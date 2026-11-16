"""Eine Sicherung zurückspielen (docs/sync-protokoll.md, 11.9; docs/plan-einrichtung-b.md, Abschnitt 2).

Hochladen, prüfen, anwenden; der Tausch geschieht erst beim nächsten Start (``restore.resume``), hier von
Hand aufgerufen wie in ``__main__.main`` vor ``create_app``. Den Neustart selbst bildet ein Ersatz für
``request_restart`` nach. Die Schlüsselpaare stammen aus ``docs/vectors.json`` (pyrage).
"""

import asyncio
import dataclasses
import gzip
import json
import logging
import os
import shutil
import sqlite3
import stat
import subprocess
import sys
import threading
from collections import namedtuple
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pyrage
import pytest
from fastapi.testclient import TestClient
from support import TEST_PASSWORD, Device, asgi_call, events_of

import stowly.__main__ as entry
from stowly import auth, autobackup, db, haconfig, pairing, push, restore, scheduler, serverconfig
from stowly.app import create_app
from stowly.config import Settings
from stowly.contract import ids
from stowly.contract.api import (
    RESTORE_UNDO_DAYS,
    LoginResponse,
    RestorePreview,
    RestoreState,
    RestoreStatus,
    RestoreUpload,
)
from stowly.contract.timeutil import format_timestamp, parse_timestamp

CURRENT = len(db.list_migrations())


class Early:
    """Der Zeitplan steht auf 01:00 in Berlin: Er macht in diesen Tests keine Sicherung von sich aus."""

    def now(self) -> datetime:
        return datetime(2026, 11, 14, 0, 0, tzinfo=UTC)

    def monotonic(self) -> float:
        return 0.0

    async def sleep(self, seconds: float) -> None:
        return None


class Restarts:
    """Ersatz für ``Listeners.request_restart``: zählt, statt neu zu starten."""

    def __init__(self) -> None:
        self.calls = 0

    def __call__(self) -> None:
        self.calls += 1


def server(settings: Settings) -> TestClient:
    return TestClient(create_app(settings, job_clock=Early()))


def armed(client: TestClient) -> Restarts:
    hook = Restarts()
    client.app.state.request_restart = hook
    return hook


@pytest.fixture
def pairs(vectors) -> list[dict[str, str]]:
    return vectors["age_keys"]["pairs"]


def sealed(settings: Settings, public: str) -> bytes:
    """Eine Sicherung wie die automatische: Schnappschuss, gzip, age."""
    return autobackup.seal(autobackup.snapshot(settings.database_path), [public])


def upload(client: TestClient, data, headers: dict | None = None):
    return client.put(
        "/api/restore/upload",
        content=data,
        headers={"Content-Type": "application/octet-stream", **(headers or {})},
    )


def uploaded(client: TestClient, data, headers: dict | None = None) -> dict:
    response = upload(client, data, headers)
    assert response.status_code == 201, response.text
    RestoreUpload.model_validate(response.json())
    return response.json()


def check(client: TestClient, upload_id: str, identity: str | None = None, headers: dict | None = None):
    body = {"upload_id": upload_id} if identity is None else {"upload_id": upload_id, "identity": identity}
    return client.post("/api/restore/check", json=body, headers=headers or {})


def checked(
    client: TestClient, upload_id: str, identity: str | None = None, headers: dict | None = None
) -> dict:
    response = check(client, upload_id, identity, headers)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    RestorePreview.model_validate(response.json())
    return response.json()


def apply(client: TestClient, restore_id: str, password: str, headers: dict | None = None, **more):
    return client.post(
        "/api/restore/apply",
        json={"restore_id": restore_id, "password": password, **more},
        headers=headers or {},
    )


def reason(response) -> str:
    assert response.status_code == 422, response.text
    return response.json()["error"]["details"]["reason"]


def state_of(client: TestClient, device: Device) -> dict:
    response = client.get("/api/restore", headers=device.headers)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    RestoreStatus.model_validate(response.json())
    return response.json()


def folder(settings: Settings) -> Path:
    return settings.data_dir / "restore"


def leftovers(settings: Settings) -> set[str]:
    path = folder(settings)
    return {entry.name for entry in path.iterdir()} if path.is_dir() else set()


def meta(settings: Settings, key: str) -> str | None:
    con = db.connect(settings.database_path)
    try:
        return db.get_meta(con, key)
    finally:
        con.close()


def stowly_file(settings: Settings, tmp_path: Path, name: str = "kopie.sqlite3") -> Path:
    """Eine Datenbank von Stowly als einzelne Datei (wie entpackt aus einer Sicherung)."""
    path = tmp_path / name
    path.write_bytes(autobackup.snapshot(settings.database_path))
    return path


# --- Ein Haushalt mit Sicherung -------------------------------------------------------------------


@dataclasses.dataclass
class Household:
    settings: Settings
    backup: bytes  # verschlüsselt an pairs[0]
    phone: Device
    tablet: Device  # erst nach der Sicherung angemeldet
    rice: str  # Packung in der Sicherung
    noodles: str  # Packung nach der Sicherung
    pool_after: list[str]  # IDs, die das Handy nach der Sicherung bekam
    revoked: str  # Gerät, das nach der Sicherung gesperrt wurde


@pytest.fixture
def household(settings, clock, pairs) -> Household:
    with server(settings) as client:
        phone = Device(client, "Handy", clock=clock)
        phone.sync()
        old = Device(client, "Altes Handy", clock=clock)
        _, rice = phone.store("Reis")
        backup = sealed(settings, pairs[0]["public"])
        # Nach der Sicherung: neue Packung, neues Gerät, ein gesperrtes, ein Push-Kontakt, ein Lauf.
        _, noodles = phone.store("Nudeln")
        pool_after = list(phone.pool)
        tablet = Device(client, "Tablet", clock=clock)
        assert client.delete(f"/api/devices/{old.id}", headers=phone.headers).status_code == 204
        assert (
            client.patch(
                "/api/server-config",
                json={"push_contact": "mailto:betrieb@example.org"},
                headers=phone.headers,
            ).status_code
            == 200
        )
    # Dazu ein neues VAPID-Schlüsselpaar mit einem Push-Abo des Tablets und ein Lauf der Tagesnachricht.
    stamp = "2026-11-16T09:00:00.000Z"
    con = db.connect(settings.database_path)
    try:
        with db.transaction(con):
            con.execute("DELETE FROM meta WHERE key IN (?, ?)", (push.VAPID_PRIVATE, push.VAPID_PUBLIC))
        push.ensure_vapid_keys(con)
        with db.transaction(con):
            con.execute(
                "INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, origin, created_at, "
                "updated_at) VALUES (?, 'https://fcm.googleapis.com/x', ?, 'AAAAAAAAAAAAAAAAAAAAAA', "
                "'https://192.168.1.10:8443', ?, ?)",
                (tablet.id, push.b64url(b"\x04" + b"\x00" * 64), stamp, stamp),
            )
        scheduler.record_success(con, "push_daily", day="2026-11-16", at=stamp, state={"packages": 1})
    finally:
        con.close()
    return Household(settings, backup, phone, tablet, rice, noodles, pool_after, old.id)


def prepare(house: Household, pairs, *, device: Device | None = None) -> None:
    """Hochladen, prüfen und anwenden mit einem angemeldeten Gerät; der Neustart steht dann aus."""
    device = device or house.phone
    with server(house.settings) as client:
        device.client = client
        restarts = armed(client)
        up = uploaded(client, house.backup, device.headers)
        assert (up["kind"], up["size"]) == ("age", len(house.backup))
        preview = checked(client, up["upload_id"], pairs[0]["secret"], device.headers)
        response = apply(client, preview["restore_id"], TEST_PASSWORD, device.headers)
        assert response.status_code == 202, response.text
        assert response.json() == {"login": None}
        assert restarts.calls == 1
        assert state_of(client, device)["state"] == "pending"


def restore_running(settings: Settings, device: Device, backup: bytes, secret: str) -> None:
    """Zurückspielen in einen laufenden Stowly samt Neustart (``resume``)."""
    with server(settings) as client:
        device.client = client
        armed(client)
        up = uploaded(client, backup, device.headers)
        preview = checked(client, up["upload_id"], secret, device.headers)
        assert apply(client, preview["restore_id"], TEST_PASSWORD, device.headers).status_code == 202
    assert restore.resume(settings) is RestoreState.DONE


# --- Laufender Stowly ---------------------------------------------------------------------------


