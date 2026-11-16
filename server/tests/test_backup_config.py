"""Sicherung aus der App (docs/plan-einrichtung-b.md, Abschnitt 1; docs/integrationen.md, Abschnitte 3 und 12).

Schlüssel, Uhrzeit und Schalter kommen aus der Umgebung oder der App, der Ordner aus ``STOWLY_BACKUP_DIR``,
einem eingebundenen ``/backups`` oder dem Datenordner. Der Zeitplan liest das bei jedem Takt; eine Änderung
weckt ihn. „Jetzt sichern" legt dieselbe Sicherung in den Ordner, herunterladen lassen sich nur eigene
Dateien. Die Schlüsselpaare stammen aus ``docs/vectors.json`` (pyrage).
"""

import dataclasses
import gzip
import json
import logging
import os
import stat
import time
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pyrage
import pytest
from fastapi.testclient import TestClient
from support import TEST_PASSWORD, Device, events_of

from stowly import autobackup, db, scheduler, serverconfig
from stowly.api import backup as backup_api
from stowly.app import create_app
from stowly.config import Settings
from stowly.contract.api import BackupStatus, IntegrationStatus, ServerConfig

POSIX = os.name == "posix"
ROOT = POSIX and os.geteuid() == 0
NO_KEY = "Es fehlt ein öffentlicher Schlüssel (in der App oder in STOWLY_BACKUP_RECIPIENTS)."


def utc(*parts: int) -> datetime:
    return datetime(*parts, tzinfo=UTC)


@pytest.fixture
def pairs(vectors) -> list[dict[str, str]]:
    return vectors["age_keys"]["pairs"]


class Early:
    """Der Zeitplan steht auf 01:00 in Berlin: Bis 03:30 macht er von sich aus keine Sicherung. Sonst holte
    er sie gleich nach, sobald ein Schlüssel da ist (und hielte dabei den Lock für „Jetzt sichern")."""

    def now(self) -> datetime:
        return utc(2026, 11, 14, 0, 0)

    def monotonic(self) -> float:
        return 0.0

    async def sleep(self, seconds: float) -> None:
        return None


def server(settings: Settings) -> TestClient:
    return TestClient(create_app(settings, job_clock=Early()))


@pytest.fixture
def bench(settings) -> Iterator[tuple[TestClient, Device]]:
    with server(settings) as client:
        yield client, Device(client, "Handy")


def read(client: TestClient, device: Device) -> dict:
    response = client.get("/api/server-config", headers=device.headers)
    assert response.status_code == 200, response.text
    ServerConfig.model_validate(response.json())
    return response.json()["backup"]


def patch(client: TestClient, device: Device, *, password: str | None = TEST_PASSWORD, **body):
    """``PATCH /api/server-config``; mit ``backup_recipients`` samt dem Haushalts-Passwort (``password``), wie
    die App es schickt, wenn ein Schlüssel hinzukommt."""
    if "backup_recipients" in body and password is not None:
        body["current_password"] = password
    return client.patch("/api/server-config", json=body, headers=device.headers)


def backup_status(client: TestClient, device: Device) -> dict:
    response = client.get("/api/integrations", headers=device.headers)
    assert response.status_code == 200, response.text
    IntegrationStatus.model_validate(response.json())
    return response.json()["backup"]


def stored(settings: Settings, key: str):
    con = db.connect(settings.database_path)
    try:
        return serverconfig.get(con, key)
    finally:
        con.close()


def decrypt(path: Path, secret: str) -> bytes:
    return gzip.decompress(pyrage.decrypt(path.read_bytes(), [pyrage.x25519.Identity.from_str(secret)]))


def wait_for(condition, timeout_s: float = 10.0) -> None:
    deadline = time.monotonic() + timeout_s
    while not condition():
        if time.monotonic() > deadline:
            raise AssertionError("Die Bedingung trat nicht ein.")
        time.sleep(0.02)


# --- Schlüssel, Uhrzeit, Schalter aus der App ---------------------------------------------------


