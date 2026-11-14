/**
 * Die Einkaufsliste im echten Kern, gegen die Nachbildung des Servers (src/core/testing): eigene
 * Einträge auch offline, automatische Einträge in der Antwort auf denselben Abgleich (ohne sie
 * vorwegzunehmen), Zusammenführen, Aufbewahrung, der Umstieg der App-Datenbank auf Version 3 und
 * die Suche nach einer neuen App bei 409 mit neuerem Protokoll.
 */
import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_DEVICE_PREFS, LIMITS, PROTOCOL_VERSION, type Command, type HouseholdSettings, type Product, type SyncRequest, type Zone } from "@/contract";

import { createCore, type StowlyCore } from ".";
import { DB_VERSION, type KvEntry } from "./db";
import { createFakeNetwork, FAKE_PASSWORD, FakeServer, validateCommand } from "./testing/fake-api";
import { commandsOf, createClock, DAY, disposeAll, expectCoreError, firstZoneId, signedIn, value, type Harness } from "./testing/harness";

afterEach(disposeAll);

/** Die Befehle, die seit `from` (Index in `syncRequests`) beim Server ankamen. */
function sentSince(harness: Harness, from: number): Record<string, unknown>[] {
  return harness.server.syncRequests.slice(from).flatMap((request) => commandsOf(request));
}

function autosOf(harness: Harness, productId: string): { quantity: number | null; state: string }[] {
  return [...harness.core.data.shoppingItems.get()!]
    .filter((item) => item.product_id === productId && item.origin === "min_stock")
    .map((item) => ({ quantity: item.quantity, state: item.done_at === null ? "open" : "done" }));
}

async function store(core: StowlyCore, productId: string, count: number): Promise<string[]> {
  const result = await core.stock.store({ product: { kind: "existing", product_id: productId }, zone_id: firstZoneId(core), best_before: null, count, labels: false });
  return result.packages.map((pkg) => pkg.id);
}

