import { describe, expect, it } from "vitest";

import { type Product, type ShoppingItem } from "@/contract";
import { sampleBarcode, sampleUuid } from "@/mock";

import { findDuplicate, isAutomatic, MAX_SUGGESTIONS, splitItems, suggestProducts } from "./model";

const STAMP = "2026-11-01T08:00:00.000Z";

function product(n: number, name: string, extra: Partial<Product> = {}): Product {
  return {
    id: sampleUuid(2, n),
    name,
    brand: "",
    quantity: "",
    image: null,
    warn_days: null,
    min_stock: null,
    lookup: "none",
    barcodes: [],
    created_at: STAMP,
    updated_at: STAMP,
    deleted_at: null,
    merged_into: null,
    ...extra,
  };
}

function item(n: number, fields: Partial<ShoppingItem> = {}): ShoppingItem {
  return {
    id: sampleUuid(7, n),
    product_id: null,
    text: "",
    quantity: null,
    origin: "manual",
    done_at: null,
    deleted_at: null,
    created_at: STAMP,
    updated_at: STAMP,
    ...fields,
  };
}

const MILK = product(1, "H-Milch", { brand: "Almhof", barcodes: [sampleBarcode(1)] });
const OAT_MILK = product(2, "Hafermilch", { brand: "Feldkorn" });
const RICE = product(3, "Basmati Reis", { brand: "Kornhaus" });
const BUTTER = product(4, "Butter", { brand: "Almhof" });
const PRODUCTS = [MILK, OAT_MILK, RICE, BUTTER];

describe("splitItems", () => {
  it("teilt in offene und erledigte, gelöschte fallen weg, die Reihenfolge bleibt", () => {
    const items = [item(1), item(2, { done_at: STAMP }), item(3), item(4, { deleted_at: STAMP }), item(5, { done_at: STAMP, deleted_at: STAMP })];
    const { open, done } = splitItems(items);
    expect(open.map((entry) => entry.id)).toEqual([sampleUuid(7, 1), sampleUuid(7, 3)]);
    expect(done.map((entry) => entry.id)).toEqual([sampleUuid(7, 2)]);
  });

  it("erkennt automatische Einträge", () => {
    expect(isAutomatic(item(1, { origin: "min_stock" }))).toBe(true);
    expect(isAutomatic(item(1))).toBe(false);
  });
});

describe("suggestProducts", () => {
  it("schlägt Produkte vor, deren Name mit der Eingabe beginnt, zuerst", () => {
    expect(suggestProducts(PRODUCTS, "milch").map((entry) => entry.name)).toEqual(["H-Milch", "Hafermilch"]);
    expect(suggestProducts(PRODUCTS, "hafer").map((entry) => entry.name)).toEqual(["Hafermilch"]);
    // „h" steckt in allen vier (Kornhaus, Almhof); vorn stehen die, die so beginnen.
    expect(suggestProducts(PRODUCTS, "H").map((entry) => entry.name)).toEqual(["H-Milch", "Hafermilch", "Basmati Reis", "Butter"]);
  });

  it("findet über Marke und Barcode, verlangt jedes Wort und kennt keine leere Eingabe", () => {
    expect(suggestProducts(PRODUCTS, "almhof").map((entry) => entry.name)).toEqual(["Butter", "H-Milch"]);
    expect(suggestProducts(PRODUCTS, "almhof milch").map((entry) => entry.name)).toEqual(["H-Milch"]);
    expect(suggestProducts(PRODUCTS, sampleBarcode(1).slice(-5)).map((entry) => entry.name)).toEqual(["H-Milch"]);
    expect(suggestProducts(PRODUCTS, "   ")).toEqual([]);
  });

  it("schlägt höchstens einige vor", () => {
    const many = Array.from({ length: 20 }, (_, index) => product(100 + index, `Tee ${String(index)}`));
    expect(suggestProducts(many, "tee")).toHaveLength(MAX_SUGGESTIONS);
  });
});

describe("findDuplicate", () => {
  const items = [item(1, { product_id: MILK.id, origin: "min_stock", quantity: 2 }), item(2, { text: "Backpapier" }), item(3, { text: "Brot", done_at: STAMP })];

  it("findet einen offenen Eintrag desselben Produkts", () => {
    expect(findDuplicate(items, PRODUCTS, { product: MILK })?.id).toBe(sampleUuid(7, 1));
    expect(findDuplicate(items, PRODUCTS, { product: RICE })).toBeUndefined();
  });

  it("findet denselben Namen, ohne Rücksicht auf Groß- und Kleinschreibung, auch zwischen Text und Produkt", () => {
    expect(findDuplicate(items, PRODUCTS, { text: " backpapier " })?.id).toBe(sampleUuid(7, 2));
    expect(findDuplicate(items, PRODUCTS, { text: "h-milch" })?.id).toBe(sampleUuid(7, 1));
    expect(findDuplicate([item(4, { text: "Butter" })], PRODUCTS, { product: BUTTER })?.id).toBe(sampleUuid(7, 4));
  });

  it("übergeht erledigte Einträge", () => {
    expect(findDuplicate(items, PRODUCTS, { text: "Brot" })).toBeUndefined();
  });
});
