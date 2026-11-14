"""Der Sync-Aufruf: Rahmen, Protokollversion, höchstens einmal, ungültige Befehle.

docs/sync-protokoll.md, Abschnitte 6.1 bis 6.5.
"""

import json
import sqlite3
import threading

import pytest
from fastapi.testclient import TestClient
from support import EAN_A, Device, events_of, statuses

from stowly.app import create_app
from stowly.contract import ID_POOL_TARGET, PROTOCOL_VERSION, ids, timeutil
from stowly.contract.sync import SyncResponse
from stowly.sync import handlers
from stowly.sync.service import database_is_failing

# --- Antwort und Rahmen ------------------------------------------------------------------


def test_first_sync_delivers_the_whole_stock(make_device, con):
    device = make_device(sync=False)
    data = device.sync()

    SyncResponse.model_validate(data)  # die Antwort entspricht dem Vertrag
    assert data["protocol"] == PROTOCOL_VERSION
    assert data["dataset_id"] == con.execute("SELECT value FROM meta WHERE key = 'dataset_id'").fetchone()[0]
    assert timeutil.is_timestamp(data["server_time"])
    assert data["results"] == []
    # Auch der erste Sync ist ein vollständiger Abzug: Die dataset_id der Anfrage ist null.
    assert data["reset"] is True
    assert data["has_more"] is False
    assert data["cursor"] == con.execute("SELECT value FROM counters WHERE name = 'rev'").fetchone()[0]

    changes = data["changes"]
    assert [zone["name"] for zone in changes["zones"]] == ["Vorrat"]
    assert changes["settings"] == {
        "zone_mode": "primary",
        "primary_zone_id": changes["zones"][0]["id"],
        "warn_days": 14,
        "trash_retention_days": 30,
        "default_printer_id": None,
        "notify_time": "17:00",
        "updated_at": changes["settings"]["updated_at"],
    }
    assert changes["shopping_items"] == []
    assert {template["key"] for template in changes["label_templates"]} == {"package", "zone"}
    assert changes["products"] == changes["packages"] == changes["printers"] == []


def test_response_is_never_cached(make_device):
    device = make_device(sync=False)
    response = device.post()
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["content-type"] == "application/json"


def test_protocol_mismatch_is_409_before_anything_else(make_device):
    device = make_device()
    # Eine App von Stufe 1 spricht Protokoll 1.
    response = device.post(protocol=1)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "protocol_mismatch"
    assert response.json()["error"]["details"] == {"server": PROTOCOL_VERSION, "client": 1}

    # Die Version zählt vor dem Rest des Rahmens: Eine neuere App darf andere Felder schicken.
    bare = device.client.post("/api/sync", json={"protocol": 7, "neu": True}, headers=device.headers)
    assert bare.status_code == 409
    assert bare.json()["error"]["details"] == {"server": PROTOCOL_VERSION, "client": 7}


def test_protocol_mismatch_changes_nothing(make_device, con):
    device = make_device()
    product_id, create = device.product()
    assert device.post([create], protocol=1).status_code == 409
    assert con.execute("SELECT COUNT(*) FROM products").fetchone()[0] == 0
    assert con.execute("SELECT COUNT(*) FROM commands").fetchone()[0] == 0
    # Die Outbox bleibt erhalten: Nach dem Aktualisieren geht derselbe Befehl durch.
    assert statuses(device.sync([create])) == [("applied", None)]


@pytest.mark.parametrize(
    "overrides, location",
    [
        ({"cursor": -1}, ["body", "cursor"]),
        ({"cursor": "viel"}, ["body", "cursor"]),
        ({"dataset_id": "kein-uuid"}, ["body", "dataset_id"]),
        ({"sent_at": "2026-11-13T10:15:30Z"}, ["body", "sent_at"]),
        ({"sent_at": "2026-13-01T00:00:00.000Z"}, ["body", "sent_at"]),
        ({"id_pool": {"have": -1}}, ["body", "id_pool", "have"]),
        ({"id_pool": None}, ["body", "id_pool"]),
        ({"commands": {}}, ["body", "commands"]),
        ({"commands": ["kein Objekt"]}, ["body", "commands", "0"]),
        ({"protocol": "eins"}, ["body", "protocol"]),
        ({"unbekannt": 1}, ["body", "unbekannt"]),
        ({"app_version": "x" * 41}, ["body", "app_version"]),
    ],
)
def test_a_broken_frame_is_422(make_device, overrides, location):
    device = make_device()
    response = device.post(**overrides)
    assert response.status_code == 422, response.text
    error = response.json()["error"]
    assert error["code"] == "invalid_request"
    assert location in [problem["loc"] for problem in error["details"]["errors"]]
    for problem in error["details"]["errors"]:
        assert set(problem) == {"loc", "msg", "type"}


