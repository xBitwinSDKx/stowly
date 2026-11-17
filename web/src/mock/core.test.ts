/**
 * Die Attrappe muss sich so verhalten, wie src/contract/core.ts es beschreibt.
 * Diese Tests sind zugleich ein ausführbares Beispiel für die Schnittstelle des Kerns.
 */
import { describe, expect, it, vi } from "vitest";

import {
  addDays,
  CoreError,
  expiryState,
  gtinCheckDigit,
  isPackageId,
  isUuid,
  isValidBarcode,
  LIMITS,
  missingStock,
  shoppingItemTitle,
  stockCount,
  todayLocal,
  warnDaysFor,
  type HaState,
  type HaStatus,
  type Live,
  type Package,
  type Product,
  type PushState,
  type ShoppingItem,
  type StatsRange,
} from "@/contract";

import {
  createMockCore,
  createSampleData,
  DEVICE_IDS,
  HA_TOKEN_MISSING,
  MOCK_BACKUP_KEYS,
  MOCK_BACKUP_SECRET,
  MOCK_HA_URL,
  MOCK_PASSWORD,
  PRINTER_IDS,
  sampleBarcode,
  samplePackageId,
  sampleUuid,
  ZONE_IDS,
  type MockCore,
  type MockScenario,
} from ".";

const NOW = new Date("2026-11-13T10:00:00.000Z");

function mock(options: Parameters<typeof createMockCore>[0] = {}) {
  return createMockCore({ latency: 0, now: () => NOW, ...options });
}

function value<T>(live: Live<T>): T {
  const current = live.get();
  if (current === undefined) {
    throw new Error("Live-Wert ist noch nicht geladen");
  }
  return current;
}

async function expectCoreError(action: Promise<unknown>, code: CoreError["code"]): Promise<CoreError> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).code).toBe(code);
    return error as CoreError;
  }
  throw new Error(`Erwartet war CoreError ${code}`);
}

describe("Beispieldaten", () => {
  const data = createSampleData(NOW);
  const today = todayLocal(NOW);

  it("sind in sich stimmig", () => {
    const ids = data.packages.map((pkg) => pkg.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(isPackageId)).toBe(true);

    const productIds = new Set(data.products.map((product) => product.id));
    const zoneIds = new Set(data.zones.map((zone) => zone.id));
    for (const pkg of data.packages) {
      expect(productIds.has(pkg.product_id), pkg.id).toBe(true);
      expect(zoneIds.has(pkg.zone_id), pkg.id).toBe(true);
    }
    expect([...productIds, ...zoneIds].every(isUuid)).toBe(true);

    const barcodes = data.products.flatMap((product) => product.barcodes);
    expect(new Set(barcodes).size).toBe(barcodes.length);
    expect(barcodes.every(isValidBarcode)).toBe(true);
  });

  it("enthalten jede Warnstufe, Platzhalter und mehrere Chargen", () => {
    const byId = new Map(data.products.map((product) => [product.id, product]));
    const states = new Set(
      data.packages
        .filter((pkg) => pkg.removed_at === null)
        .map((pkg) => expiryState(pkg.best_before, warnDaysFor(byId.get(pkg.product_id), data.settings), today)),
    );
    expect(states).toEqual(new Set(["none", "ok", "soon", "expired"]));
    expect(data.products.filter((product) => product.name === "").map((product) => product.lookup).sort()).toEqual(["not_found", "pending"]);

    const rice = data.products.find((product) => product.name === "Basmati Reis");
    const batches = new Set(data.packages.filter((pkg) => pkg.product_id === rice?.id && pkg.removed_at === null).map((pkg) => `${String(pkg.best_before)}|${pkg.zone_id}`));
    expect(batches.size).toBe(3);
  });
});

describe("Lesen", () => {
  it("trennt Bestand und Lösch-Historie und beachtet die Aufbewahrungsdauer", () => {
    const core = mock();
    const all = core.control.snapshot().packages;
    const active = value(core.data.packages);
    const removed = value(core.data.removedPackages);

    expect(active.every((pkg) => pkg.removed_at === null)).toBe(true);
    expect(removed.every((pkg) => pkg.removed_at !== null)).toBe(true);
    // Eine Packung wurde vor 40 Tagen entnommen, dazu der Verlauf für die Statistik; die Aufbewahrung beträgt 30 Tage.
    const limit = new Date(NOW.getTime() - 30 * 86_400_000).toISOString();
    const old = all.filter((pkg) => pkg.removed_at !== null && pkg.removed_at < limit);
    expect(old.length).toBeGreaterThan(40);
    expect(active.length + removed.length).toBe(all.length - old.length);
    expect(removed).toHaveLength(5);
    expect(removed.map((pkg) => pkg.removed_at)).toEqual([...removed.map((pkg) => pkg.removed_at)].sort().reverse());
    expect(removed.some((pkg) => pkg.displaced !== null)).toBe(true);
  });

  it("liefert dieselbe Referenz, solange sich nichts Betroffenes ändert", async () => {
    const core = mock();
    const zones = core.data.zones.get();
    const packages = core.data.packages.get();
    expect(core.data.zones.get()).toBe(zones);

    await core.prefs.update({ scan_sound: false });
    expect(core.data.zones.get()).toBe(zones);
    expect(core.data.packages.get()).toBe(packages);

    await core.zones.create({ name: "Garage" });
    expect(core.data.zones.get()).not.toBe(zones);
    expect(core.data.packages.get()).toBe(packages);
  });

  it("benachrichtigt Abonnenten und lässt sie sich wieder abmelden", async () => {
    const core = mock();
    let calls = 0;
    const unsubscribe = core.data.zones.subscribe(() => {
      calls += 1;
    });
    await core.zones.create({ name: "Garage" });
    expect(calls).toBeGreaterThan(0);
    const before = calls;
    unsubscribe();
    await core.zones.create({ name: "Dachboden" });
    expect(calls).toBe(before);
  });

  it("findet Packungen und Produkte", async () => {
    const core = mock();
    const removed = value(core.data.removedPackages)[0];
    expect((await core.data.findPackage(removed?.id ?? ""))?.id).toBe(removed?.id);
    expect(await core.data.findPackage("ZZZZZ")).toBeUndefined();

    const product = value(core.data.products).find((candidate) => candidate.barcodes.length > 0);
    expect((await core.data.findProductByBarcode(product?.barcodes[0] ?? ""))?.id).toBe(product?.id);
    expect(await core.data.findProductByBarcode(sampleBarcode(999))).toBeUndefined();
  });
});

describe("Einlagern und Entnehmen", () => {
  it("legt je Packung einen Datensatz mit eigener ID und ein Etikett an", async () => {
    const core = mock();
    const product = value(core.data.products)[0];
    const before = value(core.data.packages).length;
    const result = await core.stock.store({
      product: { kind: "existing", product_id: product?.id ?? "" },
      zone_id: ZONE_IDS.cellar,
      best_before: "2027-03-25",
      count: 4,
    });

    expect(result.packages).toHaveLength(4);
    expect(new Set(result.packages.map((pkg) => pkg.id)).size).toBe(4);
    expect(result.packages.every((pkg) => isPackageId(pkg.id) && pkg.best_before === "2027-03-25" && pkg.zone_id === ZONE_IDS.cellar)).toBe(true);
    expect(result.print_jobs.map((job) => job.package_id)).toEqual(result.packages.map((pkg) => pkg.id));
    expect(result.print_jobs.every((job) => job.state === "pending" && job.kind === "package")).toBe(true);
    expect(value(core.data.packages)).toHaveLength(before + 4);
  });

  it("fordert ohne Wunsch keine Etiketten an", async () => {
    const core = mock();
    const product = value(core.data.products)[0];
    const input = { product: { kind: "existing", product_id: product?.id ?? "" }, zone_id: ZONE_IDS.shelf, best_before: null, count: 1 } as const;
    expect((await core.stock.store({ ...input, labels: false })).print_jobs).toEqual([]);

    await core.prefs.update({ print_labels: false });
    expect((await core.stock.store(input)).print_jobs).toEqual([]);
    expect((await core.stock.store({ ...input, labels: true })).print_jobs).toHaveLength(1);
  });

  it("fordert ohne Drucker nie Etiketten an", async () => {
    const core = mock({ scenarios: ["empty"] });
    const result = await core.stock.store({ product: { kind: "new", name: "Reis" }, zone_id: ZONE_IDS.shelf, best_before: null, count: 2, labels: true });
    expect(result.packages).toHaveLength(2);
    expect(result.print_jobs).toEqual([]);
    await expectCoreError(core.print.requestPackageLabels([result.packages[0]?.id ?? ""]), "not_found");
    await expectCoreError(core.print.requestZoneLabel(ZONE_IDS.shelf), "not_found");
  });

  it("verwirft ausstehende Etiketten entnommener Packungen", async () => {
    const core = mock();
    const product = value(core.data.products)[0];
    const { packages, print_jobs } = await core.stock.store({
      product: { kind: "existing", product_id: product?.id ?? "" },
      zone_id: ZONE_IDS.cellar,
      best_before: null,
      count: 2,
    });
    expect(print_jobs).toHaveLength(2);

    await core.stock.remove([packages[0]?.id ?? ""], "mistake");
    const state = (id: string | undefined) => value(core.data.printJobs).find((job) => job.id === id)?.state;
    expect(state(print_jobs[0]?.id)).toBe("cancelled");
    expect(state(print_jobs[1]?.id)).toBe("pending");

    await core.stock.restore([packages[0]?.id ?? ""]);
    expect(state(print_jobs[0]?.id)).toBe("cancelled");
  });

  it("legt für einen unbekannten Barcode sofort einen Platzhalter an", async () => {
    const core = mock({ latency: 600 });
    const barcode = sampleBarcode(500);
    const result = await core.stock.store({ product: { kind: "barcode", barcode }, zone_id: ZONE_IDS.shelf, best_before: null, count: 1 });
    expect(result.product.name).toBe("");
    expect(result.product.lookup).toBe("pending");
    expect(result.product.barcodes).toEqual([barcode]);
    expect((await core.data.findProductByBarcode(barcode))?.id).toBe(result.product.id);

    // Derselbe Barcode noch einmal: kein zweites Produkt
    const again = await core.stock.store({ product: { kind: "barcode", barcode }, zone_id: ZONE_IDS.shelf, best_before: null, count: 1 });
    expect(again.product.id).toBe(result.product.id);
  });

  it("schlägt ladeninterne Codes nicht nach", async () => {
    const core = mock();
    const result = await core.stock.store({
      product: { kind: "barcode", barcode: sampleBarcode(1, "2112345") },
      zone_id: ZONE_IDS.shelf,
      best_before: null,
      count: 1,
    });
    expect(result.product.lookup).toBe("none");
  });

  it("weist ungültige Eingaben zurück", async () => {
    const core = mock();
    const product = { kind: "existing", product_id: value(core.data.products)[0]?.id ?? "" } as const;
    await expectCoreError(core.stock.store({ product, zone_id: ZONE_IDS.shelf, best_before: null, count: 0 }), "invalid");
    await expectCoreError(core.stock.store({ product, zone_id: ZONE_IDS.shelf, best_before: null, count: 51 }), "invalid");
    await expectCoreError(core.stock.store({ product, zone_id: ZONE_IDS.shelf, best_before: "25.03.2027", count: 1 }), "invalid");
    await expectCoreError(core.stock.store({ product, zone_id: "10000000-0000-4000-8000-000000000099", best_before: null, count: 1 }), "not_found");
    await expectCoreError(core.stock.store({ product: { kind: "barcode", barcode: "4006381333932" }, zone_id: ZONE_IDS.shelf, best_before: null, count: 1 }), "invalid");
    await expectCoreError(core.stock.store({ product: { kind: "new", name: "  " }, zone_id: ZONE_IDS.shelf, best_before: null, count: 1 }), "invalid");
  });

  it("entnimmt in die Lösch-Historie und stellt wieder her", async () => {
    const core = mock();
    const pkg = value(core.data.packages)[0];
    const id = pkg?.id ?? "";

    await core.stock.remove([id], "consumed");
    expect(value(core.data.packages).some((candidate) => candidate.id === id)).toBe(false);
    const removed = value(core.data.removedPackages).find((candidate) => candidate.id === id);
    expect(removed?.removal_reason).toBe("consumed");
    expect(removed?.removed_at).toBe(NOW.toISOString());

    // noch einmal entnehmen ändert nur den Grund
    await core.stock.remove([id], "discarded");
    expect(value(core.data.removedPackages).find((candidate) => candidate.id === id)?.removal_reason).toBe("discarded");

    await core.stock.restore([id]);
    const restored = value(core.data.packages).find((candidate) => candidate.id === id);
    expect(restored?.removed_at).toBeNull();
    expect(restored?.removal_reason).toBeNull();
    await expectCoreError(core.stock.remove(["ZZZZZ"], "consumed"), "not_found");
  });

  it("übernimmt beim Wiederherstellen auf Wunsch die verdrängte Bearbeitung", async () => {
    const withEdit = mock();
    const target = value(withEdit.data.removedPackages).find((pkg) => pkg.displaced !== null);
    const wanted = target?.displaced?.changes.find((change) => change.field === "best_before")?.value;
    await withEdit.stock.restore([target?.id ?? ""], { apply_displaced: true });
    const applied = value(withEdit.data.packages).find((pkg) => pkg.id === target?.id);
    expect(applied?.best_before).toBe(wanted);
    expect(applied?.displaced).toBeNull();

    const without = mock();
    await without.stock.restore([target?.id ?? ""]);
    expect(value(without.data.packages).find((pkg) => pkg.id === target?.id)?.best_before).toBe(target?.best_before);
  });

  it("ändert nur die genannten Felder", async () => {
    const core = mock();
    const pkg = value(core.data.packages).find((candidate) => candidate.best_before !== null);
    const id = pkg?.id ?? "";

    await core.stock.update([id], { zone_id: ZONE_IDS.freezer });
    let current = value(core.data.packages).find((candidate) => candidate.id === id);
    expect(current?.zone_id).toBe(ZONE_IDS.freezer);
    expect(current?.best_before).toBe(pkg?.best_before);

    await core.stock.update([id], { best_before: null });
    current = value(core.data.packages).find((candidate) => candidate.id === id);
    expect(current?.best_before).toBeNull();
    expect(current?.zone_id).toBe(ZONE_IDS.freezer);
  });
});

