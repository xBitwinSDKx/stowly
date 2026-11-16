"""Der Renderer: Vorlage und Daten werden zum 1-Bit-Bild (docs/etiketten.md, 3.4).

Die Schriftquelle legen die Tests selbst fest (``Fonts.builtin()``, die in Pillow eingebaute
Schrift), damit kein Ergebnis davon abhängt, welche Schriften auf dem Rechner liegen. Nur die
Tests unter „Schriften" nehmen ausdrücklich die mitgelieferten DejaVu-Dateien aus dem Paket.

Referenzbilder neu schreiben: ``python -m pytest tests/test_render.py --update-references``
"""

import base64
import hashlib
import io
import logging
from pathlib import Path

import pytest
from PIL import Image, ImageChops, ImageFont
from print_support import REFERENCE_DIR

from stowly_print.model import Capabilities, Media
from stowly_print.render import (
    FONT_FILES,
    PACKAGE_FONT_DIR,
    Fonts,
    Placed,
    RenderError,
    Target,
    decode_png,
    mm_to_px,
    qr_matrix,
    render,
    render_with_report,
    substitute,
    to_png,
)
from stowly_print.templates import load_builtin

BUILTIN = Fonts.builtin()

PACKAGE = {
    "qr": "STOWLY/P/A2B3C",
    "id": "A2B3C",
    "title": "Basmati Reis",
    "subtitle": "1 kg · Kornhaus",
    "best_before": "25.03.2027",
    "stored": "13.11.2026",
    "zone": "",
}
PACKAGE_LONG = {
    "qr": "STOWLY/P/9ZX4K",
    "id": "9ZX4K",
    "title": "Bio Vollkorn Haferflocken extra zart aus kontrolliert ökologischem Anbau, Großpackung",
    "subtitle": "1000 g · Mühlenhof Naturkost Erzeugergemeinschaft",
    "best_before": "01.12.2027",
    "stored": "13.11.2026",
    "zone": "Keller",
}
ZONE = {"qr": "STOWLY/Z/3F2B8C1E5A474D099B6E0C1D2E3F4A5B", "title": "Keller", "subtitle": "Lagerzone"}

# Anteil der Pixel, der in den Textkästen vom Referenzbild abweichen darf. Linien und QR-Code
# entstehen aus ganzen Rechtecken und müssen genau stimmen; nur Schrift rastert FreeType je
# nach Version an den Rändern der Buchstaben um ein Pixel anders. Auf dem Rechner, auf dem
# die Referenzbilder entstanden sind, ist die Abweichung null.
TEXT_TOLERANCE = 0.02


def black(image: Image.Image, box: tuple[int, int, int, int] | None = None) -> int:
    """Anzahl schwarzer Pixel, im ganzen Bild oder in einem Ausschnitt."""
    part = image if box is None else image.crop(box)
    return part.histogram()[0]


def ink_box(image: Image.Image) -> tuple[int, int, int, int] | None:
    return ImageChops.invert(image.convert("L")).getbbox()


def inside(inner: tuple[int, int, int, int], outer: tuple[int, int, int, int]) -> bool:
    return inner[0] >= outer[0] and inner[1] >= outer[1] and inner[2] <= outer[2] and inner[3] <= outer[3]


def texts(report: list[Placed]) -> list[Placed]:
    return [placed for placed in report if placed.type == "text"]


def text_template(**element) -> dict:
    """Eine Vorlage mit genau einem Textelement in einem Kasten von 30 × 10 mm."""
    base = {"type": "text", "x": 5, "y": 5, "w": 30, "h": 10, "value": "{t}", "font": "regular", "size": 4}
    return {
        "schema": 1,
        "media": {"width_mm": 62, "length_mm": 29},
        "design": {"width_mm": 58.9, "height_mm": 29.0},
        "elements": [{**base, **element}],
    }


# --- Referenzbilder ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "kind", "data"),
    [
        ("package-62x29", "package", PACKAGE),
        ("package-62x29-lang", "package", PACKAGE_LONG),
        ("zone-62x29", "zone", ZONE),
    ],
)
def test_builtin_templates_match_their_reference_images(name, kind, data, update_references):
    if ImageFont.load_default(10).getname() != ("Aileron", "Regular"):
        pytest.skip("Diese Pillow-Version bringt eine andere eingebaute Schrift mit.")
    image, report = render_with_report(load_builtin(kind), data, fonts=BUILTIN)
    path = REFERENCE_DIR / f"{name}.png"
    if update_references:
        path.parent.mkdir(exist_ok=True)
        image.save(path, format="PNG", optimize=True)

    with Image.open(path) as stored:
        reference = stored.copy()
    assert reference.mode == "1"
    assert reference.size == image.size == (696, 342)

    difference = ImageChops.logical_xor(image, reference)
    # Außerhalb der Textkästen (QR-Code, Linie, Rand) gibt es keine Abweichung.
    outside = difference.copy()
    in_text = 0
    for placed in texts(report):
        in_text += difference.crop(placed.box).histogram()[-1]
        outside.paste(0, placed.box)
    assert outside.histogram()[-1] == 0
    area = sum((p.box[2] - p.box[0]) * (p.box[3] - p.box[1]) for p in texts(report) if p.drawn)
    assert in_text <= TEXT_TOLERANCE * area, f"{in_text} von {area} Pixeln weichen ab"


