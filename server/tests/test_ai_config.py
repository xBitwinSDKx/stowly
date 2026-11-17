"""KI-Vorschläge einrichten: ``GET`` und ``PATCH /api/server-config/ai`` und ``POST /api/server-config/ai/check``
(stowly/aiconfig.py, stowly/api/aiconfig.py; docs/plan-0.6.md, 2.2 und 2.7).

Die Umgebung geht vor (409), ein Schlüssel in falscher Form ist 422 ohne seinen Wert, ein Merker ohne Datei
heißt „fehlt nach dem Zurückspielen“, das Modell ist wählbar, das Ereignis nennt nur Schlüsselnamen. Die
Prüfung hat ihre eigene Bremse und zählt nicht. Der Schlüssel steht nie in einer Antwort, im Log, in der
Datenbank oder einer Sicherung; in ``server_config`` stehen nur drei Schlüssel. Dazu die Variablen
STOWLY_ANTHROPIC_API_KEY und STOWLY_ANTHROPIC_BASE_URL.
"""

import dataclasses
import logging
import time
from datetime import UTC, datetime

import httpx2
import pytest
from anthropic_fake import KEY, OTHER_KEY, FakeAnthropic, failure
from fastapi.testclient import TestClient
from support import Device, events_of

from stowly import aiconfig, autobackup, claude, db, hacheck, off, serverconfig
from stowly.__main__ import main
from stowly.app import create_app
from stowly.config import ANTHROPIC_KEY_ADMIN, ANTHROPIC_KEY_SHAPE, Settings
from stowly.contract.api import AI_DAILY_MAX, AiCheck, AiConfig
from stowly.secretstore import ANTHROPIC_KEY, SecretStore

CONFIG = "/api/server-config/ai"
CHECK = "/api/server-config/ai/check"
EMPTY = {
    "source": "default",
    "key_set": False,
    "key_set_at": None,
    "model": "claude-opus-5-5",
    "model_source": "default",
    "configured": False,
    "problem": None,
    "used_today": 0,
    "daily_limit": AI_DAILY_MAX,
}


class Ticker(off.Clock):
    """Die Uhr der KI-Vorschläge: steht, bis der Test sie weiterdreht."""

    def __init__(self) -> None:
        self.value = 1000.0
        self.moment = datetime(2026, 11, 17, 9, 0, tzinfo=UTC)

    def monotonic(self) -> float:
        return self.value

    def now(self) -> datetime:
        return self.moment


@pytest.fixture
def fake() -> FakeAnthropic:
    return FakeAnthropic()


@pytest.fixture
def ticker() -> Ticker:
    return Ticker()


@pytest.fixture
def client(settings, fake, ticker):
    app = create_app(settings, ai_transport=httpx2.MockTransport(fake), ai_clock=ticker)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def device(client) -> Device:
    return Device(client, "Handy")


def get(client: TestClient, device: Device) -> dict:
    response = client.get(CONFIG, headers=device.headers)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    AiConfig.model_validate(response.json())
    return response.json()


def patch(client: TestClient, device: Device, **body) -> httpx2.Response:
    return client.patch(CONFIG, json=body, headers=device.headers)


def saved(client: TestClient, device: Device, **body) -> dict:
    response = patch(client, device, **body)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    AiConfig.model_validate(response.json())
    assert KEY not in response.text and OTHER_KEY not in response.text
    return response.json()


def stored(settings) -> dict:
    """Was in ``server_config`` zu den KI-Vorschlägen steht."""
    con = db.connect(settings.database_path)
    try:
        return {
            row["key"]: serverconfig.get(con, row["key"])
            for row in con.execute("SELECT key FROM server_config WHERE key LIKE 'ai_%' ORDER BY key")
        }
    finally:
        con.close()


def changes(client: TestClient, device: Device) -> list[tuple[str, dict]]:
    return [
        (event["device_id"], event["data"])
        for event in events_of(client, device, entity="server")
        if event["type"] == "server.config_changed"
    ]


def checked(client: TestClient, device: Device, ticker: Ticker, **body) -> dict:
    ticker.value += hacheck.GAP_S
    response = client.post(CHECK, json=body, headers=device.headers)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    AiCheck.model_validate(response.json())
    assert KEY not in response.text and OTHER_KEY not in response.text
    return response.json()


# --- Lesen und Ändern --------------------------------------------------------------------------


