/**
 * Die Einrichtung gegen den echten Server (docs/sync-protokoll.md 5, 11.6 bis 11.8): das erste
 * Passwort ohne STOWLY_PASSWORD, Passwort ändern, Einstellungen des Servers und das Koppeln eines
 * Pi, den ein Gerät ohne Anmeldung spielt. Jeder Test startet seinen eigenen Server.
 */
import { afterEach, expect, it } from "vitest";

import { ENDPOINTS, type ErrorBody, type ServerConfig } from "@/contract";

import { disposeDevices, expectCoreError, newDevice, signedIn, value } from "./support/device";
import { makeCsr } from "./support/pi";
import { RawClient } from "./support/raw";
import { freePort, startServer, type ServerHandle } from "./support/server";

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

const FIRST = "das erste Haushalts-Passwort";
const SECOND = "das zweite Haushalts-Passwort";

it("setzt ohne STOWLY_PASSWORD das erste Passwort; ein zweiter Versuch gibt conflict", async () => {
  const { url } = await server({ dev: false });
  const kitchen = await newDevice(url, "Küche");
  // Die Prüfung des Servers läuft auch abgemeldet.
  await kitchen.trySync();
  expect(kitchen.status).toMatchObject({ online: true, server_configured: false });
  await expectCoreError(kitchen.login("stowly"), "not_configured");

  // Zu kurz: Das lehnt schon der Kern ab, ohne Anfrage.
  await expectCoreError(kitchen.core.session.createPassword("kurz", "Küche"), "invalid");
  await kitchen.core.session.createPassword(FIRST, "Küche");
  expect(value(kitchen.core.session.state)).toMatchObject({ status: "signed_in", device: { name: "Küche" } });
  expect(value(kitchen.core.data.zones)).toHaveLength(1);
  expect(kitchen.status.server_configured).toBe(true);
  expect(((await (await fetch(`${url}/api/health`)).json()) as { configured: boolean }).configured).toBe(true);

  // Ein zweites Gerät war zu langsam: conflict, danach die Anmeldung mit dem gesetzten Passwort.
  const hall = await newDevice(url, "Flur");
  await expectCoreError(hall.core.session.createPassword("noch ein Passwort", "Flur"), "conflict");
  expect(hall.status.server_configured).toBe(true);
  await expectCoreError(hall.login("noch ein Passwort"), "invalid_password");
  await hall.login(FIRST);

  // Auch ohne Kern: 409 im Fehlerformat.
  const again = await fetch(`${url}${ENDPOINTS.setup_password.path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "ein drittes Passwort", device_name: "Bad" }),
  });
  expect(again.status).toBe(409);
  expect(((await again.json()) as ErrorBody).error.code).toBe("conflict");

  // Der Stand der Einrichtung: Das Passwort kommt aus der App, die Schritte sind offen.
  const status = await kitchen.core.setup.load();
  expect(status.password_source).toBe("app");
  expect(status.finished_at).toBeNull();
  expect(status.steps.map((step) => step.id)).toEqual(["https", "printer", "backup", "updates", "notifications", "home_assistant"]);
  const skipped = await kitchen.core.setup.update({ step: { id: "printer", state: "skipped" } });
  expect(skipped.steps.find((step) => step.id === "printer")).toMatchObject({ state: "skipped", ready: false });
  expect((await kitchen.core.setup.update({ finished: true })).finished_at).not.toBeNull();
});

it("ändert das Passwort; ein falsches bisheriges meldet nicht ab, und andere Geräte bleiben angemeldet", async () => {
  const { url } = await server({ dev: false });
  const kitchen = await newDevice(url, "Küche");
  await kitchen.core.session.createPassword(FIRST, "Küche");
  const hall = await newDevice(url, "Flur");
  await hall.login(FIRST);

  await expectCoreError(kitchen.core.session.changePassword("falsch geraten", SECOND), "invalid_password");
  expect(value(kitchen.core.session.state).status).toBe("signed_in");
  await kitchen.sync();

  await kitchen.core.session.changePassword(FIRST, SECOND);
  const bath = await newDevice(url, "Bad");
  await expectCoreError(bath.login(FIRST), "invalid_password");
  await bath.login(SECOND);
  // Wer schon angemeldet war, bleibt es.
  await kitchen.sync();
  await hall.sync();
});

it("lässt ein Passwort aus STOWLY_PASSWORD nur dort ändern", async () => {
  const { url } = await server({ dev: false, env: { STOWLY_PASSWORD: FIRST } });
  const kitchen = await newDevice(url, "Küche");
  await kitchen.login(FIRST);
  expect((await kitchen.core.setup.load()).password_source).toBe("env");
  await expectCoreError(kitchen.core.session.changePassword(FIRST, SECOND), "conflict");
  await expectCoreError(kitchen.core.session.createPassword(SECOND, "Küche"), "invalid");
  const other = await newDevice(url, "Flur");
  await expectCoreError(other.core.session.createPassword(SECOND, "Flur"), "conflict");
});

it("ändert Kontakt und Schalter über PATCH /api/server-config; was aus der Umgebung kommt, nur dort", async () => {
  // Ohne STOWLY_UPDATE_REPO und mit ausgeschaltetem Schalter fragt der Server GitHub nie.
  const { url } = await server({ env: { STOWLY_UPDATE_REPO_DEFAULT: "beispiel/stowly" } });
  const raw = await RawClient.login(url);
  const before = (await (await raw.request("GET", ENDPOINTS.get_server_config.path)).json()) as ServerConfig;
  expect(before.push.contact).toBeNull();
  expect(before.update).toMatchObject({ enabled: false, repo: "beispiel/stowly", available: true });

  const set = await raw.request("PATCH", ENDPOINTS.update_server_config.path, { push_contact: "haushalt@example.org" });
  expect(set.status).toBe(200);
  expect(((await set.json()) as ServerConfig).push).toEqual({ contact: "mailto:haushalt@example.org", source: "app" });

  const bad = await raw.request("PATCH", ENDPOINTS.update_server_config.path, { push_contact: "kein Kontakt" });
  expect(bad.status).toBe(422);
  expect(((await bad.json()) as ErrorBody).error.details).toMatchObject({ errors: [{ loc: ["body", "push_contact"] }] });

  const off = await raw.request("PATCH", ENDPOINTS.update_server_config.path, { update_enabled: false });
  expect(((await off.json()) as ServerConfig).update).toMatchObject({ enabled: false, source: "app" });

  // Der Kern: Push verlässt „nicht eingerichtet", die Integrationen zeigen den wirksamen Kontakt.
  const device = await signedIn(url, "Küche");
  expect((await device.core.serverConfig.load()).push.contact).toBe("mailto:haushalt@example.org");
  expect((await device.core.integrations.load()).push.configured).toBe(true);
  expect((await device.core.setup.load()).steps.find((step) => step.id === "notifications")?.ready).toBe(true);
  await device.core.serverConfig.update({ push_contact: null });
  expect((await device.core.integrations.load()).push.configured).toBe(false);

  // Aus der Umgebung: nur zu sehen.
  const fixed = await server({ env: { STOWLY_PUSH_CONTACT: "mailto:haushalt@example.org" } });
  const other = await signedIn(fixed.url, "Flur");
  expect((await other.core.serverConfig.load()).push).toEqual({ contact: "mailto:haushalt@example.org", source: "env" });
  await expectCoreError(other.core.serverConfig.update({ push_contact: "anders@example.org" }), "conflict");
  // Ein Image ohne Repository kennt den Schalter nicht.
  await expectCoreError(other.core.serverConfig.update({ update_enabled: false }), "conflict");
});

// Der Server signiert nur die IP, von der der Pi sich meldet (docs/sync-protokoll.md, 11.8). Hier kommt
// der nachgespielte Pi von 127.0.0.1: Der Server lehnt ab. Den gelungenen Weg mit einer Adresse im
// Heimnetz prüft server/tests/test_setup_integration.py.
it("koppelt einen Pi: Code und Befehl, der Pi meldet sich, ein Pi ohne Heimnetz-Adresse bekommt kein Zertifikat", async () => {
  // Mit eigenem HTTPS-Listener: Stowly hat dann sicher eine CA, die den Pi beglaubigt.
  const { url } = await server({ env: { STOWLY_HTTPS_PORT: String(await freePort()) } });
  const device = await signedIn(url, "Küche");
  const created = await device.core.printers.pair({ origin: url });
  expect(created.state).toBe("waiting");
  expect(created.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  expect(created.command).toBe(`curl -fsSL ${url}/api/pi/install.sh | sudo sh -s -- ${created.code ?? ""}`);
  expect(await device.core.printers.pairing(created.id)).toMatchObject({ state: "waiting", code: null, command: null, pi: null });

  // Der Pi spricht ohne Anmeldung, nur mit dem Code.
  const pi = RawClient.anonymous(url);
  const code = created.code ?? "";
  expect((await pi.request("POST", ENDPOINTS.pi_pair_start.path, { code: code.toLowerCase(), hostname: "stowly-pi", version: "0.3.0" })).status).toBe(204);
  expect(await device.core.printers.pairing(created.id)).toMatchObject({ state: "installing", pi: { hostname: "stowly-pi" } });

  // Der „Pi“ meldet 192.168.1.20, spricht aber von 127.0.0.1, und unter 192.168.1.20 besteht er die
  // Rückprüfung nicht (dort antwortet kein Pi mit dem Nachweis für diesen Antrag): kein Zertifikat, der Code bleibt gültig.
  const request = { code, hostname: "stowly-pi", addresses: ["192.168.1.20"], csr: makeCsr(), token: "pi-token-0123456789abcdef", model: "QL-570", printer_found: true, version: "0.3.0" };
  const answer = await pi.request("POST", ENDPOINTS.pi_pair.path, request);
  expect(answer.status).toBe(422);
  expect(((await answer.json()) as ErrorBody).error.details).toMatchObject({ errors: [{ loc: ["body", "addresses"] }] });
  expect(await device.core.printers.pairing(created.id)).toMatchObject({ state: "installing" });
  const setup = await device.core.setup.load();
  expect(setup.steps.find((step) => step.id === "printer")?.ready).toBe(false);
  expect(setup.paired_printers).toEqual([]);

  // Ein neuer Code bricht den alten ab; ein abgebrochener Code gilt nicht mehr.
  const again = await device.core.printers.pair({ origin: url });
  expect((await device.core.printers.pairing(created.id)).state).toBe("cancelled");
  await device.core.printers.cancelPairing(again.id);
  expect((await device.core.printers.pairing(again.id)).state).toBe("cancelled");
  expect((await pi.request("POST", ENDPOINTS.pi_pair_start.path, { code: again.code, hostname: "stowly-pi" })).status).toBe(409);
});
