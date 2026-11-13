"""Auftragsdienst: annehmen, einreihen, drucken, nie doppelt (docs/etiketten.md, 5.3 und 5.4).

* Einreichen prüft, rendert sofort und reiht ein. Was sich nicht rendern lässt, wird nicht angenommen.
* Je Drucker druckt ein Arbeiter der Reihe nach.
* Dieselbe Kennung mit demselben Inhalt liefert den vorhandenen Zustand, mit anderem Inhalt 409.
* Der Zustand ``printing`` liegt sicher im Speicher, **bevor** der Treiber beginnt. Stirbt der
  Dienst mittendrin, findet der nächste Lauf den Auftrag als ``printing`` vor und führt ihn als
  ``unknown``; gedruckt wird er nie von selbst noch einmal.
* Jeder Zustandswechsel geht in seiner Reihenfolge an einen Beobachter. Daran hängt der Server
  sein Fortschreiben der Etiketten.

Der Dienst ist für Aufrufe aus mehreren Threads gebaut; seine Methoden blockieren (Rendern,
Warten) und gehören deshalb nicht in eine Ereignisschleife.
"""

import logging
import threading
import time
from collections import deque
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Protocol

from PIL import Image

from stowly_print import render as rendering
from stowly_print.drivers.base import Driver
from stowly_print.model import (
    FINAL_STATES,
    JOB_ERROR_CANCELLED,
    JOB_ERROR_INTERRUPTED,
    MAX_QUEUED_JOBS,
    MIN_REMEMBERED_JOBS,
    Capabilities,
    DriverStatus,
    Job,
    JobError,
    JobRequest,
    JobState,
    PrinterError,
    PrinterInfo,
    PrintOutcome,
    ServiceError,
)
from stowly_print.store import JobRecord, JobStore, MemoryStore

log = logging.getLogger("stowly_print.service")

HTTP_STATUS: dict[ServiceError, int] = {
    ServiceError.INVALID_REQUEST: 400,
    ServiceError.UNAUTHORIZED: 401,
    ServiceError.NOT_FOUND: 404,
    ServiceError.UNKNOWN_PRINTER: 404,
    ServiceError.JOB_CONFLICT: 409,
    ServiceError.BOOT_MISMATCH: 409,
    ServiceError.NOT_CANCELLABLE: 409,
    ServiceError.NOT_PENDING: 409,
    ServiceError.RENDER_FAILED: 422,
    ServiceError.QUEUE_FULL: 503,
}

# Klartext zu den Fehlercodes eines Auftrags (``Job.error.message``).
ERROR_TEXTS: dict[str, str] = {
    PrinterError.NO_MEDIA.value: "Die Etiketten sind leer.",
    PrinterError.MEDIA_MISMATCH.value: "Es ist eine andere Rolle eingelegt als eingerichtet.",
    PrinterError.COVER_OPEN.value: "Der Deckel des Druckers ist offen.",
    PrinterError.CUTTER_JAM.value: "Das Messer des Druckers klemmt.",
    PrinterError.OVERHEATED.value: "Der Drucker ist überhitzt.",
    PrinterError.BUSY.value: "Der Drucker ist belegt.",
    PrinterError.OFFLINE.value: "Der Drucker ist nicht erreichbar.",
    PrinterError.CONFIG.value: "Die Angaben zum Drucker passen nicht zum Treiber.",
    PrinterError.UNKNOWN.value: "Der Drucker meldet einen Fehler, den der Dienst nicht kennt.",
    JOB_ERROR_CANCELLED: "Der Auftrag wurde verworfen.",
    JOB_ERROR_INTERRUPTED: "Der Druck wurde mittendrin unterbrochen. Ob gedruckt wurde, ist offen.",
    ServiceError.UNKNOWN_PRINTER.value: "Diesen Drucker gibt es nicht mehr.",
    ServiceError.RENDER_FAILED.value: "Das Etikett lässt sich für diesen Drucker nicht rendern.",
}

# So lange gilt ein abgefragter Druckerzustand, bevor das Gerät erneut gefragt wird.
STATUS_TTL_S = 2.0


