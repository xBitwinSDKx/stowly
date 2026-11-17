"""Der Draht zu Anthropic für die KI-Vorschläge (docs/plan-0.6.md, 2.2 und 2.5; docs/integrationen.md, 13).

* **Einzige Stelle mit ``import anthropic``,** und erst beim ersten Gebrauch (``sdk``): Der Export des
  Vertrags und der Start des Servers kommen ohne das SDK aus. Der erste Import (fast eine Sekunde) und der
  geteilte HTTP-Client entstehen in einem Thread, nicht in der Schleife der App (``Claude._prepare``).
* **Ein langlebiger HTTP-Client:** ``Claude`` entsteht im ``lifespan`` der App und schließt dort seinen
  ``DefaultAsyncHttpxClient`` (``transport`` ist der Ersatz für Tests). Je Aufruf gibt es einen eigenen
  ``AsyncAnthropic`` mit dem Schlüssel von jetzt, nie als ``async with``: Das schlösse den geteilten Client.
* **Nichts aus der Umgebung:** Schlüssel und Rechner stehen immer ausdrücklich da (``https://api.anthropic.com``,
  nur mit ``--dev`` auch ``STOWLY_ANTHROPIC_BASE_URL``). Die Variablen ``ANTHROPIC_*`` lenken nichts um: weder
  Schlüssel noch Rechner noch Kopfzeilen (``ANTHROPIC_CUSTOM_HEADERS``), keine Spuren (OpenTelemetry) und kein
  Log (``ANTHROPIC_LOG``). Einer Weiterleitung folgt der Client nicht.
* **Aufruf der Vorschläge:** strukturierte Ausgabe nach einem Pydantic-Schema (``output_config.format``, so
  wie ``messages.parse`` es baut), ``effort`` ``COOK_EFFORT``, ``max_tokens`` ``COOK_MAX_TOKENS``; ohne
  ``thinking``, Sampling-Parameter, Tools, ``tool_choice`` und Prefill. Opus und Sonnet fragen über die Beta
  mit Ersatzmodell bei einer Ablehnung (``fallbacks: "default"``), Haiku ohne. Erst wird ``stop_reason``
  gelesen, dann das Schema geprüft: ``messages.parse`` prüfte vorher und verlöre bei einer abgebrochenen
  Antwort (Ablehnung mitten in der Ausgabe, ``max_tokens``) Grund, Modell, Tokens und request-id.
* **Wiederholung und „berechnet":** Das SDK wiederholt nie (``max_retries=0``); ``ideas`` versucht es höchstens
  ``ATTEMPTS``-mal, und ein zweites Mal nur, wenn der erste Versuch sicher nichts gekostet hat: keine Verbindung
  (``UNSENT``) oder eine Antwort 429 oder 5xx, die eine Wiederholung erlaubt und deren Wartezeit höchstens
  ``RETRY_WAIT_MAX_S`` beträgt. Was am Ende gilt (``Failure.charged``): Eine Antwort mit 200 (auch abgelehnt oder
  unvollständig) zählt, jede andere Antwort nicht, keine Verbindung nicht; eine Verbindung, die nach dem Senden
  abbricht, zählt (``timeout`` bei ``TIMED_OUT``, sonst ``unreachable``).
* **Log:** Modell, Tokens und request-id, nie Inhalt und nie der Schlüssel. Der Logger ``anthropic`` steht auf
  höchstens WARNING; seine Debug-Ausgabe enthielte den Bestand.
* **Fehler** von Anthropic sind Ergebnisse, keine Ausnahmen: ``check`` liefert ``AiCheck``, ``ideas`` eine
  ``Answer`` oder ein ``Failure`` mit deutschem Satz und dem Merker ``charged``, nach dem ``cook.py``
  gutschreibt.
"""

import asyncio
import logging
import math
import re
import threading
from dataclasses import dataclass
from types import ModuleType
from typing import Any

import httpx2
from pydantic import BaseModel, ValidationError

from stowly import texts
from stowly.contract.api import COOK_EFFORT, COOK_MAX_TOKENS, AiCheckState, AiModel, CookFailure

log = logging.getLogger("stowly.ai")

