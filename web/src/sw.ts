/**
 * Service Worker von Stowly.
 *
 * - Alle Dateien der gebauten App liegen im Cache (die Liste setzt vite-plugin-pwa beim
 *   Bauen ein). Dazu gehört die .wasm-Datei der Barcode-Erkennung: Ohne sie könnte ein
 *   iPhone im Keller nicht scannen. Die App startet damit ohne Netz.
 * - Jede Navigation liefert index.html aus dem Cache, außer /api und /print.
 * - Produktbilder (/api/images/…) kommen aus dem Cache, wenn sie dort liegen: Ihre Kennung
 *   ist der Hash des Inhalts, sie ändern sich nie. Der Offline-Kern lädt die Bilder der
 *   Produkte im Bestand vorab in denselben Cache (src/core/images.ts).
 * - Alles andere unter /api und /print wird nie zwischengespeichert: Dafür gibt es hier
 *   keine Route, der Browser fragt immer den Server.
 * - Abgleich im Hintergrund (Background Sync, Kennung `stowly-sync`): Auf Android weckt der
 *   Browser diesen Service Worker, sobald wieder Netz da ist, und er sendet die wartenden
 *   Änderungen, auch wenn die App geschlossen ist. Safari kann das nicht; dort gleicht die
 *   App über ihre übrigen Anlässe ab.
 *
 * Den Update-Ablauf (neue Version anbieten statt sofort übernehmen) baut Runde 2.
 *
 * Geprüft wird diese Datei mit eigenen Typen: npm run typecheck:sw (kein DOM). Was sie
 * importiert, muss deshalb ohne window und document auskommen.
 */
import { CacheableResponsePlugin } from "workbox-cacheable-response";
import { clientsClaim } from "workbox-core";
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst } from "workbox-strategies";

import { BACKGROUND_SYNC_TAG, runBackgroundSync } from "@/core/background";
import { IMAGE_CACHE, IMAGE_PATH_PREFIX } from "@/core/images";

declare const self: ServiceWorkerGlobalScope;

/** Background Sync steht (noch) nicht in den Typen von TypeScript. */
interface SyncEvent extends ExtendableEvent {
  readonly tag: string;
  readonly lastChance: boolean;
}

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

// Produktbilder: unveränderlich, also zuerst der Cache. Nur gelungene Antworten werden behalten.
registerRoute(
  ({ url, request }) => request.method === "GET" && url.origin === self.location.origin && url.pathname.startsWith(IMAGE_PATH_PREFIX),
  new CacheFirst({
    cacheName: IMAGE_CACHE,
    plugins: [new CacheableResponsePlugin({ statuses: [200] })],
  }),
);

// Abgleich im Hintergrund. Scheitert er am fehlenden Netz, wirft `runBackgroundSync`, und
// der Browser versucht es später von selbst noch einmal.
self.addEventListener("sync", (event) => {
  const sync = event as SyncEvent;
  if (sync.tag === BACKGROUND_SYNC_TAG) {
    sync.waitUntil(runBackgroundSync());
  }
});
