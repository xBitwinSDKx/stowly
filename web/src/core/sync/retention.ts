/**
 * Aufbewahrung (docs/sync-protokoll.md, Abschnitte 6.4 und 9.3).
 *
 * Der Server liefert außerhalb eines vollständigen Abzugs alles, egal wie alt. Die App
 * verwirft nach derselben Regel wie der Abzug:
 *
 * - entnommene Packungen, deren `removed_at` länger zurückliegt als `trash_retention_days`,
 * - Einträge der Einkaufsliste, die länger als `trash_retention_days` erledigt oder gelöscht
 *   sind, gemessen am späteren von `done_at` und `deleted_at`,
 * - Etiketten in einem Endzustand, deren `updated_at` länger als 30 Tage zurückliegt.
 *
 * Verworfen wird beim Empfang und beim Start. Was so verschwindet, verschwindet auch dann,
 * wenn die Kopie es bis eben noch als Bestand oder als ausstehend führte: Nur so erfährt ein
 * lange nicht benutztes Gerät, dass eine Packung inzwischen entnommen ist.
 *
 * Ohne DOM: Diese Datei läuft auch im Service Worker.
 */
import type { Package, PrintJob, PrintJobState, ShoppingItem } from "@/contract/api.gen";

import type { MutableTables, Tables } from "../tables";

export const DAY_MS = 86_400_000;

/** So lange bleiben erledigte Etiketten sichtbar. */
export const PRINT_JOB_RETENTION_DAYS = 30;

const FINAL_JOB_STATES: readonly PrintJobState[] = ["printed", "sent", "failed", "cancelled"];

/** Zeitstempel, vor dem etwas als „länger her als `days` Tage" gilt. */
export function retentionLimit(nowMs: number, days: number): string {
  return new Date(nowMs - days * DAY_MS).toISOString();
}

/** Wahr für eine entnommene Packung jenseits der Aufbewahrungsdauer. */
export function isExpiredPackage(pkg: Package, limit: string): boolean {
  return pkg.removed_at !== null && pkg.removed_at < limit;
}

/** Seit wann ein Eintrag der Einkaufsliste geschlossen ist: der spätere von `done_at` und `deleted_at`; null, solange er offen ist. */
export function shoppingItemClosedAt(item: Pick<ShoppingItem, "done_at" | "deleted_at">): string | null {
  if (item.done_at === null || item.deleted_at === null) {
    return item.done_at ?? item.deleted_at;
  }
  return item.done_at > item.deleted_at ? item.done_at : item.deleted_at;
}

/** Wahr für einen Eintrag, der länger als die Aufbewahrungsdauer erledigt oder gelöscht ist. */
export function isExpiredShoppingItem(item: Pick<ShoppingItem, "done_at" | "deleted_at">, limit: string): boolean {
  const closed = shoppingItemClosedAt(item);
  return closed !== null && closed < limit;
}

/** Wahr für ein Etikett in einem Endzustand. */
export function isFinalJob(job: PrintJob): boolean {
  return FINAL_JOB_STATES.includes(job.state);
}

/** Wahr für ein erledigtes Etikett, das älter ist als die Grenze. */
export function isExpiredJob(job: PrintJob, limit: string): boolean {
  return isFinalJob(job) && job.updated_at < limit;
}

export interface PurgeResult {
  tables: Tables;
  /** Schlüssel der verworfenen Packungen. */
  packages: string[];
  /** Schlüssel der verworfenen Etiketten. */
  print_jobs: string[];
  /** Schlüssel der verworfenen Einträge der Einkaufsliste. */
  shopping_items: string[];
}

/** Wahr, wenn `purge` nichts verworfen hat. */
export function nothingPurged(result: PurgeResult): boolean {
  return result.packages.length === 0 && result.print_jobs.length === 0 && result.shopping_items.length === 0;
}

function without<V>(map: ReadonlyMap<string, V>, ids: readonly string[]): ReadonlyMap<string, V> {
  if (ids.length === 0) {
    return map;
  }
  const next = new Map(map);
  for (const id of ids) {
    next.delete(id);
  }
  return next;
}

/**
 * Verwirft aus einem Stand, was jenseits der Aufbewahrung liegt.
 * @param nowMs Serverzeit in Millisekunden (aus der Antwort oder geschätzt über die Geräteuhr)
 */
export function purge(tables: Tables, nowMs: number): PurgeResult {
  const packages: string[] = [];
  const items: string[] = [];
  if (tables.settings) {
    const limit = retentionLimit(nowMs, tables.settings.trash_retention_days);
    for (const pkg of tables.packages.values()) {
      if (isExpiredPackage(pkg, limit)) {
        packages.push(pkg.id);
      }
    }
    for (const item of tables.shopping_items.values()) {
      if (isExpiredShoppingItem(item, limit)) {
        items.push(item.id);
      }
    }
  }
  const jobs: string[] = [];
  const jobLimit = retentionLimit(nowMs, PRINT_JOB_RETENTION_DAYS);
  for (const job of tables.print_jobs.values()) {
    if (isExpiredJob(job, jobLimit)) {
      jobs.push(job.id);
    }
  }
  const result: PurgeResult = { tables, packages, print_jobs: jobs, shopping_items: items };
  if (nothingPurged(result)) {
    return result;
  }
  const next: MutableTables = { ...tables };
  next.packages = without(tables.packages, packages);
  next.print_jobs = without(tables.print_jobs, jobs);
  next.shopping_items = without(tables.shopping_items, items);
  return { ...result, tables: next };
}
