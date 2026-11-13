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
  /**
   * Kantenlänge des Codes in Bildpunkten des ausgewerteten Ausschnitts: das Mittel der vier
   * Kanten zwischen den Eckpunkten der Erkennung, ohne Ruhezone. null, wenn die Erkennung keine
   * vier Eckpunkte liefert.
   */
  side: number | null;
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
    return { rawValue: detection.rawValue, format: normalizeFormat(detection.format, detection.rawValue), center, side: sideOf(points) };
  });
}

/** Mittel der vier Kanten eines Vierecks; null ohne vier Eckpunkte. */
function sideOf(points: readonly { x: number; y: number }[]): number | null {
  if (points.length !== 4) {
    return null;
  }
  let total = 0;
  for (let index = 0; index < 4; index += 1) {
    const from = points[index] as { x: number; y: number };
    const to = points[(index + 1) % 4] as { x: number; y: number };
    total += Math.hypot(to.x - from.x, to.y - from.y);
  }
  return total / 4;
}

/**
 * Mindestgröße eines Etiketts im Bild (docs/etiketten.md, Abschnitt 2): Das Etikett einer
 * Packung oder Zone zählt erst, wenn die Kante seines QR-Codes mindestens 7 % der Kante des
 * Auswertungsquadrats misst.
 *
 * Herleitung aus dem Vertrag: Der Code des Packungs-Etiketts ist 16 mm breit, der des
 * Zonen-Etiketts knapp 20 mm. Das Auswertungsquadrat (80 % der kürzeren Bildseite) erfasst bei
 * einer üblichen Hauptkamera (etwa 43° über die kürzere Seite) eine Fläche mit rund
 * 0,63 × Abstand Kantenlänge. Ein Packungs-Etikett füllt damit bei 20 cm Abstand etwa 13 %, bei
 * 30 cm 8,5 %, bei 36 cm 7 %, bei 60 cm 4 % und bei 1 m 2,5 % der Kante. Wer ein Etikett bewusst
 * scannt, hält es näher als 30 cm; das Etikett im Regal dahinter ist weiter weg als 50 cm. Die
 * Schwelle liegt dazwischen. Sie hängt vom Bildwinkel der Kamera ab und ist an echten Geräten
 * zu bestätigen.
 */
export const MIN_LABEL_SIDE_RATIO = 0.07;

/**
 * Ist dieses Etikett im Bild zu klein, um zu zählen? Gemessen wird am Code selbst, bei der
 * eingebauten Erkennung und bei der mitgelieferten gleich. Für Produkt-Barcodes und fremde
 * Codes gilt die Grenze nicht; ohne Eckpunkte lässt sich nichts messen, dann zählt das Etikett.
 *
 * @param frameSide Kantenlänge des ausgewerteten Quadrats in denselben Bildpunkten wie `code.side`
 */
export function isLabelTooSmall(code: Pick<DetectedCode, "rawValue" | "format" | "side">, frameSide: number): boolean {
  if (code.side === null || frameSide <= 0) {
    return false;
  }
  const kind = classifyDetected(code).kind;
  return (kind === "package" || kind === "zone") && code.side / frameSide < MIN_LABEL_SIDE_RATIO;
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
