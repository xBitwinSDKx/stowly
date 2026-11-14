/**
 * Push im Service Worker (docs/integrationen.md, 4.5): `push` zeigt die Nachricht an,
 * `notificationclick` führt in die App.
 *
 * - Die Nutzlast ist JSON im Format „Declarative Web Push". Angezeigt wird nur, was
 *   `web_push === 8030` und einen `notification.title` hat, mit `body`, `lang`, `dir`, `tag`,
 *   `silent` und dem Ziel in `data.navigate`. Alles andere zeigt der Service Worker nicht an.
 *   Safari mit Declarative Web Push schickt das Ereignis auch an einen vorhandenen Service
 *   Worker; zeigt der dieselbe Nachricht an, ist das kein Doppel.
 * - Ein Tipp schließt die Nachricht, holt ein offenes Fenster der App nach vorn und führt es zum
 *   Ziel, sonst öffnet er ein neues. Ziele außerhalb des eigenen Ursprungs öffnet der Service
 *   Worker nicht: Dann führt der Tipp nur zum Anfang der App.
 *
 * Browser und Service Worker kommen über schmale Schnittstellen herein: So läuft diese Datei in
 * sw.ts (Typen eines Workers) und in den Tests des Kerns (DOM), und sie lässt sich ohne Browser
 * prüfen (worker.test.ts).
 */

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
  navigate?(url: string): Promise<unknown>;
}

export interface ClientsLike {
  matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<readonly WindowClientLike[]>;
  openWindow(url: string): Promise<unknown>;
}

export interface NotificationClickEventLike {
  readonly notification: { readonly data: unknown; close(): void };
  waitUntil(work: Promise<unknown>): void;
}

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

/** Holt ein Fenster der App nach vorn und führt es zum Ziel; ohne Fenster ein neues. */
async function openApp(clients: ClientsLike, url: string, origin: string): Promise<void> {
  const windows = (await clients.matchAll({ type: "window", includeUncontrolled: true })).filter((client) => sameOrigin(client.url, origin));
  const client = windows.find((candidate) => candidate.focused) ?? windows.find((candidate) => candidate.visibilityState === "visible") ?? windows[0];
  if (client) {
    try {
      await client.focus();
      if (client.url !== url && client.navigate) {
        await client.navigate(url);
      }
      return;
    } catch {
      // Ein Fenster, das dieser Service Worker nicht steuert, lässt sich nicht führen: ein neues.
    }
  }
  await clients.openWindow(url);
}

/** `notificationclick`: schließt die Nachricht und führt in die App. */
export function handleNotificationClick(event: NotificationClickEventLike, clients: ClientsLike, origin: string): void {
  event.notification.close();
  const data = event.notification.data;
  const url = targetUrl(isRecord(data) ? data.navigate : undefined, origin);
  event.waitUntil(openApp(clients, url, origin));
}
