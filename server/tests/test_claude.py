"""Der Draht zu Anthropic (stowly/claude.py; docs/plan-0.6.md, 2.5 und 2.7).

Gegen die nachgebildete API (anthropic_fake.py): der gesendete Rumpf (effort, Schema, kein Sampling, kein
thinking, kein tool_choice), der Ersatz nur bei Opus und Sonnet, der Rechner, den keine Variable ANTHROPIC_*
umlenkt, der Schlüssel nur in der Kopfzeile, die ganze Fehlertabelle für Vorschläge und Prüfung samt
Wiederholung und „berechnet", Ablehnung, Ersatzmodell und unvollständige oder kaputte Antworten, ein Log ohne
Inhalt, das SDK erst beim ersten Gebrauch und außerhalb der Schleife; dazu das Schutznetz, wenn ein Test den
Transport vergisst.
"""

import asyncio
import json
import logging
import os
import subprocess
import sys
import threading
import time

import httpx2
import pytest
from anthropic_fake import (
    HAIKU,
    HOST,
    KEY,
    OPUS,
    OTHER_KEY,
    SONNET,
    FakeAnthropic,
    answer,
    broken,
    failure,
    idea,
    ideas_text,
    model_info,
    slow,
)
from conftest import REPO_ROOT

from stowly import claude, cook
from stowly.contract.api import COOK_MAX_TOKENS, COOK_MESSAGE_MAX, AiCheckState, AiModel, CookFailure

PROMPT = "Vorratsliste mit Kartoffelsalat-Geheimnis"


def ask(fake: FakeAnthropic | None, model: AiModel = AiModel.OPUS, *, base_url: str | None = None):
    """``Claude.ideas`` mit einem frischen Client; ohne ``fake`` über den echten Transport (Schutznetz)."""

    async def go():
        transport = httpx2.MockTransport(fake) if fake is not None else None
        client = claude.Claude(base_url=base_url, transport=transport)
        try:
            return await client.ideas(KEY, model, system="Systemtext", prompt=PROMPT, output=cook.Ideas)
        finally:
            await client.aclose()

    return asyncio.run(go())


def check(fake: FakeAnthropic | None, model: AiModel = AiModel.OPUS) -> dict:
    async def go():
        client = claude.Claude(transport=httpx2.MockTransport(fake) if fake is not None else None)
        try:
            return await client.check(KEY, model)
        finally:
            await client.aclose()

    return asyncio.run(go())


@pytest.fixture
def fake() -> FakeAnthropic:
    return FakeAnthropic()


@pytest.fixture(autouse=True)
def quick(monkeypatch):
    """Kurze Pausen vor dem zweiten Versuch (sonst wartet jeder Fall eine bis zwei Sekunden)."""
    monkeypatch.setattr(claude, "RETRY_PAUSE_S", 0.01)
    monkeypatch.setattr(claude, "RETRY_DEFAULT_S", 0.01)


# --- Was gesendet wird -------------------------------------------------------------------------


def test_the_request_body(fake):
    outcome = ask(fake)
    assert isinstance(outcome, claude.Answer)
    (request,) = fake.requests
    assert (request.method, request.url.scheme, request.url.host, request.url.path) == (
        "POST",
        "https",
        HOST,
        "/v1/messages",
    )
    body = json.loads(request.content)
    assert body["model"] == OPUS
    assert body["max_tokens"] == COOK_MAX_TOKENS == 8000
    assert body["system"] == "Systemtext"
    assert body["messages"] == [{"role": "user", "content": PROMPT}]  # eine Nachricht, kein Prefill
    assert body["output_config"]["effort"] == "low"
    output = body["output_config"]["format"]
    assert output["type"] == "json_schema"
    schema = output["schema"]
    assert (schema["required"], schema["additionalProperties"]) == (["ideas"], False)
    idea_schema = schema["$defs"]["Idea"]
    assert sorted(idea_schema["required"]) == sorted(
        ["title", "summary", "minutes", "uses", "missing", "steps", "search"]
    )
    assert idea_schema["additionalProperties"] is False
    # Ohne Grenzen im Schema: Gekürzt wird erst danach.
    text = json.dumps(schema)
    assert not any(word in text for word in ("maxLength", "maxItems", "minimum", "maximum"))
    for absent in ("temperature", "top_p", "top_k", "thinking", "tool_choice", "tools", "stream"):
        assert absent not in body, absent
    assert body["fallbacks"] == "default"
    assert request.headers["anthropic-beta"] == claude.FALLBACK_BETA == "server-side-fallback-2026-07-01"
    assert request.headers["anthropic-version"]


