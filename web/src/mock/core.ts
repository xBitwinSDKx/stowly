/**
 * Die Attrappe: ein vollständiger `Core` im Arbeitsspeicher, ohne Server und ohne IndexedDB.
 *
 * Sie verhält sich nach außen wie der echte Kern (src/contract/core.ts), vereinfacht aber
 * alles dahinter: Es gibt keine Outbox und keine Konflikte, der „Sync" ist eine Stoppuhr.
 * Nach dem Neuladen der Seite sind alle Änderungen weg.
 *
 * Gleich wie im Kern: die Eingabeprüfungen samt ihren Sätzen (src/contract/input.ts), die
 * Regel, welcher Drucker ein Etikett druckt (`printerIdForJob`), und „Löschen gewinnt": Eine
 * Änderung an einer entnommenen Packung wird aufgehoben statt angewendet.
 *
 * Der Druck ist nachgespielt: Ein Drucker am Server ist erreichbar, solange der Server es
 * ist; der direkte Drucker (Pi) nur mit der Ausgangslage "at-pi" oder nach
 * `stowlyMock.setPiReachable(true)`. Eigene ausstehende Etiketten eines erreichbaren
 * Druckers werden von selbst gedruckt; wie das ausgeht, bestimmt `stowlyMock.setPrintOutcome`.
 * Warum der Pi nicht benutzbar ist, lässt sich mit `stowlyMock.setPiProblem("permission")`
 * (oder einem anderen `PrinterProblem`) vorgeben. Wie im Kern ändert ein Zwischenstand kein
 * Etikett mit Ausgang, `print.flush` erfüllt sich nach dem Einreichen, nicht erst mit dem
 * Ergebnis, und eine neue Meldung zum Zustand eines direkten Druckers ersetzt eine ältere, noch
 * ungesendete: Ohne Server zählt sie in `sync.status.pending` nur einmal.
 *
 * Die Einkaufsliste (Stufe 2) gilt sofort wie jede Änderung. Was der Server selbst schreibt
 * (docs/sync-protokoll.md, 7.6), spielt die Attrappe beim nachgespielten Abgleich nach, also
 * mit seiner Verzögerung und ohne Server erst, wenn er wieder da ist: automatische Einträge nach
 * Entnehmen, Wiederherstellen, Einlagern, Ändern des Mindestbestands und Zusammenführen, die
 * Sperre nach Abhaken oder Löschen eines automatischen Eintrags, und eigene Einträge eines
 * Produkts, die das Einlagern erledigt. Gerechnet wird beim Abgleich mit dem Bestand von dann,
 * nicht mit dem zum Zeitpunkt jedes einzelnen Befehls; Konflikte zwischen Geräten gibt es nicht.
 * Sperren leitet die Attrappe beim Start aus den Daten ab: Ein Produkt, dessen automatischer
 * Eintrag nach dem letzten Einlagern abgehakt wurde und das keinen offenen hat, gilt als gesperrt.
 *
 * Push (Stufe 2): Die Ausgangslagen "push-…" bestimmen den Zustand; ohne sie ist er "off", auf
 * dem iPhone im Browser ("ios") "ios_install", ohne HTTPS ("insecure") "unsupported".
 * `push.enable` fragt eine nachgespielte Erlaubnis (`stowlyMock.setPushPermission`), `push.test`
 * liefert, was `stowlyMock.setPushTestResult` vorgibt (Vorgabe "sent"), und lässt wie der Server
 * höchstens eine Testnachricht je `PUSH_TEST_INTERVAL_S` Sekunden zu (nach der Uhr der Attrappe).
 * Mit "push-rate-limited" gilt die erste Testnachricht als zu früh: als wäre 3 Sekunden vorher eine
 * hinausgegangen, gleich wann sie kommt. So lässt sich das Warten auch im Browser in Ruhe ansehen.
 * `integrations.load` liefert Beispiele (Sicherung eingerichtet und gelungen, Home Assistant aus);
 * "backup-warning" und "backup-problem" zeigen die anderen Fälle der Sicherung, die Ausgangslagen
 * "ha-…" und `stowlyMock.setHaState` die Zustände von Home Assistant (docs/integrationen.md, 5.6),
 * und `stowlyMock.setIntegrations` ersetzt Teile davon. `linked` zählt dabei die offenen Einträge
 * der Einkaufsliste, die nach der Regel des Servers in Bring! stünden: mit Namen und seit
 * mindestens zwei Minuten offen (5.2).
 *
 * Updates über GitHub (docs/integrationen.md, Abschnitt 10): Ohne Ausgangslage sind sie
 * eingerichtet, und der Server läuft schon mit der neuesten Version; "release-…" zeigen die
 * anderen Fälle. `update.check` und `update.install` prüfen wie der Server (höchstens eine Suche
 * je `UPDATE_CHECK_MIN_GAP_S` nach der Uhr der Attrappe, die Reihenfolge der Prüfungen beim
 * Anfordern). GitHub kennt dabei nichts Neueres, als der Server schon gesehen hat. Mit
 * Wartezeit (im Browser) spielt die Attrappe nach dem Anfordern den Updater nach: Er beginnt,
 * der Server ist eine Weile nicht erreichbar, dann läuft die neue Version. Ohne Wartezeit
 * (Tests) bleibt die Anforderung stehen. `stowlyMock.setIntegrations({ update })` setzt den
 * Zustand, mit dem beide weiterarbeiten.
 *
 * Statistik (Stufe 2, src/mock/stats.ts): `stats.load` rechnet wie der Server aus allen Packungen
 * der Attrappe, auch aus denen jenseits der Aufbewahrungsdauer (die Beispieldaten haben dafür
 * einen Verlauf über gut ein Jahr), in der Zeitzone aus `integrations.load` (Vorgabe
 * Europe/Berlin). "stats-empty" beginnt mit einer leeren Statistik: Dann zählt nur, was nach dem
 * Start der Attrappe entnommen wird.
 *
 * Einrichtung (docs/sync-protokoll.md, 11.6 bis 11.8): Ohne Ausgangslage ist sie abgeschlossen,
 * Kontakt und Updates kommen aus der App. "unconfigured" beginnt ohne Haushalts-Passwort
 * (`session.createPassword`), mit leerem Bestand; "setup-open" mit offener Einrichtung (kein
 * Kontakt für Push, Updates aus, der Updater meldet sich nicht); "setup-env" mit Passwort, Kontakt
 * und Updates aus der Umgebung; "no-https" ohne eigenes HTTPS. Ob dieses Gerät der CA vertraut
 * (`setup.reachesSecurely`), sagt `stowlyMock.setSecureTrusted` (Vorgabe nein). Einen Pi koppelt
 * `stowlyMock.completePairing`, `expirePairing` lässt den Code ablaufen; mit Wartezeit (im
 * Browser) meldet sich der Pi nach einer Weile von selbst und koppelt. Den Ablauf der Zertifikate
 * gekoppelter Pi meldet `setup.load` in `paired_printers`; mit "pi-cert-expiring" läuft das des Pi
 * im Keller in gut 20 Tagen ab.
 */
import {
  addDays,
  APP_VERSION,
  CoreError,
  checkBarcode,
  checkBarcodeCount,
  checkBestBefore,
  checkDeviceName,
  checkDirectConfig,
  checkMinStock,
  checkNewPassword,
  checkNotifyTime,
  checkPushContact,
  checkRetentionDays,
  checkServerConfig,
  checkShoppingQuantity,
  checkShoppingText,
  checkStoreCount,
  checkWarnDays,
  checkZoneColor,
  checkZoneIcon,
  cleanText,
  compareShoppingItems,
  DEFAULT_DEVICE_PREFS,
  HA_MIRROR_DELAY_S,
  invalidInput,
  isOpenItem,
  isStoreInternalBarcode,
  isValidBarcode,
  LIMITS,
  MAX_HANDOFF_JOBS,
  MAX_SYNC_PROBLEMS,
  missingStock,
  newUuid,
  optionalText,
  printerIdForJob,
  progressAfterOutcome,
  PUSH_TEST_INTERVAL_S,
  randomPackageId,
  requiredText,
  stockCount,
  toLocalDate,
  UPDATE_CHECK_MIN_GAP_S,
  willLookUp,
  type AppState,
  type BackupStatus,
  type Core,
  type Device,
  type DevicePrefs,
  type DisplacedChange,
  type ConfigSource,
  type HaState,
  type HaStatus,
  type HttpsStatus,
  type IntegrationStatus,
  type NewPrinter,
  type NewProduct,
  type NewShoppingItem,
  type NewZone,
  type Package,
  type PackageChanges,
  type PiPairing,
  type Printer,
  type PrinterChanges,
  type PrinterProbe,
  type PrinterProblem,
  type PrinterStatus,
  type PrintFlushReport,
  type PrintJob,
  type Product,
  type ProductChanges,
  type ProductLookup,
  type ProductRef,
  type PushState,
  type PushTestResult,
  type PushTestStatus,
  type RemovalReason,
  type ServerConfig,
  type ServiceHealth,
  type SessionState,
  type SettingsChanges,
  type SetupStatus,
  type SetupStepId,
  type SetupStepState,
  type ShoppingItem,
  type ShoppingItemChanges,
  type StatsRange,
  type StoreInput,
  type StoreResult,
  type SyncProblem,
  type SyncStatus,
  type UpdateStatus,
  type Zone,
  type ZoneChanges,
} from "@/contract";

import { MOCK_IMAGES, SAMPLE_IMAGE_ID } from "./images";
import { derived, LiveValue } from "./live";
import { PREVIEW_PNG_BASE64 } from "./preview";
import { createEmptyData, createLargeData, createSampleData, createSingleZoneData, DEVICE_IDS, PRINTER_IDS, troubledPrinterStatus, type MockData } from "./sample";
import { computeStats } from "./stats";

/**
 * Ausgangslagen zum Ausprobieren, im Browser über `?mock=…` wählbar (mehrere mit Komma):
 *
 * - "empty":       frisch eingerichtet, eine Zone, kein Bestand
 * - "single-zone": Beispieldaten mit nur einer Zone
 * - "signed-out":  nicht angemeldet (Passwort der Attrappe: "stowly")
 * - "revoked":     Token gesperrt, drei ungesendete Änderungen
 * - "offline":     Server nicht erreichbar, vier ungesendete Änderungen
 * - "problems":    eine abgelehnte und eine verdrängte Änderung
 * - "update":      eine neue Version der App wartet
 * - "update-required": ein anderer Tab hat die lokale Datenbank übernommen; dieser muss neu laden
 * - "insecure":    Aufruf über http://<LAN-IP>: kein Scannen, kein Offline-Betrieb
 * - "ios":         iPhone im Browser, nicht installiert: Anleitung statt Aufforderung
 * - "installable": der Browser bietet die Installation an
 * - "no-lookup":   der Server schlägt keine Barcodes nach (STOWLY_OFF_ENABLED=0)
 * - "large":       großer Bestand: gut 2000 Packungen in gut 300 Produkten
 * - "at-pi":       dieses Gerät ist im WLAN des Pi: Der direkte Drucker ist erreichbar.
 *                  Zusammen mit "offline" ist das die Lage im Keller.
 * - "printer-trouble": beide Drucker melden Störungen (Etiketten leer, Pi heiß, SD-Karte)
 * - "push-off", "push-on", "push-denied", "push-not-configured", "push-unsupported":
 *                  Push auf diesem Gerät im genannten Zustand (`PushState`); ohne eine davon "off"
 * - "push-rate-limited": Push ist an, und eben ging eine Testnachricht hinaus: Die nächste
 *                  scheitert mit "rate_limited" (`details.retry_after_s` 7), danach geht es wieder.
 * - "backup-warning": die letzte gelungene Sicherung liegt drei Tage zurück, seither scheitert sie
 * - "backup-problem": die automatische Sicherung ist nur halb eingerichtet (ein Schlüssel fehlt)
 * - "ha-ok":       Home Assistant eingerichtet, der letzte Abgleich gelang eben (mit Sensor)
 * - "ha-pending":  eingerichtet, seit dem Start des Servers noch kein Abgleich
 * - "ha-unreachable", "ha-unauthorized": eingerichtet, der letzte Abgleich scheiterte so
 * - "ha-problem":  Home Assistant ist nur halb eingerichtet (STOWLY_HA_TOKEN fehlt)
 * - "stats-empty": die Statistik ist leer (es zählt nur, was nach dem Start entnommen wird)
 * - "release-new": auf GitHub gibt es eine neue Version des Servers mit Änderungen; der Updater
 *                  auf dem Rechner ist bereit (nicht zu verwechseln mit "update": neue App im Browser)
 * - "release-no-updater": ebenso, aber der Updater auf dem Rechner meldet sich nicht
 * - "release-off": Updates über GitHub sind aus (weder STOWLY_UPDATE_REPO noch der Schalter der App)
 * - "unconfigured": der Server hat noch kein Haushalts-Passwort; leerer Bestand (erster Aufruf)
 * - "setup-open":  die Einrichtung ist offen: kein Kontakt für Push, Updates aus, Updater nicht bereit
 * - "setup-env":   Passwort, Kontakt für Push und Updates kommen aus der Umgebung
 * - "no-https":    Stowly hat keinen eigenen HTTPS-Listener (STOWLY_HTTPS_PORT fehlt)
 * - "pi-cert-expiring": Der Pi im Keller ist gekoppelt, sein Zertifikat läuft in gut 20 Tagen ab
 */
export type MockScenario =
  | "empty"
  | "single-zone"
  | "signed-out"
  | "revoked"
  | "offline"
  | "problems"
  | "update"
  | "update-required"
  | "insecure"
  | "ios"
  | "installable"
  | "no-lookup"
  | "large"
  | "at-pi"
  | "printer-trouble"
  | "push-off"
  | "push-on"
  | "push-denied"
  | "push-not-configured"
  | "push-unsupported"
  | "push-rate-limited"
  | "backup-warning"
  | "backup-problem"
  | "ha-ok"
  | "ha-pending"
  | "ha-unreachable"
  | "ha-unauthorized"
  | "ha-problem"
  | "stats-empty"
  | "release-new"
  | "release-no-updater"
  | "release-off"
  | "unconfigured"
  | "setup-open"
  | "setup-env"
  | "no-https"
  | "pi-cert-expiring";

export const MOCK_SCENARIOS: readonly MockScenario[] = [
  "empty",
  "single-zone",
  "signed-out",
  "revoked",
  "offline",
  "problems",
  "update",
  "update-required",
  "insecure",
  "ios",
  "installable",
  "no-lookup",
  "large",
  "at-pi",
  "printer-trouble",
  "push-off",
  "push-on",
  "push-denied",
  "push-not-configured",
  "push-unsupported",
  "push-rate-limited",
  "backup-warning",
  "backup-problem",
  "ha-ok",
  "ha-pending",
  "ha-unreachable",
  "ha-unauthorized",
  "ha-problem",
  "stats-empty",
  "release-new",
  "release-no-updater",
  "release-off",
  "unconfigured",
  "setup-open",
  "setup-env",
  "no-https",
  "pi-cert-expiring",
];

/** Wie ein nachgespielter Druck ausgeht. */
export type MockPrintOutcome = "printed" | "failed" | "unknown";

/** Was der nachgespielte Browser auf die Frage nach der Erlaubnis für Benachrichtigungen antwortet. */
export type MockPushPermission = "granted" | "denied" | "default";

export const MOCK_PASSWORD = "stowly";

/** Ausgangslagen zu Push und der Zustand, den sie ergeben. */
const PUSH_SCENARIOS: readonly [MockScenario, PushState][] = [
  ["push-off", "off"],
  ["push-on", "on"],
  ["push-denied", "denied"],
  ["push-not-configured", "not_configured"],
  ["push-unsupported", "unsupported"],
  ["push-rate-limited", "on"],
];

