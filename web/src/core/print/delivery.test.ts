/**
 * Etiketten zustellen (docs/etiketten.md, 4.1 und Abschnitt 5): der echte Kern gegen die
 * nachgebauten Druckdienste, am „Server" (`/print`) und direkt am „Pi" (eigene Adresse).
 *
 * Der Kern stellt hier nur zu, wenn der Test es sagt (`print.flush()`), außer ein Test will
 * gerade das selbsttätige Zustellen sehen.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PrintJob, StoreResult } from "@/contract";
import { MAX_HANDOFF_JOBS } from "@/contract";

import type { CoreOptions, StowlyCore } from "..";
import { SYNC_FIRST_MAX_WAIT_MS } from "../api/runtime";
import { SENDING_MARK_TTL_MS } from "../store";
import type { SchedulerTimers } from "../sync/scheduler";
import { FakePrintService, type FakeCall, type FakeLink, type FakePrintOptions } from "../testing/fake-api";
import { commandsOf, disposeAll, expectCoreError, firstZoneId, signedIn, value, type Harness } from "../testing/harness";
import type { PermissionReading } from "./address";
import { HEALTH_TIMEOUT_MS } from "./client";
import { healthTimeout, PERMISSION_PROMPT_BUDGET_MS, PERMISSION_PROMPT_TIMEOUT_MS } from "./connect";

const HTTPS = "https://10.71.83.1:8443";
const HTTP = "http://10.71.83.1:8080";

afterEach(async () => {
  await disposeAll();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------------------------------
// Hilfen
// ------------------------------------------------------------------------------------------

/** Ein Haushalt mit einem Drucker am Server (Bild-Treiber) als Standarddrucker. */
async function withServerPrinter(core: CoreOptions = {}): Promise<Harness & { printerId: string }> {
  const harness = await signedIn({ core });
  const printer = await harness.core.printers.create({ name: "Küche", connection: "server", server: { driver: "image", model: null, address: null, media: "62" } });
  await harness.core.settings.update({ default_printer_id: printer.id });
  await harness.core.sync.now();
  return { ...harness, printerId: printer.id };
}

interface PiHarness extends Harness {
  printerId: string;
  pi: FakePrintService;
  https: FakeLink;
  http: FakeLink;
  /** Die Anfragen, die den Pi erreicht haben. */
  piCalls(): FakeCall[];
}

/** Ein Haushalt mit einem direkten Drucker (Pi) als Standarddrucker, erreichbar über HTTPS und HTTP. */
async function withPi(core: CoreOptions = {}, direct: { printer?: string | null; token?: string } = {}, service: FakePrintOptions = {}): Promise<PiHarness> {
  const harness = await signedIn({ core });
  const pi = new FakePrintService({ now: harness.clock.now, ...service });
  const https = harness.network.attach(HTTPS, pi);
  const http = harness.network.attach(HTTP, pi);
  const printer = await harness.core.printers.create({
    name: "Keller-Pi",
    connection: "direct",
    direct: { urls: [HTTPS, HTTP], token: direct.token ?? pi.token, printer: direct.printer ?? null },
  });
  await harness.core.settings.update({ default_printer_id: printer.id });
  await harness.core.sync.now();
  return { ...harness, printerId: printer.id, pi, https, http, piCalls: () => harness.network.calls.filter((call) => call.base !== null) };
}

/** Lagert Packungen eines neuen Produkts ein und fordert je Packung ein Etikett an. */
function storeLabelled(core: StowlyCore, count = 1, name = "Basmati Reis"): Promise<StoreResult> {
  return core.stock.store({ product: { kind: "new", name, brand: "Kornhaus", quantity: "1 kg" }, zone_id: firstZoneId(core), best_before: "2027-03-25", count, labels: true });
}

function jobOf(core: StowlyCore, id: string | undefined): PrintJob {
  const job = value(core.data.printJobs).find((candidate) => candidate.id === id);
  if (!job) {
    throw new Error(`Das Etikett ${id} gibt es nicht.`);
  }
  return job;
}

const isSubmit = (call: FakeCall) => call.method === "POST" && /^(\/print)?\/v1\/jobs\/[^/]+$/.test(call.path);

/** Die Befehle einer Art, die der Server bisher bekommen hat. */
function sent(harness: Harness, type: string): Record<string, unknown>[] {
  return harness.server.syncRequests.flatMap((request) => commandsOf(request)).filter((command) => command.type === type);
}

/**
 * Zeitgeber von Hand: sammelt, was der Kern vormerkt, und führt es auf Wunsch aus. Abgleich und
 * Zustellen teilen sich die Zeitgeber; die Prüfung nebenbei des Abgleichs (15 Sekunden) liegt
 * dabei neben dem zweiten Zustellversuch (auch 15 Sekunden). `fire` führt deshalb alle aus, die
 * mit dieser Wartezeit vorgemerkt sind.
 */
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
    delays: () => [...pending.values()].map((entry) => entry.delay),
    fire(delay: number) {
      const due = [...pending].filter(([, entry]) => entry.delay === delay);
      if (due.length === 0) {
        throw new Error(`Kein Zeitgeber mit ${delay} ms; vorgemerkt: ${[...pending.values()].map((entry) => entry.delay).join(", ")}`);
      }
      for (const [handle, entry] of due) {
        pending.delete(handle);
        entry.callback();
      }
    },
    /** Führt alles aus, was gerade vorgemerkt ist (was dabei abgeräumt wird, nicht mehr). */
    fireAll() {
      for (const [handle, entry] of [...pending]) {
        if (pending.delete(handle)) {
          entry.callback();
        }
      }
    },
  };
}

