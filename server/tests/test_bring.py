"""Einkaufsliste nach Bring! über Home Assistant (docs/integrationen.md, Abschnitt 5).

Gegen ein nachgebildetes HA (``ha_fake.FakeHA``), das jede offene Annahme aus Abschnitt 9 umschaltbar
macht. Die Tests treiben den Abgleich von Hand (``run_once``) mit der angehaltenen Serveruhr; zwei
lassen ihn laufen wie im Betrieb. Nach jedem Lauf prüft ``Bench.run``, was in keiner Variante
geschehen darf: kein zweiter Artikel desselben Namens, kein fremder Artikel geschrieben.
"""

import asyncio
import dataclasses
import json
import logging
import ssl
import time
from datetime import UTC, datetime

import httpx2
import pytest
from fastapi.testclient import TestClient
from ha_fake import BASE, COMPLETED, ENTITY, OPEN, TOKEN, Behaviour, FakeHA, bring_key, violations
from support import EAN_A, Device, ServerClock, events_of, statuses

from stowly import bring, db, off
from stowly.app import create_app
from stowly.config import Settings
from stowly.contract import ids
from stowly.contract.api import IntegrationStatus

START = datetime(2026, 11, 14, 9, 0, tzinfo=UTC)
TWO_MINUTES = 120


class FollowClock(off.Clock):
    """Die Uhr des Abgleichs folgt der angehaltenen Serveruhr."""

    def __init__(self, server: ServerClock) -> None:
        self.server = server

    def now(self) -> datetime:
        return self.server.now()

    def monotonic(self) -> float:
        return self.server.now().timestamp()

    async def sleep(self, seconds: float) -> None:
        self.server.advance(seconds)


@dataclasses.dataclass
class Bench:
    settings: Settings
    client: TestClient
    clock: ServerClock
    device: Device
    ha: FakeHA
    worker: bring.BringSync

    # ------------------------------------------------------------------ Abgleich

    def run(self, after: float = 0.0) -> bool:
        """Ein Abgleich ``after`` Sekunden später. Danach darf nichts Verbotenes geschehen sein."""
        self.clock.advance(after)
        ok = asyncio.run(self.worker.run_once())
        assert violations(self.ha) == [], violations(self.ha)
        return ok

    def state(self) -> str:
        return self.worker.status()["state"]

    # ------------------------------------------------------------------ Stowly

    def sync(self, *commands: dict) -> dict:
        data = self.device.sync(list(commands))
        assert statuses(data) == [("applied", None)] * len(commands), data["results"]
        return data

    def entry(
        self, text: str | None = None, *, product_id: str | None = None, quantity: int | None = None
    ) -> str:
        item_id = ids.new_uuid()
        payload: dict = {"item_id": item_id}
        if text is not None:
            payload["text"] = text
        if product_id is not None:
            payload["product_id"] = product_id
        if quantity is not None:
            payload["quantity"] = quantity
        self.sync(self.device.cmd("shopping_item.create", **payload))
        return item_id

    def product(self, name: str, **payload) -> str:
        product_id, command = self.device.product(name, **payload)
        self.sync(command)
        return product_id

    def store(self, product_id: str) -> str:
        package_id, command = self.device.package(product_id)
        self.sync(command)
        return package_id

    def tick(self, item_id: str, done: bool = True) -> None:
        self.sync(self.device.cmd("shopping_item.update", item_id=item_id, changes={"done": done}))

    def delete(self, item_id: str) -> None:
        self.sync(self.device.cmd("shopping_item.delete", item_id=item_id))

    def auto(self, product_id: str) -> str:
        """Der offene automatische Eintrag eines Produkts."""
        (row,) = self.query(
            "SELECT id FROM shopping_items WHERE product_id = ? AND origin = 'min_stock' "
            "AND done_at IS NULL AND deleted_at IS NULL",
            product_id,
        )
        return row["id"]

    # ------------------------------------------------------------------ Datenbank

    def query(self, sql: str, *parameters) -> list[dict]:
        con = db.connect(self.settings.database_path)
        try:
            return [dict(row) for row in con.execute(sql, parameters)]
        finally:
            con.close()

    def item(self, item_id: str) -> dict:
        (row,) = self.query("SELECT * FROM shopping_items WHERE id = ?", item_id)
        return row

    def link(self, key: str) -> dict | None:
        rows = self.query("SELECT * FROM ha_links WHERE name_key = ?", key)
        return rows[0] if rows else None

    def open_entries(self) -> int:
        return len(self.query("SELECT id FROM shopping_items WHERE done_at IS NULL AND deleted_at IS NULL"))

    def closed_by_bring(self) -> set[str]:
        """Vergleichsformen der Artikel, an denen Einträge hingen, die Bring! erledigt hat."""
        found = set()
        for event in events_of(self.client, self.device, entity="shopping_item"):
            if event["type"] == "shopping_item.bring_done":
                found.add(bring_key(event["data"]["name"]))
        return found


@pytest.fixture
def make_bench(settings, clock):
    created: list[bring.BringSync] = []

    def factory(behaviour: Behaviour | None = None, **overrides) -> Bench:
        configured = dataclasses.replace(
            settings, ha_url=BASE, ha_token=TOKEN, ha_todo_entity=ENTITY, **overrides
        )
        clock.value = START
        # Ohne „with": Der lifespan läuft nicht; den Abgleich treibt der Test selbst.
        client = TestClient(create_app(configured))
        ha = FakeHA(behaviour)
        worker = bring.BringSync(configured, transport=httpx2.MockTransport(ha), clock=FollowClock(clock))
        created.append(worker)
        device = Device(client, "Handy", clock=clock)
        device.sync()
        return Bench(configured, client, clock, device, ha, worker)

    yield factory
    for worker in created:
        asyncio.run(worker.aclose())


