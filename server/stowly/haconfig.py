"""Home Assistant: die wirksame Einrichtung aus Umgebung und App (docs/plan-einrichtung-b.md, Abschnitt 3;
docs/integrationen.md, Abschnitte 5 und 12).

* **Gruppe:** Adresse, Token und To-do-Liste gehören zusammen. Ist eine von ``STOWLY_HA_URL``,
  ``STOWLY_HA_TOKEN`` oder ``STOWLY_HA_TODO_ENTITY`` gesetzt, kommen alle drei aus der Umgebung und sind in
  der App gesperrt (409); fehlt dort etwas, nennt ``problem`` die Variable (``Settings.ha_problem``). Sonst
  kommen alle drei aus der App.
* **Sensor-Token:** ``STOWLY_HA_SUMMARY_TOKEN`` vor dem aus der App. ``STOWLY_HA_CA`` gibt es nur in der
  Umgebung; sie gilt für beide Wege.
* **Ablage:** Adresse und Liste stehen in ``server_config`` (``ha_url``, ``ha_todo_entity``), die Tokens im
  ``SecretStore`` (``/data/secrets``). In ``server_config`` stehen dazu nur Merker ohne Geheimnis:
  ``ha_token_set_at``, ``ha_sensor_set_at`` und ``ha_links_entity`` (zu welcher Liste ``ha_links`` gehört,
  ``bring.py``). Ein Merker ohne Datei heißt: Der Token fehlt nach einem Zurückspielen oder Umzug.
* **Bindung:** Der Token von HA gilt nur für die Adresse, für die er eingetragen wurde; ein anders gebundener
  zählt als fehlend. Eine neue Adresse ohne Token im selben Aufruf löscht ihn, so lässt er sich nicht an
  einen anderen Rechner umleiten.
* **Prüfung** wie in der Umgebung (``config.normalize_ha_url``, Muster der Liste), dazu für Adressen aus der
  App die Regeln gegen fremde Ziele (``target_problem``).
* **Gelesen** wird bei Gebrauch: ``integrations.ha_status``, die Sensor-Endpunkte (bei jeder Anfrage), der
  Abgleich (vor jedem Lauf), der Assistent und der Bericht beim Start. So wirkt eine Änderung ohne Neustart.
"""

import hashlib
import ipaddress
import logging
import re
import secrets
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from stowly import db, serverconfig
from stowly.config import HA_SUMMARY_TOKEN_MIN, HA_TODO_ENTITY, Settings, normalize_ha_url
from stowly.contract import timeutil
from stowly.contract.api import ConfigSource, ErrorCode, HaConfigChanges
from stowly.contract.limits import LIMITS
from stowly.errors import ApiError
from stowly.secretstore import HA_SENSOR_TOKEN, HA_TOKEN, SecretStore, SecretStoreError

log = logging.getLogger("stowly.ha")

# Schlüssel in server_config (nie ein Geheimnis).
URL = "ha_url"
ENTITY = "ha_todo_entity"
TOKEN_SET_AT = "ha_token_set_at"
SENSOR_SET_AT = "ha_sensor_set_at"
LINKS_ENTITY = "ha_links_entity"

# Der erzeugte Sensor-Token: so viele Byte, als Hex 64 Zeichen.
SENSOR_TOKEN_BYTES = 32
# So lang darf ein Sensor-Token aus dem Speicher höchstens sein (erzeugt sind es 64 Zeichen).
SENSOR_TOKEN_MAX = 200

