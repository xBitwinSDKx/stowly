/**
 * Der Scanner: Kamera, Erkennung und Auswertung in einem Ablauf (docs/recherche.md, Abschnitt 1).
 *
 * - wertet den mittleren Bildausschnitt etwa zehnmal je Sekunde aus,
 * - ignoriert denselben Wert zwei Sekunden lang; einen Produkt-Barcode, der nach einem Dialog
 *   noch im Bild ist, bis er kurz nicht zu sehen war (src/core/scanner/dedupe.ts),
 * - ordnet jeden Code selbst ein (`classifyScan`): Etikett einer Packung, Etikett einer Zone,
 *   Produkt-Barcode oder unbekannt,
 * - meldet von mehreren Codes im Bild nur den, auf den gezielt wird (siehe `report`),
 * - gibt die Kamera frei, sobald `stop()` gerufen wird oder die App in den Hintergrund geht,
 *   und nimmt sie bei der Rückkehr wieder,
 * - hält das Kamerabild am Laufen: Steht das Video (iOS hält es an, wenn sich über einem Dialog
 *   die Tastatur öffnet), startet er es wieder; kommen trotzdem keine neuen Bilder mehr, öffnet
 *   er die Kamera neu. Sonst sähe die Erkennung immer dasselbe stehende Bild.
 *
 * Start und Stopp dürfen sich überholen: React ruft Effekte im Entwicklungsmodus doppelt,
 * und `getUserMedia` braucht seine Zeit. Jeder Start bekommt deshalb eine Nummer; kommt
 * während des Wartens ein Stopp oder ein neuer Start, räumt der alte Lauf hinter sich auf.
 */
import type { ScanResult } from "@/contract";

import { Signal } from "../live";
import { isAppleMobile } from "../pwa/install";
import {
  CameraError,
  findBestBackCamera,
  listCameras,
  openCamera,
  setTorch,
  setZoom,
  shouldLookForBetterCamera,
  startZoom,
  stopStream,
  type CameraErrorKind,
  type CameraInfo,
  type OpenCamera,
} from "./camera";
import { ScanDeduper } from "./dedupe";
import { createDetector, createZxingFallback, type CodeDetector, type DetectorKind, type Frame } from "./detector";
import { classifyDetected, isLabelTooSmall, type DetectedCode } from "./formats";
import { ScreenWakeLock } from "./wake-lock";

/** Abstand zwischen zwei Auswertungen: etwa zehn je Sekunde. */
export const FRAME_INTERVAL_MS = 100;
/** Ausgewertet wird ein Quadrat in der Bildmitte mit diesem Anteil der kürzeren Bildseite. */
export const CROP_FRACTION = 0.8;
/** Größere Ausschnitte werden auf diese Kantenlänge verkleinert. */
const MAX_FRAME_SIZE = 1_280;
/** Nach so vielen Fehlern in Folge wechselt die eingebaute Erkennung auf die mitgelieferte. */
const NATIVE_FAILURES_BEFORE_FALLBACK = 3;
/** So lange muss ein fremder Code zu sehen sein, ohne dass etwas Bekanntes im Bild ist, bevor er gemeldet wird. */
export const UNKNOWN_PATIENCE_MS = 500;
/** War ein fremder Code länger als so nicht zu sehen, beginnt das Abwarten von vorn. */
const UNKNOWN_GAP_MS = 1_000;
/** So lange bleibt der Hinweis „Näher ran" stehen, nachdem das zu kleine Etikett zuletzt zu sehen war. */
export const TOO_SMALL_LINGER_MS = 600;
/** So lange bleibt der Hinweis „Zum erneuten Scannen kurz wegschwenken" stehen, nachdem der Code zuletzt zu sehen war. */
export const RESCAN_HINT_LINGER_MS = 600;
/** Steht das Video, wird es höchstens so oft wieder gestartet. */
const PLAY_RETRY_MS = 1_000;
/**
 * Kommen so lange keine neuen Kamerabilder, obwohl ausgewertet werden soll, öffnet der Scanner
 * die Kamera neu. Eine laufende Kamera liefert 15 bis 30 Bilder je Sekunde; drei Sekunden ohne
 * eines heißen: Sie steht. Neu geöffnet wird nur, wenn seit dem letzten Öffnen schon Bilder kamen.
 */
export const STALL_RESTART_MS = 3_000;
/** Neu geöffnet wird höchstens so oft: Jedes Öffnen kann am iPhone nach der Kamera fragen. */
export const STALL_RESTART_SPACING_MS = 15_000;
/** So viele Auswertungen fließen in den Mittelwert von `diagnostics`. */
const DIAGNOSTIC_SAMPLES = 20;

