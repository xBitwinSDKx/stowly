/**
 * Die Einkaufsliste der Nachbildung des Servers gegen die gemeinsamen Fälle (docs/vectors.json,
 * Abschnitt `shopping_auto`): dieselben Folgen von Befehlen, gegen die auch der echte Server
 * geprüft wird (server/tests). Dazu, was die Nachbildung sonst über Push und die Integrationen
 * verspricht.
 *
 * So laufen die Fälle: Jedes Gerät ist eine eigene Anmeldung. Ein Schritt geht als eigene
 * Sync-Anfrage hinaus; die Uhr der Nachbildung steht dabei auf `received`, die Geräteuhr hat den
 * Befehl um `at` erzeugt und sendet um `received`. Der wirksame Zeitpunkt ist dann genau `at`.
 */
import { describe, expect, it } from "vitest";

import rawVectors from "../../../../docs/vectors.json";
import { PROTOCOL_VERSION, PUSH_PATHS, randomPackageId, type CommandResult, type ShoppingItem, type SyncResponse } from "@/contract";

import { FAKE_PASSWORD, FakeServer, pushTestPayload } from "./fake-api";
import type { FakeResponseData } from "./fake-server";

interface Expected {
  product?: string;
  text?: string;
  origin: "manual" | "min_stock";
  quantity: number | null;
  state: "open" | "done" | "deleted";
}

interface Step {
  at?: number;
  received?: number;
  device?: string;
  cmd?: string;
  product?: string;
  package?: string;
  item?: string;
  source?: string;
  target?: string;
  auto?: string;
  pick?: "done";
  name?: string;
  min_stock?: number;
  best_before?: string;
  reason?: string;
  text?: string;
  quantity?: number;
  changes?: Record<string, unknown>;
  expect?: Expected[];
}

interface Case {
  name: string;
  steps: Step[];
}

const CASES = (rawVectors as unknown as { shopping_auto: { cases: Case[] } }).shopping_auto.cases;

const T0 = Date.parse("2026-11-13T10:00:00.000Z");

function stamp(seconds: number): string {
  return new Date(T0 + seconds * 1000).toISOString();
}

function body<T>(response: FakeResponseData): T {
  return JSON.parse(typeof response.body === "string" ? response.body : "null") as T;
}

/** Spielt einen Fall gegen eine frische Nachbildung. */
class CaseRunner {
  readonly server: FakeServer;
  private nowMs = T0;
  private readonly tokens = new Map<string, string>();
  private readonly products = new Map<string, string>();
  private readonly packages = new Map<string, string>();
  private readonly items = new Map<string, string>();
  private readonly zone: string;
  private serial = 0;

  constructor() {
    this.server = new FakeServer({ now: () => new Date(this.nowMs) });
    this.zone = [...this.server.data.zones.keys()][0] ?? "";
  }

  private token(device: string): string {
    let token = this.tokens.get(device);
    if (token === undefined) {
      const response = this.server.handle({ method: "POST", path: "/api/auth/login", headers: {}, body: JSON.stringify({ password: FAKE_PASSWORD, device_name: `Gerät ${device}` }) });
      token = body<{ token: string }>(response).token;
      this.tokens.set(device, token);
    }
    return token;
  }

  private productId(name: string | undefined): string {
    if (name === undefined) {
      throw new Error("Kürzel des Produkts fehlt");
    }
    let id = this.products.get(name);
    if (id === undefined) {
      this.serial += 1;
      id = `20000000-0000-4000-8000-${String(this.serial).padStart(12, "0")}`;
      this.products.set(name, id);
    }
    return id;
  }

  private packageId(name: string | undefined): string {
    if (name === undefined) {
      throw new Error("Kürzel der Packung fehlt");
    }
    let id = this.packages.get(name);
    while (id === undefined) {
      const candidate = randomPackageId();
      if (![...this.packages.values()].includes(candidate)) {
        id = candidate;
        this.packages.set(name, id);
      }
    }
    return id;
  }

