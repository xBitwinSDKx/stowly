import { describe, expect, it } from "vitest";

import { addDays, type Package, type Product, type Zone } from "@/contract";
import { createSampleData, sampleBarcode, sampleUuid } from "@/mock";

import {
  buildEntries,
  countWarnings,
  DEFAULT_SORT,
  filterEntries,
  foldText,
  groupByProduct,
  isFiltered,
  matchesSearch,
  NO_FILTER,
  searchTokens,
  sortGroups,
  warningGroups,
  zoneFill,
  type StockEntry,
} from "./model";

const TODAY = "2026-11-13";
const STAMP = "2026-11-01T08:00:00.000Z";
const SETTINGS = { warn_days: 14 };

function zone(n: number, name: string, sort = n): Zone {
  return { id: sampleUuid(1, n), name, icon: "box", color: null, sort, printer_id: null, created_at: STAMP, updated_at: STAMP, deleted_at: null, moved_to: null };
}

function product(n: number, name: string, extra: Partial<Product> = {}): Product {
  return {
    id: sampleUuid(2, n),
    name,
    brand: "",
    quantity: "",
    image: null,
    warn_days: null,
    lookup: "none",
    barcodes: [],
    created_at: STAMP,
    updated_at: STAMP,
    deleted_at: null,
    merged_into: null,
    ...extra,
  };
}

function pkg(id: string, productRef: Product | string, zoneRef: Zone | string, offset: number | null): Package {
  return {
    id,
    product_id: typeof productRef === "string" ? productRef : productRef.id,
    zone_id: typeof zoneRef === "string" ? zoneRef : zoneRef.id,
    best_before: offset === null ? null : addDays(TODAY, offset),
    created_at: STAMP,
    updated_at: STAMP,
    removed_at: null,
    removal_reason: null,
    displaced: null,
  };
}

const SHELF = zone(1, "Vorratsregal");
const CELLAR = zone(2, "Keller");
const FRIDGE = zone(3, "Kühlschrank");
const ZONES = [SHELF, CELLAR, FRIDGE];

const RICE = product(1, "Basmati Reis", { brand: "Kornhaus", quantity: "1 kg", barcodes: [sampleBarcode(1)] });
const BUTTER = product(2, "Butter", { brand: "Almhof", warn_days: 5, barcodes: [sampleBarcode(2), sampleBarcode(3)] });
const CHEESE = product(3, "Käse", { brand: "Almhof" });
const PLACEHOLDER = product(4, "", { barcodes: [sampleBarcode(40)], lookup: "pending" });
const PRODUCTS = [RICE, BUTTER, CHEESE, PLACEHOLDER];

const PACKAGES: Package[] = [
  pkg("A2B3C", RICE, CELLAR, 132),
  pkg("A2B3D", RICE, CELLAR, 132),
  pkg("B7K9M", RICE, CELLAR, 135),
  pkg("C1C1C", RICE, SHELF, 132),
  pkg("D4D4D", BUTTER, FRIDGE, 4),
  pkg("E5E5E", BUTTER, FRIDGE, 18),
  pkg("F6F6F", CHEESE, FRIDGE, -3),
  pkg("G7G7G", CHEESE, FRIDGE, null),
  pkg("H8H8H", PLACEHOLDER, CELLAR, 10),
];

function entries(packages = PACKAGES, products = PRODUCTS, zones = ZONES): StockEntry[] {
  return buildEntries(packages, products, zones, SETTINGS, TODAY);
}

describe("buildEntries", () => {
  it("bestimmt die Warnstufe mit der Vorlaufzeit des Produkts, sonst des Haushalts", () => {
    const byId = new Map(entries().map((entry) => [entry.pkg.id, entry]));
    // Butter warnt erst 5 Tage vorher: 4 Tage = bald, 18 Tage = in Ordnung
    expect(byId.get("D4D4D")).toMatchObject({ state: "soon", days: 4 });
    expect(byId.get("E5E5E")).toMatchObject({ state: "ok", days: 18 });
    // Haushalt: 14 Tage
    expect(byId.get("H8H8H")).toMatchObject({ state: "soon", days: 10 });
    expect(byId.get("F6F6F")).toMatchObject({ state: "expired", days: -3 });
    expect(byId.get("G7G7G")).toMatchObject({ state: "none", days: null });
    expect(byId.get("A2B3C")).toMatchObject({ state: "ok", days: 132 });
  });

  it("hält Verweise ins Leere aus", () => {
    const [entry] = entries([pkg("Z9Z9Z", sampleUuid(2, 99), sampleUuid(1, 99), 3)]);
    expect(entry?.product).toBeUndefined();
    expect(entry?.zone).toBeUndefined();
    // ohne Produkt gilt die Vorlaufzeit des Haushalts
    expect(entry?.state).toBe("soon");

    const [group] = groupByProduct(entries([pkg("Z9Z9Z", sampleUuid(2, 99), sampleUuid(1, 99), 3)]), ZONES);
    expect(group).toMatchObject({ title: "Unbekanntes Produkt", subtitle: "", count: 1, product: undefined });
    expect(group?.batches[0]?.zone).toBeUndefined();
  });
});

