/**
 * Statistik und Zustand der Integrationen im echten Kern, gegen die Nachbildung des Servers
 * (src/core/testing): Zeitraum, Fehler, leere Statistik, Zusammenführen und gelöschte Zonen,
 * Monate in der Zeitzone des Servers. Der Kern speichert davon nichts: Jeder Aufruf fragt.
 */
import { afterEach, describe, expect, it } from "vitest";

import { STATS_DEFAULT_MONTHS, type ErrorBody, type HaStatus } from "@/contract";

import type { StowlyCore } from ".";
import { HA_OFF } from "./testing/fake-api";
import { disposeAll, expectCoreError, firstZoneId, signedIn, start, value, type Harness } from "./testing/harness";

afterEach(disposeAll);

/** Die Aufrufe der Statistik, die den Server erreicht haben. */
function statsCalls(harness: Harness) {
  return harness.network.calls.filter((call) => call.path === "/api/stats");
}

/** Lagert `count` Packungen eines neuen Produkts ein und liefert Produkt und Packungs-IDs. */
async function stock(core: StowlyCore, name: string, zoneId: string, count: number): Promise<{ productId: string; ids: string[] }> {
  const stored = await core.stock.store({ product: { kind: "new", name }, zone_id: zoneId, best_before: null, count, labels: false });
  return { productId: stored.product.id, ids: stored.packages.map((pkg) => pkg.id) };
}

