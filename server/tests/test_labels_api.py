"""Etiketten gestalten über die Schnittstelle: ``/api/labels/design`` und ``/api/labels/preview`` (seit 0.5.0;
docs/plan-0.5.md, 1), dazu ``label_templates.install()`` beim Start und das Zurückspielen einer Sicherung.
"""

import base64
import io
import json
import logging
import sqlite3

from fastapi.testclient import TestClient
from PIL import Image
from support import TEST_PASSWORD, Device, events_of
from test_restore import apply, armed, checked, old_database, uploaded

from stowly import db, label_templates, labels, restore
from stowly.api.labels import preview_gate
from stowly.app import create_app, prepare_database
from stowly.contract.api import (
    LABEL_PREVIEWS_AT_ONCE,
    LabelDesign,
    LabelDesignState,
    LabelKind,
    LabelPreview,
    RestoreState,
)
from stowly_print import media as catalog
from stowly_print.templates import builtin_templates, template_hash

BUILTIN = {key: digest for key, (digest, _body) in builtin_templates().items()}
DEFAULT = labels.DEFAULT_DESIGN.model_dump(mode="json")


def custom(**package_changes) -> dict:
    """Die Vorgabe mit einem anderen Packungs-Etikett (62 mm endlos, 40 mm lang); die Zone bleibt."""
    design = json.loads(json.dumps(DEFAULT))
    design["package"].update({"length_mm": 40, **package_changes})
    return design


def state(response) -> dict:
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    LabelDesignState.model_validate(response.json())
    return response.json()


def get_design(client, device) -> dict:
    return state(client.get("/api/labels/design", headers=device.headers))


def put_design(client, device, design: dict) -> dict:
    return state(client.put("/api/labels/design", json=design, headers=device.headers))


def preview(client, device, **body):
    body = {"kind": "package", "paper": "62", "layout": DEFAULT["package"], "data": None, **body}
    return client.post("/api/labels/preview", json=body, headers=device.headers)


def label_events(client, device) -> list[dict]:
    return [
        (event["type"], event["data"], event["device_id"])
        for event in events_of(client, device, entity="labels")
    ]


def png_of(answer: dict) -> Image.Image:
    with Image.open(io.BytesIO(base64.b64decode(answer["png"]))) as image:
        return image.copy()


# --- Lesen -----------------------------------------------------------------------------------------


def test_without_a_design_the_default_and_the_bundled_templates(client, make_device):
    device = make_device()
    answer = get_design(client, device)
    assert answer["design"] == DEFAULT
    assert (answer["is_default"], answer["updated_at"]) == (True, None)
    assert answer["templates"] == BUILTIN
    assert {key: template["hash"] for key, template in device.label_templates.items()} == BUILTIN
    # Der Papier-Katalog kommt vom Server, in der Reihenfolge des Katalogs.
    assert [paper["id"] for paper in answer["papers"]] == [paper.id for paper in catalog.PAPERS]
    first, *_ = answer["papers"]
    assert first == {
        "id": "18",
        "kind": "endless",
        "name": "18 mm endlos",
        "width_mm": 18.0,
        "length_mm": None,
        "printable_width_px": 234,
        "printable_length_px": None,
    }
    die_cut = next(paper for paper in answer["papers"] if paper["id"] == "62x29")
    assert (die_cut["name"], die_cut["length_mm"], die_cut["printable_length_px"]) == (
        "62 × 29 mm gestanzt",
        29.0,
        271,
    )


def test_every_call_needs_a_device(client):
    calls = [
        ("GET", "/api/labels/design", None),
        ("PUT", "/api/labels/design", DEFAULT),
        ("DELETE", "/api/labels/design", None),
        ("POST", "/api/labels/preview", {"kind": "package", "paper": "62", "layout": DEFAULT["package"]}),
    ]
    for method, path, body in calls:
        for headers in ({}, {"Authorization": "Bearer unbekannt"}):
            response = client.request(method, path, json=body, headers=headers)
            assert response.status_code == 401, (method, path)
            assert response.json()["error"]["code"] == "unauthorized"


# --- Vorschau --------------------------------------------------------------------------------------


