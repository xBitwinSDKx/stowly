"""Produkte, Barcodes und das Zusammenführen (docs/sync-protokoll.md, Abschnitte 6.6 und 7.3)."""

from support import EAN_A, EAN_B, EAN_C, EAN_STORE, events_of, statuses

from stowly.contract import ids


def product_events(device, product_id: str) -> list[tuple[str, dict]]:
    events = events_of(device.client, device, entity="product", entity_id=product_id)
    return [(event["type"], event["data"]) for event in events]


# --- Anlegen und Ändern ------------------------------------------------------------------


def test_creating_a_product(make_device, clock):
    device = make_device()
    product_id, create = device.product(
        "Basmati Reis",
        age=30,
        brand="Kornhaus",
        quantity="1 kg",
        warn_days=60,
        min_stock=2,
        barcodes=[EAN_A, EAN_B, EAN_A],
    )
    assert statuses(device.sync([create])) == [("applied", None)]
    product = device.products[product_id]
    assert product["barcodes"] == sorted([EAN_A, EAN_B])  # aufsteigend, ohne Doppelte
    assert (
        product["name"],
        product["brand"],
        product["quantity"],
        product["warn_days"],
        product["min_stock"],
    ) == ("Basmati Reis", "Kornhaus", "1 kg", 60, 2)
    assert product["created_at"] == product["updated_at"] == clock.stamp(30)
    assert product["deleted_at"] is None and product["merged_into"] is None
    assert product_events(device, product_id) == [
        (
            "product.created",
            {
                "name": "Basmati Reis",
                "brand": "Kornhaus",
                "quantity": "1 kg",
                "warn_days": 60,
                "min_stock": 2,
                "barcodes": [EAN_A, EAN_B],
            },
        )
    ]


def test_a_placeholder_needs_nothing_but_an_id(make_device):
    device = make_device()
    product_id = ids.new_uuid()
    device.sync([device.cmd("product.create", product_id=product_id)])
    product = device.products[product_id]
    assert (product["name"], product["brand"], product["quantity"]) == ("", "", "")
    assert product["warn_days"] is None and product["barcodes"] == [] and product["image"] is None
    assert product["min_stock"] is None


def test_a_product_id_can_only_be_used_once(make_device):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    product_id, create = phone.product("Reis")
    phone.sync([create])
    clash = tablet.cmd("product.create", product_id=product_id, name="Nudeln")
    data = tablet.sync([clash])
    assert statuses(data) == [("rejected", "id_conflict")]
    assert tablet.products[product_id]["name"] == "Reis"


def test_product_fields_follow_the_later_timestamp(make_device, clock):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    product_id, create = phone.product("Reis", brand="Alt")
    phone.sync([create])
    tablet.sync()
    clock.advance(3600)

    new = tablet.cmd("product.update", age=5, product_id=product_id, changes={"name": "Basmati Reis"})
    old = phone.cmd(
        "product.update", age=60, product_id=product_id, changes={"name": "Langkornreis", "brand": "Kornhaus"}
    )
    tablet.sync([new])
    phone.sync([old])

    product = phone.products[product_id]
    assert (product["name"], product["brand"]) == ("Basmati Reis", "Kornhaus")
    assert product["updated_at"] == clock.stamp(5)
    assert product_events(phone, product_id)[1:] == [
        ("product.updated", {"changes": {"name": {"old": "Reis", "new": "Basmati Reis"}}, "superseded": {}}),
        (
            "product.updated",
            {"changes": {"brand": {"old": "Alt", "new": "Kornhaus"}}, "superseded": {"name": "Langkornreis"}},
        ),
    ]


def test_warn_days_can_be_cleared(make_device):
    device = make_device()
    product_id, create = device.product("Reis", warn_days=30)
    device.sync([create, device.cmd("product.update", product_id=product_id, changes={"warn_days": None})])
    assert device.products[product_id]["warn_days"] is None