describe("Eigene Einträge", () => {
  it("entstehen auch ohne Server und gehen mit dem nächsten Abgleich hinaus", async () => {
    const harness = await signedIn();
    const { core, server, network } = harness;
    const milk = await core.products.create({ name: "Milch" });
    await core.sync.now();

    network.offline = true;
    const own = await core.shopping.create({ product_id: milk.id, quantity: 2 });
    const text = await core.shopping.create({ text: "  Kerzen  " });
    expect(own).toMatchObject({ product_id: milk.id, text: "", quantity: 2, origin: "manual", done_at: null, deleted_at: null });
    expect(text).toMatchObject({ product_id: null, text: "Kerzen", quantity: null });
    expect(value(core.data.shoppingItems).map((item) => item.id).sort()).toEqual([own.id, text.id].sort());
    expect(value(core.sync.status).pending).toBe(2);
    await core.sync.now();
    expect(value(core.sync.status)).toMatchObject({ online: false, pending: 2 });

    network.offline = false;
    const before = server.syncRequests.length;
    await core.sync.now();
    expect(value(core.sync.status).pending).toBe(0);
    const sent = sentSince(harness, before);
    expect(sent.map((command) => command.type)).toEqual(["shopping_item.create", "shopping_item.create"]);
    expect(sent.map((command) => validateCommand(command))).toEqual([null, null]);
    expect(sent[0]).toMatchObject({ item_id: own.id, product_id: milk.id, text: "", quantity: 2 });
    expect(server.data.shopping_items.get(text.id)).toMatchObject({ text: "Kerzen", origin: "manual" });
    expect(value(core.data.shoppingItems).map((item) => item.id).sort()).toEqual([own.id, text.id].sort());
  });

  it("lassen sich abhaken, öffnen, ändern und löschen; ohne Wirkung entsteht kein Befehl", async () => {
    const harness = await signedIn();
    const { core } = harness;
    const item = await core.shopping.create({ text: "Hefe" });
    await core.sync.now();
    const before = harness.server.syncRequests.length;

    await core.shopping.update(item.id, { done: true });
    expect(value(core.data.shoppingItems).find((candidate) => candidate.id === item.id)?.done_at).toBe(harness.clock.now().toISOString());
    // Abhaken eines erledigten Eintrags, Öffnen eines offenen und ein Aufruf ohne Felder: nichts.
    await core.shopping.update(item.id, { done: true });
    await core.shopping.update(item.id, {});
    await core.shopping.update(item.id, { done: false, text: " Trockenhefe ", quantity: 3 });
    await core.shopping.update(item.id, { done: false });
    await core.shopping.remove(item.id);
    await core.shopping.remove(item.id);
    expect(value(core.sync.status).pending).toBe(3);
    expect(value(core.data.shoppingItems).some((candidate) => candidate.id === item.id)).toBe(false);
    await core.sync.now();
    expect(sentSince(harness, before).map((command) => [command.type, command.changes ?? null])).toEqual([
      ["shopping_item.update", { done: true }],
      ["shopping_item.update", { text: "Trockenhefe", quantity: 3, done: false }],
      ["shopping_item.delete", null],
    ]);
    expect(harness.server.data.shopping_items.get(item.id)).toMatchObject({ text: "Trockenhefe", quantity: 3, done_at: null, deleted_at: expect.any(String) });
    // Gelöscht ist gelöscht.
    await expectCoreError(core.shopping.update(item.id, { done: true }), "not_found");
  });

  it("prüfen die Eingaben mit denselben Sätzen wie die Attrappe", async () => {
    const { core } = await signedIn();
    const rice = await core.products.create({ name: "Reis" });
    const message = async (action: Promise<unknown>) => (await expectCoreError(action, "invalid")).message;
    expect(await message(core.shopping.create({}))).toBe("Der Eintrag braucht einen Text.");
    expect(await message(core.shopping.create({ text: "   " }))).toBe("Der Eintrag braucht einen Text.");
    expect(await message(core.shopping.create({ product_id: rice.id, text: "Reis" }))).toBe("Ein Eintrag hat ein Produkt oder einen Text, nicht beides.");
    expect(await message(core.shopping.create({ text: "x".repeat(LIMITS.shopping_text + 1) }))).toBe("Der Text ist zu lang (höchstens 120 Zeichen).");
    expect(await message(core.shopping.create({ text: "Mehl", quantity: 1000 }))).toBe("Die Menge muss zwischen 1 und 999 liegen.");
    await expectCoreError(core.shopping.create({ product_id: "20000000-0000-4000-8000-000000000999" }), "not_found");
    await expectCoreError(core.shopping.remove("70000000-0000-4000-8000-000000000999"), "not_found");

    const own = await core.shopping.create({ product_id: rice.id });
    expect(await message(core.shopping.update(own.id, { text: "Basmati" }))).toBe("Ein Eintrag mit Produkt trägt dessen Namen, keinen eigenen Text.");
    expect(await message(core.shopping.update(own.id, { quantity: 0 }))).toBe("Die Menge muss zwischen 1 und 999 liegen.");
    expect(value(core.sync.status).pending).toBe(2);
  });

  it("folgen einer Zusammenführung, auch schon vor dem Abgleich", async () => {
    const harness = await signedIn();
    const { core } = harness;
    const milk = await core.products.create({ name: "Milch" });
    const whole = await core.products.create({ name: "Vollmilch" });
    const own = await core.shopping.create({ product_id: whole.id });
    await core.products.merge(whole.id, milk.id);
    expect(value(core.data.shoppingItems).find((item) => item.id === own.id)?.product_id).toBe(milk.id);
    // Ein neuer Eintrag mit der alten Kennung gehört dem Ziel.
    expect((await core.shopping.create({ product_id: whole.id })).product_id).toBe(milk.id);
    await core.sync.now();
    expect(harness.server.data.shopping_items.get(own.id)?.product_id).toBe(milk.id);
    expect(value(core.sync.problems)).toEqual([]);
  });
});

