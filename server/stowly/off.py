"""Open Food Facts: Name, Marke, Packungsgröße und Vorschaubild zu einem Barcode.

Alle Abfragen macht ein einziger Hintergrund-Ablauf (docs/sync-protokoll.md, Abschnitt 10).
Er hat zwei Quellen:

* **Produkte, die warten.** Ein Produkt mit unbekanntem Barcode entsteht sofort als
  Platzhalter mit ``lookup = pending``; der Ablauf fragt nach und füllt es.
* **Wünsche aus dem Vordergrund.** Scannt jemand einen unbekannten Barcode, fragt die App
  ``GET /api/lookup/{barcode}?wait=…``. Der Barcode kommt vorn in die Warteschlange, und die
  Anfrage wartet höchstens ``wait`` Sekunden auf das Ergebnis. Mehrere Anfragen zum selben
  Barcode teilen sich eine Abfrage. Wünsche zu Barcodes ohne Produkt sind begrenzt
  (``MAX_WISHES_WITHOUT_PRODUCT``); darüber wird nichts eingereiht.

Für beide gilt dasselbe:

* höchstens ``LOOKUPS_PER_MINUTE`` Abfragen je Minute (Open Food Facts erlaubt 15),
* Netzfehler, 429 und 5xx: neuer Versuch nach 1 Minute, 5 Minuten, 30 Minuten,
  3 Stunden, danach täglich; nach 429 ruht der ganze Ablauf,
* jedes Ergebnis steht dauerhaft in ``off_lookups`` und wird nie erneut abgefragt, auch das
  zu einem Barcode, der (noch) keinem Produkt gehört: Ein später angelegtes Produkt bekommt
  die Daten gleich in dem Abgleich, der es anlegt (``settle``, gerufen aus
  ``stowly/sync/handlers.py``),
* die Daten füllen **nur leere Felder** des Produkts; die Uhren der Felder bleiben
  unberührt, jede Eingabe eines Anwenders gewinnt, davor wie danach,
* ladeninterne Codes (Präfix 2) werden nie abgefragt.

Im Code steht keine Adresse eines Menschen: Der ``User-Agent`` nennt nur dann einen
Kontakt, wenn der Betreiber ``STOWLY_OFF_CONTACT`` setzt. Tests rufen den echten Dienst
nie auf; sie setzen einen Ersatz-Transport ein (``httpx2.MockTransport``).
"""

import asyncio
import contextlib
import hashlib
import json
import logging
import re
import sqlite3
import time
from collections import deque
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx2
from starlette.concurrency import run_in_threadpool

from stowly import __version__, db, events
from stowly.config import Settings
from stowly.contract.api import LookupResultState
from stowly.contract.ids import is_store_internal_barcode
from stowly.contract.timeutil import format_timestamp, parse_timestamp

log = logging.getLogger("stowly.off")

FIELDS = "product_name_de,product_name,brands,quantity,image_front_small_url"
LOOKUPS_PER_MINUTE = 10
RATE_WINDOW_S = 60.0
# Wartezeit nach dem 1., 2., 3. und 4. Fehlversuch; danach täglich.
RETRY_DELAYS_S = (60, 300, 1800, 10800)
RETRY_DAILY_S = 86400
# Nach einem 429 ruht der ganze Ablauf mindestens so lange.
PAUSE_AFTER_429_S = 60.0
PAUSE_MAX_S = 3600.0

MAX_IMAGE_BYTES = 300 * 1024
# So oft wird ein Bild nach einem vorübergehenden Fehler noch einmal versucht.
IMAGE_ATTEMPTS = 5
IMAGE_HOST = "openfoodfacts.org"
# Mit product_type=all leitet Open Food Facts auf die Schwesterprojekte weiter.
REDIRECT_HOSTS = ("openfoodfacts.org", "openbeautyfacts.org", "openpetfoodfacts.org", "openproductsfacts.org")
MAX_REDIRECTS = 3
IMAGE_SOURCE = "openfoodfacts"

NAME_LIMIT, BRAND_LIMIT, QUANTITY_LIMIT = 120, 80, 40  # wie ProductName, BrandName, QuantityText
RAW_LIMIT = 20_000
# Schätzzeichen am Ende der Packungsgröße: „℮" mit oder ohne Leerzeichen, „e" nur als eigenes Zeichen.
_ESTIMATE_SIGN = re.compile(r"(?:\s*℮|\s+e)\s*\Z")
TIMEOUT_S = 10.0
# So lange schläft der Ablauf höchstens, auch wenn nichts ansteht.
IDLE_MAX_S = 300.0
# Pause nach einem unerwarteten Fehler im Ablauf selbst.
ERROR_PAUSE_S = 30.0
# So viele Wünsche aus dem Vordergrund zu Barcodes ohne Produkt warten höchstens zugleich.
# Darüber antwortet der Server ``pending``, ohne einzureihen: Sonst könnte ein Gerät mit
# erfundenen Barcodes die Warteschlange füllen.
MAX_WISHES_WITHOUT_PRODUCT = 20


class Clock:
    """Zeitquelle des Ablaufs. Tests setzen eine eigene ein, die nicht wirklich wartet."""

    def now(self) -> datetime:
        return datetime.now(UTC)

    def monotonic(self) -> float:
        return time.monotonic()

    async def sleep(self, seconds: float) -> None:
        await asyncio.sleep(seconds)


