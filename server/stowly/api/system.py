"""Erreichbarkeit des Servers."""

from typing import Annotated

from fastapi import APIRouter, Depends, Response

from stowly import __version__
from stowly.api.deps import get_settings
from stowly.config import Settings
from stowly.contract import PROTOCOL_VERSION, timeutil
from stowly.contract.api import ServerHealth

router = APIRouter(tags=["system"])


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
        configured=settings.configured,
    )
