/**
 * Der Bestand als Anzeige: reine Logik ohne React.
 *
 * Jede Packung ist ein eigener Datensatz (Plan, Entscheidung 1). Gruppierung nach Produkt,
 * Chargen nach MHD und Zone, Gesamtmenge, kritischstes MHD, Warnstufen, Suche, Filter und
 * der Füllstand der Zonen entstehen hier. Bestand, Warnungen und die Pille der Kopfzeile
 * benutzen dieselben Funktionen und zählen deshalb dasselbe.
 *
 * Seit Stufe 2 auch der Mindestbestand (`missingStock`) und die Charge, die als Nächstes dran
 * ist (FIFO, `compareFifo`). Beides rechnet die App selbst, sofort und auch offline.
 */
import {
  compareFifo,
  daysUntil,
  expiryState,
  missingStock,
  productSubtitle,
  productTitle,
  warnDaysFor,
  type ExpiryState,
  type HouseholdSettings,
  type Package,
  type Product,
  type Zone,
} from "@/contract";

// ------------------------------------------------------------------------------------
// Packungen mit allem, was die Anzeige über sie wissen muss
// ------------------------------------------------------------------------------------

/** Eine Packung des Bestands samt Produkt, Zone und Warnstufe. */
export interface StockEntry {
  pkg: Package;
  /** undefined, wenn der Verweis (noch) ins Leere zeigt. */
  product: Product | undefined;
  /** undefined, wenn der Verweis (noch) ins Leere zeigt. */
  zone: Zone | undefined;
  state: ExpiryState;
  /** Tage bis zum MHD: 0 = heute, negativ = abgelaufen, null = kein MHD. */
  days: number | null;
}

/**
 * Verbindet die Packungen mit ihren Produkten und Zonen und bestimmt die Warnstufen.
 * Verweise ins Leere sind erlaubt: Produkt oder Zone ist dann undefined.
 */
export function buildEntries(
  packages: readonly Package[],
  products: readonly Product[],
  zones: readonly Zone[],
  settings: Pick<HouseholdSettings, "warn_days">,
  today: string,
): StockEntry[] {
  const productById = new Map(products.map((product) => [product.id, product]));
  const zoneById = new Map(zones.map((zone) => [zone.id, zone]));
  return packages.map((pkg) => {
    const product = productById.get(pkg.product_id);
    return {
      pkg,
      product,
      zone: zoneById.get(pkg.zone_id),
      state: expiryState(pkg.best_before, warnDaysFor(product, settings), today),
      days: daysUntil(pkg.best_before, today),
    };
  });
}

/** Abgelaufen oder läuft bald ab: Das zählt als Warnung. */
export function isWarning(entry: Pick<StockEntry, "state">): boolean {
  return entry.state === "soon" || entry.state === "expired";
}

export interface WarningCount {
  /** Abgelaufene und bald ablaufende Packungen zusammen. */
  total: number;
  expired: number;
  soon: number;
}

/** Zählt die Packungen mit Warnung. Diese Zahl steht in der Kopfzeile, auf der Kennzahl-Karte und über der Warnliste. */
export function countWarnings(entries: readonly StockEntry[]): WarningCount {
  let expired = 0;
  let soon = 0;
  for (const entry of entries) {
    if (entry.state === "expired") {
      expired += 1;
    } else if (entry.state === "soon") {
      soon += 1;
    }
  }
  return { total: expired + soon, expired, soon };
}

// ------------------------------------------------------------------------------------
// Sortieren
// ------------------------------------------------------------------------------------

const collator = new Intl.Collator("de", { numeric: true, sensitivity: "base" });

/** MHD aufsteigend, Packungen ohne MHD zuletzt. */
function compareDates(a: string | null, b: string | null): number {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return a < b ? -1 : 1;
}

/** Stelle jeder Zone in der Reihenfolge der Zonen; Unbekanntes kommt ans Ende. */
function zoneOrder(zones: readonly Zone[]): (zoneId: string) => number {
  const order = new Map(zones.map((zone, index) => [zone.id, index]));
  return (zoneId) => order.get(zoneId) ?? Number.MAX_SAFE_INTEGER;
}

