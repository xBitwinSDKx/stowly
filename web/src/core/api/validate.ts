/**
 * Prüfungen, bevor aus einer Eingabe Befehle werden.
 *
 * Was nur die Eingabe selbst betrifft (Längen, Bereiche, Formen), steht im Vertrag
 * (src/contract/input.ts) und gilt genauso für die Attrappe; die Grenzen sind die des Servers.
 * Hier bleibt, was den lokalen Datenbestand braucht: Gibt es die Zone, das Produkt, den Drucker?
 */
import type { Package, Printer, Product, Zone } from "@/contract/api.gen";
import { CoreError } from "@/contract/errors";
import { invalidInput } from "@/contract/input";

import { resolveProduct } from "../commands/apply";
import type { Draft } from "../tables";

export { LIMITS } from "@/contract/api.gen";
export {
  checkBarcode,
  checkBarcodeCount,
  checkBestBefore,
  checkDeviceName,
  checkDirectConfig,
  checkReference,
  checkRetentionDays,
  checkServerConfig,
  checkStoreCount,
  checkWarnDays,
  checkZoneColor,
  checkZoneIcon,
  cleanText as clean,
  invalidInput as invalid,
  optionalText,
  requiredText,
} from "@/contract/input";

export function notFound(message: string): CoreError {
  return new CoreError("not_found", message);
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
    throw invalidInput("Es fehlt die Liste der Packungen.");
  }
  return [...new Set(ids)].map((id) => {
    const pkg = typeof id === "string" ? draft.get("packages", id) : undefined;
    if (!pkg) {
      throw notFound(`Die Packung ${String(id)} gibt es nicht.`);
    }
    return pkg;
  });
}
