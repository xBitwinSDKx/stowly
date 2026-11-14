"""Barcode beim Scannen nachschlagen (docs/sync-protokoll.md, Abschnitt 10)."""

import dataclasses
from typing import Annotated

from fastapi import APIRouter, Path, Request, Response
from starlette.concurrency import run_in_threadpool

from stowly import off
from stowly.api.deps import CurrentDevice, get_settings
from stowly.contract.api import (
    LOOKUP_WAIT_DEFAULT_S,
    LOOKUP_WAIT_MAX_S,
    ErrorCode,
    LookupResult,
    LookupResultState,
)
from stowly.contract.ids import is_store_internal_barcode, is_valid_barcode
from stowly.errors import ApiError

router = APIRouter(tags=["lookup"])

# ``wait`` steht nur so im Vertrag und wird von Hand geprüft: Ein falscher Wert ergibt 400 im
# Fehlerformat (FastAPI antwortete mit 422).
_WAIT_PARAMETER = {
    "parameters": [
        {
            "name": "wait",
            "in": "query",
            "required": False,
            "description": "So viele Sekunden wartet der Server höchstens auf ein Ergebnis, das er noch nicht hat.",
            "schema": {
                "type": "integer",
                "minimum": 0,
                "maximum": LOOKUP_WAIT_MAX_S,
                "default": LOOKUP_WAIT_DEFAULT_S,
            },
        }
    ]
}


def _invalid(where: str, name: str, message: str) -> ApiError:
    problem = {"loc": [where, name], "msg": message, "type": "value_error"}
    return ApiError(400, ErrorCode.INVALID_REQUEST, message, {"errors": [problem]})


def _wait_of(request: Request) -> int:
    values = request.query_params.getlist("wait")
    if not values:
        return LOOKUP_WAIT_DEFAULT_S
    raw = values[0]
    if len(values) > 1 or not (raw.isascii() and raw.isdigit()) or int(raw) > LOOKUP_WAIT_MAX_S:
        raise _invalid("query", "wait", f"'wait' muss eine ganze Zahl von 0 bis {LOOKUP_WAIT_MAX_S} sein.")
    return int(raw)


@router.get(
    "/lookup/{barcode}",
    operation_id="lookup_barcode",
    response_model=LookupResult,
    openapi_extra=_WAIT_PARAMETER,
)
async def lookup_barcode(
    barcode: Annotated[
        str, Path(description="EAN-8 oder EAN-13 mit gültiger Prüfziffer, in der gespeicherten Form.")
    ],
    request: Request,
    response: Response,
    _device: CurrentDevice,
) -> LookupResult:
    """Schlägt einen Barcode bei Open Food Facts nach, während der Anwender wartet.

    Ein gespeichertes Ergebnis kommt sofort. Sonst stellt der Server den Barcode vorn in die
    Warteschlange seines Hintergrund-Ablaufs und wartet höchstens ``wait`` Sekunden; die Rate
    gilt unverändert. Ungültiger Barcode oder ``wait``: 400.
    """
    if not (barcode.isascii() and is_valid_barcode(barcode)):
        raise _invalid("path", "barcode", "Kein Barcode mit gültiger Prüfziffer (EAN-8 oder EAN-13).")
    wait = _wait_of(request)
    response.headers["Cache-Control"] = "no-store"

    settings = get_settings(request)
    if is_store_internal_barcode(barcode):
        answer = off.Answer(LookupResultState.SKIPPED)
    elif not settings.off_enabled:
        answer = off.Answer(LookupResultState.DISABLED)
    else:
        worker: off.OffWorker | None = request.app.state.off_worker
        if worker is not None:
            answer = await worker.look_up(barcode, wait)
        else:
            # Der Ablauf läuft nicht (mehr), etwa beim Herunterfahren: nur, was gespeichert ist.
            stored = await run_in_threadpool(off.stored_answer_at, settings.database_path, barcode)
            answer = stored or off.PENDING
    return LookupResult(barcode=barcode, **dataclasses.asdict(answer))
