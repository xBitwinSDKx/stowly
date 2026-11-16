"""Zustand der Integrationen für die Einstellungen der App (docs/integrationen.md, Abschnitt 8).

Push und Updates zeigen die wirksamen Werte: aus der Umgebung oder aus der App (``serverconfig``).
Nie darin: ein Token, ein privater Schlüssel, die Adresse von Home Assistant, der Push-Kontakt,
Pfade des Rechners oder das Log des Updaters. Öffentliche age-Schlüssel nur gekürzt.
"""

import sqlite3
from collections.abc import Mapping
from datetime import datetime
from typing import Any

from stowly import autobackup, bring, daily, haconfig, scheduler, serverconfig, updates
from stowly.config import Settings
from stowly.secretstore import SecretStore

PUSH_DAILY = daily.JOB


def ha_status(
    settings: Settings,
    con: sqlite3.Connection,
    sync: bring.BringSync | None = None,
    store: SecretStore | None = None,
) -> dict[str, Any]:
    """``HaStatus`` (docs/integrationen.md, 5.6 und 8) aus der wirksamen Einrichtung (``haconfig.effective``:
    Umgebung oder App, ``store`` mit den Tokens).

    ``sync`` ist der Abgleich (``app.state.bring``) mit seinem Zustand im Arbeitsspeicher. Nicht eingerichtet:
    ``off``; eingerichtet, aber noch kein Lauf mit dieser Einrichtung (seit dem Start oder einer Änderung):
    ``pending``. ``problem`` nennt auch einen Sensor-Token, der nach einem Zurückspielen fehlt.
    """
    current = haconfig.effective(settings, con, store)
    linked = con.execute(
        "SELECT COUNT(*) FROM shopping_items "
        "WHERE bring_key IS NOT NULL AND done_at IS NULL AND deleted_at IS NULL"
    ).fetchone()[0]
    if not current.configured:
        state: Mapping[str, Any] = {"state": "off"}
    elif sync is None or sync.fingerprint != current.fingerprint:
        state = {"state": "pending"}
    else:
        state = sync.status()
    return {
        "configured": current.configured,
        "problem": current.problems,
        "entity": current.entity,
        "state": state["state"],
        "last_ok_at": state.get("last_ok_at"),
        "last_error": state.get("last_error"),
        "last_error_at": state.get("last_error_at"),
        "linked": int(linked),
        "sensor": current.sensor_token is not None,
    }


def push_status(settings: Settings, con: sqlite3.Connection, device_id: str) -> dict[str, Any]:
    """``PushStatus``: Abos im Haushalt, das des fragenden Geräts, der letzte Lauf der Tagesnachricht."""
    run = scheduler.load_run(con, PUSH_DAILY)
    subscriptions = con.execute("SELECT COUNT(*) FROM push_subscriptions").fetchone()[0]
    this_device = con.execute("SELECT 1 FROM push_subscriptions WHERE device_id = ?", (device_id,)).fetchone()
    sent_at = run.state.get("sent_at")
    return {
        # Wirksam: STOWLY_PUSH_CONTACT oder der Kontakt aus der App (Abschnitt 12).
        "configured": serverconfig.push_contact(settings, con) is not None,
        "problem": None,
        "subscriptions": int(subscriptions),
        "this_device": this_device is not None,
        "last_run_at": run.last_at,
        "last_sent_at": sent_at if isinstance(sent_at, str) else None,
        "last_error": run.last_error,
    }


def status(
    settings: Settings,
    con: sqlite3.Connection,
    *,
    device_id: str,
    now: datetime,
    ha_sync: bring.BringSync | None = None,
    ha_store: SecretStore | None = None,
) -> dict[str, Any]:
    """``IntegrationStatus`` für ``GET /api/integrations``."""
    return {
        "timezone": settings.timezone,
        "backup": autobackup.status(settings, scheduler.load_run(con, autobackup.JOB), now),
        "ha": ha_status(settings, con, ha_sync, ha_store),
        "push": push_status(settings, con, device_id),
        "update": update_status(settings, con, now),
    }


def update_status(settings: Settings, con: sqlite3.Connection, now: datetime) -> dict[str, Any]:
    """``UpdateStatus`` (docs/integrationen.md, 10.4): das neueste Release aus ``job_runs`` (Aufgabe
    ``update_check``) und der Austausch mit dem Updater in ``/data/update``; ``now`` misst das Alter
    der Anforderung und der Meldungen des Updaters."""
    return updates.status(settings, con, now)