/**
 * Was die Scan-Ansicht mit `?diagnose` in der Adresse anzeigt: Kamera, Zoom und Erkennung, so wie
 * der Browser sie meldet. Nur zum Nachsehen am Gerät; nichts davon steuert den Scanner.
 */
export interface ScannerDiagnostics {
  /** Gilt das Gerät als iPhone oder iPad (Start mit Zoom, `startZoom`)? */
  apple_mobile: boolean;
  engine: DetectorKind | null;
  /** Name der laufenden Kamera, wie der Browser ihn nennt. */
  camera: string | null;
  /** Alle Kameras, zwischen denen sich umschalten lässt. */
  cameras: string[];
  /** `getCapabilities()` und `getSettings()` der laufenden Kamera, unverändert; null, wo der Browser nichts sagt. */
  capabilities: Record<string, unknown> | null;
  settings: Record<string, unknown> | null;
  /** Größe des Kamerabilds und des ausgewerteten Ausschnitts in Pixeln. */
  video: string | null;
  frame: number | null;
  /** So groß zeigt die Seite das Kamerabild, in CSS-Pixeln. */
  display: string | null;
  /** Neue Kamerabilder je Sekunde, gezählt über die letzten zwei Sekunden; null, solange keine kamen. */
  fps: number | null;
  /** So oft wurde die Kamera geöffnet (Start, Umschalten, Neustart nach stehendem Bild). */
  starts: number;
  /** Die Auswertung ist angehalten (ein Dialog ist offen). */
  paused: boolean;
  /** Dauer der Auswertung je Bild: letzte und Mittel der letzten Bilder, in Millisekunden. */
  detect_ms: { last: number | null; average: number | null };
}

export type ScannerStatus =
  /** Die Kamera ist aus. */
  | "idle"
  /** Kamera und Erkennung werden geöffnet. */
  | "starting"
  /** Es wird gescannt. */
  | "running"
  /** Es geht nicht; `error` sagt, warum. */
  | "error";

export type ScannerErrorKind =
  | CameraErrorKind
  /** Die Erkennung ließ sich nicht laden. */
  | "detector";

export interface ScannerState {
  status: ScannerStatus;
  error: ScannerErrorKind | null;
  /** Welche Erkennung läuft. */
  engine: DetectorKind | null;
  /** Kennung der laufenden Kamera. */
  cameraId: string | null;
  /** Alle Kameras, zwischen denen sich umschalten lässt. */
  cameras: CameraInfo[];
  /** Taschenlampe: nur vorhanden, wenn die Kamera sie meldet. */
  torch: { available: boolean; on: boolean };
  /** Zoom: null, wenn die Kamera keinen meldet. */
  zoom: { min: number; max: number; step: number; value: number } | null;
  /** Der Bildschirm wird wach gehalten. */
  wake_lock: boolean;
  /**
   * Gezielt wird auf ein Etikett, das im Bild zu klein ist, um zu zählen (`MIN_LABEL_SIDE_RATIO`):
   * Die Ansicht zeigt „Näher ran". Gebucht wird nichts.
   */
  too_small: boolean;
  /**
   * Gezielt wird auf einen Produkt-Barcode, der seit dem letzten Dialog durchgehend im Bild ist:
   * Er zählt erst wieder, wenn er kurz nicht zu sehen war (`RESCAN_GAP_MS`). Die Ansicht sagt,
   * dass kurzes Wegschwenken genügt.
   */
  rescan: boolean;
}

const INITIAL_STATE: ScannerState = {
  status: "idle",
  error: null,
  engine: null,
  cameraId: null,
  cameras: [],
  torch: { available: false, on: false },
  zoom: null,
  wake_lock: false,
  too_small: false,
  rescan: false,
};

/** Ein Videoelement mit `requestVideoFrameCallback` (Safari 15.4, Chrome 83, Firefox 132). */
type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/** Ist der Schlüssel eines Codes (`<Format>:<Inhalt>`) ein Produkt-Barcode? */
function isProductKey(key: string): boolean {
  const split = key.indexOf(":");
  return split > 0 && classifyDetected({ format: key.slice(0, split), rawValue: key.slice(split + 1) }).kind === "product";
}

/** Was der Scanner von außen braucht; in Tests durch Nachbildungen ersetzbar. */
export interface ScannerDeps {
  openCamera: typeof openCamera;
  listCameras: typeof listCameras;
  findBestBackCamera: typeof findBestBackCamera;
  createDetector: () => Promise<CodeDetector>;
  createZxingFallback: () => Promise<CodeDetector>;
  /** Uhr in Millisekunden. */
  now: () => number;
  /** Läuft die App auf einem iPhone oder iPad? Dann beginnt die Kamera gezoomt (`startZoom`). */
  appleMobile: () => boolean;
}

