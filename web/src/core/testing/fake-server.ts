/**
 * Der Stowly-Server, nachgebaut im Arbeitsspeicher (docs/sync-protokoll.md).
 *
 * Gegenstelle für die Tests des Kerns und für `npm run dev:fake`. Sie spricht das Protokoll
 * so, wie es im Dokument steht: Anmeldung und Geräte, `POST /api/sync` mit Ergebnissen je
 * Befehl, Änderungsfolge (`rev`, `cursor`, `has_more`), `reset`, Aufbewahrung im
 * vollständigen Abzug, ID-Vorrat, wirksamer Zeitpunkt.
 *
 * Die Wirkung der Befehle teilt sie mit dem Kern (src/core/commands/apply.ts). Die Prüfung
 * der Befehle ist dagegen eigens nach server/stowly/contract/commands.py geschrieben: Schickt
 * der Kern etwas, das der echte Server als `invalid` ablehnen würde, fällt es hier auf.
 *
 * WAS SIE NICHT IST: der Maßstab. Ob Kern und Server zusammenpassen, prüft `npm run test:e2e`
 * (web/e2e) gegen den echten Server. Weil sich Nachbildung und Kern `applyCommand` teilen,
 * bemerkt hier kein Test einen Lesefehler im Protokoll: Er steckte auf beiden Seiten.
 *
 * Wo die Nachbildung vom echten Server (server/stowly/sync) abweicht:
 * - Keine Uhren je Feld (7.1) und keine Uhr für Entnehmen/Wiederherstellen (7.2): Es gewinnt,
 *   was zuletzt eintrifft, nicht was zuletzt geschah. Nur die Meldungen zu Druckern und
 *   Etiketten vergleichen ihren Zeitpunkt. Konflikte zwischen Geräten lassen sich hier also
 *   nicht prüfen.
 * - Ein Schritt der Änderungsfolge je Befehl: Alles, was er anfasst, teilt sich einen `rev`.
 *   Der echte Server gibt jedem Datensatz seinen eigenen; nur Packungen, die ein Befehl
 *   gemeinsam verschiebt, teilen sich einen. Ein Befehl ohne Wirkung liefert hier nichts
 *   zurück, der echte Server liefert den Datensatz trotzdem mit (Echo).
 * - `print.request` prüft den genannten Drucker nicht; der echte Server lehnt einen Drucker,
 *   den es nie gab, mit `not_found` ab.
 * - Ein schon bekannter Befehl (`duplicate`) zählt nicht als Untergrenze der wirksamen
 *   Zeitpunkte (Abschnitt 4); es fehlt auch die Schranke für ein unmögliches Alter.
 * - Open Food Facts wird nachgespielt: gerade Endziffer des Barcodes = gefunden, nach
 *   `lookupDelayMs`. `product.add_barcode` und ein Zusammenführen setzen `lookup` nicht auf
 *   `pending`. Bilder gibt es nicht (404). Mit `lookupEnabled: false` meldet jede Antwort
 *   `lookup_enabled: false`, und neue Produkte beginnen mit `lookup: "none"`.
 * - `last_seen_at` rückt bei jedem Abgleich vor, im echten Server höchstens einmal je Minute.
 * - Es gibt kein Ereignisprotokoll und keine Grenze für die Größe einer Anfrage; die Sicherung
 *   ist keine SQLite-Datei; die Klartexte der Meldungen sind eigene, und `details.errors` ist
 *   bei 422 leer.
 * - Der Druckdienst unter `/print` ist ebenfalls nachgebaut (fake-print.ts; dort steht, was er
 *   nicht kann). Was er am Etikett und am Zustand des Druckers fortschreibt, überschreibt hier
 *   einfach; der echte Server lässt die jüngste Meldung gewinnen.
 * - Längen von Texten zählen hier in UTF-16-Einheiten, im Server in Zeichen.
 *
 * Ohne DOM und ohne Node: Die Datei läuft in den Tests (jsdom) und im Entwicklungsserver.
 */
import {
  COMMAND_TYPES,
  ID_POOL_TARGET,
  MAX_CHANGES_PER_SYNC,
  MAX_COMMANDS_PER_SYNC,
  PROTOCOL_VERSION,
  type Changes,
  type Command,
  type CommandResult,
  type Device,
  type ErrorBody,
  type ErrorCode,
  type HouseholdSettings,
  type LabelTemplate,
  type Package,
  type Product,
  type RejectCode,
  type ServerHealth,
  type SyncResponse,
  type Zone,
} from "@/contract/api.gen";
import { gtinCheckDigit, isStoreInternalBarcode, isValidBarcode } from "@/contract/barcode";
import { isPackageId, isUuid, newUuid, randomPackageId } from "@/contract/ids";
import { progressAfterOutcome } from "@/contract/labels";
import { isDate, isTimestamp } from "@/contract/time";

import { applyCommand } from "../commands/apply";
import { DAY_MS, isExpiredJob, isExpiredPackage, PRINT_JOB_RETENTION_DAYS, retentionLimit } from "../sync/retention";
import { FakePrintService } from "./fake-print";
import { Draft, EMPTY_TABLES, keyOf, TABLE_NAMES, type MutableTables, type TableName, type TableRows, type Tables } from "../tables";

