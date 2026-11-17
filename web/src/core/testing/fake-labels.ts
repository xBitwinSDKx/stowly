/**
 * Etiketten gestalten, nachgebaut für die Nachbildungen von Server und Druckdienst
 * (docs/plan-0.5.md, 1; docs/etiketten.md, 3.1 bis 3.4):
 *
 * - der Papier-Katalog, abgeschrieben aus print/stowly_print/media.py;
 * - eine Vorgabe der Gestaltung, die zu den mitgelieferten Vorlagen passt;
 * - eine Vorlage aus einer Gestaltung: Format, Papier, Drehung und `hash` wie beim Server,
 *   aber ohne Elemente (die Nachbildung des Druckdienstes rendert nichts);
 * - Bilder in der Größe des Papiers, als 1-Bit-PNG.
 *
 * MASSGEBLICH IST DER SERVER (server/stowly/labels.py). Die Prüfung beim Speichern kennt hier die
 * Form der Gestaltung, die Größe des QR-Codes, den Platz daneben und eine grobe Schätzung der Höhe der
 * Felder (`fakeLayoutProblem`), mit den Sätzen des Servers; gerendert wird nichts.
 *
 * Ohne DOM und ohne Node: läuft in den Tests (jsdom) und im Entwicklungsserver.
 */
import { LIMITS, type LabelDesign, type LabelField, type LabelKind, type LabelLayout, type LabelPaper, type LabelSize } from "@/contract/api.gen";

const DPI = 300;
const MM_PER_INCH = 25.4;

/** Länge eines Etiketts auf einer Endlosrolle (`ENDLESS_LENGTH_MIN_MM` und `…_MAX_MM` in media.py). */
export const FAKE_LENGTH_MIN_MM = 25;
export const FAKE_LENGTH_MAX_MM = 100;

function mm(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value).replace(".", ",");
}

function endless(width: number, printable: number): LabelPaper {
  return { id: String(width), kind: "endless", name: `${width} mm endlos`, width_mm: width, length_mm: null, printable_width_px: printable, printable_length_px: null };
}

function dieCut(id: string, width: number, length: number, printableWidth: number, printableLength: number): LabelPaper {
  return {
    id,
    kind: "die_cut",
    name: `${mm(width)} × ${mm(length)} mm gestanzt`,
    width_mm: width,
    length_mm: length,
    printable_width_px: printableWidth,
    printable_length_px: printableLength,
  };
}

/** Der Katalog in der Reihenfolge der App (`PAPERS` in media.py). */
export const FAKE_PAPERS: readonly LabelPaper[] = [
  endless(18, 234),
  endless(29, 306),
  endless(38, 413),
  endless(50, 554),
  endless(54, 590),
  endless(62, 696),
  dieCut("17x54", 17, 54, 165, 566),
  dieCut("17x87", 17, 87, 165, 956),
  dieCut("23x23", 23, 23, 202, 202),
  dieCut("29x42", 29, 42, 306, 425),
  dieCut("29x90", 29, 90, 306, 991),
  dieCut("39x90", 38, 90, 413, 991),
  dieCut("39x48", 39, 48, 425, 495),
  dieCut("52x29", 52, 29, 578, 271),
  dieCut("54x29", 54, 29, 598, 271),
  dieCut("60x86", 60, 87, 672, 954),
  dieCut("62x29", 62, 29, 696, 271),
  dieCut("62x100", 62, 100, 696, 1109),
];

export function fakePaper(id: string | null | undefined): LabelPaper | undefined {
  return FAKE_PAPERS.find((paper) => paper.id === id);
}

/** Ganze Punkte bei 300 dpi, die in eine Länge passen (29 mm sind 342). */
export function mmToPx(length: number): number {
  return Math.floor((length * DPI) / MM_PER_INCH + 1e-6);
}

