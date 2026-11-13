// GENERIERT. Nicht von Hand ändern.
//
// Quelle sind die Modelle in server/stowly/contract und print/stowly_print/model.py.
// Neu erzeugen: python -m stowly.contract.export
// Der Test server/tests/test_contract.py schlägt fehl, wenn diese Datei veraltet ist.

/* eslint-disable */

/** Protokollversion des Sync. */
export const PROTOCOL_VERSION = 1;
/** Sollgröße des ID-Vorrats je Gerät. */
export const ID_POOL_TARGET = 300;
/** Höchstzahl an Befehlen je Sync-Aufruf. */
export const MAX_COMMANDS_PER_SYNC = 500;
/** Höchstzahl an Datensätzen je Sync-Antwort. */
export const MAX_CHANGES_PER_SYNC = 5000;
/** Zeichen einer Packungs-ID (kein I, L, O, U). */
export const PACKAGE_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** Länge einer Packungs-ID. */
export const PACKAGE_ID_LENGTH = 5;
/** Beginn des QR-Inhalts eines Packungs-Etiketts. */
export const QR_PACKAGE_PREFIX = "STOWLY/P/";
/** Beginn des QR-Inhalts eines Zonen-Etiketts. */
export const QR_ZONE_PREFIX = "STOWLY/Z/";
/**
 * Eingabegrenzen des Vertrags: Zeichen bei Texten, Anzahl bei Listen, Tage bei Fristen.
 * Kern und Attrappe prüfen damit, bevor ein Befehl entsteht (src/contract/input.ts).
 */
export const LIMITS = {
  product_name: 120,
  brand: 80,
  quantity: 40,
  zone_name: 60,
  icon: 32,
  color: 16,
  printer_name: 60,
  device_name: 60,
  password: 200,
  barcodes: 20,
  warn_days: 3650,
  retention_days: 3650,
  printer_model: 40,
  printer_address: 200,
  printer_media: 40,
  printer_urls: 4,
  printer_url: 200,
  printer_token: 200,
  printer_queue: 60,
} as const;
/** Fehlercodes der HTTP-Antworten des Druckdienstes (docs/etiketten.md, 5.3). */
export const SERVICE_ERROR_CODES = [
  "invalid_request",
  "unauthorized",
  "not_found",
  "unknown_printer",
  "job_conflict",
  "boot_mismatch",
  "not_cancellable",
  "not_pending",
  "render_failed",
  "queue_full",
] as const;
export type ServiceErrorCode = (typeof SERVICE_ERROR_CODES)[number];
/** Codes in `DriverStatus.errors` und als Fehler eines gescheiterten Auftrags (docs/etiketten.md, 5.5). */
export const PRINTER_ERROR_CODES = [
  "no_media",
  "media_mismatch",
  "cover_open",
  "cutter_jam",
  "overheated",
  "busy",
  "offline",
  "config",
  "unknown",
] as const;
export type PrinterErrorCode = (typeof PRINTER_ERROR_CODES)[number];
/** Alle Befehlsarten des Sync. */
export const COMMAND_TYPES = [
  "product.create",
  "product.update",
  "product.add_barcode",
  "product.remove_barcode",
  "product.merge",
  "package.create",
  "package.update",
  "package.remove",
  "package.restore",
  "zone.create",
  "zone.update",
  "zone.delete",
  "settings.update",
  "printer.create",
  "printer.update",
  "printer.delete",
  "printer.report",
  "print.request",
  "print.report",
] as const;

/** Alle Endpunkte des Servers. Platzhalter wie {device_id} ersetzt der Aufrufer. */
export const ENDPOINTS = {
  download_backup: { method: "GET", path: "/api/backup" },
  get_image: { method: "GET", path: "/api/images/{image_id}" },
  health: { method: "GET", path: "/api/health" },
  list_devices: { method: "GET", path: "/api/devices" },
  list_events: { method: "GET", path: "/api/events" },
  login: { method: "POST", path: "/api/auth/login" },
  logout: { method: "POST", path: "/api/auth/logout" },
  revoke_device: { method: "DELETE", path: "/api/devices/{device_id}" },
  sync: { method: "POST", path: "/api/sync" },
  update_device: { method: "PATCH", path: "/api/devices/{device_id}" },
} as const;

