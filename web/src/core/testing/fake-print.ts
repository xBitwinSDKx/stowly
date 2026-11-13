/**
 * Der Druckdienst `stowly_print`, nachgebaut im Arbeitsspeicher (docs/etiketten.md, Abschnitt 5).
 *
 * Gegenstelle für die Tests des Zustellens und für das Ausprobieren im Browser. Es gibt ihn in
 * zwei Ausprägungen, wie den echten:
 *
 *   am Pi      eigenständig unter einer eigenen Adresse; lesende Aufrufe offen, schreibende mit
 *              dem Token des Druckers (im JSON-Rumpf oder als `Authorization: Bearer`); der
 *              Auftragsspeicher stirbt mit dem Neustart, und jeder Start hat eine neue `boot_id`.
 *   am Server  unter `/print` (src/core/testing/fake-server.ts hängt ihn ein): jeder Aufruf mit
 *              Geräte-Token; Drucker sind die des Datenbestands unter ihrer `Printer.id`; nur
 *              bekannte, ausstehende Etiketten werden angenommen; Zustand von Etikett und
 *              Drucker schreibt der Dienst selbst in den Datenbestand; die `boot_id` bleibt.
 *
 * MASSGEBLICH IST DER VERTRAG, NICHT DIESE NACHBILDUNG. In der Integration von Runde 2 ist sie
 * gegen den echten Dienst (`stowly_print`) gehalten und in der Reihenfolge der Prüfungen, im
 * Umgang mit unbekannten Schlüsseln und mit `wait` angeglichen worden; der echte Kern läuft
 * zusätzlich gegen den echten Dienst (web/e2e/delivery.e2e.test.ts). Was sie nicht kann oder
 * anders macht:
 *
 * - Es wird nichts gerendert. „Rendern" gelingt, wenn die Vorlage ein Objekt mit `schema: 1`
 *   ist und die Daten Zeichenketten sind; sonst `render_failed`. Die Mindestgröße der Module,
 *   Schriften und Maße prüft sie nicht. Bilder sind immer dasselbe winzige PNG.
 * - `png` (fertiges Bild als Notausgang) wird angenommen, aber nicht auf Inhalt und Größe geprüft.
 * - Gedruckt wird sofort beim Einreichen und der Reihe nach, außer der Test hält den Drucker
 *   an (`pause`, `hangNext`). `wait` wartet deshalb nur mit `realWait` wirklich.
 * - Reihenfolge der Prüfungen beim Einreichen wie im echten Dienst (docs/etiketten.md, 5.3):
 *   Token, Form der Nutzlast und `wait`, `expect_boot_id`, bekannte Kennung, am Server das
 *   Etikett, Drucker, volle Warteschlange, Rendern. Unbekannte Schlüssel übergeht sie.
 * - Am Server schreibt sie ein beim Dienst verworfenes Etikett als `cancelled` fort (so meldet es
 *   das Gerät auch) und ein unterbrochenes als `unknown` mit `interrupted`, wie der echte Server.
 * - Der Auftragsspeicher am Server lebt hier ebenfalls nur im Arbeitsspeicher; `restart` bildet
 *   nach, was die Datei des echten Dienstes über einen Neustart rettet.
 * - Ein bekannter Pfad mit falscher Methode ist hier 404, beim echten Dienst 405.
 * - CORS, die Vorabanfrage (`OPTIONS`) und Local Network Access gehören zum Transport und zum
 *   Browser, nicht hierher (siehe `createFakeNetwork` in fake-api.ts).
 * - Die Seite `/p` (Notweg) ist nur ein Platzhalter.
 *
 * Ohne DOM und ohne Node: läuft in den Tests (jsdom) und im Entwicklungsserver.
 */
import type { DriverStatus, HostHealth, Printer, PrintJob, PrintJobState, ServiceHealth, ServiceJob, ServiceJobState, ServicePrinter } from "@/contract/api.gen";
import { isUuid, newUuid } from "@/contract/ids";

import type { FakeRequestData, FakeResponseData } from "./fake-server";

export const FAKE_PRINT_VERSION = "0.0.0-fake";
export const FAKE_PRINT_TOKEN = "pi-token-0123456789";

/** Ein winziges PNG (1 × 1 Bildpunkt): Platzhalter für jedes „gerenderte" Etikett. */
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export interface FakeServicePrinter {
  name: string;
  /** "image" bestätigt den Druck ("printed") und hebt das Bild auf; alles andere überträgt nur ("sent"), außer `confirms` ist gesetzt. */
  driver?: string;
  model?: string | null;
  confirms?: boolean;
  status?: Partial<DriverStatus>;
}

