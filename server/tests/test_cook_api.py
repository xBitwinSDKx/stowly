"""Was koche ich? über die Schnittstelle: ``POST /api/cook/ideas`` und ``GET /api/cook/ideas/{id}``
(stowly/cook.py, stowly/api/cook.py; docs/plan-0.6.md, 2.6 und 2.7).

Gegen die nachgebildete Anthropic-API (anthropic_fake.py) und mit einer Ersatzuhr für die Bremsen: der Ablauf
202 → running → done, Aufträge je Gerät und ihr Ablauf, alle Bremsen samt Tageswechsel in der Zeitzone, die
Gutschrift, ein Zähler, der den Neustart übersteht, die Frist des Auftrags und ein Fehler im Server; dazu 503,
409 und 422 in ihrer Reihenfolge. Das Schutznetz gegen echte Aufrufe prüft test_claude.py.
"""

import re
import time
from datetime import UTC, datetime, timedelta

import httpx2
import pytest
from anthropic_fake import KEY, FakeAnthropic, answer, broken, failure, idea, ideas_text, slow
from fastapi.testclient import TestClient
from support import Device, events_of

from stowly import aiconfig, claude, cook, db, errors, off, serverconfig
from stowly.app import create_app
from stowly.config import MAX_REQUEST_BYTES
from stowly.contract.api import AI_DAILY_MAX, AI_DEVICE_GAP_S, COOK_JOB_TTL_S, CookFailure, CookJob
from stowly.secretstore import ANTHROPIC_KEY, SecretStore

IDEAS = "/api/cook/ideas"
CONFIG = "/api/server-config/ai"
# 10:00 in Berlin (Winterzeit, UTC+1).
START = datetime(2026, 11, 17, 9, 0, tzinfo=UTC)
TODAY = "2026-11-17"
STAMP = "2026-11-17T09:00:00.000Z"


class AiClock(off.Clock):
    """Die Uhr der KI-Vorschläge: steht, bis der Test sie weiterdreht (Zeitpunkt in UTC und monoton)."""

    def __init__(self, start: datetime = START) -> None:
        self.moment = start
        self.ticks = 1000.0

    def now(self) -> datetime:
        return self.moment

    def monotonic(self) -> float:
        return self.ticks

    def advance(self, seconds: float) -> None:
        self.moment += timedelta(seconds=seconds)
        self.ticks += seconds


@pytest.fixture
def fake() -> FakeAnthropic:
    return FakeAnthropic()


@pytest.fixture(autouse=True)
def quick(monkeypatch):
    """Kurze Pausen vor einem zweiten Versuch (sonst wartet jeder Fall eine bis zwei Sekunden)."""
    monkeypatch.setattr(claude, "RETRY_PAUSE_S", 0.01)
    monkeypatch.setattr(claude, "RETRY_DEFAULT_S", 0.01)


@pytest.fixture
def ai_clock() -> AiClock:
    return AiClock()


@pytest.fixture
def make_client(settings, fake, ai_clock):
    """Startet die App (auch mehrmals: ein Neustart mit derselben Datenbank)."""
    clients: list[TestClient] = []

    def factory(**overrides) -> TestClient:
        options = {"ai_transport": httpx2.MockTransport(fake), "ai_clock": ai_clock, **overrides}
        client = TestClient(create_app(settings, **options))
        client.__enter__()
        clients.append(client)
        return client

    yield factory
    for client in reversed(clients):
        client.__exit__(None, None, None)


@pytest.fixture
def client(make_client) -> TestClient:
    return make_client()


@pytest.fixture
def device(client) -> Device:
    handy = Device(client, "Handy")
    handy.sync()
    return handy


def set_key(client: TestClient, device: Device, key: str = KEY) -> None:
    response = client.patch(CONFIG, json={"key": key}, headers=device.headers)
    assert response.status_code == 200, response.text


def put(device: Device, name: str, best_before: str | None = None, **product) -> str:
    """Ein Produkt mit einer Packung; liefert die Kennung des Produkts."""
    product_id, create = device.product(name, **product)
    _package_id, store = device.package(product_id, best_before=best_before)
    results = device.sync([create, store])["results"]
    assert [result["status"] for result in results] == ["applied", "applied"], results
    return product_id


