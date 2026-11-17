"""Etiketten gestalten: aus der Gestaltung des Haushalts die Vorlagen (docs/plan-0.5.md, 1;
docs/etiketten.md, 3.1 bis 3.4).

``build_template(kind, paper, layout)`` erzeugt die Vorlage einer Etikettenart. Der Generator ist
deterministisch (gleiche Gestaltung, gleiche Vorlage, gleicher ``hash``) und braucht die
Brother-Bibliothek nicht: Er rechnet mit dem Papier-Katalog (``stowly_print.media``) und festen Maßen.

Anordnung, alles in Millimetern der Zeichenfläche und in Leserichtung:

* **Zeichenfläche** ist die druckbare Fläche des Papiers, auf 0,1 mm gerundet. Der Renderer bildet
  sie fast 1 : 1 ab; deshalb sind alle Größen echte Millimeter und auf jedem Papier dieselben.
* **QR-Code:** ein Quadrat an der gewählten Seite, 0,5 mm vom Rand, senkrecht in der Mitte.
* **Felder:** untereinander daneben, 1,5 mm vom QR-Code bis 0,5 mm vor den anderen Rand. Stehen
  Packungs-ID und Einlagerdatum direkt nacheinander, teilen sie sich eine Zeile: das erste links, das
  zweite rechtsbündig daneben.
* **Senkrecht:** Die letzte Zeile steht unten (0,8 mm Rand) und bekommt, wenn Platz ist, mindestens
  6,8 mm Höhe (die einer Packungs-ID in mittlerer Größe). Die Trennlinie steht mit je 0,6 mm Abstand
  darüber. Die übrigen Zeilen folgen ab 1,5 mm vom oberen Rand mit 0,2 mm Abstand; was an Höhe übrig
  bleibt, verteilt sich gleich über und unter ihnen. Eine einzelne Zeile steht in der Mitte.
* **Wird es eng,** werden alle Zeilen gleichmäßig niedriger, höchstens bis auf eine Zeile in
  ``min_size``. Der Renderer verkleinert dann die Schrift bis ``min_size`` und kürzt zuletzt mit „…",
  wie bei den mitgelieferten Vorlagen. Reicht auch das nicht, gibt es einen Satz statt einer Vorlage
  (``LabelDesignError``).

Format 1 bleibt für die 62-mm-Endlosrolle ohne Drehung (bis 62 mm Länge): Das druckt auch ein
Druckdienst 0.4.0. Jedes andere Papier und jede Drehung ergibt Format 2 mit ``media.id`` und
``rotate`` (docs/etiketten.md, 3.4).

Die Vorgabe (``DEFAULT_DESIGN``) beschreibt die mitgelieferten Vorlagen. Für sie gilt die
mitgelieferte Vorlage selbst (``template_for``), mit ihrem ``hash``: Wer die Vorgabe speichert, ändert
nichts. ``build_template`` mit der Vorgabe ergibt eine Vorlage, die genauso aussieht (Test).

Geprüft wird jede Vorlage, bevor sie gilt (``check``): gerendert mit Grenzdaten, also langem Namen und
allen Feldern voll. Eine Packungs-ID oder ein Datum, das nur gekürzt passt, ist ein Fehler; verkleinerte
oder gekürzte Namen sind Hinweise für die Vorschau (``preview``).
"""

import base64
import math
import re
from dataclasses import dataclass
from typing import Any

from stowly.contract import ids
from stowly.contract.api import (
    ZONE_LABEL_FIELDS,
    LabelDateStyle,
    LabelDesign,
    LabelField,
    LabelFieldName,
    LabelKind,
    LabelLayout,
    LabelQr,
    LabelQrSide,
    LabelSize,
)
from stowly.contract.limits import LIMITS
from stowly_print import media as catalog
from stowly_print.render import RenderError, render_with_report, to_png
from stowly_print.templates import load_builtin

PX_PER_MM = catalog.DPI / catalog.MM_PER_INCH

# --- Maße der Anordnung (mm) ---------------------------------------------------------------------

SIDE_MM = 0.5  # links und rechts zum Rand der Zeichenfläche
QR_GAP_MM = 1.5  # zwischen dem Feld des QR-Codes und den Feldern
TOP_MM = 1.5  # über der ersten Zeile
BOTTOM_MM = 0.8  # unter der letzten Zeile
ROW_GAP_MM = 0.2  # zwischen zwei Zeilen
DIVIDER_GAP_MM = 0.6  # zwischen der Trennlinie und den Zeilen darüber und darunter
DIVIDER_WIDTH_MM = 0.25
FOOTER_MIN_MM = 6.8  # Höhe der untersten Zeile, wenn Platz ist (Packungs-ID in mittlerer Größe)
COLUMN_MIN_MM = 12.0  # schmaler wird die Spalte der Felder nicht: Darunter passt kaum ein Wort

# Höhe einer Zeile in Vielfachen der Schriftgröße. Die Werte treffen die mitgelieferten Vorlagen: Name
# 2 Zeilen à 4,2 mm in 9,6 mm (16/7), MHD 4,2 mm in 5,2 mm, Packungs-ID 6,0 mm in 6,8 mm (17/15).
TITLE_LINE_EM = 8 / 7  # je Zeile des Namens
LINE_EM = 1.24  # eine Zeile Text mit Ober- und Unterlängen
ID_LINE_EM = 17 / 15  # Packungs-ID: nur Großbuchstaben und Ziffern
# Mindesthöhe: eine Zeile in min_size, mit Akzenten und Unterlängen bzw. nur Ziffern und Großbuchstaben.
MIN_LINE_EM = 1.2
MIN_FIXED_EM = 0.9
# Breite der Packungs-ID: fünf Zeichen der Festbreitenschrift (je 0,602 Geviert) und etwas Luft.
ID_WIDTH_EM = 3.07

