"""Home Assistant aus der App: ``GET`` und ``PATCH /api/server-config/ha`` und der Sensor-Token
(stowly/haconfig.py; docs/plan-einrichtung-b.md, 3).

Die Umgebung geht vor (Adresse, Token und Liste als Gruppe; der Sensor-Token für sich), der Token gilt nur
für seine Adresse, Merker ohne Datei heißen „fehlt nach dem Zurückspielen", und alles wirkt ohne Neustart:
der Sensor bei der nächsten Anfrage, der Abgleich nach ``reconfigure`` (test_bring_reconfigure.py).
"""

import dataclasses
import logging
import re
import time

import httpx2
import pytest
from fastapi.testclient import TestClient
from ha_fake import BASE, ENTITY, TOKEN, FakeHA
from support import Device, events_of

from stowly import db, haconfig, serverconfig, wizard
from stowly.app import create_app
from stowly.contract.api import HaConfig
from stowly.secretstore import HA_SENSOR_TOKEN, HA_TOKEN, SecretStore

EMPTY = {
    "source": "default",
    "url": None,
    "entity": None,
    "token_set": False,
    "token_set_at": None,
    "ca": False,
    "configured": False,
    "problem": None,
    "sensor": {"source": "default", "set": False, "set_at": None},
}
SUMMARY = "/api/ha/summary"


@pytest.fixture
def ha() -> FakeHA:
    return FakeHA()


@pytest.fixture
def client(settings, ha):
    """Mit laufendem Abgleich, der an das nachgebildete HA geht (nie ins Netz)."""
    with TestClient(create_app(settings, ha_transport=httpx2.MockTransport(ha))) as test_client:
        yield test_client


@pytest.fixture
def device(client) -> Device:
    return Device(client, "Handy")


def get(client: TestClient, device: Device) -> dict:
    response = client.get("/api/server-config/ha", headers=device.headers)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    HaConfig.model_validate(response.json())
    return response.json()


def patch(client: TestClient, device: Device, **body) -> httpx2.Response:
    return client.patch("/api/server-config/ha", json=body, headers=device.headers)


def saved(client: TestClient, device: Device, **body) -> dict:
    response = patch(client, device, **body)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    HaConfig.model_validate(response.json())
    assert TOKEN not in response.text
    return response.json()


def stored(settings) -> dict:
    """Was in ``server_config`` zu HA steht, ohne den Merker des Abgleichs (``ha_links_entity``, je nachdem,
    ob er schon lief; test_bring_reconfigure.py)."""
    con = db.connect(settings.database_path)
    try:
        return {
            row["key"]: serverconfig.get(con, row["key"])
            for row in con.execute(
                "SELECT key FROM server_config WHERE key LIKE 'ha_%' AND key != ? ORDER BY key",
                (haconfig.LINKS_ENTITY,),
            )
        }
    finally:
        con.close()


def errors(response: httpx2.Response) -> list[tuple[list[str], str]]:
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "invalid_request"
    return [(error["loc"], error["msg"]) for error in response.json()["error"]["details"]["errors"]]


# --- Lesen und Ändern --------------------------------------------------------------------------


def test_nothing_set_up(client, device):
    assert get(client, device) == EMPTY
    assert saved(client, device) == EMPTY  # ohne Felder ändert sich nichts
    assert client.get("/api/server-config/ha").status_code == 401
    assert client.patch("/api/server-config/ha", json={"entity": ENTITY}).status_code == 401
    assert client.post("/api/server-config/ha/check", json={}).status_code == 401
    for method in ("POST", "GET", "DELETE"):
        assert client.request(method, "/api/server-config/ha/sensor-token").status_code == 401


def test_setting_up_address_token_and_list(client, device, settings):
    result = saved(client, device, url=" http://HA.example:8123/ ", token=f" {TOKEN} ", entity=ENTITY)
    set_at = result["token_set_at"]
    assert result == {
        **EMPTY,
        "source": "app",
        "url": BASE,  # ohne / am Ende, Rechnername klein
        "entity": ENTITY,
        "token_set": True,
        "token_set_at": set_at,
        "configured": True,
    }
    assert get(client, device) == result
    # In der Datenbank nur Merker, der Token im Speicher, an seine Adresse gebunden.
    assert stored(settings) == {"ha_todo_entity": ENTITY, "ha_token_set_at": set_at, "ha_url": BASE}
    assert SecretStore(settings.secrets_dir).get(HA_TOKEN) == {"token": TOKEN, "url": BASE, "set_at": set_at}
    events = [e for e in events_of(client, device, entity="server") if e["type"] == "server.config_changed"]
    assert [(e["device_id"], e["data"]) for e in events] == [
        (device.id, {"keys": ["ha_url", "ha_todo_entity", "ha_token_set_at"]})
    ]
    # Dieselben Werte noch einmal ändern nichts (auch nicht anders geschrieben); der Token bleibt.
    again = saved(client, device, url=BASE + "/", entity=ENTITY)
    assert again == result
    assert (
        len([e for e in events_of(client, device, entity="server") if e["type"] == "server.config_changed"])
        == 1
    )
    # Der Assistent sieht den Schritt als erledigt.
    steps = client.get("/api/setup", headers=device.headers).json()["steps"]
    assert {step["id"]: step["ready"] for step in steps}["home_assistant"] is True


