/**
 * Push im Service Worker mit nachgebildeter Registrierung, Fenstern und Ereignissen: anzeigen,
 * falsche Nutzlast übergehen, beim Tipp ein Fenster nach vorn holen und hinführen, sonst eines
 * öffnen, und nie ein fremdes Ziel.
 */
import { describe, expect, it } from "vitest";

import { PUSH_PATHS } from "@/contract";

import { pushTestPayload } from "../testing/fake-api";
import { handleNotificationClick, handlePush, parsePushPayload, targetUrl, type ClientsLike, type NotificationOptionsLike, type WindowClientLike } from "./worker";

const ORIGIN = "https://stowly.example";

function pushEvent(payload: unknown) {
  const work: Promise<unknown>[] = [];
  return {
    event: {
      data:
        payload === undefined
          ? null
          : {
              json: () => {
                if (typeof payload === "string") {
                  return JSON.parse(payload) as unknown;
                }
                return payload;
              },
            },
      waitUntil: (promise: Promise<unknown>) => work.push(promise),
    },
    work,
  };
}

function registration() {
  const shown: { title: string; options?: NotificationOptionsLike }[] = [];
  return {
    shown,
    showNotification: (title: string, options?: NotificationOptionsLike) => {
      shown.push({ title, options });
      return Promise.resolve();
    },
  };
}

const DAILY = {
  web_push: 8030,
  notification: {
    title: "Stowly",
    body: "Neu bald fällig: Joghurt (16.11.). Insgesamt 3 bald, 1 abgelaufen.",
    navigate: `${ORIGIN}/warnungen`,
    lang: "de-DE",
    dir: "ltr",
    tag: "stowly-daily",
    silent: false,
  },
};

describe("push", () => {
  it("zeigt eine Nachricht im Format Declarative Web Push an", async () => {
    const target = registration();
    const { event, work } = pushEvent(JSON.stringify(DAILY));
    handlePush(event, target);
    expect(work).toHaveLength(1);
    await Promise.all(work);
    expect(target.shown).toEqual([
      {
        title: "Stowly",
        options: { body: DAILY.notification.body, lang: "de-DE", dir: "ltr", tag: "stowly-daily", silent: false, data: { navigate: `${ORIGIN}/warnungen` } },
      },
    ]);
  });

  it("versteht die Testnachricht, wie sie der Server schickt", () => {
    const shown = parsePushPayload({ json: () => pushTestPayload(ORIGIN) });
    expect(shown).toMatchObject({ title: "Stowly", options: { tag: "stowly-test", data: { navigate: `${ORIGIN}${PUSH_PATHS.test}` } } });
  });

  it("übergeht alles, was nicht von Stowly ist", () => {
    const wrong: unknown[] = [
      undefined,
      "kein JSON",
      JSON.stringify({ web_push: 8031, notification: DAILY.notification }),
      JSON.stringify({ notification: DAILY.notification }),
      JSON.stringify({ web_push: 8030 }),
      JSON.stringify({ web_push: 8030, notification: { ...DAILY.notification, title: "" } }),
      JSON.stringify({ web_push: 8030, notification: { ...DAILY.notification, title: 42 } }),
      JSON.stringify([DAILY]),
      JSON.stringify(null),
    ];
    for (const payload of wrong) {
      const target = registration();
      const { event, work } = pushEvent(payload);
      handlePush(event, target);
      expect(work, String(payload)).toEqual([]);
      expect(target.shown).toEqual([]);
    }
  });

  it("lässt unbekannte oder falsche Felder weg und nimmt nur, was passt", () => {
    const shown = parsePushPayload({ json: () => ({ web_push: 8030, notification: { title: "Stowly", body: 3, dir: "oben", silent: "ja", app_badge: 4, navigate: 7 } }) });
    expect(shown).toEqual({ title: "Stowly", options: { data: { navigate: null } } });
  });
});