def test_min_stock_has_its_own_clock_and_can_be_cleared(make_device, clock):
    """Mindestbestand: ein Feld wie warn_days, mit eigener Uhr (Protokoll 7.1); null heißt keiner."""
    phone, tablet = make_device("Handy"), make_device("Tablet")
    product_id, create = phone.product("Milch", min_stock=2)
    phone.sync([create])
    tablet.sync()
    clock.advance(3600)

    new = tablet.cmd("product.update", age=5, product_id=product_id, changes={"min_stock": 4})
    old = phone.cmd("product.update", age=60, product_id=product_id, changes={"min_stock": 3, "warn_days": 5})
    tablet.sync([new])
    phone.sync([old])
    product = phone.products[product_id]
    assert (product["min_stock"], product["warn_days"]) == (4, 5)
    assert product_events(phone, product_id)[-1] == (
        "product.updated",
        {"changes": {"warn_days": {"old": None, "new": 5}}, "superseded": {"min_stock": 3}},
    )

    phone.sync([phone.cmd("product.update", product_id=product_id, changes={"min_stock": None})])
    assert phone.products[product_id]["min_stock"] is None


def test_min_stock_is_checked_like_the_contract_says(make_device):
    device = make_device()
    product_id, create = device.product("Milch")
    data = device.sync(
        [
            create,
            device.cmd("product.update", product_id=product_id, changes={"min_stock": 0}),
            device.cmd("product.update", product_id=product_id, changes={"min_stock": 1000}),
            device.cmd("product.update", product_id=product_id, changes={"min_stock": 999}),
        ]
    )
    assert statuses(data) == [
        ("applied", None),
        ("rejected", "invalid"),
        ("rejected", "invalid"),
        ("applied", None),
    ]
    assert device.products[product_id]["min_stock"] == 999


def test_unknown_products_are_rejected(make_device):
    device = make_device()
    unknown = ids.new_uuid()
    data = device.sync(
        [
            device.cmd("product.update", product_id=unknown, changes={"name": "x"}),
            device.cmd("product.add_barcode", product_id=unknown, barcode=EAN_A),
            device.cmd("product.remove_barcode", product_id=unknown, barcode=EAN_A),
            device.cmd("package.create", package_id="A2B3C", product_id=unknown, zone_id=device.zone_id),
        ]
    )
    assert statuses(data) == [("rejected", "not_found")] * 4
    assert data["results"][0]["message"] == "Das Produkt gibt es nicht."


# --- Barcodes ----------------------------------------------------------------------------


def test_adding_and_removing_barcodes(make_device):
    device = make_device()
    product_id, create = device.product("Reis", barcodes=[EAN_B])
    add = device.cmd("product.add_barcode", product_id=product_id, barcode=EAN_A)
    data = device.sync([create, add, add | {"id": ids.new_uuid()}])
    assert statuses(data) == [("applied", None)] * 3
    assert device.products[product_id]["barcodes"] == sorted([EAN_A, EAN_B])

    remove = device.cmd("product.remove_barcode", product_id=product_id, barcode=EAN_B)
    # Zweimal entfernen und einen fremden Barcode entfernen: ohne Wirkung, kein Fehler.
    data = device.sync(
        [
            remove,
            remove | {"id": ids.new_uuid()},
            device.cmd("product.remove_barcode", product_id=product_id, barcode=EAN_C),
        ]
    )
    assert statuses(data) == [("applied", None)] * 3
    assert device.products[product_id]["barcodes"] == [EAN_A]
    assert product_events(device, product_id)[1:] == [
        ("product.barcode_added", {"barcode": EAN_A}),
        ("product.barcode_removed", {"barcode": EAN_B}),
    ]


def test_a_barcode_can_only_be_removed_from_its_own_product(make_device):
    device = make_device()
    rice, create_rice = device.product("Reis", barcodes=[EAN_A])
    pasta, create_pasta = device.product("Nudeln")
    device.sync(
        [create_rice, create_pasta, device.cmd("product.remove_barcode", product_id=pasta, barcode=EAN_A)]
    )
    assert device.products[rice]["barcodes"] == [EAN_A]


