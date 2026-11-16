"""Erreichbarkeit des Servers."""

from typing import Annotated

from fastapi import APIRouter, Depends, Response

from stowly import __version__, auth, db
from stowly.api.deps import get_settings
from stowly.config import Settings
from stowly.contract import PROTOCOL_VERSION, timeutil
from stowly.contract.api import ServerHealth

router = APIRouter(tags=["system"])


def _configured(settings: Settings) -> bool:
    """Gibt es ein Passwort, aus der Umgebung oder als Hash aus der App (docs/sync-protokoll.md, 5)?

    Die Datenbank öffnet das nur ohne Passwort aus der Umgebung: Der Healthcheck des Containers fragt oft.
    """
    if settings.password is not None:
        return True
    con = db.connect(settings.database_path)
    try:
        return auth.has_password(settings, con)
    finally:
        con.close()


@router.get("/health", operation_id="health", response_model=ServerHealth)
def health(response: Response, settings: Annotated[Settings, Depends(get_settings)]) -> ServerHealth:
    """Ohne Anmeldung. Die App prüft damit selbst, ob der Server erreichbar ist:
    ``navigator.onLine`` meldet im WLAN des Pi „online", obwohl der Server fehlt.
    """
    response.headers["Cache-Control"] = "no-store"
    return ServerHealth(
        app="stowly",
        status="ok",
        version=__version__,
        protocol=PROTOCOL_VERSION,
        time=timeutil.now(),
        configured=_configured(settings),
    )
