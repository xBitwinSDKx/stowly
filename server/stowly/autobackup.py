"""Automatische, verschlüsselte Sicherung in einen Ordner auf dem Server (docs/integrationen.md, Abschnitt 3).

Ein Lauf, im eigenen Thread des Zeitplans:

1. **Kopie** der Datenbank in den Arbeitsspeicher (``sqlite3.Connection.backup`` in ``:memory:``),
   mit neuer ``dataset_id`` und ``PRAGMA integrity_check``. Unverschlüsselt berührt sie nie die Platte.
2. **Packen** mit gzip, 3. **Verschlüsseln** im binären Format von age an alle öffentlichen Schlüssel
   aus ``STOWLY_BACKUP_RECIPIENTS`` zugleich (``pyrage``). Jeder private Schlüssel öffnet die Datei allein.
4. **Schreiben** in eine Zwischendatei ``.stowly-backup-<16 Hex>.tmp`` (``O_CREAT | O_EXCL``, ``0600``,
   ``fsync``), 5. **Umbenennen** auf ``stowly-YYYY-MM-DD-HHMM.sqlite3.gz.age`` (Tag und Uhrzeit des
   Laufs in ``STOWLY_TIMEZONE``), unter Linux danach ``fsync`` des Ordners.
6. **Aufräumen** nach 7/4/12 (Tage, ISO-Wochen, Monate mit Sicherung), nur unter den eigenen Dateien.
7. **Merken** in ``job_runs``.

Scheitert ein Schritt, löscht der Lauf seine Zwischendatei, vermerkt einen kurzen deutschen Satz
ohne Geheimnisse und versucht es eine Stunde später erneut. Der Server kennt nur öffentliche
Schlüssel: Wer Server und Ordner erbeutet, kann die Sicherungen nicht lesen.
"""

import contextlib
import errno
import gzip
import logging
import os
import re
import secrets
import sqlite3
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import pyrage

from stowly import db, localtime, scheduler
from stowly.config import Settings
from stowly.contract import ids
from stowly.contract.timeutil import format_timestamp, parse_timestamp

log = logging.getLogger("stowly.backup")

JOB = "backup"
# Eigene Dateien erkennt der Server ausschließlich an diesen Mustern (docs/integrationen.md, 3.3 und 3.2).
OWN_FILE = re.compile(r"^stowly-([0-9]{4})-([0-9]{2})-([0-9]{2})-([0-9]{4})\.sqlite3\.gz\.age$")
OWN_TEMP = re.compile(r"^\.stowly-backup-[0-9a-f]{16}\.tmp$")
# Nach einem Fehler: der nächste Versuch.
RETRY_AFTER = timedelta(hours=1)
# Ohne gelungene Sicherung so lange, dann warnt die App.
WARN_AFTER = timedelta(hours=48)
# Aufbewahrung: so viele Tage, ISO-Wochen und Monate mit Sicherung.
KEEP_DAYS, KEEP_WEEKS, KEEP_MONTHS = 7, 4, 12

MISSING_DIR = "Der Ordner für Sicherungen fehlt."
NOT_WRITABLE = "Der Ordner für Sicherungen ist nicht beschreibbar (Benutzer 10001)."
DISK_FULL = "Auf der Platte ist kein Platz für die Sicherung."
NOT_CONSISTENT = "Die Kopie der Datenbank ist nicht stimmig."
NOT_ENCRYPTED = "Die Sicherung ließ sich nicht verschlüsseln."
NOT_WRITTEN = "Die Sicherung ließ sich nicht schreiben."
FAILED = "Die Sicherung ist fehlgeschlagen (Einzelheiten im Log des Servers)."


class BackupError(Exception):
    """Ein Lauf ist gescheitert; ``message`` ist der Satz für ``job_runs`` und die App."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def short_key(recipient: str) -> str:
    """Ein öffentlicher Schlüssel gekürzt: die ersten 8 Zeichen, „…", die letzten 4 (``age1ql3z…ac8p``)."""
    return f"{recipient[:8]}…{recipient[-4:]}"


def file_name(moment: datetime, tz: Any) -> str:
    """``stowly-YYYY-MM-DD-HHMM.sqlite3.gz.age``, Tag und Uhrzeit in der Zeitzone des Servers."""
    return f"stowly-{localtime.local(moment, tz):%Y-%m-%d-%H%M}.sqlite3.gz.age"


# --- 1. bis 3.: Kopie, Packen, Verschlüsseln ---------------------------------------------------


def integrity_problems(con: sqlite3.Connection) -> list[str]:
    """``PRAGMA integrity_check``: ``["ok"]``, wenn die Kopie stimmt."""
    return [str(row[0]) for row in con.execute("PRAGMA integrity_check")]


