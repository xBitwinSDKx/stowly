"""Produktdaten neu abfragen: ``POST /api/lookup/{barcode}/refresh`` (seit 0.5.0; docs/plan-0.5.md, 2;
docs/sync-protokoll.md, 10).

Wie in ``test_lookup.py`` läuft der Hintergrund-Ablauf im ``lifespan`` der App, mit einer Uhr, die beim
Warten auf die Rate nur ihre Zeiger vorstellt; Open Food Facts ist ein ``httpx2.MockTransport``.
"""

import concurrent.futures
import hashlib
import time

import httpx2
import pytest
from fastapi.testclient import TestClient
from support import EAN_A, EAN_B, EAN_C, EAN_STORE, Device, events_of
from test_lookup import STAMP, Scanner, ean, result, start
from test_off import IMAGE_URL, JPEG, NOT_FOUND, PNG, found, wait_for

from stowly import db, off
from stowly.app import create_app
from stowly.contract.api import LOOKUP_REFRESH_GAP_S, LookupResult
from stowly.contract.timeutil import format_timestamp

JPEG_ID = hashlib.sha256(JPEG).hexdigest()[:32] + ".jpg"
PNG_ID = hashlib.sha256(PNG).hexdigest()[:32] + ".png"
OTHER_URL = IMAGE_URL.replace("front_de", "front_en")


def refresh(scanner: Scanner, barcode: str, wait: int | None = None, *, headers: dict | None = None):
    params = {} if wait is None else {"wait": wait}
    return scanner.client.post(
        f"/api/lookup/{barcode}/refresh",
        params=params,
        headers=scanner.device.headers if headers is None else headers,
    )


def refreshed(scanner: Scanner, barcode: str, wait: int | None = 8) -> dict:
    response = refresh(scanner, barcode, wait)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    LookupResult.model_validate(response.json())
    return response.json()


def now_of(scanner: Scanner) -> str:
    """Der Zeitstempel, den der Ablauf gerade schriebe (seine Uhr steht, bis er auf die Rate wartet)."""
    return format_timestamp(scanner.clock.now())


@pytest.fixture
def scanner(settings, clock):
    with start(settings, clock) as running:
        yield running


# --- Neu fragen ----------------------------------------------------------------------------------


def test_refresh_bypasses_the_stored_result_and_not_found_becomes_found(scanner):
    assert scanner.lookup(EAN_A, wait=8) == result(EAN_A, "not_found")
    first = scanner.row(EAN_A)["fetched_at"]
    # Ein GET fragt nie wieder; der Neuabruf schon, auch nach not_found.
    scanner.service.products[EAN_A] = found(product_name="Basmati Reis", brands="Kornhaus", quantity="1 kg")
    assert scanner.lookup(EAN_A, wait=8) == result(EAN_A, "not_found")
    assert scanner.service.lookups == [EAN_A]

    scanner.clock.advance(5)
    answer = refreshed(scanner, EAN_A)
    assert answer == result(EAN_A, "found", "Basmati Reis", "Kornhaus", "1 kg", fetched_at=now_of(scanner))
    assert answer["fetched_at"] > first
    assert scanner.service.lookups == [EAN_A, EAN_A]
    # Der Fund gilt auch für künftige Scans, aus dem Zwischenspeicher.
    assert scanner.lookup(EAN_A, wait=0) == answer
    row = scanner.row(EAN_A)
    assert (row["state"], row["name"], row["next_attempt_at"]) == ("found", "Basmati Reis", None)
    assert len(scanner.service.lookups) == 2


def test_a_found_result_is_replaced_with_its_picture(scanner):
    scanner.service.products[EAN_A] = found(product_name="Reis", image_front_small_url=IMAGE_URL)
    scanner.service.images[IMAGE_URL] = (200, JPEG)
    assert scanner.lookup(EAN_A, wait=8) == result(EAN_A, "found", "Reis", image_id=JPEG_ID)

    scanner.service.products[EAN_A] = found(
        product_name_de="Basmati Reis", brands="Kornhaus", image_front_small_url=OTHER_URL
    )
    scanner.service.images[OTHER_URL] = (200, PNG)
    answer = refreshed(scanner, EAN_A)
    assert answer == result(EAN_A, "found", "Basmati Reis", "Kornhaus", image_id=PNG_ID)
    # Das neue Bild liegt beim Server und ist ohne Anmeldung abrufbar; das alte bleibt.
    assert scanner.client.get(f"/api/images/{PNG_ID}").content == PNG
    assert scanner.client.get(f"/api/images/{JPEG_ID}").content == JPEG
    assert scanner.service.image_requests == [IMAGE_URL, OTHER_URL]
    assert scanner.row(EAN_A)["image_url"] == OTHER_URL
    assert scanner.lookup(EAN_A, wait=0) == answer