describe("Automatische Einträge", () => {
  it("kommen in der Antwort auf denselben Abgleich, der das Entnehmen bringt", async () => {
    const harness = await signedIn();
    const { core, server } = harness;
    const milk = await core.products.create({ name: "Milch", min_stock: 2 });
    const ids = await store(core, milk.id, 2);
    await core.sync.now();
    expect(autosOf(harness, milk.id)).toEqual([]);

    await core.stock.remove([ids[0] ?? ""], "consumed");
    // Der Kern nimmt den Eintrag nicht vorweg (Regel 8): Den schreibt der Server.
    expect(autosOf(harness, milk.id)).toEqual([]);
    const before = server.syncRequests.length;
    await core.sync.now();
    expect(server.syncRequests.length).toBe(before + 1);
    expect(autosOf(harness, milk.id)).toEqual([{ quantity: 1, state: "open" }]);

    // Abhaken sperrt; Einlagern hebt die Sperre auf und lässt den Bestand reichen.
    const auto = value(core.data.shoppingItems).find((item) => item.origin === "min_stock");
    await core.shopping.update(auto?.id ?? "", { done: true });
    await core.stock.remove([ids[1] ?? ""], "consumed");
    await core.sync.now();
    expect(autosOf(harness, milk.id)).toEqual([{ quantity: 1, state: "done" }]);
    await store(core, milk.id, 1);
    await core.sync.now();
    // Offene zuerst (compareShoppingItems).
    expect(autosOf(harness, milk.id)).toEqual([
      { quantity: 1, state: "open" },
      { quantity: 1, state: "done" },
    ]);
    // Die Menge eines automatischen Eintrags führt der Server.
    const fresh = value(core.data.shoppingItems).find((item) => item.origin === "min_stock" && item.done_at === null);
    await expectCoreError(core.shopping.update(fresh?.id ?? "", { quantity: 4 }), "invalid");
  });

  it("erledigen eigene Einträge eines Produkts erst mit dem Abgleich des Einlagerns", async () => {
    const harness = await signedIn();
    const { core, network } = harness;
    const butter = await core.products.create({ name: "Butter" });
    const own = await core.shopping.create({ product_id: butter.id });
    await core.sync.now();
    network.offline = true;
    await store(core, butter.id, 1);
    expect(value(core.data.shoppingItems).find((item) => item.id === own.id)?.done_at).toBeNull();
    network.offline = false;
    await core.sync.now();
    expect(value(core.data.shoppingItems).find((item) => item.id === own.id)?.done_at).not.toBeNull();
  });
});

describe("Aufbewahrung", () => {
  it("verwirft Erledigtes und Gelöschtes nach der Aufbewahrungsdauer, beim Empfang und beim Start", async () => {
    const harness = await signedIn();
    const { core, clock } = harness;
    const done = await core.shopping.create({ text: "Grillkohle" });
    const gone = await core.shopping.create({ text: "Alufolie" });
    const open = await core.shopping.create({ text: "Kerzen" });
    await core.shopping.update(done.id, { done: true });
    await core.shopping.remove(gone.id);
    await core.sync.now();
    expect(value(core.data.shoppingItems).map((item) => item.id).sort()).toEqual([done.id, open.id].sort());

    // 31 Tage später: Beim Start verschwindet es aus der Datenbank, beim Empfang ebenso.
    clock.advance(31 * DAY);
    const reopened = await harness.another();
    expect(value(reopened.data.shoppingItems).map((item) => item.id)).toEqual([open.id]);
    const db = new Dexie(harness.dbName);
    await db.open();
    const stored = (await db.table("shopping_items").toArray()) as { id: string }[];
    db.close();
    expect(stored.map((item) => item.id)).toEqual([open.id]);
    await core.sync.now();
    expect(value(core.data.shoppingItems).map((item) => item.id)).toEqual([open.id]);
  });
});

