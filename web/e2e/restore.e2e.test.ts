/**
 * Sicherung und Zurückspielen gegen den echten Server (docs/plan-einrichtung-b.md, Abschnitte 1 und 2;
 * docs/sync-protokoll.md, 11.9):
 *
 * - Der Schlüssel entsteht wie in der App (web/src/features/backup/keys.ts), nur der öffentliche geht
 *   an den Server; „Jetzt sichern" legt eine verschlüsselte Sicherung in den Ordner, die sich
 *   herunterladen lässt.
 * - Danach ändern sich die Daten; ein falscher Schlüssel scheitert mit „wrong_key", der richtige
 *   zeigt die Vorschau; Stowly startet neu, alle Geräte laden den älteren Stand neu (`reset`), und
 *   „Rückgängig" holt den neueren zurück.
 * - Beim ersten Start eines neuen Servers: ohne Anmeldung hochladen und prüfen, mit dem Passwort aus
 *   der Sicherung einspielen; der Kern wartet den Neustart ab und ist danach angemeldet.
 *
 * Jeder Test startet seine eigenen Server.
 */
import { afterEach, describe, expect, it } from "vitest";

import { generateKeyPair, keyFile } from "@/features/backup/keys";

import { firstZone, stockedOf } from "./support/data";
import { disposeDevices, expectCoreError, newDevice, PASSWORD, signedIn, value, type Device } from "./support/device";
import { RawClient } from "./support/raw";
import { startServer, type ServerHandle } from "./support/server";

const servers: ServerHandle[] = [];

async function server(options: Parameters<typeof startServer>[0] = {}): Promise<ServerHandle> {
  const handle = await startServer(options);
  servers.push(handle);
  return handle;
}

afterEach(async () => {
  await disposeDevices();
  for (const handle of servers.splice(0)) {
    await handle.dispose();
  }
});

/**
 * Richtet die Sicherung wie die App ein: Schalter aus (kein Lauf von selbst dazwischen), der öffentliche
 * Schlüssel mit dem Haushalts-Passwort. Ohne das Passwort oder mit einem falschen nimmt der Server keinen
 * neuen Schlüssel an: Ein Geräte-Token allein darf keinen Schlüssel hinzufügen, der jede künftige Sicherung
 * öffnet.
 */
async function withKey(device: Device, password = PASSWORD): Promise<ReturnType<typeof generateKeyPair>> {
  const pair = generateKeyPair();
  const missing = await expectCoreError(device.core.serverConfig.update({ backup_recipients: [pair.public] }), "invalid");
  expect(missing.details.errors).toEqual([{ loc: ["body", "current_password"], msg: missing.message, type: "missing" }]);
  await expectCoreError(device.core.serverConfig.update({ backup_recipients: [pair.public], current_password: `${password}-falsch` }), "invalid_password");
  expect(device.core.session.state.get()).toMatchObject({ status: "signed_in" });
  expect((await device.core.serverConfig.load()).backup.recipients).toEqual([]);
  const config = await device.core.serverConfig.update({ backup_enabled: false, backup_recipients: [pair.public], current_password: password });
  expect(config.backup).toMatchObject({ enabled: false, enabled_source: "app", recipients_source: "app", recipients: [{ key: pair.public }] });
  expect(JSON.stringify(config)).not.toMatch(/AGE-SECRET-KEY/i);
  return pair;
}

/** Legt eine Sicherung an und lädt sie herunter, wie „Jetzt sichern" und „Herunterladen" in der App. */
async function backup(device: Device): Promise<Blob> {
  const file = await device.core.backup.run();
  expect(file.name).toMatch(/^stowly-\d{4}-\d{2}-\d{2}-\d{4}\.sqlite3\.gz\.age$/);
  const status = await device.core.integrations.load();
  expect(status.backup.files.map((entry) => entry.name)).toContain(file.name);
  const blob = await device.core.backup.file(file.name);
  expect(blob.size).toBe(file.size);
  expect(new TextDecoder().decode(new Uint8Array(await blob.slice(0, 21).arrayBuffer()))).toBe("age-encryption.org/v1");
  return blob;
}

