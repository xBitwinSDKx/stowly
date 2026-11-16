/**
 * Stufe B im Kern gegen die nachgebaute Schnittstelle: „Jetzt sichern" und die Dateien im Ordner,
 * eine Sicherung zurückspielen (laufend und beim ersten Start, samt Rückgängig) und Home Assistant
 * aus der App. Der Code dafür wird nachgeladen (admin.ts, restore.ts); hier zählt, dass er sich
 * verhält wie in src/contract/core.ts beschrieben.
 */
import { afterEach, describe, expect, it } from "vitest";

import { RESTORE_MAX_BYTES, type RestoreKind } from "@/contract";

import rawVectors from "../../../docs/vectors.json";
import { FAKE_HA_CHECK, FAKE_PASSWORD } from "./testing/fake-api";
import { disposeAll, expectCoreError, firstZoneId, signedIn, start, value } from "./testing/harness";

afterEach(disposeAll);

interface AgePair {
  secret: string;
  public: string;
}

const pairs = (rawVectors as unknown as { age_keys: { pairs: AgePair[]; key_file: { text: string } } }).age_keys;
const [KEY, OTHER] = pairs.pairs as [AgePair, AgePair, ...AgePair[]];

/** Eine Datei, wie sie der Browser beim Wählen liefert. */
function fileOf(bytes: Uint8Array | string): Blob {
  return new Blob([typeof bytes === "string" ? bytes : bytes.slice()], { type: "application/octet-stream" });
}

describe("Sicherung", () => {
  it("legt eine Sicherung an, nennt sie im Zustand und liefert sie verschlüsselt als Datei", async () => {
    const { core, server } = await signedIn();
    const config = await core.serverConfig.update({ backup_recipients: [KEY.public], current_password: FAKE_PASSWORD });
    expect(config.backup).toMatchObject({ enabled: true, recipients_source: "app", recipients: [{ key: KEY.public }], folder: "/data/backups", folder_source: "data" });

    const file = await core.backup.run();
    expect(file.size).toBeGreaterThan(0);
    const status = await core.integrations.load();
    expect(status.backup).toMatchObject({ configured: true, folder: "/data/backups", last_file: file.name, files: [file] });
    expect((await core.setup.load()).steps.find((step) => step.id === "backup")?.ready).toBe(true);

    const blob = await core.backup.file(file.name);
    expect(blob.size).toBe(file.size);
    // Verschlüsselt für den öffentlichen Schlüssel (in der Nachbildung: nur genannt).
    const text = await blob.text();
    expect(text.startsWith("age-encryption.org/v1")).toBe(true);
    expect(text).toContain(KEY.public);
    expect(server.backupFileList).toEqual([file]);
    // Nur Namen von Stowly, nie ein Pfad.
    await expectCoreError(core.backup.file("../stowly.sqlite3"), "not_found");
    await expectCoreError(core.backup.file("stowly-2020-01-01-0330.sqlite3.gz.age"), "not_found");
  });

  it("sagt, was fehlt: ohne Schlüssel 503, zu dicht 429, eine laufende 409", async () => {
    const { core, server } = await signedIn();
    await expectCoreError(core.backup.run(), "not_configured");
    await core.serverConfig.update({ backup_recipients: [KEY.public], current_password: FAKE_PASSWORD });
    server.backupRunning = true;
    await expectCoreError(core.backup.run(), "conflict");
    server.backupRunning = false;
    await core.backup.run();
    const limited = await expectCoreError(core.backup.run(), "rate_limited");
    expect(limited.details.retry_after_s).toBeGreaterThan(0);
  });

  it("braucht für einen neuen Schlüssel das Haushalts-Passwort, über die Bremse der Anmeldung; Entfernen nicht", async () => {
    const { core, clock } = await signedIn();
    const missing = await expectCoreError(core.serverConfig.update({ backup_recipients: [KEY.public] }), "invalid");
    expect(missing.details.errors).toEqual([{ loc: ["body", "current_password"], msg: missing.message, type: "missing" }]);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expectCoreError(core.serverConfig.update({ backup_recipients: [KEY.public], current_password: "falsch" }), "invalid_password");
    }
    // Gesperrt, auch mit dem richtigen; das Gerät bleibt angemeldet.
    await expectCoreError(core.serverConfig.update({ backup_recipients: [KEY.public], current_password: FAKE_PASSWORD }), "rate_limited");
    expect(core.session.state.get()).toMatchObject({ status: "signed_in" });
    clock.advance(61_000);
    await core.serverConfig.update({ backup_recipients: [KEY.public], current_password: FAKE_PASSWORD });
    // Dieselben Schlüssel noch einmal, umsortiert oder weniger: ohne Passwort.
    await core.serverConfig.update({ backup_recipients: [KEY.public, OTHER.public], current_password: FAKE_PASSWORD });
    await core.serverConfig.update({ backup_recipients: [OTHER.public, KEY.public] });
    expect((await core.serverConfig.update({ backup_recipients: [OTHER.public] })).backup.recipients.map((entry) => entry.key)).toEqual([OTHER.public]);
    await expectCoreError(core.serverConfig.update({ backup_recipients: [OTHER.public, KEY.public] }), "invalid");
  });

  it("lehnt einen geheimen Schlüssel ab, ohne ihn zu wiederholen; Werte aus der Umgebung sind gesperrt", async () => {
    const { core, server } = await signedIn();
    const rejected = await expectCoreError(core.serverConfig.update({ backup_recipients: [KEY.secret] }), "invalid");
    expect(rejected.message).not.toContain(KEY.secret);
    expect((await core.serverConfig.load()).backup.recipients).toEqual([]);

    server.backupEnvRecipients = [OTHER.public];
    server.backupEnvTime = "02:15";
    const config = await core.serverConfig.load();
    expect(config.backup).toMatchObject({ enabled: true, enabled_source: "env", recipients_source: "env", time: "02:15", time_source: "env" });
    await expectCoreError(core.serverConfig.update({ backup_recipients: [KEY.public], current_password: FAKE_PASSWORD }), "conflict");
    await expectCoreError(core.serverConfig.update({ backup_time: "04:00" }), "conflict");
    await expectCoreError(core.serverConfig.update({ backup_enabled: false }), "conflict");
  });
});

