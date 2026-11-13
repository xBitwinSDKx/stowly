/**
 * Beispielbilder für die Tests der Barcode-Erkennung: QR-Codes und Strichcodes, erzeugt mit
 * zxing-wasm (`zxing-wasm/writer`) und in ein „Kamerabild" gesetzt. Nur für Tests unter Node.
 *
 * Die .wasm-Dateien kommen aus node_modules; geladen wird nichts aus dem Netz.
 */
import { readFileSync } from "node:fs";

import { prepareZXingModule as prepareWriter, writeBarcode } from "zxing-wasm/writer";

/** Die Tests laufen im Ordner web/ (dort liegt vitest.config.ts). */
const NODE_MODULES = "node_modules/";

/** Liest eine Datei aus node_modules. */
export function nodeModuleFile(path: string): Uint8Array {
  return readFileSync(NODE_MODULES + path);
}

function wasm(path: string): ArrayBuffer {
  const bytes = nodeModuleFile(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Die .wasm-Datei der Erkennung, wie sie auch die gebaute App ausliefert. */
export function readerWasm(): ArrayBuffer {
  return wasm("zxing-wasm/dist/reader/zxing_reader.wasm");
}

let writerReady = false;

export type SampleFormat = "QRCode" | "EAN13" | "EAN8" | "UPCA";

export interface SampleOptions {
  /** Bildpunkte je Modul. Vorgabe 4. */
  scale?: number;
  /** Kantenlänge des quadratischen „Kamerabilds". Vorgabe 640. */
  frame?: number;
  /** Das Bild um 90° drehen: Etiketten liegen nicht immer gerade. */
  rotate?: boolean;
  /** Fehlerkorrektur für QR-Codes; die Etiketten benutzen Q. */
  ecLevel?: "L" | "M" | "Q" | "H";
}

/**
 * Ein Bild mit dem Code in der Mitte: hellgrauer Grund mit leichtem Verlauf, der Code in
 * dunklem Grau statt reinem Schwarz, wie ihn eine Kamera sieht.
 */
export async function sampleImage(text: string, format: SampleFormat, options: SampleOptions = {}): Promise<ImageData> {
  if (!writerReady) {
    prepareWriter({ overrides: { wasmBinary: wasm("zxing-wasm/dist/writer/zxing_writer.wasm") } });
    writerReady = true;
  }
  const scale = options.scale ?? 4;
  const size = options.frame ?? 640;
  const written = await writeBarcode(text, { format, scale: 1, options: format === "QRCode" ? `ecLevel=${options.ecLevel ?? "Q"}` : "" });
  if (written.error) {
    throw new Error(`Der Code ließ sich nicht erzeugen: ${written.error}`);
  }
  const { data: modules, width, height } = written.symbol;
  const codeWidth = width * scale;
  const codeHeight = height * scale;
  if (codeWidth + 8 * scale > size || codeHeight + 8 * scale > size) {
    throw new Error("Der Code passt nicht in das Bild.");
  }
  const left = Math.floor((size - codeWidth) / 2);
  const top = Math.floor((size - codeHeight) / 2);
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // Quelle: beim gedrehten Bild sind Zeile und Spalte vertauscht.
      const sx = options.rotate ? y : x;
      const sy = options.rotate ? size - 1 - x : y;
      const cx = Math.floor((sx - left) / scale);
      const cy = Math.floor((sy - top) / scale);
      const inside = sx >= left && sy >= top && cx < width && cy < height;
      const dark = inside && (modules[cy * width + cx] ?? 255) < 128;
      const background = 205 + Math.round((30 * (sx + sy)) / (2 * size));
      const value = dark ? 38 : background;
      const offset = (y * size + x) * 4;
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
      pixels[offset + 3] = 255;
    }
  }
  return new ImageData(pixels, size, size);
}
