/**
 * Die Statistik (Protokoll 11.1) mit dem echten Kern gegen den echten Server: einlagern in drei
 * Zonen, entnehmen als verbraucht, entsorgt und versehentlich, Rückgängig, ein nachträglich
 * geänderter Grund, Zusammenführen, eine gelöschte Zone; dazu ein ungültiger Zeitraum, kein
 * Server und was nur die Schnittstelle sieht (Anmeldung, Zwischenspeicher, doppelter Parameter).
 *
 * Der Server läuft in einer Zeitzone weit weg von UTC (STOWLY_TIMEZONE). Den laufenden Monat nimmt
 * der Test aus der Antwort (`end`), die Monate der Entnahmen aus den wirksamen Zeitpunkten, die der
 * Server selbst gemeldet hat: So wackelt nichts um Mitternacht. Ältere Entnahmen entstehen über die
 * Uhr des Geräts (`Device.ago`): Der Server rechnet mit dem Alter eines Befehls (Protokoll, 4).
 *
 * Die Tests teilen sich einen Server und laufen in dieser Reihenfolge: zuerst der leere Haushalt.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { STATS_DEFAULT_MONTHS, type ErrorBody, type Package, type Stats, type StoreResult } from "@/contract";

import { monthIn, monthsFrom, shiftMonth } from "./support/calendar";
import { firstZone, freshBarcode } from "./support/data";
import { DAY, disposeDevices, expectCoreError, signedIn, type Device } from "./support/device";
import { RawClient } from "./support/raw";
import { startServer, type ServerHandle } from "./support/server";

/** Zeitzone des Servers: weit weg von UTC, mit Sommerzeit auf der anderen Halbkugel. */
const TIMEZONE = "Pacific/Auckland";

let server: ServerHandle;

beforeAll(async () => {
  server = await startServer({ env: { STOWLY_TIMEZONE: TIMEZONE } });
});

afterAll(async () => {
  await server?.dispose();
});

afterEach(disposeDevices);

/** Lädt die Statistik und prüft, dass `end` der laufende Monat des Servers ist (vor oder nach dem Aufruf). */
async function loadCurrent(device: Device): Promise<Stats> {
  const before = new Date();
  const stats = await device.core.stats.load();
  const after = new Date();
  expect([monthIn(TIMEZONE, before), monthIn(TIMEZONE, after)]).toContain(stats.end);
  expect(stats.start).toBe(shiftMonth(stats.end, -(STATS_DEFAULT_MONTHS - 1)));
  expect(stats.months.map((month) => month.month)).toEqual(monthsFrom(stats.start, stats.end));
  expect(stats.timezone).toBe(TIMEZONE);
  return stats;
}

/** Je Monat verbraucht und entsorgt, nachgerechnet aus den wirksamen Zeitpunkten des Servers. */
function expectedMonths(packages: Iterable<Package>, start: string, end: string): Stats["months"] {
  const months = new Map(monthsFrom(start, end).map((month) => [month, { month, consumed: 0, discarded: 0 }]));
  for (const pkg of packages) {
    if (pkg.removed_at === null || (pkg.removal_reason !== "consumed" && pkg.removal_reason !== "discarded")) {
      continue;
    }
    const month = months.get(monthIn(TIMEZONE, pkg.removed_at));
    if (month) {
      month[pkg.removal_reason] += 1;
    }
  }
  return [...months.values()];
}

function idsOf(result: StoreResult): string[] {
  return result.packages.map((pkg) => pkg.id);
}