class ServiceFault(Exception):
    """Ein Fehler, der als Antwort im Vertragsformat beim Aufrufer ankommt."""

    def __init__(self, code: ServiceError, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details

    @property
    def status(self) -> int:
        return HTTP_STATUS[self.code]


# --------------------------------------------------------------------------- Drucker des Dienstes


@dataclass(frozen=True)
class PrinterEntry:
    """Ein Drucker, wie ihn der Dienst führt."""

    name: str
    driver_name: str  # "brother_ql", "image"
    model: str | None
    driver: Driver


class Printers(Protocol):
    """Woher der Dienst seine Drucker nimmt. Am Pi fest, am Server aus dem Datenbestand."""

    def names(self) -> list[str]:
        """Alle Drucker in fester Reihenfolge."""
        ...

    def default(self) -> str | None:
        """Der Drucker für Aufträge ohne ``printer``; ``None`` = es gibt keinen Standarddrucker."""
        ...

    def lookup(self, name: str) -> PrinterEntry | None: ...


class StaticPrinters:
    """Eine feste Liste. Der erste Eintrag ist der Standarddrucker."""

    def __init__(self, entries: Sequence[PrinterEntry]) -> None:
        self._entries = {entry.name: entry for entry in entries}
        if len(self._entries) != len(entries):
            raise ValueError("Zwei Drucker tragen denselben Namen.")

    def names(self) -> list[str]:
        return list(self._entries)

    def default(self) -> str | None:
        return next(iter(self._entries), None)

    def lookup(self, name: str) -> PrinterEntry | None:
        return self._entries.get(name)


# --------------------------------------------------------------------------- Dienst


@dataclass(frozen=True)
class JobEvent:
    """Ein Zustandswechsel, wie ihn der Beobachter erfährt."""

    job: Job
    previous: JobState | None  # None = eben angenommen


@dataclass
class _Entry:
    record: JobRecord
    # Schon gerendert; fehlt nach einem Neustart und wird dann vor dem Druck neu erzeugt.
    image: Image.Image | None = None
    image_for: Capabilities | None = None
    # Der zuletzt an den Beobachter gemeldete Zustand.
    announced: JobState | None = None


@dataclass
class _Status:
    status: DriverStatus
    at: float
    driver: Driver = field(repr=False)


def _printable(request: JobRequest) -> dict[str, Any]:
    """Was vom Auftrag zum Drucken gebraucht wird."""
    return {
        "template": request.template,
        "data": request.data,
        "png": request.png,
        "copies": request.copies,
        "cut": request.cut,
    }


def _status(driver: Driver) -> DriverStatus:
    """``Driver.status`` wirft laut Vertrag nie. Tut es ein Treiber doch, ist der Zustand unbekannt."""
    try:
        return driver.status()
    except Exception:
        log.exception("Ein Treiber hat beim Abfragen des Zustands eine Ausnahme geworfen.")
        return DriverStatus(
            reachable=False, ready=None, media_detected=None, errors=[PrinterError.UNKNOWN.value]
        )


class PrintService:
    """Die Warteschlangen eines Druckdienstes.

    ``observer`` erfährt jeden Zustandswechsel in seiner Reihenfolge, ``status_observer`` jeden
    frisch abgefragten Druckerzustand. Beide laufen im Thread dessen, der den Wechsel auslöst,
    und dürfen den Dienst lesen, aber nichts einreichen oder verwerfen.

    ``admit`` darf einen neuen Auftrag vor dem Annehmen ablehnen (wirft ``ServiceFault``):
    Der Server lässt so nur Etiketten zu, die es in seinem Bestand gibt.

    ``retention_s``: Erledigte Aufträge, die älter sind und nicht zu den jüngsten
    ``MIN_REMEMBERED_JOBS`` gehören, werden vergessen. ``None`` = nur die Anzahl zählt (Pi ohne Uhr).
    """

    def __init__(
        self,
        printers: Printers,
        store: JobStore | None = None,
        *,
        observer: Callable[[JobEvent], None] | None = None,
        status_observer: Callable[[str, DriverStatus], None] | None = None,
        admit: Callable[[str, JobRequest], None] | None = None,
        fonts: rendering.Fonts | None = None,
        max_queued: int = MAX_QUEUED_JOBS,
        remembered: int = MIN_REMEMBERED_JOBS,
        retention_s: float | None = None,
        status_ttl_s: float = STATUS_TTL_S,
        clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], float] = time.time,
    ) -> None:
        self._printers = printers
        self._store: JobStore = store or MemoryStore()
        self._observer = observer
        self._status_observer = status_observer
        self._admit = admit
        self._fonts = fonts
        self._max_queued = max_queued
        self._remembered = remembered
        self._retention_s = retention_s
        self._status_ttl_s = status_ttl_s
        self._clock = clock
        self._wall_clock = wall_clock

        self.boot_id = self._store.boot_id
        self._started_at = clock()
        self._lock = threading.Condition()
        self._observer_lock = threading.Lock()
        self._jobs: dict[str, _Entry] = {}
        self._queues: dict[str, deque[str]] = {}
        self._workers: dict[str, threading.Thread] = {}
        self._events: deque[tuple[_Entry, JobEvent]] = deque()
        self._statuses: dict[str, _Status] = {}
        self._status_lock = threading.Lock()
        self._pool: ThreadPoolExecutor | None = None
        self._sequence = 0
        self._started = False
        self._closed = False
        # Nach dem Schließen des Speichers: Ein Arbeiter, der jetzt noch fertig wird, schweigt.
        self._abandoned = False

    # ------------------------------------------------------------------ Lebenslauf

    def start(self) -> None:
        """Liest den Speicher und nimmt die Arbeit auf. Was beim Absturz druckte, wird ``unknown``."""
        with self._lock:
            if self._started:
                return
            self._started = True
            for record in self._store.load():
                entry = _Entry(record=record)
                self._jobs[record.id] = entry
                self._sequence = max(self._sequence, record.sequence)
                if record.state == JobState.PRINTING:
                    # Mitten im Druck gestorben: Niemand weiß, ob das Etikett herauskam.
                    self._finish(entry, JobState.UNKNOWN, self._error(JOB_ERROR_INTERRUPTED))
                elif record.state == JobState.QUEUED:
                    self._queues.setdefault(record.printer, deque()).append(record.id)
                else:
                    entry.announced = record.state
            for name in list(self._queues):
                if self._queues[name]:
                    self._ensure_worker(name)
        self._deliver()

    def close(self, grace_s: float = 0.2) -> None:
        """Beendet die Arbeiter und schließt den Speicher.

        Ein gerade laufender Druck wird nicht abgebrochen und höchstens ``grace_s`` Sekunden
        abgewartet. Dauert er länger, bleibt sein Auftrag als ``printing`` im Speicher stehen und
        ist nach dem nächsten Start ``unknown``; gemeldet wird von diesem Lauf nichts mehr.
        """
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._lock.notify_all()
            workers = list(self._workers.values())
        deadline = self._clock() + max(0.0, grace_s)
        for worker in workers:
            worker.join(timeout=max(0.0, deadline - self._clock()))
        with self._status_lock:
            if self._pool is not None:
                self._pool.shutdown(wait=False, cancel_futures=True)
        with self._lock:
            self._abandoned = True
            self._store.close()

    @property
    def uptime_s(self) -> float:
        return self._clock() - self._started_at

    # ------------------------------------------------------------------ Aufträge

    def submit(self, job_id: str, request: JobRequest) -> tuple[Job, bool]:
        """Reicht einen Auftrag ein. Liefert ``(auftrag, neu)``; ``neu`` ist falsch, wenn er schon bekannt war."""
        content_hash = request.content_hash()
        with self._lock:
            known = self._recognise(job_id, request, content_hash)
            if known is not None:
                return known, False
            entry = self._resolve(request.printer)
            self._check_room()
        if self._admit is not None:
            self._admit(job_id, request)
        capabilities = entry.driver.capabilities()
        image = self._render(request, capabilities)

        with self._lock:
            # Währenddessen kann derselbe Auftrag ein zweites Mal angekommen sein.
            known = self._recognise(job_id, request, content_hash)
            if known is not None:
                return known, False
            self._check_room()
            now = self._wall_clock()
            self._sequence += 1
            record = JobRecord(
                id=job_id,
                sequence=self._sequence,
                printer=entry.name,
                content_hash=content_hash,
                state=JobState.QUEUED,
                error=None,
                request=_printable(request),
                accepted_at=now,
                updated_at=now,
            )
            self._store.save(record)
            job_entry = _Entry(record=record, image=image, image_for=capabilities)
            self._jobs[job_id] = job_entry
            self._queues.setdefault(entry.name, deque()).append(job_id)
            self._events.append((job_entry, JobEvent(job=self._snapshot(job_entry), previous=None)))
            self._ensure_worker(entry.name)
            self._lock.notify_all()
            job = self._snapshot(job_entry)
        self._deliver()
        return job, True

    def get(self, job_id: str) -> Job:
        with self._lock:
            return self._snapshot(self._known(job_id))

    def wait(self, job_id: str, timeout_s: float) -> Job:
        """Wartet höchstens ``timeout_s`` auf den Endzustand und liefert den Stand von dann.

        „Endzustand" heißt hier auch: Der Beobachter hat ihn schon erfahren. Wer die Antwort
        bekommt, findet am Server also den fortgeschriebenen Stand des Etiketts vor.
        """
        deadline = self._clock() + max(0.0, timeout_s)
        with self._lock:
            while True:
                entry = self._known(job_id)
                settled = entry.record.state in FINAL_STATES and entry.announced == entry.record.state
                remaining = deadline - self._clock()
                if settled or self._closed or remaining <= 0:
                    return self._snapshot(entry)
                self._lock.wait(min(remaining, 1.0))

    def cancel(self, job_id: str) -> Job:
        """Verwirft einen Auftrag, solange er wartet. Danach ist er ``failed`` mit ``cancelled``."""
        with self._lock:
            entry = self._known(job_id)
            record = entry.record
            already = (
                record.state == JobState.FAILED
                and record.error is not None
                and record.error.code == JOB_ERROR_CANCELLED
            )
            if already:
                # Eine wiederholte Anfrage bekommt dieselbe Antwort wie die erste.
                return self._snapshot(entry)
            if record.state != JobState.QUEUED:
                raise ServiceFault(
                    ServiceError.NOT_CANCELLABLE,
                    "Der Auftrag wartet nicht mehr und lässt sich nicht verwerfen.",
                    {"state": record.state.value},
                )
            self._queues[record.printer].remove(job_id)
            self._finish(entry, JobState.FAILED, self._error(JOB_ERROR_CANCELLED))
            job = self._snapshot(entry)
        self._deliver()
        return job

    def image_path(self, job_id: str) -> Any:
        """Der Pfad zum gerenderten Etikett eines Auftrags (nur beim Bild-Treiber), sonst ``None``."""
        with self._lock:
            printer = self._known(job_id).record.printer
        entry = self._printers.lookup(printer)
        locate = None if entry is None else getattr(entry.driver, "image_path", None)
        return None if locate is None else locate(job_id)

    def render(self, template: Any, data: Any, printer: str | None) -> bytes:
        """Vorschau als PNG. Ohne ``printer`` für den Standarddrucker, sonst für die Vorgabe des Vertrags."""
        capabilities: Capabilities | None = None
        if printer is not None or self._printers.default() is not None:
            capabilities = self._resolve(printer).driver.capabilities()
        try:
            image = rendering.render(template, data, capabilities, fonts=self._fonts)
        except rendering.RenderError as exc:
            raise ServiceFault(ServiceError.RENDER_FAILED, str(exc)) from exc
        return rendering.to_png(image)

    def waiting(self) -> int:
        with self._lock:
            return sum(len(queue) for queue in self._queues.values())

    # ------------------------------------------------------------------ Drucker

    def printers(self, *, fresh: bool = False) -> list[PrinterInfo]:
        """Alle Drucker mit Fähigkeiten und Zustand, in fester Reihenfolge."""
        entries = [entry for entry in map(self._printers.lookup, self._printers.names()) if entry is not None]
        statuses = self._status_of(entries, fresh=fresh)
        return [
            PrinterInfo(
                name=entry.name,
                driver=entry.driver_name,
                model=entry.model,
                capabilities=entry.driver.capabilities(),
                status=statuses[entry.name],
            )
            for entry in entries
        ]

    def _status_of(self, entries: Sequence[PrinterEntry], *, fresh: bool) -> dict[str, DriverStatus]:
        now = self._clock()
        result: dict[str, DriverStatus] = {}
        stale: list[PrinterEntry] = []
        with self._status_lock:
            for entry in entries:
                cached = self._statuses.get(entry.name)
                usable = (
                    cached is not None
                    and cached.driver is entry.driver
                    and not fresh
                    and now - cached.at < self._status_ttl_s
                )
                if usable and cached is not None:
                    result[entry.name] = cached.status
                else:
                    stale.append(entry)
        if len(stale) == 1:
            fetched = [_status(stale[0].driver)]
        elif stale:
            # Nebeneinander fragen: Ein ausgeschalteter Netzwerkdrucker hält die anderen nicht auf.
            with self._status_lock:
                if self._pool is None:
                    self._pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="stowly-print-status")
                pool = self._pool
            fetched = list(pool.map(lambda entry: _status(entry.driver), stale))
        else:
            fetched = []
        for entry, status in zip(stale, fetched, strict=True):
            with self._status_lock:
                self._statuses[entry.name] = _Status(status=status, at=self._clock(), driver=entry.driver)
            result[entry.name] = status
            self._tell_status(entry.name, status)
        return result

    def _tell_status(self, name: str, status: DriverStatus) -> None:
        if self._status_observer is None:
            return
        try:
            self._status_observer(name, status)
        except Exception:
            log.exception("Der Beobachter des Druckerzustands ist gescheitert.")

    # ------------------------------------------------------------------ intern: prüfen

    def _error(self, code: str, message: str | None = None) -> JobError:
        return JobError(code=code, message=message or ERROR_TEXTS.get(code, code))

    def _known(self, job_id: str) -> _Entry:
        entry = self._jobs.get(job_id)
        if entry is None:
            raise ServiceFault(ServiceError.NOT_FOUND, "Diesen Auftrag kennt der Druckdienst nicht.")
        return entry

    def _recognise(self, job_id: str, request: JobRequest, content_hash: str) -> Job | None:
        """Prüft Lauf und Kennung. Liefert den vorhandenen Auftrag oder ``None`` für einen neuen."""
        if self._closed or not self._started:
            raise ServiceFault(ServiceError.QUEUE_FULL, "Der Druckdienst nimmt gerade keine Aufträge an.")
        if request.expect_boot_id is not None and request.expect_boot_id != self.boot_id:
            raise ServiceFault(
                ServiceError.BOOT_MISMATCH,
                "Der Druckdienst ist inzwischen neu gestartet.",
                {"boot_id": self.boot_id},
            )
        entry = self._jobs.get(job_id)
        if entry is None:
            return None
        if entry.record.content_hash != content_hash:
            raise ServiceFault(
                ServiceError.JOB_CONFLICT, "Diese Kennung trägt schon ein Auftrag mit anderem Inhalt."
            )
        return self._snapshot(entry)

    def _resolve(self, printer: str | None) -> PrinterEntry:
        name = printer if printer is not None else self._printers.default()
        entry = None if name is None else self._printers.lookup(name)
        if entry is None:
            message = (
                "Der Auftrag nennt keinen Drucker, und dieser Dienst hat keinen Standarddrucker."
                if printer is None
                else "Diesen Drucker hat der Druckdienst nicht."
            )
            raise ServiceFault(ServiceError.UNKNOWN_PRINTER, message)
        return entry

    def _check_room(self) -> None:
        if sum(len(queue) for queue in self._queues.values()) >= self._max_queued:
            raise ServiceFault(
                ServiceError.QUEUE_FULL,
                "Es warten schon zu viele Aufträge.",
                {"max": self._max_queued},
            )

    def _render(self, request: JobRequest | dict[str, Any], capabilities: Capabilities) -> Image.Image:
        content = _printable(request) if isinstance(request, JobRequest) else request
        try:
            if content.get("png") is not None:
                return rendering.decode_png(content["png"], capabilities)
            return rendering.render(
                content.get("template"), content.get("data"), capabilities, fonts=self._fonts
            )
        except rendering.RenderError as exc:
            raise ServiceFault(ServiceError.RENDER_FAILED, str(exc)) from exc

    def _snapshot(self, entry: _Entry) -> Job:
        record = entry.record
        position = None
        if record.state == JobState.QUEUED:
            queue = self._queues.get(record.printer)
            if queue is not None and record.id in queue:
                position = list(queue).index(record.id)
        return Job(
            id=record.id,
            state=record.state,
            printer=record.printer,
            boot_id=self.boot_id,
            error=record.error,
            position=position,
        )

    # ------------------------------------------------------------------ intern: Zustände

    def _finish(self, entry: _Entry, state: JobState, error: JobError | None) -> None:
        """Setzt einen Endzustand, hält ihn fest und reiht die Meldung ein. Unter ``_lock`` aufrufen."""
        previous = entry.record.state
        entry.record.state = state
        entry.record.error = error
        entry.record.request = None
        entry.record.updated_at = self._wall_clock()
        entry.image = None
        entry.image_for = None
        try:
            self._store.save(entry.record)
        except Exception:
            # Beim Herunterfahren ist der Speicher schon zu: Der Auftrag bleibt dort ``printing``
            # und ist nach dem Neustart ``unknown``. Das ist die sichere Richtung.
            log.warning(
                "Endzustand von Auftrag %s ließ sich nicht festhalten.", entry.record.id, exc_info=True
            )
        self._events.append((entry, JobEvent(job=self._snapshot(entry), previous=previous)))
        self._lock.notify_all()

    def _deliver(self) -> None:
        """Meldet anstehende Wechsel in ihrer Reihenfolge. Ohne ``_lock`` aufrufen."""
        with self._observer_lock:
            while True:
                with self._lock:
                    if not self._events:
                        return
                    entry, event = self._events.popleft()
                if self._observer is not None:
                    try:
                        self._observer(event)
                    except Exception:
                        log.exception("Der Beobachter ist bei Auftrag %s gescheitert.", event.job.id)
                with self._lock:
                    entry.announced = event.job.state
                    self._lock.notify_all()

    def _prune(self) -> None:
        """Vergisst die ältesten erledigten Aufträge, wenn es zu viele werden. Unter ``_lock`` aufrufen."""
        if len(self._jobs) <= self._remembered * 1.2:
            return
        finished = [
            entry.record
            for entry in self._jobs.values()
            if entry.record.state in FINAL_STATES and entry.announced == entry.record.state
        ]
        finished.sort(key=lambda record: record.sequence)
        surplus = finished[: max(0, len(finished) - self._remembered)]
        if self._retention_s is not None:
            horizon = self._wall_clock() - self._retention_s
            surplus = [record for record in surplus if record.updated_at < horizon]
        if not surplus:
            return
        gone = [record.id for record in surplus]
        try:
            self._store.forget(gone)
        except Exception:
            log.warning("Alte Aufträge ließen sich nicht aus dem Speicher entfernen.", exc_info=True)
            return
        for job_id in gone:
            del self._jobs[job_id]

    # ------------------------------------------------------------------ intern: Arbeiter

    def _ensure_worker(self, name: str) -> None:
        worker = self._workers.get(name)
        if worker is not None and worker.is_alive():
            return
        worker = threading.Thread(target=self._work, args=(name,), name=f"stowly-print-{name}", daemon=True)
        self._workers[name] = worker
        worker.start()

    def _work(self, name: str) -> None:
        while True:
            with self._lock:
                queue = self._queues[name]
                while not queue and not self._closed:
                    self._lock.wait()
                if self._closed:
                    return
                entry = self._jobs[queue.popleft()]
                request = self._begin(entry)
            self._deliver()
            if request is None:
                continue
            try:
                state, error = self._print(entry, request)
            except Exception:  # darf nicht vorkommen; der Auftrag bliebe sonst für immer ``printing``
                log.exception("Unerwarteter Fehler beim Druck von Auftrag %s.", entry.record.id)
                state, error = JobState.UNKNOWN, self._error(JOB_ERROR_INTERRUPTED)
            with self._lock:
                if self._abandoned:
                    return
                self._finish(entry, state, error)
                self._prune()
            self._deliver()
            self._after_job(name)

    def _begin(self, entry: _Entry) -> dict[str, Any] | None:
        """Führt einen Auftrag als ``printing`` und liefert seinen Inhalt. Unter ``_lock`` aufrufen.

        ``None`` heißt: Der Zustand ließ sich nicht festhalten, also wird nicht gedruckt.
        Sonst druckte ein Neustart mittendrin denselben Auftrag ein zweites Mal.
        """
        record = entry.record
        record.state = JobState.PRINTING
        record.updated_at = self._wall_clock()
        try:
            self._store.save(record)
        except Exception:
            log.exception("Auftrag %s ließ sich nicht als druckend festhalten: nicht gedruckt.", record.id)
            self._finish(entry, JobState.FAILED, self._error(PrinterError.UNKNOWN.value))
            return None
        self._events.append((entry, JobEvent(job=self._snapshot(entry), previous=JobState.QUEUED)))
        self._lock.notify_all()
        return dict(record.request or {})

    def _print(self, entry: _Entry, request: dict[str, Any]) -> tuple[JobState, JobError | None]:
        record = entry.record
        printer = self._printers.lookup(record.printer)
        if printer is None:
            return JobState.FAILED, self._error(ServiceError.UNKNOWN_PRINTER.value)
        driver = printer.driver
        capabilities = driver.capabilities()
        image = entry.image if entry.image_for == capabilities else None
        if image is None:
            # Nach einem Neustart, oder der Drucker wurde seit dem Annehmen umgestellt.
            try:
                image = self._render(request, capabilities)
            except ServiceFault as fault:
                return JobState.FAILED, self._error(ServiceError.RENDER_FAILED.value, fault.message)

        copies = int(request.get("copies") or 1)
        cut = bool(request.get("cut", True))
        for_job = getattr(driver, "for_job", None)
        outcomes: list[PrintOutcome] = []
        for copy in range(1, copies + 1):
            target = driver if for_job is None else for_job(record.id, copy)
            try:
                outcome = target.print(image, cut=cut)
            except Exception as exc:
                log.warning("Druck von Auftrag %s unterbrochen: %s", record.id, exc)
                return JobState.UNKNOWN, self._error(JOB_ERROR_INTERRUPTED)
            if outcome == PrintOutcome.FAILED:
                code = self._failure_code(driver)
                if not outcomes:
                    return JobState.FAILED, self._error(code)
                # Ein Teil ist gedruckt: weder sicher ganz noch sicher gar nicht.
                reason = ERROR_TEXTS.get(code, code)
                message = f"{len(outcomes)} von {copies} Etiketten gedruckt, dann: {reason}"
                return JobState.UNKNOWN, self._error(JOB_ERROR_INTERRUPTED, message)
            outcomes.append(outcome)
        confirmed = all(outcome == PrintOutcome.PRINTED for outcome in outcomes)
        return (JobState.PRINTED if confirmed else JobState.SENT), None

    def _failure_code(self, driver: Driver) -> str:
        """Warum ein Treiber ``failed`` gemeldet hat: sein eigener Vermerk, sonst sein Zustand."""
        code = getattr(driver, "last_error", None)
        if isinstance(code, str) and code:
            return code
        errors = _status(driver).errors
        return errors[0] if errors else PrinterError.UNKNOWN.value

    def _after_job(self, name: str) -> None:
        """Nach jedem Auftrag: den Zustand des Druckers frisch abfragen und weitersagen."""
        entry = self._printers.lookup(name)
        if entry is None or self._closed:
            return
        try:
            self._status_of([entry], fresh=True)
        except Exception:
            log.exception("Zustand von Drucker %s ließ sich nach dem Auftrag nicht abfragen.", name)