/** So lange vor der ersten Testnachricht gilt mit "push-rate-limited" die vorige als hinausgegangen. */
const RECENT_PUSH_TEST_MS = 3_000;

/** Zeitzone des Servers der Attrappe (`IntegrationStatus.timezone`), solange `setIntegrations` keine andere vorgibt. */
const SERVER_TIMEZONE = "Europe/Berlin";

/**
 * Wie Home Assistant eingerichtet ist: ein Zustand des Abgleichs (`HaState`) oder "problem", halb
 * eingerichtet (dann ist der Abgleich aus und `problem` nennt den Grund).
 */
type HaSetup = HaState | "problem";

/** Ausgangslagen zu Home Assistant; ohne eine davon ist es aus. */
const HA_SCENARIOS: readonly [MockScenario, HaSetup][] = [
  ["ha-ok", "ok"],
  ["ha-pending", "pending"],
  ["ha-unreachable", "unreachable"],
  ["ha-unauthorized", "unauthorized"],
  ["ha-problem", "problem"],
];

/** Die To-do-Liste in Home Assistant, mit der Bring! verbunden ist (STOWLY_HA_TODO_ENTITY). */
const HA_ENTITY = "todo.einkaufsliste";

/** Der Fehler des letzten Abgleichs je Zustand, wie ihn der Server nennt (docs/integrationen.md, 5.6). */
const HA_ERRORS: Record<Exclude<HaState, "off" | "pending" | "ok">, string> = {
  unauthorized: "Home Assistant lehnt den Token ab.",
  not_found: `Die Liste ${HA_ENTITY} gibt es in Home Assistant nicht.`,
  unavailable: "Die Liste ist in Home Assistant gerade nicht verfügbar.",
  unreachable: "Home Assistant ist nicht erreichbar.",
  error: "Home Assistant antwortet mit 500.",
};

/** So lange ist ein Eintrag offen, bevor der Server ihn nach Bring! schreibt (docs/integrationen.md, 5.2). */
const BRING_DELAY_MS = HA_MIRROR_DELAY_S * 1000;

/** Die Version des Servers der Attrappe (`sync.status.server_version`, `UpdateStatus.current`). */
const MOCK_SERVER_VERSION = "0.1.0";

/** Das Repository der Releases in den Beispielen (STOWLY_UPDATE_REPO). */
const UPDATE_REPO = "beispiel/stowly";

/** Wie Updates eingerichtet sind: aktuell, eine neue Version (mit oder ohne Updater), oder gar nicht. */
type ReleaseSetup = "current" | "new" | "no-updater" | "off";

/** Ausgangslagen zu Updates; ohne eine davon sind sie eingerichtet, und der Server ist aktuell. */
const RELEASE_SCENARIOS: readonly [MockScenario, ReleaseSetup][] = [
  ["release-new", "new"],
  ["release-no-updater", "no-updater"],
  ["release-off", "off"],
];

/** Die neue Version in den Beispielen, mit ihren Änderungen als Markdown-Text wie von GitHub. */
const NEW_RELEASE = {
  version: "0.2.0",
  name: "Updates aus den Einstellungen",
  notes: [
    "## Neu",
    "",
    "- Updates lassen sich in den Einstellungen suchen und installieren.",
    "- Push meldet eine neue Version.",
    "",
    "## Behoben",
    "",
    "- Lange Produktnamen auf Etiketten werden nicht mehr abgeschnitten.",
  ].join("\n"),
} as const;

/** Was eine Anforderung ablehnt (docs/integrationen.md, 10.5), mit den Sätzen des Servers. */
const UPDATE_NOT_CONFIGURED = "Updates sind auf diesem Server aus. Einschalten unter Einstellungen → Aktualisierung.";
const UPDATER_SILENT = "Der Updater auf dem Rechner meldet sich nicht (docs/betrieb.md, Abschnitt 9).";

/** Der Befehl, der den Updater-Container anlegt, wie ihn der Server zusammensetzt (docs/integrationen.md, 10.7). */
export const MOCK_UPDATER_COMMAND =
  "/usr/local/bin/docker rm -f stowly-updater; /usr/local/bin/docker run -d --name stowly-updater --restart unless-stopped --user 0:0 --network none --read-only --tmpfs /tmp --no-healthcheck -v /var/run/docker.sock:/var/run/docker.sock --volumes-from 9c1e5b7d2a4f6e8c0b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a5c7e docker.io/beispiel/stowly:0.1.0 python -m stowly.updater";

/**
 * Der Zustand der Updates in einer Ausgangslage (docs/integrationen.md, 10.4). Die Zeitpunkte
 * richten sich nach der Uhr der Attrappe beim Start.
 */
function sampleUpdate(setup: ReleaseSetup, nowMs: number): UpdateStatus {
  const at = (msAgo: number) => new Date(nowMs - msAgo).toISOString();
  const off: UpdateStatus = {
    configured: false,
    repo: null,
    current: MOCK_SERVER_VERSION,
    latest: null,
    latest_name: null,
    notes: null,
    published_at: null,
    url: null,
    available: false,
    checked_at: null,
    check_error: null,
    updater_ready: false,
    updater_seen_at: null,
    updater_kind: null,
    updater_version: null,
    updater_command: MOCK_UPDATER_COMMAND,
    state: "idle",
    state_version: null,
    state_at: null,
    state_message: null,
  };
  if (setup === "off") {
    return off;
  }
  // Der Server fragte vor zwei Stunden; der Updater meldet sich jede Minute.
  const current: UpdateStatus = {
    ...off,
    configured: true,
    repo: UPDATE_REPO,
    latest: MOCK_SERVER_VERSION,
    latest_name: "Die erste Version",
    notes: "Bestand, Zonen, Etiketten und Einkaufsliste.",
    published_at: at(12 * 86_400_000),
    url: `https://github.com/${UPDATE_REPO}/releases/tag/v${MOCK_SERVER_VERSION}`,
    checked_at: at(2 * 3_600_000),
    updater_ready: true,
    updater_seen_at: at(60_000),
    updater_kind: "container",
    updater_version: MOCK_SERVER_VERSION,
  };
  if (setup === "current") {
    return current;
  }
  const next: UpdateStatus = {
    ...current,
    latest: NEW_RELEASE.version,
    latest_name: NEW_RELEASE.name,
    notes: NEW_RELEASE.notes,
    published_at: at(2 * 86_400_000),
    url: `https://github.com/${UPDATE_REPO}/releases/tag/v${NEW_RELEASE.version}`,
    available: true,
  };
  // Ohne Updater: Er meldete sich zuletzt vor drei Tagen.
  return setup === "new" ? next : { ...next, updater_ready: false, updater_seen_at: at(3 * 86_400_000) };
}

/** HTTPS durch Stowly in den Beispielen (docs/integrationen.md, 11): eine Adresse im Heimnetz, eine eigene CA. */
function mockHttps(off: boolean, seenAt: string | null, nowMs: number): HttpsStatus {
  const later = (days: number) => new Date(nowMs + days * 86_400_000).toISOString();
  return {
    enabled: !off,
    listening: !off,
    problem: null,
    port: off ? null : 8443,
    port_source: "default",
    http_port: 8010,
    addresses: [{ address: "192.168.1.10", source: "learned", in_certificate: !off }],
    origins: off ? [] : ["https://192.168.1.10:8443"],
    seen_at: off ? null : seenAt,
    via_https: false,
    ca: off
      ? null
      : {
          name: "Stowly CA 3F2A1C",
          fingerprint_sha256: "3F:2A:1C:7B:00:9E:41:D2:5A:6C:88:0B:CE:13:47:F0:22:9D:B4:6E:01:73:AA:5F:C8:3E:90:1D:64:B7:2C:58",
          not_after: later(3650),
          created_by_stowly: true,
          name_constraints: true,
        },
    certificate: off ? null : { addresses: ["192.168.1.10", "localhost", "127.0.0.1"], not_after: later(397) },
  };
}

/** Eine Adresse im Heimnetz (docs/integrationen.md, 11.3), vereinfacht: private IPv4 oder ein lokaler Name. */
const HOME_ADDRESS = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|[a-z0-9.-]+\.(local|lan|home|home\.arpa|internal|localdomain|fritz\.box))$/i;

/** Der nachgespielte Pi: Hostname, Adresse und Drucker, so wie er sich beim Koppeln meldet. */
const MOCK_PI = { hostname: "stowly-pi", address: "192.168.1.20", model: "QL-570" } as const;

/** Was der nachgespielte Push-Dienst auf eine Testnachricht antwortet (docs/integrationen.md, 4.7 und 4.9). */
const PUSH_TEST_RESULTS: Record<PushTestStatus, PushTestResult> = {
  sent: { status: "sent", http_status: 201, message: "Der Push-Dienst hat die Nachricht angenommen." },
  gone: { status: "gone", http_status: 410, message: "Der Push-Dienst kennt das Abo nicht mehr; der Server hat es gelöscht." },
  rejected: { status: "rejected", http_status: 403, message: "Der Push-Dienst lehnt ab (403). Stimmt STOWLY_PUSH_CONTACT?" },
  failed: { status: "failed", http_status: 503, message: "Der Push-Dienst ist gerade nicht erreichbar (503). Später noch einmal versuchen." },
};

/**
 * Was der Server bei einem Befehl selbst tut (docs/sync-protokoll.md, 7.6). Die Attrappe merkt es
 * sich beim Befehl vor und spielt es beim nächsten nachgespielten Abgleich nach. `at` ist der
 * Zeitpunkt des Befehls: Er steht in den Einträgen und entscheidet über die Sperre.
 */
type ServerEffect =
  /** Abgleich eines Produkts: Entnehmen, Wiederherstellen, Produkt einer Packung geändert, neues Produkt mit Mindestbestand. */
  | { kind: "reconcile"; product_id: string; at: string }
  /** Einlagern: Sperre aufheben, eigene Einträge erledigen, Abgleich. */
  | { kind: "stored"; product_id: string; at: string }
  /** Mindestbestand geändert, oder ein automatischer Eintrag wieder geöffnet: Sperre aufheben, Abgleich. */
  | { kind: "unlock"; product_id: string; at: string }
  /** Ein offener automatischer Eintrag ist abgehakt oder gelöscht: Sperre. */
  | { kind: "lock"; product_id: string; at: string }
  /** Zusammengeführt: Die Sperre wandert zum Ziel, dann Abgleich des Ziels. */
  | { kind: "merged"; source_id: string; target_id: string; at: string };

export interface MockOptions {
  scenarios?: readonly MockScenario[];
  /** Eigene Daten statt der Beispieldaten, z. B. für Tests. Fehlendes wird ergänzt. */
  data?: Partial<MockData>;
  /** Uhr der Attrappe. Vorgabe: die echte. */
  now?: () => Date;
  /** Verzögerung der simulierten Abläufe (Sync, Nachschlagen, Druck) in Millisekunden. 0 = sofort. Vorgabe 600. */
  latency?: number;
}

/** Eingriffe von außen: für Tests und zum Ausprobieren in der Konsole (`window.stowlyMock`). */
export interface MockControl {
  /** Server erreichbar oder nicht. */
  setOnline(online: boolean): void;
  /** Sperrt das Token, als hätte ein anderes Gerät dieses hier abgemeldet. */
  revoke(): void;
  /** Meldet eine neue Version der App. */
  setUpdateReady(ready: boolean): void;
  /** Fügt eine abgelehnte oder verdrängte Änderung hinzu. */
  addProblem(problem: SyncProblem): void;
  /** Der direkte Drucker (Pi) ist erreichbar oder nicht; erreichbar druckt er Ausstehendes sofort. */
  setPiReachable(reachable: boolean): void;
  /**
   * Warum der direkte Drucker gerade nicht benutzbar ist, wie es der echte Kern meldet
   * ("permission", "blocked", "not_verified", "unknown_printer", "insecure_context", …), oder
   * null: dann gilt `setPiReachable`. Wirkt auf `printers.probe` und `print.flush`.
   */
  setPiProblem(problem: PrinterProblem | null): void;
  /** Wie die nächsten Drucke ausgehen: "printed" (Vorgabe), "failed" (Etiketten leer) oder "unknown". */
  setPrintOutcome(outcome: MockPrintOutcome): void;
  /** Der Server schlägt Barcodes nach oder nicht (`sync.status.lookup_enabled`). */
  setLookupEnabled(enabled: boolean): void;
  /** Setzt den Zustand von Push auf diesem Gerät, wie ihn der Kern beim Start erkennen würde. */
  setPushState(state: PushState): void;
  /** Was der Browser beim nächsten `push.enable` auf die Frage nach der Erlaubnis antwortet (Vorgabe "granted"). */
  setPushPermission(permission: MockPushPermission): void;
  /** Was der Push-Dienst auf die nächsten Testnachrichten antwortet (Vorgabe "sent"). */
  setPushTestResult(status: PushTestStatus): void;
  /**
   * Ersetzt Teile des Zustands der Integrationen (`integrations.load`): `backup`, `ha`, `push`,
   * `update` oder `timezone`, jeweils als Ganzes. null kehrt zu den Beispielen der Ausgangslage
   * zurück, auch beim Zustand von Home Assistant und der Updates. Die Zeitzone gilt auch für die
   * Monate der Statistik; mit `update` arbeiten `update.check` und `update.install` weiter.
   */
  setIntegrations(changes: Partial<IntegrationStatus> | null): void;
  /**
   * Setzt den Zustand des Abgleichs mit Home Assistant (`integrations.load().ha`), mit dem Satz
   * aus docs/integrationen.md 5.6 als `last_error`: "off" heißt nicht eingerichtet, jeder andere
   * Zustand eingerichtet, mit Sensor. Ersetzt, was `setIntegrations` für `ha` vorgegeben hat.
   */
  setHaState(state: HaState): void;
  /** Vertraut dieses Gerät der CA von Stowly? Das meldet dann `setup.reachesSecurely` (Vorgabe: nein). */
  setSecureTrusted(trusted: boolean): void;
  /** Hat der Server ein Haushalts-Passwort (`sync.status.server_configured`)? true etwa, wenn ein anderes Gerät es eben festgelegt hat. */
  setServerConfigured(configured: boolean): void;
  /**
   * Der Pi ist fertig: Die Kopplung steht auf "paired", ein direkter Drucker kommt in den Bestand
   * (oder der gewählte bekommt die neue Verbindung). Ohne Kennung die jüngste wartende Kopplung.
   */
  completePairing(id?: string): void;
  /** Der Code einer Kopplung läuft ab, ohne dass der Pi gekoppelt wurde. Ohne Kennung die jüngste wartende. */
  expirePairing(id?: string): void;
  /** Aktueller Datenbestand der Attrappe. */
  snapshot(): MockData;
}

export interface MockCore extends Core {
  readonly control: MockControl;
}

function sortZones(zones: Zone[]): Zone[] {
  return [...zones].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "de"));
}

// Uhr des Servers der Attrappe (`IntegrationStatus.timezone`), für die Beispiele der Sicherung.
const HALF_HOUR_MS = 1_800_000;
const SERVER_CLOCK = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function serverPart(ms: number, type: Intl.DateTimeFormatPartTypes): string {
  return SERVER_CLOCK.formatToParts(new Date(ms)).find((part) => part.type === type)?.value ?? "";
}

/** Kalendertag eines Zeitpunkts in der Zeitzone des Servers, "YYYY-MM-DD". */
function serverDay(ms: number): string {
  return `${serverPart(ms, "year")}-${serverPart(ms, "month")}-${serverPart(ms, "day")}`;
}