@pytest.fixture
def ready(client, device) -> dict[str, str]:
    """Schlüssel gesetzt, drei Produkte im Vorrat: Tomaten (bald), Mehl (in Ordnung), Reis (ohne MHD)."""
    set_key(client, device)
    return {
        "tomaten": put(device, "Tomaten", "2026-11-19"),
        "mehl": put(device, "Mehl", "2027-05-01", brand="Mühle"),
        "reis": put(device, "Reis"),
    }


def start(client: TestClient, device: Device, **body) -> httpx2.Response:
    return client.post(IDEAS, json=body, headers=device.headers)


def started(client: TestClient, device: Device, **body) -> dict:
    response = start(client, device, **body)
    assert response.status_code == 202, response.text
    assert response.headers["cache-control"] == "no-store"
    CookJob.model_validate(response.json())
    return response.json()


def job(client: TestClient, device: Device, job_id: str) -> httpx2.Response:
    return client.get(f"{IDEAS}/{job_id}", headers=device.headers)


def finished(client: TestClient, device: Device, job_id: str) -> dict:
    """Fragt, bis der Auftrag nicht mehr läuft (wie die App, nur schneller)."""
    for _ in range(500):
        response = job(client, device, job_id)
        assert response.status_code == 200, response.text
        assert response.headers["cache-control"] == "no-store"
        body = response.json()
        CookJob.model_validate(body)
        if body["state"] != "running":
            return body
        time.sleep(0.01)
    raise AssertionError("Der Auftrag wurde nicht fertig.")


def throttled(response: httpx2.Response) -> tuple[str, int]:
    assert response.status_code == 429, response.text
    error = response.json()["error"]
    assert error["code"] == "rate_limited"
    assert response.headers["retry-after"] == str(error["details"]["retry_after_s"])
    assert response.headers["cache-control"] == "no-store"
    return error["details"]["reason"], error["details"]["retry_after_s"]


def used_today(client: TestClient, device: Device) -> int:
    return client.get(CONFIG, headers=device.headers).json()["used_today"]


# --- Ablauf ------------------------------------------------------------------------------------


def test_a_job_runs_from_202_to_done(client, device, ready, fake):
    first = started(client, device, wish="vegetarisch", focus=[ready["mehl"]])
    assert re.fullmatch(r"[0-9a-f]{32}", first["id"])
    assert first["state"] == "running"
    assert (first["result"], first["problem"], first["finished_at"]) == (None, None, None)
    assert (first["used_today"], first["daily_limit"]) == (1, AI_DAILY_MAX)

    done = finished(client, device, first["id"])
    assert done["state"] == "done" and done["problem"] is None and done["finished_at"] is not None
    result = done["result"]
    assert (result["model"], result["fallback"], result["stock_count"], result["truncated"]) == (
        "claude-opus-5-5",
        False,
        3,
        False,
    )
    assert [idea["title"] for idea in result["ideas"]] == [
        "Spaghetti mit Tomatensoße",
        "Pfannkuchen",
        "Reispfanne",
    ]
    # Die Schlüssel lebten nur im Auftrag: Zurück kommen Kennung und Name aus Stowly (P1 Tomaten, P2 Mehl).
    assert result["ideas"][0]["uses"] == [{"product_id": ready["tomaten"], "name": "Tomaten"}]
    assert result["ideas"][2]["uses"] == [
        {"product_id": ready["tomaten"], "name": "Tomaten"},
        {"product_id": ready["mehl"], "name": "Mehl"},
    ]
    assert done["used_today"] == 1 and used_today(client, device) == 1

    (sent,) = fake.sent()
    message = sent["messages"][0]["content"]
    assert '{"k":"P1","name":"Tomaten","count":1,"days":2,"state":"soon"}' in message
    assert '{"k":"P2","name":"Mehl","brand":"Mühle","count":1,"days":165,"state":"ok"}' in message
    assert '{"k":"P3","name":"Reis","count":1}' in message
    assert '<wunsch>"vegetarisch"</wunsch>' in message
    assert '<schwerpunkte>["P2"]</schwerpunkte>' in message
    assert "Heute ist der 17.11.2026." in message
    assert sent["system"] == cook.SYSTEM
    # Der Zähler erzeugt kein Ereignis; nur das Eintragen des Schlüssels tat es.
    keys = [
        event["data"]["keys"]
        for event in events_of(client, device, entity="server")
        if event["type"] == "server.config_changed"
    ]
    assert keys == [["ai_key_set_at"]]


