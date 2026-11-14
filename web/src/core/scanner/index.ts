/**
 * Der Scanner: `import { Scanner, playFeedback } from "@/core/scanner"`.
 *
 * Das ist der einzige Teil des Kerns, den die Scan-Ansicht unmittelbar benutzt; alles
 * andere geht über die Schnittstelle `Core`.
 */
export { CameraError, isMultiLensCamera, scoreCamera, shouldLookForBetterCamera, type CameraCapabilities, type CameraErrorKind, type CameraInfo } from "./camera";
export { RESCAN_GAP_MS, SAME_VALUE_WINDOW_MS, ScanDeduper } from "./dedupe";
export type { DetectorKind } from "./detector";
export { canVibrate, installAudioUnlock, isAudioUnlocked, playFeedback, setFeedbackActive, unlockAudio, type FeedbackPrefs, type FeedbackTone } from "./feedback";
export { classifyDetected, isLabelTooSmall, MIN_LABEL_SIDE_RATIO, normalizeFormat, type DetectedCode } from "./formats";
export { CROP_FRACTION, FRAME_INTERVAL_MS, Scanner, type ScannerErrorKind, type ScannerOptions, type ScannerState, type ScannerStatus } from "./scanner";
export { ScreenWakeLock } from "./wake-lock";
