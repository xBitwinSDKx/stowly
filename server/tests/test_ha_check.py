"""Prüfung der Verbindung zu Home Assistant: ``POST /api/server-config/ha/check`` (stowly/hacheck.py;
docs/plan-einrichtung-b.md, 3).

Gegen das nachgebildete HA (``ha_fake.FakeHA``) oder einen eigenen Transport für Grenzfälle: Zustände und
Meldungen, Grenzen (Zeit, Größe, Zahl der Listen, eine zugleich, Abstand), die Regeln gegen fremde Ziele,
Weiterleitungen ohne Token an einen zweiten Rechner und nie eine rohe Antwort von HA.
"""

import asyncio
import dataclasses
import json
import ssl
import time

import httpx2
import pytest
from fastapi.testclient import TestClient
from ha_fake import BASE, ENTITY, LOCATION, TOKEN, VERSION, FakeHA
from support import Device

from stowly import bring, hacheck, haconfig, off
from stowly.app import create_app
from stowly.contract.api import HaCheck

CHECK = "/api/server-config/ha/check"
RAW = "ROHER-RUMPF-VON-HA"


class Ticker(off.Clock):
    """Die Uhr der Bremse: steht, bis der Test sie weiterdreht."""

    def __init__(self) -> None:
        self.value = 1000.0

    def monotonic(self) -> float:
        return self.value


@pytest.fixture
def ticker() -> Ticker:
    return Ticker()


@pytest.fixture
def ha() -> FakeHA:
    home = FakeHA()
    home.add_list("todo.zuhause", "Zuhause")
    home.add_list("todo.baumarkt", "Baumarkt")
    return home


@pytest.fixture
def make_client(settings, ticker):
    clients = []

    def factory(handler, **overrides) -> tuple[TestClient, Device]:
        app = create_app(
            dataclasses.replace(settings, **overrides),
            ha_transport=httpx2.MockTransport(handler),
            ha_clock=ticker,
        )
        client = TestClient(app)
        client.__enter__()
        clients.append(client)
        return client, Device(client, "Handy")

    yield factory
    for client in clients:
        client.__exit__(None, None, None)


@pytest.fixture
def bench(make_client, ha):
    return make_client(ha)


def check(client: TestClient, device: Device, ticker: Ticker, **body) -> dict:
    ticker.value += hacheck.GAP_S
    response = client.post(CHECK, json=body, headers=device.headers)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    HaCheck.model_validate(response.json())
    assert TOKEN not in response.text
    return response.json()


def refused(client: TestClient, device: Device, ticker: Ticker, status: int, **body) -> dict:
    ticker.value += hacheck.GAP_S
    response = client.post(CHECK, json=body, headers=device.headers)
    assert response.status_code == status, response.text
    return response.json()["error"]


# --- Zustände ------------------------------------------------------------------------------------


def test_ok_lists_the_todo_lists_of_ha(bench, ha, ticker):
    client, device = bench
    ha.user_add("Milch")
    ha.user_add("Brot")
    ha.user_add("Dübel", entity="todo.baumarkt")
    result = check(client, device, ticker, url=BASE, token=TOKEN)
    assert result == {
        "state": "ok",
        "message": "Verbindung zu Home Assistant steht; 3 To-do-Listen gefunden.",
        "ha_version": VERSION,
        "location_name": LOCATION,
        "lists": [
            {"entity_id": "todo.baumarkt", "name": "Baumarkt", "open": 1},
            {"entity_id": ENTITY, "name": "Einkaufsliste", "open": 2},
            {"entity_id": "todo.zuhause", "name": "Zuhause", "open": 0},
        ],
        "entity_found": None,  # in der App ist noch keine Liste gesetzt
    }
    assert [request.url.path for request in ha.requests] == ["/api/", "/api/config", "/api/states"]
    assert all(request.headers["authorization"] == f"Bearer {TOKEN}" for request in ha.requests)
    # Prüfen speichert nichts.
    assert client.get("/api/server-config/ha", headers=device.headers).json()["source"] == "default"


