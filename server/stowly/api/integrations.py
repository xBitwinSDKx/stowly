"""Zustand der Integrationen für die Einstellungen der App (docs/integrationen.md, Abschnitt 8)."""

from datetime import UTC, datetime

from fastapi import APIRouter, Request, Response

from stowly import integrations
from stowly.api.deps import CurrentDevice, Db, get_settings
from stowly.contract.api import IntegrationStatus

router = APIRouter(tags=["integrations"])


def server_now() -> datetime:
    """Die Serveruhr für den Zustand. Eigene Funktion, damit Tests sie anhalten können."""
    return datetime.now(UTC)


@router.get("/integrations", operation_id="get_integrations", response_model=IntegrationStatus)
def get_integrations(
    _device: CurrentDevice, request: Request, response: Response, con: Db
) -> IntegrationStatus:
    """Sicherung, Home Assistant und Push: eingerichtet, letzter Erfolg, letzter Fehler. Nie ein Token."""
    response.headers["Cache-Control"] = "no-store"
    status = integrations.status(get_settings(request), con, device_id=_device["id"], now=server_now())
    return IntegrationStatus.model_validate(status)
