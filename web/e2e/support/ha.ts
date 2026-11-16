/**
 * Ein nachgebildetes Home Assistant als HTTP-Server unter 127.0.0.1, für die Tests gegen den echten
 * Stowly-Server (homeassistant.e2e.test.ts).
 *
 * Es spricht, was die Prüfung der Verbindung (server/stowly/hacheck.py) und der Abgleich mit Bring!
 * (server/stowly/bring.py) von HA brauchen: `GET /api/` (mit gültigem Token „API running."),
 * `GET /api/config`, `GET /api/states` und `/api/states/<entität>`, dazu die Dienste `todo.get_items`,
 * `add_item`, `update_item`, `remove_item`. Ohne oder mit falschem Token antwortet es 401 wie HA.
 * Es führt Buch über jede Anfrage (ohne den Token selbst).
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeTodoItem {
  uid: string;
  summary: string;
  status: "needs_action" | "completed";
}

export interface FakeTodoList {
  entity_id: string;
  name: string;
  items: FakeTodoItem[];
}

export interface FakeHaRequest {
  method: string;
  path: string;
  /** Kam der richtige Token mit? */
  authorized: boolean;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  response.writeHead(status, { "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json" });
  response.end(text);
}

export class FakeHomeAssistant {
  /** Ein langlebiger Zugangs-Token, für jeden Lauf neu. */
  readonly token = `ha-${randomBytes(24).toString("hex")}`;
  readonly lists: FakeTodoList[] = [
    { entity_id: "todo.einkaufsliste", name: "Einkaufsliste", items: [{ uid: "uid-1", summary: "Milch", status: "needs_action" }] },
    { entity_id: "todo.baumarkt", name: "Baumarkt", items: [] },
  ];
  readonly requests: FakeHaRequest[] = [];
  private server: Server | null = null;
  private next = 100;

  /** Adresse ohne Schrägstrich am Ende, etwa "http://127.0.0.1:53124". */
  url = "";

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      void this.handle(request, response).catch(() => send(response, 500, { message: "Fehler in der Nachbildung" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.server = server;
    this.url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /** Die Anfragen an einen Pfad (ohne Abfrage). */
  calls(path: string): FakeHaRequest[] {
    return this.requests.filter((entry) => entry.path === path);
  }

  private list(entity: string): FakeTodoList | undefined {
    return this.lists.find((candidate) => candidate.entity_id === entity);
  }

  private state(list: FakeTodoList): Record<string, unknown> {
    return {
      entity_id: list.entity_id,
      state: String(list.items.filter((item) => item.status === "needs_action").length),
      attributes: { friendly_name: list.name, supported_features: 15 },
      last_changed: new Date().toISOString(),
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const [path = "", query = ""] = (request.url ?? "").split("?");
    const method = request.method ?? "GET";
    const authorized = request.headers.authorization === `Bearer ${this.token}`;
    this.requests.push({ method, path, authorized });
    const body = method === "POST" ? await readBody(request) : "";
    if (!path.startsWith("/api/")) {
      send(response, 404, "404: Not Found");
      return;
    }
    if (!authorized) {
      send(response, 401, "401: Unauthorized");
      return;
    }
    if (method === "GET" && path === "/api/") {
      send(response, 200, { message: "API running." });
      return;
    }
    if (method === "GET" && path === "/api/config") {
      send(response, 200, { version: "2026.11.0", location_name: "Zuhause", time_zone: "Europe/Berlin", unit_system: { temperature: "°C" } });
      return;
    }
    if (method === "GET" && path === "/api/states") {
      send(response, 200, [...this.lists.map((list) => this.state(list)), { entity_id: "sun.sun", state: "above_horizon", attributes: { friendly_name: "Sun" } }]);
      return;
    }
    if (method === "GET" && path.startsWith("/api/states/")) {
      const list = this.list(decodeURIComponent(path.slice("/api/states/".length)));
      send(response, list ? 200 : 404, list ? this.state(list) : { message: "Entity not found." });
      return;
    }
    if (method === "POST" && path.startsWith("/api/services/todo/")) {
      const data = (body === "" ? {} : JSON.parse(body)) as { entity_id?: string; item?: string | string[]; status?: string; rename?: string };
      const list = this.list(String(data.entity_id ?? ""));
      if (!list) {
        send(response, 400, { message: "Entity not found." });
        return;
      }
      const service = path.slice("/api/services/todo/".length);
      if (service === "get_items" && query === "return_response") {
        send(response, 200, { changed_states: [], service_response: { [list.entity_id]: { items: list.items.map((item) => ({ ...item })) } } });
        return;
      }
      if (service === "add_item") {
        this.next += 1;
        list.items.push({ uid: `uid-${String(this.next)}`, summary: String(data.item ?? ""), status: "needs_action" });
        send(response, 200, []);
        return;
      }
      if (service === "update_item") {
        const item = list.items.find((candidate) => candidate.uid === data.item || candidate.summary === data.item);
        if (!item) {
          send(response, 400, { message: "Unable to find To-do item" });
          return;
        }
        if (data.status === "completed" || data.status === "needs_action") {
          item.status = data.status;
        }
        send(response, 200, []);
        return;
      }
      if (service === "remove_item") {
        const wanted = Array.isArray(data.item) ? data.item : [data.item];
        list.items = list.items.filter((item) => !wanted.includes(item.uid) && !wanted.includes(item.summary));
        send(response, 200, []);
        return;
      }
    }
    send(response, 404, { message: "Not found" });
  }
}