def test_result_is_one_bit_in_exactly_the_default_size():
    image = render(load_builtin("package"), PACKAGE, fonts=BUILTIN)
    assert image.mode == "1"
    assert image.size == (696, 342)
    # 62 mm Rolle bei 300 dpi: 29 mm Länge sind 342 Pixel (docs/etiketten.md, 3.1).
    assert mm_to_px(29, 300) == 342
    assert mm_to_px(25.4, 300) == 300
    # Nur Schwarz und Weiß: Das PNG hat ein Bit je Pixel.
    with Image.open(io.BytesIO(to_png(image))) as stored:
        assert stored.mode == "1"
        assert stored.size == (696, 342)


# --- QR-Code -----------------------------------------------------------------------------


def read_modules(image: Image.Image, placed: Placed, modules: int) -> tuple[tuple[int, ...], ...]:
    """Liest die Module aus dem Bild zurück: jedes ganz schwarz oder ganz weiß."""
    size = placed.module_px
    left, top, _right, _bottom = placed.ink
    rows = []
    for row in range(modules):
        cells = []
        for column in range(modules):
            cell = (
                left + column * size,
                top + row * size,
                left + (column + 1) * size,
                top + (row + 1) * size,
            )
            dark = black(image, cell)
            assert dark in (0, size * size), "Ein Modul ist weder ganz schwarz noch ganz weiß"
            cells.append(1 if dark else 0)
        rows.append(tuple(cells))
    return tuple(rows)


@pytest.mark.parametrize(
    ("kind", "data", "modules", "module_px"),
    [("package", PACKAGE, 21, 9), ("zone", ZONE, 29, 8)],
)
def test_qr_code_can_be_read_back_from_the_image(kind, data, modules, module_px):
    image, report = render_with_report(load_builtin(kind), data, fonts=BUILTIN)
    qr = next(placed for placed in report if placed.type == "qr")
    # Packung: Version 1 mit 9 Pixeln je Modul, 16 mm breit. Zone: Version 3, knapp 20 mm.
    assert qr.module_px == module_px
    assert qr.lines == (data["qr"],)
    expected = qr_matrix(data["qr"], "Q")
    assert len(expected) == modules
    assert read_modules(image, qr, modules) == expected

    # Ruhezone: vier Module rundum sind weiß, und der Code sitzt mittig in seinem Feld.
    left, top, right, bottom = qr.ink
    quiet = 4 * module_px
    ring = image.crop((left - quiet, top - quiet, right + quiet, bottom + quiet))
    assert black(ring) == black(image, qr.ink)
    assert qr.box == (left - quiet, top - quiet, right + quiet, bottom + quiet)


def test_qr_code_uses_the_smallest_version_for_the_requested_error_correction():
    assert len(qr_matrix("STOWLY/P/A2B3C", "Q")) == 21  # Version 1
    assert len(qr_matrix("STOWLY/Z/3F2B8C1E5A474D099B6E0C1D2E3F4A5B", "Q")) == 29  # Version 3
    assert len(qr_matrix("STOWLY/P/A2B3C", "H")) == 25  # bei H reicht Version 1 nicht mehr
    with pytest.raises(RenderError):
        qr_matrix("x" * 5000, "H")


def test_qr_field_that_is_too_small_fails_instead_of_shrinking_modules():
    template = load_builtin("package")
    template["elements"][0]["size"] = 14.0  # 14 mm für 29 Module: 5 Pixel je Modul
    with pytest.raises(RenderError, match="mindestens 6"):
        render(template, PACKAGE, fonts=BUILTIN)
    # Mit einer kleineren Untergrenze geht es.
    template["elements"][0]["min_module_px"] = 5
    _image, report = render_with_report(template, PACKAGE, fonts=BUILTIN)
    assert report[0].module_px == 5


def test_qr_without_content_fails():
    with pytest.raises(RenderError, match="keinen Inhalt"):
        render(load_builtin("package"), {**PACKAGE, "qr": ""}, fonts=BUILTIN)


# --- Ablehnen statt raten ----------------------------------------------------------------


@pytest.mark.parametrize("schema", [2, 0, "1", None, True, 1.5])
def test_unknown_schema_is_rejected(schema):
    template = load_builtin("package")
    template["schema"] = schema
    with pytest.raises(RenderError, match="unbekanntes Format"):
        render(template, PACKAGE, fonts=BUILTIN)


def test_unknown_element_type_is_rejected():
    template = load_builtin("package")
    template["elements"].append({"type": "barcode", "x": 1, "y": 1})
    with pytest.raises(RenderError, match="unbekannten Typ"):
        render(template, PACKAGE, fonts=BUILTIN)