def test_restore_keeps_the_accesses_and_resets_every_device(household, pairs, clock):
    house = household
    with server(house.settings) as client:
        house.phone.client = client
        up = uploaded(client, house.backup, house.phone.headers)
        preview = checked(client, up["upload_id"], pairs[0]["secret"], house.phone.headers)
        assert preview["kind"] == "age"
        assert (preview["schema_version"], preview["current_schema_version"]) == (CURRENT, CURRENT)
        assert preview["counts"] == {"products": 1, "items": 1, "zones": 1, "shopping": 0}
        assert (preview["has_password"], preview["devices"]) == (True, 2)
        assert preview["last_activity_at"] is not None
        expires = parse_timestamp(preview["expires_at"]) - datetime.now(UTC)
        assert timedelta(minutes=29) < expires <= timedelta(minutes=30)
    old_dataset = house.phone.dataset_id
    vapid = meta(house.settings, push.VAPID_PUBLIC)
    prepare(house, pairs)
    assert restore.resume(house.settings) is RestoreState.DONE

    with server(house.settings) as client:
        for device in (house.phone, house.tablet):
            device.client = client
            # Niemand ist abgemeldet, auch das Gerät, das es in der Sicherung noch nicht gab.
            assert client.get("/api/devices", headers=device.headers).status_code == 200
        devices = {
            d["id"]: d for d in client.get("/api/devices", headers=house.phone.headers).json()["devices"]
        }
        assert devices[house.revoked]["revoked_at"] is not None  # gesperrt bleibt gesperrt
        data = house.phone.sync()
        assert data["reset"] is True and data["dataset_id"] != old_dataset
        assert set(house.phone.packages) == {house.rice}  # die Nudeln kamen nach der Sicherung
        # Was nach der Sicherung dazukam, bleibt aus der laufenden Datenbank: der Kontakt.
        config = client.get("/api/server-config", headers=house.phone.headers).json()
        assert config["push"] == {"contact": "mailto:betrieb@example.org", "source": "app"}
        assert client.get("/api/push/key", headers=house.phone.headers).json()["public_key"] == vapid
        integrations = client.get("/api/integrations", headers=house.tablet.headers).json()["push"]
        assert (integrations["subscriptions"], integrations["this_device"]) == (1, True)
        assert integrations["last_run_at"] == "2026-11-16T09:00:00.000Z"
        events = [
            e for e in events_of(client, house.phone, entity="server") if e["type"] == "server.restored"
        ]
        assert [(e["device_id"], e["data"]) for e in events] == [
            (
                house.phone.id,
                {"kind": "restore", "source": "age", "first_start": False, "schema_version": CURRENT},
            )
        ]
        status = state_of(client, house.phone)
        assert (status["state"], status["message"]) == ("done", restore.DONE_MESSAGE)
        undo_until = parse_timestamp(status["undo_until"]) - parse_timestamp(status["at"])
        assert undo_until == timedelta(days=RESTORE_UNDO_DAYS)
        house.phone.sync()  # zweiter Abgleich: kein Zurücksetzen mehr
    assert leftovers(house.settings) == {"previous.sqlite3", "last.json"}


def test_ids_printed_after_the_backup_are_never_handed_out_again(household, pairs, clock):
    house = household
    prepare(house, pairs)
    restore.resume(house.settings)
    con = db.connect(house.settings.database_path)
    try:
        reserved = {row[0] for row in con.execute("SELECT package_id FROM id_reservations")}
        packages = {row[0] for row in con.execute("SELECT id FROM packages")}
        assert con.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        con.close()
    assert house.noodles in reserved and house.noodles not in packages
    assert set(house.pool_after) <= reserved
    with server(house.settings) as client:
        house.tablet.client = client
        house.tablet.sync()
        assert not ({house.noodles, *house.pool_after} & set(house.tablet.pool))
        # Bringt ein Gerät die Packung erneut (Outbox), legt der Server sie mit ihrer Kennung an.
        product_id, create = house.tablet.product("Nudeln")
        _, store = house.tablet.package(product_id, package_id=house.noodles)
        results = house.tablet.sync([create, store])["results"]
        assert [r["status"] for r in results] == ["applied", "applied"]


def bring_household(settings: Settings, clock, public: str, marker: str | None) -> tuple[bytes, Device, str]:
    """Ein Eintrag der Einkaufsliste, gespiegelt in eine Liste von Home Assistant (``ha_links``, ``bring_key``),
    mit oder ohne Merker der Liste; die Sicherung entsteht so, danach wechselt die Liste auf todo.neu."""
    with server(settings) as client:
        phone = Device(client, "Handy", clock=clock)
        phone.sync()
        item = ids.new_uuid()
        phone.sync([phone.cmd("shopping_item.create", item_id=item, text="Kaffee")])
    stamp = "2026-11-16T09:00:00.000Z"
    con = db.connect(settings.database_path)
    try:
        with db.transaction(con):
            con.execute(
                "INSERT INTO ha_links (name_key, name, uid, own, status) "
                "VALUES ('kaffee', 'Kaffee', 'u1', 1, 'needs_action')"
            )
            con.execute("UPDATE shopping_items SET bring_key = 'kaffee' WHERE id = ?", (item,))
            if marker is not None:
                serverconfig.put(con, haconfig.LINKS_ENTITY, marker, now=stamp, by=None)
        backup = sealed(settings, public)
        with db.transaction(con):
            serverconfig.put(con, haconfig.LINKS_ENTITY, "todo.neu", now=stamp, by=None)
    finally:
        con.close()
    return backup, phone, item


def links_after(settings: Settings, item: str) -> tuple[object, int, str | None]:
    con = db.connect(settings.database_path)
    try:
        marker = serverconfig.get(con, haconfig.LINKS_ENTITY)
        links = con.execute("SELECT COUNT(*) FROM ha_links").fetchone()[0]
        bound = con.execute("SELECT bring_key FROM shopping_items WHERE id = ?", (item,)).fetchone()[0]
    finally:
        con.close()
    return marker, links, bound


def test_the_marker_of_ha_links_comes_with_the_backup(settings, clock, pairs):
    """``ha_links`` kommen aus der Sicherung, also auch der Merker ihrer Liste; der laufende Wert weicht."""
    backup, phone, item = bring_household(settings, clock, pairs[0]["public"], "todo.alt")
    restore_running(settings, phone, backup, pairs[0]["secret"])
    assert links_after(settings, item) == ("todo.alt", 1, "kaffee")


def test_a_backup_without_the_marker_forgets_its_ha_links(settings, clock, pairs):
    """Eine Sicherung von vor 0.4.0 sagt nicht, zu welcher Liste ihre Artikel gehören: Stowly vergisst sie,
    löst die Bindungen und hakt nichts ab; der nächste Abgleich setzt den Merker (bring.BringSync._adopt)."""
    backup, phone, item = bring_household(settings, clock, pairs[0]["public"], None)
    restore_running(settings, phone, backup, pairs[0]["secret"])
    assert links_after(settings, item) == (None, 0, None)
    con = db.connect(settings.database_path)
    try:
        done = con.execute("SELECT done_at, deleted_at FROM shopping_items WHERE id = ?", (item,)).fetchone()
    finally:
        con.close()
    assert tuple(done) == (None, None)  # offen wie in der Sicherung


def test_the_password_is_checked_through_the_login_guard(household, pairs):
    house = household
    with server(house.settings) as client:
        house.phone.client = client
        armed(client)
        up = uploaded(client, house.backup, house.phone.headers)
        preview = checked(client, up["upload_id"], pairs[0]["secret"], house.phone.headers)
        for _ in range(5):
            response = apply(client, preview["restore_id"], "falsch", house.phone.headers)
            assert (response.status_code, response.json()["error"]["code"]) == (401, "invalid_password")
        locked = apply(client, preview["restore_id"], TEST_PASSWORD, house.phone.headers)
        assert locked.status_code == 429 and int(locked.headers["retry-after"]) > 0
        # Auch die Anmeldung ist gesperrt: dieselbe Bremse.
        login = client.post("/api/auth/login", json={"password": TEST_PASSWORD, "device_name": "Neu"})
        assert login.status_code == 429
    assert not restore.pending_exists(house.settings)


def test_without_a_restart_there_is_no_apply(household, pairs):
    house = household
    with server(house.settings) as client:
        house.phone.client = client
        up = uploaded(client, house.backup, house.phone.headers)
        preview = checked(client, up["upload_id"], pairs[0]["secret"], house.phone.headers)
        response = apply(client, preview["restore_id"], TEST_PASSWORD, house.phone.headers)
        assert (response.status_code, response.json()["error"]["code"]) == (503, "not_configured")
    assert not restore.pending_exists(house.settings)


def test_while_pending_everything_else_waits(household, pairs, tmp_path):
    house = household
    prepare(house, pairs)
    with server(house.settings) as client:
        house.phone.client = client
        assert upload(client, house.backup, house.phone.headers).status_code == 409
        assert client.delete("/api/restore/previous", headers=house.phone.headers).status_code == 409
        install = client.post("/api/update/install", json={"version": "9.9.9"}, headers=house.phone.headers)
        assert (install.status_code, install.json()["error"]["message"]) == (409, restore.BLOCKS_UPDATE)


