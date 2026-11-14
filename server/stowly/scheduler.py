"""Zeitplan: Aufgaben, die einmal am Tag laufen (docs/integrationen.md, Abschnitt 1).

Eine Schleife im Server nach dem Muster von ``off.OffWorker``: eine asyncio-Aufgabe im ``lifespan``
der App, eine eingereichte Uhr (``off.Clock``) und ``wake()``. Sie prüft jede Minute, zur vollen
Minute der Serveruhr, dazu sofort nach dem Start und nach ``wake()``, ob eine Aufgabe fällig ist.

**Fällig** ist eine Aufgabe, wenn es in ``STOWLY_TIMEZONE`` mindestens ihre Uhrzeit ist, sie heute
noch nicht lief (``job_runs.last_date``) und ihre eigene Bedingung gilt. Weil gefragt wird, ob die
Uhrzeit *erreicht* ist, und je Tag gemerkt wird, ob die Aufgabe lief, brauchen Sommer- und
Winterzeit keinen Sonderfall (``localtime``), und was der Server verpasst hat, holt er beim ersten
Takt nach dem Start nach.

Was blockiert (Datenbank, Packen, Verschlüsseln, Schreiben), läuft in einem eigenen Thread, damit
der Sync nicht wartet; jeder Zugriff auf die Datenbank öffnet eine eigene Verbindung. Eine Aufgabe,
die selbst ins Netz spricht (die Tagesnachricht über ``push.PushService``), läuft als Koroutine in
der Ereignisschleife und gibt ihre Datenbankarbeit selbst an einen Thread ab. Je Aufgabe läuft
höchstens ein Lauf zugleich. Ein Fehler in einer Aufgabe beendet die Schleife nie; er steht im Log
und in ``job_runs``.

Aufgaben: ``backup`` (``stowly.autobackup``) und ``push_daily`` (``stowly.daily``, Abschnitt 4.8) mit
dem Fenster der Tagesnachricht aus ``push_window`` und ``push_daily_due``.
"""

import asyncio
import contextlib
import inspect
import json
import logging
import sqlite3
from collections.abc import Awaitable, Sequence
from dataclasses import dataclass, field
from datetime import datetime, time, timedelta
from pathlib import Path
from typing import Any, Protocol
from zoneinfo import ZoneInfo

from stowly import db, localtime
from stowly.contract.timeutil import format_timestamp
from stowly.off import Clock

log = logging.getLogger("stowly.scheduler")

# So lange schläft die Schleife höchstens: bis zur nächsten vollen Minute.
TICK_S = 60.0
# So lange wartet das Herunterfahren auf einen laufenden Lauf (Docker beendet nach 15 Sekunden hart).
SHUTDOWN_WAIT_S = 8.0
# Etwas nach der vollen Minute aufwachen, nie knapp davor.
_TICK_MARGIN_S = 0.05

# Die Tagesnachricht kommt nach einem Ausfall höchstens bis 21 Uhr (docs/integrationen.md, 1.4).
PUSH_LATEST = time(21, 0)
PUSH_LATE_WINDOW = timedelta(hours=1)

_UNEXPECTED = "Unerwarteter Fehler (Einzelheiten im Log des Servers)."


# --- job_runs ----------------------------------------------------------------------------------


@dataclass(frozen=True)
class JobRun:
    """Der letzte Lauf einer Aufgabe, wie ihn ``job_runs`` festhält (docs/integrationen.md, 1.2)."""

    job: str
    last_date: str | None = None  # lokaler Tag des letzten abgeschlossenen Laufs, YYYY-MM-DD
    last_at: str | None = None  # Zeitpunkt (UTC) dieses Laufs
    last_error: str | None = None  # Fehler des letzten Versuchs; None nach einem Erfolg
    last_error_at: str | None = None
    state: dict[str, Any] = field(default_factory=dict)


def load_run(con: sqlite3.Connection, job: str) -> JobRun:
    row = con.execute("SELECT * FROM job_runs WHERE job = ?", (job,)).fetchone()
    if row is None:
        return JobRun(job)
    try:
        state = json.loads(row["state"])
    except ValueError:
        state = {}
    return JobRun(
        job=job,
        last_date=row["last_date"],
        last_at=row["last_at"],
        last_error=row["last_error"],
        last_error_at=row["last_error_at"],
        state=state if isinstance(state, dict) else {},
    )


