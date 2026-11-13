/**
 * Gemeinsames für die Tests des Kerns: ein Kern, eine nachgebaute Schnittstelle, eine Uhr.
 *
 * Jeder Kern bekommt eine eigene, leere Datenbank und gleicht nur ab, wenn der Test es sagt
 * (`autoSync: false`). Aufgeräumt wird über `disposeAll()` nach jedem Test.
 */
import Dexie from "dexie";

import { CoreError, type Live } from "@/contract";

import { createCore, type CoreOptions, type StowlyCore } from "..";
import { createFakeNetwork, FAKE_PASSWORD, FakeServer, type FakeNetwork, type FakeServerOptions } from "./fake-api";

export const START = new Date("2026-11-13T10:00:00.000Z");
export const DAY = 86_400_000;

export interface Clock {
  now(): Date;
  /** Stellt die Uhr vor (oder mit negativem Wert zurück). */
  advance(ms: number): void;
  set(moment: Date): void;
}

export function createClock(start: Date = START): Clock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance(ms) {
      current += ms;
    },
    set(moment) {
      current = moment.getTime();
    },
  };
}

export interface Harness {
  server: FakeServer;
  network: FakeNetwork;
  core: StowlyCore;
  clock: Clock;
  dbName: string;
  /** Ein zweiter Kern auf derselben Datenbank, wie ein zweiter Tab oder der Kern nach dem Neuladen. */
  another(options?: CoreOptions): Promise<StowlyCore>;
}

export interface HarnessOptions {
  server?: FakeServerOptions;
  core?: CoreOptions;
  clock?: Clock;
}

let counter = 0;
const cores: StowlyCore[] = [];
const databases: string[] = [];

/** Ein frischer Kern, noch nicht angemeldet. */
export async function start(options: HarnessOptions = {}): Promise<Harness> {
  counter += 1;
  const clock = options.clock ?? createClock();
  const server = new FakeServer({ now: clock.now, ...options.server });
  const network = createFakeNetwork(server);
  const dbName = `stowly-test-${counter}-${Math.random().toString(36).slice(2, 8)}`;
  databases.push(dbName);
  const coreOptions: CoreOptions = { fetch: network.fetch, now: clock.now, dbName, autoSync: false, ...options.core };
  const core = createCore(coreOptions);
  cores.push(core);
  await core.ready;
  return {
    server,
    network,
    core,
    clock,
    dbName,
    async another(extra = {}) {
      const second = createCore({ ...coreOptions, ...extra });
      cores.push(second);
      await second.ready;
      return second;
    },
  };
}

/** Ein Kern, der angemeldet ist und den ersten Abgleich hinter sich hat. */
export async function signedIn(options: HarnessOptions = {}): Promise<Harness> {
  const harness = await start(options);
  await harness.core.session.login(FAKE_PASSWORD, "Testgerät");
  return harness;
}

/** Beendet alle Kerne und löscht ihre Datenbanken. Gehört in `afterEach`. */
export async function disposeAll(): Promise<void> {
  for (const core of cores.splice(0)) {
    core.dispose();
    await core.ready.catch(() => undefined);
  }
  // Die Datenbanken schließen sich erst nach `ready`; einen Schritt warten, dann löschen.
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const name of databases.splice(0)) {
    await Dexie.delete(name).catch(() => undefined);
  }
}

/** Der aktuelle Wert eines `Live`; wirft, solange nichts geladen ist. */
export function value<T>(live: Live<T>): T {
  const current = live.get();
  if (current === undefined) {
    throw new Error("Live-Wert ist noch nicht geladen");
  }
  return current;
}

/** Erwartet, dass `action` mit einem CoreError dieses Codes scheitert, und liefert ihn. */
export async function expectCoreError(action: Promise<unknown>, code: CoreError["code"]): Promise<CoreError> {
  try {
    await action;
  } catch (error) {
    if (!(error instanceof CoreError)) {
      throw new Error(`Erwartet war CoreError ${code}, geworfen wurde: ${String(error)}`);
    }
    if (error.code !== code) {
      throw new Error(`Erwartet war CoreError ${code}, geworfen wurde ${error.code}: ${error.message}`);
    }
    return error;
  }
  throw new Error(`Erwartet war CoreError ${code}, aber nichts wurde geworfen`);
}

/** Die Befehle einer Sync-Anfrage. */
export function commandsOf(request: Record<string, unknown> | undefined): Record<string, unknown>[] {
  return (request?.commands as Record<string, unknown>[] | undefined) ?? [];
}

/** Die erste (und im Anfangsbestand einzige) Zone. */
export function firstZoneId(core: StowlyCore): string {
  const zone = value(core.data.zones)[0];
  if (!zone) {
    throw new Error("Es gibt keine Zone");
  }
  return zone.id;
}
