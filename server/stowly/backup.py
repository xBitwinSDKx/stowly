"""Manuelle Sicherung: eine in sich stimmige Kopie der ganzen Datenbank.

``sqlite3.Connection.backup`` kopiert einen Schnappschuss, während der Server weiterläuft.
Die **Kopie** bekommt eine neue ``dataset_id``: Wird sie später eingespielt (Server
anhalten, Datei ersetzen, starten), antwortet der Server allen Geräten mit ``reset: true``;
sie holen den Bestand vollständig neu und senden ihre Outbox erneut. Befehle, die schon
in der Sicherung stecken, erkennt der Server als bekannt (docs/sync-protokoll.md, Abschnitt 11).
"""

import contextlib
import logging
import os
import sqlite3
import tempfile
import time
from pathlib import Path

from stowly.contract import ids

log = logging.getLogger("stowly.backup")

_PREFIX = "stowly-backup-"
_SUFFIX = ".sqlite3"
# Liegengebliebene Kopien (Abbruch mitten im Download) verschwinden nach dieser Zeit.
_STALE_AFTER_S = 3600


def remove_file(path: Path) -> None:
    """Löscht eine temporäre Kopie samt Begleitdateien; fehlende Dateien stören nicht."""
    for candidate in (path, Path(f"{path}-wal"), Path(f"{path}-shm"), Path(f"{path}-journal")):
        with contextlib.suppress(OSError):
            candidate.unlink()


def remove_stale_files(directory: Path | None = None) -> None:
    """Räumt Kopien weg, die ein abgebrochener Download hinterlassen hat."""
    directory = Path(tempfile.gettempdir()) if directory is None else directory
    limit = time.time() - _STALE_AFTER_S
    with contextlib.suppress(OSError):
        for candidate in directory.glob(f"{_PREFIX}*{_SUFFIX}*"):
            with contextlib.suppress(OSError):
                if candidate.stat().st_mtime < limit:
                    candidate.unlink()


def create(database_path: Path) -> Path:
    """Schreibt die Sicherung in eine temporäre Datei und liefert deren Pfad.

    Der Aufrufer löscht die Datei (``remove_file``), sobald sie ausgeliefert ist.
    """
    if not database_path.is_file():
        # sqlite3.connect legte sonst stillschweigend eine leere Datenbank an.
        raise FileNotFoundError(f"Die Datenbank {database_path} gibt es nicht.")
    remove_stale_files()
    handle, name = tempfile.mkstemp(prefix=_PREFIX, suffix=_SUFFIX)
    os.close(handle)  # unter Windows darf die Datei nicht offen bleiben
    target = Path(name)
    try:
        source = sqlite3.connect(str(database_path), timeout=10.0)
        try:
            copy = sqlite3.connect(str(target), isolation_level=None)
            try:
                source.backup(copy)
                # Eine einzelne Datei ohne Begleitdateien: kein WAL in der Kopie.
                copy.execute("PRAGMA journal_mode = DELETE")
                copy.execute(
                    "INSERT INTO meta (key, value) VALUES ('dataset_id', ?) "
                    "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                    (ids.new_uuid(),),
                )
                problems = [row[0] for row in copy.execute("PRAGMA integrity_check")]
                if problems != ["ok"]:
                    raise RuntimeError(f"Die Sicherung ist nicht stimmig: {problems[:3]}")
            finally:
                copy.close()
        finally:
            source.close()
    except BaseException:
        remove_file(target)
        raise
    return target
