/**
 * Scan-Auswertung anhand von Beispielbildern: Bilder eines Packungs-Etiketts, eines
 * Zonen-Etiketts und von Produkt-Barcodes laufen durch die mitgelieferte Erkennung (das
 * Ponyfill auf Basis von zxing-wasm) und durch die Einordnung des Vertrags.
 *
 * Das ist der Weg, den ein Kamerabild auf dem iPhone nimmt; nur der Web Worker dazwischen
 * fehlt hier, weil es unter Node keinen gibt.
 */
import { ZXING_WASM_SHA256, ZXING_WASM_VERSION } from "barcode-detector/ponyfill";
import { beforeAll, describe, expect, it } from "vitest";

import { packageQr, SCAN_FORMATS, zoneQr, type ScanResult } from "@/contract";

import { nodeModuleFile, readerWasm, sampleImage, type SampleFormat, type SampleOptions } from "../testing/barcode-images";
import { classifyDetected, isLabelTooSmall, MIN_LABEL_SIDE_RATIO, nearestToCenter, normalizeFormat, toDetectedCodes } from "./formats";
import { createZxingDetector, ZXING_WASM_URL, type ZxingDetector } from "./zxing";

const ZONE_ID = "3f2b8c1e-5a47-4d09-9b6e-0c1d2e3f4a5b";

let detector: ZxingDetector;

beforeAll(async () => {
  detector = await createZxingDetector({ wasmBinary: readerWasm() });
});

async function scan(text: string, format: SampleFormat, options?: SampleOptions): Promise<{ results: ScanResult[]; formats: string[] }> {
  const codes = await detector.detect(await sampleImage(text, format, options));
  return { results: codes.map(classifyDetected), formats: codes.map((code) => code.format) };
}

describe("Beispielbilder durch Erkennung und Einordnung", () => {
  it("erkennt das Etikett einer Packung", async () => {
    const { results, formats } = await scan(packageQr("A2B3C"), "QRCode");
    expect(formats).toEqual(["qr_code"]);
    expect(results).toEqual([{ kind: "package", package_id: "A2B3C" }]);
  });

  it("erkennt das Etikett einer Zone", async () => {
    const { results } = await scan(zoneQr(ZONE_ID), "QRCode");
    expect(results).toEqual([{ kind: "zone", zone_id: ZONE_ID }]);
  });

  it("erkennt einen EAN-13 als Produkt-Barcode", async () => {
    const { results, formats } = await scan("4006381333931", "EAN13", { scale: 3 });
    expect(formats).toEqual(["ean_13"]);
    expect(results).toEqual([{ kind: "product", barcode: "4006381333931" }]);
  });

  it("erkennt EAN-8 und UPC-A; UPC-A wird mit führender Null gespeichert", async () => {
    expect((await scan("96385074", "EAN8")).results).toEqual([{ kind: "product", barcode: "96385074" }]);
    expect((await scan("036000291452", "UPCA", { scale: 3 })).results).toEqual([{ kind: "product", barcode: "0036000291452" }]);
  });

  it("liest auch kleine und gedrehte Codes", async () => {
    // Das Packungs-Etikett ist ein QR-Code der Version 1; aus der Nähe bleiben wenige Bildpunkte je Modul.
    expect((await scan(packageQr("7K9QX"), "QRCode", { scale: 2 })).results).toEqual([{ kind: "package", package_id: "7K9QX" }]);
    expect((await scan(packageQr("7K9QX"), "QRCode", { rotate: true })).results).toEqual([{ kind: "package", package_id: "7K9QX" }]);
    expect((await scan("4006381333931", "EAN13", { scale: 3, rotate: true })).results).toEqual([{ kind: "product", barcode: "4006381333931" }]);
  });

  it("ordnet fremde QR-Codes als unbekannt ein, statt sie für ein Etikett oder ein Produkt zu halten", async () => {
    const foreign = await scan("https://example.org/P/A2B3C", "QRCode", { scale: 3, ecLevel: "M" });
    expect(foreign.results).toEqual([{ kind: "unknown", raw: "https://example.org/P/A2B3C", format: "qr_code" }]);
    // Ein QR-Code ist nie ein Produkt-Barcode, auch wenn er nur Ziffern enthält.
    expect((await scan("4006381333931", "QRCode")).results).toEqual([{ kind: "unknown", raw: "4006381333931", format: "qr_code" }]);
    // Korrektur verwechselter Zeichen gilt nur für die Eingabe von Hand, nicht für QR-Inhalte.
    expect((await scan("STOWLY/P/O1L2I", "QRCode")).results[0]?.kind).toBe("unknown");
  });

  it("findet mehrere Codes in einem Bild und liefert zu jedem seine Lage", async () => {
    // Links ein Produkt-Barcode, rechts das Etikett einer Packung: Grundlage für „es zählt der Code in der Bildmitte".
    const left = await sampleImage("4006381333931", "EAN13", { scale: 3, frame: 400 });
    const right = await sampleImage(packageQr("A2B3C"), "QRCode", { frame: 400 });
    const pixels = new Uint8ClampedArray(800 * 400 * 4);
    for (let y = 0; y < 400; y += 1) {
      pixels.set(left.data.subarray(y * 400 * 4, (y + 1) * 400 * 4), y * 800 * 4);
      pixels.set(right.data.subarray(y * 400 * 4, (y + 1) * 400 * 4), (y * 800 + 400) * 4);
    }
    const codes = await detector.detect(new ImageData(pixels, 800, 400));
    const centers = new Map(codes.map((code) => [classifyDetected(code).kind, code.center]));
    expect([...centers.keys()].sort()).toEqual(["package", "product"]);
    const product = centers.get("product");
    const label = centers.get("package");
    expect(Math.abs((product?.x ?? 0) - 200)).toBeLessThan(40);
    expect(Math.abs((product?.y ?? 0) - 200)).toBeLessThan(40);
    expect(Math.abs((label?.x ?? 0) - 600)).toBeLessThan(40);
    expect(Math.abs((label?.y ?? 0) - 200)).toBeLessThan(40);
  });

  it("findet in einem leeren Bild nichts", async () => {
    const blank = new ImageData(new Uint8ClampedArray(320 * 320 * 4).fill(200), 320, 320);
    expect(await detector.detect(blank)).toEqual([]);
  });
});

