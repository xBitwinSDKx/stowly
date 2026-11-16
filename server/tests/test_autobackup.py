"""Automatische, verschlüsselte Sicherungen (docs/integrationen.md, Abschnitt 3).

Verschlüsselt wird an Testschlüssel, die der Test selbst erzeugt; entschlüsselt mit ``pyrage`` wie
``age -d``. Keine Datei verlässt das temporäre Verzeichnis des Tests.
"""

import asyncio
import dataclasses
import errno
import gzip
import os
import sqlite3
import stat
import sys
import time
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pyrage
import pytest
from fastapi.testclient import TestClient
from support import TEST_PASSWORD, Device

from stowly import autobackup, db, scheduler
from stowly.app import create_app
from stowly.config import Settings
from stowly.contract import ids

AGE_HEADER = b"age-encryption.org/v1\n"


def utc(*parts: int) -> datetime:
    return datetime(*parts, tzinfo=UTC)


@pytest.fixture
def identities() -> list[pyrage.x25519.Identity]:
    """Zwei private Schlüssel, wie sie der Betreiber mit age-keygen erzeugt (einer im Passwortmanager,
    einer ausgedruckt). Der Server bekommt nur die öffentlichen."""
    return [pyrage.x25519.Identity.generate() for _ in range(2)]


@pytest.fixture
def folder(tmp_path) -> Path:
    path = tmp_path / "backups"
    path.mkdir()
    return path


@pytest.fixture
def backup_settings(tmp_path, web_dir, folder, identities) -> Settings:
    return Settings.from_env(
        {
            "STOWLY_DATA_DIR": str(tmp_path / "data"),
            "STOWLY_WEB_DIR": str(web_dir),
            "STOWLY_PASSWORD": TEST_PASSWORD,
            "STOWLY_OFF_ENABLED": "0",
            "STOWLY_BACKUP_DIR": str(folder),
            "STOWLY_BACKUP_RECIPIENTS": ",".join(str(identity.to_public()) for identity in identities),
        },
        dev=False,
    )


@pytest.fixture
def household(backup_settings, clock) -> dict:
    """Ein Haushalt mit Produkt, Packungen und Einkaufsliste in der Datenbank der Sicherung.

    Der Zeitplan der App steht dabei auf 01:00 in Berlin: Er soll hier noch keine Sicherung machen.
    """
    early = FakeClock(utc(2026, 11, 14, 0, 0))
    with TestClient(create_app(backup_settings, job_clock=early)) as client:
        device = Device(client, "Handy", clock=clock)
        device.sync()
        product_id, package_id = device.store("Basmati Reis", best_before="2027-03-25")
        item_id = ids.new_uuid()
        device.sync([device.cmd("shopping_item.create", item_id=item_id, text="Grillkohle")])
    return {"product": product_id, "package": package_id, "item": item_id}


def open_backup(path: Path, identity: pyrage.x25519.Identity, tmp_path: Path) -> sqlite3.Connection:
    """Wie beim Zurückspielen: ``age -d -i schluessel.txt … | gunzip > stowly.sqlite3``."""
    plain = gzip.decompress(pyrage.decrypt(path.read_bytes(), [identity]))
    assert plain.startswith(b"SQLite format 3\x00")
    target = tmp_path / f"zurueck-{len(list(tmp_path.glob('zurueck-*')))}.sqlite3"
    target.write_bytes(plain)
    con = sqlite3.connect(target)
    con.row_factory = sqlite3.Row
    return con


def job_run(settings: Settings) -> scheduler.JobRun:
    con = db.connect(settings.database_path)
    try:
        return scheduler.load_run(con, "backup")
    finally:
        con.close()


def names(folder: Path) -> set[str]:
    return {entry.name for entry in folder.iterdir()}


# --- Eine Sicherung ------------------------------------------------------------------------


