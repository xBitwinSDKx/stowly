"""Papier-Katalog: die Brother-Rollen, die Stowly kennt (docs/etiketten.md, 3.1).

Nur Daten, ohne die Brother-Bibliothek: Der Server rechnet mit demselben Katalog (Vorschau,
Generator der Vorlagen, Prüfung beim Speichern), hat die Bibliothek aber nicht. Die Werte folgen
der Tabelle von brother_ql_next (``brother_ql.labels.ALL_LABELS``, Version 0.12.0);
``tests/test_media.py`` vergleicht beide, wo die Bibliothek installiert ist.

Maße:

* ``width_mm`` ist die Breite der Rolle, quer zur Laufrichtung; ``length_mm`` die Länge eines
  gestanzten Etiketts in Laufrichtung (bei Endlosrollen ``None``: Die Länge bestimmt die Vorlage).
* ``printable_width_px`` sind die druckbaren Punkte quer zur Laufrichtung bei 300 dpi,
  ``printable_length_px`` die in Laufrichtung (nur gestanzt). Bei gestanzten Etiketten ist die
  druckbare Länge kürzer als das Etikett: 62 × 29 mm hat 271 statt 342 Punkte.

Nicht im Katalog: Rollen über 62 mm (nur QL-1050/1100), zweifarbige und runde Etiketten, und die
12-mm-Endlosrolle: Auf 106 druckbare Punkte passt kein QR-Code mit 6 Punkten je Modul, und der
QR-Code ist auf jedem Etikett.
"""

import math
from dataclasses import dataclass

DPI = 300
MM_PER_INCH = 25.4

ENDLESS = "endless"
DIE_CUT = "die_cut"
KINDS = (ENDLESS, DIE_CUT)

# Vorgabe, wenn eine Vorlage kein Papier nennt (die mitgelieferten, Format 1) und der Haushalt
# keines gewählt hat: die 62-mm-Endlosrolle.
DEFAULT_PAPER_ID = "62"

# Länge eines Etiketts auf einer Endlosrolle, in ganzen Millimetern (docs/plan-0.5.md, 1).
ENDLESS_LENGTH_MIN_MM = 25
ENDLESS_LENGTH_MAX_MM = 100

# Spielraum beim Zuordnen einer gemeldeten Rolle zum Katalog (der Drucker meldet ganze Millimeter,
# Brother nennt manche Rollen anders, als sie messen: 39 × 90 ist 38 mm breit).
MATCH_TOLERANCE_MM = 1.0


@dataclass(frozen=True)
class PaperSpec:
    """Ein Papier des Katalogs."""

    id: str  # Kennung wie in brother_ql: "62" (endlos), "62x29" (gestanzt)
    kind: str  # ENDLESS oder DIE_CUT
    width_mm: float  # Breite der Rolle, quer zur Laufrichtung
    length_mm: float | None  # Länge eines gestanzten Etiketts; None bei Endlosrollen
    printable_width_px: int  # druckbare Punkte quer zur Laufrichtung (300 dpi)
    printable_length_px: int | None  # druckbare Punkte in Laufrichtung, nur gestanzt
    name: str  # Anzeigename in der App


def _endless(width: int, printable: int) -> PaperSpec:
    return PaperSpec(
        id=str(width),
        kind=ENDLESS,
        width_mm=float(width),
        length_mm=None,
        printable_width_px=printable,
        printable_length_px=None,
        name=f"{width} mm endlos",
    )


def _die_cut(paper_id: str, width: float, length: float, printable_w: int, printable_l: int) -> PaperSpec:
    return PaperSpec(
        id=paper_id,
        kind=DIE_CUT,
        width_mm=width,
        length_mm=length,
        printable_width_px=printable_w,
        printable_length_px=printable_l,
        name=f"{_mm(width)} × {_mm(length)} mm gestanzt",
    )


def _mm(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else str(value).replace(".", ",")


# Reihenfolge = Reihenfolge in der App: erst Endlosrollen nach Breite, dann gestanzte nach Breite
# und Länge. Die Werte stammen aus brother_ql_next 0.12.0 (tape_size, dots_printable).
PAPERS: tuple[PaperSpec, ...] = (
    _endless(18, 234),
    _endless(29, 306),
    _endless(38, 413),
    _endless(50, 554),
    _endless(54, 590),
    _endless(62, 696),
    _die_cut("17x54", 17, 54, 165, 566),
    _die_cut("17x87", 17, 87, 165, 956),
    _die_cut("23x23", 23, 23, 202, 202),
    _die_cut("29x42", 29, 42, 306, 425),
    _die_cut("29x90", 29, 90, 306, 991),
    _die_cut("39x90", 38, 90, 413, 991),  # Brother nennt sie 39 × 90, gemessen 38 mm breit
    _die_cut("39x48", 39, 48, 425, 495),
    _die_cut("52x29", 52, 29, 578, 271),
    _die_cut("54x29", 54, 29, 598, 271),
    _die_cut("60x86", 60, 87, 672, 954),  # Brother nennt sie 60 × 86, gemessen 87 mm lang
    _die_cut("62x29", 62, 29, 696, 271),
    _die_cut("62x100", 62, 100, 696, 1109),
)

BY_ID: dict[str, PaperSpec] = {paper.id: paper for paper in PAPERS}


def paper(paper_id: str | None) -> PaperSpec | None:
    """Das Papier zu einer Kennung; ``None``, wenn es sie im Katalog nicht gibt."""
    if paper_id is None:
        return None
    return BY_ID.get(paper_id)


def find(kind: str, width_mm: float, length_mm: float | None) -> PaperSpec | None:
    """Das Papier zu einer gemeldeten Rolle (Art, Breite, bei gestanzten die Länge); ``None``, wenn
    keines passt. Breite und Länge dürfen um ``MATCH_TOLERANCE_MM`` abweichen."""
    for candidate in PAPERS:
        if candidate.kind != kind or abs(candidate.width_mm - width_mm) > MATCH_TOLERANCE_MM:
            continue
        if kind == ENDLESS:
            return candidate
        if length_mm is not None and candidate.length_mm is not None:
            if abs(candidate.length_mm - length_mm) <= MATCH_TOLERANCE_MM:
                return candidate
    return None


def mm_to_px(mm: float) -> int:
    """Ganze Punkte bei 300 dpi, die in eine Länge passen, wie ``render.mm_to_px`` (29 mm sind 342)."""
    return int(math.floor(mm * DPI / MM_PER_INCH + 1e-6))


def rotated(spec: PaperSpec, length_mm: float | None = None) -> bool:
    """Liegt das Etikett quer zur Rolle, muss der Renderer es um 90° drehen: dann, wenn es in
    Laufrichtung länger ist, als die Rolle breit ist (docs/etiketten.md, 3.4). ``length_mm`` ist bei
    Endlosrollen die gewählte Länge; bei gestanzten zählt die Länge des Etiketts."""
    length = spec.length_mm if spec.kind == DIE_CUT else length_mm
    if length is None:
        return False
    return length > spec.width_mm
