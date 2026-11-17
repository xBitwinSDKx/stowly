"""Nachgebildete Anthropic-API für die Tests (docs/plan-0.6.md, 2.7).

``FakeAnthropic`` ist der Handler eines ``httpx2.MockTransport``: ``POST /v1/messages`` und
``GET /v1/models/{id}``, mit Antworten der Reihe nach (``messages``, ``models``), sonst einer Vorgabe.
Antworten baut ``answer``, Fehler ``failure``, Verbindungsprobleme ``broken``. Mit ``gate`` lassen sich
Anfragen anhalten, bis der Test sie freigibt. Nie ein echter Aufruf.

Die Schlüssel sind erfunden; sie haben nur die Form eines echten.
"""

import asyncio
import inspect
import json
import threading
from collections.abc import Callable
from typing import Any

import httpx2

KEY = "sk-ant-api03-" + "ErfundenerTestschluessel0123456789" * 3 + "-AbCdEf"
OTHER_KEY = "sk-ant-api03-" + "NochEinErfundenerSchluessel98765" * 3 + "-XyZ"
HOST = "api.anthropic.com"
OPUS = "claude-opus-5-5"
SONNET = "claude-sonnet-5-5"
HAIKU = "claude-haiku-5-5"

Reply = Callable[[httpx2.Request], Any]


def idea(
    title: str = "Spaghetti mit Tomatensoße",
    *,
    uses: tuple[str, ...] = ("P1",),
    summary: str = "Schnell gemacht und braucht die Tomaten auf.",
    minutes: int = 25,
    missing: tuple[str, ...] = ("Basilikum",),
    steps: tuple[str, ...] = ("Nudeln kochen.", "Tomaten schneiden und andünsten.", "Alles mischen."),
    search: str = "Spaghetti Tomaten",
) -> dict[str, Any]:
    """Ein Vorschlag im Schema, das der Server erbittet (``cook.Ideas``)."""
    return {
        "title": title,
        "summary": summary,
        "minutes": minutes,
        "uses": list(uses),
        "missing": list(missing),
        "steps": list(steps),
        "search": search,
    }


def ideas_text(*ideas: dict[str, Any]) -> str:
    """Der Text der Antwort: JSON nach dem Schema."""
    return json.dumps({"ideas": list(ideas)}, ensure_ascii=False)


THREE = ideas_text(
    idea(),
    idea("Pfannkuchen", uses=("P2",), minutes=30, missing=(), search="Pfannkuchen"),
    idea("Reispfanne", uses=("P1", "P2"), minutes=35, missing=("Paprika",), search="Reispfanne Gemüse"),
)


def answer(
    text: str | None = THREE,
    *,
    model: str = OPUS,
    stop_reason: str = "end_turn",
    stop_details: dict[str, Any] | None = None,
    fallback_from: str | None = None,
    request_id: str = "req_fake_answer",
) -> Reply:
    """Eine Antwort mit 200. ``fallback_from``: ein Ersatzmodell hat geantwortet (Block ``fallback`` und
    ``fallback_message`` in ``usage.iterations``, wie bei ``fallbacks: "default"``)."""
    content: list[dict[str, Any]] = []
    usage: dict[str, Any] = {
        "input_tokens": 1234,
        "output_tokens": 567,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
    }
    if fallback_from is not None:
        content.append({"type": "fallback", "from": {"model": fallback_from}, "to": {"model": model}})
        usage["iterations"] = [
            {
                "type": "message",
                "input_tokens": 1234,
                "output_tokens": 0,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": 0,
            },
            {
                "type": "fallback_message",
                "model": model,
                "input_tokens": 1234,
                "output_tokens": 567,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": 0,
            },
        ]
    if text is not None:
        content.append({"type": "text", "text": text})
    body = {
        "id": "msg_fake",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content,
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "stop_details": stop_details,
        "usage": usage,
    }
    return lambda _request: httpx2.Response(200, json=body, headers={"request-id": request_id})


def failure(
    status: int,
    error_type: str,
    message: str = "Fehler der nachgebildeten API",
    *,
    headers: dict[str, str] | None = None,
) -> Reply:
    """Eine Fehlerantwort im Format der Anthropic-API."""
    body = {
        "type": "error",
        "error": {"type": error_type, "message": message},
        "request_id": "req_fake_error",
    }
    return lambda _request: httpx2.Response(
        status, json=body, headers={"request-id": "req_fake_error", **(headers or {})}
    )


def broken(kind: type[httpx2.TransportError]) -> Reply:
    """Ein Verbindungsproblem, etwa ``httpx2.ConnectError`` oder ``httpx2.ReadTimeout``."""

    def reply(request: httpx2.Request) -> httpx2.Response:
        raise kind("nachgebildete Störung", request=request)

    return reply


def slow(seconds: float, then: Reply | None = None) -> Reply:
    """Antwortet erst nach ``seconds`` Sekunden."""

    async def reply(request: httpx2.Request) -> httpx2.Response:
        await asyncio.sleep(seconds)
        return (then or answer())(request)

    return reply


def model_info(model: str) -> Reply:
    body = {"type": "model", "id": model, "display_name": "Ein Modell", "created_at": "2026-01-01T00:00:00Z"}
    return lambda _request: httpx2.Response(200, json=body, headers={"request-id": "req_fake_model"})


class FakeAnthropic:
    """Der Handler für ``httpx2.MockTransport``; ``requests`` sind alle Anfragen in ihrer Reihenfolge."""

    def __init__(self) -> None:
        self.requests: list[httpx2.Request] = []
        self.messages: list[Reply] = []  # Antworten auf POST /v1/messages, der Reihe nach
        self.models: list[Reply] = []  # Antworten auf GET /v1/models/{id}, der Reihe nach
        self.default: Reply = answer()
        # Gelöscht hält jede Anfrage an, bis der Test sie wieder setzt (über Threads hinweg).
        self.gate = threading.Event()
        self.gate.set()

    async def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        while not self.gate.is_set():
            await asyncio.sleep(0.005)
        if request.method == "POST" and request.url.path == "/v1/messages":
            reply = self.messages.pop(0) if self.messages else self.default
        elif request.method == "GET" and request.url.path.startswith("/v1/models/"):
            reply = self.models.pop(0) if self.models else model_info(request.url.path.rsplit("/", 1)[-1])
        else:
            reply = failure(404, "not_found_error", "Unbekannter Pfad")
        result = reply(request)
        if inspect.isawaitable(result):
            result = await result
        return result

    def sent(self) -> list[dict[str, Any]]:
        """Die Rümpfe aller Anfragen an ``/v1/messages``."""
        return [
            json.loads(request.content) for request in self.requests if request.url.path == "/v1/messages"
        ]