/** Länge des Etiketts in Laufrichtung: bei Endlosrollen aus der Gestaltung, bei gestanzten die des Etiketts. */
export function labelLength(paper: LabelPaper, lengthMm: number | null): number {
  return paper.kind === "die_cut" ? (paper.length_mm ?? 0) : (lengthMm ?? 29);
}

/** Ist das Etikett in Laufrichtung länger, als die Rolle breit ist? Dann dreht der Renderer um 90°. */
export function isRotated(paper: LabelPaper, lengthMm: number | null): boolean {
  return labelLength(paper, lengthMm) > paper.width_mm;
}

/**
 * Größe des Bilds in Pixeln. `reading`: so, wie man es liest (Vorschau, `/v1/render`); sonst so,
 * wie es an den Treiber geht (quer × längs, auch beim Bild-Treiber).
 */
export function imageSize(paper: LabelPaper, lengthMm: number | null, reading: boolean): { width: number; height: number } {
  const across = paper.printable_width_px;
  const along = paper.kind === "die_cut" ? (paper.printable_length_px ?? 0) : mmToPx(labelLength(paper, lengthMm));
  return reading && isRotated(paper, lengthMm) ? { width: along, height: across } : { width: across, height: along };
}

/** Die Vorgabe der Nachbildung wie `DEFAULT_DESIGN` in server/stowly/labels.py: die mitgelieferten Vorlagen, 62 mm endlos, 29 mm lang. */
export const FAKE_DEFAULT_DESIGN: LabelDesign = {
  paper: "62",
  package: {
    length_mm: 29,
    qr: { side: "left", size: "m" },
    fields: [
      { field: "title", size: "m", lines: 2 },
      { field: "subtitle", size: "m", lines: null },
      { field: "best_before", size: "m", lines: null },
      { field: "id", size: "m", lines: null },
      { field: "stored", size: "s", lines: null },
    ],
    date: "long",
    text: "",
    divider: true,
  },
  zone: {
    length_mm: 29,
    qr: { side: "left", size: "l" },
    fields: [
      { field: "title", size: "l", lines: 2 },
      { field: "subtitle", size: "m", lines: null },
    ],
    date: "long",
    text: "",
    divider: true,
  },
};

/** Ist das die Vorgabe? Dann gibt es keine eigene Gestaltung (wie beim Server). Fehlende Zeilen zählen wie null. */
export function isFakeDefault(design: LabelDesign): boolean {
  const canonical = (value: LabelDesign) =>
    JSON.stringify([value.paper, ...[value.package, value.zone].map((layout) => ({ ...layout, fields: layout.fields.map((field) => ({ ...field, lines: field.lines ?? null })) }))]);
  return canonical(design) === canonical(FAKE_DEFAULT_DESIGN);
}

const ZONE_FIELDS: ReadonlySet<string> = new Set(["title", "subtitle", "text"]);
const PACKAGE_FIELDS: ReadonlySet<string> = new Set(["title", "subtitle", "quantity", "brand", "best_before", "stored", "id", "zone", "text"]);
const SIZES: ReadonlySet<string> = new Set(["s", "m", "l"]);
/** Höhe einer Zeile je Größe in Millimetern: eine grobe Regel der Nachbildung. */
const LINE_MM: Record<LabelSize, number> = { s: 3, m: 4.5, l: 6 };

/** Sätze, mit denen die Nachbildung ablehnt, wie in server/stowly/labels.py. */
export const FAKE_TOO_SHORT = "Für so viele Felder ist das Etikett zu kurz: ein Feld weglassen, kleiner wählen oder länger machen.";
export const FAKE_QR_TOO_LARGE = "Der QR-Code ist für dieses Etikett zu groß: kleiner wählen oder das Etikett länger machen.";

/** Kante des QR-Codes in mm je Größe, wie `QR_SIZES` beim Server. */
const QR_MM: Record<LabelKind, Record<LabelSize, number>> = {
  package: { s: 14, m: 24, l: 28 },
  zone: { s: 18.5, m: 23, l: 27 },
};

