/**
 * Die nachgebaute Schnittstelle selbst: Sie ist die Gegenstelle aller Tests des Kerns und
 * muss das Protokoll deshalb an den Stellen genau nehmen, auf die sich diese Tests stützen.
 */
import { describe, expect, it } from "vitest";

import { ENDPOINTS, ID_POOL_TARGET, PROTOCOL_VERSION, type SyncResponse } from "@/contract";

import fakeApi, { createFakeNetwork, FAKE_PASSWORD, FakeServer, validateCommand, type FakeRequest, type FakeResponse } from "./fake-api";

const AT = "2026-11-13T10:00:00.000Z";
const ID = "3f2b8c1e-5a47-4d09-9b6e-0c1d2e3f4a5b";
const PRODUCT = "20000000-0000-4000-8000-000000000001";
const ZONE = "10000000-0000-4000-8000-000000000001";

function command(payload: Record<string, unknown>): Record<string, unknown> {
  return { id: ID, at: AT, ...payload };
}

describe("Prüfung der Befehle (wie server/stowly/contract/commands.py)", () => {
  it("nimmt Befehle des Katalogs an", () => {
    const valid = [
      { type: "product.create", product_id: PRODUCT },
      { type: "product.create", product_id: PRODUCT, name: "", brand: "", quantity: "", warn_days: null, barcodes: ["4006381333931"] },
      { type: "product.update", product_id: PRODUCT, changes: { warn_days: null } },
      { type: "package.create", package_id: "A2B3C", product_id: PRODUCT, zone_id: ZONE, best_before: null },
      { type: "package.update", package_id: "A2B3C", changes: { best_before: null } },
      { type: "package.restore", package_id: "A2B3C" },
      { type: "zone.create", zone_id: ZONE, name: "Keller" },
      { type: "zone.update", zone_id: ZONE, changes: { color: null, printer_id: null } },
      { type: "settings.update", changes: { primary_zone_id: null } },
      { type: "printer.create", printer_id: ID, name: "Küche", connection: "server", server: { driver: "image", model: null, address: null, media: "62" } },
      { type: "print.request", job_id: ID, kind: "package", package_id: "A2B3C" },
      { type: "print.report", job_id: ID, state: "cancelled", printer_id: null, boot_id: null, error: null },
    ];
    expect(valid.map((payload) => validateCommand(command(payload)))).toEqual(valid.map(() => null));
  });

  it("lehnt unbekannte Felder, fehlende Pflichtfelder und falsche Formate ab", () => {
    const invalid = [
      { type: "product.create" },
      { type: "product.create", product_id: PRODUCT, extra: 1 },
      { type: "product.create", product_id: PRODUCT, name: null },
      { type: "product.update", product_id: PRODUCT, changes: { name: null } },
      { type: "product.update", product_id: PRODUCT, changes: { lookup: "found" } },
      { type: "package.create", package_id: "a2b3c", product_id: PRODUCT, zone_id: ZONE },
      { type: "package.create", package_id: "A2B3U", product_id: PRODUCT, zone_id: ZONE },
      { type: "package.create", package_id: "A2B3C", product_id: PRODUCT, zone_id: ZONE, best_before: "25.03.2027" },
      // In `changes` ist null ein Wert; Felder, die nie null sein dürfen, lehnen ihn ab.
      { type: "package.update", package_id: "A2B3C", changes: { zone_id: null } },
      { type: "package.remove", package_id: "A2B3C", reason: "eaten" },
      { type: "zone.create", zone_id: ZONE, name: "" },
      { type: "zone.update", zone_id: ZONE, changes: { name: null } },
      { type: "settings.update", changes: { trash_retention_days: 0 } },
      { type: "settings.update", changes: { warn_days: null } },
      { type: "printer.create", printer_id: ID, name: "Küche", connection: "server" },
      { type: "printer.create", printer_id: ID, name: "Küche", connection: "server", server: { driver: "image", media: "62" } },
      { type: "print.request", job_id: ID, kind: "package", zone_id: ZONE },
      { type: "noch.unbekannt" },
    ];
    expect(invalid.map((payload) => validateCommand(command(payload)) === null)).toEqual(invalid.map(() => false));
    expect(validateCommand({ ...command({ type: "zone.delete", zone_id: ZONE, move_to: ZONE }), at: "2026-11-13T10:00:00Z" })).not.toBeNull();
    expect(validateCommand("kein Objekt")).not.toBeNull();
  });
});

