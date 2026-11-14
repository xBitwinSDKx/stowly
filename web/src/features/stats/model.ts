/**
 * Die Statistik ohne React: Monate benennen, Zeiträume bilden, Achsen runden, Sätze für Screenreader.
 *
 * Gerechnet hat der Server (docs/sync-protokoll.md, 11.1); hier wird nur angezeigt. Die Monate gelten
 * in seiner Zeitzone (`Stats.timezone`).
 */
import { isMonth, productTitle, STATS_DEFAULT_MONTHS, STATS_MAX_MONTHS, toLocalDate, type Stats, type StatsProduct, type StatsRange } from "@/contract";
import { plural } from "@/ui/format";

/** Die Zeiträume zur Wahl, in Monaten bis einschließlich des laufenden. Der erste ist die Vorgabe des Servers. */
export const PERIODS: readonly number[] = [STATS_DEFAULT_MONTHS, 2 * STATS_DEFAULT_MONTHS].filter((months) => months <= STATS_MAX_MONTHS);

const MONTH_NAMES = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const MONTH_SHORT = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

/** Jahr und Monat (1 bis 12) aus "YYYY-MM". */
function parts(month: string): [number, number] {
  return [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
}

/** "2026-11" -> "November 2026". */
export function monthName(month: string): string {
  const [year, index] = parts(month);
  return `${MONTH_NAMES[index - 1] ?? month} ${String(year)}`;
}

/** "2026-11" -> "Nov": die Beschriftung unter der Säule. */
export function monthShort(month: string): string {
  return MONTH_SHORT[parts(month)[1] - 1] ?? month;
}

/** Verschiebt einen Monat "YYYY-MM" um ganze Monate, auch über Jahresgrenzen. */
export function shiftMonth(month: string, offset: number): string {
  const [year, index] = parts(month);
  const total = year * 12 + (index - 1) + offset;
  return `${String(Math.floor(total / 12)).padStart(4, "0")}-${String((total % 12) + 1).padStart(2, "0")}`;
}

/**
 * Der laufende Monat in einer Zeitzone, "YYYY-MM". Ohne Zeitzone, oder wenn der Browser sie nicht
 * kennt: der Monat in der Zeitzone des Geräts.
 */
export function currentMonth(timeZone: string | null, now: Date = new Date()): string {
  if (timeZone) {
    try {
      const fields = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(now);
      const year = fields.find((field) => field.type === "year")?.value ?? "";
      const month = fields.find((field) => field.type === "month")?.value ?? "";
      const text = `${year.padStart(4, "0")}-${month}`;
      if (isMonth(text)) {
        return text;
      }
    } catch {
      // Unbekannte Zeitzone: dann die des Geräts.
    }
  }
  return toLocalDate(now).slice(0, 7);
}

/**
 * Der Zeitraum für `core.stats.load`. Für die Vorgabe (12 Monate) keiner: Dann rechnet der Server bis
 * zu seinem laufenden Monat. Für einen längeren Zeitraum endet er mit dem laufenden Monat in der
 * Zeitzone des Servers, soweit bekannt.
 * @param timeZone Zeitzone des Servers aus der letzten Antwort (`Stats.timezone`) oder null
 */
export function statsRange(months: number, timeZone: string | null, now: Date = new Date()): StatsRange | undefined {
  if (months === STATS_DEFAULT_MONTHS) {
    return undefined;
  }
  const end = currentMonth(timeZone, now);
  return { start: shiftMonth(end, -(Math.min(months, STATS_MAX_MONTHS) - 1)), end };
}

/** Der Zeitraum einer Antwort in Worten: „Dezember 2025 bis November 2026". */
export function periodText(stats: Pick<Stats, "start" | "end">): string {
  return stats.start === stats.end ? monthName(stats.end) : `${monthName(stats.start)} bis ${monthName(stats.end)}`;
}

/** Nichts entnommen im Zeitraum (`discarded_share` ist dann null): Die Ansicht zeigt einen Leerzustand. */
export function isEmpty(stats: Pick<Stats, "consumed" | "discarded" | "discarded_share">): boolean {
  return stats.discarded_share === null || stats.consumed + stats.discarded === 0;
}

const PERCENT = new Intl.NumberFormat("de-DE", { style: "percent", maximumFractionDigits: 1 });

/** Ein Anteil von 0 bis 1 als „8,9 %"; null (nichts entnommen) als „–". */
export function shareText(share: number | null): string {
  return share === null ? "–" : PERCENT.format(share);
}

/** Anteil des Entsorgten an verbraucht + entsorgt, wie `Stats.discarded_share`; null bei 0 + 0. */
export function shareOf(counts: { consumed: number; discarded: number }): number | null {
  const total = counts.consumed + counts.discarded;
  return total === 0 ? null : counts.discarded / total;
}

/** Wie ein häufig entsorgtes Produkt heißt: sein Name, bei Platzhaltern der Barcode. */
export function statsProductTitle(product: Pick<StatsProduct, "name" | "barcode">): string {
  return productTitle({ name: product.name, barcodes: product.barcode === null ? [] : [product.barcode] });
}

/** Die Achse eines Säulendiagramms: ein runder Höchstwert und die Striche dazwischen. */
export interface Axis {
  top: number;
  ticks: number[];
}

/**
 * Runde Schritte für Stückzahlen: 17 wird zu 0, 5, 10, 15, 20; 3 zu 0, 1, 2, 3. Schritte sind ganze
 * Zahlen (1, 2, 5, 10, 20, 50 …), höchstens etwa `count` Abschnitte.
 */
export function axisFor(max: number, count = 4): Axis {
  if (!Number.isFinite(max) || max <= 0) {
    return { top: 1, ticks: [0, 1] };
  }
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = Math.max(1, nice * magnitude);
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= top; value += step) {
    ticks.push(value);
  }
  return { top, ticks };
}

