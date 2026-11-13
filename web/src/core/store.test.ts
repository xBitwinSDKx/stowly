/**
 * Der Zustand des Kerns unterhalb der Schnittstelle: Anzeige = Stand des Servers plus
 * wartende Befehle, auch wenn mehrere Tabs schreiben oder eine Antwort zu spät kommt.
 */
import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";

import { CoreError, type Changes, type HouseholdSettings, type Package, type Product, type SyncResponse, type Zone } from "@/contract";

import type { StoredSession } from "./db";
import { Store } from "./store";

const AT = "2026-11-13T10:00:00.000Z";
const ZONE: Zone = { id: "10000000-0000-4000-8000-000000000001", name: "Vorrat", icon: "box", color: null, sort: 0, printer_id: null, created_at: AT, updated_at: AT, deleted_at: null, moved_to: null };
const PRODUCT: Product = {
  id: "20000000-0000-4000-8000-000000000001",
  name: "Reis",
  brand: "",
  quantity: "",
  image: null,
  warn_days: null,
  lookup: "none",
  barcodes: [],
  created_at: AT,
  updated_at: AT,
  deleted_at: null,
  merged_into: null,
};
const SETTINGS: HouseholdSettings = { zone_mode: "primary", primary_zone_id: ZONE.id, warn_days: 14, trash_retention_days: 30, default_printer_id: null, updated_at: AT };
const SESSION: StoredSession = { status: "signed_in", token: "token-1", device: { id: "50000000-0000-4000-8000-000000000001", name: "Test" } };
const DATASET = "8c0b4b0e-6c1a-4f2e-9f0a-2d5b7c9e1a34";

function pkg(id: string, changes: Partial<Package> = {}): Package {
  return { id, product_id: PRODUCT.id, zone_id: ZONE.id, best_before: null, created_at: AT, updated_at: AT, removed_at: null, removal_reason: null, displaced: null, ...changes };
}

function response(changes: Partial<Changes>, extra: Partial<SyncResponse> = {}): SyncResponse {
  return {
    protocol: 1,
    dataset_id: DATASET,
    server_time: AT,
    results: [],
    reset: false,
    changes: { products: [], zones: [], packages: [], printers: [], printer_status: [], print_jobs: [], label_templates: [], settings: null, ...changes },
    cursor: 1,
    has_more: false,
    id_pool: { grant: [], target: 300 },
    lookup_enabled: true,
    ...extra,
  };
}

const stores: Store[] = [];
const names: string[] = [];
let counter = 0;

function newName(): string {
  counter += 1;
  const name = `stowly-store-test-${counter}-${Math.random().toString(36).slice(2, 8)}`;
  names.push(name);
  return name;
}

async function open(dbName: string): Promise<Store> {
  const store = new Store({ dbName, now: () => new Date(AT) });
  stores.push(store);
  await store.load();
  return store;
}

/** Ein Store nach der Anmeldung: eine Zone, ein Produkt, Einstellungen, Stand 10. */
async function signedIn(dbName: string = newName()): Promise<Store> {
  const store = await open(dbName);
  await store.applySync({
    basedOn: { dataset_id: null, cursor: 0 },
    token: "token-1",
    full: true,
    pages: [response({ zones: [ZONE], products: [PRODUCT], settings: SETTINGS }, { reset: true, cursor: 10, id_pool: { grant: ["AAAA1", "AAAA2", "AAAA3"], target: 300 } })],
    receivedAt: new Date(AT),
    login: SESSION,
  });
  return store;
}

afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const name of names.splice(0)) {
    await Dexie.delete(name).catch(() => undefined);
  }
});

