/**
 * Wann abgeglichen wird (docs/sync-protokoll.md, 9.4) und wann nebenbei geprüft wird, ob der
 * Server erreichbar ist (9.5): Anlässe, Zusammenfassen, Wartezeiten. Geprüft mit einer Uhr von
 * Hand, ohne Browser und ohne Datenbank.
 */
import { describe, expect, it } from "vitest";

import { CoreError } from "@/contract";

import type { SyncOutcome } from "./engine";
import { CHANGE_DEBOUNCE_MS, CHECK_INTERVAL_MS, INTERVAL_MS, LOOKUP_DELAYS_MS, RETRY_DELAYS_MS, SyncScheduler, type SchedulerTimers } from "./scheduler";

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

/**
 * Ein Zeitplan mit nachgebautem Abgleich. Mit `checks` prüft er auch nebenbei; `state.server`
 * sagt, was die Prüfung findet (null: Sie entfällt, weil gerade jemand anderes abgleicht).
 */
function setup(options: { visible?: boolean; auto?: boolean; checks?: boolean } = {}) {
  const clock = manualTimers();
  const runs: number[] = [];
  const checks: number[] = [];
  const state = {
    visible: options.visible ?? true,
    outcome: OK as SyncOutcome,
    lookups: [] as string[],
    gate: null as Promise<void> | null,
    server: true as boolean | null,
    signedIn: true,
    checkGate: null as Promise<void> | null,
  };
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
    ...(options.checks
      ? {
          async check() {
            checks.push(clock.now);
            if (state.checkGate) {
              await state.checkGate;
            }
            return state.server;
          },
          canCheck: () => state.signedIn,
        }
      : {}),
    timers: clock.timers,
    auto: options.auto,
  });
  return { clock, runs, checks, state, scheduler };
}

