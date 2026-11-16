/**
 * Anmeldung, erster Abzug, ID-Vorrat, Geräteliste, Sicherung, Abmelden und Sperren:
 * der echte Kern gegen den echten Server.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { ID_POOL_TARGET, isPackageId, PROTOCOL_VERSION } from "@/contract";

import { disposeDevices, expectCoreError, newDevice, signedIn, value } from "./support/device";
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

describe("Anmeldung und erster Abzug", () => {
  it("meldet an, holt den vollständigen Bestand und einen vollen ID-Vorrat", async () => {
    const device = await newDevice(server.url, "Küche");
    expect(value(device.core.session.state)).toEqual({ status: "signed_out", reason: "never", last_device_name: null });

    await device.login();

    const state = value(device.core.session.state);
    expect(state.status).toBe("signed_in");
    expect(device.session.name).toBe("Küche");

    // Der erste Abgleich: ein vollständiger Abzug ohne eigenen Vorrat.
    const first = device.net.syncs[0];
    expect(first?.request).toMatchObject({ protocol: PROTOCOL_VERSION, dataset_id: null, cursor: 0, commands: [], id_pool: { have: 0 } });
    expect(first?.response?.reset).toBe(true);
    expect(first?.response?.has_more).toBe(false);
    expect(first?.response?.id_pool.target).toBe(ID_POOL_TARGET);
    const granted = first?.response?.id_pool.grant ?? [];
    expect(granted).toHaveLength(ID_POOL_TARGET);
    expect(new Set(granted).size).toBe(ID_POOL_TARGET);
    expect(granted.every(isPackageId)).toBe(true);

    // Die Grundausstattung des Servers: eine Zone, die Einstellungen, die Etikett-Vorlagen.
    const zones = value(device.core.data.zones);
    expect(zones).toHaveLength(1);
    expect(zones[0]).toMatchObject({ name: "Vorrat", icon: "shelf", sort: 0, deleted_at: null, moved_to: null });
    expect(value(device.core.data.settings)).toMatchObject({
      zone_mode: "primary",
      primary_zone_id: zones[0]?.id,
      warn_days: 14,
      trash_retention_days: 30,
      default_printer_id: null,
    });
    expect(value(device.core.data.packages)).toEqual([]);
    expect(value(device.core.data.products)).toEqual([]);
    expect(first?.response?.changes.label_templates.map((template) => template.key).sort()).toEqual(["package", "zone"]);

    const status = device.status;
    expect(status).toMatchObject({ online: true, phase: "idle", pending: 0, last_error: null });
    expect(status.last_synced_at).not.toBeNull();
    expect(status.server_version).toMatch(/^\d+\.\d+\.\d+/);

    await expectSameAsServer(device, await RawClient.login(server.url));
  });

  it("gibt zwei Geräten Vorräte ohne Überschneidung und füllt Verbrauchtes wieder auf", async () => {
    const kitchen = await signedIn(server.url, "Küche");
    const cellar = await signedIn(server.url, "Keller");
    const poolKitchen = kitchen.net.syncs[0]?.response?.id_pool.grant ?? [];
    const poolCellar = cellar.net.syncs[0]?.response?.id_pool.grant ?? [];
    expect(poolKitchen).toHaveLength(ID_POOL_TARGET);
    expect(poolCellar).toHaveLength(ID_POOL_TARGET);
    expect(poolKitchen.filter((id) => poolCellar.includes(id))).toEqual([]);

    // Eingelagert wird aus dem Vorrat, in der Reihenfolge der Zuteilung.
    const zone = value(kitchen.core.data.zones)[0];
    const stored = await kitchen.core.stock.store({ product: { kind: "new", name: "Reis" }, zone_id: zone?.id ?? "", best_before: null, count: 7 });
    expect(stored.packages.map((pkg) => pkg.id)).toEqual(poolKitchen.slice(0, 7));

    await kitchen.sync();
    const exchange = kitchen.net.lastSync;
    expect(exchange.request.id_pool.have).toBe(ID_POOL_TARGET - 7);
    const refill = exchange.response?.id_pool.grant ?? [];
    expect(refill).toHaveLength(7);
    expect(refill.filter((id) => poolKitchen.includes(id) || poolCellar.includes(id))).toEqual([]);
  });

  it("lehnt ein falsches Passwort ab und meldet das Gerät nicht an", async () => {
    const device = await newDevice(server.url, "Fremdes Gerät");
    await expectCoreError(device.login("falsch"), "invalid_password");
    expect(value(device.core.session.state)).toEqual({ status: "signed_out", reason: "never", last_device_name: null });
    expect(device.status.online).toBe(true);
    expect(device.net.syncs).toHaveLength(0);

    const raw = await RawClient.login(server.url);
    const list = (await (await raw.request("GET", "/api/devices")).json()) as { devices: { name: string }[] };
    expect(list.devices.map((entry) => entry.name)).not.toContain("Fremdes Gerät");
  });
});

describe("Geräte und Sicherung", () => {
  it("listet die Geräte und benennt eines um", async () => {
    const kitchen = await signedIn(server.url, "Küche A");
    const cellar = await signedIn(server.url, "Keller A");

    const list = await kitchen.core.devices.list();
    const own = list.find((entry) => entry.id === kitchen.session.id);
    const other = list.find((entry) => entry.id === cellar.session.id);
    expect(own).toMatchObject({ name: "Küche A", current: true, revoked_at: null });
    expect(other).toMatchObject({ name: "Keller A", current: false, revoked_at: null });
    expect(own?.last_seen_at).not.toBeNull();

    const renamed = await kitchen.core.devices.rename(cellar.session.id, "Kellerhandy");
    expect(renamed).toMatchObject({ id: cellar.session.id, name: "Kellerhandy", current: false });
    expect((await cellar.core.devices.list()).find((entry) => entry.current)?.name).toBe("Kellerhandy");
    // Das umbenannte Gerät übernimmt seinen neuen Namen mit der Geräteliste in die Sitzung.
    expect(cellar.session.name).toBe("Kellerhandy");

    // Das eigene Gerät: Der neue Name gilt sofort auch in der Sitzung.
    await kitchen.core.devices.rename(kitchen.session.id, "Küchentablet");
    expect(kitchen.session.name).toBe("Küchentablet");

    await expectCoreError(kitchen.core.devices.rename("00000000-0000-4000-8000-000000000000", "Niemand"), "not_found");
    await expectCoreError(kitchen.core.devices.rename(kitchen.session.id, "   "), "invalid");
  });

  it("gibt die Sicherung nur noch verschlüsselt heraus: ohne Schlüssel kein „Jetzt sichern“, keine Kopie im Klartext", async () => {
    const device = await signedIn(server.url, "Küche B");
    await expectCoreError(device.core.backup.run(), "not_configured");
    // Die frühere Kopie zum Herunterladen (GET /api/backup) gibt es nicht mehr.
    const raw = await RawClient.login(server.url, "Prüfer B");
    expect((await raw.request("GET", "/api/backup")).status).toBe(404);
    await expectCoreError(device.core.backup.file("stowly.sqlite3"), "not_found");
  });
});

describe("Abmelden und Sperren", () => {
  it("meldet ab, löscht die lokale Kopie und sperrt das Token beim Server", async () => {
    const kitchen = await signedIn(server.url, "Küche C");
    const cellar = await signedIn(server.url, "Keller C");
    const cellarId = cellar.session.id;
    const zone = value(cellar.core.data.zones)[0];

    // Mit ungesendeten Änderungen fragt der Kern nach.
    await cellar.core.stock.store({ product: { kind: "new", name: "Linsen" }, zone_id: zone?.id ?? "", best_before: null, count: 2 });
    const refused = await expectCoreError(cellar.core.session.logout(), "pending_changes");
    expect(refused.details.pending).toBe(3);
    expect(value(cellar.core.session.state).status).toBe("signed_in");

    await cellar.core.session.logout({ discard_pending: true });
    expect(value(cellar.core.session.state)).toMatchObject({ status: "signed_out", reason: "logout" });
    expect(value(cellar.core.data.packages)).toEqual([]);
    expect(value(cellar.core.data.zones)).toEqual([]);
    expect(cellar.status.pending).toBe(0);

    // Das Token wird im Hintergrund gesperrt; die Liste eines anderen Geräts zeigt es.
    await expect
      .poll(async () => (await kitchen.core.devices.list()).find((entry) => entry.id === cellarId)?.revoked_at ?? null, { timeout: 10_000 })
      .not.toBeNull();

    // Die verworfenen Änderungen sind nie beim Server angekommen.
    const snapshot = await (await RawClient.login(server.url)).snapshot();
    expect(snapshot.products.map((product) => product.name)).not.toContain("Linsen");
  });

  it("lässt ein gesperrtes Gerät Daten und Outbox behalten und reicht sie nach erneuter Anmeldung nach", async () => {
    const kitchen = await signedIn(server.url, "Küche D");
    const cellar = await signedIn(server.url, "Keller D");
    const oldId = cellar.session.id;
    const zone = value(cellar.core.data.zones)[0];

    const stored = await cellar.core.stock.store({ product: { kind: "new", name: "Bohnen D" }, zone_id: zone?.id ?? "", best_before: "2027-05-01", count: 2 });
    const packageIds = stored.packages.map((pkg) => pkg.id);
    expect(cellar.status.pending).toBe(3);

    await kitchen.core.devices.revoke(oldId);

    const status = await cellar.trySync();
    expect(status.last_error?.code).toBe("unauthorized");
    expect(value(cellar.core.session.state)).toMatchObject({ status: "signed_out", reason: "revoked" });
    // Daten und Outbox bleiben.
    expect(cellar.status.pending).toBe(3);
    expect(
      value(cellar.core.data.packages)
        .filter((pkg) => pkg.product_id === stored.product.id)
        .map((pkg) => pkg.id)
        .sort(),
    ).toEqual([...packageIds].sort());

    // Auch nach dem Neuladen der App. Der bisherige Name steht als Vorschlag für die Anmeldung bereit.
    await cellar.reload();
    expect(value(cellar.core.session.state)).toEqual({ status: "signed_out", reason: "revoked", last_device_name: "Keller D" });
    expect(cellar.status.pending).toBe(3);

    await cellar.login();
    expect(cellar.session.id).not.toBe(oldId);
    expect(cellar.status.pending).toBe(0);
    const results = cellar.net.lastSync.response?.results ?? [];
    expect(results.map((result) => result.status)).toEqual(["applied", "applied", "applied"]);

    await kitchen.sync();
    expect(
      value(kitchen.core.data.packages)
        .filter((pkg) => packageIds.includes(pkg.id))
        .map((pkg) => pkg.best_before),
    ).toEqual(["2027-05-01", "2027-05-01"]);
    const raw = await RawClient.login(server.url);
    await expectSameAsServer(cellar, raw);
    await expectSameAsServer(kitchen, raw);
  });

  it("meldet ein Gerät ab, das sich selbst sperrt", async () => {
    const device = await signedIn(server.url, "Küche E");
    await device.core.devices.revoke(device.session.id);
    expect(value(device.core.session.state)).toMatchObject({ status: "signed_out", reason: "revoked" });
    await expectCoreError(device.core.devices.list(), "unauthorized");
  });
});
