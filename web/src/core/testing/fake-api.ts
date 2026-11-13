/**
 * Nachgebaute Server-Schnittstelle für `npm run dev:fake` und für die Tests des Kerns.
 *
 * `npm run dev:fake` startet die echte App (echter Offline-Kern) und beantwortet /api und
 * /print im selben Prozess mit dieser Datei, ohne Stowly-Server. Das Passwort ist "stowly";
 * der Bestand ist ein kleiner Beispiel-Haushalt und lebt, solange der Entwicklungsserver läuft.
 *
 * Die Nahtstelle zu vite.config.ts:
 *
 *   export default function (request, response, next): void
 *
 * im Stil einer Connect-Middleware. Die Datei läuft unter Node (über Vite), nicht im
 * Browser: kein window, kein IndexedDB. Die Typen unten sind bewusst von Hand notiert,
 * damit die Typprüfung des Kerns ohne Node-Typen auskommt.
 *
 * Für Tests: `createFakeNetwork(server)` liefert ein `fetch`, das man `createCore` mitgibt,
 * samt Eingriffen (Netz weg, verlorene Antwort, Anhalten mitten im Abgleich).
 */
import type { FetchLike } from "../http";
import { FakeServer, type FakeRequestData, type FakeResponseData } from "./fake-server";

export { FAKE_PASSWORD, FakeServer, validateCommand, type FakeServerOptions } from "./fake-server";

export interface FakeRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface FakeResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: string | Uint8Array): unknown;
}

// ------------------------------------------------------------------------------------------
// Entwicklungsserver
// ------------------------------------------------------------------------------------------

const GLOBAL_KEY = "__stowlyFakeServer";

/** Der Server des Entwicklungsservers. Er hängt an globalThis, damit er das Neuladen dieser Datei überlebt. */
function devServer(): FakeServer {
  const holder = globalThis as Record<string, unknown>;
  if (!(holder[GLOBAL_KEY] instanceof FakeServer)) {
    // Platzhalter gelten nach drei Sekunden als nachgeschlagen: So sieht man im Browser, wie sie sich füllen.
    holder[GLOBAL_KEY] = new FakeServer({ sample: true, lookupDelayMs: 3_000 });
  }
  return holder[GLOBAL_KEY] as FakeServer;
}

function send(response: FakeResponse, data: FakeResponseData): void {
  response.statusCode = data.status;
  for (const [name, value] of Object.entries(data.headers)) {
    response.setHeader(name, value);
  }
  response.end(data.body ?? undefined);
}

function singleHeaders(headers: FakeRequest["headers"]): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}

export default function fakeApi(request: FakeRequest, response: FakeResponse, next: () => void): void {
  const path = (request.url ?? "").split("?")[0] ?? "";
  if (!path.startsWith("/api/") && !path.startsWith("/print/")) {
    next();
    return;
  }
  const method = request.method ?? "GET";
  const answer = (body: string) => {
    send(response, devServer().handle({ method, path, headers: singleHeaders(request.headers), body }));
  };
  if (method === "GET" || method === "HEAD" || method === "DELETE") {
    answer("");
    return;
  }
  const chunks: Uint8Array[] = [];
  request.on("data", (chunk) => {
    chunks.push(chunk);
  });
  request.on("error", () => {
    send(response, { status: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: { code: "invalid_request", message: "Der Rumpf ließ sich nicht lesen.", details: null } }) });
  });
  request.on("end", () => {
    const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    answer(new TextDecoder().decode(bytes));
  });
}

// ------------------------------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------------------------------

export interface FakeCall {
  method: string;
  path: string;
  /** Der gesendete Rumpf, als JSON gelesen; undefined ohne Rumpf. */
  body: unknown;
  /** Das Token aus `Authorization: Bearer …` oder null. */
  token: string | null;
}

export interface FakeNetwork {
  /** Das `fetch` für `createCore({ fetch })`. */
  fetch: FetchLike;
  /** true: Der Server ist nicht erreichbar; jeder Aufruf scheitert, ohne ihn zu erreichen. */
  offline: boolean;
  /** So viele der nächsten Antworten gehen verloren: Der Server verarbeitet die Anfrage, die Antwort kommt nie an. */
  dropResponses: number;
  /** Läuft, bevor der Server die Anfrage sieht. */
  beforeRequest: ((call: FakeCall) => void | Promise<void>) | null;
  /** Läuft, nachdem der Server geantwortet hat, aber bevor die Antwort beim Kern ankommt. */
  beforeResponse: ((call: FakeCall) => void | Promise<void>) | null;
  /** Liefert statt des Servers eine eigene Antwort (z. B. die Fehlerseite eines Proxys); null = der Server antwortet. */
  respondWith: ((call: FakeCall) => Response | null) | null;
  /** Alle Aufrufe, die den Server erreicht haben. */
  readonly calls: FakeCall[];
}

/** Ein `fetch`, das die nachgebaute Schnittstelle direkt aufruft, ohne Netz. */
export function createFakeNetwork(server: FakeServer): FakeNetwork {
  const network: FakeNetwork = {
    offline: false,
    dropResponses: 0,
    beforeRequest: null,
    beforeResponse: null,
    respondWith: null,
    calls: [],
    async fetch(input, init) {
      const method = init?.method ?? "GET";
      const path = input.split("?")[0] ?? "";
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        headers[name.toLowerCase()] = value;
      }
      const text = typeof init?.body === "string" ? init.body : "";
      const authorization = headers.authorization ?? "";
      const call: FakeCall = {
        method,
        path,
        body: text === "" ? undefined : (JSON.parse(text) as unknown),
        token: authorization.startsWith("Bearer ") ? authorization.slice(7) : null,
      };
      if (network.offline) {
        throw new TypeError("Failed to fetch");
      }
      await network.beforeRequest?.(call);
      if (network.offline) {
        throw new TypeError("Failed to fetch");
      }
      const foreign = network.respondWith?.(call) ?? null;
      if (foreign) {
        return foreign;
      }
      network.calls.push(call);
      const data = server.handle({ method, path, headers, body: text });
      await network.beforeResponse?.(call);
      if (network.dropResponses > 0) {
        network.dropResponses -= 1;
        throw new TypeError("Failed to fetch");
      }
      if (init?.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return new Response(data.body as BodyInit | null, { status: data.status, headers: data.headers });
    },
  };
  return network;
}
