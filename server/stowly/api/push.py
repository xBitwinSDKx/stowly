"""Benachrichtigungen per Web-Push (docs/integrationen.md, Abschnitt 4).

Alles mit Geräte-Token. Ein Gerät hat höchstens ein Abo; es gehört zum Gerät und endet mit
dessen Abmeldung. Ohne wirksamen Kontakt (``STOWLY_PUSH_CONTACT`` oder aus der App) antworten alle
Aufrufe mit 503 ``not_configured``.
"""

import sqlite3

from fastapi import APIRouter, Request, Response
from starlette.concurrency import run_in_threadpool

from stowly import db, push, serverconfig
from stowly.api.deps import CurrentDevice, Db, get_settings, unauthorized
from stowly.config import Settings
from stowly.contract import timeutil
from stowly.contract.api import (
    PUSH_TEST_INTERVAL_S,
    ErrorCode,
    PushKey,
    PushSubscriptionInput,
    PushTestResult,
)
from stowly.errors import ApiError

router = APIRouter(prefix="/push", tags=["push"])

PUSH_OFF = (
    "Push ist auf diesem Server aus: Es fehlt der Kontakt für die Push-Dienste "
    "(Einstellungen → Einrichtung und Zugang, oder STOWLY_PUSH_CONTACT)."
)


def _require_push(settings: Settings, con: sqlite3.Connection) -> None:
    """503, solange es keinen wirksamen Kontakt gibt; gelesen bei jedem Aufruf (ohne Neustart)."""
    if serverconfig.push_contact(settings, con) is None:
        raise ApiError(503, ErrorCode.NOT_CONFIGURED, PUSH_OFF)


def _require_push_fresh(settings: Settings) -> None:
    """Wie ``_require_push``, mit eigener Verbindung (für Aufrufe in der Ereignisschleife)."""
    con = db.connect(settings.database_path)
    try:
        _require_push(settings, con)
    finally:
        con.close()


def _service(request: Request) -> push.PushService:
    service = getattr(request.app.state, "push", None)
    if service is None:
        raise ApiError(503, ErrorCode.NOT_CONFIGURED, "Push ist gerade nicht verfügbar.")
    return service


@router.get("/key", operation_id="get_push_key", response_model=PushKey)
def get_push_key(_device: CurrentDevice, request: Request, response: Response, con: Db) -> PushKey:
    """Der öffentliche VAPID-Schlüssel des Servers für pushManager.subscribe."""
    _require_push(get_settings(request), con)
    response.headers["Cache-Control"] = "no-store"
    return PushKey(public_key=push.public_key(con))


@router.put("/subscription", operation_id="put_push_subscription", status_code=204)
def put_push_subscription(
    body: PushSubscriptionInput, _device: CurrentDevice, request: Request, con: Db
) -> None:
    """Legt das Push-Abo dieses Geräts an oder ersetzt es. Unbekannter Push-Dienst: 422."""
    _require_push(get_settings(request), con)
    problems = push.check(body.endpoint, body.keys.p256dh, body.keys.auth, body.origin)
    if problems:
        raise ApiError(
            422, ErrorCode.INVALID_REQUEST, "Die Anfrage entspricht nicht dem Vertrag.", {"errors": problems}
        )
    saved = push.save(
        con,
        _device["id"],
        endpoint=body.endpoint,
        p256dh=body.keys.p256dh,
        auth=body.keys.auth,
        origin=body.origin,
        now=timeutil.now(),
    )
    if not saved:
        # Inzwischen gesperrt: Ein gesperrtes Gerät bekommt kein Abo mehr.
        raise unauthorized()


@router.delete("/subscription", operation_id="delete_push_subscription", status_code=204)
def delete_push_subscription(_device: CurrentDevice, request: Request, con: Db) -> None:
    """Löscht das Push-Abo dieses Geräts. Wiederholbar, auch ohne Abo."""
    _require_push(get_settings(request), con)
    push.remove(con, _device["id"])


@router.post("/test", operation_id="send_push_test", response_model=PushTestResult)
async def send_push_test(_device: CurrentDevice, request: Request, response: Response) -> PushTestResult:
    """Schickt eine Testnachricht an dieses Gerät und meldet, was der Push-Dienst geantwortet hat.

    404 ohne Abo dieses Geräts, 429 bei mehr als einer Testnachricht in 10 Sekunden.
    """
    await run_in_threadpool(_require_push_fresh, get_settings(request))
    service = _service(request)
    try:
        delivery = await service.test(_device["id"])
    except push.NoSubscription:
        raise ApiError(404, ErrorCode.NOT_FOUND, "Dieses Gerät hat kein Push-Abo beim Server.") from None
    except push.NoContact:
        raise ApiError(503, ErrorCode.NOT_CONFIGURED, PUSH_OFF) from None
    except push.TooSoon as exc:
        wait = exc.retry_after_s
        raise ApiError(
            429,
            ErrorCode.RATE_LIMITED,
            f"Höchstens eine Testnachricht in {PUSH_TEST_INTERVAL_S} Sekunden. Bitte in {wait} Sekunden erneut versuchen.",
            {"retry_after_s": wait},
            {"Retry-After": str(wait)},
        ) from None
    response.headers["Cache-Control"] = "no-store"
    return PushTestResult(status=delivery.status, http_status=delivery.http_status, message=delivery.message)
