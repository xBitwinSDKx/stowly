/**
 * Der Sensor für Home Assistant (docs/integrationen.md, 6; Protokoll 11.2) gegen den echten
 * Server: Was der echte Kern einlagert und auf die Einkaufsliste setzt, fasst `GET /api/ha/summary`
 * zusammen.
 *
 * `state`, `today`, `expired` und `total` rechnet der Test mit den Regeln des Vertrags in der App
 * nach (`expiryState`, `warnDaysFor`; web/src/contract/mhd.ts): die Probe, dass Python und
 * TypeScript dieselben Packungen gleich einstufen. Ebenso `next`, die Listen und den Satz. Den Tag
 * nimmt der Test aus `updated_at` der Antwort, in der Zeitzone des Servers; die wörtlichen
 * Erwartungen gelten nur, solange es der Tag ist, für den er die Daten angelegt hat.
 *
 * Dazu die Tokens: Ein Geräte-Token gilt hier nicht, der Sensor-Token nirgends sonst, und ohne
 * STOWLY_HA_SUMMARY_TOKEN antwortet der Endpunkt jedem mit 503.
 */
import { randomBytes } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  addDays,
  compareFifo,
  compareShoppingItems,
  daysBetween,
  expiryState,
  HA_SUMMARY_ENTRY_MAX,
  HA_SUMMARY_LIST_MAX,
  HA_SUMMARY_MESSAGE_MAX,
  isOpenItem,
  productTitle,
  shoppingItemTitle,
  shoppingQuantityLabel,
  warnDaysFor,
  type ErrorBody,
  type HaSummary,
  type Package,
  type Product,
  type ProductRef,
} from "@/contract";

import { dayIn } from "./support/calendar";
import { firstZone, freshBarcode } from "./support/data";
import { disposeDevices, signedIn, value, type Device } from "./support/device";
import { expectSameAsServer, RawClient } from "./support/raw";
import { sleep, startServer, type ServerHandle } from "./support/server";

/** Zeitzone des Servers: Sein „heute" beginnt neun Stunden nach dem in UTC. */
const TIMEZONE = "America/Los_Angeles";
/** Der Token des Sensors, für jeden Lauf neu (mindestens 32 Zeichen). */
const TOKEN = randomBytes(32).toString("hex");

/** Höchstens so viele Einträge je Liste, so viele Zeichen je Eintrag, so viele im Satz (Vertrag). */
const LIST_MAX = HA_SUMMARY_LIST_MAX;
const ENTRY_MAX = HA_SUMMARY_ENTRY_MAX;
const MESSAGE_MAX = HA_SUMMARY_MESSAGE_MAX;

let server: ServerHandle;

beforeAll(async () => {
  server = await startServer({ env: { STOWLY_HA_SUMMARY_TOKEN: TOKEN, STOWLY_TIMEZONE: TIMEZONE } });
});

afterAll(async () => {
  await server?.dispose();
});

afterEach(disposeDevices);

async function sensor(base: string = server.url, token: string | null = TOKEN): Promise<Response> {
  return fetch(`${base}/api/ha/summary`, { headers: token === null ? {} : { authorization: `Bearer ${token}` } });
}

async function summary(): Promise<HaSummary> {
  const response = await sensor();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return (await response.json()) as HaSummary;
}

/** "2026-11-16" -> "16.11." */
function dayMonth(day: string): string {
  return `${day.slice(8, 10)}.${day.slice(5, 7)}.`;
}

/** Vergleichsform eines Namens wie `str.casefold()` des Servers (für die Namen dieser Tests genau). */
function fold(name: string): string {
  return name.toUpperCase().toLowerCase();
}

interface Stocked {
  pkg: Package;
  product: Product | undefined;
  name: string;
}

