/**
 * Der Ablauf des Scanners mit nachgebildeter Kamera und Erkennung: Start und Stopp (auch
 * doppelt, wie React es im Entwicklungsmodus tut), Hintergrund, Wiederholungen, Rückfälle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScanResult } from "@/contract";

import { CameraError, type CameraCapabilities, type CameraInfo, type OpenCamera } from "./camera";
import { RESCAN_GAP_MS, ScanDeduper } from "./dedupe";
import type { CodeDetector, DetectorKind } from "./detector";
import { playFeedback, setFeedbackActive, unlockAudio } from "./feedback";
import type { DetectedCode } from "./formats";
import { Scanner, STALL_RESTART_MS, STALL_RESTART_SPACING_MS, type ScannerOptions } from "./scanner";

const PACKAGE = { rawValue: "STOWLY/P/A2B3C", format: "qr_code", center: { x: 50, y: 50 }, side: 200 } satisfies DetectedCode;
const ZONE = { rawValue: "STOWLY/Z/3F2B8C1E5A474D099B6E0C1D2E3F4A5B", format: "qr_code", center: { x: 10, y: 10 }, side: 200 } satisfies DetectedCode;
const PRODUCT = { rawValue: "4006381333931", format: "ean_13", center: { x: 50, y: 50 }, side: 120 } satisfies DetectedCode;

/** Derselbe Code an anderer Stelle des ausgewerteten Ausschnitts (800 × 800 Bildpunkte, Mitte bei 400/400). */
function at(code: DetectedCode, x: number, y: number): DetectedCode {
  return { ...code, center: { x, y } };
}

/** Eine Umgebung mit nachgebildeter Kamera, Erkennung und Uhr. */
function setup(config: { cameraId?: string | null; devices?: Record<string, CameraCapabilities>; engine?: DetectorKind; appleMobile?: boolean } = {}) {
  const devices = config.devices ?? { cam: {} };
  const running = new Set<object>();
  const opened: (string | null)[] = [];
  const chosen: string[] = [];
  const scans: ScanResult[] = [];
  const state = {
    visibleCodes: [] as DetectedCode[],
    detectFails: false,
    openError: null as CameraError | null,
    openGate: null as Promise<void> | null,
    missing: [] as string[],
    now: 0,
    detections: 0,
    fallbacks: 0,
    /** Das System hat das Video angehalten (iOS, wenn sich die Tastatur öffnet); `play()` hebt es auf. */
    systemPaused: false,
    /** Die Kamera liefert keine neuen Bilder mehr, auch nach `play()`; erst eine neu geöffnete wieder. */
    frozen: false,
    plays: 0,
    /** Was der Scanner an der Kamera eingestellt hat (`applyConstraints`). */
    constraints: [] as MediaTrackConstraints[],
  };

  const video = document.createElement("video");
  // jsdom liefert weder Bildgröße noch Bilder: so tun, als liefe die Kamera.
  Object.defineProperty(video, "videoWidth", { get: () => (video.srcObject ? 1000 : 0) });
  Object.defineProperty(video, "videoHeight", { get: () => (video.srcObject ? 1000 : 0) });
  Object.defineProperty(video, "readyState", { get: () => (video.srcObject ? 4 : 0) });
  let source: unknown = null;
  Object.defineProperty(video, "srcObject", { get: () => source, set: (value) => (source = value) });
  // Die Abspielposition läuft mit der Uhr, solange neue Bilder kommen.
  let position = 0;
  Object.defineProperty(video, "currentTime", {
    get: () => {
      if (source !== null && !state.systemPaused && !state.frozen) {
        position = state.now / 1000;
      }
      return position;
    },
  });
  Object.defineProperty(video, "paused", { get: () => source === null || state.systemPaused });
  video.play = () => {
    state.plays += 1;
    state.systemPaused = false;
    return Promise.resolve();
  };
  video.pause = () => undefined;

  const detector = (kind: DetectorKind): CodeDetector => ({
    kind,
    async detect() {
      state.detections += 1;
      if (state.detectFails && kind === "native") {
        throw new Error("Barcode detection service unavailable.");
      }
      return state.visibleCodes;
    },
    dispose: () => undefined,
  });

  const options: ScannerOptions = {
    video,
    cameraId: config.cameraId ?? null,
    onScan: (result) => scans.push(result),
    onCameraChosen: (deviceId) => chosen.push(deviceId),
    deps: {
      now: () => state.now,
      appleMobile: () => config.appleMobile ?? false,
      async openCamera(deviceId) {
        opened.push(deviceId);
        if (state.openGate) {
          await state.openGate;
        }
        if (state.openError) {
          throw state.openError;
        }
        const id = deviceId ?? Object.keys(devices)[0] ?? "cam";
        if (state.missing.includes(id)) {
          throw new CameraError("not_found");
        }
        // Eine neu geöffnete Kamera liefert wieder Bilder.
        state.frozen = false;
        const handle = {};
        running.add(handle);
        const track = {
          stop: () => running.delete(handle),
          addEventListener: () => undefined,
          applyConstraints: async (constraints: MediaTrackConstraints) => {
            state.constraints.push(constraints);
          },
        } as unknown as MediaStreamTrack;
        const stream = { getTracks: () => [track] } as unknown as MediaStream;
        return { stream, track, deviceId: id, capabilities: devices[id] ?? {} } satisfies OpenCamera;
      },
      async listCameras(): Promise<CameraInfo[]> {
        return Object.entries(devices).map(([deviceId, capabilities]) => ({ deviceId, label: deviceId, facing: capabilities.facingMode?.includes("user") ? "front" : "back" }));
      },
      createDetector: async () => detector(config.engine ?? "worker"),
      createZxingFallback: async () => {
        state.fallbacks += 1;
        return detector("worker");
      },
    },
  };
  const scanner = new Scanner(options);
  return { scanner, video, state, running, opened, chosen, scans };
}

