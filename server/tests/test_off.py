"""Open Food Facts (docs/sync-protokoll.md, Abschnitt 10).

Kein Test ruft den echten Dienst auf: An die Stelle der Verbindung tritt ein
``httpx2.MockTransport``. Die meisten Tests treiben den Hintergrund-Ablauf von Hand
(``drain``) mit einer Uhr, die nicht wirklich wartet; zwei lassen ihn so laufen wie im Betrieb.
"""

import asyncio
import dataclasses
import hashlib
import json
import time
from datetime import timedelta

import httpx2
import pytest
from fastapi.testclient import TestClient
from support import EAN_A, EAN_B, EAN_C, EAN_STORE, Device, ServerClock, events_of

from stowly import __version__, db, off
from stowly.app import create_app, prepare_database
from stowly.config import Settings
from stowly.contract import ids

JPEG = b"\xff\xd8\xff\xe0" + b"stowly-testbild" * 20
PNG = b"\x89PNG\r\n\x1a\n" + b"stowly-testbild" * 20
WEBP = b"RIFF" + (300).to_bytes(4, "little") + b"WEBP" + b"stowly-testbild" * 20
IMAGE_URL = "https://images.openfoodfacts.org/images/products/400/638/133/3931/front_de.3.200.jpg"


class FakeClock(off.Clock):
    """Zeitquelle des Ablaufs, die beim ``sleep`` nur ihre Zeiger vorstellt."""

    def __init__(self, server_clock: ServerClock) -> None:
        self.start = server_clock.now()
        self.elapsed = 0.0
        self.sleeps: list[float] = []

    def now(self):
        return self.start + timedelta(seconds=self.elapsed)

    def monotonic(self) -> float:
        return self.elapsed

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.elapsed += seconds

    def advance(self, seconds: float) -> None:
        self.elapsed += seconds


def found(**product) -> tuple[int, dict]:
    return 200, {"code": "x", "product": product, "result": {"id": "product_found"}, "status": "success"}


NOT_FOUND = (
    404,
    {
        "code": "x",
        "errors": [{"message": {"id": "product_not_found", "name": "Product not found"}}],
        "result": {"id": "product_not_found", "name": "Product not found"},
        "status": "failure",
    },
)


class FakeOff:
    """Der nachgespielte Dienst: Antworten je Barcode und je Bild-Adresse, dazu ein Protokoll der Abrufe."""

    def __init__(self, clock: FakeClock | None = None) -> None:
        self.clock = clock
        self.products: dict[str, object] = {}  # Antworten von world.openfoodfacts.org je Barcode
        self.elsewhere: dict[
            str, dict[str, object]
        ] = {}  # Antworten anderer Rechner: {rechner: {barcode: ...}}
        self.images: dict[str, object] = {}
        self.calls: list[tuple[float, httpx2.Request]] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.calls.append((self.clock.monotonic() if self.clock else time.monotonic(), request))
        if "/api/v3/product/" in request.url.path:
            barcode = request.url.path.rsplit("/", 1)[-1]
            if request.url.host == "world.openfoodfacts.org":
                answer = self.products.get(barcode, NOT_FOUND)
            else:
                answer = self.elsewhere.get(request.url.host, {}).get(barcode, (500, b"unerwarteter Rechner"))
        else:
            answer = self.images.get(str(request.url), (404, b""))
        if isinstance(answer, list):  # eine Folge von Antworten, die letzte bleibt
            answer = answer.pop(0) if len(answer) > 1 else answer[0]
        if isinstance(answer, Exception):
            raise answer
        status, body, *rest = answer
        headers = rest[0] if rest else {}
        if isinstance(body, bytes):
            return httpx2.Response(status, content=body, headers=headers)
        return httpx2.Response(status, json=body, headers=headers)

    @property
    def lookups(self) -> list[str]:
        """Die abgefragten Barcodes in der Reihenfolge der Abrufe."""
        return [r.url.path.rsplit("/", 1)[-1] for _, r in self.calls if "/api/v3/product/" in r.url.path]

    @property
    def image_requests(self) -> list[str]:
        return [str(r.url) for _, r in self.calls if "/api/v3/product/" not in r.url.path]


@dataclasses.dataclass
class Bench:
    """Server mit eingeschaltetem Nachschlagen, dessen Hintergrund-Ablauf der Test selbst treibt."""

    settings: Settings
    client: TestClient
    device: Device
    clock: FakeClock
    service: FakeOff
    worker: off.OffWorker

    def drain(self) -> int:
        return asyncio.run(self.worker.drain())

    def create(self, name: str = "", **payload) -> str:
        product_id, command = self.device.product(name, **payload)
        assert self.device.sync([command])["results"][0]["status"] == "applied"
        return product_id

    def product(self, product_id: str) -> dict:
        self.device.sync()
        return self.device.products[product_id]

    def lookup_row(self, barcode: str) -> dict:
        con = db.connect(self.settings.database_path)
        try:
            return dict(con.execute("SELECT * FROM off_lookups WHERE barcode = ?", (barcode,)).fetchone())
        finally:
            con.close()


