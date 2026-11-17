/**
 * Zutaten für „Was koche ich?": Kandidaten aus dem Bestand, ihre Reihenfolge, gleiche Begriffe,
 * die Vorwahl und `?mit=` (docs/plan-0.6.md, 1).
 */
import { describe, expect, it } from "vitest";

import { addDays, cookPath, type Package, type Product, type Zone } from "@/contract";
import { buildEntries, groupByProduct } from "@/features/stock/model";
import { createSampleData, sampleUuid } from "@/mock";

import { cookCandidates, focusIds, ingredientTerms, isUrgent, matchCandidates, MAX_INGREDIENTS, preselect, requestedIds, type Candidate } from "./model";

const TODAY = "2026-11-17";
const ZONE: Zone = {
  id: sampleUuid(1, 1),
  name: "Vorrat",
  icon: "shelf",
  color: null,
  sort: 0,
  printer_id: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  deleted_at: null,
  moved_to: null,
};

let serial = 0;

function product(name: string, fields: Partial<Product> = {}): Product {
  serial += 1;
  return {
    id: sampleUuid(2, serial),
    name,
    brand: "",
    quantity: "",
    image: null,
    warn_days: null,
    min_stock: null,
    lookup: "found",
    barcodes: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    deleted_at: null,
    merged_into: null,
    ...fields,
  };
}

/** Eine Packung im Bestand; `days` bis zum MHD ab heute, null = ohne MHD. */
function pkg(owner: Product, days: number | null): Package {
  serial += 1;
  return {
    id: `P${String(serial).padStart(4, "0")}`,
    product_id: owner.id,
    zone_id: ZONE.id,
    best_before: days === null ? null : addDays(TODAY, days),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    removed_at: null,
    removal_reason: null,
    displaced: null,
  };
}

function candidatesOf(products: Product[], packages: Package[]): Candidate[] {
  const entries = buildEntries(packages, products, [ZONE], { warn_days: 7 }, TODAY);
  return cookCandidates(groupByProduct(entries, [ZONE]));
}

describe("Kandidaten", () => {
  it("ordnen den Bestand der Beispieldaten: bald fällig nach Tagen, abgelaufen, der Rest nach MHD, ohne MHD zuletzt", () => {
    const now = new Date("2026-11-17T10:00:00");
    const data = createSampleData(now);
    const today = TODAY;
    const entries = buildEntries(
      data.packages.filter((entry) => entry.removed_at === null),
      data.products,
      data.zones,
      data.settings,
      today,
    );
    const candidates = cookCandidates(groupByProduct(entries, data.zones));
    expect(candidates.map((candidate) => candidate.term)).toEqual([
      "Butter",
      "Passierte Tomaten",
      "Weizenmehl",
      "Lachsfilet",
      "Haferflocken",
      "H-Milch",
      "Basmati Reis",
      "Olivenöl",
      "Erbsen",
      "Spaghetti",
      "Rote Linsen",
      "Kidneybohnen",
      "Thunfisch",
      "Apfelmus",
    ]);
    expect(candidates.map((candidate) => candidate.state).slice(0, 6)).toEqual(["soon", "soon", "soon", "soon", "expired", "ok"]);
    // Die Platzhalter ohne Namen sind keine Zutat, auch wenn einer bald abläuft.
    expect(candidates.some((candidate) => candidate.title.match(/^\d+$/))).toBe(false);
    // Die Vorwahl: drei, die bald ablaufen.
    expect(preselect(candidates).map((candidate) => candidate.term)).toEqual(["Butter", "Passierte Tomaten", "Weizenmehl"]);
  });

  it("nehmen bei Abgelaufenem das zuletzt abgelaufene zuerst und nennen das kritischste MHD", () => {
    const old = product("Joghurt");
    const fresh = product("Quark");
    const both = product("Sahne");
    const candidates = candidatesOf([old, fresh, both], [pkg(old, -10), pkg(fresh, -1), pkg(both, -4), pkg(both, 30)]);
    expect(candidates.map((candidate) => candidate.term)).toEqual(["Quark", "Sahne", "Joghurt"]);
    expect(candidates.every(isUrgent)).toBe(true);
    expect(candidates[1]).toMatchObject({ best_before: addDays(TODAY, -4), state: "expired", days: -4 });
  });

  it("legen gleiche Begriffe zusammen, das dringendste Produkt vorn", () => {
    const cheap = product("Spaghetti 500 g", { brand: "Pastaria" });
    const fancy = product("Barilla Spaghetti n.5", { brand: "Barilla" });
    const rice = product("Basmati Reis");
    const candidates = candidatesOf([cheap, fancy, rice], [pkg(cheap, 200), pkg(fancy, 3), pkg(rice, 100)]);
    expect(candidates.map((candidate) => candidate.term)).toEqual(["Spaghetti", "Basmati Reis"]);
    expect(candidates[0]).toMatchObject({ key: fancy.id, product_ids: [fancy.id, cheap.id], title: "Barilla Spaghetti n.5", state: "soon" });
  });

  it("lassen Platzhalter, Gelöschtes und Produkte ohne Bestand weg", () => {
    const placeholder = product("", { barcodes: ["4006381333931"], lookup: "pending" });
    const empty = product("Mehl");
    const real = product("Zucker");
    const candidates = candidatesOf([placeholder, empty, real], [pkg(placeholder, 1), pkg(real, null)]);
    expect(candidates.map((candidate) => candidate.term)).toEqual(["Zucker"]);
    expect(candidates[0]).toMatchObject({ best_before: null, state: "none", days: null });
  });
});

