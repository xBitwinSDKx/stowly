/**
 * Verwaltung des Servers aus der App (Einrichtung, Stufe B; docs/plan-einrichtung-b.md, 1 und 3):
 * „Jetzt sichern", die Sicherungen im Ordner und Home Assistant samt Sensor-Token.
 *
 * Ein eigener, nachgeladener Teil des Kerns: `createCore` holt ihn erst beim ersten Aufruf
 * (index.ts, `later`). So bleibt er aus dem Hauptpaket. Alles braucht den Server und eine
 * Anmeldung (`CoreRuntime.server`); gespeichert wird hier nichts.
 */
import {
  CoreError,
  ENDPOINTS,
  LIMITS,
  type BackupApi,
  type BackupFile,
  type HaCheck,
  type HaCheckInput,
  type HaConfig,
  type HaConfigApi,
  type HaConfigChanges,
  type HaSensorToken,
} from "@/contract";

import type { CoreRuntime } from "./api/runtime";
import { ApiClient, isCount, isRecord, isText, isTextOrNull, REQUEST_TIMEOUT_MS, type FetchLike } from "./http";

/** „Jetzt sichern" packt und verschlüsselt die ganze Datenbank: auf einem kleinen NAS dauert das. */
export const BACKUP_RUN_TIMEOUT_MS = 300_000;
/** Eine Sicherung zum Herunterladen kann groß sein. */
export const BACKUP_FILE_TIMEOUT_MS = 600_000;
/** Die Prüfung bei Home Assistant hat beim Server feste Fristen (höchstens 12 Sekunden); dazu der Weg. */
export const HA_CHECK_TIMEOUT_MS = 20_000;

/** Die Liste in Home Assistant, wie der Vertrag sie zulässt (`HaEntity`). */
const ENTITY = /^todo\.[a-z0-9_]+$/;
/** Eine Adresse von Home Assistant: http oder https, ohne Leerraum. */
const URL_PATTERN = /^https?:\/\/[^\s/?#@]+(:\d+)?\/?$/i;

const isBool = (value: unknown): value is boolean => typeof value === "boolean";

function isBackupFile(value: unknown): value is BackupFile {
  return isRecord(value) && isText(value.name) && isCount(value.size) && isText(value.created_at);
}

function isHaConfig(value: unknown): value is HaConfig {
  const sensor = isRecord(value) ? value.sensor : undefined;
  return (
    isRecord(value) &&
    isText(value.source) &&
    isTextOrNull(value.url) &&
    isTextOrNull(value.entity) &&
    isBool(value.token_set) &&
    isTextOrNull(value.token_set_at) &&
    isBool(value.ca) &&
    isBool(value.configured) &&
    isTextOrNull(value.problem) &&
    isRecord(sensor) &&
    isText(sensor.source) &&
    isBool(sensor.set) &&
    isTextOrNull(sensor.set_at)
  );
}

function isHaCheck(value: unknown): value is HaCheck {
  return (
    isRecord(value) &&
    isText(value.state) &&
    isText(value.message) &&
    isTextOrNull(value.ha_version) &&
    isTextOrNull(value.location_name) &&
    Array.isArray(value.lists) &&
    value.lists.every((list) => isRecord(list) && isText(list.entity_id) && isText(list.name) && (list.open === null || isCount(list.open))) &&
    (value.entity_found === null || isBool(value.entity_found))
  );
}

function isSensorToken(value: unknown): value is HaSensorToken {
  return isRecord(value) && isText(value.token) && value.token !== "";
}

function invalid(field: "url" | "entity" | "token", message: string): CoreError {
  return new CoreError("invalid", message, { errors: [{ loc: ["body", field], msg: message, type: "value_error" }] });
}

/** Prüft eine Adresse von Home Assistant vorab, wie der Vertrag sie zulässt; liefert sie ohne Leerraum am Rand. */
export function checkHaUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed === "") {
    throw invalid("url", "Bitte die Adresse von Home Assistant eingeben, etwa http://192.168.1.20:8123.");
  }
  if (trimmed.length > LIMITS.ha_url || !URL_PATTERN.test(trimmed)) {
    throw invalid("url", "Die Adresse beginnt mit http:// oder https://, etwa http://192.168.1.20:8123, ohne Pfad und ohne Benutzer.");
  }
  return trimmed.replace(/\/$/, "");
}

/** Prüft einen Zugangs-Token von Home Assistant vorab; liefert ihn ohne Leerraum am Rand. */
export function checkHaToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed === "" || trimmed.length > LIMITS.ha_token || /\s/.test(trimmed)) {
    throw invalid("token", "Bitte den langlebigen Zugangs-Token aus dem Profil von Home Assistant einfügen (ohne Leerzeichen).");
  }
  return trimmed;
}

