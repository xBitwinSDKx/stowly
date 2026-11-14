/**
 * Etiketten zustellen (docs/etiketten.md, 4.1 und 5.4).
 *
 * Wer:    Nur dieses Gerät stellt zu, was es selbst angefordert hat (`PrintJob.device_id`), an
 *         den Druckdienst des Servers genauso wie an den Pi. Fremde Etiketten zeigt es nur.
 * Wohin:  `printerIdForJob`, bei jedem Versuch neu. Ohne Drucker bleibt das Etikett "pending".
 * Wie:    je Drucker eine Abfrage des Zustands, dann die Etiketten nacheinander in der
 *         Reihenfolge ihrer Anforderung.
 *
 * „Nie doppelt" trägt die Buchführung (`DeliveryEntry`, src/core/db.ts): Bevor ein Auftrag zum
 * ersten Mal hinausgeht, steht dauerhaft fest, was an wen mit welcher `boot_id` geht. Jede
 * Wiederholung schickt genau das wieder. Daraus folgt die Unterscheidung des Vertrags:
 *
 *   kein Eintrag              noch nie abgeschickt. Der Inhalt entsteht jetzt, aus dem, was
 *                             die App gerade zeigt.
 *   Eintrag "sending"         abgeschickt, bisher ohne Antwort. Derselbe Auftrag geht noch
 *                             einmal hinaus; der Dienst druckt ihn höchstens einmal. Läuft der
 *                             Dienst inzwischen neu (`boot_mismatch`), weiß niemand, ob gedruckt
 *                             wurde: "unknown", die App fragt den Anwender.
 *   Eintrag "accepted"        Der Dienst hat angenommen; hier wird nur noch nachgefragt.
 *
 * Hat der Dienst einen eben erst festgeschriebenen Auftrag eindeutig nicht angenommen (voll,
 * Token falsch, noch unbekannt), verschwindet der Eintrag wieder: Die Antwort ist da, also ist
 * nichts unterwegs, und der nächste Versuch beginnt frisch.
 *
 * Immer nur ein Zustellversuch zugleich je Gerät, auch über mehrere Tabs (Web Lock). Nie im
 * Service Worker: Einen direkten Drucker darf nur eine Seite ansprechen, und für den Server
 * gilt dieselbe Regel, damit es einen Weg gibt.
 *
 * Ein Versuch hat zwei Teile, beide unter der Sperre:
 *
 *   bedienen     alle Drucker der Reihe nach: Zustand abfragen, einreichen, was aussteht, und
 *                einmal abfragen, was schon beim Dienst ist. Danach steht der Bericht fest
 *                (`DeliveryRun.report`, darauf wartet `print.flush`).
 *   nachfragen   im Hintergrund, solange Aufträge beim Dienst warten (`wait=10`, höchstens 60 s
 *                je Drucker). Die Ergebnisse kommen wie jede Änderung über `data.printJobs` an.
 *                Will jemand anderes die Sperre (ein neuer Versuch dieses oder eines anderen
 *                Tabs), bricht das Nachfragen ab, die laufende Abfrage auch: Sie ändert am Dienst
 *                nichts, und der neue Versuch fragt selbst wieder nach.
 */
import type { DriverStatus, Printer, PrintJob, PrintJobState, ServiceJob } from "@/contract/api.gen";
import type { PrinterProbe, PrinterProblem, PrintFlushReport } from "@/contract/core";
import { CoreError } from "@/contract/errors";
import { progressAfterOutcome } from "@/contract/labels";

import type { DeliveryEntry } from "../db";
import type { Store, StoreState } from "../store";
import { onLockWanted, withLock } from "../sync/lock";
import type { PermissionReader } from "./address";
import type { PrintServiceClient, ServiceReply } from "./client";
import { connect, type Connection, type ConnectResult } from "./connect";
import { buildContent, byRequestOrder, printerFor } from "./content";
import { PRINT_TEXTS, PROBLEM_TEXTS } from "./texts";

/** Name der Sperre, die Zustellversuche über Tabs hinweg hintereinander reiht. */
export const PRINT_LOCK_NAME = "stowly-print";

/**
 * So lange wartet der Dienst beim Einreichen auf den Endzustand, wenn der Kern von selbst
 * zustellt. Ein Etikett ist in wenigen Sekunden gedruckt; kommt der Endzustand gleich mit,
 * genügt eine Meldung statt zwei. Auf Wunsch des Anwenders (`flush`) wartet dagegen jemand auf
 * den Bericht: Dann wird ohne Warten eingereicht (`wait=0`), und den Endzustand bringt das
 * Nachfragen im Hintergrund.
 */
export const SUBMIT_WAIT_S = 5;
/** Wartezeit des Dienstes beim Nachfragen. */
export const FOLLOW_UP_WAIT_S = 10;
/** Nachgefragt wird höchstens so lange je Drucker und Versuch; danach beim nächsten Versuch. */
export const FOLLOW_UP_BUDGET_MS = 60_000;
const MAX_FOLLOW_UPS = FOLLOW_UP_BUDGET_MS / (FOLLOW_UP_WAIT_S * 1_000);
/** Für so viele Etiketten mit offenem Ausgang fragt ein Versuch höchstens nach. */
const MAX_UNKNOWN_CHECKS = 20;
/** Der Zustand eines direkten Druckers geht höchstens so oft in den Sync, solange sich nichts ändert. */
export const PRINTER_REPORT_INTERVAL_MS = 60_000;

