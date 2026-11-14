"""Sensor für Home Assistant (docs/integrationen.md, Abschnitt 6).

Der Endpunkt hat einen eigenen Token (``STOWLY_HA_SUMMARY_TOKEN``), der nur hier gilt und in
konstanter Zeit verglichen wird. Ein Geräte-Token gilt hier nicht. Ohne gesetzten Token: 503.
"""

from fastapi import APIRouter

from stowly.contract.api import ErrorCode, HaSummary
from stowly.errors import ApiError

router = APIRouter(prefix="/ha", tags=["ha"])


@router.get("/summary", operation_id="ha_summary", response_model=HaSummary)
def ha_summary() -> HaSummary:
    """Nur lesen, mit dem Token des Sensors: Was bald abläuft, was abgelaufen ist, die Einkaufsliste.

    401 ohne gültigen Sensor-Token (ein Geräte-Token gilt nicht), 503 ohne STOWLY_HA_SUMMARY_TOKEN.
    """
    raise ApiError(501, ErrorCode.NOT_IMPLEMENTED, "Der Sensor ist noch nicht umgesetzt.")
