/**
 * Home Assistant aus der App gegen den echten Server (docs/plan-einrichtung-b.md, Abschnitt 3), mit
 * einem nachgebildeten HA unter 127.0.0.1 (support/ha.ts):
 *
 * - „Verbindung prüfen" ohne Token: HA antwortet, der Token fehlt; mit Token die Listen, nach Namen.
 * - Speichern: Der Abgleich übernimmt es ohne Neustart (Zustand erst "pending", dann "ok"); der Token
 *   steht in keiner Antwort; eine neue Adresse ohne Token löscht ihn.
 * - Der in der App erzeugte Sensor-Token wirkt auf `/api/ha/summary`; entfernt, antwortet der Sensor 503.
 * - Kommt die Verbindung aus der Umgebung, sind Änderungen 409.
 */
import { afterEach, describe, expect, it } from "vitest";

import { disposeDevices, expectCoreError, signedIn, type Device } from "./support/device";
import { FakeHomeAssistant } from "./support/ha";
import { sleep, startServer, type ServerHandle } from "./support/server";

const servers: ServerHandle[] = [];
const fakes: FakeHomeAssistant[] = [];

async function homeAssistant(): Promise<FakeHomeAssistant> {
  const ha = new FakeHomeAssistant();
  await ha.start();
  fakes.push(ha);
  return ha;
}

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
  for (const ha of fakes.splice(0)) {
    await ha.close();
  }
});

/** Zwischen dem Beginn zweier Prüfungen liegen beim Server mindestens drei Sekunden. */
const CHECK_GAP_MS = 3_100;

/** Wartet, bis der Abgleich mit HA einen Zustand außer "pending" und "off" meldet, und liefert ihn. */
async function settled(device: Device): Promise<string> {
  const deadline = Date.now() + 40_000;
  for (;;) {
    const state = (await device.core.integrations.load()).ha.state;
    if (state !== "pending" && state !== "off") {
      return state;
    }
    if (Date.now() > deadline) {
      throw new Error(`Der Abgleich mit Home Assistant steht nach 40 s noch auf ${state}.`);
    }
    await sleep(250);
  }
}

