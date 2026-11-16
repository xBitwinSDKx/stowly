"""Gemeinsame Bausteine der Server-Tests.

Jeder Test bekommt eine eigene, leere Datenbank in einem temporären Verzeichnis.
Kein Test spricht mit einem fremden Dienst: Open Food Facts ist abgeschaltet und wird
nur in den Tests eingeschaltet, die es prüfen, und dann mit einem Ersatz-Transport.
"""

import json
import logging
import sqlite3
from collections.abc import Callable, Iterator
from pathlib import Path

import httpx2
import pytest
from fastapi.testclient import TestClient
from support import TEST_PASSWORD, Device, ServerClock

from stowly import auth, db, pairing
from stowly.app import create_app
from stowly.config import Settings

REPO_ROOT = Path(__file__).resolve().parents[2]

__all__ = ["REPO_ROOT", "TEST_PASSWORD"]

# So rechnet scrypt in den Tests (N = 2^4 statt 2^15): Jeder Start übernimmt STOWLY_PASSWORD als Hash, und
# mit voller Stärke kostete das je Test rund 60 Millisekunden.
QUICK_SCRYPT_LN = 4


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers", "full_scrypt: der Test rechnet scrypt mit der Stärke des Betriebs (N = 2^15)"
    )


@pytest.fixture(autouse=True)
def quick_scrypt(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> None:
    """Schneller Hash des Passworts, außer der Test prüft die echte Stärke (``full_scrypt``).

    Geprüft wird ein Hash immer mit den Werten, die in ihm stehen: Beides passt so zusammen.
    """
    if request.node.get_closest_marker("full_scrypt") is None:
        monkeypatch.setattr(auth, "SCRYPT_LN", QUICK_SCRYPT_LN)


@pytest.fixture(autouse=True)
def no_real_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Sicherheitsnetz: Kein Test kommt je wirklich ins Netz, auch nicht aus Versehen.

    Der Test-Client und ``httpx2.MockTransport`` sind davon nicht berührt; nur der echte
    Transport von httpx2 verweigert den Dienst.
    """

    def refuse(_self: object, request: httpx2.Request) -> httpx2.Response:
        raise AssertionError(f"Ein Test wollte wirklich ins Netz: {request.method} {request.url}")

    async def refuse_async(_self: object, request: httpx2.Request) -> httpx2.Response:
        raise AssertionError(f"Ein Test wollte wirklich ins Netz: {request.method} {request.url}")

    monkeypatch.setattr(httpx2.HTTPTransport, "handle_request", refuse)
    monkeypatch.setattr(httpx2.AsyncHTTPTransport, "handle_async_request", refuse_async)
    # Die Rückprüfung beim Koppeln fragt einen Pi im Heimnetz: in Tests nie wirklich. Der Ersatz tut, als
    # antworte der Pi unter jeder gemeldeten Adresse; Tests der Rückprüfung setzen ihren eigenen.
    monkeypatch.setattr(pairing, "proves", lambda _address, _token, _digest: True)


@pytest.fixture(autouse=True)
def responses_keep_the_contract(
    request: pytest.FixtureRequest, caplog: pytest.LogCaptureFixture
) -> Iterator[None]:
    """Jede Sync-Antwort muss dem Vertrag entsprechen.

    Im Betrieb liefert der Server eine Antwort, die den Vertrag verletzt, trotzdem aus
    und meldet es im Log (damit die Geräte nicht stecken bleiben). Im Test ist genau
    diese Meldung ein Fehler, außer der Test prüft das Verhalten selbst.
    """
    yield
    if request.node.get_closest_marker("allow_contract_violation"):
        return
    broken = [
        record
        for record in caplog.get_records("call")
        if record.name == "stowly.sync"
        and record.levelno >= logging.ERROR
        and "verletzt den Vertrag" in record.message
    ]
    assert not broken, f"Sync-Antwort verletzt den Vertrag: {broken[0].exc_text or broken[0].message}"


@pytest.fixture
def web_dir(tmp_path: Path) -> Path:
    """Eine winzige „gebaute" Web-App."""
    root = tmp_path / "web"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text(
        "<!doctype html><title>Stowly</title><div id=root></div>", encoding="utf-8"
    )
    (root / "assets" / "app-abc123.js").write_text("console.log('stowly')", encoding="utf-8")
    (root / "sw.js").write_text("// service worker", encoding="utf-8")
    (root / "manifest.webmanifest").write_text("{}", encoding="utf-8")
    return root


@pytest.fixture
def settings(tmp_path: Path, web_dir: Path) -> Settings:
    return Settings.from_env(
        {
            "STOWLY_DATA_DIR": str(tmp_path / "data"),
            "STOWLY_WEB_DIR": str(web_dir),
            "STOWLY_PASSWORD": TEST_PASSWORD,
            "STOWLY_OFF_ENABLED": "0",
        },
        dev=False,
    )


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(settings)) as test_client:
        yield test_client


@pytest.fixture(scope="session")
def vectors() -> dict:
    """Die gemeinsamen Beispiele von Server und Web-App."""
    return json.loads((REPO_ROOT / "docs" / "vectors.json").read_text(encoding="utf-8"))


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> ServerClock:
    """Hält die Serveruhr an: Wirksame Zeitpunkte lassen sich so genau vorhersagen."""
    server_clock = ServerClock()
    monkeypatch.setattr("stowly.api.sync.server_now", server_clock.now)
    return server_clock


@pytest.fixture
def make_device(client: TestClient, clock: ServerClock) -> Callable[..., Device]:
    """Meldet ein Gerät an und holt mit einem ersten Sync den Bestand."""

    def factory(name: str = "Testgerät", *, clock_offset_s: float = 0.0, sync: bool = True) -> Device:
        device = Device(client, name, clock=clock, clock_offset_s=clock_offset_s)
        if sync:
            device.sync()
        return device

    return factory


@pytest.fixture
def con(settings: Settings, client: TestClient) -> Iterator[sqlite3.Connection]:
    """Direkter Blick in die Datenbank des laufenden Servers."""
    connection = db.connect(settings.database_path)
    yield connection
    connection.close()