def test_keys_from_the_app_are_normalized_and_make_the_backup_work(bench, settings, pairs):
    client, device = bench
    first, second = pairs[0]["public"], pairs[1]["public"]
    response = patch(client, device, backup_recipients=[f" {first} ", second.upper(), first])
    assert response.status_code == 200, response.text
    backup = response.json()["backup"]
    assert [entry["key"] for entry in backup["recipients"]] == [first, second]  # klein, ohne Doppelte
    assert [entry["short"] for entry in backup["recipients"]] == [
        f"{key[:8]}…{key[-4:]}" for key in (first, second)
    ]
    assert all(entry["added_at"] is not None for entry in backup["recipients"])
    assert (backup["recipients_source"], backup["enabled"], backup["enabled_source"]) == (
        "app",
        True,
        "default",
    )
    assert (backup["time"], backup["time_source"]) == ("03:30", "default")
    assert (backup["folder"], backup["folder_source"], backup["folder_problem"]) == (
        str(settings.data_dir / "backups"),
        "data",
        None,
    )
    status = backup_status(client, device)
    assert (status["configured"], status["problem"], status["time"]) == (True, None, "03:30")
    assert status["recipients"] == [entry["short"] for entry in backup["recipients"]]
    events = [e for e in events_of(client, device, entity="server") if e["type"] == "server.config_changed"]
    assert [e["data"] for e in events] == [{"keys": ["backup_recipients"]}]
    assert first not in json.dumps(events)


def test_a_key_that_stays_keeps_its_time_and_an_empty_list_removes_all(bench, settings, pairs):
    client, device = bench
    first, second = pairs[0]["public"], pairs[1]["public"]
    added = patch(client, device, backup_recipients=[first]).json()["backup"]["recipients"][0]["added_at"]
    time.sleep(0.01)
    both = patch(client, device, backup_recipients=[second, first]).json()["backup"]["recipients"]
    assert [(entry["key"], entry["added_at"] == added) for entry in both] == [(second, False), (first, True)]
    # Dieselbe Liste noch einmal: keine Änderung, kein Ereignis.
    assert patch(client, device, backup_recipients=[second, first]).status_code == 200
    empty = patch(client, device, backup_recipients=[]).json()["backup"]
    assert (empty["recipients"], empty["recipients_source"]) == ([], "default")
    assert stored(settings, serverconfig.BACKUP_RECIPIENTS) is None
    changes = [e for e in events_of(client, device, entity="server") if e["type"] == "server.config_changed"]
    assert len(changes) == 3


@pytest.mark.parametrize("variant", ["secret", "lower", "spaced"])
def test_a_secret_key_is_refused_and_never_repeated(bench, settings, vectors, pairs, caplog, variant):
    caplog.set_level(logging.DEBUG)
    client, device = bench
    secret = pairs[0]["secret"]
    given = {"secret": secret, "lower": secret.lower(), "spaced": f"  {secret}\n"}[variant]
    response = patch(client, device, backup_recipients=[pairs[1]["public"], given])
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["details"]["errors"] == [
        {"loc": ["body", "backup_recipients", 1], "msg": serverconfig.SECRET_KEY, "type": "backup_recipient"}
    ]
    for text in (response.text, caplog.text, json.dumps(read(client, device))):
        assert secret not in text and secret.lower() not in text and secret[20:40] not in text
    assert stored(settings, serverconfig.BACKUP_RECIPIENTS) is None  # nichts geändert


def test_invalid_public_keys_are_422_with_their_place(bench, vectors):
    client, device = bench
    invalid = [
        key for key in vectors["age_keys"]["invalid_publics"] if not key.upper().startswith("AGE-SECRET")
    ]
    response = patch(client, device, backup_recipients=invalid)
    assert response.status_code == 422
    errors = response.json()["error"]["details"]["errors"]
    assert [error["loc"] for error in errors] == [
        ["body", "backup_recipients", i] for i in range(len(invalid))
    ]
    assert {error["msg"] for error in errors} == {serverconfig.NOT_A_RECIPIENT}
    for body in (
        {"backup_recipients": [vectors["age_keys"]["pairs"][0]["public"]] * 11},
        {"backup_recipients": [""]},
    ):
        assert patch(client, device, **body).status_code == 422


def test_time_and_switch_from_the_app(bench, settings, pairs):
    client, device = bench
    assert patch(client, device, backup_recipients=[pairs[0]["public"]]).status_code == 200
    timed = patch(client, device, backup_time="04:15").json()["backup"]
    assert (timed["time"], timed["time_source"]) == ("04:15", "app")
    assert backup_status(client, device)["time"] == "04:15"
    off = patch(client, device, backup_enabled=False).json()["backup"]
    assert (off["enabled"], off["enabled_source"]) == (False, "app")
    status = backup_status(client, device)
    assert (status["configured"], status["problem"], status["next_at"]) == (
        False,
        serverconfig.BACKUP_SWITCHED_OFF,
        None,
    )
    assert patch(client, device, backup_enabled=True).json()["backup"]["enabled"] is True
    back = patch(client, device, backup_time=None).json()["backup"]
    assert (back["time"], back["time_source"]) == ("03:30", "default")
    for body in (
        {"backup_time": "4:15"},
        {"backup_time": "24:00"},
        {"backup_enabled": None},
        {"backup_enabled": "ja"},
    ):
        assert patch(client, device, **body).status_code == 422, body


