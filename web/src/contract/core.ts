/**
 * Die Schnittstelle des Offline-Kerns (Vertrag zwischen Oberfläche und Kern).
 *
 * Die Oberfläche liest und ändert **alle** Daten ausschließlich über `Core`. Sie spricht
 * nie selbst mit dem Server, mit IndexedDB oder mit einem Druckdienst.
 *
 * Es gibt zwei Implementierungen:
 *   src/core  der echte Kern: lokale Datenbank, Outbox, Sync (Worker 3)
 *   src/mock  die Attrappe: Beispieldaten im Arbeitsspeicher, ohne Server
 *
 * Grundregeln für beide:
 *
 * 1. Lesen ist reaktiv (`Live<T>`), Schreiben ist ein Auftrag (`Promise`).
 * 2. Ein Schreibaufruf ist erfüllt, sobald die Änderung **lokal** gespeichert ist und in
 *    der Outbox steht. Er wartet nie auf den Server und gelingt auch offline. Die
 *    passenden `Live`-Werte haben sich bis dahin geändert.
 * 3. Was der Server später ablehnt, taucht in `sync.problems` auf; der lokale Zustand
 *    folgt dann wieder dem Server.
 * 4. Ausnahmen davon brauchen den Server und sind am Kommentar „braucht den Server"
 *    zu erkennen: Sie scheitern offline mit CoreError "offline".
 * 5. Fehler sind immer `CoreError` (src/contract/errors.ts).
 * 6. Eingaben werden nach den Grenzen des Servers geprüft, bevor ein Befehl entsteht; was
 *    sie verletzt, scheitert sofort mit "invalid" statt später als Sync-Problem: Produktname
 *    120 Zeichen, Marke 80, Packungsgröße 40, Zonenname 60, Geräte- und Druckername 60,
 *    höchstens 20 Barcodes je Produkt, Vorlaufzeit 0 bis 3650 Tage, Aufbewahrung 1 bis 3650
 *    Tage. Texte werden an den Rändern gekürzt (trim). Die Zahlen stehen in `LIMITS`
 *    (api.gen.ts), die Prüfungen samt ihren Sätzen in src/contract/input.ts; Kern und
 *    Attrappe benutzen beide dieselben. Bei "invalid" ist `message` ein Satz für die Anzeige.
 * 7. Ein Aufruf ohne Wirkung gelingt und erzeugt keinen Befehl: derselbe Grund auf eine schon
 *    entnommene Packung, Wiederherstellen einer Packung im Bestand, `update` ohne Felder,
 *    Umsortieren ohne Änderung, ein Barcode, den das Produkt nicht hat, `merge(a, a)`.
 *
 * Schreibweise: Alles, was Daten trägt, hat Feldnamen in snake_case wie im Sync, auch
 * Eingaben und Optionen (`zone_id`, `apply_displaced`). Methoden und die Zugänge der
 * Schnittstelle sind camelCase (`core.data.removedPackages`, `core.stock.store`).
 */
import type {
  Command,
  Device,
  DirectPrinterConfig,
  HouseholdSettings,
  Package,
  PackageChanges,
  Printer,
  PrinterChanges,
  PrinterStatus,
  PrintJob,
  Product,
  ProductChanges,
  RejectCode,
  RemovalReason,
  ServerPrinterConfig,
  ServiceHealth,
  SettingsChanges,
  Zone,
  ZoneChanges,
} from "./api.gen";
import { PRINTER_ERROR_CODES } from "./api.gen";
import type { CoreErrorCode } from "./errors";

// --------------------------------------------------------------------------------------
// Reaktive Werte
// --------------------------------------------------------------------------------------

/**
 * Ein Wert, der sich ändern kann. In React über `useLive` (src/contract/react.tsx) lesen.
 *
 * Für Implementierungen:
 * - `get()` liefert `undefined`, solange noch nichts geladen ist, danach immer einen Wert.
 * - `get()` liefert dieselbe Referenz, bis sich der Wert ändert (sonst rendert React endlos).
 * - Listener werden nach jeder Änderung von `get()` gerufen, auch nach dem ersten Laden.
 */
export interface Live<T> {
  get(): T | undefined;
  /** Meldet einen Listener an und liefert die Funktion zum Abmelden. */
  subscribe(listener: () => void): () => void;
}

