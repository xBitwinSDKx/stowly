/**
 * Push auf diesem Gerät mit nachgebildetem Browser (PushManager, Erlaubnis) gegen die
 * Nachbildung des Servers: einschalten, verweigern, Testnachricht, ausschalten (auch ohne Netz),
 * Neuanmeldung bei anderem Schlüssel des Servers, und das Ende mit dem Abmelden.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { PUSH_TEST_INTERVAL_S } from "@/contract";

import { FAKE_PASSWORD } from "../testing/fake-api";
import { disposeAll, expectCoreError, signedIn, start, value, type Harness } from "../testing/harness";
import { base64urlToBytes, bytesToBase64url, sameServerKey, subscriptionInput, type PermissionValue, type PushEnvironment, type PushManagerLike, type PushSubscriptionLike } from "./device";

afterEach(disposeAll);

const P256DH = `BA${"A".repeat(85)}`;
const AUTH = "AAAAAAAAAAAAAAAAAAAAAA";
const ORIGIN = "https://stowly.example";

class FakeSubscription implements PushSubscriptionLike {
  constructor(
    readonly endpoint: string,
    readonly options: { applicationServerKey: ArrayBuffer },
    private readonly manager: FakePushManager,
  ) {}

  toJSON() {
    return { endpoint: this.endpoint, expirationTime: null, keys: { p256dh: P256DH, auth: AUTH } };
  }

  async unsubscribe(): Promise<boolean> {
    this.manager.unsubscribed.push(this.endpoint);
    if (this.manager.current === this) {
      this.manager.current = null;
    }
    return true;
  }
}

class FakePushManager implements PushManagerLike {
  current: FakeSubscription | null = null;
  readonly subscribed: string[] = [];
  readonly unsubscribed: string[] = [];

  async getSubscription(): Promise<FakeSubscription | null> {
    return this.current;
  }

  async subscribe(options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array<ArrayBuffer> }): Promise<FakeSubscription> {
    expect(options.userVisibleOnly).toBe(true);
    const endpoint = `https://fcm.googleapis.com/fcm/send/abo-${this.subscribed.length + 1}`;
    this.subscribed.push(endpoint);
    this.current = new FakeSubscription(endpoint, { applicationServerKey: options.applicationServerKey.slice().buffer }, this);
    return this.current;
  }
}

interface FakeBrowser extends PushEnvironment {
  supportValue: "unsupported" | "ios_install" | null;
  permissionValue: PermissionValue;
  /** Was der Anwender auf die Frage antwortet. */
  answer: PermissionValue;
  asked: number;
  manager: FakePushManager;
}

function browser(): FakeBrowser {
  const env: FakeBrowser = {
    supportValue: null,
    permissionValue: "default",
    answer: "granted",
    asked: 0,
    manager: new FakePushManager(),
    support: () => env.supportValue,
    permission: () => env.permissionValue,
    requestPermission: () => {
      env.asked += 1;
      if (env.permissionValue === "default") {
        env.permissionValue = env.answer;
      }
      return Promise.resolve(env.permissionValue);
    },
    pushManager: () => Promise.resolve(env.manager),
    origin: ORIGIN,
  };
  return env;
}

function deviceId(harness: Harness): string {
  const state = value(harness.core.session.state);
  if (state.status !== "signed_in") {
    throw new Error("nicht angemeldet");
  }
  return state.device.id;
}

async function withPush(env: FakeBrowser = browser()): Promise<Harness & { env: FakeBrowser }> {
  const harness = await signedIn({ core: { push: env } });
  return { ...harness, env };
}

