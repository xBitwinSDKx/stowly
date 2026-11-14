"""Zonen und Einstellungen des Haushalts (docs/sync-protokoll.md, Abschnitte 3.3, 3.4, 6.6 und 7.4)."""

import pytest
from support import events_of, statuses

from stowly.contract import ids


def zone_events(device, zone_id: str) -> list[tuple[str, dict]]:
    return [
        (e["type"], e["data"]) for e in events_of(device.client, device, entity="zone", entity_id=zone_id)
    ]


def new_zone(device, name: str, **payload) -> tuple[str, dict]:
    zone_id = ids.new_uuid()
    return zone_id, device.cmd("zone.create", zone_id=zone_id, name=name, **payload)


# --- Anlegen und Ändern ------------------------------------------------------------------


def test_creating_a_zone(make_device, clock):
    device = make_device()
    printer = ids.new_uuid()  # Verweise auf Drucker prüft der Server nicht
    zone_id, create = new_zone(
        device, "Gefrierschrank", age=20, icon="snowflake", color="blue", sort=3, printer_id=printer
    )
    assert statuses(device.sync([create])) == [("applied", None)]
    assert device.zones[zone_id] == {
        "id": zone_id,
        "name": "Gefrierschrank",
        "icon": "snowflake",
        "color": "blue",
        "sort": 3,
        "printer_id": printer,
        "created_at": clock.stamp(20),
        "updated_at": clock.stamp(20),
        "deleted_at": None,
        "moved_to": None,
    }
    assert zone_events(device, zone_id) == [
        (
            "zone.created",
            {
                "name": "Gefrierschrank",
                "icon": "snowflake",
                "color": "blue",
                "sort": 3,
                "printer_id": printer,
            },
        )
    ]

    plain_id, plain = new_zone(device, "Keller")
    device.sync([plain])
    zone = device.zones[plain_id]
    assert (zone["icon"], zone["color"], zone["sort"], zone["printer_id"]) == ("box", None, 0, None)

    assert statuses(device.sync([device.cmd("zone.create", zone_id=zone_id, name="Doppelt")])) == [
        ("rejected", "id_conflict")
    ]


def test_zone_fields_follow_the_later_timestamp(make_device, clock):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    zone_id, create = new_zone(phone, "Keller", color="blue")
    phone.sync([create])
    tablet.sync()
    clock.advance(3600)

    new = tablet.cmd("zone.update", age=5, zone_id=zone_id, changes={"name": "Vorratskeller", "color": None})
    old = phone.cmd(
        "zone.update", age=60, zone_id=zone_id, changes={"name": "Kellerregal", "icon": "shelf", "sort": 4}
    )
    tablet.sync([new])
    phone.sync([old])

    zone = phone.zones[zone_id]
    assert (zone["name"], zone["color"], zone["icon"], zone["sort"]) == ("Vorratskeller", None, "shelf", 4)
    assert zone["updated_at"] == clock.stamp(5)
    assert zone_events(phone, zone_id)[1:] == [
        (
            "zone.updated",
            {
                "changes": {
                    "color": {"old": "blue", "new": None},
                    "name": {"old": "Keller", "new": "Vorratskeller"},
                },
                "superseded": {},
            },
        ),
        (
            "zone.updated",
            {
                "changes": {"icon": {"old": "box", "new": "shelf"}, "sort": {"old": 0, "new": 4}},
                "superseded": {"name": "Kellerregal"},
            },
        ),
    ]


def test_a_new_order_is_several_updates(make_device):
    device = make_device()
    home = device.zone_id
    cellar, create_cellar = new_zone(device, "Keller", sort=1)
    freezer, create_freezer = new_zone(device, "Gefrierschrank", sort=2)
    device.sync([create_cellar, create_freezer])
    device.sync(
        [
            device.cmd("zone.update", zone_id=freezer, changes={"sort": 0}),
            device.cmd("zone.update", zone_id=home, changes={"sort": 1}),
            device.cmd("zone.update", zone_id=cellar, changes={"sort": 2}),
        ]
    )
    ordered = sorted(device.zones.values(), key=lambda zone: (zone["sort"], zone["name"]))
    assert [zone["id"] for zone in ordered] == [freezer, home, cellar]


