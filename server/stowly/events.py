"""Ereignisprotokoll (docs/sync-protokoll.md, „Ereignisprotokoll").

Zu jeder Wirkung eines Befehls schreibt der Server mindestens einen Eintrag. Das
Protokoll wird nie gekürzt und nicht an die Geräte synchronisiert. Tokens und das
Passwort stehen nie darin.
"""

import json
import sqlite3
from typing import Any

from stowly import records

# Feste Kennung des einzigen Einstellungs-Datensatzes.
SETTINGS_ENTITY_ID = "household"


def record(
    con: sqlite3.Connection,
    *,
    at: str,
    recorded_at: str,
    type: str,
    entity: str,
    entity_id: str,
    data: dict[str, Any] | None = None,
    device_id: str | None = None,
    command_id: str | None = None,
) -> None:
    """Schreibt einen Eintrag. ``at`` ist der wirksame Zeitpunkt, ``recorded_at`` die Serverzeit."""
    con.execute(
        "INSERT INTO events (at, recorded_at, device_id, command_id, type, entity, entity_id, data) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            at,
            recorded_at,
            device_id,
            command_id,
            type,
            entity,
            entity_id,
            json.dumps(data or {}, ensure_ascii=False, separators=(",", ":")),
        ),
    )


def page(
    con: sqlite3.Connection,
    *,
    before: int | None,
    limit: int,
    entity: str | None,
    entity_id: str | None,
) -> tuple[list[dict[str, Any]], int | None]:
    """Eine Seite des Protokolls, neueste zuerst, und die Marke für die nächste Seite."""
    conditions: list[str] = []
    parameters: list[Any] = []
    if before is not None:
        conditions.append("id < ?")
        # Größer als jede Kennung, die es geben kann, heißt: von vorn. (SQLite fasst 64 Bit.)
        parameters.append(min(before, 2**63 - 1))
    if entity is not None:
        conditions.append("entity = ?")
        parameters.append(entity)
    if entity_id is not None:
        conditions.append("entity_id = ?")
        parameters.append(entity_id)
    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    # Eine Zeile mehr holen: So zeigt sich, ob es eine weitere Seite gibt.
    rows = con.execute(
        f"SELECT * FROM events {where} ORDER BY id DESC LIMIT ?", (*parameters, limit + 1)
    ).fetchall()
    events = [records.event(row) for row in rows[:limit]]
    next_before = events[-1]["id"] if len(rows) > limit else None
    return events, next_before
