/** Mindestbestand, Einkaufsliste, FIFO und die neuen Eingabeprüfungen (Stufe 2). */
import { describe, expect, it } from "vitest";

import { PUSH_PATHS, type Package, type ShoppingItem } from "./api.gen";
import { isCoreError } from "./errors";
import { compareFifo, nextPackage, olderPackage } from "./fifo";
import { checkMinStock, checkNotifyTime, checkShoppingQuantity, checkShoppingText } from "./input";
import { ROUTES } from "./routes";
import { compareShoppingItems, isBelowMinStock, isOpenItem, missingStock, shoppingItemTitle, shoppingQuantityLabel, stockCount, stockCounts } from "./shopping";

const AT = "2026-11-13T10:00:00.000Z";
const RICE = "20000000-0000-4000-8000-000000000001";
const MILK = "20000000-0000-4000-8000-000000000002";

function pkg(id: string, changes: Partial<Package> = {}): Package {
  return { id, product_id: RICE, zone_id: "10000000-0000-4000-8000-000000000001", best_before: null, created_at: AT, updated_at: AT, removed_at: null, removal_reason: null, displaced: null, ...changes };
}

function item(id: string, changes: Partial<ShoppingItem> = {}): ShoppingItem {
  return { id, product_id: null, text: "Grillkohle", quantity: null, origin: "manual", done_at: null, deleted_at: null, created_at: AT, updated_at: AT, ...changes };
}

describe("Mindestbestand", () => {
  const packages = [pkg("A0001"), pkg("A0002", { best_before: "2000-01-01" }), pkg("A0003", { removed_at: AT }), pkg("A0004", { product_id: MILK })];

  it("zählt jede nicht entnommene Packung, auch eine abgelaufene", () => {
    expect(stockCount(packages, RICE)).toBe(2);
    expect(stockCount(packages, MILK)).toBe(1);
    expect(stockCount(packages, "unbekannt")).toBe(0);
    expect(stockCounts(packages)).toEqual(new Map([[RICE, 2], [MILK, 1]]));
  });

  it("rechnet aus, wie viel fehlt", () => {
    expect(missingStock({ min_stock: 3 }, 2)).toBe(1);
    expect(missingStock({ min_stock: 3 }, 0)).toBe(3);
    expect(missingStock({ min_stock: 2 }, 2)).toBe(0);
    expect(missingStock({ min_stock: 2 }, 5)).toBe(0);
    expect(missingStock({ min_stock: null }, 0)).toBe(0);
    expect(missingStock(undefined, 0)).toBe(0);
    expect(isBelowMinStock({ min_stock: 3 }, 2)).toBe(true);
    expect(isBelowMinStock({ min_stock: 3 }, 3)).toBe(false);
    expect(isBelowMinStock({ min_stock: null }, 0)).toBe(false);
  });

  it("prüft die Eingabe wie der Server", () => {
    for (const ok of [null, undefined, 1, 999]) {
      expect(() => checkMinStock(ok)).not.toThrow();
    }
    for (const wrong of [0, 1000, 1.5, -1, "2"]) {
      expect(() => checkMinStock(wrong), String(wrong)).toThrow("Der Mindestbestand muss zwischen 1 und 999 Packungen liegen.");
    }
  });
});

