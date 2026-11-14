/**
 * Nachgebaute Server-Schnittstelle für `npm run dev:fake` und für die Tests des Kerns.
 *
 * `npm run dev:fake` startet die echte App (echter Offline-Kern) und beantwortet /api und
 * /print im selben Prozess mit dieser Datei, ohne Stowly-Server. Das Passwort ist "stowly";
 * der Bestand ist ein kleiner Beispiel-Haushalt und lebt, solange der Entwicklungsserver läuft.
 * Unter /print antwortet der nachgebaute Druckdienst des Servers (fake-print.ts); der
 * Beispiel-Haushalt hat dafür einen Drucker mit Bild-Treiber.
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
 * samt Eingriffen (Netz weg, verlorene Antwort, Anhalten mitten im Abgleich) und mit
 * nachgebauten Druckdiensten unter eigenen Adressen (`attach`), so wie der Browser sie sähe.
 */
import type { FetchLike } from "../http";
import type { FakePrintService } from "./fake-print";
import { FakeServer, type FakeRequestData, type FakeResponseData } from "./fake-server";

export { FAKE_PRINT_TOKEN, FakePrintService, type FakePrintOptions } from "./fake-print";
export { checkPushSubscription, FAKE_PASSWORD, FakeServer, pushTestPayload, validateCommand, type FakeServerOptions, type PushPayload } from "./fake-server";

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
  /** Bricht die Verbindung ab, ohne zu antworten (Node). */
  destroy?(): unknown;
}

// ------------------------------------------------------------------------------------------
// Entwicklungsserver
// ------------------------------------------------------------------------------------------

const GLOBAL_KEY = "__stowlyFakeServer";

/** Der Server des Entwicklungsservers. Er hängt an globalThis, damit er das Neuladen dieser Datei überlebt. */
function devServer(): FakeServer {
  const holder = globalThis as Record<string, unknown>;
  if (!(holder[GLOBAL_KEY] instanceof FakeServer)) {
    // Platzhalter gelten nach drei Sekunden als nachgeschlagen, und ein Druck dauert einen
    // Augenblick: So sieht man im Browser, wie sich Produkte füllen und Etiketten fertig werden.
    holder[GLOBAL_KEY] = new FakeServer({ sample: true, lookupDelayMs: 3_000, print: { realWait: true, printMs: 1_200 } });
  }
  return holder[GLOBAL_KEY] as FakeServer;
}

export function sendFake(response: FakeResponse, data: FakeResponseData): void {
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

/** Liest eine Anfrage des Entwicklungsservers in die Form, die die Nachbildungen verstehen. */
export function readFakeRequest(request: FakeRequest): Promise<FakeRequestData> {
  const [path = "", query] = (request.url ?? "").split("?");
  const method = request.method ?? "GET";
  const data = (body: string): FakeRequestData => ({ method, path, query, headers: singleHeaders(request.headers), body });
  if (method === "GET" || method === "HEAD") {
    return Promise.resolve(data(""));
  }
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    request.on("data", (chunk) => {
      chunks.push(chunk);
    });
    request.on("error", reject);
    request.on("end", () => {
      const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      resolve(data(new TextDecoder().decode(bytes)));
    });
  });
}

/**
 * Eingriffe zum Ausprobieren im Browser (nur `npm run dev:fake`):
 *
 *   GET  /api/__fake/print                 was der Druckdienst des Servers gedruckt hat
 *   POST /api/__fake/print  { "action" }   "pause" | "resume" | "hang" | "fail" | "interrupt" | "restart" |
 *                                          "drop" (die nächste Antwort auf ein Einreichen geht verloren) |
 *                                          "offline" | "online" (der Druckdienst antwortet nicht mehr / wieder) |
 *                                          "reset" (frischer Beispiel-Haushalt)
 */
interface DevControl {
  dropSubmits: number;
  printOffline: boolean;
}

const CONTROL_KEY = "__stowlyFakeControl";
const CONTROL_PATH = "/api/__fake/print";

function devControl(): DevControl {
  const holder = globalThis as Record<string, unknown>;
  holder[CONTROL_KEY] ??= { dropSubmits: 0, printOffline: false } satisfies DevControl;
  return holder[CONTROL_KEY] as DevControl;
}

