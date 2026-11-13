/**
 * Die Auswertung eines Scans: Was soll mit dem geschehen, was der Scanner gesehen hat?
 *
 *   Produkt-Barcode     -> einlagern (vorher nach dem MHD fragen)
 *   Etikett einer Packung -> ausbuchen; unbekannte und schon entnommene Packungen melden
 *   Etikett einer Zone  -> Zone wechseln
 *   alles andere        -> als unbekannt melden
 *
 * Dazu die Eingabe von Hand, die dieselben Ergebnisse liefert wie die Kamera. Ohne React
 * und ohne den Kern selbst: Nachgeschlagen wird über das, was hereingereicht wird.
 */
import { normalizeBarcode, normalizePackageId, parseQr, type Package, type Product, type ScanResult, type Zone } from "@/contract";

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