def test_the_environment_goes_first(settings, pairs, tmp_path):
    folder = tmp_path / "eigener-ordner"
    folder.mkdir()
    fixed = dataclasses.replace(
        settings, backup_recipients=(pairs[0]["public"],), backup_time="02:15", backup_dir=folder
    )
    with server(fixed) as client:
        device = Device(client, "Handy")
        # Was in der App steht, zählt nicht, solange die Umgebung etwas sagt.
        con = db.connect(fixed.database_path)
        try:
            with db.transaction(con):
                serverconfig.put(
                    con, serverconfig.BACKUP_ENABLED, False, now="2026-11-16T09:00:00.000Z", by=None
                )
                serverconfig.put(
                    con,
                    serverconfig.BACKUP_RECIPIENTS,
                    [{"key": pairs[1]["public"], "added_at": "2026-11-16T09:00:00.000Z"}],
                    now="2026-11-16T09:00:00.000Z",
                    by=None,
                )
        finally:
            con.close()
        backup = read(client, device)
        assert backup == {
            "enabled": True,
            "enabled_source": "env",
            "recipients": [
                {
                    "key": pairs[0]["public"],
                    "short": serverconfig.short_key(pairs[0]["public"]),
                    "added_at": None,
                }
            ],
            "recipients_source": "env",
            "time": "02:15",
            "time_source": "env",
            "folder": str(folder),
            "folder_source": "env",
            "folder_problem": None,
            "folder_hint": None,
        }
        for body in (
            {"backup_recipients": [pairs[1]["public"]]},
            {"backup_recipients": []},
            {"backup_enabled": False},
            {"backup_time": "04:00"},
            {"backup_time": None},
        ):
            response = patch(client, device, **body)
            assert response.status_code == 409, body
            assert response.json()["error"]["code"] == "conflict"


def test_only_the_time_from_the_environment_leaves_keys_and_switch_to_the_app(settings, pairs):
    timed = dataclasses.replace(settings, backup_time="05:00")
    with server(timed) as client:
        device = Device(client, "Handy")
        assert patch(client, device, backup_time="04:00").status_code == 409
        response = patch(client, device, backup_recipients=[pairs[0]["public"]], backup_enabled=True)
        assert response.status_code == 200
        backup = response.json()["backup"]
        assert (backup["time"], backup["time_source"], backup["enabled_source"]) == ("05:00", "env", "app")


# --- Ein neuer Schlüssel braucht das Haushalts-Passwort ------------------------------------------

WRONG = "nicht-das-haushaltspasswort"


def test_adding_a_key_needs_the_household_password(bench, settings, pairs, caplog):
    """Ein Geräte-Token allein genügt nicht: Wer einen Schlüssel hinzufügt, liest jede künftige Sicherung samt
    Passwort-Hash. Entfernen, Umsortieren, Schalter und Uhrzeit gehen ohne Passwort."""
    caplog.set_level(logging.DEBUG)
    client, device = bench
    first, second = pairs[0]["public"], pairs[1]["public"]
    missing = patch(client, device, password=None, backup_recipients=[first])
    assert missing.status_code == 422
    assert missing.json()["error"]["message"] == serverconfig.PASSWORD_NEEDED
    assert missing.json()["error"]["details"]["errors"] == [
        {"loc": ["body", "current_password"], "msg": serverconfig.PASSWORD_NEEDED, "type": "missing"}
    ]
    wrong = patch(client, device, password=WRONG, backup_recipients=[first])
    assert (wrong.status_code, wrong.json()["error"]["code"]) == (401, "invalid_password")
    assert stored(settings, serverconfig.BACKUP_RECIPIENTS) is None  # nichts geändert
    assert client.get("/api/server-config", headers=device.headers).status_code == 200  # weiter angemeldet

    # Das Passwort aus der Umgebung (STOWLY_PASSWORD) gilt.
    assert patch(client, device, backup_recipients=[first]).status_code == 200
    assert patch(client, device, password=None, backup_recipients=[second, first]).status_code == 422
    assert patch(client, device, backup_recipients=[second, first]).status_code == 200
    for unchanged in ([first.upper(), second], [second], []):
        assert patch(client, device, password=None, backup_recipients=unchanged).status_code == 200
    assert patch(client, device, password=None, backup_enabled=False, backup_time="04:00").status_code == 200
    # Wieder hinzufügen braucht es wieder; ein Passwort, das nicht nötig ist, zählt nicht.
    assert patch(client, device, password=None, backup_recipients=[first]).status_code == 422
    assert patch(client, device, password=WRONG, backup_time="05:00").status_code == 200

    events = [e for e in events_of(client, device, entity="server") if e["type"] == "server.config_changed"]
    for text in (caplog.text, json.dumps(events)):
        assert TEST_PASSWORD not in text and WRONG not in text


