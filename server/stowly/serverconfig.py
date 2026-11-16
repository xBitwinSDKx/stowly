"""Einstellungen des Servers aus der App und was der Server über sich lernt (docs/integrationen.md,
Abschnitt 12; docs/sync-protokoll.md, 11.6 und 11.7).

* **Tabelle** ``server_config`` (Migration 0004): je Schlüssel ein JSON-Wert mit ``updated_at`` und
  ``updated_by`` (das Gerät; NULL = vom Server selbst gelernt). Nie ein Geheimnis: Die Tabelle steht in
  jeder Sicherung. Nicht im Sync; die App liest sie über ``GET /api/server-config`` und ``GET /api/setup``.
* **Vorrang:** Die Umgebung geht vor. Was dort steht, ist in der App nur zu sehen (``source: env``),
  ``PATCH`` antwortet dann mit 409.

  - Push-Kontakt: ``STOWLY_PUSH_CONTACT``, sonst der Kontakt aus der App, sonst keiner.
  - Updates: ``STOWLY_UPDATE_REPO`` (immer an), sonst der Schalter in der App mit dem Repository aus
    ``STOWLY_UPDATE_REPO_DEFAULT``, sonst aus.
* **Ohne Neustart:** Wer einen Wert braucht (Versand von Push, Tagesnachricht, Abfrage bei GitHub), liest
  ihn erst beim Einsatz hier.

Die Schlüssel des Assistenten (Schritte, Adressen, Ports, Ursprünge) liest und schreibt ``wizard.py``.
"""

import json
import logging
import sqlite3
from typing import Any

from stowly import db, events
from stowly.config import Settings, push_contact_valid
from stowly.contract.api import ConfigSource, ErrorCode, ServerConfigChanges
from stowly.errors import ApiError

log = logging.getLogger("stowly.config")

# Einstellungen aus der App (docs/integrationen.md, 12).
PUSH_CONTACT = "push_contact"
UPDATE_ENABLED = "update_enabled"
# Fortschritt des Assistenten und Gelerntes (wizard.py; docs/sync-protokoll.md, 11.6).
SETUP_STEPS = "setup_steps"
SETUP_FINISHED_AT = "setup_finished_at"
TLS_ADDRESSES = "tls_addresses"
HTTPS_PORT = "https_port"
HTTP_PORT = "http_port"
HTTPS_SEEN_AT = "https_seen_at"
APP_ORIGINS_SEEN = "app_origins_seen"

PUSH_FROM_ENVIRONMENT = "Der Kontakt für die Push-Dienste steht in der Umgebung (STOWLY_PUSH_CONTACT) und lässt sich nur dort ändern."
UPDATES_FROM_ENVIRONMENT = (
    "Updates sind über STOWLY_UPDATE_REPO fest eingeschaltet; das lässt sich nur dort ändern."
)
UPDATES_UNAVAILABLE = "Dieses Image kennt kein Repository für Updates (STOWLY_UPDATE_REPO_DEFAULT); der Schalter wirkt hier nicht."
INVALID_CONTACT = "Erwartet ist eine E-Mail-Adresse (mailto:) oder eine https-Adresse."


# --- Lesen und Schreiben -----------------------------------------------------------------------


def get(con: sqlite3.Connection, key: str, default: Any = None) -> Any:
    """Der Wert eines Schlüssels; ``default``, wenn er fehlt oder kein JSON ist."""
    row = con.execute("SELECT value FROM server_config WHERE key = ?", (key,)).fetchone()
    if row is None:
        return default
    try:
        return json.loads(row[0])
    except ValueError:
        log.warning("server_config: Der Wert von %s ist kein JSON und wird übergangen.", key)
        return default


def put(con: sqlite3.Connection, key: str, value: Any, *, now: str, by: str | None) -> None:
    """Schreibt einen Wert, in der Transaktion des Aufrufers. ``by`` ist das Gerät, ``None`` der Server."""
    con.execute(
        "INSERT INTO server_config (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) "
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, "
        "updated_by = excluded.updated_by",
        (key, json.dumps(value, ensure_ascii=False, separators=(",", ":")), now, by),
    )


def delete(con: sqlite3.Connection, key: str) -> bool:
    """Entfernt einen Schlüssel, in der Transaktion des Aufrufers; liefert, ob es ihn gab."""
    return con.execute("DELETE FROM server_config WHERE key = ?", (key,)).rowcount > 0


def changed_event(con: sqlite3.Connection, keys: list[str], *, device_id: str | None, now: str) -> None:
    """``server.config_changed`` mit den geänderten Schlüsseln, nie ihren Werten."""
    events.record(
        con,
        at=now,
        recorded_at=now,
        device_id=device_id,
        type="server.config_changed",
        entity="server",
        entity_id="config",
        data={"keys": keys},
    )