function control(data: FakeRequestData): FakeResponseData {
  const server = devServer();
  const state = devControl();
  if (data.method === "POST") {
    let action = "";
    let code = "no_media";
    try {
      const body = JSON.parse(data.body || "{}") as { action?: string; code?: string };
      action = body.action ?? "";
      code = body.code ?? code;
    } catch {
      action = "";
    }
    if (action === "reset") {
      // Alles auf Anfang: ein frischer Beispiel-Haushalt, niemand ist mehr angemeldet.
      const holder = globalThis as Record<string, unknown>;
      delete holder[GLOBAL_KEY];
      delete holder[CONTROL_KEY];
      return control({ ...data, method: "GET" });
    }
    if (action === "pause") server.print.pause();
    else if (action === "resume") server.print.resume();
    else if (action === "hang") server.print.hangNext();
    else if (action === "fail") server.print.failNext(code);
    else if (action === "interrupt") server.print.interruptNext();
    else if (action === "restart") server.print.restart();
    else if (action === "drop") state.dropSubmits += 1;
    else if (action === "offline") state.printOffline = true;
    else if (action === "online") state.printOffline = false;
    else return { status: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: { code: "invalid_request", message: "Unbekannter Eingriff.", details: null } }) };
  }
  return {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ printed: server.print.printed, boot_id: server.print.bootId, drop_submits: state.dropSubmits, offline: state.printOffline }),
  };
}

export default function fakeApi(request: FakeRequest, response: FakeResponse, next: () => void): void {
  const path = (request.url ?? "").split("?")[0] ?? "";
  if (!path.startsWith("/api/") && !path.startsWith("/print/")) {
    next();
    return;
  }
  const state = devControl();
  if (path.startsWith("/print/") && state.printOffline) {
    // Der Druckdienst ist „weg": Die Verbindung bricht ab, wie bei einem Netzfehler.
    response.destroy?.();
    return;
  }
  readFakeRequest(request)
    .then(async (data) => {
      if (data.path === CONTROL_PATH) {
        return control(data);
      }
      const answer = await devServer().respond(data);
      const SUBMIT_PREFIX = "/print/v1/jobs/";
      const isSubmit = data.method === "POST" && data.path.startsWith(SUBMIT_PREFIX) && !data.path.slice(SUBMIT_PREFIX.length).includes("/");
      if (state.dropSubmits > 0 && isSubmit) {
        // Die Anfrage ist verarbeitet, die Antwort geht verloren.
        state.dropSubmits -= 1;
        response.destroy?.();
        return null;
      }
      return answer;
    })
    .then(
      (data) => {
        if (data) {
          sendFake(response, data);
        }
      },
      () => {
        sendFake(response, {
          status: 400,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: { code: "invalid_request", message: "Der Rumpf ließ sich nicht lesen.", details: null } }),
        });
      },
    );
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
  /** Die Abfrage ohne Fragezeichen; "" ohne. */
  query: string;
  /** Basis-Adresse eines Druckdienstes unter eigener Adresse; null = der Server (selber Ursprung). */
  base: string | null;
  /** Kopfzeilen, die die App selbst gesetzt hat, mit kleingeschriebenen Namen. */
  headers: Record<string, string>;
  /** Was die App dem Browser sonst mitgegeben hat. */
  mode: string | undefined;
  credentials: string | undefined;
  cache: string | undefined;
  targetAddressSpace: string | undefined;
  /**
   * Hätte der Browser vor dieser Anfrage eine Vorabanfrage (`OPTIONS`) geschickt? Bei einem
   * anderen Ursprung löst jede Methode außer GET, HEAD und POST sie aus, ebenso jede eigene
   * Kopfzeile außer den wenigen „einfachen" (docs/etiketten.md, 5.2).
   */
  preflight: boolean;
}