/** Lässt alles laufen, was gerade ansteht (für „es passiert nichts"). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/** Ein Versprechen, das der Test selbst erfüllt. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

// ------------------------------------------------------------------------------------------

describe("Etikett an den Drucker am Server", () => {
  it("wird nach dem Abgleich zugestellt und gedruckt; die Meldung kommt beim Server an", async () => {
    const harness = await withServerPrinter();
    const { core, server, network, printerId } = harness;
    const stored = await storeLabelled(core);
    const jobId = stored.print_jobs[0]?.id ?? "";

    // Vor dem Abgleich gibt es das Etikett im Server nicht: „Jetzt drucken" gleicht deshalb zuerst ab.
    expect(sent(harness, "print.request")).toEqual([]);
    const report = await core.print.flush();
    expect(report).toEqual({ delivered: 1, pending: 0, problems: [] });
    expect(sent(harness, "print.request")).toMatchObject([{ job_id: jobId }]);
    const firstSubmit = network.calls.findIndex(isSubmit);
    const lastSync = network.calls.map((call) => call.path).lastIndexOf("/api/sync", firstSubmit);
    expect(lastSync).toBeGreaterThanOrEqual(0);
    expect(jobOf(core, jobId)).toMatchObject({ state: "printed", printer_id: printerId, boot_id: server.print.bootId, error: null });

    // Genau ein Druck, mit den Daten des Etiketts und der Vorlage des Haushalts.
    expect(server.print.printed).toEqual([jobId]);
    // Seit 0.5.0 stehen alle Felder drin, auch die Zone bei nur einer Zone: Was gedruckt wird, entscheidet die Vorlage.
    expect(server.print.prints[0]?.data).toMatchObject({
      qr: `STOWLY/P/${stored.packages[0]?.id}`,
      id: stored.packages[0]?.id,
      title: "Basmati Reis",
      subtitle: "1 kg · Kornhaus",
      best_before: "25.03.2027",
      zone: "Vorrat",
      brand: "Kornhaus",
      quantity: "1 kg",
      best_before_short: "25.03.27",
    });

    // Am Server: Geräte-Token im Kopf, gewöhnliches JSON, der Drucker unter seiner Kennung.
    // Auf Wunsch des Anwenders (`flush`) wird eingereicht, ohne auf den Druck zu warten.
    const submit = network.calls.find(isSubmit);
    expect(submit).toMatchObject({ path: `/print/v1/jobs/${jobId}`, query: "wait=0", base: null });
    expect(submit?.token).toBe(network.calls.find((call) => call.path === "/api/sync")?.token);
    expect(submit?.headers["content-type"]).toBe("application/json");
    expect(submit?.body).toMatchObject({ printer: printerId, copies: 1, cut: true, expect_boot_id: server.print.bootId, template: { schema: 1, name: "package-62x29" } });
    expect(submit?.body).not.toHaveProperty("token");

    // Der Endzustand kam schon mit der Antwort: eine Meldung genügt, mit Drucker und boot_id.
    await core.sync.now();
    expect(sent(harness, "print.report")).toMatchObject([{ job_id: jobId, state: "printed", printer_id: printerId, boot_id: server.print.bootId }]);
    // Für Drucker am Server meldet kein Gerät den Zustand: Der Server schreibt selbst.
    expect(sent(harness, "printer.report")).toEqual([]);
    expect(value(core.data.printerStatus)).toMatchObject([{ printer_id: printerId, host: null, status: { reachable: true } }]);
  });

  it("gleicht vor „Verbindung prüfen“ ab, solange der Server einen eben angelegten Drucker noch nicht kennt", async () => {
    const harness = await signedIn({});
    const printer = await harness.core.printers.create({ name: "Küche", connection: "server", server: { driver: "image", model: null, address: null, media: "62" } });
    expect(sent(harness, "printer.create")).toEqual([]);
    expect(await harness.core.printers.probe(printer.id)).toMatchObject({ reachable: true, problem: null, error: null });
    expect(sent(harness, "printer.create")).toMatchObject([{ printer_id: printer.id }]);
    // Ist er abgeglichen, geht die Abfrage gleich hin.
    const syncs = harness.server.syncRequests.length;
    await harness.core.printers.probe(printer.id);
    expect(harness.server.syncRequests).toHaveLength(syncs);
  });

  it("wartet bei „Jetzt drucken“ höchstens 10 Sekunden auf den Abgleich; was der Server noch nicht kennt, geht danach hinaus", async () => {
    const manual = manualTimers();
    const harness = await withServerPrinter({ autoSync: true, timers: manual.timers });
    const { core, server, network } = harness;
    const stored = await storeLabelled(core);
    const jobId = stored.print_jobs[0]?.id ?? "";

    // Der Server ist langsam: Der Abgleich hängt.
    const slow = gate();
    network.beforeRequest = async (call) => {
      if (call.path === "/api/sync") {
        await slow.promise;
      }
    };
    let flushed = false;
    const flushing = core.print.flush().finally(() => {
      flushed = true;
    });
    await vi.waitFor(() => expect(manual.delays()).toContain(SYNC_FIRST_MAX_WAIT_MS));
    await settle();
    expect(flushed).toBe(false);
    expect(SYNC_FIRST_MAX_WAIT_MS).toBe(10_000);

    // Nach 10 Sekunden geht es weiter: Der Server kennt das Etikett noch nicht, es bleibt ausstehend.
    manual.fire(SYNC_FIRST_MAX_WAIT_MS);
    expect(await flushing).toEqual({ delivered: 0, pending: 1, problems: [] });
    expect(network.calls.some(isSubmit)).toBe(false);
    expect(jobOf(core, jobId).state).toBe("pending");
    expect(value(core.sync.status).phase).toBe("syncing");

    // Der Abgleich läuft weiter; ist er fertig, geht das Etikett von selbst hinaus.
    network.beforeRequest = null;
    slow.open();
    await vi.waitFor(() => expect(server.print.printed).toEqual([jobId]));
    await vi.waitFor(() => expect(jobOf(core, jobId).state).toBe("printed"));
  });

  it("wartet bei „Verbindung prüfen“ höchstens 10 Sekunden; kennt der Server den Drucker dann noch nicht, sagt die Abfrage das", async () => {
    const manual = manualTimers();
    const harness = await signedIn({ core: { timers: manual.timers } });
    const { core, network } = harness;
    const printer = await core.printers.create({ name: "Küche", connection: "server", server: { driver: "image", model: null, address: null, media: "62" } });

    const slow = gate();
    network.beforeRequest = async (call) => {
      if (call.path === "/api/sync") {
        await slow.promise;
      }
    };
    const probing = core.printers.probe(printer.id);
    await vi.waitFor(() => expect(manual.delays()).toContain(SYNC_FIRST_MAX_WAIT_MS));
    manual.fire(SYNC_FIRST_MAX_WAIT_MS);
    expect(await probing).toMatchObject({ reachable: true, url: null, problem: "unknown_printer" });

    // Der Abgleich läuft zu Ende; danach kennt der Server den Drucker.
    network.beforeRequest = null;
    slow.open();
    await vi.waitFor(() => expect(sent(harness, "printer.create")).toMatchObject([{ printer_id: printer.id }]));
    await vi.waitFor(() => expect(value(core.sync.status).pending).toBe(0));
    expect(await core.printers.probe(printer.id)).toMatchObject({ reachable: true, problem: null });
    expect(manual.delays()).toEqual([]);
  });

  it("lässt das Etikett ausstehen, wenn der Server nicht erreichbar ist, und stellt später zu", async () => {
    const { core, network, server, printerId } = await withServerPrinter();
    const stored = await storeLabelled(core);
    await core.sync.now();
    network.offline = true;
    const report = await core.print.flush();
    expect(report).toMatchObject({ delivered: 0, pending: 1, problems: [{ printer_id: printerId, problem: "offline" }] });
    expect(report.problems[0]?.message).not.toBe("");
    expect(jobOf(core, stored.print_jobs[0]?.id).state).toBe("pending");

    network.offline = false;
    expect(await core.print.flush()).toMatchObject({ delivered: 1, pending: 0 });
    expect(server.print.printed).toHaveLength(1);
  });

  it("lässt ausstehen, was der Server schon als verworfen führt, und druckt es nicht", async () => {
    const { core, server } = await withServerPrinter();
    const stored = await storeLabelled(core);
    const jobId = stored.print_jobs[0]?.id ?? "";
    await core.sync.now();
    // Ein anderes Gerät hat das Etikett inzwischen verworfen; hier ist das noch nicht angekommen.
    server.act({ type: "print.report", job_id: jobId, state: "cancelled" });

    expect(await core.print.flush()).toMatchObject({ delivered: 0, pending: 1 });
    expect(server.print.printed).toEqual([]);
    // Der Abgleich bringt den wahren Zustand.
    await core.sync.now();
    expect(jobOf(core, jobId).state).toBe("cancelled");
    expect(await core.print.flush()).toMatchObject({ delivered: 0, pending: 0 });
  });

  it("meldet das Gerät ab, wenn der Druckdienst des Servers das Token ablehnt, und behält alles", async () => {
    const { core, server } = await withServerPrinter();
    const stored = await storeLabelled(core);
    await core.sync.now();
    server.revoke();
    expect(await core.print.flush()).toMatchObject({ delivered: 0 });
    expect(value(core.session.state)).toMatchObject({ status: "signed_out", reason: "revoked" });
    expect(jobOf(core, stored.print_jobs[0]?.id).state).toBe("pending");
  });

  it("übernimmt, was der Dienst über einen wartenden Auftrag sagt, und fragt beim nächsten Versuch nach", async () => {
    const harness = await withServerPrinter();
    const { core, server, network, printerId } = harness;
    const stored = await storeLabelled(core);
    const jobId = stored.print_jobs[0]?.id ?? "";
    await core.sync.now();
    server.print.hangNext();

    expect(await core.print.flush()).toMatchObject({ delivered: 1, pending: 0 });
    expect(jobOf(core, jobId)).toMatchObject({ state: "queued", printer_id: printerId, boot_id: server.print.bootId });
    // Nachgefragt wird danach im Hintergrund, mit wait=10, höchstens sechsmal (eine Minute).
    const followUps = () => network.calls.filter((call) => call.method === "GET" && call.path === `/print/v1/jobs/${jobId}`);
    await vi.waitFor(() => expect(followUps().length).toBe(6));
    await settle();
    expect(followUps().length).toBe(6);
    expect(followUps().every((call) => call.query === "wait=10")).toBe(true);

    server.print.resume();
    await core.print.flush();
    expect(jobOf(core, jobId).state).toBe("printed");
    expect(network.calls.filter(isSubmit)).toHaveLength(1);
    await core.sync.now();
    // "queued", sobald der Dienst angenommen hat, dann der Endzustand.
    expect(sent(harness, "print.report").map((command) => command.state)).toEqual(["queued", "printed"]);
  });
});

describe("Direkt zum Pi", () => {
  it("geht sofort hinaus, auch ohne Server, über HTTPS und ohne Vorabanfrage", async () => {
    const harness = await withPi();
    const { core, network, pi, printerId } = harness;
    network.offline = true;
    const stored = await storeLabelled(core);
    const jobId = stored.print_jobs[0]?.id ?? "";
    network.calls.length = 0;

    expect(await core.print.flush()).toEqual({ delivered: 1, pending: 0, problems: [] });
    expect(pi.printed).toEqual([jobId]);
    expect(jobOf(core, jobId)).toMatchObject({ state: "printed", printer_id: printerId, boot_id: pi.bootId });

    const calls = harness.piCalls();
    expect(calls.map((call) => `${call.method} ${call.base}${call.path}`)).toEqual([`GET ${HTTPS}/v1/health`, `POST ${HTTPS}/v1/jobs/${jobId}`]);
    const [health, submit] = calls;
    // Lesend: GET ohne eigene Kopfzeilen.
    expect(health?.headers).toEqual({});
    // Mit dem Papier des Haushalts (seit 0.5.0): Die mitgelieferten Vorlagen nennen keines, also die 62-mm-Endlosrolle.
    expect(health?.query).toMatch(/^nonce=[A-Za-z0-9_-]{32}&media=62$/);
    // Schreibend: POST als text/plain, das Token im Rumpf, kein Authorization-Kopf.
    expect(submit?.headers).toEqual({ "content-type": "text/plain" });
    expect(submit?.body).toMatchObject({ token: pi.token, printer: null, copies: 1, cut: true, expect_boot_id: pi.bootId });
    for (const call of calls) {
      expect(call.preflight).toBe(false);
      expect(call.token).toBeNull();
      expect(call).toMatchObject({ cache: "no-store", credentials: "omit", targetAddressSpace: "local" });
    }
  });

  it("nimmt HTTP, wenn HTTPS nicht antwortet", async () => {
    const harness = await withPi();
    const { core, pi } = harness;
    harness.https.reachable = false;
    await storeLabelled(core);
    harness.network.calls.length = 0;
    expect(await core.print.flush()).toMatchObject({ delivered: 1, problems: [] });
    expect(pi.printed).toHaveLength(1);
    expect(harness.piCalls().every((call) => call.base === HTTP)).toBe(true);
    const probe = await core.printers.probe(harness.printerId);
    expect(probe).toMatchObject({ reachable: true, url: HTTP, problem: null, error: null });
    expect(probe.health?.boot_id).toBe(pi.bootId);
  });

  it("setzt den Adressraum passend zur Adresse", async () => {
    const harness = await signedIn();
    const pi = new FakePrintService();
    harness.network.attach("http://127.0.0.1:8041", pi);
    harness.network.attach("http://localhost:8042", pi);
    const printer = await harness.core.printers.create({ name: "Entwicklung", connection: "direct", direct: { urls: ["http://127.0.0.1:8041"], token: pi.token, printer: null } });
    await harness.core.printers.probe(printer.id);
    await harness.core.printers.update(printer.id, { direct: { urls: ["http://localhost:8042/"], token: pi.token, printer: null } });
    await harness.core.printers.probe(printer.id);
    expect(harness.network.calls.filter((call) => call.base !== null).map((call) => [call.base, call.targetAddressSpace])).toEqual([
      ["http://127.0.0.1:8041", "loopback"],
      ["http://localhost:8042", "loopback"],
    ]);
  });

  it("weist ab, was sich nicht als Stowly-Druckdienst mit diesem Token ausweist", async () => {
    const harness = await withPi({}, { token: "ein-anderes-token" });
    const { core, pi, printerId } = harness;
    await storeLabelled(core);
    harness.network.calls.length = 0;
    expect(await core.print.flush()).toMatchObject({ delivered: 0, pending: 1, problems: [{ printer_id: printerId, problem: "not_verified" }] });
    expect(pi.printed).toEqual([]);
    expect(harness.piCalls().filter(isSubmit)).toEqual([]);
    expect(await core.printers.probe(printerId)).toMatchObject({ reachable: false, url: null, health: null, problem: "not_verified" });
  });

  it("druckt ohne sicheren Kontext nicht direkt und schickt gar nichts hinaus", async () => {
    const harness = await withPi({ secureContext: false });
    const { core, printerId } = harness;
    await storeLabelled(core);
    expect(await core.print.flush()).toMatchObject({ delivered: 0, pending: 1, problems: [{ printer_id: printerId, problem: "insecure_context" }] });
    expect(await core.printers.probe(printerId)).toMatchObject({ reachable: false, problem: "insecure_context" });
    expect(harness.network.attempts).toEqual([]);
  });

  it("erkennt einen Dienst, der diese App nicht mitlesen lässt", async () => {
    const harness = await withPi();
    const { core, printerId } = harness;
    harness.https.reachable = false;
    harness.http.cors = false;
    await storeLabelled(core);
    harness.network.attempts.length = 0;
    expect(await core.print.flush()).toMatchObject({ delivered: 0, pending: 1, problems: [{ printer_id: printerId, problem: "blocked" }] });
    // Die zweite Anfrage ohne CORS kam an: Der Dienst ist da.
    expect(harness.network.attempts.filter((call) => call.base === HTTP).map((call) => call.mode)).toEqual([undefined, "no-cors"]);
  });

  it("fragt nach einer Zeitüberschreitung nicht noch ohne CORS nach, nur nach einem sofortigen Fehlschlag", async () => {
    const harness = await withPi();
    const { core, printerId } = harness;
    // HTTPS: Die Anfrage versickert (oder der Browser wartet auf den Anwender). HTTP: sofort abgewiesen.
    harness.https.silent = true;
    harness.http.reachable = false;
    await storeLabelled(core);
    harness.network.attempts.length = 0;
    expect(await core.print.flush()).toMatchObject({ delivered: 0, pending: 1, problems: [{ printer_id: printerId, problem: "unreachable" }] });
    expect(harness.network.attempts.map((call) => [call.base, call.mode ?? "cors"])).toEqual([
      [HTTPS, "cors"],
      [HTTP, "cors"],
      [HTTP, "no-cors"],
    ]);
  });

  it("lässt ausstehen, was den Dienst auf keiner Adresse erreicht, und stellt zu, sobald er wieder da ist", async () => {
    const harness = await withPi();
    const { core, pi, printerId } = harness;
    harness.https.reachable = false;
    harness.http.reachable = false;
    const stored = await storeLabelled(core);
    const report = await core.print.flush();
    expect(report).toMatchObject({ delivered: 0, pending: 1, problems: [{ printer_id: printerId, problem: "unreachable" }] });
    expect(jobOf(core, stored.print_jobs[0]?.id).state).toBe("pending");
    expect(await core.printers.probe(printerId)).toMatchObject({ reachable: false, problem: "unreachable" });

    harness.https.reachable = true;
    expect(await core.print.flush()).toMatchObject({ delivered: 1, pending: 0, problems: [] });
    expect(pi.printed).toHaveLength(1);
  });

  describe("Erlaubnis für das lokale Netzwerk", () => {
    it("schickt nichts hinaus, wenn der Browser sie verweigert hat", async () => {
      const harness = await withPi({ permissions: async () => "denied" });
      const { core, printerId } = harness;
      await storeLabelled(core);
      harness.network.attempts.length = 0;
      expect(await core.print.flush()).toMatchObject({ delivered: 0, pending: 1, problems: [{ printer_id: printerId, problem: "permission" }] });
      expect(await core.printers.probe(printerId)).toMatchObject({ reachable: false, problem: "permission" });
      expect(harness.network.attempts).toEqual([]);
    });

    it("wartet bei offener Nachfrage auf eine Handlung des Anwenders: selbsttätig nichts, mit flush ja", async () => {
      let permission: PermissionReading = "prompt";
      const manual = manualTimers();
      const harness = await withPi({ autoSync: true, timers: manual.timers, permissions: async () => permission });
      const { core, pi } = harness;
      harness.network.attempts.length = 0;
      const stored = await storeLabelled(core);
      await settle();
      // Die Anfrage würde die Nachfrage des Browsers auslösen: Von selbst geht nichts hinaus.
      expect(harness.network.attempts).toEqual([]);
      expect(jobOf(core, stored.print_jobs[0]?.id).state).toBe("pending");

      // Auf Wunsch des Anwenders darf sie kommen. (Hier erlaubt er.)
      const flushing = core.print.flush();
      permission = "granted";
      expect(await flushing).toMatchObject({ delivered: 1, pending: 0 });
      expect(pi.printed).toHaveLength(1);
    });

    it("merkt sich, wo der Browser trotz offener Erlaubnis gar nicht fragt, und stellt dort künftig von selbst zu", async () => {
      // Die App kommt selbst aus dem lokalen Netzwerk (Server zu Hause): Der Browser fragt nie,
      // meldet die Erlaubnis aber dauerhaft als „noch offen".
      const manual = manualTimers();
      const harness = await withPi({ autoSync: true, timers: manual.timers, permissions: async () => "prompt" });
      const { core, pi } = harness;
      harness.network.attempts.length = 0;
      await storeLabelled(core);
      await settle();
      expect(harness.network.attempts).toEqual([]);

      // Einmal auf Wunsch des Anwenders: Die Anfrage wird beantwortet, die Erlaubnis bleibt „offen".
      expect(await core.print.flush()).toMatchObject({ delivered: 1, pending: 0 });
      expect(pi.printed).toHaveLength(1);

      // Von da an geht es von selbst, auch nach dem Neuladen der App.
      await storeLabelled(core, 1, "Mais");
      await vi.waitFor(() => expect(pi.printed).toHaveLength(2));
      const reloaded = await harness.another();
      await storeLabelled(reloaded, 1, "Hirse");
      await vi.waitFor(() => expect(pi.printed).toHaveLength(3));
    });

    it("gibt dem Anwender auf seinen Wunsch hin Zeit, die Nachfrage zu beantworten", { timeout: 15_000 }, async () => {
      let permission: PermissionReading = "prompt";
      const harness = await withPi({ permissions: async () => permission });
      const { core, pi } = harness;
      await storeLabelled(core);
      // Der Browser hält die Anfragen an, solange seine Nachfrage offen ist (sie gilt für den Ursprung, also für beide Adressen).
      let answer!: () => void;
      const asking = new Promise<void>((resolve) => {
        answer = resolve;
      });
      harness.https.hold = asking;
      harness.http.hold = asking;
      const flushing = core.print.flush();
      // Der Anwender liest und tippt erst nach 2,5 s auf „Zulassen“: länger als die üblichen 1,5 s.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      permission = "granted";
      answer();
      expect(await flushing).toMatchObject({ delivered: 1, pending: 0, problems: [] });
      expect(pi.printed).toHaveLength(1);
      // Es ging nur die eine Anfrage an HTTPS, sie wurde nicht vorher aufgegeben.
      expect(harness.network.attempts.filter((call) => call.path === "/v1/health").map((call) => call.base)).toEqual([HTTPS]);
    });

    it("lässt es bei 1,5 s, wenn die Erlaubnis erteilt ist", { timeout: 15_000 }, async () => {
      const harness = await withPi({ permissions: async () => "granted" });
      const { core, printerId } = harness;
      await storeLabelled(core);
      harness.https.hold = new Promise<void>(() => undefined);
      harness.http.reachable = false;
      const started = Date.now();
      expect(await core.print.flush()).toMatchObject({ delivered: 0, pending: 1, problems: [{ printer_id: printerId, problem: "unreachable" }] });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(HEALTH_TIMEOUT_MS - 100);
      expect(elapsed).toBeLessThan(HEALTH_TIMEOUT_MS + 2_000);
    });

    it("verteilt die längere Zeitgrenze auf die Adressen eines Druckers: höchstens 20 s zusammen", () => {
      const start = 1_000_000;
      // Ohne mögliche Nachfrage (erteilt, unbekannt, „fragt nie“, selbsttätig) immer 1,5 s.
      expect(healthTimeout(false, start, start)).toBe(HEALTH_TIMEOUT_MS);
      // Die erste Anfrage, die die Nachfrage auslösen kann, bekommt 15 s.
      expect(PERMISSION_PROMPT_TIMEOUT_MS).toBe(15_000);
      expect(healthTimeout(true, start, start)).toBe(15_000);
      // Gab die erste nach 15 s auf, bleibt der zweiten der Rest bis 20 s.
      expect(PERMISSION_PROMPT_BUDGET_MS).toBe(20_000);
      expect(healthTimeout(true, start, start + 15_000)).toBe(5_000);
      // Scheiterte die erste sofort (Zertifikat, abgewiesen), hat die zweite fast die vollen 15 s.
      expect(healthTimeout(true, start, start + 200)).toBe(15_000);
      // Ist die Zeit fast aufgebraucht, gelten wenigstens die üblichen 1,5 s.
      expect(healthTimeout(true, start, start + 19_500)).toBe(HEALTH_TIMEOUT_MS);
      expect(healthTimeout(true, start, start + 40_000)).toBe(HEALTH_TIMEOUT_MS);
    });

    it("stellt von selbst zu, sobald der Anwender die Nachfrage beantwortet hat, auch nach der Zeitgrenze der Anfrage", async () => {
      let permission: PermissionReading = "prompt";
      const watcher: { onChange: (() => void) | null } = { onChange: null };
      const manual = manualTimers();
      const harness = await withPi({
        autoSync: true,
        timers: manual.timers,
        permissions: async () => permission,
        watchPermissions: (onChange) => {
          watcher.onChange = onChange;
          return () => {
            watcher.onChange = null;
          };
        },
      });
      const { core, pi } = harness;
      harness.network.attempts.length = 0;
      await storeLabelled(core);
      await settle();
      expect(harness.network.attempts).toEqual([]);

      // Die Nachfrage kam bei einem Versuch auf Wunsch des Anwenders; er erlaubt erst danach.
      permission = "granted";
      expect(watcher.onChange).not.toBeNull();
      watcher.onChange?.();
      await vi.waitFor(() => expect(pi.printed).toHaveLength(1));
    });

    it("stellt mit erteilter Erlaubnis von selbst zu, gleich nach dem Anfordern", async () => {
      const manual = manualTimers();
      const harness = await withPi({ autoSync: true, timers: manual.timers, permissions: async () => "granted" });
      const { core, pi } = harness;
      const stored = await storeLabelled(core, 2);
      await vi.waitFor(() => expect(pi.printed).toHaveLength(2));
      await vi.waitFor(() => expect(stored.print_jobs.map((job) => jobOf(core, job.id).state)).toEqual(["printed", "printed"]));
      // Von selbst wartet niemand auf den Bericht: Der Dienst darf beim Einreichen auf den Druck
      // warten, dann genügt eine Meldung je Etikett.
      expect(harness.piCalls().filter(isSubmit).map((call) => call.query)).toEqual(["wait=5", "wait=5"]);
    });
  });

  it("versucht es von selbst erneut: nach 5 und 15 Sekunden, solange Etiketten ausstehen", async () => {
    const manual = manualTimers();
    const harness = await withPi({ autoSync: true, timers: manual.timers });
    const { core, pi } = harness;
    harness.https.reachable = false;
    harness.http.reachable = false;
    await storeLabelled(core);
    await vi.waitFor(() => expect(manual.delays()).toContain(5_000));
    manual.fire(5_000);
    await vi.waitFor(() => expect(manual.delays()).toContain(15_000));
    expect(pi.printed).toEqual([]);

    harness.http.reachable = true;
    manual.fire(15_000);
    await vi.waitFor(() => expect(pi.printed).toHaveLength(1));
    // Nichts steht mehr aus: kein weiterer Versuch vorgemerkt. Was noch vorgemerkt ist, gehört
    // zum Abgleich (Takt, Prüfung nebenbei) und fragt den Server, nicht den Pi.
    await settle();
    expect(manual.delays().filter((delay) => delay === 5_000)).toEqual([]);
    const piCalls = harness.piCalls().length;
    manual.fireAll();
    await settle();
    expect(harness.piCalls()).toHaveLength(piCalls);
  });

  it("stellt ohne selbsttätigen Betrieb nie von selbst zu, nur über flush()", async () => {
    const harness = await withPi();
    const { core, pi } = harness;
    harness.network.attempts.length = 0;
    const stored = await storeLabelled(core);
    await core.sync.now();
    await settle();
    expect(harness.network.attempts).toEqual([]);
    expect(jobOf(core, stored.print_jobs[0]?.id).state).toBe("pending");
    await core.print.flush();
    expect(pi.printed).toHaveLength(1);
  });
});

describe("Nie doppelt", () => {
  const dropFirstSubmit = (harness: Harness) => {
    let dropped = false;
    harness.network.dropWhen = (call) => {
      if (!dropped && isSubmit(call)) {
        dropped = true;
        return true;
      }
      return false;
    };
  };

  it("schickt nach einer verlorenen Antwort denselben Auftrag wieder; der Dienst druckt einmal", async () => {
    const harness = await withPi();
    const { core, pi } = harness;
    const stored = await storeLabelled(core);
    const jobId = stored.print_jobs[0]?.id ?? "";
    dropFirstSubmit(harness);

    // Die Antwort auf das Einreichen geht verloren: Der Dienst hat gedruckt, die App weiß es nicht.
    expect(await core.print.flush()).toMatchObject({ delivered: 0, pending: 1 });
    expect(pi.printed).toEqual([jobId]);
    expect(jobOf(core, jobId).state).toBe("pending");

    // Inzwischen bekommt das Produkt einen anderen Namen: Hinaus geht trotzdem derselbe Inhalt.
    await core.products.update(stored.product.id, { name: "Reis, lang" });
    expect(await core.print.flush()).toMatchObject({ delivered: 1, pending: 0 });
    expect(pi.printed).toEqual([jobId]);
    expect(jobOf(core, jobId).state).toBe("printed");

    const submits = harness.piCalls().filter(isSubmit);
    expect(submits).toHaveLength(2);
    expect(submits[1]?.body).toEqual(submits[0]?.body);
    expect(submits[0]?.body).toMatchObject({ expect_boot_id: pi.bootId, data: { title: "Basmati Reis" } });
  });

  it("fragt den Anwender, wenn der Dienst nach dem Absenden neu gestartet ist", async () => {
    const harness = await withPi();
    const { core, pi, printerId } = harness;
    const stored = await storeLabelled(core);
    const jobId = stored.print_jobs[0]?.id ?? "";
    const firstBoot = pi.bootId;
    dropFirstSubmit(harness);
    await core.print.flush();
    expect(pi.printed).toHaveLength(1);

    pi.restart();
    await core.print.flush();
    // Niemand weiß, ob gedruckt wurde: nicht wiederholen, sondern fragen.
    expect(jobOf(core, jobId)).toMatchObject({ state: "unknown", error: "interrupted", printer_id: printerId, boot_id: firstBoot });
    expect(pi.printed).toHaveLength(1);
    // Die Wiederholung trug die boot_id vom ersten Absenden, nie die neue.
    expect(harness.piCalls().filter(isSubmit).map((call) => (call.body as { expect_boot_id: string }).expect_boot_id)).toEqual([firstBoot, firstBoot]);

    // Und es bleibt dabei, bis der Anwender antwortet.
    await core.print.flush();
    expect(jobOf(core, jobId).state).toBe("unknown");
    expect(pi.printed).toHaveLength(1);
    await core.print.resolveUnknown(jobId, true);
    expect(jobOf(core, jobId)).toMatchObject({ state: "printed", printer_id: printerId });
  });

  it("reicht mit der neuen boot_id ein, wenn der Dienst vor dem ersten Absenden neu gestartet ist", async () => {
    const harness = await withPi();
    const { core, pi } = harness;
    const stored = await storeLabelled(core);
    const jobId = stored.print_jobs[0]?.id ?? "";
    const firstBoot = pi.bootId;
    let restarted = false;
    harness.network.beforeRequest = (call) => {
      // Zwischen der Abfrage des Zustands und dem Einreichen startet der Dienst neu.
      if (!restarted && isSubmit(call)) {
        restarted = true;
        pi.restart();
      }
    };
    expect(await core.print.flush()).toMatchObject({ delivered: 1, pending: 0 });
    expect(pi.printed).toEqual([jobId]);
    expect(jobOf(core, jobId)).toMatchObject({ state: "printed", boot_id: pi.bootId });
    expect(harness.piCalls().filter(isSubmit).map((call) => (call.body as { expect_boot_id: string }).expect_boot_id)).toEqual([firstBoot, pi.bootId]);
  });

  it("druckt nach dem Neuladen der App nicht noch einmal", async () => {
    const harness = await withPi();
    const { core, pi } = harness;
    const stored = await storeLabelled(core, 2);
    const [first, second] = stored.print_jobs.map((job) => job.id).sort() as [string, string];
    // Das erste Etikett: abgeschickt, Antwort verloren. Das zweite kommt gar nicht mehr dran.
    dropFirstSubmit(harness);
    await core.print.flush();
    expect(pi.printed).toEqual([first]);

    // Die App wird neu geladen: ein neuer Kern auf derselben Datenbank.
    const reloaded = await harness.another();
    expect(await reloaded.print.flush()).toMatchObject({ delivered: 2, pending: 0 });
    expect(pi.printed).toEqual([first, second]);
    expect(jobOf(reloaded, first).state).toBe("printed");
    expect(jobOf(reloaded, second).state).toBe("printed");
  });

  it("fragt nach dem Neuladen bei einem wartenden Auftrag nach, statt ihn noch einmal einzureichen", async () => {
    const harness = await withPi();
    const { core, pi } = harness;
    const stored = await storeLabelled(core);
    const jobId = stored.print_jobs[0]?.id ?? "";
    pi.pause();
    await core.print.flush();
    expect(jobOf(core, jobId).state).toBe("queued");

    const reloaded = await harness.another();
    await reloaded.print.flush();
    expect(jobOf(reloaded, jobId).state).toBe("queued");
    pi.resume();
    await reloaded.print.flush();
    expect(jobOf(reloaded, jobId).state).toBe("printed");
    expect(harness.piCalls().filter(isSubmit)).toHaveLength(1);
    expect(pi.printed).toEqual([jobId]);
  });

  it("meldet einen wartenden Auftrag als offen, wenn der Dienst inzwischen neu gestartet ist", async () => {
    const harness = await withPi();
    const { core, pi } = harness;
    const stored = await storeLabelled(core);
    const jobId = stored.print_jobs[0]?.id ?? "";
    pi.pause();
    await core.print.flush();
    expect(jobOf(core, jobId).state).toBe("queued");
    pi.restart();
    await core.print.flush();
    expect(jobOf(core, jobId)).toMatchObject({ state: "unknown", error: "interrupted" });
    expect(harness.piCalls().filter(isSubmit)).toHaveLength(1);
  });

  it("druckt einmal, wenn zwei Tabs gleichzeitig zustellen", async () => {
    const harness = await withPi();
    const { core, pi } = harness;
    const stored = await storeLabelled(core, 3);
    const tab = await harness.another();
    const [a, b] = await Promise.all([core.print.flush(), tab.print.flush()]);
    expect(pi.printed.sort()).toEqual(stored.print_jobs.map((job) => job.id).sort());
    expect(a.delivered + b.delivered).toBe(3);
    expect(harness.piCalls().filter(isSubmit)).toHaveLength(3);
    await core.sync.now();
    expect(sent(harness, "print.report")).toHaveLength(3);
  });
});

describe("Bericht nach dem Einreichen, Nachfragen im Hintergrund", () => {
  /** Ein Pi, der wirklich wartet (`wait`), und dessen Drucker zunächst nichts druckt. */
  const waitingPi = () => withPi({}, {}, { realWait: true, printMs: 20 });
  const followUpsOf = (harness: PiHarness, jobId: string) => harness.piCalls().filter((call) => call.method === "GET" && call.path === `/v1/jobs/${jobId}` && call.query === "wait=10");

  it("erfüllt flush, sobald eingereicht ist; der Endzustand kommt danach ohne weiteren Aufruf an", async () => {
    const harness = await waitingPi();
    const { core, pi } = harness;
    pi.pause();
    const jobId = (await storeLabelled(core)).print_jobs[0]?.id ?? "";

    const started = Date.now();
    const report = await core.print.flush();
    expect(Date.now() - started).toBeLessThan(1_000);
    // Der Bericht gilt für diesen Moment: angekommen, beim Dienst wartend.
    expect(report).toEqual({ delivered: 1, pending: 0, problems: [] });
    expect(jobOf(core, jobId).state).toBe("queued");
    expect(harness.piCalls().filter(isSubmit).map((call) => call.query)).toEqual(["wait=0"]);

    // Im Hintergrund wird nachgefragt (die Abfrage wartet beim Dienst); der Drucker legt los.
    await vi.waitFor(() => expect(followUpsOf(harness, jobId)).toHaveLength(1));
    pi.resume();
    await vi.waitFor(() => expect(jobOf(core, jobId).state).toBe("printed"), { timeout: 3_000 });
    expect(pi.printed).toEqual([jobId]);
    expect(harness.piCalls().filter(isSubmit)).toHaveLength(1);
  });

  it("lässt ein zweites flush nicht auf das Nachfragen warten: Das Nachfragen bricht ab, die Abfrage auch", async () => {
    const harness = await waitingPi();
    const { core, pi } = harness;
    pi.pause();
    const first = (await storeLabelled(core)).print_jobs[0]?.id ?? "";
    await core.print.flush();
    // Die Abfrage mit wait=10 ist unterwegs und wartet beim Dienst.
    await vi.waitFor(() => expect(followUpsOf(harness, first)).toHaveLength(1));

    const second = (await storeLabelled(core, 1, "Mais")).print_jobs[0]?.id ?? "";
    const started = Date.now();
    const report = await core.print.flush();
    // Ohne Abbruch wartete der zweite Versuch auf die Abfrage (bis zu 10 s) und das Nachfragen (bis zu 60 s).
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(report).toEqual({ delivered: 1, pending: 0, problems: [] });
    expect(jobOf(core, second).state).toBe("queued");

    // Der neue Versuch fragt selbst weiter nach: Beide Endzustände kommen an, jeder Auftrag druckt einmal.
    pi.resume();
    await vi.waitFor(() => expect([first, second].map((id) => jobOf(core, id).state)).toEqual(["printed", "printed"]), { timeout: 3_000 });
    expect(pi.printed).toEqual([first, second]);
    expect(harness.piCalls().filter(isSubmit)).toHaveLength(2);
  });

  it("lässt auch einen Versuch aus einem anderen Tab nicht auf das Nachfragen warten", async () => {
    const harness = await waitingPi();
    const { core, pi } = harness;
    pi.pause();
    const first = (await storeLabelled(core)).print_jobs[0]?.id ?? "";
    await core.print.flush();
    await vi.waitFor(() => expect(followUpsOf(harness, first)).toHaveLength(1));

    const tab = await harness.another();
    const started = Date.now();
    const report = await tab.print.flush();
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(report).toEqual({ delivered: 0, pending: 0, problems: [] });
    pi.resume();
    await vi.waitFor(() => expect(jobOf(tab, first).state).toBe("printed"), { timeout: 3_000 });
    expect(pi.printed).toEqual([first]);
  });
});

