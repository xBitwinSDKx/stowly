/**
 * Etiketten gestalten: die reine Logik der Seite, ohne React (docs/plan-0.5.md, 1).
 *
 * Eine Gestaltung (`LabelDesign`) hat ein Papier für alle Drucker und je Etikettenart ein
 * `LabelLayout`. Die Felder darin stehen in der Reihenfolge auf dem Etikett; was fehlt, ist aus.
 * Die Seite zeigt erst die eingeschalteten Felder in dieser Reihenfolge, darunter die übrigen.
 */
import type { LabelDesign, LabelField, LabelFieldName, LabelKind, LabelLayout, LabelPaper, LabelQrSide, LabelSize, ServicePaper } from "@/contract";

/**
 * Grenzen und Takt aus dem Vertrag des Servers (server/stowly/contract/api.py: `LABEL_LENGTH_MIN_MM`,
 * `LABEL_LENGTH_MAX_MM`, `LABEL_TITLE_LINES_MAX`, `LABEL_PREVIEW_DEBOUNCE_MS`, `LABEL_PREVIEWS_AT_ONCE`).
 * Sie stehen nicht in api.gen.ts; der Papier-Katalog kommt vom Server, das schont das Bündel.
 */
export const LENGTH_MIN_MM = 25;
export const LENGTH_MAX_MM = 100;
export const TITLE_LINES_MAX = 3;
export const PREVIEW_DEBOUNCE_MS = 300;
export const PREVIEWS_AT_ONCE = 2;

/** Die Länge auf einer Endlosrolle, wenn vorher kein Wert da war (die Vorgabe: 29 mm). */
export const DEFAULT_LENGTH_MM = 29;

/** Die Felder je Etikettenart in der Reihenfolge, in der ausgeschaltete Felder unten stehen. */
export const KIND_FIELDS: Record<LabelKind, readonly LabelFieldName[]> = {
  package: ["title", "subtitle", "quantity", "brand", "best_before", "stored", "id", "zone", "text"],
  zone: ["title", "subtitle", "text"],
};

const PACKAGE_LABELS: Record<LabelFieldName, string> = {
  title: "Produktname",
  subtitle: "Größe · Marke",
  quantity: "Packungsgröße",
  brand: "Marke",
  best_before: "MHD",
  stored: "Eingelagert am",
  id: "Packungs-ID",
  zone: "Zone",
  text: "Eigener Text",
};

/** Der Name eines Felds in der Liste. */
export function fieldLabel(kind: LabelKind, field: LabelFieldName): string {
  if (kind === "zone" && field === "title") {
    return "Name der Zone";
  }
  if (kind === "zone" && field === "subtitle") {
    return "„Lagerzone“";
  }
  return PACKAGE_LABELS[field];
}

export const SIZE_OPTIONS: readonly { value: LabelSize; label: string }[] = [
  { value: "s", label: "klein" },
  { value: "m", label: "mittel" },
  { value: "l", label: "groß" },
];

export const SIDE_OPTIONS: readonly { value: LabelQrSide; label: string }[] = [
  { value: "left", label: "links" },
  { value: "right", label: "rechts" },
];

/** Ein eingeschaltetes Feld mit seiner Vorgabe: der Name mittel und zweizeilig, MHD und ID mittel, der Rest klein. */
export function newField(field: LabelFieldName): LabelField {
  if (field === "title") {
    return { field, size: "m", lines: 2 };
  }
  return { field, size: field === "best_before" || field === "id" ? "m" : "s", lines: null };
}

/** Eine Zeile der Liste: eingeschaltet mit Platz auf dem Etikett, oder aus. */
export interface FieldRow {
  field: LabelFieldName;
  on: boolean;
  size: LabelSize;
  /** Nur beim Namen: wie viele Zeilen. */
  lines: number | null;
  /** Platz unter den eingeschalteten Feldern; -1 = aus. */
  position: number;
}

/** Die Liste der Felder: erst die eingeschalteten in ihrer Reihenfolge, dann die übrigen. */
export function fieldRows(kind: LabelKind, layout: LabelLayout): FieldRow[] {
  const allowed = KIND_FIELDS[kind];
  const on = layout.fields.filter((entry) => allowed.includes(entry.field));
  const rows: FieldRow[] = on.map((entry, position) => ({ field: entry.field, on: true, size: entry.size, lines: entry.field === "title" ? (entry.lines ?? 1) : null, position }));
  for (const field of allowed) {
    if (!on.some((entry) => entry.field === field)) {
      const fresh = newField(field);
      rows.push({ field, on: false, size: fresh.size, lines: fresh.lines ?? null, position: -1 });
    }
  }
  return rows;
}

/** Schaltet ein Feld an (es kommt ans Ende) oder aus. */
export function toggleField(layout: LabelLayout, field: LabelFieldName, on: boolean): LabelLayout {
  const present = layout.fields.some((entry) => entry.field === field);
  if (on === present) {
    return layout;
  }
  return { ...layout, fields: on ? [...layout.fields, newField(field)] : layout.fields.filter((entry) => entry.field !== field) };
}

