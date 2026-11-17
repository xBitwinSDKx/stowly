"""Prüfung der Verbindung zu Home Assistant (``POST /api/server-config/ha/check``; docs/plan-einrichtung-b.md,
Abschnitt 3).

Assistent und Einstellungen prüfen damit Adresse und Token, bevor sie gespeichert werden, und holen die
To-do-Listen zur Auswahl. Ein Ablauf:

1. ``GET /api/`` (mit dem Token, wenn es einen gibt): ``{"message": "API running."}`` heißt Home Assistant.
   Ohne Token heißt 401 „Token nötig" (``token_needed``), mit Token „abgelehnt" (``unauthorized``).
2. ``GET /api/config`` (freiwillig): Version und Name des Zuhauses. Ein Fehler hier zählt nicht.
3. ``GET /api/states``, gestreamt mit höchstens 8 MiB: die Entitäten ``todo.*`` mit bereinigtem Namen und der
   Zahl offener Einträge, höchstens 100.

* **Grenzen:** 8 Sekunden je Abfrage, 12 insgesamt; eine Prüfung zugleich, und zwischen dem Beginn zweier
  Prüfungen liegen mindestens 3 Sekunden (``CheckGuard``, sonst 429).
* **Ziele:** nur Adressen, die ``haconfig.check_url`` erlaubt: http oder https, ohne Benutzerangabe, keine
  wörtliche Link-local-, Multicast- oder unbestimmte Adresse; das Heimnetz ist erlaubt. Einer Weiterleitung
  folgt die Prüfung nie; sie meldet sie mit eigener Meldung. Der gespeicherte Token geht nur an die Adresse,
  für die er eingetragen wurde (``target``). So erreicht kein Token einen zweiten Rechner.
* **Nie zurück:** ein Rumpf von HA oder ein Token. Namen aus HA kommen bereinigt und gekürzt. Fehler bildet
  die Prüfung ab wie der Abgleich (``bring.request``, ``bring.Problem``, ``bring.untrusted``).
"""

import asyncio
import math
import re
import ssl
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx2

from stowly import bring, haconfig, texts
from stowly.config import HA_TODO_ENTITY
from stowly.contract.api import ConfigSource, ErrorCode, HaCheckInput, HaCheckState
from stowly.errors import ApiError
from stowly.off import Clock

# Je Abfrage, für die ganze Prüfung, Abstand zwischen zwei Prüfungen (Sekunden).
REQUEST_S = 8.0
TOTAL_S = 12.0
GAP_S = 3.0
# Größe der Antworten: /api/states darf groß werden, die übrigen sind ein paar hundert Byte.
STATES_MAX = 8 * 1024 * 1024
SMALL_MAX = 64 * 1024
LISTS_MAX = 100
NAME_MAX = 100
VERSION_MAX = 40
_COUNT = re.compile(r"[0-9]{1,9}")

TOKEN_NEEDED = (
    "Home Assistant antwortet. Bitte einen langlebigen Zugangs-Token eintragen (in Home Assistant: Profil, "
    "Sicherheit)."
)
NOT_HA = "Unter dieser Adresse antwortet kein Home Assistant."
REDIRECT = (
    "Die Adresse leitet weiter ({status}); Stowly folgt dem nicht. Bitte die Adresse eintragen, unter der "
    "Home Assistant selbst antwortet (etwa https:// statt http:// oder mit dem richtigen Port)."
)
TOO_SLOW = "Home Assistant antwortet zu langsam (die Prüfung dauert höchstens 12 Sekunden)."
UNEXPECTED_STATES = "Home Assistant antwortet unerwartet (ohne Liste der Entitäten)."
NO_URL = "Keine Adresse angegeben, und in der App ist keine eingetragen."
ENV_FIELDS = (
    "Die Verbindung zu Home Assistant steht in der Umgebung; geprüft wird nur die dort eingetragene (ohne "
    "Felder)."
)


class TooSoon(Exception):
    """Eine Prüfung läuft schon, oder die letzte begann vor weniger als ``GAP_S`` Sekunden."""

    def __init__(self, retry_after_s: int) -> None:
        super().__init__(retry_after_s)
        self.retry_after_s = retry_after_s


