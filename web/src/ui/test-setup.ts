// Gemeinsame Vorbereitung für die Tests der Oberfläche (Worker 2).
// Läuft nach src/test/setup.dom.ts.
import { afterEach, vi } from "vitest";

import { setTestViewport } from "./testing";

// jsdom kennt keine Medienabfragen. Die Oberfläche entscheidet aber mit ihnen, ob sie den
// Rahmen für Desktop oder Handy und Tabellen oder Karten zeichnet. Die Tests bekommen
// deshalb ein Fenster mit einstellbarer Breite: Vorgabe Desktop, `setTestViewport(375)` fürs Handy.
setTestViewport(1280);

// jsdom druckt nicht und kennt keine Objekt-Adressen für Dateien.
window.print = vi.fn();
if (typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = () => "blob:stowly-test";
  URL.revokeObjectURL = () => undefined;
}
window.scrollTo = () => undefined;

afterEach(() => {
  setTestViewport(1280);
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  document.documentElement.style.removeProperty("--toast-offset");
});
