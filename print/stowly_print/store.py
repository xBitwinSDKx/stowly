"""Auftragsspeicher: was der Dienst über jeden Auftrag festhält (docs/etiketten.md, 5.4).

Zwei Ausführungen hinter derselben Schnittstelle:

* ``MemoryStore`` für den Raspberry Pi: nichts überlebt den Neustart, und genau deshalb
  bekommt jeder Lauf eine neue ``boot_id``.
* ``FileStore`` für den Server: eine SQLite-Datei. ``boot_id`` und Aufträge überleben den
  Neustart; wartende Aufträge laufen weiter, einer, der gerade druckte, wird ``unknown``.

Der Dienst führt alle Aufträge selbst im Speicher. Der Speicher hier ist nur das, was einen
Neustart übersteht: ``save`` kehrt erst zurück, wenn der Stand sicher auf der Platte liegt.
"""

import json
import logging
import sqlite3
import threading
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from stowly_print.model import JobError, JobState

log = logging.getLogger("stowly_print.store")

SCHEMA_VERSION = 1


@dataclass
class JobRecord:
    """Ein Auftrag, wie ihn der Dienst festhält."""

    id: str
    sequence: int  # Reihenfolge des Annehmens
    printer: str
    content_hash: str
    state: JobState
    error: JobError | None
    # Inhalt zum Drucken (template, data, png, copies, cut). Nach dem Endzustand None:
    # Zum Wiedererkennen genügt ``content_hash``.
    request: dict[str, Any] | None
    accepted_at: float  # Uhrzeit des Rechners; nur für das Aufräumen am Server
    updated_at: float


class JobStore(Protocol):
    boot_id: str

    def load(self) -> list[JobRecord]:
        """Alle festgehaltenen Aufträge in der Reihenfolge des Annehmens."""
        ...

    def save(self, record: JobRecord) -> None:
        """Legt an oder schreibt fort. Kehrt erst zurück, wenn der Stand einen Absturz übersteht."""
        ...

    def forget(self, job_ids: Sequence[str]) -> None: ...

    def close(self) -> None: ...


class MemoryStore:
    """Hält nichts fest. Jeder Lauf ist ein neuer: neue ``boot_id``, kein Auftrag bekannt."""

    def __init__(self) -> None:
        self.boot_id = str(uuid.uuid4())

    def load(self) -> list[JobRecord]:
        return []

    def save(self, record: JobRecord) -> None:
        return None

    def forget(self, job_ids: Sequence[str]) -> None:
        return None

    def close(self) -> None:
        return None


