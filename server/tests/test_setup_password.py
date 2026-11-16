"""Das erste Haushalts-Passwort und sein Hash (docs/sync-protokoll.md, Abschnitte 5 und 11.6).

Ohne ``STOWLY_PASSWORD`` und ohne Hash setzt das Passwort, wer Stowly zuerst öffnet, aber nur mit einem
``Host`` aus dem Heimnetz. Gespeichert wird nur ein scrypt-Hash.
"""

import contextlib
import dataclasses
import hashlib
import logging
import re
import sqlite3
import threading
import unicodedata
from collections.abc import Iterator
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from support import Device, events_of

from stowly import auth, db
from stowly.app import create_app
from stowly.config import Settings
from stowly.contract import ids, timeutil
from stowly.contract.api import LoginResponse

PASSWORD = "korrekt-pferd-batterie"
NO_PASSWORD = (
    "Auf dem Server gibt es noch kein Passwort. Bitte Stowly im Browser öffnen und die Einrichtung beginnen."
)


@pytest.fixture
def bare(settings: Settings) -> Settings:
    """Ein Server ohne STOWLY_PASSWORD und ohne Hash: offen für das erste Passwort."""
    return dataclasses.replace(settings, password=None)


@pytest.fixture
def fresh(bare: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(bare)) as client:
        yield client


def first(client: TestClient, password: str = PASSWORD, name: str = "Handy", host: str | None = None):
    headers = {} if host is None else {"Host": host}
    return client.post(
        "/api/setup/password", json={"password": password, "device_name": name}, headers=headers
    )


def stored(settings: Settings) -> str | None:
    con = db.connect(settings.database_path)
    try:
        return db.get_meta(con, auth.PASSWORD_HASH)
    finally:
        con.close()


# --- Ohne Passwort ------------------------------------------------------------------------------


def test_without_a_password_health_says_not_configured_and_login_is_503(fresh):
    assert fresh.get("/api/health").json()["configured"] is False
    response = fresh.post("/api/auth/login", json={"password": "irgendwas", "device_name": "Handy"})
    assert response.status_code == 503
    assert response.json()["error"] == {"code": "not_configured", "message": NO_PASSWORD, "details": None}


def test_the_start_says_who_sets_the_first_password(bare, caplog):
    caplog.set_level(logging.INFO, logger="stowly")
    with TestClient(create_app(bare)):
        pass
    assert "Noch kein Passwort: Wer Stowly jetzt öffnet, vergibt es." in caplog.text


# --- Das erste Passwort -------------------------------------------------------------------------


def test_the_first_password_signs_in_like_a_login_and_only_once(fresh, bare):
    response = first(fresh, name="Handy Küche")
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    body = LoginResponse.model_validate(response.json())
    assert body.device.name == "Handy Küche"
    assert body.device.current is True and body.device.revoked_at is None
    assert ids.is_uuid(body.device.id) and timeutil.is_timestamp(body.device.created_at)
    # Das Token gilt sofort, wie nach einer Anmeldung.
    devices = fresh.get("/api/devices", headers={"Authorization": f"Bearer {body.token}"})
    assert devices.status_code == 200
    assert [device["id"] for device in devices.json()["devices"]] == [body.device.id]

    assert fresh.get("/api/health").json()["configured"] is True
    assert (stored(bare) or "").startswith("$scrypt$")
    # Ein zweites Mal: 409, auch mit demselben Passwort; anmelden geht.
    again = first(fresh, name="Tablet")
    assert again.status_code == 409
    assert again.json()["error"]["code"] == "conflict"
    assert Device(fresh, "Tablet", password=PASSWORD).id != body.device.id
    assert fresh.post("/api/auth/login", json={"password": "falsch!!", "device_name": "X"}).status_code == 401


def test_with_stowly_password_there_is_no_first_password(client, settings):
    response = first(client)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "conflict"
    # Der Hash aus der Umgebung bleibt, wie er ist.
    assert auth.verify_password(settings.password or "", stored(settings) or "")


