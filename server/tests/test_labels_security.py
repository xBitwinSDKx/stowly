"""Etiketten und Produktdaten gegen Eingaben von außen (Sicherheitsprüfung 0.5.0).

Was in ``label_design`` und ``label_templates`` steht, kann aus einer Sicherung stammen, also aus einer
Fälschung. Stowly startet trotzdem immer, liefert nie eine fremde Vorlage über den Sync aus, und die
Vorschau rechnet nur mit Daten so lang, wie die App sie schickt.
"""

import json
import logging
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from support import TEST_PASSWORD, Device
from test_restore import apply, armed, checked, stowly_file, uploaded

from stowly import db, label_templates, labels, restore
from stowly.app import create_app, prepare_database
from stowly.contract.api import LabelKind, RestoreState
from stowly.errors import ApiError
from stowly.printing import ServerPrinters
from stowly_print.templates import builtin_templates

BUILTIN = {key: digest for key, (digest, _body) in builtin_templates().items()}
BUILTIN_BODY = {key: body for key, (_digest, body) in builtin_templates().items()}
STAMP = "2026-11-16T09:00:00.000Z"
# Ein einzelnes Surrogat als JSON-Escape: gültiges UTF-8 in der Datei, aber kein schreibbarer Text.
SURROGATE_ESCAPE = "\\ud800"


def design_json(paper: str = "62x29", text: str = "") -> str:
    design = labels.DEFAULT_DESIGN.model_dump(mode="json")
    design["paper"] = paper
    for kind in ("package", "zone"):
        design[kind].update({"length_mm": None if "x" in paper else 40, "qr": {"side": "left", "size": "s"}})
    design["package"]["text"] = text
    return json.dumps(design)


VALID = design_json()
# Ein QR-Inhalt, den eine Fälschung allen Geräten unterschieben wollte.
EVIL_TEMPLATE = json.dumps(
    {
        "schema": 1,
        "name": "package",
        "media": {"width_mm": 62, "length_mm": 29},
        "design": {"width_mm": 58.9, "height_mm": 29.0},
        "elements": [{"type": "qr", "x": 0.5, "y": 2.5, "size": 24.0, "value": "https://example.org/gewinn"}],
    }
)

# Zeilen in label_design, die nicht taugen: (Rumpf als SQL, updated_at als SQL, Parameter).
UNUSABLE_DESIGNS = {
    "kein UTF-8": ("CAST(X'7BFF7D' AS TEXT)", "?", (STAMP,)),
    "zu groß": ("?", "?", ('{"paper": "' + "x" * (label_templates.MAX_DESIGN_BYTES + 1) + '"}', STAMP)),
    "Papier nicht im Katalog": ("?", "?", (design_json(paper="62").replace('"62"', '"102"', 1), STAMP)),
    "updated_at kein Zeitstempel": ("?", "?", (VALID, "gestern")),
    "updated_at kein UTF-8": ("?", "CAST(X'61FF62' AS TEXT)", (VALID,)),
    "einzelnes Surrogat": (
        "?",
        "?",
        (VALID.replace('"text": ""', f'"text": "{SURROGATE_ESCAPE}"', 1), STAMP),
    ),
    "tief verschachtelt": ("?", "?", ("[" * 30_000 + "]" * 30_000, STAMP)),
    "kein Vertrag": ("?", "?", ('{"paper": "62"}', STAMP)),
}


def write_design(con: sqlite3.Connection, body_sql: str, stamp_sql: str, params: tuple) -> None:
    with db.transaction(con):
        con.execute("DELETE FROM label_design")
        con.execute(
            f"INSERT INTO label_design (id, body, updated_at, updated_by) VALUES (1, {body_sql}, {stamp_sql}, NULL)",
            params,
        )


# --- Start mit einer kaputten oder gefälschten Gestaltung ---------------------------------------------


@pytest.mark.parametrize("case", sorted(UNUSABLE_DESIGNS))
def test_an_unusable_design_never_stops_the_start(client, make_device, con, settings, case, caplog):
    device = make_device()
    body_sql, stamp_sql, params = UNUSABLE_DESIGNS[case]
    write_design(con, body_sql, stamp_sql, params)
    with caplog.at_level(logging.WARNING, logger="stowly.labels"):
        prepare_database(settings)  # wie beim Neustart nach dem Tausch
    assert "unbrauchbar" in caplog.text
    assert label_templates.stored_design(con) is None
    assert label_templates.hashes(con) == BUILTIN
    response = client.get("/api/labels/design", headers=device.headers)
    assert response.status_code == 200
    assert (response.json()["is_default"], response.json()["templates"]) == (True, BUILTIN)
    # Ein Drucker am Server nimmt dann das Papier seiner Konfiguration.
    assert ServerPrinters._household_paper(con) is None


