"""Produkte außerhalb des Sync (seit 0.5.0; docs/plan-0.5.md, 2; docs/sync-protokoll.md, 11).

Bisher setzte nur der Server ein Produktbild (beim Nachschlagen). Nach „Online abfragen" setzt die App
es hier, auf ein Bild, das Stowly selbst gespeichert hat. Das Protokoll des Sync bleibt, und
``product.update`` ändert sich nicht. Pfade, Modelle und Beschreibungen sind Vertrag
(``docs/openapi.json``); umsetzen heißt, die Rümpfe zu füllen.
"""

import sqlite3

from fastapi import APIRouter, Response

from stowly import db, events, off, records
from stowly.api.deps import CurrentDevice, Db
from stowly.contract import timeutil
from stowly.contract.api import ErrorCode, ProductImageInput
from stowly.contract.entities import Product
from stowly.errors import ApiError

router = APIRouter(prefix="/products", tags=["products"])

NO_PRODUCT = "Das Produkt gibt es nicht."
NO_IMAGE = "Dieses Bild hat Stowly nicht gespeichert."


def _servable(con: sqlite3.Connection, image_id: str) -> bool:
    """Ein Bild, das Stowly gespeichert hat und auch ausliefert (wie ``GET /api/images/{id}``): JPEG,
    PNG oder WebP, und die Bytes passen zum Typ."""
    row = con.execute(
        "SELECT content_type, substr(data, 1, 16) AS head FROM images WHERE id = ?", (image_id,)
    ).fetchone()
    if row is None or row["content_type"] not in off.IMAGE_TYPES or not isinstance(row["head"], bytes):
        return False
    sniffed = off.sniff_image(row["head"])
    return sniffed is not None and sniffed[0] == row["content_type"]


@router.put("/{product_id}/image", operation_id="set_product_image", response_model=Product)
def set_product_image(
    product_id: str, body: ProductImageInput, device: CurrentDevice, response: Response, con: Db
) -> Product:
    """Setzt das Bild eines Produkts auf ein Bild, das Stowly gespeichert hat (``image_id`` aus
    ``LookupResult``), oder entfernt es (``null``). 404 ohne Produkt (auch ein zusammengeführtes),
    422 für ein unbekanntes Bild. Das Produkt bekommt einen neuen ``rev``, also sehen alle Geräte das
    Bild beim nächsten Sync; die Antwort ist das Produkt danach. Ereignis ``product.image``."""
    response.headers["Cache-Control"] = "no-store"
    now = timeutil.now()
    with db.transaction(con):
        row = con.execute(
            "SELECT * FROM products WHERE id = ? AND deleted_at IS NULL AND merged_into IS NULL",
            (product_id,),
        ).fetchone()
        if row is None:
            raise ApiError(404, ErrorCode.NOT_FOUND, NO_PRODUCT)
        if body.image_id is not None and not _servable(con, body.image_id):
            problem = {"loc": ["body", "image_id"], "msg": NO_IMAGE, "type": "unknown_image"}
            raise ApiError(422, ErrorCode.INVALID_REQUEST, NO_IMAGE, {"errors": [problem]})
        if row["image"] != body.image_id:
            # Wie das Bild aus dem Nachschlagen (off.attach_image): neuer rev, die Uhren der Felder bleiben.
            con.execute(
                "UPDATE products SET image = ?, updated_at = max(updated_at, ?), rev = ? WHERE id = ?",
                (body.image_id, now, db.next_rev(con), product_id),
            )
            events.record(
                con,
                at=now,
                recorded_at=now,
                device_id=device["id"],
                type="product.image",
                entity="product",
                entity_id=product_id,
                data={"old": row["image"], "new": body.image_id},
            )
            row = con.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
        product = records.products(con, [row])[0]
    return Product.model_validate(product)