@pytest.fixture
def bench(make_bench) -> Bench:
    return make_bench()


# --- Hin: aus Stowly nach Bring! ---------------------------------------------------------------


def test_an_entry_goes_to_bring_after_two_minutes(bench):
    milk = bench.entry("Milch")
    assert bench.run() is True
    assert bench.state() == "ok"
    assert bench.ha.calls("add_item") == []  # noch keine zwei Minuten offen
    bench.run(after=TWO_MINUTES - 1)
    assert bench.ha.calls("add_item") == []
    bench.run(after=1)
    assert bench.ha.calls("add_item") == [{"entity_id": ENTITY, "item": "Milch", "description": "Stowly"}]
    assert bench.item(milk)["bring_key"] == "milch"
    link = bench.link("milch")
    assert (
        link["name"],
        link["own"],
        link["status"],
        link["description"],
        link["seen_at"],
        link["misses"],
    ) == (
        "Milch",
        1,
        OPEN,
        "Stowly",
        None,
        0,
    )
    # Im nächsten Lauf steht er in der Liste: gesehen, mit seiner Kennung.
    bench.run(after=TWO_MINUTES)
    link = bench.link("milch")
    assert link["seen_at"] is not None and link["uid"] == bench.ha.find("Milch").uid
    assert len(bench.ha.calls("add_item")) == 1


def test_every_run_asks_like_the_contract_says(bench):
    bench.run()
    state, read = bench.ha.requests
    assert (state.method, str(state.url)) == ("GET", f"{BASE}/api/states/{ENTITY}")
    assert (read.method, str(read.url)) == ("POST", f"{BASE}/api/services/todo/get_items?return_response")
    assert json.loads(read.content) == {"entity_id": ENTITY, "status": ["needs_action", "completed"]}
    for request in bench.ha.requests:
        assert request.headers["authorization"] == f"Bearer {TOKEN}"


def test_quantities_and_the_description_of_the_oldest_entry(bench):
    butter = bench.product("Butter")
    milk = bench.product("Milch", min_stock=2)  # automatisch: fehlt 2
    bench.entry(product_id=butter, quantity=3)
    older = bench.entry("kaffee ")
    bench.clock.advance(1)
    bench.entry("  Kaffee", quantity=2)  # derselbe Name: ein Artikel, die Beschreibung vom älteren
    bench.run(after=TWO_MINUTES)
    assert sorted(bench.ha.calls("add_item"), key=lambda call: call["item"]) == [
        {"entity_id": ENTITY, "item": "Butter", "description": "3× · Stowly"},
        {"entity_id": ENTITY, "item": "Milch", "description": "fehlt 2 · Stowly"},
        {"entity_id": ENTITY, "item": "kaffee", "description": "Stowly"},
    ]
    bench.run(after=TWO_MINUTES)  # gesehen
    # Die Menge ändert sich: Die Beschreibung wird nachgeführt, über die uid.
    bench.store(milk)
    bench.tick(older)  # jetzt ist der jüngere Kaffee der älteste offene
    bench.run(after=10)
    updates = bench.ha.calls("update_item")
    assert {
        "entity_id": ENTITY,
        "item": bench.ha.find("Milch").uid,
        "description": "fehlt 1 · Stowly",
    } in updates
    assert {"entity_id": ENTITY, "item": bench.ha.find("Kaffee").uid, "description": "2× · Stowly"} in updates
    assert bench.ha.find("Milch").description == "fehlt 1 · Stowly"
    bench.run(after=TWO_MINUTES)
    assert len(bench.ha.calls("update_item")) == 2  # nichts Neues: nichts geschrieben


def test_done_deleted_or_stored_in_stowly_is_ticked_in_bring(bench):
    yoghurt = bench.product("Joghurt")
    ticked, deleted, stored = bench.entry("Milch"), bench.entry("Brot"), bench.entry(product_id=yoghurt)
    bench.run(after=TWO_MINUTES)
    bench.run(after=TWO_MINUTES)
    bench.tick(ticked)
    bench.delete(deleted)
    bench.store(yoghurt)
    assert bench.item(stored)["closed_by"] == "store"
    bench.run(after=10)
    assert sorted(call["item"] for call in bench.ha.calls("update_item")) == sorted(
        bench.ha.find(name).uid for name in ("Milch", "Brot", "Joghurt")
    )
    assert all(call["status"] == COMPLETED for call in bench.ha.calls("update_item"))
    assert bench.ha.names(COMPLETED) == ["Brot", "Joghurt", "Milch"]
    assert [bench.link(key)["status"] for key in ("milch", "brot", "joghurt")] == [COMPLETED] * 3
    # Was Stowly selbst abgehakt hat, gilt nicht als in Bring! abgehakt.
    bench.run(after=TWO_MINUTES)
    assert bench.closed_by_bring() == set()


