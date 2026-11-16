/**
 * Prüfung der Eingaben, gemeinsam für den echten Kern und die Attrappe (Vertrag).
 *
 * Die Grenzen sind die des Servers: `LIMITS` in api.gen.ts entsteht aus
 * server/stowly/contract/limits.py, und die Modelle des Servers lesen dieselbe Stelle. Was
 * hier durchgeht, lehnt der Server nicht als `invalid` ab. Was nicht durchgeht, scheitert
 * sofort mit `CoreError` "invalid", statt erst nach dem Abgleich als Sync-Problem zu erscheinen.
 *
 * Die Sätze sind für die Anzeige gedacht: Bei "invalid" zeigt die Oberfläche `message`.
 * Texte werden an den Rändern gekürzt (trim); geprüft wird die gekürzte Fassung.
 */
import { LIMITS, type DirectPrinterConfig, type ServerPrinterConfig } from "./api.gen";
import { isValidBarcode } from "./barcode";
import { MAX_STORE_COUNT } from "./core";
import { CoreError } from "./errors";
import { isUuid } from "./ids";
import { isDate, isTimeOfDay } from "./time";

export function invalidInput(message: string): CoreError {
  return new CoreError("invalid", message);
}

/** Der Text ohne Leerraum an den Rändern; alles andere als eine Zeichenkette wird leer. */
export function cleanText(text: unknown): string {
  return typeof text === "string" ? text.trim() : "";
}

/** Pflichttext: nach dem Kürzen nicht leer und nicht zu lang. `what` z. B. "Das Produkt". */
export function requiredText(value: unknown, max: number, what: string): string {
  const text = cleanText(value);
  if (text === "") {
    throw invalidInput(`${what} braucht einen Namen.`);
  }
  if (text.length > max) {
    throw invalidInput(`Der Name ist zu lang (höchstens ${max} Zeichen).`);
  }
  return text;
}

/** Freiwilliger Text: darf leer sein, aber nicht zu lang. `what` z. B. "Die Marke". */
export function optionalText(value: unknown, max: number, what: string): string {
  const text = cleanText(value);
  if (text.length > max) {
    throw invalidInput(`${what} ist zu lang (höchstens ${max} Zeichen).`);
  }
  return text;
}

/** Name eines Geräts (Anmelden, Umbenennen); liefert die gekürzte Fassung. */
export function checkDeviceName(value: unknown): string {
  const name = cleanText(value);
  if (name === "") {
    throw invalidInput("Das Gerät braucht einen Namen.");
  }
  if (name.length > LIMITS.device_name) {
    throw invalidInput(`Der Name des Geräts ist zu lang (höchstens ${LIMITS.device_name} Zeichen).`);
  }
  return name;
}

/**
 * Ein neues Haushalts-Passwort (das erste oder ein geändertes): mindestens `LIMITS.password_min`,
 * höchstens `LIMITS.password` Zeichen, gezählt wie im Server (Unicode-Zeichen). Nicht gekürzt.
 */
export function checkNewPassword(value: unknown): asserts value is string {
  const length = typeof value === "string" ? Array.from(value).length : 0;
  if (length < LIMITS.password_min) {
    throw invalidInput(`Das Passwort braucht mindestens ${LIMITS.password_min} Zeichen.`);
  }
  if (length > LIMITS.password) {
    throw invalidInput(`Das Passwort ist zu lang (höchstens ${LIMITS.password} Zeichen).`);
  }
}

/** mailto mit einer Adresse ohne Leerraum und Klammern, wie im Server (server/stowly/config.py). */
const MAILTO = /^mailto:[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]+$/;
const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

/**
 * Kontakt für die Push-Dienste (`ServerConfigChanges.push_contact`): eine E-Mail-Adresse, mit oder
 * ohne `mailto:`, oder eine https-Adresse, nach den Regeln des Servers für STOWLY_PUSH_CONTACT.
 * Liefert die Form, die der Server speichert: gekürzt, eine E-Mail-Adresse mit `mailto:` davor.
 */
export function checkPushContact(value: unknown): string {
  const text = cleanText(value);
  if (text === "") {
    throw invalidInput("Bitte eine Kontakt-Adresse eingeben.");
  }
  const contact = /^(https:\/\/|mailto:)/.test(text) ? text : `mailto:${text}`;
  let ok = /^[\x21-\x7e]+$/.test(contact) && contact.length <= LIMITS.push_contact;
  if (ok && contact.startsWith("mailto:")) {
    ok = MAILTO.test(contact);
  } else if (ok) {
    try {
      const url = new URL(contact);
      ok = url.username === "" && url.password === "" && HOSTNAME.test(url.hostname);
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    throw invalidInput("Erwartet ist eine E-Mail-Adresse wie haushalt@example.org oder eine https-Adresse.");
  }
  return contact;
}

/** Vorlaufzeit der MHD-Warnung; null und undefined heißen „nicht gesetzt" und gehen durch. */
export function checkWarnDays(value: unknown): void {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > LIMITS.warn_days) {
    throw invalidInput(`Die Vorlaufzeit muss zwischen 0 und ${LIMITS.warn_days} Tagen liegen.`);
  }
}

/** Mindestbestand in Packungen; null und undefined heißen „keiner" und gehen durch. */
export function checkMinStock(value: unknown): void {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > LIMITS.min_stock) {
    throw invalidInput(`Der Mindestbestand muss zwischen 1 und ${LIMITS.min_stock} Packungen liegen.`);
  }
}

