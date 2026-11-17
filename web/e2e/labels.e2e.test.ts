/**
 * Etiketten gestalten Ende zu Ende (docs/plan-0.5.md, 1; docs/etiketten.md, 3.4 und 4.1): Die
 * Gestaltung geht an den echten Server, der Abgleich bringt die erzeugten Vorlagen, und der echte
 * Druckdienst mit Bild-Treiber druckt danach in der Größe des Papiers, gedreht, wo es nötig ist.
 *
 * Ein Druckdienst vor 0.5.0 (hier nachgestellt: er meldet `template_schemas` nicht) bekommt ein
 * Etikett im Format 2 nicht: Es bleibt mit `outdated` ausstehend, und es geht nichts hinaus. Mit
 * der 62-mm-Endlosrolle bis 62 mm Länge (Format 1) druckt er weiter.
 */
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { packageLabelData, type LabelDesign, type LabelLayout, type PrintJob } from "@/contract";

import { firstZone } from "./support/data";
import { disposeDevices, signedIn, until, value, type Device } from "./support/device";
import { serverImageDir, startPrintService, type PrintServiceHandle } from "./support/print";
import { RawClient } from "./support/raw";
import { startServer, type ServerHandle } from "./support/server";

let server: ServerHandle;
let pi: PrintServiceHandle;

beforeAll(async () => {
  [server, pi] = await Promise.all([startServer(), startPrintService()]);
});

afterAll(async () => {
  await Promise.all([server?.dispose(), pi?.dispose()]);
});

afterEach(disposeDevices);

/** Breite und Höhe eines PNG (aus dem IHDR-Block). */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Eine schlanke Gestaltung, die auf jedes Papier des Katalogs passt (auch 29 mm quer). */
const COMPACT: LabelLayout = {
  length_mm: 50,
  qr: { side: "left", size: "s" },
  fields: [
    { field: "title", size: "s", lines: 1 },
    { field: "id", size: "s", lines: null },
  ],
  date: "short",
  text: "",
  divider: false,
};

function design(paper: string, length: number | null): LabelDesign {
  return {
    paper,
    package: { ...COMPACT, length_mm: length },
    zone: { ...COMPACT, length_mm: length, fields: [{ field: "title", size: "s", lines: 1 }] },
  };
}

function jobOf(device: Device, id: string): PrintJob | undefined {
  return value(device.core.data.printJobs).find((job) => job.id === id);
}

/** Speichert eine Gestaltung und gleicht ab, bis die neuen Vorlagen auf dem Gerät sind. */
async function apply(device: Device, wanted: LabelDesign): Promise<void> {
  const saved = await device.core.labels.save(wanted);
  await device.sync();
  expect((await device.core.labels.templates()).hashes).toEqual(saved.templates);
}

/** Lagert eine Packung mit Etikett ein und stellt es zu; liefert die Kennung des Etiketts. */
async function storeLabelled(device: Device, name: string): Promise<string> {
  const stored = await device.core.stock.store({ product: { kind: "new", name, brand: "Hof", quantity: "500 g" }, zone_id: firstZone(device).id, best_before: "2027-03-31", count: 1, labels: true });
  const id = stored.print_jobs[0]?.id;
  if (!id) {
    throw new Error("Kein Etikett angefordert.");
  }
  return id;
}

