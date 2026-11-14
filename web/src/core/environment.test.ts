/**
 * Der Kern in seiner Umgebung: Auslöser des Abgleichs, Abgleich im Hintergrund (Service
 * Worker), Web Locks, Produktbilder, und was übrig bleibt, wenn der Browser etwas nicht hat
 * (kein sicherer Kontext, keine lokale Datenbank).
 */
import Dexie from "dexie";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Product, SyncRequest } from "@/contract";

import { createCore } from ".";
import { runBackgroundSync } from "./background";
import { IMAGE_CACHE, imageUrl, preloadImages } from "./images";
import { SYNC_LOCK_NAME, withLock } from "./sync/lock";
import { CHECK_INTERVAL_MS, type SchedulerTimers } from "./sync/scheduler";
import { createFakeNetwork, FAKE_PASSWORD, FakeServer } from "./testing/fake-api";
import { commandsOf, createClock, disposeAll, expectCoreError, firstZoneId, signedIn, start, value } from "./testing/harness";

afterEach(async () => {
  await disposeAll();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Zeitgeber von Hand: sammelt, was der Kern vormerkt, und führt es auf Wunsch aus. */
function manualTimers() {
  const pending = new Map<number, { delay: number; callback: () => void }>();
  let next = 1;
  const timers: SchedulerTimers = {
    set(callback, delayMs) {
      const handle = next;
      next += 1;
      pending.set(handle, { delay: delayMs, callback });
      return handle;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    delays: () => [...pending.values()].map((entry) => entry.delay).sort((a, b) => a - b),
    /** Kennung des vorgemerkten Zeitgebers mit dieser Wartezeit; eine neue heißt: neu gestellt. */
    handle: (delay: number) => [...pending].find(([, entry]) => entry.delay === delay)?.[0] ?? null,
    /** Führt den Zeitgeber mit dieser Wartezeit aus. */
    fire(delay: number) {
      for (const [handle, entry] of pending) {
        if (entry.delay === delay) {
          pending.delete(handle);
          entry.callback();
          return;
        }
      }
      throw new Error(`Kein Zeitgeber mit ${delay} ms; vorgemerkt: ${[...pending.values()].map((entry) => entry.delay).join(", ")}`);
    },
  };
}

describe("Auslöser des Abgleichs", () => {
  it("gleicht beim Start ab, nach einer Änderung binnen 2 Sekunden und wenn der Browser online meldet", async () => {
    const clock = manualTimers();
    const { core, server, network } = await start({ core: { autoSync: true, timers: clock.timers } });
    // Beim Start, noch nicht angemeldet: nur die Erreichbarkeit.
    await expect.poll(() => value(core.sync.status).online).toBe(true);
    expect(server.syncRequests).toHaveLength(0);
    expect(network.calls.map((call) => call.path)).toContain("/api/health");

    await core.session.login(FAKE_PASSWORD, "Handy");
    const afterLogin = server.syncRequests.length;

    // Eine lokale Änderung merkt einen Abgleich in 2 Sekunden vor; weitere Änderungen keinen zweiten.
    await core.zones.create({ name: "Keller" });
    await core.zones.create({ name: "Garage" });
    expect(clock.delays().filter((delay) => delay === 2_000)).toHaveLength(1);
    expect(server.syncRequests).toHaveLength(afterLogin);
    clock.fire(2_000);
    await expect.poll(() => value(core.sync.status).pending).toBe(0);
    expect(commandsOf(server.syncRequests[afterLogin]).map((command) => command.type)).toEqual(["zone.create", "zone.create"]);
    // Danach läuft der Takt von 60 Sekunden.
    expect(clock.delays()).toContain(60_000);

    const before = server.syncRequests.length;
    window.dispatchEvent(new Event("online"));
    await expect.poll(() => server.syncRequests.length).toBe(before + 1);

    // `offline` des Browsers ist verlässlich: sofort als nicht erreichbar zeigen.
    window.dispatchEvent(new Event("offline"));
    expect(value(core.sync.status).online).toBe(false);
  });

  it("versucht es nach einem Fehlschlag nach 2 Sekunden erneut und sendet dann", async () => {
    const clock = manualTimers();
    const { core, server, network } = await start({ core: { autoSync: true, timers: clock.timers } });
    await core.session.login(FAKE_PASSWORD, "Handy");
    network.offline = true;
    await core.zones.create({ name: "Keller" });
    clock.fire(2_000);
    await expect.poll(() => value(core.sync.status).phase).toBe("error");
    expect(clock.delays()).toEqual([2_000]);

    network.offline = false;
    clock.fire(2_000);
    await expect.poll(() => value(core.sync.status).pending).toBe(0);
    expect(server.data.zones.size).toBe(2);
  });

  it("sieht nach einem neuen Platzhalter früher nach und zeigt den ergänzten Namen", async () => {
    const clock = manualTimers();
    const time = createClock();
    const { core } = await start({ clock: time, server: { lookupDelayMs: 2_500 }, core: { autoSync: true, timers: clock.timers } });
    await core.session.login(FAKE_PASSWORD, "Handy");
    const stored = await core.stock.store({ product: { kind: "barcode", barcode: "96385074" }, zone_id: firstZoneId(core), best_before: null, count: 1 });
    expect(stored.product).toMatchObject({ name: "", lookup: "pending" });
    clock.fire(2_000);
    await expect.poll(() => value(core.sync.status).pending).toBe(0);
    // Solange das Produkt nachgeschlagen wird: zusätzlich nach 3, 10 und 30 Sekunden (daneben
    // die Prüfung nebenbei nach 15 und der Takt nach 60 Sekunden).
    expect(clock.delays()).toEqual([3_000, 10_000, CHECK_INTERVAL_MS, 30_000, 60_000]);

    time.advance(3_000);
    clock.fire(3_000);
    await expect.poll(() => value(core.data.products)[0]?.lookup).toBe("found");
    expect(value(core.data.products)[0]).toMatchObject({ name: "Beispielprodukt 5074", brand: "Beispielmarke" });
  });

  it("gleicht mit autoSync: false nie von selbst ab", async () => {
    const clock = manualTimers();
    const { core, network } = await start({ core: { autoSync: false, timers: clock.timers } });
    await core.session.login(FAKE_PASSWORD, "Handy");
    const calls = network.calls.length;
    await core.zones.create({ name: "Keller" });
    window.dispatchEvent(new Event("online"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(clock.delays()).toEqual([]);
    expect(network.calls).toHaveLength(calls);
  });
});

/** Ein Versprechen, das der Test selbst erfüllt. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Ein Proxy ohne Server dahinter (502, nicht im Fehlerformat): „nicht erreichbar". Merkt, was gefragt wurde. */
function serverGone(asked: string[]) {
  return (call: { path: string }) => {
    asked.push(call.path);
    return new Response("Bad Gateway", { status: 502 });
  };
}

describe("Ist der Server erreichbar? (Prüfung nebenbei)", () => {
  it("merkt einen Ausfall nach 15 Sekunden mit einer kleinen Anfrage und gleicht bei der Rückkehr sofort ab", async () => {
    const clock = manualTimers();
    const { core, server, network } = await start({ core: { autoSync: true, timers: clock.timers } });
    await core.session.login(FAKE_PASSWORD, "Handy");
    expect(value(core.sync.status)).toMatchObject({ online: true, phase: "idle" });
    // Nach der Anmeldung: Prüfung in 15 Sekunden, Abgleich in 60.
    expect(clock.delays()).toEqual([CHECK_INTERVAL_MS, 60_000]);

    // Der Server fällt aus, während niemand etwas ändert.
    const asked: string[] = [];
    network.respondWith = serverGone(asked);
    clock.fire(CHECK_INTERVAL_MS);
    await expect.poll(() => value(core.sync.status).online).toBe(false);
    expect(value(core.sync.status)).toMatchObject({ phase: "error", last_error: { code: "offline" } });
    expect(asked).toEqual(["/api/health"]);
    // Solange er fehlt: kein Abgleich nach der Uhr, nur die nächste Prüfung.
    expect(clock.delays()).toEqual([CHECK_INTERVAL_MS]);
    clock.fire(CHECK_INTERVAL_MS);
    await expect.poll(() => asked).toEqual(["/api/health", "/api/health"]);
    expect(server.syncRequests).toHaveLength(1);

    // Er ist wieder da: Die nächste Prüfung merkt es, und es wird sofort abgeglichen.
    network.respondWith = null;
    await expect.poll(() => clock.delays()).toEqual([CHECK_INTERVAL_MS]);
    clock.fire(CHECK_INTERVAL_MS);
    await expect.poll(() => value(core.sync.status)).toMatchObject({ online: true, phase: "idle", last_error: null });
    expect(server.syncRequests).toHaveLength(2);
    // Und der Abgleich braucht keine eigene Prüfung mehr: Die eben gelungene genügt.
    expect(network.calls.slice(-2).map((call) => call.path)).toEqual(["/api/health", "/api/sync"]);
    expect(clock.delays()).toEqual([CHECK_INTERVAL_MS, 60_000]);
  });

  it("lernt aus anderen Aufrufen: ohne Server kein Takt, und antwortet er wieder, wird sofort abgeglichen", async () => {
    const clock = manualTimers();
    const { core, server, network } = await start({ core: { autoSync: true, timers: clock.timers } });
    await core.session.login(FAKE_PASSWORD, "Handy");
    const check = clock.handle(CHECK_INTERVAL_MS);

    network.offline = true;
    await expectCoreError(core.devices.list(), "offline");
    expect(value(core.sync.status).online).toBe(false);
    // Kein Abgleich nach der Uhr mehr; die Prüfung wartet wieder volle 15 Sekunden.
    expect(clock.delays()).toEqual([CHECK_INTERVAL_MS]);
    expect(clock.handle(CHECK_INTERVAL_MS)).not.toBe(check);

    network.offline = false;
    await core.devices.list();
    await expect.poll(() => server.syncRequests.length).toBe(2);
    await expect.poll(() => value(core.sync.status)).toMatchObject({ online: true, phase: "idle" });
  });

  it("prüft nur angemeldet und im Vordergrund", async () => {
    const clock = manualTimers();
    const { core, network } = await start({ core: { autoSync: true, timers: clock.timers } });
    // Abgemeldet: nur der Takt (der dann allein die Erreichbarkeit prüft).
    await expect.poll(() => value(core.sync.status).online).toBe(true);
    expect(clock.delays()).toEqual([60_000]);

    await core.session.login(FAKE_PASSWORD, "Handy");
    expect(clock.delays()).toContain(CHECK_INTERVAL_MS);
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(clock.delays()).toEqual([]);
    const calls = network.calls.length;
    await core.devices.list();
    expect(clock.delays()).toEqual([]);

    hidden.mockRestore();
    document.dispatchEvent(new Event("visibilitychange"));
    await expect.poll(() => clock.delays()).toEqual([CHECK_INTERVAL_MS, 60_000]);
    expect(network.calls.length).toBeGreaterThan(calls);
  });

  it("zwei sichtbare Tabs: Was einer erfährt, gilt im anderen, und der fragt nicht selbst", async () => {
    const first = manualTimers();
    const second = manualTimers();
    const { core, network, another } = await start({ core: { autoSync: true, timers: first.timers } });
    await core.session.login(FAKE_PASSWORD, "Handy");
    const tab = await another({ timers: second.timers });
    await expect.poll(() => second.delays()).toContain(CHECK_INTERVAL_MS);

    // Der erste Tab prüft; der zweite wartet danach wieder volle 15 Sekunden.
    const waiting = second.handle(CHECK_INTERVAL_MS);
    first.fire(CHECK_INTERVAL_MS);
    await expect.poll(() => second.handle(CHECK_INTERVAL_MS)).not.toBe(waiting);

    // Der Server fällt aus: Der erste Tab merkt es, der zweite zeigt es, ohne selbst zu fragen.
    const asked: string[] = [];
    network.respondWith = serverGone(asked);
    await expect.poll(() => first.delays()).toContain(CHECK_INTERVAL_MS);
    first.fire(CHECK_INTERVAL_MS);
    await expect.poll(() => value(tab.sync.status)).toMatchObject({ online: false, phase: "error", last_error: { code: "offline" } });
    expect(value(core.sync.status).online).toBe(false);
    expect(asked).toEqual(["/api/health"]);
    // Auch der zweite Tab gleicht ohne Server nicht mehr nach der Uhr ab.
    expect(second.delays()).toEqual([CHECK_INTERVAL_MS]);

    // Er ist wieder da: Beide gleichen ab und zeigen „erreichbar".
    network.respondWith = null;
    await expect.poll(() => first.delays()).toContain(CHECK_INTERVAL_MS);
    first.fire(CHECK_INTERVAL_MS);
    await expect.poll(() => value(core.sync.status)).toMatchObject({ online: true, phase: "idle", last_error: null });
    await expect.poll(() => value(tab.sync.status)).toMatchObject({ online: true, phase: "idle", last_error: null });
  });

  it("fragt nicht, solange ein anderer Tab abgleicht (Sperre stowly-sync, ohne auf sie zu warten)", async () => {
    const first = manualTimers();
    const second = manualTimers();
    const { core, network, another } = await start({ core: { autoSync: true, timers: first.timers } });
    await core.session.login(FAKE_PASSWORD, "Handy");
    const tab = await another({ timers: second.timers });
    await expect.poll(() => second.delays()).toContain(CHECK_INTERVAL_MS);
    await core.zones.create({ name: "Keller" });

    // Der Abgleich des ersten Tabs hängt beim Server.
    const slow = gate();
    let syncing = false;
    network.beforeRequest = async (call) => {
      if (call.path === "/api/sync") {
        syncing = true;
        await slow.promise;
      }
    };
    const running = core.sync.now();
    await expect.poll(() => syncing).toBe(true);
    const healthChecks = () => network.calls.filter((call) => call.path === "/api/health").length;
    const before = healthChecks();
    second.fire(CHECK_INTERVAL_MS);
    // Die Prüfung entfällt und wartet wieder 15 Sekunden.
    await expect.poll(() => second.delays()).toContain(CHECK_INTERVAL_MS);
    expect(healthChecks()).toBe(before);
    expect(value(tab.sync.status).online).toBe(true);

    network.beforeRequest = null;
    slow.open();
    await running;
    expect(value(core.sync.status)).toMatchObject({ pending: 0, phase: "idle" });
    // Ist die Sperre frei, fragt er wieder.
    await expect.poll(() => second.delays()).toContain(CHECK_INTERVAL_MS);
    second.fire(CHECK_INTERVAL_MS);
    await expect.poll(() => healthChecks()).toBe(before + 1);
  });
});

describe("Abgleich im Hintergrund (Service Worker)", () => {
  it("sendet die wartenden Änderungen aus derselben Datenbank, und der offene Tab erfährt davon", async () => {
    const { core, server, network, clock, dbName } = await signedIn();
    network.offline = true;
    await core.zones.create({ name: "Keller" });
    await core.sync.now();
    expect(value(core.sync.status).pending).toBe(1);

    // Kein Netz: Der Versuch scheitert laut, damit der Browser ihn später wiederholt.
    await expect(runBackgroundSync({ fetch: network.fetch, now: clock.now, dbName })).rejects.toMatchObject({ code: "offline" });
    expect(value(core.sync.status).pending).toBe(1);

    network.offline = false;
    const outcome = await runBackgroundSync({ fetch: network.fetch, now: clock.now, dbName });
    expect(outcome).toEqual({ ok: true, synced: true });
    expect(server.data.zones.size).toBe(2);
    await expect.poll(() => value(core.sync.status).pending).toBe(0);
    expect(value(core.data.zones).map((zone) => zone.name)).toEqual(["Vorrat", "Keller"]);
  });

  it("tut nichts, wenn nichts wartet oder das Gerät nicht angemeldet ist", async () => {
    const { server, network, clock, dbName } = await signedIn();
    const before = network.calls.length;
    expect(await runBackgroundSync({ fetch: network.fetch, now: clock.now, dbName })).toBeNull();
    expect(network.calls).toHaveLength(before);
    expect(server.syncRequests).toHaveLength(1);

    const fresh = await start();
    expect(await runBackgroundSync({ fetch: fresh.network.fetch, now: fresh.clock.now, dbName: fresh.dbName })).toBeNull();
    expect(fresh.network.calls).toEqual([]);
  });

  it("meldet ein gesperrtes Token, ohne die Outbox zu verlieren", async () => {
    const { core, server, network, clock, dbName } = await signedIn();
    await core.zones.create({ name: "Keller" });
    server.revoke();
    const outcome = await runBackgroundSync({ fetch: network.fetch, now: clock.now, dbName });
    expect(outcome).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    await expect.poll(() => value(core.session.state)).toMatchObject({ status: "signed_out", reason: "revoked" });
    expect(value(core.sync.status).pending).toBe(1);
  });
});

describe("Web Locks", () => {
  it("benutzt die Sperre des Browsers unter dem Namen aus dem Protokoll", async () => {
    const requested: string[] = [];
    vi.stubGlobal("navigator", {
      ...navigator,
      onLine: true,
      locks: {
        request: async <T>(name: string, callback: () => Promise<T>): Promise<T> => {
          requested.push(name);
          return callback();
        },
      },
    });
    expect(SYNC_LOCK_NAME).toBe("stowly-sync");
    expect(await withLock(SYNC_LOCK_NAME, async () => 7)).toBe(7);
    expect(requested).toEqual(["stowly-sync"]);

    // Der Kern auf der Datenbank mit dem Standardnamen benutzt genau diesen Namen.
    const server = new FakeServer();
    const network = createFakeNetwork(server);
    const core = createCore({ fetch: network.fetch, autoSync: false });
    await core.ready;
    await core.sync.now();
    expect(requested).toEqual(["stowly-sync", "stowly-sync"]);
    core.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Dexie.delete("stowly");
  });

  it("reiht ohne Web Locks die Abgleiche eines Tabs hintereinander", async () => {
    const order: string[] = [];
    const slow = withLock("test-lock", async () => {
      order.push("a-start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("a-end");
    });
    const fast = withLock("test-lock", async () => {
      order.push("b");
    });
    // Ein Fehler in einem Lauf hält den nächsten nicht auf.
    const failing = withLock("test-lock", async () => {
      throw new Error("kaputt");
    });
    const last = withLock("test-lock", async () => order.push("c"));
    await Promise.all([slow, fast, failing.catch(() => undefined), last]);
    expect(order).toEqual(["a-start", "a-end", "b", "c"]);
  });
});

describe("Produktbilder", () => {
  function fakeCaches() {
    const stored = new Map<string, Response>();
    const cache = {
      match: async (url: string) => stored.get(url),
      put: async (url: string, response: Response) => {
        stored.set(url, response);
      },
      keys: async () => [...stored.keys()].map((url) => ({ url: `http://localhost${url}` })),
      delete: async (request: { url: string }) => stored.delete(new URL(request.url).pathname),
    };
    const opened: string[] = [];
    vi.stubGlobal("caches", {
      open: async (name: string) => {
        opened.push(name);
        return cache;
      },
      delete: async () => {
        stored.clear();
        return true;
      },
    });
    return { stored, opened };
  }

  const product = (n: number, image: string | null): Product => ({
    id: `20000000-0000-4000-8000-00000000000${n}`,
    name: `Produkt ${n}`,
    brand: "",
    quantity: "",
    image,
    warn_days: null,
    min_stock: null,
    lookup: "found",
    barcodes: [],
    created_at: "2026-11-13T10:00:00.000Z",
    updated_at: "2026-11-13T10:00:00.000Z",
    deleted_at: null,
    merged_into: null,
  });

  it("liefert die Adresse eines Bilds beim Server", async () => {
    const { core } = await start();
    expect(core.data.imageUrl("9f2c0011aabbccdd9f2c0011aabbccdd.jpg")).toBe("/api/images/9f2c0011aabbccdd9f2c0011aabbccdd.jpg");
    expect(imageUrl("a b.jpg")).toBe("/api/images/a%20b.jpg");
  });

  it("lädt nach einem Abgleich die Bilder der Produkte im Bestand vorab und räumt verwaiste weg", async () => {
    const { stored, opened } = fakeCaches();
    const { core, server, network } = await signedIn();
    const zone = firstZoneId(core);
    server.put("products", product(1, "aaa.jpg"));
    server.put("products", product(2, "bbb.jpg"));
    server.put("products", product(3, null));
    server.act({ type: "package.create", package_id: "00001", product_id: product(1, null).id, zone_id: zone });
    stored.set("/api/images/alt.jpg", new Response("alt"));
    const fetched: string[] = [];
    network.respondWith = (call) => {
      if (!call.path.startsWith("/api/images/")) {
        return null;
      }
      fetched.push(call.path);
      return new Response("bild", { status: 200, headers: { "content-type": "image/jpeg" } });
    };

    await core.sync.now();
    await expect.poll(() => [...stored.keys()].sort()).toEqual(["/api/images/aaa.jpg"]);
    // Nur das Bild des Produkts mit Bestand wird geholt; das verwaiste ist weg.
    expect(fetched).toEqual(["/api/images/aaa.jpg"]);
    expect(opened).toContain(IMAGE_CACHE);

    // Was schon da ist, wird nicht noch einmal geholt.
    await core.sync.now();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetched).toEqual(["/api/images/aaa.jpg"]);

    // Beim Abmelden verschwinden auch die Bilder.
    await core.session.logout();
    await expect.poll(() => stored.size).toBe(0);
  });

  it("kommt ohne Cache aus (kein sicherer Kontext) und behält nur gelungene Antworten", async () => {
    await expect(preloadImages(["a.jpg"], ["a.jpg"], async () => new Response("x"))).resolves.toBeUndefined();
    const { stored } = fakeCaches();
    await preloadImages(["fehlt.jpg", "da.jpg"], ["fehlt.jpg", "da.jpg"], async (url) => new Response("x", { status: url.includes("fehlt") ? 404 : 200 }));
    expect([...stored.keys()]).toEqual(["/api/images/da.jpg"]);
  });
});

describe("Ohne sicheren Kontext (http://<LAN-IP>)", () => {
  it("läuft als Online-Webseite weiter: ohne crypto.randomUUID, ohne Web Locks, ohne Cache", async () => {
    vi.stubGlobal("isSecureContext", false);
    // So wie der Browser es dort zeigt: Die Funktion fehlt ganz.
    const original = Object.getOwnPropertyDescriptor(crypto, "randomUUID") ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(crypto), "randomUUID");
    Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined });
    expect(typeof crypto.randomUUID).toBe("undefined");
    try {
      const { core, server } = await start();
      expect(value(core.app.state)).toMatchObject({ secure_context: false, storage_persistent: null });
      await core.session.login(FAKE_PASSWORD, "Rechner im LAN");
      const stored = await core.stock.store({ product: { kind: "new", name: "Reis" }, zone_id: firstZoneId(core), best_before: null, count: 2 });
      await core.sync.now();
      expect(value(core.sync.status)).toMatchObject({ pending: 0, phase: "idle" });
      expect(server.data.packages.size).toBe(2);
      const sent = commandsOf(server.syncRequests.at(-1));
      expect(sent.every((command) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(command.id)))).toBe(true);
      expect(stored.packages).toHaveLength(2);
    } finally {
      Reflect.deleteProperty(crypto, "randomUUID");
      if (original && typeof crypto.randomUUID !== "function") {
        Object.defineProperty(crypto, "randomUUID", original);
      }
      expect(typeof crypto.randomUUID).toBe("function");
    }
  });
});

describe("Ohne lokale Datenbank", () => {
  it("bleibt bedienbar abgemeldet und sagt beim Anmelden, woran es liegt", async () => {
    const open = vi.spyOn(Dexie.prototype, "open").mockRejectedValue(new Error("IndexedDB ist gesperrt"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { core } = await start();
    expect(value(core.session.state)).toEqual({ status: "signed_out", reason: "never", last_device_name: null });
    await expectCoreError(core.session.login(FAKE_PASSWORD, "Handy"), "not_supported");
    await expectCoreError(core.zones.create({ name: "Keller" }), "not_supported");
    await expect(core.sync.now()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    open.mockRestore();
  });
});

describe("Erste Anfrage", () => {
  it("nennt Protokoll, Zeitpunkt des Absendens und die Version der App", async () => {
    const { server } = await signedIn();
    const request = server.syncRequests[0] as unknown as SyncRequest;
    expect(Object.keys(request).sort()).toEqual(["app_version", "commands", "cursor", "dataset_id", "id_pool", "protocol", "sent_at"]);
    expect(request.app_version).toBe("0.0.0-test");
    expect(request.sent_at).toBe("2026-11-13T10:00:00.000Z");
  });
});