describe("Reihenfolge und Fehler", () => {
  it("reicht mehrere Etiketten nacheinander ein, in der Reihenfolge ihrer Anforderung", async () => {
    const harness = await withPi();
    const { core, pi, clock } = harness;
    const first = await storeLabelled(core, 3, "Erbsen");
    clock.advance(1_000);
    const second = await storeLabelled(core, 2, "Linsen");
    expect(await core.print.flush()).toMatchObject({ delivered: 5, pending: 0 });
    const expected = [...first.print_jobs.map((job) => job.id).sort(), ...second.print_jobs.map((job) => job.id).sort()];
    expect(pi.printed).toEqual(expected);
    // Eine Abfrage des Zustands für den ganzen Versuch, nicht je Etikett.
    expect(harness.piCalls().filter((call) => call.path === "/v1/health")).toHaveLength(1);
  });

  it("lässt bei voller Warteschlange den Rest ausstehen", async () => {
    const harness = await withPi();
    const { core, pi } = harness;
    const stored = await storeLabelled(core, 3);
    pi.pause();
    pi.queueLimit = 1;
    expect(await core.print.flush()).toMatchObject({ delivered: 1, pending: 2 });
    const states = () => stored.print_jobs.map((job) => jobOf(core, job.id).state).sort();
    expect(states()).toEqual(["pending", "pending", "queued"]);

    pi.queueLimit = 100;
    pi.resume();
    expect(await core.print.flush()).toMatchObject({ delivered: 2, pending: 0 });
    expect(states()).toEqual(["printed", "printed", "printed"]);
    expect(pi.printed).toHaveLength(3);
  });

  it("lässt ausstehen, wenn der Pi das Token ablehnt, und versucht es von selbst erst wieder nach einer Änderung", async () => {
    const manual = manualTimers();
    const harness = await withPi({ autoSync: true, timers: manual.timers });
    const { core, pi, printerId } = harness;
    pi.refuseWrites = true;
    const stored = await storeLabelled(core);
    await vi.waitFor(() => expect(harness.piCalls().filter(isSubmit)).toHaveLength(1));
    await settle();
    expect(jobOf(core, stored.print_jobs[0]?.id).state).toBe("pending");

    // Der nächste selbsttätige Versuch lässt diesen Drucker in Ruhe.
    manual.fire(5_000);
    await settle();
    expect(harness.piCalls().filter(isSubmit)).toHaveLength(1);

    // Auf Wunsch des Anwenders wird es wieder versucht; die Auskunft nennt den Grund.
    expect(await core.print.flush()).toMatchObject({ delivered: 0, pending: 1, problems: [{ printer_id: printerId, problem: "not_verified" }] });
    expect(harness.piCalls().filter(isSubmit)).toHaveLength(2);

    // Ein neuer Name ändert nichts am Zugang: weiter Ruhe.
    await core.printers.update(printerId, { name: "Keller-Pi (neu)" });
    manual.fire(5_000);
    await settle();
    expect(harness.piCalls().filter(isSubmit)).toHaveLength(2);

    // Die Angaben zum Druckdienst werden geändert (und das Token stimmt wieder): Jetzt geht es von selbst.
    pi.refuseWrites = false;
    await core.printers.update(printerId, { direct: { urls: [HTTPS, HTTP], token: pi.token, printer: "brother" } });
    manual.fire(15_000);
    await vi.waitFor(() => expect(pi.printed).toHaveLength(1));
  });

  it("meldet einen Drucker, den der Dienst nicht hat, und lässt die Etiketten ausstehen", async () => {
    const harness = await withPi({}, { printer: "gibt-es-nicht" });
    const { core, pi, printerId } = harness;
    const stored = await storeLabelled(core);
    expect(await core.print.flush()).toMatchObject({ delivered: 0, pending: 1, problems: [{ printer_id: printerId, problem: "unknown_printer" }] });
    expect(await core.printers.probe(printerId)).toMatchObject({ reachable: true, url: HTTPS, problem: "unknown_printer" });
    expect(jobOf(core, stored.print_jobs[0]?.id).state).toBe("pending");
    expect(pi.printed).toEqual([]);

    // Der Name wird berichtigt: Das Etikett geht hinaus, an genau diesen Drucker.
    pi.setPrinters([{ name: "brother", confirms: true }, { name: "zweiter", confirms: false }]);
    await core.printers.update(printerId, { direct: { urls: [HTTPS, HTTP], token: pi.token, printer: "zweiter" } });
    expect(await core.print.flush()).toMatchObject({ delivered: 1, pending: 0 });
    expect(pi.prints.map((print) => print.printer)).toEqual(["zweiter"]);
    // Dieser Drucker kann den Druck nicht bestätigen: "sent".
    expect(jobOf(core, stored.print_jobs[0]?.id).state).toBe("sent");
  });

  it("meldet als gescheitert, was der Dienst beim Einreichen endgültig ablehnt", async () => {
    const harness = await withPi();
    const { core, pi, server, printerId } = harness;
    // Der Dienst verliert seinen Drucker zwischen Abfrage und Einreichen.
    const stored = await storeLabelled(core);
    let removed = false;
    harness.network.beforeRequest = (call) => {
      if (!removed && isSubmit(call)) {
        removed = true;
        pi.setPrinters([]);
      }
    };
    await core.print.flush();
    expect(jobOf(core, stored.print_jobs[0]?.id)).toMatchObject({ state: "failed", error: "unknown_printer", printer_id: printerId });
    harness.network.beforeRequest = null;
    pi.setPrinters([{ name: "brother", confirms: true }]);

    // Eine Vorlage, die sich nicht rendern lässt: ein Format, das der Dienst kennt, aber ein Papier, das er nicht kennt.
    const template = server.data.label_templates.get("package");
    server.put("label_templates", { key: "package", hash: "00000000000000ff", body: { schema: 2, media: { id: "99x99" } }, updated_at: template?.updated_at ?? "" });
    await core.sync.now();
    const broken = await storeLabelled(core, 1, "Mais");
    await core.print.flush();
    expect(jobOf(core, broken.print_jobs[0]?.id)).toMatchObject({ state: "failed", error: "render_failed" });
    expect(pi.printed).toEqual([]);

    // Ein neuer Versuch ist ein neues Etikett.
    const retried = await core.print.retry(broken.print_jobs[0]?.id ?? "");
    expect(retried.id).not.toBe(broken.print_jobs[0]?.id);
    expect(retried.state).toBe("pending");
  });

  it("übernimmt den Fehlercode des Druckers und einen offenen Ausgang", async () => {
    const harness = await withPi();
    const { core, pi } = harness;
    const stored = await storeLabelled(core, 2);
    const [first, second] = stored.print_jobs.map((job) => job.id).sort() as [string, string];
    pi.failNext("no_media");
    pi.interruptNext();
    // Reihenfolge im Dienst: erst der unterbrochene Druck, dann der gescheiterte.
    await core.print.flush();
    expect(jobOf(core, first)).toMatchObject({ state: "unknown", error: "interrupted" });
    expect(jobOf(core, second)).toMatchObject({ state: "failed", error: "no_media", boot_id: pi.bootId });
    expect(pi.printed).toEqual([]);
  });
});