def test_missing_fields_and_non_json_are_422(make_device):
    device = make_device()
    for field in ("protocol", "dataset_id", "cursor", "sent_at", "commands", "id_pool"):
        body = device.request()
        del body[field]
        response = device.client.post("/api/sync", json=body, headers=device.headers)
        assert response.status_code == 422, field
        assert ["body", field] in [p["loc"] for p in response.json()["error"]["details"]["errors"]]

    for content in (b"kein json", b"[1, 2]", b"", b"\xff\xfe"):
        response = device.client.post(
            "/api/sync", content=content, headers={**device.headers, "Content-Type": "application/json"}
        )
        assert response.status_code == 422, content
        assert response.json()["error"]["code"] == "invalid_request"


def test_a_command_without_a_valid_id_fails_the_whole_request(make_device, con):
    device = make_device()
    _, good = device.product("Reis")
    for broken_id in ("x", None, 5, ids.new_uuid().upper()):
        bad = device.cmd("zone.create", zone_id=ids.new_uuid(), name="Keller")
        bad["id"] = broken_id
        response = device.post([good, bad])
        assert response.status_code == 422, broken_id
        problems = response.json()["error"]["details"]["errors"]
        assert problems[0]["loc"] == ["body", "commands", "1", "id"]
    missing = device.cmd("zone.create", zone_id=ids.new_uuid(), name="Keller")
    del missing["id"]
    assert device.post([good, missing]).status_code == 422
    # Nichts davon wurde verbucht, auch der gültige Befehl daneben nicht.
    assert con.execute("SELECT COUNT(*) FROM products").fetchone()[0] == 0
    assert con.execute("SELECT COUNT(*) FROM commands").fetchone()[0] == 0


def test_more_than_500_commands_is_413(make_device, con):
    device = make_device()
    commands = [device.cmd("zone.create", zone_id=ids.new_uuid(), name=f"Zone {n}") for n in range(501)]
    response = device.post(commands)
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "payload_too_large"
    assert con.execute("SELECT COUNT(*) FROM zones").fetchone()[0] == 1

    data = device.sync(commands[:500])
    assert len(data["results"]) == 500
    assert {result["status"] for result in data["results"]} == {"applied"}
    assert con.execute("SELECT COUNT(*) FROM zones").fetchone()[0] == 501


def test_an_oversized_body_is_413(make_device, monkeypatch):
    device = make_device()
    monkeypatch.setattr("stowly.api.sync.MAX_BODY_BYTES", 2000)
    response = device.post(app_version=None, commands=[device.cmd("zone.create", name="x" * 60)] * 40)
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "payload_too_large"
    assert device.post().status_code == 200


# --- Höchstens einmal --------------------------------------------------------------------


def test_the_same_command_twice_in_one_request_runs_once(make_device, con):
    device = make_device()
    product_id, create = device.product("Reis")
    data = device.sync([create, create])
    assert [(r["id"], r["status"], r["duplicate"]) for r in data["results"]] == [
        (create["id"], "applied", False),
        (create["id"], "applied", True),
    ]
    assert con.execute("SELECT COUNT(*) FROM products").fetchone()[0] == 1
    assert con.execute("SELECT COUNT(*) FROM events WHERE type = 'product.created'").fetchone()[0] == 1


def test_the_same_command_in_two_requests_runs_once(make_device, con):
    device = make_device()
    product_id, create = device.product("Reis")
    package_id, store = device.package(product_id)
    first = device.sync([create, store])
    assert [r["duplicate"] for r in first["results"]] == [False, False]

    # Die Antwort ging verloren: Das Gerät schickt dieselbe Outbox noch einmal, mit altem cursor.
    again = device.sync([create, store], cursor=0)
    assert [(r["status"], r["code"], r["duplicate"]) for r in again["results"]] == [
        ("applied", None, True),
        ("applied", None, True),
    ]
    assert con.execute("SELECT COUNT(*) FROM packages").fetchone()[0] == 1
    assert con.execute("SELECT COUNT(*) FROM commands").fetchone()[0] == 2
    # Die Wirkung steckt trotzdem in der Antwort: Geliefert wird alles nach dem cursor.
    assert [package["id"] for package in again["changes"]["packages"]] == [package_id]