def test_a_backup_opens_with_every_key_and_is_the_database_with_a_new_dataset_id(
    backup_settings, household, folder, identities, tmp_path
):
    now = utc(2026, 11, 14, 2, 30)  # 03:30 in Berlin
    assert autobackup.run_backup(backup_settings, now) is True

    expected = "stowly-2026-11-14-0330.sqlite3.gz.age"
    assert names(folder) == {expected}  # keine Zwischendatei, keine Klartextdatei
    path = folder / expected
    data = path.read_bytes()
    assert data.startswith(AGE_HEADER)  # binäres Format von age, kein ASCII-Armor
    assert b"SQLite format 3" not in data and b"Basmati" not in data
    if os.name == "posix":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600

    original = db.connect(backup_settings.database_path)
    try:
        dataset_id = db.get_meta(original, "dataset_id")
        schema = db.schema_version(original)
    finally:
        original.close()
    for identity in identities:  # jeder private Schlüssel allein genügt
        copy = open_backup(path, identity, tmp_path)
        try:
            assert [row[0] for row in copy.execute("PRAGMA integrity_check")] == ["ok"]
            # Eine einzelne Datei wie die Sicherung zum Herunterladen: kein WAL nötig.
            assert copy.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
            assert copy.execute("PRAGMA user_version").fetchone()[0] == schema
            copied = copy.execute("SELECT value FROM meta WHERE key = 'dataset_id'").fetchone()[0]
            assert ids.is_uuid(copied) and copied != dataset_id
            assert copy.execute("SELECT name FROM products WHERE id = ?", (household["product"],)).fetchone()[
                0
            ] == ("Basmati Reis")
            package = copy.execute("SELECT * FROM packages WHERE id = ?", (household["package"],)).fetchone()
            assert package["best_before"] == "2027-03-25"
            item = copy.execute(
                "SELECT text FROM shopping_items WHERE id = ?", (household["item"],)
            ).fetchone()
            assert item[0] == "Grillkohle"
            # Der VAPID-Schlüssel kommt mit (docs/integrationen.md, 3.7).
            assert (
                copy.execute("SELECT value FROM meta WHERE key = 'vapid_private_key'").fetchone() is not None
            )
        finally:
            copy.close()

    run = job_run(backup_settings)
    assert (run.last_date, run.last_at, run.last_error) == ("2026-11-14", "2026-11-14T02:30:00.000Z", None)
    keys = [str(identity.to_public()) for identity in identities]
    assert run.state == {
        "file": expected,
        "size": len(data),
        "recipients": [f"{key[:8]}…{key[-4:]}" for key in keys],
    }
    assert not any(key in str(run.state) for key in keys)


def test_a_wrong_key_does_not_open_the_backup(backup_settings, household, folder):
    autobackup.run_backup(backup_settings, utc(2026, 11, 14, 2, 30))
    (path,) = folder.iterdir()
    with pytest.raises(pyrage.DecryptError):
        pyrage.decrypt(path.read_bytes(), [pyrage.x25519.Identity.generate()])


# --- Kein Klartext, Fehler, Ordner ---------------------------------------------------------


@pytest.mark.parametrize("step", ["fsync", "replace"])
def test_no_file_stays_behind_when_writing_fails(backup_settings, household, folder, monkeypatch, step):
    def full(*_args, **_kwargs):
        raise OSError(errno.ENOSPC, "Kein Platz")

    monkeypatch.setattr(autobackup.os, step, full)
    assert autobackup.run_backup(backup_settings, utc(2026, 11, 14, 2, 30)) is False
    monkeypatch.undo()
    assert names(folder) == set()
    run = job_run(backup_settings)
    assert (run.last_error, run.last_error_at, run.last_date) == (
        autobackup.DISK_FULL,
        "2026-11-14T02:30:00.000Z",
        None,
    )


def test_nothing_unencrypted_is_ever_written(backup_settings, household, folder, monkeypatch):
    """Was in die Zwischendatei geht, ist schon verschlüsselt; scheitert das Verschlüsseln, entsteht gar nichts."""
    written: list[bytes] = []
    real = autobackup.write_file

    def spy(directory, name, data):
        written.append(data)
        return real(directory, name, data)

    monkeypatch.setattr(autobackup, "write_file", spy)
    assert autobackup.run_backup(backup_settings, utc(2026, 11, 14, 2, 30))
    assert written and all(data.startswith(AGE_HEADER) for data in written)

    def broken(*_args):
        raise pyrage.EncryptError("kaputt")

    monkeypatch.setattr(autobackup.pyrage, "encrypt", broken)
    assert autobackup.run_backup(backup_settings, utc(2026, 11, 14, 14, 30)) is False
    assert names(folder) == {"stowly-2026-11-14-0330.sqlite3.gz.age"}
    assert job_run(backup_settings).last_error == autobackup.NOT_ENCRYPTED