describe("Produkte", () => {
  it("schlägt beim Scannen nach wie der Kern: gefunden, unbekannt, ausgelassen, abgeschaltet, ohne Server", async () => {
    const core = mock();
    // Die Attrappe findet Barcodes mit gerader Prüfziffer.
    expect(await core.products.lookup("96385074")).toEqual({
      barcode: "96385074",
      state: "found",
      name: "Beispielprodukt 5074",
      brand: "Beispielmarke",
      quantity: "500 g",
      image_id: expect.any(String),
    });
    expect(await core.products.lookup("4006381333931")).toMatchObject({ state: "not_found", name: "", image_id: null });
    expect(await core.products.lookup("2000000000015")).toMatchObject({ state: "skipped" });
    expect(await core.products.lookup("123")).toMatchObject({ state: "failed" });
    core.control.setLookupEnabled(false);
    expect(await core.products.lookup("96385074")).toMatchObject({ state: "disabled" });
    core.control.setLookupEnabled(true);
    core.control.setOnline(false);
    expect(await core.products.lookup("96385074")).toMatchObject({ state: "offline" });
    // Am Bestand ändert das Nachschlagen nichts.
    expect(await core.data.findProductByBarcode("96385074")).toBeUndefined();
  });

  it("meldet einen schon vergebenen Barcode mit dem Besitzer", async () => {
    const core = mock();
    const [first, second] = value(core.data.products);
    const error = await expectCoreError(core.products.addBarcode(second?.id ?? "", first?.barcodes[0] ?? ""), "barcode_taken");
    expect(error.details.product_id).toBe(first?.id);

    const fresh = sampleBarcode(700);
    await core.products.addBarcode(second?.id ?? "", fresh);
    expect((await core.data.findProductByBarcode(fresh))?.id).toBe(second?.id);
    await core.products.removeBarcode(second?.id ?? "", fresh);
    expect(await core.data.findProductByBarcode(fresh)).toBeUndefined();
  });

  it("führt zwei Produkte zusammen", async () => {
    const core = mock();
    const [target, source] = value(core.data.products);
    const moved = value(core.data.packages).filter((pkg) => pkg.product_id === source?.id).length;
    const before = value(core.data.packages).filter((pkg) => pkg.product_id === target?.id).length;
    expect(moved).toBeGreaterThan(0);

    await core.products.merge(source?.id ?? "", target?.id ?? "");
    expect(value(core.data.products).some((product) => product.id === source?.id)).toBe(false);
    expect(value(core.data.packages).filter((pkg) => pkg.product_id === target?.id)).toHaveLength(before + moved);
    expect((await core.data.findProductByBarcode(source?.barcodes[0] ?? ""))?.id).toBe(target?.id);
    // Wer noch die alte Kennung hat, landet beim Ziel
    expect((await core.data.findProduct(source?.id ?? ""))?.id).toBe(target?.id);
  });

  it("ändert nur die genannten Felder und erlaubt, die Vorlaufzeit zu löschen", async () => {
    const core = mock();
    const product = value(core.data.products).find((candidate) => candidate.warn_days !== null);
    await core.products.update(product?.id ?? "", { warn_days: null });
    const current = value(core.data.products).find((candidate) => candidate.id === product?.id);
    expect(current?.warn_days).toBeNull();
    expect(current?.name).toBe(product?.name);
    await expectCoreError(core.products.update(product?.id ?? "", { name: " " }), "invalid");
  });
});

describe("Zonen und Einstellungen", () => {
  it("legt Zonen hinten an und sortiert nach der Reihenfolge", async () => {
    const core = mock();
    const created = await core.zones.create({ name: "Garage", icon: "garage" });
    const zones = value(core.data.zones);
    expect(zones.at(-1)?.id).toBe(created.id);

    await core.zones.reorder([created.id, ...zones.slice(0, -1).map((zone) => zone.id)]);
    expect(value(core.data.zones)[0]?.id).toBe(created.id);
  });

  it("verschiebt beim Löschen die Packungen und die Primärzone", async () => {
    const core = mock();
    const inShelf = core.control.snapshot().packages.filter((pkg) => pkg.zone_id === ZONE_IDS.shelf).length;
    const inCellar = core.control.snapshot().packages.filter((pkg) => pkg.zone_id === ZONE_IDS.cellar).length;

    await expectCoreError(core.zones.remove(ZONE_IDS.shelf, ZONE_IDS.shelf), "invalid");
    await core.zones.remove(ZONE_IDS.shelf, ZONE_IDS.cellar);

    expect(value(core.data.zones).some((zone) => zone.id === ZONE_IDS.shelf)).toBe(false);
    expect(core.control.snapshot().packages.filter((pkg) => pkg.zone_id === ZONE_IDS.cellar)).toHaveLength(inShelf + inCellar);
    expect(value(core.data.settings).primary_zone_id).toBe(ZONE_IDS.cellar);
    expect(core.control.snapshot().zones.find((zone) => zone.id === ZONE_IDS.shelf)?.moved_to).toBe(ZONE_IDS.cellar);
  });

  it("lässt die letzte Zone nicht löschen", async () => {
    const core = mock({ scenarios: ["single-zone"] });
    expect(value(core.data.zones)).toHaveLength(1);
    await expectCoreError(core.zones.remove(ZONE_IDS.shelf, ZONE_IDS.cellar), "last_zone");
  });

  it("ändert Haushalts- und Geräte-Einstellungen", async () => {
    const core = mock();
    await core.settings.update({ zone_mode: "equal", warn_days: 7 });
    expect(value(core.data.settings)).toMatchObject({ zone_mode: "equal", warn_days: 7, trash_retention_days: 30 });
    await expectCoreError(core.settings.update({ trash_retention_days: 0 }), "invalid");

    await core.prefs.update({ scan_zone_id: ZONE_IDS.cellar });
    expect(value(core.prefs.value)).toMatchObject({ scan_zone_id: ZONE_IDS.cellar, print_labels: true });
  });

  it("zeigt in der Lösch-Historie weniger, wenn die Aufbewahrungsdauer sinkt", async () => {
    const core = mock();
    const before = value(core.data.removedPackages).length;
    await core.settings.update({ trash_retention_days: 2 });
    expect(value(core.data.removedPackages).length).toBeLessThan(before);
  });
});

describe("Sitzung und Sync", () => {
  it("meldet mit dem Haushalts-Passwort an", async () => {
    const core = mock({ scenarios: ["signed-out"] });
    expect(value(core.session.state)).toEqual({ status: "signed_out", reason: "never", last_device_name: null });
    await expectCoreError(core.session.login("falsch", "Handy"), "invalid_password");
    await expectCoreError(core.session.login(MOCK_PASSWORD, " "), "invalid");
    await core.session.login(MOCK_PASSWORD, "Handy Küche");
    expect(value(core.session.state)).toMatchObject({ status: "signed_in", device: { name: "Handy Küche" } });
  });

  it("verwirft ungesendete Änderungen beim Abmelden nur auf Wunsch", async () => {
    const core = mock({ scenarios: ["offline"] });
    const error = await expectCoreError(core.session.logout(), "pending_changes");
    expect(error.details.pending).toBe(4);
    await core.session.logout({ discard_pending: true });
    expect(value(core.session.state)).toMatchObject({ status: "signed_out", reason: "logout" });
  });

  it("sammelt Änderungen, solange der Server fehlt, und gleicht danach ab", async () => {
    const core = mock({ scenarios: ["offline"] });
    expect(value(core.sync.status)).toMatchObject({ online: false, phase: "error", pending: 4 });

    await core.zones.create({ name: "Garage" });
    expect(value(core.sync.status).pending).toBe(5);
    await expectCoreError(core.devices.list(), "offline");
    await expectCoreError(core.backup.run(), "offline");

    await core.sync.now();
    expect(value(core.sync.status)).toMatchObject({ online: false, phase: "error", pending: 5 });

    core.control.setOnline(true);
    expect(value(core.sync.status)).toMatchObject({ online: true, phase: "idle", pending: 0, last_error: null });
  });

  it("zeigt abgelehnte und verdrängte Änderungen, bis sie ausgeblendet werden", async () => {
    const core = mock({ scenarios: ["problems"] });
    const problems = value(core.sync.problems);
    expect(problems.map((problem) => problem.status).sort()).toEqual(["displaced", "rejected"]);
    await core.sync.dismissProblem(problems[0]?.id ?? "");
    expect(value(core.sync.problems)).toHaveLength(1);
  });

  it("meldet ein gesperrtes Token", () => {
    const core = mock();
    core.control.revoke();
    expect(value(core.session.state)).toMatchObject({ status: "signed_out", reason: "revoked" });
  });

  it("nennt nach dem Sperren und nach dem Abmelden den letzten Namen des Geräts", async () => {
    const core = mock();
    await core.devices.rename(DEVICE_IDS.current, "Handy Keller");
    core.control.revoke();
    expect(value(core.session.state)).toEqual({ status: "signed_out", reason: "revoked", last_device_name: "Handy Keller" });
    await core.session.login(MOCK_PASSWORD, "Handy Küche");
    await core.session.logout();
    expect(value(core.session.state)).toEqual({ status: "signed_out", reason: "logout", last_device_name: "Handy Küche" });
  });

  it("richtet sich danach, ob der Server Barcodes nachschlägt", async () => {
    const core = mock({ scenarios: ["no-lookup"] });
    const input = { zone_id: ZONE_IDS.shelf, best_before: null, count: 1 } as const;
    const off = await core.stock.store({ ...input, product: { kind: "barcode", barcode: sampleBarcode(520) } });
    expect(off.product.lookup).toBe("none");
    core.control.setLookupEnabled(true);
    const on = await core.stock.store({ ...input, product: { kind: "barcode", barcode: sampleBarcode(522) } });
    // Gerade Endziffer: Die Attrappe „findet" das Produkt samt Bild.
    expect(value(core.data.products).find((product) => product.id === on.product.id)).toMatchObject({ lookup: "found", image: expect.any(String) });
    expect(core.data.imageUrl(value(core.data.products).find((product) => product.id === on.product.id)?.image ?? "").startsWith("data:image/svg+xml,")).toBe(true);
  });

  it("hebt eine Bearbeitung an einer entnommenen Packung auf, statt sie anzuwenden", async () => {
    const core = mock();
    const [target] = value(core.data.packages).filter((pkg) => pkg.best_before !== null);
    const before = target?.best_before ?? null;
    const id = target?.id ?? "";
    await core.stock.remove([id], "consumed");
    await core.stock.update([id], { best_before: "2031-01-31" });

    // Löschen gewinnt: Das MHD bleibt, die Bearbeitung liegt an der Packung und unter den Sync-Problemen.
    const removed = await core.data.findPackage(id);
    expect(removed).toMatchObject({ best_before: before, displaced: { changes: [{ field: "best_before", value: "2031-01-31" }] } });
    expect(value(core.sync.problems)[0]).toMatchObject({ status: "displaced", command: { type: "package.update", package_id: id } });

    // Eine zweite Bearbeitung ersetzt je Feld die erste und lässt andere Felder stehen.
    await core.stock.update([id], { zone_id: ZONE_IDS.fridge });
    await core.stock.update([id], { best_before: null });
    expect((await core.data.findPackage(id))?.displaced?.changes).toEqual([
      { field: "zone_id", value: ZONE_IDS.fridge },
      { field: "best_before", value: null },
    ]);

    // Wiederherstellen ohne Übernahme: wie vor dem Entnehmen, und die Probleme erledigen sich von selbst.
    await core.stock.restore([id]);
    expect(await core.data.findPackage(id)).toMatchObject({ best_before: before, displaced: null, removed_at: null });
    expect(value(core.sync.problems).filter((problem) => problem.status === "displaced")).toEqual([]);

    // Mit Übernahme gilt die Bearbeitung.
    await core.stock.remove([id], "consumed");
    await core.stock.update([id], { best_before: "2031-02-28" });
    await core.stock.restore([id], { apply_displaced: true });
    expect(await core.data.findPackage(id)).toMatchObject({ best_before: "2031-02-28", displaced: null });
  });

  it("prüft Eingaben mit denselben Grenzen und Sätzen wie der Kern", async () => {
    const core = mock();
    const long = "x".repeat(LIMITS.product_name + 1);
    const message = async (action: Promise<unknown>) => (await expectCoreError(action, "invalid")).message;

    expect(await message(core.products.create({ name: long }))).toBe("Der Name ist zu lang (höchstens 120 Zeichen).");
    expect(await message(core.products.create({ name: "Reis", brand: "x".repeat(81) }))).toBe("Die Marke ist zu lang (höchstens 80 Zeichen).");
    expect(await message(core.products.create({ name: "Reis", barcodes: Array.from({ length: 21 }, (_, n) => sampleBarcode(600 + n)) }))).toBe(
      "Ein Produkt kann höchstens 20 Barcodes haben.",
    );
    expect(await message(core.zones.create({ name: "z".repeat(61) }))).toBe("Der Name ist zu lang (höchstens 60 Zeichen).");
    expect(await message(core.zones.create({ name: "Garage", icon: "" }))).toBe("Das Symbol der Zone ist ungültig.");
    expect(await message(core.settings.update({ trash_retention_days: 0 }))).toBe("Die Aufbewahrungsdauer muss zwischen 1 und 3650 Tagen liegen.");
    expect(await message(core.settings.update({ warn_days: 3651 }))).toBe("Die Vorlaufzeit muss zwischen 0 und 3650 Tagen liegen.");
    expect(await message(core.devices.rename(DEVICE_IDS.current, "g".repeat(61)))).toBe("Der Name des Geräts ist zu lang (höchstens 60 Zeichen).");
    expect(
      await message(core.printers.create({ name: "Flur", connection: "direct", direct: { urls: [], token: "t", printer: null } })),
    ).toBe("Die Angaben zum Druckdienst sind unvollständig.");
    const zone = { zone_id: ZONE_IDS.shelf, best_before: null } as const;
    expect(await message(core.stock.store({ ...zone, count: 51, product: { kind: "new", name: "Reis" } }))).toBe("Die Menge muss zwischen 1 und 50 liegen.");
    // Texte werden an den Rändern gekürzt, bevor sie gemessen werden.
    const trimmed = await core.products.create({ name: `  ${"y".repeat(LIMITS.product_name)}  ` });
    expect(trimmed.name).toHaveLength(LIMITS.product_name);
    // Stufe 2: Mindestbestand und Uhrzeit der Tagesnachricht.
    expect(await message(core.products.create({ name: "Milch", min_stock: 0 }))).toBe("Der Mindestbestand muss zwischen 1 und 999 Packungen liegen.");
    expect(await message(core.products.update(trimmed.id, { min_stock: 1000 }))).toBe("Der Mindestbestand muss zwischen 1 und 999 Packungen liegen.");
    expect(await message(core.settings.update({ notify_time: "7:00" }))).toBe("Die Uhrzeit muss als HH:MM angegeben sein, etwa 17:00.");
  });

  it("führt Mindestbestand und Uhrzeit der Tagesnachricht", async () => {
    const core = mock();
    const milk = await core.products.create({ name: "Milch", min_stock: 2 });
    expect(milk.min_stock).toBe(2);
    await core.products.update(milk.id, { min_stock: null });
    expect(value(core.data.products).find((product) => product.id === milk.id)?.min_stock).toBeNull();
    const cream = await core.products.create({ name: "Sahne", min_stock: 4 });
    await core.products.merge(cream.id, milk.id);
    // Wie im Server: Ein leerer Mindestbestand des Ziels übernimmt den der Quelle.
    expect(value(core.data.products).find((product) => product.id === milk.id)?.min_stock).toBe(4);
    expect(value(core.data.settings).notify_time).toBe("17:00");
    await core.settings.update({ notify_time: "18:15" });
    expect(value(core.data.settings).notify_time).toBe("18:15");
  });
});

