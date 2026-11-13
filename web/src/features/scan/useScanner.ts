import { useEffect, useRef, useState, type RefObject } from "react";

import { useLive, type ScanResult } from "@/contract";
import { Scanner, type ScannerState } from "@/core/scanner";

const IDLE: ScannerState = {
  status: "idle",
  error: null,
  engine: null,
  cameraId: null,
  cameras: [],
  torch: { available: false, on: false },
  zoom: null,
  wake_lock: false,
  too_small: false,
};

/** Ein `Live`, das nie etwas meldet: der Zustand, solange es noch keinen Scanner gibt. */
const NO_SCANNER = { get: () => IDLE, subscribe: () => () => undefined };

export interface UseScannerOptions {
  /** Gemerkte Kamera beim Öffnen der Ansicht. */
  cameraId: string | null;
  onScan: (result: ScanResult) => void;
  onCameraChosen: (deviceId: string) => void;
  /** true: Die Kamera läuft weiter, ausgewertet wird aber nichts (ein Dialog ist offen). */
  paused: boolean;
}

export interface UseScanner {
  videoRef: RefObject<HTMLVideoElement | null>;
  state: ScannerState;
  scanner: Scanner | null;
}

/**
 * Bindet den Scanner an die Lebensdauer der Ansicht: Kamera an beim Öffnen, Kamera aus beim
 * Verlassen. React ruft Effekte im Entwicklungsmodus doppelt; der Scanner hält das aus.
 */
export function useScanner({ cameraId, onScan, onCameraChosen, paused }: UseScannerOptions): UseScanner {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [scanner, setScanner] = useState<Scanner | null>(null);
  // Immer die jüngsten Rückrufe, ohne den Scanner dafür neu zu starten.
  const handlers = useRef({ onScan, onCameraChosen });
  useEffect(() => {
    handlers.current = { onScan, onCameraChosen };
  });
  const initialCameraId = useRef(cameraId);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return undefined;
    }
    const instance = new Scanner({
      video,
      cameraId: initialCameraId.current,
      onScan: (result) => handlers.current.onScan(result),
      onCameraChosen: (deviceId) => handlers.current.onCameraChosen(deviceId),
    });
    setScanner(instance);
    void instance.start();
    return () => {
      instance.dispose();
      setScanner(null);
    };
  }, []);

  useEffect(() => {
    if (paused) {
      scanner?.pause();
    } else {
      scanner?.resume();
    }
  }, [scanner, paused]);

  const state = useLive(scanner?.state ?? NO_SCANNER, IDLE);
  return { videoRef, state, scanner };
}