/** Alle seit `cursor` geänderten Datensätze, jeweils vollständig. */
export interface Changes {
  products: Product[];
  zones: Zone[];
  packages: Package[];
  printers: Printer[];
  printer_status: PrinterStatus[];
  print_jobs: PrintJob[];
  label_templates: LabelTemplate[];
  /** null = unverändert. */
  settings: HouseholdSettings | null;
}

export interface CmdPackageCreate {
  /** Kennung des Befehls (UUID v4, vom Gerät erzeugt). Der Server führt sie höchstens einmal aus. */
  id: string;
  /** Wann der Anwender die Änderung gemacht hat (Geräteuhr, UTC). */
  at: string;
  type: "package.create";
  package_id: string;
  product_id: string;
  zone_id: string;
  best_before?: string | null;
}

export interface CmdPackageRemove {
  /** Kennung des Befehls (UUID v4, vom Gerät erzeugt). Der Server führt sie höchstens einmal aus. */
  id: string;
  /** Wann der Anwender die Änderung gemacht hat (Geräteuhr, UTC). */
  at: string;
  type: "package.remove";
  package_id: string;
  reason: RemovalReason;
}

export interface CmdPackageRestore {
  /** Kennung des Befehls (UUID v4, vom Gerät erzeugt). Der Server führt sie höchstens einmal aus. */
  id: string;
  /** Wann der Anwender die Änderung gemacht hat (Geräteuhr, UTC). */
  at: string;
  type: "package.restore";
  package_id: string;
  /** Die verdrängte Bearbeitung beim Wiederherstellen übernehmen. */
  apply_displaced?: boolean;
}

export interface CmdPackageUpdate {
  /** Kennung des Befehls (UUID v4, vom Gerät erzeugt). Der Server führt sie höchstens einmal aus. */
  id: string;
  /** Wann der Anwender die Änderung gemacht hat (Geräteuhr, UTC). */
  at: string;
  type: "package.update";
  package_id: string;
  changes: PackageChanges;
}

/** Meldet den Fortschritt eines Etiketts, auch Abbruch und die Antwort des Anwenders bei `unknown`. */
export interface CmdPrintReport {
  /** Kennung des Befehls (UUID v4, vom Gerät erzeugt). Der Server führt sie höchstens einmal aus. */
  id: string;
  /** Wann der Anwender die Änderung gemacht hat (Geräteuhr, UTC). */
  at: string;
  type: "print.report";
  job_id: string;
  state: PrintJobState;
  printer_id?: string | null;
  boot_id?: string | null;
  error?: string | null;
}

/** Legt ein Etikett im Zustand `pending` an. */
export interface CmdPrintRequest {
  /** Kennung des Befehls (UUID v4, vom Gerät erzeugt). Der Server führt sie höchstens einmal aus. */
  id: string;
  /** Wann der Anwender die Änderung gemacht hat (Geräteuhr, UTC). */
  at: string;
  type: "print.request";
  job_id: string;
  kind: PrintJobKind;
  package_id?: string | null;
  zone_id?: string | null;
  printer_id?: string | null;
}

export interface CmdPrinterCreate {
  /** Kennung des Befehls (UUID v4, vom Gerät erzeugt). Der Server führt sie höchstens einmal aus. */
  id: string;
  /** Wann der Anwender die Änderung gemacht hat (Geräteuhr, UTC). */
  at: string;
  type: "printer.create";
  printer_id: string;
  name: string;
  connection: PrinterConnection;
  server?: ServerPrinterConfig | null;
  direct?: DirectPrinterConfig | null;
}

export interface CmdPrinterDelete {
  /** Kennung des Befehls (UUID v4, vom Gerät erzeugt). Der Server führt sie höchstens einmal aus. */
  id: string;
  /** Wann der Anwender die Änderung gemacht hat (Geräteuhr, UTC). */
  at: string;
  type: "printer.delete";
  printer_id: string;
}

/** Ein Gerät hat einen Druckdienst erreicht und bringt dessen Zustand mit. `at` ist der Zeitpunkt der Beobachtung. */
export interface CmdPrinterReport {
  /** Kennung des Befehls (UUID v4, vom Gerät erzeugt). Der Server führt sie höchstens einmal aus. */
  id: string;
  /** Wann der Anwender die Änderung gemacht hat (Geräteuhr, UTC). */
  at: string;
  type: "printer.report";
  printer_id: string;
  boot_id?: string | null;
  status?: DriverStatus | null;
  host?: HostHealth | null;
}

