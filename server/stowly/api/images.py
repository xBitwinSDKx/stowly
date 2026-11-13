"""Produktbilder (docs/sync-protokoll.md, „Bilder")."""

from fastapi import APIRouter, Response

from stowly.errors import not_implemented

router = APIRouter(prefix="/images", tags=["images"])

_IMAGE_RESPONSES = {200: {"content": {"image/jpeg": {}, "image/png": {}, "image/webp": {}}}}


@router.get("/{image_id}", operation_id="get_image", response_class=Response, responses=_IMAGE_RESPONSES)
def get_image(image_id: str) -> Response:
    """Ohne Anmeldung, weil ``<img>`` keinen Authorization-Header senden kann. Die Kennung
    ist der Hash des Inhalts; die Antwort ist unveränderlich und darf ewig zwischengespeichert werden.
    """
    raise not_implemented("Die Bildauslieferung")