// ------------------------------------------------------------------------------------
// Bestand je Produkt: Menge und die Packung, die als Nächstes dran ist
// ------------------------------------------------------------------------------------

/** Was für jedes Produkt über den ganzen Bestand gilt, auch wenn ein Filter nur einen Teil zeigt. */
export interface StockIndex {
  /** Packungen je Produkt im Bestand, abgelaufene eingeschlossen; fehlt ein Produkt, ist es 0. */
  counts: ReadonlyMap<string, number>;
  /** Je Produkt die ID der Packung, die als Nächstes dran ist (FIFO wie `nextPackage`). */
  next: ReadonlyMap<string, string>;
}

/** Zählt den Bestand je Produkt und sucht je Produkt die nächste Packung, in einem Durchgang. */
export function indexStock(entries: readonly StockEntry[]): StockIndex {
  const counts = new Map<string, number>();
  const first = new Map<string, Package>();
  for (const { pkg } of entries) {
    counts.set(pkg.product_id, (counts.get(pkg.product_id) ?? 0) + 1);
    const best = first.get(pkg.product_id);
    if (best === undefined || compareFifo(pkg, best) < 0) {
      first.set(pkg.product_id, pkg);
    }
  }
  return { counts, next: new Map([...first].map(([productId, pkg]) => [productId, pkg.id])) };
}

// ------------------------------------------------------------------------------------
// Gruppieren: Produkt -> Chargen (MHD und Zone) -> Packungen
// ------------------------------------------------------------------------------------

/** Alle Packungen eines Produkts mit demselben MHD in derselben Zone. */
export interface Batch {
  /** Eindeutig innerhalb des Produkts. */
  key: string;
  best_before: string | null;
  zone_id: string;
  zone: Zone | undefined;
  /** Die Packungen, nach ID sortiert. */
  entries: StockEntry[];
  ids: string[];
  count: number;
  state: ExpiryState;
  days: number | null;
  /** Hier liegt die Packung, die als Nächstes dran ist (FIFO über den ganzen Bestand des Produkts). */
  next: boolean;
}

/** Eine Zeile der Bestandsliste: ein Produkt mit allem, was davon da ist. */
export interface ProductGroup {
  product_id: string;
  /** undefined, wenn das Produkt (noch) nicht geladen ist. */
  product: Product | undefined;
  /** Anzeigename; bei Platzhaltern der Barcode. */
  title: string;
  /** Marke und Packungsgröße. */
  subtitle: string;
  entries: StockEntry[];
  /** Gesamtmenge. */
  count: number;
  /** Chargen: MHD aufsteigend (ohne MHD zuletzt), dann in der Reihenfolge der Zonen. */
  batches: Batch[];
  /** Zonen, in denen das Produkt liegt, in der Reihenfolge der Zonen. */
  zone_ids: string[];
  /** Das früheste MHD aller Packungen oder null, wenn keine eines hat. */
  critical: string | null;
  /** Warnstufe des kritischsten MHD. */
  state: ExpiryState;
  /** Tage bis zum kritischsten MHD. */
  days: number | null;
  /** Packungen, die abgelaufen sind oder bald ablaufen. */
  warn_count: number;
  expired_count: number;
  /**
   * Packungen des Produkts im ganzen Bestand, auch wenn ein Filter nur einen Teil zeigt;
   * abgelaufene zählen mit. Danach richtet sich der Mindestbestand.
   */
  stock: number;
  /** Wie viele Packungen zum Mindestbestand fehlen (`missingStock`); 0 ohne Mindestbestand. */
  missing: number;
  /** ID der Packung, die als Nächstes dran ist, über den ganzen Bestand; null ohne Bestand. */
  next_id: string | null;
}

