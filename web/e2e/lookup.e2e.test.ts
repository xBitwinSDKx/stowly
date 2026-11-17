/**
 * Platzhalter füllen sich: der Weg von einem gescannten Barcode über den Hintergrund-Ablauf
 * des Servers bis zum Namen auf dem Gerät (docs/sync-protokoll.md, Abschnitt 10).
 *
 * Open Food Facts selbst wird nie angesprochen: Der Server fragt einen Ersatz unter
 * 127.0.0.1, den dieser Test stellt (STOWLY_OFF_URL). Ob der echte Dienst so antwortet wie
 * der Ersatz, zeigt dieser Test deshalb nicht. Bilder holt der Server nur über https von
 * openfoodfacts.org; mit dem Ersatz bleibt `image` leer. Für das Setzen eines Produktbilds (seit
 * 0.5.0) legt der Test deshalb ein Bild selbst in die Datenbank des Servers, wie es das Nachschlagen täte.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { gtinCheckDigit, type Product } from "@/contract";

import { firstZone, freshBarcode } from "./support/data";
import { disposeDevices, expectCoreError, signedIn, value, type Device } from "./support/device";
import { expectSameAsServer, RawClient } from "./support/raw";
import { pythonPath, startServer, type ServerHandle } from "./support/server";

interface Lookup {
  path: string;
  userAgent: string;
}

let off: Server;
let offUrl = "";
const lookups: Lookup[] = [];
/** Was der Ersatz kennt: Barcode -> Produkt, wie es Open Food Facts unter `product` liefert. */
const known = new Map<string, Record<string, unknown>>();
let server: ServerHandle;

beforeAll(async () => {
  off = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    lookups.push({ path: url.pathname + url.search, userAgent: String(request.headers["user-agent"] ?? "") });
    const barcode = /^\/api\/v3\/product\/([0-9]+)$/.exec(url.pathname)?.[1];
    const product = barcode ? known.get(barcode) : undefined;
    response.setHeader("content-type", "application/json");
    if (product) {
      response.end(JSON.stringify({ code: barcode, product, status: "success" }));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ code: barcode, result: { id: "product_not_found" }, status: "failure" }));
    }
  });
  await new Promise<void>((resolve) => off.listen(0, "127.0.0.1", resolve));
  offUrl = `http://127.0.0.1:${(off.address() as AddressInfo).port}`;
  server = await startServer({ env: { STOWLY_OFF_ENABLED: "1", STOWLY_OFF_URL: offUrl } });
});

afterAll(async () => {
  await server?.dispose();
  await new Promise((resolve) => off.close(resolve));
});

afterEach(disposeDevices);

function product(device: Device, id: string): Product {
  const found = value(device.core.data.products).find((candidate) => candidate.id === id);
  if (!found) {
    throw new Error(`${device.name} kennt das Produkt ${id} nicht.`);
  }
  return found;
}

/** Gleicht ab, bis das Produkt nicht mehr wartet (der Server schlägt im Hintergrund nach). */
async function untilSettled(device: Device, id: string): Promise<Product> {
  await expect
    .poll(
      async () => {
        await device.sync();
        return product(device, id).lookup;
      },
      { timeout: 20_000, interval: 200 },
    )
    .not.toBe("pending");
  return product(device, id);
}