/** Ein Versprechen, das der Test selbst erfüllt. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
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

describe("Prüfung nebenbei (9.5)", () => {
  it("prüft 15 Sekunden nach dem letzten Kontakt; der Abgleich alle 60 Sekunden ist selbst einer", async () => {
    const { clock, runs, checks, scheduler } = setup({ checks: true });
    await scheduler.request();
    await clock.advance(2 * INTERVAL_MS);
    expect(CHECK_INTERVAL_MS).toBe(15_000);
    expect(runs).toEqual([0, 60_000, 120_000]);
    // Höchstens eine kleine Anfrage je 15 Sekunden, und keine, wenn ohnehin abgeglichen wird.
    expect(checks).toEqual([15_000, 30_000, 45_000, 75_000, 90_000, 105_000]);
  });

  it("merkt einen Ausfall binnen 15 Sekunden und gleicht sofort ab, sobald der Server wieder antwortet", async () => {
    const { clock, runs, checks, state, scheduler } = setup({ checks: true });
    await scheduler.request();
    // Der Server fällt aus, während niemand etwas ändert.
    state.server = false;
    state.outcome = OFFLINE;
    await clock.advance(15_000);
    expect(checks).toEqual([15_000]);

    // Solange er fehlt: kein Abgleich nach der Uhr, nur die Prüfung alle 15 Sekunden.
    await clock.advance(INTERVAL_MS);
    expect(runs).toEqual([0]);
    expect(checks).toEqual([15_000, 30_000, 45_000, 60_000, 75_000]);

    // Er ist wieder da: Die nächste Prüfung merkt es, und es wird sofort abgeglichen.
    state.server = true;
    state.outcome = OK;
    await clock.advance(15_000);
    expect(checks.at(-1)).toBe(90_000);
    expect(runs).toEqual([0, 90_000]);
    // Danach gilt wieder der gewohnte Takt.
    await clock.advance(INTERVAL_MS);
    expect(runs).toEqual([0, 90_000, 150_000]);
  });

  it("wartet nach jedem anderen Kontakt wieder 15 Sekunden; ein anderer Tab meldet Ausfall und Rückkehr", async () => {
    const { clock, runs, checks, state, scheduler } = setup({ checks: true });
    await scheduler.request();
    await clock.advance(10_000);
    // Ein anderer Aufruf hat den Server erreicht (etwa die Geräteliste).
    scheduler.notifyContact(true);
    await clock.advance(10_000);
    expect(checks).toEqual([]);
    await clock.advance(5_000);
    expect(checks).toEqual([25_000]);

    // Ein anderer Tab hat den Ausfall bemerkt: hier kein Abgleich mehr nach der Uhr.
    state.server = false;
    state.outcome = OFFLINE;
    await clock.advance(5_000);
    scheduler.notifyContact(false);
    await clock.advance(INTERVAL_MS - 30_000);
    expect(runs).toEqual([0]);
    expect(checks).toEqual([25_000, 45_000, 60_000]);

    // Er meldet die Rückkehr: sofort abgleichen.
    state.server = true;
    state.outcome = OK;
    scheduler.notifyContact(true);
    await settle();
    expect(runs).toEqual([0, 60_000]);
  });

  it("versucht es ohne Server nach 2, 5 und 15 Sekunden erneut und prüft danach alle 15 Sekunden", async () => {
    const { clock, runs, checks, state, scheduler } = setup({ checks: true });
    state.server = false;
    state.outcome = OFFLINE;
    await scheduler.request();
    await clock.advance(2_000 + 5_000 + 15_000 + 45_000);
    expect(runs).toEqual([0, 2_000, 7_000, 22_000]);
    expect(checks).toEqual([37_000, 52_000, 67_000]);

    state.server = true;
    state.outcome = OK;
    await clock.advance(15_000);
    expect(runs).toEqual([0, 2_000, 7_000, 22_000, 82_000]);
  });

  it("versucht es nach einem Fehler des Servers weiter alle 60 Sekunden; daneben läuft die Prüfung", async () => {
    const { clock, runs, checks, state, scheduler } = setup({ checks: true });
    state.outcome = { ok: false, error: new CoreError("internal") };
    await scheduler.request();
    await clock.advance(2_000 + 5_000 + 15_000 + 60_000);
    expect(runs).toEqual([0, 2_000, 7_000, 22_000, 82_000]);
    // Der Server antwortet ja: Die Prüfung findet ihn, ohne einen Abgleich auszulösen.
    expect(checks).toEqual([37_000, 52_000, 67_000]);
  });

  it("prüft im Hintergrund nicht, auch nicht nach einem Kontakt", async () => {
    const { clock, checks, state, scheduler } = setup({ checks: true });
    await scheduler.request();
    state.visible = false;
    scheduler.notifyVisibility(false);
    scheduler.notifyContact(true);
    await clock.advance(5 * INTERVAL_MS);
    expect(checks).toEqual([]);
    expect(clock.count).toBe(0);

    // Wieder sichtbar: sofort abgleichen, danach wieder prüfen.
    state.visible = true;
    scheduler.notifyVisibility(true);
    await settle();
    const back = clock.now;
    await clock.advance(CHECK_INTERVAL_MS);
    expect(checks).toEqual([back + CHECK_INTERVAL_MS]);
  });

  it("prüft nur angemeldet; abgemeldet bleibt es ohne Server bei 60 Sekunden, nach der Anmeldung beginnt die Prüfung", async () => {
    const { clock, runs, checks, state, scheduler } = setup({ checks: true });
    state.signedIn = false;
    state.server = false;
    state.outcome = OFFLINE;
    await scheduler.request();
    await clock.advance(2_000 + 5_000 + 15_000 + 60_000);
    expect(checks).toEqual([]);
    expect(runs).toEqual([0, 2_000, 7_000, 22_000, 82_000]);

    // Die Anmeldung gleicht außerhalb des Zeitplans ab; danach geht es weiter wie nach einem eigenen Abgleich.
    state.signedIn = true;
    state.server = true;
    state.outcome = OK;
    scheduler.notifySynced(OK);
    const at = clock.now;
    await clock.advance(INTERVAL_MS);
    expect(checks).toEqual([at + 15_000, at + 30_000, at + 45_000]);
    expect(runs.slice(5)).toEqual([at + INTERVAL_MS]);
  });

  it("versucht es 15 Sekunden später wieder, wenn die Prüfung entfiel", async () => {
    const { clock, runs, checks, state, scheduler } = setup({ checks: true });
    await scheduler.request();
    // Ein anderer Tab oder der Service Worker gleicht gerade ab: Die Prüfung fragt nicht.
    state.server = null;
    await clock.advance(30_000);
    expect(checks).toEqual([15_000, 30_000]);
    expect(runs).toEqual([0]);
  });

  it("prüft nie, während dieser Tab abgleicht, und gleicht nach einer Prüfung nicht doppelt ab", async () => {
    const { clock, runs, checks, state, scheduler } = setup({ checks: true });
    await scheduler.request();
    // Ein Abgleich nach einer Änderung dauert länger als 15 Sekunden.
    const slow = gate();
    state.gate = slow.promise;
    scheduler.notifyChange();
    await clock.advance(2_000 + 30_000);
    expect(runs).toEqual([0, 2_000]);
    expect(checks).toEqual([]);
    state.gate = null;
    slow.open();
    await settle();
    await clock.advance(CHECK_INTERVAL_MS);
    expect(checks).toEqual([32_000 + CHECK_INTERVAL_MS]);

    // Der Server fällt aus; die nächste Prüfung hängt, während eine Änderung abgeglichen wird.
    state.server = false;
    await clock.advance(CHECK_INTERVAL_MS);
    const hanging = gate();
    state.checkGate = hanging.promise;
    state.server = true;
    await clock.advance(CHECK_INTERVAL_MS);
    expect(checks).toHaveLength(3);
    scheduler.notifyChange();
    await clock.advance(CHANGE_DEBOUNCE_MS);
    const before = runs.length;
    expect(runs.at(-1)).toBe(clock.now);
    // Die Prüfung kommt erst danach zurück und findet den Server: kein zweiter Abgleich.
    state.checkGate = null;
    hanging.open();
    await settle();
    expect(runs).toHaveLength(before);
  });

  it("ein Abgleich außerhalb des Zeitplans ändert nichts, solange ein eigener läuft", async () => {
    const { clock, runs, checks, state, scheduler } = setup({ checks: true });
    const slow = gate();
    state.gate = slow.promise;
    const running = scheduler.request();
    await settle();
    scheduler.notifySynced(OK);
    await clock.advance(CHECK_INTERVAL_MS);
    expect(checks).toEqual([]);
    state.gate = null;
    slow.open();
    await running;
    expect(runs).toEqual([0]);
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
