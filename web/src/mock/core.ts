/**
 * Die Attrappe: ein vollständiger `Core` im Arbeitsspeicher, ohne Server und ohne IndexedDB.
 *
 * Sie verhält sich nach außen wie der echte Kern (src/contract/core.ts), vereinfacht aber
 * alles dahinter: Es gibt keine Outbox und keine Konflikte, der „Sync" ist eine Stoppuhr.
 * Nach dem Neuladen der Seite sind alle Änderungen weg.
 *
 * Gleich wie im Kern: die Eingabeprüfungen samt ihren Sätzen (src/contract/input.ts), die
 * Regel, welcher Drucker ein Etikett druckt (`printerIdForJob`), und „Löschen gewinnt": Eine
 * Änderung an einer entnommenen Packung wird aufgehoben statt angewendet.
 *
 * Der Druck ist nachgespielt: Ein Drucker am Server ist erreichbar, solange der Server es
 * ist; der direkte Drucker (Pi) nur mit der Ausgangslage "at-pi" oder nach
 * `stowlyMock.setPiReachable(true)`. Eigene ausstehende Etiketten eines erreichbaren
 * Druckers werden von selbst gedruckt; wie das ausgeht, bestimmt `stowlyMock.setPrintOutcome`.
 * Warum der Pi nicht benutzbar ist, lässt sich mit `stowlyMock.setPiProblem("permission")`
 * (oder einem anderen `PrinterProblem`) vorgeben. Wie im Kern ändert ein Zwischenstand kein
 * Etikett mit Ausgang, und `print.flush` erfüllt sich nach dem Einreichen, nicht erst mit dem
 * Ergebnis.
 */
import {
  addDays,
  APP_VERSION,
  CoreError,
  checkBarcode,
  checkBarcodeCount,
  checkBestBefore,
  checkDeviceName,
  checkDirectConfig,
  checkRetentionDays,
  checkServerConfig,
  checkStoreCount,
  checkWarnDays,
  checkZoneColor,
  checkZoneIcon,
  cleanText,
  DEFAULT_DEVICE_PREFS,
  LIMITS,
  MAX_HANDOFF_JOBS,
  MAX_SYNC_PROBLEMS,
  newUuid,
  optionalText,
  printerIdForJob,
  progressAfterOutcome,
  randomPackageId,
  requiredText,
  toLocalDate,
  willLookUp,
  type AppState,
  type Core,
  type Device,
  type DevicePrefs,
  type DisplacedChange,
  type NewPrinter,
  type NewProduct,
  type NewZone,
  type Package,
  type PackageChanges,
  type Printer,
  type PrinterChanges,
  type PrinterProbe,
  type PrinterProblem,
  type PrinterStatus,
  type PrintFlushReport,
  type PrintJob,
  type Product,
  type ProductChanges,
  type ProductRef,
  type RemovalReason,
  type ServiceHealth,
  type SessionState,
  type SettingsChanges,
  type StoreInput,
  type StoreResult,
  type SyncProblem,
  type SyncStatus,
  type Zone,
  type ZoneChanges,
} from "@/contract";

import { MOCK_IMAGES, SAMPLE_IMAGE_ID } from "./images";
import { derived, LiveValue } from "./live";
import { PREVIEW_PNG_BASE64 } from "./preview";
import { createEmptyData, createLargeData, createSampleData, createSingleZoneData, DEVICE_IDS, PRINTER_IDS, troubledPrinterStatus, type MockData } from "./sample";

/**
 * Ausgangslagen zum Ausprobieren, im Browser über `?mock=…` wählbar (mehrere mit Komma):
 *
 * - "empty":       frisch eingerichtet, eine Zone, kein Bestand
 * - "single-zone": Beispieldaten mit nur einer Zone
 * - "signed-out":  nicht angemeldet (Passwort der Attrappe: "stowly")
 * - "revoked":     Token gesperrt, drei ungesendete Änderungen
 * - "offline":     Server nicht erreichbar, vier ungesendete Änderungen
 * - "problems":    eine abgelehnte und eine verdrängte Änderung
 * - "update":      eine neue Version der App wartet
 * - "update-required": ein anderer Tab hat die lokale Datenbank übernommen; dieser muss neu laden
 * - "insecure":    Aufruf über http://<LAN-IP>: kein Scannen, kein Offline-Betrieb
 * - "ios":         iPhone im Browser, nicht installiert: Anleitung statt Aufforderung
 * - "installable": der Browser bietet die Installation an
 * - "no-lookup":   der Server schlägt keine Barcodes nach (STOWLY_OFF_ENABLED=0)
 * - "large":       großer Bestand: gut 2000 Packungen in gut 300 Produkten
 * - "at-pi":       dieses Gerät ist im WLAN des Pi: Der direkte Drucker ist erreichbar.
 *                  Zusammen mit "offline" ist das die Lage im Keller.
 * - "printer-trouble": beide Drucker melden Störungen (Etiketten leer, Pi heiß, SD-Karte)
 */
export type MockScenario =
  | "empty"
  | "single-zone"
  | "signed-out"
  | "revoked"
  | "offline"
  | "problems"
  | "update"
  | "update-required"
  | "insecure"
  | "ios"
  | "installable"
  | "no-lookup"
  | "large"
  | "at-pi"
  | "printer-trouble";

export const MOCK_SCENARIOS: readonly MockScenario[] = [
  "empty",
  "single-zone",
  "signed-out",
  "revoked",
  "offline",
  "problems",
  "update",
  "update-required",
  "insecure",
  "ios",
  "installable",
  "no-lookup",
  "large",
  "at-pi",
  "printer-trouble",
];

/** Wie ein nachgespielter Druck ausgeht. */
export type MockPrintOutcome = "printed" | "failed" | "unknown";

export const MOCK_PASSWORD = "stowly";

export interface MockOptions {
  scenarios?: readonly MockScenario[];
  /** Eigene Daten statt der Beispieldaten, z. B. für Tests. Fehlendes wird ergänzt. */
  data?: Partial<MockData>;
  /** Uhr der Attrappe. Vorgabe: die echte. */
  now?: () => Date;
  /** Verzögerung der simulierten Abläufe (Sync, Nachschlagen, Druck) in Millisekunden. 0 = sofort. Vorgabe 600. */
  latency?: number;
}