def test_a_freed_barcode_can_go_to_another_product_without_merging(make_device):
    device = make_device()
    rice, create_rice = device.product("Reis", barcodes=[EAN_A])
    pasta, create_pasta = device.product("Nudeln")
    device.sync(
        [
            create_rice,
            create_pasta,
            device.cmd("product.remove_barcode", product_id=rice, barcode=EAN_A),
            device.cmd("product.add_barcode", product_id=pasta, barcode=EAN_A),
        ]
    )
    assert device.products[rice]["barcodes"] == [] and device.products[rice]["deleted_at"] is None
    assert device.products[pasta]["barcodes"] == [EAN_A]


# --- 7.3 Zusammenführen ------------------------------------------------------------------


def test_two_devices_scan_the_same_unknown_barcode_offline(make_device, clock):
    """Beide legen einen Platzhalter an. Der Server führt zusammen, statt abzulehnen."""
    phone, tablet = make_device("Handy"), make_device("Tablet")
    clock.advance(3600)

    phone_product, phone_create = phone.product("", age=50, barcodes=[EAN_A])
    phone_package, phone_store = phone.package(phone_product, age=49)
    tablet_product, tablet_create = tablet.product("", age=40, barcodes=[EAN_A])
    tablet_package, tablet_store = tablet.package(tablet_product, age=39)
    rename = tablet.cmd("product.update", age=38, product_id=tablet_product, changes={"name": "Basmati Reis"})

    assert statuses(phone.sync([phone_create, phone_store])) == [("applied", None)] * 2
    data = tablet.sync([tablet_create, tablet_store, rename])
    assert statuses(data) == [("applied", None)] * 3

    # Das neue Produkt entstand als Quelle: Grabstein mit Verweis auf das Ziel, ohne Barcodes.
    source = tablet.products[tablet_product]
    assert source["deleted_at"] == clock.stamp(40)
    assert source["merged_into"] == phone_product
    assert source["barcodes"] == []
    # Der Besitzer des Barcodes ist das Ziel und bleibt.
    target = tablet.products[phone_product]
    assert target["deleted_at"] is None and target["barcodes"] == [EAN_A]
    # Die Packung und die Umbenennung mit der alten Kennung landen beim Ziel.
    assert tablet.packages[tablet_package]["product_id"] == phone_product
    assert target["name"] == "Basmati Reis"

    assert product_events(tablet, phone_product)[1:] == [
        (
            "product.merged",
            {"source_id": tablet_product, "reason": "barcode", "packages": 0, "barcodes": [], "filled": []},
        ),
        ("product.updated", {"changes": {"name": {"old": "", "new": "Basmati Reis"}}, "superseded": {}}),
    ]
    phone.sync()
    assert phone.packages[tablet_package]["product_id"] == phone_product
    assert phone.products[tablet_product]["merged_into"] == phone_product


def test_create_with_a_taken_barcode_fills_empty_fields_and_keeps_third_party_barcodes(make_device):
    device = make_device()
    owner, create_owner = device.product("", barcodes=[EAN_A])
    third, create_third = device.product("Nudeln", barcodes=[EAN_B])
    device.sync([create_owner, create_third])

    # EAN_C ist frei, EAN_A gehört dem Ziel, EAN_B einem dritten Produkt.
    new, create_new = device.product(
        "Reis", brand="Kornhaus", quantity="1 kg", warn_days=30, barcodes=[EAN_C, EAN_A, EAN_B]
    )
    assert statuses(device.sync([create_new])) == [("applied", None)]

    target = device.products[owner]
    assert target["barcodes"] == sorted([EAN_A, EAN_C])  # der freie Barcode gehört jetzt dem Ziel
    assert (target["name"], target["brand"], target["quantity"], target["warn_days"]) == (
        "Reis",
        "Kornhaus",
        "1 kg",
        30,
    )
    assert device.products[third]["barcodes"] == [EAN_B]  # bleibt, wo er ist
    assert device.products[new]["merged_into"] == owner
    assert product_events(device, owner)[-1] == (
        "product.merged",
        {
            "source_id": new,
            "reason": "barcode",
            "packages": 0,
            "barcodes": [EAN_C],
            "filled": ["brand", "name", "quantity", "warn_days"],
        },
    )