# --- Wirksame Werte ----------------------------------------------------------------------------


def _app_contact(con: sqlite3.Connection) -> str | None:
    value = get(con, PUSH_CONTACT)
    return value if isinstance(value, str) and push_contact_valid(value) else None


def push_contact(settings: Settings, con: sqlite3.Connection) -> str | None:
    """Der wirksame Kontakt für die Push-Dienste (VAPID ``sub``); ``None`` = Push ist aus."""
    if settings.push_contact is not None:
        return settings.push_contact
    return _app_contact(con)


def _push(settings: Settings, con: sqlite3.Connection) -> dict[str, Any]:
    if settings.push_contact is not None:
        return {"contact": settings.push_contact, "source": ConfigSource.ENV}
    contact = _app_contact(con)
    return {"contact": contact, "source": ConfigSource.APP if contact is not None else ConfigSource.DEFAULT}


def _update(settings: Settings, con: sqlite3.Connection) -> dict[str, Any]:
    if settings.update_repo is not None:
        return {"enabled": True, "repo": settings.update_repo, "source": ConfigSource.ENV, "available": False}
    switch = get(con, UPDATE_ENABLED)
    available = settings.update_repo_default is not None
    return {
        "enabled": switch is True and available,
        "repo": settings.update_repo_default,
        "source": ConfigSource.APP if isinstance(switch, bool) else ConfigSource.DEFAULT,
        "available": available,
    }


def update_repo(settings: Settings, con: sqlite3.Connection) -> str | None:
    """Das wirksame Repository der Releases; ``None`` = Updates sind aus."""
    if settings.update_repo is not None:
        return settings.update_repo
    if settings.update_repo_default is not None and get(con, UPDATE_ENABLED) is True:
        return settings.update_repo_default
    return None


def effective(settings: Settings, con: sqlite3.Connection) -> dict[str, Any]:
    """``ServerConfig``: die wirksamen Werte mit ihrer Quelle. Nie ein Geheimnis."""
    return {"push": _push(settings, con), "update": _update(settings, con)}


# --- Ändern (PATCH /api/server-config) ---------------------------------------------------------


def normalize_contact(text: str) -> str:
    """Leerraum am Rand fällt weg; eine Adresse ohne ``mailto:`` (und ohne ``://``) bekommt es davor."""
    contact = text.strip()
    if contact and not contact.startswith("mailto:") and "://" not in contact:
        contact = "mailto:" + contact
    return contact


def change(
    settings: Settings, con: sqlite3.Connection, changes: ServerConfigChanges, *, device_id: str, now: str
) -> list[str]:
    """Übernimmt die vorhandenen Felder und liefert die Schlüssel, die sich wirklich geändert haben.

    ``ApiError`` 409, wenn ein Feld aus der Umgebung kommt oder das Image kein Repository für den Schalter
    kennt; 422, wenn der Kontakt nicht taugt. Dann ändert sich nichts.
    """
    fields = changes.model_fields_set
    if PUSH_CONTACT in fields and settings.push_contact is not None:
        raise ApiError(409, ErrorCode.CONFLICT, PUSH_FROM_ENVIRONMENT)
    if UPDATE_ENABLED in fields:
        if settings.update_repo is not None:
            raise ApiError(409, ErrorCode.CONFLICT, UPDATES_FROM_ENVIRONMENT)
        if settings.update_repo_default is None:
            raise ApiError(409, ErrorCode.CONFLICT, UPDATES_UNAVAILABLE)
    contact: str | None = None
    if PUSH_CONTACT in fields and changes.push_contact is not None:
        contact = normalize_contact(changes.push_contact)
        if not push_contact_valid(contact):
            raise ApiError(
                422,
                ErrorCode.INVALID_REQUEST,
                "Die Anfrage entspricht nicht dem Vertrag.",
                {"errors": [{"loc": ["body", PUSH_CONTACT], "msg": INVALID_CONTACT, "type": "push_contact"}]},
            )

    changed: list[str] = []
    with db.transaction(con):
        if PUSH_CONTACT in fields:
            old = get(con, PUSH_CONTACT)
            if contact is None:
                if delete(con, PUSH_CONTACT):
                    changed.append(PUSH_CONTACT)
            elif old != contact:
                put(con, PUSH_CONTACT, contact, now=now, by=device_id)
                changed.append(PUSH_CONTACT)
        if UPDATE_ENABLED in fields and get(con, UPDATE_ENABLED) is not changes.update_enabled:
            put(con, UPDATE_ENABLED, bool(changes.update_enabled), now=now, by=device_id)
            changed.append(UPDATE_ENABLED)
        if changed:
            changed_event(con, changed, device_id=device_id, now=now)
    if changed:
        log.info("Einstellungen des Servers geändert: %s", ", ".join(changed))
    return changed