/** Eingriffe von außen: für Tests und zum Ausprobieren in der Konsole (`window.stowlyMock`). */
export interface MockControl {
  /** Server erreichbar oder nicht. */
  setOnline(online: boolean): void;
  /** Sperrt das Token, als hätte ein anderes Gerät dieses hier abgemeldet. */
  revoke(): void;
  /** Meldet eine neue Version der App. */
  setUpdateReady(ready: boolean): void;
  /** Fügt eine abgelehnte oder verdrängte Änderung hinzu. */
  addProblem(problem: SyncProblem): void;
  /** Der direkte Drucker (Pi) ist erreichbar oder nicht; erreichbar druckt er Ausstehendes sofort. */
  setPiReachable(reachable: boolean): void;
  /**
   * Warum der direkte Drucker gerade nicht benutzbar ist, wie es der echte Kern meldet
   * ("permission", "blocked", "not_verified", "unknown_printer", "insecure_context", …), oder
   * null: dann gilt `setPiReachable`. Wirkt auf `printers.probe` und `print.flush`.
   */
  setPiProblem(problem: PrinterProblem | null): void;
  /** Wie die nächsten Drucke ausgehen: "printed" (Vorgabe), "failed" (Etiketten leer) oder "unknown". */
  setPrintOutcome(outcome: MockPrintOutcome): void;
  /** Der Server schlägt Barcodes nach oder nicht (`sync.status.lookup_enabled`). */
  setLookupEnabled(enabled: boolean): void;
  /** Aktueller Datenbestand der Attrappe. */
  snapshot(): MockData;
}

export interface MockCore extends Core {
  readonly control: MockControl;
}

function sortZones(zones: Zone[]): Zone[] {
  return [...zones].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "de"));
}