/** Zustände des Etiketts, nach denen nichts mehr zu tun ist. */
const SETTLED: ReadonlySet<PrintJobState> = new Set(["printed", "sent", "failed", "cancelled"]);

export interface DeliveryDeps {
  store: Store;
  client: PrintServiceClient;
  now: () => Date;
  /** Name der Sperre; eine eigene Datenbank (Tests) bekommt eine eigene. */
  lockName: string;
  /** Läuft die App in einem sicheren Kontext? Ohne ihn gibt es keinen Direktdruck. */
  isSecureContext: () => boolean;
  readPermission: PermissionReader;
  /** Ein Befehl ist in die Outbox gekommen: Abgleich vormerken. */
  onChange(): void;
  /** Der Druckdienst des Servers hat das Geräte-Token abgelehnt: Das Gerät ist abgemeldet. */
  onUnauthorized(token: string): Promise<void>;
  /** Hier und beim Server passt etwas nicht zusammen: bald abgleichen. */
  requestSync(): void;
}

export interface DeliveryOptions {
  /**
   * Auf eine Handlung des Anwenders hin: Die Nachfrage des Browsers nach dem lokalen Netzwerk
   * darf kommen, und ein Drucker, der zuletzt das Token abgelehnt hat, wird wieder versucht.
   */
  manual: boolean;
  /** Auch bei Etiketten mit offenem Ausgang nachsehen, ob der Dienst sie doch kennt. */
  checkUnknown: boolean;
}

export interface DeliveryOutcome extends PrintFlushReport {
  /** Eigene Etiketten, um die sich der Kern weiter kümmert: ausstehend mit Drucker, oder beim Dienst wartend. */
  outstanding: number;
}

/** Ein Zustellversuch, von außen gesehen. Beide Versprechen erfüllen sich immer, nie mit einem Fehler. */
export interface DeliveryRun {
  /**
   * Erfüllt sich, sobald jedes ausstehende Etikett eingereicht und jedes schon abgeschickte
   * einmal abgefragt ist: der Bericht für diesen Moment (`print.flush`).
   */
  report: Promise<DeliveryOutcome>;
  /** Erfüllt sich, wenn auch das Nachfragen vorbei oder abgebrochen ist und die Sperre frei wird; mit dem Stand dann. */
  done: Promise<DeliveryOutcome>;
}

/** Ein Drucker, bei dem nach dem Bedienen noch Aufträge warten. */
interface FollowUp {
  connection: Connection;
  /** Kennungen der wartenden Aufträge, der älteste zuerst. */
  waiting: string[];
}

type Step = "submit" | "follow" | "check";

interface PlannedJob {
  id: string;
  step: Step;
}

interface Group {
  printerId: string;
  jobs: PlannedJob[];
}

interface Plan {
  groups: Group[];
  /** Ausstehende eigene Etiketten ohne Drucker. */
  unassigned: number;
  /** Alle ausstehenden eigenen Etiketten. */
  pending: number;
  outstanding: number;
}

interface Attempt {
  manual: boolean;
  deviceId: string;
  token: string;
  /** Das Gerät ist nicht mehr angemeldet: Der Versuch endet. */
  aborted: boolean;
  outcome: DeliveryOutcome;
}

/** Wie es mit einem Etikett nach einem Schritt weitergeht. */
type Next =
  /** erledigt oder nichts zu tun */
  | "done"
  /** beim Dienst angenommen, noch kein Endzustand */
  | "waiting"
  /** Der Dienst antwortet nicht mehr oder nimmt nichts an: weitere Etiketten dieses Druckers lohnen jetzt nicht. */
  | "halt";

function emptyOutcome(): DeliveryOutcome {
  return { delivered: 0, pending: 0, problems: [], outstanding: 0 };
}

/** Die Angaben, über die ein direkter Drucker erreicht wird. Ändern sie sich, lohnt ein neuer Versuch. */
function accessOf(printer: Printer): string {
  return JSON.stringify(printer.direct ?? printer.server ?? null);
}

function sameStatus(a: DriverStatus | null, b: DriverStatus | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    a.reachable === b.reachable &&
    a.ready === b.ready &&
    a.media_detected === b.media_detected &&
    a.errors.length === b.errors.length &&
    [...a.errors].sort().join("\n") === [...b.errors].sort().join("\n")
  );
}

export class DeliveryEngine {
  /** Drucker, deren Dienst das Token abgelehnt hat, mit ihren Angaben von damals (`accessOf`). */
  private readonly refused = new Map<string, string>();
  /** Wann dieses Gerät den Zustand eines direkten Druckers zuletzt gemeldet hat (Geräteuhr). */
  private readonly reportedAt = new Map<string, number>();
  /** Bricht das Nachfragen des Versuchs ab, der in diesem Tab gerade nachfragt; sonst null. */
  private followingUp: AbortController | null = null;
  private stopped = false;

  constructor(private readonly deps: DeliveryDeps) {}

  /**
   * Ein Zustellversuch. Reiht sich hinter einen laufenden ein (auch den eines anderen Tabs), aber
   * nie hinter dessen Nachfragen: Das gibt nach. Wirft nie.
   */
  run(options: DeliveryOptions): DeliveryRun {
    this.yieldFollowUps();
    let report!: (outcome: DeliveryOutcome) => void;
    const reported = new Promise<DeliveryOutcome>((resolve) => {
      report = resolve;
    });
    const done = withLock(this.deps.lockName, () => this.attempt(options, report))
      .catch((error: unknown) => {
        console.warn("Stowly: Der Zustellversuch ist gescheitert.", error instanceof Error ? error.message : error);
        return emptyOutcome();
      })
      .then((outcome) => {
        // Scheiterte der Versuch vor seinem Bericht, gilt der Stand von hier (sonst ohne Wirkung).
        report(outcome);
        return outcome;
      });
    return { report: reported, done };
  }