def test_a_barcode_never_looked_up_is_looked_up(scanner):
    scanner.service.products[EAN_A] = found(product_name="Reis")
    assert scanner.row(EAN_A) is None
    assert refreshed(scanner, EAN_A) == result(EAN_A, "found", "Reis")
    assert scanner.state_of(EAN_A) == "found"
    assert refreshed(scanner, EAN_B)["state"] == "not_found"
    assert scanner.state_of(EAN_B) == "not_found"


def test_refresh_does_not_wait_for_the_next_attempt_after_a_failure(scanner):
    scanner.service.products[EAN_A] = [(500, b"kaputt"), found(product_name="Linsen")]
    assert scanner.lookup(EAN_A, wait=8) == result(EAN_A, "pending")  # neuer Versuch erst in einer Minute
    assert scanner.lookup(EAN_A, wait=8) == result(EAN_A, "pending")
    assert refreshed(scanner, EAN_A) == result(EAN_A, "found", "Linsen")
    assert scanner.service.lookups == [EAN_A, EAN_A]


# --- Was nichts ändert ---------------------------------------------------------------------------


@pytest.mark.parametrize("failure", [(500, b"kaputt"), (503, b""), httpx2.ConnectError("weg")])
def test_a_failure_changes_nothing(scanner, failure):
    scanner.service.products[EAN_A] = found(product_name="Reis", image_front_small_url=IMAGE_URL)
    scanner.service.images[IMAGE_URL] = (200, JPEG)
    scanner.lookup(EAN_A, wait=8)
    before = scanner.row(EAN_A)

    scanner.service.products[EAN_A] = failure
    assert refreshed(scanner, EAN_A) == result(EAN_A, "pending")
    assert scanner.row(EAN_A) == before
    assert scanner.lookup(EAN_A, wait=0) == result(EAN_A, "found", "Reis", image_id=JPEG_ID)
    assert scanner.service.lookups == [EAN_A, EAN_A]


def test_not_found_is_reported_but_does_not_overwrite_a_find(scanner):
    scanner.service.products[EAN_A] = found(product_name="Reis")
    stored = scanner.lookup(EAN_A, wait=8)
    before = scanner.row(EAN_A)

    scanner.service.products[EAN_A] = NOT_FOUND
    scanner.clock.advance(3)
    assert refreshed(scanner, EAN_A) == result(EAN_A, "not_found", fetched_at=now_of(scanner))
    assert scanner.row(EAN_A) == before
    assert scanner.lookup(EAN_A, wait=0) == stored


def test_no_product_changes(scanner):
    """Was die App übernimmt, entscheidet der Anwender: Der Neuabruf ändert kein Produkt, auch nicht ``lookup``."""
    device = scanner.device
    # Ein Platzhalter, den Open Food Facts nicht kannte, und ein Produkt mit getipptem Namen und Fund.
    unknown_id, unknown = device.product("", barcodes=[EAN_A])
    typed_id, typed = device.product("Reis vom Markt", barcodes=[EAN_B])
    scanner.service.products[EAN_B] = found(product_name="Basmati Reis", image_front_small_url=IMAGE_URL)
    scanner.service.images[IMAGE_URL] = (500, b"")  # das Bild kommt erst beim Neuabruf
    device.sync([unknown, typed])
    wait_for(lambda: scanner.state_of(EAN_A) == "not_found" and scanner.state_of(EAN_B) == "found")
    wait_for(lambda: scanner.row(EAN_B)["next_attempt_at"] is not None)  # das Bild: neuer Versuch geplant
    device.sync()
    before = {product_id: dict(device.products[product_id]) for product_id in (unknown_id, typed_id)}
    assert before[unknown_id]["lookup"] == "not_found" and before[typed_id]["image"] is None

    scanner.service.products[EAN_A] = found(product_name="Linsen", image_front_small_url=OTHER_URL)
    scanner.service.images[OTHER_URL] = (200, PNG)
    scanner.service.products[EAN_B] = found(product_name="Basmati Reis", image_front_small_url=IMAGE_URL)
    scanner.service.images[IMAGE_URL] = (200, JPEG)
    assert refreshed(scanner, EAN_A) == result(EAN_A, "found", "Linsen", image_id=PNG_ID)
    assert refreshed(scanner, EAN_B) == result(EAN_B, "found", "Basmati Reis", image_id=JPEG_ID)

    cursor = device.cursor
    data = device.sync()
    assert data["changes"]["products"] == []
    assert data["cursor"] == cursor
    assert {product_id: device.products[product_id] for product_id in before} == before
    for product_id in before:
        log = events_of(scanner.client, device, entity="product", entity_id=product_id)
        assert [entry["type"] for entry in log] == ["product.created", "product.lookup"]
    # Ein Bild holt der Ablauf nach einem Neuabruf nicht von sich aus für ein fertiges Produkt nach.
    assert scanner.row(EAN_B)["next_attempt_at"] is None


