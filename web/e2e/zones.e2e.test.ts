/**
 * Zonen über zwei Geräte: anlegen, umsortieren, löschen (`moved_to`), die letzte Zone.
 *
 * Die Tests bauen aufeinander auf und laufen in dieser Reihenfolge gegen einen Server.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { firstZone, stocked, zoneByName } from "./support/data";
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

function zoneNames(device: Awaited<ReturnType<typeof setup>>["kitchen"]): string[] {
  return value(device.core.data.zones).map((zone) => zone.name);
}

describe("Zonen", () => {
  it("legt Zonen hinter der letzten an und sortiert um", async () => {
    const { kitchen, cellar, raw } = await setup();

    const cellarZone = await kitchen.core.zones.create({ name: "Keller", icon: "cellar", color: "blue" });
    const freezer = await kitchen.core.zones.create({ name: "Gefriertruhe", icon: "snowflake" });
    expect(cellarZone).toMatchObject({ sort: 1, color: "blue", printer_id: null, deleted_at: null });
    expect(freezer).toMatchObject({ sort: 2, color: null });
    expect(zoneNames(kitchen)).toEqual(["Vorrat", "Keller", "Gefriertruhe"]);

    await kitchen.sync();
    await cellar.sync();
    expect(zoneNames(cellar)).toEqual(["Vorrat", "Keller", "Gefriertruhe"]);

    // Das andere Gerät sortiert um und benennt um.
    const vorrat = firstZone(cellar);
    await cellar.core.zones.reorder([freezer.id, vorrat.id, cellarZone.id]);
    await cellar.core.zones.update(cellarZone.id, { name: "Kellerregal", color: null, icon: "box" });
    expect(zoneNames(cellar)).toEqual(["Gefriertruhe", "Vorrat", "Kellerregal"]);
    await cellar.sync();
    await kitchen.sync();
    expect(zoneNames(kitchen)).toEqual(["Gefriertruhe", "Vorrat", "Kellerregal"]);
    expect(zoneByName(kitchen, "Kellerregal")).toMatchObject({ color: null, icon: "box", sort: 2 });
    await expectSameAsServer(kitchen, raw);
    await expectSameAsServer(cellar, raw);
  });

  it("löscht eine Zone: Packungen, Primärzone und spätere Verweise wandern in die Zielzone", async () => {
    const { kitchen, cellar, raw } = await setup();
    const shelf = zoneByName(kitchen, "Kellerregal");
    const freezer = zoneByName(kitchen, "Gefriertruhe");

    const stored = await kitchen.core.stock.store({ product: { kind: "new", name: "Erbsen Z2" }, zone_id: shelf.id, best_before: null, count: 3, labels: false });
    const [kept, taken, edited] = stored.packages.map((pkg) => pkg.id) as [string, string, string];
    await kitchen.core.stock.remove([taken], "consumed");
    await kitchen.core.settings.update({ primary_zone_id: shelf.id });
    await kitchen.sync();
    await cellar.sync();

    // Das andere Gerät löscht die Zone.
    await cellar.core.zones.remove(shelf.id, freezer.id);
    expect(zoneNames(cellar)).toEqual(["Gefriertruhe", "Vorrat"]);
    expect(stocked(cellar, kept).zone_id).toBe(freezer.id);
    expect(value(cellar.core.data.settings).primary_zone_id).toBe(freezer.id);
    await cellar.sync();
    const state = await expectSameAsServer(cellar, raw);
    const tombstone = state.zones.find((zone) => zone.id === shelf.id);
    expect(tombstone).toMatchObject({ moved_to: freezer.id });
    expect(tombstone?.deleted_at).not.toBeNull();
    // Auch die entnommene Packung ist umgezogen.
    expect(state.packages.find((pkg) => pkg.id === taken)).toMatchObject({ zone_id: freezer.id, removal_reason: "consumed" });
    expect(state.settings?.primary_zone_id).toBe(freezer.id);

    // Die Küche weiß davon noch nichts: Sie lagert in die gelöschte Zone ein und verschiebt dorthin.
    const late = await kitchen.core.stock.store({ product: { kind: "existing", product_id: stored.product.id }, zone_id: shelf.id, best_before: null, count: 1, labels: false });
    await kitchen.core.stock.update([edited], { zone_id: shelf.id, best_before: "2027-04-30" });
    await kitchen.sync();
    // Beides ist angewendet und folgt `moved_to`.
    expect(kitchen.net.lastSync.response?.results.map((result) => result.status)).toEqual(["applied", "applied"]);
    expect(value(kitchen.core.sync.problems)).toEqual([]);
    expect(stocked(kitchen, late.packages[0]?.id ?? "").zone_id).toBe(freezer.id);
    expect(stocked(kitchen, edited)).toMatchObject({ zone_id: freezer.id, best_before: "2027-04-30" });
    expect(zoneNames(kitchen)).toEqual(["Gefriertruhe", "Vorrat"]);
    await expectSameAsServer(kitchen, raw);
  });

  it("meldet das Bearbeiten einer inzwischen gelöschten Zone als Sync-Problem", async () => {
    const { kitchen, cellar, raw } = await setup();
    const doomed = await kitchen.core.zones.create({ name: "Vorratsschrank" });
    await kitchen.sync();
    await cellar.sync();

    await cellar.core.zones.remove(doomed.id, firstZone(cellar).id);
    await cellar.sync();

    await kitchen.core.zones.update(doomed.id, { name: "Schrank" });
    await kitchen.sync();
    const problems = value(kitchen.core.sync.problems);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ status: "rejected", code: "not_found", command: { type: "zone.update", zone_id: doomed.id } });
    expect(problems[0]?.message).toBeTruthy();
    // Die lokale Kopie folgt wieder dem Server.
    expect(zoneNames(kitchen)).toEqual(["Gefriertruhe", "Vorrat"]);
    await expectSameAsServer(kitchen, raw);

    await kitchen.core.sync.dismissProblem(problems[0]?.id ?? "");
    expect(value(kitchen.core.sync.problems)).toEqual([]);
  });

  it("lässt die letzte Zone nicht löschen, auch wenn zwei Geräte je eine der letzten beiden löschen", async () => {
    const { kitchen, cellar, raw } = await setup();
    const freezer = zoneByName(kitchen, "Gefriertruhe");
    const vorrat = zoneByName(kitchen, "Vorrat");
    expect(zoneNames(kitchen)).toEqual(["Gefriertruhe", "Vorrat"]);

    // Beide Geräte löschen offline je eine andere.
    await kitchen.core.zones.remove(freezer.id, vorrat.id);
    await cellar.core.zones.remove(vorrat.id, freezer.id);
    // Lokal weist der Kern die allerletzte sofort ab.
    await expectCoreError(kitchen.core.zones.remove(vorrat.id, freezer.id), "last_zone");

    await kitchen.sync();
    await cellar.sync();
    // Wer zuerst kommt, gewinnt; der zweite Befehl wird abgelehnt.
    const problems = value(cellar.core.sync.problems);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ status: "rejected", code: "last_zone", command: { type: "zone.delete", zone_id: vorrat.id } });
    expect(zoneNames(cellar)).toEqual(["Vorrat"]);
    await expectSameAsServer(cellar, raw);
    await kitchen.sync();
    await expectSameAsServer(kitchen, raw);
  });
});
