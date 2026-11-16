"""Einkaufsliste nach Bring! über Home Assistant (docs/integrationen.md, Abschnitt 5).

Ein eigener Hintergrund-Ablauf nach dem Muster von ``off.OffWorker``: eine asyncio-Aufgabe im
``lifespan`` der App, mit eingereichter Uhr (``off.Clock``) und ``run_once()`` für Tests. Er läuft
immer, wie ``updates.UpdateChecker``: Vor jedem Lauf liest er die wirksame Einrichtung
(``haconfig.effective``: Umgebung oder App). Ohne Einrichtung ruht er mit dem Zustand ``off``, bis
``reconfigure`` ihn weckt. Er läuft alle zwei Minuten, nach einem Sync, der die Einkaufsliste geändert
hat (``changed``, frühestens 5 Sekunden nach der letzten solchen Änderung), und dann, wenn der nächste
offene Eintrag zwei Minuten offen ist.

**Ohne Neustart** (docs/plan-einrichtung-b.md, 3): ``reconfigure`` setzt einen Merker; ein laufender
Abgleich hört nach der laufenden Anfrage auf. Hat sich der Fingerabdruck geändert (Adresse, Hash des
Tokens, Liste, CA), schließt der Ablauf den alten Client und baut einen neuen, Zustand ``pending``, und
gleicht gleich ab. Lesen der Einrichtung und Läufe geschehen in derselben Aufgabe, also nie mitten in
einer Anfrage.

Ein Lauf (5.4):

1. **Liste da?** ``GET /api/states/<entity>``. Fehlt etwas, schreibt der Lauf nichts und zählt kein Fehlen.
2. **Lesen:** ``todo.get_items`` mit offenen und erledigten Artikeln. Gehört ``ha_links`` zu einer
   anderen Liste (Merker ``ha_links_entity``), vergisst Stowly deren Artikel und löst die Bindungen,
   ohne etwas abzuhaken; die offenen Einträge gehen neu in diese Liste.
3. **Zurück** aus Bring!: Was dort abgehakt oder (zweimal in Folge nicht gesehen) gelöscht ist,
   erledigt die gebundenen offenen Einträge; bei automatischen mit Sperre.
4. **Hin** nach Bring!: neue Einträge anlegen oder an einen gleichnamigen Artikel binden, die
   Beschreibung eigener Artikel nachführen, eigene Artikel ohne offenen Eintrag abhaken oder entfernen.
5. Zustand ``ok``.

Was dabei immer gilt:

* Stowly legt nie einen zweiten Artikel desselben Namens an und schreibt nie einen fremden Artikel.
  Einen eigenen schreibt es nur, solange er offen in der Liste steht.
* Kein Eintrag gilt als eingekauft, ohne dass es in Bring! geschah. Fehlen zählt erst bei einem
  Artikel, der schon in der Liste stand; ein Neustart von HA, der die Liste kurz leer zeigt, erledigt
  nichts.
* Ein automatischer Eintrag, der verschwindet, weil der Bestand reicht, wird in Bring! entfernt, nie
  abgehakt: So entsteht kein „gekauft", das niemand getan hat.
* Der Token steht nur in der Kopfzeile ``Authorization``: nie im Log, in der Datenbank, einer Antwort
  oder einer Fehlermeldung. Meldungen nennen Status und Pfad, nicht die Adresse von HA.

Der Zustand für die App (5.6) lebt im Arbeitsspeicher und beginnt mit jedem Start und jeder geänderten
Einrichtung bei ``pending``.
"""

import asyncio
import contextlib
import json
import logging
import sqlite3
import ssl
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import httpx2

from stowly import db, haconfig, serverconfig, shopping, texts
from stowly.config import Settings
from stowly.contract.api import HA_MIRROR_DELAY_S, HA_SYNC_INTERVAL_S
from stowly.contract.timeutil import format_timestamp, parse_timestamp
from stowly.off import Clock
from stowly.secretstore import SecretStore

log = logging.getLogger("stowly.ha")

# Takt: alle zwei Minuten (Vertrag); nach einer Änderung frühestens so viele Sekunden nach der letzten.
PERIOD_S = float(HA_SYNC_INTERVAL_S)
SETTLE_S = 5.0
# Ein Eintrag geht erst nach Bring!, wenn er so lange offen ist (Zeit für Rückgängig und Tippfehler).
OPEN_FOR = timedelta(seconds=HA_MIRROR_DELAY_S)
# Steht ein eigener Artikel so lange nach dem Anlegen noch nie in der Liste: einmal eine Warnung.
UNSEEN_WARN_AFTER = timedelta(minutes=10)
# So oft in Folge fehlt ein schon gesehener Artikel, bis er als in Bring! gelöscht gilt.
MISSES_FOR_REMOVED = 2
TIMEOUT_S = 10.0
# Mehr liest der Server aus keiner Antwort von HA (auch eine lange Liste bleibt weit darunter).
BODY_MAX = 8 * 1024 * 1024
# So lange wartet das Herunterfahren auf einen laufenden Abgleich.
SHUTDOWN_WAIT_S = 5.0
# Kopfzeilen jedes Aufrufs: JSON, ungepackt (so zählt die Grenze für den Rumpf, was ankommt).
HEADERS = {"Accept": "application/json", "Accept-Encoding": "identity"}

# ha_links.status: was Stowly zuletzt geschrieben (eigene) oder gesehen (fremde) hat.
OPEN = shopping.BRING_OPEN
COMPLETED = "completed"
REMOVED = "removed"