# --- Größen: feste Millimeter, auf jedem Papier dieselben ----------------------------------------


@dataclass(frozen=True)
class QrSize:
    """Das Feld des QR-Codes (samt Ruhezone) und die Ruhezone in Modulen."""

    size_mm: float
    quiet: int


# Die kleinste Stufe ergibt 6 Pixel je Modul (die Untergrenze des Renderers) und passt auf die
# schmalsten Papiere: 14 mm (Packung, Version 1) auf 17 mm breite Etiketten, 18,5 mm (Zone, Version 3)
# auf die 18-mm-Rolle. Dafür hat sie 3 Module Ruhezone; das Papier um die druckbare Fläche ist weiß.
# Mittel ist bei der Packung, groß bei der Zone die mitgelieferte Vorlage (9 bzw. 8 Pixel je Modul).
QR_SIZES: dict[LabelKind, dict[LabelSize, QrSize]] = {
    LabelKind.PACKAGE: {
        LabelSize.SMALL: QrSize(14.0, 3),
        LabelSize.MEDIUM: QrSize(24.0, 4),
        LabelSize.LARGE: QrSize(28.0, 4),
    },
    LabelKind.ZONE: {
        LabelSize.SMALL: QrSize(18.5, 3),
        LabelSize.MEDIUM: QrSize(23.0, 4),
        LabelSize.LARGE: QrSize(27.0, 4),
    },
}
# Module des QR-Codes ohne Ruhezone (docs/etiketten.md, 2): Packung Version 1, Zone Version 3.
QR_MODULES = {LabelKind.PACKAGE: 21, LabelKind.ZONE: 29}
QR_MIN_MODULE_PX = 6


@dataclass(frozen=True)
class FontSize:
    size: float  # Schriftgröße in mm
    min_size: float  # so klein darf der Renderer werden, bevor er kürzt


@dataclass(frozen=True)
class Style:
    """Wie ein Feld gedruckt wird."""

    font: str  # regular, bold, mono
    sizes: dict[LabelSize, FontSize]
    shape: str  # "title" (mehrere Zeilen), "text", "fixed" (Datum: nur Ziffern), "id"
    valign: str = "top"


def _sizes(small: tuple[float, float], medium: tuple[float, float], large: tuple[float, float]) -> dict:
    return {
        LabelSize.SMALL: FontSize(*small),
        LabelSize.MEDIUM: FontSize(*medium),
        LabelSize.LARGE: FontSize(*large),
    }


_SECONDARY = _sizes((2.4, 2.0), (2.8, 2.2), (3.4, 2.2))
_ZONE_SECONDARY = _sizes((2.6, 2.2), (3.2, 2.4), (4.0, 2.4))

# Die mittlere Größe (bei der Zone der große Name) ist die der mitgelieferten Vorlagen; das
# Einlagerdatum steht dort klein. Groß hat dieselbe Untergrenze wie mittel: „so groß, wie Platz ist".
STYLES: dict[LabelKind, dict[LabelFieldName, Style]] = {
    LabelKind.PACKAGE: {
        LabelFieldName.TITLE: Style("bold", _sizes((3.4, 2.6), (4.2, 3.0), (5.2, 3.0)), "title"),
        LabelFieldName.SUBTITLE: Style("regular", _SECONDARY, "text"),
        LabelFieldName.QUANTITY: Style("regular", _SECONDARY, "text"),
        LabelFieldName.BRAND: Style("regular", _SECONDARY, "text"),
        LabelFieldName.BEST_BEFORE: Style("bold", _sizes((3.2, 2.6), (4.2, 3.2), (5.2, 3.2)), "fixed"),
        LabelFieldName.STORED: Style("regular", _SECONDARY, "fixed"),
        LabelFieldName.ID: Style("mono", _sizes((4.8, 4.4), (6.0, 5.6), (7.2, 5.6)), "id"),
        LabelFieldName.ZONE: Style("regular", _SECONDARY, "text"),
        LabelFieldName.TEXT: Style("regular", _SECONDARY, "text"),
    },
    LabelKind.ZONE: {
        LabelFieldName.TITLE: Style(
            "bold", _sizes((4.2, 3.0), (5.6, 3.4), (7.0, 3.6)), "title", valign="middle"
        ),
        LabelFieldName.SUBTITLE: Style("regular", _ZONE_SECONDARY, "text"),
        LabelFieldName.TEXT: Style("regular", _ZONE_SECONDARY, "text"),
    },
}

# Feldnamen in Sätzen an den Anwender.
FIELD_NAMES: dict[LabelKind, dict[LabelFieldName, str]] = {
    LabelKind.PACKAGE: {
        LabelFieldName.TITLE: "Name",
        LabelFieldName.SUBTITLE: "Größe · Marke",
        LabelFieldName.QUANTITY: "Größe",
        LabelFieldName.BRAND: "Marke",
        LabelFieldName.BEST_BEFORE: "MHD",
        LabelFieldName.STORED: "Einlagerdatum",
        LabelFieldName.ID: "Packungs-ID",
        LabelFieldName.ZONE: "Zone",
        LabelFieldName.TEXT: "Eigener Text",
    },
    LabelKind.ZONE: {
        LabelFieldName.TITLE: "Name",
        LabelFieldName.SUBTITLE: "Lagerzone",  # die Zusatzzeile, wie in docs/etiketten.md, 3.2
        LabelFieldName.TEXT: "Eigener Text",
    },
}

