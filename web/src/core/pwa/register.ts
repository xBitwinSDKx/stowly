/**
 * Meldet den Service Worker an und beobachtet, ob eine neue Version wartet
 * (der Ablauf steht in src/core/pwa/updates.ts).
 */
import { AppUpdates } from "./updates";

const SERVICE_WORKER_URL = "/sw.js";

/**
 * @param onUpdateReady wird gerufen, sobald eine neue Version auf diesen Tab wartet
 * @param reload lädt die Seite neu
 * @returns die Steuerung des Update-Ablaufs; null, wo es keinen Service Worker gibt
 *          (Entwicklungsserver, kein sicherer Kontext)
 */
export function registerServiceWorker(onUpdateReady: (ready: boolean) => void, reload: () => void): AppUpdates | null {
  // Nur in der gebauten App: Der Entwicklungsserver liefert kein sw.js.
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) {
    return null;
  }

  const updates = new AppUpdates(
    {
      container: navigator.serviceWorker,
      reload,
      isHidden: () => document.visibilityState === "hidden",
    },
    onUpdateReady,
  );

  const register = () => {
    navigator.serviceWorker
      .register(SERVICE_WORKER_URL, { scope: "/" })
      .then((registration) => updates.watch(registration))
      .catch((error: unknown) => {
        console.warn("Service Worker ließ sich nicht anmelden:", error);
      });
  };
  if (document.readyState === "complete") {
    register();
  } else {
    window.addEventListener("load", register, { once: true });
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      updates.hidden();
    } else {
      updates.visible();
    }
  });
  return updates;
}