/** Höhe der Felder in Millimetern; Packungs-ID und Einlagerdatum direkt nacheinander teilen sich eine Zeile. */
function fieldsHeight(fields: readonly LabelField[]): number {
  let height = 0;
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] as LabelField;
    const next = fields[index + 1];
    if (next && ((field.field === "id" && next.field === "stored") || (field.field === "stored" && next.field === "id"))) {
      height += Math.max(LINE_MM[field.size], LINE_MM[next.size]);
      index += 1;
      continue;
    }
    height += LINE_MM[field.size] * (field.field === "title" ? (field.lines ?? 1) : 1);
  }
  return height;
}

/** Was an einer Gestaltung nicht passt, als Satz; null = passt. */
export function fakeLayoutProblem(kind: LabelKind, paperId: unknown, layout: unknown): string | null {
  const paper = fakePaper(typeof paperId === "string" ? paperId : null);
  if (!paper) {
    return "Dieses Papier kennt Stowly nicht.";
  }
  const value = layout as Partial<LabelLayout> | null;
  if (typeof value !== "object" || value === null || !Array.isArray(value.fields) || typeof value.qr !== "object" || value.qr === null) {
    return "Die Gestaltung ist unvollständig.";
  }
  if (paper.kind === "endless") {
    if (typeof value.length_mm !== "number" || !Number.isInteger(value.length_mm) || value.length_mm < FAKE_LENGTH_MIN_MM || value.length_mm > FAKE_LENGTH_MAX_MM) {
      return `Auf einer Endlosrolle ist ein Etikett ${FAKE_LENGTH_MIN_MM} bis ${FAKE_LENGTH_MAX_MM} mm lang.`;
    }
  } else if (value.length_mm !== null) {
    return "Gestanzte Etiketten haben eine feste Länge.";
  }
  if (!["left", "right"].includes(String(value.qr.side)) || !SIZES.has(String(value.qr.size))) {
    return "Seite oder Größe des QR-Codes stimmt nicht.";
  }
  if (!["long", "short"].includes(String(value.date)) || typeof value.divider !== "boolean") {
    return "Datum oder Trennlinie stimmt nicht.";
  }
  if (typeof value.text !== "string" || value.text.length > LIMITS.label_text) {
    return `Der eigene Text ist zu lang (höchstens ${LIMITS.label_text} Zeichen).`;
  }
  const allowed = kind === "zone" ? ZONE_FIELDS : PACKAGE_FIELDS;
  const seen = new Set<string>();
  for (const field of value.fields) {
    if (!allowed.has(field.field) || seen.has(field.field) || !SIZES.has(field.size)) {
      return "Ein Feld steht doppelt oder gehört nicht auf dieses Etikett.";
    }
    seen.add(field.field);
    const lines = field.lines ?? null;
    if (lines !== null && (field.field !== "title" || !Number.isInteger(lines) || lines < 1 || lines > 3)) {
      return "Zeilen gibt es nur beim Namen, 1 bis 3.";
    }
  }
  // Zeichenfläche in Leserichtung in mm, wie `area_of` beim Server; dann QR-Code, Platz daneben, Höhe.
  const size = imageSize(paper, value.length_mm, true);
  const width = Math.round((size.width * MM_PER_INCH * 10) / DPI) / 10;
  const height = Math.round((size.height * MM_PER_INCH * 10) / DPI) / 10;
  const longer = paper.kind === "endless" && !isRotated(paper, value.length_mm);
  const smallest = QR_MM[kind].s;
  const qr = QR_MM[kind][value.qr.size as LabelSize];
  if (smallest > height || smallest + 1 > width) {
    return "Auf dieses Papier passt kein QR-Code, der sich sicher scannen lässt: ein breiteres Papier nehmen.";
  }
  if (qr > height || qr + 1 > width) {
    return longer ? FAKE_QR_TOO_LARGE : "Der QR-Code ist für dieses Etikett zu groß: kleiner wählen oder ein größeres Papier nehmen.";
  }
  if (value.fields.length > 0 && width - 1 - qr - 1.5 < 12) {
    return "Neben dem QR-Code bleibt zu wenig Platz für die Felder: QR-Code kleiner wählen, alle Felder ausschalten oder ein größeres Etikett nehmen.";
  }
  return fieldsHeight(value.fields) > height - 2.3 ? (longer ? FAKE_TOO_SHORT : "Für so viele Felder ist das Etikett zu klein: ein Feld weglassen oder kleiner wählen.") : null;
}