def test_a_wrong_password_for_a_key_counts_in_the_login_guard(bench, pairs):
    client, device = bench
    for _ in range(5):
        response = patch(client, device, password=WRONG, backup_recipients=[pairs[0]["public"]])
        assert (response.status_code, response.json()["error"]["code"]) == (401, "invalid_password")
    locked = patch(client, device, backup_recipients=[pairs[0]["public"]])  # das richtige, aber zu spät
    assert locked.status_code == 429 and int(locked.headers["retry-after"]) > 0
    # Dieselbe Bremse wie die Anmeldung.
    login = client.post("/api/auth/login", json={"password": TEST_PASSWORD, "device_name": "Neu"})
    assert login.status_code == 429


def test_the_password_set_in_the_app_counts_too(settings, pairs):
    bare = dataclasses.replace(settings, password=None)
    with server(bare) as client:
        first = client.post("/api/setup/password", json={"password": "aus-der-app-1", "device_name": "Handy"})
        headers = {"Authorization": f"Bearer {first.json()['token']}"}

        def add(password: str):
            body = {"backup_recipients": [pairs[0]["public"]], "current_password": password}
            return client.patch("/api/server-config", json=body, headers=headers)

        assert add(TEST_PASSWORD).status_code == 401
        assert add("aus-der-app-1").status_code == 200


def test_a_key_removed_meanwhile_does_not_come_back_without_the_password(bench, settings, pairs, monkeypatch):
    """Zwei Geräte zugleich: Das eine entfernt einen Schlüssel, das andere schickt die alte Liste ohne Passwort.
    Das zweite bekommt 409 statt den entfernten Schlüssel stillschweigend zurückzubringen."""
    client, device = bench
    first, second = pairs[0]["public"], pairs[1]["public"]
    assert patch(client, device, backup_recipients=[first, second]).status_code == 200
    real = serverconfig._adds_key
    calls: list[bool] = []

    def meanwhile(con, keys):
        result = real(con, keys)
        if not calls:
            other = db.connect(settings.database_path)
            try:
                with db.transaction(other):
                    serverconfig._store_recipients(
                        other, [second], now="2026-11-16T09:00:00.000Z", by=device.id
                    )
            finally:
                other.close()
        calls.append(result)
        return result

    monkeypatch.setattr(serverconfig, "_adds_key", meanwhile)
    response = patch(client, device, password=None, backup_recipients=[first, second])
    assert (response.status_code, response.json()["error"]["message"]) == (
        409,
        serverconfig.RECIPIENTS_CHANGED,
    )
    assert calls == [False, True]
    assert [entry["key"] for entry in stored(settings, serverconfig.BACKUP_RECIPIENTS)] == [second]


# --- Der Ordner -------------------------------------------------------------------------------


def mountinfo(tmp_path: Path, *points: str) -> Path:
    """Eine nachgebildete ``/proc/self/mountinfo`` mit den Einhängepunkten (Leerzeichen als ``\\040``)."""
    lines = ["22 1 0:21 / / rw,relatime - overlay overlay rw"]
    for number, point in enumerate(points, start=30):
        escaped = point.replace(" ", "\\040")
        lines.append(
            f"{number} 22 8:1 /volume1/docker/stowly/backups {escaped} rw,noatime - btrfs /dev/md2 rw"
        )
    path = tmp_path / "mountinfo"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def test_mount_points_are_read_from_mountinfo(tmp_path):
    path = mountinfo(tmp_path, "/backups", "/mit leer zeichen")
    assert serverconfig.mount_points(path) == {"/", "/backups", "/mit leer zeichen"}
    assert serverconfig.mount_points(tmp_path / "fehlt") == set()


def test_a_mounted_and_writable_backups_folder_is_used(settings, tmp_path, monkeypatch):
    mounted = tmp_path / "eingebunden"
    mounted.mkdir()
    monkeypatch.setattr(serverconfig, "MOUNTED_BACKUPS", mounted)
    monkeypatch.setattr(serverconfig, "MOUNTINFO", mountinfo(tmp_path, mounted.as_posix()))
    folder = serverconfig.backup_folder(settings)
    assert (folder.path, folder.source, folder.problem, folder.hint) == (mounted, "mounted", None, None)
    # Nicht eingebunden (nur ein Ordner im Container): der Datenordner.
    monkeypatch.setattr(serverconfig, "MOUNTINFO", mountinfo(tmp_path))
    assert serverconfig.backup_folder(settings).source == "data"