def test_preview_of_the_example_and_of_a_package(client, make_device):
    device = make_device()
    response = preview(client, device)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    answer = LabelPreview.model_validate(response.json()).model_dump()
    assert (answer["width_px"], answer["height_px"]) == (696, 342)
    assert answer["notes"] == ["Name auf 3,0 mm verkleinert und gekürzt.", "MHD auf 3,4 mm verkleinert."]
    image = png_of(answer)
    assert (image.size, image.mode) == ((696, 342), "1")

    # Mit den Daten einer Packung aus dem Bestand, wie beim Drucken.
    data = {
        "qr": "STOWLY/P/A2B3C",
        "id": "A2B3C",
        "title": "Reis",
        "subtitle": "1 kg · Kornhaus",
        "best_before": "",
        "stored": "13.11.2026",
        "zone": "Keller",
        "brand": "Kornhaus",
        "quantity": "1 kg",
        "best_before_short": "",
        "stored_short": "13.11.26",
    }
    answer = preview(client, device, data=data).json()
    assert answer["notes"] == []
    # Nichts ist gespeichert, nichts verteilt.
    assert get_design(client, device)["is_default"] is True
    assert device.sync()["changes"]["label_templates"] == []


def test_preview_on_other_paper_as_one_reads_it(client, make_device):
    device = make_device()
    layout = {**DEFAULT["zone"], "length_mm": None, "qr": {"side": "left", "size": "s"}}
    answer = preview(client, device, kind="zone", paper="29x90", layout=layout).json()
    assert (answer["width_px"], answer["height_px"]) == (991, 306)  # gedreht wird erst für den Druck
    assert png_of(answer).size == (991, 306)


def test_preview_refuses_with_a_sentence(client, make_device):
    device = make_device()
    cases = [
        ({"paper": "99"}, labels.UNKNOWN_PAPER, ["body", "paper"]),
        (
            {"paper": "62x29"},
            labels.LENGTH_FIXED,
            ["body", "layout", "length_mm"],
        ),
        (
            {"layout": {**DEFAULT["package"], "qr": {"side": "left", "size": "l"}}},
            "Das MHD passt nicht in seine Zeile: kleiner wählen, das kurze Datum nehmen oder den QR-Code verkleinern.",
            ["body", "layout", "fields", "2"],
        ),
        (
            {"kind": "zone", "layout": DEFAULT["package"]},
            "Auf Zonen-Etiketten gibt es nur „Name“, „Lagerzone“, „Eigener Text“.",
            ["body", "layout", "fields", "2", "field"],
        ),
    ]
    for body, message, loc in cases:
        response = preview(client, device, **body)
        assert response.status_code == 422, body
        error = response.json()["error"]
        assert (error["code"], error["message"]) == ("invalid_request", message)
        assert error["details"]["errors"] == [{"loc": loc, "msg": message, "type": "label_design"}]
    # Was das Modell selbst prüft, wie überall: 422 mit den Stellen.
    for body in (
        {"layout": {**DEFAULT["package"], "length_mm": 24}},
        {"layout": {**DEFAULT["package"], "text": "x" * 41}},
        {"kind": "beides"},
        {"data": {"title": "x" * 501}},
    ):
        response = preview(client, device, **body)
        assert response.status_code == 422, body
        assert response.json()["error"]["details"]["errors"]


def test_at_most_two_previews_at_once(client, make_device):
    device = make_device()
    gate = preview_gate(client.app)
    for _ in range(LABEL_PREVIEWS_AT_ONCE):
        assert gate.enter()
    try:
        response = preview(client, device)
        assert response.status_code == 429
        error = response.json()["error"]
        assert error["code"] == "rate_limited" and error["details"] == {"retry_after_s": 1}
        assert response.headers["retry-after"] == "1"
    finally:
        for _ in range(LABEL_PREVIEWS_AT_ONCE):
            gate.leave()
    assert preview(client, device).status_code == 200
    # Auch ein Fehler gibt den Platz wieder frei.
    for _ in range(LABEL_PREVIEWS_AT_ONCE + 1):
        assert preview(client, device, paper="99").status_code == 422
    assert gate.enter() and gate.enter() and not gate.enter()
    gate.leave()
    gate.leave()


# --- Speichern -------------------------------------------------------------------------------------