def test_the_token_is_bound_to_its_address(client, device, settings, ha):
    saved(client, device, url=BASE, token=TOKEN, entity=ENTITY)
    # Eine neue Adresse ohne Token im selben Aufruf löscht ihn: Er geht nie an einen anderen Rechner.
    moved = saved(client, device, url="http://192.168.1.10:8123")
    assert (moved["url"], moved["token_set"], moved["configured"]) == (
        "http://192.168.1.10:8123",
        False,
        False,
    )
    assert moved["problem"] == "Für Home Assistant fehlt noch der Token."
    assert SecretStore(settings.secrets_dir).get(HA_TOKEN) is None
    assert "ha_token_set_at" not in stored(settings)
    # Die Prüfung fragt die neue Adresse, aber ohne Token; der Abgleich fragt sie gar nicht.
    check = client.post("/api/server-config/ha/check", json={}, headers=device.headers)
    assert check.status_code == 200, check.text
    assert ha.elsewhere and all(request.url.host == "192.168.1.10" for request in ha.elsewhere)
    assert all(request.url.host == "ha.example" for request in ha.authorized())
    # Neue Adresse und neuer Token zusammen: gebunden an die neue.
    both = saved(client, device, url="http://homeassistant.local:8123", token=TOKEN)
    assert both["token_set"] is True and both["configured"] is True
    record = SecretStore(settings.secrets_dir).get(HA_TOKEN)
    assert record["url"] == "http://homeassistant.local:8123"


def test_removing_values(client, device, settings):
    saved(client, device, url=BASE, token=TOKEN, entity=ENTITY)
    without_token = saved(client, device, token=None)
    assert (without_token["token_set"], without_token["problem"]) == (
        False,
        "Für Home Assistant fehlt noch der Token.",
    )
    assert SecretStore(settings.secrets_dir).get(HA_TOKEN) is None
    without_list = saved(client, device, entity=None, token=TOKEN)
    assert without_list["problem"] == "Für Home Assistant fehlt noch die To-do-Liste."
    gone = saved(client, device, url=None, entity=None)
    assert gone == EMPTY  # die Adresse nahm den Token mit
    assert stored(settings) == {}


@pytest.mark.parametrize(
    ("body", "field", "message"),
    [
        ({"url": "ha.example:8123"}, "url", haconfig.INVALID_URL),
        ({"url": "ftp://ha.example"}, "url", haconfig.INVALID_URL),
        ({"url": "http://ha.example/api"}, "url", haconfig.INVALID_URL),
        ({"url": "http://nutzer:geheim@ha.example"}, "url", haconfig.INVALID_URL),
        ({"url": "http://169.254.169.254"}, "url", haconfig.FORBIDDEN_TARGET),
        ({"url": "http://0x7f.1"}, "url", haconfig.NUMERIC_HOST),
        ({"url": BASE, "token": "zwei teile"}, "token", haconfig.INVALID_TOKEN),
        ({"url": BASE, "token": "ünicode"}, "token", haconfig.INVALID_TOKEN),
        ({"token": TOKEN}, "token", haconfig.TOKEN_WITHOUT_URL),
        ({"url": None, "token": TOKEN}, "token", haconfig.TOKEN_WITHOUT_URL),
    ],
)
def test_invalid_values_are_422_with_the_field(client, device, settings, body, field, message):
    assert errors(patch(client, device, **body)) == [(["body", field], message)]
    assert stored(settings) == {} and SecretStore(settings.secrets_dir).get(HA_TOKEN) is None


@pytest.mark.parametrize(
    "body",
    [
        {"entity": "sensor.einkauf"},
        {"entity": "todo.Einkauf"},
        {"url": ""},
        {"token": ""},
        {"url": "http://ha.example:8123/" + "x" * 200},
        {"unbekannt": 1},
    ],
)
def test_what_the_contract_refuses_is_422(client, device, body):
    response = patch(client, device, **body)
    assert response.status_code == 422, response.text