// --------------------------------------------------------------------------------------
// Sitzung
// --------------------------------------------------------------------------------------

export interface SessionDevice {
  id: string;
  /** Name, den der Anwender diesem Gerät bei der Anmeldung gegeben hat. */
  name: string;
}

export type SessionState =
  /** Der Kern liest noch seinen gespeicherten Zustand. Nur einen Ladebildschirm zeigen. */
  | { status: "loading" }
  /**
   * Nicht angemeldet.
   * - "never": dieses Gerät war noch nie angemeldet
   * - "logout": der Anwender hat sich abgemeldet, die lokale Kopie ist gelöscht
   * - "revoked": der Server hat das Token gesperrt. Lokale Daten und ungesendete Änderungen
   *   liegen noch vor und werden nach erneuter Anmeldung gesendet.
   *
   * `last_device_name` ist der Name, unter dem dieses Gerät zuletzt angemeldet war, oder null
   * (bei "never" immer null). Die Anmeldung schlägt ihn vor: Nach einer Sperre soll das Gerät
   * nicht unter einem zweiten Namen in der Geräteliste stehen. Er überlebt auch das Abmelden.
   */
  | { status: "signed_out"; reason: "never" | "logout" | "revoked"; last_device_name: string | null }
  | { status: "signed_in"; device: SessionDevice };

export interface SessionApi {
  readonly state: Live<SessionState>;

  /**
   * Meldet dieses Gerät mit dem Haushalts-Passwort an und holt den Bestand. Braucht den Server.
   *
   * Erfüllt sich erst, wenn der erste Abgleich gelungen ist. Deshalb gilt, solange
   * `state.status === "signed_in"` ist: Es gibt mindestens eine Zone, und die Einstellungen
   * des Haushalts sind geladen. Scheitert der erste Abgleich, bleibt das Gerät abgemeldet.
   *
   * Ein zweiter Aufruf während einer laufenden Anmeldung (Doppeltipp) wartet auf die erste,
   * statt ein zweites Gerät anzulegen. "invalid" heißt: Der Gerätename ist leer oder länger
   * als 60 Zeichen, oder das Gerät ist schon angemeldet. "rate_limited" trägt die Wartezeit
   * in `details.retry_after_s`. "not_supported": Der Browser lässt keine lokale Datenbank zu.
   * @throws CoreError invalid_password | rate_limited | not_configured | protocol_mismatch | offline | invalid | not_supported
   */
  login(password: string, deviceName: string): Promise<void>;

  /**
   * Meldet ab und löscht die lokale Kopie samt ID-Vorrat, dazu die Sync-Probleme und die
   * vorab geladenen Produktbilder. Von den Geräte-Einstellungen fällt nur `scan_zone_id` weg.
   * Der Name des Geräts bleibt als Vorschlag für die nächste Anmeldung (`last_device_name`).
   * Gelingt auch offline; das Token wird beim Server gesperrt, sobald er erreichbar ist.
   * @throws CoreError pending_changes, wenn ungesendete Änderungen vorliegen und
   *         `discard_pending` nicht gesetzt ist (`details.pending` = Anzahl)
   */
  logout(options?: { discard_pending?: boolean }): Promise<void>;
}

// --------------------------------------------------------------------------------------
// Sync
// --------------------------------------------------------------------------------------

export interface SyncStatus {
  /**
   * Ist der Server erreichbar? Das prüft der Kern selbst (GET /api/health), weil der Browser
   * im WLAN des Pi „online" meldet. null = noch nicht geprüft.
   */
  online: boolean | null;
  /** "syncing" während eines laufenden Abgleichs, "error" wenn der letzte Versuch scheiterte. */
  phase: "idle" | "syncing" | "error";
  /**
   * Änderungen, die noch nicht beim Server angekommen sind. Gezählt werden Befehle, nicht
   * Vorgänge: Drei Packungen eines neuen Produkts einzulagern sind vier.
   */
  pending: number;
  /** Letzter erfolgreicher Abgleich (Vertrags-Zeitstempel) oder null. */
  last_synced_at: string | null;
  /** Grund des letzten Fehlschlags; null nach einem Erfolg. */
  last_error: { code: CoreErrorCode; message: string; at: string } | null;
  /** Version des Servers laut letzter Antwort oder null. */
  server_version: string | null;
  /**
   * Schlägt der Server unbekannte Barcodes bei Open Food Facts nach? So, wie es die letzte
   * Antwort eines Abgleichs gesagt hat; der Kern merkt es sich über Neustarts. null = noch
   * unbekannt (nicht angemeldet, oder seit der Anmeldung kein Abgleich). Nur bei `false`
   * verspricht die Oberfläche kein Nachschlagen; siehe `willLookUp` (barcode.ts).
   */
  lookup_enabled: boolean | null;
}

