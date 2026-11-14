/**
 * Die Einkaufsliste mit dem echten Kern gegen den echten Server (Protokoll 2): eigene Einträge,
 * abhaken, offline und wieder online, automatische Einträge in der Antwort auf denselben
 * Abgleich, das Erledigen durch Einlagern, und der Umstieg einer App-Datenbank aus Stufe 1
 * (Version 2) auf Version 3 mit einem vollständigen Abzug.
 *
 * Alle Tests teilen sich einen Server; jeder benutzt eigene Produktnamen.
 */
import Dexie from "dexie";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_DEVICE_PREFS, PROTOCOL_VERSION, type Command, type HouseholdSettings, type Product, type ShoppingItem } from "@/contract";
import type { KvEntry } from "@/core/db";

import { firstZone } from "./support/data";
import { Device, disposeDevices, expectCoreError, signedIn, value } from "./support/device";
import { expectSameAsServer, RawClient } from "./support/raw";
import { startServer, type ServerHandle } from "./support/server";

let server: ServerHandle;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server?.dispose();
});

afterEach(disposeDevices);

function itemsOf(device: Device, productId: string): ShoppingItem[] {
  return value(device.core.data.shoppingItems).filter((item) => item.product_id === productId);
}

async function storeSome(device: Device, productId: string, count: number): Promise<string[]> {
  const stored = await device.core.stock.store({ product: { kind: "existing", product_id: productId }, zone_id: firstZone(device).id, best_before: null, count });
  return stored.packages.map((pkg) => pkg.id);
}

describe("Eigene Einträge", () => {
  it("entstehen offline wie online, lassen sich abhaken und löschen und erreichen das andere Gerät", async () => {
    const kitchen = await signedIn(server.url, "Küche");
    const cellar = await signedIn(server.url, "Keller");
    const raw = await RawClient.login(server.url);
    const butter = await kitchen.core.products.create({ name: "Butter E1" });
    const own = await kitchen.core.shopping.create({ product_id: butter.id, quantity: 2 });
    const text = await kitchen.core.shopping.create({ text: "Backpapier E1" });
    await kitchen.sync();

    // Ohne Netz: abhaken, ändern, löschen, neu anlegen; alles gilt sofort.
    kitchen.net.online = false;
    await kitchen.core.shopping.update(text.id, { done: true });
    await kitchen.core.shopping.update(own.id, { quantity: 3 });
    const offline = await kitchen.core.shopping.create({ text: "Kerzen E1" });
    await kitchen.core.shopping.remove(offline.id);
    const kept = await kitchen.core.shopping.create({ text: "Hefe E1" });
    expect(kitchen.status.pending).toBe(5);
    expect(value(kitchen.core.data.shoppingItems).find((item) => item.id === text.id)?.done_at).not.toBeNull();
    await kitchen.trySync();
    expect(kitchen.status).toMatchObject({ online: false, pending: 5 });

    kitchen.net.online = true;
    await kitchen.sync();
    await cellar.sync();
    const snapshot = await expectSameAsServer(kitchen, raw);
    await expectSameAsServer(cellar, raw);
    expect(snapshot.shopping_items.find((item) => item.id === own.id)).toMatchObject({ product_id: butter.id, quantity: 3, origin: "manual", done_at: null });
    expect(snapshot.shopping_items.find((item) => item.id === offline.id)?.deleted_at).not.toBeNull();
    expect(value(cellar.core.data.shoppingItems).map((item) => item.id)).toEqual(expect.arrayContaining([own.id, text.id, kept.id]));

    // Das andere Gerät öffnet wieder; gelöscht bleibt gelöscht.
    await cellar.core.shopping.update(text.id, { done: false });
    await cellar.sync();
    await kitchen.sync();
    expect(value(kitchen.core.data.shoppingItems).find((item) => item.id === text.id)?.done_at).toBeNull();
    await expectCoreError(kitchen.core.shopping.update(offline.id, { done: true }), "not_found");
  });
});

describe("Automatische Einträge", () => {
  it("stehen in der Antwort auf denselben Abgleich, der das Entnehmen bringt", async () => {
    const kitchen = await signedIn(server.url, "Küche");
    const raw = await RawClient.login(server.url);
    const milk = await kitchen.core.products.create({ name: "Milch E2", min_stock: 2 });
    // Ein neues Produkt mit Mindestbestand steht sofort auf der Liste ...
    await kitchen.sync();
    expect(itemsOf(kitchen, milk.id)).toMatchObject([{ origin: "min_stock", quantity: 2, done_at: null }]);
    // ... und verschwindet, wenn der Bestand reicht.
    const ids = await storeSome(kitchen, milk.id, 2);
    await kitchen.sync();
    expect(itemsOf(kitchen, milk.id)).toEqual([]);

    await kitchen.core.stock.remove([ids[0] ?? ""], "consumed");
    // Der Kern nimmt ihn nicht vorweg.
    expect(itemsOf(kitchen, milk.id)).toEqual([]);
    const before = kitchen.net.syncs.length;
    await kitchen.sync();
    expect(kitchen.net.syncs.length).toBe(before + 1);
    const delivered = kitchen.net.lastSync.response?.changes.shopping_items.filter((item) => item.product_id === milk.id && item.deleted_at === null);
    expect(delivered).toMatchObject([{ origin: "min_stock", quantity: 1 }]);
    expect(itemsOf(kitchen, milk.id)).toMatchObject([{ id: delivered?.[0]?.id, origin: "min_stock", quantity: 1 }]);
    await expectSameAsServer(kitchen, raw);
  });

  it("bleiben nach dem Abhaken weg, bis eingelagert wird; Einlagern erledigt eigene Einträge", async () => {
    const kitchen = await signedIn(server.url, "Küche");
    const raw = await RawClient.login(server.url);
    const quark = await kitchen.core.products.create({ name: "Quark E3", min_stock: 1 });
    await kitchen.sync();
    const auto = itemsOf(kitchen, quark.id)[0];
    expect(auto).toMatchObject({ origin: "min_stock", quantity: 1 });
    await kitchen.core.shopping.update(auto?.id ?? "", { done: true });
    const own = await kitchen.core.shopping.create({ product_id: quark.id });
    await kitchen.sync();
    expect(itemsOf(kitchen, quark.id).map((item) => [item.origin, item.done_at === null])).toEqual([
      ["manual", true],
      ["min_stock", false],
    ]);

    // Einlagern und gleich wieder entnehmen: Die Sperre ist aufgehoben, der eigene Eintrag erledigt.
    const [id] = await storeSome(kitchen, quark.id, 1);
    await kitchen.core.stock.remove([id ?? ""], "consumed");
    await kitchen.sync();
    const items = itemsOf(kitchen, quark.id);
    expect(items.find((item) => item.id === own.id)?.done_at).not.toBeNull();
    expect(items.filter((item) => item.origin === "min_stock" && item.done_at === null)).toMatchObject([{ quantity: 1 }]);
    await expectSameAsServer(kitchen, raw);
  });
});

