"""Stand der Einrichtung und die CA zum Herunterladen (docs/sync-protokoll.md, 11.6; stowly/wizard.py).

``GET`` und ``PATCH /api/setup`` mit Geräte-Token: Schritte, Abschluss, Adressen fürs Zertifikat, der
externe HTTPS-Port. Gelernt wird aus ``Host`` (Adresse, Ports), über den HTTPS-Listener (der TestClient
spielt ihn mit ``https://`` nach) und aus ``Origin`` angemeldeter Änderungen.
"""

import dataclasses
import json
from collections.abc import Iterator

import pytest
from cryptography import x509
from fastapi.testclient import TestClient
from support import Device, events_of

from stowly import db, serverconfig, wizard
from stowly.app import create_app
from stowly.config import Settings
from stowly.contract import ids, timeutil
from stowly.contract.api import SetupStatus

STEPS = ["https", "printer", "backup", "updates", "notifications", "home_assistant"]


def status(client: TestClient, device: Device, **headers: str) -> dict:
    response = client.get("/api/setup", headers={**device.headers, **headers})
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    SetupStatus.model_validate(response.json())
    return response.json()


def change(client: TestClient, device: Device, headers: dict[str, str] | None = None, **body):
    return client.patch("/api/setup", json=body, headers={**device.headers, **(headers or {})})


@pytest.fixture
def secure(settings) -> Settings:
    """Mit HTTPS-Listener (STOWLY_HTTPS_PORT): Dann gibt es ein Zertifikat des Servers."""
    return dataclasses.replace(settings, https_port=8443)


@pytest.fixture
def bench(secure) -> Iterator[tuple[TestClient, Device]]:
    with TestClient(create_app(secure)) as client:
        yield client, Device(client, "Handy")


# --- Stand ---------------------------------------------------------------------------------------


def test_the_status_of_a_new_server(client):
    device = Device(client, "Handy")
    result = status(client, device)
    assert result["password_source"] == "env"
    assert result["steps"] == [
        {"id": step, "state": "open", "ready": False, "changed_at": None} for step in STEPS
    ]
    assert result["finished_at"] is None
    https = result["https"]
    ca = https.pop("ca")
    assert https == {
        "enabled": False,
        "listening": False,
        "problem": None,
        "port": None,
        "port_source": "default",
        "http_port": 80,  # aus Host ohne Port über HTTP
        "addresses": [],  # „testserver" ist ein einteiliger Name: nichts fürs Zertifikat
        "origins": [],
        "seen_at": None,
        "via_https": False,
        "certificate": None,
    }
    assert ca["created_by_stowly"] is True and ca["name_constraints"] is True
    assert client.get("/api/setup").status_code == 401
    assert client.patch("/api/setup", json={"finished": True}).status_code == 401


def test_with_https_the_server_has_a_certificate_and_a_port(bench):
    client, device = bench
    https = status(client, device)["https"]
    assert (https["enabled"], https["listening"], https["port"], https["port_source"]) == (
        True,
        False,
        8443,
        "default",
    )
    assert https["certificate"]["addresses"] == ["localhost", "127.0.0.1"]
    assert "PRIVATE KEY" not in json.dumps(https)


def test_marking_steps_and_finishing(client):
    device = Device(client, "Handy")
    marked = change(client, device, step={"id": "printer", "state": "skipped"})
    assert marked.status_code == 200, marked.text
    assert marked.headers["cache-control"] == "no-store"
    step = next(item for item in marked.json()["steps"] if item["id"] == "printer")
    assert step["state"] == "skipped" and timeutil.is_timestamp(step["changed_at"])
    # Dasselbe noch einmal ändert nichts, auch nicht den Zeitpunkt.
    again = change(client, device, step={"id": "printer", "state": "skipped"}).json()
    assert next(item for item in again["steps"] if item["id"] == "printer") == step

    finished = change(client, device, finished=True).json()["finished_at"]
    assert timeutil.is_timestamp(finished)
    assert change(client, device, finished=True).json()["finished_at"] == finished
    assert change(client, device, finished=False).json()["finished_at"] is None

    events = [e for e in events_of(client, device, entity="server") if e["type"] == "server.config_changed"]
    assert [(e["device_id"], e["data"]) for e in events] == [
        (device.id, {"keys": ["setup_steps"]}),
        (device.id, {"keys": ["setup_finished_at"]}),
        (device.id, {"keys": ["setup_finished_at"]}),
    ]


