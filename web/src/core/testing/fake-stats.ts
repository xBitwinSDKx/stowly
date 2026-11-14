/**
 * `GET /api/stats` der Nachbildung (docs/sync-protokoll.md, 11.1), eigens nach dem Protokoll
 * geschrieben: Zeitraum aus `?start=` und `?end=`, Monate in der Zeitzone der Nachbildung (über
 * `Intl`), gezählt aus dem heutigen Stand aller Packungen, auch jenseits der Aufbewahrungsdauer.
 *
 * Ungültig ist ein Monat, der nicht `YYYY-MM` ist (`isMonth`), ein Parameter doppelt (beides für
 * `start` und `end` zugleich gesammelt), `start` nach `end` oder mehr als `STATS_MAX_MONTHS`
 * Monate (Stelle jeweils `start`). Die Antwort darauf ist 400 mit `details.errors[].loc`.
 *
 * Abweichung: Namen vergleicht die Nachbildung nach `toUpperCase().toLowerCase()` statt nach
 * `str.casefold()`; für deutsche Namen ist das dasselbe.
 */
import { STATS_DEFAULT_MONTHS, STATS_MAX_MONTHS, STATS_TOP_PRODUCTS, type Stats, type StatsProduct } from "@/contract/api.gen";
import { isMonth } from "@/contract/time";

import type { Tables } from "../tables";

/** Mehr Schritte hat keine Kette aus Zusammenführungen oder gelöschten Zonen. */
const MAX_HOPS = 1000;

export interface StatsProblem {
  loc: ["query", "start" | "end"];
  msg: string;
  type: "value_error";
}

export type StatsAnswer = { ok: true; stats: Stats } | { ok: false; problems: StatsProblem[] };

function problem(field: "start" | "end", message: string): StatsProblem {
  return { loc: ["query", field], msg: message, type: "value_error" };
}

/** Kalendermonat eines Zeitpunkts in der Zeitzone, "YYYY-MM". */
export function monthIn(timezone: string, moment: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit" }).formatToParts(moment);
  const year = parts.find((part) => part.type === "year")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  return `${year.padStart(4, "0")}-${month.padStart(2, "0")}`;
}

