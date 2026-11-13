"""Änderungsfolge: alles mit ``rev > cursor`` (docs/sync-protokoll.md, Abschnitt 6.4).

Jede synchronisierte Zeile trägt den ``rev`` ihres letzten Schreibens; die Einstellungen
teilen sich ``counters.settings_rev``. Eine Antwort enthält höchstens ``PAGE_LIMIT``
Datensätze. Beim Blättern geht nichts verloren:

* Der gelieferte ``cursor`` ist ein Stand, bis zu dem die Antwort **über alle Tabellen
  hinweg** alles enthält. Geschnitten wird deshalb an einem ``rev``, nicht je Tabelle.
* Eine Seite endet nie mitten in einem ``rev``, den sich mehrere Zeilen teilen (ein Befehl,
  der viele Packungen auf einmal verschiebt). Sie darf dafür größer werden als die Grenze.

Nur ein vollständiger Abzug (``reset``) lässt etwas weg: lange entnommene Packungen und
lange erledigte Etiketten. Jede andere Antwort liefert ausnahmslos alles, sonst erführe
ein lange nicht benutztes Gerät nie, dass eine Packung inzwischen entnommen ist.
"""

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from stowly import db, records
from stowly.contract import MAX_CHANGES_PER_SYNC
from stowly.contract.timeutil import format_timestamp

# Höchstzahl der Datensätze je Antwort. Tests setzen den Wert herab.
PAGE_LIMIT = MAX_CHANGES_PER_SYNC

# Etiketten in einem Endzustand fehlen im vollständigen Abzug, wenn sie älter sind.
JOB_RETENTION_DAYS = 30

# Tabelle -> Spalte(n), nach denen innerhalb eines rev sortiert wird (stabile Reihenfolge).
_TABLES: dict[str, str] = {
    "zones": "id",
    "products": "id",
    "packages": "id",
    "printers": "id",
    "printer_status": "printer_id",
    "print_jobs": "id",
    "label_templates": "key",
}

# Was ein vollständiger Abzug weglässt.
_OMISSIONS: dict[str, str] = {
    "packages": " AND (removed_at IS NULL OR removed_at >= :removed_cutoff)",
    "print_jobs": (
        " AND (state NOT IN ('printed', 'sent', 'failed', 'cancelled') OR updated_at >= :jobs_cutoff)"
    ),
}


@dataclass(frozen=True)
class Page:
    changes: dict[str, Any]
    cursor: int
    has_more: bool


def _revs(reset: bool) -> str:
    """Ein ``rev`` je lieferbarem Datensatz nach ``:since``, über alle Tabellen."""
    parts = [
        f"SELECT rev FROM {table} WHERE rev > :since{_OMISSIONS.get(table, '') if reset else ''}"
        for table in _TABLES
    ]
    parts.append("SELECT value AS rev FROM counters WHERE name = 'settings_rev' AND value > :since")
    return " UNION ALL ".join(parts)


def collect(con: sqlite3.Connection, *, cursor: int, reset: bool, now: datetime) -> Page:
    """Sammelt die Änderungen nach ``cursor`` ein; bei ``reset`` einen Abzug ab 0.

    Muss in derselben Transaktion laufen wie die Befehle davor: Ihre Wirkung gehört dazu.
    """
    limit = max(1, PAGE_LIMIT)
    head = db.current_rev(con)
    parameters: dict[str, Any] = {"since": 0 if reset else cursor}
    if reset:
        retention = int(records.settings_values(con)["trash_retention_days"])
        parameters["removed_cutoff"] = format_timestamp(now - timedelta(days=retention))
        parameters["jobs_cutoff"] = format_timestamp(now - timedelta(days=JOB_RETENTION_DAYS))
    revs = _revs(reset)

    def count(condition: str = "", **extra: int) -> int:
        row = con.execute(f"SELECT COUNT(*) FROM ({revs}){condition}", {**parameters, **extra}).fetchone()
        return int(row[0])

    total = count()
    if total <= limit:
        upto, has_more = head, False
    else:
        # Der rev des letzten Datensatzes, der noch auf die Seite passt.
        edge = int(
            con.execute(
                f"SELECT rev FROM ({revs}) ORDER BY rev LIMIT 1 OFFSET :offset",
                {**parameters, "offset": limit - 1},
            ).fetchone()[0]
        )
        included = count(" WHERE rev <= :edge", edge=edge)
        upto = edge
        if included > limit:
            # Diesen rev teilen sich mehr Zeilen, als noch Platz ist: davor aufhören.
            # Steht er ganz am Anfang, kommt er trotzdem vollständig mit.
            before = count(" WHERE rev < :edge", edge=edge)
            if before > 0:
                upto, included = edge - 1, before
        has_more = included < total
        if not has_more:
            upto = head

    parameters["upto"] = upto
    rows: dict[str, list[sqlite3.Row]] = {}
    for table, order in _TABLES.items():
        omission = _OMISSIONS.get(table, "") if reset else ""
        rows[table] = con.execute(
            f"SELECT * FROM {table} WHERE rev > :since AND rev <= :upto{omission} ORDER BY rev, {order}",
            parameters,
        ).fetchall()

    settings_rev = int(con.execute("SELECT value FROM counters WHERE name = 'settings_rev'").fetchone()[0])
    settings = records.household_settings(con) if parameters["since"] < settings_rev <= upto else None

    changes = {
        "products": records.products(con, rows["products"]),
        "zones": [records.zone(row) for row in rows["zones"]],
        "packages": [records.package(row) for row in rows["packages"]],
        "printers": [records.printer(row) for row in rows["printers"]],
        "printer_status": [records.printer_status(row) for row in rows["printer_status"]],
        "print_jobs": [records.print_job(row) for row in rows["print_jobs"]],
        "label_templates": [records.label_template(row) for row in rows["label_templates"]],
        "settings": settings,
    }
    return Page(changes=changes, cursor=upto, has_more=has_more)
