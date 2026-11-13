/**
 * Aufrufe an einen Druckdienst (docs/etiketten.md, Abschnitt 5): dieselbe Schnittstelle am
 * Server (`<Ursprung der App>/print`) und am Pi (jede Adresse aus `Printer.direct.urls`).
 *
 * Am Pi gilt „ohne Vorabanfrage" (5.2): Lesende Aufrufe sind `GET` ohne eigene Kopfzeilen,
 * schreibende sind `POST` mit `Content-Type: text/plain` und dem Token im JSON-Rumpf. Kein
 * `Authorization`-Kopf, kein `application/json`: Beides löste eine zusätzliche Anfrage des
 * Browsers aus (`OPTIONS`), und jede zusätzliche Anfrage ist auf dem Weg in den Keller eine
 * zusätzliche Fehlerquelle. Am Server (selber Ursprung) reist das Geräte-Token im Kopf.
 *
 * Tokens stehen nie in Fehlermeldungen oder Adressen.
 */
import type { ServiceHealth, ServiceJob } from "@/contract/api.gen";

import type { DeliveryContent } from "../db";
import type { FetchLike } from "../http";
import { addressSpaceOf, baseOf, type AddressSpace } from "./address";

/** Zeitgrenzen der App (docs/etiketten.md, 4.1). */
export const HEALTH_TIMEOUT_MS = 1_500;
export const SUBMIT_TIMEOUT_MS = 10_000;
/** Nachfragen: die Wartezeit des Dienstes (`wait`) plus fünf Sekunden; mit `wait=10` also 15. */
export const FOLLOW_UP_MARGIN_MS = 5_000;
export const RENDER_TIMEOUT_MS = 15_000;

export type ServiceEndpoint =
  /** Der Druckdienst des Servers unter `/print`, mit dem Geräte-Token. */
  | { kind: "server"; token: string }
  /** Ein Druckdienst unter einer eigenen Adresse (Pi), mit dem Token des Druckers. */
  | { kind: "direct"; base: string; token: string };

/**
 * Antwort eines Druckdienstes.
 * - `ok`: Erfolg mit Inhalt.
 * - `reached`: Der Dienst hat mit einem Fehler in seinem Format geantwortet (`code`).
 * - sonst: keine verwertbare Antwort (Netzfehler, Zeitüberschreitung, Abbruch, oder es
 *   antwortet etwas, das kein Druckdienst ist). `timedOut`: Bis zur Zeitgrenze kam gar
 *   nichts; sonst scheiterte die Anfrage sofort (abgewiesen, Zertifikat, CORS).
 */
export type ServiceReply<T> =
  | { ok: true; status: number; value: T }
  | { ok: false; reached: true; status: number; code: string; message: string; details: Record<string, unknown> | null }
  | { ok: false; reached: false; timedOut: boolean };

const UNREACHED: ServiceReply<never> = { ok: false, reached: false, timedOut: false };
const TIMED_OUT: ServiceReply<never> = { ok: false, reached: false, timedOut: true };

/** `RequestInit` samt der Angabe des Adressraums, die die Typen des Browsers noch nicht kennen. */
type DirectRequestInit = RequestInit & { targetAddressSpace?: AddressSpace };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHealth(value: unknown): value is ServiceHealth {
  return isRecord(value) && typeof value.boot_id === "string" && Array.isArray(value.printers);
}

function isJob(value: unknown): value is ServiceJob {
  return isRecord(value) && typeof value.id === "string" && typeof value.state === "string" && typeof value.boot_id === "string";
}

interface CallOptions {
  method: "GET" | "POST";
  /** Pfad unterhalb der Basis, z. B. "/v1/health?nonce=…". */
  path: string;
  /** JSON-Rumpf ohne Token; das Token setzt `call` passend zum Dienst ein. */
  body?: Record<string, unknown>;
  timeoutMs: number;
  /** Bricht den Aufruf von außen ab (das Nachfragen gibt einem neuen Versuch nach). */
  signal?: AbortSignal;
}

export class PrintServiceClient {
  constructor(private readonly fetchFn: FetchLike) {}