def test_a_job_belongs_to_its_device_and_expires(client, device, ready, ai_clock):
    first = started(client, device)
    assert finished(client, device, first["id"])["state"] == "done"
    other = Device(client, "Tablet")
    for response in (job(client, other, first["id"]), job(client, device, "0" * 32)):
        assert response.status_code == 404, response.text
        assert response.json()["error"] == {"code": "not_found", "message": cook.JOB_GONE, "details": None}
        assert response.headers["cache-control"] == "no-store"
    assert job(client, device, "NICHT-HEX").status_code == 422
    assert client.get(f"{IDEAS}/{first['id']}").status_code == 401
    # Abrufbar bis COOK_JOB_TTL_S nach dem Ende, dann weg.
    ai_clock.advance(COOK_JOB_TTL_S - 1)
    assert job(client, device, first["id"]).status_code == 200
    ai_clock.advance(1)
    assert job(client, device, first["id"]).status_code == 404


def test_at_most_twenty_jobs_are_kept(client, device, ready, ai_clock, monkeypatch):
    assert cook.JOBS_MAX == 20
    monkeypatch.setattr(cook, "JOBS_MAX", 3)
    ids = []
    for _ in range(4):
        ids.append(started(client, device)["id"])
        finished(client, device, ids[-1])
        ai_clock.advance(AI_DEVICE_GAP_S)
    assert job(client, device, ids[0]).status_code == 404  # der älteste fertige wich
    assert all(job(client, device, job_id).status_code == 200 for job_id in ids[1:])


def test_a_restart_forgets_the_jobs_but_not_the_count(make_client, client, device, ready):
    first = started(client, device)
    finished(client, device, first["id"])
    client.__exit__(None, None, None)
    again = make_client()
    assert job(again, device, first["id"]).status_code == 404
    assert used_today(again, device) == 1


# --- Bremsen -----------------------------------------------------------------------------------


def test_one_request_at_a_time_for_the_whole_server(client, device, ready, fake):
    fake.gate.clear()
    first = started(client, device)
    other = Device(client, "Tablet")
    assert throttled(start(client, other)) == ("busy", cook.BUSY_RETRY_S)
    assert used_today(client, device) == 1  # abgewiesen heißt: nicht gezählt
    fake.gate.set()
    assert finished(client, device, first["id"])["state"] == "done"
    assert finished(client, other, started(client, other)["id"])["state"] == "done"
    assert used_today(client, device) == 2


def test_a_device_waits_between_its_requests(client, device, ready, ai_clock):
    finished(client, device, started(client, device)["id"])
    assert throttled(start(client, device)) == ("too_soon", AI_DEVICE_GAP_S)
    ai_clock.advance(AI_DEVICE_GAP_S - 1.5)
    assert throttled(start(client, device)) == ("too_soon", 2)
    # Ein anderes Gerät darf sofort.
    other = Device(client, "Tablet")
    finished(client, other, started(client, other)["id"])
    ai_clock.advance(1.5)
    finished(client, device, started(client, device)["id"])
    assert used_today(client, device) == 3


def test_the_daily_limit_counts_in_the_time_zone(client, device, ready, ai_clock, settings):
    # 23:30 in Berlin: noch der 17., in UTC 22:30.
    ai_clock.moment = datetime(2026, 11, 17, 22, 30, tzinfo=UTC)
    con = db.connect(settings.database_path)
    try:
        with db.transaction(con):
            serverconfig.put(
                con, aiconfig.USAGE, {"day": TODAY, "count": AI_DAILY_MAX - 1}, now=STAMP, by=None
            )
    finally:
        con.close()
    assert finished(client, device, started(client, device)["id"])["used_today"] == AI_DAILY_MAX
    ai_clock.advance(AI_DEVICE_GAP_S)
    reason, wait = throttled(start(client, device))
    assert (reason, wait) == ("daily_limit", 30 * 60 - AI_DEVICE_GAP_S)
    assert used_today(client, device) == AI_DAILY_MAX
    # Mitternacht in Berlin (23:00 UTC): ein neuer Tag mit neuem Zähler.
    ai_clock.advance(wait)
    assert started(client, device)["used_today"] == 1
    con = db.connect(settings.database_path)
    try:
        assert serverconfig.get(con, aiconfig.USAGE) == {"day": "2026-11-18", "count": 1}
    finally:
        con.close()


def test_the_limit_holds_across_devices_and_a_restart(make_client, client, device, ready, ai_clock):
    for number in range(AI_DAILY_MAX):
        handy = device if number % 2 == 0 else Device(client, f"Gerät {number}")
        finished(client, handy, started(client, handy)["id"])
        ai_clock.advance(AI_DEVICE_GAP_S)
    assert throttled(start(client, device))[0] == "daily_limit"
    client.__exit__(None, None, None)
    again = make_client()
    assert throttled(start(again, device))[0] == "daily_limit"
    assert used_today(again, device) == AI_DAILY_MAX