async function login(network: ReturnType<typeof createFakeNetwork>): Promise<string> {
  const response = await network.fetch(ENDPOINTS.login.path, { method: "POST", body: JSON.stringify({ password: FAKE_PASSWORD, device_name: "Test" }) });
  return ((await response.json()) as { token: string }).token;
}

async function sync(network: ReturnType<typeof createFakeNetwork>, token: string, body: Record<string, unknown>): Promise<{ status: number; body: SyncResponse }> {
  const response = await network.fetch(ENDPOINTS.sync.path, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as SyncResponse };
}

describe("Sync", () => {
  it("beginnt mit der Zone Vorrat, den Einstellungen und den Vorlagen und antwortet zuerst mit reset", async () => {
    const server = new FakeServer({ now: () => new Date(AT) });
    const network = createFakeNetwork(server);
    const token = await login(network);
    const first = await sync(network, token, { protocol: PROTOCOL_VERSION, dataset_id: null, cursor: 0, sent_at: AT, commands: [], id_pool: { have: 0 } });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ protocol: 1, dataset_id: server.datasetId, reset: true, has_more: false, results: [] });
    expect(first.body.changes.zones.map((zone) => zone.name)).toEqual(["Vorrat"]);
    expect(first.body.changes.settings).toMatchObject({ zone_mode: "primary", warn_days: 14, trash_retention_days: 30 });
    expect(first.body.changes.label_templates.map((template) => template.key).sort()).toEqual(["package", "zone"]);
    expect(first.body.id_pool.grant).toHaveLength(ID_POOL_TARGET);

    // Danach nur noch, was sich seit dem cursor geändert hat.
    const second = await sync(network, token, { protocol: PROTOCOL_VERSION, dataset_id: first.body.dataset_id, cursor: first.body.cursor, sent_at: AT, commands: [], id_pool: { have: 300 } });
    expect(second.body.reset).toBe(false);
    expect(second.body.changes).toEqual({ products: [], zones: [], packages: [], printers: [], printer_status: [], print_jobs: [], label_templates: [], settings: null });
    expect(second.body.id_pool.grant).toEqual([]);
    // Ein cursor jenseits des Stands des Servers ergibt wieder einen vollständigen Abzug.
    const beyond = await sync(network, token, { protocol: PROTOCOL_VERSION, dataset_id: first.body.dataset_id, cursor: first.body.cursor + 100, sent_at: AT, commands: [], id_pool: { have: 300 } });
    expect(beyond.body.reset).toBe(true);
    // Bei reset verwirft die App ihren Vorrat: Es gibt einen vollen, gleich was `have` sagt (Abschnitt 8).
    expect(beyond.body.id_pool.grant).toHaveLength(ID_POOL_TARGET);
    expect(beyond.body.id_pool.grant.filter((id) => first.body.id_pool.grant.includes(id))).toEqual([]);
  });

  it("hält die Reihenfolge eines Geräts auch über Anfragen hinweg (Abschnitt 4)", async () => {
    let now = new Date("2026-11-13T11:00:00.000Z");
    const server = new FakeServer({ now: () => now });
    const network = createFakeNetwork(server);
    const [token, other] = [await login(network), await login(network)];
    const zone = [...server.data.zones.keys()][0] ?? "";
    const frame = { protocol: PROTOCOL_VERSION, dataset_id: server.datasetId, cursor: 0, id_pool: { have: 300 } };
    server.act({ type: "product.create", product_id: PRODUCT, name: "Reis" }, { type: "package.create", package_id: "A2B3C", product_id: PRODUCT, zone_id: zone }, { type: "package.create", package_id: "A2B3D", product_id: PRODUCT, zone_id: zone });

    // Das Entnehmen ist beim Absenden frisch, das Rückgängig danach 30 Sekunden alt (Uhr verstellt, Anfrage lange unterwegs).
    await sync(network, token, { ...frame, sent_at: "2026-11-13T10:00:00.000Z", commands: [{ id: "3f2b8c1e-5a47-4d09-9b6e-0c1d2e3f4b01", at: "2026-11-13T10:00:00.000Z", type: "package.remove", package_id: "A2B3C", reason: "consumed" }] });
    now = new Date("2026-11-13T11:00:01.000Z");
    await sync(network, token, { ...frame, sent_at: "2026-11-13T10:00:31.000Z", commands: [{ id: "3f2b8c1e-5a47-4d09-9b6e-0c1d2e3f4b02", at: "2026-11-13T10:00:01.000Z", type: "package.update", package_id: "A2B3D", changes: { best_before: "2027-01-01" } }] });
    // Nach dem Alter allein wäre der zweite Befehl um 10:59:31 wirksam; er bekommt den Zeitpunkt des ersten.
    expect(server.data.packages.get("A2B3D")?.updated_at).toBe("2026-11-13T11:00:00.000Z");

    // Die Untergrenze gehört dem einen Gerät: Ein anderes rechnet nur mit dem Alter.
    const second = "20000000-0000-4000-8000-000000000002";
    await sync(network, other, { ...frame, sent_at: "2026-11-13T10:00:31.000Z", commands: [{ id: "3f2b8c1e-5a47-4d09-9b6e-0c1d2e3f4b03", at: "2026-11-13T10:00:01.000Z", type: "product.create", product_id: second, name: "Nudeln" }] });
    expect(server.data.products.get(second)?.created_at).toBe("2026-11-13T10:59:31.000Z");
  });

  it("führt jeden Befehl höchstens einmal aus und rechnet mit dem Alter statt mit der Geräteuhr", async () => {
    let now = new Date("2026-11-13T11:00:00.000Z");
    const server = new FakeServer({ now: () => now });
    const network = createFakeNetwork(server);
    const token = await login(network);
    const zone = [...server.data.zones.keys()][0] ?? "";
    const commands = [
      { id: "3f2b8c1e-5a47-4d09-9b6e-0c1d2e3f4a01", at: "2026-11-13T10:00:00.000Z", type: "product.create", product_id: PRODUCT, name: "Reis" },
      { id: "3f2b8c1e-5a47-4d09-9b6e-0c1d2e3f4a02", at: "2026-11-13T10:01:00.000Z", type: "package.create", package_id: "A2B3C", product_id: PRODUCT, zone_id: zone },
      // Die Geräteuhr wurde zurückgestellt: Der wirksame Zeitpunkt läuft trotzdem nicht rückwärts.
      { id: "3f2b8c1e-5a47-4d09-9b6e-0c1d2e3f4a03", at: "2026-11-13T09:00:00.000Z", type: "package.remove", package_id: "A2B3C", reason: "consumed" },
      { id: "3f2b8c1e-5a47-4d09-9b6e-0c1d2e3f4a04", at: "2026-11-13T10:02:00.000Z", type: "package.create", package_id: "A2B3C", product_id: PRODUCT, zone_id: zone },
      { id: "3f2b8c1e-5a47-4d09-9b6e-0c1d2e3f4a05", at: "2026-11-13T10:03:00.000Z", type: "package.update", package_id: "A2B3C", changes: { best_before: "2027-01-01" } },
      { id: "3f2b8c1e-5a47-4d09-9b6e-0c1d2e3f4a06", at: "2026-11-13T10:04:00.000Z", type: "package.update", package_id: "A2B3C", changes: { zone_id: null } },
    ];
    const request = { protocol: PROTOCOL_VERSION, dataset_id: server.datasetId, cursor: 0, sent_at: "2026-11-13T10:05:00.000Z", commands, id_pool: { have: 300 } };
    const first = await sync(network, token, request);
    expect(first.body.results.map((result) => [result.status, result.code, result.duplicate])).toEqual([
      ["applied", null, false],
      ["applied", null, false],
      ["applied", null, false],
      ["rejected", "id_conflict", false],
      ["displaced", null, false],
      ["rejected", "invalid", false],
    ]);
    const stored = server.data.packages.get("A2B3C");
    // Beim Absenden 4 Minuten alt, empfangen um 11:00: wirksam um 10:56.
    expect(stored?.created_at).toBe("2026-11-13T10:56:00.000Z");
    expect(stored?.removed_at).toBe("2026-11-13T10:56:00.000Z");

    now = new Date("2026-11-13T12:00:00.000Z");
    const again = await sync(network, token, request);
    expect(again.body.results.map((result) => [result.status, result.duplicate])).toEqual([
      ["applied", true],
      ["applied", true],
      ["applied", true],
      ["rejected", true],
      ["displaced", true],
      ["rejected", true],
    ]);
    expect(server.data.packages.get("A2B3C")).toEqual(stored);
  });

  it("teilt eine Antwort nie mitten in einem Schritt der Änderungsfolge", async () => {
    const server = new FakeServer({ now: () => new Date(AT), maxChanges: 3 });
    const network = createFakeNetwork(server);
    const token = await login(network);
    const first = [...server.data.zones.keys()][0] ?? "";
    const second = "10000000-0000-4000-8000-000000000002";
    server.act({ type: "product.create", product_id: PRODUCT, name: "Reis" }, { type: "zone.create", zone_id: second, name: "Keller", sort: 1 });
    for (const id of ["00001", "00002", "00003", "00004", "00005"]) {
      server.act({ type: "package.create", package_id: id, product_id: PRODUCT, zone_id: first });
    }
    const base = server.rev;
    // Ein Befehl, der sechs Datensätze auf einmal ändert: fünf Packungen und die Zone.
    server.act({ type: "zone.delete", zone_id: first, move_to: second });

    const page = await sync(network, token, { protocol: PROTOCOL_VERSION, dataset_id: server.datasetId, cursor: base, sent_at: AT, commands: [], id_pool: { have: 300 } });
    expect(page.body.changes.packages).toHaveLength(5);
    expect(page.body.changes.zones).toHaveLength(1);
    expect(page.body.changes.settings?.primary_zone_id).toBe(second);
    expect(page.body.has_more).toBe(false);
    expect(page.body.cursor).toBe(server.rev);
  });

  it("lässt nur im vollständigen Abzug weg, was jenseits der Aufbewahrung liegt", async () => {
    const server = new FakeServer({ now: () => new Date(AT) });
    const network = createFakeNetwork(server);
    const token = await login(network);
    const zone = [...server.data.zones.keys()][0] ?? "";
    server.act({ type: "product.create", product_id: PRODUCT, name: "Reis" });
    const old = { id: "00001", product_id: PRODUCT, zone_id: zone, best_before: null, created_at: AT, updated_at: AT, removed_at: "2026-09-01T10:00:00.000Z", removal_reason: "consumed" as const, displaced: null };
    const before = server.rev;
    server.put("packages", old);

    const full = await sync(network, token, { protocol: PROTOCOL_VERSION, dataset_id: null, cursor: 0, sent_at: AT, commands: [], id_pool: { have: 0 } });
    expect(full.body.reset).toBe(true);
    expect(full.body.changes.packages).toEqual([]);
    // Jede andere Antwort liefert ausnahmslos alles, egal wie alt.
    const delta = await sync(network, token, { protocol: PROTOCOL_VERSION, dataset_id: server.datasetId, cursor: before, sent_at: AT, commands: [], id_pool: { have: 300 } });
    expect(delta.body.changes.packages).toEqual([old]);
  });

  it("weist falsche Anfragen mit dem Fehlerformat des Servers zurück", async () => {
    const server = new FakeServer({ now: () => new Date(AT) });
    const network = createFakeNetwork(server);
    const token = await login(network);
    const good = { protocol: PROTOCOL_VERSION, dataset_id: null, cursor: 0, sent_at: AT, commands: [], id_pool: { have: 0 } };

    const status = async (body: Record<string, unknown>, auth: string = token) => {
      const response = await network.fetch(ENDPOINTS.sync.path, { method: "POST", headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify(body) });
      return [response.status, ((await response.json()) as { error?: { code: string } }).error?.code];
    };
    expect(await status(good, "falsch")).toEqual([401, "unauthorized"]);
    expect(await status({ ...good, protocol: 2 })).toEqual([409, "protocol_mismatch"]);
    // Wie der Server: Nur eine andere Zahl ist eine andere Protokollversion; fehlt das Feld, verletzt der Rahmen den Vertrag.
    const { protocol: _protocol, ...withoutProtocol } = good;
    expect(await status(withoutProtocol)).toEqual([422, "invalid_request"]);
    expect(await status({ ...good, protocol: "1" })).toEqual([422, "invalid_request"]);
    expect(await status({ ...good, extra: true })).toEqual([422, "invalid_request"]);
    expect(await status({ ...good, sent_at: "2026-11-13T10:00:00Z" })).toEqual([422, "invalid_request"]);
    expect(await status({ ...good, commands: [{ type: "zone.create" }] })).toEqual([422, "invalid_request"]);
    expect(await status({ ...good, commands: Array.from({ length: 501 }, (_, n) => ({ id: `3f2b8c1e-5a47-4d09-9b6e-${String(n).padStart(12, "0")}`, at: AT, type: "x" })) })).toEqual([413, "payload_too_large"]);
  });
});