def test_a_mounted_folder_that_is_missing_falls_back_to_the_data_folder(
    settings, tmp_path, monkeypatch, caplog
):
    caplog.set_level(logging.WARNING, logger="stowly")
    settings.data_dir.mkdir(parents=True)
    missing = tmp_path / "weg"
    monkeypatch.setattr(serverconfig, "MOUNTED_BACKUPS", missing)
    monkeypatch.setattr(serverconfig, "MOUNTINFO", mountinfo(tmp_path, missing.as_posix()))
    monkeypatch.setattr(serverconfig, "_warned", set())
    folder = serverconfig.backup_folder(settings)
    assert (folder.path, folder.source, folder.problem) == (settings.data_dir / "backups", "data", None)
    # Die App bekommt den Grund als Hinweis (BackupConfig.folder_hint), nicht nur das Log.
    assert folder.hint == serverconfig.BACKUP_MOUNTED_UNUSABLE.format(
        folder=missing.as_posix(), problem=serverconfig.BACKUP_MISSING_DIR
    )
    serverconfig.backup_folder(settings)
    assert caplog.text.count("ist eingebunden, taugt aber nicht") == 1  # einmal je Prozess


@pytest.mark.skipif(not POSIX or ROOT, reason="Rechte eines Ordners gibt es so nur unter POSIX, ohne root")
def test_a_mounted_folder_that_uid_10001_cannot_write_falls_back(settings, tmp_path, monkeypatch):
    mounted = tmp_path / "eingebunden"
    mounted.mkdir()
    mounted.chmod(0o500)
    try:
        monkeypatch.setattr(serverconfig, "MOUNTED_BACKUPS", mounted)
        monkeypatch.setattr(serverconfig, "MOUNTINFO", mountinfo(tmp_path, mounted.as_posix()))
        assert serverconfig.backup_folder(settings).source == "data"
    finally:
        mounted.chmod(0o700)


def test_the_folder_from_the_environment_is_never_created(settings, tmp_path):
    missing = tmp_path / "fehlt"
    folder = serverconfig.backup_folder(dataclasses.replace(settings, backup_dir=missing), create=True)
    assert (folder.source, folder.problem) == ("env", serverconfig.BACKUP_MISSING_DIR)
    assert not missing.exists()


def test_the_data_folder_is_created_on_first_use_only(settings, pairs):
    with server(settings) as client:
        device = Device(client, "Handy")
        assert patch(client, device, backup_recipients=[pairs[0]["public"]]).status_code == 200
        folder = settings.data_dir / "backups"
        assert read(client, device)["folder_problem"] is None
        assert not folder.exists()  # Lesen legt nichts an
        assert client.post("/api/backup/run", headers=device.headers).status_code == 200
        assert folder.is_dir()
        if POSIX:
            assert stat.S_IMODE(folder.stat().st_mode) == 0o700


@pytest.mark.skipif(not POSIX or ROOT, reason="Rechte eines Ordners gibt es so nur unter POSIX, ohne root")
def test_a_folder_from_the_environment_that_is_not_writable(settings, pairs, tmp_path):
    folder = tmp_path / "nur-lesen"
    folder.mkdir()
    folder.chmod(0o500)
    try:
        fixed = dataclasses.replace(settings, backup_dir=folder)
        with server(fixed) as client:
            device = Device(client, "Handy")
            patch(client, device, backup_recipients=[pairs[0]["public"]])
            assert read(client, device)["folder_problem"] == serverconfig.BACKUP_NOT_WRITABLE
            response = client.post("/api/backup/run", headers=device.headers)
            assert (response.status_code, response.json()["error"]["message"]) == (
                503,
                serverconfig.BACKUP_NOT_WRITABLE,
            )
    finally:
        folder.chmod(0o700)


# --- Der Zeitplan ruht und erwacht ---------------------------------------------------------------


class FakeClock:
    def __init__(self, now: datetime) -> None:
        self.value = now

    def now(self) -> datetime:
        return self.value

    def monotonic(self) -> float:
        return self.value.timestamp()

    async def sleep(self, seconds: float) -> None:
        self.value += timedelta(seconds=seconds)


