"""Ereignisprotokoll lesen."""

from typing import Annotated

from fastapi import APIRouter, Query

from stowly.contract.api import EventPage
from stowly.errors import not_implemented

router = APIRouter(tags=["events"])


@router.get("/events", operation_id="list_events", response_model=EventPage)
def list_events(
    before: Annotated[int | None, Query(ge=1, description="Nur Einträge mit kleinerer id.")] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    entity: Annotated[
        str | None, Query(max_length=40, description="Nur diese Art von Datensatz, z. B. 'package'.")
    ] = None,
    entity_id: Annotated[str | None, Query(max_length=80)] = None,
) -> EventPage:
    """Neueste zuerst, seitenweise über ``before``."""
    raise not_implemented("Das Ereignisprotokoll")