export interface CmdPrinterUpdate {
  /** Kennung des Befehls (UUID v4, vom Gerät erzeugt). Der Server führt sie höchstens einmal aus. */
  id: string;
  /** Wann der Anwender die Änderung gemacht hat (Geräteuhr, UTC). */
  at: string;
  type: "printer.update";
  printer_id: string;
  changes: PrinterChanges;
}

export interface CmdProductAddBarcode {
  /** Kennung des Befehls (UUID v4, vom Gerät erzeugt). Der Server führt sie höchstens einmal aus. */
  id: string;
  /** Wann der Anwender die Änderung gemacht hat (Geräteuhr, UTC). */
  at: string;
  type: "product.add_barcode";
  product_id: string;
  barcode: string;
}

export interface CmdProductCreate {
  /** Kennung des Befehls (UUID v4, vom Gerät erzeugt). Der Server führt sie höchstens einmal aus. */
  id: string;
  /** Wann der Anwender die Änderung gemacht hat (Geräteuhr, UTC). */
  at: string;
  type: "product.create";
  product_id: string;
  name?: string;
  brand?: string;
  quantity?: string;
  warn_days?: number | null;
  barcodes?: string[];
}

export interface CmdProductMerge {
  /** Kennung des Befehls (UUID v4, vom Gerät erzeugt). Der Server führt sie höchstens einmal aus. */
  id: string;
  /** Wann der Anwender die Änderung gemacht hat (Geräteuhr, UTC). */
  at: string;
  type: "product.merge";
  /** Dieses Produkt geht im Ziel auf. */
  source_id: string;
  target_id: string;
}

export interface CmdProductRemoveBarcode {
  /** Kennung des Befehls (UUID v4, vom Gerät erzeugt). Der Server führt sie höchstens einmal aus. */
  id: string;
  /** Wann der Anwender die Änderung gemacht hat (Geräteuhr, UTC). */
  at: string;
  type: "product.remove_barcode";
  product_id: string;
  barcode: string;
}

export interface CmdProductUpdate {
  /** Kennung des Befehls (UUID v4, vom Gerät erzeugt). Der Server führt sie höchstens einmal aus. */
  id: string;
  /** Wann der Anwender die Änderung gemacht hat (Geräteuhr, UTC). */
  at: string;
  type: "product.update";
  product_id: string;
  changes: ProductChanges;
}

export interface CmdSettingsUpdate {
  /** Kennung des Befehls (UUID v4, vom Gerät erzeugt). Der Server führt sie höchstens einmal aus. */
  id: string;
  /** Wann der Anwender die Änderung gemacht hat (Geräteuhr, UTC). */
  at: string;
  type: "settings.update";
  changes: SettingsChanges;
}

export interface CmdZoneCreate {
  /** Kennung des Befehls (UUID v4, vom Gerät erzeugt). Der Server führt sie höchstens einmal aus. */
  id: string;
  /** Wann der Anwender die Änderung gemacht hat (Geräteuhr, UTC). */
  at: string;
  type: "zone.create";
  zone_id: string;
  name: string;
  icon?: string;
  color?: string | null;
  sort?: number;
  printer_id?: string | null;
}

export interface CmdZoneDelete {
  /** Kennung des Befehls (UUID v4, vom Gerät erzeugt). Der Server führt sie höchstens einmal aus. */
  id: string;
  /** Wann der Anwender die Änderung gemacht hat (Geräteuhr, UTC). */
  at: string;
  type: "zone.delete";
  zone_id: string;
  /** Zone, in die alle Packungen der gelöschten Zone wandern. */
  move_to: string;
}

export interface CmdZoneUpdate {
  /** Kennung des Befehls (UUID v4, vom Gerät erzeugt). Der Server führt sie höchstens einmal aus. */
  id: string;
  /** Wann der Anwender die Änderung gemacht hat (Geräteuhr, UTC). */
  at: string;
  type: "zone.update";
  zone_id: string;
  changes: ZoneChanges;
}