@pytest.fixture
def bench(settings: Settings, clock: ServerClock) -> Bench:
    enabled = dataclasses.replace(settings, off_enabled=True)
    fake_clock = FakeClock(clock)
    service = FakeOff(fake_clock)
    # Ohne „with": Der lifespan läuft nicht, also auch kein Hintergrund-Ablauf neben dem Test.
    client = TestClient(create_app(enabled, off_transport=httpx2.MockTransport(service)))
    device = Device(client, "Handy", clock=clock)
    device.sync()
    worker = off.OffWorker(enabled, transport=httpx2.MockTransport(service), clock=fake_clock)
    return Bench(enabled, client, device, fake_clock, service, worker)


# --- Gefunden ----------------------------------------------------------------------------


def test_found_fills_the_placeholder_and_stores_the_image(bench):
    bench.service.products[EAN_A] = found(
        product_name_de="Basmati Reis",
        product_name="Basmati rice",
        brands="Kornhaus, Zweitmarke",
        quantity="1 kg",
        image_front_small_url=IMAGE_URL,
    )
    bench.service.images[IMAGE_URL] = (200, JPEG, {"content-type": "image/jpeg"})
    product_id = bench.create(barcodes=[EAN_A])
    assert bench.device.products[product_id]["lookup"] == "pending"
    cursor = bench.device.cursor

    assert bench.drain() == 1
    data = bench.device.sync()
    # Das Produkt erscheint im nächsten Sync, vollständig.
    assert [p["id"] for p in data["changes"]["products"]] == [product_id]
    assert data["cursor"] > cursor
    product = bench.device.products[product_id]
    image_id = hashlib.sha256(JPEG).hexdigest()[:32] + ".jpg"
    assert (product["lookup"], product["name"], product["brand"], product["quantity"], product["image"]) == (
        "found",
        "Basmati Reis",  # product_name_de vor product_name
        "Kornhaus",  # der erste Eintrag von brands
        "1 kg",
        image_id,
    )

    # Der Abruf, wie ihn der Vertrag nennt.
    _, request = bench.service.calls[0]
    assert str(request.url) == (
        f"https://world.openfoodfacts.org/api/v3/product/{EAN_A}"
        "?product_type=all&lc=de&fields=product_name_de,product_name,brands,quantity,image_front_small_url"
    )
    assert request.method == "GET"
    assert request.headers["user-agent"] == f"Stowly/{__version__}"
    assert bench.service.image_requests == [IMAGE_URL]

    # Das Bild liegt in der Datenbank und ist ohne Anmeldung abrufbar.
    image = bench.client.get(f"/api/images/{image_id}")
    assert image.status_code == 200
    assert image.content == JPEG
    assert image.headers["content-type"] == "image/jpeg"

    # Das Ergebnis steht dauerhaft in off_lookups, getrennt von products.
    row = bench.lookup_row(EAN_A)
    assert (row["state"], row["name"], row["brand"], row["quantity"], row["image_url"]) == (
        "found",
        "Basmati Reis",
        "Kornhaus",
        "1 kg",
        IMAGE_URL,
    )
    assert row["next_attempt_at"] is None and row["fetched_at"] is not None
    assert json.loads(row["raw"])["product_name"] == "Basmati rice"

    log = events_of(bench.client, bench.device, entity="product", entity_id=product_id)
    assert [(e["type"], e["device_id"], e["command_id"], e["data"]) for e in log][1:] == [
        (
            "product.lookup",
            None,
            None,
            {"barcode": EAN_A, "result": "found", "filled": ["name", "brand", "quantity", "image"]},
        )
    ]
    # Nie wieder: Ein weiterer Durchlauf fragt nichts mehr ab.
    assert bench.drain() == 0
    assert len(bench.service.calls) == 2


def test_only_empty_fields_are_filled_and_the_users_name_stays(bench):
    bench.service.products[EAN_A] = found(product_name_de="Reis von OFF", brands="OFF-Marke", quantity="1 kg")
    product_id = bench.create("Mein Reis", barcodes=[EAN_A])
    assert bench.device.products[product_id]["lookup"] == "pending"
    bench.drain()

    product = bench.product(product_id)
    assert (product["lookup"], product["name"], product["brand"], product["quantity"]) == (
        "found",
        "Mein Reis",
        "OFF-Marke",
        "1 kg",
    )
    log = events_of(bench.client, bench.device, entity="product", entity_id=product_id)
    assert log[-1]["data"] == {"barcode": EAN_A, "result": "found", "filled": ["brand", "quantity"]}


def test_any_user_input_wins_before_and_after_the_lookup(bench, clock):
    """Die Uhren der Felder bleiben unberührt: Auch eine ältere Eingabe, die später eintrifft, gilt."""
    bench.service.products[EAN_A] = found(product_name_de="Reis von OFF", brands="OFF-Marke")
    product_id = bench.create(barcodes=[EAN_A])
    clock.advance(3600)
    bench.clock.advance(3600)
    bench.drain()
    assert bench.product(product_id)["name"] == "Reis von OFF"

    # Vor einer halben Stunde offline eingetippt, also vor dem Nachschlagen; trifft jetzt ein.
    rename = bench.device.cmd(
        "product.update", age=1800, product_id=product_id, changes={"name": "Mein Reis"}
    )
    bench.device.sync([rename])
    assert bench.device.products[product_id]["name"] == "Mein Reis"
    assert bench.device.products[product_id]["brand"] == "OFF-Marke"