  private itemId(step: Step): string {
    if (step.item !== undefined) {
      let id = this.items.get(step.item);
      if (id === undefined) {
        this.serial += 1;
        id = `70000000-0000-4000-8000-${String(this.serial).padStart(12, "0")}`;
        this.items.set(step.item, id);
      }
      return id;
    }
    // `auto`: der offene automatische Eintrag des Produkts; `pick: done` der zuletzt erledigte.
    const product = this.productId(step.auto);
    const candidates = [...this.server.data.shopping_items.values()].filter((item) => item.product_id === product && item.origin === "min_stock" && item.deleted_at === null);
    const chosen =
      step.pick === "done"
        ? candidates.filter((item) => item.done_at !== null).sort((a, b) => (a.done_at ?? "").localeCompare(b.done_at ?? "")).at(-1)
        : candidates.find((item) => item.done_at === null);
    if (!chosen) {
      throw new Error(`Kein automatischer Eintrag für ${String(step.auto)} (${step.pick ?? "offen"})`);
    }
    return chosen.id;
  }

  private command(step: Step): Record<string, unknown> {
    switch (step.cmd) {
      case "product.create":
        return { product_id: this.productId(step.product), name: step.name ?? "", ...(step.min_stock !== undefined ? { min_stock: step.min_stock } : {}) };
      case "product.update":
        return { product_id: this.productId(step.product), changes: { ...step.changes } };
      case "product.merge":
        return { source_id: this.productId(step.source), target_id: this.productId(step.target) };
      case "package.create":
        return { package_id: this.packageId(step.package), product_id: this.productId(step.product), zone_id: this.zone, ...(step.best_before !== undefined ? { best_before: step.best_before } : {}) };
      case "package.remove":
        return { package_id: this.packageId(step.package), reason: step.reason };
      case "package.restore":
        return { package_id: this.packageId(step.package) };
      case "package.update": {
        const changes: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(step.changes ?? {})) {
          changes[key === "product" ? "product_id" : key] = key === "product" ? this.productId(value as string) : value;
        }
        return { package_id: this.packageId(step.package), changes };
      }
      case "shopping_item.create":
        return {
          item_id: this.itemId(step),
          ...(step.product !== undefined ? { product_id: this.productId(step.product) } : {}),
          ...(step.text !== undefined ? { text: step.text } : {}),
          ...(step.quantity !== undefined ? { quantity: step.quantity } : {}),
        };
      case "shopping_item.update":
        return { item_id: this.itemId(step), changes: { ...step.changes } };
      case "shopping_item.delete":
        return { item_id: this.itemId(step) };
      default:
        throw new Error(`Unbekannter Befehl im Testfall: ${String(step.cmd)}`);
    }
  }

  /** Ein Schritt mit Befehl: eine Sync-Anfrage des Geräts, empfangen um `received`. */
  send(step: Step): CommandResult {
    const at = step.at ?? 0;
    const received = step.received ?? at;
    const receivedMs = T0 + received * 1000;
    // „nie früher als beim Schritt davor"
    expect(receivedMs).toBeGreaterThanOrEqual(this.nowMs);
    this.nowMs = receivedMs;
    const token = this.token(step.device ?? "A");
    const command = { id: crypto.randomUUID(), at: stamp(at), type: step.cmd, ...this.command(step) };
    const request = { protocol: PROTOCOL_VERSION, dataset_id: this.server.datasetId, cursor: this.server.rev, sent_at: stamp(received), commands: [command], id_pool: { have: 300 } };
    const response = this.server.handle({ method: "POST", path: "/api/sync", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(request) });
    expect(response.status).toBe(200);
    const result = body<SyncResponse>(response).results[0];
    if (!result) {
      throw new Error("Keine Antwort auf den Befehl");
    }
    return result;
  }

  /** Alle Einträge der Einkaufsliste in der Form der Testfälle. */
  actual(): string[] {
    const names = new Map([...this.products].map(([name, id]) => [id, name]));
    return [...this.server.data.shopping_items.values()].map((item) => canonical(describeItem(item, names))).sort();
  }
}

function describeItem(item: ShoppingItem, names: ReadonlyMap<string, string>): Expected {
  const state = item.deleted_at !== null ? "deleted" : item.done_at !== null ? "done" : "open";
  return {
    ...(item.product_id !== null ? { product: names.get(item.product_id) ?? item.product_id } : { text: item.text }),
    origin: item.origin,
    quantity: item.quantity,
    state,
  };
}