def test_leftover_temporary_files_of_our_own_are_swept_first(backup_settings, household, folder):
    ours = folder / ".stowly-backup-0123456789abcdef.tmp"
    foreign = [folder / ".stowly-backup-xyz.tmp", folder / "notizen.txt", folder / ".stowly-backup-0123.tmp"]
    for path in (ours, *foreign):
        path.write_bytes(b"x")
    assert autobackup.run_backup(backup_settings, utc(2026, 11, 14, 2, 30))
    assert not ours.exists()
    assert all(path.exists() for path in foreign)


def test_a_missing_folder_is_reported_and_never_created(backup_settings, household, folder):
    folder.rmdir()
    assert autobackup.run_backup(backup_settings, utc(2026, 11, 14, 2, 30)) is False
    assert not folder.exists()
    assert job_run(backup_settings).last_error == "Der Ordner für Sicherungen fehlt."


def test_a_folder_that_is_not_writable_is_reported(backup_settings, household, folder, monkeypatch):
    real_open = os.open

    def refuse(path, flags, mode=0o777, *args, **kwargs):
        if Path(path).parent == folder:
            raise PermissionError(errno.EACCES, "Zugriff verweigert")
        return real_open(path, flags, mode, *args, **kwargs)

    monkeypatch.setattr(autobackup.os, "open", refuse)
    assert autobackup.run_backup(backup_settings, utc(2026, 11, 14, 2, 30)) is False
    monkeypatch.undo()
    assert names(folder) == set()
    assert job_run(backup_settings).last_error == (
        "Der Ordner für Sicherungen ist nicht beschreibbar (Benutzer 10001)."
    )


@pytest.mark.skipif(
    sys.platform == "win32" or getattr(os, "geteuid", lambda: 0)() == 0, reason="nur POSIX ohne root"
)
def test_a_read_only_folder_on_posix(backup_settings, household, folder):
    folder.chmod(0o500)
    try:
        assert autobackup.run_backup(backup_settings, utc(2026, 11, 14, 2, 30)) is False
    finally:
        folder.chmod(0o700)
    assert job_run(backup_settings).last_error == autobackup.NOT_WRITABLE


def test_a_broken_database_is_not_backed_up(backup_settings, household, folder, monkeypatch):
    checked: list[sqlite3.Connection] = []

    def broken(con):
        checked.append(con)
        return ["*** in database main ***", "Seite 7: kaputt"]

    monkeypatch.setattr(autobackup, "integrity_problems", broken)
    assert autobackup.run_backup(backup_settings, utc(2026, 11, 14, 2, 30)) is False
    assert checked  # geprüft wird die Kopie im Arbeitsspeicher
    assert names(folder) == set()
    assert job_run(backup_settings).last_error == "Die Kopie der Datenbank ist nicht stimmig."


# --- Rotation 7/4/12 -----------------------------------------------------------------------


def make_files(folder: Path, stamps: list[str]) -> None:
    """Eigene Dateien zu ``YYYY-MM-DD-HHMM``; das Änderungsdatum absichtlich verkehrt herum."""
    for number, stamp in enumerate(stamps):
        path = folder / f"stowly-{stamp}.sqlite3.gz.age"
        path.write_bytes(AGE_HEADER + b"...")
        moment = time.time() - number * 3600
        os.utime(path, (moment, moment))


def daily(start: date, end: date) -> list[str]:
    days = (end - start).days + 1
    return [f"{start + timedelta(days=offset):%Y-%m-%d}-0330" for offset in range(days)]


FOREIGN = [
    "stowly-2026-01-01.sqlite3",  # Sicherung zum Herunterladen, nicht unsere
    "notizen.txt",
    "stowly-2026-02-30-0330.sqlite3.gz.age",  # Muster, aber kein Tag: unangetastet
    "stowly-2026-11-14-2460.sqlite3.gz.age",  # Muster, aber keine Uhrzeit
    "STOWLY-2025-11-01-0330.sqlite3.gz.age",
    "stowly-2025-11-01-0330.sqlite3.gz.age.bak",
]