API_URL = "https://api.anthropic.com"
# Prüfen: GET /v1/models/{id} kostet keine Tokens; eine Frist für alles, kein zweiter Versuch.
CHECK_S = 8.0
# Vorschläge: die Fristen des SDK je Versuch (die Frist des ganzen Auftrags setzt cook.py).
IDEAS_S = 80.0
IDEAS_CONNECT_S = 5.0
# Höchstens so viele Versuche; der zweite nur, wenn der erste sicher nichts gekostet hat.
ATTEMPTS = 2
# Keine Verbindung: so lange warten, dann noch einmal.
RETRY_PAUSE_S = 1.0
# Eine Antwort 429 oder 5xx ohne Angabe, wie lange: so lange warten.
RETRY_DEFAULT_S = 1.5
# Höchstens so lange wartet eine Wiederholung; länger passt nicht in die Frist des Auftrags.
RETRY_WAIT_MAX_S = 10.0
# Nicht gesendet: Die Verbindung kam gar nicht zustande, Anthropic hat nichts gesehen (ProxyError: Ein Proxy
# aus der Umgebung lehnte schon den Aufbau ab).
UNSENT = (httpx2.ConnectError, httpx2.ConnectTimeout, httpx2.PoolTimeout, httpx2.ProxyError)
# Gesendet, dann keine Antwort in der Frist: zählt als Zeitüberschreitung.
TIMED_OUT = (httpx2.ReadTimeout, httpx2.WriteTimeout)
# Ersatzmodell, wenn das gewählte ablehnt (docs/plan-0.6.md, 2.5): nur Opus und Sonnet haben eins.
FALLBACK_BETA = "server-side-fallback-2026-07-01"
FALLBACK_MODELS = frozenset({AiModel.OPUS, AiModel.SONNET})
# Was von Anthropic kommt und in einer Antwort oder im Log steht, höchstens so lang.
MODEL_MAX = 100
CATEGORY_MAX = 40
LOGGED_MAX = 200
RETRY_AFTER_MAX_S = 24 * 3600

MODEL_NAMES = {
    AiModel.OPUS: "Claude Opus 5.5",
    AiModel.SONNET: "Claude Sonnet 5.5",
    AiModel.HAIKU: "Claude Haiku 5.5",
}

# Deutsche Sätze je Grund eines gescheiterten Auftrags (CookProblem.message).
MESSAGES: dict[CookFailure, str] = {
    CookFailure.REFUSED: "Claude lehnt diese Anfrage ab. Vielleicht hilft es, den Wunsch anders zu formulieren.",
    CookFailure.KEY_REJECTED: (
        "Anthropic lehnt den API-Schlüssel ab. Bitte in den Einstellungen prüfen oder neu eintragen."
    ),
    CookFailure.FORBIDDEN: (
        "Der API-Schlüssel darf das nicht (Rechte des Kontos oder Arbeitsbereichs in der Console prüfen)."
    ),
    CookFailure.BILLING: (
        "Für das Konto des API-Schlüssels gibt es kein Guthaben, oder die Abrechnung ist nicht eingerichtet "
        "(Console, Billing)."
    ),
    CookFailure.MODEL_UNAVAILABLE: (
        "Das gewählte Modell steht für diesen API-Schlüssel nicht bereit. Bitte in den Einstellungen ein "
        "anderes wählen."
    ),
    CookFailure.BUSY: "Anthropic bremst gerade (zu viele Anfragen). Bitte später noch einmal versuchen.",
    CookFailure.UNAVAILABLE: "Anthropic ist gerade überlastet oder gestört. Bitte später noch einmal versuchen.",
    CookFailure.UNREACHABLE: "Anthropic ist nicht erreichbar (Internetverbindung oder DNS des Servers prüfen).",
    CookFailure.TIMEOUT: "Claude hat nicht rechtzeitig geantwortet. Bitte noch einmal versuchen.",
    CookFailure.INCOMPLETE: "Die Antwort von Claude war unvollständig. Bitte noch einmal versuchen.",
    CookFailure.ERROR: "Anthropic hat die Anfrage nicht angenommen (Einzelheiten im Log des Servers).",
}
# Gesendet, dann brach die Verbindung ab (unreachable, aber berechnet).
ABORTED = "Die Verbindung zu Anthropic ist während der Anfrage abgebrochen. Bitte noch einmal versuchen."
# Eine Antwort mit 200, aber nichts Lesbares (kein JSON, kein Modell): etwa ein Proxy dazwischen.
UNREADABLE = "Die Antwort kam nicht lesbar von Anthropic (Einzelheiten im Log des Servers)."
# Dasselbe für die Prüfung (AiCheck kennt weniger Zustände).
CHECK_STATES: dict[CookFailure, AiCheckState] = {
    CookFailure.KEY_REJECTED: AiCheckState.KEY_REJECTED,
    CookFailure.FORBIDDEN: AiCheckState.FORBIDDEN,
    CookFailure.MODEL_UNAVAILABLE: AiCheckState.MODEL_UNAVAILABLE,
    CookFailure.BUSY: AiCheckState.BUSY,
    CookFailure.UNAVAILABLE: AiCheckState.BUSY,
    CookFailure.UNREACHABLE: AiCheckState.UNREACHABLE,
    CookFailure.TIMEOUT: AiCheckState.UNREACHABLE,
    CookFailure.BILLING: AiCheckState.ERROR,
    CookFailure.ERROR: AiCheckState.ERROR,
}
CHECK_MESSAGES: dict[CookFailure, str] = {
    CookFailure.KEY_REJECTED: "Anthropic lehnt den API-Schlüssel ab. Ist er vollständig, und gilt er noch?",
    CookFailure.FORBIDDEN: MESSAGES[CookFailure.FORBIDDEN],
    CookFailure.MODEL_UNAVAILABLE: (
        "Das Modell steht für diesen API-Schlüssel nicht bereit; bitte ein anderes wählen."
    ),
    CookFailure.BUSY: "Anthropic bremst gerade (zu viele Anfragen). Bitte später noch einmal prüfen.",
    CookFailure.UNAVAILABLE: "Anthropic ist gerade überlastet oder gestört. Bitte später noch einmal prüfen.",
    CookFailure.UNREACHABLE: MESSAGES[CookFailure.UNREACHABLE],
    CookFailure.TIMEOUT: (
        f"Anthropic hat nicht rechtzeitig geantwortet (die Prüfung wartet höchstens {CHECK_S:.0f} Sekunden)."
    ),
    CookFailure.BILLING: MESSAGES[CookFailure.BILLING],
    CookFailure.ERROR: "Anthropic hat die Prüfung nicht angenommen (Einzelheiten im Log des Servers).",
}