/** Ein Befehl, den der Server nicht (oder nicht wie gewünscht) ausgeführt hat. */
export interface SyncProblem {
  /** Kennung des Befehls. */
  id: string;
  /** Wann der Anwender die Änderung gemacht hat. */
  at: string;
  /**
   * - "rejected": abgelehnt, die Änderung ist verworfen
   * - "displaced": traf eine inzwischen entnommene Packung; die Bearbeitung liegt in der
   *   Lösch-Historie und lässt sich beim Wiederherstellen übernehmen
   */
  status: "rejected" | "displaced";
  code: RejectCode | null;
  /** Klartext des Servers als Rückfall. */
  message: string | null;
  /** Der betroffene Befehl, um dem Anwender sagen zu können, worum es ging. */
  command: Command;
}

/** So viele Sync-Probleme hebt der Kern höchstens auf. */
export const MAX_SYNC_PROBLEMS = 200;

export interface SyncApi {
  readonly status: Live<SyncStatus>;
  /**
   * Abgelehnte und verdrängte Änderungen, neueste zuerst, bis der Anwender sie wegklickt.
   * Höchstens `MAX_SYNC_PROBLEMS`; kommen mehr dazu, fallen die ältesten weg. Ein Eintrag
   * "displaced" verschwindet von selbst, sobald seine Packung keine verdrängte Bearbeitung
   * mehr trägt (wiederhergestellt, mit oder ohne Übernahme, oder nicht mehr in der
   * Lösch-Historie): Dann gibt es nichts mehr zu übernehmen.
   */
  readonly problems: Live<SyncProblem[]>;

  /**
   * Stößt jetzt einen Abgleich an. Erfüllt sich, wenn der Versuch beendet ist, auch nach
   * einem Fehlschlag (der steht dann in `status.last_error`). Wirft nicht.
   */
  now(): Promise<void>;

  dismissProblem(id: string): Promise<void>;
}

// --------------------------------------------------------------------------------------
// Lesen
// --------------------------------------------------------------------------------------

export interface DataApi {
  /** Alle Produkte, die nicht in einem anderen aufgegangen sind. Unsortiert. */
  readonly products: Live<Product[]>;
  /** Der Bestand: alle nicht entnommenen Packungen. Unsortiert. */
  readonly packages: Live<Package[]>;
  /** Lösch-Historie: entnommene Packungen innerhalb der Aufbewahrungsdauer, neueste zuerst. */
  readonly removedPackages: Live<Package[]>;
  /** Alle nicht gelöschten Zonen, nach `sort`, dann nach Name. Es gibt immer mindestens eine. */
  readonly zones: Live<Zone[]>;
  readonly settings: Live<HouseholdSettings>;
  /** Alle nicht gelöschten Drucker, nach Name. */
  readonly printers: Live<Printer[]>;
  /** Zuletzt gesehener Zustand je Drucker („zuletzt gesehen", kein Herzschlag). */
  readonly printerStatus: Live<PrinterStatus[]>;
  /** Etiketten: alle offenen und die der letzten 30 Tage, neueste zuerst. */
  readonly printJobs: Live<PrintJob[]>;

  /** Eine Packung nach ID, auch wenn sie entnommen ist. */
  findPackage(id: string): Promise<Package | undefined>;
  /** Ein Produkt nach ID; folgt dabei einer Zusammenführung zum Zielprodukt. */
  findProduct(id: string): Promise<Product | undefined>;
  /** Das Produkt zu einem Barcode in gespeicherter Form (normalizeBarcode). */
  findProductByBarcode(barcode: string): Promise<Product | undefined>;

  /** Adresse eines Produktbilds für `<img src>`; `image` ist `Product.image`. */
  imageUrl(image: string): string;
}

// --------------------------------------------------------------------------------------
// Bestand ändern
// --------------------------------------------------------------------------------------