describe("Einkaufsliste", () => {
  it("zeigt Produkt oder Text und die Menge", () => {
    expect(shoppingItemTitle(item("x"), undefined)).toBe("Grillkohle");
    expect(shoppingItemTitle(item("x", { product_id: RICE, text: "" }), { name: "Reis", barcodes: [] })).toBe("Reis");
    expect(shoppingItemTitle(item("x", { product_id: RICE, text: "" }), { name: "", barcodes: ["4006381333931"] })).toBe("4006381333931");
    expect(shoppingItemTitle(item("x", { product_id: RICE, text: "" }), undefined)).toBe("Unbekanntes Produkt");
    expect(shoppingQuantityLabel({ origin: "min_stock", quantity: 2 })).toBe("fehlt 2");
    expect(shoppingQuantityLabel({ origin: "manual", quantity: 3 })).toBe("3×");
    expect(shoppingQuantityLabel({ origin: "manual", quantity: null })).toBe("");
  });

  it("ordnet offene vor erledigten, Offenes nach Alter, Erledigtes zuletzt erledigt zuerst", () => {
    const items = [
      item("e", { done_at: "2026-11-13T12:00:00.000Z" }),
      item("b", { created_at: "2026-11-13T09:00:00.000Z" }),
      item("f", { done_at: "2026-11-13T13:00:00.000Z" }),
      item("a", { created_at: "2026-11-13T08:00:00.000Z" }),
    ];
    expect([...items].sort(compareShoppingItems).map((entry) => entry.id)).toEqual(["a", "b", "f", "e"]);
    expect(isOpenItem(item("a"))).toBe(true);
    expect(isOpenItem(item("a", { done_at: AT }))).toBe(false);
    expect(isOpenItem(item("a", { deleted_at: AT }))).toBe(false);
  });

  it("prüft Text und Menge wie der Server", () => {
    expect(checkShoppingText("  Grillkohle ")).toBe("Grillkohle");
    expect(() => checkShoppingText("   ")).toThrow("Der Eintrag braucht einen Text.");
    expect(() => checkShoppingText("x".repeat(121))).toThrow("Der Text ist zu lang (höchstens 120 Zeichen).");
    for (const ok of [null, undefined, 1, 999]) {
      expect(() => checkShoppingQuantity(ok)).not.toThrow();
    }
    for (const wrong of [0, 1000, 2.5]) {
      expect(() => checkShoppingQuantity(wrong)).toThrow("Die Menge muss zwischen 1 und 999 liegen.");
    }
  });

  it("verlangt die Uhrzeit der Tagesnachricht als HH:MM", () => {
    expect(() => checkNotifyTime("07:30")).not.toThrow();
    for (const wrong of ["7:30", "24:00", "", null, 1730]) {
      try {
        checkNotifyTime(wrong);
        expect.unreachable(String(wrong));
      } catch (error) {
        expect(isCoreError(error, "invalid")).toBe(true);
      }
    }
  });
});

describe("FIFO", () => {
  const stock = [
    pkg("A0001", { best_before: "2027-03-01", created_at: "2026-11-01T10:00:00.000Z" }),
    pkg("A0002", { best_before: "2026-12-03", created_at: "2026-11-05T10:00:00.000Z" }),
    pkg("A0003", { best_before: "2026-12-03", created_at: "2026-11-02T10:00:00.000Z" }),
    pkg("A0004", { best_before: null, created_at: "2026-10-01T10:00:00.000Z" }),
    pkg("A0005", { best_before: "2026-11-20", removed_at: AT }),
    pkg("A0006", { best_before: "2026-11-01", product_id: MILK }),
  ];

  it("nimmt das früheste MHD, bei Gleichstand die zuerst eingelagerte, ohne MHD zuletzt", () => {
    expect([...stock].filter((entry) => entry.product_id === RICE && entry.removed_at === null).sort(compareFifo).map((entry) => entry.id)).toEqual([
      "A0003",
      "A0002",
      "A0001",
      "A0004",
    ]);
    expect(nextPackage(stock, RICE)?.id).toBe("A0003");
    expect(nextPackage(stock, MILK)?.id).toBe("A0006");
    expect(nextPackage(stock, "unbekannt")).toBeUndefined();
  });

  it("nennt beim Entnehmen eine ältere Packung desselben Produkts, sonst nichts", () => {
    expect(olderPackage(pkg("Z0001", { best_before: "2027-06-01" }), stock)?.id).toBe("A0003");
    // Gleiches MHD ist nicht älter; die entnommene selbst zählt nicht.
    expect(olderPackage(pkg("A0003", { best_before: "2026-12-03" }), stock)).toBeUndefined();
    expect(olderPackage(pkg("Z0002", { best_before: "2026-11-01" }), stock)).toBeUndefined();
    // Ohne MHD ist jede Packung mit MHD älter.
    expect(olderPackage(pkg("Z0003", { best_before: null }), stock)?.id).toBe("A0003");
    expect(olderPackage(pkg("Z0004", { best_before: "2027-01-01", product_id: MILK }), stock)?.id).toBe("A0006");
  });
});

describe("Push", () => {
  it("führt zu Adressen, die es in der App gibt", () => {
    expect(PUSH_PATHS).toEqual({ daily: ROUTES.warnings, test: ROUTES.settings, update: ROUTES.settings });
  });
});