def test_an_automatic_entry_that_is_no_longer_needed_is_removed_never_bought(bench):
    milk = bench.product("Milch", min_stock=1)
    quark = bench.product("Quark", min_stock=1)
    bench.run(after=TWO_MINUTES)
    bench.run(after=TWO_MINUTES)
    assert bench.ha.names() == ["Milch", "Quark"]
    uids = sorted(bench.ha.find(name).uid for name in ("Milch", "Quark"))
    bench.store(milk)  # der Bestand reicht
    bench.sync(bench.device.cmd("product.update", product_id=quark, changes={"min_stock": None}))
    bench.run(after=10)
    assert sorted(call["item"] for call in bench.ha.calls("remove_item")) == uids
    assert bench.ha.items == []
    assert bench.ha.calls("update_item") == []  # nie abgehakt, also nie „gekauft"
    assert (bench.link("milch")["status"], bench.link("quark")["status"]) == ("removed", "removed")


def test_a_placeholder_waits_for_its_name_and_renaming_stays_out_of_bring(bench):
    placeholder = bench.product("", barcodes=[EAN_A])
    entry = bench.entry(product_id=placeholder)
    text = bench.entry("Grillkohle")
    bench.run(after=TWO_MINUTES)
    assert [call["item"] for call in bench.ha.calls("add_item")] == ["Grillkohle"]
    bench.sync(bench.device.cmd("product.update", product_id=placeholder, changes={"name": "Hafermilch"}))
    bench.run(after=10)
    assert [call["item"] for call in bench.ha.calls("add_item")] == ["Grillkohle", "Hafermilch"]
    # Umbenennen geht nicht nach Bring!; der Eintrag bleibt an seinem Artikel.
    bench.sync(bench.device.cmd("product.update", product_id=placeholder, changes={"name": "Haferdrink"}))
    bench.sync(bench.device.cmd("shopping_item.update", item_id=text, changes={"text": "Holzkohle"}))
    bench.run(after=TWO_MINUTES)
    bench.run(after=TWO_MINUTES)
    assert len(bench.ha.calls("add_item")) == 2 and bench.ha.calls("update_item") == []
    assert (bench.item(entry)["bring_key"], bench.item(text)["bring_key"]) == ("hafermilch", "grillkohle")


def test_one_item_per_name_for_several_entries(bench):
    first, second = bench.entry("Milch"), bench.entry("MILCH")
    bench.run(after=TWO_MINUTES)
    bench.run(after=TWO_MINUTES)
    third = bench.entry(" milch ")
    bench.run(after=TWO_MINUTES)
    assert len(bench.ha.calls("add_item")) == 1
    assert {bench.item(item)["bring_key"] for item in (first, second, third)} == {"milch"}
    # Solange einer offen ist, bleibt der Artikel offen.
    bench.tick(first)
    bench.delete(second)
    bench.run(after=10)
    assert bench.ha.find("Milch").status == OPEN
    bench.tick(third)
    bench.run(after=10)
    assert bench.ha.find("Milch").status == COMPLETED


# --- Zurück: aus Bring! nach Stowly ------------------------------------------------------------


def test_ticked_in_bring_is_done_in_stowly_and_locks_an_automatic_entry(bench):
    milk = bench.entry("Milch")
    quark = bench.product("Quark", min_stock=2)
    bench.store(quark)  # fehlt 1
    auto = bench.auto(quark)
    bench.run(after=TWO_MINUTES)
    bench.run(after=TWO_MINUTES)
    bench.ha.user_tick("Milch")
    bench.ha.user_tick("Quark")
    cursor = bench.device.cursor
    bench.run(after=30)
    now = bench.clock.stamp()
    for item_id in (milk, auto):
        row = bench.item(item_id)
        assert (row["done_at"], row["closed_by"], row["updated_at"]) == (now, "bring", now)
        assert row["rev"] > cursor
    assert (bench.link("milch")["status"], bench.link("quark")["status"]) == (COMPLETED, COMPLETED)
    # Die Geräte erfahren es mit dem nächsten Abgleich.
    data = bench.device.sync()
    assert {item["id"]: item["done_at"] for item in data["changes"]["shopping_items"]} == {
        milk: now,
        auto: now,
    }
    events = events_of(bench.client, bench.device)
    done = [event for event in events if event["type"] == "shopping_item.bring_done"]
    assert sorted((event["entity_id"], event["data"]["how"]) for event in done) == sorted(
        [(milk, "completed"), (auto, "completed")]
    )
    assert all(event["device_id"] is None and event["command_id"] is None for event in done)
    assert {event["data"]["name"] for event in done} == {"Milch", "Quark"}
    lock = [event for event in events if event["type"] == "product.shopping_lock"]
    assert [(event["entity_id"], event["data"]["lock"]) for event in lock] == [(quark, now)]
    # Gesperrt: Auch wenn die letzte Packung geht, entsteht bis zum Einlagern kein neuer Eintrag.
    (package,) = [row["id"] for row in bench.query("SELECT id FROM packages WHERE product_id = ?", quark)]
    bench.sync(bench.device.cmd("package.remove", package_id=package, reason="consumed"))
    assert bench.query("SELECT id FROM shopping_items WHERE product_id = ? AND done_at IS NULL", quark) == []
    # Nichts mehr zu schreiben: In Bring! ist es schon erledigt.
    bench.run(after=TWO_MINUTES)
    assert bench.ha.calls("update_item") == [] and bench.ha.calls("remove_item") == []


