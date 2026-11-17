// GENERIERT. Nicht von Hand ändern.
//
// Quelle sind die Modelle in server/stowly/contract und print/stowly_print/model.py.
// Neu erzeugen: python -m stowly.contract.export
// Der Test server/tests/test_contract.py schlägt fehl, wenn diese Datei veraltet ist.

/* eslint-disable */

/** Protokollversion des Sync. */
export const PROTOCOL_VERSION = 2;
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
/** Statistik ohne Zeitraum: so viele Monate bis einschließlich des laufenden. */
export const STATS_DEFAULT_MONTHS = 12;
/** Höchstens so viele Monate umfasst ein Zeitraum der Statistik. */
export const STATS_MAX_MONTHS = 120;
/** Höchstens so viele Produkte stehen in `Stats.top_discarded`. */
export const STATS_TOP_PRODUCTS = 10;
/** Sensor für Home Assistant: höchstens so viele Einträge je Liste. */
export const HA_SUMMARY_LIST_MAX = 5;
/** Sensor für Home Assistant: höchstens so viele Zeichen je Eintrag einer Liste. */
export const HA_SUMMARY_ENTRY_MAX = 40;
/** Sensor für Home Assistant: höchstens so viele Zeichen im Satz `message`. */
export const HA_SUMMARY_MESSAGE_MAX = 255;
/** Updates über GitHub: Der Server fragt in diesem Abstand nach dem neuesten Release. */
export const UPDATE_CHECK_INTERVAL_S = 21600;
/** Updates über GitHub: „Nach Updates suchen“ höchstens einmal in so vielen Sekunden. */
export const UPDATE_CHECK_MIN_GAP_S = 60;
/** Liste aller Waren für Home Assistant: höchstens so viele Zeichen je Produktname. */
export const HA_STOCK_NAME_MAX = 60;
/** Liste aller Waren für Home Assistant: höchstens so viele Einträge über alle Zonen. */
export const HA_STOCK_ENTRY_MAX = 300;
/** Ein offener Eintrag geht erst nach Bring!, wenn er so viele Sekunden offen ist. */
export const HA_MIRROR_DELAY_S = 120;
/** Der Abgleich mit Home Assistant läuft spätestens nach so vielen Sekunden wieder. */
export const HA_SYNC_INTERVAL_S = 120;
/** Höchstens eine Testnachricht je Gerät in so vielen Sekunden. */
export const PUSH_TEST_INTERVAL_S = 10;
/** Wohin eine Push-Nachricht führt; der Server setzt den Ursprung der App davor. */
export const PUSH_PATHS = {"daily": "/warnungen", "test": "/einstellungen", "update": "/einstellungen"};
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
  min_stock: 999,
  shopping_text: 120,
  shopping_quantity: 999,
  push_endpoint: 1024,
  push_origin: 200,
  password_min: 8,
  setup_address: 253,
  setup_addresses: 10,
  push_contact: 200,
  backup_recipient: 100,
  backup_recipients: 10,
  backup_files_listed: 50,
  restore_identity: 4096,
  ha_url: 200,
  ha_token: 2000,
  label_text: 40,
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
  "shopping_item.create",
  "shopping_item.update",
  "shopping_item.delete",
] as const;

/** Alle Endpunkte des Servers. Platzhalter wie {device_id} ersetzt der Aufrufer. */
export const ENDPOINTS = {
  apply_restore: { method: "POST", path: "/api/restore/apply" },
  cancel_pi_pairing: { method: "DELETE", path: "/api/pi/pairings/{pairing_id}" },
  change_password: { method: "POST", path: "/api/auth/password" },
  check_ha: { method: "POST", path: "/api/server-config/ha/check" },
  check_restore: { method: "POST", path: "/api/restore/check" },
  check_update: { method: "POST", path: "/api/update/check" },
  create_ha_sensor_token: { method: "POST", path: "/api/server-config/ha/sensor-token" },
  create_pi_pairing: { method: "POST", path: "/api/pi/pairings" },
  delete_ha_sensor_token: { method: "DELETE", path: "/api/server-config/ha/sensor-token" },
  delete_push_subscription: { method: "DELETE", path: "/api/push/subscription" },
  delete_restore_previous: { method: "DELETE", path: "/api/restore/previous" },
  download_backup_file: { method: "GET", path: "/api/backup/files/{name}" },
  download_ca: { method: "GET", path: "/api/setup/ca.crt" },
  get_ha_config: { method: "GET", path: "/api/server-config/ha" },
  get_ha_sensor_token: { method: "GET", path: "/api/server-config/ha/sensor-token" },
  get_image: { method: "GET", path: "/api/images/{image_id}" },
  get_integrations: { method: "GET", path: "/api/integrations" },
  get_label_design: { method: "GET", path: "/api/labels/design" },
  get_pi_pairing: { method: "GET", path: "/api/pi/pairings/{pairing_id}" },
  get_push_key: { method: "GET", path: "/api/push/key" },
  get_restore_status: { method: "GET", path: "/api/restore" },
  get_server_config: { method: "GET", path: "/api/server-config" },
  get_setup: { method: "GET", path: "/api/setup" },
  get_stats: { method: "GET", path: "/api/stats" },
  ha_stock: { method: "GET", path: "/api/ha/stock" },
  ha_summary: { method: "GET", path: "/api/ha/summary" },
  health: { method: "GET", path: "/api/health" },
  install_update: { method: "POST", path: "/api/update/install" },
  list_devices: { method: "GET", path: "/api/devices" },
  list_events: { method: "GET", path: "/api/events" },
  login: { method: "POST", path: "/api/auth/login" },
  logout: { method: "POST", path: "/api/auth/logout" },
  lookup_barcode: { method: "GET", path: "/api/lookup/{barcode}" },
  pi_bundle: { method: "GET", path: "/api/pi/bundle.tar.gz" },
  pi_install_script: { method: "GET", path: "/api/pi/install.sh" },
  pi_pair: { method: "POST", path: "/api/pi/pair" },
  pi_pair_start: { method: "POST", path: "/api/pi/pair/start" },
  preview_label: { method: "POST", path: "/api/labels/preview" },
  put_label_design: { method: "PUT", path: "/api/labels/design" },
  put_push_subscription: { method: "PUT", path: "/api/push/subscription" },
  refresh_lookup: { method: "POST", path: "/api/lookup/{barcode}/refresh" },
  reset_label_design: { method: "DELETE", path: "/api/labels/design" },
  revoke_device: { method: "DELETE", path: "/api/devices/{device_id}" },
  run_backup: { method: "POST", path: "/api/backup/run" },
  send_push_test: { method: "POST", path: "/api/push/test" },
  set_product_image: { method: "PUT", path: "/api/products/{product_id}/image" },
  setup_password: { method: "POST", path: "/api/setup/password" },
  sync: { method: "POST", path: "/api/sync" },
  undo_restore: { method: "POST", path: "/api/restore/undo" },
  update_device: { method: "PATCH", path: "/api/devices/{device_id}" },
  update_ha_config: { method: "PATCH", path: "/api/server-config/ha" },
  update_server_config: { method: "PATCH", path: "/api/server-config" },
  update_setup: { method: "PATCH", path: "/api/setup" },
  upload_restore: { method: "PUT", path: "/api/restore/upload" },
} as const;