/** Mögliche Abstände der Beschriftungen in Monaten: Teiler von 12, damit der Januar immer dabei ist. */
const LABEL_STEPS = [1, 2, 3, 4, 6, 12];

/** Jeder wievielte Monat eine Beschriftung bekommt, damit sie bei `slot` Pixeln je Monat nicht überlappen. */
export function labelStep(slot: number, labelWidth = 30): number {
  return LABEL_STEPS.find((step) => step * slot >= labelWidth) ?? 12;
}

/** Was unter einer Säule steht: der Monat und, beim Januar und beim ersten beschrifteten Monat, das Jahr. */
export interface MonthLabel {
  month: string | null;
  year: string | null;
}

export function monthLabels(months: readonly string[], step: number): MonthLabel[] {
  let yearShown = false;
  return months.map((month) => {
    const index = parts(month)[1] - 1;
    if (index % step !== 0) {
      return { month: null, year: null };
    }
    const year = !yearShown || index === 0 ? month.slice(0, 4) : null;
    yearShown = true;
    return { month: monthShort(month), year };
  });
}

/** Der Monat mit dem höchsten Wert (bei Gleichstand der frühere); null, wenn alle 0 sind. */
function peak(stats: Pick<Stats, "months">, key: "consumed" | "discarded"): { month: string; value: number } | null {
  let best: { month: string; value: number } | null = null;
  for (const entry of stats.months) {
    if (entry[key] > 0 && (best === null || entry[key] > best.value)) {
      best = { month: entry.month, value: entry[key] };
    }
  }
  return best;
}

/**
 * Was das Säulendiagramm zeigt, in Sätzen: für Screenreader (`role="img"`), die die Säulen nicht sehen.
 * Die Zahlen je Monat stehen außerdem in der Tabelle unter dem Diagramm.
 */
export function chartSummary(stats: Pick<Stats, "start" | "end" | "months" | "consumed" | "discarded">): string {
  const most = peak(stats, "consumed");
  const worst = peak(stats, "discarded");
  const sentences = [
    `Säulen je Monat, ${periodText(stats)}: ${plural(stats.consumed, "Packung", "Packungen")} verbraucht, ${String(stats.discarded)} entsorgt.`,
    most ? `Am meisten verbraucht im ${monthName(most.month)} (${String(most.value)}).` : "Verbraucht wurde nichts.",
    worst ? `Am meisten entsorgt im ${monthName(worst.month)} (${String(worst.value)}).` : "Entsorgt wurde nichts.",
    "Die Zahlen je Monat stehen in der Tabelle darunter.",
  ];
  return sentences.join(" ");
}
