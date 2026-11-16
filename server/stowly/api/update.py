"""Updates über GitHub (docs/integrationen.md, Abschnitt 10; Protokoll 11.5).

Der Server fragt GitHub nach dem neuesten Release und legt auf Wunsch eine Anforderung für den
Updater auf dem Rechner ab. Docker bekommt er dabei nie in die Hand: Ausgeführt wird das Update vom
Updater (``updater/stowly-update.sh`` oder der Updater-Container), der die Anforderung in
``/data/update`` findet. Ob Updates an sind, entscheidet der wirksame Wert (``serverconfig.update_repo``).
"""

from fastapi import APIRouter, Request, Response
from starlette.concurrency import run_in_threadpool

from stowly import serverconfig, updates
from stowly.api.deps import CurrentDevice, Db, get_settings
from stowly.contract.api import UPDATE_CHECK_MIN_GAP_S, ErrorCode, UpdateInstallInput, UpdateStatus
from stowly.errors import ApiError
from stowly.off import Clock

router = APIRouter(prefix="/update", tags=["update"])


def _clock(request: Request) -> Clock:
    """Die Uhr der Updates; Tests reichen sie ein (``create_app(update_clock=…)``)."""
    clock = getattr(request.app.state, "update_clock", None)
    return clock if clock is not None else Clock()


def _checker(request: Request) -> updates.UpdateChecker:
    """Die Schleife der Abfragen; sie läuft, solange die App bedient wird."""
    checker = getattr(request.app.state, "updates", None)
    if checker is None:
        raise ApiError(503, ErrorCode.NOT_CONFIGURED, "Die Abfrage bei GitHub ist gerade nicht verfügbar.")
    return checker


@router.post("/check", operation_id="check_update", response_model=UpdateStatus)
async def check_update(_device: CurrentDevice, request: Request, response: Response, con: Db) -> UpdateStatus:
    """Fragt GitHub sofort nach dem neuesten Release und liefert den neuen Zustand.

    503 ``not_configured``, wenn Updates aus sind (weder STOWLY_UPDATE_REPO noch der Schalter in der
    App); 429 ``rate_limited`` öfter als einmal je Minute (mit ``Retry-After``). Ein Fehler bei GitHub
    ist kein Fehler dieses Aufrufs: Er steht in ``check_error``.
    """
    settings = get_settings(request)
    if await run_in_threadpool(serverconfig.update_repo, settings, con) is None:
        raise ApiError(503, ErrorCode.NOT_CONFIGURED, updates.NOT_CONFIGURED)
    checker = _checker(request)
    try:
        await checker.check_now()
    except updates.TooSoon as exc:
        wait = exc.retry_after_s
        raise ApiError(
            429,
            ErrorCode.RATE_LIMITED,
            f"Höchstens eine Abfrage bei GitHub in {UPDATE_CHECK_MIN_GAP_S} Sekunden. "
            f"Bitte in {wait} Sekunden erneut versuchen.",
            {"retry_after_s": wait},
            {"Retry-After": str(wait)},
        ) from None
    response.headers["Cache-Control"] = "no-store"
    result = await run_in_threadpool(updates.status, settings, con, _clock(request).now())
    return UpdateStatus.model_validate(result)


@router.post("/install", operation_id="install_update", status_code=202, response_model=UpdateStatus)
def install_update(
    _device: CurrentDevice, body: UpdateInstallInput, request: Request, response: Response, con: Db
) -> UpdateStatus:
    """Fordert das Update auf ``body.version`` beim Updater an (202) und liefert den neuen Zustand.

    503 ``not_configured``, wenn Updates aus sind oder sich der Updater seit 10 Minuten nicht
    gemeldet hat; 409 ``conflict``, wenn ``version`` nicht das zuletzt gesehene neueste Release ist,
    nicht neuer als dieser Server oder schon angefordert bzw. in Arbeit.
    """
    try:
        result = updates.install(
            get_settings(request), con, body.version, device=_device["name"], now=_clock(request).now()
        )
    except updates.Refused as exc:
        raise ApiError(exc.status, exc.code, exc.message) from None
    response.headers["Cache-Control"] = "no-store"
    return UpdateStatus.model_validate(result)
