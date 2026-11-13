/**
 * Das Verhalten der Schnittstelle `Core`: Was die Attrappe der Oberfläche verspricht
 * (src/mock/core.test.ts), muss der echte Kern halten. Die Fälle sind von dort übernommen
 * und laufen hier gegen den echten Kern, der seinen Bestand von der nachgebauten
 * Schnittstelle holt. Derselbe Beispiel-Haushalt, dieselben Erwartungen.
 *
 * Wo der Kern in Runde 1 bewusst anders ist (kein Zustellen von Etiketten, keine Vorschau),
 * steht es am Test.
 */
import { afterEach, describe, expect, it } from "vitest";

import { addDays, APP_VERSION, expiryState, isPackageId, isValidBarcode, todayLocal, warnDaysFor, type Core, type SyncRequest } from "@/contract";
import { createEmptyData, createSampleData, createSingleZoneData, PRINTER_IDS, sampleBarcode, ZONE_IDS, type MockData } from "@/mock";

import { FAKE_PASSWORD, validateCommand } from "./testing/fake-api";
import { commandsOf, disposeAll, expectCoreError, start, START, value, type Harness } from "./testing/harness";

afterEach(disposeAll);

const NOW = START;

type Kind = "sample" | "empty" | "single-zone";

function dataFor(kind: Kind): MockData {
  if (kind === "empty") {
    return createEmptyData(NOW);
  }
  return kind === "single-zone" ? createSingleZoneData(NOW) : createSampleData(NOW);
}

/** Ein angemeldeter Kern, dessen Server den Beispiel-Haushalt der Attrappe führt. */
async function household(kind: Kind = "sample", change: (data: MockData) => MockData = (data) => data): Promise<Harness & { sample: MockData }> {
  const harness = await start();
  const sample = change(dataFor(kind));
  harness.server.load({
    products: sample.products,
    packages: sample.packages,
    zones: sample.zones,
    printers: sample.printers,
    printer_status: sample.printerStatus,
    print_jobs: sample.printJobs,
    settings: sample.settings,
  });
  await harness.core.session.login(FAKE_PASSWORD, "Dieses Gerät");
  return { ...harness, sample };
}

/** Alle Befehle, die der Kern bisher gesendet hat: Keiner darf beim echten Server als ungültig gelten. */
function expectValidCommands(harness: Harness): void {
  const sent = harness.server.syncRequests.flatMap((request) => commandsOf(request));
  const problems = sent.map((command) => validateCommand(command)).filter((problem) => problem !== null);
  expect(problems).toEqual([]);
}

async function syncClean(harness: Harness): Promise<void> {
  await harness.core.sync.now();
  expect(value(harness.core.sync.status)).toMatchObject({ phase: "idle", pending: 0 });
  expect(value(harness.core.sync.problems)).toEqual([]);
  expectValidCommands(harness);
}

describe("Lesen", () => {
  it("trennt Bestand und Lösch-Historie und beachtet die Aufbewahrungsdauer", async () => {
    const { core, sample } = await household();
    const active = value(core.data.packages);
    const removed = value(core.data.removedPackages);

    expect(active.every((pkg) => pkg.removed_at === null)).toBe(true);
    expect(removed.every((pkg) => pkg.removed_at !== null)).toBe(true);
    // eine Packung wurde vor 40 Tagen entnommen, die Aufbewahrung beträgt 30 Tage
    expect(active.length + removed.length).toBe(sample.packages.length - 1);
    expect(removed.map((pkg) => pkg.removed_at)).toEqual([...removed.map((pkg) => pkg.removed_at)].sort().reverse());
    expect(removed.some((pkg) => pkg.displaced !== null)).toBe(true);
  });

  it("liefert die Listen mit den Filtern und Sortierungen der Schnittstelle", async () => {
    const { core, sample } = await household();
    expect(value(core.data.products)).toHaveLength(sample.products.length);
    expect(value(core.data.zones).map((zone) => zone.name)).toEqual(["Vorratsregal", "Keller", "Kühlschrank", "Gefrierschrank"]);
    expect(value(core.data.printers).map((printer) => printer.name)).toEqual(["Keller (Pi)", "Küche (Bild)"]);
    expect(value(core.data.printerStatus).map((status) => status.printer_id).sort()).toEqual([PRINTER_IDS.kitchen, PRINTER_IDS.cellar].sort());
    const jobs = value(core.data.printJobs);
    expect(jobs).toHaveLength(sample.printJobs.length);
    expect(jobs.map((job) => job.created_at)).toEqual([...jobs.map((job) => job.created_at)].sort().reverse());
    expect(value(core.data.settings)).toEqual(sample.settings);
    expect(core.data.imageUrl("9f2c0011.jpg")).toBe("/api/images/9f2c0011.jpg");
  });

  it("liefert dieselbe Referenz, solange sich nichts Betroffenes ändert", async () => {
    const { core } = await household();
    const zones = core.data.zones.get();
    const packages = core.data.packages.get();
    const products = core.data.products.get();
    expect(core.data.zones.get()).toBe(zones);

    await core.prefs.update({ scan_sound: false });
    expect(core.data.zones.get()).toBe(zones);
    expect(core.data.packages.get()).toBe(packages);

    await core.zones.create({ name: "Garage" });
    expect(core.data.zones.get()).not.toBe(zones);
    expect(core.data.packages.get()).toBe(packages);

    // Auch ein Abgleich, der nichts Neues bringt, lässt alles in Ruhe.
    const afterCreate = core.data.zones.get();
    await core.sync.now();
    await core.sync.now();
    expect(core.data.packages.get()).toBe(packages);
    expect(core.data.products.get()).toBe(products);
    expect(core.data.zones.get()?.map((zone) => zone.name)).toEqual(afterCreate?.map((zone) => zone.name));
    const settled = core.data.zones.get();
    await core.sync.now();
    expect(core.data.zones.get()).toBe(settled);
  });

  it("benachrichtigt Abonnenten und lässt sie sich wieder abmelden", async () => {
    const { core } = await household();
    let calls = 0;
    let packageCalls = 0;
    const unsubscribe = core.data.zones.subscribe(() => {
      calls += 1;
    });
    const unsubscribePackages = core.data.packages.subscribe(() => {
      packageCalls += 1;
    });
    await core.zones.create({ name: "Garage" });
    expect(calls).toBeGreaterThan(0);
    // Wer die Packungen liest, erfährt nichts von einer neuen Zone.
    expect(packageCalls).toBe(0);
    const before = calls;
    unsubscribe();
    unsubscribePackages();
    await core.zones.create({ name: "Dachboden" });
    expect(calls).toBe(before);
  });

  it("findet Packungen und Produkte", async () => {
    const { core } = await household();
    const removed = value(core.data.removedPackages)[0];
    expect((await core.data.findPackage(removed?.id ?? ""))?.id).toBe(removed?.id);
    expect(await core.data.findPackage("ZZZZZ")).toBeUndefined();

    const product = value(core.data.products).find((candidate) => candidate.barcodes.length > 0);
    expect((await core.data.findProductByBarcode(product?.barcodes[0] ?? ""))?.id).toBe(product?.id);
    expect(await core.data.findProductByBarcode(sampleBarcode(999))).toBeUndefined();
    expect((await core.data.findProduct(product?.id ?? ""))?.id).toBe(product?.id);
    expect(await core.data.findProduct("20000000-0000-4000-8000-000000000999")).toBeUndefined();
  });

  it("zeigt dieselben Warnstufen wie die Attrappe", async () => {
    const { core } = await household();
    const today = todayLocal(NOW);
    const byId = new Map(value(core.data.products).map((product) => [product.id, product]));
    const states = new Set(value(core.data.packages).map((pkg) => expiryState(pkg.best_before, warnDaysFor(byId.get(pkg.product_id), value(core.data.settings)), today)));
    expect(states).toEqual(new Set(["none", "ok", "soon", "expired"]));
  });
});