export interface ScannerOptions {
  /** Das Element, das das Kamerabild zeigt. */
  video: HTMLVideoElement;
  /** Gemerkte Kamera (`prefs.scan_camera_id`) oder null = selbst wählen. */
  cameraId: string | null;
  /** Wird für jeden neu erkannten Code gerufen, schon eingeordnet. */
  onScan: (result: ScanResult) => void;
  /** Der Scanner hat eine Kamera gewählt (selbst oder durch Umschalten): merken. */
  onCameraChosen?: (deviceId: string) => void;
  deps?: Partial<ScannerDeps>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Scanner {
  readonly state = new Signal<ScannerState>(INITIAL_STATE);

  private readonly video: HTMLVideoElement;
  private readonly deps: ScannerDeps;
  private readonly deduper = new ScanDeduper();
  private readonly wakeLock = new ScreenWakeLock();
  private generation = 0;
  private camera: OpenCamera | null = null;
  private detector: CodeDetector | null = null;
  private detectorPromise: Promise<CodeDetector> | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private cameraId: string | null;
  /** Der Aufrufer will scannen; bleibt auch wahr, während die App im Hintergrund ist. */
  private wanted = false;
  private paused = false;
  /** Seit wann die Auswertung angehalten ist. */
  private pausedAt = 0;
  private disposed = false;
  private listening = false;
  /** Der fremde Code, der gerade allein im Bild ist: seit wann, und wann zuletzt gesehen. */
  private unknownPending: { key: string; since: number; last: number } | null = null;
  /** Wann zuletzt auf ein zu kleines Etikett gezielt wurde. */
  private tooSmallAt = 0;
  /** Wann zuletzt auf einen Produkt-Barcode gezielt wurde, der seit dem Dialog im Bild ist. */
  private rescanAt = 0;
  /** Wie lange die letzten Auswertungen dauerten, in Millisekunden (für `diagnostics`). */
  private readonly detectTimes: number[] = [];
  /** Wann die letzten Kamerabilder kamen (Uhr des Scanners), für die Bildrate in `diagnostics`. */
  private readonly frameTimes: number[] = [];
  /** So oft wurde die Kamera geöffnet, seit es diesen Scanner gibt (Umschalten, Neustart). */
  private starts = 0;
  /** Ändert das Video seine Größe, wird es neu gesetzt (`refreshVideoLayout`). */
  private readonly onVideoResize = () => this.refreshVideoLayout();
  /** Wann zuletzt ein neues Kamerabild kam (Uhr des Scanners). */
  private lastFrameAt = 0;
  /** Seit dem letzten Öffnen der Kamera kam schon ein neues Bild. */
  private framesFlowing = false;
  /** Ohne `requestVideoFrameCallback`: die zuletzt gesehene Abspielposition. */
  private lastVideoTime = -1;
  private frameCallback: number | null = null;
  private lastPlayAttempt = Number.NEGATIVE_INFINITY;
  private lastRestart = Number.NEGATIVE_INFINITY;

  private readonly onVisibility = () => {
    if (document.visibilityState === "hidden") {
      // Im Hintergrund gehört die Kamera nicht mehr dieser App.
      if (this.state.get().status !== "idle") {
        this.halt();
      }
    } else if (this.wanted && this.state.get().status === "idle") {
      void this.begin();
    }
  };

  constructor(private readonly options: ScannerOptions) {
    this.video = options.video;
    this.cameraId = options.cameraId;
    this.deps = {
      openCamera,
      listCameras,
      findBestBackCamera,
      createDetector,
      createZxingFallback,
      now: () => performance.now(),
      appleMobile: () => isAppleMobile(globalThis.navigator),
      ...options.deps,
    };
  }

  /** Öffnet die Kamera und beginnt zu scannen. Mehrfache Aufrufe schaden nicht. */
  async start(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.wanted = true;
    if (!this.listening) {
      this.listening = true;
      document.addEventListener("visibilitychange", this.onVisibility);
    }
    if (document.visibilityState === "hidden") {
      return;
    }
    const status = this.state.get().status;
    if (status === "starting" || status === "running") {
      return;
    }
    await this.begin();
  }

  /** Gibt die Kamera frei. */
  stop(): void {
    this.wanted = false;
    this.halt();
  }

  /** Gibt alles frei. Danach ist der Scanner nicht mehr benutzbar. */
  dispose(): void {
    this.stop();
    this.disposed = true;
    this.video.removeEventListener?.("resize", this.onVideoResize);
    if (this.listening) {
      this.listening = false;
      document.removeEventListener("visibilitychange", this.onVisibility);
    }
    const pending = this.detectorPromise;
    this.detectorPromise = null;
    this.detector = null;
    void pending?.then((detector) => detector.dispose()).catch(() => undefined);
  }

  /** Kamera, Zoom und Erkennung, wie der Browser sie meldet (`ScannerDiagnostics`). */
  diagnostics(): ScannerDiagnostics {
    const track = this.camera?.track;
    const read = (get: () => unknown): Record<string, unknown> | null => {
      try {
        const value = get();
        return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    };
    const times = this.detectTimes;
    const state = this.state.get();
    return {
      apple_mobile: this.deps.appleMobile(),
      engine: state.engine,
      camera: track?.label || null,
      cameras: state.cameras.map((camera) => camera.label),
      capabilities: track && typeof track.getCapabilities === "function" ? read(() => track.getCapabilities()) : null,
      settings: track ? read(() => track.getSettings()) : null,
      video: this.video.videoWidth ? `${String(this.video.videoWidth)} × ${String(this.video.videoHeight)}` : null,
      frame: this.canvas?.width ?? null,
      display: this.video.clientWidth ? `${String(this.video.clientWidth)} × ${String(this.video.clientHeight)}` : null,
      fps: (() => {
        const times = this.frameTimes;
        if (times.length < 2) {
          return null;
        }
        const span = (times.at(-1) as number) - (times[0] as number);
        return span > 0 ? Math.round(((times.length - 1) * 1000) / span) : null;
      })(),
      starts: this.starts,
      paused: this.paused,
      detect_ms: {
        last: times.length > 0 ? Math.round((times.at(-1) as number) * 10) / 10 : null,
        average: times.length > 0 ? Math.round((times.reduce((sum, value) => sum + value, 0) / times.length) * 10) / 10 : null,
      },
    };
  }

  /** Hält die Auswertung an, ohne die Kamera zu schließen (z. B. solange ein Dialog offen ist). */
  pause(): void {
    if (!this.paused) {
      this.paused = true;
      this.pausedAt = this.deps.now();
    }
  }

  /**
   * Wertet wieder aus. Was beim Anhalten im Bild war, zählt nicht sofort: ein Produkt-Barcode
   * erst, wenn er kurz nicht zu sehen war, ein Etikett (es bucht ohne Rückfrage) erst nach zwei
   * Sekunden. Steht das Video inzwischen, läuft es wieder an.
   */
  resume(): void {
    if (this.paused) {
      this.paused = false;
      const now = this.deps.now();
      this.deduper.refresh(now, this.pausedAt, isProductKey);
      // Ob noch Bilder kommen, zählt ab jetzt.
      this.lastFrameAt = now;
      this.ensurePlaying(now);
    }
  }

  /** Schaltet auf die nächste Kamera um und merkt die Wahl. */
  async switchCamera(): Promise<void> {
    const { cameras, cameraId } = this.state.get();
    if (cameras.length < 2) {
      return;
    }
    // Erst die Rückkameras der Reihe nach, dann die vordere.
    const order = [...cameras.filter((camera) => camera.facing !== "front"), ...cameras.filter((camera) => camera.facing === "front")];
    const index = order.findIndex((camera) => camera.deviceId === cameraId);
    const next = order[(index + 1) % order.length];
    if (!next || next.deviceId === cameraId) {
      return;
    }
    this.cameraId = next.deviceId;
    this.options.onCameraChosen?.(next.deviceId);
    if (this.wanted) {
      this.halt();
      await this.begin();
    }
  }

  async setTorch(on: boolean): Promise<void> {
    const camera = this.camera;
    if (!camera || !this.state.get().torch.available) {
      return;
    }
    if (await setTorch(camera.track, on)) {
      this.patch({ torch: { available: true, on } });
    }
  }

  async setZoom(value: number): Promise<void> {
    const camera = this.camera;
    const zoom = this.state.get().zoom;
    if (!camera || !zoom) {
      return;
    }
    const applied = await setZoom(camera.track, value, zoom);
    if (applied !== null) {
      this.patch({ zoom: { ...zoom, value: applied } });
      this.refreshVideoLayout();
    }
  }

  /**
   * Setzt das Kamerabild neu in seine Fläche. iOS zeigt es nach einer Änderung seiner Größe (Zoom,
   * andere Kamera) mitunter weiter in der alten, zu kleinen Größe an, bis die Seite neu gesetzt
   * wird; ein kurzer Wechsel von `object-fit` erzwingt das.
   */
  private refreshVideoLayout(): void {
    const video = this.video;
    if (!video.style) {
      return;
    }
    video.style.objectFit = "fill";
    void video.offsetWidth;
    video.style.removeProperty("object-fit");
  }

  // ---------------------------------------------------------------- Ablauf

  private patch(changes: Partial<ScannerState>): void {
    this.state.update((current) => ({ ...current, ...changes }));
  }

  private async begin(): Promise<void> {
    this.generation += 1;
    const run = this.generation;
    const current = () => run === this.generation && !this.disposed;
    this.patch({ status: "starting", error: null });
    let camera: OpenCamera | null = null;
    try {
      camera = await this.openPreferred(current);
      if (!current()) {
        stopStream(camera.stream);
        return;
      }
      this.camera = camera;
      this.starts += 1;
      const zoom = camera.capabilities.zoom;
      const zoomUsable = zoom !== undefined && typeof zoom.min === "number" && typeof zoom.max === "number" && zoom.max > zoom.min;
      let zoomValue = zoomUsable ? Math.max(1, zoom.min as number) : 1;
      // Am iPhone beginnt der Scanner gezoomt: Dann hält man es weit genug weg, um scharf zu sehen.
      // Der Zoom kommt, bevor das Video das Bild zeigt: Ändert er es danach, zeigte iOS das
      // Kamerabild mitunter kleiner als die Fläche dafür.
      const wanted = zoomUsable ? startZoom(camera.capabilities, this.deps.appleMobile()) : null;
      if (zoomUsable && wanted !== null) {
        const applied = await setZoom(camera.track, wanted, zoom);
        if (!current()) {
          // `halt()` hat die Kamera schon freigegeben.
          return;
        }
        if (applied !== null) {
          zoomValue = applied;
        }
      }
      await this.attach(camera);
      this.watchFrames(run);
      let detector: CodeDetector;
      try {
        detector = await this.ensureDetector();
      } catch {
        throw new ScannerFailure("detector");
      }
      if (!current()) {
        // `halt()` hat die Kamera schon freigegeben.
        return;
      }
      this.patch({
        status: "running",
        error: null,
        engine: detector.kind,
        cameraId: camera.deviceId,
        torch: { available: camera.capabilities.torch === true, on: false },
        zoom: zoomUsable ? { min: zoom.min as number, max: zoom.max as number, step: zoom.step ?? 0.1, value: zoomValue } : null,
      });
      camera.track.addEventListener("ended", () => {
        // Das System hat die Kamera entzogen (anderer Tab, Anruf).
        if (current() && this.camera === camera) {
          this.halt();
          this.patch({ status: "error", error: "in_use" });
        }
      });
      void this.wakeLock.acquire().then((held) => {
        if (current()) {
          this.patch({ wake_lock: held });
        }
      });
      void this.deps.listCameras().then((cameras) => {
        if (current()) {
          this.patch({ cameras });
        }
      });
      void this.loop(run);
    } catch (error) {
      if (!current()) {
        if (camera && this.camera !== camera) {
          stopStream(camera.stream);
        }
        return;
      }
      this.releaseCamera();
      const kind: ScannerErrorKind = error instanceof ScannerFailure ? error.kind : error instanceof CameraError ? error.kind : "failed";
      this.patch({ status: "error", error: kind, engine: null, torch: { available: false, on: false }, zoom: null });
    }
  }

  /** Beendet den laufenden Lauf, ohne den Wunsch des Aufrufers zu vergessen. */
  private halt(): void {
    this.generation += 1;
    this.unknownPending = null;
    if (this.frameCallback !== null) {
      (this.video as FrameVideo).cancelVideoFrameCallback?.(this.frameCallback);
      this.frameCallback = null;
    }
    this.releaseCamera();
    this.wakeLock.release();
    this.patch({ status: "idle", error: null, torch: { available: false, on: false }, zoom: null, wake_lock: false, too_small: false, rescan: false });
  }

  /**
   * Merkt jedes neue Kamerabild: über `requestVideoFrameCallback`, wo es das gibt, sonst in der
   * Schleife über die Abspielposition (`stalled`).
   */
  private watchFrames(run: number): void {
    const video = this.video as FrameVideo;
    this.framesFlowing = false;
    this.lastFrameAt = this.deps.now();
    // Erst eine Abspielposition, die weiterläuft, heißt: Es kam ein neues Bild.
    this.lastVideoTime = video.currentTime;
    const request = video.requestVideoFrameCallback;
    if (typeof request !== "function") {
      return;
    }
    const next = () => {
      if (run !== this.generation) {
        return;
      }
      this.noteFrame();
      this.frameCallback = request.call(video, next);
    };
    this.frameCallback = request.call(video, next);
  }

  private noteFrame(): void {
    this.framesFlowing = true;
    this.lastFrameAt = this.deps.now();
    this.frameTimes.push(this.lastFrameAt);
    while (this.frameTimes.length > 0 && this.lastFrameAt - (this.frameTimes[0] as number) > 2_000) {
      this.frameTimes.shift();
    }
  }

  /** Steht das Video, wird es wieder gestartet, höchstens einmal je Sekunde. */
  private ensurePlaying(now: number): void {
    const video = this.video;
    if (!video.paused || video.srcObject === null || now - this.lastPlayAttempt < PLAY_RETRY_MS) {
      return;
    }
    this.lastPlayAttempt = now;
    try {
      const played = video.play() as Promise<void> | undefined;
      played?.catch(() => undefined);
    } catch {
      // Der Browser verweigert es gerade; der nächste Versuch kommt mit der nächsten Runde.
    }
  }

  /**
   * Kommen noch neue Bilder? Steht das Video, läuft es wieder an. true heißt: Seit dem letzten
   * Öffnen kamen schon Bilder, jetzt aber `STALL_RESTART_MS` lang keine mehr; die Kamera wird neu
   * geöffnet, höchstens alle 15 Sekunden.
   */
  private stalled(now: number): boolean {
    const video = this.video as FrameVideo;
    if (typeof video.requestVideoFrameCallback !== "function") {
      const time = video.currentTime;
      if (time !== this.lastVideoTime) {
        this.lastVideoTime = time;
        this.noteFrame();
      }
    }
    const quiet = now - this.lastFrameAt;
    if (quiet < PLAY_RETRY_MS) {
      return false;
    }
    this.ensurePlaying(now);
    return this.framesFlowing && quiet >= STALL_RESTART_MS && now - this.lastRestart >= STALL_RESTART_SPACING_MS;
  }

  /** Die Kamera liefert keine Bilder mehr: neu öffnen, wie beim Umschalten. Was gesperrt ist, bleibt gesperrt. */
  private async restartCamera(run: number): Promise<void> {
    if (run !== this.generation || !this.wanted || this.disposed) {
      return;
    }
    this.lastRestart = this.deps.now();
    this.halt();
    await this.begin();
  }

  private releaseCamera(): void {
    const camera = this.camera;
    this.camera = null;
    stopStream(camera?.stream);
    try {
      this.video.pause();
    } catch {
      // jsdom und manche Browser kennen hier keinen Zustand zum Anhalten
    }
    this.video.srcObject = null;
  }

  /** Öffnet die gemerkte Kamera; gibt es sie nicht mehr oder gab es noch keine Wahl, sucht der Scanner selbst. */
  private async openPreferred(stillWanted: () => boolean): Promise<OpenCamera> {
    const { openCamera: open, findBestBackCamera: findBest } = this.deps;
    let camera: OpenCamera | null = null;
    if (this.cameraId !== null) {
      try {
        camera = await open(this.cameraId);
      } catch (error) {
        const kind = error instanceof CameraError ? error.kind : "failed";
        if (kind === "denied" || kind === "insecure" || kind === "unsupported") {
          throw error;
        }
        // Die gemerkte Kamera gibt es nicht mehr (anderes Gerät, neue Kennungen): neu wählen.
        this.cameraId = null;
      }
    }
    if (camera === null) {
      camera = await open(null);
      if (stillWanted() && shouldLookForBetterCamera(camera.capabilities)) {
        camera = await findBest(camera, stillWanted, open, this.deps.listCameras);
      }
    }
    if (stillWanted() && camera.deviceId !== null && camera.deviceId !== this.cameraId) {
      this.cameraId = camera.deviceId;
      this.options.onCameraChosen?.(camera.deviceId);
    }
    return camera;
  }

  private async attach(camera: OpenCamera): Promise<void> {
    const video = this.video;
    video.muted = true;
    video.playsInline = true;
    // iOS zeigt das Bild sonst im Vollbild-Player.
    video.setAttribute("playsinline", "");
    // Dieselbe Funktion meldet sich nur einmal an, auch beim nächsten Öffnen.
    video.addEventListener?.("resize", this.onVideoResize);
    video.srcObject = camera.stream;
    try {
      await video.play();
    } catch {
      // Unterbrochen durch einen Stopp oder vom Browser verweigert: Die Schleife wartet auf Bilder.
    }
  }

  private ensureDetector(): Promise<CodeDetector> {
    if (this.detector) {
      return Promise.resolve(this.detector);
    }
    this.detectorPromise ??= this.deps.createDetector();
    const promise = this.detectorPromise;
    return promise.then(
      (detector) => {
        if (this.detectorPromise === promise) {
          this.detector = detector;
        }
        return detector;
      },
      (error: unknown) => {
        if (this.detectorPromise === promise) {
          // Beim nächsten Start noch einmal versuchen.
          this.detectorPromise = null;
        }
        throw error;
      },
    );
  }

  private async loop(run: number): Promise<void> {
    let failures = 0;
    while (run === this.generation) {
      const started = this.deps.now();
      // Die Hinweise verschwinden kurz nachdem ihr Code nicht mehr zu sehen ist.
      if (this.state.get().too_small && (this.paused || started - this.tooSmallAt > TOO_SMALL_LINGER_MS)) {
        this.patch({ too_small: false });
      }
      if (this.state.get().rescan && (this.paused || started - this.rescanAt > RESCAN_HINT_LINGER_MS)) {
        this.patch({ rescan: false });
      }
      if (!this.paused && this.stalled(started)) {
        void this.restartCamera(run);
        return;
      }
      if (!this.paused) {
        const frame = this.grabFrame();
        const detector = this.detector;
        if (frame && detector) {
          try {
            const detectStarted = this.deps.now();
            const codes = await detector.detect(frame);
            if (run !== this.generation) {
              return;
            }
            this.detectTimes.push(this.deps.now() - detectStarted);
            if (this.detectTimes.length > DIAGNOSTIC_SAMPLES) {
              this.detectTimes.shift();
            }
            failures = 0;
            if (!this.paused) {
              this.report(codes, frame);
            }
          } catch {
            if (run !== this.generation) {
              return;
            }
            failures += 1;
            if (failures >= NATIVE_FAILURES_BEFORE_FALLBACK) {
              failures = 0;
              await this.fallBack(run, detector);
            }
          }
        }
      }
      const elapsed = this.deps.now() - started;
      await sleep(Math.max(15, FRAME_INTERVAL_MS - elapsed));
    }
  }

  /**
   * Die eingebaute Erkennung versagt wiederholt (auf Android etwa, wenn ihr Modul beim
   * ersten Einsatz ohne Netz noch nicht geladen ist): weiter mit der mitgelieferten.
   */
  private async fallBack(run: number, failed: CodeDetector): Promise<void> {
    if (failed.kind !== "native") {
      return;
    }
    try {
      const replacement = await this.deps.createZxingFallback();
      if (run !== this.generation || this.detector !== failed) {
        replacement.dispose();
        return;
      }
      failed.dispose();
      this.detector = replacement;
      this.detectorPromise = Promise.resolve(replacement);
      // Die Zeichenfläche wird neu angelegt: Die mitgelieferte Erkennung liest die Bildpunkte aus.
      this.canvas = null;
      this.context = null;
      this.patch({ engine: replacement.kind });
    } catch {
      // Auch die mitgelieferte Erkennung lädt nicht: beim nächsten Fehler noch einmal.
    }
  }

  /** Der mittlere Bildausschnitt des aktuellen Kamerabilds; null, solange noch kein Bild da ist. */
  private grabFrame(): Frame | null {
    const video = this.video;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height || video.readyState < 2) {
      return null;
    }
    const side = Math.round(Math.min(width, height) * CROP_FRACTION);
    const size = Math.min(side, MAX_FRAME_SIZE);
    if (!this.canvas || !this.context) {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: this.detector?.kind !== "native" });
      if (!context) {
        return null;
      }
      this.canvas = canvas;
      this.context = context;
    }
    const canvas = this.canvas;
    const context = this.context;
    if (canvas.width !== size || canvas.height !== size) {
      canvas.width = size;
      canvas.height = size;
    }
    context.drawImage(video, (width - side) / 2, (height - side) / 2, side, side, 0, 0, size, size);
    return { canvas, width: size, height: size, imageData: () => context.getImageData(0, 0, size, size) };
  }

  /**
   * Meldet je Bild höchstens einen Code: den, auf den gezielt wird.
   *
   * - Es zählt der Code, der der Bildmitte am nächsten liegt. Was sonst im Bild ist, löst
   *   nichts aus: nicht das Etikett im Regal hinter dem Produkt, nicht der Barcode neben dem
   *   Etikett derselben Packung. Solange der gemeldete Code im Bild bleibt und noch zwei
   *   Sekunden danach bleiben die übrigen zurückgestellt, damit das Wegziehen der Packung
   *   keinen zweiten Vorgang auslöst. Wer danach bewusst auf einen von ihnen zielt, wird bedient.
   * - Fremde Codes (der Werbe-QR neben dem Barcode, ein verlesener Barcode) zählen nur, wenn
   *   nichts Bekanntes im Bild ist, und erst, wenn sie eine halbe Sekunde lang zu sehen waren:
   *   Der Barcode daneben wird oft einen Augenblick später lesbar.
   * - Das Etikett einer Packung oder Zone zählt erst ab einer Mindestgröße im Bild
   *   (`MIN_LABEL_SIDE_RATIO`, src/core/scanner/formats.ts). Ein kleineres gilt als nicht gesehen,
   *   damit es beim Näherkommen sofort zählt. Wird gerade darauf gezielt, steht `too_small`.
   */
  private report(codes: readonly DetectedCode[], frame: Frame): void {
    if (codes.length === 0) {
      return;
    }
    const now = this.deps.now();
    const distance = (code: DetectedCode) => (code.center ? Math.hypot(code.center.x - frame.width / 2, code.center.y - frame.height / 2) : Number.MAX_VALUE);
    // Jeder Wert einmal, der Mitte am nächsten zuerst. Etiketten, die im Bild zu klein sind
    // (das Etikett im Regal dahinter), zählen nicht: Sie gelten als nicht gesehen.
    const entries = new Map<string, ScanResult>();
    const tooSmall = new Map<string, ScanResult>();
    /** Der Code, auf den gezielt wird, wenn die Größe keine Rolle spielte. */
    let aimed: string | null = null;
    let aimedKnown = false;
    for (const code of [...codes].sort((a, b) => distance(a) - distance(b))) {
      const key = `${code.format}:${code.rawValue}`;
      if (entries.has(key) || tooSmall.has(key)) {
        continue;
      }
      const result = classifyDetected(code);
      if (result.kind !== "unknown" && !aimedKnown) {
        aimed = key;
        aimedKnown = true;
      } else if (aimed === null) {
        aimed = key;
      }
      (isLabelTooSmall(code, frame.width, this.state.get().zoom?.value ?? 1) ? tooSmall : entries).set(key, result);
    }
    for (const key of tooSmall.keys()) {
      // Ein eben gescanntes Etikett, das weggezogen wird, bleibt gesperrt, solange es zu sehen ist.
      this.deduper.see(key, now);
    }
    const all = [...entries];
    const target = all.find(([, result]) => result.kind !== "unknown") ?? all[0];
    if (aimed !== null && tooSmall.has(aimed) && (!target || target[1].kind === "unknown")) {
      // Gezielt wird auf ein Etikett, das zu weit weg ist, und sonst ist nichts Gültiges im
      // Bild: nichts buchen, sondern „Näher ran" zeigen. Nicht, wenn es eben erst gescannt wurde.
      if (!this.deduper.suppressed(aimed, now)) {
        this.tooSmallAt = now;
        if (!this.state.get().too_small) {
          this.patch({ too_small: true });
        }
      }
      return;
    }
    if (!target) {
      return;
    }
    const [targetKey, targetResult] = target;
    const bystanders = all.filter(([key]) => key !== targetKey);

    if (targetResult.kind === "unknown") {
      // Nur Fremdes im Bild: abwarten, ob noch etwas Bekanntes lesbar wird.
      const pending = this.unknownPending;
      if (!pending || pending.key !== targetKey || now - pending.last > UNKNOWN_GAP_MS) {
        this.unknownPending = { key: targetKey, since: now, last: now };
        return;
      }
      pending.last = now;
      if (now - pending.since < UNKNOWN_PATIENCE_MS) {
        return;
      }
    } else {
      this.unknownPending = null;
    }

    for (const [key, result] of bystanders) {
      if (result.kind === "unknown" && targetResult.kind !== "unknown") {
        // Fremdes neben Bekanntem gilt als gesehen: Es meldet sich auch beim Wegziehen nicht.
        this.deduper.check(key, now);
      } else {
        this.deduper.see(key, now);
      }
    }
    const sighting = this.deduper.check(targetKey, now);
    if (sighting === "held") {
      return;
    }
    // Gerade gemeldet oder seit der Meldung im Bild: Was daneben liegt, bleibt zurückgestellt.
    for (const [key] of bystanders) {
      this.deduper.hold(key, now);
    }
    if (sighting === "repeat") {
      if (this.deduper.waitsForGap(targetKey)) {
        // Seit dem Dialog durchgehend im Bild: sagen, was hilft, statt still nichts zu tun.
        this.rescanAt = now;
        if (!this.state.get().rescan) {
          this.patch({ rescan: true });
        }
      }
      return;
    }
    if (this.state.get().rescan) {
      this.patch({ rescan: false });
    }
    try {
      this.options.onScan(targetResult);
    } catch (error) {
      console.error("Stowly: Fehler bei der Auswertung eines Scans.", error);
    }
  }
}

class ScannerFailure extends Error {
  constructor(readonly kind: ScannerErrorKind) {
    super(kind);
  }
}