export function createMockCore(options: MockOptions = {}): MockCore {
  const scenarios = new Set(options.scenarios ?? []);
  const clock = options.now ?? (() => new Date());
  const latency = options.latency ?? 600;
  const stamp = () => clock().toISOString();
  const today = () => toLocalDate(clock());

  const chosen = scenarios.has("empty")
    ? createEmptyData(clock())
    : scenarios.has("single-zone")
      ? createSingleZoneData(clock())
      : scenarios.has("large")
        ? createLargeData(clock())
        : createSampleData(clock());
  const base: MockData = scenarios.has("printer-trouble") ? { ...chosen, printerStatus: troubledPrinterStatus(clock()) } : chosen;
  const state = new LiveValue<MockData>({ ...base, ...options.data });

  /** Name, unter dem das Gerät der Attrappe angemeldet ist oder zuletzt war. */
  const currentName = () => state.get().devices.find((device) => device.current)?.name ?? null;

  const session = new LiveValue<SessionState>(
    scenarios.has("signed-out")
      ? { status: "signed_out", reason: "never", last_device_name: null }
      : scenarios.has("revoked")
        ? { status: "signed_out", reason: "revoked", last_device_name: currentName() }
        : { status: "signed_in", device: { id: DEVICE_IDS.current, name: currentName() ?? "Dieses Gerät" } },
  );

  const offline = scenarios.has("offline");
  const syncStatus = new LiveValue<SyncStatus>({
    online: !offline,
    phase: offline ? "error" : "idle",
    pending: scenarios.has("revoked") ? 3 : offline ? 4 : 0,
    last_synced_at: offline ? new Date(clock().getTime() - 3 * 3_600_000).toISOString() : stamp(),
    last_error: offline ? { code: "offline", message: "Der Server ist nicht erreichbar.", at: stamp() } : null,
    server_version: "0.1.0",
    lookup_enabled: !scenarios.has("no-lookup"),
  });

  /** Alle Sync-Probleme, wie sie eingetroffen sind; was die Oberfläche sieht, ist `visibleProblems`. */
  const problems = new LiveValue<SyncProblem[]>(scenarios.has("problems") ? sampleProblems(state.get(), stamp()) : []);
  const prefs = new LiveValue<DevicePrefs>({ ...DEFAULT_DEVICE_PREFS });
  const app = new LiveValue<AppState>({
    version: APP_VERSION,
    secure_context: !scenarios.has("insecure"),
    installed: false,
    can_install: scenarios.has("installable"),
    manual_install: scenarios.has("ios") ? "ios" : null,
    update_ready: scenarios.has("update"),
    update_required: scenarios.has("update-required"),
    storage_persistent: null,
  });

  // Nachgespielter Druck (siehe Kopf der Datei).
  let piReachable = scenarios.has("at-pi");
  /** Ein Grund, aus dem der Pi nicht benutzbar ist (`setPiProblem`); null = es gilt `piReachable`. */
  let piProblem: PrinterProblem | null = null;
  let printOutcome: MockPrintOutcome = "printed";
  const troubled = scenarios.has("printer-trouble");
  const BOOT_IDS = { server: "5e77e700-0000-4000-8000-000000000001", pi: "c0ffee00-0000-4000-8000-000000000001" } as const;

  // ---------------------------------------------------------------- Hilfen

  /** Führt etwas nach der simulierten Wartezeit aus; ohne Wartezeit sofort. */
  function later(action: () => void, factor = 1): void {
    if (latency <= 0) {
      action();
    } else {
      setTimeout(action, latency * factor);
    }
  }

  function wait(factor = 1): Promise<void> {
    return new Promise((resolve) => later(resolve, factor));
  }

  let syncScheduled = false;

  function finishSync(): void {
    syncScheduled = false;
    if (syncStatus.get().online && session.get().status === "signed_in") {
      syncStatus.update((status) => ({ ...status, phase: "idle", pending: 0, last_synced_at: stamp(), last_error: null }));
    }
  }

  /** Jede Änderung zählt als ein ungesendeter Befehl, bis der „Sync" sie abholt. */
  function changed(commands = 1): void {
    syncStatus.update((status) => ({ ...status, pending: status.pending + commands }));
    if (!syncStatus.get().online || syncScheduled) {
      return;
    }
    syncScheduled = true;
    later(() => {
      syncStatus.update((status) => ({ ...status, phase: "syncing" }));
      later(finishSync, 0.5);
    });
  }

  function requireOnline(): void {
    if (!syncStatus.get().online) {
      throw new CoreError("offline", "Der Server ist nicht erreichbar.");
    }
  }

  function mutate(change: (data: MockData) => MockData, commands = 1): void {
    state.update(change);
    changed(commands);
  }

  function activeProduct(id: string): Product {
    let product = state.get().products.find((candidate) => candidate.id === id);
    // einer Zusammenführung zum Ziel folgen
    for (let hops = 0; product?.merged_into && hops < 10; hops += 1) {
      const target = product.merged_into;
      product = state.get().products.find((candidate) => candidate.id === target);
    }
    if (!product || product.deleted_at !== null) {
      throw new CoreError("not_found", "Das Produkt gibt es nicht.");
    }
    return product;
  }

  function activeZone(id: string): Zone {
    const zone = state.get().zones.find((candidate) => candidate.id === id && candidate.deleted_at === null);
    if (!zone) {
      throw new CoreError("not_found", "Die Zone gibt es nicht.");
    }
    return zone;
  }

  function existingPackages(ids: string[]): Package[] {
    return ids.map((id) => {
      const pkg = state.get().packages.find((candidate) => candidate.id === id);
      if (!pkg) {
        throw new CoreError("not_found", `Die Packung ${id} gibt es nicht.`);
      }
      return pkg;
    });
  }

  function activePrinter(id: string): Printer {
    const printer = state.get().printers.find((candidate) => candidate.id === id && candidate.deleted_at === null);
    if (!printer) {
      throw new CoreError("not_found", "Den Drucker gibt es nicht.");
    }
    return printer;
  }

  function hasPrinter(): boolean {
    return state.get().printers.some((printer) => printer.deleted_at === null);
  }

  function requirePrinter(): void {
    if (!hasPrinter()) {
      throw new CoreError("not_found", "Es ist kein Drucker eingerichtet.");
    }
  }

  function barcodeOwner(barcode: string): Product | undefined {
    return state.get().products.find((product) => product.deleted_at === null && product.barcodes.includes(barcode));
  }

  function newPackageId(): string {
    for (;;) {
      const id = randomPackageId();
      if (!state.get().packages.some((pkg) => pkg.id === id)) {
        return id;
      }
    }
  }

  /** Baut ein Produkt aus schon geprüften Angaben. */
  function buildProduct(input: NewProduct, lookup: Product["lookup"]): Product {
    const now = stamp();
    return {
      id: newUuid(),
      name: input.name,
      brand: input.brand ?? "",
      quantity: input.quantity ?? "",
      image: null,
      warn_days: input.warn_days ?? null,
      lookup,
      barcodes: [...new Set(input.barcodes ?? [])].sort(),
      created_at: now,
      updated_at: now,
      deleted_at: null,
      merged_into: null,
    };
  }

  /** Spielt das Nachschlagen bei Open Food Facts nach: gerade Endziffer = gefunden. */
  function simulateLookup(productId: string, barcode: string): void {
    later(() => {
      if (!syncStatus.get().online) {
        return; // bleibt "pending", bis der Server wieder da ist
      }
      const found = Number(barcode.at(-1)) % 2 === 0;
      state.update((data) => ({
        ...data,
        products: data.products.map((product) =>
          product.id === productId && product.lookup === "pending"
            ? {
                ...product,
                lookup: found ? "found" : "not_found",
                name: found && product.name === "" ? `Beispielprodukt ${barcode.slice(-4)}` : product.name,
                brand: found && product.brand === "" ? "Beispielmarke" : product.brand,
                quantity: found && product.quantity === "" ? "500 g" : product.quantity,
                image: found && product.image === null ? SAMPLE_IMAGE_ID : product.image,
                updated_at: stamp(),
              }
            : product,
        ),
      }));
    }, 4);
  }

  function resolveProduct(ref: ProductRef): { product: Product; created: boolean } {
    if (ref.kind === "existing") {
      return { product: activeProduct(ref.product_id), created: false };
    }
    if (ref.kind === "barcode") {
      checkBarcode(ref.barcode);
      const known = barcodeOwner(ref.barcode);
      if (known) {
        return { product: known, created: false };
      }
      // Dieselbe Regel wie im Kern: Nur was der Server nachschlägt, beginnt als "pending".
      const lookup = willLookUp(ref.barcode, syncStatus.get().lookup_enabled) ? "pending" : "none";
      const name = optionalText(ref.name, LIMITS.product_name, "Der Name");
      return { product: buildProduct({ name, barcodes: [ref.barcode] }, lookup), created: true };
    }
    const name = requiredText(ref.name, LIMITS.product_name, "Das Produkt");
    const brand = optionalText(ref.brand, LIMITS.brand, "Die Marke");
    const quantity = optionalText(ref.quantity, LIMITS.quantity, "Die Packungsgröße");
    checkWarnDays(ref.warn_days);
    const barcodes = [...new Set(ref.barcodes ?? [])];
    checkBarcodeCount(barcodes.length);
    for (const barcode of barcodes) {
      checkBarcode(barcode);
      const owner = barcodeOwner(barcode);
      if (owner) {
        throw new CoreError("barcode_taken", "Der Barcode gehört schon zu einem anderen Produkt.", { product_id: owner.id });
      }
    }
    return { product: buildProduct({ name, brand, quantity, warn_days: ref.warn_days ?? null, barcodes }, "none"), created: true };
  }

  function buildJob(subject: { package_id: string } | { zone_id: string }, printerId: string | null): PrintJob {
    const now = stamp();
    const device = session.get();
    return {
      id: newUuid(),
      kind: "package_id" in subject ? "package" : "zone",
      package_id: "package_id" in subject ? subject.package_id : null,
      zone_id: "zone_id" in subject ? subject.zone_id : null,
      printer_id: printerId,
      state: "pending",
      error: null,
      boot_id: null,
      device_id: device.status === "signed_in" ? device.device.id : null,
      created_at: now,
      updated_at: now,
    };
  }

  function setJobState(id: string, next: PrintJob["state"], error: string | null = null, changes: Partial<PrintJob> = {}): void {
    state.update((data) => ({
      ...data,
      // Wie im Kern und beim Server: Ein Zwischenstand ändert kein Etikett mit Ausgang (Protokoll 6.6).
      printJobs: data.printJobs.map((job) =>
        job.id === id && !progressAfterOutcome(job.state, next) ? { ...job, ...changes, state: next, error, updated_at: stamp() } : job,
      ),
    }));
  }

  function findJob(id: string): PrintJob {
    const job = state.get().printJobs.find((candidate) => candidate.id === id);
    if (!job) {
      throw new CoreError("not_found", "Das Etikett gibt es nicht.");
    }
    return job;
  }

  /** Welcher Drucker ein Etikett druckt: dieselbe Regel wie im Kern (`printerIdForJob`). */
  function printerFor(job: PrintJob): Printer | undefined {
    const data = state.get();
    const printerId = printerIdForJob(job, {
      package: (id) => data.packages.find((candidate) => candidate.id === id),
      zone: (id) => data.zones.find((candidate) => candidate.id === id),
      printer: (id) => data.printers.find((candidate) => candidate.id === id),
      settings: data.settings,
    });
    return data.printers.find((printer) => printer.id === printerId);
  }

  /** Erreicht dieses Gerät den Druckdienst des Druckers? */
  function reachable(printer: Printer): boolean {
    return printer.connection === "server" ? syncStatus.get().online === true : piReachable && piProblem === null;
  }

  /** Warum ein Drucker nicht benutzbar ist, wie der Kern es meldet (nur, wenn er es nicht ist). */
  function problemOf(printer: Printer): { problem: PrinterProblem; message: string } {
    if (printer.connection === "server") {
      return { problem: "offline", message: "Der Server ist nicht erreichbar." };
    }
    return piProblem === null
      ? { problem: "unreachable", message: "Der Druckdienst antwortet auf keiner Adresse." }
      : { problem: piProblem, message: "Der Druckdienst ist nicht benutzbar (Attrappe)." };
  }

  function ownDeviceId(): string | null {
    const current = session.get();
    return current.status === "signed_in" ? current.device.id : null;
  }

  /** Die eigenen ausstehenden Etiketten: Nur die stellt dieses Gerät zu. */
  function ownPending(): PrintJob[] {
    const own = ownDeviceId();
    return state
      .get()
      .printJobs.filter((job) => job.state === "pending" && job.device_id === own)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  }

  function printerStatusFor(printer: Printer): PrinterStatus {
    const direct = printer.connection === "direct";
    const sample = troubled ? troubledPrinterStatus(clock()).find((status) => status.printer_id === (direct ? PRINTER_IDS.cellar : PRINTER_IDS.kitchen)) : undefined;
    return {
      printer_id: printer.id,
      observed_at: stamp(),
      boot_id: direct ? BOOT_IDS.pi : BOOT_IDS.server,
      status: sample?.status ?? { reachable: true, ready: true, media_detected: direct ? true : null, errors: [] },
      host: direct
        ? (sample?.host ?? {
            uptime_s: 4321,
            temperature_c: 49.8,
            throttled: false,
            undervoltage: null,
            storage_errors: 0,
            storage_read_only: false,
            overlay_used_pct: 8.1,
            memory_available_mb: 298,
          })
        : null,
    };
  }

  function rememberStatus(status: PrinterStatus): void {
    state.update((data) => ({
      ...data,
      printerStatus: [...data.printerStatus.filter((candidate) => candidate.printer_id !== status.printer_id), status],
    }));
  }

  /**
   * Ein Zustellversuch: Eigene ausstehende Etiketten eines erreichbaren Druckers werden
   * angenommen ("queued") und nach der Wartezeit gedruckt. Liefert, was der Versuch gebracht hat.
   */
  function deliver(): PrintFlushReport {
    const report: PrintFlushReport = { delivered: 0, pending: 0, problems: [] };
    const accepted: { job: PrintJob; printer: Printer }[] = [];
    const seen = new Set<string | null>();
    for (const job of ownPending()) {
      const printer = printerFor(job);
      if (printer && reachable(printer)) {
        accepted.push({ job, printer });
        continue;
      }
      report.pending += 1;
      const key = printer?.id ?? null;
      if (!seen.has(key)) {
        seen.add(key);
        report.problems.push(
          !printer ? { printer_id: null, problem: "no_printer", message: "Dem Etikett ist kein Drucker zugeordnet." } : { printer_id: printer.id, ...problemOf(printer) },
        );
      }
    }
    report.delivered = accepted.length;
    if (accepted.length === 0) {
      return report;
    }
    for (const printer of new Set(accepted.map((entry) => entry.printer))) {
      rememberStatus(printerStatusFor(printer));
    }
    for (const { job, printer } of accepted) {
      const bootId = printer.connection === "direct" ? BOOT_IDS.pi : BOOT_IDS.server;
      setJobState(job.id, "queued", null, { printer_id: printer.id, boot_id: bootId });
    }
    const outcome = printOutcome;
    later(() => {
      for (const { job } of accepted) {
        if (state.get().printJobs.find((candidate) => candidate.id === job.id)?.state !== "queued") {
          continue; // inzwischen verworfen
        }
        if (outcome === "printed") {
          setJobState(job.id, "printed");
        } else if (outcome === "failed") {
          setJobState(job.id, "failed", "no_media");
        } else {
          setJobState(job.id, "unknown", "interrupted");
        }
      }
      changed(accepted.length);
    }, 2);
    return report;
  }

  /** Stellt nach einer Änderung von selbst zu, so wie es der Kern tut. */
  function deliverSoon(): void {
    later(() => {
      deliver();
    });
  }

  /** Eine Bearbeitung, die eine entnommene Packung traf: aufheben statt anwenden (Sync-Protokoll 7.2). */
  function displace(pkg: Package, fresh: DisplacedChange[], at: string): Package {
    const kept = (pkg.displaced?.changes ?? []).filter((old) => !fresh.some((change) => change.field === old.field));
    return { ...pkg, displaced: { at, changes: [...kept, ...fresh] } };
  }

  /**
   * Was `sync.problems` zeigt: höchstens `MAX_SYNC_PROBLEMS`, und ein "displaced"-Eintrag nur,
   * solange seine Packung die verdrängte Bearbeitung noch trägt.
   */
  const visibleProblems = new LiveValue<SyncProblem[]>([]);
  function refreshProblems(): void {
    const packages = state.get().packages;
    const next = problems
      .get()
      .filter((problem) => {
        if (problem.status !== "displaced" || problem.command.type !== "package.update") {
          return true;
        }
        const packageId = problem.command.package_id;
        const pkg = packages.find((candidate) => candidate.id === packageId);
        return pkg !== undefined && pkg.removed_at !== null && pkg.displaced !== null;
      })
      .slice(0, MAX_SYNC_PROBLEMS);
    const current = visibleProblems.get();
    if (next.length !== current.length || next.some((problem, index) => problem !== current[index])) {
      visibleProblems.set(next);
    }
  }
  refreshProblems();
  problems.subscribe(refreshProblems);
  state.subscribe(refreshProblems);

  function previewImage(): Blob {
    const bytes = Uint8Array.from(atob(PREVIEW_PNG_BASE64), (char) => char.charCodeAt(0));
    return new Blob([bytes], { type: "image/png" });
  }

  // ---------------------------------------------------------------- Die Schnittstelle

  const core: MockCore = {
    session: {
      state: session,
      async login(password, deviceName) {
        await wait();
        requireOnline();
        const name = checkDeviceName(deviceName);
        if (password !== MOCK_PASSWORD) {
          throw new CoreError("invalid_password", "Das Passwort stimmt nicht.");
        }
        state.update((data) => ({
          ...data,
          devices: data.devices.map((device) => (device.current ? { ...device, name, last_seen_at: stamp() } : device)),
        }));
        session.set({ status: "signed_in", device: { id: DEVICE_IDS.current, name } });
        finishSync();
      },
      async logout(logoutOptions) {
        const pending = syncStatus.get().pending;
        if (pending > 0 && !logoutOptions?.discard_pending) {
          throw new CoreError("pending_changes", "Es gibt ungesendete Änderungen.", { pending });
        }
        syncStatus.update((status) => ({ ...status, pending: 0 }));
        problems.set([]);
        // Der Name bleibt als Vorschlag für die nächste Anmeldung.
        session.set({ status: "signed_out", reason: "logout", last_device_name: currentName() });
      },
    },

    sync: {
      status: syncStatus,
      problems: visibleProblems,
      async now() {
        syncStatus.update((status) => ({ ...status, phase: "syncing" }));
        await wait();
        if (syncStatus.get().online) {
          finishSync();
        } else {
          syncStatus.update((status) => ({
            ...status,
            phase: "error",
            last_error: { code: "offline", message: "Der Server ist nicht erreichbar.", at: stamp() },
          }));
        }
      },
      async dismissProblem(id) {
        problems.update((list) => list.filter((problem) => problem.id !== id));
      },
    },

    data: {
      products: derived(
        state,
        (data) => [data.products],
        (data) => data.products.filter((product) => product.deleted_at === null),
      ),
      packages: derived(
        state,
        (data) => [data.packages],
        (data) => data.packages.filter((pkg) => pkg.removed_at === null),
      ),
      removedPackages: derived(
        state,
        (data) => [data.packages, data.settings.trash_retention_days],
        (data) => {
          const limit = new Date(clock().getTime() - data.settings.trash_retention_days * 86_400_000).toISOString();
          return data.packages
            .filter((pkg) => pkg.removed_at !== null && pkg.removed_at >= limit)
            .sort((a, b) => (b.removed_at ?? "").localeCompare(a.removed_at ?? ""));
        },
      ),
      zones: derived(
        state,
        (data) => [data.zones],
        (data) => sortZones(data.zones.filter((zone) => zone.deleted_at === null)),
      ),
      settings: derived(
        state,
        (data) => [data.settings],
        (data) => data.settings,
      ),
      printers: derived(
        state,
        (data) => [data.printers],
        (data) => data.printers.filter((printer) => printer.deleted_at === null).sort((a, b) => a.name.localeCompare(b.name, "de")),
      ),
      printerStatus: derived(
        state,
        (data) => [data.printerStatus],
        (data) => data.printerStatus,
      ),
      printJobs: derived(
        state,
        (data) => [data.printJobs],
        (data) => [...data.printJobs].sort((a, b) => b.created_at.localeCompare(a.created_at)),
      ),
      async findPackage(id) {
        return state.get().packages.find((pkg) => pkg.id === id);
      },
      async findProduct(id) {
        try {
          return activeProduct(id);
        } catch {
          return undefined;
        }
      },
      async findProductByBarcode(barcode) {
        return barcodeOwner(barcode);
      },
      imageUrl(image) {
        // Die Bilder der Attrappe liegen in der App selbst; alles andere zeigt wie im Kern auf den Server.
        return MOCK_IMAGES[image] ?? `/api/images/${encodeURIComponent(image)}`;
      },
    },

    stock: {
      async store(input: StoreInput): Promise<StoreResult> {
        checkStoreCount(input.count);
        checkBestBefore(input.best_before);
        const zone = activeZone(input.zone_id);
        const { product, created } = resolveProduct(input.product);
        const now = stamp();
        const packages: Package[] = [];
        for (let i = 0; i < input.count; i += 1) {
          let id = newPackageId();
          while (packages.some((pkg) => pkg.id === id)) {
            id = newPackageId();
          }
          packages.push({
            id,
            product_id: product.id,
            zone_id: zone.id,
            best_before: input.best_before,
            created_at: now,
            updated_at: now,
            removed_at: null,
            removal_reason: null,
            displaced: null,
          });
        }
        // Etiketten gibt es nur, wenn der Haushalt einen Drucker hat.
        const labels = (input.labels ?? prefs.get().print_labels) && hasPrinter();
        const jobs = labels ? packages.map((pkg) => buildJob({ package_id: pkg.id }, null)) : [];
        mutate(
          (data) => ({
            ...data,
            products: created ? [...data.products, product] : data.products,
            packages: [...data.packages, ...packages],
            printJobs: [...data.printJobs, ...jobs],
          }),
          (created ? 1 : 0) + packages.length + jobs.length,
        );
        const firstBarcode = product.barcodes[0];
        if (created && product.lookup === "pending" && firstBarcode) {
          simulateLookup(product.id, firstBarcode);
        }
        if (jobs.length > 0) {
          deliverSoon();
        }
        return { product, packages, print_jobs: jobs };
      },

      async remove(packageIds: string[], reason: RemovalReason) {
        existingPackages(packageIds);
        const now = stamp();
        mutate(
          (data) => ({
            ...data,
            packages: data.packages.map((pkg) =>
              packageIds.includes(pkg.id)
                ? { ...pkg, removed_at: pkg.removed_at ?? now, removal_reason: reason, updated_at: now }
                : pkg,
            ),
            // Ein Etikett, das noch aussteht, braucht eine entnommene Packung nicht mehr.
            printJobs: data.printJobs.map((job) =>
              job.state === "pending" && job.package_id !== null && packageIds.includes(job.package_id)
                ? { ...job, state: "cancelled", updated_at: now }
                : job,
            ),
          }),
          packageIds.length,
        );
      },

      async restore(packageIds: string[], restoreOptions) {
        existingPackages(packageIds);
        const now = stamp();
        mutate(
          (data) => ({
            ...data,
            packages: data.packages.map((pkg) => {
              if (!packageIds.includes(pkg.id) || pkg.removed_at === null) {
                return pkg;
              }
              const restored: Package = { ...pkg, removed_at: null, removal_reason: null, displaced: null, updated_at: now };
              if (restoreOptions?.apply_displaced && pkg.displaced) {
                for (const change of pkg.displaced.changes) {
                  if (change.field === "best_before") {
                    restored.best_before = change.value;
                  } else if (change.value !== null) {
                    restored[change.field] = change.value;
                  }
                }
              }
              return restored;
            }),
          }),
          packageIds.length,
        );
      },

      async update(packageIds: string[], changes: PackageChanges) {
        const targets = existingPackages(packageIds);
        if ("best_before" in changes) {
          checkBestBefore(changes.best_before ?? null);
        }
        const zoneId = changes.zone_id === undefined ? undefined : activeZone(changes.zone_id).id;
        const productId = changes.product_id === undefined ? undefined : activeProduct(changes.product_id).id;
        const fresh: DisplacedChange[] = [];
        if ("best_before" in changes) {
          fresh.push({ field: "best_before", value: changes.best_before ?? null });
        }
        if (zoneId !== undefined) {
          fresh.push({ field: "zone_id", value: zoneId });
        }
        if (productId !== undefined) {
          fresh.push({ field: "product_id", value: productId });
        }
        if (fresh.length === 0) {
          return; // ohne Felder: ohne Wirkung
        }
        const now = stamp();
        mutate(
          (data) => ({
            ...data,
            packages: data.packages.map((pkg) => {
              if (!packageIds.includes(pkg.id)) {
                return pkg;
              }
              if (pkg.removed_at !== null) {
                // Löschen gewinnt: Die Bearbeitung wird aufgehoben, nicht angewendet.
                return displace(pkg, fresh, now);
              }
              return {
                ...pkg,
                best_before: "best_before" in changes ? (changes.best_before ?? null) : pkg.best_before,
                zone_id: zoneId ?? pkg.zone_id,
                product_id: productId ?? pkg.product_id,
                updated_at: now,
              };
            }),
          }),
          packageIds.length,
        );
        // Der echte Kern erfährt es erst beim Abgleich; die Attrappe trägt das Sync-Problem sofort ein.
        const displaced: SyncProblem[] = targets
          .filter((pkg) => pkg.removed_at !== null)
          .map((pkg) => ({
            id: newUuid(),
            at: now,
            status: "displaced",
            code: null,
            message: null,
            command: { id: newUuid(), at: now, type: "package.update", package_id: pkg.id, changes },
          }));
        if (displaced.length > 0) {
          problems.update((list) => [...displaced, ...list]);
        }
      },
    },

    products: {
      async create(input: NewProduct) {
        const { product } = resolveProduct({ kind: "new", ...input });
        mutate((data) => ({ ...data, products: [...data.products, product] }));
        return product;
      },
      async update(id: string, changes: ProductChanges) {
        const product = activeProduct(id);
        const name = changes.name === undefined ? undefined : requiredText(changes.name, LIMITS.product_name, "Das Produkt");
        const brand = changes.brand === undefined ? undefined : optionalText(changes.brand, LIMITS.brand, "Die Marke");
        const quantity = changes.quantity === undefined ? undefined : optionalText(changes.quantity, LIMITS.quantity, "Die Packungsgröße");
        checkWarnDays(changes.warn_days);
        mutate((data) => ({
          ...data,
          products: data.products.map((candidate) =>
            candidate.id === product.id
              ? {
                  ...candidate,
                  name: name ?? candidate.name,
                  brand: brand ?? candidate.brand,
                  quantity: quantity ?? candidate.quantity,
                  warn_days: "warn_days" in changes ? (changes.warn_days ?? null) : candidate.warn_days,
                  updated_at: stamp(),
                }
              : candidate,
          ),
        }));
      },
      async addBarcode(id: string, barcode: string) {
        const product = activeProduct(id);
        checkBarcode(barcode);
        const owner = barcodeOwner(barcode);
        if (owner && owner.id !== product.id) {
          throw new CoreError("barcode_taken", "Der Barcode gehört schon zu einem anderen Produkt.", { product_id: owner.id });
        }
        if (owner) {
          return;
        }
        checkBarcodeCount(product.barcodes.length + 1);
        mutate((data) => ({
          ...data,
          products: data.products.map((candidate) =>
            candidate.id === product.id
              ? { ...candidate, barcodes: [...candidate.barcodes, barcode].sort(), updated_at: stamp() }
              : candidate,
          ),
        }));
      },
      async removeBarcode(id: string, barcode: string) {
        const product = activeProduct(id);
        mutate((data) => ({
          ...data,
          products: data.products.map((candidate) =>
            candidate.id === product.id
              ? { ...candidate, barcodes: candidate.barcodes.filter((code) => code !== barcode), updated_at: stamp() }
              : candidate,
          ),
        }));
      },
      async merge(sourceId: string, targetId: string) {
        const source = activeProduct(sourceId);
        const target = activeProduct(targetId);
        if (source.id === target.id) {
          return;
        }
        const now = stamp();
        mutate((data) => ({
          ...data,
          products: data.products.map((candidate) => {
            if (candidate.id === source.id) {
              return { ...candidate, barcodes: [], deleted_at: now, merged_into: target.id, updated_at: now };
            }
            if (candidate.id === target.id) {
              return { ...candidate, barcodes: [...new Set([...candidate.barcodes, ...source.barcodes])].sort(), updated_at: now };
            }
            return candidate;
          }),
          packages: data.packages.map((pkg) => (pkg.product_id === source.id ? { ...pkg, product_id: target.id, updated_at: now } : pkg)),
        }));
      },
    },

    zones: {
      async create(input: NewZone) {
        const name = requiredText(input.name, LIMITS.zone_name, "Die Zone");
        const icon = input.icon ?? "box";
        const color = input.color ?? null;
        checkZoneIcon(icon);
        checkZoneColor(color);
        if (input.printer_id) {
          activePrinter(input.printer_id);
        }
        const now = stamp();
        const zones = state.get().zones.filter((zone) => zone.deleted_at === null);
        const zone: Zone = {
          id: newUuid(),
          name,
          icon,
          color,
          sort: zones.reduce((highest, candidate) => Math.max(highest, candidate.sort), -1) + 1,
          printer_id: input.printer_id ?? null,
          created_at: now,
          updated_at: now,
          deleted_at: null,
          moved_to: null,
        };
        mutate((data) => ({ ...data, zones: [...data.zones, zone] }));
        return zone;
      },
      async update(id: string, changes: ZoneChanges) {
        const zone = activeZone(id);
        const name = changes.name === undefined ? undefined : requiredText(changes.name, LIMITS.zone_name, "Die Zone");
        if (changes.icon !== undefined) {
          checkZoneIcon(changes.icon);
        }
        if ("color" in changes) {
          checkZoneColor(changes.color ?? null);
        }
        if (changes.printer_id) {
          activePrinter(changes.printer_id);
        }
        mutate((data) => ({
          ...data,
          zones: data.zones.map((candidate) =>
            candidate.id === zone.id
              ? {
                  ...candidate,
                  name: name ?? candidate.name,
                  icon: changes.icon ?? candidate.icon,
                  color: "color" in changes ? (changes.color ?? null) : candidate.color,
                  sort: changes.sort ?? candidate.sort,
                  printer_id: "printer_id" in changes ? (changes.printer_id ?? null) : candidate.printer_id,
                  updated_at: stamp(),
                }
              : candidate,
          ),
        }));
      },
      async reorder(ids: string[]) {
        ids.forEach((id) => activeZone(id));
        mutate(
          (data) => ({
            ...data,
            zones: data.zones.map((zone) => {
              const position = ids.indexOf(zone.id);
              return position === -1 || position === zone.sort ? zone : { ...zone, sort: position, updated_at: stamp() };
            }),
          }),
          ids.length,
        );
      },
      async remove(id: string, moveTo: string) {
        const zone = activeZone(id);
        if (state.get().zones.filter((candidate) => candidate.deleted_at === null).length <= 1) {
          throw new CoreError("last_zone", "Die letzte Zone lässt sich nicht löschen.");
        }
        if (id === moveTo) {
          throw new CoreError("invalid", "Die Packungen müssen in eine andere Zone wandern.");
        }
        const target = activeZone(moveTo);
        const now = stamp();
        mutate((data) => ({
          ...data,
          zones: data.zones.map((candidate) =>
            candidate.id === zone.id ? { ...candidate, deleted_at: now, moved_to: target.id, updated_at: now } : candidate,
          ),
          packages: data.packages.map((pkg) => (pkg.zone_id === zone.id ? { ...pkg, zone_id: target.id, updated_at: now } : pkg)),
          settings:
            data.settings.primary_zone_id === zone.id
              ? { ...data.settings, primary_zone_id: target.id, updated_at: now }
              : data.settings,
        }));
        if (prefs.get().scan_zone_id === zone.id) {
          prefs.update((value) => ({ ...value, scan_zone_id: null }));
        }
      },
    },

    settings: {
      async update(changes: SettingsChanges) {
        if (changes.primary_zone_id) {
          activeZone(changes.primary_zone_id);
        }
        if (changes.default_printer_id) {
          activePrinter(changes.default_printer_id);
        }
        if (changes.warn_days !== undefined) {
          if (changes.warn_days === null) {
            throw new CoreError("invalid", "Die Vorlaufzeit des Haushalts darf nicht leer sein.");
          }
          checkWarnDays(changes.warn_days);
        }
        if (changes.trash_retention_days !== undefined) {
          checkRetentionDays(changes.trash_retention_days);
        }
        mutate((data) => ({ ...data, settings: { ...data.settings, ...changes, updated_at: stamp() } }));
      },
    },

    prefs: {
      value: prefs,
      async update(changes: Partial<DevicePrefs>) {
        prefs.update((value) => ({ ...value, ...changes }));
      },
    },

    printers: {
      async create(input: NewPrinter) {
        const name = requiredText(input.name, LIMITS.printer_name, "Der Drucker");
        if (input.connection === "server") {
          checkServerConfig(input.server);
        } else if (input.connection === "direct") {
          checkDirectConfig(input.direct);
        } else {
          throw new CoreError("invalid", "Unbekannte Art der Verbindung.");
        }
        const now = stamp();
        const printer: Printer = {
          id: newUuid(),
          name,
          connection: input.connection,
          server: input.connection === "server" ? input.server : null,
          direct: input.connection === "direct" ? input.direct : null,
          created_at: now,
          updated_at: now,
          deleted_at: null,
        };
        mutate((data) => ({ ...data, printers: [...data.printers, printer] }));
        return printer;
      },
      async update(id: string, changes: PrinterChanges) {
        const printer = activePrinter(id);
        const name = changes.name === undefined ? undefined : requiredText(changes.name, LIMITS.printer_name, "Der Drucker");
        if ((changes.server !== undefined && printer.connection !== "server") || (changes.direct !== undefined && printer.connection !== "direct")) {
          throw new CoreError("invalid", "Die Art der Verbindung lässt sich nicht ändern.");
        }
        if (changes.server !== undefined) {
          checkServerConfig(changes.server);
        }
        if (changes.direct !== undefined) {
          checkDirectConfig(changes.direct);
        }
        mutate((data) => ({
          ...data,
          printers: data.printers.map((candidate) =>
            candidate.id === printer.id
              ? {
                  ...candidate,
                  name: name ?? candidate.name,
                  server: changes.server ?? candidate.server,
                  direct: changes.direct ?? candidate.direct,
                  updated_at: stamp(),
                }
              : candidate,
          ),
        }));
      },
      async remove(id: string) {
        const printer = activePrinter(id);
        const now = stamp();
        mutate((data) => ({
          ...data,
          printers: data.printers.map((candidate) => (candidate.id === printer.id ? { ...candidate, deleted_at: now, updated_at: now } : candidate)),
          zones: data.zones.map((zone) => (zone.printer_id === printer.id ? { ...zone, printer_id: null, updated_at: now } : zone)),
          settings:
            data.settings.default_printer_id === printer.id
              ? { ...data.settings, default_printer_id: null, updated_at: now }
              : data.settings,
        }));
      },
      async probe(id: string): Promise<PrinterProbe> {
        const printer = activePrinter(id);
        await wait();
        if (!reachable(printer)) {
          const { problem, message } = problemOf(printer);
          // Wie im Kern: „unknown_printer" heißt, der Dienst antwortet, kennt den Drucker aber nicht.
          return { reachable: problem === "unknown_printer", url: null, health: null, problem, error: message };
        }
        const status = printerStatusFor(printer);
        rememberStatus(status);
        const health = sampleHealth(printer, status);
        // Ein direkter Drucker bringt seinen Zustand mit dem nächsten Abgleich zum Server (`printer.report`).
        if (printer.connection === "direct") {
          changed();
        }
        deliverSoon();
        return { reachable: true, url: printer.direct?.urls[0] ?? null, health, problem: null, error: null };
      },
    },

    print: {
      async requestPackageLabels(packageIds: string[], requestOptions) {
        existingPackages(packageIds);
        requirePrinter();
        const printerId = requestOptions?.printer_id ? activePrinter(requestOptions.printer_id).id : null;
        const jobs = [...new Set(packageIds)].map((id) => buildJob({ package_id: id }, printerId));
        mutate((data) => ({ ...data, printJobs: [...data.printJobs, ...jobs] }), jobs.length);
        deliverSoon();
        return jobs;
      },
      async requestZoneLabel(zoneId: string, requestOptions) {
        const zone = activeZone(zoneId);
        requirePrinter();
        const printerId = requestOptions?.printer_id ? activePrinter(requestOptions.printer_id).id : null;
        const job = buildJob({ zone_id: zone.id }, printerId);
        mutate((data) => ({ ...data, printJobs: [...data.printJobs, job] }));
        deliverSoon();
        return job;
      },
      async retry(jobId: string) {
        const old = findJob(jobId);
        // Ein ausstehendes Etikett eines anderen Geräts übernehmen: das alte verwerfen, ein eigenes anlegen.
        const takeOver = old.state === "pending" && old.device_id !== ownDeviceId();
        if (!takeOver && !["failed", "unknown", "cancelled"].includes(old.state)) {
          throw new CoreError("invalid", "Nur fehlgeschlagene, unklare oder verworfene Etiketten lassen sich wiederholen.");
        }
        // Ein inzwischen gelöschter Drucker gilt als nicht gewählt.
        const stillThere = state.get().printers.some((printer) => printer.id === old.printer_id && printer.deleted_at === null);
        const job = buildJob(old.package_id ? { package_id: old.package_id } : { zone_id: old.zone_id ?? "" }, stillThere ? old.printer_id : null);
        if (takeOver) {
          setJobState(old.id, "cancelled");
        }
        mutate((data) => ({ ...data, printJobs: [...data.printJobs, job] }), takeOver ? 2 : 1);
        deliverSoon();
        return job;
      },
      async cancel(jobId: string) {
        const job = findJob(jobId);
        if (job.state !== "pending" && job.state !== "queued") {
          throw new CoreError("invalid", "Das Etikett ist nicht mehr ausstehend.");
        }
        setJobState(jobId, "cancelled");
        changed();
      },
      async resolveUnknown(jobId: string, printed: boolean) {
        const job = findJob(jobId);
        if (job.state !== "unknown") {
          throw new CoreError("invalid", "Bei diesem Etikett ist nichts offen.");
        }
        setJobState(jobId, printed ? "printed" : "failed", printed ? null : "not_printed");
        changed();
      },
      async flush() {
        const report = deliver();
        // Wie im Kern: erfüllt sich, sobald eingereicht ist; den Endzustand bringt das Nachfragen
        // danach (hier: `deliver` setzt ihn nach der doppelten Wartezeit), über `data.printJobs`.
        await wait();
        return report;
      },
      async preview(subject, previewOptions) {
        if (subject.kind === "package") {
          existingPackages([subject.package_id]);
        } else {
          activeZone(subject.zone_id);
        }
        if (previewOptions?.printer_id) {
          activePrinter(previewOptions.printer_id);
        }
        await wait();
        requireOnline();
        return previewImage();
      },
      async image(jobId: string) {
        const job = findJob(jobId);
        const printer = state.get().printers.find((candidate) => candidate.id === job.printer_id);
        if (printer?.server?.driver !== "image" || !["printed", "sent"].includes(job.state)) {
          throw new CoreError("not_found", "Zu diesem Etikett gibt es kein Bild.");
        }
        await wait();
        requireOnline();
        return previewImage();
      },
      async handoff(printerId: string) {
        const printer = activePrinter(printerId);
        if (printer.connection !== "direct" || !printer.direct) {
          throw new CoreError("invalid", "Die Seite des Druckdienstes gibt es nur bei einem direkten Drucker.");
        }
        const waiting = ownPending().filter((job) => printerFor(job)?.id === printer.id);
        // Eine Übergabe trägt eine Vorlage: nur Etiketten der Art des ältesten.
        const jobs = waiting.filter((job) => job.kind === waiting[0]?.kind).slice(0, MAX_HANDOFF_JOBS);
        if (jobs.length === 0) {
          throw new CoreError("not_found", "Für diesen Drucker steht kein eigenes Etikett aus.");
        }
        for (const job of jobs) {
          setJobState(job.id, "unknown", "handoff", { printer_id: printer.id });
        }
        changed(jobs.length);
        const base = printer.direct.urls.find((url) => url.startsWith("http://")) ?? printer.direct.urls[0] ?? "";
        const handed = state.get().printJobs.filter((job) => jobs.some((candidate) => candidate.id === job.id));
        // Die Attrappe hat keinen Druckdienst: Die Adresse zeigt nur, wie sie aussähe.
        return { url: `${base.replace(/\/+$/, "")}/p#attrappe-${jobs.length}`, jobs: handed };
      },
    },

    devices: {
      async list() {
        await wait(0.5);
        requireOnline();
        return state.get().devices;
      },
      async rename(id: string, name: string) {
        const wanted = checkDeviceName(name);
        await wait(0.5);
        requireOnline();
        let renamed: Device | undefined;
        state.update((data) => ({
          ...data,
          devices: data.devices.map((device) => {
            if (device.id !== id) {
              return device;
            }
            renamed = { ...device, name: wanted };
            return renamed;
          }),
        }));
        if (!renamed) {
          throw new CoreError("not_found", "Das Gerät gibt es nicht.");
        }
        const current = session.get();
        if (renamed.current && current.status === "signed_in") {
          session.set({ status: "signed_in", device: { ...current.device, name: renamed.name } });
        }
        return renamed;
      },
      async revoke(id: string) {
        await wait(0.5);
        requireOnline();
        const device = state.get().devices.find((candidate) => candidate.id === id);
        if (!device) {
          throw new CoreError("not_found", "Das Gerät gibt es nicht.");
        }
        state.update((data) => ({
          ...data,
          devices: data.devices.map((candidate) => (candidate.id === id ? { ...candidate, revoked_at: candidate.revoked_at ?? stamp() } : candidate)),
        }));
        if (device.current) {
          session.set({ status: "signed_out", reason: "revoked", last_device_name: device.name });
        }
      },
    },

    backup: {
      async download() {
        await wait();
        requireOnline();
        return {
          blob: new Blob(["Attrappe: Hier käme die Kopie der Datenbank.\n"], { type: "application/vnd.sqlite3" }),
          filename: `stowly-${today()}.sqlite3`,
        };
      },
    },

    app: {
      state: app,
      async applyUpdate() {
        // Der echte Kern lädt die App neu; die Attrappe räumt nur die Anzeige ab.
        app.update((value) => ({ ...value, update_ready: false, update_required: false }));
      },
      async promptInstall() {
        if (!app.get().can_install) {
          return false;
        }
        app.update((value) => ({ ...value, can_install: false, installed: true }));
        return true;
      },
      async requestPersistence() {
        app.update((value) => ({ ...value, storage_persistent: true }));
        return true;
      },
    },

    control: {
      setOnline(online: boolean) {
        syncStatus.update((status) => ({
          ...status,
          online,
          phase: online ? "idle" : "error",
          last_error: online ? null : { code: "offline", message: "Der Server ist nicht erreichbar.", at: stamp() },
        }));
        if (online && syncStatus.get().pending > 0) {
          syncScheduled = false;
          changed(0);
        }
        if (online) {
          deliverSoon();
        }
      },
      revoke() {
        session.set({ status: "signed_out", reason: "revoked", last_device_name: currentName() });
      },
      setUpdateReady(ready: boolean) {
        app.update((value) => ({ ...value, update_ready: ready }));
      },
      addProblem(problem: SyncProblem) {
        problems.update((list) => [problem, ...list]);
      },
      setPiReachable(next: boolean) {
        piReachable = next;
        if (next) {
          deliverSoon();
        }
      },
      setPiProblem(problem: PrinterProblem | null) {
        piProblem = problem;
        if (problem === null && piReachable) {
          deliverSoon();
        }
      },
      setPrintOutcome(outcome: MockPrintOutcome) {
        printOutcome = outcome;
      },
      setLookupEnabled(enabled: boolean) {
        syncStatus.update((status) => ({ ...status, lookup_enabled: enabled }));
      },
      snapshot() {
        return state.get();
      },
    },
  };

  return core;
}

