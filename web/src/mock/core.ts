/**
 * Die Attrappe: ein vollständiger `Core` im Arbeitsspeicher, ohne Server und ohne IndexedDB.
 *
 * Sie verhält sich nach außen wie der echte Kern (src/contract/core.ts), vereinfacht aber
 * alles dahinter: Es gibt keine Outbox und keine Konflikte, der „Sync" ist eine Stoppuhr.
 * Nach dem Neuladen der Seite sind alle Änderungen weg.
 */
import {
  addDays,
  APP_VERSION,
  CoreError,
  DEFAULT_DEVICE_PREFS,
  isDate,
  isStoreInternalBarcode,
  isValidBarcode,
  MAX_STORE_COUNT,
  newUuid,
  randomPackageId,
  toLocalDate,
  type AppState,
  type Core,
  type Device,
  type DevicePrefs,
  type NewPrinter,
  type NewProduct,
  type NewZone,
  type Package,
  type PackageChanges,
  type Printer,
  type PrinterChanges,
  type PrinterProbe,
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

import { derived, LiveValue } from "./live";
import { PREVIEW_PNG_BASE64 } from "./preview";
import { createEmptyData, createSampleData, createSingleZoneData, DEVICE_IDS, type MockData } from "./sample";

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
 * - "insecure":    Aufruf über http://<LAN-IP>: kein Scannen, kein Offline-Betrieb
 */
export type MockScenario = "empty" | "single-zone" | "signed-out" | "revoked" | "offline" | "problems" | "update" | "insecure";

export const MOCK_SCENARIOS: readonly MockScenario[] = ["empty", "single-zone", "signed-out", "revoked", "offline", "problems", "update", "insecure"];

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
  /** Aktueller Datenbestand der Attrappe. */
  snapshot(): MockData;
}

export interface MockCore extends Core {
  readonly control: MockControl;
}

function sortZones(zones: Zone[]): Zone[] {
  return [...zones].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "de"));
}

function clean(text: string | undefined): string {
  return (text ?? "").trim();
}

