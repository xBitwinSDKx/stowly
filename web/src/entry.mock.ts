/**
 * Verdrahtung für die Attrappe (`npm run dev:mock`, `npm run build:mock`, Tests der Oberfläche).
 *
 * Der Alias "@entry" zeigt je nach Ausprägung auf diese Datei oder auf entry.real.ts.
 * Beide exportieren dasselbe: `createCore`, `ScanPage`, `ENTRY`.
 *
 * Ausgangslage wählen:   http://localhost:8012/?mock=offline,problems
 * In der Konsole:        stowlyMock.setOnline(false)   (siehe MockControl in src/mock/core.ts)
 * Echte Scan-Ansicht:    http://localhost:8013/scan?scan=real   (nur im Entwicklungsserver)
 */
import { createElement, lazy, Suspense, type ComponentType } from "react";

import type { Core } from "@/contract";
import { createMockCore, MOCK_SCENARIOS, MockScanPage, type MockControl, type MockScenario } from "@/mock";

export const ENTRY: "real" | "mock" = "mock";

declare global {
  interface Window {
    stowlyMock?: MockControl;
  }
}

export function createCore(): Core {
  const requested = new URLSearchParams(window.location.search).get("mock")?.split(",") ?? [];
  const scenarios = requested.filter((name): name is MockScenario => (MOCK_SCENARIOS as readonly string[]).includes(name));
  const core = createMockCore({ scenarios });
  window.stowlyMock = core.control;
  // Kennzeichnet die Seite sichtbar als Attrappe (global.css).
  document.documentElement.dataset.mock = "true";
  return core;
}

// ---------------------------------------------------------------------------------------
// Scan-Ansicht: Vorgabe ist der Platzhalter der Attrappe. Mit ?scan=real lädt der
// Entwicklungsserver stattdessen die echte Ansicht aus src/features/scan, sodass sie sich
// auf den Beispieldaten ausprobieren lässt (?scan=mock schaltet zurück). Die Wahl gilt,
// bis der Tab geschlossen wird.
// ---------------------------------------------------------------------------------------

const SCAN_CHOICE_KEY = "stowly.mock.scan";

function wantsRealScan(): boolean {
  if (!import.meta.env.DEV) {
    return false;
  }
  const choice = new URLSearchParams(window.location.search).get("scan");
  if (choice === "real") {
    sessionStorage.setItem(SCAN_CHOICE_KEY, "real");
  } else if (choice === "mock") {
    sessionStorage.removeItem(SCAN_CHOICE_KEY);
  }
  return sessionStorage.getItem(SCAN_CHOICE_KEY) === "real";
}

const RealScanPage = lazy(async () => {
  // Bewusst kein fester Importpfad: So hängt die Typprüfung der Oberfläche nicht an
  // src/features/scan. Der Entwicklungsserver liefert das Modul unter dieser Adresse.
  const path = "/src/features/scan/index.tsx";
  const module = (await import(/* @vite-ignore */ path)) as { ScanPage: ComponentType };
  return { default: module.ScanPage };
});

export function ScanPage() {
  if (wantsRealScan()) {
    return createElement(Suspense, { fallback: null }, createElement(RealScanPage));
  }
  return createElement(MockScanPage);
}