describe("Fremde Etiketten und das Verwerfen", () => {
  it("stellt nur zu, was dieses Gerät angefordert hat; „hier drucken“ übernimmt ein fremdes", async () => {
    const harness = await withPi();
    const { core, pi, server } = harness;
    const stored = await storeLabelled(core);
    await core.sync.now();
    await core.print.flush();
    pi.prints.length = 0;
    // Ein anderes Gerät fordert für dieselbe Packung ein Etikett an.
    const foreignId = "70000000-0000-4000-8000-000000000001";
    server.act({ type: "print.request", job_id: foreignId, kind: "package", package_id: stored.packages[0]?.id });
    await core.sync.now();
    expect(jobOf(core, foreignId)).toMatchObject({ state: "pending", device_id: null });

    expect(await core.print.flush()).toEqual({ delivered: 0, pending: 0, problems: [] });
    expect(pi.printed).toEqual([]);

    // „Hier drucken": das alte verwerfen, ein eigenes anfordern, in einem Schritt.
    const before = value(core.sync.status).pending;
    const own = await core.print.retry(foreignId);
    expect(value(core.sync.status).pending).toBe(before + 2);
    expect(jobOf(core, foreignId).state).toBe("cancelled");
    expect(own).toMatchObject({ state: "pending", package_id: stored.packages[0]?.id });
    await core.print.flush();
    expect(pi.printed).toEqual([own.id]);
  });

  it("verwirft ein eigenes wartendes Etikett zuerst beim Dienst", async () => {
    const harness = await withPi();
    const { core, pi, printerId } = harness;
    const stored = await storeLabelled(core);
    const jobId = stored.print_jobs[0]?.id ?? "";
    pi.pause();
    await core.print.flush();
    expect(jobOf(core, jobId).state).toBe("queued");

    await core.print.cancel(jobId);
    expect(pi.job(jobId)).toEqual({ state: "failed", error: "cancelled" });
    expect(jobOf(core, jobId)).toMatchObject({ state: "cancelled", printer_id: printerId, error: null });
    pi.resume();
    await core.print.flush();
    expect(pi.printed).toEqual([]);
  });

  it("verwirft nicht, was schon druckt, und zeigt dann den Zustand des Dienstes", async () => {
    const harness = await withPi();
    const { core, pi } = harness;
    const stored = await storeLabelled(core, 2);
    const [first, second] = stored.print_jobs.map((job) => job.id).sort() as [string, string];
    pi.hangNext();
    await core.print.flush();
    expect(jobOf(core, first).state).toBe("queued");
    // Der erste druckt gerade (hängt), der zweite wartet dahinter.
    await expectCoreError(core.print.cancel(first), "invalid");
    expect(jobOf(core, first).state).toBe("queued");
    pi.resume();
    await expectCoreError(core.print.cancel(first), "invalid");
    expect(jobOf(core, first).state).toBe("printed");
    expect(jobOf(core, second).state).toBe("queued");
  });

  it("verwirft nicht, solange der Dienst nicht erreichbar ist", async () => {
    const harness = await withPi();
    const { core, pi } = harness;
    const stored = await storeLabelled(core);
    const jobId = stored.print_jobs[0]?.id ?? "";
    pi.pause();
    await core.print.flush();
    harness.https.reachable = false;
    harness.http.reachable = false;
    await expectCoreError(core.print.cancel(jobId), "offline");
    expect(jobOf(core, jobId).state).toBe("queued");
  });

  it("verwirft ein eigenes Etikett, das vielleicht schon unterwegs ist, zuerst beim Dienst, ohne Dienst nur hier", async () => {
    const harness = await withPi();
    const { core, pi } = harness;
    const dropNextSubmit = () => {
      let dropped = false;
      harness.network.dropWhen = (call) => {
        if (!dropped && isSubmit(call)) {
          dropped = true;
          return true;
        }
        return false;
      };
    };
    // Der Dienst nimmt an, druckt aber noch nicht; die Antwort auf das Einreichen geht verloren.
    pi.pause();
    const first = (await storeLabelled(core)).print_jobs[0]?.id ?? "";
    dropNextSubmit();
    await core.print.flush();
    expect(pi.job(first)).toEqual({ state: "queued", error: null });
    expect(jobOf(core, first).state).toBe("pending");

    // Erreichbar: zuerst beim Dienst verworfen, dort druckt es nie.
    await core.print.cancel(first);
    expect(pi.job(first)).toEqual({ state: "failed", error: "cancelled" });
    expect(jobOf(core, first).state).toBe("cancelled");

    // Nicht erreichbar: verworfen wird trotzdem, wie jedes ausstehende Etikett auch ohne Netz.
    const second = (await storeLabelled(core, 1, "Mais")).print_jobs[0]?.id ?? "";
    dropNextSubmit();
    await core.print.flush();
    expect(pi.job(second)?.state).toBe("queued");
    harness.https.reachable = false;
    harness.http.reachable = false;
    await core.print.cancel(second);
    expect(jobOf(core, second)).toMatchObject({ state: "cancelled", error: null });
    // Druckt der Dienst es später doch, dann einmal; der Kern schickt es nicht noch einmal.
    harness.https.reachable = true;
    pi.resume();
    await core.print.flush();
    expect(pi.printed).toEqual([second]);
    expect(harness.piCalls().filter(isSubmit).filter((call) => call.path.endsWith(second))).toHaveLength(1);
  });

  it("verwirft ein ausstehendes Etikett sofort und ein fremdes wartendes nur als Meldung", async () => {
    const harness = await withPi();
    const { core, pi, server, printerId } = harness;
    harness.https.reachable = false;
    harness.http.reachable = false;
    const stored = await storeLabelled(core);
    const jobId = stored.print_jobs[0]?.id ?? "";
    await core.print.cancel(jobId);
    expect(jobOf(core, jobId).state).toBe("cancelled");

    const foreignId = "70000000-0000-4000-8000-000000000002";
    await core.sync.now();
    server.act(
      { type: "print.request", job_id: foreignId, kind: "package", package_id: stored.packages[0]?.id },
      { type: "print.report", job_id: foreignId, state: "queued", printer_id: printerId, boot_id: pi.bootId },
    );
    await core.sync.now();
    harness.network.attempts.length = 0;
    await core.print.cancel(foreignId);
    expect(jobOf(core, foreignId)).toMatchObject({ state: "cancelled", printer_id: printerId });
    expect(harness.network.attempts).toEqual([]);
  });
});

