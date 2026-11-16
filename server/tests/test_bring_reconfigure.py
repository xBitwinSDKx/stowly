"""Der Abgleich mit Bring! übernimmt eine geänderte Einrichtung ohne Neustart (stowly/bring.py,
``BringSync.reconfigure``; docs/plan-einrichtung-b.md, 3).

* Mit laufendem Server (lifespan, echte Uhr): Einrichten in der App wirkt sofort, Entfernen stoppt jede
  Anfrage, ein neuer Token gilt ab der nächsten Anfrage.
* Von Hand getrieben (``run_once``, angehaltene Serveruhr): Listenwechsel ohne falsch Abgehaktes, eine
  Änderung mitten in einem Lauf, der Merker ``ha_links_entity`` beim ersten Start nach dem Update und ein
  Wechsel zwischen Umgebung und App über einen Neustart.
"""

import asyncio
import dataclasses
import logging
import time
from collections.abc import Callable
from datetime import UTC, datetime

import httpx2
import pytest
from fastapi.testclient import TestClient
from ha_fake import BASE, ENTITY, TOKEN, FakeHA, violations
from support import Device, ServerClock, events_of

from stowly import bring, db, haconfig, off, serverconfig
from stowly.app import create_app
from stowly.config import Settings
from stowly.contract import ids, timeutil
from stowly.contract.api import HaConfigChanges

START = datetime(2026, 11, 16, 9, 0, tzinfo=UTC)
TWO_MINUTES = 120
OTHER = "todo.zuhause"


def wait_until(condition: Callable[[], bool], what: str, seconds: float = 4.0) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if condition():
            return
        time.sleep(0.01)
    raise AssertionError(f"nicht eingetreten: {what}")


# --- Mit laufendem Server ----------------------------------------------------------------------


@pytest.fixture
def live(settings, monkeypatch):
    """Server mit lifespan und nachgebildetem HA, noch ohne Einrichtung."""
    monkeypatch.setattr(bring, "SETTLE_S", 0.1)
    home = FakeHA()
    app = create_app(settings, ha_transport=httpx2.MockTransport(home))
    with TestClient(app) as client:
        yield client, Device(client, "Handy"), home


def ha_state(client: TestClient, device: Device) -> dict:
    return client.get("/api/integrations", headers=device.headers).json()["ha"]


def configure(client: TestClient, device: Device, **body) -> dict:
    response = client.patch("/api/server-config/ha", json=body, headers=device.headers)
    assert response.status_code == 200, response.text
    return response.json()


def test_a_setup_in_the_app_works_without_a_restart(live):
    client, device, home = live
    device.sync()
    time.sleep(0.2)
    assert home.requests == []
    assert (ha_state(client, device)["state"], client.app.state.bring.status()["state"]) == ("off", "off")

    configure(client, device, url=BASE, token=TOKEN, entity=ENTITY)
    wait_until(lambda: ha_state(client, device)["state"] == "ok", "Abgleich ok")
    status = ha_state(client, device)
    assert (status["configured"], status["entity"], status["problem"]) == (True, ENTITY, None)
    assert [request.url.path for request in home.requests[:2]] == [
        f"/api/states/{ENTITY}",
        "/api/services/todo/get_items",
    ]
    # Danach wirkt eine Änderung der Einkaufsliste wie immer.
    seen = len(home.requests)
    device.sync([device.cmd("shopping_item.create", item_id=ids.new_uuid(), text="Milch")])
    wait_until(lambda: len(home.requests) >= seen + 2, "Lauf nach einer Änderung")


def test_removing_the_address_stops_every_request(live):
    client, device, home = live
    configure(client, device, url=BASE, token=TOKEN, entity=ENTITY)
    wait_until(lambda: ha_state(client, device)["state"] == "ok", "Abgleich ok")

    configure(client, device, url=None)
    wait_until(lambda: client.app.state.bring.status()["state"] == "off", "Abgleich aus")
    status = ha_state(client, device)
    assert (status["configured"], status["state"], status["problem"]) == (
        False,
        "off",
        "Für Home Assistant fehlen noch die Adresse und der Token.",
    )
    asked = len(home.requests)
    device.sync([device.cmd("shopping_item.create", item_id=ids.new_uuid(), text="Brot")])
    time.sleep(0.4)
    assert len(home.requests) == asked