describe("Drucker und Etiketten", () => {
  it("verwaltet Drucker und räumt Verweise beim Löschen auf", async () => {
    const core = mock();
    const created = await core.printers.create({
      name: "Flur",
      connection: "server",
      server: { driver: "brother_ql", model: "QL-820NWB", address: "tcp://192.168.1.60:9100", media: "62" },
    });
    expect(value(core.data.printers).map((printer) => printer.name)).toContain("Flur");
    await expectCoreError(
      core.printers.update(created.id, { direct: { urls: ["https://10.71.83.1:8443"], token: "t", printer: null } }),
      "invalid",
    );

    await core.printers.remove(PRINTER_IDS.cellar);
    expect(value(core.data.zones).every((zone) => zone.printer_id !== PRINTER_IDS.cellar)).toBe(true);
    await core.printers.remove(PRINTER_IDS.kitchen);
    expect(value(core.data.settings).default_printer_id).toBeNull();
  });

  it("führt Etiketten durch ihre Zustände", async () => {
    const core = mock();
    const pkg = value(core.data.packages)[0];
    // Der Drucker des Kellers hängt am Pi, und der ist von hier aus nicht erreichbar.
    const [job] = await core.print.requestPackageLabels([pkg?.id ?? ""], { printer_id: PRINTER_IDS.cellar });
    expect(job?.state).toBe("pending");
    const state = (id: string) => value(core.data.printJobs).find((candidate) => candidate.id === id)?.state;

    const blocked = await core.print.flush();
    expect(blocked).toMatchObject({ delivered: 0, problems: [{ printer_id: PRINTER_IDS.cellar, problem: "unreachable" }] });
    expect(blocked.pending).toBeGreaterThanOrEqual(1);
    expect(state(job?.id ?? "")).toBe("pending");

    // Im WLAN des Pi druckt die Attrappe von selbst, was dieses Gerät angefordert hat.
    core.control.setPiReachable(true);
    expect(state(job?.id ?? "")).toBe("printed");
    expect(value(core.data.printJobs).find((candidate) => candidate.id === job?.id)).toMatchObject({ printer_id: PRINTER_IDS.cellar });
    expect(await core.print.flush()).toEqual({ delivered: 0, pending: 0, problems: [] });
    core.control.setPiReachable(false);

    const unknown = value(core.data.printJobs).find((candidate) => candidate.state === "unknown");
    await core.print.resolveUnknown(unknown?.id ?? "", false);
    expect(state(unknown?.id ?? "")).toBe("failed");
    const retried = await core.print.retry(unknown?.id ?? "");
    expect(retried.id).not.toBe(unknown?.id);
    expect(retried.package_id).toBe(unknown?.package_id);
    expect(state(unknown?.id ?? "")).toBe("failed");

    await core.print.cancel(retried.id);
    expect(state(retried.id)).toBe("cancelled");
    await expectCoreError(core.print.cancel(retried.id), "invalid");

    const zoneJob = await core.print.requestZoneLabel(ZONE_IDS.cellar);
    expect(zoneJob).toMatchObject({ kind: "zone", zone_id: ZONE_IDS.cellar, package_id: null, state: "pending" });
  });

  it("druckt am Drucker des Servers von selbst und zeigt, wie es ausgeht", async () => {
    const core = mock();
    const state = (id: string) => value(core.data.printJobs).find((candidate) => candidate.id === id);

    // Die Zone „Vorratsregal" hat keinen eigenen Drucker: Es gilt der Standarddrucker am Server.
    const done = await core.print.requestZoneLabel(ZONE_IDS.shelf);
    expect(state(done.id)).toMatchObject({ state: "printed", printer_id: PRINTER_IDS.kitchen, error: null });
    expect((await core.print.image(done.id)).type).toBe("image/png");

    core.control.setPrintOutcome("failed");
    const failed = await core.print.requestZoneLabel(ZONE_IDS.shelf);
    expect(state(failed.id)).toMatchObject({ state: "failed", error: "no_media" });
    await expectCoreError(core.print.image(failed.id), "not_found");

    core.control.setPrintOutcome("unknown");
    const open = await core.print.requestZoneLabel(ZONE_IDS.shelf);
    expect(state(open.id)).toMatchObject({ state: "unknown" });
    await core.print.resolveUnknown(open.id, true);
    expect(state(open.id)).toMatchObject({ state: "printed" });

    // Ohne Server bleibt das Etikett ausstehend und wird gedruckt, sobald er wieder da ist.
    core.control.setPrintOutcome("printed");
    core.control.setOnline(false);
    const waiting = await core.print.requestZoneLabel(ZONE_IDS.shelf);
    expect(state(waiting.id)).toMatchObject({ state: "pending" });
    expect((await core.print.flush()).problems).toContainEqual(expect.objectContaining({ printer_id: PRINTER_IDS.kitchen, problem: "offline" }));
    core.control.setOnline(true);
    expect(state(waiting.id)).toMatchObject({ state: "printed" });
  });

  it("stellt nur eigene Etiketten zu und übernimmt fremde auf Wunsch", async () => {
    const core = mock({ scenarios: ["at-pi"] });
    const foreign = value(core.data.printJobs).find((job) => job.state === "pending" && job.device_id !== DEVICE_IDS.current);
    expect(foreign).toBeDefined();
    await core.print.flush();
    const state = (id: string) => value(core.data.printJobs).find((candidate) => candidate.id === id)?.state;
    // Die eigenen sind gedruckt, das fremde wartet weiter auf sein Gerät.
    expect(value(core.data.printJobs).filter((job) => job.state === "pending").map((job) => job.id)).toEqual([foreign?.id]);

    const own = await core.print.retry(foreign?.id ?? "");
    expect(state(foreign?.id ?? "")).toBe("cancelled");
    expect(own).toMatchObject({ package_id: foreign?.package_id, device_id: DEVICE_IDS.current });
    expect(state(own.id)).toBe("printed");
  });

  it("übergibt ausstehende Etiketten an die Seite des Druckdienstes", async () => {
    const core = mock();
    await expectCoreError(core.print.handoff(PRINTER_IDS.kitchen), "invalid");
    const { url, jobs } = await core.print.handoff(PRINTER_IDS.cellar);
    expect(url.startsWith("http://10.71.83.1:8080/p#")).toBe(true);
    expect(jobs).toHaveLength(2);
    expect(jobs.every((job) => job.state === "unknown" && job.error === "handoff")).toBe(true);
    await expectCoreError(core.print.handoff(PRINTER_IDS.cellar), "not_found");
  });

  it("meldet am Pi jeden Grund, den der Kern kennt, und lässt keinen Zwischenstand über einen Ausgang", async () => {
    const core = mock({ scenarios: ["at-pi"] });
    core.control.setPiProblem("permission");
    expect(await core.printers.probe(PRINTER_IDS.cellar)).toMatchObject({ reachable: false, problem: "permission" });
    const [job] = await core.print.requestPackageLabels([value(core.data.packages)[0]?.id ?? ""], { printer_id: PRINTER_IDS.cellar });
    expect(await core.print.flush()).toMatchObject({ delivered: 0, problems: [{ printer_id: PRINTER_IDS.cellar, problem: "permission" }] });
    core.control.setPiProblem("unknown_printer");
    expect(await core.printers.probe(PRINTER_IDS.cellar)).toMatchObject({ reachable: true, problem: "unknown_printer" });
    // Ohne Grund ist der Pi wieder da und druckt, was aussteht.
    core.control.setPiProblem(null);
    expect(value(core.data.printJobs).find((candidate) => candidate.id === job?.id)?.state).toBe("printed");

    // docs/sync-protokoll.md, 6.6: Ein Zwischenstand ändert kein Etikett mit Ausgang. Die Attrappe
    // druckt nur aus „queued"; ein gedrucktes Etikett bleibt gedruckt, auch nach einem neuen Versuch.
    expect(await core.print.flush()).toEqual({ delivered: 0, pending: 0, problems: [] });
    expect(value(core.data.printJobs).find((candidate) => candidate.id === job?.id)?.state).toBe("printed");
  });

  it("liefert eine Vorschau und den Zustand eines Druckers", async () => {
    const core = mock();
    const preview = await core.print.preview({ kind: "zone", zone_id: ZONE_IDS.cellar });
    expect(preview.type).toBe("image/png");
    expect(preview.size).toBeGreaterThan(1000);

    // Von hier aus ist der Pi nicht zu erreichen: Das steht im Ergebnis, der Aufruf wirft nicht.
    const before = value(core.data.printerStatus).find((status) => status.printer_id === PRINTER_IDS.cellar)?.observed_at;
    expect(await core.printers.probe(PRINTER_IDS.cellar)).toEqual({
      reachable: false,
      url: null,
      health: null,
      problem: "unreachable",
      error: "Der Druckdienst antwortet auf keiner Adresse.",
    });
    expect(value(core.data.printerStatus).find((status) => status.printer_id === PRINTER_IDS.cellar)?.observed_at).toBe(before);

    core.control.setPiReachable(true);
    const probe = await core.printers.probe(PRINTER_IDS.cellar);
    expect(probe).toMatchObject({ reachable: true, url: "https://10.71.83.1:8443", problem: null, error: null });
    expect(probe.health?.host?.temperature_c).toBeTypeOf("number");
    expect(value(core.data.printerStatus).find((status) => status.printer_id === PRINTER_IDS.cellar)?.observed_at).toBe(NOW.toISOString());

    // Der Drucker am Server heißt im Druckdienst wie seine Kennung.
    const kitchen = await core.printers.probe(PRINTER_IDS.kitchen);
    expect(kitchen).toMatchObject({ reachable: true, url: null, problem: null });
    expect(kitchen.health?.printers[0]?.name).toBe(PRINTER_IDS.kitchen);
    core.control.setOnline(false);
    expect(await core.printers.probe(PRINTER_IDS.kitchen)).toMatchObject({ reachable: false, problem: "offline" });
  });

  it("zählt ohne Server je direktem Drucker höchstens eine ungesendete Meldung seines Zustands", async () => {
    const core = mock({ scenarios: ["offline", "at-pi"] });
    // Die erste Abfrage meldet den Zustand (und der Pi druckt, was für ihn aussteht).
    expect(await core.printers.probe(PRINTER_IDS.cellar)).toMatchObject({ reachable: true });
    const afterFirst = value(core.sync.status).pending;
    // Jede weitere ersetzt nur die Meldung davor.
    for (let probe = 0; probe < 3; probe += 1) {
      expect(await core.printers.probe(PRINTER_IDS.cellar)).toMatchObject({ reachable: true });
    }
    expect(value(core.sync.status).pending).toBe(afterFirst);

    // Der Abgleich bringt sie zum Server; danach zählt die nächste wieder.
    core.control.setOnline(true);
    expect(value(core.sync.status).pending).toBe(0);
    core.control.setOnline(false);
    await core.printers.probe(PRINTER_IDS.cellar);
    await core.printers.probe(PRINTER_IDS.cellar);
    expect(value(core.sync.status).pending).toBe(1);
  });

  it("zeigt gestörte Drucker", async () => {
    const core = mock({ scenarios: ["printer-trouble", "at-pi"] });
    const pi = value(core.data.printerStatus).find((status) => status.printer_id === PRINTER_IDS.cellar);
    expect(pi).toMatchObject({ status: { ready: false, errors: ["no_media"] }, host: { storage_read_only: true, throttled: true } });
    const probe = await core.printers.probe(PRINTER_IDS.cellar);
    expect(probe.health?.printers[0]?.status.errors).toEqual(["no_media"]);
  });
});

describe("Ausgangslagen", () => {
  it("startet leer, mit einer Zone, mit wartendem Update oder unsicher", () => {
    const empty = mock({ scenarios: ["empty"] });
    expect(value(empty.data.packages)).toEqual([]);
    expect(value(empty.data.zones)).toHaveLength(1);

    expect(value(mock({ scenarios: ["update"] }).app.state).update_ready).toBe(true);
    expect(value(mock({ scenarios: ["insecure"] }).app.state).secure_context).toBe(false);
    expect(value(mock({ scenarios: ["revoked"] }).session.state)).toEqual({ status: "signed_out", reason: "revoked", last_device_name: "Dieses Gerät" });
    expect(value(mock({ scenarios: ["update-required"] }).app.state).update_required).toBe(true);
    expect(value(mock({ scenarios: ["ios"] }).app.state).manual_install).toBe("ios");
    expect(value(mock({ scenarios: ["no-lookup"] }).sync.status).lookup_enabled).toBe(false);
    expect(value(mock().sync.status).lookup_enabled).toBe(true);
  });

  it("hat einen großen Bestand zum Prüfen der Geschwindigkeit", () => {
    const large = mock({ scenarios: ["large"] });
    const packages = value(large.data.packages);
    expect(packages.length).toBeGreaterThan(1800);
    expect(packages.length).toBeLessThan(2400);
    expect(new Set(packages.map((pkg) => pkg.id)).size).toBe(packages.length);
    expect(value(large.data.products).length).toBeGreaterThan(300);
    const productIds = new Set(value(large.data.products).map((product) => product.id));
    expect(packages.every((pkg) => productIds.has(pkg.product_id) && isPackageId(pkg.id))).toBe(true);
  });

  it("nimmt eigene Daten an", () => {
    const today = todayLocal(NOW);
    const data = createSampleData(NOW);
    const core = mock({ data: { packages: data.packages.slice(0, 2).map((pkg) => ({ ...pkg, best_before: addDays(today, 1) })) } });
    expect(value(core.data.packages)).toHaveLength(2);
    expect(value(core.data.products).length).toBe(data.products.length);
  });

  it("startet Push in jedem Zustand, den der Kern kennt", () => {
    const cases: [MockScenario[], PushState][] = [
      [[], "off"],
      [["push-off"], "off"],
      [["push-on"], "on"],
      [["push-denied"], "denied"],
      [["push-not-configured"], "not_configured"],
      [["push-unsupported"], "unsupported"],
      // iPhone im Browser: erst installieren. Ohne HTTPS gibt es keinen Service Worker.
      [["ios"], "ios_install"],
      [["insecure"], "unsupported"],
      [["ios", "push-on"], "on"],
      [["push-rate-limited"], "on"],
    ];
    for (const [scenarios, state] of cases) {
      expect(value(mock({ scenarios }).push.state), scenarios.join(",")).toBe(state);
    }
  });
});

// ------------------------------------------------------------------------------------------
// Stufe 2
// ------------------------------------------------------------------------------------------

function productNamed(core: MockCore, name: string): Product {
  const product = value(core.data.products).find((candidate) => candidate.name === name);
  if (!product) {
    throw new Error(`Kein Produkt ${name}`);
  }
  return product;
}

function stockOf(core: MockCore, productId: string): string[] {
  return value(core.data.packages)
    .filter((pkg) => pkg.product_id === productId)
    .map((pkg) => pkg.id);
}

/** Alle Einträge der Einkaufsliste, auch erledigte und gelöschte. */
function allItems(core: MockCore): ShoppingItem[] {
  return core.control.snapshot().shoppingItems;
}

type ItemState = "open" | "done" | "deleted";

/** Die automatischen Einträge eines Produkts, wie sie stehen: offen, erledigt oder gelöscht. */
function autosOf(core: MockCore, productId: string): { quantity: number | null; state: ItemState }[] {
  return allItems(core)
    .filter((item) => item.product_id === productId && item.origin === "min_stock")
    .map((item): { quantity: number | null; state: ItemState } => ({ quantity: item.quantity, state: item.deleted_at !== null ? "deleted" : item.done_at !== null ? "done" : "open" }))
    .sort((a, b) => a.state.localeCompare(b.state) || (a.quantity ?? 0) - (b.quantity ?? 0));
}