def test_nothing_set_up(client, device):
    assert get(client, device) == EMPTY
    assert saved(client, device) == EMPTY  # ohne Felder ändert sich nichts
    assert client.get(CONFIG).status_code == 401
    assert client.patch(CONFIG, json={"key": KEY}).status_code == 401
    assert client.post(CHECK, json={}).status_code == 401


def test_setting_replacing_and_removing_the_key(client, device, settings):
    result = saved(client, device, key=f"  {KEY}  ")
    set_at = result["key_set_at"]
    assert result == {**EMPTY, "source": "app", "key_set": True, "key_set_at": set_at, "configured": True}
    assert get(client, device) == result
    # In der Datenbank nur der Merker, der Schlüssel (am Rand gekürzt) im eigenen Speicher.
    assert stored(settings) == {"ai_key_set_at": set_at}
    assert SecretStore(settings.secrets_dir).get(ANTHROPIC_KEY) == {"key": KEY, "set_at": set_at}
    assert changes(client, device) == [(device.id, {"keys": ["ai_key_set_at"]})]

    time.sleep(0.002)  # ein neuer Zeitstempel
    replaced = saved(client, device, key=OTHER_KEY)
    assert replaced["key_set"] is True and replaced["key_set_at"] > set_at
    assert SecretStore(settings.secrets_dir).get(ANTHROPIC_KEY)["key"] == OTHER_KEY
    assert len(changes(client, device)) == 2

    assert saved(client, device, key=None) == EMPTY
    assert SecretStore(settings.secrets_dir).get(ANTHROPIC_KEY) is None
    assert stored(settings) == {}
    assert len(changes(client, device)) == 3
    assert saved(client, device, key=None) == EMPTY  # nichts mehr zu entfernen: kein Ereignis
    assert len(changes(client, device)) == 3


def test_choosing_the_model(client, device, settings):
    result = saved(client, device, model="claude-sonnet-5-5")
    assert (result["model"], result["model_source"], result["configured"]) == (
        "claude-sonnet-5-5",
        "app",
        False,
    )
    assert stored(settings) == {"ai_model": "claude-sonnet-5-5"}
    assert saved(client, device, model="claude-sonnet-5-5") == result  # dasselbe noch einmal: kein Ereignis
    both = saved(client, device, model="claude-haiku-5-5", key=KEY)
    assert (both["model"], both["key_set"]) == ("claude-haiku-5-5", True)
    assert [data for _device, data in changes(client, device)] == [
        {"keys": ["ai_model"]},
        {"keys": ["ai_model", "ai_key_set_at"]},
    ]
    for body in ({"model": "gpt-5"}, {"model": None}, {"model": "claude-opus-4-1"}, {"anders": 1}):
        assert patch(client, device, **body).status_code == 422, body
    # Ein Modell, das es nicht (mehr) zur Wahl gibt, zählt nicht: die Vorgabe.
    con = db.connect(settings.database_path)
    try:
        with db.transaction(con):
            serverconfig.put(con, aiconfig.MODEL, "claude-opus-4-1", now="2026-11-17T09:00:00.000Z", by=None)
    finally:
        con.close()
    assert (get(client, device)["model"], get(client, device)["model_source"]) == (
        "claude-opus-5-5",
        "default",
    )


@pytest.mark.parametrize(
    ("key", "message"),
    [
        ("sk-ant-admin01-" + "a" * 40, ANTHROPIC_KEY_ADMIN),
        ("  sk-ant-admin01-geheim  ", ANTHROPIC_KEY_ADMIN),
        ("kein-schluessel-geheim", ANTHROPIC_KEY_SHAPE),
        ("sk-ant-api03-mit leer-geheim", ANTHROPIC_KEY_SHAPE),
        ("sk-ant-api03-ünicode-geheim", ANTHROPIC_KEY_SHAPE),
        ("SK-ANT-API03-GEHEIM", ANTHROPIC_KEY_SHAPE),
        ("sk-antgeheim", ANTHROPIC_KEY_SHAPE),
        ("   ", ANTHROPIC_KEY_SHAPE),
    ],
)
def test_a_key_of_the_wrong_shape_is_422_without_its_value(client, device, settings, ticker, key, message):
    for response in (
        patch(client, device, key=key),
        client.post(CHECK, json={"key": key}, headers=device.headers),
    ):
        assert response.status_code == 422, response.text
        assert response.json()["error"]["details"]["errors"] == [
            {"loc": ["body", "key"], "msg": message, "type": "ai_key"}
        ]
        assert response.headers["cache-control"] == "no-store"
        assert "geheim" not in response.text
        assert not key.strip() or key.strip() not in response.text
    assert stored(settings) == {} and SecretStore(settings.secrets_dir).get(ANTHROPIC_KEY) is None


