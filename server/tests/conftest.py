"""Gemeinsame Bausteine der Server-Tests.

Jeder Test bekommt eine eigene, leere Datenbank in einem temporären Verzeichnis.
Kein Test spricht mit einem fremden Dienst; Open Food Facts ist abgeschaltet.
"""

import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from stowly.app import create_app
from stowly.config import Settings

REPO_ROOT = Path(__file__).resolve().parents[2]
TEST_PASSWORD = "test-passwort"


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