UNAUTHORIZED = "Home Assistant lehnt den Token ab."
UNAVAILABLE = "Die Liste ist in Home Assistant gerade nicht verfügbar."
UNREACHABLE = "Home Assistant ist nicht erreichbar."
UNTRUSTED = "Home Assistant ist nicht erreichbar: Zertifikat nicht vertraut, siehe STOWLY_HA_CA."
UNEXPECTED = "Home Assistant antwortet unerwartet."
NO_GET_ITEMS = "Home Assistant kennt todo.get_items nicht so (400)."
FAILED = "Unerwarteter Fehler beim Abgleich mit Home Assistant (Einzelheiten im Log des Servers)."
CA_UNUSABLE = "Die Zertifizierungsstelle aus STOWLY_HA_CA lässt sich nicht laden."

# Zustände, bei denen ein Lauf sofort endet: Jeder weitere Aufruf scheiterte genauso.
_FATAL = frozenset({"unauthorized", "unreachable"})


# --- Namen und Beschreibung (5.2) --------------------------------------------------------------


def mirror_name(product_id: str | None, product_name: str | None, text: str) -> str | None:
    """Der Name in Bring!: bei einem Produkt dessen Name, sonst der Text, getrimmt. ``None``: keiner.

    Ein Platzhalter ohne Namen wird erst gespiegelt, wenn er einen hat.
    """
    name = (product_name or "") if product_id is not None else text
    return name.strip() or None


def description(origin: str, quantity: int | None) -> str:
    """Die Spezifikation in Bring!: „fehlt 2 · Stowly", „3× · Stowly", sonst „Stowly"."""
    label = texts.quantity_label(origin, quantity)
    return f"{label} · Stowly" if label else "Stowly"


# --- Die Liste in Home Assistant ---------------------------------------------------------------


@dataclass(frozen=True)
class Item:
    """Ein Artikel aus ``todo.get_items``."""

    uid: str | None
    summary: str
    status: str  # needs_action oder completed
    description: str | None = None


class Listing:
    """Die gelesene Liste, nach Vergleichsform des Namens. Steht ein Name offen und erledigt darin,
    gilt der offene."""

    def __init__(self, items: Iterable[Item]) -> None:
        self.items = list(items)
        self._by_key: dict[str, list[Item]] = {}
        for item in self.items:
            key = texts.name_key(item.summary)
            if key:
                self._by_key.setdefault(key, []).append(item)

    def open(self, key: str) -> Item | None:
        return next((item for item in self._by_key.get(key, ()) if item.status == OPEN), None)

    def completed(self, key: str) -> list[Item]:
        return [item for item in self._by_key.get(key, ()) if item.status == COMPLETED]


def parse_items(payload: Any, entity: str) -> list[Item] | None:
    """Die Artikel aus ``service_response[<entity>].items``; ``None``, wenn die Antwort anders aussieht."""
    if not isinstance(payload, dict):
        return None
    response = payload.get("service_response")
    entry = response.get(entity) if isinstance(response, dict) else None
    raw_items = entry.get("items") if isinstance(entry, dict) else None
    if not isinstance(raw_items, list):
        return None
    found: list[Item] = []
    for raw in raw_items:
        if not isinstance(raw, dict):
            continue
        summary, status = raw.get("summary"), raw.get("status")
        if not isinstance(summary, str) or status not in (OPEN, COMPLETED):
            continue
        uid = raw.get("uid")
        text = raw.get("description")
        found.append(
            Item(
                uid=uid if isinstance(uid, str) and uid else None,
                summary=summary,
                status=status,
                description=text if isinstance(text, str) else None,
            )
        )
    return found


# --- Fehler ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Problem:
    """Warum ein Aufruf scheiterte: ``state`` und ``message`` für die App, ``detail`` fürs Log."""

    state: str
    message: str
    detail: str


class Failed(Exception):
    """Ein Aufruf an HA ist gescheitert. ``sent``: Die Anfrage kann HA trotzdem erreicht haben. ``status``:
    die Antwort von HA (nicht 2xx); ``None`` ohne Antwort."""

    def __init__(self, problem: Problem, *, sent: bool, status: int | None = None) -> None:
        super().__init__(problem.detail)
        self.problem = problem
        self.sent = sent
        self.status = status


@dataclass(frozen=True)
class Reply:
    """Eine Antwort 2xx von HA: Status und Rumpf (höchstens die Grenze des Aufrufs)."""

    status: int
    body: bytes

    def data(self) -> Any:
        """Der Rumpf als JSON; ``None``, wenn er keines ist."""
        try:
            return json.loads(self.body)
        except (ValueError, RecursionError):
            return None


class _TooLarge(Exception):
    """Der Rumpf einer Antwort überschreitet die Grenze des Aufrufs."""


def untrusted(exc: BaseException) -> bool:
    """Scheiterte die Verbindung am Zertifikat von HA?"""
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, ssl.SSLCertVerificationError):
            return True
        text = str(current)
        if "CERTIFICATE_VERIFY_FAILED" in text or "certificate verify failed" in text:
            return True
        current = current.__cause__ or current.__context__
    return False


def trust(ca: Path | None) -> ssl.SSLContext | bool:
    """Die eigene Zertifizierungsstelle aus ``STOWLY_HA_CA`` zusätzlich zu denen des Systems. Wirft
    ``OSError`` oder ``ssl.SSLError``, wenn sie sich nicht laden lässt."""
    if ca is None:
        return True
    context = ssl.create_default_context()
    context.load_verify_locations(cafile=str(ca))
    return context


def _size(limit: int) -> str:
    mib = 1024 * 1024
    return f"{limit // mib} MiB" if limit % mib == 0 else f"{limit // 1024} KiB"