describe("Push einschalten", () => {
  it("fragt die Erlaubnis noch im Tipp, legt das Abo an und meldet es mit dem Ursprung beim Server an", async () => {
    const harness = await withPush();
    const { core, server, env } = harness;
    expect(value(core.push.state)).toBe("off");

    const enabling = core.push.enable();
    // Gefragt wird, bevor irgendetwas wartet: Safari fragt sonst nicht.
    expect(env.asked).toBe(1);
    expect(await enabling).toBe("on");
    expect(value(core.push.state)).toBe("on");
    expect(server.pushSubscriptionOf(deviceId(harness))).toEqual({ endpoint: env.manager.subscribed[0], keys: { p256dh: P256DH, auth: AUTH }, origin: ORIGIN });
    // Der Schlüssel des Abos ist der des Servers.
    expect(bytesToBase64url(env.manager.current?.options.applicationServerKey ?? new ArrayBuffer(0))).toBe(server.pushKey);

    // Noch einmal: dasselbe Abo, ohne neue Frage.
    expect(await core.push.enable()).toBe("on");
    expect(env.asked).toBe(1);
    expect(env.manager.subscribed).toHaveLength(1);
  });

  it("meldet eine verweigerte oder weggeklickte Erlaubnis", async () => {
    const denied = await withPush();
    denied.env.answer = "denied";
    expect(await denied.core.push.enable()).toBe("denied");
    expect(value(denied.core.push.state)).toBe("denied");
    expect(denied.env.manager.subscribed).toEqual([]);
    expect(denied.server.pushSubscriptionOf(deviceId(denied))).toBeUndefined();

    const dismissed = await withPush();
    dismissed.env.answer = "default";
    expect(await dismissed.core.push.enable()).toBe("off");
    expect(value(dismissed.core.push.state)).toBe("off");
  });

  it("erkennt einen Server ohne Push und einen Browser ohne Push", async () => {
    const env = browser();
    const harness = await start({ core: { push: env } });
    harness.server.pushConfigured = false;
    await harness.core.session.login(FAKE_PASSWORD, "Handy");
    await vi.waitFor(() => expect(value(harness.core.push.state)).toBe("not_configured"));
    // Dann wird gar nicht erst gefragt.
    await expectCoreError(harness.core.push.enable(), "not_configured");
    expect(env.asked).toBe(0);

    const iphone = browser();
    iphone.supportValue = "ios_install";
    const onIphone = await withPush(iphone);
    expect(value(onIphone.core.push.state)).toBe("ios_install");
    await expectCoreError(onIphone.core.push.enable(), "not_supported");
    expect(iphone.asked).toBe(0);
  });

  it("braucht den Server: ohne ihn scheitert es, das Abo im Browser bleibt für den nächsten Versuch", async () => {
    const harness = await withPush();
    const { core, server, network, env } = harness;
    network.offline = true;
    await expectCoreError(core.push.enable(), "offline");
    expect(value(core.push.state)).toBe("off");
    network.offline = false;
    expect(await core.push.enable()).toBe("on");
    expect(server.pushSubscriptionOf(deviceId(harness))?.endpoint).toBe(env.manager.current?.endpoint);
  });
});

describe("Testnachricht und Ausschalten", () => {
  it("schickt Testnachrichten und folgt dem, was der Push-Dienst antwortet", async () => {
    const harness = await withPush();
    const { core, server, clock, env } = harness;
    await expectCoreError(core.push.test(), "not_found");
    await core.push.enable();
    expect(await core.push.test()).toEqual({ status: "sent", http_status: 201, message: "Der Push-Dienst hat die Nachricht angenommen." });
    expect(server.pushMessages.at(-1)?.payload.notification).toMatchObject({ title: "Stowly", tag: "stowly-test", navigate: `${ORIGIN}/einstellungen` });
    const limited = await expectCoreError(core.push.test(), "rate_limited");
    expect(limited.details.retry_after_s).toBe(PUSH_TEST_INTERVAL_S);

    clock.advance(PUSH_TEST_INTERVAL_S * 1000);
    server.pushTestStatus = "gone";
    expect((await core.push.test()).status).toBe("gone");
    // Das Abo taugt nirgends mehr: auch im Browser beendet, damit Einschalten ein neues anlegt.
    expect(value(core.push.state)).toBe("off");
    expect(env.manager.current).toBeNull();
    server.pushTestStatus = "sent";
    expect(await core.push.enable()).toBe("on");
    expect(env.manager.subscribed).toHaveLength(2);
  });

  it("schaltet aus, auch ohne Netz; der Server erfährt es beim nächsten Kontakt", async () => {
    const harness = await withPush();
    const { core, server, network, env } = harness;
    await core.push.enable();
    await core.push.disable();
    expect(value(core.push.state)).toBe("off");
    expect(env.manager.current).toBeNull();
    expect(server.pushSubscriptionOf(deviceId(harness))).toBeUndefined();

    await core.push.enable();
    network.offline = true;
    await core.push.disable();
    expect(value(core.push.state)).toBe("off");
    expect(server.pushSubscriptionOf(deviceId(harness))).toBeDefined();
    network.offline = false;
    await core.sync.now();
    await vi.waitFor(() => expect(server.pushSubscriptionOf(deviceId(harness))).toBeUndefined());
  });

  it("endet mit dem Abmelden: im Browser sofort, beim Server mit dem Token", async () => {
    const harness = await withPush();
    const { core, server, env } = harness;
    await core.push.enable();
    const id = deviceId(harness);
    await core.session.logout();
    expect(env.manager.current).toBeNull();
    expect(value(core.push.state)).toBe("off");
    await vi.waitFor(() => expect(server.pushSubscriptionOf(id)).toBeUndefined());
  });
});