# --- Ergebnisse eines Abrufs -------------------------------------------------------------


@dataclass(frozen=True)
class Found:
    name: str
    brand: str
    quantity: str
    image_url: str | None  # nur, wenn die Adresse erlaubt ist
    raw: str | None


@dataclass(frozen=True)
class NotFound:
    raw: str | None


@dataclass(frozen=True)
class Failed:
    reason: str
    pause_s: float | None = None  # gesetzt bei 429: so lange ruht der ganze Ablauf


@dataclass(frozen=True)
class Image:
    id: str
    content_type: str
    data: bytes


@dataclass(frozen=True)
class Job:
    barcode: str
    state: str  # 'pending' = nachschlagen, 'found' = nur noch das Bild holen
    image_url: str | None


@dataclass(frozen=True)
class Answer:
    """Was ``GET /api/lookup/{barcode}`` antwortet; leere Felder sind ``""`` (Abschnitt 10)."""

    state: LookupResultState
    name: str = ""
    brand: str = ""
    quantity: str = ""
    image_id: str | None = None


PENDING = Answer(LookupResultState.PENDING)


@dataclass(eq=False)
class _Wish:
    """Ein Barcode, auf den im Vordergrund jemand wartet (``GET /api/lookup/{barcode}``)."""

    orphan: bool  # gehört keinem Produkt: zählt gegen MAX_WISHES_WITHOUT_PRODUCT
    done: asyncio.Event = field(default_factory=asyncio.Event)
    answer: Answer | None = None  # sobald Open Food Facts geantwortet hat, auch schon vor dem Bild
    waiting: int = 0  # so viele Anfragen warten gerade darauf


# --- Reine Funktionen --------------------------------------------------------------------


def user_agent(contact: str | None) -> str:
    """``Stowly/<Version>``, mit ``(<Kontakt>)`` nur, wenn der Betreiber einen gesetzt hat.

    Der Kontakt kommt aus der Konfiguration und landet in einer Kopfzeile: nur druckbare
    ASCII-Zeichen, sonst scheiterte jeder Abruf schon beim Absenden.
    """
    base = f"Stowly/{__version__}"
    cleaned = "".join(char if " " <= char <= "~" else " " for char in contact or "")
    cleaned = " ".join(cleaned.split())[:200]
    return f"{base} ({cleaned})" if cleaned else base


def lookup_url(base_url: str, barcode: str) -> str:
    return f"{base_url}/api/v3/product/{barcode}?product_type=all&lc=de&fields={FIELDS}"


def retry_delay_s(attempts: int) -> int:
    """Wartezeit nach dem ``attempts``-ten Fehlversuch (ab 1 gezählt)."""
    if attempts <= len(RETRY_DELAYS_S):
        return RETRY_DELAYS_S[max(attempts, 1) - 1]
    return RETRY_DAILY_S


def _host_under(host: str | None, domains: tuple[str, ...]) -> bool:
    host = (host or "").lower().rstrip(".")
    return any(host == domain or host.endswith("." + domain) for domain in domains)


def is_allowed_image_url(url: Any) -> bool:
    """Bilder nur über ``https`` und nur von Rechnern unter ``openfoodfacts.org``."""
    if not isinstance(url, str) or len(url) > 2000 or not url.isascii():
        return False
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return False
    return (
        parts.scheme == "https"
        and parts.username is None
        and parts.password is None
        and port in (None, 443)
        and _host_under(parts.hostname, (IMAGE_HOST,))
    )


def sniff_image(data: bytes) -> tuple[str, str] | None:
    """``(Inhaltstyp, Endung)`` für JPEG, PNG und WebP, bestimmt am Inhalt; sonst ``None``."""
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg", ".jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png", ".png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp", ".webp"
    return None


def image_id(data: bytes, extension: str) -> str:
    """Anfang des SHA-256 des Inhalts (32 Hex-Zeichen) plus Endung."""
    return hashlib.sha256(data).hexdigest()[:32] + extension


def _clean(value: Any, limit: int) -> str:
    """Text aus fremder Quelle: ohne Steuerzeichen, Leerraum zusammengefasst, auf Feldlänge gekürzt."""
    if not isinstance(value, str):
        return ""
    printable = "".join(char if char.isprintable() else " " for char in value)
    return " ".join(printable.split())[:limit].rstrip()


def quantity_without_estimate_sign(text: str) -> str:
    """Die Packungsgröße ohne Schätzzeichen am Ende (docs/sync-protokoll.md, Abschnitt 10).

    „℮" am Ende fällt weg, mit oder ohne Leerzeichen davor („400 g℮", „400 g ℮"). Ein „e" nur
    als eigenes Zeichen hinter einem Leerzeichen („400 g e", „250 ml e"), nie als Ende eines
    Wortes („1 Flasche" bleibt).
    """
    return _ESTIMATE_SIGN.sub("", text).rstrip()


def _quantity(value: Any) -> str:
    cleaned = _clean(value, RAW_LIMIT)
    return quantity_without_estimate_sign(cleaned)[:QUANTITY_LIMIT].rstrip()