# --- 7.4 Zonen löschen -------------------------------------------------------------------


def test_deleting_a_zone_moves_its_packages_and_the_primary_zone(make_device, clock):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    home = phone.zone_id
    assert phone.settings["primary_zone_id"] == home
    cellar, create = new_zone(phone, "Keller")
    product_id, create_product = phone.product("Reis")
    in_stock, store = phone.package(product_id, zone_id=home)
    removed, store_removed = phone.package(product_id, zone_id=home)
    elsewhere, store_elsewhere = phone.package(product_id, zone_id=cellar)
    phone.sync(
        [
            create,
            create_product,
            store,
            store_removed,
            store_elsewhere,
            phone.cmd("package.remove", package_id=removed, reason="consumed"),
        ]
    )
    tablet.sync()
    clock.advance(3600)

    delete = phone.cmd("zone.delete", age=30, zone_id=home, move_to=cellar)
    data = phone.sync([delete])
    assert statuses(data) == [("applied", None)]

    gone = phone.zones[home]
    assert gone["deleted_at"] == clock.stamp(30)
    assert gone["moved_to"] == cellar
    # Alle Packungen der Zone, auch die entnommene, liegen in der Zielzone.
    assert {phone.packages[p]["zone_id"] for p in (in_stock, removed, elsewhere)} == {cellar}
    assert phone.packages[removed]["removed_at"] is not None
    assert phone.packages[in_stock]["updated_at"] == clock.stamp(30)
    # Die Primärzone zieht mit; die Einstellungen kommen deshalb in derselben Antwort.
    assert data["changes"]["settings"]["primary_zone_id"] == cellar
    assert {package["id"] for package in data["changes"]["packages"]} == {in_stock, removed}

    assert zone_events(phone, home)[-1] == ("zone.deleted", {"moved_to": cellar, "packages": 2})
    settings = events_of(phone.client, phone, entity="settings", entity_id="household")
    assert [(e["type"], e["command_id"], e["data"]) for e in settings] == [
        (
            "settings.updated",
            delete["id"],
            {"changes": {"primary_zone_id": {"old": home, "new": cellar}}, "superseded": {}},
        )
    ]

    # Gelöschte Zonen kommen immer mit: Die App braucht sie, um alten Verweisen zu folgen.
    tablet.sync()
    assert tablet.zones[home]["moved_to"] == cellar
    assert tablet.packages[in_stock]["zone_id"] == cellar
    assert tablet.settings["primary_zone_id"] == cellar


def test_the_primary_zone_stays_if_another_zone_is_deleted(make_device):
    device = make_device()
    home = device.zone_id
    cellar, create = new_zone(device, "Keller")
    device.sync([create])
    data = device.sync([device.cmd("zone.delete", zone_id=cellar, move_to=home)])
    assert data["changes"]["settings"] is None
    assert device.settings["primary_zone_id"] == home


def test_later_references_to_a_deleted_zone_follow_moved_to(make_device):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    home = phone.zone_id
    cellar, create_cellar = new_zone(phone, "Keller")
    attic, create_attic = new_zone(phone, "Dachboden")
    product_id, create_product = phone.product("Reis")
    phone.sync([create_cellar, create_attic, create_product])
    tablet.sync()

    # Über mehrere Schritte: Vorrat -> Keller -> Dachboden.
    phone.sync(
        [
            phone.cmd("zone.delete", zone_id=home, move_to=cellar),
            phone.cmd("zone.delete", zone_id=cellar, move_to=attic),
        ]
    )

    # Das Tablet lagert noch in die gelöschte Zone ein und verschiebt dorthin.
    new_package, store = tablet.package(product_id, zone_id=home)
    moved, store_moved = tablet.package(product_id, zone_id=attic)
    data = tablet.sync(
        [store, store_moved, tablet.cmd("package.update", package_id=moved, changes={"zone_id": cellar})]
    )
    assert statuses(data) == [("applied", None)] * 3
    assert tablet.packages[new_package]["zone_id"] == attic
    assert tablet.packages[moved]["zone_id"] == attic
    created = [e for e in events_of(tablet.client, tablet, entity="package", entity_id=new_package)]
    assert created[0]["data"]["zone_id"] == attic

    # Eine gelöschte Zone lässt sich dagegen nicht mehr bearbeiten.
    data = tablet.sync([tablet.cmd("zone.update", zone_id=home, changes={"name": "Vorrat neu"})])
    assert statuses(data) == [("rejected", "not_found")]
    assert tablet.zones[home]["name"] == "Vorrat"


