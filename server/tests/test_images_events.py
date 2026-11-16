"""Bilder und Ereignisprotokoll über die Schnittstelle (docs/sync-protokoll.md, Abschnitte 11 und 12)."""

import pytest
from support import events_of

from stowly.contract import ids, timeutil
from stowly.contract.api import EventPage

JPEG = b"\xff\xd8\xff\xe0" + b"bild" * 40


def add_image(con, image_id: str, content_type: str, data: bytes) -> None:
    with con:
        con.execute(
            "INSERT INTO images (id, content_type, data, source, source_url, created_at) VALUES (?, ?, ?, 'test', NULL, ?)",
            (image_id, content_type, data, timeutil.now()),
        )


# --- Bilder ------------------------------------------------------------------------------


def test_images_are_served_without_login_and_cached_forever(client, con):
    add_image(con, "9f2c0a1b2c3d4e5f60718293a4b5c6d7.jpg", "image/jpeg", JPEG)
    add_image(con, "00112233445566778899aabbccddeeff.webp", "image/webp", b"RIFF....WEBP")

    response = client.get("/api/images/9f2c0a1b2c3d4e5f60718293a4b5c6d7.jpg")  # kein Authorization-Kopf
    assert response.status_code == 200
    assert response.content == JPEG
    assert response.headers["content-type"] == "image/jpeg"
    assert response.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["content-security-policy"] == "default-src 'none'; sandbox"
    assert int(response.headers["content-length"]) == len(JPEG)

    assert (
        client.get("/api/images/00112233445566778899aabbccddeeff.webp").headers["content-type"]
        == "image/webp"
    )


@pytest.mark.parametrize(
    "content_type, data",
    [
        ("text/html", b"<script>fetch('/api/devices')</script>"),
        ("image/svg+xml", b"<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>"),
        ("image/png", b"<html><script>alert(1)</script></html>"),  # die Bytes passen nicht zum Typ
        ("image/jpeg; charset=utf-8", JPEG),
        ("IMAGE/JPEG", JPEG),
    ],
)
def test_only_real_images_are_served(client, con, content_type, data):
    """Was kein JPEG, PNG oder WebP ist (etwa aus einer gefälschten Sicherung), liefert Stowly nie aus: Es liefe
    sonst als Seite unter dem Ursprung der App, und dort liegt das Geräte-Token."""
    add_image(con, "0123456789abcdef0123456789abcdef.x", content_type, data)
    response = client.get("/api/images/0123456789abcdef0123456789abcdef.x")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
    assert b"script" not in response.content and b"svg" not in response.content


@pytest.mark.parametrize(
    "image_id",
    [
        "gibt-es-nicht.jpg",
        "9f2c0a1b2c3d4e5f60718293a4b5c6d7",
        "9f2c0a1b2c3d4e5f60718293a4b5c6d7.png",
        "..%2Fdaten",
    ],
)
def test_unknown_images_are_404_in_the_error_format(client, con, image_id):
    add_image(con, "9f2c0a1b2c3d4e5f60718293a4b5c6d7.jpg", "image/jpeg", JPEG)
    response = client.get(f"/api/images/{image_id}")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
    assert "immutable" not in response.headers.get("cache-control", "")


# --- Ereignisprotokoll -------------------------------------------------------------------


@pytest.fixture
def history(make_device, clock):
    """Ein Gerät mit etwas Vorgeschichte: 2 Produkte, 5 Packungen, eine Entnahme."""
    device = make_device("Handy")
    rice, create_rice = device.product("Reis")
    pasta, create_pasta = device.product("Nudeln")
    packages = [device.package(rice) for _ in range(3)] + [device.package(pasta) for _ in range(2)]
    device.sync([create_rice, create_pasta, *[command for _, command in packages]])
    clock.advance(3600)
    remove = device.cmd("package.remove", age=120, package_id=packages[0][0], reason="discarded")
    device.sync([remove])
    return device, rice, pasta, [package_id for package_id, _ in packages], remove