// ------------------------------------------------------------------------------------------
// Umstieg der App-Datenbank auf Version 3 (docs/sync-protokoll.md, 6.5)
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
  it("holt einmal alles neu und behält Outbox, ID-Vorrat, Anmeldung und Geräte-Einstellungen", async () => {
    expect(DB_VERSION).toBe(3);
    const clock = createClock();
    const server = new FakeServer({ now: clock.now });
    const network = createFakeNetwork(server);
    const zone = [...server.data.zones.values()][0] as Zone;
    // Auf dem Server: ein Produkt mit Mindestbestand und sein automatischer Eintrag (Protokoll 2).
    const milkId = "20000000-0000-4000-8000-000000000001";
    server.act({ type: "product.create", product_id: milkId, name: "Milch", min_stock: 2 });
    const login = await network.fetch("/api/auth/login", { method: "POST", body: JSON.stringify({ password: FAKE_PASSWORD, device_name: "Altes Handy" }) });
    const { token, device } = (await login.json()) as { token: string; device: { id: string; name: string } };

    // Das Gerät mit der App aus Stufe 1: Datensätze ohne die neuen Felder, ein wartender Befehl.
    const dbName = `stowly-upgrade-${Math.random().toString(36).slice(2, 8)}`;
    const old = new StageOneDb(dbName);
    await old.open();
    const { min_stock: _min, ...oldMilk } = server.data.products.get(milkId) as Product;
    const { notify_time: _time, ...oldSettings } = server.data.settings as HouseholdSettings;
    const pending: Command = { id: "3f2b8c1e-5a47-4d09-9b6e-0c1d2e3f4a01", at: clock.now().toISOString(), type: "product.update", product_id: milkId, changes: { brand: "Almhof" } };
    await old.table("products").put(oldMilk);
    await old.table("zones").put(zone);
    await old.table("outbox").add({ id: pending.id, command: pending });
    await old.table("id_pool").add({ id: "A2B3C" });
    const kv: KvEntry[] = [
      { key: "seq", value: 7 },
      { key: "session", value: { status: "signed_in", token, device: { id: device.id, name: device.name } } },
      { key: "sync", value: { dataset_id: server.datasetId, cursor: server.rev, last_synced_at: clock.now().toISOString(), clock_offset_ms: 0, full_resync: false, lookup_enabled: true } },
      { key: "settings", value: oldSettings as HouseholdSettings },
      { key: "prefs", value: { ...DEFAULT_DEVICE_PREFS, scan_sound: false } },
    ];
    await old.table("kv").bulkPut(kv);
    old.close();

    // Die neue App öffnet dieselbe Datenbank.
    const core = createCore({ fetch: network.fetch, now: clock.now, dbName, autoSync: false });
    try {
      await core.ready;
      expect(value(core.session.state)).toEqual({ status: "signed_in", device: { id: device.id, name: device.name } });
      expect(value(core.prefs.value).scan_sound).toBe(false);
      expect(value(core.sync.status).pending).toBe(1);
      // Bis zum Abgleich tragen die alten Datensätze die Vorgaben des Protokolls.
      expect(value(core.data.products).find((product) => product.id === milkId)?.min_stock).toBeNull();
      expect(value(core.data.settings).notify_time).toBe("17:00");
      expect(value(core.data.shoppingItems)).toEqual([]);

      await core.sync.now();
      const request = server.syncRequests.at(-1) as unknown as SyncRequest;
      expect(request).toMatchObject({ protocol: PROTOCOL_VERSION, dataset_id: null, cursor: 0, id_pool: { have: 0 } });
      expect(request.commands.map((command) => command.id)).toEqual([pending.id]);
      expect(value(core.sync.status)).toMatchObject({ phase: "idle", pending: 0 });
      expect(value(core.data.products).find((product) => product.id === milkId)).toMatchObject({ min_stock: 2, brand: "Almhof" });
      expect(value(core.data.shoppingItems)).toMatchObject([{ product_id: milkId, origin: "min_stock", quantity: 2 }]);
      // Danach gleicht der Kern wieder gewöhnlich ab.
      await core.sync.now();
      expect(server.syncRequests.at(-1)).toMatchObject({ dataset_id: server.datasetId, cursor: expect.any(Number) });
      expect((server.syncRequests.at(-1) as { cursor: number }).cursor).toBeGreaterThan(0);
    } finally {
      core.dispose();
      await core.ready.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Dexie.delete(dbName).catch(() => undefined);
    }
  });
});

describe("Neueres Protokoll beim Server", () => {
  it("sucht bei 409 mit höherer Version des Servers sofort nach einer neuen App", async () => {
    let checks = 0;
    const harness = await signedIn({ core: { checkForUpdate: () => (checks += 1) } });
    harness.server.protocol = PROTOCOL_VERSION + 1;
    await harness.core.sync.now();
    expect(value(harness.core.sync.status).last_error?.code).toBe("protocol_mismatch");
    expect(checks).toBe(1);
  });

  it("nicht, wenn der Server älter ist", async () => {
    let checks = 0;
    const harness = await signedIn({ core: { checkForUpdate: () => (checks += 1) } });
    harness.server.protocol = PROTOCOL_VERSION - 1;
    await harness.core.sync.now();
    expect(value(harness.core.sync.status).last_error?.code).toBe("protocol_mismatch");
    expect(checks).toBe(0);
  });
});