/** Lässt die Schleife `ms` Millisekunden laufen (Uhr des Scanners und Zeitgeber zusammen). */
async function run(env: ReturnType<typeof setup>, ms: number): Promise<void> {
  const step = 100;
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    env.state.now += step;
    await vi.advanceTimersByTimeAsync(step);
  }
}

function setVisibility(value: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom zeichnet nicht: Eine Zeichenfläche, die nichts tut, genügt der Schleife.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: () => undefined,
    getImageData: () => new ImageData(new Uint8ClampedArray(4), 1, 1),
  } as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
  setVisibility("visible");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Start und Stopp", () => {
  it("öffnet die Kamera, scannt und gibt sie beim Stopp wieder frei", async () => {
    const env = setup();
    await env.scanner.start();
    expect(env.scanner.state.get()).toMatchObject({ status: "running", engine: "worker", cameraId: "cam", error: null });
    expect(env.running.size).toBe(1);
    expect(env.video.srcObject).not.toBeNull();
    await run(env, 300);
    expect(env.state.detections).toBeGreaterThan(1);

    env.scanner.stop();
    expect(env.scanner.state.get().status).toBe("idle");
    expect(env.running.size).toBe(0);
    expect(env.video.srcObject).toBeNull();
    // Nach dem Stopp wird nichts mehr ausgewertet.
    const before = env.state.detections;
    await run(env, 500);
    expect(env.state.detections).toBe(before);
  });

  it("hält doppeltes Starten und einen Stopp mitten im Öffnen aus", async () => {
    const env = setup();
    let open: () => void = () => undefined;
    env.state.openGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    // Wie React im Entwicklungsmodus: starten, sofort stoppen, wieder starten.
    const first = env.scanner.start();
    env.scanner.stop();
    const second = env.scanner.start();
    const third = env.scanner.start();
    open();
    await Promise.all([first, second, third]);

    expect(env.scanner.state.get().status).toBe("running");
    // Genau eine Kamera läuft; die des abgebrochenen Starts ist wieder geschlossen.
    expect(env.running.size).toBe(1);
    env.scanner.dispose();
    expect(env.running.size).toBe(0);
  });

  it("lässt nach einem Stopp während des Öffnens keine Kamera laufen", async () => {
    const env = setup();
    let open: () => void = () => undefined;
    env.state.openGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const starting = env.scanner.start();
    env.scanner.dispose();
    open();
    await starting;
    expect(env.running.size).toBe(0);
    expect(env.scanner.state.get().status).toBe("idle");
    expect(env.video.srcObject).toBeNull();
  });

  it("gibt die Kamera frei, wenn die App in den Hintergrund geht, und nimmt sie danach wieder", async () => {
    const env = setup();
    await env.scanner.start();
    setVisibility("hidden");
    expect(env.running.size).toBe(0);
    expect(env.scanner.state.get().status).toBe("idle");

    setVisibility("visible");
    await run(env, 100);
    expect(env.scanner.state.get().status).toBe("running");
    expect(env.running.size).toBe(1);

    // Nach einem ausdrücklichen Stopp bleibt sie auch bei der Rückkehr aus.
    env.scanner.stop();
    setVisibility("hidden");
    setVisibility("visible");
    await run(env, 100);
    expect(env.running.size).toBe(0);
  });

  it("meldet verständlich, warum die Kamera nicht läuft", async () => {
    for (const kind of ["denied", "not_found", "insecure", "unsupported", "in_use"] as const) {
      const env = setup();
      env.state.openError = new CameraError(kind);
      await env.scanner.start();
      expect(env.scanner.state.get()).toMatchObject({ status: "error", error: kind });
      expect(env.running.size).toBe(0);
      // Ein neuer Versuch gelingt, sobald das Hindernis weg ist.
      env.state.openError = null;
      await env.scanner.start();
      expect(env.scanner.state.get().status).toBe("running");
      env.scanner.dispose();
    }
  });
});