describe("Statistik", () => {
  it("ist ohne Entnommenes leer, mit jedem Monat und jeder Zone", async () => {
    const kitchen = await signedIn(server.url, "Küche");
    const stats = await loadCurrent(kitchen);
    expect(stats).toMatchObject({ consumed: 0, discarded: 0, discarded_share: null, top_discarded: [], zones: [{ zone_id: firstZone(kitchen).id, name: "Vorrat", consumed: 0, discarded: 0 }] });
    expect(stats.months).toHaveLength(STATS_DEFAULT_MONTHS);
    expect(stats.months.every((month) => month.consumed === 0 && month.discarded === 0)).toBe(true);
  });

  it("zählt beim Server nach dem heutigen Stand: Rückgängig, geänderter Grund, Zusammenführen und gelöschte Zone; versehentlich nie", async () => {
    const kitchen = await signedIn(server.url, "Küche");
    const pantry = firstZone(kitchen);
    const core = kitchen.core;
    const store = (name: string, zoneId: string, count: number) => core.stock.store({ product: { kind: "new", name }, zone_id: zoneId, best_before: null, count, labels: false });

    // Alles der Reihe nach, wie es geschah: Die wirksamen Zeitpunkte eines Geräts laufen nie rückwärts.
    const [cellar, garage] = await kitchen.ago(402 * DAY, async () => [await core.zones.create({ name: "Keller S" }), await core.zones.create({ name: "Garage S" })]);
    // Vor gut einem Jahr: Mehl, verbraucht. Das liegt vor dem Zeitraum ohne Angabe.
    const flour = await kitchen.ago(401 * DAY, () => store("Mehl S", pantry.id, 1));
    await kitchen.ago(400 * DAY, () => core.stock.remove(idsOf(flour), "consumed"));
    // Vor 50 Tagen eingelagert, in drei Zonen; ein Platzhalter über einen unbekannten Barcode.
    const yogurt = await kitchen.ago(50 * DAY, () => store("Joghurt S", pantry.id, 4));
    const quark = await kitchen.ago(50 * DAY, () => store("Quark S", cellar.id, 3));
    const skyr = await kitchen.ago(50 * DAY, () => store("Skyr S", cellar.id, 2));
    const juice = await kitchen.ago(50 * DAY, () => store("Saft S", garage.id, 2));
    const barcode = freshBarcode();
    const placeholder = await kitchen.ago(50 * DAY, () => core.stock.store({ product: { kind: "barcode", barcode }, zone_id: pantry.id, best_before: null, count: 1, labels: false }));
    const [y1 = "", y2 = "", y3 = "", y4 = ""] = idsOf(yogurt);
    const [q1 = "", q2 = "", q3 = ""] = idsOf(quark);
    const [s1 = "", s2 = ""] = idsOf(skyr);
    const [j1 = "", j2 = ""] = idsOf(juice);
    const [p1 = ""] = idsOf(placeholder);
    // Vor 40 Tagen: das erste entnommen, in einem früheren Monat.
    await kitchen.ago(40 * DAY, async () => {
      await core.stock.remove([y1], "discarded");
      await core.stock.remove([q1], "consumed");
    });
    // Heute.
    await core.stock.remove([y2, s2, j1, q3], "consumed");
    await core.stock.remove([y3, q2, s1, j2, p1], "discarded");
    await core.stock.remove([y4], "mistake");
    await core.stock.restore([q3]);
    // Der Grund nachträglich geändert; Skyr geht in Quark auf; die Garage wird zum Keller.
    await core.stock.remove([y2], "discarded");
    await core.products.merge(skyr.product.id, quark.product.id);
    await core.zones.remove(garage.id, cellar.id);
    await kitchen.sync();

    const stats = await loadCurrent(kitchen);
    // Verbraucht: Quark (vor 40 Tagen), Skyr, Saft. Entsorgt: dreimal Joghurt, Quark, Skyr, Saft, der Platzhalter.
    expect(stats).toMatchObject({ consumed: 3, discarded: 7, discarded_share: 0.7 });
    const reported = kitchen.net.serverPackages();
    expect(stats.months).toEqual(expectedMonths(reported.values(), stats.start, stats.end));
    // Was heute geschah, steht in einem Monat, wie der Server die Zeitpunkte meldet; meist im laufenden.
    const removedIn = (id: string) => {
      const removedAt = reported.get(id)?.removed_at;
      if (!removedAt) {
        throw new Error(`Die Packung ${id} ist beim Server nicht entnommen.`);
      }
      return monthIn(TIMEZONE, removedAt);
    };
    const current = removedIn(y3);
    if ([y2, s1, s2, j1, j2, p1, q2].every((id) => removedIn(id) === current)) {
      expect(stats.months.find((month) => month.month === current)).toEqual({ month: current, consumed: 2, discarded: 6 });
    }
    expect(removedIn(y1)).not.toBe(current);
    // Beim Ziel des Zusammenführens; bei Gleichstand nach Name, der Platzhalter ohne Namen zuletzt.
    expect(stats.top_discarded).toEqual([
      { product_id: yogurt.product.id, name: "Joghurt S", barcode: null, discarded: 3 },
      { product_id: quark.product.id, name: "Quark S", barcode: null, discarded: 2 },
      { product_id: juice.product.id, name: "Saft S", barcode: null, discarded: 1 },
      { product_id: placeholder.product.id, name: "", barcode, discarded: 1 },
    ]);
    // Jede Zone, die es noch gibt, in ihrer Reihenfolge; was in der Garage lag, zählt beim Keller.
    expect(stats.zones).toEqual([
      { zone_id: pantry.id, name: "Vorrat", consumed: 0, discarded: 4 },
      { zone_id: cellar.id, name: "Keller S", consumed: 3, discarded: 3 },
    ]);

    // Über die ganze Zeit: Ein Zeitraum ab dem Monat des Mehls zählt es mit.
    const flourMonth = removedIn(idsOf(flour)[0] ?? "");
    const all = await core.stats.load({ start: flourMonth, end: stats.end });
    expect(all).toMatchObject({ start: flourMonth, end: stats.end, consumed: 4, discarded: 7 });
    expect(all.months[0]).toEqual({ month: flourMonth, consumed: 1, discarded: 0 });
    expect(all.months).toEqual(expectedMonths(reported.values(), flourMonth, stats.end));
    // Nur der Monat des Mehls.
    expect(await core.stats.load({ start: flourMonth, end: flourMonth })).toMatchObject({ consumed: 1, discarded: 0, discarded_share: 0, top_discarded: [] });
  });

  it("weist einen ungültigen Zeitraum als invalid ab und scheitert ohne Server mit offline", async () => {
    const kitchen = await signedIn(server.url, "Küche");
    const where = async (range: { start?: string; end?: string }) => {
      const error = await expectCoreError(kitchen.core.stats.load(range), "invalid");
      // Der Satz des Servers ist der Rückfall für die Anzeige.
      expect(error.message.length).toBeGreaterThan(0);
      return (error.details.errors as { loc: string[] }[]).map((problem) => problem.loc);
    };
    expect(await where({ start: "2026-13" })).toEqual([["query", "start"]]);
    expect(await where({ end: "0000-01" })).toEqual([["query", "end"]]);
    expect(await where({ end: "" })).toEqual([["query", "end"]]);
    expect(await where({ start: "2026-1", end: "2026/02" })).toEqual([
      ["query", "start"],
      ["query", "end"],
    ]);
    // `start` nach `end` und mehr als 120 Monate: Welche der beiden Stellen, lässt der Vertrag offen.
    for (const range of [
      { start: "2026-02", end: "2026-01" },
      { start: "2016-01", end: "2026-01" },
      { start: "9999-12" },
    ]) {
      const [loc, ...rest] = await where(range);
      expect(rest).toEqual([]);
      expect(loc?.[0]).toBe("query");
      expect(["start", "end"]).toContain(loc?.[1]);
    }
    // Genau 120 Monate gehen.
    expect((await kitchen.core.stats.load({ start: "2016-02", end: "2026-01" })).months).toHaveLength(120);

    kitchen.net.online = false;
    await expectCoreError(kitchen.core.stats.load(), "offline");
    expect(kitchen.status.online).toBe(false);
  });

  it("antwortet nur angemeldeten Geräten, ohne Zwischenspeicher, und weist einen doppelten Parameter ab", async () => {
    const anonymous = await fetch(`${server.url}/api/stats`);
    expect(anonymous.status).toBe(401);
    expect(((await anonymous.json()) as ErrorBody).error.code).toBe("unauthorized");

    const raw = await RawClient.login(server.url);
    const ok = await raw.request("GET", "/api/stats?start=2026-01&end=2026-03");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(((await ok.json()) as Stats).months.map((month) => month.month)).toEqual(["2026-01", "2026-02", "2026-03"]);

    const twice = await raw.request("GET", "/api/stats?start=2026-01&start=2026-02");
    expect(twice.status).toBe(400);
    const body = (await twice.json()) as ErrorBody;
    expect(body.error.code).toBe("invalid_request");
    expect((body.error.details?.errors as { loc: string[] }[]).map((problem) => problem.loc)).toEqual([["query", "start"]]);
  });
});
