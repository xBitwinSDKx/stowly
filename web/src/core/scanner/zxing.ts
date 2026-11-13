/**
 * Die mitgelieferte Barcode-Erkennung: das Ponyfill `barcode-detector` auf Basis von zxing-wasm.
 * Sie läuft überall dort, wo der Browser keine eigene Erkennung hat (Safari, Desktop-Chrome
 * unter Windows und Linux).
 *
 * Wichtig für den Betrieb ohne Netz: Das Ponyfill holt seine .wasm-Datei von Haus aus von
 * einem fremden Server (jsDelivr). Hier bekommt es stattdessen die Datei aus der eigenen App:
 * Vite legt sie beim Bauen unter /assets ab, und der Service Worker speichert sie vorab.
 *
 * `prepareZXingModule` muss das des Ponyfills sein: Es bringt seine eigene Kopie von
 * zxing-wasm mit; die Einstellung an `zxing-wasm/reader` selbst bliebe ohne Wirkung.
 *
 * Ohne DOM: Diese Datei läuft im Web Worker (zxing.worker.ts) und als Rückfall auf der Seite.
 */
import { BarcodeDetector as ZxingBarcodeDetector, prepareZXingModule, purgeZXingModule } from "barcode-detector/ponyfill";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

import { DETECT_FORMATS, toDetectedCodes, type DetectedCode } from "./formats";

export interface ZxingOptions {
  /** Die .wasm-Datei als Bytes statt als Adresse. Für Tests unter Node, wo es nichts zu laden gibt. */
  wasmBinary?: ArrayBuffer;
}

export interface ZxingDetector {
  detect(image: ImageData): Promise<DetectedCode[]>;
}

let prepared: Promise<void> | null = null;

/** Lädt die Erkennung aus der eigenen App. Mehrfache Aufrufe teilen sich einen Ladevorgang. */
export function prepareZxing(options: ZxingOptions = {}): Promise<void> {
  prepared ??= Promise.resolve(
    prepareZXingModule({
      overrides: options.wasmBinary
        ? { wasmBinary: options.wasmBinary }
        : { locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path) },
      fireImmediately: true,
    }),
  ).then(() => undefined);
  // Ein gescheiterter Versuch (kein Netz beim allerersten Laden) darf wiederholt werden:
  // zxing-wasm merkt sich sonst auch den Fehlschlag.
  prepared.catch(() => {
    prepared = null;
    purgeZXingModule();
  });
  return prepared;
}

/** Die Erkennung für die vier Formate des Scanners. Erfüllt sich, wenn sie einsatzbereit ist. */
export async function createZxingDetector(options: ZxingOptions = {}): Promise<ZxingDetector> {
  await prepareZxing(options);
  const detector = new ZxingBarcodeDetector({ formats: [...DETECT_FORMATS] as never });
  return {
    async detect(image) {
      return toDetectedCodes(await detector.detect(image));
    },
  };
}

/** Adresse der .wasm-Datei in der gebauten App (für Prüfungen). */
export const ZXING_WASM_URL: string = wasmUrl;