# Felder, die nie gekürzt werden dürfen: Eine halbe Packungs-ID oder ein halbes Datum hilft niemandem.
FIXED_FIELDS = (LabelFieldName.ID, LabelFieldName.BEST_BEFORE, LabelFieldName.STORED)

# --- Vorgabe: die mitgelieferten Vorlagen als Gestaltung -----------------------------------------

DEFAULT_PAPER_ID = catalog.DEFAULT_PAPER_ID
DEFAULT_LAYOUTS: dict[LabelKind, LabelLayout] = {
    LabelKind.PACKAGE: LabelLayout(
        length_mm=29,
        qr=LabelQr(side=LabelQrSide.LEFT, size=LabelSize.MEDIUM),
        fields=[
            LabelField(field=LabelFieldName.TITLE, size=LabelSize.MEDIUM, lines=2),
            LabelField(field=LabelFieldName.SUBTITLE, size=LabelSize.MEDIUM),
            LabelField(field=LabelFieldName.BEST_BEFORE, size=LabelSize.MEDIUM),
            LabelField(field=LabelFieldName.ID, size=LabelSize.MEDIUM),
            LabelField(field=LabelFieldName.STORED, size=LabelSize.SMALL),
        ],
        date=LabelDateStyle.LONG,
        text="",
        divider=True,
    ),
    LabelKind.ZONE: LabelLayout(
        length_mm=29,
        qr=LabelQr(side=LabelQrSide.LEFT, size=LabelSize.LARGE),
        fields=[
            LabelField(field=LabelFieldName.TITLE, size=LabelSize.LARGE, lines=2),
            LabelField(field=LabelFieldName.SUBTITLE, size=LabelSize.MEDIUM),
        ],
        date=LabelDateStyle.LONG,
        text="",
        divider=True,
    ),
}
DEFAULT_DESIGN = LabelDesign(
    paper=DEFAULT_PAPER_ID,
    package=DEFAULT_LAYOUTS[LabelKind.PACKAGE],
    zone=DEFAULT_LAYOUTS[LabelKind.ZONE],
)

# --- Beispiel- und Grenzdaten --------------------------------------------------------------------

# Das Beispiel der Vorschau (data = null): ein langer Name, alle Felder gefüllt.
SAMPLE_DATA: dict[LabelKind, dict[str, str]] = {
    LabelKind.PACKAGE: {
        "qr": "STOWLY/P/A2B3C",
        "id": "A2B3C",
        "title": "Bio-Vollkorn-Spaghetti aus Hartweizengrieß",
        "subtitle": "500 g · Kornhaus",
        "quantity": "500 g",
        "brand": "Kornhaus",
        "best_before": "25.03.2027",
        "best_before_short": "25.03.27",
        "stored": "13.11.2026",
        "stored_short": "13.11.26",
        "zone": "Vorratsschrank im Keller",
    },
    LabelKind.ZONE: {
        "qr": "STOWLY/Z/3F2B8C1E5A474D099B6E0C1D2E3F4A5B",
        "title": "Vorratsschrank im Keller",
        "subtitle": "Lagerzone",
    },
}