describe("Einlagern und Entnehmen", () => {
  it("legt je Packung einen Datensatz mit eigener ID und ein Etikett an", async () => {
    const harness = await household();
    const { core } = harness;
    const product = value(core.data.products)[0];
    const before = value(core.data.packages).length;
    const result = await core.stock.store({
      product: { kind: "existing", product_id: product?.id ?? "" },
      zone_id: ZONE_IDS.cellar,
      best_before: "2027-03-25",
      count: 4,
    });

    expect(result.product.id).toBe(product?.id);
    expect(result.packages).toHaveLength(4);
    expect(new Set(result.packages.map((pkg) => pkg.id)).size).toBe(4);
    expect(result.packages.every((pkg) => isPackageId(pkg.id) && pkg.best_before === "2027-03-25" && pkg.zone_id === ZONE_IDS.cellar)).toBe(true);
    expect(result.print_jobs.map((job) => job.package_id)).toEqual(result.packages.map((pkg) => pkg.id));
    expect(result.print_jobs.every((job) => job.state === "pending" && job.kind === "package")).toBe(true);
    expect(value(core.data.packages)).toHaveLength(before + 4);
    // Das Etikett nennt das Gerät, das es angefordert hat.
    const session = value(core.session.state);
    expect(result.print_jobs[0]?.device_id).toBe(session.status === "signed_in" ? session.device.id : "");

    await syncClean(harness);
    expect(value(core.data.packages)).toHaveLength(before + 4);
    // Die Etiketten bleiben in Runde 1 ausstehend.
    expect(value(core.data.printJobs).filter((job) => result.print_jobs.some((mine) => mine.id === job.id)).every((job) => job.state === "pending")).toBe(true);
  });

  it("fordert ohne Wunsch keine Etiketten an", async () => {
    const harness = await household();
    const { core } = harness;
    const product = value(core.data.products)[0];
    const input = { product: { kind: "existing", product_id: product?.id ?? "" }, zone_id: ZONE_IDS.shelf, best_before: null, count: 1 } as const;
    expect((await core.stock.store({ ...input, labels: false })).print_jobs).toEqual([]);

    await core.prefs.update({ print_labels: false });
    expect((await core.stock.store(input)).print_jobs).toEqual([]);
    expect((await core.stock.store({ ...input, labels: true })).print_jobs).toHaveLength(1);
    await syncClean(harness);
  });

  it("fordert ohne Drucker nie Etiketten an", async () => {
    const harness = await household("empty");
    const { core } = harness;
    const result = await core.stock.store({ product: { kind: "new", name: "Reis" }, zone_id: ZONE_IDS.shelf, best_before: null, count: 2, labels: true });
    expect(result.packages).toHaveLength(2);
    expect(result.print_jobs).toEqual([]);
    await expectCoreError(core.print.requestPackageLabels([result.packages[0]?.id ?? ""]), "not_found");
    await expectCoreError(core.print.requestZoneLabel(ZONE_IDS.shelf), "not_found");
    await syncClean(harness);
  });

  it("verwirft ausstehende Etiketten entnommener Packungen", async () => {
    const harness = await household();
    const { core, server } = harness;
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

    await syncClean(harness);
    expect(server.data.print_jobs.get(print_jobs[0]?.id ?? "")?.state).toBe("cancelled");
    expect(state(print_jobs[0]?.id)).toBe("cancelled");
    expect(state(print_jobs[1]?.id)).toBe("pending");
  });

  it("legt für einen unbekannten Barcode sofort einen Platzhalter an", async () => {
    const harness = await household();
    const { core } = harness;
    const barcode = sampleBarcode(500);
    const result = await core.stock.store({ product: { kind: "barcode", barcode }, zone_id: ZONE_IDS.shelf, best_before: null, count: 1 });
    expect(result.product.name).toBe("");
    expect(result.product.lookup).toBe("pending");
    expect(result.product.barcodes).toEqual([barcode]);
    expect((await core.data.findProductByBarcode(barcode))?.id).toBe(result.product.id);

    // Derselbe Barcode noch einmal: kein zweites Produkt
    const again = await core.stock.store({ product: { kind: "barcode", barcode }, zone_id: ZONE_IDS.shelf, best_before: null, count: 1 });
    expect(again.product.id).toBe(result.product.id);

    // Den Namen gleich von Hand setzen
    const named = await core.stock.store({ product: { kind: "barcode", barcode: sampleBarcode(501), name: " Senf " }, zone_id: ZONE_IDS.shelf, best_before: null, count: 1 });
    expect(named.product).toMatchObject({ name: "Senf", lookup: "pending" });
    await syncClean(harness);
  });

  it("richtet sich danach, ob der Server Barcodes nachschlägt", async () => {
    // Vor der Anmeldung ist nichts bekannt.
    const off = await start({ server: { lookupEnabled: false } });
    expect(value(off.core.sync.status).lookup_enabled).toBeNull();
    await off.core.session.login(FAKE_PASSWORD, "Handy");
    expect(value(off.core.sync.status).lookup_enabled).toBe(false);

    // Abgeschaltet: Der Platzhalter verspricht nichts, schon vor dem Abgleich und danach.
    off.network.offline = true;
    const zone = value(off.core.data.zones)[0]?.id ?? "";
    const stored = await off.core.stock.store({ product: { kind: "barcode", barcode: sampleBarcode(510) }, zone_id: zone, best_before: null, count: 1 });
    expect(stored.product.lookup).toBe("none");
    expect(value(off.core.data.products).find((product) => product.id === stored.product.id)?.lookup).toBe("none");
    // Auch nach dem Neuladen, ohne dass der Server gefragt wurde: Der Kern hat es sich gemerkt.
    off.core.dispose();
    const reloaded = await off.another();
    expect(value(reloaded.sync.status).lookup_enabled).toBe(false);
    expect(value(reloaded.data.products).find((product) => product.id === stored.product.id)?.lookup).toBe("none");
    off.network.offline = false;
    await reloaded.sync.now();
    expect(value(reloaded.sync.status).pending).toBe(0);
    expect(value(reloaded.data.products).find((product) => product.id === stored.product.id)?.lookup).toBe("none");

    // Eingeschaltet: wie bisher "pending". Abmelden vergisst die Angabe wieder.
    const on = await start();
    await on.core.session.login(FAKE_PASSWORD, "Handy");
    expect(value(on.core.sync.status).lookup_enabled).toBe(true);
    const pending = await on.core.stock.store({
      product: { kind: "barcode", barcode: sampleBarcode(511) },
      zone_id: value(on.core.data.zones)[0]?.id ?? "",
      best_before: null,
      count: 1,
    });
    expect(pending.product.lookup).toBe("pending");
    await on.core.session.logout({ discard_pending: true });
    expect(value(on.core.sync.status).lookup_enabled).toBeNull();
  });

  it("schlägt ladeninterne Codes nicht nach", async () => {
    const { core } = await household();
    const result = await core.stock.store({
      product: { kind: "barcode", barcode: sampleBarcode(1, "2112345") },
      zone_id: ZONE_IDS.shelf,
      best_before: null,
      count: 1,
    });
    expect(result.product.lookup).toBe("none");
  });

  it("weist ungültige Eingaben zurück", async () => {
    const { core } = await household();
    const product = { kind: "existing", product_id: value(core.data.products)[0]?.id ?? "" } as const;
    const pending = value(core.sync.status).pending;
    await expectCoreError(core.stock.store({ product, zone_id: ZONE_IDS.shelf, best_before: null, count: 0 }), "invalid");
    await expectCoreError(core.stock.store({ product, zone_id: ZONE_IDS.shelf, best_before: null, count: 51 }), "invalid");
    await expectCoreError(core.stock.store({ product, zone_id: ZONE_IDS.shelf, best_before: null, count: 1.5 }), "invalid");
    await expectCoreError(core.stock.store({ product, zone_id: ZONE_IDS.shelf, best_before: "25.03.2027", count: 1 }), "invalid");
    await expectCoreError(core.stock.store({ product, zone_id: ZONE_IDS.shelf, best_before: "2027-02-30", count: 1 }), "invalid");
    await expectCoreError(core.stock.store({ product, zone_id: "10000000-0000-4000-8000-000000000099", best_before: null, count: 1 }), "not_found");
    await expectCoreError(core.stock.store({ product: { kind: "existing", product_id: "20000000-0000-4000-8000-000000000999" }, zone_id: ZONE_IDS.shelf, best_before: null, count: 1 }), "not_found");
    await expectCoreError(core.stock.store({ product: { kind: "barcode", barcode: "4006381333932" }, zone_id: ZONE_IDS.shelf, best_before: null, count: 1 }), "invalid");
    await expectCoreError(core.stock.store({ product: { kind: "new", name: "  " }, zone_id: ZONE_IDS.shelf, best_before: null, count: 1 }), "invalid");
    await expectCoreError(core.stock.store({ product: { kind: "new", name: "x".repeat(121) }, zone_id: ZONE_IDS.shelf, best_before: null, count: 1 }), "invalid");
    // Eine abgewiesene Eingabe hinterlässt nichts: keine halben Befehle, keine verbrauchten IDs.
    expect(value(core.sync.status).pending).toBe(pending);
  });

  it("legt bei einem Fehler mitten im Vorgang gar nichts an", async () => {
    const { core } = await household();
    const products = value(core.data.products).length;
    const taken = value(core.data.products).find((candidate) => candidate.barcodes.length > 0)?.barcodes[0] ?? "";
    // Das Produkt wäre neu, einer seiner Barcodes gehört aber schon einem anderen.
    const error = await expectCoreError(
      core.stock.store({ product: { kind: "new", name: "Reis", barcodes: [sampleBarcode(800), taken] }, zone_id: ZONE_IDS.shelf, best_before: null, count: 3 }),
      "barcode_taken",
    );
    expect(error.details.product_id).toEqual(expect.any(String));
    expect(value(core.data.products)).toHaveLength(products);
    expect(value(core.sync.status).pending).toBe(0);
  });

  it("entnimmt in die Lösch-Historie und stellt wieder her", async () => {
    const harness = await household();
    const { core, server } = harness;
    const pkg = value(core.data.packages)[0];
    const id = pkg?.id ?? "";

    await core.stock.remove([id], "consumed");
    expect(value(core.data.packages).some((candidate) => candidate.id === id)).toBe(false);
    const removed = value(core.data.removedPackages).find((candidate) => candidate.id === id);
    expect(removed?.removal_reason).toBe("consumed");
    expect(removed?.removed_at).toBe(NOW.toISOString());
    // neueste zuerst
    expect(value(core.data.removedPackages)[0]?.id).toBe(id);

    // noch einmal entnehmen ändert nur den Grund
    await core.stock.remove([id], "discarded");
    expect(value(core.data.removedPackages).find((candidate) => candidate.id === id)?.removal_reason).toBe("discarded");
    expect(value(core.data.removedPackages).find((candidate) => candidate.id === id)?.removed_at).toBe(NOW.toISOString());

    await core.stock.restore([id]);
    const restored = value(core.data.packages).find((candidate) => candidate.id === id);
    expect(restored?.removed_at).toBeNull();
    expect(restored?.removal_reason).toBeNull();
    await expectCoreError(core.stock.remove(["ZZZZZ"], "consumed"), "not_found");
    await expectCoreError(core.stock.remove([id, "ZZZZZ"], "consumed"), "not_found");
    expect(value(core.data.packages).some((candidate) => candidate.id === id)).toBe(true);

    await syncClean(harness);
    expect(server.data.packages.get(id)).toMatchObject({ removed_at: null, removal_reason: null });
    expect(commandsOf(server.syncRequests.at(-1)).map((command) => command.type)).toEqual(["package.remove", "package.remove", "package.restore"]);
  });

  it("übernimmt beim Wiederherstellen auf Wunsch die verdrängte Bearbeitung", async () => {
    const withEdit = await household();
    const target = value(withEdit.core.data.removedPackages).find((pkg) => pkg.displaced !== null);
    const wanted = target?.displaced?.changes.find((change) => change.field === "best_before")?.value;
    await withEdit.core.stock.restore([target?.id ?? ""], { apply_displaced: true });
    const applied = value(withEdit.core.data.packages).find((pkg) => pkg.id === target?.id);
    expect(applied?.best_before).toBe(wanted);
    expect(applied?.displaced).toBeNull();
    await syncClean(withEdit);
    expect(withEdit.server.data.packages.get(target?.id ?? "")).toMatchObject({ best_before: wanted, displaced: null, removed_at: null });

    const without = await household();
    await without.core.stock.restore([target?.id ?? ""]);
    const plain = value(without.core.data.packages).find((pkg) => pkg.id === target?.id);
    expect(plain?.best_before).toBe(target?.best_before);
    expect(plain?.displaced).toBeNull();
  });

  it("ändert nur die genannten Felder", async () => {
    const harness = await household();
    const { core, server } = harness;
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

    await expectCoreError(core.stock.update([id], { best_before: "morgen" }), "invalid");
    await expectCoreError(core.stock.update([id], { zone_id: "10000000-0000-4000-8000-000000000099" }), "not_found");
    await expectCoreError(core.stock.update(["ZZZZZ"], { best_before: null }), "not_found");

    await syncClean(harness);
    // Je Befehl nur die geänderten Schlüssel: `null` ist dort ein Wert, kein „nicht angegeben".
    const sent = commandsOf(server.syncRequests.at(-1));
    expect(sent.map((command) => command.changes)).toEqual([{ zone_id: ZONE_IDS.freezer }, { best_before: null }]);
    expect(server.data.packages.get(id)).toMatchObject({ zone_id: ZONE_IDS.freezer, best_before: null });
  });

  it("hebt die Bearbeitung einer entnommenen Packung auf, statt sie anzuwenden", async () => {
    // Anders als die Attrappe, aber wie der Server (Löschen gewinnt, 7.2).
    const { core } = await household();
    const removed = value(core.data.removedPackages).find((pkg) => pkg.displaced === null);
    const id = removed?.id ?? "";
    await core.stock.update([id], { best_before: "2029-01-01" });
    const current = await core.data.findPackage(id);
    expect(current?.best_before).toBe(removed?.best_before);
    expect(current?.displaced?.changes).toEqual([{ field: "best_before", value: "2029-01-01" }]);
  });
});