export const FAKE_PASSWORD = "stowly";
export const FAKE_VERSION = "0.0.0-fake";

export interface FakeRequestData {
  method: string;
  /** Pfad ohne Abfrage, z. B. "/api/sync". */
  path: string;
  /** Die Abfrage ohne das Fragezeichen, z. B. "wait=10"; fehlt, wenn es keine gibt. */
  query?: string;
  /** Kopfzeilen mit kleingeschriebenen Namen. */
  headers: Record<string, string | undefined>;
  /** Der Rumpf als Text; leer, wenn es keinen gibt. */
  body: string;
}

export interface FakeResponseData {
  status: number;
  headers: Record<string, string>;
  /** JSON-Rumpf als Text, Binärdaten oder nichts (204). */
  body: string | Uint8Array | null;
}

export interface FakeServerOptions {
  /** Uhr des Servers. Vorgabe: die echte. */
  now?: () => Date;
  password?: string;
  /** Höchstzahl an Datensätzen je Antwort; klein gewählt lässt sich `has_more` prüfen. */
  maxChanges?: number;
  /** Mit Beispieldaten starten (für `npm run dev:fake`) statt nur mit der Zone „Vorrat". */
  sample?: boolean;
  /**
   * Nach so vielen Millisekunden gilt ein Platzhalter als nachgeschlagen (beim nächsten Abgleich).
   * null = nie. Vorgabe null.
   */
  lookupDelayMs?: number | null;
  /** false: Das Nachschlagen ist abgeschaltet (wie STOWLY_OFF_ENABLED=0). Vorgabe true. */
  lookupEnabled?: boolean;
  /**
   * Der Druckdienst unter `/print`: Mit `realWait` dauert ein Druck `printMs` und `wait` wartet
   * wirklich (für den Entwicklungsserver); sonst druckt er sofort.
   */
  print?: { realWait?: boolean; printMs?: number };
}

interface FakeDevice {
  id: string;
  name: string;
  token: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  /** Wirksamer Zeitpunkt des letzten gültigen Befehls dieses Geräts in Millisekunden; 0 = noch keiner. */
  last_command_ms: number;
}

type CommandBody = Record<string, unknown>;

// ------------------------------------------------------------------------------------------
// Prüfung der Befehle nach server/stowly/contract/commands.py: unbekannte Schlüssel, fehlende
// Pflichtfelder und falsche Formate sind `invalid`.
// ------------------------------------------------------------------------------------------

type Check = (value: unknown) => boolean;
interface Field {
  required: boolean;
  check: Check;
}

const req = (check: Check): Field => ({ required: true, check });
const opt = (check: Check): Field => ({ required: false, check });
const nullable =
  (check: Check): Check =>
  (value) =>
    value === null || check(value);
const text =
  (min: number, max: number): Check =>
  (value) =>
    typeof value === "string" && value.length >= min && value.length <= max;
const oneOf =
  (...values: string[]): Check =>
  (value) =>
    typeof value === "string" && values.includes(value);
const integer =
  (min: number, max: number): Check =>
  (value) =>
    typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const uuid: Check = (value) => typeof value === "string" && isUuid(value);
const packageId: Check = (value) => typeof value === "string" && isPackageId(value);
// Wie der Server: Form und Prüfziffer (server/stowly/sync/handlers.py, check_semantics).
const barcode: Check = (value) => typeof value === "string" && isValidBarcode(value);
const date: Check = (value) => typeof value === "string" && isDate(value);
const timestamp: Check = (value) => typeof value === "string" && isTimestamp(value);
const bool: Check = (value) => typeof value === "boolean";
const anyInt: Check = (value) => typeof value === "number" && Number.isInteger(value);
const listOf =
  (check: Check, min: number, max: number): Check =>
  (value) =>
    Array.isArray(value) && value.length >= min && value.length <= max && value.every(check);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Ein Objekt mit genau den genannten Schlüsseln. */
function object(fields: Record<string, Field>): Check {
  return (value) => {
    if (!isRecord(value)) {
      return false;
    }
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(fields, key)) {
        return false;
      }
    }
    for (const [key, field] of Object.entries(fields)) {
      if (!Object.hasOwn(value, key)) {
        if (field.required) {
          return false;
        }
        continue;
      }
      if (!field.check(value[key])) {
        return false;
      }
    }
    return true;
  };
}

const serverConfig = object({
  driver: req(oneOf("brother_ql", "image")),
  model: req(nullable(text(0, 40))),
  address: req(nullable(text(0, 200))),
  media: req(text(0, 40)),
});
const directConfig = object({
  urls: req(listOf(text(0, 200), 1, 4)),
  token: req(text(1, 200)),
  printer: req(nullable(text(0, 60))),
});
const warnDays = integer(0, 3650);
const loose: Check = (value) => value === null || isRecord(value);
const JOB_STATES = ["pending", "queued", "printing", "printed", "sent", "failed", "unknown", "cancelled"];