/** Welches Produkt eingelagert wird. */
export type ProductRef =
  /** Ein bekanntes Produkt. */
  | { kind: "existing"; product_id: string }
  /**
   * Ein gescannter Barcode (gespeicherte Form). Kennt die lokale Kopie ihn, wird dieses
   * Produkt verwendet. Sonst entsteht sofort ein Platzhalter; Name und Bild ergänzt der
   * Server später aus Open Food Facts, wenn er diesen Barcode nachschlägt (`willLookUp`:
   * nicht bei ladeninternen Codes, nicht bei abgeschaltetem Nachschlagen; das Produkt hat
   * dann von Anfang an `lookup: "none"`). `name` setzt den Namen gleich von Hand.
   */
  | { kind: "barcode"; barcode: string; name?: string }
  /** Ein neues Produkt ohne Scan. */
  | {
      kind: "new";
      name: string;
      brand?: string;
      quantity?: string;
      warn_days?: number | null;
      barcodes?: string[];
    };

/** Höchstzahl an Packungen je Einlager-Vorgang. */
export const MAX_STORE_COUNT = 50;

export interface StoreInput {
  product: ProductRef;
  zone_id: string;
  /** MHD "YYYY-MM-DD" oder null. */
  best_before: string | null;
  /** Anzahl der Packungen, 1 bis MAX_STORE_COUNT. Jede bekommt eine eigene ID. */
  count: number;
  /**
   * Etiketten anfordern. Vorgabe: die Geräte-Einstellung `print_labels`.
   * Hat der Haushalt keinen Drucker, werden nie Etiketten angefordert.
   */
  labels?: boolean;
}

export interface StoreResult {
  product: Product;
  /** Die neuen Packungen mit ihren IDs, in der Reihenfolge der Etiketten. */
  packages: Package[];
  /** Die angeforderten Etiketten (Zustand "pending"); leer, wenn keine angefordert wurden. */
  print_jobs: PrintJob[];
}

export interface StockApi {
  /**
   * Einlagern: legt `count` Packungen an, bei Bedarf das Produkt, und fordert Etiketten an.
   * @throws CoreError invalid (Menge, Datum, Barcode) | not_found (Produkt, Zone)
   */
  store(input: StoreInput): Promise<StoreResult>;

  /**
   * Entnehmen oder löschen. Die Packungen wandern in die Lösch-Historie.
   * Für bereits entnommene Packungen ändert der Aufruf nur den Grund.
   * Noch ausstehende Etiketten dieser Packungen ("pending") werden verworfen.
   * @throws CoreError not_found
   */
  remove(packageIds: string[], reason: RemovalReason): Promise<void>;

  /**
   * Wiederherstellen aus der Lösch-Historie, auch als „Rückgängig" direkt nach dem Entnehmen.
   * `apply_displaced` übernimmt dabei eine verdrängte Bearbeitung (Package.displaced).
   * @throws CoreError not_found
   */
  restore(packageIds: string[], options?: { apply_displaced?: boolean }): Promise<void>;

  /**
   * Ändert MHD, Zone oder Produkt mehrerer Packungen. Nur die in `changes` vorhandenen
   * Schlüssel werden geändert; `best_before: null` entfernt das MHD.
   * Trifft die Änderung eine entnommene Packung, wird sie nicht angewendet, sondern in
   * `Package.displaced` aufgehoben (Sync-Protokoll 7.2); `restore` mit `apply_displaced`
   * übernimmt sie. Der Aufruf gelingt trotzdem; nach dem Abgleich steht die Änderung als
   * "displaced" in `sync.problems` (die Attrappe trägt sie dort sofort ein).
   * @throws CoreError not_found | invalid
   */
  update(packageIds: string[], changes: PackageChanges): Promise<void>;
}

export interface NewProduct {
  name: string;
  brand?: string;
  quantity?: string;
  warn_days?: number | null;
  barcodes?: string[];
}

export interface ProductsApi {
  /** @throws CoreError invalid | barcode_taken */
  create(input: NewProduct): Promise<Product>;
  /** Nur die vorhandenen Schlüssel werden geändert. @throws CoreError not_found | invalid */
  update(id: string, changes: ProductChanges): Promise<void>;
  /**
   * @throws CoreError barcode_taken, wenn der Barcode lokal schon zu einem anderen Produkt
   *         gehört (`details.product_id`). Die Oberfläche bietet dann `merge` an.
   */
  addBarcode(id: string, barcode: string): Promise<void>;
  removeBarcode(id: string, barcode: string): Promise<void>;
  /**
   * Führt zwei Produkte zusammen: Packungen und Barcodes von `sourceId` gehen auf
   * `targetId` über, `sourceId` verschwindet aus `data.products`. Nicht umkehrbar.
   */
  merge(sourceId: string, targetId: string): Promise<void>;
}

