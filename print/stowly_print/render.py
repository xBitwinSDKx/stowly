"""Renderer: Vorlage und Daten werden zu einem 1-Bit-Bild (docs/etiketten.md, 3.4).

Gerendert wird dort, wo der Drucker hängt: Nur diese Stelle kennt druckbare Breite und
Auflösung. Das Ergebnis ist ein Pillow-Bild im Modus ``"1"`` in genau der Größe, die der
Treiber erwartet, ohne Graustufen und ohne Dithering.

Was sich nicht rendern lässt, wirft ``RenderError`` (Antwort 422 ``render_failed``):
unbekanntes ``schema``, unbekannter Elementtyp, ein QR-Code, der nicht in sein Feld passt.
Der Renderer rät nie.

Text im Kasten, die Regeln im Einzelnen:

* Umbrochen wird an Leerzeichen, innerhalb eines Wortes nach ``-`` und ``/``.
* Passt der Text nicht, wird die Schrift in Schritten von 0,2 mm bis ``min_size`` kleiner.
  Erst wenn keine Größe ohne Trennen mitten im Wort auskommt, wird auch dort getrennt
  (zwischen Buchstaben mit Trennstrich, in etwa gleich langen Stücken).
* Reicht auch das nicht, endet die letzte Zeile mit „…".
* „Passt" heißt: höchstens ``max_lines`` Zeilen, keine breiter als der Kasten, und das
  Gezeichnete ist zusammen nicht höher als der Kasten. Gezeichnet wird nie außerhalb.
* ``size`` ist die Schriftgröße (Geviert) in Millimetern. Der Zeilenabstand ist der der Schrift.
"""

import base64
import io
import itertools
import logging
import math
import re
import threading
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import segno
from PIL import Image, ImageDraw, ImageFont

from stowly_print.model import MAX_PNG_BYTES, Capabilities
from stowly_print.templates import TEMPLATE_SCHEMA

log = logging.getLogger("stowly_print.render")

MM_PER_INCH = 25.4
# Vorgabe dieser Stufe, wenn kein Drucker genannt ist: 62-mm-Rolle bei 300 dpi.
DEFAULT_DPI = 300
DEFAULT_WIDTH_PX = 696

FONT_STEP_MM = 0.2
ELLIPSIS = "…"
# Beim Trennen mitten im Wort bleiben nie weniger Zeichen allein auf einer Zeile.
MIN_PIECE = 3
# Grenzen gegen Vorlagen, die den Dienst nur beschäftigen sollen.
MAX_ELEMENTS = 100
MAX_LENGTH_PX = 6000
MAX_TEXT_LENGTH = 2000

# Die drei Schriften des Vertrags und ihre Dateien (Familie DejaVu).
FONT_FILES = {
    "regular": "DejaVuSans.ttf",
    "bold": "DejaVuSans-Bold.ttf",
    "mono": "DejaVuSansMono-Bold.ttf",
}
PACKAGE_FONT_DIR = Path(__file__).resolve().parent / "fonts"
SYSTEM_FONT_DIR = Path("/usr/share/fonts/truetype/dejavu")

# Steht die eingebaute Schrift für die Festbreitenschrift ein, darf sie kleiner werden als
# ``min_size``: Sie läuft bei breiten Buchstaben weiter als DejaVu Sans Mono, für die der Kasten
# bemessen ist, und eine abgeschnittene Packungs-ID wäre schlimmer als eine kleinere.
# Untergrenze: dieser Anteil von ``min_size``, mindestens BUILTIN_MONO_MIN_MM.
BUILTIN_MONO_FACTOR = 0.6
BUILTIN_MONO_MIN_MM = 1.6

ALIGN = ("left", "center", "right")
VALIGN = ("top", "middle", "bottom")
EC_LEVELS = ("L", "M", "Q", "H")
ELEMENT_TYPES = ("text", "qr", "line", "rect")

_PLACEHOLDER = re.compile(r"\{\{|\}\}|\{([A-Za-z_][A-Za-z0-9_]*)\}")
_WHITESPACE = re.compile(r"\s+")
_WORD = re.compile(r"\S+")
# Nach diesen Zeichen darf innerhalb eines Wortes umbrochen werden.
_SOFT_BREAK = re.compile(r"(?<=[/-])(?=[^\s/-])")

# Ersatz für Zeichen, die eine Schrift nicht hat. Betrifft praktisch nur die in Pillow
# eingebaute Schrift: Sie kennt weder Umlaute noch „ß". DejaVu hat alle diese Zeichen.
_SUBSTITUTES = {
    "ä": "ae",
    "ö": "oe",
    "ü": "ue",
    "Ä": "Ae",
    "Ö": "Oe",
    "Ü": "Ue",
    "ß": "ss",
    "ẞ": "SS",
    "–": "-",
    "—": "-",
    "‐": "-",
    "‑": "-",
    "„": '"',
    "“": '"',
    "”": '"',
    "‚": "'",
    "‘": "'",
    "’": "'",
    "×": "x",
    "€": "EUR",
    "℮": "e",
    "⁄": "/",
    "…": "...",
    "·": "-",
    "•": "-",
    " ": " ",
    " ": " ",
}

