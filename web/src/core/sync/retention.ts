/**
 * Aufbewahrung (docs/sync-protokoll.md, Abschnitte 6.4 und 9.3).
 *
 * Der Server liefert außerhalb eines vollständigen Abzugs alles, egal wie alt. Die App
 * verwirft nach derselben Regel wie der Abzug:
 *
 * - entnommene Packungen, deren `removed_at` länger zurückliegt als `trash_retention_days`,
 * - Etiketten in einem Endzustand, deren `updated_at` länger als 30 Tage zurückliegt.
 *
 * Verworfen wird beim Empfang und beim Start. Was so verschwindet, verschwindet auch dann,
 * wenn die Kopie es bis eben noch als Bestand oder als ausstehend führte: Nur so erfährt ein
 * lange nicht benutztes Gerät, dass eine Packung inzwischen entnommen ist.
 *
 * Ohne DOM: Diese Datei läuft auch im Service Worker.
 */
import type { Package, PrintJob, PrintJobState } from "@/contract/api.gen";

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
}

/**
 * Verwirft aus einem Stand, was jenseits der Aufbewahrung liegt.
 * @param nowMs Serverzeit in Millisekunden (aus der Antwort oder geschätzt über die Geräteuhr)
 */
export function purge(tables: Tables, nowMs: number): PurgeResult {
  const packages: string[] = [];
  if (tables.settings) {
    const limit = retentionLimit(nowMs, tables.settings.trash_retention_days);
    for (const pkg of tables.packages.values()) {
      if (isExpiredPackage(pkg, limit)) {
        packages.push(pkg.id);
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
  if (packages.length === 0 && jobs.length === 0) {
    return { tables, packages, print_jobs: jobs };
  }
  const next: MutableTables = { ...tables };
  if (packages.length > 0) {
    const map = new Map(tables.packages);
    for (const id of packages) {
      map.delete(id);
    }
    next.packages = map;
  }
  if (jobs.length > 0) {
    const map = new Map(tables.print_jobs);
    for (const id of jobs) {
      map.delete(id);
    }
    next.print_jobs = map;
  }
  return { tables: next, packages, print_jobs: jobs };
}