describe("Beim Start", () => {
  it("meldet ein Abo neu an, wenn der Server einen anderen Schlüssel hat oder es nicht mehr kennt", async () => {
    const harness = await withPush();
    const { server, env } = harness;
    await harness.core.push.enable();
    const first = env.manager.current?.endpoint;

    // Eine zurückgespielte Sicherung bringt einen anderen Schlüssel und kennt das Abo nicht.
    server.rotatePushKey();
    server.forgetPushSubscriptions();
    const reopened = await harness.another();
    await vi.waitFor(() => {
      expect(env.manager.subscribed).toHaveLength(2);
      expect(server.pushSubscriptionOf(deviceId(harness))?.endpoint).toBe(env.manager.subscribed[1]);
    });
    expect(env.manager.unsubscribed).toContain(first);
    expect(bytesToBase64url(env.manager.current?.options.applicationServerKey ?? new ArrayBuffer(0))).toBe(server.pushKey);
    expect(value(reopened.push.state)).toBe("on");

    // Derselbe Schlüssel, aber der Server hat das Abo vergessen: dasselbe Abo noch einmal anmelden.
    server.forgetPushSubscriptions();
    await harness.another();
    await vi.waitFor(() => expect(server.pushSubscriptionOf(deviceId(harness))?.endpoint).toBeDefined());
    expect(server.pushSubscriptionOf(deviceId(harness))?.endpoint).toBe(env.manager.subscribed[1]);
    expect(env.manager.subscribed).toHaveLength(2);
  });

  it("gilt ohne Server mit dem Abo des Browsers als an und holt den Abgleich nach", async () => {
    const harness = await withPush();
    const { server, network, env } = harness;
    await harness.core.push.enable();
    server.forgetPushSubscriptions();
    network.offline = true;
    const reopened = await harness.another();
    await vi.waitFor(() => expect(value(reopened.push.state)).toBe("on"));
    expect(server.pushSubscriptionOf(deviceId(harness))).toBeUndefined();
    network.offline = false;
    await reopened.sync.now();
    await vi.waitFor(() => expect(server.pushSubscriptionOf(deviceId(harness))?.endpoint).toBe(env.manager.current?.endpoint));
  });

  it("erkennt eine im Browser verweigerte Erlaubnis", async () => {
    const env = browser();
    env.permissionValue = "denied";
    const harness = await withPush(env);
    await vi.waitFor(() => expect(value(harness.core.push.state)).toBe("denied"));
  });

  it("liest den Zustand neu, wenn die App wieder sichtbar wird: eine neu erteilte Erlaubnis gilt ohne Neuladen", async () => {
    const env = browser();
    env.permissionValue = "denied";
    const harness = await withPush(env);
    await vi.waitFor(() => expect(value(harness.core.push.state)).toBe("denied"));

    // In den Einstellungen des Browsers erlaubt, dann zurück zu Stowly.
    env.permissionValue = "granted";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(value(harness.core.push.state)).toBe("off"));
    expect(await harness.core.push.enable()).toBe("on");
    expect(env.asked).toBe(0);
  });
});

describe("Zustand der Integrationen", () => {
  it("kommt vom Server und braucht ihn", async () => {
    const harness = await withPush();
    await harness.core.push.enable();
    const status = await harness.core.integrations.load();
    expect(status).toMatchObject({ timezone: "Europe/Berlin", backup: { configured: false }, ha: { state: "off" }, push: { configured: true, this_device: true, subscriptions: 1 } });
    harness.network.offline = true;
    await expectCoreError(harness.core.integrations.load(), "offline");
  });
});

describe("Hilfen", () => {
  it("rechnet base64url hin und zurück und vergleicht Schlüssel", () => {
    const bytes = Uint8Array.from([4, 255, 0, 62, 63, 250]);
    const text = bytesToBase64url(bytes);
    expect(text).not.toMatch(/[+/=]/);
    expect([...base64urlToBytes(text)]).toEqual([...bytes]);
    expect([...base64urlToBytes(`${text}==`)]).toEqual([...bytes]);
    const manager = new FakePushManager();
    const subscription = new FakeSubscription("https://fcm.googleapis.com/x", { applicationServerKey: bytes.slice().buffer }, manager);
    expect(sameServerKey(subscription, text)).toBe(true);
    expect(sameServerKey(subscription, bytesToBase64url(Uint8Array.from([4, 1])))).toBe(false);
    // Ohne Angabe des Browsers gilt das Abo als passend.
    expect(sameServerKey({ ...subscription, options: null, toJSON: () => ({}), unsubscribe: async () => true }, text)).toBe(true);
    expect(subscriptionInput(subscription, ORIGIN)).toEqual({ endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: P256DH, auth: AUTH }, origin: ORIGIN });
  });
});
