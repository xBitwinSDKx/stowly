/**
 * Der Druck Ende zu Ende (docs/etiketten.md, 4.1 und 5): der echte Kern stellt Etiketten zu, an
 * den Druckdienst des echten Servers (`/print`, Drucker mit Bild-Treiber) und an den
 * eigenständigen Druckdienst als zweiten Prozess, wie er auf dem Pi läuft.
 *
 * Gezählt wird, was wirklich gedruckt ist: die Bilder im Verzeichnis des Bild-Treibers. Kein
 * Etikett darf dort zweimal stehen, auch nicht nach verlorenen Antworten, Neustarts und
 * gleichzeitigen Versuchen zweier Tabs.
 *
 * Die Geräte gleichen nur ab, wenn der Test es sagt, und stellen nur über `print.flush` zu
 * (`autoSync: false`, wie alle Tests hier). Das Nachfragen nach dem Einreichen läuft im Kern im
 * Hintergrund weiter; darauf wartet der Test mit `until`.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { PrintJob, ServiceJob } from "@/contract";

import { firstZone } from "./support/data";
import { disposeDevices, expectCoreError, signedIn, until, value, type Device } from "./support/device";
import { printedIn, serverImageDir, simulateIn, startPrintService, type PrintServiceHandle } from "./support/print";
import { expectSameAsServer, RawClient } from "./support/raw";
import { freePort, startServer, type ServerHandle } from "./support/server";

let server: ServerHandle;
let pi: PrintServiceHandle;

beforeAll(async () => {
  [server, pi] = await Promise.all([startServer(), startPrintService()]);
});

afterAll(async () => {
  await Promise.all([server?.dispose(), pi?.dispose()]);
});

afterEach(async () => {
  await disposeDevices();
  simulateIn(serverImageDir(server), null);
  pi.simulate(null);
  if (!server.running) {
    await server.start();
  }
  if (!pi.running) {
    await pi.start();
  }
});

/** Die Etiketten, die der Druckdienst des Servers gedruckt hat. */
function serverPrinted(): string[] {
  return printedIn(serverImageDir(server));
}

function jobOf(device: Device, id: string): PrintJob {
  const job = value(device.core.data.printJobs).find((candidate) => candidate.id === id);
  if (!job) {
    throw new Error(`${device.name} kennt das Etikett ${id} nicht.`);
  }
  return job;
}

/** Wartet, bis das Etikett auf dem Gerät diesen Zustand zeigt. */
async function settled(device: Device, id: string, state: PrintJob["state"]): Promise<void> {
  await until(() => value(device.core.data.printJobs).some((job) => job.id === id && job.state === state), `${device.name}: Etikett ${id} ist ${state}`);
}

/** Breite und Höhe eines PNG (aus dem IHDR-Block). */
async function pngSize(blob: Blob): Promise<{ width: number; height: number }> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Der Zustand eines Auftrags, wie ihn der eigenständige Druckdienst führt. */
async function serviceJob(id: string): Promise<ServiceJob | null> {
  const response = await fetch(`${pi.url}/v1/jobs/${id}`);
  return response.ok ? ((await response.json()) as ServiceJob) : null;
}

async function serverPrinter(device: Device, name = "Bild am Server") {
  return device.core.printers.create({ name, connection: "server", server: { driver: "image", model: null, address: null, media: "62" } });
}

async function directPrinter(device: Device, urls: string[] = [pi.url]) {
  return device.core.printers.create({ name: "Keller-Pi", connection: "direct", direct: { urls, token: pi.token, printer: null } });
}

/** Lagert `count` Packungen eines neuen Produkts ein und fordert die Etiketten an. */
async function storeWithLabels(device: Device, name: string, count = 1, zoneId?: string): Promise<string[]> {
  const stored = await device.core.stock.store({
    product: { kind: "new", name, brand: "Hof", quantity: "500 g" },
    zone_id: zoneId ?? firstZone(device).id,
    best_before: "2027-03-31",
    count,
    labels: true,
  });
  expect(stored.print_jobs.map((job) => job.state)).toEqual(stored.packages.map(() => "pending"));
  return stored.print_jobs.map((job) => job.id);
}