# Ein Renderer nach dem anderen: FreeType-Schriften vertragen keinen gleichzeitigen Zugriff,
# und Rechenzeit ließe sich unter dem GIL ohnehin nicht teilen.
_RENDER_LOCK = threading.Lock()


class RenderError(Exception):
    """Vorlage oder Daten lassen sich nicht rendern. Die Meldung ist deutsch und für den Anwender."""


@dataclass(frozen=True)
class Target:
    """Die druckbare Fläche, für die gerendert wird."""

    dpi: int = DEFAULT_DPI
    width_px: int = DEFAULT_WIDTH_PX
    # Feste Länge des Materials in Pixeln; None = Endlosrolle, die Länge nennt die Vorlage.
    length_px: int | None = None

    @classmethod
    def of(cls, capabilities: Capabilities | None) -> "Target":
        """Die Fläche eines Druckers; ohne Drucker die Vorgabe aus docs/etiketten.md, 3.4."""
        if capabilities is None:
            return cls()
        media = capabilities.media
        length_px = None if media.length_mm is None else mm_to_px(media.length_mm, capabilities.dpi)
        return cls(dpi=capabilities.dpi, width_px=media.printable_px, length_px=length_px)


def mm_to_px(mm: float, dpi: int) -> int:
    """Ganze Pixel, die in eine Länge passen (29 mm bei 300 dpi sind 342)."""
    return int(math.floor(mm * dpi / MM_PER_INCH + 1e-6))


@dataclass(frozen=True)
class Placed:
    """Was aus einem Element geworden ist. Für Tests und Fehlersuche."""

    index: int
    type: str
    drawn: bool
    box: tuple[int, int, int, int]  # links, oben, rechts, unten in Pixeln (rechts/unten ausschließlich)
    lines: tuple[str, ...] = ()
    size_mm: float | None = None  # verwendete Schriftgröße
    truncated: bool = False  # endet mit „…"
    module_px: int | None = None  # QR: Pixel je Modul
    ink: tuple[int, int, int, int] | None = None  # was wirklich gezeichnet wurde


# --------------------------------------------------------------------------- Schriften


class _Glyphs:
    """Weiß für eine Schriftdatei, welche Zeichen fehlen, und ersetzt sie lesbar."""

    PROBE_PX = 24

    def __init__(self, font: ImageFont.FreeTypeFont) -> None:
        self._font = font
        self._known: dict[str, bool] = {}
        # Das Kästchen für „Zeichen fehlt" sieht für jedes fehlende Zeichen gleich aus.
        self._notdef = self._picture("￿")

    def _picture(self, char: str) -> bytes:
        size = self.PROBE_PX * 3
        image = Image.new("1", (size, size), 1)
        draw = ImageDraw.Draw(image)
        draw.fontmode = "1"
        draw.text((self.PROBE_PX, self.PROBE_PX * 2), char, font=self._font, fill=0, anchor="ls")
        return image.tobytes()

    def has(self, char: str) -> bool:
        known = self._known.get(char)
        if known is None:
            known = char.isspace() or self._picture(char) != self._notdef
            self._known[char] = known
        return known

    def readable(self, text: str) -> str:
        """Ersetzt fehlende Zeichen: Umlaute ausgeschrieben, Akzente weggelassen."""
        if all(self.has(char) for char in set(text)):
            return text
        result: list[str] = []
        for char in text:
            if self.has(char):
                result.append(char)
                continue
            replacement = _SUBSTITUTES.get(char)
            if replacement is None:
                replacement = "".join(
                    _SUBSTITUTES.get(part, part)
                    for part in unicodedata.normalize("NFKD", char)
                    if not unicodedata.combining(part)
                )
            # Was auch der Ersatz nicht hergibt, bleibt als Kästchen stehen: ehrlicher als weglassen.
            result.append(replacement or char)
        return _WHITESPACE.sub(" ", "".join(result)).strip()


@dataclass
class _Face:
    """Eine geladene Schrift in einer Größe."""

    font: ImageFont.FreeTypeFont
    ascent: int
    descent: int
    glyphs: _Glyphs = field(repr=False)
    builtin: bool  # die in Pillow eingebaute Schrift, nicht die Datei aus dem Vertrag
    _boxes: dict[str, tuple[int, int, int, int]] = field(default_factory=dict, repr=False)

    def bbox(self, text: str) -> tuple[int, int, int, int]:
        """Gezeichnete Fläche relativ zum Schreibpunkt auf der Grundlinie."""
        box = self._boxes.get(text)
        if box is None:
            left, top, right, bottom = self.font.getbbox(text, mode="1", anchor="ls")
            box = (math.floor(left), math.floor(top), math.ceil(right), math.ceil(bottom))
            if len(self._boxes) > 4000:
                self._boxes.clear()
            self._boxes[text] = box
        return box

    def extent(self, text: str) -> int:
        """Breite, die eine Zeile im Kasten braucht."""
        left, _top, right, _bottom = self.bbox(text)
        return right - min(0, left)


