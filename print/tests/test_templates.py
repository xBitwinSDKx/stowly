import re

from stowly_print.templates import (
    BUILTIN_TEMPLATES,
    TEMPLATE_SCHEMA,
    builtin_templates,
    load_builtin,
    template_hash,
)

ELEMENT_TYPES = {"text", "qr", "line", "rect"}
PLACEHOLDER = re.compile(r"\{([a-z_]+)\}")

# Felder, die die App je Etikett-Art liefert (docs/etiketten.md, „Daten")
DATA_FIELDS = {
    "package": {"qr", "id", "title", "subtitle", "best_before", "stored", "zone"},
    "zone": {"qr", "title", "subtitle"},
}


def test_builtin_templates_are_complete():
    assert set(BUILTIN_TEMPLATES) == {"package", "zone"}
    for key, (digest, body) in builtin_templates().items():
        assert body["schema"] == TEMPLATE_SCHEMA
        assert digest == template_hash(body)
        assert len(digest) == 16
        assert body["media"] == {"width_mm": 62, "length_mm": 29}
        assert body["elements"], key


def test_elements_stay_inside_the_design_area_and_use_known_fields():
    for key in BUILTIN_TEMPLATES:
        body = load_builtin(key)
        width = body["design"]["width_mm"]
        height = body["design"]["height_mm"]
        for element in body["elements"]:
            assert element["type"] in ELEMENT_TYPES
            if element["type"] == "line":
                xs, ys = (element["x1"], element["x2"]), (element["y1"], element["y2"])
            elif element["type"] == "qr":
                xs = (element["x"], element["x"] + element["size"])
                ys = (element["y"], element["y"] + element["size"])
            else:
                xs = (element["x"], element["x"] + element["w"])
                ys = (element["y"], element["y"] + element["h"])
            assert 0 <= min(xs) and max(xs) <= width, (key, element)
            assert 0 <= min(ys) and max(ys) <= height, (key, element)

            used = set(PLACEHOLDER.findall(element.get("value", "")))
            if "when" in element:
                used.add(element["when"])
            assert used <= DATA_FIELDS[key], (key, element)


def test_every_template_carries_a_qr_code():
    for key in BUILTIN_TEMPLATES:
        qr = [e for e in load_builtin(key)["elements"] if e["type"] == "qr"]
        assert len(qr) == 1
        assert qr[0]["value"] == "{qr}"


def test_template_hash_is_independent_of_key_order():
    assert template_hash({"a": 1, "b": [1, 2]}) == template_hash({"b": [1, 2], "a": 1})
    assert template_hash({"a": 1}) != template_hash({"a": 2})
