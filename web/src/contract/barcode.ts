/**
 * Produkt-Barcodes (Vertrag). Gegenstück im Server: server/stowly/contract/ids.py.
 * Gespeichert werden nur EAN-13 und EAN-8 mit stimmender Prüfziffer.
 */

// Dasselbe Muster wie BARCODE_PATTERN im Server: Ziffern sind 0 bis 9, nichts sonst.
const BARCODE_RE = /^([0-9]{8}|[0-9]{13})$/;
const DIGITS_RE = /^[0-9]+$/;

/** Prüfziffer nach GS1 für die Ziffern ohne Prüfziffer (7 oder 12 Stellen). */
export function gtinCheckDigit(body: string): number {
  let total = 0;
  for (let position = 0; position < body.length; position += 1) {
    const digit = body.charCodeAt(body.length - 1 - position) - 48;
    total += digit * (position % 2 === 0 ? 3 : 1);
  }
  return (10 - (total % 10)) % 10;
}

/** Wahr für EAN-8 und EAN-13 mit stimmender Prüfziffer. */
export function isValidBarcode(code: string): boolean {
  if (!BARCODE_RE.test(code)) {
    return false;
  }
  return gtinCheckDigit(code.slice(0, -1)) === code.charCodeAt(code.length - 1) - 48;
}

/**
 * Bringt einen gelesenen Produkt-Barcode in die gespeicherte Form.
 * EAN-13 und EAN-8 bleiben, UPC-A (12 Stellen) bekommt eine führende Null.
 * null bei falscher Länge, fremden Zeichen oder falscher Prüfziffer.
 */
export function normalizeBarcode(raw: string): string | null {
  let digits = raw.trim();
  if (!DIGITS_RE.test(digits)) {
    return null;
  }
  if (digits.length === 12) {
    digits = `0${digits}`;
  }
  return isValidBarcode(digits) ? digits : null;
}

/** Ladeninterne Codes (Präfix 2) sind nicht eindeutig und werden nie nachgeschlagen. */
export function isStoreInternalBarcode(code: string): boolean {
  return code.startsWith("2");
}

/**
 * Schlägt der Server diesen Barcode bei Open Food Facts nach, wenn daraus ein Produkt entsteht?
 * `lookupEnabled` ist `SyncStatus.lookup_enabled`: Nur ein ausdrückliches `false` schaltet ab;
 * `null` (noch unbekannt) gilt als eingeschaltet. Dieselbe Regel entscheidet, ob ein neues
 * Produkt lokal mit `lookup: "pending"` oder `"none"` beginnt und ob die Oberfläche verspricht,
 * dass Name und Bild nachkommen.
 */
export function willLookUp(barcode: string, lookupEnabled: boolean | null): boolean {
  return lookupEnabled !== false && !isStoreInternalBarcode(barcode);
}