def test_the_plain_product_name_is_the_fallback(bench):
    bench.service.products[EAN_A] = found(
        product_name_de="", product_name="  Basmati \n rice ", brands=["Kornhaus", "x"]
    )
    bench.service.products[EAN_B] = found(
        quantity="x" * 100, product_name="n" * 200, brands="b" * 100 + ", zweite"
    )
    first, second = bench.create(barcodes=[EAN_A]), bench.create(barcodes=[EAN_B])
    bench.drain()
    assert bench.product(first)["name"] == "Basmati rice"  # Leerraum zusammengefasst
    assert bench.device.products[first]["brand"] == "Kornhaus"
    # Fremde Texte werden auf die Feldlängen des Vertrags gekürzt.
    product = bench.device.products[second]
    assert (len(product["name"]), len(product["brand"]), len(product["quantity"])) == (120, 80, 40)


def test_found_without_any_data_is_still_found(bench):
    bench.service.products[EAN_A] = found()
    product_id = bench.create(barcodes=[EAN_A])
    bench.drain()
    product = bench.product(product_id)
    assert (product["lookup"], product["name"], product["image"]) == ("found", "", None)
    log = events_of(bench.client, bench.device, entity="product", entity_id=product_id)
    assert log[-1]["data"] == {"barcode": EAN_A, "result": "found", "filled": []}


def test_the_contact_appears_in_the_user_agent_only_if_configured(bench):
    assert off.user_agent(None) == f"Stowly/{__version__}"
    assert off.user_agent("betreiber@example.org") == f"Stowly/{__version__} (betreiber@example.org)"

    with_contact = dataclasses.replace(bench.settings, off_contact="betreiber@example.org")
    worker = off.OffWorker(with_contact, transport=httpx2.MockTransport(bench.service), clock=bench.clock)
    bench.create(barcodes=[EAN_A])
    asyncio.run(worker.drain())
    assert bench.service.calls[0][1].headers["user-agent"] == f"Stowly/{__version__} (betreiber@example.org)"


# --- Nicht gefunden, Fehler, Wiederholungen ----------------------------------------------


def test_not_found_is_final(bench):
    product_id = bench.create(barcodes=[EAN_A])  # der Dienst kennt den Barcode nicht
    assert bench.drain() == 1
    product = bench.product(product_id)
    assert (product["lookup"], product["name"]) == ("not_found", "")
    row = bench.lookup_row(EAN_A)
    assert (row["state"], row["next_attempt_at"], row["attempts"]) == ("not_found", None, 1)

    log = events_of(bench.client, bench.device, entity="product", entity_id=product_id)
    assert log[-1]["data"] == {"barcode": EAN_A, "result": "not_found", "filled": []}

    bench.clock.advance(30 * 86400)
    assert bench.drain() == 0
    assert bench.service.lookups == [EAN_A]


def test_a_404_without_product_not_found_is_not_final(bench):
    bench.service.products[EAN_A] = (404, b"<html>Not Found</html>")
    product_id = bench.create(barcodes=[EAN_A])
    bench.drain()
    assert bench.product(product_id)["lookup"] == "pending"


@pytest.mark.parametrize(
    "failure",
    [
        httpx2.ConnectError("keine Verbindung"),
        httpx2.ReadTimeout("zu langsam"),
        (500, b"kaputt"),
        (503, {"status": "maintenance"}),
        (429, b"langsam"),
        (200, b"kein json"),
        (200, {"status": "success"}),
    ],
)
def test_transient_failures_keep_the_product_pending(bench, failure):
    bench.service.products[EAN_A] = failure
    product_id = bench.create(barcodes=[EAN_A])
    assert bench.drain() == 1
    assert bench.product(product_id)["lookup"] == "pending"
    row = bench.lookup_row(EAN_A)
    assert (row["state"], row["attempts"]) == ("pending", 1)
    # Neuer Versuch nach einer Minute geplant.
    assert row["next_attempt_at"] == off.format_timestamp(bench.clock.now() + timedelta(seconds=60))
    assert bench.drain() == 0


def test_retries_follow_the_schedule_until_it_works(bench):
    bench.service.products[EAN_A] = [httpx2.ConnectError("offline")] * 6 + [found(product_name="Reis")]
    product_id = bench.create(barcodes=[EAN_A])
    waits = []
    for _ in range(6):
        assert bench.drain() == 1
        row = bench.lookup_row(EAN_A)
        wait = (off.parse_timestamp(row["next_attempt_at"]) - bench.clock.now()).total_seconds()
        waits.append(wait)
        # Kurz vor dem Termin passiert nichts.
        bench.clock.advance(wait - 1)
        assert bench.drain() == 0
        bench.clock.advance(1)
    # 1 Minute, 5 Minuten, 30 Minuten, 3 Stunden, danach täglich.
    assert waits == [60, 300, 1800, 10800, 86400, 86400]

    assert bench.drain() == 1
    assert bench.product(product_id)["lookup"] == "found"
    assert bench.device.products[product_id]["name"] == "Reis"
    assert len(bench.service.lookups) == 7