it("füllt Platzhalter aus dem Ergebnis, lässt Eingaben des Anwenders stehen und fragt jeden Barcode nur einmal", async () => {
  const device = await signedIn(server.url, "Küche");
  const other = await signedIn(server.url, "Keller");
  const raw = await RawClient.login(server.url);
  const zone = firstZone(device);

  const [oat, named, unknown] = [freshBarcode(), freshBarcode(), freshBarcode()] as [string, string, string];
  const internalBody = `21${String(process.pid % 100_000).padStart(5, "0")}00001`;
  const internal = internalBody + String(gtinCheckDigit(internalBody));
  known.set(oat, { product_name_de: "Bio Haferdrink", product_name: "Oat drink", brands: "Hofgut, Andere Marke", quantity: "1 l", image_front_small_url: `${offUrl}/bild.jpg` });
  known.set(named, { product_name: "Fremder Name", brands: "Mühle", quantity: "500 g" });

  // Gescannt: sofort ein Platzhalter, der auf das Nachschlagen wartet.
  const placeholder = await device.core.stock.store({ product: { kind: "barcode", barcode: oat }, zone_id: zone.id, best_before: null, count: 1, labels: false });
  expect(placeholder.product).toMatchObject({ name: "", lookup: "pending" });
  // Von Hand benannt: Der Name des Anwenders bleibt, die leeren Felder füllen sich.
  const own = await device.core.products.create({ name: "Mein Mehl", barcodes: [named] });
  // Open Food Facts kennt den Barcode nicht.
  const missing = await device.core.stock.store({ product: { kind: "barcode", barcode: unknown }, zone_id: zone.id, best_before: null, count: 1, labels: false });
  // Ladenintern (Präfix 2): wird nie nachgeschlagen.
  const local = await device.core.stock.store({ product: { kind: "barcode", barcode: internal }, zone_id: zone.id, best_before: null, count: 1, labels: false });
  expect(local.product.lookup).toBe("none");

  expect(await untilSettled(device, placeholder.product.id)).toMatchObject({ name: "Bio Haferdrink", brand: "Hofgut", quantity: "1 l", lookup: "found", image: null, barcodes: [oat] });
  expect(await untilSettled(device, own.id)).toMatchObject({ name: "Mein Mehl", brand: "Mühle", quantity: "500 g", lookup: "found" });
  expect(await untilSettled(device, missing.product.id)).toMatchObject({ name: "", lookup: "not_found" });
  expect(product(device, local.product.id)).toMatchObject({ name: "", lookup: "none" });
  await expectSameAsServer(device, raw);

  // Das andere Gerät bekommt die gefüllten Produkte mit seinem nächsten Abgleich.
  await other.sync();
  expect(product(other, placeholder.product.id).name).toBe("Bio Haferdrink");
  await expectSameAsServer(other, raw);

  // Der Ersatz wurde je Barcode genau einmal gefragt, nie nach dem ladeninternen Code und nie nach einem Bild.
  const asked = lookups.map((lookup) => lookup.path.split("?")[0]);
  expect([...asked].sort()).toEqual([oat, named, unknown].map((barcode) => `/api/v3/product/${barcode}`).sort());
  expect(lookups.every((lookup) => lookup.path.includes("fields=product_name_de,product_name,brands,quantity,image_front_small_url") && lookup.path.includes("lc=de"))).toBe(true);
  // Der User-Agent nennt Stowly und, ohne STOWLY_OFF_CONTACT, keinen Kontakt.
  expect(lookups.every((lookup) => /^Stowly\/[0-9.]+$/.test(lookup.userAgent))).toBe(true);

  // Ein späterer Anwender-Eintrag gewinnt weiter: Das Nachschlagen hat keine Uhr gestellt.
  await other.core.products.update(placeholder.product.id, { name: "Haferdrink Barista" });
  await other.sync();
  await device.sync();
  expect(product(device, placeholder.product.id).name).toBe("Haferdrink Barista");

  const history = (await raw.events({ entity: "product", entity_id: placeholder.product.id })).map((event) => event.type).reverse();
  expect(history).toEqual(["product.created", "product.lookup", "product.updated"]);
});

it("sagt dem Gerät, ob nachgeschlagen wird, und das Gerät verspricht nur dann etwas", async () => {
  // Dieser Server schlägt nach: Der Kern erfährt es mit dem ersten Abgleich.
  const device = await signedIn(server.url, "Küche");
  expect(device.status.lookup_enabled).toBe(true);
  expect(device.net.lastSync.response?.lookup_enabled).toBe(true);

  // Ein zweiter Server mit abgeschaltetem Nachschlagen (die Vorgabe aller anderen Tests).
  const plain = await startServer();
  try {
    const quiet = await signedIn(plain.url, "Keller");
    expect(quiet.status.lookup_enabled).toBe(false);
    const zone = firstZone(quiet);
    const barcode = freshBarcode();

    // Offline eingelagert: Der Platzhalter beginnt als "none", nicht als "pending" ...
    quiet.net.online = false;
    const stored = await quiet.core.stock.store({ product: { kind: "barcode", barcode }, zone_id: zone.id, best_before: null, count: 1, labels: false });
    expect(stored.product.lookup).toBe("none");
    // ... auch nach dem Neuladen der App, ohne dass der Server gefragt wurde.
    await quiet.reload();
    expect(quiet.status.lookup_enabled).toBe(false);
    expect(product(quiet, stored.product.id).lookup).toBe("none");

    // Und der Server sieht es genauso: Nach dem Abgleich ändert sich nichts.
    quiet.net.online = true;
    await quiet.sync();
    expect(product(quiet, stored.product.id)).toMatchObject({ name: "", lookup: "none", barcodes: [barcode] });
    const raw = await RawClient.login(plain.url);
    await expectSameAsServer(quiet, raw);
  } finally {
    await plain.dispose();
  }
});