  /** Das Nachfragen dieses Tabs gibt nach: Es bricht ab, seine laufende Abfrage auch. */
  yieldFollowUps(): void {
    this.followingUp?.abort();
  }

  /** Der Kern endet (oder ein Tab mit neuerer App hat übernommen): nicht mehr nachfragen. */
  stop(): void {
    this.stopped = true;
    this.yieldFollowUps();
  }

  /** Eigene Etiketten, um die sich der Kern noch kümmern muss. Ohne Netz, aus dem Arbeitsspeicher. */
  outstanding(): number {
    const state = this.deps.store.snapshot;
    const deviceId = state.session?.status === "signed_in" ? state.session.device?.id : undefined;
    return deviceId ? this.plan(state, deviceId).outstanding : 0;
  }

  // ---------------------------------------------------------------- Plan

  private plan(state: StoreState, deviceId: string): Plan {
    const view = state.view;
    const groups = new Map<string, PlannedJob[]>();
    const plan: Plan = { groups: [], unassigned: 0, pending: 0, outstanding: 0 };
    const own: PrintJob[] = [];
    for (const job of view.print_jobs.values()) {
      if (job.device_id === deviceId) {
        own.push(job);
      }
    }
    own.sort(byRequestOrder);
    for (const job of own) {
      const entry = state.deliveries.get(job.id);
      let printerId: string | null;
      let step: Step;
      if (job.state === "pending") {
        plan.pending += 1;
        step = "submit";
        // Ein Auftrag, der vielleicht schon unterwegs ist, bleibt bei seinem Drucker.
        printerId = entry && entry.phase !== "handoff" ? entry.printer_id : printerFor(view, job);
        if (printerId === null) {
          plan.unassigned += 1;
          continue;
        }
        plan.outstanding += 1;
      } else if (job.state === "queued" || job.state === "printing") {
        step = "follow";
        printerId = entry?.printer_id ?? job.printer_id;
        if (printerId === null) {
          continue;
        }
        plan.outstanding += 1;
      } else if (job.state === "unknown") {
        step = "check";
        printerId = entry?.printer_id ?? job.printer_id;
        if (printerId === null || (!entry && job.boot_id === null)) {
          continue;
        }
      } else {
        continue;
      }
      const jobs = groups.get(printerId);
      if (jobs) {
        jobs.push({ id: job.id, step });
      } else {
        groups.set(printerId, [{ id: job.id, step }]);
      }
    }
    for (const [printerId, jobs] of groups) {
      plan.groups.push({ printerId, jobs });
    }
    return plan;
  }

  // ---------------------------------------------------------------- Versuch

  /**
   * Ein Versuch unter der Sperre: erst alle Drucker bedienen und berichten (`report`), dann im
   * Hintergrund nachfragen. Liefert den Stand am Ende.
   */
  private async attempt(options: DeliveryOptions, report: (outcome: DeliveryOutcome) => void): Promise<DeliveryOutcome> {
    const { store } = this.deps;
    const outcome = emptyOutcome();
    if (store.superseded) {
      return outcome;
    }
    await store.refreshIfStale();
    const session = store.snapshot.session;
    if (!store.snapshot.loaded || session?.status !== "signed_in" || !session.device || session.token === null) {
      return outcome;
    }
    const attempt: Attempt = { manual: options.manual, deviceId: session.device.id, token: session.token, aborted: false, outcome };
    const plan = this.plan(store.snapshot, attempt.deviceId);
    if (plan.unassigned > 0) {
      outcome.problems.push({ printer_id: null, problem: "no_printer", message: PROBLEM_TEXTS.no_printer });
    }
    // Erst alle Drucker bedienen, dann nachfragen.
    const followUps: FollowUp[] = [];
    for (const group of plan.groups) {
      if (attempt.aborted) {
        break;
      }
      if (!options.checkUnknown && group.jobs.every((job) => job.step === "check")) {
        continue;
      }
      const followUp = await this.serve(group, attempt);
      if (followUp) {
        followUps.push(followUp);
      }
    }
    this.summarize(attempt);
    report({ ...outcome, problems: [...outcome.problems] });
    if (followUps.length > 0 && !attempt.aborted && !this.stopped) {
      await this.followUp(followUps, attempt);
      this.summarize(attempt);
    }
    return outcome;
  }

  /** Wie viel nach diesem Versuch noch aussteht. */
  private summarize(attempt: Attempt): void {
    const after = this.plan(this.deps.store.snapshot, attempt.deviceId);
    attempt.outcome.pending = after.pending;
    attempt.outcome.outstanding = after.outstanding;
  }

