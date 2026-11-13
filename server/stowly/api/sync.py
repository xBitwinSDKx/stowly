"""Der Sync-Aufruf (docs/sync-protokoll.md, „Sync-Aufruf")."""

import json
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Request, Response
from starlette.concurrency import run_in_threadpool

from stowly.api.deps import CurrentDevice, Db, get_settings
from stowly.config import MAX_REQUEST_BYTES
from stowly.contract.api import ErrorCode
from stowly.contract.sync import SyncResponse
from stowly.errors import ApiError
from stowly.sync import service

router = APIRouter(tags=["sync"])

# Obergrenze für den Rumpf. 500 Befehle bleiben weit darunter; mehr ist kein Sync. Die App
# weist größere Anfragen schon am angekündigten Umfang ab (stowly/app.py); hier wird
# zusätzlich mitgezählt, falls der Umfang nicht angekündigt ist.
MAX_BODY_BYTES = MAX_REQUEST_BYTES
# Tiefer verschachtelt ist kein Befehl des Katalogs (der tiefste braucht sechs Ebenen). Die Grenze
# hält absichtlich tief verschachteltes JSON von allem fern, was es rekursiv durchläuft.
MAX_NESTING = 32

# Der Rumpf wird bewusst nicht von FastAPI geprüft: Ein einzelner ungültiger Befehl
# darf nicht die ganze Anfrage scheitern lassen, sonst bliebe die Outbox des Geräts
# für immer stecken. Der Endpunkt liest das JSON selbst und prüft jeden Befehl einzeln
# (pydantic.TypeAdapter(Command)); ungültige Befehle bekommen das Ergebnis rejected/invalid.
_REQUEST_BODY = {
    "requestBody": {
        "required": True,
        "content": {"application/json": {"schema": {"$ref": "#/components/schemas/SyncRequest"}}},
    }
}


def server_now() -> datetime:
    """Empfangszeit einer Anfrage. Eigene Funktion, damit Tests die Serveruhr anhalten können."""
    return datetime.now(UTC)


def _too_large() -> ApiError:
    return ApiError(
        413,
        ErrorCode.PAYLOAD_TOO_LARGE,
        "Die Anfrage ist zu groß.",
        {"max_bytes": MAX_BODY_BYTES},
    )


async def _read_json(request: Request) -> Any:
    """Liest den Rumpf mit Obergrenze und deutet ihn als JSON (422, wenn er keines ist)."""
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > MAX_BODY_BYTES:
        raise _too_large()
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_BODY_BYTES:
            raise _too_large()
        chunks.append(chunk)
    try:
        body = json.loads(b"".join(chunks))
        reason = None if _nesting_ok(body) else "zu tief verschachtelt"
    except RecursionError:
        reason = "zu tief verschachtelt"
    except ValueError as exc:  # auch UnicodeDecodeError
        reason = str(exc)
    if reason is not None:
        raise ApiError(
            422,
            ErrorCode.INVALID_REQUEST,
            "Die Anfrage entspricht nicht dem Vertrag.",
            {"errors": [{"loc": ["body"], "msg": f"Kein gültiges JSON: {reason}", "type": "json_invalid"}]},
        )
    return body


def _nesting_ok(value: Any) -> bool:
    """Wahr, wenn das JSON höchstens ``MAX_NESTING`` Ebenen tief ist. Ohne Rekursion geprüft."""
    level = [value]
    for _depth in range(MAX_NESTING):
        deeper: list[Any] = []
        for item in level:
            if isinstance(item, dict):
                deeper.extend(item.values())
            elif isinstance(item, list):
                deeper.extend(item)
        if not deeper:
            return True
        level = deeper
    return False


@router.post("/sync", operation_id="sync", response_model=SyncResponse, openapi_extra=_REQUEST_BODY)
async def sync(request: Request, device: CurrentDevice, con: Db) -> Response:
    """Nimmt Befehle an und liefert alle Änderungen seit ``cursor``."""
    frame = service.parse_frame(await _read_json(request))
    received = server_now()
    # Die Datenbankarbeit blockiert und gehört deshalb nicht in die Ereignisschleife.
    outcome = await run_in_threadpool(
        service.run,
        con,
        device_id=device["id"],
        frame=frame,
        received=received,
        off_enabled=get_settings(request).off_enabled,
    )
    worker = getattr(request.app.state, "off_worker", None)
    if worker is not None and outcome.lookup_pending:
        worker.wake()
    return Response(
        content=outcome.body, media_type="application/json", headers={"Cache-Control": "no-store"}
    )