describe("countWarnings", () => {
  it("zählt abgelaufene und bald ablaufende Packungen", () => {
    expect(countWarnings(entries())).toEqual({ total: 3, expired: 1, soon: 2 });
    expect(countWarnings([])).toEqual({ total: 0, expired: 0, soon: 0 });
  });
});

describe("groupByProduct", () => {
  const groups = groupByProduct(entries(), ZONES);
  const byTitle = (title: string) => {
    const group = groups.find((candidate) => candidate.title === title);
    if (!group) {
      throw new Error(`Gruppe ${title} fehlt`);
    }
    return group;
  };

  it("bildet eine Zeile je Produkt, nach Anzeigename sortiert", () => {
    // Platzhalter tragen ihren Barcode als Namen; Ziffern stehen vor Buchstaben
    expect(groups.map((group) => group.title)).toEqual([sampleBarcode(40), "Basmati Reis", "Butter", "Käse"]);
    expect(groups.map((group) => group.count)).toEqual([1, 4, 2, 2]);
  });

  it("bildet Chargen je Kombination aus MHD und Zone", () => {
    const rice = byTitle("Basmati Reis");
    expect(rice.batches.map((batch) => [batch.best_before, batch.zone?.name, batch.count, batch.ids])).toEqual([
      // gleiches MHD: in der Reihenfolge der Zonen (Vorratsregal vor Keller)
      [addDays(TODAY, 132), "Vorratsregal", 1, ["C1C1C"]],
      [addDays(TODAY, 132), "Keller", 2, ["A2B3C", "A2B3D"]],
      [addDays(TODAY, 135), "Keller", 1, ["B7K9M"]],
    ]);
    expect(rice.zone_ids).toEqual([SHELF.id, CELLAR.id]);
    expect(rice.subtitle).toBe("Kornhaus · 1 kg");
  });

  it("nennt das früheste MHD als kritischstes, mit seiner Warnstufe", () => {
    expect(byTitle("Basmati Reis")).toMatchObject({ critical: addDays(TODAY, 132), state: "ok", days: 132, warn_count: 0 });
    expect(byTitle("Butter")).toMatchObject({ critical: addDays(TODAY, 4), state: "soon", days: 4, warn_count: 1, expired_count: 0 });
    // eine abgelaufene Packung und eine ohne MHD: Die ohne MHD steht als Charge zuletzt
    const cheese = byTitle("Käse");
    expect(cheese).toMatchObject({ critical: addDays(TODAY, -3), state: "expired", days: -3, warn_count: 1, expired_count: 1 });
    expect(cheese.batches.map((batch) => batch.best_before)).toEqual([addDays(TODAY, -3), null]);
  });

  it("kennt Produkte ganz ohne MHD", () => {
    const [group] = groupByProduct(entries([pkg("G7G7G", CHEESE, FRIDGE, null)]), ZONES);
    expect(group).toMatchObject({ critical: null, state: "none", days: null, warn_count: 0 });
  });

  it("verarbeitet die Beispieldaten der Attrappe", () => {
    const data = createSampleData(new Date(`${TODAY}T10:00:00`));
    const active = data.packages.filter((candidate) => candidate.removed_at === null);
    const sample = groupByProduct(buildEntries(active, data.products, data.zones, data.settings, TODAY), data.zones);
    expect(sample.reduce((sum, group) => sum + group.count, 0)).toBe(active.length);
    expect(sample.find((group) => group.title === "Basmati Reis")?.batches).toHaveLength(3);
  });
});

