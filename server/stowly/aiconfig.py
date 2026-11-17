"""KI-Vorschläge: die wirksame Einrichtung aus Umgebung und App, dazu der Tageszähler (docs/plan-0.6.md, 2.2;
docs/integrationen.md, 13).

* **Schlüssel:** ``STOWLY_ANTHROPIC_API_KEY`` geht vor und sperrt den Schlüssel in der App (409). Sonst gilt
  der aus der App. Er liegt im ``SecretStore`` (``anthropic_key.json``), nie in der Datenbank, einer
  Sicherung, dem Log oder einer Antwort. Geprüft wird er in beiden Fällen gleich
  (``config.anthropic_key_problem``); was die Prüfung nicht besteht, zählt nicht.
* **In ``server_config``** stehen nur ``ai_model`` (das gewählte Modell), ``ai_key_set_at`` (ein Merker ohne
  Geheimnis) und ``ai_usage`` (``{"day": "YYYY-MM-DD", "count": n}``, der Tageszähler). Ein Merker ohne Datei
  heißt: Der Schlüssel fehlt nach einem Zurückspielen oder Umzug (``problem``, ``details.reason: lost``).
* **Ereignis** ``server.config_changed`` nur mit Schlüsselnamen und nur bei ``ai_model`` und
  ``ai_key_set_at``; der Zähler erzeugt nie eins.
* **Zähler:** Tag in ``STOWLY_TIMEZONE``. Gezählt wird in der Transaktion, die eine Anfrage zulässt
  (``cook.CookGuard`` mit ``take``); was Anthropic nicht berechnet hat, nimmt ``give_back`` zurück. Springt die
  Uhr zurück, gilt der gespeicherte Tag mit seiner Zahl weiter (``counted``): Ein Rücksprung schenkt keine
  Anfragen.
* **Gelesen** wird bei Gebrauch: Eine Änderung wirkt ohne Neustart.
"""

import logging
import sqlite3
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from stowly import db, serverconfig
from stowly.config import Settings, anthropic_key_problem
from stowly.contract import timeutil
from stowly.contract.api import (
    AI_DAILY_MAX,
    AI_MODEL_DEFAULT,
    AiCheckInput,
    AiConfigChanges,
    AiModel,
    ConfigSource,
    ErrorCode,
)
from stowly.errors import ApiError
from stowly.secretstore import ANTHROPIC_KEY, SecretStore, SecretStoreError

log = logging.getLogger("stowly.ai")

# Schlüssel in server_config (nie ein Geheimnis).
MODEL = "ai_model"
KEY_SET_AT = "ai_key_set_at"
USAGE = "ai_usage"
KEYS = (MODEL, KEY_SET_AT, USAGE)
# So viele Tage darf der gespeicherte Tag des Zählers nach „heute“ liegen und gilt doch weiter: Die Uhr sprang
# zurück. Liegt er weiter vorn, stammt er von einer Uhr, die falsch vorging, und sperrte sonst für lange Zeit.
CLOCK_BACK_DAYS = 2

KEY_FROM_ENVIRONMENT = (
    "Der API-Schlüssel steht in der Umgebung (STOWLY_ANTHROPIC_API_KEY) und lässt sich nur dort ändern."
)
CHECK_ENVIRONMENT = (
    "Der API-Schlüssel steht in der Umgebung (STOWLY_ANTHROPIC_API_KEY); geprüft wird nur der dort "
    "eingetragene (ohne das Feld key)."
)
KEY_LOST = "Der API-Schlüssel für die KI-Vorschläge fehlt (steht in keiner Sicherung); bitte neu eintragen."
KEY_MISSING = (
    "Für die KI-Vorschläge fehlt noch ein API-Schlüssel von Anthropic (Einstellungen, KI-Vorschläge)."
)
KEY_NOT_WRITTEN = "Der API-Schlüssel ließ sich nicht speichern (Einzelheiten im Log des Servers)."
INVALID = "Die Anfrage entspricht nicht dem Vertrag."


def _timestamp(value: Any) -> str | None:
    return value if isinstance(value, str) and timeutil.is_timestamp(value) else None


# --- Wirksame Werte ----------------------------------------------------------------------------


@dataclass(frozen=True)
class Effective:
    """Die wirksame Einrichtung der KI-Vorschläge. Der Schlüssel steht in keiner Ausgabe (``repr``)."""

    source: ConfigSource  # des Schlüssels
    key: str | None = field(repr=False)
    key_set_at: str | None
    model: AiModel
    model_source: ConfigSource
    problem: str | None  # warum es keinen Schlüssel gibt, obwohl einer eingetragen war
    lost: bool  # eingetragen (Merker), aber die Datei fehlt

    @property
    def configured(self) -> bool:
        """Es gibt einen wirksamen Schlüssel: KI-Vorschläge sind möglich."""
        return self.key is not None


def from_environment(settings: Settings) -> bool:
    """Kommt der Schlüssel aus der Umgebung? Dann ist er in der App gesperrt."""
    return settings.anthropic_api_key is not None