describe("Drucker am Server mit Bild-Treiber", () => {
  it("druckt nach dem Abgleich genau einmal; das Bild ist abrufbar, ein zweites Gerät sieht Zustand und Drucker", async () => {
    const kitchen = await signedIn(server.url, "Küche");
    const cellar = await signedIn(server.url, "Keller");
    const raw = await RawClient.login(server.url);
    const printer = await serverPrinter(kitchen);
    await kitchen.core.settings.update({ default_printer_id: printer.id });
    const [id] = (await storeWithLabels(kitchen, "Linsen E1")) as [string];

    // Vor dem Abgleich kennt der Server weder Drucker noch Etikett: „Verbindung prüfen" und
    // „Jetzt drucken" gleichen deshalb zuerst ab.
    expect(kitchen.net.syncs.flatMap((exchange) => exchange.request.commands)).toEqual([]);
    expect(await kitchen.core.printers.probe(printer.id)).toMatchObject({ reachable: true, problem: null, url: null });
    expect(await kitchen.core.print.flush()).toEqual({ delivered: 1, pending: 0, problems: [] });
    expect(kitchen.net.syncs.flatMap((exchange) => exchange.request.commands).map((command) => command.type)).toContain("print.request");
    await settled(kitchen, id, "printed");
    expect(serverPrinted()).toContain(id);

    // So ging der Auftrag hinaus: Geräte-Token im Kopf, gewöhnliches JSON, die Daten fertig formatiert.
    const [submit] = kitchen.net.submits(id);
    expect(submit?.headers.authorization).toMatch(/^Bearer /);
    expect(submit?.headers["content-type"]).toBe("application/json");
    expect(submit?.body).toMatchObject({
      printer: printer.id,
      copies: 1,
      cut: true,
      template: { schema: 1, name: "package-62x29" },
      data: { title: "Linsen E1", subtitle: "500 g · Hof", best_before: "31.03.2027", zone: "" },
    });
    expect(typeof submit?.body?.expect_boot_id).toBe("string");

    // Das Bild des Bild-Treibers, über den Kern.
    expect(await pngSize(await kitchen.core.print.image(id))).toEqual({ width: 696, height: 342 });

    await kitchen.sync();
    await cellar.sync();
    expect(jobOf(cellar, id)).toMatchObject({ state: "printed", printer_id: printer.id, error: null, device_id: kitchen.session.id });
    // Den Zustand seines Druckers schreibt der Server selbst; kein Gerät meldet ihn.
    expect(value(cellar.core.data.printerStatus)).toContainEqual(
      expect.objectContaining({ printer_id: printer.id, host: null, status: { reachable: true, ready: true, media_detected: true, errors: [] } }),
    );
    expect(kitchen.net.syncs.flatMap((exchange) => exchange.request.commands).some((command) => command.type === "printer.report")).toBe(false);
    await expectSameAsServer(kitchen, raw);
    await expectSameAsServer(cellar, raw);

    // Vorschau: für den Drucker am Server und ohne Drucker (Vorgabe 696 × 342), für Packung und Zone.
    const packageId = jobOf(cellar, id).package_id ?? "";
    expect(await pngSize(await cellar.core.print.preview({ kind: "package", package_id: packageId }, { printer_id: printer.id }))).toEqual({ width: 696, height: 342 });
    expect(await pngSize(await cellar.core.print.preview({ kind: "zone", zone_id: firstZone(cellar).id }))).toEqual({ width: 696, height: 342 });

    // Noch einmal zustellen ändert nichts: kein zweites Bild, kein zweiter Auftrag.
    expect(await kitchen.core.print.flush()).toEqual({ delivered: 0, pending: 0, problems: [] });
    expect(kitchen.net.submits(id)).toHaveLength(1);
    expect(serverPrinted().filter((entry) => entry.startsWith(id))).toEqual([id]);

    // Ein Zwischenstand, der später eintrifft, ändert den Ausgang nicht mehr (Protokoll 6.6).
    const late = await raw.send([{ type: "print.report", job_id: id, state: "queued", printer_id: printer.id, boot_id: "spaet" }]);
    expect(late.results).toMatchObject([{ status: "applied", code: null }]);
    await cellar.sync();
    expect(jobOf(cellar, id)).toMatchObject({ state: "printed", printer_id: printer.id, error: null });
  });
});