def test_an_update_blocks_the_restore(household, pairs):
    house = household
    now = datetime.now(UTC)
    update = house.settings.update_dir
    update.mkdir(parents=True, exist_ok=True)
    stamp = format_timestamp(now)
    (update / "request").write_text(f"version=9.9.9\nrequested_at={stamp}\ndevice=Handy\n", encoding="utf-8")
    (update / "updater").write_text(f"seen_at={stamp}\nkind=container\n", encoding="utf-8")
    with server(house.settings) as client:
        house.phone.client = client
        response = upload(client, house.backup, house.phone.headers)
        assert (response.status_code, response.json()["error"]["message"]) == (409, restore.UPDATE_RUNNING)
    # Eine Anforderung, die der Updater seit über 10 Minuten nicht abholt, sperrt nicht für immer.
    old = format_timestamp(now - timedelta(minutes=30))
    (update / "request").write_text(f"version=9.9.9\nrequested_at={old}\ndevice=Handy\n", encoding="utf-8")
    (update / "updater").write_text(f"seen_at={old}\nkind=container\n", encoding="utf-8")
    assert restore.update_busy(house.settings, now) is False


# --- Rückgängig ----------------------------------------------------------------------------------


def test_undo_brings_back_the_database_from_before_and_can_itself_be_undone(household, pairs, clock):
    house = household
    prepare(house, pairs)
    restore.resume(house.settings)
    with server(house.settings) as client:
        house.phone.client = client
        house.phone.sync()
        _, beans = house.phone.store("Bohnen")  # nach dem Zurückspielen, vor dem Rückgängig
        restarts = armed(client)
        response = client.post("/api/restore/undo", headers=house.phone.headers)
        assert (response.status_code, response.json()) == (202, {"login": None})
        assert restarts.calls == 1
    assert restore.resume(house.settings) is RestoreState.UNDONE
    with server(house.settings) as client:
        house.phone.client = client
        assert house.phone.sync()["reset"] is True
        assert set(house.phone.packages) == {house.rice, house.noodles}
        status = state_of(client, house.phone)
        assert (status["state"], status["message"]) == ("undone", restore.UNDONE_MESSAGE)
        assert status["undo_until"] is not None
        con = db.connect(house.settings.database_path)
        try:
            reserved = {row[0] for row in con.execute("SELECT package_id FROM id_reservations")}
        finally:
            con.close()
        assert beans in reserved  # auch nach einem Rückgängig vergibt Stowly keine gedruckte Kennung neu
        armed(client)
        assert client.post("/api/restore/undo", headers=house.phone.headers).status_code == 202
    assert restore.resume(house.settings) is RestoreState.UNDONE
    with server(house.settings) as client:
        house.phone.client = client
        house.phone.sync()
        assert set(house.phone.packages) == {house.rice, beans}


def test_deleting_the_previous_database_ends_undo(household, pairs):
    house = household
    prepare(house, pairs)
    restore.resume(house.settings)
    with server(house.settings) as client:
        house.phone.client = client
        armed(client)
        assert client.delete("/api/restore/previous", headers=house.phone.headers).status_code == 204
        assert client.delete("/api/restore/previous", headers=house.phone.headers).status_code == 204
        status = state_of(client, house.phone)
        assert (status["state"], status["undo_until"]) == ("done", None)
        response = client.post("/api/restore/undo", headers=house.phone.headers)
        assert (response.status_code, response.json()["error"]["message"]) == (404, restore.NOTHING_TO_UNDO)


def test_after_seven_days_the_previous_database_is_gone(household, pairs):
    house = household
    prepare(house, pairs)
    restore.resume(house.settings)
    later = datetime.now(UTC) + timedelta(days=RESTORE_UNDO_DAYS, minutes=1)
    assert restore.status(house.settings, later)["state"] is RestoreState.IDLE
    assert restore.resume(house.settings, now=later) is None
    assert not (folder(house.settings) / "previous.sqlite3").exists()
    with server(house.settings) as client:
        house.phone.client = client
        assert client.post("/api/restore/undo", headers=house.phone.headers).status_code == 404


# --- Der Tausch: Abstürze, Fristen, offene Datenbank ----------------------------------------------


class Crash(BaseException):
    """Der Prozess endet an dieser Stelle (BaseException: Auch resume fängt sie nicht)."""


@pytest.mark.parametrize(
    "point",
    ["_verify", "_quiesce", "_take_over", "_build_swap", "_link_or_copy", "_replace", "_finish", "_remember"],
)
def test_a_crash_between_any_two_steps_is_repaired_by_the_next_start(household, pairs, monkeypatch, point):
    house = household
    prepare(house, pairs)
    real = getattr(restore, point)

    def crash(*args, **kwargs):
        raise Crash

    monkeypatch.setattr(restore, point, crash)
    with pytest.raises(Crash):
        restore.resume(house.settings)
    monkeypatch.setattr(restore, point, real)
    assert restore.resume(house.settings) is RestoreState.DONE
    assert restore.resume(house.settings) is None  # danach liegt nichts mehr bereit
    assert leftovers(house.settings) == {"previous.sqlite3", "last.json"}
    with server(house.settings) as client:
        house.phone.client = client
        house.phone.sync()
        assert set(house.phone.packages) == {house.rice}
        assert state_of(client, house.phone)["state"] == "done"
    previous = sqlite3.connect(folder(house.settings) / "previous.sqlite3")
    try:
        assert previous.execute("SELECT COUNT(*) FROM packages").fetchone()[0] == 2  # Reis und Nudeln
    finally:
        previous.close()


def test_too_late_before_the_swap_keeps_the_old_database(household, pairs):
    house = household
    prepare(house, pairs)
    later = datetime.now(UTC) + timedelta(minutes=11)
    assert restore.resume(house.settings, now=later) is RestoreState.FAILED
    assert leftovers(house.settings) == {"last.json"}
    with server(house.settings) as client:
        house.phone.client = client
        house.phone.sync()
        assert set(house.phone.packages) == {house.rice, house.noodles}
        status = state_of(client, house.phone)
        assert (status["state"], status["undo_until"]) == ("failed", None)
        assert status["message"] == restore._failed(restore.TOO_LATE)


def test_after_the_swap_a_late_start_still_finishes(household, pairs, monkeypatch):
    house = household
    prepare(house, pairs)

    def crash(*_args, **_kwargs):
        raise Crash

    monkeypatch.setattr(restore, "_finish", crash)
    with pytest.raises(Crash):
        restore.resume(house.settings)
    monkeypatch.undo()
    later = datetime.now(UTC) + timedelta(hours=3)
    assert restore.resume(house.settings, now=later) is RestoreState.DONE
    assert leftovers(house.settings) == {"previous.sqlite3", "last.json"}


def test_a_database_still_open_is_never_swapped(household, pairs):
    house = household
    prepare(house, pairs)
    holder = db.connect(house.settings.database_path)  # etwa ein Thread, der nicht rechtzeitig endete
    try:
        holder.execute("SELECT COUNT(*) FROM packages").fetchone()
        assert restore.resume(house.settings) is RestoreState.FAILED
    finally:
        holder.close()
    with server(house.settings) as client:
        house.phone.client = client
        house.phone.sync()
        assert set(house.phone.packages) == {house.rice, house.noodles}
        assert state_of(client, house.phone)["message"] == restore._failed(restore.STILL_OPEN)


WRITE_AND_DIE = """
import os, sqlite3, sys
con = sqlite3.connect(sys.argv[1], isolation_level=None)
con.execute("PRAGMA journal_mode = WAL")
con.execute("PRAGMA wal_autocheckpoint = 0")
con.execute("INSERT INTO meta (key, value) VALUES ('nur_im_wal', 'ja')")
os._exit(0)  # ohne close: Die Änderung steht nur im -wal
"""


def test_an_open_wal_ends_up_in_the_previous_database(household, pairs, tmp_path):
    house = household
    prepare(house, pairs)
    database = house.settings.database_path
    script = tmp_path / "schreiben.py"
    script.write_text(WRITE_AND_DIE, encoding="utf-8")
    subprocess.run([sys.executable, "-I", str(script), str(database)], check=True, timeout=60)
    assert Path(f"{database}-wal").stat().st_size > 0
    assert restore.resume(house.settings) is RestoreState.DONE
    assert not Path(f"{database}-wal").exists()
    previous = sqlite3.connect(folder(house.settings) / "previous.sqlite3")
    try:
        assert previous.execute("SELECT value FROM meta WHERE key = 'nur_im_wal'").fetchone() == ("ja",)
    finally:
        previous.close()
    assert meta(house.settings, "nur_im_wal") is None


def test_a_changed_pending_file_is_refused(household, pairs):
    house = household
    prepare(house, pairs)
    pending = folder(house.settings) / "pending.sqlite3"
    with pending.open("r+b") as stream:
        stream.seek(4096)
        stream.write(b"\x00" * 16)
    assert restore.resume(house.settings) is RestoreState.FAILED
    assert restore.status(house.settings, datetime.now(UTC))["message"] == restore._failed(restore.CHANGED)
    assert leftovers(house.settings) == {"last.json"}