/** Ein Fenster der App, wie es `clients.matchAll` liefert. */
function windowClient(url: string, extra: Partial<WindowClientLike> & { failNavigate?: boolean } = {}) {
  const calls: string[] = [];
  const client: WindowClientLike & { calls: string[] } = {
    url,
    focused: extra.focused ?? false,
    visibilityState: extra.visibilityState ?? "hidden",
    calls,
    focus: () => {
      calls.push("focus");
      return Promise.resolve(client);
    },
    navigate: (to: string) => {
      calls.push(`navigate ${to}`);
      return extra.failNavigate ? Promise.reject(new TypeError("Dieser Client wird nicht gesteuert.")) : Promise.resolve(client);
    },
  };
  return client;
}

function clientsWith(windows: WindowClientLike[]) {
  const opened: string[] = [];
  const queries: unknown[] = [];
  const clients: ClientsLike = {
    matchAll: (options) => {
      queries.push(options);
      return Promise.resolve(windows);
    },
    openWindow: (url) => {
      opened.push(url);
      return Promise.resolve(null);
    },
  };
  return { clients, opened, queries };
}

async function click(data: unknown, clients: ClientsLike): Promise<{ closed: number }> {
  const state = { closed: 0 };
  const work: Promise<unknown>[] = [];
  handleNotificationClick({ notification: { data, close: () => (state.closed += 1) }, waitUntil: (promise) => work.push(promise) }, clients, ORIGIN);
  expect(work).toHaveLength(1);
  await Promise.all(work);
  return state;
}

describe("notificationclick", () => {
  it("schließt die Nachricht, holt ein offenes Fenster der App nach vorn und führt es hin", async () => {
    const hidden = windowClient(`${ORIGIN}/bestand`);
    const visible = windowClient(`${ORIGIN}/zonen`, { visibilityState: "visible" });
    const foreign = windowClient("https://example.org/", { focused: true });
    const { clients, opened, queries } = clientsWith([foreign, hidden, visible]);
    const { closed } = await click({ navigate: `${ORIGIN}/warnungen` }, clients);
    expect(closed).toBe(1);
    expect(queries).toEqual([{ type: "window", includeUncontrolled: true }]);
    expect(visible.calls).toEqual(["focus", `navigate ${ORIGIN}/warnungen`]);
    expect(hidden.calls).toEqual([]);
    expect(foreign.calls).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("holt ein Fenster, das schon am Ziel ist, nur nach vorn", async () => {
    const there = windowClient(`${ORIGIN}/warnungen`, { focused: true });
    const { clients, opened } = clientsWith([there]);
    await click({ navigate: `${ORIGIN}/warnungen` }, clients);
    expect(there.calls).toEqual(["focus"]);
    expect(opened).toEqual([]);
  });

  it("öffnet ein neues Fenster, wenn keines offen ist oder sich das offene nicht führen lässt", async () => {
    const none = clientsWith([]);
    await click({ navigate: `${ORIGIN}/einstellungen` }, none.clients);
    expect(none.opened).toEqual([`${ORIGIN}/einstellungen`]);

    const stubborn = windowClient(`${ORIGIN}/`, { failNavigate: true });
    const uncontrolled = clientsWith([stubborn]);
    await click({ navigate: `${ORIGIN}/warnungen` }, uncontrolled.clients);
    expect(uncontrolled.opened).toEqual([`${ORIGIN}/warnungen`]);
  });

  it("öffnet kein fremdes Ziel, sondern den Anfang der App", async () => {
    for (const navigate of ["https://example.org/warnungen", "javascript:alert(1)", "//example.org/x", 42, null, ""]) {
      const { clients, opened } = clientsWith([]);
      await click({ navigate }, clients);
      expect(opened, String(navigate)).toEqual([`${ORIGIN}/`]);
    }
    const { clients, opened } = clientsWith([]);
    await click(undefined, clients);
    expect(opened).toEqual([`${ORIGIN}/`]);
  });

  it("nimmt relative Ziele im eigenen Ursprung", () => {
    expect(targetUrl("/warnungen", ORIGIN)).toBe(`${ORIGIN}/warnungen`);
    expect(targetUrl(`${ORIGIN}/warnungen?x=1`, ORIGIN)).toBe(`${ORIGIN}/warnungen?x=1`);
    expect(targetUrl("https://stowly.example:8443/warnungen", ORIGIN)).toBe(`${ORIGIN}/`);
  });
});
