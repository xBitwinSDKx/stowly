/**
 * Kalendertag und Monat in der Zeitzone des Servers (STOWLY_TIMEZONE), über `Intl`.
 *
 * Die Tests nehmen „heute" und den laufenden Monat aus den Antworten des Servers (`updated_at`
 * des Sensors, `end` der Statistik) und rechnen Zeitpunkte damit um: So wackelt nichts, wenn ein
 * Test über Mitternacht läuft.
 */

function parts(timezone: string, moment: Date | string): Record<"year" | "month" | "day", string> {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const found = formatter.formatToParts(typeof moment === "string" ? new Date(moment) : moment);
  const part = (type: Intl.DateTimeFormatPartTypes) => found.find((entry) => entry.type === type)?.value ?? "";
  return { year: part("year").padStart(4, "0"), month: part("month"), day: part("day") };
}

/** Kalendertag eines Zeitpunkts in der Zeitzone, "YYYY-MM-DD". */
export function dayIn(timezone: string, moment: Date | string): string {
  const { year, month, day } = parts(timezone, moment);
  return `${year}-${month}-${day}`;
}

/** Kalendermonat eines Zeitpunkts in der Zeitzone, "YYYY-MM". */
export function monthIn(timezone: string, moment: Date | string): string {
  const { year, month } = parts(timezone, moment);
  return `${year}-${month}`;
}

/** Alle Monate von `start` bis `end` ("YYYY-MM"), beide eingeschlossen, aufsteigend. */
export function monthsFrom(start: string, end: string): string[] {
  const index = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
  const result: string[] = [];
  for (let current = index(start); current <= index(end); current += 1) {
    result.push(`${String(Math.floor(current / 12)).padStart(4, "0")}-${String((current % 12) + 1).padStart(2, "0")}`);
  }
  return result;
}

/** Ein Monat `n` Monate vor oder nach `month` ("YYYY-MM"). */
export function shiftMonth(month: string, n: number): string {
  const current = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + n;
  return `${String(Math.floor(current / 12)).padStart(4, "0")}-${String((current % 12) + 1).padStart(2, "0")}`;
}