/** Was der Dienst am Server vom Datenbestand braucht (docs/etiketten.md, 5.8). */
export interface FakePrintBackend {
  /** Gilt das Geräte-Token dieser Anfrage? */
  authorized(headers: Record<string, string | undefined>): boolean;
  /** Alle nicht gelöschten Drucker am Server. */
  printers(): Printer[];
  job(id: string): PrintJob | undefined;
  /** Schreibt den Zustand eines Etiketts fort, als hätte ein Gerät im selben Moment gemeldet. */
  writeJob(id: string, state: PrintJobState, printerId: string, bootId: string, error: string | null): void;
  /** Schreibt den zuletzt gesehenen Zustand eines Druckers fort. */
  writeStatus(printerId: string, bootId: string, status: DriverStatus): void;
}

export interface FakePrintOptions {
  now?: () => Date;
  /** Token des Dienstes am Pi. */
  token?: string;
  /** Drucker des Dienstes am Pi in fester Reihenfolge; der erste ist der Standarddrucker. */
  printers?: FakeServicePrinter[];
  /** Zustand des Rechners; null am Server. */
  host?: HostHealth | null;
  /** Der Dienst läuft im Server: mit Geräte-Token und Datenbestand. */
  backend?: FakePrintBackend;
  /** true: `wait` wartet wirklich, und ein Druck dauert `printMs` (für den Entwicklungsserver). */
  realWait?: boolean;
  /** Dauer eines Drucks in Millisekunden mit `realWait`. Vorgabe 800. */
  printMs?: number;
}

interface StoredJob {
  id: string;
  state: ServiceJobState;
  /** Name des Druckers im Dienst. */
  printer: string;
  error: { code: string; message: string } | null;
  /** Der Inhalt, an dem eine Wiederholung erkannt wird (`content_hash`). */
  hash: string;
  data: Record<string, string> | null;
  /** Hat der Bild-Treiber ein Bild geschrieben? */
  image: boolean;
}

/** Was der Dienst gedruckt hat: ein Eintrag je Druck. Steht eine Kennung zweimal hier, wurde doppelt gedruckt. */
export interface FakePrint {
  id: string;
  printer: string;
  data: Record<string, string> | null;
}

const DEFAULT_STATUS: DriverStatus = { reachable: true, ready: true, media_detected: true, errors: [] };

const ERROR_TEXTS: Record<string, string> = {
  invalid_request: "Die Nutzlast verletzt den Vertrag.",
  unauthorized: "Das Token fehlt oder ist falsch.",
  not_found: "Diesen Auftrag gibt es nicht.",
  unknown_printer: "Diesen Drucker hat der Dienst nicht.",
  job_conflict: "Dieselbe Kennung mit anderem Inhalt.",
  boot_mismatch: "Der Dienst läuft in einem neuen Lauf.",
  not_cancellable: "Der Auftrag wartet nicht mehr.",
  not_pending: "Das Etikett ist verworfen oder schon erledigt.",
  render_failed: "Vorlage oder Daten lassen sich nicht rendern.",
  queue_full: "Zu viele wartende Aufträge.",
};

function json(status: number, body: unknown): FakeResponseData {
  return { status, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) };
}

function failure(status: number, code: string, details: Record<string, unknown> | null = null): FakeResponseData {
  return json(status, { error: { code, message: ERROR_TEXTS[code] ?? code, details } });
}

function png(): FakeResponseData {
  const binary = atob(TINY_PNG);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return { status: 200, headers: { "content-type": "image/png", "cache-control": "no-store" }, body: bytes };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON mit sortierten Schlüsseln: dieselbe Nutzlast ergibt denselben Text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

async function hmacHex(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const imported = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(message)));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface ParsedRequest {
  printer: string | null;
  template: Record<string, unknown> | null;
  data: Record<string, string> | null;
  png: string | null;
  copies: number;
  cut: boolean;
  expectBootId: string | null;
}