export interface NewZone {
  name: string;
  icon?: string;
  color?: string | null;
  printer_id?: string | null;
}

export interface ZonesApi {
  /** Legt die Zone hinter der letzten an. @throws CoreError invalid */
  create(input: NewZone): Promise<Zone>;
  /** Nur die vorhandenen Schlüssel werden geändert. @throws CoreError not_found | invalid */
  update(id: string, changes: ZoneChanges): Promise<void>;
  /** Neue Reihenfolge: `ids` enthält alle Zonen in der gewünschten Folge. */
  reorder(ids: string[]): Promise<void>;
  /**
   * Löscht eine Zone; ihre Packungen wandern nach `moveTo`.
   * @throws CoreError last_zone | not_found | invalid (moveTo ist dieselbe Zone)
   */
  remove(id: string, moveTo: string): Promise<void>;
}

export interface SettingsApi {
  /** Haushalts-Einstellungen ändern (gelten für alle Geräte). Nur vorhandene Schlüssel. */
  update(changes: SettingsChanges): Promise<void>;
}

// --------------------------------------------------------------------------------------
// Einstellungen dieses Geräts
// --------------------------------------------------------------------------------------

/**
 * Einstellungen, die nur dieses Gerät betreffen und nie synchronisiert werden.
 * Thema und Akzentfarbe gehören nicht dazu (src/ui/theme.ts): Sie müssen schon
 * vor dem Start der App feststehen.
 */
export interface DevicePrefs {
  /** Beim Einlagern Etiketten anfordern. */
  print_labels: boolean;
  /** Ton als Rückmeldung beim Scannen. */
  scan_sound: boolean;
  /** Vibration als Rückmeldung beim Scannen (nur wo der Browser sie kann). */
  scan_vibration: boolean;
  /** Gemerkte Kamera (`MediaDeviceInfo.deviceId`) oder null = automatisch wählen. */
  scan_camera_id: string | null;
  /** Zuletzt gewählte Zone im Modus „gleichwertig" oder null. */
  scan_zone_id: string | null;
}

export const DEFAULT_DEVICE_PREFS: DevicePrefs = {
  print_labels: true,
  scan_sound: true,
  scan_vibration: true,
  scan_camera_id: null,
  scan_zone_id: null,
};

export interface PrefsApi {
  readonly value: Live<DevicePrefs>;
  update(changes: Partial<DevicePrefs>): Promise<void>;
}

// --------------------------------------------------------------------------------------
// Drucker und Etiketten
// --------------------------------------------------------------------------------------
//
// Wie gedruckt wird, steht in docs/etiketten.md (Abschnitte 4 bis 6). Kurz:
//
// - Ein Etikett ist ein synchronisierter Datensatz (`PrintJob`). Anfordern heißt: anlegen im
//   Zustand "pending". Das gelingt immer, auch offline.
// - **Zugestellt wird ein Etikett nur von dem Gerät, das es angefordert hat**
//   (`PrintJob.device_id`), und zwar an den Druckdienst seines Druckers: beim Drucker am
//   Server an `<App>/print`, beim direkten Drucker an den Pi. Nur dieses Gerät weiß, ob es den
//   Auftrag schon einmal abgeschickt hat; so druckt nichts doppelt. Andere Geräte zeigen das
//   Etikett nur an.
// - Der Kern stellt von selbst zu (nach dem Anfordern, nach jedem Abgleich, beim Start, wenn
//   ein Drucker wieder erreichbar ist) und auf Wunsch sofort (`print.flush`). Erreicht er den
//   Dienst nicht, bleibt das Etikett "pending".
// - Welcher Drucker ein Etikett druckt, entscheidet `printerIdForJob` (labels.ts), bei jedem
//   Versuch neu.

export type NewPrinter =
  | { name: string; connection: "server"; server: ServerPrinterConfig }
  | { name: string; connection: "direct"; direct: DirectPrinterConfig };