const COMMAND_FIELDS: Record<(typeof COMMAND_TYPES)[number], Record<string, Field>> = {
  "product.create": {
    product_id: req(uuid),
    name: opt(text(0, 120)),
    brand: opt(text(0, 80)),
    quantity: opt(text(0, 40)),
    warn_days: opt(nullable(warnDays)),
    barcodes: opt(listOf(barcode, 0, 20)),
  },
  "product.update": {
    product_id: req(uuid),
    changes: req(object({ name: opt(text(0, 120)), brand: opt(text(0, 80)), quantity: opt(text(0, 40)), warn_days: opt(nullable(warnDays)) })),
  },
  "product.add_barcode": { product_id: req(uuid), barcode: req(barcode) },
  "product.remove_barcode": { product_id: req(uuid), barcode: req(barcode) },
  "product.merge": { source_id: req(uuid), target_id: req(uuid) },
  "package.create": { package_id: req(packageId), product_id: req(uuid), zone_id: req(uuid), best_before: opt(nullable(date)) },
  "package.update": {
    package_id: req(packageId),
    changes: req(object({ best_before: opt(nullable(date)), zone_id: opt(uuid), product_id: opt(uuid) })),
  },
  "package.remove": { package_id: req(packageId), reason: req(oneOf("consumed", "discarded", "mistake")) },
  "package.restore": { package_id: req(packageId), apply_displaced: opt(bool) },
  "zone.create": {
    zone_id: req(uuid),
    name: req(text(1, 60)),
    icon: opt(text(1, 32)),
    color: opt(nullable(text(1, 16))),
    sort: opt(anyInt),
    printer_id: opt(nullable(uuid)),
  },
  "zone.update": {
    zone_id: req(uuid),
    changes: req(object({ name: opt(text(1, 60)), icon: opt(text(1, 32)), color: opt(nullable(text(1, 16))), sort: opt(anyInt), printer_id: opt(nullable(uuid)) })),
  },
  "zone.delete": { zone_id: req(uuid), move_to: req(uuid) },
  "settings.update": {
    changes: req(
      object({
        zone_mode: opt(oneOf("primary", "equal")),
        primary_zone_id: opt(nullable(uuid)),
        warn_days: opt(warnDays),
        trash_retention_days: opt(integer(1, 3650)),
        default_printer_id: opt(nullable(uuid)),
      }),
    ),
  },
  "printer.create": {
    printer_id: req(uuid),
    name: req(text(1, 60)),
    connection: req(oneOf("server", "direct")),
    server: opt(nullable(serverConfig)),
    direct: opt(nullable(directConfig)),
  },
  "printer.update": { printer_id: req(uuid), changes: req(object({ name: opt(text(1, 60)), server: opt(serverConfig), direct: opt(directConfig) })) },
  "printer.delete": { printer_id: req(uuid) },
  "printer.report": { printer_id: req(uuid), boot_id: opt(nullable(text(0, 80))), status: opt(loose), host: opt(loose) },
  "print.request": {
    job_id: req(uuid),
    kind: req(oneOf("package", "zone")),
    package_id: opt(nullable(packageId)),
    zone_id: opt(nullable(uuid)),
    printer_id: opt(nullable(uuid)),
  },
  "print.report": {
    job_id: req(uuid),
    state: req(oneOf(...JOB_STATES)),
    printer_id: opt(nullable(uuid)),
    boot_id: opt(nullable(text(0, 80))),
    error: opt(nullable(text(0, 200))),
  },
};

/** null, wenn der Befehl dem Katalog entspricht; sonst der Grund. */
export function validateCommand(command: unknown): string | null {
  if (!isRecord(command)) {
    return "Der Befehl ist kein Objekt.";
  }
  const type = command.type;
  if (typeof type !== "string" || !Object.hasOwn(COMMAND_FIELDS, type)) {
    return `Unbekannte Befehlsart: ${String(type)}`;
  }
  if (!timestamp(command.at)) {
    return "`at` ist kein gültiger Zeitstempel.";
  }
  const fields: Record<string, Field> = { id: req(uuid), at: req(timestamp), type: req(() => true), ...COMMAND_FIELDS[type as (typeof COMMAND_TYPES)[number]] };
  for (const key of Object.keys(command)) {
    if (!Object.hasOwn(fields, key)) {
      return `Unbekanntes Feld: ${key}`;
    }
  }
  for (const [key, field] of Object.entries(fields)) {
    if (!Object.hasOwn(command, key)) {
      if (field.required) {
        return `Es fehlt das Feld ${key}.`;
      }
      continue;
    }
    if (!field.check(command[key])) {
      return `Ungültiger Wert im Feld ${key}.`;
    }
  }
  if (type === "printer.create") {
    const server = command.server ?? null;
    const direct = command.direct ?? null;
    if ((command.connection === "server" && (server === null || direct !== null)) || (command.connection === "direct" && (direct === null || server !== null))) {
      return "Die Angaben passen nicht zur Art der Verbindung.";
    }
  }
  if (type === "print.request") {
    const pkg = command.package_id ?? null;
    const zone = command.zone_id ?? null;
    if ((command.kind === "package" && (pkg === null || zone !== null)) || (command.kind === "zone" && (zone === null || pkg !== null))) {
      return "Das Etikett braucht genau eine Packung oder genau eine Zone.";
    }
  }
  return null;
}