describe("Vorwahl", () => {
  const items = ["A", "B", "C", "D"].map((name) => product(`Zutat ${name}`));
  const withDays = (days: (number | null)[]) => candidatesOf(items, items.map((item, index) => pkg(item, days[index] ?? null)));

  it("wählt zwei bis drei vor: alle dringenden, höchstens drei, sonst die mit dem nächsten MHD", () => {
    expect(preselect(withDays([1, 2, 3, 4]))).toHaveLength(3);
    expect(preselect(withDays([1, -2, 100, 200])).map((candidate) => candidate.state)).toEqual(["soon", "expired"]);
    // Nur eine dringende: dazu die mit dem nächsten MHD.
    expect(preselect(withDays([1, 100, 50, null])).map((candidate) => candidate.days)).toEqual([1, 50]);
    // Nichts dringend: die zwei mit dem nächsten MHD.
    expect(preselect(withDays([300, 100, 50, null])).map((candidate) => candidate.days)).toEqual([50, 100]);
    expect(preselect([])).toEqual([]);
    expect(preselect(withDays([1, 2, 3, 4]).slice(0, 1))).toHaveLength(1);
  });

  it("nimmt mit ?mit= genau die genannten Produkte, in ihrer Reihenfolge, auch über zusammengelegte Begriffe", () => {
    const candidates = withDays([1, 2, 3, 4]);
    const [first, second, third, fourth] = items.map((item) => item.id) as [string, string, string, string];
    expect(preselect(candidates, [fourth, first]).map((candidate) => candidate.key)).toEqual([fourth, first]);
    // Unbekannte zählen nicht; passt gar keine, gilt die übliche Vorwahl.
    expect(preselect(candidates, [sampleUuid(9, 9), third]).map((candidate) => candidate.key)).toEqual([third]);
    expect(preselect(candidates, [sampleUuid(9, 9)]).map((candidate) => candidate.key)).toEqual([first, second, third]);

    const cheap = product("Spaghetti", { brand: "Pastaria" });
    const fancy = product("Barilla Spaghetti", { brand: "Barilla" });
    const merged = candidatesOf([cheap, fancy], [pkg(cheap, 200), pkg(fancy, 3)]);
    expect(preselect(merged, [cheap.id]).map((candidate) => candidate.term)).toEqual(["Spaghetti"]);
  });

  it("liest ?mit= mit Komma und wiederholt, ohne Leeres und Doppeltes", () => {
    expect(requestedIds("?mit=a,b&mit=c&mit=a&mit=")).toEqual(["a", "b", "c"]);
    expect(requestedIds("")).toEqual([]);
    expect(requestedIds(cookPath(["x", "y"]).slice("/kochen".length))).toEqual(["x", "y"]);
    expect(cookPath()).toBe("/kochen");
  });
});

describe("Zutaten", () => {
  const items = ["Eins", "Zwei", "Drei", "Vier", "Fünf", "Sechs"].map((name) => product(name));
  const candidates = candidatesOf(items, items.map((item, index) => pkg(item, index + 1)));

  it("geben ihre Begriffe an die Suche und ihr erstes Produkt an Claude, höchstens fünf", () => {
    const ingredients = candidates.map((candidate) => ({ candidate, term: candidate.term }));
    expect(ingredientTerms([{ ...ingredients[0]!, term: " Mein Begriff " }, { ...ingredients[1]!, term: "  " }])).toEqual(["Mein Begriff"]);
    expect(focusIds(ingredients)).toEqual(items.slice(0, MAX_INGREDIENTS).map((item) => item.id));
    expect(MAX_INGREDIENTS).toBe(5);
  });

  it("findet Kandidaten über Begriff, Name und Marke", () => {
    expect(matchCandidates(candidates, "fun").map((candidate) => candidate.term)).toEqual(["Fünf"]);
    expect(matchCandidates(candidates, "")).toHaveLength(candidates.length);
    const oats = product("Haferflocken zart", { brand: "Mühlenglück", quantity: "500 g" });
    const branded = candidatesOf([oats], [pkg(oats, 1)]);
    expect(branded.map((candidate) => candidate.term)).toEqual(["Haferflocken zart"]);
    // Die Marke steht nicht im Begriff, ist aber zu finden; Umlaute wie im Suchfeld des Bestands.
    expect(matchCandidates(branded, "muhlen gluck")).toHaveLength(1);
    expect(matchCandidates(branded, "500")).toHaveLength(1);
    expect(matchCandidates(branded, "Reis")).toEqual([]);
  });
});