def test_events_come_newest_first_with_all_fields(history, client, clock):
    device, rice, _pasta, packages, remove = history
    response = client.get("/api/events", headers=device.headers)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    page = EventPage.model_validate(response.json())  # entspricht dem Vertrag
    assert page.next_before is None  # alles auf einer Seite (Vorgabe: 100)
    identifiers = [event.id for event in page.events]
    assert identifiers == sorted(identifiers, reverse=True)
    assert [event.type for event in page.events] == [
        "package.removed",
        *["package.created"] * 5,
        *["product.created"] * 2,
        "device.login",
        # Beim Start übernommen: STOWLY_PASSWORD als Hash (docs/sync-protokoll.md, 12).
        "server.password_set",
    ]

    newest = response.json()["events"][0]
    assert newest == {
        "id": identifiers[0],
        "at": clock.stamp(120),  # wirksamer Zeitpunkt
        "recorded_at": clock.stamp(),  # Serverzeit beim Verbuchen
        "device_id": device.id,
        "command_id": remove["id"],
        "type": "package.removed",
        "entity": "package",
        "entity_id": packages[0],
        "data": {"reason": "discarded", "product_id": rice, "zone_id": device.zone_id, "best_before": None},
    }


def test_events_are_paged_with_before(history, client):
    device, *_ = history
    seen: list[int] = []
    before = None
    pages = 0
    while True:
        parameters = {"limit": 4} | ({"before": before} if before else {})
        page = client.get("/api/events", params=parameters, headers=device.headers).json()
        pages += 1
        assert len(page["events"]) <= 4
        seen.extend(event["id"] for event in page["events"])
        before = page["next_before"]
        if before is None:
            break
        assert before == page["events"][-1]["id"]
    assert pages == 3  # 10 Einträge (9 und server.password_set vom Start) in Seiten zu 4
    assert seen == sorted(seen, reverse=True) and len(seen) == len(set(seen)) == 10

    # Eine Seite, die genau aufgeht, hat keine Fortsetzung.
    exact = client.get("/api/events", params={"limit": 10}, headers=device.headers).json()
    assert len(exact["events"]) == 10 and exact["next_before"] is None
    assert client.get("/api/events", params={"before": 1}, headers=device.headers).json() == {
        "events": [],
        "next_before": None,
    }


def test_events_can_be_filtered_by_entity_and_id(history, client):
    device, rice, pasta, packages, _remove = history

    def types(**query) -> list[str]:
        return [event["type"] for event in events_of(client, device, **query)]

    assert types(entity="product") == ["product.created"] * 2
    assert types(entity="product", entity_id=pasta) == ["product.created"]
    assert types(entity="package", entity_id=packages[0]) == ["package.created", "package.removed"]
    assert types(entity_id=packages[1]) == ["package.created"]
    assert types(entity="device") == ["device.login"]
    assert types(entity="zone") == []
    assert types(entity="package", entity_id=rice) == []

    # Filter und Blättern zusammen.
    first = client.get("/api/events", params={"entity": "package", "limit": 4}, headers=device.headers).json()
    assert len(first["events"]) == 4 and first["next_before"] is not None
    rest = client.get(
        "/api/events",
        params={"entity": "package", "limit": 4, "before": first["next_before"]},
        headers=device.headers,
    ).json()
    assert len(rest["events"]) == 2 and rest["next_before"] is None


@pytest.mark.parametrize(
    "query",
    [
        {"limit": 0},
        {"limit": 501},
        {"limit": "viele"},
        {"before": 0},
        {"entity": "x" * 41},
        {"entity_id": "x" * 81},
    ],
)
def test_invalid_event_queries_are_422(history, client, query):
    device, *_ = history
    response = client.get("/api/events", params=query, headers=device.headers)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


def test_the_limit_goes_up_to_500(make_device, client):
    device = make_device()
    device.sync([device.cmd("zone.create", zone_id=ids.new_uuid(), name=f"Zone {n}") for n in range(120)])
    assert len(client.get("/api/events", headers=device.headers).json()["events"]) == 100
    full = client.get("/api/events", params={"limit": 500}, headers=device.headers).json()
    # 120 Zonen, die Anmeldung und server.password_set vom Start
    assert len(full["events"]) == 122 and full["next_before"] is None


def test_every_effect_of_a_command_leaves_a_trace(history, client, con):
    """Jeder ausgeführte Befehl mit Wirkung hat mindestens einen Eintrag."""
    device, *_ = history
    applied = {row[0] for row in con.execute("SELECT id FROM commands WHERE status = 'applied'")}
    logged = {event["command_id"] for event in events_of(client, device)}
    assert applied <= logged


def test_an_absurd_before_is_just_the_start(history, client):
    device, *_ = history
    response = client.get("/api/events", params={"before": 10**30, "limit": 2}, headers=device.headers)
    assert response.status_code == 200
    assert len(response.json()["events"]) == 2