describe("Direkter Drucker (eigenständiger Druckdienst)", () => {
  it("weist den Dienst aus, druckt ohne Server und bringt den Zustand des Pi mit dem nächsten Abgleich zum Server", async () => {
    const kitchen = await signedIn(server.url, "Küche");
    const cellar = await signedIn(server.url, "Keller");
    const raw = await RawClient.login(server.url);
    // Die erste Adresse antwortet nicht (wie HTTPS ohne Zertifikat): Es gilt die zweite.
    const dead = `http://127.0.0.1:${String(await freePort())}`;
    const printer = await directPrinter(kitchen, [dead, pi.url]);
    const zone = await kitchen.core.zones.create({ name: "Keller", printer_id: printer.id });

    const probe = await kitchen.core.printers.probe(printer.id);
    const boot = (await pi.health()).boot_id;
    expect(probe).toMatchObject({ reachable: true, url: pi.url, problem: null, error: null, health: { app: "stowly-print", boot_id: boot } });

    const ids = await storeWithLabels(kitchen, "Bohnen D1", 2, zone.id);
    // Im Keller: kein Server, aber der Pi.
    kitchen.net.online = false;
    expect(await kitchen.core.print.flush()).toEqual({ delivered: 2, pending: 0, problems: [] });
    for (const id of ids) {
      await settled(kitchen, id, "printed");
    }
    expect(pi.printed()).toEqual([...ids].sort());

    // Ohne Vorabanfrage: lesend ein GET ohne eigene Kopfzeilen, schreibend ein POST als text/plain mit dem Token im Rumpf.
    const direct = kitchen.net.printCalls.filter((call) => call.url.startsWith(pi.url));
    expect(direct.length).toBeGreaterThan(0);
    for (const call of direct) {
      expect(call.headers.authorization).toBeUndefined();
      expect(["GET", "POST"]).toContain(call.method);
      if (call.method === "GET") {
        expect(Object.keys(call.headers)).toEqual([]);
      } else {
        expect(call.headers["content-type"]).toBe("text/plain");
        expect(call.body?.token).toBe(pi.token);
      }
    }
    // In der Reihenfolge der Anforderung, mit der boot_id der Abfrage davor und dem Zonennamen (zwei Zonen).
    const submits = kitchen.net.submits();
    expect(submits.map((call) => call.path)).toEqual(ids.map((id) => `/v1/jobs/${id}`));
    expect(submits.map((call) => call.body?.expect_boot_id)).toEqual([boot, boot]);
    expect(submits.map((call) => (call.body?.data as Record<string, string>).zone)).toEqual(["Keller", "Keller"]);
    expect(submits.every((call) => call.body?.printer === null)).toBe(true);

    kitchen.net.online = true;
    await kitchen.sync();
    const snapshot = await raw.snapshot();
    for (const id of ids) {
      expect(snapshot.print_jobs.find((job) => job.id === id)).toMatchObject({ state: "printed", printer_id: printer.id, boot_id: boot, error: null });
    }
    // printer.report: Zustand des Druckers und des Rechners, gesehen vom Handy.
    expect(snapshot.printer_status.find((status) => status.printer_id === printer.id)).toMatchObject({
      boot_id: boot,
      status: { reachable: true, ready: true, media_detected: true, errors: [] },
      host: expect.any(Object),
    });
    await cellar.sync();
    expect(value(cellar.core.data.printerStatus).find((status) => status.printer_id === printer.id)?.boot_id).toBe(boot);
    for (const id of ids) {
      expect(jobOf(cellar, id).state).toBe("printed");
    }
    await expectSameAsServer(cellar, raw);
  });
});

describe("Ausweis des Druckdienstes", () => {
  it("nimmt einen Dienst mit anderem Token nicht als Drucker und schickt ihm nichts", async () => {
    const kitchen = await signedIn(server.url, "Küche");
    const printer = await kitchen.core.printers.create({ name: "Falscher Pi", connection: "direct", direct: { urls: [pi.url], token: "ein-ganz-anderes-token-0000", printer: null } });
    await kitchen.core.settings.update({ default_printer_id: printer.id });
    expect(await kitchen.core.printers.probe(printer.id)).toMatchObject({ reachable: false, problem: "not_verified" });
    const [id] = (await storeWithLabels(kitchen, "Graupen A1")) as [string];
    expect(await kitchen.core.print.flush()).toMatchObject({ delivered: 0, pending: 1, problems: [{ printer_id: printer.id, problem: "not_verified" }] });
    expect(kitchen.net.submits()).toEqual([]);
    expect(jobOf(kitchen, id).state).toBe("pending");
    // Einen Drucker, der sich nicht ausweist, meldet das Gerät auch nicht als gesehen.
    await kitchen.sync();
    expect(value(kitchen.core.data.printerStatus).some((status) => status.printer_id === printer.id)).toBe(false);
  });
});

