"""Eine Sicherung auf Knopfdruck enthält alles Bestätigte, und eine Dateikopie braucht eine neue Kennung
(docs/sync-protokoll.md, Abschnitt 11).

Die frühere unverschlüsselte Sicherung zum Herunterladen (``GET /api/backup``) gibt es seit Stufe B nicht
mehr: „Jetzt sichern" legt dieselbe verschlüsselte Sicherung wie die automatische in den Ordner
(test_backup_config.py), und das Einspielen mit neuer ``dataset_id`` übernimmt das Zurückspielen in der
App (test_restore.py). Von Hand bleibt ``--new-dataset``.
"""

import gzip
import shutil
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

import pyrage
from fastapi.testclient import TestClient
from support import TEST_PASSWORD, Device

from stowly.__main__ import main
from stowly.app import create_app


class Early:
    """Der Zeitplan steht auf 01:00 in Berlin."""

    def now(self) -> datetime:
        return datetime(2026, 11, 14, 0, 0, tzinfo=UTC)

    def monotonic(self) -> float:
        return 0.0

    async def sleep(self, seconds: float) -> None:
        return None


def test_backup_now_sees_everything_committed_so_far(settings, clock, tmp_path, vectors):
    """Auch was noch im WAL steht, gehört in die Kopie."""
    pair = vectors["age_keys"]["pairs"][0]
    # Der Zeitplan steht vor 03:30: Er holt die Sicherung des Tages nicht von sich aus nach.
    with TestClient(create_app(settings, job_clock=Early())) as client:
        device = Device(client, "Handy", clock=clock)
        device.sync()
        changed = client.patch(
            "/api/server-config",
            json={"backup_recipients": [pair["public"]], "current_password": TEST_PASSWORD},
            headers=device.headers,
        )
        assert changed.status_code == 200
        product_id, create = device.product("Reis")
        stored = [device.package(product_id) for _ in range(50)]
        device.sync([create, *[command for _, command in stored]])
        response = client.post("/api/backup/run", headers=device.headers)
        assert response.status_code == 200, response.text
        folder = Path(client.get("/api/server-config", headers=device.headers).json()["backup"]["folder"])
    identity = pyrage.x25519.Identity.from_str(pair["secret"])
    plain = gzip.decompress(pyrage.decrypt((folder / response.json()["name"]).read_bytes(), [identity]))
    copy_path = tmp_path / "kopie.sqlite3"
    copy_path.write_bytes(plain)
    copy = sqlite3.connect(copy_path)
    try:
        assert copy.execute("SELECT COUNT(*) FROM packages").fetchone()[0] == 50
    finally:
        copy.close()


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