def transport_problem(exc: BaseException, shown: str) -> tuple[Problem, bool]:
    """Ein Aufruf ohne Antwort: Netz, Zeitüberschreitung, Zertifikat. Liefert das Problem und ob die Anfrage
    HA trotzdem erreicht haben kann."""
    detail = f"{shown}: {type(exc).__name__}"
    if isinstance(exc, httpx2.ConnectError | httpx2.ConnectTimeout | httpx2.PoolTimeout):
        # Die Anfrage hat HA nicht erreicht.
        return Problem("unreachable", UNTRUSTED if untrusted(exc) else UNREACHABLE, detail), False
    if isinstance(exc, httpx2.InvalidURL | UnicodeError):
        return Problem("unreachable", UNREACHABLE, detail), False
    if isinstance(exc, TimeoutError | httpx2.TimeoutException):
        return Problem("unreachable", UNREACHABLE, detail), True
    return Problem("unreachable", UNTRUSTED if untrusted(exc) else UNREACHABLE, detail), True


def status_problem(
    status: int, shown: str, *, missing: str | None = None, bad_request: str | None = None
) -> Problem:
    """Eine Antwort, die nicht 2xx ist. Meldungen nennen Status und Pfad, nie einen Rumpf von HA."""
    if status == 401:
        return Problem("unauthorized", UNAUTHORIZED, f"{shown}: 401")
    if status == 404 and missing is not None:
        return Problem("not_found", missing, f"{shown}: 404")
    if status == 400 and bad_request is not None:
        return Problem("error", bad_request, f"{shown}: 400")
    return Problem("error", f"Home Assistant antwortet mit {status}.", f"{shown}: {status}")


async def request(
    client: httpx2.AsyncClient,
    method: str,
    url: str,
    *,
    shown: str,
    payload: Mapping[str, Any] | None = None,
    missing: str | None = None,
    bad_request: str | None = None,
    timeout: float | None = None,
    limit: int | None = None,
) -> Reply:
    """Ein Aufruf an HA; ``Failed`` bei allem außer 2xx, ohne einer Weiterleitung zu folgen.

    Höchstens ``timeout`` Sekunden (Vorgabe ``TIMEOUT_S``) für Anfrage und Antwort zusammen, auch wenn die
    Antwort tröpfchenweise kommt, und höchstens ``limit`` Byte Rumpf (Vorgabe ``BODY_MAX``). ``shown``
    (Methode und Pfad) steht in den Meldungen, nie die Adresse von HA oder ein Rumpf. Der Abgleich und die
    Prüfung der Einrichtung (``hacheck.py``) teilen diesen Aufruf und seine Fehlerabbildung.
    """
    timeout = TIMEOUT_S if timeout is None else timeout
    limit = BODY_MAX if limit is None else limit

    async def exchange() -> Reply:
        async with client.stream(method, url, json=payload) as response:
            if not 200 <= response.status_code < 300:
                return Reply(response.status_code, b"")  # den Rumpf eines Fehlers liest Stowly nicht
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body += chunk
                if len(body) > limit:
                    raise _TooLarge
            return Reply(response.status_code, bytes(body))

    try:
        reply = await asyncio.wait_for(exchange(), timeout)
    except _TooLarge:
        message = f"Die Antwort von Home Assistant ist zu groß (mehr als {_size(limit)})."
        raise Failed(Problem("error", message, f"{shown}: mehr als {limit} Byte"), sent=True) from None
    except (TimeoutError, httpx2.HTTPError, httpx2.InvalidURL, UnicodeError) as exc:
        # UnicodeError: Der Resolver lehnt einen Namen ab (etwa mit leerem Teil), bevor ein Paket hinausgeht.
        problem, sent = transport_problem(exc, shown)
        raise Failed(problem, sent=sent) from None
    if 200 <= reply.status < 300:
        return reply
    problem = status_problem(reply.status, shown, missing=missing, bad_request=bad_request)
    raise Failed(problem, sent=True, status=reply.status)


# --- Was ein Lauf schreibt ---------------------------------------------------------------------


@dataclass(frozen=True)
class _Add:
    """Ein neuer Artikel: Name und Beschreibung des ältesten Eintrags, die Einträge, die ihn teilen."""

    key: str
    name: str
    description: str
    entries: list[str]
    # Kennung eines erledigten gleichnamigen Artikels in der Liste („zuletzt gekauft"): Bis Stowly
    # den neuen Artikel offen sieht, gilt dieser nicht als abgehakt.
    stale_uid: str | None


@dataclass(frozen=True)
class _Write:
    """Ein eigener Artikel, der offen in der Liste steht: Beschreibung nachführen, abhaken oder entfernen."""

    key: str
    kind: str  # describe, complete, remove
    target: str  # uid, sonst der Name, wie er in der Liste steht
    description: str | None = None


@dataclass
class _Run:
    """Was ein Lauf an Fehlern sammelt, die ihn nicht beenden (ein einzelner Artikel)."""

    problems: list[Problem] = field(default_factory=list)


def _fresh(state: str) -> dict[str, Any]:
    return {"state": state, "last_ok_at": None, "last_error": None, "last_error_at": None}