class CheckGuard:
    """Eine Prüfung zugleich, und zwischen dem Beginn zweier mindestens ``GAP_S`` Sekunden, für den ganzen
    Server. Liegt in ``app.state.ha_check``; ``clock`` ist der Ersatz für Tests."""

    def __init__(self, clock: Clock | None = None) -> None:
        self._clock = clock or Clock()
        self._lock = threading.Lock()
        self._running = False
        self._started: float | None = None  # monoton: Beginn der letzten Prüfung

    def admit(self) -> None:
        """Lässt eine Prüfung beginnen; ``TooSoon`` mit der Wartezeit in Sekunden, wenn nicht."""
        with self._lock:
            now = self._clock.monotonic()
            if self._running:
                raise TooSoon(math.ceil(GAP_S))
            if self._started is not None and now - self._started < GAP_S:
                raise TooSoon(max(1, math.ceil(self._started + GAP_S - now)))
            self._running = True
            self._started = now

    def release(self) -> None:
        with self._lock:
            self._running = False


# --- Was geprüft wird --------------------------------------------------------------------------


@dataclass(frozen=True)
class Target:
    """Adresse und Token der Prüfung; ``entity`` ist die wirksame Liste (für ``entity_found``)."""

    url: str
    token: str | None = field(repr=False)
    ca: Path | None
    entity: str | None


def _error(name: str, message: str) -> dict[str, Any]:
    return {"loc": ["body", name], "msg": message, "type": f"ha_{name}"}


def target(current: haconfig.Effective, body: HaCheckInput) -> Target:
    """Was die Prüfung anfragt. Ohne Felder die wirksame Einrichtung, sonst die angegebenen Werte.

    ``ApiError`` 409, wenn die Verbindung aus der Umgebung kommt und trotzdem Felder angegeben sind (oder
    dort die Adresse fehlt); 422 mit ``details.errors[].loc`` bei einer ungültigen Adresse oder einem
    ungültigen Token, oder wenn es gar keine Adresse gibt. Der gespeicherte Token geht nur an seine Adresse.
    """
    fields = body.model_fields_set & {"url", "token"}
    if current.source == ConfigSource.ENV:
        if fields:
            raise ApiError(409, ErrorCode.CONFLICT, ENV_FIELDS)
        if current.url is None:
            raise ApiError(409, ErrorCode.CONFLICT, current.problem or haconfig.FROM_ENVIRONMENT)
        return Target(current.url, current.token, current.ca, current.entity)
    problems: list[dict[str, Any]] = []
    url = current.url
    if "url" in fields:
        url, message = haconfig.check_url(body.url)
        if message is not None:
            problems.append(_error("url", message))
    elif url is None:
        problems.append(_error("url", NO_URL))
    token: str | None = None
    if "token" in fields:
        token = body.token.strip()
        if not haconfig.header_safe(token):
            problems.append(_error("token", haconfig.INVALID_TOKEN))
    elif url is not None and url == current.url:
        token = current.token  # nur an die Adresse, für die er eingetragen wurde
    if problems or url is None:
        raise ApiError(422, ErrorCode.INVALID_REQUEST, haconfig.INVALID, {"errors": problems})
    return Target(url, token, current.ca, current.entity)


# --- Die Prüfung -------------------------------------------------------------------------------


def _result(
    state: HaCheckState,
    message: str,
    *,
    version: str | None = None,
    location: str | None = None,
    lists: list[dict[str, Any]] | None = None,
    found: bool | None = None,
) -> dict[str, Any]:
    return {
        "state": state,
        "message": message,
        "ha_version": version,
        "location_name": location,
        "lists": lists or [],
        "entity_found": found,
    }


def _failure(failed: bring.Failed, *, token: bool, first: bool) -> dict[str, Any]:
    """Eine gescheiterte Abfrage als Ergebnis; ``first``: die erste (``/api/``), die HA erkennt."""
    status = failed.status
    if status is None:
        state = HaCheckState.UNREACHABLE if failed.problem.state == "unreachable" else HaCheckState.ERROR
        return _result(state, failed.problem.message)
    if status == 401:
        if token:
            return _result(HaCheckState.UNAUTHORIZED, bring.UNAUTHORIZED)
        return _result(HaCheckState.TOKEN_NEEDED, TOKEN_NEEDED)
    if 300 <= status < 400:
        return _result(HaCheckState.ERROR, REDIRECT.format(status=status))
    if first and status in (404, 405):
        return _result(HaCheckState.NOT_HA, NOT_HA)
    return _result(HaCheckState.ERROR, failed.problem.message)


def _is_ha(payload: Any) -> bool:
    message = payload.get("message") if isinstance(payload, dict) else None
    return isinstance(message, str) and message.startswith("API running")


