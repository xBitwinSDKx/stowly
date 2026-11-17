/**
 * Was koche ich? Vorschläge von Claude mit dem echten Kern gegen den echten Server und eine
 * nachgebildete Anthropic-API unter 127.0.0.1 (support/anthropic.ts; docs/plan-0.6.md, 2 und 3):
 *
 * - Schlüssel eintragen und prüfen (fragt nur das Modell ab, kostet keine Tokens), Vorschläge holen: Der
 *   Prompt trägt die Vorratsliste mit Schlüsseln, den Wunsch und die gewählte Zutat; die Antwort nennt die
 *   Produkte mit ihren Namen aus Stowly. Nicht im Prompt: Zonen, Barcodes, Packungs-IDs.
 * - Fehlendes auf die Einkaufsliste; ein zweites Gerät sieht es, den Auftrag des ersten aber nicht.
 * - 401, eine Ablehnung und 429 von Anthropic stehen im fertigen Auftrag, nicht als Fehler; gezählt wird
 *   nur, was Anthropic berechnet hat.
 * - Der Tageszähler übersteht einen Neustart des Servers.
 * - Der Schlüssel steht nie in einer Antwort und nie in der Ausgabe des Servers, auch mit DEBUG.
 *
 * Jeder Start kommt von einem eigenen Gerät: Ein Gerät darf nur alle 30 Sekunden fragen.
 */
import { afterEach, describe, expect, it } from "vitest";

import { isOpenItem, type CookJob, type Product } from "@/contract";

import { FakeAnthropic } from "./support/anthropic";
import { freshBarcode } from "./support/data";
import { disposeDevices, expectCoreError, signedIn, value, type Device } from "./support/device";
import { RawClient } from "./support/raw";
import { sleep, startServer, type ServerHandle, type ServerOptions } from "./support/server";

const servers: ServerHandle[] = [];
const fakes: FakeAnthropic[] = [];

/** Zwischen dem Beginn zweier Prüfungen liegen beim Server mindestens drei Sekunden. */
const CHECK_GAP_MS = 3_100;

async function anthropic(): Promise<FakeAnthropic> {
  const fake = new FakeAnthropic();
  await fake.start();
  fakes.push(fake);
  return fake;
}

/** Ein Server, der statt api.anthropic.com die Nachbildung fragt (nur mit `--dev` erlaubt). */
async function server(fake: FakeAnthropic, options: ServerOptions = {}): Promise<ServerHandle> {
  const handle = await startServer({ ...options, env: { STOWLY_ANTHROPIC_BASE_URL: fake.url, ...options.env } });
  servers.push(handle);
  return handle;
}

afterEach(async () => {
  await disposeDevices();
  for (const handle of servers.splice(0)) {
    await handle.dispose();
  }
  for (const fake of fakes.splice(0)) {
    await fake.close();
  }
});