def test_deleted_in_bring_counts_after_missing_twice(bench):
    milk = bench.entry("Milch")
    bench.run(after=TWO_MINUTES)
    bench.run(after=TWO_MINUTES)  # gesehen
    bench.ha.user_delete("Milch")
    bench.run(after=TWO_MINUTES)
    assert bench.item(milk)["done_at"] is None and bench.link("milch")["misses"] == 1
    bench.run(after=TWO_MINUTES)
    row = bench.item(milk)
    assert (row["closed_by"], row["done_at"]) == ("bring", bench.clock.stamp())
    assert bench.link("milch")["status"] == "removed"
    (event,) = [e for e in events_of(bench.client, bench.device) if e["type"] == "shopping_item.bring_done"]
    assert event["data"] == {"name": "Milch", "how": "removed"}


def test_missing_once_and_back_again_changes_nothing(bench):
    milk = bench.entry("Milch")
    bench.run(after=TWO_MINUTES)
    bench.run(after=TWO_MINUTES)
    item = bench.ha.find("Milch")
    bench.ha.items.remove(item)
    bench.run(after=TWO_MINUTES)
    bench.ha.items.append(item)
    bench.run(after=TWO_MINUTES)
    bench.ha.items.remove(item)
    bench.run(after=TWO_MINUTES)
    assert bench.item(milk)["done_at"] is None and bench.link("milch")["misses"] == 1


def test_an_own_item_never_seen_is_never_deleted_and_warned_about_once(make_bench, caplog):
    bench = make_bench(Behaviour(truncate=4))
    caplog.set_level(logging.INFO, logger="stowly.ha")
    milk = bench.entry("Milchreis")
    bench.run(after=TWO_MINUTES)
    assert bench.ha.names() == ["Milc"]  # HA hat den Namen gekürzt
    for _ in range(5):  # zehn Minuten nach dem Anlegen
        bench.run(after=TWO_MINUTES)
    assert bench.item(milk)["done_at"] is None
    assert bench.link("milchreis")["seen_at"] is None and bench.link("milchreis")["misses"] == 0
    warnings = [record for record in caplog.records if "zehn Minuten" in record.getMessage()]
    assert len(warnings) == 1
    # Auch wenn jemand den gekürzten Artikel abhakt oder löscht: Stowly erkennt ihn nicht.
    bench.ha.user_tick("Milc")
    bench.run(after=TWO_MINUTES)
    bench.ha.user_delete("Milc")
    bench.run(after=TWO_MINUTES)
    bench.run(after=TWO_MINUTES)
    assert bench.item(milk)["done_at"] is None


def test_a_foreign_item_is_only_read(bench):
    bench.ha.user_add("Kaffee", "die gute Sorte")
    first = bench.entry("kaffee ")
    bench.run(after=TWO_MINUTES)
    assert bench.ha.calls("add_item") == []
    link = bench.link("kaffee")
    assert (link["own"], link["status"], link["name"], link["uid"]) == (0, OPEN, "Kaffee", "uid-0001")
    assert bench.item(first)["bring_key"] == "kaffee"
    # Stowly hakt ab: In Bring! bleibt der fremde Artikel, wie er ist.
    bench.tick(first)
    bench.run(after=TWO_MINUTES)
    assert bench.ha.writes == [] and bench.ha.find("Kaffee").description == "die gute Sorte"
    # Ein neuer Eintrag desselben Namens bindet sich wieder an ihn; hakt ihn jemand ab, ist er eingekauft.
    second = bench.entry("Kaffee")
    bench.run(after=TWO_MINUTES)
    bench.ha.user_tick("Kaffee")
    bench.run(after=TWO_MINUTES)
    assert bench.item(second)["closed_by"] == "bring"
    assert bench.ha.writes == []


def test_an_own_item_brought_back_by_someone_becomes_foreign(bench):
    milk = bench.entry("Milch")
    bench.run(after=TWO_MINUTES)
    bench.run(after=TWO_MINUTES)
    bench.tick(milk)
    bench.run(after=10)  # Stowly hakt ab
    bench.ha.user_reopen("Milch")  # jemand holt ihn aus „zuletzt gekauft" zurück
    bench.run(after=TWO_MINUTES)
    assert (bench.link("milch")["own"], bench.link("milch")["status"]) == (0, OPEN)
    again = bench.entry("Milch")
    bench.run(after=TWO_MINUTES)
    bench.tick(again)
    bench.run(after=TWO_MINUTES)
    # Er gehört jetzt dem Haushalt: Stowly hakt ihn nicht ab.
    assert len(bench.ha.calls("update_item")) == 1 and bench.ha.find("Milch").status == OPEN


# --- Wieder öffnen -----------------------------------------------------------------------------


@pytest.mark.parametrize("recent", ["back", "new"])
def test_reopening_an_entry_whose_item_is_done_mirrors_it_anew(make_bench, recent):
    bench = make_bench(Behaviour(recent=recent))
    milk = bench.entry("Milch")
    bench.run(after=TWO_MINUTES)
    bench.run(after=TWO_MINUTES)
    bench.tick(milk)
    bench.run(after=10)
    assert bench.ha.find("Milch").status == COMPLETED
    bench.tick(milk, done=False)
    assert bench.item(milk)["bring_key"] is None  # der Artikel ist erledigt: Die Bindung fällt weg
    bench.run(after=60)
    assert len(bench.ha.calls("add_item")) == 1  # zwei Minuten ab dem Wiederöffnen
    bench.run(after=60)
    assert len(bench.ha.calls("add_item")) == 2
    assert bench.item(milk)["bring_key"] == "milch"
    bench.run(after=TWO_MINUTES)
    assert bench.ha.names() == ["Milch"]
    assert bench.item(milk)["done_at"] is None  # der alte erledigte Artikel zählt nicht als abgehakt
    assert bench.ha.names(COMPLETED) == ([] if recent == "back" else ["Milch"])
    bench.ha.user_tick("Milch")
    bench.run(after=TWO_MINUTES)
    assert bench.item(milk)["closed_by"] == "bring"