class Fonts:
    """Schriftquelle des Renderers.

    Jede Datei wird der Reihe nach in ``directories`` gesucht: zuerst im Paket
    (``stowly_print/fonts``), dann unter den Schriften des Systems. Fehlt sie überall,
    steht die in Pillow eingebaute Schrift für sie ein, und das steht einmal im Log.

    Die eingebaute Schrift kennt nur eine Form und keine Umlaute: ``bold`` und ``mono``
    sehen dann aus wie ``regular``, „ä" wird „ae". Für echte Etiketten gehört DejaVu dazu.
    """

    def __init__(self, directories: Iterable[Path | str] | None = None) -> None:
        if directories is None:
            directories = (PACKAGE_FONT_DIR, SYSTEM_FONT_DIR)
        self.directories = tuple(Path(directory) for directory in directories)
        self._lock = threading.RLock()
        self._paths: dict[str, Path | None] = {}
        self._faces: dict[tuple[str, int], _Face] = {}
        self._glyphs: dict[str, _Glyphs] = {}

    @classmethod
    def builtin(cls) -> "Fonts":
        """Bewusst nur die in Pillow eingebaute Schrift, gleich was auf dem Rechner liegt.

        Für Tests: Ihr Ergebnis hängt so nicht davon ab, welche Schriften installiert sind.
        """
        return cls(directories=())

    def path(self, name: str) -> Path | None:
        """Die Datei für ``regular``, ``bold`` oder ``mono``; ``None`` = eingebaute Schrift."""
        with self._lock:
            if name not in self._paths:
                filename = FONT_FILES[name]
                found = next(
                    (
                        directory / filename
                        for directory in self.directories
                        if (directory / filename).is_file()
                    ),
                    None,
                )
                if found is None and self.directories:
                    self._warn_missing(filename)
                self._paths[name] = found
            return self._paths[name]

    def _warn_missing(self, filename: str) -> None:
        log.warning(
            "Schrift %s fehlt (gesucht in %s): Es gilt die in Pillow eingebaute Schrift, "
            "ohne Umlaute und ohne Fett- und Festbreitenschrift.",
            filename,
            ", ".join(str(directory) for directory in self.directories),
        )

    def describe(self) -> dict[str, str]:
        """Woher jede der drei Schriften kommt. Für Log und Bericht."""
        return {name: str(self.path(name) or "eingebaut") for name in FONT_FILES}

    def face(self, name: str, size_px: int) -> _Face:
        with self._lock:
            path = self.path(name)
            key = (name, size_px)
            face = self._faces.get(key)
            if face is None:
                if len(self._faces) > 256:
                    self._faces.clear()
                font = self._load(name, path, size_px)
                path = self._paths[name]  # eine unlesbare Datei gilt ab jetzt als fehlend
                source = name if path is not None else "eingebaut"
                glyphs = self._glyphs.get(source)
                if glyphs is None:
                    glyphs = _Glyphs(self._load(name, path, _Glyphs.PROBE_PX))
                    self._glyphs[source] = glyphs
                ascent, descent = font.getmetrics()
                face = _Face(
                    font=font,
                    ascent=int(ascent),
                    descent=int(descent),
                    glyphs=glyphs,
                    builtin=path is None,
                )
                self._faces[key] = face
            return face

    def _load(self, name: str, path: Path | None, size_px: int) -> ImageFont.FreeTypeFont:
        if path is not None:
            try:
                # Immer die einfache Zeilensetzung: Mit libraqm fielen dieselben Etiketten je nach
                # Rechner verschieden breit aus.
                return ImageFont.truetype(str(path), size_px, layout_engine=ImageFont.Layout.BASIC)
            except OSError as exc:
                log.warning("Schrift %s ist nicht lesbar (%s): Es gilt die eingebaute Schrift.", path, exc)
                self._paths[name] = None
        try:
            font = ImageFont.load_default(size_px)
        except (ImportError, OSError) as exc:
            raise RenderError("Auf diesem Rechner lässt sich keine Schrift laden (FreeType fehlt).") from exc
        if not isinstance(font, ImageFont.FreeTypeFont):
            raise RenderError("Auf diesem Rechner lässt sich keine Schrift laden (FreeType fehlt).")
        return font


_default_fonts: Fonts | None = None
_default_fonts_lock = threading.Lock()


def default_fonts() -> Fonts:
    """Die Schriftquelle des Betriebs: Paket, dann System, dann eingebaut."""
    global _default_fonts
    with _default_fonts_lock:
        if _default_fonts is None:
            _default_fonts = Fonts()
        return _default_fonts


# --------------------------------------------------------------------------- Vorlage lesen


def _number(
    source: dict[str, Any],
    key: str,
    where: str,
    *,
    default: float | None = None,
    minimum: float | None = None,
    exclusive: bool = False,
) -> float:
    value = source.get(key, default)
    if value is None:
        raise RenderError(f"{where}: '{key}' fehlt.")
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise RenderError(f"{where}: '{key}' muss eine Zahl sein.")
    if minimum is not None and (value < minimum or (exclusive and value == minimum)):
        raise RenderError(f"{where}: '{key}' ist zu klein.")
    if abs(value) > 10_000:
        raise RenderError(f"{where}: '{key}' ist zu groß.")
    return float(value)