def test_a_new_token_is_used_from_the_next_request_on(live):
    client, device, home = live
    configure(client, device, url=BASE, token=TOKEN, entity=ENTITY)
    wait_until(lambda: ha_state(client, device)["state"] == "ok", "Abgleich ok")

    renewed = TOKEN + "-neu"
    home.token = renewed  # HA kennt nur noch den neuen
    configure(client, device, token=renewed)
    wait_until(
        lambda: ha_state(client, device)["state"] == "ok" and home.reads >= 2, "Abgleich mit neuem Token"
    )
    last = home.requests[-1]
    assert last.headers["authorization"] == f"Bearer {renewed}"
    # Ein falscher Token zeigt sich gleich im Zustand, ohne Neustart.
    configure(client, device, token="falsch")
    wait_until(lambda: ha_state(client, device)["state"] == "unauthorized", "abgelehnt")
    assert ha_state(client, device)["last_error"] == "Home Assistant lehnt den Token ab."


# --- Von Hand getrieben ------------------------------------------------------------------------


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

    def run(self, after: float = 0.0) -> bool:
        self.clock.advance(after)
        ok = asyncio.run(self.worker.run_once())
        assert violations(self.ha) == [], violations(self.ha)
        return ok

    def configure(self, **changes) -> list[str]:
        con = db.connect(self.settings.database_path)
        try:
            return haconfig.change(
                self.settings,
                con,
                self.client.app.state.secrets,
                HaConfigChanges(**changes),
                device_id=self.device.id,
                now=timeutil.now(),
            )
        finally:
            con.close()

    def entry(self, text: str) -> str:
        item_id = ids.new_uuid()
        self.device.sync([self.device.cmd("shopping_item.create", item_id=item_id, text=text)])
        return item_id

    def query(self, sql: str, *parameters) -> list[dict]:
        con = db.connect(self.settings.database_path)
        try:
            return [dict(row) for row in con.execute(sql, parameters)]
        finally:
            con.close()

    def item(self, item_id: str) -> dict:
        (row,) = self.query("SELECT * FROM shopping_items WHERE id = ?", item_id)
        return row

    def links(self) -> list[str]:
        return [row["name_key"] for row in self.query("SELECT name_key FROM ha_links ORDER BY name_key")]

    def marker(self) -> object:
        con = db.connect(self.settings.database_path)
        try:
            return serverconfig.get(con, haconfig.LINKS_ENTITY)
        finally:
            con.close()

    def bought(self) -> list[dict]:
        return [e for e in events_of(self.client, self.device) if e["type"] == "shopping_item.bring_done"]


@pytest.fixture
def make_bench(settings, clock):
    created: list[bring.BringSync] = []

    def factory(home: FakeHA | None = None, **overrides) -> Bench:
        configured = dataclasses.replace(settings, **overrides)
        if not created:
            clock.value = START  # ein zweiter Server (Neustart) läuft mit derselben Uhr weiter
        client = TestClient(create_app(configured))  # ohne lifespan: den Abgleich treibt der Test
        home = home or FakeHA()
        if OTHER not in home.others:
            home.add_list(OTHER, "Zuhause")
        worker = bring.BringSync(
            configured,
            client.app.state.secrets,
            transport=httpx2.MockTransport(home),
            clock=FollowClock(clock),
        )
        created.append(worker)
        device = Device(client, "Handy", clock=clock)
        device.sync()
        return Bench(configured, client, clock, device, home, worker)

    yield factory
    for worker in created:
        asyncio.run(worker.aclose())


def test_without_a_setup_no_request_is_made(make_bench):
    bench = make_bench()
    assert bench.run() is False
    assert bench.worker.status()["state"] == "off" and bench.ha.requests == []
    bench.configure(url=BASE, entity=ENTITY)  # ohne Token: noch nicht eingerichtet
    assert bench.run() is False and bench.ha.requests == []


def test_a_new_list_mirrors_anew_and_ticks_nothing(make_bench, caplog):
    caplog.set_level(logging.INFO, logger="stowly.ha")
    bench = make_bench()
    bench.configure(url=BASE, token=TOKEN, entity=ENTITY)
    milk, bread = bench.entry("Milch"), bench.entry("Brot")
    assert bench.run(after=TWO_MINUTES) is True
    bench.run(after=TWO_MINUTES)  # gesehen
    assert bench.ha.names() == ["Brot", "Milch"] and bench.links() == ["brot", "milch"]
    assert bench.marker() == ENTITY

    assert bench.configure(entity=OTHER) == ["ha_todo_entity"]
    assert bench.run() is True
    # Nichts ist abgehakt; die Einträge gehen neu in die neue Liste, in der alten bleiben sie stehen.
    assert bench.bought() == []
    assert (bench.item(milk)["done_at"], bench.item(bread)["done_at"]) == (None, None)
    assert bench.ha.names(entity=OTHER) == ["Brot", "Milch"]
    assert bench.ha.names() == ["Brot", "Milch"]
    assert [call["entity_id"] for call in bench.ha.calls("add_item")] == [ENTITY, ENTITY, OTHER, OTHER]
    assert bench.marker() == OTHER
    assert (bench.item(milk)["bring_key"], bench.item(bread)["bring_key"]) == ("milch", "brot")
    assert any("Liste gewechselt" in record.getMessage() for record in caplog.records)

    # Weitere Läufe haken nichts ab, auch nicht, wenn die alte Liste die Artikel verliert.
    bench.ha.user_delete("Milch")
    for _ in range(3):
        bench.run(after=TWO_MINUTES)
    assert bench.bought() == [] and bench.item(milk)["done_at"] is None
    # In der neuen Liste abgehakt: eingekauft.
    bench.ha.user_tick("Milch", entity=OTHER)
    bench.run(after=TWO_MINUTES)
    assert bench.item(milk)["closed_by"] == "bring"
    assert [event["entity_id"] for event in bench.bought()] == [milk]


