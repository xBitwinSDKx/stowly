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
} as const;

export type RouteKey = keyof typeof ROUTES;