@pytest.mark.parametrize(
    ("model", "fallback"), [(AiModel.OPUS, True), (AiModel.SONNET, True), (AiModel.HAIKU, False)]
)
def test_only_opus_and_sonnet_ask_for_a_fallback(fake, model, fallback):
    fake.default = answer(model=model.value)
    assert isinstance(ask(fake, model), claude.Answer)
    (request,) = fake.requests
    body = json.loads(request.content)
    assert body["model"] == model.value
    assert ("fallbacks" in body, "anthropic-beta" in request.headers) == (fallback, fallback)
    if fallback:
        assert (body["fallbacks"], request.headers["anthropic-beta"]) == ("default", claude.FALLBACK_BETA)


def test_the_host_stays_api_anthropic_com_whatever_the_environment_says(fake, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://umleitung.example:8080")
    monkeypatch.setenv("ANTHROPIC_API_KEY", OTHER_KEY)
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "fremder-token")
    monkeypatch.setenv("ANTHROPIC_CUSTOM_HEADERS", f"Authorization: Bearer {OTHER_KEY}\nX-Fremd: ja")
    monkeypatch.setenv("ANTHROPIC_PROFILE", "fremd")
    monkeypatch.setenv("ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE", "content")
    assert isinstance(ask(fake), claude.Answer)
    assert check(fake)["state"] == AiCheckState.OK
    assert len(fake.requests) == 2
    for request in fake.requests:
        assert (request.url.scheme, request.url.host, request.url.port) == ("https", HOST, None)
        assert request.headers["authorization"] == f"Bearer {KEY}"
        for absent in ("x-fremd", "x-api-key", "traceparent"):
            assert absent not in request.headers, absent
        assert OTHER_KEY not in str(request.headers) and "fremder-token" not in str(request.headers)


def test_the_key_travels_only_in_the_authorization_header(fake):
    ask(fake)
    check(fake)
    for request in fake.requests:
        assert KEY not in str(request.url)
        assert KEY.encode() not in request.content
        assert [name for name, value in request.headers.items() if KEY in value] == ["authorization"]


def test_only_the_dev_address_replaces_the_host(fake):
    assert isinstance(ask(fake, base_url="http://127.0.0.1:4010"), claude.Answer)
    (request,) = fake.requests
    assert (request.url.scheme, request.url.host, request.url.port) == ("http", "127.0.0.1", 4010)


# --- Antworten ---------------------------------------------------------------------------------


def test_a_good_answer(fake):
    outcome = ask(fake)
    assert isinstance(outcome, claude.Answer)
    assert (outcome.model, outcome.fallback) == (OPUS, False)
    assert [item.title for item in outcome.parsed.ideas] == [
        "Spaghetti mit Tomatensoße",
        "Pfannkuchen",
        "Reispfanne",
    ]


def test_an_answer_from_the_fallback_model(fake):
    fake.default = answer(model="claude-opus-4-8", fallback_from=OPUS)
    outcome = ask(fake)
    assert isinstance(outcome, claude.Answer)
    assert (outcome.model, outcome.fallback) == ("claude-opus-4-8", True)
    # Auch wenn usage.iterations als Liste von dicts kommt (ohne Beta) und ohne Angabe: vorsichtig gelesen.
    fake.default = answer(model=HAIKU, fallback_from=SONNET)
    assert ask(fake, AiModel.HAIKU).fallback is True
    fake.default = answer(model=HAIKU)
    assert ask(fake, AiModel.HAIKU).fallback is False