describe("sortGroups", () => {
  const groups = groupByProduct(entries(), ZONES);

  it("sortiert nach Name, Menge und kritischstem MHD", () => {
    expect(sortGroups(groups, DEFAULT_SORT).map((group) => group.title)).toEqual([sampleBarcode(40), "Basmati Reis", "Butter", "Käse"]);
    expect(sortGroups(groups, { key: "title", descending: true }).map((group) => group.title)[0]).toBe("Käse");
    expect(sortGroups(groups, { key: "count", descending: true }).map((group) => group.title)[0]).toBe("Basmati Reis");
    expect(sortGroups(groups, { key: "critical", descending: false }).map((group) => group.title)).toEqual(["Käse", "Butter", sampleBarcode(40), "Basmati Reis"]);
  });

  it("stellt Zeilen ohne MHD immer ans Ende", () => {
    const withUndated = groupByProduct(entries([...PACKAGES.filter((candidate) => candidate.product_id !== CHEESE.id), pkg("G7G7G", CHEESE, FRIDGE, null)]), ZONES);
    for (const descending of [false, true]) {
      expect(sortGroups(withUndated, { key: "critical", descending }).at(-1)?.title).toBe("Käse");
    }
  });
});

describe("Suche", () => {
  const all = entries();
  const find = (query: string) => filterEntries(all, { ...NO_FILTER, query }).map((entry) => entry.pkg.id);

  it("findet über Produktname und Marke, ohne Rücksicht auf Groß- und Kleinschreibung und Umlaute", () => {
    expect(find("reis")).toEqual(["A2B3C", "A2B3D", "B7K9M", "C1C1C"]);
    expect(find("ALMHOF")).toEqual(["D4D4D", "E5E5E", "F6F6F", "G7G7G"]);
    expect(find("kase")).toEqual(["F6F6F", "G7G7G"]);
    expect(find("käse")).toEqual(["F6F6F", "G7G7G"]);
    expect(foldText("Weißer Käse")).toBe("weisser kase");
  });

  it("verlangt bei mehreren Wörtern, dass jedes trifft", () => {
    expect(find("almhof butter")).toEqual(["D4D4D", "E5E5E"]);
    expect(find("almhof reis")).toEqual([]);
  });

  it("findet über den Barcode, auch über einen Teil davon", () => {
    expect(find(sampleBarcode(3))).toEqual(["D4D4D", "E5E5E"]);
    expect(find(sampleBarcode(40).slice(-6))).toEqual(["H8H8H"]);
  });

  it("findet eine einzelne Packung über ihre ID, auch wie von Hand getippt", () => {
    expect(find("B7K9M")).toEqual(["B7K9M"]);
    expect(find("b7k")).toEqual(["B7K9M"]);
    expect(find("a2-b3")).toEqual(["A2B3C", "A2B3D"]);
    // O wird wie 0 gelesen, I und L wie 1
    expect(find("clclc")).toEqual(["C1C1C"]);
    // Die ID zählt nur ab ihrem Anfang
    expect(find("K9M")).toEqual([]);
  });

  it("zählt ein Wort erst ab drei Zeichen als Anfang einer Packungs-ID", () => {
    // „ba" meint Basmati, nicht die Butter, deren ID zufällig mit BA beginnt.
    const withLookalike = entries([...PACKAGES, pkg("BA7K2", BUTTER, FRIDGE, 30)]);
    const search = (query: string) => filterEntries(withLookalike, { ...NO_FILTER, query }).map((entry) => entry.pkg.id);
    expect(search("ba")).toEqual(["A2B3C", "A2B3D", "B7K9M", "C1C1C"]);
    expect(search("b7")).toEqual([]);
    expect(search("ba7")).toEqual(["BA7K2"]);
    // Bindestriche zählen nicht mit: „b-a" bleibt zu kurz.
    expect(search("b-a")).toEqual([]);
    expect(searchTokens("ba b7k").map((token) => token.id)).toEqual(["", "B7K"]);
  });

  it("verbindet Produkt und ID: Reis mit einer bestimmten ID", () => {
    expect(find("reis a2b3d")).toEqual(["A2B3D"]);
  });

  it("trifft bei leerer Eingabe alles", () => {
    expect(searchTokens("   ")).toEqual([]);
    expect(find("")).toHaveLength(all.length);
    const first = all[0];
    expect(first && matchesSearch(first, [])).toBe(true);
  });

  it("zeigt in der Gruppe nur die gefundenen Packungen", () => {
    const [group] = groupByProduct(filterEntries(all, { ...NO_FILTER, query: "B7K9M" }), ZONES);
    expect(group).toMatchObject({ title: "Basmati Reis", count: 1, critical: addDays(TODAY, 135) });
  });
});

