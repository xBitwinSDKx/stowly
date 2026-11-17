"""Barcode beim Scannen nachschlagen: ``GET /api/lookup/{barcode}`` (docs/sync-protokoll.md, Abschnitt 10).

Wie in ``test_off.py`` ruft kein Test den echten Dienst auf: An die Stelle der Verbindung tritt
ein ``httpx2.MockTransport``. Der Hintergrund-Ablauf läuft hier wie im Betrieb im ``lifespan``
der App, mit einer Uhr, die beim Warten auf die Rate nicht wirklich wartet. Wo ein Test einen
langsamen Dienst braucht, hält ein Tor die Abfrage an, bis der Test es öffnet.
"""

import asyncio
import concurrent.futures
import contextlib
import dataclasses
import hashlib
import http.client
import json
import threading
import time
from collections.abc import Iterator

import httpx2
import pytest
import uvicorn
from fastapi.testclient import TestClient
from support import EAN_A, EAN_B, EAN_C, EAN_STORE, TEST_PASSWORD, Device, ServerClock, events_of
from test_off import IMAGE_URL, JPEG, PNG, FakeClock, FakeOff, found, wait_for

from stowly import db, off
from stowly.__main__ import Server
from stowly.app import create_app, prepare_database
from stowly.config import Settings
from stowly.contract import ids, timeutil

JPEG_ID = hashlib.sha256(JPEG).hexdigest()[:32] + ".jpg"
OTHER_URL = IMAGE_URL.replace("front_de", "front_en")


def ean(number: int) -> str:
    """Ein erfundener EAN-13 mit gültiger Prüfziffer."""
    body = f"40063813{number:04d}"
    return body + str(ids.gtin_check_digit(body))


class AnyTimestamp:
    """Gleich jedem Zeitstempel des Vertrags: wann Open Food Facts geantwortet hat, steht in ``off_lookups``."""

    def __eq__(self, other: object) -> bool:
        return isinstance(other, str) and timeutil.is_timestamp(other)

    def __repr__(self) -> str:
        return "<Zeitstempel>"


STAMP = AnyTimestamp()


def result(
    barcode: str,
    state: str,
    name: str = "",
    brand: str = "",
    quantity: str = "",
    image_id=None,
    *,
    fetched_at=...,
    throttled: bool = False,
) -> dict:
    """Die erwartete Antwort. ``fetched_at`` ist bei einem Ergebnis von Open Food Facts ein Zeitstempel
    (seit 0.5.0), sonst ``null``; ``throttled`` gibt es nur beim Neuabruf."""
    if fetched_at is ...:
        fetched_at = STAMP if state in ("found", "not_found") else None
    return {
        "barcode": barcode,
        "state": state,
        "name": name,
        "brand": brand,
        "quantity": quantity,
        "image_id": image_id,
        "fetched_at": fetched_at,
        "throttled": throttled,
    }


class GatedOff(FakeOff):
    """Der nachgespielte Dienst. Abfragen zu Barcodes oder Bild-Adressen in ``held`` warten am Tor,
    bis der Test ``gate`` öffnet."""

    def __init__(self, clock: FakeClock | None) -> None:
        super().__init__(clock)
        self.held: set[str] = set()
        self.gate = threading.Event()
        self.arrived: list[str] = []  # was am Tor angekommen ist, in dieser Reihenfolge

    async def __call__(self, request: httpx2.Request) -> httpx2.Response:
        path = request.url.path
        key = path.rsplit("/", 1)[-1] if "/api/v3/product/" in path else str(request.url)
        if key in self.held:
            self.arrived.append(key)
            while not self.gate.is_set():
                await asyncio.sleep(0.01)
        return super().__call__(request)


class HeldClock(FakeClock):
    """Wie ``FakeClock``; nur hält jedes Warten des Ablaufs an, bis der Test ``go`` setzt."""

    def __init__(self, server_clock: ServerClock) -> None:
        super().__init__(server_clock)
        self.asleep = threading.Event()
        self.go = threading.Event()

    async def sleep(self, seconds: float) -> None:
        self.asleep.set()
        while not self.go.is_set():
            await asyncio.sleep(0.01)
        await super().sleep(seconds)


