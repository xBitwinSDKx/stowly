"""SQLite: Verbindung, Migrationen, Grundausstattung.

Stowly spricht SQLite direkt über die Standardbibliothek, ohne ORM. Das Schema
liegt als nummerierte SQL-Dateien in ``stowly/migrations`` und ist Teil des Vertrags.

Regeln für alle Zugriffe:

* Jede Anfrage öffnet eine eigene Verbindung (``connect``) und schließt sie wieder.
* Schreibende Abläufe laufen vollständig in ``with transaction(con):``. Das beginnt
  mit ``BEGIN IMMEDIATE``: Es gibt immer nur einen Schreiber, Leser warten nie (WAL).
* Jede Änderung an einer synchronisierten Zeile setzt ``rev = next_rev(con)``.
"""

import json
import re
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from importlib import resources
from pathlib import Path

from stowly.contract import ids, timeutil

_MIGRATION_NAME = re.compile(r"^(\d{4})_[a-z0-9_]+\.sql$")

DEFAULT_SETTINGS: dict[str, object] = {
    "zone_mode": "primary",
    "primary_zone_id": None,  # wird beim ersten Start auf die erste Zone gesetzt
    "warn_days": 14,
    "trash_retention_days": 30,
    "default_printer_id": None,
}
DEFAULT_ZONE_NAME = "Vorrat"
DEFAULT_ZONE_ICON = "shelf"
SETTINGS_ENTITY_ID = "household"


def connect(path: Path | str) -> sqlite3.Connection:
    """Öffnet eine Verbindung im Autocommit-Modus; Transaktionen nur über ``transaction``."""
    con = sqlite3.connect(str(path), isolation_level=None, check_same_thread=False, timeout=10.0)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA busy_timeout = 10000")
    if str(path) != ":memory:":
        con.execute("PRAGMA journal_mode = WAL")
        con.execute("PRAGMA synchronous = NORMAL")
    return con


@contextmanager
def transaction(con: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """Schreib-Transaktion: alles oder nichts."""
    con.execute("BEGIN IMMEDIATE")
    try:
        yield con
    except BaseException:
        con.execute("ROLLBACK")
        raise
    else:
        con.execute("COMMIT")


def next_rev(con: sqlite3.Connection) -> int:
    """Nächster Wert der Änderungsfolge. Nur innerhalb einer Transaktion aufrufen."""
    row = con.execute("UPDATE counters SET value = value + 1 WHERE name = 'rev' RETURNING value").fetchone()
    return int(row[0])


def current_rev(con: sqlite3.Connection) -> int:
    row = con.execute("SELECT value FROM counters WHERE name = 'rev'").fetchone()
    return int(row[0])


def get_meta(con: sqlite3.Connection, key: str) -> str | None:
    row = con.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return None if row is None else str(row[0])


def list_migrations() -> list[tuple[int, str, str]]:
    """Alle Migrationen als ``(nummer, dateiname, sql)``, aufsteigend und lückenlos ab 1."""
    found: list[tuple[int, str, str]] = []
    for entry in resources.files("stowly.migrations").iterdir():
        match = _MIGRATION_NAME.match(entry.name)
        if match:
            found.append((int(match.group(1)), entry.name, entry.read_text(encoding="utf-8")))
    found.sort()
    for expected, (number, name, _sql) in enumerate(found, start=1):
        if number != expected:
            raise RuntimeError(f"Migration {name}: erwartet war Nummer {expected:04d}.")
    return found


def schema_version(con: sqlite3.Connection) -> int:
    return int(con.execute("PRAGMA user_version").fetchone()[0])


def migrate(con: sqlite3.Connection) -> int:
    """Wendet alle noch fehlenden Migrationen an, jede in einer eigenen Transaktion.

    Der Stand steht in ``PRAGMA user_version``. Liefert die erreichte Version.
    """
    migrations = list_migrations()
    version = schema_version(con)
    if version > len(migrations):
        raise RuntimeError(
            f"Die Datenbank hat Schema-Version {version}, dieser Server kennt nur {len(migrations)}. "
            "Bitte einen neueren Server verwenden."
        )
    for number, name, sql in migrations:
        if number <= version:
            continue
        try:
            con.executescript(f"BEGIN IMMEDIATE;\n{sql}\nPRAGMA user_version = {number};\nCOMMIT;")
        except BaseException as exc:
            if con.in_transaction:
                con.execute("ROLLBACK")
            raise RuntimeError(f"Migration {name} ist fehlgeschlagen: {exc}") from exc
    return schema_version(con)


def seed_defaults(con: sqlite3.Connection) -> None:
    """Grundausstattung einer neuen Datenbank; ändert an einer bestehenden nichts.

    * ``dataset_id``: Kennung des Datenbestands (docs/sync-protokoll.md, „Sync-Aufruf")
    * Zähler ``rev`` und ``settings_rev``
    * die erste Zone und die Haushalts-Einstellungen
    """
    with transaction(con):
        con.execute("INSERT OR IGNORE INTO counters (name, value) VALUES ('rev', 0)")
        con.execute("INSERT OR IGNORE INTO counters (name, value) VALUES ('settings_rev', 0)")
        if get_meta(con, "dataset_id") is None:
            con.execute("INSERT INTO meta (key, value) VALUES ('dataset_id', ?)", (ids.new_uuid(),))

        if con.execute("SELECT 1 FROM settings LIMIT 1").fetchone() is not None:
            return

        stamp = timeutil.now()
        zone_id = con.execute("SELECT id FROM zones ORDER BY sort, name LIMIT 1").fetchone()
        if zone_id is None:
            first_zone = ids.new_uuid()
            con.execute(
                "INSERT INTO zones (id, name, icon, sort, created_at, updated_at, rev) VALUES (?, ?, ?, 0, ?, ?, ?)",
                (first_zone, DEFAULT_ZONE_NAME, DEFAULT_ZONE_ICON, stamp, stamp, next_rev(con)),
            )
        else:
            first_zone = str(zone_id[0])

        values = dict(DEFAULT_SETTINGS)
        values["primary_zone_id"] = first_zone
        for key, value in values.items():
            con.execute(
                "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
                (key, json.dumps(value), stamp),
            )
        con.execute("UPDATE counters SET value = ? WHERE name = 'settings_rev'", (next_rev(con),))


def initialise(path: Path) -> None:
    """Legt Verzeichnis und Datenbank an, migriert und stattet sie aus. Mehrfach aufrufbar."""
    path.parent.mkdir(parents=True, exist_ok=True)
    con = connect(path)
    try:
        migrate(con)
        seed_defaults(con)
    finally:
        con.close()