  /**
   * Fragt nach, solange Aufträge beim Dienst warten: je Drucker der älteste zuerst (er wird
   * zuerst fertig), höchstens `FOLLOW_UP_BUDGET_MS` je Drucker. Will jemand anderes die Sperre,
   * bricht es ab, die laufende Abfrage auch.
   */
  private async followUp(followUps: readonly FollowUp[], attempt: Attempt): Promise<void> {
    const controller = new AbortController();
    this.followingUp = controller;
    const stopWatching = onLockWanted(this.deps.lockName, () => controller.abort());
    const signal = controller.signal;
    try {
      for (const { connection, waiting } of followUps) {
        const started = Date.now();
        let polls = 0;
        while (!signal.aborted && !attempt.aborted && waiting.length > 0 && polls < MAX_FOLLOW_UPS && Date.now() - started < FOLLOW_UP_BUDGET_MS) {
          polls += 1;
          const next = await this.follow(connection, waiting[0] as string, attempt, FOLLOW_UP_WAIT_S, false, signal);
          if (signal.aborted || next === "halt") {
            break;
          }
          if (next !== "waiting") {
            waiting.shift();
          }
        }
        if (signal.aborted || attempt.aborted) {
          break;
        }
      }
    } finally {
      stopWatching();
      if (this.followingUp === controller) {
        this.followingUp = null;
      }
    }
  }

  private problem(attempt: Attempt, printerId: string, problem: PrinterProblem): void {
    if (!attempt.outcome.problems.some((entry) => entry.printer_id === printerId)) {
      attempt.outcome.problems.push({ printer_id: printerId, problem, message: PROBLEM_TEXTS[problem] });
    }
  }

  private connect(printerId: string, token: string, manual: boolean): Promise<ConnectResult> | null {
    const printer = this.deps.store.snapshot.view.printers.get(printerId);
    if (!printer) {
      return null;
    }
    return connect(printer, {
      client: this.deps.client,
      deviceToken: token,
      secureContext: this.deps.isSecureContext(),
      readPermission: this.deps.readPermission,
      manual,
      promptFree: (space) => this.deps.store.snapshot.openNetworks.includes(space),
      learnPromptFree: (space) => {
        void this.deps.store.markNetworkOpen(space).catch(() => undefined);
      },
    });
  }

  /**
   * Alle Etiketten eines Druckers: eine Abfrage, dann der Reihe nach einreichen oder einmal
   * abfragen. Liefert, was danach noch beim Dienst wartet; null, wenn nichts nachzufragen ist.
   */
  private async serve(group: Group, attempt: Attempt): Promise<FollowUp | null> {
    const printer = this.deps.store.snapshot.view.printers.get(group.printerId);
    if (!printer) {
      return null;
    }
    // Der Dienst hat das Token dieses Druckers abgelehnt: erst wieder, wenn der Drucker
    // geändert wurde oder der Anwender es verlangt.
    if (!attempt.manual && this.refused.get(printer.id) === accessOf(printer)) {
      return null;
    }
    const result = await this.connect(printer.id, attempt.token, attempt.manual);
    if (!result) {
      return null;
    }
    if (!result.ok) {
      if (result.unauthorized) {
        await this.deps.onUnauthorized(attempt.token);
        attempt.aborted = true;
        return null;
      }
      if (!result.waiting_for_permission) {
        this.problem(attempt, printer.id, result.problem);
      }
      return null;
    }
    this.refused.delete(printer.id);
    const connection = result.connection;
    await this.reportPrinter(connection, false);
    if (result.problem) {
      this.problem(attempt, printer.id, result.problem);
    }

    const waiting: string[] = [];
    let checks = 0;
    let halted = false;
    // Auf Wunsch des Anwenders wartet jemand auf den Bericht: einreichen, ohne auf den Druck zu warten.
    const submitWait = attempt.manual ? 0 : SUBMIT_WAIT_S;
    for (const planned of group.jobs) {
      if (attempt.aborted || halted) {
        break;
      }
      let next: Next = "done";
      if (planned.step === "submit") {
        // Hinter einem Auftrag, der noch wartet, lohnt das Warten nicht: Der Drucker arbeitet der Reihe nach.
        next = await this.submit(connection, planned.id, attempt, waiting.length === 0 ? submitWait : 0);
      } else if (planned.step === "follow") {
        next = await this.follow(connection, planned.id, attempt, 0);
      } else if (checks < MAX_UNKNOWN_CHECKS) {
        checks += 1;
        await this.check(connection, planned.id, attempt);
      }
      if (next === "waiting") {
        waiting.push(planned.id);
      } else if (next === "halt") {
        halted = true;
      }
    }
    // Antwortet der Dienst nicht mehr, lohnt auch das Nachfragen jetzt nicht.
    return !halted && waiting.length > 0 ? { connection, waiting } : null;
  }

  // ---------------------------------------------------------------- Einreichen

