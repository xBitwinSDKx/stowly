/**
 * Service Worker von Stowly. GRUNDGERÜST: Worker 3 baut ihn in Runde 1 aus
 * (Bilder zwischenspeichern, Abgleich im Hintergrund) und in Runde 2 den Update-Ablauf.
 *
 * Was hier schon gilt:
 * - Alle Dateien der gebauten App liegen im Cache (die Liste setzt vite-plugin-pwa beim
 *   Bauen ein, auch .wasm). Die App startet damit ohne Netz.
 * - Jede Navigation liefert index.html aus dem Cache, außer /api und /print.
 * - Die Schnittstelle (/api, /print) wird nie zwischengespeichert.
 *
 * Geprüft wird diese Datei mit eigenen Typen: npm run typecheck:sw (kein DOM).
 */
import { clientsClaim } from "workbox-core";
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";

declare const self: ServiceWorkerGlobalScope;

// Bis der Update-Ablauf steht: Eine neue Version übernimmt sofort (siehe core/pwa/register.ts).
void self.skipWaiting();
clientsClaim();

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

registerRoute(
  new NavigationRoute(createHandlerBoundToURL("/index.html"), {
    denylist: [/^\/api\//, /^\/print\//],
  }),
);