export type Command =
  | CmdProductCreate
  | CmdProductUpdate
  | CmdProductAddBarcode
  | CmdProductRemoveBarcode
  | CmdProductMerge
  | CmdPackageCreate
  | CmdPackageUpdate
  | CmdPackageRemove
  | CmdPackageRestore
  | CmdZoneCreate
  | CmdZoneUpdate
  | CmdZoneDelete
  | CmdSettingsUpdate
  | CmdPrinterCreate
  | CmdPrinterUpdate
  | CmdPrinterDelete
  | CmdPrinterReport
  | CmdPrintRequest
  | CmdPrintReport;

export interface CommandResult {
  id: string;
  status: CommandStatus;
  /** Nur bei rejected. */
  code: RejectCode | null;
  /** Deutscher Klartext zum code, als Rückfall anzeigbar. */
  message: string | null;
  /** Der Befehl war schon bekannt; status ist das Ergebnis von damals. */
  duplicate: boolean;
}

export type CommandStatus = "applied" | "displaced" | "rejected";

export interface Device {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  /** true = das Gerät, das gerade fragt. */
  current: boolean;
}

export interface DeviceList {
  devices: Device[];
}

export interface DeviceUpdate {
  name: string;
}

/** Druckdienst, den das Gerät selbst anspricht (Raspberry Pi im Keller). */
export interface DirectPrinterConfig {
  /** Basis-Adressen in der Reihenfolge der Versuche, z. B. https://10.71.83.1:8443, dann http://10.71.83.1:8080. */
  urls: string[];
  /** Bearer-Token des Druckdienstes. */
  token: string;
  /** Name des Druckers im Druckdienst; null = dessen Standarddrucker. */
  printer: string | null;
}

export interface DisplacedChange {
  field: PackageField;
  value: string | null;
}

/** Eine Bearbeitung, die auf eine bereits entnommene Packung traf (Löschen gewinnt). */
export interface DisplacedEdit {
  /** Wann die Bearbeitung gemacht wurde. */
  at: string;
  /** Die nicht angewendeten Feldwerte. */
  changes: DisplacedChange[];
}

/** Momentaufnahme eines Druckers. `None` heißt: lässt sich nicht feststellen. */
export interface DriverStatus {
  reachable: boolean;
  ready: boolean | null;
  media_detected: boolean | null;
  errors: string[];
}

/** Rumpf jeder Fehlerantwort der Schnittstelle. */
export interface ErrorBody {
  error: ErrorInfo;
}

/** Fehlercodes der HTTP-Schnittstelle (docs/sync-protokoll.md, „Fehlerformat"). */
export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "invalid_password"
  | "rate_limited"
  | "not_configured"
  | "not_found"
  | "conflict"
  | "protocol_mismatch"
  | "payload_too_large"
  | "not_implemented"
  | "internal";

export interface ErrorInfo {
  code: ErrorCode;
  /** Deutscher Klartext, als Rückfall anzeigbar. */
  message: string;
  details: { [key: string]: unknown } | null;
}

export interface EventPage {
  /** Neueste zuerst. */
  events: EventRecord[];
  /** Als ?before= mitsenden, um weiterzublättern; null = Ende. */
  next_before: number | null;
}

/** Ein Eintrag des Ereignisprotokolls. */
export interface EventRecord {
  id: number;
  /** Wann es geschah (Serverzeit, aus dem Befehl berechnet). */
  at: string;
  /** Wann der Server es verbucht hat. */
  recorded_at: string;
  device_id: string | null;
  command_id: string | null;
  type: string;
  entity: string;
  entity_id: string;
  data: { [key: string]: unknown };
}

/**
 * Zustand des Rechners, auf dem der Druckdienst läuft. `None` = unbekannt.
 *
 * `undervoltage` ist auf der Pi-Zero-Reihe immer `None`: Sie hat keinen Detektor.
 * Für die SD-Karte gibt es nur Symptome (docs/recherche.md, Abschnitt 6).
 */
export interface HostHealth {
  uptime_s?: number | null;
  temperature_c?: number | null;
  throttled?: boolean | null;
  undervoltage?: boolean | null;
  storage_errors?: number | null;
  storage_read_only?: boolean | null;
  overlay_used_pct?: number | null;
  memory_available_mb?: number | null;
}