def _first_brand(value: Any) -> str:
    """Der erste Eintrag von ``brands`` (Text mit Kommas oder Liste)."""
    if isinstance(value, list):
        value = next((item for item in value if isinstance(item, str) and item.strip()), "")
    if not isinstance(value, str):
        return ""
    return _clean(value.split(",")[0], BRAND_LIMIT)


def _says_not_found(payload: Any) -> bool:
    if not isinstance(payload, dict):
        return False
    result = payload.get("result")
    if isinstance(result, dict) and result.get("id") == "product_not_found":
        return True
    errors = payload.get("errors")
    if isinstance(errors, list):
        for error in errors:
            message = error.get("message") if isinstance(error, dict) else None
            if isinstance(message, dict) and message.get("id") == "product_not_found":
                return True
    return False


def parse_lookup(status_code: int, text: str) -> Found | NotFound | Failed:
    """Deutet die Antwort von ``/api/v3/product/{barcode}``.

    ``product_not_found`` ist endgültig. 200 mit Produkt ist gefunden. Alles andere
    (429, 5xx, unerwartete Antworten) gilt als vorübergehend: Das Produkt bleibt ``pending``.
    """
    try:
        payload = json.loads(text)
    except ValueError:
        payload = None
    if _says_not_found(payload) or (status_code == 404 and "product_not_found" in text):
        return NotFound(raw=text if len(text) <= RAW_LIMIT else None)
    product = payload.get("product") if isinstance(payload, dict) else None
    if status_code == 200 and isinstance(product, dict):
        name = _clean(product.get("product_name_de"), NAME_LIMIT) or _clean(
            product.get("product_name"), NAME_LIMIT
        )
        image_url = product.get("image_front_small_url")
        # Als reines ASCII: Fremde Daten können halbe Zeichen enthalten, die sich sonst nicht speichern ließen.
        raw = json.dumps(product, ensure_ascii=True)
        return Found(
            name=name,
            brand=_first_brand(product.get("brands")),
            quantity=_quantity(product.get("quantity")),
            image_url=image_url if is_allowed_image_url(image_url) else None,
            raw=raw if len(raw) <= RAW_LIMIT else None,
        )
    return Failed(f"HTTP {status_code}")


# --- Datenbank ---------------------------------------------------------------------------

# Was ansteht: ein Abruf für ein wartendes Produkt oder ein Bild, das beim ersten Mal
# nicht zu holen war. Einträge ohne Produkt oder für ein fertiges Produkt ruhen.
_OPEN_WORK = (
    "FROM off_lookups l "
    "JOIN product_barcodes b ON b.barcode = l.barcode "
    "JOIN products p ON p.id = b.product_id "
    "WHERE l.next_attempt_at IS NOT NULL AND p.deleted_at IS NULL "
    "AND ((l.state = 'pending' AND p.lookup = 'pending') OR (l.state = 'found' AND p.image IS NULL))"
)


def _lookup_event(con: sqlite3.Connection, product_id: str, now: str, data: dict[str, Any]) -> None:
    events.record(
        con, at=now, recorded_at=now, type="product.lookup", entity="product", entity_id=product_id, data=data
    )


def _stored_image(con: sqlite3.Connection, url: str | None) -> str | None:
    if url is None:
        return None
    row = con.execute(
        "SELECT id FROM images WHERE source = ? AND source_url = ? ORDER BY created_at LIMIT 1",
        (IMAGE_SOURCE, url),
    ).fetchone()
    return None if row is None else str(row["id"])


def stored_answer(con: sqlite3.Connection, barcode: str) -> Answer | None:
    """Das gespeicherte Ergebnis zu einem Barcode als Antwort; ``None``, solange es keines gibt.

    Die Texte sind dieselben, mit denen ``settle`` ein Produkt füllt. Das Bild nur, wenn es
    schon in der Datenbank liegt.
    """
    row = con.execute(
        "SELECT state, name, brand, quantity, image_url FROM off_lookups WHERE barcode = ?", (barcode,)
    ).fetchone()
    if row is None or row["state"] == "pending":
        return None
    if row["state"] == "not_found":
        return Answer(LookupResultState.NOT_FOUND)
    return Answer(
        LookupResultState.FOUND,
        name=(row["name"] or "")[:NAME_LIMIT],
        brand=(row["brand"] or "")[:BRAND_LIMIT],
        quantity=(row["quantity"] or "")[:QUANTITY_LIMIT],
        image_id=_stored_image(con, row["image_url"]),
    )


def stored_answer_at(path: Path, barcode: str) -> Answer | None:
    """``stored_answer`` mit eigener Verbindung, für den Endpunkt, wenn der Ablauf nicht läuft."""
    con = db.connect(path)
    try:
        return stored_answer(con, barcode)
    finally:
        con.close()


def _answer_of(outcome: Found | NotFound, image_id: str | None = None) -> Answer:
    if isinstance(outcome, NotFound):
        return Answer(LookupResultState.NOT_FOUND)
    return Answer(LookupResultState.FOUND, outcome.name, outcome.brand, outcome.quantity, image_id)


def ensure_queued(con: sqlite3.Connection, barcode: str, now: str) -> None:
    """Stellt einen Barcode in die Warteschlange, falls er dort noch nicht steht."""
    con.execute(
        "INSERT OR IGNORE INTO off_lookups (barcode, state, attempts, next_attempt_at) VALUES (?, 'pending', 0, ?)",
        (barcode, now),
    )


