/**
 * Der Abgleich mit dem Server (docs/sync-protokoll.md, Abschnitte 6 und 9).
 *
 * Ein Lauf (`run`) besteht aus Runden. Jede Runde schickt bis zu 500 wartende Befehle in
 * ihrer Reihenfolge, sammelt alle Seiten der Antwort (`has_more`) und übergibt sie gemeinsam
 * dem Store. Weitere Runden folgen, solange die Outbox mehr enthält, der Bestand vollständig
 * neu geholt werden soll oder der Stand sich unter der Anfrage geändert hat.
 *
 * `run` wirft nie; das Ergebnis sagt, ob der Versuch gelungen ist.
 *
 * Ohne DOM: Diese Datei läuft auch im Service Worker.
 */
import { MAX_COMMANDS_PER_SYNC, PROTOCOL_VERSION, type ServerHealth, type SyncRequest, type SyncResponse } from "@/contract/api.gen";
import type { SessionDevice } from "@/contract/core";
import { CoreError } from "@/contract/errors";

import type { StoredSession } from "../db";
import type { ApiClient } from "../http";
import type { Store, SyncApplyReport } from "../store";
import { withLock } from "./lock";

export type SyncOutcome =
  /** `synced` ist false, wenn das Gerät nicht angemeldet ist: Dann wurde nur die Erreichbarkeit geprüft. */
  { ok: true; synced: boolean } | { ok: false; error: CoreError };

export interface SyncRunOptions {
  /** Abgleich während der Anmeldung: Mit der ersten gelungenen Runde gilt das Gerät als angemeldet. */
  login?: { token: string; device: SessionDevice };
}

export interface SyncEngineDeps {
  store: Store;
  api: ApiClient;
  now: () => Date;
  /** Name der Sperre, die Abgleiche über Tabs und Service Worker hinweg hintereinander reiht. */
  lockName: string;
  /** Version der App, nur zur Diagnose im Server. */
  appVersion?: string | null;
  /** Wird nach jeder Erreichbarkeitsprüfung gerufen (null = nicht erreichbar). */
  onHealth?: (health: ServerHealth | null) => void;
}

/** So lange gilt eine gelungene Antwort als Beleg, dass der Server erreichbar ist. */
const CONTACT_FRESH_MS = 30_000;
/** Obergrenze je Lauf: schützt vor einer Endlosschleife, falls Server und App sich nicht einig werden. */
const MAX_ROUNDS = 20;
const MAX_PAGES = 2_000;
const MAX_RESTARTS = 3;

interface RoundResult {
  report: SyncApplyReport;
  /** Sollgröße des ID-Vorrats laut Server. */
  target: number;
  /** Zahl der in dieser Runde gesendeten Befehle. */
  sent: number;
}

/** Der Server hat mitten im Blättern den Bestand gewechselt: Die Runde beginnt von vorn. */
class RestartRound extends Error {}

function toCoreError(error: unknown): CoreError {
  if (error instanceof CoreError) {
    return error;
  }
  return new CoreError("internal", error instanceof Error ? error.message : String(error));
}

export class SyncEngine {
  private lastContactMs: number | null = null;

  constructor(private readonly deps: SyncEngineDeps) {}

  /** Ein Abgleich. Reiht sich hinter einen laufenden ein (auch den eines anderen Tabs) und wirft nie. */
  run(options: SyncRunOptions = {}): Promise<SyncOutcome> {
    return withLock(this.deps.lockName, () => this.runLocked(options)).catch((error: unknown) => ({ ok: false as const, error: toCoreError(error) }));
  }

  /** Prüft nur, ob der Server erreichbar ist (docs/sync-protokoll.md, 9.5). */
  async checkHealth(): Promise<ServerHealth | null> {
    const health = await this.deps.api.health();
    if (health) {
      this.lastContactMs = this.deps.now().getTime();
    }
    this.deps.onHealth?.(health);
    return health;
  }