/** Uhrzeit der täglichen Push-Nachricht, "HH:MM" (Zeitzone des Servers). */
export function checkNotifyTime(value: unknown): asserts value is string {
  if (typeof value !== "string" || !isTimeOfDay(value)) {
    throw invalidInput("Die Uhrzeit muss als HH:MM angegeben sein, etwa 17:00.");
  }
}

/** Text eines Eintrags der Einkaufsliste ohne Produkt; liefert die gekürzte Fassung. */
export function checkShoppingText(value: unknown): string {
  const text = cleanText(value);
  if (text === "") {
    throw invalidInput("Der Eintrag braucht einen Text.");
  }
  if (text.length > LIMITS.shopping_text) {
    throw invalidInput(`Der Text ist zu lang (höchstens ${LIMITS.shopping_text} Zeichen).`);
  }
  return text;
}

/** Menge eines Eintrags der Einkaufsliste; null und undefined heißen „ohne Angabe" und gehen durch. */
export function checkShoppingQuantity(value: unknown): void {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > LIMITS.shopping_quantity) {
    throw invalidInput(`Die Menge muss zwischen 1 und ${LIMITS.shopping_quantity} liegen.`);
  }
}

/** Aufbewahrungsdauer der Lösch-Historie in Tagen. */
export function checkRetentionDays(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > LIMITS.retention_days) {
    throw invalidInput(`Die Aufbewahrungsdauer muss zwischen 1 und ${LIMITS.retention_days} Tagen liegen.`);
  }
}

/** Anzahl der Packungen eines Einlager-Vorgangs. */
export function checkStoreCount(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_STORE_COUNT) {
    throw invalidInput(`Die Menge muss zwischen 1 und ${MAX_STORE_COUNT} liegen.`);
  }
}

/** Ein Barcode in gespeicherter Form (EAN-13 oder EAN-8 mit stimmender Prüfziffer). */
export function checkBarcode(barcode: unknown): asserts barcode is string {
  if (typeof barcode !== "string" || !isValidBarcode(barcode)) {
    throw invalidInput(`Kein gültiger Barcode: ${String(barcode)}`);
  }
}

/** Wie viele Barcodes ein Produkt (danach) hätte. */
export function checkBarcodeCount(count: number): void {
  if (count > LIMITS.barcodes) {
    throw invalidInput(`Ein Produkt kann höchstens ${LIMITS.barcodes} Barcodes haben.`);
  }
}

/** MHD als "YYYY-MM-DD" oder null. */
export function checkBestBefore(value: unknown): asserts value is string | null {
  if (value !== null && (typeof value !== "string" || !isDate(value))) {
    throw invalidInput("Das MHD ist kein gültiges Datum.");
  }
}

/** Kennung eines anderen Datensatzes oder null. `what` z. B. "Drucker der Zone". */
export function checkReference(value: unknown, what: string): asserts value is string | null {
  if (value !== null && (typeof value !== "string" || !isUuid(value))) {
    throw invalidInput(`${what}: keine gültige Kennung.`);
  }
}

/** Symbol einer Zone: ein Schlüssel der Symbolliste. */
export function checkZoneIcon(icon: unknown): asserts icon is string {
  if (typeof icon !== "string" || icon === "" || icon.length > LIMITS.icon) {
    throw invalidInput("Das Symbol der Zone ist ungültig.");
  }
}

/** Farbe einer Zone: ein Schlüssel der Farbpalette oder null. */
export function checkZoneColor(color: unknown): asserts color is string | null {
  if (color !== null && (typeof color !== "string" || color === "" || color.length > LIMITS.color)) {
    throw invalidInput("Die Farbe der Zone ist ungültig.");
  }
}

function limited(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

/** Angaben zu einem Drucker am Server (`Printer.server`). */
export function checkServerConfig(config: unknown): asserts config is ServerPrinterConfig {
  const value = config as Partial<ServerPrinterConfig> | null | undefined;
  const ok =
    value !== null &&
    typeof value === "object" &&
    (value.driver === "brother_ql" || value.driver === "image") &&
    (value.model === null || limited(value.model, LIMITS.printer_model)) &&
    (value.address === null || limited(value.address, LIMITS.printer_address)) &&
    limited(value.media, LIMITS.printer_media);
  if (!ok) {
    throw invalidInput("Die Angaben zum Drucker am Server sind unvollständig.");
  }
}

/** Angaben zu einem Druckdienst, den das Gerät selbst anspricht (`Printer.direct`). */
export function checkDirectConfig(config: unknown): asserts config is DirectPrinterConfig {
  const value = config as Partial<DirectPrinterConfig> | null | undefined;
  const ok =
    value !== null &&
    typeof value === "object" &&
    Array.isArray(value.urls) &&
    value.urls.length >= 1 &&
    value.urls.length <= LIMITS.printer_urls &&
    value.urls.every((url) => limited(url, LIMITS.printer_url) && url !== "") &&
    limited(value.token, LIMITS.printer_token) &&
    value.token !== "" &&
    (value.printer === null || limited(value.printer, LIMITS.printer_queue));
  if (!ok) {
    throw invalidInput("Die Angaben zum Druckdienst sind unvollständig.");
  }
}