@pytest.mark.parametrize(
    ("stop_details", "category"),
    [
        ({"type": "refusal", "category": "cyber", "explanation": "Erklärung"}, "cyber"),
        ({"type": "refusal", "category": None, "explanation": None}, None),
        (
            {"type": "refusal", "category": "eine_neue\nkategorie_" + "x" * 60},
            "eine_neue kategorie_" + "x" * 19 + "…",
        ),
        (None, None),
    ],
)
def test_a_refusal_with_or_without_details(fake, stop_details, category):
    # Auch mit einer halben Antwort davor: Erst zählt stop_reason, dann das Schema.
    fake.default = answer('{"ideas": [{"title": "Halb', stop_reason="refusal", stop_details=stop_details)
    outcome = ask(fake)
    assert outcome == claude.Failure(
        CookFailure.REFUSED, claude.MESSAGES[CookFailure.REFUSED], charged=True, category=category
    )


@pytest.mark.parametrize(
    "reply",
    [
        answer('{"ideas": [{"title": "Abgeschnitten', stop_reason="max_tokens"),
        answer(ideas_text(idea()), stop_reason="max_tokens"),
        answer(None),
        answer("kein JSON"),
        answer('{"ideas": [{"title": "ohne Rest"}]}'),
        answer('{"ideen": []}'),
    ],
)
def test_incomplete_answers(fake, reply):
    fake.default = reply
    assert ask(fake) == claude.Failure(
        CookFailure.INCOMPLETE, claude.MESSAGES[CookFailure.INCOMPLETE], charged=True
    )


# --- Fehler ------------------------------------------------------------------------------------


STOP = {"x-should-retry": "false"}


@pytest.mark.parametrize(
    ("reply", "reason"),
    [
        (failure(401, "authentication_error"), CookFailure.KEY_REJECTED),
        (failure(403, "permission_error"), CookFailure.FORBIDDEN),
        (failure(404, "not_found_error"), CookFailure.MODEL_UNAVAILABLE),
        (failure(400, "invalid_request_error"), CookFailure.ERROR),
        (failure(402, "billing_error"), CookFailure.BILLING),
        (failure(400, "billing_error"), CookFailure.BILLING),
        (failure(409, "conflict_error"), CookFailure.ERROR),
        (failure(413, "request_too_large"), CookFailure.ERROR),
        (failure(408, "timeout_error", headers={"x-should-retry": "true"}), CookFailure.ERROR),
        (failure(301, "weiter", headers={"location": "https://anderswo.example/"}), CookFailure.ERROR),
    ],
)
def test_an_answer_other_than_200_costs_nothing_and_is_final(fake, reply, reason):
    fake.messages = [reply]
    assert ask(fake) == claude.Failure(reason, claude.MESSAGES[reason], charged=False)
    assert len(fake.requests) == 1  # kein Weiterleiten, kein zweiter Versuch


@pytest.mark.parametrize(
    ("status", "kind", "reason"),
    [
        (429, "rate_limit_error", CookFailure.BUSY),
        (500, "api_error", CookFailure.UNAVAILABLE),
        (503, "api_error", CookFailure.UNAVAILABLE),
        (529, "overloaded_error", CookFailure.UNAVAILABLE),
    ],
)
def test_429_and_5xx_get_a_second_try(fake, status, kind, reason):
    fake.messages = [failure(status, kind), answer()]
    assert isinstance(ask(fake), claude.Answer)
    assert len(fake.requests) == 2
    # Scheitert auch der zweite, zählt nichts; retry_after_s kommt aus der letzten Antwort.
    fake.requests.clear()
    fake.messages = [failure(status, kind), failure(status, kind, headers={"retry-after": "7"}), answer()]
    assert ask(fake) == claude.Failure(reason, claude.MESSAGES[reason], charged=False, retry_after_s=7)
    assert len(fake.requests) == 2  # nie mehr als zwei Versuche