def test_the_job_rests_without_keys_and_a_change_in_the_app_wakes_it(settings, pairs, monkeypatch):
    """20:15 in Berlin, heute lief noch keine: Ohne Schlüssel ruht die Sicherung. Kommt ein Schlüssel, weckt
    die Änderung den Zeitplan sofort, nicht erst zur nächsten vollen Minute."""
    checks: list[bool] = []
    real_due = autobackup.BackupJob.due

    def spy(self, run, now):
        result = real_due(self, run, now)
        checks.append(result)
        return result

    monkeypatch.setattr(autobackup.BackupJob, "due", spy)
    clock = FakeClock(utc(2026, 11, 14, 19, 15, 1))  # die nächste volle Minute ist fast eine Minute weg
    folder = settings.data_dir / "backups"
    with TestClient(create_app(settings, job_clock=clock)) as client:
        device = Device(client, "Handy")
        wait_for(lambda: checks)  # der erste Takt nach dem Start
        assert checks == [False] and not folder.exists()
        assert patch(client, device, backup_recipients=[pairs[0]["public"]]).status_code == 200
        wait_for(lambda: folder.is_dir() and any(folder.iterdir()), 5.0)
        wait_for(lambda: backup_status(client, device)["last_file"] is not None, 5.0)
        status = backup_status(client, device)
    assert [entry.name for entry in folder.iterdir()] == ["stowly-2026-11-14-2015.sqlite3.gz.age"]
    assert status["last_file"] == "stowly-2026-11-14-2015.sqlite3.gz.age"
    assert checks[-1] is True


def test_due_follows_the_settings_from_the_app(settings, pairs):
    create_app(settings)  # legt die Datenbank an
    job = autobackup.BackupJob(settings)
    fresh = scheduler.JobRun("backup")

    def change(key: str, value) -> None:
        con = db.connect(settings.database_path)
        try:
            with db.transaction(con):
                serverconfig.put(con, key, value, now="2026-11-14T00:00:00.000Z", by=None)
        finally:
            con.close()

    at_0400 = utc(2026, 11, 14, 3, 0)  # 04:00 in Berlin
    assert not job.due(fresh, at_0400)  # ohne Schlüssel
    change(
        serverconfig.BACKUP_RECIPIENTS, [{"key": pairs[0]["public"], "added_at": "2026-11-14T00:00:00.000Z"}]
    )
    assert job.due(fresh, at_0400)
    change(serverconfig.BACKUP_TIME, "04:15")
    assert not job.due(fresh, at_0400)
    assert job.due(fresh, utc(2026, 11, 14, 3, 15))
    change(serverconfig.BACKUP_ENABLED, False)
    assert not job.due(fresh, utc(2026, 11, 14, 3, 15))


# --- Jetzt sichern -------------------------------------------------------------------------------


def test_backup_now_writes_the_same_backup_and_counts_for_the_day(bench, settings, pairs, monkeypatch):
    client, device = bench
    monkeypatch.setattr(backup_api, "server_now", lambda: utc(2026, 11, 14, 9, 41, 30))
    assert (
        patch(client, device, backup_recipients=[pairs[0]["public"], pairs[1]["public"]]).status_code == 200
    )
    response = client.post("/api/backup/run", headers=device.headers)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    path = settings.data_dir / "backups" / "stowly-2026-11-14-1041.sqlite3.gz.age"
    assert body == {"name": path.name, "size": path.stat().st_size, "created_at": "2026-11-14T09:41:00.000Z"}
    for pair in pairs[:2]:  # jeder Schlüssel öffnet sie allein
        assert decrypt(path, pair["secret"]).startswith(b"SQLite format 3\x00")
    con = db.connect(settings.database_path)
    try:
        run = scheduler.load_run(con, "backup")
    finally:
        con.close()
    assert (run.last_date, run.state["file"]) == ("2026-11-14", path.name)  # die Sicherung des Tages
    status = backup_status(client, device)
    assert status["files"] == [body]
    assert (status["last_file"], status["last_size"]) == (path.name, body["size"])


def test_backup_now_needs_a_key_and_a_folder(bench, settings, pairs, tmp_path):
    client, device = bench
    response = client.post("/api/backup/run", headers=device.headers)
    assert (response.status_code, response.json()["error"]) == (
        503,
        {"code": "not_configured", "message": NO_KEY, "details": None},
    )
    missing = dataclasses.replace(
        settings, backup_dir=tmp_path / "fehlt", backup_recipients=(pairs[0]["public"],)
    )
    with server(missing) as other:
        phone = Device(other, "Handy")
        response = other.post("/api/backup/run", headers=phone.headers)
        assert (response.status_code, response.json()["error"]["message"]) == (
            503,
            serverconfig.BACKUP_MISSING_DIR,
        )


def test_backup_now_also_works_when_the_daily_backup_is_off(bench, pairs):
    client, device = bench
    patch(client, device, backup_recipients=[pairs[0]["public"]], backup_enabled=False)
    assert client.post("/api/backup/run", headers=device.headers).status_code == 200


def test_backup_now_at_most_once_a_minute(bench, pairs, monkeypatch):
    client, device = bench
    patch(client, device, backup_recipients=[pairs[0]["public"]])
    moment = [1000.0]
    monkeypatch.setattr(backup_api, "monotonic", lambda: moment[0])
    assert client.post("/api/backup/run", headers=device.headers).status_code == 200
    moment[0] += 20
    response = client.post("/api/backup/run", headers=device.headers)
    assert response.status_code == 429
    assert response.headers["retry-after"] == "40"
    assert response.json()["error"]["details"] == {"retry_after_s": 40}
    moment[0] += 40
    assert client.post("/api/backup/run", headers=device.headers).status_code == 200


