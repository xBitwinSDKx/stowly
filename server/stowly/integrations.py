"""Zustand der Integrationen für die Einstellungen der App (docs/integrationen.md, Abschnitt 8).

Nie darin: ein Token, ein privater Schlüssel, die Adresse von Home Assistant, ``STOWLY_PUSH_CONTACT``.
Öffentliche age-Schlüssel nur gekürzt.
"""

import sqlite3
from collections.abc import Mapping
from datetime import datetime
from typing import Any

from stowly import autobackup, daily, scheduler
from stowly.config import Settings

PUSH_DAILY = daily.JOB


def ha_status(
    settings: Settings, con: sqlite3.Connection, sync: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    """``HaStatus`` (docs/integrationen.md, 5.6 und 8).

    ``sync`` ist der Zustand des Abgleichs im Arbeitsspeicher (``bring.BringSync.status``). Nicht
    eingerichtet: ``off``; eingerichtet, aber noch kein Lauf seit dem Start: ``pending``.
    """
    linked = con.execute(
        "SELECT COUNT(*) FROM shopping_items "
        "WHERE bring_key IS NOT NULL AND done_at IS NULL AND deleted_at IS NULL"
    ).fetchone()[0]
    if not settings.ha_configured:
        state: Mapping[str, Any] = {"state": "off"}
    elif sync is None:
        state = {"state": "pending"}
    else:
        state = sync
    return {
        "configured": settings.ha_configured,
        "problem": settings.ha_problem,
        "entity": settings.ha_todo_entity,
        "state": state["state"],
        "last_ok_at": state.get("last_ok_at"),
        "last_error": state.get("last_error"),
        "last_error_at": state.get("last_error_at"),
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


def status(
    settings: Settings,
    con: sqlite3.Connection,
    *,
    device_id: str,
    now: datetime,
    ha_sync: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """``IntegrationStatus`` für ``GET /api/integrations``."""
    return {
        "timezone": settings.timezone,
        "backup": autobackup.status(settings, scheduler.load_run(con, autobackup.JOB), now),
        "ha": ha_status(settings, con, ha_sync),
        "push": push_status(settings, con, device_id),
    }
