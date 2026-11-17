/**
 * Einrichtung im Kern gegen die Nachbildung des Servers (docs/sync-protokoll.md 5, 11.6 bis 11.8):
 * erstes Passwort, Passwort ändern, Stand der Einrichtung, Einstellungen des Servers samt Push,
 * Pi koppeln und die Prüfung, ob dieses Gerät HTTPS vertraut.
 */
import { afterEach, describe, expect, it } from "vitest";

import { ENDPOINTS, LIMITS, type PiPairing, type UpdateStatus } from "@/contract";

import type { PermissionValue, PushEnvironment } from "./push/device";
import { FakePrintService } from "./testing/fake-api";
import { disposeAll, expectCoreError, signedIn, start, value } from "./testing/harness";

afterEach(disposeAll);

const NEW_PASSWORD = "ein langes Haushalts-Passwort";

/** Ein Browser, der Push kann, aber noch kein Abo und keine Erlaubnis hat. */
function pushBrowser(): PushEnvironment {
  const permission: PermissionValue = "default";
  return {
    support: () => null,
    permission: () => permission,
    requestPermission: () => Promise.resolve(permission),
    pushManager: () => Promise.resolve({ getSubscription: () => Promise.resolve(null), subscribe: () => Promise.reject(new Error("nicht im Test")) }),
    origin: "https://192.168.1.10:8443",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("Hat der Server ein Passwort?", () => {
  it("liest server_configured aus der Prüfung des Servers, auch abgemeldet", async () => {
    const { core, server } = await start();
    expect(value(core.sync.status).server_configured).toBeNull();

    server.configured = false;
    await core.sync.now();
    expect(value(core.sync.status)).toMatchObject({ online: true, server_configured: false });

    server.configured = true;
    await core.sync.now();
    expect(value(core.sync.status).server_configured).toBe(true);
  });

  it("setzt false nach einer Anmeldung mit not_configured und true nach einer gelungenen", async () => {
    const { core, server } = await start();
    server.configured = false;
    await expectCoreError(core.session.login("stowly", "Handy"), "not_configured");
    expect(value(core.sync.status)).toMatchObject({ online: true, server_configured: false });

    server.configured = true;
    await core.session.login("stowly", "Handy");
    expect(value(core.sync.status).server_configured).toBe(true);
  });
});

describe("Erstes Passwort", () => {
  it("setzt es, meldet dieses Gerät damit an, und andere Geräte melden sich damit an", async () => {
    const harness = await start();
    const { core, server, network } = harness;
    server.configured = false;
    await core.sync.now();

    await core.session.createPassword(NEW_PASSWORD, "Küche");
    expect(value(core.session.state)).toMatchObject({ status: "signed_in", device: { name: "Küche" } });
    expect(value(core.sync.status).server_configured).toBe(true);
    expect(network.calls.find((call) => call.path === ENDPOINTS.setup_password.path)?.body).toEqual({ password: NEW_PASSWORD, device_name: "Küche" });
    // Wie nach der Anmeldung: Zonen und Einstellungen liegen vor.
    expect(value(core.data.zones)).toHaveLength(1);
    expect(server.setupStatus().password_source).toBe("app");

    const second = await harness.another({ dbName: `${harness.dbName}-zweites` });
    await expectCoreError(second.session.login("stowly", "Flur"), "invalid_password");
    await second.session.login(NEW_PASSWORD, "Flur");
    expect(value(second.session.state).status).toBe("signed_in");
  });

  it("meldet conflict, wenn inzwischen ein Passwort gesetzt ist; die Schranke wechselt dann zur Anmeldung", async () => {
    const { core, server } = await start();
    server.configured = false;
    await core.sync.now();
    expect(value(core.sync.status).server_configured).toBe(false);

    // Ein anderes Gerät war schneller.
    server.configured = true;
    await expectCoreError(core.session.createPassword(NEW_PASSWORD, "Küche"), "conflict");
    expect(value(core.sync.status).server_configured).toBe(true);
    expect(value(core.session.state)).toEqual({ status: "signed_out", reason: "never", last_device_name: null });
  });

  it("lehnt ein zu kurzes Passwort ohne Anfrage ab", async () => {
    const { core, server, network } = await start();
    server.configured = false;
    const error = await expectCoreError(core.session.createPassword("kurz", "Küche"), "invalid");
    expect(error.message).toBe(`Das Passwort braucht mindestens ${String(LIMITS.password_min)} Zeichen.`);
    await expectCoreError(core.session.createPassword(NEW_PASSWORD, " "), "invalid");
    expect(network.calls.some((call) => call.path === ENDPOINTS.setup_password.path)).toBe(false);
    expect(server.configured).toBe(false);
  });
});

describe("Passwort ändern", () => {
  it("ändert es; ein falsches bisheriges Passwort meldet invalid_password, und das Gerät bleibt angemeldet", async () => {
    const harness = await signedIn();
    const { core, network } = harness;

    await expectCoreError(core.session.changePassword("falsch", NEW_PASSWORD), "invalid_password");
    expect(value(core.session.state).status).toBe("signed_in");
    expect(network.calls.filter((call) => call.path === ENDPOINTS.change_password.path)).toHaveLength(1);

    // Zu kurz: ohne Anfrage.
    await expectCoreError(core.session.changePassword("stowly", "kurz"), "invalid");
    expect(network.calls.filter((call) => call.path === ENDPOINTS.change_password.path)).toHaveLength(1);

    await core.session.changePassword("stowly", NEW_PASSWORD);
    expect(network.calls.at(-1)?.body).toEqual({ current_password: "stowly", new_password: NEW_PASSWORD });
    expect(value(core.session.state).status).toBe("signed_in");

    const second = await harness.another({ dbName: `${harness.dbName}-zweites` });
    await expectCoreError(second.session.login("stowly", "Flur"), "invalid_password");
    await second.session.login(NEW_PASSWORD, "Flur");
    // Das erste Gerät gleicht weiter ab.
    await core.sync.now();
    expect(value(core.sync.status).last_error).toBeNull();
  });

  it("meldet conflict, wenn das Passwort aus der Umgebung kommt", async () => {
    const { core, server } = await signedIn();
    server.passwordSource = "env";
    await expectCoreError(core.session.changePassword("stowly", NEW_PASSWORD), "conflict");
    expect(value(core.session.state).status).toBe("signed_in");
  });
});

describe("Stand der Einrichtung", () => {
  it("lädt die Schritte und ändert sie", async () => {
    const { core, server } = await signedIn();
    const status = await core.setup.load();
    expect(status.steps.map((step) => [step.id, step.state, step.ready])).toEqual([
      ["https", "open", false],
      ["printer", "open", false],
      ["backup", "open", false],
      ["updates", "open", false],
      ["notifications", "open", true],
      ["home_assistant", "open", false],
    ]);
    expect(status.finished_at).toBeNull();
    expect(status.https).toMatchObject({ enabled: true, port: 8443, origins: ["https://192.168.1.10:8443"] });

    const skipped = await core.setup.update({ step: { id: "printer", state: "skipped" } });
    expect(skipped.steps.find((step) => step.id === "printer")).toMatchObject({ state: "skipped", ready: false });
    const finished = await core.setup.update({ finished: true });
    expect(finished.finished_at).not.toBeNull();
    expect(server.setupFinishedAt).toBe(finished.finished_at);

    const moved = await core.setup.update({ https_port: 8444, addresses: ["stowly.fritz.box"] });
    expect(moved.https.origins).toEqual(["https://192.168.1.10:8444", "https://stowly.fritz.box:8444"]);
    const error = await expectCoreError(core.setup.update({ addresses: ["8.8.8.8"] }), "invalid");
    expect(error.details.errors).toEqual([{ loc: ["body", "addresses", 0], msg: "Die Adresse liegt nicht im Heimnetz.", type: "value_error" }]);
  });

  it("braucht den Server und eine Anmeldung", async () => {
    const harness = await signedIn();
    harness.network.offline = true;
    await expectCoreError(harness.core.setup.load(), "offline");
    const fresh = await start();
    await expectCoreError(fresh.core.setup.load(), "unauthorized");
  });
});

describe("Einstellungen des Servers", () => {
  it("setzt den Push-Kontakt: Push verlässt danach „nicht eingerichtet“", async () => {
    const { core, server, network } = await signedIn({ core: { push: pushBrowser() } });
    server.pushConfigured = false;
    await core.push.disable();
    // Der Kern fragt beim Server nach: 503, also nicht eingerichtet.
    await expectCoreError(core.push.test(), "not_configured");
    expect(value(core.push.state)).toBe("not_configured");

    const config = await core.serverConfig.update({ push_contact: " haushalt@example.org " });
    expect(network.calls.at(-1)?.body).toEqual({ push_contact: "mailto:haushalt@example.org" });
    expect(config.push).toEqual({ contact: "mailto:haushalt@example.org", source: "app" });
    await expect.poll(() => value(core.push.state)).toBe("off");
  });

  it("prüft den Kontakt vorher und meldet, was aus der Umgebung kommt", async () => {
    const { core, server, network } = await signedIn();
    const before = network.calls.length;
    await expectCoreError(core.serverConfig.update({ push_contact: "kein Kontakt" }), "invalid");
    expect(network.calls).toHaveLength(before);

    // Vorgabe der Nachbildung: der Kontakt aus STOWLY_PUSH_CONTACT.
    await expectCoreError(core.serverConfig.update({ push_contact: "haushalt@example.org" }), "conflict");
    expect((await core.serverConfig.load()).push.source).toBe("env");

    // Der Schalter für Updates.
    const on = await core.serverConfig.update({ update_enabled: true });
    expect(on.update).toEqual({ enabled: true, repo: "beispiel/stowly", source: "app", available: true });
    expect((await core.integrations.load()).update).toMatchObject({ configured: true, repo: "beispiel/stowly" });
    server.updateRepoDefault = null;
    server.updateSwitch = null;
    await expectCoreError(core.serverConfig.update({ update_enabled: true }), "conflict");
  });
});

describe("Pi koppeln", () => {
  it("erzeugt Code und Befehl, folgt dem Stand und holt den gekoppelten Drucker mit dem Abgleich", async () => {
    const { core, server } = await signedIn();
    const created = await core.printers.pair({ origin: "http://192.168.1.10:8010" });
    expect(created.state).toBe("waiting");
    expect(created.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(created.command).toBe(`curl -fsSL http://192.168.1.10:8010/api/pi/install.sh | sudo sh -s -- ${created.code ?? ""}`);

    expect(await core.printers.pairing(created.id)).toMatchObject({ state: "waiting", code: null, command: null, pi: null });
    server.startPairing(created.id, "stowly-pi");
    expect(await core.printers.pairing(created.id)).toMatchObject({ state: "installing", pi: { hostname: "stowly-pi" } });

    const printer = server.completePairing(created.id, { address: "192.168.1.20", model: "QL-570" });
    expect(value(core.data.printers).some((candidate) => candidate.id === printer.id)).toBe(false);
    const paired: PiPairing = await core.printers.pairing(created.id);
    expect(paired).toMatchObject({ state: "paired", printer_id: printer.id, pi: { hostname: "stowly-pi", addresses: ["192.168.1.20"], model: "QL-570" } });
    // Der Drucker kommt mit dem Abgleich, den der Kern dafür anstößt.
    await expect.poll(() => value(core.data.printers).find((candidate) => candidate.id === printer.id)?.direct?.urls[0]).toBe("https://192.168.1.20:8443");
  });

  it("übernimmt einen vorhandenen Drucker, bricht ab und kennt abgelaufene Codes", async () => {
    const { core, server } = await signedIn();
    const existing = await core.printers.create({ name: "Keller", connection: "direct", direct: { urls: ["https://10.71.83.1:8443"], token: "alt", printer: null } });
    await core.sync.now();

    const first = await core.printers.pair({ origin: "https://192.168.1.10:8443", printer_id: existing.id });
    expect(first.command).toContain("http://192.168.1.10:8010/api/pi/install.sh");
    // Ein neuer Code bricht den älteren ab.
    const second = await core.printers.pair({ origin: "https://192.168.1.10:8443", printer_id: existing.id });
    expect((await core.printers.pairing(first.id)).state).toBe("cancelled");

    server.completePairing(second.id, { address: "192.168.1.30" });
    expect((await core.printers.pairing(second.id)).printer_id).toBe(existing.id);
    await expect.poll(() => value(core.data.printers).find((printer) => printer.id === existing.id)?.direct?.token).toBe("pi-token-stowly-pi");
    expect(value(core.data.printers).find((printer) => printer.id === existing.id)?.name).toBe("Keller");

    const third = await core.printers.pair({ origin: "https://192.168.1.10:8443" });
    server.expirePairing(third.id);
    expect((await core.printers.pairing(third.id)).state).toBe("expired");
    await core.printers.cancelPairing(third.id);
    // Unbekannt gilt als abgebrochen.
    await core.printers.cancelPairing("00000000-0000-4000-8000-000000000000");
    await expectCoreError(core.printers.pairing("00000000-0000-4000-8000-000000000000"), "not_found");
    await expectCoreError(core.printers.pair({ origin: "kein Ursprung" }), "invalid");
  });
});

describe("Gekoppelte Pi (SetupStatus.paired_printers)", () => {
  it("meldet je Drucker die jüngste Kopplung, früheste Ablaufzeit zuerst, ohne gelöschte Drucker", async () => {
    const { core, server } = await signedIn();
    expect((await core.setup.load()).paired_printers).toEqual([]);
    const first = await core.printers.pair({ origin: "http://192.168.1.10:8010" });
    const cellar = server.completePairing(first.id, { hostname: "keller-pi", not_after: "2028-01-01T00:00:00.000Z" });
    const second = await core.printers.pair({ origin: "http://192.168.1.10:8010" });
    const kitchen = server.completePairing(second.id, { hostname: "kueche-pi", address: "192.168.1.21", not_after: "2027-06-01T00:00:00.000Z", version: "0.5.0", model: null });
    // Seit 0.5.0 mit Version des Druckdienstes und Modell vom Koppeln: So sieht die App einen alten Pi ohne Abfrage.
    expect((await core.setup.load()).paired_printers).toEqual([
      { printer_id: kitchen.id, hostname: "kueche-pi", not_after: "2027-06-01T00:00:00.000Z", version: "0.5.0", model: null },
      { printer_id: cellar.id, hostname: "keller-pi", not_after: "2028-01-01T00:00:00.000Z", version: "0.3.0", model: "QL-570" },
    ]);

    // Neu gekoppelt: Es zählt die jüngste Kopplung.
    const again = await core.printers.pair({ origin: "http://192.168.1.10:8010", printer_id: cellar.id });
    server.completePairing(again.id, { hostname: "keller-pi", not_after: "2029-01-01T00:00:00.000Z" });
    expect((await core.setup.load()).paired_printers.map((entry) => [entry.printer_id, entry.not_after])).toEqual([
      [kitchen.id, "2027-06-01T00:00:00.000Z"],
      [cellar.id, "2029-01-01T00:00:00.000Z"],
    ]);

    // Ein gelöschter Drucker fällt weg.
    await core.sync.now();
    await core.printers.remove(kitchen.id);
    await core.sync.now();
    expect((await core.setup.load()).paired_printers.map((entry) => entry.printer_id)).toEqual([cellar.id]);
  });

  it("nimmt einen Stand ohne paired_printers an (älterer Server), prüft die Angabe aber, wenn sie da ist", async () => {
    const { core, server, network } = await signedIn();
    const { paired_printers: _paired, ...older } = server.setupStatus();
    network.respondWith = (call) => (call.path === ENDPOINTS.get_setup.path ? jsonResponse(older) : null);
    expect((await core.setup.load()).steps).toHaveLength(6);
    network.respondWith = (call) => (call.path === ENDPOINTS.get_setup.path ? jsonResponse({ ...older, paired_printers: [{ printer_id: 1 }] }) : null);
    await expectCoreError(core.setup.load(), "offline");
  });
});

describe("Vertraut dieses Gerät HTTPS?", () => {
  it("fragt ohne CORS und meldet true, sobald unter der Adresse etwas antwortet; sonst false", async () => {
    const { core, network } = await start();
    expect(await core.setup.reachesSecurely("https://192.168.1.10:8443")).toBe(false);

    network.attach("https://192.168.1.10:8443", new FakePrintService());
    expect(await core.setup.reachesSecurely("https://192.168.1.10:8443")).toBe(true);
    const call = network.attempts.at(-1);
    expect(call).toMatchObject({ path: "/api/health", mode: "no-cors", credentials: "omit", base: "https://192.168.1.10:8443" });
  });
});

describe("Antworten, die nicht vom Stowly-Server stammen", () => {
  it("gelten als „nicht erreichbar“", async () => {
    const { core, network } = await signedIn();
    network.respondWith = (call) => (["/api/setup", "/api/server-config"].includes(call.path) || call.path.startsWith("/api/pi/") ? jsonResponse({ hallo: "Welt" }) : null);
    await expectCoreError(core.setup.load(), "offline");
    await expectCoreError(core.setup.update({ finished: true }), "offline");
    await expectCoreError(core.serverConfig.load(), "offline");
    await expectCoreError(core.printers.pair({ origin: "http://192.168.1.10:8010" }), "offline");
    await expectCoreError(core.printers.pairing("00000000-0000-4000-8000-000000000000"), "offline");
  });

  it("lässt die neuen Felder von UpdateStatus zu, auch wenn ein älterer Server sie weglässt", async () => {
    const { core, server, network } = await signedIn();
    server.updateRepo = "beispiel/stowly";
    const { updater_kind: _kind, updater_version: _version, updater_command: _command, ...older } = server.updateStatus();
    network.respondWith = (call) => (call.path === ENDPOINTS.check_update.path ? jsonResponse(older) : null);
    expect(await core.update.check()).toMatchObject({ configured: true, repo: "beispiel/stowly" });

    const newer: UpdateStatus = { ...server.updateStatus(), updater_kind: "container", updater_version: "0.3.0", updater_command: "docker run …" };
    network.respondWith = (call) => (call.path === ENDPOINTS.check_update.path ? jsonResponse(newer) : null);
    expect(await core.update.check()).toMatchObject({ updater_kind: "container", updater_version: "0.3.0" });

    network.respondWith = (call) => (call.path === ENDPOINTS.check_update.path ? jsonResponse({ ...newer, updater_command: 42 }) : null);
    await expectCoreError(core.update.check(), "offline");
  });
});