class BringSync:
    """Gleicht die Einkaufsliste mit der To-do-Liste in Home Assistant ab.

    Entsteht immer und baut seinen Client erst, wenn HA eingerichtet ist (``_refresh``). ``store`` ist der
    Speicher der Tokens (``app.state.secrets``; ohne einer zum Lesen im Datenordner). ``transport`` und
    ``clock`` sind der Ersatz für Tests; im Betrieb bleiben sie ``None``.
    """

    def __init__(
        self,
        settings: Settings,
        store: SecretStore | None = None,
        *,
        transport: httpx2.AsyncBaseTransport | None = None,
        clock: Clock | None = None,
    ) -> None:
        self._settings = settings
        self._store = store
        self._path = settings.database_path
        self._transport = transport
        self._clock = clock or Clock()
        # Der Client gehört zur Einrichtung mit diesem Fingerabdruck; None = nicht eingerichtet.
        self._client: httpx2.AsyncClient | None = None
        self._fingerprint: haconfig.Fingerprint | None = None
        self._base = ""
        self._entity = ""
        self._wake = asyncio.Event()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._stopping = False
        self._reconfigured = False  # die Einrichtung hat sich geändert: aufhören und neu lesen
        self._next_run: float | None = None  # monoton; None = sofort
        self._settle_until: float | None = None
        self._warned: set[str] = set()
        # Bis zum ersten Lesen der Einrichtung ``pending``; ``integrations.ha_status`` zeigt ohne Einrichtung
        # ohnehin ``off`` und vor dem ersten Lauf mit dieser Einrichtung ``pending``.
        self._status: dict[str, Any] = _fresh("pending")

    # ------------------------------------------------------------------ Zustand (5.6)

    def status(self) -> dict[str, Any]:
        """``state``, ``last_ok_at``, ``last_error`` und ``last_error_at`` für ``HaStatus``."""
        return dict(self._status)

    @property
    def fingerprint(self) -> haconfig.Fingerprint | None:
        """Die Einrichtung, für die ``status`` gilt (``haconfig.Effective.fingerprint``); ``None`` = keine."""
        return self._fingerprint

    def _succeed(self, now: datetime) -> None:
        previous = self._status["state"]
        self._status = {
            "state": "ok",
            "last_ok_at": format_timestamp(now),
            "last_error": None,
            "last_error_at": None,
        }
        if previous == "pending":
            log.info("Home Assistant: Abgleich mit %s läuft.", self._entity)
        elif previous != "ok":
            log.info("Home Assistant: Abgleich mit %s läuft wieder.", self._entity)

    def _fail(self, problem: Problem, now: datetime) -> None:
        previous = self._status["state"]
        self._status = {
            "state": problem.state,
            "last_ok_at": self._status["last_ok_at"],
            "last_error": problem.message,
            "last_error_at": format_timestamp(now),
        }
        # Ins Log kommt ein Wechsel des Zustands, nicht jeder gescheiterte Lauf.
        if previous != problem.state:
            log.warning("Home Assistant: %s (%s)", problem.message, problem.detail)

    # ------------------------------------------------------------------ Lebenslauf

    async def run(self) -> None:
        """Läuft bis ``stop``: liest die Einrichtung, ruht ohne sie, gleicht mit ihr im Takt ab. Ein Fehler
        beendet den Ablauf nie."""
        self._loop = asyncio.get_running_loop()
        while not self._stopping:
            try:
                if not await self._refresh():
                    await self._sleep()
                    continue
                await self._wait()
                if self._halted():
                    continue  # beendet, oder die Einrichtung ist neu zu lesen
                await self._run()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Home Assistant: unerwarteter Fehler im Abgleich")
                self._next_run = self._clock.monotonic() + PERIOD_S
                self._fail(Problem("error", FAILED, "unerwartet"), self._clock.now())
                await self._sleep(PERIOD_S)

    def changed(self) -> None:
        """Die Einkaufsliste hat sich geändert. Darf aus jedem Thread gerufen werden."""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        with contextlib.suppress(RuntimeError):  # die Schleife endet gerade
            loop.call_soon_threadsafe(self._on_change)

    def _on_change(self) -> None:
        if self._client is None:
            return  # nicht eingerichtet: Erst reconfigure weckt den Ablauf
        self._settle_until = self._clock.monotonic() + SETTLE_S
        self._wake.set()

    def reconfigure(self) -> None:
        """Die Einrichtung hat sich geändert (``PATCH /api/server-config/ha``): Ein laufender Abgleich hört
        nach der laufenden Anfrage auf, dann liest der Ablauf die Einrichtung neu und gleicht gleich ab.
        Darf aus jedem Thread gerufen werden."""
        loop = self._loop
        if loop is not None and not loop.is_closed():
            with contextlib.suppress(RuntimeError):  # die Schleife endet gerade
                loop.call_soon_threadsafe(self._on_reconfigure)
                return
        self._reconfigured = True

    def _on_reconfigure(self) -> None:
        self._reconfigured = True
        self._wake.set()

    def stop(self) -> None:
        """Der laufende Abgleich schreibt nichts Neues mehr an; danach endet der Ablauf."""
        self._stopping = True
        self._wake.set()

    def _halted(self) -> bool:
        """Soll ein laufender Abgleich aufhören? Beim Beenden und wenn die Einrichtung neu zu lesen ist."""
        return self._stopping or self._reconfigured

    async def aclose(self) -> None:
        await self._drop_client()
        self._fingerprint = None  # ein späterer Lauf baut den Client neu

    async def _drop_client(self) -> None:
        client, self._client = self._client, None
        if client is not None:
            await client.aclose()

    async def _sleep(self, timeout: float | None = None) -> None:
        """Ruht, bis ``reconfigure``, eine Änderung der Einkaufsliste oder ``stop`` weckt, höchstens
        ``timeout`` Sekunden."""
        if self._halted():
            return
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self._wake.wait(), timeout)
        self._wake.clear()

    async def _wait(self) -> None:
        """Bis der nächste Lauf fällig ist: Takt, Änderung oder ein Eintrag, der zwei Minuten offen ist."""
        while not self._halted():
            delay = await self._delay()
            if delay <= 0:
                return
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._wake.wait(), delay)
            self._wake.clear()

    # ------------------------------------------------------------------ Einrichtung

    def _effective(self) -> haconfig.Effective:
        con = db.connect(self._path)
        try:
            return haconfig.effective(self._settings, con, self._store)
        finally:
            con.close()

    async def _refresh(self) -> bool:
        """Liest die wirksame Einrichtung; liefert, ob HA eingerichtet ist. Nur zwischen zwei Läufen.

        Nicht eingerichtet: Client schließen, Zustand ``off``. Fingerabdruck geändert: alten Client
        schließen, neuen bauen, Zustand ``pending``, gleich abgleichen.
        """
        self._reconfigured = False
        current = await asyncio.to_thread(self._effective)
        fingerprint = current.fingerprint
        if fingerprint is None or current.url is None or current.entity is None or current.token is None:
            if self._fingerprint is not None:
                log.info("Home Assistant: Der Abgleich ist aus (nicht mehr eingerichtet).")
            await self._drop_client()
            self._fingerprint = None
            self._status = _fresh("off")
            return False
        if fingerprint == self._fingerprint:
            return self._client is not None
        again = self._fingerprint is not None
        await self._drop_client()
        self._fingerprint = fingerprint
        self._base, self._entity = current.url, current.entity
        self._next_run = None
        self._warned.clear()
        self._status = _fresh("pending")
        try:
            verify = trust(current.ca)
        except (OSError, ssl.SSLError) as exc:
            # STOWLY_HA_CA ist beim Start geprüft; fehlt die Datei inzwischen, hilft erst ein Neustart.
            self._fail(
                Problem("error", CA_UNUSABLE, f"STOWLY_HA_CA: {type(exc).__name__}"), self._clock.now()
            )
            return False
        self._client = httpx2.AsyncClient(
            transport=self._transport,
            headers={"Authorization": f"Bearer {current.token}", **HEADERS},
            timeout=httpx2.Timeout(TIMEOUT_S),
            follow_redirects=False,  # Weiterleitungen folgt der Server nicht (5.4)
            verify=verify,
        )
        if again:
            log.info("Home Assistant: Einrichtung geändert, der Abgleich mit %s beginnt neu.", self._entity)
        return True

    async def _delay(self) -> float:
        now = self._clock.monotonic()
        targets = [now if self._next_run is None else self._next_run]
        if self._settle_until is not None:
            targets.append(self._settle_until)
        try:
            ready = await asyncio.to_thread(self.seconds_until_ready)
        except Exception:
            log.exception("Home Assistant: Wann ist der nächste Eintrag zwei Minuten offen? Unbekannt")
            ready = None
        if ready is not None:
            targets.append(now + ready)
        return min(targets) - now

    def seconds_until_ready(self) -> float | None:
        """Sekunden, bis der nächste noch nicht gespiegelte Eintrag zwei Minuten offen ist; sonst ``None``."""
        now = self._clock.now()
        con = db.connect(self._path)
        try:
            rows = con.execute(
                "SELECT COALESCE(c.at, s.created_at) AS opened FROM shopping_items s "
                "LEFT JOIN field_clocks c ON c.entity = ? AND c.entity_id = s.id AND c.field = ? "
                "WHERE s.done_at IS NULL AND s.deleted_at IS NULL AND s.bring_key IS NULL",
                (shopping.ENTITY, shopping.DONE_CLOCK),
            ).fetchall()
        finally:
            con.close()
        waits = [(parse_timestamp(row["opened"]) + OPEN_FOR - now).total_seconds() for row in rows]
        coming = [wait for wait in waits if wait > 0]
        return min(coming) if coming else None

    # ------------------------------------------------------------------ Ein Lauf

    async def run_once(self) -> bool:
        """Ein Abgleich: erst die Einrichtung lesen (``_refresh``), dann die Schritte 1 bis 5. Liefert, ob er
        gelang; ohne Einrichtung ``False``, ohne eine Anfrage an HA."""
        self._loop = asyncio.get_running_loop()
        if not await self._refresh():
            return False
        return await self._run()

    async def _run(self) -> bool:
        """Die Schritte 1 bis 5 mit dem Client der gelesenen Einrichtung."""
        self._next_run = self._clock.monotonic() + PERIOD_S
        self._settle_until = None
        now = self._clock.now()
        run = _Run()
        try:
            listing = await self._read()
            if self._halted():
                return self._interrupted()
            await asyncio.to_thread(self._adopt, now)
            await asyncio.to_thread(self._back, listing, now)
            await self._forward(listing, now, run)
        except Failed as failed:
            self._fail(failed.problem, now)
            return False
        if self._halted():
            return self._interrupted()
        if run.problems:
            self._fail(run.problems[0], now)
            return False
        self._succeed(now)
        return True

    def _interrupted(self) -> bool:
        """Der Lauf hört vorzeitig auf. Hat sich die Einrichtung geändert, kommt der nächste gleich danach."""
        if self._reconfigured:
            self._next_run = None
        return False

    # ------------------------------------------------------------------ 1. und 2.: lesen

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: Mapping[str, Any] | None = None,
        missing: str | None = None,
        bad_request: str | None = None,
    ) -> Reply:
        """Ein Aufruf an HA (``request``); ``Failed`` bei allem außer 2xx. Fehler nennen Methode, Pfad und
        Status."""
        if self._client is None:
            raise Failed(Problem("error", FAILED, "kein Client"), sent=False)
        return await request(
            self._client,
            method,
            self._base + path,
            shown=f"{method} {path.split('?', 1)[0]}",
            payload=json,
            missing=missing,
            bad_request=bad_request,
        )

    async def _read(self) -> Listing:
        missing = f"Die Liste {self._entity} gibt es in Home Assistant nicht."
        path = f"/api/states/{self._entity}"
        state = (await self._request("GET", path, missing=missing)).data()
        value = state.get("state") if isinstance(state, dict) else None
        if not isinstance(value, str):
            raise Failed(Problem("error", UNEXPECTED, f"GET {path}: ohne Zustand"), sent=True)
        if value in ("unavailable", "unknown"):
            raise Failed(Problem("unavailable", UNAVAILABLE, f"GET {path}: {value}"), sent=True)
        reply = await self._request(
            "POST",
            "/api/services/todo/get_items?return_response",
            json={"entity_id": self._entity, "status": [OPEN, COMPLETED]},
            missing=missing,
            bad_request=NO_GET_ITEMS,
        )
        items = parse_items(reply.data(), self._entity)
        if items is None:
            raise Failed(
                Problem("error", UNEXPECTED, "POST /api/services/todo/get_items: ohne service_response"),
                sent=True,
            )
        return Listing(items)

    # ------------------------------------------------------------------ Listenwechsel

    def _adopt(self, now: datetime) -> None:
        """Merkt sich, zu welcher Liste ``ha_links`` gehört (``ha_links_entity``), in einer Transaktion.

        Gehört es zu einer anderen Liste, vergisst Stowly deren Artikel und löst die Bindungen aller
        Einträge der Einkaufsliste (``bring_key`` steht nicht im Sync: kein neuer ``rev``). Nichts wird
        abgehakt; die offenen Einträge gehen neu in die neue Liste, in der alten bleiben sie stehen. Fehlt
        der Merker (erster Lauf nach dem Update), setzt Stowly nur ihn.
        """
        stamp = format_timestamp(now)
        con = db.connect(self._path)
        try:
            with db.transaction(con):
                known = serverconfig.get(con, haconfig.LINKS_ENTITY)
                if known == self._entity:
                    return
                if isinstance(known, str):
                    entries = con.execute(
                        "SELECT COUNT(*) FROM shopping_items "
                        "WHERE bring_key IS NOT NULL AND done_at IS NULL AND deleted_at IS NULL"
                    ).fetchone()[0]
                    con.execute("UPDATE shopping_items SET bring_key = NULL WHERE bring_key IS NOT NULL")
                    links = con.execute("DELETE FROM ha_links").rowcount
                    log.info(
                        "Home Assistant: Liste gewechselt (%s statt %s): %d Artikel der alten Liste vergessen, "
                        "%d offene Einträge gehen neu nach Bring!. Nichts wird abgehakt.",
                        self._entity,
                        known,
                        links,
                        entries,
                    )
                serverconfig.put(con, haconfig.LINKS_ENTITY, self._entity, now=stamp, by=None)
        finally:
            con.close()
        self._warned.clear()

    # ------------------------------------------------------------------ 3.: zurück aus Bring!

    def _back(self, listing: Listing, now: datetime) -> None:
        stamp = format_timestamp(now)
        con = db.connect(self._path)
        try:
            with db.transaction(con):
                cause = shopping.Cause(con=con, at=stamp, recorded_at=stamp, command_id=None)
                for row in con.execute("SELECT * FROM ha_links ORDER BY name_key").fetchall():
                    values = self._back_row(cause, row, listing, now)
                    if values:
                        assignments = ", ".join(f"{column} = ?" for column in values)
                        con.execute(
                            f"UPDATE ha_links SET {assignments} WHERE name_key = ?",
                            (*values.values(), row["name_key"]),
                        )
        finally:
            con.close()

    def _back_row(
        self, cause: shopping.Cause, row: sqlite3.Row, listing: Listing, now: datetime
    ) -> dict[str, Any]:
        """Was ein Artikel in der Liste über ihn sagt; liefert die neuen Spalten der Zeile."""
        key = row["name_key"]
        stamp = cause.at
        opened = listing.open(key)
        if opened is not None:
            values: dict[str, Any] = {"seen_at": stamp, "misses": 0, "uid": opened.uid}
            if not row["own"]:
                values["status"] = OPEN
            elif row["status"] != OPEN:
                # Stowly hatte ihn abgehakt oder entfernt, jemand hat ihn zurück auf die Liste geholt:
                # Er gehört jetzt dem Haushalt. Stowly liest ihn nur noch.
                values.update(own=0, status=OPEN, description=None)
                log.info(
                    "Home Assistant: %s steht wieder auf der Liste, Stowly schreibt ihn nicht mehr.", key
                )
            return values

        done = listing.completed(key)
        if done:
            if row["status"] == OPEN and (
                row["seen_at"] is not None or any(_new(item, row) for item in done)
            ):
                # In Bring! abgehakt.
                item = next((item for item in done if _new(item, row)), done[0])
                self._close_bound(cause, key, item.summary, "completed")
                return {"seen_at": stamp, "misses": 0, "uid": item.uid, "status": COMPLETED}
            if row["seen_at"] is not None:
                item = next((item for item in done if item.uid == row["uid"]), done[0])
                return {"seen_at": stamp, "misses": 0, "uid": item.uid}
            # Noch nie gesehen, seit Stowly ihn anlegte: Das Erledigte ist ein alter Artikel aus
            # „zuletzt gekauft", nicht der eigene.
            return self._unseen(row, now)

        if row["seen_at"] is None:
            # Fehlen zählt erst, wenn der Artikel schon einmal in der Liste stand.
            return self._unseen(row, now)
        misses = int(row["misses"]) + 1
        if misses >= MISSES_FOR_REMOVED and row["status"] == OPEN:
            # Zweimal in Folge nicht gesehen, während HA und die Liste erreichbar waren: in Bring! gelöscht.
            self._close_bound(cause, key, row["name"], "removed")
            return {"misses": misses, "status": REMOVED}
        return {"misses": misses}

    def _unseen(self, row: sqlite3.Row, now: datetime) -> dict[str, Any]:
        """Ein eigener Artikel, den Stowly angelegt, aber noch nie in der Liste gesehen hat."""
        key = row["name_key"]
        written = row["written_at"]
        if (
            row["own"]
            and row["status"] == OPEN
            and written is not None
            and key not in self._warned
            and now - parse_timestamp(written) >= UNSEEN_WARN_AFTER
        ):
            self._warned.add(key)
            log.warning(
                "Home Assistant: Der Artikel %r steht zehn Minuten nach dem Anlegen noch nicht in der Liste "
                "(anderer Name in Bring!?). Er bleibt gebunden und offen.",
                row["name"],
            )
        return {}

    @staticmethod
    def _close_bound(cause: shopping.Cause, key: str, name: str, how: str) -> None:
        """In Bring! abgehakt oder gelöscht: alle offenen Einträge, die an diesen Artikel gebunden sind."""
        items = cause.con.execute(
            "SELECT id, origin, product_id FROM shopping_items "
            "WHERE bring_key = ? AND done_at IS NULL AND deleted_at IS NULL ORDER BY created_at, id",
            (key,),
        ).fetchall()
        for item in items:
            shopping.bring_done(cause, item, name=name, how=how)
        if items:
            log.info(
                "Home Assistant: %r in Bring! %s; erledigt: %s.",
                name,
                "abgehakt" if how == "completed" else "gelöscht",
                "1 Eintrag" if len(items) == 1 else f"{len(items)} Einträge",
            )

    # ------------------------------------------------------------------ 4.: hin nach Bring!

    async def _forward(self, listing: Listing, now: datetime, run: _Run) -> None:
        if self._halted():
            return
        adds = await asyncio.to_thread(self._bind, listing, now)
        for add in adds:
            if self._halted():
                return
            await self._add(add, now, run)
        writes = await asyncio.to_thread(self._writes, listing)
        for write in writes:
            if self._halted():
                return
            await self._write(write, now, run)

    def _bind(self, listing: Listing, now: datetime) -> list[_Add]:
        """Neue Einträge: an einen offenen gleichnamigen Artikel binden; liefert, was neu anzulegen ist."""
        stamp = format_timestamp(now)
        con = db.connect(self._path)
        try:
            with db.transaction(con):
                rows = {row["name_key"]: row for row in con.execute("SELECT * FROM ha_links").fetchall()}
                groups = self._new_entries(con, rows, now)
                adds: list[_Add] = []
                for key, group in groups.items():
                    row = rows.get(key)
                    ids = [entry["id"] for entry, _name in group]
                    opened = listing.open(key)
                    if opened is not None:
                        if row is None:
                            # Ein Artikel, den Stowly nicht kennt: Er bleibt fremd, Stowly liest ihn nur.
                            con.execute(
                                "INSERT INTO ha_links (name_key, name, uid, own, description, status, written_at, "
                                "seen_at, misses) VALUES (?, ?, ?, 0, NULL, ?, NULL, ?, 0)",
                                (key, opened.summary, opened.uid, OPEN, stamp),
                            )
                        elif row["status"] != OPEN:
                            con.execute(
                                "UPDATE ha_links SET status = ?, seen_at = ?, misses = 0 WHERE name_key = ?",
                                (OPEN, stamp, key),
                            )
                        _bind_entries(con, key, ids)
                    elif row is not None and row["status"] == OPEN:
                        if row["seen_at"] is None:
                            # Angelegt, aber noch nicht in der Liste: kein zweiter Artikel.
                            _bind_entries(con, key, ids)
                        # Sonst fehlt er gerade (vielleicht gelöscht): erst der nächste Lauf entscheidet.
                    else:
                        oldest, name = group[0]
                        done = listing.completed(key)
                        adds.append(
                            _Add(
                                key=key,
                                name=name,
                                description=description(oldest["origin"], oldest["quantity"]),
                                entries=ids,
                                stale_uid=done[0].uid if done else None,
                            )
                        )
                return adds
        finally:
            con.close()

    @staticmethod
    def _new_entries(
        con: sqlite3.Connection, rows: Mapping[str, sqlite3.Row], now: datetime
    ) -> dict[str, list[tuple[sqlite3.Row, str]]]:
        """Offene Einträge mit Namen, seit zwei Minuten offen, noch ohne offenen Artikel; je Vergleichsform."""
        entries = con.execute(
            "SELECT s.id, s.product_id, s.text, s.quantity, s.origin, s.created_at, s.bring_key, "
            "p.name AS product_name, c.at AS opened_at FROM shopping_items s "
            "LEFT JOIN products p ON p.id = s.product_id "
            "LEFT JOIN field_clocks c ON c.entity = ? AND c.entity_id = s.id AND c.field = ? "
            "WHERE s.done_at IS NULL AND s.deleted_at IS NULL ORDER BY s.created_at, s.id",
            (shopping.ENTITY, shopping.DONE_CLOCK),
        ).fetchall()
        groups: dict[str, list[tuple[sqlite3.Row, str]]] = {}
        for entry in entries:
            bound = entry["bring_key"]
            if bound is not None and bound in rows and rows[bound]["status"] == OPEN:
                continue
            name = mirror_name(entry["product_id"], entry["product_name"], entry["text"])
            if name is None:
                continue
            opened = parse_timestamp(entry["opened_at"] or entry["created_at"])
            if now - opened < OPEN_FOR:
                continue
            groups.setdefault(texts.name_key(name), []).append((entry, name))
        return groups

    async def _add(self, add: _Add, now: datetime, run: _Run) -> None:
        payload = {"entity_id": self._entity, "item": add.name, "description": add.description}
        try:
            await self._request("POST", "/api/services/todo/add_item", json=payload)
        except Failed as failed:
            fatal = failed.problem.state in _FATAL
            if failed.sent and failed.problem.state == "unreachable":
                # Ohne Antwort weiß Stowly nicht, ob HA ihn angelegt hat. Lieber gilt er als angelegt,
                # als dass ein zweiter Artikel desselben Namens entsteht. Eine Antwort wie 401 ist
                # dagegen eine Ablehnung: Dann ist nichts angelegt.
                await asyncio.to_thread(self._added, add, now)
            if fatal:
                raise
            run.problems.append(failed.problem)
            log.info("Home Assistant: %s ließ sich nicht anlegen (%s)", add.key, failed.problem.detail)
            return
        await asyncio.to_thread(self._added, add, now)

    def _added(self, add: _Add, now: datetime) -> None:
        """Merkt sich den neuen eigenen Artikel (eine alte Zeile desselben Namens wird ersetzt) und bindet."""
        stamp = format_timestamp(now)
        con = db.connect(self._path)
        try:
            with db.transaction(con):
                # Die Einträge des alten Artikels dieses Namens gehören nicht zum neuen.
                con.execute(
                    "UPDATE shopping_items SET bring_key = NULL WHERE bring_key = ? "
                    "AND (done_at IS NOT NULL OR deleted_at IS NOT NULL)",
                    (add.key,),
                )
                con.execute(
                    "INSERT INTO ha_links (name_key, name, uid, own, description, status, written_at, seen_at, "
                    "misses) VALUES (?, ?, ?, 1, ?, ?, ?, NULL, 0) ON CONFLICT (name_key) DO UPDATE SET "
                    "name = excluded.name, uid = excluded.uid, own = 1, description = excluded.description, "
                    "status = excluded.status, written_at = excluded.written_at, seen_at = NULL, misses = 0",
                    (add.key, add.name, add.stale_uid, add.description, OPEN, stamp),
                )
                _bind_entries(con, add.key, add.entries)
        finally:
            con.close()
        self._warned.discard(add.key)

    def _writes(self, listing: Listing) -> list[_Write]:
        """Eigene offene Artikel, die gerade offen in der Liste stehen: was an ihnen zu schreiben ist."""
        con = db.connect(self._path)
        try:
            writes: list[_Write] = []
            rows = con.execute(
                "SELECT * FROM ha_links WHERE own = 1 AND status = ? ORDER BY name_key", (OPEN,)
            ).fetchall()
            for row in rows:
                key = row["name_key"]
                opened = listing.open(key)
                if opened is None:
                    # Noch nicht oder gerade nicht in der Liste: Stowly schreibt erst, wenn es ihn sieht.
                    continue
                target = opened.uid or opened.summary
                entries = con.execute(
                    "SELECT origin, quantity FROM shopping_items WHERE bring_key = ? "
                    "AND done_at IS NULL AND deleted_at IS NULL ORDER BY created_at, id",
                    (key,),
                ).fetchall()
                if entries:
                    wanted = description(entries[0]["origin"], entries[0]["quantity"])
                    if wanted != row["description"]:
                        writes.append(_Write(key, "describe", target, wanted))
                    continue
                kind = _closing(con, key)
                if kind is not None:
                    writes.append(_Write(key, kind, target))
            return writes
        finally:
            con.close()

    async def _write(self, write: _Write, now: datetime, run: _Run) -> None:
        if write.kind == "remove":
            service, payload = "remove_item", {"entity_id": self._entity, "item": write.target}
        elif write.kind == "complete":
            service, payload = (
                "update_item",
                {"entity_id": self._entity, "item": write.target, "status": COMPLETED},
            )
        else:
            service, payload = (
                "update_item",
                {"entity_id": self._entity, "item": write.target, "description": write.description},
            )
        try:
            await self._request("POST", f"/api/services/todo/{service}", json=payload)
        except Failed as failed:
            if failed.problem.state in _FATAL:
                raise
            run.problems.append(failed.problem)
            log.info("Home Assistant: %s ließ sich nicht schreiben (%s)", write.key, failed.problem.detail)
            return
        await asyncio.to_thread(self._wrote, write, now)

    def _wrote(self, write: _Write, now: datetime) -> None:
        stamp = format_timestamp(now)
        con = db.connect(self._path)
        try:
            with db.transaction(con):
                if write.kind == "describe":
                    con.execute(
                        "UPDATE ha_links SET description = ?, written_at = ? WHERE name_key = ?",
                        (write.description, stamp, write.key),
                    )
                else:
                    status = REMOVED if write.kind == "remove" else COMPLETED
                    con.execute(
                        "UPDATE ha_links SET status = ?, written_at = ? WHERE name_key = ?",
                        (status, stamp, write.key),
                    )
        finally:
            con.close()


