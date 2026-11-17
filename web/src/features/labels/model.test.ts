/**
 * Etiketten gestalten: die reine Logik der Seite (docs/plan-0.5.md, 1).
 */
import { describe, expect, it } from "vitest";

import type { LabelDesign, LabelLayout, LabelPaper } from "@/contract";

import { fieldRows, isRotated, layoutOfProblem, moveField, needsFormat2, newField, rollFits, sameDesign, setFieldSize, setTitleLines, toggleField, withPaper } from "./model";

const PAPERS: LabelPaper[] = [
  { id: "29", kind: "endless", name: "29 mm endlos", width_mm: 29, length_mm: null, printable_width_px: 306, printable_length_px: null },
  { id: "62", kind: "endless", name: "62 mm endlos", width_mm: 62, length_mm: null, printable_width_px: 696, printable_length_px: null },
  { id: "29x90", kind: "die_cut", name: "29 × 90 mm gestanzt", width_mm: 29, length_mm: 90, printable_width_px: 306, printable_length_px: 991 },
  { id: "62x29", kind: "die_cut", name: "62 × 29 mm gestanzt", width_mm: 62, length_mm: 29, printable_width_px: 696, printable_length_px: 271 },
];

const paper = (id: string) => PAPERS.find((candidate) => candidate.id === id) as LabelPaper;

const LAYOUT: LabelLayout = {
  length_mm: 29,
  qr: { side: "left", size: "l" },
  fields: [
    { field: "title", size: "m", lines: 2 },
    { field: "best_before", size: "m", lines: null },
    { field: "id", size: "l", lines: null },
  ],
  date: "long",
  text: "",
  divider: true,
};

const DESIGN: LabelDesign = { paper: "62", package: LAYOUT, zone: { ...LAYOUT, fields: [{ field: "title", size: "l", lines: 2 }] } };

describe("Felder", () => {
  it("zeigt erst die eingeschalteten in ihrer Reihenfolge, dann die übrigen", () => {
    const rows = fieldRows("package", LAYOUT);
    expect(rows.map((row) => [row.field, row.on, row.position])).toEqual([
      ["title", true, 0],
      ["best_before", true, 1],
      ["id", true, 2],
      ["subtitle", false, -1],
      ["quantity", false, -1],
      ["brand", false, -1],
      ["stored", false, -1],
      ["zone", false, -1],
      ["text", false, -1],
    ]);
    expect(rows[0]).toMatchObject({ size: "m", lines: 2 });
    // Zonen-Etiketten kennen nur Name, „Lagerzone" und den eigenen Text.
    expect(fieldRows("zone", DESIGN.zone).map((row) => row.field)).toEqual(["title", "subtitle", "text"]);
  });

  it("schaltet an (ans Ende, mit Vorgabe) und aus", () => {
    const on = toggleField(LAYOUT, "zone", true);
    expect(on.fields.at(-1)).toEqual({ field: "zone", size: "s", lines: null });
    expect(toggleField(on, "zone", true)).toBe(on);
    expect(toggleField(on, "best_before", false).fields.map((field) => field.field)).toEqual(["title", "id", "zone"]);
    expect(newField("title")).toEqual({ field: "title", size: "m", lines: 2 });
    expect(newField("id")).toEqual({ field: "id", size: "m", lines: null });
  });

  it("ordnet mit Pfeilen um, nie über den Rand hinaus", () => {
    expect(moveField(LAYOUT, "id", -1).fields.map((field) => field.field)).toEqual(["title", "id", "best_before"]);
    expect(moveField(LAYOUT, "title", 1).fields.map((field) => field.field)).toEqual(["best_before", "title", "id"]);
    expect(moveField(LAYOUT, "title", -1)).toBe(LAYOUT);
    expect(moveField(LAYOUT, "id", 1)).toBe(LAYOUT);
    expect(moveField(LAYOUT, "zone", 1)).toBe(LAYOUT);
  });

  it("setzt die Größe je Feld und beim Namen 1 bis 3 Zeilen", () => {
    expect(setFieldSize(LAYOUT, "id", "s").fields[2]).toEqual({ field: "id", size: "s", lines: null });
    expect(setTitleLines(LAYOUT, 3).fields[0]?.lines).toBe(3);
    expect(setTitleLines(LAYOUT, 9).fields[0]?.lines).toBe(3);
    expect(setTitleLines(LAYOUT, 0).fields[0]?.lines).toBe(1);
  });
});