/** Warum ein Druckdienst gerade nicht benutzbar ist. Die Oberfläche hat zu jedem Wert einen Satz. */
export type PrinterProblem =
  /** Drucker am Server: Der Server ist nicht erreichbar. */
  | "offline"
  /** Auf keiner Adresse hat in der Zeit etwas geantwortet: falsches WLAN, Pi aus, Zertifikat nicht installiert. */
  | "unreachable"
  /** Der Browser hat den Zugriff auf das lokale Netzwerk abgelehnt (Local Network Access). */
  | "permission"
  /** Es antwortet etwas, aber diese App darf nicht mitlesen: Ihr Ursprung fehlt in der Konfiguration des Druckdienstes. */
  | "blocked"
  /** Es antwortet etwas anderes als ein Stowly-Druckdienst, oder das Token stimmt nicht (Nachweis falsch). */
  | "not_verified"
  /** Der Dienst kennt diesen Drucker nicht (`direct.printer` falsch, oder am Server nicht eingerichtet). */
  | "unknown_printer"
  /** Direkter Drucker, aber die App läuft ohne HTTPS (`secure_context: false`): Der Browser lässt den Direktdruck nicht zu. */
  | "insecure_context";

/** Ergebnis einer Sofort-Abfrage eines Druckers. */
export interface PrinterProbe {
  /** Der Druckdienst hat geantwortet (und sich bei direkten Druckern ausgewiesen). */
  reachable: boolean;
  /** Über welche Adresse; null bei Druckern am Server oder wenn nichts antwortete. */
  url: string | null;
  /** Antwort des Druckdienstes oder null. */
  health: ServiceHealth | null;
  /** Warum nicht benutzbar; null, wenn alles passt. Auch bei `reachable: true` möglich ("unknown_printer"). */
  problem: PrinterProblem | null;
  /** Dasselbe als Satz, als Rückfall für die Anzeige; sonst null. */
  error: string | null;
}

export interface PrintersApi {
  /** @throws CoreError invalid */
  create(input: NewPrinter): Promise<Printer>;
  /** Nur die vorhandenen Schlüssel werden geändert. @throws CoreError not_found | invalid */
  update(id: string, changes: PrinterChanges): Promise<void>;
  /** Löscht den Drucker; Zonen, die auf ihn zeigten, nutzen wieder den Standarddrucker. */
  remove(id: string): Promise<void>;
  /**
   * Fragt den Druckdienst jetzt ab (`GET /v1/health`) und merkt sich das Ergebnis in
   * `data.printerStatus`. Wirft nicht, wenn der Dienst fehlt: Das steht im Ergebnis.
   * Bei einem direkten Drucker darf der Aufruf die Nachfrage des Browsers nach dem lokalen
   * Netzwerk auslösen; die Oberfläche ruft ihn deshalb nur auf eine Handlung des Anwenders hin.
   * @throws CoreError not_found
   */
  probe(id: string): Promise<PrinterProbe>;
}

/** Was ein Zustellversuch gebracht hat. */
export interface PrintFlushReport {
  /** Etiketten, die bei einem Druckdienst angekommen sind (jetzt "queued" oder weiter). */
  delivered: number;
  /** Eigene Etiketten, die danach weiter ausstehen. */
  pending: number;
  /**
   * Je Drucker, bei dem es nicht geklappt hat, der Grund. `printer_id: null` steht für
   * Etiketten, denen kein Drucker zugeordnet ist.
   */
  problems: { printer_id: string | null; problem: PrinterProblem | "no_printer"; message: string }[];
}

/** So viele Etiketten übergibt `print.handoff` höchstens auf einmal. */
export const MAX_HANDOFF_JOBS = 20;

/**
 * Was in `PrintJob.error` stehen kann (docs/etiketten.md, 4.1): die Codes des Druckers, die des
 * Druckdienstes und die der App selbst ("handoff": an die Seite des Druckdienstes übergeben;
 * "not_printed": der Anwender hat auf „Wurde gedruckt?" mit Nein geantwortet). Die Oberfläche
 * hat zu jedem einen Satz und zeigt einen unbekannten Code unverändert.
 */
export const PRINT_JOB_ERROR_CODES = [
  ...PRINTER_ERROR_CODES,
  "unknown_printer",
  "invalid_request",
  "render_failed",
  "cancelled",
  "interrupted",
  "handoff",
  "not_printed",
] as const;
export type PrintJobErrorCode = (typeof PRINT_JOB_ERROR_CODES)[number];