def test_the_effective_list_is_looked_up(bench, ha, ticker):
    client, device = bench
    client.patch(
        "/api/server-config/ha",
        json={"url": BASE, "token": TOKEN, "entity": "todo.zuhause"},
        headers=device.headers,
    )
    assert check(client, device, ticker)["entity_found"] is True  # ohne Felder: die wirksame Einrichtung
    client.patch("/api/server-config/ha", json={"entity": "todo.weg"}, headers=device.headers)
    result = check(client, device, ticker)
    assert result["entity_found"] is False
    assert result["message"].endswith("Die Liste todo.weg gibt es dort nicht.")


def test_without_a_token_ha_asks_for_one(bench, ha, ticker):
    client, device = bench
    result = check(client, device, ticker, url=BASE)
    assert (result["state"], result["message"], result["lists"]) == ("token_needed", hacheck.TOKEN_NEEDED, [])
    (request,) = ha.requests
    assert "authorization" not in request.headers
    # Ebenso mit gespeicherter Adresse ohne Token.
    client.patch("/api/server-config/ha", json={"url": BASE}, headers=device.headers)
    assert check(client, device, ticker)["state"] == "token_needed"


def test_a_wrong_token_is_unauthorized(bench, ha, ticker):
    client, device = bench
    result = check(client, device, ticker, url=BASE, token="falsch")
    assert (result["state"], result["message"]) == ("unauthorized", "Home Assistant lehnt den Token ab.")


@pytest.mark.parametrize(
    ("answer", "state", "message"),
    [
        (httpx2.Response(200, text=f"<html>{RAW}</html>"), "not_ha", hacheck.NOT_HA),
        (httpx2.Response(200, json={"message": RAW}), "not_ha", hacheck.NOT_HA),
        (httpx2.Response(404, text=RAW), "not_ha", hacheck.NOT_HA),
        (httpx2.Response(500, text=RAW), "error", "Home Assistant antwortet mit 500."),
        (httpx2.Response(403, json={"message": RAW}), "error", "Home Assistant antwortet mit 403."),
        (
            httpx2.Response(302, headers={"Location": f"https://{RAW}.example/"}, text=RAW),
            "error",
            hacheck.REDIRECT.format(status=302),
        ),
        (httpx2.ConnectError("Connection refused"), "unreachable", bring.UNREACHABLE),
        (
            httpx2.ConnectError("[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed"),
            "unreachable",
            bring.UNTRUSTED,
        ),
        (httpx2.ReadTimeout("zu langsam"), "unreachable", bring.UNREACHABLE),
        (UnicodeError("encoding with 'idna' codec failed"), "unreachable", bring.UNREACHABLE),
    ],
)
def test_answers_of_the_address_never_come_back_raw(make_client, ticker, answer, state, message):
    def handler(request: httpx2.Request) -> httpx2.Response:
        if isinstance(answer, Exception):
            raise answer
        return answer

    client, device = make_client(handler)
    result = check(client, device, ticker, url="http://192.168.1.10:8123", token=TOKEN)
    assert (result["state"], result["message"]) == (state, message)
    assert result["lists"] == [] and result["ha_version"] is None
    assert RAW not in json.dumps(result)


def test_a_certificate_error_inside_the_connection_is_recognised(make_client, ticker):
    def handler(request: httpx2.Request) -> httpx2.Response:
        error = httpx2.ConnectError("Verbindung gescheitert")
        error.__cause__ = ssl.SSLCertVerificationError(1, "self-signed certificate")
        raise error

    client, device = make_client(handler)
    result = check(client, device, ticker, url="https://192.168.1.10:8123", token=TOKEN)
    assert (result["state"], result["message"]) == ("unreachable", bring.UNTRUSTED)


