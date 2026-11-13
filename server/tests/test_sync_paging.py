"""Änderungsfolge: Blättern, gemeinsamer ``rev``, vollständiger Abzug (docs/sync-protokoll.md, 6.4)."""

import sqlite3
from collections import Counter

import pytest
from support import Device

from stowly.contract import MAX_CHANGES_PER_SYNC, ids
from stowly.sync import changes

DAY = 86400

_KEYS = {
    "zones": "id",
    "products": "id",
    "packages": "id",
    "printers": "id",
    "printer_status": "printer_id",
    "print_jobs": "id",
    "label_templates": "key",
}


def records_of(page: dict) -> list[tuple[str, str]]:
    """Alle Datensätze einer Antwort als ``(tabelle, schlüssel)``; die Einstellungen als einer."""
    found = [(table, record[key]) for table, key in _KEYS.items() for record in page["changes"][table]]
    if page["changes"]["settings"] is not None:
        found.append(("settings", "household"))
    return found


def rev_of(con: sqlite3.Connection, table: str, key: str) -> int:
    if table == "settings":
        return con.execute("SELECT value FROM counters WHERE name = 'settings_rev'").fetchone()[0]
    return con.execute(f"SELECT rev FROM {table} WHERE {_KEYS[table]} = ?", (key,)).fetchone()[0]


def check_pages(con: sqlite3.Connection, pages: list[dict], start: int = 0) -> list[tuple[str, str]]:
    """Prüft die Zusagen des Blätterns und liefert alle Datensätze der gesammelten Seiten.

    * Nichts kommt doppelt.
    * Jede Seite enthält genau die Datensätze mit ``vorheriger cursor < rev <= cursor``:
      Der ``cursor`` gilt über alle Tabellen hinweg, keine Seite endet mitten in einem ``rev``.
    * Nur die letzte Seite hat ``has_more`` falsch.
    """
    collected: list[tuple[str, str]] = []
    previous = start
    for index, page in enumerate(pages):
        assert page["has_more"] is (index < len(pages) - 1)
        assert page["cursor"] > previous or not page["has_more"]
        for table, key in records_of(page):
            assert previous < rev_of(con, table, key) <= page["cursor"], (table, key)
        collected.extend(records_of(page))
        previous = page["cursor"]
    assert not [record for record, count in Counter(collected).items() if count > 1], "doppelt geliefert"
    return collected


@pytest.fixture
def small_pages(monkeypatch):
    def set_limit(limit: int) -> None:
        monkeypatch.setattr(changes, "PAGE_LIMIT", limit)

    return set_limit


# --- has_more ----------------------------------------------------------------------------


def test_a_large_stock_arrives_in_pages(make_device, con, small_pages, client, clock):
    phone = make_device("Handy")
    product_id, create = phone.product("Reis")
    commands = [create]
    for number in range(8):
        commands.append(phone.cmd("zone.create", zone_id=ids.new_uuid(), name=f"Zone {number}"))
        commands.append(phone.package(product_id)[1])
    phone.sync(commands)

    small_pages(4)
    tablet = Device(client, "Tablet", clock=clock)
    pages = tablet.sync_all()
    assert len(pages) > 3
    assert [page["reset"] for page in pages] == [True] + [False] * (len(pages) - 1)
    assert all(len(records_of(page)) <= 4 for page in pages)

    collected = check_pages(con, pages)
    # 9 Zonen, 1 Produkt, 8 Packungen, 2 Vorlagen, die Einstellungen: nichts fehlt.
    assert Counter(table for table, _ in collected) == {
        "zones": 9,
        "products": 1,
        "packages": 8,
        "label_templates": 2,
        "settings": 1,
    }
    assert tablet.cursor == phone.cursor
    assert tablet.packages == phone.packages and tablet.zones == phone.zones
    assert tablet.sync()["has_more"] is False


def test_paging_from_a_cursor_in_the_middle(make_device, con, small_pages):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    start = tablet.cursor
    product_id, create = phone.product("Reis")
    stored = [phone.package(product_id) for _ in range(7)]
    phone.sync([create, *[command for _, command in stored]])

    small_pages(3)
    pages = tablet.sync_all()
    assert [len(records_of(page)) for page in pages] == [3, 3, 2]
    assert all(page["reset"] is False for page in pages)
    collected = check_pages(con, pages, start)
    assert {key for table, key in collected if table == "packages"} == {
        package_id for package_id, _ in stored
    }


def test_commands_and_paging_in_one_call(make_device, small_pages):
    """Die Wirkung der eigenen Befehle steckt in den Seiten; Folgeseiten kommen ohne Befehle."""
    device = make_device()
    small_pages(2)
    product_id, create = device.product("Reis")
    stored = [device.package(product_id) for _ in range(5)]
    pages = device.sync_all([create, *[command for _, command in stored]])
    assert len(pages) == 3
    assert len(pages[0]["results"]) == 6 and pages[1]["results"] == []
    assert set(device.packages) == {package_id for package_id, _ in stored}


def test_the_page_limit_is_the_contract_value():
    assert changes.PAGE_LIMIT == MAX_CHANGES_PER_SYNC == 5000