STOP = {"x-should-retry": "false"}


@pytest.mark.parametrize(
    ("replies", "reason", "retry_after"),
    [
        ([failure(401, "authentication_error")], "key_rejected", None),
        ([failure(403, "permission_error")], "forbidden", None),
        ([failure(404, "not_found_error")], "model_unavailable", None),
        ([failure(402, "billing_error")], "billing", None),
        ([failure(400, "invalid_request_error")], "error", None),
        ([failure(429, "rate_limit_error", headers={**STOP, "retry-after": "42"})], "busy", 42),
        ([failure(429, "rate_limit_error", headers={"retry-after": "3600"})], "busy", 3600),
        ([failure(529, "overloaded_error"), failure(529, "overloaded_error")], "unavailable", None),
        ([broken(httpx2.ConnectError), broken(httpx2.ConnectError)], "unreachable", None),
        ([broken(httpx2.ConnectTimeout), broken(httpx2.PoolTimeout)], "unreachable", None),
    ],
)
def test_what_anthropic_did_not_bill_is_credited(client, device, ready, fake, replies, reason, retry_after):
    fake.messages = list(replies)
    first = started(client, device)
    assert first["used_today"] == 1
    done = finished(client, device, first["id"])
    assert done["state"] == "failed" and done["result"] is None
    assert done["problem"]["reason"] == reason
    assert done["problem"]["message"] == claude.MESSAGES[CookFailure(reason)]
    assert done["problem"]["retry_after_s"] == retry_after
    assert done["used_today"] == 0 and used_today(client, device) == 0
    assert len(fake.requests) == len(replies)  # ein zweiter Versuch nur, wenn der erste nichts kostete


@pytest.mark.parametrize(
    ("reply", "reason"),
    [
        (answer(None, stop_reason="refusal", stop_details={"type": "refusal", "category": "bio"}), "refused"),
        (answer('{"ideas": [{"title": "Halb', stop_reason="max_tokens"), "incomplete"),
        (answer(ideas_text(idea(title=" "))), "incomplete"),
        (broken(httpx2.ReadTimeout), "timeout"),
        (broken(httpx2.WriteTimeout), "timeout"),
        (broken(httpx2.ReadError), "unreachable"),
        (broken(httpx2.WriteError), "unreachable"),
        (broken(httpx2.RemoteProtocolError), "unreachable"),
    ],
)
def test_what_anthropic_answered_or_got_counts(client, device, ready, fake, reply, reason):
    fake.messages = [reply]
    done = finished(client, device, started(client, device)["id"])
    assert (done["state"], done["problem"]["reason"]) == ("failed", reason)
    assert done["problem"]["category"] == ("bio" if reason == "refused" else None)
    assert done["used_today"] == 1
    assert len(fake.requests) == 1  # schon gesendet: kein zweiter Versuch


def test_a_second_try_that_works_counts_once(client, device, ready, fake):
    fake.messages = [broken(httpx2.ConnectError)]
    done = finished(client, device, started(client, device)["id"])
    assert (done["state"], done["used_today"], len(fake.requests)) == ("done", 1, 2)
    client.app.state.ai_clock.advance(AI_DEVICE_GAP_S)
    fake.messages = [failure(529, "overloaded_error", headers={"retry-after-ms": "20"})]
    done = finished(client, device, started(client, device)["id"])
    assert (done["state"], done["used_today"], len(fake.requests)) == ("done", 2, 4)


def test_the_deadline_of_a_job(client, device, ready, fake, monkeypatch):
    assert cook.DEADLINE_S == 90
    monkeypatch.setattr(cook, "DEADLINE_S", 0.2)
    fake.messages = [slow(5)]
    began = time.monotonic()
    done = finished(client, device, started(client, device)["id"])
    assert time.monotonic() - began < 3
    assert (done["state"], done["problem"]["reason"], done["used_today"]) == ("failed", "timeout", 1)
    # Die Bremse ist wieder frei.
    other = Device(client, "Tablet")
    assert finished(client, other, started(client, other)["id"])["state"] == "done"