def settle(
    con: sqlite3.Connection, product_id: str, now: str, fresh_images: dict[str, str] | None = None
) -> bool:
    """Entscheidet ``lookup`` eines wartenden Produkts aus den gespeicherten Ergebnissen.

    Gefunden: nur leere Felder füllen. Kennt Open Food Facts keinen der Barcodes:
    ``not_found``. Sonst wartet das Produkt weiter. Liefert, ob sich etwas geändert hat.
    Nur innerhalb einer Transaktion aufrufen.

    ``fresh_images`` nennt eben geladene Bilder als ``{adresse: bild_id}``: Zwei Adressen
    können denselben Inhalt liefern, gespeichert ist dann nur die erste.
    """
    product = con.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
    if product is None or product["deleted_at"] is not None or product["lookup"] != "pending":
        return False
    rows = [
        row
        for row in con.execute(
            "SELECT b.barcode, l.state, l.name, l.brand, l.quantity, l.image_url "
            "FROM product_barcodes b LEFT JOIN off_lookups l ON l.barcode = b.barcode "
            "WHERE b.product_id = ? ORDER BY b.created_at, b.barcode",
            (product_id,),
        )
        if not is_store_internal_barcode(row["barcode"])
    ]

    if not rows:
        # Kein nachschlagbarer Barcode mehr: nichts nachzuschlagen.
        con.execute(
            "UPDATE products SET lookup = 'none', rev = ? WHERE id = ?", (db.next_rev(con), product_id)
        )
        return True

    found = [row for row in rows if row["state"] == "found"]
    if found:
        values: dict[str, Any] = {}
        for index, row in enumerate(found):
            filled: list[str] = []
            for field in ("name", "brand", "quantity"):
                if product[field] == "" and field not in values and row[field]:
                    values[field] = row[field]
                    filled.append(field)
            if product["image"] is None and "image" not in values:
                stored = (fresh_images or {}).get(row["image_url"]) or _stored_image(con, row["image_url"])
                if stored is not None:
                    values["image"] = stored
                    filled.append("image")
            if filled or index == 0:
                _lookup_event(
                    con, product_id, now, {"barcode": row["barcode"], "result": "found", "filled": filled}
                )
        assignments = "".join(f"{field} = ?, " for field in values)
        touched = "updated_at = max(updated_at, ?), " if values else ""
        con.execute(
            f"UPDATE products SET {assignments}{touched}lookup = 'found', rev = ? WHERE id = ?",
            (*values.values(), *((now,) if values else ()), db.next_rev(con), product_id),
        )
        return True

    if all(row["state"] == "not_found" for row in rows):
        con.execute(
            "UPDATE products SET lookup = 'not_found', rev = ? WHERE id = ?", (db.next_rev(con), product_id)
        )
        _lookup_event(
            con, product_id, now, {"barcode": rows[0]["barcode"], "result": "not_found", "filled": []}
        )
        return True

    for row in rows:
        if row["state"] is None:
            ensure_queued(con, row["barcode"], now)
    return False


def attach_image(con: sqlite3.Connection, barcode: str, stored: str, now: str) -> None:
    """Trägt ein nachträglich geholtes Bild beim Produkt ein, wenn es noch keines hat."""
    owner = con.execute(
        "SELECT p.id FROM product_barcodes b JOIN products p ON p.id = b.product_id "
        "WHERE b.barcode = ? AND p.deleted_at IS NULL AND p.image IS NULL",
        (barcode,),
    ).fetchone()
    if owner is None:
        return
    con.execute(
        "UPDATE products SET image = ?, updated_at = max(updated_at, ?), rev = ? WHERE id = ?",
        (stored, now, db.next_rev(con), owner["id"]),
    )
    _lookup_event(con, owner["id"], now, {"barcode": barcode, "result": "found", "filled": ["image"]})


def reconcile(con: sqlite3.Connection, *, enabled: bool) -> None:
    """Bringt ``lookup`` beim Start mit der Einstellung ``STOWLY_OFF_ENABLED`` in Einklang.

    Abgeschaltet: Niemand schlägt mehr nach, wartende Produkte werden ``none``.
    Eingeschaltet: Produkte, die einen nachschlagbaren Barcode haben und trotzdem auf
    ``none`` stehen (angelegt, als abgeschaltet war), kommen in die Warteschlange.
    """
    now = format_timestamp(datetime.now(UTC))
    with db.transaction(con):
        if not enabled:
            for row in con.execute("SELECT id FROM products WHERE lookup = 'pending'").fetchall():
                con.execute(
                    "UPDATE products SET lookup = 'none', rev = ? WHERE id = ?", (db.next_rev(con), row["id"])
                )
            return
        rows = con.execute(
            "SELECT p.id, b.barcode FROM products p JOIN product_barcodes b ON b.product_id = p.id "
            "WHERE p.lookup = 'none' AND p.deleted_at IS NULL ORDER BY p.id"
        ).fetchall()
        waiting: set[str] = set()
        for row in rows:
            if is_store_internal_barcode(row["barcode"]):
                continue
            ensure_queued(con, row["barcode"], now)
            waiting.add(row["id"])
        for product_id in sorted(waiting):
            con.execute(
                "UPDATE products SET lookup = 'pending', rev = ? WHERE id = ?", (db.next_rev(con), product_id)
            )