export type AddressSource = "learned" | "manual";

export interface BackupConfig {
  /** Die automatische Sicherung ist an. */
  enabled: boolean;
  /** env: fest an, weil die Schlüssel aus STOWLY_BACKUP_RECIPIENTS kommen; app: Schalter in der App; default: noch nie geschaltet, dann an. */
  enabled_source: ConfigSource;
  recipients: BackupRecipientInfo[];
  recipients_source: ConfigSource;
  /** Uhrzeit der täglichen Sicherung, Zeitzone des Servers. */
  time: string;
  time_source: ConfigSource;
  /** Ordner im Container, in den die Sicherungen gehen. */
  folder: string;
  folder_source: BackupFolderSource;
  /** Warum der Ordner nicht taugt (fehlt, nicht beschreibbar); sonst null. */
  folder_problem: string | null;
  /** Hinweis, wenn ein eigener Ordner /backups eingebunden ist, aber nicht taugt (etwa ohne Schreibrecht für Benutzer 10001): Die Sicherungen gehen dann in den Datenordner. Sonst null. */
  folder_hint: string | null;
}

/** Eine Sicherung im Ordner (nur Dateien von Stowly: stowly-JJJJ-MM-TT-HHMM.sqlite3.gz.age). */
export interface BackupFile {
  name: string;
  /** Größe in Byte. */
  size: number;
  /** Zeit aus dem Dateinamen bzw. der Datei. */
  created_at: string;
}

/** Woher der Ordner der Sicherungen kommt (docs/plan-einrichtung-b.md, Abschnitt 1). */
export type BackupFolderSource = "env" | "mounted" | "data";

/** Ein öffentlicher age-Schlüssel der Sicherung. Nie ein geheimer Schlüssel. */
export interface BackupRecipientInfo {
  /** Der öffentliche Schlüssel, vollständig (age1…). */
  key: string;
  /** Gekürzt für die Anzeige, etwa 'age1ql3z…ac8p'. */
  short: string;
  /** Wann er in der App hinzukam; null aus der Umgebung. */
  added_at: string | null;
}

/** Automatische Sicherung (docs/integrationen.md, Abschnitt 3). Nie ein Schlüssel im Klartext. */
export interface BackupStatus {
  /** Die Sicherung ist wirksam: an, mit mindestens einem öffentlichen Schlüssel (Umgebung oder App) und einem brauchbaren Ordner. */
  configured: boolean;
  /** Ordner im Container, in dem die Sicherungen liegen. */
  folder: string | null;
  /** Sicherungen im Ordner, neueste zuerst, höchstens LIMITS.backup_files_listed. */
  files: BackupFile[];
  /** Warum die Sicherung aus ist, obwohl etwas gesetzt ist; sonst null. */
  problem: string | null;
  /** Wirksame Uhrzeit der täglichen Sicherung (Umgebung, App oder Vorgabe); null ohne jede Einstellung. */
  time: string | null;
  /** Öffentliche age-Schlüssel, gekürzt: 'age1ql3z…ac8p'. */
  recipients: string[];
  /** Letzte gelungene Sicherung. */
  last_ok_at: string | null;
  /** Dateiname der letzten gelungenen Sicherung. */
  last_file: string | null;
  /** Größe der letzten gelungenen Sicherung in Byte. */
  last_size: number | null;
  /** Fehler des letzten Versuchs; null nach einem Erfolg. */
  last_error: string | null;
  last_error_at: string | null;
  /** Nächster geplanter Versuch; null = keiner. */
  next_at: string | null;
  /** Seit 48 Stunden keine gelungene Sicherung (Regel: docs/integrationen.md, 3.6). */
  warning: boolean;
}

/** Die Zertifizierungsstelle von Stowly. Nie ein Schlüssel. */
export interface CaInfo {
  name: string;
  /** SHA-256 des Zertifikats, Großbuchstaben mit Doppelpunkten (AB:CD:…). */
  fingerprint_sha256: string;
  not_after: string;
  /** false = von Hand nach /data/tls gelegt. */
  created_by_stowly: boolean;
  /** Die CA beglaubigt nur Adressen im Heimnetz. */
  name_constraints: boolean;
}

/** Das Zertifikat des HTTPS-Listeners. */
export interface CertificateInfo {
  /** Adressen (SAN) des Zertifikats. */
  addresses: string[];
  not_after: string;
}