def _config(payload: Any) -> tuple[str | None, str | None]:
    """Version und Name des Zuhauses aus ``/api/config``; was fehlt oder nicht passt, ist ``None``."""
    if not isinstance(payload, dict):
        return None, None
    version, location = payload.get("version"), payload.get("location_name")
    return (
        (texts.clean(version, VERSION_MAX) or None) if isinstance(version, str) else None,
        (texts.clean(location, NAME_MAX) or None) if isinstance(location, str) else None,
    )


def _lists(entities: list[Any]) -> list[dict[str, Any]]:
    """Die To-do-Listen aus ``/api/states``, nach Namen sortiert, jede Entität einmal."""
    found: dict[str, dict[str, Any]] = {}
    for entry in entities:
        if not isinstance(entry, dict):
            continue
        entity_id = entry.get("entity_id")
        if not isinstance(entity_id, str) or len(entity_id) > 255 or not HA_TODO_ENTITY.fullmatch(entity_id):
            continue
        attributes = entry.get("attributes")
        raw_name = attributes.get("friendly_name") if isinstance(attributes, dict) else None
        name = texts.clean(raw_name, NAME_MAX) if isinstance(raw_name, str) else ""
        state = entry.get("state")
        found.setdefault(
            entity_id,
            {
                "entity_id": entity_id,
                "name": name or entity_id,
                "open": int(state) if isinstance(state, str) and _COUNT.fullmatch(state) else None,
            },
        )
    return sorted(found.values(), key=lambda item: (item["name"].casefold(), item["entity_id"]))


def _ok(
    lists: list[dict[str, Any]], entity: str | None, version: str | None, location: str | None
) -> dict[str, Any]:
    count = len(lists)
    if count == 0:
        text = "keine To-do-Liste"
    elif count == 1:
        text = "eine To-do-Liste"
    elif count > LISTS_MAX:
        text = f"{count} To-do-Listen (zur Auswahl die ersten {LISTS_MAX})"
    else:
        text = f"{count} To-do-Listen"
    message = f"Verbindung zu Home Assistant steht; {text} gefunden."
    found = None if entity is None else any(item["entity_id"] == entity for item in lists)
    if found is False:
        message += f" Die Liste {entity} gibt es dort nicht."
    return _result(
        HaCheckState.OK,
        message,
        version=version,
        location=location,
        lists=lists[:LISTS_MAX],
        found=found,
    )


async def check(goal: Target, *, transport: httpx2.AsyncBaseTransport | None = None) -> dict[str, Any]:
    """Prüft Adresse und Token und liefert ``HaCheck``. Wirft nur bei einem Fehler im Code."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + TOTAL_S
    try:
        verify = bring.trust(goal.ca)
    except (OSError, ssl.SSLError):
        return _result(HaCheckState.ERROR, bring.CA_UNUSABLE)
    headers = dict(bring.HEADERS)
    if goal.token is not None:
        headers["Authorization"] = f"Bearer {goal.token}"
    token = goal.token is not None

    async with httpx2.AsyncClient(
        transport=transport,
        headers=headers,
        timeout=httpx2.Timeout(REQUEST_S),
        follow_redirects=False,  # nie an einen anderen Rechner, auch nicht mit dem Token
        verify=verify,
    ) as client:

        async def get(path: str, limit: int) -> bring.Reply:
            left = deadline - loop.time()
            if left <= 0:
                problem = bring.Problem("unreachable", TOO_SLOW, f"GET {path}: Frist der Prüfung")
                raise bring.Failed(problem, sent=False)
            return await bring.request(
                client, "GET", goal.url + path, shown=f"GET {path}", timeout=min(REQUEST_S, left), limit=limit
            )

        try:
            if not _is_ha((await get("/api/", SMALL_MAX)).data()):
                return _result(HaCheckState.NOT_HA, NOT_HA)
        except bring.Failed as failed:
            return _failure(failed, token=token, first=True)

        version = location = None
        try:
            version, location = _config((await get("/api/config", SMALL_MAX)).data())
        except bring.Failed:
            pass  # freiwillig: Version und Name fehlen dann

        try:
            entities = (await get("/api/states", STATES_MAX)).data()
        except bring.Failed as failed:
            return _failure(failed, token=token, first=False)
    if not isinstance(entities, list):
        return _result(HaCheckState.ERROR, UNEXPECTED_STATES)
    return _ok(_lists(entities), goal.entity, version, location)
