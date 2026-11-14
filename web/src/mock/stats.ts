/**
 * Die Statistik der Attrappe (docs/sync-protokoll.md, 11.1), gerechnet wie beim Server aus allen
 * Packungen der ganzen Zeit, nicht nur aus der Lösch-Historie.
 *
 * - Zeitraum in ganzen Monaten der Zeitzone des Servers, beide eingeschlossen. Ohne `end` der
 *   laufende Monat, ohne `start` `STATS_DEFAULT_MONTHS` − 1 Monate vor `end`.
 * - Ungültig ("invalid", mit `details.errors[].loc` und den Sätzen des Servers): ein Monat, der
 *   nicht `YYYY-MM` ist (`isMonth`; sind es beide, stehen beide in `details.errors`), `start` nach
 *   `end`, mehr als `STATS_MAX_MONTHS` Monate. Bei den beiden letzten ist `start` die Stelle.
 * - Gezählt wird der heutige Stand jeder Packung: `removed_at` im Zeitraum, Grund "consumed"
 *   oder "discarded". Zusammengeführte und umgezogene Packungen zählen beim Ziel, weil die
 *   Attrappe sie dorthin umhängt wie der Server.
 *
 * Abweichung: Namen vergleicht die Attrappe nach `toUpperCase().toLowerCase()` statt nach
 * `str.casefold()` des Servers; für deutsche Namen ist das dasselbe.
 */
import { CoreError, isMonth, STATS_DEFAULT_MONTHS, STATS_MAX_MONTHS, STATS_TOP_PRODUCTS, type Package, type Product, type Stats, type StatsProduct, type StatsRange, type Zone } from "@/contract";


