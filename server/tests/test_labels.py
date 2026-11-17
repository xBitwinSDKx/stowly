"""Der Generator der Vorlagen: aus Papier und Gestaltung eine Vorlage (``stowly.labels``; docs/plan-0.5.md,
1; docs/etiketten.md, 3.1 bis 3.4).

Gerendert wird mit dem Renderer des Druckdienstes (``render_with_report`` ohne Drucker: Format 2 in der
Fläche des Papiers der Vorlage, so wie man es liest). Die Vergleiche mit den mitgelieferten Vorlagen
laufen mit beiden Schriftquellen: den DejaVu-Dateien des Pakets (so rendert der Server) und der in Pillow
eingebauten Schrift (so entstehen die Referenzbilder des Druckdienstes, ``print/tests/reference``).
"""

import base64
import io

import pytest
from PIL import Image, ImageChops

from stowly import labels
from stowly.contract.api import (
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
from stowly_print import media as catalog
from stowly_print.render import Fonts, render_with_report
from stowly_print.templates import load_builtin, template_hash

PACKAGE, ZONE = LabelKind.PACKAGE, LabelKind.ZONE
FONTS = {"dejavu": Fonts(), "eingebaut": Fonts.builtin()}

DATA = {
    PACKAGE: [
        labels.SAMPLE_DATA[PACKAGE],
        labels.LIMIT_DATA[PACKAGE],
        {
            "qr": "STOWLY/P/9ZX4K",
            "id": "9ZX4K",
            "title": "Äpfel gjpqy",
            "subtitle": "Ägypten · gjpqy",
            "best_before": "01.12.2027",
            "stored": "13.11.2026",
        },
        {
            "qr": "STOWLY/P/A2B3C",
            "id": "A2B3C",
            "title": "Reis",
            "subtitle": "",
            "best_before": "",
            "stored": "",
        },
    ],
    ZONE: [
        labels.SAMPLE_DATA[ZONE],
        labels.LIMIT_DATA[ZONE],
        {"qr": "STOWLY/Z/3F2B8C1E5A474D099B6E0C1D2E3F4A5B", "title": "Keller", "subtitle": "Lagerzone"},
        {"qr": "STOWLY/Z/3F2B8C1E5A474D099B6E0C1D2E3F4A5B", "title": "Gefrierschrank", "subtitle": ""},
    ],
}


def layout(kind: LabelKind = PACKAGE, **changes) -> LabelLayout:
    """Die Vorgabe einer Etikettenart, mit Änderungen."""
    base = labels.DEFAULT_LAYOUTS[kind].model_dump()
    base.update(changes)
    return LabelLayout.model_validate(base)


def fields(*entries: tuple) -> list[dict]:
    """Felder als ``(name, größe)`` oder ``(name, größe, zeilen)``."""
    return [
        {"field": entry[0], "size": entry[1], "lines": entry[2] if len(entry) > 2 else None}
        for entry in entries
    ]


def failure(kind: LabelKind, paper: str, layout: LabelLayout) -> labels.LabelDesignError:
    with pytest.raises(labels.LabelDesignError) as caught:
        labels.check(kind, paper, layout)
    return caught.value


def texts_of(template: dict) -> list[dict]:
    return [element for element in template["elements"] if element["type"] == "text"]


# --- Die Vorgabe sieht aus wie heute ---------------------------------------------------------------


def test_the_default_design_describes_the_bundled_templates():
    design = labels.DEFAULT_DESIGN
    assert design.paper == catalog.DEFAULT_PAPER_ID == "62"
    for kind in LabelKind:
        bundled = load_builtin(kind.value)
        generated = labels.build_template(kind, "62", getattr(design, kind.value))
        assert generated["schema"] == 1 and "rotate" not in generated
        assert generated["media"] == {"id": "62", "kind": "endless", "width_mm": 62, "length_mm": 29}
        assert generated["design"] == bundled["design"] == {"width_mm": 58.9, "height_mm": 29.0}
        # Dieselben Elemente in derselben Reihenfolge; Abweichungen nur, wo der Generator eine Regel hat:
        # Packung: Die Zeile „Größe · Marke" ist 3,5 statt 3,4 mm hoch (1,24 × Schriftgröße, oben bündig:
        # kein Pixel anders). Zone: Der Name steht 0,15 mm höher (2,85 statt 3,0), weil der Generator den
        # übrigen Platz gleich über und unter die Zeilen verteilt.
        expected = [dict(element) for element in bundled["elements"]]
        if kind == PACKAGE:
            expected[2]["h"] = 3.5
        else:
            expected[1]["y"] = 2.85
        assert generated["elements"] == expected


@pytest.mark.parametrize("font", sorted(FONTS))
@pytest.mark.parametrize("kind", list(LabelKind))
def test_the_default_renders_like_the_bundled_template(kind, font):
    """Referenzbild: das Rendern der mitgelieferten Vorlage. Packung bitgleich; Zone bis auf den Namen, der
    höchstens 2 Pixel höher steht, bei gleicher Größe, gleichen Zeilen und gleichem Kürzen."""
    generated = labels.build_template(kind, "62", labels.DEFAULT_LAYOUTS[kind])
    bundled = load_builtin(kind.value)
    for data in DATA[kind]:
        mine, mine_report = render_with_report(generated, data, fonts=FONTS[font])
        theirs, their_report = render_with_report(bundled, data, fonts=FONTS[font])
        assert mine.size == theirs.size == (696, 342)
        difference = ImageChops.logical_xor(mine, theirs)
        if kind == PACKAGE:
            assert difference.getbbox() is None, data["title"]
            continue
        title, reference = mine_report[1], their_report[1]
        outside = difference.copy()
        outside.paste(0, (title.box[0], min(title.box[1], reference.box[1]), title.box[2], reference.box[3]))
        assert outside.getbbox() is None, data["title"]
        assert (title.size_mm, title.lines, title.truncated) == (
            reference.size_mm,
            reference.lines,
            reference.truncated,
        )
        if title.ink is not None:
            assert (title.ink[0], title.ink[2]) == (reference.ink[0], reference.ink[2])
            assert 0 <= reference.ink[1] - title.ink[1] <= 2
            assert reference.ink[3] - reference.ink[1] == title.ink[3] - title.ink[1]


def test_for_the_default_the_bundled_template_itself_holds():
    """Wer die Vorgabe speichert, ändert nichts: gleiche Vorlage, gleicher ``hash``."""
    for kind in LabelKind:
        bundled = load_builtin(kind.value)
        assert labels.is_default(kind, "62", labels.DEFAULT_LAYOUTS[kind])
        assert labels.template_for(kind, "62", labels.DEFAULT_LAYOUTS[kind]) == bundled
        assert labels.check(kind, "62", labels.DEFAULT_LAYOUTS[kind]) == bundled
        # Schon eine andere Länge oder ein anderes Papier erzeugt die Vorlage.
        longer = layout(kind, length_mm=30)
        assert not labels.is_default(kind, "62", longer)
        assert template_hash(labels.template_for(kind, "62", longer)) != template_hash(bundled)


# --- Jedes Papier --------------------------------------------------------------------------------


def area_size(paper: catalog.PaperSpec, length_mm: int | None) -> tuple[int, int]:
    """Die Fläche in Leserichtung nach docs/etiketten.md, 3.4."""
    across = paper.printable_width_px
    along = paper.printable_length_px if paper.kind == catalog.DIE_CUT else catalog.mm_to_px(length_mm)
    length = paper.length_mm if paper.kind == catalog.DIE_CUT else length_mm
    return (along, across) if catalog.rotated(paper, length) else (across, along)


# Die schmalsten Papiere tragen einen Zonen-Code (Version 3) nicht mit 6 Pixeln je Modul.
NO_ZONE_QR = {"17x54", "17x87", "23x23"}


@pytest.mark.parametrize("paper", catalog.PAPERS, ids=lambda paper: paper.id)
@pytest.mark.parametrize("kind", list(LabelKind))
def test_every_paper_renders(paper, kind):
    lengths = [25, 29, 62, 63, 100] if paper.kind == catalog.ENDLESS else [None]
    for length in lengths:
        bare = layout(kind, length_mm=length, qr={"side": "left", "size": "s"}, fields=[], divider=False)
        if kind == ZONE and paper.id in NO_ZONE_QR:
            error = failure(kind, paper.id, bare)
            assert (error.message, error.loc) == (labels.NO_QR_FITS, ("paper",))
            continue
        template = labels.check(kind, paper.id, bare)
        rotated = catalog.rotated(paper, paper.length_mm if length is None else length)
        assert template["schema"] == (1 if paper.id == "62" and not rotated else 2)
        assert template["media"]["id"] == paper.id and template["media"]["kind"] == paper.kind
        if template["schema"] == 2:
            assert template["rotate"] == (90 if rotated else 0)
        image, report = render_with_report(template, labels.SAMPLE_DATA[kind])
        assert image.size == area_size(paper, length)
        assert image.mode == "1"
        # Die kleinste Stufe scannt noch sicher: mindestens 6 Pixel je Modul.
        assert report[0].type == "qr" and report[0].module_px >= 6


@pytest.mark.parametrize(
    ("paper", "length"),
    [
        ("62", 29),
        ("62", 45),
        ("62", 100),
        ("29", 62),
        ("38", 50),
        ("50", 40),
        ("62x29", None),
        ("29x90", None),
    ]
    + [("39x90", None), ("62x100", None), ("54x29", None), ("60x86", None)],
)
def test_a_typical_package_fits_on_many_papers(paper, length):
    """Name in zwei Zeilen, MHD kurz, ID und Einlagerdatum in einer Zeile, kleiner QR-Code."""
    typical = layout(
        length_mm=length,
        qr={"side": "left", "size": "s"},
        fields=fields(("title", "m", 2), ("best_before", "s"), ("id", "s"), ("stored", "s")),
        date="short",
    )
    preview = labels.preview(PACKAGE, paper, typical, None)
    with Image.open(io.BytesIO(preview.png)) as image:
        assert image.size == (preview.width_px, preview.height_px)
        assert image.mode == "1"


def test_module_sizes_of_the_three_steps():
    """Feste Millimeter, auf 62 mm endlos bei 40 mm Länge: Packung 6, 9, 11 Pixel je Modul, Zone 6, 7, 8."""
    expected = {PACKAGE: [6, 9, 11], ZONE: [6, 7, 8]}
    for kind in LabelKind:
        modules = []
        for size in LabelSize:
            template = labels.build_template(
                kind, "62", layout(kind, length_mm=40, qr={"side": "left", "size": size.value})
            )
            _image, report = render_with_report(template, labels.SAMPLE_DATA[kind])
            modules.append(report[0].module_px)
        assert modules == expected[kind]


def test_sizes_are_the_same_millimetres_on_every_paper():
    """Dieselbe Gestaltung auf zwei Papieren: gleich große Elemente, nur anders angeordnet."""
    wide = labels.build_template(PACKAGE, "62", layout(length_mm=45, qr={"side": "left", "size": "s"}))
    narrow = labels.build_template(PACKAGE, "29x90", layout(length_mm=None, qr={"side": "left", "size": "s"}))
    for one, other in zip(wide["elements"], narrow["elements"], strict=True):
        assert one["type"] == other["type"]
        for key in ("size", "min_size", "max_lines", "font", "value", "when", "quiet"):
            assert one.get(key) == other.get(key), key
        if one.get("value") == "{id}":
            assert (
                one["w"] == other["w"] == 18.4
            )  # fünf Zeichen der Festbreitenschrift; die Spalte ist breiter
    scales = []
    for template in (wide, narrow):
        image, _ = render_with_report(template, labels.SAMPLE_DATA[PACKAGE])
        scales.append(
            min(image.width / template["design"]["width_mm"], image.height / template["design"]["height_mm"])
        )
    assert all(abs(scale - catalog.DPI / catalog.MM_PER_INCH) < 0.05 for scale in scales)


# --- Was die Gestaltung festlegt -----------------------------------------------------------------


def test_fields_dates_text_and_divider():
    custom = layout(
        length_mm=40,
        qr={"side": "right", "size": "m"},
        fields=fields(
            ("text", "l"),
            ("title", "l", 3),
            ("brand", "s"),
            ("quantity", "s"),
            ("stored", "m"),
            ("id", "l"),
            ("zone", "s"),
            ("best_before", "s"),
        ),
        date="short",
        text="Bio {fein} }{",
        divider=False,
    )
    template = labels.build_template(PACKAGE, "62", custom)
    elements = template["elements"]
    qr, *rest = elements
    assert qr["x"] == pytest.approx(58.9 - 0.5 - 24.0) and qr["size"] == 24.0
    assert all(element["type"] == "text" for element in rest)  # keine Trennlinie
    values = [element["value"] for element in rest]
    assert values == [
        "Bio {{fein}} }}{{",  # fester Text, Klammern verdoppelt
        "{title}",
        "{brand}",
        "{quantity}",
        "{stored_short}",
        "{id}",
        "{zone}",
        "MHD {best_before_short}",
    ]
    by_value = {element["value"]: element for element in rest}
    assert by_value["{title}"]["max_lines"] == 3 and by_value["{title}"]["size"] == 5.2
    assert by_value["{stored_short}"]["when"] == "stored_short"
    assert by_value["MHD {best_before_short}"]["when"] == "best_before_short"
    # Einlagerdatum vor der ID: Sie teilen sich eine Zeile, das Datum links, die ID rechtsbündig.
    stored, ident = by_value["{stored_short}"], by_value["{id}"]
    assert stored["y"] == ident["y"] and stored["h"] == ident["h"]
    assert stored.get("align", "left") == "left" and ident["align"] == "right"
    assert stored["x"] + stored["w"] == pytest.approx(ident["x"])
    # Die Felder stehen links vom QR-Code, mit 1,5 mm Abstand.
    assert all(element["x"] == 0.5 for element in rest if element.get("align") != "right")
    assert ident["x"] + ident["w"] == pytest.approx(qr["x"] - 1.5)
    # Der feste Text erscheint so, wie er getippt wurde.
    _image, report = render_with_report(template, labels.SAMPLE_DATA[PACKAGE])
    assert report[1].lines == ("Bio {fein} }{",)


def test_id_and_stored_share_a_line_only_when_they_follow_each_other():
    apart = labels.build_template(
        PACKAGE, "62", layout(length_mm=40, fields=fields(("id", "m"), ("title", "m"), ("stored", "s")))
    )
    ident, title, stored = texts_of(apart)
    assert ident["y"] < title["y"] < stored["y"] and ident["w"] == stored["w"] == title["w"]
    # Ein leerer eigener Text dazwischen zählt nicht: Er wird nicht gedruckt.
    between = labels.build_template(
        PACKAGE, "62", layout(fields=fields(("title", "m", 2), ("id", "m"), ("text", "s"), ("stored", "s")))
    )
    assert [element["value"] for element in texts_of(between)] == ["{title}", "{id}", "{stored}"]
    assert texts_of(between)[1]["y"] == texts_of(between)[2]["y"]


def test_the_divider_is_above_the_last_line():
    template = labels.build_template(
        ZONE,
        "62",
        layout(ZONE, length_mm=40, fields=fields(("title", "m", 2), ("text", "s")), text="Regal 3"),
    )
    title, text = texts_of(template)
    (line,) = [element for element in template["elements"] if element["type"] == "line"]
    assert title["y"] + title["h"] + 0.6 <= line["y1"] + 1e-9
    assert line["y1"] + 0.6 == pytest.approx(text["y"])
    assert text["y"] + text["h"] == pytest.approx(template["design"]["height_mm"] - 0.8)
    # Eine einzelne Zeile hat keine Trennlinie über sich; sie steht in der Mitte.
    single = labels.build_template(ZONE, "62", layout(ZONE, length_mm=40, fields=fields(("title", "m", 2))))
    assert [element["type"] for element in single["elements"]] == ["qr", "text"]
    (title,) = texts_of(single)
    assert title["y"] - 1.5 == pytest.approx(40.0 - 0.8 - (title["y"] + title["h"]))


def test_format_1_only_for_62_mm_endless_without_rotation():
    cases = [
        ("62", 25, 1, None, (696, 295)),
        ("62", 62, 1, None, (696, 732)),
        ("62", 63, 2, 90, (744, 696)),
        ("29", 29, 2, 0, (306, 342)),
        ("29", 30, 2, 90, (354, 306)),
        ("62x29", None, 2, 0, (696, 271)),
        ("29x90", None, 2, 90, (991, 306)),
        ("62x100", None, 2, 90, (1109, 696)),
    ]
    for paper, length, schema, rotate, size in cases:
        bare = layout(ZONE, length_mm=length, qr={"side": "left", "size": "s"}, fields=[], divider=False)
        template = labels.build_template(ZONE, paper, bare)
        assert template["schema"] == schema, paper
        assert template.get("rotate") == rotate, paper
        spec = catalog.paper(paper)
        assert template["media"] == {
            "id": paper,
            "kind": spec.kind,
            "width_mm": int(spec.width_mm),
            "length_mm": length if length is not None else int(spec.length_mm),
        }
        image, _ = render_with_report(template, labels.SAMPLE_DATA[ZONE])
        assert image.size == size, paper


def test_format_1_uses_only_what_the_print_service_0_4_0_knows():
    """Mit der 62-mm-Rolle bis 62 mm Länge druckt auch der Druckdienst 0.4.0 die erzeugten Vorlagen: dieselben
    Elemente und Schlüssel wie die mitgelieferten, ``media.id`` und ``kind`` übergeht er."""
    known = {
        "qr": {"type", "x", "y", "size", "value", "ec", "quiet", "min_module_px"},
        "text": {
            "type",
            "x",
            "y",
            "w",
            "h",
            "value",
            "font",
            "size",
            "min_size",
            "max_lines",
            "align",
            "valign",
            "when",
        },
        "line": {"type", "x1", "y1", "x2", "y2", "width"},
    }
    every_field = fields(
        ("title", "l", 3),
        ("subtitle", "s"),
        ("quantity", "s"),
        ("brand", "s"),
        ("zone", "s"),
        ("text", "s"),
        ("best_before", "s"),
        ("id", "s"),
        ("stored", "s"),
    )
    for length in (45, 62):  # alle neun Felder brauchen Platz
        for side in ("left", "right"):
            template = labels.check(
                PACKAGE,
                "62",
                layout(length_mm=length, qr={"side": side, "size": "s"}, fields=every_field, text="Bio"),
            )
            assert set(template) == {"schema", "name", "media", "design", "elements"}
            assert template["schema"] == 1 and set(template["media"]) == {
                "id",
                "kind",
                "width_mm",
                "length_mm",
            }
            for element in template["elements"]:
                assert set(element) <= known[element["type"]], element


def test_the_generator_is_deterministic():
    design = LabelDesign.model_validate(
        {
            "paper": "29x90",
            "package": layout(length_mm=None, qr={"side": "right", "size": "s"}, date="short").model_dump(),
            "zone": layout(ZONE, length_mm=None, qr={"side": "left", "size": "s"}).model_dump(),
        }
    )
    again = LabelDesign.model_validate_json(design.model_dump_json())
    for kind in LabelKind:
        first = labels.build_template(kind, design.paper, getattr(design, kind.value))
        second = labels.build_template(kind, again.paper, getattr(again, kind.value))
        assert first == second
        assert template_hash(first) == template_hash(second)
    assert labels.check_design(design) == labels.check_design(again)


# --- Grenzfälle: ein Satz statt einer Vorlage ------------------------------------------------------


def test_what_the_design_cannot_say():
    cases = [
        (PACKAGE, "99", layout(), labels.UNKNOWN_PAPER, ("paper",)),
        (PACKAGE, "62x29", layout(length_mm=29), labels.LENGTH_FIXED, ("length_mm",)),
        (PACKAGE, "62", layout(length_mm=None), labels.LENGTH_MISSING, ("length_mm",)),
        (
            ZONE,
            "62",
            layout(ZONE, fields=fields(("title", "l", 2), ("id", "m"))),
            "Auf Zonen-Etiketten gibt es nur „Name“, „Lagerzone“, „Eigener Text“.",
            ("fields", 1, "field"),
        ),
        (
            PACKAGE,
            "62",
            layout(fields=fields(("title", "m", 2), ("brand", "s"), ("title", "s"))),
            "Das Feld „Name“ steht doppelt in der Liste.",
            ("fields", 2, "field"),
        ),
        (
            PACKAGE,
            "62",
            layout(fields=fields(("title", "m", 2), ("brand", "s", 2))),
            labels.LINES_ONLY_TITLE,
            ("fields", 1, "lines"),
        ),
    ]
    for kind, paper, design, message, loc in cases:
        error = failure(kind, paper, design)
        assert (error.message, error.loc) == (message, loc)


def test_too_many_fields_for_the_height():
    crowded = layout(
        length_mm=25,
        fields=fields(
            ("title", "l", 3),
            ("subtitle", "l"),
            ("brand", "l"),
            ("quantity", "l"),
            ("best_before", "l"),
            ("zone", "l"),
            ("id", "l"),
            ("stored", "l"),
        ),
        qr={"side": "left", "size": "s"},
    )
    error = failure(PACKAGE, "62", crowded)
    assert error.message == (
        "Für so viele Felder ist das Etikett zu kurz: ein Feld weglassen, kleiner wählen oder länger machen."
    )
    assert error.loc == ("fields",)
    # Auf gestanzten Etiketten hilft „länger" nicht.
    error = failure(PACKAGE, "62x29", crowded.model_copy(update={"length_mm": None}))
    assert (
        error.message
        == "Für so viele Felder ist das Etikett zu klein: ein Feld weglassen oder kleiner wählen."
    )
    # Mit weniger Feldern geht es: Die Zeilen werden niedriger, der Renderer verkleinert die Schrift.
    fewer = crowded.model_copy(update={"fields": crowded.fields[:3] + crowded.fields[6:]})
    preview = labels.preview(PACKAGE, "62", fewer, None)
    assert any(note.startswith("Name auf ") for note in preview.notes)


def test_the_qr_code_too_large_and_no_room_beside_it():
    error = failure(PACKAGE, "62", layout(length_mm=25, qr={"side": "left", "size": "l"}))
    assert (
        error.message
        == "Der QR-Code ist für dieses Etikett zu groß: kleiner wählen oder das Etikett länger machen."
    )
    assert error.loc == ("qr", "size")
    error = failure(PACKAGE, "62x29", layout(length_mm=None))
    assert (
        error.message
        == "Der QR-Code ist für dieses Etikett zu groß: kleiner wählen oder ein größeres Papier nehmen."
    )
    error = failure(ZONE, "29", layout(ZONE, length_mm=29, qr={"side": "left", "size": "m"}))
    assert error.message == (
        "Neben dem QR-Code bleibt zu wenig Platz für die Felder: QR-Code kleiner wählen, alle Felder ausschalten "
        "oder ein größeres Etikett nehmen."
    )
    # Ohne Felder genügt der QR-Code.
    assert labels.check(ZONE, "29", layout(ZONE, length_mm=29, qr={"side": "left", "size": "s"}, fields=[]))


def test_an_id_or_a_date_that_only_fits_cut_off_is_refused():
    error = failure(PACKAGE, "62", layout(qr={"side": "left", "size": "l"}))
    assert error.message == (
        "Das MHD passt nicht in seine Zeile: kleiner wählen, das kurze Datum nehmen oder den QR-Code verkleinern."
    )
    assert error.loc == ("fields", 2)
    narrow = layout(
        length_mm=40,
        qr={"side": "left", "size": "l"},
        fields=fields(("title", "m", 2), ("id", "l"), ("stored", "m")),
    )
    error = failure(PACKAGE, "62", narrow)
    assert error.message.startswith("Packungs-ID und Einlagerdatum passen nicht nebeneinander:")
    # Ein Name, der nur gekürzt passt, ist dagegen ein Hinweis, kein Fehler.
    assert "Name auf 3,0 mm verkleinert und gekürzt." in labels.preview(PACKAGE, "62", layout(), None).notes


# --- Hinweise der Vorschau -------------------------------------------------------------------------


def test_notes_say_what_only_fits_smaller_or_cut_off():
    preview = labels.preview(PACKAGE, "62", labels.DEFAULT_LAYOUTS[PACKAGE], None)
    assert preview.notes == ["Name auf 3,0 mm verkleinert und gekürzt.", "MHD auf 3,4 mm verkleinert."]
    assert (preview.width_px, preview.height_px) == (696, 342)
    short = {**labels.SAMPLE_DATA[PACKAGE], "title": "Reis", "best_before": ""}
    assert labels.preview(PACKAGE, "62", labels.DEFAULT_LAYOUTS[PACKAGE], short).notes == []
    zone = labels.preview(ZONE, "62", labels.DEFAULT_LAYOUTS[ZONE], None)
    assert zone.notes == ["Name auf 3,6 mm verkleinert und gekürzt."]


def test_the_preview_is_the_label_as_one_reads_it():
    """Gedreht wird erst für den Druck: Die Vorschau eines gedrehten Etiketts ist breiter als hoch."""
    preview = labels.preview(
        ZONE, "29x90", layout(ZONE, length_mm=None, qr={"side": "left", "size": "s"}), None
    )
    assert (preview.width_px, preview.height_px) == (991, 306)
    with Image.open(io.BytesIO(base64.b64decode(preview.png_base64()))) as image:
        assert (image.size, image.mode) == ((991, 306), "1")
    # Ohne QR-Inhalt in den Daten, oder mit einem fremden, steht der des Beispiels dort: Ein Etikett hat
    # immer einen, und ein fremder Inhalt sagte über die Gestaltung nichts. Kleinbuchstaben werden groß.
    data = {"title": "Keller", "subtitle": "Lagerzone"}
    sample = labels.preview(
        ZONE, "62", labels.DEFAULT_LAYOUTS[ZONE], {**data, "qr": labels.SAMPLE_DATA[ZONE]["qr"]}
    )
    for qr in (None, "", "https://example.org/gewinn", "STOWLY/P/A2B3C"):
        given = data if qr is None else {**data, "qr": qr}
        assert labels.preview(ZONE, "62", labels.DEFAULT_LAYOUTS[ZONE], given).png == sample.png
    own = labels.preview(
        PACKAGE, "62", labels.DEFAULT_LAYOUTS[PACKAGE], {"qr": "STOWLY/P/9ZX4K", "id": "9ZX4K"}
    )
    lower = labels.preview(
        PACKAGE, "62", labels.DEFAULT_LAYOUTS[PACKAGE], {"qr": "stowly/p/9zx4k", "id": "9ZX4K"}
    )
    assert own.png == lower.png


def test_a_layout_built_by_hand_is_the_same_as_the_default_values():
    """Die Vorgabe ist eine gewöhnliche Gestaltung: so, wie die App sie schickt."""
    sent = LabelLayout(
        length_mm=29,
        qr=LabelQr(side=LabelQrSide.LEFT, size=LabelSize.MEDIUM),
        fields=[
            LabelField(field=LabelFieldName.TITLE, size=LabelSize.MEDIUM, lines=2),
            LabelField(field=LabelFieldName.SUBTITLE, size=LabelSize.MEDIUM, lines=None),
            LabelField(field=LabelFieldName.BEST_BEFORE, size=LabelSize.MEDIUM),
            LabelField(field=LabelFieldName.ID, size=LabelSize.MEDIUM),
            LabelField(field=LabelFieldName.STORED, size=LabelSize.SMALL),
        ],
        date=LabelDateStyle.LONG,
        text="",
        divider=True,
    )
    assert labels.is_default(PACKAGE, "62", sent)