@pytest.mark.parametrize("key", ["", "sk-ant-api03-" + "g" * 288, 12])
def test_what_the_contract_refuses_is_422(client, device, key):
    response = patch(client, device, key=key)
    assert response.status_code == 422, response.text
    assert "g" * 20 not in response.text


def test_the_environment_goes_first(settings, fake, ticker):
    env = dataclasses.replace(settings, anthropic_api_key=KEY)
    with TestClient(create_app(env, ai_transport=httpx2.MockTransport(fake), ai_clock=ticker)) as client:
        device = Device(client, "Handy")
        result = get(client, device)
        assert result == {**EMPTY, "source": "env", "key_set": True, "configured": True}
        for body in ({"key": OTHER_KEY}, {"key": None}, {"key": OTHER_KEY, "model": "claude-haiku-5-5"}):
            response = patch(client, device, **body)
            assert response.status_code == 409, body
            assert response.json()["error"]["message"] == aiconfig.KEY_FROM_ENVIRONMENT
            assert response.headers["cache-control"] == "no-store"
        assert get(client, device) == result  # nichts halb geändert
        assert (
            saved(client, device, model="claude-haiku-5-5")["model"] == "claude-haiku-5-5"
        )  # das Modell schon
        ticker.value += hacheck.GAP_S
        refused = client.post(CHECK, json={"key": OTHER_KEY}, headers=device.headers)
        assert (refused.status_code, refused.json()["error"]["message"]) == (409, aiconfig.CHECK_ENVIRONMENT)
        assert checked(client, device, ticker)["state"] == "ok"
        (request,) = fake.requests
        assert request.headers["authorization"] == f"Bearer {KEY}"
        assert request.url.path == "/v1/models/claude-haiku-5-5"


def test_a_key_missing_after_a_restore_is_named(client, device, settings, ticker):
    saved(client, device, key=KEY)
    SecretStore(settings.secrets_dir).delete(ANTHROPIC_KEY)  # Zurückspielen oder Umzug
    result = get(client, device)
    assert result == {**EMPTY, "source": "app", "problem": aiconfig.KEY_LOST}
    ticker.value += hacheck.GAP_S
    response = client.post(CHECK, json={}, headers=device.headers)
    assert response.status_code == 503
    assert response.json()["error"] == {
        "code": "not_configured",
        "message": aiconfig.KEY_LOST,
        "details": {"reason": "lost"},
    }
    # Eine Datei, die nicht taugt, zählt ebenso nicht.
    SecretStore(settings.secrets_dir).put(ANTHROPIC_KEY, {"key": "sk-ant-admin01-x", "set_at": "egal"})
    assert get(client, device)["problem"] == aiconfig.KEY_LOST
    # Neu eingetragen: wieder in Ordnung.
    assert saved(client, device, key=KEY)["problem"] is None


def test_a_secrets_folder_that_cannot_be_written_is_named(settings, fake):
    settings.data_dir.mkdir(parents=True)
    settings.secrets_dir.write_text("kein Ordner", encoding="utf-8")
    with TestClient(create_app(settings, ai_transport=httpx2.MockTransport(fake))) as client:
        device = Device(client, "Handy")
        assert get(client, device)["problem"] is not None
        refused = patch(client, device, key=KEY)
        assert refused.status_code == 500
        assert refused.json()["error"] == {
            "code": "internal",
            "message": aiconfig.KEY_NOT_WRITTEN,
            "details": None,
        }
        assert get(client, device)["key_set"] is False and stored(settings) == {}


# --- Prüfen ------------------------------------------------------------------------------------


