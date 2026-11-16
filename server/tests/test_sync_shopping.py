"""Einkaufsliste: Befehle, Uhren, Echo, Ereignisse, Aufbewahrung (docs/sync-protokoll.md, 3.6, 6.4, 6.6, 7.6).

Die automatischen Einträge prüfen vor allem die gemeinsamen Fälle (``test_shopping_auto.py``); hier
steht, was die Fälle nicht abdecken: Ablehnungen, die Uhren je Feld, das Echo, die Ereignisse, die
Sperre außerhalb des Sync und die Aufbewahrung im vollständigen Abzug.
"""

import pytest
from support import Device, events_of, statuses

from stowly import shopping
from stowly.contract import ids
from stowly.sync import changes

DAY = 86400


def item_cmd(device: Device, *, age: float = 0.0, item_id: str | None = None, **payload) -> tuple[str, dict]:
    """``shopping_item.create``; liefert ``(item_id, befehl)``."""
    item_id = item_id or ids.new_uuid()
    return item_id, device.cmd("shopping_item.create", age=age, item_id=item_id, **payload)


def update(device: Device, item_id: str, *, age: float = 0.0, **changes) -> dict:
    return device.cmd("shopping_item.update", age=age, item_id=item_id, changes=changes)


def delete(device: Device, item_id: str, *, age: float = 0.0) -> dict:
    return device.cmd("shopping_item.delete", age=age, item_id=item_id)


def item_events(device: Device, item_id: str) -> list[tuple[str, dict]]:
    events = events_of(device.client, device, entity="shopping_item", entity_id=item_id)
    return [(event["type"], event["data"]) for event in events]


def auto_items(device: Device, product_id: str) -> list[dict]:
    """Die automatischen Einträge eines Produkts, wie das Gerät sie kennt, älteste zuerst."""
    found = [
        item
        for item in device.shopping_items.values()
        if item["product_id"] == product_id and item["origin"] == "min_stock"
    ]
    return sorted(found, key=lambda item: (item["created_at"], item["id"]))


def rev_of(con, item_id: str) -> int:
    return con.execute("SELECT rev FROM shopping_items WHERE id = ?", (item_id,)).fetchone()[0]


# --- Anlegen ---------------------------------------------------------------------------------


def test_own_entries_with_a_product_or_a_text(make_device, clock):
    device = make_device()
    product_id, create_product = device.product("Butter", age=40)
    with_product, create_first = item_cmd(device, age=30, product_id=product_id, quantity=2)
    with_text, create_second = item_cmd(device, age=20, text="Grillkohle")
    data = device.sync([create_product, create_first, create_second])
    assert statuses(data) == [("applied", None)] * 3
    # Was die Befehle anlegen, steht schon in der Antwort.
    assert {item["id"] for item in data["changes"]["shopping_items"]} == {with_product, with_text}

    first = device.shopping_items[with_product]
    assert first == {
        "id": with_product,
        "product_id": product_id,
        "text": "",
        "quantity": 2,
        "origin": "manual",
        "done_at": None,
        "deleted_at": None,
        "created_at": clock.stamp(30),
        "updated_at": clock.stamp(30),
    }
    second = device.shopping_items[with_text]
    assert (second["product_id"], second["text"], second["quantity"]) == (None, "Grillkohle", None)
    assert item_events(device, with_product) == [
        ("shopping_item.created", {"product_id": product_id, "text": "", "quantity": 2})
    ]


def test_creating_is_rejected_like_the_catalogue_says(make_device):
    device = make_device()
    product_id, create_product = device.product("Butter")
    taken, create = item_cmd(device, text="Milch")
    data = device.sync(
        [
            create_product,
            create,
            # Dieselbe Kennung mit einem neuen Befehl: id_conflict, der erste Eintrag bleibt.
            item_cmd(device, item_id=taken, text="Kaffee")[1],
            item_cmd(device, product_id=ids.new_uuid())[1],  # das Produkt gab es nie
            item_cmd(device)[1],  # weder Produkt noch Text
            item_cmd(device, product_id=product_id, text="Butter")[1],  # beides
            item_cmd(device, text="Milch", quantity=0)[1],
            item_cmd(device, text="Milch", quantity=1000)[1],
            item_cmd(device, text="x" * 121)[1],
            item_cmd(device, text="Milch", origin="min_stock")[1],  # origin setzt nur der Server
        ]
    )
    assert statuses(data) == [
        ("applied", None),
        ("applied", None),
        ("rejected", "id_conflict"),
        ("rejected", "not_found"),
        *[("rejected", "invalid")] * 6,
    ]
    assert data["results"][3]["message"] == "Das Produkt gibt es nicht."
    assert device.shopping_items[taken]["text"] == "Milch"
    assert len(device.shopping_items) == 1
    rejected = [e for e in events_of(device.client, device) if e["type"] == "command.rejected"]
    assert rejected[0]["entity"] == "shopping_item" and rejected[0]["entity_id"] == taken