@dataclasses.dataclass
class Scanner:
    """Server mit eingeschaltetem Nachschlagen; der Hintergrund-Ablauf läuft wie im Betrieb."""

    settings: Settings
    client: TestClient
    device: Device
    clock: FakeClock
    service: GatedOff

    def get(self, barcode: str, wait: int | None = None, *, headers: dict | None = None):
        params = {} if wait is None else {"wait": wait}
        return self.client.get(
            f"/api/lookup/{barcode}",
            params=params,
            headers=self.device.headers if headers is None else headers,
        )

    def lookup(self, barcode: str, wait: int | None = None) -> dict:
        response = self.get(barcode, wait)
        assert response.status_code == 200, response.text
        assert response.headers["cache-control"] == "no-store"
        return response.json()

    def waiting(self) -> dict[str, int]:
        """Die Wünsche im Ablauf: ``{barcode: wartende_anfragen}``."""
        worker = self.client.app.state.off_worker
        return self.client.portal.call(worker.waiting)

    def row(self, barcode: str) -> dict | None:
        con = db.connect(self.settings.database_path)
        try:
            row = con.execute("SELECT * FROM off_lookups WHERE barcode = ?", (barcode,)).fetchone()
            return None if row is None else dict(row)
        finally:
            con.close()

    def state_of(self, barcode: str) -> str | None:
        row = self.row(barcode)
        return None if row is None else row["state"]


@contextlib.contextmanager
def start(settings: Settings, clock: ServerClock, worker_clock: FakeClock | None = None) -> Iterator[Scanner]:
    enabled = dataclasses.replace(settings, off_enabled=True)
    worker_clock = worker_clock or FakeClock(clock)
    service = GatedOff(worker_clock)
    app = create_app(enabled, off_transport=httpx2.MockTransport(service), off_clock=worker_clock)
    with TestClient(app) as client:
        device = Device(client, "Handy", clock=clock)
        device.sync()
        try:
            yield Scanner(enabled, client, device, worker_clock, service)
        finally:
            service.gate.set()  # nichts bleibt am Tor hängen


@pytest.fixture
def scanner(settings: Settings, clock: ServerClock) -> Iterator[Scanner]:
    with start(settings, clock) as running:
        yield running


# --- Die fünf Zustände -------------------------------------------------------------------


def test_found_with_name_and_image_then_straight_from_the_cache(scanner):
    scanner.service.products[EAN_A] = found(
        product_name_de="Basmati Reis",
        product_name="Basmati rice",
        brands="Kornhaus, Zweitmarke",
        quantity="1 kg ℮",
        image_front_small_url=IMAGE_URL,
    )
    scanner.service.images[IMAGE_URL] = (200, JPEG)

    expected = result(EAN_A, "found", "Basmati Reis", "Kornhaus", "1 kg", JPEG_ID)
    assert scanner.lookup(EAN_A, wait=8) == expected
    assert scanner.service.lookups == [EAN_A]
    assert scanner.client.get(f"/api/images/{JPEG_ID}").content == JPEG
    # Das Ergebnis steht dauerhaft in off_lookups, obwohl es zu dem Barcode kein Produkt gibt.
    row = scanner.row(EAN_A)
    assert (row["state"], row["name"], row["quantity"], row["image_url"]) == (
        "found",
        "Basmati Reis",
        "1 kg",
        IMAGE_URL,
    )

    # Zweiter Aufruf: sofort aus dem Zwischenspeicher. Eine Abfrage hinge jetzt am Tor.
    scanner.service.held.add(EAN_A)
    started = time.monotonic()
    assert scanner.lookup(EAN_A, wait=8) == expected
    assert time.monotonic() - started < 4
    assert len(scanner.service.calls) == 2  # eine Abfrage, ein Bild


def test_not_found_and_from_the_cache(scanner):
    expected = result(EAN_B, "not_found")
    assert scanner.lookup(EAN_B) == expected  # Vorgabe: höchstens 4 Sekunden
    assert scanner.lookup(EAN_B, wait=0) == expected
    assert scanner.service.lookups == [EAN_B]
    assert scanner.state_of(EAN_B) == "not_found"


