/**
 * Die Bremse gegen das Durchprobieren des Passworts (docs/sync-protokoll.md, Abschnitt 5).
 *
 * Eigene Datei und damit eigener Server: Die Sperre gilt für alle Anmeldungen gemeinsam
 * und hielte sonst die übrigen Tests auf.
 */
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { firstZone } from "./support/data";
import { disposeDevices, expectCoreError, newDevice, signedIn, value } from "./support/device";
import { startServer, type ServerHandle } from "./support/server";

let server: ServerHandle;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server?.dispose();
});

afterEach(disposeDevices);

it("sperrt nach fünf Fehlversuchen jede Anmeldung, lässt angemeldete Geräte aber arbeiten", async () => {
  const kitchen = await signedIn(server.url, "Küche");
  const guesser = await newDevice(server.url, "Ratender");

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await expectCoreError(guesser.login(`falsch-${attempt}`), "invalid_password");
  }

  // Der sechste Versuch wird gar nicht mehr geprüft.
  const locked = await expectCoreError(guesser.login("falsch-6"), "rate_limited");
  expect(locked.details.retry_after_s).toBeGreaterThanOrEqual(1);
  expect(locked.details.retry_after_s).toBeLessThanOrEqual(60);

  // Auch das richtige Passwort nicht: Die Sperre gilt für alle.
  const honest = await newDevice(server.url, "Ehrlicher");
  const refused = await expectCoreError(honest.login(), "rate_limited");
  expect(refused.details.retry_after_s).toBeGreaterThanOrEqual(1);
  expect(value(honest.core.session.state)).toEqual({ status: "signed_out", reason: "never", last_device_name: null });
  // Der Server hat geantwortet: Er gilt als erreichbar.
  expect(honest.status.online).toBe(true);

  // Wer schon angemeldet ist, merkt davon nichts.
  await kitchen.core.stock.store({ product: { kind: "new", name: "Salz" }, zone_id: firstZone(kitchen).id, best_before: null, count: 1 });
  await kitchen.sync();
  expect(await kitchen.core.devices.list()).toHaveLength(1);
});