describe("Nie doppelt", () => {
  it("schickt nach einer verlorenen Antwort denselben Auftrag noch einmal; gedruckt wird einmal (direkt und am Server)", async () => {
    const kitchen = await signedIn(server.url, "Küche");
    const atServer = await serverPrinter(kitchen);
    const atPi = await directPrinter(kitchen);
    const zone = await kitchen.core.zones.create({ name: "Keller", printer_id: atPi.id });
    await kitchen.core.settings.update({ default_printer_id: atServer.id });
    const [direct] = (await storeWithLabels(kitchen, "Erbsen N1", 1, zone.id)) as [string];
    const [viaServer] = (await storeWithLabels(kitchen, "Erbsen N2")) as [string];
    await kitchen.sync();

    // Beide Antworten auf das Einreichen gehen verloren, nachdem der Dienst angenommen hat.
    kitchen.net.loseSubmitResponses = 2;
    expect(await kitchen.core.print.flush()).toMatchObject({ delivered: 0, pending: 2 });
    expect(jobOf(kitchen, direct).state).toBe("pending");
    expect(jobOf(kitchen, viaServer).state).toBe("pending");
    // Gedruckt haben die Dienste trotzdem.
    await until(() => pi.printed().includes(direct) && serverPrinted().includes(viaServer), "beide Dienste haben gedruckt");

    // Inzwischen bekommt das Produkt einen anderen Namen: Die Wiederholung schickt trotzdem den alten Inhalt.
    const product = value(kitchen.core.data.products).find((candidate) => candidate.name === "Erbsen N1");
    await kitchen.core.products.update(product?.id ?? "", { name: "Erbsen, neu benannt" });

    expect(await kitchen.core.print.flush()).toMatchObject({ delivered: 2, pending: 0 });
    await settled(kitchen, direct, "printed");
    await settled(kitchen, viaServer, "printed");
    for (const id of [direct, viaServer]) {
      const [first, second, ...rest] = kitchen.net.submits(id);
      expect(rest).toEqual([]);
      expect(first?.lost).toBe(true);
      expect(second?.status).toBe(200);
      // Dieselbe Kennung, derselbe Inhalt, dieselbe boot_id.
      expect(second?.body).toEqual(first?.body);
    }
    expect(pi.printed().filter((entry) => entry.startsWith(direct))).toEqual([direct]);
    expect(serverPrinted().filter((entry) => entry.startsWith(viaServer))).toEqual([viaServer]);
  });

  it("macht ein Etikett unklar, wenn der Pi zwischen Einreichen und Nachfragen neu startet; gedruckt wird nichts von selbst", async () => {
    const kitchen = await signedIn(server.url, "Küche");
    const printer = await directPrinter(kitchen);
    await kitchen.core.settings.update({ default_printer_id: printer.id });
    pi.simulate("hang");
    const [id] = (await storeWithLabels(kitchen, "Mais N3")) as [string];
    const before = (await pi.health()).boot_id;
    expect(await kitchen.core.print.flush()).toMatchObject({ delivered: 1, pending: 0 });
    expect(jobOf(kitchen, id)).toMatchObject({ state: "queued", boot_id: before });
    await until(async () => (await serviceJob(id))?.state === "printing", "Der Pi druckt (hängt)");

    // Strom weg mitten im Druck, dann wieder da: ein neuer Lauf.
    await pi.stop();
    pi.simulate(null);
    await pi.start();
    expect((await pi.health()).boot_id).not.toBe(before);

    await kitchen.core.print.flush();
    expect(jobOf(kitchen, id)).toMatchObject({ state: "unknown", error: "interrupted", printer_id: printer.id, boot_id: before });
    await kitchen.core.print.flush();
    expect(pi.printed()).not.toContain(id);
    expect(kitchen.net.submits(id)).toHaveLength(1);

    // Der Anwender sagt „nicht gedruckt" und druckt neu: ein neues Etikett, genau einmal.
    await kitchen.core.print.resolveUnknown(id, false);
    const again = await kitchen.core.print.retry(id);
    await kitchen.core.print.flush();
    await settled(kitchen, again.id, "printed");
    expect(pi.printed().filter((entry) => entry === again.id || entry === id)).toEqual([again.id]);
    await kitchen.sync();
    expect(jobOf(kitchen, id)).toMatchObject({ state: "failed", error: "not_printed" });
  });

  it("macht ein Etikett unklar, wenn der Server mitten im Druck endet; nach dem Neustart wird es nicht gedruckt", async () => {
    const kitchen = await signedIn(server.url, "Küche");
    const cellar = await signedIn(server.url, "Keller");
    const raw = await RawClient.login(server.url);
    const printer = await serverPrinter(kitchen);
    await kitchen.core.settings.update({ default_printer_id: printer.id });
    const [id] = (await storeWithLabels(kitchen, "Hirse N4")) as [string];
    await kitchen.sync();
    simulateIn(serverImageDir(server), "hang");
    expect(await kitchen.core.print.flush()).toMatchObject({ delivered: 1, pending: 0 });
    await cellar.sync();
    await until(async () => {
      await cellar.sync();
      return jobOf(cellar, id).state === "printing";
    }, "Der Server druckt (hängt)");

    await server.stop();
    simulateIn(serverImageDir(server), null);
    await server.start();

    // Der Server hat das Etikett selbst als unklar fortgeschrieben, ohne Zutun eines Geräts.
    await cellar.sync();
    expect(jobOf(cellar, id)).toMatchObject({ state: "unknown", error: "interrupted", printer_id: printer.id });
    await kitchen.sync();
    expect(jobOf(kitchen, id)).toMatchObject({ state: "unknown", error: "interrupted" });
    await kitchen.core.print.flush();
    await kitchen.sync();
    expect(jobOf(kitchen, id).state).toBe("unknown");
    expect(serverPrinted()).not.toContain(id);
    await expectSameAsServer(kitchen, raw);
  });

  it("druckt einmal, wenn zwei Tabs desselben Geräts gleichzeitig zustellen", async () => {
    const kitchen = await signedIn(server.url, "Küche");
    const atServer = await serverPrinter(kitchen);
    const atPi = await directPrinter(kitchen);
    const zone = await kitchen.core.zones.create({ name: "Keller", printer_id: atPi.id });
    await kitchen.core.settings.update({ default_printer_id: atServer.id });
    const direct = await storeWithLabels(kitchen, "Gerste N5", 2, zone.id);
    const viaServer = await storeWithLabels(kitchen, "Gerste N6", 2);
    await kitchen.sync();
    const tab = await kitchen.secondTab();

    const reports = await Promise.all([kitchen.core.print.flush(), tab.print.flush(), kitchen.core.print.flush(), tab.print.flush()]);
    expect(reports.reduce((sum, report) => sum + report.delivered, 0)).toBe(4);
    for (const id of [...direct, ...viaServer]) {
      await settled(kitchen, id, "printed");
      expect(kitchen.net.submits(id)).toHaveLength(1);
    }
    expect(pi.printed().filter((entry) => direct.some((id) => entry.startsWith(id)))).toEqual([...direct].sort());
    expect(serverPrinted().filter((entry) => viaServer.some((id) => entry.startsWith(id)))).toEqual([...viaServer].sort());
  });
});