function canonical(entry: Expected): string {
  return JSON.stringify([entry.product ?? null, entry.text ?? null, entry.origin, entry.quantity, entry.state]);
}

describe("Einkaufsliste der Nachbildung gegen docs/vectors.json (shopping_auto)", () => {
  it("kennt die Fälle", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(20);
  });

  for (const testCase of CASES) {
    it(testCase.name, () => {
      const runner = new CaseRunner();
      testCase.steps.forEach((step, index) => {
        if (step.expect) {
          expect(runner.actual(), `${testCase.name}, Schritt ${index + 1}`).toEqual(step.expect.map(canonical).sort());
          return;
        }
        const result = runner.send(step);
        expect(result, `${testCase.name}, Schritt ${index + 1} (${String(step.cmd)})`).toMatchObject({ status: "applied", code: null });
      });
    });
  }
});

describe("Was der Server an der Einkaufsliste selbst schreibt", () => {
  function setup() {
    const runner = new CaseRunner();
    return { runner, server: runner.server };
  }

  it("vermerkt intern, wodurch ein Eintrag geschlossen wurde, und liefert es nie mit", () => {
    const { runner, server } = setup();
    runner.send({ at: 0, cmd: "product.create", product: "milch", name: "Milch", min_stock: 1 });
    runner.send({ at: 1, cmd: "shopping_item.create", item: "own", product: "milch" });
    runner.send({ at: 2, cmd: "shopping_item.create", item: "text", text: "Kerzen" });
    const auto = [...server.data.shopping_items.values()].find((item) => item.origin === "min_stock");
    runner.send({ at: 3, cmd: "package.create", package: "m1", product: "milch" });
    runner.send({ at: 4, cmd: "shopping_item.update", item: "text", changes: { done: true } });
    const rules = server.shoppingRules;
    const own = [...server.data.shopping_items.values()].find((item) => item.origin === "manual" && item.product_id !== null);
    const text = [...server.data.shopping_items.values()].find((item) => item.product_id === null);
    expect(rules.closedBy(own?.id ?? "")).toBe("store");
    expect(rules.closedBy(auto?.id ?? "")).toBe("stock");
    expect(rules.closedBy(text?.id ?? "")).toBe("device");
    runner.send({ at: 5, cmd: "shopping_item.update", item: "text", changes: { done: false } });
    expect(rules.closedBy(text?.id ?? "")).toBeNull();
    for (const item of server.data.shopping_items.values()) {
      expect(Object.keys(item).sort()).toEqual(["created_at", "deleted_at", "done_at", "id", "origin", "product_id", "quantity", "text", "updated_at"]);
    }
  });

  it("schreibt nichts, wenn der auslösende Befehl abgelehnt wird", () => {
    const { runner, server } = setup();
    runner.send({ at: 0, cmd: "product.create", product: "milch", name: "Milch", min_stock: 2 });
    const before = [...server.data.shopping_items.values()];
    const auto = before[0];
    const result = runner.send({ at: 1, cmd: "shopping_item.delete", item: "fremd" });
    expect(result).toMatchObject({ status: "rejected", code: "not_found" });
    // Die Menge eines automatischen Eintrags gehört dem Server: Der ganze Befehl gilt nicht, auch `done` nicht.
    const invalid = runner.send({ at: 2, cmd: "shopping_item.update", auto: "milch", changes: { quantity: 5, done: true } });
    expect(invalid).toMatchObject({ status: "rejected", code: "invalid" });
    expect([...server.data.shopping_items.values()]).toEqual(before);
    expect(server.shoppingRules.lockOf(auto?.product_id ?? "")).toBeUndefined();
  });

  it("lässt Erledigtes und Gelöschtes nur im vollständigen Abzug nach der Aufbewahrungsdauer weg", () => {
    const { runner, server } = setup();
    runner.send({ at: 0, cmd: "shopping_item.create", item: "alt", text: "Grillkohle" });
    runner.send({ at: 1, cmd: "shopping_item.update", item: "alt", changes: { done: true } });
    runner.send({ at: 2, cmd: "shopping_item.create", item: "neu", text: "Kerzen" });
    const token = server.handle({ method: "POST", path: "/api/auth/login", headers: {}, body: JSON.stringify({ password: FAKE_PASSWORD, device_name: "Prüfer" }) });
    const auth = { authorization: `Bearer ${body<{ token: string }>(token).token}` };
    const sync = (request: Record<string, unknown>) =>
      body<SyncResponse>(server.handle({ method: "POST", path: "/api/sync", headers: auth, body: JSON.stringify({ protocol: PROTOCOL_VERSION, sent_at: stamp(0), commands: [], id_pool: { have: 300 }, ...request }) }));
    // 31 Tage später: Der erledigte Eintrag fällt aus dem Abzug, der offene nicht.
    const later = new FakeServer({ now: () => new Date(T0 + 31 * 86_400_000) });
    later.load({ shopping_items: [...server.data.shopping_items.values()] });
    const laterAuth = { authorization: `Bearer ${body<{ token: string }>(later.handle({ method: "POST", path: "/api/auth/login", headers: {}, body: JSON.stringify({ password: FAKE_PASSWORD, device_name: "Prüfer" }) })).token}` };
    const full = body<SyncResponse>(later.handle({ method: "POST", path: "/api/sync", headers: laterAuth, body: JSON.stringify({ protocol: PROTOCOL_VERSION, dataset_id: null, cursor: 0, sent_at: stamp(0), commands: [], id_pool: { have: 0 } }) }));
    expect(full.reset).toBe(true);
    expect(full.changes.shopping_items.map((item) => item.text)).toEqual(["Kerzen"]);
    const delta = body<SyncResponse>(later.handle({ method: "POST", path: "/api/sync", headers: laterAuth, body: JSON.stringify({ protocol: PROTOCOL_VERSION, dataset_id: later.datasetId, cursor: 0, sent_at: stamp(0), commands: [], id_pool: { have: 300 } }) }));
    expect(delta.changes.shopping_items.map((item) => item.text).sort()).toEqual(["Grillkohle", "Kerzen"]);
    // Am selben Tag liefert auch der vollständige Abzug beide.
    expect(sync({ dataset_id: null, cursor: 0 }).changes.shopping_items).toHaveLength(2);
  });
});

