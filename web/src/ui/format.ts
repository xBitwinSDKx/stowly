/**
 * Texte, die mehrere Ansichten gleich schreiben: Mengen, Abstände in Tagen, Gründe.
 * Reine Funktionen ohne React.
 */
import type { ExpiryState, RemovalReason } from "@/contract";

/** "1 Packung", "3 Packungen". */
export function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

export function packagesText(count: number): string {
  return plural(count, "Packung", "Packungen");
}

/** Betrag eines Abstands in Worten, im Dativ: "9 Tagen", "etwa 4 Monaten", "etwa 2 Jahren". */
function span(days: number): string {
  if (days < 60) {
    return `${String(days)} Tagen`;
  }
  if (days < 730) {
    return `etwa ${String(Math.round(days / 30.44))} Monaten`;
  }
  return `etwa ${String(Math.round(days / 365.25))} Jahren`;
}

/**
 * Abstand zu heute in Worten: "heute", "morgen", "in 9 Tagen", "in etwa 4 Monaten",
 * "gestern", "vor 3 Tagen".
 * @param days Tage ab heute; negativ = Vergangenheit (`daysUntil`)
 */
export function relativeDays(days: number): string {
  if (days === 0) {
    return "heute";
  }
  if (days === 1) {
    return "morgen";
  }
  if (days === -1) {
    return "gestern";
  }
  return days > 0 ? `in ${span(days)}` : `vor ${span(-days)}`;
}

/**
 * Was eine Warnstufe für eine Packung heißt: "seit 3 Tagen abgelaufen", "läuft heute ab",
 * "läuft in 9 Tagen ab". Für "ok" der bloße Abstand, ohne MHD ein leerer Text.
 */
export function expiryText(state: ExpiryState, days: number | null): string {
  if (days === null || state === "none") {
    return "";
  }
  if (state === "expired") {
    return days === -1 ? "seit gestern abgelaufen" : `seit ${span(-days)} abgelaufen`;
  }
  if (state === "soon") {
    if (days === 0) {
      return "läuft heute ab";
    }
    return days === 1 ? "läuft morgen ab" : `läuft in ${span(days)} ab`;
  }
  return relativeDays(days);
}

/**
 * Wie lange ein Zeitpunkt her ist: "gerade eben", "vor 5 Minuten", "vor 3 Stunden", "vor 2 Tagen".
 * Für „zuletzt gesehen" und „letzter Abgleich"; liegt der Zeitpunkt in der Zukunft
 * (Uhren gehen verschieden), gilt er als "gerade eben".
 * @param timestamp Vertrags-Zeitstempel
 * @param now       jetzt, in Millisekunden
 */
export function timeAgo(timestamp: string, now: number): string {
  const then = Date.parse(timestamp);
  if (Number.isNaN(then)) {
    return "";
  }
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) {
    return "gerade eben";
  }
  if (minutes < 60) {
    return minutes === 1 ? "vor einer Minute" : `vor ${String(minutes)} Minuten`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours === 1 ? "vor einer Stunde" : `vor ${String(hours)} Stunden`;
  }
  const days = Math.floor(hours / 24);
  if (days === 1) {
    return "gestern";
  }
  return `vor ${span(days)}`;
}

const sizeFormat = (digits: number) => new Intl.NumberFormat("de-DE", { maximumFractionDigits: digits });

/** Größe einer Datei: "812 Byte", "52 kB", "1,4 MB" (Dezimalpräfixe, Komma wie im Deutschen). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1000) {
    return `${String(Math.max(0, Math.round(Number.isFinite(bytes) ? bytes : 0)))} Byte`;
  }
  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${sizeFormat(value < 10 ? 1 : 0).format(value)} ${units[unit] ?? ""}`;
}

/** Entnahmegründe, wie sie in Sätzen stehen: „3 Packungen verbraucht". */
export const REMOVAL_REASON_LABELS: Record<RemovalReason, string> = {
  consumed: "verbraucht",
  discarded: "entsorgt",
  mistake: "falsch erfasst",
};

/** Dieselben Gründe als Beschriftung einer Auswahl. */
export const REMOVAL_REASON_OPTIONS: readonly { value: RemovalReason; label: string }[] = [
  { value: "consumed", label: "Verbraucht" },
  { value: "discarded", label: "Entsorgt" },
  { value: "mistake", label: "Falsch erfasst" },
];