def _choice(source: dict[str, Any], key: str, where: str, allowed: tuple[str, ...], default: str) -> str:
    value = source.get(key, default)
    if not isinstance(value, str) or value not in allowed:
        raise RenderError(f"{where}: '{key}' muss eines von {', '.join(allowed)} sein.")
    return value


def _value(element: dict[str, Any], where: str) -> str:
    value = element.get("value", "")
    if not isinstance(value, str):
        raise RenderError(f"{where}: 'value' muss eine Zeichenkette sein.")
    return value


def substitute(pattern: str, data: dict[str, str]) -> str:
    """Setzt ``{feld}`` ein. Fehlende Felder sind leer; ``{{`` und ``}}`` stehen für die Klammern."""

    def replace(match: re.Match[str]) -> str:
        token = match.group(0)
        if token == "{{":
            return "{"
        if token == "}}":
            return "}"
        return data.get(match.group(1), "")

    return _PLACEHOLDER.sub(replace, pattern)


def _clean(text: str) -> str:
    """Eine Zeile ohne Steuerzeichen, Leerraum zusammengezogen."""
    spaced = "".join(" " if char.isspace() else char for char in text)
    visible = "".join(char for char in spaced if unicodedata.category(char) not in ("Cc", "Cf"))
    return _WHITESPACE.sub(" ", visible).strip()


@dataclass(frozen=True)
class _Frame:
    """Bildet Millimeter der Zeichenfläche auf Pixel des Etiketts ab."""

    scale: float  # Pixel je Millimeter
    left: float
    top: float

    def x(self, mm: float) -> float:
        return self.left + mm * self.scale

    def y(self, mm: float) -> float:
        return self.top + mm * self.scale

    def box(self, x: float, y: float, w: float, h: float) -> tuple[int, int, int, int]:
        left, top = round(self.x(x)), round(self.y(y))
        right, bottom = round(self.x(x + w)), round(self.y(y + h))
        return left, top, max(right, left + 1), max(bottom, top + 1)


# --------------------------------------------------------------------------- Text


@dataclass(frozen=True)
class _Line:
    """Eine Zeile als Ausschnitt des Textes; ``hyphen`` = mitten im Wort getrennt."""

    start: int
    end: int
    hyphen: bool = False

    def text(self, source: str) -> str:
        return source[self.start : self.end] + ("-" if self.hyphen else "")


def _needs_hyphen(source: str, cut: int) -> bool:
    """Ein Trennstrich gehört nur zwischen zwei Buchstaben, nicht in eine Ziffernfolge."""
    return source[cut - 1].isalpha() and source[cut : cut + 1].isalpha()


def _piece(source: str, start: int, cut: int) -> str:
    return source[start:cut] + ("-" if _needs_hyphen(source, cut) else "")


def _break_greedy(source: str, start: int, end: int, face: _Face, width: int) -> list[int]:
    """Schnittstellen, die ``source[start:end]`` in Stücke zerlegen, die in die Zeile passen."""
    cuts: list[int] = []
    while face.extent(source[start:end]) > width:
        cut = start + 1
        while cut + 1 < end and face.extent(_piece(source, start, cut + 1)) <= width:
            cut += 1
        cuts.append(cut)
        start = cut
    return cuts


def _break_word(source: str, start: int, end: int, face: _Face, width: int, *, balance: bool) -> list[int]:
    """Trennt ein Wort ohne Trennstelle, möglichst in etwa gleich lange Stücke.

    Ohne ``balance`` (der Text wird ohnehin gekürzt) gilt das nur für zwei Stücke; bei mehr
    wird jede Zeile ganz gefüllt, damit möglichst viel vom Wort zu sehen ist.
    """
    cuts = _break_greedy(source, start, end, face, width)
    if not cuts:
        return cuts
    if balance or len(cuts) == 1:
        # Gleich breit, nicht gleich viele Zeichen: „iii" ist schmaler als „mmm".
        count = len(cuts) + 1
        total = face.extent(source[start:end])
        even: list[int] = []
        for number in range(1, count):
            wanted = total * number / count
            floor = (even[-1] if even else start) + 1
            even.append(
                min(
                    range(floor, end - (count - number) + 1),
                    key=lambda cut, wanted=wanted: abs(face.extent(source[start:cut]) - wanted),
                    default=floor,
                )
            )
        edges = [start, *even, end]
        pieces = [
            _piece(source, edges[i], edges[i + 1]) if i < count - 1 else source[edges[i] : end]
            for i in range(count)
        ]
        if all(face.extent(piece) <= width for piece in pieces):
            return even
    # Nicht ein, zwei Buchstaben allein auf die nächste Zeile schieben.
    if end - cuts[-1] < MIN_PIECE:
        previous = cuts[-2] if len(cuts) > 1 else start
        moved = max(previous + 1, end - MIN_PIECE)
        if moved < cuts[-1]:
            cuts[-1] = moved
    return cuts