def test_a_rejected_result_is_remembered_too(make_device, con):
    device = make_device()
    missing = device.cmd("package.remove", package_id="A2B3C", reason="consumed")
    first = device.sync([missing])
    assert first["results"] == [
        {
            "id": missing["id"],
            "status": "rejected",
            "code": "not_found",
            "message": "Die Packung gibt es nicht.",
            "duplicate": False,
        }
    ]

    # Inzwischen gibt es die Packung. Der alte Befehl bleibt trotzdem abgelehnt.
    product_id, create = device.product()
    _, store = device.package(product_id, package_id="A2B3C")
    device.sync([create, store])
    second = device.sync([missing])
    assert second["results"] == [{**first["results"][0], "duplicate": True}]
    assert device.packages["A2B3C"]["removed_at"] is None

    invalid = {"id": ids.new_uuid(), "at": device.stamp(), "type": "gibt.es.nicht"}
    assert statuses(device.sync([invalid])) == [("rejected", "invalid")]
    repeated = device.sync([invalid])["results"][0]
    assert (repeated["status"], repeated["code"], repeated["duplicate"]) == ("rejected", "invalid", True)


def test_another_device_cannot_run_a_known_command_again(make_device, con):
    first, second = make_device("Handy"), make_device("Tablet")
    product_id, create = first.product("Reis")
    first.sync([create])
    data = second.sync([create])
    assert data["results"][0]["duplicate"] is True
    assert con.execute("SELECT device_id FROM commands").fetchone()[0] == first.id


def test_commands_are_stored_as_received(make_device, con, clock):
    device = make_device()
    product_id, create = device.product("Reis", age=90)
    device.sync([create])
    row = con.execute("SELECT * FROM commands WHERE id = ?", (create["id"],)).fetchone()
    assert json.loads(row["body"]) == create
    assert row["type"] == "product.create"
    assert row["device_id"] == device.id
    assert row["status"] == "applied" and row["code"] is None and row["message"] is None
    assert row["at"] == clock.stamp(age_s=90)  # der wirksame Zeitpunkt, nicht die Geräteuhr
    assert row["received_at"] == clock.stamp()


# --- Ungültige und fehlschlagende Befehle ------------------------------------------------


def test_one_broken_command_between_valid_ones(make_device, con):
    device = make_device()
    product_id, create = device.product("Reis")
    broken = device.cmd("package.create", package_id="A2B3U", product_id=product_id, zone_id=device.zone_id)
    package_id, store = device.package(product_id)
    data = device.sync([create, broken, store])

    assert statuses(data) == [("applied", None), ("rejected", "invalid"), ("applied", None)]
    assert [r["id"] for r in data["results"]] == [create["id"], broken["id"], store["id"]]
    assert data["results"][1]["message"].startswith("Der Befehl entspricht nicht dem Vertrag")
    assert list(device.products) == [product_id]
    assert list(device.packages) == [package_id]

    # Die Ablehnung steht im Ereignisprotokoll, bei der Art des Befehls.
    rejected = events_of(device.client, device, entity="package", entity_id="A2B3U")
    assert [(e["type"], e["command_id"], e["data"]["code"], e["data"]["type"]) for e in rejected] == [
        ("command.rejected", broken["id"], "invalid", "package.create")
    ]


@pytest.mark.parametrize(
    "mutate",
    [
        lambda command: command.update(type="package.fliegen"),
        lambda command: command.pop("type"),
        lambda command: command.update(type=7),
        lambda command: command.pop("reason"),
        lambda command: command.update(reason="verschenkt"),
        lambda command: command.update(zusatz=1),
        lambda command: command.update(package_id="a2b3c"),
        lambda command: command.pop("at"),
        lambda command: command.update(at="2026-11-13T10:15:30Z"),
        lambda command: command.update(at="2026-13-45T10:15:30.000Z"),
        lambda command: command.update(at=None),
    ],
)
def test_every_kind_of_invalid_command_is_rejected_not_failed(make_device, mutate):
    device = make_device()
    command = device.cmd("package.remove", package_id="A2B3C", reason="consumed")
    mutate(command)
    data = device.sync([command])
    assert statuses(data) == [("rejected", "invalid")]
    assert data["results"][0]["id"] == command["id"]