@pytest.mark.parametrize(
    ("headers", "retry_after"),
    [
        (STOP, None),  # Anthropic sagt: nicht wiederholen
        ({**STOP, "retry-after": "3"}, 3),
        ({"retry-after": "3600"}, 3600),  # wartet länger, als in die Frist passt
        ({"retry-after-ms": "60000"}, 60),
        ({"retry-after": "11"}, 11),
        ({"retry-after-ms": "10001"}, 11),
    ],
)
def test_no_second_try_when_anthropic_forbids_it_or_the_wait_is_too_long(fake, headers, retry_after):
    assert claude.RETRY_WAIT_MAX_S == 10.0
    for status, kind, reason in (
        (429, "rate_limit_error", CookFailure.BUSY),
        (529, "x", CookFailure.UNAVAILABLE),
    ):
        fake.requests.clear()
        fake.messages = [failure(status, kind, headers=headers), answer()]
        assert ask(fake) == claude.Failure(
            reason, claude.MESSAGES[reason], charged=False, retry_after_s=retry_after
        )
        assert len(fake.requests) == 1


def test_the_wait_comes_from_retry_after_ms_then_retry_after(fake, monkeypatch):
    monkeypatch.setattr(claude, "RETRY_WAIT_MAX_S", 0.05)
    # retry-after-ms geht vor: 50 ms passen, die 3600 s aus retry-after zählen dann nicht.
    fake.messages = [failure(529, "x", headers={"retry-after-ms": "50", "retry-after": "3600"}), answer()]
    assert isinstance(ask(fake), claude.Answer) and len(fake.requests) == 2
    fake.requests.clear()
    fake.messages = [failure(529, "x", headers={"retry-after-ms": "60"}), answer()]
    assert ask(fake).retry_after_s == 1 and len(fake.requests) == 1
    # Ohne brauchbare Angabe gilt RETRY_DEFAULT_S (hier 0,01 s).
    fake.requests.clear()
    fake.messages = [failure(429, "x", headers={"retry-after": "morgen"}), answer()]
    assert isinstance(ask(fake), claude.Answer) and len(fake.requests) == 2


@pytest.mark.parametrize(
    "kind", [httpx2.ConnectError, httpx2.ConnectTimeout, httpx2.PoolTimeout, httpx2.ProxyError]
)
def test_without_a_connection_it_tries_once_more_and_counts_nothing(fake, kind):
    fake.messages = [broken(kind), answer()]
    assert isinstance(ask(fake), claude.Answer)
    assert len(fake.requests) == 2
    fake.requests.clear()
    fake.messages = [broken(kind), broken(kind), answer()]
    assert ask(fake) == claude.Failure(
        CookFailure.UNREACHABLE, claude.MESSAGES[CookFailure.UNREACHABLE], charged=False
    )
    assert len(fake.requests) == 2


@pytest.mark.parametrize(
    ("kind", "reason"),
    [
        (httpx2.ReadTimeout, CookFailure.TIMEOUT),
        (httpx2.WriteTimeout, CookFailure.TIMEOUT),
        (httpx2.ReadError, CookFailure.UNREACHABLE),
        (httpx2.WriteError, CookFailure.UNREACHABLE),
        (httpx2.RemoteProtocolError, CookFailure.UNREACHABLE),
    ],
)
def test_a_connection_lost_after_sending_counts_and_is_final(fake, kind, reason):
    fake.messages = [broken(kind), answer()]
    message = claude.MESSAGES[reason] if reason == CookFailure.TIMEOUT else claude.ABORTED
    assert ask(fake) == claude.Failure(reason, message, charged=True)
    assert len(fake.requests) == 1


@pytest.mark.parametrize(
    ("first", "second", "expected"),
    [
        (broken(httpx2.ConnectError), broken(httpx2.ReadTimeout), (CookFailure.TIMEOUT, True)),
        (broken(httpx2.ConnectError), broken(httpx2.ReadError), (CookFailure.UNREACHABLE, True)),
        (broken(httpx2.ConnectError), failure(429, "x", headers=STOP), (CookFailure.BUSY, False)),
        (failure(529, "x"), broken(httpx2.RemoteProtocolError), (CookFailure.UNREACHABLE, True)),
        (failure(529, "x"), broken(httpx2.ConnectTimeout), (CookFailure.UNREACHABLE, False)),
        (failure(429, "x"), failure(401, "authentication_error"), (CookFailure.KEY_REJECTED, False)),
    ],
)
def test_the_last_try_decides(fake, first, second, expected):
    fake.messages = [first, second, answer()]
    outcome = ask(fake)
    assert (outcome.reason, outcome.charged) == expected
    assert len(fake.requests) == 2