describe("Filter", () => {
  const all = entries();

  it("filtert nach Zone, vor dem Gruppieren", () => {
    const inCellar = groupByProduct(filterEntries(all, { ...NO_FILTER, zone_id: CELLAR.id }), ZONES);
    expect(inCellar.map((group) => [group.title, group.count])).toEqual([
      [sampleBarcode(40), 1],
      ["Basmati Reis", 3],
    ]);
    // Die Zeile kennt dann nur noch den Keller
    expect(inCellar[1]?.zone_ids).toEqual([CELLAR.id]);
  });

  it("filtert auf abgelaufene und bald ablaufende Packungen", () => {
    const expiring = filterEntries(all, { ...NO_FILTER, expiring: true });
    expect(expiring.map((entry) => entry.pkg.id).sort()).toEqual(["D4D4D", "F6F6F", "H8H8H"]);
    // Butter: nur die eine Packung, die bald abläuft
    expect(groupByProduct(expiring, ZONES).find((group) => group.title === "Butter")?.count).toBe(1);
  });

  it("verbindet Suche, Zone und Warnfilter", () => {
    const result = filterEntries(all, { query: "almhof", zone_id: FRIDGE.id, expiring: true });
    expect(result.map((entry) => entry.pkg.id).sort()).toEqual(["D4D4D", "F6F6F"]);
    expect(filterEntries(all, { query: "almhof", zone_id: CELLAR.id, expiring: false })).toEqual([]);
  });

  it("erkennt, ob überhaupt gefiltert wird", () => {
    expect(isFiltered(NO_FILTER)).toBe(false);
    expect(isFiltered({ ...NO_FILTER, query: "  " })).toBe(false);
    expect(isFiltered({ ...NO_FILTER, query: "reis" })).toBe(true);
    expect(isFiltered({ ...NO_FILTER, zone_id: CELLAR.id })).toBe(true);
    expect(isFiltered({ ...NO_FILTER, expiring: true })).toBe(true);
  });
});

describe("zoneFill", () => {
  it("zählt je Zone und nennt den Anteil am Bestand", () => {
    const fill = zoneFill(entries(), ZONES);
    expect(fill.map((entry) => [entry.zone.name, entry.count])).toEqual([
      ["Vorratsregal", 1],
      ["Keller", 4],
      ["Kühlschrank", 4],
    ]);
    expect(fill.reduce((sum, entry) => sum + entry.share, 0)).toBeCloseTo(1);
    expect(fill[1]?.share).toBeCloseTo(4 / 9);
  });

  it("kommt mit leerem Bestand und leeren Zonen zurecht", () => {
    expect(zoneFill([], ZONES).map((entry) => [entry.count, entry.share])).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
  });
});

describe("warningGroups", () => {
  it("fasst je Produkt und MHD zusammen, das Dringendste zuerst", () => {
    const extra = [...PACKAGES, pkg("J1J1J", BUTTER, SHELF, 4), pkg("K2K2K", CHEESE, CELLAR, -3)];
    const groups = warningGroups(entries(extra), ZONES);
    expect(groups.map((group) => [group.title, group.state, group.days, group.count])).toEqual([
      ["Käse", "expired", -3, 2],
      ["Butter", "soon", 4, 2],
      [sampleBarcode(40), "soon", 10, 1],
    ]);
    // Zonen in ihrer Reihenfolge, mit den IDs je Zone
    expect(groups[1]?.zones.map((place) => [place.zone?.name, place.ids])).toEqual([
      ["Vorratsregal", ["J1J1J"]],
      ["Kühlschrank", ["D4D4D"]],
    ]);
    expect(groups[0]?.ids.sort()).toEqual(["F6F6F", "K2K2K"]);
  });

  it("zählt dieselben Packungen wie countWarnings", () => {
    const all = entries();
    const listed = warningGroups(all, ZONES).reduce((sum, group) => sum + group.count, 0);
    expect(listed).toBe(countWarnings(all).total);
  });

  it("ist leer, wenn nichts abläuft", () => {
    expect(warningGroups(entries([pkg("A2B3C", RICE, CELLAR, 132), pkg("G7G7G", CHEESE, FRIDGE, null)]), ZONES)).toEqual([]);
  });
});