# --- Grenzen -------------------------------------------------------------------------------------


def test_once_per_barcode_and_minute_otherwise_the_stored_result(scanner):
    scanner.service.products[EAN_A] = found(product_name="Reis")
    fresh = refreshed(scanner, EAN_A)
    assert fresh == result(EAN_A, "found", "Reis")

    scanner.service.products[EAN_A] = found(product_name="Basmati Reis")
    scanner.clock.advance(LOOKUP_REFRESH_GAP_S - 1)
    assert refreshed(scanner, EAN_A) == {**fresh, "throttled": True}
    # Ein anderer Barcode ist frei.
    assert refreshed(scanner, EAN_B) == result(EAN_B, "not_found")
    assert scanner.service.lookups == [EAN_A, EAN_B]

    scanner.clock.advance(1)
    assert refreshed(scanner, EAN_A) == result(EAN_A, "found", "Basmati Reis")
    assert scanner.service.lookups == [EAN_A, EAN_B, EAN_A]


def test_throttled_without_a_stored_result_is_pending(scanner):
    scanner.service.products[EAN_A] = (500, b"kaputt")
    assert refreshed(scanner, EAN_A) == result(EAN_A, "pending")
    assert refreshed(scanner, EAN_A) == result(EAN_A, "pending", throttled=True)
    assert scanner.service.lookups == [EAN_A]


def test_while_open_food_facts_slows_down_the_stored_result(scanner):
    scanner.service.products[EAN_A] = found(product_name="Reis")
    stored = scanner.lookup(EAN_A, wait=8)
    scanner.service.products[EAN_B] = found(product_name="Nudeln")
    stored_b = scanner.lookup(EAN_B, wait=8)

    # Bremst Open Food Facts den Neuabruf selbst (429), kommt der gespeicherte Stand.
    scanner.service.products[EAN_A] = (429, b"", {"retry-after": "120"})
    assert refreshed(scanner, EAN_A) == {**stored, "throttled": True}
    assert scanner.row(EAN_A)["state"] == "found"
    # Danach ruht der Ablauf: Auch ein anderer Barcode wird nicht neu gefragt.
    scanner.service.products[EAN_B] = found(product_name="Spaghetti")
    assert refreshed(scanner, EAN_B) == {**stored_b, "throttled": True}
    assert scanner.service.lookups == [EAN_A, EAN_B, EAN_A]

    scanner.clock.advance(121)
    assert refreshed(scanner, EAN_B) == result(EAN_B, "found", "Spaghetti")


def test_refreshes_count_into_the_rate(scanner):
    codes = [ean(number) for number in range(off.LOOKUPS_PER_MINUTE + 1)]
    for code in codes:
        assert refreshed(scanner, code, wait=8) == result(code, "not_found")
    assert scanner.service.lookups == codes
    times = [at for at, _ in scanner.service.calls]
    assert times[off.LOOKUPS_PER_MINUTE - 1] == 0 and times[off.LOOKUPS_PER_MINUTE] >= 60