def test_fetched_at_says_when_open_food_facts_answered(scanner):
    """Seit 0.5.0 nennt die Antwort, wann Open Food Facts das Ergebnis geliefert hat (``off_lookups.fetched_at``),
    auch aus dem Zwischenspeicher. Ein Ergebnis ohne Zeitpunkt (oder mit einem unlesbaren) hat null."""
    scanner.service.products[EAN_A] = found(product_name="Reis")
    first = scanner.lookup(EAN_A, wait=8)
    assert first["fetched_at"] == scanner.row(EAN_A)["fetched_at"]
    assert first["fetched_at"] == timeutil.format_timestamp(scanner.clock.now())
    assert scanner.lookup(EAN_A, wait=0)["fetched_at"] == first["fetched_at"]

    con = db.connect(scanner.settings.database_path)
    try:
        with db.transaction(con):
            con.execute(
                "INSERT INTO off_lookups (barcode, state, attempts, name) VALUES (?, 'found', 1, 'Nudeln')",
                (EAN_B,),
            )
            con.execute(
                "INSERT INTO off_lookups (barcode, state, attempts, fetched_at) VALUES (?, 'not_found', 1, 'gestern')",
                (EAN_C,),
            )
    finally:
        con.close()
    assert scanner.lookup(EAN_B, wait=0) == result(EAN_B, "found", "Nudeln", fetched_at=None)
    assert scanner.lookup(EAN_C, wait=0) == result(EAN_C, "not_found", fetched_at=None)
    assert scanner.service.lookups == [EAN_A]


def test_store_internal_codes_are_skipped(scanner):
    assert scanner.lookup(EAN_STORE, wait=8) == result(EAN_STORE, "skipped")
    assert scanner.service.calls == []
    assert scanner.row(EAN_STORE) is None
    assert scanner.waiting() == {}


def test_switched_off_says_disabled(client, make_device, settings):
    """Die Vorgabe der Tests: STOWLY_OFF_ENABLED=0. Auch ein gespeichertes Ergebnis gilt dann nicht."""
    device = make_device()
    con = db.connect(settings.database_path)
    with db.transaction(con):
        con.execute(
            "INSERT INTO off_lookups (barcode, state, attempts, name) VALUES (?, 'found', 1, 'Reis')",
            (EAN_A,),
        )
    con.close()
    for code in (EAN_A, EAN_B):
        response = client.get(f"/api/lookup/{code}", params={"wait": 8}, headers=device.headers)
        assert response.status_code == 200
        assert response.json() == result(code, "disabled")
    # Ein ladeninterner Code wird nie nachgeschlagen, ob ein- oder ausgeschaltet.
    response = client.get(f"/api/lookup/{EAN_STORE}", headers=device.headers)
    assert response.json() == result(EAN_STORE, "skipped")


def test_wait_0_answers_at_once_and_the_lookup_goes_on(scanner):
    scanner.service.products[EAN_A] = found(product_name="Reis", brands="Kornhaus")
    assert scanner.lookup(EAN_A, wait=0) == result(EAN_A, "pending")
    wait_for(lambda: scanner.state_of(EAN_A) == "found")
    assert scanner.lookup(EAN_A, wait=0) == result(EAN_A, "found", "Reis", "Kornhaus")
    assert scanner.service.lookups == [EAN_A]


def test_too_slow_is_pending_and_the_result_arrives_in_the_cache_later(scanner):
    scanner.service.products[EAN_A] = found(product_name="Reis", image_front_small_url=IMAGE_URL)
    scanner.service.images[IMAGE_URL] = (200, JPEG)
    scanner.service.held.add(EAN_A)

    started = time.monotonic()
    assert scanner.lookup(EAN_A, wait=1) == result(EAN_A, "pending")
    assert 0.9 <= time.monotonic() - started < 4
    # Die Abfrage läuft weiter, der Wunsch bleibt eingereiht.
    wait_for(lambda: scanner.service.arrived == [EAN_A])
    assert scanner.waiting() == {EAN_A: 0}

    scanner.service.gate.set()
    wait_for(lambda: scanner.state_of(EAN_A) == "found")
    assert scanner.lookup(EAN_A, wait=0) == result(EAN_A, "found", "Reis", image_id=JPEG_ID)
    assert scanner.service.lookups == [EAN_A]
    assert scanner.waiting() == {}


def test_the_name_comes_even_if_the_picture_is_slow(scanner):
    """Name und Marke sind da, bevor das Bild geladen ist; ``image_id`` kommt, wenn das Bild da ist."""
    scanner.service.products[EAN_A] = found(product_name="Reis", image_front_small_url=IMAGE_URL)
    scanner.service.images[IMAGE_URL] = (200, JPEG)
    scanner.service.held.add(IMAGE_URL)

    assert scanner.lookup(EAN_A, wait=0) == result(EAN_A, "pending")
    # Open Food Facts hat geantwortet, das Bild hängt am Tor.
    wait_for(lambda: scanner.service.arrived == [IMAGE_URL])
    started = time.monotonic()
    assert scanner.lookup(EAN_A, wait=1) == result(EAN_A, "found", "Reis")
    assert time.monotonic() - started >= 0.9  # bis zum Ende der Wartezeit auf das Bild gewartet
    scanner.service.gate.set()
    wait_for(lambda: scanner.state_of(EAN_A) == "found")
    assert scanner.lookup(EAN_A, wait=0) == result(EAN_A, "found", "Reis", image_id=JPEG_ID)


