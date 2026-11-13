/**
 * Nachgebaute Server-Schnittstelle für `npm run dev:fake`. GRUNDGERÜST: Worker 3 baut sie aus.
 *
 * `npm run dev:fake` startet die echte App (echter Offline-Kern) und beantwortet /api und
 * /print im selben Prozess mit dieser Datei, ohne Stowly-Server. So lässt sich der Kern im
 * Browser ausprobieren, solange der echte Server noch entsteht. Dieselbe Nachbildung kann
 * den Tests des Kerns als Gegenstelle dienen.
 *
 * Fest steht nur die Nahtstelle zu vite.config.ts:
 *
 *   export default function (request, response, next): void
 *
 * im Stil einer Connect-Middleware. Die Datei läuft unter Node (über Vite), nicht im
 * Browser: kein window, kein IndexedDB. Die Typen unten sind bewusst von Hand notiert,
 * damit die Typprüfung des Kerns ohne Node-Typen auskommt.
 */
import { ENDPOINTS, PROTOCOL_VERSION, type ErrorBody, type ErrorCode, type ServerHealth } from "@/contract/api.gen";

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

function sendJson(response: FakeResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

function sendError(response: FakeResponse, status: number, code: ErrorCode, message: string): void {
  const body: ErrorBody = { error: { code, message, details: null } };
  sendJson(response, status, body);
}

export default function fakeApi(request: FakeRequest, response: FakeResponse, next: () => void): void {
  const path = (request.url ?? "").split("?")[0] ?? "";

  if (request.method === ENDPOINTS.health.method && path === ENDPOINTS.health.path) {
    const health: ServerHealth = {
      app: "stowly",
      status: "ok",
      version: "0.0.0-fake",
      protocol: PROTOCOL_VERSION,
      time: new Date().toISOString(),
      configured: true,
    };
    sendJson(response, 200, health);
    return;
  }

  if (path.startsWith("/api/") || path.startsWith("/print/")) {
    sendError(response, 501, "not_implemented", "Die nachgebaute Schnittstelle kennt diesen Aufruf noch nicht.");
    return;
  }

  next();
}