def snapshot(database_path: Path) -> bytes:
    """Eine in sich stimmige Kopie der Datenbank als Bytes, mit neuer ``dataset_id``.

    Die Kopie entsteht im Arbeitsspeicher und wird dort geprüft. Wird sie eingespielt, holen alle
    Geräte den Bestand vollständig neu (docs/sync-protokoll.md, 6.4).
    """
    if not database_path.is_file():
        # sqlite3.connect legte sonst stillschweigend eine leere Datenbank an.
        raise BackupError(FAILED)
    source = sqlite3.connect(str(database_path), timeout=10.0)
    try:
        copy = sqlite3.connect(":memory:", isolation_level=None)
        try:
            # Eine Kopie im Arbeitsspeicher braucht dieselbe Seitengröße wie das Original.
            page_size = int(source.execute("PRAGMA page_size").fetchone()[0])
            copy.execute(f"PRAGMA page_size = {page_size}")
            source.backup(copy)
            copy.execute(
                "INSERT INTO meta (key, value) VALUES ('dataset_id', ?) "
                "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                (ids.new_uuid(),),
            )
            problems = integrity_problems(copy)
            if problems != ["ok"]:
                log.error("Sicherung: Die Kopie ist nicht stimmig: %s", problems[:3])
                raise BackupError(NOT_CONSISTENT)
            image = bytearray(copy.serialize())
        finally:
            copy.close()
    finally:
        source.close()
    # Wie die Sicherung zum Herunterladen eine einzelne Datei ohne WAL: Die Bytes 18 und 19 des
    # Dateikopfs sagen 1 (Rollback-Journal, journal_mode = DELETE) statt 2 (WAL). Der Server stellt
    # beim Öffnen von selbst wieder auf WAL um.
    if image[18:20] == b"\x02\x02":
        image[18:20] = b"\x01\x01"
    return bytes(image)


def seal(data: bytes, recipients: list[str] | tuple[str, ...]) -> bytes:
    """Packt (gzip, ohne Zeitstempel) und verschlüsselt an alle Empfänger zugleich (age, binär)."""
    packed = gzip.compress(data, mtime=0)
    try:
        keys = [pyrage.x25519.Recipient.from_str(recipient) for recipient in recipients]
        return pyrage.encrypt(packed, keys)
    except Exception as exc:
        log.error("Sicherung: Verschlüsseln ist fehlgeschlagen (%s)", type(exc).__name__)
        raise BackupError(NOT_ENCRYPTED) from exc


# --- 4. und 5.: Schreiben und Umbenennen -------------------------------------------------------


def _os_problem(exc: OSError) -> str:
    if isinstance(exc, PermissionError) or exc.errno in (errno.EACCES, errno.EPERM, errno.EROFS):
        return NOT_WRITABLE
    if exc.errno in (errno.ENOSPC, getattr(errno, "EDQUOT", errno.ENOSPC)):
        return DISK_FULL
    if isinstance(exc, FileNotFoundError):
        return MISSING_DIR
    return NOT_WRITTEN


def remove_leftovers(directory: Path) -> list[str]:
    """Löscht liegengebliebene eigene Zwischendateien (nur das eigene Muster)."""
    removed: list[str] = []
    with contextlib.suppress(OSError):
        for entry in os.scandir(directory):
            if OWN_TEMP.fullmatch(entry.name) and entry.is_file(follow_symlinks=False):
                try:
                    os.unlink(entry.path)
                except OSError:
                    log.warning("Sicherung: Die Zwischendatei %s ließ sich nicht löschen", entry.name)
                else:
                    removed.append(entry.name)
    return removed


def _fsync_directory(directory: Path) -> None:
    """Unter Linux: Das Umbenennen steht erst nach einem ``fsync`` des Ordners sicher auf der Platte."""
    if os.name != "posix":
        return
    handle = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(handle)
    finally:
        os.close(handle)


def write_file(directory: Path, name: str, data: bytes) -> Path:
    """Schreibt ``data`` über eine Zwischendatei (0600, ``fsync``) und benennt sie dann um.

    In der Zwischendatei steht von Anfang an nur, was ``data`` ist, also Verschlüsseltes. Scheitert
    etwas, ist sie wieder weg. Gibt es den Namen schon, ersetzt die neue Datei die alte.
    """
    temp = directory / f".stowly-backup-{secrets.token_hex(8)}.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
    try:
        handle = os.open(temp, flags, 0o600)
    except OSError as exc:
        raise BackupError(_os_problem(exc)) from exc
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        target = directory / name
        os.replace(temp, target)
    except OSError as exc:
        with contextlib.suppress(OSError):
            os.unlink(temp)
        raise BackupError(_os_problem(exc)) from exc
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(temp)
        raise
    try:
        _fsync_directory(directory)
    except OSError:
        log.warning("Sicherung: fsync des Ordners ist fehlgeschlagen", exc_info=True)
    return target