# --- Warteschlange, Rate, Obergrenze -----------------------------------------------------


def test_concurrent_requests_share_one_query(scanner):
    scanner.service.products[EAN_A] = found(product_name="Reis")
    scanner.service.held.add(EAN_A)
    with concurrent.futures.ThreadPoolExecutor(3) as pool:
        first = pool.submit(scanner.lookup, EAN_A, 8)
        wait_for(lambda: scanner.service.arrived == [EAN_A])
        later = [pool.submit(scanner.lookup, EAN_A, 8) for _ in range(2)]
        wait_for(lambda: scanner.waiting() == {EAN_A: 3})
        scanner.service.gate.set()
        answers = [future.result(timeout=10) for future in (first, *later)]
    assert answers == [result(EAN_A, "found", "Reis")] * 3
    assert scanner.service.lookups == [EAN_A]


def test_a_wish_goes_before_the_products_that_wait(scanner):
    codes = [ean(number) for number in range(3)]
    scanner.service.held.add(codes[0])
    # Drei Platzhalter warten auf den Ablauf; die Abfrage zum ersten hängt am Tor.
    scanner.device.sync([scanner.device.product("", barcodes=[code])[1] for code in codes])
    wait_for(lambda: scanner.service.arrived == [codes[0]])

    assert scanner.lookup(EAN_A, wait=0) == result(EAN_A, "pending")
    scanner.service.gate.set()
    wait_for(lambda: len(scanner.service.lookups) == 4)
    assert scanner.service.lookups == [codes[0], EAN_A, codes[1], codes[2]]


def test_a_wish_takes_the_next_free_slot_of_the_rate(settings, clock):
    """Wartet der Ablauf auf die Rate, bekommt ein Wunsch, der währenddessen kommt, den nächsten Platz."""
    held = HeldClock(clock)
    with start(settings, clock, held) as scanner:
        first = [ean(number) for number in range(10)]
        for code in first:
            assert scanner.lookup(code, wait=0)["state"] == "pending"
        wait_for(lambda: len(scanner.service.lookups) == 10)
        assert not held.asleep.is_set()

        # Ein Platzhalter muss auf die Rate warten ...
        scanner.device.sync([scanner.device.product("", barcodes=[EAN_B])[1]])
        wait_for(held.asleep.is_set)
        # ... und ein Wunsch, der währenddessen kommt, geht vor.
        assert scanner.lookup(EAN_A, wait=0)["state"] == "pending"
        held.go.set()
        wait_for(lambda: len(scanner.service.lookups) == 12)
        assert scanner.service.lookups == [*first, EAN_A, EAN_B]
        times = [at for at, _ in scanner.service.calls]
        assert times[9] == 0 and times[10] >= 60


def test_the_rate_holds_for_wishes_too(scanner):
    codes = [ean(number) for number in range(15)]
    for code in codes:
        assert scanner.lookup(code, wait=0)["state"] == "pending"
    wait_for(lambda: len(scanner.service.lookups) == 15)
    assert scanner.service.lookups == codes  # in der Reihenfolge der Wünsche
    times = [at for at, _ in scanner.service.calls]
    # In jedem Fenster von 60 Sekunden höchstens zehn Abfragen, wie im Hintergrund.
    for index, begin in enumerate(times):
        assert sum(1 for at in times[index:] if at < begin + 60) <= off.LOOKUPS_PER_MINUTE
    assert times[9] == 0 and times[10] >= 60


