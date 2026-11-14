/**
 * Wahl der Kamera nach Fähigkeiten (docs/recherche.md, Abschnitt 1). Die Werte unten sind
 * die, die iPhones und Android-Geräte der Recherche nach melden; an echten Geräten geprüft
 * ist die Auswahl nicht.
 */
import { describe, expect, it } from "vitest";

import { APPLE_START_ZOOM, findBestBackCamera, isMultiLensCamera, scoreCamera, shouldLookForBetterCamera, startZoom, type CameraCapabilities, type CameraInfo, type OpenCamera } from "./camera";

const back = ["environment"];

// iPhone Pro: Die Mehrfachkamera zählt den Zoom ab dem Ultraweitwinkel und stellt dank ihm ab 2 cm scharf.
const IPHONE_TRIPLE: CameraCapabilities = { facingMode: back, zoom: { min: 0.5, max: 10 }, focusDistance: { min: 0.02, max: 1 }, torch: true };
const IPHONE_WIDE: CameraCapabilities = { facingMode: back, zoom: { min: 1, max: 10 }, focusDistance: { min: 0.15, max: 1 }, torch: true };
const IPHONE_ULTRA_WIDE: CameraCapabilities = { facingMode: back, zoom: { min: 1, max: 10 }, focusDistance: { min: 0.02, max: 1 }, torch: true };
const IPHONE_TELE: CameraCapabilities = { facingMode: back, zoom: { min: 1, max: 10 }, focusDistance: { min: 0.8, max: 1 }, torch: true };
const IPHONE_FRONT: CameraCapabilities = { facingMode: ["user"], zoom: { min: 1, max: 4 } };
// Android: Die Hauptkamera hat Dauerfokus und Taschenlampe, die Weitwinkel-Linse einen festen Fokus.
const ANDROID_MAIN: CameraCapabilities = { facingMode: back, focusMode: ["manual", "single-shot", "continuous"], torch: true, zoom: { min: 1, max: 8 } };
const ANDROID_WIDE_FIXED: CameraCapabilities = { facingMode: back, focusMode: ["manual"], zoom: { min: 1, max: 8 } };
const WEBCAM: CameraCapabilities = {};

describe("Bewertung", () => {
  it("erkennt die Mehrfachkamera, die selbstständig die Linse wechselt", () => {
    expect(isMultiLensCamera(IPHONE_TRIPLE)).toBe(true);
    expect([IPHONE_WIDE, IPHONE_ULTRA_WIDE, IPHONE_TELE, ANDROID_MAIN, WEBCAM].map(isMultiLensCamera)).toEqual([false, false, false, false, false]);
  });

  it("zieht am iPhone die feste Hauptkamera allen anderen vor", () => {
    const ranked = [
      ["triple", IPHONE_TRIPLE],
      ["wide", IPHONE_WIDE],
      ["ultra", IPHONE_ULTRA_WIDE],
      ["tele", IPHONE_TELE],
      ["front", IPHONE_FRONT],
    ] as const;
    const order = [...ranked].sort((a, b) => scoreCamera(b[1]) - scoreCamera(a[1])).map(([name]) => name);
    expect(order).toEqual(["wide", "ultra", "tele", "triple", "front"]);
  });

  it("zieht auf Android die Kamera mit Dauerfokus und Taschenlampe vor", () => {
    expect(scoreCamera(ANDROID_MAIN)).toBeGreaterThan(scoreCamera(ANDROID_WIDE_FIXED));
  });

  it("sucht nur dann nach einer besseren Kamera, wenn die geöffnete erkennbar ungeeignet ist", () => {
    expect(shouldLookForBetterCamera(IPHONE_TRIPLE)).toBe(true);
    expect(shouldLookForBetterCamera(IPHONE_ULTRA_WIDE)).toBe(true);
    expect(shouldLookForBetterCamera(IPHONE_TELE)).toBe(true);
    expect(shouldLookForBetterCamera(ANDROID_WIDE_FIXED)).toBe(true);
    expect(shouldLookForBetterCamera(IPHONE_WIDE)).toBe(false);
    expect(shouldLookForBetterCamera(ANDROID_MAIN)).toBe(false);
    // Eine Kamera, die nichts über sich verrät, bleibt: Es gibt nichts, wonach sich wählen ließe.
    expect(shouldLookForBetterCamera(WEBCAM)).toBe(false);
    expect(shouldLookForBetterCamera(IPHONE_FRONT)).toBe(false);
  });
});