def test_an_entry_follows_the_merged_product_and_stays_open_with_stock(make_device):
    """Ein Produkt im Bestand erledigt einen neuen Eintrag nicht sofort; das tut erst ein Einlagern danach."""
    device = make_device()
    source, create_source = device.product("Vollmilch")
    target, create_target = device.product("Milch")
    _package, store = device.package(target)
    device.sync([create_source, create_target, store])
    device.sync([device.cmd("product.merge", source_id=source, target_id=target)])

    item_id, create = item_cmd(device, product_id=source)
    device.sync([create])
    item = device.shopping_items[item_id]
    assert item["product_id"] == target
    assert item["done_at"] is None


# --- Ändern ----------------------------------------------------------------------------------


def test_update_checks_in_the_order_of_the_contract(make_device, con):
    device = make_device()
    product_id, create_product = device.product("Milch", min_stock=1)
    with_product, create_first = item_cmd(device, product_id=product_id)
    with_text, create_second = item_cmd(device, text="Kaffee")
    gone, create_gone = item_cmd(device, product_id=product_id)
    device.sync([create_product, create_first, create_second, create_gone, delete(device, gone)])
    (auto,) = auto_items(device, product_id)

    data = device.sync(
        [
            update(device, ids.new_uuid(), done=True),  # unbekannt
            update(device, gone, text="Neu"),  # gelöscht geht vor invalid: ohne Wirkung
            update(device, with_product, text="Neu"),  # Text bei einem Eintrag mit Produkt
            update(device, auto["id"], quantity=5),  # Menge bei einem automatischen
            update(device, auto["id"], quantity=5, done=True),  # der ganze Befehl gilt nicht
            update(device, with_text, text="Kaffee, gemahlen", quantity=2),
            update(device, with_product, quantity=3),
        ]
    )
    assert statuses(data) == [
        ("rejected", "not_found"),
        ("applied", None),
        ("rejected", "invalid"),
        ("rejected", "invalid"),
        ("rejected", "invalid"),
        ("applied", None),
        ("applied", None),
    ]
    assert device.shopping_items[auto["id"]]["done_at"] is None
    assert device.shopping_items[auto["id"]]["quantity"] == 1
    assert (device.shopping_items[with_text]["text"], device.shopping_items[with_text]["quantity"]) == (
        "Kaffee, gemahlen",
        2,
    )
    assert device.shopping_items[with_product]["quantity"] == 3
    assert device.shopping_items[gone]["text"] == ""
    # Ein abgelehnter Befehl stellt keine Uhr.
    clocks = con.execute(
        "SELECT entity_id, field FROM field_clocks WHERE entity = 'shopping_item' ORDER BY entity_id, field"
    ).fetchall()
    assert {(row["entity_id"], row["field"]) for row in clocks} == {
        (with_text, "text"),
        (with_text, "quantity"),
        (with_product, "quantity"),
    }


def test_fields_follow_the_later_timestamp(make_device, clock):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    item_id, create = item_cmd(phone, text="Milch")
    phone.sync([create])
    tablet.sync()
    clock.advance(3600)

    newer = update(tablet, item_id, age=5, text="Hafermilch")
    older = update(phone, item_id, age=60, text="Vollmilch", quantity=2)
    tablet.sync([newer])
    phone.sync([older])

    item = phone.shopping_items[item_id]
    assert (item["text"], item["quantity"]) == ("Hafermilch", 2)
    assert item["updated_at"] == clock.stamp(5)
    assert item_events(phone, item_id)[1:] == [
        (
            "shopping_item.updated",
            {"changes": {"text": {"old": "Milch", "new": "Hafermilch"}}, "superseded": {}},
        ),
        (
            "shopping_item.updated",
            {"changes": {"quantity": {"old": None, "new": 2}}, "superseded": {"text": "Vollmilch"}},
        ),
    ]
    # null entfernt die Menge.
    phone.sync([update(phone, item_id, quantity=None)])
    assert phone.shopping_items[item_id]["quantity"] is None


