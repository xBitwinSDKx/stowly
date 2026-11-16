"""Der Speicher für Tokens außerhalb der Datenbank (stowly/secretstore.py; docs/plan-einrichtung-b.md, 3).

Rechte, atomares Schreiben ohne liegengebliebene Zwischendateien und Lesen, das nie wirft. Dazu das
Versprechen des Speichers: Der Token von HA und der Sensor-Token stehen nie in der Datenbank-Datei, einer
Sicherung, dem Log oder einer Antwort (außer der Sensor-Token in den Antworten, die ihn zeigen sollen).
Rechte prüft der Server nur unter POSIX; unter Windows fallen diese Prüfungen weg.
"""

import logging
import os
import stat
import threading
import time
from pathlib import Path

import httpx2
import pytest
from fastapi.testclient import TestClient
from ha_fake import BASE, ENTITY, TOKEN, FakeHA
from support import Device

from stowly import autobackup, db, safefile, secretstore
from stowly.app import create_app
from stowly.secretstore import HA_SENSOR_TOKEN, HA_TOKEN, SecretStore, SecretStoreError

posix_only = pytest.mark.skipif(os.name != "posix", reason="Rechte prüft der Server nur unter POSIX")
STAMP = "2026-11-16T08:00:00.000Z"
RECORD = {"token": TOKEN, "url": BASE, "set_at": STAMP}


def mode(path: Path) -> int:
    return stat.S_IMODE(os.stat(path).st_mode)


def files(folder: Path) -> list[str]:
    return sorted(entry.name for entry in folder.iterdir())


# --- Der Speicher ------------------------------------------------------------------------------


def test_put_get_and_delete_under_fixed_names(tmp_path):
    folder = tmp_path / "secrets"
    store = SecretStore(folder)
    assert store.prepare() is None and store.problem is None
    assert folder.is_dir() and files(folder) == []
    assert store.get(HA_TOKEN) is None and store.get(HA_SENSOR_TOKEN) is None

    store.put(HA_TOKEN, RECORD)
    store.put(HA_SENSOR_TOKEN, {"token": "s" * 64, "set_at": STAMP})
    assert store.get(HA_TOKEN) == RECORD
    assert SecretStore(folder).get(HA_TOKEN) == RECORD  # jede Instanz liest denselben Ordner
    assert files(folder) == ["ha_sensor_token.json", "ha_token.json"]  # keine Zwischendatei übrig

    store.put(HA_TOKEN, {**RECORD, "token": "neu"})
    assert store.get(HA_TOKEN)["token"] == "neu"
    assert store.delete(HA_TOKEN) is True
    assert store.delete(HA_TOKEN) is False
    assert store.get(HA_TOKEN) is None
    assert files(folder) == ["ha_sensor_token.json"]


@pytest.mark.parametrize("name", ["passwort", "../ha_token", "ha_token.json", ""])
def test_only_the_fixed_names_exist(tmp_path, name):
    store = SecretStore(tmp_path)
    for call in (lambda: store.get(name), lambda: store.put(name, {}), lambda: store.delete(name)):
        with pytest.raises(ValueError):
            call()
    assert files(tmp_path) == []


@posix_only
def test_folder_0700_and_files_0600_even_with_an_open_umask(tmp_path):
    folder = tmp_path / "secrets"
    previous = os.umask(0)
    try:
        store = SecretStore(folder)
        store.prepare()
        store.put(HA_TOKEN, RECORD)
    finally:
        os.umask(previous)
    assert mode(folder) == 0o700
    assert mode(folder / "ha_token.json") == 0o600
    # Von Hand gelockert: Der nächste Start setzt die Rechte wieder.
    os.chmod(folder, 0o755)
    os.chmod(folder / "ha_token.json", 0o644)
    SecretStore(folder).prepare()
    assert (mode(folder), mode(folder / "ha_token.json")) == (0o700, 0o600)


def test_broken_large_or_odd_files_count_as_missing_with_one_warning_without_content(tmp_path, caplog):
    caplog.set_level(logging.DEBUG)
    store = SecretStore(tmp_path)
    path = store.path(HA_TOKEN)
    for content in (b'{"token": "GEHEIM-1', b"\xff\xfe GEHEIM-2", b'["GEHEIM-3"]', b"GEHEIM-4" * 9000):
        caplog.clear()
        path.write_bytes(content)
        assert store.get(HA_TOKEN) is None
        assert store.get(HA_TOKEN) is None
        warnings = [record for record in caplog.records if record.levelno == logging.WARNING]
        assert len(warnings) <= 1  # je Datei und Grund einmal, nicht bei jeder Anfrage des Sensors
        assert "GEHEIM" not in caplog.text
    assert len(b"GEHEIM-4" * 9000) > secretstore.MAX_BYTES
    # Nach dem Schreiben gilt die Datei wieder; eine neue Störung meldet sich wieder.
    store.put(HA_TOKEN, RECORD)
    assert store.get(HA_TOKEN) == RECORD
    caplog.clear()
    path.write_bytes(b"{kaputt")
    assert store.get(HA_TOKEN) is None
    assert "kein gültiges JSON" in caplog.text


def test_a_failed_write_keeps_the_old_value_and_leaves_no_temporary_file(tmp_path, monkeypatch, caplog):
    store = SecretStore(tmp_path)
    store.put(HA_TOKEN, RECORD)

    def refuse(_source, _target):
        raise PermissionError("verweigert")

    monkeypatch.setattr(safefile, "_replace", refuse)
    with pytest.raises(SecretStoreError) as error:
        store.put(HA_TOKEN, {**RECORD, "token": "GEHEIM-NEU"})
    assert str(error.value) == secretstore.NOT_WRITTEN
    assert store.get(HA_TOKEN) == RECORD
    assert files(tmp_path) == ["ha_token.json"]
    assert "GEHEIM-NEU" not in caplog.text


