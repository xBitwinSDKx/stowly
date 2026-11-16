"""Eine Sicherung zurückspielen (docs/sync-protokoll.md, 11.9; docs/plan-einrichtung-b.md, Abschnitt 2).

Drei Schritte: hochladen, prüfen (bei age mit dem geheimen Schlüssel, nur im Speicher), anwenden; danach
startet Stowly neu und tauscht die Datenbank, bevor etwas sie öffnet. Mit Geräte-Token gilt es für einen
laufenden Stowly, ohne Token nur beim ersten Start (noch kein Passwort, Host-Regel wie beim ersten
Passwort). Pfade, Modelle und Beschreibungen sind Vertrag (``docs/openapi.json``); umsetzen heißt, die
Rümpfe zu füllen. Die Arbeit selbst steht in ``stowly/restore.py``.
"""

import asyncio
import sqlite3
from collections.abc import AsyncIterator, Callable

from fastapi import APIRouter, BackgroundTasks, Request, Response
from starlette.concurrency import run_in_threadpool

from stowly import auth, db, restore, wizard
from stowly.api.deps import CurrentDevice, get_settings, unauthorized
from stowly.contract.api import (
    ErrorCode,
    RestoreApplied,
    RestoreApplyInput,
    RestoreCheckInput,
    RestorePreview,
    RestoreStatus,
    RestoreUpload,
)
from stowly.errors import ApiError

router = APIRouter(prefix="/restore", tags=["restore"])

# Der Rumpf ist die Datei selbst (keine Form-Daten): so braucht es kein python-multipart, und PUT mit
# diesem Typ verlangt im Browser eine Vorabfrage (CORS), die fremde Seiten nicht bestehen.
_UPLOAD_BODY = {
    "requestBody": {
        "required": True,
        "content": {"application/octet-stream": {"schema": {"type": "string", "format": "binary"}}},
    }
}


def _manager(request: Request) -> restore.RestoreManager:
    return request.app.state.restore


def _access(request: Request, *, password_set_conflict: bool = False) -> sqlite3.Row | None:
    """Wer zurückspielen darf: mit Geräte-Token das Gerät (laufender Stowly); ohne Token nur beim ersten
    Start, also ohne Passwort und mit ``Host`` aus dem Heimnetz (dann ``None``).

    401 bei einem unbekannten Token und ohne Token, sobald es ein Passwort gibt (``password_set_conflict``:
    409, weil es inzwischen gesetzt wurde); 400 bei einem ``Host`` außerhalb des Heimnetzes (wie
    ``POST /api/setup/password``).
    """
    settings = get_settings(request)
    header = request.headers.get("authorization")
    con = db.connect(settings.database_path)
    try:
        if header is not None:
            token = auth.bearer_token(header)
            device = None if token is None else auth.device_for_token(con, token)
            if device is None:
                raise unauthorized()
            return device
        if auth.has_password(settings, con):
            if password_set_conflict:
                raise ApiError(409, ErrorCode.CONFLICT, restore.PASSWORD_SET_MEANWHILE)
            raise unauthorized()
    finally:
        con.close()
    if not wizard.first_password_host(request.headers.get("host")):
        raise ApiError(
            400,
            ErrorCode.INVALID_REQUEST,
            restore.NOT_AT_HOME,
            {"errors": [{"loc": ["header", "host"], "msg": restore.NOT_AT_HOME, "type": "setup_host"}]},
        )
    return None


def _declared_size(request: Request) -> int | None:
    value = request.headers.get("content-length")
    return int(value) if value is not None and value.isdigit() else None