def test_the_sdk_never_tries_again_on_its_own(fake):
    # x-should-retry: true ließe das SDK mit max_retries > 0 noch einmal fragen; es bleibt bei zwei Versuchen.
    fake.messages = [failure(529, "x", headers={"x-should-retry": "true"})] * 3 + [answer()]
    assert ask(fake).reason == CookFailure.UNAVAILABLE
    assert len(fake.requests) == 2
    for request in fake.requests:
        assert request.headers["x-stainless-retry-count"] == "0"


def test_a_broken_answer_with_200_counts_as_an_error(fake, caplog):
    caplog.set_level(logging.DEBUG)
    fake.messages = [
        lambda _request: httpx2.Response(
            200, content=b'{"type": "message", "Geheimer Anfang', headers={"content-type": "application/json"}
        )
    ]
    assert ask(fake) == claude.Failure(CookFailure.ERROR, claude.UNREADABLE, charged=True)
    assert "JSONDecodeError" in caplog.text and "Geheimer Anfang" not in caplog.text
    # Etwas anderes als eine Nachricht (etwa die Seite eines Proxys) ist unvollständig und zählt.
    fake.messages = [lambda _request: httpx2.Response(200, text="<html>Anmeldung</html>")]
    assert ask(fake) == claude.Failure(
        CookFailure.INCOMPLETE, claude.MESSAGES[CookFailure.INCOMPLETE], charged=True
    )


def test_every_reason_has_a_german_sentence_within_the_contract():
    assert set(claude.MESSAGES) == set(CookFailure)
    assert (
        set(claude.CHECK_MESSAGES)
        == set(claude.CHECK_STATES)
        == set(CookFailure) - {CookFailure.REFUSED, CookFailure.INCOMPLETE}
    )
    for text in [
        *claude.MESSAGES.values(),
        *claude.CHECK_MESSAGES.values(),
        claude.ABORTED,
        claude.UNREADABLE,
    ]:
        assert 0 < len(text) <= COOK_MESSAGE_MAX and text.endswith((".", "?")), text


@pytest.mark.parametrize(
    ("reply", "state", "message"),
    [
        (failure(401, "authentication_error"), AiCheckState.KEY_REJECTED, CookFailure.KEY_REJECTED),
        (failure(403, "permission_error"), AiCheckState.FORBIDDEN, CookFailure.FORBIDDEN),
        (failure(404, "not_found_error"), AiCheckState.MODEL_UNAVAILABLE, CookFailure.MODEL_UNAVAILABLE),
        (failure(429, "rate_limit_error", headers={"retry-after": "3"}), AiCheckState.BUSY, CookFailure.BUSY),
        (failure(529, "overloaded_error"), AiCheckState.BUSY, CookFailure.UNAVAILABLE),
        (failure(500, "api_error"), AiCheckState.BUSY, CookFailure.UNAVAILABLE),
        (failure(402, "billing_error"), AiCheckState.ERROR, CookFailure.BILLING),
        (failure(400, "invalid_request_error"), AiCheckState.ERROR, CookFailure.ERROR),
        (failure(418, "teapot_error"), AiCheckState.ERROR, CookFailure.ERROR),
        (broken(httpx2.ReadTimeout), AiCheckState.UNREACHABLE, CookFailure.TIMEOUT),
        (broken(httpx2.ConnectError), AiCheckState.UNREACHABLE, CookFailure.UNREACHABLE),
    ],
)
def test_every_error_of_the_check(fake, reply, state, message):
    fake.models = [reply]
    assert check(fake, AiModel.SONNET) == {
        "state": state,
        "message": claude.CHECK_MESSAGES[message],
        "model": AiModel.SONNET,
    }
    (request,) = fake.requests  # kein zweiter Versuch
    assert (request.method, request.url.path) == ("GET", "/v1/models/claude-sonnet-5-5")