def test_a_change_during_a_run_stops_it_after_the_current_request(make_bench):
    home = FakeHA()
    bench = make_bench(home)
    bench.configure(url=BASE, token=TOKEN, entity=ENTITY)
    for name in ("Brot", "Milch", "Quark"):
        bench.entry(name)
        bench.clock.advance(1)  # feste Reihenfolge der Artikel
    bench.clock.advance(TWO_MINUTES)

    real = home._add_item

    def add_and_change_meanwhile(data):
        answer = real(data)
        if len(home.calls("add_item")) == 1:
            # Während diese Anfrage läuft, speichert jemand eine andere Liste (PATCH /api/server-config/ha).
            bench.configure(entity=OTHER)
            bench.worker.reconfigure()
        return answer

    home._add_item = add_and_change_meanwhile  # type: ignore[method-assign]
    assert bench.run() is False  # unterbrochen, kein Fehler
    assert bench.worker.status()["state"] == "pending"
    assert [call["item"] for call in home.calls("add_item")] == ["Brot"]  # danach keine Anfrage mehr
    # Der nächste Lauf gilt der neuen Liste.
    assert bench.run() is True
    assert home.names(entity=OTHER) == ["Brot", "Milch", "Quark"]
    assert home.names() == ["Brot"]
    assert bench.bought() == []


def test_the_first_run_after_the_update_only_sets_the_marker(make_bench):
    env = {"ha_url": BASE, "ha_token": TOKEN, "ha_todo_entity": ENTITY}
    bench = make_bench(**env)
    milk = bench.entry("Milch")
    bench.run(after=TWO_MINUTES)
    bench.run(after=TWO_MINUTES)
    # Ein Stand von vor dem Update: Artikel gebunden, aber kein Merker.
    con = db.connect(bench.settings.database_path)
    try:
        with db.transaction(con):
            serverconfig.delete(con, haconfig.LINKS_ENTITY)
        before = [dict(row) for row in con.execute("SELECT * FROM ha_links")]
    finally:
        con.close()
    writes = len(bench.ha.writes)
    assert bench.run(after=TWO_MINUTES) is True
    assert bench.marker() == ENTITY
    assert bench.query("SELECT * FROM ha_links") == [
        {**row, "seen_at": bench.clock.stamp()} for row in before
    ]
    assert bench.item(milk)["bring_key"] == "milch" and len(bench.ha.writes) == writes


def test_a_change_between_environment_and_app_counts_like_a_new_list(make_bench, settings):
    # Erst aus der App mit der Einkaufsliste …
    home = FakeHA()
    bench = make_bench(home)
    bench.configure(url=BASE, token=TOKEN, entity=ENTITY)
    milk = bench.entry("Milch")
    bench.run(after=TWO_MINUTES)
    bench.run(after=TWO_MINUTES)
    assert home.names() == ["Milch"] and bench.marker() == ENTITY

    # … dann ein Neustart mit der Umgebung, die eine andere Liste nennt: Sie geht vor.
    env = make_bench(home, ha_url=BASE, ha_token=TOKEN, ha_todo_entity=OTHER)
    assert env.run() is True
    assert home.names(entity=OTHER) == ["Milch"] and env.marker() == OTHER
    assert env.bought() == [] and env.item(milk)["done_at"] is None

    # … und zurück ohne Umgebung: wieder die Liste aus der App, an den noch offenen Artikel gebunden.
    back = make_bench(home)
    assert back.run() is True
    assert back.marker() == ENTITY
    assert home.names() == ["Milch"] and len(home.calls("add_item", entity=ENTITY)) == 1
    assert back.item(milk)["bring_key"] == "milch"
    assert back.bought() == []
