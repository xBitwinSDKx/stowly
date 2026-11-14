"""Zustand der Integrationen für die Einstellungen der App (docs/integrationen.md, Abschnitt 8).

Nie darin: ein Token, ein privater Schlüssel, die Adresse von Home Assistant, ``STOWLY_PUSH_CONTACT``.
Öffentliche age-Schlüssel nur gekürzt.
"""

import sqlite3
from datetime import datetime
from typing import Any

from stowly import autobackup, scheduler
from stowly.config import Settings

PUSH_DAILY = "push_daily"


def ha_status(settings: Settings, con: sqlite3.Connection) -> dict[str, Any]:
    """``HaStatus``. Der Abgleich mit Bring! kommt in Runde 2; bis dahin steht er auf ``pending``,
    wenn er eingerichtet ist, sonst auf ``off``."""
    linked = con.execute(
        "SELECT COUNT(*) FROM shopping_items "
        "WHERE bring_key IS NOT NULL AND done_at IS NULL AND deleted_at IS NULL"
    ).fetchone()[0]
    return {
        "configured": settings.ha_configured,
        "problem": settings.ha_problem,
        "entity": settings.ha_todo_entity,
        "state": "pending" if settings.ha_configured else "off",
        "last_ok_at": None,
        "last_error": None,
        "last_error_at": None,
        "linked": int(linked),
        "sensor": settings.ha_summary_token is not None,
    }


def push_status(settings: Settings, con: sqlite3.Connection, device_id: str) -> dict[str, Any]:
    """``PushStatus``: Abos im Haushalt, das des fragenden Geräts, der letzte Lauf der Tagesnachricht."""
    run = scheduler.load_run(con, PUSH_DAILY)
    subscriptions = con.execute("SELECT COUNT(*) FROM push_subscriptions").fetchone()[0]
    this_device = con.execute("SELECT 1 FROM push_subscriptions WHERE device_id = ?", (device_id,)).fetchone()
    sent_at = run.state.get("sent_at")
    return {
        "configured": settings.push_configured,
        "problem": None,
        "subscriptions": int(subscriptions),
        "this_device": this_device is not None,
        "last_run_at": run.last_at,
        "last_sent_at": sent_at if isinstance(sent_at, str) else None,
        "last_error": run.last_error,
    }


def status(settings: Settings, con: sqlite3.Connection, *, device_id: str, now: datetime) -> dict[str, Any]:
    """``IntegrationStatus`` für ``GET /api/integrations``."""
    return {
        "timezone": settings.timezone,
        "backup": autobackup.status(settings, scheduler.load_run(con, autobackup.JOB), now),
        "ha": ha_status(settings, con),
        "push": push_status(settings, con, device_id),
    }