/** Ein Tag als "YYYY-MM-DD", `days` ab heute (Zeit dieses Rechners; für ein MHD genügt das). */
function inDays(days: number): string {
  const day = new Date(Date.now() + days * 86_400_000);
  return `${String(day.getFullYear())}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

/** Lagert ein neues Produkt ein und gleicht ab; liefert das Produkt und die Kennungen der Packungen. */
async function stock(device: Device, zoneId: string, name: string, extra: { brand?: string; quantity?: string; barcodes?: string[]; days?: number | null; count?: number } = {}) {
  const stored = await device.core.stock.store({
    product: { kind: "new", name, brand: extra.brand, quantity: extra.quantity, barcodes: extra.barcodes },
    zone_id: zoneId,
    best_before: extra.days === null || extra.days === undefined ? null : inDays(extra.days),
    count: extra.count ?? 1,
  });
  await device.sync();
  return { product: stored.product, packages: stored.packages.map((pkg) => pkg.id) };
}

/** Startet einen Auftrag und wartet auf sein Ende. */
async function ask(device: Device, input: Parameters<Device["core"]["ai"]["start"]>[0] = {}): Promise<{ started: CookJob; done: CookJob }> {
  const started = await device.core.ai.start(input);
  const done = await device.core.ai.wait(started.id);
  return { started, done };
}

describe("Vorschläge von Claude", () => {
  it("trägt den Schlüssel ein, prüft ihn, holt Vorschläge und setzt Fehlendes auf die Liste", { timeout: 120_000 }, async () => {
    const fake = await anthropic();
    const handle = await server(fake, { env: { STOWLY_LOG_LEVEL: "debug" } });
    const kitchen = await signedIn(handle.url, "Küche");
    const cellar = await signedIn(handle.url, "Keller");
    const answers: unknown[] = [];

    expect(await kitchen.core.ai.load()).toMatchObject({ source: "default", key_set: false, configured: false, used_today: 0, daily_limit: 20, problem: null });
    const zone = await kitchen.core.zones.create({ name: "Speisekammer E-KI" });
    await kitchen.sync();
    const barcode = freshBarcode();
    const spaghetti = await stock(kitchen, zone.id, "Spaghetti E-KI", { brand: "Pastaria", quantity: "500 g", barcodes: [barcode], days: 200, count: 2 });
    const tomatoes = await stock(kitchen, zone.id, "Passierte Tomaten E-KI", { days: 3 });
    const old = await stock(kitchen, zone.id, "Haferflocken E-KI", { days: -2 });

    // Ohne Schlüssel: 503 mit Grund.
    expect((await expectCoreError(kitchen.core.ai.start({}), "not_configured")).details).toMatchObject({ status: 503, reason: "missing" });

    // Prüfen vor dem Speichern, mit dem eingegebenen Schlüssel; ein falscher ist kein Fehler des Aufrufs.
    const checked = await kitchen.core.ai.check({ key: fake.key });
    expect(checked).toMatchObject({ state: "ok", model: "claude-opus-5-5" });
    answers.push(checked);
    expect((await expectCoreError(kitchen.core.ai.check({ key: fake.key }), "rate_limited")).details.retry_after_s).toBeGreaterThan(0);
    await sleep(CHECK_GAP_MS);
    expect(await kitchen.core.ai.check({ key: "sk-ant-api03-gibt-es-nicht-0123456789" })).toMatchObject({ state: "key_rejected" });
    expect((await kitchen.core.ai.load()).configured).toBe(false);
    await expectCoreError(kitchen.core.ai.update({ key: "sk-ant-admin01-0123456789" }), "invalid");

    const saved = await kitchen.core.ai.update({ key: ` ${fake.key} ` });
    expect(saved).toMatchObject({ source: "app", key_set: true, configured: true, model: "claude-opus-5-5", model_source: "default" });
    expect(saved.key_set_at).not.toBeNull();
    answers.push(saved);
    await sleep(CHECK_GAP_MS);
    const stored = await kitchen.core.ai.check();
    expect(stored).toMatchObject({ state: "ok" });
    answers.push(stored);
    // Die Prüfungen fragten nur das Modell ab: keine Tokens.
    expect(fake.calls("/v1/messages")).toHaveLength(0);
    expect(fake.calls("/v1/models/claude-opus-5-5").length).toBe(3);

    // Vorschläge: Wunsch und gewählte Zutat gehen mit, die Antwort nennt die Produkte mit den Namen aus Stowly.
    const { started, done } = await ask(kitchen, { wish: "vegetarisch, für 2", focus: [tomatoes.product.id] });
    expect(started).toMatchObject({ state: "running", used_today: 1, daily_limit: 20 });
    expect(done.state).toBe("done");
    answers.push(started, done);
    expect(await kitchen.core.ai.lastJob()).toBe(started.id);

    const prompt = fake.lastPrompt();
    const keyOf = (product: Product) => prompt.stock.find((entry) => entry.name === product.name)?.k;
    expect(prompt.stock.map((entry) => entry.name)).toEqual(expect.arrayContaining(["Spaghetti E-KI", "Passierte Tomaten E-KI", "Haferflocken E-KI"]));
    expect(prompt.stock.find((entry) => entry.name === "Spaghetti E-KI")).toMatchObject({ brand: "Pastaria", size: "500 g", count: 2, state: "ok" });
    // Abgelaufenes und bald Fälliges zuerst.
    expect(prompt.stock.slice(0, 2).map((entry) => entry.name).sort()).toEqual(["Haferflocken E-KI", "Passierte Tomaten E-KI"]);
    expect(prompt.focus).toEqual([keyOf(tomatoes.product)]);
    expect(prompt.wish).toBe("vegetarisch, für 2");
    const sent = JSON.stringify(fake.calls("/v1/messages")[0]?.body);
    expect(sent).not.toContain("Speisekammer");
    expect(sent).not.toContain(barcode);
    for (const id of [...spaghetti.packages, ...tomatoes.packages, ...old.packages, tomatoes.product.id]) {
      expect(sent).not.toContain(id);
    }
    // Ein Aufruf ohne Sampling-Parameter und ohne Tools, mit fester Ausgabe.
    const body = fake.calls("/v1/messages")[0]?.body ?? {};
    expect(body).toMatchObject({ model: "claude-opus-5-5", max_tokens: 8000, output_config: { effort: "low", format: { type: "json_schema" } } });
    for (const field of ["temperature", "top_p", "top_k", "tools", "tool_choice"]) {
      expect(body).not.toHaveProperty(field);
    }

    const result = done.result;
    expect(result).toMatchObject({ model: "claude-opus-5-5", fallback: false, stock_count: 3, truncated: false });
    expect(result?.ideas).toHaveLength(3);
    const first = result?.ideas[0];
    // Die gewählte Zutat vorn; der Schlüssel P999 gibt es nicht und fällt weg; Nummern vor Schritten auch.
    expect(first?.uses[0]).toEqual({ product_id: tomatoes.product.id, name: "Passierte Tomaten E-KI" });
    expect(first?.uses.every((use) => [spaghetti.product.id, tomatoes.product.id, old.product.id].includes(use.product_id))).toBe(true);
    expect(first?.steps).toEqual(["Vorbereiten.", "Kochen.", "Abschmecken."]);
    expect(first?.missing).toEqual(["Zwiebel", "Knoblauch"]);

    // Fehlendes auf die Einkaufsliste: Das zweite Gerät sieht es mit dem nächsten Abgleich.
    for (const text of first?.missing ?? []) {
      await kitchen.core.shopping.create({ text });
    }
    await kitchen.sync();
    await cellar.sync();
    const texts = value(cellar.core.data.shoppingItems)
      .filter(isOpenItem)
      .map((item) => item.text);
    expect(texts).toEqual(expect.arrayContaining(["Zwiebel", "Knoblauch"]));

    // Der Auftrag gehört dem Gerät, das ihn startete.
    await expectCoreError(cellar.core.ai.job(started.id), "not_found");
    expect(await kitchen.core.ai.job(started.id)).toMatchObject({ id: started.id, state: "done" });

    // Der Schlüssel: bei Anthropic angekommen, sonst nirgends, auch nicht im Log mit DEBUG.
    expect(fake.requests.filter((request) => request.path === "/v1/messages").every((request) => request.authorized)).toBe(true);
    answers.push(await kitchen.core.ai.load(), await cellar.core.ai.load());
    for (const answer of answers) {
      expect(JSON.stringify(answer)).not.toContain(fake.key);
    }
    const raw = await RawClient.login(handle.url, "Prüfer");
    for (const path of ["/api/server-config/ai", `/api/cook/ideas/${started.id}`]) {
      const response = await raw.request("GET", path);
      expect(response.headers.get("cache-control"), path).toBe("no-store");
      expect(await response.text(), path).not.toContain(fake.key);
    }
    expect(handle.output()).not.toContain(fake.key);
  });

  it("meldet 401, eine Ablehnung und 429 im fertigen Auftrag und zählt nur, was Anthropic berechnet hat", { timeout: 120_000 }, async () => {
    const fake = await anthropic();
    const handle = await server(fake);
    const devices = [await signedIn(handle.url, "Gerät A"), await signedIn(handle.url, "Gerät B"), await signedIn(handle.url, "Gerät C"), await signedIn(handle.url, "Gerät D")];
    const [a, b, c, d] = devices as [Device, Device, Device, Device];
    const zone = value(a.core.data.zones)[0]?.id ?? "";
    await stock(a, zone, "Linsen E-KI", { days: 5 });
    await a.core.ai.update({ key: fake.key });

    // Anthropic lehnt den Schlüssel ab: ein Fehler im Auftrag; nichts berechnet, nichts gezählt.
    fake.failure = { status: 401, type: "authentication_error", message: "invalid x-api-key" };
    const rejected = await ask(a);
    expect(rejected.started.used_today).toBe(1);
    expect(rejected.done).toMatchObject({ state: "failed", result: null, problem: { reason: "key_rejected" }, used_today: 0 });

    // Claude lehnt ab: berechnet, also gezählt; die Kategorie steht dabei.
    fake.failure = { refusal: "cyber" };
    const refused = await ask(b);
    expect(refused.done).toMatchObject({ state: "failed", problem: { reason: "refused", category: "cyber" }, used_today: 1 });

    // Anthropic bremst: mit der Wartezeit von dort, nicht gezählt.
    fake.failure = { status: 429, type: "rate_limit_error", message: "Number of request tokens has exceeded your per-minute rate limit", retryAfter: 17 };
    const busy = await ask(c);
    expect(busy.done).toMatchObject({ state: "failed", problem: { reason: "busy", retry_after_s: 17 }, used_today: 1 });

    // Kein Guthaben: in die Einstellungen.
    fake.failure = { status: 402, type: "billing_error", message: "Your credit balance is too low." };
    const billing = await ask(d);
    expect(billing.done).toMatchObject({ state: "failed", problem: { reason: "billing" }, used_today: 1 });

    // Dasselbe Gerät gleich noch einmal: zu früh (ohne zu zählen).
    fake.failure = null;
    const soon = await expectCoreError(a.core.ai.start({}), "rate_limited");
    expect(soon.details).toMatchObject({ reason: "too_soon", status: 429 });
    expect((await a.core.ai.load()).used_today).toBe(1);
    expect(handle.output()).not.toContain(fake.key);
  });

  it("behält den Tageszähler und den Schlüssel über einen Neustart; Aufträge sind danach weg", { timeout: 120_000 }, async () => {
    const fake = await anthropic();
    const handle = await server(fake);
    const kitchen = await signedIn(handle.url, "Küche");
    const zone = value(kitchen.core.data.zones)[0]?.id ?? "";
    await stock(kitchen, zone, "Reis E-KI", { days: null });
    await kitchen.core.ai.update({ key: fake.key, model: "claude-haiku-5-5" });
    const { started, done } = await ask(kitchen);
    expect(done).toMatchObject({ state: "done", used_today: 1 });
    // Haiku fragt ohne Ersatzmodell; das gewählte Modell gilt.
    expect(fake.calls("/v1/messages").at(-1)?.body).toMatchObject({ model: "claude-haiku-5-5" });
    expect(done.result?.model).toBe("claude-haiku-5-5");

    await handle.stop();
    await handle.start();
    expect(await kitchen.core.ai.load()).toMatchObject({ configured: true, source: "app", model: "claude-haiku-5-5", used_today: 1 });
    await expectCoreError(kitchen.core.ai.job(started.id), "not_found");
    // Nach dem Neustart kennt der Server den Abstand je Gerät nicht mehr; gezählt wird weiter.
    const again = await ask(kitchen);
    expect(again.done).toMatchObject({ state: "done", used_today: 2 });
    expect(handle.output()).not.toContain(fake.key);
  });

  it("sperrt einen Schlüssel aus der Umgebung und nimmt ihn trotzdem", { timeout: 90_000 }, async () => {
    const fake = await anthropic();
    const handle = await server(fake, { env: { STOWLY_ANTHROPIC_API_KEY: fake.key } });
    const kitchen = await signedIn(handle.url, "Küche");
    expect(await kitchen.core.ai.load()).toMatchObject({ source: "env", key_set: true, key_set_at: null, configured: true });
    await expectCoreError(kitchen.core.ai.update({ key: null }), "conflict");
    await expectCoreError(kitchen.core.ai.check({ key: fake.key }), "conflict");
    expect(await kitchen.core.ai.check()).toMatchObject({ state: "ok" });
    const zone = value(kitchen.core.data.zones)[0]?.id ?? "";
    await stock(kitchen, zone, "Nudeln E-KI", { days: 1 });
    expect((await ask(kitchen)).done.state).toBe("done");
    expect(handle.output()).not.toContain(fake.key);
  });
});
