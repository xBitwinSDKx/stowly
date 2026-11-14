/**
 * Die Auswertung eines Scans: Was soll mit dem geschehen, was der Scanner gesehen hat?
 *
 *   Produkt-Barcode     -> einlagern (vorher nach dem MHD fragen)
 *   Etikett einer Packung -> ausbuchen; unbekannte und schon entnommene Packungen melden
 *   Etikett einer Zone  -> Zone wechseln
 *   alles andere        -> als unbekannt melden
 *
 * Dazu die Eingabe von Hand, die dieselben Ergebnisse liefert wie die Kamera, und was nach dem
 * Entnehmen dazukommt: der FIFO-Hinweis auf eine ältere Packung (Plan von Stufe 2,
 * Entscheidung 5) und das Angebot „Auf die Einkaufsliste" nach der letzten Packung eines Produkts
 * ohne Mindestbestand. Ohne React und ohne den Kern selbst: Nachgeschlagen wird über das, was
 * hereingereicht wird.
 */
import {
  formatDate,
  isDate,
  isOpenItem,
  normalizeBarcode,
  normalizePackageId,
  olderPackage,
  parseQr,
  stockCount,
  type Package,
  type Product,
  type ScanResult,
  type ShoppingItem,
  type Zone,
} from "@/contract";

export type ScanAction =
  /** Produkt-Barcode: einlagern. `product` fehlt, wenn die lokale Kopie den Barcode noch nicht kennt. */
  | { type: "store"; barcode: string; product: Product | undefined }
  /** Etikett einer Packung im Bestand: ausbuchen. */
  | { type: "remove"; pkg: Package; product: Product | undefined }
  /** Die Packung ist schon entnommen. */
  | { type: "already_removed"; pkg: Package; product: Product | undefined }
  /** Diese Packungs-ID kennt die lokale Kopie nicht. */
  | { type: "unknown_package"; package_id: string }
  /** Etikett einer Zone: wechseln. */
  | { type: "zone"; zone: Zone }
  /** Das Etikett gehört zu keiner Zone (mehr). */
  | { type: "unknown_zone"; zone_id: string }
  /** Etikett der einzigen Zone: Es gibt nichts zu wechseln und nichts zu zeigen. */
  | { type: "nothing" }
  /** Fremder Code. */
  | { type: "unknown_code"; raw: string };

/** Was die Auswertung nachschlagen können muss (ein Ausschnitt von `core.data`). */
export interface ScanLookups {
  findPackage(id: string): Promise<Package | undefined>;
  findProduct(id: string): Promise<Product | undefined>;
  findProductByBarcode(barcode: string): Promise<Product | undefined>;
  /** Alle nicht gelöschten Zonen. */
  zones: readonly Zone[];
}

/** Entscheidet, was ein Scan bedeutet. Ändert nichts. */
export async function evaluateScan(result: ScanResult, lookups: ScanLookups): Promise<ScanAction> {
  if (result.kind === "product") {
    return { type: "store", barcode: result.barcode, product: await lookups.findProductByBarcode(result.barcode) };
  }
  if (result.kind === "package") {
    const pkg = await lookups.findPackage(result.package_id);
    if (!pkg) {
      return { type: "unknown_package", package_id: result.package_id };
    }
    const product = await lookups.findProduct(pkg.product_id);
    return pkg.removed_at === null ? { type: "remove", pkg, product } : { type: "already_removed", pkg, product };
  }
  if (result.kind === "zone") {
    const zone = lookups.zones.find((candidate) => candidate.id === result.zone_id);
    if (!zone) {
      return { type: "unknown_zone", zone_id: result.zone_id };
    }
    return lookups.zones.length > 1 ? { type: "zone", zone } : { type: "nothing" };
  }
  return { type: "unknown_code", raw: result.raw };
}

export type ManualInput =
  | { ok: true; result: ScanResult }
  /**
   * - "empty": nichts eingegeben
   * - "barcode": sieht aus wie ein Barcode (8, 12 oder 13 Ziffern), aber die Prüfziffer stimmt nicht
   * - "unknown": weder Packungs-ID noch Barcode
   */
  | { ok: false; reason: "empty" | "barcode" | "unknown" };