/** Ein Druckdienst unter einer eigenen Adresse, wie ihn der Browser erreicht (oder nicht). */
export interface FakeLink {
  readonly base: string;
  readonly service: FakePrintService;
  /** false: Unter dieser Adresse antwortet nichts (falsches WLAN, Pi aus, Zertifikat nicht anerkannt). */
  reachable: boolean;
  /**
   * true: Die Anfrage bleibt ohne Antwort hängen, bis die App sie an ihrer Zeitgrenze abbricht
   * (Pakete versickern, oder der Browser wartet noch auf die Antwort des Anwenders auf seine
   * Nachfrage nach dem lokalen Netzwerk). `reachable: false` scheitert dagegen sofort.
   */
  silent: boolean;
  /**
   * Hält jede Anfrage an diese Adresse an, bis sich das Versprechen erfüllt, so wie der Browser
   * eine Anfrage anhält, solange seine Nachfrage nach dem lokalen Netzwerk offen ist. Bricht die
   * App vorher ab, scheitert die Anfrage. null = keine Pause.
   */
  hold: Promise<void> | null;
  /**
   * false: Der Ursprung der App fehlt in der Konfiguration des Dienstes. Der Browser lässt die
   * Seite dann keine Antwort lesen; nur eine Anfrage ohne CORS kommt (undurchsichtig) zurück.
   */
  cors: boolean;
}

export interface FakeNetwork {
  /** Das `fetch` für `createCore({ fetch })`. */
  fetch: FetchLike;
  /** true: Der Server ist nicht erreichbar; jeder Aufruf an ihn scheitert, ohne ihn zu erreichen. */
  offline: boolean;
  /** So viele der nächsten Antworten des Servers gehen verloren: Er verarbeitet die Anfrage, die Antwort kommt nie an. */
  dropResponses: number;
  /**
   * Lässt gezielt Antworten verloren gehen (auch die eines Druckdienstes): Liefert die Funktion
   * true, verarbeitet die Gegenstelle die Anfrage, aber die Antwort kommt nie an.
   */
  dropWhen: ((call: FakeCall) => boolean) | null;
  /** Läuft, bevor die Gegenstelle die Anfrage sieht. */
  beforeRequest: ((call: FakeCall) => void | Promise<void>) | null;
  /** Läuft, nachdem die Gegenstelle geantwortet hat, aber bevor die Antwort beim Kern ankommt. */
  beforeResponse: ((call: FakeCall) => void | Promise<void>) | null;
  /** Liefert statt des Servers eine eigene Antwort (z. B. die Fehlerseite eines Proxys); null = der Server antwortet. */
  respondWith: ((call: FakeCall) => Response | null) | null;
  /** Alle Aufrufe, die eine Gegenstelle erreicht haben. */
  readonly calls: FakeCall[];
  /** Alle Aufrufe an Adressen außerhalb des Servers, auch die, die niemanden erreicht haben. */
  readonly attempts: FakeCall[];
  /** Stellt einen nachgebauten Druckdienst unter einer Adresse bereit, z. B. "https://10.71.83.1:8443". */
  attach(base: string, service: FakePrintService): FakeLink;
}

const SIMPLE_HEADERS = new Set(["accept", "accept-language", "content-language", "content-type"]);
const SIMPLE_CONTENT_TYPES = ["text/plain", "multipart/form-data", "application/x-www-form-urlencoded"];

function needsPreflight(method: string, headers: Record<string, string>): boolean {
  if (!["GET", "HEAD", "POST"].includes(method)) {
    return true;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (!SIMPLE_HEADERS.has(name)) {
      return true;
    }
    if (name === "content-type" && !SIMPLE_CONTENT_TYPES.some((type) => value.toLowerCase().startsWith(type))) {
      return true;
    }
  }
  return false;
}

function toResponse(data: FakeResponseData): Response {
  return new Response(data.body as BodyInit | null, { status: data.status, headers: data.headers });
}

/**
 * Wie im Browser: Wird eine Anfrage abgebrochen, scheitert `fetch` sofort, auch wenn die
 * Gegenstelle noch arbeitet (etwa mit `wait` auf den Endzustand eines Auftrags wartet). Was sie
 * dabei tut, tut sie trotzdem; nur die Antwort kommt nicht mehr an.
 */