def test_reopening_while_the_item_is_still_open_keeps_the_binding(bench):
    milk = bench.entry("Milch")
    bench.run(after=TWO_MINUTES)
    bench.tick(milk)
    bench.tick(milk, done=False)
    assert bench.item(milk)["bring_key"] == "milch"
    bench.run(after=10)
    assert bench.ha.calls("update_item") == [] and len(bench.ha.calls("add_item")) == 1


# --- Fehler ------------------------------------------------------------------------------------


def seen_and_deleted(bench: Bench) -> str:
    """Ein gespiegelter, gesehener Eintrag, dessen Artikel jemand in Bring! löscht."""
    milk = bench.entry("Milch")
    bench.run(after=TWO_MINUTES)
    bench.run(after=TWO_MINUTES)
    bench.ha.user_delete("Milch")
    return milk


@pytest.mark.parametrize(
    ("setup", "state", "message"),
    [
        (lambda ha: setattr(ha, "token", "anders"), "unauthorized", "Home Assistant lehnt den Token ab."),
        (
            lambda ha: setattr(ha, "entity", "todo.andere"),
            "not_found",
            "Die Liste todo.einkaufsliste gibt es in Home Assistant nicht.",
        ),
        (
            lambda ha: setattr(ha, "state_override", "unavailable"),
            "unavailable",
            "Die Liste ist in Home Assistant gerade nicht verfügbar.",
        ),
        (
            lambda ha: setattr(ha, "state_override", "unknown"),
            "unavailable",
            "Die Liste ist in Home Assistant gerade nicht verfügbar.",
        ),
        (
            lambda ha: ha.failures.update({"*": httpx2.ConnectError("Connection refused")}),
            "unreachable",
            "Home Assistant ist nicht erreichbar.",
        ),
        (
            lambda ha: ha.failures.update({"*": httpx2.ReadTimeout("zu langsam")}),
            "unreachable",
            "Home Assistant ist nicht erreichbar.",
        ),
        (
            lambda ha: ha.failures.update(
                {"*": httpx2.ConnectError("[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed")}
            ),
            "unreachable",
            "Home Assistant ist nicht erreichbar: Zertifikat nicht vertraut, siehe STOWLY_HA_CA.",
        ),
        (lambda ha: ha.failures.update({"*": 500}), "error", "Home Assistant antwortet mit 500."),
        (lambda ha: ha.failures.update({"*": 503}), "error", "Home Assistant antwortet mit 503."),
        (
            lambda ha: ha.failures.update({"get_items": 400}),
            "error",
            "Home Assistant kennt todo.get_items nicht so (400).",
        ),
        (lambda ha: ha.failures.update({"get_items": 502}), "error", "Home Assistant antwortet mit 502."),
        (lambda ha: ha.failures.update({"get_items": 301}), "error", "Home Assistant antwortet mit 301."),
    ],
)
def test_when_ha_fails_nothing_is_written_and_nothing_counts_as_missing(bench, setup, state, message):
    milk = seen_and_deleted(bench)
    writes = len(bench.ha.writes)
    setup(bench.ha)
    for _ in range(3):
        assert bench.run(after=TWO_MINUTES) is False
    status = bench.worker.status()
    assert (status["state"], status["last_error"], status["last_error_at"]) == (
        state,
        message,
        bench.clock.stamp(),
    )
    assert status["last_ok_at"] is not None  # der letzte Erfolg bleibt
    assert len(bench.ha.writes) == writes
    assert bench.item(milk)["done_at"] is None and bench.link("milch")["misses"] == 0


def test_an_unexpected_answer_is_an_error(bench):
    bench.ha.failures["get_items"] = 200  # 200 ohne service_response
    assert bench.run() is False
    assert (bench.state(), bench.worker.status()["last_error"]) == (
        "error",
        "Home Assistant antwortet unerwartet.",
    )


def test_a_certificate_error_inside_the_connection_is_recognised():
    inner = ssl.SSLCertVerificationError(1, "self-signed certificate in certificate chain")
    outer = httpx2.ConnectError("Verbindung gescheitert")
    outer.__cause__ = inner
    assert bring.untrusted(outer)
    assert not bring.untrusted(httpx2.ConnectError("Connection refused"))


def test_only_a_change_of_state_reaches_the_log_and_never_the_token(bench, caplog):
    caplog.set_level(logging.DEBUG)
    bench.run()
    bench.ha.failures["*"] = 500
    for _ in range(3):
        bench.run(after=TWO_MINUTES)
    bench.ha.failures.clear()
    bench.run(after=TWO_MINUTES)
    bench.run(after=TWO_MINUTES)
    messages = [record.getMessage() for record in caplog.records if record.name == "stowly.ha"]
    assert messages == [
        "Home Assistant: Abgleich mit todo.einkaufsliste läuft.",
        "Home Assistant: Home Assistant antwortet mit 500. (GET /api/states/todo.einkaufsliste: 500)",
        "Home Assistant: Abgleich mit todo.einkaufsliste läuft wieder.",
    ]
    assert TOKEN not in caplog.text
    ours = " ".join(record.getMessage() for record in caplog.records if record.name.startswith("stowly"))
    assert "ha.example" not in ours
    assert TOKEN not in json.dumps(bench.worker.status())


