/**
 * Wann abgeglichen wird (docs/sync-protokoll.md, 9.4) und wann nebenbei geprüft wird, ob der
 * Server erreichbar ist (9.5):
 *
 * - beim Start und nach der Anmeldung, wenn der Browser `online` meldet, wenn die App
 *   wieder sichtbar wird und auf Wunsch des Anwenders: sofort
 * - nach jeder lokalen Änderung, zusammengefasst über höchstens 2 Sekunden
 * - alle 60 Sekunden, solange die App sichtbar und der Server erreichbar ist
 * - solange ein Produkt noch nachgeschlagen wird: zusätzlich nach 3, 10 und 30 Sekunden
 * - nach einem Fehlschlag nach 2, 5, 15, dann alle 60 Sekunden; war der Server nicht
 *   erreichbar, übernimmt nach den 15 Sekunden die Prüfung nebenbei
 * - sobald die Prüfung nebenbei (oder ein anderer Kontakt) den Server nach einem Ausfall
 *   wieder erreicht: sofort
 *
 * Die Prüfung nebenbei: Solange die App sichtbar und das Gerät angemeldet ist, fragt der
 * Zeitplan `GET /api/health`, sobald 15 Sekunden lang kein Kontakt zum Server bestand (kein
 * Abgleich, keine Prüfung, kein anderer Aufruf, auch keiner eines anderen Tabs, den
 * `notifyContact` meldet). So merkt die App Ausfall und Rückkehr binnen etwa 15 Sekunden, mit
 * höchstens einer kleinen Anfrage je 15 Sekunden.
 *
 * Es läuft nie mehr als ein Abgleich dieses Tabs zugleich; ein Anlass während eines
 * laufenden Abgleichs führt zu genau einem weiteren danach. Diese Klasse kennt weder
 * `window` noch den Store: Uhr und Umgebung werden hereingereicht, damit sie sich ohne
 * Browser prüfen lässt.
 */
import { CoreError } from "@/contract/errors";

import type { SyncOutcome } from "./engine";

export const CHANGE_DEBOUNCE_MS = 2_000;
export const INTERVAL_MS = 60_000;
export const RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 15_000, 60_000];
export const LOOKUP_DELAYS_MS: readonly number[] = [3_000, 10_000, 30_000];
/** So lange darf es ohne Kontakt zum Server bleiben, bevor nebenbei geprüft wird (9.5). */
export const CHECK_INTERVAL_MS = 15_000;

export interface SchedulerTimers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface SchedulerDeps {
  /** Führt einen Abgleich aus. Wirft nicht. */
  run(): Promise<SyncOutcome>;
  /** Ist die App sichtbar? */
  isVisible(): boolean;
  /** Kennungen der Produkte, deren Nachschlagen noch aussteht. */
  pendingLookups(): readonly string[];
  /**
   * Prüft nebenbei, ob der Server erreichbar ist (9.5): true oder false; null, wenn die
   * Prüfung entfiel (gerade gleicht jemand ab, auch ein anderer Tab oder der Service Worker).
   * Wirft nicht. Ohne diese Funktion prüft der Zeitplan nie nebenbei.
   */
  check?(): Promise<boolean | null>;
  /** Darf jetzt nebenbei geprüft werden? Nur, solange das Gerät angemeldet ist. Vorgabe: ja. */
  canCheck?(): boolean;
  timers?: SchedulerTimers;
  /** false: Es wird nie von selbst abgeglichen, nur auf ausdrücklichen Wunsch (`request(true)`). Vorgabe true. */
  auto?: boolean;
}

const DEFAULT_TIMERS: SchedulerTimers = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type TimerName = "changeTimer" | "intervalTimer" | "retryTimer" | "checkTimer";

export class SyncScheduler {
  private readonly timers: SchedulerTimers;
  private readonly automatic: boolean;
  private running: Promise<SyncOutcome> | null = null;
  /** Wer während eines laufenden Abgleichs fragt, wartet auf den nächsten. */
  private waiting: { promise: Promise<SyncOutcome>; resolve: (outcome: SyncOutcome) => void } | null = null;
  private changeTimer: unknown = null;
  private intervalTimer: unknown = null;
  private retryTimer: unknown = null;
  /** Wartezeit des vorgemerkten neuen Versuchs. */
  private retryDelay = 0;
  private checkTimer: unknown = null;
  private checking = false;
  private lookupTimers: unknown[] = [];
  private readonly polledLookups = new Set<string>();
  private retryLevel = 0;
  /** Was der letzte Kontakt über den Server gesagt hat; null = noch nichts. */
  private reachable: boolean | null = null;
  private blocked = false;
  private stopped = false;