def test_done_and_reopen_have_one_clock(make_device, clock):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    item_id, create = item_cmd(phone, text="Milch")
    phone.sync([create])
    clock.advance(3600)

    data = phone.sync([update(phone, item_id, age=30, done=True)])
    assert phone.shopping_items[item_id]["done_at"] == clock.stamp(30)
    # Noch einmal abhaken lässt done_at, wie es ist, stellt aber die Uhr ...
    phone.sync([update(phone, item_id, age=10, done=True)])
    assert phone.shopping_items[item_id]["done_at"] == clock.stamp(30)
    # ... so verliert ein Wiederöffnen, das davor geschah, auch wenn es erst jetzt eintrifft.
    data = tablet.sync([update(tablet, item_id, age=20, done=False)])
    assert statuses(data) == [("applied", None)]
    assert tablet.shopping_items[item_id]["done_at"] == clock.stamp(30)

    tablet.sync([update(tablet, item_id, age=5, done=False)])
    item = tablet.shopping_items[item_id]
    assert item["done_at"] is None
    assert item["updated_at"] == clock.stamp(5)
    assert [entry for entry in item_events(tablet, item_id) if entry[0] == "shopping_item.updated"] == [
        ("shopping_item.updated", {"changes": {"done": {"old": False, "new": True}}, "superseded": {}}),
        ("shopping_item.updated", {"changes": {}, "superseded": {"done": False}}),
        ("shopping_item.updated", {"changes": {"done": {"old": True, "new": False}}, "superseded": {}}),
    ]


def test_closed_by_follows_the_entry(make_device, con):
    """Nicht im Sync: wodurch ein Eintrag geschlossen wurde (für Bring!, docs/integrationen.md 5.4)."""
    device = make_device()
    product_id, create_product = device.product("Butter")
    ticked, create_ticked = item_cmd(device, text="Kaffee")
    stored, create_stored = item_cmd(device, product_id=product_id)
    removed, create_removed = item_cmd(device, text="Tee")
    _package, store = device.package(product_id)
    device.sync([create_product, create_ticked, create_stored, create_removed])
    device.sync([update(device, ticked, done=True), store, delete(device, removed)])

    def closed_by(item_id: str) -> str | None:
        return con.execute("SELECT closed_by FROM shopping_items WHERE id = ?", (item_id,)).fetchone()[0]

    assert (closed_by(ticked), closed_by(stored), closed_by(removed)) == ("device", "store", "device")
    device.sync([update(device, ticked, done=False)])
    assert closed_by(ticked) is None
    # Ein erledigter Eintrag, der danach gelöscht wird, bleibt geschlossen wie zuvor.
    device.sync([delete(device, stored)])
    assert closed_by(stored) == "store"
    record = device.shopping_items[stored]
    assert "closed_by" not in record and "bring_key" not in record


# --- Löschen ---------------------------------------------------------------------------------


def test_delete_always_wins(make_device, clock):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    item_id, create = item_cmd(phone, text="Milch")
    phone.sync([create])
    tablet.sync()
    clock.advance(3600)

    phone.sync([delete(phone, item_id, age=60)])
    assert phone.shopping_items[item_id]["deleted_at"] == clock.stamp(60)
    # Ein späterer Zeitpunkt ändert nichts mehr: weder Text noch Wiederöffnen.
    data = tablet.sync([update(tablet, item_id, age=5, text="Hafermilch", done=True)])
    assert statuses(data) == [("applied", None)]
    item = tablet.shopping_items[item_id]
    assert (item["text"], item["done_at"], item["deleted_at"]) == ("Milch", None, clock.stamp(60))
    data = tablet.sync([delete(tablet, item_id, age=1)])
    assert statuses(data) == [("applied", None)]
    assert tablet.shopping_items[item_id]["deleted_at"] == clock.stamp(60)
    assert item_events(tablet, item_id) == [
        ("shopping_item.created", {"product_id": None, "text": "Milch", "quantity": None}),
        ("shopping_item.deleted", {"origin": "manual", "product_id": None}),
    ]
    assert statuses(tablet.sync([delete(tablet, ids.new_uuid())])) == [("rejected", "not_found")]


# --- Echo ------------------------------------------------------------------------------------


