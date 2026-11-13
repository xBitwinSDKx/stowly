/**
 * Aufrufe an den Stowly-Server (docs/sync-protokoll.md, Abschnitte 5, 6, 11 und 13).
 *
 * Jeder Fehlschlag wird zu einem `CoreError`:
 *
 * - Netzfehler, Zeitüberschreitung, 502/503/504 eines vorgeschalteten Proxys und jede
 *   Antwort, die nicht von Stowly stammt (z. B. die Anmeldeseite eines WLANs): "offline"
 * - Fehlerantworten des Servers (`ErrorBody`): der passende Code
 *
 * Ohne DOM: Diese Datei läuft auch im Service Worker.
 */
import { ENDPOINTS, type Device, type DeviceList, type ErrorCode, type LoginResponse, type ServerHealth, type SyncRequest, type SyncResponse } from "@/contract/api.gen";
import { CoreError, type CoreErrorCode } from "@/contract/errors";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Abbruch der Erreichbarkeitsprüfung (docs/sync-protokoll.md, 9.5). */
export const HEALTH_TIMEOUT_MS = 3_000;
/** Ein Abgleich darf dauern: Der erste Abzug eines großen Bestands ist kein kleiner Aufruf. */
export const SYNC_TIMEOUT_MS = 45_000;
export const REQUEST_TIMEOUT_MS = 15_000;

const OFFLINE_MESSAGE = "Der Server ist nicht erreichbar.";

const ERROR_CODES: Record<ErrorCode, CoreErrorCode> = {
  invalid_request: "invalid",
  unauthorized: "unauthorized",
  invalid_password: "invalid_password",
  rate_limited: "rate_limited",
  not_configured: "not_configured",
  not_found: "not_found",
  conflict: "invalid",
  protocol_mismatch: "protocol_mismatch",
  payload_too_large: "internal",
  not_implemented: "not_supported",
  internal: "internal",
};

interface Endpoint {
  readonly method: string;
  readonly path: string;
}

interface CallOptions {
  token?: string | null;
  body?: unknown;
  timeoutMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Macht aus einer Fehlerantwort einen CoreError. Antworten ohne das Fehlerformat des Servers gelten als „nicht erreichbar". */
async function errorFrom(response: Response): Promise<CoreError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const info = isRecord(body) && isRecord(body.error) ? body.error : null;
  const code = info && typeof info.code === "string" ? info.code : null;
  if (code === null || !Object.hasOwn(ERROR_CODES, code)) {
    // Kein Stowly-Fehler: ein Proxy ohne Server dahinter, ein fremdes Gerät unter derselben
    // Adresse. Auch ein 401 von dort sperrt das Gerät nicht: Nur der Server selbst darf das.
    return new CoreError("offline", OFFLINE_MESSAGE, { status: response.status });
  }
  const message = info && typeof info.message === "string" ? info.message : code;
  const details: Record<string, unknown> = { status: response.status, ...(info && isRecord(info.details) ? info.details : {}) };
  if (code === "rate_limited" && typeof details.retry_after_s !== "number") {
    const header = Number(response.headers.get("retry-after"));
    if (Number.isFinite(header) && header > 0) {
      details.retry_after_s = header;
    }
  }
  return new CoreError(ERROR_CODES[code as ErrorCode], message, details);
}

export class ApiClient {
  constructor(private readonly fetchFn: FetchLike) {}

