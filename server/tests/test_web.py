"""Derselbe Prozess liefert die gebaute Web-App aus (stowly/web.py)."""

import dataclasses

from fastapi.testclient import TestClient

from stowly.app import create_app


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
    for path in ("/api/gibt-es-nicht", "/api", "/print/v1/health"):
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
        for path in ("/api/gibt-es-nicht", "/api", "/api/sync/mehr", "/print/v1/jobs/abc"):
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