function monthNumber(month: string): number {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

function monthText(number: number): string {
  return `${String(Math.floor(number / 12)).padStart(4, "0")}-${String((number % 12) + 1).padStart(2, "0")}`;
}

/** Vergleich nach Unicode-Zeichen, wie Python Texte vergleicht. */
function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a, (char) => char.codePointAt(0) ?? 0);
  const right = Array.from(b, (char) => char.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

/** Folgt einer Kette (`merged_into`, `moved_to`) bis zum Ende; null bei einer Schleife. */
function follow(start: string, step: (id: string) => string | null): string | null {
  let current = start;
  for (let hops = 0; hops < MAX_HOPS; hops += 1) {
    const next = step(current);
    if (next === null) {
      return current;
    }
    current = next;
  }
  return null;
}

/** Der Zeitraum aus der Abfrage, als fortlaufende Nummern der Monate, oder die Verstöße. */
function periodOf(query: string, timezone: string, now: Date): { first: number; last: number } | StatsProblem[] {
  const params = new URLSearchParams(query);
  const given: Record<"start" | "end", string | null> = { start: null, end: null };
  const problems: StatsProblem[] = [];
  for (const field of ["start", "end"] as const) {
    const values = params.getAll(field);
    if (values.length > 1) {
      problems.push(problem(field, `'${field}' darf nur einmal angegeben sein.`));
    } else if (values.length === 1 && !isMonth(values[0] ?? "")) {
      problems.push(problem(field, `'${field}' muss ein Monat YYYY-MM sein (Jahre 0001 bis 9999).`));
    }
    given[field] = values[0] ?? null;
  }
  if (problems.length > 0) {
    return problems;
  }
  const last = given.end === null ? monthNumber(monthIn(timezone, now)) : monthNumber(given.end);
  // Ohne `start` STATS_DEFAULT_MONTHS Monate bis `end`, aber nie vor dem Jahr 0001.
  const first = given.start === null ? Math.max(last - (STATS_DEFAULT_MONTHS - 1), 12) : monthNumber(given.start);
  if (first > last) {
    return [problem("start", "'start' liegt nach 'end'.")];
  }
  if (last - first + 1 > STATS_MAX_MONTHS) {
    return [problem("start", `Der Zeitraum umfasst mehr als ${STATS_MAX_MONTHS} Monate.`)];
  }
  return { first, last };
}

/** Die Statistik für `GET /api/stats?…` (`query` ohne Fragezeichen). */
export function fakeStats(tables: Tables, query: string, timezone: string, now: Date): StatsAnswer {
  const period = periodOf(query, timezone, now);
  if (Array.isArray(period)) {
    return { ok: false, problems: period };
  }
  const { first, last } = period;
  const months = new Map<number, { consumed: number; discarded: number }>();
  for (let number = first; number <= last; number += 1) {
    months.set(number, { consumed: 0, discarded: 0 });
  }
  const zoneCounts = new Map<string, { consumed: number; discarded: number }>();
  const discardedBy = new Map<string, number>();

  for (const pkg of tables.packages.values()) {
    const reason = pkg.removal_reason;
    if (pkg.removed_at === null || (reason !== "consumed" && reason !== "discarded")) {
      continue;
    }
    const month = months.get(monthNumber(monthIn(timezone, new Date(pkg.removed_at))));
    if (!month) {
      continue;
    }
    month[reason] += 1;
    // Wie im Server: Zone und Produkt folgen gelöschten Zonen und Zusammenführungen bis zum Ziel.
    const zoneId = follow(pkg.zone_id, (id) => {
      const zone = tables.zones.get(id);
      return zone && zone.deleted_at !== null ? zone.moved_to : null;
    });
    if (zoneId !== null) {
      const tally = zoneCounts.get(zoneId) ?? { consumed: 0, discarded: 0 };
      tally[reason] += 1;
      zoneCounts.set(zoneId, tally);
    }
    if (reason === "discarded") {
      const productId = follow(pkg.product_id, (id) => tables.products.get(id)?.merged_into ?? null);
      if (productId !== null) {
        discardedBy.set(productId, (discardedBy.get(productId) ?? 0) + 1);
      }
    }
  }

  const top: StatsProduct[] = [...discardedBy].map(([productId, discarded]) => {
    const product = tables.products.get(productId);
    return { product_id: productId, name: product?.name.trim() ?? "", barcode: [...(product?.barcodes ?? [])].sort()[0] ?? null, discarded };
  });
  top.sort(
    (a, b) =>
      b.discarded - a.discarded ||
      Number(a.name === "") - Number(b.name === "") ||
      compareCodePoints(a.name.toUpperCase().toLowerCase(), b.name.toUpperCase().toLowerCase()) ||
      compareCodePoints(a.product_id, b.product_id),
  );
  const zones = [...tables.zones.values()]
    .filter((zone) => zone.deleted_at === null)
    .sort((a, b) => a.sort - b.sort || compareCodePoints(a.name, b.name) || compareCodePoints(a.id, b.id));
  const counted = [...months.values()];
  const consumed = counted.reduce((sum, month) => sum + month.consumed, 0);
  const discarded = counted.reduce((sum, month) => sum + month.discarded, 0);
  const total = consumed + discarded;
  return {
    ok: true,
    stats: {
      start: monthText(first),
      end: monthText(last),
      months: [...months].map(([number, counts]) => ({ month: monthText(number), ...counts })),
      consumed,
      discarded,
      discarded_share: total === 0 ? null : Math.round((discarded / total) * 10_000) / 10_000,
      top_discarded: top.slice(0, STATS_TOP_PRODUCTS),
      zones: zones.map((zone) => ({ zone_id: zone.id, name: zone.name, ...(zoneCounts.get(zone.id) ?? { consumed: 0, discarded: 0 }) })),
      timezone,
    },
  };
}