def test_the_fallback_of_the_development_mode_counts_but_is_never_stored(bare):
    dev = dataclasses.replace(bare, password="stowly", password_fallback=True, dev=True)
    with TestClient(create_app(dev)) as client:
        assert client.get("/api/health").json()["configured"] is True
        assert first(client).status_code == 409
        assert (
            client.post("/api/auth/login", json={"password": "stowly", "device_name": "Handy"}).status_code
            == 200
        )
    assert stored(dev) is None


@pytest.mark.parametrize(
    "host",
    [
        "localhost",
        "localhost:8010",
        "127.0.0.1:8010",
        "[::1]:8010",
        "[fd00::10]",
        "[fd00::10]:8010",
        "diskstation",
        "diskstation:8010",
        "192.168.1.10:8010",
        "10.0.0.5",
        "172.16.4.2:8010",
        "100.64.0.7:8010",
        "nas.local",
        "NAS.Local.:8010",
        "stowly.home.arpa",
    ],
)
def test_hosts_in_the_home_network_may_set_the_first_password(bare, host):
    with TestClient(create_app(bare)) as client:
        assert first(client, host=host).status_code == 200, host


@pytest.mark.parametrize(
    "host",
    [
        "evil.example",
        "evil.example:8010",
        "8.8.8.8",
        "8.8.8.8:8010",
        "[2001:db8::1]:8010",
        "172.32.0.1:8010",
        "192.169.1.10",
        "stowly.example",
        # .box ist eine öffentliche Endung: fürs erste Passwort zu unsicher (DNS-Rebinding)
        "nas.fritz.box:8010",
        "fritz.box",
        "nas.local:0",
        "nas.local:99999",
        "fd00::10",
        "1.2.3",
        "benutzer@nas.local",
        "nas.local/pfad",
        "",
    ],
)
def test_other_hosts_are_400_and_nothing_is_stored(fresh, bare, host):
    response = first(fresh, host=host)
    assert response.status_code == 400, host
    error = response.json()["error"]
    assert error["code"] == "invalid_request"
    assert error["details"]["errors"][0]["loc"] == ["header", "host"]
    assert stored(bare) is None
    assert fresh.get("/api/health").json()["configured"] is False


@pytest.mark.parametrize(
    ("password", "valid"), [("1234567", False), ("12345678", True), ("x" * 200, True), ("x" * 201, False)]
)
def test_the_password_has_8_to_200_characters(bare, password, valid):
    with TestClient(create_app(bare)) as client:
        response = first(client, password=password)
        assert response.status_code == (200 if valid else 422), response.text
        if not valid:
            assert response.json()["error"]["details"]["errors"][0]["loc"] == ["body", "password"]
            assert stored(bare) is None


def test_exactly_one_of_two_at_once_wins(fresh, bare):
    """Zwei Browser zugleich: genau einer setzt das Passwort, der andere bekommt 409."""
    barrier = threading.Barrier(2)
    results: list[int] = []

    def race(name: str) -> None:
        barrier.wait()
        results.append(first(fresh, password=f"passwort-von-{name}", name=name).status_code)

    threads = [threading.Thread(target=race, args=(name,)) for name in ("Handy", "Tablet")]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    assert sorted(results) == [200, 409]
    con = db.connect(bare.database_path)
    try:
        assert con.execute("SELECT COUNT(*) FROM devices").fetchone()[0] == 1
    finally:
        con.close()


