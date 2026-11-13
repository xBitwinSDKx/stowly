/**
 * Der Zustand des Kerns: Datenbank und Arbeitsspeicher in einem.
 *
 * In der Datenbank liegt der Stand des Servers und die Outbox (src/core/db.ts). Im
 * Arbeitsspeicher liegt zusätzlich, was die App zeigt:
 *
 *   view = base + wartende Befehle, in ihrer Reihenfolge       (docs/sync-protokoll.md, 9.1)
 *
 * `view` wird nie gespeichert, sondern immer daraus berechnet. Eine Änderung des Anwenders
 * (`mutate`) schreibt deshalb nur ihre Befehle in die Outbox, in einer Transaktion; die
 * Antwort des Servers (`applySync`) ersetzt `base`, entfernt die bestätigten Befehle und
 * rechnet `view` neu. Was der Server abgelehnt hat, ist damit von selbst wieder weg.
 *
 * Mehrere Tabs und der Service Worker teilen sich die Datenbank. Jeder Schreibvorgang erhöht
 * den Zähler `seq`. Vor jedem eigenen Schreibvorgang prüft der Store in derselben Transaktion,
 * ob sein Arbeitsspeicher noch auf dem aktuellen Zähler beruht, und liest sonst neu. Ein
 * BroadcastChannel sagt den anderen zusätzlich sofort Bescheid.
 *
 * Ohne DOM: Diese Datei läuft auch im Service Worker.
 */
import type { Command, CommandResult, RejectCode, SyncResponse } from "@/contract/api.gen";
import { DEFAULT_DEVICE_PREFS, type DevicePrefs } from "@/contract/core";
import { CoreError, type CoreErrorCode } from "@/contract/errors";
import { newUuid, randomPackageId } from "@/contract/ids";

import { applyCommand, replay } from "./commands/apply";
import { DEFAULT_DB_NAME, INITIAL_SYNC_META, StowlyDb, type OutboxEntry, type StoredProblem, type StoredSession, type SyncMeta } from "./db";
import { Signal } from "./live";
import { purge } from "./sync/retention";
import { Draft, EMPTY_TABLES, keyOf, reconcile, TABLE_NAMES, tableFrom, type MutableTables, type TableName, type TableRows, type Tables } from "./tables";

export interface StoreState {
  /** false, bis die Datenbank gelesen ist. */
  loaded: boolean;
  /** Zähler der Datenbank, auf dem dieser Stand beruht. */
  seq: number;
  /** Stand des Servers. */
  base: Tables;
  /** Was die App zeigt: `base` plus die wartenden Befehle. */
  view: Tables;
  /** Die wartenden Befehle in der Reihenfolge ihrer Entstehung. */
  outbox: readonly OutboxEntry[];
  /** Der ID-Vorrat in der Reihenfolge der Zuteilung. */
  pool: readonly string[];
  problems: readonly StoredProblem[];
  session: StoredSession | null;
  prefs: DevicePrefs;
  meta: SyncMeta;
  /** Tokens, die beim Server noch gesperrt werden müssen. */
  revocations: readonly string[];
}