  private async submit(connection: Connection, jobId: string, attempt: Attempt, waitS: number): Promise<Next> {
    const { store, client } = this.deps;
    const state = store.snapshot;
    const job = state.view.print_jobs.get(jobId);
    if (!job || job.device_id !== attempt.deviceId || job.state !== "pending") {
      return "done";
    }
    // An den Druckdienst des Servers erst, wenn es das Etikett dort gibt: nach dem Abgleich.
    if (connection.endpoint.kind === "server" && state.outbox.some((entry) => entry.command.type === "print.request" && entry.command.job_id === jobId)) {
      return "done";
    }
    let entry = state.deliveries.get(jobId);
    /** Dieser Auftrag ist noch nie hinausgegangen. */
    let fresh = false;
    if (entry?.phase === "handoff") {
      return "done";
    }
    if (entry?.phase === "accepted") {
      // Angenommen, aber die Meldung dazu fehlt (die App wurde dazwischen geschlossen): nachfragen.
      return this.follow(connection, jobId, attempt, 0);
    }
    if (!entry) {
      if (connection.service === null) {
        // Der Dienst hat diesen Drucker nicht: Das Etikett bleibt ausstehend, bis die Angaben stimmen.
        return "done";
      }
      const content = buildContent(state.view, job, connection.queue);
      if (!content) {
        return "done";
      }
      const wanted: DeliveryEntry = {
        job_id: jobId,
        printer_id: connection.printer.id,
        url: connection.url ?? "",
        boot_id: connection.health.boot_id,
        content,
        phase: "sending",
        created_at: this.deps.now().toISOString(),
      };
      // Erst festschreiben, dann absenden. Hat ein anderer Tab inzwischen festgeschrieben, gilt dessen Eintrag.
      const written = await store.mutate((mutation) => {
        const current = mutation.draft.get("print_jobs", jobId);
        if (!current || current.state !== "pending" || current.device_id !== mutation.deviceId) {
          return null;
        }
        const existing = mutation.delivery(jobId);
        if (existing) {
          return existing;
        }
        mutation.putDelivery(wanted);
        return wanted;
      });
      if (!written || written.phase !== "sending") {
        return "done";
      }
      entry = written;
      fresh = written === wanted;
    }
    // Genau der festgehaltene Inhalt geht hinaus, bei jeder Wiederholung derselbe.
    const content = entry.content;
    if (!content) {
      return "done";
    }

    for (let round = 0; round < 2; round += 1) {
      const reply = await client.submit(connection.endpoint, jobId, content, entry.boot_id, waitS);
      if (reply.ok) {
        attempt.outcome.delivered += 1;
        return this.adopt(connection, jobId, reply.value);
      }
      if (!reply.reached) {
        // Keine Antwort: Es bleibt, wie es ist. Der nächste Versuch schickt denselben Auftrag wieder.
        return "halt";
      }
      switch (reply.code) {
        case "boot_mismatch": {
          if (!fresh) {
            // Schon einmal abgeschickt, und der Dienst läuft inzwischen neu: Niemand weiß, ob gedruckt wurde.
            await this.write(jobId, "unknown", connection.printer.id, entry.boot_id, "interrupted", "drop");
            return "done";
          }
          const boot = typeof reply.details?.boot_id === "string" ? reply.details.boot_id : null;
          if (round === 0 && boot !== null) {
            // Noch nie abgeschickt: mit der neuen `boot_id` einreichen.
            const renewed: DeliveryEntry = { ...entry, boot_id: boot };
            await store.mutate((mutation) => mutation.putDelivery(renewed));
            entry = renewed;
            continue;
          }
          await this.dropEntry(jobId);
          return "halt";
        }
        case "job_conflict":
          // Der Dienst kennt die Kennung schon: dessen Zustand übernehmen.
          return this.follow(connection, jobId, attempt, 0, true);
        case "unknown_printer":
        case "invalid_request":
        case "render_failed":
          await this.write(jobId, "failed", connection.printer.id, connection.health.boot_id, reply.code, "drop");
          return "done";
        case "unauthorized":
          if (fresh) {
            await this.dropEntry(jobId);
          }
          if (connection.endpoint.kind === "server") {
            await this.deps.onUnauthorized(attempt.token);
            attempt.aborted = true;
          } else {
            // Das Token des Druckers stimmt nicht.
            this.refused.set(connection.printer.id, accessOf(connection.printer));
            this.problem(attempt, connection.printer.id, "not_verified");
          }
          return "halt";
        case "queue_full":
          if (fresh) {
            await this.dropEntry(jobId);
          }
          return "halt";
        case "not_found":
        case "not_pending":
          // Nur am Server: Dort gibt es das Etikett (noch) nicht, oder es ist schon erledigt. Der Abgleich klärt es.
          if (fresh) {
            await this.dropEntry(jobId);
          }
          this.deps.requestSync();
          return "done";
        default:
          // Ein Fehler, den der Vertrag nicht kennt: nichts annehmen, nichts ändern.
          return "halt";
      }
    }
    return "halt";
  }

  // ---------------------------------------------------------------- Nachfragen

  /**
   * Fragt den Stand eines Auftrags ab, den der Dienst angenommen hat. `adoptOnly`: nach
   * `job_conflict`; der Dienst kennt die Kennung, was immer das Etikett hier gerade zeigt.
   * `signal` bricht die Abfrage ab (das Nachfragen gibt nach); dann ändert sich nichts.
   */
  private async follow(connection: Connection, jobId: string, attempt: Attempt, waitS: number, adoptOnly = false, signal?: AbortSignal): Promise<Next> {
    const state = this.deps.store.snapshot;
    const job = state.view.print_jobs.get(jobId);
    if (!job || job.device_id !== attempt.deviceId || SETTLED.has(job.state)) {
      return "done";
    }
    const entry = state.deliveries.get(jobId);
    const expected = adoptOnly ? null : (entry?.boot_id ?? job.boot_id);
    const interrupted = async (): Promise<Next> => {
      // Ein neuer Lauf des Dienstes, oder er kennt den Auftrag nicht mehr: Der Ausgang ist offen.
      await this.write(jobId, "unknown", connection.printer.id, expected, "interrupted", "drop");
      return "done";
    };
    if (expected !== null && connection.health.boot_id !== expected) {
      return interrupted();
    }
    const reply = await this.deps.client.job(connection.endpoint, jobId, waitS, signal);
    if (reply.ok) {
      if (expected !== null && reply.value.boot_id !== expected) {
        return interrupted();
      }
      return this.adopt(connection, jobId, reply.value);
    }
    if (!reply.reached) {
      return "halt";
    }
    if (reply.code === "not_found") {
      return adoptOnly ? "done" : interrupted();
    }
    return this.refusedBy(connection, reply, attempt);
  }