def test_the_start_removes_leftovers_of_an_interrupted_write(tmp_path):
    (tmp_path / ".ha_token.json.0a1b2c3d4e5f.tmp").write_text('{"token": "GEHEIM"}', encoding="utf-8")
    (tmp_path / "fremd.txt").write_text("bleibt", encoding="utf-8")
    SecretStore(tmp_path).prepare()
    assert files(tmp_path) == ["fremd.txt"]


def test_writers_take_turns(tmp_path):
    store = SecretStore(tmp_path)
    errors: list[BaseException] = []

    def write(number: int) -> None:
        try:
            for round_ in range(20):
                store.put(HA_SENSOR_TOKEN, {"token": f"{number:02d}" * 32, "set_at": STAMP, "round": round_})
        except BaseException as exc:  # noqa: BLE001 - in den Test zurückgeben
            errors.append(exc)

    threads = [threading.Thread(target=write, args=(number,)) for number in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == []
    final = store.get(HA_SENSOR_TOKEN)
    assert final is not None and final["round"] == 19
    assert files(tmp_path) == ["ha_sensor_token.json"]


def test_a_folder_that_cannot_be_created_is_a_problem_and_the_server_still_starts(settings):
    settings.data_dir.mkdir(parents=True)
    settings.secrets_dir.write_text("kein Ordner", encoding="utf-8")  # da kann kein Ordner hin
    app = create_app(settings, ha_transport=httpx2.MockTransport(FakeHA()))
    assert app.state.secrets.problem == secretstore.NOT_PREPARED
    with TestClient(app) as client:
        assert client.get("/api/health").status_code == 200
        device = Device(client, "Handy")
        saved = client.patch(
            "/api/server-config/ha", json={"url": BASE, "entity": ENTITY}, headers=device.headers
        )
        assert saved.status_code == 200, saved.text
        assert saved.json()["problem"] == secretstore.NOT_PREPARED
        refused = client.patch("/api/server-config/ha", json={"token": TOKEN}, headers=device.headers)
        assert refused.status_code == 500
        assert refused.json()["error"] == {
            "code": "internal",
            "message": secretstore.NOT_WRITTEN,
            "details": None,
        }
        after = client.get("/api/server-config/ha", headers=device.headers).json()
        assert after["token_set"] is False and after["token_set_at"] is None  # nichts halb gespeichert
        sensor = client.post("/api/server-config/ha/sensor-token", headers=device.headers)
        assert sensor.status_code == 500


# --- Nie in Datenbank, Sicherung, Log oder Antwort ---------------------------------------------


def test_tokens_never_reach_the_database_a_backup_the_log_or_an_answer(settings, caplog):
    caplog.set_level(logging.DEBUG)
    home = FakeHA()
    app = create_app(settings, ha_transport=httpx2.MockTransport(home))
    answers: list[str] = []
    with TestClient(app) as client:
        device = Device(client, "Handy")
        device.sync()

        def keep(response: httpx2.Response) -> httpx2.Response:
            assert response.status_code < 300, response.text
            answers.append(response.text)
            return response

        keep(
            client.patch(
                "/api/server-config/ha",
                json={"url": BASE, "token": TOKEN, "entity": ENTITY},
                headers=device.headers,
            )
        )
        keep(client.post("/api/server-config/ha/check", json={}, headers=device.headers))
        sensor = client.post("/api/server-config/ha/sensor-token", headers=device.headers).json()["token"]
        assert client.get("/api/ha/summary", headers={"Authorization": f"Bearer {sensor}"}).status_code == 200
        for _ in range(300):  # der Abgleich übernimmt die Einrichtung ohne Neustart
            if client.get("/api/integrations", headers=device.headers).json()["ha"]["state"] == "ok":
                break
            time.sleep(0.01)
        assert home.reads > 0
        for path in (
            "/api/server-config/ha",
            "/api/server-config",
            "/api/integrations",
            "/api/setup",
            "/api/events",
            "/api/devices",
        ):
            keep(client.get(path, headers=device.headers))
        keep(client.patch("/api/server-config/ha", json={"token": TOKEN + "x"}, headers=device.headers))
        keep(
            client.patch(
                "/api/server-config/ha", json={"url": "http://192.168.1.10:8123"}, headers=device.headers
            )
        )

    for text in answers:
        assert TOKEN not in text and sensor not in text
    assert TOKEN not in caplog.text and sensor not in caplog.text
    con = db.connect(settings.database_path)
    try:
        con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        con.close()
    for path in settings.data_dir.glob("stowly.sqlite3*"):
        content = path.read_bytes()
        assert TOKEN.encode() not in content and sensor.encode() not in content, path.name
    image = autobackup.snapshot(settings.database_path)  # dieselbe Kopie wie jede Sicherung
    assert TOKEN.encode() not in image and sensor.encode() not in image
    # Was in der Datenbank steht: nur Merker ohne Geheimnis.
    con = db.connect(settings.database_path)
    try:
        keys = {row[0] for row in con.execute("SELECT key FROM server_config WHERE key LIKE 'ha_%'")}
    finally:
        con.close()
    assert keys == {"ha_url", "ha_todo_entity", "ha_sensor_set_at", "ha_links_entity"}