describe("Mindestgröße eines Etiketts im Bild", () => {
  /** Liest das Beispielbild und liefert den einen Code darin samt der Kante des Bilds. */
  async function measured(text: string, format: SampleFormat, options: SampleOptions & { frame: number }) {
    const codes = await detector.detect(await sampleImage(text, format, options));
    expect(codes).toHaveLength(1);
    const code = codes[0];
    if (!code) {
      throw new Error("kein Code gelesen");
    }
    return { code, frame: options.frame, ratio: (code.side ?? 0) / options.frame };
  }

  it("misst die Kante am Code selbst, ohne Ruhezone", async () => {
    // Das Packungs-Etikett hat 21 Module; bei 4 Bildpunkten je Modul sind das 84 Bildpunkte.
    const { code } = await measured(packageQr("A2B3C"), "QRCode", { scale: 4, frame: 640 });
    expect(code.side).toBeGreaterThan(84 - 5);
    expect(code.side).toBeLessThan(84 + 5);
    // Gedreht dasselbe.
    const rotated = await measured(packageQr("A2B3C"), "QRCode", { scale: 4, frame: 640, rotate: true });
    expect(rotated.code.side).toBeGreaterThan(84 - 5);
    expect(rotated.code.side).toBeLessThan(84 + 5);
  });

  it("zählt das Etikett einer Packung knapp über der Schwelle und knapp darunter nicht", async () => {
    expect(MIN_LABEL_SIDE_RATIO).toBe(0.07);
    // 21 Module zu 2 Bildpunkten = 42 Bildpunkte: 6,6 % von 640, 7,5 % von 560.
    const below = await measured(packageQr("A2B3C"), "QRCode", { scale: 2, frame: 640 });
    expect(below.ratio).toBeLessThan(0.07);
    expect(below.ratio).toBeGreaterThan(0.06);
    expect(classifyDetected(below.code)).toEqual({ kind: "package", package_id: "A2B3C" });
    expect(isLabelTooSmall(below.code, below.frame)).toBe(true);

    const above = await measured(packageQr("A2B3C"), "QRCode", { scale: 2, frame: 560 });
    expect(above.ratio).toBeGreaterThan(0.07);
    expect(above.ratio).toBeLessThan(0.08);
    expect(isLabelTooSmall(above.code, above.frame)).toBe(false);
  });

  it("gilt genauso für das Etikett einer Zone", async () => {
    // 29 Module zu 2 Bildpunkten = 58 Bildpunkte: 6,6 % von 880, 7,6 % von 760.
    const below = await measured(zoneQr(ZONE_ID), "QRCode", { scale: 2, frame: 880 });
    expect(classifyDetected(below.code).kind).toBe("zone");
    expect(isLabelTooSmall(below.code, below.frame)).toBe(true);
    const above = await measured(zoneQr(ZONE_ID), "QRCode", { scale: 2, frame: 760 });
    expect(isLabelTooSmall(above.code, above.frame)).toBe(false);
  });

  it("gilt nicht für Produkt-Barcodes und fremde Codes, so klein sie im Bild auch sind", async () => {
    const barcode = await measured("4006381333931", "EAN13", { scale: 2, frame: 4_000 });
    expect(classifyDetected(barcode.code)).toEqual({ kind: "product", barcode: "4006381333931" });
    expect(isLabelTooSmall(barcode.code, barcode.frame)).toBe(false);
    const foreign = await measured("https://example.org/aktion", "QRCode", { scale: 2, frame: 2_000, ecLevel: "M" });
    expect(foreign.ratio).toBeLessThan(0.07);
    expect(isLabelTooSmall(foreign.code, foreign.frame)).toBe(false);
  });
});