def test_the_check_costs_no_tokens_and_has_a_deadline(fake, monkeypatch):
    result = check(fake, AiModel.HAIKU)
    assert result == {
        "state": AiCheckState.OK,
        "message": "Der API-Schlüssel gilt, und Claude Haiku 5.5 steht bereit.",
        "model": AiModel.HAIKU,
    }
    (request,) = fake.requests
    assert (request.method, request.url.host, request.url.path) == (
        "GET",
        HOST,
        "/v1/models/claude-haiku-5-5",
    )
    assert "anthropic-beta" not in request.headers
    assert claude.CHECK_S == 8.0
    monkeypatch.setattr(claude, "CHECK_S", 0.2)
    fake.models = [slow(5, model_info(OPUS))]
    began = time.monotonic()
    assert check(fake)["state"] == AiCheckState.UNREACHABLE
    assert time.monotonic() - began < 3


def model_reply(**body) -> object:
    return lambda _request: httpx2.Response(200, json=body)


@pytest.mark.parametrize(
    "reply",
    [
        lambda _request: httpx2.Response(
            200, content=b'{"type": "model", "Geheimer Rest', headers={"content-type": "application/json"}
        ),
        lambda _request: httpx2.Response(200, text="<html>Anmeldung im Gäste-WLAN</html>"),
        model_reply(type="model", id="claude-opus-4-8", display_name="x", created_at="2026-01-01T00:00:00Z"),
        model_reply(type="model", id="claude-opus-5-5-extra"),
        model_reply(id="claude-opus-5-5"),  # ohne type: kein Modell
        lambda _request: httpx2.Response(200, json=[1, 2, 3]),
    ],
)
def test_a_check_answer_that_is_not_this_model_is_an_error(fake, caplog, reply):
    caplog.set_level(logging.DEBUG)
    fake.models = [reply]
    assert check(fake) == {"state": AiCheckState.ERROR, "message": claude.UNREADABLE, "model": AiModel.OPUS}
    # Ins Log nur der Typ, nie die Antwort; und kein Fehler im Code.
    assert "Geheimer Rest" not in caplog.text and "Gäste-WLAN" not in caplog.text
    assert not [record for record in caplog.records if record.levelno >= logging.ERROR]


def test_a_dated_version_of_the_model_is_the_model(fake):
    fake.models = [model_reply(type="model", id="claude-opus-5-5-20261101", display_name="Claude Opus 5.5")]
    assert check(fake)["state"] == AiCheckState.OK


# --- Log und SDK -------------------------------------------------------------------------------


def test_the_log_counts_the_tokens_of_every_pass(fake, caplog):
    caplog.set_level(logging.INFO, logger="stowly.ai")
    fake.messages = [answer(model="claude-opus-4-8", fallback_from=OPUS, request_id="req_ersatz")]
    assert ask(fake).fallback is True
    # Abgelehnter Durchgang (1234 hinein) und Ersatz (1234 hinein, 567 heraus): die Summe.
    assert "2468 Tokens hinein, 567 heraus (über 2 Durchgänge), request-id req_ersatz" in caplog.text
    caplog.clear()
    fake.messages = [answer(request_id="req_einfach")]
    ask(fake)
    assert "1234 Tokens hinein, 567 heraus, request-id req_einfach" in caplog.text


def test_sdk_and_client_load_outside_the_event_loop(fake, monkeypatch):
    seen: list[tuple[str, threading.Thread]] = []
    load, make_http = claude.sdk, claude.Claude._new_http

    def loading():
        seen.append(("sdk", threading.current_thread()))
        return load()

    def making(self, anthropic):
        seen.append(("http", threading.current_thread()))
        return make_http(self, anthropic)

    monkeypatch.setattr(claude, "_sdk", None)  # als käme der erste Gebrauch
    monkeypatch.setattr(claude, "sdk", loading)
    monkeypatch.setattr(claude.Claude, "_new_http", making)
    loop_thread: list[threading.Thread] = []

    async def go():
        loop_thread.append(threading.current_thread())
        client = claude.Claude(transport=httpx2.MockTransport(fake))
        try:
            return await client.ideas(KEY, AiModel.OPUS, system="s", prompt="p", output=cook.Ideas)
        finally:
            await client.aclose()

    assert isinstance(asyncio.run(go()), claude.Answer)
    assert [what for what, _thread in seen[:2]] == ["sdk", "http"]
    assert all(thread is not loop_thread[0] for _what, thread in seen[:2])