/** Einstellungen des Haushalts; gelten für alle Geräte. */
export interface HouseholdSettings {
  zone_mode: ZoneMode;
  /** Primärzone; null = erste Zone der Reihenfolge. */
  primary_zone_id: string | null;
  /** Vorlaufzeit der MHD-Warnung in Tagen. */
  warn_days: number;
  /** Aufbewahrungsdauer der Lösch-Historie in Tagen. */
  trash_retention_days: number;
  /** Drucker für Zonen ohne eigenen Drucker. */
  default_printer_id: string | null;
  updated_at: string;
}

export interface IdPoolGrant {
  /** Neu für dieses Gerät reservierte Packungs-IDs. */
  grant: string[];
  /** Sollgröße des Vorrats. */
  target: number;
}

export interface IdPoolState {
  /** Wie viele unbenutzte Packungs-IDs das Gerät noch hat. */
  have: number;
}

/** Etikett-Vorlage. Die App reicht `body` unverändert mit jedem Druckauftrag weiter. */
export interface LabelTemplate {
  key: PrintJobKind;
  hash: string;
  body: { [key: string]: unknown };
  updated_at: string;
}

export interface LoginRequest {
  password: string;
  device_name: string;
}

export interface LoginResponse {
  /** Geräte-Token; bei jedem Aufruf als 'Authorization: Bearer <token>' senden. */
  token: string;
  device: Device;
}

/** Stand des Nachschlagens bei Open Food Facts. */
export type LookupState = "none" | "pending" | "found" | "not_found";

/** Eine einzelne Packung. Entnommene Packungen bleiben als Datensatz erhalten. */
export interface Package {
  id: string;
  product_id: string;
  zone_id: string;
  /** MHD als Kalenderdatum; null = keines. */
  best_before: string | null;
  /** Zeitpunkt des Einlagerns. */
  created_at: string;
  updated_at: string;
  /** Gesetzt = entnommen (Lösch-Historie). */
  removed_at: string | null;
  removal_reason: RemovalReason | null;
  /** Verdrängte Bearbeitung, nur bei entnommenen Packungen. */
  displaced: DisplacedEdit | null;
}

export interface PackageChanges {
  best_before?: string | null;
  zone_id?: string;
  product_id?: string;
}

/** Änderbare Felder einer Packung. */
export type PackageField = "best_before" | "zone_id" | "product_id";

export interface PackageLabelData {
  /** QR-Inhalt, z. B. 'STOWLY/P/A2B3C'. */
  qr: string;
  /** Packungs-ID im Klartext, z. B. 'A2B3C'. */
  id: string;
  /** Produktname; bei Platzhaltern der Barcode. */
  title: string;
  /** Packungsgröße und Marke, mit ' · ' verbunden; darf leer sein. Die Größe steht vorn. */
  subtitle: string;
  /** MHD als 'TT.MM.JJJJ'; leer = keines. */
  best_before: string;
  /** Tag des Einlagerns als 'TT.MM.JJJJ'. */
  stored: string;
  /** Name der Zone; leer, wenn es nur eine gibt. */
  zone: string;
}

/** Ein Etikett, das gedruckt werden soll oder wurde. Die Kennung ist zugleich die Auftragskennung beim Druckdienst. */
export interface PrintJob {
  id: string;
  kind: PrintJobKind;
  /** Gesetzt bei kind = package. */
  package_id: string | null;
  /** Gesetzt bei kind = zone. */
  zone_id: string | null;
  /** Zieldrucker; null = beim Drucken aus Zone und Standarddrucker bestimmen. */
  printer_id: string | null;
  state: PrintJobState;
  /** Fehlercode des Druckdienstes bei failed. */
  error: string | null;
  /** boot_id des Druckdienstes, der den Auftrag angenommen hat. */
  boot_id: string | null;
  /** Gerät, das den Auftrag angelegt hat. */
  device_id: string | null;
  created_at: string;
  updated_at: string;
}

export type PrintJobKind = "package" | "zone";

/**
 * Zustand eines Etiketts aus Sicht des Haushalts.
 *
 * `pending` und `cancelled` kennt nur Stowly; die übrigen Werte sind die
 * Zustände des Druckdienstes (docs/etiketten.md).
 */