describe("Produkte", () => {
  it("legt Produkte an und weist doppelte Barcodes zurück", async () => {
    const harness = await household();
    const { core } = harness;
    const created = await core.products.create({ name: " Senf ", brand: "Scharfmacher", quantity: "200 ml", warn_days: 10, barcodes: [sampleBarcode(601), sampleBarcode(600)] });
    expect(created).toMatchObject({ name: "Senf", brand: "Scharfmacher", quantity: "200 ml", warn_days: 10, lookup: "pending", image: null, deleted_at: null });
    expect(created.barcodes).toEqual([sampleBarcode(600), sampleBarcode(601)].sort());
    expect(created.barcodes.every(isValidBarcode)).toBe(true);
    expect(value(core.data.products).some((product) => product.id === created.id)).toBe(true);

    await expectCoreError(core.products.create({ name: "" }), "invalid");
    await expectCoreError(core.products.create({ name: "Senf", warn_days: -1 }), "invalid");
    await expectCoreError(core.products.create({ name: "Senf", barcodes: ["123"] }), "invalid");
    const error = await expectCoreError(core.products.create({ name: "Senf 2", barcodes: [sampleBarcode(600)] }), "barcode_taken");
    expect(error.details.product_id).toBe(created.id);
    // Ohne Barcode gibt es nichts nachzuschlagen.
    expect((await core.products.create({ name: "Selbstgemachte Marmelade" })).lookup).toBe("none");
    await syncClean(harness);
  });

  it("meldet einen schon vergebenen Barcode mit dem Besitzer", async () => {
    const harness = await household();
    const { core } = harness;
    const [first, second] = value(core.data.products);
    const error = await expectCoreError(core.products.addBarcode(second?.id ?? "", first?.barcodes[0] ?? ""), "barcode_taken");
    expect(error.details.product_id).toBe(first?.id);

    const fresh = sampleBarcode(700);
    await core.products.addBarcode(second?.id ?? "", fresh);
    expect((await core.data.findProductByBarcode(fresh))?.id).toBe(second?.id);
    await core.products.removeBarcode(second?.id ?? "", fresh);
    expect(await core.data.findProductByBarcode(fresh)).toBeUndefined();
    await syncClean(harness);
  });

  it("führt zwei Produkte zusammen", async () => {
    const harness = await household();
    const { core, server } = harness;
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
    // Einlagern mit der alten Kennung landet ebenfalls beim Ziel.
    const stored = await core.stock.store({ product: { kind: "existing", product_id: source?.id ?? "" }, zone_id: ZONE_IDS.shelf, best_before: null, count: 1, labels: false });
    expect(stored.product.id).toBe(target?.id);
    expect(stored.packages[0]?.product_id).toBe(target?.id);

    await syncClean(harness);
    expect(server.data.products.get(source?.id ?? "")).toMatchObject({ merged_into: target?.id, barcodes: [] });
    expect(value(core.data.products).some((product) => product.id === source?.id)).toBe(false);
  });

  it("ändert nur die genannten Felder und erlaubt, die Vorlaufzeit zu löschen", async () => {
    const harness = await household();
    const { core, server } = harness;
    const product = value(core.data.products).find((candidate) => candidate.warn_days !== null);
    await core.products.update(product?.id ?? "", { warn_days: null });
    const current = value(core.data.products).find((candidate) => candidate.id === product?.id);
    expect(current?.warn_days).toBeNull();
    expect(current?.name).toBe(product?.name);
    await expectCoreError(core.products.update(product?.id ?? "", { name: " " }), "invalid");
    await core.products.update(product?.id ?? "", { name: " Lachs ", brand: "" });
    expect(value(core.data.products).find((candidate) => candidate.id === product?.id)).toMatchObject({ name: "Lachs", brand: "", quantity: product?.quantity });

    await syncClean(harness);
    expect(commandsOf(server.syncRequests.at(-1)).map((command) => command.changes)).toEqual([{ warn_days: null }, { name: "Lachs", brand: "" }]);
  });
});