def test_a_failed_write_is_tried_again_and_does_not_stop_the_others(bench):
    milk = bench.entry("Milch")
    bread = bench.entry("Brot")
    bench.ha.failures["add_item"] = 500
    assert bench.run(after=TWO_MINUTES) is False
    assert (bench.state(), bench.worker.status()["last_error"]) == (
        "error",
        "Home Assistant antwortet mit 500.",
    )
    assert bench.ha.attempts("add_item") == 2  # beide versucht
    assert bench.item(milk)["bring_key"] is None and bench.link("milch") is None
    bench.ha.failures.clear()
    assert bench.run(after=TWO_MINUTES) is True
    assert bench.ha.names() == ["Brot", "Milch"]
    assert bench.item(bread)["bring_key"] == "brot"


def test_an_add_whose_answer_got_lost_never_leads_to_a_second_item(make_bench):
    """Kommt auf todo.add_item keine Antwort, gilt der Artikel als angelegt: lieber so als doppelt."""
    bench = make_bench(Behaviour(duplicate="second"))
    milk = bench.entry("Milch")

    real = bench.ha._add_item

    def add_and_lose_the_answer(data):
        real(data)
        raise httpx2.ReadTimeout("Antwort verloren")

    bench.ha._add_item = add_and_lose_the_answer  # type: ignore[method-assign]
    assert bench.run(after=TWO_MINUTES) is False
    assert bench.state() == "unreachable"
    assert bench.item(milk)["bring_key"] == "milch" and bench.link("milch")["own"] == 1
    bench.ha._add_item = real  # type: ignore[method-assign]
    bench.entry("milch")  # noch einer desselben Namens
    bench.run(after=TWO_MINUTES)
    bench.run(after=TWO_MINUTES)
    assert bench.ha.names() == ["Milch"]
    assert bench.link("milch")["seen_at"] is not None


def test_an_add_rejected_with_401_is_not_taken_as_created(bench):
    """Eine Ablehnung ist eine Antwort: Nach 401 auf todo.add_item gilt nichts als angelegt."""
    milk = bench.entry("Milch")
    bench.ha.failures["add_item"] = 401
    assert bench.run(after=TWO_MINUTES) is False
    assert bench.state() == "unauthorized"
    assert bench.item(milk)["bring_key"] is None and bench.link("milch") is None
    bench.ha.failures.clear()
    assert bench.run(after=TWO_MINUTES) is True
    assert bench.ha.names() == ["Milch"]
    assert bench.item(milk)["bring_key"] == "milch"


def test_a_write_to_a_vanished_item_waits_until_it_is_back(bench):
    milk = bench.entry("Milch")
    bench.run(after=TWO_MINUTES)
    bench.run(after=TWO_MINUTES)
    item = bench.ha.find("Milch")
    bench.ha.items.remove(item)  # fehlt einmal (etwa ein Neustart)
    bench.tick(milk)
    bench.run(after=10)
    assert bench.ha.calls("update_item") == []  # nicht in der Liste: noch nichts schreiben
    bench.ha.items.append(item)
    bench.run(after=TWO_MINUTES)
    assert bench.ha.calls("update_item") == [{"entity_id": ENTITY, "item": item.uid, "status": COMPLETED}]


# --- Neustart von HA ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "behaviour",
    [
        Behaviour(restart="unavailable"),
        Behaviour(restart="empty"),
        Behaviour(restart="full"),
        Behaviour(restart="empty", stable_uid=False),
        Behaviour(restart="unavailable", stable_uid=False),
    ],
    ids=lambda behaviour: behaviour.label(),
)
def test_a_restart_of_ha_never_empties_the_list(make_bench, behaviour):
    bench = make_bench(behaviour)
    milk, bread = bench.entry("Milch"), bench.entry("Brot")
    bench.run(after=TWO_MINUTES)
    bench.run(after=TWO_MINUTES)
    bench.ha.restart(runs=1)
    bench.run(after=TWO_MINUTES)
    bench.run(after=TWO_MINUTES)
    bench.run(after=TWO_MINUTES)
    assert bench.open_entries() == 2 and bench.closed_by_bring() == set()
    assert bench.link("milch")["misses"] == 0
    # Neue uids nach dem Neustart: Stowly schreibt mit der aktuellen.
    bench.tick(milk)
    bench.run(after=10)
    assert bench.ha.calls("update_item")[-1] == {
        "entity_id": ENTITY,
        "item": bench.ha.find("Milch").uid,
        "status": COMPLETED,
    }
    assert bench.ha.find("Milch").status == COMPLETED and bench.item(bread)["done_at"] is None


# --- Alle Varianten der Annahmen ---------------------------------------------------------------

VARIANTS = [
    Behaviour(),
    Behaviour(duplicate="update"),
    Behaviour(duplicate="error"),
    Behaviour(recent="new"),
    Behaviour(fold=False),
    Behaviour(completed=False),
    Behaviour(stable_uid=False),
    Behaviour(restart="empty"),
    Behaviour(restart="full"),
    Behaviour(truncate=4),
    Behaviour(delay=1),
    Behaviour(delay=2),
    Behaviour(recent="new", delay=2),
    Behaviour(recent="new", fold=False, stable_uid=False, restart="empty"),
    Behaviour(duplicate="update", recent="new", completed=False, delay=1),
    Behaviour(truncate=4, delay=2, restart="empty", stable_uid=False),
    Behaviour(
        duplicate="error",
        recent="back",
        fold=False,
        completed=False,
        stable_uid=False,
        restart="unavailable",
        delay=1,
    ),
]