  /** Ein Etikett mit offenem Ausgang: Kennt der Dienst den Auftrag doch, gilt dessen Zustand. */
  private async check(connection: Connection, jobId: string, attempt: Attempt): Promise<void> {
    const state = this.deps.store.snapshot;
    const job = state.view.print_jobs.get(jobId);
    if (!job || job.device_id !== attempt.deviceId || job.state !== "unknown") {
      return;
    }
    const entry = state.deliveries.get(jobId);
    const boot = entry?.boot_id ?? job.boot_id;
    // Nach einer Übergabe (Notweg) weiß die App nicht, in welchem Lauf eingereicht wurde. Sonst
    // lohnt die Frage nur im selben Lauf: Ein neuer kennt den Auftrag nicht.
    if (entry?.phase !== "handoff" && boot !== connection.health.boot_id) {
      return;
    }
    const reply = await this.deps.client.job(connection.endpoint, jobId, 0);
    if (reply.ok && reply.value.state !== "unknown") {
      await this.adopt(connection, jobId, reply.value);
    } else if (!reply.ok && reply.reached) {
      await this.refusedBy(connection, reply, attempt);
    }
  }

  /** Der Dienst hat eine Nachfrage abgelehnt. */
  private async refusedBy(connection: Connection, reply: Extract<ServiceReply<unknown>, { reached: true }>, attempt: Attempt): Promise<Next> {
    if (reply.code === "unauthorized" && connection.endpoint.kind === "server") {
      await this.deps.onUnauthorized(attempt.token);
      attempt.aborted = true;
      return "halt";
    }
    return "done";
  }

  /** Übernimmt für das Etikett, was der Dienst über den Auftrag sagt, und meldet es. */
  private async adopt(connection: Connection, jobId: string, serviceJob: ServiceJob): Promise<Next> {
    const printerId = connection.printer.id;
    const boot = serviceJob.boot_id;
    switch (serviceJob.state) {
      case "queued":
      case "printing": {
        const snapshot = this.deps.store.snapshot;
        const current = snapshot.deliveries.get(jobId);
        const job = snapshot.view.print_jobs.get(jobId);
        const booked = current?.phase === "accepted" && current.printer_id === printerId && current.boot_id === boot;
        // "printing" (so schreibt es der Server selbst fort) sagt mehr als "queued": nicht zurückmelden.
        const reported = job !== undefined && (job.state === "queued" || job.state === "printing") && job.printer_id === printerId && job.boot_id === boot;
        if (booked && reported) {
          return "waiting";
        }
        const accepted: DeliveryEntry = {
          job_id: jobId,
          printer_id: printerId,
          url: connection.url ?? "",
          boot_id: boot,
          content: current?.content ?? null,
          phase: "accepted",
          created_at: current?.created_at ?? this.deps.now().toISOString(),
        };
        if (reported) {
          await this.deps.store.mutate((mutation) => mutation.putDelivery(accepted));
        } else {
          await this.write(jobId, "queued", printerId, boot, null, accepted);
        }
        return "waiting";
      }
      case "printed":
      case "sent":
        await this.write(jobId, serviceJob.state, printerId, boot, null, "drop");
        return "done";
      case "failed":
        await this.write(jobId, "failed", printerId, boot, serviceJob.error?.code ?? "unknown", "drop");
        return "done";
      case "unknown":
        await this.write(jobId, "unknown", printerId, boot, "interrupted", "drop");
        return "done";
      default:
        return "done";
    }
  }

  // ---------------------------------------------------------------- Schreiben

  /**
   * Meldet den Zustand eines Etiketts (`print.report`, immer mit Drucker und `boot_id`) und führt
   * die Buchführung nach, beides in einem Schreibvorgang. Sagt die Meldung nichts Neues, entsteht
   * kein Befehl: Jede Meldung ist ein Befehl in der Outbox.
   */
  private async write(jobId: string, state: PrintJobState, printerId: string, bootId: string | null, error: string | null, ledger: DeliveryEntry | "drop" | "keep"): Promise<void> {
    const emitted = await this.deps.store.mutate((mutation) => {
      const job = mutation.draft.get("print_jobs", jobId);
      if (!job) {
        // Das Etikett fehlt hier gerade: verworfen (dann räumt der Abgleich die Buchführung ab),
        // oder der Bestand hinkt nach einem Abgleich in einem anderen Tab kurz hinterher. Zu
        // melden gibt es nichts; was über den Auftrag feststeht, bleibt festgehalten.
        if (ledger !== "drop" && ledger !== "keep") {
          mutation.putDelivery(ledger);
        }
        return false;
      }
      if (ledger === "drop") {
        mutation.dropDelivery(jobId);
      } else if (ledger !== "keep") {
        mutation.putDelivery(ledger);
      }
      if (job.state === state && job.printer_id === printerId && job.boot_id === bootId && job.error === error) {
        return false;
      }
      if (progressAfterOutcome(job.state, state)) {
        // Ein Zwischenstand ändert kein Etikett mit Ausgang (docs/sync-protokoll.md, 6.6): Die
        // Meldung bliebe ohne Wirkung. Die Buchführung oben gilt trotzdem; nachgefragt wird weiter.
        return false;
      }
      if (job.state === "cancelled" && state === "failed" && error === "cancelled") {
        // Hier schon verworfen, und der Dienst meldet dasselbe („gescheitert: verworfen"), etwa
        // weil eine Abfrage die Antwort auf das Verwerfen kreuzt: nichts Neues.
        return false;
      }
      mutation.emit({ type: "print.report", job_id: jobId, state, printer_id: printerId, boot_id: bootId, error });
      return true;
    });
    if (emitted) {
      this.deps.onChange();
    }
  }