@pytest.mark.parametrize(
    "command",
    [
        {"type": "product.create", "product_id": ids.new_uuid(), "barcodes": ["4006381333932"]},
        {"type": "product.add_barcode", "product_id": ids.new_uuid(), "barcode": "96385075"},
        {
            "type": "package.create",
            "package_id": "A2B3C",
            "product_id": ids.new_uuid(),
            "zone_id": ids.new_uuid(),
            "best_before": "2027-02-30",
        },
        {"type": "package.update", "package_id": "A2B3C", "changes": {"best_before": "2027-13-01"}},
    ],
)
def test_values_that_only_look_right_are_invalid(make_device, command):
    """Falsche Prüfziffer und unmögliche Kalendertage passen auf das Muster, gelten aber nicht."""
    device = make_device()
    data = device.sync([{"id": ids.new_uuid(), "at": device.stamp(), **command}])
    assert statuses(data) == [("rejected", "invalid")]


def test_an_unexpected_error_rejects_only_that_command(make_device, con, monkeypatch, caplog):
    device = make_device()
    original = handlers._HANDLERS["zone.create"]

    def exploding(runner, command):
        if command.name == "Bumm":
            # Schreibt erst und scheitert dann: Der Sicherungspunkt muss das zurückrollen.
            original(runner, command)
            raise RuntimeError("absichtlich")
        return original(runner, command)

    monkeypatch.setitem(handlers._HANDLERS, "zone.create", exploding)
    zones = [ids.new_uuid() for _ in range(3)]
    commands = [
        device.cmd("zone.create", zone_id=zones[0], name="Keller"),
        device.cmd("zone.create", zone_id=zones[1], name="Bumm"),
        device.cmd("zone.create", zone_id=zones[2], name="Speisekammer"),
    ]
    data = device.sync(commands)

    assert statuses(data) == [("applied", None), ("rejected", "internal"), ("applied", None)]
    assert data["results"][1]["message"]
    assert zones[1] not in device.zones
    assert con.execute("SELECT COUNT(*) FROM zones WHERE id = ?", (zones[1],)).fetchone()[0] == 0
    assert (
        con.execute(
            "SELECT COUNT(*) FROM events WHERE entity_id = ? AND type = 'zone.created'", (zones[1],)
        ).fetchone()[0]
        == 0
    )
    assert "absichtlich" in caplog.text  # der Fehler steht im Server-Log
    # Auch dieses Ergebnis ist gespeichert: Der Befehl läuft nicht noch einmal.
    assert device.sync([commands[1]])["results"][0]["duplicate"] is True


def test_a_failing_database_fails_the_request_instead_of_dropping_commands(make_device, con, monkeypatch):
    """Platte voll oder E/A-Fehler ist kein Fehler eines Befehls: nichts verbuchen, später erneut."""
    device = make_device()

    def broken(runner, command):
        raise sqlite3.OperationalError("database or disk is full")

    monkeypatch.setitem(handlers._HANDLERS, "zone.create", broken)
    command = device.cmd("zone.create", zone_id=ids.new_uuid(), name="Keller")
    with pytest.raises(sqlite3.OperationalError):
        device.post([command])
    assert con.execute("SELECT COUNT(*) FROM commands").fetchone()[0] == 0


# --- Änderungsfolge ----------------------------------------------------------------------


def test_own_changes_come_back_in_the_same_response(make_device):
    device = make_device()
    cursor = device.cursor
    product_id, create = device.product("Reis", brand="Kornhaus", quantity="1 kg", barcodes=[EAN_A])
    package_id, store = device.package(product_id, best_before="2027-03-25")
    data = device.sync([create, store])

    assert data["reset"] is False
    assert data["cursor"] > cursor
    assert data["changes"]["products"] == [
        {
            "id": product_id,
            "name": "Reis",
            "brand": "Kornhaus",
            "quantity": "1 kg",
            "image": None,
            "warn_days": None,
            "min_stock": None,
            "lookup": "none",  # Open Food Facts ist in den Tests abgeschaltet
            "barcodes": [EAN_A],
            "created_at": create["at"],
            "updated_at": create["at"],
            "deleted_at": None,
            "merged_into": None,
        }
    ]
    assert data["changes"]["packages"] == [
        {
            "id": package_id,
            "product_id": product_id,
            "zone_id": device.zone_id,
            "best_before": "2027-03-25",
            "created_at": store["at"],
            "updated_at": store["at"],
            "removed_at": None,
            "removal_reason": None,
            "displaced": None,
        }
    ]
    assert data["changes"]["zones"] == []
    assert data["changes"]["settings"] is None

    # Danach ist alles abgeholt.
    quiet = device.sync()
    assert quiet["cursor"] == data["cursor"]
    assert all(not value for value in quiet["changes"].values())


def test_a_second_device_gets_the_changes(make_device):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    product_id, package_id = phone.store("Reis")
    data = tablet.sync()
    assert [product["id"] for product in data["changes"]["products"]] == [product_id]
    assert [package["id"] for package in data["changes"]["packages"]] == [package_id]
    assert tablet.packages[package_id] == phone.packages[package_id]
    assert data["results"] == []
    assert data["changes"]["settings"] is None