describe("Papier", () => {
  it("gibt gestanzten Etiketten ihre feste Länge und Endlosrollen danach eine Länge zurück", () => {
    const dieCut = withPaper(DESIGN, paper("62x29"), PAPERS);
    expect(dieCut).toMatchObject({ paper: "62x29", package: { length_mm: null }, zone: { length_mm: null } });
    // Von 29 × 90 gestanzt auf 29 mm endlos: Das Etikett bleibt 90 mm lang.
    const tall = withPaper({ ...dieCut, paper: "29x90" }, paper("29"), PAPERS);
    expect(tall).toMatchObject({ paper: "29", package: { length_mm: 90 }, zone: { length_mm: 90 } });
    // Zwischen Endlosrollen bleibt die Länge.
    expect(withPaper({ ...DESIGN, package: { ...LAYOUT, length_mm: 50 } }, paper("29"), PAPERS).package.length_mm).toBe(50);
  });

  it("weiß, wann gedreht wird und wann eine Vorlage Format 2 braucht", () => {
    expect(isRotated(paper("62"), { length_mm: 62 })).toBe(false);
    expect(isRotated(paper("62"), { length_mm: 63 })).toBe(true);
    expect(isRotated(paper("29"), { length_mm: 29 })).toBe(false);
    expect(isRotated(paper("29x90"), { length_mm: null })).toBe(true);
    expect(needsFormat2(DESIGN, paper("62"))).toBe(false);
    expect(needsFormat2({ ...DESIGN, zone: { ...DESIGN.zone, length_mm: 70 } }, paper("62"))).toBe(true);
    expect(needsFormat2({ ...DESIGN, paper: "29" }, paper("29"))).toBe(true);
    expect(needsFormat2({ ...DESIGN, paper: "62x29" }, paper("62x29"))).toBe(true);
    expect(needsFormat2(DESIGN, undefined)).toBe(false);
  });

  it("vergleicht Gestaltungen nach Inhalt, fehlende Zeilen wie null", () => {
    expect(sameDesign(DESIGN, JSON.parse(JSON.stringify(DESIGN)) as LabelDesign)).toBe(true);
    const withoutLines = { ...DESIGN, package: { ...LAYOUT, fields: LAYOUT.fields.map(({ lines, ...rest }) => (lines === null ? rest : { ...rest, lines })) } };
    expect(sameDesign(DESIGN, withoutLines)).toBe(true);
    expect(sameDesign(DESIGN, { ...DESIGN, package: { ...LAYOUT, text: "x" } })).toBe(false);
    expect(sameDesign(DESIGN, null)).toBe(false);
  });

  it("vergleicht eine eingelegte Rolle mit dem Papier", () => {
    expect(rollFits({ id: "62", kind: "endless", width_mm: 62, length_mm: null }, paper("62"))).toBe(true);
    expect(rollFits({ id: "62", kind: "endless", width_mm: 62, length_mm: null }, paper("62x29"))).toBe(false);
    // Ohne Kennung über Art und Maße.
    expect(rollFits({ id: null, kind: "die_cut", width_mm: 62, length_mm: 29 }, paper("62x29"))).toBe(true);
    expect(rollFits({ id: null, kind: "endless", width_mm: 29, length_mm: null }, paper("62"))).toBe(false);
  });
});

describe("Sätze des Servers", () => {
  it("liest aus der Stelle eines 422, welche Gestaltung gemeint ist", () => {
    expect(layoutOfProblem({ errors: [{ loc: ["body", "zone", "qr", "size"], msg: "…", type: "label_design" }] })).toBe("zone");
    expect(layoutOfProblem({ errors: [{ loc: ["body", "package", "fields", "2"] }] })).toBe("package");
    expect(layoutOfProblem({ errors: [{ loc: ["body", "paper"] }] })).toBeNull();
    expect(layoutOfProblem({ errors: [{ loc: ["body", "layout", "qr"] }] })).toBeNull();
    expect(layoutOfProblem({ status: 422 })).toBeNull();
    expect(layoutOfProblem({ errors: "kaputt" })).toBeNull();
  });
});