# --- Der Hintergrund-Ablauf --------------------------------------------------------------


class OffWorker:
    """Arbeitet die Warteschlange ab. Läuft als eine asyncio-Aufgabe im ``lifespan`` der App.

    Nur dieser Ablauf fragt Open Food Facts; auch der Endpunkt ``GET /api/lookup/{barcode}``
    stellt seinen Barcode nur hier ein (``look_up``). Die Wünsche aus dem Vordergrund leben im
    Arbeitsspeicher und gehören zur Ereignisschleife der App.

    ``transport`` und ``clock`` sind der Ersatz für Tests; im Betrieb bleiben sie ``None``.
    """

    def __init__(
        self,
        settings: Settings,
        *,
        transport: httpx2.AsyncBaseTransport | None = None,
        clock: Clock | None = None,
    ) -> None:
        self._path: Path = settings.database_path
        self._base_url = settings.off_url
        self._clock = clock or Clock()
        self._client = httpx2.AsyncClient(
            transport=transport,
            headers={"User-Agent": user_agent(settings.off_contact), "Accept": "application/json, image/*"},
            timeout=httpx2.Timeout(TIMEOUT_S),
            follow_redirects=False,  # Weiterleitungen nur von Hand und nur zu erlaubten Rechnern
        )
        self._calls: deque[float] = deque()  # Zeitpunkte der letzten Abfragen (Drosselung)
        self._paused_until = 0.0
        self._wake = asyncio.Event()
        self._loop: asyncio.AbstractEventLoop | None = None
        # Wünsche aus dem Vordergrund je Barcode, in der Reihenfolge ihres Eintreffens.
        self._wishes: dict[str, _Wish] = {}
        self._closing = False

    # ------------------------------------------------------------------ Lebenslauf

    async def run(self) -> None:
        """Läuft, bis die Aufgabe abgebrochen wird. Ein Fehler beendet den Ablauf nie."""
        self._loop = asyncio.get_running_loop()
        while True:
            try:
                worked = await self.run_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Open Food Facts: unerwarteter Fehler im Hintergrund-Ablauf")
                await asyncio.sleep(ERROR_PAUSE_S)
                continue
            if not worked:
                await self._idle()

    def wake(self) -> None:
        """Es gibt neue Arbeit. Darf aus jedem Thread gerufen werden."""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        loop.call_soon_threadsafe(self._wake.set)

    def release(self) -> None:
        """Beim Herunterfahren: Wer auf ein Nachschlagen wartet, bekommt sofort, was bekannt ist.

        Danach wartet keine Anfrage mehr. Sonst hielte ein ``?wait=8`` das Beenden auf.
        """
        self._closing = True
        wishes, self._wishes = self._wishes, {}
        for wish in wishes.values():
            wish.done.set()

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _idle(self) -> None:
        """Wartet auf ``wake`` oder bis der nächste Eintrag fällig ist."""
        delay = await run_in_threadpool(self._seconds_until_due)
        timeout = IDLE_MAX_S if delay is None else min(max(delay, 0.0), IDLE_MAX_S)
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self._wake.wait(), timeout + 0.05)
        self._wake.clear()

    async def drain(self, limit: int = 10_000) -> int:
        """Arbeitet, bis nichts mehr fällig ist; liefert die Zahl der Schritte. Für Tests."""
        steps = 0
        while steps < limit and await self.run_once():
            steps += 1
        return steps

    async def run_once(self) -> bool:
        """Ein Schritt: gespeicherte Ergebnisse anwenden, dann höchstens ein Abruf.

        Wünsche aus dem Vordergrund kommen vor allem anderen dran. Liefert ``False``, wenn
        nichts zu tun war.
        """
        settled = await run_in_threadpool(self._settle_pending)
        job = await self._pick()
        if job is None:
            return settled > 0
        if (
            job.state == "pending"
            and not is_store_internal_barcode(job.barcode)
            and await self._wait_for_slot()
        ):
            # Während des Wartens auf die Rate kann ein Wunsch gekommen sein: Er bekommt den Platz.
            job = await self._pick()
            if job is None:
                return True
        try:
            if job.state == "pending":
                await self._lookup(job.barcode)
            else:
                await self._retry_image(job.barcode, job.image_url)
        finally:
            # Wer auf diesen Barcode wartet, erfährt spätestens jetzt, was bekannt ist, auch
            # nach einem Fehler und beim Herunterfahren.
            self._finish(job.barcode, None)
        return True

    async def _pick(self) -> Job | None:
        """Der nächste Abruf. Wünsche, deren Antwort ohne Abruf feststeht, bekommen sie gleich."""
        job, known = await run_in_threadpool(self._next_job, list(self._wishes))
        for barcode, answer in known.items():
            self._finish(barcode, answer)
        return job

    # ------------------------------------------------------------------ Vordergrund

    async def look_up(self, barcode: str, wait_s: float) -> Answer:
        """Antwort für ``GET /api/lookup/{barcode}`` zu einem gültigen, nachschlagbaren Barcode.

        Ein gespeichertes Ergebnis kommt sofort, ebenso ``pending``, solange nach einem
        Fehlversuch die Wartezeit läuft. Sonst kommt der Barcode vorn in die Warteschlange, und
        die Anfrage wartet höchstens ``wait_s`` Sekunden. Abgefragt wird nur im Ablauf selbst.
        """
        known, owned = await run_in_threadpool(self._known, barcode)
        if known is not None:
            return known
        wish = self._wish(barcode, orphan=not owned)
        if wish is None:
            return PENDING
        if wait_s > 0:
            wish.waiting += 1
            try:
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(wish.done.wait(), wait_s)
            finally:
                wish.waiting -= 1
        return wish.answer or PENDING

    def waiting(self) -> dict[str, int]:
        """Die Wünsche aus dem Vordergrund als ``{barcode: wartende_anfragen}``, älteste zuerst.

        Für Tests; nur in der Ereignisschleife der App aufrufen.
        """
        return {barcode: wish.waiting for barcode, wish in self._wishes.items()}

    def _wish(self, barcode: str, *, orphan: bool) -> _Wish | None:
        """Stellt den Barcode vorn in die Warteschlange. ``None``: nicht eingereiht.

        Gibt es schon einen Wunsch zu dem Barcode, teilen sich die Anfragen diesen.
        """
        if self._closing:
            return None
        wish = self._wishes.get(barcode)
        if wish is None:
            if orphan and sum(w.orphan for w in self._wishes.values()) >= MAX_WISHES_WITHOUT_PRODUCT:
                return None
            wish = self._wishes[barcode] = _Wish(orphan=orphan)
            self._wake.set()
        elif not orphan:
            wish.orphan = False
        return wish

    def _finish(self, barcode: str, answer: Answer | None) -> None:
        """Gibt allen Bescheid, die auf diesen Barcode warten: ``answer`` oder was bis dahin bekannt ist."""
        wish = self._wishes.pop(barcode, None)
        if wish is None:
            return
        if answer is not None:
            wish.answer = answer
        wish.done.set()

    # ------------------------------------------------------------------ Netz

    async def _wait_for_slot(self) -> bool:
        """Wartet, bis eine Abfrage erlaubt ist (Rate, Pause nach 429), ohne den Platz zu belegen.

        Liefert, ob gewartet werden musste.
        """
        waited = False
        while True:
            now = self._clock.monotonic()
            if now < self._paused_until:
                await self._clock.sleep(self._paused_until - now)
                waited = True
                continue
            while self._calls and self._calls[0] <= now - RATE_WINDOW_S:
                self._calls.popleft()
            if len(self._calls) < LOOKUPS_PER_MINUTE:
                return waited
            await self._clock.sleep(self._calls[0] + RATE_WINDOW_S - now)
            waited = True

    async def _throttle(self) -> None:
        """Höchstens ``LOOKUPS_PER_MINUTE`` Abfragen in jedem Fenster von 60 Sekunden."""
        await self._wait_for_slot()
        self._calls.append(self._clock.monotonic())

    def _api_redirect_allowed(self, target: httpx2.URL) -> bool:
        """Weiterleitungen der Abfrage: nur per https zu Open Food Facts und den Schwesterprojekten."""
        if str(target).startswith(self._base_url + "/"):
            return True
        return target.scheme == "https" and _host_under(target.host, REDIRECT_HOSTS)

    async def _query(self, barcode: str) -> Found | NotFound | Failed:
        url = lookup_url(self._base_url, barcode)
        try:
            for _hop in range(MAX_REDIRECTS + 1):
                response = await self._client.get(url)
                if not response.is_redirect:
                    break
                target = response.url.join(response.headers.get("location", ""))
                if not self._api_redirect_allowed(target):
                    return Failed(f"Weiterleitung nach {target.host} abgelehnt")
                url = str(target)
            else:
                return Failed("zu viele Weiterleitungen")
        except Exception as exc:
            # Netzfehler aller Art, auch ungültige Adressen in einer Weiterleitung: später erneut.
            return Failed(type(exc).__name__)
        if response.status_code == 429:
            return Failed("HTTP 429", pause_s=_pause_after_429(response.headers.get("retry-after")))
        return parse_lookup(response.status_code, response.text)

    async def _download(self, url: str) -> tuple[Image | None, bool]:
        """Lädt ein Bild. Liefert ``(bild, später_erneut)``; ``bild`` ist ``None`` bei jedem Fehlschlag.

        ``später_erneut`` nur bei vorübergehenden Fehlern (Netz, 429, 5xx). Zu groß,
        falscher Typ, fremder Rechner und 4xx sind endgültig.
        """
        try:
            for _hop in range(MAX_REDIRECTS + 1):
                if not is_allowed_image_url(url):
                    return None, False
                async with self._client.stream("GET", url) as response:
                    if response.is_redirect:
                        url = str(response.url.join(response.headers.get("location", "")))
                        continue
                    if response.status_code == 429 or response.status_code >= 500:
                        return None, True
                    if response.status_code != 200:
                        return None, False
                    declared = response.headers.get("content-length", "")
                    if declared.isdigit() and int(declared) > MAX_IMAGE_BYTES:
                        return None, False
                    data = bytearray()
                    async for chunk in response.aiter_bytes():
                        data.extend(chunk)
                        if len(data) > MAX_IMAGE_BYTES:
                            return None, False
                kind = sniff_image(bytes(data))
                if kind is None:
                    return None, False
                content_type, extension = kind
                return Image(image_id(bytes(data), extension), content_type, bytes(data)), False
            return None, False
        except httpx2.HTTPError:
            return None, True
        except Exception:
            # Etwa eine unlesbare Adresse in einer Weiterleitung: kein Bild, kein neuer Versuch.
            log.warning("Open Food Facts: Bild ließ sich nicht laden", exc_info=True)
            return None, False

    async def _lookup(self, barcode: str) -> None:
        if is_store_internal_barcode(barcode):
            # Sicherheitsnetz: Ladeninterne Codes gehören nie in die Warteschlange.
            await run_in_threadpool(self._drop, barcode)
            return
        await self._throttle()
        outcome = await self._query(barcode)
        wish = self._wishes.get(barcode)
        if wish is not None and not isinstance(outcome, Failed):
            # Name und Marke sind da. Wer nicht länger warten kann, bekommt sie schon vor dem Bild.
            wish.answer = _answer_of(outcome)
        image: Image | None = None
        image_retry = False
        if isinstance(outcome, Found) and outcome.image_url is not None:
            image, image_retry = await self._download(outcome.image_url)
        if isinstance(outcome, Failed):
            if outcome.pause_s is not None:
                self._paused_until = self._clock.monotonic() + outcome.pause_s
            log.warning("Open Food Facts: Abruf für %s fehlgeschlagen (%s)", barcode, outcome.reason)
        else:
            log.info(
                "Open Food Facts: %s %s", barcode, "gefunden" if isinstance(outcome, Found) else "unbekannt"
            )
        answer = await run_in_threadpool(self._store_lookup, barcode, outcome, image, image_retry)
        self._finish(barcode, answer)

    async def _retry_image(self, barcode: str, url: str | None) -> None:
        image: Image | None = None
        retry = False
        if url is not None:
            image, retry = await self._download(url)
        await run_in_threadpool(self._store_image, barcode, url, image, retry)

    # ------------------------------------------------------------------ Datenbank

    def _now(self) -> datetime:
        return self._clock.now()

    def _stamp(self, offset_s: float = 0.0) -> str:
        return format_timestamp(self._now() + timedelta(seconds=offset_s))

    def _settle_pending(self) -> int:
        """Wendet gespeicherte Ergebnisse auf alle wartenden Produkte an. Ohne Netz."""
        con = db.connect(self._path)
        try:
            waiting = [
                row["id"]
                for row in con.execute(
                    "SELECT id FROM products WHERE lookup = 'pending' AND deleted_at IS NULL ORDER BY id"
                )
            ]
            if not waiting:
                return 0
            changed = 0
            with db.transaction(con):
                now = self._stamp()
                for product_id in waiting:
                    changed += settle(con, product_id, now)
            return changed
        finally:
            con.close()

    def _next_job(self, wished: Sequence[str] = ()) -> tuple[Job | None, dict[str, Answer]]:
        """Der nächste fällige Abruf und die Antworten auf Wünsche, die ohne Abruf feststehen.

        Zuerst die Wünsche aus dem Vordergrund in der Reihenfolge ihres Eintreffens, dann, was
        sonst fällig ist. Die Wartezeit nach einem Fehlversuch gilt für beide.
        """
        con = db.connect(self._path)
        try:
            now = self._stamp()
            known: dict[str, Answer] = {}
            for barcode in wished:
                row = con.execute(
                    "SELECT state, next_attempt_at FROM off_lookups WHERE barcode = ?", (barcode,)
                ).fetchone()
                if row is None or (row["state"] == "pending" and (row["next_attempt_at"] or now) <= now):
                    return Job(barcode, "pending", None), known
                known[barcode] = stored_answer(con, barcode) or PENDING
            row = con.execute(
                f"SELECT l.barcode, l.state, l.image_url {_OPEN_WORK} AND l.next_attempt_at <= ? "
                "ORDER BY l.next_attempt_at, l.barcode LIMIT 1",
                (now,),
            ).fetchone()
            job = None if row is None else Job(row["barcode"], row["state"], row["image_url"])
            return job, known
        finally:
            con.close()

    def _known(self, barcode: str) -> tuple[Answer | None, bool]:
        """``(antwort, hat_produkt)``: ``antwort``, wenn sie ohne Abruf feststeht, sonst ``None``.

        Fest steht sie bei einem gespeicherten Ergebnis und solange nach einem Fehlversuch die
        Wartezeit läuft (``pending``): Die gilt auch, wenn jemand wartet. ``hat_produkt`` zählt
        nur ohne Antwort: Gehört der Barcode einem Produkt, zählt sein Wunsch nicht gegen
        ``MAX_WISHES_WITHOUT_PRODUCT``.
        """
        con = db.connect(self._path)
        try:
            row = con.execute(
                "SELECT state, next_attempt_at FROM off_lookups WHERE barcode = ?", (barcode,)
            ).fetchone()
            if row is not None and row["state"] != "pending":
                return stored_answer(con, barcode), True
            if (
                row is not None
                and row["next_attempt_at"] is not None
                and row["next_attempt_at"] > self._stamp()
            ):
                return PENDING, True
            owner = con.execute(
                "SELECT 1 FROM product_barcodes b JOIN products p ON p.id = b.product_id "
                "WHERE b.barcode = ? AND p.deleted_at IS NULL",
                (barcode,),
            ).fetchone()
            return None, owner is not None
        finally:
            con.close()

    def _seconds_until_due(self) -> float | None:
        con = db.connect(self._path)
        try:
            row = con.execute(f"SELECT MIN(l.next_attempt_at) {_OPEN_WORK}").fetchone()
        finally:
            con.close()
        if row is None or row[0] is None:
            return None
        return (parse_timestamp(row[0]) - self._now()).total_seconds()

    def _drop(self, barcode: str) -> None:
        con = db.connect(self._path)
        try:
            with db.transaction(con):
                con.execute("DELETE FROM off_lookups WHERE barcode = ? AND state = 'pending'", (barcode,))
        finally:
            con.close()

    @staticmethod
    def _save_image(con: sqlite3.Connection, image: Image, url: str | None, now: str) -> None:
        con.execute(
            "INSERT OR IGNORE INTO images (id, content_type, data, source, source_url, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (image.id, image.content_type, image.data, IMAGE_SOURCE, url, now),
        )

    def _store_lookup(
        self, barcode: str, outcome: Found | NotFound | Failed, image: Image | None, image_retry: bool
    ) -> Answer | None:
        """Hält das Ergebnis dauerhaft fest und entscheidet das Produkt, dem der Barcode gehört.

        Liefert die Antwort für Wartende im Vordergrund; ``None`` nach einem Fehlversuch.
        """
        con = db.connect(self._path)
        try:
            with db.transaction(con):
                now = self._stamp()
                row = con.execute("SELECT attempts FROM off_lookups WHERE barcode = ?", (barcode,)).fetchone()
                if row is None:
                    if is_store_internal_barcode(barcode):
                        return None
                    # Ein Wunsch aus dem Vordergrund: Der Barcode gehört (noch) keinem Produkt.
                    ensure_queued(con, barcode, now)
                attempts = (0 if row is None else int(row["attempts"])) + 1
                answer: Answer | None = None
                if isinstance(outcome, Found):
                    stored = image.id if image is not None else _stored_image(con, outcome.image_url)
                    answer = _answer_of(outcome, stored)
                    if image is not None:
                        self._save_image(con, image, outcome.image_url, now)
                    # Fehlt nur noch das Bild, zählt ``attempts`` ab hier dessen Fehlversuche.
                    con.execute(
                        "UPDATE off_lookups SET state = 'found', attempts = ?, next_attempt_at = ?, "
                        "fetched_at = ?, name = ?, brand = ?, quantity = ?, image_url = ?, raw = ? WHERE barcode = ?",
                        (
                            1 if image_retry else attempts,
                            self._stamp(retry_delay_s(1)) if image_retry else None,
                            now,
                            outcome.name,
                            outcome.brand,
                            outcome.quantity,
                            outcome.image_url,
                            outcome.raw,
                            barcode,
                        ),
                    )
                elif isinstance(outcome, NotFound):
                    answer = _answer_of(outcome)
                    con.execute(
                        "UPDATE off_lookups SET state = 'not_found', attempts = ?, next_attempt_at = NULL, "
                        "fetched_at = ?, raw = ? WHERE barcode = ?",
                        (attempts, now, outcome.raw, barcode),
                    )
                else:
                    con.execute(
                        "UPDATE off_lookups SET attempts = ?, next_attempt_at = ? WHERE barcode = ?",
                        (attempts, self._stamp(retry_delay_s(attempts)), barcode),
                    )
                    return None
                owner = con.execute(
                    "SELECT product_id FROM product_barcodes WHERE barcode = ?", (barcode,)
                ).fetchone()
                if owner is not None:
                    fresh: dict[str, str] = {}
                    if isinstance(outcome, Found) and image is not None and outcome.image_url is not None:
                        fresh[outcome.image_url] = image.id
                    settle(con, owner["product_id"], now, fresh)
                return answer
        finally:
            con.close()

    def _store_image(self, barcode: str, url: str | None, image: Image | None, retry: bool) -> None:
        con = db.connect(self._path)
        try:
            with db.transaction(con):
                row = con.execute("SELECT attempts FROM off_lookups WHERE barcode = ?", (barcode,)).fetchone()
                if row is None:
                    return
                now = self._stamp()
                attempts = int(row["attempts"]) + 1
                if image is not None:
                    self._save_image(con, image, url, now)
                    con.execute("UPDATE off_lookups SET next_attempt_at = NULL WHERE barcode = ?", (barcode,))
                    attach_image(con, barcode, image.id, now)
                elif retry and attempts < IMAGE_ATTEMPTS:
                    con.execute(
                        "UPDATE off_lookups SET attempts = ?, next_attempt_at = ? WHERE barcode = ?",
                        (attempts, self._stamp(retry_delay_s(attempts)), barcode),
                    )
                else:
                    con.execute(
                        "UPDATE off_lookups SET attempts = ?, next_attempt_at = NULL WHERE barcode = ?",
                        (attempts, barcode),
                    )
        finally:
            con.close()


def _pause_after_429(retry_after: str | None) -> float:
    """Wie lange der Ablauf nach einem 429 ruht: ``Retry-After``, mindestens eine Minute, höchstens eine Stunde."""
    seconds = PAUSE_AFTER_429_S
    if retry_after is not None and retry_after.strip().isdigit():
        seconds = max(seconds, float(retry_after.strip()))
    return min(seconds, PAUSE_MAX_S)
