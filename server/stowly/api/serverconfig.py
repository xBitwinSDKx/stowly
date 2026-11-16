"""Einstellungen des Servers aus der App (docs/integrationen.md, Abschnitt 12; Protokoll 11.7).

Die Umgebung geht vor: Was dort steht, ist in der App nur zu sehen. Pfade, Modelle und
Beschreibungen sind Vertrag (``docs/openapi.json``); umsetzen heißt, die Rümpfe zu füllen.
"""

from fastapi import APIRouter, Request, Response

from stowly import serverconfig
from stowly.api.deps import CurrentDevice, Db, get_settings
from stowly.contract import timeutil
from stowly.contract.api import ServerConfig, ServerConfigChanges

router = APIRouter(prefix="/server-config", tags=["server-config"])


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
    changed = serverconfig.change(settings, con, body, device_id=device["id"], now=timeutil.now())
    if serverconfig.UPDATE_ENABLED in changed:
        # Die Abfrage bei GitHub liest den Schalter neu: eingeschaltet die erste nach einer Minute.
        checker = getattr(request.app.state, "updates", None)
        if checker is not None:
            checker.reconfigure()
    # Push liest den Kontakt bei jeder Zustellung selbst; dafür ist nichts zu tun.
    response.headers["Cache-Control"] = "no-store"
    return ServerConfig.model_validate(serverconfig.effective(settings, con))
