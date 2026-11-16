"""Hilfeseite, wenn sich ``/data`` nicht beschreiben lässt (stowly/rescue.py; Plan, Abschnitt 5).

Statt eines Absturzes und einer Neustart-Schleife zeigt Stowly auf dem HTTP-Port, warum es nicht startet
und was hilft. ``/api/health`` antwortet 503; sobald der Ordner beschreibbar ist, endet der Server mit
Exit-Code 3, und Docker startet ihn neu.
"""

import asyncio
import dataclasses
import http.client
import json
import os
import stat
import threading
import time
from pathlib import Path

import pytest

import stowly.__main__ as entry
from stowly import rescue
from stowly.config import Settings

POSIX = os.name == "posix"
ROOT = POSIX and os.geteuid() == 0  # root schreibt auch ohne Rechte


def blocked(tmp_path: Path) -> Path:
    """Ein Datenordner, der sich nicht anlegen lässt: An seiner Stelle liegt eine Datei."""
    blocker = tmp_path / "volume"
    blocker.write_text("kein Ordner", encoding="utf-8")
    return blocker / "data"


def wait_for(condition, timeout_s: float = 15.0) -> None:
    deadline = time.monotonic() + timeout_s
    while not condition():
        if time.monotonic() > deadline:
            raise AssertionError("Die Bedingung trat nicht ein.")
        time.sleep(0.02)


def get(port: int, path: str) -> tuple[int, str, str]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        return response.status, response.getheader("content-type") or "", response.read().decode("utf-8")
    finally:
        connection.close()


# --- Die Prüfung ---------------------------------------------------------------------------------


def test_a_writable_folder_is_fine_and_nothing_stays_behind(tmp_path):
    folder = tmp_path / "data"
    assert rescue.data_dir_problem(folder) is None
    assert folder.is_dir()
    assert list(folder.iterdir()) == []


def test_a_folder_that_cannot_be_created(tmp_path):
    problem = rescue.data_dir_problem(blocked(tmp_path))
    assert problem is not None and "lässt sich nicht anlegen" in problem


@pytest.mark.skipif(not POSIX or ROOT, reason="Rechte eines Ordners gibt es so nur unter POSIX, ohne root")
def test_a_folder_without_write_permission(tmp_path):
    folder = tmp_path / "data"
    folder.mkdir()
    os.chmod(folder, 0o555)
    try:
        problem = rescue.data_dir_problem(folder)
        assert problem is not None and "lässt sich nicht schreiben" in problem
        assert list(folder.iterdir()) == []
    finally:
        os.chmod(folder, 0o755)


@pytest.mark.skipif(ROOT, reason="root schreibt auch in eine schreibgeschützte Datei")
def test_a_database_that_cannot_be_written(tmp_path):
    folder = tmp_path / "data"
    folder.mkdir()
    database = folder / "stowly.sqlite3"
    database.write_bytes(b"")
    os.chmod(database, stat.S_IREAD)
    try:
        problem = rescue.data_dir_problem(folder)
        assert problem is not None and "Die Datenbank" in problem
    finally:
        os.chmod(database, stat.S_IREAD | stat.S_IWRITE)


# --- Die Seite -----------------------------------------------------------------------------------


def test_the_page_names_cause_and_remedy(tmp_path):
    settings = Settings.from_env({"STOWLY_DATA_DIR": str(blocked(tmp_path))}, dev=False)
    page = rescue.page(settings, "Kaputt <script>alert(1)</script>")
    assert "Kaputt &lt;script&gt;" in page and "<script>" not in page
    assert "Jeder" in page and "Lesen/Schreiben" in page
    assert "Eigenschaften → Berechtigung" in page
    assert "chown -R 10001:10001" in page
    assert "Stowly läuft als" in page
    assert "den Ordner" in page and "gibt es nicht" in page  # Eigentümer des nächsten vorhandenen Ordners
    assert 'lang="de"' in page


def test_the_rescue_server_answers_and_ends_once_the_folder_is_writable(tmp_path):
    folder = blocked(tmp_path)
    settings = dataclasses.replace(Settings.from_env({"STOWLY_DATA_DIR": str(folder)}, dev=False), port=0)
    problem = rescue.data_dir_problem(folder)
    assert problem is not None
    server = rescue.RescueServer(settings, problem, interval_s=0.1)
    result: dict[str, int] = {}
    thread = threading.Thread(target=lambda: result.update(code=asyncio.run(server.serve())))
    thread.start()
    try:
        wait_for(lambda: server.server.started or not thread.is_alive())
        port = server.server.servers[0].sockets[0].getsockname()[1]

        status, kind, page = get(port, "/")
        assert (status, kind.split(";")[0]) == (503, "text/html")
        assert "Jeder" in page
        assert get(port, "/einstellungen")[0] == 503
        for path in ("/api/health", "/api/sync", "/print/v1/health"):
            status, kind, body = get(port, path)
            assert (status, kind) == (503, "application/json"), path
            error = json.loads(body)["error"]
            assert error["code"] == "not_configured"
            assert error["message"].startswith("Stowly kann nicht in seinen Datenordner schreiben")

        # Jetzt beschreibbar: Der Server endet von selbst mit Exit-Code 3 (Docker startet neu).
        (tmp_path / "volume").unlink()
        thread.join(timeout=15)
        assert result == {"code": 3}
        assert folder.is_dir()
    finally:
        server.server.should_exit = True
        thread.join(timeout=15)


def test_main_shows_the_help_page_instead_of_starting(tmp_path, monkeypatch):
    monkeypatch.setenv("STOWLY_DATA_DIR", str(blocked(tmp_path)))
    monkeypatch.setattr(entry, "configure_logging", lambda level: None)  # das Logging der Tests bleibt

    def never(*_args, **_kwargs):
        raise AssertionError("Ohne beschreibbaren Datenordner darf die App nicht entstehen.")

    seen: list[str] = []
    monkeypatch.setattr(entry, "create_app", never)
    monkeypatch.setattr(rescue, "run", lambda settings, problem: seen.append(problem) or 3)
    assert entry.main([]) == 3
    assert len(seen) == 1 and "lässt sich nicht anlegen" in seen[0]