def _new(item: Item, row: sqlite3.Row) -> bool:
    """Ein erledigter Artikel, der nicht der alte aus „zuletzt gekauft" ist (andere Kennung)."""
    return item.uid is not None and item.uid != row["uid"]


def _bind_entries(con: sqlite3.Connection, key: str, ids: Sequence[str]) -> None:
    """Bindet offene Einträge an einen Artikel. ``bring_key`` steht nicht im Sync: kein neuer ``rev``."""
    for item_id in ids:
        con.execute(
            "UPDATE shopping_items SET bring_key = ? WHERE id = ? AND done_at IS NULL AND deleted_at IS NULL",
            (key, item_id),
        )


def _closing(con: sqlite3.Connection, key: str) -> str | None:
    """Ein eigener Artikel ohne offenen Eintrag: Entschieden wird nach dem zuletzt geschlossenen (``closed_by``).

    * ``stock``, ``merge``: entfernen. Der Bestand reicht wieder; so entsteht kein „gekauft".
    * ``device``, ``store``: abhaken, er wandert in Bring! zu „zuletzt gekauft".
    * ``bring`` oder keiner: nichts.
    """
    rows = con.execute(
        "SELECT closed_by, done_at, deleted_at, rev FROM shopping_items "
        "WHERE bring_key = ? AND (done_at IS NOT NULL OR deleted_at IS NOT NULL)",
        (key,),
    ).fetchall()
    if not rows:
        return None
    last = max(rows, key=lambda row: (row["done_at"] or row["deleted_at"], row["rev"]))
    closed_by = last["closed_by"]
    if closed_by in (shopping.CLOSED_BY_STOCK, shopping.CLOSED_BY_MERGE):
        return "remove"
    if closed_by in (shopping.CLOSED_BY_DEVICE, shopping.CLOSED_BY_STORE):
        return "complete"
    return None