def test_a_redirect_never_takes_the_token_to_a_second_host(bench, ha, ticker):
    client, device = bench
    ha.redirect = "http://anders.example:8123/api/"
    result = check(client, device, ticker, url=BASE, token=TOKEN)
    assert (result["state"], result["message"]) == ("error", hacheck.REDIRECT.format(status=301))
    assert ha.elsewhere == []  # der zweite Rechner sah keine Anfrage, also auch keinen Token
    assert [request.url.host for request in ha.authorized()] == ["ha.example"]
    # Auch der Abgleich folgt keiner Weiterleitung.
    client.patch(
        "/api/server-config/ha", json={"url": BASE, "token": TOKEN, "entity": ENTITY}, headers=device.headers
    )
    for _ in range(200):
        state = client.get("/api/integrations", headers=device.headers).json()["ha"]["state"]
        if state != "pending":
            break
        time.sleep(0.01)
    assert state == "error"
    assert ha.elsewhere == []


def test_the_stored_token_goes_only_to_its_address(bench, ha, ticker):
    client, device = bench
    client.patch(
        "/api/server-config/ha", json={"url": BASE, "token": TOKEN, "entity": ENTITY}, headers=device.headers
    )
    assert check(client, device, ticker)["state"] == "ok"
    # Eine andere Adresse ohne Token: Der gespeicherte geht nicht mit.
    check(client, device, ticker, url="http://anders.example:8123")
    assert ha.elsewhere and all("authorization" not in request.headers for request in ha.elsewhere)
    # Dieselbe Adresse, anders geschrieben: Er gilt.
    assert check(client, device, ticker, url="HTTP://HA.example:8123/")["state"] == "ok"
    # Ein angegebener Token geht an die gespeicherte Adresse; er wird nicht gespeichert.
    assert check(client, device, ticker, token="anders")["state"] == "unauthorized"
    assert client.get("/api/server-config/ha", headers=device.headers).json()["token_set"] is True


def test_the_environment_is_checked_but_not_overridden(make_client, ha, ticker):
    client, device = make_client(ha, ha_url=BASE, ha_token=TOKEN, ha_todo_entity=ENTITY)
    result = check(client, device, ticker)
    assert (result["state"], result["entity_found"]) == ("ok", True)
    for body in ({"url": BASE}, {"token": TOKEN}, {"url": BASE, "token": TOKEN}):
        error = refused(client, device, ticker, 409, **body)
        assert error["message"] == hacheck.ENV_FIELDS
    # Fehlt in der Umgebung die Adresse, gibt es nichts zu prüfen.
    client, device = make_client(ha, ha_token=TOKEN)
    assert (
        refused(client, device, ticker, 409)["message"] == "STOWLY_HA_URL und STOWLY_HA_TODO_ENTITY fehlen."
    )


def test_without_any_address_there_is_nothing_to_check(bench, ticker, ha):
    client, device = bench
    error = refused(client, device, ticker, 422)
    assert error["details"]["errors"] == [{"loc": ["body", "url"], "msg": hacheck.NO_URL, "type": "ha_url"}]
    assert ha.requests == []


# --- Ziele -------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "http://169.254.169.254",
        "http://[fe80::1]:8123",
        "http://224.0.0.1",
        "http://0.0.0.0:8123",
        "http://[::]:8123",
        "http://[::ffff:169.254.169.254]",
        "http://2852039166",
        "http://0xa9.0xfe.0xa9.0xfe",
        "http://nutzer:geheim@ha.example",
        "ftp://ha.example",
        "file:///etc/passwd",
        "http://ha.example/api",
    ],
)
def test_forbidden_targets_are_never_asked(bench, ha, ticker, url):
    client, device = bench
    error = refused(client, device, ticker, 422, url=url, token=TOKEN)
    (problem,) = error["details"]["errors"]
    assert problem["loc"] == ["body", "url"]
    assert ha.requests == [] and ha.elsewhere == []


def test_tokens_that_do_not_fit_a_header_are_422(bench, ha, ticker):
    client, device = bench
    error = refused(client, device, ticker, 422, url=BASE, token="zwei teile")
    assert error["details"]["errors"] == [
        {"loc": ["body", "token"], "msg": haconfig.INVALID_TOKEN, "type": "ha_token"}
    ]
    assert refused(client, device, ticker, 422, url=BASE, token="")["code"] == "invalid_request"
    assert refused(client, device, ticker, 422, url=None)["code"] == "invalid_request"
    assert ha.requests == []


