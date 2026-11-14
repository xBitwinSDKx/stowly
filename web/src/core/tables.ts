/**
 * Die synchronisierten Datensätze im Arbeitsspeicher.
 *
 * `Tables` ist ein unveränderlicher Stand: Jede Änderung erzeugt für die betroffene Tabelle
 * eine neue Map, unberührte Tabellen behalten ihre. Daran erkennen die `Live`-Werte, ob sie
 * neu rechnen müssen (src/core/live.ts).
 *
 * `Draft` ist eine Arbeitskopie darüber: Befehle schreiben hinein, ohne den Stand darunter
 * anzufassen. Erst `commit()` liefert den neuen Stand. Scheitert unterwegs etwas, wird der
 * Entwurf einfach verworfen.
 *
 * Ohne DOM: Diese Datei läuft auch im Service Worker und in der nachgebauten Schnittstelle.
 */
import type { HouseholdSettings, LabelTemplate, Package, Printer, PrinterStatus, PrintJob, Product, ShoppingItem, Zone } from "@/contract/api.gen";

export interface TableRows {
  products: Product;
  packages: Package;
  zones: Zone;
  printers: Printer;
  printer_status: PrinterStatus;
  print_jobs: PrintJob;
  label_templates: LabelTemplate;
  /** Einkaufsliste (seit Protokoll 2, App-Datenbank v3). */
  shopping_items: ShoppingItem;
}

export type TableName = keyof TableRows;

export const TABLE_NAMES: readonly TableName[] = [
  "products",
  "packages",
  "zones",
  "printers",
  "printer_status",
  "print_jobs",
  "label_templates",
  "shopping_items",
];

export type Tables = { readonly [T in TableName]: ReadonlyMap<string, TableRows[T]> } & {
  readonly settings: HouseholdSettings | null;
};

/** Derselbe Aufbau zum Zusammensetzen eines neuen Stands. */
export type MutableTables = { -readonly [K in keyof Tables]: Tables[K] };

export const EMPTY_TABLES: Tables = {
  products: new Map(),
  packages: new Map(),
  zones: new Map(),
  printers: new Map(),
  printer_status: new Map(),
  print_jobs: new Map(),
  label_templates: new Map(),
  shopping_items: new Map(),
  settings: null,
};

/** Der Schlüssel eines Datensatzes in seiner Tabelle. */
export function keyOf<T extends TableName>(table: T, row: TableRows[T]): string {
  if (table === "printer_status") {
    return (row as PrinterStatus).printer_id;
  }
  if (table === "label_templates") {
    return (row as LabelTemplate).key;
  }
  return (row as { id: string }).id;
}

/** Baut eine Tabelle aus einer Liste von Datensätzen. */
export function tableFrom<T extends TableName>(table: T, rows: readonly TableRows[T][]): Map<string, TableRows[T]> {
  const map = new Map<string, TableRows[T]>();
  for (const row of rows) {
    map.set(keyOf(table, row), row);
  }
  return map;
}

type ChangedMaps = { [T in TableName]?: Map<string, TableRows[T]> };

export class Draft {
  private readonly changed: ChangedMaps = {};
  private settingsValue: HouseholdSettings | null;
  private settingsTouched = false;

  constructor(private readonly base: Tables) {
    this.settingsValue = base.settings;
  }

  get<T extends TableName>(table: T, id: string): TableRows[T] | undefined {
    const own = this.changed[table] as Map<string, TableRows[T]> | undefined;
    if (own?.has(id)) {
      return own.get(id);
    }
    return (this.base[table] as ReadonlyMap<string, TableRows[T]>).get(id);
  }

  put<T extends TableName>(table: T, row: TableRows[T]): void {
    let own = this.changed[table] as Map<string, TableRows[T]> | undefined;
    if (!own) {
      own = new Map();
      (this.changed as Record<TableName, unknown>)[table] = own;
    }
    own.set(keyOf(table, row), row);
  }

  /** Alle Datensätze einer Tabelle, Änderungen des Entwurfs eingeschlossen. Als Liste, damit währenddessen geschrieben werden darf. */
  rows<T extends TableName>(table: T): TableRows[T][] {
    const own = this.changed[table] as Map<string, TableRows[T]> | undefined;
    const base = this.base[table] as ReadonlyMap<string, TableRows[T]>;
    if (!own || own.size === 0) {
      return [...base.values()];
    }
    const result: TableRows[T][] = [];
    for (const [id, row] of base) {
      if (!own.has(id)) {
        result.push(row);
      }
    }
    result.push(...own.values());
    return result;
  }

  get settings(): HouseholdSettings | null {
    return this.settingsValue;
  }

  set settings(value: HouseholdSettings | null) {
    this.settingsValue = value;
    this.settingsTouched = true;
  }

  /** Was der Entwurf geändert hat: Tabelle und Schlüssel je Datensatz. */
  touched(): [TableName, string][] {
    const result: [TableName, string][] = [];
    for (const table of TABLE_NAMES) {
      for (const id of this.changed[table]?.keys() ?? []) {
        result.push([table, id]);
      }
    }
    return result;
  }

  /** Wahr, wenn der Entwurf die Einstellungen des Haushalts geändert hat. */
  get touchedSettings(): boolean {
    return this.settingsTouched;
  }

  /** Der neue Stand. Nur geänderte Tabellen bekommen eine neue Map. */
  commit(): Tables {
    const next: Record<string, unknown> = { ...this.base };
    for (const table of TABLE_NAMES) {
      const own = this.changed[table];
      if (own && own.size > 0) {
        const merged = new Map<string, unknown>(this.base[table]);
        for (const [id, row] of own) {
          merged.set(id, row);
        }
        next[table] = merged;
      }
    }
    if (this.settingsTouched) {
      next.settings = this.settingsValue;
    }
    return next as unknown as Tables;
  }
}

/** Vergleicht zwei JSON-artige Werte dem Inhalt nach. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) {
    return false;
  }
  return keys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
}

function reconcileMap<V>(previous: ReadonlyMap<string, V>, next: ReadonlyMap<string, V>): ReadonlyMap<string, V> {
  if (previous === next) {
    return previous;
  }
  let identical = previous.size === next.size;
  const result = new Map<string, V>();
  for (const [id, row] of next) {
    const old = previous.get(id);
    if (old !== undefined && (old === row || deepEqual(old, row))) {
      result.set(id, old);
    } else {
      result.set(id, row);
      identical = false;
    }
  }
  return identical ? previous : result;
}

/**
 * Gleicht einen neu berechneten Stand mit dem vorigen ab: Was inhaltlich gleich geblieben
 * ist, behält seine alte Referenz (Datensatz und, wenn sich gar nichts tat, die ganze Tabelle).
 * So rendert die Oberfläche nach einem Abgleich nur neu, was sich wirklich geändert hat.
 */
export function reconcile(previous: Tables, next: Tables): Tables {
  if (previous === next) {
    return previous;
  }
  const result: Record<string, unknown> = {};
  let identical = true;
  for (const table of TABLE_NAMES) {
    const map = reconcileMap(previous[table] as ReadonlyMap<string, unknown>, next[table] as ReadonlyMap<string, unknown>);
    result[table] = map;
    identical &&= map === previous[table];
  }
  const settings = deepEqual(previous.settings, next.settings) ? previous.settings : next.settings;
  result.settings = settings;
  identical &&= settings === previous.settings;
  return identical ? previous : (result as unknown as Tables);
}