def test_every_applied_command_echoes_the_entry(make_device, con):
    """Auch ohne Wirkung bekommt der Eintrag einen neuen rev und kommt in derselben Antwort."""
    phone, tablet = make_device("Handy"), make_device("Tablet")
    item_id, create = item_cmd(phone, text="Milch")
    phone.sync([create, update(phone, item_id, text="Hafermilch")])
    tablet.sync()

    for command in (
        update(tablet, item_id, age=3600, text="verloren"),  # verliert gegen die Uhr
        update(tablet, item_id, done=False),  # schon offen
        update(tablet, item_id),  # ohne Felder
        delete(tablet, item_id),
        delete(tablet, item_id),  # schon gelöscht
        update(tablet, item_id, done=True),  # gelöscht: ohne Wirkung
    ):
        before = rev_of(con, item_id)
        data = tablet.sync([command])
        assert statuses(data) == [("applied", None)]
        assert rev_of(con, item_id) > before
        assert [item["id"] for item in data["changes"]["shopping_items"]] == [item_id]
    # Ohne Wirkung: kein Eintrag im Ereignisprotokoll (außer der unterlegenen Änderung und dem Löschen).
    assert [entry[0] for entry in item_events(tablet, item_id)] == [
        "shopping_item.created",
        "shopping_item.updated",
        "shopping_item.updated",
        "shopping_item.deleted",
    ]


# --- Automatische Einträge: Ereignisse, Sperre, Antwort ---------------------------------------


def test_what_the_server_writes_itself_has_its_own_events_without_device(make_device):
    device = make_device()
    product_id, create = device.product("Milch", min_stock=2)
    first, store_first = device.package(product_id)
    second, store_second = device.package(product_id)
    manual, create_manual = item_cmd(device, product_id=product_id)
    device.sync([create, create_manual])
    (auto,) = auto_items(device, product_id)
    device.sync([store_first])
    device.sync([store_second])

    remove = device.cmd("package.remove", package_id=first, reason="consumed")
    device.sync([remove])
    (again,) = [item for item in auto_items(device, product_id) if item["deleted_at"] is None]
    tick = update(device, again["id"], done=True)
    device.sync([tick])
    restore = device.cmd("package.restore", package_id=first)
    third, store_third = device.package(product_id)
    device.sync([restore, store_third])

    log = events_of(device.client, device)
    own = [event for event in log if event["device_id"] is None and event["entity"] != "server"]
    assert [(event["type"], event["entity"]) for event in own] == [
        ("shopping_item.auto_created", "shopping_item"),  # product.create mit Mindestbestand
        ("shopping_item.store_done", "shopping_item"),  # erstes Einlagern: der eigene Eintrag ist erledigt
        ("shopping_item.auto_quantity", "shopping_item"),  # ... und es fehlt nur noch 1
        ("shopping_item.auto_removed", "shopping_item"),  # zweites Einlagern: Bestand reicht
        ("shopping_item.auto_created", "shopping_item"),  # Entnehmen: fehlt 1
        ("product.shopping_lock", "product"),  # abgehakt
        ("product.shopping_lock", "product"),  # Einlagern hebt die Sperre auf
    ]
    assert own[0]["data"] == {"product_id": product_id, "quantity": 2}
    assert own[0]["command_id"] == create["id"]
    assert own[1]["entity_id"] == manual
    assert own[1]["data"] == {"product_id": product_id, "package_id": first}
    assert own[1]["command_id"] == own[2]["command_id"] == store_first["id"]
    assert own[2]["data"] == {"product_id": product_id, "old": 2, "new": 1}
    assert own[3]["data"] == {"product_id": product_id, "quantity": 1, "reason": "stock"}
    assert own[3]["entity_id"] == auto["id"]
    assert own[4]["entity_id"] == again["id"] and own[4]["command_id"] == remove["id"]
    assert own[5]["entity_id"] == product_id and own[5]["command_id"] == tick["id"]
    assert own[5]["data"] == {"lock": tick["at"], "old": None}
    assert own[6]["data"] == {"lock": None, "old": tick["at"]}
    assert own[6]["command_id"] == store_third["id"]
    # Die Ursache steht vor der Wirkung.
    position = {event["id"]: index for index, event in enumerate(log)}
    created = next(e for e in log if e["type"] == "package.created" and e["entity_id"] == first)
    assert position[created["id"]] < position[own[1]["id"]]
    # Das Wiederherstellen brachte den Bestand auf 2: Der erledigte Eintrag bleibt erledigt.
    assert device.shopping_items[again["id"]]["done_at"] is not None
    assert all(item["deleted_at"] or item["done_at"] for item in auto_items(device, product_id))


