/**
 * Zeitstempel und Datumsangaben (Vertrag, docs/sync-protokoll.md, „Umgang mit Zeit").
 *
 * Zeitstempel: immer UTC, ISO 8601, genau drei Nachkommastellen und "Z" - das Format
 *              von `new Date().toISOString()`. Als Text vergleich- und sortierbar.
 * Datum (MHD): "YYYY-MM-DD", ein Kalendertag ohne Uhrzeit und ohne Zeitzone.
 *              "Heute" ist immer der Kalendertag in der Zeitzone des Geräts.
 *
 * Gültig sind die Jahre 0001 bis 9999, wie im Server (server/stowly/contract/timeutil.py):
 * Dessen Kalender kennt kein Jahr 0000. Ziffern sind immer 0 bis 9.
 */

const TIMESTAMP_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const DATE_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
/** Uhrzeit ohne Datum, wie TIME_OF_DAY_PATTERN in server/stowly/contract/timeutil.py. */
const TIME_OF_DAY_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
/** Kalendermonat "YYYY-MM", wie MONTH_PATTERN im Server. */
const MONTH_RE = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const DAY_MS = 86_400_000;

/**
 * Mitternacht (UTC) eines Kalendertags in Millisekunden. Tag und Monat dürfen überlaufen
 * (Tag 0 ist der letzte des Vormonats). Nicht `Date.UTC`: Das deutet die Jahre 0 bis 99
 * als 1900 bis 1999.
 */
function utcDay(year: number, month: number, day: number): number {
  const moment = new Date(0);
  moment.setUTCFullYear(year, month - 1, day);
  return moment.getTime();
}

/** Aktuelle Geräteuhr als Vertrags-Zeitstempel. */
export function nowTimestamp(now: Date = new Date()): string {
  return now.toISOString();
}

export function isTimestamp(text: string): boolean {
  if (!TIMESTAMP_RE.test(text) || text.startsWith("0000")) {
    return false;
  }
  const ms = Date.parse(text);
  // Der Vergleich fängt Tage ab, die manche Browser stillschweigend weiterrollen (30. Februar).
  return !Number.isNaN(ms) && new Date(ms).toISOString() === text;
}

function parts(text: string): [number, number, number] | null {
  const match = DATE_RE.exec(text);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(utcDay(year, month, day));
  if (year < 1 || probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  return [year, month, day];
}

/** Wahr für ein existierendes Kalenderdatum "YYYY-MM-DD". */
export function isDate(text: string): boolean {
  return parts(text) !== null;
}

/**
 * Wahr für eine Uhrzeit "HH:MM" von "00:00" bis "23:59", zweistellig geschrieben (Einstellung
 * `notify_time`). Sie gilt in der Zeitzone des Servers, nicht in der des Geräts.
 */
export function isTimeOfDay(text: string): boolean {
  return typeof text === "string" && TIME_OF_DAY_RE.test(text);
}

/** Wahr für einen Kalendermonat "YYYY-MM" der Jahre 0001 bis 9999 (Zeitraum der Statistik). */
export function isMonth(text: string): boolean {
  return typeof text === "string" && MONTH_RE.test(text) && !text.startsWith("0000");
}

/** Baut "YYYY-MM-DD" aus Jahr, Monat (1-12) und Tag; null, wenn es den Tag nicht gibt. */
export function makeDate(year: number, month: number, day: number): string | null {
  const text = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isDate(text) ? text : null;
}

/** Kalendertag eines Zeitpunkts in der Zeitzone des Geräts. */
export function toLocalDate(moment: Date): string {
  const year = moment.getFullYear();
  const month = moment.getMonth() + 1;
  const day = moment.getDate();
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Heute als "YYYY-MM-DD" in der Zeitzone des Geräts. */
export function todayLocal(now: Date = new Date()): string {
  return toLocalDate(now);
}

/** Ganze Kalendertage von `from` bis `to`; negativ, wenn `to` früher liegt. */
export function daysBetween(from: string, to: string): number {
  const a = parts(from);
  const b = parts(to);
  if (!a || !b) {
    throw new Error(`Kein gültiges Datum: ${!a ? from : to}`);
  }
  return Math.round((utcDay(b[0], b[1], b[2]) - utcDay(a[0], a[1], a[2])) / DAY_MS);
}

/** Verschiebt ein Datum um ganze Tage. */
export function addDays(date: string, days: number): string {
  const p = parts(date);
  if (!p) {
    throw new Error(`Kein gültiges Datum: ${date}`);
  }
  const moved = new Date(utcDay(p[0], p[1], p[2] + days));
  return `${String(moved.getUTCFullYear()).padStart(4, "0")}-${String(moved.getUTCMonth() + 1).padStart(2, "0")}-${String(moved.getUTCDate()).padStart(2, "0")}`;
}

/** Letzter Tag eines Monats (1-12) als "YYYY-MM-DD". */
export function lastDayOfMonth(year: number, month: number): string {
  const last = new Date(utcDay(year, month + 1, 0));
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(last.getUTCDate()).padStart(2, "0")}`;
}

/** "2027-03-25" -> "25.03.2027". Ungültiges kommt unverändert zurück. */
export function formatDate(date: string): string {
  const p = parts(date);
  if (!p) {
    return date;
  }
  return `${String(p[2]).padStart(2, "0")}.${String(p[1]).padStart(2, "0")}.${String(p[0]).padStart(4, "0")}`;
}

/** Zeitstempel für die Anzeige in der Zeitzone des Geräts: "13.11.2026, 11:15". */
export function formatTimestamp(timestamp: string): string {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) {
    return timestamp;
  }
  const moment = new Date(ms);
  const time = `${String(moment.getHours()).padStart(2, "0")}:${String(moment.getMinutes()).padStart(2, "0")}`;
  return `${formatDate(toLocalDate(moment))}, ${time}`;
}