it("schlägt gleich beim Scannen nach: Name, Marke und Größe sind sofort da, und das Produkt entsteht damit", async () => {
  const device = await signedIn(server.url, "Küche");
  const raw = await RawClient.login(server.url);
  const zone = firstZone(device);
  const [beans, unknown] = [freshBarcode(), freshBarcode()] as [string, string];
  const internalBody = `22${String(process.pid % 100_000).padStart(5, "0")}00002`;
  const internal = internalBody + String(gtinCheckDigit(internalBody));
  known.set(beans, { product_name_de: "Weiße Bohnen", product_name: "White beans", brands: "Feldhof", quantity: "400 g" });
  const asked = lookups.length;

  // Der Server fragt Open Food Facts (hier den Ersatz), während das Gerät wartet.
  const found = await device.core.products.lookup(beans);
  expect(found).toEqual({ barcode: beans, state: "found", name: "Weiße Bohnen", brand: "Feldhof", quantity: "400 g", image_id: null });
  expect(await device.core.products.lookup(unknown)).toEqual({ barcode: unknown, state: "not_found", name: "", brand: "", quantity: "", image_id: null });
  // Ladenintern: gar nicht erst gefragt.
  expect(await device.core.products.lookup(internal)).toMatchObject({ state: "skipped" });
  expect(lookups.slice(asked).map((lookup) => lookup.path.split("?")[0])).toEqual([`/api/v3/product/${beans}`, `/api/v3/product/${unknown}`]);

  // Eingelagert mit dem Ergebnis: Das Produkt hat Name, Marke und Größe von Anfang an.
  const stored = await device.core.stock.store({
    product: { kind: "barcode", barcode: beans, name: found.name, brand: found.brand, quantity: found.quantity },
    zone_id: zone.id,
    best_before: null,
    count: 1,
    labels: false,
  });
  expect(stored.product).toMatchObject({ name: "Weiße Bohnen", brand: "Feldhof", quantity: "400 g", lookup: "pending" });
  expect(await untilSettled(device, stored.product.id)).toMatchObject({ name: "Weiße Bohnen", brand: "Feldhof", quantity: "400 g", lookup: "found", barcodes: [beans] });
  await expectSameAsServer(device, raw);
  // Das Ergebnis von eben liegt beim Server: Open Food Facts wurde nicht noch einmal gefragt.
  expect(lookups.slice(asked).filter((lookup) => lookup.path.startsWith(`/api/v3/product/${beans}`))).toHaveLength(1);
});

/**
 * Legt ein Bild in die Datenbank des Servers, als hätte er es bei Open Food Facts geladen (der Ersatz
 * liefert keine Bilder: nur https von openfoodfacts.org). Liefert seine Kennung wie `off.image_id`.
 */
