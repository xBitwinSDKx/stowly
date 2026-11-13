/**
 * Produktbilder (docs/sync-protokoll.md, 9.6 und 11).
 *
 * Bilder kommen ohne Anmeldung von `GET /api/images/{id}` und ändern sich nie: Die Kennung
 * ist der Hash des Inhalts. Die App legt die Bilder der Produkte im Bestand vorab in einen
 * eigenen Cache, damit sie im Keller ohne Netz erscheinen; der Service Worker (src/sw.ts)
 * beantwortet Bild-Abrufe aus demselben Cache.
 *
 * Den Cache gibt es nur in sicheren Kontexten. Über http://<LAN-IP> entfällt das Vorabladen.
 *
 * Ohne DOM: Diese Datei läuft auch im Service Worker.
 */
import { ENDPOINTS } from "@/contract/api.gen";

/** Name des Caches für Produktbilder; Seite und Service Worker benutzen denselben. */
export const IMAGE_CACHE = "stowly-images-v1";

/** Anfang aller Bild-Adressen. */
export const IMAGE_PATH_PREFIX = ENDPOINTS.get_image.path.replace("{image_id}", "");

/** Adresse eines Produktbilds; `image` ist `Product.image`. */
export function imageUrl(image: string): string {
  return ENDPOINTS.get_image.path.replace("{image_id}", encodeURIComponent(image));
}

function cacheStorage(): CacheStorage | null {
  const storage = (globalThis as { caches?: CacheStorage }).caches;
  return storage && typeof storage.open === "function" ? storage : null;
}

/** Löscht alle vorab geladenen Bilder (beim Abmelden). Wirft nicht. */
export async function clearImages(): Promise<void> {
  try {
    await cacheStorage()?.delete(IMAGE_CACHE);
  } catch {
    // nichts zu löschen
  }
}

/**
 * Lädt die genannten Bilder in den Cache, soweit sie dort fehlen, und entfernt alle, die
 * nicht mehr gebraucht werden (`keep`). Wirft nicht: Ein fehlendes Bild ist kein Fehler.
 */
export async function preloadImages(wanted: Iterable<string>, keep: Iterable<string>, fetchFn: (url: string) => Promise<Response>): Promise<void> {
  const storage = cacheStorage();
  if (!storage) {
    return;
  }
  try {
    const cache = await storage.open(IMAGE_CACHE);
    for (const image of new Set(wanted)) {
      const url = imageUrl(image);
      if (await cache.match(url)) {
        continue;
      }
      try {
        const response = await fetchFn(url);
        if (response.ok) {
          await cache.put(url, response);
        }
      } catch {
        // Kein Netz: beim nächsten Abgleich noch einmal.
        return;
      }
    }
    const keepUrls = new Set([...keep].map(imageUrl));
    for (const request of await cache.keys()) {
      const path = new URL(request.url).pathname;
      if (!keepUrls.has(path)) {
        await cache.delete(request);
      }
    }
  } catch {
    // Der Cache ist eine Annehmlichkeit; ohne ihn lädt das Bild eben aus dem Netz.
  }
}