const REJECT_MESSAGES: Record<RejectCode, string> = {
  invalid: "Der Befehl ist ungültig.",
  not_found: "Der Datensatz existiert nicht.",
  id_conflict: "Die Kennung ist schon vergeben.",
  last_zone: "Die letzte Zone lässt sich nicht löschen.",
  internal: "Fehler im Server.",
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): FakeResponseData {
  return { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers }, body: JSON.stringify(body) };
}

function failure(status: number, code: ErrorCode, message: string, details: Record<string, unknown> | null = null, headers: Record<string, string> = {}): FakeResponseData {
  const body: ErrorBody = { error: { code, message, details } };
  return json(status, body, headers);
}

/** Gültige EAN-13 für Beispieldaten. */
function sampleBarcode(n: number): string {
  const body = `4000001${String(n).padStart(5, "0")}`;
  return body + String(gtinCheckDigit(body));
}

function toIsoDate(moment: Date): string {
  return moment.toISOString().slice(0, 10);
}

export class FakeServer {
  /** Kennung des Datenbestands. */
  datasetId = newUuid();
  /** Stand der Änderungsfolge. */
  rev = 0;
  /** Protokollversion, die der Server verlangt. */
  protocol: number = PROTOCOL_VERSION;
  /** false = STOWLY_PASSWORD ist nicht gesetzt. */
  configured = true;
  /** Alle Sync-Anfragen in der Reihenfolge ihres Eintreffens. */
  readonly syncRequests: Record<string, unknown>[] = [];
  /** Der Druckdienst des Servers unter `/print` (src/core/testing/fake-print.ts). */
  readonly print: FakePrintService;

  private tables: Tables = EMPTY_TABLES;
  private readonly revs = new Map<string, number>();
  private settingsRev = 0;
  private readonly results = new Map<string, CommandResult>();
  private readonly devices = new Map<string, FakeDevice>();
  private readonly reservations = new Map<string, string>();
  private readonly lookups = new Map<string, number>();
  private failedLogins: number[] = [];
  private lockedUntil = 0;

  private readonly now: () => Date;
  private readonly password: string;
  private readonly maxChanges: number;
  private readonly lookupDelayMs: number | null;
  private readonly lookupEnabled: boolean;

  constructor(options: FakeServerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.password = options.password ?? FAKE_PASSWORD;
    this.maxChanges = options.maxChanges ?? MAX_CHANGES_PER_SYNC;
    this.lookupDelayMs = options.lookupDelayMs ?? null;
    this.lookupEnabled = options.lookupEnabled ?? true;
    this.print = new FakePrintService({
      now: this.now,
      realWait: options.print?.realWait,
      printMs: options.print?.printMs,
      // Was im Server anders ist als am Pi (docs/etiketten.md, 5.8): Geräte-Token, die Drucker des
      // Datenbestands, nur bekannte Etiketten, und der Dienst schreibt ihren Zustand selbst fort.
      backend: {
        authorized: (headers) => this.deviceFor({ method: "", path: "", headers, body: "" }) !== null,
        printers: () => [...this.tables.printers.values()].filter((printer) => printer.deleted_at === null && printer.connection === "server"),
        job: (id) => this.tables.print_jobs.get(id),
        writeJob: (id, serviceState, printerId, bootId, serviceError) => {
          const job = this.tables.print_jobs.get(id);
          // Wie der echte Server: Am Dienst verworfen heißt für das Etikett „verworfen" (etiketten.md, 5.8).
          const cancelled = serviceState === "failed" && serviceError === "cancelled";
          const state = cancelled ? "cancelled" : serviceState;
          const error = cancelled ? null : serviceError;
          // Und ein Zwischenstand ändert kein Etikett mit Ausgang (Protokoll 6.6).
          if (job && !progressAfterOutcome(job.state, state)) {
            this.put("print_jobs", { ...job, state, printer_id: printerId, boot_id: bootId, error, updated_at: this.stamp() });
          }
        },
        writeStatus: (printerId, bootId, status) => {
          this.put("printer_status", { printer_id: printerId, observed_at: this.stamp(), boot_id: bootId, status, host: null });
        },
      },
    });
    this.seedDefaults();
    if (options.sample) {
      this.seedSample();
    }
  }

  // ---------------------------------------------------------------- Zugriff für Tests

  /** Der aktuelle Datenbestand des Servers. */
  get data(): Tables {
    return this.tables;
  }

  get deviceList(): FakeDevice[] {
    return [...this.devices.values()];
  }

  /** Schreibt einen Datensatz direkt, als hätte ihn ein anderes Gerät geändert. */
  put<T extends TableName>(table: T, row: TableRows[T]): void {
    const next: MutableTables = { ...this.tables };
    const map = new Map<string, unknown>(this.tables[table]);
    map.set(keyOf(table, row), row);
    (next as Record<TableName, unknown>)[table] = map;
    this.tables = next;
    this.rev += 1;
    this.revs.set(`${table}:${keyOf(table, row)}`, this.rev);
  }

  putSettings(changes: Partial<HouseholdSettings>): void {
    const current = this.tables.settings;
    if (!current) {
      return;
    }
    this.tables = { ...this.tables, settings: { ...current, ...changes, updated_at: this.stamp() } };
    this.rev += 1;
    this.settingsRev = this.rev;
  }

