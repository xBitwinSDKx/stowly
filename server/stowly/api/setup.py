"""Einrichtung (docs/sync-protokoll.md, 11.6; docs/integrationen.md, Abschnitt 11).

Das erste Haushalts-Passwort, der Stand des Assistenten und die CA zum Herunterladen. Pfade,
Modelle und Beschreibungen sind Vertrag (``docs/openapi.json``); umsetzen heißt, die Rümpfe zu füllen.
"""

import logging
import sqlite3
from typing import Any

from fastapi import APIRouter, Request, Response

from stowly import auth, records, restore, wizard
from stowly.api.auth import rate_limited
from stowly.api.deps import CurrentDevice, Db, get_settings
from stowly.contract.api import (
    ErrorCode,
    LoginResponse,
    SetupChanges,
    SetupPasswordInput,
    SetupStatus,
)
from stowly.errors import ApiError
from stowly.tls import TlsManager

router = APIRouter(prefix="/setup", tags=["setup"])
log = logging.getLogger("stowly.setup")

_CA_RESPONSES = {200: {"content": {"application/x-x509-ca-cert": {}, "application/pkix-cert": {}}}}

NOT_AT_HOME = (
    "Das erste Passwort lässt sich nur im Heimnetz setzen: Stowly über seine IP-Adresse oder seinen "
    "lokalen Namen öffnen (etwa http://192.168.1.10:8010)."
)
ALREADY_SET = "Es gibt schon ein Passwort. Bitte damit anmelden."
NO_CA = "Es gibt keine nutzbare CA (Einzelheiten unter Einstellungen → Einrichtung)."


class _Restoring(Exception):
    """Beim ersten Start wird gerade eine Sicherung zurückgespielt."""


def _tls(request: Request) -> TlsManager:
    return request.app.state.tls


def _learn(request: Request, con: sqlite3.Connection, *, origin: bool) -> None:
    """Lernt aus der Anfrage (wizard.learn) und stellt bei einer neuen Adresse das Zertifikat neu aus."""
    settings, tls = get_settings(request), _tls(request)
    added = wizard.learn(
        settings,
        con,
        tls,
        host=request.headers.get("host"),
        scheme=request.url.scheme,
        origin=request.headers.get("origin") if origin else None,
        proxied=wizard.proxied(request.headers),
    )
    if added:
        wizard.refresh_certificate(settings, con, tls)


def _status(request: Request, con: sqlite3.Connection) -> SetupStatus:
    result: dict[str, Any] = wizard.status(
        get_settings(request), con, _tls(request), via_https=request.url.scheme == "https"
    )
    return SetupStatus.model_validate(result)


