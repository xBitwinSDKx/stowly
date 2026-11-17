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
 * Was der Server an der Einkaufsliste selbst schreibt (7.6: automatische Einträge, Sperre,
 * Erledigen durch Einlagern, Zusammenlegen), steht eigens in fake-shopping.ts und läuft im
 * Sicherungspunkt des auslösenden Befehls. Es besteht dieselben Fälle wie der Server
 * (docs/vectors.json, `shopping_auto`; fake-shopping.test.ts). `closed_by` führt sie nur intern.
 *
 * Wo die Nachbildung vom echten Server (server/stowly/sync) abweicht:
 * - Keine Uhren je Feld (7.1) und keine Uhr für Entnehmen/Wiederherstellen (7.2): Es gewinnt,
 *   was zuletzt eintrifft, nicht was zuletzt geschah. Nur die Meldungen zu Druckern und
 *   Etiketten vergleichen ihren Zeitpunkt, und für 7.6 die Sperre und das Feld `done` eines
 *   Eintrags der Einkaufsliste. Konflikte zwischen Geräten lassen sich hier sonst nicht prüfen;
 *   auch „Mindestbestand angewendet und geändert" (7.6) heißt hier nur „geändert".
 * - Ein Schritt der Änderungsfolge je Befehl: Alles, was er anfasst, teilt sich einen `rev`.
 *   Der echte Server gibt jedem Datensatz seinen eigenen; nur Packungen, die ein Befehl
 *   gemeinsam verschiebt, teilen sich einen. Ein Befehl ohne Wirkung liefert hier nichts
 *   zurück, der echte Server liefert den Datensatz trotzdem mit (Echo).
 * - `print.request` prüft den genannten Drucker nicht; der echte Server lehnt einen Drucker,
 *   den es nie gab, mit `not_found` ab.
 * - Ein schon bekannter Befehl (`duplicate`) zählt nicht als Untergrenze der wirksamen
 *   Zeitpunkte (Abschnitt 4); es fehlt auch die Schranke für ein unmögliches Alter.
 * - Open Food Facts wird nachgespielt: was der Test in `offProducts` einträgt, sonst gerade
 *   Endziffer des Barcodes = gefunden, nach `lookupDelayMs`. `product.add_barcode` und ein
 *   Zusammenführen setzen `lookup` nicht auf `pending`. Bilder gibt es nur, wenn der Test sie in
 *   `images` einträgt (ein kleines PNG), sonst 404. Mit `lookupEnabled: false` meldet jede Antwort
 *   `lookup_enabled: false`, und neue Produkte beginnen mit `lookup: "none"`.
 *   `GET /api/lookup/{barcode}` antwortet nach derselben Regel sofort (nie `pending`) und merkt sich
 *   nichts; der echte Server legt das Ergebnis ab und füllt damit später das Produkt. Der Neuabruf
 *   (`POST …/refresh`, seit 0.5.0) merkt sich sein Ergebnis und bremst je Barcode eine Minute nach
 *   der Uhr des Servers; die Bremse nach 429 und die Grenze je Minute gibt es hier nicht.
 * - Etiketten gestalten (`/api/labels/…`, seit 0.5.0): Katalog und Vorlagen aus fake-labels.ts.
 *   Die Vorlagen nennen Format, Papier und Drehung wie beim Server, haben aber keine Elemente; die
 *   Prüfung kennt nur die Form und eine grobe Regel für „zu kurz"; die Vorschau ist ein weißes Feld
 *   in der Größe des Papiers. Höchstens zwei Vorschauen zugleich prüft sie nicht (sie antwortet
 *   ohnehin der Reihe nach).
 * - `last_seen_at` rückt bei jedem Abgleich vor, im echten Server höchstens einmal je Minute.
 * - Es gibt kein Ereignisprotokoll und keine Grenze für die Größe einer Anfrage; die Klartexte
 *   der Meldungen sind eigene, und `details.errors` ist bei 422 meist leer.
 * - Der Druckdienst unter `/print` ist ebenfalls nachgebaut (fake-print.ts; dort steht, was er
 *   nicht kann). Was er am Etikett und am Zustand des Druckers fortschreibt, überschreibt hier
 *   einfach; der echte Server lässt die jüngste Meldung gewinnen.
 * - Längen von Texten zählen hier in UTF-16-Einheiten, im Server in Zeichen.
 * - Push (`/api/push/…`): Der öffentliche Schlüssel ist eine feste Zeichenfolge in der richtigen
 *   Form, aber kein Punkt auf der Kurve; beim Anlegen eines Abos prüft die Nachbildung Form und
 *   Längen, nicht, ob `keys.p256dh` auf der Kurve liegt. Eine Testnachricht geht nirgends hin: Die
 *   Nachbildung merkt sich die Nutzlast (`pushMessages`) und antwortet, was `pushTestStatus` sagt.
 *   Die Tagesnachricht gibt es nicht.
 * - `GET /api/integrations`: Push zählt die Abos der Nachbildung. Den Zustand von Home Assistant
 *   gibt der Test vor (`haStatus`, Vorgabe „aus"), samt `linked`: Einen Abgleich mit Bring! gibt
 *   es hier nicht, `bring_key` auch nicht. Eine Änderung der Verbindung in der App setzt ihn auf
 *   „pending" (der erste Abgleich steht aus); weiter schaltet ihn nur der Test.
 * - Sicherung (Stufe B): Es wird nichts verschlüsselt. Eine Sicherung der Nachbildung ist ein paar
 *   Bytes: der Kopf von age, je öffentlichem Schlüssel eine Zeile `-> stowly-fake age1…` und ein
 *   Verweis auf den festgehaltenen Stand im Arbeitsspeicher (`backupBytes`). Zum Prüfen errechnet
 *   die Nachbildung aus dem geheimen Schlüssel den öffentlichen und sucht ihn in diesen Zeilen;
 *   eine fremde Datei ist „damaged". Es gibt keine Uhrzeit für den nächsten Lauf (`next_at`) und
 *   keinen täglichen Lauf, nur „Jetzt sichern".
 * - Zurückspielen (Stufe B): Der Neustart ist sofort vorbei; `restartPolls` lässt `GET /api/restore`
 *   (laufender Stowly) bzw. `/api/health` (erster Start) noch so oft den alten Stand melden. Was
 *   der laufende Stowly behält, ist hier: Geräte, Passwort und alle Einstellungen des Servers.
 *   Kennungen neuerer Pakete werden nicht reserviert.
 * - Home Assistant (Stufe B): Es gibt kein HA. „Verbindung prüfen" liefert `haCheckResult`
 *   (ohne Token: "token_needed"); die Prüfungen stehen in `haChecks`.
 * - Updates (`/api/update/…`, docs/integrationen.md 10): Vorgabe „nicht eingerichtet"
 *   (`updateRepo` null). Statt GitHub zu fragen, nimmt die Nachbildung `githubRelease` (oder
 *   scheitert mit `githubError`); den Updater auf dem Rechner spielt der Test über
 *   `updaterSeenAt`, `updaterState` und `updateRequest` nach, die Dateien in `/data/update`.
 *   `current` ist `updateCurrent` (Vorgabe 0.1.0), nicht `FAKE_VERSION`. Es gibt keine
 *   planmäßige Abfrage (nur `checkGithub()`) und keinen Push zu einer neuen Version; die Sperre
 *   von `UPDATE_CHECK_MIN_GAP_S` gilt nur zwischen zwei Abfragen auf Knopfdruck.
 * - `GET /api/stats` (fake-stats.ts) rechnet die Monate in `timezone` der Nachbildung (Vorgabe
 *   Europe/Berlin) über `Intl`, nicht über `zoneinfo`; Namen vergleicht sie annähernd wie
 *   `str.casefold()`. Die Sätze bei 400 sind die des Servers (Stand Runde 2).
 * - `GET /api/ha/summary` gibt es nicht: Der Kern ruft den Sensor nie. Die Nachbildung antwortet
 *   darauf wie auf jeden unbekannten Aufruf (ohne Geräte-Token 401, sonst 501).
 * - Einrichtung (11.6 bis 11.8): Das erste Passwort prüft keine Kopfzeile `Host`, und gelernt wird
 *   keine Adresse; HTTPS gibt der Test vor (`https`, Vorgabe: Listener läuft, eine Adresse im
 *   Heimnetz, eine CA), `ready` von `https` heißt `https.seen_at` gesetzt. Die CA zum
 *   Herunterladen sind ein paar Bytes, kein Zertifikat. Den Pi spielt der Test über
 *   `startPairing`, `completePairing` und `expirePairing`; die Aufrufe des Pi selbst
 *   (`/api/pi/pair…`, Startskript, Paket) gibt es nicht. Ein gekoppelter Pi wird ein direkter
 *   Drucker wie beim Server, aber ohne Uhr je Feld.
 * - Updates schaltet ohne `updateRepo` (STOWLY_UPDATE_REPO) der Schalter der App (`updateSwitch`)
 *   mit `updateRepoDefault` ein; Push hängt am Kontakt (`pushContact`, Vorgabe aus der Umgebung).
 * - KI-Vorschläge (seit 0.6.0, `/api/server-config/ai…` und `/api/cook/ideas…`): Es gibt kein
 *   Anthropic. „Prüfen" liefert `aiCheckState`; ein Auftrag bleibt `cookRunningPolls` Abfragen lang
 *   "running" und endet dann mit `cookOutcome` (Vorgabe: ein Vorschlag aus den ersten Produkten des
 *   Bestands) oder mit `cookProblem`. Die Bremsen sind die des Servers (ein Auftrag zugleich, 30 s je
 *   Gerät, `FAKE_AI_DAILY_MAX` am Tag in `timezone`, die Prüfung mit 3 s Abstand), die Gutschrift für
 *   Fehler, die Anthropic nicht berechnet, auch. Eine Prüfung oder ein Auftrag „läuft" hier nie über
 *   die Antwort hinaus, also gibt es kein 429 für eine gleichzeitige Prüfung, und Aufträge laufen nicht
 *   ab (kein `COOK_JOB_TTL_S`, nur `expireCookJobs()`). Der Zähler liegt im Arbeitsspeicher; einen
 *   Neustart gibt es hier nicht. Die Form des Schlüssels prüft die Nachbildung wie der Server, die
 *   Sätze bei 422 sind eigene.
 *
 * Ohne DOM und ohne Node: Die Datei läuft in den Tests (jsdom) und im Entwicklungsserver.
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { bech32 } from "@scure/base";

import {
  AI_DEVICE_GAP_S,
  COMMAND_TYPES,
  ID_POOL_TARGET,
  LIMITS,
  MAX_CHANGES_PER_SYNC,
  MAX_COMMANDS_PER_SYNC,
  PROTOCOL_VERSION,
  PUSH_PATHS,
  PUSH_TEST_INTERVAL_S,
  UPDATE_CHECK_MIN_GAP_S,
  type AiCheckState,
  type AiConfig,
  type AiModel,
  type BackupConfig,
  type BackupFile,
  type BackupStatus,
  type Changes,
  type Command,
  type CommandResult,
  type ConfigSource,
  type CookFailure,
  type CookIdeas,
  type CookJob,
  type CookProblem,
  type Device,
  type ErrorBody,
  type ErrorCode,
  type HaCheck,
  type HaConfig,
  type HaConfigChanges,
  type HaStatus,
  type HouseholdSettings,
  type HttpsStatus,
  type IntegrationStatus,
  type LabelDesign,
  type LabelDesignState,
  type LabelLayout,
  type LabelPaper,
  type LabelPreview,
  type LabelTemplate,
  type LoginResponse,
  type LookupResult,
  type Package,
  type PairedPrinter,
  type PasswordSource,
  type PiInfo,
  type PiPairing,
  type PiPairingState,
  type Printer,
  type Product,
  type PushSubscriptionInput,
  type PushTestResult,
  type PushTestStatus,
  type RejectCode,
  type RestorePreview,
  type RestoreState,
  type RestoreStatus,
  type RestoreUpload,
  type ServerConfig,
  type ServerConfigChanges,
  type ServerHealth,
  type SetupChanges,
  type SetupStatus,
  type SetupStepId,
  type SetupStepState,
  type ShoppingItem,
  type SyncResponse,
  type UpdateStatus,
  type Zone,
} from "@/contract/api.gen";
import { gtinCheckDigit, isStoreInternalBarcode, isValidBarcode } from "@/contract/barcode";
import { isPackageId, isUuid, newUuid, randomPackageId } from "@/contract/ids";
import { progressAfterOutcome } from "@/contract/labels";
import { isDate, isTimeOfDay, isTimestamp } from "@/contract/time";

import { applyCommand } from "../commands/apply";
import { DAY_MS, isExpiredJob, isExpiredPackage, isExpiredShoppingItem, PRINT_JOB_RETENTION_DAYS, retentionLimit } from "../sync/retention";
import { FAKE_DEFAULT_DESIGN, FAKE_PAPERS, fakeHash, fakeLayoutProblem, fakePaper, fakeTemplate, framePng, imageSize, isFakeDefault, toBase64 } from "./fake-labels";
import { FakePrintService } from "./fake-print";
import { ShoppingRules } from "./fake-shopping";
import { fakeStats } from "./fake-stats";
import { Draft, EMPTY_TABLES, keyOf, TABLE_NAMES, type MutableTables, type TableName, type TableRows, type Tables } from "../tables";

export const FAKE_PASSWORD = "stowly";
export const FAKE_VERSION = "0.0.0-fake";
/** Neuabruf bei Open Food Facts: je Barcode höchstens einmal in dieser Zeit (`LOOKUP_REFRESH_GAP_S`). */
export const FAKE_REFRESH_GAP_MS = 60_000;

export interface FakeRequestData {
  method: string;
  /** Pfad ohne Abfrage, z. B. "/api/sync". */
  path: string;
  /** Die Abfrage ohne das Fragezeichen, z. B. "wait=10"; fehlt, wenn es keine gibt. */
  query?: string;
  /** Kopfzeilen mit kleingeschriebenen Namen. */
  headers: Record<string, string | undefined>;
  /** Der Rumpf als Text; leer, wenn es keinen gibt (oder er nur als Rohdaten in `bytes` steht). */
  body: string;
  /** Der Rumpf als Rohdaten, wenn er kein Text ist (das Hochladen einer Sicherung). */
  bytes?: Uint8Array;
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
const minStock = integer(1, LIMITS.min_stock);
const shoppingQuantity = integer(1, LIMITS.shopping_quantity);
const timeOfDay: Check = (value) => typeof value === "string" && isTimeOfDay(value);
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
    min_stock: opt(nullable(minStock)),
  },
  "product.update": {
    product_id: req(uuid),
    changes: req(
      object({
        name: opt(text(0, 120)),
        brand: opt(text(0, 80)),
        quantity: opt(text(0, 40)),
        warn_days: opt(nullable(warnDays)),
        min_stock: opt(nullable(minStock)),
      }),
    ),
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
        notify_time: opt(timeOfDay),
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
  "shopping_item.create": {
    item_id: req(uuid),
    product_id: opt(nullable(uuid)),
    text: opt(text(0, LIMITS.shopping_text)),
    quantity: opt(nullable(shoppingQuantity)),
  },
  "shopping_item.update": {
    item_id: req(uuid),
    changes: req(object({ text: opt(text(1, LIMITS.shopping_text)), quantity: opt(nullable(shoppingQuantity)), done: opt(bool) })),
  },
  "shopping_item.delete": { item_id: req(uuid) },
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
  if (type === "shopping_item.create") {
    const hasProduct = (command.product_id ?? null) !== null;
    const hasText = (command.text ?? "") !== "";
    if (hasProduct === hasText) {
      return "Ein Eintrag hat genau eines von Produkt und Text.";
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

// ------------------------------------------------------------------------------------------
// Push (docs/integrationen.md, Abschnitt 4)
// ------------------------------------------------------------------------------------------

/** Push-Dienste, an die der Server schickt (4.2): der Host ist eine davon oder liegt darunter. */
const PUSH_DOMAINS = ["fcm.googleapis.com", "push.apple.com", "push.services.mozilla.com", "notify.windows.com"];

function toBase64url(bytes: readonly number[]): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Die Bytes eines base64url-Texts (Füllzeichen erlaubt); null, wenn er keiner ist. */
function fromBase64url(text: unknown): number[] | null {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*={0,2}$/.test(text)) {
    return null;
  }
  const plain = text.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  try {
    return Array.from(atob(plain + "=".repeat((4 - (plain.length % 4)) % 4)), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Ein öffentlicher Schlüssel in der Form von P-256 (unkomprimiert, 65 Byte), aber erfunden. */
function fakePushKey(seed: number): string {
  return toBase64url([4, ...Array.from({ length: 64 }, (_, n) => (seed * 31 + n * 7) % 256)]);
}

/** Prüft ein Abo nach 4.2 und liefert die Stelle des ersten Fehlers, oder null. */
export function checkPushSubscription(body: unknown): { loc: string[]; msg: string } | null {
  if (!isRecord(body) || Object.keys(body).some((key) => !["endpoint", "keys", "origin"].includes(key))) {
    return { loc: ["body"], msg: "Das Abo hat nicht die erwartete Form." };
  }
  const endpoint = body.endpoint;
  let host: string | null = null;
  if (typeof endpoint === "string" && endpoint.length <= LIMITS.push_endpoint) {
    try {
      const url = new URL(endpoint);
      if (url.protocol === "https:" && url.username === "" && url.password === "" && (url.port === "" || url.port === "443")) {
        host = url.hostname.toLowerCase();
      }
    } catch {
      host = null;
    }
  }
  if (host === null || !PUSH_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    return { loc: ["body", "endpoint"], msg: "Kein bekannter Push-Dienst." };
  }
  const keys = body.keys;
  if (!isRecord(keys) || Object.keys(keys).some((key) => key !== "p256dh" && key !== "auth")) {
    return { loc: ["body", "keys"], msg: "Die Schlüssel fehlen." };
  }
  const p256dh = fromBase64url(keys.p256dh);
  if (p256dh === null || p256dh.length !== 65 || p256dh[0] !== 4) {
    return { loc: ["body", "keys", "p256dh"], msg: "Kein öffentlicher Schlüssel auf P-256." };
  }
  if (fromBase64url(keys.auth)?.length !== 16) {
    return { loc: ["body", "keys", "auth"], msg: "Das Geheimnis hat nicht 16 Byte." };
  }
  const origin = body.origin;
  let originOk = false;
  if (typeof origin === "string" && origin.length <= LIMITS.push_origin) {
    try {
      const url = new URL(origin);
      const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      originOk = (url.protocol === "https:" || local) && url.origin === origin && url.username === "";
    } catch {
      originOk = false;
    }
  }
  return originOk ? null : { loc: ["body", "origin"], msg: "Kein gültiger Ursprung." };
}

/** Die Nutzlast einer Push-Nachricht im Format „Declarative Web Push" (4.5). */
export interface PushPayload {
  web_push: 8030;
  notification: { title: string; body: string; navigate: string; lang: string; dir: "ltr"; tag: string; silent: boolean };
}

/** Die Testnachricht für ein Abo mit diesem Ursprung (4.9). */
export function pushTestPayload(origin: string): PushPayload {
  return {
    web_push: 8030,
    notification: {
      title: "Testnachricht",
      body: "Benachrichtigungen kommen auf diesem Gerät an.",
      navigate: `${origin}${PUSH_PATHS.test}`,
      lang: "de-DE",
      dir: "ltr",
      tag: "stowly-test",
      silent: false,
    },
  };
}

/** Home Assistant ist nicht eingerichtet (docs/integrationen.md, 5.6): der Zustand ohne Vorgabe. */
export const HA_OFF: HaStatus = { configured: false, problem: null, entity: null, state: "off", last_ok_at: null, last_error: null, last_error_at: null, linked: 0, sensor: false };

/** Was die Nachbildung auf eine Testnachricht antwortet, je nach Antwort des Push-Dienstes (4.7). */
const PUSH_TEST_RESULTS: Record<PushTestStatus, PushTestResult> = {
  sent: { status: "sent", http_status: 201, message: "Der Push-Dienst hat die Nachricht angenommen." },
  gone: { status: "gone", http_status: 410, message: "Der Push-Dienst kennt das Abo nicht mehr; es ist gelöscht." },
  rejected: { status: "rejected", http_status: 403, message: "Der Push-Dienst lehnt ab (403). Stimmt STOWLY_PUSH_CONTACT?" },
  failed: { status: "failed", http_status: 503, message: "Der Push-Dienst ist gerade nicht erreichbar (503)." },
};

// ------------------------------------------------------------------------------------------
// Updates über GitHub (docs/integrationen.md, Abschnitt 10)
// ------------------------------------------------------------------------------------------

/** Das neueste Release, wie es der Server aus der Antwort von GitHub macht (10.2). */
export interface FakeRelease {
  /** Version ohne „v", etwa "0.2.0". */
  version: string;
  name: string | null;
  notes: string | null;
  published_at: string | null;
  url: string | null;
}

/** Was der Updater in `/data/update/state` schreibt (10.3). */
export interface FakeUpdaterState {
  state: "installing" | "done" | "failed";
  /** Die Zielversion. */
  version: string;
  at: string;
  message: string | null;
}

/** Die Anforderung in `/data/update/request` (10.3). */
export interface FakeUpdateRequest {
  version: string;
  requested_at: string;
  /** Name des Geräts, das angefordert hat. */
  device: string;
}

/** So lange nach seiner letzten Meldung gilt der Updater als bereit (`UPDATER_READY_S` im Server). */
const UPDATER_READY_MS = 600_000;
/** Holt der Updater eine Anforderung so lange nicht ab, sagt `state_message` das (`UPDATE_REQUEST_STALE_S`). */
const UPDATE_REQUEST_STALE_MS = 600_000;
/** Meldet sich der Updater während der Installation so lange nicht, sagt `state_message` das (10.4). */
const UPDATE_INSTALLING_STALE_MS = 15 * 60_000;
/** Eine Version wie 1.2.3 (`VERSION_PATTERN` im Server). */
const VERSION_RE = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/;

// ------------------------------------------------------------------------------------------
// Einrichtung (docs/sync-protokoll.md 11.6 bis 11.8, docs/integrationen.md 11 und 12)
// ------------------------------------------------------------------------------------------

/** Die Schritte des Assistenten nach dem Passwort, in ihrer Reihenfolge. */
export const SETUP_STEP_IDS: readonly SetupStepId[] = ["https", "printer", "backup", "updates", "notifications", "home_assistant"];

/** Was der Server sagt, wenn Updates aus sind (docs/integrationen.md, 10.5). */
const UPDATE_OFF = "Updates sind auf diesem Server aus. Einschalten unter Einstellungen → Aktualisierung.";

/** So lange gilt ein Kopplungscode (`PI_PAIRING_TTL_S` im Server). */
const PI_PAIRING_TTL_MS = 1_800_000;
/** So lange gilt das Zertifikat eines Pi (`PI_CERT_DAYS`). */
const PI_CERT_DAYS = 825;
/** Crockford-Base32 ohne I, L, O, U. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Eine Adresse im Heimnetz (docs/integrationen.md, 11.3): private IPv4, ULA oder ein lokaler Name. */
export function isHomeAddress(address: string): boolean {
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (/^f[cd][0-9a-f]{0,2}:/i.test(address)) {
    return true;
  }
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.(local|lan|home|home\.arpa|internal|localdomain|fritz\.box)$/i.test(address);
}

/** Kontakt für die Push-Dienste nach den Regeln des Servers (server/stowly/config.py); liefert die gespeicherte Form oder null. */
function pushContactOf(value: string): string | null {
  const contact = value.startsWith("https://") || value.startsWith("mailto:") ? value : `mailto:${value}`;
  if (!/^[\x21-\x7e]+$/.test(contact)) {
    return null;
  }
  if (contact.startsWith("mailto:")) {
    return /^mailto:[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]+$/.test(contact) ? contact : null;
  }
  try {
    const url = new URL(contact);
    return url.username === "" && url.password === "" && /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(url.hostname) ? contact : null;
  } catch {
    return null;
  }
}

/** Eine Kopplung, wie der Server sie führt (Tabelle `pi_pairings`). */
export interface FakePairing {
  id: string;
  code: string;
  state: PiPairingState;
  expires_at: string;
  printer_id: string | null;
  pi: PiInfo | null;
  origin: string;
}

/** Was der Test beim Abschluss einer Kopplung vorgeben kann: was der Pi meldet. */
export interface FakePi {
  hostname?: string;
  address?: string;
  /** Erkanntes Druckermodell; null = keins. Vorgabe "QL-570". */
  model?: string | null;
  /** Name eines neuen Druckers in Stowly; Vorgabe das Modell. */
  name?: string;
  /** Ablauf des Zertifikats, das der Server ausstellt; Vorgabe in `PI_CERT_DAYS` (825) Tagen. */
  not_after?: string;
  /** Version des Druckdienstes, die der Pi beim Koppeln meldet (`PairedPrinter.version`). Vorgabe "0.3.0". */
  version?: string;
}

/** Ist `version` neuer als `than`? Verglichen werden die drei Zahlen; was keine Version wie 1.2.3 ist, ist nie neuer. */
function isNewerVersion(version: string, than: string): boolean {
  const a = VERSION_RE.exec(version);
  const b = VERSION_RE.exec(than);
  if (!a || !b) {
    return false;
  }
  for (let part = 1; part <= 3; part += 1) {
    const difference = Number(a[part]) - Number(b[part]);
    if (difference !== 0) {
      return difference > 0;
    }
  }
  return false;
}

// ------------------------------------------------------------------------------------------
// Sicherung, Zurückspielen und Home Assistant aus der App (Stufe B, docs/plan-einrichtung-b.md)
// ------------------------------------------------------------------------------------------

/** Vorgabe der Uhrzeit der Sicherung (BACKUP_TIME_DEFAULT). */
const BACKUP_TIME_DEFAULT = "03:30";
/** So groß darf eine Sicherung zum Zurückspielen sein (RESTORE_MAX_BYTES). */
export const FAKE_RESTORE_MAX_BYTES = 512 * 1024 * 1024;
/** So lange gelten `upload_id` und `restore_id` (RESTORE_ID_TTL_S). */
const RESTORE_ID_TTL_MS = 1_800_000;
/** So lange geht „Rückgängig" (RESTORE_UNDO_DAYS). */
const RESTORE_UNDO_MS = 7 * DAY_MS;
/** Die eigene Bremse des Zurückspielens: höchstens so viele Versuche in zehn Minuten. */
const RESTORE_LIMIT = 6;
const RESTORE_WINDOW_MS = 600_000;
/** Die Version der Datenbank, die die Nachbildung „hat" (`user_version`). */
export const FAKE_SCHEMA_VERSION = 5;
/** Höchstens eine Sicherung je Minute auf Knopfdruck. */
const BACKUP_RUN_GAP_MS = 60_000;
/** Zwischen zwei Prüfungen bei Home Assistant mindestens so viel Abstand. */
const HA_CHECK_GAP_MS = 3_000;

// Seit 0.6.0: KI-Vorschläge (docs/plan-0.6.md, 2).
/** Zwischen zwei Prüfungen des Schlüssels mindestens so viel Abstand. */
const AI_CHECK_GAP_MS = 3_000;
/** Höchstens so viele Anfragen am Tag für den ganzen Haushalt (`AI_DAILY_MAX` des Servers). */
export const FAKE_AI_DAILY_MAX = 20;
/** Läuft schon ein Auftrag, sagt der Server: in so vielen Sekunden noch einmal (`BUSY_RETRY_S`). */
const FAKE_BUSY_RETRY_S = 5;
/** Höchstens so viele Produkte gehen an Claude (`COOK_STOCK_MAX`). */
const FAKE_COOK_STOCK_MAX = 300;
/** Der Satz, wenn der Merker steht, die Datei mit dem Schlüssel aber fehlt (nach einem Zurückspielen). */
export const FAKE_AI_KEY_LOST = "Der API-Schlüssel für die KI-Vorschläge fehlt (steht in keiner Sicherung); bitte neu eintragen.";
const AI_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const satisfies readonly AiModel[];
const AI_MODEL_DEFAULT: AiModel = "claude-opus-5-5";
/** Was „Prüfen" je Ergebnis sagt; der Server sagt es mit eigenen Worten. */
const AI_CHECK_MESSAGES: Record<AiCheckState, string> = {
  ok: "Schlüssel und Modell passen.",
  key_rejected: "Anthropic lehnt den API-Schlüssel ab.",
  forbidden: "Der API-Schlüssel darf dieses Modell nicht nutzen.",
  model_unavailable: "Das Modell gibt es für diesen Schlüssel nicht.",
  busy: "Anthropic ist gerade ausgelastet.",
  unreachable: "Anthropic ist nicht erreichbar.",
  error: "Anthropic hat unerwartet geantwortet.",
};
/** Fehler, für die Anthropic nichts berechnet hat: Sie zählen nicht für heute (docs/plan-0.6.md, 2.6). */
const CREDITED_FAILURES: ReadonlySet<CookFailure> = new Set<CookFailure>(["key_rejected", "forbidden", "billing", "model_unavailable", "busy", "unavailable", "unreachable"]);
const COOK_JOB_ID = /^[0-9a-f]{32}$/;

/** Die Form eines API-Schlüssels, wie der Server sie prüft: der Satz, wenn sie nicht stimmt; sonst null. */
function aiKeyProblem(key: string): string | null {
  const trimmed = key.trim();
  if (!/^[\x21-\x7e]+$/.test(trimmed) || trimmed.length > LIMITS.ai_key || !trimmed.startsWith("sk-ant-") || trimmed.startsWith("sk-ant-admin")) {
    return "Kein API-Schlüssel von Anthropic in der erwarteten Form (sk-ant-…).";
  }
  return null;
}

/** Kalendertag eines Zeitpunkts in einer Zeitzone, "YYYY-MM-DD". */
function dayIn(timezone: string, moment: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(moment);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Sekunden bis zum nächsten Tag in der Zeitzone, auf die Minute genau (mindestens 1). */
function secondsUntilNextDay(timezone: string, nowMs: number): number {
  const today = dayIn(timezone, new Date(nowMs));
  let probe = nowMs;
  while (dayIn(timezone, new Date(probe)) === today) {
    probe += 3_600_000;
  }
  while (dayIn(timezone, new Date(probe - 60_000)) !== today) {
    probe -= 60_000;
  }
  return Math.max(1, Math.ceil((probe - nowMs) / 1000));
}
/** Dateien von Stowly im Ordner der Sicherungen. */
const OWN_BACKUP_FILE = /^stowly-\d{4}-\d{2}-\d{2}-\d{4}\.sqlite3\.gz\.age$/;
const AGE_PUBLIC = /^age1[02-9ac-hj-np-z]{58}$/;
const HA_ENTITY = /^todo\.[a-z0-9_]+$/;
const HA_URL = /^https?:\/\/[^\s/?#@]+\/?$/i;
const AGE_MAGIC = "age-encryption.org/v1\n";
const SQLITE_MAGIC = "SQLite format 3\u0000";
/** So schreibt die Nachbildung einen Empfänger in ihre „verschlüsselte" Datei: kein echtes age, nur der öffentliche Schlüssel. */
const FAKE_STANZA = "-> stowly-fake ";
/** So verweist eine Datei der Nachbildung auf den Stand, den sie festhält. */
const FAKE_SNAPSHOT = "--- stowly-fake ";

/** Ein Stand des Servers, wie ihn eine Sicherung festhält. */
interface FakeSnapshot {
  tables: Tables;
  /** Das Haushalts-Passwort; null = keines (eine Sicherung vor dem ersten Passwort). */
  password: string | null;
  devices: FakeDevice[];
  /** Die jüngste Änderung. */
  at: string;
}

interface FakeBackupFile {
  name: string;
  size: number;
  created_at: string;
  bytes: Uint8Array;
}

interface FakeUpload {
  id: string;
  kind: "age" | "gzip" | "sqlite";
  bytes: Uint8Array;
  expires: number;
}

interface FakeCandidate {
  id: string;
  expires: number;
  snapshot: FakeSnapshot;
}

/** Was „Verbindung prüfen" bei Home Assistant ergibt; die Nachbildung fragt kein HA. */
export const FAKE_HA_CHECK: HaCheck = {
  state: "ok",
  message: "Verbindung zu Home Assistant steht; 2 To-do-Listen gefunden.",
  ha_version: "2026.11.0",
  location_name: "Zuhause",
  // Wie der Server: nach Namen sortiert; `open` kann fehlen.
  lists: [
    { entity_id: "todo.baumarkt", name: "Baumarkt", open: null },
    { entity_id: "todo.einkaufsliste", name: "Einkaufsliste", open: 4 },
  ],
  entity_found: null,
};

/** Die Adresse, wie der Server sie speichert: Schema und Rechnername klein, ohne Schrägstrich am Ende. */
function normalizeHaUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, "")
    .replace(/^(https?:\/\/)(\[[^\]]*\]|[^/:?#]*)/i, (_match, scheme: string, host: string) => `${scheme.toLowerCase()}${host.toLowerCase()}`);
}

function hex(bytes: number): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}

function startsWith(bytes: Uint8Array, magic: string): boolean {
  const head = new TextEncoder().encode(magic);
  return bytes.length >= head.length && head.every((value, index) => bytes[index] === value);
}

/** Die öffentlichen Schlüssel zu den geheimen in einem Text (Zeilen mit # zählen nicht); null, wenn eine Zeile keiner ist. */
export function fakeIdentities(text: string): string[] | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (lines.length === 0) {
    return null;
  }
  const publics: string[] = [];
  for (const line of lines) {
    try {
      const decoded = bech32.decode(line);
      const secret = bech32.fromWords(decoded.words);
      if (decoded.prefix !== "age-secret-key-" || secret.length !== 32) {
        return null;
      }
      publics.push(bech32.encode("age", bech32.toWords(x25519.getPublicKey(secret))));
    } catch {
      return null;
    }
  }
  return publics;
}

/** Der Name einer Sicherung: `stowly-JJJJ-MM-TT-HHMM.sqlite3.gz.age`, Tag und Uhrzeit in der Zeitzone des Servers. */
function backupFileName(moment: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(moment);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "00";
  return `stowly-${part("year")}-${part("month")}-${part("day")}-${part("hour")}${part("minute")}.sqlite3.gz.age`;
}

export class FakeServer {
  /** Kennung des Datenbestands. */
  datasetId = newUuid();
  /** Stand der Änderungsfolge. */
  rev = 0;
  /** Protokollversion, die der Server verlangt. */
  protocol: number = PROTOCOL_VERSION;
  /**
   * false = es gibt noch kein Haushalts-Passwort (weder STOWLY_PASSWORD noch aus der App): Die
   * Anmeldung antwortet 503, `POST /api/setup/password` setzt es.
   */
  configured = true;
  /** Woher das Passwort kommt: "env" ist nur in der Umgebung änderbar (409), "app" auch in der App. */
  passwordSource: PasswordSource = "app";
  /** Alle Sync-Anfragen in der Reihenfolge ihres Eintreffens. */
  readonly syncRequests: Record<string, unknown>[] = [];
  /** Der Druckdienst des Servers unter `/print` (src/core/testing/fake-print.ts). */
  readonly print: FakePrintService;
  /** Kontakt für die Push-Dienste; null = keiner: Alles unter `/api/push` antwortet mit 503. */
  pushContact: string | null = "mailto:haushalt@example.org";
  /** Woher der Kontakt kommt: "env" (STOWLY_PUSH_CONTACT, in der App nicht änderbar), "app" oder "default" (keiner). */
  pushContactSource: ConfigSource = "env";
  /** Was der Push-Dienst auf die nächsten Testnachrichten antwortet. */
  pushTestStatus: PushTestStatus = "sent";
  /** Die Testnachrichten, die der Server verschickt hätte, in ihrer Reihenfolge. */
  readonly pushMessages: { device_id: string; endpoint: string; payload: PushPayload }[] = [];
  /** Zeitzone des Servers (STOWLY_TIMEZONE): für die Monate der Statistik und `GET /api/integrations`. */
  timezone = "Europe/Berlin";
  /** Zustand von Home Assistant in `GET /api/integrations` (docs/integrationen.md, 5.6 und 8). */
  haStatus: HaStatus = HA_OFF;
  /** STOWLY_UPDATE_REPO: gesetzt sind Updates immer an. null (Vorgabe) = es entscheidet `updateSwitch`. */
  updateRepo: string | null = null;
  /** STOWLY_UPDATE_REPO_DEFAULT: das Repository, das der Schalter der App einschaltet; null = das Image kennt keins. */
  updateRepoDefault: string | null = "beispiel/stowly";
  /** Der Schalter „Nach Updates suchen" in der App; null = nie geschaltet (aus). */
  updateSwitch: boolean | null = null;
  /** Was der Updater zuletzt in `updater` geschrieben hat: Art und Version (10.3); null = nichts. */
  updaterKind: "script" | "container" | null = null;
  updaterVersion: string | null = null;
  /** `UpdateStatus.updater_command` (10.7); null = das Image kennt keinen Befehl. */
  updaterCommand: string | null = null;
  /** Wann die Einrichtung abgeschlossen wurde; null = offen. */
  setupFinishedAt: string | null = null;
  /** HTTPS durch Stowly, wie `GET /api/setup` es meldet; Adressen und Port ändert auch `PATCH /api/setup`. */
  https: HttpsStatus;
  /** false: Es fehlen CA oder Paket für den Pi; `POST /api/pi/pairings` antwortet 503. */
  piReady = true;
  /** Die Version dieses Servers (`UpdateStatus.current`); nach einem Update setzt der Test die neue. */
  updateCurrent = "0.1.0";
  /** Was GitHub bei der nächsten Abfrage als neuestes Release liefert; null = es gibt noch keins (404). */
  githubRelease: FakeRelease | null = null;
  /** Scheitert die nächste Abfrage bei GitHub, steht hier der Satz für `check_error`; sonst null. */
  githubError: string | null = null;
  /** Letzte Meldung des Updaters (Datei `updater`); null = er hat sich nie gemeldet. */
  updaterSeenAt: string | null = null;
  /** Was der Updater zuletzt in `state` geschrieben hat; null = nichts. */
  updaterState: FakeUpdaterState | null = null;
  /** Die Anforderung für den Updater (Datei `request`); null = keine. Der Updater löscht sie, wenn er fertig ist. */
  updateRequest: FakeUpdateRequest | null = null;

  // Stufe B: Sicherung (docs/plan-einrichtung-b.md, 1). Was in der Umgebung steht, gibt der Test vor.
  /** STOWLY_BACKUP_RECIPIENTS; leer = die Schlüssel kommen aus der App. */
  backupEnvRecipients: string[] = [];
  /** STOWLY_BACKUP_TIME; null = aus der App oder die Vorgabe 03:30. */
  backupEnvTime: string | null = null;
  /** STOWLY_BACKUP_DIR; null = `/backups`, wenn eingebunden (`backupMounted`), sonst `/data/backups`. */
  backupEnvDir: string | null = null;
  /** In DSM ist ein zweiter Ordner als /backups eingebunden und beschreibbar. */
  backupMounted = false;
  /** Warum der Ordner nicht taugt; null = er taugt. */
  backupFolderProblem: string | null = null;
  /** Ein eingebundener Ordner /backups taugt nicht, die Sicherungen gehen in den Datenordner (`folder_hint`). */
  backupFolderHint: string | null = null;
  /** true: Gerade läuft eine Sicherung („Jetzt sichern" antwortet 409). */
  backupRunning = false;
  // Stufe B: Zurückspielen (2).
  /** Größte Sicherung zum Hochladen; für Tests kleiner einstellbar (413). */
  restoreMaxBytes = FAKE_RESTORE_MAX_BYTES;
  /** true: Ein Zurückspielen läuft schon (409). */
  restoreBusy = false;
  /**
   * So oft meldet der Server nach dem Anwenden noch den alten Stand, als liefe der Neustart noch:
   * `GET /api/restore` "pending", `GET /api/health` beim ersten Start `configured: false`. Vorgabe 0.
   */
  restartPolls = 0;
  // Stufe B: Home Assistant aus der App (3). Die Umgebung gibt der Test vor.
  /** STOWLY_HA_URL, STOWLY_HA_TOKEN, STOWLY_HA_TODO_ENTITY; gesetzt = die Verbindung kommt aus der Umgebung. */
  haEnv: { url: string; entity: string } | null = null;
  /** STOWLY_HA_SUMMARY_TOKEN; null = keiner (dann gilt der aus der App). */
  haSensorEnv: string | null = null;
  /** STOWLY_HA_CA ist gesetzt. */
  haCa = false;
  /** Was „Verbindung prüfen" ergibt (`POST /api/server-config/ha/check`). */
  haCheckResult: HaCheck = FAKE_HA_CHECK;
  /** Die Prüfungen bei HA, wie sie kamen (Adresse und ob ein Token dabei war). */
  readonly haChecks: { url: string | null; token: boolean }[] = [];
  // Seit 0.5.0: Etiketten gestalten und Produktdaten neu abfragen (docs/plan-0.5.md, 1 und 2).
  /**
   * Was Open Food Facts in der Nachbildung kennt, vor der Regel „gerade Endziffer = gefunden": für
   * „erst unbekannt, dann gefunden". Gilt für das Nachschlagen im Hintergrund, beim Scannen und den
   * Neuabruf; `image_id` muss ein Bild aus `images` sein (oder null).
   */
  readonly offProducts = new Map<string, { name: string; brand?: string; quantity?: string; image_id?: string | null }>();
  /** Bilder, die der Server gespeichert hat (Tabelle `images`): Nur auf sie lässt sich ein Produktbild setzen. */
  readonly images = new Set<string>();
  /** Die Vorschauen, wie sie ankamen (`POST /api/labels/preview`). */
  readonly previews: Record<string, unknown>[] = [];
  // Seit 0.6.0: KI-Vorschläge (docs/plan-0.6.md, 2). Anthropic gibt es hier nicht.
  /** STOWLY_ANTHROPIC_API_KEY; null = keiner (dann gilt der aus der App). */
  aiEnvKey: string | null = null;
  /** Was „Prüfen" bei Anthropic ergibt (`POST /api/server-config/ai/check`). */
  aiCheckState: AiCheckState = "ok";
  /** Die Prüfungen, wie sie kamen: mit eigenem Schlüssel (sonst der wirksame) und mit welchem Modell. */
  readonly aiChecks: { key: boolean; model: AiModel }[] = [];
  /** So viele Abfragen lang meldet `GET /api/cook/ideas/{id}` einen Auftrag noch als "running". */
  cookRunningPolls = 0;
  /** Womit die nächsten Aufträge enden; null = ein Vorschlag aus den ersten Produkten des Bestands. */
  cookOutcome: CookIdeas | null = null;
  /** Woran die nächsten Aufträge scheitern; null = sie gelingen. Geht `cookOutcome` vor. */
  cookProblem: CookProblem | null = null;
  /** Die Aufträge, wie sie angenommen wurden: Gerät, Wunsch, Zutaten. */
  readonly cookStarts: { device_id: string; wish: string; focus: string[] }[] = [];

  private tables: Tables = EMPTY_TABLES;
  /** Was der Server an der Einkaufsliste selbst schreibt (7.6), samt Sperren und Uhren. */
  private shopping = new ShoppingRules();
  private pushKeySeed = 1;
  private readonly pushSubscriptions = new Map<string, PushSubscriptionInput>();
  /** Zeitpunkt der letzten Testnachricht je Gerät in Millisekunden. */
  private readonly pushTests = new Map<string, number>();
  /** Was der Server bei GitHub zuletzt gesehen hat (`job_runs`, 10.2). */
  private updateSeen: { release: FakeRelease | null; checked_at: string | null; check_error: string | null } = { release: null, checked_at: null, check_error: null };
  /** Zeitpunkt der letzten Abfrage auf Knopfdruck in Millisekunden. */
  private lastUpdateCheck: number | null = null;
  private readonly revs = new Map<string, number>();
  private settingsRev = 0;
  private readonly results = new Map<string, CommandResult>();
  private readonly devices = new Map<string, FakeDevice>();
  private readonly reservations = new Map<string, string>();
  private readonly lookups = new Map<string, number>();
  private failedLogins: number[] = [];
  private lockedUntil = 0;
  /** Wie die App die Schritte des Assistenten markiert hat (11.6). */
  private readonly setupSteps = new Map<SetupStepId, { state: SetupStepState; changed_at: string }>();
  private readonly pairings = new Map<string, FakePairing>();
  /** Sicherung aus der App: Schalter (null = nie geschaltet: an), Uhrzeit, öffentliche Schlüssel. */
  private backupSwitch: boolean | null = null;
  private backupTimeApp: string | null = null;
  private backupRecipientsApp: { key: string; added_at: string }[] = [];
  /** Die Sicherungen im Ordner, neueste zuerst. */
  private backupFiles: FakeBackupFile[] = [];
  private lastBackupRun: number | null = null;
  /** Die Stände, auf die Dateien der Nachbildung verweisen. */
  private readonly snapshots = new Map<string, FakeSnapshot>();
  private readonly uploads = new Map<string, FakeUpload>();
  private readonly candidates = new Map<string, FakeCandidate>();
  /** Zeitpunkte der letzten Versuche zum Zurückspielen (Bremse). */
  private restoreAttempts: number[] = [];
  private restoreState: { state: RestoreState; at: string | null; message: string | null; next: RestoreState; polls: number } = {
    state: "idle",
    at: null,
    message: null,
    next: "idle",
    polls: 0,
  };
  /** Die Datenbank von vor dem Zurückspielen, für „Rückgängig". */
  private restorePrevious: { snapshot: FakeSnapshot; until: number } | null = null;
  /** So oft meldet `/api/health` nach einem Zurückspielen beim ersten Start noch „nicht eingerichtet". */
  private healthPolls = 0;
  /** Home Assistant aus der App: Adresse, Liste, Token (nur hier, nie in einer Antwort). */
  private haApp: { url: string | null; entity: string | null; token: string | null; token_set_at: string | null } = { url: null, entity: null, token: null, token_set_at: null };
  private haSensorApp: { token: string; set_at: string } | null = null;
  private lastHaCheck: number | null = null;
  /** Die eigene Gestaltung des Haushalts; null = Vorgabe, es gelten die mitgelieferten Vorlagen. */
  private labelDesign: { design: LabelDesign; updated_at: string } | null = null;
  /** Die mitgelieferten Vorlagen, wie beim Start übernommen: Zurücksetzen bringt sie mit demselben `hash` zurück. */
  private bundledTemplates: LabelTemplate[] = [];
  /** Das zuletzt gespeicherte Ergebnis je Barcode (`off_lookups`) und wann er zuletzt neu gefragt wurde. */
  private readonly offStored = new Map<string, LookupResult>();
  private readonly refreshedAt = new Map<string, number>();
  /** Der Schlüssel aus der App (in /data/secrets); nie in einer Antwort. */
  private aiAppKey: string | null = null;
  /** Der Merker in `server_config`: wann der Schlüssel eingetragen wurde. Steht er ohne Schlüssel, fehlt die Datei. */
  private aiKeySetAt: string | null = null;
  private aiModel: AiModel | null = null;
  /** Anfragen am Tag `day` (Zeitzone des Servers). */
  private aiUsage = { day: "", count: 0 };
  private lastAiCheck: number | null = null;
  private readonly cookJobs = new Map<string, { device_id: string; job: CookJob; polls: number; focus: string[] }>();
  /** Wann jedes Gerät zuletzt einen Auftrag gestartet hat, in Millisekunden. */
  private readonly cookStartedAt = new Map<string, number>();

  private readonly now: () => Date;
  private password: string;
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
    const nowMs = this.now().getTime();
    const later = (days: number) => new Date(nowMs + days * DAY_MS).toISOString();
    this.https = {
      enabled: true,
      listening: true,
      problem: null,
      port: 8443,
      port_source: "default",
      http_port: null,
      addresses: [{ address: "192.168.1.10", source: "learned", in_certificate: true }],
      origins: ["https://192.168.1.10:8443"],
      seen_at: null,
      via_https: false,
      ca: { name: "Stowly CA 3F2A1C", fingerprint_sha256: "3F:2A:1C:7B:00:9E:41:D2:5A:6C:88:0B:CE:13:47:F0:22:9D:B4:6E:01:73:AA:5F:C8:3E:90:1D:64:B7:2C:58", not_after: later(3650), created_by_stowly: true, name_constraints: true },
      certificate: { addresses: ["192.168.1.10", "localhost", "127.0.0.1"], not_after: later(397) },
    };
    this.seedDefaults();
    if (options.sample) {
      this.seedSample();
      // Ein Haushalt mit Bestand ist eingerichtet.
      this.setupFinishedAt = this.stamp();
    }
  }

  /** Gibt es einen Kontakt für die Push-Dienste? false heißt: Alles unter `/api/push` antwortet mit 503. */
  get pushConfigured(): boolean {
    return this.pushContact !== null;
  }

  set pushConfigured(value: boolean) {
    if (!value) {
      this.pushContact = null;
      this.pushContactSource = "default";
    } else if (this.pushContact === null) {
      this.pushContact = "mailto:haushalt@example.org";
      this.pushContactSource = "env";
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

  /** Die Regeln der Einkaufsliste mit Sperren, Uhren und `closed_by`. */
  get shoppingRules(): ShoppingRules {
    return this.shopping;
  }

  /** Der öffentliche VAPID-Schlüssel (`GET /api/push/key`). */
  get pushKey(): string {
    return fakePushKey(this.pushKeySeed);
  }

  /** Ein anderer VAPID-Schlüssel, wie nach dem Einspielen einer Sicherung einer anderen Datenbank. */
  rotatePushKey(): void {
    this.pushKeySeed += 1;
  }

  /** Das Push-Abo eines Geräts, wie es der Server kennt. */
  pushSubscriptionOf(deviceId: string): PushSubscriptionInput | undefined {
    return this.pushSubscriptions.get(deviceId);
  }

  /** Vergisst alle Push-Abos, wie nach dem Einspielen einer älteren Sicherung. */
  forgetPushSubscriptions(): void {
    this.pushSubscriptions.clear();
  }

  /**
   * Fragt GitHub, wie es der Server planmäßig tut (10.2), ohne die Sperre für den Knopf: übernimmt
   * `githubRelease`, oder merkt sich bei `githubError` nur den Fehler. Dann bleiben die bisherigen
   * Angaben zum neuesten Release stehen.
   */
  checkGithub(): void {
    if (this.githubError !== null) {
      this.updateSeen = { ...this.updateSeen, check_error: this.githubError };
    } else {
      this.updateSeen = { release: this.githubRelease ? { ...this.githubRelease } : null, checked_at: this.stamp(), check_error: null };
    }
  }

  /** `UpdateStatus` nach den Regeln aus docs/integrationen.md 10.4; bei `state` gilt die erste passende. */
  /** Das wirksame Repository (docs/integrationen.md, 12): STOWLY_UPDATE_REPO, sonst der Schalter der App; null = aus. */
  get effectiveUpdateRepo(): string | null {
    return this.updateRepo ?? (this.updateSwitch === true ? this.updateRepoDefault : null);
  }

  updateStatus(): UpdateStatus {
    const nowMs = this.now().getTime();
    const release = this.updateSeen.release;
    const ready = this.updaterSeenAt !== null && nowMs - Date.parse(this.updaterSeenAt) <= UPDATER_READY_MS;
    const repo = this.effectiveUpdateRepo;
    const status: UpdateStatus = {
      configured: repo !== null,
      repo,
      current: this.updateCurrent,
      latest: release?.version ?? null,
      latest_name: release?.name ?? null,
      notes: release?.notes ?? null,
      published_at: release?.published_at ?? null,
      url: release?.url ?? null,
      available: release !== null && isNewerVersion(release.version, this.updateCurrent),
      checked_at: this.updateSeen.checked_at,
      check_error: this.updateSeen.check_error,
      updater_ready: ready,
      updater_seen_at: this.updaterSeenAt,
      updater_kind: this.updaterSeenAt === null ? null : (this.updaterKind ?? "script"),
      updater_version: this.updaterVersion,
      updater_command: this.updaterCommand,
      state: "idle",
      state_version: null,
      state_at: null,
      state_message: null,
    };
    const request = this.updateRequest;
    const written = this.updaterState;
    if (request && written?.state === "installing" && written.version === request.version) {
      return { ...status, state: "installing", state_version: written.version, state_at: written.at };
    }
    if (request) {
      const stale = nowMs - Date.parse(request.requested_at) > UPDATE_REQUEST_STALE_MS && !ready;
      return {
        ...status,
        state: "requested",
        state_version: request.version,
        state_at: request.requested_at,
        state_message: stale ? "Der Updater hat die Anforderung noch nicht abgeholt. Läuft die Aufgabe auf dem Rechner?" : null,
      };
    }
    if (written?.state === "installing") {
      const stale = nowMs - Date.parse(written.at) > UPDATE_INSTALLING_STALE_MS;
      return {
        ...status,
        state: "installing",
        state_version: written.version,
        state_at: written.at,
        state_message: stale ? "Der Updater meldet sich seit 15 Minuten nicht. Bitte auf dem Rechner nachsehen." : null,
      };
    }
    if (written?.state === "done" && written.version === this.updateCurrent) {
      return { ...status, state: "done", state_version: written.version, state_at: written.at };
    }
    if (written?.state === "failed") {
      return { ...status, state: "failed", state_version: written.version, state_at: written.at, state_message: written.message };
    }
    // Auch „done" für eine andere Version als die laufende, etwa nach einem Zurückspielen von Hand.
    return status;
  }

  /** `SetupStatus` (11.6): `ready` je Schritt aus Sicht des Servers, dazu was die App markiert hat. */
  setupStatus(): SetupStatus {
    const ready: Record<SetupStepId, boolean> = {
      https: this.https.seen_at !== null,
      printer: [...this.tables.printers.values()].some((printer) => printer.deleted_at === null),
      // Wirksam und mit einer gelungenen Sicherung (SetupStep.ready).
      backup: this.backupConfigured && this.backupFiles.length > 0,
      updates: this.effectiveUpdateRepo !== null,
      notifications: this.pushContact !== null,
      home_assistant: this.haConfig().configured,
    };
    return {
      password_source: this.passwordSource,
      steps: SETUP_STEP_IDS.map((id) => ({ id, state: this.setupSteps.get(id)?.state ?? "open", ready: ready[id], changed_at: this.setupSteps.get(id)?.changed_at ?? null })),
      finished_at: this.setupFinishedAt,
      paired_printers: this.pairedPrinters(),
      https: { ...this.https, addresses: this.https.addresses.map((address) => ({ ...address })), origins: [...this.https.origins] },
    };
  }

  /** `SetupStatus.paired_printers`: je nicht gelöschtem Drucker die jüngste Kopplung eines Pi, früheste Ablaufzeit zuerst. */
  private pairedPrinters(): PairedPrinter[] {
    const latest = new Map<string, PairedPrinter>();
    // Die Kopplungen stehen in der Reihenfolge ihres Entstehens: Die spätere ersetzt die frühere.
    for (const pairing of this.pairings.values()) {
      const printer = pairing.printer_id === null ? undefined : this.tables.printers.get(pairing.printer_id);
      if (pairing.state === "paired" && printer && printer.deleted_at === null && pairing.pi?.not_after) {
        const { hostname, not_after, version, model } = pairing.pi;
        latest.set(printer.id, { printer_id: printer.id, hostname, not_after, version: version ?? null, model });
      }
    }
    return [...latest.values()].sort((a, b) => a.not_after.localeCompare(b.not_after));
  }

  /** `ServerConfig` (11.7): die wirksamen Werte mit ihrer Quelle. */
  serverConfig(): ServerConfig {
    return {
      push: { contact: this.pushContact, source: this.pushContactSource },
      update: {
        enabled: this.effectiveUpdateRepo !== null,
        repo: this.updateRepo ?? this.updateRepoDefault,
        source: this.updateRepo !== null ? "env" : this.updateSwitch === null ? "default" : "app",
        available: this.updateRepo === null && this.updateRepoDefault !== null,
      },
      backup: this.backupConfig(),
    };
  }

  // ---------------------------------------------------------------- Stufe B: Sicherung

  /** `ServerConfig.backup`: die wirksamen Werte mit ihrer Quelle (docs/plan-einrichtung-b.md, 1). */
  backupConfig(): BackupConfig {
    const fromEnv = this.backupEnvRecipients.length > 0;
    const short = (key: string) => `${key.slice(0, 8)}…${key.slice(-4)}`;
    return {
      enabled: fromEnv || (this.backupSwitch ?? true),
      enabled_source: fromEnv ? "env" : this.backupSwitch === null ? "default" : "app",
      recipients: fromEnv
        ? this.backupEnvRecipients.map((key) => ({ key, short: short(key), added_at: null }))
        : this.backupRecipientsApp.map(({ key, added_at }) => ({ key, short: short(key), added_at })),
      recipients_source: fromEnv ? "env" : this.backupRecipientsApp.length > 0 ? "app" : "default",
      time: this.backupEnvTime ?? this.backupTimeApp ?? BACKUP_TIME_DEFAULT,
      time_source: this.backupEnvTime !== null ? "env" : this.backupTimeApp !== null ? "app" : "default",
      folder: this.backupEnvDir ?? (this.backupMounted ? "/backups" : "/data/backups"),
      folder_source: this.backupEnvDir !== null ? "env" : this.backupMounted ? "mounted" : "data",
      folder_problem: this.backupFolderProblem,
      folder_hint: this.backupFolderHint,
    };
  }

  /** Wirksam: an, mit mindestens einem Schlüssel und einem brauchbaren Ordner. */
  get backupConfigured(): boolean {
    const config = this.backupConfig();
    return config.enabled && config.recipients.length > 0 && config.folder_problem === null;
  }

  /** Die Sicherungen im Ordner, neueste zuerst. */
  get backupFileList(): BackupFile[] {
    return this.backupFiles.map(({ name, size, created_at }) => ({ name, size, created_at }));
  }

  /** `BackupStatus` in `GET /api/integrations`. */
  private backupStatus(): BackupStatus {
    const config = this.backupConfig();
    const configured = this.backupConfigured;
    const last = this.backupFiles[0];
    return {
      configured,
      folder: config.folder,
      files: this.backupFileList.slice(0, LIMITS.backup_files_listed),
      problem: !configured && config.recipients.length > 0 ? (config.folder_problem ?? (config.enabled ? null : "Die automatische Sicherung ist ausgeschaltet.")) : null,
      time: config.time,
      recipients: config.recipients.map((recipient) => recipient.short),
      last_ok_at: last?.created_at ?? null,
      last_file: last?.name ?? null,
      last_size: last?.size ?? null,
      last_error: null,
      last_error_at: null,
      next_at: null,
      warning: false,
    };
  }

  /** Der jetzige Stand, wie ihn eine Sicherung festhielte. */
  private snapshot(): FakeSnapshot {
    return { tables: this.tables, password: this.configured ? this.password : null, devices: [...this.devices.values()].map((device) => ({ ...device })), at: this.stamp() };
  }

  /**
   * Eine Datei der Nachbildung mit dem jetzigen Stand: "age" für diese öffentlichen Schlüssel (kein
   * echtes age: Die Datei nennt nur die Schlüssel und verweist auf den Stand), "gzip" oder "sqlite"
   * wie eine ältere, unverschlüsselte Sicherung.
   */
  backupBytes(kind: "age" | "gzip" | "sqlite", recipients: readonly string[] = []): Uint8Array {
    const id = hex(16);
    this.snapshots.set(id, this.snapshot());
    const head = kind === "age" ? `${AGE_MAGIC}${recipients.map((key) => `${FAKE_STANZA}${key}\n`).join("")}` : kind === "sqlite" ? SQLITE_MAGIC : "";
    const text = new TextEncoder().encode(`${head}${FAKE_SNAPSHOT}${id}\n`);
    if (kind !== "gzip") {
      return text;
    }
    const bytes = new Uint8Array(text.length + 2);
    bytes.set([0x1f, 0x8b]);
    bytes.set(text, 2);
    return bytes;
  }

  /** `POST /api/backup/run`: dieselbe Sicherung wie die tägliche, in den Ordner. */
  private runBackup(): FakeResponseData {
    if (this.backupRunning) {
      return failure(409, "conflict", "Es läuft schon eine Sicherung.");
    }
    const nowMs = this.now().getTime();
    if (this.lastBackupRun !== null && nowMs - this.lastBackupRun < BACKUP_RUN_GAP_MS) {
      const wait = Math.max(1, Math.ceil((this.lastBackupRun + BACKUP_RUN_GAP_MS - nowMs) / 1000));
      return failure(429, "rate_limited", "Höchstens eine Sicherung je Minute.", { retry_after_s: wait }, { "retry-after": String(wait) });
    }
    const config = this.backupConfig();
    if (config.recipients.length === 0) {
      return failure(503, "not_configured", "Für die Sicherung fehlt ein öffentlicher Schlüssel.");
    }
    if (config.folder_problem !== null) {
      return failure(503, "not_configured", config.folder_problem);
    }
    this.lastBackupRun = nowMs;
    const bytes = this.backupBytes("age", config.recipients.map((recipient) => recipient.key));
    const file: FakeBackupFile = { name: backupFileName(this.now(), this.timezone), size: bytes.length, created_at: this.stamp(), bytes };
    this.backupFiles = [file, ...this.backupFiles.filter((other) => other.name !== file.name)];
    return json(200, { name: file.name, size: file.size, created_at: file.created_at });
  }

  /** `GET /api/backup/files/{name}`: nur Dateien von Stowly aus dem Ordner. */
  private backupFile(name: string): FakeResponseData {
    const file = OWN_BACKUP_FILE.test(name) ? this.backupFiles.find((candidate) => candidate.name === name) : undefined;
    if (!file) {
      return failure(404, "not_found", "Diese Sicherung gibt es nicht.");
    }
    return {
      status: 200,
      headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${file.name}"`, "cache-control": "no-store" },
      body: file.bytes,
    };
  }

  /**
   * Bringt `backup_recipients` einen Schlüssel, den die App noch nicht hat, braucht es das Haushalts-Passwort
   * (`current_password`): fehlt es, 422 an ["body", "current_password"]; falsch, 401 über die Bremse der
   * Anmeldung (dann 429). Liefert die Antwort, wenn es nicht passt, sonst null.
   */
  private confirmNewKey(changes: ServerConfigChanges, keys: string[]): FakeResponseData | null {
    if (keys.every((key) => this.backupRecipientsApp.some((known) => known.key === key))) {
      return null;
    }
    if (changes.current_password === undefined) {
      const msg = "Zum Hinzufügen eines Schlüssels braucht es das Haushalts-Passwort.";
      return failure(422, "invalid_request", msg, { errors: [{ loc: ["body", "current_password"], msg, type: "missing" }] });
    }
    const locked = this.lockout();
    if (locked) {
      return locked;
    }
    if (changes.current_password !== this.password) {
      this.failedAttempt();
      return failure(401, "invalid_password", "Das Passwort stimmt nicht.");
    }
    this.failedLogins = [];
    return null;
  }

  /** Die Felder `backup_*` von `PATCH /api/server-config`: die Antwort, wenn etwas nicht passt, sonst wie es sich ändert. */
  private patchBackup(changes: ServerConfigChanges): FakeResponseData | (() => void) {
    const fromEnv = this.backupEnvRecipients.length > 0;
    if ((changes.backup_enabled !== undefined || changes.backup_recipients !== undefined) && fromEnv) {
      return failure(409, "conflict", "Die Schlüssel der Sicherung kommen aus der Umgebung (STOWLY_BACKUP_RECIPIENTS).");
    }
    if (changes.backup_time !== undefined && this.backupEnvTime !== null) {
      return failure(409, "conflict", "Die Uhrzeit der Sicherung kommt aus der Umgebung (STOWLY_BACKUP_TIME).");
    }
    let recipients: { key: string; added_at: string }[] | undefined;
    if (changes.backup_recipients !== undefined) {
      const keys: string[] = [];
      for (const [index, raw] of changes.backup_recipients.entries()) {
        const key = raw.trim().toLowerCase();
        if (/AGE-SECRET-KEY-/i.test(raw)) {
          // Wie der Server: abgelehnt, ohne den Schlüssel zu wiederholen.
          const msg = "Das ist ein geheimer Schlüssel. An Stowly geht nur der öffentliche (age1…).";
          return failure(422, "invalid_request", msg, { errors: [{ loc: ["body", "backup_recipients", index], msg, type: "value_error" }] });
        }
        if (!AGE_PUBLIC.test(key)) {
          const msg = "Das ist kein öffentlicher Schlüssel von age (age1…).";
          return failure(422, "invalid_request", msg, { errors: [{ loc: ["body", "backup_recipients", index], msg, type: "value_error" }] });
        }
        if (!keys.includes(key)) {
          keys.push(key);
        }
      }
      const refused = this.confirmNewKey(changes, keys);
      if (refused) {
        return refused;
      }
      const at = this.stamp();
      recipients = keys.map((key) => ({ key, added_at: this.backupRecipientsApp.find((known) => known.key === key)?.added_at ?? at }));
    }
    return () => {
      if (changes.backup_enabled !== undefined) {
        this.backupSwitch = changes.backup_enabled;
      }
      if (changes.backup_time !== undefined) {
        this.backupTimeApp = changes.backup_time;
      }
      if (recipients !== undefined) {
        this.backupRecipientsApp = recipients;
      }
    };
  }

  // ---------------------------------------------------------------- Stufe B: Zurückspielen

  /** Die Bremse des Zurückspielens: eine Antwort 429, oder null, wenn es weitergeht (dann zählt der Versuch). */
  private restoreBrake(): FakeResponseData | null {
    const nowMs = this.now().getTime();
    this.restoreAttempts = this.restoreAttempts.filter((at) => nowMs - at < RESTORE_WINDOW_MS);
    if (this.restoreAttempts.length >= RESTORE_LIMIT) {
      const wait = Math.max(1, Math.ceil(((this.restoreAttempts[0] ?? nowMs) + RESTORE_WINDOW_MS - nowMs) / 1000));
      return failure(429, "rate_limited", "Zu viele Versuche zum Zurückspielen. Bitte etwas warten.", { retry_after_s: wait }, { "retry-after": String(wait) });
    }
    this.restoreAttempts.push(nowMs);
    return null;
  }

  /** 409, wenn gerade etwas läuft, das sich mit dem Zurückspielen nicht verträgt; sonst null. */
  private restoreConflict(): FakeResponseData | null {
    if (this.restoreBusy) {
      return failure(409, "conflict", "Gerade läuft schon ein Zurückspielen.");
    }
    if (this.updateRequest !== null) {
      return failure(409, "conflict", "Gerade steht ein Update an. Zurückspielen geht danach wieder.");
    }
    return null;
  }

  /** `PUT /api/restore/upload`: die Datei als Rohdaten; erkannt an den ersten Bytes. */
  private restoreUpload(request: FakeRequestData): FakeResponseData {
    const bytes = request.bytes ?? new TextEncoder().encode(request.body);
    if (bytes.length > this.restoreMaxBytes) {
      return failure(413, "payload_too_large", "Die Datei ist zu groß.");
    }
    const conflict = this.restoreConflict() ?? this.restoreBrake();
    if (conflict) {
      return conflict;
    }
    const kind = startsWith(bytes, AGE_MAGIC) ? "age" : bytes[0] === 0x1f && bytes[1] === 0x8b ? "gzip" : startsWith(bytes, SQLITE_MAGIC) ? "sqlite" : null;
    if (kind === null) {
      return failure(422, "invalid_request", "Das ist keine Sicherung von Stowly.", { reason: "not_stowly" });
    }
    const upload: FakeUpload = { id: hex(16), kind, bytes, expires: this.now().getTime() + RESTORE_ID_TTL_MS };
    this.uploads.set(upload.id, upload);
    const answer: RestoreUpload = { upload_id: upload.id, kind, size: bytes.length };
    return json(201, answer);
  }

  /** Der Stand hinter einer Datei der Nachbildung; null, wenn sie keiner ist. */
  private snapshotIn(bytes: Uint8Array): FakeSnapshot | null {
    const text = new TextDecoder().decode(bytes);
    const at = text.indexOf(FAKE_SNAPSHOT);
    const id = at === -1 ? "" : text.slice(at + FAKE_SNAPSHOT.length).split("\n")[0]?.trim() ?? "";
    return this.snapshots.get(id) ?? null;
  }

  /** `POST /api/restore/check`: entschlüsseln (nachgespielt) und prüfen; die Vorschau samt `restore_id`. */
  private restoreCheck(body: unknown): FakeResponseData {
    if (!object({ upload_id: req(text(32, 32)), identity: opt(nullable(text(0, LIMITS.restore_identity))) })(body)) {
      return failure(422, "invalid_request", "Die Anfrage verletzt den Vertrag.", { errors: [] });
    }
    const { upload_id: uploadId, identity } = body as { upload_id: string; identity?: string | null };
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.expires < this.now().getTime()) {
      return failure(404, "not_found", "Die hochgeladene Datei ist abgelaufen. Bitte noch einmal hochladen.");
    }
    const conflict = this.restoreConflict() ?? this.restoreBrake();
    if (conflict) {
      return conflict;
    }
    if (upload.kind === "age") {
      const publics = identity ? fakeIdentities(identity) : null;
      if (publics === null) {
        return failure(422, "invalid_request", "Das ist kein geheimer Schlüssel von age (AGE-SECRET-KEY-1…).", { reason: "not_a_key" });
      }
      const text = new TextDecoder().decode(upload.bytes);
      const recipients = text
        .split("\n")
        .filter((line) => line.startsWith(FAKE_STANZA))
        .map((line) => line.slice(FAKE_STANZA.length).trim());
      if (!publics.some((key) => recipients.includes(key))) {
        return failure(422, "invalid_request", "Der Schlüssel passt nicht zu dieser Sicherung.", { reason: "wrong_key" });
      }
    }
    const snapshot = this.snapshotIn(upload.bytes);
    if (snapshot === null) {
      return failure(422, "invalid_request", "Die Sicherung ist beschädigt.", { reason: "damaged" });
    }
    const candidate: FakeCandidate = { id: hex(16), expires: this.now().getTime() + RESTORE_ID_TTL_MS, snapshot };
    this.candidates.set(candidate.id, candidate);
    const { tables } = snapshot;
    const preview: RestorePreview = {
      restore_id: candidate.id,
      expires_at: new Date(candidate.expires).toISOString(),
      kind: upload.kind,
      schema_version: FAKE_SCHEMA_VERSION,
      current_schema_version: FAKE_SCHEMA_VERSION,
      last_activity_at: snapshot.at,
      has_password: snapshot.password !== null,
      devices: snapshot.devices.filter((device) => device.revoked_at === null).length,
      counts: {
        products: [...tables.products.values()].filter((product) => product.deleted_at === null && product.merged_into === null).length,
        items: [...tables.packages.values()].filter((pkg) => pkg.removed_at === null).length,
        zones: [...tables.zones.values()].filter((zone) => zone.deleted_at === null).length,
        shopping: [...tables.shopping_items.values()].filter((item) => item.done_at === null && item.deleted_at === null).length,
      },
    };
    return json(200, preview);
  }

  /** Spielt den Bestand eines Stands ein, unter einer neuen `dataset_id`: Alle Geräte bekommen `reset`. */
  private swapIn(snapshot: FakeSnapshot): void {
    const rows: { [T in TableName]?: TableRows[T][] } = {};
    for (const table of TABLE_NAMES) {
      (rows as Record<TableName, unknown[]>)[table] = [...snapshot.tables[table].values()];
    }
    this.load({ ...rows, settings: snapshot.tables.settings ?? undefined });
    this.datasetId = newUuid();
  }

  /**
   * `POST /api/restore/apply` (202). Laufender Stowly (`device`): mit dem jetzigen Passwort; Geräte,
   * Passwort und Einstellungen des Servers bleiben, „Rückgängig" geht sieben Tage. Erster Start (kein
   * Passwort, ohne Token): mit dem Passwort aus der Sicherung oder einem neuen; das Gerät entsteht mit.
   */
  private restoreApply(body: unknown, device: FakeDevice | null): FakeResponseData {
    if (!object({ restore_id: req(text(32, 32)), password: req(text(1, LIMITS.password)), device_name: opt(nullable(text(1, LIMITS.device_name))) })(body)) {
      return failure(422, "invalid_request", "Die Anfrage verletzt den Vertrag.", { errors: [] });
    }
    const { restore_id: restoreId, password, device_name: name } = body as { restore_id: string; password: string; device_name?: string | null };
    const candidate = this.candidates.get(restoreId);
    if (!candidate || candidate.expires < this.now().getTime()) {
      return failure(404, "not_found", "Die geprüfte Sicherung ist abgelaufen. Bitte noch einmal prüfen.");
    }
    const conflict = this.restoreConflict();
    if (conflict) {
      return conflict;
    }
    const locked = this.lockout();
    if (locked) {
      return locked;
    }
    const at = this.stamp();
    if (device) {
      if (password !== this.password) {
        this.failedAttempt();
        return failure(401, "invalid_password", "Das Passwort stimmt nicht.");
      }
      this.candidates.delete(restoreId);
      this.restorePrevious = { snapshot: this.snapshot(), until: this.now().getTime() + RESTORE_UNDO_MS };
      this.swapIn(candidate.snapshot);
      this.restoreState = { state: "pending", at, message: null, next: "done", polls: this.restartPolls };
      return json(202, { login: null });
    }
    // Erster Start.
    const snapshot = candidate.snapshot;
    if (!name) {
      const msg = "Beim ersten Start braucht dieses Gerät einen Namen.";
      return failure(422, "invalid_request", msg, { errors: [{ loc: ["body", "device_name"], msg, type: "value_error" }] });
    }
    if (snapshot.password !== null && password !== snapshot.password) {
      this.failedAttempt();
      return failure(401, "invalid_password", "Das Passwort stimmt nicht mit dem aus der Sicherung überein.");
    }
    if (snapshot.password === null && password.length < LIMITS.password_min) {
      const msg = `Das Passwort braucht mindestens ${String(LIMITS.password_min)} Zeichen.`;
      return failure(422, "invalid_request", msg, { errors: [{ loc: ["body", "password"], msg, type: "value_error" }] });
    }
    this.candidates.delete(restoreId);
    this.swapIn(snapshot);
    this.password = snapshot.password ?? password;
    this.configured = true;
    this.passwordSource = "app";
    this.devices.clear();
    if (snapshot.password !== null) {
      // Mit dem Passwort aus der Sicherung gelten ihre Geräte weiter.
      for (const known of snapshot.devices) {
        this.devices.set(known.id, { ...known });
      }
    }
    this.restoreState = { state: "done", at, message: null, next: "done", polls: 0 };
    this.restorePrevious = null;
    this.healthPolls = this.restartPolls;
    return json(202, { login: this.newDevice(name) });
  }

  /** `GET /api/restore`: der Stand; nach dem Anwenden erst „pending" (`restartPolls`), dann das Ergebnis. */
  private restoreStatus(): RestoreStatus {
    if (this.restoreState.state === "pending") {
      if (this.restoreState.polls > 0) {
        this.restoreState.polls -= 1;
      } else {
        this.restoreState = { ...this.restoreState, state: this.restoreState.next, at: this.stamp() };
      }
    }
    const previous = this.restorePrevious;
    const open = previous !== null && previous.until > this.now().getTime();
    return { state: this.restoreState.state, at: this.restoreState.at, message: this.restoreState.message, undo_until: open ? new Date(previous.until).toISOString() : null };
  }

  /** `POST /api/restore/undo` (202): zurück zur Datenbank von vor dem Zurückspielen; auch das lässt sich wieder umkehren. */
  private restoreUndo(): FakeResponseData {
    const previous = this.restorePrevious;
    if (previous === null || previous.until <= this.now().getTime()) {
      return failure(404, "not_found", "Es gibt nichts zurückzunehmen.");
    }
    const conflict = this.restoreConflict();
    if (conflict) {
      return conflict;
    }
    const current = this.snapshot();
    this.swapIn(previous.snapshot);
    this.restorePrevious = { snapshot: current, until: previous.until };
    this.restoreState = { state: "pending", at: this.stamp(), message: null, next: "undone", polls: this.restartPolls };
    return json(202, { login: null });
  }

  /** Alles unter `/api/restore`: mit Token für einen laufenden Stowly, ohne nur beim ersten Start. */
  private restoreRequest(request: FakeRequestData, body: unknown): FakeResponseData {
    const { method, path } = request;
    const device = this.deviceFor(request);
    const firstRun = !this.configured;
    if (!device && !firstRun) {
      // Beim ersten Start hätte es geklappt; inzwischen gibt es ein Passwort.
      return request.headers.authorization ? failure(401, "unauthorized", "Das Gerät ist nicht angemeldet.") : failure(409, "conflict", "Es gibt schon ein Haushalts-Passwort. Zurückspielen geht jetzt nur angemeldet.");
    }
    if (method === "PUT" && path === "/api/restore/upload") {
      return this.restoreUpload(request);
    }
    if (method === "POST" && path === "/api/restore/check") {
      return this.restoreCheck(body);
    }
    if (method === "POST" && path === "/api/restore/apply") {
      return this.restoreApply(body, device);
    }
    if (!device) {
      return failure(401, "unauthorized", "Das Gerät ist nicht angemeldet.");
    }
    if (method === "GET" && path === "/api/restore") {
      return json(200, this.restoreStatus());
    }
    if (method === "POST" && path === "/api/restore/undo") {
      return this.restoreUndo();
    }
    if (method === "DELETE" && path === "/api/restore/previous") {
      this.restorePrevious = null;
      return { status: 204, headers: {}, body: null };
    }
    return failure(404, "not_found", "Diesen Aufruf gibt es nicht.");
  }

  // ---------------------------------------------------------------- Stufe B: Home Assistant

  /** `HaConfig`: die wirksame Einrichtung mit Quelle; nie ein Token. */
  haConfig(): HaConfig {
    const env = this.haEnv;
    const app = this.haApp;
    const sensor = { source: (this.haSensorEnv !== null ? "env" : this.haSensorApp ? "app" : "default") as ConfigSource, set: this.haSensorEnv !== null || this.haSensorApp !== null, set_at: this.haSensorApp?.set_at ?? null };
    if (env) {
      return { source: "env", url: env.url, entity: env.entity, token_set: true, token_set_at: null, ca: this.haCa, configured: true, problem: null, sensor };
    }
    const any = app.url !== null || app.entity !== null || app.token !== null;
    const configured = app.url !== null && app.entity !== null && app.token !== null;
    return {
      source: any ? "app" : "default",
      url: app.url,
      entity: app.entity,
      token_set: app.token !== null,
      token_set_at: app.token_set_at,
      ca: this.haCa,
      configured,
      problem: any && !configured ? (app.url === null ? "Für Home Assistant fehlen noch die Adresse und der Token." : app.token === null ? "Für Home Assistant fehlt noch der Token." : "Es ist noch keine Liste gewählt.") : null,
      sensor,
    };
  }

  /** Der Token, mit dem der Sensor liest; null = keiner (der Sensor antwortet dann mit 503). */
  get sensorToken(): string | null {
    return this.haSensorEnv ?? this.haSensorApp?.token ?? null;
  }

  /** Nach einer Änderung: der Zustand des Abgleichs folgt der Einrichtung, der erste Abgleich steht aus. */
  private haChanged(): void {
    const config = this.haConfig();
    this.haStatus = config.configured
      ? { ...this.haStatus, configured: true, problem: null, entity: config.entity, state: "pending", last_ok_at: null, last_error: null, last_error_at: null, linked: config.entity === this.haStatus.entity ? this.haStatus.linked : 0, sensor: config.sensor.set }
      : { ...HA_OFF, problem: config.problem, entity: config.entity, sensor: config.sensor.set };
  }

  /** `PATCH /api/server-config/ha`: nur vorhandene Felder; eine neue Adresse ohne Token löscht den gespeicherten. */
  private patchHa(body: unknown): FakeResponseData {
    if (!object({ url: opt(nullable(text(1, LIMITS.ha_url))), entity: opt(nullable(text(1, 255))), token: opt(nullable(text(1, LIMITS.ha_token))) })(body)) {
      return failure(422, "invalid_request", "Die Anfrage verletzt den Vertrag.", { errors: [] });
    }
    if (this.haEnv) {
      return failure(409, "conflict", "Die Verbindung zu Home Assistant steht in der Umgebung (STOWLY_HA_URL, STOWLY_HA_TOKEN, STOWLY_HA_TODO_ENTITY) und lässt sich nur dort ändern.");
    }
    const changes = body as HaConfigChanges;
    if (typeof changes.url === "string" && !HA_URL.test(changes.url)) {
      const msg = "Erwartet ist http(s)://Rechner[:Port].";
      return failure(422, "invalid_request", msg, { errors: [{ loc: ["body", "url"], msg, type: "value_error" }] });
    }
    if (typeof changes.entity === "string" && !HA_ENTITY.test(changes.entity)) {
      const msg = "Erwartet ist todo.<name>.";
      return failure(422, "invalid_request", msg, { errors: [{ loc: ["body", "entity"], msg, type: "value_error" }] });
    }
    const url = typeof changes.url === "string" ? normalizeHaUrl(changes.url) : changes.url;
    if (typeof changes.token === "string" && (url === null || (url === undefined && this.haApp.url === null))) {
      const msg = "Erst die Adresse von Home Assistant eintragen: Der Token gilt nur für sie.";
      return failure(422, "invalid_request", msg, { errors: [{ loc: ["body", "token"], msg, type: "value_error" }] });
    }
    const app = { ...this.haApp };
    if (url !== undefined && url !== app.url) {
      app.url = url;
      if (changes.token === undefined) {
        // Ein Token gilt nur für die Adresse, für die er eingetragen wurde.
        app.token = null;
        app.token_set_at = null;
      }
    }
    if (changes.entity !== undefined) {
      app.entity = changes.entity;
    }
    if (changes.token !== undefined) {
      app.token = changes.token;
      app.token_set_at = changes.token === null ? null : this.stamp();
    }
    this.haApp = app;
    this.haChanged();
    return json(200, this.haConfig());
  }

  /** `POST /api/server-config/ha/check`: liefert `haCheckResult`; eine Prüfung mit Abstand. */
  private checkHa(body: unknown): FakeResponseData {
    if (!object({ url: opt(text(1, LIMITS.ha_url)), token: opt(text(1, LIMITS.ha_token)) })(body ?? {})) {
      return failure(422, "invalid_request", "Die Anfrage verletzt den Vertrag.", { errors: [] });
    }
    const input = (body ?? {}) as { url?: string; token?: string };
    if (this.haEnv && (input.url !== undefined || input.token !== undefined)) {
      return failure(409, "conflict", "Die Verbindung kommt aus der Umgebung; geprüft wird die von dort.");
    }
    const nowMs = this.now().getTime();
    if (this.lastHaCheck !== null && nowMs - this.lastHaCheck < HA_CHECK_GAP_MS) {
      const wait = Math.max(1, Math.ceil((this.lastHaCheck + HA_CHECK_GAP_MS - nowMs) / 1000));
      return failure(429, "rate_limited", "Bitte kurz warten, dann noch einmal prüfen.", { retry_after_s: wait }, { "retry-after": String(wait) });
    }
    const config = this.haConfig();
    if (input.url === undefined && config.url === null) {
      const msg = "Keine Adresse angegeben, und in der App ist keine eingetragen.";
      return failure(422, "invalid_request", msg, { errors: [{ loc: ["body", "url"], msg, type: "value_error" }] });
    }
    this.lastHaCheck = nowMs;
    this.haChecks.push({ url: input.url ?? null, token: input.token !== undefined });
    // Der gespeicherte Token geht nur an seine Adresse.
    const hasToken = input.token !== undefined || (config.token_set && (input.url === undefined || normalizeHaUrl(input.url) === config.url));
    if (!hasToken && this.haCheckResult.state === "ok") {
      return json(200, { ...this.haCheckResult, state: "token_needed", message: "Home Assistant antwortet; für die Listen braucht es den Token.", lists: [], entity_found: null });
    }
    const entity = config.entity;
    const found = entity === null ? null : this.haCheckResult.lists.some((list) => list.entity_id === entity);
    const message = found === false && this.haCheckResult.state === "ok" ? `${this.haCheckResult.message} Die Liste ${entity ?? ""} gibt es dort nicht.` : this.haCheckResult.message;
    return json(200, { ...this.haCheckResult, message, entity_found: found });
  }

  /** `/api/server-config/ha/sensor-token`: erzeugen, anzeigen, entfernen; aus der Umgebung 409. */
  private sensorTokenRequest(method: string): FakeResponseData {
    if (this.haSensorEnv !== null) {
      return failure(409, "conflict", "Der Sensor-Token kommt aus der Umgebung (STOWLY_HA_SUMMARY_TOKEN).");
    }
    if (method === "POST") {
      this.haSensorApp = { token: hex(32), set_at: this.stamp() };
      this.haStatus = { ...this.haStatus, sensor: true };
      return json(201, { token: this.haSensorApp.token });
    }
    if (method === "GET") {
      return this.haSensorApp ? json(200, { token: this.haSensorApp.token }) : failure(404, "not_found", "Es gibt noch keinen Sensor-Token aus der App; bitte einen erzeugen.");
    }
    if (method === "DELETE") {
      this.haSensorApp = null;
      this.haStatus = { ...this.haStatus, sensor: false };
      return { status: 204, headers: {}, body: null };
    }
    return failure(405, "invalid_request", "Diese Methode ist hier nicht erlaubt.", null, { allow: "GET, POST, DELETE" });
  }

  /** Alles unter `/api/server-config/ha`. */
  private haRequest(method: string, path: string, body: unknown): FakeResponseData {
    if (path === "/api/server-config/ha") {
      if (method === "GET") {
        return json(200, this.haConfig());
      }
      if (method === "PATCH") {
        return this.patchHa(body);
      }
      return failure(405, "invalid_request", "Diese Methode ist hier nicht erlaubt.", null, { allow: "GET, PATCH" });
    }
    if (path === "/api/server-config/ha/check" && method === "POST") {
      return this.checkHa(body);
    }
    if (path === "/api/server-config/ha/sensor-token") {
      return this.sensorTokenRequest(method);
    }
    return failure(404, "not_found", "Diesen Aufruf gibt es nicht.");
  }

  // ---------------------------------------------------------------- Seit 0.6.0: KI-Vorschläge

  /** Der Schlüssel aus der App, wie er gespeichert ist; null = keiner. Steht in keiner Antwort. */
  get aiKey(): string | null {
    return this.aiAppKey;
  }

  /** Die Datei mit dem Schlüssel ist weg, der Merker bleibt: wie nach dem Zurückspielen einer Sicherung. */
  loseAiKey(): void {
    this.aiAppKey = null;
  }

  /** Alle Aufträge sind weg, wie nach `COOK_JOB_TTL_S` oder einem Neustart. */
  expireCookJobs(): void {
    this.cookJobs.clear();
  }

  /** Anfragen heute (Tag in `timezone`); ein neuer Tag beginnt bei null. */
  private aiUsedToday(): number {
    const today = dayIn(this.timezone, this.now());
    if (this.aiUsage.day !== today) {
      this.aiUsage = { day: today, count: 0 };
    }
    return this.aiUsage.count;
  }

  /** `AiConfig`: die wirksame Einrichtung mit Quelle; nie der Schlüssel. */
  aiConfig(): AiConfig {
    const env = this.aiEnvKey !== null;
    const app = this.aiAppKey !== null;
    return {
      // Wie der Server: Ein Schlüssel, der nach dem Zurückspielen fehlt, kam aus der App.
      source: env ? "env" : app || this.aiKeySetAt !== null ? "app" : "default",
      key_set: env || app,
      key_set_at: !env && app ? this.aiKeySetAt : null,
      model: this.aiModel ?? AI_MODEL_DEFAULT,
      model_source: this.aiModel === null ? "default" : "app",
      configured: env || app,
      problem: !env && !app && this.aiKeySetAt !== null ? FAKE_AI_KEY_LOST : null,
      used_today: this.aiUsedToday(),
      daily_limit: FAKE_AI_DAILY_MAX,
    };
  }

  /** `PATCH /api/server-config/ai`: nur vorhandene Felder; `key: null` entfernt den Schlüssel. */
  private patchAi(body: unknown): FakeResponseData {
    if (!object({ key: opt(nullable(text(1, LIMITS.ai_key))), model: opt(oneOf(...AI_MODELS)) })(body ?? {})) {
      return failure(422, "invalid_request", "Die Anfrage verletzt den Vertrag.", { errors: [] });
    }
    const changes = (body ?? {}) as { key?: string | null; model?: AiModel };
    if (changes.key !== undefined && this.aiEnvKey !== null) {
      return failure(409, "conflict", "Der API-Schlüssel kommt aus der Umgebung (STOWLY_ANTHROPIC_API_KEY) und lässt sich nur dort ändern.");
    }
    const problem = typeof changes.key === "string" ? aiKeyProblem(changes.key) : null;
    if (problem !== null) {
      // Wie der Server: die Stelle und ein Satz, nie der Wert.
      return failure(422, "invalid_request", problem, { errors: [{ loc: ["body", "key"], msg: problem, type: "value_error" }] });
    }
    if (changes.key !== undefined) {
      this.aiAppKey = changes.key === null ? null : changes.key.trim();
      this.aiKeySetAt = changes.key === null ? null : this.stamp();
    }
    if (changes.model !== undefined) {
      this.aiModel = changes.model;
    }
    return json(200, this.aiConfig());
  }

  /** `POST /api/server-config/ai/check`: liefert `aiCheckState`; eine Prüfung mit Abstand. */
  private checkAi(body: unknown): FakeResponseData {
    if (!object({ key: opt(text(1, LIMITS.ai_key)), model: opt(oneOf(...AI_MODELS)) })(body ?? {})) {
      return failure(422, "invalid_request", "Die Anfrage verletzt den Vertrag.", { errors: [] });
    }
    const input = (body ?? {}) as { key?: string; model?: AiModel };
    if (input.key !== undefined && this.aiEnvKey !== null) {
      return failure(409, "conflict", "Der Schlüssel kommt aus der Umgebung; geprüft wird der von dort.");
    }
    const problem = input.key === undefined ? null : aiKeyProblem(input.key);
    if (problem !== null) {
      return failure(422, "invalid_request", problem, { errors: [{ loc: ["body", "key"], msg: problem, type: "value_error" }] });
    }
    const nowMs = this.now().getTime();
    if (this.lastAiCheck !== null && nowMs - this.lastAiCheck < AI_CHECK_GAP_MS) {
      const wait = Math.max(1, Math.ceil((this.lastAiCheck + AI_CHECK_GAP_MS - nowMs) / 1000));
      return failure(429, "rate_limited", "Bitte kurz warten, dann noch einmal prüfen.", { retry_after_s: wait }, { "retry-after": String(wait) });
    }
    if (input.key === undefined && !this.aiConfig().configured) {
      return failure(503, "not_configured", "Es ist noch kein API-Schlüssel eingetragen.");
    }
    this.lastAiCheck = nowMs;
    const model = input.model ?? this.aiModel ?? AI_MODEL_DEFAULT;
    this.aiChecks.push({ key: input.key !== undefined, model });
    return json(200, { state: this.aiCheckState, message: AI_CHECK_MESSAGES[this.aiCheckState], model });
  }

  /** Alles unter `/api/server-config/ai`. */
  private aiRequest(method: string, path: string, body: unknown): FakeResponseData {
    if (path === "/api/server-config/ai") {
      if (method === "GET") {
        return json(200, this.aiConfig());
      }
      if (method === "PATCH") {
        return this.patchAi(body);
      }
      return failure(405, "invalid_request", "Diese Methode ist hier nicht erlaubt.", null, { allow: "GET, PATCH" });
    }
    if (path === "/api/server-config/ai/check" && method === "POST") {
      return this.checkAi(body);
    }
    return failure(404, "not_found", "Diesen Aufruf gibt es nicht.");
  }

  /** Die Produkte mit Namen, von denen etwas im Bestand ist: die gewählten zuerst, dann nach Namen. */
  private namedStock(focus: readonly string[] = []): Product[] {
    const stocked = new Set<string>();
    for (const pkg of this.tables.packages.values()) {
      if (pkg.removed_at === null) {
        stocked.add(pkg.product_id);
      }
    }
    const rank = (product: Product) => (focus.includes(product.id) ? 0 : 1);
    return [...this.tables.products.values()]
      .filter((product) => product.deleted_at === null && product.merged_into === null && product.name.trim() !== "" && stocked.has(product.id))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "de"));
  }

  /** Ein Vorschlag aus den ersten Produkten des Bestands, mit ihren Namen in Stowly. */
  private defaultIdeas(focus: readonly string[]): CookIdeas {
    const stocked = this.namedStock(focus);
    const used = stocked.slice(0, 2);
    return {
      ideas: [
        {
          title: `Resteessen mit ${used.map((product) => product.name).join(" und ")}`,
          summary: "Ein Vorschlag der Nachbildung.",
          minutes: 20,
          uses: used.map((product) => ({ product_id: product.id, name: product.name })),
          missing: ["Zwiebel"],
          steps: ["Alles vorbereiten.", "Garen und abschmecken."],
          search: used[0]?.name ?? "Resteessen",
        },
      ],
      model: this.aiModel ?? AI_MODEL_DEFAULT,
      fallback: false,
      stock_count: Math.min(stocked.length, FAKE_COOK_STOCK_MAX),
      truncated: stocked.length > FAKE_COOK_STOCK_MAX,
    };
  }

  /** `POST /api/cook/ideas`: die Prüfungen in der Reihenfolge des Servers, dann ein Auftrag (202). */
  private startCook(device: FakeDevice, body: unknown): FakeResponseData {
    if (!object({ wish: opt(text(0, LIMITS.cook_wish)), focus: opt(listOf(uuid, 0, LIMITS.cook_focus)) })(body ?? {})) {
      return failure(422, "invalid_request", "Die Anfrage verletzt den Vertrag.", { errors: [] });
    }
    const input = (body ?? {}) as { wish?: string; focus?: string[] };
    if (!this.aiConfig().configured) {
      return failure(503, "not_configured", "Für Vorschläge von Claude fehlt der API-Schlüssel.", { reason: this.aiKeySetAt !== null && this.aiEnvKey === null ? "lost" : "missing" });
    }
    if (this.namedStock().length === 0) {
      return failure(409, "conflict", "Im Bestand ist kein Produkt mit Namen.");
    }
    const nowMs = this.now().getTime();
    const limited = (reason: string, message: string, wait: number) =>
      failure(429, "rate_limited", message, { reason, retry_after_s: wait }, { "retry-after": String(wait) });
    if ([...this.cookJobs.values()].some((entry) => entry.job.state === "running")) {
      return limited("busy", "Gerade läuft schon eine Anfrage.", FAKE_BUSY_RETRY_S);
    }
    const last = this.cookStartedAt.get(device.id);
    if (last !== undefined && nowMs - last < AI_DEVICE_GAP_S * 1000) {
      return limited("too_soon", "Dieses Gerät hat eben erst gefragt.", Math.max(1, Math.ceil((last + AI_DEVICE_GAP_S * 1000 - nowMs) / 1000)));
    }
    if (this.aiUsedToday() >= FAKE_AI_DAILY_MAX) {
      return limited("daily_limit", "Für heute sind alle Anfragen verbraucht.", secondsUntilNextDay(this.timezone, nowMs));
    }
    // Erst jetzt zählt die Anfrage für heute.
    this.aiUsage = { ...this.aiUsage, count: this.aiUsage.count + 1 };
    this.cookStartedAt.set(device.id, nowMs);
    const focus = [...new Set(input.focus ?? [])];
    const job: CookJob = {
      id: hex(16),
      state: "running",
      started_at: this.stamp(),
      finished_at: null,
      result: null,
      problem: null,
      used_today: this.aiUsage.count,
      daily_limit: FAKE_AI_DAILY_MAX,
    };
    this.cookJobs.set(job.id, { device_id: device.id, job, polls: 0, focus });
    this.cookStarts.push({ device_id: device.id, wish: (input.wish ?? "").trim(), focus });
    return json(202, job);
  }

  /** `GET /api/cook/ideas/{id}`: nur für das Gerät, das ihn startete; nach `cookRunningPolls` Abfragen fertig. */
  private cookJob(device: FakeDevice, id: string): FakeResponseData {
    if (!COOK_JOB_ID.test(id)) {
      return failure(422, "invalid_request", "Keine Kennung eines Auftrags.", { errors: [{ loc: ["path", "job_id"], msg: "Keine Kennung eines Auftrags.", type: "string_pattern_mismatch" }] });
    }
    const entry = this.cookJobs.get(id);
    if (!entry || entry.device_id !== device.id) {
      return failure(404, "not_found", "Diesen Auftrag gibt es nicht (mehr).");
    }
    if (entry.job.state === "running") {
      if (entry.polls < this.cookRunningPolls) {
        entry.polls += 1;
      } else {
        const problem = this.cookProblem;
        if (problem !== null && CREDITED_FAILURES.has(problem.reason)) {
          // Anthropic hat nichts berechnet: Die Anfrage zählt nicht.
          this.aiUsedToday();
          this.aiUsage = { ...this.aiUsage, count: Math.max(0, this.aiUsage.count - 1) };
        }
        entry.job = {
          ...entry.job,
          state: problem === null ? "done" : "failed",
          finished_at: this.stamp(),
          result: problem === null ? (this.cookOutcome ?? this.defaultIdeas(entry.focus)) : null,
          problem,
          used_today: this.aiUsedToday(),
        };
      }
    }
    return json(200, entry.job);
  }

  /** Alle Kopplungen, älteste zuerst. */
  get pairingList(): FakePairing[] {
    return [...this.pairings.values()].map((pairing) => this.expired(pairing));
  }

  private pairingOf(id: string): FakePairing {
    const pairing = this.pairings.get(id);
    if (!pairing) {
      throw new Error(`Die Kopplung ${id} gibt es nicht.`);
    }
    return this.expired(pairing);
  }

  /** Läuft die Frist ab, ohne dass der Pi gekoppelt wurde, ist die Kopplung abgelaufen. */
  private expired(pairing: FakePairing): FakePairing {
    const waiting = pairing.state === "waiting" || pairing.state === "installing";
    if (waiting && Date.parse(pairing.expires_at) <= this.now().getTime()) {
      pairing.state = "expired";
    }
    return pairing;
  }

  /** Der Pi meldet sich gleich nach dem Laden des Pakets (`POST /api/pi/pair/start`): "installing", die Frist beginnt neu. */
  startPairing(id: string, hostname = "stowly-pi"): void {
    const pairing = this.pairingOf(id);
    if (pairing.state !== "waiting" && pairing.state !== "installing") {
      throw new Error(`Die Kopplung ${id} wartet nicht (${pairing.state}).`);
    }
    pairing.state = "installing";
    pairing.expires_at = new Date(this.now().getTime() + PI_PAIRING_TTL_MS).toISOString();
    pairing.pi = { hostname, addresses: [], model: null, printer_found: false, version: "0.3.0", not_after: null };
  }

  /**
   * Der Pi ist fertig (`POST /api/pi/pair`): Der Server legt einen direkten Drucker an (oder
   * übernimmt den gewählten, dann ändert sich nur die Verbindung) und meldet "paired". Der Drucker
   * kommt wie jeder andere mit dem nächsten Abgleich. Liefert ihn.
   */
  completePairing(id: string, pi: FakePi = {}): Printer {
    const pairing = this.pairingOf(id);
    if (pairing.state !== "waiting" && pairing.state !== "installing") {
      throw new Error(`Die Kopplung ${id} wartet nicht (${pairing.state}).`);
    }
    const hostname = pi.hostname ?? pairing.pi?.hostname ?? "stowly-pi";
    const address = pi.address ?? "192.168.1.20";
    const model = pi.model === undefined ? "QL-570" : pi.model;
    const direct = {
      urls: [`https://${address}:8443`, `https://${hostname}.local:8443`, `http://${address}:8080`],
      token: `pi-token-${hostname}`,
      printer: null,
    };
    const printerId = pairing.printer_id ?? newUuid();
    if (pairing.printer_id === null) {
      this.act({ type: "printer.create", printer_id: printerId, name: pi.name ?? model ?? "Raspberry Pi", connection: "direct", direct });
    } else {
      this.act({ type: "printer.update", printer_id: printerId, changes: { direct } });
    }
    const notAfter = pi.not_after ?? new Date(this.now().getTime() + PI_CERT_DAYS * DAY_MS).toISOString();
    pairing.state = "paired";
    pairing.printer_id = printerId;
    pairing.pi = { hostname, addresses: [address], model, printer_found: model !== null, version: pi.version ?? "0.3.0", not_after: notAfter };
    const printer = this.tables.printers.get(printerId);
    if (!printer) {
      throw new Error("Der Drucker ließ sich nicht anlegen.");
    }
    return printer;
  }

  /** Die Frist eines Codes ist um, ohne dass der Pi gekoppelt wurde. */
  expirePairing(id: string): void {
    const pairing = this.pairingOf(id);
    pairing.expires_at = new Date(this.now().getTime() - 1).toISOString();
    this.expired(pairing);
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
    this.shopping = new ShoppingRules();
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

  /** Sperrt alle Tokens (oder das eines Geräts). Mit dem Token endet das Push-Abo des Geräts. */
  revoke(deviceId?: string): void {
    for (const device of this.devices.values()) {
      if (deviceId === undefined || device.id === deviceId) {
        device.revoked_at ??= this.stamp();
        this.pushSubscriptions.delete(device.id);
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
      settings: {
        zone_mode: "primary",
        primary_zone_id: zone.id,
        warn_days: 14,
        trash_retention_days: 30,
        default_printer_id: null,
        notify_time: "17:00",
        updated_at: at,
      },
    };
    this.rev += 1;
    this.settingsRev = this.rev;
    const templates: LabelTemplate[] = [
      { key: "package", hash: "0000000000000001", body: { schema: 1, name: "package-62x29", elements: [] }, updated_at: at },
      { key: "zone", hash: "0000000000000002", body: { schema: 1, name: "zone-62x29", elements: [] }, updated_at: at },
    ];
    this.bundledTemplates = templates;
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
      // Ein Sicherungspunkt (6.3): Was der Befehl tut und was der Server daraus ableitet (7.6),
      // gilt zusammen oder gar nicht.
      const draft = new Draft(this.tables);
      const rollback = this.shopping.savepoint();
      let outcome: ReturnType<typeof applyCommand>;
      try {
        // Die Uhr von `done` eines Eintrags kann den Befehl um dieses Feld kürzen (7.1).
        const prepared = this.shopping.prepare(command as Command, effectiveAt);
        const before = this.shopping.observe(draft, prepared);
        outcome = applyCommand(draft, prepared, {
          at: effectiveAt,
          device_id: device?.id ?? null,
          authoritative: true,
          lookup_enabled: this.lookupEnabled,
        });
        if (outcome.status !== "rejected") {
          this.shopping.apply(draft, prepared, before, effectiveAt);
        }
      } catch {
        outcome = { status: "rejected", code: "internal" };
      }
      if (outcome.status === "rejected") {
        rollback();
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
      const answer = this.offStored.get(code) ?? this.offAnswer(code);
      // Die Daten füllen nur leere Felder (Abschnitt 10).
      const filled: Product =
        answer.state === "found"
          ? {
              ...product,
              lookup: "found",
              name: product.name === "" ? answer.name : product.name,
              brand: product.brand === "" ? answer.brand : product.brand,
              quantity: product.quantity === "" ? answer.quantity : product.quantity,
              image: product.image ?? answer.image_id,
            }
          : { ...product, lookup: "not_found" };
      this.put("products", filled);
    }
  }

  /**
   * Was Open Food Facts in der Nachbildung zu einem Barcode sagt: was in `offProducts` steht, sonst
   * gerade Endziffer = gefunden (ohne Bild), ungerade = unbekannt.
   */
  private offAnswer(barcode: string): LookupResult {
    const known = this.offProducts.get(barcode);
    const base = { barcode, image_id: null, fetched_at: this.stamp(), throttled: false };
    if (known) {
      return { ...base, state: "found", name: known.name, brand: known.brand ?? "", quantity: known.quantity ?? "", image_id: known.image_id ?? null };
    }
    return Number(barcode.at(-1)) % 2 === 0
      ? { ...base, state: "found", name: `Beispielprodukt ${barcode.slice(-4)}`, brand: "Beispielmarke", quantity: "500 g" }
      : { ...base, state: "not_found", name: "", brand: "", quantity: "" };
  }

  /** Prüft Barcode und `wait` wie der Server; liefert die Antworten ohne Abfrage (ladenintern, aus) oder null. */
  private lookupPrecheck(barcode: string, query: string): FakeResponseData | null {
    const wait = new URLSearchParams(query).get("wait");
    const waitS = wait === null ? 4 : Number(wait);
    if (!isValidBarcode(barcode) || !Number.isInteger(waitS) || waitS < 0 || waitS > 8) {
      return failure(400, "invalid_request", "Barcode oder Wartezeit sind ungültig.");
    }
    const empty = { barcode, name: "", brand: "", quantity: "", image_id: null, fetched_at: null, throttled: false };
    if (isStoreInternalBarcode(barcode)) {
      return json(200, { ...empty, state: "skipped" });
    }
    return this.lookupEnabled ? null : json(200, { ...empty, state: "disabled" });
  }

  /** `GET /api/lookup/{barcode}?wait=0..8`: Open Food Facts nachgespielt wie oben, sofort beantwortet. */
  private lookupNow(barcode: string, query: string): FakeResponseData {
    const early = this.lookupPrecheck(barcode, query);
    if (early) {
      return early;
    }
    return json(200, { ...(this.offStored.get(barcode) ?? this.offAnswer(barcode)), throttled: false });
  }

  /**
   * `POST /api/lookup/{barcode}/refresh` (seit 0.5.0): fragt jetzt neu, höchstens einmal je Minute
   * und Barcode, sonst der gespeicherte Stand mit `throttled`. Ein Fund ersetzt das gespeicherte
   * Ergebnis; „unbekannt" überschreibt keinen Fund. Kein Produkt ändert sich.
   */
  private refreshLookup(barcode: string, query: string): FakeResponseData {
    const early = this.lookupPrecheck(barcode, query);
    if (early) {
      return early;
    }
    const nowMs = this.now().getTime();
    const last = this.refreshedAt.get(barcode);
    const stored = this.offStored.get(barcode);
    if (last !== undefined && nowMs - last < FAKE_REFRESH_GAP_MS) {
      return json(200, { ...(stored ?? this.offAnswer(barcode)), throttled: true });
    }
    this.refreshedAt.set(barcode, nowMs);
    const answer = this.offAnswer(barcode);
    if (answer.state === "found" || stored?.state !== "found") {
      this.offStored.set(barcode, answer);
    }
    return json(200, answer);
  }

  /** `PUT /api/products/{id}/image` (seit 0.5.0): nur Bilder, die der Server hat; neuer `rev`. */
  private setProductImage(productId: string, body: unknown): FakeResponseData {
    if (!object({ image_id: req(nullable(text(1, 100))) })(body)) {
      return failure(422, "invalid_request", "Die Anfrage verletzt den Vertrag.", { errors: [] });
    }
    const product = this.tables.products.get(productId);
    if (!product || product.deleted_at !== null || product.merged_into !== null) {
      return failure(404, "not_found", "Das Produkt gibt es nicht.");
    }
    const imageId = (body as { image_id: string | null }).image_id;
    if (imageId !== null && !this.images.has(imageId)) {
      return failure(422, "invalid_request", "Dieses Bild hat Stowly nicht gespeichert.", { errors: [] });
    }
    const next: Product = { ...product, image: imageId, updated_at: this.stamp() };
    this.put("products", next);
    return json(200, next);
  }

  // ---------------------------------------------------------------- Etiketten gestalten (seit 0.5.0)

  /** `LabelDesignState`: die gültige Gestaltung, ob es die Vorgabe ist, die `hash` der Vorlagen, der Katalog. */
  labelDesignState(): LabelDesignState {
    const templates = this.tables.label_templates;
    return {
      design: JSON.parse(JSON.stringify(this.labelDesign?.design ?? FAKE_DEFAULT_DESIGN)) as LabelDesign,
      is_default: this.labelDesign === null,
      updated_at: this.labelDesign?.updated_at ?? null,
      templates: { package: templates.get("package")?.hash ?? "", zone: templates.get("zone")?.hash ?? "" },
      papers: FAKE_PAPERS.map((paper) => ({ ...paper })),
    };
  }

  /** Schreibt eine Vorlage, wenn sich ihr `hash` ändert: Dann bekommen alle Geräte sie mit dem Sync. */
  private putTemplate(template: LabelTemplate): void {
    if (this.tables.label_templates.get(template.key)?.hash !== template.hash) {
      this.put("label_templates", { ...template, updated_at: this.stamp() });
    }
  }

  private labelDesignRequest(method: string, body: unknown): FakeResponseData {
    if (method === "GET") {
      return json(200, this.labelDesignState());
    }
    if (method === "DELETE") {
      this.labelDesign = null;
      for (const template of this.bundledTemplates) {
        this.putTemplate(template);
      }
      return json(200, this.labelDesignState());
    }
    if (method !== "PUT") {
      return failure(405, "invalid_request", "Diese Methode ist hier nicht erlaubt.", null, { allow: "GET, PUT, DELETE" });
    }
    const wanted = isRecord(body) ? body : {};
    // Wie der Server: der Satz, und die Stelle in `details.errors[0].loc` (welche Gestaltung).
    for (const kind of ["package", "zone"] as const) {
      const problem = fakeLayoutProblem(kind, wanted.paper, wanted[kind]);
      if (problem !== null) {
        return failure(422, "invalid_request", problem, { errors: [{ loc: ["body", kind], msg: problem, type: "label_design" }] });
      }
    }
    const design = { paper: wanted.paper, package: wanted.package, zone: wanted.zone } as LabelDesign;
    if (isFakeDefault(design)) {
      // Die Vorgabe zu speichern heißt wie beim Server: keine eigene Gestaltung.
      return this.labelDesignRequest("DELETE", undefined);
    }
    this.labelDesign = { design, updated_at: this.stamp() };
    for (const kind of ["package", "zone"] as const) {
      const template = fakeTemplate(kind, design);
      this.putTemplate({ key: kind, hash: fakeHash(JSON.stringify(template)), body: template, updated_at: this.stamp() });
    }
    return json(200, this.labelDesignState());
  }

  /** `POST /api/labels/preview`: ein weißes Feld in der Größe des Papiers, so wie man es liest. */
  private labelPreview(body: unknown): FakeResponseData {
    const wanted = isRecord(body) ? body : {};
    this.previews.push(wanted);
    const kind = wanted.kind === "zone" ? "zone" : wanted.kind === "package" ? "package" : null;
    const problem = kind === null ? "Unbekannte Etikettenart." : fakeLayoutProblem(kind, wanted.paper, wanted.layout);
    if (problem !== null) {
      return failure(422, "invalid_request", problem, { errors: [{ loc: ["body", "layout"], msg: problem, type: "label_design" }] });
    }
    const paper = fakePaper(String(wanted.paper)) as LabelPaper;
    const layout = wanted.layout as LabelLayout;
    const size = imageSize(paper, layout.length_mm, true);
    // Eine einzeilige Überschrift mit langem Namen passt nur verkleinert: ein Hinweis wie beim Server.
    const title = layout.fields.find((field) => field.field === "title");
    const notes = title && (title.lines ?? 1) === 1 ? ["Name auf 3,0 mm verkleinert und gekürzt."] : [];
    const preview: LabelPreview = { png: toBase64(framePng(size.width, size.height)), width_px: size.width, height_px: size.height, notes };
    return json(200, preview);
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
        if (full && table === "shopping_items" && isExpiredShoppingItem(row as ShoppingItem, packageLimit)) {
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
    const changes: Changes = {
      products: [],
      zones: [],
      packages: [],
      printers: [],
      printer_status: [],
      print_jobs: [],
      label_templates: [],
      shopping_items: [],
      settings: null,
    };
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

  /** Die Sperre nach zu vielen Fehlversuchen (Abschnitt 5): die Antwort 429, oder null, wenn keine gilt. */
  private lockout(): FakeResponseData | null {
    const nowMs = this.now().getTime();
    if (nowMs >= this.lockedUntil) {
      return null;
    }
    const wait = Math.ceil((this.lockedUntil - nowMs) / 1000);
    return failure(429, "rate_limited", "Zu viele Fehlversuche.", { retry_after_s: wait }, { "retry-after": String(wait) });
  }

  /** Ein Fehlversuch zählt; nach 5 in 5 Minuten gilt 60 Sekunden die Sperre für alle. */
  private failedAttempt(): void {
    const nowMs = this.now().getTime();
    this.failedLogins = [...this.failedLogins.filter((at) => nowMs - at < 300_000), nowMs];
    if (this.failedLogins.length >= 5) {
      this.failedLogins = [];
      this.lockedUntil = nowMs + 60_000;
    }
  }

  /** Ein neues Gerät mit eigenem Token: die Antwort der Anmeldung und des ersten Passworts. */
  private newDevice(name: string): LoginResponse {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const device: FakeDevice = { id: newUuid(), name, token, created_at: this.stamp(), last_seen_at: null, revoked_at: null, last_command_ms: 0 };
    this.devices.set(device.id, device);
    return { token, device: this.describe(device, device) };
  }

  private login(body: unknown): FakeResponseData {
    if (!this.configured) {
      return failure(503, "not_configured", "Auf dem Server ist noch kein Haushalts-Passwort gesetzt.");
    }
    const locked = this.lockout();
    if (locked) {
      return locked;
    }
    if (!object({ password: req(text(1, 200)), device_name: req(text(1, 60)) })(body)) {
      return failure(422, "invalid_request", "Die Anfrage verletzt den Vertrag.", { errors: [] });
    }
    const { password, device_name: name } = body as { password: string; device_name: string };
    if (password !== this.password) {
      this.failedAttempt();
      return failure(401, "invalid_password", "Das Passwort stimmt nicht.");
    }
    return json(200, this.newDevice(name));
  }

  /** `POST /api/setup/password` (11.6): das erste Passwort, nur solange es keines gibt; die Antwort gleicht der Anmeldung. */
  private setupPassword(body: unknown): FakeResponseData {
    // Die Form prüft der Server vor allem anderen (422), wie bei jedem Rumpf.
    if (!object({ password: req(text(LIMITS.password_min, LIMITS.password)), device_name: req(text(1, 60)) })(body)) {
      return failure(422, "invalid_request", "Die Anfrage verletzt den Vertrag.", { errors: [] });
    }
    if (this.configured) {
      return failure(409, "conflict", "Es gibt schon ein Haushalts-Passwort.");
    }
    const locked = this.lockout();
    if (locked) {
      return locked;
    }
    const { password, device_name: name } = body as { password: string; device_name: string };
    this.password = password;
    this.configured = true;
    this.passwordSource = "app";
    return json(200, this.newDevice(name));
  }

  /** `POST /api/auth/password` (Abschnitt 5): Ein falsches bisheriges Passwort zählt in der Bremse und meldet nie ab. */
  private changePassword(body: unknown): FakeResponseData {
    if (!object({ current_password: req(text(1, LIMITS.password)), new_password: req(text(LIMITS.password_min, LIMITS.password)) })(body)) {
      return failure(422, "invalid_request", "Die Anfrage verletzt den Vertrag.", { errors: [] });
    }
    const locked = this.lockout();
    if (locked) {
      return locked;
    }
    if (this.passwordSource === "env") {
      return failure(409, "conflict", "Das Passwort kommt aus der Umgebung (STOWLY_PASSWORD) und lässt sich nur dort ändern.");
    }
    const { current_password: current, new_password: next } = body as { current_password: string; new_password: string };
    if (current !== this.password) {
      this.failedAttempt();
      return failure(401, "invalid_password", "Das bisherige Passwort stimmt nicht.");
    }
    this.password = next;
    this.failedLogins = [];
    return { status: 204, headers: {}, body: null };
  }

  // ---------------------------------------------------------------- Push und Integrationen

  /** `/api/push/…` (docs/sync-protokoll.md 11.3, docs/integrationen.md 4). */
  private push(method: string, path: string, device: FakeDevice, body: unknown): FakeResponseData {
    const known = ["GET /api/push/key", "PUT /api/push/subscription", "DELETE /api/push/subscription", "POST /api/push/test"];
    if (!known.includes(`${method} ${path}`)) {
      return failure(404, "not_found", "Diesen Aufruf gibt es nicht.");
    }
    if (!this.pushConfigured) {
      return failure(503, "not_configured", "Der Server hat keinen Kontakt für die Push-Dienste.");
    }
    if (path === "/api/push/key") {
      return json(200, { public_key: this.pushKey });
    }
    if (path === "/api/push/subscription" && method === "DELETE") {
      this.pushSubscriptions.delete(device.id);
      return { status: 204, headers: {}, body: null };
    }
    if (path === "/api/push/subscription") {
      const error = checkPushSubscription(body);
      if (error) {
        return failure(422, "invalid_request", error.msg, { errors: [{ loc: error.loc, msg: error.msg, type: "value_error" }] });
      }
      const subscription = body as PushSubscriptionInput;
      // Gehört derselbe Endpunkt einem anderen Gerät, wechselt er zu diesem.
      for (const [owner, existing] of [...this.pushSubscriptions]) {
        if (existing.endpoint === subscription.endpoint) {
          this.pushSubscriptions.delete(owner);
        }
      }
      this.pushSubscriptions.set(device.id, { endpoint: subscription.endpoint, keys: { ...subscription.keys }, origin: subscription.origin });
      return { status: 204, headers: {}, body: null };
    }
    // POST /api/push/test
    const subscription = this.pushSubscriptions.get(device.id);
    if (!subscription) {
      return failure(404, "not_found", "Dieses Gerät hat kein Push-Abo.");
    }
    const nowMs = this.now().getTime();
    const last = this.pushTests.get(device.id);
    if (last !== undefined && nowMs - last < PUSH_TEST_INTERVAL_S * 1000) {
      const wait = Math.max(1, Math.ceil((last + PUSH_TEST_INTERVAL_S * 1000 - nowMs) / 1000));
      return failure(429, "rate_limited", "Höchstens eine Testnachricht in zehn Sekunden.", { retry_after_s: wait }, { "retry-after": String(wait) });
    }
    this.pushTests.set(device.id, nowMs);
    this.pushMessages.push({ device_id: device.id, endpoint: subscription.endpoint, payload: pushTestPayload(subscription.origin) });
    const result = PUSH_TEST_RESULTS[this.pushTestStatus];
    if (result.status === "gone") {
      // 404 oder 410 vom Push-Dienst: Das Abo ist erloschen, der Server löscht es (4.7).
      this.pushSubscriptions.delete(device.id);
    }
    return json(200, result);
  }

  /** `/api/update/…` (Protokoll 11.5, docs/integrationen.md 10.2 und 10.5). */
  private update(method: string, path: string, device: FakeDevice, body: unknown): FakeResponseData {
    if (path !== "/api/update/check" && path !== "/api/update/install") {
      return failure(404, "not_found", "Diesen Aufruf gibt es nicht.");
    }
    if (method !== "POST") {
      return failure(405, "invalid_request", "Diese Methode ist hier nicht erlaubt.", null, { allow: "POST" });
    }
    if (path === "/api/update/check") {
      if (this.effectiveUpdateRepo === null) {
        return failure(503, "not_configured", UPDATE_OFF);
      }
      const nowMs = this.now().getTime();
      const last = this.lastUpdateCheck;
      if (last !== null && nowMs - last < UPDATE_CHECK_MIN_GAP_S * 1000) {
        const wait = Math.max(1, Math.ceil((last + UPDATE_CHECK_MIN_GAP_S * 1000 - nowMs) / 1000));
        return failure(429, "rate_limited", "Nach Updates suchen geht höchstens einmal je Minute.", { retry_after_s: wait }, { "retry-after": String(wait) });
      }
      this.lastUpdateCheck = nowMs;
      this.checkGithub();
      return json(200, this.updateStatus());
    }
    // POST /api/update/install: zuerst die Form (422, wie die Prüfung des Rumpfs im Server), dann 10.5 der Reihe nach.
    if (!object({ version: req((value) => typeof value === "string" && value.length <= 40 && VERSION_RE.test(value)) })(body)) {
      return failure(422, "invalid_request", "Die Anfrage entspricht nicht dem Vertrag.", { errors: [] });
    }
    const version = (body as { version: string }).version;
    const status = this.updateStatus();
    if (!status.configured) {
      return failure(503, "not_configured", UPDATE_OFF);
    }
    if (!status.updater_ready) {
      return failure(503, "not_configured", "Der Updater auf dem Rechner meldet sich nicht (docs/betrieb.md, Abschnitt 9).");
    }
    if (status.state === "requested" || status.state === "installing") {
      return failure(409, "conflict", "Ein Update ist schon angefordert.");
    }
    if (version !== status.latest) {
      return failure(409, "conflict", "Das ist nicht die neueste bekannte Version. Bitte erst nach Updates suchen.");
    }
    if (!isNewerVersion(version, this.updateCurrent)) {
      return failure(409, "conflict", "Diese Version ist schon installiert.");
    }
    // In die Anforderung kommt nur die geprüfte Version, dazu Zeitpunkt und Gerätename.
    this.updateRequest = { version, requested_at: this.stamp(), device: device.name };
    return json(202, this.updateStatus());
  }

  /** `GET /api/integrations`: Sicherung aus Einstellungen und Ordner; Home Assistant gibt `haStatus` vor (auch nach Änderungen in der App). */
  private integrations(device: FakeDevice): IntegrationStatus {
    return {
      timezone: this.timezone,
      backup: this.backupStatus(),
      ha: { ...this.haStatus },
      push: {
        configured: this.pushConfigured,
        problem: null,
        subscriptions: this.pushSubscriptions.size,
        this_device: this.pushSubscriptions.has(device.id),
        last_run_at: null,
        last_sent_at: null,
        last_error: null,
      },
      update: this.updateStatus(),
    };
  }

  // ---------------------------------------------------------------- Einrichtung

  /** `PATCH /api/setup` (11.6): nur vorhandene Felder zählen. */
  private patchSetup(body: unknown): FakeResponseData {
    const valid = object({
      step: opt(object({ id: req(oneOf(...SETUP_STEP_IDS)), state: req(oneOf("open", "done", "skipped")) })),
      finished: opt(bool),
      addresses: opt(listOf(text(1, LIMITS.setup_address), 0, LIMITS.setup_addresses)),
      https_port: opt(nullable(integer(1, 65535))),
    });
    if (!valid(body)) {
      return failure(422, "invalid_request", "Die Anfrage verletzt den Vertrag.", { errors: [] });
    }
    const changes = body as SetupChanges;
    const addresses = changes.addresses;
    const outside = addresses?.findIndex((address) => !isHomeAddress(address)) ?? -1;
    if (addresses && outside !== -1) {
      const msg = "Die Adresse liegt nicht im Heimnetz.";
      return failure(422, "invalid_request", msg, { errors: [{ loc: ["body", "addresses", outside], msg, type: "value_error" }] });
    }
    const at = this.stamp();
    if (changes.step) {
      this.setupSteps.set(changes.step.id, { state: changes.step.state, changed_at: at });
    }
    if (changes.finished !== undefined) {
      this.setupFinishedAt = changes.finished ? at : null;
    }
    if (changes.https_port !== undefined) {
      this.https.port = changes.https_port ?? 8443;
      this.https.port_source = changes.https_port === null ? "default" : "manual";
    }
    if (addresses) {
      const learned = this.https.addresses.filter((address) => address.source === "learned");
      const manual = addresses.filter((address) => !learned.some((known) => known.address === address)).map((address) => ({ address, source: "manual" as const, in_certificate: true }));
      this.https.addresses = [...learned, ...manual];
    }
    if (addresses || changes.https_port !== undefined) {
      this.https.origins = this.https.addresses.map((address) => `https://${address.address}:${String(this.https.port)}`);
    }
    return json(200, this.setupStatus());
  }

  /** `GET /api/setup/ca.crt` (11.6): ein paar Bytes statt eines Zertifikats; 404 ohne CA. */
  private caCertificate(query: string): FakeResponseData {
    if (this.https.ca === null) {
      return failure(404, "not_found", "Es gibt keine nutzbare CA.");
    }
    const download = new URLSearchParams(query).get("download") === "true";
    const headers: Record<string, string> = download
      ? { "content-type": "application/pkix-cert", "content-disposition": "attachment; filename=\"stowly-ca.crt\"", "cache-control": "no-store" }
      : { "content-type": "application/x-x509-ca-cert", "cache-control": "no-store" };
    return { status: 200, headers, body: new Uint8Array([0x30, 0x82, 0x01, 0x0a]) };
  }

  /** `PATCH /api/server-config` (11.7): Was aus der Umgebung kommt, ist nur zu sehen (409). */
  private patchServerConfig(body: unknown): FakeResponseData {
    const valid = object({
      push_contact: opt(nullable(text(1, LIMITS.push_contact))),
      update_enabled: opt(bool),
      backup_enabled: opt(bool),
      backup_time: opt(nullable(timeOfDay)),
      backup_recipients: opt(listOf(text(1, LIMITS.backup_recipient), 0, LIMITS.backup_recipients)),
      current_password: opt(text(1, LIMITS.password)),
    });
    if (!valid(body)) {
      return failure(422, "invalid_request", "Die Anfrage verletzt den Vertrag.", { errors: [] });
    }
    const changes = body as ServerConfigChanges;
    // Erst alles prüfen, dann ändern: Ein abgelehntes Feld (etwa ein geheimer Schlüssel) ändert nichts.
    const backup = this.patchBackup(changes);
    if (typeof backup !== "function") {
      return backup;
    }
    let contact: string | null | undefined;
    if (changes.push_contact !== undefined) {
      if (this.pushContactSource === "env") {
        return failure(409, "conflict", "Der Kontakt kommt aus der Umgebung (STOWLY_PUSH_CONTACT).");
      }
      contact = changes.push_contact === null ? null : pushContactOf(changes.push_contact);
      if (contact === null && changes.push_contact !== null) {
        const msg = "Erwartet ist mailto:<Adresse> oder eine https-Adresse.";
        return failure(422, "invalid_request", msg, { errors: [{ loc: ["body", "push_contact"], msg, type: "value_error" }] });
      }
    }
    if (changes.update_enabled !== undefined && this.updateRepo !== null) {
      return failure(409, "conflict", "Updates sind über STOWLY_UPDATE_REPO fest eingeschaltet.");
    }
    if (changes.update_enabled !== undefined && this.updateRepoDefault === null) {
      return failure(409, "conflict", "Dieses Image kennt kein Repository für Updates.");
    }
    if (contact !== undefined) {
      this.pushContact = contact;
      this.pushContactSource = contact === null ? "default" : "app";
    }
    if (changes.update_enabled !== undefined) {
      this.updateSwitch = changes.update_enabled;
    }
    backup();
    return json(200, this.serverConfig());
  }

  /** Eine Kopplung, wie `GET /api/pi/pairings/{id}` sie meldet: ohne Code und Befehl. */
  private describePairing(pairing: FakePairing): PiPairing {
    const { id, state, expires_at, printer_id, pi } = this.expired(pairing);
    return { id, state, code: null, command: null, expires_at, printer_id, pi: pi ? { ...pi, addresses: [...pi.addresses] } : null };
  }

  /** `POST /api/pi/pairings` (11.8): Ein neuer Code bricht wartende ältere ab. */
  private createPairing(body: unknown): FakeResponseData {
    if (!object({ origin: req(text(1, LIMITS.push_origin)), printer_id: opt(nullable(uuid)) })(body)) {
      return failure(422, "invalid_request", "Die Anfrage verletzt den Vertrag.", { errors: [] });
    }
    const input = body as { origin: string; printer_id?: string | null };
    let origin: URL | null = null;
    try {
      origin = new URL(input.origin);
    } catch {
      origin = null;
    }
    if (!origin || (origin.protocol !== "http:" && origin.protocol !== "https:") || origin.origin !== input.origin) {
      const msg = "Kein gültiger Ursprung.";
      return failure(422, "invalid_request", msg, { errors: [{ loc: ["body", "origin"], msg, type: "value_error" }] });
    }
    const printerId = input.printer_id ?? null;
    const chosen = printerId === null ? null : this.tables.printers.get(printerId);
    if (printerId !== null && (!chosen || chosen.deleted_at !== null || chosen.connection !== "direct")) {
      const msg = "Kein vorhandener direkter Drucker.";
      return failure(422, "invalid_request", msg, { errors: [{ loc: ["body", "printer_id"], msg, type: "value_error" }] });
    }
    if (!this.piReady) {
      return failure(503, "not_configured", "Für den Pi fehlen die CA oder das Paket.");
    }
    for (const older of this.pairings.values()) {
      if (older.state === "waiting" || older.state === "installing") {
        older.state = "cancelled";
      }
    }
    const random = new Uint8Array(8);
    crypto.getRandomValues(random);
    const plain = Array.from(random, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
    const code = `${plain.slice(0, 4)}-${plain.slice(4)}`;
    const pairing: FakePairing = {
      id: newUuid(),
      code,
      state: "waiting",
      expires_at: new Date(this.now().getTime() + PI_PAIRING_TTL_MS).toISOString(),
      printer_id: printerId,
      pi: null,
      origin: input.origin,
    };
    this.pairings.set(pairing.id, pairing);
    // Die HTTP-Adresse im Befehl: der Ursprung, wenn er http ist, sonst sein Host mit dem gelernten HTTP-Port.
    const http = origin.protocol === "http:" ? input.origin : `http://${origin.hostname}:${String(this.https.http_port ?? 8010)}`;
    const command = `curl -fsSL ${http}/api/pi/install.sh | sudo sh -s -- ${code}`;
    return json(201, { ...this.describePairing(pairing), code, command });
  }

  /** `/api/pi/pairings/{id}`: Stand (GET) und Abbrechen (DELETE, wiederholbar). */
  private pairingRequest(method: string, id: string): FakeResponseData {
    const pairing = this.pairings.get(id);
    if (!pairing) {
      return failure(404, "not_found", "Die Kopplung gibt es nicht.");
    }
    if (method === "DELETE") {
      const { state } = this.expired(pairing);
      if (state === "waiting" || state === "installing") {
        pairing.state = "cancelled";
      }
      return { status: 204, headers: {}, body: null };
    }
    if (method !== "GET") {
      return failure(405, "invalid_request", "Diese Methode ist hier nicht erlaubt.", null, { allow: "GET, DELETE" });
    }
    return json(200, this.describePairing(pairing));
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
    // Die Sicherung zum Zurückspielen kommt als Rohdaten, nicht als JSON.
    if (method === "PUT" && path === "/api/restore/upload") {
      return this.restoreRequest(request, undefined);
    }
    let body: unknown;
    if (request.body !== "") {
      try {
        body = JSON.parse(request.body);
      } catch {
        return failure(422, "invalid_request", "Der Rumpf ist kein JSON.");
      }
    }

    if (method === "GET" && path === "/api/health") {
      // Nach einem Zurückspielen beim ersten Start meldet der alte Prozess noch kurz „nicht eingerichtet".
      const configured = this.configured && this.healthPolls === 0;
      if (this.healthPolls > 0) {
        this.healthPolls -= 1;
      }
      const health: ServerHealth = { app: "stowly", status: "ok", version: FAKE_VERSION, protocol: this.protocol, time: this.stamp(), configured };
      return json(200, health);
    }
    if (path === "/api/restore" || path.startsWith("/api/restore/")) {
      return this.restoreRequest(request, body);
    }
    if (method === "POST" && path === "/api/auth/login") {
      return this.login(body);
    }
    if (method === "POST" && path === "/api/setup/password") {
      return this.setupPassword(body);
    }
    if (method === "GET" && path === "/api/setup/ca.crt") {
      return this.caCertificate(request.query ?? "");
    }
    if (method === "GET" && path.startsWith("/api/images/")) {
      // Nur die Bilder, die der Test eingetragen hat (`images`): ein kleines Feld mit Rahmen.
      return this.images.has(decodeURIComponent(path.slice("/api/images/".length)))
        ? { status: 200, headers: { "content-type": "image/png", "cache-control": "no-store" }, body: framePng(64, 64) }
        : failure(404, "not_found", "Das Bild gibt es nicht.");
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
      // Mit dem Token endet das Push-Abo des Geräts (docs/integrationen.md, 4.10).
      this.pushSubscriptions.delete(device.id);
      return { status: 204, headers: {}, body: null };
    }
    if (method === "POST" && path === "/api/auth/password") {
      return this.changePassword(body);
    }
    if (path === "/api/setup" || path === "/api/server-config") {
      const setup = path === "/api/setup";
      if (method === "GET") {
        return json(200, setup ? this.setupStatus() : this.serverConfig());
      }
      if (method === "PATCH") {
        return setup ? this.patchSetup(body) : this.patchServerConfig(body);
      }
      return failure(405, "invalid_request", "Diese Methode ist hier nicht erlaubt.", null, { allow: "GET, PATCH" });
    }
    if (path === "/api/server-config/ha" || path.startsWith("/api/server-config/ha/")) {
      return this.haRequest(method, path, body);
    }
    if (path === "/api/server-config/ai" || path.startsWith("/api/server-config/ai/")) {
      return this.aiRequest(method, path, body);
    }
    if (method === "POST" && path === "/api/cook/ideas") {
      return this.startCook(device, body);
    }
    const cookMatch = /^\/api\/cook\/ideas\/([^/]+)$/.exec(path);
    if (method === "GET" && cookMatch) {
      return this.cookJob(device, decodeURIComponent(cookMatch[1] ?? ""));
    }
    if (method === "POST" && path === "/api/backup/run") {
      return this.runBackup();
    }
    const backupMatch = /^\/api\/backup\/files\/([^/]+)$/.exec(path);
    if (method === "GET" && backupMatch) {
      return this.backupFile(decodeURIComponent(backupMatch[1] ?? ""));
    }
    if (method === "POST" && path === "/api/pi/pairings") {
      return this.createPairing(body);
    }
    const pairingMatch = /^\/api\/pi\/pairings\/([^/]+)$/.exec(path);
    if (pairingMatch) {
      return this.pairingRequest(method, decodeURIComponent(pairingMatch[1] ?? ""));
    }
    if (path.startsWith("/api/push/")) {
      return this.push(method, path, device, body);
    }
    if (path.startsWith("/api/update/")) {
      return this.update(method, path, device, body);
    }
    if (method === "GET" && path === "/api/integrations") {
      return json(200, this.integrations(device));
    }
    if (method === "GET" && path === "/api/stats") {
      const answer = fakeStats(this.tables, request.query ?? "", this.timezone, this.now());
      return answer.ok ? json(200, answer.stats) : failure(400, "invalid_request", answer.problems[0]?.msg ?? "Der Zeitraum ist ungültig.", { errors: answer.problems });
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
        this.pushSubscriptions.delete(target.id);
        return { status: 204, headers: {}, body: null };
      }
    }
    const lookupMatch = /^\/api\/lookup\/([^/]+)$/.exec(path);
    if (method === "GET" && lookupMatch) {
      return this.lookupNow(decodeURIComponent(lookupMatch[1] ?? ""), request.query ?? "");
    }
    const refreshMatch = /^\/api\/lookup\/([^/]+)\/refresh$/.exec(path);
    if (method === "POST" && refreshMatch) {
      return this.refreshLookup(decodeURIComponent(refreshMatch[1] ?? ""), request.query ?? "");
    }
    const imageMatch = /^\/api\/products\/([^/]+)\/image$/.exec(path);
    if (method === "PUT" && imageMatch) {
      return this.setProductImage(decodeURIComponent(imageMatch[1] ?? ""), body);
    }
    if (path === "/api/labels/design") {
      return this.labelDesignRequest(method, body);
    }
    if (method === "POST" && path === "/api/labels/preview") {
      return this.labelPreview(body);
    }
    return failure(501, "not_implemented", "Die nachgebaute Schnittstelle kennt diesen Aufruf nicht.");
  }
}