function sampleHealth(printer: Printer, status: PrinterStatus): ServiceHealth {
  const direct = printer.connection === "direct";
  return {
    app: "stowly-print",
    version: "0.1.0",
    protocol: 1,
    boot_id: status.boot_id ?? "",
    uptime_s: 4321,
    proof: null,
    host: status.host,
    printers: [
      {
        // Am Server heißt ein Drucker im Druckdienst wie seine Kennung, am Pi trägt er einen eigenen Namen.
        name: direct ? (printer.direct?.printer ?? "ql800") : printer.id,
        driver: direct ? "brother_ql" : (printer.server?.driver ?? "image"),
        model: direct ? "QL-800" : (printer.server?.model ?? null),
        capabilities: {
          dpi: 300,
          media: { width_mm: 62, length_mm: null, printable_px: 696 },
          cutter: true,
          colors: ["black"],
          status_query: direct,
          confirms_print: direct,
        },
        status: status.status ?? { reachable: true, ready: true, media_detected: null, errors: [] },
      },
    ],
  };
}

function sampleProblems(data: MockData, at: string): SyncProblem[] {
  const active = data.packages.filter((pkg) => pkg.removed_at === null);
  // Die entnommene Packung, die wirklich eine verdrängte Bearbeitung trägt.
  const removed = data.packages.find((pkg) => pkg.removed_at !== null && pkg.displaced !== null);
  const first = active[0];
  const result: SyncProblem[] = [];
  if (first) {
    result.push({
      id: newUuid(),
      at,
      status: "rejected",
      code: "id_conflict",
      message: "Die Packungs-ID ist schon vergeben.",
      command: {
        id: newUuid(),
        at,
        type: "package.create",
        package_id: first.id,
        product_id: first.product_id,
        zone_id: first.zone_id,
        best_before: addDays(toLocalDate(new Date(at)), 90),
      },
    });
  }
  if (removed) {
    result.push({
      id: newUuid(),
      at,
      status: "displaced",
      code: null,
      message: null,
      command: {
        id: newUuid(),
        at,
        type: "package.update",
        package_id: removed.id,
        changes: { best_before: addDays(toLocalDate(new Date(at)), 40) },
      },
    });
  }
  return result;
}