def _wrap(source: str, face: _Face, width: int, *, break_words: bool, balance: bool) -> list[_Line] | None:
    """Bricht ``source`` auf Zeilen der Breite ``width`` um.

    ``None`` heißt: Es ginge nur mit Trennen mitten im Wort, und das ist nicht erlaubt.
    """
    lines: list[_Line] = []
    line_start: int | None = None
    line_end = 0
    for word in _WORD.finditer(source):
        # Teile eines Wortes, zwischen denen umbrochen werden darf („Bio-" und „Hafer").
        breaks = (word.start() + match.start() for match in _SOFT_BREAK.finditer(word.group()))
        for part_start, part_end in itertools.pairwise([word.start(), *breaks, word.end()]):
            if line_start is not None and face.extent(source[line_start:part_end]) <= width:
                line_end = part_end
                continue
            if line_start is not None:
                lines.append(_Line(line_start, line_end))
                line_start = None
            if face.extent(source[part_start:part_end]) > width:
                if not break_words:
                    return None
                previous = part_start
                for cut in _break_word(source, part_start, part_end, face, width, balance=balance):
                    lines.append(_Line(previous, cut, hyphen=_needs_hyphen(source, cut)))
                    previous = cut
                part_start = previous
            line_start, line_end = part_start, part_end
    if line_start is not None:
        lines.append(_Line(line_start, line_end))
    return lines


def _ink_span(texts: list[str], face: _Face) -> tuple[int, int]:
    """Obere und untere Kante des Gezeichneten, gemessen von der Grundlinie der ersten Zeile."""
    pitch = face.ascent + face.descent
    top: int | None = None
    bottom: int | None = None
    for index, text in enumerate(texts):
        _left, line_top, _right, line_bottom = face.bbox(text)
        if line_top == line_bottom:
            continue
        upper, lower = index * pitch + line_top, index * pitch + line_bottom
        top = upper if top is None else min(top, upper)
        bottom = lower if bottom is None else max(bottom, lower)
    if top is None or bottom is None:
        return 0, 0
    return top, bottom


def _fits(texts: list[str], face: _Face, width: int, height: int, max_lines: int) -> bool:
    if len(texts) > max_lines or any(face.extent(text) > width for text in texts):
        return False
    top, bottom = _ink_span(texts, face)
    return bottom - top <= height


def _sizes(size: float, min_size: float) -> list[float]:
    """Schriftgrößen in mm: von ``size`` in Schritten von 0,2 mm bis ``min_size``."""
    sizes = []
    steps = 0
    while size - steps * FONT_STEP_MM > min_size + 1e-9:
        sizes.append(round(size - steps * FONT_STEP_MM, 4))
        steps += 1
    sizes.append(round(min_size, 4))
    return sizes


def _truncate(
    source: str, lines: list[_Line], face: _Face, width: int, height: int, max_lines: int
) -> tuple[list[str], bool]:
    """Kürzt auf die Zeilen, die in den Kasten passen; die letzte endet dann mit „…"."""
    texts = [line.text(source) for line in lines]
    count = max(1, min(max_lines, len(texts)))
    while count > 1 and not _fits(texts[:count], face, width, height, count):
        count -= 1
    if count >= len(texts):
        return texts, False
    # Die letzte Zeile nimmt vom Rest, so viel hineinpasst, auch ein angefangenes Wort.
    start = lines[count - 1].start
    end = start
    while end < len(source) and face.extent(source[start : end + 1].rstrip(" -/") + ELLIPSIS) <= width:
        end += 1
    return [*texts[: count - 1], source[start:end].rstrip(" -/") + ELLIPSIS], True


def _layout_text(
    text: str,
    fonts: Fonts,
    font_name: str,
    frame: _Frame,
    size: float,
    min_size: float,
    box: tuple[int, int, int, int],
    max_lines: int,
) -> tuple[list[str], _Face, float, bool]:
    """Wählt Schriftgröße und Zeilen. Liefert ``(zeilen, schrift, größe in mm, gekürzt)``."""
    width, height = box[2] - box[0], box[3] - box[1]
    sizes = _sizes(size, min_size)
    if font_name == "mono" and fonts.face(font_name, max(1, round(min_size * frame.scale))).builtin:
        floor = min(min_size, max(BUILTIN_MONO_MIN_MM, min_size * BUILTIN_MONO_FACTOR))
        sizes = [*sizes, *_sizes(min_size, floor)[1:]]

    candidates: list[tuple[float, _Face, str]] = []
    seen: set[int] = set()
    for size_mm in sizes:
        size_px = max(1, round(size_mm * frame.scale))
        if size_px in seen:
            continue
        seen.add(size_px)
        face = fonts.face(font_name, size_px)
        candidates.append((size_mm, face, face.glyphs.readable(text)))

    # Erst ohne Trennen mitten im Wort, dann mit: lieber eine Stufe kleiner als ein zerrissenes Wort.
    for break_words in (False, True):
        for size_mm, face, readable in candidates:
            lines = _wrap(readable, face, width, break_words=break_words, balance=True)
            if lines is None:
                continue
            texts = [line.text(readable) for line in lines]
            if _fits(texts, face, width, height, max_lines):
                return texts, face, size_mm, False

    size_mm, face, readable = candidates[-1]
    lines = _wrap(readable, face, width, break_words=True, balance=False) or []
    texts, truncated = _truncate(readable, lines, face, width, height, max_lines)
    return texts, face, size_mm, truncated


