/** Scan-Auswertung, MHD-Eingabe, Warnstufen und Etikett-Daten. */
import { describe, expect, it } from "vitest";

import type { Package, Product, Zone } from "./api.gen";
import { isPlaceholder, packageLabelData, productSubtitle, productTitle, zoneLabelData } from "./labels";
import { daysUntil, expiryState, parseBestBefore, warnDaysFor } from "./mhd";
import { classifyScan, PRODUCT_BARCODE_FORMATS, SCAN_FORMATS } from "./qr";
import { addDays, daysBetween, formatDate, lastDayOfMonth, makeDate, toLocalDate } from "./time";

describe("classifyScan", () => {
  it("erkennt Produkt-Barcodes in allen drei Formaten", () => {
    expect(classifyScan("4006381333931", "ean_13")).toEqual({ kind: "product", barcode: "4006381333931" });
    expect(classifyScan("96385074", "ean_8")).toEqual({ kind: "product", barcode: "96385074" });
    // UPC-A wird als EAN-13 mit führender Null gespeichert, egal wie der Detektor ihn meldet.
    expect(classifyScan("036000291452", "upc_a")).toEqual({ kind: "product", barcode: "0036000291452" });
    expect(classifyScan("0036000291452", "ean_13")).toEqual({ kind: "product", barcode: "0036000291452" });
  });

  it("verwirft Lesefehler und fremde Formate", () => {
    expect(classifyScan("4006381333932", "ean_13").kind).toBe("unknown");
    expect(classifyScan("4006381333931", "code_128").kind).toBe("unknown");
    expect(classifyScan("96385074", "upc_e").kind).toBe("unknown");
  });

  it("hält QR-Codes und Strichcodes auseinander", () => {
    // Ein QR-Code, der zufällig wie eine EAN aussieht, ist kein Produkt-Barcode ...
    expect(classifyScan("4006381333931", "qr_code")).toEqual({ kind: "unknown", raw: "4006381333931", format: "qr_code" });
    // ... und ein Strichcode nie ein Etikett.
    expect(classifyScan("STOWLY/P/A2B3C", "code_128").kind).toBe("unknown");
    expect(classifyScan("https://example.org/", "qr_code").kind).toBe("unknown");
  });

  it("nennt die Formate für den BarcodeDetector", () => {
    expect(PRODUCT_BARCODE_FORMATS).toEqual(["ean_13", "ean_8", "upc_a"]);
    expect(SCAN_FORMATS).toEqual(["qr_code", "ean_13", "ean_8", "upc_a"]);
  });
});

describe("parseBestBefore", () => {
  const today = "2026-11-13";
  const day = (date: string) => ({ date, precision: "day" });
  const month = (date: string) => ({ date, precision: "month" });

  it.each([
    ["25.03.2027", day("2027-03-25")],
    ["25.3.27", day("2027-03-25")],
    ["25/03/2027", day("2027-03-25")],
    ["25-03-2027", day("2027-03-25")],
    ["25 03 2027", day("2027-03-25")],
    ["25032027", day("2027-03-25")],
    ["250327", day("2027-03-25")],
    ["2027-03-25", day("2027-03-25")],
    ["MHD 25.03.2027", day("2027-03-25")],
    ["29.02.2028", day("2028-02-29")],
  ])("liest %s als Tag", (input, expected) => {
    expect(parseBestBefore(input, today)).toEqual(expected);
  });

  it.each([
    ["03.2027", month("2027-03-31")],
    ["3/2027", month("2027-03-31")],
    ["03/27", month("2027-03-31")],
    ["03.27", month("2027-03-31")],
    ["0327", month("2027-03-31")],
    ["032027", month("2027-03-31")],
    ["2027-03", month("2027-03-31")],
    ["Ende 02/2028", month("2028-02-29")],
    ["02.27", month("2027-02-28")],
    ["12 26", month("2026-12-31")],
  ])("liest %s als Monat und nimmt dessen letzten Tag", (input, expected) => {
    expect(parseBestBefore(input, today)).toEqual(expected);
  });

  it.each([
    ["25.03.", day("2027-03-25")], // dieses Jahr schon vorbei
    ["25.3", day("2027-03-25")],
    ["2503", day("2027-03-25")],
    ["13.11.", day("2026-11-13")], // heute zählt noch
    ["14.11", day("2026-11-14")],
    ["12.11.", day("2027-11-12")], // gestern: nächstes Jahr
    ["24.12.", day("2026-12-24")],
    ["0312", day("2026-12-03")], // Tag.Monat, nicht März 2012
    ["29.02.", day("2028-02-29")], // das nächste Schaltjahr
  ])("ergänzt bei %s das Jahr des nächsten Vorkommens", (input, expected) => {
    expect(parseBestBefore(input, today)).toEqual(expected);
  });

  it.each(["", "   ", "abc", "31.02.2027", "32.01.2027", "00.03.2027", "25.13.2027", "13.27", "1", "12", "253", "25.03.1999", "25.03.2101", "1.2.3.4", "2027-13", "25.03.207"])(
    "weist %j zurück",
    (input) => {
      expect(parseBestBefore(input, today)).toBeNull();
    },
  );

  it("verlangt ein gültiges Heute", () => {
    expect(() => parseBestBefore("25.03.", "heute")).toThrow();
  });
});

