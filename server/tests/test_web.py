"""Derselbe Prozess liefert die gebaute Web-App aus (stowly/web.py)."""

import dataclasses

import pytest
from fastapi.testclient import TestClient

from stowly.app import create_app
from stowly.config import DEFAULT_CSP, Settings


def test_root_serves_the_app_and_is_revalidated(client):
    response = client.get("/")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert response.headers["cache-control"] == "no-cache"
    assert "<div id=root>" in response.text


def test_app_routes_fall_back_to_the_start_page(client):
    for path in ("/zonen", "/scan", "/einstellungen/geraete", "/irgend/etwas"):
        response = client.get(path)
        assert response.status_code == 200, path
        assert "<div id=root>" in response.text, path


def test_hashed_assets_are_immutable_and_typed(client):
    response = client.get("/assets/app-abc123.js")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/javascript")
    assert response.headers["cache-control"] == "public, max-age=31536000, immutable"


def test_service_worker_and_manifest_are_revalidated(client):
    worker = client.get("/sw.js")
    assert worker.status_code == 200
    assert worker.headers["content-type"].startswith("text/javascript")
    assert worker.headers["cache-control"] == "no-cache"

    manifest = client.get("/manifest.webmanifest")
    assert manifest.status_code == 200
    assert manifest.headers["content-type"] == "application/manifest+json"


def test_missing_files_are_not_answered_with_html(client):
    response = client.get("/assets/fehlt.js")
    assert response.status_code == 404
    assert "<div id=root>" not in response.text


def test_head_requests_work(client):
    response = client.head("/")
    assert response.status_code == 200
    assert response.text == ""


def test_unknown_api_paths_answer_in_the_error_format(client):
    for path in ("/api/gibt-es-nicht", "/api", "/print", "/print/", "/print/v1/gibt-es-nicht"):
        response = client.get(path)
        assert response.status_code == 404, path
        assert response.json()["error"]["code"] == "not_found", path


def test_files_outside_the_web_directory_are_never_served(client, settings):
    secret = settings.web_dir.parent / "geheim.txt"
    secret.write_text("geheim", encoding="utf-8")
    for path in ("/../geheim.txt", "/%2e%2e/geheim.txt", "/assets/../../geheim.txt", "/..%2fgeheim.txt"):
        response = client.get(path)
        assert "geheim" not in response.text, path


def test_without_a_built_app_the_server_says_so(settings, tmp_path):
    bare = dataclasses.replace(settings, web_dir=tmp_path / "nicht-da")
    with TestClient(create_app(bare)) as client:
        response = client.get("/")
        assert response.status_code == 503
        assert "npm run build" in response.text
        assert client.get("/api/health").status_code == 200

    api_only = dataclasses.replace(settings, web_dir=None)
    with TestClient(create_app(api_only)) as client:
        assert client.get("/").status_code == 503
        assert client.get("/api/health").status_code == 200


def test_sounds_and_fonts_get_a_type_a_browser_accepts(settings):
    for name, expected in {
        "piep.mp3": "audio/mpeg",
        "piep.wav": "audio/wav",
        "schrift.woff": "font/woff",
        "leser.wasm": "application/wasm",
        "bild.avif": "image/avif",
    }.items():
        (settings.web_dir / "assets" / name).write_bytes(b"\x00")
        with TestClient(create_app(settings)) as client:
            response = client.get(f"/assets/{name}")
            assert response.status_code == 200
            assert response.headers["content-type"] == expected, name


def test_unknown_api_paths_are_404_for_every_method(client):
    """„Unbekannte Pfade unter /api antworten mit 404 im Fehlerformat", nicht nur bei GET."""
    for method in ("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"):
        for path in ("/api/gibt-es-nicht", "/api", "/api/sync/mehr", "/print", "/print/v1/jobs/abc/mehr"):
            response = client.request(method, path)
            assert response.status_code == 404, (method, path)
            if method != "HEAD":
                assert response.json()["error"]["code"] == "not_found", (method, path)


def test_known_api_paths_with_the_wrong_method_stay_405(client):
    for method, path, allowed in (
        ("PUT", "/api/health", "GET"),
        ("GET", "/api/sync", "POST"),
        ("POST", "/api/devices", "GET"),
        ("PUT", "/api/devices/abc", "DELETE, PATCH"),
        ("DELETE", "/api/auth/login", "POST"),
    ):
        response = client.request(method, path)
        assert response.status_code == 405, (method, path)
        assert response.json()["error"]["code"] == "invalid_request", (method, path)
        assert response.headers["allow"] == allowed, (method, path)