function buildBatches(entries: readonly StockEntry[], order: (zoneId: string) => number, nextId: string | null): Batch[] {
  const byKey = new Map<string, StockEntry[]>();
  for (const entry of entries) {
    const key = `${entry.pkg.best_before ?? ""}|${entry.pkg.zone_id}`;
    const list = byKey.get(key);
    if (list) {
      list.push(entry);
    } else {
      byKey.set(key, [entry]);
    }
  }
  const batches: Batch[] = [];
  for (const [key, list] of byKey) {
    list.sort((a, b) => (a.pkg.id < b.pkg.id ? -1 : a.pkg.id > b.pkg.id ? 1 : 0));
    const first = list[0];
    if (!first) {
      continue;
    }
    const ids = list.map((entry) => entry.pkg.id);
    batches.push({
      key,
      best_before: first.pkg.best_before,
      zone_id: first.pkg.zone_id,
      zone: first.zone,
      entries: list,
      ids,
      count: list.length,
      state: first.state,
      days: first.days,
      next: nextId !== null && ids.includes(nextId),
    });
  }
  return batches.sort((a, b) => compareDates(a.best_before, b.best_before) || order(a.zone_id) - order(b.zone_id));
}

/**
 * Gruppiert Packungen nach Produkt. Das Ergebnis ist nach Anzeigename sortiert.
 * @param zones alle Zonen in ihrer Reihenfolge (bestimmt die Reihenfolge innerhalb einer Zeile)
 * @param index Bestand und nächste Packung über den ganzen Bestand (`indexStock`). Ohne Angabe
 *              gelten nur die übergebenen Packungen; bei gefilterten Packungen deshalb immer mitgeben,
 *              sonst stimmen Fehlbestand und nächste Charge nicht.
 */
export function groupByProduct(entries: readonly StockEntry[], zones: readonly Zone[], index: StockIndex = indexStock(entries)): ProductGroup[] {
  const order = zoneOrder(zones);
  const byProduct = new Map<string, StockEntry[]>();
  for (const entry of entries) {
    const list = byProduct.get(entry.pkg.product_id);
    if (list) {
      list.push(entry);
    } else {
      byProduct.set(entry.pkg.product_id, [entry]);
    }
  }

  const groups: ProductGroup[] = [];
  for (const [productId, list] of byProduct) {
    const product = list[0]?.product;
    const nextId = index.next.get(productId) ?? null;
    const batches = buildBatches(list, order, nextId);
    // Das früheste MHD steht in der ersten Charge; innerhalb eines Produkts gilt dieselbe
    // Vorlaufzeit, also trägt sie auch die dringendste Warnstufe.
    const first = batches[0];
    const critical = first?.best_before ?? null;
    const zoneIds = [...new Set(list.map((entry) => entry.pkg.zone_id))].sort((a, b) => order(a) - order(b));
    const warnings = countWarnings(list);
    const stock = index.counts.get(productId) ?? list.length;
    groups.push({
      product_id: productId,
      product,
      title: productTitle(product),
      subtitle: productSubtitle(product),
      entries: list,
      count: list.length,
      batches,
      zone_ids: zoneIds,
      critical,
      state: critical === null ? "none" : (first?.state ?? "none"),
      days: critical === null ? null : (first?.days ?? null),
      warn_count: warnings.total,
      expired_count: warnings.expired,
      stock,
      missing: missingStock(product, stock),
      next_id: nextId,
    });
  }
  return groups.sort((a, b) => collator.compare(a.title, b.title) || (a.product_id < b.product_id ? -1 : 1));
}

/**
 * Zeilen für Produkte mit Mindestbestand, von denen nichts im Bestand ist: Menge 0, „fehlt n".
 * Ohne sie verschwände gerade das Produkt aus der Liste, das am dringendsten fehlt; so zeigt
 * die Bestandsliste den Fehlbestand sofort, auch offline, bevor der Server den Eintrag der
 * Einkaufsliste anlegt. Nach Anzeigename sortiert.
 */
export function emptyGroups(products: readonly Product[], counts: ReadonlyMap<string, number>): ProductGroup[] {
  const groups: ProductGroup[] = [];
  for (const product of products) {
    if ((counts.get(product.id) ?? 0) > 0) {
      continue;
    }
    const missing = missingStock(product, 0);
    if (missing === 0) {
      continue;
    }
    groups.push({
      product_id: product.id,
      product,
      title: productTitle(product),
      subtitle: productSubtitle(product),
      entries: [],
      count: 0,
      batches: [],
      zone_ids: [],
      critical: null,
      state: "none",
      days: null,
      warn_count: 0,
      expired_count: 0,
      stock: 0,
      missing,
      next_id: null,
    });
  }
  return groups.sort((a, b) => collator.compare(a.title, b.title) || (a.product_id < b.product_id ? -1 : 1));
}

