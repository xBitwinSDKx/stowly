/**
 * QR-Inhalte und die Auswertung eines Scans (Vertrag, docs/etiketten.md).
 *
 *   Packung  STOWLY/P/A2B3C                               QR-Version 1, Fehlerkorrektur Q
 *   Zone     STOWLY/Z/3F2B8C1E5A474D099B6E0C1D2E3F4A5B    UUID als 32 große Hex-Zeichen
 *
 * Gegenstück im Server: server/stowly/contract/ids.py, gemeinsame Beispiele in docs/vectors.json.
 */
import { QR_PACKAGE_PREFIX, QR_ZONE_PREFIX } from "./api.gen";
import { normalizeBarcode } from "./barcode";
import { isPackageId, isUuid } from "./ids";

const QR_PACKAGE_RE = /^STOWLY\/P\/([0-9A-HJKMNP-TV-Z]{5})$/;
const QR_ZONE_RE = /^STOWLY\/Z\/([0-9A-F]{32})$/;

/** Formate für Produkt-Barcodes, in den Namen der BarcodeDetector-API. */
export const PRODUCT_BARCODE_FORMATS = ["ean_13", "ean_8", "upc_a"] as const;
/** Alle Formate, die der Scanner liest. */
export const SCAN_FORMATS = ["qr_code", ...PRODUCT_BARCODE_FORMATS] as const;

export type ScanFormat = (typeof SCAN_FORMATS)[number];

/** QR-Inhalt eines Packungs-Etiketts. */
export function packageQr(packageId: string): string {
  if (!isPackageId(packageId)) {
    throw new Error(`Keine gültige Packungs-ID: ${packageId}`);
  }
  return QR_PACKAGE_PREFIX + packageId;
}

/** QR-Inhalt eines Zonen-Etiketts. */
export function zoneQr(zoneId: string): string {
  if (!isUuid(zoneId)) {
    throw new Error(`Keine gültige Zonen-ID: ${zoneId}`);
  }
  return QR_ZONE_PREFIX + zoneId.replace(/-/g, "").toUpperCase();
}

export type StowlyQr = { kind: "package"; id: string } | { kind: "zone"; id: string };

/**
 * Erkennt Stowly-QR-Codes; null für alles andere.
 * Leerraum am Rand und Kleinschreibung werden toleriert.
 */
export function parseQr(text: string): StowlyQr | null {
  const candidate = text.trim().toUpperCase();
  const packageMatch = QR_PACKAGE_RE.exec(candidate);
  if (packageMatch?.[1]) {
    return { kind: "package", id: packageMatch[1] };
  }
  const zoneMatch = QR_ZONE_RE.exec(candidate);
  if (zoneMatch?.[1]) {
    const h = zoneMatch[1].toLowerCase();
    return {
      kind: "zone",
      id: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`,
    };
  }
  return null;
}

/** Was der Scanner gesehen hat. Der Scanner erkennt selbst, worum es sich handelt. */
export type ScanResult =
  /** Etikett einer Packung: ausbuchen. */
  | { kind: "package"; package_id: string }
  /** Etikett einer Zone: Zone wechseln. */
  | { kind: "zone"; zone_id: string }
  /** Produkt-Barcode in gespeicherter Form (EAN-13 oder EAN-8): einlagern. */
  | { kind: "product"; barcode: string }
  /** Fremder QR-Code, anderes Format oder falsche Prüfziffer: ignorieren oder melden. */
  | { kind: "unknown"; raw: string; format: string };

/**
 * Ordnet einen gelesenen Code ein.
 * @param rawValue Inhalt, wie ihn der BarcodeDetector liefert
 * @param format   Format in den Namen der BarcodeDetector-API ("qr_code", "ean_13", …)
 */
export function classifyScan(rawValue: string, format: string): ScanResult {
  if (format === "qr_code") {
    const qr = parseQr(rawValue);
    if (qr?.kind === "package") {
      return { kind: "package", package_id: qr.id };
    }
    if (qr?.kind === "zone") {
      return { kind: "zone", zone_id: qr.id };
    }
    return { kind: "unknown", raw: rawValue, format };
  }
  if ((PRODUCT_BARCODE_FORMATS as readonly string[]).includes(format)) {
    const barcode = normalizeBarcode(rawValue);
    if (barcode !== null) {
      return { kind: "product", barcode };
    }
  }
  return { kind: "unknown", raw: rawValue, format };
}
