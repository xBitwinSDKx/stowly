"""Produktbilder (docs/sync-protokoll.md, „Bilder")."""

from fastapi import APIRouter, Response

from stowly.api.deps import Db
from stowly.contract.api import ErrorCode
from stowly.errors import ApiError

router = APIRouter(prefix="/images", tags=["images"])

_IMAGE_RESPONSES = {200: {"content": {"image/jpeg": {}, "image/png": {}, "image/webp": {}}}}

IMMUTABLE = "public, max-age=31536000, immutable"


@router.get("/{image_id}", operation_id="get_image", response_class=Response, responses=_IMAGE_RESPONSES)
def get_image(image_id: str, con: Db) -> Response:
    """Ohne Anmeldung, weil ``<img>`` keinen Authorization-Header senden kann. Die Kennung
    ist der Hash des Inhalts; die Antwort ist unveränderlich und darf ewig zwischengespeichert werden.
    """
    row = con.execute("SELECT content_type, data FROM images WHERE id = ?", (image_id,)).fetchone()
    if row is None:
        raise ApiError(404, ErrorCode.NOT_FOUND, "Das Bild gibt es nicht.")
    return Response(
        content=bytes(row["data"]),
        media_type=row["content_type"],
        headers={
            "Cache-Control": IMMUTABLE,
            # Der Typ steht fest (JPEG, PNG oder WebP): Der Browser soll nichts anderes hineindeuten.
            "X-Content-Type-Options": "nosniff",
        },
    )
