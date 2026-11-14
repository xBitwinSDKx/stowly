/**
 * Push im Browser: was `PushController` (device.ts) vom Browser braucht.
 *
 * - "unsupported": kein sicherer Kontext, kein Service Worker, kein PushManager oder keine
 *   Benachrichtigungen (auch iOS vor 16.4, installiert).
 * - "ios_install": iPhone oder iPad im Browser. Dort gibt es Push erst in der installierten App.
 *
 * Den PushManager liefert die Registrierung des Service Workers. Meldet die App selbst keinen an
 * (Entwicklungsserver), gibt es keinen: Dann wird auch auf keinen gewartet.
 */
import { isAppleMobile } from "../pwa/install";
import type { PermissionValue, PushEnvironment, PushManagerLike } from "./device";

export interface BrowserPushOptions {
  /** Läuft die App in einem sicheren Kontext (HTTPS)? */
  secureContext: boolean;
  /** Läuft die App installiert vom Home-Bildschirm? */
  installed(): boolean;
  /** Meldet die App einen Service Worker an (gebaute App)? Dann wartet der Kern auf ihn. */
  serviceWorker: boolean;
}

/** So lange wartet der Kern auf die Registrierung des Service Workers. */
const REGISTRATION_WAIT_MS = 10_000;

function waitAtMost<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

export function browserPushEnvironment(options: BrowserPushOptions): PushEnvironment {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const hasNotifications = () => typeof Notification === "function";
  return {
    support() {
      if (!options.secureContext) {
        return "unsupported";
      }
      if (isAppleMobile(nav) && !options.installed()) {
        return "ios_install";
      }
      if (!nav || !("serviceWorker" in nav) || typeof PushManager === "undefined" || !hasNotifications()) {
        return "unsupported";
      }
      return null;
    },
    permission() {
      return hasNotifications() ? (Notification.permission as PermissionValue) : "default";
    },
    requestPermission() {
      return hasNotifications() ? Notification.requestPermission() : Promise.resolve("default");
    },
    async pushManager() {
      const container = nav && "serviceWorker" in nav ? nav.serviceWorker : undefined;
      if (!container) {
        return null;
      }
      const registration = (await container.getRegistration().catch(() => undefined)) ?? (options.serviceWorker ? await waitAtMost(container.ready, REGISTRATION_WAIT_MS) : null);
      return (registration?.pushManager as PushManagerLike | undefined) ?? null;
    },
    origin: typeof location === "undefined" ? "" : location.origin,
  };
}

interface PermissionStatusLike {
  addEventListener?(type: "change", listener: () => void): void;
  removeEventListener?(type: "change", listener: () => void): void;
}

/**
 * Meldet, wenn sich die Erlaubnis für Benachrichtigungen ändert (Permissions API), und liefert die
 * Funktion zum Abmelden. Auf dem Desktop ändert man sie meist über das Symbol neben der Adresse;
 * die Seite bleibt dabei sichtbar, `visibilitychange` kommt also nicht. Ohne Permissions API: nichts.
 */
export function watchNotificationPermission(onChange: () => void): () => void {
  const permissions = (globalThis.navigator as { permissions?: { query(descriptor: { name: string }): Promise<PermissionStatusLike> } } | undefined)?.permissions;
  if (!permissions || typeof permissions.query !== "function") {
    return () => undefined;
  }
  let stopped = false;
  let watched: PermissionStatusLike | null = null;
  const listener = () => {
    if (!stopped) {
      onChange();
    }
  };
  permissions.query({ name: "notifications" }).then(
    (status) => {
      if (!stopped && typeof status.addEventListener === "function") {
        status.addEventListener("change", listener);
        watched = status;
      }
    },
    () => undefined,
  );
  return () => {
    stopped = true;
    watched?.removeEventListener?.("change", listener);
    watched = null;
  };
}

/** Wo es kein Fenster gibt (Service Worker, Tests unter Node): kein Push. */
export const NO_PUSH: PushEnvironment = {
  support: () => "unsupported",
  permission: () => "default",
  requestPermission: () => Promise.resolve("default"),
  pushManager: () => Promise.resolve(null),
  origin: "",
};