async def _timed(chunks: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    """Die Teile des Rumpfs, mit Zeitgrenzen: 408, wenn ``restore.UPLOAD_IDLE_S`` Sekunden lang nichts kommt
    oder alles zusammen länger als ``restore.UPLOAD_TOTAL_S`` dauert. Ohne sie hielte ein stockendes
    Hochladen den Schritt (und damit jedes Update) ohne Ende auf, beim ersten Start sogar ohne Anmeldung."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + restore.UPLOAD_TOTAL_S
    iterator = aiter(chunks)
    while True:
        left = deadline - loop.time()
        if left <= 0:
            raise ApiError(408, ErrorCode.INVALID_REQUEST, restore.UPLOAD_TOO_SLOW)
        idle = restore.UPLOAD_IDLE_S < left
        try:
            async with asyncio.timeout(restore.UPLOAD_IDLE_S if idle else left):
                chunk = await anext(iterator, None)
        except TimeoutError:
            message = restore.UPLOAD_IDLE if idle else restore.UPLOAD_TOO_SLOW
            raise ApiError(408, ErrorCode.INVALID_REQUEST, message) from None
        if chunk is None:
            return
        yield chunk


def _restart(request: Request) -> Callable[[], None]:
    """Der Neustart, den die Listener bereitstellen (``__main__.Listeners.request_restart``)."""
    hook = getattr(request.app.state, "request_restart", None)
    if hook is None:
        raise ApiError(503, ErrorCode.NOT_CONFIGURED, restore.NO_RESTART)
    return hook


@router.put(
    "/upload",
    operation_id="upload_restore",
    status_code=201,
    response_model=RestoreUpload,
    openapi_extra=_UPLOAD_BODY,
)
async def upload_restore(request: Request, response: Response) -> RestoreUpload:
    """Nimmt die Sicherung als Rohdaten an (höchstens RESTORE_MAX_BYTES) und erkennt ihre Art.

    413 ``payload_too_large``; 422 bei einer Datei, die keine Sicherung sein kann; 409, wenn schon ein
    Zurückspielen oder ein Update läuft; 429 aus der eigenen Bremse; 507-artige Platznot als 409 mit Satz.
    """
    manager = _manager(request)
    device = await run_in_threadpool(_access, request)
    await run_in_threadpool(manager.refuse_if_blocked)
    with manager.operation(counted=True):
        receiver = await run_in_threadpool(
            manager.receiver, _declared_size(request), first_start=device is None
        )
        try:
            buffer = bytearray()
            async for chunk in _timed(request.stream()):
                if not chunk:
                    continue
                buffer += chunk
                # Bis die Art feststeht, gleich weiterreichen: Eine fremde Datei fällt nach den ersten Bytes auf.
                if receiver.kind is None or len(buffer) >= restore.CHUNK:
                    await run_in_threadpool(receiver.feed, bytes(buffer))
                    buffer.clear()
            if buffer:
                await run_in_threadpool(receiver.feed, bytes(buffer))
            uploaded = await run_in_threadpool(receiver.finish)
        except BaseException:
            receiver.discard()
            raise
    response.headers["Cache-Control"] = "no-store"
    return RestoreUpload(upload_id=uploaded.id, kind=uploaded.kind, size=uploaded.size)


@router.post("/check", operation_id="check_restore", response_model=RestorePreview)
def check_restore(body: RestoreCheckInput, request: Request, response: Response) -> RestorePreview:
    """Entschlüsselt (age) und prüft die hochgeladene Sicherung und migriert eine Kopie.

    422 mit ``details.reason``: ``wrong_key``, ``not_a_key``, ``not_stowly``, ``damaged``,
    ``newer_schema``, ``migration_failed``; 404, wenn die ``upload_id`` abgelaufen oder unbekannt ist;
    413, wenn die Sicherung entpackt größer als 2 GiB wäre; 429 aus der eigenen Bremse. Der Schlüssel
    steht nie in einer Antwort oder im Log.
    """
    manager = _manager(request)
    device = _access(request)
    manager.refuse_if_blocked()
    with manager.operation(counted=True):
        preview = manager.check(body.upload_id, body.identity, first_start=device is None)
    response.headers["Cache-Control"] = "no-store"
    return RestorePreview.model_validate(preview)


@router.post("/apply", operation_id="apply_restore", status_code=202, response_model=RestoreApplied)
def apply_restore(
    body: RestoreApplyInput, request: Request, response: Response, background: BackgroundTasks
) -> RestoreApplied:
    """Legt die geprüfte Sicherung bereit und startet Stowly neu; der Tausch geschieht beim Start.

    401 ``invalid_password`` bei falschem Passwort (über die Bremse der Anmeldung, dann auch 429); 404,
    wenn die ``restore_id`` unbekannt oder abgelaufen ist; 409, wenn beim ersten Start inzwischen ein
    Passwort gesetzt ist oder ein Update läuft; beim ersten Start 422, wenn ``device_name`` fehlt oder ein
    neues Passwort zu kurz ist; 503 ``not_configured``, wenn sich Stowly hier nicht selbst neu starten kann.
    """
    manager = _manager(request)
    # Beim ersten Start geprüft, inzwischen gibt es ein Passwort (POST /api/setup/password kam zuvor): 409.
    candidate = manager.candidate
    device = _access(request, password_set_conflict=candidate is not None and candidate.first_start)
    manager.refuse_if_blocked()
    restart = _restart(request)
    with manager.operation(counted=False):
        result = manager.apply(
            body.restore_id,
            body.password,
            body.device_name,
            device=device,
            guard=request.app.state.login_guard,
        )
    # Erst nach der Antwort: Die Listener enden sauber, dann ersetzt sich der Prozess (__main__).
    background.add_task(restart)
    response.headers["Cache-Control"] = "no-store"
    return RestoreApplied.model_validate(result)


@router.get("", operation_id="get_restore_status", response_model=RestoreStatus)
def get_restore_status(_device: CurrentDevice, request: Request, response: Response) -> RestoreStatus:
    """Der letzte Stand des Zurückspielens (nur angemeldet), ``Cache-Control: no-store``."""
    response.headers["Cache-Control"] = "no-store"
    result = restore.status(get_settings(request), _manager(request).clock())
    return RestoreStatus.model_validate(result)


@router.post("/undo", operation_id="undo_restore", status_code=202, response_model=RestoreApplied)
def undo_restore(
    device: CurrentDevice, request: Request, response: Response, background: BackgroundTasks
) -> RestoreApplied:
    """Spielt die Datenbank von vor dem letzten Zurückspielen wieder ein (bis ``undo_until``) und startet neu.

    404, wenn es keine gibt; 409, wenn gerade etwas läuft; 503 ``not_configured``, wenn sich Stowly hier
    nicht selbst neu starten kann.
    """
    manager = _manager(request)
    manager.refuse_if_blocked()
    manager.ensure_undo()
    restart = _restart(request)
    with manager.operation(counted=False):
        manager.undo(device_id=device["id"])
    background.add_task(restart)
    response.headers["Cache-Control"] = "no-store"
    return RestoreApplied(login=None)


@router.delete("/previous", operation_id="delete_restore_previous", status_code=204)
def delete_restore_previous(_device: CurrentDevice, request: Request) -> None:
    """Löscht die Datenbank von vor dem Zurückspielen vorzeitig; danach geht „Rückgängig" nicht mehr.

    Wiederholbar: 204 auch, wenn es keine (mehr) gibt; 409, solange eine Sicherung zum Einspielen bereitliegt.
    """
    settings = get_settings(request)
    if restore.pending_exists(settings):
        raise ApiError(409, ErrorCode.CONFLICT, restore.PENDING)
    # Wiederholbar: Gibt es keine (mehr), ist das Ziel schon erreicht.
    restore.delete_previous(settings)