describe("Zustand des Druckers weiterreichen", () => {
  it("meldet einen direkten Drucker nach der Abfrage, gedrosselt, bei Änderung sofort", async () => {
    const harness = await withPi();
    const { core, pi, clock, printerId } = harness;
    const reports = () => value(core.sync.status).pending;
    await storeLabelled(core);
    await core.sync.now();
    expect(reports()).toBe(0);

    await core.print.flush();
    await core.sync.now();
    expect(sent(harness, "printer.report")).toMatchObject([
      { printer_id: printerId, boot_id: pi.bootId, status: { reachable: true, ready: true, media_detected: true, errors: [] }, host: { temperature_c: 48.5 } },
    ]);
    expect(value(core.data.printerStatus)).toMatchObject([{ printer_id: printerId, boot_id: pi.bootId }]);

    // Innerhalb einer Minute und ohne Änderung: keine weitere Meldung.
    await storeLabelled(core, 1, "Mais");
    await core.print.flush();
    await core.sync.now();
    expect(sent(harness, "printer.report")).toHaveLength(1);

    // Der Zustand ändert sich: sofort.
    pi.setStatus("brother", { ready: false, media_detected: false, errors: ["no_media"] });
    await storeLabelled(core, 1, "Bohnen");
    await core.print.flush();
    await core.sync.now();
    expect(sent(harness, "printer.report")).toHaveLength(2);
    expect(sent(harness, "printer.report")[1]).toMatchObject({ status: { ready: false, errors: ["no_media"] } });

    // Nach einer Minute wieder, auch ohne Änderung.
    clock.advance(61_000);
    await storeLabelled(core, 1, "Hirse");
    await core.print.flush();
    await core.sync.now();
    expect(sent(harness, "printer.report")).toHaveLength(3);

    // Fragt der Anwender ausdrücklich ab, immer.
    await core.printers.probe(printerId);
    await core.sync.now();
    expect(sent(harness, "printer.report")).toHaveLength(4);
  });

  it("hält ohne Server je Drucker höchstens eine Meldung in der Outbox; es gilt die jüngste, hier wie beim Server", async () => {
    const harness = await withPi();
    const { core, pi, network, printerId } = harness;
    const reportsBefore = sent(harness, "printer.report").length;
    // Im Keller: kein Server, aber der Pi. Jede Abfrage meldet seinen Zustand.
    network.offline = true;
    await core.printers.probe(printerId);
    expect(value(core.sync.status).pending).toBe(1);
    pi.setStatus("brother", { ready: false, media_detected: false, errors: ["no_media"] });
    await core.printers.probe(printerId);
    pi.restart();
    pi.setStatus("brother", { ready: false, media_detected: false, errors: ["cover_open"] });
    await core.printers.probe(printerId);
    // Drei Meldungen, eine in der Outbox: die jüngste, und die Anzeige zeigt dasselbe wie ohne Ersetzen.
    expect(value(core.sync.status).pending).toBe(1);
    expect(value(core.data.printerStatus)).toMatchObject([{ printer_id: printerId, boot_id: pi.bootId, status: { errors: ["cover_open"] } }]);

    // Auch beim Zustellen (gedrosselt, aber bei jeder Änderung) bleibt es bei einer.
    pi.setStatus("brother", { ready: true, media_detected: true, errors: [] });
    const stored = await storeLabelled(core);
    await core.print.flush();
    await vi.waitFor(() => expect(jobOf(core, stored.print_jobs[0]?.id).state).toBe("printed"));
    expect(value(core.data.printerStatus)).toMatchObject([{ printer_id: printerId, boot_id: pi.bootId, status: { ready: true, errors: [] } }]);

    network.offline = false;
    await core.sync.now();
    expect(value(core.sync.status)).toMatchObject({ pending: 0, phase: "idle" });
    expect(sent(harness, "printer.report").slice(reportsBefore)).toMatchObject([{ printer_id: printerId, boot_id: pi.bootId, status: { ready: true, errors: [] } }]);
    expect(harness.server.data.printer_status.get(printerId)).toMatchObject({ boot_id: pi.bootId, status: { ready: true, errors: [] } });
  });

  it("lässt stehen, was ein Abgleich gerade sendet, auch der eines anderen Tabs, und schickt die neue Meldung danach", async () => {
    const harness = await withPi();
    const { core, pi, network, server, printerId } = harness;
    const tab = await harness.another();
    await core.printers.probe(printerId);
    const before = sent(harness, "printer.report").length;

    // Der Abgleich des ersten Tabs ist unterwegs; der Server hat die Anfrage noch nicht.
    const slow = gate();
    let syncing = false;
    network.beforeRequest = async (call) => {
      if (call.path === "/api/sync" && !syncing) {
        syncing = true;
        await slow.promise;
      }
    };
    const running = core.sync.now();
    await vi.waitFor(() => expect(syncing).toBe(true));
    // Inzwischen meldet sich der Pi neu, in diesem Tab und im anderen.
    pi.setStatus("brother", { errors: ["cover_open"], ready: false });
    await core.printers.probe(printerId);
    pi.setStatus("brother", { errors: ["no_media"], ready: false, media_detected: false });
    await tab.printers.probe(printerId);
    // Die gesendete bleibt; die beiden neuen ersetzen einander.
    await vi.waitFor(() => expect(value(core.sync.status).pending).toBe(2));
    await vi.waitFor(() => expect(value(core.data.printerStatus)).toMatchObject([{ status: { errors: ["no_media"] } }]));

    network.beforeRequest = null;
    slow.open();
    await running;
    // Die gesendete ist bestätigt; die jüngste ging mit der nächsten Runde desselben Abgleichs
    // hinaus. Kein Fehler, nichts verloren, nichts doppelt.
    expect(value(core.sync.status)).toMatchObject({ pending: 0, phase: "idle", last_error: null });
    expect(value(core.data.printerStatus)).toMatchObject([{ status: { errors: ["no_media"] } }]);
    expect(sent(harness, "printer.report").slice(before).map((command) => (command.status as { errors: string[] }).errors)).toEqual([[], ["no_media"]]);
    expect(server.data.printer_status.get(printerId)?.status?.errors).toEqual(["no_media"]);
  });

  it("verträgt ein Ergebnis zu einer Meldung, die unterwegs doch ersetzt wurde (Tab mitten im Abgleich beendet)", async () => {
    const harness = await withPi();
    const { core, pi, network, server, clock, printerId } = harness;
    await core.printers.probe(printerId);
    const before = sent(harness, "printer.report").length;

    const slow = gate();
    let syncing = false;
    network.beforeRequest = async (call) => {
      if (call.path === "/api/sync" && !syncing) {
        syncing = true;
        await slow.promise;
      }
    };
    const running = core.sync.now();
    await vi.waitFor(() => expect(syncing).toBe(true));
    // Die Markierung gilt nicht ewig: Nach ihrer Frist wird die gesendete Meldung doch ersetzt.
    clock.advance(SENDING_MARK_TTL_MS + 1_000);
    pi.setStatus("brother", { errors: ["cover_open"], ready: false });
    await core.printers.probe(printerId);
    expect(value(core.sync.status).pending).toBe(1);

    network.beforeRequest = null;
    slow.open();
    await running;
    // Das Ergebnis der ersetzten Meldung stört nicht: Der Abgleich gelingt, und die neue geht
    // mit seiner nächsten Runde hinaus.
    expect(value(core.sync.status)).toMatchObject({ pending: 0, phase: "idle", last_error: null });
    expect(value(core.sync.problems)).toEqual([]);
    expect(sent(harness, "printer.report").slice(before)).toHaveLength(2);
    expect(server.data.printer_status.get(printerId)?.status?.errors).toEqual(["cover_open"]);
  });

  it("gibt Gesendetes wieder frei, wenn die Antwort verloren geht: Danach wird es ersetzt", async () => {
    const harness = await withPi();
    const { core, pi, network, server, printerId } = harness;
    await core.printers.probe(printerId);
    const before = sent(harness, "printer.report").length;
    // Der Server verbucht die Meldung, die Antwort kommt nie an.
    network.dropResponses = 1;
    await core.sync.now();
    expect(value(core.sync.status)).toMatchObject({ pending: 1, online: false });

    network.offline = true;
    pi.setStatus("brother", { errors: ["no_media"], ready: false, media_detected: false });
    await core.printers.probe(printerId);
    expect(value(core.sync.status).pending).toBe(1);
    network.offline = false;
    await core.sync.now();
    expect(value(core.sync.status)).toMatchObject({ pending: 0, phase: "idle" });
    expect(sent(harness, "printer.report").slice(before)).toHaveLength(2);
    expect(server.data.printer_status.get(printerId)?.status?.errors).toEqual(["no_media"]);
  });

  it("meldet für einen Drucker am Server nie; dessen Zustand bringt der Abgleich", async () => {
    const harness = await withServerPrinter();
    const { core, printerId } = harness;
    const probe = await core.printers.probe(printerId);
    expect(probe).toMatchObject({ reachable: true, url: null, problem: null });
    expect(probe.health?.printers.map((printer) => printer.name)).toEqual([printerId]);
    await core.sync.now();
    expect(sent(harness, "printer.report")).toEqual([]);
    expect(value(core.data.printerStatus)).toMatchObject([{ printer_id: printerId, host: null }]);
  });
});