@pytest.mark.parametrize(
    "body",
    [
        {"step": {"id": "sicherung", "state": "done"}},
        {"step": {"id": "https", "state": "erledigt"}},
        {"step": None},
        {"finished": "ja"},
        {"https_port": 0},
        {"https_port": 65536},
        {"addresses": ["192.168.1.1"] * 11},
        {"unbekannt": 1},
    ],
)
def test_invalid_changes_are_422(client, body):
    device = Device(client, "Handy")
    response = change(client, device, **body)
    assert response.status_code == 422, body
    assert response.json()["error"]["code"] == "invalid_request"


def test_ready_is_what_the_server_sees(settings):
    image = dataclasses.replace(settings, update_repo_default="beispiel/stowly")
    with TestClient(create_app(image)) as client:
        device = Device(client, "Handy")

        def ready() -> dict[str, bool]:
            return {step["id"]: step["ready"] for step in status(client, device)["steps"]}

        assert ready() == dict.fromkeys(STEPS, False)
        con = db.connect(image.database_path)
        try:
            with db.transaction(con):
                stamp = timeutil.now()
                con.execute(
                    "INSERT INTO printers (id, name, connection, config, created_at, updated_at, rev) "
                    "VALUES (?, 'Etiketten', 'server', '{}', ?, ?, ?)",
                    (ids.new_uuid(), stamp, stamp, db.next_rev(con)),
                )
        finally:
            con.close()
        client.patch("/api/server-config", json={"update_enabled": True}, headers=device.headers)
        client.patch(
            "/api/server-config", json={"push_contact": "betrieb@example.org"}, headers=device.headers
        )
        assert ready() == {
            "https": False,
            "printer": True,
            "backup": False,  # ohne Schlüssel und ohne gelungene Sicherung (test_backup_config.py)
            "updates": True,
            "notifications": True,
            "home_assistant": False,
        }

    with TestClient(create_app(image), base_url="https://192.168.1.10:8443") as secure:
        secure_device = Device(secure, "Tablet")
        assert {step["id"]: step["ready"] for step in status(secure, secure_device)["steps"]}["https"] is True


def test_a_household_with_a_password_from_the_app(settings):
    bare = dataclasses.replace(settings, password=None)
    with TestClient(create_app(bare)) as client:
        token = client.post(
            "/api/setup/password", json={"password": "erstes-passwort", "device_name": "Handy"}
        )
        headers = {"Authorization": f"Bearer {token.json()['token']}"}
        assert client.get("/api/setup", headers=headers).json()["password_source"] == "app"


# --- Adressen von Hand ---------------------------------------------------------------------------


def test_addresses_by_hand_go_into_the_certificate(bench):
    client, device = bench
    response = change(client, device, addresses=[" 192.168.1.10 ", "NAS.local", "[fd00::10]", "192.168.1.10"])
    assert response.status_code == 200, response.text
    https = response.json()["https"]
    assert https["addresses"] == [
        {"address": "192.168.1.10", "source": "manual", "in_certificate": True},
        {"address": "nas.local", "source": "manual", "in_certificate": True},
        {"address": "fd00::10", "source": "manual", "in_certificate": True},
    ]
    assert sorted(https["certificate"]["addresses"]) == ["192.168.1.10", "fd00::10", "nas.local"]
    assert https["origins"] == [
        "https://192.168.1.10:8443",
        "https://nas.local:8443",
        "https://[fd00::10]:8443",
    ]
    events = [
        e["data"] for e in events_of(client, device, entity="server") if e["type"] == "server.config_changed"
    ]
    assert {"keys": ["tls_addresses"]} in events and "192.168.1.10" not in json.dumps(events)

    # Eine leere Liste nimmt die von Hand eingetragenen wieder heraus; das Zertifikat folgt.
    cleared = change(client, device, addresses=[]).json()["https"]
    assert cleared["addresses"] == [] and cleared["certificate"]["addresses"] == ["localhost", "127.0.0.1"]


