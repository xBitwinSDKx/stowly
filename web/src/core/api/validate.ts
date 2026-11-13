/**
 * Prüfungen der Eingaben, bevor daraus Befehle werden.
 *
 * Die Grenzen sind die des Servers (server/stowly/contract/entities.py und commands.py):
 * Was hier durchgeht, lehnt der Server nicht als `invalid` ab. Was nicht durchgeht, meldet
 * der Kern sofort als `CoreError`, statt es erst nach dem Abgleich als Sync-Problem zu zeigen.
 */
import type { DirectPrinterConfig, Package, Printer, Product, ServerPrinterConfig, Zone } from "@/contract/api.gen";
import { isValidBarcode } from "@/contract/barcode";
import { CoreError } from "@/contract/errors";
import { isUuid } from "@/contract/ids";
import { isDate } from "@/contract/time";

import { resolveProduct } from "../commands/apply";
import type { Draft } from "../tables";

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
} as const;

export function invalid(message: string): CoreError {
  return new CoreError("invalid", message);
}

export function notFound(message: string): CoreError {
  return new CoreError("not_found", message);
}

export function clean(text: unknown): string {
  return typeof text === "string" ? text.trim() : "";
}

/** Pflichttext: nach dem Kürzen nicht leer und nicht zu lang. */
export function requiredText(value: unknown, max: number, what: string): string {
  const text = clean(value);
  if (text === "") {
    throw invalid(`${what} braucht einen Namen.`);
  }
  if (text.length > max) {
    throw invalid(`Der Name ist zu lang (höchstens ${max} Zeichen).`);
  }
  return text;
}

/** Freiwilliger Text: darf leer sein, aber nicht zu lang. */
export function optionalText(value: unknown, max: number, what: string): string {
  const text = clean(value);
  if (text.length > max) {
    throw invalid(`${what} ist zu lang (höchstens ${max} Zeichen).`);
  }
  return text;
}

export function checkWarnDays(value: unknown): void {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > LIMITS.warn_days) {
    throw invalid(`Die Vorlaufzeit muss zwischen 0 und ${LIMITS.warn_days} Tagen liegen.`);
  }
}

export function checkBarcode(barcode: unknown): asserts barcode is string {
  if (typeof barcode !== "string" || !isValidBarcode(barcode)) {
    throw invalid(`Kein gültiger Barcode: ${String(barcode)}`);
  }
}

export function checkBestBefore(value: unknown): asserts value is string | null {
  if (value !== null && (typeof value !== "string" || !isDate(value))) {
    throw invalid("Das MHD ist kein gültiges Datum.");
  }
}

/** Kennung eines anderen Datensatzes oder null. */
export function checkReference(value: unknown, what: string): asserts value is string | null {
  if (value !== null && (typeof value !== "string" || !isUuid(value))) {
    throw invalid(`${what}: keine gültige Kennung.`);
  }
}

export function activeZone(draft: Draft, id: string): Zone {
  const zone = draft.get("zones", id);
  if (!zone || zone.deleted_at !== null) {
    throw notFound("Die Zone gibt es nicht.");
  }
  return zone;
}

export function activeZones(draft: Draft): Zone[] {
  return draft.rows("zones").filter((zone) => zone.deleted_at === null);
}

/** Das Produkt; folgt einer Zusammenführung zum Zielprodukt. */
export function activeProduct(draft: Draft, id: string): Product {
  const product = resolveProduct(draft, id);
  if (!product) {
    throw notFound("Das Produkt gibt es nicht.");
  }
  return product;
}

export function activePrinter(draft: Draft, id: string): Printer {
  const printer = draft.get("printers", id);
  if (!printer || printer.deleted_at !== null) {
    throw notFound("Den Drucker gibt es nicht.");
  }
  return printer;
}

export function hasPrinter(draft: Draft): boolean {
  return draft.rows("printers").some((printer) => printer.deleted_at === null);
}

export function requirePrinter(draft: Draft): void {
  if (!hasPrinter(draft)) {
    throw notFound("Es ist kein Drucker eingerichtet.");
  }
}

/** Die Packungen zu den Kennungen (jede nur einmal), auch entnommene. */
export function existingPackages(draft: Draft, ids: readonly string[]): Package[] {
  if (!Array.isArray(ids)) {
    throw invalid("Es fehlt die Liste der Packungen.");
  }
  return [...new Set(ids)].map((id) => {
    const pkg = typeof id === "string" ? draft.get("packages", id) : undefined;
    if (!pkg) {
      throw notFound(`Die Packung ${String(id)} gibt es nicht.`);
    }
    return pkg;
  });
}

function limited(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

export function checkServerConfig(config: unknown): asserts config is ServerPrinterConfig {
  const value = config as Partial<ServerPrinterConfig> | null | undefined;
  const ok =
    value !== null &&
    typeof value === "object" &&
    (value.driver === "brother_ql" || value.driver === "image") &&
    (value.model === null || limited(value.model, 40)) &&
    (value.address === null || limited(value.address, 200)) &&
    limited(value.media, 40);
  if (!ok) {
    throw invalid("Die Angaben zum Drucker am Server sind unvollständig.");
  }
}

export function checkDirectConfig(config: unknown): asserts config is DirectPrinterConfig {
  const value = config as Partial<DirectPrinterConfig> | null | undefined;
  const ok =
    value !== null &&
    typeof value === "object" &&
    Array.isArray(value.urls) &&
    value.urls.length >= 1 &&
    value.urls.length <= 4 &&
    value.urls.every((url) => limited(url, 200) && url !== "") &&
    limited(value.token, 200) &&
    value.token !== "" &&
    (value.printer === null || limited(value.printer, 60));
  if (!ok) {
    throw invalid("Die Angaben zum Druckdienst sind unvollständig.");
  }
}