def test_a_429_pauses_all_lookups(bench):
    bench.service.products[EAN_A] = (429, b"", {"retry-after": "120"})
    bench.service.products[EAN_B] = found(product_name="Nudeln")
    bench.create(barcodes=[EAN_A])
    second = bench.create(barcodes=[EAN_B])
    bench.drain()
    # Der zweite Abruf wartete das Retry-After ab, statt sofort nachzusetzen.
    times = [at for at, _ in bench.service.calls]
    assert times[1] - times[0] >= 120
    assert bench.product(second)["lookup"] == "found"


# --- Was nie abgefragt wird --------------------------------------------------------------


def test_store_internal_codes_are_never_looked_up(bench):
    internal = bench.create("Hackfleisch", barcodes=[EAN_STORE])
    assert bench.device.products[internal]["lookup"] == "none"
    assert bench.drain() == 0
    assert bench.service.calls == []
    assert bench.product(internal)["lookup"] == "none"
    # Der Code steht nicht einmal in der Warteschlange.
    con = db.connect(bench.settings.database_path)
    assert con.execute("SELECT COUNT(*) FROM off_lookups").fetchone()[0] == 0
    con.close()


def test_a_store_internal_code_in_the_queue_is_dropped_not_fetched(bench):
    """Sicherheitsnetz: Selbst wenn ein solcher Code in die Warteschlange geriete, ginge er nie hinaus."""
    product_id = bench.create("Hackfleisch", barcodes=[EAN_STORE])
    con = db.connect(bench.settings.database_path)
    with db.transaction(con):
        off.ensure_queued(con, EAN_STORE, off.format_timestamp(bench.clock.now()))
        con.execute("UPDATE products SET lookup = 'pending' WHERE id = ?", (product_id,))
    bench.drain()
    bench.clock.advance(86400)
    bench.drain()
    assert bench.service.calls == []
    assert con.execute("SELECT lookup FROM products WHERE id = ?", (product_id,)).fetchone()[0] == "none"

    # Und käme der Ablauf doch bis zum Abruf, fliegt der Eintrag hinaus, statt abgefragt zu werden.
    asyncio.run(bench.worker._lookup(EAN_STORE))
    assert bench.service.calls == []
    assert con.execute("SELECT COUNT(*) FROM off_lookups").fetchone()[0] == 0
    con.close()


def test_only_the_public_barcode_of_a_product_is_looked_up(bench):
    bench.service.products[EAN_A] = found(product_name="Reis")
    product_id = bench.create(barcodes=[EAN_STORE, EAN_A])
    bench.drain()
    assert bench.service.lookups == [EAN_A]
    assert bench.product(product_id)["lookup"] == "found"


def test_a_product_without_barcode_is_none(bench):
    product_id = bench.create("Selbstgemachte Marmelade")
    assert bench.device.products[product_id]["lookup"] == "none"
    assert bench.drain() == 0
    assert bench.service.calls == []


def test_switched_off_means_none_and_no_requests(settings, clock):
    """Die Vorgabe der Tests: STOWLY_OFF_ENABLED=0."""
    service = FakeOff()
    with TestClient(create_app(settings, off_transport=httpx2.MockTransport(service))) as client:
        assert client.app.state.off_worker is None  # der Ablauf startet gar nicht erst
        device = Device(client, clock=clock)
        device.sync()
        product_id, create = device.product("", barcodes=[EAN_A])
        device.sync([create])
        assert device.products[product_id]["lookup"] == "none"
    assert service.calls == []
    con = db.connect(settings.database_path)
    assert con.execute("SELECT COUNT(*) FROM off_lookups").fetchone()[0] == 0
    con.close()


# --- Drosselung --------------------------------------------------------------------------


def test_at_most_ten_lookups_per_minute(bench):
    barcodes = []
    for number in range(25):
        body = f"40063813{number:04d}"
        barcodes.append(body + str(ids.gtin_check_digit(body)))
    commands = [bench.device.product("", barcodes=[barcode])[1] for barcode in barcodes]
    bench.device.sync(commands)

    assert bench.drain() == 25
    times = [at for at, _ in bench.service.calls]
    assert len(times) == 25 and sorted(bench.service.lookups) == sorted(barcodes)
    # In jedem Fenster von 60 Sekunden höchstens zehn Abfragen.
    for index, start in enumerate(times):
        assert sum(1 for at in times[index:] if at < start + 60) <= 10
    # Die ersten zehn sofort, dann erst wieder nach einer Minute.
    assert times[9] == 0 and times[10] >= 60 and times[20] >= 120
    assert off.LOOKUPS_PER_MINUTE == 10


