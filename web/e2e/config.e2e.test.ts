/**
 * Der Server ohne Entwicklungsmodus: mit eigenem Passwort und ganz ohne.
 * Jeder Test startet seinen eigenen Server.
 */
import { afterEach, expect, it } from "vitest";

import { disposeDevices, expectCoreError, newDevice, value } from "./support/device";
import { startServer, type ServerHandle } from "./support/server";

let server: ServerHandle | null = null;

afterEach(async () => {
  await disposeDevices();
  await server?.dispose();
  server = null;
});

it("lässt ohne STOWLY_PASSWORD niemanden herein und sagt es", async () => {
  server = await startServer({ dev: false });
  const health = (await (await fetch(`${server.url}/api/health`)).json()) as { configured: boolean; app: string };
  expect(health).toMatchObject({ app: "stowly", configured: false });

  const device = await newDevice(server.url, "Küche");
  await expectCoreError(device.login("stowly"), "not_configured");
  expect(value(device.core.session.state)).toEqual({ status: "signed_out", reason: "never" });
  // Der Server ist erreichbar, nur nicht eingerichtet.
  expect(device.status.online).toBe(true);
  // Die Hinweise auf der Konsole nennen den Grund.
  expect(server.output()).toContain("STOWLY_PASSWORD ist nicht gesetzt");
});

it("meldet mit dem Passwort aus STOWLY_PASSWORD an; die API-Dokumentation gibt es nur beim Entwickeln", async () => {
  server = await startServer({ dev: false, env: { STOWLY_PASSWORD: "ein langes Haushalts-Passwort" } });
  expect(((await (await fetch(`${server.url}/api/health`)).json()) as { configured: boolean }).configured).toBe(true);

  const stranger = await newDevice(server.url, "Fremdes Gerät");
  await expectCoreError(stranger.login("stowly"), "invalid_password");

  const device = await newDevice(server.url, "Küche");
  await device.login("ein langes Haushalts-Passwort");
  expect(value(device.core.session.state).status).toBe("signed_in");
  expect(value(device.core.data.zones)).toHaveLength(1);

  expect((await fetch(`${server.url}/api/docs`)).status).toBe(404);
  expect((await fetch(`${server.url}/api/openapi.json`)).status).toBe(404);
  // Unbekannte Pfade unter /api antworten im Fehlerformat.
  const unknown = await fetch(`${server.url}/api/gibt-es-nicht`);
  expect(unknown.status).toBe(404);
  expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("not_found");
});
