/**
 * Vorbereitung aller Tests, die in jsdom laufen (Projekte "ui" und "core").
 *
 * - Zusätzliche Prüfungen wie `toBeInTheDocument()` (@testing-library/jest-dom)
 * - Aufräumen des DOM nach jedem Test
 * - Ersatz für Browser-Funktionen, die jsdom nicht hat
 */
import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});

// jsdom kennt keine Medienabfragen: immer "trifft nicht zu" (also dunkles Thema, kein Touch).
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  });
}

// jsdom zeigt <dialog> nicht modal an. Für Tests genügt es, das Attribut "open" zu setzen.
if (typeof HTMLDialogElement !== "undefined") {
  const prototype = HTMLDialogElement.prototype;
  if (typeof prototype.showModal !== "function") {
    prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
  }
  if (typeof prototype.close !== "function") {
    prototype.close = function close(this: HTMLDialogElement) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
  }
}