describe("Kamera", () => {
  it("beginnt am iPhone mit 2× Zoom, wenn die Kamera ihn kann; sonst bleibt er, wie er ist", async () => {
    const zoomable = { cam: { facingMode: ["environment"], zoom: { min: 1, max: 10, step: 0.1 } } };
    const iphone = setup({ appleMobile: true, devices: zoomable });
    await iphone.scanner.start();
    expect(iphone.state.constraints).toEqual([{ advanced: [{ zoom: 2 }] }]);
    expect(iphone.scanner.state.get().zoom).toEqual({ min: 1, max: 10, step: 0.1, value: 2 });
    iphone.scanner.dispose();

    const android = setup({ appleMobile: false, devices: zoomable });
    await android.scanner.start();
    expect(android.state.constraints).toEqual([]);
    expect(android.scanner.state.get().zoom?.value).toBe(1);
    android.scanner.dispose();

    // Ohne Zoom (oder mit zu wenig) gibt es nichts einzustellen.
    const plain = setup({ appleMobile: true, devices: { cam: { facingMode: ["environment"] } } });
    await plain.scanner.start();
    expect(plain.state.constraints).toEqual([]);
    expect(plain.scanner.state.get().zoom).toBeNull();
  });

  it("merkt sich die gewählte Kamera", async () => {
    const env = setup();
    await env.scanner.start();
    expect(env.opened).toEqual([null]);
    expect(env.chosen).toEqual(["cam"]);
  });

  it("öffnet die gemerkte Kamera direkt und sucht nicht erneut", async () => {
    const env = setup({ cameraId: "wide", devices: { triple: { facingMode: ["environment"], zoom: { min: 0.5, max: 10 } }, wide: { facingMode: ["environment"], zoom: { min: 1, max: 10 }, focusDistance: { min: 0.15 } } } });
    await env.scanner.start();
    expect(env.opened).toEqual(["wide"]);
    expect(env.chosen).toEqual([]);
    expect(env.scanner.state.get()).toMatchObject({ cameraId: "wide", zoom: { min: 1, max: 10, value: 1 }, torch: { available: false } });
  });

  it("sucht am iPhone einmal die feste Rückkamera und merkt sie", async () => {
    const env = setup({
      devices: {
        triple: { facingMode: ["environment"], zoom: { min: 0.5, max: 10 }, focusDistance: { min: 0.02 }, torch: true },
        wide: { facingMode: ["environment"], zoom: { min: 1, max: 10 }, focusDistance: { min: 0.15 }, torch: true },
        front: { facingMode: ["user"] },
      },
    });
    await env.scanner.start();
    expect(env.scanner.state.get()).toMatchObject({ status: "running", cameraId: "wide", torch: { available: true, on: false } });
    expect(env.chosen).toEqual(["wide"]);
    expect(env.running.size).toBe(1);
  });

  it("wählt neu, wenn es die gemerkte Kamera nicht mehr gibt", async () => {
    const env = setup({ cameraId: "weg" });
    env.state.missing = ["weg"];
    await env.scanner.start();
    expect(env.opened).toEqual(["weg", null]);
    expect(env.scanner.state.get()).toMatchObject({ status: "running", cameraId: "cam" });
    expect(env.chosen).toEqual(["cam"]);
  });

  it("schaltet auf Wunsch zur nächsten Kamera um und merkt die Wahl", async () => {
    const env = setup({ cameraId: "a", devices: { a: { facingMode: ["environment"] }, front: { facingMode: ["user"] }, b: { facingMode: ["environment"] } } });
    await env.scanner.start();
    await run(env, 100);
    expect(env.scanner.state.get().cameras.map((camera) => camera.deviceId)).toEqual(["a", "front", "b"]);

    await env.scanner.switchCamera();
    expect(env.scanner.state.get().cameraId).toBe("b");
    await run(env, 100);
    await env.scanner.switchCamera();
    // Erst die Rückkameras, dann die vordere.
    expect(env.scanner.state.get().cameraId).toBe("front");
    expect(env.chosen).toEqual(["b", "front"]);
    expect(env.running.size).toBe(1);
  });
});