describe("Schreiben", () => {
  it("legt Befehle und ihre Wirkung zusammen an oder gar nicht", async () => {
    const store = await signedIn();
    await expect(
      store.mutate((mutation) => {
        mutation.emit({ type: "package.create", package_id: mutation.takePackageId(), product_id: PRODUCT.id, zone_id: ZONE.id, best_before: null });
        throw new CoreError("invalid", "mittendrin gescheitert");
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(store.snapshot.outbox).toEqual([]);
    expect(store.snapshot.view.packages.size).toBe(0);
    // Auch die entnommene ID ist noch im Vorrat.
    expect(store.snapshot.pool).toEqual(["AAAA1", "AAAA2", "AAAA3"]);
    expect(await store.db.outbox.count()).toBe(0);
    expect(await store.db.id_pool.count()).toBe(3);
  });

  it("erzeugt keinen Befehl, den schon die lokale Kopie ablehnen würde", async () => {
    const store = await signedIn();
    await expect(store.mutate((mutation) => mutation.emit({ type: "package.remove", package_id: "ZZZZZ", reason: "consumed" }))).rejects.toMatchObject({ code: "not_found" });
    await expect(store.mutate((mutation) => mutation.emit({ type: "zone.delete", zone_id: ZONE.id, move_to: ZONE.id }))).rejects.toMatchObject({ code: "last_zone" });
    expect(store.snapshot.outbox).toEqual([]);
  });

  it("entnimmt IDs in der Reihenfolge der Zuteilung und überspringt inzwischen vergebene", async () => {
    const store = await signedIn();
    // Ein anderes Gerät hat AAAA1 inzwischen selbst angelegt.
    await store.applySync({ basedOn: { dataset_id: DATASET, cursor: 10 }, token: "token-1", full: false, pages: [response({ packages: [pkg("AAAA1")] }, { cursor: 11 })], receivedAt: new Date(AT) });
    const ids = await store.mutate((mutation) => [mutation.takePackageId(), mutation.takePackageId(), mutation.takePackageId()]);
    expect(ids.slice(0, 2)).toEqual(["AAAA2", "AAAA3"]);
    expect(ids[2]).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(new Set(ids).size).toBe(3);
    expect(store.snapshot.pool).toEqual([]);
    expect(await store.db.id_pool.count()).toBe(0);
  });

  it("speichert nur den Stand des Servers; die Anzeige entsteht aus Outbox und Stand", async () => {
    const dbName = newName();
    const store = await signedIn(dbName);
    await store.mutate((mutation) => {
      mutation.emit({ type: "package.create", package_id: "AAAA1", product_id: PRODUCT.id, zone_id: ZONE.id, best_before: "2027-01-01" });
      mutation.emit({ type: "zone.update", zone_id: ZONE.id, changes: { name: "Keller" } });
    });
    expect(store.snapshot.view.zones.get(ZONE.id)?.name).toBe("Keller");
    expect(store.snapshot.base.zones.get(ZONE.id)?.name).toBe("Vorrat");
    // In der Datenbank steht die Zone, wie der Server sie kennt, und die Packung nur als Befehl.
    expect((await store.db.zones.get(ZONE.id))?.name).toBe("Vorrat");
    expect(await store.db.packages.count()).toBe(0);
    expect(await store.db.outbox.count()).toBe(2);

    // Nach dem Neuladen ergibt dieselbe Rechnung dieselbe Anzeige.
    store.close();
    const reloaded = await open(dbName);
    expect(reloaded.snapshot.view.zones.get(ZONE.id)?.name).toBe("Keller");
    expect(reloaded.snapshot.view.packages.get("AAAA1")?.best_before).toBe("2027-01-01");
    expect(reloaded.snapshot.outbox.map((entry) => entry.command.type)).toEqual(["package.create", "zone.update"]);
  });
});

describe("Antwort anwenden", () => {
  it("verwirft die Datensätze einer Antwort, deren Anfrage auf einem veralteten Stand beruhte, verbucht aber ihre Ergebnisse", async () => {
    const store = await signedIn();
    const command = await store.mutate((mutation) => mutation.emit({ type: "zone.update", zone_id: ZONE.id, changes: { name: "Keller" } }));
    // Ein anderer Abgleich (zweiter Tab ohne Web Locks) war schneller und steht schon bei 20.
    await store.applySync({ basedOn: { dataset_id: DATASET, cursor: 10 }, token: "token-1", full: false, pages: [response({ zones: [{ ...ZONE, name: "Neu", icon: "cellar" }] }, { cursor: 20 })], receivedAt: new Date(AT) });

    const report = await store.applySync({
      basedOn: { dataset_id: DATASET, cursor: 10 },
      token: "token-1",
      full: false,
      pages: [
        response(
          { zones: [{ ...ZONE, name: "Alt" }] },
          { cursor: 15, results: [{ id: command.id, status: "applied", code: null, message: null, duplicate: false }], id_pool: { grant: ["BBBB1"], target: 300 } },
        ),
      ],
      receivedAt: new Date(AT),
    });

    expect(report).toMatchObject({ applied: true, changes_applied: false, confirmed: 1 });
    // Der neuere Stand bleibt, der Zeiger läuft nicht rückwärts, der Befehl ist trotzdem erledigt.
    expect(store.snapshot.meta.cursor).toBe(20);
    expect(store.snapshot.base.zones.get(ZONE.id)).toMatchObject({ name: "Neu", icon: "cellar" });
    expect(store.snapshot.outbox).toEqual([]);
    expect(store.snapshot.pool).not.toContain("BBBB1");
  });

  it("verwirft eine Antwort ganz, wenn die Sitzung inzwischen eine andere ist", async () => {
    const store = await signedIn();
    await store.mutate((mutation) => mutation.emit({ type: "zone.update", zone_id: ZONE.id, changes: { name: "Keller" } }));
    await store.logout(true);
    const report = await store.applySync({ basedOn: { dataset_id: DATASET, cursor: 10 }, token: "token-1", full: false, pages: [response({ packages: [pkg("AAAA1")] }, { cursor: 11 })], receivedAt: new Date(AT) });
    expect(report.applied).toBe(false);
    expect(store.snapshot.base.packages.size).toBe(0);
    expect(await store.db.packages.count()).toBe(0);
    // Der Name des Geräts bleibt als Vorschlag für die nächste Anmeldung.
    expect(store.snapshot.session).toEqual({ status: "logout", token: null, device: null, last_device_name: "Test" });
  });

  it("meldet nur an, wenn der erste Abzug Zonen und Einstellungen enthält", async () => {
    const store = await open(newName());
    await expect(
      store.applySync({ basedOn: { dataset_id: null, cursor: 0 }, token: "token-1", full: true, pages: [response({ products: [PRODUCT] }, { reset: true })], receivedAt: new Date(AT), login: SESSION }),
    ).rejects.toMatchObject({ code: "internal" });
    // Nichts davon ist gespeichert: Das Gerät bleibt abgemeldet.
    expect(store.snapshot.session).toBeNull();
    expect(store.snapshot.base.products.size).toBe(0);
    expect(await store.db.products.count()).toBe(0);
  });

  it("behält Referenzen, wenn ein vollständiger Abzug nichts Neues bringt", async () => {
    const store = await signedIn();
    const before = store.snapshot;
    await store.applySync({
      basedOn: { dataset_id: DATASET, cursor: 10 },
      token: "token-1",
      full: true,
      // Dieselben Daten als neue Objekte, wie sie aus JSON kommen.
      pages: [response({ zones: [structuredClone(ZONE)], products: [structuredClone(PRODUCT)], settings: structuredClone(SETTINGS) }, { reset: true, cursor: 10 })],
      receivedAt: new Date(AT),
    });
    expect(store.snapshot.view.zones).toBe(before.view.zones);
    expect(store.snapshot.view.products).toBe(before.view.products);
    expect(store.snapshot.view.settings).toBe(before.view.settings);
  });

  it("merkt den Abstand zur Serverzeit und rechnet die Aufbewahrung damit", async () => {
    const store = await signedIn();
    // Die Geräteuhr geht zwei Tage nach; der Server sagt, wie spät es wirklich ist.
    await store.applySync({
      basedOn: { dataset_id: DATASET, cursor: 10 },
      token: "token-1",
      full: false,
      pages: [response({ packages: [pkg("AAAA1", { removed_at: "2026-10-15T10:00:00.000Z", removal_reason: "consumed" })] }, { cursor: 11, server_time: "2026-11-15T10:00:00.000Z" })],
      receivedAt: new Date(AT),
    });
    expect(store.snapshot.meta.clock_offset_ms).toBe(2 * 86_400_000);
    // 31 Tage nach Serverzeit: jenseits der Aufbewahrung, obwohl es nach der Geräteuhr erst 29 wären.
    expect(store.snapshot.base.packages.has("AAAA1")).toBe(false);
    expect(await store.db.packages.count()).toBe(0);
  });
});

describe("Mehrere Tabs", () => {
  it("liest vor dem Schreiben neu, wenn ein anderer Tab geschrieben hat", async () => {
    const dbName = newName();
    const first = await signedIn(dbName);
    const second = await open(dbName);
    // Der zweite Tab erfährt hier nichts über den Kanal: Er soll es beim Schreiben selbst merken.
    (second as unknown as { channel: BroadcastChannel | null }).channel?.close();

    await first.mutate((mutation) => mutation.emit({ type: "zone.create", zone_id: "10000000-0000-4000-8000-000000000002", name: "Keller", sort: 1 }));
    expect(second.snapshot.view.zones.size).toBe(1);

    // Der zweite Tab legt eine Zone „hinter der letzten" an und muss dafür die des ersten kennen.
    const sort = await second.mutate((mutation) => {
      const highest = mutation.draft.rows("zones").reduce((max, zone) => Math.max(max, zone.sort), -1);
      mutation.emit({ type: "zone.create", zone_id: "10000000-0000-4000-8000-000000000003", name: "Garage", sort: highest + 1 });
      return highest + 1;
    });
    expect(sort).toBe(2);
    expect(second.snapshot.outbox.map((entry) => entry.command.type)).toEqual(["zone.create", "zone.create"]);
    expect(second.snapshot.view.zones.size).toBe(3);
    // Die Reihenfolge der Outbox ist die Reihenfolge der Entstehung, über beide Tabs hinweg.
    expect((await first.db.outbox.toArray()).map((entry) => (entry.command as { name?: string }).name)).toEqual(["Keller", "Garage"]);
  });
});