@pytest.mark.parametrize("module_lock", [True, False])
def test_the_database_lets_only_one_win(fresh, bare, monkeypatch, module_lock):
    """Unter dem Endpunkt: Lock im Modul und INSERT ohne Upsert. Auch ohne das Lock (etwa zwei Prozesse)
    gewinnt genau einer."""
    if not module_lock:
        monkeypatch.setattr(auth, "_FIRST_PASSWORD", contextlib.nullcontext())
    barrier = threading.Barrier(4)
    outcome: list[str] = []

    def race(index: int) -> None:
        con = db.connect(bare.database_path)
        try:
            barrier.wait()
            auth.set_first_password(con, f"passwort-{index}", f"Gerät {index}")
            outcome.append("gesetzt")
        except auth.PasswordExists:
            outcome.append("schon da")
        finally:
            con.close()

    threads = [threading.Thread(target=race, args=(index,)) for index in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    assert sorted(outcome) == ["gesetzt", "schon da", "schon da", "schon da"]
    con = db.connect(bare.database_path)
    try:
        assert con.execute("SELECT COUNT(*) FROM devices").fetchone()[0] == 1
        types = [row[0] for row in con.execute("SELECT type FROM events WHERE entity = 'server'")]
        assert types == ["server.password_set"]
    finally:
        con.close()


def test_the_brake_of_the_login_holds_here_too(fresh):
    """Fünf Fehlversuche sperren auch das erste Passwort (ohne Passwort gibt es sie nur von Hand)."""
    clock = _Clock()
    guard = fresh.app.state.login_guard
    guard.clock = clock
    for _ in range(5):
        guard.attempt(lambda: False)
    response = first(fresh)
    assert response.status_code == 429
    assert response.headers["retry-after"] == "60"
    assert response.json()["error"]["details"] == {"retry_after_s": 60}
    clock.value += 60
    assert first(fresh).status_code == 200


class _Clock:
    def __init__(self) -> None:
        self.value = 1000.0

    def __call__(self) -> float:
        return self.value


def test_neither_the_password_nor_the_token_is_kept_or_logged(fresh, bare, caplog):
    caplog.set_level(logging.DEBUG)
    response = first(fresh, name="Handy")
    token = response.json()["token"]
    device = response.json()["device"]["id"]
    con = db.connect(bare.database_path)
    try:
        dump = "\n".join(con.iterdump())
        rows = [dict(row) for row in con.execute("SELECT * FROM events ORDER BY id")]
    finally:
        con.close()
    for secret in (PASSWORD, token):
        assert secret not in dump
        assert secret not in caplog.text
    assert hashlib.sha256(PASSWORD.encode()).hexdigest() not in dump
    # Die Ereignisse: das Gerät und das Passwort, beides vom neuen Gerät.
    events = events_of(fresh, SimpleNamespace(headers={"Authorization": f"Bearer {token}"}))
    assert [
        (event["type"], event["entity"], event["entity_id"], event["device_id"], event["data"])
        for event in events
    ] == [
        ("device.login", "device", device, device, {"name": "Handy"}),
        ("server.password_set", "server", "password", device, {"source": "app"}),
    ]
    assert all(row["command_id"] is None for row in rows)


def test_the_host_is_learned_for_the_certificate(bare):
    with TestClient(create_app(bare)) as client:
        token = first(client, host="192.168.1.10:8010").json()["token"]
        status = client.get(
            "/api/setup", headers={"Authorization": f"Bearer {token}", "Host": "192.168.1.10:8010"}
        )
    assert status.status_code == 200
    https = status.json()["https"]
    assert https["addresses"] == [{"address": "192.168.1.10", "source": "learned", "in_certificate": False}]
    assert https["http_port"] == 8010


def test_loopback_and_single_names_are_not_learned(bare):
    with TestClient(create_app(bare)) as client:
        token = first(client, host="diskstation:8010").json()["token"]
        status = client.get(
            "/api/setup", headers={"Authorization": f"Bearer {token}", "Host": "localhost:8010"}
        )
    assert status.json()["https"]["addresses"] == []


# --- Der Hash -----------------------------------------------------------------------------------


@pytest.mark.full_scrypt
def test_the_hash_is_scrypt_with_n_2_15_in_phc_format():
    assert (auth.SCRYPT_LN, auth.SCRYPT_R, auth.SCRYPT_P) == (15, 8, 1)
    value = auth.hash_password(PASSWORD)
    assert re.fullmatch(r"\$scrypt\$ln=15,r=8,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}", value), value
    assert auth.verify_password(PASSWORD, value)
    assert not auth.verify_password(PASSWORD + "x", value)
    # Jedes Mal ein neues Salz.
    assert auth.hash_password(PASSWORD) != value


@pytest.mark.full_scrypt
def test_the_default_memory_limit_of_openssl_is_too_small():
    """Darum maxmem 64 MiB: Mit der Vorgabe von OpenSSL (32 MiB) bricht scrypt mit N=2^15, r=8 ab."""
    with pytest.raises(ValueError):
        hashlib.scrypt(b"x", salt=b"0" * 16, n=2**15, r=8, p=1, dklen=32)
    hashlib.scrypt(b"x", salt=b"0" * 16, n=2**15, r=8, p=1, dklen=32, maxmem=auth.SCRYPT_MAXMEM)


def test_the_hash_carries_its_own_strength():
    """Geprüft wird mit den Werten aus dem Hash: Ein stärkerer Standard macht alte Hashes nicht ungültig."""
    weak = auth.hash_password(PASSWORD)  # ln=4 aus conftest
    assert weak.startswith("$scrypt$ln=4,")
    assert auth.verify_password(PASSWORD, weak)


def test_the_password_is_compared_after_nfc():
    composed = "Bär-im-Garten"
    decomposed = unicodedata.normalize("NFD", composed)
    assert composed != decomposed
    assert auth.verify_password(decomposed, auth.hash_password(composed))
    assert auth.password_matches(decomposed, composed)


@pytest.mark.parametrize(
    "value",
    [
        "",
        "kein hash",
        "$scrypt$ln=4,r=8,p=1$c2FsdA$",
        "$scrypt$ln=99,r=8,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2g",
        "$scrypt$ln=4,r=0,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2g",
        "$scrypt$ln=4,r=8,p=1$!!!!!!!!!!!!!!!!!!!!!!$aGFzaGhhc2hoYXNoaGFzaGhhc2g",
        "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA",
    ],
)
def test_an_unusable_hash_never_matches_and_never_fails(value):
    assert auth.verify_password(PASSWORD, value) is False


def test_a_hash_without_environment_keeps_the_server_configured(bare):
    with TestClient(create_app(bare)) as client:
        first(client)
    with TestClient(create_app(bare)) as client:
        assert client.get("/api/health").json()["configured"] is True
        assert first(client).status_code == 409
        login = client.post("/api/auth/login", json={"password": PASSWORD, "device_name": "Tablet"})
        assert login.status_code == 200


def test_an_old_backup_without_a_hash_opens_the_server_again(bare):
    """So steht es im Risiko des Plans: Ohne Hash und ohne Variable setzt wieder, wer zuerst kommt."""
    with TestClient(create_app(bare)) as client:
        first(client)
    con = db.connect(bare.database_path)
    try:
        with db.transaction(con):
            con.execute("DELETE FROM meta WHERE key = ?", (auth.PASSWORD_HASH,))
    finally:
        con.close()
    with TestClient(create_app(bare)) as client:
        assert client.get("/api/health").json()["configured"] is False
        assert first(client, password="ein-neues-passwort").status_code == 200


def test_the_insert_fails_on_an_existing_hash(bare):
    with TestClient(create_app(bare)):
        pass
    con = db.connect(bare.database_path)
    try:
        auth.set_first_password(con, PASSWORD, "Handy")
        with pytest.raises(auth.PasswordExists):
            auth.set_first_password(con, "ein-anderes", "Tablet")
        with pytest.raises(sqlite3.IntegrityError):
            con.execute("INSERT INTO meta (key, value) VALUES (?, 'x')", (auth.PASSWORD_HASH,))
    finally:
        con.close()