def test_the_check_asks_anthropic_and_saves_nothing(client, device, settings, ticker, fake):
    ticker.value += hacheck.GAP_S
    missing = client.post(CHECK, json={}, headers=device.headers)
    assert missing.status_code == 503 and missing.json()["error"]["details"] == {"reason": "missing"}
    assert missing.headers["cache-control"] == "no-store"
    assert fake.requests == []

    saved(client, device, key=KEY)
    result = checked(client, device, ticker)
    assert result == {
        "state": "ok",
        "message": "Der API-Schlüssel gilt, und Claude Opus 5.5 steht bereit.",
        "model": "claude-opus-5-5",
    }
    (request,) = fake.requests
    assert (request.method, request.url.path) == ("GET", "/v1/models/claude-opus-5-5")
    assert request.headers["authorization"] == f"Bearer {KEY}"

    # Mit eigenen Werten: geprüft, aber nicht gespeichert.
    other = checked(client, device, ticker, key=OTHER_KEY, model="claude-haiku-5-5")
    assert (other["state"], other["model"]) == ("ok", "claude-haiku-5-5")
    assert fake.requests[-1].headers["authorization"] == f"Bearer {OTHER_KEY}"
    assert SecretStore(settings.secrets_dir).get(ANTHROPIC_KEY)["key"] == KEY
    assert get(client, device)["used_today"] == 0  # Prüfen zählt nicht

    fake.models = [failure(401, "authentication_error")]
    assert checked(client, device, ticker)["state"] == "key_rejected"


def test_one_check_at_a_time_and_three_seconds_apart(client, device, ticker, fake):
    saved(client, device, key=KEY)
    checked(client, device, ticker)
    ticker.value += 1
    response = client.post(CHECK, json={}, headers=device.headers)
    assert response.status_code == 429
    assert (response.headers["retry-after"], response.headers["cache-control"]) == ("2", "no-store")
    assert response.json()["error"]["code"] == "rate_limited"
    assert response.json()["error"]["details"] == {"retry_after_s": 2}
    assert len(fake.requests) == 1
    # Eine ungültige Eingabe zählt nicht als Prüfung.
    ticker.value += 3
    assert client.post(CHECK, json={"key": "kaputt"}, headers=device.headers).status_code == 422
    assert client.post(CHECK, json={}, headers=device.headers).status_code == 200


def test_a_broken_answer_to_the_check_is_an_error_not_a_500(client, device, ticker, fake, caplog):
    saved(client, device, key=KEY)
    fake.models = [
        lambda _request: httpx2.Response(
            200, content=b'{"type": "model", "id": ', headers={"content-type": "application/json"}
        ),
        lambda _request: httpx2.Response(200, text="<html>Captive Portal</html>"),
    ]
    for _ in range(2):
        result = checked(client, device, ticker)
        assert (result["state"], result["message"]) == ("error", claude.UNREADABLE)
    assert not [record for record in caplog.records if record.levelno >= logging.ERROR]
    assert "Captive" not in caplog.text


# --- Tageszähler -------------------------------------------------------------------------------


def usage(settings, value) -> None:
    con = db.connect(settings.database_path)
    try:
        with db.transaction(con):
            serverconfig.put(con, aiconfig.USAGE, value, now="2026-11-17T09:00:00.000Z", by=None)
    finally:
        con.close()


@pytest.mark.parametrize(
    ("stored", "today", "expected"),
    [
        ({"day": "2026-11-17", "count": 7}, "2026-11-17", ("2026-11-17", 7)),
        ({"day": "2026-11-16", "count": 7}, "2026-11-17", ("2026-11-17", 0)),  # ein neuer Tag
        ({"day": "2026-11-18", "count": 7}, "2026-11-17", ("2026-11-18", 7)),  # die Uhr sprang zurück
        ({"day": "2026-11-19", "count": 7}, "2026-11-17", ("2026-11-19", 7)),
        ({"day": "2026-11-20", "count": 7}, "2026-11-17", ("2026-11-17", 0)),  # zu weit: eine falsche Uhr
        ({"day": "2026-11-17", "count": -1}, "2026-11-17", ("2026-11-17", 0)),
        ({"day": "2026-11-17", "count": True}, "2026-11-17", ("2026-11-17", 0)),
        ({"day": "17.11.2026", "count": 7}, "2026-11-17", ("2026-11-17", 0)),
        ([1, 2], "2026-11-17", ("2026-11-17", 0)),
    ],
)
def test_the_day_that_counts(client, settings, stored, today, expected):
    assert aiconfig.CLOCK_BACK_DAYS == 2
    usage(settings, stored)
    con = db.connect(settings.database_path)
    try:
        assert aiconfig.counted(con, today) == expected
        assert aiconfig.used(con, today) == expected[1]
    finally:
        con.close()


