"""Der Druckdienst im Server unter ``/print`` (docs/etiketten.md, 5.8).

Gedruckt wird mit dem Bild-Treiber: Er schreibt jedes Etikett als PNG ins Datenverzeichnis
(``print/images``). Störungen stellt die Datei ``simulate.txt`` dort nach (``hang``, ``abort``,
``fail``). Kein Test spricht ein Gerät oder einen fremden Dienst an.
"""

import io
import os
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from support import Device, events_of, statuses

from stowly import db, printing
from stowly.app import create_app
from stowly.contract import ids
from stowly.contract.entities import PrintJobState
from stowly_print.model import Job, JobState

IMAGE = {"driver": "image", "model": None, "address": None, "media": "62"}
# Ein Brother, den der Treiber nicht kennt: Er bleibt in der Liste und meldet „config".
UNUSABLE = {"driver": "brother_ql", "model": "QL-9999", "address": "tcp://127.0.0.1:9", "media": "62"}


def wait_until(condition, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while not condition():
        if time.monotonic() > deadline:
            raise AssertionError("Bedingung ist nicht rechtzeitig eingetreten")
        time.sleep(0.01)


def images_of(settings) -> Path:
    return settings.data_dir / "print" / "images"


def add_printer(device: Device, name: str = "Bild", config: dict | None = None) -> str:
    printer_id = ids.new_uuid()
    command = device.cmd(
        "printer.create", printer_id=printer_id, name=name, connection="server", server=config or IMAGE
    )
    assert statuses(device.sync([command])) == [("applied", None)]
    return printer_id


def request_label(device: Device, printer_id: str | None = None, title: str = "Basmati Reis") -> str:
    """Lagert eine Packung ein und fordert ihr Etikett an; liefert die Kennung des Etiketts."""
    _product_id, package_id = device.store(title)
    job_id = ids.new_uuid()
    command = device.cmd(
        "print.request", job_id=job_id, kind="package", package_id=package_id, printer_id=printer_id
    )
    assert statuses(device.sync([command])) == [("applied", None)]
    return job_id


def job_body(device: Device, printer_id: str | None, title: str = "Basmati Reis", **more) -> dict:
    """Der Auftrag, wie ihn die App einreicht: die Vorlage aus dem Sync, fertige Zeichenketten."""
    return {
        "printer": printer_id,
        "template": device.label_templates["package"]["body"],
        "data": {
            "qr": "STOWLY/P/A2B3C",
            "id": "A2B3C",
            "title": title,
            "subtitle": "Kornhaus · 1 kg",
            "best_before": "25.03.2027",
            "stored": "13.11.2026",
            "zone": "",
        },
        "copies": 1,
        "cut": True,
        **more,
    }


def submit(device: Device, job_id: str, body: dict, wait: float = 10):
    return device.client.post(
        f"/print/v1/jobs/{job_id}", params={"wait": wait}, json=body, headers=device.headers
    )


def error_code(response) -> str:
    body = response.json()
    assert set(body["error"]) == {"code", "message", "details"}
    return body["error"]["code"]


# --- Anmeldung ---------------------------------------------------------------------------


def test_every_call_needs_a_device_token(client, make_device):
    device = make_device()
    printer_id = add_printer(device)
    job_id = request_label(device, printer_id)
    calls = (
        ("GET", "/print/v1/health"),
        ("GET", "/print/v1/printers"),
        ("GET", f"/print/v1/jobs/{job_id}"),
        ("GET", f"/print/v1/jobs/{job_id}/image"),
        ("POST", f"/print/v1/jobs/{job_id}"),
        ("PUT", f"/print/v1/jobs/{job_id}"),
        ("DELETE", f"/print/v1/jobs/{job_id}"),
        ("POST", f"/print/v1/jobs/{job_id}/cancel"),
        ("POST", "/print/v1/render"),
    )
    revoked = make_device("Altes Handy", sync=False)
    assert client.post("/api/auth/logout", headers=revoked.headers).status_code == 204
    for headers in ({}, {"Authorization": "Bearer falsch"}, revoked.headers, {"Authorization": "Basic x"}):
        for method, path in calls:
            response = client.request(method, path, json=job_body(device, printer_id), headers=headers)
            assert response.status_code == 401, (method, path, headers)
            assert error_code(response) == "unauthorized"
            assert response.json()["error"]["message"] == "Nicht angemeldet."
            assert response.headers["www-authenticate"] == "Bearer"
    # Nichts davon hat etwas angenommen.
    assert device.sync() and device.print_jobs[job_id]["state"] == "pending"

    health = client.get("/print/v1/health", params={"nonce": "n" * 16}, headers=device.headers)
    assert health.status_code == 200
    body = health.json()
    assert (body["app"], body["protocol"], body["proof"], body["host"]) == ("stowly-print", 1, None, None)
    # Weder CORS noch die Seite /p: Die App spricht den Server immer vom eigenen Ursprung an.
    response = client.get("/print/v1/health", headers={**device.headers, "Origin": "https://fremd.example"})
    assert "access-control-allow-origin" not in response.headers
    assert client.get("/print/p", headers=device.headers).status_code == 404


# --- Nur bekannte, ausstehende Etiketten -------------------------------------------------


def test_a_label_the_server_does_not_know_is_not_accepted(client, make_device, settings):
    device = make_device()
    printer_id = add_printer(device)
    unknown = ids.new_uuid()
    response = submit(device, unknown, job_body(device, printer_id))
    assert (response.status_code, error_code(response)) == (404, "not_found")
    assert client.get(f"/print/v1/jobs/{unknown}", headers=device.headers).status_code == 404
    assert not list(images_of(settings).glob("*.png"))


def test_a_cancelled_or_finished_label_is_not_pending(client, make_device, settings):
    device = make_device()
    printer_id = add_printer(device)
    cancelled = request_label(device, printer_id)
    report = device.cmd("print.report", job_id=cancelled, state="cancelled", printer_id=printer_id)
    assert statuses(device.sync([report])) == [("applied", None)]

    response = submit(device, cancelled, job_body(device, printer_id))
    assert (response.status_code, error_code(response)) == (409, "not_pending")
    assert response.json()["error"]["details"] == {"state": "cancelled"}
    # Auch wenn der Drucker inzwischen fehlt: Das Etikett zählt zuerst.
    response = submit(device, cancelled, job_body(device, ids.new_uuid()))
    assert (response.status_code, error_code(response)) == (409, "not_pending")
    # Nichts geschrieben: Das Etikett kommt im nächsten Abgleich gar nicht erst wieder.
    assert device.sync()["changes"]["print_jobs"] == []
    assert device.print_jobs[cancelled]["state"] == "cancelled"
    assert not list(images_of(settings).glob("*.png"))


def test_a_job_without_printer_or_for_an_unknown_one(client, make_device):
    device = make_device()
    add_printer(device)
    job_id = request_label(device)
    for printer in (None, ids.new_uuid(), "kein-drucker"):
        response = submit(device, job_id, job_body(device, printer))
        assert (response.status_code, error_code(response)) == (404, "unknown_printer"), printer
    # Der Server hat keinen Standarddrucker; das Etikett bleibt ausstehend.
    device.sync()
    assert device.print_jobs[job_id]["state"] == "pending"


# --- Drucken und fortschreiben -----------------------------------------------------------


def test_print_writes_the_label_and_the_other_device_sees_the_final_state(
    client, make_device, settings, clock
):
    kitchen, cellar = make_device("Küche"), make_device("Keller")
    printer_id = add_printer(kitchen)
    job_id = request_label(kitchen, printer_id)
    cellar.sync()
    assert cellar.print_jobs[job_id]["state"] == "pending"
    boot_id = client.get("/print/v1/health", headers=kitchen.headers).json()["boot_id"]

    response = submit(kitchen, job_id, job_body(kitchen, printer_id, expect_boot_id=boot_id))
    assert response.status_code == 201
    job = response.json()
    assert job == {
        "id": job_id,
        "state": "printed",
        "printer": printer_id,
        "boot_id": boot_id,
        "error": None,
        "position": None,
    }

    # Das PNG liegt im Datenverzeichnis und ist abrufbar.
    png = images_of(settings) / f"{job_id}.png"
    assert png.is_file()
    response = client.get(f"/print/v1/jobs/{job_id}/image", headers=cellar.headers)
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.content == png.read_bytes()
    with Image.open(io.BytesIO(response.content)) as label:
        assert (label.size, label.mode) == ((696, 342), "1")

    # Der Endzustand kommt beim nächsten Sync eines anderen Geräts an, ohne dass ein Gerät meldet.
    cellar.sync()
    label = cellar.print_jobs[job_id]
    assert (label["state"], label["printer_id"], label["boot_id"], label["error"]) == (
        "printed",
        printer_id,
        boot_id,
        None,
    )
    assert label["updated_at"] == clock.stamp()
    log = events_of(client, cellar, entity="print_job", entity_id=job_id)
    assert [(e["type"], e["device_id"], e["command_id"], e["data"]["state"]) for e in log] == [
        ("print.requested", kitchen.id, log[0]["command_id"], "pending"),
        ("print.reported", None, None, "queued"),
        ("print.reported", None, None, "printing"),
        ("print.reported", None, None, "printed"),
    ]
    assert log[1]["data"] == {
        "kind": "package",
        "state": "queued",
        "printer_id": printer_id,
        "error": None,
        "old": {"state": "pending", "error": None},
    }

    # Derselbe Auftrag noch einmal: 200, derselbe Zustand, kein zweites Bild, kein neuer Eintrag.
    again = submit(kitchen, job_id, job_body(kitchen, printer_id, expect_boot_id=boot_id))
    assert (again.status_code, again.json()) == (200, job)
    assert [path.name for path in images_of(settings).glob("*.png")] == [f"{job_id}.png"]
    assert len(events_of(client, cellar, entity="print_job", entity_id=job_id)) == 4
    # Anderer Inhalt unter derselben Kennung: Konflikt.
    response = submit(kitchen, job_id, job_body(kitchen, printer_id, "Jasmin Reis"))
    assert (response.status_code, error_code(response)) == (409, "job_conflict")


def test_accepting_writes_queued_before_the_answer(client, make_device, settings):
    device = make_device()
    printer_id = add_printer(device)
    job_id = request_label(device, printer_id)
    (images_of(settings) / "simulate.txt").write_text("hang", encoding="utf-8")
    try:
        response = submit(device, job_id, job_body(device, printer_id), wait=0)
        assert response.status_code == 201
        assert response.json()["state"] in ("queued", "printing")
        con = db.connect(settings.database_path)
        try:
            row = con.execute(
                "SELECT state, printer_id, boot_id, error FROM print_jobs WHERE id = ?", (job_id,)
            ).fetchone()
        finally:
            con.close()
        # Schon beim Annehmen steht der Zustand im Bestand, samt Drucker und boot_id.
        assert row["state"] in ("queued", "printing")
        assert (row["printer_id"], row["boot_id"], row["error"]) == (
            printer_id,
            response.json()["boot_id"],
            None,
        )
        wait_until(
            lambda: (
                client.get(f"/print/v1/jobs/{job_id}", headers=device.headers).json()["state"] == "printing"
            )
        )
        device.sync()
        assert device.print_jobs[job_id]["state"] == "printing"
        # Wer wartet, bekommt nach der Wartezeit den Stand von dann.
        response = client.get(f"/print/v1/jobs/{job_id}", params={"wait": 0.2}, headers=device.headers)
        assert response.json()["state"] == "printing"
    finally:
        (images_of(settings) / "simulate.txt").write_text("abort", encoding="utf-8")
    final = client.get(f"/print/v1/jobs/{job_id}", params={"wait": 10}, headers=device.headers).json()
    assert (final["state"], final["error"]["code"]) == ("unknown", "interrupted")
    device.sync()
    assert (device.print_jobs[job_id]["state"], device.print_jobs[job_id]["error"]) == (
        "unknown",
        "interrupted",
    )
    assert not (images_of(settings) / f"{job_id}.png").exists()


def test_a_newer_report_of_a_device_wins_over_the_server(client, make_device, clock):
    """Die jüngste Meldung gilt: Meldet ein Gerät mit späterem Zeitpunkt, schreibt der Server nicht darüber."""
    device = make_device()
    printer_id = add_printer(device)
    job_id = request_label(device, printer_id)
    # Das Gerät meldet „gedruckt" für einen Zeitpunkt in einer Minute (seine Uhr geht nicht vor:
    # Die Serveruhr steht, der Befehl ist jünger als alles, was der Server bisher schreibt).
    clock.advance(60)
    report = device.cmd("print.report", job_id=job_id, state="printed", printer_id=printer_id)
    assert statuses(device.sync([report])) == [("applied", None)]
    clock.advance(-60)
    response = submit(device, job_id, job_body(device, printer_id))
    # Das Etikett war nicht mehr ausstehend.
    assert (response.status_code, error_code(response)) == (409, "not_pending")

    second = request_label(device, printer_id, "Zweites")
    state = client.app.state.printing
    job = submit(device, second, job_body(device, printer_id, "Zweites")).json()
    assert job["state"] == "printed"
    clock.advance(30)
    late = device.cmd("print.report", job_id=second, state="unknown", printer_id=printer_id, error="handoff")
    assert statuses(device.sync([late])) == [("applied", None)]
    clock.advance(-60)
    # Eine Meldung des Servers mit älterem Zeitpunkt verliert.
    assert state.record_job(Job(second, JobState.PRINTED, printer_id, job["boot_id"], None, None)) is False
    device.sync()
    assert (device.print_jobs[second]["state"], device.print_jobs[second]["error"]) == ("unknown", "handoff")


def test_failures_end_as_failed_with_the_code_of_the_printer(client, make_device, settings):
    device = make_device()
    printer_id = add_printer(device)
    job_id = request_label(device, printer_id)
    (images_of(settings) / "simulate.txt").write_text("fail:cover_open", encoding="utf-8")
    job = submit(device, job_id, job_body(device, printer_id)).json()
    assert (job["state"], job["error"]["code"]) == ("failed", "cover_open")
    device.sync()
    assert (device.print_jobs[job_id]["state"], device.print_jobs[job_id]["error"]) == (
        "failed",
        "cover_open",
    )


def test_cancelling_a_waiting_job_at_the_service(client, make_device, settings):
    device = make_device()
    printer_id = add_printer(device)
    first, second = request_label(device, printer_id, "Eins"), request_label(device, printer_id, "Zwei")
    simulate = images_of(settings) / "simulate.txt"
    simulate.write_text("hang", encoding="utf-8")
    try:
        assert submit(device, first, job_body(device, printer_id, "Eins"), wait=0).status_code == 201
        assert (
            submit(device, second, job_body(device, printer_id, "Zwei"), wait=0).json()["state"] == "queued"
        )
        response = client.post(f"/print/v1/jobs/{second}/cancel", json={}, headers=device.headers)
        assert response.status_code == 200
        assert (response.json()["state"], response.json()["error"]["code"]) == ("failed", "cancelled")
        wait_until(
            lambda: (
                client.get(f"/print/v1/jobs/{first}", headers=device.headers).json()["state"] == "printing"
            )
        )
        response = client.delete(f"/print/v1/jobs/{first}", headers=device.headers)
        assert (response.status_code, error_code(response)) == (409, "not_cancellable")
    finally:
        simulate.unlink()
    assert client.get(f"/print/v1/jobs/{first}?wait=10", headers=device.headers).json()["state"] == "printed"
    device.sync()
    assert (device.print_jobs[second]["state"], device.print_jobs[second]["error"]) == ("failed", "cancelled")
    assert [path.name for path in images_of(settings).glob("*.png")] == [f"{first}.png"]


# --- Drucker aus dem Bestand -------------------------------------------------------------


def test_printers_come_from_the_sync_and_changes_apply_at_once(client, make_device):
    device = make_device()
    assert client.get("/print/v1/printers", headers=device.headers).json() == {"printers": []}
    first = add_printer(device, "Bild")
    second = add_printer(device, "Küche", UNUSABLE)
    direct = ids.new_uuid()
    pi = device.cmd(
        "printer.create",
        printer_id=direct,
        name="Pi",
        connection="direct",
        direct={"urls": ["http://10.71.83.1:8080"], "token": "pi-token-1234567890", "printer": None},
    )
    assert statuses(device.sync([pi])) == [("applied", None)]

    printers = client.get("/print/v1/printers", headers=device.headers).json()["printers"]
    # Nur Drucker am Server, in der Reihenfolge ihres Anlegens, unter ihrer Kennung.
    assert [(p["name"], p["driver"], p["model"]) for p in printers] == [
        (first, "image", None),
        (second, "brother_ql", "QL-9999"),
    ]
    assert printers[0]["status"] == {"reachable": True, "ready": True, "media_detected": True, "errors": []}
    assert printers[1]["status"] == {
        "reachable": False,
        "ready": None,
        "media_detected": None,
        "errors": ["config"],
    }
    assert printers[1]["capabilities"]["media"] == {"width_mm": 62.0, "length_mm": None, "printable_px": 696}

    # Ein Auftrag an den unbrauchbaren Drucker wird angenommen und endet als failed/config.
    job_id = request_label(device, second)
    job = submit(device, job_id, job_body(device, second)).json()
    assert (job["state"], job["error"]["code"]) == ("failed", "config")

    # Ändern: Der Drucker wird zum Bild-Treiber, ohne Neustart.
    change = device.cmd("printer.update", printer_id=second, changes={"server": IMAGE})
    assert statuses(device.sync([change])) == [("applied", None)]
    printers = client.get("/print/v1/printers", headers=device.headers).json()["printers"]
    assert printers[1]["driver"] == "image" and printers[1]["status"]["errors"] == []
    job_id = request_label(device, second)
    assert submit(device, job_id, job_body(device, second)).json()["state"] == "printed"

    # Löschen: weg aus der Liste, ein Auftrag an ihn ist unknown_printer.
    assert statuses(device.sync([device.cmd("printer.delete", printer_id=second)])) == [("applied", None)]
    printers = client.get("/print/v1/printers", headers=device.headers).json()["printers"]
    assert [p["name"] for p in printers] == [first]
    job_id = request_label(device)
    response = submit(device, job_id, job_body(device, second))
    assert (response.status_code, error_code(response)) == (404, "unknown_printer")
    assert client.get("/print/v1/health", headers=device.headers).json()["printers"] == printers


def test_preview_without_printer_uses_the_default_of_the_contract(client, make_device):
    device = make_device()
    body = job_body(device, None)
    response = client.post(
        "/print/v1/render", json={"template": body["template"], "data": body["data"]}, headers=device.headers
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    with Image.open(io.BytesIO(response.content)) as preview:
        assert (preview.size, preview.mode) == ((696, 342), "1")


# --- Zustand der Drucker -----------------------------------------------------------------


class Monotonic:
    def __init__(self) -> None:
        self.value = 1000.0

    def __call__(self) -> float:
        return self.value


def test_printer_status_is_written_and_throttled(client, make_device, settings, monkeypatch):
    ticks = Monotonic()
    monkeypatch.setattr(printing, "monotonic", ticks)
    kitchen, other = make_device("Küche"), make_device("Zweites")
    printer_id = add_printer(kitchen)
    service = client.app.state.printing.service

    def row():
        con = db.connect(settings.database_path)
        try:
            return con.execute("SELECT * FROM printer_status WHERE printer_id = ?", (printer_id,)).fetchone()
        finally:
            con.close()

    # Eine Abfrage durch eine App schreibt den Zustand.
    assert row() is None
    client.get("/print/v1/health", headers=kitchen.headers)
    first = row()
    assert first is not None
    assert (first["device_id"], first["boot_id"], first["host"]) == (None, service.boot_id, None)
    other.sync()
    status = other.printer_status[printer_id]
    assert status["status"] == {"reachable": True, "ready": True, "media_detected": True, "errors": []}
    assert (status["boot_id"], status["host"]) == (service.boot_id, None)

    # Unverändert und binnen einer Minute: nicht noch einmal.
    service.printers(fresh=True)
    ticks.value += 59
    service.printers(fresh=True)
    assert row()["rev"] == first["rev"]
    # Geändert: sofort.
    (images_of(settings) / "simulate.txt").write_text("fail:no_media", encoding="utf-8")
    service.printers(fresh=True)
    changed = row()
    assert changed["rev"] > first["rev"]
    other.sync()
    assert other.printer_status[printer_id]["status"]["errors"] == ["no_media"]
    # Nach einer Minute auch unverändert wieder.
    service.printers(fresh=True)
    assert row()["rev"] == changed["rev"]
    ticks.value += 61
    service.printers(fresh=True)
    assert row()["rev"] > changed["rev"]

    # Nach jedem Auftrag wird der Drucker frisch abgefragt (hier: wieder bereit, also geändert).
    (images_of(settings) / "simulate.txt").unlink()
    before = row()["rev"]
    job_id = request_label(kitchen, printer_id)
    assert submit(kitchen, job_id, job_body(kitchen, printer_id)).json()["state"] == "printed"
    wait_until(
        lambda: row()["rev"] > before and row()["status"] is not None and '"errors":[]' in row()["status"]
    )


# --- Neustart ----------------------------------------------------------------------------


def test_restart_keeps_boot_id_continues_waiting_jobs_and_never_reprints(settings, clock):
    simulate = images_of(settings) / "simulate.txt"
    with TestClient(create_app(settings)) as client:
        device = Device(client, "Handy", clock=clock)
        device.sync()
        printer_id = add_printer(device)
        printing_job = request_label(device, printer_id, "Eins")
        waiting_job = request_label(device, printer_id, "Zwei")
        boot_id = client.get("/print/v1/health", headers=device.headers).json()["boot_id"]
        simulate.write_text("hang", encoding="utf-8")
        assert submit(device, printing_job, job_body(device, printer_id, "Eins"), wait=0).status_code == 201
        wait_until(
            lambda: (
                client.get(f"/print/v1/jobs/{printing_job}", headers=device.headers).json()["state"]
                == "printing"
            )
        )
        assert (
            submit(device, waiting_job, job_body(device, printer_id, "Zwei"), wait=0).json()["state"]
            == "queued"
        )
        token = device.token
    # Der Server ist beendet, während der Druck hing. Der hängende Druck bricht danach ab.
    simulate.write_text("abort", encoding="utf-8")
    wait_until(lambda: not any(t.name == f"stowly-print-{printer_id}" for t in threading.enumerate()))
    simulate.unlink()

    with TestClient(create_app(settings)) as client:
        device.client = client
        assert device.token == token
        health = client.get("/print/v1/health", headers=device.headers).json()
        # Der Auftragsspeicher liegt in einer Datei: dieselbe boot_id.
        assert health["boot_id"] == boot_id
        interrupted = client.get(f"/print/v1/jobs/{printing_job}", headers=device.headers).json()
        assert (interrupted["state"], interrupted["error"]["code"]) == ("unknown", "interrupted")
        assert (
            client.get(f"/print/v1/jobs/{waiting_job}?wait=10", headers=device.headers).json()["state"]
            == "printed"
        )
        # Der unterbrochene Auftrag wird nie von selbst wiederholt, auch nicht auf Nachfrage.
        again = submit(device, printing_job, job_body(device, printer_id, "Eins", expect_boot_id=boot_id))
        assert (again.status_code, again.json()["state"]) == (200, "unknown")
        device.sync()
        assert (device.print_jobs[printing_job]["state"], device.print_jobs[printing_job]["error"]) == (
            "unknown",
            "interrupted",
        )
        assert device.print_jobs[waiting_job]["state"] == "printed"
    assert sorted(path.name for path in images_of(settings).glob("*.png")) == [f"{waiting_job}.png"]


def test_print_store_and_images_live_in_the_data_directory(client, make_device, settings):
    device = make_device()
    printer_id = add_printer(device)
    job_id = request_label(device, printer_id)
    submit(device, job_id, job_body(device, printer_id))
    assert (settings.data_dir / "print" / "jobs.sqlite3").is_file()
    assert (settings.data_dir / "print" / "images" / f"{job_id}.png").is_file()


def test_old_images_are_cleaned_up_at_start(settings, monkeypatch):
    images = images_of(settings)
    images.mkdir(parents=True)
    now = time.time()
    for number in range(5):
        path = images / f"alt-{number}.png"
        path.write_bytes(b"x")
        age = printing.IMAGE_MAX_AGE_S + 3600 if number < 2 else 60 * number
        os.utime(path, (now - age, now - age))
    monkeypatch.setattr(printing, "IMAGE_KEEP", 2)
    with TestClient(create_app(settings)):
        pass
    # Zu alt sind zwei, und von den übrigen bleiben nur die zwei jüngsten.
    assert sorted(path.name for path in images.glob("*.png")) == ["alt-2.png", "alt-3.png"]


def test_without_a_running_service_print_answers_503(settings, tmp_path):
    # Ohne lifespan läuft kein Dienst: Die App lässt ihre Etiketten dann ausstehen.
    client = TestClient(create_app(settings))
    response = client.get("/print/v1/health")
    assert (response.status_code, error_code(response)) == (503, "queue_full")


def test_a_print_store_that_cannot_be_opened_leaves_the_rest_of_the_server_running(settings, caplog):
    blocker = settings.data_dir / "print"
    blocker.parent.mkdir(parents=True, exist_ok=True)
    blocker.write_text("kein Verzeichnis", encoding="utf-8")
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/health").status_code == 200
        response = client.get("/print/v1/health")
        assert (response.status_code, error_code(response)) == (503, "queue_full")
        assert "nicht verfügbar" in response.json()["error"]["message"]
    assert any("Druckdienst" in record.getMessage() for record in caplog.records)


@pytest.mark.parametrize("state", list(JobState))
def test_every_state_of_the_service_is_a_state_of_the_label(state):
    # Der Server schreibt den Zustand des Dienstes unverändert ins Etikett.
    assert PrintJobState(state.value).value == state.value
