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
} as const;

export type RouteKey = keyof typeof ROUTES;

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