  constructor(private readonly deps: SchedulerDeps) {
    this.timers = deps.timers ?? DEFAULT_TIMERS;
    this.automatic = deps.auto ?? true;
  }

  /** true, solange App und Server verschiedene Protokollversionen sprechen: Es wird nicht mehr von selbst gesendet. */
  get isBlocked(): boolean {
    return this.blocked;
  }

  /** Beendet alle Wartezeiten. Ein laufender Abgleich läuft zu Ende. */
  stop(): void {
    this.stopped = true;
    this.clear("changeTimer");
    this.clear("intervalTimer");
    this.clear("retryTimer");
    this.clear("checkTimer");
    this.clearLookupTimers();
  }

  /**
   * Gleicht jetzt ab und erfüllt sich, wenn ein Versuch beendet ist, der nach diesem Aufruf
   * begonnen hat. `manual` gilt auch dann, wenn sonst nicht mehr gesendet wird.
   */
  request(manual = false): Promise<SyncOutcome> {
    if (manual) {
      this.blocked = false;
    }
    if (this.running === null) {
      return this.launch();
    }
    // Der laufende Abgleich hat womöglich schon ohne die jüngste Änderung begonnen: einer danach.
    if (this.waiting === null) {
      let resolve: (outcome: SyncOutcome) => void = () => undefined;
      const promise = new Promise<SyncOutcome>((done) => {
        resolve = done;
      });
      this.waiting = { promise, resolve };
    }
    return this.waiting.promise;
  }

  private launch(): Promise<SyncOutcome> {
    const run = this.execute().then((outcome) => {
      this.running = null;
      const waiting = this.waiting;
      if (waiting) {
        this.waiting = null;
        void this.launch().then(waiting.resolve);
      }
      return outcome;
    });
    this.running = run;
    return run;
  }

  /** Der Anwender hat etwas geändert. */
  notifyChange(): void {
    if (this.stopped || !this.automatic || this.changeTimer !== null) {
      return;
    }
    this.changeTimer = this.timers.set(() => {
      this.changeTimer = null;
      this.auto();
    }, CHANGE_DEBOUNCE_MS);
  }

  /** Der Browser meldet `online`. */
  notifyOnline(): void {
    this.auto();
  }

  /** Die App ist sichtbar geworden oder in den Hintergrund gegangen. */
  notifyVisibility(visible: boolean): void {
    if (visible) {
      this.auto();
      if (this.running === null) {
        this.armCheck();
      }
    } else {
      // Im Hintergrund wird nicht nach der Uhr abgeglichen und nicht nebenbei geprüft; eine noch
      // wartende Änderung geht trotzdem raus.
      this.clear("intervalTimer");
      this.clear("retryTimer");
      this.clear("checkTimer");
    }
  }

  /**
   * Der Server wurde außerhalb dieses Zeitplans erreicht oder nicht: ein anderer Aufruf an ihn,
   * oder ein anderer Tab hat es erfahren. Die Prüfung nebenbei wartet wieder volle 15 Sekunden;
   * kommt der Server nach einem Ausfall wieder, wird sofort abgeglichen.
   */
  notifyContact(reachable: boolean): void {
    if (this.stopped || !this.automatic) {
      return;
    }
    this.observe(reachable);
    if (this.running === null) {
      this.armCheck();
    }
  }

  /**
   * Ein Abgleich außerhalb dieses Zeitplans ist zu Ende (die Anmeldung): Danach geht es weiter
   * wie nach einem eigenen. Läuft gerade ein eigener, legt der das Weitere fest.
   */
  notifySynced(outcome: SyncOutcome): void {
    if (this.stopped || !this.automatic || this.running !== null) {
      return;
    }
    this.clear("retryTimer");
    this.afterRun(outcome);
  }

  private auto(): void {
    if (this.stopped || this.blocked || !this.automatic) {
      return;
    }
    void this.request();
  }

  private async execute(): Promise<SyncOutcome> {
    this.clear("changeTimer");
    this.clear("retryTimer");
    // Der Abgleich ist selbst ein Kontakt; danach wartet die Prüfung nebenbei wieder von vorn.
    this.clear("checkTimer");
    let outcome: SyncOutcome;
    try {
      outcome = await this.deps.run();
    } catch (error) {
      outcome = { ok: false, error: error instanceof CoreError ? error : new CoreError("internal", String(error)) };
    }
    if (!this.stopped && this.automatic) {
      this.afterRun(outcome);
    }
    return outcome;
  }