def test_rotation_keeps_7_days_4_weeks_and_12_months_of_its_own_files_only(folder):
    make_files(folder, [*daily(date(2025, 12, 1), date(2026, 11, 14)), "2026-11-10-2100", "2026-11-14-1530"])
    for name in FOREIGN:
        (folder / name).write_bytes(b"fremd")
    (folder / "stowly-2025-01-01-0330.sqlite3.gz.age").mkdir()  # ein Ordner, kein eigene Datei

    removed = autobackup.rotate(folder, "stowly-2026-11-14-1530.sqlite3.gz.age")

    kept = {name for name in names(folder) if name not in FOREIGN} - {"stowly-2025-01-01-0330.sqlite3.gz.age"}
    expected_days = [
        "2026-11-08-0330",
        "2026-11-09-0330",
        "2026-11-10-2100",  # die neueste des Tages
        "2026-11-11-0330",
        "2026-11-12-0330",
        "2026-11-13-0330",
        "2026-11-14-1530",
    ]
    expected_weeks = ["2026-11-01-0330", "2026-10-25-0330"]  # KW 44 und 43 (KW 46 und 45 schon oben)
    expected_months = [
        "2026-10-31-0330",
        "2026-09-30-0330",
        "2026-08-31-0330",
        "2026-07-31-0330",
        "2026-06-30-0330",
        "2026-05-31-0330",
        "2026-04-30-0330",
        "2026-03-31-0330",
        "2026-02-28-0330",
        "2026-01-31-0330",
        "2025-12-31-0330",
    ]
    assert kept == {
        f"stowly-{stamp}.sqlite3.gz.age" for stamp in [*expected_days, *expected_weeks, *expected_months]
    }
    assert "stowly-2026-11-14-0330.sqlite3.gz.age" in removed  # zweiter Lauf des Tages: der ältere geht
    assert "stowly-2026-11-10-0330.sqlite3.gz.age" in removed
    assert len(removed) == 349 + 2 - 20
    for name in FOREIGN:
        assert (folder / name).read_bytes() == b"fremd"
    assert (folder / "stowly-2025-01-01-0330.sqlite3.gz.age").is_dir()


def test_after_a_long_outage_the_last_backups_stay(folder):
    """Gezählt werden Tage, Wochen und Monate *mit* Sicherung."""
    make_files(folder, [*daily(date(2025, 3, 1), date(2025, 3, 20)), "2026-11-14-0330"])
    autobackup.rotate(folder, "stowly-2026-11-14-0330.sqlite3.gz.age")
    assert names(folder) == {
        f"stowly-{stamp}.sqlite3.gz.age"
        for stamp in [
            "2026-11-14-0330",
            *daily(date(2025, 3, 15), date(2025, 3, 20)),  # mit dem 14.11. die 7 neuesten Tage
            "2025-03-09-0330",  # KW 10 (KW 46/2026, 12 und 11 stecken schon in den Tagen)
        ]
    }


def test_the_file_just_written_always_stays(folder):
    """Auch wenn im Ordner (falsch datierte) neuere Dateien liegen."""
    make_files(folder, daily(date(2030, 1, 1), date(2030, 12, 31)))
    make_files(folder, ["2026-11-14-0330"])
    autobackup.rotate(folder, "stowly-2026-11-14-0330.sqlite3.gz.age")
    assert (folder / "stowly-2026-11-14-0330.sqlite3.gz.age").exists()


def test_rotation_only_after_a_successful_backup(backup_settings, household, folder, monkeypatch):
    make_files(folder, daily(date(2026, 1, 1), date(2026, 11, 13)))
    before = names(folder)

    def broken(*_args):
        raise pyrage.EncryptError("kaputt")

    monkeypatch.setattr(autobackup.pyrage, "encrypt", broken)
    assert autobackup.run_backup(backup_settings, utc(2026, 11, 14, 2, 30)) is False
    assert names(folder) == before
    monkeypatch.undo()
    assert autobackup.run_backup(backup_settings, utc(2026, 11, 14, 3, 30)) is True
    assert len(names(folder)) < len(before)
    assert "stowly-2026-11-14-0430.sqlite3.gz.age" in names(folder)


def test_two_runs_on_the_same_day(backup_settings, household, folder):
    # In derselben Minute: Die neue Datei ersetzt die alte.
    assert autobackup.run_backup(backup_settings, utc(2026, 11, 14, 2, 30, 5))
    first = (folder / "stowly-2026-11-14-0330.sqlite3.gz.age").read_bytes()
    assert autobackup.run_backup(backup_settings, utc(2026, 11, 14, 2, 30, 40))
    assert names(folder) == {"stowly-2026-11-14-0330.sqlite3.gz.age"}
    assert (folder / "stowly-2026-11-14-0330.sqlite3.gz.age").read_bytes() != first  # neu verschlüsselt
    # Später am Tag: Die Rotation behält die neueste des Tages.
    assert autobackup.run_backup(backup_settings, utc(2026, 11, 14, 14, 30))
    assert names(folder) == {"stowly-2026-11-14-1530.sqlite3.gz.age"}
    # Der Zeitplan selbst lässt die Sicherung nur einmal am Tag laufen.
    job = autobackup.BackupJob(backup_settings)
    assert not job.due(job_run(backup_settings), utc(2026, 11, 14, 20, 0))
    assert job.due(job_run(backup_settings), utc(2026, 11, 15, 2, 30))