def test_the_home_network_and_names_are_allowed(make_client, ticker):
    asked: list[str] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        asked.append(str(request.url))
        return httpx2.Response(401)

    client, device = make_client(handler)
    for url in (
        "http://192.168.1.10:8123",
        "http://homeassistant.local:8123",
        "http://127.0.0.1:8123",
        "https://[fd00::10]:8123",
    ):
        assert check(client, device, ticker, url=url)["state"] == "token_needed"
    assert asked == [
        "http://192.168.1.10:8123/api/",
        "http://homeassistant.local:8123/api/",
        "http://127.0.0.1:8123/api/",
        "https://[fd00::10]:8123/api/",
    ]


# --- Grenzen -----------------------------------------------------------------------------------


def states_handler(states, *, config=None):
    """Ein HA, das ``states`` unter /api/states liefert (Liste oder fertige Bytes)."""

    def handler(request: httpx2.Request) -> httpx2.Response:
        if request.url.path == "/api/":
            return httpx2.Response(200, json={"message": "API running."})
        if request.url.path == "/api/config":
            return config if config is not None else httpx2.Response(200, json={"version": "1.0"})
        if isinstance(states, bytes):
            return httpx2.Response(200, content=states, headers={"Content-Type": "application/json"})
        return httpx2.Response(200, json=states)

    return handler


def todo(number: int, name: str | None = None, state: str = "0") -> dict:
    attributes = {} if name is None else {"friendly_name": name}
    return {"entity_id": f"todo.liste_{number:03d}", "state": state, "attributes": attributes}


def test_at_most_100_lists_sorted_by_name(make_client, ticker):
    states = [todo(number, f"Liste {number:03d}") for number in range(150, 0, -1)]
    client, device = make_client(states_handler(states))
    result = check(client, device, ticker, url=BASE, token=TOKEN)
    assert len(result["lists"]) == hacheck.LISTS_MAX == 100
    assert [item["name"] for item in result["lists"]][:2] == ["Liste 001", "Liste 002"]
    assert (
        result["message"]
        == "Verbindung zu Home Assistant steht; 150 To-do-Listen (zur Auswahl die ersten 100) gefunden."
    )


def test_names_and_counts_from_ha_are_cleaned(make_client, ticker):
    states = [
        todo(1, "Ein‮ka\u0000uf\n  liste"),  # Richtungswechsel, Nullzeichen, Zeilenumbruch
        todo(2, "x" * 300, state="12"),
        todo(3, None, state="unavailable"),
        todo(4, "   ", state="²"),
        {"entity_id": "todo.Gross", "state": "1", "attributes": {"friendly_name": "falsch geschrieben"}},
        {"entity_id": "light.kueche", "state": "on", "attributes": {"friendly_name": "Küche"}},
        {"entity_id": 7},
        "kein Objekt",
        todo(1, "doppelt"),
    ]
    client, device = make_client(
        states_handler(
            states, config=httpx2.Response(200, json={"version": "\u0007" + "9" * 80, "location_name": 3})
        )
    )
    result = check(client, device, ticker, url=BASE, token=TOKEN)
    names = {item["entity_id"]: (item["name"], item["open"]) for item in result["lists"]}
    assert names == {
        "todo.liste_001": ("Ein ka uf liste", 0),
        "todo.liste_002": ("x" * 99 + "…", 12),
        "todo.liste_003": ("todo.liste_003", None),
        "todo.liste_004": ("todo.liste_004", None),
    }
    assert len(result["ha_version"]) <= hacheck.VERSION_MAX and result["location_name"] is None


