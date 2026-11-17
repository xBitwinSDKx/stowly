/** Scan-Auswertung, MHD-Eingabe, Warnstufen und Etikett-Daten. */
import { describe, expect, it } from "vitest";

import type { Package, Product, Zone } from "./api.gen";
import { willLookUp } from "./barcode";
import { isPlaceholder, labelSubtitle, packageLabelData, printerIdForJob, productSubtitle, productTitle, zoneLabelData } from "./labels";
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
    const data = packageLabelData(pkg, product, zone);
    const stored = formatDate(toLocalDate(new Date(pkg.created_at)));
    expect(data).toEqual({
      qr: "STOWLY/P/A2B3C",
      id: "A2B3C",
      title: "Basmati Reis",
      subtitle: "1 kg · Kornhaus",
      best_before: "25.03.2027",
      stored,
      zone: "Keller",
      // Seit 0.5.0: einzeln und kurz, für die Gestaltung des Haushalts.
      brand: "Kornhaus",
      quantity: "1 kg",
      best_before_short: "25.03.27",
      stored_short: `${stored.slice(0, 6)}${stored.slice(8)}`,
    });
    expect(data.stored_short).toMatch(/^\d{2}\.\d{2}\.\d{2}$/);
    expect(Object.values(data).every((value) => typeof value === "string")).toBe(true);
  });

  it("nennt die Zone immer, auch wenn es nur eine gibt: Ob sie gedruckt wird, entscheidet die Vorlage", () => {
    expect(packageLabelData(pkg, product, { name: "Vorrat" }).zone).toBe("Vorrat");
    // Ohne Zone (sie ist gelöscht und nirgends hin verschoben) bleibt das Feld leer.
    expect(packageLabelData(pkg, product, undefined).zone).toBe("");
    // Marke und Größe ohne Leerraum am Rand, wie in der Zeile darüber.
    expect(packageLabelData(pkg, { ...product, brand: " Kornhaus ", quantity: " 1 kg " }, zone)).toMatchObject({ brand: "Kornhaus", quantity: "1 kg", subtitle: "1 kg · Kornhaus" });
  });

  it("stellt auf dem Etikett die Packungsgröße vor die Marke: Gekürzt wird am Ende der Zeile", () => {
    expect(labelSubtitle(product)).toBe("1 kg · Kornhaus");
    expect(labelSubtitle({ brand: " COCA-COLA SERVICES SA/NV ", quantity: " 330 ml " })).toBe("330 ml · COCA-COLA SERVICES SA/NV");
    expect(labelSubtitle({ brand: "Kornhaus", quantity: "" })).toBe("Kornhaus");
    expect(labelSubtitle({ brand: "", quantity: "500 g" })).toBe("500 g");
    expect(labelSubtitle({ brand: " ", quantity: "" })).toBe("");
    expect(labelSubtitle(undefined)).toBe("");
    // In der App bleibt die Marke vorn.
    expect(productSubtitle(product)).toBe("Kornhaus · 1 kg");
  });

  it("lässt leer, was fehlt", () => {
    const placeholder = { name: " ", barcodes: ["4006381333931"], brand: "", quantity: "" };
    const data = packageLabelData({ ...pkg, best_before: null }, placeholder, undefined);
    expect(data.title).toBe("4006381333931");
    expect(data.subtitle).toBe("");
    expect(data.best_before).toBe("");
    expect(data.best_before_short).toBe("");
    expect(data.brand).toBe("");
    expect(data.quantity).toBe("");
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

describe("Nachschlagen", () => {
  it("verspricht nur, was der Server auch tut", () => {
    expect(willLookUp("4006381333931", true)).toBe(true);
    // Noch unbekannt (vor dem ersten Abgleich) gilt als eingeschaltet.
    expect(willLookUp("4006381333931", null)).toBe(true);
    expect(willLookUp("4006381333931", false)).toBe(false);
    // Ladeninterne Codes (Präfix 2) werden nie nachgeschlagen.
    expect(willLookUp("2112345678900", true)).toBe(false);
    expect(willLookUp("2112345678900", null)).toBe(false);
  });
});

describe("Welcher Drucker", () => {
  const printers = new Map([
    ["p-label", { id: "p-label", deleted_at: null }],
    ["p-zone", { id: "p-zone", deleted_at: null }],
    ["p-default", { id: "p-default", deleted_at: null }],
    ["p-gone", { id: "p-gone", deleted_at: "2026-11-01T00:00:00.000Z" }],
  ]);
  const lookup = (zonePrinter: string | null, defaultPrinter: string | null) => ({
    package: (id: string) => (id === "A2B3C" ? { zone_id: "zone-1" } : undefined),
    zone: (id: string) => (id === "zone-1" ? { printer_id: zonePrinter } : undefined),
    printer: (id: string) => printers.get(id),
    settings: { default_printer_id: defaultPrinter },
  });
  const job = (printer_id: string | null) => ({ printer_id, package_id: "A2B3C", zone_id: null });

  it("nimmt den genannten, sonst den der Zone, sonst den Standarddrucker", () => {
    expect(printerIdForJob(job("p-label"), lookup("p-zone", "p-default"))).toBe("p-label");
    expect(printerIdForJob(job(null), lookup("p-zone", "p-default"))).toBe("p-zone");
    expect(printerIdForJob(job(null), lookup(null, "p-default"))).toBe("p-default");
    expect(printerIdForJob(job(null), lookup(null, null))).toBeNull();
    // Das Etikett einer Zone nimmt den Drucker dieser Zone.
    expect(printerIdForJob({ printer_id: null, package_id: null, zone_id: "zone-1" }, lookup("p-zone", "p-default"))).toBe("p-zone");
  });

  it("übergeht gelöschte und unbekannte Drucker auf jeder Stufe", () => {
    expect(printerIdForJob(job("p-gone"), lookup("p-zone", "p-default"))).toBe("p-zone");
    expect(printerIdForJob(job("gibt-es-nicht"), lookup("p-gone", "p-default"))).toBe("p-default");
    expect(printerIdForJob(job(null), lookup("p-gone", "p-gone"))).toBeNull();
    // Eine Packung, die die lokale Kopie nicht kennt: Es bleibt der Standarddrucker.
    expect(printerIdForJob({ printer_id: null, package_id: "ZZZZZ", zone_id: null }, lookup("p-zone", "p-default"))).toBe("p-default");
    expect(printerIdForJob(job(null), { ...lookup(null, null), settings: null })).toBeNull();
  });
});
