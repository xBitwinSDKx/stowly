/**
 * Zeitstempel und Datumsangaben (Vertrag, docs/sync-protokoll.md, „Umgang mit Zeit").
 *
 * Zeitstempel: immer UTC, ISO 8601, genau drei Nachkommastellen und "Z" - das Format
 *              von `new Date().toISOString()`. Als Text vergleich- und sortierbar.
 * Datum (MHD): "YYYY-MM-DD", ein Kalendertag ohne Uhrzeit und ohne Zeitzone.
 *              "Heute" ist immer der Kalendertag in der Zeitzone des Geräts.
 */

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** Aktuelle Geräteuhr als Vertrags-Zeitstempel. */
export function nowTimestamp(now: Date = new Date()): string {
  return now.toISOString();
}

export function isTimestamp(text: string): boolean {
  if (!TIMESTAMP_RE.test(text)) {
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
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  return [year, month, day];
}

/** Wahr für ein existierendes Kalenderdatum "YYYY-MM-DD". */
export function isDate(text: string): boolean {
  return parts(text) !== null;
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
  return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / DAY_MS);
}

/** Verschiebt ein Datum um ganze Tage. */
export function addDays(date: string, days: number): string {
  const p = parts(date);
  if (!p) {
    throw new Error(`Kein gültiges Datum: ${date}`);
  }
  const moved = new Date(Date.UTC(p[0], p[1] - 1, p[2] + days));
  return `${String(moved.getUTCFullYear()).padStart(4, "0")}-${String(moved.getUTCMonth() + 1).padStart(2, "0")}-${String(moved.getUTCDate()).padStart(2, "0")}`;
}

/** Letzter Tag eines Monats (1-12) als "YYYY-MM-DD". */
export function lastDayOfMonth(year: number, month: number): string {
  const last = new Date(Date.UTC(year, month, 0));
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
