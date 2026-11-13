"""Anmeldung und Geräte (docs/sync-protokoll.md, Abschnitt 5)."""

import base64
import dataclasses
import hashlib
import json
import logging

import pytest
from fastapi.testclient import TestClient
from support import TEST_PASSWORD, Device, events_of

from stowly import auth
from stowly.app import create_app
from stowly.contract import ids, timeutil

ID = "3f2b8c1e-5a47-4d09-9b6e-0c1d2e3f4a5b"


def login(client: TestClient, password: str = TEST_PASSWORD, name: str = "Handy"):
    return client.post("/api/auth/login", json={"password": password, "device_name": name})


class FakeTime:
    def __init__(self) -> None:
        self.value = 1000.0

    def __call__(self) -> float:
        return self.value


# --- Anmelden ----------------------------------------------------------------------------


def test_login_creates_a_device_and_hands_out_the_token_once(client, con):
    response = login(client, name="Handy Küche")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    device = body["device"]
    assert ids.is_uuid(device["id"])
    assert device["name"] == "Handy Küche"
    assert device["current"] is True
    assert device["revoked_at"] is None
    assert device["last_seen_at"] is None
    assert timeutil.is_timestamp(device["created_at"])

    # 32 Zufallsbytes, URL-sicheres Base64 ohne Füllzeichen
    token = body["token"]
    assert "=" not in token
    assert len(base64.urlsafe_b64decode(token + "=")) == 32

    # Gespeichert ist nur der SHA-256 (hex), nie das Token.
    row = con.execute("SELECT * FROM devices WHERE id = ?", (device["id"],)).fetchone()
    assert row["token_hash"] == hashlib.sha256(token.encode()).hexdigest()
    dump = "\n".join(con.iterdump())
    assert token not in dump
    assert TEST_PASSWORD not in dump


def test_every_login_gets_its_own_token(client):
    first, second = login(client).json(), login(client).json()
    assert first["token"] != second["token"]
    assert first["device"]["id"] != second["device"]["id"]


def test_wrong_password_is_rejected(client):
    response = login(client, password="falsch")
    assert response.status_code == 401
    assert response.json()["error"] == {
        "code": "invalid_password",
        "message": "Das Passwort stimmt nicht.",
        "details": None,
    }
    # Ein richtiges Passwort mit anderer Schreibung oder Leerraum ist auch falsch.
    assert login(client, password=TEST_PASSWORD.upper()).status_code == 401
    assert login(client, password=TEST_PASSWORD + " ").status_code == 401


def test_without_a_password_on_the_server_nobody_can_log_in(settings):
    bare = dataclasses.replace(settings, password=None)
    with TestClient(create_app(bare)) as client:
        response = login(client, password="irgendwas")
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "not_configured"
        assert client.get("/api/health").json()["configured"] is False


def test_five_failures_lock_the_login_for_everyone(client):
    clock = FakeTime()
    client.app.state.login_guard.clock = clock

    for _ in range(4):
        assert login(client, password="falsch").status_code == 401
        clock.value += 10
    # Vier Fehlversuche sperren noch nicht: Das richtige Passwort geht durch und setzt zurück.
    assert login(client).status_code == 200

    for _ in range(5):
        assert login(client, password="falsch").status_code == 401
        clock.value += 10

    # Der fünfte Fehlversuch hat gesperrt: 60 Sekunden lang wird jede Anmeldung abgelehnt,
    # auch mit dem richtigen Passwort.
    clock.value += 5  # 15 Sekunden nach dem fünften Fehlversuch
    response = login(client)
    assert response.status_code == 429
    assert response.headers["retry-after"] == "45"
    error = response.json()["error"]
    assert error["code"] == "rate_limited"
    assert error["details"] == {"retry_after_s": 45}

    clock.value += 44
    assert login(client).status_code == 429
    assert login(client).headers["retry-after"] == "1"
    clock.value += 1
    assert login(client).status_code == 200


def test_failures_older_than_five_minutes_do_not_count(client):
    clock = FakeTime()
    client.app.state.login_guard.clock = clock
    for _ in range(4):
        assert login(client, password="falsch").status_code == 401
    clock.value += 301
    assert login(client, password="falsch").status_code == 401
    # Nur ein Fehlversuch im Fenster: keine Sperre.
    assert login(client).status_code == 200


def test_login_guard_keeps_counting_after_the_lock():
    clock = FakeTime()
    guard = auth.LoginGuard(clock=clock)
    for _ in range(5):
        assert guard.attempt(lambda: False) == (False, None)
    assert guard.attempt(lambda: True) == (False, 60)
    clock.value += 60
    # Die fünf Fehlversuche stehen noch im Fenster: Der nächste sperrt sofort wieder.
    assert guard.attempt(lambda: False) == (False, None)
    assert guard.attempt(lambda: True) == (False, 60)
    clock.value += 60
    assert guard.attempt(lambda: True) == (True, None)