def test_the_log_names_model_tokens_and_request_id_but_never_content(fake, caplog):
    caplog.set_level(logging.DEBUG)
    fake.messages = [
        answer(ideas_text(idea("Geheimrezept Kartoffelsuppe")), request_id="req_ok_0123"),
        answer('{"ideas": [{"title": "Geheimes Halbes'),
        failure(
            400,
            "invalid_request_error",
            "messages.0: " + "x" * 400 + " ENDE",
            headers={"request-id": "req_400"},
        ),
        failure(500, "api_error", "Interne Geheimnisse"),
    ]
    for _ in range(4):
        ask(fake)
    text = caplog.text
    assert "req_ok_0123" in text and OPUS in text and "1234" in text and "567" in text
    # 400: die Meldung von Anthropic, gekürzt, mit request-id; sonst nur Status und Fehlerart.
    assert "req_400" in text and "messages.0: xxx" in text and "ENDE" not in text
    assert "api_error" in text and "Interne Geheimnisse" not in text
    for secret in ("Geheimrezept", "Geheimes", "Kartoffelsalat-Geheimnis", KEY):
        assert secret not in text, secret
    assert not [record for record in caplog.records if record.name.startswith("anthropic")]


def test_the_sdk_logger_stays_at_warning_or_above():
    sdk_logger = logging.getLogger("anthropic")
    before = sdk_logger.level
    try:
        sdk_logger.setLevel(logging.DEBUG)
        claude.sdk()
        assert sdk_logger.level == logging.WARNING
        sdk_logger.setLevel(logging.ERROR)
        claude.sdk()
        assert sdk_logger.level == logging.ERROR  # leiser bleibt leiser
    finally:
        sdk_logger.setLevel(before)


def _python(code: str, **env: str) -> str:
    environment = {key: value for key, value in os.environ.items() if not key.startswith("ANTHROPIC_")}
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=REPO_ROOT / "server",
        env={**environment, **env},
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()


def test_export_and_start_need_no_sdk(tmp_path):
    code = (
        "import sys\n"
        "from stowly.app import build_app\n"
        "from stowly.config import Settings\n"
        "from stowly.contract import export\n"
        f"app = build_app(Settings.from_env({{'STOWLY_DATA_DIR': {str(tmp_path)!r}}}, dev=False))\n"
        "app.openapi()\n"
        "print('anthropic' in sys.modules)\n"
    )
    assert _python(code) == "False"


def test_anthropic_log_changes_nothing_on_the_first_import():
    code = (
        "import logging\n"
        "from stowly import claude\n"
        "claude.sdk()\n"
        "print(logging.getLogger('anthropic').level, logging.getLogger('httpx2').level,"
        " len(logging.getLogger().handlers))\n"
    )
    assert _python(code, ANTHROPIC_LOG="debug") == f"{logging.WARNING} {logging.NOTSET} 0"


# --- Schutznetz --------------------------------------------------------------------------------


def test_without_a_transport_a_real_call_fails_loudly():
    """Ohne Transport ginge die Anfrage ins Netz. Das Schutznetz (conftest.py) wirft ``pytest.fail``, und kein
    ``except Exception`` im SDK oder in claude.py macht daraus still einen Verbindungsfehler."""
    with pytest.raises(
        pytest.fail.Exception, match="wirklich ins Netz: GET https://api.anthropic.com/v1/models/"
    ):
        check(None)
    with pytest.raises(
        pytest.fail.Exception, match="wirklich ins Netz: POST https://api.anthropic.com/v1/messages"
    ):
        ask(None)