def test_a_broken_manifest_is_dropped_without_a_loop(household, pairs):
    house = household
    prepare(house, pairs)
    (folder(house.settings) / "pending.json").write_text("{kein json", encoding="utf-8")
    assert restore.resume(house.settings) is RestoreState.FAILED
    assert restore.resume(house.settings) is None
    assert leftovers(house.settings) == {"last.json"}


def test_without_hard_links_the_previous_database_is_a_copy(household, pairs, monkeypatch):
    house = household
    prepare(house, pairs)

    def no_links(_source, _target):
        raise OSError(1, "Operation not permitted")

    monkeypatch.setattr(restore.os, "link", no_links)
    assert restore.resume(house.settings) is RestoreState.DONE
    previous = sqlite3.connect(folder(house.settings) / "previous.sqlite3")
    try:
        assert previous.execute("SELECT COUNT(*) FROM packages").fetchone()[0] == 2
    finally:
        previous.close()


@pytest.mark.skipif(os.name != "posix", reason="Rechte von Dateien gibt es so nur unter POSIX")
def test_the_restore_folder_and_its_files_are_private(household, pairs):
    house = household
    prepare(house, pairs)
    target = folder(house.settings)
    assert stat.S_IMODE(target.stat().st_mode) == 0o700
    for name in ("pending.sqlite3", "pending.json"):
        assert stat.S_IMODE((target / name).stat().st_mode) == 0o600, name
    restore.resume(house.settings)
    assert stat.S_IMODE((target / "last.json").stat().st_mode) == 0o600
    assert stat.S_IMODE(house.settings.database_path.stat().st_mode) == 0o600


def test_leftovers_of_an_earlier_process_are_swept(settings):
    target = settings.data_dir / "restore"
    target.mkdir(parents=True)
    names = [
        f"upload-{'a' * 32}",
        f"work-{'b' * 32}.sqlite3",
        f"candidate-{'c' * 32}.sqlite3",
        f"candidate-{'c' * 32}.sqlite3-journal",
        "swap.sqlite3",
        "previous.next.sqlite3",
        "pending.sqlite3",
    ]
    for name in [*names, "fremd.txt"]:
        (target / name).write_bytes(b"x")
    assert restore.resume(settings) is None
    assert leftovers(settings) == {"fremd.txt"}


# --- Prüfen: Schlüssel und Dateien ----------------------------------------------------------------


@pytest.fixture
def bench(household) -> Iterator[tuple[TestClient, Device, Household]]:
    with server(household.settings) as client:
        household.phone.client = client
        yield client, household.phone, household


def test_a_wrong_key_and_then_the_right_one_without_uploading_again(bench, pairs, caplog):
    caplog.set_level(logging.DEBUG)
    client, phone, house = bench
    up = uploaded(client, house.backup, phone.headers)
    wrong = check(client, up["upload_id"], pairs[1]["secret"], phone.headers)
    assert reason(wrong) == "wrong_key"
    assert wrong.json()["error"]["message"] == restore.WRONG_KEY
    key_file = "# created: 2026-11-16T20:00:00+01:00\n# public key: …\n" + pairs[0]["secret"] + "\n"
    preview = checked(client, up["upload_id"], key_file, phone.headers)
    assert preview["kind"] == "age"
    for secret in (pairs[0]["secret"], pairs[1]["secret"]):
        assert secret not in caplog.text and secret not in wrong.text and secret not in json.dumps(preview)


def test_more_keys_in_one_file_any_of_them_opens(bench, pairs):
    client, phone, house = bench
    up = uploaded(client, house.backup, phone.headers)
    both = f"{pairs[2]['secret']}\n{pairs[0]['secret'].lower()}"
    assert checked(client, up["upload_id"], both, phone.headers)["kind"] == "age"


@pytest.mark.parametrize(
    "identity, message",
    [
        (None, restore.KEY_MISSING),
        ("", restore.KEY_MISSING),
        ("# nur ein Kommentar\n\n", restore.KEY_MISSING),
        ("age1wd93f5pmu4q002srqcx02vjwhex9ka0drhg73kaawz9nnp4rcetqpndxjq", restore.PUBLIC_GIVEN),
        ("AGE-SECRET-KEY-1", restore.NOT_A_KEY),
        ("kein schlüssel", restore.NOT_A_KEY),
    ],
)
def test_what_is_not_a_secret_key(bench, identity, message):
    client, phone, house = bench
    up = uploaded(client, house.backup, phone.headers)
    response = check(client, up["upload_id"], identity, phone.headers)
    assert (reason(response), response.json()["error"]["message"]) == ("not_a_key", message)


def test_a_too_long_identity_is_refused_by_the_contract(bench):
    client, phone, house = bench
    up = uploaded(client, house.backup, phone.headers)
    response = check(client, up["upload_id"], "x" * 5000, phone.headers)
    assert response.status_code == 422 and "x" * 100 not in response.text


def test_armored_gzip_and_plain_uploads_are_recognized(bench, pairs, tmp_path):
    client, phone, house = bench
    plain = autobackup.snapshot(house.settings.database_path)
    armored = pyrage.encrypt(
        gzip.compress(plain), [pyrage.x25519.Recipient.from_str(pairs[0]["public"])], armored=True
    )
    for data, kind, identity in (
        (armored, "age", pairs[0]["secret"]),
        (gzip.compress(plain), "gzip", None),
        (plain, "sqlite", None),
        (
            pyrage.encrypt(plain, [pyrage.x25519.Recipient.from_str(pairs[0]["public"])]),
            "age",
            pairs[0]["secret"],
        ),
    ):
        up = uploaded(client, data, phone.headers)
        assert up["kind"] == kind
        assert checked(client, up["upload_id"], identity, phone.headers)["counts"]["products"] == 2
        client.app.state.restore._recent.clear()  # die Bremse zählt hier nicht


@pytest.mark.parametrize(
    "data, expected",
    [
        (b"", "not_stowly"),
        (b"PK\x03\x04" + b"x" * 200, "not_stowly"),  # ein ZIP
        (b"-----BEGIN PGP MESSAGE-----\n" + b"x" * 100, "not_stowly"),
    ],
)
def test_files_that_cannot_be_a_backup_are_refused_at_once(bench, data, expected):
    client, phone, house = bench
    response = upload(client, data, phone.headers)
    assert reason(response) == expected
    assert not any(name.startswith("upload-") for name in leftovers(house.settings))


