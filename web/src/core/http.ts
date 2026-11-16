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
import {
  ENDPOINTS,
  type Device,
  type DeviceList,
  type ErrorCode,
  type IntegrationStatus,
  type LoginResponse,
  type LookupResult,
  type LookupResultState,
  type PasswordChangeInput,
  type PiPairing,
  type PiPairingInput,
  type PushSubscriptionInput,
  type PushTestResult,
  type PushTestStatus,
  type ServerConfig,
  type ServerConfigChanges,
  type ServerHealth,
  type SetupChanges,
  type SetupPasswordInput,
  type SetupStatus,
  type Stats,
  type SyncRequest,
  type SyncResponse,
  type UpdateInstallInput,
  type UpdateState,
  type UpdateStatus,
} from "@/contract/api.gen";
import { SECURE_CHECK_TIMEOUT_MS, type StatsRange } from "@/contract/core";
import { CoreError, type CoreErrorCode } from "@/contract/errors";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Abbruch der Erreichbarkeitsprüfung (docs/sync-protokoll.md, 9.5). */
export const HEALTH_TIMEOUT_MS = 3_000;
/** Ein Abgleich darf dauern: Der erste Abzug eines großen Bestands ist kein kleiner Aufruf. */
export const SYNC_TIMEOUT_MS = 45_000;
export const REQUEST_TIMEOUT_MS = 15_000;
/** Nachschlagen beim Scannen: Der Server wartet bis zu 4 Sekunden auf Open Food Facts, dazu der Weg. */
export const LOOKUP_TIMEOUT_MS = 6_000;

const LOOKUP_STATES: ReadonlySet<string> = new Set<LookupResultState>(["found", "not_found", "pending", "skipped", "disabled"]);
const PUSH_TEST_STATES: ReadonlySet<string> = new Set<PushTestStatus>(["sent", "gone", "rejected", "failed"]);
const UPDATE_STATES: ReadonlySet<string> = new Set<UpdateState>(["idle", "requested", "installing", "done", "failed"]);

const OFFLINE_MESSAGE = "Der Server ist nicht erreichbar.";