describe("Middleware für den Entwicklungsserver", () => {
  function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
    return new Promise((resolve) => {
      const listeners: Record<string, ((value?: unknown) => void)[]> = {};
      const request: FakeRequest = {
        method,
        url,
        headers,
        on(event: string, listener: (value: never) => void) {
          (listeners[event] ??= []).push(listener as (value?: unknown) => void);
          return request;
        },
      };
      const result = { status: 0, headers: {} as Record<string, string>, body: undefined as unknown };
      const response: FakeResponse = {
        statusCode: 200,
        setHeader(name, value) {
          result.headers[name] = value;
        },
        end(payload) {
          result.status = this.statusCode;
          result.body = typeof payload === "string" && payload !== "" ? JSON.parse(payload) : payload;
          resolve(result);
        },
      };
      fakeApi(request, response, () => resolve({ ...result, status: -1 }));
      // Der Rumpf kommt wie unter Node in Stücken.
      const text = body === undefined ? "" : JSON.stringify(body);
      const bytes = new TextEncoder().encode(text);
      const half = Math.floor(bytes.length / 2);
      for (const listener of listeners.data ?? []) {
        listener(bytes.slice(0, half));
        listener(bytes.slice(half));
      }
      for (const listener of listeners.end ?? []) {
        listener();
      }
    });
  }

  it("beantwortet /api/health mit dem Marker des Servers und lässt alles andere durch", async () => {
    const health = await call("GET", `${ENDPOINTS.health.path}?x=1`);
    expect(health.status).toBe(200);
    expect(health.headers["cache-control"]).toBe("no-store");
    expect(health.body).toMatchObject({ app: "stowly", status: "ok", protocol: PROTOCOL_VERSION, configured: true });
    expect((await call("GET", "/zonen")).status).toBe(-1);
    expect((await call("POST", "/print/v1/jobs/1", {})).status).toBe(501);
  });

  it("meldet an und gleicht ab, mit einem Beispiel-Haushalt als Bestand", async () => {
    expect((await call("POST", "/api/sync", {})).status).toBe(401);
    const login = await call("POST", "/api/auth/login", { password: FAKE_PASSWORD, device_name: "Browser" });
    expect(login.status).toBe(200);
    const token = (login.body as { token: string }).token;
    const sync = await call("POST", "/api/sync", { protocol: PROTOCOL_VERSION, dataset_id: null, cursor: 0, sent_at: AT, commands: [], id_pool: { have: 0 } }, { Authorization: `Bearer ${token}` });
    expect(sync.status).toBe(200);
    const body = sync.body as SyncResponse;
    expect(body.changes.zones.map((zone) => zone.name).sort()).toEqual(["Gefrierschrank", "Keller", "Vorratsregal"]);
    expect(body.changes.packages.length).toBeGreaterThan(3);
    expect(body.changes.printers).toHaveLength(1);
    expect(body.changes.products.every((product) => product.lookup === "found")).toBe(true);
  });
});