describe("Warnstufen", () => {
  const today = "2026-11-13";

  it("zählt Kalendertage bis zum MHD", () => {
    expect(daysUntil(null, today)).toBeNull();
    expect(daysUntil("2026-11-13", today)).toBe(0);
    expect(daysUntil("2026-11-20", today)).toBe(7);
    expect(daysUntil("2026-11-12", today)).toBe(-1);
    expect(daysUntil("2027-03-29", "2027-03-27")).toBe(2); // über die Zeitumstellung hinweg
  });

  it("stuft nach der Regel des Vertrags ein", () => {
    expect(expiryState(null, 14, today)).toBe("none");
    expect(expiryState("2026-11-12", 14, today)).toBe("expired");
    expect(expiryState("2026-11-13", 14, today)).toBe("soon"); // heute ist noch nicht abgelaufen
    expect(expiryState("2026-11-27", 14, today)).toBe("soon");
    expect(expiryState("2026-11-28", 14, today)).toBe("ok");
    expect(expiryState("2026-11-13", 0, today)).toBe("soon");
    expect(expiryState("2026-11-14", 0, today)).toBe("ok");
  });

  it("nimmt die Vorlaufzeit des Produkts, sonst die des Haushalts", () => {
    expect(warnDaysFor({ warn_days: 3 }, { warn_days: 14 })).toBe(3);
    expect(warnDaysFor({ warn_days: 0 }, { warn_days: 14 })).toBe(0);
    expect(warnDaysFor({ warn_days: null }, { warn_days: 14 })).toBe(14);
    expect(warnDaysFor(undefined, { warn_days: 14 })).toBe(14);
  });
});

describe("Datumsrechnung", () => {
  it("rechnet mit Kalendertagen", () => {
    expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-03-01", -1)).toBe("2027-02-28");
    expect(lastDayOfMonth(2028, 2)).toBe("2028-02-29");
    expect(makeDate(2027, 2, 29)).toBeNull();
    expect(makeDate(2027, 3, 5)).toBe("2027-03-05");
    expect(() => daysBetween("gestern", "2027-01-01")).toThrow();
  });

  it("formatiert für die Anzeige", () => {
    expect(formatDate("2027-03-05")).toBe("05.03.2027");
    expect(formatDate("kein Datum")).toBe("kein Datum");
    expect(toLocalDate(new Date(2027, 2, 5, 23, 59))).toBe("2027-03-05");
  });
});

describe("Etikett-Daten", () => {
  const product: Pick<Product, "name" | "barcodes" | "brand" | "quantity"> = {
    name: "Basmati Reis",
    barcodes: ["4006381333931"],
    brand: "Kornhaus",
    quantity: "1 kg",
  };
  const pkg: Pick<Package, "id" | "best_before" | "created_at"> = {
    id: "A2B3C",
    best_before: "2027-03-25",
    created_at: "2026-11-13T10:15:30.123Z",
  };
  const zone: Pick<Zone, "id" | "name"> = { id: "3f2b8c1e-5a47-4d09-9b6e-0c1d2e3f4a5b", name: "Keller" };

  it("füllt alle Felder einer Packung als fertige Texte", () => {
    const data = packageLabelData(pkg, product, zone, { show_zone: true });
    expect(data).toEqual({
      qr: "STOWLY/P/A2B3C",
      id: "A2B3C",
      title: "Basmati Reis",
      subtitle: "Kornhaus · 1 kg",
      best_before: "25.03.2027",
      stored: formatDate(toLocalDate(new Date(pkg.created_at))),
      zone: "Keller",
    });
    expect(Object.values(data).every((value) => typeof value === "string")).toBe(true);
  });

  it("lässt leer, was fehlt", () => {
    const placeholder = { name: " ", barcodes: ["4006381333931"], brand: "", quantity: "" };
    const data = packageLabelData({ ...pkg, best_before: null }, placeholder, zone, { show_zone: false });
    expect(data.title).toBe("4006381333931");
    expect(data.subtitle).toBe("");
    expect(data.best_before).toBe("");
    expect(data.zone).toBe("");
    expect(isPlaceholder(placeholder)).toBe(true);
    expect(isPlaceholder(product)).toBe(false);
  });

  it("benennt Produkte auch ohne Namen und ohne Barcode", () => {
    expect(productTitle({ name: "", barcodes: [] })).toBe("Unbekanntes Produkt");
    expect(productTitle(undefined)).toBe("Unbekanntes Produkt");
    expect(productSubtitle({ brand: "", quantity: "500 g" })).toBe("500 g");
    expect(productSubtitle(undefined)).toBe("");
  });

  it("füllt das Etikett einer Zone", () => {
    expect(zoneLabelData(zone)).toEqual({
      qr: "STOWLY/Z/3F2B8C1E5A474D099B6E0C1D2E3F4A5B",
      title: "Keller",
      subtitle: "Lagerzone",
    });
  });
});
