"""Zustand der Integrationen für die Einstellungen der App (docs/integrationen.md, Abschnitt 8)."""

from fastapi import APIRouter

from stowly.api.deps import CurrentDevice
from stowly.contract.api import ErrorCode, IntegrationStatus
from stowly.errors import ApiError

router = APIRouter(tags=["integrations"])


@router.get("/integrations", operation_id="get_integrations", response_model=IntegrationStatus)
def get_integrations(_device: CurrentDevice) -> IntegrationStatus:
    """Sicherung, Home Assistant und Push: eingerichtet, letzter Erfolg, letzter Fehler. Nie ein Token."""
    raise ApiError(501, ErrorCode.NOT_IMPLEMENTED, "Der Zustand der Integrationen ist noch nicht umgesetzt.")