describe("Vorschau, Bild und Notweg", () => {
  it("rendert die Vorschau am Server mit Vorlage und Daten wie beim Druck", async () => {
    const harness = await withServerPrinter();
    const { core, network, printerId } = harness;
    const stored = await storeLabelled(core);
    const zoneId = firstZoneId(core);

    const image = await core.print.preview({ kind: "package", package_id: stored.packages[0]?.id ?? "" }, { printer_id: printerId });
    expect(image.size).toBeGreaterThan(20);
    const render = network.calls.find((call) => call.path === "/print/v1/render");
    expect(render?.body).toMatchObject({ printer: printerId, template: { name: "package-62x29" }, data: { id: stored.packages[0]?.id, title: "Basmati Reis" } });

    network.calls.length = 0;
    await core.print.preview({ kind: "zone", zone_id: zoneId });
    const body = network.calls.find((call) => call.path === "/print/v1/render")?.body;
    expect(body).toMatchObject({ template: { name: "zone-62x29" }, data: { qr: `STOWLY/Z/${zoneId.replace(/-/g, "").toUpperCase()}`, subtitle: "Lagerzone" } });
    expect(body).not.toHaveProperty("printer");

    await expectCoreError(core.print.preview({ kind: "package", package_id: "ZZZZZ" }), "not_found");
    network.offline = true;
    await expectCoreError(core.print.preview({ kind: "zone", zone_id: zoneId }), "offline");
  });

  it("meldet eine Vorlage, die sich nicht rendern lässt, als ungültig", async () => {
    const { core, server } = await withServerPrinter();
    server.put("label_templates", { key: "zone", hash: "00000000000000fe", body: { schema: 99 }, updated_at: "2026-11-13T10:00:00.000Z" });
    await core.sync.now();
    await expectCoreError(core.print.preview({ kind: "zone", zone_id: firstZoneId(core) }), "invalid");
  });

  it("holt das Bild, das der Bild-Treiber geschrieben hat", async () => {
    const { core } = await withServerPrinter();
    const stored = await storeLabelled(core);
    const jobId = stored.print_jobs[0]?.id ?? "";
    await core.sync.now();
    // Vor dem Druck gibt es kein Bild.
    await expectCoreError(core.print.image(jobId), "not_found");
    await core.print.flush();
    const image = await core.print.image(jobId);
    expect(image.type).toBe("image/png");
    await expectCoreError(core.print.image("70000000-0000-4000-8000-000000000009"), "not_found");
  });

  it("baut die Adresse des Notwegs und fragt danach, ob gedruckt wurde", async () => {
    const harness = await withPi();
    const { core, pi, printerId } = harness;
    // Die App erreicht den Dienst nicht (dafür ist der Notweg da).
    harness.https.reachable = false;
    harness.http.reachable = false;
    await expectCoreError(core.print.handoff(printerId), "not_found");
    const stored = await storeLabelled(core, MAX_HANDOFF_JOBS + 2);
    harness.clock.advance(1_000);
    const zoneJob = await core.print.requestZoneLabel(firstZoneId(core));
    harness.network.attempts.length = 0;

    const handoff = await core.print.handoff(printerId);
    // Ohne Netz, ohne Abfrage.
    expect(harness.network.attempts).toEqual([]);
    // Über HTTP, weil die Seite dort kein Zertifikat braucht; die Nutzlast steht im Fragment.
    expect(handoff.url.startsWith(`${HTTP}/p#`)).toBe(true);
    const fragment = handoff.url.slice(handoff.url.indexOf("#") + 1);
    expect(fragment).toMatch(/^[A-Za-z0-9_-]+$/);
    const binary = atob(fragment.replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))) as {
      v: number;
      token: string;
      printer: string | null;
      template: Record<string, unknown>;
      jobs: { id: string; data: Record<string, string> }[];
      back: string | null;
    };
    expect(payload).toMatchObject({ v: 1, token: pi.token, printer: null, template: { name: "package-62x29" } });
    expect(payload.back).toBe(`${window.location.origin}/drucker`);
    // Höchstens 20, nur Etiketten einer Art, in der Reihenfolge ihrer Anforderung.
    const expected = stored.print_jobs.map((job) => job.id).sort().slice(0, MAX_HANDOFF_JOBS);
    expect(payload.jobs.map((job) => job.id)).toEqual(expected);
    expect(payload.jobs[0]?.data).toMatchObject({ title: "Basmati Reis", best_before: "25.03.2027" });
    expect(handoff.jobs.map((job) => job.id)).toEqual(expected);

    // Die übergebenen Etiketten: Ausgang offen, die App fragt nach. Der Rest steht weiter aus.
    for (const id of expected) {
      expect(jobOf(core, id)).toMatchObject({ state: "unknown", error: "handoff", printer_id: printerId });
    }
    expect(jobOf(core, zoneJob.id).state).toBe("pending");
    const rest = await core.print.handoff(printerId);
    expect(rest.jobs).toHaveLength(2);

    // Die Seite des Dienstes reicht ein (hier von Hand nachgespielt) und druckt.
    const submitted = payload.jobs[0];
    await pi.handle({ method: "POST", path: `/v1/jobs/${submitted?.id}`, headers: {}, body: JSON.stringify({ token: payload.token, printer: payload.printer, template: payload.template, data: submitted?.data }) });
    expect(pi.printed).toEqual([submitted?.id]);
    // Erreicht die App den Dienst später doch und kennt er den Auftrag, gilt dessen Zustand.
    harness.https.reachable = true;
    await core.print.flush();
    expect(jobOf(core, submitted?.id).state).toBe("printed");
    expect(jobOf(core, expected[1]).state).toBe("unknown");
    expect(pi.printed).toHaveLength(2);

    await expectCoreError(core.print.handoff("30000000-0000-4000-8000-000000000099"), "not_found");
  });

  it("übergibt nur Etiketten, die noch nie abgeschickt wurden", async () => {
    const harness = await withPi();
    const { core, pi, printerId } = harness;
    // Abgeschickt, Antwort verloren: Das Etikett ist vielleicht schon beim Drucker (hier: gedruckt).
    const sentId = (await storeLabelled(core)).print_jobs[0]?.id ?? "";
    let dropped = false;
    harness.network.dropWhen = (call) => {
      if (!dropped && isSubmit(call)) {
        dropped = true;
        return true;
      }
      return false;
    };
    await core.print.flush();
    harness.network.dropWhen = null;
    expect(jobOf(core, sentId).state).toBe("pending");
    expect(pi.printed).toEqual([sentId]);

    // Danach erreicht die App den Pi nicht mehr: Über die Seite des Dienstes geht dieses Etikett nicht.
    harness.https.reachable = false;
    harness.http.reachable = false;
    const refused = await expectCoreError(core.print.handoff(printerId), "not_found");
    expect(refused.message).toMatch(/vielleicht schon beim Drucker/);
    expect(jobOf(core, sentId).state).toBe("pending");

    // Ein neues Etikett geht über die Seite, das vielleicht schon abgeschickte bleibt stehen.
    harness.clock.advance(1_000);
    const freshId = (await storeLabelled(core, 1, "Mais")).print_jobs[0]?.id ?? "";
    const handoff = await core.print.handoff(printerId);
    expect(handoff.jobs.map((job) => job.id)).toEqual([freshId]);
    expect(jobOf(core, freshId)).toMatchObject({ state: "unknown", error: "handoff" });
    expect(jobOf(core, sentId).state).toBe("pending");

    // Der normale Weg klärt es, sobald der Pi wieder da ist: kein zweiter Druck.
    harness.https.reachable = true;
    await core.print.flush();
    expect(jobOf(core, sentId).state).toBe("printed");
    expect(pi.printed).toEqual([sentId]);
  });

  it("meldet bei einem übergebenen Etikett keinen Zwischenstand, nur den Ausgang", async () => {
    // docs/sync-protokoll.md, 6.6: queued oder printing ändern ein unklares Etikett nicht. Der Kern
    // erzeugt solche Meldungen deshalb gar nicht erst; jede Meldung ist ein Befehl in der Outbox.
    const harness = await withPi();
    const { core, pi, printerId } = harness;
    harness.https.reachable = false;
    harness.http.reachable = false;
    const id = (await storeLabelled(core)).print_jobs[0]?.id ?? "";
    const { url } = await core.print.handoff(printerId);
    const fragment = url.slice(url.indexOf("#") + 1);
    const binary = atob(fragment.replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))) as { template: Record<string, unknown>; jobs: { id: string; data: Record<string, string> }[] };

    // Die Seite reicht ein; der Drucker arbeitet noch nicht.
    pi.pause();
    await pi.handle({ method: "POST", path: `/v1/jobs/${id}`, headers: {}, body: JSON.stringify({ token: pi.token, printer: null, template: payload.template, data: payload.jobs[0]?.data }) });
    harness.https.reachable = true;
    await core.print.flush();
    await core.sync.now();
    expect(jobOf(core, id)).toMatchObject({ state: "unknown", error: "handoff" });
    const reports = () => sent(harness, "print.report").filter((command) => command.job_id === id).map((command) => command.state);
    expect(reports()).toEqual(["unknown"]);

    pi.resume();
    await core.print.flush();
    await core.sync.now();
    expect(jobOf(core, id).state).toBe("printed");
    expect(reports()).toEqual(["unknown", "printed"]);
    expect(pi.printed).toEqual([id]);
  });

  it("gibt es den Notweg nur bei einem direkten Drucker", async () => {
    const { core, printerId } = await withServerPrinter();
    await storeLabelled(core);
    await expectCoreError(core.print.handoff(printerId), "invalid");
  });
});

