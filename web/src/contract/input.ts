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
import { isDate } from "./time";

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

/** Vorlaufzeit der MHD-Warnung; null und undefined heißen „nicht gesetzt" und gehen durch. */
export function checkWarnDays(value: unknown): void {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > LIMITS.warn_days) {
    throw invalidInput(`Die Vorlaufzeit muss zwischen 0 und ${LIMITS.warn_days} Tagen liegen.`);
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