# --- Das SDK -----------------------------------------------------------------------------------

_sdk: ModuleType | None = None
_sdk_lock = threading.Lock()


def sdk() -> ModuleType:
    """Das SDK ``anthropic``, beim ersten Aufruf importiert (``Claude`` tut das in einem Thread).

    ``ANTHROPIC_LOG`` stellt dabei nichts um: Was der Import an der Wurzel der Logger und an ``httpx2``
    ändert, wird zurückgenommen, und der Logger ``anthropic`` steht danach auf höchstens WARNING, auch bei
    ``STOWLY_LOG_LEVEL=debug``. Seine Debug-Ausgabe enthielte die ganze Anfrage samt Bestand.
    """
    global _sdk
    with _sdk_lock:
        if _sdk is None:
            root = logging.getLogger()
            transport = logging.getLogger("httpx2")
            handlers, root_level, transport_level = list(root.handlers), root.level, transport.level
            import anthropic

            for handler in root.handlers[:]:
                if handler not in handlers:
                    root.removeHandler(handler)
            root.setLevel(root_level)
            transport.setLevel(transport_level)
            _sdk = anthropic
        quiet = logging.getLogger("anthropic")
        if quiet.level < logging.WARNING:
            quiet.setLevel(logging.WARNING)
        return _sdk


# --- Ergebnisse --------------------------------------------------------------------------------


@dataclass(frozen=True)
class Answer:
    """Eine brauchbare Antwort: das geprüfte Ausgabe-Schema, das Modell, das antwortete (bei einem Ersatz
    dieses), und ob es ein Ersatzmodell war."""

    parsed: Any
    model: str
    fallback: bool


@dataclass(frozen=True)
class Failure:
    """Kein Ergebnis, mit deutschem Satz. ``charged``: Anthropic hat die Anfrage vermutlich berechnet (eine
    Antwort mit 200, auch Ablehnung oder unvollständig, oder eine Verbindung, die nach dem Senden abbrach);
    sonst schreibt ``cook.py`` die Anfrage dem Tageszähler gut."""

    reason: CookFailure
    message: str
    charged: bool
    retry_after_s: int | None = None
    category: str | None = None


