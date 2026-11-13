/**
 * Zwei Geräte im Konflikt (docs/sync-protokoll.md, Abschnitt 7): Löschen gewinnt gegen
 * Bearbeiten, die spätere Feldänderung gewinnt, ein Barcode gehört zu einem Produkt,
 * eine Packungs-ID gibt es nur einmal. Dazu die Reihenfolge eines Geräts über mehrere
 * Anfragen hinweg (Abschnitt 4).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { firstZone, freshBarcode, removed, stocked, stockedOf } from "./support/data";
import { disposeDevices, MINUTE, signedIn, value } from "./support/device";
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

async function setup() {
  const kitchen = await signedIn(server.url, "Küche");
  const cellar = await signedIn(server.url, "Keller");
  const raw = await RawClient.login(server.url);
  return { kitchen, cellar, raw };
}

describe("Löschen gewinnt gegen Bearbeiten", () => {
  it("legt die Bearbeitung einer entnommenen Packung ab und wendet sie beim Wiederherstellen an", async () => {
    const { kitchen, cellar, raw } = await setup();
    const zone = firstZone(kitchen);
    const shelf = await kitchen.core.zones.create({ name: "Regal K1" });
    const stored = await kitchen.core.stock.store({ product: { kind: "new", name: "Kichererbsen K1" }, zone_id: zone.id, best_before: "2027-01-31", count: 1, labels: false });
    const id = stored.packages[0]?.id ?? "";
    await kitchen.sync();
    await cellar.sync();

    // Der Keller entnimmt die Packung; die Küche bearbeitet sie danach, ohne davon zu wissen.
    await cellar.core.stock.remove([id], "consumed");
    await cellar.sync();
    await kitchen.core.stock.update([id], { best_before: "2027-06-30", zone_id: shelf.id });
    expect(stocked(kitchen, id).best_before).toBe("2027-06-30");
    await kitchen.sync();

    // Nicht angewendet, obwohl die Bearbeitung später kam: Die Packung ist weg.
    expect(kitchen.net.lastSync.response?.results).toMatchObject([{ status: "displaced", code: null, duplicate: false }]);
    const problems = value(kitchen.core.sync.problems);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ status: "displaced", code: null, command: { type: "package.update", package_id: id } });
    const waiting = removed(kitchen, id);
    expect(waiting).toMatchObject({ best_before: "2027-01-31", zone_id: zone.id, removal_reason: "consumed" });
    expect(waiting.displaced?.changes).toEqual([
      { field: "best_before", value: "2027-06-30" },
      { field: "zone_id", value: shelf.id },
    ]);
    await expectSameAsServer(kitchen, raw);

    // Der Keller sieht die verdrängte Bearbeitung in der Lösch-Historie und übernimmt sie beim Wiederherstellen.
    await cellar.sync();
    expect(removed(cellar, id).displaced?.changes).toHaveLength(2);
    await cellar.core.stock.restore([id], { apply_displaced: true });
    // Lokal sofort so, wie es der Server danach liefert.
    expect(stocked(cellar, id)).toMatchObject({ best_before: "2027-06-30", zone_id: shelf.id, removed_at: null, displaced: null });
    await cellar.sync();
    expect(stocked(cellar, id)).toMatchObject({ best_before: "2027-06-30", zone_id: shelf.id, removed_at: null, removal_reason: null, displaced: null });
    await expectSameAsServer(cellar, raw);
    await kitchen.sync();
    expect(stocked(kitchen, id)).toMatchObject({ best_before: "2027-06-30", zone_id: shelf.id });
    await expectSameAsServer(kitchen, raw);

    const history = (await raw.events({ entity: "package", entity_id: id })).map((event) => event.type).reverse();
    expect(history).toEqual(["package.created", "package.removed", "package.edit_displaced", "package.restored", "package.updated"]);
  });

  it("verwirft die verdrängte Bearbeitung, wenn ohne sie wiederhergestellt wird", async () => {
    const { kitchen, cellar, raw } = await setup();
    const stored = await kitchen.core.stock.store({ product: { kind: "new", name: "Bulgur K2" }, zone_id: firstZone(kitchen).id, best_before: "2027-02-28", count: 1, labels: false });
    const id = stored.packages[0]?.id ?? "";
    await kitchen.sync();
    await cellar.sync();

    await cellar.core.stock.remove([id], "discarded");
    await cellar.sync();
    await kitchen.core.stock.update([id], { best_before: null });
    await kitchen.sync();
    expect(removed(kitchen, id).displaced?.changes).toEqual([{ field: "best_before", value: null }]);

    await kitchen.core.stock.restore([id]);
    await kitchen.sync();
    expect(stocked(kitchen, id)).toMatchObject({ best_before: "2027-02-28", displaced: null });
    await expectSameAsServer(kitchen, raw);
  });

  it("lässt von Entnehmen und Wiederherstellen das spätere gewinnen, gleich in welcher Reihenfolge sie eintreffen", async () => {
    const { kitchen, cellar, raw } = await setup();
    const stored = await kitchen.core.stock.store({ product: { kind: "new", name: "Couscous K3" }, zone_id: firstZone(kitchen).id, best_before: null, count: 1, labels: false });
    const id = stored.packages[0]?.id ?? "";
    await kitchen.sync();
    await cellar.sync();

    // Der Keller hat die Packung vor zehn Minuten entnommen und war seitdem ohne Netz.
    await cellar.ago(10 * MINUTE, () => cellar.core.stock.remove([id], "consumed"));
    // Die Küche entnimmt sie jetzt und stellt sie gleich wieder her; das kommt zuerst beim Server an.
    await kitchen.core.stock.remove([id], "mistake");
    await kitchen.core.stock.restore([id]);
    await kitchen.sync();
    await cellar.sync();

    // Das alte Entnehmen des Kellers trifft später ein, ist aber das frühere: Es verliert.
    expect(cellar.net.lastSync.response?.results).toMatchObject([{ status: "applied" }]);
    expect(stocked(cellar, id).removed_at).toBeNull();
    await expectSameAsServer(cellar, raw);
    await kitchen.sync();
    expect(stocked(kitchen, id).removed_at).toBeNull();
  });
});

describe("Feldänderungen", () => {
  it("lässt je Feld die spätere Änderung gewinnen, auch wenn die frühere später eintrifft", async () => {
    const { kitchen, cellar, raw } = await setup();
    const zone = firstZone(kitchen);
    const shelf = await kitchen.core.zones.create({ name: "Regal F1" });
    const stored = await kitchen.core.stock.store({ product: { kind: "new", name: "Polenta F1" }, zone_id: zone.id, best_before: "2027-01-01", count: 1, labels: false });
    const id = stored.packages[0]?.id ?? "";
    await kitchen.sync();
    await cellar.sync();

    // Die Küche hat vor einer Minute MHD und Zone geändert, war aber ohne Netz.
    // (Ihre letzte Änderung davor, das Einlagern, ist jünger als eine Minute: Die Untergrenze
    // je Gerät hebt den Befehl auf diesen Zeitpunkt, er bleibt damit vor der Änderung des Kellers.)
    await kitchen.ago(MINUTE, () => kitchen.core.stock.update([id], { best_before: "2027-02-02", zone_id: shelf.id }));
    // Der Keller ändert jetzt das MHD und gleicht zuerst ab.
    await cellar.core.stock.update([id], { best_before: "2027-03-03" });
    await cellar.sync();
    await kitchen.sync();

    // Kein Sync-Problem: Der Befehl der Küche ist verarbeitet, nur ihr MHD hat verloren.
    expect(kitchen.net.lastSync.response?.results).toMatchObject([{ status: "applied", code: null }]);
    expect(value(kitchen.core.sync.problems)).toEqual([]);
    expect(stocked(kitchen, id)).toMatchObject({ best_before: "2027-03-03", zone_id: shelf.id });
    await cellar.sync();
    expect(stocked(cellar, id)).toMatchObject({ best_before: "2027-03-03", zone_id: shelf.id });
    await expectSameAsServer(kitchen, raw);
    await expectSameAsServer(cellar, raw);

    // Das Ereignisprotokoll hält fest, was überschrieben wurde und was verloren hat.
    const updates = (await raw.events({ entity: "package", entity_id: id })).filter((event) => event.type === "package.updated");
    expect(updates[0]?.data).toMatchObject({ changes: { zone_id: { old: zone.id, new: shelf.id } }, superseded: { best_before: "2027-02-02" } });
    expect(updates[1]?.data).toMatchObject({ changes: { best_before: { old: "2027-01-01", new: "2027-03-03" } } });
  });

  it("entscheidet auch bei Produkten und Zonen je Feld", async () => {
    const { kitchen, cellar, raw } = await setup();
    const product = await kitchen.core.products.create({ name: "Grieß F2", brand: "Alt", quantity: "500 g" });
    const zone = await kitchen.core.zones.create({ name: "Schrank F2", icon: "box" });
    await kitchen.sync();
    await cellar.sync();

    await cellar.core.products.update(product.id, { brand: "Neu" });
    await cellar.core.zones.update(zone.id, { name: "Hochschrank F2" });
    await kitchen.core.products.update(product.id, { quantity: "1 kg" });
    await kitchen.core.zones.update(zone.id, { icon: "shelf" });
    await cellar.sync();
    await kitchen.sync();
    await cellar.sync();

    for (const device of [kitchen, cellar]) {
      expect(value(device.core.data.products).find((candidate) => candidate.id === product.id)).toMatchObject({ name: "Grieß F2", brand: "Neu", quantity: "1 kg" });
      expect(value(device.core.data.zones).find((candidate) => candidate.id === zone.id)).toMatchObject({ name: "Hochschrank F2", icon: "shelf" });
      await expectSameAsServer(device, raw);
    }
  });
});

describe("Ein Barcode, ein Produkt", () => {
  it("führt zwei Platzhalter zusammen, die zwei Geräte offline zum selben Barcode angelegt haben", async () => {
    const { kitchen, cellar, raw } = await setup();
    const zone = firstZone(kitchen);
    const barcode = freshBarcode();

    const inKitchen = await kitchen.core.stock.store({ product: { kind: "barcode", barcode }, zone_id: zone.id, best_before: null, count: 1, labels: false });
    const inCellar = await cellar.core.stock.store({ product: { kind: "barcode", barcode }, zone_id: zone.id, best_before: "2027-05-05", count: 2, labels: false });
    await cellar.core.products.update(inCellar.product.id, { name: "Tomaten B1" });
    expect(inKitchen.product.id).not.toBe(inCellar.product.id);

    await kitchen.sync();
    await cellar.sync();

    // Kein Befehl abgelehnt: Der Platzhalter des Kellers ist im Produkt der Küche aufgegangen.
    expect(cellar.net.lastSync.response?.results.map((result) => result.status)).toEqual(["applied", "applied", "applied", "applied"]);
    expect(value(cellar.core.sync.problems)).toEqual([]);
    const all = [...inKitchen.packages, ...inCellar.packages].map((pkg) => pkg.id).sort();
    expect(stockedOf(cellar, inKitchen.product.id)).toEqual(all);
    expect(value(cellar.core.data.products).some((product) => product.id === inCellar.product.id)).toBe(false);
    // Der Name, den der Keller seinem Platzhalter gegeben hat, gilt für das gemeinsame Produkt.
    expect((await cellar.core.data.findProduct(inCellar.product.id))?.id).toBe(inKitchen.product.id);
    expect((await cellar.core.data.findProductByBarcode(barcode))?.name).toBe("Tomaten B1");
    const state = await expectSameAsServer(cellar, raw);
    expect(state.products.find((product) => product.id === inCellar.product.id)).toMatchObject({ merged_into: inKitchen.product.id, barcodes: [] });
    expect(state.products.find((product) => product.id === inKitchen.product.id)).toMatchObject({ name: "Tomaten B1", barcodes: [barcode], deleted_at: null });

    await kitchen.sync();
    expect(stockedOf(kitchen, inKitchen.product.id)).toEqual(all);
    await expectSameAsServer(kitchen, raw);

    const merges = (await raw.events({ entity: "product", entity_id: inKitchen.product.id })).filter((event) => event.type === "product.merged");
    expect(merges).toHaveLength(1);
    expect(merges[0]?.data).toMatchObject({ source_id: inCellar.product.id, reason: "barcode", packages: 0 });
  });
});

describe("Ein Barcode wird zugeordnet, den inzwischen ein anderes Produkt hat", () => {
  it("lässt den bisherigen Besitzer im genannten Produkt aufgehen", async () => {
    const { kitchen, cellar, raw } = await setup();
    const zone = firstZone(kitchen);
    const barcode = freshBarcode();
    const named = await kitchen.core.products.create({ name: "Passata B2" });
    await kitchen.sync();
    await cellar.sync();

    // Der Keller scannt den Barcode (Platzhalter mit Packung) und gleicht ab.
    const scanned = await cellar.core.stock.store({ product: { kind: "barcode", barcode }, zone_id: zone.id, best_before: null, count: 1, labels: false });
    await cellar.sync();
    // Die Küche weiß davon nichts und ordnet denselben Barcode ihrem benannten Produkt zu.
    await kitchen.core.products.addBarcode(named.id, barcode);
    await kitchen.sync();

    expect(kitchen.net.lastSync.response?.results).toMatchObject([{ status: "applied", code: null }]);
    expect(value(kitchen.core.sync.problems)).toEqual([]);
    // Der Platzhalter ist im benannten Produkt aufgegangen, seine Packung gehört jetzt dazu.
    expect(stockedOf(kitchen, named.id)).toEqual(scanned.packages.map((pkg) => pkg.id));
    expect((await kitchen.core.data.findProductByBarcode(barcode))?.id).toBe(named.id);
    await expectSameAsServer(kitchen, raw);

    await cellar.sync();
    expect((await cellar.core.data.findProduct(scanned.product.id))?.id).toBe(named.id);
    expect(stockedOf(cellar, named.id)).toEqual(scanned.packages.map((pkg) => pkg.id));
    await expectSameAsServer(cellar, raw);
  });
});

describe("Doppelte Packungs-ID", () => {
  it("lehnt das zweite Anlegen ab und zeigt es in den Sync-Problemen", async () => {
    const { cellar, raw } = await setup();
    const zone = firstZone(cellar);

    // Der Keller lagert offline ein; die ID stammt aus seinem Vorrat.
    const stored = await cellar.core.stock.store({ product: { kind: "new", name: "Reis D1" }, zone_id: zone.id, best_before: "2027-09-09", count: 2, labels: false });
    const [clash, fine] = stored.packages.map((pkg) => pkg.id) as [string, string];

    // Ein anderes Gerät legt inzwischen eine Packung mit derselben ID an (leerer Vorrat, Zufalls-ID).
    const foreignProduct = "0c0ffee0-0000-4000-8000-00000000d001";
    const first = await raw.send([
      { type: "product.create", product_id: foreignProduct, name: "Fremdes Produkt D1" },
      { type: "package.create", package_id: clash, product_id: foreignProduct, zone_id: zone.id, best_before: null },
    ]);
    expect(first.results.map((result) => result.status)).toEqual(["applied", "applied"]);

    await cellar.sync();
    const results = cellar.net.lastSync.response?.results ?? [];
    expect(results.map((result) => [result.status, result.code])).toEqual([
      ["applied", null],
      ["rejected", "id_conflict"],
      ["applied", null],
    ]);

    const problems = value(cellar.core.sync.problems);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ status: "rejected", code: "id_conflict", command: { type: "package.create", package_id: clash, best_before: "2027-09-09" } });
    expect(problems[0]?.message).toBeTruthy();

    // Die lokale Kopie folgt dem Server: Die Packung gehört dem anderen Produkt, die zweite ist angelegt.
    expect(stocked(cellar, clash)).toMatchObject({ product_id: foreignProduct, best_before: null });
    expect(stocked(cellar, fine)).toMatchObject({ product_id: stored.product.id, best_before: "2027-09-09" });
    await expectSameAsServer(cellar, raw);

    // Das Problem bleibt über ein Neuladen der App, bis der Anwender es wegklickt.
    await cellar.reload();
    expect(value(cellar.core.sync.problems)).toHaveLength(1);
    await cellar.core.sync.dismissProblem(problems[0]?.id ?? "");
    expect(value(cellar.core.sync.problems)).toEqual([]);

    const rejected = (await raw.events({ entity: "package", entity_id: clash })).filter((event) => event.type === "command.rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.data).toMatchObject({ code: "id_conflict", type: "package.create" });
  });
});

describe("Reihenfolge eines Geräts über Anfragen hinweg", () => {
  it("lässt ein „Rückgängig“ gewinnen, auch wenn das Entnehmen davor lange unterwegs war", async () => {
    const { kitchen, raw } = await setup();
    const stored = await kitchen.core.stock.store({ product: { kind: "new", name: "Hirse R1" }, zone_id: firstZone(kitchen).id, best_before: null, count: 1, labels: false });
    const id = stored.packages[0]?.id ?? "";
    await kitchen.sync();

    // Die Anfrage mit dem Entnehmen braucht anderthalb Sekunden bis zum Server.
    kitchen.net.delayNextSyncMs = 1_500;
    await kitchen.core.stock.remove([id], "consumed");
    const slow = kitchen.core.sync.now();
    // Eine halbe Sekunde später tippt der Anwender auf „Rückgängig“; das geht in einer zweiten, schnellen Anfrage hinaus.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await kitchen.core.stock.restore([id]);
    expect(stocked(kitchen, id).removed_at).toBeNull();
    await slow;
    await kitchen.sync();

    // Der wirksame Zeitpunkt des Entnehmens enthält die Laufzeit der Anfrage und liegt damit
    // nach dem des „Rückgängig“. Entscheidend ist trotzdem die Reihenfolge, in der das Gerät gehandelt hat.
    expect(stocked(kitchen, id).removed_at).toBeNull();
    await expectSameAsServer(kitchen, raw);
    const history = (await raw.events({ entity: "package", entity_id: id })).map((event) => event.type).reverse();
    expect(history).toEqual(["package.created", "package.removed", "package.restored"]);
  });
});