def test_after_a_failure_the_waiting_times_hold(scanner):
    scanner.service.products[EAN_A] = (429, b"", {"retry-after": "120"})
    scanner.service.products[EAN_B] = found(product_name="Nudeln")

    # Der Fehlversuch beendet das Warten sofort: Vor einer Minute gibt es keinen neuen Versuch.
    started = time.monotonic()
    assert scanner.lookup(EAN_A, wait=8) == result(EAN_A, "pending")
    assert time.monotonic() - started < 4
    row = scanner.row(EAN_A)
    assert (row["state"], row["attempts"]) == ("pending", 1)

    # Die Wartezeit nach dem Fehler gilt auch, wenn jemand wartet: keine zweite Abfrage.
    started = time.monotonic()
    assert scanner.lookup(EAN_A, wait=8) == result(EAN_A, "pending")
    assert time.monotonic() - started < 4
    assert scanner.service.lookups == [EAN_A]

    # Nach dem 429 ruht der ganze Ablauf, auch für Wünsche (Retry-After: 120 Sekunden).
    assert scanner.lookup(EAN_B, wait=8) == result(EAN_B, "found", "Nudeln")
    times = [at for at, _ in scanner.service.calls]
    assert times[1] - times[0] >= 120
    assert scanner.service.lookups == [EAN_A, EAN_B]


def test_wishes_without_a_product_are_limited(scanner):
    limit = off.MAX_WISHES_WITHOUT_PRODUCT
    codes = [ean(number) for number in range(limit + 2)]
    scanner.service.held.update(codes)
    for code in codes[:limit]:
        assert scanner.lookup(code, wait=0)["state"] == "pending"
    wait_for(lambda: scanner.service.arrived == codes[:1])
    assert list(scanner.waiting()) == codes[:limit]

    # Darüber hinaus: pending, ohne einzureihen.
    extra = codes[limit]
    assert scanner.lookup(extra, wait=0) == result(extra, "pending")
    assert extra not in scanner.waiting()

    # Ein Barcode, der einem Produkt gehört, zählt nicht dazu.
    owned = codes[limit + 1]
    scanner.device.sync([scanner.device.product("", barcodes=[owned])[1]])
    assert scanner.lookup(owned, wait=0)["state"] == "pending"
    assert owned in scanner.waiting()

    scanner.service.gate.set()
    wait_for(lambda: len(scanner.service.lookups) == limit + 1)
    assert extra not in scanner.service.lookups
    assert scanner.row(extra) is None
    # Ist wieder Platz, wird auch dieser Barcode nachgeschlagen.
    assert scanner.lookup(extra, wait=8) == result(extra, "not_found")


# --- Zusammenspiel mit Produkten und Abgleich --------------------------------------------


def test_a_product_created_after_the_lookup_gets_the_data_in_the_same_sync(scanner):
    scanner.service.products[EAN_A] = found(
        product_name_de="Basmati Reis", brands="Kornhaus", quantity="1 kg", image_front_small_url=IMAGE_URL
    )
    scanner.service.images[IMAGE_URL] = (200, JPEG)
    scanner.service.products[EAN_B] = found(
        product_name_de="Spaghetti", brands="Nudelwerk", quantity="500 g", image_front_small_url=OTHER_URL
    )
    scanner.service.images[OTHER_URL] = (200, PNG)
    answer_a = scanner.lookup(EAN_A, wait=8)
    answer_b = scanner.lookup(EAN_B, wait=8)
    assert scanner.lookup(EAN_C, wait=8)["state"] == "not_found"
    calls = len(scanner.service.calls)

    device = scanner.device
    # A: Der Anwender hat nichts eingetragen; die App legt einen Platzhalter an.
    plain_id, plain = device.product("", barcodes=[EAN_A])
    # B: Die App schickt Name, Marke und Größe aus der Antwort als Eingabe des Anwenders mit.
    typed_id, typed = device.product(
        answer_b["name"], brand=answer_b["brand"], quantity=answer_b["quantity"], barcodes=[EAN_B]
    )
    unknown_id, unknown = device.product("", barcodes=[EAN_C])
    data = device.sync([plain, typed, unknown])

    # Alles steht schon in der Antwort dieses Abgleichs, ohne den Hintergrund-Ablauf.
    products = {product["id"]: product for product in data["changes"]["products"]}
    fields = ("lookup", "name", "brand", "quantity", "image")
    assert tuple(products[plain_id][field] for field in fields) == (
        "found",
        "Basmati Reis",
        "Kornhaus",
        "1 kg",
        answer_a["image_id"],
    )
    assert tuple(products[typed_id][field] for field in fields) == (
        "found",
        "Spaghetti",
        "Nudelwerk",
        "500 g",
        answer_b["image_id"],
    )
    assert products[unknown_id]["lookup"] == "not_found"
    assert answer_a["image_id"] == JPEG_ID and answer_b["image_id"] is not None
    assert len(scanner.service.calls) == calls

    # Im Protokoll erst das Anlegen, dann die Übernahme; gefüllt wird nur, was leer war.
    log = events_of(scanner.client, device, entity="product", entity_id=plain_id)
    assert [entry["type"] for entry in log] == ["product.created", "product.lookup"]
    assert log[-1]["data"] == {
        "barcode": EAN_A,
        "result": "found",
        "filled": ["name", "brand", "quantity", "image"],
    }
    log = events_of(scanner.client, device, entity="product", entity_id=typed_id)
    assert log[-1]["data"] == {"barcode": EAN_B, "result": "found", "filled": ["image"]}
    log = events_of(scanner.client, device, entity="product", entity_id=unknown_id)
    assert log[-1]["data"] == {"barcode": EAN_C, "result": "not_found", "filled": []}