export interface PrintApi {
  /**
   * Fordert je Packung ein neues Etikett an (Nachdruck). Beim Einlagern macht das
   * `stock.store` selbst.
   * @throws CoreError not_found (Packung unbekannt, oder der Haushalt hat keinen Drucker)
   */
  requestPackageLabels(packageIds: string[], options?: { printer_id?: string | null }): Promise<PrintJob[]>;
  /** Fordert das QR-Etikett einer Zone an. @throws CoreError not_found (Zone unbekannt, kein Drucker) */
  requestZoneLabel(zoneId: string, options?: { printer_id?: string | null }): Promise<PrintJob>;
  /**
   * Neuer Versuch für ein Etikett in "failed", "unknown" oder "cancelled". Legt ein neues
   * Etikett an; das alte bleibt, wie es ist (ein Auftrag druckt nie zweimal).
   *
   * Auch für ein ausstehendes Etikett ("pending"), das ein **anderes** Gerät angefordert hat:
   * Dann wird das alte verworfen ("cancelled") und ein neues für dieses Gerät angelegt. Das
   * andere Gerät druckt es nicht mehr, sobald es abgeglichen hat; die Oberfläche sagt das dazu.
   * @throws CoreError not_found | invalid (Zustand passt nicht)
   */
  retry(jobId: string): Promise<PrintJob>;
  /**
   * Verwirft ein ausstehendes Etikett ("pending" oder "queued"), auch das eines anderen Geräts.
   * Ein eigenes Etikett, das schon beim Druckdienst wartet ("queued"), wird zuerst dort
   * verworfen: Druckt es inzwischen, scheitert der Aufruf mit "invalid" und das Etikett zeigt
   * den Zustand des Dienstes; ist der Dienst nicht erreichbar, scheitert er mit "offline".
   * @throws CoreError not_found | invalid | offline
   */
  cancel(jobId: string): Promise<void>;
  /**
   * Antwort des Anwenders auf „Wurde das Etikett gedruckt?" bei einem Etikett in "unknown":
   * true setzt es auf "printed", false auf "failed" (dann bietet die Oberfläche `retry` an).
   */
  resolveUnknown(jobId: string, printed: boolean): Promise<void>;
  /**
   * Versucht jetzt, alle eigenen ausstehenden Etiketten zuzustellen, und fragt den Stand der
   * schon abgeschickten ab. Erfüllt sich nach dem Versuch, wirft nicht. Darf die Nachfrage des
   * Browsers nach dem lokalen Netzwerk auslösen (wie `printers.probe`).
   */
  flush(): Promise<PrintFlushReport>;
  /**
   * Vorschau eines Etiketts als PNG, gerendert vom Druckdienst des Servers. Braucht den Server.
   * `printer_id` rendert für genau diesen Drucker am Server; ohne Angabe (oder bei einem
   * direkten Drucker) für die Vorgabe: 62-mm-Rolle bei 300 dpi, 696 x 342 Pixel.
   * @throws CoreError offline | not_found | invalid (Vorlage lässt sich nicht rendern)
   */
  preview(
    subject: { kind: "package"; package_id: string } | { kind: "zone"; zone_id: string },
    options?: { printer_id?: string | null },
  ): Promise<Blob>;
  /**
   * Das Bild, das ein Drucker mit Bild-Treiber für dieses Etikett geschrieben hat (PNG).
   * Braucht den Druckdienst dieses Druckers.
   * @throws CoreError not_found (kein Bild-Treiber, oder noch nicht gedruckt) | offline
   */
  image(jobId: string): Promise<Blob>;
  /**
   * Notweg für einen direkten Drucker, den der Browser nicht ansprechen darf (iPhone ohne
   * gültiges Zertifikat): liefert die Adresse einer Seite des Druckdienstes, die die eigenen
   * ausstehenden Etiketten dieses Druckers selbst einreicht (docs/etiketten.md, 5.7), höchstens
   * `MAX_HANDOFF_JOBS` und nur die einer Art (die des ältesten: Packungen oder Zonen); für den
   * Rest ruft die Oberfläche noch einmal. Sie öffnet die Adresse in einem neuen Tab. Die
   * übergebenen Etiketten gelten danach als "unknown" mit `error: "handoff"`: Die App erfährt
   * den Ausgang nicht und fragt nach.
   * @throws CoreError not_found (Drucker unbekannt, oder nichts Eigenes steht aus) | invalid (kein direkter Drucker)
   */
  handoff(printerId: string): Promise<{ url: string; jobs: PrintJob[] }>;
}