def test_save_generates_the_templates_and_every_device_gets_them(client, make_device):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    design = custom(qr={"side": "right", "size": "m"})
    answer = put_design(client, phone, design)
    assert answer["design"] == design
    assert answer["is_default"] is False and answer["updated_at"] is not None
    expected = labels.build_template(LabelKind.PACKAGE, "62", LabelDesign.model_validate(design).package)
    assert answer["templates"] == {"package": template_hash(expected), "zone": BUILTIN["zone"]}
    assert get_design(client, tablet) == answer

    # Neuer rev nur für die geänderte Vorlage; das Zonen-Etikett entspricht der Vorgabe und bleibt.
    data = tablet.sync()
    assert [template["key"] for template in data["changes"]["label_templates"]] == ["package"]
    assert tablet.label_templates["package"]["body"] == expected
    assert tablet.label_templates["package"]["hash"] == answer["templates"]["package"]
    assert tablet.label_templates["zone"]["hash"] == BUILTIN["zone"]
    assert expected["schema"] == 1 and expected["media"]["id"] == "62"

    assert label_events(client, phone) == [
        ("labels.changed", {"paper": "62", "default": False, "templates": ["package"]}, phone.id)
    ]
    # Dasselbe noch einmal: keine Änderung, kein Ereignis, kein neuer rev.
    assert put_design(client, phone, design) == answer
    assert tablet.sync()["changes"]["label_templates"] == []
    assert len(label_events(client, phone)) == 1


def test_another_paper_for_both_kinds(client, make_device):
    device = make_device()
    design = {
        "paper": "62x29",
        "package": {**DEFAULT["package"], "length_mm": None, "qr": {"side": "left", "size": "s"}},
        "zone": {**DEFAULT["zone"], "length_mm": None, "qr": {"side": "left", "size": "s"}},
    }
    answer = put_design(client, device, design)
    data = device.sync()
    assert sorted(template["key"] for template in data["changes"]["label_templates"]) == ["package", "zone"]
    for key in ("package", "zone"):
        body = device.label_templates[key]["body"]
        assert (body["schema"], body["rotate"], body["media"]["id"]) == (2, 0, "62x29")
        assert answer["templates"][key] == device.label_templates[key]["hash"] != BUILTIN[key]


def test_save_refuses_with_a_sentence_and_changes_nothing(client, make_device):
    device = make_device()
    cases = [
        ({**DEFAULT, "paper": "102"}, labels.UNKNOWN_PAPER, ["body", "paper"]),
        (
            {
                **DEFAULT,
                "zone": {
                    **DEFAULT["zone"],
                    "fields": [*DEFAULT["zone"]["fields"], DEFAULT["package"]["fields"][3]],
                },
            },
            "Auf Zonen-Etiketten gibt es nur „Name“, „Lagerzone“, „Eigener Text“.",
            ["body", "zone", "fields", "2", "field"],
        ),
        (
            custom(fields=[*DEFAULT["package"]["fields"], DEFAULT["package"]["fields"][0]]),
            "Das Feld „Name“ steht doppelt in der Liste.",
            ["body", "package", "fields", "5", "field"],
        ),
        (
            custom(fields=[{"field": "brand", "size": "s", "lines": 2}]),
            labels.LINES_ONLY_TITLE,
            ["body", "package", "fields", "0", "lines"],
        ),
        ({**DEFAULT, "paper": "62x29"}, labels.LENGTH_FIXED, ["body", "package", "length_mm"]),
        (custom(length_mm=None), labels.LENGTH_MISSING, ["body", "package", "length_mm"]),
        (
            custom(
                length_mm=25,
                fields=[
                    {"field": name, "size": "l", "lines": None} for name in ("title", "subtitle", "brand")
                ]
                + [
                    {"field": name, "size": "l", "lines": None}
                    for name in ("quantity", "best_before", "zone")
                ]
                + [{"field": name, "size": "l", "lines": None} for name in ("id", "stored", "text")],
                text="Bio",
                qr={"side": "left", "size": "s"},
            ),
            "Für so viele Felder ist das Etikett zu kurz: ein Feld weglassen, kleiner wählen oder länger machen.",
            ["body", "package", "fields"],
        ),
    ]
    for design, message, loc in cases:
        response = client.put("/api/labels/design", json=design, headers=device.headers)
        assert response.status_code == 422, design
        error = response.json()["error"]
        assert error["message"] == message
        assert error["details"]["errors"][0]["loc"] == loc
    assert get_design(client, device)["is_default"] is True
    assert device.sync()["changes"]["label_templates"] == []
    assert label_events(client, device) == []