def _store(settings: Settings, store: SecretStore | None) -> SecretStore:
    """Der Speicher aus ``app.state``; ohne ihn einer zum Lesen im selben Ordner."""
    return store if store is not None else SecretStore(settings.secrets_dir)


def _record(record: dict[str, Any] | None) -> tuple[str | None, str | None]:
    """Schlüssel und Zeitpunkt aus ``anthropic_key.json``; nach denselben Regeln wie die Umgebung."""
    key = record.get("key") if record is not None else None
    if not isinstance(key, str) or anthropic_key_problem(key) is not None:
        return None, None
    assert record is not None
    return key, _timestamp(record.get("set_at"))


def app_model(con: sqlite3.Connection) -> AiModel | None:
    """Das Modell aus der App; was keines der wählbaren ist (mehr), zählt nicht."""
    value = serverconfig.get(con, MODEL)
    if isinstance(value, str):
        try:
            return AiModel(value)
        except ValueError:
            pass
    return None


def effective(settings: Settings, con: sqlite3.Connection, store: SecretStore | None = None) -> Effective:
    """Die wirksame Einrichtung: Schlüssel aus Umgebung oder App, Modell aus der App oder die Vorgabe. Liest
    Datenbank und Speicher, also in einem Thread aufrufen."""
    store = _store(settings, store)
    model = app_model(con)
    chosen = {
        "model": model or AI_MODEL_DEFAULT,
        "model_source": ConfigSource.APP if model is not None else ConfigSource.DEFAULT,
    }
    if from_environment(settings):
        return Effective(
            source=ConfigSource.ENV,
            key=settings.anthropic_api_key,
            key_set_at=None,
            problem=None,
            lost=False,
            **chosen,
        )
    key, set_at = _record(store.get(ANTHROPIC_KEY))
    marker = _timestamp(serverconfig.get(con, KEY_SET_AT))
    if key is not None:
        return Effective(
            source=ConfigSource.APP, key=key, key_set_at=set_at or marker, problem=None, lost=False, **chosen
        )
    if marker is not None:
        # In der App eingetragen, die Datei fehlt aber: Zurückspielen oder Umzug.
        return Effective(
            source=ConfigSource.APP, key=None, key_set_at=None, problem=KEY_LOST, lost=True, **chosen
        )
    # Nichts eingetragen; lässt sich der Ordner nicht anlegen, sagt es problem schon jetzt.
    return Effective(
        source=ConfigSource.DEFAULT, key=None, key_set_at=None, problem=store.problem, lost=False, **chosen
    )


def not_configured(current: Effective) -> ApiError:
    """503 ``not_configured`` ohne wirksamen Schlüssel; ``details.reason``: ``missing`` oder ``lost``."""
    return ApiError(
        503,
        ErrorCode.NOT_CONFIGURED,
        KEY_LOST if current.lost else KEY_MISSING,
        {"reason": "lost" if current.lost else "missing"},
    )


def view(current: Effective, used_today: int) -> dict[str, Any]:
    """``AiConfig``: die wirksame Einrichtung mit Quelle und Tageszähler. Nie der Schlüssel."""
    return {
        "source": current.source,
        "key_set": current.key is not None,
        "key_set_at": current.key_set_at,
        "model": current.model,
        "model_source": current.model_source,
        "configured": current.configured,
        "problem": current.problem,
        "used_today": used_today,
        "daily_limit": AI_DAILY_MAX,
    }


# --- Tageszähler -------------------------------------------------------------------------------


def _stored(con: sqlite3.Connection) -> tuple[str, int] | None:
    """Der gespeicherte Stand ``(Tag, Zahl)``; ``None``, wenn es keinen gibt oder er nicht lesbar ist."""
    value = serverconfig.get(con, USAGE)
    if not isinstance(value, dict):
        return None
    day, count = value.get("day"), value.get("count")
    if not isinstance(day, str) or not timeutil.is_date(day):
        return None
    if isinstance(count, bool) or not isinstance(count, int) or count < 0:
        return None
    return day, count


def counted(con: sqlite3.Connection, today: str) -> tuple[str, int]:
    """Der Tag, für den gezählt wird, und sein Stand. Das ist ``today`` (``YYYY-MM-DD`` in ``STOWLY_TIMEZONE``);
    liegt der gespeicherte Tag danach, weil die Uhr zurücksprang, gilt er mit seiner Zahl weiter, höchstens
    ``CLOCK_BACK_DAYS`` Tage. Ein früherer, fernerer oder unlesbarer Stand zählt als 0 für ``today``."""
    stored = _stored(con)
    if stored is not None:
        day, count = stored
        latest = (date.fromisoformat(today) + timedelta(days=CLOCK_BACK_DAYS)).isoformat()
        if today <= day <= latest:
            return day, count
    return today, 0


def used(con: sqlite3.Connection, today: str) -> int:
    """Wie viele Anfragen für ``today`` gezählt sind (``counted``)."""
    return counted(con, today)[1]