  private async runLocked(options: SyncRunOptions): Promise<SyncOutcome> {
    const { store } = this.deps;
    let token: string | null = null;
    try {
      await store.refreshIfStale();
      const session = store.snapshot.session;
      token = options.login?.token ?? (session?.status === "signed_in" ? session.token : null);

      // Erst klären, ob der Server da ist: Im WLAN des Pi hinge ein Abgleich sonst lange in der Luft.
      const nowMs = this.deps.now().getTime();
      const fresh = this.lastContactMs !== null && Math.abs(nowMs - this.lastContactMs) < CONTACT_FRESH_MS;
      if (!fresh || token === null) {
        const health = await this.checkHealth();
        if (!health) {
          return { ok: false, error: new CoreError("offline", "Der Server ist nicht erreichbar.") };
        }
      }
      if (token === null) {
        return { ok: true, synced: false };
      }

      let login: StoredSession | undefined = options.login ? { status: "signed_in", token: options.login.token, device: options.login.device } : undefined;
      let toppedUp = false;
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const { report, target, sent } = await this.round(token, login);
        this.lastContactMs = this.deps.now().getTime();
        if (!report.applied) {
          // Inzwischen abgemeldet oder gesperrt: Die Antwort gehört zu keiner Sitzung mehr.
          return { ok: true, synced: false };
        }
        login = undefined;
        const after = store.snapshot;
        if (sent > 0 && report.confirmed === 0) {
          throw new CoreError("internal", "Der Server hat die gesendeten Änderungen nicht bestätigt.");
        }
        let again = after.meta.full_resync || !report.changes_applied || after.outbox.length > 0;
        if (!again && report.reset && !toppedUp && after.pool.length < target) {
          // Nach einem unerwarteten Abzug ist der Vorrat kleiner als zugedacht: einmal auffüllen.
          toppedUp = true;
          again = true;
        }
        if (!again) {
          return { ok: true, synced: true };
        }
      }
      // Es kommt laufend Neues hinzu: Der Rest folgt mit dem nächsten Anlass.
      return { ok: true, synced: true };
    } catch (error) {
      const failure = toCoreError(error);
      if (failure.code === "unauthorized" && token !== null && !options.login) {
        // Token unbekannt oder gesperrt: abgemeldet, Daten und Outbox bleiben (9.2).
        await store.markRevoked(token).catch(() => undefined);
      }
      return { ok: false, error: failure };
    }
  }

  private async round(token: string, login: StoredSession | undefined): Promise<RoundResult> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.roundOnce(token, login);
      } catch (error) {
        if (!(error instanceof RestartRound) || attempt >= MAX_RESTARTS) {
          throw error instanceof RestartRound ? new CoreError("internal", "Der Server wechselt während des Abgleichs immer wieder den Bestand.") : error;
        }
      }
    }
  }

  private async roundOnce(token: string, login: StoredSession | undefined): Promise<RoundResult> {
    const { store, api, now } = this.deps;
    await store.refreshIfStale();
    const state = store.snapshot;
    const basedOn = { dataset_id: state.meta.dataset_id, cursor: state.meta.cursor };
    // Vollständig neu holen: beim ersten Abgleich und nach einer längeren Aufbewahrungsdauer (6.4).
    const full = state.meta.full_resync || state.meta.dataset_id === null;
    const batch = state.outbox.slice(0, MAX_COMMANDS_PER_SYNC);
    const request: SyncRequest = {
      protocol: PROTOCOL_VERSION,
      dataset_id: full ? null : state.meta.dataset_id,
      cursor: full ? 0 : state.meta.cursor,
      sent_at: now().toISOString(),
      commands: batch.map((entry) => entry.command),
      // Auf einen vollständigen Abzug folgt immer `reset`, und der verwirft den Vorrat: Er zählt schon jetzt nicht mehr.
      id_pool: { have: full ? 0 : state.pool.length },
    };
    if (this.deps.appVersion) {
      request.app_version = this.deps.appVersion;
    }

    let response: SyncResponse = await api.sync(token, request);
    const pages: SyncResponse[] = [response];
    const kept = response.reset ? 0 : state.pool.length;
    let granted = response.id_pool.grant.length;
    while (response.has_more) {
      if (pages.length >= MAX_PAGES) {
        throw new CoreError("internal", "Der Server liefert endlos weitere Seiten.");
      }
      // Weitere Seiten: ohne Befehle, mit dem neuen cursor (6.4).
      response = await api.sync(token, {
        protocol: PROTOCOL_VERSION,
        dataset_id: response.dataset_id,
        cursor: response.cursor,
        sent_at: now().toISOString(),
        commands: [],
        id_pool: { have: kept + granted },
        ...(this.deps.appVersion ? { app_version: this.deps.appVersion } : {}),
      });
      if (response.reset) {
        // Der Bestand hat mitten im Blättern gewechselt: Nichts davon anwenden, neu beginnen.
        throw new RestartRound();
      }
      pages.push(response);
      granted += response.id_pool.grant.length;
    }

    const report = await store.applySync({ basedOn, token, full, pages, receivedAt: now(), login });
    return { report, target: response.id_pool.target, sent: batch.length };
  }
}
