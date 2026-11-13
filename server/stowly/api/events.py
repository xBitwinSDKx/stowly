"""Ereignisprotokoll lesen."""

from typing import Annotated

from fastapi import APIRouter, Query, Response

from stowly import events
from stowly.api.deps import CurrentDevice, Db
from stowly.contract.api import EventPage

router = APIRouter(tags=["events"])


@router.get("/events", operation_id="list_events", response_model=EventPage)
def list_events(
    response: Response,
    _device: CurrentDevice,
    con: Db,
    before: Annotated[int | None, Query(ge=1, description="Nur Einträge mit kleinerer id.")] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    entity: Annotated[
        str | None, Query(max_length=40, description="Nur diese Art von Datensatz, z. B. 'package'.")
    ] = None,
    entity_id: Annotated[str | None, Query(max_length=80)] = None,
) -> dict:
    """Neueste zuerst, seitenweise über ``before``."""
    page, next_before = events.page(con, before=before, limit=limit, entity=entity, entity_id=entity_id)
    response.headers["Cache-Control"] = "no-store"
    return {"events": page, "next_before": next_before}