export type PrintJobState =
  | "pending"
  | "queued"
  | "printing"
  | "printed"
  | "sent"
  | "failed"
  | "unknown"
  | "cancelled";

export interface Printer {
  id: string;
  name: string;
  connection: PrinterConnection;
  /** Gesetzt genau dann, wenn connection = server. */
  server: ServerPrinterConfig | null;
  /** Gesetzt genau dann, wenn connection = direct. */
  direct: DirectPrinterConfig | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** Was ein Treiber kann. Ändert sich nicht, solange die Konfiguration gleich bleibt. */
export interface PrinterCapabilities {
  dpi: number;
  media: PrinterMedia;
  cutter: boolean;
  colors: string[];
  status_query: boolean;
  confirms_print: boolean;
}

/** Die Art der Verbindung lässt sich nicht ändern; passend zur Verbindung ist nur eines der Objekte erlaubt. */
export interface PrinterChanges {
  name?: string;
  server?: ServerPrinterConfig;
  direct?: DirectPrinterConfig;
}

export type PrinterConnection = "server" | "direct";

export type PrinterDriver = "brother_ql" | "image";

/** Eingelegtes Material. Längenangaben in Millimetern. */
export interface PrinterMedia {
  width_mm: number;
  length_mm: number | null;
  printable_px: number;
}

/** Zuletzt gesehener Zustand eines Druckers („zuletzt gesehen", kein Herzschlag). */
export interface PrinterStatus {
  printer_id: string;
  /** Wann ein Gerät oder der Server den Druckdienst zuletzt erreicht hat. */
  observed_at: string;
  boot_id: string | null;
  /** Zustand des Druckers; null, wenn der Dienst ihn nicht melden konnte. */
  status: DriverStatus | null;
  /** Zustand des Rechners (Pi); null bei Druckern am Server. */
  host: HostHealth | null;
}

export interface Product {
  id: string;
  /** Leer = noch unbekannt (Platzhalter); die App zeigt dann den Barcode. */
  name: string;
  brand: string;
  /** Packungsgröße als Text, z. B. '500 g'. */
  quantity: string;
  /** Bild-ID für GET /api/images/{id} oder null. */
  image: string | null;
  /** Vorlaufzeit der MHD-Warnung in Tagen; null = Haushaltswert. */
  warn_days: number | null;
  lookup: LookupState;
  /** Alle Barcodes dieses Produkts, aufsteigend sortiert. */
  barcodes: string[];
  created_at: string;
  updated_at: string;
  /** Gesetzt = in einem anderen Produkt aufgegangen. */
  deleted_at: string | null;
  /** Bei zusammengeführten Produkten: das Zielprodukt. */
  merged_into: string | null;
}

export interface ProductChanges {
  name?: string;
  brand?: string;
  quantity?: string;
  warn_days?: number | null;
}

export type RejectCode = "invalid" | "not_found" | "id_conflict" | "last_zone" | "internal";

/** Warum eine Packung entnommen wurde (Grundlage der Statistik in Stufe 2). */
export type RemovalReason = "consumed" | "discarded" | "mistake";

/** Antwort von `GET /api/health`. `app` ist der Marker, an dem die App den Server erkennt. */
export interface ServerHealth {
  app: "stowly";
  status: "ok";
  version: string;
  protocol: number;
  time: string;
  /** false = STOWLY_PASSWORD ist nicht gesetzt, Anmelden ist nicht möglich. */
  configured: boolean;
}

/** Drucker, den der Server ansteuert. */
export interface ServerPrinterConfig {
  driver: PrinterDriver;
  /** Modell für den Treiber, z. B. 'QL-820NWB'; null beim Bild-Treiber. */
  model: string | null;
  /** 'tcp://192.168.1.60:9100' oder 'usb://04f9:209b'; null beim Bild-Treiber. */
  address: string | null;
  /** Rollenkennung des Treibers, z. B. '62' für die 62-mm-Endlosrolle. */
  media: string;
}

/** Antwort von `GET /v1/health`. */
export interface ServiceHealth {
  app: string;
  version: string;
  protocol: number;
  boot_id: string;
  uptime_s: number;
  proof: string | null;
  host: HostHealth | null;
  printers: ServicePrinter[];
}

/** Antwort auf das Einreichen und Abfragen eines Auftrags. */
export interface ServiceJob {
  id: string;
  state: ServiceJobState;
  printer: string;
  boot_id: string;
  error: ServiceJobError | null;
  position: number | null;
}

export interface ServiceJobError {
  code: string;
  message: string;
}

/**
 * Inhalt eines Druckauftrags.
 *
 * Entweder `template` und `data` (Normalfall: gerendert wird beim Drucker)
 * oder `png` (Notausgang: fertiges 1-Bit-PNG in exakt passender Größe, Base64).
 * `expect_boot_id` gehört nicht zum Inhalt und beeinflusst `content_hash` nicht.
 */
export interface ServiceJobRequest {
  template?: { [key: string]: unknown } | null;
  data?: { [key: string]: string } | null;
  png?: string | null;
  printer?: string | null;
  copies?: number;
  cut?: boolean;
  expect_boot_id?: string | null;
}

/** Zustand eines Auftrags im Druckdienst. */
export type ServiceJobState = "queued" | "printing" | "printed" | "sent" | "failed" | "unknown";

/** Ein Drucker, wie ihn `GET /v1/printers` und `GET /v1/health` melden. */
export interface ServicePrinter {
  name: string;
  driver: string;
  model: string | null;
  capabilities: PrinterCapabilities;
  status: DriverStatus;
}

export interface SettingsChanges {
  zone_mode?: ZoneMode;
  primary_zone_id?: string | null;
  warn_days?: number;
  trash_retention_days?: number;
  default_printer_id?: string | null;
}

export interface SyncRequest {
  /** Protokollversion des Geräts. */
  protocol: number;
  /** dataset_id der letzten Antwort; null beim ersten Sync. */
  dataset_id: string | null;
  /** cursor der letzten Antwort; 0 beim ersten Sync. */
  cursor: number;
  /** Geräteuhr im Moment des Absendens. */
  sent_at: string;
  /** Befehle in der Reihenfolge ihrer Entstehung. */
  commands: Command[];
  id_pool: IdPoolState;
  app_version?: string | null;
}

export interface SyncResponse {
  protocol: number;
  /** Kennung des Datenbestands. Weicht sie vom gespeicherten Wert ab, ist reset = true. */
  dataset_id: string;
  server_time: string;
  /** Ein Ergebnis je gesendetem Befehl, in derselben Reihenfolge. */
  results: CommandResult[];
  /** true = die Antwort ist ein vollständiger Abzug; lokale Kopie vorher leeren. */
  reset: boolean;
  changes: Changes;
  /** Beim nächsten Sync mitsenden. */
  cursor: number;
  /** true = sofort erneut abrufen (ohne Befehle), es gibt weitere Änderungen. */
  has_more: boolean;
  id_pool: IdPoolGrant;
  /** Schlägt der Server unbekannte Barcodes bei Open Food Facts nach? false = abgeschaltet (STOWLY_OFF_ENABLED=0). */
  lookup_enabled: boolean;
}

export interface Zone {
  id: string;
  name: string;
  /** Schlüssel aus der Symbolliste der Web-App; Unbekanntes wird als 'box' gezeigt. */
  icon: string;
  /** Schlüssel aus der Farbpalette der Web-App oder null. */
  color: string | null;
  /** Reihenfolge, aufsteigend; bei Gleichstand nach Name. */
  sort: number;
  /** Drucker für Etiketten dieser Zone; null = Standarddrucker. */
  printer_id: string | null;
  created_at: string;
  updated_at: string;
  /** Gesetzt = Zone gelöscht (Grabstein). */
  deleted_at: string | null;
  /** Bei gelöschten Zonen: wohin ihre Packungen verschoben wurden. */
  moved_to: string | null;
}

export interface ZoneChanges {
  name?: string;
  icon?: string;
  color?: string | null;
  sort?: number;
  printer_id?: string | null;
}

export interface ZoneLabelData {
  /** QR-Inhalt, z. B. 'STOWLY/Z/3F2B…' (32 Hex-Zeichen). */
  qr: string;
  /** Name der Zone. */
  title: string;
  /** Zusatzzeile, z. B. 'Lagerzone'; darf leer sein. */
  subtitle: string;
}

export type ZoneMode = "primary" | "equal";