function storeImage(handle: ServerHandle): string {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const id = `${createHash("sha256").update(png).digest("hex").slice(0, 32)}.png`;
  const script = [
    "import sqlite3, sys",
    "con = sqlite3.connect(sys.argv[1], timeout=10)",
    "con.execute(\"INSERT OR IGNORE INTO images (id, content_type, data, source, source_url, created_at) VALUES (?, 'image/png', ?, 'openfoodfacts', 'https://images.openfoodfacts.org/images/e2e.png', '2026-11-16T10:00:00.000Z')\", (sys.argv[2], bytes.fromhex(sys.argv[3])))",
    "con.commit()",
  ].join("\n");
  const result = spawnSync(pythonPath(), ["-I", "-c", script, join(handle.dataDir, "stowly.sqlite3"), id, png.toString("hex")], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Bild ließ sich nicht ablegen: ${result.stderr}`);
  }
  return id;
}

it("fragt auf Wunsch neu: erst unbekannt, dann gefunden; übernommen wird nur, was der Anwender speichert, das Bild eingeschlossen", async () => {
  const device = await signedIn(server.url, "Küche");
  const raw = await RawClient.login(server.url);
  const zone = firstZone(device);
  const barcode = freshBarcode();

  // Gescannt, Open Food Facts kennt den Barcode (noch) nicht.
  const stored = await device.core.stock.store({ product: { kind: "barcode", barcode }, zone_id: zone.id, best_before: null, count: 1, labels: false });
  expect(await untilSettled(device, stored.product.id)).toMatchObject({ name: "", lookup: "not_found" });

  // Jetzt kennt ihn Open Food Facts: „Online abfragen" fragt neu, auch nach „unbekannt".
  known.set(barcode, { product_name_de: "Bio Haferdrink", brands: "Hofgut", quantity: "1 l" });
  const asked = lookups.length;
  const found = await device.core.products.refreshLookup(barcode);
  expect(found).toMatchObject({ barcode, state: "found", name: "Bio Haferdrink", brand: "Hofgut", quantity: "1 l", image_id: null, throttled: false });
  expect(found.fetched_at).not.toBeNull();
  expect(lookups.slice(asked).map((lookup) => lookup.path.split("?")[0])).toEqual([`/api/v3/product/${barcode}`]);

  // Kein Produkt ändert sich, auch nicht sein Stand `lookup`.
  await device.sync();
  expect(product(device, stored.product.id)).toMatchObject({ name: "", lookup: "not_found", image: null });
  // Gleich noch einmal: gebremst, der gespeicherte Stand, ohne neue Anfrage.
  expect(await device.core.products.refreshLookup(barcode)).toMatchObject({ state: "found", name: "Bio Haferdrink", throttled: true });
  expect(lookups.length).toBe(asked + 1);
  // Das neue Ergebnis gilt auch für künftige Scans.
  expect(await device.core.products.lookup(barcode)).toMatchObject({ state: "found", name: "Bio Haferdrink", brand: "Hofgut" });
  // Ladeninterne Codes gehen nicht hinaus.
  const internalBody = `23${String(process.pid % 100_000).padStart(5, "0")}00003`;
  expect(await device.core.products.refreshLookup(internalBody + String(gtinCheckDigit(internalBody)))).toMatchObject({ state: "skipped" });
  expect(lookups.length).toBe(asked + 1);

  // „Übernehmen" und „Speichern": die Felder wie bisher, danach das Bild.
  await device.core.products.update(stored.product.id, { name: found.name, brand: found.brand, quantity: found.quantity });
  const image = storeImage(server);
  await device.core.products.setImage(stored.product.id, image);
  await device.sync();
  expect(product(device, stored.product.id)).toMatchObject({ name: "Bio Haferdrink", brand: "Hofgut", quantity: "1 l", image });
  await expectSameAsServer(device, raw);
  const served = await fetch(`${server.url}/api/images/${image}`);
  expect(served.headers.get("content-type")).toBe("image/png");

  // Ein Bild, das Stowly nicht hat, lehnt der Server ab; null entfernt das Bild.
  await expectCoreError(device.core.products.setImage(stored.product.id, "0123456789abcdef0123456789abcdef.png"), "invalid");
  await expectCoreError(device.core.products.setImage("00000000-0000-4000-8000-000000000000", null), "not_found");
  await device.core.products.setImage(stored.product.id, null);
  await device.sync();
  expect(product(device, stored.product.id).image).toBeNull();

  const history = (await raw.events({ entity: "product", entity_id: stored.product.id })).map((event) => event.type);
  expect(history.filter((type) => type === "product.image")).toHaveLength(2);
});

it("setzt das Bild eines offline angelegten Produkts erst nach dessen Abgleich", async () => {
  const device = await signedIn(server.url, "Keller");
  const image = storeImage(server);
  device.net.online = false;
  const made = await device.core.products.create({ name: "Mein Mehl offline" });
  device.net.online = true;
  // Der Kern gleicht vorher ab: Sonst kennte der Server das Produkt nicht (404).
  await device.core.products.setImage(made.id, image);
  await device.sync();
  expect(product(device, made.id)).toMatchObject({ name: "Mein Mehl offline", image });
});
