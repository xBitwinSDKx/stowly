/**
 * Neue Version anbieten statt sofort übernehmen: der Ablauf mit nachgebildetem Service Worker.
 */
import { describe, expect, it } from "vitest";

import { isAppleMobile } from "@/contract/platform";

import { InstallPrompt } from "./install";
import {
  AppUpdates,
  isSkipWaitingMessage,
  serverIsNewer,
  SKIP_WAITING_MESSAGE,
  TAKEOVER_TIMEOUT_MS,
  UPDATE_CHECK_INTERVAL_MS,
  type ContainerLike,
  type RegistrationLike,
  type WorkerLike,
} from "./updates";

class FakeWorker implements WorkerLike {
  state = "installing";
  readonly messages: unknown[] = [];
  private readonly listeners: (() => void)[] = [];

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  addEventListener(_type: "statechange", listener: () => void): void {
    this.listeners.push(listener);
  }

  become(state: string): void {
    this.state = state;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function setup(options: { controlled: boolean; hidden?: boolean }) {
  const env = {
    hidden: options.hidden ?? false,
    reloads: 0,
    ready: [] as boolean[],
    now: 0,
    timers: [] as { callback: () => void; delay: number }[],
    updates: 0,
  };
  const controllerListeners: (() => void)[] = [];
  const container = {
    controller: options.controlled ? {} : null,
    addEventListener(_type: "controllerchange", listener: () => void) {
      controllerListeners.push(listener);
    },
  } satisfies ContainerLike & { controller: unknown };
  const updateFound: (() => void)[] = [];
  const registration = {
    waiting: null as FakeWorker | null,
    installing: null as FakeWorker | null,
    addEventListener(_type: "updatefound", listener: () => void) {
      updateFound.push(listener);
    },
    update() {
      env.updates += 1;
      return Promise.resolve();
    },
  } satisfies RegistrationLike;
  const updates = new AppUpdates(
    {
      container,
      reload: () => {
        env.reloads += 1;
      },
      isHidden: () => env.hidden,
      now: () => env.now,
      setTimer: (callback, delay) => env.timers.push({ callback, delay }),
    },
    (value) => env.ready.push(value),
  );
  return {
    env,
    updates,
    registration,
    container,
    /** Der Browser hat eine neue Version gefunden und installiert sie. */
    install(): FakeWorker {
      const worker = new FakeWorker();
      registration.installing = worker;
      for (const listener of updateFound) {
        listener();
      }
      worker.become("installed");
      registration.installing = null;
      // Ohne Vorgänger wird ein neuer Service Worker gleich aktiv, sonst wartet er.
      if (container.controller) {
        registration.waiting = worker;
      }
      return worker;
    },
    /** Ein (neuer) Service Worker steuert jetzt die Seite. */
    takeControl(): void {
      container.controller = {};
      registration.waiting = null;
      for (const listener of controllerListeners) {
        listener();
      }
    },
  };
}

describe("Aktualisierung der App", () => {
  it("bietet beim allerersten Besuch nichts an und lädt nicht neu", () => {
    const page = setup({ controlled: false });
    page.updates.watch(page.registration);
    page.install();
    // Der erste Service Worker übernimmt die Seite von selbst.
    page.takeControl();
    expect(page.env.ready).toEqual([]);
    expect(page.env.reloads).toBe(0);
    expect(page.updates.ready).toBe(false);
  });

  it("bietet eine neue Version an, statt sie zu übernehmen, und lädt nach dem Übernehmen genau einmal neu", () => {
    const page = setup({ controlled: true });
    page.updates.watch(page.registration);
    const worker = page.install();
    expect(page.env.ready).toEqual([true]);
    expect(page.updates.ready).toBe(true);
    // Von selbst passiert nichts: Der neue Service Worker wartet.
    expect(worker.messages).toEqual([]);
    expect(page.env.reloads).toBe(0);

    page.updates.apply(false);
    expect(worker.messages).toEqual([SKIP_WAITING_MESSAGE]);
    expect(isSkipWaitingMessage(worker.messages[0])).toBe(true);
    expect(page.env.reloads).toBe(0);
    // Neu geladen wird erst, wenn er steuert.
    page.takeControl();
    expect(page.env.reloads).toBe(1);
    // Und nur einmal, was auch kommt.
    page.takeControl();
    page.updates.apply(true);
    for (const timer of page.env.timers) {
      timer.callback();
    }
    expect(page.env.reloads).toBe(1);
  });

  it("bietet eine Version an, die schon beim Start wartet", () => {
    const page = setup({ controlled: true });
    page.registration.waiting = new FakeWorker();
    page.updates.watch(page.registration);
    expect(page.env.ready).toEqual([true]);
  });

  it("bietet eine Version an, deren Installation schon lief, als die Registrierung ankam", () => {
    const page = setup({ controlled: true });
    // Der Browser hat beim Laden der Seite schon nachgesehen; `updatefound` ist vorbei.
    const worker = new FakeWorker();
    page.registration.installing = worker;
    page.updates.watch(page.registration);
    expect(page.env.ready).toEqual([]);
    worker.become("installed");
    page.registration.installing = null;
    page.registration.waiting = worker;
    expect(page.env.ready).toEqual([true]);
    page.updates.apply(false);
    expect(worker.messages).toEqual([SKIP_WAITING_MESSAGE]);
  });

  it("bietet nach dem ersten Besuch auch in derselben Sitzung eine neue Version an", () => {
    const page = setup({ controlled: false });
    page.updates.watch(page.registration);
    page.install();
    page.takeControl();
    const worker = page.install();
    expect(page.env.ready).toEqual([true]);
    page.updates.apply(false);
    expect(worker.messages).toHaveLength(1);
    page.takeControl();
    expect(page.env.reloads).toBe(1);
  });

  it("tut ohne wartende Version nichts, außer der Tab kann ohnehin nicht weiterarbeiten", () => {
    const page = setup({ controlled: true });
    page.updates.watch(page.registration);
    page.updates.apply(false);
    expect(page.env.reloads).toBe(0);
    page.updates.apply(true);
    expect(page.env.reloads).toBe(1);
  });

  it("lädt trotzdem neu, wenn der wartende Service Worker nicht übernimmt", () => {
    const page = setup({ controlled: true });
    page.updates.watch(page.registration);
    page.install();
    page.updates.apply(false);
    expect(page.env.timers.map((timer) => timer.delay)).toEqual([TAKEOVER_TIMEOUT_MS]);
    page.env.timers[0]?.callback();
    expect(page.env.reloads).toBe(1);
  });

  describe("mehrere Tabs", () => {
    it("lädt einen Tab im Hintergrund sofort neu, wenn ein anderer aktualisiert hat", () => {
      const page = setup({ controlled: true, hidden: true });
      page.updates.watch(page.registration);
      page.install();
      // Ein anderer Tab hat `applyUpdate` gerufen: Der neue Service Worker steuert jetzt alle.
      page.takeControl();
      expect(page.env.reloads).toBe(1);
    });

    it("unterbricht einen sichtbaren Tab nicht, sondern bietet weiter an und lädt bei Annahme oder im Hintergrund neu", () => {
      const page = setup({ controlled: true });
      page.updates.watch(page.registration);
      page.install();
      page.takeControl();
      expect(page.env.reloads).toBe(0);
      expect(page.env.ready).toEqual([true, true]);
      expect(page.updates.ready).toBe(true);
      // Der Anwender nimmt an: Es gibt nichts mehr zu übernehmen, also gleich neu laden.
      page.updates.apply(false);
      expect(page.env.reloads).toBe(1);

      const other = setup({ controlled: true });
      other.updates.watch(other.registration);
      other.install();
      other.takeControl();
      other.env.hidden = true;
      other.updates.hidden();
      expect(other.env.reloads).toBe(1);
    });

    it("lädt beim Wechsel in den Hintergrund nicht neu, solange niemand aktualisiert hat", () => {
      const page = setup({ controlled: true });
      page.updates.watch(page.registration);
      page.install();
      page.updates.hidden();
      expect(page.env.reloads).toBe(0);
    });
  });

  it("sieht beim Start nach einer neuen Version und danach gelegentlich, wenn die App wieder sichtbar wird", () => {
    const page = setup({ controlled: true });
    page.updates.watch(page.registration);
    // Beim Start: einmal, sobald die Registrierung da ist.
    expect(page.env.updates).toBe(1);
    page.updates.visible();
    expect(page.env.updates).toBe(1);
    page.env.now = UPDATE_CHECK_INTERVAL_MS;
    page.updates.visible();
    page.updates.visible();
    expect(page.env.updates).toBe(2);
  });

  it("sucht sofort, wenn der Server ein neueres Protokoll spricht, auch vor der Registrierung", () => {
    const page = setup({ controlled: true });
    // Die Registrierung ist noch nicht da: gesucht wird, sobald sie ankommt.
    page.updates.checkNow();
    expect(page.env.updates).toBe(0);
    page.updates.watch(page.registration);
    expect(page.env.updates).toBe(1);
    page.updates.checkNow();
    expect(page.env.updates).toBe(2);
    // Das zählt als Nachsehen: Die nächste Stunde beginnt jetzt.
    page.env.now = UPDATE_CHECK_INTERVAL_MS - 1;
    page.updates.visible();
    expect(page.env.updates).toBe(2);
    // Eine gefundene Version wird wie jede andere angeboten.
    page.install();
    expect(page.env.ready).toEqual([true]);
  });

  it("erkennt am 409, ob der Server neuer ist", () => {
    expect(serverIsNewer({ server: 3, client: 2 }, 2)).toBe(true);
    expect(serverIsNewer({ server: 2, client: 3 }, 3)).toBe(false);
    expect(serverIsNewer({ server: 2, client: 2 }, 2)).toBe(false);
    expect(serverIsNewer({ status: 409 }, 2)).toBe(false);
    expect(serverIsNewer({ server: "3" }, 2)).toBe(false);
  });
});

describe("Installation", () => {
  function promptEvent(outcome: "accepted" | "dismissed") {
    const event = new Event("beforeinstallprompt", { cancelable: true }) as Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }>; prompted: number };
    event.prompted = 0;
    event.prompt = () => {
      event.prompted += 1;
      return Promise.resolve();
    };
    event.userChoice = Promise.resolve({ outcome });
    return event;
  }

  it("hält die Aufforderung des Browsers fest und zeigt sie erst auf Wunsch", async () => {
    const target = new EventTarget();
    const seen: string[] = [];
    const install = new InstallPrompt(target, { canInstall: (value) => seen.push(`can:${value}`), installed: () => seen.push("installed") });
    expect(await install.prompt()).toBe(false);

    const event = promptEvent("accepted");
    target.dispatchEvent(event);
    // Die Leiste des Browsers ist unterdrückt, gezeigt wird noch nichts.
    expect(event.defaultPrevented).toBe(true);
    expect(event.prompted).toBe(0);
    expect(seen).toEqual(["can:true"]);

    expect(await install.prompt()).toBe(true);
    expect(event.prompted).toBe(1);
    // Das Ereignis lässt sich nur einmal verwenden.
    expect(await install.prompt()).toBe(false);
    target.dispatchEvent(new Event("appinstalled"));
    expect(seen).toEqual(["can:true", "can:false", "can:false", "installed"]);
  });

  it("meldet, wenn der Anwender ablehnt", async () => {
    const target = new EventTarget();
    const install = new InstallPrompt(target, { canInstall: () => undefined, installed: () => undefined });
    target.dispatchEvent(promptEvent("dismissed"));
    expect(await install.prompt()).toBe(false);
    install.dispose();
    target.dispatchEvent(promptEvent("accepted"));
    expect(await install.prompt()).toBe(false);
  });

  it("erkennt iPhone und iPad, auch das iPad, das sich als Mac ausgibt", () => {
    expect(isAppleMobile({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 Version/18.4 Mobile/15E148 Safari/604.1", platform: "iPhone", maxTouchPoints: 5 })).toBe(true);
    expect(isAppleMobile({ userAgent: "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15", platform: "iPad", maxTouchPoints: 5 })).toBe(true);
    expect(isAppleMobile({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.4 Safari/605.1.15", platform: "MacIntel", maxTouchPoints: 5 })).toBe(true);
    // Ein echter Mac hat keinen Touchscreen.
    expect(isAppleMobile({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.4 Safari/605.1.15", platform: "MacIntel", maxTouchPoints: 0 })).toBe(false);
    expect(isAppleMobile({ userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 Chrome/142.0.0.0 Mobile Safari/537.36", platform: "Linux armv81", maxTouchPoints: 5 })).toBe(false);
    expect(isAppleMobile(undefined)).toBe(false);
  });
});