describe("Einkaufsliste", () => {
  it("zeigt offene Einträge zuerst, die ältesten vorn, dann erledigte; Gelöschtes und Altes nicht", () => {
    const core = mock();
    const products = value(core.data.products);
    const title = (item: ShoppingItem) => shoppingItemTitle(item, products.find((product) => product.id === item.product_id));
    const items = value(core.data.shoppingItems);
    expect(items.map(title)).toEqual(["Olivenöl", "H-Milch 3,5 %", "Backpapier", "Kaffeebohnen", "Butter", "Spülmittel"]);
    expect(items.map((item) => item.done_at === null)).toEqual([true, true, true, true, false, false]);
    expect(items.filter((item) => item.origin === "min_stock").map(title)).toEqual(["H-Milch 3,5 %", "Butter"]);
    // In den Daten stehen auch der gelöschte und der alte erledigte Eintrag.
    expect(allItems(core)).toHaveLength(8);
  });

  it("hat Produkte unter dem Mindestbestand, eines davon mit automatischem Eintrag", () => {
    const data = createSampleData(NOW);
    const below = data.products
      .filter((product) => missingStock(product, stockCount(data.packages, product.id)) > 0)
      .map((product) => [product.name, missingStock(product, stockCount(data.packages, product.id))]);
    expect(below).toEqual([
      ["Butter", 1],
      ["H-Milch 3,5 %", 2],
    ]);
    expect(data.products.filter((product) => product.min_stock !== null)).toHaveLength(4);
  });

  it("legt eigene Einträge an, mit Produkt oder freiem Text, geprüft wie im Kern", async () => {
    const core = mock();
    const rice = productNamed(core, "Basmati Reis");
    const byProduct = await core.shopping.create({ product_id: rice.id, quantity: 2 });
    expect(byProduct).toMatchObject({ product_id: rice.id, text: "", quantity: 2, origin: "manual", done_at: null, deleted_at: null, created_at: NOW.toISOString() });
    const byText = await core.shopping.create({ text: "  Backpulver  " });
    expect(byText).toMatchObject({ product_id: null, text: "Backpulver", quantity: null });
    expect(value(core.data.shoppingItems).map((item) => item.id)).toEqual(expect.arrayContaining([byProduct.id, byText.id]));

    const message = async (action: Promise<unknown>) => (await expectCoreError(action, "invalid")).message;
    expect(await message(core.shopping.create({}))).toBe("Der Eintrag braucht einen Text.");
    expect(await message(core.shopping.create({ text: "   " }))).toBe("Der Eintrag braucht einen Text.");
    expect(await message(core.shopping.create({ product_id: rice.id, text: "Reis" }))).toBe("Ein Eintrag hat ein Produkt oder einen Text, nicht beides.");
    expect(await message(core.shopping.create({ text: "x".repeat(LIMITS.shopping_text + 1) }))).toBe("Der Text ist zu lang (höchstens 120 Zeichen).");
    expect(await message(core.shopping.create({ text: "Mehl", quantity: 0 }))).toBe("Die Menge muss zwischen 1 und 999 liegen.");
    await expectCoreError(core.shopping.create({ product_id: sampleUuid(2, 999) }), "not_found");

    // Ein zusammengeführtes Produkt: Der Eintrag gehört dem Ziel.
    const lentils = productNamed(core, "Rote Linsen");
    await core.products.merge(lentils.id, rice.id);
    expect((await core.shopping.create({ product_id: lentils.id })).product_id).toBe(rice.id);
  });

  it("hakt ab, öffnet wieder, ändert und löscht; ohne Wirkung entsteht kein Befehl", async () => {
    const core = mock({ scenarios: ["offline"] });
    const pending = () => value(core.sync.status).pending;
    const start = pending();
    const item = await core.shopping.create({ text: "Hefe" });
    await core.shopping.update(item.id, { done: true });
    expect(allItems(core).find((candidate) => candidate.id === item.id)?.done_at).toBe(NOW.toISOString());
    // Abhaken eines erledigten Eintrags und ein Aufruf ohne Felder bleiben ohne Wirkung.
    await core.shopping.update(item.id, { done: true });
    await core.shopping.update(item.id, {});
    await core.shopping.update(item.id, { done: false, text: " Trockenhefe ", quantity: 3 });
    expect(allItems(core).find((candidate) => candidate.id === item.id)).toMatchObject({ done_at: null, text: "Trockenhefe", quantity: 3 });
    await core.shopping.remove(item.id);
    await core.shopping.remove(item.id);
    expect(pending()).toBe(start + 4);
    expect(value(core.data.shoppingItems).some((candidate) => candidate.id === item.id)).toBe(false);
    await expectCoreError(core.shopping.update(item.id, { done: true }), "not_found");
    await expectCoreError(core.shopping.remove(sampleUuid(7, 999)), "not_found");
  });

  it("ändert Text nur ohne Produkt und die Menge nur bei eigenen Einträgen", async () => {
    const core = mock();
    const items = value(core.data.shoppingItems);
    const auto = items.find((item) => item.origin === "min_stock" && item.done_at === null);
    const oil = items.find((item) => item.origin === "manual" && item.product_id !== null);
    const text = items.find((item) => item.product_id === null && item.done_at === null);
    const message = async (action: Promise<unknown>) => (await expectCoreError(action, "invalid")).message;
    expect(await message(core.shopping.update(auto?.id ?? "", { quantity: 5 }))).toBe("Die Menge eines automatischen Eintrags führt der Server.");
    expect(await message(core.shopping.update(auto?.id ?? "", { text: "Milch" }))).toBe("Ein Eintrag mit Produkt trägt dessen Namen, keinen eigenen Text.");
    expect(await message(core.shopping.update(oil?.id ?? "", { text: "Öl" }))).toBe("Ein Eintrag mit Produkt trägt dessen Namen, keinen eigenen Text.");
    expect(await message(core.shopping.update(text?.id ?? "", { text: " " }))).toBe("Der Eintrag braucht einen Text.");
    await core.shopping.update(oil?.id ?? "", { quantity: null });
    expect(allItems(core).find((item) => item.id === oil?.id)?.quantity).toBeNull();
  });

  it("zeigt Erledigtes nur innerhalb der Aufbewahrungsdauer", async () => {
    const core = mock();
    const done = () => value(core.data.shoppingItems).filter((item) => item.done_at !== null).length;
    expect(done()).toBe(2);
    await core.settings.update({ trash_retention_days: 1 });
    expect(done()).toBe(1);
    await core.settings.update({ trash_retention_days: 60 });
    expect(done()).toBe(3);
  });
});

describe("Automatische Einträge (wie der Server, Protokoll 7.6)", () => {
  it("entstehen beim Entnehmen unter den Mindestbestand, zählen mit und verschwinden, wenn der Bestand reicht", async () => {
    const core = mock();
    const pasta = productNamed(core, "Spaghetti");
    const [a, b, c, d] = stockOf(core, pasta.id);
    await core.stock.remove([a ?? "", b ?? ""], "consumed");
    expect(autosOf(core, pasta.id)).toEqual([]);
    await core.stock.remove([c ?? ""], "consumed");
    expect(autosOf(core, pasta.id)).toEqual([{ quantity: 1, state: "open" }]);
    await core.stock.remove([d ?? ""], "discarded");
    expect(autosOf(core, pasta.id)).toEqual([{ quantity: 2, state: "open" }]);
    // Rückgängig zählt wieder mit, Einlagern auch.
    await core.stock.restore([d ?? ""]);
    expect(autosOf(core, pasta.id)).toEqual([{ quantity: 1, state: "open" }]);
    await core.stock.store({ product: { kind: "existing", product_id: pasta.id }, zone_id: ZONE_IDS.shelf, best_before: null, count: 1, labels: false });
    expect(autosOf(core, pasta.id)).toEqual([{ quantity: 1, state: "deleted" }]);
    expect(value(core.data.shoppingItems).some((item) => item.product_id === pasta.id)).toBe(false);
  });

  it("kommen ohne Server erst mit dem nächsten Abgleich", async () => {
    const core = mock({ scenarios: ["offline"] });
    const pasta = productNamed(core, "Spaghetti");
    await core.stock.remove(stockOf(core, pasta.id).slice(0, 3), "consumed");
    expect(autosOf(core, pasta.id)).toEqual([]);
    core.control.setOnline(true);
    expect(autosOf(core, pasta.id)).toEqual([{ quantity: 1, state: "open" }]);
  });

  it("kommen mit der Verzögerung der Attrappe", async () => {
    const core = createMockCore({ latency: 5, now: () => NOW });
    const pasta = productNamed(core, "Spaghetti");
    await core.stock.remove(stockOf(core, pasta.id).slice(0, 3), "consumed");
    expect(autosOf(core, pasta.id)).toEqual([]);
    await vi.waitFor(() => expect(autosOf(core, pasta.id)).toEqual([{ quantity: 1, state: "open" }]));
  });

  it("bleiben nach dem Abhaken weg, bis das Produkt eingelagert wird; Wiederöffnen hebt die Sperre auf", async () => {
    const core = mock();
    const butter = productNamed(core, "Butter");
    // Beispieldaten: Der automatische Eintrag ist abgehakt, Butter ist gesperrt.
    expect(autosOf(core, butter.id)).toEqual([{ quantity: 1, state: "done" }]);
    await core.stock.remove(stockOf(core, butter.id).slice(0, 1), "consumed");
    expect(autosOf(core, butter.id)).toEqual([{ quantity: 1, state: "done" }]);
    await core.stock.store({ product: { kind: "existing", product_id: butter.id }, zone_id: ZONE_IDS.fridge, best_before: null, count: 1, labels: false });
    expect(autosOf(core, butter.id)).toEqual([
      { quantity: 1, state: "done" },
      { quantity: 1, state: "open" },
    ]);
    const fresh = allItems(core).find((item) => item.product_id === butter.id && item.origin === "min_stock" && item.done_at === null);
    await core.shopping.update(fresh?.id ?? "", { done: true });
    await core.stock.remove(stockOf(core, butter.id).slice(0, 1), "consumed");
    expect(autosOf(core, butter.id).map((auto) => auto.state)).toEqual(["done", "done"]);
    // Wieder geöffnet folgt er dem Bestand: 3 minus 1.
    await core.shopping.update(fresh?.id ?? "", { done: false });
    expect(allItems(core).find((item) => item.id === fresh?.id)).toMatchObject({ done_at: null, quantity: 2 });
  });

  it("bleiben nach dem Löschen weg; ein anderer Mindestbestand hebt die Sperre auf, derselbe nicht", async () => {
    const core = mock();
    const milk = productNamed(core, "H-Milch 3,5 %");
    const auto = allItems(core).find((item) => item.product_id === milk.id && item.origin === "min_stock");
    await core.shopping.remove(auto?.id ?? "");
    await core.stock.remove(stockOf(core, milk.id).slice(0, 1), "consumed");
    expect(autosOf(core, milk.id)).toEqual([{ quantity: 2, state: "deleted" }]);
    await core.products.update(milk.id, { min_stock: 8 });
    expect(autosOf(core, milk.id)).toEqual([{ quantity: 2, state: "deleted" }]);
    await core.products.update(milk.id, { min_stock: 10 });
    expect(autosOf(core, milk.id)).toEqual([
      { quantity: 2, state: "deleted" },
      { quantity: 5, state: "open" },
    ]);
    // Ohne Mindestbestand verschwindet er.
    await core.products.update(milk.id, { min_stock: null });
    expect(autosOf(core, milk.id)).toEqual([
      { quantity: 2, state: "deleted" },
      { quantity: 5, state: "deleted" },
    ]);
  });

  it("erledigen eigene Einträge eines Produkts beim Einlagern, freie Texte nicht", async () => {
    const core = mock();
    const oil = productNamed(core, "Olivenöl");
    await core.stock.store({ product: { kind: "existing", product_id: oil.id }, zone_id: ZONE_IDS.shelf, best_before: null, count: 1, labels: false });
    const items = allItems(core);
    expect(items.find((item) => item.product_id === oil.id)).toMatchObject({ done_at: NOW.toISOString() });
    expect(items.filter((item) => item.product_id === null && item.done_at === null && item.deleted_at === null).map((item) => item.text)).toEqual(["Backpapier", "Kaffeebohnen"]);
  });

  it("wandern beim Zusammenführen mit; zwei offene automatische werden einer", async () => {
    let now = NOW;
    const core = mock({ now: () => now });
    const quark = await core.products.create({ name: "Quark", min_stock: 2 });
    // Eine Sekunde später: Der ältere automatische Eintrag (der von Quark) bleibt.
    now = new Date(NOW.getTime() + 1000);
    const skyr = await core.products.create({ name: "Skyr", min_stock: 1 });
    expect(autosOf(core, quark.id)).toEqual([{ quantity: 2, state: "open" }]);
    expect(autosOf(core, skyr.id)).toEqual([{ quantity: 1, state: "open" }]);
    const own = await core.shopping.create({ product_id: skyr.id });
    await core.products.merge(skyr.id, quark.id);
    expect(autosOf(core, quark.id)).toEqual([
      { quantity: 1, state: "deleted" },
      { quantity: 2, state: "open" },
    ]);
    expect(allItems(core).find((item) => item.id === own.id)?.product_id).toBe(quark.id);
    expect(allItems(core).some((item) => item.product_id === skyr.id)).toBe(false);
  });
});

describe("Push", () => {
  it("schaltet ein, schickt Testnachrichten und schaltet aus", async () => {
    let now = NOW;
    const core = mock({ now: () => now });
    expect(await core.push.enable()).toBe("on");
    expect(value(core.push.state)).toBe("on");
    expect(await core.push.test()).toEqual({ status: "sent", http_status: 201, message: "Der Push-Dienst hat die Nachricht angenommen." });
    // Wie der Server: höchstens eine Testnachricht je 10 Sekunden.
    expect((await expectCoreError(core.push.test(), "rate_limited")).details.retry_after_s).toBe(10);

    now = new Date(now.getTime() + 10_000);
    core.control.setPushTestResult("rejected");
    expect(await core.push.test()).toMatchObject({ status: "rejected", http_status: 403 });
    expect(value(core.push.state)).toBe("on");
    now = new Date(now.getTime() + 10_000);
    core.control.setPushTestResult("gone");
    expect((await core.push.test()).status).toBe("gone");
    expect(value(core.push.state)).toBe("off");
    now = new Date(now.getTime() + 10_000);
    await expectCoreError(core.push.test(), "not_found");

    expect(await core.push.enable()).toBe("on");
    await core.push.disable();
    expect(value(core.push.state)).toBe("off");
    await core.push.disable();
    expect(value(core.push.state)).toBe("off");
  });

  it("meldet eine verweigerte Erlaubnis, einen Server ohne Push und einen Browser ohne Push", async () => {
    expect(await mock({ scenarios: ["push-denied"] }).push.enable()).toBe("denied");
    const asked = mock();
    asked.control.setPushPermission("default");
    expect(await asked.push.enable()).toBe("off");
    asked.control.setPushPermission("denied");
    expect(await asked.push.enable()).toBe("denied");
    expect(value(asked.push.state)).toBe("denied");

    const notConfigured = mock({ scenarios: ["push-not-configured"] });
    await expectCoreError(notConfigured.push.enable(), "not_configured");
    await expectCoreError(notConfigured.push.test(), "not_configured");
    await expectCoreError(mock({ scenarios: ["push-unsupported"] }).push.enable(), "not_supported");
    await expectCoreError(mock({ scenarios: ["ios"] }).push.enable(), "not_supported");
  });

  it("braucht zum Einschalten und Testen den Server, zum Ausschalten nicht", async () => {
    const core = mock({ scenarios: ["offline"] });
    await expectCoreError(core.push.enable(), "offline");
    expect(value(core.push.state)).toBe("off");
    const on = mock({ scenarios: ["offline", "push-on"] });
    await expectCoreError(on.push.test(), "offline");
    await on.push.disable();
    expect(value(on.push.state)).toBe("off");
  });

  it("endet mit dem Abmelden", async () => {
    const core = mock({ scenarios: ["push-on"] });
    await core.session.logout();
    expect(value(core.push.state)).toBe("off");
  });
});