def test_the_web_app_itself_only_answers_get_and_head(client):
    for method in ("POST", "PUT", "DELETE"):
        response = client.request(method, "/zonen")
        assert response.status_code == 405, method
        assert response.json()["error"]["code"] == "invalid_request"
        assert response.headers["allow"] == "GET, HEAD"


# --- Content-Security-Policy -------------------------------------------------------------


def test_every_answer_of_the_web_app_carries_the_default_policy(client):
    for path in (
        "/",
        "/zonen",
        "/assets/app-abc123.js",
        "/sw.js",
        "/manifest.webmanifest",
        "/assets/fehlt.js",
    ):
        assert client.get(path).headers["content-security-policy"] == DEFAULT_CSP, path
    # Schnittstelle und Druckdienst sind keine Seiten: dort keine Policy.
    assert "content-security-policy" not in client.get("/api/health").headers
    assert "content-security-policy" not in client.get("/api/gibt-es-nicht").headers
    assert "content-security-policy" not in client.get("/print/v1/health").headers


def test_default_policy_allows_what_the_app_needs_and_nothing_inline():
    directives = {
        part.split()[0]: part.split()[1:]
        for part in (piece.strip() for piece in DEFAULT_CSP.split(";"))
        if part
    }
    # WebAssembly für die Barcode-Erkennung, aber kein eval und kein Inline-Skript.
    assert directives["script-src"] == ["'self'", "'wasm-unsafe-eval'"]
    assert "'unsafe-inline'" in directives["style-src"]  # Stil-Attribute der App
    assert {"'self'", "blob:", "data:"} <= set(directives["img-src"])
    # Direktdruck an frei eingetragene Adressen im Heimnetz, über HTTP wie HTTPS.
    assert {"'self'", "http:", "https:"} <= set(directives["connect-src"])
    assert directives["worker-src"] == ["'self'", "blob:"]
    assert directives["object-src"] == ["'none'"]
    assert directives["frame-ancestors"] == ["'none'"]
    assert "upgrade-insecure-requests" not in directives  # würde den Druck über HTTP umleiten


def test_policy_can_be_switched_off_or_replaced(settings):
    off = Settings.from_env({**_env(settings), "STOWLY_CSP": "off"}, dev=False)
    assert off.csp is None
    with TestClient(create_app(off)) as client:
        assert "content-security-policy" not in client.get("/").headers

    own = Settings.from_env(
        {**_env(settings), "STOWLY_CSP": "  default-src 'self';\n  img-src *  "}, dev=False
    )
    assert own.csp == "default-src 'self'; img-src *"
    with TestClient(create_app(own)) as client:
        assert client.get("/zonen").headers["content-security-policy"] == "default-src 'self'; img-src *"

    for unset in ({}, {"STOWLY_CSP": ""}, {"STOWLY_CSP": "   "}):
        assert Settings.from_env({**_env(settings), **unset}, dev=False).csp == DEFAULT_CSP
    with pytest.raises(ValueError, match="STOWLY_CSP"):
        Settings.from_env({**_env(settings), "STOWLY_CSP": "default-src 'self' ä"}, dev=False)


def _env(settings: Settings) -> dict[str, str]:
    return {
        "STOWLY_DATA_DIR": str(settings.data_dir),
        "STOWLY_WEB_DIR": str(settings.web_dir),
        "STOWLY_PASSWORD": "x",
        "STOWLY_OFF_ENABLED": "0",
    }


# --- /favicon.ico ------------------------------------------------------------------------


def test_favicon_is_the_icon_of_the_app(client, settings):
    # Ohne Symbol im Web-Verzeichnis: 204, nie die Startseite und nie 404.
    response = client.get("/favicon.ico")
    assert (response.status_code, response.content) == (204, b"")

    icon = b"\x89PNG\r\n\x1a\n" + b"symbol" * 10
    (settings.web_dir / "icons").mkdir()
    (settings.web_dir / "icons" / "favicon-32.png").write_bytes(icon)
    response = client.get("/favicon.ico")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.content == icon
    assert client.head("/favicon.ico").status_code == 200

    # Bringt die App eine eigene favicon.ico mit, gilt diese.
    (settings.web_dir / "favicon.ico").write_bytes(b"\x00\x00\x01\x00ico")
    response = client.get("/favicon.ico")
    assert (response.status_code, response.headers["content-type"]) == (200, "image/x-icon")
    assert client.post("/favicon.ico").status_code == 405


def test_favicon_without_a_built_app(settings, tmp_path):
    bare = dataclasses.replace(settings, web_dir=tmp_path / "nicht-da")
    with TestClient(create_app(bare)) as client:
        assert client.get("/favicon.ico").status_code == 204
        assert client.get("/").status_code == 503