describe("Zonen und Einstellungen", () => {
  it("legt Zonen hinten an und sortiert nach der Reihenfolge", async () => {
    const harness = await household();
    const { core } = harness;
    const created = await core.zones.create({ name: "Garage", icon: "garage" });
    expect(created).toMatchObject({ name: "Garage", icon: "garage", color: null, sort: 4, printer_id: null, deleted_at: null });
    const zones = value(core.data.zones);
    expect(zones.at(-1)?.id).toBe(created.id);

    await core.zones.reorder([created.id, ...zones.slice(0, -1).map((zone) => zone.id)]);
    expect(value(core.data.zones)[0]?.id).toBe(created.id);
    expect(value(core.data.zones).map((zone) => zone.sort)).toEqual([0, 1, 2, 3, 4]);

    await core.zones.update(created.id, { name: " Werkstatt ", color: "amber" });
    expect(value(core.data.zones)[0]).toMatchObject({ name: "Werkstatt", color: "amber", icon: "garage" });
    await expectCoreError(core.zones.update(created.id, { name: "" }), "invalid");
    await expectCoreError(core.zones.create({ name: " " }), "invalid");
    await expectCoreError(core.zones.create({ name: "x".repeat(61) }), "invalid");
    await syncClean(harness);
    expect(value(core.data.zones).map((zone) => zone.name)).toEqual(["Werkstatt", "Vorratsregal", "Keller", "Kühlschrank", "Gefrierschrank"]);
  });

  it("verschiebt beim Löschen die Packungen und die Primärzone", async () => {
    const harness = await household();
    const { core, server, sample } = harness;
    // ohne die Packung jenseits der Aufbewahrung, die dieses Gerät nie bekommen hat
    const known = (zoneId: string) => sample.packages.filter((pkg) => pkg.zone_id === zoneId).length;
    const inShelf = known(ZONE_IDS.shelf);
    const inCellar = known(ZONE_IDS.cellar);
    await core.prefs.update({ scan_zone_id: ZONE_IDS.shelf });

    await expectCoreError(core.zones.remove(ZONE_IDS.shelf, ZONE_IDS.shelf), "invalid");
    await expectCoreError(core.zones.remove(ZONE_IDS.shelf, "10000000-0000-4000-8000-000000000099"), "not_found");
    await core.zones.remove(ZONE_IDS.shelf, ZONE_IDS.cellar);

    expect(value(core.data.zones).some((zone) => zone.id === ZONE_IDS.shelf)).toBe(false);
    expect(value(core.data.settings).primary_zone_id).toBe(ZONE_IDS.cellar);
    expect(value(core.prefs.value).scan_zone_id).toBeNull();
    expect(value(core.data.packages).some((pkg) => pkg.zone_id === ZONE_IDS.shelf)).toBe(false);

    await syncClean(harness);
    expect([...server.data.packages.values()].filter((pkg) => pkg.zone_id === ZONE_IDS.cellar)).toHaveLength(inShelf + inCellar);
    expect(server.data.zones.get(ZONE_IDS.shelf)?.moved_to).toBe(ZONE_IDS.cellar);
    expect(value(core.data.settings).primary_zone_id).toBe(ZONE_IDS.cellar);
    // Einlagern in die gelöschte Zone geht nicht mehr.
    await expectCoreError(core.stock.store({ product: { kind: "new", name: "Reis" }, zone_id: ZONE_IDS.shelf, best_before: null, count: 1 }), "not_found");
  });

  it("lässt die letzte Zone nicht löschen", async () => {
    const { core } = await household("single-zone");
    expect(value(core.data.zones)).toHaveLength(1);
    await expectCoreError(core.zones.remove(ZONE_IDS.shelf, ZONE_IDS.cellar), "last_zone");
  });

  it("ändert Haushalts- und Geräte-Einstellungen", async () => {
    const harness = await household();
    const { core, another } = harness;
    await core.settings.update({ zone_mode: "equal", warn_days: 7 });
    expect(value(core.data.settings)).toMatchObject({ zone_mode: "equal", warn_days: 7, trash_retention_days: 30 });
    await expectCoreError(core.settings.update({ trash_retention_days: 0 }), "invalid");
    await expectCoreError(core.settings.update({ warn_days: 4000 }), "invalid");
    await expectCoreError(core.settings.update({ primary_zone_id: "10000000-0000-4000-8000-000000000099" }), "not_found");
    await expectCoreError(core.settings.update({ default_printer_id: "30000000-0000-4000-8000-000000000099" }), "not_found");
    await core.settings.update({ primary_zone_id: ZONE_IDS.cellar, default_printer_id: null });
    expect(value(core.data.settings)).toMatchObject({ primary_zone_id: ZONE_IDS.cellar, default_printer_id: null });

    await core.prefs.update({ scan_zone_id: ZONE_IDS.cellar });
    expect(value(core.prefs.value)).toMatchObject({ scan_zone_id: ZONE_IDS.cellar, print_labels: true });
    await expectCoreError(core.prefs.update({ scan_sound: "laut" as unknown as boolean }), "invalid");
    await syncClean(harness);
    expect(value(core.data.settings)).toMatchObject({ zone_mode: "equal", warn_days: 7, primary_zone_id: ZONE_IDS.cellar });

    // Geräte-Einstellungen sind dauerhaft, werden aber nie gesendet.
    core.dispose();
    const reloaded = await another();
    expect(value(reloaded.prefs.value)).toMatchObject({ scan_zone_id: ZONE_IDS.cellar, scan_sound: true });
  });

  it("zeigt in der Lösch-Historie weniger, wenn die Aufbewahrungsdauer sinkt", async () => {
    const { core } = await household();
    const before = value(core.data.removedPackages).length;
    await core.settings.update({ trash_retention_days: 2 });
    expect(value(core.data.removedPackages).length).toBeLessThan(before);
  });
});

