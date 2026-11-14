/**
 * Auswertung eines Scans und Eingabe von Hand, ohne Oberfläche.
 */
import { describe, expect, it } from "vitest";

import { zoneQr, type Package, type Product, type ShoppingItem, type Zone } from "@/contract";

import { evaluateScan, fifoHint, isOnShoppingList, offersShoppingList, parseManualInput, shortDate, wasLastPackage, type ScanLookups } from "./scan-flow";

const AT = "2026-11-13T10:00:00.000Z";
const ZONE_A: Zone = { id: "10000000-0000-4000-8000-000000000001", name: "Vorrat", icon: "box", color: null, sort: 0, printer_id: null, created_at: AT, updated_at: AT, deleted_at: null, moved_to: null };
const ZONE_B: Zone = { ...ZONE_A, id: "10000000-0000-4000-8000-000000000002", name: "Keller", sort: 1 };
const RICE: Product = { id: "20000000-0000-4000-8000-000000000001", name: "Reis", brand: "", quantity: "", image: null, warn_days: null, min_stock: null, lookup: "found", barcodes: ["4006381333931"], created_at: AT, updated_at: AT, deleted_at: null, merged_into: null };
const IN_STOCK: Package = { id: "A2B3C", product_id: RICE.id, zone_id: ZONE_A.id, best_before: null, created_at: AT, updated_at: AT, removed_at: null, removal_reason: null, displaced: null };
const REMOVED: Package = { ...IN_STOCK, id: "7K9QX", removed_at: AT, removal_reason: "consumed" };

function lookups(zones: Zone[] = [ZONE_A, ZONE_B]): ScanLookups {
  return {
    zones,
    findPackage: async (id) => [IN_STOCK, REMOVED].find((pkg) => pkg.id === id),
    findProduct: async (id) => (id === RICE.id ? RICE : undefined),
    findProductByBarcode: async (barcode) => (RICE.barcodes.includes(barcode) ? RICE : undefined),
  };
}

describe("Auswertung eines Scans", () => {
  it("lagert bei einem Produkt-Barcode ein, ob bekannt oder nicht", async () => {
    expect(await evaluateScan({ kind: "product", barcode: "4006381333931" }, lookups())).toEqual({ type: "store", barcode: "4006381333931", product: RICE });
    expect(await evaluateScan({ kind: "product", barcode: "96385074" }, lookups())).toEqual({ type: "store", barcode: "96385074", product: undefined });
  });

  it("bucht bei einem Packungs-Etikett aus und meldet Unbekanntes und schon Entnommenes", async () => {
    expect(await evaluateScan({ kind: "package", package_id: "A2B3C" }, lookups())).toEqual({ type: "remove", pkg: IN_STOCK, product: RICE });
    expect(await evaluateScan({ kind: "package", package_id: "7K9QX" }, lookups())).toEqual({ type: "already_removed", pkg: REMOVED, product: RICE });
    expect(await evaluateScan({ kind: "package", package_id: "ZZZZZ" }, lookups())).toEqual({ type: "unknown_package", package_id: "ZZZZZ" });
  });

  it("wechselt bei einem Zonen-Etikett die Zone", async () => {
    expect(await evaluateScan({ kind: "zone", zone_id: ZONE_B.id }, lookups())).toEqual({ type: "zone", zone: ZONE_B });
    expect(await evaluateScan({ kind: "zone", zone_id: "10000000-0000-4000-8000-000000000099" }, lookups())).toEqual({ type: "unknown_zone", zone_id: "10000000-0000-4000-8000-000000000099" });
    // Gibt es nur eine Zone, gibt es nichts zu wechseln und nichts zu zeigen.
    expect(await evaluateScan({ kind: "zone", zone_id: ZONE_A.id }, lookups([ZONE_A]))).toEqual({ type: "nothing" });
    expect(await evaluateScan({ kind: "zone", zone_id: ZONE_B.id }, lookups([ZONE_A]))).toEqual({ type: "unknown_zone", zone_id: ZONE_B.id });
  });

  it("meldet fremde Codes", async () => {
    expect(await evaluateScan({ kind: "unknown", raw: "https://example.org", format: "qr_code" }, lookups())).toEqual({ type: "unknown_code", raw: "https://example.org" });
  });
});