describe("Auswertung", () => {
  it("meldet einen Code einmal und ignoriert ihn, solange er im Bild bleibt", async () => {
    const env = setup();
    await env.scanner.start();
    env.state.visibleCodes = [PACKAGE];
    await run(env, 3_000);
    expect(env.scans).toEqual([{ kind: "package", package_id: "A2B3C" }]);

    // Zwei Sekunden nicht zu sehen: Danach zählt er wieder.
    env.state.visibleCodes = [];
    await run(env, 2_100);
    env.state.visibleCodes = [PACKAGE];
    await run(env, 300);
    expect(env.scans).toHaveLength(2);
  });

  it("ordnet selbst ein, was er sieht, und meldet von mehreren Codes nur den in der Bildmitte", async () => {
    const env = setup();
    await env.scanner.start();
    env.state.visibleCodes = [ZONE];
    await run(env, 200);
    expect(env.scans).toEqual([{ kind: "zone", zone_id: "3f2b8c1e-5a47-4d09-9b6e-0c1d2e3f4a5b" }]);

    // Ein Etikett am Rand, der Produkt-Barcode näher an der Mitte: Solange beide im Bild sind, zählt nur der Barcode.
    env.state.visibleCodes = [at(PACKAGE, 60, 60), at(PRODUCT, 400, 400)];
    await run(env, 3_000);
    expect(env.scans).toEqual([
      { kind: "zone", zone_id: "3f2b8c1e-5a47-4d09-9b6e-0c1d2e3f4a5b" },
      { kind: "product", barcode: "4006381333931" },
    ]);
  });

  it("löst beim Wegziehen der Packung keinen zweiten Vorgang aus", async () => {
    const env = setup();
    await env.scanner.start();
    // Das Etikett in der Mitte, daneben der Barcode derselben Packung.
    env.state.visibleCodes = [at(PRODUCT, 700, 400), at(PACKAGE, 400, 400)];
    await run(env, 1_500);
    expect(env.scans).toEqual([{ kind: "package", package_id: "A2B3C" }]);

    // Beim Wegziehen wandert der Barcode allein durch die Bildmitte.
    env.state.visibleCodes = [at(PRODUCT, 400, 400)];
    await run(env, 1_500);
    expect(env.scans).toHaveLength(1);

    // Wer danach bewusst auf ihn zielt, wird bedient.
    await run(env, 1_000);
    expect(env.scans).toEqual([
      { kind: "package", package_id: "A2B3C" },
      { kind: "product", barcode: "4006381333931" },
    ]);
  });

  it("sperrt einen gemeldeten Code weiter, auch wenn inzwischen auf einen anderen gezielt wurde", async () => {
    const env = setup();
    await env.scanner.start();
    // Eingelagert; das Produkt bleibt am Bildrand liegen, während ein Etikett gescannt wird.
    env.state.visibleCodes = [at(PRODUCT, 400, 400)];
    await run(env, 300);
    env.state.visibleCodes = [at(PRODUCT, 700, 400), at(PACKAGE, 400, 400)];
    await run(env, 300);
    expect(env.scans).toHaveLength(2);

    // Das Etikett ist weg, das Produkt liegt noch da: Es wird nicht noch einmal eingelagert.
    env.state.visibleCodes = [at(PRODUCT, 400, 400)];
    await run(env, 5_000);
    expect(env.scans).toHaveLength(2);
  });

  it("meldet fremde Codes erst nach einer halben Sekunde und nie neben etwas Bekanntem", async () => {
    const env = setup();
    await env.scanner.start();
    const foreign = { rawValue: "https://example.org/aktion", format: "qr_code", center: { x: 400, y: 400 }, side: 200 } satisfies DetectedCode;

    // Der Werbe-QR wird zuerst lesbar, der Barcode daneben einen Augenblick später.
    env.state.visibleCodes = [foreign];
    await run(env, 300);
    expect(env.scans).toEqual([]);
    env.state.visibleCodes = [foreign, at(PRODUCT, 700, 400)];
    await run(env, 300);
    expect(env.scans).toEqual([{ kind: "product", barcode: "4006381333931" }]);

    // Beim Wegziehen bleibt der fremde Code allein im Bild: keine Fehlermeldung.
    env.state.visibleCodes = [foreign];
    await run(env, 1_500);
    expect(env.scans).toHaveLength(1);

    // Auch nicht, nachdem der Dialog zum Einlagern lange offen war.
    env.state.visibleCodes = [foreign, at(PRODUCT, 700, 400)];
    await run(env, 200);
    env.scanner.pause();
    await run(env, 5_000);
    env.scanner.resume();
    env.state.visibleCodes = [foreign];
    await run(env, 1_500);
    expect(env.scans).toHaveLength(1);

    // Ein fremder Code allein wird gemeldet, sobald er eine halbe Sekunde zu sehen war.
    env.state.visibleCodes = [];
    await run(env, 2_500);
    env.state.visibleCodes = [foreign];
    await run(env, 400);
    expect(env.scans).toHaveLength(1);
    await run(env, 300);
    expect(env.scans).toEqual([
      { kind: "product", barcode: "4006381333931" },
      { kind: "unknown", raw: "https://example.org/aktion", format: "qr_code" },
    ]);
  });

  it("wertet nichts aus, solange angehalten ist, und meldet danach nicht sofort denselben Code", async () => {
    const env = setup();
    await env.scanner.start();
    env.state.visibleCodes = [PRODUCT];
    await run(env, 200);
    expect(env.scans).toHaveLength(1);

    // Der Dialog für das MHD ist offen; das Produkt liegt weiter vor der Kamera.
    env.scanner.pause();
    const before = env.state.detections;
    await run(env, 5_000);
    expect(env.state.detections).toBe(before);
    env.scanner.resume();
    await run(env, 1_000);
    expect(env.scans).toHaveLength(1);

    // Erst weglegen, dann wieder zeigen: jetzt zählt er.
    env.state.visibleCodes = [];
    await run(env, 2_100);
    env.state.visibleCodes = [PRODUCT];
    await run(env, 200);
    expect(env.scans).toHaveLength(2);
  });

  it("wechselt auf die mitgelieferte Erkennung, wenn die eingebaute wiederholt versagt", async () => {
    const env = setup({ engine: "native" });
    await env.scanner.start();
    expect(env.scanner.state.get().engine).toBe("native");
    env.state.detectFails = true;
    env.state.visibleCodes = [PACKAGE];
    await run(env, 1_000);
    expect(env.state.fallbacks).toBe(1);
    expect(env.scanner.state.get()).toMatchObject({ status: "running", engine: "worker" });
    expect(env.scans).toEqual([{ kind: "package", package_id: "A2B3C" }]);
  });

  it("überlebt einen Fehler in der Auswertung eines Scans", async () => {
    const env = setup();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let calls = 0;
    const scanner = new Scanner({
      video: env.video,
      cameraId: null,
      onScan: () => {
        calls += 1;
        throw new Error("kaputt");
      },
      deps: (env.scanner as unknown as { deps: ScannerOptions["deps"] }).deps,
    });
    await scanner.start();
    env.state.visibleCodes = [PACKAGE];
    await run(env, 300);
    env.state.visibleCodes = [PRODUCT];
    await run(env, 300);
    expect(calls).toBe(2);
    expect(error).toHaveBeenCalled();
    scanner.dispose();
  });
});