describe("Zurückspielen eines laufenden Stowly", () => {
  it("spielt eine Sicherung ein: falscher Schlüssel, Vorschau, Neustart, alle Geräte laden neu; dann Rückgängig", { timeout: 240_000 }, async () => {
    const { url } = await server();
    const kitchen = await signedIn(url, "Küche");
    const cellar = await signedIn(url, "Keller");
    const zone = firstZone(kitchen);

    const pair = await withKey(kitchen);
    const rice = await kitchen.core.stock.store({ product: { kind: "new", name: "Reis R1" }, zone_id: zone.id, best_before: null, count: 2, labels: false });
    await kitchen.sync();
    const blob = await backup(kitchen);
    // Höchstens eine Sicherung auf Knopfdruck je Minute.
    expect((await expectCoreError(kitchen.core.backup.run(), "rate_limited")).details.retry_after_s).toBeGreaterThan(0);

    // Danach ändert sich der Bestand.
    const pasta = await kitchen.core.stock.store({ product: { kind: "new", name: "Nudeln R1" }, zone_id: zone.id, best_before: null, count: 1, labels: false });
    await kitchen.sync();
    await cellar.sync();
    expect(stockedOf(cellar, pasta.product.id)).toHaveLength(1);

    const uploaded = await kitchen.core.restore.upload(blob);
    expect(uploaded).toMatchObject({ kind: "age", size: blob.size });
    // Ein anderer Schlüssel, und der öffentliche statt des geheimen: abgelehnt, ohne Neues hochzuladen.
    expect((await expectCoreError(kitchen.core.restore.check(uploaded.upload_id, generateKeyPair().secret), "invalid")).details.reason).toBe("wrong_key");
    expect((await expectCoreError(kitchen.core.restore.check(uploaded.upload_id, pair.public), "invalid")).details.reason).toBe("not_a_key");
    // Der richtige, als ganze Schlüsseldatei wie von age-keygen.
    const preview = await kitchen.core.restore.check(uploaded.upload_id, keyFile(pair));
    // Das Passwort des Entwicklungsmodus gilt wie STOWLY_PASSWORD und steht nicht in der Datenbank.
    expect(preview).toMatchObject({ kind: "age", has_password: false, counts: { items: 2, products: 1 } });
    expect(preview.schema_version).toBe(preview.current_schema_version);

    await expectCoreError(kitchen.core.restore.apply({ restore_id: preview.restore_id, password: "nicht das Passwort" }), "invalid_password");
    await kitchen.core.restore.apply({ restore_id: preview.restore_id, password: PASSWORD });
    const done = await kitchen.core.restore.waitForRestart();
    expect(done.state).toBe("done");
    expect(done.undo_until).not.toBeNull();

    // Alle Geräte bleiben angemeldet und holen den älteren Stand vollständig neu.
    await kitchen.sync();
    expect(kitchen.net.lastSync.response?.reset).toBe(true);
    expect(stockedOf(kitchen, rice.product.id)).toEqual(rice.packages.map((pkg) => pkg.id).sort());
    expect(stockedOf(kitchen, pasta.product.id)).toEqual([]);
    await cellar.sync();
    expect(cellar.net.lastSync.response?.reset).toBe(true);
    expect(stockedOf(cellar, pasta.product.id)).toEqual([]);
    expect(value(cellar.core.session.state).status).toBe("signed_in");
    // Die Einstellungen des Servers bleiben die des laufenden Stowly: auch der Schlüssel.
    expect((await kitchen.core.serverConfig.load()).backup.recipients.map((recipient) => recipient.key)).toEqual([pair.public]);

    // Rückgängig: wieder mit Neustart, danach der neuere Stand.
    await kitchen.core.restore.undo();
    const undone = await kitchen.core.restore.waitForRestart();
    expect(undone.state).toBe("undone");
    await cellar.sync();
    expect(cellar.net.lastSync.response?.reset).toBe(true);
    expect(stockedOf(cellar, pasta.product.id)).toEqual(pasta.packages.map((pkg) => pkg.id));

    // Die alte Datenbank lässt sich vorzeitig löschen; danach geht Rückgängig nicht mehr.
    await kitchen.core.restore.discardPrevious();
    expect((await kitchen.core.restore.status()).undo_until).toBeNull();
    await expectCoreError(kitchen.core.restore.undo(), "not_found");
  });

  it("nimmt nur Sicherungen an und lässt ohne Anmeldung niemanden zurückspielen, sobald es ein Passwort gibt", async () => {
    const { url } = await server();
    const kitchen = await signedIn(url, "Küche");
    expect((await expectCoreError(kitchen.core.restore.upload(new Blob(["Das ist keine Sicherung."])), "invalid")).details.reason).toBe("not_stowly");
    await expectCoreError(kitchen.core.restore.check("0".repeat(32)), "not_found");

    const stranger = await newDevice(url, "Fremd");
    await expectCoreError(stranger.core.restore.upload(new Blob(["SQLite format 3\u0000"])), "unauthorized");
    const raw = RawClient.anonymous(url);
    expect((await raw.request("GET", "/api/restore")).status).toBe(401);
  });
});