# --- Viele Zeilen mit demselben rev ------------------------------------------------------


def stock_in_two_zones(device, per_zone: int) -> tuple[str, str, list[str]]:
    """Ein Produkt, eine zweite Zone und ``per_zone`` Packungen in der ersten Zone."""
    home = device.zone_id
    cellar = ids.new_uuid()
    product_id, create = device.product("Reis")
    stored = [device.package(product_id, zone_id=home) for _ in range(per_zone)]
    device.sync([device.cmd("zone.create", zone_id=cellar, name="Keller"), create, *[c for _, c in stored]])
    return home, cellar, [package_id for package_id, _ in stored]


def test_a_page_never_ends_inside_a_shared_rev(make_device, con, small_pages):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    home, cellar, packages = stock_in_two_zones(phone, per_zone=7)
    tablet.sync()
    start = tablet.cursor

    # Ein Befehl verschiebt sieben Packungen auf einmal: Sie teilen sich einen rev.
    extra, create_extra = phone.product("Nudeln")
    phone.sync([create_extra, phone.cmd("zone.delete", zone_id=home, move_to=cellar)])
    assert len({rev_of(con, "packages", package_id) for package_id in packages}) == 1

    small_pages(3)
    pages = tablet.sync_all()
    collected = check_pages(con, pages, start)
    # Das Produkt davor passt allein auf die erste Seite; die sieben Packungen kommen
    # danach vollständig, auch wenn die Seite dafür größer wird als die Grenze.
    sizes = [len(records_of(page)) for page in pages]
    assert sizes[0] == 1 and 7 in sizes
    assert {key for table, key in collected if table == "packages"} == set(packages)
    assert all(tablet.packages[package_id]["zone_id"] == cellar for package_id in packages)
    assert tablet.zones[home]["moved_to"] == cellar
    assert tablet.settings["primary_zone_id"] == cellar


def test_a_shared_rev_right_behind_the_cursor_comes_whole(make_device, con, small_pages):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    home, cellar, packages = stock_in_two_zones(phone, per_zone=9)
    tablet.sync()
    start = tablet.cursor
    phone.sync([phone.cmd("zone.delete", zone_id=home, move_to=cellar)])

    small_pages(4)
    pages = tablet.sync_all()
    assert len(records_of(pages[0])) == 9  # der ganze rev, obwohl die Grenze 4 ist
    assert pages[0]["has_more"] is True
    collected = check_pages(con, pages, start)
    assert {key for table, key in collected if table == "packages"} == set(packages)


def test_a_merge_shares_one_rev_across_a_page_boundary(make_device, con, small_pages):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    source, create_source = phone.product("Reis lose")
    target, create_target = phone.product("Basmati Reis")
    stored = [phone.package(source) for _ in range(6)]
    phone.sync([create_source, create_target, *[command for _, command in stored]])
    tablet.sync()
    start = tablet.cursor
    phone.sync([phone.cmd("product.merge", source_id=source, target_id=target)])

    small_pages(2)
    pages = tablet.sync_all()
    collected = check_pages(con, pages, start)
    assert Counter(table for table, _ in collected) == {"packages": 6, "products": 2}
    assert all(tablet.packages[package_id]["product_id"] == target for package_id, _ in stored)


def test_exactly_full_pages(make_device, con, small_pages):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    start = tablet.cursor
    phone.sync([phone.cmd("zone.create", zone_id=ids.new_uuid(), name=f"Zone {n}") for n in range(6)])
    small_pages(3)
    pages = tablet.sync_all()
    assert [len(records_of(page)) for page in pages] == [3, 3]
    assert [page["has_more"] for page in pages] == [True, False]
    check_pages(con, pages, start)

    small_pages(6)
    again = tablet.sync_all(cursor=start)
    assert [len(records_of(page)) for page in again] == [6]


# --- Was ein vollständiger Abzug weglässt ------------------------------------------------


@pytest.fixture
def aged_stock(make_device, clock):
    """Bestand mit einer frischen und einer lange zurückliegenden Entnahme und Etiketten jeden Alters."""
    phone, tablet = make_device("Handy"), make_device("Tablet")
    product_id, create = phone.product("Reis")
    names = ("in_stock", "removed_recently", "removed_long_ago")
    packages = dict(zip(names, (phone.package(product_id) for _ in names), strict=True))
    jobs = {
        name: ids.new_uuid()
        for name in ("pending_old", "unknown_old", "printed_old", "cancelled_old", "printed_new")
    }
    phone.sync(
        [
            create,
            *[command for _, command in packages.values()],
            *[
                phone.cmd("print.request", job_id=job, kind="package", package_id=packages["in_stock"][0])
                for job in jobs.values()
            ],
        ]
    )
    tablet.sync()  # das Tablet kennt den Bestand von vor den Entnahmen
    clock.advance(days=100)

    phone.sync(
        [
            phone.cmd(
                "package.remove", age=40 * DAY, package_id=packages["removed_long_ago"][0], reason="consumed"
            ),
            phone.cmd("print.report", age=40 * DAY, job_id=jobs["unknown_old"], state="unknown"),
            phone.cmd("print.report", age=31 * DAY, job_id=jobs["printed_old"], state="printed"),
            phone.cmd("print.report", age=31 * DAY, job_id=jobs["cancelled_old"], state="cancelled"),
            phone.cmd(
                "package.remove", age=10 * DAY, package_id=packages["removed_recently"][0], reason="discarded"
            ),
            phone.cmd("print.report", age=5 * DAY, job_id=jobs["printed_new"], state="printed"),
        ]
    )
    return phone, tablet, {name: package_id for name, (package_id, _) in packages.items()}, jobs