/** Wie viele Produkte unter ihrem Mindestbestand liegen, und wie viele überhaupt einen haben. */
export interface MinStockCount {
  /** Produkte unter dem Mindestbestand, auch solche ohne Packung im Bestand. */
  below: number;
  /** Produkte mit Mindestbestand. */
  tracked: number;
}

export function countBelowMinStock(products: readonly Product[], counts: ReadonlyMap<string, number>): MinStockCount {
  let below = 0;
  let tracked = 0;
  for (const product of products) {
    if (product.min_stock === null) {
      continue;
    }
    tracked += 1;
    if (missingStock(product, counts.get(product.id) ?? 0) > 0) {
      below += 1;
    }
  }
  return { below, tracked };
}

function sameGroup(a: ProductGroup, b: ProductGroup): boolean {
  return (
    a.product === b.product &&
    a.stock === b.stock &&
    a.missing === b.missing &&
    a.next_id === b.next_id &&
    a.entries.length === b.entries.length &&
    a.entries.every((entry, index) => entry === b.entries[index]) &&
    a.zone_ids.length === b.zone_ids.length &&
    a.zone_ids.every((id, index) => id === b.zone_ids[index])
  );
}

/**
 * Gibt für unveränderte Produkte das Objekt der vorigen Liste zurück statt des neu gebauten.
 *
 * Filtern und Suchen bauen die Gruppen jedes Mal neu, obwohl sich an den meisten nichts
 * ändert. Bleibt das Objekt dasselbe, zeichnet die Ansicht die Zeile nicht neu: Bei einem
 * großen Bestand entscheidet das darüber, ob das Tippen im Suchfeld flüssig bleibt.
 * Gleich heißt: dasselbe Produkt, dieselben Packungen (als Einträge des Bestands) in
 * derselben Folge, dieselben Zonen in derselben Folge, und über den ganzen Bestand derselbe
 * Fehlbestand und dieselbe nächste Packung (ein Filter zeigt davon nur einen Teil).
 */
export function reuseGroups(previous: ReadonlyMap<string, ProductGroup>, next: readonly ProductGroup[]): ProductGroup[] {
  return next.map((group) => {
    const old = previous.get(group.product_id);
    return old !== undefined && sameGroup(old, group) ? old : group;
  });
}

export type SortKey = "title" | "critical" | "count";

export interface SortOrder {
  key: SortKey;
  descending: boolean;
}

export const DEFAULT_SORT: SortOrder = { key: "title", descending: false };

/** Sortiert die Zeilen der Bestandsliste. Zeilen ohne MHD stehen bei "critical" immer am Ende. */
export function sortGroups(groups: readonly ProductGroup[], order: SortOrder): ProductGroup[] {
  const direction = order.descending ? -1 : 1;
  const byTitle = (a: ProductGroup, b: ProductGroup) => collator.compare(a.title, b.title);
  const sorted = [...groups];
  switch (order.key) {
    case "title":
      return sorted.sort((a, b) => direction * byTitle(a, b));
    case "count":
      return sorted.sort((a, b) => direction * (a.count - b.count) || byTitle(a, b));
    case "critical":
      return sorted.sort((a, b) => {
        if (a.critical === null || b.critical === null) {
          return compareDates(a.critical, b.critical) || byTitle(a, b);
        }
        return direction * compareDates(a.critical, b.critical) || byTitle(a, b);
      });
  }
}

// ------------------------------------------------------------------------------------
// Suche und Filter
// ------------------------------------------------------------------------------------

