/**
 * Die Kamera für den Scanner (docs/recherche.md, Abschnitt 1).
 *
 * - Rückkamera, 1920 × 1080 angefordert: Kleine Codes brauchen die Auflösung.
 * - Gewählt wird nach Fähigkeiten (`getCapabilities()`), nie nach Namen: Die Namen der
 *   Kameras sind je Sprache verschieden.
 * - iPhone: Die Mehrfachkamera („Triple", „Dual Wide") wechselt selbstständig die Linse
 *   (WebKit 262416). Gesucht wird deshalb eine feste Rückkamera; die Wahl merkt sich die App
 *   (`prefs.scan_camera_id`), damit die Suche nur einmal nötig ist.
 * - Android: `facingMode: "environment"` kann eine Weitwinkel-Linse ohne Autofokus liefern.
 *   Bevorzugt wird eine Kamera mit Dauerfokus.
 * - Taschenlampe und Zoom gibt es nur, wenn die Kamera sie meldet.
 */

export type CameraErrorKind =
  /** Kein sicherer Kontext (http://<LAN-IP>): Der Browser gibt die Kamera nicht her. */
  | "insecure"
  /** Der Browser kennt die Kamera-Schnittstelle nicht. */
  | "unsupported"
  /** Der Anwender oder das System hat den Zugriff verweigert. */
  | "denied"
  /** Es gibt keine Kamera. */
  | "not_found"
  /** Die Kamera ist belegt oder reagiert nicht. */
  | "in_use"
  /** Alles andere. */
  | "failed";

export class CameraError extends Error {
  constructor(
    readonly kind: CameraErrorKind,
    message?: string,
  ) {
    super(message ?? kind);
    this.name = "CameraError";
  }
}

interface Range {
  min?: number;
  max?: number;
  step?: number;
}

/** `MediaTrackCapabilities` samt der Felder aus „Image Capture", die TypeScript noch nicht kennt. */
export interface CameraCapabilities {
  deviceId?: string;
  facingMode?: string[];
  torch?: boolean;
  zoom?: Range;
  focusMode?: string[];
  focusDistance?: Range;
}

export interface CameraInfo {
  deviceId: string;
  label: string;
  /** Blickrichtung, soweit der Browser sie ohne Öffnen der Kamera verrät. */
  facing: "back" | "front" | "unknown";
}

export interface OpenCamera {
  stream: MediaStream;
  track: MediaStreamTrack;
  /** Kennung der geöffneten Kamera; null, wenn der Browser sie nicht nennt. */
  deviceId: string | null;
  capabilities: CameraCapabilities;
}

const WANTED_SIZE = { width: { ideal: 1920 }, height: { ideal: 1080 } };

function mediaDevices(): MediaDevices {
  const devices = (globalThis.navigator as Navigator | undefined)?.mediaDevices;
  if (!devices || typeof devices.getUserMedia !== "function") {
    const insecure = typeof globalThis.isSecureContext === "boolean" && !globalThis.isSecureContext;
    throw new CameraError(insecure ? "insecure" : "unsupported");
  }
  return devices;
}

function toCameraError(error: unknown): CameraError {
  if (error instanceof CameraError) {
    return error;
  }
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return new CameraError("denied", message);
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return new CameraError("not_found", message);
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return new CameraError("in_use", message);
  }
  return new CameraError("failed", message);
}

export function capabilitiesOf(track: MediaStreamTrack): CameraCapabilities {
  try {
    return typeof track.getCapabilities === "function" ? (track.getCapabilities() as CameraCapabilities) : {};
  } catch {
    return {};
  }
}

export function stopStream(stream: MediaStream | null | undefined): void {
  for (const track of stream?.getTracks() ?? []) {
    try {
      track.stop();
    } catch {
      // schon beendet
    }
  }
}

/**
 * Öffnet eine Kamera: die genannte, sonst die Rückkamera nach Wahl des Browsers.
 * @throws CameraError
 */