  /** Führt Befehle aus, als kämen sie von einem anderen Gerät. Kennung und Zeitpunkt werden ergänzt. */
  act(...commands: Record<string, unknown>[]): CommandResult[] {
    const at = this.stamp();
    return commands.map((command) => this.execute({ id: newUuid(), at, ...command }, null, at));
  }

  /**
   * Ersetzt den ganzen Bestand durch eigene Daten (die Etikett-Vorlagen bleiben).
   * Jeder Datensatz bekommt einen neuen Stand der Änderungsfolge.
   */
  load(data: { [T in TableName]?: readonly TableRows[T][] } & { settings?: HouseholdSettings }): void {
    const templates = [...this.tables.label_templates.values()];
    this.tables = { ...EMPTY_TABLES, settings: this.tables.settings };
    this.revs.clear();
    for (const table of TABLE_NAMES) {
      const rows = table === "label_templates" ? (data.label_templates ?? templates) : (data[table] ?? []);
      for (const row of rows as readonly TableRows[TableName][]) {
        this.put(table, row as never);
      }
    }
    if (data.settings) {
      this.tables = { ...this.tables, settings: data.settings };
      this.rev += 1;
      this.settingsRev = this.rev;
    }
  }

  /** Sperrt alle Tokens (oder das eines Geräts). */
  revoke(deviceId?: string): void {
    for (const device of this.devices.values()) {
      if (deviceId === undefined || device.id === deviceId) {
        device.revoked_at ??= this.stamp();
      }
    }
  }

  /** Neuer Datenbestand, wie nach dem Einspielen einer Sicherung: Alle Geräte bekommen `reset`. */
  newDataset(): void {
    this.datasetId = newUuid();
  }

  /** Gilt die Reservierung einer ID noch? */
  isReserved(id: string): boolean {
    return this.reservations.has(id);
  }

  /** Alle reservierten, noch unbenutzten Packungs-IDs. */
  get reservedIds(): string[] {
    return [...this.reservations.keys()];
  }

  /** Entfernt einen Datensatz spurlos, wie es nur das Einspielen einer älteren Sicherung kann. */
  forget(table: TableName, id: string): void {
    const map = new Map<string, unknown>(this.tables[table]);
    map.delete(id);
    this.tables = { ...this.tables, [table]: map } as Tables;
    this.revs.delete(`${table}:${id}`);
  }

  // ---------------------------------------------------------------- Anfangsbestand

  private stamp(): string {
    return this.now().toISOString();
  }

  /** Wie `db.seed_defaults` im Server: die Zone „Vorrat", die Einstellungen, die Vorlagen. */
  private seedDefaults(): void {
    const at = this.stamp();
    const zone: Zone = { id: newUuid(), name: "Vorrat", icon: "box", color: null, sort: 0, printer_id: null, created_at: at, updated_at: at, deleted_at: null, moved_to: null };
    this.put("zones", zone);
    this.tables = {
      ...this.tables,
      settings: { zone_mode: "primary", primary_zone_id: zone.id, warn_days: 14, trash_retention_days: 30, default_printer_id: null, updated_at: at },
    };
    this.rev += 1;
    this.settingsRev = this.rev;
    const templates: LabelTemplate[] = [
      { key: "package", hash: "0000000000000001", body: { schema: 1, name: "package-62x29", elements: [] }, updated_at: at },
      { key: "zone", hash: "0000000000000002", body: { schema: 1, name: "zone-62x29", elements: [] }, updated_at: at },
    ];
    for (const template of templates) {
      this.put("label_templates", template);
    }
  }

  /** Ein kleiner, erfundener Haushalt zum Ausprobieren im Browser. */
  private seedSample(): void {
    const first = [...this.tables.zones.values()][0];
    if (!first) {
      return;
    }
    const today = this.now();
    const inDays = (days: number) => toIsoDate(new Date(today.getTime() + days * DAY_MS));
    const cellar = newUuid();
    const freezer = newUuid();
    const printer = newUuid();
    const rice = newUuid();
    const pasta = newUuid();
    const peas = newUuid();
    this.act(
      { type: "zone.update", zone_id: first.id, changes: { name: "Vorratsregal", icon: "shelf" } },
      { type: "zone.create", zone_id: cellar, name: "Keller", icon: "cellar", color: "blue", sort: 1 },
      { type: "zone.create", zone_id: freezer, name: "Gefrierschrank", icon: "freezer", color: "slate", sort: 2 },
      { type: "printer.create", printer_id: printer, name: "Küche (Bild)", connection: "server", server: { driver: "image", model: null, address: null, media: "62" } },
      { type: "settings.update", changes: { default_printer_id: printer } },
      { type: "product.create", product_id: rice, name: "Basmati Reis", brand: "Kornhaus", quantity: "1 kg", barcodes: [sampleBarcode(1)] },
      { type: "product.create", product_id: pasta, name: "Spaghetti", brand: "Pastaria", quantity: "500 g", barcodes: [sampleBarcode(2)] },
      { type: "product.create", product_id: peas, name: "Erbsen (TK)", brand: "Frostgarten", quantity: "750 g", barcodes: [sampleBarcode(3)] },
    );
    const stock: [string, string, string | null][] = [
      [rice, cellar, inDays(132)],
      [rice, cellar, inDays(132)],
      [rice, first.id, inDays(400)],
      [pasta, first.id, inDays(9)],
      [pasta, cellar, inDays(300)],
      [peas, freezer, inDays(200)],
      [peas, freezer, null],
    ];
    for (const [productId, zoneId, bestBefore] of stock) {
      this.act({ type: "package.create", package_id: this.freeId(), product_id: productId, zone_id: zoneId, best_before: bestBefore });
    }
    // Die Beispiele sind sofort „nachgeschlagen".
    for (const product of this.tables.products.values()) {
      this.put("products", { ...product, lookup: "found" });
    }
    this.lookups.clear();
  }