@pytest.mark.parametrize(
    "broken",
    [
        "keine Vorlage",
        {"schema": 1},
        {"schema": 1, "elements": [], "media": {"length_mm": 29}},
        {"schema": 1, "elements": "x", "design": {"width_mm": 58.9, "height_mm": 29}},
        {"schema": 1, "elements": [], "design": {"width_mm": 0, "height_mm": 29}, "media": {"length_mm": 29}},
        {"schema": 1, "elements": [], "design": {"width_mm": 58.9, "height_mm": 29}},
        {
            "schema": 1,
            "elements": [],
            "design": {"width_mm": 58.9, "height_mm": 29},
            "media": {"length_mm": 5000},
        },
        {
            "schema": 1,
            "elements": [7],
            "design": {"width_mm": 58.9, "height_mm": 29},
            "media": {"length_mm": 29},
        },
    ],
)
def test_broken_templates_are_rejected(broken):
    with pytest.raises(RenderError):
        render(broken, {}, fonts=BUILTIN)


@pytest.mark.parametrize(
    "element",
    [
        {"x": "links"},
        {"w": 0},
        {"h": -1},
        {"size": 0},
        {"font": "comic"},
        {"align": "block"},
        {"valign": "oben"},
        {"max_lines": 0},
        {"value": 5},
        {"when": 5},
        {"x": float("nan")},
        {"x": True},
    ],
)
def test_broken_elements_are_rejected(element):
    with pytest.raises(RenderError):
        render(text_template(**element), {"t": "Text"}, fonts=BUILTIN)


def test_data_must_be_strings():
    with pytest.raises(RenderError):
        render(load_builtin("package"), {**PACKAGE, "title": 5}, fonts=BUILTIN)
    with pytest.raises(RenderError):
        render(load_builtin("package"), ["x"], fonts=BUILTIN)


def test_too_many_elements_are_rejected():
    template = text_template()
    template["elements"] = template["elements"] * 101
    with pytest.raises(RenderError, match="zu viele"):
        render(template, {"t": "x"}, fonts=BUILTIN)


# --- Text --------------------------------------------------------------------------------


def test_placeholders_and_doubled_braces():
    data = {"a": "eins", "leer": ""}
    assert substitute("{a} und {b}", data) == "eins und "
    assert substitute("{{a}} {a} }}{{", data) == "{a} eins }{"
    assert substitute("MHD {leer}", data) == "MHD "
    assert (
        substitute("kein {feld mit leerzeichen} und { offen", data)
        == "kein {feld mit leerzeichen} und { offen"
    )


def test_every_text_stays_inside_its_box():
    for kind, samples in (("package", (PACKAGE, PACKAGE_LONG)), ("zone", (ZONE,))):
        for data in samples:
            _image, report = render_with_report(load_builtin(kind), data, fonts=BUILTIN)
            for placed in texts(report):
                if placed.drawn:
                    assert placed.ink is not None
                    assert inside(placed.ink, placed.box), (kind, placed)


@pytest.mark.parametrize(
    "value",
    [
        "Ägypten ÖL ÜBER Çà gjpqy",
        "j" * 60,
        "W" * 60,
        "Ein sehr langer Name mit vielen kurzen Worten und noch viel mehr Worten dahinter",
        "Donaudampfschifffahrtsgesellschaftskapitänsmützenhersteller",
        "4006381333931400638133393140063813339314006381333931",
        "Bio-Vollkorn-Dinkel-Roggen/Weizen-Mischung",
        "A",
        "(|)",
    ],
)
@pytest.mark.parametrize("align", ["left", "center", "right"])
@pytest.mark.parametrize("valign", ["top", "middle", "bottom"])
def test_nothing_is_ever_drawn_outside_the_box(value, align, valign):
    template = text_template(align=align, valign=valign, max_lines=2, min_size=2.5)
    image, report = render_with_report(template, {"t": value}, fonts=BUILTIN)
    placed = report[0]
    assert placed.drawn
    assert black(image) == black(image, placed.box) > 0
    assert inside(ink_box(image), placed.box)


def test_long_name_wraps_then_shrinks_then_ends_with_an_ellipsis():
    template = load_builtin("package")
    short = texts(render_with_report(template, PACKAGE, fonts=BUILTIN)[1])[0]
    assert (short.lines, short.size_mm, short.truncated) == (("Basmati Reis",), 4.2, False)

    # Zwei Zeilen in voller Größe.
    two = texts(
        render_with_report(template, {**PACKAGE, "title": "Basmati Reis aus dem Himalaya"}, fonts=BUILTIN)[1]
    )[0]
    assert len(two.lines) == 2
    assert two.size_mm == 4.2
    assert not two.truncated

    # Mehr Text: zwei Zeilen, aber kleiner.
    smaller = texts(
        render_with_report(
            template, {**PACKAGE, "title": "Basmati Reis aus dem Himalaya, duftend"}, fonts=BUILTIN
        )[1]
    )[0]
    assert len(smaller.lines) == 2
    assert 3.0 <= smaller.size_mm < 4.2
    assert not smaller.truncated
    assert " ".join(smaller.lines) == "Basmati Reis aus dem Himalaya, duftend"

    # Noch mehr: kleinste Größe der Vorlage, zwei Zeilen, die letzte endet mit „…".
    longest = texts(render_with_report(template, PACKAGE_LONG, fonts=BUILTIN)[1])[0]
    assert len(longest.lines) == 2
    assert longest.size_mm == 3.0
    assert longest.truncated
    assert longest.lines[-1].endswith("…")
    assert longest.lines[0] == "Bio Vollkorn"
    assert longest.lines[1].startswith("Haferflocken extra")
    assert inside(longest.ink, longest.box)