const ERROR_CODES: Record<ErrorCode, CoreErrorCode> = {
  invalid_request: "invalid",
  unauthorized: "unauthorized",
  invalid_password: "invalid_password",
  rate_limited: "rate_limited",
  not_configured: "not_configured",
  not_found: "not_found",
  conflict: "conflict",
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

  /** Eine JSON-Antwort, deren Form `valid` prüft. Was nicht so aussieht, stammt nicht vom Stowly-Server: "offline". */
  private async checked<T>(endpoint: Endpoint, path: string, options: CallOptions, valid: (value: unknown) => value is T): Promise<T> {
    const answer = await this.json<unknown>(endpoint, path, options);
    if (!valid(answer)) {
      throw new CoreError("offline", OFFLINE_MESSAGE);
    }
    return answer;
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

  login(password: string, deviceName: string): Promise<LoginResponse> {
    return this.checked(ENDPOINTS.login, ENDPOINTS.login.path, { body: { password, device_name: deviceName }, timeoutMs: REQUEST_TIMEOUT_MS }, isLoginResponse);
  }

  // ---------------------------------------------------------------- Einrichtung (Protokoll 5, 11.6 bis 11.8)

  /** Das erste Haushalts-Passwort (`POST /api/setup/password`, ohne Anmeldung); die Antwort gleicht der Anmeldung. */
  createPassword(password: string, deviceName: string): Promise<LoginResponse> {
    const body: SetupPasswordInput = { password, device_name: deviceName };
    return this.checked(ENDPOINTS.setup_password, ENDPOINTS.setup_password.path, { body, timeoutMs: REQUEST_TIMEOUT_MS }, isLoginResponse);
  }

  /** Ein neues Haushalts-Passwort (`POST /api/auth/password`, 204). */
  async changePassword(token: string, current: string, next: string): Promise<void> {
    const body: PasswordChangeInput = { current_password: current, new_password: next };
    await this.call(ENDPOINTS.change_password, ENDPOINTS.change_password.path, { token, body, timeoutMs: REQUEST_TIMEOUT_MS }, async () => undefined);
  }

  setupStatus(token: string): Promise<SetupStatus> {
    return this.checked(ENDPOINTS.get_setup, ENDPOINTS.get_setup.path, { token, timeoutMs: REQUEST_TIMEOUT_MS }, isSetupStatus);
  }

  updateSetup(token: string, changes: SetupChanges): Promise<SetupStatus> {
    return this.checked(ENDPOINTS.update_setup, ENDPOINTS.update_setup.path, { token, body: changes, timeoutMs: REQUEST_TIMEOUT_MS }, isSetupStatus);
  }

  serverConfig(token: string): Promise<ServerConfig> {
    return this.checked(ENDPOINTS.get_server_config, ENDPOINTS.get_server_config.path, { token, timeoutMs: REQUEST_TIMEOUT_MS }, isServerConfig);
  }

  patchServerConfig(token: string, changes: ServerConfigChanges): Promise<ServerConfig> {
    return this.checked(ENDPOINTS.update_server_config, ENDPOINTS.update_server_config.path, { token, body: changes, timeoutMs: REQUEST_TIMEOUT_MS }, isServerConfig);
  }

  createPairing(token: string, input: PiPairingInput): Promise<PiPairing> {
    return this.checked(ENDPOINTS.create_pi_pairing, ENDPOINTS.create_pi_pairing.path, { token, body: input, timeoutMs: REQUEST_TIMEOUT_MS }, isPairing);
  }

  pairing(token: string, id: string): Promise<PiPairing> {
    const path = ENDPOINTS.get_pi_pairing.path.replace("{pairing_id}", encodeURIComponent(id));
    return this.checked(ENDPOINTS.get_pi_pairing, path, { token, timeoutMs: REQUEST_TIMEOUT_MS }, isPairing);
  }

  /** Bricht eine Kopplung ab; eine unbekannte (404) gilt als abgebrochen. */
  async cancelPairing(token: string, id: string): Promise<void> {
    const path = ENDPOINTS.cancel_pi_pairing.path.replace("{pairing_id}", encodeURIComponent(id));
    try {
      await this.call(ENDPOINTS.cancel_pi_pairing, path, { token, timeoutMs: REQUEST_TIMEOUT_MS }, async () => undefined);
    } catch (error) {
      if (!(error instanceof CoreError && error.code === "not_found")) {
        throw error;
      }
    }
  }

  /**
   * Antwortet HTTPS unter `origin` mit einem Zertifikat, dem dieses Gerät vertraut? Ein Abruf ohne
   * CORS auf `/api/health`: Er gelingt (undurchsichtig), sobald die Verbindung steht, und scheitert
   * bei fremdem Zertifikat oder geschlossenem Port (docs/integrationen.md, 11.5). Wirft nicht.
   */
  async reachesSecurely(origin: string): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SECURE_CHECK_TIMEOUT_MS);
    try {
      await this.fetchFn(`${origin.replace(/\/+$/, "")}${ENDPOINTS.health.path}`, { mode: "no-cors", cache: "no-store", credentials: "omit", signal: controller.signal });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
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

  /**
   * Schlägt einen Barcode nach (`GET /api/lookup/{barcode}?wait=…`); der Server wartet bis zu
   * `waitS` Sekunden auf Open Food Facts. Eine Antwort, die nicht so aussieht, gilt als „nicht
   * erreichbar".
   */
  async lookup(token: string, barcode: string, waitS: number): Promise<LookupResult> {
    const path = `${ENDPOINTS.lookup_barcode.path.replace("{barcode}", encodeURIComponent(barcode))}?wait=${String(waitS)}`;
    const answer = await this.json<LookupResult>(ENDPOINTS.lookup_barcode, path, { token, timeoutMs: LOOKUP_TIMEOUT_MS });
    if (
      !isRecord(answer) ||
      typeof answer.state !== "string" ||
      !LOOKUP_STATES.has(answer.state) ||
      typeof answer.name !== "string" ||
      typeof answer.brand !== "string" ||
      typeof answer.quantity !== "string" ||
      !(answer.image_id === null || typeof answer.image_id === "string")
    ) {
      throw new CoreError("offline", OFFLINE_MESSAGE);
    }
    return answer;
  }

  // ---------------------------------------------------------------- Push (Protokoll 11.3)

  /** Der öffentliche VAPID-Schlüssel des Servers (`GET /api/push/key`). 503 = nicht eingerichtet. */
  async pushKey(token: string): Promise<string> {
    const answer = await this.json<{ public_key?: unknown }>(ENDPOINTS.get_push_key, ENDPOINTS.get_push_key.path, { token, timeoutMs: REQUEST_TIMEOUT_MS });
    if (!isRecord(answer) || typeof answer.public_key !== "string" || answer.public_key === "") {
      throw new CoreError("offline", OFFLINE_MESSAGE);
    }
    return answer.public_key;
  }

  /** Legt das Abo dieses Geräts beim Server an oder ersetzt es (`PUT /api/push/subscription`). */
  async putPushSubscription(token: string, subscription: PushSubscriptionInput): Promise<void> {
    await this.call(ENDPOINTS.put_push_subscription, ENDPOINTS.put_push_subscription.path, { token, body: subscription, timeoutMs: REQUEST_TIMEOUT_MS }, async () => undefined);
  }

  /** Löscht das Abo dieses Geräts beim Server; auch ohne Abo ein Erfolg. */
  async deletePushSubscription(token: string): Promise<void> {
    await this.call(ENDPOINTS.delete_push_subscription, ENDPOINTS.delete_push_subscription.path, { token, timeoutMs: REQUEST_TIMEOUT_MS }, async () => undefined);
  }

  /** Schickt eine Testnachricht an dieses Gerät; der Server antwortet, wenn der Push-Dienst geantwortet hat. */
  async pushTest(token: string): Promise<PushTestResult> {
    const answer = await this.json<PushTestResult>(ENDPOINTS.send_push_test, ENDPOINTS.send_push_test.path, { token, timeoutMs: REQUEST_TIMEOUT_MS });
    if (
      !isRecord(answer) ||
      typeof answer.status !== "string" ||
      !PUSH_TEST_STATES.has(answer.status) ||
      !(answer.http_status === null || typeof answer.http_status === "number") ||
      typeof answer.message !== "string"
    ) {
      throw new CoreError("offline", OFFLINE_MESSAGE);
    }
    return { status: answer.status, http_status: answer.http_status, message: answer.message };
  }

  /** Der Zustand von Sicherung, Home Assistant, Push und Updates (`GET /api/integrations`). */
  async integrations(token: string): Promise<IntegrationStatus> {
    const answer = await this.json<IntegrationStatus>(ENDPOINTS.get_integrations, ENDPOINTS.get_integrations.path, { token, timeoutMs: REQUEST_TIMEOUT_MS });
    if (
      !isRecord(answer) ||
      typeof answer.timezone !== "string" ||
      !isRecord(answer.backup) ||
      !isRecord(answer.ha) ||
      !isRecord(answer.push) ||
      !isRecord(answer.update)
    ) {
      throw new CoreError("offline", OFFLINE_MESSAGE);
    }
    return answer;
  }

  // ---------------------------------------------------------------- Updates (Protokoll 11.5)

  /**
   * Fragt GitHub sofort nach dem neuesten Release (`POST /api/update/check`) und liefert den
   * Zustand danach. Ein Fehler bei GitHub steht in `check_error`; 429 kommt als "rate_limited".
   */
  async checkUpdate(token: string): Promise<UpdateStatus> {
    const answer = await this.json<UpdateStatus>(ENDPOINTS.check_update, ENDPOINTS.check_update.path, { token, timeoutMs: REQUEST_TIMEOUT_MS });
    if (!isUpdateStatus(answer)) {
      throw new CoreError("offline", OFFLINE_MESSAGE);
    }
    return answer;
  }

  /**
   * Fordert das Update auf `version` beim Updater an (`POST /api/update/install`, 202) und liefert
   * den Zustand danach. Die Version geht so hinaus, wie sie ist: Ihre Form prüft der Server (422).
   */
  async installUpdate(token: string, version: string): Promise<UpdateStatus> {
    const body: UpdateInstallInput = { version };
    const answer = await this.json<UpdateStatus>(ENDPOINTS.install_update, ENDPOINTS.install_update.path, { token, body, timeoutMs: REQUEST_TIMEOUT_MS });
    if (!isUpdateStatus(answer)) {
      throw new CoreError("offline", OFFLINE_MESSAGE);
    }
    return answer;
  }

  /**
   * Die Statistik (`GET /api/stats?start=&end=`, Protokoll 11.1). Gesendet wird nur, was angegeben
   * ist, so wie es ist: Den Zeitraum prüft der Server (400, als "invalid" mit seinem Satz).
   */
  async stats(token: string, range?: StatsRange | null): Promise<Stats> {
    const query = new URLSearchParams();
    for (const field of ["start", "end"] as const) {
      const given = range?.[field];
      if (given !== undefined) {
        query.set(field, String(given));
      }
    }
    const search = query.toString();
    const path = search === "" ? ENDPOINTS.get_stats.path : `${ENDPOINTS.get_stats.path}?${search}`;
    const answer = await this.json<Stats>(ENDPOINTS.get_stats, path, { token, timeoutMs: REQUEST_TIMEOUT_MS });
    if (!isStats(answer)) {
      throw new CoreError("offline", OFFLINE_MESSAGE);
    }
    return answer;
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

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

/** Die Felder eines `UpdateStatus`, die Text oder null sind. */
const UPDATE_TEXTS = [
  "repo",
  "latest",
  "latest_name",
  "notes",
  "published_at",
  "url",
  "checked_at",
  "check_error",
  "updater_seen_at",
  "state_version",
  "state_at",
  "state_message",
] as const;

/**
 * Prüfung der Form eines `UpdateStatus` (docs/integrationen.md, 10.4), als Antwort auf Suchen und
 * Anfordern: Was nicht so aussieht, stammt nicht vom Stowly-Server. Im Zustand der Integrationen
 * genügt wie bei den übrigen Teilen ein Objekt; ein Fehler darin soll dort nicht auch Sicherung,
 * Home Assistant und Push verbergen.
 */
function isUpdateStatus(value: unknown): value is UpdateStatus {
  return (
    isRecord(value) &&
    typeof value.configured === "boolean" &&
    typeof value.current === "string" &&
    typeof value.available === "boolean" &&
    typeof value.updater_ready === "boolean" &&
    typeof value.state === "string" &&
    UPDATE_STATES.has(value.state) &&
    UPDATE_TEXTS.every((key) => value[key] === null || typeof value[key] === "string") &&
    // Seit 0.3.0 (docs/integrationen.md, 10.4); ein älterer Server lässt sie weg.
    ["updater_kind", "updater_version", "updater_command"].every((key) => value[key] == null || typeof value[key] === "string")
  );
}

const isText = (value: unknown): value is string => typeof value === "string";
const isTextOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";
const isPortOrNull = (value: unknown): boolean => value === null || (typeof value === "number" && Number.isInteger(value));

function isLoginResponse(value: unknown): value is LoginResponse {
  return isRecord(value) && isText(value.token) && isRecord(value.device) && isText(value.device.id);
}

/** Prüfung der Form von `SetupStatus`, soweit die App sie liest. */
function isSetupStatus(value: unknown): value is SetupStatus {
  if (!isRecord(value) || !isRecord(value.https)) {
    return false;
  }
  const https = value.https;
  const ca = https.ca;
  const paired = value.paired_printers;
  return (
    isText(value.password_source) &&
    isTextOrNull(value.finished_at) &&
    // Seit Runde 2 der Einrichtung; ein Server davor lässt es weg.
    (paired === undefined || (Array.isArray(paired) && paired.every((entry) => isRecord(entry) && isText(entry.printer_id) && isText(entry.not_after)))) &&
    Array.isArray(value.steps) &&
    value.steps.every((step) => isRecord(step) && isText(step.id) && isText(step.state) && typeof step.ready === "boolean") &&
    typeof https.enabled === "boolean" &&
    typeof https.listening === "boolean" &&
    isTextOrNull(https.problem) &&
    isPortOrNull(https.port) &&
    isPortOrNull(https.http_port) &&
    Array.isArray(https.addresses) &&
    https.addresses.every((address) => isRecord(address) && isText(address.address)) &&
    Array.isArray(https.origins) &&
    (ca === null || (isRecord(ca) && isText(ca.name) && isText(ca.fingerprint_sha256)))
  );
}

function isServerConfig(value: unknown): value is ServerConfig {
  return (
    isRecord(value) &&
    isRecord(value.push) &&
    isTextOrNull(value.push.contact) &&
    isText(value.push.source) &&
    isRecord(value.update) &&
    typeof value.update.enabled === "boolean" &&
    typeof value.update.available === "boolean" &&
    isText(value.update.source)
  );
}

function isPairing(value: unknown): value is PiPairing {
  const pi = isRecord(value) ? value.pi : undefined;
  return (
    isRecord(value) &&
    isText(value.id) &&
    isText(value.state) &&
    isText(value.expires_at) &&
    isTextOrNull(value.code) &&
    isTextOrNull(value.command) &&
    isTextOrNull(value.printer_id) &&
    (pi === null || (isRecord(pi) && isText(pi.hostname) && Array.isArray(pi.addresses)))
  );
}

/** Prüfung der Form einer Statistik: Was nicht so aussieht, stammt nicht vom Stowly-Server. */
function isStats(value: unknown): value is Stats {
  if (!isRecord(value)) {
    return false;
  }
  const share = value.discarded_share;
  return (
    typeof value.start === "string" &&
    typeof value.end === "string" &&
    typeof value.timezone === "string" &&
    isCount(value.consumed) &&
    isCount(value.discarded) &&
    (share === null || (typeof share === "number" && share >= 0 && share <= 1)) &&
    Array.isArray(value.months) &&
    value.months.every((month) => isRecord(month) && typeof month.month === "string" && isCount(month.consumed) && isCount(month.discarded)) &&
    Array.isArray(value.top_discarded) &&
    value.top_discarded.every(
      (product) =>
        isRecord(product) &&
        typeof product.product_id === "string" &&
        typeof product.name === "string" &&
        (product.barcode === null || typeof product.barcode === "string") &&
        isCount(product.discarded),
    ) &&
    Array.isArray(value.zones) &&
    value.zones.every((zone) => isRecord(zone) && typeof zone.zone_id === "string" && typeof zone.name === "string" && isCount(zone.consumed) && isCount(zone.discarded))
  );
}

/** Grobe Prüfung der Form, bevor eine Antwort die lokale Kopie verändern darf. */
function isSyncResponse(value: unknown): value is SyncResponse {
  if (!isRecord(value) || !isRecord(value.changes) || !isRecord(value.id_pool)) {
    return false;
  }
  const changes = value.changes;
  const lists = ["products", "zones", "packages", "printers", "printer_status", "print_jobs", "label_templates", "shopping_items"];
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