// ------------------------------------------------------------------------------------------
// Umstieg der App-Datenbank auf Version 3
// ------------------------------------------------------------------------------------------

/** Die App-Datenbank, wie Stufe 1 sie angelegt hat (Version 2). */
class StageOneDb extends Dexie {
  constructor(name: string) {
    super(name);
    this.version(1).stores({
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
    });
    this.version(2).stores({ deliveries: "job_id" });
  }
}

describe("Umstieg der App-Datenbank auf Version 3", () => {
  it("holt einmal alles neu, sendet die alte Outbox und behält Anmeldung und Geräte-Einstellungen", async () => {
    const raw = await RawClient.login(server.url);
    const productId = crypto.randomUUID();
    await raw.send([{ type: "product.create", product_id: productId, name: "Senf E4", min_stock: 1 }]);
    const snapshot = await raw.snapshot();
    const last = snapshot.pages.at(-1);
    // Das Gerät war mit der App aus Stufe 1 angemeldet: ein eigenes Token beim Server.
    const old = await RawClient.login(server.url, "Altes Handy");

    const device = new Device(server.url, "Altes Handy");
    await device.core.ready;
    await device.close();
    await Dexie.delete(device.dbName);
    const db = new StageOneDb(device.dbName);
    await db.open();
    const { min_stock: _min, ...oldProduct } = snapshot.products.find((product) => product.id === productId) as Product;
    const { notify_time: _time, ...oldSettings } = snapshot.settings as HouseholdSettings;
    const pending: Command = { id: crypto.randomUUID(), at: new Date().toISOString(), type: "product.update", product_id: productId, changes: { brand: "Feinkost E4" } };
    await db.table("products").put(oldProduct);
    await db.table("zones").bulkPut(snapshot.zones);
    await db.table("label_templates").bulkPut(snapshot.label_templates);
    await db.table("outbox").add({ id: pending.id, command: pending });
    const kv: KvEntry[] = [
      { key: "seq", value: 3 },
      { key: "session", value: { status: "signed_in", token: old.token, device: { id: old.deviceId, name: "Altes Handy" } } },
      { key: "sync", value: { dataset_id: last?.dataset_id ?? null, cursor: last?.cursor ?? 0, last_synced_at: new Date().toISOString(), clock_offset_ms: 0, full_resync: false, lookup_enabled: false } },
      { key: "settings", value: oldSettings as HouseholdSettings },
      { key: "prefs", value: { ...DEFAULT_DEVICE_PREFS, scan_vibration: false } },
    ];
    await db.table("kv").bulkPut(kv);
    db.close();

    // Die neue App startet auf derselben Datenbank.
    await device.reload();
    expect(device.session).toEqual({ id: old.deviceId, name: "Altes Handy" });
    expect(value(device.core.prefs.value).scan_vibration).toBe(false);
    expect(device.status.pending).toBe(1);
    expect(value(device.core.data.products).find((product) => product.id === productId)?.min_stock).toBeNull();
    expect(value(device.core.data.settings).notify_time).toBe("17:00");

    await device.sync();
    const first = device.net.syncs[0];
    expect(first?.request).toMatchObject({ protocol: PROTOCOL_VERSION, dataset_id: null, cursor: 0, id_pool: { have: 0 } });
    expect(first?.request.commands.map((command) => command.id)).toEqual([pending.id]);
    expect(first?.response?.reset).toBe(true);
    const after = await expectSameAsServer(device, raw);
    expect(after.products.find((product) => product.id === productId)).toMatchObject({ min_stock: 1, brand: "Feinkost E4" });
    expect(itemsOf(device, productId)).toMatchObject([{ origin: "min_stock", quantity: 1 }]);

    // Danach gleicht das Gerät wieder gewöhnlich ab, ohne Abzug.
    await device.sync();
    expect(device.net.lastSync.request.dataset_id).toBe(after.pages.at(-1)?.dataset_id);
    expect(device.net.lastSync.response?.reset).toBe(false);
  });
});
