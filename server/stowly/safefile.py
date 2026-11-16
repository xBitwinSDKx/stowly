"""Dateien sicher schreiben: atomar und mit festen Rechten.

Für alles, was Stowly neben der Datenbank im Datenordner ablegt und was in keiner Sicherung steht:
``/data/tls`` (CA, Zertifikat), ``/data/secrets`` (Token von Home Assistant, Sensor-Token) und
``/data/restore`` (eine Sicherung beim Zurückspielen). Nach dem Muster von ``autobackup.write_file``.
"""

import contextlib
import logging
import os
import secrets
import stat
import time
from pathlib import Path

log = logging.getLogger("stowly.files")

POSIX = os.name == "posix"
# os.replace scheitert unter Windows kurz, solange ein anderer Prozess (Virenscanner, Indexer) die
# Zieldatei offen hält. Unter Linux kommt das nicht vor.
_REPLACE_TRIES = 5
_REPLACE_PAUSE_S = 0.05


def write_atomic(directory: Path, name: str, data: bytes, mode: int) -> None:
    """Schreibt ``directory/name`` atomar: Zwischendatei mit ``mode`` von Anfang an, ``fsync``,
    ``os.replace``, ``fsync`` des Ordners. Scheitert etwas, ist die Zwischendatei wieder weg."""
    temp = directory / f".{name}.{secrets.token_hex(6)}.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
    handle = os.open(temp, flags, mode)
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if POSIX:
            os.chmod(temp, mode)  # die umask hätte beim Anlegen Rechte wegnehmen können
        _replace(temp, directory / name)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(temp)
        raise
    sync_directory(directory)


def _replace(source: Path, target: Path) -> None:
    for attempt in range(_REPLACE_TRIES):
        try:
            os.replace(source, target)
            return
        except PermissionError:
            if POSIX or attempt + 1 == _REPLACE_TRIES:
                raise
            time.sleep(_REPLACE_PAUSE_S)


def sync_directory(directory: Path) -> None:
    """``fsync`` des Ordners (nur POSIX), damit eine Umbenennung einen Absturz übersteht."""
    if not POSIX:
        return
    folder = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(folder)
    except OSError:
        log.warning("fsync des Ordners %s ist fehlgeschlagen", directory.name, exc_info=True)
    finally:
        os.close(folder)


def ensure_mode(path: Path, mode: int, *, label: str = "Datei") -> None:
    """Nur unter POSIX: setzt die Rechte, wenn sie anders sind (etwa bei einer von Hand gelegten Datei)."""
    if not POSIX:
        return
    try:
        current = stat.S_IMODE(os.stat(path).st_mode)
        if current != mode:
            os.chmod(path, mode)
            log.info(
                "%s: Rechte von %s auf %s gesetzt (vorher %s).", label, path.name, oct(mode), oct(current)
            )
    except OSError:
        log.warning("%s: Die Rechte von %s ließen sich nicht setzen.", label, path.name, exc_info=True)


def ensure_directory(path: Path, mode: int = 0o700, *, label: str = "Datei") -> None:
    """Legt einen Ordner an (samt Eltern) und setzt seine Rechte auf ``mode``."""
    path.mkdir(mode=mode, parents=True, exist_ok=True)
    ensure_mode(path, mode, label=label)
