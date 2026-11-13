/**
 * Kennungen (Vertrag). Gegenstück im Server: server/stowly/contract/ids.py.
 * Beide Seiten werden gegen docs/vectors.json getestet.
 */
import { PACKAGE_ID_ALPHABET, PACKAGE_ID_LENGTH } from "./api.gen";

const PACKAGE_ID_RE = /^[0-9A-HJKMNP-TV-Z]{5}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Wahr für genau fünf Zeichen des ID-Alphabets in Großschreibung. */
export function isPackageId(value: string): boolean {
  return PACKAGE_ID_RE.test(value);
}

/**
 * Macht aus einer Eingabe von Hand eine Packungs-ID oder null.
 * Leerraum und Bindestriche fallen weg, Kleinbuchstaben werden groß,
 * O wird 0, I und L werden 1. U bleibt ungültig.
 */
export function normalizePackageId(text: string): string | null {
  const cleaned = text
    .replace(/[\s-]/g, "")
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return isPackageId(cleaned) ? cleaned : null;
}

/**
 * Zufällige Packungs-ID. Nur der Rückfall, wenn der ID-Vorrat offline aufgebraucht ist:
 * Im Normalfall kommen IDs aus dem Vorrat, den der Server reserviert hat.
 */
export function randomPackageId(): string {
  const bytes = new Uint8Array(PACKAGE_ID_LENGTH);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const byte of bytes) {
    // 32 Zeichen = 5 Bit: Die unteren 5 Bit eines Bytes sind gleichverteilt.
    id += PACKAGE_ID_ALPHABET[byte & 31];
  }
  return id;
}

/** Wahr für eine UUID in der kanonischen Schreibweise (klein, mit Bindestrichen). */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Neue UUID v4. `crypto.randomUUID` gibt es nur in sicheren Kontexten; über
 * http://<LAN-IP> fällt die Funktion auf `crypto.getRandomValues` zurück.
 */
export function newUuid(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