/** Kleinschreibung ohne Akzente und Umlaut-Punkte: „Käse" wird über „kase" und „käse" gefunden. */
export function foldText(text: string): string {
  return text
    .toLocaleLowerCase("de")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * Ab so vielen Zeichen gilt ein Suchwort auch als Anfang einer Packungs-ID. Kürzere Wörter
 * träfen zufällig: Wer „ba" für Basmati tippt, bekäme sonst jede Packung dazu, deren ID mit
 * „BA" beginnt.
 */
export const MIN_ID_PREFIX = 3;

/** Ein Suchwort in den drei Lesarten, in denen es treffen kann. */
interface SearchToken {
  /** für Name und Marke */
  text: string;
  /** für Barcodes: nur wenn das Wort ganz aus Ziffern besteht */
  digits: string | null;
  /** für Packungs-IDs: groß, O als 0, I und L als 1 (wie `normalizePackageId`); leer, wenn das Wort dafür zu kurz ist */
  id: string;
}

/** Zerlegt die Eingabe des Suchfelds in Wörter. Leere Eingabe ergibt keine Wörter. */
export function searchTokens(query: string): SearchToken[] {
  return query
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "")
    .map((word) => {
      const id = word.replace(/-/g, "").toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");
      return {
        text: foldText(word),
        digits: /^\d+$/.test(word) ? word : null,
        id: id.length >= MIN_ID_PREFIX ? id : "",
      };
    });
}

/**
 * Trifft die Suche diese Packung? Jedes Wort muss treffen, und zwar
 * - im Namen oder in der Marke des Produkts (irgendwo im Text),
 * - in einem Barcode des Produkts (irgendwo, nur für reine Ziffern) oder
 * - am Anfang der Packungs-ID (erst ab `MIN_ID_PREFIX` Zeichen).
 */
export function matchesSearch(entry: StockEntry, tokens: readonly SearchToken[]): boolean {
  return matchesTokens(entry.product, entry.pkg.id, tokens);
}

/** Trifft die Suche dieses Produkt? Wie `matchesSearch`, nur ohne Packungs-ID (für Zeilen ohne Bestand). */
export function matchesProduct(product: Product | undefined, tokens: readonly SearchToken[]): boolean {
  return matchesTokens(product, null, tokens);
}

function matchesTokens(product: Product | undefined, packageId: string | null, tokens: readonly SearchToken[]): boolean {
  if (tokens.length === 0) {
    return true;
  }
  const haystack = product ? foldText(`${product.name} ${product.brand}`) : "";
  const barcodes = product?.barcodes ?? [];
  return tokens.every(
    (token) =>
      haystack.includes(token.text) ||
      (token.digits !== null && barcodes.some((barcode) => barcode.includes(token.digits as string))) ||
      (packageId !== null && token.id !== "" && packageId.startsWith(token.id)),
  );
}

export interface StockFilter {
  /** Eingabe des Suchfelds. */
  query: string;
  /** Nur diese Zone; null = alle. */
  zone_id: string | null;
  /** Nur Packungen, die abgelaufen sind oder bald ablaufen. */
  expiring: boolean;
  /** Nur Produkte unter dem Mindestbestand (über den ganzen Bestand gezählt). */
  below_min?: boolean;
}

export const NO_FILTER: StockFilter = { query: "", zone_id: null, expiring: false, below_min: false };

export function isFiltered(filter: StockFilter): boolean {
  return filter.query.trim() !== "" || filter.zone_id !== null || filter.expiring || filter.below_min === true;
}

/**
 * Wendet Suche und Filter auf die Packungen an. Gefiltert wird vor dem Gruppieren:
 * Mit dem Filter „Keller" zeigt eine Zeile Menge und kritischstes MHD nur der Packungen im Keller.
 */
export function filterEntries(entries: readonly StockEntry[], filter: StockFilter): StockEntry[] {
  const tokens = searchTokens(filter.query);
  return entries.filter(
    (entry) =>
      (filter.zone_id === null || entry.pkg.zone_id === filter.zone_id) &&
      (!filter.expiring || isWarning(entry)) &&
      matchesSearch(entry, tokens),
  );
}

/**
 * Die Zeilen der Bestandsliste, unsortiert: die Produkte im Bestand nach Suche und Filter, dazu
 * die Produkte unter dem Mindestbestand ohne Packung (`emptyGroups`), solange weder eine Zone
 * noch „Läuft bald ab" gewählt ist: Beides kennt nur Packungen. Der Suche müssen sie trotzdem
 * entsprechen. Mit `below_min` bleiben nur Produkte unter dem Mindestbestand.
 * @param index Bestand und nächste Packung über alle Packungen (`indexStock(entries)`)
 */