def test_counting_and_crediting_stay_on_their_day(client, settings):
    usage(settings, {"day": "2026-11-18", "count": AI_DAILY_MAX - 1})
    con = db.connect(settings.database_path)
    try:
        with db.transaction(con):  # die Uhr steht einen Tag zurück: gezählt wird für den 18.
            assert aiconfig.take(con, "2026-11-17", now="x") == ("2026-11-18", AI_DAILY_MAX)
        with db.transaction(con):
            assert aiconfig.take(con, "2026-11-17", now="x") == ("2026-11-18", None)
        assert aiconfig.give_back(con, "2026-11-17", now="x") == 0  # ein anderer Tag: keine Gutschrift
        assert aiconfig.give_back(con, "2026-11-18", now="x") == AI_DAILY_MAX - 1
        assert serverconfig.get(con, aiconfig.USAGE) == {"day": "2026-11-18", "count": AI_DAILY_MAX - 1}
    finally:
        con.close()


def test_the_start_names_source_and_model_never_the_key(settings, fake, caplog):
    caplog.set_level(logging.INFO, logger="stowly")
    with TestClient(create_app(settings, ai_transport=httpx2.MockTransport(fake))) as client:
        device = Device(client, "Handy")
        saved(client, device, key=KEY, model="claude-sonnet-5-5")
    caplog.clear()
    with TestClient(create_app(settings, ai_transport=httpx2.MockTransport(fake))):
        pass
    assert "KI-Vorschläge mit claude-sonnet-5-5, Schlüssel aus der App." in caplog.messages
    SecretStore(settings.secrets_dir).delete(ANTHROPIC_KEY)
    caplog.clear()
    with TestClient(create_app(settings, ai_transport=httpx2.MockTransport(fake))):
        pass
    assert f"KI-Vorschläge: {aiconfig.KEY_LOST}" in caplog.messages
    caplog.clear()
    env = dataclasses.replace(
        settings, anthropic_api_key=KEY, dev=True, anthropic_base_url="http://127.0.0.1:4010"
    )
    with TestClient(create_app(env, ai_transport=httpx2.MockTransport(fake))):
        pass
    assert "KI-Vorschläge mit claude-sonnet-5-5, Schlüssel aus der Umgebung." in caplog.messages
    assert any("http://127.0.0.1:4010" in message for message in caplog.messages)
    assert KEY not in caplog.text


# --- Umgebung ----------------------------------------------------------------------------------


def test_the_key_from_the_environment_is_checked_like_the_one_from_the_app():
    settings = Settings.from_env({"STOWLY_ANTHROPIC_API_KEY": f"  {KEY}  "})
    assert settings.anthropic_api_key == KEY and KEY not in repr(settings)
    assert Settings.from_env({"STOWLY_ANTHROPIC_API_KEY": "  "}).anthropic_api_key is None
    for key, message in (
        ("sk-ant-admin01-geheim", ANTHROPIC_KEY_ADMIN),
        ("geheim-ohne-anfang", ANTHROPIC_KEY_SHAPE),
        ("sk-ant-api03-geheim mit leer", ANTHROPIC_KEY_SHAPE),
        ("sk-ant-api03-" + "g" * 300, ANTHROPIC_KEY_SHAPE),
    ):
        with pytest.raises(ValueError) as error:
            Settings.from_env({"STOWLY_ANTHROPIC_API_KEY": key})
        assert str(error.value) == f"STOWLY_ANTHROPIC_API_KEY: {message}"
        assert "geheim" not in str(error.value)


def test_a_wrong_key_in_the_environment_ends_the_start(monkeypatch, capsys, tmp_path):
    monkeypatch.setenv("STOWLY_DATA_DIR", str(tmp_path / "daten"))
    monkeypatch.setenv("STOWLY_ANTHROPIC_API_KEY", "sk-ant-admin01-geheimnis")
    assert main([]) == 2
    error = capsys.readouterr().err
    assert "Konfigurationsfehler: STOWLY_ANTHROPIC_API_KEY" in error and "geheimnis" not in error
    assert not (tmp_path / "daten").exists()


