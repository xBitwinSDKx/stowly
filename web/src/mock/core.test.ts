/**
 * Die Attrappe muss sich so verhalten, wie src/contract/core.ts es beschreibt.
 * Diese Tests sind zugleich ein ausführbares Beispiel für die Schnittstelle des Kerns.
 */
import { describe, expect, it } from "vitest";

import { addDays, CoreError, expiryState, isPackageId, isUuid, isValidBarcode, LIMITS, todayLocal, warnDaysFor, type Live } from "@/contract";

import { createMockCore, createSampleData, DEVICE_IDS, MOCK_PASSWORD, PRINTER_IDS, sampleBarcode, ZONE_IDS } from ".";

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
    // eine Packung wurde vor 40 Tagen entnommen, die Aufbewahrung beträgt 30 Tage
    expect(active.length + removed.length).toBe(all.length - 1);
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
    await expectCoreError(core.backup.download(), "offline");

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
});
