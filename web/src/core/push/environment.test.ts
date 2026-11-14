/**
 * Push im Browser: Wann gilt Push als möglich, wann als "unsupported" oder "ios_install", woher
 * kommen Erlaubnis und PushManager, und wie erfährt der Kern von einer geänderten Erlaubnis? Mit
 * nachgebildetem `navigator`, `Notification` und `PushManager`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { browserPushEnvironment, watchNotificationPermission } from "./environment";

const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubBrowser(options: { userAgent?: string; serviceWorker?: boolean; pushManager?: boolean; notification?: boolean; registration?: unknown }) {
  const asked: string[] = [];
  vi.stubGlobal("navigator", {
    userAgent: options.userAgent ?? ANDROID,
    platform: "Linux armv8l",
    maxTouchPoints: 5,
    ...(options.serviceWorker === false
      ? {}
      : {
          serviceWorker: {
            getRegistration: () => Promise.resolve(options.registration),
            ready: new Promise(() => undefined),
          },
        }),
  });
  vi.stubGlobal("PushManager", options.pushManager === false ? undefined : function PushManager() {});
  vi.stubGlobal(
    "Notification",
    options.notification === false
      ? undefined
      : Object.assign(function Notification() {}, {
          permission: "default",
          requestPermission: () => {
            asked.push("gefragt");
            return Promise.resolve("granted");
          },
        }),
  );
  return { asked };
}

describe("Push im Browser", () => {
  it("geht mit sicherem Kontext, Service Worker, PushManager und Benachrichtigungen", async () => {
    const { asked } = stubBrowser({ registration: { pushManager: { marker: "pm" } } });
    const env = browserPushEnvironment({ secureContext: true, installed: () => false, serviceWorker: true });
    expect(env.support()).toBeNull();
    expect(env.permission()).toBe("default");
    expect(await env.requestPermission()).toBe("granted");
    expect(asked).toEqual(["gefragt"]);
    expect(await env.pushManager()).toEqual({ marker: "pm" });
  });

  it("geht nicht ohne HTTPS, ohne Service Worker, ohne PushManager oder ohne Benachrichtigungen", () => {
    stubBrowser({});
    expect(browserPushEnvironment({ secureContext: false, installed: () => false, serviceWorker: true }).support()).toBe("unsupported");
    for (const missing of [{ serviceWorker: false }, { pushManager: false }, { notification: false }]) {
      vi.unstubAllGlobals();
      stubBrowser(missing);
      expect(browserPushEnvironment({ secureContext: true, installed: () => false, serviceWorker: true }).support(), JSON.stringify(missing)).toBe("unsupported");
    }
  });

  it("verlangt auf dem iPhone die Installation; installiert geht es", () => {
    let installed = false;
    stubBrowser({ userAgent: IPHONE, pushManager: false, notification: false });
    const env = browserPushEnvironment({ secureContext: true, installed: () => installed, serviceWorker: true });
    expect(env.support()).toBe("ios_install");
    vi.unstubAllGlobals();
    stubBrowser({ userAgent: IPHONE });
    installed = true;
    expect(browserPushEnvironment({ secureContext: true, installed: () => installed, serviceWorker: true }).support()).toBeNull();
  });

  it("wartet ohne eigenen Service Worker nicht auf einen", async () => {
    stubBrowser({ registration: undefined });
    expect(await browserPushEnvironment({ secureContext: true, installed: () => false, serviceWorker: false }).pushManager()).toBeNull();
  });
});

describe("Änderungen der Erlaubnis", () => {
  it("meldet sie über die Permissions API, bis abgemeldet wird; ohne sie geschieht nichts", async () => {
    const status = new EventTarget();
    const asked: string[] = [];
    vi.stubGlobal("navigator", {
      permissions: {
        query: (descriptor: { name: string }) => {
          asked.push(descriptor.name);
          return Promise.resolve(status);
        },
      },
    });
    let changes = 0;
    const stop = watchNotificationPermission(() => {
      changes += 1;
    });
    // Die Antwort der Permissions API kommt später: erst danach hängt der Kern sich an.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asked).toEqual(["notifications"]);
    status.dispatchEvent(new Event("change"));
    expect(changes).toBe(1);
    stop();
    status.dispatchEvent(new Event("change"));
    expect(changes).toBe(1);

    vi.stubGlobal("navigator", {});
    expect(() => watchNotificationPermission(() => undefined)()).not.toThrow();
  });
});