def test_backup_now_while_one_runs_is_409(bench, pairs):
    client, device = bench
    patch(client, device, backup_recipients=[pairs[0]["public"]])
    assert autobackup._RUNNING.acquire(blocking=False)
    try:
        response = client.post("/api/backup/run", headers=device.headers)
    finally:
        autobackup._RUNNING.release()
    assert (response.status_code, response.json()["error"]["code"]) == (409, "conflict")
    # Der abgewiesene Druck zählt nicht für die Bremse: Gleich danach geht es.
    assert client.post("/api/backup/run", headers=device.headers).status_code == 200


def test_a_failing_backup_now_says_why_and_is_remembered(bench, settings, pairs, monkeypatch):
    client, device = bench
    patch(client, device, backup_recipients=[pairs[0]["public"]])

    def broken(*_args):
        raise pyrage.EncryptError("kaputt")

    monkeypatch.setattr(autobackup.pyrage, "encrypt", broken)
    response = client.post("/api/backup/run", headers=device.headers)
    assert (response.status_code, response.json()["error"]["message"]) == (500, autobackup.NOT_ENCRYPTED)
    assert backup_status(client, device)["last_error"] == autobackup.NOT_ENCRYPTED


def test_the_daily_run_waits_while_a_manual_one_runs(settings, pairs):
    create_app(settings)
    keyed = dataclasses.replace(settings, backup_recipients=(pairs[0]["public"],))
    assert autobackup._RUNNING.acquire(blocking=False)
    try:
        assert autobackup.run_backup(keyed, utc(2026, 11, 14, 2, 30)) is False
    finally:
        autobackup._RUNNING.release()
    con = db.connect(settings.database_path)
    try:
        assert scheduler.load_run(con, "backup") == scheduler.JobRun("backup")  # nichts vermerkt
    finally:
        con.close()


# --- Herunterladen -------------------------------------------------------------------------------


def test_download_an_own_backup(bench, settings, pairs):
    client, device = bench
    patch(client, device, backup_recipients=[pairs[0]["public"]])
    name = client.post("/api/backup/run", headers=device.headers).json()["name"]
    response = client.get(f"/api/backup/files/{name}", headers=device.headers)
    assert response.status_code == 200
    assert response.content == (settings.data_dir / "backups" / name).read_bytes()
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["content-disposition"] == f'attachment; filename="{name}"'
    assert int(response.headers["content-length"]) == len(response.content)
    assert client.get(f"/api/backup/files/{name}").status_code == 401


@pytest.mark.parametrize(
    "name",
    [
        "stowly.sqlite3",
        "..%2Fstowly.sqlite3",
        "%2E%2E%2Fstowly.sqlite3",
        "notizen.txt",
        "stowly-2026-02-30-0330.sqlite3.gz.age",  # Muster, aber kein Tag
        "stowly-2026-11-14-2460.sqlite3.gz.age",  # Muster, aber keine Uhrzeit
        "STOWLY-2026-11-14-0330.sqlite3.gz.age",
        "stowly-2026-11-14-0330.sqlite3.gz.age.bak",
        "stowly-2026-11-14-0330.sqlite3.gz",
        "stowly-2026-11-14-0331.sqlite3.gz.age",  # gibt es nicht
        "ordner-stowly-2026-11-14-0330.sqlite3.gz.age",
    ],
)
def test_download_refuses_everything_else(bench, settings, name):
    client, device = bench
    folder = settings.data_dir / "backups"
    folder.mkdir()
    (folder / "notizen.txt").write_text("fremd", encoding="utf-8")
    (folder / "stowly-2026-11-14-0330.sqlite3.gz").write_bytes(b"fremd")
    (folder / "stowly-2026-11-14-0330.sqlite3.gz.age.bak").write_bytes(b"fremd")
    response = client.get(f"/api/backup/files/{name}", headers=device.headers)
    assert response.status_code == 404, name
    assert response.json()["error"]["code"] == "not_found"


def test_download_refuses_paths_and_folders(bench, settings):
    client, device = bench
    folder = settings.data_dir / "backups"
    (folder / "stowly-2026-11-14-0330.sqlite3.gz.age").mkdir(parents=True)  # ein Ordner mit eigenem Namen
    for path in (
        "/api/backup/files/stowly-2026-11-14-0330.sqlite3.gz.age",
        "/api/backup/files/../../stowly.sqlite3",
        "/api/backup/files/..%2F..%2Fstowly.sqlite3",
        "/api/backup/files/%2E%2E/stowly.sqlite3",
        "/api/backup/files/",
    ):
        assert client.get(path, headers=device.headers).status_code == 404, path