def test_broken_and_foreign_contents(bench, pairs, tmp_path):
    client, phone, house = bench
    plain = autobackup.snapshot(house.settings.database_path)
    recipient = pyrage.x25519.Recipient.from_str(pairs[0]["public"])
    flipped = bytearray(house.backup)
    flipped[len(flipped) // 2] ^= 0x01
    cases = [
        (bytes(flipped), pairs[0]["secret"], "damaged"),
        (house.backup[:-200], pairs[0]["secret"], "damaged"),  # abgeschnitten
        (gzip.compress(plain)[:-100], None, "damaged"),
        (pyrage.encrypt(b"kein gzip, keine Datenbank" * 10, [recipient]), pairs[0]["secret"], "not_stowly"),
        (gzip.compress(b"keine Datenbank" * 100), None, "not_stowly"),
        (plain[: len(plain) // 2], None, "damaged"),
    ]
    for data, identity, expected in cases:
        up = uploaded(client, data, phone.headers)
        assert reason(check(client, up["upload_id"], identity, phone.headers)) == expected
        client.app.state.restore._recent.clear()  # die Bremse zählt hier nicht
    assert not any(name.startswith(("work-", "candidate-")) for name in leftovers(house.settings))


def changed_copy(settings: Settings, tmp_path: Path, *statements: str) -> bytes:
    path = stowly_file(settings, tmp_path)
    con = sqlite3.connect(path, isolation_level=None)
    try:
        for statement in statements:
            con.execute(statement)
    finally:
        con.close()
    return path.read_bytes()


@pytest.mark.parametrize(
    "statements, message",
    [
        (
            ("CREATE TRIGGER heimlich AFTER INSERT ON zones BEGIN DELETE FROM packages; END",),
            restore.TRIGGERS,
        ),
        (("CREATE VIEW alles AS SELECT * FROM packages",), restore.TRIGGERS),
        (("CREATE TABLE fremd (x)",), restore.FOREIGN_SCHEMA),
        (("CREATE INDEX extra ON packages (best_before)",), restore.FOREIGN_SCHEMA),
        (("PRAGMA application_id = 1234",), restore.NOT_STOWLY),
        (("PRAGMA user_version = 0",), restore.NOT_STOWLY),
    ],
)
def test_a_file_that_is_not_a_stowly_database(bench, tmp_path, statements, message):
    client, phone, house = bench
    up = uploaded(client, changed_copy(house.settings, tmp_path, *statements), phone.headers)
    response = check(client, up["upload_id"], None, phone.headers)
    assert (reason(response), response.json()["error"]["message"]) == ("not_stowly", message)


def test_a_backup_from_a_newer_stowly(bench, tmp_path):
    client, phone, house = bench
    up = uploaded(
        client, changed_copy(house.settings, tmp_path, f"PRAGMA user_version = {CURRENT + 1}"), phone.headers
    )
    response = check(client, up["upload_id"], None, phone.headers)
    assert reason(response) == "newer_schema"
    assert f"Datenbank-Version {CURRENT + 1}" in response.json()["error"]["message"]


def test_a_foreign_sqlite_database(bench, tmp_path):
    client, phone, house = bench
    path = tmp_path / "fremd.sqlite3"
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE notizen (text TEXT)")
    con.execute("PRAGMA user_version = 2")
    con.commit()
    con.close()
    up = uploaded(client, path.read_bytes(), phone.headers)
    assert reason(check(client, up["upload_id"], None, phone.headers)) == "not_stowly"


def old_database(path: Path, version: int) -> bytes:
    """Eine Datenbank, wie sie ein Stowly mit ``version`` Migrationen anlegte, mit einer Zone und einem Gerät."""
    con = sqlite3.connect(path, isolation_level=None)
    try:
        for number, _name, sql in db.list_migrations():
            if number > version:
                break
            con.executescript(f"BEGIN;\n{sql}\nPRAGMA user_version = {number};\nCOMMIT;")
        stamp = "2025-01-02T03:04:05.000Z"
        con.execute("INSERT INTO counters (name, value) VALUES ('rev', 1), ('settings_rev', 0)")
        con.execute("INSERT INTO meta (key, value) VALUES ('dataset_id', 'alt')")
        con.execute(
            "INSERT INTO zones (id, name, created_at, updated_at, rev) VALUES "
            "('00000000-0000-4000-8000-000000000001', 'Keller', ?, ?, 1)",
            (stamp, stamp),
        )
        con.execute(
            "INSERT INTO devices (id, name, token_hash, created_at) VALUES "
            "('00000000-0000-4000-8000-000000000002', 'Handy', 'abc', ?)",
            (stamp,),
        )
    finally:
        con.close()
    return path.read_bytes()


def test_an_older_backup_is_migrated(bench, tmp_path):
    client, phone, house = bench
    data = old_database(tmp_path / "alt.sqlite3", 2)
    up = uploaded(client, data, phone.headers)
    preview = checked(client, up["upload_id"], None, phone.headers)
    assert (preview["schema_version"], preview["current_schema_version"]) == (2, CURRENT)
    assert preview["counts"] == {"products": 0, "items": 0, "zones": 1, "shopping": 0}
    assert (preview["has_password"], preview["devices"]) == (False, 1)
    candidate = client.app.state.restore.candidate
    con = sqlite3.connect(candidate.path)
    try:
        assert con.execute("PRAGMA user_version").fetchone()[0] == CURRENT
        assert con.execute("PRAGMA application_id").fetchone()[0] == restore.APPLICATION_ID
        assert con.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
    finally:
        con.close()


def test_the_limits_of_size_and_space(bench, pairs, monkeypatch):
    client, phone, house = bench
    monkeypatch.setattr(restore, "RESTORE_MAX_BYTES", 1000)
    too_big = upload(client, b"SQLite format 3\x00" + b"x" * 2000, phone.headers)
    assert (too_big.status_code, too_big.json()["error"]["code"]) == (413, "payload_too_large")
    # Auch ohne Content-Length (chunked): gezählt wird beim Lesen.
    chunked = upload(client, iter([b"SQLite format 3\x00" + b"x" * 600, b"y" * 600]), phone.headers)
    assert chunked.status_code == 413
    monkeypatch.undo()
    up = uploaded(client, house.backup, phone.headers)
    client.app.state.restore._recent.clear()
    monkeypatch.setattr(restore, "UNPACKED_MAX", 1000)
    unpacked = check(client, up["upload_id"], pairs[0]["secret"], phone.headers)
    assert (unpacked.status_code, unpacked.json()["error"]["message"]) == (413, restore.UNPACKED_TOO_LARGE)
    monkeypatch.undo()
    usage = namedtuple("usage", "total used free")
    monkeypatch.setattr(restore.shutil, "disk_usage", lambda _path: usage(10**9, 10**9, 1000))
    full = upload(client, house.backup, phone.headers)
    assert full.status_code == 409 and "zu wenig Platz" in full.json()["error"]["message"]
    # Vom gescheiterten Hochladen bleibt nichts; die frühere Datei gilt weiter.
    assert {name for name in leftovers(house.settings) if name.startswith("upload-")} == {
        f"upload-{up['upload_id']}"
    }


def test_a_large_upload_passes_the_general_body_limit(bench):
    """Die Grenze von 4 MiB gilt für alle anderen Aufrufe, nicht für das Hochladen (app.BodyLimit)."""
    client, phone, house = bench
    big = b"\x1f\x8b" + os.urandom(5 * 1024 * 1024)
    assert uploaded(client, big, phone.headers)["size"] == len(big)
    response = client.post(
        "/api/sync", content=big, headers={**phone.headers, "Content-Type": "application/json"}
    )
    assert response.status_code == 413


def test_uploads_and_checks_expire_after_30_minutes(bench, pairs):
    client, phone, house = bench
    manager = client.app.state.restore
    now = [datetime.now(UTC)]
    manager.clock = lambda: now[0]
    up = uploaded(client, house.backup, phone.headers)
    now[0] += timedelta(minutes=31)
    response = check(client, up["upload_id"], pairs[0]["secret"], phone.headers)
    assert (response.status_code, response.json()["error"]["message"]) == (404, restore.UPLOAD_UNKNOWN)
    assert not any(name.startswith("upload-") for name in leftovers(house.settings))
    up = uploaded(client, house.backup, phone.headers)
    preview = checked(client, up["upload_id"], pairs[0]["secret"], phone.headers)
    now[0] += timedelta(minutes=31)
    armed(client)
    response = apply(client, preview["restore_id"], TEST_PASSWORD, phone.headers)
    assert (response.status_code, response.json()["error"]["message"]) == (404, restore.CANDIDATE_UNKNOWN)
    assert not any(name.startswith("candidate-") for name in leftovers(house.settings))
    unknown = apply(client, "0" * 32, TEST_PASSWORD, phone.headers)
    assert unknown.status_code == 404


def test_one_step_at_a_time_and_at_most_six_in_ten_minutes(bench, pairs):
    client, phone, house = bench
    manager = client.app.state.restore
    with manager.operation(counted=False):
        busy = upload(client, house.backup, phone.headers)
    assert busy.status_code == 429 and busy.headers["retry-after"] == str(restore.BUSY_RETRY_S)
    now = [datetime.now(UTC)]
    manager.clock = lambda: now[0]
    up = uploaded(client, house.backup, phone.headers)
    for _ in range(4):
        assert reason(check(client, up["upload_id"], pairs[1]["secret"], phone.headers)) == "wrong_key"
    assert check(client, up["upload_id"], pairs[0]["secret"], phone.headers).status_code == 200
    seventh = check(client, up["upload_id"], pairs[0]["secret"], phone.headers)
    assert seventh.status_code == 429
    assert seventh.json()["error"]["details"] == {"retry_after_s": 600}
    now[0] += timedelta(minutes=10, seconds=1)
    assert check(client, up["upload_id"], pairs[0]["secret"], phone.headers).status_code == 200


def test_a_running_stowly_needs_a_valid_token(bench):
    client, phone, house = bench
    for headers in ({}, {"Authorization": "Bearer unbekannt"}, {"Authorization": ""}):
        response = upload(client, house.backup, headers)
        assert response.status_code == 401, headers
        assert response.json()["error"]["code"] == "unauthorized"
    assert check(client, "0" * 32, None, {}).status_code == 401
    assert apply(client, "0" * 32, TEST_PASSWORD, {}).status_code == 401
    assert client.get("/api/restore").status_code == 401


def test_the_status_without_anything(bench):
    client, phone, house = bench
    assert state_of(client, phone) == {"state": "idle", "at": None, "message": None, "undo_until": None}


# --- Erster Start --------------------------------------------------------------------------------


@pytest.fixture
def fresh(settings, tmp_path) -> Settings:
    """Ein neuer Rechner: kein STOWLY_PASSWORD, ein leerer Datenordner."""
    return dataclasses.replace(settings, password=None, data_dir=tmp_path / "neu")


def test_first_start_with_the_password_of_the_backup(household, fresh, pairs, clock):
    house = household
    with server(fresh) as client:
        assert client.get("/api/health").json()["configured"] is False
        restarts = armed(client)
        up = uploaded(client, house.backup)
        preview = checked(client, up["upload_id"], pairs[0]["secret"])
        assert (preview["has_password"], preview["devices"]) == (True, 2)
        wrong = apply(client, preview["restore_id"], "falsch", device_name="Laptop")
        assert (wrong.status_code, wrong.json()["error"]["message"]) == (401, restore.WRONG_BACKUP_PASSWORD)
        response = apply(client, preview["restore_id"], TEST_PASSWORD, device_name="Laptop")
        assert response.status_code == 202, response.text
        login = LoginResponse.model_validate(response.json()["login"])
        assert (login.device.name, login.device.current) == ("Laptop", True)
        assert restarts.calls == 1
        # Bis zum Neustart setzt niemand ein erstes Passwort.
        first = client.post(
            "/api/setup/password", json={"password": "ein-anderes-passwort", "device_name": "X"}
        )
        assert (first.status_code, first.json()["error"]["message"]) == (409, restore.BLOCKS_FIRST_PASSWORD)
        assert client.get("/api/health").json()["configured"] is False
    assert restore.resume(fresh) is RestoreState.DONE
    with server(fresh) as client:
        assert client.get("/api/health").json()["configured"] is True
        headers = {"Authorization": f"Bearer {login.token}"}
        assert client.get("/api/devices", headers=headers).status_code == 200
        # Mit dem Passwort der Sicherung gelten auch ihre Geräte weiter.
        assert client.get("/api/devices", headers=house.phone.headers).status_code == 200
        device = Device(client, "Tablet", clock=clock)  # Anmelden mit dem Passwort aus der Sicherung
        status = state_of(client, device)
        assert (status["state"], status["undo_until"]) == ("done", None)  # kein Rückgängig beim ersten Start
        armed(client)
        assert client.post("/api/restore/undo", headers=headers).status_code == 404
        setup = client.get("/api/setup", headers=headers).json()
        assert setup["finished_at"] is None  # die sichere Verbindung beginnt von vorn
        assert setup["https"]["seen_at"] is None
        events = [e for e in events_of(client, device, entity="server") if e["type"] == "server.restored"]
        assert events[0]["data"]["first_start"] is True and events[0]["device_id"] == login.device.id


def test_first_start_without_a_password_in_the_backup(settings, fresh, pairs, clock):
    with server(settings) as client:
        old = Device(client, "Altes Handy", clock=clock)
        old.sync()
        old.store("Reis")
    con = db.connect(settings.database_path)
    try:
        with db.transaction(con):
            con.execute("DELETE FROM meta WHERE key = ?", (auth.PASSWORD_HASH,))
    finally:
        con.close()
    backup = sealed(settings, pairs[0]["public"])
    with server(fresh) as client:
        armed(client)
        up = uploaded(client, backup)
        preview = checked(client, up["upload_id"], pairs[0]["secret"])
        assert preview["has_password"] is False
        short = apply(client, preview["restore_id"], "kurz", device_name="Laptop")
        assert short.status_code == 422
        assert short.json()["error"]["details"]["errors"][0]["loc"] == ["body", "password"]
        nameless = apply(client, preview["restore_id"], "ein-neues-passwort")
        assert nameless.json()["error"]["details"]["errors"][0]["loc"] == ["body", "device_name"]
        response = apply(client, preview["restore_id"], "ein-neues-passwort", device_name="Laptop")
        assert response.status_code == 202, response.text
        token = response.json()["login"]["token"]
    assert restore.resume(fresh) is RestoreState.DONE
    with server(fresh) as client:
        assert client.get("/api/devices", headers={"Authorization": f"Bearer {token}"}).status_code == 200
        assert client.get("/api/devices", headers=old.headers).status_code == 401  # gilt nicht mehr
        login = client.post(
            "/api/auth/login", json={"password": "ein-neues-passwort", "device_name": "Tablet"}
        )
        assert login.status_code == 200
        tablet = Device(client, "Tablet2", clock=clock, password="ein-neues-passwort")
        tablet.sync()
        assert len(tablet.packages) == 1


def test_first_start_only_from_the_home_network(household, fresh):
    with server(fresh) as client:
        response = upload(client, household.backup, {"Host": "stowly.example.com"})
        assert response.status_code == 400
        assert response.json()["error"]["details"]["errors"][0]["loc"] == ["header", "host"]
        assert upload(client, household.backup, {"Host": "192.168.1.10:8010"}).status_code == 201


def test_a_first_password_set_meanwhile_wins(household, fresh, pairs):
    with server(fresh) as client:
        armed(client)
        up = uploaded(client, household.backup)
        preview = checked(client, up["upload_id"], pairs[0]["secret"])
        first = client.post("/api/setup/password", json={"password": "schneller-war", "device_name": "Handy"})
        assert first.status_code == 200
        response = apply(client, preview["restore_id"], TEST_PASSWORD, device_name="Laptop")
        assert (response.status_code, response.json()["error"]["message"]) == (
            409,
            restore.PASSWORD_SET_MEANWHILE,
        )
        assert upload(client, household.backup).status_code == 401  # ab jetzt nur noch mit Token
    assert not restore.pending_exists(fresh)


def test_the_first_password_and_a_restore_are_decided_under_one_lock(household, fresh, pairs, monkeypatch):
    """Prüft das Anwenden gerade das Passwort der Sicherung, wartet das erste Passwort und bekommt dann 409."""
    entered, release = threading.Event(), threading.Event()
    real = auth.verify_password

    def slow(password: str, stored: str) -> bool:
        entered.set()
        assert release.wait(10)
        return real(password, stored)

    with server(fresh) as client:
        armed(client)
        up = uploaded(client, household.backup)
        preview = checked(client, up["upload_id"], pairs[0]["secret"])
        monkeypatch.setattr(restore.auth, "verify_password", slow)
        results: dict[str, int] = {}

        def restoring() -> None:
            results["apply"] = apply(
                client, preview["restore_id"], TEST_PASSWORD, device_name="Laptop"
            ).status_code

        def first_password() -> None:
            response = client.post("/api/setup/password", json={"password": "dazwischen", "device_name": "X"})
            results["first"] = response.status_code

        one = threading.Thread(target=restoring)
        one.start()
        assert entered.wait(10)
        two = threading.Thread(target=first_password)
        two.start()
        two.join(0.3)
        assert two.is_alive()  # wartet auf den Lock der Bremse
        release.set()
        one.join(10)
        two.join(10)
    assert results == {"apply": 202, "first": 409}


# --- Gefälschte Sicherungen ----------------------------------------------------------------------
# age prüft den Absender nicht: Eine Datei, die jemand für den öffentlichen Schlüssel des Haushalts
# verschlüsselt, kommt durch die Entschlüsselung. Dagegen steht die Prüfung des Aufbaus, und jede
# Verbindung zu einer Kopie läuft ohne Trigger und Views.

STRANGER = auth.hash_token("fremdes-token")
STRANGER_TRIGGER = (
    "CREATE TRIGGER heimlich AFTER INSERT ON devices BEGIN "
    "INSERT OR IGNORE INTO devices (id, name, token_hash, created_at) "
    f"VALUES ('fremd', 'Küche', '{STRANGER}', '2026-01-01T00:00:00.000Z'); END"
)


def renamed(old: str, new: str) -> tuple[str, ...]:
    """Was eine gefälschte Datei mit ``writable_schema`` tut: einen Eintrag umbenennen, im Namen wie in der SQL
    (bei einer View auch ``tbl_name``)."""
    return (
        "PRAGMA writable_schema = ON",
        f"UPDATE sqlite_master SET name = '{new}', sql = replace(sql, '{old}', '{new}'), "
        f"tbl_name = CASE type WHEN 'view' THEN '{new}' ELSE tbl_name END WHERE name = '{old}'",
        "PRAGMA writable_schema = OFF",
    )


def strangers(path: Path) -> list[str]:
    con = sqlite3.connect(path)
    try:
        return [row[0] for row in con.execute("SELECT id FROM devices WHERE token_hash = ?", (STRANGER,))]
    finally:
        con.close()


@pytest.mark.parametrize(
    "statements",
    [
        (STRANGER_TRIGGER, *renamed("heimlich", "sqlite_stat1")),
        ("CREATE VIEW heimlich AS SELECT * FROM devices", *renamed("heimlich", "sqlite_stat4")),
        ("CREATE TRIGGER heimlich AFTER INSERT ON zones BEGIN DELETE FROM packages; END",),
    ],
    ids=["trigger-als-statistik", "view-als-statistik", "trigger"],
)
def test_triggers_and_views_are_refused_under_any_name(bench, tmp_path, statements):
    client, phone, house = bench
    up = uploaded(client, changed_copy(house.settings, tmp_path, *statements), phone.headers)
    response = check(client, up["upload_id"], None, phone.headers)
    assert (reason(response), response.json()["error"]["message"]) == ("not_stowly", restore.TRIGGERS)
    assert client.app.state.restore.candidate is None


def test_a_comment_that_swallows_a_column_is_noticed(bench, tmp_path):
    """Der Aufbau zählt Zeichen für Zeichen: Ohne seinen Zeilenumbruch verschluckt ein ``--``-Kommentar die
    nächste Spalte (hier ``ha_links.description``), und nur Leerraum unterschiede sich."""
    client, phone, house = bench
    path = stowly_file(house.settings, tmp_path)
    con = sqlite3.connect(path, isolation_level=None)
    try:
        sql = con.execute("SELECT sql FROM sqlite_master WHERE name = 'ha_links'").fetchone()[0]
        end = sql.index("\n", sql.index("-- 1 = von Stowly angelegt"))
        con.execute("PRAGMA writable_schema = ON")
        con.execute(
            "UPDATE sqlite_master SET sql = ? WHERE name = 'ha_links'", (f"{sql[:end]} {sql[end + 1 :]}",)
        )
        con.execute("PRAGMA writable_schema = OFF")
    finally:
        con.close()
    con = sqlite3.connect(path)
    try:
        assert "description" not in [row[1] for row in con.execute("PRAGMA table_info(ha_links)")]
    finally:
        con.close()
    up = uploaded(client, path.read_bytes(), phone.headers)
    response = check(client, up["upload_id"], None, phone.headers)
    assert (reason(response), response.json()["error"]["message"]) == ("not_stowly", restore.FOREIGN_SCHEMA)


def test_statistics_of_sqlite_pass_only_in_their_own_form_and_are_dropped(bench, tmp_path):
    """Stowly ruft ANALYZE nie auf; wer es von Hand tat, kann die Sicherung trotzdem zurückspielen. Im
    Kandidaten fallen die Statistiktabellen weg; mit anderer SQL gelten sie als fremd."""
    client, phone, house = bench
    up = uploaded(client, changed_copy(house.settings, tmp_path, "ANALYZE"), phone.headers)
    assert checked(client, up["upload_id"], None, phone.headers)["counts"]["products"] == 2
    con = sqlite3.connect(client.app.state.restore.candidate.path)
    try:
        names = {row[0] for row in con.execute("SELECT name FROM sqlite_master")}
    finally:
        con.close()
    assert not names & set(restore.STAT_TABLES)
    other = changed_copy(
        house.settings,
        tmp_path,
        "ANALYZE",
        "PRAGMA writable_schema = ON",
        "UPDATE sqlite_master SET sql = 'CREATE TABLE sqlite_stat1(tbl,idx,stat,mehr)' WHERE name = 'sqlite_stat1'",
        "PRAGMA writable_schema = OFF",
    )
    up = uploaded(client, other, phone.headers)
    response = check(client, up["upload_id"], None, phone.headers)
    assert (reason(response), response.json()["error"]["message"]) == ("not_stowly", restore.FOREIGN_SCHEMA)


def test_no_trigger_ever_fires_on_a_copy_of_a_backup(settings, tmp_path, clock):
    """Käme ein Trigger doch an der Prüfung vorbei: Weder der erste Start noch die Übernahme der Zugänge
    lassen ihn laufen, und der Tausch lehnt eine solche Datei schon im ersten Schritt ab."""
    with server(settings) as client:
        phone = Device(client, "Handy", clock=clock)
    evil = tmp_path / "boese.sqlite3"
    evil.write_bytes(changed_copy(settings, tmp_path, STRANGER_TRIGGER))

    first = tmp_path / "erster-start.sqlite3"
    shutil.copyfile(evil, first)
    _token, laptop = restore._first_start(first, None, "Laptop")
    assert strangers(first) == [] and laptop["name"] == "Laptop"

    target = folder(settings)
    target.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(evil, target / restore.PENDING_DB)
    manifest = {
        "version": 1,
        "kind": "restore",
        "mode": "running",
        "source": "sqlite",
        "requested_at": format_timestamp(datetime.now(UTC)),
        "device_id": phone.id,
        "dataset_id": ids.new_uuid(),
        "schema_version": CURRENT,
        "sha256": restore.sha256_of(target / restore.PENDING_DB),
    }
    swap = restore._build_swap(target, settings.database_path, manifest, format_timestamp(datetime.now(UTC)))
    assert strangers(swap) == []
    restore._remove(swap)

    (target / restore.PENDING_MANIFEST).write_text(json.dumps(manifest), encoding="utf-8")
    assert restore.resume(settings) is RestoreState.FAILED
    assert restore.status(settings, datetime.now(UTC))["message"] == restore._failed(restore.CHANGED)
    assert strangers(settings.database_path) == []
    with server(settings) as client:
        assert client.get("/api/devices", headers=phone.headers).status_code == 200


JPEG = b"\xff\xd8\xff\xe0" + b"bild" * 40


def test_images_of_other_types_stay_behind(bench, tmp_path, caplog):
    """Bilder liefert Stowly nur als JPEG, PNG oder WebP aus; andere aus einer Sicherung fallen schon im
    Kandidaten weg (auch eines, dessen Bytes nicht zu seinem Typ passen), und das Log zählt sie."""
    caplog.set_level(logging.INFO)
    client, phone, house = bench
    images = [
        ("00000000000000000000000000000001.jpg", "image/jpeg", JPEG),
        ("00000000000000000000000000000002.html", "text/html", b"<script>alert(1)</script>"),
        ("00000000000000000000000000000003.svg", "image/svg+xml", b"<svg onload='alert(1)'/>"),
        ("00000000000000000000000000000004.png", "image/png", b"<html><script>alert(1)</script>"),
    ]
    statements = [
        "INSERT INTO images (id, content_type, data, source, source_url, created_at) "
        f"VALUES ('{image_id}', '{kind}', X'{data.hex()}', 'off', NULL, '2026-11-16T09:00:00.000Z')"
        for image_id, kind, data in images
    ]
    up = uploaded(client, changed_copy(house.settings, tmp_path, *statements), phone.headers)
    checked(client, up["upload_id"], None, phone.headers)
    con = sqlite3.connect(client.app.state.restore.candidate.path)
    try:
        kept = con.execute("SELECT id, content_type FROM images").fetchall()
    finally:
        con.close()
    assert kept == [("00000000000000000000000000000001.jpg", "image/jpeg")]
    assert "3 Bilder der Sicherung sind kein JPEG, PNG oder WebP" in caplog.text


def waiting_pairing(settings: Settings, device_id: str | None) -> tuple[str, str]:
    """Legt eine wartende Kopplung mit bekanntem Code an, die erst in Jahren abläuft, und eine gekoppelte;
    liefert den Code und die Kennung der gekoppelten."""
    code = pairing.new_code()
    paired = ids.new_uuid()
    stamp = "2026-11-16T09:00:00.000Z"
    con = db.connect(settings.database_path)
    try:
        with db.transaction(con):
            for pairing_id, code_hash, paired_at in (
                (ids.new_uuid(), pairing.code_hash(code), None),
                (paired, pairing.code_hash(pairing.new_code()), stamp),
            ):
                con.execute(
                    "INSERT INTO pi_pairings (id, code_hash, origin, device_id, created_at, expires_at, "
                    "paired_at) VALUES (?, ?, 'http://192.168.1.10:8010', ?, ?, '2099-01-01T00:00:00.000Z', ?)",
                    (pairing_id, code_hash, device_id, stamp, paired_at),
                )
    finally:
        con.close()
    return code, paired


def pairing_states(settings: Settings) -> dict[str | None, int]:
    con = db.connect(settings.database_path)
    try:
        moment = datetime.now(UTC)
        states: dict[str | None, int] = {}
        for row in con.execute("SELECT * FROM pi_pairings"):
            state = pairing.state_of(row, moment).value
            states[state] = states.get(state, 0) + 1
        return states
    finally:
        con.close()


@pytest.mark.parametrize("first_start", [False, True], ids=["laufend", "erster-start"])
def test_waiting_pi_pairings_from_a_backup_are_cancelled(settings, fresh, clock, pairs, first_start):
    """Ein Code aus einer Sicherung bekäme sonst ein Zertifikat der eigenen CA (POST /api/pi/pair)."""
    with server(settings) as client:
        phone = Device(client, "Handy", clock=clock)
    code, _paired = waiting_pairing(settings, phone.id)
    backup = sealed(settings, pairs[0]["public"])
    target = fresh if first_start else settings
    if first_start:
        with server(fresh) as client:
            armed(client)
            up = uploaded(client, backup)
            preview = checked(client, up["upload_id"], pairs[0]["secret"])
            assert (
                apply(client, preview["restore_id"], TEST_PASSWORD, device_name="Laptop").status_code == 202
            )
        assert restore.resume(fresh) is RestoreState.DONE
    else:
        restore_running(settings, phone, backup, pairs[0]["secret"])
    assert pairing_states(target) == {"cancelled": 1, "paired": 1}
    with server(target) as client:
        response = client.post("/api/pi/pair/start", json={"code": code, "hostname": "stowly-drucker"})
        assert (response.status_code, response.json()["error"]["message"]) == (409, pairing.CANCELLED)


# --- Aufräumen und Zeitgrenzen -------------------------------------------------------------------


def test_a_checked_backup_stays_until_a_new_one_passes(bench, pairs):
    """Ein zweites Gerät, das hochlädt oder eine Prüfung nicht besteht, nimmt dem ersten die geprüfte
    Sicherung nicht weg; erst eine neue, die besteht, ersetzt sie."""
    client, phone, house = bench
    tablet = house.tablet
    tablet.client = client
    up = uploaded(client, house.backup, phone.headers)
    first = checked(client, up["upload_id"], pairs[0]["secret"], phone.headers)
    other = uploaded(client, house.backup, tablet.headers)
    assert reason(check(client, other["upload_id"], pairs[1]["secret"], tablet.headers)) == "wrong_key"
    assert reason(upload(client, b"PK\x03\x04" + b"x" * 200, tablet.headers)) == "not_stowly"
    assert client.app.state.restore.candidate.id == first["restore_id"]
    assert {name for name in leftovers(house.settings) if name.startswith("upload-")} == {
        f"upload-{other['upload_id']}"  # die neue ersetzt die frühere, sobald sie ganz da ist
    }
    second = checked(client, other["upload_id"], pairs[0]["secret"], tablet.headers)
    assert {name for name in leftovers(house.settings) if name.startswith("candidate-")} == {
        f"candidate-{second['restore_id']}.sqlite3"
    }
    armed(client)
    assert apply(client, first["restore_id"], TEST_PASSWORD, phone.headers).status_code == 404
    assert apply(client, second["restore_id"], TEST_PASSWORD, tablet.headers).status_code == 202


def test_expired_uploads_and_checks_are_swept_without_another_call(bench, pairs):
    client, phone, house = bench
    manager = client.app.state.restore
    now = [datetime.now(UTC)]
    manager.clock = lambda: now[0]
    up = uploaded(client, house.backup, phone.headers)
    preview = checked(client, up["upload_id"], pairs[0]["secret"], phone.headers)
    target = folder(house.settings)
    (target / f"work-{'d' * 32}.sqlite3").write_bytes(b"x")  # ein Rest ohne Besitzer
    manager.sweep()
    assert leftovers(house.settings) == {
        f"upload-{up['upload_id']}",
        f"candidate-{preview['restore_id']}.sqlite3",
    }
    # Läuft gerade ein Schritt, bleibt alles, was er braucht.
    now[0] += timedelta(minutes=31)
    with manager.operation(counted=False):
        manager.sweep()
    assert manager.upload is not None and manager.candidate is not None
    manager.sweep()
    assert (manager.upload, manager.candidate, leftovers(house.settings)) == (None, None, set())


def test_after_seven_days_the_sweep_deletes_the_previous_database(household, pairs):
    house = household
    prepare(house, pairs)
    restore.resume(house.settings)
    manager = restore.RestoreManager(house.settings)
    manager.sweep()
    assert (folder(house.settings) / "previous.sqlite3").exists()
    manager.clock = lambda: datetime.now(UTC) + timedelta(days=RESTORE_UNDO_DAYS, minutes=1)
    manager.sweep()
    assert not (folder(house.settings) / "previous.sqlite3").exists()


def test_the_app_sweeps_on_its_own(settings, monkeypatch):
    swept = threading.Event()
    monkeypatch.setattr(restore, "SWEEP_EVERY_S", 0.01)
    monkeypatch.setattr(restore.RestoreManager, "sweep", lambda _self: swept.set())
    with server(settings):
        assert swept.wait(5)


def trickle(head: bytes, *, pause_s: float, then: int | None = None):
    """Die Teile eines Hochladens: erst ``head``, dann alle ``pause_s`` Sekunden zehn Byte (``then`` Mal; None:
    ohne Ende)."""

    async def parts():
        yield head
        count = 0
        while then is None or count < then:
            await asyncio.sleep(pause_s)
            count += 1
            yield b"y" * 10

    return parts()


@pytest.mark.parametrize(
    "limits, pause_s, message",
    [
        ({"UPLOAD_IDLE_S": 0.2}, 30.0, restore.UPLOAD_IDLE),
        ({"UPLOAD_TOTAL_S": 0.4}, 0.02, restore.UPLOAD_TOO_SLOW),
    ],
    ids=["stockt", "zu-langsam"],
)
def test_a_stalling_upload_is_cut_off_and_cleaned_up(fresh, monkeypatch, limits, pause_s, message):
    """Beim ersten Start ohne Anmeldung: Ein Hochladen, das stockt oder zu lange tröpfelt, hält den Schritt
    (und Updates) nicht auf; Stowly bricht ab (408), räumt auf, und das nächste geht wieder."""
    for name, value in limits.items():
        monkeypatch.setattr(restore, name, value)
    app = create_app(fresh, job_clock=Early())
    home = {"host": "192.168.1.10:8010", "content-type": "application/octet-stream"}
    head = b"SQLite format 3\x00" + b"x" * 100
    status, body = asgi_call(app, "PUT", "/api/restore/upload", home, trickle(head, pause_s=pause_s))
    assert (status, body["error"]["code"], body["error"]["message"]) == (408, "invalid_request", message)
    manager = app.state.restore
    assert (manager.working, manager.upload, leftovers(fresh)) == (False, None, set())
    status, body = asgi_call(app, "PUT", "/api/restore/upload", home, trickle(head, pause_s=0.0, then=3))
    assert status == 201 and body["size"] == len(head) + 30


# --- Neustart ------------------------------------------------------------------------------------


def test_after_a_restore_the_process_replaces_itself(monkeypatch):
    calls: list[tuple[str, list[str]]] = []
    monkeypatch.setattr(entry.os, "execv", lambda path, argv: calls.append((path, list(argv))))
    # Ein echtes execv kehrt nie zurück; das nachgebildete schon, dann endet main mit Exit-Code 3.
    assert entry.replace_process() == entry.STARTUP_FAILURE
    assert calls == [(sys.executable, [sys.executable, *sys.orig_argv[1:]])]

    def broken(_path, _argv):
        raise OSError(8, "Exec format error")

    monkeypatch.setattr(entry.os, "execv", broken)
    assert entry.replace_process() == entry.STARTUP_FAILURE


@pytest.fixture
def started(settings, web_dir, monkeypatch) -> list:
    """``main`` mit nachgebildeten Listenern: Der erste Lauf bittet um einen Neustart, der zweite nicht."""
    for name, value in {
        "STOWLY_DATA_DIR": str(settings.data_dir),
        "STOWLY_WEB_DIR": str(web_dir),
        "STOWLY_PASSWORD": TEST_PASSWORD,
        "STOWLY_OFF_ENABLED": "0",
    }.items():
        monkeypatch.setenv(name, value)
    for name in ("STOWLY_HTTPS_PORT", "STOWLY_BACKUP_DIR", "STOWLY_BACKUP_RECIPIENTS"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(entry, "configure_logging", lambda _level: None)
    resumed: list[Settings] = []
    monkeypatch.setattr(entry.restore, "resume", lambda current: resumed.append(current))
    served: list = []

    async def serve(self) -> int:
        served.append(self)
        if len(served) == 1:
            self.app.state.request_restart()
        return 0

    monkeypatch.setattr(entry.Listeners, "serve", serve)
    return [resumed, served]


def test_main_restarts_in_the_same_process_on_windows(started, monkeypatch):
    resumed, served = started
    monkeypatch.setattr(entry, "RESTART_IN_PROCESS", True)
    assert entry.main([]) == 0
    assert len(resumed) == 2 and len(served) == 2  # vor jedem create_app ein Tausch
    assert served[0].restart_requested is True and served[1].restart_requested is False


def test_main_replaces_the_process_on_posix(started, monkeypatch):
    resumed, served = started
    monkeypatch.setattr(entry, "RESTART_IN_PROCESS", False)
    calls: list = []
    monkeypatch.setattr(entry.os, "execv", lambda path, argv: calls.append(argv))
    assert entry.main([]) == entry.STARTUP_FAILURE  # das nachgebildete execv kehrt zurück
    assert len(resumed) == 1 and len(served) == 1 and len(calls) == 1


def test_request_restart_ends_both_listeners_cleanly(settings):
    listeners = entry.Listeners(create_app(settings, job_clock=Early()), settings)
    listeners.http.config.port = 0
    result: dict[str, int] = {}

    def run() -> None:
        import asyncio

        result["code"] = asyncio.run(listeners.serve())

    thread = threading.Thread(target=run)
    thread.start()
    for _ in range(500):
        if listeners.http.started:
            break
        thread.join(0.02)
    assert listeners.http.started
    listeners.app.state.request_restart()
    thread.join(15)
    assert not thread.is_alive()
    assert (result["code"], listeners.restart_requested) == (0, True)
    assert listeners.app.state.scheduler is None  # der Lebenszyklus der App ist abgelaufen
