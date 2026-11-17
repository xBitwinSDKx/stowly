/**
 * KI-Vorschläge im Kern (src/core/ai.ts, nachgeladen) gegen die Nachbildung des Servers
 * (docs/plan-0.6.md, 3; docs/sync-protokoll.md, 11.13): Schlüssel, Modell und Prüfung, Aufträge
 * starten und auf sie warten, die Bremsen des Servers und die Form der Antworten.
 */
import { afterEach, describe, expect, it } from "vitest";

import { AI_DEVICE_GAP_S, COOK_WAIT_MS, CoreError, type CookIdeas, type CookJob } from "@/contract";

import type { SchedulerTimers } from "./sync/scheduler";
import { createCore } from ".";
import { createFakeNetwork, FAKE_AI_DAILY_MAX, FAKE_AI_KEY_LOST, FAKE_PASSWORD } from "./testing/fake-api";
import { createClock, disposeAll, expectCoreError, firstZoneId, signedIn, type Clock, type Harness } from "./testing/harness";

afterEach(disposeAll);

/** Ein Schlüssel in der richtigen Form; ausgedacht. */
const KEY = "sk-ant-api03-test-0123456789abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJ";

/**
 * Zeitgeber für die Pausen von `wait`: Sie merken sich die Wartezeit, stellen die Uhr des Tests um
 * genau so viel vor und laufen gleich danach. So dauert kein Test so lange wie seine Pausen.
 */