  /**
   * Ein Aufruf samt Zeitgrenze. `read` liest eine gelungene Antwort; wirft es oder liefert es
   * null, gilt die Antwort als nicht verwertbar.
   */
  private async call<T>(endpoint: ServiceEndpoint, options: CallOptions, read: (response: Response) => Promise<T | null>): Promise<ServiceReply<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    const outside = options.signal;
    const abortFromOutside = () => controller.abort();
    if (outside?.aborted) {
      controller.abort();
    } else {
      outside?.addEventListener("abort", abortFromOutside, { once: true });
    }
    try {
      let url: string;
      let init: DirectRequestInit;
      if (endpoint.kind === "server") {
        url = `/print${options.path}`;
        const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${endpoint.token}` };
        init = { method: options.method, headers, cache: "no-store", signal: controller.signal };
        if (options.body !== undefined) {
          headers["content-type"] = "application/json";
          init.body = JSON.stringify(options.body);
        }
      } else {
        url = `${baseOf(endpoint.base)}${options.path}`;
        init = {
          method: options.method,
          cache: "no-store",
          credentials: "omit",
          targetAddressSpace: addressSpaceOf(endpoint.base),
          signal: controller.signal,
        };
        if (options.method === "POST") {
          // Ein „einfacher" Aufruf im Sinne von CORS: keine Vorabanfrage.
          init.headers = { "Content-Type": "text/plain" };
          init.body = JSON.stringify({ token: endpoint.token, ...options.body });
        }
      }
      let response: Response;
      try {
        response = await this.fetchFn(url, init);
      } catch {
        return controller.signal.aborted ? TIMED_OUT : UNREACHED;
      }
      if (response.ok) {
        try {
          const value = await read(response);
          return value === null ? UNREACHED : { ok: true, status: response.status, value };
        } catch {
          return UNREACHED;
        }
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return UNREACHED;
      }
      const info = isRecord(body) && isRecord(body.error) ? body.error : null;
      if (!info || typeof info.code !== "string") {
        // Kein Fehler im Format des Dienstes: ein Proxy ohne Dienst dahinter, ein fremdes Gerät.
        return UNREACHED;
      }
      return {
        ok: false,
        reached: true,
        status: response.status,
        code: info.code,
        message: typeof info.message === "string" ? info.message : info.code,
        details: isRecord(info.details) ? info.details : null,
      };
    } finally {
      clearTimeout(timer);
      outside?.removeEventListener("abort", abortFromOutside);
    }
  }

  /**
   * Zustand des Dienstes. Mit `nonce` weist er sich aus (`proof`); am Server entfällt das.
   * `timeoutMs`: länger als üblich nur, wenn die Anfrage die Nachfrage des Browsers nach dem
   * lokalen Netzwerk auslösen kann (src/core/print/connect.ts).
   */
  health(endpoint: ServiceEndpoint, nonce: string | null, timeoutMs: number = HEALTH_TIMEOUT_MS): Promise<ServiceReply<ServiceHealth>> {
    const path = nonce === null ? "/v1/health" : `/v1/health?nonce=${encodeURIComponent(nonce)}`;
    return this.call(endpoint, { method: "GET", path, timeoutMs }, async (response) => {
      const value: unknown = await response.json();
      return isHealth(value) ? value : null;
    });
  }

  /**
   * Reicht einen Auftrag ein. `content` und `expectBootId` sind die beim ersten Absenden
   * festgehaltenen Werte; eine Wiederholung schickt genau diese wieder.
   */
  submit(endpoint: ServiceEndpoint, jobId: string, content: DeliveryContent, expectBootId: string | null, waitS: number): Promise<ServiceReply<ServiceJob>> {
    const body: Record<string, unknown> = {
      printer: content.printer,
      template: content.template,
      data: content.data,
      copies: content.copies,
      cut: content.cut,
      expect_boot_id: expectBootId,
    };
    return this.call(endpoint, { method: "POST", path: `/v1/jobs/${encodeURIComponent(jobId)}?wait=${waitS}`, body, timeoutMs: SUBMIT_TIMEOUT_MS }, async (response) => {
      const value: unknown = await response.json();
      return isJob(value) ? value : null;
    });
  }

  /**
   * Zustand eines Auftrags; `waitS` lässt den Dienst so lange auf einen Endzustand warten.
   * `signal` bricht die Abfrage ab; am Dienst ändert sie nichts.
   */
  job(endpoint: ServiceEndpoint, jobId: string, waitS: number, signal?: AbortSignal): Promise<ServiceReply<ServiceJob>> {
    const path = `/v1/jobs/${encodeURIComponent(jobId)}${waitS > 0 ? `?wait=${waitS}` : ""}`;
    return this.call(endpoint, { method: "GET", path, timeoutMs: waitS * 1_000 + FOLLOW_UP_MARGIN_MS, signal }, async (response) => {
      const value: unknown = await response.json();
      return isJob(value) ? value : null;
    });
  }

  /** Verwirft einen Auftrag, solange er wartet. */
  cancel(endpoint: ServiceEndpoint, jobId: string): Promise<ServiceReply<ServiceJob>> {
    return this.call(endpoint, { method: "POST", path: `/v1/jobs/${encodeURIComponent(jobId)}/cancel`, body: {}, timeoutMs: SUBMIT_TIMEOUT_MS }, async (response) => {
      const value: unknown = await response.json();
      return isJob(value) ? value : null;
    });
  }

  /** Vorschau: rendert, ohne zu drucken. */
  render(endpoint: ServiceEndpoint, body: { template: Record<string, unknown>; data: Record<string, string>; printer?: string }): Promise<ServiceReply<Blob>> {
    return this.call(endpoint, { method: "POST", path: "/v1/render", body, timeoutMs: RENDER_TIMEOUT_MS }, (response) => response.blob());
  }

  /** Das Bild, das der Bild-Treiber für einen Auftrag geschrieben hat. */
  image(endpoint: ServiceEndpoint, jobId: string): Promise<ServiceReply<Blob>> {
    return this.call(endpoint, { method: "GET", path: `/v1/jobs/${encodeURIComponent(jobId)}/image`, timeoutMs: RENDER_TIMEOUT_MS }, (response) => response.blob());
  }

  /**
   * Antwortet unter dieser Adresse überhaupt etwas? Eine Anfrage ohne CORS liefert der Seite
   * nichts Lesbares, aber sie gelingt, sobald ein Dienst da ist. So lässt sich „nicht
   * erreichbar" von „lässt diese App nicht mitlesen" unterscheiden (docs/etiketten.md, 5.6).
   */
  async respondsWithoutCors(base: string): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const init: DirectRequestInit = {
        method: "GET",
        mode: "no-cors",
        cache: "no-store",
        credentials: "omit",
        targetAddressSpace: addressSpaceOf(base),
        signal: controller.signal,
      };
      await this.fetchFn(`${baseOf(base)}/v1/health`, init);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