  private afterRun(outcome: SyncOutcome): void {
    this.clear("intervalTimer");
    // Jede Antwort des Servers, auch eine Fehlermeldung, zeigt: Er ist erreichbar.
    this.reachable = outcome.ok || outcome.error.code !== "offline";
    if (outcome.ok) {
      this.retryLevel = 0;
      this.scheduleInterval();
      this.pollLookups();
    } else if (outcome.error.code === "protocol_mismatch") {
      // Erst eine neue Version der App kann wieder abgleichen (6.5).
      this.blocked = true;
    } else if (this.deps.isVisible()) {
      this.scheduleRetry(outcome.error.code === "offline");
    }
    this.armCheck();
  }

  private scheduleRetry(offline: boolean): void {
    if (offline && this.retryLevel >= RETRY_DELAYS_MS.length - 1 && this.canCheck()) {
      // Nicht erreichbar, und die schnellen Versuche sind vorbei: Ab jetzt prüft die Uhr alle
      // 15 Sekunden nebenbei und gleicht ab, sobald der Server wieder antwortet.
      return;
    }
    const delay = RETRY_DELAYS_MS[Math.min(this.retryLevel, RETRY_DELAYS_MS.length - 1)] as number;
    this.retryLevel += 1;
    this.retryDelay = delay;
    this.retryTimer = this.timers.set(() => {
      this.retryTimer = null;
      this.auto();
    }, delay);
  }

  private scheduleInterval(): void {
    if (!this.deps.isVisible()) {
      return;
    }
    this.intervalTimer = this.timers.set(() => {
      this.intervalTimer = null;
      if (this.deps.isVisible()) {
        this.auto();
      }
    }, INTERVAL_MS);
  }

  /** Wird nebenbei geprüft? Nur mit einer Prüfung, von selbst, und solange das Gerät angemeldet ist. */
  private canCheck(): boolean {
    return this.deps.check !== undefined && this.automatic && !this.stopped && !this.blocked && (this.deps.canCheck?.() ?? true);
  }

  /** Die Prüfung nebenbei: 15 Sekunden nach dem letzten Kontakt, solange die App sichtbar ist. */
  private armCheck(): void {
    this.clear("checkTimer");
    if (!this.canCheck() || !this.deps.isVisible()) {
      return;
    }
    if (this.retryTimer !== null && this.retryDelay <= CHECK_INTERVAL_MS) {
      // Der nächste Versuch kommt ohnehin früher, und er ist selbst ein Kontakt.
      return;
    }
    this.checkTimer = this.timers.set(() => {
      this.checkTimer = null;
      void this.checkNow();
    }, CHECK_INTERVAL_MS);
  }

  private async checkNow(): Promise<void> {
    const check = this.deps.check;
    // Ein laufender Abgleich ist selbst ein Kontakt; an seinem Ende beginnt die Uhr von vorn.
    if (!check || this.checking || this.running !== null || !this.canCheck() || !this.deps.isVisible()) {
      return;
    }
    this.checking = true;
    let result: boolean | null;
    try {
      result = await check();
    } catch {
      result = null;
    } finally {
      this.checking = false;
    }
    if (this.stopped) {
      return;
    }
    if (result !== null) {
      this.observe(result);
    }
    if (this.running === null) {
      this.armCheck();
    }
  }

  /** Was ein Kontakt über den Server sagt. Kommt er nach einem Ausfall wieder, wird sofort abgeglichen. */
  private observe(reachable: boolean): void {
    const returned = reachable && this.reachable === false;
    this.reachable = reachable;
    if (!reachable) {
      // Solange er nicht erreichbar ist, lohnt der Takt nicht; die Prüfung nebenbei merkt die Rückkehr.
      this.clear("intervalTimer");
    } else if (returned && this.running === null && this.deps.isVisible()) {
      this.auto();
    }
  }

  /** Neue Platzhalter: Der Server ergänzt sie binnen Sekunden; dreimal früher nachsehen als sonst. */
  private pollLookups(): void {
    const pending = this.deps.pendingLookups();
    for (const id of [...this.polledLookups]) {
      if (!pending.includes(id)) {
        this.polledLookups.delete(id);
      }
    }
    const fresh = pending.filter((id) => !this.polledLookups.has(id));
    if (fresh.length === 0) {
      return;
    }
    for (const id of fresh) {
      this.polledLookups.add(id);
    }
    this.clearLookupTimers();
    for (const delay of LOOKUP_DELAYS_MS) {
      const handle = this.timers.set(() => {
        this.lookupTimers = this.lookupTimers.filter((candidate) => candidate !== handle);
        this.auto();
      }, delay);
      this.lookupTimers.push(handle);
    }
  }

  private clearLookupTimers(): void {
    for (const handle of this.lookupTimers) {
      this.timers.clear(handle);
    }
    this.lookupTimers = [];
  }

  private clear(name: TimerName): void {
    const handle = this[name];
    if (handle !== null) {
      this.timers.clear(handle);
      this[name] = null;
    }
  }
}
