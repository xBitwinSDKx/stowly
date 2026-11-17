/**
 * „Online abfragen": die Gegenüberstellung je Feld (docs/plan-0.5.md, 2).
 */
import { describe, expect, it } from "vitest";

import { compareLookup } from "./LookupCompare";

const FORM = { name: "Basmati Reis", brand: "Kornhaus", quantity: "1 kg", image: null };

describe("compareLookup", () => {
  it("stellt Name, Marke, Größe und Bild gegenüber und hakt Abweichendes vor", () => {
    expect(compareLookup(FORM, { name: "Basmati-Reis Langkorn", brand: "Kornhaus", quantity: "1000 g", image_id: "bild-1" })).toEqual([
      { field: "name", label: "Name", current: "Basmati Reis", offered: "Basmati-Reis Langkorn", differs: true },
      { field: "brand", label: "Marke", current: "Kornhaus", offered: "Kornhaus", differs: false },
      { field: "quantity", label: "Packungsgröße", current: "1 kg", offered: "1000 g", differs: true },
      { field: "image", label: "Bild", current: "", offered: "bild-1", differs: true },
    ]);
  });

  it("bietet leere Werte von Open Food Facts nie an: So wird nichts gelöscht", () => {
    expect(compareLookup(FORM, { name: "  ", brand: "", quantity: "1 kg", image_id: null })).toEqual([{ field: "quantity", label: "Packungsgröße", current: "1 kg", offered: "1 kg", differs: false }]);
    expect(compareLookup(FORM, { name: "", brand: "", quantity: "", image_id: null })).toEqual([]);
  });

  it("vergleicht ohne Leerraum am Rand, und dasselbe Bild weicht nicht ab", () => {
    const rows = compareLookup({ name: " Haferflocken ", brand: "", quantity: "500 g", image: "bild-2" }, { name: "Haferflocken", brand: "Mühlenglück ", quantity: "500 g", image_id: "bild-2" });
    expect(rows.map((row) => [row.field, row.differs])).toEqual([
      ["name", false],
      ["brand", true],
      ["quantity", false],
      ["image", false],
    ]);
    expect(rows[1]?.offered).toBe("Mühlenglück");
    // Ein Platzhalter (noch ohne Namen) bekommt den Namen vorgehakt.
    expect(compareLookup({ ...FORM, name: "" }, { name: "Bio Haferdrink", brand: "", quantity: "", image_id: null })).toEqual([
      { field: "name", label: "Name", current: "", offered: "Bio Haferdrink", differs: true },
    ]);
  });
});