def test_an_answer_from_the_fallback_model_names_it(client, device, ready, fake):
    fake.messages = [answer(model="claude-opus-4-8", fallback_from="claude-opus-5-5")]
    result = finished(client, device, started(client, device)["id"])["result"]
    assert (result["model"], result["fallback"]) == ("claude-opus-4-8", True)


def test_a_fault_in_the_server_ends_the_job_and_frees_the_brake(client, device, ready, monkeypatch, caplog):
    content = "-".join(["Inhalt", "der", "Antwort"])  # erst zur Laufzeit: Der Verlauf zeigt nur Code

    def broken_mapping(*_args):
        raise RuntimeError(content)

    mapping = cook.ideas
    monkeypatch.setattr(cook, "ideas", broken_mapping)
    done = finished(client, device, started(client, device)["id"])
    assert (done["state"], done["problem"]["reason"], done["used_today"]) == ("failed", "error", 1)
    assert "RuntimeError" in caplog.text and "broken_mapping" in caplog.text and content not in caplog.text
    # Der Worker läuft weiter, die Bremse ist frei.
    monkeypatch.setattr(cook, "ideas", mapping)
    other = Device(client, "Tablet")
    assert finished(client, other, started(client, other)["id"])["state"] == "done"


def test_the_model_of_the_settings_is_asked(client, device, ready, fake):
    response = client.patch(CONFIG, json={"model": "claude-haiku-5-5"}, headers=device.headers)
    assert response.status_code == 200, response.text
    fake.default = answer(model="claude-haiku-5-5")
    result = finished(client, device, started(client, device)["id"])["result"]
    assert result["model"] == "claude-haiku-5-5"
    (sent,) = fake.sent()
    assert sent["model"] == "claude-haiku-5-5" and "fallbacks" not in sent


# --- Was der Server selbst ablehnt -------------------------------------------------------------


def test_without_a_key_there_is_no_job(client, device, settings):
    put(device, "Tomaten", "2026-11-19")
    response = start(client, device)
    assert response.status_code == 503, response.text
    assert response.json()["error"] == {
        "code": "not_configured",
        "message": aiconfig.KEY_MISSING,
        "details": {"reason": "missing"},
    }
    assert response.headers["cache-control"] == "no-store"
    # Eingetragen, aber die Datei fehlt (Zurückspielen, Umzug): lost.
    set_key(client, device)
    SecretStore(settings.secrets_dir).delete(ANTHROPIC_KEY)
    response = start(client, device)
    assert response.status_code == 503
    assert response.json()["error"]["details"] == {"reason": "lost"}
    assert response.json()["error"]["message"] == aiconfig.KEY_LOST
    assert used_today(client, device) == 0


def test_without_a_named_product_in_stock_there_is_no_job(client, device, fake):
    set_key(client, device)
    put(device, "")  # ein Platzhalter ohne Namen
    gone = put(device, "Verbraucht", "2026-11-20")
    (package_id,) = [package["id"] for package in device.packages.values() if package["product_id"] == gone]
    device.sync([device.cmd("package.remove", package_id=package_id, reason="consumed")])
    response = start(client, device)
    assert response.status_code == 409, response.text
    assert response.json()["error"]["message"] == cook.EMPTY_STOCK
    assert used_today(client, device) == 0 and fake.requests == []


@pytest.mark.parametrize(
    "body",
    [
        {"wish": "x" * 201},
        {"focus": ["00000000-0000-4000-8000-000000000000"] * 6},
        {"focus": ["keine-kennung"]},
        {"wish": None},
        {"unbekannt": 1},
    ],
)
def test_invalid_input_is_422(client, device, ready, body):
    response = start(client, device, **body)
    assert response.status_code == 422, response.text
    assert used_today(client, device) == 0


def test_the_order_of_the_checks(client, device):
    # 401 vor 422 vor 503 vor 409 vor 429.
    assert client.post(IDEAS, json={"wish": "x" * 201}).status_code == 401
    assert start(client, device, wish="x" * 201).status_code == 422
    assert start(client, device).status_code == 503
    set_key(client, device)
    assert start(client, device).status_code == 409
    put(device, "Tomaten", "2026-11-19")
    finished(client, device, started(client, device)["id"])
    assert throttled(start(client, device))[0] == "too_soon"


def test_unknown_or_unnamed_focus_is_ignored(client, device, ready, fake):
    placeholder = put(device, "", "2026-11-18")
    started(client, device, focus=[ready["reis"], placeholder, "00000000-0000-4000-8000-000000000000"])
    assert '<schwerpunkte>["P3"]</schwerpunkte>' in fake.sent()[0]["messages"][0]["content"]