def test_settings_are_null_unless_changed(make_device):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    assert phone.sync()["changes"]["settings"] is None

    data = phone.sync([phone.cmd("settings.update", changes={"warn_days": 21})])
    assert data["changes"]["settings"]["warn_days"] == 21
    assert phone.sync()["changes"]["settings"] is None
    assert tablet.sync()["changes"]["settings"]["warn_days"] == 21
    assert tablet.sync()["changes"]["settings"] is None


def test_reset_on_foreign_dataset_id(make_device):
    device = make_device()
    device.store("Reis")
    data = device.sync(dataset_id=ids.new_uuid())
    assert data["reset"] is True
    assert len(data["changes"]["products"]) == 1 and len(data["changes"]["packages"]) == 1
    assert len(data["changes"]["zones"]) == 1 and data["changes"]["settings"] is not None
    # Ein vollständiger Abzug bringt auch einen vollständigen ID-Vorrat mit.
    assert len(data["id_pool"]["grant"]) == ID_POOL_TARGET
    assert device.sync()["reset"] is False


def test_reset_when_the_cursor_is_ahead_of_the_server(make_device):
    device = make_device()
    device.store("Reis")
    stand = device.cursor
    data = device.sync(cursor=stand + 1)
    assert data["reset"] is True
    assert data["cursor"] == stand
    assert len(data["changes"]["packages"]) == 1
    # Genau auf dem Stand ist kein Grund für einen Abzug.
    assert device.sync(cursor=stand)["reset"] is False


def test_commands_still_run_when_the_response_is_a_reset(make_device):
    """Nach dem Einspielen einer Sicherung senden die Geräte ihre Outbox erneut."""
    device = make_device()
    product_id, create = device.product("Reis")
    data = device.sync([create], dataset_id=None, cursor=0)
    assert data["reset"] is True
    assert statuses(data) == [("applied", None)]
    assert [product["id"] for product in data["changes"]["products"]] == [product_id]


def test_app_version_is_optional(make_device):
    device = make_device()
    assert device.post(app_version="0.1.0").status_code == 200
    body = device.request()
    assert "app_version" not in body
    assert device.client.post("/api/sync", json=body, headers=device.headers).status_code == 200


def test_login_then_first_sync_of_a_fresh_device(client):
    """Ohne angehaltene Uhr und ohne Hilfen: der Ablauf, wie ihn die App fährt."""
    device = Device(client, "Handy")
    data = device.sync()
    assert data["reset"] is True
    assert len(device.pool) == ID_POOL_TARGET
    assert device.settings is not None and device.zones


def test_a_failing_database_answers_500_in_the_error_format(settings, clock, monkeypatch):
    """Dieselbe Lage aus Sicht der App: 5xx heißt „später erneut", die Outbox bleibt."""
    with TestClient(create_app(settings), raise_server_exceptions=False) as client:
        device = Device(client, clock=clock)
        device.sync()
        command = device.cmd("zone.create", zone_id=ids.new_uuid(), name="Keller")

        def broken(runner, _command):
            raise sqlite3.OperationalError("disk I/O error")

        with monkeypatch.context() as patch:
            patch.setitem(handlers._HANDLERS, "zone.create", broken)
            response = device.post([command])
        assert response.status_code == 500
        assert response.json() == {
            "error": {"code": "internal", "message": "Interner Fehler des Servers.", "details": None}
        }
        # Sobald die Datenbank wieder schreibt, geht derselbe Befehl durch.
        assert statuses(device.sync([command])) == [("applied", None)]


@pytest.mark.allow_contract_violation
def test_a_response_that_breaks_the_contract_is_logged_but_still_delivered(make_device, con, caplog):
    """Darf nicht vorkommen. Käme es doch dazu, blieben mit einem 500 alle Geräte für immer stecken."""
    device = make_device()
    product_id, create = device.product("Reis")
    device.sync([create])
    with con:
        con.execute(
            "UPDATE products SET name = ? WHERE id = ?", ("x" * 500, product_id)
        )  # länger als erlaubt
        con.execute("UPDATE products SET rev = (SELECT value + 1 FROM counters WHERE name = 'rev')")
        con.execute("UPDATE counters SET value = value + 1 WHERE name = 'rev'")

    command = device.cmd("zone.create", zone_id=ids.new_uuid(), name="Keller")
    data = device.sync([command])
    assert statuses(data) == [("applied", None)]
    assert data["changes"]["products"][0]["name"] == "x" * 500
    assert "verletzt den Vertrag" in caplog.text