def test_saving_the_default_means_no_design_of_its_own(client, make_device):
    device = make_device()
    put_design(client, device, custom())
    device.sync()
    answer = put_design(client, device, DEFAULT)
    assert (answer["is_default"], answer["updated_at"], answer["templates"]) == (True, None, BUILTIN)
    data = device.sync()
    assert [template["key"] for template in data["changes"]["label_templates"]] == ["package"]
    assert device.label_templates["package"]["hash"] == BUILTIN["package"]
    assert label_events(client, device)[-1] == (
        "labels.changed",
        {"paper": "62", "default": True, "templates": ["package"]},
        device.id,
    )
    # Die Vorgabe noch einmal zu speichern, ändert nichts.
    put_design(client, device, DEFAULT)
    assert len(label_events(client, device)) == 2


def test_reset_brings_back_the_bundled_templates(client, make_device):
    device = make_device()
    put_design(client, device, custom(date="short"))
    device.sync()
    response = client.delete("/api/labels/design", headers=device.headers)
    answer = state(response)
    assert (answer["is_default"], answer["design"], answer["templates"]) == (True, DEFAULT, BUILTIN)
    data = device.sync()
    assert [template["key"] for template in data["changes"]["label_templates"]] == ["package"]
    assert device.label_templates["package"]["body"] == builtin_templates()["package"][1]
    events = label_events(client, device)
    assert events[-1] == (
        "labels.changed",
        {"paper": "62", "default": True, "templates": ["package"]},
        device.id,
    )
    # Ohne eigene Gestaltung ändert sich nichts: kein Ereignis, kein neuer rev.
    assert state(client.delete("/api/labels/design", headers=device.headers)) == answer
    assert device.sync()["changes"]["label_templates"] == []
    assert label_events(client, device) == events


# --- install() beim Start --------------------------------------------------------------------------


def test_install_at_start_with_and_without_a_design(client, make_device, con, settings):
    device = make_device()
    # Ohne Gestaltung: die mitgelieferten Vorlagen mit unverändertem hash; ein Neustart ändert nichts.
    assert label_templates.install(con) == []
    prepare_database(settings)
    assert label_templates.hashes(con) == BUILTIN

    answer = put_design(
        client,
        device,
        custom(
            text="Vorrat",
            fields=[*DEFAULT["package"]["fields"], {"field": "text", "size": "s", "lines": None}],
        ),
    )
    device.sync()
    assert label_templates.install(con) == []
    # Wie nach einem Update, das die Vorlagen von früher hinterließ: Der Start erzeugt sie aus der Gestaltung.
    with db.transaction(con):
        con.execute(
            "UPDATE label_templates SET hash = ?, body = ? WHERE key = 'package'",
            (BUILTIN["package"], json.dumps(builtin_templates()["package"][1])),
        )
    prepare_database(settings)
    assert label_templates.hashes(con) == answer["templates"]
    data = device.sync()
    assert [template["key"] for template in data["changes"]["label_templates"]] == ["package"]
    assert device.label_templates["package"]["hash"] == answer["templates"]["package"]

    # Ohne Zeile in label_design (etwa von Hand gelöscht) wieder die mitgelieferten.
    with db.transaction(con):
        con.execute("DELETE FROM label_design")
    assert label_templates.install(con) == ["package"]
    assert label_templates.hashes(con) == BUILTIN


def test_an_unreadable_design_counts_as_none(client, make_device, con, caplog):
    device = make_device()
    put_design(client, device, custom())
    unreadable = (
        "kein json",
        json.dumps({"paper": "62"}),
        "x" * (label_templates.MAX_DESIGN_BYTES + 1),
        "[" * 30_000 + "]" * 30_000,  # so tief verschachtelt, dass json.loads aufgibt
    )
    for body in unreadable:
        with db.transaction(con):
            con.execute("UPDATE label_design SET body = ?", (body,))
        caplog.clear()
        with caplog.at_level(logging.WARNING, logger="stowly.labels"):
            label_templates.install(con)
            assert label_templates.hashes(con) == BUILTIN
            assert get_design(client, device)["is_default"] is True
        assert "unbrauchbar" in caplog.text


