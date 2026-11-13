"""Manuelle Sicherung und ihr Wiedereinspielen (docs/sync-protokoll.md, Abschnitt 11)."""

import os
import re
import shutil
import sqlite3
import tempfile
import time
from datetime import datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from support import Device

from stowly import backup, db
from stowly.__main__ import main
from stowly.app import create_app
from stowly.contract import ids


def download(device: Device, target: Path) -> Path:
    response = device.client.get("/api/backup", headers=device.headers)
    assert response.status_code == 200, response.text
    target.write_bytes(response.content)
    return target


def leftovers() -> set[str]:
    return {path.name for path in Path(tempfile.gettempdir()).glob("stowly-backup-*")}


def test_the_backup_is_a_download_named_after_the_day(make_device):
    device = make_device()
    response = device.client.get("/api/backup", headers=device.headers)
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/vnd.sqlite3"
    assert response.headers["cache-control"] == "no-store"
    disposition = response.headers["content-disposition"]
    assert re.fullmatch(r'attachment; filename="stowly-\d{4}-\d{2}-\d{2}\.sqlite3"', disposition)
    assert f"stowly-{datetime.now().astimezone():%Y-%m-%d}.sqlite3" in disposition
    assert int(response.headers["content-length"]) == len(response.content)
    assert response.content.startswith(b"SQLite format 3\x00")


def test_the_backup_is_a_valid_database_with_the_data_and_a_new_dataset_id(make_device, con, tmp_path):
    device = make_device()
    product_id, package_id = device.store("Basmati Reis", best_before="2027-03-25")
    with con:
        con.execute(
            "INSERT INTO images (id, content_type, data, source, created_at) VALUES ('bild.jpg', 'image/jpeg', ?, 'test', ?)",
            (b"\xff\xd8\xff" + b"x" * 5000, device.stamp()),
        )
    before = leftovers()

    path = download(device, tmp_path / "sicherung.sqlite3")
    copy = sqlite3.connect(path)
    copy.row_factory = sqlite3.Row
    try:
        assert [row[0] for row in copy.execute("PRAGMA integrity_check")] == ["ok"]
        # Eine einzelne Datei: kein WAL, keine Begleitdateien nötig.
        assert copy.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
        assert copy.execute("PRAGMA user_version").fetchone()[0] == db.schema_version(con)

        # Die Daten sind da ...
        assert (
            copy.execute("SELECT name FROM products WHERE id = ?", (product_id,)).fetchone()[0]
            == "Basmati Reis"
        )
        package = copy.execute("SELECT * FROM packages WHERE id = ?", (package_id,)).fetchone()
        assert (package["product_id"], package["best_before"]) == (product_id, "2027-03-25")
        assert copy.execute("SELECT name FROM zones").fetchone()[0] == "Vorrat"
        assert copy.execute("SELECT COUNT(*) FROM devices").fetchone()[0] == 1
        assert copy.execute("SELECT COUNT(*) FROM commands").fetchone()[0] == 2
        assert copy.execute("SELECT COUNT(*) FROM events").fetchone()[0] >= 3
        assert copy.execute("SELECT length(data) FROM images").fetchone()[0] == 5003
        assert copy.execute("SELECT COUNT(*) FROM label_templates").fetchone()[0] == 2
        for table in ("counters", "settings", "id_reservations", "field_clocks"):
            ours = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            assert copy.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == ours

        # ... aber die Kopie trägt eine neue dataset_id, das Original behält seine.
        original = db.get_meta(con, "dataset_id")
        copied = copy.execute("SELECT value FROM meta WHERE key = 'dataset_id'").fetchone()[0]
        assert ids.is_uuid(copied) and copied != original
        assert device.sync()["dataset_id"] == original
    finally:
        copy.close()

    # Die temporäre Datei des Servers ist wieder weg.
    assert leftovers() == before


def test_two_backups_get_two_dataset_ids(make_device, tmp_path):
    device = make_device()
    found = set()
    for number in range(2):
        copy = sqlite3.connect(download(device, tmp_path / f"{number}.sqlite3"))
        found.add(copy.execute("SELECT value FROM meta WHERE key = 'dataset_id'").fetchone()[0])
        copy.close()
    assert len(found) == 2


def test_the_backup_sees_everything_committed_so_far(make_device, tmp_path):
    """Auch was noch im WAL steht, gehört in die Kopie."""
    device = make_device()
    product_id, create = device.product("Reis")
    stored = [device.package(product_id) for _ in range(50)]
    device.sync([create, *[command for _, command in stored]])
    copy = sqlite3.connect(download(device, tmp_path / "sicherung.sqlite3"))
    assert copy.execute("SELECT COUNT(*) FROM packages").fetchone()[0] == 50
    copy.close()


