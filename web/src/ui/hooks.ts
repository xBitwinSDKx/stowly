/**
 * Kleine Hooks der Oberfläche: Medienabfragen, „heute", Ansichts-Vorlieben.
 */
import { startTransition, useCallback, useEffect, useState, useSyncExternalStore } from "react";

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
 * Nach einem Absenden mit Fehlern: Fokus in das erste Feld, das einen Fehler meldet
 * (`aria-invalid`), damit Tastatur und Screenreader gleich dort weitermachen. Wartet, bis die
 * Fehler gezeichnet sind.
 */
export function focusFirstInvalid(formId: string): void {
  setTimeout(() => {
    const form = document.getElementById(formId);
    form?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, 0);
}

/** So viele Einträge einer langen Liste stehen sofort da; der Rest folgt in Schritten dieser Größe. */
export const LIST_FIRST = 40;
export const LIST_STEP = 80;

/**
 * Zeichnet eine lange Liste in Abschnitten: Die ersten Einträge stehen sofort da, der Rest
 * folgt im Hintergrund, ohne die Bedienung aufzuhalten (jeder Schritt ist für React
 * unterbrechbar). Bei einem Bestand mit Hunderten Produkten bleibt so der erste Blick und
 * jeder Wechsel der Darstellung flüssig.
 *
 * @param total    Länge der Liste
 * @param resetKey ändert er sich, beginnt die Liste wieder mit dem ersten Abschnitt
 *                 (z. B. wenn alle Zeilen ihr Aussehen wechseln)
 * @returns wie viele Einträge jetzt zu zeichnen sind
 */
export function useProgressiveCount(total: number, resetKey: string): number {
  const [state, setState] = useState({ key: resetKey, count: LIST_FIRST });
  let count = state.count;
  if (state.key !== resetKey) {
    // Abgeleiteter Zustand: sofort mit dem ersten Abschnitt weiterzeichnen, nicht erst nach einem Effekt.
    count = LIST_FIRST;
    setState({ key: resetKey, count });
  }

  useEffect(() => {
    if (count >= total) {
      return;
    }
    const timer = setTimeout(() => {
      startTransition(() => setState((current) => (current.key === resetKey ? { key: resetKey, count: Math.min(total, current.count + LIST_STEP) } : current)));
    }, 30);
    return () => clearTimeout(timer);
  }, [count, total, resetKey]);

  return Math.min(count, total);
}