  // ---------------------------------------------------------------- Befehle

  private freeId(): string {
    for (;;) {
      const id = randomPackageId();
      if (!this.tables.packages.has(id) && !this.reservations.has(id)) {
        return id;
      }
    }
  }

  /** Verarbeitet einen Befehl höchstens einmal (6.3). */
  private execute(command: unknown, device: FakeDevice | null, effectiveAt: string): CommandResult {
    const id = (command as CommandBody).id as string;
    const known = this.results.get(id);
    if (known) {
      return { ...known, duplicate: true };
    }
    let result: CommandResult;
    const problem = validateCommand(command);
    if (problem !== null) {
      result = { id, status: "rejected", code: "invalid", message: problem, duplicate: false };
    } else {
      const draft = new Draft(this.tables);
      let outcome: ReturnType<typeof applyCommand>;
      try {
        outcome = applyCommand(draft, command as Command, {
          at: effectiveAt,
          device_id: device?.id ?? null,
          authoritative: true,
          lookup_enabled: this.lookupEnabled,
        });
      } catch {
        outcome = { status: "rejected", code: "internal" };
      }
      if (outcome.status === "rejected") {
        result = { id, status: "rejected", code: outcome.code, message: REJECT_MESSAGES[outcome.code], duplicate: false };
      } else {
        this.commit(draft, command as Command);
        result = { id, status: outcome.status, code: null, message: null, duplicate: false };
      }
    }
    this.results.set(id, result);
    return result;
  }

  private commit(draft: Draft, command: Command): void {
    this.tables = draft.commit();
    // Ein Befehl ist ein Schritt der Änderungsfolge: Alles, was er anfasst, trägt denselben Stand.
    this.rev += 1;
    for (const [table, id] of draft.touched()) {
      this.revs.set(`${table}:${id}`, this.rev);
    }
    if (draft.touchedSettings) {
      this.settingsRev = this.rev;
    }
    if (command.type === "package.create") {
      // Wer eine freie ID zuerst anlegt, bekommt sie; die Reservierung verfällt (Abschnitt 8).
      this.reservations.delete(command.package_id);
    }
    if (command.type === "product.create") {
      const product = this.tables.products.get(command.product_id);
      if (product?.lookup === "pending") {
        this.lookups.set(product.id, this.now().getTime());
      }
    }
  }

  /** Spielt Open Food Facts nach: Platzhalter, die lange genug warten, bekommen ein Ergebnis. */
  private resolveLookups(): void {
    if (this.lookupDelayMs === null) {
      return;
    }
    const nowMs = this.now().getTime();
    for (const [productId, since] of [...this.lookups]) {
      if (nowMs - since < this.lookupDelayMs) {
        continue;
      }
      this.lookups.delete(productId);
      const product = this.tables.products.get(productId);
      if (!product || product.lookup !== "pending") {
        continue;
      }
      const code = product.barcodes.find((candidate) => !isStoreInternalBarcode(candidate)) ?? "";
      const found = Number(code.at(-1)) % 2 === 0;
      // Die Daten füllen nur leere Felder (Abschnitt 10).
      const filled: Product = found
        ? {
            ...product,
            lookup: "found",
            name: product.name === "" ? `Beispielprodukt ${code.slice(-4)}` : product.name,
            brand: product.brand === "" ? "Beispielmarke" : product.brand,
            quantity: product.quantity === "" ? "500 g" : product.quantity,
          }
        : { ...product, lookup: "not_found" };
      this.put("products", filled);
    }
  }

  // ---------------------------------------------------------------- Sync