FROM_ENVIRONMENT = (
    "Die Verbindung zu Home Assistant steht in der Umgebung (STOWLY_HA_URL, STOWLY_HA_TOKEN, "
    "STOWLY_HA_TODO_ENTITY) und lässt sich nur dort ändern."
)
SENSOR_FROM_ENVIRONMENT = (
    "Der Sensor-Token steht in der Umgebung (STOWLY_HA_SUMMARY_TOKEN) und lässt sich nur dort ändern."
)
TOKEN_LOST = "Der Token für Home Assistant fehlt (steht in keiner Sicherung); bitte neu eintragen."
SENSOR_LOST = "Der Sensor-Token fehlt (steht in keiner Sicherung); bitte neu erzeugen."
NO_SENSOR_TOKEN = "Es gibt noch keinen Sensor-Token aus der App; bitte einen erzeugen."
INVALID_URL = (
    "Erwartet ist eine Adresse wie http://192.168.1.20:8123 (http oder https, ohne Pfad, Abfrage und "
    "Benutzerangabe)."
)
NUMERIC_HOST = "Eine IP-Adresse bitte in der üblichen Schreibweise, etwa 192.168.1.20."
FORBIDDEN_TARGET = "Diese Adresse ist nicht erlaubt (Link-local, Multicast oder unbestimmt)."
INVALID_TOKEN = (
    "Der Token besteht nur aus druckbaren ASCII-Zeichen ohne Leerraum (so, wie Home Assistant ihn anzeigt)."
)
TOKEN_WITHOUT_URL = "Erst die Adresse von Home Assistant eintragen: Der Token gilt nur für sie."
INVALID = "Die Anfrage entspricht nicht dem Vertrag."

_PARTS = {"url": "die Adresse", "token": "der Token", "entity": "die To-do-Liste"}
# Der letzte Teil eines Rechnernamens, der nach einer Zahl aussieht: Dann muss es eine IPv4-Adresse in der
# üblichen Schreibweise sein. Sonst läse der Resolver ``2852039166`` oder ``0xa9.0xfe.0xa9.0xfe`` als
# 169.254.169.254.
_NUMERIC = re.compile(r"(?:0x[0-9a-f]*|[0-9]+)", re.IGNORECASE)
# Ein Teil eines Rechnernamens (klein geschrieben).
_LABEL = re.compile(r"[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?")
_NAT64 = ipaddress.IPv6Network("64:ff9b::/96")
_COMPATIBLE = ipaddress.IPv6Network("::/96")

Fingerprint = tuple[str, str, str, str | None]


# --- Prüfen ------------------------------------------------------------------------------------


def header_safe(text: str) -> bool:
    """Druckbares ASCII ohne Leerraum: So kommt ein Token unversehrt in die Kopfzeile ``Authorization``."""
    return bool(text) and text.isascii() and all(" " < char <= "~" for char in text)


