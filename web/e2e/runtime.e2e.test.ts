/**
 * Die Umgebung des Kerns gegen den echten Server: zwei Tabs eines Geräts, der Abgleich
 * im Hintergrund (so, wie ihn der Service Worker ausführt), mehrere Geräte gleichzeitig
 * und eine App mit anderer Protokollversion.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { CoreError } from "@/contract";
import { runBackgroundSync } from "@/core/background";

import { firstZone, stockedOf } from "./support/data";
import { Device, disposeDevices, signedIn, value } from "./support/device";
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

describe("Zwei Tabs eines Geräts", () => {
  it("teilen sich Bestand, Outbox und ID-Vorrat; jeder Befehl kommt genau einmal an", async () => {
    const device = await signedIn(server.url, "Küche");
    const raw = await RawClient.login(server.url);
    const first = device.core;
    const second = await device.secondTab();
    expect(value(second.session.state).status).toBe("signed_in");
    const zone = firstZone(device);

    // Der erste Tab lagert ein; der zweite sieht es, ohne dass abgeglichen wurde.
    const a = await first.stock.store({ product: { kind: "new", name: "Erbsen T1" }, zone_id: zone.id, best_before: null, count: 2, labels: false });
    await expect.poll(() => value(second.data.packages).filter((pkg) => pkg.product_id === a.product.id).length).toBe(2);
    expect(value(second.sync.status).pending).toBe(3);

    // Der zweite lagert dazu ein: Er nimmt die nächsten IDs aus dem gemeinsamen Vorrat, keine doppelt.
    const b = await second.stock.store({ product: { kind: "existing", product_id: a.product.id }, zone_id: zone.id, best_before: null, count: 2, labels: false });
    const pool = device.net.syncs[0]?.response?.id_pool.grant ?? [];
    expect([...a.packages, ...b.packages].map((pkg) => pkg.id)).toEqual(pool.slice(0, 4));

    // Beide gleichen gleichzeitig ab.
    const from = device.net.syncs.length;
    await Promise.all([first.sync.now(), second.sync.now()]);
    await expect.poll(() => value(first.sync.status).pending).toBe(0);
    await expect.poll(() => value(second.sync.status).pending).toBe(0);
    const results = device.net.resultsSince(from);
    expect(results.filter((result) => result.status !== "applied")).toEqual([]);
    expect(results.filter((result) => !result.duplicate)).toHaveLength(5);

    const state = await expectSameAsServer(device, raw);
    expect(state.packages.filter((pkg) => pkg.product_id === a.product.id)).toHaveLength(4);
    await expect.poll(() => value(second.data.packages).filter((pkg) => pkg.product_id === a.product.id).length).toBe(4);
  });
});

describe("Abgleich im Hintergrund", () => {
  it("sendet die Outbox ohne die Seite, mit derselben Datenbank", async () => {
    const device = await signedIn(server.url, "Handy");
    const other = await signedIn(server.url, "Tablet");
    const raw = await RawClient.login(server.url);
    const options = { fetch: device.net.fetch, now: device.clock.now, dbName: device.dbName };

    // Nichts zu tun: kein Aufruf an den Server.
    const before = device.net.syncs.length;
    expect(await runBackgroundSync(options)).toBeNull();
    expect(device.net.syncs).toHaveLength(before);

    const stored = await device.core.stock.store({ product: { kind: "new", name: "Mais H1" }, zone_id: firstZone(device).id, best_before: "2027-07-07", count: 2, labels: false });

    // Kein Netz: Der Aufruf wirft, damit der Browser es später erneut versucht; die Outbox bleibt.
    device.net.online = false;
    await expect(runBackgroundSync(options)).rejects.toBeInstanceOf(CoreError);
    expect(device.status.pending).toBe(3);

    device.net.online = true;
    const outcome = await runBackgroundSync(options);
    expect(outcome).toEqual({ ok: true, synced: true });
    // Der Hintergrund sendet kein `app_version`; die Seite tut es.
    expect(device.net.lastSync.request.app_version).toBeUndefined();
    expect(device.net.syncs[0]?.request.app_version).toBe("0.0.0-e2e");
    expect(device.net.lastSync.response?.results.map((result) => result.status)).toEqual(["applied", "applied", "applied"]);

    // Die offene Seite erfährt davon über die gemeinsame Datenbank.
    await expect.poll(() => device.status.pending).toBe(0);
    await other.sync();
    expect(stockedOf(other, stored.product.id)).toEqual(stored.packages.map((pkg) => pkg.id).sort());
    await device.sync();
    await expectSameAsServer(device, raw);
  });
});

describe("Mehrere Geräte gleichzeitig", () => {
  it("verbucht die Abgleiche von vier Geräten nacheinander, ohne einen zu verlieren", async () => {
    const raw = await RawClient.login(server.url);
    const devices = await Promise.all(["Eins", "Zwei", "Drei", "Vier"].map((name) => signedIn(server.url, name)));
    const products: string[] = [];
    for (const device of devices) {
      const zone = firstZone(device);
      const stored = await device.core.stock.store({ product: { kind: "new", name: `Parallel ${device.name}` }, zone_id: zone.id, best_before: null, count: 50, labels: false });
      await device.core.stock.update(
        stored.packages.map((pkg) => pkg.id),
        { best_before: "2027-12-12" },
      );
      products.push(stored.product.id);
    }

    await Promise.all(devices.map((device) => device.sync()));
    await Promise.all(devices.map((device) => device.sync()));

    const state = await raw.snapshot();
    for (const product of products) {
      const packages = state.packages.filter((pkg) => pkg.product_id === product);
      expect(packages).toHaveLength(50);
      expect(packages.every((pkg) => pkg.best_before === "2027-12-12")).toBe(true);
    }
    for (const device of devices) {
      expect(device.net.resultsSince(1).filter((result) => result.status !== "applied")).toEqual([]);
      await expectSameAsServer(device, raw);
    }
  });
});

describe("Selbsttätiger Abgleich", () => {
  it("sendet eine Änderung ohne Zutun wenige Sekunden später", async () => {
    const device = new Device(server.url, "Küche", true);
    const other = await signedIn(server.url, "Keller");
    await device.login();

    const from = device.net.syncs.length;
    const stored = await device.core.stock.store({ product: { kind: "new", name: "Linsen S1" }, zone_id: firstZone(device).id, best_before: null, count: 1, labels: false });
    await device.core.stock.update([stored.packages[0]?.id ?? ""], { best_before: "2027-06-06" });
    expect(device.status.pending).toBe(3);

    // Änderungen werden über höchstens zwei Sekunden zusammengefasst (Protokoll 9.4): ein Aufruf für alle drei Befehle.
    await expect.poll(() => device.status.pending, { timeout: 8_000, interval: 100 }).toBe(0);
    const sent = device.net.syncs.slice(from).filter((exchange) => exchange.request.commands.length > 0);
    expect(sent.map((exchange) => exchange.request.commands.length)).toEqual([3]);

    await other.sync();
    expect(stockedOf(other, stored.product.id)).toHaveLength(1);
  });
});

describe("Andere Protokollversion", () => {
  it("behält die Outbox und meldet protocol_mismatch, bis die Version wieder passt", async () => {
    const device = await signedIn(server.url, "Altes Handy");
    const raw = await RawClient.login(server.url);
    await device.core.stock.store({ product: { kind: "new", name: "Gerste V1" }, zone_id: firstZone(device).id, best_before: null, count: 1, labels: false });

    // Die App spricht eine Version, die der Server nicht kennt.
    device.net.rewriteSyncRequest = (body) => {
      body.protocol = 2;
    };
    const status = await device.trySync();
    expect(device.net.lastSync.status).toBe(409);
    expect(status).toMatchObject({ phase: "error", online: true, pending: 2 });
    expect(status.last_error?.code).toBe("protocol_mismatch");
    expect(value(device.core.session.state).status).toBe("signed_in");

    // Nach dem Aktualisieren der App geht alles hinaus.
    device.net.rewriteSyncRequest = null;
    await device.sync();
    await expectSameAsServer(device, raw);
  });
});