def test_the_base_url_is_only_for_development():
    for raw, expected in (
        ("http://127.0.0.1:4010", "http://127.0.0.1:4010"),
        (" http://127.0.0.1:4010/ ", "http://127.0.0.1:4010"),
    ):
        assert Settings.from_env({"STOWLY_ANTHROPIC_BASE_URL": raw}, dev=True).anthropic_base_url == expected
    assert Settings.from_env({}, dev=True).anthropic_base_url is None
    with pytest.raises(ValueError, match="nur im Entwicklungsmodus"):
        Settings.from_env({"STOWLY_ANTHROPIC_BASE_URL": "http://127.0.0.1:4010"}, dev=False)
    for raw in (
        "http://localhost:4010",
        "https://127.0.0.1:4010",
        "http://127.0.0.1",
        "http://127.0.0.1:0",
        "http://127.0.0.1:70000",
        "http://127.0.0.1:4010/v1",
        "http://127.0.0.1:4010?x=1",
        "http://10.0.0.1:4010",
        "http://127.0.0.1.example:4010",
        "https://api.anthropic.com",
    ):
        with pytest.raises(ValueError, match="STOWLY_ANTHROPIC_BASE_URL: erwartet"):
            Settings.from_env({"STOWLY_ANTHROPIC_BASE_URL": raw}, dev=True)


# --- Nie in Datenbank, Sicherung, Log oder Antwort ---------------------------------------------


def test_the_key_never_reaches_the_database_a_backup_the_log_or_an_answer(settings, caplog):
    caplog.set_level(logging.DEBUG)
    fake = FakeAnthropic()
    ticker = Ticker()
    answers: list[str] = []

    def keep(response: httpx2.Response) -> httpx2.Response:
        answers.append(response.text)
        return response

    app = create_app(settings, ai_transport=httpx2.MockTransport(fake), ai_clock=ticker)
    with TestClient(app) as client:
        device = Device(client, "Handy")
        device.sync()
        product_id, create = device.product("Kartoffeln vom Nachbarhof")
        _package_id, store = device.package(product_id, best_before="2026-11-19")
        device.sync([create, store])
        keep(client.patch(CONFIG, json={"key": KEY, "model": "claude-sonnet-5-5"}, headers=device.headers))
        ticker.value += hacheck.GAP_S
        keep(client.post(CHECK, json={}, headers=device.headers))
        ticker.value += hacheck.GAP_S
        keep(client.post(CHECK, json={"key": OTHER_KEY}, headers=device.headers))
        job = keep(client.post("/api/cook/ideas", json={"wish": "Geheimer Wunsch"}, headers=device.headers))
        assert job.status_code == 202, job.text
        for _ in range(500):
            state = keep(client.get(f"/api/cook/ideas/{job.json()['id']}", headers=device.headers)).json()[
                "state"
            ]
            if state != "running":
                break
            time.sleep(0.01)
        assert state == "done"
        keep(client.patch(CONFIG, json={"key": "sk-ant-admin01-" + KEY[7:]}, headers=device.headers))
        keep(client.patch(CONFIG, json={"key": OTHER_KEY}, headers=device.headers))
        for path in (
            CONFIG,
            "/api/server-config",
            "/api/integrations",
            "/api/setup",
            "/api/events",
            "/api/devices",
        ):
            keep(client.get(path, headers=device.headers))
    assert len(fake.requests) == 3

    for text in answers:
        assert KEY not in text and OTHER_KEY not in text and KEY[7:] not in text
    assert KEY not in caplog.text and OTHER_KEY not in caplog.text
    # Ins Log kommen von den KI-Vorschlägen nur Modell, Tokens und request-id, nie Inhalt; das SDK schweigt.
    ai_log = "\n".join(record.getMessage() for record in caplog.records if record.name == "stowly.ai")
    assert "req_fake_answer" in ai_log
    assert "Kartoffeln" not in ai_log and "Geheimer Wunsch" not in ai_log
    assert not [record for record in caplog.records if record.name.startswith("anthropic")]

    con = db.connect(settings.database_path)
    try:
        con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        keys = {row[0] for row in con.execute("SELECT key FROM server_config WHERE key LIKE 'ai_%'")}
    finally:
        con.close()
    for path in settings.data_dir.glob("stowly.sqlite3*"):
        content = path.read_bytes()
        assert KEY.encode() not in content and OTHER_KEY.encode() not in content, path.name
    image = autobackup.snapshot(settings.database_path)  # dieselbe Kopie wie jede Sicherung
    assert KEY.encode() not in image and OTHER_KEY.encode() not in image
    # In server_config stehen nur Modell, Merker und Zähler; der Schlüssel nur im eigenen Speicher.
    assert keys == {"ai_model", "ai_key_set_at", "ai_usage"} == set(aiconfig.KEYS)
    assert SecretStore(settings.secrets_dir).get(ANTHROPIC_KEY)["key"] == OTHER_KEY
