/**
 * Was die Erkennung liefert, in den Namen der BarcodeDetector-API.
 *
 * Die eingebaute Erkennung und das Ponyfill (zxing) melden dieselben Codes nicht immer unter
 * demselben Namen: zxing kennt Unterarten (`qr_code_model_2`, `isbn`) und die Familie
 * `ean_upc`. `classifyScan` aus dem Vertrag kennt nur die vier Formate aus `SCAN_FORMATS`;
 * hier werden die Spielarten darauf zurückgeführt.
 *
 * Ohne DOM: Diese Datei läuft auch im Web Worker.
 */
import { classifyScan, SCAN_FORMATS, type ScanResult } from "@/contract/qr";

/** Ein gelesener Code. */
export interface DetectedCode {
  rawValue: string;
  /** Format in den Namen der BarcodeDetector-API, auf `SCAN_FORMATS` zurückgeführt, soweit möglich. */
  format: string;
  /** Mittelpunkt des Codes im ausgewerteten Bildausschnitt, falls bekannt. */
  center: { x: number; y: number } | null;
}

const QR_VARIANTS = new Set(["qr_code", "qr_code_model_1", "qr_code_model_2"]);
const RETAIL_VARIANTS = new Set(["ean_13", "ean_8", "upc_a", "isbn", "ean_upc"]);

/** Führt den Namen eines Formats auf einen aus `SCAN_FORMATS` zurück; Unbekanntes bleibt, wie es ist. */
export function normalizeFormat(format: string, rawValue: string): string {
  if (QR_VARIANTS.has(format)) {
    return "qr_code";
  }
  if (RETAIL_VARIANTS.has(format)) {
    // Die Länge entscheidet: ISBN ist ein EAN-13, die Familie `ean_upc` sagt nichts Genaueres.
    const digits = rawValue.trim().length;
    if (digits === 13) {
      return "ean_13";
    }
    if (digits === 12) {
      return "upc_a";
    }
    if (digits === 8) {
      return "ean_8";
    }
  }
  return format;
}

interface RawDetection {
  rawValue: string;
  format: string;
  cornerPoints?: readonly { x: number; y: number }[];
}

/** Bringt das Ergebnis einer Erkennung (eingebaut oder Ponyfill) in die gemeinsame Form. */
export function toDetectedCodes(detections: readonly RawDetection[]): DetectedCode[] {
  return detections.map((detection) => {
    const points = detection.cornerPoints ?? [];
    const center =
      points.length > 0
        ? { x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length }
        : null;
    return { rawValue: detection.rawValue, format: normalizeFormat(detection.format, detection.rawValue), center };
  });
}

/** Wählt aus mehreren Codes im Bild den, der der Mitte am nächsten liegt. */
export function nearestToCenter(codes: readonly DetectedCode[], width: number, height: number): DetectedCode | undefined {
  let best: DetectedCode | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const code of codes) {
    const distance = code.center ? Math.hypot(code.center.x - width / 2, code.center.y - height / 2) : Number.MAX_VALUE;
    if (distance < bestDistance) {
      best = code;
      bestDistance = distance;
    }
  }
  return best;
}

/** Ordnet einen gelesenen Code ein: Etikett einer Packung, Etikett einer Zone, Produkt-Barcode oder unbekannt. */
export function classifyDetected(code: Pick<DetectedCode, "rawValue" | "format">): ScanResult {
  return classifyScan(code.rawValue, normalizeFormat(code.format, code.rawValue));
}

/** Die Formate, nach denen gesucht wird. */
export const DETECT_FORMATS: readonly string[] = SCAN_FORMATS;