describe("Wiederherstellen beim ersten Start", () => {
  it("spielt auf einem neuen Server ohne Anmeldung ein und ist nach dem Neustart angemeldet", { timeout: 240_000 }, async () => {
    // Der bisherige Stowly, mit einem Passwort aus der App (es steht dann in der Sicherung).
    const old = await server({ dev: false });
    const before = await newDevice(old.url, "Küche");
    await before.core.session.createPassword("das alte Haushalts-Passwort", "Küche");
    const pair = await withKey(before, "das alte Haushalts-Passwort");
    const lentils = await before.core.stock.store({ product: { kind: "new", name: "Linsen R2" }, zone_id: firstZone(before).id, best_before: null, count: 3, labels: false });
    await before.sync();
    const blob = await backup(before);

    // Der neue Server hat noch kein Passwort.
    const fresh = await server({ dev: false });
    const phone = await newDevice(fresh.url, "Neues Handy");
    await phone.trySync();
    expect(phone.status.server_configured).toBe(false);

    const uploaded = await phone.core.restore.upload(blob);
    const preview = await phone.core.restore.check(uploaded.upload_id, pair.secret);
    expect(preview).toMatchObject({ has_password: true, counts: { items: 3 } });
    await expectCoreError(phone.core.restore.apply({ restore_id: preview.restore_id, password: "ein anderes Passwort", device_name: "Neues Handy" }), "invalid_password");

    await phone.core.restore.apply({ restore_id: preview.restore_id, password: "das alte Haushalts-Passwort", device_name: "Neues Handy" });
    expect(value(phone.core.session.state)).toMatchObject({ status: "signed_in", device: { name: "Neues Handy" } });
    expect(phone.status.server_configured).toBe(true);
    expect(stockedOf(phone, lentils.product.id)).toEqual(lentils.packages.map((pkg) => pkg.id).sort());
    expect(((await (await fetch(`${fresh.url}/api/health`)).json()) as { configured: boolean }).configured).toBe(true);
    // Mit dem Passwort aus der Sicherung meldet sich jedes weitere Gerät an.
    const hall = await newDevice(fresh.url, "Flur");
    await hall.login("das alte Haushalts-Passwort");
    expect(stockedOf(hall, lentils.product.id)).toHaveLength(3);
    // Beim ersten Start gibt es kein Rückgängig.
    expect((await phone.core.restore.status()).undo_until).toBeNull();
  });
});