describe("Verwerfen, übernehmen, abgelehnt, gelöscht", () => {
  it("verwirft beim Dienst, solange der Auftrag wartet; einen druckenden nicht", async () => {
    const kitchen = await signedIn(server.url, "Küche");
    const raw = await RawClient.login(server.url);
    const printer = await directPrinter(kitchen);
    await kitchen.core.settings.update({ default_printer_id: printer.id });
    pi.simulate("hang");
    const [printing, waiting] = (await storeWithLabels(kitchen, "Dinkel V1", 2)) as [string, string];
    expect(await kitchen.core.print.flush()).toMatchObject({ delivered: 2 });
    await until(async () => (await serviceJob(printing))?.state === "printing", "Der Pi druckt (hängt)");
    expect((await serviceJob(waiting))?.state).toBe("queued");

    await kitchen.core.print.cancel(waiting);
    expect(jobOf(kitchen, waiting)).toMatchObject({ state: "cancelled", printer_id: printer.id });
    expect(await serviceJob(waiting)).toMatchObject({ state: "failed", error: { code: "cancelled" } });

    // Zu spät: Der Dienst druckt schon. Das Etikett zeigt, was der Dienst sagt.
    await expectCoreError(kitchen.core.print.cancel(printing), "invalid");
    expect(["queued", "printing"]).toContain(jobOf(kitchen, printing).state);

    pi.simulate(null);
    await kitchen.core.print.flush();
    await settled(kitchen, printing, "printed");
    expect(pi.printed()).toContain(printing);
    expect(pi.printed()).not.toContain(waiting);
    await kitchen.sync();
    await expectSameAsServer(kitchen, raw);
    expect(jobOf(kitchen, waiting).state).toBe("cancelled");
  });

  it("verwirft am Server, solange der Auftrag wartet", async () => {
    const kitchen = await signedIn(server.url, "Küche");
    const raw = await RawClient.login(server.url);
    const printer = await serverPrinter(kitchen);
    await kitchen.core.settings.update({ default_printer_id: printer.id });
    const [printing, waiting] = (await storeWithLabels(kitchen, "Dinkel V2", 2)) as [string, string];
    await kitchen.sync();
    simulateIn(serverImageDir(server), "hang");
    expect(await kitchen.core.print.flush()).toMatchObject({ delivered: 2 });

    await kitchen.core.print.cancel(waiting);
    expect(jobOf(kitchen, waiting).state).toBe("cancelled");
    await expectCoreError(kitchen.core.print.cancel(printing), "invalid");

    simulateIn(serverImageDir(server), null);
    await kitchen.core.print.flush();
    await settled(kitchen, printing, "printed");
    await kitchen.sync();
    const snapshot = await expectSameAsServer(kitchen, raw);
    expect(snapshot.print_jobs.find((job) => job.id === waiting)?.state).toBe("cancelled");
    expect(serverPrinted()).toContain(printing);
    expect(serverPrinted()).not.toContain(waiting);
  });

  it("übernimmt das ausstehende Etikett eines anderen Geräts; das andere druckt es nicht mehr", async () => {
    const kitchen = await signedIn(server.url, "Küche");
    const cellar = await signedIn(server.url, "Keller");
    const raw = await RawClient.login(server.url);
    const printer = await serverPrinter(kitchen);
    await kitchen.core.settings.update({ default_printer_id: printer.id });
    const [foreign] = (await storeWithLabels(kitchen, "Roggen U1")) as [string];
    await kitchen.sync();
    await cellar.sync();

    // Der Keller sieht das Etikett der Küche: zustellen kann es nur die Küche.
    expect(jobOf(cellar, foreign)).toMatchObject({ state: "pending", device_id: kitchen.session.id });
    expect(await cellar.core.print.flush()).toEqual({ delivered: 0, pending: 0, problems: [] });
    const mine = await cellar.core.print.retry(foreign);
    expect(mine).toMatchObject({ state: "pending", device_id: cellar.session.id, package_id: jobOf(cellar, foreign).package_id });
    expect(jobOf(cellar, foreign).state).toBe("cancelled");
    await cellar.sync();
    await cellar.core.print.flush();
    await settled(cellar, mine.id, "printed");

    // Die Küche hat noch nicht abgeglichen und will zustellen: Der Server lehnt ab (verworfen).
    expect(jobOf(kitchen, foreign).state).toBe("pending");
    const report = await kitchen.core.print.flush();
    expect(report.delivered).toBe(0);
    expect(kitchen.net.submits(foreign).map((call) => call.status)).toEqual([409]);
    await kitchen.sync();
    expect(jobOf(kitchen, foreign).state).toBe("cancelled");
    expect(await kitchen.core.print.flush()).toEqual({ delivered: 0, pending: 0, problems: [] });
    expect(serverPrinted()).toContain(mine.id);
    expect(serverPrinted()).not.toContain(foreign);
    await expectSameAsServer(kitchen, raw);
  });

  it("verwirft die Etiketten einer Packung, deren ID ein anderes Gerät schon vergeben hat", async () => {
    const cellar = await signedIn(server.url, "Keller");
    const raw = await RawClient.login(server.url);
    const printer = await serverPrinter(cellar);
    await cellar.core.settings.update({ default_printer_id: printer.id });
    await cellar.sync();
    const zone = firstZone(cellar);
    const stored = await cellar.core.stock.store({ product: { kind: "new", name: "Reis K1" }, zone_id: zone.id, best_before: null, count: 1, labels: true });
    const clash = stored.packages[0]?.id ?? "";
    const label = stored.print_jobs[0]?.id ?? "";

    // Ein anderes Gerät legt inzwischen eine Packung mit derselben ID an.
    const foreignProduct = "0c0ffee0-0000-4000-8000-00000000e001";
    await raw.send([
      { type: "product.create", product_id: foreignProduct, name: "Fremdes Produkt K1" },
      { type: "package.create", package_id: clash, product_id: foreignProduct, zone_id: zone.id, best_before: null },
    ]);

    await cellar.trySync();
    expect(value(cellar.core.sync.problems)).toMatchObject([{ status: "rejected", code: "id_conflict" }]);
    await cellar.sync();
    expect(await cellar.core.print.flush()).toMatchObject({ delivered: 0, pending: 0 });
    expect(cellar.net.submits()).toEqual([]);
    const snapshot = await expectSameAsServer(cellar, raw);
    const onServer = snapshot.print_jobs.find((job) => job.id === label);
    expect(onServer === undefined || onServer.state === "cancelled").toBe(true);
    expect(serverPrinted()).not.toContain(label);
  });

  it("setzt beim Löschen eines Druckers Standarddrucker und Zonen zurück; ausstehende Etiketten folgen der Regel", async () => {
    const kitchen = await signedIn(server.url, "Küche");
    const raw = await RawClient.login(server.url);
    const first = await serverPrinter(kitchen, "Erster");
    const second = await serverPrinter(kitchen, "Zweiter");
    const zone = await kitchen.core.zones.create({ name: "Speisekammer", printer_id: first.id });
    await kitchen.core.settings.update({ default_printer_id: first.id });
    const [inZone] = (await storeWithLabels(kitchen, "Grieß G1", 1, zone.id)) as [string];
    const [byDefault] = (await storeWithLabels(kitchen, "Grieß G2")) as [string];
    await kitchen.sync();

    await kitchen.core.printers.remove(first.id);
    // Lokal wie am Server: Verweise auf den gelöschten Drucker sind danach null.
    expect(value(kitchen.core.data.settings).default_printer_id).toBeNull();
    expect(value(kitchen.core.data.zones).find((candidate) => candidate.id === zone.id)?.printer_id).toBeNull();
    expect(await kitchen.core.print.flush()).toMatchObject({ delivered: 0, pending: 2, problems: [{ printer_id: null, problem: "no_printer" }] });
    await kitchen.sync();
    const snapshot = await expectSameAsServer(kitchen, raw);
    expect(snapshot.settings?.default_printer_id).toBeNull();
    expect(snapshot.zones.find((candidate) => candidate.id === zone.id)?.printer_id).toBeNull();

    // Mit einem neuen Standarddrucker gehen sie dorthin.
    await kitchen.core.settings.update({ default_printer_id: second.id });
    await kitchen.sync();
    expect(await kitchen.core.print.flush()).toMatchObject({ delivered: 2, pending: 0 });
    await settled(kitchen, inZone, "printed");
    await settled(kitchen, byDefault, "printed");
    expect(jobOf(kitchen, inZone).printer_id).toBe(second.id);
  });

  it("klärt ein vielleicht schon abgeschicktes Etikett beim gelöschten Drucker, solange er erreichbar ist", async () => {
    const kitchen = await signedIn(server.url, "Küche");
    const printer = await directPrinter(kitchen);
    await kitchen.core.settings.update({ default_printer_id: printer.id });
    const [sent, later] = (await storeWithLabels(kitchen, "Polenta G3", 2)) as [string, string];

    // Das erste geht hinaus, die Antwort geht verloren (der Pi druckt es); das zweite bleibt deshalb liegen.
    kitchen.net.loseSubmitResponses = 1;
    expect(await kitchen.core.print.flush()).toMatchObject({ delivered: 0, pending: 2 });
    await until(() => pi.printed().includes(sent), "Der Pi hat das erste gedruckt");
    expect(kitchen.net.submits(later)).toEqual([]);

    await kitchen.core.printers.remove(printer.id);
    // Das vielleicht schon abgeschickte bleibt bei seinem Drucker, und der klärt es. Das andere hat keinen Drucker mehr.
    const report = await kitchen.core.print.flush();
    expect(report.problems).toContainEqual(expect.objectContaining({ printer_id: null, problem: "no_printer" }));
    await settled(kitchen, sent, "printed");
    expect(jobOf(kitchen, later).state).toBe("pending");
    expect(pi.printed().filter((entry) => entry.startsWith(sent) || entry.startsWith(later))).toEqual([sent]);
    expect(kitchen.net.submits(sent)).toHaveLength(2);
  });

  it("lässt Etiketten beim gelöschten, nicht mehr erreichbaren Drucker verwerfen, auch ein dort wartendes", async () => {
    const kitchen = await signedIn(server.url, "Küche");
    const raw = await RawClient.login(server.url);
    const printer = await directPrinter(kitchen);
    await kitchen.core.settings.update({ default_printer_id: printer.id });
    // Eines wartet beim Pi (sein Druck hängt), eines ging hinaus, ohne dass eine Antwort kam.
    pi.simulate("hang");
    const [waiting] = (await storeWithLabels(kitchen, "Polenta G4")) as [string];
    expect(await kitchen.core.print.flush()).toMatchObject({ delivered: 1 });
    expect(jobOf(kitchen, waiting).state).toBe("queued");
    const [sent] = (await storeWithLabels(kitchen, "Polenta G5")) as [string];
    kitchen.net.loseSubmitResponses = 1;
    await kitchen.core.print.flush();
    expect(kitchen.net.submits(sent).map((call) => call.lost)).toEqual([true]);

    // Der Drucker wird gelöscht, und der Pi ist nicht mehr zu erreichen.
    await kitchen.core.printers.remove(printer.id);
    kitchen.net.unreachable.add(pi.url);
    const report = await kitchen.core.print.flush();
    expect(report).toMatchObject({ pending: 1, problems: [{ printer_id: printer.id, problem: "unreachable" }] });
    expect(jobOf(kitchen, sent).state).toBe("pending");
    expect(jobOf(kitchen, waiting).state).toBe("queued");

    // Beide lassen sich verwerfen, ohne auf den Pi zu warten.
    await kitchen.core.print.cancel(sent);
    await kitchen.core.print.cancel(waiting);
    await kitchen.sync();
    const snapshot = await expectSameAsServer(kitchen, raw);
    for (const id of [sent, waiting]) {
      expect(snapshot.print_jobs.find((job) => job.id === id)?.state).toBe("cancelled");
    }
    expect(await kitchen.core.print.flush()).toMatchObject({ delivered: 0, pending: 0, problems: [] });
  });
});