function errorBody(status: number, code: string, message: string): Response {
  const body: ErrorBody = { error: { code: code as ErrorBody["error"]["code"], message, details: null } };
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("Zeitraum", () => {
  it("ist ohne Angabe die 12 Monate bis zum laufenden; jeder Aufruf fragt den Server", async () => {
    const harness = await signedIn();
    const { core } = harness;
    const stats = await core.stats.load();
    expect(stats).toEqual({
      start: "2025-12",
      end: "2026-11",
      months: expect.any(Array),
      consumed: 0,
      discarded: 0,
      discarded_share: null,
      top_discarded: [],
      zones: [{ zone_id: firstZoneId(core), name: "Vorrat", consumed: 0, discarded: 0 }],
      timezone: "Europe/Berlin",
    });
    expect(stats.months).toHaveLength(STATS_DEFAULT_MONTHS);
    expect(stats.months[0]).toEqual({ month: "2025-12", consumed: 0, discarded: 0 });
    expect(stats.months.at(-1)).toEqual({ month: "2026-11", consumed: 0, discarded: 0 });
    // Ohne Angabe geht keine Abfrage mit; gespeichert wird nichts, der nächste Aufruf fragt wieder.
    expect(statsCalls(harness).map((call) => call.query)).toEqual([""]);
    await core.stats.load();
    expect(statsCalls(harness)).toHaveLength(2);
  });

  it("schickt nur, was angegeben ist", async () => {
    const harness = await signedIn();
    const { core } = harness;
    const quarter = await core.stats.load({ start: "2026-01", end: "2026-03" });
    expect(quarter).toMatchObject({ start: "2026-01", end: "2026-03" });
    expect(quarter.months.map((month) => month.month)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(await core.stats.load({ end: "2026-06" })).toMatchObject({ start: "2025-07", end: "2026-06" });
    expect(await core.stats.load({ start: "2026-10" })).toMatchObject({ start: "2026-10", end: "2026-11" });
    expect((await core.stats.load({ start: "2016-12", end: "2026-11" })).months).toHaveLength(120);
    expect(statsCalls(harness).map((call) => call.query)).toEqual(["start=2026-01&end=2026-03", "end=2026-06", "start=2026-10", "start=2016-12&end=2026-11"]);
  });

  it("zählt jeden Monat in der Zeitzone des Servers", async () => {
    const harness = await signedIn();
    const { core, server, clock } = harness;
    const { ids } = await stock(core, "Joghurt", firstZoneId(core), 1);
    await core.sync.now();
    // 23:30 UTC am letzten Oktober: In Berlin ist es schon der 1. November.
    clock.set(new Date("2026-10-31T23:30:00.000Z"));
    await core.stock.remove(ids, "consumed");
    await core.sync.now();
    const berlin = await core.stats.load();
    expect(berlin).toMatchObject({ end: "2026-11", timezone: "Europe/Berlin", consumed: 1 });
    expect(berlin.months.at(-1)).toEqual({ month: "2026-11", consumed: 1, discarded: 0 });

    // In New York ist es noch Oktober, auch der laufende Monat des Servers.
    server.timezone = "America/New_York";
    const newYork = await core.stats.load();
    expect(newYork).toMatchObject({ start: "2025-11", end: "2026-10", timezone: "America/New_York" });
    expect(newYork.months.at(-1)).toEqual({ month: "2026-10", consumed: 1, discarded: 0 });
    expect((await core.integrations.load()).timezone).toBe("America/New_York");
  });
});

describe("Gezählt", () => {
  it("wird beim Server nach dem heutigen Stand jeder Packung: Rückgängig zählt nicht, ein geänderter Grund schon, ein Versehen nie", async () => {
    const harness = await signedIn();
    const { core } = harness;
    const cellar = await core.zones.create({ name: "Keller" });
    const milk = await stock(core, "Milch", firstZoneId(core), 4);
    const quark = await stock(core, "Quark", cellar.id, 2);
    await core.sync.now();
    const [m1 = "", m2 = "", m3 = "", m4 = ""] = milk.ids;
    const [q1 = "", q2 = ""] = quark.ids;
    await core.stock.remove([m1, m2], "consumed");
    await core.stock.remove([m3], "mistake");
    await core.stock.remove([m4, q1], "discarded");
    await core.stock.remove([q2], "consumed");
    await core.stock.restore([q2]);
    await core.stock.remove([m1], "discarded");

    // Was noch in der Outbox wartet, kennt der Server nicht: Die Statistik kommt von ihm.
    expect(await core.stats.load()).toMatchObject({ consumed: 0, discarded: 0, discarded_share: null });
    await core.sync.now();
    const stats = await core.stats.load();
    expect(stats).toMatchObject({ consumed: 1, discarded: 3, discarded_share: 0.75 });
    expect(stats.months.at(-1)).toEqual({ month: "2026-11", consumed: 1, discarded: 3 });
    expect(stats.top_discarded).toEqual([
      { product_id: milk.productId, name: "Milch", barcode: null, discarded: 2 },
      { product_id: quark.productId, name: "Quark", barcode: null, discarded: 1 },
    ]);
    expect(stats.zones).toEqual([
      { zone_id: firstZoneId(core), name: "Vorrat", consumed: 1, discarded: 2 },
      { zone_id: cellar.id, name: "Keller", consumed: 0, discarded: 1 },
    ]);
  });

  it("führt Zusammengeführtes beim Ziel und Gelöschtes bei der Zone, in die es gewandert ist", async () => {
    const harness = await signedIn();
    const { core } = harness;
    const cellar = await core.zones.create({ name: "Keller" });
    const butter = await stock(core, "Butter", firstZoneId(core), 2);
    const margarine = await stock(core, "Margarine", cellar.id, 3);
    await core.sync.now();
    await core.stock.remove(butter.ids, "discarded");
    await core.stock.remove(margarine.ids.slice(0, 2), "discarded");
    await core.sync.now();
    expect((await core.stats.load()).top_discarded.map((product) => [product.name, product.discarded])).toEqual([
      ["Butter", 2],
      ["Margarine", 2],
    ]);

    await core.products.merge(margarine.productId, butter.productId);
    await core.zones.remove(cellar.id, firstZoneId(core));
    await core.sync.now();
    const stats = await core.stats.load();
    expect(stats.top_discarded).toEqual([{ product_id: butter.productId, name: "Butter", barcode: null, discarded: 4 }]);
    expect(stats.zones).toEqual([{ zone_id: firstZoneId(core), name: "Vorrat", consumed: 0, discarded: 4 }]);
    expect(stats).toMatchObject({ consumed: 0, discarded: 4, discarded_share: 1 });
  });
});

describe("Fehler", () => {
  it("weist einen ungültigen Zeitraum als invalid ab, mit dem Satz des Servers und seinen Stellen", async () => {
    const harness = await signedIn();
    const { core } = harness;
    const where = async (range: { start?: string; end?: string }) => {
      const error = await expectCoreError(core.stats.load(range), "invalid");
      expect(error.details.status).toBe(400);
      return { message: error.message, loc: (error.details.errors as { loc: string[] }[]).map((problem) => problem.loc) };
    };
    expect(await where({ start: "2026-13" })).toEqual({ message: "'start' muss ein Monat YYYY-MM sein (Jahre 0001 bis 9999).", loc: [["query", "start"]] });
    expect(await where({ start: "0000-12", end: "2026-1" })).toEqual({
      message: "'start' muss ein Monat YYYY-MM sein (Jahre 0001 bis 9999).",
      loc: [
        ["query", "start"],
        ["query", "end"],
      ],
    });
    // Leer ist eine Angabe, keine fehlende.
    expect((await where({ end: "" })).loc).toEqual([["query", "end"]]);
    expect(await where({ start: "2026-12", end: "2026-11" })).toEqual({ message: "'start' liegt nach 'end'.", loc: [["query", "start"]] });
    expect(await where({ start: "2016-11", end: "2026-11" })).toEqual({ message: "Der Zeitraum umfasst mehr als 120 Monate.", loc: [["query", "start"]] });
    // Was in einer Adresse etwas bedeutet, geht verpackt hinaus und kommt so beim Server an.
    expect((await where({ start: "2026-01&end=2026-02" })).loc).toEqual([["query", "start"]]);
    expect(statsCalls(harness).at(-1)?.query).toBe("start=2026-01%26end%3D2026-02");
    // Der Server hat geantwortet: Er gilt weiter als erreichbar.
    expect(value(core.sync.status).online).toBe(true);
  });

  it("braucht den Server: ohne ihn, mit einer fremden oder unbrauchbaren Antwort offline", async () => {
    const harness = await signedIn();
    const { core, network } = harness;
    network.offline = true;
    await expectCoreError(core.stats.load(), "offline");
    expect(value(core.sync.status).online).toBe(false);
    network.offline = false;

    // Die Anmeldeseite eines WLANs oder ein Proxy ohne Server: nicht der Stowly-Server.
    network.respondWith = (call) => (call.path === "/api/stats" ? new Response("<html>Anmelden</html>", { status: 200, headers: { "content-type": "text/html" } }) : null);
    await expectCoreError(core.stats.load(), "offline");
    network.respondWith = (call) => (call.path === "/api/stats" ? new Response(JSON.stringify({ start: "2026-01", months: "viele" }), { status: 200 }) : null);
    await expectCoreError(core.stats.load(), "offline");
    network.respondWith = (call) => (call.path === "/api/stats" ? new Response("Bad Gateway", { status: 502 }) : null);
    await expectCoreError(core.stats.load(), "offline");
    // Ein Server, der die Statistik noch nicht kann.
    network.respondWith = (call) => (call.path === "/api/stats" ? errorBody(501, "not_implemented", "Die Statistik ist noch nicht umgesetzt.") : null);
    await expectCoreError(core.stats.load(), "not_supported");
    network.respondWith = null;
    expect((await core.stats.load()).consumed).toBe(0);
  });

  it("braucht eine Anmeldung; ein gesperrtes Token meldet das Gerät ab", async () => {
    const fresh = await start();
    await expectCoreError(fresh.core.stats.load(), "unauthorized");
    expect(statsCalls(fresh)).toEqual([]);

    const harness = await signedIn();
    harness.server.revoke();
    await expectCoreError(harness.core.stats.load(), "unauthorized");
    expect(value(harness.core.session.state)).toMatchObject({ status: "signed_out", reason: "revoked" });
  });
});

describe("Zustand von Home Assistant", () => {
  it("kommt so, wie der Server ihn nennt; ohne Vorgabe aus", async () => {
    const harness = await signedIn();
    const { core, server } = harness;
    expect((await core.integrations.load()).ha).toEqual(HA_OFF);
    const failing: HaStatus = {
      configured: true,
      problem: null,
      entity: "todo.einkaufsliste",
      state: "unreachable",
      last_ok_at: "2026-11-13T07:00:00.000Z",
      last_error: "Home Assistant ist nicht erreichbar.",
      last_error_at: "2026-11-13T09:58:00.000Z",
      linked: 3,
      sensor: true,
    };
    server.haStatus = failing;
    expect((await core.integrations.load()).ha).toEqual(failing);
    server.haStatus = { ...HA_OFF, problem: "STOWLY_HA_TOKEN fehlt.", entity: "todo.einkaufsliste" };
    expect((await core.integrations.load()).ha).toMatchObject({ configured: false, state: "off", problem: "STOWLY_HA_TOKEN fehlt." });
  });
});
