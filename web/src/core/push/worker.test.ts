/**
 * Push im Service Worker mit nachgebildeter Registrierung, Fenstern und Ereignissen: anzeigen,
 * falsche Nutzlast übergehen, beim Tipp ein Fenster nach vorn holen und hinführen, sonst eines
 * öffnen, und nie ein fremdes Ziel.
 */
import { describe, expect, it } from "vitest";

import { NAVIGATE_MESSAGE, PUSH_PATHS } from "@/contract";

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
    title: "MHD-Hinweis",
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
        title: "MHD-Hinweis",
        options: { body: DAILY.notification.body, lang: "de-DE", dir: "ltr", tag: "stowly-daily", silent: false, data: { navigate: `${ORIGIN}/warnungen` } },
      },
    ]);
  });

  it("versteht die Testnachricht, wie sie der Server schickt", () => {
    const shown = parsePushPayload({ json: () => pushTestPayload(ORIGIN) });
    expect(shown).toMatchObject({ title: "Testnachricht", options: { tag: "stowly-test", data: { navigate: `${ORIGIN}${PUSH_PATHS.test}` } } });
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
function windowClient(url: string, extra: Partial<WindowClientLike> & { failMessage?: boolean } = {}) {
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
    postMessage: (message) => {
      if (extra.failMessage) {
        throw new TypeError("Dieses Fenster nimmt keine Nachricht an.");
      }
      calls.push(`${message.type} ${message.url}`);
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

async function click(data: unknown, clients: ClientsLike, navigate?: unknown): Promise<{ closed: number }> {
  const state = { closed: 0 };
  const work: Promise<unknown>[] = [];
  handleNotificationClick({ notification: { data, navigate, close: () => (state.closed += 1) }, waitUntil: (promise) => work.push(promise) }, clients, ORIGIN);
  expect(work).toHaveLength(1);
  await Promise.all(work);
  return state;
}

describe("notificationclick", () => {
  it("schließt die Nachricht, holt ein offenes Fenster der App nach vorn und schickt ihm das Ziel", async () => {
    const hidden = windowClient(`${ORIGIN}/bestand`);
    const visible = windowClient(`${ORIGIN}/zonen`, { visibilityState: "visible" });
    const foreign = windowClient("https://example.org/", { focused: true });
    const { clients, opened, queries } = clientsWith([foreign, hidden, visible]);
    const { closed } = await click({ navigate: `${ORIGIN}/warnungen` }, clients);
    expect(closed).toBe(1);
    expect(queries).toEqual([{ type: "window", includeUncontrolled: true }]);
    expect(visible.calls).toEqual([`${NAVIGATE_MESSAGE} ${ORIGIN}/warnungen`, "focus"]);
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

  it("öffnet ein neues Fenster, wenn keines offen ist oder das offene keine Nachricht annimmt", async () => {
    const none = clientsWith([]);
    await click({ navigate: `${ORIGIN}/einstellungen` }, none.clients);
    expect(none.opened).toEqual([`${ORIGIN}/einstellungen`]);

    const stubborn = windowClient(`${ORIGIN}/`, { failMessage: true });
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

  it("nimmt das Ziel einer Mitteilung, die der Browser als Declarative Web Push selbst angezeigt hat", async () => {
    // iOS ab 18.4 zeigt die Nachricht selbst an: Das Ziel steht dann in notification.navigate, data fehlt.
    const open = windowClient(`${ORIGIN}/`, { focused: true });
    const running = clientsWith([open]);
    await click(null, running.clients, `${ORIGIN}/warnungen`);
    expect(open.calls).toEqual([`${NAVIGATE_MESSAGE} ${ORIGIN}/warnungen`, "focus"]);

    const closed = clientsWith([]);
    await click(undefined, closed.clients, `${ORIGIN}/warnungen`);
    expect(closed.opened).toEqual([`${ORIGIN}/warnungen`]);

    // Ein fremdes Ziel dort führt wie sonst nur zum Anfang der App.
    const foreign = clientsWith([]);
    await click({ navigate: `${ORIGIN}/einstellungen` }, foreign.clients, "https://example.org/");
    expect(foreign.opened).toEqual([`${ORIGIN}/`]);
  });

  it("holt ein Fenster nach vorn, auch wenn es sich nicht fokussieren lässt", async () => {
    const stubborn = windowClient(`${ORIGIN}/`);
    stubborn.focus = () => Promise.reject(new Error("nicht erlaubt"));
    const { clients, opened } = clientsWith([stubborn]);
    await click({ navigate: `${ORIGIN}/warnungen` }, clients);
    expect(stubborn.calls).toEqual([`${NAVIGATE_MESSAGE} ${ORIGIN}/warnungen`]);
    expect(opened).toEqual([]);
  });

  it("führt ohne Ziel in der Mitteilung nach ihrer Kennung, auch bei einer neuen Version", async () => {
    // Die Nachricht zu einer neuen Version (docs/integrationen.md 10.2), wie sie ankommt.
    const update = {
      web_push: 8030,
      notification: { title: "Neue Version", body: "Stowly 0.2.0 ist verfügbar.", navigate: `${ORIGIN}${PUSH_PATHS.update}`, lang: "de-DE", dir: "ltr", tag: "stowly-update", silent: false },
    };
    expect(parsePushPayload({ json: () => update })).toMatchObject({ title: "Neue Version", options: { tag: "stowly-update", data: { navigate: `${ORIGIN}/einstellungen` } } });

    // Gibt der Browser beim Tipp weder `navigate` noch `data` mit, gilt das Ziel nach der Kennung.
    const targets: [string, string][] = [
      ["stowly-update", PUSH_PATHS.update],
      ["stowly-daily", PUSH_PATHS.daily],
      ["stowly-test", PUSH_PATHS.test],
      ["unbekannt", "/"],
    ];
    for (const [tag, path] of targets) {
      const { clients, opened } = clientsWith([]);
      const work: Promise<unknown>[] = [];
      handleNotificationClick({ notification: { data: null, tag, close: () => undefined }, waitUntil: (promise) => work.push(promise) }, clients, ORIGIN);
      await Promise.all(work);
      expect(opened, tag).toEqual([`${ORIGIN}${path}`]);
    }
    expect(PUSH_PATHS.update).toBe("/einstellungen");
  });

  it("nimmt relative Ziele im eigenen Ursprung", () => {
    expect(targetUrl("/warnungen", ORIGIN)).toBe(`${ORIGIN}/warnungen`);
    expect(targetUrl(`${ORIGIN}/warnungen?x=1`, ORIGIN)).toBe(`${ORIGIN}/warnungen?x=1`);
    expect(targetUrl("https://stowly.example:8443/warnungen", ORIGIN)).toBe(`${ORIGIN}/`);
  });
});
