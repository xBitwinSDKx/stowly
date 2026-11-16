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
 * - Open Food Facts wird nachgespielt: gerade Endziffer des Barcodes = gefunden, nach
 *   `lookupDelayMs`. `product.add_barcode` und ein Zusammenführen setzen `lookup` nicht auf
 *   `pending`. Bilder gibt es nicht (404). Mit `lookupEnabled: false` meldet jede Antwort
 *   `lookup_enabled: false`, und neue Produkte beginnen mit `lookup: "none"`.
 *   `GET /api/lookup/{barcode}` antwortet nach derselben Regel sofort (nie `pending`, nie mit
 *   Bild) und merkt sich nichts; der echte Server legt das Ergebnis ab und füllt damit später
 *   das Produkt.
 * - `last_seen_at` rückt bei jedem Abgleich vor, im echten Server höchstens einmal je Minute.
 * - Es gibt kein Ereignisprotokoll und keine Grenze für die Größe einer Anfrage; die Sicherung
 *   ist keine SQLite-Datei; die Klartexte der Meldungen sind eigene, und `details.errors` ist
 *   bei 422 leer.
 * - Der Druckdienst unter `/print` ist ebenfalls nachgebaut (fake-print.ts; dort steht, was er
 *   nicht kann). Was er am Etikett und am Zustand des Druckers fortschreibt, überschreibt hier
 *   einfach; der echte Server lässt die jüngste Meldung gewinnen.
 * - Längen von Texten zählen hier in UTF-16-Einheiten, im Server in Zeichen.
 * - Push (`/api/push/…`): Der öffentliche Schlüssel ist eine feste Zeichenfolge in der richtigen
 *   Form, aber kein Punkt auf der Kurve; beim Anlegen eines Abos prüft die Nachbildung Form und
 *   Längen, nicht, ob `keys.p256dh` auf der Kurve liegt. Eine Testnachricht geht nirgends hin: Die
 *   Nachbildung merkt sich die Nutzlast (`pushMessages`) und antwortet, was `pushTestStatus` sagt.
 *   Die Tagesnachricht gibt es nicht.
 * - `GET /api/integrations`: Die Sicherung ist nie eingerichtet; Push zählt die Abos der
 *   Nachbildung. Den Zustand von Home Assistant gibt der Test vor (`haStatus`, Vorgabe „aus"),
 *   samt `linked`: Einen Abgleich mit Bring! gibt es hier nicht, `bring_key` auch nicht.
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
 *
 * Ohne DOM und ohne Node: Die Datei läuft in den Tests (jsdom) und im Entwicklungsserver.
 */
import {
  COMMAND_TYPES,
  ID_POOL_TARGET,
  LIMITS,
  MAX_CHANGES_PER_SYNC,
  MAX_COMMANDS_PER_SYNC,
  PROTOCOL_VERSION,
  PUSH_PATHS,
  PUSH_TEST_INTERVAL_S,
  UPDATE_CHECK_MIN_GAP_S,
  type Changes,
  type Command,
  type CommandResult,
  type Device,
  type ErrorBody,
  type ErrorCode,
  type HaStatus,
  type HouseholdSettings,
  type IntegrationStatus,
  type LabelTemplate,
  type Package,
  type Product,
  type PushSubscriptionInput,
  type PushTestResult,
  type PushTestStatus,
  type RejectCode,
  type ServerHealth,
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
import { FakePrintService } from "./fake-print";
import { ShoppingRules } from "./fake-shopping";
import { fakeStats } from "./fake-stats";
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
  /** false = STOWLY_PUSH_CONTACT ist nicht gesetzt: Alles unter `/api/push` antwortet mit 503. */
  pushConfigured = true;
  /** Was der Push-Dienst auf die nächsten Testnachrichten antwortet. */
  pushTestStatus: PushTestStatus = "sent";
  /** Die Testnachrichten, die der Server verschickt hätte, in ihrer Reihenfolge. */
  readonly pushMessages: { device_id: string; endpoint: string; payload: PushPayload }[] = [];
  /** Zeitzone des Servers (STOWLY_TIMEZONE): für die Monate der Statistik und `GET /api/integrations`. */
  timezone = "Europe/Berlin";
  /** Zustand von Home Assistant in `GET /api/integrations` (docs/integrationen.md, 5.6 und 8). */
  haStatus: HaStatus = HA_OFF;
  /** STOWLY_UPDATE_REPO; null (Vorgabe) = Updates sind nicht eingerichtet. */
  updateRepo: string | null = null;
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
  updateStatus(): UpdateStatus {
    const nowMs = this.now().getTime();
    const release = this.updateSeen.release;
    const ready = this.updaterSeenAt !== null && nowMs - Date.parse(this.updaterSeenAt) <= UPDATER_READY_MS;
    const status: UpdateStatus = {
      configured: this.updateRepo !== null,
      repo: this.updateRepo,
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

  /** `GET /api/lookup/{barcode}?wait=0..8`: Open Food Facts nachgespielt wie oben, sofort beantwortet. */
  private lookupNow(barcode: string, query: string): FakeResponseData {
    const wait = new URLSearchParams(query).get("wait");
    const waitS = wait === null ? 4 : Number(wait);
    if (!isValidBarcode(barcode) || !Number.isInteger(waitS) || waitS < 0 || waitS > 8) {
      return failure(400, "invalid_request", "Barcode oder Wartezeit sind ungültig.");
    }
    const empty = { barcode, name: "", brand: "", quantity: "", image_id: null };
    if (isStoreInternalBarcode(barcode)) {
      return json(200, { ...empty, state: "skipped" });
    }
    if (!this.lookupEnabled) {
      return json(200, { ...empty, state: "disabled" });
    }
    if (Number(barcode.at(-1)) % 2 !== 0) {
      return json(200, { ...empty, state: "not_found" });
    }
    return json(200, { barcode, state: "found", name: `Beispielprodukt ${barcode.slice(-4)}`, brand: "Beispielmarke", quantity: "500 g", image_id: null });
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

  // ---------------------------------------------------------------- Push und Integrationen

  /** `/api/push/…` (docs/sync-protokoll.md 11.3, docs/integrationen.md 4). */
  private push(method: string, path: string, device: FakeDevice, body: unknown): FakeResponseData {
    const known = ["GET /api/push/key", "PUT /api/push/subscription", "DELETE /api/push/subscription", "POST /api/push/test"];
    if (!known.includes(`${method} ${path}`)) {
      return failure(404, "not_found", "Diesen Aufruf gibt es nicht.");
    }
    if (!this.pushConfigured) {
      return failure(503, "not_configured", "Push ist auf dem Server nicht eingerichtet (STOWLY_PUSH_CONTACT).");
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
      if (this.updateRepo === null) {
        return failure(503, "not_configured", "Updates sind auf diesem Server nicht eingerichtet (STOWLY_UPDATE_REPO).");
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
      return failure(503, "not_configured", "Updates sind auf diesem Server nicht eingerichtet (STOWLY_UPDATE_REPO).");
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

  /** `GET /api/integrations`: Die Sicherung ist hier nie eingerichtet; Home Assistant gibt `haStatus` vor. */
  private integrations(device: FakeDevice): IntegrationStatus {
    return {
      timezone: this.timezone,
      backup: { configured: false, problem: null, time: null, recipients: [], last_ok_at: null, last_file: null, last_size: null, last_error: null, last_error_at: null, next_at: null, warning: false },
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
      // Mit dem Token endet das Push-Abo des Geräts (docs/integrationen.md, 4.10).
      this.pushSubscriptions.delete(device.id);
      return { status: 204, headers: {}, body: null };
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