const INITIAL_STATE: StoreState = {
  loaded: false,
  seq: 0,
  base: EMPTY_TABLES,
  view: EMPTY_TABLES,
  outbox: [],
  pool: [],
  problems: [],
  session: null,
  prefs: DEFAULT_DEVICE_PREFS,
  meta: INITIAL_SYNC_META,
  revocations: [],
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Ein Befehl ohne Kennung und Zeitpunkt; beides setzt `Mutation.emit`. */
export type CommandInput = DistributiveOmit<Command, "id" | "at">;

const REJECT_TO_ERROR: Record<RejectCode, CoreErrorCode> = {
  invalid: "invalid",
  not_found: "not_found",
  id_conflict: "internal",
  last_zone: "last_zone",
  internal: "internal",
};

/**
 * Eine Änderung des Anwenders in Arbeit: Befehle, die auf einen Entwurf der Anzeige wirken.
 * Erst wenn alles gelungen ist, landen die Befehle in der Outbox und der Entwurf in der Anzeige.
 */
export class Mutation {
  readonly draft: Draft;
  readonly commands: Command[] = [];
  /** Zeitpunkt dieser Änderung nach der Geräteuhr; alle Befehle eines Vorgangs tragen ihn. */
  readonly at: string;
  /** Aus dem Vorrat entnommene IDs. */
  readonly takenIds: string[] = [];
  prefs: DevicePrefs;
  prefsChanged = false;
  /** Der nächste Abgleich soll den Bestand vollständig neu holen. */
  fullResync = false;

  private poolIndex = 0;
  private readonly usedIds = new Set<string>();

  constructor(
    readonly state: StoreState,
    now: Date,
  ) {
    this.draft = new Draft(state.view);
    this.at = now.toISOString();
    this.prefs = state.prefs;
  }

  get deviceId(): string | null {
    return this.state.session?.device?.id ?? null;
  }

  /**
   * Erzeugt den Befehl, wendet ihn auf den Entwurf an und merkt ihn für die Outbox vor.
   * Würde schon die lokale Kopie ihn ablehnen, wird er gar nicht erst erzeugt.
   * @throws CoreError passend zum Grund der Ablehnung
   */
  emit(input: CommandInput): Command {
    const command = { id: newUuid(), at: this.at, ...input } as Command;
    const outcome = applyCommand(this.draft, command, { at: this.at, device_id: this.deviceId, authoritative: false });
    if (outcome.status === "rejected") {
      throw new CoreError(REJECT_TO_ERROR[outcome.code], `Die Änderung ist nicht möglich (${command.type}: ${outcome.code}).`);
    }
    this.commands.push(command);
    return command;
  }

  /** Die nächste freie Packungs-ID: aus dem Vorrat, sonst zufällig (docs/sync-protokoll.md, Abschnitt 8). */
  takePackageId(): string {
    while (this.poolIndex < this.state.pool.length) {
      const id = this.state.pool[this.poolIndex] as string;
      this.poolIndex += 1;
      this.takenIds.push(id);
      // Wer eine freie ID zuerst anlegt, bekommt sie: Eine inzwischen vergebene wird übersprungen.
      if (!this.draft.get("packages", id) && !this.usedIds.has(id)) {
        this.usedIds.add(id);
        return id;
      }
    }
    for (;;) {
      const id = randomPackageId();
      if (!this.draft.get("packages", id) && !this.usedIds.has(id)) {
        this.usedIds.add(id);
        return id;
      }
    }
  }

  setPrefs(changes: Partial<DevicePrefs>): void {
    this.prefs = { ...this.prefs, ...changes };
    this.prefsChanged = true;
  }
}

export interface SyncApplyInput {
  /** Stand, auf dem die Anfrage beruhte. Hat er sich inzwischen geändert, zählen nur die Ergebnisse. */
  basedOn: { dataset_id: string | null; cursor: number };
  /** Token, mit dem gefragt wurde. */
  token: string;
  /** Die Anfrage hat einen vollständigen Abzug verlangt (`dataset_id: null`, `cursor: 0`). */
  full: boolean;
  /** Alle Seiten der Antwort in ihrer Reihenfolge; sie werden gemeinsam angewendet. */
  pages: readonly SyncResponse[];
  /** Geräteuhr beim Eintreffen der letzten Seite. */
  receivedAt: Date;
  /** Bei der Anmeldung: die Sitzung, die mit diesem ersten Abgleich gilt. */
  login?: StoredSession;
}

export interface SyncApplyReport {
  /** false: Die Sitzung hat sich inzwischen geändert (abgemeldet, gesperrt); die Antwort wurde verworfen. */
  applied: boolean;
  /** false: Der Stand hat sich inzwischen geändert; nur die Ergebnisse der Befehle wurden verbucht. */
  changes_applied: boolean;
  confirmed: number;
  rejected: number;
  displaced: number;
  reset: boolean;
}

export interface StoreOptions {
  dbName?: string;
  now?: () => Date;
}

export class Store {
  readonly db: StowlyDb;
  readonly state = new Signal<StoreState>(INITIAL_STATE);

  private readonly now: () => Date;
  private channel: BroadcastChannel | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(options: StoreOptions = {}) {
    this.db = new StowlyDb(options.dbName ?? DEFAULT_DB_NAME);
    this.now = options.now ?? (() => new Date());
  }

  get snapshot(): StoreState {
    return this.state.get();
  }

  /** Öffnet die Datenbank und liest den Stand. */
  async load(): Promise<void> {
    await this.db.open();
    await this.reload();
    if (typeof BroadcastChannel === "function") {
      const channel = new BroadcastChannel(`stowly-core:${this.db.name}`);
      // Unter Node hielte ein offener Kanal den Prozess am Leben.
      (channel as unknown as { unref?: () => void }).unref?.();
      channel.onmessage = () => {
        void this.refreshIfStale().catch(() => undefined);
      };
      this.channel = channel;
    }
  }

  close(): void {
    this.closed = true;
    this.channel?.close();
    this.channel = null;
    this.db.close();
  }

  /** Serverzeit, geschätzt aus der Geräteuhr und dem Abstand beim letzten Abgleich. */
  serverNowMs(): number {
    return this.now().getTime() + this.snapshot.meta.clock_offset_ms;
  }

  // ---------------------------------------------------------------- Lesen

  /** Liest den ganzen Stand neu aus der Datenbank. */
  reload(): Promise<void> {
    return this.enqueue(async () => {
      const next = await this.db.transaction("r", this.db.tables, () => this.readAll());
      this.state.set(next);
    });
  }

  /** Liest neu, wenn ein anderer Tab oder der Service Worker inzwischen geschrieben hat. */
  refreshIfStale(): Promise<void> {
    return this.enqueue(async () => {
      if (this.closed) {
        return;
      }
      const next = await this.db.transaction("r", this.db.tables, async () => {
        const seq = (await this.db.readKv("seq")) ?? 0;
        return seq === this.snapshot.seq && this.snapshot.loaded ? null : this.readAll();
      });
      if (next) {
        this.state.set(next);
      }
    });
  }

  private async readAll(): Promise<StoreState> {
    const db = this.db;
    const [products, packages, zones, printers, printerStatus, printJobs, labelTemplates, outbox, pool, problems, kv] = await Promise.all([
      db.products.toArray(),
      db.packages.toArray(),
      db.zones.toArray(),
      db.printers.toArray(),
      db.printer_status.toArray(),
      db.print_jobs.toArray(),
      db.label_templates.toArray(),
      db.outbox.toArray(),
      db.id_pool.toArray(),
      db.problems.toArray(),
      db.kv.toArray(),
    ]);
    const values = new Map<string, unknown>(kv.map((entry) => [entry.key, entry.value]));
    const previous = this.snapshot;
    const session = (values.get("session") as StoredSession | undefined) ?? null;
    const base = reconcile(previous.base, {
      products: tableFrom("products", products),
      packages: tableFrom("packages", packages),
      zones: tableFrom("zones", zones),
      printers: tableFrom("printers", printers),
      printer_status: tableFrom("printer_status", printerStatus),
      print_jobs: tableFrom("print_jobs", printJobs),
      label_templates: tableFrom("label_templates", labelTemplates),
      settings: (values.get("settings") as Tables["settings"] | undefined) ?? null,
    });
    outbox.sort((a, b) => a.seq - b.seq);
    pool.sort((a, b) => a.n - b.n);
    return {
      loaded: true,
      seq: (values.get("seq") as number | undefined) ?? 0,
      base,
      view: this.project(previous.view, base, outbox, session),
      outbox,
      pool: pool.map((entry) => entry.id),
      problems: problems.sort((a, b) => a.recorded - b.recorded),
      session,
      prefs: { ...DEFAULT_DEVICE_PREFS, ...(values.get("prefs") as Partial<DevicePrefs> | undefined) },
      meta: { ...INITIAL_SYNC_META, ...(values.get("sync") as Partial<SyncMeta> | undefined) },
      revocations: (values.get("revocations") as string[] | undefined) ?? [],
    };
  }

  /** `base` plus wartende Befehle; Unverändertes behält die Referenzen aus `previous`. */
  private project(previous: Tables, base: Tables, outbox: readonly OutboxEntry[], session: StoredSession | null): Tables {
    if (outbox.length === 0) {
      return reconcile(previous, base);
    }
    const draft = new Draft(base);
    replay(
      draft,
      outbox.map((entry) => entry.command),
      session?.device?.id ?? null,
    );
    return reconcile(previous, draft.commit());
  }

  // ---------------------------------------------------------------- Schreiben

  /** Reiht die Vorgänge dieses Tabs hintereinander: Jeder sieht den Arbeitsspeicher seines Vorgängers. */
  private enqueue<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /**
   * Ein Schreibvorgang: `work` läuft in einer Transaktion über alle Tabellen und liefert den
   * neuen Stand (oder null, wenn nichts zu schreiben war). Erst nach dem Abschluss der
   * Transaktion gilt der neue Stand auch im Arbeitsspeicher.
   *
   * Innerhalb der Transaktion wird niemand benachrichtigt: Abonnenten liefen sonst im
   * Geltungsbereich der Transaktion und könnten sie mit eigenen Zugriffen stören.
   */
  private write<R>(work: (current: StoreState) => Promise<{ next: StoreState | null; value: R }>): Promise<R> {
    return this.enqueue(async () => {
      if (this.closed) {
        throw new CoreError("internal", "Die lokale Datenbank ist geschlossen.");
      }
      const run: {
        /** Ergebnis von `work`; gilt erst, wenn die Transaktion abgeschlossen ist. */
        done: { next: StoreState | null; value: R } | null;
        /** Hat ein anderer Tab geschrieben, wird in derselben Transaktion neu gelesen. */
        refreshed: StoreState | null;
        committed: boolean;
      } = { done: null, refreshed: null, committed: false };
      try {
        await this.db.transaction("rw", this.db.tables, async () => {
          let current = this.snapshot;
          const seq = (await this.db.readKv("seq")) ?? 0;
          if (seq !== current.seq || !current.loaded) {
            current = await this.readAll();
            run.refreshed = current;
          }
          const result = await work(current);
          if (result.next) {
            const nextSeq = current.seq + 1;
            await this.db.writeKv("seq", nextSeq);
            result.next = { ...result.next, seq: nextSeq };
          }
          run.done = result;
        });
        run.committed = true;
      } finally {
        const published = (run.committed ? run.done?.next : null) ?? run.refreshed;
        if (published) {
          this.state.set(published);
        }
      }
      const done = run.done;
      if (!done) {
        throw new CoreError("internal", "Die lokale Datenbank hat den Schreibvorgang nicht abgeschlossen.");
      }
      if (done.next) {
        try {
          this.channel?.postMessage({ seq: done.next.seq });
        } catch {
          // Der Kanal ist nur ein Zuruf; die anderen prüfen den Zähler ohnehin selbst.
        }
      }
      return done.value;
    });
  }

  /**
   * Eine Änderung des Anwenders. `build` prüft die Eingaben und erzeugt die Befehle; wirft es,
   * ändert sich nichts. Sonst stehen die Befehle danach in der Outbox, und die Anzeige zeigt
   * ihre Wirkung: beides zusammen oder gar nicht.
   */
  async mutate<R>(build: (mutation: Mutation) => R): Promise<R> {
    const outcome = await this.write<{ ok: true; value: R } | { ok: false; error: unknown }>(async (current) => {
      const mutation = new Mutation(current, this.now());
      let value: R;
      try {
        value = build(mutation);
      } catch (error) {
        return { next: null, value: { ok: false, error } };
      }
      const entries: OutboxEntry[] = [];
      if (mutation.commands.length > 0) {
        const keys = await this.db.outbox.bulkAdd(
          mutation.commands.map((command) => ({ id: command.id, command })),
          { allKeys: true },
        );
        mutation.commands.forEach((command, index) => {
          entries.push({ seq: keys[index] as number, id: command.id, command });
        });
      }
      if (mutation.takenIds.length > 0) {
        await this.db.id_pool.where("id").anyOf(mutation.takenIds).delete();
      }
      if (mutation.prefsChanged) {
        await this.db.writeKv("prefs", mutation.prefs);
      }
      const meta = mutation.fullResync && !current.meta.full_resync ? { ...current.meta, full_resync: true } : current.meta;
      if (meta !== current.meta) {
        await this.db.writeKv("sync", meta);
      }
      const changed = entries.length > 0 || mutation.takenIds.length > 0 || mutation.prefsChanged || meta !== current.meta;
      if (!changed) {
        return { next: null, value: { ok: true, value } };
      }
      const taken = new Set(mutation.takenIds);
      const next: StoreState = {
        ...current,
        view: entries.length > 0 ? mutation.draft.commit() : current.view,
        outbox: entries.length > 0 ? [...current.outbox, ...entries] : current.outbox,
        pool: taken.size > 0 ? current.pool.filter((id) => !taken.has(id)) : current.pool,
        prefs: mutation.prefs,
        meta,
      };
      return { next, value: { ok: true, value } };
    });
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  }

  /**
   * Wendet die Antwort des Servers an (docs/sync-protokoll.md, 9.2 und 9.3): Ergebnisse
   * verbuchen, alle Seiten gemeinsam übernehmen, Altes verwerfen, die verbliebenen Befehle
   * erneut anwenden. Alles in einer Transaktion.
   */
  applySync(input: SyncApplyInput): Promise<SyncApplyReport> {
    return this.write<SyncApplyReport>(async (current) => {
      const report: SyncApplyReport = { applied: false, changes_applied: false, confirmed: 0, rejected: 0, displaced: 0, reset: false };
      const signedIn = current.session?.status === "signed_in";
      const sessionMatches = input.login ? !signedIn : signedIn && current.session?.token === input.token;
      const first = input.pages[0];
      const last = input.pages.at(-1);
      if (!sessionMatches || !first || !last) {
        return { next: null, value: report };
      }
      report.applied = true;

      // 1. Ergebnisse: Ein Befehl verlässt die Outbox erst, wenn sein Ergebnis da ist.
      const results = new Map<string, CommandResult>();
      for (const page of input.pages) {
        for (const result of page.results) {
          results.set(result.id, result);
        }
      }
      const remaining: OutboxEntry[] = [];
      const confirmed: OutboxEntry[] = [];
      for (const entry of current.outbox) {
        (results.has(entry.id) ? confirmed : remaining).push(entry);
      }
      let recorded = current.problems.reduce((highest, problem) => Math.max(highest, problem.recorded), 0);
      const newProblems: StoredProblem[] = [];
      for (const entry of confirmed) {
        const result = results.get(entry.id) as CommandResult;
        if (result.status === "applied") {
          continue;
        }
        recorded += 1;
        newProblems.push({
          id: entry.id,
          at: entry.command.at,
          status: result.status,
          code: result.status === "rejected" ? result.code : null,
          message: result.message,
          command: entry.command,
          recorded,
        });
        if (result.status === "rejected") {
          report.rejected += 1;
        } else {
          report.displaced += 1;
        }
      }
      report.confirmed = confirmed.length;
      if (confirmed.length > 0) {
        await this.db.outbox.bulkDelete(confirmed.map((entry) => entry.seq));
      }
      if (newProblems.length > 0) {
        await this.db.problems.bulkPut(newProblems);
      }

      // 2. Datensätze: nur, wenn die Anfrage noch auf dem gespeicherten Stand beruhte.
      let base = current.base;
      let pool = current.pool;
      let meta = current.meta;
      const stale = current.meta.dataset_id !== input.basedOn.dataset_id || current.meta.cursor !== input.basedOn.cursor;
      if (!stale) {
        report.changes_applied = true;
        report.reset = first.reset;
        const serverNowMs = Date.parse(last.server_time);
        const merged = mergePages(first.reset ? EMPTY_TABLES : current.base, input.pages);
        const purged = purge(merged.tables, serverNowMs);
        base = reconcile(current.base, purged.tables);

        if (first.reset) {
          await Promise.all(TABLE_NAMES.map((table) => this.db.table(table).clear()));
          await this.db.kv.delete("settings");
          await this.db.id_pool.clear();
        }
        const dropped: Record<string, Set<string>> = { packages: new Set(purged.packages), print_jobs: new Set(purged.print_jobs) };
        for (const table of TABLE_NAMES) {
          const rows = [...merged.touched[table].values()].filter((row) => !dropped[table]?.has(keyOf(table, row as never)));
          if (rows.length > 0) {
            await this.db.table(table).bulkPut(rows);
          }
        }
        if (!first.reset) {
          if (purged.packages.length > 0) {
            await this.db.packages.bulkDelete(purged.packages);
          }
          if (purged.print_jobs.length > 0) {
            await this.db.print_jobs.bulkDelete(purged.print_jobs);
          }
        }
        if (merged.settingsTouched && base.settings) {
          await this.db.writeKv("settings", base.settings);
        }

        // ID-Vorrat: bei reset den alten verwerfen, dann die Zuteilung übernehmen.
        const kept = first.reset ? [] : [...current.pool];
        const known = new Set(kept);
        const granted: string[] = [];
        for (const page of input.pages) {
          for (const id of page.id_pool.grant) {
            if (!known.has(id)) {
              known.add(id);
              granted.push(id);
            }
          }
        }
        if (granted.length > 0) {
          await this.db.id_pool.bulkAdd(granted.map((id) => ({ id })));
        }
        pool = [...kept, ...granted];

        meta = {
          dataset_id: last.dataset_id,
          cursor: last.cursor,
          last_synced_at: input.receivedAt.toISOString(),
          clock_offset_ms: Number.isFinite(serverNowMs) ? serverNowMs - input.receivedAt.getTime() : current.meta.clock_offset_ms,
          full_resync: current.meta.full_resync,
        };
      }

      const session = input.login ?? current.session;
      if (input.login) {
        await this.db.writeKv("session", input.login);
      }

      // 3. Die verbliebenen Befehle erneut anwenden.
      const view = this.project(current.view, base, remaining, session);
      if (input.login && (view.settings === null || ![...view.zones.values()].some((zone) => zone.deleted_at === null))) {
        // Angemeldet heißt: Es gibt mindestens eine Zone und die Einstellungen. Sonst bleibt das
        // Gerät abgemeldet; der Fehler bricht die Transaktion ab, nichts davon wird gespeichert.
        throw new CoreError("internal", "Der Server hat keinen vollständigen Bestand geliefert (Zonen oder Einstellungen fehlen).");
      }

      // 4. Längere Aufbewahrung: beim nächsten Abgleich einmal vollständig neu holen.
      if (!stale) {
        const complete = input.full || first.reset;
        const grew =
          grewRetention(current.view, view) || grewRetention(current.base, base);
        meta = { ...meta, full_resync: complete ? false : current.meta.full_resync || grew };
        await this.db.writeKv("sync", meta);
      }

      const problems = newProblems.length > 0 ? mergeProblems(current.problems, newProblems) : current.problems;
      const changed = confirmed.length > 0 || !stale || Boolean(input.login);
      if (!changed) {
        return { next: null, value: report };
      }
      return { next: { ...current, base, view, outbox: remaining, pool, problems, meta, session }, value: report };
    });
  }

  /** Verwirft beim Start, was inzwischen jenseits der Aufbewahrung liegt. */
  purgeExpired(): Promise<void> {
    return this.write<void>(async (current) => {
      const purged = purge(current.base, this.now().getTime() + current.meta.clock_offset_ms);
      if (purged.packages.length === 0 && purged.print_jobs.length === 0) {
        return { next: null, value: undefined };
      }
      if (purged.packages.length > 0) {
        await this.db.packages.bulkDelete(purged.packages);
      }
      if (purged.print_jobs.length > 0) {
        await this.db.print_jobs.bulkDelete(purged.print_jobs);
      }
      const view = this.project(current.view, purged.tables, current.outbox, current.session);
      return { next: { ...current, base: purged.tables, view }, value: undefined };
    });
  }

  // ---------------------------------------------------------------- Sitzung

  /**
   * Das Token gilt nicht mehr. Daten und Outbox bleiben; nach erneuter Anmeldung wird weiter gesendet.
   * Ohne Wirkung, wenn inzwischen ein anderes Token gilt.
   */
  markRevoked(token: string): Promise<void> {
    return this.write<void>(async (current) => {
      const session = current.session;
      if (session?.status !== "signed_in" || session.token !== token) {
        return { next: null, value: undefined };
      }
      const next: StoredSession = { status: "revoked", token: null, device: session.device };
      await this.db.writeKv("session", next);
      return { next: { ...current, session: next }, value: undefined };
    });
  }

  /**
   * Meldet ab: löscht die lokale Kopie, die Outbox, den ID-Vorrat und die Sync-Probleme.
   * Das Token wandert auf die Liste der noch zu sperrenden.
   * @returns die Zahl der wartenden Befehle, wenn deswegen nichts gelöscht wurde; sonst null
   */
  logout(discardPending: boolean): Promise<number | null> {
    return this.write<number | null>(async (current) => {
      if (current.outbox.length > 0 && !discardPending) {
        return { next: null, value: current.outbox.length };
      }
      await Promise.all(TABLE_NAMES.map((table) => this.db.table(table).clear()));
      await Promise.all([this.db.outbox.clear(), this.db.id_pool.clear(), this.db.problems.clear()]);
      await this.db.kv.delete("settings");
      const session: StoredSession = { status: "logout", token: null, device: null };
      const token = current.session?.token ?? null;
      const revocations = token === null ? current.revocations : [...current.revocations, token];
      const prefs: DevicePrefs = { ...current.prefs, scan_zone_id: null };
      await this.db.writeKv("session", session);
      await this.db.writeKv("sync", INITIAL_SYNC_META);
      await this.db.writeKv("revocations", revocations);
      await this.db.writeKv("prefs", prefs);
      const next: StoreState = {
        ...current,
        base: EMPTY_TABLES,
        view: EMPTY_TABLES,
        outbox: [],
        pool: [],
        problems: [],
        session,
        prefs,
        meta: INITIAL_SYNC_META,
        revocations,
      };
      return { next, value: null };
    });
  }

  /** Der Name dieses Geräts hat sich geändert. */
  renameDevice(deviceId: string, name: string): Promise<void> {
    return this.write<void>(async (current) => {
      const session = current.session;
      if (!session?.device || session.device.id !== deviceId || session.device.name === name) {
        return { next: null, value: undefined };
      }
      const next: StoredSession = { ...session, device: { ...session.device, name } };
      await this.db.writeKv("session", next);
      return { next: { ...current, session: next }, value: undefined };
    });
  }

  /** Merkt ein Token vor, das beim Server gesperrt werden soll, oder streicht es wieder. */
  setRevocation(token: string, pending: boolean): Promise<void> {
    return this.write<void>(async (current) => {
      const has = current.revocations.includes(token);
      if (has === pending) {
        return { next: null, value: undefined };
      }
      const revocations = pending ? [...current.revocations, token] : current.revocations.filter((candidate) => candidate !== token);
      await this.db.writeKv("revocations", revocations);
      return { next: { ...current, revocations }, value: undefined };
    });
  }

  dismissProblem(id: string): Promise<void> {
    return this.write<void>(async (current) => {
      if (!current.problems.some((problem) => problem.id === id)) {
        return { next: null, value: undefined };
      }
      await this.db.problems.delete(id);
      return { next: { ...current, problems: current.problems.filter((problem) => problem.id !== id) }, value: undefined };
    });
  }
}

function grewRetention(before: Tables, after: Tables): boolean {
  return before.settings !== null && after.settings !== null && after.settings.trash_retention_days > before.settings.trash_retention_days;
}

function mergeProblems(existing: readonly StoredProblem[], added: readonly StoredProblem[]): StoredProblem[] {
  const ids = new Set(added.map((problem) => problem.id));
  return [...existing.filter((problem) => !ids.has(problem.id)), ...added];
}

interface MergedPages {
  tables: Tables;
  /** Je Tabelle die gelieferten Datensätze in ihrer letzten Fassung. */
  touched: { [T in TableName]: Map<string, TableRows[T]> };
  settingsTouched: boolean;
}

/** Legt alle Seiten einer Antwort übereinander; spätere Seiten gewinnen. */
function mergePages(start: Tables, pages: readonly SyncResponse[]): MergedPages {
  const touched: MergedPages["touched"] = {
    products: new Map(),
    packages: new Map(),
    zones: new Map(),
    printers: new Map(),
    printer_status: new Map(),
    print_jobs: new Map(),
    label_templates: new Map(),
  };
  let settings = start.settings;
  let settingsTouched = false;
  for (const page of pages) {
    const changes = page.changes;
    for (const table of TABLE_NAMES) {
      const target = touched[table] as Map<string, unknown>;
      for (const row of changes[table] as TableRows[TableName][]) {
        target.set(keyOf(table, row as never), row);
      }
    }
    if (changes.settings) {
      settings = changes.settings;
      settingsTouched = true;
    }
  }
  const tables: MutableTables = { ...start, settings };
  for (const table of TABLE_NAMES) {
    const rows = touched[table] as Map<string, unknown>;
    if (rows.size > 0) {
      const map = new Map<string, unknown>(start[table]);
      for (const [id, row] of rows) {
        map.set(id, row);
      }
      (tables as Record<TableName, unknown>)[table] = map;
    }
  }
  return { tables, touched, settingsTouched };
}