def test_a_locked_login_does_not_even_check_the_password():
    clock = FakeTime()
    guard = auth.LoginGuard(clock=clock)
    for _ in range(5):
        guard.attempt(lambda: False)
    calls = []
    assert guard.attempt(lambda: calls.append(1) or True) == (False, 60)
    assert calls == []


def test_login_is_written_to_the_event_log_without_secrets(client, con):
    device = Device(client, "Tablet")
    events = events_of(client, device, entity="device")
    assert [event["type"] for event in events] == ["device.login"]
    assert events[0]["entity_id"] == device.id
    assert events[0]["device_id"] == device.id
    assert events[0]["data"] == {"name": "Tablet"}
    text = "\n".join(str(tuple(row)) for row in con.execute("SELECT * FROM events"))
    assert device.token not in text
    assert TEST_PASSWORD not in text


def test_neither_token_nor_password_reach_the_log(client, caplog):
    with caplog.at_level(logging.DEBUG):
        device = Device(client, "Handy")
        device.sync()
        login(client, password="streng-geheim-falsch")
        client.get("/api/devices", headers=device.headers)
    assert device.token not in caplog.text
    assert TEST_PASSWORD not in caplog.text
    assert "streng-geheim-falsch" not in caplog.text


# --- Token -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "method, path, body",
    [
        ("POST", "/api/auth/logout", None),
        ("GET", "/api/devices", None),
        ("PATCH", f"/api/devices/{ID}", {"name": "Neu"}),
        ("DELETE", f"/api/devices/{ID}", None),
        ("POST", "/api/sync", {}),
        ("GET", "/api/backup", None),
        ("GET", "/api/events", None),
    ],
)
def test_protected_endpoints_need_a_token(client, method, path, body):
    for headers in (
        {},
        {"Authorization": "Bearer unbekannt"},
        {"Authorization": "Basic dXNlcjpwYXNz"},
        {"Authorization": "Bearer"},
        {"Authorization": TEST_PASSWORD},
    ):
        response = client.request(method, path, json=body, headers=headers)
        assert response.status_code == 401, (method, path, headers, response.text)
        assert response.json()["error"]["code"] == "unauthorized"
        assert response.headers["www-authenticate"] == "Bearer"


def test_health_login_and_images_are_open(client):
    assert client.get("/api/health").status_code == 200
    assert login(client).status_code == 200
    # 404 und nicht 401: Bilder brauchen keine Anmeldung.
    assert client.get("/api/images/gibt-es-nicht.jpg").status_code == 404


def test_the_scheme_is_case_insensitive(client):
    device = Device(client)
    response = client.get("/api/devices", headers={"Authorization": f"bearer {device.token}"})
    assert response.status_code == 200


def test_logout_revokes_only_the_own_token(client):
    phone, tablet = Device(client, "Handy"), Device(client, "Tablet")
    response = client.post("/api/auth/logout", headers=phone.headers)
    assert response.status_code == 204
    assert response.content == b""

    assert client.get("/api/devices", headers=phone.headers).status_code == 401
    assert phone.post().status_code == 401
    assert phone.post().json()["error"]["code"] == "unauthorized"
    # Das andere Gerät bleibt angemeldet und sieht die Sperre.
    devices = client.get("/api/devices", headers=tablet.headers).json()["devices"]
    by_id = {device["id"]: device for device in devices}
    assert timeutil.is_timestamp(by_id[phone.id]["revoked_at"])
    assert by_id[tablet.id]["revoked_at"] is None


def test_a_changed_password_keeps_devices_signed_in(settings):
    with TestClient(create_app(settings)) as client:
        device = Device(client)
    changed = dataclasses.replace(settings, password="neues-passwort")
    with TestClient(create_app(changed)) as client:
        assert client.get("/api/devices", headers=device.headers).status_code == 200
        assert login(client).status_code == 401
        assert login(client, password="neues-passwort").status_code == 200


# --- Geräte ------------------------------------------------------------------------------


def test_device_list_marks_the_current_device(client):
    phone, tablet = Device(client, "Handy"), Device(client, "Tablet")
    response = client.get("/api/devices", headers=tablet.headers)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    devices = response.json()["devices"]
    assert [(device["name"], device["current"]) for device in devices] == [("Handy", False), ("Tablet", True)]
    assert {device["id"] for device in devices} == {phone.id, tablet.id}
    assert "token" not in json.dumps(devices)  # weder Token noch token_hash