describe("Sitzung und Sync", () => {
  it("meldet mit dem Haushalts-Passwort an", async () => {
    const { core } = await start();
    expect(value(core.session.state)).toEqual({ status: "signed_out", reason: "never", last_device_name: null });
    await expectCoreError(core.session.login("falsch", "Handy"), "invalid_password");
    await expectCoreError(core.session.login(FAKE_PASSWORD, " "), "invalid");
    await core.session.login(FAKE_PASSWORD, "Handy Küche");
    expect(value(core.session.state)).toMatchObject({ status: "signed_in", device: { name: "Handy Küche" } });
  });

  it("verwirft ungesendete Änderungen beim Abmelden nur auf Wunsch", async () => {
    const { core, network, server, another } = await household();
    network.offline = true;
    for (const name of ["A", "B", "C", "D"]) {
      await core.zones.create({ name });
    }
    const error = await expectCoreError(core.session.logout(), "pending_changes");
    expect(error.details.pending).toBe(4);
    expect(value(core.session.state).status).toBe("signed_in");
    expect(value(core.data.zones)).toHaveLength(8);

    // Abmelden gelingt auch offline.
    await core.session.logout({ discard_pending: true });
    expect(value(core.session.state)).toMatchObject({ status: "signed_out", reason: "logout" });
    // Die lokale Kopie, die Outbox und die Sync-Probleme sind gelöscht.
    expect(value(core.data.packages)).toEqual([]);
    expect(value(core.data.zones)).toEqual([]);
    expect(value(core.sync.status)).toMatchObject({ pending: 0, last_synced_at: null });
    expect(server.deviceList[0]?.revoked_at).toBeNull();

    // Das Token wird gesperrt, sobald der Server erreichbar ist.
    network.offline = false;
    await core.sync.now();
    await expect.poll(() => server.deviceList[0]?.revoked_at).not.toBeNull();

    // Auch nach dem Neuladen: abgemeldet, nichts mehr da.
    core.dispose();
    const reloaded = await another();
    expect(value(reloaded.session.state)).toMatchObject({ status: "signed_out", reason: "logout" });
    expect(value(reloaded.data.products)).toEqual([]);

    // Neu anmelden holt den Bestand wieder; die verworfenen Zonen gibt es nicht.
    await reloaded.session.login(FAKE_PASSWORD, "Handy");
    expect(value(reloaded.data.zones)).toHaveLength(4);
    expect((server.syncRequests.at(-1) as unknown as SyncRequest).dataset_id).toBeNull();
  });

  it("meldet ohne ungesendete Änderungen einfach ab und sperrt das Token", async () => {
    const { core, server } = await household();
    await core.session.logout();
    expect(value(core.session.state)).toMatchObject({ status: "signed_out", reason: "logout" });
    await expect.poll(() => server.deviceList[0]?.revoked_at).not.toBeNull();
  });

  it("sammelt Änderungen, solange der Server fehlt, und gleicht danach ab", async () => {
    const { core, network } = await household();
    network.offline = true;
    for (const name of ["A", "B", "C", "D"]) {
      await core.zones.create({ name });
    }
    await core.sync.now();
    expect(value(core.sync.status)).toMatchObject({ online: false, phase: "error", pending: 4 });

    await core.zones.create({ name: "Garage" });
    expect(value(core.sync.status).pending).toBe(5);
    await expectCoreError(core.devices.list(), "offline");
    await expectCoreError(core.backup.download(), "offline");

    await core.sync.now();
    expect(value(core.sync.status)).toMatchObject({ online: false, phase: "error", pending: 5 });
    expect(value(core.sync.status).last_error).toMatchObject({ code: "offline", at: NOW.toISOString() });

    network.offline = false;
    await core.sync.now();
    expect(value(core.sync.status)).toMatchObject({ online: true, phase: "idle", pending: 0, last_error: null });
  });

  it("zeigt abgelehnte und verdrängte Änderungen, bis sie ausgeblendet werden", async () => {
    const { core, server, network, another } = await household();
    const [first, second] = value(core.data.packages);
    network.offline = true;
    await core.stock.update([first?.id ?? ""], { best_before: "2029-01-01" });
    await core.stock.update([second?.id ?? ""], { best_before: "2029-02-02" });
    server.act({ type: "package.remove", package_id: first?.id, reason: "consumed" });
    server.forget("packages", second?.id ?? "");
    network.offline = false;
    await core.sync.now();

    const problems = value(core.sync.problems);
    expect(problems.map((problem) => problem.status).sort()).toEqual(["displaced", "rejected"]);
    expect(problems.every((problem) => problem.at === NOW.toISOString())).toBe(true);
    await core.sync.dismissProblem(problems[0]?.id ?? "");
    expect(value(core.sync.problems)).toHaveLength(1);

    // Die Probleme bleiben über das Neuladen, bis der Anwender sie wegklickt.
    core.dispose();
    const reloaded = await another();
    expect(value(reloaded.sync.problems)).toEqual([problems[1]]);
  });

  it("meldet ein gesperrtes Token", async () => {
    const { core, server } = await household();
    server.revoke();
    await core.sync.now();
    expect(value(core.session.state)).toMatchObject({ status: "signed_out", reason: "revoked" });
  });

  it("nennt nach dem Sperren und nach dem Abmelden den letzten Namen des Geräts", async () => {
    const { core, server, another } = await household();
    const session = value(core.session.state);
    await core.devices.rename(session.status === "signed_in" ? session.device.id : "", "Handy Keller");

    // Gesperrt: Die Anmeldung soll den bisherigen Namen vorschlagen können.
    server.revoke();
    await core.sync.now();
    expect(value(core.session.state)).toEqual({ status: "signed_out", reason: "revoked", last_device_name: "Handy Keller" });

    // Auch nach dem Neuladen.
    core.dispose();
    const reloaded = await another();
    expect(value(reloaded.session.state)).toEqual({ status: "signed_out", reason: "revoked", last_device_name: "Handy Keller" });

    // Wieder angemeldet unter einem neuen Namen, dann abgemeldet: Der Name überlebt das Löschen der lokalen Kopie.
    await reloaded.session.login(FAKE_PASSWORD, "Handy Küche");
    await reloaded.session.logout();
    expect(value(reloaded.session.state)).toEqual({ status: "signed_out", reason: "logout", last_device_name: "Handy Küche" });
    reloaded.dispose();
    const again = await another();
    expect(value(again.session.state)).toEqual({ status: "signed_out", reason: "logout", last_device_name: "Handy Küche" });

    // Abmelden aus dem gesperrten Zustand behält den Namen ebenfalls.
    await again.session.login(FAKE_PASSWORD, "Handy Küche");
    server.revoke();
    await again.sync.now();
    await again.session.logout({ discard_pending: true });
    expect(value(again.session.state)).toEqual({ status: "signed_out", reason: "logout", last_device_name: "Handy Küche" });
  });

  it("wirft bei sync.now() nie", async () => {
    const { core, network } = await household();
    network.offline = true;
    await expect(core.sync.now()).resolves.toBeUndefined();
    network.offline = false;
    network.respondWith = () => {
      throw new Error("kaputt");
    };
    await expect(core.sync.now()).resolves.toBeUndefined();
    expect(value(core.sync.status).phase).toBe("error");
  });
});