function fastTimers(clock: Clock): SchedulerTimers & { delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    set(callback, delayMs) {
      delays.push(delayMs);
      clock.advance(delayMs);
      return setTimeout(callback, 0);
    },
    clear(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
}

interface AiHarness extends Harness {
  timers: SchedulerTimers & { delays: number[] };
}

/** Ein angemeldeter Kern mit schnellen Pausen; auf Wunsch mit Schlüssel und einem Produkt im Bestand. */
async function setUp(options: { key?: boolean; stock?: boolean } = {}): Promise<AiHarness> {
  const clock = createClock();
  const timers = fastTimers(clock);
  const harness = await signedIn({ clock, core: { timers } });
  if (options.key !== false) {
    await harness.core.ai.update({ key: KEY });
  }
  if (options.stock !== false) {
    await harness.core.stock.store({ product: { kind: "new", name: "Barilla Spaghetti", brand: "Barilla" }, zone_id: firstZoneId(harness.core), best_before: null, count: 2 });
    await harness.core.stock.store({ product: { kind: "new", name: "Passierte Tomaten" }, zone_id: firstZoneId(harness.core), best_before: "2026-11-20", count: 1 });
    await harness.core.sync.now();
  }
  timers.delays.length = 0;
  return { ...harness, timers };
}

describe("Einrichtung", () => {
  it("speichert den Schlüssel geprüft und ohne Leerraum; keine Antwort enthält ihn", async () => {
    const { core, server, network } = await signedIn();
    expect(await core.ai.load()).toEqual({
      source: "default",
      key_set: false,
      key_set_at: null,
      model: "claude-opus-5-5",
      model_source: "default",
      configured: false,
      problem: null,
      used_today: 0,
      daily_limit: FAKE_AI_DAILY_MAX,
    });

    const saved = await core.ai.update({ key: `  ${KEY}\n` });
    expect(saved).toMatchObject({ source: "app", key_set: true, configured: true, problem: null });
    expect(saved.key_set_at).not.toBeNull();
    expect(server.aiKey).toBe(KEY);
    const sent = network.calls.filter((call) => call.path === "/api/server-config/ai");
    expect(sent.at(-1)?.body).toEqual({ key: KEY });
    expect(JSON.stringify(saved)).not.toContain(KEY);
    expect(JSON.stringify(await core.ai.load())).not.toContain(KEY);

    const model = await core.ai.update({ model: "claude-haiku-5-5" });
    expect(model).toMatchObject({ model: "claude-haiku-5-5", model_source: "app", key_set: true });
    expect(network.calls.at(-1)?.body).toEqual({ model: "claude-haiku-5-5" });

    expect(await core.ai.update({ key: null })).toMatchObject({ source: "default", key_set: false, configured: false });
    expect(server.aiKey).toBeNull();
  });

  it("lehnt einen Schlüssel in falscher Form ab, ohne ihn zu senden oder zu nennen", async () => {
    const { core, network } = await signedIn();
    const before = network.calls.length;
    for (const key of ["", "   ", "sk-ant-mit leerzeichen", "sk-ant-ümlaut", "abc-123", `sk-ant-${"x".repeat(300)}`, "sk-ant-admin01-geheim"]) {
      const error = await expectCoreError(core.ai.update({ key }), "invalid");
      expect(error.details.errors).toEqual([expect.objectContaining({ loc: ["body", "key"] })]);
      if (key.trim() !== "") {
        expect(error.message).not.toContain(key.trim());
      }
    }
    await expectCoreError(core.ai.check({ key: "sk-falsch" }), "invalid");
    expect(network.calls.length).toBe(before);
  });

  it("sperrt den Schlüssel aus der Umgebung; geprüft wird der von dort", async () => {
    const { core, server } = await signedIn();
    server.aiEnvKey = KEY;
    expect(await core.ai.load()).toMatchObject({ source: "env", key_set: true, key_set_at: null, configured: true });
    await expectCoreError(core.ai.update({ key: KEY }), "conflict");
    await expectCoreError(core.ai.update({ key: null }), "conflict");
    await expectCoreError(core.ai.check({ key: KEY }), "conflict");
    expect(await core.ai.check()).toMatchObject({ state: "ok", model: "claude-opus-5-5" });
    // Das Modell bleibt wählbar.
    expect(await core.ai.update({ model: "claude-sonnet-5-5" })).toMatchObject({ source: "env", model: "claude-sonnet-5-5" });
  });

  it("meldet einen Schlüssel, der nach dem Zurückspielen fehlt", async () => {
    const { core, server } = await signedIn();
    await core.ai.update({ key: KEY });
    server.loseAiKey();
    expect(await core.ai.load()).toMatchObject({ source: "app", key_set: false, key_set_at: null, configured: false, problem: FAKE_AI_KEY_LOST });
  });
});

describe("Prüfen", () => {
  it("prüft den eingegebenen oder den gespeicherten Schlüssel, mit drei Sekunden Abstand; was Anthropic sagt, steht im Ergebnis", async () => {
    const { core, server, clock } = await signedIn();
    await expectCoreError(core.ai.check(), "not_configured");
    expect(await core.ai.check({ key: ` ${KEY} `, model: "claude-sonnet-5-5" })).toEqual({ state: "ok", message: "Schlüssel und Modell passen.", model: "claude-sonnet-5-5" });
    expect(server.aiChecks).toEqual([{ key: true, model: "claude-sonnet-5-5" }]);
    // Geprüft heißt nicht gespeichert.
    expect((await core.ai.load()).configured).toBe(false);

    const limited = await expectCoreError(core.ai.check({ key: KEY }), "rate_limited");
    expect(limited.details.retry_after_s).toBe(3);

    clock.advance(3_000);
    server.aiCheckState = "key_rejected";
    expect(await core.ai.check({ key: KEY })).toMatchObject({ state: "key_rejected", message: "Anthropic lehnt den API-Schlüssel ab." });
  });
});

describe("Aufträge", () => {
  it("startet mit Wunsch und Zutaten, wartet nach 1, 2 und dann alle 3 Sekunden und liefert die Vorschläge", async () => {
    const { core, server, timers } = await setUp();
    server.cookRunningPolls = 3;
    const products = new Map((core.data.products.get() ?? []).map((product) => [product.name, product.id]));
    const spaghetti = products.get("Barilla Spaghetti") ?? "";

    expect(await core.ai.lastJob()).toBeNull();
    const started = await core.ai.start({ wish: "  vegetarisch, schnell  ", focus: [spaghetti, spaghetti] });
    expect(started).toMatchObject({ state: "running", finished_at: null, result: null, problem: null, used_today: 1, daily_limit: FAKE_AI_DAILY_MAX });
    expect(started.id).toMatch(/^[0-9a-f]{32}$/);
    expect(server.cookStarts).toEqual([{ device_id: expect.any(String), wish: "vegetarisch, schnell", focus: [spaghetti] }]);
    expect(await core.ai.lastJob()).toBe(started.id);

    const ticks: CookJob[] = [];
    const done = await core.ai.wait(started.id, { onTick: (job) => ticks.push(job) });
    expect(timers.delays).toEqual([1_000, 2_000, 3_000, 3_000]);
    expect(ticks.map((job) => job.state)).toEqual(["running", "running", "running"]);
    expect(done.state).toBe("done");
    expect(done.finished_at).not.toBeNull();
    const result = done.result as CookIdeas;
    expect(result).toMatchObject({ model: "claude-opus-5-5", fallback: false, stock_count: 2, truncated: false });
    // Die gewählte Zutat steht vorn, mit dem Namen aus Stowly.
    expect(result.ideas[0]?.uses[0]).toEqual({ product_id: spaghetti, name: "Barilla Spaghetti" });

    // Schon fertig: `wait` fragt einmal und liefert ihn.
    expect(await core.ai.wait(started.id)).toEqual(done);
    expect(await core.ai.job(started.id)).toEqual(done);
  });

  it("prüft die Eingabe vorab wie der Server", async () => {
    const { core, network } = await setUp();
    const before = network.calls.length;
    await expectCoreError(core.ai.start({ wish: "x".repeat(201) }), "invalid");
    const ids = Array.from({ length: 6 }, (_, index) => `00000000-0000-4000-8000-00000000000${String(index)}`);
    await expectCoreError(core.ai.start({ focus: ids }), "invalid");
    await expectCoreError(core.ai.start({ focus: ["kein-produkt"] }), "invalid");
    await expectCoreError(core.ai.job("../../api/sync"), "not_found");
    await expectCoreError(core.ai.wait("kein-auftrag"), "not_found");
    expect(network.calls.length).toBe(before);
    // 200 Zeichen nach dem Kürzen sind erlaubt.
    expect((await core.ai.start({ wish: ` ${"x".repeat(200)} ` })).state).toBe("running");
  });

  it("sagt ohne Schlüssel und ohne Bestand, warum es nicht geht", async () => {
    const empty = await setUp({ stock: false });
    expect((await expectCoreError(empty.core.ai.start({}), "conflict")).details.status).toBe(409);

    const missing = await setUp({ key: false });
    expect((await expectCoreError(missing.core.ai.start({}), "not_configured")).details.reason).toBe("missing");
    await missing.core.ai.update({ key: KEY });
    missing.server.loseAiKey();
    expect((await expectCoreError(missing.core.ai.start({}), "not_configured")).details.reason).toBe("lost");
  });

  it("bremst wie der Server: ein Auftrag zugleich, 30 Sekunden je Gerät, 20 am Tag", async () => {
    const { core, server, clock } = await setUp();
    server.cookRunningPolls = 1;
    const first = await core.ai.start({});
    const busy = await expectCoreError(core.ai.start({}), "rate_limited");
    expect(busy.details).toMatchObject({ reason: "busy", status: 429 });
    expect(busy.details.retry_after_s).toBeGreaterThan(0);

    await core.ai.wait(first.id);
    const soon = await expectCoreError(core.ai.start({}), "rate_limited");
    expect(soon.details.reason).toBe("too_soon");
    expect(soon.details.retry_after_s).toBeLessThanOrEqual(AI_DEVICE_GAP_S);

    // Ein ganzer Tag voll: die nächste Anfrage erst morgen.
    server.cookRunningPolls = 0;
    for (let count = (await core.ai.load()).used_today; count < FAKE_AI_DAILY_MAX; count += 1) {
      clock.advance(AI_DEVICE_GAP_S * 1000);
      await core.ai.wait((await core.ai.start({})).id);
    }
    expect((await core.ai.load()).used_today).toBe(FAKE_AI_DAILY_MAX);
    clock.advance(AI_DEVICE_GAP_S * 1000);
    const limit = await expectCoreError(core.ai.start({}), "rate_limited");
    expect(limit.details.reason).toBe("daily_limit");
    expect(limit.details.retry_after_s).toBeGreaterThan(0);
    expect(limit.details.retry_after_s).toBeLessThanOrEqual(24 * 3600);

    // Am nächsten Tag geht es wieder.
    clock.advance((limit.details.retry_after_s as number) * 1000 + 60_000);
    expect((await core.ai.load()).used_today).toBe(0);
    expect((await core.ai.start({})).used_today).toBe(1);
  });

  it("meldet Fehler von Anthropic im Auftrag und zählt, was nicht berechnet wurde, nicht", async () => {
    const { core, server, clock } = await setUp();
    server.cookProblem = { reason: "busy", message: "Anthropic bremst gerade.", retry_after_s: 20, category: null };
    const busy = await core.ai.wait((await core.ai.start({})).id);
    expect(busy).toMatchObject({ state: "failed", result: null, problem: { reason: "busy", retry_after_s: 20 }, used_today: 0 });

    clock.advance(AI_DEVICE_GAP_S * 1000);
    server.cookProblem = { reason: "refused", message: "Claude lehnt ab.", retry_after_s: null, category: "cyber" };
    const refused = await core.ai.wait((await core.ai.start({})).id);
    expect(refused).toMatchObject({ state: "failed", problem: { reason: "refused", category: "cyber" }, used_today: 1 });
  });

  it("gibt nach der Frist auf und meldet den Auftrag dann wie der Server: gescheitert mit timeout", async () => {
    const { core, server, timers } = await setUp();
    server.cookRunningPolls = 1_000;
    const started = await core.ai.start({});
    const job = await core.ai.wait(started.id);
    expect(job).toMatchObject({ id: started.id, state: "failed", result: null, problem: { reason: "timeout", retry_after_s: null, category: null } });
    expect(timers.delays.reduce((sum, delay) => sum + delay, 0)).toBeGreaterThanOrEqual(COOK_WAIT_MS);
    expect(timers.delays.length).toBeLessThan(50);
  });

  it("wartet über einen kurzen Ausfall hinweg und lässt sich abbrechen", async () => {
    const { core, server, network, clock } = await setUp();
    server.cookRunningPolls = 2;
    const started = await core.ai.start({});
    // Die Antwort auf die erste Abfrage geht verloren: Das Warten geht weiter.
    let polls = 0;
    network.dropWhen = (call) => call.path.startsWith("/api/cook/ideas/") && (polls += 1) === 1;
    expect((await core.ai.wait(started.id)).state).toBe("done");
    expect(polls).toBe(3);
    network.dropWhen = null;

    // Abbrechen beendet nur das Warten; der Auftrag läuft am Server weiter.
    clock.advance(AI_DEVICE_GAP_S * 1000);
    server.cookRunningPolls = 1_000;
    const running = await core.ai.start({});
    const controller = new AbortController();
    const reason = new Error("Seite verlassen");
    await expect(core.ai.wait(running.id, { signal: controller.signal, onTick: () => controller.abort(reason) })).rejects.toBe(reason);
    expect((await core.ai.job(running.id)).state).toBe("running");
    const aborted = new AbortController();
    aborted.abort(reason);
    await expect(core.ai.wait(running.id, { signal: aborted.signal })).rejects.toBe(reason);
  });

  it("bricht das Warten ab, wenn der Auftrag weg ist, statt bis zur Frist zu fragen", async () => {
    const { core, server, timers } = await setUp();
    server.cookRunningPolls = 1_000;
    const started = await core.ai.start({});
    const waiting = core.ai.wait(started.id, { onTick: () => server.expireCookJobs() });
    await expect(waiting).rejects.toBeInstanceOf(CoreError);
    await expectCoreError(core.ai.wait(started.id), "not_found");
    expect(timers.delays.length).toBeLessThan(5);
  });

  it("findet Aufträge anderer Geräte nicht, abgelaufene auch nicht", async () => {
    const { core, server, clock } = await setUp();
    const started = await core.ai.start({});
    const network = createFakeNetwork(server);
    const other = createCore({ fetch: network.fetch, now: clock.now, dbName: `stowly-ai-other-${String(Date.now())}`, autoSync: false });
    try {
      await other.ready;
      await other.session.login(FAKE_PASSWORD, "Zweites Gerät");
      await expectCoreError(other.ai.job(started.id), "not_found");
      await expectCoreError(other.ai.wait(started.id), "not_found");
    } finally {
      other.dispose();
    }
    server.expireCookJobs();
    await expectCoreError(core.ai.job(started.id), "not_found");
  });

  it("hält eine Antwort, die nicht vom Stowly-Server stammt, für „nicht erreichbar“", async () => {
    const { core, network } = await setUp();
    network.respondWith = (call) =>
      call.path === "/api/server-config/ai" ? new Response(JSON.stringify({ source: "env", key: KEY }), { status: 200, headers: { "content-type": "application/json" } }) : null;
    await expectCoreError(core.ai.load(), "offline");
    network.respondWith = (call) => (call.path === "/api/cook/ideas" ? new Response(JSON.stringify({ id: "x", state: "running" }), { status: 202 }) : null);
    await expectCoreError(core.ai.start({}), "offline");
    network.respondWith = null;
  });
});