@pytest.mark.skipif(not POSIX, reason="Symlinks lassen sich unter Windows nur mit Sonderrechten anlegen")
def test_download_never_follows_a_link(bench, settings):
    client, device = bench
    folder = settings.data_dir / "backups"
    folder.mkdir()
    (folder / "stowly-2026-11-14-0330.sqlite3.gz.age").symlink_to(settings.database_path)
    response = client.get("/api/backup/files/stowly-2026-11-14-0330.sqlite3.gz.age", headers=device.headers)
    assert response.status_code == 404


def test_the_status_lists_own_files_newest_first_at_most_50(bench, settings, pairs):
    client, device = bench
    patch(client, device, backup_recipients=[pairs[0]["public"]])
    folder = settings.data_dir / "backups"
    folder.mkdir()
    for day in range(1, 31):
        for hhmm in ("0330", "1530"):
            (folder / f"stowly-2026-10-{day:02d}-{hhmm}.sqlite3.gz.age").write_bytes(b"x" * day)
    (folder / "notizen.txt").write_text("fremd", encoding="utf-8")
    (folder / "stowly-2026-12-24-0330.sqlite3.gz.age.bak").write_bytes(b"fremd")
    files = backup_status(client, device)["files"]
    BackupStatus.model_validate(backup_status(client, device))
    assert len(files) == 50
    assert files[0] == {
        "name": "stowly-2026-10-30-1530.sqlite3.gz.age",
        "size": 30,
        "created_at": "2026-10-30T14:30:00.000Z",  # Winterzeit: 15:30 in Berlin
    }
    assert files[-1]["name"] == "stowly-2026-10-06-0330.sqlite3.gz.age"
    assert files[-1]["created_at"] == "2026-10-06T01:30:00.000Z"  # Sommerzeit
    assert [entry["name"] for entry in files] == sorted((entry["name"] for entry in files), reverse=True)


# --- Assistent ---------------------------------------------------------------------------------


def test_the_setup_step_is_ready_with_keys_and_a_first_backup(bench, pairs):
    client, device = bench

    def ready() -> bool:
        steps = client.get("/api/setup", headers=device.headers).json()["steps"]
        return next(step["ready"] for step in steps if step["id"] == "backup")

    assert ready() is False
    patch(client, device, backup_recipients=[pairs[0]["public"]])
    assert ready() is False  # noch keine gelungene Sicherung
    assert client.post("/api/backup/run", headers=device.headers).status_code == 200
    assert ready() is True
    patch(client, device, backup_enabled=False)
    assert ready() is False  # nicht mehr wirksam


def test_the_start_names_the_backup_in_the_log(settings, pairs, caplog):
    caplog.set_level(logging.INFO, logger="stowly")
    keyed = dataclasses.replace(settings, backup_recipients=(pairs[0]["public"],), backup_time="04:45")
    with server(keyed):
        pass
    assert "Automatische Sicherung täglich um 04:45" in caplog.text
    assert pairs[0]["public"] not in caplog.text


def test_status_on_a_new_database_without_the_app(settings):
    """``autobackup.status`` öffnet ohne Verbindung eine eigene (etwa im Thread des Zeitplans)."""
    db.initialise(settings.database_path)
    status = autobackup.status(settings, scheduler.JobRun("backup"), utc(2026, 11, 14, 12, 0))
    assert (status["configured"], status["folder"], status["files"]) == (
        False,
        str(settings.data_dir / "backups"),
        [],
    )


def test_a_broken_value_in_the_table_counts_as_none(bench, settings, pairs):
    client, device = bench
    con = db.connect(settings.database_path)
    try:
        with db.transaction(con):
            for key, value in (
                (serverconfig.BACKUP_ENABLED, "ja"),
                (serverconfig.BACKUP_TIME, "25:00"),
                (
                    serverconfig.BACKUP_RECIPIENTS,
                    [{"key": "age1kaputt"}, "kein Objekt", {"key": pairs[0]["public"]}],
                ),
            ):
                serverconfig.put(con, key, value, now="2026-11-16T09:00:00.000Z", by=None)
    finally:
        con.close()
    backup = read(client, device)
    assert (backup["enabled"], backup["enabled_source"], backup["time"], backup["time_source"]) == (
        True,
        "default",
        "03:30",
        "default",
    )
    assert [entry["key"] for entry in backup["recipients"]] == [pairs[0]["public"]]
    assert backup["recipients"][0]["added_at"] is None