def test_move_to_a_deleted_zone_lands_in_its_target(make_device):
    device = make_device()
    home = device.zone_id
    cellar, create_cellar = new_zone(device, "Keller")
    attic, create_attic = new_zone(device, "Dachboden")
    product_id, create_product = device.product("Reis")
    package_id, store = device.package(product_id, zone_id=attic)
    device.sync([create_cellar, create_attic, create_product, store])
    device.sync([device.cmd("zone.delete", zone_id=cellar, move_to=home)])

    # „Dachboden nach Keller": Den Keller gibt es nicht mehr, seine Packungen liegen im Vorrat.
    device.sync([device.cmd("zone.delete", zone_id=attic, move_to=cellar)])
    assert device.zones[attic]["moved_to"] == home
    assert device.packages[package_id]["zone_id"] == home


def test_the_last_zone_cannot_be_deleted(make_device):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    home = phone.zone_id
    cellar, create = new_zone(phone, "Keller")
    phone.sync([create])
    tablet.sync()

    # Jedes Gerät löscht offline die jeweils andere Zone. Die zweite Löschung träfe die letzte.
    assert statuses(phone.sync([phone.cmd("zone.delete", zone_id=home, move_to=cellar)])) == [
        ("applied", None)
    ]
    data = tablet.sync([tablet.cmd("zone.delete", zone_id=cellar, move_to=home)])
    assert statuses(data) == [("rejected", "last_zone")]
    assert data["results"][0]["message"] == "Die letzte Zone lässt sich nicht löschen."
    assert tablet.zones[cellar]["deleted_at"] is None
    rejected = [
        e
        for e in events_of(tablet.client, tablet, entity="zone", entity_id=cellar)
        if e["type"] == "command.rejected"
    ]
    assert [e["data"]["code"] for e in rejected] == ["last_zone"]


def test_a_fresh_database_refuses_to_delete_its_only_zone(make_device):
    device = make_device()
    home = device.zone_id
    data = device.sync(
        [
            device.cmd("zone.delete", zone_id=home, move_to=home),
            device.cmd("zone.delete", zone_id=home, move_to=ids.new_uuid()),
        ]
    )
    assert statuses(data) == [("rejected", "last_zone")] * 2


def test_zone_delete_rejections_and_repetition(make_device):
    device = make_device()
    home = device.zone_id
    cellar, create = new_zone(device, "Keller")
    device.sync([create])
    unknown = ids.new_uuid()
    data = device.sync(
        [
            device.cmd("zone.delete", zone_id=unknown, move_to=home),
            device.cmd("zone.delete", zone_id=cellar, move_to=unknown),
            device.cmd("zone.delete", zone_id=cellar, move_to=cellar),
            device.cmd("zone.update", zone_id=unknown, changes={"name": "x"}),
        ]
    )
    assert statuses(data) == [
        ("rejected", "not_found"),
        ("rejected", "not_found"),
        ("rejected", "invalid"),
        ("rejected", "not_found"),
    ]
    assert device.zones[cellar]["deleted_at"] is None

    delete = device.cmd("zone.delete", zone_id=cellar, move_to=home)
    device.sync([delete])
    deleted_at = device.zones[cellar]["deleted_at"]
    # Schon gelöscht: ohne Wirkung, auch wenn das Ziel diesmal Unsinn ist.
    again = device.sync([device.cmd("zone.delete", zone_id=cellar, move_to=unknown)])
    assert statuses(again) == [("applied", None)]
    assert device.zones[cellar]["deleted_at"] == deleted_at
    assert [e[0] for e in zone_events(device, cellar)].count("zone.deleted") == 1