export async function openCamera(deviceId: string | null): Promise<OpenCamera> {
  const devices = mediaDevices();
  const video: MediaTrackConstraints = deviceId === null ? { facingMode: { ideal: "environment" }, ...WANTED_SIZE } : { deviceId: { exact: deviceId }, ...WANTED_SIZE };
  let stream: MediaStream;
  try {
    stream = await devices.getUserMedia({ audio: false, video });
  } catch (error) {
    throw toCameraError(error);
  }
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stopStream(stream);
    throw new CameraError("not_found");
  }
  const capabilities = capabilitiesOf(track);
  // Dauerfokus einschalten, wo die Kamera ihn kennt: Etiketten werden aus der Nähe gelesen.
  if (capabilities.focusMode?.includes("continuous")) {
    await track.applyConstraints({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] }).catch(() => undefined);
  }
  let openedId: string | null = null;
  try {
    openedId = track.getSettings().deviceId ?? null;
  } catch {
    openedId = null;
  }
  return { stream, track, deviceId: openedId ?? deviceId, capabilities };
}

/** Alle Kameras des Geräts. Namen gibt es erst, nachdem der Anwender den Zugriff erlaubt hat. */
export async function listCameras(): Promise<CameraInfo[]> {
  let devices: MediaDeviceInfo[];
  try {
    devices = await mediaDevices().enumerateDevices();
  } catch {
    return [];
  }
  const cameras: CameraInfo[] = [];
  for (const device of devices) {
    if (device.kind !== "videoinput" || device.deviceId === "") {
      continue;
    }
    let facing: CameraInfo["facing"] = "unknown";
    try {
      // InputDeviceInfo.getCapabilities gibt es in Chrome und Safari 17, nicht überall.
      const modes = (device as MediaDeviceInfo & { getCapabilities?: () => CameraCapabilities }).getCapabilities?.().facingMode ?? [];
      if (modes.includes("environment")) {
        facing = "back";
      } else if (modes.includes("user")) {
        facing = "front";
      }
    } catch {
      facing = "unknown";
    }
    cameras.push({ deviceId: device.deviceId, label: device.label, facing });
  }
  return cameras;
}

// ------------------------------------------------------------------------------------------
// Auswahl nach Fähigkeiten
// ------------------------------------------------------------------------------------------

/** Kürzester Abstand, auf den die Hauptkamera eines Handys scharf stellt, liegt unter dieser Grenze (Meter). */
const MAIN_CAMERA_MAX_NEAR_FOCUS = 0.35;
/** Darunter stellt nur ein Ultraweitwinkel mit Makro scharf, oder eine Mehrfachkamera, die es enthält. */
const MACRO_NEAR_FOCUS = 0.05;

/**
 * Eine Mehrfachkamera, die selbstständig die Linse wechselt: WebKit zählt dort den Zoom ab
 * dem Ultraweitwinkel, der kleinste Wert liegt also unter 1.
 */
export function isMultiLensCamera(capabilities: CameraCapabilities): boolean {
  return typeof capabilities.zoom?.min === "number" && capabilities.zoom.min < 1;
}

/**
 * Bewertet eine Kamera für das Lesen kleiner Codes aus der Nähe. Höher ist besser.
 *
 *   Rückseite                         +100   (Vorderseite −100)
 *   Mehrfachkamera                     −50   wechselt selbstständig die Linse
 *   Nahgrenze der Hauptkamera          +40   stellt ab etwa 10 bis 20 cm scharf
 *   Dauerfokus ohne Angabe der Grenze  +30
 *   Nahgrenze unter 5 cm               +10   Ultraweitwinkel: Codes werden im Bild sehr klein
 *   Tele oder Fixfokus                  +0
 *   Taschenlampe                        +5
 */
export function scoreCamera(capabilities: CameraCapabilities): number {
  let score = 0;
  const facing = capabilities.facingMode ?? [];
  if (facing.includes("environment")) {
    score += 100;
  } else if (facing.includes("user")) {
    score -= 100;
  }
  if (isMultiLensCamera(capabilities)) {
    score -= 50;
  }
  const near = capabilities.focusDistance?.min;
  if (typeof near === "number") {
    if (near <= MACRO_NEAR_FOCUS) {
      score += 10;
    } else if (near <= MAIN_CAMERA_MAX_NEAR_FOCUS) {
      score += 40;
    }
  } else if (capabilities.focusMode?.includes("continuous")) {
    score += 30;
  }
  if (capabilities.torch === true) {
    score += 5;
  }
  return score;
}