def test_font_shrinks_in_steps_of_a_fifth_of_a_millimetre():
    template = text_template(size=5.0, min_size=3.0)
    sizes = set()
    for length in range(4, 40):
        placed = render_with_report(template, {"t": "n" * length}, fonts=BUILTIN)[1][0]
        sizes.add(placed.size_mm)
        assert placed.truncated == placed.lines[-1].endswith("…")
    assert sizes <= {round(5.0 - step * 0.2, 4) for step in range(11)}
    assert {5.0, 3.0} <= sizes
    assert len(sizes) > 5


def test_without_min_size_the_font_never_shrinks():
    template = text_template(size=5.0)
    placed = render_with_report(
        template, {"t": "Ein Text, der in dieser Größe nicht in den Kasten passt"}, fonts=BUILTIN
    )[1][0]
    assert placed.size_mm == 5.0
    assert placed.truncated
    assert len(placed.lines) == 1


def test_a_word_is_only_split_when_no_size_avoids_it():
    template = text_template(size=5.0, min_size=3.0, max_lines=2, w=30)
    # Passt ungetrennt, sobald die Schrift klein genug ist: lieber kleiner als zerrissen.
    whole = render_with_report(template, {"t": "Haferflockenmix"}, fonts=BUILTIN)[1][0]
    assert whole.lines == ("Haferflockenmix",)
    assert whole.size_mm < 5.0
    # Passt in keiner Größe auf eine Zeile: getrennt mit Trennstrich, in etwa gleich breiten Stücken.
    split = render_with_report(template, {"t": "Donaudampfschifffahrtsgesellschaft"}, fonts=BUILTIN)[1][0]
    assert len(split.lines) == 2
    assert split.lines[0].endswith("-")
    assert not split.truncated
    assert split.lines[0][:-1] + split.lines[1] == "Donaudampfschifffahrtsgesellschaft"
    assert abs(len(split.lines[0]) - len(split.lines[1])) <= 3
    # Reicht auch das nicht, wird jede Zeile gefüllt und die letzte gekürzt.
    cut = render_with_report(template, {"t": "Donaudampfschifffahrtsgesellschaftskapitän"}, fonts=BUILTIN)[1][
        0
    ]
    assert cut.truncated and cut.size_mm == 3.0
    assert cut.lines[0].endswith("-") and cut.lines[1].endswith("…")
    assert "Donaudampfschifffahrtsgesellschaftskapitaen".startswith(cut.lines[0][:-1] + cut.lines[1][:-1])
    # Ziffernfolgen bekommen keinen Trennstrich.
    digits = render_with_report(template, {"t": "4" * 50}, fonts=BUILTIN)[1][0]
    assert all("-" not in line for line in digits.lines)


def test_words_break_after_hyphens_and_slashes():
    template = text_template(size=4.0, max_lines=3, h=20, w=24)
    placed = render_with_report(template, {"t": "Bio-Vollkorn-Dinkel/Roggen"}, fonts=BUILTIN)[1][0]
    assert not placed.truncated
    assert "".join(placed.lines) == "Bio-Vollkorn-Dinkel/Roggen"
    assert len(placed.lines) > 1
    assert all(line[-1] in "-/" for line in placed.lines[:-1])


def test_empty_fields_drop_their_line():
    template = load_builtin("package")
    full_image, full = render_with_report(template, PACKAGE, fonts=BUILTIN)
    empty = {**PACKAGE, "subtitle": "", "best_before": "", "stored": ""}
    image, report = render_with_report(template, empty, fonts=BUILTIN)
    values = [element.get("value", element["type"]) for element in template["elements"]]
    by_value = dict(zip(values, report, strict=True))
    full_by_value = dict(zip(values, full, strict=True))
    for value in ("{subtitle}", "MHD {best_before}", "{stored}"):
        assert not by_value[value].drawn
        box = full_by_value[value].box
        assert black(full_image, box) > 0
        assert black(image, box) == 0, value
    # „MHD" steht ohne Datum nicht allein da; Titel, ID und QR-Code bleiben.
    assert by_value["{title}"].drawn and by_value["{id}"].drawn and by_value["{qr}"].drawn

    # Nur Leerraum zählt als leer; ein fehlendes Feld ebenso.
    blank = {key: value for key, value in PACKAGE.items() if key != "subtitle"}
    blank["best_before"] = "   "
    report = render_with_report(template, blank, fonts=BUILTIN)[1]
    assert [placed.drawn for placed in report] == [True, True, False, False, True, True, True]


