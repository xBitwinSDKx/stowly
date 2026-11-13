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

import { SAMPLE_IMAGE_ID } from "./images";

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
  /** Das Produkt hat ein Vorschaubild (das Beispielbild der Attrappe). */
  image?: boolean;
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
  { name: "Apfelmus", brand: "Obstwiese", quantity: "700 g", image: true, stock: [["cellar", null, 2, 70]] },
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
      image: seed.image ? SAMPLE_IMAGE_ID : null,
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
  const shelfPackages = packages.filter((pkg) => pkg.zone_id === ZONE_IDS.shelf && pkg.removed_at === null);
  const job = (
    n: number,
    pkg: Package | undefined,
    state: PrintJob["state"],
    daysAgo: number,
    error: string | null = null,
    changes: Partial<PrintJob> = {},
  ): PrintJob => ({
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
    ...changes,
  });
  const printJobs: PrintJob[] = [
    job(1, cellarPackages.at(-1), "pending", 0.01),
    job(2, cellarPackages.at(-2), "pending", 0.01),
    job(3, cellarPackages[0], "unknown", 2.2, "interrupted"),
    job(4, cellarPackages[1], "failed", 6, "no_media"),
    job(5, cellarPackages[2], "printed", 6),
    // Von einem anderen Gerät angefordert: Dieses hier zeigt es nur an (und kann es übernehmen).
    job(6, cellarPackages[3], "pending", 0.6, null, { device_id: DEVICE_IDS.phone }),
    // Am Drucker mit Bild-Treiber gedruckt: Dazu gibt es ein Bild (`print.image`).
    job(7, shelfPackages[0], "printed", 1.5, null, { printer_id: PRINTER_IDS.kitchen, boot_id: "server" }),
    job(8, shelfPackages[1], "sent", 9, null, { printer_id: null, device_id: DEVICE_IDS.phone }),
    job(9, shelfPackages[2], "cancelled", 3, null, { printer_id: null, boot_id: null }),
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

/**
 * Zustand der beiden Beispiel-Drucker, wenn etwas nicht stimmt (Ausgangslage "printer-trouble"):
 * Der Drucker am Server ist aus; am Pi sind die Etiketten leer, er ist heiß und drosselt,
 * und die SD-Karte zeigt Fehler. Zuletzt gesehen wurde er vor neun Tagen.
 */
export function troubledPrinterStatus(now: Date = new Date()): PrinterStatus[] {
  const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY_MS).toISOString();
  return [
    {
      printer_id: PRINTER_IDS.kitchen,
      observed_at: at(0.02),
      boot_id: "server",
      status: { reachable: false, ready: null, media_detected: null, errors: ["offline"] },
      host: null,
    },
    {
      printer_id: PRINTER_IDS.cellar,
      observed_at: at(9),
      boot_id: "c0ffee00-0000-4000-8000-000000000001",
      status: { reachable: true, ready: false, media_detected: false, errors: ["no_media"] },
      host: {
        uptime_s: 86_400 * 41.2,
        temperature_c: 81.5,
        throttled: true,
        undervoltage: null,
        storage_errors: 3,
        storage_read_only: true,
        overlay_used_pct: 91.4,
        memory_available_mb: 38,
      },
    },
  ];
}

const LARGE_NAMES = [
  "Apfelmus", "Bohnen", "Brühe", "Couscous", "Erbsen", "Gurken", "Haferdrink", "Honig", "Kaffee", "Kichererbsen",
  "Kokosmilch", "Linsen", "Mais", "Marmelade", "Mehl", "Müsli", "Nudeln", "Öl", "Pesto", "Reis",
  "Sauerkraut", "Senf", "Tee", "Tomaten", "Zucker",
];
const LARGE_KINDS = ["fein", "grob", "mild", "würzig", "klein", "groß", "hell", "dunkel", "klassisch", "extra", "pur", "gemischt"];
const LARGE_BRANDS = ["Kornhaus", "Sonnenhof", "Mühlenglück", "Almhof", "Obstwiese", "Nordkap", "Frostgarten", ""];
const LARGE_SIZES = ["250 g", "400 g", "500 g", "750 g", "1 kg", "330 ml", "1 l", ""];

/**
 * Großer Bestand zum Prüfen der Geschwindigkeit: 300 weitere Produkte mit zusammen gut 2000 Packungen
 * in den vier Zonen der Beispieldaten, dazu deren Drucker, Etiketten und Geräte. Die Folge ist
 * fest (kein Zufall), damit zwei Läufe dasselbe zeigen.
 */
export function createLargeData(now: Date = new Date()): MockData {
  const sample = createSampleData(now);
  const today = toLocalDate(now);
  const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY_MS).toISOString();
  const zoneIds = [ZONE_IDS.shelf, ZONE_IDS.cellar, ZONE_IDS.cellar, ZONE_IDS.fridge, ZONE_IDS.freezer, ZONE_IDS.cellar];
  const products: Product[] = [];
  const packages: Package[] = [];
  let packageCounter = 10_000; // weit hinter den Kennungen der Beispieldaten
  let step = 7;
  const next = (modulo: number) => {
    step = (step * 1_103_515_245 + 12_345) % 2_147_483_648;
    // Die oberen Bits: Die unteren wiederholen sich bei dieser Folge nach wenigen Schritten.
    return Math.floor(step / 65_536) % modulo;
  };
  let index = 0;
  for (const name of LARGE_NAMES) {
    for (const kind of LARGE_KINDS) {
      index += 1;
      const productId = sampleUuid(6, index);
      products.push({
        id: productId,
        name: `${name} ${kind}`,
        brand: LARGE_BRANDS[next(LARGE_BRANDS.length)] ?? "",
        quantity: LARGE_SIZES[next(LARGE_SIZES.length)] ?? "",
        image: index % 9 === 0 ? SAMPLE_IMAGE_ID : null,
        warn_days: null,
        lookup: "found",
        barcodes: [sampleBarcode(index, "4000002")],
        created_at: at(400),
        updated_at: at(400),
        deleted_at: null,
        merged_into: null,
      });
      // Zwei bis drei Chargen je Produkt, zusammen im Mittel knapp sieben Packungen.
      const batches = 2 + next(2);
      for (let batch = 0; batch < batches; batch += 1) {
        const zoneId = zoneIds[next(zoneIds.length)] ?? ZONE_IDS.shelf;
        const offset = next(20) === 0 ? null : next(700) - 20;
        const daysAgo = next(300);
        const count = 1 + next(5);
        for (let i = 0; i < count; i += 1) {
          packageCounter += 1;
          packages.push({
            id: samplePackageId(packageCounter),
            product_id: productId,
            zone_id: zoneId,
            best_before: offset === null ? null : addDays(today, offset),
            created_at: at(daysAgo),
            updated_at: at(daysAgo),
            removed_at: null,
            removal_reason: null,
            displaced: null,
          });
        }
      }
    }
  }
  return { ...sample, products: [...sample.products, ...products], packages: [...sample.packages, ...packages] };
}
