"""Eine Sicherung zurückspielen (docs/sync-protokoll.md, 11.9; docs/plan-einrichtung-b.md, Abschnitt 2).

Drei Schritte in der App, dann ein Neustart. Alles liegt in ``/data/restore`` (0700, Dateien 0600):

1. **Hochladen** (``PUT /api/restore/upload``): die Rohdaten nach ``upload-<id>``, höchstens
   ``RESTORE_MAX_BYTES``, nur bei dreifach freiem Platz, mit Zeitgrenzen (``UPLOAD_IDLE_S`` ohne Daten,
   ``UPLOAD_TOTAL_S`` insgesamt). Die Art (age, gzip, SQLite) erkennt Stowly an den ersten Bytes.
2. **Prüfen** (``POST /api/restore/check``): entschlüsseln (age; der geheime Schlüssel lebt nur im
   Arbeitsspeicher und steht nie in einer Antwort oder im Log), entpacken (höchstens 2 GiB), prüfen und in
   einer Kopie migrieren: der fertige Kandidat ``candidate-<id>.sqlite3``. Geprüft wird der Reihe nach:
   ``quick_check``, ``application_id`` („STOW" oder 0), ``user_version`` (1 bis N), der Aufbau Zeichen für
   Zeichen wie aus den Migrationen (keine Trigger oder Views unter welchem Namen auch immer, keine fremden
   Tabellen), ``integrity_check``, ``foreign_key_check``. Im Kandidaten fallen dann Statistiktabellen und
   Bilder in fremden Typen weg, und offene Kopplungen eines Pi gelten als abgebrochen. Jede Verbindung zu
   einer Sicherung oder ihrer Kopie läuft ohne Trigger und Views (``_harden``).
3. **Anwenden** (``POST /api/restore/apply``): das Passwort prüfen, den Kandidaten als ``pending.sqlite3``
   mit ``pending.json`` bereitlegen und neu starten.

Eine hochgeladene Datei und ein Kandidat gelten 30 Minuten; ein neuer ersetzt den alten erst, wenn er
gelungen ist. Abgelaufenes räumt ``RestoreManager.sweep`` regelmäßig weg, auch ohne neuen Aufruf.

**Tausch** (``resume``) im frisch gestarteten Prozess, bevor etwas die Datenbank öffnet:

1. Den Kandidaten prüfen (sha256, ``quick_check``, Version).
2. Die laufende Datenbank checkpointen und auf ``journal_mode = DELETE`` stellen; das gelingt nur ohne
   offene Verbindung. Danach gibt es kein ``-wal`` mehr, das SQLite einer neuen Datei unterschieben könnte.
3. In einer Kopie (``swap.sqlite3``): die Zugänge des laufenden Stowly übernehmen (Geräte, Passwort-Hash,
   VAPID-Schlüssel samt Abos, ``server_config``, ``job_runs``), Kennungen jüngerer Pakete reservieren, neue
   ``dataset_id``, Ereignis ``server.restored``.
4. Die alte Datenbank als ``previous.next.sqlite3`` festhalten (``os.link``, sonst Kopie), dann die Kopie an
   den Platz der Datenbank (``os.replace``): der Punkt ohne Wiederkehr. Zuletzt ``previous.sqlite3``,
   ``last.json`` und Aufräumen.

Jeder Schritt lässt sich nach einem Absturz wiederholen; ob der Tausch schon geschah, zeigt die
``dataset_id`` der Datenbank. Ein Fehler davor behält die alte Datenbank, merkt ``failed`` und startet
normal, ohne Neustart-Schleife. „Rückgängig" spielt ``previous.sqlite3`` über denselben Tausch zurück.
"""

import contextlib
import functools
import hashlib
import itertools
import json
import logging
import math
import os
import re
import secrets
import shutil
import sqlite3
import threading
import time
import zlib
from collections import deque
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import MappingProxyType
from typing import Any, BinaryIO

import pyrage

from stowly import (
    auth,
    db,
    events,
    haconfig,
    label_templates,
    off,
    push,
    records,
    safefile,
    serverconfig,
    updates,
)
from stowly.config import Settings
from stowly.contract import ids
from stowly.contract.api import (
    RESTORE_ID_TTL_S,
    RESTORE_MAX_BYTES,
    RESTORE_UNDO_DAYS,
    ErrorCode,
    PortSource,
    RestoreKind,
    RestoreState,
    SetupStepId,
    UpdateState,
)
from stowly.contract.limits import LIMITS
from stowly.contract.timeutil import format_timestamp, is_timestamp, parse_timestamp
from stowly.errors import ApiError

log = logging.getLogger("stowly.restore")

FOLDER = "restore"
PENDING_DB = "pending.sqlite3"
PENDING_MANIFEST = "pending.json"
SWAP_DB = "swap.sqlite3"
PREVIOUS_DB = "previous.sqlite3"
PREVIOUS_NEXT = "previous.next.sqlite3"
LAST = "last.json"
_UPLOAD_NAME = re.compile(r"^upload-[0-9a-f]{32}$")
_WORK_NAME = re.compile(r"^(work|candidate)-[0-9a-f]{32}\.sqlite3(-journal)?$")

# „STOW" (Migration 0005); ältere Datenbanken haben 0.
APPLICATION_ID = 0x53544F57
UNPACKED_MAX = 2 * 1024 * 1024 * 1024
# Größer ist kein Text, den Stowly schreibt (eine Anfrage hat höchstens 4 MiB): Die Prüfung der Texte lädt
# ihn gar nicht erst und lehnt die Sicherung als beschädigt ab (text_problem).
MAX_TEXT_BYTES = 16 * 1024 * 1024
# So tief verschachtelt schreibt Stowly nie: Seine tiefsten JSON-Werte (Gestaltung der Etiketten, Befehle,
# Ereignisse) haben vier, fünf Ebenen. 64 lässt viel Spielraum und bleibt weit unter dem, woran die Parser
# scheitern (json.loads an der Rekursionsgrenze von etwa 1000, pydantic bei 200).
MAX_JSON_DEPTH = 64
ID_TTL = timedelta(seconds=RESTORE_ID_TTL_S)
UNDO_FOR = timedelta(days=RESTORE_UNDO_DAYS)
# Ein bereitgelegtes Zurückspielen gilt nur so lange nach dem Anwenden; danach verwirft der Start es.
PENDING_FOR = timedelta(minutes=10)
# Eigene Bremse: eins zugleich, höchstens so viele Schritte (Hochladen, Prüfen) im Fenster.
WINDOW = timedelta(minutes=10)
WINDOW_MAX = 6
BUSY_RETRY_S = 5
# So viel freien Platz braucht es: das Dreifache der hochgeladenen Datei.
SPACE_FACTOR = 3
# Beim Entpacken bleibt mindestens so viel frei; geprüft wird alle SPACE_CHECK_EVERY Byte.
MIN_FREE = 64 * 1024 * 1024
SPACE_CHECK_EVERY = 64 * 1024 * 1024
CHUNK = 1024 * 1024
OUT_CHUNK = 256 * 1024
# Bevor die Art feststeht, so viele Byte sammeln (oder bis zum Ende der Datei).
SNIFF_BYTES = 64
# Hochladen (api/restore.py): Kommen so lange keine Daten oder dauert es insgesamt länger, bricht Stowly ab
# (408) und räumt auf. Sonst hielte ein stockendes Hochladen jeden Schritt und jedes Update auf.
UPLOAD_IDLE_S = 60
UPLOAD_TOTAL_S = 20 * 60
# So oft räumt Stowly auch ohne Aufruf auf (``RestoreManager.sweep`` im lifespan der App).
SWEEP_EVERY_S = 300

AGE_BINARY = b"age-encryption.org/v1\n"
AGE_ARMOR = b"-----BEGIN AGE ENCRYPTED FILE-----"
GZIP_MAGIC = b"\x1f\x8b"
SQLITE_MAGIC = b"SQLite format 3\x00"
# Statistiktabellen von SQLite (ANALYZE) gehören nicht zum Aufbau. Stowly selbst ruft weder ANALYZE noch
# PRAGMA optimize auf; stehen sie in einer Sicherung, hat sie jemand von Hand angelegt. Zulässig sind sie nur,
# wie SQLite sie anlegt (eine Tabelle mit genau dieser SQL), und im Kandidaten fallen sie weg.
STAT_TABLES: Mapping[str, str] = MappingProxyType(
    {
        "sqlite_stat1": "CREATE TABLE sqlite_stat1(tbl,idx,stat)",
        "sqlite_stat4": "CREATE TABLE sqlite_stat4(tbl,idx,neq,nlt,ndlt,sample)",
    }
)
# Was SQLite beim Laden des Aufbaus als Trigger oder View liest: Es richtet sich nach der SQL, nicht nach
# der Spalte ``type``.
_TRIGGER_OR_VIEW_SQL = re.compile(r"\s*create\s+(?:temp(?:orary)?\s+)?(?:trigger|view)\b", re.IGNORECASE)
# Was ein laufender Stowly behält (Plan, Abschnitt 2): so wird niemand abgemeldet. Ausnahme in
# server_config: der Merker ``ha_links_entity`` gehört zu ``ha_links`` und kommt mit der Sicherung.
TAKEN_OVER_TABLES = ("devices", "push_subscriptions", "server_config", "job_runs")
TAKEN_OVER_META = (auth.PASSWORD_HASH, push.VAPID_PRIVATE, push.VAPID_PUBLIC)

# --- Meldungen ----------------------------------------------------------------------------------

