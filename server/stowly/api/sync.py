"""Der Sync-Aufruf (docs/sync-protokoll.md, „Sync-Aufruf")."""

from fastapi import APIRouter, Request

from stowly.contract.sync import SyncResponse
from stowly.errors import not_implemented

router = APIRouter(tags=["sync"])

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


@router.post("/sync", operation_id="sync", response_model=SyncResponse, openapi_extra=_REQUEST_BODY)
async def sync(request: Request) -> SyncResponse:
    """Nimmt Befehle an und liefert alle Änderungen seit ``cursor``."""
    raise not_implemented("Der Sync")