# --- Kaputte Zeichenketten ---------------------------------------------------------------
#
# JavaScript-Zeichenketten können halbe Zeichen enthalten (ein einzelnes Surrogat, etwa wenn
# ein Emoji beim Kürzen durchgeschnitten wurde). JSON.stringify schickt sie als "\\ud83d".
# So etwas ist ungültig, darf aber nie mehr auslösen als ein abgelehnter Befehl: Mit einem
# 500 bliebe die Outbox des Geräts für immer stecken.

HALF = "\ud83d"  # die erste Hälfte eines Emojis


def post_raw(device, body: dict):
    """Schickt den Rumpf so, wie JSON.stringify ihn schriebe (halbe Zeichen als Escape)."""
    return device.client.post(
        "/api/sync",
        content=json.dumps(body).encode("ascii"),
        headers={**device.headers, "Content-Type": "application/json"},
    )


@pytest.mark.parametrize(
    "mutate",
    [
        lambda command: command.update(name="Reis " + HALF),
        lambda command: command.update(type="product." + HALF),
        lambda command: command.update({"feld" + HALF: 1}),
        lambda command: command.update(product_id=HALF * 20),
        lambda command: command.update(at=HALF),
        lambda command: command.update(barcodes=[HALF]),
    ],
)
def test_half_characters_reject_the_command_but_never_fail_the_request(make_device, con, mutate):
    device = make_device()
    good_id, good = device.product("Nudeln")
    broken_id, broken = device.product("Reis")
    mutate(broken)
    response = post_raw(device, device.request([broken, good]))
    assert response.status_code == 200, response.text
    data = response.json()
    assert statuses(data) == [("rejected", "invalid"), ("applied", None)]
    assert data["results"][0]["message"]

    # Das Ergebnis ist gespeichert, der Befehl bleibt nachvollziehbar, und er läuft nie wieder.
    stored = con.execute("SELECT body, type FROM commands WHERE id = ?", (broken["id"],)).fetchone()
    assert json.loads(stored["body"]) == broken
    again = post_raw(device, device.request([broken]))
    assert again.status_code == 200
    assert again.json()["results"][0]["duplicate"] is True
    assert events_of(device.client, device, entity="product")  # das Protokoll bleibt lesbar


def test_half_characters_in_the_frame_are_422_not_500(make_device):
    device = make_device()
    for body in (
        device.request(app_version=HALF),
        {**device.request(), "feld" + HALF: 1},
        device.request(dataset_id=HALF),
    ):
        response = post_raw(device, body)
        assert response.status_code == 422, response.text
        assert response.json()["error"]["code"] == "invalid_request"


def test_half_characters_at_login_are_422_not_500(client):
    for body in (
        {"password": "test-passwort", "device_name": "Handy " + HALF},
        {"password": HALF, "device_name": "Handy"},
        {"password": "test-passwort", "device_name": "Handy", "feld" + HALF: 1},
    ):
        response = client.post(
            "/api/auth/login",
            content=json.dumps(body).encode("ascii"),
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 422, response.text
        assert response.json()["error"]["code"] == "invalid_request"


@pytest.mark.parametrize("depth", [40, 2_000, 100_000])
def test_absurdly_nested_json_is_422(make_device, depth):
    device = make_device()
    body = json.dumps(device.request())[:-1] + ', "x": ' + "[" * depth + "]" * depth + "}"
    response = device.client.post(
        "/api/sync", content=body.encode(), headers={**device.headers, "Content-Type": "application/json"}
    )
    assert response.status_code == 422
    assert response.json()["error"]["details"]["errors"][0]["type"] == "json_invalid"
    assert device.post().status_code == 200


def test_devices_syncing_at_the_same_time_do_not_trip_over_each_other(client):
    """Es gibt immer nur einen Schreiber; die anderen warten, statt zu scheitern."""
    devices = [Device(client, f"Gerät {number}") for number in range(4)]
    for device in devices:
        device.sync()
    failures: list[str] = []

    def work(device: Device) -> None:
        try:
            for round_ in range(12):
                product_id, create = device.product(f"Produkt {round_}")
                package_id, store = device.package(product_id)
                change = device.cmd("settings.update", changes={"warn_days": 10 + round_})
                data = device.sync([create, store, change])
                if statuses(data) != [("applied", None)] * 3:
                    failures.append(str(data["results"]))
        except Exception as exc:  # im Thread ginge die Ausnahme sonst unter
            failures.append(repr(exc))

    threads = [threading.Thread(target=work, args=(device,)) for device in devices]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)
    assert failures == []

    observer = Device(client, "Beobachter")
    observer.sync()
    assert len(observer.products) == len(observer.packages) == 4 * 12
    # Jede Packung genau einmal, jede mit eigener ID aus dem Vorrat ihres Geräts.
    assert len({package["id"] for package in observer.packages.values()}) == 48