def test_the_environment_goes_first_as_a_group(settings, ha):
    env = dataclasses.replace(settings, ha_url=BASE, ha_token=TOKEN, ha_todo_entity=ENTITY)
    with TestClient(create_app(env, ha_transport=httpx2.MockTransport(ha))) as client:
        device = Device(client, "Handy")
        result = get(client, device)
        assert result == {
            **EMPTY,
            "source": "env",
            "url": BASE,
            "entity": ENTITY,
            "token_set": True,
            "configured": True,
        }
        for body in ({"url": "http://192.168.1.10:8123"}, {"entity": "todo.zuhause"}, {"token": None}):
            response = patch(client, device, **body)
            assert response.status_code == 409, body
            assert response.json()["error"]["message"] == haconfig.FROM_ENVIRONMENT
        assert saved(client, device) == result  # ohne Felder ändert sich nichts, auch kein 409

    # Schon eine der drei Variablen sperrt die Gruppe; was fehlt, nennt problem.
    half = dataclasses.replace(settings, ha_todo_entity=ENTITY)
    with TestClient(create_app(half, ha_transport=httpx2.MockTransport(ha))) as client:
        device = Device(client, "Handy")
        result = get(client, device)
        assert (result["source"], result["configured"], result["problem"]) == (
            "env",
            False,
            "STOWLY_HA_URL und STOWLY_HA_TOKEN fehlen.",
        )
        assert patch(client, device, url=BASE, token=TOKEN).status_code == 409


def test_the_ca_of_the_environment_counts_for_the_app_too(settings, tmp_path, ha):
    ca = tmp_path / "ha-ca.pem"
    ca.write_text("egal", encoding="utf-8")  # Settings prüft die Datei nur in from_env
    with TestClient(
        create_app(dataclasses.replace(settings, ha_ca=ca), ha_transport=httpx2.MockTransport(ha))
    ) as client:
        device = Device(client, "Handy")
        result = get(client, device)
        assert (result["source"], result["ca"], result["problem"]) == ("default", True, None)
        assert saved(client, device, url=BASE)["source"] == "app"


def test_a_token_missing_after_a_restore_is_named(client, device, settings):
    saved(client, device, url=BASE, token=TOKEN, entity=ENTITY)
    client.post("/api/server-config/ha/sensor-token", headers=device.headers)
    # Zurückspielen oder Umzug: Die Datenbank kennt die Merker, die Dateien fehlen.
    for name in (HA_TOKEN, HA_SENSOR_TOKEN):
        SecretStore(settings.secrets_dir).delete(name)
    result = get(client, device)
    assert (result["configured"], result["token_set"], result["sensor"]["set"]) == (False, False, False)
    assert result["problem"] == f"{haconfig.TOKEN_LOST} {haconfig.SENSOR_LOST}"
    assert result["sensor"] == {"source": "app", "set": False, "set_at": None}
    status = client.get("/api/integrations", headers=device.headers).json()["ha"]
    assert (status["configured"], status["state"], status["problem"], status["sensor"]) == (
        False,
        "off",
        f"{haconfig.TOKEN_LOST} {haconfig.SENSOR_LOST}",
        False,
    )
    steps = client.get("/api/setup", headers=device.headers).json()["steps"]
    assert {step["id"]: step["ready"] for step in steps}["home_assistant"] is False
    lost = client.get("/api/server-config/ha/sensor-token", headers=device.headers)
    assert (lost.status_code, lost.json()["error"]["message"]) == (404, haconfig.SENSOR_LOST)
    assert client.get(SUMMARY, headers={"Authorization": "Bearer x"}).status_code == 503
    # Ein Token, der zu einer anderen Adresse gehört (etwa aus einem anderen Stand), zählt ebenso nicht.
    SecretStore(settings.secrets_dir).put(HA_TOKEN, {"token": TOKEN, "url": "http://192.168.1.10:8123"})
    assert get(client, device)["token_set"] is False
    # Neu eingetragen: wieder in Ordnung.
    assert saved(client, device, token=TOKEN)["problem"] == haconfig.SENSOR_LOST
    assert client.post("/api/server-config/ha/sensor-token", headers=device.headers).status_code == 201
    assert get(client, device)["problem"] is None