def test_states_are_read_up_to_8_mib(make_client, ticker, monkeypatch):
    assert hacheck.STATES_MAX == 8 * 1024 * 1024
    monkeypatch.setattr(hacheck, "STATES_MAX", 2048)
    big = json.dumps([todo(number, f"Liste {number}") for number in range(100)]).encode()
    assert len(big) > 2048
    client, device = make_client(states_handler(big))
    result = check(client, device, ticker, url=BASE, token=TOKEN)
    assert (result["state"], result["message"]) == (
        "error",
        "Die Antwort von Home Assistant ist zu groß (mehr als 2 KiB).",
    )


def test_odd_states_are_an_error(make_client, ticker):
    client, device = make_client(states_handler(b"{kein json"))
    result = check(client, device, ticker, url=BASE, token=TOKEN)
    assert (result["state"], result["message"]) == ("error", hacheck.UNEXPECTED_STATES)


def test_config_is_optional(make_client, ticker):
    client, device = make_client(states_handler([todo(1, "Eins")], config=httpx2.Response(500, text=RAW)))
    result = check(client, device, ticker, url=BASE, token=TOKEN)
    assert (result["state"], result["ha_version"], result["location_name"]) == ("ok", None, None)
    assert len(result["lists"]) == 1


def test_each_request_and_the_whole_check_have_a_deadline(make_client, ticker, monkeypatch):
    assert (hacheck.REQUEST_S, hacheck.TOTAL_S) == (8.0, 12.0)
    monkeypatch.setattr(hacheck, "REQUEST_S", 0.2)
    monkeypatch.setattr(hacheck, "TOTAL_S", 0.5)

    async def slow_states(request: httpx2.Request) -> httpx2.Response:
        if request.url.path == "/api/states":
            await asyncio.sleep(5)
        return await asyncio.sleep(0.15, states_handler([])(request))

    client, device = make_client(slow_states)
    started = time.monotonic()
    result = check(client, device, ticker, url=BASE, token=TOKEN)
    assert time.monotonic() - started < 2
    assert result["state"] == "unreachable"

    async def slow_everything(request: httpx2.Request) -> httpx2.Response:
        return await asyncio.sleep(0.18, states_handler([])(request))

    client, device = make_client(slow_everything)
    result = check(client, device, ticker, url=BASE, token=TOKEN)
    # /api/ und /api/config brauchen je 0,18 s, dann ist von 0,5 s kaum etwas übrig: zu langsam.
    assert (result["state"], result["message"]) in {
        ("unreachable", hacheck.TOO_SLOW),
        ("unreachable", bring.UNREACHABLE),
    }


def test_one_check_at_a_time_and_three_seconds_apart(bench, ticker, ha):
    client, device = bench
    check(client, device, ticker, url=BASE, token=TOKEN)
    ticker.value += 1
    response = client.post(CHECK, json={"url": BASE, "token": TOKEN}, headers=device.headers)
    assert response.status_code == 429
    assert response.headers["retry-after"] == "2"
    assert response.json()["error"]["code"] == "rate_limited"
    assert response.json()["error"]["details"] == {"retry_after_s": 2}
    asked = len(ha.requests)
    ticker.value += 2
    assert client.post(CHECK, json={"url": BASE, "token": TOKEN}, headers=device.headers).status_code == 200
    assert len(ha.requests) == asked + 3
    # Eine ungültige Eingabe zählt nicht als Prüfung.
    ticker.value += 3
    assert client.post(CHECK, json={"url": "ftp://x"}, headers=device.headers).status_code == 422
    assert client.post(CHECK, json={"url": BASE, "token": TOKEN}, headers=device.headers).status_code == 200


def test_the_guard_lets_one_through(ticker):
    guard = hacheck.CheckGuard(ticker)
    guard.admit()
    with pytest.raises(hacheck.TooSoon) as running:
        guard.admit()
    assert running.value.retry_after_s == 3
    ticker.value += 10
    with pytest.raises(hacheck.TooSoon):
        guard.admit()  # die erste läuft noch
    guard.release()
    guard.admit()
    guard.release()
    ticker.value += 2.5
    with pytest.raises(hacheck.TooSoon) as soon:
        guard.admit()
    assert soon.value.retry_after_s == 1