def save_success(
    con: sqlite3.Connection,
    job: str,
    *,
    day: str,
    at: str,
    state: dict[str, Any],
    error: str | None = None,
) -> None:
    """Wie ``record_success``, aber in der Transaktion des Aufrufers.

    ``error`` ist für einen Lauf, der abgeschlossen ist und trotzdem nichts erreicht hat (die
    Tagesnachricht an kein einziges Abo): Er zählt für den Tag, der Satz steht als ``last_error``.
    """
    con.execute(
        "INSERT INTO job_runs (job, last_date, last_at, last_error, last_error_at, state) "
        "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (job) DO UPDATE SET last_date = excluded.last_date, "
        "last_at = excluded.last_at, last_error = excluded.last_error, "
        "last_error_at = excluded.last_error_at, state = excluded.state",
        (
            job,
            day,
            at,
            error,
            None if error is None else at,
            json.dumps(state, ensure_ascii=False, separators=(",", ":")),
        ),
    )


def record_success(con: sqlite3.Connection, job: str, *, day: str, at: str, state: dict[str, Any]) -> None:
    """Ein abgeschlossener Lauf: ``last_date`` = sein Tag, ``last_at``, kein Fehler, ``state``."""
    with db.transaction(con):
        save_success(con, job, day=day, at=at, state=state)


def record_failure(con: sqlite3.Connection, job: str, *, at: str, error: str) -> None:
    """Ein gescheiterter Versuch: Der Fehler steht da, der letzte gelungene Lauf bleibt."""
    with db.transaction(con):
        con.execute(
            "INSERT INTO job_runs (job, last_error, last_error_at) VALUES (?, ?, ?) "
            "ON CONFLICT (job) DO UPDATE SET last_error = excluded.last_error, "
            "last_error_at = excluded.last_error_at",
            (job, error, at),
        )


# --- Regeln ------------------------------------------------------------------------------------


def ran_today(run: JobRun, now: datetime, tz: ZoneInfo) -> bool:
    return run.last_date is not None and run.last_date >= localtime.today(now, tz).isoformat()


def daily_due(run: JobRun, now: datetime, tz: ZoneInfo, hhmm: str) -> bool:
    """Bedingungen 1 und 2 aus docs/integrationen.md 1.2: Uhrzeit erreicht, heute noch nicht gelaufen."""
    return localtime.reached(now, tz, hhmm) and not ran_today(run, now, tz)


def push_window(notify_time: str) -> tuple[time, time | None]:
    """Fenster der Tagesnachricht als ``(von, bis ausschließlich)``; ``bis`` None heißt Mitternacht.

    Vor 21:00: von ``notify_time`` bis 21:00. Um oder nach 21:00: eine Stunde ab ``notify_time``,
    höchstens bis Mitternacht (docs/integrationen.md, 1.4).
    """
    start = localtime.parse_time_of_day(notify_time)
    if start < PUSH_LATEST:
        return start, PUSH_LATEST
    end = datetime.combine(datetime.min.date(), start) + PUSH_LATE_WINDOW
    return start, (end.time() if end.date() == datetime.min.date() else None)


def in_push_window(now: datetime, tz: ZoneInfo, notify_time: str) -> bool:
    start, end = push_window(notify_time)
    clock = localtime.local(now, tz).time()
    return start <= clock and (end is None or clock < end)


def push_daily_due(run: JobRun, now: datetime, tz: ZoneInfo, notify_time: str) -> bool:
    """Ist die Tagesnachricht fällig? Nur in ihrem Fenster, und nur einmal am Tag.

    Außerhalb des Fensters fällt sie für diesen Tag aus und wird nicht am nächsten nachgeholt. Wer
    ``notify_time`` ändert, nachdem sie heute lief, bekommt heute keine zweite.
    """
    return in_push_window(now, tz, notify_time) and not ran_today(run, now, tz)


# --- Die Schleife ------------------------------------------------------------------------------


def seconds_to_next_tick(now: datetime) -> float:
    """Bis zur nächsten vollen Minute der Serveruhr, ein wenig danach."""
    return TICK_S - (now.second + now.microsecond / 1_000_000) + _TICK_MARGIN_S


class Job(Protocol):
    """Eine Aufgabe des Zeitplans."""

    name: str

    def due(self, run: JobRun, now: datetime) -> bool:
        """Fällig? Liest nur; ``run`` ist der Stand aus ``job_runs``."""
        ...

    def run(self, now: datetime) -> None | Awaitable[None]:
        """Ein Lauf. Hält Erfolg und Fehler selbst in ``job_runs`` fest.

        Eine gewöhnliche Funktion läuft im eigenen Thread; eine Koroutine (``async def``) in der
        Ereignisschleife, und was dort blockiert, gibt sie selbst an einen Thread ab.
        """
        ...