def like(ha: FakeHA, name: str):
    """Der Artikel, wie ihn der Anwender in Bring! sieht (vielleicht gekürzt)."""
    key = bring_key(name)
    for item in ha.items:
        if key.startswith(bring_key(item.summary)):
            return item
    return None


def settle(bench: Bench, runs: int = 3) -> None:
    for _ in range(runs):
        bench.run(after=TWO_MINUTES)


@pytest.mark.parametrize("behaviour", VARIANTS, ids=lambda behaviour: behaviour.label())
def test_what_holds_in_every_variant(make_bench, behaviour):
    bench = make_bench(behaviour)
    ha = bench.ha
    ha.user_add("Kaffee")
    milk = bench.entry("Milch")
    bread = bench.entry("Brot")
    coffee = bench.entry("kaffee")
    yoghurt = bench.product("Joghurt", min_stock=1)
    settle(bench)
    assert ha.calls("add_item") and all(call["item"] != "kaffee" for call in ha.calls("add_item"))
    yoghurt_item = like(ha, "Joghurt")
    assert yoghurt_item is not None

    # Jemand hakt die Milch in Bring! ab; Stowly hakt das Brot ab; beim Joghurt reicht der Bestand wieder.
    milk_item = like(ha, "Milch")
    assert milk_item is not None and milk_item.status == OPEN
    milk_item.status = COMPLETED
    ha.actions.append(("tick", "milch"))
    bench.tick(bread)
    bench.store(yoghurt)
    settle(bench)
    # Der automatische Eintrag ist nie „gekauft": Stowly hakt seinen Artikel in Bring! nie ab.
    assert not any(
        write.service == "update_item"
        and write.data.get("status") == COMPLETED
        and write.target is yoghurt_item
        for write in ha.writes
    )

    # Ein Neustart von HA leert die Liste von Stowly nicht.
    before = bench.open_entries()
    ha.restart(runs=1)
    settle(bench)
    assert bench.open_entries() == before

    # Wieder öffnen und ein neuer Eintrag mit dem Namen des abgehakten Artikels.
    bench.tick(bread, done=False)
    again = bench.entry("Milch")
    settle(bench)

    # Der fremde Kaffee wird in Bring! gelöscht.
    ha.user_delete("Kaffee")
    settle(bench)

    # Eingekauft ist nur, was in Bring! geschah: Kaffee (gelöscht) und, wenn Stowly sie sieht, die Milch.
    assert bench.item(coffee)["closed_by"] == "bring"
    seen_by_name = behaviour.truncate is None
    assert bench.item(milk)["closed_by"] == ("bring" if seen_by_name else None)
    assert bench.closed_by_bring() <= {"kaffee", "milch"}
    for item_id in (bread, again):
        row = bench.item(item_id)
        assert (row["done_at"], row["closed_by"]) == (None, None), row
    if seen_by_name:
        assert bench.item(again)["bring_key"] == "milch"
        assert like(ha, "Milch") is not None and any(
            item.status == OPEN for item in ha.items if item.summary == "Milch"
        )


# --- Zeitpunkte --------------------------------------------------------------------------------


def test_the_next_entry_is_due_two_minutes_after_its_last_opening(bench):
    assert bench.worker.seconds_until_ready() is None
    milk = bench.entry("Milch")
    assert bench.worker.seconds_until_ready() == pytest.approx(120)
    bench.clock.advance(30)
    assert bench.worker.seconds_until_ready() == pytest.approx(90)
    bench.clock.advance(100)
    assert bench.worker.seconds_until_ready() is None  # fällig: das übernimmt der nächste Lauf
    bench.tick(milk)
    bench.clock.advance(10)
    bench.tick(milk, done=False)
    assert bench.worker.seconds_until_ready() == pytest.approx(120)


def test_the_loop_runs_at_start_and_after_a_change(settings, monkeypatch):
    """Im Betrieb: ein Lauf beim Start, dann frühestens SETTLE_S nach einer Änderung der Einkaufsliste."""
    monkeypatch.setattr(bring, "SETTLE_S", 0.2)
    ha = FakeHA()
    configured = dataclasses.replace(settings, ha_url=BASE, ha_token=TOKEN, ha_todo_entity=ENTITY)
    app = create_app(configured, ha_transport=httpx2.MockTransport(ha))
    with TestClient(app) as client:
        device = Device(client, "Handy")
        device.sync()

        def wait_for(count: int) -> None:
            for _ in range(400):
                if len(ha.requests) >= count:
                    return
                time.sleep(0.01)
            raise AssertionError(f"nur {len(ha.requests)} Aufrufe")

        wait_for(2)  # beim Start: Zustand und Liste
        assert app.state.bring.status()["state"] == "ok"
        response = client.get("/api/integrations", headers=device.headers)
        IntegrationStatus.model_validate(response.json())
        ha_status = response.json()["ha"]
        assert (ha_status["state"], ha_status["last_error"], ha_status["linked"]) == ("ok", None, 0)
        assert ha_status["last_ok_at"] is not None
        assert TOKEN not in response.text and "ha.example" not in response.text
        started = time.monotonic()
        device.sync([device.cmd("shopping_item.create", item_id=ids.new_uuid(), text="Milch")])
        wait_for(4)
        assert time.monotonic() - started >= 0.15
        # Ein Sync, der die Einkaufsliste nicht ändert, weckt den Abgleich nicht.
        device.sync()
        time.sleep(0.4)
        assert len(ha.requests) == 4
    assert app.state.bring is None