describe("Eingabe von Hand", () => {
  it("liest Packungs-IDs und korrigiert verwechselte Zeichen", () => {
    expect(parseManualInput("A2B3C")).toEqual({ ok: true, result: { kind: "package", package_id: "A2B3C" } });
    expect(parseManualInput(" a2-b3c ")).toEqual({ ok: true, result: { kind: "package", package_id: "A2B3C" } });
    expect(parseManualInput("o1l2i")).toEqual({ ok: true, result: { kind: "package", package_id: "01121" } });
    // Fünf Ziffern sind eine Packungs-ID, kein Barcode.
    expect(parseManualInput("12345")).toEqual({ ok: true, result: { kind: "package", package_id: "12345" } });
  });

  it("liest Barcodes in gespeicherter Form", () => {
    expect(parseManualInput("4006381333931")).toEqual({ ok: true, result: { kind: "product", barcode: "4006381333931" } });
    expect(parseManualInput("96385074")).toEqual({ ok: true, result: { kind: "product", barcode: "96385074" } });
    expect(parseManualInput("036000291452")).toEqual({ ok: true, result: { kind: "product", barcode: "0036000291452" } });
    // So, wie die Zahl unter dem Strichcode gedruckt ist.
    expect(parseManualInput("4 006381 333931")).toEqual({ ok: true, result: { kind: "product", barcode: "4006381333931" } });
  });

  it("liest den Inhalt eines Stowly-QR-Codes", () => {
    expect(parseManualInput("STOWLY/P/A2B3C")).toEqual({ ok: true, result: { kind: "package", package_id: "A2B3C" } });
    expect(parseManualInput(zoneQr(ZONE_B.id))).toEqual({ ok: true, result: { kind: "zone", zone_id: ZONE_B.id } });
  });

  it("sagt, warum eine Eingabe nichts ist", () => {
    expect(parseManualInput("   ")).toEqual({ ok: false, reason: "empty" });
    expect(parseManualInput("4006381333932")).toEqual({ ok: false, reason: "barcode" });
    expect(parseManualInput("A2B3")).toEqual({ ok: false, reason: "unknown" });
    expect(parseManualInput("A2B3U")).toEqual({ ok: false, reason: "unknown" });
    expect(parseManualInput("1234567")).toEqual({ ok: false, reason: "unknown" });
    expect(parseManualInput("Basmati Reis")).toEqual({ ok: false, reason: "unknown" });
  });
});

describe("Nach dem Entnehmen", () => {
  const pkg = (id: string, changes: Partial<Package> = {}): Package => ({ ...IN_STOCK, id, ...changes });

  it("nennt die ältere Packung: ID, MHD und die Zone, wenn es mehr als eine gibt", () => {
    const taken = pkg("TAKEN", { best_before: "2026-12-20" });
    const stock = [
      taken,
      pkg("LATER", { best_before: "2027-01-01" }),
      pkg("XYZ12", { best_before: "2026-12-03", zone_id: ZONE_B.id }),
      pkg("NEWER", { best_before: "2026-12-10" }),
    ];
    expect(fifoHint(taken, stock, [ZONE_A, ZONE_B])).toBe("Älter: XYZ12 · MHD 03.12. · Keller");
    expect(fifoHint(taken, stock, [ZONE_B])).toBe("Älter: XYZ12 · MHD 03.12.");
  });

  it("schweigt ohne ältere Packung: gleiches MHD, ohne MHD, anderes Produkt, entnommen", () => {
    const taken = pkg("TAKEN", { best_before: "2026-12-03" });
    expect(fifoHint(taken, [taken, pkg("SAME0", { best_before: "2026-12-03" }), pkg("NOMHD", { best_before: null })], [ZONE_A, ZONE_B])).toBeNull();
    expect(fifoHint(taken, [pkg("OTHER", { best_before: "2026-01-01", product_id: "20000000-0000-4000-8000-000000000002" })], [ZONE_A])).toBeNull();
    expect(fifoHint(taken, [pkg("GONE0", { best_before: "2026-01-01", removed_at: AT })], [ZONE_A])).toBeNull();
    // Eine Packung ohne MHD hat jede Packung mit MHD vor sich.
    const undated = pkg("UNDAT", { best_before: null });
    expect(fifoHint(undated, [undated, pkg("DATED", { best_before: "2027-05-01" })], [ZONE_A, ZONE_B])).toBe("Älter: DATED · MHD 01.05. · Vorrat");
  });

  it("schreibt das MHD kurz und erkennt die letzte Packung und einen offenen Eintrag", () => {
    expect(shortDate("2026-03-01")).toBe("01.03.");
    expect(shortDate("kein Datum")).toBe("kein Datum");
    const taken = pkg("TAKEN");
    expect(wasLastPackage(taken, [taken])).toBe(true);
    expect(wasLastPackage(taken, [taken, pkg("OTHER")])).toBe(false);
    const item = (changes: Partial<ShoppingItem>): ShoppingItem => ({ id: "70000000-0000-4000-8000-000000000001", product_id: RICE.id, text: "", quantity: null, origin: "manual", done_at: null, deleted_at: null, created_at: AT, updated_at: AT, ...changes });
    expect(isOnShoppingList(RICE.id, [item({})])).toBe(true);
    expect(isOnShoppingList(RICE.id, [item({ origin: "min_stock", quantity: 1 })])).toBe(true);
    expect(isOnShoppingList(RICE.id, [item({ done_at: AT }), item({ deleted_at: AT })])).toBe(false);
    expect(isOnShoppingList(RICE.id, [item({ product_id: null, text: "Reis" })])).toBe(false);
  });

  it("spricht die Einkaufsliste nur nach der letzten Packung eines Produkts ohne Mindestbestand an", () => {
    const taken = pkg("TAKEN");
    expect(offersShoppingList(taken, RICE, [taken])).toBe(true);
    expect(offersShoppingList(taken, RICE, [taken, pkg("OTHER")])).toBe(false);
    // Mit Mindestbestand legt der Server den Eintrag an: weder Angebot noch Satz.
    expect(offersShoppingList(taken, { ...RICE, min_stock: 2 }, [taken])).toBe(false);
    expect(offersShoppingList(taken, { ...RICE, min_stock: 1 }, [])).toBe(false);
    // Ein Produkt, das die lokale Kopie nicht kennt, ließe sich nicht auf die Liste setzen.
    expect(offersShoppingList(taken, undefined, [taken])).toBe(false);
  });
});