class Scheduler:
    """Prüft jede Minute, welche Aufgabe fällig ist, und startet sie im eigenen Thread."""

    def __init__(self, database_path: Path, jobs: Sequence[Job], *, clock: Clock | None = None) -> None:
        self._path = database_path
        self._jobs = list(jobs)
        self._clock = clock or Clock()
        self._wake = asyncio.Event()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._running: dict[str, asyncio.Task[None]] = {}
        self._stopping = False
        # ``wake`` kam, während ein Lauf noch lief: nach seinem Ende noch einmal prüfen.
        self._again = False

    @property
    def jobs(self) -> list[str]:
        return [job.name for job in self._jobs]

    async def run(self) -> None:
        """Läuft bis ``stop``. Ein Fehler beendet die Schleife nie."""
        self._loop = asyncio.get_running_loop()
        while not self._stopping:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Zeitplan: unerwarteter Fehler beim Prüfen der Aufgaben")
            if not self._stopping:
                await self._idle()

    def wake(self) -> None:
        """Gleich noch einmal prüfen. Darf aus jedem Thread gerufen werden."""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        loop.call_soon_threadsafe(self._woken)

    def _woken(self) -> None:
        self._wake.set()
        if self._running:
            self._again = True

    def stop(self) -> None:
        """Die Schleife endet nach dem laufenden Takt; neue Läufe beginnen nicht mehr.

        Nicht abbrechen: Ein Takt, der gerade in seinem Thread die Datenbank liest, soll fertig
        werden, bevor das Herunterfahren weitergeht. Nur in der Ereignisschleife aufrufen.
        """
        self._stopping = True
        self._wake.set()

    async def _idle(self) -> None:
        """Wartet bis zur nächsten vollen Minute der Serveruhr oder bis ``wake``."""
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self._wake.wait(), seconds_to_next_tick(self._clock.now()))
        self._wake.clear()

    async def tick(self) -> list[asyncio.Task[None]]:
        """Startet jede fällige Aufgabe, die nicht schon läuft, in ihrer Reihenfolge."""
        now = self._clock.now()
        idle = [job for job in self._jobs if job.name not in self._running]
        if not idle:
            return []
        due = await asyncio.to_thread(self._due, idle, now)
        started: list[asyncio.Task[None]] = []
        for job in idle:
            if job.name not in due or self._stopping:
                continue
            task = asyncio.create_task(self._execute(job, now), name=f"stowly-job-{job.name}")
            self._running[job.name] = task
            task.add_done_callback(lambda _task, name=job.name: self._finished(name))
            started.append(task)
        return started

    def _finished(self, name: str) -> None:
        """Ein Lauf ist zu Ende. Kam ``wake`` währenddessen, wird gleich noch einmal geprüft.

        Der Takt nach ``wake`` hat die Aufgabe übergangen, weil sie noch lief; ohne diesen Schritt
        bliebe es bis zur nächsten vollen Minute dabei. Sonst bleibt es beim Takt: Eine Aufgabe, die
        immer wieder scheitert, versucht es so höchstens einmal je Minute.
        """
        self._running.pop(name, None)
        if self._again:
            self._again = False
            self._wake.set()

    async def run_once(self) -> list[str]:
        """Ein Takt, der wartet, bis die gestarteten Läufe fertig sind. Für Tests."""
        tasks = await self.tick()
        await asyncio.gather(*tasks)
        return [task.get_name().removeprefix("stowly-job-") for task in tasks]

    async def aclose(self, timeout_s: float = SHUTDOWN_WAIT_S) -> None:
        """Beim Herunterfahren: auf laufende Läufe warten, höchstens ``timeout_s`` Sekunden.

        Ein Lauf sitzt in einem Thread und lässt sich nicht abbrechen. Endet er nicht rechtzeitig,
        bleibt höchstens eine verschlüsselte Zwischendatei liegen; die räumt der nächste Lauf weg.
        """
        self.stop()
        running = list(self._running.values())
        if running:
            await asyncio.wait(running, timeout=timeout_s)

    def _due(self, jobs: Sequence[Job], now: datetime) -> set[str]:
        con = db.connect(self._path)
        try:
            due: set[str] = set()
            for job in jobs:
                try:
                    if job.due(load_run(con, job.name), now):
                        due.add(job.name)
                except Exception:
                    log.exception("Zeitplan: Ist %s fällig? Die Prüfung ist fehlgeschlagen", job.name)
            return due
        finally:
            con.close()

    async def _execute(self, job: Job, now: datetime) -> None:
        try:
            if inspect.iscoroutinefunction(job.run):
                await job.run(now)
            else:
                await asyncio.to_thread(job.run, now)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Zeitplan: Die Aufgabe %s ist unerwartet fehlgeschlagen", job.name)
            await asyncio.to_thread(self._failed, job.name, now)

    def _failed(self, name: str, now: datetime) -> None:
        con = db.connect(self._path)
        try:
            record_failure(con, name, at=format_timestamp(now), error=_UNEXPECTED)
        except Exception:
            log.exception("Zeitplan: Der Fehler von %s ließ sich nicht vermerken", name)
        finally:
            con.close()