def test_image_downloads_do_not_eat_the_lookup_budget(bench):
    """Bilder kommen von einem anderen Rechner; gedrosselt werden die Abfragen der Schnittstelle."""
    for number in range(10):
        body = f"40063813{number:04d}"
        barcode = body + str(ids.gtin_check_digit(body))
        url = f"https://images.openfoodfacts.org/{barcode}.jpg"
        bench.service.products[barcode] = found(product_name=f"Produkt {number}", image_front_small_url=url)
        bench.service.images[url] = (200, JPEG + bytes([number]))
        bench.create(barcodes=[barcode])
    bench.drain()
    assert len(bench.service.lookups) == 10 and len(bench.service.image_requests) == 10
    assert bench.clock.sleeps == []


# --- Bilder ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "data, content_type, extension",
    [(JPEG, "image/jpeg", ".jpg"), (PNG, "image/png", ".png"), (WEBP, "image/webp", ".webp")],
)
def test_jpeg_png_and_webp_are_accepted_by_content(bench, data, content_type, extension):
    bench.service.products[EAN_A] = found(image_front_small_url=IMAGE_URL)
    # Der Typ wird am Inhalt bestimmt, nicht an dem, was der fremde Rechner behauptet.
    bench.service.images[IMAGE_URL] = (200, data, {"content-type": "application/octet-stream"})
    product_id = bench.create(barcodes=[EAN_A])
    bench.drain()
    image_id = bench.product(product_id)["image"]
    assert image_id == hashlib.sha256(data).hexdigest()[:32] + extension
    assert bench.client.get(f"/api/images/{image_id}").headers["content-type"] == content_type


@pytest.mark.parametrize(
    "url",
    [
        "http://images.openfoodfacts.org/bild.jpg",  # nicht https
        "https://images.example.org/bild.jpg",  # fremder Rechner
        "https://openfoodfacts.org.example.org/bild.jpg",
        "https://nichtopenfoodfacts.org/bild.jpg",
        "https://user:pw@images.openfoodfacts.org/bild.jpg",
        "https://images.openfoodfacts.org:8443/bild.jpg",
        "ftp://images.openfoodfacts.org/bild.jpg",
        "//images.openfoodfacts.org/bild.jpg",
        "",
        None,
        17,
    ],
)
def test_images_are_only_fetched_via_https_from_open_food_facts(bench, url):
    assert off.is_allowed_image_url(url) is False
    bench.service.products[EAN_A] = found(product_name="Reis", image_front_small_url=url)
    product_id = bench.create(barcodes=[EAN_A])
    bench.drain()
    product = bench.product(product_id)
    assert (product["lookup"], product["name"], product["image"]) == ("found", "Reis", None)
    assert bench.service.image_requests == []  # die Adresse wurde gar nicht erst aufgerufen
    assert bench.lookup_row(EAN_A)["image_url"] is None


def test_allowed_image_hosts():
    assert off.is_allowed_image_url("https://images.openfoodfacts.org/a.jpg")
    assert off.is_allowed_image_url("https://static.openfoodfacts.org/a.jpg")
    assert off.is_allowed_image_url("https://openfoodfacts.org/a.jpg")
    assert off.is_allowed_image_url("https://IMAGES.OpenFoodFacts.org:443/a.jpg")


@pytest.mark.parametrize(
    "answer",
    [
        (200, JPEG + b"x" * off.MAX_IMAGE_BYTES),  # zu groß
        (200, b"x", {"content-length": str(off.MAX_IMAGE_BYTES + 1)}),  # schon laut Ankündigung zu groß
        (200, b"GIF89a" + b"x" * 50, {"content-type": "image/gif"}),  # falscher Typ
        (200, b"<html>kein Bild</html>", {"content-type": "image/jpeg"}),
        (404, b""),
        (302, b"", {"location": "https://images.example.org/bild.jpg"}),  # Weiterleitung zu Fremden
    ],
)
def test_unusable_images_are_skipped_for_good(bench, answer):
    bench.service.products[EAN_A] = found(product_name="Reis", image_front_small_url=IMAGE_URL)
    bench.service.images[IMAGE_URL] = answer
    product_id = bench.create(barcodes=[EAN_A])
    bench.drain()
    product = bench.product(product_id)
    assert (product["lookup"], product["name"], product["image"]) == ("found", "Reis", None)
    assert bench.lookup_row(EAN_A)["next_attempt_at"] is None
    bench.clock.advance(7 * 86400)
    assert bench.drain() == 0
    assert bench.service.image_requests == [IMAGE_URL]
    con = db.connect(bench.settings.database_path)
    assert con.execute("SELECT COUNT(*) FROM images").fetchone()[0] == 0
    con.close()


def test_an_image_of_exactly_300_kb_is_fine(bench):
    data = JPEG + b"x" * (off.MAX_IMAGE_BYTES - len(JPEG))
    assert len(data) == 300 * 1024
    bench.service.products[EAN_A] = found(image_front_small_url=IMAGE_URL)
    bench.service.images[IMAGE_URL] = (200, data)
    product_id = bench.create(barcodes=[EAN_A])
    bench.drain()
    assert bench.product(product_id)["image"] is not None