def test_a_usable_design_is_read_and_its_paper_used(client, make_device, con, settings):
    device = make_device()
    write_design(con, "?", "?", (VALID, STAMP))
    prepare_database(settings)
    design, stamp = label_templates.stored_design(con)
    assert (design.paper, stamp) == ("62x29", STAMP)
    assert ServerPrinters._household_paper(con) == "62x29"
    answer = client.get("/api/labels/design", headers=device.headers).json()
    assert (answer["is_default"], answer["updated_at"], answer["design"]["paper"]) == (False, STAMP, "62x29")
    assert answer["templates"]["package"] != BUILTIN["package"]


def test_the_start_falls_back_to_the_bundled_templates(client, con, settings, monkeypatch, caplog):
    """Was auch immer beim Erzeugen schiefgeht: Stowly startet, mit den mitgelieferten Vorlagen."""
    write_design(con, "?", "?", (VALID, STAMP))
    original = label_templates.install

    def broken(connection, *, use_design: bool = True):
        if use_design:
            raise RuntimeError("Generator kaputt")
        return original(connection, use_design=False)

    monkeypatch.setattr(label_templates, "install", broken)
    with caplog.at_level(logging.ERROR, logger="stowly"):
        prepare_database(settings)
    assert "es gelten die mitgelieferten" in caplog.text
    assert label_templates.hashes(con) == BUILTIN

    # Selbst wenn auch das scheitert, startet Stowly.
    def hopeless(connection, *, use_design: bool = True):
        raise sqlite3.OperationalError("kaputt")

    monkeypatch.setattr(label_templates, "install", hopeless)
    prepare_database(settings)


# --- Vorlagen: nur, was zum hash passt ------------------------------------------------------------------


FORGED_TEMPLATES = {
    "fremder Rumpf, alter hash": ("?", "?", lambda key: (EVIL_TEMPLATE, BUILTIN[key])),
    "hash kein UTF-8": ("?", "CAST(X'61FF62' AS TEXT)", lambda key: (json.dumps(BUILTIN_BODY[key]),)),
    "Rumpf kein UTF-8": ("CAST(X'7BFF7D' AS TEXT)", "?", lambda key: (BUILTIN[key],)),
    "Rumpf mit Surrogat": (
        "?",
        "?",
        lambda key: ('{"schema": 1, "x": "' + SURROGATE_ESCAPE + '"}', BUILTIN[key]),
    ),
    "Rumpf zu groß": ("?", "?", lambda key: ("[" + "0," * 200_000 + "0]", BUILTIN[key])),
}


@pytest.mark.parametrize("case", sorted(FORGED_TEMPLATES))
def test_a_template_that_does_not_match_its_hash_is_written_anew(client, make_device, con, settings, case):
    device = make_device()
    body_sql, hash_sql, params = FORGED_TEMPLATES[case]
    with db.transaction(con):
        con.execute(
            f"UPDATE label_templates SET body = {body_sql}, hash = {hash_sql} WHERE key = 'package'",
            params("package"),
        )
    prepare_database(settings)
    data = device.sync()
    # Ein neuer rev: Jedes Gerät bekommt die echte Vorlage, nie die fremde.
    assert [template["key"] for template in data["changes"]["label_templates"]] == ["package"]
    assert device.label_templates["package"]["body"] == BUILTIN_BODY["package"]
    assert device.label_templates["package"]["hash"] == BUILTIN["package"]
    assert label_templates.install(con) == []


# --- Zurückspielen --------------------------------------------------------------------------------------


def examined_copy(settings, tmp_path: Path, statements: list[tuple[str, tuple]]) -> sqlite3.Connection:
    """Eine Kopie der Datenbank, gefälscht und dann geprüft wie beim Zurückspielen (``restore.examine``)."""
    path = stowly_file(settings, tmp_path)
    raw = sqlite3.connect(path, isolation_level=None)
    try:
        for statement, params in statements:
            raw.execute(statement, params)
    finally:
        raw.close()
    restore.examine(path)
    copy = sqlite3.connect(path)
    copy.row_factory = sqlite3.Row
    return copy


