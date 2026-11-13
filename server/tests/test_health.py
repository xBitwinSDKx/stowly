from stowly import __version__
from stowly.app import create_app
from stowly.config import Settings
from stowly.contract import PROTOCOL_VERSION, timeutil


def test_health_carries_the_marker_and_is_never_cached(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["app"] == "stowly"
    assert body["status"] == "ok"
    assert body["version"] == __version__
    assert body["protocol"] == PROTOCOL_VERSION
    assert body["configured"] is True
    assert timeutil.is_timestamp(body["time"])


def test_health_reports_a_missing_password(tmp_path):
    from fastapi.testclient import TestClient

    settings = Settings.from_env({"STOWLY_DATA_DIR": str(tmp_path / "data")}, dev=False)
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/health").json()["configured"] is False