def test_an_image_that_fails_for_now_is_fetched_later(bench):
    bench.service.products[EAN_A] = found(product_name="Reis", image_front_small_url=IMAGE_URL)
    bench.service.images[IMAGE_URL] = [httpx2.ConnectError("offline"), (503, b""), (200, JPEG)]
    product_id = bench.create(barcodes=[EAN_A])
    bench.drain()
    # Name und Marke sind schon da; nur das Bild fehlt noch.
    product = bench.product(product_id)
    assert (product["lookup"], product["name"], product["image"]) == ("found", "Reis", None)
    cursor = bench.device.cursor

    bench.clock.advance(60)
    assert bench.drain() == 1
    assert bench.product(product_id)["image"] is None
    bench.clock.advance(300)
    assert bench.drain() == 1

    product = bench.product(product_id)
    assert product["image"] == hashlib.sha256(JPEG).hexdigest()[:32] + ".jpg"
    assert bench.device.cursor > cursor  # das Produkt kam erneut über den Sync
    assert bench.service.lookups == [EAN_A]  # die Abfrage selbst lief nur einmal
    assert len(bench.service.image_requests) == 3
    log = events_of(bench.client, bench.device, entity="product", entity_id=product_id)
    assert log[-1]["data"] == {"barcode": EAN_A, "result": "found", "filled": ["image"]}
    assert bench.drain() == 0


def test_image_retries_give_up_eventually(bench):
    bench.service.products[EAN_A] = found(product_name="Reis", image_front_small_url=IMAGE_URL)
    bench.service.images[IMAGE_URL] = (500, b"")
    product_id = bench.create(barcodes=[EAN_A])
    for _ in range(20):
        bench.drain()
        bench.clock.advance(86400)
    assert len(bench.service.image_requests) == off.IMAGE_ATTEMPTS
    assert bench.lookup_row(EAN_A)["next_attempt_at"] is None
    assert bench.product(product_id)["image"] is None


def test_the_same_picture_behind_two_addresses(bench):
    other_url = IMAGE_URL.replace("front_de", "front_en")
    bench.service.products[EAN_A] = found(product_name="Reis", image_front_small_url=IMAGE_URL)
    bench.service.products[EAN_B] = found(product_name="Reis XL", image_front_small_url=other_url)
    bench.service.images[IMAGE_URL] = (200, JPEG)
    bench.service.images[other_url] = (200, JPEG)
    first, second = bench.create(barcodes=[EAN_A]), bench.create(barcodes=[EAN_B])
    bench.drain()
    assert bench.product(first)["image"] == bench.device.products[second]["image"] is not None


# --- Dauerhaft, Zusammenführen, Weiterleitungen ------------------------------------------


def test_a_stored_result_is_reused_without_asking_again(bench):
    bench.service.products[EAN_A] = found(product_name="Reis", image_front_small_url=IMAGE_URL)
    bench.service.images[IMAGE_URL] = (200, JPEG)
    first = bench.create(barcodes=[EAN_A])
    bench.drain()
    assert len(bench.service.calls) == 2

    # Der Barcode wandert zu einem neuen Produkt: Das Ergebnis kommt aus off_lookups.
    second = bench.create()
    bench.device.sync(
        [
            bench.device.cmd("product.remove_barcode", product_id=first, barcode=EAN_A),
            bench.device.cmd("product.add_barcode", product_id=second, barcode=EAN_A),
        ]
    )
    assert bench.device.products[second]["lookup"] == "pending"
    bench.drain()
    product = bench.product(second)
    assert (product["lookup"], product["name"]) == ("found", "Reis")
    assert product["image"] == bench.device.products[first]["image"] is not None
    assert len(bench.service.calls) == 2  # kein weiterer Abruf


def test_a_known_not_found_is_reused_too(bench):
    first = bench.create(barcodes=[EAN_A])
    bench.drain()
    second = bench.create()
    bench.device.sync(
        [
            bench.device.cmd("product.remove_barcode", product_id=first, barcode=EAN_A),
            bench.device.cmd("product.add_barcode", product_id=second, barcode=EAN_A),
        ]
    )
    # Wie jedes Ergebnis führt auch dieses über pending; der Ablauf übernimmt es ohne Abruf.
    assert bench.device.products[second]["lookup"] == "pending"
    assert bench.drain() == 1
    assert bench.product(second)["lookup"] == "not_found"
    assert bench.service.lookups == [EAN_A]
    log = events_of(bench.client, bench.device, entity="product", entity_id=second)
    assert log[-1]["data"] == {"barcode": EAN_A, "result": "not_found", "filled": []}

    # Danach bleibt es dabei: Ein weiterer Befehl am Produkt stößt nichts neu an.
    cursor = bench.device.cursor
    bench.device.sync([bench.device.cmd("product.add_barcode", product_id=second, barcode=EAN_STORE)])
    assert bench.device.products[second]["lookup"] == "not_found"
    assert bench.drain() == 0
    assert bench.device.cursor > cursor


