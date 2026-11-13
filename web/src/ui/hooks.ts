/**
 * Kleine Hooks der Oberfläche: Medienabfragen, „heute", Ansichts-Vorlieben, Fokus.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { todayLocal } from "@/contract";

/** Ab dieser Breite gibt es die Seitenleiste; darunter den Rahmen fürs Handy. */
export const DESKTOP_QUERY = "(min-width: 64rem)";
/** Ab dieser Breite passen Tabellen; darunter werden Zeilen zu Karten. */
export const WIDE_QUERY = "(min-width: 48rem)";
/** Ab dieser Breite haben Tabellen reichlich Platz; darunter rücken sie zusammen. */
export const ROOMY_QUERY = "(min-width: 80rem)";

/** Trifft eine Medienabfrage gerade zu? Rendert neu, sobald sich das ändert. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (typeof matchMedia !== "function") {
        return () => undefined;
      }
      const list = matchMedia(query);
      list.addEventListener("change", listener);
      return () => list.removeEventListener("change", listener);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => typeof matchMedia === "function" && matchMedia(query).matches,
    () => false,
  );
}

/**
 * Heute als "YYYY-MM-DD" in der Zeitzone des Geräts. Bleibt die App über Mitternacht
 * offen oder kommt sie aus dem Hintergrund zurück, stimmt der Wert trotzdem.
 */
export function useToday(): string {
  const [today, setToday] = useState(() => todayLocal());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => setToday(todayLocal());
    const schedule = () => {
      const now = new Date();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
      timer = setTimeout(() => {
        check();
        schedule();
      }, midnight.getTime() - now.getTime());
    };
    schedule();
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, []);

  return today;
}

/**
 * Jetzt in Millisekunden, in einem festen Takt aktualisiert. Für Angaben wie
 * „vor 5 Minuten", die sonst stehen blieben.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const UI_PREF_PREFIX = "stowly.ui.";

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(UI_PREF_PREFIX + key);
  } catch {
    return null; // Speicher gesperrt (privater Modus)
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(UI_PREF_PREFIX + key, value);
  } catch {
    // Dann gilt die Wahl nur, bis die Ansicht verlassen wird.
  }
}

/**
 * Eine reine Ansichts-Vorliebe dieses Geräts (z. B. „Details immer zeigen").
 * Liegt in localStorage unter "stowly.ui.<key>" und wird nie synchronisiert.
 */
export function useUiFlag(key: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    const stored = readPref(key);
    return stored === null ? fallback : stored === "1";
  });
  const update = useCallback(
    (next: boolean) => {
      setValue(next);
      writePref(key, next ? "1" : "0");
    },
    [key],
  );
  return [value, update];
}

/**
 * Gibt den Fokus an das Element zurück, das ihn hatte, als die Komponente entstand.
 * Für Dialoge, die nur gerendert werden, solange sie offen sind: Der Browser stellt den
 * Fokus nur wieder her, wenn ein <dialog> geschlossen wird, nicht wenn er verschwindet.
 */
export function useReturnFocus(): void {
  // Beim ersten Rendern merken: Effekte laufen erst, wenn der Dialog den Fokus schon hat.
  const [opener] = useState(() => (typeof document === "undefined" ? null : document.activeElement));
  useEffect(() => {
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [opener]);
}

/**
 * Setzt den Fokus beim Öffnen eines Dialogs in dieses Feld: `<TextField ref={focusOnOpen} />`.
 *
 * Ein <dialog> entscheidet beim Öffnen selbst, wohin der Fokus geht, und achtet dabei auf
 * das Attribut "autofocus"; Reacts `autoFocus` kommt dafür zu früh. Am Handy bleibt das
 * Feld ohne Fokus, sonst spränge mit jedem Dialog sofort die Tastatur auf.
 */
export function focusOnOpen(element: HTMLElement | null): void {
  if (element && !(typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches)) {
    element.setAttribute("autofocus", "");
  }
}