describe("Nach einem Dialog", () => {
  /** Der Barcode löst den Dialog aus, der Dialog ist eine Weile offen, dann zu. */
  async function scanThroughDialog(env: ReturnType<typeof setup>, openMs = 5_000): Promise<void> {
    await env.scanner.start();
    env.state.visibleCodes = [PRODUCT];
    await run(env, 200);
    expect(env.scans).toEqual([{ kind: "product", barcode: "4006381333931" }]);
    env.scanner.pause();
    await run(env, openMs);
    env.scanner.resume();
  }

  it("öffnet ihn nicht von selbst wieder, solange der Barcode im Bild bleibt, und sagt, was hilft", async () => {
    const env = setup();
    await scanThroughDialog(env);
    await run(env, 10_000);
    expect(env.scans).toHaveLength(1);
    expect(env.scanner.state.get().rescan).toBe(true);
    // Kurze Aussetzer der Erkennung bei ruhig gehaltenem Code zählen nicht als Wegschwenken.
    for (let dropout = 0; dropout < 5; dropout += 1) {
      env.state.visibleCodes = [];
      await run(env, 600);
      env.state.visibleCodes = [PRODUCT];
      await run(env, 300);
    }
    expect(env.scans).toHaveLength(1);
  });

  it("zählt denselben Barcode wieder, sobald er kurz nicht zu sehen war; der Hinweis geht", async () => {
    const env = setup();
    await scanThroughDialog(env);
    await run(env, 1_000);
    expect(env.scanner.state.get().rescan).toBe(true);
    env.state.visibleCodes = [];
    await run(env, RESCAN_GAP_MS);
    expect(env.scanner.state.get().rescan).toBe(false);
    env.state.visibleCodes = [PRODUCT];
    await run(env, 200);
    expect(env.scans).toEqual([
      { kind: "product", barcode: "4006381333931" },
      { kind: "product", barcode: "4006381333931" },
    ]);
    expect(RESCAN_GAP_MS).toBeLessThanOrEqual(1_000);
  });

  it("lässt ein Etikett (es bucht ohne Rückfrage) nach dem Dialog erst nach zwei Sekunden wieder zählen", async () => {
    const env = setup();
    await env.scanner.start();
    env.state.visibleCodes = [PACKAGE];
    await run(env, 200);
    env.scanner.pause();
    await run(env, 5_000);
    env.scanner.resume();
    await run(env, 1_000);
    expect(env.scanner.state.get().rescan).toBe(false);
    env.state.visibleCodes = [];
    await run(env, 1_000);
    env.state.visibleCodes = [PACKAGE];
    await run(env, 500);
    expect(env.scans).toHaveLength(1);
    env.state.visibleCodes = [];
    await run(env, 2_100);
    env.state.visibleCodes = [PACKAGE];
    await run(env, 200);
    expect(env.scans).toHaveLength(2);
  });

  it("startet das Video wieder, wenn das System es angehalten hat (iOS nach der Tastatur)", async () => {
    const env = setup();
    await env.scanner.start();
    env.state.visibleCodes = [PRODUCT];
    await run(env, 200);
    env.scanner.pause();
    // Im Dialog öffnet sich die Tastatur; iOS hält das Video an, das Bild steht.
    env.state.systemPaused = true;
    await run(env, 5_000);
    const plays = env.state.plays;
    env.scanner.resume();
    expect(env.state.plays).toBe(plays + 1);
    // Es läuft wieder: Ein anderer Code wird erkannt, ohne dass die Kamera neu geöffnet wird.
    env.state.visibleCodes = [PACKAGE];
    await run(env, 300);
    expect(env.scans).toEqual([
      { kind: "product", barcode: "4006381333931" },
      { kind: "package", package_id: "A2B3C" },
    ]);
    expect(env.opened).toHaveLength(1);
  });

  it("öffnet die Kamera neu, wenn trotzdem keine neuen Bilder kommen; was gesperrt war, bleibt gesperrt", async () => {
    const env = setup();
    await scanThroughDialog(env);
    // Das letzte Bild steht, und es zeigt noch den Barcode von eben.
    env.state.frozen = true;
    await run(env, STALL_RESTART_MS - 500);
    expect(env.opened).toHaveLength(1);
    await run(env, 1_000);
    expect(env.opened).toHaveLength(2);
    expect(env.running.size).toBe(1);
    await vi.waitFor(() => expect(env.scanner.state.get().status).toBe("running"));
    // Das neue Bild zeigt noch denselben Barcode: kein neuer Dialog. Ein anderer Code zählt.
    await run(env, 2_000);
    expect(env.scans).toHaveLength(1);
    env.state.visibleCodes = [PACKAGE];
    await run(env, 300);
    expect(env.scans).toHaveLength(2);

    // Steht es gleich wieder, wird nicht ständig neu geöffnet: frühestens 15 Sekunden später.
    env.state.frozen = true;
    await run(env, STALL_RESTART_MS + 1_000);
    expect(env.opened).toHaveLength(2);
    await run(env, STALL_RESTART_SPACING_MS);
    expect(env.opened).toHaveLength(3);
  });

  it("öffnet nicht neu, solange seit dem Öffnen noch nie ein Bild kam", async () => {
    const env = setup();
    env.state.frozen = true;
    const open = env.scanner.start();
    // `openCamera` taut die Kamera auf; diese hier liefert trotzdem nie ein Bild.
    await open;
    env.state.frozen = true;
    await run(env, 30_000);
    expect(env.opened).toHaveLength(1);
  });
});