def _draw_text(
    image: Image.Image, element: dict[str, Any], index: int, frame: _Frame, data: dict[str, str], fonts: Fonts
) -> Placed:
    where = f"Element {index + 1} (text)"
    box = frame.box(
        _number(element, "x", where),
        _number(element, "y", where),
        _number(element, "w", where, minimum=0, exclusive=True),
        _number(element, "h", where, minimum=0, exclusive=True),
    )
    value = _value(element, where)
    font_name = _choice(element, "font", where, tuple(FONT_FILES), "regular")
    size = _number(element, "size", where, minimum=0, exclusive=True)
    min_size = min(size, _number(element, "min_size", where, default=size, minimum=0, exclusive=True))
    max_lines = int(_number(element, "max_lines", where, default=1, minimum=1))
    align = _choice(element, "align", where, ALIGN, "left")
    valign = _choice(element, "valign", where, VALIGN, "top")

    text = _clean(substitute(value, data))[:MAX_TEXT_LENGTH].strip()
    if not text:
        return Placed(index=index, type="text", drawn=False, box=box)
    lines, face, size_mm, truncated = _layout_text(
        text, fonts, font_name, frame, size, min_size, box, max_lines
    )
    if not lines:
        return Placed(index=index, type="text", drawn=False, box=box)

    left, top, right, bottom = box
    width, height = right - left, bottom - top
    pitch = face.ascent + face.descent
    block = len(lines) * pitch
    if valign == "top":
        block_top = top
    elif valign == "middle":
        block_top = top + (height - block) // 2
    else:
        block_top = bottom - block
    baseline = block_top + face.ascent
    # Das Gezeichnete bleibt im Kasten, auch wenn ein Akzent über die Oberlänge der Schrift ragt.
    ink_top, ink_bottom = _ink_span(lines, face)
    if baseline + ink_bottom > bottom:
        baseline = bottom - ink_bottom
    if baseline + ink_top < top:
        baseline = top - ink_top

    # Auf eine eigene Ebene in der Größe des Kastens: Was darüber hinausragte (nur bei einer
    # Vorlage, deren Kasten kleiner ist als eine Zeile der kleinsten Schrift), fällt weg.
    layer = Image.new("1", (width, height), 1)
    draw = ImageDraw.Draw(layer)
    draw.fontmode = "1"
    for number, line in enumerate(lines):
        line_left, _line_top, line_right, _line_bottom = face.bbox(line)
        if align == "left":
            pen = -min(0, line_left)
        elif align == "right":
            pen = width - line_right
        else:
            pen = (width - (line_right - line_left)) // 2 - line_left
        draw.text((pen, baseline - top + number * pitch), line, font=face.font, fill=0, anchor="ls")
    # Nur das Schwarze übertragen: Was andere Elemente im Kasten gezeichnet haben, bleibt stehen.
    mask = layer.point(lambda value: 255 if value == 0 else 0, mode="L")
    image.paste(0, (left, top), mask)
    found = mask.getbbox()
    return Placed(
        index=index,
        type="text",
        drawn=True,
        box=box,
        lines=tuple(lines),
        size_mm=size_mm,
        truncated=truncated,
        ink=None if found is None else (found[0] + left, found[1] + top, found[2] + left, found[3] + top),
    )


# --------------------------------------------------------------------------- QR, Linie, Rechteck


def qr_matrix(value: str, ec: str = "Q") -> tuple[tuple[int, ...], ...]:
    """Die Module eines QR-Codes ohne Ruhezone: kleinste Version bei mindestens ``ec``.

    Passt in derselben Version auch eine höhere Fehlerkorrektur, nimmt segno sie.
    """
    try:
        code = segno.make(value, error=ec.lower(), micro=False)
    except (ValueError, segno.DataOverflowError) as exc:
        raise RenderError("Der Inhalt passt in keinen QR-Code.") from exc
    return tuple(tuple(1 if module else 0 for module in row) for row in code.matrix)