class FileStore:
    """Aufträge und ``boot_id`` in einer SQLite-Datei.

    Ist die Datei nicht lesbar, wird sie beiseitegelegt und eine neue begonnen, mit neuer
    ``boot_id``: Die App erfährt so, dass der Dienst seine Aufträge nicht mehr kennt, und fragt
    bei offenen Etiketten nach, statt sie doppelt zu drucken.
    """

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self._con = self._open()
        except sqlite3.DatabaseError as exc:
            # Gesperrt oder nicht zu öffnen heißt nicht beschädigt: Dann lieber laut scheitern,
            # als die Aufträge eines noch laufenden Dienstes beiseitezulegen.
            if isinstance(exc, sqlite3.OperationalError):
                raise
            aside = self._set_aside()
            log.error(
                "Auftragsspeicher %s ist nicht lesbar (%s). Er liegt jetzt unter %s; es beginnt ein neuer.",
                self.path,
                exc,
                aside,
            )
            self._con = self._open()
        self.boot_id = self._boot_id()

    def _open(self) -> sqlite3.Connection:
        con = sqlite3.connect(str(self.path), isolation_level=None, check_same_thread=False, timeout=10.0)
        try:
            con.execute("PRAGMA journal_mode = WAL")
            # FULL: Ein bestätigter Stand übersteht auch den Stromausfall. Darauf beruht „nie doppelt".
            con.execute("PRAGMA synchronous = FULL")
            con.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            con.execute(
                "CREATE TABLE IF NOT EXISTS jobs ("
                "id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, printer TEXT NOT NULL, "
                "content_hash TEXT NOT NULL, state TEXT NOT NULL, error_code TEXT, error_message TEXT, "
                "request TEXT, accepted_at REAL NOT NULL, updated_at REAL NOT NULL)"
            )
            con.execute("CREATE INDEX IF NOT EXISTS jobs_sequence ON jobs (sequence)")
            version = con.execute("SELECT value FROM meta WHERE key = 'schema'").fetchone()
            if version is None:
                con.execute("INSERT INTO meta (key, value) VALUES ('schema', ?)", (str(SCHEMA_VERSION),))
            elif int(version[0]) > SCHEMA_VERSION:
                raise sqlite3.DatabaseError(f"Schema {version[0]} ist neuer als dieser Dienst")
            # Liest einmal alles: Eine beschädigte Datei fällt hier auf, nicht erst mitten im Betrieb.
            con.execute("SELECT count(*) FROM jobs").fetchone()
        except BaseException:
            con.close()
            raise
        return con

    def _set_aside(self) -> Path:
        number = 1
        while True:
            aside = self.path.with_name(f"{self.path.name}.defekt-{number}")
            if not aside.exists():
                break
            number += 1
        self.path.replace(aside)
        for suffix in ("-wal", "-shm"):
            extra = self.path.with_name(self.path.name + suffix)
            if extra.exists():
                extra.unlink()
        return aside

    def _boot_id(self) -> str:
        with self._lock:
            row = self._con.execute("SELECT value FROM meta WHERE key = 'boot_id'").fetchone()
            if row is not None:
                return str(row[0])
            boot_id = str(uuid.uuid4())
            self._con.execute("INSERT INTO meta (key, value) VALUES ('boot_id', ?)", (boot_id,))
            return boot_id

    def load(self) -> list[JobRecord]:
        with self._lock:
            rows = self._con.execute(
                "SELECT id, sequence, printer, content_hash, state, error_code, error_message, request, "
                "accepted_at, updated_at FROM jobs ORDER BY sequence"
            ).fetchall()
        records = []
        for row in rows:
            error = None if row[5] is None else JobError(code=row[5], message=row[6] or "")
            records.append(
                JobRecord(
                    id=row[0],
                    sequence=row[1],
                    printer=row[2],
                    content_hash=row[3],
                    state=JobState(row[4]),
                    error=error,
                    request=None if row[7] is None else json.loads(row[7]),
                    accepted_at=row[8],
                    updated_at=row[9],
                )
            )
        return records

    def save(self, record: JobRecord) -> None:
        request = None if record.request is None else json.dumps(record.request, ensure_ascii=False)
        with self._lock:
            self._con.execute(
                "INSERT INTO jobs (id, sequence, printer, content_hash, state, error_code, error_message, "
                "request, accepted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT (id) DO UPDATE SET state = excluded.state, error_code = excluded.error_code, "
                "error_message = excluded.error_message, request = excluded.request, "
                "updated_at = excluded.updated_at",
                (
                    record.id,
                    record.sequence,
                    record.printer,
                    record.content_hash,
                    record.state.value,
                    None if record.error is None else record.error.code,
                    None if record.error is None else record.error.message,
                    request,
                    record.accepted_at,
                    record.updated_at,
                ),
            )

    def forget(self, job_ids: Sequence[str]) -> None:
        with self._lock:
            self._con.execute("BEGIN IMMEDIATE")
            try:
                self._con.executemany("DELETE FROM jobs WHERE id = ?", [(job_id,) for job_id in job_ids])
            except BaseException:
                self._con.execute("ROLLBACK")
                raise
            self._con.execute("COMMIT")

    def close(self) -> None:
        with self._lock:
            self._con.close()