def test_a_design_the_generator_no_longer_takes_keeps_the_current_template(client, make_device, con, caplog):
    """Gespeichert wird nur, was passt. Passt es nach einem Update nicht mehr, bleibt die geltende Vorlage."""
    device = make_device()
    answer = put_design(client, device, custom())
    stored = json.loads(con.execute("SELECT body FROM label_design").fetchone()["body"])
    stored["package"]["qr"]["size"] = "l"
    stored["package"]["length_mm"] = 25  # so groß passt der QR-Code nicht
    with db.transaction(con):
        con.execute("UPDATE label_design SET body = ?", (json.dumps(stored),))
    with caplog.at_level(logging.ERROR, logger="stowly.labels"):
        assert label_templates.install(con) == []
    assert label_templates.hashes(con) == answer["templates"]
    assert "ergibt keine Vorlage" in caplog.text and "es gilt die bisherige" in caplog.text


# --- Zurückspielen ---------------------------------------------------------------------------------


def test_restoring_a_backup_of_0_4_0_runs_migration_6_and_keeps_the_bundled_templates(
    settings, clock, tmp_path
):
    """Eine Sicherung von 0.4.0 (Schema 5): Die Migration 0006 legt ``label_design`` leer an, und es gelten die
    mitgelieferten Vorlagen mit ihrem ``hash``, auch wenn hier vorher eine eigene Gestaltung galt."""
    old = tmp_path / "stowly-0.4.0.sqlite3"
    old_database(old, 5)
    raw = sqlite3.connect(old)
    try:
        with raw:
            for key, (digest, body) in builtin_templates().items():
                raw.execute(
                    "INSERT INTO label_templates (key, hash, body, updated_at, rev) VALUES (?, ?, ?, ?, 1)",
                    (key, digest, json.dumps(body), "2025-01-02T03:04:05.000Z"),
                )
    finally:
        raw.close()

    with TestClient(create_app(settings)) as client:
        phone = Device(client, "Handy", clock=clock)
        put_design(client, phone, custom())
        restarts = armed(client)
        up = uploaded(client, old.read_bytes(), phone.headers)
        assert up["kind"] == "sqlite"
        preview = checked(client, up["upload_id"], None, phone.headers)
        assert preview["schema_version"] == 5
        assert apply(client, preview["restore_id"], TEST_PASSWORD, phone.headers).status_code == 202
        assert restarts.calls == 1
    assert restore.resume(settings) is RestoreState.DONE

    with TestClient(create_app(settings)) as client:
        phone.client = client
        con = db.connect(settings.database_path)
        try:
            assert db.schema_version(con) == len(db.list_migrations()) == 6
            assert con.execute("SELECT COUNT(*) FROM label_design").fetchone()[0] == 0
        finally:
            con.close()
        answer = get_design(client, phone)
        assert (answer["is_default"], answer["templates"]) == (True, BUILTIN)
        data = phone.sync()
        assert data["reset"] is True
        assert {key: template["hash"] for key, template in phone.label_templates.items()} == BUILTIN


def test_a_design_comes_back_with_its_backup(settings, clock, tmp_path):
    with TestClient(create_app(settings)) as client:
        phone = Device(client, "Handy", clock=clock)
        saved = put_design(client, phone, custom(date="short"))
        backup = tmp_path / "mit-gestaltung.sqlite3"
        con = db.connect(settings.database_path)
        try:
            con.execute("VACUUM INTO ?", (str(backup),))
        finally:
            con.close()
        client.delete("/api/labels/design", headers=phone.headers)
        restarts = armed(client)
        up = uploaded(client, backup.read_bytes(), phone.headers)
        preview = checked(client, up["upload_id"], None, phone.headers)
        assert apply(client, preview["restore_id"], TEST_PASSWORD, phone.headers).status_code == 202
        assert restarts.calls == 1
    assert restore.resume(settings) is RestoreState.DONE
    with TestClient(create_app(settings)) as client:
        phone.client = client
        answer = get_design(client, phone)
        assert (answer["design"], answer["templates"]) == (saved["design"], saved["templates"])
        assert answer["is_default"] is False
