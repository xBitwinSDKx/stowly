/**
 * Etiketten gestalten in der Attrappe (seit 0.5.0; docs/plan-0.5.md, 1): der Papier-Katalog
 * (abgeschrieben aus print/stowly_print/media.py), die Vorgabe, eine grobe Prüfung und eine
 * gezeichnete Vorschau.
 *
 * Die Vorschau ist kein echtes Etikett: ein 1-Bit-Bild in der Größe des Papiers (so, wie man es
 * liest) mit Rahmen, einem gemusterten Quadrat an der Stelle des QR-Codes und je Feld einem Balken
 * in seiner Größe. So zeigt sie trotzdem, was eine Änderung bewirkt. Maßgeblich ist der Server
 * (server/stowly/labels.py); die Sätze hier sind eigene.
 */
import { LIMITS, type LabelDesign, type LabelField, type LabelKind, type LabelLayout, type LabelPaper, type LabelPreview, type LabelSize } from "@/contract";

function mm(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value).replace(".", ",");
}

function endless(width: number, printable: number): LabelPaper {
  return { id: String(width), kind: "endless", name: `${width} mm endlos`, width_mm: width, length_mm: null, printable_width_px: printable, printable_length_px: null };
}

function dieCut(id: string, width: number, length: number, printableWidth: number, printableLength: number): LabelPaper {
  return { id, kind: "die_cut", name: `${mm(width)} × ${mm(length)} mm gestanzt`, width_mm: width, length_mm: length, printable_width_px: printableWidth, printable_length_px: printableLength };
}

