"""Der Druckdienst im Server unter ``/print`` (docs/etiketten.md, 5.8).

Derselbe Dienst wie auf dem Raspberry Pi (``stowly_print``), eingebunden in den Server. Was hier
anders ist:

* **Drucker** sind die nicht gelöschten ``Printer`` mit ``connection = "server"``, unter ihrer
  ``id`` als Name, in der Reihenfolge ihres Anlegens. Sie werden bei jedem Auftrag und jeder
  Abfrage frisch aus der Datenbank gelesen: Was ein Sync-Befehl ändert, gilt sofort. Einen
  Standarddrucker gibt es nicht.
* **Anmeldung:** Jeder Aufruf braucht ein gültiges Geräte-Token, auch der lesende. Einen
  Nachweis (``proof``) gibt es nicht; hier bürgt die Verbindung selbst.
* **Nur bekannte Etiketten:** Angenommen wird ein Auftrag nur, wenn es das Etikett gibt und es
  aussteht (``pending``); sonst 404 ``not_found`` oder 409 ``not_pending``.
* **Fortschreiben:** Mit dem Annehmen und bei jedem Wechsel schreibt der Server Zustand,
  ``printer_id``, ``boot_id`` und ``error`` des Etiketts selbst, als Meldung zum jetzigen Zeitpunkt
  seiner Uhr (docs/sync-protokoll.md, 6.6). Ebenso den Zustand seiner Drucker
  (``printer_status``), höchstens einmal je Minute und Drucker, außer er hat sich geändert.
  Beides geschieht außerhalb eines Sync-Aufrufs, in eigener Verbindung und Transaktion.
* **Auftragsspeicher und ``boot_id``** liegen in ``<Datenverzeichnis>/print/jobs.sqlite3`` und
  überleben den Neustart; die Bilder des Bild-Treibers in ``<Datenverzeichnis>/print/images``.

Der Dienst entsteht erst, wenn die App bedient wird (``lifespan``): ``build_app`` fasst weder
Dateien noch die Datenbank an. Bis dahin, und wenn er nicht startet, antwortet ``/print`` mit 503.
"""

import json
import logging
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

from starlette.types import ASGIApp, Receive, Scope, Send

from stowly import auth, db, events
from stowly.api import sync as sync_api
from stowly.config import Settings
from stowly.contract.entities import PrintJobState
from stowly.contract.timeutil import format_timestamp
from stowly.sync.handlers import progress_after_outcome
from stowly_print.drivers import PrinterConfig, build_driver
from stowly_print.drivers.image import ImageDriver
from stowly_print.http import create_app as create_print_app
from stowly_print.http import error_response as print_error_response
from stowly_print.model import (
    FINAL_STATES,
    JOB_ERROR_CANCELLED,
    DriverStatus,
    Job,
    JobRequest,
    JobState,
    ServiceError,
    to_dict,
)
from stowly_print.render import Fonts
from stowly_print.service import JobEvent, PrinterEntry, PrintService, ServiceFault
from stowly_print.store import FileStore

log = logging.getLogger("stowly.print")

PRINT_DIR = "print"
STORE_FILE = "jobs.sqlite3"
IMAGE_DIR = "images"
# Am Server merkt sich der Dienst jeden Auftrag mindestens 90 Tage (docs/etiketten.md, 5.3).
RETENTION_S = 90 * 86400.0
# Zustand eines Druckers höchstens so oft schreiben, solange er sich nicht ändert.
STATUS_INTERVAL_S = 60.0
# Bilder des Bild-Treibers: höchstens 30 Tage und höchstens die jüngsten 1000 aufheben,
# aufgeräumt beim Start und danach höchstens einmal je Stunde.
IMAGE_MAX_AGE_S = 30 * 86400.0
IMAGE_KEEP = 1000
CLEANUP_INTERVAL_S = 3600.0

JOB_STATE_CLOCK = "state"  # dieselbe Feld-Uhr wie print.report (stowly/sync/handlers.py)


def monotonic() -> float:
    """Monotone Uhr für die Drosselung. Eigene Funktion, damit Tests sie vorstellen können."""
    return time.monotonic()