# --- Im Zeitplan ---------------------------------------------------------------------------


class FakeClock:
    def __init__(self, now: datetime) -> None:
        self.value = now

    def now(self) -> datetime:
        return self.value

    def monotonic(self) -> float:
        return self.value.timestamp()

    async def sleep(self, seconds: float) -> None:
        self.value += timedelta(seconds=seconds)


def test_the_backup_on_the_days_of_the_time_change(backup_settings, household, folder):
    settings = dataclasses.replace(backup_settings, backup_time="02:30")
    clock = FakeClock(utc(2026, 3, 29, 0, 59))
    jobs = scheduler.Scheduler(settings.database_path, [autobackup.BackupJob(settings)], clock=clock)

    assert asyncio.run(jobs.run_once()) == []
    clock.value = utc(2026, 3, 29, 1, 0)  # 02:30 gibt es nicht: der erste Takt nach dem Sprung
    assert asyncio.run(jobs.run_once()) == ["backup"]
    assert names(folder) == {"stowly-2026-03-29-0300.sqlite3.gz.age"}

    clock.value = utc(2026, 10, 25, 0, 30)  # das erste 02:30
    assert asyncio.run(jobs.run_once()) == ["backup"]
    clock.value = utc(2026, 10, 25, 1, 30)  # das zweite 02:30: heute schon gelaufen
    assert asyncio.run(jobs.run_once()) == []
    assert "stowly-2026-10-25-0230.sqlite3.gz.age" in names(folder)


def test_a_failed_backup_is_retried_an_hour_later(backup_settings, household, folder):
    clock = FakeClock(utc(2026, 11, 14, 2, 30))
    jobs = scheduler.Scheduler(
        backup_settings.database_path, [autobackup.BackupJob(backup_settings)], clock=clock
    )
    folder.rmdir()
    assert asyncio.run(jobs.run_once()) == ["backup"]
    assert job_run(backup_settings).last_error == autobackup.MISSING_DIR
    folder.mkdir()
    clock.value = utc(2026, 11, 14, 3, 29)
    assert asyncio.run(jobs.run_once()) == []
    clock.value = utc(2026, 11, 14, 3, 30)
    assert asyncio.run(jobs.run_once()) == ["backup"]
    run = job_run(backup_settings)
    assert (run.last_error, run.last_date) == (None, "2026-11-14")
    assert names(folder) == {"stowly-2026-11-14-0430.sqlite3.gz.age"}
    clock.value = utc(2026, 11, 14, 22, 0)
    assert asyncio.run(jobs.run_once()) == []


def test_after_an_outage_the_server_catches_up_at_start(backup_settings, household, folder):
    """Der Server war um 03:30 aus: Der erste Takt nach dem Start holt die Sicherung nach, auch abends."""
    clock = FakeClock(utc(2026, 11, 14, 20, 15))
    with TestClient(create_app(backup_settings, job_clock=clock)) as client:
        device = Device(client, "Handy")
        for _ in range(500):  # der Lauf sitzt in seinem eigenen Thread
            status = client.get("/api/integrations", headers=device.headers).json()["backup"]
            if status["last_file"] is not None:
                break
            time.sleep(0.01)
    assert names(folder) == {"stowly-2026-11-14-2115.sqlite3.gz.age"}
    assert status["last_file"] == "stowly-2026-11-14-2115.sqlite3.gz.age"
    assert status["last_ok_at"] == "2026-11-14T20:15:00.000Z"


def test_the_backup_job_rests_without_keys_and_needs_no_folder_from_the_environment(backup_settings):
    db.initialise(backup_settings.database_path)
    noon = utc(2026, 11, 14, 12, 0)
    no_keys = dataclasses.replace(backup_settings, backup_recipients=())
    assert not autobackup.BackupJob(no_keys).due(scheduler.JobRun("backup"), noon)
    # Ohne STOWLY_BACKUP_DIR gehen die Sicherungen in den Datenordner (serverconfig.backup_folder).
    no_dir = dataclasses.replace(backup_settings, backup_dir=None)
    assert autobackup.BackupJob(no_dir).due(scheduler.JobRun("backup"), noon)


# --- Zustand für die App (3.6) -------------------------------------------------------------