def test_restoring_a_backup_resets_every_device(settings, clock, tmp_path):
    """Server anhalten, Datei ersetzen, starten: Alle Geräte holen den Bestand vollständig neu."""
    with TestClient(create_app(settings)) as client:
        device = Device(client, "Handy", clock=clock)
        device.sync()
        _, in_backup = device.store("Reis")
        known = device.cmd("zone.create", zone_id=ids.new_uuid(), name="Keller")
        device.sync([known])
        path = download(device, tmp_path / "sicherung.sqlite3")

        # Nach der Sicherung geht es weiter: Diese Packung fehlt in der Kopie.
        product_id, create = device.product("Nudeln")
        after_backup, store = device.package(product_id)
        device.sync([create, store])
        old_dataset = device.dataset_id

    # Einspielen.
    database = settings.database_path
    for leftover in (database, Path(f"{database}-wal"), Path(f"{database}-shm")):
        leftover.unlink(missing_ok=True)
    shutil.copyfile(path, database)

    with TestClient(create_app(settings)) as client:
        device.client = client
        # Das Token gilt weiter: Die Geräte stehen in der Sicherung.
        # Die App sendet ihre Outbox erneut; hier: ein Befehl aus der Zeit vor und einer nach der Sicherung.
        data = device.sync([known, create, store])
        assert data["reset"] is True
        assert data["dataset_id"] != old_dataset
        assert [(r["status"], r["duplicate"]) for r in data["results"]] == [
            ("applied", True),  # steckt schon in der Sicherung: als bekannt erkannt
            ("applied", False),
            ("applied", False),
        ]
        assert set(device.packages) == {in_backup, after_backup}
        assert len(device.pool) == 300  # neuer Vorrat aus dieser Antwort
        assert device.sync()["reset"] is False


def test_a_failed_backup_leaves_no_file_behind(tmp_path):
    before = leftovers()
    missing = tmp_path / "stowly.sqlite3"
    with pytest.raises(FileNotFoundError):
        backup.create(missing)
    assert not missing.exists()  # und es entsteht dabei auch keine leere Datenbank

    broken = tmp_path / "kaputt.sqlite3"
    broken.write_bytes(b"das ist keine Datenbank, sondern Text " * 100)
    with pytest.raises(sqlite3.DatabaseError):
        backup.create(broken)
    assert leftovers() == before


def test_stale_copies_are_swept(tmp_path):
    old = tmp_path / "stowly-backup-alt.sqlite3"
    fresh = tmp_path / "stowly-backup-neu.sqlite3"
    other = tmp_path / "etwas-anderes.sqlite3"
    for path in (old, fresh, other):
        path.write_bytes(b"x")
    long_ago = time.time() - 2 * 3600
    os.utime(old, (long_ago, long_ago))
    os.utime(other, (long_ago, long_ago))
    backup.remove_stale_files(tmp_path)
    assert not old.exists() and fresh.exists() and other.exists()


def test_a_raw_copy_needs_a_new_dataset_id_and_there_is_a_command_for_it(
    settings, clock, monkeypatch, capsys
):
    """Wer eine Dateikopie statt der Sicherung zurückspielt, erneuert die Kennung von Hand."""
    database = settings.database_path
    with TestClient(create_app(settings)) as client:
        device = Device(client, "Handy", clock=clock)
        device.sync()
        device.store("Reis")
    snapshot = database.with_suffix(".kopie")
    shutil.copyfile(database, snapshot)  # Server steht: eine schlichte Kopie der Datei

    with TestClient(create_app(settings)) as client:
        device.client = client
        _, later = device.store("Nudeln")
        old_dataset = device.dataset_id

    # Die Kopie kommt zurück. Ihre Kennung ist die alte: Ohne weiteres merkte niemand etwas.
    for leftover in (database, Path(f"{database}-wal"), Path(f"{database}-shm")):
        leftover.unlink(missing_ok=True)
    shutil.copyfile(snapshot, database)

    monkeypatch.setenv("STOWLY_DATA_DIR", str(settings.data_dir))
    monkeypatch.setenv("STOWLY_OFF_ENABLED", "0")
    assert main(["--new-dataset"]) == 0
    assert "Neue Kennung des Datenbestands" in capsys.readouterr().out

    with TestClient(create_app(settings)) as client:
        device.client = client
        data = device.sync()
        assert data["reset"] is True
        assert data["dataset_id"] != old_dataset
        assert later not in device.packages and len(device.packages) == 1


def test_new_dataset_refuses_to_create_a_database(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("STOWLY_DATA_DIR", str(tmp_path / "leer"))
    assert main(["--new-dataset"]) == 1
    assert not (tmp_path / "leer").exists()
    assert "gibt es nicht" in capsys.readouterr().err