describe("Home Assistant aus der App", () => {
  it("prüft, speichert und gleicht ohne Neustart ab; der Token bleibt beim Server", { timeout: 120_000 }, async () => {
    const ha = await homeAssistant();
    const { url } = await server();
    const device = await signedIn(url, "Küche");
    expect(await device.core.haConfig.load()).toMatchObject({ source: "default", configured: false, token_set: false, url: null, sensor: { source: "default", set: false } });

    // Ohne Token: HA antwortet, die Listen gibt es erst mit Token.
    const anonymous = await device.core.haConfig.check({ url: ha.url });
    expect(anonymous).toMatchObject({ state: "token_needed", lists: [] });
    // Zu dicht hintereinander: 429.
    expect((await expectCoreError(device.core.haConfig.check({ url: ha.url, token: ha.token }), "rate_limited")).details.retry_after_s).toBeGreaterThan(0);
    await sleep(CHECK_GAP_MS);
    const checked = await device.core.haConfig.check({ url: ha.url, token: ha.token });
    expect(checked).toMatchObject({ state: "ok", ha_version: "2026.11.0", location_name: "Zuhause" });
    expect(checked.lists).toEqual([
      { entity_id: "todo.baumarkt", name: "Baumarkt", open: 0 },
      { entity_id: "todo.einkaufsliste", name: "Einkaufsliste", open: 1 },
    ]);
    expect(JSON.stringify(checked)).not.toContain(ha.token);
    // Geprüft wird nur; gespeichert ist nichts.
    expect((await device.core.haConfig.load()).configured).toBe(false);

    const saved = await device.core.haConfig.update({ url: `${ha.url}/`, token: ha.token, entity: "todo.einkaufsliste" });
    expect(saved).toMatchObject({ source: "app", url: ha.url, entity: "todo.einkaufsliste", token_set: true, configured: true, problem: null });
    expect(JSON.stringify(saved)).not.toContain(ha.token);
    expect(JSON.stringify(await device.core.haConfig.load())).not.toContain(ha.token);

    // Ohne Neustart: Der Abgleich übernimmt es und kommt durch.
    expect(await settled(device)).toBe("ok");
    expect(ha.calls("/api/states/todo.einkaufsliste").length).toBeGreaterThan(0);
    expect(ha.requests.every((entry) => entry.authorized || entry.path === "/api/")).toBe(true);
    expect((await device.core.setup.load()).steps.find((step) => step.id === "home_assistant")?.ready).toBe(true);
    const status = await device.core.integrations.load();
    expect(status.ha).toMatchObject({ configured: true, entity: "todo.einkaufsliste", state: "ok" });

    // Die gespeicherte Verbindung prüfen: ohne Felder.
    await sleep(CHECK_GAP_MS);
    expect(await device.core.haConfig.check()).toMatchObject({ state: "ok", entity_found: true });

    // Eine neue Adresse ohne Token löscht den gespeicherten: Er gilt nur für seine Adresse.
    const moved = await device.core.haConfig.update({ url: "http://127.0.0.2:8123" });
    expect(moved).toMatchObject({ url: "http://127.0.0.2:8123", token_set: false, configured: false });
    await expectCoreError(device.core.haConfig.update({ entity: "Einkaufsliste" }), "invalid");
    const removed = await device.core.haConfig.update({ url: null, entity: null, token: null });
    expect(removed).toMatchObject({ configured: false, url: null, entity: null, token_set: false });
  });

  it("erzeugt einen Sensor-Token, der auf /api/ha/summary wirkt, und entfernt ihn wieder", async () => {
    const { url } = await server();
    const device = await signedIn(url, "Küche");
    const summary = (token: string) => fetch(`${url}/api/ha/summary`, { headers: { authorization: `Bearer ${token}` } });

    await expectCoreError(device.core.haConfig.sensorToken(), "not_found");
    const token = await device.core.haConfig.createSensorToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await device.core.haConfig.sensorToken()).toBe(token);
    expect((await device.core.haConfig.load()).sensor).toMatchObject({ source: "app", set: true });
    expect((await device.core.integrations.load()).ha.sensor).toBe(true);

    const answer = await summary(token);
    expect(answer.status).toBe(200);
    expect(((await answer.json()) as { state: number }).state).toBeTypeOf("number");
    expect((await summary("f".repeat(64))).status).toBe(401);

    // Ein neuer ersetzt den alten sofort.
    const next = await device.core.haConfig.createSensorToken();
    expect((await summary(token)).status).toBe(401);
    expect((await summary(next)).status).toBe(200);

    await device.core.haConfig.deleteSensorToken();
    expect((await summary(next)).status).toBe(503);
    expect((await device.core.haConfig.load()).sensor.set).toBe(false);
  });

  it("sperrt eine Verbindung aus der Umgebung: Ändern gibt 409, Prüfen geht", { timeout: 90_000 }, async () => {
    const ha = await homeAssistant();
    const sensor = "s".repeat(40);
    const { url } = await server({ env: { STOWLY_HA_URL: ha.url, STOWLY_HA_TOKEN: ha.token, STOWLY_HA_TODO_ENTITY: "todo.einkaufsliste", STOWLY_HA_SUMMARY_TOKEN: sensor } });
    const device = await signedIn(url, "Keller");
    const config = await device.core.haConfig.load();
    expect(config).toMatchObject({ source: "env", url: ha.url, entity: "todo.einkaufsliste", token_set: true, configured: true, sensor: { source: "env", set: true } });
    expect(JSON.stringify(config)).not.toContain(ha.token);

    await expectCoreError(device.core.haConfig.update({ entity: "todo.baumarkt" }), "conflict");
    await expectCoreError(device.core.haConfig.update({ url: null, entity: null, token: null }), "conflict");
    await expectCoreError(device.core.haConfig.check({ url: ha.url }), "conflict");
    await expectCoreError(device.core.haConfig.createSensorToken(), "conflict");
    await expectCoreError(device.core.haConfig.sensorToken(), "conflict");
    await expectCoreError(device.core.haConfig.deleteSensorToken(), "conflict");

    expect(await device.core.haConfig.check()).toMatchObject({ state: "ok", entity_found: true });
    expect(await settled(device)).toBe("ok");
    expect((await fetch(`${url}/api/ha/summary`, { headers: { authorization: `Bearer ${sensor}` } })).status).toBe(200);
  });
});