def test_any_device_can_rename_any_device(client):
    phone, tablet = Device(client, "Handy"), Device(client, "Tablet")
    response = client.patch(f"/api/devices/{phone.id}", json={"name": "Handy Keller"}, headers=tablet.headers)
    assert response.status_code == 200
    assert response.json()["name"] == "Handy Keller"
    assert response.json()["current"] is False

    own = client.patch(f"/api/devices/{tablet.id}", json={"name": "Tablet Küche"}, headers=tablet.headers)
    assert own.json()["current"] is True

    names = {d["id"]: d["name"] for d in client.get("/api/devices", headers=phone.headers).json()["devices"]}
    assert names == {phone.id: "Handy Keller", tablet.id: "Tablet Küche"}

    renamed = [e for e in events_of(client, phone, entity="device") if e["type"] == "device.renamed"]
    assert [(e["entity_id"], e["device_id"], e["data"]) for e in renamed] == [
        (phone.id, tablet.id, {"name": "Handy Keller", "old": "Handy"}),
        (tablet.id, tablet.id, {"name": "Tablet Küche", "old": "Tablet"}),
    ]


def test_rename_validates_name_and_device(client):
    device = Device(client)
    unknown = client.patch(f"/api/devices/{ID}", json={"name": "Neu"}, headers=device.headers)
    assert unknown.status_code == 404
    assert unknown.json()["error"]["code"] == "not_found"
    assert (
        client.patch(f"/api/devices/{device.id}", json={"name": ""}, headers=device.headers).status_code
        == 422
    )
    too_long = client.patch(f"/api/devices/{device.id}", json={"name": "x" * 61}, headers=device.headers)
    assert too_long.status_code == 422
    assert too_long.json()["error"]["code"] == "invalid_request"


def test_revoking_a_device_locks_its_token_and_can_be_repeated(client):
    phone, tablet = Device(client, "Handy"), Device(client, "Tablet")
    assert phone.post().status_code == 200

    response = client.delete(f"/api/devices/{phone.id}", headers=tablet.headers)
    assert response.status_code == 204
    # Gesperrtes Token: 401 beim Sync, die App behält ihre Daten und meldet sich neu an.
    blocked = phone.post()
    assert blocked.status_code == 401
    assert blocked.json()["error"]["code"] == "unauthorized"

    devices = {d["id"]: d for d in client.get("/api/devices", headers=tablet.headers).json()["devices"]}
    revoked_at = devices[phone.id]["revoked_at"]
    assert timeutil.is_timestamp(revoked_at)

    # Wiederholbar: gleiches Ergebnis, der Zeitpunkt bleibt.
    assert client.delete(f"/api/devices/{phone.id}", headers=tablet.headers).status_code == 204
    devices = {d["id"]: d for d in client.get("/api/devices", headers=tablet.headers).json()["devices"]}
    assert devices[phone.id]["revoked_at"] == revoked_at

    assert client.delete(f"/api/devices/{ID}", headers=tablet.headers).status_code == 404

    revoked = [e for e in events_of(client, tablet, entity="device") if e["type"] == "device.revoked"]
    assert [(e["entity_id"], e["device_id"], e["data"]) for e in revoked] == [
        (phone.id, tablet.id, {"name": "Handy"})
    ]


def test_a_device_can_revoke_itself(client):
    device = Device(client)
    assert client.delete(f"/api/devices/{device.id}", headers=device.headers).status_code == 204
    assert client.get("/api/devices", headers=device.headers).status_code == 401


def test_sync_updates_last_seen_at_most_once_a_minute(make_device, client, clock):
    device = make_device("Handy")

    def last_seen() -> str:
        devices = client.get("/api/devices", headers=device.headers).json()["devices"]
        return devices[0]["last_seen_at"]

    first = last_seen()
    assert first == clock.stamp()

    clock.advance(30)
    device.sync()
    assert last_seen() == first

    clock.advance(31)
    device.sync()
    assert last_seen() == clock.stamp()


def test_an_oversized_request_is_refused_before_it_is_read(client):
    huge = b'{"password": "' + b"x" * (4 * 1024 * 1024) + b'", "device_name": "Handy"}'
    response = client.post("/api/auth/login", content=huge, headers={"Content-Type": "application/json"})
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "payload_too_large"
    assert response.json()["error"]["details"] == {"max_bytes": 4 * 1024 * 1024}
    # Die Grenze gilt für alles, was der Server annimmt, und zählt nicht als Fehlversuch.
    assert login(client).status_code == 200