/** Prüft die Nutzlast eines Auftrags (wie `JobRequest.from_dict`: unbekannte Schlüssel zählen nicht); null = verletzt den Vertrag. */
function parseJobRequest(body: unknown): ParsedRequest | null {
  if (!isRecord(body)) {
    return null;
  }
  const printer = body.printer ?? null;
  const template = body.template ?? null;
  const data = body.data ?? null;
  const image = body.png ?? null;
  const copies = body.copies ?? 1;
  const cut = body.cut ?? true;
  const expect = body.expect_boot_id ?? null;
  if (printer !== null && (typeof printer !== "string" || printer === "")) {
    return null;
  }
  if (expect !== null && typeof expect !== "string") {
    return null;
  }
  if (typeof copies !== "number" || !Number.isInteger(copies) || copies < 1 || copies > 20 || typeof cut !== "boolean") {
    return null;
  }
  if (image !== null) {
    // Entweder Vorlage und Daten oder ein fertiges Bild.
    if (typeof image !== "string" || image === "" || template !== null || data !== null) {
      return null;
    }
    return { printer, template: null, data: null, png: image, copies, cut, expectBootId: expect };
  }
  if (!isRecord(template) || !isRecord(data) || Object.values(data).some((value) => typeof value !== "string")) {
    return null;
  }
  return { printer, template, data: data as Record<string, string>, png: null, copies, cut, expectBootId: expect };
}

export class FakePrintService {
  /** Kennung dieses Laufs. */
  bootId = newUuid();
  readonly token: string;
  /** Was gedruckt wurde, in der Reihenfolge des Drucks. */
  readonly prints: FakePrint[] = [];
  /** Alle Anfragen, die den Dienst erreicht haben. */
  readonly requests: FakeRequestData[] = [];
  /** Mehr wartende Aufträge nimmt der Dienst nicht an. */
  queueLimit = 100;
  /** true: Schreibende Aufrufe scheitern mit 401, als passte das Token nicht mehr. */
  refuseWrites = false;
  /** Zustand des Rechners in `/v1/health`. */
  host: HostHealth | null;

  private readonly now: () => Date;
  private readonly backend: FakePrintBackend | null;
  private readonly realWait: boolean;
  private readonly printMs: number;
  private piPrinters: FakeServicePrinter[];
  private readonly statusOverrides = new Map<string, Partial<DriverStatus>>();
  private jobs = new Map<string, StoredJob>();
  private queue: string[] = [];
  private paused = false;
  private hangs = 0;
  private hanging: string | null = null;
  private failures: string[] = [];
  private interrupts = 0;
  private startedAt: number;
  private readonly statusWritten = new Map<string, { at: number; text: string }>();
  private listeners: (() => void)[] = [];
  private working = false;

  constructor(options: FakePrintOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.token = options.token ?? FAKE_PRINT_TOKEN;
    this.backend = options.backend ?? null;
    this.realWait = options.realWait ?? false;
    this.printMs = options.printMs ?? 800;
    this.piPrinters = options.printers ?? [{ name: "brother", driver: "brother_ql", model: "QL-820NWB", confirms: true }];
    this.host = options.host === undefined ? (this.backend ? null : { uptime_s: 120, temperature_c: 48.5, throttled: false, undervoltage: null, storage_errors: 0, storage_read_only: false, overlay_used_pct: 2, memory_available_mb: 300 }) : options.host;
    this.startedAt = this.now().getTime();
  }

  // ---------------------------------------------------------------- Steuerung für Tests

  /** Kennungen der gedruckten Aufträge in der Reihenfolge des Drucks. */
  get printed(): string[] {
    return this.prints.map((print) => print.id);
  }

  /** Der Auftrag, wie ihn der Dienst gerade führt. */
  job(id: string): { state: ServiceJobState; error: string | null } | undefined {
    const job = this.jobs.get(id);
    return job ? { state: job.state, error: job.error?.code ?? null } : undefined;
  }

  /** Der Drucker nimmt Aufträge an, druckt aber nicht: Sie warten ("queued"). */
  pause(): void {
    this.paused = true;
  }

  /** Der nächste Druck (oder so viele) bleibt hängen: Der Auftrag steht auf "printing", bis `resume`. */
  hangNext(count = 1): void {
    this.hangs += count;
  }

  /** Der Drucker arbeitet wieder: Ein hängender Druck wird fertig, wartende Aufträge folgen. */
  resume(): void {
    this.paused = false;
    const hanging = this.hanging;
    this.hanging = null;
    if (hanging) {
      this.finish(hanging);
    }
    this.work();
  }

  /** Der nächste Druck (oder so viele) scheitert sicher mit diesem Code des Druckers. */
  failNext(code: string, count = 1): void {
    for (let index = 0; index < count; index += 1) {
      this.failures.push(code);
    }
  }

  /** Beim nächsten Druck reißt die Verbindung zum Drucker mittendrin ab: Der Auftrag wird "unknown". */
  interruptNext(count = 1): void {
    this.interrupts += count;
  }