  private async dropEntry(jobId: string): Promise<void> {
    await this.deps.store.mutate((mutation) => mutation.dropDelivery(jobId));
  }

  /**
   * Reicht den Zustand eines direkten Druckers weiter (`printer.report`): höchstens einmal je
   * Minute und Drucker, außer es hat sich etwas geändert oder der Anwender hat abgefragt. Eine
   * neue Meldung ersetzt eine ältere, die noch ungesendet in der Outbox wartet
   * (`Mutation.reportPrinter`): Im Keller ohne Server steht je Drucker höchstens eine dort.
   * Für Drucker am Server meldet kein Gerät; der Server schreibt selbst.
   */
  private async reportPrinter(connection: Connection, force: boolean): Promise<void> {
    if (connection.endpoint.kind !== "direct") {
      return;
    }
    const { store } = this.deps;
    const printerId = connection.printer.id;
    const status = connection.service?.status ?? null;
    const boot = connection.health.boot_id;
    const known = store.snapshot.view.printer_status.get(printerId);
    const changed = !known || known.boot_id !== boot || !sameStatus(known.status, status);
    const nowMs = this.deps.now().getTime();
    const last = this.reportedAt.get(printerId);
    const recentlyHere = last !== undefined && Math.abs(nowMs - last) < PRINTER_REPORT_INTERVAL_MS;
    const recentlySeen = known !== undefined && Math.abs(store.serverNowMs() - Date.parse(known.observed_at)) < PRINTER_REPORT_INTERVAL_MS;
    if (!force && !changed && (recentlyHere || recentlySeen)) {
      return;
    }
    try {
      await store.mutate((mutation) => {
        if (!mutation.draft.get("printers", printerId)) {
          return;
        }
        mutation.reportPrinter({ printer_id: printerId, boot_id: boot, status, host: connection.health.host ?? null });
      });
      this.reportedAt.set(printerId, nowMs);
      this.deps.onChange();
    } catch {
      // Der Zustand ist eine Zugabe; am Zustellen ändert sein Fehlen nichts.
    }
  }

  // ---------------------------------------------------------------- Auf Wunsch des Anwenders

  private session(): { deviceId: string; token: string } | null {
    const session = this.deps.store.snapshot.session;
    return session?.status === "signed_in" && session.device && session.token !== null ? { deviceId: session.device.id, token: session.token } : null;
  }

  /**
   * Fragt den Druckdienst eines Druckers jetzt ab (`printers.probe`). Darf die Nachfrage des
   * Browsers auslösen. @throws CoreError not_found
   */
  async probe(printerId: string): Promise<PrinterProbe> {
    const printer = this.deps.store.snapshot.view.printers.get(printerId);
    if (!printer || printer.deleted_at !== null) {
      throw new CoreError("not_found", "Den Drucker gibt es nicht.");
    }
    const failed = (problem: PrinterProblem): PrinterProbe => ({ reachable: false, url: null, health: null, problem, error: PROBLEM_TEXTS[problem] });
    const session = this.session();
    if (!session && printer.connection === "server") {
      return failed("offline");
    }
    const result = await this.connect(printer.id, session?.token ?? "", true);
    if (!result) {
      throw new CoreError("not_found", "Den Drucker gibt es nicht.");
    }
    if (!result.ok) {
      if (result.unauthorized && session) {
        await this.deps.onUnauthorized(session.token);
      }
      return failed(result.problem);
    }
    this.refused.delete(printer.id);
    const connection = result.connection;
    await this.reportPrinter(connection, true);
    if (connection.endpoint.kind === "server") {
      // Den Zustand seiner Drucker schreibt der Server selbst fort; der Abgleich bringt ihn.
      this.deps.requestSync();
    }
    return {
      reachable: true,
      url: connection.url,
      health: connection.health,
      problem: result.problem,
      error: result.problem ? PROBLEM_TEXTS[result.problem] : null,
    };
  }

  /**
   * Muss ein Etikett vor dem Verwerfen erst beim Druckdienst verworfen werden? Ja, wenn es ein
   * eigenes ist, das dort wartet oder dorthin unterwegs sein kann.
   */
  needsServiceCancel(job: PrintJob): boolean {
    const session = this.session();
    if (!session || job.device_id !== session.deviceId) {
      return false;
    }
    if (job.state === "queued") {
      return true;
    }
    const entry = this.deps.store.snapshot.deliveries.get(job.id);
    return job.state === "pending" && entry !== undefined && entry.phase !== "handoff";
  }

