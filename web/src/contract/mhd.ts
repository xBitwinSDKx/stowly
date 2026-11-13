/**
 * Mindesthaltbarkeitsdatum: schnelle Eingabe und Warnstufen.
 *
 * Eine gemeinsame Auslegung für alle Ansichten (Scannen, Bearbeiten, Warnungen),
 * damit dieselbe Eingabe überall dasselbe Datum ergibt.
 */
import { daysBetween, isDate, lastDayOfMonth, makeDate } from "./time";

export interface ParsedBestBefore {
  /** Das Datum als "YYYY-MM-DD". Bei Monatsangaben der letzte Tag des Monats. */
  date: string;
  /** "month", wenn nur Monat und Jahr eingegeben wurden. */
  precision: "day" | "month";
}

const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

function fullYear(text: string): number | null {
  if (!/^\d+$/.test(text)) {
    return null;
  }
  if (text.length === 4) {
    return Number(text);
  }
  if (text.length === 2) {
    return 2000 + Number(text);
  }
  return null;
}

function inRange(year: number): boolean {
  return year >= MIN_YEAR && year <= MAX_YEAR;
}

function dayResult(year: number, month: number, day: number): ParsedBestBefore | null {
  if (!inRange(year)) {
    return null;
  }
  const date = makeDate(year, month, day);
  return date ? { date, precision: "day" } : null;
}

function monthResult(year: number, month: number): ParsedBestBefore | null {
  if (!inRange(year) || month < 1 || month > 12) {
    return null;
  }
  return { date: lastDayOfMonth(year, month), precision: "month" };
}

/** Tag und Monat ohne Jahr: das nächste Vorkommen ab heute (auch der 29.02. findet sein Schaltjahr). */
function nextOccurrence(day: number, month: number, today: string): ParsedBestBefore | null {
  const startYear = Number(today.slice(0, 4));
  for (let year = startYear; year <= startYear + 8; year += 1) {
    const date = makeDate(year, month, day);
    if (date && date >= today) {
      return { date, precision: "day" };
    }
  }
  return null;
}

/**
 * Zwei zweistellige Zahlen ohne Jahr sind entweder Tag.Monat oder Monat.Jahr.
 * Ist die zweite Zahl ein Monat (1-12), gilt Tag.Monat; sonst Monat.Jahr.
 * Bis zum Jahr 2100 ist das eindeutig, weil kein zweistelliges Jahr ab 2013 ein Monat ist.
 */
function twoNumbers(first: string, second: string, today: string): ParsedBestBefore | null {
  const a = Number(first);
  const b = Number(second);
  if (b >= 1 && b <= 12) {
    return nextOccurrence(a, b, today);
  }
  if (second.length === 2 && a >= 1 && a <= 12) {
    return monthResult(2000 + b, a);
  }
  return null;
}

/**
 * Liest ein von Hand eingegebenes MHD.
 *
 * Verstanden werden (Trenner: Punkt, Schrägstrich, Bindestrich oder Leerzeichen):
 *
 *   25.03.2027, 25.03.27, 25032027, 250327   Tag, Monat, Jahr
 *   25.03., 25.3, 2503                       Tag und Monat: das nächste Vorkommen ab heute
 *   03.2027, 03/27, 0327, 032027             Monat und Jahr: der letzte Tag des Monats
 *   2027-03-25, 2027-03                      ISO-Schreibweise
 *
 * Text vor der ersten Ziffer ("MHD", "Ende") wird übersprungen.
 *
 * @param input Eingabe des Anwenders
 * @param today heutiges Datum "YYYY-MM-DD" (todayLocal())
 * @returns das Datum oder null, wenn die Eingabe kein Datum ergibt
 */
export function parseBestBefore(input: string, today: string): ParsedBestBefore | null {
  if (!isDate(today)) {
    throw new Error(`Kein gültiges Datum: ${today}`);
  }
  const text = input
    .trim()
    .replace(/^[^\d]+/, "")
    .replace(/[^\d]+$/, "");
  if (text === "") {
    return null;
  }

  const iso = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(text);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    return iso[3] === undefined ? monthResult(year, month) : dayResult(year, month, Number(iso[3]));
  }

  const tokens = text.split(/[.\/\-\s]+/);
  if (tokens.some((token) => !/^\d+$/.test(token))) {
    return null;
  }

  if (tokens.length === 3) {
    const [day, month, yearText] = tokens as [string, string, string];
    const year = fullYear(yearText);
    if (year === null || day.length > 2 || month.length > 2) {
      return null;
    }
    return dayResult(year, Number(month), Number(day));
  }

  if (tokens.length === 2) {
    const [first, second] = tokens as [string, string];
    if (first.length > 2) {
      return null;
    }
    if (second.length === 4) {
      return monthResult(Number(second), Number(first));
    }
    if (second.length > 2) {
      return null;
    }
    return twoNumbers(first, second, today);
  }

  if (tokens.length === 1) {
    const digits = tokens[0] as string;
    if (digits.length === 8) {
      return dayResult(Number(digits.slice(4)), Number(digits.slice(2, 4)), Number(digits.slice(0, 2)));
    }
    if (digits.length === 6) {
      // TTMMJJ; passt das nicht, MMJJJJ. Beides zugleich geht nicht: Ein Jahr 20xx wäre als Monat ungültig.
      return (
        dayResult(2000 + Number(digits.slice(4)), Number(digits.slice(2, 4)), Number(digits.slice(0, 2))) ??
        monthResult(Number(digits.slice(2)), Number(digits.slice(0, 2)))
      );
    }
    if (digits.length === 4) {
      return twoNumbers(digits.slice(0, 2), digits.slice(2), today);
    }
  }
  return null;
}

/** Warnstufe einer Packung. */
export type ExpiryState =
  /** kein MHD */
  | "none"
  /** noch länger haltbar als die Vorlaufzeit */
  | "ok"
  /** läuft heute oder innerhalb der Vorlaufzeit ab */
  | "soon"
  /** MHD liegt vor heute */
  | "expired";

/** Tage bis zum MHD: 0 = heute, negativ = abgelaufen, null = kein MHD. */
export function daysUntil(bestBefore: string | null, today: string): number | null {
  return bestBefore === null ? null : daysBetween(today, bestBefore);
}

/**
 * Warnstufe nach der Regel des Vertrags:
 * abgelaufen, wenn das MHD vor heute liegt; „läuft bald ab", wenn es in 0 bis `warnDays` Tagen erreicht ist.
 */
export function expiryState(bestBefore: string | null, warnDays: number, today: string): ExpiryState {
  const days = daysUntil(bestBefore, today);
  if (days === null) {
    return "none";
  }
  if (days < 0) {
    return "expired";
  }
  return days <= warnDays ? "soon" : "ok";
}

/** Vorlaufzeit für ein Produkt: der eigene Wert, sonst der des Haushalts. */
export function warnDaysFor(product: { warn_days: number | null } | undefined, settings: { warn_days: number }): number {
  return product?.warn_days ?? settings.warn_days;
}