def test_addresses_outside_the_home_network_are_422(bench):
    client, device = bench
    response = change(
        client,
        device,
        addresses=[
            "192.168.1.10",
            "8.8.8.8",
            "evil.example",
            "nas.local:8010",
            "http://nas.local",
            "diskstation",
            "nas.lan",
        ],
    )
    assert response.status_code == 422
    errors = response.json()["error"]["details"]["errors"]
    assert [error["loc"] for error in errors] == [["body", "addresses", index] for index in (1, 2, 3, 4, 5)]
    assert status(client, device)["https"]["addresses"] == []


def test_at_most_ten_addresses_with_the_learned_ones(secure):
    with TestClient(create_app(secure)) as client:
        device = Device(client, "Handy")
        for number in range(1, 9):
            status(client, device, host=f"192.168.1.{number}:8010")
        learned = [entry["address"] for entry in status(client, device)["https"]["addresses"]]
        assert learned == [f"192.168.1.{number}" for number in range(1, 9)]
        too_many = change(client, device, addresses=["nas.local", "nas.lan", "nas.home"])
        assert too_many.status_code == 422
        assert [e["loc"] for e in too_many.json()["error"]["details"]["errors"]] == [["body", "addresses", 2]]
        # Schon gelernte zählen nicht doppelt.
        fine = change(client, device, addresses=["192.168.1.1", "nas.local", "nas.lan"])
        assert fine.status_code == 200
        entries = fine.json()["https"]["addresses"]
        assert len(entries) == 10 and entries[-2:] == [
            {"address": "nas.local", "source": "manual", "in_certificate": True},
            {"address": "nas.lan", "source": "manual", "in_certificate": True},
        ]
        # Voll: Gelernt wird nichts mehr, aber auch nichts entfernt.
        status(client, device, host="192.168.1.200:8010")
        assert len(status(client, device)["https"]["addresses"]) == 10


# --- Lernen ----------------------------------------------------------------------------------------


def test_over_the_https_listener_the_server_learns_address_port_and_seen_at(secure):
    with TestClient(create_app(secure), base_url="https://192.168.1.10:8444") as client:
        device = Device(client, "Handy")
        https = status(client, device)["https"]
        assert https["via_https"] is True and timeutil.is_timestamp(https["seen_at"])
        assert (https["port"], https["port_source"], https["http_port"]) == (8444, "learned", None)
        assert https["addresses"] == [
            {"address": "192.168.1.10", "source": "learned", "in_certificate": True}
        ]
        assert https["origins"] == ["https://192.168.1.10:8444"]

        # Von Hand gesetzt, lernt der Server den Port nicht mehr …
        manual = change(client, device, https_port=9443).json()["https"]
        assert (manual["port"], manual["port_source"]) == (9443, "manual")
        assert status(client, device)["https"]["port"] == 9443
        # … bis null ihn wieder lernen lässt, gleich aus dieser Anfrage.
        relearned = change(client, device, https_port=None).json()["https"]
        assert (relearned["port"], relearned["port_source"]) == (8444, "learned")

    # Ohne Port in Host: 443, und die Ursprünge schreiben ihn nicht (wie der Browser).
    with TestClient(create_app(secure), base_url="https://nas.local") as client:
        device = Device(client, "Handy")
        https = status(client, device)["https"]
        assert (https["port"], https["port_source"]) == (443, "learned")
        assert https["origins"] == ["https://192.168.1.10", "https://nas.local"]


def test_over_http_the_server_learns_the_http_port_only(secure):
    with TestClient(create_app(secure), base_url="http://192.168.1.10:8010") as client:
        device = Device(client, "Handy")
        https = status(client, device)["https"]
        assert (https["http_port"], https["port"], https["port_source"], https["seen_at"]) == (
            8010,
            8443,
            "default",
            None,
        )
        assert https["via_https"] is False


def test_behind_a_reverse_proxy_the_ports_are_not_learned(secure):
    with TestClient(create_app(secure), base_url="http://nas.local") as client:
        device = Device(client, "Handy")
        https = status(client, device, **{"X-Forwarded-For": "192.168.1.20"})["https"]
        assert https["http_port"] is None
        assert [entry["address"] for entry in https["addresses"]] == ["nas.local"]


@pytest.mark.parametrize(
    "host", ["localhost:8010", "127.0.0.1:8010", "[::1]:8010", "diskstation:8010", "8.8.8.8", "evil.example"]
)
def test_what_is_not_learned(bench, host):
    client, device = bench
    assert status(client, device, host=host)["https"]["addresses"] == []


