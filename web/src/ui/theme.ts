/**
 * Thema (Dunkel/Hell) und Akzentfarbe dieses Geräts.
 *
 * Beides steht in localStorage und nicht im Offline-Kern, weil es schon vor dem Start
 * der App gebraucht wird: public/theme-init.js setzt die Attribute am <html>-Element,
 * bevor irgendetwas gezeichnet ist. Diese Datei und theme-init.js müssen zusammenpassen
 * (gleiche Schlüssel, Werte und Vorgaben); theme.test.ts prüft das.
 *
 * Die Farben selbst stehen in tokens.css.
 */
import { useSyncExternalStore } from "react";

export const THEMES = ["dark", "light", "system"] as const;
/** "system" folgt der Einstellung des Betriebssystems. */
export type ThemeChoice = (typeof THEMES)[number];
export type ResolvedTheme = "dark" | "light";

export const ACCENTS = [
  { key: "mint", label: "Mint" },
  { key: "blue", label: "Blau" },
  { key: "violet", label: "Violett" },
  { key: "rose", label: "Rosé" },
  { key: "lime", label: "Limette" },
] as const;
export type AccentKey = (typeof ACCENTS)[number]["key"];

export const DEFAULT_THEME: ThemeChoice = "dark";
export const DEFAULT_ACCENT: AccentKey = "mint";
export const THEME_STORAGE_KEY = "stowly.theme";
export const ACCENT_STORAGE_KEY = "stowly.accent";

/** Farbe der Browser-Leiste je Thema; entspricht --color-bg in tokens.css. */
export const THEME_COLORS: Record<ResolvedTheme, string> = { dark: "#0b1214", light: "#f3f6f6" };

export interface ThemeState {
  theme: ThemeChoice;
  accent: AccentKey;
  /** Das tatsächlich gezeigte Thema ("system" aufgelöst). */
  resolved: ResolvedTheme;
}

function isTheme(value: unknown): value is ThemeChoice {
  return (THEMES as readonly unknown[]).includes(value);
}

function isAccent(value: unknown): value is AccentKey {
  return ACCENTS.some((accent) => accent.key === value);
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // Speicher gesperrt (privater Modus)
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Dann gilt die Wahl nur bis zum Neuladen.
  }
}

function systemPrefersLight(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches;
}

export function resolveTheme(theme: ThemeChoice): ResolvedTheme {
  if (theme === "system") {
    return systemPrefersLight() ? "light" : "dark";
  }
  return theme;
}

function load(): ThemeState {
  const storedTheme = read(THEME_STORAGE_KEY);
  const storedAccent = read(ACCENT_STORAGE_KEY);
  const theme = isTheme(storedTheme) ? storedTheme : DEFAULT_THEME;
  const accent = isAccent(storedAccent) ? storedAccent : DEFAULT_ACCENT;
  return { theme, accent, resolved: resolveTheme(theme) };
}

/** Setzt die Attribute am <html>-Element und die Farbe der Browser-Leiste. */
export function applyTheme(state: Pick<ThemeState, "accent" | "resolved">): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", state.resolved);
  root.setAttribute("data-accent", state.accent);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[state.resolved]);
}

let current: ThemeState | null = null;
const listeners = new Set<() => void>();
let watchingSystem = false;

function publish(next: ThemeState): void {
  current = next;
  applyTheme(next);
  for (const listener of listeners) {
    listener();
  }
}

function watchSystem(): void {
  if (watchingSystem || typeof matchMedia !== "function") {
    return;
  }
  watchingSystem = true;
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (current?.theme === "system") {
      publish({ ...current, resolved: resolveTheme("system") });
    }
  });
}

/** Aktueller Stand; liest beim ersten Aufruf aus dem Speicher. */
export function getThemeState(): ThemeState {
  if (current === null) {
    current = load();
    watchSystem();
  }
  return current;
}

export function setTheme(theme: ThemeChoice): void {
  write(THEME_STORAGE_KEY, theme);
  publish({ ...getThemeState(), theme, resolved: resolveTheme(theme) });
}

export function setAccent(accent: AccentKey): void {
  write(ACCENT_STORAGE_KEY, accent);
  publish({ ...getThemeState(), accent });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Thema und Akzentfarbe in React:
 *
 *   const { theme, accent, resolved } = useTheme();
 *   setTheme("light"); setAccent("blue");
 */
export function useTheme(): ThemeState {
  return useSyncExternalStore(subscribe, getThemeState, getThemeState);
}

/** Nur für Tests: vergisst den gelesenen Stand. */
export function resetThemeForTests(): void {
  current = null;
}