NOT_AT_HOME = (
    "Beim ersten Start lässt sich eine Sicherung nur im Heimnetz zurückspielen: Stowly über seine IP-Adresse "
    "oder seinen lokalen Namen öffnen (etwa http://192.168.1.10:8010)."
)
BUSY = "Gerade läuft schon ein Schritt des Zurückspielens. Bitte gleich noch einmal versuchen."
PENDING = "Eine Sicherung ist schon bereitgelegt; Stowly startet gleich neu."
UPDATE_RUNNING = "Gerade läuft ein Update. Zurückspielen geht erst danach."
BLOCKS_UPDATE = "Gerade wird eine Sicherung zurückgespielt. Ein Update geht erst danach."
BLOCKS_FIRST_PASSWORD = "Gerade wird eine Sicherung zurückgespielt; Stowly startet gleich neu."
EMPTY = "Die Datei ist leer."
UNKNOWN_FORMAT = "Das ist keine Sicherung von Stowly (erwartet: .sqlite3.gz.age, .sqlite3.gz oder .sqlite3)."
TOO_LARGE = f"Die Datei ist zu groß (höchstens {RESTORE_MAX_BYTES // (1024 * 1024)} MiB)."
UPLOAD_IDLE = (
    f"Beim Hochladen kamen {UPLOAD_IDLE_S} Sekunden lang keine Daten; Stowly hat abgebrochen. Bitte noch "
    "einmal hochladen."
)
UPLOAD_TOO_SLOW = (
    f"Das Hochladen dauerte länger als {UPLOAD_TOTAL_S // 60} Minuten; Stowly hat abgebrochen. Bitte noch "
    "einmal hochladen, am besten im Heimnetz."
)
UNPACKED_TOO_LARGE = "Entpackt wäre die Datenbank größer als 2 GiB."
UPLOAD_UNKNOWN = "Die hochgeladene Datei ist abgelaufen oder unbekannt. Bitte noch einmal hochladen."
CANDIDATE_UNKNOWN = "Die geprüfte Sicherung ist abgelaufen oder unbekannt. Bitte noch einmal prüfen."
KEY_MISSING = "Für diese verschlüsselte Sicherung braucht es den geheimen Schlüssel (AGE-SECRET-KEY-1…)."
PUBLIC_GIVEN = "Das ist der öffentliche Schlüssel (age1…). Zum Zurückspielen braucht es den geheimen (AGE-SECRET-KEY-1…)."
NOT_A_KEY = "Das ist kein geheimer age-Schlüssel (AGE-SECRET-KEY-1…)."
WRONG_KEY = "Der Schlüssel passt nicht zu dieser Sicherung."
DAMAGED = "Die Datei ist beschädigt oder unvollständig."
DAMAGED_DATABASE = "Die Datenbank in der Sicherung ist beschädigt."
INVALID_TEXT = "Die Datenbank in der Sicherung ist beschädigt: Sie enthält Text, der kein gültiges UTF-8 ist."
TEXT_TOO_LARGE = f"Die Datenbank in der Sicherung ist beschädigt: Sie enthält einen Text über {MAX_TEXT_BYTES // (1024 * 1024)} MiB."
JSON_TOO_DEEP = "Die Datenbank in der Sicherung ist beschädigt: Sie enthält zu tief verschachtelte Daten."
NOT_STOWLY = "Das ist keine Datenbank von Stowly."
FOREIGN_SCHEMA = "Der Aufbau der Datenbank weicht von dem einer Datenbank von Stowly ab."
TRIGGERS = "Die Datenbank enthält Trigger oder Views; eine Sicherung von Stowly hat keine."
MIGRATION_FAILED = (
    "Die Sicherung ließ sich nicht auf den Stand dieses Stowly bringen (Einzelheiten im Log des Servers)."
)
WRONG_PASSWORD = "Das Passwort stimmt nicht."
WRONG_BACKUP_PASSWORD = "Das Passwort stimmt nicht mit dem aus der Sicherung überein."
PASSWORD_SET_MEANWHILE = "Inzwischen gibt es ein Passwort. Bitte damit anmelden und dann zurückspielen."
DEVICE_NAME_MISSING = "Beim ersten Start braucht es einen Namen für dieses Gerät."
NO_RESTART = "Stowly kann sich hier nicht selbst neu starten."
NOTHING_TO_UNDO = "Es gibt nichts rückgängig zu machen."
NOT_PREPARED = "Die Sicherung ließ sich nicht bereitlegen (Einzelheiten im Log des Servers)."

PENDING_MESSAGE = "Stowly startet neu und spielt die Sicherung ein."
DONE_MESSAGE = "Die Sicherung ist zurückgespielt. Alle Geräte laden den Bestand neu."
UNDONE_MESSAGE = "Das Zurückspielen ist rückgängig gemacht. Alle Geräte laden den Bestand neu."
TOO_LATE = "Der Neustart kam zu spät (mehr als 10 Minuten nach dem Anwenden)."
CHANGED = "Die bereitgelegte Sicherung ist verändert oder unvollständig."
STILL_OPEN = "Die Datenbank war beim Neustart noch geöffnet."
NOT_TAKEN_OVER = "Die Zugänge ließen sich nicht stimmig übernehmen."
UNEXPECTED = "Ein unerwarteter Fehler trat auf (Einzelheiten im Log des Servers)."
NO_SPACE_ON_SWAP = "Auf der Platte war zu wenig Platz."


def _failed(reason: str) -> str:
    return f"Das Zurückspielen ist gescheitert: {reason} Die bisherige Datenbank läuft weiter."


def refused(reason: str, message: str) -> ApiError:
    """422 mit ``details.reason`` (docs/sync-protokoll.md, 11.9)."""
    return ApiError(422, ErrorCode.INVALID_REQUEST, message, {"reason": reason})


def _no_space(needed: int) -> ApiError:
    megabytes = max(1, math.ceil(needed / (1024 * 1024)))
    return ApiError(
        409, ErrorCode.CONFLICT, f"Auf der Platte ist zu wenig Platz: Nötig sind etwa {megabytes} MB frei."
    )


def _invalid(field: str, message: str, kind: str) -> ApiError:
    return ApiError(
        422,
        ErrorCode.INVALID_REQUEST,
        "Die Anfrage entspricht nicht dem Vertrag.",
        {"errors": [{"loc": ["body", field], "msg": message, "type": kind}]},
    )


def new_id() -> str:
    """128 Bit, hex: ``upload_id`` und ``restore_id``."""
    return secrets.token_hex(16)


def _same(known: str, given: str) -> bool:
    """Vergleicht eine Kennung in konstanter Zeit: Beim ersten Start ist sie der einzige Ausweis."""
    return secrets.compare_digest(known.encode(), given.encode())


def folder_of(settings: Settings) -> Path:
    return settings.data_dir / FOLDER


def ensure_folder(settings: Settings) -> Path:
    folder = folder_of(settings)
    safefile.ensure_directory(folder, 0o700, label="Zurückspielen")
    return folder


def _remove(*paths: Path) -> None:
    for path in paths:
        for candidate in (path, Path(f"{path}-journal")):
            with contextlib.suppress(FileNotFoundError):
                candidate.unlink()


def _replace(source: Path, target: Path) -> None:
    """``os.replace``; unter Windows mit ein paar Versuchen, falls ein Virenscanner die Datei kurz hält."""
    for attempt in range(5):
        try:
            os.replace(source, target)
            return
        except PermissionError:
            if safefile.POSIX or attempt == 4:
                raise
            time.sleep(0.05)


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _copy(source: Path, target: Path) -> None:
    """Kopiert in eine neue Datei (0600) und schreibt sie fest (``fsync``)."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
    handle = os.open(target, flags, 0o600)
    try:
        with os.fdopen(handle, "wb") as out, source.open("rb") as stream:
            shutil.copyfileobj(stream, out, CHUNK)
            out.flush()
            os.fsync(out.fileno())
    except BaseException:
        _remove(target)
        raise


def _link_or_copy(source: Path, target: Path) -> None:
    """Ein zweiter Name für dieselbe Datei (``os.link``); geht das nicht (anderes Dateisystem, kein Hardlink),
    eine Kopie mit ``fsync``."""
    _remove(target)
    try:
        os.link(source, target)
    except OSError:
        log.info("Zurückspielen: Kein Hardlink möglich, %s wird kopiert.", source.name)
        _copy(source, target)


def _fsync(path: Path) -> None:
    # Unter Windows braucht fsync einen Griff mit Schreibrecht; unter Linux schadet er nicht.
    handle = os.open(path, os.O_RDWR | getattr(os, "O_BINARY", 0))
    try:
        os.fsync(handle)
    except OSError:
        log.warning("Zurückspielen: fsync von %s ist fehlgeschlagen", path.name, exc_info=True)
    finally:
        os.close(handle)


def _write_json(folder: Path, name: str, value: dict[str, Any]) -> None:
    data = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
    safefile.write_atomic(folder, name, data, 0o600)


def _read_json(path: Path) -> dict[str, Any] | None:
    """Eine kleine JSON-Datei; ``None``, wenn sie fehlt oder kein Objekt enthält."""
    try:
        with path.open("rb") as stream:
            value = json.loads(stream.read(64 * 1024))
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        log.warning("Zurückspielen: %s lässt sich nicht lesen", path.name)
        return None
    return value if isinstance(value, dict) else None


def _timestamp(value: Any) -> datetime | None:
    return parse_timestamp(value) if isinstance(value, str) and is_timestamp(value) else None


# --- Art erkennen und entpacken ------------------------------------------------------------------


def kind_of(head: bytes) -> RestoreKind | None:
    """Die Art einer Datei an ihren ersten Bytes; ``None``, wenn es keine Sicherung sein kann."""
    if head.startswith(AGE_BINARY) or head.startswith(AGE_ARMOR):
        return RestoreKind.AGE
    if head.startswith(GZIP_MAGIC):
        return RestoreKind.GZIP
    if head.startswith(SQLITE_MAGIC):
        return RestoreKind.SQLITE
    return None


def parse_identities(text: str | None) -> list[pyrage.x25519.Identity]:
    """Die geheimen Schlüssel aus dem Text (auch dem Inhalt einer Schlüsseldatei von ``age-keygen``): je Zeile
    einer, Zeilen mit ``#`` und leere zählen nicht. 422 ``not_a_key``; der Schlüssel steht nie in der Meldung."""
    found: list[pyrage.x25519.Identity] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.lower().startswith("age1"):
            raise refused("not_a_key", PUBLIC_GIVEN)
        try:
            found.append(pyrage.x25519.Identity.from_str(line))
        except Exception:
            raise refused("not_a_key", NOT_A_KEY) from None
    if not found:
        raise refused("not_a_key", KEY_MISSING)
    return found


class _TooLarge(Exception):
    pass


class _NoSpace(Exception):
    pass


class _Damaged(Exception):
    pass


class _Foreign(Exception):
    pass


class _Sink:
    """Schreibt die entpackte Datenbank; zählt mit und hält die Grenzen ein (2 GiB, Platz auf der Platte)."""

    def __init__(self, stream: BinaryIO, folder: Path, limit: int) -> None:
        self.stream = stream
        self.folder = folder
        self.limit = limit
        self.written = 0
        self._check_at = SPACE_CHECK_EVERY

    def write(self, data: bytes) -> int:
        self.written += len(data)
        if self.written > self.limit:
            raise _TooLarge
        if self.written >= self._check_at:
            self._check_at += SPACE_CHECK_EVERY
            if shutil.disk_usage(self.folder).free < MIN_FREE:
                raise _NoSpace
        self.stream.write(data)
        return len(data)

    def finish(self) -> None:
        pass