def test_when_draws_an_element_only_if_its_field_is_set():
    template = text_template(when="flag", value="fest")
    assert not render_with_report(template, {}, fonts=BUILTIN)[1][0].drawn
    assert not render_with_report(template, {"flag": ""}, fonts=BUILTIN)[1][0].drawn
    assert render_with_report(template, {"flag": "x"}, fonts=BUILTIN)[1][0].lines == ("fest",)
    # Gilt für jede Art von Element.
    line = {"type": "line", "x1": 1, "y1": 1, "x2": 20, "y2": 1, "width": 0.5, "when": "flag"}
    template["elements"] = [line]
    assert black(render(template, {}, fonts=BUILTIN)) == 0
    assert black(render(template, {"flag": "ja"}, fonts=BUILTIN)) > 0


def test_alignment_inside_the_box():
    boxes = {}
    for align in ("left", "center", "right"):
        for valign in ("top", "middle", "bottom"):
            template = text_template(align=align, valign=valign, w=40, h=20)
            placed = render_with_report(template, {"t": "Hxg"}, fonts=BUILTIN)[1][0]
            boxes[align, valign] = placed
            assert inside(placed.ink, placed.box)
    left, top, right, bottom = boxes["left", "top"].box
    assert boxes["left", "top"].ink[0] - left <= 6  # nur der Vorbreite des „H" wegen nicht null
    assert right - boxes["right", "top"].ink[2] <= 6  # die Nachbreite des „g"
    center = boxes["center", "top"].ink
    assert abs((center[0] - left) - (right - center[2])) <= 2
    # Oben, Mitte, unten: von oben nach unten, die Mitte in der Mitte.
    tops = [boxes["left", valign].ink[1] for valign in ("top", "middle", "bottom")]
    assert tops == sorted(tops) and len(set(tops)) == 3
    middle = boxes["left", "middle"].ink
    assert abs((middle[1] - top) - (bottom - middle[3])) <= (bottom - top) // 6
    assert bottom - boxes["left", "bottom"].ink[3] <= (bottom - top) // 6


def test_control_characters_and_line_breaks_become_plain_spaces():
    placed = render_with_report(text_template(), {"t": "  Zeile\teins\r\nzwei\x00​  "}, fonts=BUILTIN)[1][0]
    assert placed.lines == ("Zeile eins zwei",)


# --- Schriften ---------------------------------------------------------------------------


def test_builtin_font_spells_out_umlauts_instead_of_drawing_boxes():
    """Die in Pillow eingebaute Schrift kennt weder Umlaute noch „ß": Der Rückfall schreibt sie aus."""
    template = text_template(w=50, size=3.0)
    placed = render_with_report(template, {"t": "Grüße aus Österreich: Käse süß"}, fonts=BUILTIN)[1][0]
    assert placed.lines == ("Gruesse aus Oesterreich: Kaese suess",)
    placed = render_with_report(template, {"t": "Crème fraîche – 250 g ℮ · 2 €"}, fonts=BUILTIN)[1][0]
    assert placed.lines == ("Creme fraiche - 250 g e · 2 EUR",)
    placed = render_with_report(template, {"t": "½ m² „Öl“ Señor"}, fonts=BUILTIN)[1][0]
    assert placed.lines == ('1/2 m2 "Oel“ Senor',)
    # Dasselbe Bild, als hätte jemand den Ersatz von Hand geschrieben.
    spelled = render(template, {"t": "Gruesse aus Oesterreich: Kaese suess"}, fonts=BUILTIN)
    assert (
        render(template, {"t": "Grüße aus Österreich: Käse süß"}, fonts=BUILTIN).tobytes()
        == spelled.tobytes()
    )


# Die mitgelieferten Schriften: DejaVu 2.37, unverändert aus ``dejavu-fonts-ttf-2.37.tar.bz2`` von
# der Seite des Projekts (docs/etiketten.md, 3.4).
SHIPPED_FONTS = {
    "DejaVuSans.ttf": "7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954",
    "DejaVuSans-Bold.ttf": "e6476c1b80502924294eed40894c5b18e06c181444ca953e5334262df9c27724",
    "DejaVuSansMono-Bold.ttf": "bce60f1b4421acd9ea51ba6623d7024ecbe6817a953e3654df62a5e6bdf8f769",
}


def test_package_ships_the_dejavu_fonts_unchanged_and_with_their_licence():
    assert set(SHIPPED_FONTS) == set(FONT_FILES.values())
    for filename, digest in SHIPPED_FONTS.items():
        assert hashlib.sha256((PACKAGE_FONT_DIR / filename).read_bytes()).hexdigest() == digest, filename
    # Die Lizenz verlangt, dass ihr Text jede Kopie der Schriften begleitet.
    licence = (PACKAGE_FONT_DIR / "DejaVu-LICENSE.txt").read_text(encoding="utf-8")
    assert "Bitstream Vera Fonts Copyright" in licence
    assert "DejaVu changes are in public domain" in licence
    # Die Schriftquelle des Betriebs nimmt sie von dort, vor den Schriften des Systems.
    assert Fonts().describe() == {
        name: str(PACKAGE_FONT_DIR / filename) for name, filename in FONT_FILES.items()
    }