# --- 6.: Rotation ------------------------------------------------------------------------------


@dataclass(frozen=True, order=True)
class OwnFile:
    day: date
    hhmm: str
    name: str


def own_files(directory: Path) -> list[OwnFile]:
    """Die eigenen Sicherungen im Ordner, älteste zuerst. Andere Dateien gehen den Server nichts an.

    Grundlage ist das Datum im Namen, nicht das Änderungsdatum. Ein Name nach dem Muster, aber ohne
    gültigen Tag oder gültige Uhrzeit, bleibt unangetastet.
    """
    found: list[OwnFile] = []
    for entry in os.scandir(directory):
        match = OWN_FILE.fullmatch(entry.name)
        if match is None or not entry.is_file(follow_symlinks=False):
            continue
        year, month, day, hhmm = match.groups()
        try:
            stamp = date(int(year), int(month), int(day))
        except ValueError:
            continue
        if int(hhmm[:2]) > 23 or int(hhmm[2:]) > 59:
            continue
        found.append(OwnFile(stamp, hhmm, entry.name))
    return sorted(found)


def keep(files: list[OwnFile]) -> set[str]:
    """Was die Rotation behält: die neueste Datei jedes der 7 neuesten Tage, 4 neuesten ISO-Wochen und
    12 neuesten Monate, in denen es eine Sicherung gibt (vereinigt)."""
    kept: set[str] = set()
    for period, count in (
        (lambda f: f.day, KEEP_DAYS),
        (lambda f: f.day.isocalendar()[:2], KEEP_WEEKS),
        (lambda f: (f.day.year, f.day.month), KEEP_MONTHS),
    ):
        newest: dict[Any, OwnFile] = {}
        for item in files:  # aufsteigend: die letzte je Zeitraum ist die neueste
            newest[period(item)] = item
        for key in sorted(newest, reverse=True)[:count]:
            kept.add(newest[key].name)
    return kept


def rotate(directory: Path, written: str) -> list[str]:
    """Löscht die eigenen Dateien, die die Rotation nicht behält; die eben geschriebene bleibt immer."""
    files = own_files(directory)
    kept = keep(files) | {written}
    removed: list[str] = []
    for item in files:
        if item.name in kept:
            continue
        try:
            os.unlink(directory / item.name)
        except OSError:
            log.warning("Sicherung: %s ließ sich beim Aufräumen nicht löschen", item.name)
        else:
            removed.append(item.name)
    return removed


# --- Ein Lauf ----------------------------------------------------------------------------------


@dataclass(frozen=True)
class Result:
    file: str
    size: int
    removed: list[str]


def create(settings: Settings, now: datetime) -> Result:
    """Eine Sicherung, Schritte 1 bis 6. ``BackupError`` mit dem Satz für die App, wenn etwas scheitert."""
    directory = settings.backup_dir
    if directory is None or not settings.backup_recipients:
        raise BackupError(FAILED)
    # Den Ordner legt der Server nicht an: Er läge sonst womöglich im Container statt auf dem Laufwerk.
    if not directory.is_dir():
        raise BackupError(MISSING_DIR)
    if os.name == "posix" and not os.access(directory, os.W_OK | os.X_OK):
        raise BackupError(NOT_WRITABLE)
    remove_leftovers(directory)
    sealed = seal(snapshot(settings.database_path), settings.backup_recipients)
    name = file_name(now, settings.tz)
    write_file(directory, name, sealed)
    try:
        removed = rotate(directory, name)
    except OSError:
        # Die Sicherung steht; aufgeräumt wird beim nächsten Lauf.
        log.warning("Sicherung: Aufräumen ist fehlgeschlagen", exc_info=True)
        removed = []
    return Result(file=name, size=len(sealed), removed=removed)


