// Gemeinsame Vorbereitung für die Tests von src/core und src/features/scan (Worker 3).
// Läuft nach src/test/setup.dom.ts und src/test/setup.core.ts.

// Die Prüfungen wie `toBeInTheDocument()` richtet schon src/test/setup.dom.ts ein. Der Import
// steht hier noch einmal, damit auch die Typprüfung des Kerns (tsconfig.core.json) sie kennt:
// Sie sieht setup.dom.ts nicht.
import "@testing-library/jest-dom/vitest";

// jsdom kennt kein ImageData (das käme erst mit einem Canvas-Paket). Die Barcode-Erkennung
// braucht nur die Form: Bildpunkte als RGBA, Breite, Höhe.
if (typeof globalThis.ImageData === "undefined") {
  class TestImageData {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
    readonly colorSpace = "srgb";

    constructor(dataOrWidth: Uint8ClampedArray | number, widthOrHeight: number, height?: number) {
      if (typeof dataOrWidth === "number") {
        this.width = dataOrWidth;
        this.height = widthOrHeight;
        this.data = new Uint8ClampedArray(dataOrWidth * widthOrHeight * 4);
      } else {
        this.data = dataOrWidth;
        this.width = widthOrHeight;
        this.height = height ?? dataOrWidth.length / 4 / widthOrHeight;
      }
    }
  }
  (globalThis as { ImageData?: unknown }).ImageData = TestImageData;
}

// jsdom spielt keine Medien ab; die Scan-Ansicht ruft play() und pause() am Kamerabild auf.
if (typeof HTMLMediaElement !== "undefined") {
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => undefined;
}

export {};
