/**
 * Kennungen, QR-Inhalte, Barcodes, Zeit und MHD gegen die gemeinsamen Beispiele.
 * Dieselbe Datei (docs/vectors.json) prüft auch den Server: server/tests/test_vectors.py.
 */
import { describe, expect, it } from "vitest";

import rawVectors from "../../../docs/vectors.json";
import { PACKAGE_ID_ALPHABET, PACKAGE_ID_LENGTH } from "./api.gen";
import { isStoreInternalBarcode, isValidBarcode, normalizeBarcode } from "./barcode";
import { isPackageId, isUuid, newUuid, normalizePackageId, randomPackageId } from "./ids";
import { daysUntil, expiredFrom, expiryState, soonFrom, warnDaysFor, type ExpiryState } from "./mhd";
import { classifyScan, packageQr, parseQr, zoneQr } from "./qr";
import { addDays, isDate, isMonth, isTimeOfDay, isTimestamp, nowTimestamp } from "./time";

interface Vectors {
  package_ids: {
    valid: string[];
    invalid: string[];
    normalize: { input: string; output: string | null }[];
  };
  uuids: {
    valid: string[];
    invalid: string[];
  };
  qr: {
    package: { id: string; text: string }[];
    zone: { id: string; text: string }[];
    parse: { text: string; kind: "package" | "zone" | null; id: string | null }[];
  };
  barcodes: {
    valid: string[];
    invalid: string[];
    normalize: { input: string; output: string | null }[];
    store_internal: { code: string; internal: boolean }[];
  };
  timestamps: {
    valid: string[];
    invalid: string[];
    dates_valid: string[];
    dates_invalid: string[];
    times_of_day_valid: string[];
    times_of_day_invalid: string[];
    months_valid: string[];
    months_invalid: string[];
  };
  mhd: {
    days_until: { best_before: string | null; today: string; days: number | null }[];
    days_until_invalid: { best_before: string; today: string }[];
    expiry_state: { best_before: string | null; warn_days: number; today: string; state: ExpiryState }[];
    warn_days_for: { product: { warn_days: number | null } | null; settings: { warn_days: number }; warn_days: number }[];
    entry: { best_before: string | null; warn_days: number; soon_from: string | null; expired_from: string | null }[];
  };
}

const vectors = rawVectors as unknown as Vectors;

describe("Packungs-IDs", () => {
  it("erkennt gültige und ungültige IDs", () => {
    for (const value of vectors.package_ids.valid) {
      expect(isPackageId(value), value).toBe(true);
    }
    for (const value of vectors.package_ids.invalid) {
      expect(isPackageId(value), value).toBe(false);
    }
  });

  it("bereinigt Eingaben von Hand", () => {
    for (const { input, output } of vectors.package_ids.normalize) {
      expect(normalizePackageId(input), input).toBe(output);
    }
  });

  it("erzeugt Zufalls-IDs aus dem Alphabet", () => {
    expect(PACKAGE_ID_ALPHABET).toHaveLength(32);
    expect(new Set(PACKAGE_ID_ALPHABET).size).toBe(32);
    expect(PACKAGE_ID_ALPHABET).not.toMatch(/[ILOU]/);
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const id = randomPackageId();
      expect(id).toHaveLength(PACKAGE_ID_LENGTH);
      expect(isPackageId(id), id).toBe(true);
      seen.add(id);
    }
    expect(seen.size).toBeGreaterThan(490);
  });

  it("erkennt gültige und ungültige UUIDs", () => {
    for (const value of vectors.uuids.valid) {
      expect(isUuid(value), value).toBe(true);
    }
    for (const value of vectors.uuids.invalid) {
      expect(isUuid(value), JSON.stringify(value)).toBe(false);
    }
  });

  it("erzeugt UUIDs in kanonischer Schreibweise", () => {
    const id = newUuid();
    expect(isUuid(id)).toBe(true);
    expect(isUuid(id.toUpperCase())).toBe(false);
    expect(id[14]).toBe("4");
  });
});

