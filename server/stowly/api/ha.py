"""Sensor und Liste aller Waren für Home Assistant (docs/integrationen.md, Abschnitt 6).

Beide Endpunkte lesen nur und haben einen eigenen Token, der nur hier gilt und in konstanter Zeit
verglichen wird: ``STOWLY_HA_SUMMARY_TOKEN``, sonst der Sensor-Token aus der App (``haconfig.sensor_token``,
bei jeder Anfrage gelesen, also ohne Neustart). Ein Geräte-Token gilt hier nicht. Ohne Token: 503.
"""

from datetime import UTC, datetime

from fastapi import APIRouter, Request, Response

from stowly import auth, haconfig, stocklist, summary
from stowly.api.deps import Db, get_settings, unauthorized
from stowly.config import Settings
from stowly.contract.api import ErrorCode, HaStock, HaSummary
from stowly.errors import ApiError

router = APIRouter(prefix="/ha", tags=["ha"])

NOT_SET_UP = (
    "Der Sensor ist auf diesem Server nicht eingerichtet (Sensor-Token in der App unter Einstellungen, "
    "Home Assistant, oder STOWLY_HA_SUMMARY_TOKEN)."
)


def server_now() -> datetime:
    """Die Serveruhr für „heute" und ``updated_at``. Eigene Funktion, damit Tests sie anhalten können."""
    return datetime.now(UTC)


def _sensor(request: Request, response: Response) -> Settings:
    """Prüft den Token des Sensors; liefert die Einstellungen. 503 ohne Token, 401 bei falschem."""
    settings = get_settings(request)
    expected = haconfig.sensor_token(settings, getattr(request.app.state, "secrets", None))
    if expected is None:
        raise ApiError(503, ErrorCode.NOT_CONFIGURED, NOT_SET_UP)
    # Der Token kommt aus der Kopfzeile, nicht über ein Sicherheitsschema: Die Beschreibung der
    # Schnittstelle ist Vertrag. Verglichen wird über die SHA-256 beider Werte, in konstanter Zeit.
    candidate = auth.bearer_token(request.headers.get("authorization"))
    if candidate is None or not auth.password_matches(candidate, expected):
        raise unauthorized()
    response.headers["Cache-Control"] = "no-store"
    return settings


@router.get("/summary", operation_id="ha_summary", response_model=HaSummary)
def ha_summary(request: Request, response: Response, con: Db) -> HaSummary:
    """Nur lesen, mit dem Token des Sensors: Was bald abläuft, was abgelaufen ist, die Einkaufsliste.

    401 ohne gültigen Sensor-Token (ein Geräte-Token gilt nicht), 503 ohne Sensor-Token (App oder Umgebung).
    """
    settings = _sensor(request, response)
    return HaSummary.model_validate(summary.build(con, settings.tz, server_now()))


@router.get("/stock", operation_id="ha_stock", response_model=HaStock)
def ha_stock(request: Request, response: Response, con: Db) -> HaStock:
    """Nur lesen, mit dem Token des Sensors: alle Waren im Bestand, je Zone, mit dem nächsten MHD.

    401 ohne gültigen Sensor-Token (ein Geräte-Token gilt nicht), 503 ohne Sensor-Token (App oder Umgebung).
    """
    settings = _sensor(request, response)
    return HaStock.model_validate(stocklist.build(con, settings.tz, server_now()))