def failure(reason: CookFailure, *, charged: bool, **more: Any) -> Failure:
    """Ein ``Failure`` mit dem deutschen Satz zu ``reason`` (``MESSAGES``)."""
    return Failure(reason, MESSAGES[reason], charged, **more)


def _clean(value: Any, limit: int) -> str | None:
    """Ein Wert von Anthropic für Log oder Antwort: nur Text, gesäubert und gekürzt; sonst ``None``."""
    return (texts.clean(value, limit) or None) if isinstance(value, str) else None


def _request_id(source: Any) -> str:
    """Die request-id einer Antwort oder eines Fehlers fürs Log; ``-``, wenn es keine gibt."""
    value = getattr(source, "_request_id", None) or getattr(source, "request_id", None)
    return _clean(value, MODEL_MAX) or "-"


def _status_reason(exc: Any) -> CookFailure:
    """Der Grund zu einer Antwort außer 200 (``APIStatusError``)."""
    status = exc.status_code
    if status == 402 or exc.type == "billing_error":
        return CookFailure.BILLING
    if status == 401:
        return CookFailure.KEY_REJECTED
    if status == 403:
        return CookFailure.FORBIDDEN
    if status == 404:
        return CookFailure.MODEL_UNAVAILABLE
    if status == 429:
        return CookFailure.BUSY
    if status >= 500:  # auch 529 (überlastet)
        return CookFailure.UNAVAILABLE
    return CookFailure.ERROR  # 400 und alles Übrige


def _retry_wait(exc: Any) -> float | None:
    """Wie lange Anthropic warten lässt, in Sekunden: ``retry-after-ms``, sonst ``retry-after`` (nur als Zahl);
    ``None`` ohne brauchbare Angabe."""
    for name, scale in (("retry-after-ms", 0.001), ("retry-after", 1.0)):
        raw = exc.response.headers.get(name)
        if not isinstance(raw, str):
            continue
        try:
            value = float(raw.strip())
        except ValueError:
            continue
        if math.isfinite(value) and value >= 0:
            return value * scale
    return None


def _retryable(exc: Any) -> bool:
    """Darf eine Antwort außer 200 wiederholt werden? 429 und 5xx (auch 529), außer Anthropic sagt
    ``x-should-retry: false``."""
    allowed = exc.response.headers.get("x-should-retry", "").strip().lower() != "false"
    return allowed and (exc.status_code == 429 or exc.status_code >= 500)


def _log_status(what: str, exc: Any, key: str) -> None:
    """Eine Antwort außer 200 im Log: Status, Fehlerart und request-id; bei 400 dazu die Meldung von Anthropic,
    gekürzt (sie beschreibt, was an der Anfrage nicht stimmt). Nie der Schlüssel."""
    if exc.status_code == 400:
        message = exc.message.replace(key, "…") if isinstance(exc.message, str) else ""
        log.warning(
            "KI-Vorschläge (%s): Anthropic lehnt die Anfrage ab (400): %s (request-id %s)",
            what,
            texts.clean(message, LOGGED_MAX),
            _request_id(exc),
        )
        return
    log.warning(
        "KI-Vorschläge (%s): Anthropic antwortet %d (%s), request-id %s.",
        what,
        exc.status_code,
        _clean(exc.type, CATEGORY_MAX) or "ohne Fehlerart",
        _request_id(exc),
    )


def _cause(exc: BaseException) -> str:
    """Der Name der eigentlichen Ursache eines Verbindungsfehlers (ohne Meldung: Die nennt Adressen)."""
    return type(exc.__cause__ or exc).__name__


def _unsent(exc: BaseException) -> bool:
    """Kam die Anfrage gar nicht erst bei Anthropic an (keine Verbindung)?"""
    return isinstance(exc.__cause__, UNSENT)