/** Uhrzeit eines Zeitpunkts in der Zeitzone des Servers, "HH:MM". */
function serverTime(ms: number): string {
  return `${serverPart(ms, "hour")}:${serverPart(ms, "minute")}`;
}

/**
 * Der Lauf der Sicherung um 03:30 (Zeit des Servers) an oder vor `ms` (`direction` −1) oder an
 * oder nach `ms` (1). Europe/Berlin weicht in ganzen Stunden von UTC ab, auch über die
 * Zeitumstellung: Es genügt, die halben Stunden abzusuchen.
 */
function backupRun(ms: number, direction: -1 | 1): number {
  const round = direction < 0 ? Math.floor : Math.ceil;
  let candidate = round(ms / HALF_HOUR_MS) * HALF_HOUR_MS;
  for (let step = 0; step < 100; step += 1, candidate += direction * HALF_HOUR_MS) {
    if (serverTime(candidate) === "03:30") {
      return candidate;
    }
  }
  return ms;
}

export function createMockCore(options: MockOptions = {}): MockCore {
  const scenarios = new Set(options.scenarios ?? []);
  const clock = options.now ?? (() => new Date());
  const latency = options.latency ?? 600;
  const stamp = () => clock().toISOString();
  const today = () => toLocalDate(clock());

  const unconfigured = scenarios.has("unconfigured");
  const chosen = scenarios.has("empty") || unconfigured
    ? createEmptyData(clock())
    : scenarios.has("single-zone")
      ? createSingleZoneData(clock())
      : scenarios.has("large")
        ? createLargeData(clock())
        : createSampleData(clock());
  const base: MockData = scenarios.has("printer-trouble") ? { ...chosen, printerStatus: troubledPrinterStatus(clock()) } : chosen;
  const state = new LiveValue<MockData>({ ...base, ...options.data });

  /** Name, unter dem das Gerät der Attrappe angemeldet ist oder zuletzt war. */
  const currentName = () => state.get().devices.find((device) => device.current)?.name ?? null;

  const session = new LiveValue<SessionState>(
    scenarios.has("signed-out") || unconfigured
      ? { status: "signed_out", reason: "never", last_device_name: null }
      : scenarios.has("revoked")
        ? { status: "signed_out", reason: "revoked", last_device_name: currentName() }
        : { status: "signed_in", device: { id: DEVICE_IDS.current, name: currentName() ?? "Dieses Gerät" } },
  );

  const offline = scenarios.has("offline");
  const syncStatus = new LiveValue<SyncStatus>({
    online: !offline,
    phase: offline ? "error" : "idle",
    pending: scenarios.has("revoked") ? 3 : offline ? 4 : 0,
    last_synced_at: offline ? new Date(clock().getTime() - 3 * 3_600_000).toISOString() : stamp(),
    last_error: offline ? { code: "offline", message: "Der Server ist nicht erreichbar.", at: stamp() } : null,
    server_version: MOCK_SERVER_VERSION,
    lookup_enabled: !scenarios.has("no-lookup"),
    server_configured: !unconfigured,
  });

  /** Alle Sync-Probleme, wie sie eingetroffen sind; was die Oberfläche sieht, ist `visibleProblems`. */
  const problems = new LiveValue<SyncProblem[]>(scenarios.has("problems") ? sampleProblems(state.get(), stamp()) : []);
  const prefs = new LiveValue<DevicePrefs>({ ...DEFAULT_DEVICE_PREFS });
  const app = new LiveValue<AppState>({
    version: APP_VERSION,
    secure_context: !scenarios.has("insecure"),
    installed: false,
    can_install: scenarios.has("installable"),
    manual_install: scenarios.has("ios") ? "ios" : null,
    update_ready: scenarios.has("update"),
    update_required: scenarios.has("update-required"),
    storage_persistent: null,
  });

  // Push auf diesem Gerät (siehe Kopf der Datei). Bei offener Einrichtung fehlt der Kontakt.
  const setupOpen = unconfigured || scenarios.has("setup-open");
  const pushScenario = PUSH_SCENARIOS.find(([scenario]) => scenarios.has(scenario))?.[1];
  const pushState = new LiveValue<PushState>(
    pushScenario ?? (scenarios.has("ios") ? "ios_install" : scenarios.has("insecure") ? "unsupported" : setupOpen ? "not_configured" : "off"),
  );
  let pushPermission: MockPushPermission = "granted";
  let pushTestStatus: PushTestStatus = "sent";
  /** Zeitpunkt der letzten Testnachricht in Millisekunden (Uhr der Attrappe) oder null. */
  let lastPushTest: number | null = null;
  /** Mit "push-rate-limited" kommt die erste Testnachricht zu früh (siehe Kopf der Datei). */
  let rateLimitNextTest = scenarios.has("push-rate-limited");
  let integrationChanges: Partial<IntegrationStatus> = {};
  /** Wie Home Assistant eingerichtet ist; `setHaState` und `setIntegrations(null)` ändern es. */
  const initialHa: HaSetup = HA_SCENARIOS.find(([scenario]) => scenarios.has(scenario))?.[1] ?? "off";
  let haSetup: HaSetup = initialHa;
  /** Mit "stats-empty" zählt die Statistik nur, was ab dem Start der Attrappe entnommen wird. */
  const statsSince = scenarios.has("stats-empty") ? stamp() : null;
  /** Updates über GitHub (siehe Kopf der Datei); `setIntegrations({ update })` ersetzt den Zustand. */
  const initialUpdates = () => sampleUpdate(RELEASE_SCENARIOS.find(([scenario]) => scenarios.has(scenario))?.[1] ?? (setupOpen ? "off" : "current"), clock().getTime());
  let updates: UpdateStatus = initialUpdates();
  /** Zeitpunkt der letzten Suche auf Knopfdruck in Millisekunden (Uhr der Attrappe) oder null. */
  let lastUpdateCheck: number | null = null;

  // Einrichtung und Einstellungen des Servers (siehe Kopf der Datei).
  const fromEnv = scenarios.has("setup-env");
  let householdPassword = MOCK_PASSWORD;
  let pushContact: string | null = pushState.get() === "not_configured" ? null : "mailto:haushalt@example.org";
  let pushContactSource: ConfigSource = fromEnv ? "env" : pushContact === null ? "default" : "app";
  /** Wie die Updates eingeschaltet sind: aus der Umgebung, mit dem Schalter der App, oder nie geschaltet. */
  let updateSource: ConfigSource = fromEnv ? "env" : updates.configured ? "app" : "default";
  const setupSince = new Date(clock().getTime() - 3 * 86_400_000).toISOString();
  const setupSteps = new Map<SetupStepId, { state: SetupStepState; changed_at: string | null }>(
    (["https", "printer", "updates", "notifications"] as const).map((id) => [id, setupOpen ? { state: "open", changed_at: null } : { state: "done", changed_at: setupSince }]),
  );
  let setupFinishedAt: string | null = setupOpen ? null : setupSince;
  let https: HttpsStatus = mockHttps(scenarios.has("no-https"), setupOpen ? null : setupSince, clock().getTime());
  /** Vertraut dieses Gerät der CA von Stowly (`setup.reachesSecurely`)? */
  let secureTrusted = false;
  /** Die Kopplungen eines Pi, älteste zuerst; die Codes stehen nur in der Antwort auf `printers.pair`. */
  const pairings = new Map<string, PiPairing>();
  /** Je Drucker die jüngste Kopplung eines Pi: Hostname und Ablauf des Zertifikats (`SetupStatus.paired_printers`). */
  const piCertificates = new Map<string, { hostname: string; not_after: string }>();
  if (scenarios.has("pi-cert-expiring")) {
    piCertificates.set(PRINTER_IDS.cellar, { hostname: "stowly-pi", not_after: new Date(clock().getTime() + 20.5 * 86_400_000).toISOString() });
  }

  // Einkaufsliste: was der Server selbst tut (siehe Kopf der Datei und `ServerEffect`).
  const serverEffects: ServerEffect[] = [];
  /** Sperre der automatischen Einträge je Produkt: wirksamer Zeitpunkt (Protokoll 7.6). */
  const shoppingLocks = new Map<string, string>();
  /** Wann ein Eintrag zuletzt abgehakt oder wieder geöffnet wurde (Uhr von `done`); fehlt: seit dem Anlegen. */
  const doneClocks = new Map<string, string>();
  for (const [productId, lock] of initialLocks(state.get())) {
    shoppingLocks.set(productId, lock);
  }

  // Nachgespielter Druck (siehe Kopf der Datei).
  let piReachable = scenarios.has("at-pi");
  /** Ein Grund, aus dem der Pi nicht benutzbar ist (`setPiProblem`); null = es gilt `piReachable`. */
  let piProblem: PrinterProblem | null = null;
  let printOutcome: MockPrintOutcome = "printed";
  const troubled = scenarios.has("printer-trouble");
  const BOOT_IDS = { server: "5e77e700-0000-4000-8000-000000000001", pi: "c0ffee00-0000-4000-8000-000000000001" } as const;

  // ---------------------------------------------------------------- Hilfen

  /** Führt etwas nach der simulierten Wartezeit aus; ohne Wartezeit sofort. */
  function later(action: () => void, factor = 1): void {
    if (latency <= 0) {
      action();
    } else {
      setTimeout(action, latency * factor);
    }
  }

  function wait(factor = 1): Promise<void> {
    return new Promise((resolve) => later(resolve, factor));
  }

  let syncScheduled = false;
  /**
   * Direkte Drucker, deren Zustand noch ungesendet wartet. Wie im Kern ersetzt eine neue Meldung
   * die ältere (Sync-Protokoll 9.1): Sie zählt nicht noch einmal.
   */
  const unsentPrinterReports = new Set<string>();

  function finishSync(): void {
    syncScheduled = false;
    if (syncStatus.get().online && session.get().status === "signed_in") {
      unsentPrinterReports.clear();
      // Der Server hat die Befehle verarbeitet: Was er dabei selbst schreibt, kommt jetzt (7.6).
      runServerEffects();
      syncStatus.update((status) => ({ ...status, phase: "idle", pending: 0, last_synced_at: stamp(), last_error: null }));
    }
  }

  /** Jede Änderung zählt als ein ungesendeter Befehl, bis der „Sync" sie abholt. */
  function changed(commands = 1): void {
    syncStatus.update((status) => ({ ...status, pending: status.pending + commands }));
    if (!syncStatus.get().online || syncScheduled) {
      return;
    }
    syncScheduled = true;
    later(() => {
      syncStatus.update((status) => ({ ...status, phase: "syncing" }));
      later(finishSync, 0.5);
    });
  }

  function requireOnline(): void {
    if (!syncStatus.get().online) {
      throw new CoreError("offline", "Der Server ist nicht erreichbar.");
    }
  }

  /**
   * Eine Änderung des Anwenders: gilt sofort und zählt als `commands` ungesendete Befehle. `effects`
   * ist, was der Server bei diesen Befehlen selbst tun wird (7.6); es folgt beim nächsten Abgleich.
   */
  function mutate(change: (data: MockData) => MockData, commands = 1, effects: readonly ServerEffect[] = []): void {
    serverEffects.push(...effects);
    state.update(change);
    changed(commands);
  }

  function activeProduct(id: string): Product {
    let product = state.get().products.find((candidate) => candidate.id === id);
    // einer Zusammenführung zum Ziel folgen
    for (let hops = 0; product?.merged_into && hops < 10; hops += 1) {
      const target = product.merged_into;
      product = state.get().products.find((candidate) => candidate.id === target);
    }
    if (!product || product.deleted_at !== null) {
      throw new CoreError("not_found", "Das Produkt gibt es nicht.");
    }
    return product;
  }

  function activeZone(id: string): Zone {
    const zone = state.get().zones.find((candidate) => candidate.id === id && candidate.deleted_at === null);
    if (!zone) {
      throw new CoreError("not_found", "Die Zone gibt es nicht.");
    }
    return zone;
  }

  function existingPackages(ids: string[]): Package[] {
    return ids.map((id) => {
      const pkg = state.get().packages.find((candidate) => candidate.id === id);
      if (!pkg) {
        throw new CoreError("not_found", `Die Packung ${id} gibt es nicht.`);
      }
      return pkg;
    });
  }

  function activePrinter(id: string): Printer {
    const printer = state.get().printers.find((candidate) => candidate.id === id && candidate.deleted_at === null);
    if (!printer) {
      throw new CoreError("not_found", "Den Drucker gibt es nicht.");
    }
    return printer;
  }

  function hasPrinter(): boolean {
    return state.get().printers.some((printer) => printer.deleted_at === null);
  }

  function requirePrinter(): void {
    if (!hasPrinter()) {
      throw new CoreError("not_found", "Es ist kein Drucker eingerichtet.");
    }
  }

  function barcodeOwner(barcode: string): Product | undefined {
    return state.get().products.find((product) => product.deleted_at === null && product.barcodes.includes(barcode));
  }

  function newPackageId(): string {
    for (;;) {
      const id = randomPackageId();
      if (!state.get().packages.some((pkg) => pkg.id === id)) {
        return id;
      }
    }
  }

  /** Baut ein Produkt aus schon geprüften Angaben. */
  function buildProduct(input: NewProduct, lookup: Product["lookup"]): Product {
    const now = stamp();
    return {
      id: newUuid(),
      name: input.name,
      brand: input.brand ?? "",
      quantity: input.quantity ?? "",
      image: null,
      warn_days: input.warn_days ?? null,
      min_stock: input.min_stock ?? null,
      lookup,
      barcodes: [...new Set(input.barcodes ?? [])].sort(),
      created_at: now,
      updated_at: now,
      deleted_at: null,
      merged_into: null,
    };
  }

  /** Spielt das Nachschlagen bei Open Food Facts nach: gerade Endziffer = gefunden. */
  function simulateLookup(productId: string, barcode: string): void {
    later(() => {
      if (!syncStatus.get().online) {
        return; // bleibt "pending", bis der Server wieder da ist
      }
      const found = Number(barcode.at(-1)) % 2 === 0;
      state.update((data) => ({
        ...data,
        products: data.products.map((product) =>
          product.id === productId && product.lookup === "pending"
            ? {
                ...product,
                lookup: found ? "found" : "not_found",
                name: found && product.name === "" ? `Beispielprodukt ${barcode.slice(-4)}` : product.name,
                brand: found && product.brand === "" ? "Beispielmarke" : product.brand,
                quantity: found && product.quantity === "" ? "500 g" : product.quantity,
                image: found && product.image === null ? SAMPLE_IMAGE_ID : product.image,
                updated_at: stamp(),
              }
            : product,
        ),
      }));
    }, 4);
  }

  function resolveProduct(ref: ProductRef): { product: Product; created: boolean } {
    if (ref.kind === "existing") {
      return { product: activeProduct(ref.product_id), created: false };
    }
    if (ref.kind === "barcode") {
      checkBarcode(ref.barcode);
      const known = barcodeOwner(ref.barcode);
      if (known) {
        return { product: known, created: false };
      }
      // Dieselbe Regel wie im Kern: Nur was der Server nachschlägt, beginnt als "pending".
      const lookup = willLookUp(ref.barcode, syncStatus.get().lookup_enabled) ? "pending" : "none";
      const name = optionalText(ref.name, LIMITS.product_name, "Der Name");
      const brand = optionalText(ref.brand, LIMITS.brand, "Die Marke");
      const quantity = optionalText(ref.quantity, LIMITS.quantity, "Die Packungsgröße");
      return { product: buildProduct({ name, brand, quantity, barcodes: [ref.barcode] }, lookup), created: true };
    }
    const name = requiredText(ref.name, LIMITS.product_name, "Das Produkt");
    const brand = optionalText(ref.brand, LIMITS.brand, "Die Marke");
    const quantity = optionalText(ref.quantity, LIMITS.quantity, "Die Packungsgröße");
    checkWarnDays(ref.warn_days);
    checkMinStock(ref.min_stock);
    const barcodes = [...new Set(ref.barcodes ?? [])];
    checkBarcodeCount(barcodes.length);
    for (const barcode of barcodes) {
      checkBarcode(barcode);
      const owner = barcodeOwner(barcode);
      if (owner) {
        throw new CoreError("barcode_taken", "Der Barcode gehört schon zu einem anderen Produkt.", { product_id: owner.id });
      }
    }
    return {
      product: buildProduct({ name, brand, quantity, warn_days: ref.warn_days ?? null, min_stock: ref.min_stock ?? null, barcodes }, "none"),
      created: true,
    };
  }

  function buildJob(subject: { package_id: string } | { zone_id: string }, printerId: string | null): PrintJob {
    const now = stamp();
    const device = session.get();
    return {
      id: newUuid(),
      kind: "package_id" in subject ? "package" : "zone",
      package_id: "package_id" in subject ? subject.package_id : null,
      zone_id: "zone_id" in subject ? subject.zone_id : null,
      printer_id: printerId,
      state: "pending",
      error: null,
      boot_id: null,
      device_id: device.status === "signed_in" ? device.device.id : null,
      created_at: now,
      updated_at: now,
    };
  }

  function setJobState(id: string, next: PrintJob["state"], error: string | null = null, changes: Partial<PrintJob> = {}): void {
    state.update((data) => ({
      ...data,
      // Wie im Kern und beim Server: Ein Zwischenstand ändert kein Etikett mit Ausgang (Protokoll 6.6).
      printJobs: data.printJobs.map((job) =>
        job.id === id && !progressAfterOutcome(job.state, next) ? { ...job, ...changes, state: next, error, updated_at: stamp() } : job,
      ),
    }));
  }

  function findJob(id: string): PrintJob {
    const job = state.get().printJobs.find((candidate) => candidate.id === id);
    if (!job) {
      throw new CoreError("not_found", "Das Etikett gibt es nicht.");
    }
    return job;
  }

  /** Welcher Drucker ein Etikett druckt: dieselbe Regel wie im Kern (`printerIdForJob`). */
  function printerFor(job: PrintJob): Printer | undefined {
    const data = state.get();
    const printerId = printerIdForJob(job, {
      package: (id) => data.packages.find((candidate) => candidate.id === id),
      zone: (id) => data.zones.find((candidate) => candidate.id === id),
      printer: (id) => data.printers.find((candidate) => candidate.id === id),
      settings: data.settings,
    });
    return data.printers.find((printer) => printer.id === printerId);
  }

  /** Erreicht dieses Gerät den Druckdienst des Druckers? */
  function reachable(printer: Printer): boolean {
    return printer.connection === "server" ? syncStatus.get().online === true : piReachable && piProblem === null;
  }

  /** Warum ein Drucker nicht benutzbar ist, wie der Kern es meldet (nur, wenn er es nicht ist). */
  function problemOf(printer: Printer): { problem: PrinterProblem; message: string } {
    if (printer.connection === "server") {
      return { problem: "offline", message: "Der Server ist nicht erreichbar." };
    }
    return piProblem === null
      ? { problem: "unreachable", message: "Der Druckdienst antwortet auf keiner Adresse." }
      : { problem: piProblem, message: "Der Druckdienst ist nicht benutzbar (Attrappe)." };
  }

  function ownDeviceId(): string | null {
    const current = session.get();
    return current.status === "signed_in" ? current.device.id : null;
  }

  /** Die eigenen ausstehenden Etiketten: Nur die stellt dieses Gerät zu. */
  function ownPending(): PrintJob[] {
    const own = ownDeviceId();
    return state
      .get()
      .printJobs.filter((job) => job.state === "pending" && job.device_id === own)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  }

  function printerStatusFor(printer: Printer): PrinterStatus {
    const direct = printer.connection === "direct";
    const sample = troubled ? troubledPrinterStatus(clock()).find((status) => status.printer_id === (direct ? PRINTER_IDS.cellar : PRINTER_IDS.kitchen)) : undefined;
    return {
      printer_id: printer.id,
      observed_at: stamp(),
      boot_id: direct ? BOOT_IDS.pi : BOOT_IDS.server,
      status: sample?.status ?? { reachable: true, ready: true, media_detected: direct ? true : null, errors: [] },
      host: direct
        ? (sample?.host ?? {
            uptime_s: 4321,
            temperature_c: 49.8,
            throttled: false,
            undervoltage: null,
            storage_errors: 0,
            storage_read_only: false,
            overlay_used_pct: 8.1,
            memory_available_mb: 298,
          })
        : null,
    };
  }

  function rememberStatus(status: PrinterStatus): void {
    state.update((data) => ({
      ...data,
      printerStatus: [...data.printerStatus.filter((candidate) => candidate.printer_id !== status.printer_id), status],
    }));
  }

  /**
   * Ein Zustellversuch: Eigene ausstehende Etiketten eines erreichbaren Druckers werden
   * angenommen ("queued") und nach der Wartezeit gedruckt. Liefert, was der Versuch gebracht hat.
   */
  function deliver(): PrintFlushReport {
    const report: PrintFlushReport = { delivered: 0, pending: 0, problems: [] };
    const accepted: { job: PrintJob; printer: Printer }[] = [];
    const seen = new Set<string | null>();
    for (const job of ownPending()) {
      const printer = printerFor(job);
      if (printer && reachable(printer)) {
        accepted.push({ job, printer });
        continue;
      }
      report.pending += 1;
      const key = printer?.id ?? null;
      if (!seen.has(key)) {
        seen.add(key);
        report.problems.push(
          !printer ? { printer_id: null, problem: "no_printer", message: "Dem Etikett ist kein Drucker zugeordnet." } : { printer_id: printer.id, ...problemOf(printer) },
        );
      }
    }
    report.delivered = accepted.length;
    if (accepted.length === 0) {
      return report;
    }
    for (const printer of new Set(accepted.map((entry) => entry.printer))) {
      rememberStatus(printerStatusFor(printer));
    }
    for (const { job, printer } of accepted) {
      const bootId = printer.connection === "direct" ? BOOT_IDS.pi : BOOT_IDS.server;
      setJobState(job.id, "queued", null, { printer_id: printer.id, boot_id: bootId });
    }
    const outcome = printOutcome;
    later(() => {
      for (const { job } of accepted) {
        if (state.get().printJobs.find((candidate) => candidate.id === job.id)?.state !== "queued") {
          continue; // inzwischen verworfen
        }
        if (outcome === "printed") {
          setJobState(job.id, "printed");
        } else if (outcome === "failed") {
          setJobState(job.id, "failed", "no_media");
        } else {
          setJobState(job.id, "unknown", "interrupted");
        }
      }
      changed(accepted.length);
    }, 2);
    return report;
  }

  /** Stellt nach einer Änderung von selbst zu, so wie es der Kern tut. */
  function deliverSoon(): void {
    later(() => {
      deliver();
    });
  }

  /** Eine Bearbeitung, die eine entnommene Packung traf: aufheben statt anwenden (Sync-Protokoll 7.2). */
  function displace(pkg: Package, fresh: DisplacedChange[], at: string): Package {
    const kept = (pkg.displaced?.changes ?? []).filter((old) => !fresh.some((change) => change.field === old.field));
    return { ...pkg, displaced: { at, changes: [...kept, ...fresh] } };
  }

  /**
   * Was `sync.problems` zeigt: höchstens `MAX_SYNC_PROBLEMS`, und ein "displaced"-Eintrag nur,
   * solange seine Packung die verdrängte Bearbeitung noch trägt.
   */
  const visibleProblems = new LiveValue<SyncProblem[]>([]);
  function refreshProblems(): void {
    const packages = state.get().packages;
    const next = problems
      .get()
      .filter((problem) => {
        if (problem.status !== "displaced" || problem.command.type !== "package.update") {
          return true;
        }
        const packageId = problem.command.package_id;
        const pkg = packages.find((candidate) => candidate.id === packageId);
        return pkg !== undefined && pkg.removed_at !== null && pkg.displaced !== null;
      })
      .slice(0, MAX_SYNC_PROBLEMS);
    const current = visibleProblems.get();
    if (next.length !== current.length || next.some((problem, index) => problem !== current[index])) {
      visibleProblems.set(next);
    }
  }
  refreshProblems();
  problems.subscribe(refreshProblems);
  state.subscribe(refreshProblems);

  function previewImage(): Blob {
    const bytes = Uint8Array.from(atob(PREVIEW_PNG_BASE64), (char) => char.charCodeAt(0));
    return new Blob([bytes], { type: "image/png" });
  }

  // ---------------------------------------------------------------- Einkaufsliste

  function findItem(id: string): ShoppingItem {
    const item = state.get().shoppingItems.find((candidate) => candidate.id === id);
    if (!item) {
      throw new CoreError("not_found", "Den Eintrag gibt es nicht.");
    }
    return item;
  }

  /** Das Produkt nach einer Zusammenführung; undefined, wenn es keins (mehr) gibt. */
  function resolvedProduct(data: MockData, id: string): Product | undefined {
    let product = data.products.find((candidate) => candidate.id === id);
    for (let hops = 0; product?.merged_into && hops < 10; hops += 1) {
      const target = product.merged_into;
      product = data.products.find((candidate) => candidate.id === target);
    }
    return product && product.deleted_at === null ? product : undefined;
  }

  /** Hebt die Sperre eines Produkts auf, wenn sie nicht nach `at` liegt (7.6). */
  function unlock(productId: string, at: string): void {
    const lock = shoppingLocks.get(productId);
    if (lock !== undefined && lock <= at) {
      shoppingLocks.delete(productId);
    }
  }

  /** Der spätere zweier Zeitstempel. */
  function laterOf(a: string, b: string): string {
    return a > b ? a : b;
  }

  /**
   * Spielt nach, was der Server zu den vorgemerkten Befehlen selbst schreibt (7.6), in ihrer
   * Reihenfolge und auf dem Bestand von jetzt.
   */
  function runServerEffects(): void {
    if (serverEffects.length === 0) {
      return;
    }
    const queue = serverEffects.splice(0);
    state.update((data) => {
      const items = new Map(data.shoppingItems.map((item) => [item.id, item]));
      let touched = false;
      const put = (item: ShoppingItem) => {
        items.set(item.id, item);
        touched = true;
      };

      /** Abgleich eines Produkts zum Zeitpunkt `at` (7.6, Schritte 1 bis 3). */
      const reconcile = (productId: string, at: string) => {
        const product = resolvedProduct(data, productId);
        if (!product) {
          return;
        }
        const open = [...items.values()]
          .filter((item) => item.product_id === product.id && item.origin === "min_stock" && isOpenItem(item))
          .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
        const [kept, ...extra] = open;
        for (const item of extra) {
          put({ ...item, deleted_at: at, updated_at: laterOf(item.updated_at, at) });
        }
        const missing = missingStock(product, stockCount(data.packages, product.id));
        if (missing > 0 && kept) {
          if (kept.quantity !== missing) {
            put({ ...kept, quantity: missing, updated_at: laterOf(kept.updated_at, at) });
          }
        } else if (missing > 0 && !shoppingLocks.has(product.id)) {
          put({ id: newUuid(), product_id: product.id, text: "", quantity: missing, origin: "min_stock", done_at: null, deleted_at: null, created_at: at, updated_at: at });
        } else if (missing === 0 && kept) {
          put({ ...kept, deleted_at: at, updated_at: laterOf(kept.updated_at, at) });
        }
      };

      for (const effect of queue) {
        if (effect.kind === "merged") {
          const target = resolvedProduct(data, effect.target_id);
          if (!target) {
            continue;
          }
          const locks = [shoppingLocks.get(effect.source_id), shoppingLocks.get(target.id)].filter((lock): lock is string => lock !== undefined);
          shoppingLocks.delete(effect.source_id);
          if (locks.length > 0) {
            shoppingLocks.set(target.id, locks.reduce(laterOf));
          }
          reconcile(target.id, effect.at);
          continue;
        }
        const product = resolvedProduct(data, effect.product_id);
        if (!product) {
          continue;
        }
        if (effect.kind === "lock") {
          shoppingLocks.set(product.id, laterOf(shoppingLocks.get(product.id) ?? effect.at, effect.at));
        } else if (effect.kind === "unlock") {
          unlock(product.id, effect.at);
          reconcile(product.id, effect.at);
        } else if (effect.kind === "stored") {
          unlock(product.id, effect.at);
          // Eigene Einträge des Produkts, die seit dem Einlagern oder früher offen sind, sind erledigt.
          for (const item of [...items.values()]) {
            const openSince = doneClocks.get(item.id) ?? item.created_at;
            if (item.product_id === product.id && item.origin === "manual" && isOpenItem(item) && openSince <= effect.at) {
              put({ ...item, done_at: effect.at, updated_at: laterOf(item.updated_at, effect.at) });
              doneClocks.set(item.id, effect.at);
            }
          }
          reconcile(product.id, effect.at);
        } else {
          reconcile(product.id, effect.at);
        }
      }
      // Ohne neue Fassung bleibt alles, wie es ist: Die Live-Werte behalten ihre Referenz.
      return touched ? { ...data, shoppingItems: [...items.values()] } : data;
    });
  }

  /** Der Abgleich je betroffenem Produkt, jedes nur einmal. */
  function reconcileAll(productIds: Iterable<string>, at: string): ServerEffect[] {
    return [...new Set(productIds)].map((product_id) => ({ kind: "reconcile", product_id, at }));
  }

  // ---------------------------------------------------------------- Integrationen

  /**
   * Offene Einträge, die nach der Regel des Servers in Bring! stünden (docs/integrationen.md, 5.2):
   * mit Namen (Produkt mit Namen oder freier Text) und seit mindestens zwei Minuten offen.
   */
  function linkedItems(nowMs: number): number {
    const data = state.get();
    const limit = new Date(nowMs - BRING_DELAY_MS).toISOString();
    return data.shoppingItems.filter((item) => {
      if (!isOpenItem(item) || (doneClocks.get(item.id) ?? item.created_at) > limit) {
        return false;
      }
      return item.product_id === null ? item.text.trim() !== "" : (resolvedProduct(data, item.product_id)?.name.trim() ?? "") !== "";
    }).length;
  }

  /** Der Zustand von Home Assistant nach `haSetup` (siehe Kopf der Datei). */
  function haStatus(nowMs: number): HaStatus {
    const setup = haSetup;
    const off: HaStatus = { configured: false, problem: null, entity: null, state: "off", last_ok_at: null, last_error: null, last_error_at: null, linked: 0, sensor: false };
    if (setup === "off") {
      return off;
    }
    if (setup === "problem") {
      // Adresse und Liste stehen in der .env, der Token fehlt: kein Abgleich (5.1).
      return { ...off, problem: "STOWLY_HA_TOKEN fehlt.", entity: HA_ENTITY };
    }
    const at = (msAgo: number) => new Date(nowMs - msAgo).toISOString();
    const configured: HaStatus = { ...off, configured: true, entity: HA_ENTITY, state: setup, linked: linkedItems(nowMs), sensor: true };
    if (setup === "pending") {
      return configured;
    }
    if (setup === "ok") {
      return { ...configured, last_ok_at: at(60_000) };
    }
    // Vor drei Stunden ging es noch; der letzte Versuch vor einer Minute scheiterte.
    return { ...configured, last_ok_at: at(3 * 3_600_000), last_error: HA_ERRORS[setup], last_error_at: at(60_000) };
  }

  /** Die Zeitzone des Servers der Attrappe: die aus `setIntegrations`, wenn es eine gültige ist. */
  function serverTimezone(): string {
    const wanted = integrationChanges.timezone;
    if (wanted === undefined) {
      return SERVER_TIMEZONE;
    }
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: wanted });
      return wanted;
    } catch {
      return SERVER_TIMEZONE;
    }
  }

  function integrationStatus(): IntegrationStatus {
    const nowMs = clock().getTime();
    const at = (hoursAgo: number) => new Date(nowMs - hoursAgo * 3_600_000).toISOString();
    const iso = (ms: number) => new Date(ms).toISOString();
    // Wie beim Server: Tag und Uhrzeit des Laufs in seiner Zeitzone (docs/integrationen.md, 3.3).
    const fileOf = (ms: number) => `stowly-${serverDay(ms)}-${serverTime(ms).replace(":", "")}.sqlite3.gz.age`;
    /** Der Lauf um 03:30 (Zeit des Servers), der zuletzt war, `daysBack` Läufe zurück. */
    const pastRun = (daysBack: number) => {
      let run = backupRun(nowMs, -1);
      for (let day = 0; day < daysBack; day += 1) {
        run = backupRun(run - HALF_HOUR_MS, -1);
      }
      return run;
    };
    const recipients = ["age1ql3z…ac8p", "age1x7m2…9kqd"];
    let backup: BackupStatus;
    if (scenarios.has("backup-problem")) {
      backup = {
        configured: false,
        problem: "STOWLY_BACKUP_RECIPIENTS fehlt.",
        time: "03:30",
        recipients: [],
        last_ok_at: null,
        last_file: null,
        last_size: null,
        last_error: null,
        last_error_at: null,
        next_at: null,
        warning: false,
      };
    } else if (scenarios.has("backup-warning")) {
      // Vor drei Tagen gelungen, seither scheitert jeder Versuch; nach einem Fehler folgt der nächste eine Stunde später.
      const lastOk = pastRun(3);
      backup = {
        configured: true,
        problem: null,
        time: "03:30",
        recipients,
        last_ok_at: iso(lastOk),
        last_file: fileOf(lastOk),
        last_size: 48_213,
        last_error: "Der Ordner für Sicherungen ist nicht beschreibbar (Benutzer 10001).",
        last_error_at: at(1),
        next_at: at(0),
        warning: true,
      };
    } else {
      // Heute um 03:30 gelungen (oder gestern, wenn es noch früher ist); die nächste morgen um 03:30.
      const lastOk = pastRun(0);
      backup = {
        configured: true,
        problem: null,
        time: "03:30",
        recipients,
        last_ok_at: iso(lastOk),
        last_file: fileOf(lastOk),
        last_size: 51_874,
        last_error: null,
        last_error_at: null,
        next_at: iso(backupRun(lastOk + HALF_HOUR_MS, 1)),
        warning: false,
      };
    }
    const push = pushState.get();
    const configured = push !== "not_configured";
    return {
      timezone: SERVER_TIMEZONE,
      backup,
      ha: haStatus(nowMs),
      push: {
        configured,
        problem: null,
        // Ein anderes Gerät des Haushalts hat schon ein Abo.
        subscriptions: configured ? 1 + (push === "on" ? 1 : 0) : 0,
        this_device: push === "on",
        last_run_at: configured ? at(17) : null,
        last_sent_at: configured ? at(41) : null,
        last_error: null,
      },
      update: { ...updates },
      ...integrationChanges,
    };
  }

  /**
   * Der nachgespielte Updater nach einer Anforderung (siehe Kopf der Datei), nur mit Wartezeit:
   * Er beginnt, Stowly startet neu (der Server ist eine Weile nicht erreichbar), dann läuft die
   * neue Version. Hat sich der Zustand inzwischen anders entwickelt, tut er nichts mehr.
   */
  function simulateUpdater(version: string): void {
    if (latency <= 0) {
      return;
    }
    const still = (state: UpdateStatus["state"]) => updates.state === state && updates.state_version === version;
    later(() => {
      if (still("requested")) {
        updates = { ...updates, state: "installing", state_at: stamp(), state_message: null };
      }
    }, 8);
    later(() => {
      if (still("installing")) {
        core.control.setOnline(false);
      }
    }, 16);
    later(() => {
      if (still("installing")) {
        updates = { ...updates, current: version, available: false, state: "done", state_at: stamp() };
        syncStatus.update((status) => ({ ...status, server_version: version }));
        core.control.setOnline(true);
      }
    }, 40);
  }

  // ---------------------------------------------------------------- Einrichtung

  /** Meldet dieses Gerät an und gleicht ab, wie nach `session.login`. */
  function signIn(name: string): void {
    state.update((data) => ({
      ...data,
      devices: data.devices.map((device) => (device.current ? { ...device, name, last_seen_at: stamp() } : device)),
    }));
    session.set({ status: "signed_in", device: { id: DEVICE_IDS.current, name } });
    finishSync();
  }

  /** Der Stand der Einrichtung (Protokoll 11.6): `ready` aus Sicht des Servers. */
  function setupStatus(): SetupStatus {
    const ready: Record<SetupStepId, boolean> = {
      https: https.seen_at !== null,
      printer: hasPrinter(),
      updates: updates.configured,
      notifications: pushContact !== null,
    };
    // Wie der Server: nur nicht gelöschte Drucker, früheste Ablaufzeit zuerst.
    const printers = state.get().printers;
    const paired = [...piCertificates]
      .filter(([printerId]) => printers.some((printer) => printer.id === printerId && printer.deleted_at === null))
      .map(([printerId, pi]) => ({ printer_id: printerId, hostname: pi.hostname, not_after: pi.not_after }))
      .sort((a, b) => a.not_after.localeCompare(b.not_after));
    return {
      password_source: fromEnv ? "env" : "app",
      steps: [...setupSteps].map(([id, step]) => ({ id, state: step.state, ready: ready[id], changed_at: step.changed_at })),
      finished_at: setupFinishedAt,
      paired_printers: paired,
      https: { ...https, addresses: https.addresses.map((address) => ({ ...address })), origins: [...https.origins] },
    };
  }

  /** Die Einstellungen des Servers (Protokoll 11.7) mit ihrer Quelle. */
  function currentServerConfig(): ServerConfig {
    return {
      push: { contact: pushContact, source: pushContactSource },
      update: { enabled: updates.configured, repo: UPDATE_REPO, source: updateSource, available: !fromEnv },
    };
  }

  /** Eine Kopplung samt Ablauf der Frist; undefined, wenn es sie nicht gibt. */
  function currentPairing(id: string): PiPairing | undefined {
    const found = pairings.get(id);
    if (found && (found.state === "waiting" || found.state === "installing") && Date.parse(found.expires_at) <= clock().getTime()) {
      const expired: PiPairing = { ...found, state: "expired" };
      pairings.set(id, expired);
      return expired;
    }
    return found;
  }

  /** Die jüngste Kopplung, die noch auf den Pi wartet. */
  function latestWaiting(): PiPairing | undefined {
    return [...pairings.values()].reverse().find((pairing) => {
      const current = currentPairing(pairing.id);
      return current?.state === "waiting" || current?.state === "installing";
    });
  }

  const inThirtyMinutes = () => new Date(clock().getTime() + 1_800_000).toISOString();

  /** Der Pi meldet sich gleich nach dem Laden des Pakets: Er richtet sich ein. */
  function startPi(id: string): void {
    const pairing = currentPairing(id);
    if (pairing?.state === "waiting") {
      const pi = { hostname: MOCK_PI.hostname, addresses: [], model: null, printer_found: false, version: "0.3.0", not_after: null };
      pairings.set(id, { ...pairing, state: "installing", expires_at: inThirtyMinutes(), pi });
    }
  }

  /**
   * Der Pi ist fertig: Der Server legt den direkten Drucker an oder gibt dem gewählten die neue
   * Verbindung. Der Pi ist danach von hier aus erreichbar.
   */
  function completePi(id: string): void {
    const pairing = currentPairing(id);
    if (pairing?.state !== "waiting" && pairing?.state !== "installing") {
      return;
    }
    const now = stamp();
    const { hostname, address, model } = MOCK_PI;
    const direct = { urls: [`https://${address}:8443`, `https://${hostname}.local:8443`, `http://${address}:8080`], token: `pi-token-${hostname}`, printer: null };
    const printerId = pairing.printer_id ?? newUuid();
    state.update((data) => {
      const known = data.printers.some((printer) => printer.id === printerId);
      const printers: Printer[] = known
        ? data.printers.map((printer) => (printer.id === printerId ? { ...printer, direct, updated_at: now } : printer))
        : [...data.printers, { id: printerId, name: model, connection: "direct", server: null, direct, created_at: now, updated_at: now, deleted_at: null }];
      return { ...data, printers };
    });
    const notAfter = new Date(clock().getTime() + 825 * 86_400_000).toISOString();
    pairings.set(id, { ...pairing, state: "paired", printer_id: printerId, pi: { hostname, addresses: [address], model, printer_found: true, version: "0.3.0", not_after: notAfter } });
    piCertificates.set(printerId, { hostname, not_after: notAfter });
    piReachable = true;
  }

  /** Mit Wartezeit (im Browser) meldet sich der Pi nach einer Weile von selbst und koppelt. */
  function simulatePi(id: string): void {
    if (latency > 0) {
      later(() => startPi(id), 10);
      later(() => completePi(id), 25);
    }
  }

  // ---------------------------------------------------------------- Die Schnittstelle

  const core: MockCore = {
    session: {
      state: session,
      async login(password, deviceName) {
        await wait();
        requireOnline();
        const name = checkDeviceName(deviceName);
        if (syncStatus.get().server_configured === false) {
          throw new CoreError("not_configured", "Auf dem Server ist noch kein Haushalts-Passwort gesetzt.");
        }
        if (password !== householdPassword) {
          throw new CoreError("invalid_password", "Das Passwort stimmt nicht.");
        }
        signIn(name);
      },
      async createPassword(password, deviceName) {
        // Wie im Kern: Gerätename und Länge ohne Anfrage.
        const name = checkDeviceName(deviceName);
        checkNewPassword(password);
        await wait();
        requireOnline();
        if (syncStatus.get().server_configured !== false) {
          syncStatus.update((status) => ({ ...status, server_configured: true }));
          throw new CoreError("conflict", "Es gibt schon ein Haushalts-Passwort.");
        }
        householdPassword = password;
        syncStatus.update((status) => ({ ...status, server_configured: true }));
        signIn(name);
      },
      async changePassword(current, next) {
        checkNewPassword(next);
        await wait(0.5);
        requireOnline();
        if (fromEnv) {
          throw new CoreError("conflict", "Das Passwort kommt aus der Umgebung (STOWLY_PASSWORD) und lässt sich nur dort ändern.");
        }
        if (current !== householdPassword) {
          throw new CoreError("invalid_password", "Das bisherige Passwort stimmt nicht.");
        }
        householdPassword = next;
      },
      async logout(logoutOptions) {
        const pending = syncStatus.get().pending;
        if (pending > 0 && !logoutOptions?.discard_pending) {
          throw new CoreError("pending_changes", "Es gibt ungesendete Änderungen.", { pending });
        }
        syncStatus.update((status) => ({ ...status, pending: 0 }));
        unsentPrinterReports.clear();
        // Verworfene Befehle erreichen den Server nie: Er schreibt dazu auch nichts.
        serverEffects.length = 0;
        problems.set([]);
        // Mit dem Abmelden endet auch Push auf diesem Gerät.
        if (pushState.get() === "on") {
          pushState.set("off");
        }
        // Der Name bleibt als Vorschlag für die nächste Anmeldung.
        session.set({ status: "signed_out", reason: "logout", last_device_name: currentName() });
      },
    },

    sync: {
      status: syncStatus,
      problems: visibleProblems,
      async now() {
        syncStatus.update((status) => ({ ...status, phase: "syncing" }));
        await wait();
        if (syncStatus.get().online) {
          finishSync();
        } else {
          syncStatus.update((status) => ({
            ...status,
            phase: "error",
            last_error: { code: "offline", message: "Der Server ist nicht erreichbar.", at: stamp() },
          }));
        }
      },
      async dismissProblem(id) {
        problems.update((list) => list.filter((problem) => problem.id !== id));
      },
    },

    data: {
      products: derived(
        state,
        (data) => [data.products],
        (data) => data.products.filter((product) => product.deleted_at === null),
      ),
      packages: derived(
        state,
        (data) => [data.packages],
        (data) => data.packages.filter((pkg) => pkg.removed_at === null),
      ),
      removedPackages: derived(
        state,
        (data) => [data.packages, data.settings.trash_retention_days],
        (data) => {
          const limit = new Date(clock().getTime() - data.settings.trash_retention_days * 86_400_000).toISOString();
          return data.packages
            .filter((pkg) => pkg.removed_at !== null && pkg.removed_at >= limit)
            .sort((a, b) => (b.removed_at ?? "").localeCompare(a.removed_at ?? ""));
        },
      ),
      zones: derived(
        state,
        (data) => [data.zones],
        (data) => sortZones(data.zones.filter((zone) => zone.deleted_at === null)),
      ),
      settings: derived(
        state,
        (data) => [data.settings],
        (data) => data.settings,
      ),
      printers: derived(
        state,
        (data) => [data.printers],
        (data) => data.printers.filter((printer) => printer.deleted_at === null).sort((a, b) => a.name.localeCompare(b.name, "de")),
      ),
      printerStatus: derived(
        state,
        (data) => [data.printerStatus],
        (data) => data.printerStatus,
      ),
      printJobs: derived(
        state,
        (data) => [data.printJobs],
        (data) => [...data.printJobs].sort((a, b) => b.created_at.localeCompare(a.created_at)),
      ),
      shoppingItems: derived(
        state,
        (data) => [data.shoppingItems, data.settings.trash_retention_days],
        (data) => {
          // Erledigtes nur innerhalb der Aufbewahrungsdauer, wie entnommene Packungen.
          const limit = new Date(clock().getTime() - data.settings.trash_retention_days * 86_400_000).toISOString();
          return data.shoppingItems.filter((item) => item.deleted_at === null && (item.done_at === null || item.done_at >= limit)).sort(compareShoppingItems);
        },
      ),
      async findPackage(id) {
        return state.get().packages.find((pkg) => pkg.id === id);
      },
      async findProduct(id) {
        try {
          return activeProduct(id);
        } catch {
          return undefined;
        }
      },
      async findProductByBarcode(barcode) {
        return barcodeOwner(barcode);
      },
      imageUrl(image) {
        // Die Bilder der Attrappe liegen in der App selbst; alles andere zeigt wie im Kern auf den Server.
        return MOCK_IMAGES[image] ?? `/api/images/${encodeURIComponent(image)}`;
      },
    },

    stock: {
      async store(input: StoreInput): Promise<StoreResult> {
        checkStoreCount(input.count);
        checkBestBefore(input.best_before);
        const zone = activeZone(input.zone_id);
        const { product, created } = resolveProduct(input.product);
        const now = stamp();
        const packages: Package[] = [];
        for (let i = 0; i < input.count; i += 1) {
          let id = newPackageId();
          while (packages.some((pkg) => pkg.id === id)) {
            id = newPackageId();
          }
          packages.push({
            id,
            product_id: product.id,
            zone_id: zone.id,
            best_before: input.best_before,
            created_at: now,
            updated_at: now,
            removed_at: null,
            removal_reason: null,
            displaced: null,
          });
        }
        // Etiketten gibt es nur, wenn der Haushalt einen Drucker hat.
        const labels = (input.labels ?? prefs.get().print_labels) && hasPrinter();
        const jobs = labels ? packages.map((pkg) => buildJob({ package_id: pkg.id }, null)) : [];
        // Beim Server: ein neues Produkt mit Mindestbestand beginnt seine Einkaufsliste, das Einlagern
        // hebt die Sperre auf und erledigt eigene Einträge (7.6).
        const effects: ServerEffect[] = [
          ...(created && product.min_stock !== null ? reconcileAll([product.id], now) : []),
          { kind: "stored", product_id: product.id, at: now },
        ];
        mutate(
          (data) => ({
            ...data,
            products: created ? [...data.products, product] : data.products,
            packages: [...data.packages, ...packages],
            printJobs: [...data.printJobs, ...jobs],
          }),
          (created ? 1 : 0) + packages.length + jobs.length,
          effects,
        );
        const firstBarcode = product.barcodes[0];
        if (created && product.lookup === "pending" && firstBarcode) {
          simulateLookup(product.id, firstBarcode);
        }
        if (jobs.length > 0) {
          deliverSoon();
        }
        return { product, packages, print_jobs: jobs };
      },

      async remove(packageIds: string[], reason: RemovalReason) {
        const targets = existingPackages(packageIds);
        const now = stamp();
        // Nur was eben noch im Bestand war, ändert den Fehlbestand.
        const stocked = targets.filter((pkg) => pkg.removed_at === null).map((pkg) => pkg.product_id);
        mutate(
          (data) => ({
            ...data,
            packages: data.packages.map((pkg) =>
              packageIds.includes(pkg.id)
                ? { ...pkg, removed_at: pkg.removed_at ?? now, removal_reason: reason, updated_at: now }
                : pkg,
            ),
            // Ein Etikett, das noch aussteht, braucht eine entnommene Packung nicht mehr.
            printJobs: data.printJobs.map((job) =>
              job.state === "pending" && job.package_id !== null && packageIds.includes(job.package_id)
                ? { ...job, state: "cancelled", updated_at: now }
                : job,
            ),
          }),
          packageIds.length,
          reconcileAll(stocked, now),
        );
      },

      async restore(packageIds: string[], restoreOptions) {
        const targets = existingPackages(packageIds);
        const now = stamp();
        // Wiederhergestellt wird nur Entnommenes; übernimmt es ein anderes Produkt, zählt es bei beiden.
        const affected = targets
          .filter((pkg) => pkg.removed_at !== null)
          .flatMap((pkg) => {
            const moved = restoreOptions?.apply_displaced ? pkg.displaced?.changes.find((change) => change.field === "product_id")?.value : null;
            return moved ? [pkg.product_id, moved] : [pkg.product_id];
          });
        mutate(
          (data) => ({
            ...data,
            packages: data.packages.map((pkg) => {
              if (!packageIds.includes(pkg.id) || pkg.removed_at === null) {
                return pkg;
              }
              const restored: Package = { ...pkg, removed_at: null, removal_reason: null, displaced: null, updated_at: now };
              if (restoreOptions?.apply_displaced && pkg.displaced) {
                for (const change of pkg.displaced.changes) {
                  if (change.field === "best_before") {
                    restored.best_before = change.value;
                  } else if (change.value !== null) {
                    restored[change.field] = change.value;
                  }
                }
              }
              return restored;
            }),
          }),
          packageIds.length,
          reconcileAll(affected, now),
        );
      },

      async update(packageIds: string[], changes: PackageChanges) {
        const targets = existingPackages(packageIds);
        if ("best_before" in changes) {
          checkBestBefore(changes.best_before ?? null);
        }
        const zoneId = changes.zone_id === undefined ? undefined : activeZone(changes.zone_id).id;
        const productId = changes.product_id === undefined ? undefined : activeProduct(changes.product_id).id;
        const fresh: DisplacedChange[] = [];
        if ("best_before" in changes) {
          fresh.push({ field: "best_before", value: changes.best_before ?? null });
        }
        if (zoneId !== undefined) {
          fresh.push({ field: "zone_id", value: zoneId });
        }
        if (productId !== undefined) {
          fresh.push({ field: "product_id", value: productId });
        }
        if (fresh.length === 0) {
          return; // ohne Felder: ohne Wirkung
        }
        const now = stamp();
        // Wechselt eine Packung im Bestand das Produkt, zählt das bei beiden (7.6).
        const moved = productId === undefined ? [] : targets.filter((pkg) => pkg.removed_at === null && pkg.product_id !== productId).flatMap((pkg) => [pkg.product_id, productId]);
        mutate(
          (data) => ({
            ...data,
            packages: data.packages.map((pkg) => {
              if (!packageIds.includes(pkg.id)) {
                return pkg;
              }
              if (pkg.removed_at !== null) {
                // Löschen gewinnt: Die Bearbeitung wird aufgehoben, nicht angewendet.
                return displace(pkg, fresh, now);
              }
              return {
                ...pkg,
                best_before: "best_before" in changes ? (changes.best_before ?? null) : pkg.best_before,
                zone_id: zoneId ?? pkg.zone_id,
                product_id: productId ?? pkg.product_id,
                updated_at: now,
              };
            }),
          }),
          packageIds.length,
          reconcileAll(moved, now),
        );
        // Der echte Kern erfährt es erst beim Abgleich; die Attrappe trägt das Sync-Problem sofort ein.
        const displaced: SyncProblem[] = targets
          .filter((pkg) => pkg.removed_at !== null)
          .map((pkg) => ({
            id: newUuid(),
            at: now,
            status: "displaced",
            code: null,
            message: null,
            command: { id: newUuid(), at: now, type: "package.update", package_id: pkg.id, changes },
          }));
        if (displaced.length > 0) {
          problems.update((list) => [...displaced, ...list]);
        }
      },
    },

    products: {
      async create(input: NewProduct) {
        const { product } = resolveProduct({ kind: "new", ...input });
        // Mit Mindestbestand beginnt beim Server die Einkaufsliste des Produkts (7.6).
        mutate((data) => ({ ...data, products: [...data.products, product] }), 1, product.min_stock === null ? [] : reconcileAll([product.id], stamp()));
        return product;
      },
      async lookup(barcode: string): Promise<ProductLookup> {
        // Dieselbe Regel wie beim Nachschlagen im Hintergrund: gerade Endziffer = gefunden.
        const answer = (state: ProductLookup["state"], found: Partial<ProductLookup> = {}): ProductLookup => ({
          barcode,
          state,
          name: "",
          brand: "",
          quantity: "",
          image_id: null,
          ...found,
        });
        if (!isValidBarcode(barcode)) {
          return answer("failed");
        }
        if (isStoreInternalBarcode(barcode)) {
          return answer("skipped");
        }
        if (syncStatus.get().lookup_enabled === false) {
          return answer("disabled");
        }
        if (!syncStatus.get().online) {
          return answer("offline");
        }
        await wait(2);
        if (!syncStatus.get().online) {
          return answer("offline");
        }
        return Number(barcode.at(-1)) % 2 === 0
          ? answer("found", { name: `Beispielprodukt ${barcode.slice(-4)}`, brand: "Beispielmarke", quantity: "500 g", image_id: SAMPLE_IMAGE_ID })
          : answer("not_found");
      },
      async update(id: string, changes: ProductChanges) {
        const product = activeProduct(id);
        const name = changes.name === undefined ? undefined : requiredText(changes.name, LIMITS.product_name, "Das Produkt");
        const brand = changes.brand === undefined ? undefined : optionalText(changes.brand, LIMITS.brand, "Die Marke");
        const quantity = changes.quantity === undefined ? undefined : optionalText(changes.quantity, LIMITS.quantity, "Die Packungsgröße");
        checkWarnDays(changes.warn_days);
        checkMinStock(changes.min_stock);
        const now = stamp();
        // Ein geänderter Mindestbestand hebt beim Server die Sperre auf; dieselbe Zahl nicht (7.6).
        const minStockChanged = "min_stock" in changes && (changes.min_stock ?? null) !== product.min_stock;
        mutate(
          (data) => ({
            ...data,
            products: data.products.map((candidate) =>
              candidate.id === product.id
                ? {
                    ...candidate,
                    name: name ?? candidate.name,
                    brand: brand ?? candidate.brand,
                    quantity: quantity ?? candidate.quantity,
                    warn_days: "warn_days" in changes ? (changes.warn_days ?? null) : candidate.warn_days,
                    min_stock: "min_stock" in changes ? (changes.min_stock ?? null) : candidate.min_stock,
                    updated_at: now,
                  }
                : candidate,
            ),
          }),
          1,
          minStockChanged ? [{ kind: "unlock", product_id: product.id, at: now }] : [],
        );
      },
      async addBarcode(id: string, barcode: string) {
        const product = activeProduct(id);
        checkBarcode(barcode);
        const owner = barcodeOwner(barcode);
        if (owner && owner.id !== product.id) {
          throw new CoreError("barcode_taken", "Der Barcode gehört schon zu einem anderen Produkt.", { product_id: owner.id });
        }
        if (owner) {
          return;
        }
        checkBarcodeCount(product.barcodes.length + 1);
        mutate((data) => ({
          ...data,
          products: data.products.map((candidate) =>
            candidate.id === product.id
              ? { ...candidate, barcodes: [...candidate.barcodes, barcode].sort(), updated_at: stamp() }
              : candidate,
          ),
        }));
      },
      async removeBarcode(id: string, barcode: string) {
        const product = activeProduct(id);
        mutate((data) => ({
          ...data,
          products: data.products.map((candidate) =>
            candidate.id === product.id
              ? { ...candidate, barcodes: candidate.barcodes.filter((code) => code !== barcode), updated_at: stamp() }
              : candidate,
          ),
        }));
      },
      async merge(sourceId: string, targetId: string) {
        const source = activeProduct(sourceId);
        const target = activeProduct(targetId);
        if (source.id === target.id) {
          return;
        }
        const now = stamp();
        mutate(
          (data) => ({
            ...data,
            products: data.products.map((candidate) => {
              if (candidate.id === source.id) {
                return { ...candidate, barcodes: [], deleted_at: now, merged_into: target.id, updated_at: now };
              }
              if (candidate.id === target.id) {
                return {
                  ...candidate,
                  barcodes: [...new Set([...candidate.barcodes, ...source.barcodes])].sort(),
                  // Wie im Server (Protokoll 7.3): Ein leerer Mindestbestand des Ziels übernimmt den der Quelle.
                  min_stock: candidate.min_stock ?? source.min_stock,
                  updated_at: now,
                };
              }
              return candidate;
            }),
            packages: data.packages.map((pkg) => (pkg.product_id === source.id ? { ...pkg, product_id: target.id, updated_at: now } : pkg)),
            // Die Einträge der Einkaufsliste wandern mit, auch erledigte und gelöschte (7.3, Schritt 5).
            shoppingItems: data.shoppingItems.map((item) => (item.product_id === source.id ? { ...item, product_id: target.id, updated_at: now } : item)),
          }),
          1,
          [{ kind: "merged", source_id: source.id, target_id: target.id, at: now }],
        );
      },
    },

    zones: {
      async create(input: NewZone) {
        const name = requiredText(input.name, LIMITS.zone_name, "Die Zone");
        const icon = input.icon ?? "box";
        const color = input.color ?? null;
        checkZoneIcon(icon);
        checkZoneColor(color);
        if (input.printer_id) {
          activePrinter(input.printer_id);
        }
        const now = stamp();
        const zones = state.get().zones.filter((zone) => zone.deleted_at === null);
        const zone: Zone = {
          id: newUuid(),
          name,
          icon,
          color,
          sort: zones.reduce((highest, candidate) => Math.max(highest, candidate.sort), -1) + 1,
          printer_id: input.printer_id ?? null,
          created_at: now,
          updated_at: now,
          deleted_at: null,
          moved_to: null,
        };
        mutate((data) => ({ ...data, zones: [...data.zones, zone] }));
        return zone;
      },
      async update(id: string, changes: ZoneChanges) {
        const zone = activeZone(id);
        const name = changes.name === undefined ? undefined : requiredText(changes.name, LIMITS.zone_name, "Die Zone");
        if (changes.icon !== undefined) {
          checkZoneIcon(changes.icon);
        }
        if ("color" in changes) {
          checkZoneColor(changes.color ?? null);
        }
        if (changes.printer_id) {
          activePrinter(changes.printer_id);
        }
        mutate((data) => ({
          ...data,
          zones: data.zones.map((candidate) =>
            candidate.id === zone.id
              ? {
                  ...candidate,
                  name: name ?? candidate.name,
                  icon: changes.icon ?? candidate.icon,
                  color: "color" in changes ? (changes.color ?? null) : candidate.color,
                  sort: changes.sort ?? candidate.sort,
                  printer_id: "printer_id" in changes ? (changes.printer_id ?? null) : candidate.printer_id,
                  updated_at: stamp(),
                }
              : candidate,
          ),
        }));
      },
      async reorder(ids: string[]) {
        ids.forEach((id) => activeZone(id));
        mutate(
          (data) => ({
            ...data,
            zones: data.zones.map((zone) => {
              const position = ids.indexOf(zone.id);
              return position === -1 || position === zone.sort ? zone : { ...zone, sort: position, updated_at: stamp() };
            }),
          }),
          ids.length,
        );
      },
      async remove(id: string, moveTo: string) {
        const zone = activeZone(id);
        if (state.get().zones.filter((candidate) => candidate.deleted_at === null).length <= 1) {
          throw new CoreError("last_zone", "Die letzte Zone lässt sich nicht löschen.");
        }
        if (id === moveTo) {
          throw new CoreError("invalid", "Die Packungen müssen in eine andere Zone wandern.");
        }
        const target = activeZone(moveTo);
        const now = stamp();
        mutate((data) => ({
          ...data,
          zones: data.zones.map((candidate) =>
            candidate.id === zone.id ? { ...candidate, deleted_at: now, moved_to: target.id, updated_at: now } : candidate,
          ),
          packages: data.packages.map((pkg) => (pkg.zone_id === zone.id ? { ...pkg, zone_id: target.id, updated_at: now } : pkg)),
          settings:
            data.settings.primary_zone_id === zone.id
              ? { ...data.settings, primary_zone_id: target.id, updated_at: now }
              : data.settings,
        }));
        if (prefs.get().scan_zone_id === zone.id) {
          prefs.update((value) => ({ ...value, scan_zone_id: null }));
        }
      },
    },

    settings: {
      async update(changes: SettingsChanges) {
        if (changes.primary_zone_id) {
          activeZone(changes.primary_zone_id);
        }
        if (changes.default_printer_id) {
          activePrinter(changes.default_printer_id);
        }
        if (changes.warn_days !== undefined) {
          if (changes.warn_days === null) {
            throw new CoreError("invalid", "Die Vorlaufzeit des Haushalts darf nicht leer sein.");
          }
          checkWarnDays(changes.warn_days);
        }
        if (changes.trash_retention_days !== undefined) {
          checkRetentionDays(changes.trash_retention_days);
        }
        if (changes.notify_time !== undefined) {
          checkNotifyTime(changes.notify_time);
        }
        mutate((data) => ({ ...data, settings: { ...data.settings, ...changes, updated_at: stamp() } }));
      },
    },

    prefs: {
      value: prefs,
      async update(changes: Partial<DevicePrefs>) {
        prefs.update((value) => ({ ...value, ...changes }));
      },
    },

    printers: {
      async create(input: NewPrinter) {
        const name = requiredText(input.name, LIMITS.printer_name, "Der Drucker");
        if (input.connection === "server") {
          checkServerConfig(input.server);
        } else if (input.connection === "direct") {
          checkDirectConfig(input.direct);
        } else {
          throw new CoreError("invalid", "Unbekannte Art der Verbindung.");
        }
        const now = stamp();
        const printer: Printer = {
          id: newUuid(),
          name,
          connection: input.connection,
          server: input.connection === "server" ? input.server : null,
          direct: input.connection === "direct" ? input.direct : null,
          created_at: now,
          updated_at: now,
          deleted_at: null,
        };
        mutate((data) => ({ ...data, printers: [...data.printers, printer] }));
        return printer;
      },
      async update(id: string, changes: PrinterChanges) {
        const printer = activePrinter(id);
        const name = changes.name === undefined ? undefined : requiredText(changes.name, LIMITS.printer_name, "Der Drucker");
        if ((changes.server !== undefined && printer.connection !== "server") || (changes.direct !== undefined && printer.connection !== "direct")) {
          throw new CoreError("invalid", "Die Art der Verbindung lässt sich nicht ändern.");
        }
        if (changes.server !== undefined) {
          checkServerConfig(changes.server);
        }
        if (changes.direct !== undefined) {
          checkDirectConfig(changes.direct);
        }
        mutate((data) => ({
          ...data,
          printers: data.printers.map((candidate) =>
            candidate.id === printer.id
              ? {
                  ...candidate,
                  name: name ?? candidate.name,
                  server: changes.server ?? candidate.server,
                  direct: changes.direct ?? candidate.direct,
                  updated_at: stamp(),
                }
              : candidate,
          ),
        }));
      },
      async remove(id: string) {
        const printer = activePrinter(id);
        const now = stamp();
        mutate((data) => ({
          ...data,
          printers: data.printers.map((candidate) => (candidate.id === printer.id ? { ...candidate, deleted_at: now, updated_at: now } : candidate)),
          zones: data.zones.map((zone) => (zone.printer_id === printer.id ? { ...zone, printer_id: null, updated_at: now } : zone)),
          settings:
            data.settings.default_printer_id === printer.id
              ? { ...data.settings, default_printer_id: null, updated_at: now }
              : data.settings,
        }));
      },
      async probe(id: string): Promise<PrinterProbe> {
        const printer = activePrinter(id);
        await wait();
        if (!reachable(printer)) {
          const { problem, message } = problemOf(printer);
          // Wie im Kern: „unknown_printer" heißt, der Dienst antwortet, kennt den Drucker aber nicht.
          return { reachable: problem === "unknown_printer", url: null, health: null, problem, error: message };
        }
        const status = printerStatusFor(printer);
        rememberStatus(status);
        const health = sampleHealth(printer, status);
        // Ein direkter Drucker bringt seinen Zustand mit dem nächsten Abgleich zum Server
        // (`printer.report`). Wartet von ihm noch eine ungesendete Meldung, ersetzt die neue sie.
        if (printer.connection === "direct") {
          const replaces = unsentPrinterReports.has(printer.id);
          unsentPrinterReports.add(printer.id);
          changed(replaces ? 0 : 1);
        }
        deliverSoon();
        return { reachable: true, url: printer.direct?.urls[0] ?? null, health, problem: null, error: null };
      },
      // Einen Pi koppeln (Protokoll 11.8), nachgespielt; siehe Kopf der Datei.
      async pair(input) {
        await wait(0.5);
        requireOnline();
        let origin: URL | null = null;
        try {
          origin = new URL(input.origin);
        } catch {
          origin = null;
        }
        if (!origin || (origin.protocol !== "http:" && origin.protocol !== "https:") || origin.origin !== input.origin) {
          throw new CoreError("invalid", "Kein gültiger Ursprung.");
        }
        const printerId = input.printer_id ?? null;
        const chosen = state.get().printers.find((printer) => printer.id === printerId && printer.deleted_at === null);
        if (printerId !== null && chosen?.connection !== "direct") {
          throw new CoreError("invalid", "Übernehmen lässt sich nur ein vorhandener direkter Drucker.");
        }
        for (const older of pairings.values()) {
          if (older.state === "waiting" || older.state === "installing") {
            pairings.set(older.id, { ...older, state: "cancelled" });
          }
        }
        const letters = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
        const plain = Array.from({ length: 8 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
        const code = `${plain.slice(0, 4)}-${plain.slice(4)}`;
        const pairing: PiPairing = { id: newUuid(), state: "waiting", code: null, command: null, expires_at: inThirtyMinutes(), printer_id: printerId, pi: null };
        pairings.set(pairing.id, pairing);
        simulatePi(pairing.id);
        const http = origin.protocol === "http:" ? input.origin : `http://${origin.hostname}:${String(https.http_port ?? 8010)}`;
        return { ...pairing, code, command: `curl -fsSL ${http}/api/pi/install.sh | sudo sh -s -- ${code}` };
      },
      async pairing(id) {
        await wait(0.5);
        requireOnline();
        const found = currentPairing(id);
        if (!found) {
          throw new CoreError("not_found", "Die Kopplung gibt es nicht.");
        }
        return { ...found, pi: found.pi ? { ...found.pi, addresses: [...found.pi.addresses] } : null };
      },
      async cancelPairing(id) {
        await wait(0.5);
        requireOnline();
        const found = currentPairing(id);
        if (found && (found.state === "waiting" || found.state === "installing")) {
          pairings.set(id, { ...found, state: "cancelled" });
        }
      },
    },

    print: {
      async requestPackageLabels(packageIds: string[], requestOptions) {
        existingPackages(packageIds);
        requirePrinter();
        const printerId = requestOptions?.printer_id ? activePrinter(requestOptions.printer_id).id : null;
        const jobs = [...new Set(packageIds)].map((id) => buildJob({ package_id: id }, printerId));
        mutate((data) => ({ ...data, printJobs: [...data.printJobs, ...jobs] }), jobs.length);
        deliverSoon();
        return jobs;
      },
      async requestZoneLabel(zoneId: string, requestOptions) {
        const zone = activeZone(zoneId);
        requirePrinter();
        const printerId = requestOptions?.printer_id ? activePrinter(requestOptions.printer_id).id : null;
        const job = buildJob({ zone_id: zone.id }, printerId);
        mutate((data) => ({ ...data, printJobs: [...data.printJobs, job] }));
        deliverSoon();
        return job;
      },
      async retry(jobId: string) {
        const old = findJob(jobId);
        // Ein ausstehendes Etikett eines anderen Geräts übernehmen: das alte verwerfen, ein eigenes anlegen.
        const takeOver = old.state === "pending" && old.device_id !== ownDeviceId();
        if (!takeOver && !["failed", "unknown", "cancelled"].includes(old.state)) {
          throw new CoreError("invalid", "Nur fehlgeschlagene, unklare oder verworfene Etiketten lassen sich wiederholen.");
        }
        // Ein inzwischen gelöschter Drucker gilt als nicht gewählt.
        const stillThere = state.get().printers.some((printer) => printer.id === old.printer_id && printer.deleted_at === null);
        const job = buildJob(old.package_id ? { package_id: old.package_id } : { zone_id: old.zone_id ?? "" }, stillThere ? old.printer_id : null);
        if (takeOver) {
          setJobState(old.id, "cancelled");
        }
        mutate((data) => ({ ...data, printJobs: [...data.printJobs, job] }), takeOver ? 2 : 1);
        deliverSoon();
        return job;
      },
      async cancel(jobId: string) {
        const job = findJob(jobId);
        if (job.state !== "pending" && job.state !== "queued") {
          throw new CoreError("invalid", "Das Etikett ist nicht mehr ausstehend.");
        }
        setJobState(jobId, "cancelled");
        changed();
      },
      async resolveUnknown(jobId: string, printed: boolean) {
        const job = findJob(jobId);
        if (job.state !== "unknown") {
          throw new CoreError("invalid", "Bei diesem Etikett ist nichts offen.");
        }
        setJobState(jobId, printed ? "printed" : "failed", printed ? null : "not_printed");
        changed();
      },
      async flush() {
        const report = deliver();
        // Wie im Kern: erfüllt sich, sobald eingereicht ist; den Endzustand bringt das Nachfragen
        // danach (hier: `deliver` setzt ihn nach der doppelten Wartezeit), über `data.printJobs`.
        await wait();
        return report;
      },
      async preview(subject, previewOptions) {
        if (subject.kind === "package") {
          existingPackages([subject.package_id]);
        } else {
          activeZone(subject.zone_id);
        }
        if (previewOptions?.printer_id) {
          activePrinter(previewOptions.printer_id);
        }
        await wait();
        requireOnline();
        return previewImage();
      },
      async image(jobId: string) {
        const job = findJob(jobId);
        const printer = state.get().printers.find((candidate) => candidate.id === job.printer_id);
        if (printer?.server?.driver !== "image" || !["printed", "sent"].includes(job.state)) {
          throw new CoreError("not_found", "Zu diesem Etikett gibt es kein Bild.");
        }
        await wait();
        requireOnline();
        return previewImage();
      },
      async handoff(printerId: string) {
        const printer = activePrinter(printerId);
        if (printer.connection !== "direct" || !printer.direct) {
          throw new CoreError("invalid", "Die Seite des Druckdienstes gibt es nur bei einem direkten Drucker.");
        }
        const waiting = ownPending().filter((job) => printerFor(job)?.id === printer.id);
        // Eine Übergabe trägt eine Vorlage: nur Etiketten der Art des ältesten.
        const jobs = waiting.filter((job) => job.kind === waiting[0]?.kind).slice(0, MAX_HANDOFF_JOBS);
        if (jobs.length === 0) {
          throw new CoreError("not_found", "Für diesen Drucker steht kein eigenes Etikett aus.");
        }
        for (const job of jobs) {
          setJobState(job.id, "unknown", "handoff", { printer_id: printer.id });
        }
        changed(jobs.length);
        const base = printer.direct.urls.find((url) => url.startsWith("http://")) ?? printer.direct.urls[0] ?? "";
        const handed = state.get().printJobs.filter((job) => jobs.some((candidate) => candidate.id === job.id));
        // Die Attrappe hat keinen Druckdienst: Die Adresse zeigt nur, wie sie aussähe.
        return { url: `${base.replace(/\/+$/, "")}/p#attrappe-${jobs.length}`, jobs: handed };
      },
    },

    devices: {
      async list() {
        await wait(0.5);
        requireOnline();
        return state.get().devices;
      },
      async rename(id: string, name: string) {
        const wanted = checkDeviceName(name);
        await wait(0.5);
        requireOnline();
        let renamed: Device | undefined;
        state.update((data) => ({
          ...data,
          devices: data.devices.map((device) => {
            if (device.id !== id) {
              return device;
            }
            renamed = { ...device, name: wanted };
            return renamed;
          }),
        }));
        if (!renamed) {
          throw new CoreError("not_found", "Das Gerät gibt es nicht.");
        }
        const current = session.get();
        if (renamed.current && current.status === "signed_in") {
          session.set({ status: "signed_in", device: { ...current.device, name: renamed.name } });
        }
        return renamed;
      },
      async revoke(id: string) {
        await wait(0.5);
        requireOnline();
        const device = state.get().devices.find((candidate) => candidate.id === id);
        if (!device) {
          throw new CoreError("not_found", "Das Gerät gibt es nicht.");
        }
        state.update((data) => ({
          ...data,
          devices: data.devices.map((candidate) => (candidate.id === id ? { ...candidate, revoked_at: candidate.revoked_at ?? stamp() } : candidate)),
        }));
        if (device.current) {
          session.set({ status: "signed_out", reason: "revoked", last_device_name: device.name });
        }
      },
    },

    backup: {
      async download() {
        await wait();
        requireOnline();
        return {
          blob: new Blob(["Attrappe: Hier käme die Kopie der Datenbank.\n"], { type: "application/vnd.sqlite3" }),
          filename: `stowly-${today()}.sqlite3`,
        };
      },
    },

    app: {
      state: app,
      async applyUpdate() {
        // Der echte Kern lädt die App neu; die Attrappe räumt nur die Anzeige ab.
        app.update((value) => ({ ...value, update_ready: false, update_required: false }));
      },
      async promptInstall() {
        if (!app.get().can_install) {
          return false;
        }
        app.update((value) => ({ ...value, can_install: false, installed: true }));
        return true;
      },
      async requestPersistence() {
        app.update((value) => ({ ...value, storage_persistent: true }));
        return true;
      },
    },

    // Einkaufsliste (docs/sync-protokoll.md 3.6, 6.6 und 7.6): dieselben Prüfungen wie im Kern.
    shopping: {
      async create(input: NewShoppingItem) {
        if (input === null || typeof input !== "object") {
          throw invalidInput("Es fehlt die Angabe, was auf die Liste soll.");
        }
        const productId = input.product_id ?? null;
        const text = cleanText(input.text);
        if (productId !== null && text !== "") {
          throw invalidInput("Ein Eintrag hat ein Produkt oder einen Text, nicht beides.");
        }
        checkShoppingQuantity(input.quantity);
        const product = productId === null ? null : activeProduct(productId);
        const now = stamp();
        const item: ShoppingItem = {
          id: newUuid(),
          product_id: product?.id ?? null,
          text: product ? "" : checkShoppingText(input.text),
          quantity: input.quantity ?? null,
          origin: "manual",
          done_at: null,
          deleted_at: null,
          created_at: now,
          updated_at: now,
        };
        mutate((data) => ({ ...data, shoppingItems: [...data.shoppingItems, item] }));
        return item;
      },

      async update(id: string, changes: ShoppingItemChanges) {
        const item = findItem(id);
        if (item.deleted_at !== null) {
          throw new CoreError("not_found", "Der Eintrag ist gelöscht.");
        }
        if (changes === null || typeof changes !== "object") {
          throw invalidInput("Es fehlt die Angabe, was geändert werden soll.");
        }
        const wanted: ShoppingItemChanges = {};
        if (changes.text !== undefined) {
          if (item.product_id !== null) {
            throw invalidInput("Ein Eintrag mit Produkt trägt dessen Namen, keinen eigenen Text.");
          }
          wanted.text = checkShoppingText(changes.text);
        }
        if ("quantity" in changes) {
          if (item.origin === "min_stock") {
            throw invalidInput("Die Menge eines automatischen Eintrags führt der Server.");
          }
          checkShoppingQuantity(changes.quantity);
          wanted.quantity = changes.quantity ?? null;
        }
        if (changes.done !== undefined) {
          if (typeof changes.done !== "boolean") {
            throw invalidInput("Abhaken geht nur mit ja oder nein.");
          }
          // Abhaken eines erledigten Eintrags (oder Öffnen eines offenen) bleibt ohne Wirkung (Regel 7).
          if (changes.done !== (item.done_at !== null)) {
            wanted.done = changes.done;
          }
        }
        if (Object.keys(wanted).length === 0) {
          return;
        }
        const now = stamp();
        const effects: ServerEffect[] = [];
        if (wanted.done !== undefined) {
          doneClocks.set(item.id, now);
          if (item.origin === "min_stock" && item.product_id !== null) {
            // Abhaken sperrt das Produkt, Wiederöffnen hebt die Sperre auf (7.6).
            effects.push({ kind: wanted.done ? "lock" : "unlock", product_id: item.product_id, at: now });
          }
        }
        mutate(
          (data) => ({
            ...data,
            shoppingItems: data.shoppingItems.map((candidate) =>
              candidate.id === item.id
                ? {
                    ...candidate,
                    text: wanted.text ?? candidate.text,
                    quantity: "quantity" in wanted ? (wanted.quantity ?? null) : candidate.quantity,
                    done_at: wanted.done === undefined ? candidate.done_at : wanted.done ? now : null,
                    updated_at: now,
                  }
                : candidate,
            ),
          }),
          1,
          effects,
        );
      },

      async remove(id: string) {
        const item = findItem(id);
        if (item.deleted_at !== null) {
          return; // Löschen eines gelöschten bleibt ohne Wirkung (Regel 7).
        }
        const now = stamp();
        // Ein offener automatischer Eintrag sperrt wie das Abhaken; ein erledigter nicht mehr (7.6).
        const locks: ServerEffect[] = item.origin === "min_stock" && isOpenItem(item) && item.product_id !== null ? [{ kind: "lock", product_id: item.product_id, at: now }] : [];
        mutate(
          (data) => ({
            ...data,
            shoppingItems: data.shoppingItems.map((candidate) => (candidate.id === item.id ? { ...candidate, deleted_at: now, updated_at: now } : candidate)),
          }),
          1,
          locks,
        );
      },
    },

    // Push auf diesem Gerät (docs/integrationen.md, Abschnitt 4), nachgespielt.
    push: {
      state: pushState,
      async enable() {
        const current = pushState.get();
        if (current === "unsupported" || current === "ios_install") {
          throw new CoreError("not_supported", current === "ios_install" ? "Push geht auf dem iPhone erst, wenn Stowly auf dem Home-Bildschirm liegt." : "Dieser Browser kann hier kein Push.");
        }
        if (current === "not_configured") {
          throw new CoreError("not_configured", "Der Server ist nicht für Push eingerichtet.");
        }
        // Wie im Browser: Ist die Erlaubnis einmal verweigert, fragt er nicht mehr.
        const answer = current === "denied" ? "denied" : pushPermission;
        if (answer === "denied") {
          pushState.set("denied");
          return "denied";
        }
        if (answer === "default") {
          return pushState.get();
        }
        await wait();
        requireOnline();
        pushState.set("on");
        return "on";
      },
      async disable() {
        // Gelingt auch ohne Server: Der erfährt es beim nächsten Kontakt.
        if (pushState.get() === "on") {
          pushState.set("off");
        }
      },
      async test() {
        await wait();
        requireOnline();
        const current = pushState.get();
        if (current === "not_configured") {
          throw new CoreError("not_configured", "Der Server ist nicht für Push eingerichtet.");
        }
        if (current !== "on") {
          throw new CoreError("not_found", "Der Server kennt kein Abo dieses Geräts.");
        }
        const nowMs = clock().getTime();
        if (rateLimitNextTest) {
          // "push-rate-limited": als wäre eben eine Testnachricht hinausgegangen.
          rateLimitNextTest = false;
          lastPushTest = nowMs - RECENT_PUSH_TEST_MS;
        }
        if (lastPushTest !== null && nowMs - lastPushTest < PUSH_TEST_INTERVAL_S * 1000) {
          const retryAfter = Math.max(1, Math.ceil((lastPushTest + PUSH_TEST_INTERVAL_S * 1000 - nowMs) / 1000));
          throw new CoreError("rate_limited", "Zu viele Testnachrichten.", { retry_after_s: retryAfter });
        }
        lastPushTest = nowMs;
        const result = PUSH_TEST_RESULTS[pushTestStatus];
        if (result.status === "gone") {
          // Der Server hat das Abo gelöscht.
          pushState.set("off");
        }
        return { ...result };
      },
    },

    // Statistik (docs/sync-protokoll.md, 11.1; src/mock/stats.ts): braucht den Server.
    stats: {
      async load(range?: StatsRange) {
        await wait(0.5);
        requireOnline();
        const data = state.get();
        return computeStats({
          packages: data.packages,
          products: data.products,
          zones: sortZones(data.zones.filter((zone) => zone.deleted_at === null)),
          range: range ?? {},
          timezone: serverTimezone(),
          now: clock(),
          since: statsSince,
        });
      },
    },

    integrations: {
      async load() {
        await wait(0.5);
        requireOnline();
        return integrationStatus();
      },
    },

    // Updates über GitHub (docs/integrationen.md, 10.2 und 10.5), nachgespielt: braucht den Server.
    update: {
      async check() {
        await wait(0.5);
        requireOnline();
        if (!updates.configured) {
          throw new CoreError("not_configured", UPDATE_NOT_CONFIGURED);
        }
        const nowMs = clock().getTime();
        if (lastUpdateCheck !== null && nowMs - lastUpdateCheck < UPDATE_CHECK_MIN_GAP_S * 1000) {
          const retryAfter = Math.max(1, Math.ceil((lastUpdateCheck + UPDATE_CHECK_MIN_GAP_S * 1000 - nowMs) / 1000));
          throw new CoreError("rate_limited", "Nach Updates suchen geht höchstens einmal je Minute.", { retry_after_s: retryAfter });
        }
        lastUpdateCheck = nowMs;
        // GitHub kennt nichts Neueres, als der Server schon gesehen hat.
        updates = { ...updates, checked_at: stamp(), check_error: null };
        return { ...updates };
      },
      async install(version) {
        await wait(0.5);
        requireOnline();
        // Wie der Server: zuerst die Form der Anfrage, dann die Prüfungen der Reihe nach.
        if (typeof version !== "string" || version.length > 40 || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
          throw new CoreError("invalid", "Die Anfrage entspricht nicht dem Vertrag.");
        }
        if (!updates.configured) {
          throw new CoreError("not_configured", UPDATE_NOT_CONFIGURED);
        }
        if (!updates.updater_ready) {
          throw new CoreError("not_configured", UPDATER_SILENT);
        }
        if (updates.state === "requested" || updates.state === "installing") {
          throw new CoreError("conflict", "Ein Update ist schon angefordert.");
        }
        if (version !== updates.latest) {
          throw new CoreError("conflict", "Das ist nicht die neueste bekannte Version. Bitte erst nach Updates suchen.");
        }
        if (!updates.available) {
          throw new CoreError("conflict", "Diese Version ist schon installiert.");
        }
        updates = { ...updates, state: "requested", state_version: version, state_at: stamp(), state_message: null };
        simulateUpdater(version);
        return { ...updates };
      },
    },

    // Einrichtung (docs/sync-protokoll.md, 11.6), nachgespielt: braucht den Server.
    setup: {
      async load() {
        await wait(0.5);
        requireOnline();
        return setupStatus();
      },
      async update(changes) {
        await wait(0.5);
        requireOnline();
        const addresses = changes.addresses;
        const outside = addresses?.findIndex((address) => !HOME_ADDRESS.test(address)) ?? -1;
        if (addresses && outside !== -1) {
          const msg = "Die Adresse liegt nicht im Heimnetz.";
          throw new CoreError("invalid", msg, { errors: [{ loc: ["body", "addresses", outside], msg, type: "value_error" }] });
        }
        const at = stamp();
        if (changes.step) {
          setupSteps.set(changes.step.id, { state: changes.step.state, changed_at: at });
        }
        if (changes.finished !== undefined) {
          setupFinishedAt = changes.finished ? at : null;
        }
        if (changes.https_port !== undefined || addresses) {
          const port = changes.https_port === undefined ? https.port : (changes.https_port ?? 8443);
          const learned = https.addresses.filter((address) => address.source === "learned");
          const all = addresses
            ? [...learned, ...addresses.filter((address) => !learned.some((known) => known.address === address)).map((address) => ({ address, source: "manual" as const, in_certificate: true }))]
            : https.addresses;
          https = {
            ...https,
            port,
            port_source: changes.https_port === undefined ? https.port_source : changes.https_port === null ? "default" : "manual",
            addresses: all,
            origins: https.enabled ? all.map((address) => `https://${address.address}:${String(port)}`) : [],
          };
        }
        return setupStatus();
      },
      async reachesSecurely() {
        await wait();
        return secureTrusted && https.listening;
      },
    },

    // Einstellungen des Servers (docs/integrationen.md, Abschnitt 12), nachgespielt: braucht den Server.
    serverConfig: {
      async load() {
        await wait(0.5);
        requireOnline();
        return currentServerConfig();
      },
      async update(changes) {
        // Wie im Kern: den Kontakt vorher prüfen; eine Adresse ohne mailto: bekommt es davor.
        const contact = typeof changes.push_contact === "string" ? checkPushContact(changes.push_contact) : changes.push_contact;
        await wait(0.5);
        requireOnline();
        if (contact !== undefined && pushContactSource === "env") {
          throw new CoreError("conflict", "Der Kontakt kommt aus der Umgebung (STOWLY_PUSH_CONTACT).");
        }
        if (changes.update_enabled !== undefined && updateSource === "env") {
          throw new CoreError("conflict", "Updates sind über STOWLY_UPDATE_REPO fest eingeschaltet.");
        }
        if (contact !== undefined) {
          pushContact = contact;
          pushContactSource = contact === null ? "default" : "app";
          // Wie `push.serverChanged()` im Kern: Der Zustand folgt dem Kontakt.
          const current = pushState.get();
          if (contact === null && (current === "off" || current === "on" || current === "denied")) {
            pushState.set("not_configured");
          } else if (contact !== null && current === "not_configured") {
            pushState.set("off");
          }
        }
        if (changes.update_enabled !== undefined) {
          updateSource = "app";
          updates = { ...updates, configured: changes.update_enabled, repo: changes.update_enabled ? UPDATE_REPO : null };
        }
        return currentServerConfig();
      },
    },

    control: {
      setOnline(online: boolean) {
        syncStatus.update((status) => ({
          ...status,
          online,
          phase: online ? "idle" : "error",
          last_error: online ? null : { code: "offline", message: "Der Server ist nicht erreichbar.", at: stamp() },
        }));
        if (online && syncStatus.get().pending > 0) {
          syncScheduled = false;
          changed(0);
        }
        if (online) {
          deliverSoon();
        }
      },
      revoke() {
        session.set({ status: "signed_out", reason: "revoked", last_device_name: currentName() });
      },
      setUpdateReady(ready: boolean) {
        app.update((value) => ({ ...value, update_ready: ready }));
      },
      addProblem(problem: SyncProblem) {
        problems.update((list) => [problem, ...list]);
      },
      setPiReachable(next: boolean) {
        piReachable = next;
        if (next) {
          deliverSoon();
        }
      },
      setPiProblem(problem: PrinterProblem | null) {
        piProblem = problem;
        if (problem === null && piReachable) {
          deliverSoon();
        }
      },
      setPrintOutcome(outcome: MockPrintOutcome) {
        printOutcome = outcome;
      },
      setLookupEnabled(enabled: boolean) {
        syncStatus.update((status) => ({ ...status, lookup_enabled: enabled }));
      },
      setPushState(next: PushState) {
        pushState.set(next);
        // Ohne Kontakt ist Push „nicht eingerichtet"; mit einem anderen Zustand gibt es einen.
        if (next === "not_configured") {
          pushContact = null;
          pushContactSource = "default";
        } else if (pushContact === null) {
          pushContact = "mailto:haushalt@example.org";
          pushContactSource = "app";
        }
      },
      setPushPermission(permission: MockPushPermission) {
        pushPermission = permission;
      },
      setPushTestResult(status: PushTestStatus) {
        pushTestStatus = status;
      },
      setIntegrations(changes: Partial<IntegrationStatus> | null) {
        if (changes === null) {
          integrationChanges = {};
          haSetup = initialHa;
          updates = initialUpdates();
          updateSource = fromEnv ? "env" : updates.configured ? "app" : "default";
          lastUpdateCheck = null;
          return;
        }
        // Updates sind ein Zustand, mit dem `update.check` und `update.install` weiterarbeiten.
        const { update, ...rest } = changes;
        if (update !== undefined) {
          updates = { ...update };
        }
        integrationChanges = { ...integrationChanges, ...rest };
      },
      setHaState(next: HaState) {
        haSetup = next;
        const { ha: _replaced, ...rest } = integrationChanges;
        integrationChanges = rest;
      },
      setSecureTrusted(trusted: boolean) {
        secureTrusted = trusted;
      },
      setServerConfigured(configured: boolean) {
        syncStatus.update((status) => ({ ...status, server_configured: configured }));
      },
      completePairing(id?: string) {
        const target = id ?? latestWaiting()?.id;
        if (target !== undefined) {
          completePi(target);
        }
      },
      expirePairing(id?: string) {
        const target = currentPairing(id ?? latestWaiting()?.id ?? "");
        if (target && (target.state === "waiting" || target.state === "installing")) {
          pairings.set(target.id, { ...target, state: "expired", expires_at: new Date(clock().getTime() - 1).toISOString() });
        }
      },
      snapshot() {
        return state.get();
      },
    },
  };

  return core;
}

function sampleHealth(printer: Printer, status: PrinterStatus): ServiceHealth {
  const direct = printer.connection === "direct";
  return {
    app: "stowly-print",
    version: "0.1.0",
    protocol: 1,
    boot_id: status.boot_id ?? "",
    uptime_s: 4321,
    proof: null,
    host: status.host,
    printers: [
      {
        // Am Server heißt ein Drucker im Druckdienst wie seine Kennung, am Pi trägt er einen eigenen Namen.
        name: direct ? (printer.direct?.printer ?? "ql800") : printer.id,
        driver: direct ? "brother_ql" : (printer.server?.driver ?? "image"),
        model: direct ? "QL-800" : (printer.server?.model ?? null),
        capabilities: {
          dpi: 300,
          media: { width_mm: 62, length_mm: null, printable_px: 696 },
          cutter: true,
          colors: ["black"],
          status_query: direct,
          confirms_print: direct,
        },
        status: status.status ?? { reachable: true, ready: true, media_detected: null, errors: [] },
      },
    ],
  };
}

/**
 * Sperren der automatischen Einträge, abgeleitet aus den Daten (siehe Kopf der Datei): Ein Produkt,
 * dessen zuletzt abgehakter automatischer Eintrag nach dem letzten Einlagern abgehakt wurde und das
 * keinen offenen hat, ist gesperrt, und zwar seit diesem Abhaken. Gelöschte Einträge zählen nicht:
 * Ob sie offen oder erledigt gelöscht wurden, steht nicht in ihnen.
 */
function initialLocks(data: MockData): Map<string, string> {
  const locks = new Map<string, string>();
  for (const product of data.products) {
    const autos = data.shoppingItems.filter((item) => item.product_id === product.id && item.origin === "min_stock" && item.deleted_at === null);
    if (product.deleted_at !== null || autos.some((item) => item.done_at === null)) {
      continue;
    }
    const lastDone = autos
      .map((item) => item.done_at)
      .filter((at): at is string => at !== null)
      .sort()
      .at(-1);
    const lastStored = data.packages
      .filter((pkg) => pkg.product_id === product.id)
      .map((pkg) => pkg.created_at)
      .sort()
      .at(-1);
    if (lastDone !== undefined && (lastStored === undefined || lastStored <= lastDone)) {
      locks.set(product.id, lastDone);
    }
  }
  return locks;
}

function sampleProblems(data: MockData, at: string): SyncProblem[] {
  const active = data.packages.filter((pkg) => pkg.removed_at === null);
  // Die entnommene Packung, die wirklich eine verdrängte Bearbeitung trägt.
  const removed = data.packages.find((pkg) => pkg.removed_at !== null && pkg.displaced !== null);
  const first = active[0];
  const result: SyncProblem[] = [];
  if (first) {
    result.push({
      id: newUuid(),
      at,
      status: "rejected",
      code: "id_conflict",
      message: "Die Packungs-ID ist schon vergeben.",
      command: {
        id: newUuid(),
        at,
        type: "package.create",
        package_id: first.id,
        product_id: first.product_id,
        zone_id: first.zone_id,
        best_before: addDays(toLocalDate(new Date(at)), 90),
      },
    });
  }
  if (removed) {
    result.push({
      id: newUuid(),
      at,
      status: "displaced",
      code: null,
      message: null,
      command: {
        id: newUuid(),
        at,
        type: "package.update",
        package_id: removed.id,
        changes: { best_before: addDays(toLocalDate(new Date(at)), 40) },
      },
    });
  }
  return result;
}