def test_a_second_barcode_gets_its_own_chance(bench):
    bench.service.products[EAN_B] = found(product_name="Nudeln")
    product_id = bench.create(barcodes=[EAN_A])
    bench.drain()
    assert bench.product(product_id)["lookup"] == "not_found"

    bench.device.sync([bench.device.cmd("product.add_barcode", product_id=product_id, barcode=EAN_B)])
    assert bench.device.products[product_id]["lookup"] == "pending"
    bench.drain()
    product = bench.product(product_id)
    assert (product["lookup"], product["name"]) == ("found", "Nudeln")
    assert bench.service.lookups == [EAN_A, EAN_B]


def test_the_result_lands_at_the_product_that_owns_the_barcode_now(bench):
    bench.service.products[EAN_A] = found(product_name="Reis", brands="Kornhaus")
    source = bench.create(barcodes=[EAN_A])
    target = bench.create("Mein Reis")
    # Zusammengeführt, bevor Open Food Facts geantwortet hat.
    bench.device.sync([bench.device.cmd("product.merge", source_id=source, target_id=target)])
    assert bench.device.products[target]["lookup"] == "pending"
    assert bench.device.products[source]["lookup"] == "none"
    bench.drain()
    product = bench.product(target)
    assert (product["lookup"], product["name"], product["brand"]) == ("found", "Mein Reis", "Kornhaus")
    assert bench.device.products[source]["brand"] == ""


def test_losing_the_last_public_barcode_ends_the_waiting(bench):
    bench.service.products[EAN_A] = httpx2.ConnectError("offline")
    product_id = bench.create(barcodes=[EAN_A])
    bench.drain()
    bench.device.sync([bench.device.cmd("product.remove_barcode", product_id=product_id, barcode=EAN_A)])
    assert bench.device.products[product_id]["lookup"] == "none"
    bench.clock.advance(86400)
    assert bench.drain() == 0
    assert bench.service.lookups == [EAN_A]


def test_redirects_are_followed_only_within_the_open_food_facts_family(bench):
    beauty = f"https://world.openbeautyfacts.org/api/v3/product/{EAN_A}?product_type=all"
    bench.service.products[EAN_A] = (302, b"", {"location": beauty})
    bench.service.products[EAN_B] = (302, b"", {"location": "https://example.org/api/v3/product/1"})
    bench.service.products[EAN_C] = (301, b"", {"location": f"/api/v3/product/{EAN_C}"})  # Schleife
    # Das Schwesterprojekt kennt den ersten Barcode.
    bench.service.elsewhere["world.openbeautyfacts.org"] = {EAN_A: found(product_name="Zahnpasta")}
    first, second, third = (bench.create(barcodes=[code]) for code in (EAN_A, EAN_B, EAN_C))
    bench.drain()

    assert bench.product(first)["name"] == "Zahnpasta"
    assert bench.device.products[first]["lookup"] == "found"
    assert bench.device.products[second]["lookup"] == "pending"  # fremder Rechner: nicht gefolgt
    assert bench.device.products[third]["lookup"] == "pending"  # zu viele Weiterleitungen
    hosts = [request.url.host for _, request in bench.service.calls]
    assert "example.org" not in hosts
    assert hosts.count("world.openbeautyfacts.org") == 1
    assert hosts.count("world.openfoodfacts.org") == 2 + (off.MAX_REDIRECTS + 1)


# --- Start und Betrieb -------------------------------------------------------------------


def test_startup_brings_lookup_in_line_with_the_setting(settings, clock):
    enabled = dataclasses.replace(settings, off_enabled=True)

    # Angelegt, während das Nachschlagen abgeschaltet war: none.
    client = TestClient(create_app(settings))
    device = Device(client, clock=clock)
    device.sync()
    with_code, create_code = device.product("", barcodes=[EAN_A])
    internal, create_internal = device.product("Hackfleisch", barcodes=[EAN_STORE])
    plain, create_plain = device.product("Marmelade")
    device.sync([create_code, create_internal, create_plain])
    assert {device.products[p]["lookup"] for p in (with_code, internal, plain)} == {"none"}

    # Eingeschaltet und neu gestartet: Was sich nachschlagen lässt, wartet jetzt.
    prepare_database(enabled)
    device.sync()
    assert device.products[with_code]["lookup"] == "pending"
    assert device.products[internal]["lookup"] == "none"
    assert device.products[plain]["lookup"] == "none"

    # Wieder abgeschaltet: Niemand schlägt mehr nach, also wartet auch nichts mehr.
    prepare_database(settings)
    assert device.sync()["changes"]["products"][0]["lookup"] == "none"
    assert device.products[with_code]["lookup"] == "none"


