/**
 * Tests des Grundgerüsts. Sie zeigen, dass die Testumgebung des Kerns steht (jsdom,
 * IndexedDB im Arbeitsspeicher) und was die Platzhalter tun. Worker 3 ersetzt sie in
 * Runde 1 durch die Tests des echten Kerns.
 */
import Dexie from "dexie";
import { describe, expect, it } from "vitest";

import { CoreError, ENDPOINTS, PROTOCOL_VERSION } from "@/contract";

import { createCore } from ".";
import fakeApi, { type FakeRequest, type FakeResponse } from "./testing/fake-api";

function call(method: string, url: string): { status: number; headers: Record<string, string>; body: unknown } {
  const result = { status: 0, headers: {} as Record<string, string>, body: undefined as unknown };
  const request: FakeRequest = { method, url, headers: {}, on: () => undefined };
  const response: FakeResponse = {
    statusCode: 200,
    setHeader(name, value) {
      result.headers[name] = value;
    },
    end(body) {
      result.status = this.statusCode;
      result.body = typeof body === "string" ? JSON.parse(body) : body;
    },
  };
  let passedOn = false;
  fakeApi(request, response, () => {
    passedOn = true;
  });
  return passedOn ? { ...result, status: -1 } : result;
}

describe("Grundgerüst des Kerns", () => {
  it("meldet, dass der echte Kern noch fehlt", () => {
    try {
      createCore();
    } catch (error) {
      expect(error).toBeInstanceOf(CoreError);
      expect((error as CoreError).code).toBe("not_supported");
      return;
    }
    throw new Error("createCore() hätte werfen müssen");
  });

  it("hat in Tests eine IndexedDB, mit der Dexie arbeitet", async () => {
    const db = new Dexie("stowly-test-skeleton");
    db.version(1).stores({ packages: "id, product_id" });
    await db.table("packages").bulkPut([
      { id: "A2B3C", product_id: "p1" },
      { id: "7K9QX", product_id: "p1" },
    ]);
    expect(await db.table("packages").where("product_id").equals("p1").count()).toBe(2);
    await db.delete();
  });
});

describe("Nachgebaute Schnittstelle (dev:fake)", () => {
  it("beantwortet /api/health mit dem Marker des Servers", () => {
    const response = call("GET", `${ENDPOINTS.health.path}?x=1`);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toMatchObject({ app: "stowly", status: "ok", protocol: PROTOCOL_VERSION, configured: true });
  });

  it("antwortet auf alles Übrige unter /api und /print mit 501 im Fehlerformat", () => {
    for (const url of ["/api/sync", "/api/auth/login", "/print/v1/health"]) {
      const response = call("POST", url);
      expect(response.status, url).toBe(501);
      expect(response.body, url).toMatchObject({ error: { code: "not_implemented", details: null } });
    }
  });

  it("lässt alles andere durch", () => {
    expect(call("GET", "/zonen").status).toBe(-1);
  });
});