def test_origins_come_from_signed_in_changes_only(client):
    device = Device(client, "Handy")
    status(client, device, origin="https://stowly.example")  # GET: nichts
    assert status(client, device)["https"]["origins"] == []
    change(client, device, headers={"Origin": "https://stowly.example"}, finished=False)
    change(client, device, headers={"Origin": "http://nas.local:8010"}, finished=False)
    change(client, device, headers={"Origin": "https://evil.example/pfad"}, finished=False)
    assert status(client, device)["https"]["origins"] == ["https://stowly.example"]
    for number in range(30):
        change(client, device, headers={"Origin": f"https://stowly{number}.example"}, finished=False)
    assert len(status(client, device)["https"]["origins"]) == 20


def test_a_new_learned_address_brings_a_new_certificate(secure):
    with TestClient(create_app(secure)) as client:
        device = Device(client, "Handy")
        first = status(client, device)["https"]["certificate"]
        learned = status(client, device, host="192.168.1.10:8010")["https"]
        assert learned["certificate"]["addresses"] == ["192.168.1.10"]
        assert first["addresses"] == ["localhost", "127.0.0.1"]


# --- Ursprünge für den Pi ------------------------------------------------------------------------


def test_app_origins_and_http_origin(secure, bench):
    con = db.connect(secure.database_path)
    try:
        with db.transaction(con):
            serverconfig.put(
                con,
                serverconfig.TLS_ADDRESSES,
                [
                    {"address": "192.168.1.10", "source": "learned"},
                    {"address": "fd00::10", "source": "manual"},
                ],
                now=timeutil.now(),
                by=None,
            )
            serverconfig.put(
                con,
                serverconfig.APP_ORIGINS_SEEN,
                ["https://stowly.example", "https://192.168.1.10:8443"],
                now=timeutil.now(),
                by=None,
            )
        assert wizard.app_origins(secure, con) == [
            "https://192.168.1.10:8443",
            "https://[fd00::10]:8443",
            "https://stowly.example",
        ]
        assert wizard.app_origins(dataclasses.replace(secure, https_port=None), con) == [
            "https://stowly.example",
            "https://192.168.1.10:8443",
        ]
        assert wizard.http_origin(secure, con, "192.168.1.10") == "http://192.168.1.10:8010"
        assert wizard.http_origin(secure, con, "fd00::10") == "http://[fd00::10]:8010"
        with db.transaction(con):
            serverconfig.put(con, serverconfig.HTTP_PORT, 8020, now=timeutil.now(), by=None)
        assert wizard.http_origin(secure, con, "nas.local") == "http://nas.local:8020"
        assert wizard.http_origin(secure, con, "[fd00::10]") == "http://[fd00::10]:8020"
    finally:
        con.close()


# --- Die CA zum Herunterladen --------------------------------------------------------------------


def test_the_ca_comes_inline_for_the_iphone_and_as_a_file_for_the_rest(client, settings):
    der = (settings.tls_dir / "ca.crt").read_bytes()
    expected = x509.load_pem_x509_certificate(der)
    inline = client.get("/api/setup/ca.crt")
    assert inline.status_code == 200
    assert inline.headers["content-type"] == "application/x-x509-ca-cert"
    assert inline.headers["cache-control"] == "no-store"
    assert "content-disposition" not in inline.headers
    assert x509.load_der_x509_certificate(inline.content) == expected

    download = client.get("/api/setup/ca.crt", params={"download": "true"})
    assert download.status_code == 200
    assert download.headers["content-type"] == "application/pkix-cert"
    assert download.headers["content-disposition"] == 'attachment; filename="stowly-ca.crt"'
    assert download.headers["cache-control"] == "no-store"
    assert download.content == inline.content


def test_without_a_usable_ca_the_download_is_404(settings):
    settings.tls_dir.mkdir(parents=True)
    (settings.tls_dir / "ca.crt").write_text("kein Zertifikat", encoding="utf-8")
    with TestClient(create_app(settings)) as client:
        response = client.get("/api/setup/ca.crt")
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "not_found"
        device = Device(client, "Handy")
        https = status(client, device)["https"]
        assert https["ca"] is None and "ca.key" in https["problem"]
