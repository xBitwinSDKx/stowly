/**
 * Der Lebenslauf der App im Kern: Installation, dauerhafter Speicher, und was geschieht, wenn
 * sich der Aufbau der lokalen Datenbank ändert (Umstellung von Stand 1, zwei Tabs mit
 * verschiedenen Versionen).
 */
import Dexie from "dexie";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCore, type StowlyCore } from ".";
import { DB_VERSION } from "./db";
import { disposeAll, expectCoreError, firstZoneId, signedIn, value, type Harness } from "./testing/harness";

/** Der Aufbau der lokalen Datenbank in Runde 1 (Version 1), wörtlich. */
const V1_STORES = {
  products: "id",
  packages: "id",
  zones: "id",
  printers: "id",
  printer_status: "printer_id",
  print_jobs: "id",
  label_templates: "key",
  outbox: "++seq, &id",
  id_pool: "++n, &id",
  problems: "id",
  kv: "key",
};

const extraCores: StowlyCore[] = [];
const extraDatabases: string[] = [];

afterEach(async () => {
  for (const core of extraCores.splice(0)) {
    core.dispose();
    await core.ready.catch(() => undefined);
  }
  await disposeAll();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const name of extraDatabases.splice(0)) {
    await Dexie.delete(name).catch(() => undefined);
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

let counter = 0;
function freshName(): string {
  counter += 1;
  const name = `stowly-lifecycle-${counter}-${Math.random().toString(36).slice(2, 8)}`;
  extraDatabases.push(name);
  return name;
}

/** Legt eine Datenbank auf Stand 1 an, mit dem Inhalt der Datenbank eines laufenden Kerns. */
async function copyAsVersion1(from: string, to: string): Promise<void> {
  const source = new Dexie(from);
  await source.open();
  const legacy = new Dexie(to);
  legacy.version(1).stores(V1_STORES);
  await legacy.open();
  for (const table of Object.keys(V1_STORES)) {
    const rows = await source.table(table).toArray();
    if (rows.length > 0) {
      await legacy.table(table).bulkAdd(rows);
    }
  }
  expect(legacy.verno).toBe(1);
  source.close();
  legacy.close();
}

function openCore(harness: Harness, dbName: string, options: Parameters<typeof createCore>[0] = {}): StowlyCore {
  const core = createCore({ fetch: harness.network.fetch, now: harness.clock.now, dbName, autoSync: false, ...options });
  extraCores.push(core);
  return core;
}

describe("Installation und dauerhafter Speicher", () => {
  it("meldet, dass der Browser die Installation anbietet, und zeigt die Aufforderung auf Wunsch", async () => {
    const { core } = await signedIn();
    expect(value(core.app.state)).toMatchObject({ can_install: false, installed: false, manual_install: null });
    expect(await core.app.promptInstall()).toBe(false);

    const event = new Event("beforeinstallprompt", { cancelable: true }) as Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
    let prompted = 0;
    event.prompt = () => {
      prompted += 1;
      return Promise.resolve();
    };
    event.userChoice = Promise.resolve({ outcome: "accepted" });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(value(core.app.state).can_install).toBe(true);

    expect(await core.app.promptInstall()).toBe(true);
    expect(prompted).toBe(1);
    expect(value(core.app.state).can_install).toBe(false);
    window.dispatchEvent(new Event("appinstalled"));
    expect(value(core.app.state)).toMatchObject({ installed: true, can_install: false });
  });

  it("zeigt am iPhone im Browser die Anleitung an, installiert nicht mehr", async () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1");
    const { core } = await signedIn();
    expect(value(core.app.state)).toMatchObject({ manual_install: "ios", installed: false, can_install: false });
    window.dispatchEvent(new Event("appinstalled"));
    expect(value(core.app.state)).toMatchObject({ manual_install: null, installed: true });
  });

  it("bittet nach der Anmeldung einmal um dauerhaften Speicher und auf Wunsch noch einmal", async () => {
    let answer = false;
    let asked = 0;
    vi.stubGlobal("navigator", {
      ...navigator,
      userAgent: navigator.userAgent,
      storage: {
        persist: async () => {
          asked += 1;
          return answer;
        },
        persisted: async () => answer,
      },
    });
    const { core } = await signedIn();
    await vi.waitFor(() => expect(asked).toBe(1));
    await vi.waitFor(() => expect(value(core.app.state).storage_persistent).toBe(false));

    // „Noch einmal": Diesmal sagt der Browser zu.
    answer = true;
    expect(await core.app.requestPersistence()).toBe(true);
    expect(asked).toBe(2);
    expect(value(core.app.state).storage_persistent).toBe(true);
  });

  it("lässt den Stand unbekannt, wenn der Browser die Frage nicht kennt", async () => {
    vi.stubGlobal("navigator", { ...navigator, userAgent: navigator.userAgent, storage: undefined });
    const { core } = await signedIn();
    expect(await core.app.requestPersistence()).toBe(false);
    expect(value(core.app.state).storage_persistent).toBeNull();
  });
});

describe("Die lokale Datenbank wechselt ihren Aufbau", () => {
  it("stellt eine Datenbank von Stand 1 um, ohne etwas zu verlieren", async () => {
    const harness = await signedIn();
    const first = harness.core;
    const zoneId = firstZoneId(first);
    const stored = await first.stock.store({ product: { kind: "new", name: "Linsen" }, zone_id: zoneId, best_before: "2027-06-06", count: 2, labels: false });
    await first.prefs.update({ scan_sound: false });
    const pending = value(first.sync.status).pending;
    expect(pending).toBe(3);
    const device = value(first.session.state);

    const legacy = freshName();
    await copyAsVersion1(harness.dbName, legacy);
    first.dispose();
    await first.ready;

    // Die neue App öffnet die alte Datenbank.
    const core = openCore(harness, legacy);
    await core.ready;
    expect(value(core.session.state)).toEqual(device);
    expect(value(core.sync.status).pending).toBe(pending);
    expect(value(core.prefs.value).scan_sound).toBe(false);
    expect(value(core.data.packages).map((pkg) => pkg.id).sort()).toEqual(stored.packages.map((pkg) => pkg.id).sort());
    expect(value(core.data.zones)).toHaveLength(1);

    // Der ID-Vorrat ist noch da: Die nächste Packung nimmt eine zugeteilte ID.
    const next = await core.stock.store({ product: { kind: "existing", product_id: stored.product.id }, zone_id: zoneId, best_before: null, count: 1, labels: false });
    expect(harness.server.isReserved(next.packages[0]?.id ?? "")).toBe(true);

    // Die Outbox geht hinaus wie zuvor.
    await core.sync.now();
    expect(value(core.sync.status)).toMatchObject({ pending: 0, last_error: null });
    expect([...harness.server.data.packages.keys()].sort()).toEqual([...stored.packages, ...next.packages].map((pkg) => pkg.id).sort());

    // Und die Datenbank steht jetzt auf dem neuen Stand, samt der Buchführung des Zustellens.
    const check = new Dexie(legacy);
    await check.open();
    expect(check.verno).toBe(DB_VERSION);
    expect(check.tables.map((table) => table.name)).toContain("deliveries");
    check.close();
  });

  it("gibt die Datenbank frei, wenn ein Tab mit neuerer App sie umstellt, und arbeitet erst nach dem Neuladen weiter", async () => {
    let reloads = 0;
    const harness = await signedIn({ core: { reload: () => (reloads += 1) } });
    const { core } = harness;
    const zoneId = firstZoneId(core);
    await core.stock.store({ product: { kind: "new", name: "Reis" }, zone_id: zoneId, best_before: null, count: 1, labels: false });
    expect(value(core.app.state).update_required).toBe(false);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // Ein anderer Tab läuft schon mit einer neueren App: Ihre Datenbank hat eine höhere Version.
    const newer = new Dexie(harness.dbName);
    newer.version(DB_VERSION + 1).stores({ ...V1_STORES, deliveries: "job_id", spaeter: "id" });
    await newer.open();
    // Der neue Tab musste nicht warten: Der alte hat sofort losgelassen.
    expect(newer.verno).toBe(DB_VERSION + 1);
    expect(await newer.table("outbox").count()).toBe(2);

    await vi.waitFor(() => expect(value(core.app.state).update_required).toBe(true));
    // Lesen geht weiter (aus dem Arbeitsspeicher), Schreiben nicht mehr.
    expect(value(core.data.packages)).toHaveLength(1);
    const error = await expectCoreError(core.stock.store({ product: { kind: "new", name: "Mais" }, zone_id: zoneId, best_before: null, count: 1, labels: false }), "not_supported");
    expect(error.message).toMatch(/neu geladen/);
    await expectCoreError(core.prefs.update({ scan_sound: false }), "not_supported");
    await core.sync.now();
    expect(value(core.sync.status).last_error?.code).toBe("not_supported");
    expect(await core.print.flush()).toEqual({ delivered: 0, pending: 0, problems: [] });

    // `applyUpdate` lädt neu, auch ohne wartenden Service Worker.
    expect(reloads).toBe(0);
    await core.app.applyUpdate();
    expect(reloads).toBe(1);
    newer.close();
  });

  it("wartet nicht ewig auf einen Tab mit älterer App, der die Datenbank festhält, und holt den Start nach", async () => {
    const harness = await signedIn();
    const name = freshName();
    await copyAsVersion1(harness.dbName, name);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // Ein Tab mit der alten App hält seine Verbindung und reagiert nicht (eingefroren).
    const holder = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("open"));
    });

    const core = openCore(harness, name, { blockedTimeoutMs: 40 });
    await core.ready;
    // Ohne lokale Daten: nicht angemeldet, und Schreiben sagt, woran es liegt.
    expect(value(core.session.state)).toMatchObject({ status: "signed_out" });
    const error = await expectCoreError(core.stock.store({ product: { kind: "new", name: "Mais" }, zone_id: "x", best_before: null, count: 1, labels: false }), "not_supported");
    expect(error.message).toMatch(/anderer Tab/);

    // Der alte Tab wird geschlossen: Jetzt beginnt der Kern wirklich.
    holder.close();
    await vi.waitFor(() => expect(value(core.session.state).status).toBe("signed_in"));
    const stored = await core.stock.store({ product: { kind: "new", name: "Mais" }, zone_id: firstZoneId(core), best_before: null, count: 1, labels: false });
    expect(stored.packages).toHaveLength(1);
  });
});