export function stockGroups(
  entries: readonly StockEntry[],
  products: readonly Product[],
  zones: readonly Zone[],
  filter: StockFilter,
  index: StockIndex = indexStock(entries),
): ProductGroup[] {
  const narrowed = filter.query.trim() !== "" || filter.zone_id !== null || filter.expiring;
  const groups = groupByProduct(narrowed ? filterEntries(entries, filter) : entries, zones, index);
  if (filter.zone_id === null && !filter.expiring) {
    const tokens = searchTokens(filter.query);
    for (const group of emptyGroups(products, index.counts)) {
      if (matchesProduct(group.product, tokens)) {
        groups.push(group);
      }
    }
  }
  return filter.below_min === true ? groups.filter((group) => group.missing > 0) : groups;
}

// ------------------------------------------------------------------------------------
// Zonen-Karten
// ------------------------------------------------------------------------------------

export interface ZoneFill {
  zone: Zone;
  /** Packungen in dieser Zone. */
  count: number;
  /** Anteil am gesamten Bestand, 0 bis 1: die Länge des Balkens. */
  share: number;
}

/** Füllstand je Zone: wie viele Packungen dort liegen und welcher Anteil des Bestands das ist. */
export function zoneFill(entries: readonly StockEntry[], zones: readonly Zone[]): ZoneFill[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.pkg.zone_id, (counts.get(entry.pkg.zone_id) ?? 0) + 1);
  }
  const total = entries.length;
  return zones.map((zone) => {
    const count = counts.get(zone.id) ?? 0;
    return { zone, count, share: total === 0 ? 0 : count / total };
  });
}

// ------------------------------------------------------------------------------------
// Warnungen: je Produkt und MHD
// ------------------------------------------------------------------------------------

/** Alle Packungen eines Produkts mit demselben MHD, die abgelaufen sind oder bald ablaufen. */
export interface WarningGroup {
  key: string;
  product_id: string;
  product: Product | undefined;
  title: string;
  subtitle: string;
  best_before: string;
  state: "soon" | "expired";
  /** Tage bis zum MHD; negativ = abgelaufen. */
  days: number;
  entries: StockEntry[];
  ids: string[];
  count: number;
  /** Wo die Packungen liegen, in der Reihenfolge der Zonen. */
  zones: { zone_id: string; zone: Zone | undefined; ids: string[] }[];
}

/**
 * Die Warnliste: abgelaufene und bald ablaufende Packungen, zusammengefasst je Produkt und
 * MHD, das Dringendste zuerst.
 */
export function warningGroups(entries: readonly StockEntry[], zones: readonly Zone[]): WarningGroup[] {
  const order = zoneOrder(zones);
  const byKey = new Map<string, StockEntry[]>();
  for (const entry of entries) {
    if (!isWarning(entry) || entry.pkg.best_before === null) {
      continue;
    }
    const key = `${entry.pkg.product_id}|${entry.pkg.best_before}`;
    const list = byKey.get(key);
    if (list) {
      list.push(entry);
    } else {
      byKey.set(key, [entry]);
    }
  }

  const groups: WarningGroup[] = [];
  for (const [key, list] of byKey) {
    const first = list[0];
    if (!first || first.pkg.best_before === null || first.days === null) {
      continue;
    }
    list.sort((a, b) => order(a.pkg.zone_id) - order(b.pkg.zone_id) || (a.pkg.id < b.pkg.id ? -1 : 1));
    const byZone = new Map<string, { zone_id: string; zone: Zone | undefined; ids: string[] }>();
    for (const entry of list) {
      const place = byZone.get(entry.pkg.zone_id);
      if (place) {
        place.ids.push(entry.pkg.id);
      } else {
        byZone.set(entry.pkg.zone_id, { zone_id: entry.pkg.zone_id, zone: entry.zone, ids: [entry.pkg.id] });
      }
    }
    groups.push({
      key,
      product_id: first.pkg.product_id,
      product: first.product,
      title: productTitle(first.product),
      subtitle: productSubtitle(first.product),
      best_before: first.pkg.best_before,
      state: first.state === "expired" ? "expired" : "soon",
      days: first.days,
      entries: list,
      ids: list.map((entry) => entry.pkg.id),
      count: list.length,
      zones: [...byZone.values()],
    });
  }
  return groups.sort((a, b) => a.days - b.days || collator.compare(a.title, b.title) || (a.key < b.key ? -1 : 1));
}