@router.post("/password", operation_id="setup_password", response_model=LoginResponse)
def setup_password(body: SetupPasswordInput, request: Request, response: Response, con: Db) -> dict:
    """Ohne Anmeldung, nur solange es kein Passwort gibt: setzt das erste Haushalts-Passwort, legt
    das Gerät an und liefert dessen Token genau einmal, wie die Anmeldung.

    409 ``conflict``, wenn es schon ein Passwort gibt (auch aus STOWLY_PASSWORD); 400
    ``invalid_request``, wenn die Kopfzeile Host nicht ins Heimnetz zeigt (private IP, einteiliger
    Name oder lokale Endung); 429 ``rate_limited`` wie bei der Anmeldung; 422 bei zu kurzem Passwort.
    Lernt die Adresse aus Host fürs Zertifikat.
    """
    settings = get_settings(request)
    if not wizard.first_password_host(request.headers.get("host")):
        raise ApiError(
            400,
            ErrorCode.INVALID_REQUEST,
            NOT_AT_HOME,
            {"errors": [{"loc": ["header", "host"], "msg": NOT_AT_HOME, "type": "setup_host"}]},
        )
    if auth.has_password(settings, con):
        raise ApiError(409, ErrorCode.CONFLICT, ALREADY_SET)
    # Beim ersten Start kann statt des Passworts eine Sicherung kommen (stowly/restore.py): Liegt sie bereit,
    # bringt sie ihr Passwort mit. Geprüft unter dem Lock der Bremse, wie das Anwenden dort.
    restoring = request.app.state.restore.blocks_first_password
    if restoring():
        raise ApiError(409, ErrorCode.CONFLICT, restore.BLOCKS_FIRST_PASSWORD)

    created: dict[str, Any] = {}

    def first() -> bool:
        # Unter dem Lock der Bremse: höchstens ein scrypt zugleich, und gesperrt heißt auch hier 429.
        if restoring():
            raise _Restoring
        created["token"], created["device"] = auth.set_first_password(con, body.password, body.device_name)
        return True

    guard: auth.LoginGuard = request.app.state.login_guard
    try:
        _ok, retry_after = guard.attempt(first)
    except auth.PasswordExists:
        raise ApiError(409, ErrorCode.CONFLICT, ALREADY_SET) from None
    except _Restoring:
        raise ApiError(409, ErrorCode.CONFLICT, restore.BLOCKS_FIRST_PASSWORD) from None
    if retry_after is not None:
        raise rate_limited(retry_after)

    try:
        _learn(request, con, origin=False)
    except Exception:
        # Das Token muss die App erreichen; die Adresse lernt der Server beim nächsten Aufruf.
        log.exception("Einrichtung: Die Adresse aus dieser Anfrage ließ sich nicht lernen.")
    response.headers["Cache-Control"] = "no-store"
    device = created["device"]
    return {"token": created["token"], "device": records.device(device, device["id"])}


@router.get("", operation_id="get_setup", response_model=SetupStatus)
def get_setup(device: CurrentDevice, request: Request, response: Response, con: Db) -> SetupStatus:
    """Stand der Einrichtung, ``Cache-Control: no-store``. Lernt die Adresse aus Host (und über den
    HTTPS-Listener den externen Port); eine neue Adresse stellt das Zertifikat neu aus."""
    _learn(request, con, origin=False)
    response.headers["Cache-Control"] = "no-store"
    return _status(request, con)


@router.patch("", operation_id="update_setup", response_model=SetupStatus)
def update_setup(
    device: CurrentDevice, body: SetupChanges, request: Request, response: Response, con: Db
) -> SetupStatus:
    """Markiert einen Schritt, schließt ab oder öffnet wieder, trägt Adressen oder den externen
    HTTPS-Port ein; liefert den neuen Stand. 422 ``invalid_request`` mit ``details.errors[].loc``
    ``["body", "addresses", i]``, wenn eine Adresse nicht im Heimnetz liegt oder die CA sie nicht deckt."""
    settings, tls = get_settings(request), _tls(request)
    # Erst ändern, dann lernen: „https_port: null" lernt so gleich aus dieser Anfrage neu.
    changed = wizard.change(settings, con, tls, body, device_id=device["id"])
    _learn(request, con, origin=True)
    if changed:
        wizard.refresh_certificate(settings, con, tls)
    response.headers["Cache-Control"] = "no-store"
    return _status(request, con)


@router.get("/ca.crt", operation_id="download_ca", response_class=Response, responses=_CA_RESPONSES)
def download_ca(request: Request, download: bool = False) -> Response:
    """Ohne Anmeldung: das Zertifikat der CA als DER, ``Cache-Control: no-store``.

    Ohne ``download`` als ``application/x-x509-ca-cert`` zum Öffnen (iPhone: Profil, Firefox: Dialog),
    mit ``download=true`` als ``application/pkix-cert``-Datei ``stowly-ca.crt`` (Android, Windows,
    Mac). 404 ``not_found`` ohne nutzbare CA.
    """
    der = _tls(request).ca_der()
    if der is None:
        raise ApiError(404, ErrorCode.NOT_FOUND, NO_CA)
    if download:
        return Response(
            der,
            media_type="application/pkix-cert",
            headers={
                "Cache-Control": "no-store",
                "Content-Disposition": 'attachment; filename="stowly-ca.crt"',
            },
        )
    return Response(der, media_type="application/x-x509-ca-cert", headers={"Cache-Control": "no-store"})