def _long(text: str, limit: int) -> str:
    """Ein Text in voller Länge aus wiederholten Wörtern: wie ein echter, nur länger."""
    repeated = " ".join([text] * (limit // max(1, len(text)) + 2))
    return repeated[:limit].rstrip()


# Grenzdaten der Prüfung: alles so lang, wie die App es zulässt (LIMITS), Daten in langer Form. Die
# Packungs-ID steht in Festbreitenschrift und Ziffern sind gleich breit: Was hier passt, passt immer.
LIMIT_DATA: dict[LabelKind, dict[str, str]] = {
    LabelKind.PACKAGE: {
        **SAMPLE_DATA[LabelKind.PACKAGE],
        "title": _long("Bio-Vollkorn-Spaghetti aus Hartweizengrieß mit Dinkel", 120),
        "subtitle": _long("1 Packung zu 500 g", 40) + " · " + _long("Kornhaus Feinkost", 80),
        "quantity": _long("1 Packung zu 500 g", 40),
        "brand": _long("Kornhaus Feinkost", 80),
        "zone": _long("Vorratsschrank im Keller", 60),
    },
    LabelKind.ZONE: {
        **SAMPLE_DATA[LabelKind.ZONE],
        "title": _long("Vorratsschrank im Keller links", 60),
    },
}

# So lang sind die Daten eines Etiketts höchstens, wenn sie aus der App kommen (LIMITS; docs/etiketten.md,
# 3.3). Die Vorschau nimmt nichts Längeres an: Der Vertrag erlaubt je Wert 500 Zeichen, und so lange Texte
# ließen den Renderer Sekunden rechnen, während er die Sperre für alle Etiketten hält. Schlüssel, die hier
# nicht stehen, übergeht die Vorschau.
_QR_MAX = len(ids.QR_ZONE_PREFIX) + 32  # der längere der beiden QR-Inhalte
_SUBTITLE_MAX = LIMITS["quantity"] + len(" · ") + LIMITS["brand"]
DATA_LIMITS: dict[LabelKind, dict[str, int]] = {
    LabelKind.PACKAGE: {
        "qr": _QR_MAX,
        "id": ids.PACKAGE_ID_LENGTH,
        "title": LIMITS["product_name"],
        "subtitle": _SUBTITLE_MAX,
        "quantity": LIMITS["quantity"],
        "brand": LIMITS["brand"],
        "zone": LIMITS["zone_name"],
        "best_before": len("TT.MM.JJJJ"),
        "stored": len("TT.MM.JJJJ"),
        "best_before_short": len("TT.MM.JJ"),
        "stored_short": len("TT.MM.JJ"),
    },
    LabelKind.ZONE: {"qr": _QR_MAX, "title": LIMITS["zone_name"], "subtitle": _SUBTITLE_MAX},
}
# Die Namen der Daten in Sätzen an den Anwender (Größe · Marke bzw. Lagerzone nach FIELD_NAMES).
_DATA_NAMES = {
    "qr": "QR-Inhalt",
    "id": "Packungs-ID",
    "title": "Name",
    "quantity": "Größe",
    "brand": "Marke",
    "zone": "Zone",
    "best_before": "MHD",
    "best_before_short": "MHD",
    "stored": "Einlagerdatum",
    "stored_short": "Einlagerdatum",
}


# --- Fehler und Ergebnis -------------------------------------------------------------------------


class LabelDesignError(Exception):
    """Die Gestaltung passt nicht. ``message`` ist ein deutscher Satz für den Anwender, ``loc`` die
    Stelle relativ zur Gestaltung einer Etikettenart (etwa ``("fields", 2)``); ``("paper",)`` meint
    das Papier, ``("data", schlüssel)`` die Daten der Vorschau."""

    def __init__(self, message: str, loc: tuple[str | int, ...] = ()) -> None:
        super().__init__(message)
        self.message = message
        self.loc = loc


UNKNOWN_PAPER = "Dieses Papier kennt Stowly nicht."
LENGTH_FIXED = "Gestanzte Etiketten haben eine feste Länge; eine eigene Länge geht nur bei Endlosrollen."
LENGTH_MISSING = "Für eine Endlosrolle fehlt die Länge des Etiketts."
LINES_ONLY_TITLE = "Die Zahl der Zeilen lässt sich nur beim Namen wählen."
TEXT_UNPRINTABLE = "Der eigene Text enthält Zeichen, die sich nicht drucken lassen."
NO_QR_FITS = (
    "Auf dieses Papier passt kein QR-Code, der sich sicher scannen lässt: ein breiteres Papier nehmen."
)
QR_TOO_SMALL = "Der QR-Code wäre zu klein, um sicher gescannt zu werden: größer wählen."


@dataclass(frozen=True)
class Preview:
    """Ergebnis von ``preview``: das PNG so, wie man das Etikett liest, und die Hinweise."""

    png: bytes
    width_px: int
    height_px: int
    notes: list[str]

    def png_base64(self) -> str:
        return base64.b64encode(self.png).decode("ascii")


# --- Fläche ----------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Area:
    """Die Zeichenfläche eines Etiketts in Leserichtung."""

    paper: catalog.PaperSpec
    length_mm: float  # Länge in Laufrichtung: gewählt (endlos) bzw. die des Etiketts (gestanzt)
    rotate: int  # 0 oder 90 (docs/etiketten.md, 3.4)
    width_px: int
    height_px: int
    width_mm: float  # design.width_mm
    height_mm: float  # design.height_mm

    @property
    def scale(self) -> float:
        """Pixel je Millimeter der Zeichenfläche, so wie der Renderer sie abbildet."""
        return min(self.width_px / self.width_mm, self.height_px / self.height_mm)

    @property
    def format(self) -> int:
        """Format 1 nur für die 62-mm-Endlosrolle ohne Drehung, sonst Format 2."""
        return 1 if self.paper.id == DEFAULT_PAPER_ID and self.rotate == 0 else 2


def area_of(spec: catalog.PaperSpec, length_mm: float | None) -> Area:
    """Die Fläche eines Papiers: quer zur Laufrichtung ``printable_width_px``, längs bei gestanzten
    ``printable_length_px``, bei Endlosrollen die gewählte Länge. Liegt das Etikett längs zur Rolle
    (``media.rotated``), ist die Leserichtung gedreht."""
    across = spec.printable_width_px
    if spec.kind == catalog.DIE_CUT:
        along = int(spec.printable_length_px or 0)
        length = float(spec.length_mm or 0.0)
    else:
        length = float(length_mm or 0.0)
        along = catalog.mm_to_px(length)
    rotate = 90 if catalog.rotated(spec, length) else 0
    width_px, height_px = (along, across) if rotate else (across, along)
    return Area(
        paper=spec,
        length_mm=length,
        rotate=rotate,
        width_px=width_px,
        height_px=height_px,
        width_mm=round(width_px / PX_PER_MM, 1),
        height_mm=round(height_px / PX_PER_MM, 1),
    )


# --- Prüfen der Gestaltung -----------------------------------------------------------------------


def paper_of(paper: str) -> catalog.PaperSpec:
    spec = catalog.paper(paper)
    if spec is None:
        raise LabelDesignError(UNKNOWN_PAPER, ("paper",))
    return spec


def _check_layout(kind: LabelKind, spec: catalog.PaperSpec, layout: LabelLayout) -> None:
    """Was das Modell nicht prüfen kann: Länge zum Papier, erlaubte und doppelte Felder, Zeilen."""
    if spec.kind == catalog.DIE_CUT and layout.length_mm is not None:
        raise LabelDesignError(LENGTH_FIXED, ("length_mm",))
    if spec.kind == catalog.ENDLESS and layout.length_mm is None:
        raise LabelDesignError(LENGTH_MISSING, ("length_mm",))
    if not _printable(layout.text):
        raise LabelDesignError(TEXT_UNPRINTABLE, ("text",))
    seen: set[LabelFieldName] = set()
    names = FIELD_NAMES[kind]
    for index, entry in enumerate(layout.fields):
        if kind == LabelKind.ZONE and entry.field not in ZONE_LABEL_FIELDS:
            allowed = ", ".join(f"„{names[name]}“" for name in ZONE_LABEL_FIELDS)
            raise LabelDesignError(f"Auf Zonen-Etiketten gibt es nur {allowed}.", ("fields", index, "field"))
        if entry.field in seen:
            raise LabelDesignError(
                f"Das Feld „{names[entry.field]}“ steht doppelt in der Liste.", ("fields", index, "field")
            )
        seen.add(entry.field)
        if entry.lines is not None and entry.field != LabelFieldName.TITLE:
            raise LabelDesignError(LINES_ONLY_TITLE, ("fields", index, "lines"))


def _printable(text: str) -> bool:
    """Lässt sich der Text als UTF-8 schreiben? Einzelne Surrogate (aus JSON wie ``"\\ud800"``) nicht: Die
    Vorlage ließe sich dann weder hashen noch speichern."""
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _tight(area: Area) -> str:
    """Wie man zu mehr Höhe kommt: Endlosrollen ohne Drehung werden länger, sonst hilft nur Weglassen."""
    if area.paper.kind == catalog.ENDLESS and area.rotate == 0:
        return "Für so viele Felder ist das Etikett zu kurz: ein Feld weglassen, kleiner wählen oder länger machen."
    return "Für so viele Felder ist das Etikett zu klein: ein Feld weglassen oder kleiner wählen."


def _qr_too_large(area: Area) -> str:
    if area.paper.kind == catalog.ENDLESS and area.rotate == 0:
        return "Der QR-Code ist für dieses Etikett zu groß: kleiner wählen oder das Etikett länger machen."
    return "Der QR-Code ist für dieses Etikett zu groß: kleiner wählen oder ein größeres Papier nehmen."


# --- Zeilen ----------------------------------------------------------------------------------------


def _round1(value: float) -> float:
    return round(value + 1e-9, 1)


def _ceil1(value: float) -> float:
    return math.ceil(value * 10 - 1e-6) / 10


def _floor2(value: float) -> float:
    return math.floor(value * 100 + 1e-6) / 100


def _mm(value: float) -> float:
    """Ein Maß für die Vorlage: auf 0,01 mm gerundet, ohne Rauschen aus der Gleitkommarechnung."""
    return round(value + 0.0, 2) + 0.0


@dataclass(frozen=True)
class _Part:
    """Ein Feld, wie es in einer Zeile steht."""

    field: LabelFieldName
    index: int  # Stelle in layout.fields
    style: Style
    font: FontSize
    lines: int
    value: str
    when: str | None

    @property
    def natural(self) -> float:
        size = self.font.size
        if self.style.shape == "title":
            return self.lines * _round1(size * TITLE_LINE_EM)
        if self.style.shape == "id":
            return _round1(size * ID_LINE_EM)
        return _round1(size * LINE_EM)

    @property
    def minimum(self) -> float:
        factor = MIN_FIXED_EM if self.style.shape in ("id", "fixed") else MIN_LINE_EM
        return min(self.natural, _ceil1(self.font.min_size * factor))


@dataclass(frozen=True)
class _Row:
    parts: tuple[_Part, ...]  # ein Feld, oder Packungs-ID und Einlagerdatum zusammen

    @property
    def natural(self) -> float:
        return max(part.natural for part in self.parts)

    @property
    def minimum(self) -> float:
        return max(part.minimum for part in self.parts)


def _escape(text: str) -> str:
    """Fester Text in ``value``: Geschweifte Klammern stehen für Platzhalter und werden verdoppelt."""
    return text.replace("{", "{{").replace("}", "}}")


def _part(kind: LabelKind, layout: LabelLayout, index: int, entry: LabelField) -> _Part | None:
    style = STYLES[kind][entry.field]
    short = layout.date == LabelDateStyle.SHORT
    value: str
    when: str | None
    if entry.field == LabelFieldName.TEXT:
        if not layout.text.strip():
            return None  # ohne Text keine Zeile
        value, when = _escape(layout.text), None
    elif entry.field == LabelFieldName.BEST_BEFORE:
        key = "best_before_short" if short else "best_before"
        value, when = f"MHD {{{key}}}", key
    elif entry.field == LabelFieldName.STORED:
        key = "stored_short" if short else "stored"
        value, when = f"{{{key}}}", key
    elif entry.field in (LabelFieldName.TITLE, LabelFieldName.ID):
        # Wie in den mitgelieferten Vorlagen ohne „when": Name und ID gibt es immer.
        value, when = f"{{{entry.field.value}}}", None
    else:
        value, when = f"{{{entry.field.value}}}", entry.field.value
    lines = (entry.lines or 1) if entry.field == LabelFieldName.TITLE else 1
    return _Part(entry.field, index, style, style.sizes[entry.size], lines, value, when)


def _rows(kind: LabelKind, layout: LabelLayout) -> list[_Row]:
    """Die Zeilen von oben nach unten. Packungs-ID und Einlagerdatum direkt nacheinander teilen sich eine."""
    parts = [
        part
        for index, entry in enumerate(layout.fields)
        if (part := _part(kind, layout, index, entry)) is not None
    ]
    rows: list[_Row] = []
    pair = {LabelFieldName.ID, LabelFieldName.STORED}
    position = 0
    while position < len(parts):
        current = parts[position]
        following = parts[position + 1] if position + 1 < len(parts) else None
        if following is not None and {current.field, following.field} == pair:
            rows.append(_Row((current, following)))
            position += 2
        else:
            rows.append(_Row((current,)))
            position += 1
    return rows


def _fit(rows: list[_Row], available: float, area: Area) -> list[float]:
    """Die Höhen der Zeilen: wie gewünscht, oder alle gleichmäßig niedriger bis zur Mindesthöhe."""
    natural = sum(row.natural for row in rows)
    if natural <= available + 1e-9:
        return [row.natural for row in rows]
    minimum = sum(row.minimum for row in rows)
    if minimum > available + 1e-9:
        raise LabelDesignError(_tight(area), ("fields",))
    share = (available - minimum) / (natural - minimum)
    return [_floor2(row.minimum + (row.natural - row.minimum) * share) for row in rows]


@dataclass(frozen=True)
class _Placed:
    row: _Row
    y: float
    height: float
    footer: bool


def _vertical(rows: list[_Row], area: Area, divider: bool) -> tuple[list[_Placed], float | None]:
    """Senkrechte Lage der Zeilen und der Trennlinie (``None`` = keine)."""
    height = area.height_mm
    if not rows:
        return [], None
    if len(rows) == 1:
        available = height - TOP_MM - BOTTOM_MM
        (single,) = _fit(rows, available, area)
        return [_Placed(rows[0], TOP_MM + (available - single) / 2, single, False)], None
    above_footer = 2 * DIVIDER_GAP_MM if divider else ROW_GAP_MM
    available = height - TOP_MM - BOTTOM_MM - ROW_GAP_MM * (len(rows) - 2) - above_footer
    heights = _fit(rows, available, area)
    slack = max(0.0, available - sum(heights))
    grow = min(slack, max(0.0, FOOTER_MIN_MM - heights[-1]))
    heights[-1] += grow
    slack -= grow
    footer_y = height - BOTTOM_MM - heights[-1]
    placed: list[_Placed] = []
    y = TOP_MM + slack / 2
    for row, row_height in zip(rows[:-1], heights[:-1], strict=True):
        placed.append(_Placed(row, y, row_height, False))
        y += row_height + ROW_GAP_MM
    placed.append(_Placed(rows[-1], footer_y, heights[-1], True))
    return placed, (footer_y - DIVIDER_GAP_MM if divider else None)


# --- Die Vorlage ---------------------------------------------------------------------------------


def _text_element(
    part: _Part, x: float, y: float, w: float, h: float, *, align: str, valign: str
) -> dict[str, Any]:
    element: dict[str, Any] = {
        "type": "text",
        "x": _mm(x),
        "y": _mm(y),
        "w": _mm(w),
        "h": _mm(h),
        "value": part.value,
        "font": part.style.font,
        "size": part.font.size,
        "min_size": part.font.min_size,
    }
    if part.lines > 1:
        element["max_lines"] = part.lines
    if align != "left":
        element["align"] = align
    if valign != "top":
        element["valign"] = valign
    if part.when is not None:
        element["when"] = part.when
    return element


def _row_elements(placed: _Placed, left: float, right: float, layout: LabelLayout) -> list[dict[str, Any]]:
    width = right - left
    parts = placed.row.parts
    if len(parts) == 1:
        (part,) = parts
        # Die unterste Zeile ist oft höher als ihre Schrift: Dort steht der Text in der Mitte.
        valign = "middle" if placed.footer else part.style.valign
        return [_text_element(part, left, placed.y, width, placed.height, align="left", valign=valign)]
    # Packungs-ID und Einlagerdatum: die ID so breit wie ihre fünf Zeichen, das Datum im Rest.
    first, second = parts
    ident = first if first.field == LabelFieldName.ID else second
    id_width = min(width, _round1(ident.font.size * ID_WIDTH_EM))
    if width - id_width < 1.0:
        raise LabelDesignError(_fixed_problem(LabelFieldName.ID, layout), ("fields", second.index))
    first_width = id_width if first is ident else width - id_width
    return [
        _text_element(first, left, placed.y, first_width, placed.height, align="left", valign="middle"),
        _text_element(
            second,
            left + first_width,
            placed.y,
            width - first_width,
            placed.height,
            align="right",
            valign="middle",
        ),
    ]


def _media(area: Area) -> dict[str, Any]:
    def number(value: float) -> float | int:
        return int(value) if float(value).is_integer() else value

    return {
        "id": area.paper.id,
        "kind": area.paper.kind,
        "width_mm": number(area.paper.width_mm),
        "length_mm": number(area.length_mm),
    }


def build_template(kind: LabelKind | str, paper: str, layout: LabelLayout) -> dict[str, Any]:
    """Die Vorlage einer Etikettenart aus Papier und Gestaltung (docs/etiketten.md, 3.4).

    Deterministisch und ohne Rendern. ``LabelDesignError`` mit einem Satz, wenn die Gestaltung nicht
    zum Papier passt: unbekanntes Papier, Länge bei gestanzten bzw. fehlend bei Endlosrollen, ein Feld,
    das es auf Zonen-Etiketten nicht gibt, ein doppeltes Feld, Zeilen außerhalb des Namens, ein zu
    großer QR-Code, zu wenig Platz daneben oder zu viele Felder für die Höhe.
    """
    kind = LabelKind(kind)
    spec = paper_of(paper)
    _check_layout(kind, spec, layout)
    area = area_of(spec, layout.length_mm)

    qr = QR_SIZES[kind][layout.qr.size]
    smallest = QR_SIZES[kind][LabelSize.SMALL]
    if smallest.size_mm > area.height_mm + 1e-9 or smallest.size_mm + 2 * SIDE_MM > area.width_mm + 1e-9:
        raise LabelDesignError(NO_QR_FITS, ("paper",))
    if qr.size_mm > area.height_mm + 1e-9 or qr.size_mm + 2 * SIDE_MM > area.width_mm + 1e-9:
        raise LabelDesignError(_qr_too_large(area), ("qr", "size"))
    modules = QR_MODULES[kind] + 2 * qr.quiet
    if math.floor(qr.size_mm * area.scale / modules + 1e-6) < QR_MIN_MODULE_PX:
        raise LabelDesignError(QR_TOO_SMALL, ("qr", "size"))
    if layout.qr.side == LabelQrSide.LEFT:
        qr_x = SIDE_MM
        left, right = SIDE_MM + qr.size_mm + QR_GAP_MM, area.width_mm - SIDE_MM
    else:
        qr_x = area.width_mm - SIDE_MM - qr.size_mm
        left, right = SIDE_MM, area.width_mm - SIDE_MM - qr.size_mm - QR_GAP_MM
    elements: list[dict[str, Any]] = [
        {
            "type": "qr",
            "x": _mm(qr_x),
            "y": _mm((area.height_mm - qr.size_mm) / 2),
            "size": qr.size_mm,
            "value": "{qr}",
            "ec": "Q",
            "quiet": qr.quiet,
            "min_module_px": QR_MIN_MODULE_PX,
        }
    ]

    rows = _rows(kind, layout)
    if rows and right - left < COLUMN_MIN_MM - 1e-9:
        raise LabelDesignError(
            "Neben dem QR-Code bleibt zu wenig Platz für die Felder: QR-Code kleiner wählen, alle Felder "
            "ausschalten oder ein größeres Etikett nehmen.",
            ("qr", "size"),
        )
    placed, line_y = _vertical(rows, area, layout.divider)
    for entry in placed:
        if entry.footer and line_y is not None:
            elements.append(
                {
                    "type": "line",
                    "x1": _mm(left),
                    "y1": _mm(line_y),
                    "x2": _mm(right),
                    "y2": _mm(line_y),
                    "width": DIVIDER_WIDTH_MM,
                }
            )
        elements.extend(_row_elements(entry, left, right, layout))

    template: dict[str, Any] = {"schema": area.format, "name": kind.value, "media": _media(area)}
    if area.format == 2:
        template["rotate"] = area.rotate
    template["design"] = {"width_mm": area.width_mm, "height_mm": area.height_mm}
    template["elements"] = elements
    return template


def is_default(kind: LabelKind | str, paper: str, layout: LabelLayout) -> bool:
    """Entspricht die Gestaltung einer Etikettenart der mitgelieferten Vorlage?"""
    return paper == DEFAULT_PAPER_ID and layout == DEFAULT_LAYOUTS[LabelKind(kind)]


def template_for(kind: LabelKind | str, paper: str, layout: LabelLayout) -> dict[str, Any]:
    """Die Vorlage, die für eine Gestaltung gilt: bei der Vorgabe die mitgelieferte (gleicher ``hash``,
    Speichern der Vorgabe ändert nichts), sonst die erzeugte."""
    kind = LabelKind(kind)
    if is_default(kind, paper, layout):
        return load_builtin(kind.value)
    return build_template(kind, paper, layout)


# --- Prüfen durch Rendern und Hinweise -----------------------------------------------------------

_PLACEHOLDER = re.compile(r"\{\{|\}\}|\{([A-Za-z_][A-Za-z0-9_]*)\}")
_DATA_FIELDS = {
    "title": LabelFieldName.TITLE,
    "subtitle": LabelFieldName.SUBTITLE,
    "quantity": LabelFieldName.QUANTITY,
    "brand": LabelFieldName.BRAND,
    "best_before": LabelFieldName.BEST_BEFORE,
    "best_before_short": LabelFieldName.BEST_BEFORE,
    "stored": LabelFieldName.STORED,
    "stored_short": LabelFieldName.STORED,
    "id": LabelFieldName.ID,
    "zone": LabelFieldName.ZONE,
}


def field_of(element: dict[str, Any]) -> LabelFieldName:
    """Welches Feld ein Textelement zeigt: nach dem ersten Platzhalter, ohne einen der eigene Text."""
    value = element.get("value")
    for match in _PLACEHOLDER.finditer(value if isinstance(value, str) else ""):
        name = match.group(1)
        if name is not None:
            return _DATA_FIELDS.get(name, LabelFieldName.TEXT)
    return LabelFieldName.TEXT


def _render(template: dict[str, Any], data: dict[str, str]) -> tuple[Any, list[Any]]:
    """Rendern ohne Drucker: Format 2 in der Fläche des Papiers der Vorlage, so wie man es liest."""
    try:
        return render_with_report(template, data)
    except RenderError as exc:
        message = str(exc)
        if "QR-Code" in message and "Modul" in message:
            raise LabelDesignError(QR_TOO_SMALL, ("qr", "size")) from exc
        raise LabelDesignError(f"Das Etikett lässt sich so nicht drucken: {message}") from exc


def _fixed_problem(field: LabelFieldName, layout: LabelLayout) -> str:
    """Der Satz, wenn eine Packungs-ID oder ein Datum nur gekürzt passte, mit dem, was hilft."""
    together = field in (LabelFieldName.ID, LabelFieldName.STORED) and _shares_row(layout)
    if together:
        subject = "Packungs-ID und Einlagerdatum passen nicht nebeneinander"
    elif field == LabelFieldName.ID:
        subject = "Die Packungs-ID passt nicht in ihre Zeile"
    elif field == LabelFieldName.BEST_BEFORE:
        subject = "Das MHD passt nicht in seine Zeile"
    else:
        subject = "Das Einlagerdatum passt nicht in seine Zeile"
    advice = ["kleiner wählen"]
    if field != LabelFieldName.ID and layout.date == LabelDateStyle.LONG:
        advice.append("das kurze Datum nehmen")
    advice.append("den QR-Code verkleinern")
    if together:
        advice.append("ein Feld dazwischen stellen")
    return f"{subject}: {', '.join(advice[:-1])} oder {advice[-1]}."


def _shares_row(layout: LabelLayout) -> bool:
    names = [
        entry.field for entry in layout.fields if entry.field != LabelFieldName.TEXT or layout.text.strip()
    ]
    pair = {LabelFieldName.ID, LabelFieldName.STORED}
    return any({a, b} == pair for a, b in zip(names, names[1:], strict=False))


def _index_of(layout: LabelLayout, field: LabelFieldName) -> int | None:
    return next((index for index, entry in enumerate(layout.fields) if entry.field == field), None)


def check(kind: LabelKind | str, paper: str, layout: LabelLayout) -> dict[str, Any]:
    """Die Vorlage einer Etikettenart, geprüft: erzeugt (``template_for``) und mit Grenzdaten gerendert.

    ``LabelDesignError`` mit Satz, wenn die Gestaltung nicht passt, der Renderer scheitert (etwa ein
    QR-Code unter 6 Pixeln je Modul) oder eine Packungs-ID oder ein Datum nur gekürzt passt.
    """
    kind = LabelKind(kind)
    template = template_for(kind, paper, layout)
    _image, report = _render(template, LIMIT_DATA[kind])
    elements = template["elements"]
    for placed in report:
        if placed.type != "text" or not placed.drawn or not placed.truncated:
            continue
        field = field_of(elements[placed.index])
        if field in FIXED_FIELDS:
            index = _index_of(layout, field)
            raise LabelDesignError(
                _fixed_problem(field, layout), ("fields",) if index is None else ("fields", index)
            )
    return template


def check_design(design: LabelDesign) -> dict[LabelKind, dict[str, Any]]:
    """Beide Vorlagen einer Gestaltung, geprüft. Die Stelle eines Fehlers beginnt mit der Etikettenart
    (``("package", "fields", 2)``) oder ist ``("paper",)``."""
    paper_of(design.paper)
    templates: dict[LabelKind, dict[str, Any]] = {}
    for kind in LabelKind:
        try:
            templates[kind] = check(kind, design.paper, getattr(design, kind.value))
        except LabelDesignError as exc:
            if exc.loc[:1] == ("paper",):
                raise
            raise LabelDesignError(exc.message, (kind.value, *exc.loc)) from exc
    return templates


def _decimal(value: float) -> str:
    return f"{value:.1f}".replace(".", ",")


def notes_of(kind: LabelKind | str, template: dict[str, Any], report: list[Any]) -> list[str]:
    """Was nur verkleinert oder gekürzt passt, als Sätze: „Name auf 3,0 mm verkleinert und gekürzt."."""
    kind = LabelKind(kind)
    notes: list[str] = []
    elements = template["elements"]
    for placed in report:
        if placed.type != "text" or not placed.drawn:
            continue
        element = elements[placed.index]
        size = element.get("size")
        shrunk = (
            isinstance(size, (int, float)) and placed.size_mm is not None and placed.size_mm < size - 1e-9
        )
        if not shrunk and not placed.truncated:
            continue
        name = FIELD_NAMES[kind].get(field_of(element), "Eigener Text")
        if shrunk and placed.truncated:
            note = f"{name} auf {_decimal(placed.size_mm)} mm verkleinert und gekürzt."
        elif shrunk:
            note = f"{name} auf {_decimal(placed.size_mm)} mm verkleinert."
        else:
            note = f"{name} gekürzt."
        if note not in notes:
            notes.append(note)
    return notes


def preview_data(kind: LabelKind | str, data: dict[str, str]) -> dict[str, str]:
    """Die Daten der Vorschau, so wie die App sie schickt (``DATA_LIMITS``): Längeres und Zeichen, die sich
    nicht drucken lassen, lehnt ``LabelDesignError`` mit Satz ab (Stelle ``("data", schlüssel)``);
    unbekannte Schlüssel fallen weg."""
    kind = LabelKind(kind)
    limits = DATA_LIMITS[kind]
    checked: dict[str, str] = {}
    for key, value in data.items():
        limit = limits.get(key)
        if limit is None:
            continue
        name = FIELD_NAMES[kind][LabelFieldName.SUBTITLE] if key == "subtitle" else _DATA_NAMES[key]
        if len(value) > limit:
            raise LabelDesignError(
                f"Zu lang für ein Etikett: {name} höchstens {limit} Zeichen.", ("data", key)
            )
        if not _printable(value):
            raise LabelDesignError(f"{name} enthält Zeichen, die sich nicht drucken lassen.", ("data", key))
        checked[key] = value
    return checked


def preview(kind: LabelKind | str, paper: str, layout: LabelLayout, data: dict[str, str] | None) -> Preview:
    """Rendert ein Etikett zur Ansicht, ohne etwas zu speichern: die Vorlage wie beim Speichern geprüft
    (``check``), dann mit ``data`` (``None`` = ``SAMPLE_DATA``) gerendert, so wie man es liest. Die Daten
    dürfen nicht länger sein, als die App sie schickt (``preview_data``).

    Ist der Inhalt des QR-Codes in ``data`` kein Stowly-Code dieser Etikettenart (oder fehlt er), steht der
    des Beispiels dort: Ein Etikett hat immer einen, und ein fremder Inhalt sagte über die Gestaltung nichts.
    """
    kind = LabelKind(kind)
    content = dict(SAMPLE_DATA[kind]) if data is None else preview_data(kind, data)
    template = check(kind, paper, layout)
    parsed = ids.parse_qr(content.get("qr", ""))
    if parsed is None or parsed[0] != kind.value:
        content["qr"] = SAMPLE_DATA[kind]["qr"]
    else:  # in der Form, die die App druckt (große Buchstaben: der kleinste QR-Code)
        content["qr"] = ids.package_qr(parsed[1]) if kind == LabelKind.PACKAGE else ids.zone_qr(parsed[1])
    image, report = _render(template, content)
    return Preview(to_png(image), image.width, image.height, notes_of(kind, template, report))