def server_stamp() -> str:
    """Die Serveruhr als Zeitstempel: dieselbe Uhr wie beim Sync, in Tests an einer Stelle anhaltbar."""
    return format_timestamp(sync_api.server_now())


def _dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


# --------------------------------------------------------------------------- Drucker


class ServerPrinters:
    """Die Drucker des Servers, frisch aus der Datenbank.

    Ein Treiber bleibt bestehen, solange sich die Angaben zum Drucker nicht ändern; so behält er
    seinen Zustand (etwa die Sperre eines USB-Geräts während eines Drucks). Neue Angaben ergeben
    beim nächsten Nachschlagen einen neuen Treiber.
    """

    def __init__(self, database: Path, image_dir: Path) -> None:
        self._database = database
        self._image_dir = image_dir
        self._lock = threading.Lock()
        self._entries: dict[str, tuple[str, PrinterEntry]] = {}

    def _query(self, sql: str, parameters: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
        con = db.connect(self._database)
        try:
            return con.execute(sql, parameters).fetchall()
        finally:
            con.close()

    def names(self) -> list[str]:
        # Feste Reihenfolge: wann angelegt, bei gleichem Zeitpunkt die Reihenfolge des Einfügens.
        rows = self._query(
            "SELECT id FROM printers WHERE connection = 'server' AND deleted_at IS NULL "
            "ORDER BY created_at, rowid"
        )
        return [str(row["id"]) for row in rows]

    def default(self) -> str | None:
        return None

    def lookup(self, name: str) -> PrinterEntry | None:
        rows = self._query(
            "SELECT id, config FROM printers WHERE id = ? AND connection = 'server' AND deleted_at IS NULL",
            (name,),
        )
        if not rows:
            return None
        return self._entry(str(rows[0]["id"]), str(rows[0]["config"]))

    def _entry(self, printer_id: str, config_text: str) -> PrinterEntry:
        with self._lock:
            known = self._entries.get(printer_id)
            if known is not None and known[0] == config_text:
                return known[1]
            try:
                config = json.loads(config_text)
            except ValueError:
                config = None
            if not isinstance(config, dict):
                config = {}
            driver_name = str(config.get("driver") or "")
            model = config.get("model") if isinstance(config.get("model"), str) else None
            address = config.get("address") if isinstance(config.get("address"), str) else None
            media = config.get("media") if isinstance(config.get("media"), str) else None
            driver = build_driver(
                PrinterConfig(
                    name=printer_id,
                    driver=driver_name,
                    model=model,
                    address=address,
                    media=media,
                    directory=self._image_dir,
                )
            )
            entry = PrinterEntry(name=printer_id, driver_name=driver_name, model=model, driver=driver)
            self._entries[printer_id] = (config_text, entry)
            return entry


# --------------------------------------------------------------------------- Anmeldung


class DeviceTokens:
    """Jeder Aufruf braucht ein gültiges Geräte-Token, wie bei der Schnittstelle unter ``/api``."""

    def __init__(self, database: Path) -> None:
        self._database = database

    def __call__(self, token: str | None, *, write: bool) -> str | None:
        if token is not None:
            con = db.connect(self._database)
            try:
                device = auth.device_for_token(con, token)
            finally:
                con.close()
            if device is not None:
                # Kein Schlüssel für den Nachweis: Am Server bürgt die Verbindung selbst.
                return None
        raise ServiceFault(ServiceError.UNAUTHORIZED, "Nicht angemeldet.")


# --------------------------------------------------------------------------- Dienst


class ServerPrinting:
    """Der Druckdienst eines laufenden Servers."""

    def __init__(self, settings: Settings, *, fonts: Fonts | None = None) -> None:
        self._database = settings.database_path
        self.directory = settings.data_dir / PRINT_DIR
        self.image_dir = self.directory / IMAGE_DIR
        self._status_lock = threading.Lock()
        self._status_seen: dict[str, tuple[tuple[Any, ...], float]] = {}
        self._cleanup_lock = threading.Lock()
        self._cleaned_at: float | None = None
        store = FileStore(self.directory / STORE_FILE)
        try:
            self.service = PrintService(
                ServerPrinters(self._database, self.image_dir),
                store,
                observer=self._on_job,
                status_observer=self._on_status,
                admit=self._admit,
                retention_s=RETENTION_S,
                fonts=fonts,
            )
        except BaseException:
            store.close()
            raise
        self.app: ASGIApp = create_print_app(self.service, authorize=DeviceTokens(self._database))

    @classmethod
    def open(cls, settings: Settings) -> "ServerPrinting":
        """Legt den Dienst an und nimmt die Arbeit auf. Was beim letzten Ende druckte, wird ``unknown``."""
        printing = cls(settings)
        try:
            printing.start()
        except BaseException:
            printing.close()
            raise
        return printing

    def start(self) -> None:
        self.image_dir.mkdir(parents=True, exist_ok=True)
        self._cleanup(force=True)
        self.service.start()
        log.info("Druckdienst unter /print bereit (boot_id %s).", self.service.boot_id)

    def close(self) -> None:
        """Ein laufender Druck wird weder abgebrochen noch abgewartet: Nach dem Neustart ist er ``unknown``."""
        self.service.close(grace_s=0.0)

    # ------------------------------------------------------------------ nur bekannte Etiketten

    def _admit(self, job_id: str, _request: JobRequest) -> None:
        con = db.connect(self._database)
        try:
            row = con.execute("SELECT state FROM print_jobs WHERE id = ?", (job_id,)).fetchone()
        finally:
            con.close()
        if row is None:
            raise ServiceFault(
                ServiceError.NOT_FOUND,
                "Dieses Etikett kennt der Server noch nicht. Erst abgleichen, dann drucken.",
            )
        if row["state"] != "pending":
            raise ServiceFault(
                ServiceError.NOT_PENDING,
                "Das Etikett ist verworfen oder schon erledigt.",
                {"state": row["state"]},
            )

    # ------------------------------------------------------------------ Zustand der Etiketten

    def _on_job(self, event: JobEvent) -> None:
        self.record_job(event.job)
        if event.job.state in FINAL_STATES:
            self._cleanup()

    def record_job(self, job: Job) -> bool:
        """Schreibt den Zustand eines Auftrags in sein Etikett, wie eine Meldung zum jetzigen Zeitpunkt.

        Die jüngste Meldung gilt (Feld-Uhr ``state``): Hat ein Gerät schon eine spätere gemeldet,
        bleibt das Etikett, wie es ist. Ein Zwischenstand ändert ein Etikett mit Ausgang nie.
        Liefert, ob geschrieben wurde.
        """
        state = job.state.value
        error = None if job.error is None else job.error.code
        if state == JobState.FAILED.value and error == JOB_ERROR_CANCELLED:
            # Am Dienst verworfen: Für das Etikett heißt das „verworfen", so wie es das Gerät
            # danach auch meldet (docs/etiketten.md, 5.8: beide Meldungen sagen dasselbe).
            state, error = PrintJobState.CANCELLED.value, None
        con = db.connect(self._database)
        try:
            with db.transaction(con):
                stamp = server_stamp()
                row = con.execute(
                    "SELECT kind, state, error FROM print_jobs WHERE id = ?", (job.id,)
                ).fetchone()
                if row is None:
                    log.warning(
                        "Auftrag %s hat kein Etikett im Bestand; sein Zustand bleibt ungeschrieben.", job.id
                    )
                    return False
                # Ein Zwischenstand (queued, printing) ändert kein Etikett, das schon einen Ausgang
                # hat oder verworfen ist (docs/sync-protokoll.md, 6.6).
                if progress_after_outcome(str(row["state"]), state):
                    return False
                clock = con.execute(
                    "SELECT at FROM field_clocks WHERE entity = 'print_job' AND entity_id = ? AND field = ?",
                    (job.id, JOB_STATE_CLOCK),
                ).fetchone()
                if clock is not None and stamp < clock["at"]:
                    return False
                con.execute(
                    "INSERT INTO field_clocks (entity, entity_id, field, at) VALUES ('print_job', ?, ?, ?) "
                    "ON CONFLICT (entity, entity_id, field) DO UPDATE SET at = excluded.at",
                    (job.id, JOB_STATE_CLOCK, stamp),
                )
                con.execute(
                    "UPDATE print_jobs SET state = ?, error = ?, printer_id = ?, boot_id = ?, "
                    "updated_at = max(updated_at, ?), rev = ? WHERE id = ?",
                    (state, error, job.printer, job.boot_id, stamp, db.next_rev(con), job.id),
                )
                events.record(
                    con,
                    at=stamp,
                    recorded_at=stamp,
                    type="print.reported",
                    entity="print_job",
                    entity_id=job.id,
                    data={
                        "kind": row["kind"],
                        "state": state,
                        "printer_id": job.printer,
                        "error": error,
                        "old": {"state": row["state"], "error": row["error"]},
                    },
                )
                return True
        finally:
            con.close()

    # ------------------------------------------------------------------ Zustand der Drucker

    def _on_status(self, name: str, status: DriverStatus) -> None:
        """Schreibt den Zustand eines Druckers, höchstens einmal je Minute, außer er hat sich geändert."""
        key = (
            self.service.boot_id,
            status.reachable,
            status.ready,
            status.media_detected,
            tuple(status.errors),
        )
        now = monotonic()
        with self._status_lock:
            seen = self._status_seen.get(name)
            if seen is not None and seen[0] == key and now - seen[1] < STATUS_INTERVAL_S:
                return
            self._status_seen[name] = (key, now)
        try:
            self.record_status(name, status)
        except Exception:
            # Beim nächsten Mal wieder versuchen, nicht erst nach einer Minute.
            with self._status_lock:
                self._status_seen.pop(name, None)
            raise

    def record_status(self, printer_id: str, status: DriverStatus) -> bool:
        """Schreibt den zuletzt gesehenen Zustand eines Druckers; eine jüngere Beobachtung bleibt."""
        con = db.connect(self._database)
        try:
            with db.transaction(con):
                stamp = server_stamp()
                if con.execute("SELECT 1 FROM printers WHERE id = ?", (printer_id,)).fetchone() is None:
                    return False
                known = con.execute(
                    "SELECT observed_at FROM printer_status WHERE printer_id = ?", (printer_id,)
                ).fetchone()
                if known is not None and stamp < known["observed_at"]:
                    return False
                con.execute(
                    "INSERT INTO printer_status (printer_id, observed_at, device_id, boot_id, status, host, rev) "
                    "VALUES (?, ?, NULL, ?, ?, NULL, ?) "
                    "ON CONFLICT (printer_id) DO UPDATE SET observed_at = excluded.observed_at, "
                    "device_id = NULL, boot_id = excluded.boot_id, status = excluded.status, host = NULL, "
                    "rev = excluded.rev",
                    (printer_id, stamp, self.service.boot_id, _dumps(to_dict(status)), db.next_rev(con)),
                )
                return True
        finally:
            con.close()

    # ------------------------------------------------------------------ Bilder aufräumen

    def _cleanup(self, *, force: bool = False) -> None:
        now = monotonic()
        with self._cleanup_lock:
            if not force and self._cleaned_at is not None and now - self._cleaned_at < CLEANUP_INTERVAL_S:
                return
            self._cleaned_at = now
        removed = ImageDriver(self.image_dir).cleanup(max_age_s=IMAGE_MAX_AGE_S, keep=IMAGE_KEEP)
        if removed:
            log.info("%d alte Etikett-Bilder gelöscht.", removed)


# --------------------------------------------------------------------------- Einbindung


class PrintGateway:
    """Hängt unter ``/print`` und reicht an den Druckdienst weiter, sobald er läuft.

    ``build_app`` bindet den Weg ein, der Dienst selbst entsteht erst im ``lifespan``. Solange er
    fehlt, antwortet jeder Aufruf mit 503 im Fehlerformat; die App lässt ihre Etiketten dann
    ausstehen und versucht es später.
    """

    def __init__(self) -> None:
        self.app: ASGIApp | None = None
        self.reason = "Der Druckdienst des Servers ist noch nicht bereit."

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        app = self.app
        if app is not None:
            await app(scope, receive, send)
            return
        if scope["type"] != "http":
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1013})
            return
        response = print_error_response(503, ServiceError.QUEUE_FULL.value, self.reason)
        await response(scope, receive, send)