def _draw_qr(
    image: Image.Image, element: dict[str, Any], index: int, frame: _Frame, data: dict[str, str]
) -> Placed:
    where = f"Element {index + 1} (qr)"
    x = _number(element, "x", where)
    y = _number(element, "y", where)
    size = _number(element, "size", where, minimum=0, exclusive=True)
    value = _value(element, where)
    ec = _choice(element, "ec", where, EC_LEVELS, "Q")
    quiet = int(_number(element, "quiet", where, default=4, minimum=0))
    min_module_px = int(_number(element, "min_module_px", where, default=6, minimum=1))

    content = substitute(value, data)
    if not content:
        raise RenderError(f"{where}: Der QR-Code hat keinen Inhalt.")
    matrix = qr_matrix(content, ec)
    modules = len(matrix)
    total = modules + 2 * quiet
    field_px = size * frame.scale
    module_px = int(math.floor(field_px / total + 1e-6))
    if module_px < min_module_px:
        raise RenderError(
            f"{where}: Der QR-Code passt nicht in sein Feld "
            f"({module_px} Pixel je Modul, mindestens {min_module_px} sind nötig)."
        )
    side = total * module_px
    left = round(frame.x(x) + (field_px - side) / 2)
    top = round(frame.y(y) + (field_px - side) / 2)
    draw = ImageDraw.Draw(image)
    origin_x, origin_y = left + quiet * module_px, top + quiet * module_px
    for row_number, row in enumerate(matrix):
        for column, dark in enumerate(row):
            if dark:
                x0 = origin_x + column * module_px
                y0 = origin_y + row_number * module_px
                draw.rectangle((x0, y0, x0 + module_px - 1, y0 + module_px - 1), fill=0)
    code_side = modules * module_px
    return Placed(
        index=index,
        type="qr",
        drawn=True,
        box=(left, top, left + side, top + side),
        lines=(content,),
        module_px=module_px,
        ink=(origin_x, origin_y, origin_x + code_side, origin_y + code_side),
    )


def _draw_line(image: Image.Image, element: dict[str, Any], index: int, frame: _Frame) -> Placed:
    where = f"Element {index + 1} (line)"
    x1 = frame.x(_number(element, "x1", where))
    y1 = frame.y(_number(element, "y1", where))
    x2 = frame.x(_number(element, "x2", where))
    y2 = frame.y(_number(element, "y2", where))
    thickness = max(1, round(_number(element, "width", where, default=0.25, minimum=0) * frame.scale))
    draw = ImageDraw.Draw(image)
    if round(y1) == round(y2):
        left, top = round(min(x1, x2)), round(y1 - thickness / 2)
        box = (left, top, max(round(max(x1, x2)), left + 1), top + thickness)
        draw.rectangle((box[0], box[1], box[2] - 1, box[3] - 1), fill=0)
    elif round(x1) == round(x2):
        left, top = round(x1 - thickness / 2), round(min(y1, y2))
        box = (left, top, left + thickness, max(round(max(y1, y2)), top + 1))
        draw.rectangle((box[0], box[1], box[2] - 1, box[3] - 1), fill=0)
    else:
        draw.line((round(x1), round(y1), round(x2), round(y2)), fill=0, width=thickness)
        box = (
            round(min(x1, x2)) - thickness,
            round(min(y1, y2)) - thickness,
            round(max(x1, x2)) + thickness,
            round(max(y1, y2)) + thickness,
        )
    return Placed(index=index, type="line", drawn=True, box=box)


def _draw_rect(image: Image.Image, element: dict[str, Any], index: int, frame: _Frame) -> Placed:
    where = f"Element {index + 1} (rect)"
    box = frame.box(
        _number(element, "x", where),
        _number(element, "y", where),
        _number(element, "w", where, minimum=0, exclusive=True),
        _number(element, "h", where, minimum=0, exclusive=True),
    )
    fill = element.get("fill", False)
    if not isinstance(fill, bool):
        raise RenderError(f"{where}: 'fill' muss true oder false sein.")
    stroke = max(1, round(_number(element, "stroke", where, default=0.25, minimum=0) * frame.scale))
    draw = ImageDraw.Draw(image)
    corners = (box[0], box[1], box[2] - 1, box[3] - 1)
    if fill:
        draw.rectangle(corners, fill=0)
    else:
        draw.rectangle(corners, outline=0, width=stroke)
    return Placed(index=index, type="rect", drawn=True, box=box)


# --------------------------------------------------------------------------- Einstieg


def _checked_data(data: Any) -> dict[str, str]:
    if not isinstance(data, dict):
        raise RenderError("Die Daten des Etiketts müssen ein Objekt sein.")
    for key, value in data.items():
        if not isinstance(key, str) or not isinstance(value, str):
            raise RenderError("Die Daten des Etiketts dürfen nur Zeichenketten enthalten.")
    return data


def _canvas(template: dict[str, Any], target: Target) -> tuple[Image.Image, _Frame]:
    """Leeres Etikett in der Größe des Druckers und die Abbildung der Zeichenfläche darauf."""
    design = template.get("design")
    if not isinstance(design, dict):
        raise RenderError("Die Vorlage nennt keine Zeichenfläche ('design').")
    design_width = _number(design, "width_mm", "design", minimum=0, exclusive=True)
    design_height = _number(design, "height_mm", "design", minimum=0, exclusive=True)

    if target.width_px < 1 or target.dpi < 1:
        raise RenderError("Der Drucker nennt keine druckbare Fläche.")
    length_px = target.length_px
    if length_px is None:
        media = template.get("media")
        if not isinstance(media, dict):
            raise RenderError("Die Vorlage nennt kein Material ('media').")
        length_px = mm_to_px(_number(media, "length_mm", "media", minimum=0, exclusive=True), target.dpi)
    if not 1 <= length_px <= MAX_LENGTH_PX or target.width_px > MAX_LENGTH_PX:
        raise RenderError("Die Größe des Etiketts liegt außerhalb dessen, was sich drucken lässt.")

    # Gleichmäßig skalieren und zentrieren: So passt dieselbe Vorlage auf jede Auflösung.
    scale = min(target.width_px / design_width, length_px / design_height)
    frame = _Frame(
        scale=scale,
        left=(target.width_px - design_width * scale) / 2,
        top=(length_px - design_height * scale) / 2,
    )
    return Image.new("1", (target.width_px, length_px), 1), frame