def test_the_state_of_a_setup_from_the_app(client, device):
    saved(client, device, url=BASE, token=TOKEN, entity=ENTITY)
    sensor = client.post("/api/server-config/ha/sensor-token", headers=device.headers).json()["token"]
    for _ in range(300):
        response = client.get("/api/integrations", headers=device.headers)
        if response.json()["ha"]["state"] == "ok":
            break
        time.sleep(0.01)
    status = response.json()["ha"]
    assert status == {
        "configured": True,
        "problem": None,
        "entity": ENTITY,
        "state": "ok",
        "last_ok_at": status["last_ok_at"],
        "last_error": None,
        "last_error_at": None,
        "linked": 0,
        "sensor": True,
    }
    for secret in (TOKEN, sensor, "ha.example"):
        assert secret not in response.text


def test_the_start_names_what_is_set_up_and_what_is_missing(settings, ha, caplog):
    caplog.set_level(logging.INFO, logger="stowly")
    with TestClient(create_app(settings, ha_transport=httpx2.MockTransport(ha))) as client:
        device = Device(client, "Handy")
        saved(client, device, url=BASE, token=TOKEN, entity=ENTITY)
        client.post("/api/server-config/ha/sensor-token", headers=device.headers)
    caplog.clear()
    with TestClient(create_app(settings, ha_transport=httpx2.MockTransport(ha))):
        pass
    assert f"Einkaufsliste nach Bring! über Home Assistant, Liste {ENTITY} (aus der App)." in caplog.messages
    assert "Sensor für Home Assistant unter /api/ha/summary eingerichtet." in caplog.messages
    # Umzug: Die Dateien fehlen.
    for name in (HA_TOKEN, HA_SENSOR_TOKEN):
        SecretStore(settings.secrets_dir).delete(name)
    caplog.clear()
    with TestClient(create_app(settings, ha_transport=httpx2.MockTransport(ha))):
        pass
    assert f"Kein Abgleich mit Home Assistant: {haconfig.TOKEN_LOST}" in caplog.messages
    assert f"Sensor für Home Assistant: {haconfig.SENSOR_LOST}" in caplog.messages
    assert TOKEN not in caplog.text


# --- Sensor-Token aus der App ------------------------------------------------------------------


def test_the_sensor_token_works_without_a_restart(client, device, settings):
    assert client.get(SUMMARY, headers={"Authorization": "Bearer egal"}).status_code == 503
    assert client.get("/api/server-config/ha/sensor-token", headers=device.headers).status_code == 404
    created = client.post("/api/server-config/ha/sensor-token", headers=device.headers)
    assert created.status_code == 201, created.text
    assert created.headers["cache-control"] == "no-store"
    token = created.json()["token"]
    assert re.fullmatch(r"[0-9a-f]{64}", token)
    assert client.get(SUMMARY, headers={"Authorization": f"Bearer {token}"}).status_code == 200
    assert client.get("/api/ha/stock", headers={"Authorization": f"Bearer {token}"}).status_code == 200
    shown = client.get("/api/server-config/ha/sensor-token", headers=device.headers)
    assert (shown.status_code, shown.json(), shown.headers["cache-control"]) == (
        200,
        {"token": token},
        "no-store",
    )
    sensor = get(client, device)["sensor"]
    assert (sensor["source"], sensor["set"]) == ("app", True) and sensor["set_at"] is not None
    assert client.get("/api/integrations", headers=device.headers).json()["ha"]["sensor"] is True
    assert stored(settings) == {"ha_sensor_set_at": sensor["set_at"]}

    # Ein neuer ersetzt den alten.
    renewed = client.post("/api/server-config/ha/sensor-token", headers=device.headers).json()["token"]
    assert renewed != token
    assert client.get(SUMMARY, headers={"Authorization": f"Bearer {token}"}).status_code == 401
    assert client.get(SUMMARY, headers={"Authorization": f"Bearer {renewed}"}).status_code == 200

    removed = client.delete("/api/server-config/ha/sensor-token", headers=device.headers)
    assert (removed.status_code, removed.content) == (204, b"")
    assert client.get(SUMMARY, headers={"Authorization": f"Bearer {renewed}"}).status_code == 503
    assert client.get("/api/server-config/ha/sensor-token", headers=device.headers).status_code == 404
    assert get(client, device)["sensor"] == EMPTY["sensor"]
    assert client.delete("/api/server-config/ha/sensor-token", headers=device.headers).status_code == 204
    keys = [
        e["data"]["keys"]
        for e in events_of(client, device, entity="server")
        if e["type"] == "server.config_changed"
    ]
    assert (
        keys == [["ha_sensor_set_at"]] * 3
    )  # erzeugt, ersetzt, entfernt; das zweite Entfernen ändert nichts