def test_shipped_dejavu_draws_real_umlauts_and_keeps_id_and_date_complete():
    fonts = Fonts(directories=[PACKAGE_FONT_DIR])
    assert "eingebaut" not in fonts.describe().values()
    for kind, data in (
        ("package", {**PACKAGE, "title": "Grüße aus Österreich", "subtitle": "Käse · süß"}),
        ("package", PACKAGE_LONG),
        ("zone", ZONE),
    ):
        image, report = render_with_report(load_builtin(kind), data, fonts=fonts)
        assert image.size == (696, 342)
        for placed in texts(report):
            if placed.drawn:
                assert inside(placed.ink, placed.box)
    title = texts(render_with_report(load_builtin("package"), {**PACKAGE, "title": "Grüße"}, fonts=fonts)[1])[
        0
    ]
    assert title.lines == ("Grüße",)
    # Die Festbreitenschrift ist wirklich eine: Jede ID ist gleich breit und passt in voller Größe.
    ids = [
        texts(render_with_report(load_builtin("package"), {**PACKAGE, "id": value}, fonts=fonts)[1])[3]
        for value in ("11111", "WWWWW", "A2B3C")
    ]
    assert {placed.size_mm for placed in ids} == {6.0}
    assert not any(placed.truncated for placed in ids)
    # Das Einlagerdatum steht in der Größe der Vorlage vollständig da, gleich welche Ziffern es hat.
    dates = ("13.11.2026", "28.08.2088", "11.11.2111")
    stored = [
        texts(render_with_report(load_builtin("package"), {**PACKAGE, "stored": value}, fonts=fonts)[1])[4]
        for value in dates
    ]
    assert [placed.lines for placed in stored] == [(value,) for value in dates]
    assert {placed.size_mm for placed in stored} == {2.4}
    assert not any(placed.truncated for placed in stored)


def test_missing_font_files_fall_back_to_the_builtin_font_and_say_so_once(tmp_path, caplog):
    fonts = Fonts(directories=[tmp_path / "leer", tmp_path / "auch-leer"])
    with caplog.at_level(logging.WARNING, logger="stowly_print.render"):
        first = render(load_builtin("package"), PACKAGE, fonts=fonts)
        second = render(load_builtin("package"), PACKAGE, fonts=fonts)
        render(load_builtin("zone"), ZONE, fonts=fonts)
    assert fonts.describe() == {"regular": "eingebaut", "bold": "eingebaut", "mono": "eingebaut"}
    warnings = [record.getMessage() for record in caplog.records if "fehlt" in record.getMessage()]
    # Je Datei genau eine Meldung, auch nach mehreren Etiketten.
    assert len(warnings) == 3
    assert {name for name in FONT_FILES.values() if any(name in warning for warning in warnings)} == set(
        FONT_FILES.values()
    )
    assert (
        first.tobytes()
        == second.tobytes()
        == render(load_builtin("package"), PACKAGE, fonts=BUILTIN).tobytes()
    )


def test_unreadable_font_file_falls_back_too(tmp_path, caplog, monkeypatch):
    # Pillow sucht nach einer unlesbaren Datei unter Linux in XDG_DATA_HOME/XDG_DATA_DIRS, unter
    # Windows in WINDIR/fonts nach einer gleichnamigen Schrift. Liegt dort DejaVu (etwa auf einem
    # Ubuntu-Runner), nähme sie Pillow stillschweigend. Für den Test sind diese Orte leer.
    empty = tmp_path / "leer"
    empty.mkdir()
    for variable in ("XDG_DATA_HOME", "XDG_DATA_DIRS", "WINDIR"):
        monkeypatch.setenv(variable, str(empty))
    for filename in FONT_FILES.values():
        (tmp_path / filename).write_bytes(b"keine Schrift")
    fonts = Fonts(directories=[tmp_path])
    with caplog.at_level(logging.WARNING, logger="stowly_print.render"):
        image = render(load_builtin("package"), PACKAGE, fonts=fonts)
    assert any("nicht lesbar" in record.getMessage() for record in caplog.records)
    assert image.tobytes() == render(load_builtin("package"), PACKAGE, fonts=BUILTIN).tobytes()


def test_font_files_are_searched_in_the_given_order(tmp_path):
    first, second = tmp_path / "paket", tmp_path / "system"
    first.mkdir()
    second.mkdir()
    (second / FONT_FILES["regular"]).write_bytes(b"x")
    (second / FONT_FILES["bold"]).write_bytes(b"x")
    (first / FONT_FILES["bold"]).write_bytes(b"x")
    fonts = Fonts(directories=[first, second])
    assert fonts.path("regular") == second / FONT_FILES["regular"]
    assert fonts.path("bold") == first / FONT_FILES["bold"]
    assert fonts.path("mono") is None
    # Die Vorgabe sucht erst im Paket, dann unter den Schriften des Systems.
    assert [str(path).replace("\\", "/") for path in Fonts().directories][
        1
    ] == "/usr/share/fonts/truetype/dejavu"
    assert Fonts().directories[0].name == "fonts"
    assert Fonts().directories[0].parent.name == "stowly_print"