describe("Push in der Nachbildung", () => {
  const SUBSCRIPTION = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc",
    keys: { p256dh: `BA${"A".repeat(85)}`, auth: "AAAAAAAAAAAAAAAAAAAAAA" },
    origin: "https://stowly.example",
  };

  function setup() {
    let nowMs = T0;
    const server = new FakeServer({ now: () => new Date(nowMs) });
    const login = (name: string) => body<{ token: string; device: { id: string } }>(server.handle({ method: "POST", path: "/api/auth/login", headers: {}, body: JSON.stringify({ password: FAKE_PASSWORD, device_name: name }) }));
    const call = (token: string, method: string, path: string, payload?: unknown) =>
      server.handle({ method, path, headers: { authorization: `Bearer ${token}` }, body: payload === undefined ? "" : JSON.stringify(payload) });
    return {
      server,
      login,
      call,
      advance: (ms: number) => {
        nowMs += ms;
      },
    };
  }

  it("liefert den Schlüssel, nimmt Abos an und schickt Testnachrichten", () => {
    const { server, login, call, advance } = setup();
    const { token, device } = login("Handy");
    const key = body<{ public_key: string }>(call(token, "GET", "/api/push/key")).public_key;
    // 65 Byte, beginnend mit 0x04 (unkomprimierter Punkt), base64url ohne Füllzeichen.
    expect(key).toMatch(/^B[A-Za-z0-9_-]{86}$/);
    server.rotatePushKey();
    expect(body<{ public_key: string }>(call(token, "GET", "/api/push/key")).public_key).not.toBe(key);
    expect(call(token, "POST", "/api/push/test").status).toBe(404);
    expect(call(token, "PUT", "/api/push/subscription", SUBSCRIPTION).status).toBe(204);
    expect(server.pushSubscriptionOf(device.id)).toEqual(SUBSCRIPTION);

    const sent = call(token, "POST", "/api/push/test");
    expect(body(sent)).toEqual({ status: "sent", http_status: 201, message: "Der Push-Dienst hat die Nachricht angenommen." });
    expect(server.pushMessages.at(-1)?.payload).toEqual(pushTestPayload(SUBSCRIPTION.origin));
    expect(server.pushMessages.at(-1)?.payload.notification.navigate).toBe(`https://stowly.example${PUSH_PATHS.test}`);
    // Höchstens eine Testnachricht je 10 Sekunden.
    const limited = call(token, "POST", "/api/push/test");
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBe("10");
    advance(10_000);
    server.pushTestStatus = "gone";
    expect(body<{ status: string }>(call(token, "POST", "/api/push/test")).status).toBe("gone");
    expect(server.pushSubscriptionOf(device.id)).toBeUndefined();

    expect(call(token, "PUT", "/api/push/subscription", SUBSCRIPTION).status).toBe(204);
    expect(call(token, "DELETE", "/api/push/subscription").status).toBe(204);
    expect(call(token, "DELETE", "/api/push/subscription").status).toBe(204);
    expect(server.pushSubscriptionOf(device.id)).toBeUndefined();
  });

  it("weist fremde Push-Dienste, falsche Schlüssel und Ursprünge mit der Stelle zurück", () => {
    const { login, call } = setup();
    const { token } = login("Handy");
    const loc = (payload: unknown) => {
      const response = call(token, "PUT", "/api/push/subscription", payload);
      return response.status === 204 ? "" : (body<{ error: { details: { errors: { loc: string[] }[] } } }>(response).error.details.errors[0]?.loc ?? []).join(".");
    };
    expect(loc({ ...SUBSCRIPTION, endpoint: "https://push.example.org/x" })).toBe("body.endpoint");
    expect(loc({ ...SUBSCRIPTION, endpoint: "http://fcm.googleapis.com/x" })).toBe("body.endpoint");
    expect(loc({ ...SUBSCRIPTION, endpoint: "https://fcm.googleapis.com:8443/x" })).toBe("body.endpoint");
    expect(loc({ ...SUBSCRIPTION, endpoint: "https://evilfcm.googleapis.com.example/x" })).toBe("body.endpoint");
    expect(loc({ ...SUBSCRIPTION, endpoint: "https://web.push.apple.com/x" })).toBe("");
    expect(loc({ ...SUBSCRIPTION, keys: { ...SUBSCRIPTION.keys, p256dh: "AAAA" } })).toBe("body.keys.p256dh");
    expect(loc({ ...SUBSCRIPTION, keys: { ...SUBSCRIPTION.keys, auth: "AAAA" } })).toBe("body.keys.auth");
    expect(loc({ ...SUBSCRIPTION, origin: "https://stowly.example/app" })).toBe("body.origin");
    expect(loc({ ...SUBSCRIPTION, origin: "http://stowly.example" })).toBe("body.origin");
    expect(loc({ ...SUBSCRIPTION, origin: "http://localhost:5173" })).toBe("");
  });

  it("antwortet ohne Einrichtung mit 503, beendet Abos mit dem Token und nennt sie im Zustand", () => {
    const { server, login, call } = setup();
    const first = login("Handy");
    const second = login("Tablet");
    call(first.token, "PUT", "/api/push/subscription", SUBSCRIPTION);
    // Derselbe Endpunkt wechselt zum anderen Gerät.
    call(second.token, "PUT", "/api/push/subscription", SUBSCRIPTION);
    expect(server.pushSubscriptionOf(first.device.id)).toBeUndefined();
    const status = body<{ push: { subscriptions: number; this_device: boolean } }>(call(second.token, "GET", "/api/integrations"));
    expect(status.push).toMatchObject({ subscriptions: 1, this_device: true });
    call(second.token, "POST", "/api/auth/logout");
    expect(server.pushSubscriptionOf(second.device.id)).toBeUndefined();

    server.pushConfigured = false;
    for (const [method, path] of [
      ["GET", "/api/push/key"],
      ["PUT", "/api/push/subscription"],
      ["DELETE", "/api/push/subscription"],
      ["POST", "/api/push/test"],
    ] as const) {
      expect(call(first.token, method, path, method === "PUT" ? SUBSCRIPTION : undefined).status, path).toBe(503);
    }
  });
});