describe("QR-Inhalte", () => {
  it("baut und liest Packungs-Etiketten", () => {
    for (const { id, text } of vectors.qr.package) {
      expect(packageQr(id)).toBe(text);
      expect(parseQr(text)).toEqual({ kind: "package", id });
      expect(classifyScan(text, "qr_code")).toEqual({ kind: "package", package_id: id });
    }
  });

  it("baut und liest Zonen-Etiketten", () => {
    for (const { id, text } of vectors.qr.zone) {
      expect(zoneQr(id)).toBe(text);
      expect(parseQr(text)).toEqual({ kind: "zone", id });
      expect(classifyScan(text, "qr_code")).toEqual({ kind: "zone", zone_id: id });
    }
  });

  it("weist alles andere zurück", () => {
    for (const { text, kind, id } of vectors.qr.parse) {
      expect(parseQr(text), JSON.stringify(text)).toEqual(kind === null ? null : { kind, id });
    }
  });

  it("lehnt ungültige Kennungen beim Bauen ab", () => {
    expect(() => packageQr("A2B3U")).toThrow();
    expect(() => zoneQr("keine-uuid")).toThrow();
  });
});

describe("Barcodes", () => {
  it("prüft die Prüfziffer", () => {
    for (const value of vectors.barcodes.valid) {
      expect(isValidBarcode(value), value).toBe(true);
    }
    for (const value of vectors.barcodes.invalid) {
      expect(isValidBarcode(value), value).toBe(false);
    }
  });

  it("bringt gelesene Codes in die gespeicherte Form", () => {
    for (const { input, output } of vectors.barcodes.normalize) {
      expect(normalizeBarcode(input), input).toBe(output);
    }
  });

  it("erkennt ladeninterne Codes", () => {
    for (const { code, internal } of vectors.barcodes.store_internal) {
      expect(isStoreInternalBarcode(code), code).toBe(internal);
    }
  });
});

describe("Zeit", () => {
  it("erkennt Vertrags-Zeitstempel", () => {
    for (const value of vectors.timestamps.valid) {
      expect(isTimestamp(value), value).toBe(true);
    }
    for (const value of vectors.timestamps.invalid) {
      expect(isTimestamp(value), value).toBe(false);
    }
    expect(isTimestamp(nowTimestamp())).toBe(true);
  });

  it("erkennt Kalenderdaten", () => {
    for (const value of vectors.timestamps.dates_valid) {
      expect(isDate(value), value).toBe(true);
    }
    for (const value of vectors.timestamps.dates_invalid) {
      expect(isDate(value), value).toBe(false);
    }
  });

  it("erkennt Uhrzeiten und Monate", () => {
    for (const value of vectors.timestamps.times_of_day_valid) {
      expect(isTimeOfDay(value), value).toBe(true);
    }
    for (const value of vectors.timestamps.times_of_day_invalid) {
      expect(isTimeOfDay(value), JSON.stringify(value)).toBe(false);
    }
    for (const value of vectors.timestamps.months_valid) {
      expect(isMonth(value), value).toBe(true);
    }
    for (const value of vectors.timestamps.months_invalid) {
      expect(isMonth(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe("MHD", () => {
  it("zählt Tage bis zum MHD", () => {
    for (const { best_before, today, days } of vectors.mhd.days_until) {
      expect(daysUntil(best_before, today), `${best_before} / ${today}`).toBe(days);
    }
    for (const { best_before, today } of vectors.mhd.days_until_invalid) {
      expect(() => daysUntil(best_before, today), `${best_before} / ${JSON.stringify(today)}`).toThrow();
    }
  });

  it("stuft nach der Regel des Vertrags ein", () => {
    for (const { best_before, warn_days, today, state } of vectors.mhd.expiry_state) {
      expect(expiryState(best_before, warn_days, today), `${best_before} / ${warn_days} / ${today}`).toBe(state);
    }
  });

  it("nimmt die Vorlaufzeit des Produkts, sonst die des Haushalts", () => {
    for (const { product, settings, warn_days } of vectors.mhd.warn_days_for) {
      expect(warnDaysFor(product, settings), JSON.stringify(product)).toBe(warn_days);
    }
  });

  it("nennt den Eintritt in „bald“ und „abgelaufen“ passend zur Warnstufe", () => {
    for (const { best_before, warn_days, soon_from, expired_from } of vectors.mhd.entry) {
      const soon = soonFrom(best_before, warn_days);
      const expired = expiredFrom(best_before);
      expect([soon, expired], `${best_before} / ${warn_days}`).toEqual([soon_from, expired_from]);
      if (best_before === null || soon === null) {
        continue;
      }
      expect(expiryState(best_before, warn_days, soon)).toBe("soon");
      if (soon !== "0001-01-01") {
        expect(expiryState(best_before, warn_days, addDays(soon, -1))).toBe("ok");
      }
      if (expired !== null) {
        expect(expiryState(best_before, warn_days, expired)).toBe("expired");
        expect(expiryState(best_before, warn_days, best_before)).toBe("soon");
      }
    }
  });
});