/**
 * Lohnt es sich, nach einer besseren Rückkamera zu suchen? Ja bei einer Mehrfachkamera, bei
 * einem Ultraweitwinkel und bei einer Kamera, die ihren Fokus meldet, aber keinen Dauerfokus hat.
 * Meldet die Kamera gar nichts über ihren Fokus (Webcam, mancher Browser), bleibt es bei ihr.
 */
export function shouldLookForBetterCamera(capabilities: CameraCapabilities): boolean {
  if (capabilities.facingMode?.includes("user")) {
    return false;
  }
  if (isMultiLensCamera(capabilities)) {
    return true;
  }
  const near = capabilities.focusDistance?.min;
  if (typeof near === "number") {
    return near <= MACRO_NEAR_FOCUS || near > MAIN_CAMERA_MAX_NEAR_FOCUS;
  }
  return Array.isArray(capabilities.focusMode) && capabilities.focusMode.length > 0 && !capabilities.focusMode.includes("continuous");
}

/** Höchstens so viele weitere Kameras werden zum Vergleich geöffnet. */
const MAX_PROBES = 4;

/**
 * Sucht unter den übrigen Rückkameras eine, die besser zum Scannen taugt als die geöffnete,
 * und liefert die beste geöffnet zurück. Dafür muss jede Kandidatin kurz geöffnet werden:
 * Nur eine laufende Kamera verrät ihre Fähigkeiten.
 *
 * @param current      die bereits geöffnete Kamera; sie wird dabei geschlossen
 * @param stillWanted  false bricht ab (die Ansicht wurde inzwischen verlassen)
 */
export async function findBestBackCamera(
  current: OpenCamera,
  stillWanted: () => boolean,
  open: (deviceId: string | null) => Promise<OpenCamera> = openCamera,
  list: () => Promise<CameraInfo[]> = listCameras,
): Promise<OpenCamera> {
  const cameras = await list();
  const candidates = cameras.filter((camera) => camera.deviceId !== current.deviceId && camera.facing !== "front").slice(0, MAX_PROBES);
  if (candidates.length === 0 || !stillWanted()) {
    return current;
  }
  // Am iPhone läuft immer nur eine Kamera: erst schließen, dann die nächste öffnen.
  stopStream(current.stream);
  let bestId = current.deviceId;
  let bestScore = scoreCamera(current.capabilities);
  for (const candidate of candidates) {
    if (!stillWanted()) {
      break;
    }
    try {
      const probe = await open(candidate.deviceId);
      const score = scoreCamera(probe.capabilities);
      stopStream(probe.stream);
      if (score > bestScore) {
        bestScore = score;
        bestId = candidate.deviceId;
      }
    } catch {
      // Diese Kamera lässt sich nicht öffnen: keine Kandidatin.
    }
  }
  try {
    return await open(bestId);
  } catch (error) {
    // Die beste ließ sich nicht noch einmal öffnen: zurück zur Wahl des Browsers.
    if (bestId !== null) {
      return open(null);
    }
    throw error;
  }
}

/** Schaltet die Taschenlampe. Liefert, ob es gelungen ist. */
export async function setTorch(track: MediaStreamTrack, on: boolean): Promise<boolean> {
  try {
    await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
    return true;
  } catch {
    return false;
  }
}

/** Setzt den Zoom innerhalb der gemeldeten Grenzen. Liefert den gesetzten Wert oder null. */
export async function setZoom(track: MediaStreamTrack, value: number, range: Range): Promise<number | null> {
  const clamped = Math.min(range.max ?? value, Math.max(range.min ?? value, value));
  try {
    await track.applyConstraints({ advanced: [{ zoom: clamped } as MediaTrackConstraintSet] });
    return clamped;
  } catch {
    return null;
  }
}
