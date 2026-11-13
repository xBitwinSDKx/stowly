/**
 * Wann zugestellt wird (docs/etiketten.md, 4.1, „Wann"):
 *
 * - nach dem Anfordern, nach jedem gelungenen Abgleich, beim Start, wenn die App wieder
 *   sichtbar wird, und auf Wunsch sofort (`print.flush`, `printers.probe`);
 * - solange eigene Etiketten ausstehen und die App sichtbar ist, von selbst erneut:
 *   nach 5, 15 und 60 Sekunden, danach alle 60 Sekunden.
 *
 * Es läuft nie mehr als ein Versuch dieses Tabs zugleich (über Tabs hinweg sorgt die Sperre
 * in engine.ts dafür). Ein Anlass, während ein Versuch noch einreicht, führt zu genau einem
 * weiteren danach; einer, während er nur noch nachfragt, beginnt sofort (das Nachfragen gibt
 * nach). Im Hintergrund wird nicht von selbst zugestellt.
 *
 * Wer wartet (`flush`), bekommt den Bericht des Versuchs, sobald eingereicht ist. Den nächsten
 * Termin legt erst das Ende des Nachfragens fest.
 *
 * Wie der Zeitplan des Abgleichs kennt diese Klasse weder `window` noch den Store.
 */
import type { SchedulerTimers } from "../sync/scheduler";
import type { DeliveryOptions, DeliveryOutcome, DeliveryRun } from "./engine";

export const DELIVERY_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 60_000];

/**
 * Warum jetzt zugestellt werden soll. Nur der Abgleich lässt die Wartezeiten, wie sie sind:
 * Er läuft ohnehin jede Minute und soll den Takt nicht wieder auf fünf Sekunden stellen.
 * "permission": Die Erlaubnis des Browsers für das lokale Netzwerk hat sich geändert.
 */
export type DeliveryReason = "request" | "sync" | "start" | "visible" | "permission";

export interface DeliverySchedulerDeps {
  /** Ein Zustellversuch. Wirft nicht. */
  run(options: DeliveryOptions): DeliveryRun;
  /** Ist die App sichtbar? */
  isVisible(): boolean;
  timers?: SchedulerTimers;
  /** false: Es wird nie von selbst zugestellt, nur über `flush()`. Vorgabe true. */
  auto?: boolean;
}

const DEFAULT_TIMERS: SchedulerTimers = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const NOTHING: DeliveryOutcome = { delivered: 0, pending: 0, problems: [], outstanding: 0 };

export class DeliveryScheduler {
  private readonly timers: SchedulerTimers;
  private readonly automatic: boolean;
  private running: Promise<DeliveryOutcome> | null = null;
  /** Was der nächste Versuch nach dem laufenden können soll; null = keiner vorgemerkt. */
  private queued: DeliveryOptions | null = null;
  private waiters: ((outcome: DeliveryOutcome) => void)[] = [];
  private retryTimer: unknown = null;
  private retryLevel = 0;
  private stopped = false;
  /** Zählt die Versuche: Nur der jüngste legt nach seinem Nachfragen den nächsten Termin fest. */
  private generation = 0;

  constructor(private readonly deps: DeliverySchedulerDeps) {
    this.timers = deps.timers ?? DEFAULT_TIMERS;
    this.automatic = deps.auto ?? true;
  }

  /** Beendet die Wartezeiten. Ein laufender Versuch läuft zu Ende. */
  stop(): void {
    this.stopped = true;
    this.clearRetry();
  }

  /** Ein Anlass, von selbst zuzustellen. Ohne Wirkung im Hintergrund und mit `auto: false`. */
  kick(reason: DeliveryReason): void {
    if (this.stopped || !this.automatic || !this.deps.isVisible()) {
      return;
    }
    if (reason !== "sync") {
      this.retryLevel = 0;
    }
    void this.request({ manual: false, checkUnknown: reason === "start" || reason === "visible" });
  }

  /** Auf Wunsch des Anwenders: jetzt zustellen. Erfüllt sich nach einem Versuch, der danach begonnen hat. */
  flush(): Promise<DeliveryOutcome> {
    if (this.stopped) {
      return Promise.resolve(NOTHING);
    }
    this.retryLevel = 0;
    return this.request({ manual: true, checkUnknown: true });
  }

  /** Die App ist sichtbar geworden oder in den Hintergrund gegangen. */
  notifyVisibility(visible: boolean): void {
    if (visible) {
      this.kick("visible");
    } else {
      this.clearRetry();
    }
  }

  private request(options: DeliveryOptions): Promise<DeliveryOutcome> {
    if (this.running === null) {
      return this.launch(options);
    }
    // Der laufende Versuch hat womöglich schon ohne den jüngsten Anlass begonnen: einer danach.
    this.queued = {
      manual: (this.queued?.manual ?? false) || options.manual,
      checkUnknown: (this.queued?.checkUnknown ?? false) || options.checkUnknown,
    };
    return new Promise<DeliveryOutcome>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private launch(options: DeliveryOptions): Promise<DeliveryOutcome> {
    this.clearRetry();
    this.generation += 1;
    const generation = this.generation;
    const run = this.deps.run(options);
    const report = run.report
      .catch(() => NOTHING)
      .then((outcome) => {
        this.running = null;
        const next = this.queued;
        if (next && !this.stopped) {
          const waiters = this.waiters;
          this.queued = null;
          this.waiters = [];
          void this.launch(next).then((later) => {
            for (const resolve of waiters) {
              resolve(later);
            }
          });
        } else {
          for (const resolve of this.waiters.splice(0)) {
            resolve(outcome);
          }
          this.queued = null;
        }
        return outcome;
      });
    this.running = report;
    void run.done
      .catch(() => NOTHING)
      .then((outcome) => {
        // Hat inzwischen ein neuer Versuch begonnen, legt der den nächsten Termin fest.
        if (generation === this.generation && this.running === null) {
          this.afterRun(outcome);
        }
      });
    return report;
  }

  /** Steht nach dem Versuch noch etwas aus, folgt der nächste von selbst. */
  private afterRun(outcome: DeliveryOutcome): void {
    if (this.stopped || !this.automatic) {
      return;
    }
    if (outcome.outstanding === 0) {
      this.retryLevel = 0;
      return;
    }
    if (!this.deps.isVisible()) {
      return;
    }
    const delay = DELIVERY_RETRY_DELAYS_MS[Math.min(this.retryLevel, DELIVERY_RETRY_DELAYS_MS.length - 1)] as number;
    this.retryLevel += 1;
    this.retryTimer = this.timers.set(() => {
      this.retryTimer = null;
      if (!this.stopped && this.deps.isVisible()) {
        void this.request({ manual: false, checkUnknown: false });
      }
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      this.timers.clear(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