export interface StatsInput {
  /** Alle Packungen, auch entnommene. */
  packages: readonly Package[];
  /** Alle Produkte, auch zusammengeführte. */
  products: readonly Product[];
  /** Die nicht gelöschten Zonen in ihrer Reihenfolge. */
  zones: readonly Zone[];
  range: StatsRange;
  /** Zeitzone des Servers (IANA-Name). */
  timezone: string;
  now: Date;
  /** Nur was ab diesem Zeitpunkt entnommen wurde, zählt; null = alles (Ausgangslage "stats-empty"). */
  since: string | null;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Kalendermonat eines Zeitpunkts in der Zeitzone, "YYYY-MM". */
export function monthIn(timezone: string, moment: Date): string {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit" });
    formatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(moment);
  const year = parts.find((part) => part.type === "year")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  return `${year.padStart(4, "0")}-${month.padStart(2, "0")}`;
}

/** Fortlaufende Nummer eines Monats "YYYY-MM": Jahr mal 12 plus Monat (0 bis 11). */
function monthNumber(month: string): number {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

function monthText(number: number): string {
  const year = Math.floor(number / 12);
  return `${String(year).padStart(4, "0")}-${String((number % 12) + 1).padStart(2, "0")}`;
}

interface Problem {
  loc: ["query", "start" | "end"];
  msg: string;
  type: "value_error";
}

/** "invalid" mit allen Stellen in `details.errors`, wie der Server sie bei 400 nennt; der Satz ist der der ersten. */
function invalidRange(problems: Problem[]): CoreError {
  return new CoreError("invalid", problems[0]?.msg ?? "Der Zeitraum ist ungültig.", { errors: problems });
}

function problem(field: "start" | "end", message: string): Problem {
  return { loc: ["query", field], msg: message, type: "value_error" };
}

/** Der Zeitraum nach den Regeln des Servers als fortlaufende Nummern der Monate. */
function periodOf(range: StatsRange, timezone: string, now: Date): { first: number; last: number } {
  const malformed = (["start", "end"] as const)
    .filter((field) => range[field] !== undefined && !isMonth(range[field] as string))
    .map((field) => problem(field, `'${field}' muss ein Monat YYYY-MM sein (Jahre 0001 bis 9999).`));
  if (malformed.length > 0) {
    throw invalidRange(malformed);
  }
  const last = range.end === undefined ? monthNumber(monthIn(timezone, now)) : monthNumber(range.end);
  // Ohne `start` reicht der Zeitraum STATS_DEFAULT_MONTHS Monate zurück, aber nie vor das Jahr 1.
  const first = range.start === undefined ? Math.max(12, last - (STATS_DEFAULT_MONTHS - 1)) : monthNumber(range.start);
  if (first > last) {
    throw invalidRange([problem("start", "'start' liegt nach 'end'.")]);
  }
  if (last - first + 1 > STATS_MAX_MONTHS) {
    throw invalidRange([problem("start", `Der Zeitraum umfasst mehr als ${STATS_MAX_MONTHS} Monate.`)]);
  }
  return { first, last };
}

/** Vergleich nach Unicode-Zeichen (nicht nach UTF-16-Einheiten), wie Python Texte vergleicht. */
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

/** Meiste entsorgte zuerst, dann nach Name (Platzhalter ohne Namen zuletzt), dann nach Kennung. */
function compareTop(a: StatsProduct, b: StatsProduct): number {
  if (a.discarded !== b.discarded) {
    return b.discarded - a.discarded;
  }
  if ((a.name === "") !== (b.name === "")) {
    return a.name === "" ? 1 : -1;
  }
  return compareCodePoints(a.name.toUpperCase().toLowerCase(), b.name.toUpperCase().toLowerCase()) || compareCodePoints(a.product_id, b.product_id);
}

/** Die Statistik; wirft CoreError "invalid" bei einem ungültigen Zeitraum. */
export function computeStats(input: StatsInput): Stats {
  const { first, last } = periodOf(input.range, input.timezone, input.now);
  const months = new Map<number, { consumed: number; discarded: number }>();
  for (let number = first; number <= last; number += 1) {
    months.set(number, { consumed: 0, discarded: 0 });
  }
  const zones = new Map(input.zones.map((zone) => [zone.id, { consumed: 0, discarded: 0 }]));
  const discardedBy = new Map<string, number>();
  let consumed = 0;
  let discarded = 0;

  for (const pkg of input.packages) {
    if (pkg.removed_at === null || (pkg.removal_reason !== "consumed" && pkg.removal_reason !== "discarded")) {
      continue;
    }
    if (input.since !== null && pkg.removed_at < input.since) {
      continue;
    }
    const month = months.get(monthNumber(monthIn(input.timezone, new Date(pkg.removed_at))));
    if (!month) {
      continue;
    }
    const zone = zones.get(pkg.zone_id);
    if (pkg.removal_reason === "consumed") {
      consumed += 1;
      month.consumed += 1;
      if (zone) {
        zone.consumed += 1;
      }
    } else {
      discarded += 1;
      month.discarded += 1;
      if (zone) {
        zone.discarded += 1;
      }
      discardedBy.set(pkg.product_id, (discardedBy.get(pkg.product_id) ?? 0) + 1);
    }
  }

  const products = new Map(input.products.map((product) => [product.id, product]));
  const top: StatsProduct[] = [...discardedBy].map(([productId, count]) => {
    const product = products.get(productId);
    return { product_id: productId, name: product?.name ?? "", barcode: product?.barcodes[0] ?? null, discarded: count };
  });
  const total = consumed + discarded;
  return {
    start: monthText(first),
    end: monthText(last),
    months: [...months].map(([number, counts]) => ({ month: monthText(number), ...counts })),
    consumed,
    discarded,
    discarded_share: total === 0 ? null : Math.round((discarded / total) * 10_000) / 10_000,
    top_discarded: top.sort(compareTop).slice(0, STATS_TOP_PRODUCTS),
    zones: input.zones.map((zone) => ({ zone_id: zone.id, name: zone.name, ...(zones.get(zone.id) ?? { consumed: 0, discarded: 0 }) })),
    timezone: input.timezone,
  };
}