def test_a_bug_in_a_statement_rejects_one_command_while_a_failing_database_fails_the_request(
    make_device, con, monkeypatch
):
    device = make_device()
    original = handlers._HANDLERS["zone.create"]

    def buggy(runner, command):
        if command.name == "Fehler im Programm":
            runner.con.execute("SELECT * FROM diese_tabelle_gibt_es_nicht")  # SQLITE_ERROR
        if command.name == "Platte voll":
            full = sqlite3.OperationalError("database or disk is full")
            full.sqlite_errorcode = 13  # SQLITE_FULL
            raise full
        return original(runner, command)

    monkeypatch.setitem(handlers._HANDLERS, "zone.create", buggy)
    good, bug, disk = (
        device.cmd("zone.create", zone_id=ids.new_uuid(), name=name)
        for name in ("Keller", "Fehler im Programm", "Platte voll")
    )
    # Ein Fehler im Programm trifft nur den einen Befehl ...
    assert statuses(device.sync([bug, good])) == [("rejected", "internal"), ("applied", None)]
    # ... eine streikende Datenbank lässt die ganze Anfrage scheitern, und nichts ist verbucht.
    extra = device.cmd("zone.create", zone_id=ids.new_uuid(), name="Speisekammer")
    with pytest.raises(sqlite3.OperationalError):
        device.post([extra, disk])
    assert con.execute("SELECT COUNT(*) FROM commands WHERE id = ?", (extra["id"],)).fetchone()[0] == 0
    assert con.execute("SELECT COUNT(*) FROM zones").fetchone()[0] == 2


def test_which_database_errors_count_as_a_failing_database(tmp_path):
    database = sqlite3.connect(tmp_path / "probe.sqlite3")
    database.execute("CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT NOT NULL) STRICT")

    def error_of(sql: str, *args) -> sqlite3.Error:
        with pytest.raises(sqlite3.Error) as caught:
            database.execute(sql, args)
        return caught.value

    # Fehler im Programm: nur der eine Befehl wird abgelehnt.
    assert not database_is_failing(error_of("SELECT * FROM gibt_es_nicht"))
    assert not database_is_failing(error_of("INSERT INTO t VALUES (1, NULL)"))
    assert not database_is_failing(error_of("INSERT INTO t VALUES ('x', 'y')"))
    assert not database_is_failing(error_of("INSERT INTO t VALUES (?, ?)", 1))
    assert not database_is_failing(RuntimeError("irgendetwas"))
    assert not database_is_failing(OverflowError("Python int too large to convert to SQLite INTEGER"))
    # Die Datenbank streikt: nichts verbuchen, später erneut.
    database.execute("PRAGMA max_page_count = 3")
    assert database_is_failing(error_of("INSERT INTO t VALUES (2, ?)", "x" * 100_000))
    assert database_is_failing(sqlite3.OperationalError("ohne Kennung"))
    database.close()


# --- Nach der unabhängigen Durchsicht ----------------------------------------------------


def test_reset_is_decided_before_the_commands_raise_the_revision(make_device, con):
    """Ein cursor, der dem Server voraus ist, bleibt es auch, wenn die Anfrage selbst Befehle bringt.

    So sieht es aus, wenn eine ältere Kopie der Datenbank mit gleicher Kennung zurückgespielt
    wurde: Das Gerät kennt einen Stand, den der Server nicht mehr hat.
    """
    device = make_device()
    device.store("Reis")
    stand = device.cursor
    zones = [device.cmd("zone.create", zone_id=ids.new_uuid(), name=f"Zone {n}") for n in range(5)]
    data = device.sync(zones, cursor=stand + 3)

    assert data["reset"] is True
    assert statuses(data) == [("applied", None)] * 5
    # Ein vollständiger Abzug: alle fünf neuen Zonen, die alte, das Produkt, die Packung.
    assert len(data["changes"]["zones"]) == 6
    assert len(data["changes"]["products"]) == len(data["changes"]["packages"]) == 1
    assert len(data["id_pool"]["grant"]) == ID_POOL_TARGET
    assert device.sync()["reset"] is False