def test_a_wish_for_a_waiting_product_fills_it(scanner):
    """Gehört der Barcode einem wartenden Produkt, füllt dieselbe Abfrage das Produkt."""
    scanner.service.products[EAN_A] = found(product_name="Reis", image_front_small_url=IMAGE_URL)
    scanner.service.images[IMAGE_URL] = (200, JPEG)
    scanner.service.held.add(EAN_A)
    product_id, create = scanner.device.product("", barcodes=[EAN_A])
    scanner.device.sync([create])
    assert scanner.device.products[product_id]["lookup"] == "pending"
    wait_for(lambda: scanner.service.arrived == [EAN_A])

    with concurrent.futures.ThreadPoolExecutor(1) as pool:
        waiting = pool.submit(scanner.lookup, EAN_A, 8)
        wait_for(lambda: scanner.waiting() == {EAN_A: 1})
        scanner.service.gate.set()
        assert waiting.result(timeout=10) == result(EAN_A, "found", "Reis", image_id=JPEG_ID)
    product = scanner.device.sync()["changes"]["products"][0]
    assert (product["lookup"], product["name"], product["image"]) == ("found", "Reis", JPEG_ID)
    assert scanner.service.lookups == [EAN_A]


def test_results_without_a_product_survive_restarts_and_rest(settings, clock):
    """``reconcile`` beim Start und der Ablauf halten Zeilen ohne Produkt aus und fassen sie nicht an."""
    with start(settings, clock) as scanner:
        service = scanner.service
        service.products[EAN_A] = found(product_name="Reis", image_front_small_url=IMAGE_URL)
        service.images[IMAGE_URL] = (200, JPEG)
        service.products[EAN_C] = [(500, b"kaputt"), found(product_name="Linsen")]
        assert scanner.lookup(EAN_A, wait=8)["state"] == "found"
        assert scanner.lookup(EAN_B, wait=8)["state"] == "not_found"
        assert scanner.lookup(EAN_C, wait=8)["state"] == "pending"  # 500: neuer Versuch in einer Minute
        enabled = scanner.settings

    def rows() -> dict:
        con = db.connect(settings.database_path)
        try:
            return {row["barcode"]: dict(row) for row in con.execute("SELECT * FROM off_lookups")}
        finally:
            con.close()

    before = rows()
    assert {code: row["state"] for code, row in before.items()} == {
        EAN_A: "found",
        EAN_B: "not_found",
        EAN_C: "pending",
    }

    # Neustart, abgeschaltet und wieder eingeschaltet: Die Zeilen bleiben, wie sie sind.
    prepare_database(settings)
    prepare_database(enabled)
    assert rows() == before

    # Ohne Produkt und ohne Wunsch ruht alles, auch wenn der neue Versuch längst fällig ist.
    worker_clock = FakeClock(clock)
    worker_clock.advance(86400)
    worker = off.OffWorker(enabled, transport=httpx2.MockTransport(service), clock=worker_clock)
    calls = len(service.calls)
    assert asyncio.run(worker.drain()) == 0
    assert len(service.calls) == calls and rows() == before

    # Später angelegte Produkte: A und B entscheidet der Abgleich, C wartet auf den Ablauf.
    client = TestClient(create_app(enabled, off_transport=httpx2.MockTransport(service)))
    device = Device(client, "Rechner", clock=clock)
    device.sync()
    created = {code: device.product("", barcodes=[code]) for code in (EAN_A, EAN_B, EAN_C)}
    device.sync([command for _, command in created.values()])
    lookups = {code: device.products[product_id]["lookup"] for code, (product_id, _) in created.items()}
    assert lookups == {EAN_A: "found", EAN_B: "not_found", EAN_C: "pending"}
    assert device.products[created[EAN_A][0]]["image"] == JPEG_ID

    assert asyncio.run(worker.drain()) == 1
    device.sync()
    product = device.products[created[EAN_C][0]]
    assert (product["lookup"], product["name"]) == ("found", "Linsen")


