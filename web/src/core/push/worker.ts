/**
 * Push im Service Worker (docs/integrationen.md, 4.5): `push` zeigt die Nachricht an,
 * `notificationclick` führt in die App.
 *
 * - Die Nutzlast ist JSON im Format „Declarative Web Push". Angezeigt wird nur, was
 *   `web_push === 8030` und einen `notification.title` hat, mit `body`, `lang`, `dir`, `tag`,
 *   `silent` und dem Ziel in `data.navigate`. Alles andere zeigt der Service Worker nicht an.
 * - Ein Tipp schließt die Nachricht, schickt einem offenen Fenster der App das Ziel
 *   (`NAVIGATE_MESSAGE`; sie wechselt ohne Neuladen) und holt es nach vorn; ohne Fenster öffnet
 *   er ein neues. Das Ziel steht in `notification.navigate` (wo der Browser die Mitteilung selbst
 *   angezeigt hat), sonst in `data.navigate`, sonst gilt es nach der Kennung. Ziele außerhalb des
 *   eigenen Ursprungs öffnet er nicht: Dann führt der Tipp nur zum Anfang der App.
 * - iOS 27 meldet das Tippen auf eine Push-Mitteilung nicht: Dort öffnet der Tipp die App am
 *   Anfang (am iPhone gesehen, docs/integrationen.md 4.5).
 *
 * Browser und Service Worker kommen über schmale Schnittstellen herein: So läuft diese Datei in
 * sw.ts (Typen eines Workers) und in den Tests des Kerns (DOM), und sie lässt sich ohne Browser
 * prüfen (worker.test.ts).
 */

import { PUSH_PATHS } from "@/contract/api.gen";
import { NAVIGATE_MESSAGE, type NavigateMessage } from "@/contract/routes";

/** Die Kennung des Formats „Declarative Web Push" in der Nutzlast. */
export const DECLARATIVE_WEB_PUSH = 8030;

export interface NotificationOptionsLike {
  body?: string;
  lang?: string;
  dir?: "auto" | "ltr" | "rtl";
  tag?: string;
  silent?: boolean;
  data?: { navigate: string | null };
}

export interface PushEventLike {
  readonly data: { json(): unknown } | null;
  waitUntil(work: Promise<unknown>): void;
}

export interface NotifyingRegistration {
  showNotification(title: string, options?: NotificationOptionsLike): Promise<void>;
}

export interface WindowClientLike {
  readonly url: string;
  readonly focused?: boolean;
  readonly visibilityState?: string;
  focus(): Promise<unknown>;
  postMessage(message: NavigateMessage): void;
}

export interface ClientsLike {
  matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<readonly WindowClientLike[]>;
  openWindow(url: string): Promise<unknown>;
}

export interface NotificationClickEventLike {
  readonly notification: NotificationLike;
  waitUntil(work: Promise<unknown>): void;
}

/** Was der Tipp von der Mitteilung braucht. `navigate` setzt der Browser bei Declarative Web Push. */
export interface NotificationLike {
  readonly data: unknown;
  readonly navigate?: unknown;
  readonly tag?: string;
  readonly title?: string;
  close(): void;
}

/**
 * Ziel nach der Kennung (`tag`) der Mitteilung (docs/integrationen.md 4.6, 4.9, 10.2): der letzte
 * Rückfall, wenn der Browser beim Tipp weder `navigate` noch `data` mitgibt.
 */
const TAG_TARGETS: Readonly<Record<string, string>> = {
  "stowly-daily": PUSH_PATHS.daily,
  "stowly-test": PUSH_PATHS.test,
  "stowly-update": PUSH_PATHS.update,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Die Nachricht aus der Nutzlast; null, wenn sie nicht im Format von Stowly ist. */
export function parsePushPayload(data: { json(): unknown } | null | undefined): { title: string; options: NotificationOptionsLike } | null {
  let payload: unknown;
  try {
    payload = data?.json();
  } catch {
    return null;
  }
  if (!isRecord(payload) || payload.web_push !== DECLARATIVE_WEB_PUSH || !isRecord(payload.notification)) {
    return null;
  }
  const notification = payload.notification;
  if (typeof notification.title !== "string" || notification.title === "") {
    return null;
  }
  const options: NotificationOptionsLike = { data: { navigate: typeof notification.navigate === "string" ? notification.navigate : null } };
  if (typeof notification.body === "string") {
    options.body = notification.body;
  }
  if (typeof notification.lang === "string") {
    options.lang = notification.lang;
  }
  if (notification.dir === "auto" || notification.dir === "ltr" || notification.dir === "rtl") {
    options.dir = notification.dir;
  }
  if (typeof notification.tag === "string") {
    options.tag = notification.tag;
  }
  if (typeof notification.silent === "boolean") {
    options.silent = notification.silent;
  }
  return { title: notification.title, options };
}

/** `push`: zeigt die Nachricht an, wenn sie von Stowly ist. */
export function handlePush(event: PushEventLike, registration: NotifyingRegistration): void {
  const shown = parsePushPayload(event.data);
  if (shown) {
    event.waitUntil(registration.showNotification(shown.title, shown.options));
  }
}

/** Wohin ein Tipp führt: das Ziel der Nachricht, wenn es zum eigenen Ursprung gehört, sonst der Anfang der App. */
export function targetUrl(navigate: unknown, origin: string): string {
  if (typeof navigate === "string" && navigate !== "") {
    try {
      const url = new URL(navigate, origin);
      if (url.origin === origin) {
        return url.href;
      }
    } catch {
      // kein gültiges Ziel
    }
  }
  return new URL("/", origin).href;
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Das Ziel einer Mitteilung: `navigate`, wenn der Browser sie als Declarative Web Push selbst
 * angezeigt hat (dann gibt es kein `data`), sonst `data.navigate` aus `parsePushPayload`.
 */
export function notificationTarget(notification: NotificationLike): unknown {
  if (typeof notification.navigate === "string" && notification.navigate !== "") {
    return notification.navigate;
  }
  const fromData = isRecord(notification.data) ? notification.data.navigate : undefined;
  if (typeof fromData === "string" && fromData !== "") {
    return fromData;
  }
  return notification.tag ? TAG_TARGETS[notification.tag] : undefined;
}

/**
 * Schickt einem offenen Fenster der App das Ziel und holt es nach vorn; ohne Fenster ein neues.
 * Bewusst nicht `WindowClient.navigate`: Safari kennt es nicht, und es lädt die App neu.
 */
async function openApp(clients: ClientsLike, url: string, origin: string): Promise<void> {
  const windows = (await clients.matchAll({ type: "window", includeUncontrolled: true })).filter((client) => sameOrigin(client.url, origin));
  const client = windows.find((candidate) => candidate.focused) ?? windows.find((candidate) => candidate.visibilityState === "visible") ?? windows[0];
  if (client) {
    try {
      if (client.url !== url) {
        client.postMessage({ type: NAVIGATE_MESSAGE, url });
      }
      // Nach vorn holen, ohne darauf zu warten: Ein Fenster, das sich nicht holen lässt, ist trotzdem geführt.
      void client.focus().then(
        () => undefined,
        () => undefined,
      );
      return;
    } catch {
      // Das Fenster nimmt keine Nachricht an: ein neues.
    }
  }
  await clients.openWindow(url);
}

/** `notificationclick`: schließt die Nachricht und führt in die App. */
export function handleNotificationClick(event: NotificationClickEventLike, clients: ClientsLike, origin: string): void {
  event.notification.close();
  const url = targetUrl(notificationTarget(event.notification), origin);
  event.waitUntil(openApp(clients, url, origin));
}