def wait_for(condition, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while not condition():
        assert time.monotonic() < deadline, "Der Hintergrund-Ablauf hat nicht rechtzeitig gearbeitet."
        time.sleep(0.02)


def test_the_background_task_runs_with_the_app(settings):
    """Wie im Betrieb: Der Ablauf läuft im lifespan, ein Sync weckt ihn."""
    enabled = dataclasses.replace(settings, off_enabled=True)
    service = FakeOff()
    service.products[EAN_A] = found(product_name_de="Basmati Reis", image_front_small_url=IMAGE_URL)
    service.images[IMAGE_URL] = (200, JPEG)

    with TestClient(create_app(enabled, off_transport=httpx2.MockTransport(service))) as client:
        assert client.app.state.off_worker is not None
        device = Device(client)
        device.sync()
        product_id, create = device.product("", barcodes=[EAN_A])
        missing_id, create_missing = device.product("", barcodes=[EAN_B])
        device.sync([create, create_missing])
        assert device.products[product_id]["lookup"] == "pending"

        def settled() -> bool:
            device.sync()
            return {device.products[p]["lookup"] for p in (product_id, missing_id)} == {"found", "not_found"}

        wait_for(settled)
        assert device.products[product_id]["name"] == "Basmati Reis"
        assert device.products[missing_id]["lookup"] == "not_found"
        assert client.get(f"/api/images/{device.products[product_id]['image']}").content == JPEG
    # Mit dem Ende der App endet auch der Ablauf.
    assert client.app.state.off_worker is None
    assert sorted(service.lookups) == sorted([EAN_A, EAN_B])


def test_pending_products_are_picked_up_after_a_restart(settings):
    enabled = dataclasses.replace(settings, off_enabled=True)
    service = FakeOff()
    service.products[EAN_A] = found(product_name="Reis")

    # Erster Lauf ohne lifespan: Das Produkt bleibt wartend zurück, wie nach einem Absturz.
    client = TestClient(create_app(enabled, off_transport=httpx2.MockTransport(service)))
    device = Device(client)
    device.sync()
    product_id, create = device.product("", barcodes=[EAN_A])
    device.sync([create])
    assert service.calls == []

    with TestClient(create_app(enabled, off_transport=httpx2.MockTransport(service))) as restarted:
        device.client = restarted

        def found_it() -> bool:
            device.sync()
            return device.products[product_id]["lookup"] == "found"

        wait_for(found_it)


def test_an_error_in_the_worker_does_not_stop_it(settings, monkeypatch, caplog):
    enabled = dataclasses.replace(settings, off_enabled=True)
    prepare_database(enabled)
    worker = off.OffWorker(enabled, transport=httpx2.MockTransport(FakeOff()))
    calls = []

    async def run_once() -> bool:
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("absichtlich")
        raise asyncio.CancelledError

    async def no_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr(worker, "run_once", run_once)
    monkeypatch.setattr(asyncio, "sleep", no_sleep)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(worker.run())
    assert len(calls) == 2  # nach dem Fehler lief der Ablauf weiter
    assert "absichtlich" in caplog.text


def test_parse_lookup_understands_the_documented_answers():
    assert isinstance(off.parse_lookup(*_text(NOT_FOUND)), off.NotFound)
    assert isinstance(off.parse_lookup(200, json.dumps(NOT_FOUND[1])), off.NotFound)
    assert isinstance(off.parse_lookup(404, "product_not_found"), off.NotFound)
    assert isinstance(off.parse_lookup(404, "<html>"), off.Failed)
    assert isinstance(off.parse_lookup(500, "{}"), off.Failed)
    assert isinstance(off.parse_lookup(200, "[]"), off.Failed)
    result = off.parse_lookup(*_text(found(product_name=7, brands=None, quantity=["x"])))
    assert result == off.Found(name="", brand="", quantity="", image_url=None, raw=result.raw)
    assert off.retry_delay_s(1) == 60 and off.retry_delay_s(4) == 10800 and off.retry_delay_s(99) == 86400


def _text(answer: tuple[int, dict]) -> tuple[int, str]:
    return answer[0], json.dumps(answer[1])


def test_half_characters_from_open_food_facts_do_no_harm(bench):
    """Auch die fremde Quelle kann halbe Zeichen liefern; das Ergebnis muss sich trotzdem speichern lassen."""
    half = "\ud83d"
    answer = found(
        product_name="Reis " + half,
        brands="Korn" + half + "haus",
        quantity=half,
        image_front_small_url=IMAGE_URL + half,
    )
    bench.service.products[EAN_A] = (200, json.dumps(answer[1]).encode("ascii"))
    product_id = bench.create(barcodes=[EAN_A])
    assert bench.drain() == 1
    product = bench.product(product_id)
    assert (product["lookup"], product["name"], product["brand"], product["quantity"], product["image"]) == (
        "found",
        "Reis",
        "Korn haus",
        "",
        None,
    )
    assert bench.lookup_row(EAN_A)["state"] == "found"
    assert bench.service.image_requests == []
    assert bench.drain() == 0


def test_the_contact_is_made_safe_for_a_header():
    assert off.user_agent("  ") == f"Stowly/{__version__}"
    assert (
        off.user_agent("büro@example.org\r\nX-Fremd: 1")
        == f"Stowly/{__version__} (b ro@example.org X-Fremd: 1)"
    )
    assert len(off.user_agent("x" * 1000)) < 230
