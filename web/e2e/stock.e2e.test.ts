/**
 * Bestand ändern über zwei Geräte: einlagern, Etiketten anfordern, entnehmen,
 * wiederherstellen, bearbeiten, Produkte pflegen, Einstellungen.
 *
 * Alle Tests teilen sich einen Server; jeder benutzt eigene Produktnamen und Barcodes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { isTimestamp } from "@/contract";

import { firstZone, freshBarcode, removed, stocked, stockedOf } from "./support/data";
import { disposeDevices, expectCoreError, signedIn, value } from "./support/device";
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

describe("Einlagern", () => {
  it("legt Packungen an: neues Produkt, unbekannter Barcode, bekanntes Produkt", async () => {
    const { kitchen, cellar, raw } = await setup();
    const zone = firstZone(kitchen);
    const barcode = freshBarcode();
    const scanned = freshBarcode();

    const rice = await kitchen.core.stock.store({
      product: { kind: "new", name: "Basmati S1", brand: "Reishunger", quantity: "1 kg", warn_days: 30, barcodes: [barcode] },
      zone_id: zone.id,
      best_before: "2027-03-31",
      count: 3,
    });
    expect(rice.packages).toHaveLength(3);
    // Der Haushalt hat keinen Drucker: Es werden keine Etiketten angefordert.
    expect(rice.print_jobs).toEqual([]);

    // Unbekannter Barcode: sofort ein Platzhalter ohne Namen; derselbe Barcode trifft danach dasselbe Produkt.
    const placeholder = await kitchen.core.stock.store({ product: { kind: "barcode", barcode: scanned }, zone_id: zone.id, best_before: null, count: 1 });
    expect(placeholder.product).toMatchObject({ name: "", barcodes: [scanned] });
    const again = await kitchen.core.stock.store({ product: { kind: "barcode", barcode: scanned }, zone_id: zone.id, best_before: "2026-12-24", count: 2 });
    expect(again.product.id).toBe(placeholder.product.id);
    const more = await kitchen.core.stock.store({ product: { kind: "existing", product_id: rice.product.id }, zone_id: zone.id, best_before: null, count: 1 });

    // Lokal sofort sichtbar; je Produkt und je Packung wartet ein Befehl.
    expect(kitchen.status.pending).toBe(1 + 3 + 1 + 1 + 2 + 1);
    const riceIds = [...rice.packages, ...more.packages].map((pkg) => pkg.id).sort();
    expect(stockedOf(kitchen, rice.product.id)).toEqual(riceIds);

    await kitchen.sync();
    const results = kitchen.net.lastSync.response?.results ?? [];
    expect(results).toHaveLength(9);
    expect(results.every((result) => result.status === "applied" && !result.duplicate && result.code === null)).toBe(true);

    const state = await expectSameAsServer(kitchen, raw);
    // Open Food Facts ist in den Tests abgeschaltet: Nichts wartet auf ein Nachschlagen.
    expect(state.products.find((product) => product.id === rice.product.id)).toMatchObject({
      name: "Basmati S1",
      brand: "Reishunger",
      quantity: "1 kg",
      warn_days: 30,
      barcodes: [barcode],
      lookup: "none",
      image: null,
      deleted_at: null,
      merged_into: null,
    });
    expect(state.products.find((product) => product.id === placeholder.product.id)).toMatchObject({ name: "", barcodes: [scanned], lookup: "none" });
    const pkg = state.packages.find((candidate) => candidate.id === rice.packages[0]?.id);
    expect(pkg).toMatchObject({ product_id: rice.product.id, zone_id: zone.id, best_before: "2027-03-31", removed_at: null, removal_reason: null, displaced: null });
    // Zeitpunkte sind Serverzeit: der Moment des Einlagerns, nicht die Geräteuhr.
    expect(isTimestamp(pkg?.created_at ?? "")).toBe(true);
    expect(Math.abs(Date.parse(pkg?.created_at ?? "") - Date.now())).toBeLessThan(60_000);

    await cellar.sync();
    await expectSameAsServer(cellar, raw);
    expect(stockedOf(cellar, rice.product.id)).toEqual(riceIds);
    expect(stockedOf(cellar, placeholder.product.id)).toHaveLength(3);

    // Ereignisprotokoll: genau ein Eintrag je Packung, mit dem Gerät, das eingelagert hat.
    const events = await raw.events({ entity: "package", entity_id: rice.packages[0]?.id });
    expect(events.map((event) => event.type)).toEqual(["package.created"]);
    expect(events[0]?.device_id).toBe(kitchen.session.id);
  });

  it("lagert mit einer Geräteuhr ein, die falsch geht: Es zählt nur das Alter", async () => {
    const { kitchen, raw } = await setup();
    // Die Uhr des Geräts geht drei Tage vor.
    kitchen.clock.shift(3 * 24 * 3_600_000);
    const stored = await kitchen.core.stock.store({ product: { kind: "new", name: "Zucker S2" }, zone_id: firstZone(kitchen).id, best_before: null, count: 1 });
    expect(Date.parse(stored.packages[0]?.created_at ?? "")).toBeGreaterThan(Date.now() + 2 * 24 * 3_600_000);
    await kitchen.sync();
    const state = await expectSameAsServer(kitchen, raw);
    const created = state.packages.find((pkg) => pkg.id === stored.packages[0]?.id)?.created_at ?? "";
    expect(Math.abs(Date.parse(created) - Date.now())).toBeLessThan(60_000);
  });

  it("nimmt alles an, was der Kern an Grenzwerten durchlässt", async () => {
    const { kitchen, raw } = await setup();
    const long = (length: number) => "x".repeat(length);
    const barcodes = Array.from({ length: 20 }, () => freshBarcode());

    const product = await kitchen.core.products.create({ name: long(120), brand: long(80), quantity: long(40), warn_days: 3650, barcodes });
    const zone = await kitchen.core.zones.create({ name: long(60), icon: long(32), color: long(16) });
    const stored = await kitchen.core.stock.store({ product: { kind: "existing", product_id: product.id }, zone_id: zone.id, best_before: "2099-12-31", count: 50, labels: false });
    await kitchen.core.settings.update({ warn_days: 3650 });
    expect(stored.packages).toHaveLength(50);

    await kitchen.sync();
    const results = kitchen.net.resultsSince(1);
    expect(results.filter((result) => result.status !== "applied")).toEqual([]);
    const state = await expectSameAsServer(kitchen, raw);
    expect(state.products.find((candidate) => candidate.id === product.id)?.barcodes).toEqual([...barcodes].sort());
    expect(state.zones.find((candidate) => candidate.id === zone.id)).toMatchObject({ name: long(60), icon: long(32), color: long(16) });

    // Aufräumen für die übrigen Tests dieser Datei.
    await kitchen.core.settings.update({ warn_days: 14 });
    await kitchen.core.zones.remove(zone.id, firstZone(kitchen).id);
    await kitchen.sync();
  });
});

describe("Etiketten", () => {
  it("fordert Etiketten an, sobald es einen Drucker gibt, und verwirft ausstehende beim Entnehmen", async () => {
    const { kitchen, cellar, raw } = await setup();
    const zone = firstZone(kitchen);

    // Ohne Drucker gibt es keine Etiketten, auch wenn sie gewünscht sind.
    const before = await kitchen.core.stock.store({ product: { kind: "new", name: "Mehl L1" }, zone_id: zone.id, best_before: null, count: 1, labels: true });
    expect(before.print_jobs).toEqual([]);
    await expectCoreError(kitchen.core.print.requestPackageLabels([before.packages[0]?.id ?? ""]), "not_found");

    const printer = await kitchen.core.printers.create({ name: "Brother Küche", connection: "server", server: { driver: "image", model: null, address: null, media: "62x29" } });
    await kitchen.core.settings.update({ default_printer_id: printer.id });
    const stored = await kitchen.core.stock.store({ product: { kind: "existing", product_id: before.product.id }, zone_id: zone.id, best_before: "2027-01-15", count: 2 });
    const [first, second] = stored.packages.map((pkg) => pkg.id) as [string, string];
    expect(stored.print_jobs.map((job) => job.package_id)).toEqual([first, second]);
    expect(stored.print_jobs.every((job) => job.kind === "package" && job.state === "pending" && job.printer_id === null)).toBe(true);
    const firstJob = stored.print_jobs[0]?.id ?? "";

    await kitchen.sync();
    let state = await expectSameAsServer(kitchen, raw);
    expect(state.print_jobs.find((job) => job.id === firstJob)).toMatchObject({
      kind: "package",
      package_id: first,
      zone_id: null,
      state: "pending",
      printer_id: null,
      boot_id: null,
      error: null,
      device_id: kitchen.session.id,
    });
    expect(state.settings?.default_printer_id).toBe(printer.id);

    await cellar.sync();
    await expectSameAsServer(cellar, raw);

    // Das andere Gerät entnimmt eine der Packungen: Ihr ausstehendes Etikett braucht niemand mehr.
    await cellar.core.stock.remove([first], "mistake");
    expect(value(cellar.core.data.printJobs).find((job) => job.id === firstJob)?.state).toBe("cancelled");
    await cellar.sync();
    state = await expectSameAsServer(cellar, raw);
    expect(state.print_jobs.find((job) => job.id === firstJob)).toMatchObject({ state: "cancelled", error: null, printer_id: null, boot_id: null });

    // Nachdruck auf einen bestimmten Drucker, verwerfen, neuer Versuch; dazu ein Zonen-Etikett.
    await kitchen.sync();
    const [reprint] = await kitchen.core.print.requestPackageLabels([second], { printer_id: printer.id });
    expect(reprint).toMatchObject({ state: "pending", package_id: second, printer_id: printer.id });
    await kitchen.core.print.cancel(reprint?.id ?? "");
    const retry = await kitchen.core.print.retry(reprint?.id ?? "");
    expect(retry).toMatchObject({ state: "pending", package_id: second, printer_id: printer.id });
    expect(retry.id).not.toBe(reprint?.id);
    const zoneLabel = await kitchen.core.print.requestZoneLabel(zone.id);
    expect(zoneLabel).toMatchObject({ kind: "zone", zone_id: zone.id, package_id: null, state: "pending" });
    await kitchen.sync();
    state = await expectSameAsServer(kitchen, raw);
    // Wer verwirft, schickt den Drucker mit: Er bleibt am Etikett stehen.
    expect(state.print_jobs.find((job) => job.id === reprint?.id)).toMatchObject({ state: "cancelled", printer_id: printer.id, boot_id: null, error: null });
    expect(state.print_jobs.find((job) => job.id === retry.id)).toMatchObject({ state: "pending", printer_id: printer.id });

    // Drucker einer Zone zuordnen, umbenennen und löschen: Verweise in Zonen und Einstellungen verschwinden.
    await kitchen.core.zones.update(zone.id, { printer_id: printer.id });
    await kitchen.core.printers.update(printer.id, { name: "Brother Keller" });
    await kitchen.sync();
    await cellar.sync();
    expect(value(cellar.core.data.printers).find((candidate) => candidate.id === printer.id)?.name).toBe("Brother Keller");
    expect(firstZone(cellar).printer_id).toBe(printer.id);

    await cellar.core.printers.remove(printer.id);
    expect(value(cellar.core.data.settings).default_printer_id).toBeNull();
    expect(firstZone(cellar).printer_id).toBeNull();
    await cellar.sync();
    state = await expectSameAsServer(cellar, raw);
    expect(state.settings?.default_printer_id).toBeNull();
    expect(state.zones.find((candidate) => candidate.id === zone.id)?.printer_id).toBeNull();
    expect(state.printers.find((candidate) => candidate.id === printer.id)?.deleted_at).not.toBeNull();

    await kitchen.sync();
    await expectSameAsServer(kitchen, raw);
    expect(value(kitchen.core.data.printers).some((candidate) => candidate.id === printer.id)).toBe(false);
  });
});

describe("Entnehmen, Wiederherstellen, Bearbeiten", () => {
  it("entnimmt, ändert den Grund, stellt wieder her und bearbeitet", async () => {
    const { kitchen, cellar, raw } = await setup();
    const zone = firstZone(kitchen);
    const shelf = await kitchen.core.zones.create({ name: "Regal S3", icon: "shelf", color: "blue" });
    const other = await kitchen.core.products.create({ name: "Dinkelnudeln S3" });
    const stored = await kitchen.core.stock.store({ product: { kind: "new", name: "Nudeln S3" }, zone_id: zone.id, best_before: "2027-08-31", count: 3, labels: false });
    const [p1, p2, p3] = stored.packages.map((pkg) => pkg.id) as [string, string, string];
    await kitchen.sync();
    await cellar.sync();

    // Entnehmen auf dem anderen Gerät.
    await cellar.core.stock.remove([p1], "consumed");
    expect(removed(cellar, p1).removal_reason).toBe("consumed");
    expect(stockedOf(cellar, stored.product.id)).toEqual([p2, p3].sort());
    await cellar.sync();
    await kitchen.sync();
    const gone = removed(kitchen, p1);
    expect(gone.removal_reason).toBe("consumed");
    expect(Math.abs(Date.parse(gone.removed_at ?? "") - Date.now())).toBeLessThan(60_000);

    // Schon entnommen: Es ändert sich nur der Grund, nicht der Zeitpunkt.
    await kitchen.core.stock.remove([p1], "discarded");
    await kitchen.sync();
    await cellar.sync();
    expect(removed(cellar, p1)).toMatchObject({ removal_reason: "discarded", removed_at: gone.removed_at });

    // Wiederherstellen.
    await kitchen.core.stock.restore([p1]);
    expect(stocked(kitchen, p1).removed_at).toBeNull();
    await kitchen.sync();
    await cellar.sync();
    expect(stocked(cellar, p1)).toMatchObject({ removed_at: null, removal_reason: null, best_before: "2027-08-31", displaced: null });

    // Bearbeiten: MHD, Zone, Produkt; null entfernt das MHD.
    await kitchen.core.stock.update([p2, p3], { best_before: "2028-01-31", zone_id: shelf.id });
    await kitchen.core.stock.update([p3], { best_before: null, product_id: other.id });
    await kitchen.sync();
    await cellar.sync();
    expect(stocked(cellar, p2)).toMatchObject({ best_before: "2028-01-31", zone_id: shelf.id, product_id: stored.product.id });
    expect(stocked(cellar, p3)).toMatchObject({ best_before: null, zone_id: shelf.id, product_id: other.id });
    await expectSameAsServer(kitchen, raw);
    await expectSameAsServer(cellar, raw);

    const history = (await raw.events({ entity: "package", entity_id: p1 })).map((event) => event.type).reverse();
    expect(history).toEqual(["package.created", "package.removed", "package.reason_changed", "package.restored"]);
  });
});

describe("Produkte und Einstellungen", () => {
  it("pflegt Produkte: Felder, Barcodes, Zusammenführen", async () => {
    const { kitchen, cellar, raw } = await setup();
    const zone = firstZone(kitchen);
    const [b1, b2, b3] = [freshBarcode(), freshBarcode(), freshBarcode()] as [string, string, string];

    const oats = await kitchen.core.products.create({ name: "Haferflocken P1", brand: "Kölln", quantity: "500 g", warn_days: 60, barcodes: [b1] });
    const placeholder = await kitchen.core.stock.store({ product: { kind: "barcode", barcode: b2 }, zone_id: zone.id, best_before: null, count: 2, labels: false });
    await kitchen.core.products.update(oats.id, { brand: "Kölln Flocken", warn_days: null });
    await kitchen.core.products.addBarcode(oats.id, b3);
    await kitchen.core.products.removeBarcode(oats.id, b1);

    // Der Barcode des Platzhalters gehört schon einem Produkt: Das meldet der Kern, statt still zusammenzuführen.
    const taken = await expectCoreError(kitchen.core.products.addBarcode(oats.id, b2), "barcode_taken");
    expect(taken.details.product_id).toBe(placeholder.product.id);

    await kitchen.core.products.merge(placeholder.product.id, oats.id);
    // Lokal sofort: Die Quelle ist weg, ihre Packungen und Barcodes gehören zum Ziel.
    expect(value(kitchen.core.data.products).some((product) => product.id === placeholder.product.id)).toBe(false);
    expect(stockedOf(kitchen, oats.id)).toEqual(placeholder.packages.map((pkg) => pkg.id).sort());
    expect((await kitchen.core.data.findProduct(placeholder.product.id))?.id).toBe(oats.id);

    await kitchen.sync();
    const state = await expectSameAsServer(kitchen, raw);
    expect(state.products.find((product) => product.id === oats.id)).toMatchObject({
      name: "Haferflocken P1",
      brand: "Kölln Flocken",
      quantity: "500 g",
      warn_days: null,
      barcodes: [b2, b3].sort(),
      deleted_at: null,
    });
    const source = state.products.find((product) => product.id === placeholder.product.id);
    expect(source).toMatchObject({ merged_into: oats.id, barcodes: [] });
    expect(source?.deleted_at).not.toBeNull();

    await cellar.sync();
    await expectSameAsServer(cellar, raw);
    expect((await cellar.core.data.findProductByBarcode(b2))?.id).toBe(oats.id);
    expect((await cellar.core.data.findProduct(placeholder.product.id))?.id).toBe(oats.id);
    expect(await cellar.core.data.findProductByBarcode(b1)).toBeUndefined();
  });

  it("ändert die Einstellungen des Haushalts für alle Geräte", async () => {
    const { kitchen, cellar, raw } = await setup();
    const second = await kitchen.core.zones.create({ name: "Speisekammer E1" });
    await kitchen.core.settings.update({ zone_mode: "equal", warn_days: 21, primary_zone_id: second.id });
    expect(value(kitchen.core.data.settings)).toMatchObject({ zone_mode: "equal", warn_days: 21, primary_zone_id: second.id });
    await kitchen.sync();
    await cellar.sync();
    expect(value(cellar.core.data.settings)).toMatchObject({ zone_mode: "equal", warn_days: 21, primary_zone_id: second.id, trash_retention_days: 30 });
    await expectSameAsServer(cellar, raw);

    // Jedes Feld für sich: Die Änderung des einen Geräts lässt die des anderen stehen.
    await cellar.core.settings.update({ warn_days: 7 });
    await kitchen.core.settings.update({ zone_mode: "primary" });
    await cellar.sync();
    await kitchen.sync();
    await cellar.sync();
    expect(value(cellar.core.data.settings)).toMatchObject({ zone_mode: "primary", warn_days: 7, primary_zone_id: second.id });
    await expectSameAsServer(kitchen, raw);
    await expectSameAsServer(cellar, raw);
  });
});