def take(con: sqlite3.Connection, today: str, *, now: str) -> tuple[str, int | None]:
    """In der Transaktion des Aufrufers: zählt eine Anfrage und liefert den Tag, für den gezählt wird
    (``counted``), mit dem neuen Stand; der Stand ist ``None``, wenn ``AI_DAILY_MAX`` schon erreicht ist (dann
    ändert sich nichts). Kein Ereignis."""
    day, count = counted(con, today)
    if count >= AI_DAILY_MAX:
        return day, None
    serverconfig.put(con, USAGE, {"day": day, "count": count + 1}, now=now, by=None)
    return day, count + 1


def give_back(con: sqlite3.Connection, day: str, *, now: str) -> int:
    """Gutschrift für eine Anfrage, die Anthropic nicht berechnet hat: eine weniger am Tag ``day`` (für den sie
    gezählt wurde), nie unter 0. Gilt inzwischen ein anderer Tag, bleibt alles, wie es ist. Liefert den Stand
    für ``day``."""
    with db.transaction(con):
        stored = _stored(con)
        if stored is None or stored[0] != day:
            return 0
        count = stored[1]
        if count > 0:
            serverconfig.put(con, USAGE, {"day": day, "count": count - 1}, now=now, by=None)
            return count - 1
    return 0


# --- Ändern (PATCH /api/server-config/ai) ------------------------------------------------------


def _error(name: str, message: str) -> dict[str, Any]:
    return {"loc": ["body", name], "msg": message, "type": f"ai_{name}"}


def _invalid(problems: list[dict[str, Any]]) -> ApiError:
    return ApiError(422, ErrorCode.INVALID_REQUEST, INVALID, {"errors": problems})


def checked_key(raw: str) -> str:
    """Ein Schlüssel aus einer Anfrage, am Rand gekürzt; 422 an ``["body","key"]``, wenn die Form nicht
    stimmt. Die Meldung nennt ihn nie."""
    key = raw.strip()
    problem = anthropic_key_problem(key)
    if problem is not None:
        raise _invalid([_error("key", problem)])
    return key


def change(
    settings: Settings,
    con: sqlite3.Connection,
    store: SecretStore,
    changes: AiConfigChanges,
    *,
    device_id: str,
    now: str,
) -> list[str]:
    """Übernimmt die vorhandenen Felder und liefert die Schlüssel in ``server_config``, die sich geändert haben.

    Reihenfolge: erst der Speicher, dann eine Transaktion mit dem Ereignis ``server.config_changed`` (nur
    Schlüsselnamen). Scheitert der Speicher, ändert sich nichts. ``ApiError`` 409, wenn ``key`` geändert
    werden soll, der Schlüssel aber aus der Umgebung kommt; 422 an ``["body","key"]`` bei einem Schlüssel in
    falscher Form (ohne seinen Wert); 500, wenn der Speicher nicht schreibt.
    """
    fields = changes.model_fields_set & {"key", "model"}
    if not fields:
        return []
    if "key" in fields and from_environment(settings):
        raise ApiError(409, ErrorCode.CONFLICT, KEY_FROM_ENVIRONMENT)
    key = checked_key(changes.key) if "key" in fields and changes.key is not None else None
    # Ein ausdrückliches null für model lehnt schon der Vertrag ab (422).
    model = changes.model if "model" in fields else None

    file_removed = False
    try:
        if key is not None:
            store.put(ANTHROPIC_KEY, {"key": key, "set_at": now})
        elif "key" in fields:
            file_removed = store.delete(ANTHROPIC_KEY)
    except SecretStoreError:
        raise ApiError(500, ErrorCode.INTERNAL, KEY_NOT_WRITTEN) from None

    changed: list[str] = []
    with db.transaction(con):
        if model is not None and serverconfig.get(con, MODEL) != model.value:
            serverconfig.put(con, MODEL, model.value, now=now, by=device_id)
            changed.append(MODEL)
        if key is not None:
            serverconfig.put(con, KEY_SET_AT, now, now=now, by=device_id)
            changed.append(KEY_SET_AT)
        elif "key" in fields and (serverconfig.delete(con, KEY_SET_AT) or file_removed):
            changed.append(KEY_SET_AT)
        if changed:
            serverconfig.changed_event(con, changed, device_id=device_id, now=now)
    if changed:
        log.info("KI-Vorschläge: Einrichtung in der App geändert: %s", ", ".join(changed))
    return changed


# --- Prüfen (POST /api/server-config/ai/check) -------------------------------------------------


def check_target(current: Effective, body: AiCheckInput) -> tuple[str, AiModel]:
    """Schlüssel und Modell der Prüfung: ohne Felder die wirksamen, sonst die angegebenen.

    ``ApiError`` 409, wenn ``key`` angegeben ist, der Schlüssel aber aus der Umgebung kommt; 422 bei einem
    Schlüssel in falscher Form; 503 ``not_configured``, wenn es keinen gibt.
    """
    fields = body.model_fields_set
    # Ein ausdrückliches null für key oder model lehnt schon der Vertrag ab (422).
    model = body.model if "model" in fields and body.model is not None else current.model
    if "key" in fields and body.key is not None:
        if current.source == ConfigSource.ENV:
            raise ApiError(409, ErrorCode.CONFLICT, CHECK_ENVIRONMENT)
        return checked_key(body.key), model
    if current.key is None:
        raise not_configured(current)
    return current.key, model