describe("Etiketten nach id_conflict", () => {
  it("verwirft die eigenen Etiketten zu einer Packung, deren ID schon vergeben war", async () => {
    const harness = await withPi();
    const { core, pi, server, network } = harness;
    harness.https.reachable = false;
    harness.http.reachable = false;
    const stored = await storeLabelled(core);
    const packageId = stored.packages[0]?.id ?? "";
    const sentJob = stored.print_jobs[0]?.id ?? "";

    // Ein anderes Gerät war mit derselben ID schneller.
    const otherProduct = "50000000-0000-4000-8000-000000000001";
    server.act({ type: "product.create", product_id: otherProduct, name: "Fremdes Produkt" }, { type: "package.create", package_id: packageId, product_id: otherProduct, zone_id: firstZoneId(core) });

    // Während der Abgleich läuft, fordert der Anwender ein zweites Etikett an: Es wartet in der Outbox.
    let waitingJob = "";
    let once = false;
    network.beforeResponse = async (call) => {
      if (!once && call.path === "/api/sync") {
        once = true;
        const [job] = await core.print.requestPackageLabels([packageId]);
        waitingJob = job?.id ?? "";
      }
    };
    await core.sync.now();
    network.beforeResponse = null;

    // Die Ablehnung steht in den Sync-Problemen.
    expect(value(core.sync.problems)).toMatchObject([{ status: "rejected", code: "id_conflict", command: { type: "package.create", package_id: packageId } }]);
    // Die wartende Anforderung ist samt ihren Meldungen aus der Outbox gefallen: Dieses Etikett gab es nie.
    expect(value(core.data.printJobs).some((job) => job.id === waitingJob)).toBe(false);
    expect(sent(harness, "print.request").map((command) => command.job_id)).toEqual([sentJob]);
    // Das schon gesendete ist verworfen, hier und beim Server.
    expect(jobOf(core, sentJob).state).toBe("cancelled");
    expect(server.data.print_jobs.get(sentJob)?.state).toBe("cancelled");
    expect(value(core.sync.status).pending).toBe(0);

    // Zugestellt wird davon nichts mehr.
    harness.https.reachable = true;
    expect(await core.print.flush()).toMatchObject({ delivered: 0, pending: 0 });
    expect(pi.printed).toEqual([]);
  });

  it("lässt ein schon gedrucktes Etikett, wie es ist", async () => {
    const harness = await withPi();
    const { core, pi, server } = harness;
    const stored = await storeLabelled(core);
    const packageId = stored.packages[0]?.id ?? "";
    const jobId = stored.print_jobs[0]?.id ?? "";
    // Direkt gedruckt, noch bevor der Server von der Packung weiß.
    await core.print.flush();
    expect(pi.printed).toEqual([jobId]);

    const otherProduct = "50000000-0000-4000-8000-000000000002";
    server.act({ type: "product.create", product_id: otherProduct, name: "Fremdes Produkt" }, { type: "package.create", package_id: packageId, product_id: otherProduct, zone_id: firstZoneId(core) });
    await core.sync.now();
    expect(value(core.sync.problems)).toMatchObject([{ code: "id_conflict" }]);
    expect(jobOf(core, jobId).state).toBe("printed");
    expect(sent(harness, "print.report").map((command) => command.state)).toEqual(["printed"]);
  });
});