  private sync(device: FakeDevice, body: unknown): FakeResponseData {
    if (!isRecord(body)) {
      return failure(422, "invalid_request", "Die Anfrage ist kein JSON-Objekt.");
    }
    this.syncRequests.push(body);
    // Reihenfolge der Prüfungen wie im Server (6.2): Protokollversion (409, nur wenn sie eine
    // Zahl ist), Zahl der Befehle (413), dann der Rahmen (422, auch bei fehlendem `protocol`).
    if (anyInt(body.protocol) && body.protocol !== this.protocol) {
      return failure(409, "protocol_mismatch", "App und Server sprechen verschiedene Protokollversionen.", { server: this.protocol, client: body.protocol });
    }
    if (Array.isArray(body.commands) && body.commands.length > MAX_COMMANDS_PER_SYNC) {
      return failure(413, "payload_too_large", "Zu viele Befehle in einem Aufruf.");
    }
    const frame = object({
      protocol: req(anyInt),
      dataset_id: req(nullable(uuid)),
      cursor: req(integer(0, Number.MAX_SAFE_INTEGER)),
      sent_at: req(timestamp),
      commands: req((value) => Array.isArray(value) && value.every((command) => isRecord(command) && uuid(command.id))),
      id_pool: req(object({ have: req(integer(0, Number.MAX_SAFE_INTEGER)) })),
      app_version: opt(nullable(text(0, 40))),
    });
    if (!frame(body)) {
      return failure(422, "invalid_request", "Die Anfrage verletzt den Vertrag.", { errors: [] });
    }
    const commands = body.commands as CommandBody[];

    // Ob das Gerät einen vollständigen Abzug braucht, entscheidet der Stand vor seinen Befehlen (6.4).
    const cursor = body.cursor as number;
    const reset = body.dataset_id !== this.datasetId || cursor > this.rev;

    // Befehle einzeln, in Reihenfolge. Die wirksamen Zeitpunkte eines Geräts laufen nie rückwärts,
    // auch nicht über Anfragen hinweg (Abschnitt 4); Befehle, die an der Form scheitern, zählen nicht.
    const received = this.now().getTime();
    const sentAt = Date.parse(body.sent_at as string);
    let floor = Math.min(device.last_command_ms, received);
    const results = commands.map((command) => {
      const at = typeof command.at === "string" ? Date.parse(command.at) : Number.NaN;
      const age = Number.isFinite(at) ? Math.max(0, sentAt - at) : 0;
      const effective = Math.max(received - age, floor);
      const result = this.execute(command, device, new Date(effective).toISOString());
      if (!result.duplicate && result.code !== "invalid") {
        floor = effective;
      }
      return result;
    });
    device.last_command_ms = floor;

    this.resolveLookups();

    const page = this.collect(reset ? 0 : cursor, reset);

    // ID-Vorrat auffüllen (Abschnitt 8); bei `reset` verwirft die App ihren Vorrat: dann ein voller.
    const have = (body.id_pool as { have: number }).have;
    const grant: string[] = [];
    for (let missing = reset ? ID_POOL_TARGET : Math.max(0, ID_POOL_TARGET - have); missing > 0; missing -= 1) {
      const id = this.freeId();
      this.reservations.set(id, device.id);
      grant.push(id);
    }

    device.last_seen_at = this.stamp();
    const response: SyncResponse = {
      protocol: this.protocol,
      dataset_id: this.datasetId,
      server_time: this.stamp(),
      results,
      reset,
      changes: page.changes,
      cursor: page.cursor,
      has_more: page.has_more,
      id_pool: { grant, target: ID_POOL_TARGET },
      lookup_enabled: this.lookupEnabled,
    };
    return json(200, response);
  }

  /**
   * Alles mit `rev > from`, höchstens `maxChanges` Datensätze, nie mitten in einem `rev` geteilt.
   * Nur ein vollständiger Abzug (`full`) lässt weg, was jenseits der Aufbewahrung liegt (6.4).
   */
  private collect(from: number, full: boolean): { changes: Changes; cursor: number; has_more: boolean } {
    const nowMs = this.now().getTime();
    const packageLimit = retentionLimit(nowMs, this.tables.settings?.trash_retention_days ?? 30);
    const jobLimit = retentionLimit(nowMs, PRINT_JOB_RETENTION_DAYS);
    const pending: { rev: number; table: TableName | "settings"; row: unknown }[] = [];
    for (const table of TABLE_NAMES) {
      for (const [id, row] of this.tables[table] as ReadonlyMap<string, unknown>) {
        const rev = this.revs.get(`${table}:${id}`) ?? 0;
        if (rev <= from) {
          continue;
        }
        if (full && table === "packages" && isExpiredPackage(row as Package, packageLimit)) {
          continue;
        }
        if (full && table === "print_jobs" && isExpiredJob(row as TableRows["print_jobs"], jobLimit)) {
          continue;
        }
        pending.push({ rev, table, row });
      }
    }
    if (this.tables.settings && this.settingsRev > from) {
      pending.push({ rev: this.settingsRev, table: "settings", row: this.tables.settings });
    }
    pending.sort((a, b) => a.rev - b.rev);

    let count = 0;
    while (count < pending.length && (count < this.maxChanges || pending[count]?.rev === pending[count - 1]?.rev)) {
      count += 1;
    }
    const included = pending.slice(0, count);
    const hasMore = count < pending.length;
    const changes: Changes = { products: [], zones: [], packages: [], printers: [], printer_status: [], print_jobs: [], label_templates: [], settings: null };
    for (const entry of included) {
      if (entry.table === "settings") {
        changes.settings = entry.row as HouseholdSettings;
      } else {
        (changes[entry.table] as unknown[]).push(entry.row);
      }
    }
    return { changes, cursor: hasMore ? (included.at(-1)?.rev ?? from) : this.rev, has_more: hasMore };
  }

  // ---------------------------------------------------------------- Anmeldung und Geräte

  private deviceFor(request: FakeRequestData): FakeDevice | null {
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    for (const device of this.devices.values()) {
      if (token !== "" && device.token === token && device.revoked_at === null) {
        return device;
      }
    }
    return null;
  }