def test_add_barcode_with_a_taken_barcode_merges_the_owner_into_the_named_product(make_device):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    old, create_old = phone.product("Reis lose", brand="Kornhaus", barcodes=[EAN_A, EAN_B])
    kept, create_kept = phone.product("Basmati Reis")
    in_stock, store = phone.package(old)
    removed, store_removed = phone.package(old)
    phone.sync(
        [
            create_old,
            create_kept,
            store,
            store_removed,
            phone.cmd("package.remove", package_id=removed, reason="consumed"),
        ]
    )
    tablet.sync()

    add = tablet.cmd("product.add_barcode", product_id=kept, barcode=EAN_A)
    assert statuses(tablet.sync([add])) == [("applied", None)]

    # Der bisherige Besitzer ist die Quelle, das genannte Produkt das Ziel.
    assert tablet.products[old]["merged_into"] == kept
    assert tablet.products[old]["deleted_at"] is not None
    assert tablet.products[old]["barcodes"] == []
    target = tablet.products[kept]
    assert target["barcodes"] == sorted([EAN_A, EAN_B])  # alle Barcodes der Quelle
    assert (target["name"], target["brand"]) == ("Basmati Reis", "Kornhaus")  # nur das leere Feld gefüllt
    # Alle Packungen der Quelle, auch die entnommene.
    assert tablet.packages[in_stock]["product_id"] == kept
    assert tablet.packages[removed]["product_id"] == kept
    assert tablet.packages[removed]["removed_at"] is not None
    assert product_events(tablet, kept)[-1] == (
        "product.merged",
        {
            "source_id": old,
            "reason": "barcode",
            "packages": 2,
            "barcodes": sorted([EAN_A, EAN_B]),
            "filled": ["brand"],
        },
    )


def test_merging_by_hand(make_device, con, clock):
    device = make_device()
    source, create_source = device.product(
        "Reis lose", brand="Kornhaus", quantity="1 kg", warn_days=90, min_stock=3, barcodes=[EAN_A]
    )
    target, create_target = device.product("Basmati Reis", quantity="500 g", barcodes=[EAN_B])
    first, store_first = device.package(source)
    second, store_second = device.package(source)
    other, store_other = device.package(target)
    device.sync(
        [
            create_source,
            create_target,
            store_first,
            store_second,
            store_other,
            device.cmd("package.remove", package_id=second, reason="discarded"),
        ]
    )
    with con:
        con.execute("UPDATE products SET image = 'abc.jpg' WHERE id = ?", (source,))
    clock.advance(3600)

    merge = device.cmd("product.merge", age=30, source_id=source, target_id=target)
    data = device.sync([merge])
    assert statuses(data) == [("applied", None)]

    # 1. Alle Packungen der Quelle, auch entnommene, gehören zum Ziel.
    assert {device.packages[p]["product_id"] for p in (first, second, other)} == {target}
    assert device.packages[first]["updated_at"] == clock.stamp(30)
    # 2. Alle Barcodes der Quelle gehören zum Ziel.
    assert device.products[target]["barcodes"] == sorted([EAN_A, EAN_B])
    # 3. Leere Felder des Ziels übernehmen den Wert der Quelle; gefüllte bleiben.
    merged = device.products[target]
    assert (
        merged["name"],
        merged["brand"],
        merged["quantity"],
        merged["warn_days"],
        merged["image"],
        merged["min_stock"],
    ) == ("Basmati Reis", "Kornhaus", "500 g", 90, "abc.jpg", 3)
    assert merged["updated_at"] == clock.stamp(30)
    # 4. Die Quelle bekommt deleted_at und merged_into und hat keine Barcodes mehr.
    gone = device.products[source]
    assert gone["deleted_at"] == clock.stamp(30)
    assert (gone["merged_into"], gone["barcodes"], gone["name"]) == (target, [], "Reis lose")

    assert product_events(device, target)[-1] == (
        "product.merged",
        {
            "source_id": source,
            "reason": "user",
            "packages": 2,
            "barcodes": [EAN_A],
            "filled": ["brand", "image", "min_stock", "warn_days"],
        },
    )
    # Die Packungen eines Zusammenführens teilen sich einen rev und kommen gemeinsam.
    assert {package["id"] for package in data["changes"]["packages"]} == {first, second}