def run_backup(settings: Settings, now: datetime) -> bool:
    """Ein Lauf samt Vermerk in ``job_runs``; liefert, ob er gelang. Wirft nie wegen der Sicherung selbst."""
    try:
        result = create(settings, now)
    except BackupError as exc:
        log.error("Sicherung fehlgeschlagen: %s Nächster Versuch in einer Stunde.", exc.message)
        _remember_failure(settings, now, exc.message)
        return False
    except Exception:
        log.exception("Sicherung fehlgeschlagen. Nächster Versuch in einer Stunde.")
        _remember_failure(settings, now, FAILED)
        return False
    log.info(
        "Sicherung geschrieben: %s (%d Byte, %d Schlüssel)%s",
        result.file,
        result.size,
        len(settings.backup_recipients),
        f", aufgeräumt: {', '.join(result.removed)}" if result.removed else "",
    )
    con = db.connect(settings.database_path)
    try:
        scheduler.record_success(
            con,
            JOB,
            day=localtime.today(now, settings.tz).isoformat(),
            at=format_timestamp(now),
            state={
                "file": result.file,
                "size": result.size,
                "recipients": [short_key(recipient) for recipient in settings.backup_recipients],
            },
        )
    finally:
        con.close()
    return True


def _remember_failure(settings: Settings, now: datetime, message: str) -> None:
    con = db.connect(settings.database_path)
    try:
        scheduler.record_failure(con, JOB, at=format_timestamp(now), error=message)
    finally:
        con.close()


class BackupJob:
    """Die Aufgabe ``backup`` des Zeitplans: täglich ab ``STOWLY_BACKUP_TIME``, nach einem Fehler stündlich."""

    name = JOB

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def due(self, run: scheduler.JobRun, now: datetime) -> bool:
        settings = self.settings
        if not settings.backup_configured:
            return False
        if not scheduler.daily_due(run, now, settings.tz, settings.backup_time):
            return False
        later = retry_at(run, now)
        return later is None or now >= later

    def run(self, now: datetime) -> None:
        run_backup(self.settings, now)


def retry_at(run: scheduler.JobRun, now: datetime) -> datetime | None:
    """Nach einem Fehler: der Zeitpunkt des nächsten Versuchs, eine Stunde später.

    Liegt der Fehler in der Zukunft (die Uhr des Servers wurde zurückgestellt), zählt er nicht:
    Sonst ruhte die Sicherung, bis die Uhr ihn wieder eingeholt hat.
    """
    if run.last_error is None or run.last_error_at is None:
        return None
    later = parse_timestamp(run.last_error_at) + RETRY_AFTER
    return None if later - now > RETRY_AFTER else later


# --- Zustand für die App -----------------------------------------------------------------------


def next_attempt(settings: Settings, run: scheduler.JobRun, now: datetime) -> datetime:
    """Der nächste geplante Versuch (docs/integrationen.md, 3.6), so wie der Zeitplan ihn nimmt.

    Heute zur Uhrzeit, wenn sie noch kommt und heute noch nichts lief; nach einem Fehler eine Stunde
    später; sonst morgen zur Uhrzeit, über die Zeitumstellung richtig umgerechnet. Ist ein Versuch
    schon jetzt fällig (etwa nach einem Ausfall), ist es jetzt.
    """
    tz = settings.tz
    day = localtime.today(now, tz)
    if scheduler.ran_today(run, now, tz):
        day = localtime.next_day(day)
    later = retry_at(run, now)
    candidate = now
    for _attempt in range(3):
        candidate = max(localtime.first_moment(day, settings.backup_time, tz), now)
        if later is not None and later > candidate:
            candidate = later
        if localtime.today(candidate, tz) == day:
            return candidate
        # Der Versuch fiele auf den nächsten Tag: Dort gilt wieder die Uhrzeit.
        day = localtime.today(candidate, tz)
    return candidate


def status(settings: Settings, run: scheduler.JobRun, now: datetime) -> dict[str, Any]:
    """``BackupStatus`` für ``GET /api/integrations``. Öffentliche Schlüssel nur gekürzt."""
    configured = settings.backup_configured
    last_ok_at = run.last_at if run.last_date is not None else None
    state = run.state if last_ok_at is not None else {}
    last_ok = None if last_ok_at is None else parse_timestamp(last_ok_at)
    warning = configured and (
        (last_ok is not None and now - last_ok > WARN_AFTER)
        or (last_ok is None and run.last_error is not None)
    )
    size = state.get("size")
    return {
        "configured": configured,
        "problem": settings.backup_problem,
        "time": settings.backup_time if settings.backup_mentioned else None,
        "recipients": [short_key(recipient) for recipient in settings.backup_recipients],
        "last_ok_at": last_ok_at,
        "last_file": state.get("file") if isinstance(state.get("file"), str) else None,
        "last_size": size if isinstance(size, int) and not isinstance(size, bool) and size >= 0 else None,
        "last_error": run.last_error,
        "last_error_at": run.last_error_at,
        "next_at": format_timestamp(next_attempt(settings, run, now)) if configured else None,
        "warning": bool(warning),
    }