// ------------------------------------------------------------------------------------------
// Papier und Format der Vorlage (seit 0.5.0; docs/etiketten.md, 3.4 und 4.1)
// ------------------------------------------------------------------------------------------

describe("Papier und Format der Vorlage", () => {
  /** Setzt die Vorlagen des Haushalts, als hätte der Server eine Gestaltung gespeichert, und gleicht ab. */
  async function useTemplates(harness: Harness, body: Record<string, unknown>): Promise<void> {
    for (const [key, hash] of [
      ["package", "a000000000000001"],
      ["zone", "b000000000000001"],
    ] as const) {
      harness.server.put("label_templates", { key, hash, body: { ...body, name: key }, updated_at: harness.clock.now().toISOString() });
    }
    await harness.core.sync.now();
  }

  const NARROW = { schema: 2, media: { id: "29", kind: "endless", width_mm: 29, length_mm: 50 }, rotate: 90, elements: [] };

  it("stellt einem Druckdienst vor 0.5.0 kein Etikett im Format 2 zu: Es bleibt ausstehend mit `outdated`", async () => {
    const harness = await withPi({}, {}, { templateSchemas: null });
    const { core, pi, printerId } = harness;
    await useTemplates(harness, NARROW);
    const stored = await storeLabelled(core);
    const jobId = stored.print_jobs[0]?.id;
    expect(await core.print.flush()).toEqual({
      delivered: 0,
      pending: 1,
      problems: [{ printer_id: printerId, problem: "outdated", message: "Der Druckdienst auf dem Pi ist zu alt für dieses Papier. Neu koppeln aktualisiert ihn." }],
    });
    expect(jobOf(core, jobId)).toMatchObject({ state: "pending", error: null });
    // Nichts ging hinaus: nur die Abfrage des Zustands, kein Einreichen.
    expect(harness.piCalls().filter((call) => call.method === "POST")).toEqual([]);
    expect(pi.printed).toEqual([]);
    // „Verbindung prüfen" sagt dasselbe; der Dienst selbst antwortet.
    expect(await core.printers.probe(printerId)).toMatchObject({ reachable: true, problem: "outdated", health: { version: "0.4.0" } });

    // Neu gekoppelt, also ein neuer Druckdienst: Jetzt geht das Etikett hinaus, so wie es war.
    pi.templateSchemas = [1, 2];
    expect(await core.print.flush()).toMatchObject({ delivered: 1, pending: 0, problems: [] });
    expect(pi.printed).toEqual([jobId]);
    const [submit] = harness.piCalls().filter((call) => call.method === "POST");
    expect(submit?.body).toMatchObject({ template: { schema: 2, media: { id: "29" }, rotate: 90 } });
  });

  it("druckt Format 1 auch auf einem Druckdienst vor 0.5.0, mit allen Feldern der Daten", async () => {
    const harness = await withPi({}, {}, { templateSchemas: null });
    await useTemplates(harness, { schema: 1, media: { id: "62", kind: "endless", width_mm: 62, length_mm: 40 }, elements: [] });
    const stored = await storeLabelled(harness.core);
    expect(await harness.core.print.flush()).toMatchObject({ delivered: 1, problems: [] });
    expect(harness.pi.printed).toEqual([stored.print_jobs[0]?.id]);
    // Ein Druckdienst vor 0.5.0 nimmt unbekannte Schlüssel der Daten an.
    expect(harness.pi.prints[0]?.data).toMatchObject({ brand: "Kornhaus", quantity: "1 kg", best_before_short: "25.03.27", zone: "Vorrat" });
  });

  it("nennt dem Druckdienst bei jeder Abfrage das Papier des Haushalts; eine andere Rolle meldet er, und gedruckt wird nicht", async () => {
    const roll = { id: "62", kind: "endless", width_mm: 62, length_mm: null };
    const harness = await withPi({}, {}, { printers: [{ name: "brother", confirms: true, loaded: roll }] });
    await useTemplates(harness, { schema: 2, media: { id: "62x29", kind: "die_cut", width_mm: 62, length_mm: 29 }, rotate: 0, elements: [] });
    const probe = await harness.core.printers.probe(harness.printerId);
    const health = harness.piCalls().filter((call) => call.path === "/v1/health").at(-1);
    expect(new URLSearchParams(health?.query).get("media")).toBe("62x29");
    expect(probe).toMatchObject({ reachable: true, problem: null, health: { template_schemas: [1, 2] } });
    expect(probe.health?.printers[0]).toMatchObject({ loaded: roll, status: { ready: false, errors: ["media_mismatch"] } });

    const stored = await storeLabelled(harness.core);
    await harness.core.print.flush();
    await expect.poll(() => jobOf(harness.core, stored.print_jobs[0]?.id).state).toBe("failed");
    expect(jobOf(harness.core, stored.print_jobs[0]?.id).error).toBe("media_mismatch");
    expect(harness.pi.printed).toEqual([]);
  });

  it("reicht auf dem Notweg die Vorlage weiter wie bisher, auch an einen alten Druckdienst", async () => {
    const harness = await withPi({}, {}, { templateSchemas: null });
    await useTemplates(harness, NARROW);
    await storeLabelled(harness.core);
    const { url } = await harness.core.print.handoff(harness.printerId);
    const fragment = url.slice(url.indexOf("#") + 1);
    const binary = atob(fragment.replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))) as { template: Record<string, unknown> };
    expect(payload.template).toMatchObject({ schema: 2, media: { id: "29" } });
  });
});