def test_builtin_font_keeps_a_package_id_complete_by_shrinking_below_the_template_size():
    """Die eingebaute Schrift ist keine Festbreitenschrift: Breite IDs passen nicht in voller Größe."""
    template = load_builtin("package")
    for value in ("WWWWW", "QW7E8", "MMMMM", "A2B3C", "11111"):
        placed = texts(render_with_report(template, {**PACKAGE, "id": value}, fonts=BUILTIN)[1])[3]
        assert placed.lines == (value,)
        assert not placed.truncated
        assert 3.6 <= placed.size_mm <= 6.0
        assert inside(placed.ink, placed.box)
    assert texts(render_with_report(template, {**PACKAGE, "id": "11111"}, fonts=BUILTIN)[1])[3].size_mm == 6.0


# --- Andere Drucker ----------------------------------------------------------------------


def test_another_resolution_scales_the_same_template():
    # 203 dpi, 59 mm druckbar: 472 Pixel breit, 29 mm sind 231 Pixel.
    target = Target(dpi=203, width_px=472)
    image, report = render_with_report(load_builtin("package"), PACKAGE, target, fonts=BUILTIN)
    assert image.size == (472, 231)
    assert image.mode == "1"
    qr = report[0]
    assert qr.module_px == 6
    assert read_modules(image, qr, 21) == qr_matrix(PACKAGE["qr"], "Q")
    for placed in texts(report):
        assert placed.drawn
        assert inside(placed.ink, placed.box)
    # Dieselbe Aufteilung wie bei 300 dpi, nur kleiner.
    large = render_with_report(load_builtin("package"), PACKAGE, fonts=BUILTIN)[1]
    for small_box, large_box in zip(
        (p.box for p in texts(report)), (p.box for p in texts(large)), strict=True
    ):
        for small_edge, large_edge in zip(small_box, large_box, strict=True):
            assert abs(small_edge - large_edge * 231 / 342) <= 2

    # Doppelte Auflösung: alles doppelt so groß.
    fine = render_with_report(load_builtin("zone"), ZONE, Target(dpi=600, width_px=1392), fonts=BUILTIN)
    assert fine[0].size == (1392, 685)
    assert fine[1][0].module_px in (16, 17)


def test_design_is_centred_on_a_wider_or_longer_printable_area():
    template = {
        "schema": 1,
        "media": {"width_mm": 62, "length_mm": 29},
        "design": {"width_mm": 20, "height_mm": 10},
        "elements": [{"type": "rect", "x": 0, "y": 0, "w": 20, "h": 10, "fill": True}],
    }
    # Fläche 400 × 100: Die Höhe begrenzt (10 Pixel je mm), die 200 Pixel breite Zeichnung sitzt mittig.
    image = render(template, {}, Target(dpi=300, width_px=400, length_px=100), fonts=BUILTIN)
    assert image.size == (400, 100)
    assert ink_box(image) == (100, 0, 300, 100)
    # Fläche 200 × 300: Die Breite begrenzt, die Zeichnung sitzt in der Mitte der Länge.
    image = render(template, {}, Target(dpi=300, width_px=200, length_px=300), fonts=BUILTIN)
    assert ink_box(image) == (0, 100, 200, 200)


def test_target_follows_the_capabilities_of_a_printer():
    endless = Capabilities(300, Media(62, None, 696), True, ["black"], True, True)
    assert Target.of(endless) == Target(300, 696, None)
    assert Target.of(None) == Target(300, 696, None)
    die_cut = Capabilities(300, Media(62, 29, 696), True, ["black"], True, True)
    assert Target.of(die_cut) == Target(300, 696, 342)
    image = render(load_builtin("package"), PACKAGE, endless, fonts=BUILTIN)
    assert image.size == (696, 342)
    # Festes Material: Die Länge kommt vom Drucker, nicht aus der Vorlage.
    fixed = Capabilities(300, Media(62, 100, 696), True, ["black"], True, True)
    assert render(load_builtin("package"), PACKAGE, fixed, fonts=BUILTIN).size == (696, 1181)


# --- Linie und Rechteck ------------------------------------------------------------------


def shapes(*elements: dict) -> dict:
    return {
        "schema": 1,
        "media": {"width_mm": 62, "length_mm": 29},
        "design": {"width_mm": 58.9, "height_mm": 29.0},
        "elements": list(elements),
    }