  /** Setzt den Zustand eines Druckers, wie ihn `/v1/health` meldet. */
  setStatus(printer: string, status: Partial<DriverStatus>): void {
    this.statusOverrides.set(printer, status);
  }

  /** Ersetzt die Drucker des Dienstes am Pi. */
  setPrinters(printers: FakeServicePrinter[]): void {
    this.piPrinters = printers;
  }

  /**
   * Der Dienst startet neu. Am Pi ist danach alles vergessen und die `boot_id` neu. Am Server
   * bleiben `boot_id` und wartende Aufträge; einer, der gerade druckte, ist "unknown" (5.4).
   */
  restart(): void {
    this.startedAt = this.now().getTime();
    this.paused = false;
    this.hangs = 0;
    const hanging = this.hanging;
    this.hanging = null;
    if (!this.backend) {
      this.bootId = newUuid();
      this.jobs = new Map();
      this.queue = [];
      this.changed();
      return;
    }
    if (hanging) {
      this.settle(hanging, "unknown", "interrupted");
    }
    this.work();
  }

  // ---------------------------------------------------------------- Drucker

  private printers(): ServicePrinter[] {
    const configured: FakeServicePrinter[] = this.backend
      ? this.backend.printers().map((printer) => ({
          name: printer.id,
          driver: printer.server?.driver ?? "image",
          model: printer.server?.model ?? null,
          confirms: printer.server?.driver === "image" || !(printer.server?.address ?? "").startsWith("tcp://"),
        }))
      : this.piPrinters;
    return configured.map((printer) => {
      const driver = printer.driver ?? "brother_ql";
      const confirms = printer.confirms ?? driver === "image";
      return {
        name: printer.name,
        driver,
        model: printer.model ?? null,
        capabilities: { dpi: 300, media: { width_mm: 62, length_mm: null, printable_px: 696 }, cutter: true, colors: ["black"], status_query: true, confirms_print: confirms },
        status: { ...DEFAULT_STATUS, ...printer.status, ...this.statusOverrides.get(printer.name) },
      };
    });
  }

  /** Am Server: den zuletzt gesehenen Zustand der Drucker fortschreiben, höchstens einmal je Minute, außer er ändert sich. */
  private writeStatuses(only?: string): void {
    if (!this.backend) {
      return;
    }
    const nowMs = this.now().getTime();
    for (const printer of this.printers()) {
      if (only !== undefined && printer.name !== only) {
        continue;
      }
      const text = canonical(printer.status);
      const last = this.statusWritten.get(printer.name);
      if (last && last.text === text && Math.abs(nowMs - last.at) < 60_000) {
        continue;
      }
      this.statusWritten.set(printer.name, { at: nowMs, text });
      this.backend.writeStatus(printer.name, this.bootId, printer.status);
    }
  }

  // ---------------------------------------------------------------- Aufträge

  private describe(job: StoredJob): ServiceJob {
    const position = job.state === "queued" ? this.queue.indexOf(job.id) : -1;
    return { id: job.id, state: job.state, printer: job.printer, boot_id: this.bootId, error: job.error, position: position === -1 ? null : position };
  }

  private changed(): void {
    for (const listener of this.listeners.splice(0)) {
      listener();
    }
  }

  private settle(id: string, state: ServiceJobState, error: string | null): void {
    const job = this.jobs.get(id);
    if (!job) {
      return;
    }
    job.state = state;
    job.error = error === null ? null : { code: error, message: error };
    if (this.backend) {
      // Der Server schreibt den Zustand des Etiketts selbst fort (5.8).
      this.backend.writeJob(id, state, job.printer, this.bootId, error);
      this.writeStatuses(job.printer);
    }
    this.changed();
  }

  /** Bringt einen Druck zu Ende, mit dem Ausgang, den der Test vorgibt. */
  private finish(id: string): void {
    const job = this.jobs.get(id);
    if (!job) {
      return;
    }
    if (this.interrupts > 0) {
      this.interrupts -= 1;
      this.settle(id, "unknown", "interrupted");
      return;
    }
    const printer = this.printers().find((candidate) => candidate.name === job.printer);
    const forced = this.failures.shift();
    const failed = forced ?? (printer ? (printer.status.errors[0] ?? (printer.status.reachable ? undefined : "offline")) : "config");
    if (failed !== undefined) {
      this.settle(id, "failed", failed);
      return;
    }
    this.prints.push({ id, printer: job.printer, data: job.data });
    job.image = printer?.driver === "image";
    this.settle(id, printer?.capabilities.confirms_print ? "printed" : "sent", null);
  }