/** Verschiebt ein eingeschaltetes Feld um einen Platz nach oben (-1) oder unten (1). */
export function moveField(layout: LabelLayout, field: LabelFieldName, step: -1 | 1): LabelLayout {
  const index = layout.fields.findIndex((entry) => entry.field === field);
  const target = index + step;
  if (index === -1 || target < 0 || target >= layout.fields.length) {
    return layout;
  }
  const fields = [...layout.fields];
  [fields[index], fields[target]] = [fields[target] as LabelField, fields[index] as LabelField];
  return { ...layout, fields };
}

export function setFieldSize(layout: LabelLayout, field: LabelFieldName, size: LabelSize): LabelLayout {
  return { ...layout, fields: layout.fields.map((entry) => (entry.field === field ? { ...entry, size } : entry)) };
}

export function setTitleLines(layout: LabelLayout, lines: number): LabelLayout {
  const clamped = Math.min(TITLE_LINES_MAX, Math.max(1, Math.round(lines)));
  return { ...layout, fields: layout.fields.map((entry) => (entry.field === "title" ? { ...entry, lines: clamped } : entry)) };
}

function clampLength(length: number): number {
  return Math.min(LENGTH_MAX_MM, Math.max(LENGTH_MIN_MM, Math.round(length)));
}

/**
 * Ein anderes Papier für beide Etikettenarten. Gestanzte Etiketten haben ihre feste Länge
 * (`length_mm: null`); kommt eine Endlosrolle nach gestanzten, behält das Etikett deren Länge.
 */
export function withPaper(design: LabelDesign, paper: LabelPaper, papers: readonly LabelPaper[]): LabelDesign {
  const before = papers.find((candidate) => candidate.id === design.paper);
  const length = (layout: LabelLayout): number | null => {
    if (paper.kind === "die_cut") {
      return null;
    }
    return layout.length_mm ?? clampLength(before?.length_mm ?? DEFAULT_LENGTH_MM);
  };
  return { paper: paper.id, package: { ...design.package, length_mm: length(design.package) }, zone: { ...design.zone, length_mm: length(design.zone) } };
}

/** Länge des Etiketts in Laufrichtung: bei Endlosrollen aus der Gestaltung, bei gestanzten die des Etiketts. */
export function labelLength(paper: LabelPaper, layout: Pick<LabelLayout, "length_mm">): number {
  return paper.kind === "die_cut" ? (paper.length_mm ?? 0) : (layout.length_mm ?? DEFAULT_LENGTH_MM);
}

/** Wird das Etikett gedreht? Dann, wenn es in Laufrichtung länger ist, als die Rolle breit ist (docs/etiketten.md, 3.1). */
export function isRotated(paper: LabelPaper, layout: Pick<LabelLayout, "length_mm">): boolean {
  return labelLength(paper, layout) > paper.width_mm;
}

/**
 * Braucht die Gestaltung Vorlagen im Format 2? Nur die 62-mm-Endlosrolle ohne Drehung bleibt Format 1;
 * das kann auch ein Druckdienst vor 0.5.0 (docs/etiketten.md, 3.4).
 */
export function needsFormat2(design: LabelDesign, paper: LabelPaper | undefined): boolean {
  return paper !== undefined && (paper.id !== "62" || isRotated(paper, design.package) || isRotated(paper, design.zone));
}

/** Gleiche Gestaltung? Fehlende Zeilenangaben zählen wie null. */
export function sameDesign(a: LabelDesign | null, b: LabelDesign | null): boolean {
  const canonical = (design: LabelDesign | null) =>
    design === null
      ? null
      : JSON.stringify([
          design.paper,
          ...[design.package, design.zone].map((layout) => [
            layout.length_mm,
            layout.qr.side,
            layout.qr.size,
            layout.fields.map((entry) => [entry.field, entry.size, entry.lines ?? null]),
            layout.date,
            layout.text,
            layout.divider,
          ]),
        ]);
  return canonical(a) === canonical(b);
}

/** Passt eine eingelegte Rolle zum Papier? Mit Kennung über sie, sonst über Art und Breite. */
export function rollFits(loaded: ServicePaper, paper: LabelPaper): boolean {
  if (loaded.id !== null) {
    return loaded.id === paper.id;
  }
  return loaded.kind === paper.kind && Math.abs(loaded.width_mm - paper.width_mm) <= 1 && (paper.kind === "endless" || loaded.length_mm === null || Math.abs(loaded.length_mm - (paper.length_mm ?? 0)) <= 1);
}

/**
 * Welche Gestaltung ein Satz des Servers meint: Bei 422 nennt er die Stelle in
 * `details.errors[0].loc`, etwa `["body", "zone", "qr", "size"]`. null = keine oder das Papier.
 */
export function layoutOfProblem(details: Readonly<Record<string, unknown>>): LabelKind | null {
  const errors = details.errors;
  const first: unknown = Array.isArray(errors) ? errors[0] : undefined;
  const loc = typeof first === "object" && first !== null ? (first as { loc?: unknown }).loc : undefined;
  const part: unknown = Array.isArray(loc) ? loc[1] : undefined;
  return part === "package" || part === "zone" ? part : null;
}