describe("Wiederholungen", () => {
  it("ignoriert denselben Wert zwei Sekunden lang, gerechnet ab der letzten Sichtung", () => {
    const deduper = new ScanDeduper();
    expect(deduper.accept("a", 0)).toBe(true);
    expect(deduper.accept("a", 1_900)).toBe(false);
    expect(deduper.accept("a", 3_800)).toBe(false);
    expect(deduper.accept("b", 3_900)).toBe(true);
    expect(deduper.accept("a", 5_800)).toBe(true);
    deduper.forget("a");
    expect(deduper.accept("a", 5_900)).toBe(true);
    // Nach einer Pause (hier von 6 s bis 20 s) gilt als gerade gesehen, was davor im Bild war.
    deduper.refresh(20_000, 6_000);
    expect(deduper.accept("a", 21_000)).toBe(false);
    expect(deduper.accept("a", 23_100)).toBe(true);
  });

  it("hält nach einer Pause nur gesperrt, was beim Anhalten noch im Bild war", () => {
    const deduper = new ScanDeduper();
    expect(deduper.accept("alt", 0)).toBe(true);
    expect(deduper.accept("im-bild", 9_000)).toBe(true);
    // Der Dialog öffnet sich bei 10 s und schließt bei 30 s.
    deduper.refresh(30_000, 10_000);
    // Was beim Öffnen noch vor der Kamera lag, bleibt gesperrt ...
    expect(deduper.accept("im-bild", 30_100)).toBe(false);
    // ... was schon lange weg war, zählt sofort wieder.
    expect(deduper.accept("alt", 30_100)).toBe(true);
  });

  it("stellt zurück, was beim Melden eines anderen Codes mit im Bild war, ohne die Frist zu verlängern", () => {
    const deduper = new ScanDeduper();
    deduper.hold("b", 1_000);
    expect(deduper.check("b", 1_500)).toBe("held");
    expect(deduper.check("b", 2_900)).toBe("held");
    // Die Frist läuft ab der Zurückstellung, nicht ab der letzten Sichtung.
    expect(deduper.check("b", 3_000)).toBe("new");
    expect(deduper.check("b", 3_100)).toBe("repeat");

    // Ein schon gemeldeter Wert bleibt über die Frist hinaus gesperrt, solange er im Bild ist.
    expect(deduper.check("c", 10_000)).toBe("new");
    deduper.hold("c", 10_100);
    expect(deduper.check("c", 11_900)).toBe("held");
    expect(deduper.check("c", 12_200)).toBe("repeat");

    // Eine Sichtung am Rand hält nur schon Gemeldetes gesperrt.
    deduper.see("d", 20_000);
    expect(deduper.check("d", 20_100)).toBe("new");
    deduper.see("d", 21_900);
    expect(deduper.check("d", 23_000)).toBe("repeat");

    deduper.hold("e", 30_000);
    deduper.forget("e");
    expect(deduper.check("e", 30_100)).toBe("new");
  });
});

