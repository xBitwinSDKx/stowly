import type { SetupStepId } from "./api.gen";

/**
 * Adressen der Ansichten. Hier festgelegt, weil Oberfläche und Scan-Ansicht sich
 * gegenseitig verlinken, ohne einander zu importieren.
 */
export const ROUTES = {
  /** Übersicht und Bestand (Startseite). */
  stock: "/",
  zones: "/zonen",
  warnings: "/warnungen",
  /** Lösch-Historie. */
  history: "/verlauf",
  printers: "/drucker",
  settings: "/einstellungen",
  /** Sync-Status mit abgelehnten Änderungen. */
  sync: "/sync",
  /** Scannen: Vollbild, außerhalb des Rahmens. */
  scan: "/scan",
  /** Einkaufsliste (Stufe 2). */
  shopping: "/einkaufsliste",
  /** Statistik: verbraucht und entsorgt (Stufe 2). */
  stats: "/statistik",
  /** Einrichtung: Vollbild, außerhalb des Rahmens; dahinter das Kürzel eines Schritts (`setupPath`). */
  setup: "/einrichtung",
} as const;

export type RouteKey = keyof typeof ROUTES;

/** Eine Seite des Assistenten: ein Schritt des Servers (`SetupStepId`) oder die Übersicht am Ende. */
export type SetupStepKey = SetupStepId | "done";

/** Kürzel der Seiten in der Adresse, etwa /einrichtung/drucker. */
export const SETUP_SLUGS: Readonly<Record<SetupStepKey, string>> = {
  https: "sicher",
  printer: "drucker",
  updates: "updates",
  notifications: "mitteilungen",
  done: "fertig",
};

/** Adresse der Einrichtung: mit Schritt dessen Seite, ohne der erste offene Schritt. */
export function setupPath(step?: SetupStepKey): string {
  return step === undefined ? ROUTES.setup : `${ROUTES.setup}/${SETUP_SLUGS[step]}`;
}

/** Die Seite zu einem Kürzel der Adresse; null, wenn es keines ist. */
export function setupStepOf(slug: string | undefined): SetupStepKey | null {
  const found = (Object.keys(SETUP_SLUGS) as SetupStepKey[]).find((key) => SETUP_SLUGS[key] === slug);
  return found ?? null;
}

/**
 * Nachricht des Service Workers an ein offenes Fenster der App: Wechsle zu `url`.
 * So führt ein Tipp auf eine Mitteilung in die richtige Ansicht, auch wo der Browser
 * `WindowClient.navigate` nicht kennt (Safari), und ohne die App neu zu laden
 * (docs/integrationen.md, 4.5).
 */
export const NAVIGATE_MESSAGE = "stowly:navigate";

export interface NavigateMessage {
  type: typeof NAVIGATE_MESSAGE;
  /** Absolute Adresse im eigenen Ursprung. */
  url: string;
}

/**
 * Das Ziel einer solchen Nachricht als Pfad mit Suche und Anker, wenn es zum eigenen Ursprung
 * gehört; sonst (andere Nachricht, fremder Ursprung, keine Adresse) null.
 */
export function navigateTarget(data: unknown, origin: string): string | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const { type, url } = data as { type?: unknown; url?: unknown };
  if (type !== NAVIGATE_MESSAGE || typeof url !== "string" || url === "") {
    return null;
  }
  try {
    const target = new URL(url, origin);
    return target.origin === origin ? `${target.pathname}${target.search}${target.hash}` : null;
  } catch {
    return null;
  }
}