def test_lines_are_at_least_one_pixel_wide():
    hair = render(
        shapes({"type": "line", "x1": 10, "y1": 10, "x2": 30, "y2": 10, "width": 0.001}), {}, fonts=BUILTIN
    )
    left, top, right, bottom = ink_box(hair)
    assert bottom - top == 1
    assert 234 <= right - left <= 237  # 20 mm
    thick = render(
        shapes({"type": "line", "x1": 10, "y1": 10, "x2": 30, "y2": 10, "width": 1.0}), {}, fonts=BUILTIN
    )
    left, top, right, bottom = ink_box(thick)
    assert bottom - top == 12
    assert black(thick) == (right - left) * 12
    vertical = render(
        shapes({"type": "line", "x1": 10, "y1": 5, "x2": 10, "y2": 25, "width": 0.25}), {}, fonts=BUILTIN
    )
    left, top, right, bottom = ink_box(vertical)
    assert right - left == 3
    assert 234 <= bottom - top <= 237
    diagonal = render(
        shapes({"type": "line", "x1": 5, "y1": 5, "x2": 25, "y2": 20, "width": 0.25}), {}, fonts=BUILTIN
    )
    assert black(diagonal) > 200
    # Die Trennlinie der Packungs-Vorlage: 0,25 mm sind drei Pixel.
    _image, report = render_with_report(load_builtin("package"), PACKAGE, fonts=BUILTIN)
    line = next(placed for placed in report if placed.type == "line")
    assert line.box[3] - line.box[1] == 3


def test_rectangles_filled_and_as_a_frame():
    filled = render(
        shapes({"type": "rect", "x": 10, "y": 5, "w": 20, "h": 10, "fill": True}), {}, fonts=BUILTIN
    )
    left, top, right, bottom = ink_box(filled)
    assert black(filled) == (right - left) * (bottom - top)
    frame = render(shapes({"type": "rect", "x": 10, "y": 5, "w": 20, "h": 10}), {}, fonts=BUILTIN)
    assert ink_box(frame) == (left, top, right, bottom)
    stroke = 3  # Vorgabe 0,25 mm
    assert black(frame) == (right - left) * (bottom - top) - (right - left - 2 * stroke) * (
        bottom - top - 2 * stroke
    )
    with pytest.raises(RenderError):
        render(shapes({"type": "rect", "x": 10, "y": 5, "w": 20, "h": 10, "fill": "ja"}), {}, fonts=BUILTIN)


def test_text_does_not_erase_what_other_elements_drew_in_its_box():
    template = shapes(
        {"type": "rect", "x": 5, "y": 5, "w": 30, "h": 10},
        {
            "type": "text",
            "x": 5,
            "y": 5,
            "w": 30,
            "h": 10,
            "value": "Text",
            "font": "regular",
            "size": 4,
            "valign": "middle",
        },
    )
    frame_only = black(render(shapes(template["elements"][0]), {}, fonts=BUILTIN))
    assert black(render(template, {}, fonts=BUILTIN)) > frame_only


# --- Notausgang: fertiges PNG ------------------------------------------------------------


def encoded(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def test_ready_made_png_must_fit_the_printer_exactly():
    image = render(load_builtin("package"), PACKAGE, fonts=BUILTIN)
    decoded = decode_png(encoded(image))
    assert decoded.mode == "1"
    assert decoded.tobytes() == image.tobytes()
    # Auf einer Endlosrolle ist die Länge frei, die Breite nicht.
    assert decode_png(encoded(Image.new("1", (696, 100), 1))).size == (696, 100)
    with pytest.raises(RenderError, match="696"):
        decode_png(encoded(Image.new("1", (600, 342), 1)))
    with pytest.raises(RenderError, match="lang"):
        decode_png(encoded(Image.new("1", (696, 100), 1)), Target(300, 696, 342))
    with pytest.raises(RenderError, match="1-Bit"):
        decode_png(encoded(Image.new("L", (696, 342), 255)))
    with pytest.raises(RenderError, match="1-Bit"):
        decode_png(encoded(Image.new("RGB", (696, 342), "white")))
    with pytest.raises(RenderError, match="Länge"):
        decode_png(encoded(Image.new("1", (696, 7000), 1)))


def test_broken_png_is_rejected():
    with pytest.raises(RenderError, match="Base64"):
        decode_png("das ist kein base64!")
    with pytest.raises(RenderError, match="PNG"):
        decode_png(base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"kaputt" * 10).decode("ascii"))
    with pytest.raises(RenderError, match="PNG"):
        decode_png(base64.b64encode(b"GIF89a" + b"\x00" * 40).decode("ascii"))
    jpeg = io.BytesIO()
    Image.new("L", (696, 342), 255).save(jpeg, format="JPEG")
    with pytest.raises(RenderError, match="PNG"):
        decode_png(base64.b64encode(jpeg.getvalue()).decode("ascii"))


def test_reference_images_are_small_one_bit_files():
    files = sorted(Path(REFERENCE_DIR).glob("*.png"))
    assert [path.name for path in files] == ["package-62x29-lang.png", "package-62x29.png", "zone-62x29.png"]
    for path in files:
        assert path.stat().st_size < 10_000
        with Image.open(path) as image:
            assert image.mode == "1"