function abortable<T>(work: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  const aborted = () => new DOMException("The operation was aborted.", "AbortError");
  if (!signal) {
    return work;
  }
  if (signal.aborted) {
    return Promise.reject(aborted());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(aborted());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Ein `fetch`, das die nachgebauten Gegenstellen direkt aufruft, ohne Netz. */
export function createFakeNetwork(server: FakeServer): FakeNetwork {
  const links: FakeLink[] = [];
  const failed = () => new TypeError("Failed to fetch");

  const network: FakeNetwork = {
    offline: false,
    dropResponses: 0,
    dropWhen: null,
    beforeRequest: null,
    beforeResponse: null,
    respondWith: null,
    calls: [],
    attempts: [],
    attach(base, service) {
      const link: FakeLink = { base: base.replace(/\/+$/, ""), service, reachable: true, silent: false, hold: null, cors: true };
      links.push(link);
      return link;
    },
    async fetch(input, init) {
      const method = init?.method ?? "GET";
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        headers[name.toLowerCase()] = value;
      }
      const text = typeof init?.body === "string" ? init.body : "";
      const authorization = headers.authorization ?? "";
      const absolute = /^https?:\/\//.test(input);
      // Die Adresse eines Druckdienstes unter eigener Adresse: die längste passende Basis gewinnt.
      const link = absolute ? links.filter((candidate) => input === candidate.base || input.startsWith(`${candidate.base}/`)).sort((a, b) => b.base.length - a.base.length)[0] : undefined;
      const base = absolute ? (link?.base ?? new URL(input).origin) : null;
      const local = base === null ? input : input.slice(base.length);
      const [path = "", query = ""] = local.split("?");
      let body: unknown;
      try {
        body = text === "" ? undefined : (JSON.parse(text) as unknown);
      } catch {
        body = text;
      }
      const extras = (init ?? {}) as RequestInit & { targetAddressSpace?: string };
      const call: FakeCall = {
        method,
        path,
        query,
        body,
        token: authorization.startsWith("Bearer ") ? authorization.slice(7) : null,
        base,
        headers,
        mode: extras.mode,
        credentials: extras.credentials,
        cache: extras.cache,
        targetAddressSpace: extras.targetAddressSpace,
        preflight: base !== null && needsPreflight(method, headers),
      };

      if (base !== null) {
        // Ein Druckdienst unter eigener Adresse: Hier gelten die Regeln des Browsers für fremde Ursprünge.
        network.attempts.push(call);
        if (!link || !link.reachable) {
          throw failed();
        }
        if (link.silent) {
          // Keine Antwort, bis die App aufgibt (ohne Zeitgrenze: nie).
          const signal = init?.signal;
          await new Promise<void>((resolve) => {
            if (signal?.aborted) {
              resolve();
            } else {
              signal?.addEventListener("abort", () => resolve(), { once: true });
            }
          });
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        if (link.hold) {
          await abortable(link.hold, init?.signal);
        }
        await network.beforeRequest?.(call);
        if (call.mode === "no-cors") {
          // Ohne CORS kommt eine Antwort zurück, sobald etwas da ist; lesen kann die Seite sie nicht.
          network.calls.push(call);
          return { type: "opaque", ok: false, status: 0 } as unknown as Response;
        }
        if (!link.cors) {
          throw failed();
        }
        network.calls.push(call);
        const data = await abortable(link.service.handle({ method, path, query, headers, body: text }), init?.signal);
        await network.beforeResponse?.(call);
        if (network.dropWhen?.(call) || init?.signal?.aborted) {
          throw failed();
        }
        return toResponse(data);
      }

      if (network.offline) {
        throw failed();
      }
      await network.beforeRequest?.(call);
      if (network.offline) {
        throw failed();
      }
      const foreign = network.respondWith?.(call) ?? null;
      if (foreign) {
        return foreign;
      }
      network.calls.push(call);
      const data = await abortable(server.respond({ method, path, query, headers, body: text }), init?.signal);
      await network.beforeResponse?.(call);
      if (network.dropResponses > 0) {
        network.dropResponses -= 1;
        throw failed();
      }
      if (network.dropWhen?.(call)) {
        throw failed();
      }
      if (init?.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return toResponse(data);
    },
  };
  return network;
}