describe("Integrationen", () => {
  it("zeigen eine gelungene Sicherung, Home Assistant aus und Push", async () => {
    const status = await mock({ scenarios: ["push-on"] }).integrations.load();
    expect(status.timezone).toBe("Europe/Berlin");
    expect(status.backup).toMatchObject({ configured: true, problem: null, time: "03:30", last_error: null, warning: false });
    expect(status.backup.recipients.every((key) => /^age1.{4}….{4}$/.test(key))).toBe(true);
    // Heute um 03:30 in Berlin (02:30 UTC), der Dateiname nach derselben Uhr; die nächste morgen.
    expect(status.backup).toMatchObject({ last_ok_at: "2026-11-13T02:30:00.000Z", last_file: "stowly-2026-11-13-0330.sqlite3.gz.age", next_at: "2026-11-14T02:30:00.000Z" });
    expect(status.ha).toMatchObject({ configured: false, state: "off", linked: 0, sensor: false });
    expect(status.push).toMatchObject({ configured: true, this_device: true, subscriptions: 2, last_error: null });
    expect((await mock({ scenarios: ["push-not-configured"] }).integrations.load()).push).toMatchObject({ configured: false, subscriptions: 0 });
  });

  it("kennen eine Warnung und eine halb eingerichtete Sicherung", async () => {
    const warning = (await mock({ scenarios: ["backup-warning"] }).integrations.load()).backup;
    expect(warning).toMatchObject({ configured: true, warning: true, last_error: expect.any(String) });
    expect(warning).toMatchObject({ last_ok_at: "2026-11-10T02:30:00.000Z", last_file: "stowly-2026-11-10-0330.sqlite3.gz.age" });
    const problem = (await mock({ scenarios: ["backup-problem"] }).integrations.load()).backup;
    expect(problem).toMatchObject({ configured: false, problem: "Der Ordner für Sicherungen ist nicht beschreibbar (Benutzer 10001).", last_ok_at: null, files: [], warning: false });
  });

  it("brauchen den Server und lassen sich umstellen", async () => {
    await expectCoreError(mock({ scenarios: ["offline"] }).integrations.load(), "offline");
    const core = mock();
    core.control.setIntegrations({ timezone: "Europe/Vienna" });
    expect((await core.integrations.load()).timezone).toBe("Europe/Vienna");
    core.control.setIntegrations(null);
    expect((await core.integrations.load()).timezone).toBe("Europe/Berlin");
  });
});

// ------------------------------------------------------------------------------------------
// Stufe 2, Runde 2: Statistik, Home Assistant, Wartezeit der Testnachricht
// ------------------------------------------------------------------------------------------

/** Der Platzhalter im Kühlschrank (ohne Namen), einer der am häufigsten entsorgten. */
const PLACEHOLDER_ID = sampleUuid(2, 16);

describe("Statistik", () => {
  const PLACEHOLDER = PLACEHOLDER_ID;

  it("zählt ohne Zeitraum die 12 Monate bis zum laufenden, aus dem ganzen Verlauf, in der Zeitzone des Servers", async () => {
    const core = mock();
    const stats = await core.stats.load();
    expect(stats).toMatchObject({ start: "2025-12", end: "2026-11", timezone: "Europe/Berlin", consumed: 33, discarded: 18, discarded_share: 0.3529 });
    expect(stats.months.map((month) => [month.month, month.consumed, month.discarded])).toEqual([
      ["2025-12", 2, 1],
      ["2026-01", 2, 2],
      ["2026-02", 2, 2],
      ["2026-03", 2, 2],
      ["2026-04", 3, 1],
      ["2026-05", 2, 2],
      ["2026-06", 3, 1],
      ["2026-07", 3, 1],
      ["2026-08", 3, 2],
      ["2026-09", 5, 1],
      ["2026-10", 3, 2],
      ["2026-11", 3, 1],
    ]);
    // Meiste zuerst; bei Gleichstand nach Name, der Platzhalter ohne Namen zuletzt.
    expect(stats.top_discarded.map((product) => [product.name, product.discarded])).toEqual([
      ["H-Milch 3,5 %", 4],
      ["", 4],
      ["Butter", 3],
      ["Haferflocken", 2],
      ["Lachsfilet (TK)", 2],
      ["Apfelmus", 1],
      ["Erbsen (TK)", 1],
      ["Passierte Tomaten", 1],
    ]);
    const placeholder = core.control.snapshot().products.find((product) => product.id === PLACEHOLDER);
    expect(stats.top_discarded[1]).toEqual({ product_id: PLACEHOLDER, name: "", barcode: placeholder?.barcodes[0], discarded: 4 });
    expect(stats.zones.map((zone) => [zone.name, zone.consumed, zone.discarded])).toEqual([
      ["Vorratsregal", 13, 6],
      ["Keller", 16, 2],
      ["Kühlschrank", 1, 7],
      ["Gefrierschrank", 3, 3],
    ]);
    expect(stats.zones.map((zone) => zone.zone_id)).toEqual([ZONE_IDS.shelf, ZONE_IDS.cellar, ZONE_IDS.fridge, ZONE_IDS.freezer]);
    // Die Lösch-Historie zeigt davon nur die letzten 30 Tage.
    expect(value(core.data.removedPackages)).toHaveLength(5);
  });

  it("rechnet einen gewählten Zeitraum, auch jenseits der Aufbewahrungsdauer", async () => {
    const core = mock();
    const older = await core.stats.load({ start: "2025-10", end: "2025-11" });
    expect(older).toEqual({
      start: "2025-10",
      end: "2025-11",
      months: [
        { month: "2025-10", consumed: 3, discarded: 0 },
        { month: "2025-11", consumed: 2, discarded: 0 },
      ],
      consumed: 5,
      discarded: 0,
      discarded_share: 0,
      top_discarded: [],
      zones: [
        { zone_id: ZONE_IDS.shelf, name: "Vorratsregal", consumed: 3, discarded: 0 },
        { zone_id: ZONE_IDS.cellar, name: "Keller", consumed: 1, discarded: 0 },
        { zone_id: ZONE_IDS.fridge, name: "Kühlschrank", consumed: 1, discarded: 0 },
        { zone_id: ZONE_IDS.freezer, name: "Gefrierschrank", consumed: 0, discarded: 0 },
      ],
      timezone: "Europe/Berlin",
    });
    // Nur der Anfang: bis zum laufenden Monat. Nur das Ende: 12 Monate bis dahin.
    expect(await core.stats.load({ start: "2026-10" })).toMatchObject({ start: "2026-10", end: "2026-11", consumed: 6, discarded: 3, discarded_share: 0.3333 });
    const year = await core.stats.load({ end: "2026-06" });
    expect(year).toMatchObject({ start: "2025-07", end: "2026-06" });
    expect(year.months).toHaveLength(12);
    // Ein Monat allein, und genau 120 Monate gehen.
    expect((await core.stats.load({ start: "2026-11", end: "2026-11" })).months).toEqual([{ month: "2026-11", consumed: 3, discarded: 1 }]);
    expect((await core.stats.load({ start: "2016-12", end: "2026-11" })).months).toHaveLength(120);
  });

  it("weist einen ungültigen Zeitraum ab wie der Server und braucht den Server", async () => {
    const core = mock();
    const where = async (range: StatsRange) => {
      const error = await expectCoreError(core.stats.load(range), "invalid");
      expect(error.message).not.toBe("");
      return (error.details.errors as { loc: string[] }[])[0]?.loc;
    };
    expect(await where({ start: "2026-13" })).toEqual(["query", "start"]);
    expect(await where({ start: "0000-05", end: "0001-02" })).toEqual(["query", "start"]);
    expect(await where({ end: "26-11" })).toEqual(["query", "end"]);
    expect(await where({ end: "" })).toEqual(["query", "end"]);
    expect(await where({ start: "2026-12", end: "2026-11" })).toEqual(["query", "start"]);
    expect(await where({ start: "2016-11", end: "2026-11" })).toEqual(["query", "start"]);
    // Ohne Ende gilt der laufende Monat: Ein späterer Anfang liegt danach.
    expect(await where({ start: "2026-12" })).toEqual(["query", "start"]);
    // Sind beide falsch geschrieben, nennt der Fehler beide, mit dem Satz des Servers.
    const both = await expectCoreError(core.stats.load({ start: "2026-1", end: "2026/11" }), "invalid");
    expect(both.message).toBe("'start' muss ein Monat YYYY-MM sein (Jahre 0001 bis 9999).");
    expect((both.details.errors as { loc: string[] }[]).map((error) => error.loc)).toEqual([
      ["query", "start"],
      ["query", "end"],
    ]);

    await expectCoreError(mock({ scenarios: ["offline"] }).stats.load(), "offline");
    // Mit der Verzögerung der Attrappe: Fällt der Server unterwegs weg, fehlt die Antwort.
    const slow = createMockCore({ latency: 5, now: () => NOW });
    const pending = slow.stats.load();
    slow.control.setOnline(false);
    await expectCoreError(pending, "offline");
  });

  it("folgt Entnehmen, Rückgängig, geändertem Grund, Zusammenführen und gelöschten Zonen; Versehen zählen nie", async () => {
    const core = mock();
    const before = await core.stats.load();
    const zoneOf = (stats: typeof before, id: string) => stats.zones.find((zone) => zone.zone_id === id);
    const rice = productNamed(core, "Basmati Reis");
    const [a = "", b = "", c = ""] = stockOf(core, rice.id);
    await core.stock.remove([a, b], "discarded");
    await core.stock.remove([c], "mistake");
    let stats = await core.stats.load();
    expect(stats).toMatchObject({ consumed: before.consumed, discarded: before.discarded + 2 });
    expect(stats.top_discarded.find((product) => product.product_id === rice.id)?.discarded).toBe(2);

    // Rückgängig und ein nachträglich geänderter Grund: Es zählt der heutige Stand jeder Packung.
    await core.stock.restore([a]);
    await core.stock.remove([b], "consumed");
    stats = await core.stats.load();
    expect(stats).toMatchObject({ consumed: before.consumed + 1, discarded: before.discarded });
    expect(stats.months.at(-1)?.consumed).toBe((before.months.at(-1)?.consumed ?? 0) + 1);
    expect(stats.top_discarded.some((product) => product.product_id === rice.id)).toBe(false);

    // Zusammengeführt: Die entsorgten Packungen des Platzhalters zählen bei H-Milch.
    const milk = productNamed(core, "H-Milch 3,5 %");
    await core.products.merge(PLACEHOLDER, milk.id);
    stats = await core.stats.load();
    expect(stats.top_discarded[0]).toMatchObject({ product_id: milk.id, name: "H-Milch 3,5 %", discarded: 8 });
    expect(stats.top_discarded.some((product) => product.product_id === PLACEHOLDER)).toBe(false);

    // Eine gelöschte Zone fehlt; ihre Packungen zählen bei der Zone, in die sie gewandert sind.
    await core.zones.remove(ZONE_IDS.fridge, ZONE_IDS.cellar);
    stats = await core.stats.load();
    expect(stats.zones.map((zone) => zone.name)).toEqual(["Vorratsregal", "Keller", "Gefrierschrank"]);
    expect(zoneOf(stats, ZONE_IDS.cellar)).toMatchObject({
      consumed: (zoneOf(before, ZONE_IDS.cellar)?.consumed ?? 0) + 1 + (zoneOf(before, ZONE_IDS.fridge)?.consumed ?? 0),
      discarded: (zoneOf(before, ZONE_IDS.cellar)?.discarded ?? 0) + (zoneOf(before, ZONE_IDS.fridge)?.discarded ?? 0),
    });
  });

  it("zählt jeden Monat in der Zeitzone des Servers", async () => {
    const data = createSampleData(NOW);
    const late = "2026-10-31T23:30:00.000Z";
    const pkg: Package = {
      id: samplePackageId(999),
      product_id: data.products[0]?.id ?? "",
      zone_id: ZONE_IDS.cellar,
      best_before: null,
      created_at: "2026-10-20T10:00:00.000Z",
      updated_at: late,
      removed_at: late,
      removal_reason: "consumed",
      displaced: null,
    };
    const core = mock({ data: { packages: [pkg] } });
    // In Berlin ist es schon der 1. November, 00:30.
    expect((await core.stats.load()).months.slice(-2)).toEqual([
      { month: "2026-10", consumed: 0, discarded: 0 },
      { month: "2026-11", consumed: 1, discarded: 0 },
    ]);
    core.control.setIntegrations({ timezone: "America/New_York" });
    const stats = await core.stats.load();
    expect(stats.timezone).toBe("America/New_York");
    expect(stats.months.slice(-2)).toEqual([
      { month: "2026-10", consumed: 1, discarded: 0 },
      { month: "2026-11", consumed: 0, discarded: 0 },
    ]);
  });

  it("beginnt mit stats-empty leer und zählt, was danach entnommen wird", async () => {
    const core = mock({ scenarios: ["stats-empty"] });
    const empty = await core.stats.load();
    expect(empty).toMatchObject({ start: "2025-12", end: "2026-11", consumed: 0, discarded: 0, discarded_share: null, top_discarded: [] });
    expect(empty.months).toHaveLength(12);
    expect(empty.months.every((month) => month.consumed === 0 && month.discarded === 0)).toBe(true);
    expect(empty.zones.map((zone) => [zone.name, zone.consumed, zone.discarded])).toEqual([
      ["Vorratsregal", 0, 0],
      ["Keller", 0, 0],
      ["Kühlschrank", 0, 0],
      ["Gefrierschrank", 0, 0],
    ]);
    // Bestand und Lösch-Historie bleiben, wie sie sind.
    expect(value(core.data.removedPackages)).toHaveLength(5);
    const [first] = value(core.data.packages);
    await core.stock.remove([first?.id ?? ""], "discarded");
    expect(await core.stats.load()).toMatchObject({ consumed: 0, discarded: 1, discarded_share: 1 });

    // Ein frischer Haushalt hat ebenfalls nichts, mit seiner einen Zone.
    expect((await mock({ scenarios: ["empty"] }).stats.load()).zones).toEqual([{ zone_id: ZONE_IDS.shelf, name: "Vorrat", consumed: 0, discarded: 0 }]);
  });
});

describe("Home Assistant", () => {
  const OFF: HaStatus = { configured: false, problem: null, entity: null, state: "off", last_ok_at: null, last_error: null, last_error_at: null, linked: 0, sensor: false };

  it("zeigt jeden Zustand einer Ausgangslage; ohne Angabe ist es aus", async () => {
    const ha = async (scenarios: MockScenario[]) => (await mock({ scenarios }).integrations.load()).ha;
    expect(await ha([])).toEqual(OFF);
    // Die Beispieldaten haben vier offene Einträge mit Namen, alle älter als zwei Minuten.
    expect(await ha(["ha-ok"])).toEqual({ ...OFF, configured: true, entity: "todo.einkaufsliste", state: "ok", last_ok_at: "2026-11-13T09:59:00.000Z", linked: 4, sensor: true });
    expect(await ha(["ha-pending"])).toEqual({ ...OFF, configured: true, entity: "todo.einkaufsliste", state: "pending", linked: 4, sensor: true });
    expect(await ha(["ha-unreachable"])).toEqual({
      ...OFF,
      configured: true,
      entity: "todo.einkaufsliste",
      state: "unreachable",
      last_ok_at: "2026-11-13T07:00:00.000Z",
      last_error: "Home Assistant ist nicht erreichbar.",
      last_error_at: "2026-11-13T09:59:00.000Z",
      linked: 4,
      sensor: true,
    });
    expect(await ha(["ha-unauthorized"])).toMatchObject({ configured: true, state: "unauthorized", last_error: "Home Assistant lehnt den Token ab." });
    expect(await ha(["ha-problem"])).toEqual({ ...OFF, problem: "STOWLY_HA_TOKEN fehlt.", entity: "todo.einkaufsliste" });
  });

  it("setzt jeden Zustand mit dem Satz des Servers und kehrt zur Ausgangslage zurück", async () => {
    const core = mock({ scenarios: ["ha-ok"] });
    const messages: Record<HaState, string | null> = {
      off: null,
      pending: null,
      ok: null,
      unauthorized: "Home Assistant lehnt den Token ab.",
      not_found: "Die Liste todo.einkaufsliste gibt es in Home Assistant nicht.",
      unavailable: "Die Liste ist in Home Assistant gerade nicht verfügbar.",
      unreachable: "Home Assistant ist nicht erreichbar.",
      error: "Home Assistant antwortet mit 500.",
    };
    for (const [state, message] of Object.entries(messages) as [HaState, string | null][]) {
      core.control.setHaState(state);
      const ha = (await core.integrations.load()).ha;
      expect(ha, state).toMatchObject({ state, configured: state !== "off", sensor: state !== "off", last_error: message, last_error_at: message === null ? null : expect.any(String) });
    }
    core.control.setHaState("off");
    expect((await core.integrations.load()).ha).toEqual(OFF);

    // setIntegrations ersetzt das Ganze; setHaState gilt danach wieder; null führt zur Ausgangslage.
    core.control.setIntegrations({ ha: { ...OFF, problem: "STOWLY_HA_URL fehlt." } });
    expect((await core.integrations.load()).ha.problem).toBe("STOWLY_HA_URL fehlt.");
    core.control.setHaState("unavailable");
    expect((await core.integrations.load()).ha).toMatchObject({ state: "unavailable", problem: null });
    core.control.setIntegrations(null);
    expect((await core.integrations.load()).ha).toMatchObject({ state: "ok", last_error: null });
  });

  it("zählt als verbunden, was nach der Regel des Servers in Bring! stünde", async () => {
    let now = NOW;
    const core = mock({ scenarios: ["ha-ok"], now: () => now });
    const linked = async () => (await core.integrations.load()).ha.linked;
    expect(await linked()).toBe(4);
    const yeast = await core.shopping.create({ text: "Hefe" });
    // Erst nach zwei Minuten offen geht ein Eintrag nach Bring!.
    expect(await linked()).toBe(4);
    now = new Date(NOW.getTime() + 120_000);
    expect(await linked()).toBe(5);
    await core.shopping.update(yeast.id, { done: true });
    expect(await linked()).toBe(4);
    // Ein Platzhalter ohne Namen geht erst mit Namen nach Bring!.
    await core.shopping.create({ product_id: PLACEHOLDER_ID });
    now = new Date(NOW.getTime() + 300_000);
    expect(await linked()).toBe(4);
    await core.products.update(PLACEHOLDER_ID, { name: "Ziegenkäse" });
    expect(await linked()).toBe(5);
  });
});

