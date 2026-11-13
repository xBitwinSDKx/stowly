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
