"""Produktbild setzen: ``PUT /api/products/{product_id}/image`` (seit 0.5.0; docs/plan-0.5.md, 2).

Nur Bilder, die Stowly selbst gespeichert hat (Tabelle ``images``), und nur solche, die es auch ausliefert.
Das Produkt bekommt einen neuen ``rev``; alle Geräte sehen das Bild beim nächsten Sync.
"""

import hashlib

import pytest
from support import EAN_A, EAN_B, events_of
from test_off import JPEG, PNG

from stowly import db, off
from stowly.contract import ids
from stowly.contract.entities import Product

JPEG_ID = hashlib.sha256(JPEG).hexdigest()[:32] + ".jpg"
PNG_ID = hashlib.sha256(PNG).hexdigest()[:32] + ".png"


def store_image(con, data: bytes, image_id: str, content_type: str) -> None:
    """Ein Bild, wie es das Nachschlagen speichert (``OffWorker._save_image``)."""
    with db.transaction(con):
        con.execute(
            "INSERT INTO images (id, content_type, data, source, source_url, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (image_id, content_type, data, off.IMAGE_SOURCE, None, "2026-11-16T09:00:00.000Z"),
        )


def put_image(client, device, product_id: str, image_id):
    return client.put(
        f"/api/products/{product_id}/image", json={"image_id": image_id}, headers=device.headers
    )


@pytest.fixture
def images(con):
    store_image(con, JPEG, JPEG_ID, "image/jpeg")
    store_image(con, PNG, PNG_ID, "image/png")
    return con


def test_set_and_remove_the_image(client, make_device, images):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    product_id, _package = phone.store("Basmati Reis")
    tablet.sync()
    cursor = tablet.cursor

    response = put_image(client, phone, product_id, JPEG_ID)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    product = Product.model_validate(response.json()).model_dump(mode="json")
    assert (product["image"], product["name"], product["lookup"]) == (JPEG_ID, "Basmati Reis", "none")

    # Neuer rev: Das andere Gerät bekommt das Produkt mit dem Bild beim nächsten Sync.
    data = tablet.sync()
    assert [p["id"] for p in data["changes"]["products"]] == [product_id]
    assert data["cursor"] > cursor
    assert tablet.products[product_id] == response.json()
    assert client.get(f"/api/images/{JPEG_ID}").content == JPEG

    # Ein anderes Bild, dann keines.
    assert put_image(client, phone, product_id, PNG_ID).json()["image"] == PNG_ID
    removed = put_image(client, phone, product_id, None)
    assert removed.status_code == 200
    assert removed.json()["image"] is None
    tablet.sync()
    assert tablet.products[product_id]["image"] is None

    log = [
        e
        for e in events_of(client, phone, entity="product", entity_id=product_id)
        if e["type"] == "product.image"
    ]
    assert [(e["data"], e["device_id"], e["command_id"]) for e in log] == [
        ({"old": None, "new": JPEG_ID}, phone.id, None),
        ({"old": JPEG_ID, "new": PNG_ID}, phone.id, None),
        ({"old": PNG_ID, "new": None}, phone.id, None),
    ]


def test_the_same_image_again_changes_nothing(client, make_device, images):
    device = make_device()
    product_id, _ = device.store()
    assert put_image(client, device, product_id, JPEG_ID).status_code == 200
    device.sync()
    cursor = device.cursor
    again = put_image(client, device, product_id, JPEG_ID)
    assert again.status_code == 200 and again.json()["image"] == JPEG_ID
    assert device.sync()["changes"]["products"] == []
    assert device.cursor == cursor
    log = events_of(client, device, entity="product", entity_id=product_id)
    assert [e["type"] for e in log].count("product.image") == 1


def test_only_images_stowly_stored(client, make_device, images):
    device = make_device()
    product_id, _ = device.store()
    device.sync()
    cursor = device.cursor
    # Ein Bild, das es nicht gibt, und eines, dessen Bytes nicht zum Typ passen (so liefert Stowly es nie aus).
    store_image(images, b"<svg onload=alert(1)>" + b"x" * 20, "a" * 32 + ".jpg", "image/jpeg")
    store_image(images, JPEG, "b" * 32 + ".svg", "image/svg+xml")
    for image_id in ("0" * 32 + ".jpg", "a" * 32 + ".jpg", "b" * 32 + ".svg", "../" + JPEG_ID, ""):
        response = put_image(client, device, product_id, image_id)
        assert response.status_code == 422, image_id
        error = response.json()["error"]
        assert error["code"] == "invalid_request"
        assert error["message"] == "Dieses Bild hat Stowly nicht gespeichert."
        assert [problem["loc"] for problem in error["details"]["errors"]] == [["body", "image_id"]]
    assert device.sync()["changes"]["products"] == []
    assert device.cursor == cursor
    log = events_of(client, device, entity="product", entity_id=product_id)
    assert "product.image" not in [e["type"] for e in log]


def test_without_a_product_404(client, make_device, images):
    device = make_device()
    for product_id in (ids.new_uuid(), "kein-produkt"):
        response = put_image(client, device, product_id, JPEG_ID)
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "not_found"
    # Ein zusammengeführtes Produkt gibt es nicht mehr: Es ist im Ziel aufgegangen.
    source_id, create_source = device.product("Reis", barcodes=[EAN_A])
    target_id, create_target = device.product("Basmati Reis", barcodes=[EAN_B])
    device.sync([create_source, create_target])
    merge = device.cmd("product.merge", source_id=source_id, target_id=target_id)
    assert device.sync([merge])["results"][0]["status"] == "applied"
    assert put_image(client, device, source_id, JPEG_ID).status_code == 404
    assert put_image(client, device, target_id, JPEG_ID).status_code == 200


def test_the_contract_of_the_body(client, make_device, images):
    device = make_device()
    product_id, _ = device.store()
    for body in ({}, {"image_id": 5}, {"image_id": "x" * 101}, {"image_id": JPEG_ID, "mehr": 1}):
        response = client.put(f"/api/products/{product_id}/image", json=body, headers=device.headers)
        assert response.status_code == 422, body
    for headers in ({}, {"Authorization": "Bearer unbekannt"}):
        response = client.put(
            f"/api/products/{product_id}/image", json={"image_id": JPEG_ID}, headers=headers
        )
        assert response.status_code == 401


def test_the_image_does_not_touch_the_fields_and_their_clocks(client, make_device, images, clock):
    """Das Bild steht außerhalb des Sync: ``product.update`` bleibt, wie es ist, auch mit älterem Zeitpunkt."""
    device = make_device()
    product_id, _ = device.store("Reis")
    assert put_image(client, device, product_id, JPEG_ID).status_code == 200
    update = device.cmd("product.update", age=30, product_id=product_id, changes={"name": "Basmati Reis"})
    assert device.sync([update])["results"][0]["status"] == "applied"
    product = device.products[product_id]
    assert (product["name"], product["image"]) == ("Basmati Reis", JPEG_ID)