describe("Rückmeldung", () => {
  class FakeAudioContext {
    static instances: FakeAudioContext[] = [];
    state = "suspended";
    currentTime = 0;
    destination = {};
    started = 0;
    constructor() {
      FakeAudioContext.instances.push(this);
    }
    resume() {
      this.state = "running";
      return Promise.resolve();
    }
    suspend() {
      this.state = "suspended";
      return Promise.resolve();
    }
    createOscillator() {
      return { type: "sine", frequency: { value: 0 }, connect: () => undefined, start: () => (this.started += 1), stop: () => undefined };
    }
    createGain() {
      return { gain: { setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined }, connect: () => undefined };
    }
  }

  it("gibt Ton erst nach der ersten Berührung und nur, wenn er eingeschaltet ist; Vibration nur, wo es sie gibt", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const vibrate = vi.fn();
    // Ohne navigator.vibrate (Safari) passiert nichts und nichts wirft.
    expect(() => playFeedback("success", { sound: true, vibration: true })).not.toThrow();
    Object.defineProperty(navigator, "vibrate", { configurable: true, value: vibrate });

    playFeedback("success", { sound: true, vibration: true });
    // Noch nicht entsperrt: kein Ton, aber Vibration.
    expect(FakeAudioContext.instances.reduce((sum, context) => sum + context.started, 0)).toBe(0);
    expect(vibrate).toHaveBeenCalledTimes(1);

    // Die erste Berührung entsperrt; solange nicht gescannt wird, ruht die Tonausgabe wieder.
    unlockAudio();
    const context = FakeAudioContext.instances[0];
    expect(context?.state).toBe("running");
    await Promise.resolve();
    await Promise.resolve();
    expect(context?.state).toBe("suspended");
    setFeedbackActive(true);
    expect(context?.state).toBe("running");
    playFeedback("success", { sound: true, vibration: false });
    expect(context?.started).toBe(2);
    playFeedback("error", { sound: false, vibration: true });
    expect(context?.started).toBe(2);
    expect(vibrate).toHaveBeenLastCalledWith([80, 60, 80]);

    // Am iPhone hält das System den Ton im Hintergrund an: Vor dem nächsten Ton wird er wieder aufgenommen.
    if (context) {
      context.state = "interrupted";
    }
    playFeedback("notice", { sound: true, vibration: false });
    expect(context?.state).toBe("running");
    expect(context?.started).toBe(3);
    setFeedbackActive(false);
    expect(context?.state).toBe("suspended");
    Reflect.deleteProperty(navigator, "vibrate");
    vi.unstubAllGlobals();
  });
});