/**
 * Liest eine Eingabe von Hand: eine Packungs-ID (fünf Zeichen; verwechselte Zeichen werden
 * korrigiert), einen Barcode (EAN-13, EAN-8, UPC-A) oder den Inhalt eines Stowly-QR-Codes.
 */
export function parseManualInput(text: string): ManualInput {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { ok: false, reason: "empty" };
  }
  const qr = parseQr(trimmed);
  if (qr?.kind === "package") {
    return { ok: true, result: { kind: "package", package_id: qr.id } };
  }
  if (qr?.kind === "zone") {
    return { ok: true, result: { kind: "zone", zone_id: qr.id } };
  }
  const compact = trimmed.replace(/[\s-]/g, "");
  if (/^\d+$/.test(compact) && [8, 12, 13].includes(compact.length)) {
    const barcode = normalizeBarcode(compact);
    return barcode === null ? { ok: false, reason: "barcode" } : { ok: true, result: { kind: "product", barcode } };
  }
  const packageId = normalizePackageId(trimmed);
  if (packageId !== null) {
    return { ok: true, result: { kind: "package", package_id: packageId } };
  }
  return { ok: false, reason: "unknown" };
}

// ------------------------------------------------------------------------------------------
// Nach dem Entnehmen
// ------------------------------------------------------------------------------------------

/** Ein MHD kurz, wie auf dem Etikett: "2026-12-03" -> "03.12.". */
export function shortDate(date: string): string {
  return isDate(date) ? formatDate(date).slice(0, 6) : date;
}

/**
 * Der FIFO-Hinweis nach dem Entnehmen als „verbraucht": Liegt eine Packung desselben Produkts
 * mit früherem MHD im Bestand (`olderPackage`), heißt er „Älter: XYZ12 · MHD 03.12. · Keller";
 * die Zone nur, wenn es mehr als eine gibt. null, wenn es keine ältere gibt. Rein lokal.
 * `stock` sind die Packungen im Bestand; die entnommene darf noch darin stehen.
 */
export function fifoHint(removed: Pick<Package, "id" | "product_id" | "best_before">, stock: readonly Package[], zones: readonly Zone[]): string | null {
  const older = olderPackage(removed, stock);
  if (!older || older.best_before === null) {
    return null;
  }
  const parts = [`Älter: ${older.id}`, `MHD ${shortDate(older.best_before)}`];
  const zone = zones.find((candidate) => candidate.id === older.zone_id);
  if (zones.length > 1 && zone) {
    parts.push(zone.name);
  }
  return parts.join(" · ");
}

/**
 * Nach dem Entnehmen: Ist das die letzte Packung des Produkts gewesen (Bestand jetzt 0)?
 * `stock` ist der Bestand danach; die entnommene zählt nie mit.
 */
export function wasLastPackage(removed: Pick<Package, "id" | "product_id">, stock: readonly Package[]): boolean {
  return stockCount(
    stock.filter((pkg) => pkg.id !== removed.id),
    removed.product_id,
  ) === 0;
}

/**
 * Kommt nach dem Entnehmen die Einkaufsliste zur Sprache (das Angebot „Auf die Einkaufsliste" oder
 * der Satz, dass das Produkt schon darauf steht)? Nur nach der letzten Packung eines bekannten
 * Produkts ohne Mindestbestand. Für ein Produkt mit Mindestbestand legt der Server den Eintrag
 * selbst an (docs/sync-protokoll.md, 7.6); die Bestandsansicht hält es ebenso
 * (features/stock/RemoveDialog.tsx). Nach einem Entnehmen als „falsch erfasst" fragt die Ansicht
 * gar nicht erst: Was es nie gab, fehlt auch nicht.
 */
export function offersShoppingList(removed: Pick<Package, "id" | "product_id">, product: Pick<Product, "min_stock"> | undefined, stock: readonly Package[]): boolean {
  return product !== undefined && product.min_stock === null && wasLastPackage(removed, stock);
}

/** Steht das Produkt offen auf der Einkaufsliste (eigener oder automatischer Eintrag)? */
export function isOnShoppingList(productId: string, items: readonly ShoppingItem[]): boolean {
  return items.some((item) => item.product_id === productId && isOpenItem(item));
}