# --- Uhr ---------------------------------------------------------------------------------------


def test_a_clock_that_jumps_back_keeps_the_count_of_the_later_day(client, device, ready, ai_clock, settings):
    con = db.connect(settings.database_path)
    try:
        with db.transaction(con):
            serverconfig.put(
                con, aiconfig.USAGE, {"day": TODAY, "count": AI_DAILY_MAX - 1}, now=STAMP, by=None
            )
    finally:
        con.close()
    finished(client, device, started(client, device)["id"])
    ai_clock.advance(AI_DEVICE_GAP_S)
    # Die Uhr springt einen Tag zurück: Der gespeicherte Tag gilt weiter, bis er wirklich vorbei ist.
    ai_clock.moment -= timedelta(days=1)
    reason, wait = throttled(start(client, device))
    assert (reason, wait) == ("daily_limit", 86_400 + 13 * 3600 + 59 * 60 + 30)  # bis 18.11., 0:00 in Berlin
    assert used_today(client, device) == AI_DAILY_MAX
    ai_clock.moment += timedelta(days=1)
    assert throttled(start(client, device))[0] == "daily_limit"
    # Liegt der gespeicherte Tag weit vorn, ging die Uhr damals falsch: Er sperrt nicht für Tage.
    ai_clock.moment -= timedelta(days=aiconfig.CLOCK_BACK_DAYS + 1)
    assert started(client, device)["used_today"] == 1


# --- Cache-Control ------------------------------------------------------------------------------


def test_every_answer_on_these_paths_says_no_store(settings, fake, ai_clock, monkeypatch):
    app = create_app(settings, ai_transport=httpx2.MockTransport(fake), ai_clock=ai_clock)
    with TestClient(app, raise_server_exceptions=False) as client:
        device = Device(client, "Handy")
        job_path = f"{IDEAS}/{'a' * 32}"
        answers = {
            "401 ohne Anmeldung": client.get(CONFIG),
            "401 falsches Token": client.get(job_path, headers={"Authorization": "Bearer falsch"}),
            "401 Prüfung": client.post(f"{CONFIG}/check", json={}),
            "422 Vertrag": client.patch(CONFIG, json={"key": 5}, headers=device.headers),
            "422 Form": client.patch(CONFIG, json={"key": "sk-x"}, headers=device.headers),
            "422 Wunsch": client.post(IDEAS, json={"wish": "x" * 201}, headers=device.headers),
            "422 Muster": client.get(f"{IDEAS}/XYZ", headers=device.headers),
            "404 Auftrag": client.get(job_path, headers=device.headers),
            "404 Pfad": client.get("/api/cook/anderes", headers=device.headers),
            "405 Methode": client.put(CONFIG, json={}, headers=device.headers),
            "405 Methode Auftrag": client.delete(job_path, headers=device.headers),
            "413 zu groß": client.post(
                IDEAS,
                content=b" " * (MAX_REQUEST_BYTES + 1),
                headers={**device.headers, "content-type": "application/json"},
            ),
            "503 ohne Schlüssel": client.post(IDEAS, json={}, headers=device.headers),
            "200 Stand": client.get(CONFIG, headers=device.headers),
        }
        monkeypatch.setattr(aiconfig, "view", lambda *_args: 1 / 0)
        answers["500 Stand"] = client.get(CONFIG, headers=device.headers)
        monkeypatch.setattr(cook.CookService, "get", lambda *_args, **_kwargs: 1 / 0)
        answers["500 Auftrag"] = client.get(job_path, headers=device.headers)
        for name, response in answers.items():
            assert str(response.status_code) == name[:3], (name, response.status_code, response.text)
            assert response.headers.get("cache-control") == "no-store", name
        # Andere Pfade bleiben, wie sie sind.
        assert "cache-control" not in client.get("/api/server-config/ha").headers
        assert "cache-control" not in client.get("/api/server-config/aiconfig").headers


@pytest.mark.parametrize(
    ("path", "covered"),
    [
        ("/api/server-config/ai", True),
        ("/api/server-config/ai/check", True),
        ("/api/cook/ideas", True),
        ("/api/cook/ideas/0123", True),
        ("/api/cook", True),
        ("/api/server-config/aiconfig", False),
        ("/api/server-config", False),
        ("/api/cookbook", False),
        ("/api/images/abc.webp", False),
    ],
)
def test_which_paths_say_no_store(path, covered):
    assert errors.no_store(path) is covered