@pytest.mark.parametrize(
    "at, sent_at",
    [
        ("0001-01-01T00:00:00.000Z", None),  # Geräteuhr stand bei der Änderung im Jahr 1
        (None, "9999-12-31T23:59:59.999Z"),  # Geräteuhr steht beim Absenden im Jahr 9999
        ("0001-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z"),
        ("0999-06-01T00:00:00.000Z", None),
    ],
)
def test_an_impossible_age_neither_fails_the_request_nor_loses_the_command(make_device, clock, at, sent_at):
    """Der wirksame Zeitpunkt ließe sich nicht darstellen. Der Befehl gilt trotzdem, mit der ältesten möglichen Zeit."""
    device = make_device()
    old_id, old = device.product("Uralt")
    if at is not None:
        old["at"] = at
    fresh_id, fresh = device.product("Frisch")
    overrides = {} if sent_at is None else {"sent_at": sent_at}
    data = device.sync([old, fresh], **overrides)

    assert statuses(data) == [("applied", None), ("applied", None)]
    assert device.products[old_id]["created_at"] == "2000-01-01T00:00:00.000Z"
    # Zeitstempel bleiben vierstellig im Jahr und damit als Text vergleichbar.
    assert timeutil.is_timestamp(device.products[old_id]["created_at"])
    if sent_at is None:
        assert device.products[fresh_id]["created_at"] == clock.stamp()
    assert device.sync([old])["results"][0]["duplicate"] is True


def test_an_impossible_age_on_an_invalid_command_is_harmless_too(make_device):
    device = make_device()
    broken = {"id": ids.new_uuid(), "at": "0001-01-01T00:00:00.000Z", "type": "gibt.es.nicht"}
    assert statuses(device.sync([broken])) == [("rejected", "invalid")]


@pytest.mark.parametrize("sort", [2**63, -(2**63) - 1, 10**30])
def test_a_sort_value_beyond_64_bit_is_invalid_not_internal(make_device, sort, caplog):
    device = make_device()
    zone_id = ids.new_uuid()
    data = device.sync(
        [
            device.cmd("zone.create", zone_id=ids.new_uuid(), name="Zu groß", sort=sort),
            device.cmd("zone.create", zone_id=zone_id, name="Grenze", sort=2**63 - 1),
            device.cmd("zone.update", zone_id=zone_id, changes={"sort": sort}),
        ]
    )
    assert statuses(data) == [("rejected", "invalid"), ("applied", None), ("rejected", "invalid")]
    assert device.zones[zone_id]["sort"] == 2**63 - 1
    assert "unerwartet fehlgeschlagen" not in caplog.text


FULLWIDTH_2027 = "\uff12\uff10\uff12\uff17"
FULLWIDTH_EAN = "".join(chr(0xFF10 + int(digit)) for digit in EAN_A)


@pytest.mark.parametrize(
    "command",
    [
        {"type": "product.create", "product_id": ids.new_uuid(), "barcodes": [FULLWIDTH_EAN]},
        {"type": "product.add_barcode", "product_id": ids.new_uuid(), "barcode": FULLWIDTH_EAN},
        {"type": "product.remove_barcode", "product_id": ids.new_uuid(), "barcode": FULLWIDTH_EAN},
        {
            "type": "package.update",
            "package_id": "A2B3C",
            "changes": {"best_before": FULLWIDTH_2027 + "-03-25"},
        },
        {"type": "package.restore", "package_id": "A2B3C", "at": FULLWIDTH_2027 + "-01-01T00:00:00.000Z"},
    ],
)
def test_digits_of_other_scripts_are_not_digits(make_device, con, command):
    """Sonst gäbe es denselben Barcode zweimal: einmal in ASCII, einmal in vollbreiten Ziffern."""
    device = make_device()
    payload = {"id": ids.new_uuid(), "at": device.stamp(), **command}
    assert statuses(device.sync([payload])) == [("rejected", "invalid")]
    assert con.execute("SELECT COUNT(*) FROM product_barcodes").fetchone()[0] == 0


def test_a_fullwidth_sent_at_is_422(make_device):
    device = make_device()
    response = device.post(sent_at=FULLWIDTH_2027 + "-01-01T00:00:00.000Z")
    assert response.status_code == 422


def test_a_command_id_with_a_trailing_newline_is_no_id(make_device):
    device = make_device()
    command = device.cmd("zone.create", zone_id=ids.new_uuid(), name="Keller")
    command["id"] += "\n"
    response = device.post([command])
    assert response.status_code == 422
    assert response.json()["error"]["details"]["errors"][0]["loc"] == ["body", "commands", "0", "id"]