/** Prüft die Kennung einer To-do-Liste vorab (`todo.einkaufsliste`). */
export function checkHaEntity(entity: string): string {
  const trimmed = entity.trim();
  if (!ENTITY.test(trimmed) || trimmed.length > 255) {
    throw invalid("entity", "Eine Liste heißt in Home Assistant todo.… (Kleinbuchstaben, Ziffern und _), etwa todo.einkaufsliste.");
  }
  return trimmed;
}

/** Die Aufrufe dieses Teils, gebaut auf `ApiClient`. */
class AdminClient extends ApiClient {
  runBackup(token: string): Promise<BackupFile> {
    return this.checked(ENDPOINTS.run_backup, ENDPOINTS.run_backup.path, { token, timeoutMs: BACKUP_RUN_TIMEOUT_MS }, isBackupFile);
  }

  backupFile(token: string, name: string): Promise<Blob> {
    const path = ENDPOINTS.download_backup_file.path.replace("{name}", encodeURIComponent(name));
    return this.call(ENDPOINTS.download_backup_file, path, { token, timeoutMs: BACKUP_FILE_TIMEOUT_MS }, (response) => response.blob());
  }

  haConfig(token: string): Promise<HaConfig> {
    return this.checked(ENDPOINTS.get_ha_config, ENDPOINTS.get_ha_config.path, { token, timeoutMs: REQUEST_TIMEOUT_MS }, isHaConfig);
  }

  updateHaConfig(token: string, changes: HaConfigChanges): Promise<HaConfig> {
    return this.checked(ENDPOINTS.update_ha_config, ENDPOINTS.update_ha_config.path, { token, body: changes, timeoutMs: REQUEST_TIMEOUT_MS }, isHaConfig);
  }

  checkHa(token: string, input: HaCheckInput): Promise<HaCheck> {
    return this.checked(ENDPOINTS.check_ha, ENDPOINTS.check_ha.path, { token, body: input, timeoutMs: HA_CHECK_TIMEOUT_MS }, isHaCheck);
  }

  async sensorToken(token: string, create: boolean): Promise<string> {
    const endpoint = create ? ENDPOINTS.create_ha_sensor_token : ENDPOINTS.get_ha_sensor_token;
    return (await this.checked(endpoint, endpoint.path, { token, timeoutMs: REQUEST_TIMEOUT_MS }, isSensorToken)).token;
  }

  async deleteSensorToken(token: string): Promise<void> {
    await this.call(ENDPOINTS.delete_ha_sensor_token, ENDPOINTS.delete_ha_sensor_token.path, { token, timeoutMs: REQUEST_TIMEOUT_MS }, async () => undefined);
  }
}

/** Nur die vorhandenen Felder, vorab geprüft und ohne Leerraum am Rand; null bleibt null (entfernen). */
function cleanChanges(changes: HaConfigChanges): HaConfigChanges {
  const result: HaConfigChanges = {};
  if (changes.url !== undefined) {
    result.url = changes.url === null ? null : checkHaUrl(changes.url);
  }
  if (changes.entity !== undefined) {
    result.entity = changes.entity === null ? null : checkHaEntity(changes.entity);
  }
  if (changes.token !== undefined) {
    result.token = changes.token === null ? null : checkHaToken(changes.token);
  }
  return result;
}

function cleanCheck(input: HaCheckInput | undefined): HaCheckInput {
  const result: HaCheckInput = {};
  if (typeof input?.url === "string") {
    result.url = checkHaUrl(input.url);
  }
  if (typeof input?.token === "string" && input.token.trim() !== "") {
    result.token = checkHaToken(input.token);
  }
  return result;
}

export interface Admin {
  backup: BackupApi;
  haConfig: HaConfigApi;
}

/** Sicherung und Home Assistant für `createCore`; `fetchFn` ist das `fetch` des Kerns. */
export function createAdmin(runtime: CoreRuntime, fetchFn: FetchLike): Admin {
  const client = new AdminClient(fetchFn);
  const server = runtime.server.bind(runtime);
  return {
    backup: {
      run: () => server((token) => client.runBackup(token)),
      async file(name) {
        if (typeof name !== "string" || !/^[\w.-]+$/.test(name)) {
          throw new CoreError("not_found", "Diese Sicherung gibt es nicht.");
        }
        return server((token) => client.backupFile(token, name));
      },
    },
    haConfig: {
      load: () => server((token) => client.haConfig(token)),
      async update(changes) {
        const wanted = cleanChanges(changes);
        return server((token) => client.updateHaConfig(token, wanted));
      },
      async check(input) {
        const wanted = cleanCheck(input);
        return server((token) => client.checkHa(token, wanted));
      },
      sensorToken: () => server((token) => client.sensorToken(token, false)),
      createSensorToken: () => server((token) => client.sensorToken(token, true)),
      deleteSensorToken: () => server((token) => client.deleteSensorToken(token)),
    },
  };
}