  private describe(device: FakeDevice, current: FakeDevice | null): Device {
    return {
      id: device.id,
      name: device.name,
      created_at: device.created_at,
      last_seen_at: device.last_seen_at,
      revoked_at: device.revoked_at,
      current: device.id === current?.id,
    };
  }

  private login(body: unknown): FakeResponseData {
    if (!this.configured) {
      return failure(503, "not_configured", "Auf dem Server ist kein Passwort gesetzt.");
    }
    const nowMs = this.now().getTime();
    if (nowMs < this.lockedUntil) {
      const wait = Math.ceil((this.lockedUntil - nowMs) / 1000);
      return failure(429, "rate_limited", "Zu viele Fehlversuche.", { retry_after_s: wait }, { "retry-after": String(wait) });
    }
    if (!object({ password: req(text(1, 200)), device_name: req(text(1, 60)) })(body)) {
      return failure(422, "invalid_request", "Die Anfrage verletzt den Vertrag.", { errors: [] });
    }
    const { password, device_name: name } = body as { password: string; device_name: string };
    if (password !== this.password) {
      // Nach 5 Fehlversuchen in 5 Minuten: 60 Sekunden Sperre für alle.
      this.failedLogins = [...this.failedLogins.filter((at) => nowMs - at < 300_000), nowMs];
      if (this.failedLogins.length >= 5) {
        this.failedLogins = [];
        this.lockedUntil = nowMs + 60_000;
      }
      return failure(401, "invalid_password", "Das Passwort stimmt nicht.");
    }
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const device: FakeDevice = { id: newUuid(), name, token, created_at: this.stamp(), last_seen_at: null, revoked_at: null, last_command_ms: 0 };
    this.devices.set(device.id, device);
    return json(200, { token, device: this.describe(device, device) });
  }

  // ---------------------------------------------------------------- Die Schnittstelle

  /**
   * Beantwortet jeden Aufruf: was unter `/print` liegt, der Druckdienst (er kann warten, deshalb
   * ein Promise), alles andere `handle`.
   */
  respond(request: FakeRequestData): Promise<FakeResponseData> {
    if (request.path.startsWith("/print/")) {
      return this.print.handle({ ...request, path: request.path.slice("/print".length) });
    }
    return Promise.resolve(this.handle(request));
  }

  /** Beantwortet einen Aufruf unter /api. */
  handle(request: FakeRequestData): FakeResponseData {
    const { method, path } = request;
    let body: unknown;
    if (request.body !== "") {
      try {
        body = JSON.parse(request.body);
      } catch {
        return failure(422, "invalid_request", "Der Rumpf ist kein JSON.");
      }
    }

    if (method === "GET" && path === "/api/health") {
      const health: ServerHealth = { app: "stowly", status: "ok", version: FAKE_VERSION, protocol: this.protocol, time: this.stamp(), configured: this.configured };
      return json(200, health);
    }
    if (method === "POST" && path === "/api/auth/login") {
      return this.login(body);
    }
    if (method === "GET" && path.startsWith("/api/images/")) {
      return failure(404, "not_found", "Das Bild gibt es nicht.");
    }
    if (!path.startsWith("/api/")) {
      return failure(501, "not_implemented", "Die nachgebaute Schnittstelle kennt keinen Druckdienst.");
    }

    const device = this.deviceFor(request);
    if (!device) {
      return failure(401, "unauthorized", "Das Gerät ist nicht angemeldet.");
    }
    if (method === "POST" && path === "/api/auth/logout") {
      device.revoked_at = this.stamp();
      return { status: 204, headers: {}, body: null };
    }
    if (method === "POST" && path === "/api/sync") {
      return this.sync(device, body);
    }
    if (method === "GET" && path === "/api/devices") {
      return json(200, { devices: [...this.devices.values()].map((candidate) => this.describe(candidate, device)) });
    }
    const deviceMatch = /^\/api\/devices\/([^/]+)$/.exec(path);
    if (deviceMatch) {
      const target = this.devices.get(decodeURIComponent(deviceMatch[1] ?? ""));
      if (!target) {
        return failure(404, "not_found", "Das Gerät gibt es nicht.");
      }
      if (method === "PATCH") {
        if (!object({ name: req(text(1, 60)) })(body)) {
          return failure(422, "invalid_request", "Die Anfrage verletzt den Vertrag.", { errors: [] });
        }
        target.name = (body as { name: string }).name;
        return json(200, this.describe(target, device));
      }
      if (method === "DELETE") {
        target.revoked_at ??= this.stamp();
        return { status: 204, headers: {}, body: null };
      }
    }
    if (method === "GET" && path === "/api/backup") {
      const header = new TextEncoder().encode("SQLite format 3\u0000 (Nachbildung, keine echte Datenbank)\n");
      return {
        status: 200,
        headers: { "content-type": "application/vnd.sqlite3", "content-disposition": `attachment; filename="stowly-${toIsoDate(this.now())}.sqlite3"` },
        body: header,
      };
    }
    return failure(501, "not_implemented", "Die nachgebaute Schnittstelle kennt diesen Aufruf nicht.");
  }
}