describe("Druckdienst im Server aus", () => {
  it("lässt die Etiketten ausstehen und sagt, woran es liegt", async () => {
    // Der Dienst lässt sich nicht starten: Wo sein Verzeichnis hingehört, liegt eine Datei.
    const broken = await startServer({ prepareData: (dataDir) => writeFileSync(join(dataDir, "print"), "kein Verzeichnis", "utf8") });
    try {
      const kitchen = await signedIn(broken.url, "Küche");
      const printer = await serverPrinter(kitchen);
      await kitchen.core.settings.update({ default_printer_id: printer.id });
      const [id] = (await storeWithLabels(kitchen, "Quinoa S1")) as [string];
      await kitchen.sync();

      const health = await fetch(`${broken.url}/print/v1/health`, { headers: { authorization: "Bearer falsch" } });
      expect(health.status).toBe(503);
      expect(await health.json()).toMatchObject({ error: { code: "queue_full" } });

      // Der Server antwortet, nur sein Druckdienst nicht: Das ist etwas anderes als „nicht erreichbar".
      const report = await kitchen.core.print.flush();
      expect(report).toMatchObject({ delivered: 0, pending: 1, problems: [{ printer_id: printer.id, problem: "unavailable" }] });
      expect(await kitchen.core.printers.probe(printer.id)).toMatchObject({ reachable: false, problem: "unavailable", error: expect.stringContaining("Log des Servers") });
      expect(kitchen.net.submits()).toEqual([]);
      expect(jobOf(kitchen, id).state).toBe("pending");
      // Abgleichen geht trotzdem.
      await kitchen.sync();
      expect(value(kitchen.core.sync.status)).toMatchObject({ online: true, last_error: null });
    } finally {
      await disposeDevices();
      await broken.dispose();
    }
  });
});