def _embedded_v4(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> ipaddress.IPv4Address | None:
    """Eine IPv4-Adresse, die in einer IPv6-Adresse steckt (::ffff:…, 6to4, NAT64, ::a.b.c.d)."""
    if not isinstance(ip, ipaddress.IPv6Address):
        return None
    if ip.ipv4_mapped is not None:
        return ip.ipv4_mapped
    if ip.sixtofour is not None:
        return ip.sixtofour
    plain = ipaddress.IPv6Address(int(ip))  # ohne Zonen-Angabe
    if plain in _NAT64 or (plain in _COMPATIBLE and int(plain) > 1):
        return ipaddress.IPv4Address(int(plain) & 0xFFFFFFFF)
    return None


def target_problem(host: str) -> str | None:
    """Regeln gegen fremde Ziele für Adressen aus der App; ``None`` = erlaubt.

    Abgelehnt werden IP-Adressen in ungewohnter Schreibweise (``2852039166``, ``0xa9.0xfe.0xa9.0xfe``,
    führende Nullen), wörtliche Link-local-, Multicast- und unbestimmte Adressen, auch in IPv6 verpackt, und
    Namen mit leeren oder ungültigen Teilen. Namen, das Heimnetz und Loopback sind erlaubt. Namen werden nicht
    aufgelöst.
    """
    host = host.lower()
    if not host:
        return INVALID_URL
    if ":" not in host and _NUMERIC.fullmatch(host.rstrip(".").rsplit(".", 1)[-1]):
        try:
            ip: ipaddress.IPv4Address | ipaddress.IPv6Address = ipaddress.IPv4Address(host)
        except ValueError:
            return NUMERIC_HOST
    elif ":" in host:
        try:
            ip = ipaddress.ip_address(host)
        except ValueError:
            return INVALID_URL
    else:
        # Ein Name: Teile aus Buchstaben, Ziffern, Bindestrich und Unterstrich, nicht leer.
        labels = host.removesuffix(".").split(".")
        if len(host) > 253 or not all(_LABEL.fullmatch(label) for label in labels):
            return INVALID_URL
        return None
    for candidate in (ip, _embedded_v4(ip)):
        if candidate is not None and (
            candidate.is_link_local or candidate.is_multicast or candidate.is_unspecified
        ):
            return FORBIDDEN_TARGET
    return None


def check_url(text: str) -> tuple[str | None, str | None]:
    """Eine Adresse aus der App: wie ``STOWLY_HA_URL`` (``config.normalize_ha_url``), der Rechnername klein
    geschrieben, dazu ``target_problem``. Liefert ``(adresse, None)`` oder ``(None, meldung)``."""
    url = normalize_ha_url(text.strip())
    if url is None or len(url) > LIMITS["ha_url"]:
        return None, INVALID_URL
    parts = urlsplit(url)
    problem = target_problem(parts.hostname or "")
    if problem is not None:
        return None, problem
    return f"{parts.scheme}://{parts.netloc.lower()}", None


def _timestamp(value: Any) -> str | None:
    return value if isinstance(value, str) and timeutil.is_timestamp(value) else None


# --- Wirksame Werte ----------------------------------------------------------------------------


@dataclass(frozen=True)
class Effective:
    """Die wirksame Einrichtung von HA. Die Tokens stehen in keiner Ausgabe (``repr``)."""

    source: ConfigSource  # der Gruppe aus Adresse, Token und Liste
    url: str | None
    entity: str | None
    token: str | None = field(repr=False)
    token_set_at: str | None
    ca: Path | None
    problem: str | None  # warum der Abgleich aus ist, obwohl etwas gesetzt ist
    sensor_source: ConfigSource
    sensor_token: str | None = field(repr=False)
    sensor_set_at: str | None
    sensor_problem: str | None  # der Sensor-Token aus der App fehlt

    @property
    def configured(self) -> bool:
        """Adresse, Token und Liste sind wirksam: Der Abgleich mit Bring! läuft."""
        return None not in (self.url, self.token, self.entity)

    @property
    def fingerprint(self) -> Fingerprint | None:
        """Woran der Abgleich eine geänderte Einrichtung erkennt: Adresse, Hash des Tokens, Liste und CA.
        ``None``, solange HA nicht eingerichtet ist."""
        if self.url is None or self.token is None or self.entity is None:
            return None
        digest = hashlib.sha256(self.token.encode("utf-8")).hexdigest()
        return (self.url, digest, self.entity, None if self.ca is None else str(self.ca))

    @property
    def problems(self) -> str | None:
        """Was die App als ``problem`` zeigt: erst die Verbindung, dann der Sensor."""
        found = [text for text in (self.problem, self.sensor_problem) if text]
        return " ".join(found) or None


def from_environment(settings: Settings) -> bool:
    """Kommt die Verbindung (Adresse, Token, Liste) aus der Umgebung? Dann ist sie in der App gesperrt."""
    return any(value is not None for value in (settings.ha_url, settings.ha_token, settings.ha_todo_entity))


def app_url(con: sqlite3.Connection) -> str | None:
    """Die Adresse aus der App; was die Prüfung nicht besteht, zählt nicht."""
    value = serverconfig.get(con, URL)
    if not isinstance(value, str):
        return None
    url, problem = check_url(value)
    return url if problem is None else None


def app_entity(con: sqlite3.Connection) -> str | None:
    """Die To-do-Liste aus der App; was nicht dem Muster entspricht, zählt nicht."""
    value = serverconfig.get(con, ENTITY)
    return value if isinstance(value, str) and HA_TODO_ENTITY.fullmatch(value) else None


def _bound_token(record: dict[str, Any] | None, url: str | None) -> tuple[str | None, str | None]:
    """Token und Zeitpunkt aus ``ha_token.json``, nur wenn er für genau diese Adresse eingetragen wurde."""
    if record is None or url is None:
        return None, None
    token = record.get("token")
    if (
        not isinstance(token, str)
        or len(token) > LIMITS["ha_token"]
        or not header_safe(token)
        or record.get("url") != url
    ):
        return None, None
    return token, _timestamp(record.get("set_at"))


def _sensor_record(record: dict[str, Any] | None) -> tuple[str | None, str | None]:
    """Token und Zeitpunkt aus ``ha_sensor_token.json``; nach denselben Regeln wie STOWLY_HA_SUMMARY_TOKEN."""
    token = record.get("token") if record is not None else None
    if (
        not isinstance(token, str)
        or not HA_SUMMARY_TOKEN_MIN <= len(token) <= SENSOR_TOKEN_MAX
        or not header_safe(token)
    ):
        return None, None
    assert record is not None
    return token, _timestamp(record.get("set_at"))


def _store(settings: Settings, store: SecretStore | None) -> SecretStore:
    """Der Speicher aus ``app.state``; ohne ihn einer zum Lesen im selben Ordner."""
    return store if store is not None else SecretStore(settings.secrets_dir)


def sensor_token(settings: Settings, store: SecretStore | None = None) -> str | None:
    """Der wirksame Sensor-Token (ohne Datenbank, für jede Anfrage des Sensors); ``None`` = keiner."""
    if settings.ha_summary_token is not None:
        return settings.ha_summary_token
    return _sensor_record(_store(settings, store).get(HA_SENSOR_TOKEN))[0]


def _sensor(settings: Settings, con: sqlite3.Connection, store: SecretStore) -> dict[str, Any]:
    if settings.ha_summary_token is not None:
        return {
            "sensor_source": ConfigSource.ENV,
            "sensor_token": settings.ha_summary_token,
            "sensor_set_at": None,
            "sensor_problem": None,
        }
    token, set_at = _sensor_record(store.get(HA_SENSOR_TOKEN))
    marker = _timestamp(serverconfig.get(con, SENSOR_SET_AT))
    if token is not None:
        return {
            "sensor_source": ConfigSource.APP,
            "sensor_token": token,
            "sensor_set_at": set_at or marker,
            "sensor_problem": None,
        }
    if marker is not None:
        # In der App erzeugt, die Datei fehlt aber: Zurückspielen oder Umzug.
        return {
            "sensor_source": ConfigSource.APP,
            "sensor_token": None,
            "sensor_set_at": None,
            "sensor_problem": SENSOR_LOST,
        }
    return {
        "sensor_source": ConfigSource.DEFAULT,
        "sensor_token": None,
        "sensor_set_at": None,
        "sensor_problem": None,
    }


def _missing(parts: list[str]) -> str:
    names = [_PARTS[part] for part in parts]
    if len(names) == 1:
        return f"Für Home Assistant fehlt noch {names[0]}."
    return f"Für Home Assistant fehlen noch {', '.join(names[:-1])} und {names[-1]}."


def effective(settings: Settings, con: sqlite3.Connection, store: SecretStore | None = None) -> Effective:
    """Die wirksame Einrichtung: Umgebung oder App, mit Quelle und dem, was fehlt. Liest Datenbank und
    Speicher, also in einem Thread aufrufen."""
    store = _store(settings, store)
    sensor = _sensor(settings, con, store)
    if from_environment(settings):
        return Effective(
            source=ConfigSource.ENV,
            url=settings.ha_url,
            entity=settings.ha_todo_entity,
            token=settings.ha_token,
            token_set_at=None,
            ca=settings.ha_ca,
            problem=settings.ha_problem,
            **sensor,
        )
    url = app_url(con)
    entity = app_entity(con)
    marker = _timestamp(serverconfig.get(con, TOKEN_SET_AT))
    record = store.get(HA_TOKEN)
    token, set_at = _bound_token(record, url)
    if url is None and entity is None and marker is None and record is None:
        return Effective(
            source=ConfigSource.DEFAULT,
            url=None,
            entity=None,
            token=None,
            token_set_at=None,
            ca=settings.ha_ca,
            problem=None,
            **sensor,
        )
    notes: list[str] = []
    missing = [part for part, value in (("url", url), ("token", token), ("entity", entity)) if value is None]
    if token is None and url is not None and marker is not None:
        # In der App eingetragen, die Datei fehlt aber oder gehört zu einer anderen Adresse.
        missing.remove("token")
        notes.append(TOKEN_LOST)
    elif token is None and store.problem is not None:
        missing.remove("token")
        notes.append(store.problem)
    if missing:
        notes.insert(0, _missing(missing))
    return Effective(
        source=ConfigSource.APP,
        url=url,
        entity=entity,
        token=token,
        token_set_at=(set_at or marker) if token is not None else None,
        ca=settings.ha_ca,
        problem=" ".join(notes) or None,
        **sensor,
    )


def view(settings: Settings, current: Effective) -> dict[str, Any]:
    """``HaConfig``: die wirksame Einrichtung mit Quelle. Nie ein Token."""
    return {
        "source": current.source,
        "url": current.url,
        "entity": current.entity,
        "token_set": current.token is not None,
        "token_set_at": current.token_set_at,
        "ca": settings.ha_ca is not None,
        "configured": current.configured,
        "problem": current.problems,
        "sensor": {
            "source": current.sensor_source,
            "set": current.sensor_token is not None,
            "set_at": current.sensor_set_at,
        },
    }


# --- Ändern (PATCH /api/server-config/ha) ------------------------------------------------------


def _error(name: str, message: str) -> dict[str, Any]:
    return {"loc": ["body", name], "msg": message, "type": f"ha_{name}"}


def _invalid(problems: list[dict[str, Any]]) -> ApiError:
    return ApiError(422, ErrorCode.INVALID_REQUEST, INVALID, {"errors": problems})


def _not_written(exc: SecretStoreError) -> ApiError:
    return ApiError(500, ErrorCode.INTERNAL, str(exc))


def change(
    settings: Settings,
    con: sqlite3.Connection,
    store: SecretStore,
    changes: HaConfigChanges,
    *,
    device_id: str,
    now: str,
) -> list[str]:
    """Übernimmt die vorhandenen Felder und liefert die Schlüssel in ``server_config``, die sich geändert
    haben (für das Ereignis und ``BringSync.reconfigure``).

    Reihenfolge: erst der Speicher, dann eine Transaktion mit dem Ereignis ``server.config_changed`` (nur
    Schlüsselnamen). Scheitert der Speicher, ändert sich nichts. ``ApiError`` 409, wenn die Verbindung aus
    der Umgebung kommt; 422 mit ``details.errors[].loc`` bei einer ungültigen Adresse oder einem Token, der
    nicht in eine Kopfzeile passt oder ohne Adresse käme; 500, wenn der Speicher nicht schreibt.
    """
    fields = changes.model_fields_set & {"url", "entity", "token"}
    if not fields:
        return []
    if from_environment(settings):
        raise ApiError(409, ErrorCode.CONFLICT, FROM_ENVIRONMENT)

    current_url = app_url(con)
    url = current_url
    problems: list[dict[str, Any]] = []
    if "url" in fields:
        url = None
        if changes.url is not None:
            url, message = check_url(changes.url)
            if message is not None:
                problems.append(_error("url", message))
    token: str | None = None
    if "token" in fields and changes.token is not None:
        token = changes.token.strip()
        if not header_safe(token):
            problems.append(_error("token", INVALID_TOKEN))
        elif url is None and not problems:
            problems.append(_error("token", TOKEN_WITHOUT_URL))
    if problems:
        raise _invalid(problems)

    # Verglichen mit dem gespeicherten Wert, wie er dasteht: Auch ein unbrauchbarer lässt sich so entfernen.
    url_changed = "url" in fields and url != serverconfig.get(con, URL)
    # Ohne neuen Token mit einer neuen Adresse (oder auf Wunsch) fällt der alte weg: Er gilt nur für seine.
    drop_token = ("token" in fields and token is None) or (url_changed and "token" not in fields)
    file_removed = False
    try:
        if token is not None:
            store.put(HA_TOKEN, {"token": token, "url": url, "set_at": now})
        elif drop_token:
            file_removed = store.delete(HA_TOKEN)
    except SecretStoreError as exc:
        raise _not_written(exc) from None

    changed: list[str] = []
    with db.transaction(con):
        if url_changed:
            if url is None:
                serverconfig.delete(con, URL)
            else:
                serverconfig.put(con, URL, url, now=now, by=device_id)
            changed.append(URL)
        if "entity" in fields and serverconfig.get(con, ENTITY) != changes.entity:
            if changes.entity is None:
                serverconfig.delete(con, ENTITY)
            else:
                serverconfig.put(con, ENTITY, changes.entity, now=now, by=device_id)
            changed.append(ENTITY)
        if token is not None:
            serverconfig.put(con, TOKEN_SET_AT, now, now=now, by=device_id)
            changed.append(TOKEN_SET_AT)
        elif drop_token and (serverconfig.delete(con, TOKEN_SET_AT) or file_removed):
            changed.append(TOKEN_SET_AT)
        if changed:
            serverconfig.changed_event(con, changed, device_id=device_id, now=now)
    if changed:
        log.info("Home Assistant: Einrichtung in der App geändert: %s", ", ".join(changed))
    return changed


# --- Sensor-Token aus der App ------------------------------------------------------------------


def _sensor_from_environment(settings: Settings) -> None:
    if settings.ha_summary_token is not None:
        raise ApiError(409, ErrorCode.CONFLICT, SENSOR_FROM_ENVIRONMENT)


def create_sensor_token(
    settings: Settings, con: sqlite3.Connection, store: SecretStore, *, device_id: str, now: str
) -> str:
    """Erzeugt einen neuen Sensor-Token (64 Hex-Zeichen) und ersetzt den bisherigen. 409 aus der Umgebung."""
    _sensor_from_environment(settings)
    token = secrets.token_hex(SENSOR_TOKEN_BYTES)
    try:
        store.put(HA_SENSOR_TOKEN, {"token": token, "set_at": now})
    except SecretStoreError as exc:
        raise _not_written(exc) from None
    with db.transaction(con):
        serverconfig.put(con, SENSOR_SET_AT, now, now=now, by=device_id)
        serverconfig.changed_event(con, [SENSOR_SET_AT], device_id=device_id, now=now)
    log.info("Home Assistant: neuer Sensor-Token aus der App.")
    return token


def stored_sensor_token(settings: Settings, con: sqlite3.Connection, store: SecretStore) -> str:
    """Der Sensor-Token aus der App zum Anzeigen. 409 aus der Umgebung, 404 ohne (auch wenn er fehlt)."""
    _sensor_from_environment(settings)
    token = _sensor_record(store.get(HA_SENSOR_TOKEN))[0]
    if token is None:
        lost = _timestamp(serverconfig.get(con, SENSOR_SET_AT)) is not None
        raise ApiError(404, ErrorCode.NOT_FOUND, SENSOR_LOST if lost else NO_SENSOR_TOKEN)
    return token


def delete_sensor_token(
    settings: Settings, con: sqlite3.Connection, store: SecretStore, *, device_id: str, now: str
) -> None:
    """Entfernt den Sensor-Token aus der App; der Sensor antwortet danach mit 503. 409 aus der Umgebung."""
    _sensor_from_environment(settings)
    try:
        removed = store.delete(HA_SENSOR_TOKEN)
    except SecretStoreError as exc:
        raise _not_written(exc) from None
    with db.transaction(con):
        if serverconfig.delete(con, SENSOR_SET_AT) or removed:
            serverconfig.changed_event(con, [SENSOR_SET_AT], device_id=device_id, now=now)
    if removed:
        log.info("Home Assistant: Sensor-Token aus der App entfernt.")
