"""Statistik: verbraucht und entsorgt (docs/sync-protokoll.md, Abschnitt 11.1)."""

from datetime import UTC, datetime

from fastapi import APIRouter, Request, Response

from stowly import localtime, stats
from stowly.api.deps import CurrentDevice, Db, get_settings
from stowly.contract.api import STATS_DEFAULT_MONTHS, STATS_MAX_MONTHS, ErrorCode, Stats
from stowly.contract.timeutil import MONTH_PATTERN
from stowly.errors import ApiError

router = APIRouter(tags=["stats"])

# ``start`` und ``end`` stehen nur so im Vertrag und werden von Hand geprüft: Ein falscher Wert
# ergibt 400 im Fehlerformat (FastAPI antwortete mit 422), wie bei ``wait`` am Nachschlagen.
_PERIOD_PARAMETERS = {
    "parameters": [
        {
            "name": "start",
            "in": "query",
            "required": False,
            "description": (
                f"Erster Monat 'YYYY-MM' (Zeitzone des Servers). Ohne Angabe: {STATS_DEFAULT_MONTHS - 1} "
                "Monate vor end."
            ),
            "schema": {"type": "string", "pattern": MONTH_PATTERN},
        },
        {
            "name": "end",
            "in": "query",
            "required": False,
            "description": (
                f"Letzter Monat 'YYYY-MM', eingeschlossen. Ohne Angabe: der laufende Monat. Höchstens "
                f"{STATS_MAX_MONTHS} Monate von start bis end."
            ),
            "schema": {"type": "string", "pattern": MONTH_PATTERN},
        },
    ]
}


def server_now() -> datetime:
    """Die Serveruhr für den laufenden Monat. Eigene Funktion, damit Tests sie anhalten können."""
    return datetime.now(UTC)


@router.get("/stats", operation_id="get_stats", response_model=Stats, openapi_extra=_PERIOD_PARAMETERS)
def get_stats(_device: CurrentDevice, request: Request, response: Response, con: Db) -> Stats:
    """Verbraucht und entsorgt je Monat, je Zone und die am häufigsten entsorgten Produkte.

    Gerechnet aus allen Packungen über die ganze Zeit; „versehentlich" zählt nicht.
    Ungültiger Zeitraum: 400.
    """
    settings = get_settings(request)
    query = {name: request.query_params.getlist(name) for name in ("start", "end")}
    try:
        start, end = stats.period(query, localtime.today(server_now(), settings.tz))
    except stats.PeriodError as exc:
        raise ApiError(400, ErrorCode.INVALID_REQUEST, str(exc), {"errors": exc.problems}) from None
    response.headers["Cache-Control"] = "no-store"
    return Stats.model_validate(stats.compute(con, settings.tz, settings.timezone, start, end))