/** Der Katalog in der Reihenfolge der App. */
export const MOCK_PAPERS: readonly LabelPaper[] = [
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

export function mockPaper(id: string): LabelPaper | undefined {
  return MOCK_PAPERS.find((paper) => paper.id === id);
}

/** Die Vorgabe wie `DEFAULT_DESIGN` in server/stowly/labels.py: die mitgelieferten Vorlagen, 62 mm endlos, 29 mm lang. */
export const MOCK_DEFAULT_DESIGN: LabelDesign = {
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
export function isMockDefault(design: LabelDesign): boolean {
  const canonical = (value: LabelDesign) =>
    JSON.stringify([value.paper, ...[value.package, value.zone].map((layout) => ({ ...layout, fields: layout.fields.map((field) => ({ ...field, lines: field.lines ?? null })) }))]);
  return canonical(design) === canonical(MOCK_DEFAULT_DESIGN);
}

/** "labels-custom": eine eigene Gestaltung auf der 62-mm-Rolle, 50 mm lang, QR-Code rechts. */
export const MOCK_CUSTOM_DESIGN: LabelDesign = {
  paper: "62",
  package: {
    length_mm: 50,
    qr: { side: "right", size: "m" },
    fields: [
      { field: "title", size: "l", lines: 3 },
      { field: "brand", size: "s", lines: null },
      { field: "best_before", size: "l", lines: null },
      { field: "zone", size: "s", lines: null },
      { field: "text", size: "s", lines: null },
      { field: "id", size: "m", lines: null },
      { field: "stored", size: "s", lines: null },
    ],
    date: "short",
    text: "Bitte zuerst aufbrauchen",
    divider: true,
  },
  zone: { ...MOCK_DEFAULT_DESIGN.zone, qr: { side: "right", size: "m" } },
};

/**
 * "labels-die-cut": gestanzte Etiketten 62 × 29 mm (Format 2). Bedruckbar sind dort nur knapp 23 mm
 * Höhe: kleiner QR-Code und weniger Zeilen als die Vorgabe (mit der lehnt der Server ab).
 */
export const MOCK_DIE_CUT_DESIGN: LabelDesign = {
  paper: "62x29",
  package: {
    ...MOCK_DEFAULT_DESIGN.package,
    length_mm: null,
    qr: { side: "left", size: "s" },
    fields: [
      { field: "title", size: "m", lines: 2 },
      { field: "best_before", size: "s", lines: null },
      { field: "id", size: "s", lines: null },
      { field: "stored", size: "s", lines: null },
    ],
  },
  zone: { ...MOCK_DEFAULT_DESIGN.zone, length_mm: null, qr: { side: "left", size: "s" } },
};

/** "pi-outdated": 29 mm endlos, 50 mm lang (gedreht, Format 2); die Zone mit mittlerem QR-Code. */
export const MOCK_NARROW_DESIGN: LabelDesign = {
  paper: "29",
  package: { ...MOCK_DEFAULT_DESIGN.package, length_mm: 50 },
  zone: { ...MOCK_DEFAULT_DESIGN.zone, length_mm: 50, qr: { side: "left", size: "m" } },
};

/** Länge in Laufrichtung: bei Endlosrollen aus der Gestaltung, bei gestanzten die des Etiketts. */
function lengthOf(paper: LabelPaper, layout: Pick<LabelLayout, "length_mm">): number {
  return paper.kind === "die_cut" ? (paper.length_mm ?? 0) : (layout.length_mm ?? 29);
}

/** Wird das Etikett gedreht (länger, als die Rolle breit ist)? */
export function mockRotated(paper: LabelPaper, layout: Pick<LabelLayout, "length_mm">): boolean {
  return lengthOf(paper, layout) > paper.width_mm;
}

/** Das Format der Vorlage, die der Server aus dieser Gestaltung erzeugte (docs/etiketten.md, 3.4). */
export function mockSchema(design: LabelDesign): number {
  const paper = mockPaper(design.paper);
  if (!paper) {
    return 1;
  }
  return paper.id === "62" && !mockRotated(paper, design.package) && !mockRotated(paper, design.zone) ? 1 : 2;
}

const ZONE_FIELDS: ReadonlySet<string> = new Set(["title", "subtitle", "text"]);
const LINE_MM: Record<LabelSize, number> = { s: 3, m: 4.5, l: 6 };

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

/** Die Sätze, mit denen die Attrappe ablehnt, wie in server/stowly/labels.py. */
export const MOCK_TOO_SHORT = "Für so viele Felder ist das Etikett zu kurz: ein Feld weglassen, kleiner wählen oder länger machen.";
const TOO_SMALL = "Für so viele Felder ist das Etikett zu klein: ein Feld weglassen oder kleiner wählen.";
const NO_QR_FITS = "Auf dieses Papier passt kein QR-Code, der sich sicher scannen lässt: ein breiteres Papier nehmen.";
const QR_TOO_LARGE_LONGER = "Der QR-Code ist für dieses Etikett zu groß: kleiner wählen oder das Etikett länger machen.";
const QR_TOO_LARGE_PAPER = "Der QR-Code ist für dieses Etikett zu groß: kleiner wählen oder ein größeres Papier nehmen.";
const NO_ROOM = "Neben dem QR-Code bleibt zu wenig Platz für die Felder: QR-Code kleiner wählen, alle Felder ausschalten oder ein größeres Etikett nehmen.";

/** Kante des QR-Codes in mm je Größe, wie `QR_SIZES` beim Server (Packung Version 1, Zone Version 3). */
const QR_MM: Record<LabelKind, Record<LabelSize, number>> = {
  package: { s: 14, m: 24, l: 28 },
  zone: { s: 18.5, m: 23, l: 27 },
};

/** Die Zeichenfläche in Leserichtung in mm (auf 0,1 mm gerundet, wie `area_of` beim Server). */
function areaOf(paper: LabelPaper, layout: Pick<LabelLayout, "length_mm">): { width: number; height: number } {
  const across = paper.printable_width_px;
  const along = paper.kind === "die_cut" ? (paper.printable_length_px ?? 0) : Math.floor(((layout.length_mm ?? 29) * 300) / 25.4 + 1e-6);
  const [width, height] = mockRotated(paper, layout) ? [along, across] : [across, along];
  const mm = (px: number) => Math.round((px * 25.4 * 10) / 300) / 10;
  return { width: mm(width), height: mm(height) };
}

/**
 * Was an einer Gestaltung nicht passt, als Satz; null = passt. Vereinfacht nach `check` beim Server:
 * Papier, Länge, Felder, Größe des QR-Codes, Platz daneben und die Höhe der Felder (grob geschätzt).
 */
export function mockLayoutProblem(kind: LabelKind, paperId: string, layout: LabelLayout): string | null {
  const paper = mockPaper(paperId);
  if (!paper) {
    return "Dieses Papier kennt Stowly nicht.";
  }
  if (paper.kind === "endless" && (layout.length_mm === null || !Number.isInteger(layout.length_mm) || layout.length_mm < 25 || layout.length_mm > 100)) {
    return "Auf einer Endlosrolle ist ein Etikett 25 bis 100 mm lang.";
  }
  if (paper.kind === "die_cut" && layout.length_mm !== null) {
    return "Gestanzte Etiketten haben eine feste Länge; eine eigene Länge geht nur bei Endlosrollen.";
  }
  if (layout.text.length > LIMITS.label_text) {
    return `Der eigene Text ist zu lang (höchstens ${LIMITS.label_text} Zeichen).`;
  }
  const seen = new Set<string>();
  for (const field of layout.fields) {
    if (seen.has(field.field) || (kind === "zone" && !ZONE_FIELDS.has(field.field))) {
      return "Ein Feld steht doppelt oder gehört nicht auf dieses Etikett.";
    }
    seen.add(field.field);
  }
  const area = areaOf(paper, layout);
  const longer = paper.kind === "endless" && !mockRotated(paper, layout);
  const smallest = QR_MM[kind].s;
  const qr = QR_MM[kind][layout.qr.size];
  if (smallest > area.height || smallest + 1 > area.width) {
    return NO_QR_FITS;
  }
  if (qr > area.height || qr + 1 > area.width) {
    return longer ? QR_TOO_LARGE_LONGER : QR_TOO_LARGE_PAPER;
  }
  if (layout.fields.length > 0 && area.width - 1 - qr - 1.5 < 12) {
    return NO_ROOM;
  }
  return fieldsHeight(layout.fields) > area.height - 2.3 ? (longer ? MOCK_TOO_SHORT : TOO_SMALL) : null;
}

/** 16 Hex-Zeichen über einen Text: fest für denselben Text, wie der `hash` einer Vorlage. */
export function mockHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x5bd1e995;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x01000195) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

// ------------------------------------------------------------------------------------------
// Vorschau als 1-Bit-PNG
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

/** Rohdaten als zlib-Strom aus ungepackten Blöcken. */
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

/** Ein 1-Bit-PNG; `black(x, y)` sagt, welche Punkte schwarz sind. Als Base64. */
function pngBase64(width: number, height: number, black: (x: number, y: number) => boolean): string {
  const rowBytes = Math.ceil(width / 8);
  const raw = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (rowBytes + 1);
    for (let x = 0; x < width; x += 1) {
      if (!black(x, y)) {
        const index = row + 1 + (x >> 3);
        raw[index] = (raw[index] as number) | (0x80 >> (x & 7));
      }
    }
  }
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, width);
  new DataView(header.buffer).setUint32(4, height);
  header[8] = 1;
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", zlibStored(raw)), chunk("IEND", new Uint8Array(0))];
  let binary = "";
  for (const part of parts) {
    for (let offset = 0; offset < part.length; offset += 0x8000) {
      binary += String.fromCharCode(...part.subarray(offset, offset + 0x8000));
    }
  }
  return btoa(binary);
}