/** Je Produkt und MHD eine Gruppe: nach MHD, dann Name, dann Kennung; die erste Packung nach FIFO. */
function groupsOf(packages: readonly Stocked[]): { first: Stocked; count: number }[] {
  const groups = new Map<string, Stocked[]>();
  for (const entry of packages) {
    const key = `${entry.pkg.product_id}|${entry.pkg.best_before ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups.values()]
    .map((group) => ({ first: [...group].sort((a, b) => compareFifo(a.pkg, b.pkg))[0] as Stocked, count: group.length }))
    .sort(
      (a, b) =>
        (a.first.pkg.best_before ?? "").localeCompare(b.first.pkg.best_before ?? "") ||
        (fold(a.first.name) < fold(b.first.name) ? -1 : fold(a.first.name) > fold(b.first.name) ? 1 : 0) ||
        (a.first.pkg.product_id < b.first.pkg.product_id ? -1 : 1),
    );
}

/** "2× Joghurt (16.11.)": je Gruppe ein Eintrag, höchstens fünf. */
function listOf(packages: readonly Stocked[]): string[] {
  return groupsOf(packages)
    .slice(0, LIST_MAX)
    .map(({ first, count }) => `${count > 1 ? `${count}× ` : ""}${first.name} (${dayMonth(first.pkg.best_before ?? "")})`);
}

/** „A", „A und B", „A, B und C", bei mehr „A, B, C und weitere". */
function namesOf(packages: readonly Stocked[]): string {
  const names = [...new Map(groupsOf(packages).map(({ first }) => [first.pkg.product_id, first.name])).values()];
  if (names.length > 3) {
    return `${names.slice(0, 3).join(", ")} und weitere`;
  }
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} und ${names.at(-1) ?? ""}`;
}

/**
 * Der Satz nach docs/integrationen.md 6.1. „TT.MM." endet schon mit einem Punkt: Der Server setzt
 * in „Bald …" keinen zweiten dahinter (die Vorlage im Vertrag schreibt `<TT.MM.>.`).
 */
function messageOf(today: readonly Stocked[], soon: readonly Stocked[], expired: number, shopping: number): string {
  const parts: string[] = [];
  if (today.length === 1) {
    parts.push(`Heute läuft 1 Packung ab: ${namesOf(today)}.`);
  } else if (today.length > 1) {
    parts.push(`Heute laufen ${today.length} Packungen ab: ${namesOf(today)}.`);
  } else if (soon.length > 0) {
    const first = [...soon].sort((a, b) => compareFifo(a.pkg, b.pkg))[0] as Stocked;
    const when = dayMonth(first.pkg.best_before ?? "");
    parts.push(soon.length === 1 ? `Bald läuft 1 Packung ab: ${first.name} am ${when}` : `Bald laufen ${soon.length} Packungen ab, als Nächstes ${first.name} am ${when}`);
  } else {
    parts.push("Nichts läuft bald ab.");
  }
  if (expired > 0) {
    parts.push(expired === 1 ? "1 Packung ist abgelaufen." : `${expired} Packungen sind abgelaufen.`);
  }
  if (shopping > 0) {
    parts.push(shopping === 1 ? "Auf der Einkaufsliste steht 1 Eintrag." : `Auf der Einkaufsliste stehen ${shopping} Einträge.`);
  }
  return parts.join(" ");
}

/**
 * Holt die Zusammenfassung und rechnet sie aus dem Bestand des Geräts nach, der nach dem Abgleich
 * genau der des Servers ist. Liefert die Antwort und den Tag, für den sie gilt.
 */
async function expectSummary(device: Device, raw: RawClient): Promise<{ body: HaSummary; today: string }> {
  await expectSameAsServer(device, raw);
  const body = await summary();
  const today = dayIn(TIMEZONE, body.updated_at);
  const data = device.core.data;
  const settings = value(data.settings);
  const products = new Map(value(data.products).map((product) => [product.id, product]));
  const zones = new Map(value(data.zones).map((zone) => [zone.id, zone]));
  const stocked: Stocked[] = value(data.packages).map((pkg) => {
    const product = products.get(pkg.product_id);
    return { pkg, product, name: productTitle(product) };
  });
  const stage = (entry: Stocked) => expiryState(entry.pkg.best_before, warnDaysFor(entry.product, settings), today);
  const soon = stocked.filter((entry) => stage(entry) === "soon");
  const expired = stocked.filter((entry) => stage(entry) === "expired");
  const dueToday = soon.filter((entry) => entry.pkg.best_before === today);
  const open = value(data.shoppingItems).filter(isOpenItem).sort(compareShoppingItems);

  // Die Probe: dieselben Stufen in Python und TypeScript.
  expect({ state: body.state, today: body.today, expired: body.expired, total: body.total }).toEqual({
    state: soon.length,
    today: dueToday.length,
    expired: expired.length,
    total: stocked.length,
  });

  // `next`: unter den Packungen ab heute die nach FIFO erste, gleich in welcher Stufe.
  const coming = stocked.filter((entry) => entry.pkg.best_before !== null && entry.pkg.best_before >= today).sort((a, b) => compareFifo(a.pkg, b.pkg));
  const first = coming[0];
  expect(body.next).toEqual(
    first
      ? {
          name: first.name,
          best_before: first.pkg.best_before,
          days: daysBetween(today, first.pkg.best_before ?? today),
          count: coming.filter((entry) => entry.pkg.product_id === first.pkg.product_id && entry.pkg.best_before === first.pkg.best_before).length,
          zone: zones.get(first.pkg.zone_id)?.name ?? "",
        }
      : null,
  );

  expect(body.shopping).toBe(open.length);
  expect(body.soon_list).toEqual(listOf(soon));
  expect(body.expired_list).toEqual(listOf(expired));
  expect(body.shopping_list).toEqual(
    open.slice(0, LIST_MAX).map((item) => {
      const label = shoppingQuantityLabel(item);
      const title = shoppingItemTitle(item, item.product_id === null ? undefined : products.get(item.product_id));
      return label === "" ? title : `${title} (${label})`;
    }),
  );
  expect(body.message).toBe(messageOf(dueToday, soon, expired.length, open.length));
  for (const entry of [...body.soon_list, ...body.expired_list, ...body.shopping_list]) {
    expect(entry.length).toBeLessThanOrEqual(ENTRY_MAX);
  }
  expect(body.message.length).toBeLessThanOrEqual(MESSAGE_MAX);
  return { body, today };
}

describe("Sensor", () => {
  it("stuft wie die App ein: heute, bald mit eigener Vorlaufzeit, später, abgelaufen, ohne MHD, dazu die Einkaufsliste", async () => {
    const kitchen = await signedIn(server.url, "Küche");
    const raw = await RawClient.login(server.url);
    const core = kitchen.core;
    const pantry = firstZone(kitchen);
    const fridge = await core.zones.create({ name: "Kühlschrank H" });
    // Der Tag des Servers, wie er ihn meldet; danach richten sich die MHD.
    const day = dayIn(TIMEZONE, (await summary()).updated_at);
    const store = async (product: ProductRef, zoneId: string, bestBefore: string | null, count = 1) =>
      core.stock.store({ product, zone_id: zoneId, best_before: bestBefore, count, labels: false });

    const yogurt = await store({ kind: "new", name: "Joghurt H" }, fridge.id, day, 2);
    // Eigene Vorlaufzeit 3 Tage: in 2 Tagen ist bald, in 5 Tagen noch nicht (beim Haushalt mit 14 wäre es bald).
    const milk = await core.products.create({ name: "Milch H", warn_days: 3 });
    const milkSoon = await store({ kind: "existing", product_id: milk.id }, fridge.id, addDays(day, 2));
    await store({ kind: "existing", product_id: milk.id }, fridge.id, addDays(day, 5));
    const barcode = freshBarcode();
    const placeholder = await store({ kind: "barcode", barcode }, fridge.id, addDays(day, 1));
    const rice = await store({ kind: "new", name: "Reis H" }, pantry.id, addDays(day, 100));
    await store({ kind: "new", name: "Quark H" }, fridge.id, addDays(day, -2));
    await store({ kind: "new", name: "Salz H" }, pantry.id, null);
    // Einkaufsliste: ein automatischer Eintrag (legt der Server an), ein eigener mit Menge, ein freier
    // Text; erledigte und gelöschte zählen nicht. Die Pausen geben jedem Eintrag seinen eigenen Zeitpunkt.
    await core.products.create({ name: "Butter H", min_stock: 2 });
    await sleep(5);
    await core.shopping.create({ product_id: rice.product.id, quantity: 2 });
    await sleep(5);
    await core.shopping.create({ text: "Grillkohle H" });
    const done = await core.shopping.create({ text: "Kerzen H" });
    await core.shopping.update(done.id, { done: true });
    const gone = await core.shopping.create({ text: "Alufolie H" });
    await core.shopping.remove(gone.id);
    await kitchen.sync();

    const first = await expectSummary(kitchen, raw);
    if (first.today === day) {
      expect(first.body).toMatchObject({ state: 4, today: 2, expired: 1, total: 8, shopping: 3 });
      expect(first.body.next).toEqual({ name: "Joghurt H", best_before: day, days: 0, count: 2, zone: "Kühlschrank H" });
      expect(first.body.soon_list).toEqual([`2× Joghurt H (${dayMonth(day)})`, `${barcode} (${dayMonth(addDays(day, 1))})`, `Milch H (${dayMonth(addDays(day, 2))})`]);
      expect(first.body.expired_list).toEqual([`Quark H (${dayMonth(addDays(day, -2))})`]);
      expect(first.body.shopping_list).toEqual(["Butter H (fehlt 2)", "Reis H (2×)", "Grillkohle H"]);
      expect(first.body.message).toBe("Heute laufen 2 Packungen ab: Joghurt H. 1 Packung ist abgelaufen. Auf der Einkaufsliste stehen 3 Einträge.");
    }

    // Was heute und bald abläuft, ist weg. Der Satz nennt das nächste bald fällige; `next` ist die
    // Milch in 5 Tagen davor, mit ihrer kurzen Vorlaufzeit noch nicht bald.
    await core.stock.remove([...yogurt.packages, ...placeholder.packages, ...milkSoon.packages].map((pkg) => pkg.id), "consumed");
    const honey = await store({ kind: "new", name: "Honig H" }, pantry.id, addDays(day, 10));
    await kitchen.sync();
    const second = await expectSummary(kitchen, raw);
    if (second.today === day) {
      expect(second.body).toMatchObject({ state: 1, today: 0, expired: 1, total: 5 });
      expect(second.body.next).toEqual({ name: "Milch H", best_before: addDays(day, 5), days: 5, count: 1, zone: "Kühlschrank H" });
      expect(second.body.message).toBe(`Bald läuft 1 Packung ab: Honig H am ${dayMonth(addDays(day, 10))} 1 Packung ist abgelaufen. Auf der Einkaufsliste stehen 3 Einträge.`);
    }

    // Nichts mehr bald, ein Eintrag weniger zweimal.
    await core.stock.remove(honey.packages.map((pkg) => pkg.id), "discarded");
    const open = value(core.data.shoppingItems).filter((item) => isOpenItem(item) && item.origin === "manual");
    for (const item of open) {
      await core.shopping.update(item.id, { done: true });
    }
    await kitchen.sync();
    const third = await expectSummary(kitchen, raw);
    if (third.today === day) {
      expect(third.body).toMatchObject({ state: 0, today: 0, expired: 1, shopping: 1, soon_list: [], shopping_list: ["Butter H (fehlt 2)"] });
      expect(third.body.message).toBe("Nichts läuft bald ab. 1 Packung ist abgelaufen. Auf der Einkaufsliste steht 1 Eintrag.");
    }
  });

  it("lässt nur den Token des Sensors herein, und den nur hier", async () => {
    const raw = await RawClient.login(server.url);
    const anonymous = await sensor(server.url, null);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect(((await anonymous.json()) as ErrorBody).error.code).toBe("unauthorized");
    // Ein Geräte-Token gilt hier nicht, ein fast richtiger Sensor-Token auch nicht.
    expect((await sensor(server.url, raw.token)).status).toBe(401);
    expect((await sensor(server.url, `${TOKEN}0`)).status).toBe(401);
    expect((await sensor(server.url, TOKEN.slice(0, -1))).status).toBe(401);
    expect((await sensor(server.url, TOKEN)).status).toBe(200);

    // Anderswo ist der Sensor-Token ein unbekanntes Geräte-Token.
    const elsewhere = async (method: string, path: string) =>
      (await fetch(`${server.url}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" })).status;
    expect(await elsewhere("GET", "/api/integrations")).toBe(401);
    expect(await elsewhere("GET", "/api/stats")).toBe(401);
    expect(await elsewhere("GET", "/api/devices")).toBe(401);
    expect(await elsewhere("POST", "/api/backup/run")).toBe(401);
    expect(await elsewhere("GET", "/api/restore")).toBe(401);
    // Auch nicht für die Einrichtung von HA: Der Sensor-Token liest dort nicht einmal sich selbst.
    expect(await elsewhere("GET", "/api/server-config/ha")).toBe(401);
    expect(await elsewhere("GET", "/api/server-config/ha/sensor-token")).toBe(401);
    expect(await elsewhere("POST", "/api/sync")).toBe(401);

    // Die App sieht, dass der Sensor eingerichtet ist, aber nie seinen Token.
    const kitchen = await signedIn(server.url, "Küche");
    const status = await kitchen.core.integrations.load();
    expect(status.ha).toMatchObject({ sensor: true, configured: false, state: "off" });
    expect(JSON.stringify(status)).not.toContain(TOKEN);
  });

  it("antwortet ohne STOWLY_HA_SUMMARY_TOKEN jedem mit 503", async () => {
    const plain = await startServer();
    try {
      const raw = await RawClient.login(plain.url);
      for (const token of [null, TOKEN, raw.token]) {
        const response = await sensor(plain.url, token);
        expect(response.status).toBe(503);
        expect(((await response.json()) as ErrorBody).error.code).toBe("not_configured");
      }
      const kitchen = await signedIn(plain.url, "Küche");
      expect((await kitchen.core.integrations.load()).ha.sensor).toBe(false);
    } finally {
      await disposeDevices();
      await plain.dispose();
    }
  });
});