def state_of(settings: Settings, run: scheduler.JobRun, now: datetime) -> dict:
    db.initialise(settings.database_path)  # die Einstellungen aus der App stehen in der Datenbank
    return autobackup.status(settings, run, now)


def test_the_status_of_a_backup_that_is_not_set_up(backup_settings):
    off = dataclasses.replace(backup_settings, backup_dir=None, backup_recipients=())
    status = state_of(off, scheduler.JobRun("backup"), utc(2026, 11, 14, 12, 0))
    assert status == {
        "configured": False,
        "folder": str(off.data_dir / "backups"),
        "files": [],
        "problem": None,
        "time": None,
        "recipients": [],
        "last_ok_at": None,
        "last_file": None,
        "last_size": None,
        "last_error": None,
        "last_error_at": None,
        "next_at": None,
        "warning": False,
    }
    half = dataclasses.replace(backup_settings, backup_recipients=())
    status = state_of(half, scheduler.JobRun("backup"), utc(2026, 11, 14, 12, 0))
    assert (status["configured"], status["problem"], status["time"], status["next_at"]) == (
        False,
        "Es fehlt ein öffentlicher Schlüssel (in der App oder in STOWLY_BACKUP_RECIPIENTS).",
        "03:30",
        None,
    )


def test_the_next_attempt(backup_settings):
    fresh = scheduler.JobRun("backup")
    # Vor der Uhrzeit: heute um 03:30 (Berlin).
    assert state_of(backup_settings, fresh, utc(2026, 11, 14, 1, 0))["next_at"] == "2026-11-14T02:30:00.000Z"
    # Danach, ohne Lauf heute (etwa nach einem Ausfall): gleich.
    assert state_of(backup_settings, fresh, utc(2026, 11, 14, 9, 0))["next_at"] == "2026-11-14T09:00:00.000Z"
    # Heute gelaufen: morgen, über die Zeitumstellung richtig umgerechnet (25.10.: Winterzeit).
    done = scheduler.JobRun("backup", last_date="2026-10-24", last_at="2026-10-24T01:30:00.000Z")
    assert state_of(backup_settings, done, utc(2026, 10, 24, 9, 0))["next_at"] == "2026-10-25T02:30:00.000Z"
    # Nach einem Fehler: eine Stunde später.
    failed = scheduler.JobRun("backup", last_error="Kaputt.", last_error_at="2026-11-14T02:30:00.000Z")
    assert (
        state_of(backup_settings, failed, utc(2026, 11, 14, 2, 31))["next_at"] == "2026-11-14T03:30:00.000Z"
    )
    # Ein Fehler kurz vor Mitternacht: am nächsten Tag zählt wieder die Uhrzeit.
    late = scheduler.JobRun("backup", last_error="Kaputt.", last_error_at="2026-11-14T22:45:00.000Z")
    assert state_of(backup_settings, late, utc(2026, 11, 14, 22, 46))["next_at"] == "2026-11-15T02:30:00.000Z"


def test_the_warning_after_48_hours(backup_settings):
    ok = scheduler.JobRun(
        "backup",
        last_date="2026-11-12",
        last_at="2026-11-12T02:30:00.000Z",
        state={"file": "stowly-2026-11-12-0330.sqlite3.gz.age", "size": 1234, "recipients": ["…"]},
    )
    status = state_of(backup_settings, ok, utc(2026, 11, 14, 2, 30))
    assert (status["warning"], status["last_ok_at"], status["last_file"], status["last_size"]) == (
        False,
        "2026-11-12T02:30:00.000Z",
        "stowly-2026-11-12-0330.sqlite3.gz.age",
        1234,
    )
    assert state_of(backup_settings, ok, utc(2026, 11, 14, 2, 31))["warning"] is True
    never = scheduler.JobRun("backup", last_error="Kaputt.", last_error_at="2026-11-14T02:30:00.000Z")
    assert state_of(backup_settings, never, utc(2026, 11, 14, 2, 31))["warning"] is True
    assert state_of(backup_settings, scheduler.JobRun("backup"), utc(2026, 11, 14, 2, 31))["warning"] is False


def test_the_status_shows_public_keys_only_shortened(backup_settings, identities):
    status = state_of(backup_settings, scheduler.JobRun("backup"), utc(2026, 11, 14, 12, 0))
    keys = [str(identity.to_public()) for identity in identities]
    assert status["recipients"] == [f"{key[:8]}…{key[-4:]}" for key in keys]
    assert all(len(short) == 13 for short in status["recipients"])