const QR_SHARE: Record<LabelSize, number> = { s: 0.6, m: 0.75, l: 0.88 };
const BAR_SHARE: Record<LabelSize, number> = { s: 0.07, m: 0.1, l: 0.14 };

/** Ein Rechteck (x, y, Breite, Höhe) in Punkten. */
type Box = [number, number, number, number];

/**
 * Die gezeichnete Vorschau der Attrappe: so groß wie das Papier bei 300 dpi, so wie man es liest.
 * Ein langer Name (das Beispiel) passt einzeilig nur verkleinert: Das steht in `notes`.
 */
export function mockPreview(paper: LabelPaper, layout: LabelLayout, example: boolean): LabelPreview {
  const across = paper.printable_width_px;
  const along = paper.kind === "die_cut" ? (paper.printable_length_px ?? 0) : Math.floor(((layout.length_mm ?? 29) * 300) / 25.4 + 1e-6);
  const [width, height] = mockRotated(paper, layout) ? [along, across] : [across, along];
  const margin = Math.round(height * 0.06);
  const qr = Math.round(Math.min(height - 2 * margin, width * 0.45) * QR_SHARE[layout.qr.size]);
  const qrX = layout.qr.side === "left" ? margin : width - margin - qr;
  const qrY = Math.round((height - qr) / 2);
  const textX = layout.qr.side === "left" ? qrX + qr + margin : margin;
  const textWidth = width - qr - 3 * margin;
  const bars: Box[] = [];
  let y = margin;
  layout.fields.forEach((field, index) => {
    const lines = field.field === "title" ? (field.lines ?? 1) : 1;
    const bar = Math.round(height * BAR_SHARE[field.size]);
    if (layout.divider && index === layout.fields.length - 1 && index > 0) {
      bars.push([textX, y, textWidth, 2]);
      y += 6;
    }
    for (let line = 0; line < lines; line += 1) {
      const share = field.field === "title" ? (line === lines - 1 ? 0.6 : 0.95) : 0.45 + ((index * 17) % 30) / 100;
      if (y + bar <= height - margin) {
        bars.push([textX, y, Math.round(textWidth * share), bar]);
      }
      y += bar + Math.round(bar * 0.35);
    }
  });
  const inside = ([x0, y0, w, h]: Box, x: number, yy: number) => x >= x0 && x < x0 + w && yy >= y0 && yy < y0 + h;
  const module = Math.max(4, Math.round(qr / 21));
  const png = pngBase64(width, height, (x, yy) => {
    if (x < 2 || yy < 2 || x >= width - 2 || yy >= height - 2) {
      return true;
    }
    if (inside([qrX, qrY, qr, qr], x, yy)) {
      const mx = Math.floor((x - qrX) / module);
      const my = Math.floor((yy - qrY) / module);
      return (mx * 7 + my * 3 + mx * my) % 5 < 2;
    }
    return bars.some((box) => inside(box, x, yy));
  });
  const title = layout.fields.find((field) => field.field === "title");
  const notes = example && title && (title.lines ?? 1) === 1 ? ["Name auf 3,0 mm verkleinert und gekürzt."] : [];
  return { png, width_px: width, height_px: height, notes };
}