class _Gunzip:
    """Entpackt gzip (auch mehrere Glieder hintereinander) in Häppchen: Auch eine Datei, die aus wenigen Byte
    Gigabyte macht, füllt so nie den Speicher; die Grenze des Ziels greift vorher."""

    def __init__(self, target: "_Sink") -> None:
        self.target = target
        self._z = zlib.decompressobj(wbits=31)

    def write(self, data: bytes) -> int:
        self._inflate(bytes(data))
        return len(data)

    def _inflate(self, data: bytes) -> None:
        try:
            while True:
                if self._z.eof:
                    # Ende eines Glieds: Was danach kommt, muss das nächste sein.
                    data = self._z.unused_data + data
                    if not data:
                        return
                    if len(data) >= len(GZIP_MAGIC) and not data.startswith(GZIP_MAGIC):
                        raise _Damaged
                    self._z = zlib.decompressobj(wbits=31)
                out = self._z.decompress(data, OUT_CHUNK)
                if out:
                    self.target.write(out)
                data = self._z.unconsumed_tail
                # Ein volles Häppchen kann noch mehr nach sich ziehen, auch ohne neue Eingabe.
                if not self._z.eof and not data and len(out) < OUT_CHUNK:
                    return
        except zlib.error:
            raise _Damaged from None

    def finish(self) -> None:
        self._inflate(b"")
        if not self._z.eof:
            raise _Damaged  # abgeschnitten
        self.target.finish()


class _Plain:
    """Was age entschlüsselt hat: gzip oder gleich eine Datenbank, erkannt an den ersten Bytes."""

    def __init__(self, sink: _Sink) -> None:
        self.sink = sink
        self._head = b""
        self._target: _Sink | _Gunzip | None = None

    def _choose(self) -> None:
        if self._head.startswith(GZIP_MAGIC):
            self._target = _Gunzip(self.sink)
        elif self._head.startswith(SQLITE_MAGIC):
            self._target = self.sink
        else:
            raise _Foreign
        head, self._head = self._head, b""
        self._target.write(head)

    def write(self, data: bytes) -> int:
        if self._target is None:
            self._head += bytes(data)
            if len(self._head) >= len(SQLITE_MAGIC):
                self._choose()
            return len(data)
        self._target.write(data)
        return len(data)

    def finish(self) -> None:
        if self._target is None:
            if not self._head:
                raise _Damaged
            self._choose()
        assert self._target is not None
        self._target.finish()


def unpack(source: Path, kind: RestoreKind, identities: list[Any], target: Path) -> int:
    """Entschlüsselt (age) und entpackt (gzip) ``source`` nach ``target`` (neu, 0600); liefert die Größe.

    ``ApiError``: 422 ``wrong_key``, ``damaged`` oder ``not_stowly``, 413 über 2 GiB, 409 ohne Platz.
    """
    folder = target.parent
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
    handle = os.open(target, flags, 0o600)
    try:
        with os.fdopen(handle, "wb") as out:
            sink = _Sink(out, folder, UNPACKED_MAX)
            with source.open("rb") as stream:
                if kind is RestoreKind.AGE:
                    plain = _Plain(sink)
                    try:
                        pyrage.decrypt_io(stream, plain, identities)
                    except OSError as exc:
                        # Kaputte oder abgeschnittene Daten mitten im Strom meldet age als OSError ohne errno;
                        # ein echter Fehler beim Lesen oder Schreiben (etwa ENOSPC) hat einen.
                        if exc.errno is not None:
                            raise
                        raise _Damaged from None
                    plain.finish()
                else:
                    writer: _Sink | _Gunzip = _Gunzip(sink) if kind is RestoreKind.GZIP else sink
                    for chunk in iter(lambda: stream.read(CHUNK), b""):
                        writer.write(chunk)
                    writer.finish()
            out.flush()
            os.fsync(out.fileno())
            written = sink.written
    except pyrage.DecryptError as exc:
        # „No matching keys found": Der Schlüssel öffnet die Datei nicht; alles andere ist kaputt.
        if "no matching keys" in str(exc).lower():
            raise refused("wrong_key", WRONG_KEY) from None
        raise refused("damaged", DAMAGED) from None
    except _TooLarge:
        raise ApiError(413, ErrorCode.PAYLOAD_TOO_LARGE, UNPACKED_TOO_LARGE) from None
    except _NoSpace:
        raise _no_space(MIN_FREE) from None
    except _Damaged:
        raise refused("damaged", DAMAGED) from None
    except _Foreign:
        raise refused("not_stowly", UNKNOWN_FORMAT) from None
    except OSError as exc:
        if exc.errno == 28:  # ENOSPC
            raise _no_space(MIN_FREE) from None
        raise
    with target.open("rb") as stream:
        head = stream.read(100)
    if not head.startswith(SQLITE_MAGIC):
        raise refused("not_stowly", UNKNOWN_FORMAT)
    if len(head) < 100:
        raise refused("damaged", DAMAGED_DATABASE)
    return written


def single_file(path: Path) -> None:
    """Wie ``autobackup.snapshot``: Die Bytes 18 und 19 des Kopfs sagen 1 (Rollback-Journal) statt 2 (WAL).
    So sucht SQLite zu dieser einzelnen Datei kein ``-wal``."""
    with path.open("r+b") as stream:
        stream.seek(18)
        if stream.read(2) == b"\x02\x02":
            stream.seek(18)
            stream.write(b"\x01\x01")
            stream.flush()
            os.fsync(stream.fileno())


# --- Prüfen ------------------------------------------------------------------------------------


Schema = tuple[tuple[Any, ...], ...]


def schema_of(con: sqlite3.Connection) -> Schema:
    """Der Aufbau einer Datenbank: je Eintrag in ``sqlite_master`` Art, Name, Tabelle und SQL, genau so, wie
    sie dort stehen. Nichts wird zusammengefasst: Ein Zeilenumbruch beendet einen ``--``-Kommentar, ohne ihn
    verschluckte der Kommentar, was danach kommt. Sortiert, damit auch doppelte Einträge zählen."""
    rows = con.execute("SELECT type, name, tbl_name, sql FROM sqlite_master").fetchall()
    return tuple(sorted((tuple(row) for row in rows), key=repr))


@functools.cache
def reference_schema(version: int) -> Schema:
    """Der Aufbau, den die Migrationen 1 bis ``version`` ergeben (eine leere Datenbank im Arbeitsspeicher)."""
    con = sqlite3.connect(":memory:", isolation_level=None)
    try:
        for number, _name, sql in db.list_migrations():
            if number > version:
                break
            con.executescript(f"BEGIN;\n{sql}\nCOMMIT;")
        return schema_of(con)
    finally:
        con.close()


def is_stat_table(entry: tuple[Any, ...]) -> bool:
    """Eine Statistiktabelle von SQLite, genau so, wie ANALYZE sie anlegt (``STAT_TABLES``)."""
    kind, name, table, sql = entry
    return (
        isinstance(name, str)
        and name in STAT_TABLES
        and (kind, table, sql) == ("table", name, STAT_TABLES[name])
    )


def is_trigger_or_view(entry: tuple[Any, ...]) -> bool:
    """Ein Trigger oder eine View, gleich unter welchem Namen: nach der Spalte ``type`` oder nach der SQL."""
    kind, _name, _table, sql = entry
    if isinstance(sql, bytes):
        sql = sql.decode("utf-8", "replace")
    return kind in ("trigger", "view") or (
        isinstance(sql, str) and _TRIGGER_OR_VIEW_SQL.match(sql) is not None
    )


def _differences(found: Schema, expected: Schema) -> str:
    """Die Namen der Einträge, die abweichen (fremd, verändert oder fehlend), für das Log: höchstens zehn, je
    höchstens 60 Zeichen; ``%r`` hält sie auf einer Zeile."""
    names = [entry[1] for entry in found if entry not in expected]
    names += [entry[1] for entry in expected if entry not in found]
    return ", ".join(repr(name)[:60] for name in list(dict.fromkeys(names))[:10])


def _harden(con: sqlite3.Connection) -> None:
    """Jede Verbindung zu einer Sicherung oder einer Kopie davon (Prüfen, Migrieren, erster Start, Tausch):
    ``DBCONFIG_DEFENSIVE`` (kein ``writable_schema``), ``trusted_schema = OFF`` und weder Trigger noch Views.
    Was die Prüfung des Aufbaus übersähe, liefe so trotzdem nie."""
    con.setconfig(sqlite3.SQLITE_DBCONFIG_DEFENSIVE, True)
    con.setconfig(sqlite3.SQLITE_DBCONFIG_TRUSTED_SCHEMA, False)
    con.setconfig(sqlite3.SQLITE_DBCONFIG_ENABLE_TRIGGER, False)
    con.setconfig(sqlite3.SQLITE_DBCONFIG_ENABLE_VIEW, False)
    con.execute("PRAGMA trusted_schema = OFF")


def _open_untrusted(path: Path) -> sqlite3.Connection:
    """Öffnet eine fremde Datei nur lesend und abgesichert (``_harden``)."""
    con = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True, isolation_level=None)
    try:
        _harden(con)
        con.execute("PRAGMA cell_size_check = ON")
        con.execute("PRAGMA mmap_size = 0")
    except BaseException:
        con.close()
        raise
    return con


def open_copy(path: Path) -> sqlite3.Connection:
    """Öffnet eine Kopie aus einer Sicherung zum Schreiben (Migrieren, erster Start, Tausch), abgesichert wie
    ``_open_untrusted``: Trigger und Views laufen nie, auch nicht die einer ``ATTACH``-ten Datenbank."""
    con = sqlite3.connect(str(path), isolation_level=None)
    try:
        _harden(con)
    except BaseException:
        con.close()
        raise
    return con


@dataclass(frozen=True)
class Examined:
    """Was die Prüfung über den Kandidaten weiß (nach der Migration)."""

    schema_version: int  # in der Sicherung, vor der Migration
    password_hash: str | None
    devices: int
    last_activity_at: str | None
    counts: dict[str, int]


def _rows_ok(rows: list[Any]) -> bool:
    return [str(row[0]) for row in rows] == ["ok"]