  /**
   * Verwirft ein eigenes Etikett beim Druckdienst und meldet es als "cancelled".
   *
   * Ein ausstehendes Etikett ("pending"), das vielleicht schon unterwegs ist (abgeschickt ohne
   * Antwort), wird zuerst beim Dienst verworfen, damit es dort nicht doch noch druckt. Ist der
   * Dienst nicht erreichbar, wird es trotzdem verworfen, wie jedes ausstehende Etikett auch
   * ohne Netz: Druckt der Dienst es später doch, ist das kein doppelter Druck.
   * Ist sein Drucker gelöscht und antwortet nicht mehr, wird auch ein wartendes Etikett nur hier verworfen.
   * @throws CoreError offline (Dienst nicht erreichbar, Etikett wartet dort) | invalid (er druckt schon, oder der Ausgang ist offen)
   */
  async cancelAtService(jobId: string): Promise<void> {
    // Das Verwerfen nimmt keine Sperre und wartet auf nichts. Das Nachfragen dieses Tabs gibt
    // trotzdem nach: Es fragt womöglich gerade nach genau diesem Etikett.
    this.yieldFollowUps();
    const state = this.deps.store.snapshot;
    const job = state.view.print_jobs.get(jobId);
    const session = this.session();
    if (!job || !session) {
      throw new CoreError("not_found", PRINT_TEXTS.no_job);
    }
    const entry = state.deliveries.get(jobId);
    const printerId = entry?.printer_id ?? job.printer_id;
    const printer = printerId === null ? undefined : state.view.printers.get(printerId);
    // Den Drucker gibt es nicht mehr: Auf seine Antwort zu warten, hieße womöglich für immer.
    const printerGone = printer === undefined || printer.deleted_at !== null;
    const unreachable = async (): Promise<void> => {
      if (job.state === "pending" || printerGone) {
        // Druckt der Dienst es später doch, ist das kein doppelter Druck: Das Etikett ist nur verworfen.
        await this.cancelLocally(jobId, printerGone);
        return;
      }
      throw new CoreError("offline", PRINT_TEXTS.cancel_offline);
    };
    const result = printerId === null ? null : await this.connect(printerId, session.token, true);
    if (!result || !result.ok) {
      if (result?.unauthorized) {
        await this.deps.onUnauthorized(session.token);
      }
      return unreachable();
    }
    const connection = result.connection;
    await this.reportPrinter(connection, false);
    const attempt: Attempt = { manual: true, deviceId: session.deviceId, token: session.token, aborted: false, outcome: emptyOutcome() };
    const reply = await this.deps.client.cancel(connection.endpoint, jobId);
    if (reply.ok) {
      await this.write(jobId, "cancelled", connection.printer.id, reply.value.boot_id, null, "drop");
      return;
    }
    if (!reply.reached) {
      return unreachable();
    }
    if (reply.code === "not_cancellable") {
      // Er druckt schon oder ist fertig: Das Etikett zeigt, was der Dienst sagt.
      await this.follow(connection, jobId, attempt, 0, true);
      throw new CoreError("invalid", PRINT_TEXTS.not_cancellable);
    }
    if (reply.code === "not_found") {
      if (job.state === "pending") {
        // Der Dienst hat den Auftrag nie angenommen: Es gibt dort nichts zu verwerfen.
        await this.write(jobId, "cancelled", connection.printer.id, null, null, "drop");
        return;
      }
      // Angenommen war er, und der Dienst kennt ihn nicht mehr (neuer Lauf): Der Ausgang ist offen.
      await this.write(jobId, "unknown", connection.printer.id, entry?.boot_id ?? job.boot_id, "interrupted", "drop");
      throw new CoreError("invalid", PRINT_TEXTS.cancel_lost);
    }
    if (reply.code === "unauthorized" && connection.endpoint.kind === "server") {
      await this.deps.onUnauthorized(session.token);
    }
    return unreachable();
  }

  /**
   * Verwirft ein Etikett nur hier (`print.report` mit "cancelled"), ohne den Dienst: ein
   * ausstehendes, oder ein wartendes, dessen Drucker gelöscht ist und nicht antwortet.
   */
  private async cancelLocally(jobId: string, printerGone = false): Promise<void> {
    await this.deps.store.mutate((mutation) => {
      const current = mutation.draft.get("print_jobs", jobId);
      if (!current || (current.state !== "pending" && !(printerGone && current.state === "queued"))) {
        // Inzwischen beim Dienst angekommen (ein anderer Tab hat zugestellt) oder erledigt.
        throw new CoreError("invalid", PRINT_TEXTS.not_pending);
      }
      mutation.dropDelivery(jobId);
      mutation.emit({ type: "print.report", job_id: jobId, state: "cancelled", printer_id: current.printer_id, boot_id: current.boot_id, error: null });
    });
    this.deps.onChange();
  }

  /**
   * Das Bild, das der Bild-Treiber für ein Etikett geschrieben hat.
   * @throws CoreError not_found | offline
   */
  async image(jobId: string): Promise<Blob> {
    const job = this.deps.store.snapshot.view.print_jobs.get(jobId);
    const session = this.session();
    if (!job || job.printer_id === null || !session) {
      throw new CoreError("not_found", PRINT_TEXTS.no_image);
    }
    const result = await this.connect(job.printer_id, session.token, true);
    if (!result) {
      throw new CoreError("not_found", PRINT_TEXTS.no_image);
    }
    if (!result.ok) {
      if (result.unauthorized) {
        await this.deps.onUnauthorized(session.token);
      }
      throw new CoreError("offline", PRINT_TEXTS.image_offline);
    }
    await this.reportPrinter(result.connection, false);
    const reply = await this.deps.client.image(result.connection.endpoint, jobId);
    if (reply.ok) {
      return reply.value;
    }
    throw reply.reached ? new CoreError("not_found", PRINT_TEXTS.no_image) : new CoreError("offline", PRINT_TEXTS.image_offline);
  }
}