describe("Notweg über die Seite des Druckdienstes", () => {
  it("übergibt die nie abgeschickten Etiketten; die Seite druckt sie einmal, die App erfährt es danach", async () => {
    const kitchen = await signedIn(server.url, "Küche");
    const printer = await directPrinter(kitchen);
    await kitchen.core.settings.update({ default_printer_id: printer.id });

    // Eines ging schon einmal hinaus (Antwort verloren): Es gehört nicht in die Übergabe.
    const [sent] = (await storeWithLabels(kitchen, "Amaranth P1")) as [string];
    kitchen.net.loseSubmitResponses = 1;
    await kitchen.core.print.flush();
    expect(kitchen.net.submits(sent)).toHaveLength(1);

    // Jetzt lässt der Browser die App nicht mehr zum Pi.
    kitchen.net.unreachable.add(pi.url);
    const fresh = await storeWithLabels(kitchen, "Amaranth P2", 2);
    expect(await kitchen.core.print.flush()).toMatchObject({ delivered: 0, pending: 3, problems: [{ printer_id: printer.id, problem: "unreachable" }] });

    const { url, jobs } = await kitchen.core.print.handoff(printer.id);
    expect(jobs.map((job) => job.id).sort()).toEqual([...fresh].sort());
    expect(jobs.every((job) => job.state === "unknown" && job.error === "handoff")).toBe(true);
    expect(jobOf(kitchen, sent).state).toBe("pending");
    expect(url.startsWith(`${pi.url}/p#`)).toBe(true);
    const fragment = url.slice(url.indexOf("#") + 1);
    expect(fragment).toMatch(/^[A-Za-z0-9_-]+$/);
    const payload = JSON.parse(Buffer.from(fragment, "base64url").toString("utf8")) as {
      v: number;
      token: string;
      printer: string | null;
      template: Record<string, unknown>;
      jobs: { id: string; data: Record<string, string> }[];
      back: string | null;
    };
    expect(payload).toMatchObject({ v: 1, token: pi.token, printer: null, template: { schema: 1, name: "package-62x29" } });
    expect(payload.jobs.map((job) => job.id).sort()).toEqual([...fresh].sort());

    // Was die Seite `/p` tut: Zustand abfragen, dann der Reihe nach einreichen, wie ein Browser ohne Vorabanfrage.
    const page = await fetch(`${pi.url}/p`);
    expect(page.headers.get("content-type")).toMatch(/^text\/html/);
    const submitAll = async (): Promise<number[]> => {
      const boot = (await pi.health()).boot_id;
      const statuses: number[] = [];
      for (const job of payload.jobs) {
        const response = await fetch(`${pi.url}/v1/jobs/${encodeURIComponent(job.id)}?wait=30`, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: JSON.stringify({ token: payload.token, printer: payload.printer, template: payload.template, data: job.data, copies: 1, cut: true, expect_boot_id: boot }),
        });
        statuses.push(response.status);
        expect(((await response.json()) as ServiceJob).state).toBe("printed");
      }
      return statuses;
    };
    expect(await submitAll()).toEqual([201, 201]);
    // Dieselbe Adresse ein zweites Mal: nichts doppelt.
    expect(await submitAll()).toEqual([200, 200]);
    expect(pi.printed().filter((entry) => fresh.some((id) => entry.startsWith(id)))).toEqual([...fresh].sort());

    // Zurück in Reichweite: Die App fragt nach und übernimmt den Zustand; das andere klärt sich auf dem normalen Weg.
    kitchen.net.unreachable.delete(pi.url);
    await kitchen.core.print.flush();
    for (const id of [...fresh, sent]) {
      await settled(kitchen, id, "printed");
    }
    expect(pi.printed().filter((entry) => entry.startsWith(sent))).toEqual([sent]);
    await expectCoreError(kitchen.core.print.handoff(printer.id), "not_found");
    await kitchen.sync();
  });
});