describe("Zurückspielen eines laufenden Stowly", () => {
  it("spielt eine Sicherung ein: falscher Schlüssel, Vorschau, Passwort, Neustart, neuer Bestand; dann Rückgängig", async () => {
    const harness = await signedIn();
    const { core, server } = harness;
    const zone = firstZoneId(core);
    await core.serverConfig.update({ backup_recipients: [KEY.public], current_password: FAKE_PASSWORD });
    await core.stock.store({ product: { kind: "new", name: "Reis" }, zone_id: zone, best_before: null, count: 2 });
    await core.sync.now();
    const backup = await core.backup.run();
    const blob = await core.backup.file(backup.name);

    // Danach ändert sich der Bestand.
    await core.stock.store({ product: { kind: "new", name: "Nudeln" }, zone_id: zone, best_before: null, count: 1 });
    await core.sync.now();
    expect(value(core.data.packages)).toHaveLength(3);
    const datasetBefore = server.datasetId;

    const progress: number[] = [];
    const uploaded = await core.restore.upload(blob, { onProgress: (step) => progress.push(step.loaded) });
    expect(uploaded).toMatchObject({ kind: "age", size: blob.size });
    expect(progress.at(-1)).toBe(blob.size);

    const wrong = await expectCoreError(core.restore.check(uploaded.upload_id, OTHER.secret), "invalid");
    expect(wrong.details.reason).toBe("wrong_key");
    const noKey = await expectCoreError(core.restore.check(uploaded.upload_id, "kein Schlüssel"), "invalid");
    expect(noKey.details.reason).toBe("not_a_key");
    // Die Schlüsseldatei als Ganzes geht auch.
    const preview = await core.restore.check(uploaded.upload_id, pairs.key_file.text);
    expect(preview).toMatchObject({ kind: "age", has_password: true, counts: { items: 2, products: 1 } });

    await expectCoreError(core.restore.apply({ restore_id: preview.restore_id, password: "falsch" }), "invalid_password");
    server.restartPolls = 1;
    await core.restore.apply({ restore_id: preview.restore_id, password: FAKE_PASSWORD });
    const done = await core.restore.waitForRestart();
    expect(done.state).toBe("done");
    expect(done.undo_until).not.toBeNull();
    expect(server.datasetId).not.toBe(datasetBefore);
    // Das Gerät bleibt angemeldet und lädt den Bestand neu.
    await core.sync.now();
    expect(value(core.session.state).status).toBe("signed_in");
    expect(value(core.data.packages)).toHaveLength(2);

    await core.restore.undo();
    expect((await core.restore.waitForRestart()).state).toBe("undone");
    await core.sync.now();
    expect(value(core.data.packages)).toHaveLength(3);

    await core.restore.discardPrevious();
    expect((await core.restore.status()).undo_until).toBeNull();
    await expectCoreError(core.restore.undo(), "not_found");
  });

  it("prüft vor dem Hochladen die Größe und sagt, was keine Sicherung ist", async () => {
    const { core, server, network } = await signedIn();
    const huge = fileOf("x");
    Object.defineProperty(huge, "size", { value: RESTORE_MAX_BYTES + 1 });
    const calls = network.calls.length;
    await expectCoreError(core.restore.upload(huge), "invalid");
    expect(network.calls.length).toBe(calls);
    await expectCoreError(core.restore.upload(fileOf("")), "invalid");

    const foreign = await expectCoreError(core.restore.upload(fileOf("PK\u0003\u0004 ein Zip")), "invalid");
    expect(foreign.details.reason).toBe("not_stowly");

    server.restoreMaxBytes = 4;
    const big = await expectCoreError(core.restore.upload(fileOf("SQLite format 3\u0000…")), "invalid");
    expect(big.message).toMatch(/zu groß/);

    server.restoreMaxBytes = RESTORE_MAX_BYTES;
    server.restoreBusy = true;
    await expectCoreError(core.restore.upload(fileOf(server.backupBytes("sqlite"))), "conflict");
  });

  it("nimmt auch eine ältere, unverschlüsselte Sicherung ohne Schlüssel und bremst nach sechs Versuchen", async () => {
    const { core, server } = await signedIn();
    for (const kind of ["sqlite", "gzip"] as RestoreKind[]) {
      const uploaded = await core.restore.upload(fileOf(server.backupBytes(kind as "sqlite" | "gzip")));
      expect(uploaded.kind).toBe(kind);
      expect((await core.restore.check(uploaded.upload_id)).kind).toBe(kind);
    }
    // Vier Versuche sind gezählt; zwei gehen noch.
    await core.restore.upload(fileOf(server.backupBytes("sqlite")));
    await core.restore.upload(fileOf(server.backupBytes("sqlite")));
    const limited = await expectCoreError(core.restore.upload(fileOf(server.backupBytes("sqlite"))), "rate_limited");
    expect(limited.details.retry_after_s).toBeGreaterThan(0);
  });
});