export function createMockCore(options: MockOptions = {}): MockCore {
  const scenarios = new Set(options.scenarios ?? []);
  const clock = options.now ?? (() => new Date());
  const latency = options.latency ?? 600;
  const stamp = () => clock().toISOString();
  const today = () => toLocalDate(clock());

  const base = scenarios.has("empty")
    ? createEmptyData(clock())
    : scenarios.has("single-zone")
      ? createSingleZoneData(clock())
      : createSampleData(clock());
  const state = new LiveValue<MockData>({ ...base, ...options.data });

  const session = new LiveValue<SessionState>(
    scenarios.has("signed-out")
      ? { status: "signed_out", reason: "never" }
      : scenarios.has("revoked")
        ? { status: "signed_out", reason: "revoked" }
        : { status: "signed_in", device: { id: DEVICE_IDS.current, name: "Dieses Gerät" } },
  );

  const offline = scenarios.has("offline");
  const syncStatus = new LiveValue<SyncStatus>({
    online: !offline,
    phase: offline ? "error" : "idle",
    pending: scenarios.has("revoked") ? 3 : offline ? 4 : 0,
    last_synced_at: offline ? new Date(clock().getTime() - 3 * 3_600_000).toISOString() : stamp(),
    last_error: offline ? { code: "offline", message: "Der Server ist nicht erreichbar.", at: stamp() } : null,
    server_version: "0.1.0",
  });

  const problems = new LiveValue<SyncProblem[]>(scenarios.has("problems") ? sampleProblems(state.get(), stamp()) : []);
  const prefs = new LiveValue<DevicePrefs>({ ...DEFAULT_DEVICE_PREFS });
  const app = new LiveValue<AppState>({
    version: APP_VERSION,
    secure_context: !scenarios.has("insecure"),
    installed: false,
    can_install: false,
    update_ready: scenarios.has("update"),
    storage_persistent: null,
  });

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

  function checkBarcode(barcode: string): void {
    if (!isValidBarcode(barcode)) {
      throw new CoreError("invalid", `Kein gültiger Barcode: ${barcode}`);
    }
  }

  function checkWarnDays(value: number | null | undefined): void {
    if (value !== null && value !== undefined && (!Number.isInteger(value) || value < 0 || value > 3650)) {
      throw new CoreError("invalid", "Die Vorlaufzeit muss zwischen 0 und 3650 Tagen liegen.");
    }
  }

  function newPackageId(): string {
    for (;;) {
      const id = randomPackageId();
      if (!state.get().packages.some((pkg) => pkg.id === id)) {
        return id;
      }
    }
  }

  function buildProduct(input: NewProduct, lookup: Product["lookup"]): Product {
    const now = stamp();
    return {
      id: newUuid(),
      name: clean(input.name),
      brand: clean(input.brand),
      quantity: clean(input.quantity),
      image: null,
      warn_days: input.warn_days ?? null,
      lookup,
      barcodes: [...(input.barcodes ?? [])].sort(),
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
      const lookup = isStoreInternalBarcode(ref.barcode) ? "none" : "pending";
      return { product: buildProduct({ name: ref.name ?? "", barcodes: [ref.barcode] }, lookup), created: true };
    }
    if (clean(ref.name) === "") {
      throw new CoreError("invalid", "Das Produkt braucht einen Namen.");
    }
    checkWarnDays(ref.warn_days);
    for (const barcode of ref.barcodes ?? []) {
      checkBarcode(barcode);
      const owner = barcodeOwner(barcode);
      if (owner) {
        throw new CoreError("barcode_taken", "Der Barcode gehört schon zu einem anderen Produkt.", { product_id: owner.id });
      }
    }
    return { product: buildProduct(ref, "none"), created: true };
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

  function setJobState(id: string, next: PrintJob["state"], error: string | null = null): void {
    state.update((data) => ({
      ...data,
      printJobs: data.printJobs.map((job) => (job.id === id ? { ...job, state: next, error, updated_at: stamp() } : job)),
    }));
  }

  function findJob(id: string): PrintJob {
    const job = state.get().printJobs.find((candidate) => candidate.id === id);
    if (!job) {
      throw new CoreError("not_found", "Das Etikett gibt es nicht.");
    }
    return job;
  }

  /** Welcher Drucker ein Etikett druckt: der genannte, sonst der der Zone, sonst der Standarddrucker. */
  function printerFor(job: PrintJob): Printer | undefined {
    const data = state.get();
    const pkg = job.package_id ? data.packages.find((candidate) => candidate.id === job.package_id) : undefined;
    const zoneId = job.zone_id ?? pkg?.zone_id;
    const zone = data.zones.find((candidate) => candidate.id === zoneId);
    const printerId = job.printer_id ?? zone?.printer_id ?? data.settings.default_printer_id;
    return data.printers.find((printer) => printer.id === printerId && printer.deleted_at === null);
  }

  // ---------------------------------------------------------------- Die Schnittstelle

  const core: MockCore = {
    session: {
      state: session,
      async login(password, deviceName) {
        await wait();
        requireOnline();
        if (clean(deviceName) === "") {
          throw new CoreError("invalid", "Das Gerät braucht einen Namen.");
        }
        if (password !== MOCK_PASSWORD) {
          throw new CoreError("invalid_password", "Das Passwort stimmt nicht.");
        }
        const name = clean(deviceName);
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
        session.set({ status: "signed_out", reason: "logout" });
      },
    },

    sync: {
      status: syncStatus,
      problems,
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
        return `/api/images/${encodeURIComponent(image)}`;
      },
    },

    stock: {
      async store(input: StoreInput): Promise<StoreResult> {
        if (!Number.isInteger(input.count) || input.count < 1 || input.count > MAX_STORE_COUNT) {
          throw new CoreError("invalid", `Die Menge muss zwischen 1 und ${MAX_STORE_COUNT} liegen.`);
        }
        if (input.best_before !== null && !isDate(input.best_before)) {
          throw new CoreError("invalid", "Das MHD ist kein gültiges Datum.");
        }
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
        existingPackages(packageIds);
        if (changes.best_before !== undefined && changes.best_before !== null && !isDate(changes.best_before)) {
          throw new CoreError("invalid", "Das MHD ist kein gültiges Datum.");
        }
        const zoneId = changes.zone_id === undefined ? undefined : activeZone(changes.zone_id).id;
        const productId = changes.product_id === undefined ? undefined : activeProduct(changes.product_id).id;
        const now = stamp();
        mutate(
          (data) => ({
            ...data,
            packages: data.packages.map((pkg) =>
              packageIds.includes(pkg.id)
                ? {
                    ...pkg,
                    best_before: "best_before" in changes ? (changes.best_before ?? null) : pkg.best_before,
                    zone_id: zoneId ?? pkg.zone_id,
                    product_id: productId ?? pkg.product_id,
                    updated_at: now,
                  }
                : pkg,
            ),
          }),
          packageIds.length,
        );
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
        if (changes.name !== undefined && clean(changes.name) === "") {
          throw new CoreError("invalid", "Das Produkt braucht einen Namen.");
        }
        checkWarnDays(changes.warn_days);
        mutate((data) => ({
          ...data,
          products: data.products.map((candidate) =>
            candidate.id === product.id
              ? {
                  ...candidate,
                  name: changes.name === undefined ? candidate.name : clean(changes.name),
                  brand: changes.brand === undefined ? candidate.brand : clean(changes.brand),
                  quantity: changes.quantity === undefined ? candidate.quantity : clean(changes.quantity),
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
        if (clean(input.name) === "") {
          throw new CoreError("invalid", "Die Zone braucht einen Namen.");
        }
        const now = stamp();
        const zones = state.get().zones.filter((zone) => zone.deleted_at === null);
        const zone: Zone = {
          id: newUuid(),
          name: clean(input.name),
          icon: input.icon ?? "box",
          color: input.color ?? null,
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
        if (changes.name !== undefined && clean(changes.name) === "") {
          throw new CoreError("invalid", "Die Zone braucht einen Namen.");
        }
        mutate((data) => ({
          ...data,
          zones: data.zones.map((candidate) =>
            candidate.id === zone.id
              ? {
                  ...candidate,
                  name: changes.name === undefined ? candidate.name : clean(changes.name),
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
        checkWarnDays(changes.warn_days);
        const retention = changes.trash_retention_days;
        if (retention !== undefined && (!Number.isInteger(retention) || retention < 1 || retention > 3650)) {
          throw new CoreError("invalid", "Die Aufbewahrungsdauer muss zwischen 1 und 3650 Tagen liegen.");
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
        if (clean(input.name) === "") {
          throw new CoreError("invalid", "Der Drucker braucht einen Namen.");
        }
        const now = stamp();
        const printer: Printer = {
          id: newUuid(),
          name: clean(input.name),
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
        if (changes.name !== undefined && clean(changes.name) === "") {
          throw new CoreError("invalid", "Der Drucker braucht einen Namen.");
        }
        if ((changes.server && printer.connection !== "server") || (changes.direct && printer.connection !== "direct")) {
          throw new CoreError("invalid", "Die Art der Verbindung lässt sich nicht ändern.");
        }
        mutate((data) => ({
          ...data,
          printers: data.printers.map((candidate) =>
            candidate.id === printer.id
              ? {
                  ...candidate,
                  name: changes.name === undefined ? candidate.name : clean(changes.name),
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
        if (printer.connection === "server" && !syncStatus.get().online) {
          return { reachable: false, url: null, health: null, error: "Der Server ist nicht erreichbar." };
        }
        const health = sampleHealth(printer);
        const observed = stamp();
        state.update((data) => ({
          ...data,
          printerStatus: [
            ...data.printerStatus.filter((status) => status.printer_id !== printer.id),
            {
              printer_id: printer.id,
              observed_at: observed,
              boot_id: health.boot_id,
              status: health.printers?.[0]?.status ?? null,
              host: health.host,
            },
          ],
        }));
        return { reachable: true, url: printer.direct?.urls[0] ?? null, health, error: null };
      },
    },

    print: {
      async requestPackageLabels(packageIds: string[], requestOptions) {
        existingPackages(packageIds);
        requirePrinter();
        const jobs = packageIds.map((id) => buildJob({ package_id: id }, requestOptions?.printer_id ?? null));
        mutate((data) => ({ ...data, printJobs: [...data.printJobs, ...jobs] }), jobs.length);
        return jobs;
      },
      async requestZoneLabel(zoneId: string, requestOptions) {
        const zone = activeZone(zoneId);
        requirePrinter();
        const job = buildJob({ zone_id: zone.id }, requestOptions?.printer_id ?? null);
        mutate((data) => ({ ...data, printJobs: [...data.printJobs, job] }));
        return job;
      },
      async retry(jobId: string) {
        const old = findJob(jobId);
        if (!["failed", "unknown", "cancelled"].includes(old.state)) {
          throw new CoreError("invalid", "Nur fehlgeschlagene, unklare oder verworfene Etiketten lassen sich wiederholen.");
        }
        const job = buildJob(old.package_id ? { package_id: old.package_id } : { zone_id: old.zone_id ?? "" }, old.printer_id);
        mutate((data) => ({ ...data, printJobs: [...data.printJobs, job] }));
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
        const pending = state.get().printJobs.filter((job) => job.state === "pending" && printerFor(job));
        for (const job of pending) {
          setJobState(job.id, "printing");
        }
        await wait(2);
        for (const job of pending) {
          setJobState(job.id, "printed");
        }
        if (pending.length > 0) {
          changed(pending.length);
        }
      },
      async preview() {
        await wait();
        requireOnline();
        const bytes = Uint8Array.from(atob(PREVIEW_PNG_BASE64), (char) => char.charCodeAt(0));
        return new Blob([bytes], { type: "image/png" });
      },
    },

    devices: {
      async list() {
        await wait(0.5);
        requireOnline();
        return state.get().devices;
      },
      async rename(id: string, name: string) {
        await wait(0.5);
        requireOnline();
        if (clean(name) === "") {
          throw new CoreError("invalid", "Das Gerät braucht einen Namen.");
        }
        let renamed: Device | undefined;
        state.update((data) => ({
          ...data,
          devices: data.devices.map((device) => {
            if (device.id !== id) {
              return device;
            }
            renamed = { ...device, name: clean(name) };
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
          session.set({ status: "signed_out", reason: "revoked" });
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
        app.update((value) => ({ ...value, update_ready: false }));
      },
      async promptInstall() {
        return false;
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
      },
      revoke() {
        session.set({ status: "signed_out", reason: "revoked" });
      },
      setUpdateReady(ready: boolean) {
        app.update((value) => ({ ...value, update_ready: ready }));
      },
      addProblem(problem: SyncProblem) {
        problems.update((list) => [problem, ...list]);
      },
      snapshot() {
        return state.get();
      },
    },
  };

  return core;
}

function sampleHealth(printer: Printer): ServiceHealth {
  const direct = printer.connection === "direct";
  return {
    app: "stowly-print",
    version: "0.1.0",
    protocol: 1,
    boot_id: direct ? "c0ffee00-0000-4000-8000-000000000001" : "server",
    uptime_s: 4321,
    proof: null,
    host: direct
      ? {
          uptime_s: 4321,
          temperature_c: 49.8,
          throttled: false,
          undervoltage: null,
          storage_errors: 0,
          storage_read_only: false,
          overlay_used_pct: 8.1,
          memory_available_mb: 298,
        }
      : null,
    printers: [
      {
        name: direct ? "ql800" : "bild",
        driver: direct ? "brother_ql" : "image",
        model: direct ? "QL-800" : null,
        capabilities: {
          dpi: 300,
          media: { width_mm: 62, length_mm: null, printable_px: 696 },
          cutter: true,
          colors: ["black"],
          status_query: direct,
          confirms_print: direct,
        },
        status: { reachable: true, ready: true, media_detected: direct ? true : null, errors: [] },
      },
    ],
  };
}

function sampleProblems(data: MockData, at: string): SyncProblem[] {
  const active = data.packages.filter((pkg) => pkg.removed_at === null);
  const removed = data.packages.find((pkg) => pkg.removed_at !== null);
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
