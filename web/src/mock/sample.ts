/**
 * Beispieldaten der Attrappe: ein kleiner, erfundener Haushalt.
 *
 * Alle Datumsangaben hängen an „heute", damit es immer abgelaufene, bald ablaufende und
 * lange haltbare Packungen gibt. Namen und Marken sind ausgedacht.
 */
import {
  addDays,
  gtinCheckDigit,
  PACKAGE_ID_ALPHABET,
  PACKAGE_ID_LENGTH,
  toLocalDate,
  type Device,
  type HouseholdSettings,
  type Package,
  type Printer,
  type PrinterStatus,
  type PrintJob,
  type Product,
  type RemovalReason,
  type Zone,
} from "@/contract";

export interface MockData {
  products: Product[];
  /** Alle Packungen, auch entnommene. */
  packages: Package[];
  zones: Zone[];
  settings: HouseholdSettings;
  printers: Printer[];
  printerStatus: PrinterStatus[];
  printJobs: PrintJob[];
  devices: Device[];
}

const DAY_MS = 86_400_000;

/** Feste, gültige UUID für Beispieldaten: Gruppe 1-9, laufende Nummer. */
export function sampleUuid(group: number, n: number): string {
  return `${group}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** Feste, gültige Packungs-ID für Beispieldaten. */
export function samplePackageId(n: number): string {
  const space = PACKAGE_ID_ALPHABET.length ** PACKAGE_ID_LENGTH;
  let value = (n * 7_368_787 + 1_234_567) % space;
  let id = "";
  for (let i = 0; i < PACKAGE_ID_LENGTH; i += 1) {
    id = PACKAGE_ID_ALPHABET[value % PACKAGE_ID_ALPHABET.length] + id;
    value = Math.floor(value / PACKAGE_ID_ALPHABET.length);
  }
  return id;
}

/** Gültige EAN-13 für Beispieldaten. */
export function sampleBarcode(n: number, prefix = "4000001"): string {
  const body = prefix + String(n).padStart(5, "0");
  return body + String(gtinCheckDigit(body));
}

export const ZONE_IDS = {
  shelf: sampleUuid(1, 1),
  cellar: sampleUuid(1, 2),
  fridge: sampleUuid(1, 3),
  freezer: sampleUuid(1, 4),
} as const;

export const PRINTER_IDS = {
  kitchen: sampleUuid(3, 1),
  cellar: sampleUuid(3, 2),
} as const;

export const DEVICE_IDS = {
  current: sampleUuid(5, 1),
  phone: sampleUuid(5, 2),
  tablet: sampleUuid(5, 3),
} as const;

type ZoneKey = keyof typeof ZONE_IDS;

interface ProductSeed {
  name: string;
  brand?: string;
  quantity?: string;
  warn_days?: number;
  barcodes?: number;
  lookup?: Product["lookup"];
  /** [Zone, MHD in Tagen ab heute oder null, Anzahl, vor wie vielen Tagen eingelagert] */
  stock: [ZoneKey, number | null, number, number][];
}

const PRODUCTS: ProductSeed[] = [
  { name: "Basmati Reis", brand: "Kornhaus", quantity: "1 kg", stock: [["cellar", 132, 2, 20], ["cellar", 135, 1, 6], ["shelf", 400, 1, 2]] },
  { name: "Spaghetti", brand: "Pastaria", quantity: "500 g", stock: [["shelf", 300, 3, 14], ["cellar", 520, 2, 40]] },
  { name: "Passierte Tomaten", brand: "Sonnenhof", quantity: "500 g", stock: [["cellar", 9, 2, 200], ["cellar", 250, 4, 12]] },
  { name: "Kidneybohnen", brand: "Sonnenhof", quantity: "400 g", stock: [["cellar", 700, 3, 30]] },
  { name: "Haferflocken", brand: "Mühlenglück", quantity: "500 g", stock: [["shelf", -3, 1, 180], ["shelf", 45, 1, 25]] },
  { name: "Weizenmehl Type 405", brand: "Mühlenglück", quantity: "1 kg", stock: [["shelf", 12, 1, 90]] },
  { name: "Erbsen (TK)", brand: "Frostgarten", quantity: "750 g", stock: [["freezer", 200, 2, 15]] },
  { name: "Lachsfilet (TK)", brand: "Nordkap", quantity: "250 g", warn_days: 30, stock: [["freezer", 20, 2, 60], ["freezer", 90, 1, 9]] },
  { name: "Butter", brand: "Almhof", quantity: "250 g", warn_days: 5, stock: [["fridge", 4, 1, 12], ["fridge", 18, 1, 3]] },
  { name: "H-Milch 3,5 %", brand: "Almhof", quantity: "1 l", barcodes: 2, stock: [["shelf", 60, 6, 8]] },
  { name: "Apfelmus", brand: "Obstwiese", quantity: "700 g", stock: [["cellar", null, 2, 70]] },
  { name: "Rote Linsen", brand: "Kornhaus", quantity: "500 g", stock: [["shelf", 365, 2, 5]] },
  { name: "Thunfisch in Öl", brand: "Nordkap", quantity: "150 g", stock: [["cellar", 900, 4, 33]] },
  { name: "Olivenöl", quantity: "750 ml", barcodes: 0, lookup: "none", stock: [["shelf", 150, 1, 50]] },
  // Platzhalter: über einen unbekannten Barcode angelegt
  { name: "", lookup: "pending", stock: [["cellar", 30, 1, 0]] },
  { name: "", lookup: "not_found", stock: [["fridge", 2, 1, 1]] },
];

/** [Produkt, Zone, MHD in Tagen, vor wie vielen Tagen entnommen, Grund] */
const REMOVED: [number, ZoneKey, number | null, number, RemovalReason][] = [
  [12, "cellar", 900, 0.08, "mistake"],
  [0, "cellar", 132, 1, "consumed"],
  [1, "shelf", 300, 3, "consumed"],
  [8, "fridge", -6, 5, "discarded"],
  [2, "cellar", 9, 10, "consumed"],
  // außerhalb der Aufbewahrungsdauer von 30 Tagen: darf in der Lösch-Historie nicht erscheinen
  [3, "cellar", 700, 40, "consumed"],
];

export function createSampleData(now: Date = new Date()): MockData {
  const today = toLocalDate(now);
  const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY_MS).toISOString();
  const created = at(400);

  const zone = (id: string, name: string, icon: string, color: string | null, sort: number, printer_id: string | null): Zone => ({
    id,
    name,
    icon,
    color,
    sort,
    printer_id,
    created_at: created,
    updated_at: created,
    deleted_at: null,
    moved_to: null,
  });
  const zones: Zone[] = [
    zone(ZONE_IDS.shelf, "Vorratsregal", "shelf", null, 0, null),
    zone(ZONE_IDS.cellar, "Keller", "cellar", "blue", 1, PRINTER_IDS.cellar),
    zone(ZONE_IDS.fridge, "Kühlschrank", "fridge", "lime", 2, null),
    zone(ZONE_IDS.freezer, "Gefrierschrank", "freezer", "slate", 3, PRINTER_IDS.cellar),
  ];

  const products: Product[] = [];
  const packages: Package[] = [];
  let packageCounter = 0;
  let barcodeCounter = 0;

  PRODUCTS.forEach((seed, index) => {
    const productId = sampleUuid(2, index + 1);
    const barcodes: string[] = [];
    for (let i = 0; i < (seed.barcodes ?? 1); i += 1) {
      barcodeCounter += 1;
      barcodes.push(sampleBarcode(barcodeCounter));
    }
    products.push({
      id: productId,
      name: seed.name,
      brand: seed.brand ?? "",
      quantity: seed.quantity ?? "",
      image: null,
      warn_days: seed.warn_days ?? null,
      lookup: seed.lookup ?? "found",
      barcodes: barcodes.sort(),
      created_at: created,
      updated_at: created,
      deleted_at: null,
      merged_into: null,
    });
    for (const [zoneKey, offset, count, daysAgo] of seed.stock) {
      for (let i = 0; i < count; i += 1) {
        packageCounter += 1;
        packages.push({
          id: samplePackageId(packageCounter),
          product_id: productId,
          zone_id: ZONE_IDS[zoneKey],
          best_before: offset === null ? null : addDays(today, offset),
          created_at: at(daysAgo),
          updated_at: at(daysAgo),
          removed_at: null,
          removal_reason: null,
          displaced: null,
        });
      }
    }
  });

  REMOVED.forEach(([productIndex, zoneKey, offset, daysAgo, reason], index) => {
    packageCounter += 1;
    packages.push({
      id: samplePackageId(packageCounter),
      product_id: sampleUuid(2, productIndex + 1),
      zone_id: ZONE_IDS[zoneKey],
      best_before: offset === null ? null : addDays(today, offset),
      created_at: at(daysAgo + 30),
      updated_at: at(daysAgo),
      removed_at: at(daysAgo),
      removal_reason: reason,
      // Eine Bearbeitung von einem anderen Gerät traf diese Packung erst nach dem Entnehmen.
      displaced: index === 4 ? { at: at(daysAgo - 1), changes: [{ field: "best_before", value: addDays(today, 40) }] } : null,
    });
  });

  const printers: Printer[] = [
    {
      id: PRINTER_IDS.kitchen,
      name: "Küche (Bild)",
      connection: "server",
      server: { driver: "image", model: null, address: null, media: "62" },
      direct: null,
      created_at: created,
      updated_at: created,
      deleted_at: null,
    },
    {
      id: PRINTER_IDS.cellar,
      name: "Keller (Pi)",
      connection: "direct",
      server: null,
      direct: { urls: ["https://10.71.83.1:8443", "http://10.71.83.1:8080"], token: "attrappe", printer: null },
      created_at: created,
      updated_at: created,
      deleted_at: null,
    },
  ];

  const printerStatus: PrinterStatus[] = [
    {
      printer_id: PRINTER_IDS.kitchen,
      observed_at: at(0.001),
      boot_id: "server",
      status: { reachable: true, ready: true, media_detected: null, errors: [] },
      host: null,
    },
    {
      printer_id: PRINTER_IDS.cellar,
      observed_at: at(2.2),
      boot_id: "c0ffee00-0000-4000-8000-000000000001",
      status: { reachable: true, ready: true, media_detected: true, errors: [] },
      host: {
        uptime_s: 86_400 * 12.5,
        temperature_c: 51.3,
        throttled: false,
        undervoltage: null,
        storage_errors: 0,
        storage_read_only: false,
        overlay_used_pct: 7.5,
        memory_available_mb: 301,
      },
    },
  ];

  const cellarPackages = packages.filter((pkg) => pkg.zone_id === ZONE_IDS.cellar && pkg.removed_at === null);
  const job = (n: number, pkg: Package | undefined, state: PrintJob["state"], daysAgo: number, error: string | null = null): PrintJob => ({
    id: sampleUuid(4, n),
    kind: "package",
    package_id: pkg?.id ?? samplePackageId(1),
    zone_id: null,
    printer_id: PRINTER_IDS.cellar,
    state,
    error,
    boot_id: state === "pending" ? null : "c0ffee00-0000-4000-8000-000000000001",
    device_id: DEVICE_IDS.current,
    created_at: at(daysAgo),
    updated_at: at(daysAgo),
  });
  const printJobs: PrintJob[] = [
    job(1, cellarPackages.at(-1), "pending", 0.01),
    job(2, cellarPackages.at(-2), "pending", 0.01),
    job(3, cellarPackages[0], "unknown", 2.2),
    job(4, cellarPackages[1], "failed", 6, "no_media"),
    job(5, cellarPackages[2], "printed", 6),
  ];

  const devices: Device[] = [
    { id: DEVICE_IDS.current, name: "Dieses Gerät", created_at: at(120), last_seen_at: at(0), revoked_at: null, current: true },
    { id: DEVICE_IDS.phone, name: "Handy Küche", created_at: at(90), last_seen_at: at(0.3), revoked_at: null, current: false },
    { id: DEVICE_IDS.tablet, name: "Altes Tablet", created_at: at(300), last_seen_at: at(200), revoked_at: at(100), current: false },
  ];

  const settings: HouseholdSettings = {
    zone_mode: "primary",
    primary_zone_id: ZONE_IDS.shelf,
    warn_days: 14,
    trash_retention_days: 30,
    default_printer_id: PRINTER_IDS.kitchen,
    updated_at: created,
  };

  return { products, packages, zones, settings, printers, printerStatus, printJobs, devices };
}

/** Frisch eingerichteter Haushalt: eine Zone, sonst nichts. */
export function createEmptyData(now: Date = new Date()): MockData {
  const stamp = now.toISOString();
  return {
    products: [],
    packages: [],
    zones: [
      {
        id: ZONE_IDS.shelf,
        name: "Vorrat",
        icon: "shelf",
        color: null,
        sort: 0,
        printer_id: null,
        created_at: stamp,
        updated_at: stamp,
        deleted_at: null,
        moved_to: null,
      },
    ],
    settings: {
      zone_mode: "primary",
      primary_zone_id: ZONE_IDS.shelf,
      warn_days: 14,
      trash_retention_days: 30,
      default_printer_id: null,
      updated_at: stamp,
    },
    printers: [],
    printerStatus: [],
    printJobs: [],
    devices: [{ id: DEVICE_IDS.current, name: "Dieses Gerät", created_at: stamp, last_seen_at: stamp, revoked_at: null, current: true }],
  };
}

/** Der Beispiel-Haushalt mit nur einer Zone: Die Oberfläche blendet dann alles zu Zonen aus. */
export function createSingleZoneData(now: Date = new Date()): MockData {
  const data = createSampleData(now);
  return {
    ...data,
    zones: data.zones.filter((zone) => zone.id === ZONE_IDS.shelf).map((zone) => ({ ...zone, name: "Vorrat" })),
    packages: data.packages.map((pkg) => ({ ...pkg, zone_id: ZONE_IDS.shelf })),
    settings: { ...data.settings, primary_zone_id: ZONE_IDS.shelf },
  };
}