describe("Zurückspielen beim ersten Start", () => {
  it("spielt ohne Anmeldung ein, wartet auf den Neustart und meldet mit dem gelieferten Zugang an", async () => {
    const harness = await signedIn();
    const { core, server } = harness;
    await core.stock.store({ product: { kind: "new", name: "Linsen" }, zone_id: firstZoneId(core), best_before: null, count: 3 });
    await core.sync.now();
    await core.serverConfig.update({ backup_recipients: [KEY.public], current_password: FAKE_PASSWORD });
    const blob = await core.backup.file((await core.backup.run()).name);

    // Ein neuer Server ohne Passwort, ein neues Gerät (wie nach einem Umzug).
    server.configured = false;
    server.revoke();
    const fresh = await harness.another({ dbName: `${harness.dbName}-neu` });
    const uploaded = await fresh.restore.upload(blob);
    const preview = await fresh.restore.check(uploaded.upload_id, KEY.secret);
    expect(preview.has_password).toBe(true);

    // Ohne Gerätename geht es nicht, mit falschem Passwort auch nicht.
    await expectCoreError(fresh.restore.apply({ restore_id: preview.restore_id, password: FAKE_PASSWORD }), "invalid");
    await expectCoreError(fresh.restore.apply({ restore_id: preview.restore_id, password: "falsch", device_name: "Neues Handy" }), "invalid_password");

    server.restartPolls = 1;
    await fresh.restore.apply({ restore_id: preview.restore_id, password: FAKE_PASSWORD, device_name: "Neues Handy" });
    expect(value(fresh.session.state)).toMatchObject({ status: "signed_in", device: { name: "Neues Handy" } });
    expect(value(fresh.sync.status).server_configured).toBe(true);
    expect(value(fresh.data.packages)).toHaveLength(3);
  });

  it("legt ohne Passwort in der Sicherung ein neues fest", async () => {
    const harness = await start();
    const { core, server } = harness;
    server.configured = false;
    const uploaded = await core.restore.upload(fileOf(server.backupBytes("sqlite")));
    const preview = await core.restore.check(uploaded.upload_id);
    expect(preview.has_password).toBe(false);
    await expectCoreError(core.restore.apply({ restore_id: preview.restore_id, password: "kurz", device_name: "Küche" }), "invalid");
    await core.restore.apply({ restore_id: preview.restore_id, password: "ein neues Passwort", device_name: "Küche" });
    expect(value(core.session.state).status).toBe("signed_in");
    // Ab jetzt gilt das neue Passwort.
    const second = await harness.another({ dbName: `${harness.dbName}-2` });
    await second.session.login("ein neues Passwort", "Flur");
    expect(value(second.session.state).status).toBe("signed_in");
  });
});

