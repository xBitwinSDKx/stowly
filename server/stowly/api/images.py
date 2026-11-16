"""Produktbilder (docs/sync-protokoll.md, „Bilder").

Ausgeliefert wird nur, was ein Bild ist: JPEG, PNG oder WebP (``off.IMAGE_TYPES``), und nur, wenn die Bytes
zum gespeicherten Typ passen; sonst 404. Die Antwort trägt eine Content-Security-Policy ohne jede Quelle und
mit ``sandbox`` sowie ``nosniff``: Selbst ein Bild, das eine gefälschte Sicherung mitbrächte, liefe nie als
Seite unter dem Ursprung von Stowly (dort liegt das Geräte-Token).
"""

from fastapi import APIRouter, Response

from stowly import off
from stowly.api.deps import Db
from stowly.contract.api import ErrorCode
from stowly.errors import ApiError

router = APIRouter(prefix="/images", tags=["images"])

_IMAGE_RESPONSES = {200: {"content": {"image/jpeg": {}, "image/png": {}, "image/webp": {}}}}

IMMUTABLE = "public, max-age=31536000, immutable"
# Ein Bild braucht nichts nachzuladen und nichts auszuführen.
IMAGE_CSP = "default-src 'none'; sandbox"
NOT_FOUND = "Das Bild gibt es nicht."


@router.get("/{image_id}", operation_id="get_image", response_class=Response, responses=_IMAGE_RESPONSES)
def get_image(image_id: str, con: Db) -> Response:
    """Ohne Anmeldung, weil ``<img>`` keinen Authorization-Header senden kann. Die Kennung
    ist der Hash des Inhalts; die Antwort ist unveränderlich und darf ewig zwischengespeichert werden.
    """
    row = con.execute("SELECT content_type, data FROM images WHERE id = ?", (image_id,)).fetchone()
    if row is None:
        raise ApiError(404, ErrorCode.NOT_FOUND, NOT_FOUND)
    data = row["data"]
    sniffed = off.sniff_image(data) if isinstance(data, bytes) else None
    if row["content_type"] not in off.IMAGE_TYPES or sniffed is None or sniffed[0] != row["content_type"]:
        raise ApiError(404, ErrorCode.NOT_FOUND, NOT_FOUND)
    return Response(
        content=data,
        media_type=sniffed[0],
        headers={
            "Cache-Control": IMMUTABLE,
            # Der Typ steht fest (JPEG, PNG oder WebP): Der Browser soll nichts anderes hineindeuten.
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": IMAGE_CSP,
        },
    )