describe("Geräte und Sicherung (brauchen den Server)", () => {
  it("listet Geräte, benennt um und sperrt", async () => {
    const { core, server, network } = await household();
    const other = await (async () => {
      const response = await network.fetch("/api/auth/login", { method: "POST", body: JSON.stringify({ password: FAKE_PASSWORD, device_name: "Altes Tablet" }) });
      return ((await response.json()) as { device: { id: string } }).device.id;
    })();

    const devices = await core.devices.list();
    expect(devices.map((device) => [device.name, device.current])).toEqual([
      ["Dieses Gerät", true],
      ["Altes Tablet", false],
    ]);
    const mine = devices.find((device) => device.current);

    await expectCoreError(core.devices.rename(other, "  "), "invalid");
    await expectCoreError(core.devices.rename("50000000-0000-4000-8000-000000000099", "Niemand"), "not_found");
    expect((await core.devices.rename(other, " Tablet Keller ")).name).toBe("Tablet Keller");
    // Der eigene Name erscheint sofort in der Sitzung.
    await core.devices.rename(mine?.id ?? "", "Handy Flur");
    expect(value(core.session.state)).toMatchObject({ status: "signed_in", device: { name: "Handy Flur" } });

    await core.devices.revoke(other);
    expect(server.deviceList.find((device) => device.id === other)?.revoked_at).not.toBeNull();
    expect(value(core.session.state).status).toBe("signed_in");

    // Das eigene Gerät sperren meldet es ab; Daten und Outbox bleiben.
    await core.devices.revoke(mine?.id ?? "");
    expect(value(core.session.state)).toMatchObject({ status: "signed_out", reason: "revoked" });
    expect(value(core.data.packages).length).toBeGreaterThan(0);
    await expectCoreError(core.devices.list(), "unauthorized");
  });

  it("übernimmt den eigenen Namen aus der Geräteliste, wenn ein anderes Gerät dieses umbenannt hat", async () => {
    const { core, network } = await household();
    const mine = (await core.devices.list()).find((device) => device.current);
    // Ein zweites Gerät meldet sich an und benennt das erste um.
    const login = await network.fetch("/api/auth/login", { method: "POST", body: JSON.stringify({ password: FAKE_PASSWORD, device_name: "Tablet" }) });
    const { token } = (await login.json()) as { token: string };
    const renamed = await network.fetch(`/api/devices/${mine?.id ?? ""}`, { method: "PATCH", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "Handy Keller" }) });
    expect(renamed.status).toBe(200);
    // Bis zur nächsten Geräteliste kennt die Sitzung noch den alten Namen.
    expect(value(core.session.state)).toMatchObject({ status: "signed_in", device: { name: "Dieses Gerät" } });

    const devices = await core.devices.list();
    expect(devices.find((device) => device.current)?.name).toBe("Handy Keller");
    expect(value(core.session.state)).toMatchObject({ status: "signed_in", device: { id: mine?.id, name: "Handy Keller" } });
  });

  it("merkt beim nächsten Aufruf, dass das Token gesperrt wurde", async () => {
    const { core, server } = await household();
    server.revoke();
    await expectCoreError(core.devices.list(), "unauthorized");
    expect(value(core.session.state)).toMatchObject({ status: "signed_out", reason: "revoked" });
  });

  it("lädt die Sicherung als Blob mit dem Namen des Servers", async () => {
    const { core } = await household();
    const { blob, filename } = await core.backup.download();
    expect(filename).toBe("stowly-2026-11-13.sqlite3");
    expect(blob.size).toBeGreaterThan(10);
    expect((await blob.text()).startsWith("SQLite format 3")).toBe(true);
  });
});