describe("Home Assistant aus der App", () => {
  it("speichert Adresse, Token und Liste, prüft die Verbindung und bindet den Token an die Adresse", async () => {
    const { core, server } = await signedIn();
    expect(await core.haConfig.load()).toMatchObject({ source: "default", configured: false, token_set: false, sensor: { source: "default", set: false } });

    // Ohne Token: HA antwortet, es fehlt der Token.
    expect((await core.haConfig.check({ url: "http://homeassistant.local:8123" })).state).toBe("token_needed");
    const saved = await core.haConfig.update({ url: " http://homeassistant.local:8123/ ", token: "ein-langer-token", entity: "todo.einkaufsliste" });
    expect(saved).toMatchObject({ source: "app", url: "http://homeassistant.local:8123", entity: "todo.einkaufsliste", token_set: true, configured: true });
    expect(JSON.stringify(saved)).not.toContain("ein-langer-token");
    expect((await core.integrations.load()).ha).toMatchObject({ configured: true, state: "pending", entity: "todo.einkaufsliste" });
    expect((await core.setup.load()).steps.find((step) => step.id === "home_assistant")?.ready).toBe(true);

    // Eine neue Adresse ohne Token löscht den gespeicherten.
    const moved = await core.haConfig.update({ url: "https://ha.example:8123" });
    expect(moved).toMatchObject({ url: "https://ha.example:8123", token_set: false, configured: false });

    await expectCoreError(core.haConfig.update({ entity: "Einkaufsliste" }), "invalid");
    await expectCoreError(core.haConfig.update({ url: "ftp://ha.example" }), "invalid");
    const removed = await core.haConfig.update({ url: null, entity: null, token: null });
    expect(removed).toMatchObject({ source: "default", configured: false });
  });

  it("liefert die Listen von HA, bremst zu dichte Prüfungen und sperrt Werte aus der Umgebung", async () => {
    const { core, server, clock } = await signedIn();
    server.haEnv = { url: "http://ha.local:8123", entity: "todo.einkaufsliste" };
    const check = await core.haConfig.check();
    expect(check.lists).toEqual(FAKE_HA_CHECK.lists);
    expect(check.entity_found).toBe(true);
    await expectCoreError(core.haConfig.check(), "rate_limited");
    clock.advance(5_000);
    await expectCoreError(core.haConfig.check({ url: "http://anderes.local:8123" }), "conflict");
    await expectCoreError(core.haConfig.update({ entity: "todo.baumarkt" }), "conflict");
    expect(await core.haConfig.load()).toMatchObject({ source: "env", url: "http://ha.local:8123", token_set: true });
  });

  it("erzeugt, zeigt und entfernt den Sensor-Token; aus der Umgebung 409", async () => {
    const { core, server } = await signedIn();
    await expectCoreError(core.haConfig.sensorToken(), "not_found");
    const token = await core.haConfig.createSensorToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await core.haConfig.sensorToken()).toBe(token);
    expect((await core.haConfig.load()).sensor).toMatchObject({ source: "app", set: true });
    expect(await core.haConfig.createSensorToken()).not.toBe(token);
    await core.haConfig.deleteSensorToken();
    expect((await core.haConfig.load()).sensor.set).toBe(false);

    server.haSensorEnv = "s".repeat(40);
    await expectCoreError(core.haConfig.sensorToken(), "conflict");
    await expectCoreError(core.haConfig.createSensorToken(), "conflict");
  });

  it("braucht den Server und eine Anmeldung", async () => {
    const { core, network } = await signedIn();
    network.offline = true;
    await expectCoreError(core.haConfig.load(), "offline");
    await expectCoreError(core.restore.status(), "offline");
    const anonymous = await start();
    await expectCoreError(anonymous.core.haConfig.load(), "unauthorized");
    await expectCoreError(anonymous.core.restore.status(), "unauthorized");
  });
});