def test_at_most_five_refreshes_wait_and_scans_go_first(scanner):
    """Neuabrufe sind begrenzt, auch zu Barcodes mit Produkt; ein Scan wartet nie hinter ihnen."""
    codes = [ean(number) for number in range(off.MAX_OPEN_REFRESHES + 1)]
    scanner.device.sync([scanner.device.product("", barcodes=[code])[1] for code in codes])
    wait_for(lambda: all(scanner.state_of(code) == "not_found" for code in codes))
    scanner.service.held.add(codes[0])
    for code in codes[: off.MAX_OPEN_REFRESHES]:
        assert refreshed(scanner, code, wait=0) == result(code, "pending")
    wait_for(lambda: scanner.service.arrived == [codes[0]])
    # Der sechste wartet nicht: der gespeicherte Stand, gebremst.
    extra = codes[off.MAX_OPEN_REFRESHES]
    assert refreshed(scanner, extra, wait=0) == result(extra, "not_found", throttled=True)
    # Ein Scan in der Zwischenzeit kommt vor den wartenden Neuabrufen dran.
    assert scanner.lookup(EAN_A, wait=0) == result(EAN_A, "pending")
    scanner.service.gate.set()
    wait_for(lambda: len(scanner.service.lookups) == 2 * len(codes))
    assert scanner.service.lookups[len(codes) :] == [codes[0], EAN_A, *codes[1 : off.MAX_OPEN_REFRESHES]]
    # Danach ist wieder Platz.
    assert refreshed(scanner, extra, wait=8) == result(extra, "not_found")


def test_refresh_goes_before_the_products_that_wait(scanner):
    scanner.service.products[EAN_A] = found(product_name="Reis")
    scanner.lookup(EAN_A, wait=8)
    codes = [ean(number) for number in range(3)]
    scanner.service.held.add(codes[0])
    scanner.device.sync([scanner.device.product("", barcodes=[code])[1] for code in codes])
    wait_for(lambda: scanner.service.arrived == [codes[0]])

    assert refreshed(scanner, EAN_A, wait=0) == result(EAN_A, "pending")
    scanner.service.gate.set()
    wait_for(lambda: len(scanner.service.lookups) == 5)
    assert scanner.service.lookups == [EAN_A, codes[0], EAN_A, codes[1], codes[2]]


def test_concurrent_refreshes_share_one_query(scanner):
    scanner.service.products[EAN_A] = found(product_name="Reis")
    scanner.lookup(EAN_A, wait=8)
    scanner.service.products[EAN_A] = found(product_name="Basmati Reis")
    scanner.service.held.add(EAN_A)
    with concurrent.futures.ThreadPoolExecutor(3) as pool:
        first = pool.submit(refreshed, scanner, EAN_A, 8)
        wait_for(lambda: scanner.service.arrived == [EAN_A])
        later = [pool.submit(refreshed, scanner, EAN_A, 8) for _ in range(2)]
        wait_for(lambda: scanner.waiting() == {EAN_A: 3})
        # Ein Scan in der Zwischenzeit bekommt den gespeicherten Stand, ohne zu warten.
        assert scanner.lookup(EAN_A, wait=8) == result(EAN_A, "found", "Reis")
        scanner.service.gate.set()
        answers = [future.result(timeout=10) for future in (first, *later)]
    assert answers == [result(EAN_A, "found", "Basmati Reis")] * 3
    assert scanner.service.lookups == [EAN_A, EAN_A]


def test_too_slow_is_pending_and_the_refresh_ends_in_the_background(scanner):
    scanner.service.products[EAN_A] = found(product_name="Reis")
    scanner.lookup(EAN_A, wait=8)
    scanner.service.products[EAN_A] = found(product_name="Basmati Reis")
    scanner.service.held.add(EAN_A)
    started = time.monotonic()
    assert refreshed(scanner, EAN_A, wait=1) == result(EAN_A, "pending")
    assert 0.9 <= time.monotonic() - started < 4
    scanner.service.gate.set()
    wait_for(lambda: scanner.row(EAN_A)["name"] == "Basmati Reis")
    assert scanner.lookup(EAN_A, wait=0) == result(EAN_A, "found", "Basmati Reis")


# --- Vertrag ---------------------------------------------------------------------------------------


def test_store_internal_codes_are_skipped(scanner):
    assert refreshed(scanner, EAN_STORE) == result(EAN_STORE, "skipped")
    assert scanner.service.calls == []
    assert scanner.row(EAN_STORE) is None