def test_the_sensor_token_of_the_environment_goes_first(settings, ha):
    env_token = "s" * 40
    env = dataclasses.replace(settings, ha_summary_token=env_token)
    with TestClient(create_app(env, ha_transport=httpx2.MockTransport(ha))) as client:
        device = Device(client, "Handy")
        for method in ("POST", "GET", "DELETE"):
            response = client.request(method, "/api/server-config/ha/sensor-token", headers=device.headers)
            assert response.status_code == 409, method
            assert response.json()["error"]["message"] == haconfig.SENSOR_FROM_ENVIRONMENT
        assert get(client, device)["sensor"] == {"source": "env", "set": True, "set_at": None}
        assert client.get(SUMMARY, headers={"Authorization": f"Bearer {env_token}"}).status_code == 200


def test_a_stored_sensor_token_that_does_not_fit_counts_as_none(client, device, settings):
    store = SecretStore(settings.secrets_dir)
    for record in ({"token": "kurz"}, {"token": "mit leer " * 8}, {"token": 7}, {"anders": "x" * 64}):
        store.put(HA_SENSOR_TOKEN, record)
        assert (
            client.get(SUMMARY, headers={"Authorization": f"Bearer {record.get('token')}"}).status_code == 503
        )


# --- Bausteine ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("http://192.168.1.20:8123", "http://192.168.1.20:8123"),
        ("https://HomeAssistant.local:8123/", "https://homeassistant.local:8123"),
        ("http://[FD00::20]:8123", "http://[fd00::20]:8123"),
        ("http://127.0.0.1:8123", "http://127.0.0.1:8123"),
        ("http://10.0.0.5", "http://10.0.0.5"),
        ("https://beispiel.ui.nabu.casa", "https://beispiel.ui.nabu.casa"),
        ("http://nas_ha.fritz.box.:8123", "http://nas_ha.fritz.box.:8123"),
    ],
)
def test_allowed_addresses(text, expected):
    assert haconfig.check_url(text) == (expected, None)


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("http://169.254.169.254", haconfig.FORBIDDEN_TARGET),
        ("http://169.254.0.1:8123", haconfig.FORBIDDEN_TARGET),
        ("http://[fe80::1]:8123", haconfig.FORBIDDEN_TARGET),
        ("http://[fe80::1%25eth0]:8123", haconfig.FORBIDDEN_TARGET),
        ("http://224.0.0.251", haconfig.FORBIDDEN_TARGET),
        ("http://[ff02::fb]", haconfig.FORBIDDEN_TARGET),
        ("http://0.0.0.0:8123", haconfig.FORBIDDEN_TARGET),
        ("http://[::]:8123", haconfig.FORBIDDEN_TARGET),
        ("http://[::ffff:169.254.169.254]", haconfig.FORBIDDEN_TARGET),
        ("http://[::ffff:0.0.0.0]", haconfig.FORBIDDEN_TARGET),
        ("http://[64:ff9b::a9fe:a9fe]", haconfig.FORBIDDEN_TARGET),
        ("http://[2002:a9fe:a9fe::1]", haconfig.FORBIDDEN_TARGET),
        ("http://2852039166", haconfig.NUMERIC_HOST),
        ("http://0xa9.0xfe.0xa9.0xfe", haconfig.NUMERIC_HOST),
        ("http://0251.0376.0251.0376", haconfig.NUMERIC_HOST),
        ("http://192.168.1", haconfig.NUMERIC_HOST),
        ("http://0:8123", haconfig.NUMERIC_HOST),
        ("http://nutzer@ha.example", haconfig.INVALID_URL),
        ("file:///etc/passwd", haconfig.INVALID_URL),
        ("gopher://ha.example", haconfig.INVALID_URL),
        ("http://ha.example?x=1", haconfig.INVALID_URL),
        ("http://ha.example:0", haconfig.INVALID_URL),
        ("http://ha example", haconfig.INVALID_URL),
        ("http://a..b:8123", haconfig.INVALID_URL),
        ("http://-ha-:8123", haconfig.INVALID_URL),
        ("http://" + "a" * 64 + ".local", haconfig.INVALID_URL),
        ("http://[nicht:ip]:8123", haconfig.INVALID_URL),
    ],
)
def test_forbidden_addresses(text, message):
    assert haconfig.check_url(text) == (None, message)


def test_the_effective_values_never_show_a_token(settings):
    env = dataclasses.replace(
        settings, ha_url=BASE, ha_token=TOKEN, ha_todo_entity=ENTITY, ha_summary_token="s" * 40
    )
    create_app(env)
    con = db.connect(env.database_path)
    try:
        current = haconfig.effective(env, con)
        ready = wizard.ready(env, con)
    finally:
        con.close()
    assert TOKEN not in repr(current) and "s" * 40 not in repr(current)
    assert TOKEN not in str(current.fingerprint)
    assert ready["home_assistant"] is True