def test_without_ha_the_state_is_off_and_pending_before_the_first_run(settings):
    from stowly import integrations

    with TestClient(create_app(settings)) as client:
        device = Device(client, "Handy")
        assert client.get("/api/integrations", headers=device.headers).json()["ha"]["state"] == "off"
    configured = dataclasses.replace(settings, ha_url=BASE, ha_token=TOKEN, ha_todo_entity=ENTITY)
    con = db.connect(settings.database_path)
    try:
        assert integrations.ha_status(configured, con, None)["state"] == "pending"
    finally:
        con.close()


def test_the_state_of_the_sync_reaches_the_app(bench):
    """``HaStatus`` aus dem Abgleich: Zustand, letzter Erfolg, letzter Fehler, gebundene offene Einträge."""
    bench.client.app.state.bring = bench.worker  # wie im lifespan

    def ha_state() -> dict:
        response = bench.client.get("/api/integrations", headers=bench.device.headers)
        IntegrationStatus.model_validate(response.json())
        assert TOKEN not in response.text and "ha.example" not in response.text
        return response.json()["ha"]

    assert ha_state()["state"] == "pending"
    milk = bench.entry("Milch")
    bench.entry("Brot")
    bench.run(after=TWO_MINUTES)
    ok_at = bench.clock.stamp()
    assert ha_state() == {
        "configured": True,
        "problem": None,
        "entity": ENTITY,
        "state": "ok",
        "last_ok_at": ok_at,
        "last_error": None,
        "last_error_at": None,
        "linked": 2,
        "sensor": False,
    }
    bench.tick(milk)
    bench.ha.token = "anders"
    bench.run(after=TWO_MINUTES)
    state = ha_state()
    assert (
        state["state"],
        state["last_ok_at"],
        state["last_error"],
        state["last_error_at"],
        state["linked"],
    ) == (
        "unauthorized",
        ok_at,
        "Home Assistant lehnt den Token ab.",
        bench.clock.stamp(),
        1,
    )


def test_a_slow_ha_is_given_up_after_the_time_limit(settings, clock, monkeypatch):
    """Höchstens 10 Sekunden je Aufruf; der Test kürzt die Grenze, statt so lange zu warten."""
    assert bring.TIMEOUT_S == 10.0
    monkeypatch.setattr(bring, "TIMEOUT_S", 0.2)

    async def slow(request: httpx2.Request) -> httpx2.Response:
        await asyncio.sleep(5)
        return httpx2.Response(200, json={"state": "0"})

    configured = dataclasses.replace(settings, ha_url=BASE, ha_token=TOKEN, ha_todo_entity=ENTITY)
    worker = bring.BringSync(configured, transport=httpx2.MockTransport(slow), clock=FollowClock(clock))

    async def scenario() -> bool:
        try:
            return await worker.run_once()
        finally:
            await worker.aclose()

    create_app(configured)  # legt die Datenbank an
    started = time.monotonic()
    assert asyncio.run(scenario()) is False
    assert time.monotonic() - started < 3
    assert (worker.status()["state"], worker.status()["last_error"]) == (
        "unreachable",
        "Home Assistant ist nicht erreichbar.",
    )


# --- Bausteine ---------------------------------------------------------------------------------


def test_names_and_descriptions_for_bring():
    assert bring.mirror_name(None, None, "  Brot ") == "Brot"
    assert bring.mirror_name("p", " Hafermilch ", "") == "Hafermilch"
    assert bring.mirror_name("p", "   ", "") is None  # Platzhalter ohne Namen
    assert bring.mirror_name("p", None, "") is None
    assert bring.description("min_stock", 2) == "fehlt 2 · Stowly"
    assert bring.description("manual", 3) == "3× · Stowly"
    assert bring.description("manual", None) == "Stowly"
    assert bring_key("  Bio  Milch ") == "bio milch"


def test_odd_answers_of_get_items():
    good = {"summary": "Milch", "uid": "u1", "status": "needs_action", "description": "Stowly"}
    payload = {
        "service_response": {
            ENTITY: {
                "items": [
                    good,
                    {"summary": "Brot", "uid": "", "status": "completed"},
                    {"summary": "Quark", "status": "irgendwas"},
                    {"summary": 7, "status": "needs_action"},
                    "kein Objekt",
                ]
            }
        }
    }
    assert bring.parse_items(payload, ENTITY) == [
        bring.Item("u1", "Milch", "needs_action", "Stowly"),
        bring.Item(None, "Brot", "completed", None),
    ]
    for broken in (None, [], {"service_response": {}}, {"service_response": {ENTITY: {"items": "x"}}}):
        assert bring.parse_items(broken, ENTITY) is None
    listing = bring.Listing(
        [
            bring.Item("a", "Milch", "completed"),
            bring.Item("b", "milch ", "needs_action"),
            bring.Item("c", " ", "needs_action"),
        ]
    )
    assert listing.open("milch") == bring.Item("b", "milch ", "needs_action")
    assert [item.uid for item in listing.completed("milch")] == ["a"]
    assert listing.open("") is None
