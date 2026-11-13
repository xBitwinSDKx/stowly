/**
 * Wann abgeglichen wird (docs/sync-protokoll.md, 9.4): Anlässe, Zusammenfassen, Wartezeiten.
 * Geprüft mit einer Uhr von Hand, ohne Browser und ohne Datenbank.
 */
import { describe, expect, it } from "vitest";

import { CoreError } from "@/contract";

import type { SyncOutcome } from "./engine";
import { CHANGE_DEBOUNCE_MS, INTERVAL_MS, LOOKUP_DELAYS_MS, RETRY_DELAYS_MS, SyncScheduler, type SchedulerTimers } from "./scheduler";

const OK: SyncOutcome = { ok: true, synced: true };
const OFFLINE: SyncOutcome = { ok: false, error: new CoreError("offline") };

/** Zeitgeber von Hand: `advance` lässt die Uhr laufen und führt aus, was fällig wird. */
function manualTimers() {
  let now = 0;
  let nextHandle = 1;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const timers: SchedulerTimers = {
    set(callback, delayMs) {
      const handle = nextHandle;
      nextHandle += 1;
      pending.set(handle, { at: now + delayMs, callback });
      return handle;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    get now() {
      return now;
    },
    get count() {
      return pending.size;
    },
    /** Lässt `ms` Millisekunden vergehen; fällige Zeitgeber laufen in ihrer Reihenfolge, dazwischen kommt der Abgleich zum Zug. */
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) {
          break;
        }
        pending.delete(due[0]);
        now = due[1].at;
        due[1].callback();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

/** Lässt alle schon fälligen Fortsetzungen laufen. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

function setup(options: { visible?: boolean; auto?: boolean } = {}) {
  const clock = manualTimers();
  const runs: number[] = [];
  const state = { visible: options.visible ?? true, outcome: OK as SyncOutcome, lookups: [] as string[], gate: null as Promise<void> | null };
  const scheduler = new SyncScheduler({
    async run() {
      runs.push(clock.now);
      if (state.gate) {
        await state.gate;
      }
      return state.outcome;
    },
    isVisible: () => state.visible,
    pendingLookups: () => state.lookups,
    timers: clock.timers,
    auto: options.auto,
  });
  return { clock, runs, state, scheduler };
}

describe("Anlässe", () => {
  it("gleicht auf Wunsch sofort ab und danach alle 60 Sekunden, solange die App sichtbar ist", async () => {
    const { clock, runs, scheduler, state } = setup();
    await scheduler.request();
    expect(runs).toEqual([0]);

    await clock.advance(INTERVAL_MS - 1);
    expect(runs).toEqual([0]);
    await clock.advance(1);
    expect(runs).toEqual([0, 60_000]);
    await clock.advance(INTERVAL_MS);
    expect(runs).toEqual([0, 60_000, 120_000]);

    // Im Hintergrund ruht die Uhr; beim Zurückkehren wird sofort abgeglichen.
    state.visible = false;
    scheduler.notifyVisibility(false);
    await clock.advance(5 * INTERVAL_MS);
    expect(runs).toHaveLength(3);
    state.visible = true;
    scheduler.notifyVisibility(true);
    await settle();
    expect(runs).toHaveLength(4);
    expect(runs.at(-1)).toBe(clock.now);
  });

  it("fasst lokale Änderungen über höchstens 2 Sekunden zusammen", async () => {
    const { clock, runs, scheduler } = setup();
    scheduler.notifyChange();
    await clock.advance(1_500);
    // Weitere Änderungen verlängern die Wartezeit nicht.
    scheduler.notifyChange();
    scheduler.notifyChange();
    expect(runs).toEqual([]);
    await clock.advance(CHANGE_DEBOUNCE_MS - 1_500);
    expect(runs).toEqual([2_000]);

    scheduler.notifyChange();
    await clock.advance(CHANGE_DEBOUNCE_MS);
    expect(runs).toEqual([2_000, 4_000]);
  });

  it("gleicht ab, wenn der Browser online meldet", async () => {
    const { runs, scheduler } = setup();
    scheduler.notifyOnline();
    await settle();
    expect(runs).toEqual([0]);
  });

  it("sieht nach neuen Platzhaltern zusätzlich nach 3, 10 und 30 Sekunden", async () => {
    const { clock, runs, scheduler, state } = setup();
    state.lookups = ["p1"];
    await scheduler.request();
    await clock.advance(30_000);
    expect(runs).toEqual([0, ...LOOKUP_DELAYS_MS]);

    // Bleibt der Platzhalter offen, gilt wieder nur der gewohnte Takt.
    await clock.advance(INTERVAL_MS);
    expect(runs).toEqual([0, 3_000, 10_000, 30_000, 90_000]);

    // Ein weiterer Platzhalter beginnt die Folge neu.
    state.lookups = ["p1", "p2"];
    scheduler.notifyOnline();
    await settle();
    const start = clock.now;
    await clock.advance(30_000);
    expect(runs.slice(5)).toEqual([start, start + 3_000, start + 10_000, start + 30_000]);
  });
});

describe("Ein Abgleich zur Zeit", () => {
  it("startet während eines laufenden Abgleichs keinen zweiten, sondern genau einen danach", async () => {
    const { runs, scheduler, state } = setup();
    let open: () => void = () => undefined;
    state.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const first = scheduler.request();
    await settle();
    const second = scheduler.request();
    const third = scheduler.request();
    await settle();
    expect(runs).toHaveLength(1);
    expect(second).toBe(third);

    state.gate = null;
    open();
    await first;
    await second;
    expect(runs).toHaveLength(2);
  });

  it("gibt das Ergebnis des Versuchs zurück, auch nach einem Fehlschlag", async () => {
    const { scheduler, state } = setup();
    state.outcome = OFFLINE;
    await expect(scheduler.request()).resolves.toEqual(OFFLINE);
  });
});

describe("Fehlschläge", () => {
  it("wartet nach einem Fehlschlag 2, 5, 15, dann 60 Sekunden", async () => {
    const { clock, runs, scheduler, state } = setup();
    state.outcome = OFFLINE;
    await scheduler.request();
    await clock.advance(2_000 + 5_000 + 15_000 + 60_000 + 60_000);
    expect(RETRY_DELAYS_MS).toEqual([2_000, 5_000, 15_000, 60_000]);
    expect(runs).toEqual([0, 2_000, 7_000, 22_000, 82_000, 142_000]);

    // Nach einem Erfolg beginnt die Folge von vorn.
    state.outcome = OK;
    await clock.advance(60_000);
    state.outcome = OFFLINE;
    await clock.advance(60_000);
    const failedAt = runs.at(-1) ?? 0;
    await clock.advance(2_000);
    expect(runs.at(-1)).toBe(failedAt + 2_000);
  });

  it("sendet bei verschiedenen Protokollversionen nicht mehr von selbst, auf Wunsch aber schon", async () => {
    const { clock, runs, scheduler, state } = setup();
    state.outcome = { ok: false, error: new CoreError("protocol_mismatch") };
    await scheduler.request();
    expect(scheduler.isBlocked).toBe(true);
    scheduler.notifyChange();
    scheduler.notifyOnline();
    scheduler.notifyVisibility(true);
    await clock.advance(10 * INTERVAL_MS);
    expect(runs).toEqual([0]);

    state.outcome = OK;
    await scheduler.request(true);
    expect(scheduler.isBlocked).toBe(false);
    expect(runs).toHaveLength(2);
    await clock.advance(INTERVAL_MS);
    expect(runs).toHaveLength(3);
  });

  it("versucht es im Hintergrund nicht nach der Uhr erneut", async () => {
    const { clock, runs, scheduler, state } = setup({ visible: false });
    state.outcome = OFFLINE;
    await scheduler.request();
    await clock.advance(10 * INTERVAL_MS);
    expect(runs).toEqual([0]);
    expect(clock.count).toBe(0);
  });
});

describe("Anhalten", () => {
  it("lässt nach stop() keine Zeitgeber zurück", async () => {
    const { clock, runs, scheduler, state } = setup();
    state.lookups = ["p1"];
    await scheduler.request();
    scheduler.notifyChange();
    expect(clock.count).toBeGreaterThan(0);
    scheduler.stop();
    expect(clock.count).toBe(0);
    scheduler.notifyChange();
    scheduler.notifyOnline();
    await clock.advance(10 * INTERVAL_MS);
    expect(runs).toEqual([0]);
  });

  it("gleicht ohne `auto` nie von selbst ab", async () => {
    const { clock, runs, scheduler } = setup({ auto: false });
    scheduler.notifyChange();
    scheduler.notifyOnline();
    scheduler.notifyVisibility(true);
    await clock.advance(10 * INTERVAL_MS);
    expect(runs).toEqual([]);
    await scheduler.request(true);
    expect(runs).toHaveLength(1);
    expect(clock.count).toBe(0);
  });
});