def render_with_report(
    template: Any,
    data: Any,
    target: Target | Capabilities | None = None,
    *,
    fonts: Fonts | None = None,
) -> tuple[Image.Image, list[Placed]]:
    """Wie ``render``, zusätzlich mit dem, was aus jedem Element geworden ist."""
    if not isinstance(target, Target):
        target = Target.of(target)
    if not isinstance(template, dict):
        raise RenderError("Die Vorlage muss ein Objekt sein.")
    schema = template.get("schema")
    if isinstance(schema, bool) or schema != TEMPLATE_SCHEMA:
        raise RenderError(f"Die Vorlage hat ein unbekanntes Format (schema {schema!r}).")
    elements = template.get("elements")
    if not isinstance(elements, list):
        raise RenderError("Die Vorlage enthält keine Elemente.")
    if len(elements) > MAX_ELEMENTS:
        raise RenderError("Die Vorlage hat zu viele Elemente.")
    data = _checked_data(data)
    fonts = fonts or default_fonts()

    with _RENDER_LOCK:
        image, frame = _canvas(template, target)
        report: list[Placed] = []
        for index, element in enumerate(elements):
            if not isinstance(element, dict):
                raise RenderError(f"Element {index + 1} ist kein Objekt.")
            kind = element.get("type")
            if not isinstance(kind, str) or kind not in ELEMENT_TYPES:
                raise RenderError(f"Element {index + 1} hat einen unbekannten Typ ({kind!r}).")
            when = element.get("when")
            if when is not None:
                if not isinstance(when, str):
                    raise RenderError(f"Element {index + 1}: 'when' muss ein Feldname sein.")
                if not data.get(when, "").strip():
                    report.append(Placed(index=index, type=kind, drawn=False, box=(0, 0, 0, 0)))
                    continue
            if kind == "text":
                report.append(_draw_text(image, element, index, frame, data, fonts))
            elif kind == "qr":
                report.append(_draw_qr(image, element, index, frame, data))
            elif kind == "line":
                report.append(_draw_line(image, element, index, frame))
            else:
                report.append(_draw_rect(image, element, index, frame))
        return image, report


def render(
    template: Any,
    data: Any,
    target: Target | Capabilities | None = None,
    *,
    fonts: Fonts | None = None,
) -> Image.Image:
    """Rendert ein Etikett als 1-Bit-Bild in der Größe von ``target``.

    ``target`` ist die Fläche eines Druckers (``Capabilities`` oder ``Target``); ohne Angabe
    gilt die Vorgabe: 696 Pixel Breite bei 300 dpi, Länge aus der Vorlage. ``fonts`` legt die
    Schriftquelle fest; Tests nehmen ``Fonts.builtin()``, damit ihr Ergebnis nicht vom Rechner abhängt.
    """
    return render_with_report(template, data, target, fonts=fonts)[0]


def decode_png(encoded: str, target: Target | Capabilities | None = None) -> Image.Image:
    """Der Notausgang: ein fertiges 1-Bit-PNG, Base64. Muss genau auf den Drucker passen."""
    if not isinstance(target, Target):
        target = Target.of(target)
    try:
        raw = base64.b64decode(encoded, validate=True)
    except ValueError as exc:
        raise RenderError("'png' ist kein gültiges Base64.") from exc
    if len(raw) > MAX_PNG_BYTES:
        raise RenderError("'png' ist zu groß.")
    try:
        image = Image.open(io.BytesIO(raw), formats=("PNG",))
        width, height = image.size
        if width != target.width_px:
            raise RenderError(f"Das Bild ist {width} Pixel breit, der Drucker erwartet {target.width_px}.")
        if target.length_px is not None and height != target.length_px:
            raise RenderError(f"Das Bild ist {height} Pixel lang, der Drucker erwartet {target.length_px}.")
        if not 1 <= height <= MAX_LENGTH_PX:
            raise RenderError("Die Länge des Bildes liegt außerhalb dessen, was sich drucken lässt.")
        if image.mode != "1":
            raise RenderError("Das Bild muss ein 1-Bit-PNG sein (nur Schwarz und Weiß).")
        image.load()
    except RenderError:
        raise
    except Exception as exc:  # Pillow meldet kaputte Dateien mit ganz verschiedenen Ausnahmen
        raise RenderError("'png' lässt sich nicht als PNG lesen.") from exc
    return image.copy()


def to_png(image: Image.Image) -> bytes:
    """Das Etikett als PNG-Datei (1 Bit je Pixel)."""
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()