def test_without_the_background_task_only_the_cache_answers(settings, clock):
    """Läuft der Ablauf nicht (etwa beim Herunterfahren), reiht der Endpunkt nichts ein."""
    enabled = dataclasses.replace(settings, off_enabled=True)
    service = FakeOff()
    service.products[EAN_A] = found(product_name="Reis")
    client = TestClient(create_app(enabled, off_transport=httpx2.MockTransport(service)))  # ohne lifespan
    device = Device(client, clock=clock)
    assert client.get(f"/api/lookup/{EAN_A}", headers=device.headers).json() == result(EAN_A, "pending")
    assert service.calls == []

    device.sync([device.product("", barcodes=[EAN_A])[1]])
    worker = off.OffWorker(enabled, transport=httpx2.MockTransport(service))
    assert asyncio.run(worker.drain()) == 1
    response = client.get(f"/api/lookup/{EAN_A}", headers=device.headers)
    assert response.json() == result(EAN_A, "found", "Reis")


# --- Anfragen, die nicht dem Vertrag entsprechen -----------------------------------------


@pytest.mark.parametrize(
    "barcode",
    [
        "12345",
        "4006381333932",  # falsche Prüfziffer
        "036000291452",  # UPC-A: gespeichert wird es mit führender Null
        "40063813339310",
        "400638133393a",
        "４００６３８１３３３９３１",  # vollbreite Ziffern
        "2112345678901",  # ladenintern, aber falsche Prüfziffer
    ],
)
def test_an_invalid_barcode_is_400(scanner, barcode):
    response = scanner.get(barcode, wait=0)
    assert response.status_code == 400
    error = response.json()["error"]
    assert error["code"] == "invalid_request"
    assert [problem["loc"] for problem in error["details"]["errors"]] == [["path", "barcode"]]
    assert scanner.service.calls == []
    assert scanner.waiting() == {}


@pytest.mark.parametrize(
    "query",
    ["wait=-1", "wait=9", "wait=4.5", "wait=abc", "wait=", "wait=%204", "wait=1&wait=2", "wait=%EF%BC%94"],
)
def test_an_invalid_wait_is_400(scanner, query):
    response = scanner.client.get(f"/api/lookup/{EAN_A}?{query}", headers=scanner.device.headers)
    assert response.status_code == 400
    error = response.json()["error"]
    assert error["code"] == "invalid_request"
    assert [problem["loc"] for problem in error["details"]["errors"]] == [["query", "wait"]]
    assert scanner.service.calls == []


def test_the_limits_of_wait_are_fine(scanner):
    assert scanner.lookup(EAN_B, wait=8)["state"] == "not_found"
    assert scanner.lookup(EAN_B, wait=0)["state"] == "not_found"
    response = scanner.client.get(f"/api/lookup/{EAN_B}?wait=08", headers=scanner.device.headers)
    assert response.status_code == 200


def test_without_a_valid_token_401(scanner):
    for headers in ({}, {"Authorization": "Bearer unbekannt"}):
        for barcode in (EAN_A, "123"):  # das Token zuerst, vor jeder anderen Prüfung
            response = scanner.get(barcode, wait=0, headers=headers)
            assert response.status_code == 401
            assert response.json()["error"]["code"] == "unauthorized"
            assert response.headers["www-authenticate"] == "Bearer"
    # Auch ein gesperrtes Token.
    assert scanner.client.post("/api/auth/logout", headers=scanner.device.headers).status_code == 204
    assert scanner.get(EAN_A, wait=0).status_code == 401
    assert scanner.service.calls == []


# --- Herunterfahren ----------------------------------------------------------------------


