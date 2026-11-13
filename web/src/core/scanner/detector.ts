/**
 * Die Erkennung von Barcodes und QR-Codes (docs/recherche.md, Abschnitt 1).
 *
 * Drei Wege, in dieser Reihenfolge:
 *
 *   "native"  die eingebaute BarcodeDetector-API, wenn sie alle Formate des Scanners kann
 *             (Chrome für Android; am Desktop nur macOS und ChromeOS)
 *   "worker"  die mitgelieferte Erkennung (zxing) in einem Web Worker (Safari und der Rest)
 *   "main"    dieselbe Erkennung auf der Seite selbst, falls sich kein Worker starten lässt
 */
import { SCAN_FORMATS } from "@/contract";

import { DETECT_FORMATS, toDetectedCodes, type DetectedCode } from "./formats";
import type { WorkerRequest, WorkerResponse } from "./zxing.worker";

export type DetectorKind = "native" | "worker" | "main";

/** Ein Bildausschnitt der Kamera. */
export interface Frame {
  /** Die Zeichenfläche mit dem Ausschnitt. */
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  /** Die Bildpunkte des Ausschnitts; wird nur gelesen, wenn die Erkennung sie braucht. */
  imageData(): ImageData;
}

export interface CodeDetector {
  readonly kind: DetectorKind;
  detect(frame: Frame): Promise<DetectedCode[]>;
  dispose(): void;
}

interface NativeBarcodeDetector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string; format: string; cornerPoints?: { x: number; y: number }[] }[]>;
}

interface NativeBarcodeDetectorClass {
  new (options: { formats: string[] }): NativeBarcodeDetector;
  getSupportedFormats(): Promise<string[]>;
}

/** Die eingebaute Erkennung, wenn der Browser sie hat und sie alle Formate abdeckt; sonst null. */
export async function createNativeDetector(): Promise<CodeDetector | null> {
  const Native = (globalThis as { BarcodeDetector?: NativeBarcodeDetectorClass }).BarcodeDetector;
  if (typeof Native !== "function" || typeof Native.getSupportedFormats !== "function") {
    return null;
  }
  try {
    const supported = await Native.getSupportedFormats();
    if (!SCAN_FORMATS.every((format) => supported.includes(format))) {
      return null;
    }
    const detector = new Native({ formats: [...DETECT_FORMATS] });
    return {
      kind: "native",
      async detect(frame) {
        return toDetectedCodes(await detector.detect(frame.canvas));
      },
      dispose() {
        // nichts freizugeben
      },
    };
  } catch {
    return null;
  }
}

/** So lange darf der Worker brauchen, bis die Erkennung geladen ist. */
const WORKER_READY_TIMEOUT_MS = 15_000;

/** Die mitgelieferte Erkennung in einem Web Worker. Scheitert, wenn sich der Worker nicht starten lässt. */
export function createWorkerDetector(): Promise<CodeDetector> {
  return new Promise<CodeDetector>((resolve, reject) => {
    if (typeof Worker !== "function") {
      reject(new Error("Web Worker gibt es hier nicht."));
      return;
    }
    let worker: Worker;
    try {
      worker = new Worker(new URL("./zxing.worker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let nextId = 1;
    let ready = false;
    let dead = false;
    const waiting = new Map<number, { resolve: (codes: DetectedCode[]) => void; reject: (error: Error) => void }>();

    const fail = (message: string) => {
      dead = true;
      worker.terminate();
      for (const entry of waiting.values()) {
        entry.reject(new Error(message));
      }
      waiting.clear();
      if (!ready) {
        reject(new Error(message));
      }
    };

    const timer = setTimeout(() => fail("Die Erkennung hat sich nicht rechtzeitig gemeldet."), WORKER_READY_TIMEOUT_MS);

    worker.addEventListener("error", (event) => {
      clearTimeout(timer);
      fail(event.message || "Der Web Worker ist abgestürzt.");
    });
    worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === "ready") {
        clearTimeout(timer);
        ready = true;
        resolve({
          kind: "worker",
          detect(frame) {
            if (dead) {
              return Promise.reject(new Error("Die Erkennung läuft nicht mehr."));
            }
            const image = frame.imageData();
            const id = nextId;
            nextId += 1;
            const request: WorkerRequest = { type: "detect", id, width: image.width, height: image.height, data: image.data.buffer as ArrayBuffer };
            return new Promise<DetectedCode[]>((done, failed) => {
              waiting.set(id, { resolve: done, reject: failed });
              // Die Bildpunkte wandern ohne Kopie in den Worker.
              worker.postMessage(request, [request.data]);
            });
          },
          dispose() {
            dead = true;
            worker.terminate();
            waiting.clear();
          },
        });
      } else if (message.type === "failed") {
        clearTimeout(timer);
        fail(message.message);
      } else if (message.type === "result") {
        waiting.get(message.id)?.resolve(message.codes);
        waiting.delete(message.id);
      } else if (message.type === "error") {
        waiting.get(message.id)?.reject(new Error(message.message));
        waiting.delete(message.id);
      }
    });
  });
}

/** Die mitgelieferte Erkennung auf der Seite selbst. Der Code dafür wird erst hier nachgeladen. */
export async function createMainThreadDetector(): Promise<CodeDetector> {
  const { createZxingDetector } = await import("./zxing");
  const detector = await createZxingDetector();
  return {
    kind: "main",
    detect(frame) {
      return detector.detect(frame.imageData());
    },
    dispose() {
      // nichts freizugeben
    },
  };
}

/** Die mitgelieferte Erkennung: im Worker, sonst auf der Seite. */
export async function createZxingFallback(): Promise<CodeDetector> {
  try {
    return await createWorkerDetector();
  } catch {
    return createMainThreadDetector();
  }
}

/** Wählt die beste verfügbare Erkennung. */
export async function createDetector(): Promise<CodeDetector> {
  return (await createNativeDetector()) ?? (await createZxingFallback());
}
