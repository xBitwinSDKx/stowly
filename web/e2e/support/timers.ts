/**
 * Zeitgeber von Hand für den Kern im Test (`createCore({ timers })`): Der Kern merkt seine
 * Wartezeiten vor (Takt des Abgleichs, Prüfung nebenbei, Zustellversuche, die Frist vor
 * „Jetzt drucken"), der Test führt sie aus, wann er will. Alles andere läuft in echter Zeit
 * gegen den echten Server.
 */
import type { SchedulerTimers } from "@/core/sync/scheduler";

export class ManualTimers {
  private readonly pending = new Map<number, { delay: number; callback: () => void }>();
  private next = 1;

  readonly timers: SchedulerTimers = {
    set: (callback, delayMs) => {
      const handle = this.next;
      this.next += 1;
      this.pending.set(handle, { delay: delayMs, callback });
      return handle;
    },
    clear: (handle) => {
      this.pending.delete(handle as number);
    },
  };

  /** Die vorgemerkten Wartezeiten, aufsteigend. */
  delays(): number[] {
    return [...this.pending.values()].map((entry) => entry.delay).sort((a, b) => a - b);
  }

  /** Führt alle Zeitgeber mit dieser Wartezeit aus. Wirft, wenn keiner vorgemerkt ist. */
  fire(delay: number): void {
    const due = [...this.pending].filter(([, entry]) => entry.delay === delay);
    if (due.length === 0) {
      throw new Error(`Kein Zeitgeber mit ${delay} ms; vorgemerkt: ${this.delays().join(", ")}`);
    }
    for (const [handle, entry] of due) {
      this.pending.delete(handle);
      entry.callback();
    }
  }
}