def test_later_references_to_a_merged_product_follow_merged_into(make_device):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    first, create_first = phone.product("Reis A")
    second, create_second = phone.product("Reis B")
    third, create_third = phone.product("Reis C")
    phone.sync([create_first, create_second, create_third])
    tablet.sync()

    # Über mehrere Schritte: A geht in B auf, B in C.
    phone.sync(
        [
            phone.cmd("product.merge", source_id=first, target_id=second),
            phone.cmd("product.merge", source_id=second, target_id=third),
        ]
    )

    # Das Tablet weiß davon nichts und arbeitet mit der alten Kennung weiter.
    package_id, store = tablet.package(first)
    moved, store_moved = tablet.package(third)
    data = tablet.sync(
        [
            store,
            tablet.cmd("product.update", product_id=first, changes={"brand": "Kornhaus"}),
            tablet.cmd("product.add_barcode", product_id=first, barcode=EAN_A),
            store_moved,
            tablet.cmd("package.update", package_id=moved, changes={"product_id": second}),
        ]
    )
    assert statuses(data) == [("applied", None)] * 5
    assert tablet.packages[package_id]["product_id"] == third
    assert tablet.packages[moved]["product_id"] == third
    assert tablet.products[third]["brand"] == "Kornhaus"
    assert tablet.products[third]["barcodes"] == [EAN_A]
    # Die Grabsteine bleiben unverändert und kommen immer mit.
    assert tablet.products[first]["merged_into"] == second
    assert tablet.products[second]["merged_into"] == third
    assert tablet.products[first]["brand"] == ""

    # Eine alte Kennung lässt sich nicht neu vergeben.
    assert statuses(tablet.sync([tablet.cmd("product.create", product_id=first, name="Neu")])) == [
        ("rejected", "id_conflict")
    ]


def test_merging_twice_or_in_opposite_directions(make_device):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    first, create_first = phone.product("Reis A", barcodes=[EAN_A])
    second, create_second = phone.product("Reis B", barcodes=[EAN_B])
    phone.sync([create_first, create_second])
    tablet.sync()

    assert statuses(phone.sync([phone.cmd("product.merge", source_id=first, target_id=second)])) == [
        ("applied", None)
    ]
    # Derselbe Wunsch vom zweiten Gerät und der umgekehrte: beides ohne Wirkung. Die erste
    # Zusammenführung gilt, sie lässt sich nicht rückgängig machen.
    data = tablet.sync(
        [
            tablet.cmd("product.merge", source_id=first, target_id=second),
            tablet.cmd("product.merge", source_id=second, target_id=first),
            tablet.cmd("product.merge", source_id=second, target_id=second),
        ]
    )
    assert statuses(data) == [("applied", None)] * 3
    assert tablet.products[first]["merged_into"] == second
    assert tablet.products[second]["deleted_at"] is None
    assert tablet.products[second]["barcodes"] == sorted([EAN_A, EAN_B])
    merged = [e for e in events_of(phone.client, phone, entity="product") if e["type"] == "product.merged"]
    assert len(merged) == 1


def test_merging_unknown_products_is_rejected(make_device):
    device = make_device()
    product_id, create = device.product("Reis")
    unknown = ids.new_uuid()
    data = device.sync(
        [
            create,
            device.cmd("product.merge", source_id=unknown, target_id=product_id),
            device.cmd("product.merge", source_id=product_id, target_id=unknown),
        ]
    )
    assert statuses(data) == [("applied", None), ("rejected", "not_found"), ("rejected", "not_found")]
    assert device.products[product_id]["deleted_at"] is None


def test_lookup_stays_none_while_open_food_facts_is_switched_off(make_device):
    device = make_device()
    with_code, create_code = device.product("", barcodes=[EAN_A])
    internal, create_internal = device.product("Hackfleisch", barcodes=[EAN_STORE])
    device.sync(
        [create_code, create_internal, device.cmd("product.add_barcode", product_id=internal, barcode=EAN_B)]
    )
    assert device.products[with_code]["lookup"] == "none"
    assert device.products[internal]["lookup"] == "none"