describe("Mindestgröße eines Etiketts im Bild", () => {
  /** Derselbe Code mit einer anderen Kantenlänge im ausgewerteten Ausschnitt (800 Bildpunkte Kante). */
  const sized = (code: DetectedCode, side: number): DetectedCode => ({ ...code, side });
  // 7 % von 800 Bildpunkten sind 56.
  const SMALL = 55;
  const BIG = 57;

  it("meint mit Zoom denselben Abstand: Bei 2× muss das Etikett im Bild doppelt so groß sein", async () => {
    const env = setup({ appleMobile: true, devices: { cam: { facingMode: ["environment"], zoom: { min: 1, max: 10, step: 0.1 } } } });
    await env.scanner.start();
    expect(env.scanner.state.get().zoom?.value).toBe(2);
    // 10 % des Ausschnitts: ohne Zoom genug, mit 2× (das Etikett im Regal dahinter) nicht.
    env.state.visibleCodes = [sized(at(PACKAGE, 400, 400), 80)];
    await run(env, 1_000);
    expect(env.scans).toEqual([]);
    expect(env.scanner.state.get().too_small).toBe(true);
    // Zurück auf 1×: Jetzt zählt es.
    await env.scanner.setZoom(1);
    await run(env, 200);
    expect(env.scans).toEqual([{ kind: "package", package_id: "A2B3C" }]);
  });

  it("bucht ein zu kleines Etikett nicht und zeigt „Näher ran“; beim Näherkommen zählt es sofort", async () => {
    const env = setup();
    await env.scanner.start();
    env.state.visibleCodes = [sized(at(PACKAGE, 400, 400), SMALL)];
    await run(env, 3_000);
    expect(env.scans).toEqual([]);
    expect(env.scanner.state.get().too_small).toBe(true);

    // Näher: Jetzt misst die Kante mehr als 7 % des Ausschnitts. Es galt bisher als nicht gesehen.
    env.state.visibleCodes = [sized(at(PACKAGE, 400, 400), BIG)];
    await run(env, 100);
    expect(env.scans).toEqual([{ kind: "package", package_id: "A2B3C" }]);
    await run(env, 700);
    expect(env.scanner.state.get().too_small).toBe(false);
  });

  it("nimmt den Hinweis kurz nach dem Verschwinden des Etiketts zurück", async () => {
    const env = setup();
    await env.scanner.start();
    env.state.visibleCodes = [sized(at(ZONE, 400, 400), SMALL)];
    await run(env, 300);
    expect(env.scanner.state.get().too_small).toBe(true);
    env.state.visibleCodes = [];
    await run(env, 500);
    expect(env.scanner.state.get().too_small).toBe(true);
    await run(env, 300);
    expect(env.scanner.state.get().too_small).toBe(false);
    expect(env.scans).toEqual([]);
  });

  it("lässt ein kleines Etikett im Hintergrund in Ruhe, wenn ein anderer gültiger Code im Bild ist", async () => {
    const env = setup();
    await env.scanner.start();
    // Das Etikett im Regal liegt sogar näher an der Bildmitte als der Barcode in der Hand.
    env.state.visibleCodes = [sized(at(PACKAGE, 400, 400), SMALL), at(PRODUCT, 600, 400)];
    await run(env, 3_000);
    expect(env.scans).toEqual([{ kind: "product", barcode: "4006381333931" }]);
    expect(env.scanner.state.get().too_small).toBe(false);

    // Der Barcode ist weg, das Etikett kommt näher: Es war nicht zurückgestellt, nur nicht gezählt.
    env.state.visibleCodes = [sized(at(PACKAGE, 400, 400), BIG)];
    await run(env, 100);
    expect(env.scans).toHaveLength(2);
  });

  it("gilt nicht für Produkt-Barcodes und nicht für fremde Codes", async () => {
    const env = setup();
    await env.scanner.start();
    env.state.visibleCodes = [sized(at(PRODUCT, 400, 400), 10)];
    await run(env, 200);
    expect(env.scans).toEqual([{ kind: "product", barcode: "4006381333931" }]);
    expect(env.scanner.state.get().too_small).toBe(false);
  });

  it("zählt ein Etikett, dessen Größe sich nicht messen lässt", async () => {
    const env = setup();
    await env.scanner.start();
    env.state.visibleCodes = [{ ...PACKAGE, center: null, side: null }];
    await run(env, 200);
    expect(env.scans).toEqual([{ kind: "package", package_id: "A2B3C" }]);
  });

  it("zeigt den Hinweis nicht für ein eben gescanntes Etikett, das weggezogen wird, und bucht es nicht noch einmal", async () => {
    const env = setup();
    await env.scanner.start();
    env.state.visibleCodes = [sized(at(PACKAGE, 400, 400), 200)];
    await run(env, 300);
    expect(env.scans).toHaveLength(1);
    // Die Packung wandert weg, das Etikett wird kleiner, bleibt aber im Bild.
    env.state.visibleCodes = [sized(at(PACKAGE, 400, 400), 30)];
    await run(env, 4_000);
    expect(env.scanner.state.get().too_small).toBe(false);
    // Kommt es wieder näher, ohne zwischendurch verschwunden zu sein, ist es dasselbe Etikett.
    env.state.visibleCodes = [sized(at(PACKAGE, 400, 400), 200)];
    await run(env, 500);
    expect(env.scans).toHaveLength(1);
  });

  it("zeigt den Hinweis auch, wenn daneben nur ein fremder Code liegt, und meldet den fremden nicht", async () => {
    const env = setup();
    await env.scanner.start();
    const foreign = { rawValue: "https://example.org/aktion", format: "qr_code", center: { x: 420, y: 400 }, side: 200 } satisfies DetectedCode;
    env.state.visibleCodes = [foreign, sized(at(ZONE, 600, 400), SMALL)];
    await run(env, 2_000);
    expect(env.scans).toEqual([]);
    expect(env.scanner.state.get().too_small).toBe(true);
  });
});