def test_switched_off_says_disabled(client, make_device, settings):
    """Die Vorgabe der Tests: STOWLY_OFF_ENABLED=0. Auch ein gespeichertes Ergebnis gilt dann nicht."""
    device = make_device()
    con = db.connect(settings.database_path)
    try:
        with db.transaction(con):
            con.execute(
                "INSERT INTO off_lookups (barcode, state, attempts, name) VALUES (?, 'found', 1, 'Reis')",
                (EAN_A,),
            )
    finally:
        con.close()
    for code in (EAN_A, EAN_B):
        response = client.post(f"/api/lookup/{code}/refresh", params={"wait": 8}, headers=device.headers)
        assert response.status_code == 200
        assert response.json() == result(code, "disabled")


def test_without_the_background_task_only_the_stored_result(settings, clock):
    with start(settings, clock) as scanner:
        scanner.service.products[EAN_A] = found(product_name="Reis")
        stored = scanner.lookup(EAN_A, wait=8)
        enabled = scanner.settings
    client = TestClient(create_app(enabled))  # ohne lifespan: kein Ablauf
    device = Device(client, clock=clock)
    response = client.post(f"/api/lookup/{EAN_A}/refresh", headers=device.headers)
    assert response.json() == {**stored, "throttled": True}
    response = client.post(f"/api/lookup/{EAN_C}/refresh", headers=device.headers)
    assert response.json() == result(EAN_C, "pending", throttled=True)


@pytest.mark.parametrize("barcode", ["12345", "4006381333932", "036000291452", "400638133393a"])
def test_an_invalid_barcode_is_400(scanner, barcode):
    response = refresh(scanner, barcode, 0)
    assert response.status_code == 400
    error = response.json()["error"]
    assert [problem["loc"] for problem in error["details"]["errors"]] == [["path", "barcode"]]
    assert scanner.service.calls == []


@pytest.mark.parametrize("query", ["wait=-1", "wait=9", "wait=abc", "wait=1&wait=2"])
def test_an_invalid_wait_is_400(scanner, query):
    response = scanner.client.post(f"/api/lookup/{EAN_A}/refresh?{query}", headers=scanner.device.headers)
    assert response.status_code == 400
    assert [problem["loc"] for problem in response.json()["error"]["details"]["errors"]] == [
        ["query", "wait"]
    ]
    assert scanner.service.calls == []


def test_without_a_valid_token_401(scanner):
    for headers in ({}, {"Authorization": "Bearer unbekannt"}):
        response = refresh(scanner, EAN_A, 0, headers=headers)
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "unauthorized"
    assert scanner.service.calls == []


def test_the_address_of_open_food_facts_is_fixed(scanner):
    """Gefragt wird nur die feste Adresse von Open Food Facts (``STOWLY_OFF_URL``), nie eine aus der Anfrage."""
    scanner.service.products[EAN_A] = found(product_name="Reis")
    response = scanner.client.post(
        f"/api/lookup/{EAN_A}/refresh?wait=8&url=https://fremd.example",
        headers={**scanner.device.headers, "X-Forwarded-Host": "fremd.example"},
    )
    assert response.status_code == 200
    assert response.json()["fetched_at"] == STAMP
    (request,) = [request for _, request in scanner.service.calls]
    assert str(request.url) == (
        f"https://world.openfoodfacts.org/api/v3/product/{EAN_A}"
        "?product_type=all&lc=de&fields=product_name_de,product_name,brands,quantity,image_front_small_url"
    )


def test_a_scan_that_shares_a_refresh_is_never_throttled(scanner):
    """``throttled`` gibt es nur beim Neuabruf, auch wenn ein Scan dessen Abfrage mitbenutzt."""
    scanner.service.products[EAN_A] = (429, b"", {"retry-after": "120"})
    scanner.service.held.add(EAN_A)
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        again = pool.submit(refreshed, scanner, EAN_A, 8)
        wait_for(lambda: scanner.service.arrived == [EAN_A])
        scan = pool.submit(scanner.lookup, EAN_A, 8)
        wait_for(lambda: scanner.waiting() == {EAN_A: 2})
        scanner.service.gate.set()
        assert again.result(timeout=10) == result(EAN_A, "pending", throttled=True)
        assert scan.result(timeout=10) == result(EAN_A, "pending")
    assert scanner.service.lookups == [EAN_A]
    assert scanner.row(EAN_A) is None  # ein Fehlschlag ändert nichts, auch für einen fremden Barcode