describe("Wartezeit der Testnachricht", () => {
  it("lässt mit push-rate-limited die nächste Testnachricht warten, gleich wann sie kommt; danach geht es wieder", async () => {
    let now = NOW;
    const core = mock({ scenarios: ["push-rate-limited"], now: () => now });
    expect(value(core.push.state)).toBe("on");
    expect((await core.integrations.load()).push).toMatchObject({ configured: true, this_device: true });
    now = new Date(NOW.getTime() + 60_000);
    expect((await expectCoreError(core.push.test(), "rate_limited")).details.retry_after_s).toBe(7);
    // Nach der Uhr der Attrappe: sechs Sekunden später fehlt noch eine.
    now = new Date(now.getTime() + 6_000);
    expect((await expectCoreError(core.push.test(), "rate_limited")).details.retry_after_s).toBe(1);
    now = new Date(now.getTime() + 1_000);
    expect(await core.push.test()).toEqual({ status: "sent", http_status: 201, message: "Der Push-Dienst hat die Nachricht angenommen." });
    // Danach gilt die Regel wie sonst.
    expect((await expectCoreError(core.push.test(), "rate_limited")).details.retry_after_s).toBe(10);
  });
});

describe("Updates über GitHub", () => {
  it("zeigt je Ausgangslage, was der Server weiß; ohne Angabe eingerichtet und aktuell", async () => {
    const update = async (scenarios: MockScenario[]) => (await mock({ scenarios }).integrations.load()).update;
    expect(await update([])).toMatchObject({
      configured: true,
      repo: "beispiel/stowly",
      current: "0.1.0",
      latest: "0.1.0",
      available: false,
      checked_at: "2026-11-13T08:00:00.000Z",
      check_error: null,
      updater_ready: true,
      state: "idle",
      state_message: null,
    });
    const fresh = await update(["release-new"]);
    expect(fresh).toMatchObject({ latest: "0.2.0", available: true, updater_ready: true, url: "https://github.com/beispiel/stowly/releases/tag/v0.2.0" });
    expect(fresh.notes).toContain("\n- Updates lassen sich in den Einstellungen suchen und installieren.");
    expect(await update(["release-no-updater"])).toMatchObject({ latest: "0.2.0", available: true, updater_ready: false, updater_seen_at: "2026-11-10T10:00:00.000Z" });
    expect(await update(["release-off"])).toMatchObject({ configured: false, repo: null, current: "0.1.0", latest: null, updater_ready: false });
    // Dieselbe Version meldet der Abgleich.
    expect(value(mock().sync.status).server_version).toBe("0.1.0");
  });

  it("sucht höchstens einmal je Minute und braucht den Server", async () => {
    let now = NOW;
    const core = mock({ now: () => now });
    expect(await core.update.check()).toMatchObject({ checked_at: NOW.toISOString(), check_error: null, available: false });
    expect((await expectCoreError(core.update.check(), "rate_limited")).details.retry_after_s).toBe(60);
    now = new Date(NOW.getTime() + 59_500);
    expect((await expectCoreError(core.update.check(), "rate_limited")).details.retry_after_s).toBe(1);
    now = new Date(NOW.getTime() + 60_000);
    expect((await core.update.check()).checked_at).toBe(now.toISOString());
    expect((await core.integrations.load()).update.checked_at).toBe(now.toISOString());

    await expectCoreError(mock({ scenarios: ["offline"] }).update.check(), "offline");
    const off = await expectCoreError(mock({ scenarios: ["release-off"] }).update.check(), "not_configured");
    expect(off.message).toBe("Updates sind auf diesem Server aus. Einschalten unter Einstellungen → Aktualisierung.");
  });

  it("fordert an, prüft dabei wie der Server, und die Anforderung bleibt ohne Wartezeit stehen", async () => {
    const core = mock({ scenarios: ["release-new"] });
    await expectCoreError(core.update.install("v0.2.0"), "invalid");
    expect((await expectCoreError(core.update.install("0.1.0"), "conflict")).message).toBe("Das ist nicht die neueste bekannte Version. Bitte erst nach Updates suchen.");
    expect(await core.update.install("0.2.0")).toMatchObject({ state: "requested", state_version: "0.2.0", state_at: NOW.toISOString(), state_message: null });
    expect((await expectCoreError(core.update.install("0.2.0"), "conflict")).message).toBe("Ein Update ist schon angefordert.");
    expect((await core.integrations.load()).update.state).toBe("requested");
    // Ohne Wartezeit spielt die Attrappe den Updater nicht nach: Der Abgleich bleibt erreichbar.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(value(core.sync.status).online).toBe(true);
    expect((await core.integrations.load()).update.state).toBe("requested");

    const silent = await expectCoreError(mock({ scenarios: ["release-no-updater"] }).update.install("0.2.0"), "not_configured");
    expect(silent.message).toBe("Der Updater auf dem Rechner meldet sich nicht (docs/betrieb.md, Abschnitt 9).");
    expect((await expectCoreError(mock().update.install("0.1.0"), "conflict")).message).toBe("Diese Version ist schon installiert.");
    await expectCoreError(mock({ scenarios: ["release-off"] }).update.install("0.2.0"), "not_configured");
    await expectCoreError(mock({ scenarios: ["release-new", "offline"] }).update.install("0.2.0"), "offline");
  });

  it("spielt mit Wartezeit den Updater nach: Er beginnt, der Server startet neu, dann läuft die neue Version", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const core = createMockCore({ latency: 10, now: () => NOW, scenarios: ["release-new"] });
      const requested = core.update.install("0.2.0");
      await vi.advanceTimersByTimeAsync(5);
      expect((await requested).state).toBe("requested");
      await vi.advanceTimersByTimeAsync(80);
      const installing = core.integrations.load();
      await vi.advanceTimersByTimeAsync(5);
      expect((await installing).update.state).toBe("installing");
      await vi.advanceTimersByTimeAsync(80);
      // Stowly ist angehalten: Der Server antwortet nicht.
      expect(value(core.sync.status).online).toBe(false);
      await vi.advanceTimersByTimeAsync(240);
      expect(value(core.sync.status)).toMatchObject({ online: true, server_version: "0.2.0" });
      const done = core.integrations.load();
      await vi.advanceTimersByTimeAsync(5);
      expect((await done).update).toMatchObject({ state: "done", state_version: "0.2.0", current: "0.2.0", available: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("lässt sich über setIntegrations setzen; damit arbeiten Suchen und Anfordern weiter", async () => {
    const core = mock();
    const before = (await core.integrations.load()).update;
    core.control.setIntegrations({ update: { ...before, latest: "0.3.0", available: true, state: "failed", state_version: "0.3.0", state_message: "Die neue Version startete nicht, zurück auf 0.1.0." } });
    expect((await core.integrations.load()).update).toMatchObject({ state: "failed", latest: "0.3.0" });
    // Nach einem gescheiterten Update geht ein neuer Versuch.
    expect((await core.update.install("0.3.0")).state).toBe("requested");
    core.control.setIntegrations({ timezone: "Europe/Vienna" });
    expect((await core.integrations.load()).update.state).toBe("requested");
    core.control.setIntegrations(null);
    expect((await core.integrations.load()).update).toEqual(before);
  });
});

describe("Einrichtung (docs/sync-protokoll.md, 11.6 bis 11.8)", () => {
  it("ist ohne Ausgangslage abgeschlossen; die Ausgangslagen zeigen die anderen Fälle", async () => {
    const finished = await mock().setup.load();
    expect(finished.finished_at).not.toBeNull();
    expect(finished.password_source).toBe("app");
    // Die Schritte von Stufe B kamen nach dem Abschluss dazu: unmarkiert; die Sicherung aus der Umgebung ist trotzdem erledigt.
    expect(finished.steps.map((step) => [step.id, step.state, step.ready])).toEqual([
      ["https", "done", true],
      ["printer", "done", true],
      ["backup", "open", true],
      ["updates", "done", true],
      ["notifications", "done", true],
      ["home_assistant", "open", false],
    ]);
    expect(finished.https).toMatchObject({ enabled: true, port: 8443, http_port: 8010, origins: ["https://192.168.1.10:8443"], ca: { name: "Stowly CA 3F2A1C" } });

    const open = mock({ scenarios: ["setup-open"] });
    const status = await open.setup.load();
    expect(status.finished_at).toBeNull();
    expect(status.steps.map((step) => [step.id, step.state, step.ready])).toEqual([
      ["https", "open", false],
      ["printer", "open", true],
      ["backup", "open", false],
      ["updates", "open", false],
      ["notifications", "open", false],
      ["home_assistant", "open", false],
    ]);
    expect(value(open.push.state)).toBe("not_configured");
    expect((await open.serverConfig.load()).update).toEqual({ enabled: false, repo: "beispiel/stowly", source: "default", available: true });
    expect((await open.integrations.load()).update).toMatchObject({ configured: false, updater_ready: false, updater_command: expect.stringContaining("python -m stowly.updater") });

    const env = mock({ scenarios: ["setup-env"] });
    expect((await env.setup.load()).password_source).toBe("env");
    expect(await env.serverConfig.load()).toMatchObject({
      push: { contact: "mailto:haushalt@example.org", source: "env" },
      update: { enabled: true, repo: "beispiel/stowly", source: "env", available: false },
    });

    expect((await mock({ scenarios: ["no-https"] }).setup.load()).https).toMatchObject({ enabled: false, listening: false, port: null, ca: null, origins: [] });
  });

  it("beginnt mit unconfigured ohne Passwort und legt das erste fest; ein zweites gibt conflict", async () => {
    const core = mock({ scenarios: ["unconfigured"] });
    expect(value(core.session.state)).toEqual({ status: "signed_out", reason: "never", last_device_name: null });
    expect(value(core.sync.status).server_configured).toBe(false);
    expect(value(core.data.packages)).toEqual([]);
    await expectCoreError(core.session.login(MOCK_PASSWORD, "Handy"), "not_configured");
    await expectCoreError(core.session.createPassword("kurz", "Handy"), "invalid");

    await core.session.createPassword("ein langes Passwort", "Rechner");
    expect(value(core.session.state)).toMatchObject({ status: "signed_in", device: { name: "Rechner" } });
    expect(value(core.sync.status).server_configured).toBe(true);
    expect((await core.setup.load()).finished_at).toBeNull();

    await core.session.logout({ discard_pending: true });
    await expectCoreError(core.session.createPassword("noch ein Passwort", "Flur"), "conflict");
    await expectCoreError(core.session.login(MOCK_PASSWORD, "Flur"), "invalid_password");
    await core.session.login("ein langes Passwort", "Flur");
  });

  it("ändert das Passwort; ein falsches bisheriges meldet nicht ab, eines aus der Umgebung lässt sich nicht ändern", async () => {
    const core = mock();
    await expectCoreError(core.session.changePassword("falsch", "ein neues Passwort"), "invalid_password");
    expect(value(core.session.state).status).toBe("signed_in");
    await expectCoreError(core.session.changePassword(MOCK_PASSWORD, "kurz"), "invalid");
    await core.session.changePassword(MOCK_PASSWORD, "ein neues Passwort");
    await core.session.logout();
    await expectCoreError(core.session.login(MOCK_PASSWORD, "Handy"), "invalid_password");
    await core.session.login("ein neues Passwort", "Handy");

    await expectCoreError(mock({ scenarios: ["setup-env"] }).session.changePassword(MOCK_PASSWORD, "ein neues Passwort"), "conflict");
    await expectCoreError(mock({ scenarios: ["offline"] }).session.changePassword(MOCK_PASSWORD, "ein neues Passwort"), "offline");
  });

  it("markiert Schritte, schließt ab und trägt Port und Adressen ein", async () => {
    const core = mock({ scenarios: ["setup-open"] });
    expect((await core.setup.update({ step: { id: "https", state: "skipped" } })).steps[0]).toMatchObject({ id: "https", state: "skipped", changed_at: NOW.toISOString() });
    expect((await core.setup.update({ finished: true })).finished_at).toBe(NOW.toISOString());
    expect((await core.setup.update({ finished: false })).finished_at).toBeNull();
    const moved = await core.setup.update({ https_port: 8444, addresses: ["nas.fritz.box"] });
    expect(moved.https).toMatchObject({ port: 8444, port_source: "manual", origins: ["https://192.168.1.10:8444", "https://nas.fritz.box:8444"] });
    const error = await expectCoreError(core.setup.update({ addresses: ["example.org"] }), "invalid");
    expect(error.details.errors).toEqual([{ loc: ["body", "addresses", 0], msg: "Die Adresse liegt nicht im Heimnetz.", type: "value_error" }]);
    expect((await core.setup.update({ https_port: null })).https).toMatchObject({ port: 8443, port_source: "default" });
    await expectCoreError(mock({ scenarios: ["offline"] }).setup.load(), "offline");
  });

  it("prüft das Vertrauen nach setSecureTrusted", async () => {
    const core = mock();
    expect(await core.setup.reachesSecurely("https://192.168.1.10:8443")).toBe(false);
    core.control.setSecureTrusted(true);
    expect(await core.setup.reachesSecurely("https://192.168.1.10:8443")).toBe(true);
    const off = mock({ scenarios: ["no-https"] });
    off.control.setSecureTrusted(true);
    expect(await off.setup.reachesSecurely("https://192.168.1.10:8443")).toBe(false);
  });

  it("setzt den Kontakt für Push: Push folgt ihm; die Umgebung geht vor", async () => {
    const core = mock({ scenarios: ["setup-open"] });
    expect(value(core.push.state)).toBe("not_configured");
    await expectCoreError(core.serverConfig.update({ push_contact: "kein Kontakt" }), "invalid");
    expect((await core.serverConfig.update({ push_contact: "haushalt@example.org" })).push).toEqual({ contact: "mailto:haushalt@example.org", source: "app" });
    expect(value(core.push.state)).toBe("off");
    expect((await core.integrations.load()).push.configured).toBe(true);
    expect((await core.setup.load()).steps.find((step) => step.id === "notifications")?.ready).toBe(true);
    await core.serverConfig.update({ push_contact: null });
    expect(value(core.push.state)).toBe("not_configured");

    const env = mock({ scenarios: ["setup-env"] });
    await expectCoreError(env.serverConfig.update({ push_contact: "haushalt@example.org" }), "conflict");
    await expectCoreError(env.serverConfig.update({ update_enabled: false }), "conflict");
  });

  it("schaltet Updates mit dem Schalter der App", async () => {
    const core = mock({ scenarios: ["release-off"] });
    expect((await core.serverConfig.load()).update).toEqual({ enabled: false, repo: "beispiel/stowly", source: "default", available: true });
    await expectCoreError(core.update.check(), "not_configured");
    expect((await core.serverConfig.update({ update_enabled: true })).update).toEqual({ enabled: true, repo: "beispiel/stowly", source: "app", available: true });
    expect((await core.integrations.load()).update).toMatchObject({ configured: true, repo: "beispiel/stowly" });
    expect((await core.update.check()).checked_at).toBe(NOW.toISOString());
  });

  it("koppelt einen Pi: Code und Befehl, Stand, Abschluss, Ablauf, Abbruch", async () => {
    const core = mock({ scenarios: ["empty"] });
    const created = await core.printers.pair({ origin: "http://192.168.1.10:8010" });
    expect(created).toMatchObject({ state: "waiting", printer_id: null, pi: null });
    expect(created.command).toBe(`curl -fsSL http://192.168.1.10:8010/api/pi/install.sh | sudo sh -s -- ${created.code ?? ""}`);
    expect(await core.printers.pairing(created.id)).toMatchObject({ state: "waiting", code: null, command: null });

    core.control.completePairing();
    const paired = await core.printers.pairing(created.id);
    expect(paired).toMatchObject({ state: "paired", pi: { hostname: "stowly-pi", addresses: ["192.168.1.20"], model: "QL-570", printer_found: true } });
    const printer = value(core.data.printers).find((candidate) => candidate.id === paired.printer_id);
    expect(printer).toMatchObject({ name: "QL-570", connection: "direct", direct: { urls: ["https://192.168.1.20:8443", "https://stowly-pi.local:8443", "http://192.168.1.20:8080"] } });
    // Vom Server angelegt: kein ungesendeter Befehl dieses Geräts.
    expect(value(core.sync.status).pending).toBe(0);
    expect((await core.printers.probe(printer?.id ?? "")).reachable).toBe(true);

    // Neu koppeln übernimmt den Drucker; ein neuer Code bricht den älteren ab.
    const first = await core.printers.pair({ origin: "https://192.168.1.10:8443", printer_id: printer?.id });
    expect(first.command).toContain("http://192.168.1.10:8010/api/pi/install.sh");
    const second = await core.printers.pair({ origin: "https://192.168.1.10:8443", printer_id: printer?.id });
    expect((await core.printers.pairing(first.id)).state).toBe("cancelled");
    core.control.expirePairing(second.id);
    expect((await core.printers.pairing(second.id)).state).toBe("expired");

    const third = await core.printers.pair({ origin: "http://192.168.1.10:8010" });
    await core.printers.cancelPairing(third.id);
    expect((await core.printers.pairing(third.id)).state).toBe("cancelled");
    await core.printers.cancelPairing("00000000-0000-4000-8000-000000000000");
    await expectCoreError(core.printers.pairing("00000000-0000-4000-8000-000000000000"), "not_found");
    await expectCoreError(core.printers.pair({ origin: "kein Ursprung" }), "invalid");
    await expectCoreError(core.printers.pair({ origin: "http://192.168.1.10:8010", printer_id: sampleUuid(3, 99) }), "invalid");
  });

  it("meldet gekoppelte Pi mit dem Ablauf ihres Zertifikats (paired_printers)", async () => {
    expect((await mock().setup.load()).paired_printers).toEqual([]);
    const core = mock({ scenarios: ["pi-cert-expiring"] });
    // Seit 0.5.0 mit Version des Druckdienstes und Modell vom Koppeln.
    expect((await core.setup.load()).paired_printers).toEqual([
      { printer_id: PRINTER_IDS.cellar, hostname: "stowly-pi", not_after: new Date(NOW.getTime() + 20.5 * 86_400_000).toISOString(), version: "0.5.0", model: "QL-570" },
    ]);
    // Neu gekoppelt: Das neue Zertifikat gilt 825 Tage.
    const again = await core.printers.pair({ origin: "http://192.168.1.10:8010", printer_id: PRINTER_IDS.cellar });
    core.control.completePairing(again.id);
    expect((await core.setup.load()).paired_printers).toEqual([
      { printer_id: PRINTER_IDS.cellar, hostname: "stowly-pi", not_after: new Date(NOW.getTime() + 825 * 86_400_000).toISOString(), version: "0.5.0", model: "QL-570" },
    ]);
    // Ein gelöschter Drucker fällt weg.
    await core.printers.remove(PRINTER_IDS.cellar);
    expect((await core.setup.load()).paired_printers).toEqual([]);
  });

  it("koppelt mit Wartezeit nach einer Weile von selbst", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const core = createMockCore({ latency: 10, now: () => NOW, scenarios: ["empty"] });
      const pairing = core.printers.pair({ origin: "http://192.168.1.10:8010" });
      await vi.advanceTimersByTimeAsync(5);
      const created = await pairing;
      await vi.advanceTimersByTimeAsync(100);
      const installing = core.printers.pairing(created.id);
      await vi.advanceTimersByTimeAsync(5);
      expect((await installing).state).toBe("installing");
      await vi.advanceTimersByTimeAsync(150);
      const paired = core.printers.pairing(created.id);
      await vi.advanceTimersByTimeAsync(5);
      expect((await paired).state).toBe("paired");
      expect(value(core.data.printers)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ------------------------------------------------------------------------------------------
// Stufe B: Sicherung, Zurückspielen, Home Assistant aus der App
// ------------------------------------------------------------------------------------------

describe("Sicherung aus der App", () => {
  it("kommt ohne Ausgangslage aus der Umgebung und ist dort gesperrt", async () => {
    const core = mock();
    const config = (await core.serverConfig.load()).backup;
    expect(config).toMatchObject({ enabled: true, enabled_source: "env", recipients_source: "env", time: "03:30", time_source: "env", folder: "/backups", folder_source: "env" });
    expect(config.recipients.map((recipient) => recipient.key)).toEqual([...MOCK_BACKUP_KEYS]);
    await expectCoreError(core.serverConfig.update({ backup_recipients: [] }), "conflict");
    await expectCoreError(core.serverConfig.update({ backup_time: "02:00" }), "conflict");
    const status = (await core.integrations.load()).backup;
    expect(status).toMatchObject({ configured: true, folder: "/backups", recipients: ["age1wd93…dxjq", "age1extf…tge3"] });
    expect(status.files).toHaveLength(3);
    expect(status.files[0]?.name).toBe(status.last_file);
  });

  it("richtet mit backup-none in der App ein: Schlüssel, Uhrzeit, Schalter; ein geheimer Schlüssel wird abgelehnt", async () => {
    const core = mock({ scenarios: ["backup-none"] });
    expect((await core.integrations.load()).backup).toMatchObject({ configured: false, folder: "/data/backups", files: [], problem: null });
    expect((await core.setup.load()).steps.find((step) => step.id === "backup")?.ready).toBe(false);
    await expectCoreError(core.backup.run(), "not_configured");

    const secret = await expectCoreError(core.serverConfig.update({ backup_recipients: [MOCK_BACKUP_SECRET] }), "invalid");
    expect(secret.message).not.toContain(MOCK_BACKUP_SECRET);
    await expectCoreError(core.serverConfig.update({ backup_recipients: ["age1kaputt"] }), "invalid");
    await expectCoreError(core.serverConfig.update({ backup_time: "25:00" }), "invalid");
    // Ein neuer Schlüssel braucht das Haushalts-Passwort, wie beim Server.
    expect((await expectCoreError(core.serverConfig.update({ backup_recipients: [MOCK_BACKUP_KEYS[1]] }), "invalid")).message).toBe(
      "Zum Hinzufügen eines Schlüssels braucht es das Haushalts-Passwort.",
    );
    await expectCoreError(core.serverConfig.update({ backup_recipients: [MOCK_BACKUP_KEYS[1]], current_password: "falsch" }), "invalid_password");
    expect((await core.serverConfig.load()).backup.recipients).toEqual([]);

    const config = await core.serverConfig.update({ backup_recipients: [MOCK_BACKUP_KEYS[1].toUpperCase()], current_password: MOCK_PASSWORD, backup_time: "04:15", backup_enabled: true });
    expect(config.backup).toMatchObject({
      recipients_source: "app",
      recipients: [{ key: MOCK_BACKUP_KEYS[1], added_at: NOW.toISOString() }],
      time: "04:15",
      time_source: "app",
      enabled_source: "app",
    });
    const file = await core.backup.run();
    expect(file.name).toMatch(/^stowly-\d{4}-\d{2}-\d{2}-\d{4}\.sqlite3\.gz\.age$/);
    expect((await core.integrations.load()).backup).toMatchObject({ configured: true, last_file: file.name, files: [file] });
    expect((await core.setup.load()).steps.find((step) => step.id === "backup")?.ready).toBe(true);
    // Höchstens eine je Minute.
    expect((await expectCoreError(core.backup.run(), "rate_limited")).details.retry_after_s).toBe(60);
    expect(await (await core.backup.file(file.name)).text()).toContain("age-encryption.org/v1");
    await expectCoreError(core.backup.file("stowly-1999-01-01-0330.sqlite3.gz.age"), "not_found");
  });

  it("zeigt mit backup-app einen Schlüssel aus der App und den eigenen Ordner", async () => {
    const config = (await mock({ scenarios: ["backup-app"] }).serverConfig.load()).backup;
    expect(config).toMatchObject({ recipients_source: "app", recipients: [{ key: MOCK_BACKUP_KEYS[0] }], folder: "/backups", folder_source: "mounted", time_source: "default" });
  });
});

describe("Zurückspielen", () => {
  const age = () => new Blob(["age-encryption.org/v1\n-> X25519 …\n"]);

  it("lädt hoch, prüft den Schlüssel wirklich, zeigt die Vorschau und spielt mit Neustart ein; dann Rückgängig", async () => {
    const core = mock();
    const progress: number[] = [];
    const uploaded = await core.restore.upload(age(), { onProgress: (step) => progress.push(step.loaded) });
    expect(uploaded.kind).toBe("age");
    expect(progress.at(-1)).toBe(uploaded.size);
    expect((await expectCoreError(core.restore.check(uploaded.upload_id, "kein Schlüssel"), "invalid")).details.reason).toBe("not_a_key");
    const other = "AGE-SECRET-KEY-1VCRK9U8HKEN8GG34K206EPERG55J0X2LD5PATAUTEHQK8MQMH5VSJ2SRXF";
    expect((await expectCoreError(core.restore.check(uploaded.upload_id, other), "invalid")).details.reason).toBe("wrong_key");
    const preview = await core.restore.check(uploaded.upload_id, `# public key: ${MOCK_BACKUP_KEYS[0]}\n${MOCK_BACKUP_SECRET}\n`);
    expect(preview).toMatchObject({ kind: "age", has_password: true, counts: { zones: 4 } });

    await expectCoreError(core.restore.apply({ restore_id: preview.restore_id, password: "falsch" }), "invalid_password");
    await core.restore.apply({ restore_id: preview.restore_id, password: MOCK_PASSWORD });
    expect((await core.restore.status()).state).toBe("pending");
    const done = await core.restore.waitForRestart();
    expect(done).toMatchObject({ state: "done", undo_until: new Date(NOW.getTime() + 7 * 86_400_000).toISOString() });

    await core.restore.undo();
    expect((await core.restore.waitForRestart()).state).toBe("undone");
    await core.restore.discardPrevious();
    await expectCoreError(core.restore.undo(), "not_found");
  });

  it("sagt, was keine Sicherung ist, und nimmt mit restore-preview jede Datei und jeden Schlüssel", async () => {
    const core = mock();
    expect((await expectCoreError(core.restore.upload(new Blob(["PK\u0003\u0004"])), "invalid")).details.reason).toBe("not_stowly");
    await expectCoreError(core.restore.upload(new Blob([])), "invalid");

    const lenient = mock({ scenarios: ["restore-preview"] });
    expect(await lenient.restore.status()).toMatchObject({ state: "done", undo_until: expect.any(String) });
    const uploaded = await lenient.restore.upload(new Blob(["irgendwas"]));
    expect(uploaded.kind).toBe("sqlite");
    expect((await lenient.restore.check(uploaded.upload_id)).has_password).toBe(true);
  });

  it("stellt beim ersten Start wieder her und meldet mit dem Passwort der Sicherung an", async () => {
    const core = mock({ scenarios: ["unconfigured"] });
    expect(value(core.data.packages)).toEqual([]);
    const uploaded = await core.restore.upload(age());
    const preview = await core.restore.check(uploaded.upload_id, MOCK_BACKUP_SECRET);
    await expectCoreError(core.restore.apply({ restore_id: preview.restore_id, password: MOCK_PASSWORD }), "invalid");
    await expectCoreError(core.restore.apply({ restore_id: preview.restore_id, password: "falsch", device_name: "Neues Handy" }), "invalid_password");
    await core.restore.apply({ restore_id: preview.restore_id, password: MOCK_PASSWORD, device_name: "Neues Handy" });
    expect(value(core.session.state)).toMatchObject({ status: "signed_in", device: { name: "Neues Handy" } });
    expect(value(core.sync.status).server_configured).toBe(true);
    expect(value(core.data.packages).length).toBeGreaterThan(0);
  });

  it("geht abgemeldet nur beim ersten Start und braucht den Server", async () => {
    await expectCoreError(mock({ scenarios: ["signed-out"] }).restore.upload(age()), "conflict");
    await expectCoreError(mock({ scenarios: ["offline"] }).restore.upload(age()), "offline");
    await expectCoreError(mock({ scenarios: ["signed-out"] }).restore.status(), "unauthorized");
  });
});

describe("Home Assistant aus der App", () => {
  it("ist ohne Ausgangslage nicht eingerichtet; speichern, prüfen, Token an die Adresse gebunden", async () => {
    const core = mock();
    expect(await core.haConfig.load()).toMatchObject({ source: "default", configured: false, token_set: false, sensor: { set: false } });
    await expectCoreError(core.haConfig.check(), "invalid");
    expect((await core.haConfig.check({ url: MOCK_HA_URL })).state).toBe("token_needed");
    const saved = await core.haConfig.update({ url: `${MOCK_HA_URL}/`, token: "ein-token", entity: "todo.einkaufsliste" });
    expect(saved).toMatchObject({ source: "app", url: MOCK_HA_URL, configured: true, token_set: true });
    // Ohne Wartezeit ist der erste Abgleich sofort gelaufen (sonst erst "pending").
    expect((await core.integrations.load()).ha).toMatchObject({ configured: true, state: "ok", entity: "todo.einkaufsliste" });
    expect((await core.setup.load()).steps.find((step) => step.id === "home_assistant")?.ready).toBe(true);
    // Eine neue Adresse ohne Token löscht ihn.
    expect(await core.haConfig.update({ url: "http://anderes.local:8123" })).toMatchObject({ token_set: false, configured: false });
    await expectCoreError(core.haConfig.update({ entity: "Einkaufsliste" }), "invalid");
  });

  it("nennt die Listen sortiert, bremst zu dichte Prüfungen und sperrt eine Verbindung aus der Umgebung", async () => {
    const core = mock({ scenarios: ["ha-env"] });
    expect(await core.haConfig.load()).toMatchObject({ source: "env", url: MOCK_HA_URL, configured: true, sensor: { source: "env", set: true } });
    const check = await core.haConfig.check();
    expect(check).toMatchObject({ state: "ok", entity_found: true });
    expect(check.lists.map((list) => list.name)).toEqual(["Baumarkt", "Einkaufsliste"]);
    await expectCoreError(core.haConfig.check(), "rate_limited");
    await expectCoreError(core.haConfig.update({ entity: "todo.baumarkt" }), "conflict");
    await expectCoreError(core.haConfig.sensorToken(), "conflict");
  });

  it("meldet mit ha-token-missing den fehlenden Token und erzeugt den Sensor-Token", async () => {
    const core = mock({ scenarios: ["ha-token-missing"] });
    expect(await core.haConfig.load()).toMatchObject({ source: "app", token_set: false, configured: false, problem: HA_TOKEN_MISSING });
    expect((await core.integrations.load()).ha).toMatchObject({ configured: false, problem: HA_TOKEN_MISSING });
    await expectCoreError(core.haConfig.sensorToken(), "not_found");
    const token = await core.haConfig.createSensorToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await core.haConfig.sensorToken()).toBe(token);
    await core.haConfig.deleteSensorToken();
    expect((await core.haConfig.load()).sensor.set).toBe(false);
  });
});

describe("Etiketten gestalten (seit 0.5.0)", () => {
  it("liefert Gestaltung und Katalog, prüft, zeichnet in der Größe des Papiers und bringt die Vorlagen mit dem Abgleich", async () => {
    const core = mock();
    const state = await core.labels.design();
    expect(state).toMatchObject({ is_default: true, updated_at: null, design: { paper: "62" } });
    expect(state.papers.map((paper) => paper.name)).toContain("62 × 29 mm gestanzt");
    expect(await core.labels.templates()).toEqual({ paper: "62", schema: 1, hashes: state.templates });

    // Die Vorschau hat die Größe des Papiers, so wie man das Etikett liest.
    expect(await core.labels.preview({ kind: "package", paper: "62", layout: state.design.package, data: null })).toMatchObject({ width_px: 696, height_px: 342 });
    const small = { side: "left" as const, size: "s" as const };
    const fewer = state.design.package.fields.filter((field) => field.field !== "subtitle");
    expect(await core.labels.preview({ kind: "package", paper: "62x29", layout: { ...state.design.package, length_mm: null, qr: small, fields: fewer }, data: null })).toMatchObject({ width_px: 696, height_px: 271 });
    expect(await core.labels.preview({ kind: "zone", paper: "29", layout: { ...state.design.zone, length_mm: 62, qr: small }, data: null })).toMatchObject({ width_px: 732, height_px: 306 });
    // Ein langer Name auf einer Zeile passt nur verkleinert: ein Hinweis.
    const oneLine = { ...state.design.package, fields: state.design.package.fields.map((field) => (field.field === "title" ? { ...field, lines: 1 } : field)) };
    expect((await core.labels.preview({ kind: "package", paper: "62", layout: oneLine, data: null })).notes).toEqual(["Name auf 3,0 mm verkleinert und gekürzt."]);

    const saved = await core.labels.save({ paper: "29", package: { ...state.design.package, length_mm: 50 }, zone: { ...state.design.zone, length_mm: 50, qr: small } });
    expect(saved).toMatchObject({ is_default: false, design: { paper: "29" } });
    expect(saved.updated_at).not.toBeNull();
    expect(await core.labels.templates()).toEqual({ paper: "29", schema: 2, hashes: saved.templates });

    const crowded = { ...state.design.package, length_mm: 25, fields: (["title", "subtitle", "quantity", "brand", "best_before", "zone"] as const).map((field) => ({ field, size: "l" as const, lines: null })) };
    const refused = await expectCoreError(core.labels.save({ ...state.design, package: crowded }), "invalid");
    expect(refused.message).toBe("Für so viele Felder ist das Etikett zu kurz: ein Feld weglassen, kleiner wählen oder länger machen.");
    await expectCoreError(core.labels.preview({ kind: "package", paper: "62", layout: crowded, data: null }), "invalid");
    await expectCoreError(core.labels.save({ ...state.design, zone: { ...state.design.zone, fields: [{ field: "best_before", size: "s", lines: null }] } }), "invalid");

    expect(await core.labels.reset()).toMatchObject({ is_default: true, templates: state.templates });
    expect(await core.labels.templates()).toEqual({ paper: "62", schema: 1, hashes: state.templates });
  });

  it("braucht den Server, außer für die Vorlagen im Sync; die neuen kommen erst mit dem Abgleich", async () => {
    const core = createMockCore({ latency: 5, now: () => NOW });
    const state = await core.labels.design();
    const small = { side: "left" as const, size: "s" as const };
    const saved = await core.labels.save({
      paper: "62x29",
      package: { ...state.design.package, length_mm: null, qr: small, fields: state.design.package.fields.filter((field) => field.field !== "subtitle") },
      zone: { ...state.design.zone, length_mm: null, qr: small },
    });
    // Noch nicht abgeglichen: die alten Vorlagen.
    expect((await core.labels.templates()).hashes).toEqual(state.templates);
    await expect.poll(async () => (await core.labels.templates()).hashes).toEqual(saved.templates);
    core.control.setOnline(false);
    await expectCoreError(core.labels.design(), "offline");
    await expectCoreError(core.labels.preview({ kind: "package", paper: "62", layout: state.design.package, data: null }), "offline");
    expect((await core.labels.templates()).paper).toBe("62x29");
  });

  it("prüft wie der Server: Die Gestaltungen der Ausgangslagen passen, die Vorgabe nicht auf 62 × 29 mm gestanzt", async () => {
    for (const scenario of ["labels-custom", "labels-die-cut", "pi-outdated"] as const) {
      const core = mock({ scenarios: [scenario] });
      const state = await core.labels.design();
      await core.labels.save(state.design);
      for (const kind of ["package", "zone"] as const) {
        await core.labels.preview({ kind, paper: state.design.paper, layout: state.design[kind], data: null });
      }
    }
    const core = mock();
    const state = await core.labels.design();
    const dieCut = { ...state.design, paper: "62x29", package: { ...state.design.package, length_mm: null }, zone: { ...state.design.zone, length_mm: null } };
    const refused = await expectCoreError(core.labels.save(dieCut), "invalid");
    expect(refused.message).toBe("Der QR-Code ist für dieses Etikett zu groß: kleiner wählen oder ein größeres Papier nehmen.");
    expect(refused.details).toMatchObject({ errors: [{ loc: ["body", "package"] }] });
    // Mit kleinem QR-Code und einer Zeile weniger passt die Packung; die Zone braucht dann auch den kleinen.
    const smaller = { ...dieCut, package: { ...dieCut.package, qr: { side: "left" as const, size: "s" as const }, fields: dieCut.package.fields.filter((field) => field.field !== "subtitle") } };
    expect((await expectCoreError(core.labels.save(smaller), "invalid")).details).toMatchObject({ errors: [{ loc: ["body", "zone"] }] });
    await core.labels.save({ ...smaller, zone: { ...smaller.zone, qr: { side: "left", size: "s" } } });
    // Die Vorgabe zu speichern heißt: keine eigene Gestaltung.
    expect(await core.labels.save(state.design)).toMatchObject({ is_default: true, updated_at: null, templates: state.templates });
  });

  it("kennt die Ausgangslagen mit eigener Gestaltung", async () => {
    expect((await mock({ scenarios: ["labels-custom"] }).labels.design()).design).toMatchObject({ paper: "62", package: { length_mm: 50, qr: { side: "right" }, date: "short" } });
    expect(await mock({ scenarios: ["labels-custom"] }).labels.templates()).toMatchObject({ paper: "62", schema: 1 });
    expect(await mock({ scenarios: ["labels-die-cut"] }).labels.templates()).toMatchObject({ paper: "62x29", schema: 2 });
    expect(await mock({ scenarios: ["pi-outdated"] }).labels.templates()).toMatchObject({ paper: "29", schema: 2 });
  });
});

describe("Drucker und Papier (seit 0.5.0)", () => {
  it("meldet beim Prüfen Formate und eingelegte Rolle; bei anderem Papier eine falsche Rolle", async () => {
    const ready = await mock({ scenarios: ["at-pi"] }).printers.probe(PRINTER_IDS.cellar);
    expect(ready).toMatchObject({ reachable: true, problem: null, health: { version: "0.5.0", template_schemas: [1, 2] } });
    expect(ready.health?.printers[0]).toMatchObject({ loaded: { id: "62", kind: "endless" }, status: { ready: true, errors: [] } });
    const dieCut = await mock({ scenarios: ["at-pi", "labels-die-cut"] }).printers.probe(PRINTER_IDS.cellar);
    expect(dieCut.health?.printers[0]?.status).toMatchObject({ ready: false, errors: ["media_mismatch"] });
  });

  it("printer-off: Der Dienst antwortet, der Drucker nicht; zuletzt gesehen war er schon aus", async () => {
    const core = mock({ scenarios: ["printer-off"] });
    expect(value(core.data.printerStatus).find((entry) => entry.printer_id === PRINTER_IDS.cellar)?.status).toMatchObject({ reachable: false, errors: ["offline"] });
    const probe = await core.printers.probe(PRINTER_IDS.cellar);
    expect(probe).toMatchObject({ reachable: true, problem: null });
    expect(probe.health?.printers[0]?.status).toMatchObject({ reachable: false, errors: ["offline"] });
    // Ein Etikett dorthin scheitert, wie beim echten Dienst.
    const [job] = await core.print.requestPackageLabels([value(core.data.packages).find((pkg) => pkg.zone_id === ZONE_IDS.cellar)?.id ?? ""]);
    await core.print.flush();
    expect(value(core.data.printJobs).find((entry) => entry.id === job?.id)).toMatchObject({ state: "failed", error: "offline" });
  });

  it("pi-outdated: Etiketten bleiben mit `outdated` ausstehend, bis der Pi neu gekoppelt ist", async () => {
    const core = mock({ scenarios: ["pi-outdated", "at-pi"] });
    expect((await core.setup.load()).paired_printers).toMatchObject([{ printer_id: PRINTER_IDS.cellar, version: "0.4.0", model: "QL-570" }]);
    const probe = await core.printers.probe(PRINTER_IDS.cellar);
    expect(probe).toMatchObject({ reachable: true, problem: "outdated", health: { version: "0.4.0" } });
    expect(probe.health?.template_schemas).toBeUndefined();
    expect(probe.health?.printers[0]?.loaded).toBeUndefined();
    const [job] = await core.print.requestPackageLabels([value(core.data.packages).find((pkg) => pkg.zone_id === ZONE_IDS.cellar)?.id ?? ""]);
    const report = await core.print.flush();
    expect(report.problems).toContainEqual({ printer_id: PRINTER_IDS.cellar, problem: "outdated", message: "Der Druckdienst auf dem Pi ist zu alt für dieses Papier. Neu koppeln aktualisiert ihn." });
    expect(value(core.data.printJobs).find((entry) => entry.id === job?.id)?.state).toBe("pending");

    // Neu gekoppelt: neuer Druckdienst, und das Etikett geht hinaus (an die 62-mm-Rolle passt das Papier 29 mm nicht).
    const again = await core.printers.pair({ origin: "http://192.168.1.10:8010", printer_id: PRINTER_IDS.cellar });
    core.control.completePairing(again.id);
    expect((await core.setup.load()).paired_printers).toMatchObject([{ printer_id: PRINTER_IDS.cellar, version: "0.5.0" }]);
    expect((await core.printers.probe(PRINTER_IDS.cellar)).problem).toBeNull();
    await core.print.flush();
    expect(value(core.data.printJobs).find((entry) => entry.id === job?.id)).toMatchObject({ state: "failed", error: "media_mismatch" });
  });
});

describe("Produktdaten neu abfragen (seit 0.5.0)", () => {
  it("fragt nach der Regel der Attrappe, bremst je Barcode eine Minute und ändert kein Produkt", async () => {
    let now = NOW.getTime();
    const core = mock({ now: () => new Date(now) });
    const even = value(core.data.products).find((product) => product.barcodes.length === 1 && Number(product.barcodes[0]?.at(-1)) % 2 === 0);
    const odd = value(core.data.products).find((product) => product.barcodes.length === 1 && Number(product.barcodes[0]?.at(-1)) % 2 === 1);
    const evenCode = even?.barcodes[0] ?? "";
    const oddCode = odd?.barcodes[0] ?? "";
    expect(await core.products.refreshLookup(evenCode)).toMatchObject({ state: "found", name: `Beispielprodukt ${evenCode.slice(-4)}`, throttled: false, fetched_at: NOW.toISOString() });
    expect(await core.products.refreshLookup(oddCode)).toMatchObject({ state: "not_found", throttled: false });
    expect(await core.products.refreshLookup(oddCode)).toMatchObject({ state: "not_found", throttled: true });
    now += 61_000;
    expect(await core.products.refreshLookup(oddCode)).toMatchObject({ throttled: false });
    expect(value(core.data.products).find((product) => product.id === even?.id)).toEqual(even);
    await expectCoreError(core.products.refreshLookup("123"), "invalid");
    const body = "200123400001";
    const internal = body + String(gtinCheckDigit(body));
    expect(isValidBarcode(internal)).toBe(true);
    expect(await core.products.refreshLookup(internal)).toMatchObject({ state: "skipped" });
    core.control.setOnline(false);
    await expectCoreError(core.products.refreshLookup(evenCode), "offline");
  });

  it("lookup-refresh findet jeden Barcode mit abweichenden Angaben und Bild", async () => {
    const core = mock({ scenarios: ["lookup-refresh"] });
    const rice = value(core.data.products).find((product) => product.name === "Basmati Reis");
    expect(await core.products.refreshLookup(rice?.barcodes[0] ?? "")).toMatchObject({ state: "found", name: "Bio Basmati Reis", brand: "Kornhaus", quantity: "500 g" });
    const placeholder = value(core.data.products).find((product) => product.name === "" && product.lookup === "not_found");
    const found = await core.products.refreshLookup(placeholder?.barcodes[0] ?? "");
    expect(found.state).toBe("found");
    expect(found.image_id).not.toBeNull();
  });

  it("setzt das Bild eines Produkts sofort, nur auf ein Bild, das Stowly hat", async () => {
    const core = mock({ scenarios: ["lookup-refresh"] });
    const rice = value(core.data.products).find((product) => product.name === "Basmati Reis");
    const found = await core.products.refreshLookup(rice?.barcodes[0] ?? "");
    await core.products.setImage(rice?.id ?? "", found.image_id);
    expect(value(core.data.products).find((product) => product.id === rice?.id)?.image).toBe(found.image_id);
    await expectCoreError(core.products.setImage(rice?.id ?? "", "fremdes-bild"), "invalid");
    await core.products.setImage(rice?.id ?? "", null);
    expect(value(core.data.products).find((product) => product.id === rice?.id)?.image).toBeNull();
    await expectCoreError(core.products.setImage("00000000-0000-4000-8000-000000000000", null), "not_found");
    core.control.setOnline(false);
    await expectCoreError(core.products.setImage(rice?.id ?? "", found.image_id), "offline");
  });
});