  /** Arbeitet die Warteschlange ab: der Reihe nach, einer zur Zeit. */
  private work(): void {
    if (this.working) {
      return;
    }
    this.working = true;
    try {
      while (!this.paused && this.hanging === null && this.queue.length > 0) {
        const id = this.queue.shift() as string;
        const job = this.jobs.get(id);
        if (!job) {
          continue;
        }
        job.state = "printing";
        if (this.backend) {
          this.backend.writeJob(id, "printing", job.printer, this.bootId, null);
        }
        if (this.hangs > 0) {
          this.hangs -= 1;
          this.hanging = id;
          this.changed();
          return;
        }
        if (this.realWait) {
          // Im Entwicklungsserver dauert ein Druck, damit man "queued" und "printing" sieht.
          this.hanging = id;
          this.changed();
          setTimeout(() => {
            if (this.hanging === id) {
              this.hanging = null;
              this.finish(id);
              this.work();
            }
          }, this.printMs);
          return;
        }
        this.finish(id);
      }
    } finally {
      this.working = false;
    }
  }

  /** Wartet (nur mit `realWait`) bis zu `seconds` auf einen Endzustand des Auftrags. */
  private async wait(id: string, seconds: number): Promise<void> {
    if (!this.realWait || seconds <= 0) {
      return;
    }
    const deadline = Date.now() + seconds * 1_000;
    for (;;) {
      const job = this.jobs.get(id);
      if (!job || (job.state !== "queued" && job.state !== "printing")) {
        return;
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        return;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.listeners.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  private submit(id: string, request: ParsedRequest): FakeResponseData | StoredJob {
    if (request.expectBootId !== null && request.expectBootId !== this.bootId) {
      return failure(409, "boot_mismatch", { boot_id: this.bootId });
    }
    const hash = canonical({ printer: request.printer, template: request.template, data: request.data, png: request.png, copies: request.copies, cut: request.cut });
    const known = this.jobs.get(id);
    if (known) {
      // Derselbe Auftrag noch einmal: nicht drucken, den vorhandenen Zustand liefern (5.4).
      return known.hash === hash ? known : failure(409, "job_conflict");
    }
    if (this.backend) {
      // Nur bekannte Etiketten, und nur ausstehende (5.8).
      const label = this.backend.job(id);
      if (!label) {
        return failure(404, "not_found");
      }
      if (label.state !== "pending") {
        return failure(409, "not_pending");
      }
    }
    const printers = this.printers();
    // Am Pi ist der erste Drucker der Standarddrucker; der Dienst im Server hat keinen.
    const printer = request.printer === null ? (this.backend ? undefined : printers[0]) : printers.find((candidate) => candidate.name === request.printer);
    if (!printer) {
      return failure(404, "unknown_printer");
    }
    if (this.queue.length >= this.queueLimit) {
      return failure(503, "queue_full");
    }
    if (request.png === null && request.template?.schema !== 1) {
      return failure(422, "render_failed");
    }
    const job: StoredJob = { id, state: "queued", printer: printer.name, error: null, hash, data: request.data, image: false };
    this.jobs.set(id, job);
    this.queue.push(id);
    if (this.backend) {
      this.backend.writeJob(id, "queued", job.printer, this.bootId, null);
    }
    this.work();
    return job;
  }

  // ---------------------------------------------------------------- Die Schnittstelle

  /** Darf diese Anfrage schreiben? Am Pi mit dem Token des Druckers, im Rumpf oder im Kopf. */
  private mayWrite(request: FakeRequestData, body: unknown): boolean {
    if (this.refuseWrites) {
      return false;
    }
    if (this.backend) {
      return true;
    }
    const header = request.headers.authorization ?? "";
    const given = isRecord(body) && typeof body.token === "string" ? body.token : header.startsWith("Bearer ") ? header.slice(7) : "";
    return given === this.token;
  }

  /** Beantwortet einen Aufruf. `request.path` ist der Pfad unterhalb der Basis, z. B. "/v1/health". */
  async handle(request: FakeRequestData): Promise<FakeResponseData> {
    this.requests.push(request);
    const { method, path } = request;
    const query = new URLSearchParams(request.query ?? "");
    // Am Server braucht jeder Aufruf das Geräte-Token, auch die lesenden (5.8).
    if (this.backend && !this.backend.authorized(request.headers)) {
      return failure(401, "unauthorized");
    }
    let body: unknown;
    if (request.body !== "") {
      try {
        // Der Dienst liest den Rumpf immer als JSON, gleich welcher Content-Type gesetzt ist (5.2).
        body = JSON.parse(request.body);
      } catch {
        return failure(400, "invalid_request");
      }
    }
    // `wait`: 0 bis 30 Sekunden, Vorgabe 0; anderes ist wie beim echten Dienst `invalid_request`.
    const waitRaw = query.get("wait");
    const waitS = waitRaw === null || waitRaw === "" ? 0 : Number(waitRaw);
    const waitValid = Number.isFinite(waitS) && waitS >= 0 && waitS <= 30;

    if (method === "GET" && path === "/v1/health") {
      const nonce = query.get("nonce");
      if (nonce !== null && !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) {
        return failure(400, "invalid_request");
      }
      this.writeStatuses();
      const health: ServiceHealth = {
        app: "stowly-print",
        version: FAKE_PRINT_VERSION,
        protocol: 1,
        boot_id: this.bootId,
        uptime_s: Math.max(0, (this.now().getTime() - this.startedAt) / 1_000),
        // Am Server entfällt der Nachweis: Dort bürgt die Verbindung selbst (5.5).
        proof: nonce === null || this.backend ? null : await hmacHex(this.token, nonce),
        host: this.host,
        printers: this.printers(),
      };
      return json(200, health);
    }
    if (method === "GET" && path === "/v1/printers") {
      return json(200, { printers: this.printers() });
    }
    if (method === "GET" && path === "/p" && !this.backend) {
      return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: "<!doctype html><title>Stowly-Druckdienst (Nachbildung)</title><p>Platzhalter für die Seite des Druckdienstes.</p>" };
    }
    if (method === "POST" && path === "/v1/render") {
      if (!this.mayWrite(request, body)) {
        return failure(401, "unauthorized");
      }
      if (!isRecord(body) || !isRecord(body.template) || !isRecord(body.data)) {
        return failure(400, "invalid_request");
      }
      const wanted = body.printer ?? null;
      if (wanted !== null && !this.printers().some((printer) => printer.name === wanted)) {
        return failure(404, "unknown_printer");
      }
      if (body.template.schema !== 1 || Object.values(body.data).some((value) => typeof value !== "string")) {
        return failure(422, "render_failed");
      }
      return png();
    }

    const match = /^\/v1\/jobs\/([^/]+)(\/cancel|\/image)?$/.exec(path);
    if (!match) {
      return failure(404, "not_found");
    }
    const id = decodeURIComponent(match[1] ?? "");
    const suffix = match[2] ?? "";

    if (suffix === "/image" && method === "GET") {
      const job = this.jobs.get(id);
      // Nur beim Bild-Treiber, und erst, wenn gedruckt ist.
      return job?.image ? png() : failure(404, "not_found");
    }
    if (suffix === "" && method === "GET") {
      if (!waitValid) {
        return failure(400, "invalid_request");
      }
      await this.wait(id, waitS);
      const job = this.jobs.get(id);
      return job ? json(200, this.describe(job)) : failure(404, "not_found");
    }
    if ((suffix === "/cancel" && method === "POST") || (suffix === "" && method === "DELETE")) {
      if (!this.mayWrite(request, body)) {
        return failure(401, "unauthorized");
      }
      const job = this.jobs.get(id);
      if (!job) {
        return failure(404, "not_found");
      }
      if (job.state === "failed" && job.error?.code === "cancelled") {
        return json(200, this.describe(job));
      }
      if (job.state !== "queued") {
        return failure(409, "not_cancellable");
      }
      // Verworfene Aufträge bleiben bekannt, damit eine verspätete Wiederholung nicht doch noch druckt.
      this.queue = this.queue.filter((candidate) => candidate !== id);
      this.settle(id, "failed", "cancelled");
      return json(200, this.describe(job));
    }
    if (suffix === "" && (method === "POST" || method === "PUT")) {
      if (!this.mayWrite(request, body)) {
        return failure(401, "unauthorized");
      }
      const parsed = isUuid(id) && waitValid ? parseJobRequest(body) : null;
      if (!parsed) {
        return failure(400, "invalid_request");
      }
      const known = this.jobs.has(id);
      const result = this.submit(id, parsed);
      if ("status" in result) {
        return result;
      }
      await this.wait(id, waitS);
      return json(known ? 200 : 201, this.describe(this.jobs.get(id) ?? result));
    }
    return failure(404, "not_found");
  }
}