describe("Drucker und Etiketten als Datenhaltung", () => {
  it("verwaltet Drucker und räumt Verweise beim Löschen auf", async () => {
    const harness = await household();
    const { core, server } = harness;
    const created = await core.printers.create({
      name: "Flur",
      connection: "server",
      server: { driver: "brother_ql", model: "QL-820NWB", address: "tcp://192.168.1.60:9100", media: "62" },
    });
    expect(created).toMatchObject({ name: "Flur", connection: "server", direct: null, deleted_at: null });
    expect(value(core.data.printers).map((printer) => printer.name)).toContain("Flur");
    await expectCoreError(core.printers.update(created.id, { direct: { urls: ["https://10.71.83.1:8443"], token: "t", printer: null } }), "invalid");
    await expectCoreError(core.printers.create({ name: "", connection: "direct", direct: { urls: ["https://10.71.83.1:8443"], token: "t", printer: null } }), "invalid");
    await expectCoreError(core.printers.create({ name: "Pi", connection: "direct", direct: { urls: [], token: "t", printer: null } }), "invalid");
    await core.printers.update(created.id, { name: "Flur oben" });
    expect(value(core.data.printers).map((printer) => printer.name)).toContain("Flur oben");

    await core.printers.remove(PRINTER_IDS.cellar);
    expect(value(core.data.zones).every((zone) => zone.printer_id !== PRINTER_IDS.cellar)).toBe(true);
    await core.printers.remove(PRINTER_IDS.kitchen);
    expect(value(core.data.settings).default_printer_id).toBeNull();
    await expectCoreError(core.printers.remove(PRINTER_IDS.kitchen), "not_found");

    await syncClean(harness);
    expect(server.data.printers.get(PRINTER_IDS.cellar)?.deleted_at).not.toBeNull();
    expect(value(core.data.printers).map((printer) => printer.name)).toEqual(["Flur oben"]);
  });

  it("führt Etiketten durch die Zustände, die ohne Druckdienst möglich sind", async () => {
    const harness = await household();
    const { core } = harness;
    const pkg = value(core.data.packages)[0];
    const [job] = await core.print.requestPackageLabels([pkg?.id ?? ""]);
    expect(job).toMatchObject({ state: "pending", kind: "package", package_id: pkg?.id, zone_id: null, printer_id: null });

    // Solange die Anforderung nicht abgeglichen ist, geht nichts an den Drucker am Server:
    // Dort gäbe es das Etikett noch nicht. `flush` wirft nicht. (Das Zustellen selbst prüft
    // src/core/print/delivery.test.ts.)
    const flushed = await core.print.flush();
    const state = (id: string) => value(core.data.printJobs).find((candidate) => candidate.id === id)?.state;
    expect(state(job?.id ?? "")).toBe("pending");
    expect(flushed.delivered).toBe(0);
    expect(flushed.pending).toBeGreaterThan(0);

    const unknown = value(core.data.printJobs).find((candidate) => candidate.state === "unknown");
    await expectCoreError(core.print.retry(job?.id ?? ""), "invalid");
    await core.print.resolveUnknown(unknown?.id ?? "", false);
    expect(value(core.data.printJobs).find((candidate) => candidate.id === unknown?.id)).toMatchObject({ state: "failed", error: "not_printed" });
    const retried = await core.print.retry(unknown?.id ?? "");
    expect(retried.id).not.toBe(unknown?.id);
    expect(retried.package_id).toBe(unknown?.package_id);
    expect(retried.printer_id).toBe(unknown?.printer_id);
    expect(state(unknown?.id ?? "")).toBe("failed");

    await core.print.cancel(retried.id);
    expect(state(retried.id)).toBe("cancelled");
    await expectCoreError(core.print.cancel(retried.id), "invalid");
    await expectCoreError(core.print.cancel("40000000-0000-4000-8000-000000000099"), "not_found");

    const zoneJob = await core.print.requestZoneLabel(ZONE_IDS.cellar, { printer_id: PRINTER_IDS.cellar });
    expect(zoneJob).toMatchObject({ kind: "zone", zone_id: ZONE_IDS.cellar, package_id: null, state: "pending", printer_id: PRINTER_IDS.cellar });
    await expectCoreError(core.print.requestZoneLabel(ZONE_IDS.cellar, { printer_id: "30000000-0000-4000-8000-000000000099" }), "not_found");

    await syncClean(harness);
    expect(state(retried.id)).toBe("cancelled");
    expect(state(zoneJob.id)).toBe("pending");
    // Der ausdrücklich gewählte Drucker überlebt das Verwerfen.
    expect(value(core.data.printJobs).find((candidate) => candidate.id === retried.id)?.printer_id).toBe(unknown?.printer_id);
  });

  it("fragt einen unbekannten Drucker nicht ab", async () => {
    const { core } = await household();
    await expectCoreError(core.printers.probe("30000000-0000-4000-8000-000000000099"), "not_found");
  });
});

