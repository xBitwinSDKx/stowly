"""Sicherung jetzt und Herunterladen (docs/integrationen.md, Abschnitt 3; docs/plan-einrichtung-b.md, 1).

Seit Stufe B gibt es nur noch verschlüsselte Sicherungen: „Jetzt sichern" legt dieselbe Sicherung wie die
automatische in den Ordner, und herunterladen lassen sich nur Dateien von Stowly aus diesem Ordner. Die
frühere unverschlüsselte Kopie (``GET /api/backup``) ist weggefallen. Pfade, Modelle und Beschreibungen
sind Vertrag (``docs/openapi.json``); umsetzen heißt, die Rümpfe zu füllen.
"""

import math
import os
import stat
import threading
import time
from collections.abc import Iterator
from datetime import UTC, datetime

from fastapi import APIRouter, Request, Response
from starlette.responses import StreamingResponse

from stowly import autobackup, serverconfig
from stowly.api.deps import CurrentDevice, get_settings
from stowly.contract.api import BackupFile, ErrorCode
from stowly.contract.timeutil import format_timestamp
from stowly.errors import ApiError

router = APIRouter(tags=["backup"])

_FILE_RESPONSES = {200: {"content": {"application/octet-stream": {}}}}

# „Jetzt sichern" höchstens einmal je so viele Sekunden, für den ganzen Server.
RUN_MIN_GAP_S = 60
ALREADY_RUNNING = "Gerade läuft schon eine Sicherung."
_READ_CHUNK = 1024 * 1024

_pressed_lock = threading.Lock()


def server_now() -> datetime:
    """Die Serveruhr für den Namen der Sicherung. Eigene Funktion, damit Tests sie anhalten können."""
    return datetime.now(UTC)


def monotonic() -> float:
    """Die Uhr der Bremse. Eigene Funktion, damit Tests sie vorstellen können."""
    return time.monotonic()


def _admit(request: Request) -> float | None:
    """Höchstens ein Knopfdruck je Minute (429 mit ``Retry-After``); liefert den vorigen Zeitpunkt."""
    state = request.app.state
    with _pressed_lock:
        now = monotonic()
        last = getattr(state, "backup_pressed", None)
        if last is not None and now - last < RUN_MIN_GAP_S:
            wait = max(1, math.ceil(last + RUN_MIN_GAP_S - now))
            raise ApiError(
                429,
                ErrorCode.RATE_LIMITED,
                f"Höchstens eine Sicherung auf Knopfdruck je Minute. Bitte in {wait} Sekunden erneut versuchen.",
                {"retry_after_s": wait},
                {"Retry-After": str(wait)},
            )
        state.backup_pressed = now
        return last


@router.post("/backup/run", operation_id="run_backup", response_model=BackupFile)
def run_backup(request: Request, response: Response, _device: CurrentDevice) -> BackupFile:
    """Legt jetzt eine verschlüsselte Sicherung in den Ordner, mit demselben Lock wie der tägliche Lauf.

    409 ``conflict``, wenn gerade eine läuft; 429 bei mehr als einer je Minute; 503 ``not_configured``
    ohne öffentlichen Schlüssel oder ohne brauchbaren Ordner.
    """
    settings = get_settings(request)
    setup = autobackup.current_setup(settings)
    if not setup.keys:
        raise ApiError(503, ErrorCode.NOT_CONFIGURED, serverconfig.BACKUP_NO_KEY)
    if setup.folder.problem is not None:
        raise ApiError(503, ErrorCode.NOT_CONFIGURED, setup.folder.problem)
    previous = _admit(request)
    try:
        result = autobackup.run(settings, server_now(), manual=True)
    except autobackup.Busy:
        # Lief schon eine (etwa die tägliche gleich nach dem Eintragen des Schlüssels), zählt der Druck nicht.
        request.app.state.backup_pressed = previous
        raise ApiError(409, ErrorCode.CONFLICT, ALREADY_RUNNING) from None
    except autobackup.NotSetUp as exc:
        raise ApiError(503, ErrorCode.NOT_CONFIGURED, exc.message) from None
    except autobackup.BackupError as exc:
        if exc.message in (autobackup.MISSING_DIR, autobackup.NOT_WRITABLE):
            raise ApiError(503, ErrorCode.NOT_CONFIGURED, exc.message) from None
        raise ApiError(500, ErrorCode.INTERNAL, exc.message) from None
    moment = autobackup.name_time(result.file, settings.tz)
    response.headers["Cache-Control"] = "no-store"
    return BackupFile(
        name=result.file,
        size=result.size,
        created_at=format_timestamp(moment if moment is not None else server_now()),
    )


def _not_found() -> ApiError:
    return ApiError(404, ErrorCode.NOT_FOUND, "Diese Sicherung gibt es nicht.")


@router.get(
    "/backup/files/{name}",
    operation_id="download_backup_file",
    response_class=Response,
    responses=_FILE_RESPONSES,
)
def download_backup_file(name: str, request: Request, _device: CurrentDevice) -> Response:
    """Liefert eine Sicherung aus dem Ordner als Download, ``Cache-Control: no-store``.

    Nur Namen von Stowly (stowly-JJJJ-MM-TT-HHMM.sqlite3.gz.age), nie ein anderer Pfad; sonst 404.
    """
    settings = get_settings(request)
    # Nur das eigene Muster: kein Schrägstrich, kein „..", nichts außer Ziffern, Bindestrichen und Punkten.
    if autobackup.name_time(name, settings.tz) is None:
        raise _not_found()
    folder = autobackup.current_setup(settings).folder.path
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        # Kein Verweis: weder ein Symlink noch etwas anderes als eine gewöhnliche Datei.
        if not stat.S_ISREG(os.lstat(folder / name).st_mode):
            raise _not_found()
        handle = os.open(folder / name, flags)
    except OSError:
        raise _not_found() from None
    stream = os.fdopen(handle, "rb")
    try:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise _not_found()
    except BaseException:
        stream.close()
        raise

    def chunks() -> Iterator[bytes]:
        with stream:
            yield from iter(lambda: stream.read(_READ_CHUNK), b"")

    return StreamingResponse(
        chunks(),
        media_type="application/octet-stream",
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": f'attachment; filename="{name}"',
            "Content-Length": str(info.st_size),
            "X-Content-Type-Options": "nosniff",
        },
    )