def test_restore_drops_the_templates_and_keeps_a_usable_design(client, settings, tmp_path):
    statements = [
        ("INSERT INTO label_design (id, body, updated_at) VALUES (1, ?, ?)", (VALID, STAMP)),
        ("UPDATE label_templates SET body = ? WHERE key = 'package'", (EVIL_TEMPLATE,)),
    ]
    copy = examined_copy(settings, tmp_path, statements)
    try:
        # Vorlagen sind abgeleitet: Der Start erzeugt sie neu, aus der Gestaltung.
        assert copy.execute("SELECT COUNT(*) FROM label_templates").fetchone()[0] == 0
        assert copy.execute("SELECT body FROM label_design").fetchone()["body"] == VALID
    finally:
        copy.close()


@pytest.mark.parametrize("case", sorted(UNUSABLE_DESIGNS))
def test_restore_drops_an_unusable_design(client, settings, tmp_path, case, caplog):
    body_sql, stamp_sql, params = UNUSABLE_DESIGNS[case]
    statement = f"INSERT INTO label_design (id, body, updated_at) VALUES (1, {body_sql}, {stamp_sql})"
    # Kein UTF-8 oder zu tief verschachtelt: Das lehnt schon die Prüfung aller Texte ab (test_restore_text.py),
    # die ganze Sicherung.
    refused = {"kein UTF-8": restore.INVALID_TEXT, "updated_at kein UTF-8": restore.INVALID_TEXT}
    refused["tief verschachtelt"] = restore.JSON_TOO_DEEP
    if case in refused:
        with pytest.raises(ApiError) as caught:
            examined_copy(settings, tmp_path, [(statement, params)])
        assert (caught.value.details, caught.value.message) == ({"reason": "damaged"}, refused[case])
        return
    with caplog.at_level(logging.WARNING, logger="stowly"):
        copy = examined_copy(settings, tmp_path, [(statement, params)])
    try:
        assert copy.execute("SELECT COUNT(*) FROM label_design").fetchone()[0] == 0
    finally:
        copy.close()
    assert "Gestaltung der Etiketten aus der Sicherung ist unbrauchbar" in caplog.text


def test_a_forged_backup_starts_and_every_device_gets_the_bundled_templates(settings, clock, tmp_path):
    """Der ganze Weg: hochladen, prüfen, anwenden, Neustart. Die Fälschung (gültiges UTF-8, sonst lehnte schon
    die Prüfung ab) bringt weder ihre Vorlagen noch ihre unbrauchbare Gestaltung mit, und Stowly startet."""
    with TestClient(create_app(settings)) as client:
        phone = Device(client, "Handy", clock=clock)
        forged = stowly_file(settings, tmp_path, "gefaelscht.sqlite3")
        raw = sqlite3.connect(forged, isolation_level=None)
        try:
            unknown_paper = design_json(paper="62").replace('"62"', '"102"', 1)
            raw.execute(
                "INSERT INTO label_design (id, body, updated_at) VALUES (1, ?, ?)", (unknown_paper, STAMP)
            )
            raw.execute("UPDATE label_templates SET body = ? WHERE key = 'package'", (EVIL_TEMPLATE,))
            raw.execute(
                "UPDATE label_templates SET body = ? WHERE key = 'zone'",
                ('{"schema": 1, "x": "' + SURROGATE_ESCAPE + '"}',),
            )
        finally:
            raw.close()
        restarts = armed(client)
        up = uploaded(client, forged.read_bytes(), phone.headers)
        candidate = checked(client, up["upload_id"], None, phone.headers)
        assert apply(client, candidate["restore_id"], TEST_PASSWORD, phone.headers).status_code == 202
        assert restarts.calls == 1
    assert restore.resume(settings) is RestoreState.DONE
    with TestClient(create_app(settings)) as client:
        phone.client = client
        answer = client.get("/api/labels/design", headers=phone.headers).json()
        assert (answer["is_default"], answer["templates"]) == (True, BUILTIN)
        phone.sync()
        assert {key: template["body"] for key, template in phone.label_templates.items()} == BUILTIN_BODY


# --- Vorschau: nur Daten so lang, wie die App sie schickt ------------------------------------------------


def preview(client, device, kind: str, data: dict | None, *, raw: bytes | None = None):
    if raw is not None:
        return client.post(
            "/api/labels/preview", content=raw, headers={**device.headers, "Content-Type": "application/json"}
        )
    layout = labels.DEFAULT_LAYOUTS[LabelKind(kind)].model_dump(mode="json")
    body = {"kind": kind, "paper": "62", "layout": layout, "data": data}
    return client.post("/api/labels/preview", json=body, headers=device.headers)


