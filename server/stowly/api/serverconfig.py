"""Einstellungen des Servers aus der App (docs/integrationen.md, Abschnitt 12; Protokoll 11.7).

Die Umgebung geht vor: Was dort steht, ist in der App nur zu sehen. Pfade, Modelle und
Beschreibungen sind Vertrag (``docs/openapi.json``); umsetzen heißt, die Rümpfe zu füllen.
"""

import sqlite3
from collections.abc import Callable

from fastapi import APIRouter, Request, Response

from stowly import auth, serverconfig
from stowly.api.auth import rate_limited
from stowly.api.deps import CurrentDevice, Db, get_settings
from stowly.config import Settings
from stowly.contract import timeutil
from stowly.contract.api import ErrorCode, ServerConfig, ServerConfigChanges
from stowly.errors import ApiError

router = APIRouter(prefix="/server-config", tags=["server-config"])

WRONG_PASSWORD = "Das Passwort stimmt nicht."


def password_confirmation(
    settings: Settings, con: sqlite3.Connection, guard: auth.LoginGuard
) -> Callable[[str], None]:
    """Prüft ``current_password`` wie die Anmeldung: dieselbe Bremse (401 ``invalid_password``, dann 429),
    das Passwort aus der Umgebung geht vor. Nie im Log."""

    def confirm(password: str) -> None:
        check = auth.password_check(settings, con, password)
        if check is None:
            raise ApiError(503, ErrorCode.NOT_CONFIGURED, auth.NO_PASSWORD)
        matched, retry_after = guard.attempt(check)
        if retry_after is not None:
            raise rate_limited(retry_after)
        if not matched:
            # invalid_password, nie unauthorized: Der Kern der App meldet das Gerät deshalb nicht ab.
            raise ApiError(401, ErrorCode.INVALID_PASSWORD, WRONG_PASSWORD)

    return confirm


@router.get("", operation_id="get_server_config", response_model=ServerConfig)
def get_server_config(device: CurrentDevice, request: Request, response: Response, con: Db) -> ServerConfig:
    """Wirksame Werte mit ihrer Quelle, ``Cache-Control: no-store``. Nie ein Geheimnis."""
    response.headers["Cache-Control"] = "no-store"
    return ServerConfig.model_validate(serverconfig.effective(get_settings(request), con))


@router.patch("", operation_id="update_server_config", response_model=ServerConfig)
def update_server_config(
    device: CurrentDevice, body: ServerConfigChanges, request: Request, response: Response, con: Db
) -> ServerConfig:
    """Ändert die vorhandenen Felder und liefert die wirksamen Werte; wirkt ohne Neustart.

    409 ``conflict``, wenn ein Feld aus der Umgebung kommt oder das Image kein Repository für den
    Schalter kennt; 422 ``invalid_request`` mit ``details.errors[].loc`` ``["body", "push_contact"]``
    bei einem ungültigen Kontakt.
    """
    settings = get_settings(request)
    confirm = password_confirmation(settings, con, request.app.state.login_guard)
    changed = serverconfig.change(
        settings, con, body, device_id=device["id"], now=timeutil.now(), confirm=confirm
    )
    if serverconfig.UPDATE_ENABLED in changed:
        # Die Abfrage bei GitHub liest den Schalter neu: eingeschaltet die erste nach einer Minute.
        checker = getattr(request.app.state, "updates", None)
        if checker is not None:
            checker.reconfigure()
    if any(key in changed for key in serverconfig.BACKUP_KEYS):
        # Der Zeitplan prüft gleich, ob die Sicherung jetzt fällig ist (Schlüssel neu, Uhrzeit erreicht).
        jobs = getattr(request.app.state, "scheduler", None)
        if jobs is not None:
            jobs.wake()
    # Push liest den Kontakt bei jeder Zustellung selbst; dafür ist nichts zu tun.
    response.headers["Cache-Control"] = "no-store"
    return ServerConfig.model_validate(serverconfig.effective(settings, con))