describe("Gestaltung speichern, abgleichen, drucken", () => {
  it("druckt am Druckdienst des Servers je Papier in dessen Größe, gedreht, wo nötig; die Vorschau zeigt es, wie man es liest", async () => {
    const kitchen = await signedIn(server.url, "Küche");
    const cellar = await signedIn(server.url, "Keller");
    const raw = await RawClient.login(server.url);
    const printer = await kitchen.core.printers.create({ name: "Bild am Server", connection: "server", server: { driver: "image", model: null, address: null, media: "62" } });
    await kitchen.core.settings.update({ default_printer_id: printer.id });

    // Ohne eigene Gestaltung: die mitgelieferten Vorlagen, Format 1 auf der 62-mm-Rolle.
    const initial = await kitchen.core.labels.design();
    expect(initial).toMatchObject({ is_default: true, updated_at: null, design: { paper: "62" } });
    expect(initial.papers.map((paper) => paper.id)).toEqual(expect.arrayContaining(["62", "29", "62x29", "29x90"]));
    expect(await kitchen.core.labels.templates()).toMatchObject({ paper: "62", schema: 1, hashes: initial.templates });

    // [Papier, Länge, Format, gedreht, Bild am Drucker (quer × längs), Vorschau (wie man es liest)]
    const cases: [string, number | null, number, boolean, [number, number], [number, number]][] = [
      ["62", 40, 1, false, [696, 472], [696, 472]],
      ["62", 70, 2, true, [696, 826], [826, 696]],
      ["29", 50, 2, true, [306, 590], [590, 306]],
      ["62x29", null, 2, false, [696, 271], [696, 271]],
      ["29x90", null, 2, true, [306, 991], [991, 306]],
    ];
    for (const [paper, length, schema, turned, printed, read] of cases) {
      const what = `${paper}${length === null ? "" : ` / ${String(length)} mm`}`;
      await apply(kitchen, design(paper, length));
      expect(await kitchen.core.labels.templates(), what).toMatchObject({ paper, schema });

      const jobId = await storeLabelled(kitchen, `Linsen ${what}`);
      expect(await kitchen.core.print.flush(), what).toMatchObject({ delivered: 1, problems: [] });
      await until(() => jobOf(kitchen, jobId)?.state === "printed", `${what}: gedruckt`);
      const [submit] = kitchen.net.submits(jobId);
      expect(submit?.body?.template, what).toMatchObject({ schema, media: { id: paper } });
      if (schema === 2) {
        expect(submit?.body?.template, what).toMatchObject({ rotate: turned ? 90 : 0 });
      }
      const image = new Uint8Array(await (await kitchen.core.print.image(jobId)).arrayBuffer());
      expect(pngSize(image), what).toEqual({ width: printed[0], height: printed[1] });
      expect(pngSize(new Uint8Array(readFileSync(join(serverImageDir(server), `${jobId}.png`)))), what).toEqual({ width: printed[0], height: printed[1] });

      // Die Vorschau am Server: dasselbe Etikett, ungedreht.
      const pkg = value(kitchen.core.data.packages).find((candidate) => candidate.id === jobOf(kitchen, jobId)?.package_id);
      const product = value(kitchen.core.data.products).find((candidate) => candidate.id === pkg?.product_id);
      const preview = await kitchen.core.labels.preview({ kind: "package", paper, layout: { ...COMPACT, length_mm: length }, data: pkg ? { ...packageLabelData(pkg, product, firstZone(kitchen)) } : null });
      expect([preview.width_px, preview.height_px], what).toEqual(read);
      expect(pngSize(Uint8Array.from(atob(preview.png), (char) => char.charCodeAt(0))), what).toEqual({ width: read[0], height: read[1] });
    }

    // Das andere Gerät bekommt die Vorlagen mit seinem Abgleich; die Gestaltung liegt beim Server.
    await cellar.sync();
    expect(await cellar.core.labels.templates()).toEqual(await kitchen.core.labels.templates());
    expect((await cellar.core.labels.design()).design.paper).toBe("29x90");

    // Zurück zur Vorgabe: die mitgelieferten Vorlagen mit ihrem alten `hash`.
    expect(await kitchen.core.labels.reset()).toMatchObject({ is_default: true, templates: initial.templates });
    await kitchen.sync();
    expect((await kitchen.core.labels.templates()).hashes).toEqual(initial.templates);
    const events = await raw.events({ entity: "labels" });
    expect(events.map((event) => event.type)).toContain("labels.changed");
  });

  it("druckt am eigenständigen Druckdienst (wie am Pi) gestanzt in der Größe des Etiketts", async () => {
    const device = await signedIn(server.url, "Handy");
    expect((await pi.health()).template_schemas).toEqual([1, 2]);
    const printer = await device.core.printers.create({ name: "Keller-Pi", connection: "direct", direct: { urls: [pi.url], token: pi.token, printer: null } });
    await device.core.settings.update({ default_printer_id: printer.id });
    await apply(device, design("62x29", null));
    const probe = await device.core.printers.probe(printer.id);
    expect(probe).toMatchObject({ reachable: true, problem: null, health: { template_schemas: [1, 2] } });
    // Die Abfrage nennt das Papier des Haushalts.
    const health = device.net.printCalls.filter((call) => call.path === "/v1/health").at(-1);
    expect(new URL(health?.url ?? "http://x").searchParams.get("media")).toBe("62x29");

    const jobId = await storeLabelled(device, "Mais P2");
    expect(await device.core.print.flush()).toMatchObject({ delivered: 1, problems: [] });
    await until(() => pi.printed().includes(jobId), "am Pi gedruckt");
    expect(pngSize(new Uint8Array(readFileSync(join(pi.imageDir, `${jobId}.png`))))).toEqual({ width: 696, height: 271 });
    await device.core.labels.reset();
  });

  it("lehnt eine zu volle Gestaltung mit einem Satz ab, in der Vorschau wie beim Speichern", async () => {
    const device = await signedIn(server.url, "Küche");
    const crowded: LabelLayout = {
      ...COMPACT,
      length_mm: 25,
      qr: { side: "left", size: "l" },
      fields: (["title", "subtitle", "quantity", "brand", "best_before", "stored", "id", "zone", "text"] as const).map((field) => ({ field, size: "l" as const, lines: field === "title" ? 3 : null })),
      text: "Bitte zuerst aufbrauchen",
    };
    const refused = await device.core.labels.save({ ...design("62", 25), package: crowded }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toMatchObject({ code: "invalid" });
    expect((refused as Error).message.length).toBeGreaterThan(10);
    const preview = await device.core.labels.preview({ kind: "package", paper: "62", layout: crowded, data: null }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(preview).toMatchObject({ code: "invalid", message: (refused as Error).message });
    expect((await device.core.labels.design()).is_default).toBe(true);
  });
});

describe("Druckdienst vor 0.5.0", () => {
  const TOKEN = "e2e-alter-druckdienst-0123";
  let old: Server;
  let oldUrl = "";
  const bootId = randomUUID();
  /** Was beim alten Dienst einging: Methode und Pfad. */
  const received: string[] = [];

  beforeAll(async () => {
    // Nachgestellt, wie ein Druckdienst 0.4.0 antwortet: ohne `template_schemas`, ohne Rolle.
    old = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      received.push(`${request.method ?? "GET"} ${url.pathname}`);
      response.setHeader("content-type", "application/json");
      if (request.method === "GET" && url.pathname === "/v1/health") {
        const nonce = url.searchParams.get("nonce");
        response.end(
          JSON.stringify({
            app: "stowly-print",
            version: "0.4.0",
            protocol: 1,
            boot_id: bootId,
            uptime_s: 12,
            proof: nonce === null ? null : createHmac("sha256", TOKEN).update(nonce).digest("hex"),
            host: null,
            printers: [
              {
                name: "bild",
                driver: "image",
                model: null,
                capabilities: { dpi: 300, media: { width_mm: 62, length_mm: null, printable_px: 696 }, cutter: true, colors: ["black"], status_query: true, confirms_print: true },
                status: { reachable: true, ready: true, media_detected: null, errors: [] },
              },
            ],
          }),
        );
        return;
      }
      const job = /^\/v1\/jobs\/([^/]+)$/.exec(url.pathname);
      if (job && request.method === "POST") {
        request.resume();
        request.on("end", () => {
          response.statusCode = 201;
          response.end(JSON.stringify({ id: job[1], state: "printed", printer: "bild", boot_id: bootId, error: null, position: null }));
        });
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { code: "not_found", message: "Unbekannt.", details: null } }));
    });
    await new Promise<void>((resolve) => old.listen(0, "127.0.0.1", resolve));
    oldUrl = `http://127.0.0.1:${String((old.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => old.close(resolve));
  });

  it("bekommt ein Etikett im Format 2 nicht: Es bleibt mit `outdated` ausstehend; Format 1 druckt er", async () => {
    const device = await signedIn(server.url, "Keller");
    const printer = await device.core.printers.create({ name: "Alter Pi", connection: "direct", direct: { urls: [oldUrl], token: TOKEN, printer: null } });
    await device.core.settings.update({ default_printer_id: printer.id });
    await apply(device, design("29", 50));

    const jobId = await storeLabelled(device, "Graupen A1");
    received.length = 0;
    const report = await device.core.print.flush();
    expect(report).toMatchObject({ delivered: 0, pending: 1, problems: [{ printer_id: printer.id, problem: "outdated" }] });
    expect(report.problems[0]?.message).toBe("Der Druckdienst auf dem Pi ist zu alt für dieses Papier. Neu koppeln aktualisiert ihn.");
    expect(jobOf(device, jobId)).toMatchObject({ state: "pending", error: null });
    // Es ging nichts hinaus außer der Abfrage des Zustands.
    expect(received.every((entry) => entry === "GET /v1/health")).toBe(true);
    expect(await device.core.printers.probe(printer.id)).toMatchObject({ reachable: true, problem: "outdated", health: { version: "0.4.0" } });
    await device.sync();
    expect(jobOf(device, jobId)?.state).toBe("pending");

    // Zurück auf die 62-mm-Rolle (Format 1): Jetzt druckt auch der alte Dienst, dasselbe Etikett.
    await device.core.labels.reset();
    await device.sync();
    expect(await device.core.print.flush()).toMatchObject({ delivered: 1, problems: [] });
    await until(() => jobOf(device, jobId)?.state === "printed", "beim alten Dienst gedruckt");
    expect(received).toContain(`POST /v1/jobs/${jobId}`);
  });
});
