/**
 * Web Worker für die mitgelieferte Barcode-Erkennung: Die Auswertung der Kamerabilder läuft
 * hier, damit die Oberfläche flüssig bleibt (zehn Bilder je Sekunde sind auf dem
 * Haupt-Thread spürbar).
 *
 * Nachrichten:
 *   Worker -> Seite   { type: "ready" } | { type: "failed", message }
 *   Seite -> Worker   { type: "detect", id, width, height, data: ArrayBuffer }
 *   Worker -> Seite   { type: "result", id, codes } | { type: "error", id, message }
 */
import type { DetectedCode } from "./formats";
import { createZxingDetector, type ZxingDetector } from "./zxing";

export type WorkerRequest = { type: "detect"; id: number; width: number; height: number; data: ArrayBuffer };

export type WorkerResponse =
  | { type: "ready" }
  | { type: "failed"; message: string }
  | { type: "result"; id: number; codes: DetectedCode[] }
  | { type: "error"; id: number; message: string };

interface WorkerScope {
  postMessage(message: WorkerResponse): void;
  addEventListener(type: "message", listener: (event: { data: WorkerRequest }) => void): void;
}

const scope = self as unknown as WorkerScope;

let detector: ZxingDetector | null = null;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

createZxingDetector().then(
  (created) => {
    detector = created;
    scope.postMessage({ type: "ready" });
  },
  (error: unknown) => {
    scope.postMessage({ type: "failed", message: describe(error) });
  },
);

scope.addEventListener("message", (event) => {
  const request = event.data;
  if (request?.type !== "detect") {
    return;
  }
  if (!detector) {
    scope.postMessage({ type: "error", id: request.id, message: "Die Erkennung ist noch nicht bereit." });
    return;
  }
  const image = new ImageData(new Uint8ClampedArray(request.data), request.width, request.height);
  detector.detect(image).then(
    (codes) => scope.postMessage({ type: "result", id: request.id, codes }),
    (error: unknown) => scope.postMessage({ type: "error", id: request.id, message: describe(error) }),
  );
});