@pytest.mark.parametrize("kind", ["package", "zone"])
def test_preview_data_up_to_the_limits_of_the_app(client, make_device, kind):
    device = make_device()
    limits = labels.DATA_LIMITS[LabelKind(kind)]
    full = {key: "W" * limit for key, limit in limits.items()}
    response = preview(client, device, kind, {**full, "unbekannt": "x" * 500})  # Unbekanntes übergeht sie
    assert response.status_code == 200, response.text
    for key, limit in limits.items():
        response = preview(client, device, kind, {**full, key: "W" * (limit + 1)})
        assert response.status_code == 422, key
        error = response.json()["error"]
        assert error["message"].startswith("Zu lang für ein Etikett: ")
        assert error["message"].endswith(f"höchstens {limit} Zeichen.")
        assert error["details"]["errors"][0]["loc"] == ["body", "data", key]


def test_preview_sentences_for_data(client, make_device):
    device = make_device()
    response = preview(client, device, "package", {"title": "x" * 121})
    assert response.json()["error"]["message"] == "Zu lang für ein Etikett: Name höchstens 120 Zeichen."
    response = preview(client, device, "zone", {"title": "x" * 61})
    assert response.json()["error"]["message"] == "Zu lang für ein Etikett: Name höchstens 60 Zeichen."
    response = preview(client, device, "package", {"subtitle": "x" * 124})
    message = response.json()["error"]["message"]
    assert message == "Zu lang für ein Etikett: Größe · Marke höchstens 123 Zeichen."
    # Einzelne Surrogate lehnt schon der JSON-Parser der Schnittstelle ab; die Vorschau prüft trotzdem selbst.
    layout = labels.DEFAULT_LAYOUTS[LabelKind.PACKAGE].model_dump(mode="json")
    raw = json.dumps({"kind": "package", "paper": "62", "layout": layout, "data": {"title": "X"}})
    response = preview(
        client, device, "package", None, raw=raw.replace('"X"', f'"{SURROGATE_ESCAPE}"').encode()
    )
    assert response.status_code == 422
    with pytest.raises(labels.LabelDesignError) as caught:
        labels.preview_data(LabelKind.PACKAGE, {"title": "Reis " + chr(0xD800)})
    assert (caught.value.message, caught.value.loc) == (
        "Name enthält Zeichen, die sich nicht drucken lassen.",
        ("data", "title"),
    )


def test_a_text_that_cannot_be_written_as_utf_8_is_refused(client, make_device):
    """Ein einzelnes Surrogat im eigenen Text ließe die Vorlage weder hashen noch speichern."""
    device = make_device()
    raw = VALID.replace('"text": ""', f'"text": "{SURROGATE_ESCAPE}"', 1).encode()
    response = client.put(
        "/api/labels/design", content=raw, headers={**device.headers, "Content-Type": "application/json"}
    )
    assert response.status_code == 422  # schon der JSON-Parser der Schnittstelle
    assert client.get("/api/labels/design", headers=device.headers).json()["is_default"] is True
    layout = labels.DEFAULT_LAYOUTS[LabelKind.PACKAGE].model_copy(
        update={"text": "Bio " + chr(0xDC80), "length_mm": 40}
    )
    with pytest.raises(labels.LabelDesignError) as caught:
        labels.check(LabelKind.PACKAGE, "62", layout)
    assert (caught.value.message, caught.value.loc) == (labels.TEXT_UNPRINTABLE, ("text",))


def test_an_unusable_design_is_reported_once_not_on_every_print_job(client, con, caplog):
    """Die Drucker am Server fragen bei jedem Auftrag nach dem Papier: Die Warnung steht trotzdem nur einmal da."""
    write_design(con, "?", "?", (VALID, "gestern"))
    with caplog.at_level(logging.WARNING, logger="stowly.labels"):
        for _ in range(3):
            assert ServerPrinters._household_paper(con) is None
    assert caplog.text.count("unbrauchbar") == 1
    # Ein anderes Problem steht wieder da, und nach einer brauchbaren Gestaltung auch dasselbe.
    write_design(con, "?", "?", ('{"paper": "62"}', STAMP))
    write_design(con, "?", "?", (VALID, STAMP))
    caplog.clear()
    with caplog.at_level(logging.WARNING, logger="stowly.labels"):
        assert ServerPrinters._household_paper(con) == "62x29"
        write_design(con, "?", "?", (VALID, "gestern"))
        assert label_templates.stored_design(con) is None
    assert caplog.text.count("unbrauchbar") == 1
