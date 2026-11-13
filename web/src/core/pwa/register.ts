/**
 * Meldet den Service Worker an. GRUNDGERÜST: Den Installations- und Update-Ablauf
 * (neue Version anbieten statt sofort übernehmen) baut Worker 3 in Runde 2.
 *
 * Bis dahin gilt die einfachste Regel, die beim Entwickeln keine veraltete App festhält:
 * Ein neuer Service Worker übernimmt sofort (siehe src/sw.ts), und die Seite lädt einmal neu.
 */

const SERVICE_WORKER_URL = "/sw.js";

export function registerServiceWorker(): void {
  // Nur in der gebauten App: Der Entwicklungsserver liefert kein sw.js.
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) {
    return;
  }

  let reloading = false;
  const hadController = navigator.serviceWorker.controller !== null;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // Beim allerersten Besuch gibt es noch keinen Vorgänger: nichts neu zu laden.
    if (!hadController || reloading) {
      return;
    }
    reloading = true;
    window.location.reload();
  });

  window.addEventListener("load", () => {
    navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: "/" }).catch((error: unknown) => {
      console.warn("Service Worker ließ sich nicht anmelden:", error);
    });
  });
}