/** Alle seit `cursor` geänderten Datensätze, jeweils vollständig. */
export interface Changes {
  products: Product[];
  zones: Zone[];
  packages: Package[];
  printers: Printer[];
  printer_status: PrinterStatus[];
  print_jobs: PrintJob[];
  label_templates: LabelTemplate[];
  /** Einträge der Einkaufsliste, auch erledigte und gelöschte. */
  shopping_items: ShoppingItem[];
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
  /** Seit Protokoll 2; fehlt bei älteren Apps. */
  min_stock?: number | null;
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

/** Legt einen eigenen Eintrag an (`origin = manual`): genau eines von Produkt und Text. */
export interface CmdShoppingItemCreate {
  /** Kennung des Befehls (UUID v4, vom Gerät erzeugt). Der Server führt sie höchstens einmal aus. */
  id: string;
  /** Wann der Anwender die Änderung gemacht hat (Geräteuhr, UTC). */
  at: string;
  type: "shopping_item.create";
  item_id: string;
  product_id?: string | null;
  text?: string;
  quantity?: number | null;
}

/** Löscht einen Eintrag endgültig, auch einen automatischen. */
export interface CmdShoppingItemDelete {
  /** Kennung des Befehls (UUID v4, vom Gerät erzeugt). Der Server führt sie höchstens einmal aus. */
  id: string;
  /** Wann der Anwender die Änderung gemacht hat (Geräteuhr, UTC). */
  at: string;
  type: "shopping_item.delete";
  item_id: string;
}

export interface CmdShoppingItemUpdate {
  /** Kennung des Befehls (UUID v4, vom Gerät erzeugt). Der Server führt sie höchstens einmal aus. */
  id: string;
  /** Wann der Anwender die Änderung gemacht hat (Geräteuhr, UTC). */
  at: string;
  type: "shopping_item.update";
  item_id: string;
  changes: ShoppingItemChanges;
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
  | CmdPrintReport
  | CmdShoppingItemCreate
  | CmdShoppingItemUpdate
  | CmdShoppingItemDelete;

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

/** Woher ein wirksamer Wert kommt (docs/integrationen.md, Abschnitt 12). */
export type ConfigSource = "env" | "app" | "default";

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

/** Ergebnis der Prüfung. Nie eine rohe Antwort von HA, nie ein Token. */
export interface HaCheck {
  state: HaCheckState;
  /** Deutscher Klartext. */
  message: string;
  ha_version: string | null;
  location_name: string | null;
  /** To-do-Listen (todo.*), höchstens 100. */
  lists: HaTodoList[];
  /** Die wirksame To-do-Liste gibt es in HA; null = keine Liste eingerichtet. */
  entity_found: boolean | null;
}

/** `POST /api/server-config/ha/check`. Ohne Felder: die wirksame Einrichtung prüfen. */
export interface HaCheckInput {
  url?: string;
  token?: string;
}

export type HaCheckState = "ok" | "token_needed" | "unauthorized" | "not_ha" | "unreachable" | "error";

/**
 * `GET /api/server-config/ha`. Nie ein Token: Der Token von HA steht in einem eigenen Speicher
 * außerhalb der Datenbank und jeder Sicherung.
 */
export interface HaConfig {
  /** env: Adresse, Token und Liste kommen aus der Umgebung (in der App gesperrt); app: aus der App; default: nichts eingerichtet. */
  source: ConfigSource;
  url: string | null;
  entity: string | null;
  token_set: boolean;
  token_set_at: string | null;
  /** Eine eigene CA für HA ist gesetzt (STOWLY_HA_CA, nur in der Umgebung). */
  ca: boolean;
  configured: boolean;
  problem: string | null;
  sensor: HaSensorConfig;
}

/**
 * `PATCH /api/server-config/ha`. Nur vorhandene Felder zählen; 409, wenn die Verbindung aus der
 * Umgebung kommt. Eine neue Adresse ohne token im selben Aufruf löscht den gespeicherten Token.
 */
export interface HaConfigChanges {
  /** http(s)://Rechner[:Port]; null = entfernen. */
  url?: string | null;
  /** Die To-do-Liste; null = entfernen. */
  entity?: string | null;
  /** Langlebiger Zugangs-Token; null = entfernen. */
  token?: string | null;
}

export interface HaSensorConfig {
  /** env: STOWLY_HA_SUMMARY_TOKEN; app: in der App erzeugt; default: keiner. */
  source: ConfigSource;
  set: boolean;
  set_at: string | null;
}

/** Der Sensor-Token für HA (erzeugen bzw. anzeigen; nur angemeldet). */
export interface HaSensorToken {
  token: string;
}

/** Ergebnis des letzten Abgleichs mit Home Assistant. */
export type HaState =
  | "off"
  | "pending"
  | "ok"
  | "unauthorized"
  | "not_found"
  | "unavailable"
  | "unreachable"
  | "error";

/** Home Assistant und Bring! (docs/integrationen.md, Abschnitt 5). Nie ein Token. */
export interface HaStatus {
  /** Adresse, Token und To-do-Liste sind wirksam: alle drei aus der Umgebung (STOWLY_HA_URL, STOWLY_HA_TOKEN, STOWLY_HA_TODO_ENTITY) oder alle drei aus der App. */
  configured: boolean;
  /** Warum der Abgleich oder der Sensor nicht wirkt, obwohl etwas gesetzt ist (etwa: der Token oder der Sensor-Token fehlt nach einem Zurückspielen); sonst null. */
  problem: string | null;
  /** Die wirksame To-do-Liste in HA. */
  entity: string | null;
  state: HaState;
  /** Letzter gelungener Abgleich. */
  last_ok_at: string | null;
  /** Fehler des letzten Abgleichs; null nach einem Erfolg. */
  last_error: string | null;
  last_error_at: string | null;
  /** Offene Einträge, die gerade in Bring! stehen. */
  linked: number;
  /** Der Sensor ist eingerichtet (STOWLY_HA_SUMMARY_TOKEN oder ein Sensor-Token aus der App). */
  sensor: boolean;
}

/** Alle Waren im Bestand je Zone, für die rest-Integration von Home Assistant (docs/integrationen.md, 6.3). */
export interface HaStock {
  /** Zustand des Sensors: Packungen im Bestand. */
  state: number;
  /** Verschiedene Produkte im Bestand. */
  product_count: number;
  /** Zonen mit Bestand, in der Reihenfolge der Zonen. */
  zones: HaStockZone[];
  /** true: nach 300 Einträgen gekürzt; state, product_count und count zählen trotzdem alles. */
  truncated: boolean;
  /** Serverzeit der Antwort. */
  updated_at: string;
}

/** Ein Produkt in einer Zone: seine Packungen dort, beschrieben durch die mit dem frühesten MHD. */
export interface HaStockProduct {
  /** Anzeigename des Produkts (bei Platzhaltern der Barcode), höchstens 60 Zeichen. */
  name: string;
  /** Packungen dieses Produkts in dieser Zone. */
  count: number;
  /** Das früheste MHD dieser Packungen; null = keine hat ein MHD. */
  best_before: string | null;
  /** best_before als TT.MM.JJJJ zum Anzeigen; null wie best_before. */
  mhd: string | null;
  /** Tage bis best_before: 0 = heute, negativ = abgelaufen; null wie best_before. */
  days: number | null;
  /** Warnstufe der Packung mit dem frühesten MHD (none = ohne MHD). */
  state: "none" | "ok" | "soon" | "expired";
}

/** Eine Zone mit Bestand. */
export interface HaStockZone {
  /** Name der Zone. */
  name: string;
  /** Packungen in dieser Zone, auch wenn die Liste gekürzt ist. */
  count: number;
  /** Nach dem frühesten MHD (ohne MHD zuletzt), dann nach Name, dann nach Produkt. */
  products: HaStockProduct[];
}

/** Zusammenfassung für die rest-Integration von Home Assistant (docs/integrationen.md, Abschnitt 6). */
export interface HaSummary {
  /** Zustand des Sensors: Packungen, die bald ablaufen (heute eingeschlossen). */
  state: number;
  /** Davon: Packungen, deren MHD heute ist. */
  today: number;
  /** Abgelaufene Packungen. */
  expired: number;
  /** Packungen im Bestand. */
  total: number;
  /** Das nächste ablaufende Produkt; null = keines. */
  next: HaSummaryNext | null;
  /** Offene Einträge der Einkaufsliste. */
  shopping: number;
  /** Bald ablaufend, nach MHD, höchstens 5 Einträge wie 'Joghurt (16.11.)'. */
  soon_list: string[];
  /** Abgelaufen, nach MHD, höchstens 5 Einträge. */
  expired_list: string[];
  /** Offene Einträge der Einkaufsliste, höchstens 5. */
  shopping_list: string[];
  /** Fertiger deutscher Satz zum Vorlesen. */
  message: string;
  /** Serverzeit der Antwort. */
  updated_at: string;
}

/** Das nächste ablaufende Produkt: die nicht abgelaufene Packung mit dem frühesten MHD. */
export interface HaSummaryNext {
  /** Anzeigename des Produkts (bei Platzhaltern der Barcode). */
  name: string;
  best_before: string;
  /** Tage bis zum MHD; 0 = heute. */
  days: number;
  /** Packungen dieses Produkts mit diesem MHD. */
  count: number;
  /** Name der Zone der ersten dieser Packungen. */
  zone: string;
}

export interface HaTodoList {
  entity_id: string;
  name: string;
  /** Offene Einträge, soweit HA sie meldet. */
  open: number | null;
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
  /** Uhrzeit der täglichen Push-Nachricht, "HH:MM" in der Zeitzone des Servers (STOWLY_TIMEZONE). */
  notify_time: string;
  updated_at: string;
}

/** HTTPS durch Stowly selbst (docs/integrationen.md, Abschnitt 11). */
export interface HttpsStatus {
  /** Stowly hat einen HTTPS-Listener (STOWLY_HTTPS_PORT ist gesetzt). */
  enabled: boolean;
  /** Der HTTPS-Listener läuft. */
  listening: boolean;
  /** Warum HTTPS nicht läuft oder kein brauchbares Zertifikat hat; sonst null. */
  problem: string | null;
  /** Port, unter dem HTTPS von außen erreichbar ist; null ohne HTTPS-Listener. */
  port: number | null;
  port_source: PortSource;
  /** Port, unter dem HTTP von außen erreichbar ist, gelernt aus Anfragen über HTTP (für den Download der CA und den Befehl für den Pi); null = noch nicht gesehen. */
  http_port: number | null;
  /** Höchstens 10, gelernte zuerst. */
  addresses: SetupAddress[];
  /** HTTPS-Ursprünge der App, etwa https://192.168.1.10:8443. */
  origins: string[];
  /** Letzte angemeldete Anfrage über den HTTPS-Listener. */
  seen_at: string | null;
  /** Diese Anfrage kam über den HTTPS-Listener von Stowly. */
  via_https: boolean;
  /** null = keine nutzbare CA (problem sagt warum). */
  ca: CaInfo | null;
  certificate: CertificateInfo | null;
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

/** Zustand von Sicherung, Home Assistant, Push und Updates für die Einstellungen der App. */
export interface IntegrationStatus {
  /** Zeitzone des Servers für Uhrzeiten und den heutigen Tag (STOWLY_TIMEZONE). */
  timezone: string;
  backup: BackupStatus;
  ha: HaStatus;
  push: PushStatus;
  update: UpdateStatus;
}

/** Wie MHD und Einlagerdatum gedruckt werden. */
export type LabelDateStyle = "long" | "short";

/** Papier und beide Gestaltungen (`PUT /api/labels/design`). */
export interface LabelDesign {
  /** Kennung des Papiers im Katalog (LabelPaper.id), für alle Drucker. */
  paper: string;
  package: LabelLayout;
  zone: LabelLayout;
}

/** Antwort von `GET`, `PUT` und `DELETE /api/labels/design`. */
export interface LabelDesignState {
  /** Die gültige Gestaltung; ohne eigene die Werte, die den mitgelieferten Vorlagen entsprechen. */
  design: LabelDesign;
  /** true = keine eigene Gestaltung: Es gelten die mitgelieferten Vorlagen. */
  is_default: boolean;
  /** Wann die eigene Gestaltung gespeichert wurde; null = Vorgabe. */
  updated_at: string | null;
  /** Daran sieht die App, ob die Vorlagen nach dem Speichern schon über den Sync da sind. */
  templates: LabelTemplateHashes;
  /** Der Papier-Katalog, in der Reihenfolge für die App. */
  papers: LabelPaper[];
}

export interface LabelField {
  field: LabelFieldName;
  size: LabelSize;
  /** Nur beim Namen (title): höchstens so viele Zeilen; sonst null. */
  lines?: number | null;
}

/** Was eine Zeile zeigt. Packungs-Etiketten können alle, Zonen-Etiketten nur ZONE_LABEL_FIELDS. */
export type LabelFieldName =
  | "title"
  | "subtitle"
  | "quantity"
  | "brand"
  | "best_before"
  | "stored"
  | "id"
  | "zone"
  | "text";

/** Etikettenart: je eine Gestaltung und eine Vorlage (LabelTemplate.key). */
export type LabelKind = "package" | "zone";

/**
 * Die Gestaltung einer Etikettenart. Die Anordnung übernimmt der Server: QR-Code als Quadrat an der
 * gewählten Seite, die Felder untereinander daneben.
 */
export interface LabelLayout {
  /** Länge des Etiketts auf einer Endlosrolle; null bei gestanzten Etiketten. */
  length_mm: number | null;
  qr: LabelQr;
  /** Die gedruckten Felder von oben nach unten, jedes höchstens einmal; was fehlt, ist aus. Stehen id und stored direkt nacheinander, teilen sie sich die unterste Zeile. */
  fields: LabelField[];
  date: LabelDateStyle;
  /** Eigener Text für das Feld text; darf leer sein. */
  text: string;
  /** Trennlinie über der untersten Zeile. */
  divider: boolean;
}

/** Ein Papier des Katalogs (`print/stowly_print/media.py`). */
export interface LabelPaper {
  /** Kennung wie bei Brother: '62' (endlos), '62x29' (gestanzt). */
  id: string;
  kind: PaperKind;
  /** Anzeigename, etwa '62 mm endlos' oder '62 × 29 mm gestanzt'. */
  name: string;
  /** Breite der Rolle, quer zur Laufrichtung. */
  width_mm: number;
  /** Länge eines gestanzten Etiketts; null bei Endlosrollen. */
  length_mm: number | null;
  /** Druckbare Punkte quer zur Laufrichtung bei 300 dpi. */
  printable_width_px: number;
  /** Druckbare Punkte in Laufrichtung bei 300 dpi, nur gestanzt; null bei Endlosrollen. */
  printable_length_px: number | null;
}

/** Antwort von `POST /api/labels/preview`. */
export interface LabelPreview {
  /** 1-Bit-PNG als Base64, so wie man das Etikett liest (ungedreht). */
  png: string;
  width_px: number;
  height_px: number;
  /** Was nur verkleinert oder gekürzt passt, als Sätze, etwa 'Name auf 3,0 mm verkleinert und gekürzt.'; leer = alles passt. */
  notes: string[];
}

/** `POST /api/labels/preview`: ein Etikett rendern, ohne etwas zu speichern. */
export interface LabelPreviewInput {
  kind: LabelKind;
  /** Kennung des Papiers im Katalog. */
  paper: string;
  layout: LabelLayout;
  /** Inhalt wie beim Drucken (PackageLabelData bzw. ZoneLabelData); null = ein Beispiel mit langem Namen und allen Feldern. */
  data?: { [key: string]: string } | null;
}

export interface LabelQr {
  side: LabelQrSide;
  /** Die kleinste Stufe scannt noch sicher (mindestens 6 Pixel je Modul). */
  size: LabelSize;
}

export type LabelQrSide = "left" | "right";

/** Größe eines Felds oder des QR-Codes: feste Millimeter, auf jedem Papier dieselben. */
export type LabelSize = "s" | "m" | "l";

/** Etikett-Vorlage. Die App reicht `body` unverändert mit jedem Druckauftrag weiter. */
export interface LabelTemplate {
  key: PrintJobKind;
  hash: string;
  body: { [key: string]: unknown };
  updated_at: string;
}

/** `hash` der Vorlagen, die gerade gelten (wie LabelTemplate.hash im Sync). */
export interface LabelTemplateHashes {
  package: string;
  zone: string;
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

/** Antwort von `GET /api/lookup/{barcode}`. Leere Felder sind `""`, nie `null` (außer `image_id`). */
export interface LookupResult {
  barcode: string;
  state: LookupResultState;
  /** Wie beim Füllen eines Produkts aufbereitet; leer, wenn unbekannt. */
  name: string;
  /** Der erste Eintrag von brands; leer, wenn unbekannt. */
  brand: string;
  /** Packungsgröße ohne Schätzzeichen; leer, wenn unbekannt. */
  quantity: string;
  /** Bild-ID für GET /api/images/{id}, wenn das Bild schon beim Server liegt; sonst null. */
  image_id: string | null;
  /** Wann Open Food Facts dieses Ergebnis geliefert hat; null bei pending, skipped, disabled und bei Ergebnissen von vor 0.5.0 ohne Zeitpunkt. */
  fetched_at: string | null;
  /** Nur bei POST …/refresh: true = nicht neu gefragt, weil dieser Barcode in der letzten Minute schon neu gefragt wurde oder Open Food Facts gerade bremst; die Antwort ist der gespeicherte Stand. Bei GET immer false. */
  throttled: boolean;
}

/** Ergebnis von `GET /api/lookup/{barcode}` (docs/sync-protokoll.md, Abschnitt 10). */
export type LookupResultState = "found" | "not_found" | "pending" | "skipped" | "disabled";

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
  /** Name der Zone, in der die Packung liegt; leer nur, wenn sie keine hat. Seit 0.5.0 immer gefüllt: Ob er gedruckt wird, entscheidet die Vorlage (ältere Apps schickten ihn nur bei mehr als einer Zone). */
  zone: string;
  /** Marke allein; darf leer sein. */
  brand: string;
  /** Packungsgröße allein, z. B. '500 g'; darf leer sein. */
  quantity: string;
  /** MHD als 'TT.MM.JJ'; leer = keines. */
  best_before_short: string;
  /** Tag des Einlagerns als 'TT.MM.JJ'. */
  stored_short: string;
}

/** Ein Drucker an einem gekoppelten Pi, mit dem Ablauf von dessen Zertifikat. */
export interface PairedPrinter {
  printer_id: string;
  /** Hostname des Pi bei der Kopplung. */
  hostname: string;
  /** Ablauf des Zertifikats; die App warnt PI_CERT_WARN_DAYS Tage vorher. */
  not_after: string;
  /** Version des Druckdienstes bei der Kopplung; null = nicht gemeldet. Daran sieht die App ohne Abfrage, ob der Pi ein Papier im Format 2 drucken kann (docs/etiketten.md, 3.4). */
  version: string | null;
  /** Druckermodell bei der Kopplung, etwa QL-570; null = keins erkannt. */
  model: string | null;
}

export type PaperKind = "endless" | "die_cut";

/** Neues Haushalts-Passwort (`POST /api/auth/password`). */
export interface PasswordChangeInput {
  current_password: string;
  new_password: string;
}

/** Woher das Haushalts-Passwort kommt. */
export type PasswordSource = "env" | "app";

/** Was der Pi beim Koppeln gemeldet hat. */
export interface PiInfo {
  hostname: string;
  /** Seine IPv4-Adressen im Heimnetz. */
  addresses: string[];
  /** Erkanntes Druckermodell, etwa QL-570; null = keins erkannt. */
  model: string | null;
  /** Beim Koppeln hing ein Brother-Drucker am USB. */
  printer_found: boolean;
  /** Version des Druckdienstes auf dem Pi. */
  version: string | null;
  /** Ablauf seines Zertifikats; null vor der Kopplung. */
  not_after: string | null;
}

/** Die Kopplung selbst (`POST /api/pi/pair`), nach der Installation auf dem Pi. */
export interface PiPairInput {
  code: string;
  hostname: string;
  /** IPv4-Adressen des Pi im Heimnetz, die zum Server zuerst. */
  addresses: string[];
  /** Zertifikatsantrag (PEM), Schlüssel P-256 oder RSA ab 2048 Bit. Betreff und Erweiterungen zählen nicht: Die Adressen bestimmt der Server. */
  csr: string;
  /** Token des Druckdienstes; Stowly trägt es in die Konfiguration des Druckers ein. */
  token: string;
  model?: string | null;
  printer_found: boolean;
  /** Der Drucker einer früheren Kopplung (pairing.json); die Wahl in der App geht vor. */
  printer_id?: string | null;
  version?: string | null;
}

/** Antwort an den Pi. Enthält keine Geheimnisse. */
export interface PiPairResult {
  printer_id: string;
  /** Name des Druckers in Stowly. */
  name: string;
  /** Das Zertifikat des Pi (PEM), von der CA von Stowly signiert. */
  certificate: string;
  /** Das Zertifikat der CA (PEM). */
  ca: string;
  /** Ursprünge der App, die direkt drucken dürfen. */
  origins: string[];
  /** Adressen, unter denen die App den Druckdienst anspricht. */
  urls: string[];
  not_after: string;
}

/** Der Pi meldet sich gleich nach dem Laden des Pakets (`POST /api/pi/pair/start`). */
export interface PiPairStartInput {
  code: string;
  hostname: string;
  version?: string | null;
}

/** Eine Kopplung (`POST /api/pi/pairings`, `GET /api/pi/pairings/{pairing_id}`). */
export interface PiPairing {
  id: string;
  state: PiPairingState;
  /** Der Code als XXXX-XXXX; nur in der Antwort auf POST, sonst null. */
  code: string | null;
  /** Der fertige Befehl für den Pi; nur in der Antwort auf POST, sonst null. */
  command: string | null;
  expires_at: string;
  /** Der gewählte bzw. gekoppelte Drucker. */
  printer_id: string | null;
  /** Was der Pi gemeldet hat; null, solange er sich nicht gemeldet hat. */
  pi: PiInfo | null;
}

/** Neuer Kopplungscode (`POST /api/pi/pairings`). */
export interface PiPairingInput {
  /** Ursprung der App (location.origin): Der Pi erlaubt ihn, und der Befehl baut darauf auf. */
  origin: string;
  /** Einen vorhandenen direkten Drucker übernehmen; null = neu anlegen. */
  printer_id?: string | null;
}

export type PiPairingState = "waiting" | "installing" | "paired" | "expired" | "cancelled";

export type PortSource = "default" | "learned" | "manual";

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

/**
 * Das eingerichtete Material (`media` in der Konfiguration): die Vorgabe für Vorlagen, die kein
 * Papier nennen. Längenangaben in Millimetern. Welche Rolle wirklich eingelegt ist, meldet
 * `PrinterInfo.loaded`.
 */
export interface PrinterMedia {
  width_mm: number;
  length_mm: number | null;
  printable_px: number;
  id?: string | null;
  kind?: string | null;
  printable_length_px?: number | null;
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
  /** Mindestbestand in Packungen; null = keiner. Zum Bestand zählt jede nicht entnommene Packung des Produkts, auch eine abgelaufene. */
  min_stock: number | null;
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
  /** null = kein Mindestbestand. Seit Protokoll 2. */
  min_stock?: number | null;
}

/** `PUT /api/products/{product_id}/image`: das Bild eines Produkts setzen oder entfernen. */
export interface ProductImageInput {
  /** Ein Bild, das Stowly gespeichert hat (image_id aus LookupResult); null entfernt das Bild. Ein unbekanntes Bild gibt 422. */
  image_id: string | null;
}

export interface PushConfig {
  /** Wirksamer Kontakt für die Push-Dienste (mailto: oder https); null = keiner, Push ist aus. */
  contact: string | null;
  source: ConfigSource;
}

export interface PushKey {
  /** Öffentlicher VAPID-Schlüssel des Servers: P-256, unkomprimiert (65 Byte), base64url ohne Füllzeichen. Für pushManager.subscribe als applicationServerKey. */
  public_key: string;
}

/** Benachrichtigungen per Web-Push (docs/integrationen.md, Abschnitt 4). */
export interface PushStatus {
  /** Ein Kontakt für die Push-Dienste ist wirksam (STOWLY_PUSH_CONTACT oder in der App). */
  configured: boolean;
  /** Warum Push aus ist, obwohl etwas gesetzt ist; sonst null. */
  problem: string | null;
  /** Geräte des Haushalts mit Push-Abo. */
  subscriptions: number;
  /** Das fragende Gerät hat ein Abo beim Server. */
  this_device: boolean;
  /** Letzter Lauf der Tagesnachricht, auch ohne Neues. */
  last_run_at: string | null;
  /** Letzte verschickte Tagesnachricht. */
  last_sent_at: string | null;
  /** Fehler des letzten Laufs; null nach einem Erfolg. */
  last_error: string | null;
}

/** Das Push-Abo dieses Geräts; ersetzt ein früheres desselben Geräts. */
export interface PushSubscriptionInput {
  /** https-Adresse beim Push-Dienst (PushSubscription.endpoint); nur bekannte Push-Dienste. */
  endpoint: string;
  keys: PushSubscriptionKeys;
  /** Ursprung der App (location.origin); daraus baut der Server die Adresse in der Nachricht. */
  origin: string;
}

export interface PushSubscriptionKeys {
  /** Öffentlicher Schlüssel des Browsers (65 Byte), base64url. */
  p256dh: string;
  /** Geheimnis des Abos (16 Byte), base64url. */
  auth: string;
}

export interface PushTestResult {
  status: PushTestStatus;
  /** Antwort des Push-Dienstes; null ohne Antwort. */
  http_status: number | null;
  /** Deutscher Klartext, als Rückfall anzeigbar. */
  message: string;
}

export type PushTestStatus = "sent" | "gone" | "rejected" | "failed";

export type RejectCode = "invalid" | "not_found" | "id_conflict" | "last_zone" | "internal";

/** Warum eine Packung entnommen wurde (Grundlage der Statistik in Stufe 2). */
export type RemovalReason = "consumed" | "discarded" | "mistake";

/** Antwort 202 auf `POST /api/restore/apply` und `POST /api/restore/undo`. */
export interface RestoreApplied {
  /** Nur beim ersten Start: Token und Gerät; es gilt, sobald /api/health nach dem Neustart wieder configured=true meldet. Ein laufender Stowly behält alle Anmeldungen. */
  login: LoginResponse | null;
}

/** `POST /api/restore/apply`: die geprüfte Sicherung einspielen; Stowly startet danach neu. */
export interface RestoreApplyInput {
  restore_id: string;
  /** Laufender Stowly: das jetzige Haushalts-Passwort. Erster Start: das Passwort aus der Sicherung (has_password) oder ein neues (sonst; dann gilt die Mindestlänge eines neuen Passworts). */
  password: string;
  /** Nur beim ersten Start: Name dieses Geräts für die Anmeldung. */
  device_name?: string;
}

/** `POST /api/restore/check`: die hochgeladene Datei prüfen, bei age mit dem geheimen Schlüssel. */
export interface RestoreCheckInput {
  upload_id: string;
  /** Der geheime age-Schlüssel (AGE-SECRET-KEY-1…), auch als Inhalt der Schlüsseldatei; Zeilen mit # zählen nicht. Nur für kind=age. Der Server speichert und loggt ihn nie. */
  identity?: string | null;
}

export interface RestoreCounts {
  products: number;
  /** Vorräte (Packungen) im Bestand. */
  items: number;
  zones: number;
  /** Offene Einträge der Einkaufsliste. */
  shopping: number;
}

/** Was hochgeladen wurde, an den ersten Bytes erkannt. */
export type RestoreKind = "age" | "gzip" | "sqlite";

/** Was in der Sicherung steckt (Antwort auf `POST /api/restore/check`). */
export interface RestorePreview {
  restore_id: string;
  expires_at: string;
  kind: RestoreKind;
  /** Version der Datenbank in der Sicherung. */
  schema_version: number;
  /** Version dieses Servers. */
  current_schema_version: number;
  /** Jüngste Änderung in der Sicherung. */
  last_activity_at: string | null;
  /** Die Sicherung enthält ein Haushalts-Passwort (nur sein Hash). */
  has_password: boolean;
  /** Geräte in der Sicherung. */
  devices: number;
  counts: RestoreCounts;
}

export type RestoreState = "idle" | "pending" | "done" | "undone" | "failed";

/** `GET /api/restore`: der letzte Stand des Zurückspielens. Nie ein Schlüssel. */
export interface RestoreStatus {
  state: RestoreState;
  /** Seit wann state gilt. */
  at: string | null;
  message: string | null;
  /** Bis wann Rückgängig geht (RESTORE_UNDO_DAYS = 7 Tage); null = gar nicht. */
  undo_until: string | null;
}

/** Antwort auf `PUT /api/restore/upload`. */
export interface RestoreUpload {
  upload_id: string;
  kind: RestoreKind;
  /** Größe in Byte. */
  size: number;
}

/** Einstellungen des Servers, die auch in der App gehen. Die Umgebung geht vor; nie ein Geheimnis. */
export interface ServerConfig {
  push: PushConfig;
  update: UpdateConfig;
  backup: BackupConfig;
}

/** `PATCH /api/server-config`. Nur vorhandene Felder zählen; 409, wenn das Feld aus der Umgebung kommt. */
export interface ServerConfigChanges {
  /** mailto:<Adresse> oder eine https-Adresse; eine Adresse ohne mailto: bekommt es davor. null = entfernen (Push ist dann aus). */
  push_contact?: string | null;
  update_enabled?: boolean;
  /** Die automatische Sicherung an oder aus. */
  backup_enabled?: boolean;
  /** Uhrzeit HH:MM; null = wieder die Vorgabe 03:30. */
  backup_time?: string | null;
  /** Die öffentlichen age-Schlüssel (age1…); ersetzt die bisherigen aus der App. Ein geheimer Schlüssel (AGE-SECRET-KEY-…) gibt 422, ohne ihn zu wiederholen. Kommt ein Schlüssel hinzu, braucht es current_password. */
  backup_recipients?: string[];
  /** Das Haushalts-Passwort. Nötig, wenn backup_recipients einen Schlüssel hinzufügt: Wer einen Schlüssel hinzufügt, kann jede künftige Sicherung lesen (samt Passwort-Hash). Fehlt es, 422 an ['body', 'current_password']; falsch: 401 invalid_password über die Bremse der Anmeldung (dann auch 429). Entfernen braucht es nicht. */
  current_password?: string;
}

/** Antwort von `GET /api/health`. `app` ist der Marker, an dem die App den Server erkennt. */
export interface ServerHealth {
  app: "stowly";
  status: "ok";
  version: string;
  protocol: number;
  time: string;
  /** false = es gibt noch kein Haushalts-Passwort (weder STOWLY_PASSWORD noch in der App gesetzt). Die App zeigt dann die Einrichtung (POST /api/setup/password). */
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
  template_schemas?: number[];
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

/**
 * Ein Papier, wie es eine Vorlage nennt (`media` im Format 2) und wie ein Drucker die eingelegte
 * Rolle meldet (`PrinterInfo.loaded`). Längenangaben in Millimetern.
 */
export interface ServicePaper {
  id: string | null;
  kind: string;
  width_mm: number;
  length_mm: number | null;
}

/** Ein Drucker, wie ihn `GET /v1/printers` und `GET /v1/health` melden. */
export interface ServicePrinter {
  name: string;
  driver: string;
  model: string | null;
  capabilities: PrinterCapabilities;
  status: DriverStatus;
  loaded?: ServicePaper | null;
}

export interface SettingsChanges {
  zone_mode?: ZoneMode;
  primary_zone_id?: string | null;
  warn_days?: number;
  trash_retention_days?: number;
  default_printer_id?: string | null;
  /** Seit Protokoll 2. */
  notify_time?: string;
}

export interface SetupAddress {
  /** IP-Adresse oder Name, unter dem Stowly erreichbar ist, ohne Port. */
  address: string;
  source: AddressSource;
  /** Das aktuelle Zertifikat des Servers gilt für diese Adresse. */
  in_certificate: boolean;
}

/** Änderungen an der Einrichtung (`PATCH /api/setup`). Nur vorhandene Felder zählen. */
export interface SetupChanges {
  /** Einen Schritt markieren. */
  step?: SetupStepChange;
  /** true = abschließen, false = wieder öffnen. */
  finished?: boolean;
  /** Die von Hand eingetragenen Adressen (IP oder Name, ohne Port); ersetzt die bisherigen. Gelernte bleiben. Jede muss im Heimnetz liegen und von der CA gedeckt sein. */
  addresses?: string[];
  /** Port, unter dem HTTPS von außen erreichbar ist; null = wieder lernen. */
  https_port?: number | null;
}

/** Das erste Haushalts-Passwort (`POST /api/setup/password`). */
export interface SetupPasswordInput {
  password: string;
  device_name: string;
}

/** Stand der Einrichtung (`GET /api/setup`). Nie ein Schlüssel, nie ein Passwort. */
export interface SetupStatus {
  password_source: PasswordSource;
  /** Alle Schritte, in der Reihenfolge des Assistenten. */
  steps: SetupStep[];
  /** Wann die Einrichtung abgeschlossen wurde; null = offen. */
  finished_at: string | null;
  /** Je nicht gelöschtem Drucker die jüngste Kopplung eines Pi, früheste Ablaufzeit zuerst. Daran warnt jedes Gerät vor dem Ablauf des Zertifikats. */
  paired_printers: PairedPrinter[];
  https: HttpsStatus;
}

export interface SetupStep {
  id: SetupStepId;
  /** Wie die App den Schritt markiert hat; ohne Markierung open. */
  state: SetupStepState;
  /** Aus Sicht des Servers erledigt: https = eine angemeldete Anfrage kam über den HTTPS-Listener; printer = es gibt einen Drucker; backup = die Sicherung ist wirksam und es gibt eine gelungene; updates = Updates sind an; notifications = ein Kontakt für die Push-Dienste ist wirksam; home_assistant = der Abgleich mit Home Assistant ist eingerichtet. */
  ready: boolean;
  /** Wann state zuletzt gesetzt wurde. */
  changed_at: string | null;
}

export interface SetupStepChange {
  id: SetupStepId;
  state: SetupStepState;
}

/** Die Schritte des Assistenten nach dem Passwort, in dieser Reihenfolge. */
export type SetupStepId = "https" | "printer" | "backup" | "updates" | "notifications" | "home_assistant";

export type SetupStepState = "open" | "done" | "skipped";

/** Ein Eintrag der Einkaufsliste: ein Produkt oder freier Text. Gelöschte bleiben als Grabstein. */
export interface ShoppingItem {
  id: string;
  /** Das Produkt; null = freier Text. */
  product_id: string | null;
  /** Freier Text; leer bei Einträgen mit Produkt. */
  text: string;
  /** Menge in Packungen; null = ohne Angabe. Bei origin = min_stock: wie viele Packungen zum Mindestbestand fehlen, vom Server nachgeführt. */
  quantity: number | null;
  origin: ShoppingOrigin;
  /** Gesetzt = erledigt (abgehakt oder eingekauft). */
  done_at: string | null;
  /** Gesetzt = gelöscht; endgültig. */
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

/** `text` nur bei Einträgen ohne Produkt, `quantity` nur bei eigenen Einträgen (docs/sync-protokoll.md, 6.6). */
export interface ShoppingItemChanges {
  text?: string;
  quantity?: number | null;
  /** true = abhaken (erledigt), false = wieder öffnen. */
  done?: boolean;
}

/** Wer einen Eintrag der Einkaufsliste angelegt hat (docs/sync-protokoll.md, 3.6). */
export type ShoppingOrigin = "manual" | "min_stock";

/** Verbraucht und entsorgt im Zeitraum. „Versehentlich" (mistake) zählt nirgends mit. */
export interface Stats {
  /** Erster Monat des Zeitraums. */
  start: string;
  /** Letzter Monat des Zeitraums (eingeschlossen). */
  end: string;
  /** Jeder Monat des Zeitraums, aufsteigend, auch leere. */
  months: StatsMonth[];
  consumed: number;
  discarded: number;
  /** Anteil des Entsorgten an verbraucht + entsorgt, 0 bis 1; null, wenn beides 0 ist. */
  discarded_share: number | null;
  /** Die am häufigsten entsorgten Produkte, meiste zuerst, höchstens 10. */
  top_discarded: StatsProduct[];
  /** Je nicht gelöschter Zone, in der Reihenfolge der Zonen, auch mit 0. */
  zones: StatsZone[];
  /** Zeitzone, in der die Monate gerechnet sind (STOWLY_TIMEZONE). */
  timezone: string;
}

export interface StatsMonth {
  /** Kalendermonat in der Zeitzone des Servers, 'YYYY-MM'. */
  month: string;
  /** Packungen, in diesem Monat als verbraucht entnommen. */
  consumed: number;
  /** Packungen, in diesem Monat als entsorgt entnommen. */
  discarded: number;
}

export interface StatsProduct {
  /** Das Produkt; nach einer Zusammenführung das Ziel. */
  product_id: string;
  /** Name des Produkts; leer bei Platzhaltern. */
  name: string;
  /** Erster Barcode, als Anzeige für Platzhalter; null = keiner. */
  barcode: string | null;
  /** Entsorgte Packungen im Zeitraum. */
  discarded: number;
}

export interface StatsZone {
  zone_id: string;
  name: string;
  consumed: number;
  discarded: number;
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

export interface UpdateConfig {
  /** Der Server fragt GitHub nach neuen Versionen. */
  enabled: boolean;
  /** Das Repository der Releases; null = keines bekannt. */
  repo: string | null;
  /** env: STOWLY_UPDATE_REPO (immer an); app: Schalter in der App; default: noch nicht geschaltet, aus. */
  source: ConfigSource;
  /** Der Schalter wirkt: Das Image kennt ein Repository (STOWLY_UPDATE_REPO_DEFAULT) und die Umgebung legt nichts fest. */
  available: boolean;
}

/** Anforderung eines Updates (POST /api/update/install). */
export interface UpdateInstallInput {
  /** Die Version, die die App als neueste gezeigt hat; muss latest sein. */
  version: string;
}

/** Wo ein Update steht (docs/integrationen.md, 10.4). */
export type UpdateState = "idle" | "requested" | "installing" | "done" | "failed";

/** Updates über GitHub (docs/integrationen.md, Abschnitt 10). Nie ein Token. */
export interface UpdateStatus {
  /** Updates sind an: STOWLY_UPDATE_REPO ist gesetzt oder der Schalter in der App an. */
  configured: boolean;
  /** Das Repository der Releases; null, solange Updates aus sind. */
  repo: string | null;
  /** Version dieses Servers. */
  current: string;
  /** Version des neuesten Releases ohne „v"; null = noch nicht gefragt oder keins. */
  latest: string | null;
  /** Titel des neuesten Releases. */
  latest_name: string | null;
  /** Änderungen des neuesten Releases als Markdown-Text, höchstens 4000 Zeichen. */
  notes: string | null;
  /** Wann das neueste Release erschienen ist. */
  published_at: string | null;
  /** Seite des neuesten Releases auf GitHub. */
  url: string | null;
  /** latest ist neuer als current. */
  available: boolean;
  /** Letzte gelungene Abfrage bei GitHub. */
  checked_at: string | null;
  /** Fehler der letzten Abfrage; null nach einem Erfolg. */
  check_error: string | null;
  /** Der Updater auf dem Rechner hat sich vor höchstens 10 Minuten gemeldet. */
  updater_ready: boolean;
  /** Letzte Meldung des Updaters. */
  updater_seen_at: string | null;
  /** Welcher Updater sich zuletzt gemeldet hat; null = noch keiner. */
  updater_kind: UpdaterKind | null;
  /** Version des Updaters, soweit er sie meldet. */
  updater_version: string | null;
  /** Befehl, der den Updater-Container anlegt oder erneuert (einmal als root, etwa im Aufgabenplaner von DSM); null, wenn das Image keine Referenz kennt (STOWLY_IMAGE_REF) oder Stowly seinen Container nicht erkennt. */
  updater_command: string | null;
  state: UpdateState;
  /** Die Version, um die es in state geht. */
  state_version: string | null;
  /** Seit wann state gilt. */
  state_at: string | null;
  /** Erklärung zu state, bei failed der Grund; sonst meist null. */
  state_message: string | null;
}

/** Welcher Updater sich meldet (docs/integrationen.md, 10.3 und 10.7). */
export type UpdaterKind = "script" | "container";

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