def test_the_shutdown_of_the_app_answers_a_waiting_request(settings):
    """Fährt die App herunter, bekommt eine wartende Anfrage sofort ``pending``.

    Die Anfrage wartet auf einen Barcode, der noch in der Warteschlange steht; die Abfrage davor
    hängt am Tor. Der Test steuert den ``lifespan`` selbst: Ein TestClient verklemmte sich, wenn
    eine Anfrage länger liefe als er, und so endet auch ein Fehler nach wenigen Sekunden.
    """
    enabled = dataclasses.replace(settings, off_enabled=True)
    service = GatedOff(None)
    service.held.add(EAN_B)
    app = create_app(enabled, off_transport=httpx2.MockTransport(service))

    async def scenario() -> tuple[int, dict, float]:
        transport = httpx2.ASGITransport(app=app)
        async with httpx2.AsyncClient(transport=transport, base_url="http://testserver") as client:
            lifespan = app.router.lifespan_context(app)
            await lifespan.__aenter__()
            try:
                login = await client.post(
                    "/api/auth/login", json={"password": TEST_PASSWORD, "device_name": "Handy"}
                )
                headers = {"Authorization": f"Bearer {login.json()['token']}"}
                first = await client.get(f"/api/lookup/{EAN_B}?wait=0", headers=headers)
                assert first.json()["state"] == "pending"
                request = asyncio.create_task(client.get(f"/api/lookup/{EAN_A}?wait=8", headers=headers))
                worker = app.state.off_worker
                async with asyncio.timeout(10):
                    while worker.waiting() != {EAN_B: 0, EAN_A: 1}:
                        await asyncio.sleep(0.01)
            finally:
                started = time.monotonic()
                await lifespan.__aexit__(None, None, None)
            response = await asyncio.wait_for(request, 4)
            return response.status_code, response.json(), time.monotonic() - started

    try:
        status, answer, elapsed = asyncio.run(scenario())
    finally:
        service.gate.set()
    assert (status, answer) == (200, result(EAN_A, "pending"))
    assert elapsed < 3
    assert service.lookups == []  # die Abfrage am Tor endete mit dem Ablauf


def in_loop_of(worker: off.OffWorker, function):
    """Ruft ``function`` in der Ereignisschleife des Ablaufs auf: Dort leben die Wünsche."""

    async def call():
        return function()

    return asyncio.run_coroutine_threadsafe(call(), worker._loop).result(timeout=5)


def _http(port: int, method: str, path: str, *, token: str | None = None, body: dict | None = None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    try:
        headers = {"Content-Type": "application/json"} if body is not None else {}
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        connection.request(method, path, body=None if body is None else json.dumps(body), headers=headers)
        response = connection.getresponse()
        return response.status, json.loads(response.read() or b"null")
    finally:
        connection.close()


def test_uvicorn_answers_a_waiting_request_before_it_stops(settings):
    """Wie im Betrieb (``python -m stowly``): uvicorn wartet beim Beenden auf laufende Anfragen.
    Die wartende Anfrage bekommt vorher ihre Antwort, statt das Beenden bis zu 8 Sekunden aufzuhalten."""
    enabled = dataclasses.replace(settings, off_enabled=True)
    service = GatedOff(None)
    service.held.update({EAN_A, EAN_B})
    app = create_app(enabled, off_transport=httpx2.MockTransport(service))
    config = uvicorn.Config(
        app, host="127.0.0.1", port=0, log_config=None, log_level="warning", timeout_graceful_shutdown=5
    )
    server = Server(config, app)
    thread = threading.Thread(target=server.run, name="stowly-test-uvicorn")
    thread.start()
    try:
        wait_for(lambda: server.started or not thread.is_alive())
        assert server.started
        port = server.servers[0].sockets[0].getsockname()[1]
        status, login = _http(
            port, "POST", "/api/auth/login", body={"password": TEST_PASSWORD, "device_name": "Handy"}
        )
        assert status == 200
        token = login["token"]
        # Die Abfrage zu B hängt am Tor, A wartet dahinter in der Warteschlange.
        assert _http(port, "GET", f"/api/lookup/{EAN_B}?wait=0", token=token)[1]["state"] == "pending"
        wait_for(lambda: service.arrived == [EAN_B])
        worker = app.state.off_worker
        with concurrent.futures.ThreadPoolExecutor(1) as pool:
            waiting = pool.submit(_http, port, "GET", f"/api/lookup/{EAN_A}?wait=8", token=token)
            wait_for(lambda: in_loop_of(worker, worker.waiting) == {EAN_B: 0, EAN_A: 1})
            started = time.monotonic()
            server.should_exit = True
            status, answer = waiting.result(timeout=10)
            answered = time.monotonic() - started
            thread.join(timeout=10)
            stopped = time.monotonic() - started
    finally:
        server.should_exit = True
        service.gate.set()
        thread.join(timeout=10)
    assert (status, answer) == (200, result(EAN_A, "pending"))
    assert answered < 3 and stopped < 4
    assert not thread.is_alive()