describe("Formate", () => {
  it("führt die Spielarten der Erkennung auf die vier Formate des Scanners zurück", () => {
    expect(normalizeFormat("qr_code", "x")).toBe("qr_code");
    expect(normalizeFormat("qr_code_model_2", "x")).toBe("qr_code");
    expect(normalizeFormat("isbn", "9783161484100")).toBe("ean_13");
    expect(normalizeFormat("ean_upc", "96385074")).toBe("ean_8");
    expect(normalizeFormat("ean_upc", "036000291452")).toBe("upc_a");
    // Was der Scanner nicht liest, bleibt unverändert und wird damit „unbekannt".
    expect(normalizeFormat("code_128", "4006381333931")).toBe("code_128");
    expect(normalizeFormat("micro_qr_code", "x")).toBe("micro_qr_code");
    expect(classifyDetected({ rawValue: "9783161484100", format: "isbn" })).toEqual({ kind: "product", barcode: "9783161484100" });
    expect(classifyDetected({ rawValue: "4006381333931", format: "code_128" }).kind).toBe("unknown");
    expect(SCAN_FORMATS).toEqual(["qr_code", "ean_13", "ean_8", "upc_a"]);
  });

  it("wählt aus mehreren Codes den in der Bildmitte", () => {
    const codes = toDetectedCodes([
      { rawValue: "rand", format: "qr_code", cornerPoints: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }] },
      { rawValue: "mitte", format: "qr_code", cornerPoints: [{ x: 90, y: 90 }, { x: 110, y: 90 }, { x: 110, y: 110 }, { x: 90, y: 110 }] },
      { rawValue: "ohne", format: "qr_code" },
    ]);
    expect(codes.map((code) => code.center)).toEqual([{ x: 10, y: 10 }, { x: 100, y: 100 }, null]);
    expect(nearestToCenter(codes, 200, 200)?.rawValue).toBe("mitte");
    expect(nearestToCenter([], 200, 200)).toBeUndefined();
  });
});

describe("Die .wasm-Datei kommt aus der eigenen App", () => {
  it("passt genau zur Version, die das Ponyfill mitbringt", async () => {
    // Das Ponyfill enthält seine eigene Kopie von zxing-wasm. Wird nur eines der beiden Pakete
    // angehoben, passt die ausgelieferte Datei nicht mehr, und die Erkennung fiele erst am Gerät aus.
    const manifest = JSON.parse(new TextDecoder().decode(nodeModuleFile("zxing-wasm/package.json"))) as { version: string };
    expect(manifest.version).toBe(ZXING_WASM_VERSION);
    const digest = await crypto.subtle.digest("SHA-256", readerWasm());
    const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe(ZXING_WASM_SHA256);
  });

  it("wird von der eigenen Adresse geladen, nicht von einem fremden Server", () => {
    expect(ZXING_WASM_URL).toMatch(/zxing_reader.*\.wasm$/);
    expect(ZXING_WASM_URL).not.toMatch(/^https?:/);
  });
});