// --------------------------------------------------------------------------------------
// Verwaltung: braucht den Server
// --------------------------------------------------------------------------------------

export interface DevicesApi {
  /**
   * Alle Geräte des Haushalts, auch gesperrte (`revoked_at`); das eigene mit `current: true`.
   * Braucht den Server. Hat ein anderes Gerät dieses hier umbenannt, gilt der neue Name
   * danach auch in `session.state`.
   */
  list(): Promise<Device[]>;
  /** Braucht den Server. Der neue Name des eigenen Geräts gilt sofort in `session.state`. */
  rename(id: string, name: string): Promise<Device>;
  /**
   * Sperrt das Token eines Geräts. Braucht den Server. Sperrt ein Gerät sich selbst, wechselt
   * es sofort nach `signed_out` mit Grund "revoked"; Daten und Outbox bleiben.
   */
  revoke(id: string): Promise<void>;
}

export interface BackupApi {
  /** Lädt die vollständige Kopie der Datenbank. Braucht den Server. */
  download(): Promise<{ blob: Blob; filename: string }>;
}

// --------------------------------------------------------------------------------------
// Die App selbst
// --------------------------------------------------------------------------------------

export interface AppState {
  /** Version der Web-App. */
  version: string;
  /**
   * false über http://<LAN-IP>: Dort verweigert der Browser Kamera, Offline-Betrieb und
   * Installation. Die Oberfläche weist darauf hin und blendet das Scannen aus.
   */
  secure_context: boolean;
  /** Die App läuft installiert vom Home-Bildschirm. */
  installed: boolean;
  /** Der Browser bietet die Installation an (`promptInstall`), Android und Desktop. */
  can_install: boolean;
  /**
   * "ios": iPhone oder iPad im Browser, nicht installiert. Dort gibt es keine Aufforderung;
   * die Oberfläche zeigt die Anleitung („Teilen", dann „Zum Home-Bildschirm"). Sonst null.
   */
  manual_install: "ios" | null;
  /** Eine neue Version ist geladen und wartet auf `applyUpdate`. */
  update_ready: boolean;
  /**
   * Dieser Tab kann nicht weiterarbeiten, bis er neu geladen ist: Ein anderer Tab läuft schon
   * mit einer neueren Version und hat die lokale Datenbank übernommen (`versionchange`).
   * Schreibaufrufe scheitern solange mit "not_supported". Die Oberfläche zeigt das als Sperre
   * mit einem Knopf für `applyUpdate`.
   */
  update_required: boolean;
  /** Der Browser hat zugesagt, die lokalen Daten nicht zu löschen; null = unbekannt. */
  storage_persistent: boolean | null;
}

export interface AppApi {
  readonly state: Live<AppState>;
  /**
   * Wechselt auf die neue Version: aktiviert den wartenden Service Worker und lädt die App
   * neu. Ohne wartende Version lädt der Aufruf nur neu, wenn `update_required` gilt.
   */
  applyUpdate(): Promise<void>;
  /** Zeigt den Installationsdialog des Browsers; true, wenn angenommen. Ohne `can_install`: false. */
  promptInstall(): Promise<boolean>;
  /**
   * Bittet den Browser, die lokalen Daten dauerhaft zu behalten (`navigator.storage.persist`),
   * und liefert die Antwort; sie steht danach auch in `state.storage_persistent`. Der Kern
   * fragt nach der Anmeldung von selbst einmal; dies ist der Knopf für „noch einmal".
   */
  requestPersistence(): Promise<boolean>;
}

// --------------------------------------------------------------------------------------

export interface Core {
  readonly session: SessionApi;
  readonly sync: SyncApi;
  readonly data: DataApi;
  readonly stock: StockApi;
  readonly products: ProductsApi;
  readonly zones: ZonesApi;
  readonly settings: SettingsApi;
  readonly prefs: PrefsApi;
  readonly printers: PrintersApi;
  readonly print: PrintApi;
  readonly devices: DevicesApi;
  readonly backup: BackupApi;
  readonly app: AppApi;
}