def _quoted(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def text_problem(con: sqlite3.Connection) -> str | None:
    """Prüft jeden TEXT-Wert jeder Tabelle: strenges UTF-8, höchstens ``MAX_TEXT_BYTES`` groß und, wenn er wie
    JSON beginnt, höchstens ``MAX_JSON_DEPTH`` tief verschachtelt. Liefert den Satz für ``damaged``
    (``INVALID_TEXT``, ``TEXT_TOO_LARGE``, ``JSON_TOO_DEEP``) oder ``None``, wenn alles gut ist.

    SQLite prüft das nicht: Eine Spalte TEXT nimmt auch ungültige Bytes an (``CAST(X'FF' AS TEXT)``), auch in
    einer STRICT-Tabelle, und Python scheitert erst beim Lesen, etwa beim Start (``off.reconcile``,
    ``db.seed_defaults``). Ebenso bricht ``json.loads`` an tief verschachteltem JSON mit ``RecursionError`` ab
    (``serverconfig.get`` beim Start, der Abgleich bei ``settings``). Gelesen wird Zeile für Zeile und jeder
    Text als Bytes; BLOB-Spalten (die Bilder) bleiben aus, und einen Wert über der Grenze lädt die Prüfung gar
    nicht erst. Streng heißt: Python dekodiert ohne Ersatz, kodierte Surrogate (``ED A0 80``) gelten nicht."""
    tables = [
        row[0]
        for row in con.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
    ]
    for table in tables:
        columns = [
            str(row[1])
            for row in con.execute(f"PRAGMA table_info({_quoted(table)})").fetchall()
            if str(row[2]).upper() != "BLOB"
        ]
        if not columns:
            continue
        # Je Spalte: der Text als Bytes, 0 für einen Text über der Grenze, NULL für alles andere.
        values = ", ".join(
            f"CASE WHEN typeof({name}) = 'text' THEN CASE WHEN {label_templates.byte_length(name)} <= "
            f"{MAX_TEXT_BYTES} THEN CAST({name} AS BLOB) ELSE 0 END END"
            for name in map(_quoted, columns)
        )
        for row in con.execute(f"SELECT {values} FROM {_quoted(table)}"):
            for value in row:
                if value is None:
                    continue
                if not isinstance(value, bytes):
                    return TEXT_TOO_LARGE
                try:
                    value.decode("utf-8")
                except UnicodeDecodeError:
                    return INVALID_TEXT
                if too_deep(value):
                    return JSON_TOO_DEEP
    return None


# Wie JSON beginnt ein Text, wenn nach Leerraum „[" oder „{" kommt (so beginnt alles, was json.loads tief
# verschachtelt zurückweisen könnte). Zeichenketten in JSON enthalten Klammern als Text: Escapes (\x) fallen
# zuerst weg, danach trennen die übrigen Anführungszeichen Zeichenketten vom Rest.
_JSON_START = re.compile(rb"[ \t\r\n]*[\[{]")
_JSON_ESCAPE = re.compile(rb"\\.", re.DOTALL)
_NOT_STRUCTURE = bytes(byte for byte in range(256) if byte not in b'[]{}"')
_DEPTH_STEP = [0] * 256
for _open in b"[{":
    _DEPTH_STEP[_open] = 1
for _close in b"]}":
    _DEPTH_STEP[_close] = -1


def json_depth(data: bytes) -> int:
    """Die tiefste Schachtelung von ``[`` und ``{`` außerhalb von Zeichenketten, ohne zu parsen.

    Linear und ohne Objekte für die Werte: Escapes entfernen, alles außer Klammern und Anführungszeichen
    löschen (beides in C), die Stücke außerhalb von Zeichenketten zusammensetzen und die größte Summe der
    Schritte nehmen. Für kaputtes JSON ist das Ergebnis eine Schätzung; geprüft wird nur, ob es zu tief ist."""
    structure = _JSON_ESCAPE.sub(b"", data).translate(None, _NOT_STRUCTURE)
    outside = b"".join(structure.split(b'"')[0::2])
    if not outside:
        return 0
    return max(0, max(itertools.accumulate(map(_DEPTH_STEP.__getitem__, outside))))


def too_deep(value: bytes) -> bool:
    """Beginnt ``value`` wie JSON und ist tiefer verschachtelt als ``MAX_JSON_DEPTH``? Was weniger öffnende
    Klammern hat, als die Grenze erlaubt, kann nicht zu tief sein und wird gar nicht erst gezählt."""
    if _JSON_START.match(value) is None:
        return False
    if value.count(b"[") + value.count(b"{") <= MAX_JSON_DEPTH:
        return False
    return json_depth(value) > MAX_JSON_DEPTH


def examine(path: Path, *, now: datetime | None = None) -> Examined:
    """Prüft die entpackte Datenbank der Reihe nach und migriert sie dann an Ort und Stelle (die Datei ist
    schon eine Kopie). ``ApiError`` 422 mit ``details.reason``.

    Der Aufbau muss genau dem aus den Migrationen gleichen, Zeichen für Zeichen; Trigger und Views lehnt die
    Prüfung unter jedem Namen ab, Statistiktabellen von SQLite nur in ihrer eigenen Form zu. Jeder Text muss
    gültiges UTF-8 sein (``text_problem``), sonst ``damaged``; das gilt für beide Arten des Zurückspielens,
    auch beim ersten Start, wo ``meta`` und ``server_config`` aus der Sicherung kommen. Danach räumt
    ``_clean_candidate`` den Kandidaten auf (``now``: Zeitpunkt dafür, Vorgabe jetzt)."""
    current = len(db.list_migrations())
    single_file(path)
    try:
        con = _open_untrusted(path)
    except sqlite3.Error:
        raise refused("damaged", DAMAGED_DATABASE) from None
    try:
        if not _rows_ok(con.execute("PRAGMA quick_check").fetchall()):
            raise refused("damaged", DAMAGED_DATABASE)
        if int(con.execute("PRAGMA application_id").fetchone()[0]) not in (0, APPLICATION_ID):
            raise refused("not_stowly", NOT_STOWLY)
        version = int(con.execute("PRAGMA user_version").fetchone()[0])
        if version < 1:
            raise refused("not_stowly", NOT_STOWLY)
        if version > current:
            raise refused(
                "newer_schema",
                f"Die Sicherung stammt von einem neueren Stowly (Datenbank-Version {version}, dieser kennt "
                f"{current}). Bitte erst Stowly aktualisieren.",
            )
        schema = schema_of(con)
        if any(is_trigger_or_view(entry) for entry in schema):
            raise refused("not_stowly", TRIGGERS)
        own = tuple(entry for entry in schema if not is_stat_table(entry))
        expected = reference_schema(version)
        if own != expected:
            log.warning(
                "Zurückspielen: Der Aufbau der Sicherung weicht ab bei %s.", _differences(own, expected)
            )
            raise refused("not_stowly", FOREIGN_SCHEMA)
        if not _rows_ok(con.execute("PRAGMA integrity_check").fetchall()):
            raise refused("damaged", DAMAGED_DATABASE)
        if con.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise refused("damaged", DAMAGED_DATABASE)
        problem = text_problem(con)
        if problem is not None:
            log.warning("Zurückspielen: abgelehnt, %s", problem)
            raise refused("damaged", problem)
    except sqlite3.Error:
        raise refused("damaged", DAMAGED_DATABASE) from None
    finally:
        con.close()
    # Die Migration in der Kopie, abgesichert wie die Prüfung; db.connect stellte auf WAL um.
    con = open_copy(path)
    try:
        con.execute("PRAGMA foreign_keys = ON")
        try:
            for name in STAT_TABLES:
                con.execute(f"DROP TABLE IF EXISTS {name}")
            db.migrate(con)
            con.execute(f"PRAGMA application_id = {APPLICATION_ID}")
            _clean_candidate(con, now or datetime.now(UTC))
        except (RuntimeError, sqlite3.Error):
            log.exception(
                "Zurückspielen: Die Migration der Sicherung (Version %d) ist fehlgeschlagen", version
            )
            raise refused("migration_failed", MIGRATION_FAILED) from None
        if not _rows_ok(con.execute("PRAGMA quick_check").fetchall()):
            raise refused("migration_failed", MIGRATION_FAILED)
        return _describe(con, version)
    finally:
        con.close()


def _clean_candidate(con: sqlite3.Connection, now: datetime) -> None:
    """Im Kandidaten, nach der Migration, für beide Arten des Zurückspielens:

    * **Bilder**, die Stowly nie ausliefert, fallen weg: ein anderer Typ als JPEG, PNG oder WebP, oder Bytes,
      die nicht zum Typ passen (``off.sniff_image``). Ein Produkt, das auf eines zeigt, hat dann kein Bild.
    * **Kopplungen eines Pi**, die noch nicht gekoppelt sind, gelten als abgebrochen: Ein Code aus einer
      gefälschten Sicherung bekäme sonst ein Zertifikat der eigenen CA.
    * **Etikett-Vorlagen** (``label_templates``) fallen alle weg: Sie sind abgeleitet, und der Start erzeugt
      sie neu (``label_templates.install``). Was eine Sicherung als Vorlage mitbrächte, ginge sonst über den
      Sync unbesehen an alle Geräte, etwa ein fremder Inhalt im QR-Code.
    * **Die Gestaltung der Etiketten** (``label_design``) bleibt nur, wenn sie taugt
      (``label_templates.parse_design``: höchstens 64 KiB, UTF-8, nach dem Vertrag, Papier im Katalog,
      ``updated_at`` ein Zeitstempel); sonst fällt sie weg, und es gelten die mitgelieferten Vorlagen.
    """
    doomed = [
        row[0]
        for row in con.execute("SELECT id, content_type, substr(data, 1, 16) FROM images")
        if not _image_ok(row[1], row[2])
    ]
    designs = _unusable_designs(con)
    stamp = format_timestamp(now)
    with db.transaction(con):
        con.executemany("DELETE FROM images WHERE id = ?", [(image_id,) for image_id in doomed])
        pairings = con.execute(
            "UPDATE pi_pairings SET cancelled_at = ? WHERE paired_at IS NULL AND cancelled_at IS NULL",
            (stamp,),
        ).rowcount
        con.execute("DELETE FROM label_templates")
        con.executemany("DELETE FROM label_design WHERE id = ?", [(design_id,) for design_id in designs])
    if doomed:
        log.warning(
            "Zurückspielen: %d Bilder der Sicherung sind kein JPEG, PNG oder WebP und fallen weg.",
            len(doomed),
        )
    if pairings:
        log.info("Zurückspielen: %d offene Kopplungen eines Pi aus der Sicherung sind abgebrochen.", pairings)
    if designs:
        log.warning(
            "Zurückspielen: Die Gestaltung der Etiketten aus der Sicherung ist unbrauchbar und fällt weg; "
            "es gelten die mitgelieferten Vorlagen."
        )


def _unusable_designs(con: sqlite3.Connection) -> list[int]:
    """Die Zeilen in ``label_design``, die nicht taugen: nicht die Zeile 1, zu groß (gemessen in SQL, ohne sie
    zu laden) oder abgelehnt von ``label_templates.parse_design``."""
    unusable: list[int] = []
    sizes = con.execute(f"SELECT id, {label_templates.byte_length('body')} FROM label_design").fetchall()
    for design_id, size in sizes:
        try:
            if design_id != 1 or not isinstance(size, int) or size > label_templates.MAX_DESIGN_BYTES:
                raise ValueError("Die Gestaltung ist zu groß oder nicht die einzige.")
            body, updated_at = con.execute(
                "SELECT CAST(body AS BLOB), CAST(updated_at AS BLOB) FROM label_design WHERE id = ?",
                (design_id,),
            ).fetchone()
            label_templates.parse_design(body, updated_at)
        except label_templates.UNREADABLE:
            unusable.append(design_id)
    return unusable


def _image_ok(content_type: Any, head: Any) -> bool:
    if content_type not in off.IMAGE_TYPES or not isinstance(head, bytes):
        return False
    sniffed = off.sniff_image(head)
    return sniffed is not None and sniffed[0] == content_type


def _describe(con: sqlite3.Connection, version: int) -> Examined:
    def count(sql: str) -> int:
        return int(con.execute(sql).fetchone()[0])

    stored = con.execute("SELECT value FROM meta WHERE key = ?", (auth.PASSWORD_HASH,)).fetchone()
    moments = [
        row[0]
        for row in (
            con.execute("SELECT max(recorded_at) FROM events").fetchone(),
            con.execute("SELECT max(received_at) FROM commands").fetchone(),
        )
        if isinstance(row[0], str) and is_timestamp(row[0])
    ]
    return Examined(
        schema_version=version,
        password_hash=None if stored is None else str(stored[0]),
        devices=count("SELECT COUNT(*) FROM devices WHERE revoked_at IS NULL"),
        last_activity_at=max(moments) if moments else None,
        counts={
            "products": count(
                "SELECT COUNT(*) FROM products WHERE deleted_at IS NULL AND merged_into IS NULL"
            ),
            "items": count("SELECT COUNT(*) FROM packages WHERE removed_at IS NULL"),
            "zones": count("SELECT COUNT(*) FROM zones WHERE deleted_at IS NULL"),
            "shopping": count(
                "SELECT COUNT(*) FROM shopping_items WHERE done_at IS NULL AND deleted_at IS NULL"
            ),
        },
    )


# --- Gegenseitiger Ausschluss mit Updates --------------------------------------------------------


def update_busy(settings: Settings, now: datetime) -> bool:
    """Ist ein Update angefordert oder in Arbeit (docs/integrationen.md, 10.4)? Eine Anforderung, die der
    Updater seit 10 Minuten nicht abholt, und ein Update, zu dem er seit 15 Minuten schweigt, zählen nicht:
    Sonst sperrte ein verschwundener Updater das Zurückspielen für immer."""
    files = updates.read_files(settings.update_dir)
    seen = updates.parse_time((files.updater or {}).get("seen_at"))
    ready = seen is not None and now - seen <= updates.READY_WITHIN
    state = updates.update_state(files, now, updater_ready=ready)
    if state["state"] not in (UpdateState.REQUESTED, UpdateState.INSTALLING):
        return False
    return state["state_message"] not in (updates.REQUEST_NOT_PICKED_UP, updates.UPDATER_QUIET)


def pending_exists(settings: Settings) -> bool:
    return (folder_of(settings) / PENDING_MANIFEST).exists()


# --- Im Arbeitsspeicher: Hochladen, Prüfen, Anwenden ---------------------------------------------


@dataclass
class Uploaded:
    id: str
    path: Path
    kind: RestoreKind
    size: int
    expires: datetime
    first_start: bool


@dataclass
class Candidate:
    id: str
    path: Path
    kind: RestoreKind
    expires: datetime
    first_start: bool
    examined: Examined


class Receiver:
    """Nimmt die hochgeladenen Rohdaten in Teilen an (``feed``) und schreibt sie nach ``upload-<id>``."""

    def __init__(self, manager: "RestoreManager", path: Path, first_start: bool) -> None:
        self.manager = manager
        self.path = path
        self.first_start = first_start
        self.size = 0
        self.kind: RestoreKind | None = None
        self._head = b""
        self._stream: BinaryIO | None = None
        self._check_at = SPACE_CHECK_EVERY

    def _open(self) -> BinaryIO:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
        return os.fdopen(os.open(self.path, flags, 0o600), "wb")

    def feed(self, data: bytes) -> None:
        self.size += len(data)
        if self.size > RESTORE_MAX_BYTES:
            raise ApiError(413, ErrorCode.PAYLOAD_TOO_LARGE, TOO_LARGE, {"max_bytes": RESTORE_MAX_BYTES})
        if self.kind is None:
            self._head += data
            if len(self._head) < SNIFF_BYTES:
                return
            self._decide()
            data, self._head = self._head, b""
        if self.size >= self._check_at:
            self._check_at += SPACE_CHECK_EVERY
            if shutil.disk_usage(self.path.parent).free < 2 * self.size:
                raise _no_space(SPACE_FACTOR * self.size)
        assert self._stream is not None
        try:
            self._stream.write(data)
        except OSError as exc:
            if exc.errno == 28:  # ENOSPC
                raise _no_space(SPACE_FACTOR * self.size) from None
            raise

    def _decide(self) -> None:
        kind = kind_of(self._head)
        if kind is None:
            raise refused("not_stowly", UNKNOWN_FORMAT)
        self.kind = kind
        self._stream = self._open()

    def finish(self) -> Uploaded:
        if self.kind is None:
            if not self._head:
                raise refused("not_stowly", EMPTY)
            self._decide()
            head, self._head = self._head, b""
            assert self._stream is not None
            self._stream.write(head)
        assert self._stream is not None and self.kind is not None
        self._stream.flush()
        os.fsync(self._stream.fileno())
        self._stream.close()
        self._stream = None
        return self.manager._uploaded(self)

    def discard(self) -> None:
        if self._stream is not None:
            with contextlib.suppress(OSError):
                self._stream.close()
            self._stream = None
        with contextlib.suppress(OSError):
            _remove(self.path)


class RestoreManager:
    """Der Stand des Zurückspielens im Arbeitsspeicher, je App: höchstens eine hochgeladene Datei und ein
    geprüfter Kandidat, die eigene Bremse und die Sperre gegen ein gleichzeitiges erstes Passwort."""

    def __init__(self, settings: Settings, *, clock: Callable[[], datetime] | None = None) -> None:
        self.settings = settings
        self.clock: Callable[[], datetime] = clock or (lambda: datetime.now(UTC))
        self._lock = threading.Lock()
        self._working = False
        self._recent: deque[datetime] = deque()
        self.upload: Uploaded | None = None
        self.candidate: Candidate | None = None
        # Beim ersten Start angewendet: Bis zum Neustart setzt niemand ein erstes Passwort.
        self.first_start_claimed = False

    # ------------------------------------------------------------------ Bremse und Sperren

    @contextlib.contextmanager
    def operation(self, *, counted: bool) -> Iterator[None]:
        """Ein Schritt zugleich (429); ``counted``: höchstens 6 in 10 Minuten (429 mit ``Retry-After``)."""
        with self._lock:
            if self._working:
                raise ApiError(
                    429,
                    ErrorCode.RATE_LIMITED,
                    BUSY,
                    {"retry_after_s": BUSY_RETRY_S},
                    {"Retry-After": str(BUSY_RETRY_S)},
                )
            now = self.clock()
            if counted:
                while self._recent and self._recent[0] <= now - WINDOW:
                    self._recent.popleft()
                if len(self._recent) >= WINDOW_MAX:
                    wait = max(1, math.ceil((self._recent[0] + WINDOW - now).total_seconds()))
                    raise ApiError(
                        429,
                        ErrorCode.RATE_LIMITED,
                        f"Höchstens {WINDOW_MAX} Versuche in 10 Minuten. Bitte in {wait} Sekunden erneut "
                        "versuchen.",
                        {"retry_after_s": wait},
                        {"Retry-After": str(wait)},
                    )
                self._recent.append(now)
            self._working = True
        try:
            yield
        finally:
            with self._lock:
                self._working = False

    @property
    def working(self) -> bool:
        return self._working

    def refuse_if_blocked(self) -> None:
        """409, solange eine Sicherung bereitliegt oder ein Update angefordert ist bzw. läuft."""
        if self.first_start_claimed or pending_exists(self.settings):
            raise ApiError(409, ErrorCode.CONFLICT, PENDING)
        if update_busy(self.settings, self.clock()):
            raise ApiError(409, ErrorCode.CONFLICT, UPDATE_RUNNING)

    def blocks_update(self) -> bool:
        """Ein Update wartet, solange ein Schritt läuft oder eine Sicherung bereitliegt."""
        return self._working or self.first_start_claimed or pending_exists(self.settings)

    def blocks_first_password(self) -> bool:
        """``POST /api/setup/password`` antwortet 409, solange ein Zurückspielen bereitliegt."""
        return self.first_start_claimed or pending_exists(self.settings)

    # ------------------------------------------------------------------ Ablauf der Fristen

    def _expire(self) -> None:
        now = self.clock()
        if self.upload is not None and now >= self.upload.expires:
            self._drop_upload()
        if self.candidate is not None and now >= self.candidate.expires:
            self._drop_candidate()

    def _drop_upload(self) -> None:
        if self.upload is not None:
            _remove(self.upload.path)
            self.upload = None

    def _drop_candidate(self) -> None:
        if self.candidate is not None:
            _remove(self.candidate.path)
            self.candidate = None

    def forget(self) -> None:
        """Verwirft hochgeladene Datei und Kandidat."""
        self._drop_upload()
        self._drop_candidate()

    def sweep(self) -> None:
        """Räumt auf, auch ohne Aufruf (im lifespan der App alle ``SWEEP_EVERY_S`` Sekunden): abgelaufene
        hochgeladene Dateien und Kandidaten, Reste ohne Besitzer in ``/data/restore`` (etwa eine Datei, die sich
        nicht löschen ließ) und nach 7 Tagen die Datenbank von vor dem Zurückspielen. Läuft gerade ein Schritt,
        kommt das Aufräumen beim nächsten Mal dran: Was er braucht, bleibt."""
        try:
            with self.operation(counted=False):
                self._expire()
                keep = {item.path.name for item in (self.upload, self.candidate) if item is not None}
                _sweep(folder_of(self.settings), keep=keep)
                if not pending_exists(self.settings):
                    expire_previous(self.settings, self.clock())
        except ApiError:
            return

    # ------------------------------------------------------------------ 1. Hochladen

    def receiver(self, declared: int | None, *, first_start: bool) -> Receiver:
        """Beginnt ein Hochladen. 409 ohne Platz.

        Was schon da ist, bleibt: Die frühere Datei fällt erst weg, wenn dieses Hochladen gelingt, ein
        geprüfter Kandidat erst, wenn ein neuer die Prüfung besteht. So nimmt ein zweites Gerät dem ersten
        nicht die geprüfte Sicherung weg, kurz bevor es sie anwendet.
        """
        folder = ensure_folder(self.settings)
        self._expire()
        if declared is not None and declared > RESTORE_MAX_BYTES:
            raise ApiError(413, ErrorCode.PAYLOAD_TOO_LARGE, TOO_LARGE, {"max_bytes": RESTORE_MAX_BYTES})
        if declared is not None and shutil.disk_usage(folder).free < SPACE_FACTOR * declared:
            raise _no_space(SPACE_FACTOR * declared)
        return Receiver(self, folder / f"upload-{new_id()}", first_start)

    def _uploaded(self, receiver: Receiver) -> Uploaded:
        assert receiver.kind is not None
        upload_id = receiver.path.name.removeprefix("upload-")
        self._drop_upload()
        self.upload = Uploaded(
            id=upload_id,
            path=receiver.path,
            kind=receiver.kind,
            size=receiver.size,
            expires=self.clock() + ID_TTL,
            first_start=receiver.first_start,
        )
        log.info("Zurückspielen: Datei hochgeladen (%s, %d Byte).", receiver.kind.value, receiver.size)
        return self.upload

    # ------------------------------------------------------------------ 2. Prüfen

    def check(self, upload_id: str, identity: str | None, *, first_start: bool) -> dict[str, Any]:
        """Entschlüsselt, entpackt, prüft und migriert eine Kopie; liefert die ``RestorePreview``. Die
        hochgeladene Datei bleibt, damit sich die Prüfung mit einem anderen Schlüssel wiederholen lässt; ein
        früherer Kandidat bleibt, bis dieser die Prüfung besteht."""
        self._expire()
        upload = self.upload
        if upload is None or not _same(upload.id, upload_id) or upload.first_start != first_start:
            raise ApiError(404, ErrorCode.NOT_FOUND, UPLOAD_UNKNOWN)
        identities = parse_identities(identity) if upload.kind is RestoreKind.AGE else []
        folder = ensure_folder(self.settings)
        if shutil.disk_usage(folder).free < 2 * upload.size:
            raise _no_space(2 * upload.size)
        restore_id = new_id()
        work = folder / f"work-{restore_id}.sqlite3"
        target = folder / f"candidate-{restore_id}.sqlite3"
        try:
            unpack(upload.path, upload.kind, identities, work)
            examined = examine(work, now=self.clock())
            _replace(work, target)
        except BaseException:
            _remove(work, target)
            raise
        expires = self.clock() + ID_TTL
        self._drop_candidate()
        self.candidate = Candidate(restore_id, target, upload.kind, expires, first_start, examined)
        log.info(
            "Zurückspielen: Sicherung geprüft (%s, Version %d, %d Produkte).",
            upload.kind.value,
            examined.schema_version,
            examined.counts["products"],
        )
        return {
            "restore_id": restore_id,
            "expires_at": format_timestamp(expires),
            "kind": upload.kind,
            "schema_version": examined.schema_version,
            "current_schema_version": len(db.list_migrations()),
            "last_activity_at": examined.last_activity_at,
            "has_password": examined.password_hash is not None,
            "devices": examined.devices,
            "counts": examined.counts,
        }

    # ------------------------------------------------------------------ 3. Anwenden

    def apply(
        self,
        restore_id: str,
        password: str,
        device_name: str | None,
        *,
        device: sqlite3.Row | None,
        guard: auth.LoginGuard,
    ) -> dict[str, Any]:
        """Prüft das Passwort und legt den Kandidaten für den Tausch beim nächsten Start bereit.

        ``device`` ist das angemeldete Gerät (laufender Stowly) oder ``None`` (erster Start). Liefert
        ``RestoreApplied``; der Aufrufer startet danach neu.
        """
        first_start = device is None
        self._expire()
        candidate = self.candidate
        if candidate is None or not _same(candidate.id, restore_id) or candidate.first_start != first_start:
            raise ApiError(404, ErrorCode.NOT_FOUND, CANDIDATE_UNKNOWN)
        if first_start:
            return self._apply_first_start(candidate, password, device_name, guard)
        settings = self.settings
        con = db.connect(settings.database_path)
        try:
            check = auth.password_check(settings, con, password)
        finally:
            con.close()
        if check is None:
            raise ApiError(503, ErrorCode.NOT_CONFIGURED, auth.NO_PASSWORD)
        matched, retry_after = guard.attempt(check)
        if retry_after is not None:
            raise _rate_limited(retry_after)
        if not matched:
            raise ApiError(401, ErrorCode.INVALID_PASSWORD, WRONG_PASSWORD)
        assert device is not None
        self._prepare(candidate, mode="running", device_id=device["id"])
        return {"login": None}

    def _apply_first_start(
        self, candidate: Candidate, password: str, device_name: str | None, guard: auth.LoginGuard
    ) -> dict[str, Any]:
        if device_name is None:
            raise _invalid("device_name", DEVICE_NAME_MISSING, "device_name")
        stored = candidate.examined.password_hash
        if stored is None and len(password) < LIMITS["password_min"]:
            raise _invalid("password", f"Mindestens {LIMITS['password_min']} Zeichen.", "string_too_short")
        settings = self.settings

        class PasswordSet(Exception):
            pass

        def check() -> bool:
            # Unter dem Lock der Bremse, wie das erste Passwort (api/setup.py): Genau einer gewinnt.
            con = db.connect(settings.database_path)
            try:
                if auth.has_password(settings, con):
                    raise PasswordSet
            finally:
                con.close()
            if stored is not None and not auth.verify_password(password, stored):
                return False
            self.first_start_claimed = True
            return True

        try:
            matched, retry_after = guard.attempt(check)
        except PasswordSet:
            raise ApiError(409, ErrorCode.CONFLICT, PASSWORD_SET_MEANWHILE) from None
        if retry_after is not None:
            raise _rate_limited(retry_after)
        if not matched:
            raise ApiError(401, ErrorCode.INVALID_PASSWORD, WRONG_BACKUP_PASSWORD)
        try:
            token, row = _first_start(candidate.path, password if stored is None else None, device_name)
            self._prepare(candidate, mode="first_start", device_id=row["id"])
        except BaseException:
            self.first_start_claimed = False
            raise
        return {"login": {"token": token, "device": records.device(row, row["id"])}}

    def _prepare(self, candidate: Candidate, *, mode: str, device_id: str | None) -> None:
        """Legt den Kandidaten als ``pending.sqlite3`` bereit, das Manifest zuletzt. 500 bei einem Fehler."""
        folder = ensure_folder(self.settings)
        manifest = {
            "version": 1,
            "kind": "restore",
            "mode": mode,
            "source": candidate.kind.value,
            "requested_at": format_timestamp(self.clock()),
            "device_id": device_id,
            "dataset_id": ids.new_uuid(),
            "schema_version": candidate.examined.schema_version,
        }
        try:
            _remove(folder / PENDING_MANIFEST, folder / PENDING_DB)
            _replace(candidate.path, folder / PENDING_DB)
            self.candidate = None
            _fsync(folder / PENDING_DB)
            manifest["sha256"] = sha256_of(folder / PENDING_DB)
            _write_json(folder, PENDING_MANIFEST, manifest)
        except OSError:
            log.exception("Zurückspielen: Die Sicherung ließ sich nicht bereitlegen")
            self.candidate = None
            _remove(folder / PENDING_MANIFEST, folder / PENDING_DB)
            raise ApiError(500, ErrorCode.INTERNAL, NOT_PREPARED) from None
        self._drop_upload()
        log.info(
            "Zurückspielen: Sicherung bereitgelegt (%s, %s, Version %d); Stowly startet neu.",
            candidate.kind.value,
            "erster Start" if mode == "first_start" else "laufender Stowly",
            candidate.examined.schema_version,
        )

    # ------------------------------------------------------------------ Rückgängig

    def ensure_undo(self) -> None:
        """404, wenn es nichts rückgängig zu machen gibt (keine ``previous.sqlite3``, Frist vorbei, erster Start)."""
        if status(self.settings, self.clock())["undo_until"] is None:
            raise ApiError(404, ErrorCode.NOT_FOUND, NOTHING_TO_UNDO)

    def undo(self, *, device_id: str) -> None:
        """Legt die Datenbank von vor dem letzten Zurückspielen für denselben Tausch bereit. 404 ohne sie."""
        settings = self.settings
        now = self.clock()
        self.ensure_undo()
        folder = ensure_folder(settings)
        manifest = {
            "version": 1,
            "kind": "undo",
            "mode": "running",
            "source": "previous",
            "requested_at": format_timestamp(now),
            "device_id": device_id,
            "dataset_id": ids.new_uuid(),
            "schema_version": None,
        }
        try:
            _remove(folder / PENDING_MANIFEST, folder / PENDING_DB)
            _link_or_copy(folder / PREVIOUS_DB, folder / PENDING_DB)
            manifest["sha256"] = sha256_of(folder / PENDING_DB)
            _write_json(folder, PENDING_MANIFEST, manifest)
        except OSError:
            log.exception("Zurückspielen: Rückgängig ließ sich nicht bereitlegen")
            _remove(folder / PENDING_MANIFEST, folder / PENDING_DB)
            raise ApiError(500, ErrorCode.INTERNAL, NOT_PREPARED) from None
        self.forget()
        log.info("Zurückspielen: Rückgängig bereitgelegt; Stowly startet neu.")


def _rate_limited(retry_after: int) -> ApiError:
    return ApiError(
        429,
        ErrorCode.RATE_LIMITED,
        f"Zu viele Fehlversuche. Bitte in {retry_after} Sekunden erneut versuchen.",
        {"retry_after_s": retry_after},
        {"Retry-After": str(retry_after)},
    )


def _first_start(path: Path, new_password: str | None, device_name: str) -> tuple[str, sqlite3.Row]:
    """Beim ersten Start, im Kandidaten: das neue Gerät (sein Token gilt nach dem Neustart), ohne Passwort in
    der Sicherung ein neues (dann gelten die Geräte der Sicherung nicht mehr), und was zur alten CA gehört
    wird vergessen: Zeitpunkt der Einrichtung, „über HTTPS gesehen", gelernte Ports, der Schritt HTTPS."""
    con = open_copy(path)
    con.row_factory = sqlite3.Row
    try:
        con.execute("PRAGMA foreign_keys = ON")
        now = format_timestamp(datetime.now(UTC))
        with db.transaction(con):
            if new_password is not None:
                con.execute(
                    "INSERT INTO meta (key, value) VALUES (?, ?) "
                    "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                    (auth.PASSWORD_HASH, auth.hash_password(new_password)),
                )
                con.execute("UPDATE devices SET revoked_at = ? WHERE revoked_at IS NULL", (now,))
                con.execute("DELETE FROM push_subscriptions")
            _forget_old_ca(con)
        token, device = auth.create_device(con, device_name)
        if new_password is not None:
            with db.transaction(con):
                events.record(
                    con,
                    at=now,
                    recorded_at=now,
                    device_id=device["id"],
                    type="server.password_set",
                    entity="server",
                    entity_id="password",
                    data={"source": "app"},
                )
    finally:
        con.close()
    _fsync(path)
    return token, device


def _forget_old_ca(con: sqlite3.Connection) -> None:
    """Auf einem neuen Rechner ist die CA neu: Die sichere Verbindung beginnt von vorn."""
    for key in (serverconfig.SETUP_FINISHED_AT, serverconfig.HTTPS_SEEN_AT, serverconfig.HTTP_PORT):
        serverconfig.delete(con, key)
    port = serverconfig.get(con, serverconfig.HTTPS_PORT)
    if isinstance(port, dict) and port.get("source") != PortSource.MANUAL:
        serverconfig.delete(con, serverconfig.HTTPS_PORT)
    steps = serverconfig.get(con, serverconfig.SETUP_STEPS)
    if isinstance(steps, dict) and SetupStepId.HTTPS.value in steps:
        steps.pop(SetupStepId.HTTPS.value)
        row = con.execute(
            "SELECT updated_at, updated_by FROM server_config WHERE key = ?", (serverconfig.SETUP_STEPS,)
        ).fetchone()
        serverconfig.put(con, serverconfig.SETUP_STEPS, steps, now=row[0], by=row[1])


# --- Stand (GET /api/restore) --------------------------------------------------------------------


def expire_previous(settings: Settings, now: datetime) -> None:
    """Löscht ``previous.sqlite3``, wenn die Frist für „Rückgängig" vorbei ist."""
    folder = folder_of(settings)
    previous = folder / PREVIOUS_DB
    if not previous.exists():
        return
    last = _read_json(folder / LAST) or {}
    at = _timestamp(last.get("at"))
    if at is None:
        try:
            at = datetime.fromtimestamp(previous.stat().st_mtime, UTC)
        except OSError:
            return
    if now - at >= UNDO_FOR:
        with contextlib.suppress(OSError):
            previous.unlink()
            log.info("Zurückspielen: Die Datenbank von vor dem Zurückspielen ist nach 7 Tagen gelöscht.")


def status(settings: Settings, now: datetime) -> dict[str, Any]:
    """``RestoreStatus``. Nie ein Schlüssel."""
    folder = folder_of(settings)
    manifest = _read_json(folder / PENDING_MANIFEST)
    if manifest is not None:
        at = _timestamp(manifest.get("requested_at"))
        return {
            "state": RestoreState.PENDING,
            "at": None if at is None else format_timestamp(at),
            "message": PENDING_MESSAGE,
            "undo_until": None,
        }
    expire_previous(settings, now)
    last = _read_json(folder / LAST) or {}
    at = _timestamp(last.get("at"))
    state = last.get("state")
    if at is None or state not in (RestoreState.DONE, RestoreState.UNDONE, RestoreState.FAILED):
        return {"state": RestoreState.IDLE, "at": None, "message": None, "undo_until": None}
    if now - at >= UNDO_FOR:
        return {"state": RestoreState.IDLE, "at": None, "message": None, "undo_until": None}
    undo_until = _timestamp(last.get("undo_until"))
    if (
        state == RestoreState.FAILED
        or undo_until is None
        or now >= undo_until
        or not (folder / PREVIOUS_DB).is_file()
    ):
        undo_until = None
    message = last.get("message")
    return {
        "state": RestoreState(state),
        "at": format_timestamp(at),
        "message": message if isinstance(message, str) else None,
        "undo_until": None if undo_until is None else format_timestamp(undo_until),
    }


def delete_previous(settings: Settings) -> bool:
    """Löscht ``previous.sqlite3`` vorzeitig; liefert, ob es sie gab."""
    previous = folder_of(settings) / PREVIOUS_DB
    try:
        previous.unlink()
    except (FileNotFoundError, NotADirectoryError):  # Linux meldet einen fehlenden Ordner so, Windows anders
        return False
    log.info(
        "Zurückspielen: Die Datenbank von vor dem Zurückspielen ist gelöscht; Rückgängig geht nicht mehr."
    )
    return True


# --- Der Tausch beim Start (resume) --------------------------------------------------------------


class _SwapFailed(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _dataset_id(database: Path) -> str | None:
    if not database.is_file():
        return None
    con = sqlite3.connect(str(database), isolation_level=None, timeout=2.0)
    try:
        _harden(con)
        row = con.execute("SELECT value FROM meta WHERE key = 'dataset_id'").fetchone()
        return None if row is None else str(row[0])
    except sqlite3.Error:
        return None
    finally:
        con.close()


def _verify(pending: Path, manifest: dict[str, Any]) -> None:
    """Schritt 1: sha256, ``quick_check``, Version, weder Trigger noch Views."""
    if not pending.is_file() or manifest.get("sha256") != sha256_of(pending):
        raise _SwapFailed(CHANGED)
    try:
        con = _open_untrusted(pending)
    except sqlite3.Error:
        raise _SwapFailed(CHANGED) from None
    try:
        if not _rows_ok(con.execute("PRAGMA quick_check").fetchall()):
            raise _SwapFailed(CHANGED)
        version = int(con.execute("PRAGMA user_version").fetchone()[0])
        if not 1 <= version <= len(db.list_migrations()):
            raise _SwapFailed(CHANGED)
        if any(is_trigger_or_view(entry) for entry in schema_of(con)):
            raise _SwapFailed(CHANGED)
    except sqlite3.Error:
        raise _SwapFailed(CHANGED) from None
    finally:
        con.close()


def _quiesce(database: Path) -> None:
    """Schritt 2: checkpointen und ``journal_mode = DELETE``. Das gelingt nur, wenn keine andere Verbindung
    offen ist; danach gibt es kein ``-wal`` mehr, das zu dieser Datei gehört."""
    if not database.is_file():
        return
    try:
        con = sqlite3.connect(str(database), isolation_level=None, timeout=2.0)
        try:
            _harden(con)
            con.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
            mode = str(con.execute("PRAGMA journal_mode = DELETE").fetchone()[0]).lower()
        finally:
            con.close()
    except sqlite3.Error:
        raise _SwapFailed(STILL_OPEN) from None
    if mode != "delete":
        raise _SwapFailed(STILL_OPEN)
    with contextlib.suppress(FileNotFoundError):
        Path(f"{database}-shm").unlink()
    if Path(f"{database}-wal").exists():
        raise _SwapFailed(STILL_OPEN)


def _columns(con: sqlite3.Connection, schema: str, table: str) -> list[str]:
    return [str(row[1]) for row in con.execute(f'PRAGMA {schema}.table_info("{table}")')]


def _take_over(con: sqlite3.Connection, now: str) -> None:
    """Schritt 3, laufender Stowly: was aus der laufenden Datenbank (``old``) bleibt. So wird niemand
    abgemeldet, und gesperrte Geräte bleiben gesperrt; Geräte aus einer gefälschten Datei zählen nicht."""
    for table in TAKEN_OVER_TABLES:
        old = set(_columns(con, "old", table))
        if not old:
            continue
        names = ", ".join(f'"{name}"' for name in _columns(con, "main", table) if name in old)
        con.execute(f'DELETE FROM main."{table}"')
        con.execute(f'INSERT INTO main."{table}" ({names}) SELECT {names} FROM old."{table}"')
    for key in TAKEN_OVER_META:
        con.execute("DELETE FROM main.meta WHERE key = ?", (key,))
        con.execute(
            "INSERT INTO main.meta (key, value) SELECT key, value FROM old.meta WHERE key = ?", (key,)
        )
    # Kennungen: Was nach der Sicherung gedruckt wurde, vergibt Stowly nie ein zweites Mal (sync/idpool.py).
    con.execute(
        "INSERT OR IGNORE INTO main.id_reservations (package_id, device_id, granted_at) "
        "SELECT id, coalesce(created_by, 'restore'), ? FROM old.packages "
        "WHERE id NOT IN (SELECT id FROM main.packages)",
        (now,),
    )
    con.execute(
        "INSERT OR IGNORE INTO main.id_reservations (package_id, device_id, granted_at) "
        "SELECT package_id, device_id, granted_at FROM old.id_reservations "
        "WHERE package_id NOT IN (SELECT id FROM main.packages)"
    )
    con.execute(
        "UPDATE main.pi_pairings SET device_id = NULL "
        "WHERE device_id IS NOT NULL AND device_id NOT IN (SELECT id FROM main.devices)"
    )


def _match_ha_links(con: sqlite3.Connection, marker: sqlite3.Row | None) -> None:
    """Der Merker ``ha_links_entity`` muss zu ``ha_links`` passen, und die kommen mit der Sicherung: also
    auch ihr Merker, selbst wenn ein laufender Stowly sonst seine ``server_config`` behält. Hat die Sicherung
    keinen (älter als 0.4.0), weiß niemand, zu welcher Liste ihre Artikel gehören: Stowly vergisst sie und
    löst die Bindungen der Einkaufsliste. Nichts wird abgehakt; der nächste Abgleich mit Home Assistant
    setzt den Merker und spiegelt die offenen Einträge neu (``bring.BringSync._adopt``)."""
    con.execute("DELETE FROM main.server_config WHERE key = ?", (haconfig.LINKS_ENTITY,))
    if marker is not None:
        con.execute(
            "INSERT INTO main.server_config (key, value, updated_at, updated_by) VALUES (?, ?, ?, NULL)",
            (marker["key"], marker["value"], marker["updated_at"]),
        )
        return
    con.execute("DELETE FROM main.ha_links")
    con.execute("UPDATE main.shopping_items SET bring_key = NULL WHERE bring_key IS NOT NULL")


def _build_swap(folder: Path, database: Path, manifest: dict[str, Any], now: str) -> Path:
    """Schritt 3: die Kopie, die an den Platz der Datenbank kommt. Immer neu aus ``pending.sqlite3``."""
    swap = folder / SWAP_DB
    _remove(swap)
    _copy(folder / PENDING_DB, swap)
    running = manifest.get("mode") != "first_start"
    # Abgesichert: Kein Trigger der Kopie läuft, wenn die Zugänge aus der laufenden Datenbank hineinkommen.
    con = open_copy(swap)
    con.row_factory = sqlite3.Row
    try:
        con.execute("PRAGMA journal_mode = DELETE")
        con.execute("PRAGMA foreign_keys = OFF")
        if running and database.is_file():
            con.execute("ATTACH DATABASE ? AS old", (str(database),))
        try:
            with db.transaction(con):
                marker = con.execute(
                    "SELECT * FROM main.server_config WHERE key = ?", (haconfig.LINKS_ENTITY,)
                ).fetchone()
                if running and database.is_file():
                    _take_over(con, now)
                _match_ha_links(con, marker)
                con.execute(
                    "INSERT INTO meta (key, value) VALUES ('dataset_id', ?) "
                    "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                    (manifest["dataset_id"],),
                )
                events.record(
                    con,
                    at=now,
                    recorded_at=now,
                    device_id=manifest.get("device_id"),
                    type="server.restored",
                    entity="server",
                    entity_id="restore",
                    data={
                        "kind": manifest.get("kind"),
                        "source": manifest.get("source"),
                        "first_start": not running,
                        "schema_version": manifest.get("schema_version"),
                    },
                )
        finally:
            if running and database.is_file():
                con.execute("DETACH DATABASE old")
        if con.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise _SwapFailed(NOT_TAKEN_OVER)
        if not _rows_ok(con.execute("PRAGMA quick_check").fetchall()):
            raise _SwapFailed(NOT_TAKEN_OVER)
    except sqlite3.Error:
        log.exception("Zurückspielen: Die Zugänge ließen sich nicht übernehmen")
        raise _SwapFailed(NOT_TAKEN_OVER) from None
    finally:
        con.close()
    _fsync(swap)
    return swap


def _discard(folder: Path) -> None:
    """Verwirft ein bereitgelegtes Zurückspielen; das Manifest zuerst."""
    _remove(folder / PENDING_MANIFEST, folder / PENDING_DB, folder / SWAP_DB, folder / PREVIOUS_NEXT)
    safefile.sync_directory(folder)


def _remember(folder: Path, value: dict[str, Any]) -> None:
    try:
        _write_json(folder, LAST, value)
    except OSError:
        log.warning("Zurückspielen: last.json ließ sich nicht schreiben", exc_info=True)


def _finish(folder: Path, manifest: dict[str, Any], now: datetime) -> RestoreState:
    """Nach dem Punkt ohne Wiederkehr: ``previous.sqlite3``, ``last.json``, Aufräumen. Wiederholbar; die
    Datenbank selbst und ihre Begleitdateien fasst dieser Schritt nie an."""
    first_start = manifest.get("mode") == "first_start"
    undo = manifest.get("kind") == "undo"
    staged = folder / PREVIOUS_NEXT
    if staged.exists():
        _replace(staged, folder / PREVIOUS_DB)
    state = RestoreState.UNDONE if undo else RestoreState.DONE
    _remember(
        folder,
        {
            "state": state.value,
            "at": format_timestamp(now),
            "message": UNDONE_MESSAGE if undo else DONE_MESSAGE,
            "kind": manifest.get("kind"),
            "mode": manifest.get("mode"),
            "source": manifest.get("source"),
            # Beim ersten Start gibt es kein Rückgängig; die alte Datei bleibt trotzdem 7 Tage liegen.
            "undo_until": None if first_start else format_timestamp(now + UNDO_FOR),
            "dataset_id": manifest.get("dataset_id"),
        },
    )
    _remove(folder / PENDING_MANIFEST, folder / PENDING_DB, folder / SWAP_DB)
    safefile.sync_directory(folder)
    return state


def _sweep(folder: Path, *, keep: set[str] | frozenset[str] = frozenset()) -> None:
    """Löscht hochgeladene Dateien, Arbeitsdateien und Kandidaten außer ``keep`` (samt ihrem ``-journal``).

    Beim Start alle: Was ein früherer Prozess hochgeladen oder geprüft hat, gilt nicht mehr (die Kennungen
    lebten nur in seinem Arbeitsspeicher). Im Betrieb (``RestoreManager.sweep``) alle ohne Besitzer."""
    kept = {*keep, *(f"{name}-journal" for name in keep)}
    with contextlib.suppress(OSError):
        for entry in os.scandir(folder):
            if entry.name in kept:
                continue
            if _UPLOAD_NAME.fullmatch(entry.name) or _WORK_NAME.fullmatch(entry.name):
                with contextlib.suppress(OSError):
                    os.unlink(entry.path)


def resume(settings: Settings, *, now: datetime | None = None) -> RestoreState | None:
    """Beim Start, vor ``create_app``: spielt eine bereitgelegte Sicherung ein (Tausch, siehe oben).

    Liefert den neuen Stand (``done``, ``undone``, ``failed``) oder ``None``, wenn nichts bereitlag. Wirft
    nie: Ein Fehler behält die alte Datenbank, merkt ``failed`` und lässt Stowly normal starten.
    """
    now = now or datetime.now(UTC)
    folder = folder_of(settings)
    if not folder.is_dir():
        return None
    try:
        return _resume(settings, folder, now)
    except Exception:
        log.exception("Zurückspielen: Unerwarteter Fehler beim Start")
        manifest = _read_json(folder / PENDING_MANIFEST)
        if manifest is not None and _dataset_id(settings.database_path) == manifest.get("dataset_id"):
            # Der Tausch ist geschehen; nur das Aufräumen fehlt, das holt der nächste Start nach.
            return RestoreState.DONE
        with contextlib.suppress(Exception):
            _discard(folder)
        _remember(folder, {"state": "failed", "at": format_timestamp(now), "message": _failed(UNEXPECTED)})
        return RestoreState.FAILED


def _resume(settings: Settings, folder: Path, now: datetime) -> RestoreState | None:
    _sweep(folder)
    manifest_path = folder / PENDING_MANIFEST
    manifest = _read_json(manifest_path)
    if manifest is None:
        if manifest_path.exists():
            _discard(folder)
            _remember(folder, {"state": "failed", "at": format_timestamp(now), "message": _failed(CHANGED)})
            log.error("Zurückspielen: Das Manifest ist unbrauchbar; nichts wurde getauscht.")
            return RestoreState.FAILED
        # Ohne Manifest gehören auch diese Reste zu keinem Zurückspielen mehr.
        _remove(folder / PENDING_DB, folder / SWAP_DB, folder / PREVIOUS_NEXT)
        expire_previous(settings, now)
        return None
    database = settings.database_path
    if _dataset_id(database) == manifest.get("dataset_id"):
        # Ein früherer Start hat schon getauscht und ist danach abgebrochen: nur noch aufräumen.
        state = _finish(folder, manifest, now)
        log.info("Zurückspielen: Der Tausch war schon geschehen; aufgeräumt.")
        return state
    requested = _timestamp(manifest.get("requested_at"))
    try:
        if requested is None or now - requested > PENDING_FOR or requested - now > PENDING_FOR:
            raise _SwapFailed(TOO_LATE)
        if not isinstance(manifest.get("dataset_id"), str):
            raise _SwapFailed(CHANGED)
        _verify(folder / PENDING_DB, manifest)
        _quiesce(database)
        swap = _build_swap(folder, database, manifest, format_timestamp(now))
        if database.is_file():
            _link_or_copy(database, folder / PREVIOUS_NEXT)
            _fsync(folder / PREVIOUS_NEXT)
        if Path(f"{database}-wal").exists() or Path(f"{database}-journal").exists():
            raise _SwapFailed(STILL_OPEN)
    except _SwapFailed as exc:
        _discard(folder)
        _remember(
            folder,
            {
                "state": "failed",
                "at": format_timestamp(now),
                "message": _failed(exc.reason),
                "kind": manifest.get("kind"),
                "mode": manifest.get("mode"),
            },
        )
        log.error("Zurückspielen gescheitert: %s Die bisherige Datenbank läuft weiter.", exc.reason)
        return RestoreState.FAILED
    except OSError as exc:
        _discard(folder)
        reason = NO_SPACE_ON_SWAP if exc.errno == 28 else UNEXPECTED
        _remember(folder, {"state": "failed", "at": format_timestamp(now), "message": _failed(reason)})
        log.exception("Zurückspielen gescheitert; die bisherige Datenbank läuft weiter.")
        return RestoreState.FAILED
    # Der Punkt ohne Wiederkehr.
    database.parent.mkdir(parents=True, exist_ok=True)
    _replace(swap, database)
    safefile.sync_directory(database.parent)
    state = _finish(folder, manifest, now)
    log.info(
        "Zurückspielen: %s (%s). Alle Geräte holen den Bestand neu.",
        "rückgängig gemacht" if state is RestoreState.UNDONE else "Sicherung eingespielt",
        "erster Start" if manifest.get("mode") == "first_start" else "Zugänge behalten",
    )
    return state