function fakeDevices(devices: Record<string, CameraCapabilities>, broken: string[] = []) {
  const opened: (string | null)[] = [];
  const running = new Set<string>();
  const first = Object.keys(devices)[0] ?? "";
  const open = async (deviceId: string | null): Promise<OpenCamera> => {
    opened.push(deviceId);
    const id = deviceId ?? first;
    if (broken.includes(id)) {
      throw new Error("lässt sich nicht öffnen");
    }
    running.add(id);
    const track = { stop: () => running.delete(id) } as unknown as MediaStreamTrack;
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    return { stream, track, deviceId: id, capabilities: devices[id] ?? {} };
  };
  const list = async (): Promise<CameraInfo[]> =>
    Object.entries(devices).map(([deviceId, capabilities]) => ({
      deviceId,
      label: "",
      facing: capabilities.facingMode?.includes("user") ? "front" : capabilities.facingMode?.includes("environment") ? "back" : "unknown",
    }));
  return { open, list, opened, running };
}

describe("Suche nach der besten Rückkamera", () => {
  it("wählt am iPhone Pro statt der Dreifachkamera die feste Hauptkamera", async () => {
    const devices = fakeDevices({ front: IPHONE_FRONT, triple: IPHONE_TRIPLE, wide: IPHONE_WIDE, ultra: IPHONE_ULTRA_WIDE, tele: IPHONE_TELE });
    const current = await devices.open("triple");
    const best = await findBestBackCamera(current, () => true, devices.open, devices.list);
    expect(best.deviceId).toBe("wide");
    // Die Frontkamera wird gar nicht erst geöffnet, und am Ende läuft nur die gewählte.
    expect(devices.opened).not.toContain("front");
    expect([...devices.running]).toEqual(["wide"]);
  });

  it("bleibt bei der geöffneten Kamera, wenn keine andere besser ist", async () => {
    const devices = fakeDevices({ main: ANDROID_MAIN, wide: ANDROID_WIDE_FIXED, front: IPHONE_FRONT });
    const current = await devices.open("main");
    const best = await findBestBackCamera(current, () => true, devices.open, devices.list);
    expect(best.deviceId).toBe("main");
    expect([...devices.running]).toEqual(["main"]);
  });

  it("überspringt Kameras, die sich nicht öffnen lassen", async () => {
    const devices = fakeDevices({ wide: ANDROID_WIDE_FIXED, depth: {}, main: ANDROID_MAIN }, ["depth"]);
    const current = await devices.open("wide");
    const best = await findBestBackCamera(current, () => true, devices.open, devices.list);
    expect(best.deviceId).toBe("main");
  });

  it("öffnet nichts weiter, wenn es keine Kandidatin gibt oder die Ansicht verlassen wurde", async () => {
    const single = fakeDevices({ only: IPHONE_TRIPLE });
    const current = await single.open("only");
    expect(await findBestBackCamera(current, () => true, single.open, single.list)).toBe(current);

    const devices = fakeDevices({ triple: IPHONE_TRIPLE, wide: IPHONE_WIDE });
    const opened = await devices.open("triple");
    expect(await findBestBackCamera(opened, () => false, devices.open, devices.list)).toBe(opened);
    expect(devices.opened).toEqual(["triple"]);
  });
});

describe("Zoom beim Start", () => {
  it("beginnt am iPhone mit der festen Kamera gezoomt, damit man weit genug weg bleibt, um scharf zu sehen", () => {
    expect(APPLE_START_ZOOM).toBe(2);
    expect(startZoom(IPHONE_WIDE, true)).toBe(2);
    expect(startZoom(IPHONE_ULTRA_WIDE, true)).toBe(2);
  });

  it("lässt den Zoom anderswo, bei der Mehrfachkamera und ohne genug Zoom, wie er ist", () => {
    expect(startZoom(IPHONE_WIDE, false)).toBeNull();
    expect(startZoom(ANDROID_MAIN, false)).toBeNull();
    expect(startZoom(IPHONE_TRIPLE, true)).toBeNull();
    expect(startZoom({ facingMode: back, zoom: { min: 1, max: 1.5 } }, true)).toBeNull();
    expect(startZoom({ facingMode: back }, true)).toBeNull();
    expect(startZoom(WEBCAM, true)).toBeNull();
  });
});