  /**
   * Schickt den Aufruf ab und liest die Antwort mit `read`, wenn sie ein Erfolg ist.
   * Die Zeitgrenze gilt, bis auch der Rumpf gelesen ist.
   */
  private async call<T>(endpoint: Endpoint, path: string, options: CallOptions, read: (response: Response) => Promise<T>): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.token) {
      headers.authorization = `Bearer ${options.token}`;
    }
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchFn(path, { method: endpoint.method, headers, body, cache: "no-store", signal: controller.signal });
      } catch {
        throw new CoreError("offline", OFFLINE_MESSAGE);
      }
      if (!response.ok) {
        throw await errorFrom(response);
      }
      try {
        return await read(response);
      } catch {
        // Erfolg ohne lesbaren Rumpf: abgebrochen, oder das war nicht der Stowly-Server.
        throw new CoreError("offline", OFFLINE_MESSAGE);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private json<T>(endpoint: Endpoint, path: string, options: CallOptions): Promise<T> {
    return this.call(endpoint, path, options, (response) => response.json() as Promise<T>);
  }

  /** Ist der Server erreichbar? Liefert seine Antwort oder null. Wirft nicht. */
  async health(): Promise<ServerHealth | null> {
    try {
      const health = await this.json<ServerHealth>(ENDPOINTS.health, ENDPOINTS.health.path, { timeoutMs: HEALTH_TIMEOUT_MS });
      // Im WLAN des Pi antwortet womöglich etwas anderes: Nur der Marker zählt.
      return isRecord(health) && health.app === "stowly" ? health : null;
    } catch {
      return null;
    }
  }

  async login(password: string, deviceName: string): Promise<LoginResponse> {
    const response = await this.json<LoginResponse>(ENDPOINTS.login, ENDPOINTS.login.path, {
      body: { password, device_name: deviceName },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!isRecord(response) || typeof response.token !== "string" || !isRecord(response.device) || typeof response.device.id !== "string") {
      throw new CoreError("offline", OFFLINE_MESSAGE);
    }
    return response;
  }

  /** Sperrt das Token beim Server. Ein schon gesperrtes Token gilt als Erfolg. */
  async logout(token: string): Promise<void> {
    try {
      await this.call(ENDPOINTS.logout, ENDPOINTS.logout.path, { token, timeoutMs: REQUEST_TIMEOUT_MS }, async () => undefined);
    } catch (error) {
      if (error instanceof CoreError && error.code === "unauthorized") {
        return;
      }
      throw error;
    }
  }

  async sync(token: string, request: SyncRequest): Promise<SyncResponse> {
    const response = await this.json<SyncResponse>(ENDPOINTS.sync, ENDPOINTS.sync.path, { token, body: request, timeoutMs: SYNC_TIMEOUT_MS });
    if (!isSyncResponse(response)) {
      throw new CoreError("internal", "Der Server hat auf den Abgleich mit einer unbrauchbaren Antwort reagiert.");
    }
    return response;
  }

  async listDevices(token: string): Promise<Device[]> {
    const list = await this.json<DeviceList>(ENDPOINTS.list_devices, ENDPOINTS.list_devices.path, { token, timeoutMs: REQUEST_TIMEOUT_MS });
    return isRecord(list) && Array.isArray(list.devices) ? list.devices : [];
  }

  async renameDevice(token: string, deviceId: string, name: string): Promise<Device> {
    const path = ENDPOINTS.update_device.path.replace("{device_id}", encodeURIComponent(deviceId));
    return this.json<Device>(ENDPOINTS.update_device, path, { token, body: { name }, timeoutMs: REQUEST_TIMEOUT_MS });
  }

  async revokeDevice(token: string, deviceId: string): Promise<void> {
    const path = ENDPOINTS.revoke_device.path.replace("{device_id}", encodeURIComponent(deviceId));
    await this.call(ENDPOINTS.revoke_device, path, { token, timeoutMs: REQUEST_TIMEOUT_MS }, async () => undefined);
  }

  /** Lädt die Kopie der Datenbank. Der Name steht in `Content-Disposition`. */
  async backup(token: string): Promise<{ blob: Blob; filename: string | null }> {
    return this.call(ENDPOINTS.download_backup, ENDPOINTS.download_backup.path, { token, timeoutMs: 8 * REQUEST_TIMEOUT_MS }, async (response) => {
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const match = /filename="?([^";]+)"?/i.exec(disposition);
      return { blob, filename: match?.[1]?.trim() || null };
    });
  }
}

/** Grobe Prüfung der Form, bevor eine Antwort die lokale Kopie verändern darf. */
function isSyncResponse(value: unknown): value is SyncResponse {
  if (!isRecord(value) || !isRecord(value.changes) || !isRecord(value.id_pool)) {
    return false;
  }
  const changes = value.changes;
  const lists = ["products", "zones", "packages", "printers", "printer_status", "print_jobs", "label_templates"];
  return (
    typeof value.dataset_id === "string" &&
    typeof value.cursor === "number" &&
    typeof value.server_time === "string" &&
    typeof value.reset === "boolean" &&
    typeof value.has_more === "boolean" &&
    Array.isArray(value.results) &&
    Array.isArray(value.id_pool.grant) &&
    lists.every((name) => Array.isArray(changes[name])) &&
    (changes.settings === null || isRecord(changes.settings))
  );
}