def test_the_lock_is_not_part_of_the_sync(make_device, con):
    device = make_device()
    product_id, create = device.product("Milch", min_stock=1)
    device.sync([create])
    (auto,) = auto_items(device, product_id)
    before = con.execute("SELECT rev FROM products WHERE id = ?", (product_id,)).fetchone()[0]

    data = device.sync([update(device, auto["id"], done=True)])
    row = con.execute("SELECT rev, shopping_lock_at FROM products WHERE id = ?", (product_id,)).fetchone()
    assert row["shopping_lock_at"] is not None
    assert row["rev"] == before  # kein neuer Stand: Die Sperre kennt kein Gerät
    assert data["changes"]["products"] == []
    assert "shopping_lock_at" not in device.products[product_id]


def test_an_older_store_from_another_device_does_not_lift_the_lock(make_device, clock, con):
    """Offline vor dem Abhaken eingelagert, erst danach abgeglichen: Die Sperre bleibt."""
    phone, tablet = make_device("Handy"), make_device("Tablet")
    product_id, create = phone.product("Milch", min_stock=2)
    phone.sync([create])
    (auto,) = auto_items(phone, product_id)
    clock.advance(3600)
    phone.sync([update(phone, auto["id"], age=60, done=True)])
    lock = con.execute("SELECT shopping_lock_at FROM products WHERE id = ?", (product_id,)).fetchone()[0]
    assert lock == clock.stamp(60)

    _package, store = tablet.package(product_id, age=120)
    tablet.sync([store])
    assert (
        con.execute("SELECT shopping_lock_at FROM products WHERE id = ?", (product_id,)).fetchone()[0] == lock
    )
    assert len(auto_items(tablet, product_id)) == 1  # gesperrt: kein neuer, obwohl noch 1 fehlt


def test_the_response_carries_what_its_commands_triggered(make_device):
    device = make_device()
    product_id, create = device.product("Milch")
    package_id, store = device.package(product_id)
    device.sync(
        [create, store, device.cmd("product.update", product_id=product_id, changes={"min_stock": 1})]
    )
    assert device.shopping_items == {}

    data = device.sync([device.cmd("package.remove", package_id=package_id, reason="consumed")])
    (item,) = data["changes"]["shopping_items"]
    assert (item["product_id"], item["origin"], item["quantity"], item["text"]) == (
        product_id,
        "min_stock",
        1,
        "",
    )
    assert item["created_at"] == item["updated_at"] == device.packages[package_id]["removed_at"]


def test_a_merge_moves_every_entry_and_counts_it(make_device, con, clock):
    device = make_device()
    source, create_source = device.product("Vollmilch", min_stock=1)
    target, create_target = device.product("Milch")
    done, create_done = item_cmd(device, product_id=source)
    gone, create_gone = item_cmd(device, product_id=source)
    device.sync(
        [
            create_source,
            create_target,
            create_done,
            create_gone,
            update(device, done, done=True),
            delete(device, gone),
        ]
    )
    clock.advance(60)
    data = device.sync([device.cmd("product.merge", age=10, source_id=source, target_id=target)])
    moved = [item for item in data["changes"]["shopping_items"] if item["id"] in (done, gone)]
    assert {item["product_id"] for item in moved} == {target}
    assert {item["updated_at"] for item in moved} == {clock.stamp(10)}
    # Ein gemeinsamer rev, wie bei den Packungen.
    assert rev_of(con, done) == rev_of(con, gone)
    merged = [e for e in events_of(device.client, device, entity="product") if e["type"] == "product.merged"]
    assert merged[0]["data"]["shopping_items"] == 3  # der automatische, der erledigte, der gelöschte
    assert all(item["product_id"] == target for item in device.shopping_items.values())