def _broken_off(exc: BaseException, timed_out: bool) -> Failure:
    """Ein Verbindungsfehler im letzten Versuch: nicht gesendet zählt nicht; gesendet und abgebrochen zählt,
    als ``timeout`` (``TIMED_OUT``) oder ``unreachable``."""
    if _unsent(exc):
        log.warning("KI-Vorschläge: Anthropic ist nicht erreichbar (%s).", _cause(exc))
        return failure(CookFailure.UNREACHABLE, charged=False)
    if isinstance(exc.__cause__, TIMED_OUT) or (exc.__cause__ is None and timed_out):
        log.warning("KI-Vorschläge: Anthropic antwortet nicht rechtzeitig (%s).", _cause(exc))
        return failure(CookFailure.TIMEOUT, charged=True)
    log.warning("KI-Vorschläge: Die Verbindung zu Anthropic brach nach dem Senden ab (%s).", _cause(exc))
    return Failure(CookFailure.UNREACHABLE, ABORTED, charged=True)


def _seconds(wait: float | None) -> int | None:
    return None if wait is None else min(math.ceil(wait), RETRY_AFTER_MAX_S)


def _field(entry: Any, name: str) -> Any:
    return entry.get(name) if isinstance(entry, dict) else getattr(entry, name, None)


def _count(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _fallback(usage: Any) -> bool:
    """Hat ein Ersatzmodell geantwortet? Dann steht ein ``fallback_message`` in ``usage.iterations`` (in der
    Beta ein Modell, sonst eine Liste von dicts; ohne die Angabe: nein)."""
    iterations = getattr(usage, "iterations", None)
    if not isinstance(iterations, list):
        return False
    return any(_field(entry, "type") == "fallback_message" for entry in iterations)


def _tokens(usage: Any) -> tuple[str, str, int]:
    """Tokens hinein und heraus fürs Log, mit der Zahl der Durchgänge: über alle Durchgänge in
    ``usage.iterations``, wenn jeder eine Zählung hat (Ersatzmodell), sonst die der Antwort."""
    iterations = getattr(usage, "iterations", None)
    if isinstance(iterations, list) and iterations:
        counts = [
            (_count(_field(entry, "input_tokens")), _count(_field(entry, "output_tokens")))
            for entry in iterations
        ]
        if all(tokens_in is not None and tokens_out is not None for tokens_in, tokens_out in counts):
            return (
                str(sum(tokens_in or 0 for tokens_in, _ in counts)),
                str(sum(tokens_out or 0 for _, tokens_out in counts)),
                len(counts),
            )
    tokens_in, tokens_out = (
        _count(getattr(usage, "input_tokens", None)),
        _count(getattr(usage, "output_tokens", None)),
    )
    return ("?" if tokens_in is None else str(tokens_in), "?" if tokens_out is None else str(tokens_out), 1)


def _text(message: Any) -> str | None:
    """Der Text der Antwort: die Textblöcke nach dem letzten Wechsel zum Ersatzmodell; ``None`` ohne."""
    content = getattr(message, "content", None)
    blocks = list(content) if isinstance(content, list) else []
    start = 0
    for index, block in enumerate(blocks):
        if getattr(block, "type", None) == "fallback":
            start = index + 1
    parts = [
        block.text
        for block in blocks[start:]
        if getattr(block, "type", None) == "text" and isinstance(getattr(block, "text", None), str)
    ]
    return "".join(parts) if parts else None


def _read(message: Any, output: type[BaseModel]) -> Answer | Failure:
    """Eine Antwort mit 200: erst ``stop_reason``, dann das Schema. Ins Log kommen Modell, Tokens und
    request-id, nie der Inhalt (auch keine Meldung der Prüfung: Die zitierte ihn)."""
    model = _clean(getattr(message, "model", None), MODEL_MAX) or "unbekannt"
    usage = getattr(message, "usage", None)
    fallback = _fallback(usage)
    stop = getattr(message, "stop_reason", None)
    request_id = _request_id(message)
    tokens_in, tokens_out, passes = _tokens(usage)
    log.info(
        "KI-Vorschläge: Antwort von %s%s, Ende %s, %s Tokens hinein, %s heraus%s, request-id %s.",
        model,
        " (Ersatzmodell)" if fallback else "",
        _clean(stop, CATEGORY_MAX) or "-",
        tokens_in,
        tokens_out,
        f" (über {passes} Durchgänge)" if passes > 1 else "",
        request_id,
    )
    if stop == "refusal":
        details = getattr(message, "stop_details", None)
        category = _clean(getattr(details, "category", None), CATEGORY_MAX)
        return failure(CookFailure.REFUSED, charged=True, category=category)
    if stop == "max_tokens":
        return failure(CookFailure.INCOMPLETE, charged=True)
    text = _text(message)
    if text is None:
        return failure(CookFailure.INCOMPLETE, charged=True)
    try:
        parsed = output.model_validate_json(text)
    except ValidationError:
        log.warning("KI-Vorschläge: Die Antwort passt nicht zum Schema (request-id %s).", request_id)
        return failure(CookFailure.INCOMPLETE, charged=True)
    return Answer(parsed=parsed, model=model, fallback=fallback)


def _is_model(info: Any, model: AiModel) -> bool:
    """Ist die Antwort der Prüfung das geprüfte Modell? Ein Modell mit derselben Kennung oder einer datierten
    Fassung davon (``claude-…-YYYYMMDD``); alles andere (etwa die Seite eines Proxys) nicht."""
    ident = getattr(info, "id", None)
    return (
        getattr(info, "type", None) == "model"
        and isinstance(ident, str)
        and re.fullmatch(re.escape(model.value) + r"(?:-[0-9]{8})?", ident) is not None
    )


# --- Der Client --------------------------------------------------------------------------------


class Claude:
    """Anfragen an Anthropic. Liegt im laufenden Betrieb in ``app.state.claude``.

    ``base_url`` ist ``None`` (https://api.anthropic.com) oder, nur mit ``--dev``, die nachgebildete API der
    e2e-Tests; ``transport`` ersetzt in Tests die Verbindung. Wirft nur bei einem Fehler im Code.
    """

    def __init__(
        self, *, base_url: str | None = None, transport: httpx2.AsyncBaseTransport | None = None
    ) -> None:
        self.base_url = base_url or API_URL
        self._transport = transport
        self._http: httpx2.AsyncClient | None = None
        self._ready = asyncio.Lock()

    async def _prepare(self) -> ModuleType:
        """Das SDK und der geteilte HTTP-Client. Beim ersten Mal beides in einem Thread: Der Import braucht fast
        eine Sekunde und der Client sein TLS, und die Schleife der App soll derweil weiter antworten."""
        async with self._ready:
            anthropic = sdk() if _sdk is not None else await asyncio.to_thread(sdk)
            if self._http is None:
                self._http = await asyncio.to_thread(self._new_http, anthropic)
        return anthropic

    def _new_http(self, anthropic: ModuleType) -> httpx2.AsyncClient:
        options: dict[str, Any] = {"follow_redirects": False}
        if self._transport is not None:
            options["transport"] = self._transport
        return anthropic.DefaultAsyncHttpxClient(**options)

    def _client(self, anthropic: ModuleType, key: str, *, timeout: Any) -> Any:
        """Ein ``AsyncAnthropic`` für einen Aufruf auf dem geteilten HTTP-Client, ohne Wiederholung im SDK."""
        client = anthropic.AsyncAnthropic(
            api_key=key,
            base_url=self.base_url,
            http_client=self._http,
            max_retries=0,
            timeout=timeout,
            open_telemetry={"traces": False, "propagation": False},
        )
        # ANTHROPIC_CUSTOM_HEADERS aus der Umgebung landete sonst in jeder Anfrage, bis hin zu einer anderen
        # Anmeldung (Authorization); das SDK liest die Variable im Konstruktor.
        client._custom_headers = {}
        return client

    async def aclose(self) -> None:
        """Schließt den HTTP-Client (im ``lifespan``); ein späterer Aufruf legte einen neuen an."""
        http, self._http = self._http, None
        if http is not None:
            await http.aclose()

    async def check(self, key: str, model: AiModel) -> dict[str, Any]:
        """``AiCheck`` zu Schlüssel und Modell über ``GET /v1/models/{id}`` (kostet keine Tokens):
        ``CHECK_S`` Sekunden Frist, kein zweiter Versuch. ``ok`` nur, wenn die Antwort dieses Modell ist."""
        anthropic = await self._prepare()
        client = self._client(anthropic, key, timeout=anthropic.Timeout(CHECK_S))
        try:
            async with asyncio.timeout(CHECK_S):
                info = await client.models.retrieve(model.value)
        except (TimeoutError, anthropic.APITimeoutError):
            log.warning("KI-Vorschläge (Prüfung): Anthropic antwortet nicht rechtzeitig.")
            return _checked(CookFailure.TIMEOUT, model)
        except anthropic.APIConnectionError as exc:
            log.warning("KI-Vorschläge (Prüfung): Anthropic ist nicht erreichbar (%s).", _cause(exc))
            return _checked(CookFailure.UNREACHABLE, model)
        except anthropic.APIStatusError as exc:
            _log_status("Prüfung", exc, key)
            return _checked(_status_reason(exc), model)
        except ValueError as exc:  # 200, aber kein lesbares JSON; die Meldung zitierte die Antwort
            log.warning("KI-Vorschläge (Prüfung): Die Antwort ist unlesbar (%s).", type(exc).__name__)
            return {"state": AiCheckState.ERROR, "message": UNREADABLE, "model": model}
        if not _is_model(info, model):
            log.warning(
                "KI-Vorschläge (Prüfung): Die Antwort ist nicht das Modell %s (%s).",
                model.value,
                type(info).__name__,
            )
            return {"state": AiCheckState.ERROR, "message": UNREADABLE, "model": model}
        log.info("KI-Vorschläge: Schlüssel und %s geprüft, request-id %s.", model.value, _request_id(info))
        return {
            "state": AiCheckState.OK,
            "message": f"Der API-Schlüssel gilt, und {MODEL_NAMES[model]} steht bereit.",
            "model": model,
        }

    async def ideas(
        self, key: str, model: AiModel, *, system: str, prompt: str, output: type[BaseModel]
    ) -> Answer | Failure:
        """Fragt nach Vorschlägen in der Form ``output`` (ein Pydantic-Modell ohne Grenzen; gekürzt wird
        danach). Je Versuch die Fristen ``IDEAS_S`` (Verbindung ``IDEAS_CONNECT_S``), höchstens ``ATTEMPTS``
        Versuche (siehe oben); die Frist des ganzen Auftrags setzt der Aufrufer."""
        anthropic = await self._prepare()
        client = self._client(anthropic, key, timeout=anthropic.Timeout(IDEAS_S, connect=IDEAS_CONNECT_S))
        request: dict[str, Any] = {
            "model": model.value,
            "max_tokens": COOK_MAX_TOKENS,
            "system": system,
            "messages": [{"role": "user", "content": prompt}],
            "output_config": {
                "effort": COOK_EFFORT,
                # Wie messages.parse(output_format=output): das Schema in der Form, die die API annimmt.
                "format": {"type": "json_schema", "schema": anthropic.transform_schema(output)},
            },
        }
        attempt = 1
        while True:
            try:
                if model in FALLBACK_MODELS:
                    message = await client.beta.messages.create(
                        **request, betas=[FALLBACK_BETA], fallbacks="default"
                    )
                else:
                    message = await client.messages.create(**request)
            except anthropic.APIConnectionError as exc:  # auch APITimeoutError
                if attempt < ATTEMPTS and _unsent(exc):
                    log.warning(
                        "KI-Vorschläge: keine Verbindung zu Anthropic (%s); noch ein Versuch in %.0f s.",
                        _cause(exc),
                        RETRY_PAUSE_S,
                    )
                    await asyncio.sleep(RETRY_PAUSE_S)
                    attempt += 1
                    continue
                return _broken_off(exc, isinstance(exc, anthropic.APITimeoutError))
            except anthropic.APIStatusError as exc:
                _log_status("Vorschläge", exc, key)
                wait = _retry_wait(exc)
                pause = RETRY_DEFAULT_S if wait is None else wait
                if attempt < ATTEMPTS and _retryable(exc) and pause <= RETRY_WAIT_MAX_S:
                    log.info("KI-Vorschläge: noch ein Versuch in %.1f s.", pause)
                    await asyncio.sleep(pause)
                    attempt += 1
                    continue
                reason = _status_reason(exc)
                retry = _seconds(wait) if reason in (CookFailure.BUSY, CookFailure.UNAVAILABLE) else None
                return failure(reason, charged=False, retry_after_s=retry)
            except ValueError as exc:  # 200, aber kein lesbares JSON; die Meldung zitierte die Antwort
                log.warning("KI-Vorschläge: Die Antwort ist unlesbar (%s).", type(exc).__name__)
                return Failure(CookFailure.ERROR, UNREADABLE, charged=True)
            return _read(message, output)


def _checked(reason: CookFailure, model: AiModel) -> dict[str, Any]:
    return {"state": CHECK_STATES[reason], "message": CHECK_MESSAGES[reason], "model": model}