/** 16 Hex-Zeichen über einen Text (zweimal FNV-1a): fest für denselben Text, wie `template_hash`. */
export function fakeHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x01000193 + 2) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/**
 * Die Vorlage einer Etikettenart aus einer Gestaltung: Format 1 für die 62-mm-Endlosrolle ohne
 * Drehung, sonst Format 2 mit `media` und `rotate` (docs/etiketten.md, 3.4). Elemente gibt es keine;
 * die Gestaltung steht nur in der Nachbildung mit darin, damit sich der `hash` mit ihr ändert.
 */
export function fakeTemplate(kind: LabelKind, design: LabelDesign): Record<string, unknown> {
  const paper = fakePaper(design.paper) ?? (fakePaper("62") as LabelPaper);
  const layout = design[kind];
  const turned = isRotated(paper, layout.length_mm);
  const schema = paper.id === "62" && !turned ? 1 : 2;
  return {
    schema,
    name: kind,
    media: { id: paper.id, kind: paper.kind, width_mm: paper.width_mm, length_mm: labelLength(paper, layout.length_mm) },
    ...(schema === 2 ? { rotate: turned ? 90 : 0 } : {}),
    elements: [],
    layout,
  };
}

// ------------------------------------------------------------------------------------------
// PNG
// ------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Ein Block des PNG: Länge, Art, Daten, Prüfsumme. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index += 1) {
    out[4 + index] = type.charCodeAt(index);
  }
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Rohdaten als zlib-Strom aus ungepackten Blöcken: kein Packen nötig, und jeder Leser versteht es. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(raw.length / 65_535));
  const out = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let at = 2;
  for (let index = 0; index < blocks; index += 1) {
    const block = raw.subarray(index * 65_535, (index + 1) * 65_535);
    out[at] = index === blocks - 1 ? 1 : 0;
    out[at + 1] = block.length & 0xff;
    out[at + 2] = block.length >>> 8;
    out[at + 3] = ~block.length & 0xff;
    out[at + 4] = (~block.length >>> 8) & 0xff;
    out.set(block, at + 5);
    at += 5 + block.length;
  }
  let a = 1;
  let b = 0;
  for (const byte of raw) {
    a = (a + byte) % 65_521;
    b = (b + a) % 65_521;
  }
  new DataView(out.buffer).setUint32(at, ((b << 16) | a) >>> 0);
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Ein 1-Bit-PNG (weiß, schwarzer Rahmen von 2 Pixeln) in der gewünschten Größe: der Platzhalter der
 * Nachbildung für jedes „gerenderte" Etikett. `pixel` kann einzelne Punkte schwarz färben.
 */
export function framePng(width: number, height: number, pixel?: (x: number, y: number) => boolean): Uint8Array {
  const rowBytes = Math.ceil(width / 8);
  const raw = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (rowBytes + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const black = x < 2 || y < 2 || x >= width - 2 || y >= height - 2 || (pixel?.(x, y) ?? false);
      if (!black) {
        const index = row + 1 + (x >> 3);
        raw[index] = (raw[index] as number) | (0x80 >> (x & 7));
      }
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 1; // 1 Bit je Punkt, Graustufen (Farbtyp 0)
  return concat([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", zlibStored(raw)), chunk("IEND", new Uint8Array(0))]);
}

/** Bytes als Base64, ohne Node. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