describe("Die App selbst", () => {
  it("meldet Version und Umgebung; ohne Service Worker gibt es nichts zu aktualisieren und nichts zu installieren", async () => {
    const { core } = await household();
    expect(value(core.app.state)).toMatchObject({
      version: APP_VERSION,
      secure_context: true,
      installed: false,
      can_install: false,
      manual_install: null,
      update_ready: false,
      update_required: false,
    });
    await expect(core.app.applyUpdate()).resolves.toBeUndefined();
    await expect(core.app.promptInstall()).resolves.toBe(false);
  });
});

describe("Eigene Daten", () => {
  it("nimmt den Bestand, den der Server führt", async () => {
    const today = todayLocal(NOW);
    const { core, sample } = await household("sample", (data) => ({ ...data, packages: data.packages.slice(0, 2).map((pkg) => ({ ...pkg, best_before: addDays(today, 1) })) }));
    expect(value(core.data.packages)).toHaveLength(2);
    expect(value(core.data.products).length).toBe(sample.products.length);
  });

  it("startet in einem frisch eingerichteten Haushalt mit einer Zone und ohne Bestand", async () => {
    const { core } = await household("empty");
    expect(value(core.data.packages)).toEqual([]);
    expect(value(core.data.zones)).toHaveLength(1);
    expect(value(core.data.printers)).toEqual([]);
  });

  it("erfüllt die Schnittstelle vollständig", async () => {
    const { core } = await household("empty");
    const typed: Core = core;
    const groups = ["session", "sync", "data", "stock", "products", "zones", "settings", "prefs", "printers", "print", "devices", "backup", "app"] as const;
    for (const group of groups) {
      expect(typed[group], group).toBeTypeOf("object");
    }
  });
});