def test_a_failing_trigger_takes_the_command_with_it(make_device, monkeypatch, con):
    """Was ein Befehl auslöst, gilt mit ihm oder gar nicht: derselbe Sicherungspunkt (6.3)."""
    device = make_device()
    product_id, create = device.product("Milch", min_stock=1)

    def broken(cause, product_id):
        cause.con.execute(
            "INSERT INTO shopping_items (id, product_id, text, origin, created_at, updated_at, rev) "
            "VALUES (?, ?, '', 'min_stock', ?, ?, 1)",
            (ids.new_uuid(), product_id, cause.at, cause.at),
        )
        raise RuntimeError("kaputt")

    monkeypatch.setattr(shopping, "reconcile", broken)
    data = device.sync([create])
    assert statuses(data) == [("rejected", "internal")]
    assert con.execute("SELECT COUNT(*) FROM shopping_items").fetchone()[0] == 0
    assert con.execute("SELECT COUNT(*) FROM products").fetchone()[0] == 0


# --- Aufbewahrung im vollständigen Abzug -----------------------------------------------------


@pytest.fixture
def aged_list(make_device, clock):
    """Einträge jeden Alters: offen, lange erledigt, lange erledigt und kürzlich gelöscht …"""
    phone, tablet = make_device("Handy"), make_device("Tablet")
    names = (
        "open_old",
        "done_long_ago",
        "done_long_ago_deleted_recently",
        "deleted_long_ago",
        "done_recently",
        "deleted_at_the_edge",
    )
    created = {name: item_cmd(phone, text=name) for name in names}
    phone.sync([command for _, command in created.values()])
    tablet.sync()  # das Tablet kennt die Liste von vor dem Abhaken
    clock.advance(days=100)
    items = {name: item_id for name, (item_id, _) in created.items()}
    phone.sync(
        [
            update(phone, items["done_long_ago"], age=40 * DAY, done=True),
            update(phone, items["done_long_ago_deleted_recently"], age=40 * DAY, done=True),
            delete(phone, items["deleted_long_ago"], age=31 * DAY),
            delete(phone, items["deleted_at_the_edge"], age=30 * DAY),
            delete(phone, items["done_long_ago_deleted_recently"], age=10 * DAY),
            update(phone, items["done_recently"], age=5 * DAY, done=True),
        ]
    )
    return phone, tablet, items


def test_a_full_dump_leaves_out_entries_closed_long_ago(aged_list, client, clock):
    phone, _tablet, items = aged_list
    fresh = Device(client, "Neues Gerät", clock=clock)
    data = fresh.sync()
    assert data["reset"] is True
    # Gemessen am späteren von done_at und deleted_at; offene bleiben, egal wie alt.
    assert set(fresh.shopping_items) == {
        items["open_old"],
        items["done_long_ago_deleted_recently"],
        items["done_recently"],
        items["deleted_at_the_edge"],
    }
    assert fresh.cursor == phone.cursor
    assert fresh.sync()["changes"]["shopping_items"] == []


def test_a_device_with_an_old_cursor_still_learns_about_old_closures(aged_list):
    _phone, tablet, items = aged_list
    data = tablet.sync()
    assert data["reset"] is False
    delivered = {item["id"] for item in data["changes"]["shopping_items"]}
    assert delivered == set(items.values()) - {items["open_old"]}
    assert tablet.shopping_items[items["deleted_long_ago"]]["deleted_at"] is not None


def test_only_the_reset_page_leaves_entries_out(aged_list, client, clock, monkeypatch):
    """Die Folgeseiten eines Abzugs liefern ausnahmslos alles mit rev > cursor, auch alte Einträge."""
    _phone, _tablet, items = aged_list
    monkeypatch.setattr(changes, "PAGE_LIMIT", 2)
    fresh = Device(client, "Neues Gerät", clock=clock)
    pages = fresh.sync_all()
    assert pages[0]["reset"] is True and len(pages) > 2
    first = {item["id"] for item in pages[0]["changes"]["shopping_items"]}
    later = {item["id"] for page in pages[1:] for item in page["changes"]["shopping_items"]}
    # Das Schließen gab den Einträgen einen hohen rev: Sie liegen hinter der ersten Seite.
    assert items["done_long_ago"] in later and items["deleted_long_ago"] in later
    assert not first & later


def test_the_omission_follows_the_retention_setting_for_the_list(aged_list, client, clock):
    phone, _tablet, items = aged_list
    phone.sync([phone.cmd("settings.update", changes={"trash_retention_days": 60})])
    phone.sync(dataset_id=None, cursor=0)
    assert set(phone.shopping_items) == set(items.values())

    phone.sync([phone.cmd("settings.update", changes={"trash_retention_days": 7})])
    fresh = Device(client, "Neues Gerät", clock=clock)
    fresh.sync()
    assert set(fresh.shopping_items) == {items["open_old"], items["done_recently"]}