def test_a_full_dump_leaves_out_what_is_long_gone(aged_stock, client, clock):
    phone, _tablet, packages, jobs = aged_stock
    fresh = Device(client, "Neues Gerät", clock=clock)
    data = fresh.sync()

    assert data["reset"] is True
    # Entnommen vor 40 Tagen bei 30 Tagen Aufbewahrung: nicht mehr dabei.
    assert set(fresh.packages) == {packages["in_stock"], packages["removed_recently"]}
    # Erledigt (printed, cancelled) und älter als 30 Tage: nicht mehr dabei. Offene bleiben, egal wie alt.
    assert set(fresh.print_jobs) == {jobs["pending_old"], jobs["unknown_old"], jobs["printed_new"]}
    assert fresh.cursor == phone.cursor
    assert fresh.sync()["changes"]["packages"] == []


def test_a_device_with_an_old_cursor_still_learns_about_old_removals(aged_stock):
    """Sonst zeigte es die Packung für immer im Bestand und stellte das Etikett noch einmal zu."""
    _phone, tablet, packages, jobs = aged_stock
    assert tablet.packages[packages["removed_long_ago"]]["removed_at"] is None
    assert tablet.print_jobs[jobs["printed_old"]]["state"] == "pending"

    data = tablet.sync()
    assert data["reset"] is False
    delivered = {package["id"]: package for package in data["changes"]["packages"]}
    assert set(delivered) == {packages["removed_long_ago"], packages["removed_recently"]}
    assert delivered[packages["removed_long_ago"]]["removal_reason"] == "consumed"
    assert {job["id"]: job["state"] for job in data["changes"]["print_jobs"]} == {
        jobs["unknown_old"]: "unknown",
        jobs["printed_old"]: "printed",
        jobs["cancelled_old"]: "cancelled",
        jobs["printed_new"]: "printed",
    }


def test_the_omission_follows_the_retention_setting(aged_stock, client, clock):
    phone, _tablet, packages, _jobs = aged_stock
    phone.sync([phone.cmd("settings.update", changes={"trash_retention_days": 60})])
    # Längere Aufbewahrung: Die App holt den Bestand einmal vollständig neu (dataset_id null, cursor 0).
    data = phone.sync(dataset_id=None, cursor=0)
    assert data["reset"] is True
    assert set(phone.packages) == set(packages.values())

    phone.sync([phone.cmd("settings.update", changes={"trash_retention_days": 7})])
    fresh = Device(client, "Neues Gerät", clock=clock)
    fresh.sync()
    assert set(fresh.packages) == {packages["in_stock"]}


def test_only_the_reset_page_itself_leaves_things_out(aged_stock, client, clock, con, small_pages):
    """Auch die Folgeseiten eines Abzugs liefern ausnahmslos alles mit rev > cursor."""
    _phone, _tablet, packages, jobs = aged_stock
    small_pages(3)
    fresh = Device(client, "Neues Gerät", clock=clock)
    pages = fresh.sync_all()
    assert pages[0]["reset"] is True and len(pages) > 2

    first = set(records_of(pages[0]))
    later = {record for page in pages[1:] for record in records_of(page)}
    # Die lange zurückliegende Entnahme und die alten erledigten Etiketten haben einen hohen
    # rev: Sie liegen hinter der ersten Seite und kommen deshalb mit.
    assert ("packages", packages["removed_long_ago"]) not in first
    assert ("packages", packages["removed_long_ago"]) in later
    assert ("print_jobs", jobs["printed_old"]) in later
    assert not first & later


def test_tombstones_are_always_part_of_a_full_dump(make_device, client, clock):
    phone = make_device("Handy")
    home = phone.zone_id
    cellar = ids.new_uuid()
    source, create_source = phone.product("Reis lose")
    target, create_target = phone.product("Basmati Reis")
    phone.sync(
        [
            phone.cmd("zone.create", zone_id=cellar, name="Keller"),
            create_source,
            create_target,
            phone.cmd("zone.delete", zone_id=home, move_to=cellar),
            phone.cmd("product.merge", source_id=source, target_id=target),
        ]
    )
    clock.advance(days=400)
    fresh = Device(client, "Neues Gerät", clock=clock)
    fresh.sync()
    # Gelöschte Zonen und zusammengeführte Produkte kommen immer mit, egal wie alt.
    assert fresh.zones[home]["moved_to"] == cellar
    assert fresh.products[source]["merged_into"] == target