def test_a_package_cannot_be_created_in_an_unknown_zone(make_device):
    device = make_device()
    product_id, create = device.product("Reis")
    _, store = device.package(product_id, zone_id=ids.new_uuid())
    assert statuses(device.sync([create, store])) == [("applied", None), ("rejected", "not_found")]
    assert device.packages == {}


# --- Einstellungen -----------------------------------------------------------------------


def test_settings_follow_the_later_timestamp_per_field(make_device, clock):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    clock.advance(3600)
    new = tablet.cmd("settings.update", age=5, changes={"warn_days": 21, "zone_mode": "equal"})
    old = phone.cmd("settings.update", age=60, changes={"warn_days": 7, "trash_retention_days": 90})
    tablet.sync([new])
    data = phone.sync([old])

    assert statuses(data) == [("applied", None)]
    settings = phone.settings
    assert (settings["warn_days"], settings["zone_mode"], settings["trash_retention_days"]) == (
        21,
        "equal",
        90,
    )
    assert settings["updated_at"] == clock.stamp(5)
    log = events_of(phone.client, phone, entity="settings")
    assert [(e["entity_id"], e["type"], e["data"]) for e in log] == [
        (
            "household",
            "settings.updated",
            {
                "changes": {
                    "warn_days": {"old": 14, "new": 21},
                    "zone_mode": {"old": "primary", "new": "equal"},
                },
                "superseded": {},
            },
        ),
        (
            "household",
            "settings.updated",
            {"changes": {"trash_retention_days": {"old": 30, "new": 90}}, "superseded": {"warn_days": 7}},
        ),
    ]


def test_notify_time_is_a_setting_with_its_own_clock(make_device, clock):
    """notify_time: "HH:MM", Vorgabe 17:00, Feld-Uhr wie jede Einstellung (Protokoll 3.4 und 7.1)."""
    phone, tablet = make_device("Handy"), make_device("Tablet")
    assert phone.settings["notify_time"] == "17:00"
    clock.advance(3600)
    new = tablet.cmd("settings.update", age=5, changes={"notify_time": "18:30"})
    old = phone.cmd("settings.update", age=60, changes={"notify_time": "07:15"})
    tablet.sync([new])
    assert statuses(phone.sync([old])) == [("applied", None)]
    assert phone.settings["notify_time"] == "18:30"


def test_references_in_settings_are_not_checked(make_device):
    device = make_device()
    nowhere, nothing = ids.new_uuid(), ids.new_uuid()
    data = device.sync(
        [device.cmd("settings.update", changes={"primary_zone_id": nowhere, "default_printer_id": nothing})]
    )
    assert statuses(data) == [("applied", None)]
    assert (device.settings["primary_zone_id"], device.settings["default_printer_id"]) == (nowhere, nothing)
    device.sync(
        [device.cmd("settings.update", changes={"primary_zone_id": None, "default_printer_id": None})]
    )
    assert (device.settings["primary_zone_id"], device.settings["default_printer_id"]) == (None, None)


@pytest.mark.parametrize(
    "changes",
    [
        {"warn_days": -1},
        {"warn_days": 3651},
        {"trash_retention_days": 0},
        {"zone_mode": "chaos"},
        {"zone_mode": None},
        {"sprache": "de"},
        {"notify_time": None},
        {"notify_time": "7:00"},
        {"notify_time": "24:00"},
        {"notify_time": "17:60"},
        {"notify_time": "17:00:00"},
    ],
)
def test_invalid_settings_are_rejected(make_device, changes):
    device = make_device()
    assert statuses(device.sync([device.cmd("settings.update", changes=changes)])) == [
        ("rejected", "invalid")
    ]
    assert device.sync()["changes"]["settings"] is None
