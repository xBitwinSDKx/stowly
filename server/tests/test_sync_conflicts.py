"""Konfliktregeln für Packungen (docs/sync-protokoll.md, Abschnitte 4, 7.1 und 7.2).

Die Serveruhr steht in diesen Tests still (Fixture ``clock``). ``age`` ist das Alter
eines Befehls beim Absenden: Der wirksame Zeitpunkt ist dann genau ``clock.stamp(age)``.
Nach dem Anlegen der Ausgangslage rückt die Uhr eine Stunde vor (``clock.advance``),
damit auch ein „vor 60 Sekunden" noch nach dem Einlagern liegt: Die wirksamen Zeitpunkte
eines Geräts laufen nie rückwärts (Abschnitt 4), ein Befehl bekäme sonst den Zeitpunkt
des Einlagerns. Aus demselben Grund kommt eine Änderung, die älter ist als eine schon
verarbeitete, in diesen Tests immer von einem anderen Gerät: Ein Gerät sendet seine
Befehle in der Reihenfolge, in der sie entstanden sind.
"""

from support import events_of, statuses

from stowly.contract import ids

# --- 7.1 Feldänderungen: der spätere Zeitstempel gewinnt ----------------------------------


def test_the_later_change_wins_whatever_arrives_first(make_device, clock):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    _, package_id = phone.store("Reis", best_before="2027-01-01")
    _, other_id = phone.store("Nudeln", best_before="2027-01-01")
    tablet.sync()
    clock.advance(3600)

    old = phone.cmd("package.update", age=60, package_id=package_id, changes={"best_before": "2027-06-06"})
    new = tablet.cmd("package.update", age=5, package_id=package_id, changes={"best_before": "2027-05-05"})
    # Die jüngere Änderung trifft zuerst ein, die ältere danach: Sie verliert.
    assert statuses(tablet.sync([new])) == [("applied", None)]
    data = phone.sync([old])
    assert statuses(data) == [("applied", None)]  # verarbeitet; dass das Feld verlor, ist kein Fehler
    assert phone.packages[package_id]["best_before"] == "2027-05-05"

    # Umgekehrte Reihenfolge des Eintreffens, gleiches Ergebnis.
    old = phone.cmd("package.update", age=60, package_id=other_id, changes={"best_before": "2027-06-06"})
    new = tablet.cmd("package.update", age=5, package_id=other_id, changes={"best_before": "2027-05-05"})
    phone.sync([old])
    tablet.sync([new])
    phone.sync()
    assert phone.packages[other_id]["best_before"] == tablet.packages[other_id]["best_before"] == "2027-05-05"


def test_the_loser_gets_the_winning_record_back(make_device, clock):
    """Echo: Wer verliert, bekommt in derselben Antwort den Stand des Servers."""
    phone, tablet = make_device("Handy"), make_device("Tablet")
    _, package_id = phone.store("Reis")
    tablet.sync()
    clock.advance(3600)
    tablet.sync(
        [tablet.cmd("package.update", age=5, package_id=package_id, changes={"best_before": "2027-05-05"})]
    )
    phone.sync()  # das Handy kennt die Änderung des Tablets schon

    late = phone.cmd("package.update", age=600, package_id=package_id, changes={"best_before": "2027-06-06"})
    data = phone.sync([late])
    assert [package["best_before"] for package in data["changes"]["packages"]] == ["2027-05-05"]


def test_different_fields_of_one_package_both_apply(make_device, clock):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    _, package_id = phone.store("Reis")
    cellar = ids.new_uuid()
    tablet.sync([tablet.cmd("zone.create", zone_id=cellar, name="Keller")])
    phone.sync()
    clock.advance(3600)

    move = tablet.cmd("package.update", age=5, package_id=package_id, changes={"zone_id": cellar})
    date = phone.cmd("package.update", age=60, package_id=package_id, changes={"best_before": "2027-06-06"})
    tablet.sync([move])
    phone.sync([date])

    package = phone.packages[package_id]
    assert (package["zone_id"], package["best_before"]) == (cellar, "2027-06-06")
    # updated_at ist der späteste wirksame Zeitpunkt einer angewendeten Änderung.
    assert package["updated_at"] == clock.stamp(5)


def test_at_the_same_instant_the_later_processed_change_wins(make_device, clock):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    _, package_id = phone.store("Reis")
    tablet.sync()
    clock.advance(3600)

    first = phone.cmd("package.update", age=30, package_id=package_id, changes={"best_before": "2027-01-01"})
    second = tablet.cmd(
        "package.update", age=30, package_id=package_id, changes={"best_before": "2027-02-02"}
    )
    phone.sync([first])
    tablet.sync([second])
    assert tablet.packages[package_id]["best_before"] == "2027-02-02"

    third = phone.cmd("package.update", age=30, package_id=package_id, changes={"best_before": "2027-03-03"})
    phone.sync([third])
    assert phone.packages[package_id]["best_before"] == "2027-03-03"


def test_overwritten_and_superseded_values_are_in_the_event_log(make_device, clock):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    _, package_id = phone.store("Reis", best_before="2027-01-01")
    tablet.sync()
    clock.advance(3600)

    new = tablet.cmd("package.update", age=5, package_id=package_id, changes={"best_before": "2027-05-05"})
    old = phone.cmd(
        "package.update",
        age=60,
        package_id=package_id,
        changes={"best_before": "2027-06-06", "zone_id": phone.zone_id},
    )
    tablet.sync([new])
    phone.sync([old])

    updates = [
        e
        for e in events_of(phone.client, phone, entity="package", entity_id=package_id)
        if e["type"] == "package.updated"
    ]
    assert [(e["device_id"], e["command_id"], e["at"], e["data"]) for e in updates] == [
        (
            tablet.id,
            new["id"],
            clock.stamp(5),
            {"changes": {"best_before": {"old": "2027-01-01", "new": "2027-05-05"}}, "superseded": {}},
        ),
        # Die ältere Änderung hat beim MHD verloren; die Zone galt, blieb aber dieselbe.
        (phone.id, old["id"], clock.stamp(60), {"changes": {}, "superseded": {"best_before": "2027-06-06"}}),
    ]
    assert all(e["recorded_at"] == clock.stamp() for e in updates)


def test_null_is_a_value_and_absent_keys_stay_untouched(make_device):
    device = make_device()
    _, package_id = device.store("Reis", best_before="2027-01-01")
    device.sync([device.cmd("package.update", package_id=package_id, changes={})])
    assert device.packages[package_id]["best_before"] == "2027-01-01"
    device.sync([device.cmd("package.update", package_id=package_id, changes={"best_before": None})])
    assert device.packages[package_id]["best_before"] is None


def test_updates_referring_to_unknown_things_are_rejected(make_device):
    device = make_device()
    _, package_id = device.store("Reis", best_before="2027-01-01")
    data = device.sync(
        [
            device.cmd("package.update", package_id="ZZZZZ", changes={"best_before": None}),
            device.cmd("package.update", package_id=package_id, changes={"zone_id": ids.new_uuid()}),
            device.cmd(
                "package.update",
                package_id=package_id,
                changes={"best_before": None, "product_id": ids.new_uuid()},
            ),
        ]
    )
    assert statuses(data) == [("rejected", "not_found")] * 3
    # Abgelehnt heißt: gar nicht ausgeführt, auch nicht das gültige Feld daneben.
    assert device.packages[package_id]["best_before"] == "2027-01-01"


# --- Abschnitt 4: Der Server vertraut nur dem Alter eines Befehls ------------------------


def test_a_device_clock_running_fast_does_not_win(make_device, clock):
    phone = make_device("Handy")
    fast = make_device("Tablet mit falscher Uhr", clock_offset_s=3600)
    _, package_id = phone.store("Reis")
    fast.sync()
    clock.advance(3600)

    # Das Tablet ändert zuerst (vor 60 s), das Handy danach (vor 5 s). Die Uhr des Tablets
    # geht eine Stunde vor: Sein „at" liegt weit nach dem des Handys.
    early = fast.cmd("package.update", age=60, package_id=package_id, changes={"best_before": "2027-01-01"})
    late = phone.cmd("package.update", age=5, package_id=package_id, changes={"best_before": "2027-02-02"})
    assert early["at"] > late["at"]

    phone.sync([late])
    fast.sync([early])
    assert fast.packages[package_id]["best_before"] == "2027-02-02"
    assert fast.packages[package_id]["updated_at"] == clock.stamp(5)


def test_effective_time_is_server_time_never_device_time(make_device, clock, con):
    slow = make_device("Uhr geht nach", clock_offset_s=-86400)
    fast = make_device("Uhr geht vor", clock_offset_s=7200)
    _, first = slow.store("Reis")
    _, second = fast.store("Nudeln")
    slow.sync()
    # Beide eben eingelagert: created_at ist die Serverzeit, bei beiden dieselbe.
    assert slow.packages[first]["created_at"] == slow.packages[second]["created_at"] == clock.stamp()
    clock.advance(3600)

    # Alter 90 s: Der Befehl gilt 90 s vor dem Empfang, gleich was die Geräteuhr sagt.
    product_id, create = fast.product("Mehl", age=90)
    fast.sync([create])
    assert fast.products[product_id]["created_at"] == clock.stamp(90)

    # „at" nach „sent_at" (Uhr zwischen Änderung und Absenden zurückgestellt): Alter 0, nie Zukunft.
    product_id, create = fast.product("Zucker", age=-500)
    fast.sync([create])
    assert fast.products[product_id]["created_at"] == clock.stamp()


# --- 7.2 Löschen gewinnt gegen Bearbeiten ------------------------------------------------


def test_removing_a_package(make_device, clock):
    device = make_device()
    product_id, package_id = device.store("Reis", best_before="2027-01-01")
    clock.advance(3600)
    remove = device.cmd("package.remove", age=20, package_id=package_id, reason="consumed")
    assert statuses(device.sync([remove])) == [("applied", None)]

    package = device.packages[package_id]
    assert package["removed_at"] == clock.stamp(20)
    assert package["removal_reason"] == "consumed"
    assert package["displaced"] is None

    removed = [
        e for e in events_of(device.client, device, entity="package") if e["type"] == "package.removed"
    ]
    assert [(e["entity_id"], e["at"], e["data"]) for e in removed] == [
        (
            package_id,
            clock.stamp(20),
            {
                "reason": "consumed",
                "product_id": product_id,
                "zone_id": device.zone_id,
                "best_before": "2027-01-01",
            },
        )
    ]


def test_an_edit_after_removal_is_displaced(make_device, clock):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    product_id, package_id = phone.store("Reis", best_before="2027-01-01")
    tablet.sync()
    clock.advance(3600)

    phone.sync([phone.cmd("package.remove", age=30, package_id=package_id, reason="consumed")])
    # Das Tablet weiß noch nichts davon und bearbeitet die Packung.
    edit = tablet.cmd("package.update", age=10, package_id=package_id, changes={"best_before": "2027-09-09"})
    data = tablet.sync([edit])

    assert data["results"][0]["status"] == "displaced"
    assert data["results"][0]["code"] is None
    package = tablet.packages[package_id]
    assert package["best_before"] == "2027-01-01"  # nicht angewendet
    assert package["removed_at"] == clock.stamp(30)
    assert package["displaced"] == {
        "at": clock.stamp(10),
        "changes": [{"field": "best_before", "value": "2027-09-09"}],
    }

    displaced = [
        e for e in events_of(phone.client, phone, entity="package") if e["type"] == "package.edit_displaced"
    ]
    assert [(e["device_id"], e["data"]) for e in displaced] == [
        (tablet.id, {"changes": {"best_before": "2027-09-09"}})
    ]
    # Auch dieses Ergebnis ist gespeichert.
    again = tablet.sync([edit])["results"][0]
    assert (again["status"], again["duplicate"]) == ("displaced", True)


def test_an_edit_is_displaced_whatever_its_timestamp(make_device):
    """Die Packung ist physisch weg: Auch eine Bearbeitung von vor dem Entnehmen wird nicht angewendet."""
    phone, tablet = make_device("Handy"), make_device("Tablet")
    _, package_id = phone.store("Reis", best_before="2027-01-01")
    tablet.sync()
    phone.sync([phone.cmd("package.remove", age=30, package_id=package_id, reason="discarded")])

    before = tablet.cmd(
        "package.update", age=500, package_id=package_id, changes={"best_before": "2027-08-08"}
    )
    assert tablet.sync([before])["results"][0]["status"] == "displaced"
    assert tablet.packages[package_id]["best_before"] == "2027-01-01"
    assert tablet.packages[package_id]["displaced"]["changes"] == [
        {"field": "best_before", "value": "2027-08-08"}
    ]


def test_an_empty_edit_of_a_removed_package_is_displaced_too(make_device):
    device = make_device()
    _, package_id = device.store("Reis", best_before="2027-01-01")
    device.sync([device.cmd("package.remove", package_id=package_id, reason="consumed")])
    data = device.sync([device.cmd("package.update", package_id=package_id, changes={})])
    assert data["results"][0]["status"] == "displaced"
    assert device.packages[package_id]["displaced"] is None  # nichts aufzuheben


def test_a_displaced_edit_is_kept_as_wanted_and_checked_only_when_applied(make_device):
    """Nicht angewendet heißt auch: nicht geprüft. Verweisen folgt erst das Wiederherstellen."""
    device = make_device()
    home = device.zone_id
    _, package_id = device.store("Reis", best_before="2027-01-01")
    nowhere = ids.new_uuid()
    device.sync([device.cmd("package.remove", package_id=package_id, reason="consumed")])
    data = device.sync(
        [
            device.cmd(
                "package.update",
                package_id=package_id,
                changes={"zone_id": nowhere, "best_before": "2027-09-09"},
            )
        ]
    )
    assert data["results"][0]["status"] == "displaced"
    assert device.packages[package_id]["displaced"]["changes"] == [
        {"field": "best_before", "value": "2027-09-09"},
        {"field": "zone_id", "value": nowhere},
    ]

    # Beim Übernehmen gilt, was sich anwenden lässt; die Zone, die es nicht gibt, bleibt außen vor.
    data = device.sync([device.cmd("package.restore", package_id=package_id, apply_displaced=True)])
    assert statuses(data) == [("applied", None)]
    package = device.packages[package_id]
    assert (package["removed_at"], package["best_before"], package["zone_id"]) == (None, "2027-09-09", home)
    assert package["displaced"] is None


def test_a_displaced_edit_follows_deleted_zones_and_merged_products_when_applied(make_device):
    device = make_device()
    home = device.zone_id
    product_id, package_id = device.store("Reis lose")
    cellar, attic, target = ids.new_uuid(), ids.new_uuid(), ids.new_uuid()
    device.sync(
        [
            device.cmd("zone.create", zone_id=cellar, name="Keller"),
            device.cmd("zone.create", zone_id=attic, name="Dachboden"),
            device.cmd("product.create", product_id=target, name="Basmati Reis"),
            device.cmd("package.remove", package_id=package_id, reason="consumed"),
            device.cmd("package.update", package_id=package_id, changes={"zone_id": cellar}),
            # Erst danach verschwindet die gewünschte Zone, und das Produkt geht in einem anderen auf.
            device.cmd("zone.delete", zone_id=cellar, move_to=attic),
            device.cmd("product.merge", source_id=product_id, target_id=target),
            device.cmd("package.restore", package_id=package_id, apply_displaced=True),
        ]
    )
    package = device.packages[package_id]
    assert (package["zone_id"], package["product_id"], package["removed_at"]) == (attic, target, None)
    assert home != attic


def test_several_displaced_edits_keep_the_later_value_per_field(make_device, clock):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    product_id, package_id = phone.store("Reis", best_before="2027-01-01")
    other_product, create = phone.product("Nudeln")
    cellar = ids.new_uuid()
    phone.sync([create, phone.cmd("zone.create", zone_id=cellar, name="Keller")])
    tablet.sync()
    clock.advance(3600)
    phone.sync([phone.cmd("package.remove", age=100, package_id=package_id, reason="consumed")])

    tablet.sync(
        [
            tablet.cmd(
                "package.update",
                age=20,
                package_id=package_id,
                changes={"best_before": "2027-02-02", "zone_id": cellar},
            )
        ]
    )
    # Älter beim MHD (verliert), neu beim Produkt (kommt dazu).
    phone.sync(
        [
            phone.cmd(
                "package.update",
                age=50,
                package_id=package_id,
                changes={"best_before": "2027-03-03", "product_id": other_product},
            )
        ]
    )
    assert phone.packages[package_id]["displaced"] == {
        "at": clock.stamp(20),
        "changes": [
            {"field": "best_before", "value": "2027-02-02"},
            {"field": "zone_id", "value": cellar},
            {"field": "product_id", "value": other_product},
        ],
    }
    # Jünger beim MHD: ersetzt den Wert.
    phone.sync([phone.cmd("package.update", age=5, package_id=package_id, changes={"best_before": None})])
    assert phone.packages[package_id]["displaced"]["at"] == clock.stamp(5)
    assert phone.packages[package_id]["displaced"]["changes"][0] == {"field": "best_before", "value": None}


def test_restore_without_the_displaced_edit(make_device, clock):
    device = make_device()
    _, package_id = device.store("Reis", best_before="2027-01-01")
    clock.advance(3600)
    device.sync(
        [
            device.cmd("package.remove", age=30, package_id=package_id, reason="consumed"),
            device.cmd(
                "package.update", age=20, package_id=package_id, changes={"best_before": "2027-09-09"}
            ),
        ]
    )
    assert device.packages[package_id]["displaced"] is not None

    restore = device.cmd("package.restore", age=10, package_id=package_id)
    assert statuses(device.sync([restore])) == [("applied", None)]
    package = device.packages[package_id]
    assert package["removed_at"] is None and package["removal_reason"] is None
    assert package["displaced"] is None  # in jedem Fall danach null
    assert package["best_before"] == "2027-01-01"
    assert package["updated_at"] == clock.stamp(10)

    restored = [
        e for e in events_of(device.client, device, entity="package") if e["type"] == "package.restored"
    ]
    assert [e["data"] for e in restored] == [{"applied_displaced": False}]


def test_restore_with_the_displaced_edit(make_device, clock):
    device, other = make_device(), make_device("Tablet")
    _, package_id = device.store("Reis", best_before="2027-01-01")
    home, cellar = device.zone_id, ids.new_uuid()
    other.sync()
    clock.advance(3600)
    device.sync(
        [
            device.cmd("zone.create", age=40, zone_id=cellar, name="Keller"),
            device.cmd("package.remove", age=30, package_id=package_id, reason="mistake"),
            device.cmd(
                "package.update",
                age=20,
                package_id=package_id,
                changes={"best_before": "2027-09-09", "zone_id": cellar},
            ),
        ]
    )
    restore = device.cmd("package.restore", age=10, package_id=package_id, apply_displaced=True)
    assert statuses(device.sync([restore])) == [("applied", None)]

    package = device.packages[package_id]
    assert package["removed_at"] is None and package["displaced"] is None
    assert (package["best_before"], package["zone_id"]) == ("2027-09-09", cellar)

    log = [
        e
        for e in events_of(device.client, device, entity="package", entity_id=package_id)
        if e["command_id"] == restore["id"]
    ]
    assert [(e["type"], e["data"]) for e in log] == [
        ("package.restored", {"applied_displaced": True}),
        (
            "package.updated",
            {
                "changes": {
                    "best_before": {"old": "2027-01-01", "new": "2027-09-09"},
                    "zone_id": {"old": home, "new": cellar},
                },
                "superseded": {},
            },
        ),
    ]
    # Die verdrängten Werte gelten mit dem Zeitpunkt des Wiederherstellens: Eine Änderung
    # von davor, die erst jetzt von einem anderen Gerät eintrifft, verliert gegen sie.
    stale = other.cmd("package.update", age=15, package_id=package_id, changes={"best_before": "2027-04-04"})
    other.sync([stale])
    assert other.packages[package_id]["best_before"] == "2027-09-09"


def test_apply_displaced_without_a_displaced_edit_just_restores(make_device):
    device = make_device()
    _, package_id = device.store("Reis", best_before="2027-01-01")
    device.sync([device.cmd("package.remove", age=30, package_id=package_id, reason="consumed")])
    device.sync([device.cmd("package.restore", age=10, package_id=package_id, apply_displaced=True)])
    assert device.packages[package_id]["removed_at"] is None
    restored = [
        e for e in events_of(device.client, device, entity="package") if e["type"] == "package.restored"
    ]
    assert [e["data"] for e in restored] == [{"applied_displaced": False}]


def test_restoring_a_package_that_is_not_removed_does_nothing(make_device):
    device = make_device()
    _, package_id = device.store("Reis")
    data = device.sync([device.cmd("package.restore", package_id=package_id)])
    assert statuses(data) == [("applied", None)]
    assert device.packages[package_id]["removed_at"] is None
    assert statuses(device.sync([device.cmd("package.restore", package_id="ZZZZZ")])) == [
        ("rejected", "not_found")
    ]


def test_remove_against_restore_the_later_one_wins(make_device, clock):
    phone, tablet = make_device("Handy"), make_device("Tablet")
    _, kept = phone.store("Reis")
    _, gone = phone.store("Nudeln")
    clock.advance(3600)
    phone.sync(
        [
            phone.cmd("package.remove", age=100, package_id=kept, reason="consumed"),
            phone.cmd("package.remove", age=100, package_id=gone, reason="consumed"),
        ]
    )
    tablet.sync()

    # Wiederherstellen (vor 5 s) trifft vor einem Entnehmen von davor (vor 50 s) ein: bleibt da.
    tablet.sync([tablet.cmd("package.restore", age=5, package_id=kept)])
    data = phone.sync([phone.cmd("package.remove", age=50, package_id=kept, reason="discarded")])
    assert statuses(data) == [("applied", None)]
    assert phone.packages[kept]["removed_at"] is None
    assert phone.packages[kept]["removal_reason"] is None

    # Wiederherstellen (vor 50 s) trifft nach einem Entnehmen von danach (vor 5 s) ein: bleibt weg.
    tablet.sync([tablet.cmd("package.remove", age=5, package_id=gone, reason="discarded")])
    phone.sync([phone.cmd("package.restore", age=50, package_id=gone)])
    assert phone.packages[gone]["removed_at"] == clock.stamp(100)
    assert phone.packages[gone]["removal_reason"] == "discarded"


def test_a_restore_also_beats_a_removal_that_arrives_later(make_device, clock):
    """Unabhängig von der Reihenfolge des Eintreffens: erst das Wiederherstellen, dann das ältere Entnehmen."""
    phone, tablet = make_device("Handy"), make_device("Tablet")
    _, package_id = phone.store("Reis")
    tablet.sync()
    clock.advance(3600)
    # Das Tablet stellt wieder her (vor 5 s); auf dem Server ist die Packung noch gar nicht entnommen.
    tablet.sync([tablet.cmd("package.restore", age=5, package_id=package_id)])
    phone.sync([phone.cmd("package.remove", age=50, package_id=package_id, reason="consumed")])
    assert phone.packages[package_id]["removed_at"] is None


def test_removing_again_only_changes_the_reason(make_device, clock):
    device = make_device()
    _, package_id = device.store("Reis")
    clock.advance(3600)
    device.sync([device.cmd("package.remove", age=60, package_id=package_id, reason="consumed")])
    removed_at = device.packages[package_id]["removed_at"]
    assert removed_at == clock.stamp(60)

    again = device.cmd("package.remove", age=10, package_id=package_id, reason="discarded")
    assert statuses(device.sync([again])) == [("applied", None)]
    package = device.packages[package_id]
    assert package["removed_at"] == removed_at  # bleibt der Zeitpunkt des Entnehmens
    assert package["removal_reason"] == "discarded"

    changed = [
        e for e in events_of(device.client, device, entity="package") if e["type"] == "package.reason_changed"
    ]
    assert [(e["command_id"], e["data"]) for e in changed] == [
        (again["id"], {"old": "consumed", "new": "discarded"})
    ]
    # Kein zweites „entnommen": Die Statistik zählt die Packung einmal.
    assert (
        len([e for e in events_of(device.client, device, entity="package") if e["type"] == "package.removed"])
        == 1
    )


def test_undo_wins_even_if_the_device_clock_was_set_back(make_device, clock):
    """Entnehmen und Rückgängig in einer Anfrage; ``at`` des Rückgängig liegt vor dem des Entnehmens.

    Die Outbox ist die Reihenfolge, in der der Anwender gehandelt hat. Innerhalb einer
    Anfrage laufen die wirksamen Zeitpunkte deshalb nie rückwärts.
    """
    device = make_device()
    _, package_id = device.store("Reis")

    # Entnommen um 12:00 nach der alten Uhr, dann Uhr eine Stunde zurück, Rückgängig um 11:00:05.
    remove = device.cmd("package.remove", age=-3595, package_id=package_id, reason="consumed")
    restore = device.cmd("package.restore", age=5, package_id=package_id)
    assert restore["at"] < remove["at"]

    data = device.sync([remove, restore])
    assert statuses(data) == [("applied", None), ("applied", None)]
    assert device.packages[package_id]["removed_at"] is None

    log = [e for e in events_of(device.client, device, entity="package", entity_id=package_id)]
    assert [e["type"] for e in log] == ["package.created", "package.removed", "package.restored"]
    # Das Rückgängig bekam mindestens den wirksamen Zeitpunkt des Entnehmens davor.
    assert log[1]["at"] == log[2]["at"] == clock.stamp()


def test_undo_wins_although_the_removal_was_under_way_for_longer(make_device, clock):
    """Das Beispiel aus Abschnitt 4: Der wirksame Zeitpunkt enthält die Laufzeit der Anfrage.

    Entnehmen bei t, die Anfrage ist fünf Sekunden unterwegs. Das Rückgängig entsteht bei
    t + 2 s und kommt in einer zweiten, schnellen Anfrage. Nach dem Alter allein läge es
    vor dem Entnehmen und verlöre; die Untergrenze je Gerät hält die Reihenfolge, in der
    der Anwender gehandelt hat.
    """
    device = make_device()
    _, package_id = device.store("Reis")
    clock.advance(3600)

    # t: Der Anwender entnimmt, die App sendet sofort ab.
    remove = device.cmd("package.remove", package_id=package_id, reason="consumed")
    slow = device.request([remove])
    # t + 2 s: „Rückgängig".
    clock.advance(2)
    restore = device.cmd("package.restore", package_id=package_id)
    # t + 5 s: Erst jetzt kommt die erste Anfrage beim Server an.
    clock.advance(3)
    removed_at = clock.stamp()
    response = device.client.post("/api/sync", json=slow, headers=device.headers)
    assert response.status_code == 200
    device.apply(response.json())
    assert device.packages[package_id]["removed_at"] == removed_at

    # t + 5,5 s: Die zweite Anfrage geht hinaus und ist nach 50 ms da. Ihr Befehl ist 3,5 s alt.
    clock.advance(0.5)
    fast = device.request([restore])
    clock.advance(0.05)
    assert clock.stamp(3.5) < removed_at  # nach dem Alter allein: vor dem Entnehmen
    response = device.client.post("/api/sync", json=fast, headers=device.headers)
    assert response.status_code == 200
    device.apply(response.json())

    assert statuses(response.json()) == [("applied", None)]
    assert device.packages[package_id]["removed_at"] is None
    log = events_of(device.client, device, entity="package", entity_id=package_id)
    assert [e["type"] for e in log] == ["package.created", "package.removed", "package.restored"]
    # Das Rückgängig bekam den wirksamen Zeitpunkt des Entnehmens davor.
    assert log[1]["at"] == log[2]["at"] == removed_at


def test_the_floor_holds_across_requests_when_the_device_clock_was_set_back(make_device, clock):
    """Dieselben zwei Befehle wie oben, nur in zwei Anfragen: Auch dann gewinnt das Rückgängig."""
    device = make_device()
    _, package_id = device.store("Reis")
    device.sync([device.cmd("package.remove", age=-3595, package_id=package_id, reason="consumed")])
    device.sync([device.cmd("package.restore", age=5, package_id=package_id)])
    assert device.packages[package_id]["removed_at"] is None


def test_the_floor_belongs_to_one_device(make_device, clock):
    """Gegenprobe: Zwischen zwei Geräten zählt allein das Alter, das frühere Rückgängig verliert."""
    phone, tablet = make_device("Handy"), make_device("Tablet")
    _, package_id = phone.store("Reis")
    tablet.sync()
    clock.advance(3600)
    phone.sync([phone.cmd("package.remove", package_id=package_id, reason="consumed")])
    tablet.sync([tablet.cmd("package.restore", age=5, package_id=package_id)])
    assert tablet.packages[package_id]["removed_at"] == clock.stamp()


def test_the_floor_is_the_last_valid_command_of_the_device(make_device, clock, con):
    def stored(device) -> str | None:
        return con.execute("SELECT last_command_at FROM devices WHERE id = ?", (device.id,)).fetchone()[0]

    device, idle = make_device("Handy"), make_device("Tablet")
    assert stored(device) is None and stored(idle) is None

    clock.advance(3600)
    _, create = device.product("Reis", age=100)
    device.sync([create])
    assert stored(device) == clock.stamp(100)
    assert stored(idle) is None

    # Ein Befehl, der schon an der Form scheitert, hat keinen wirksamen Zeitpunkt und zählt nicht.
    broken = device.cmd("product.create", age=10, product_id="keine-uuid", name="Kaputt")
    assert statuses(device.sync([broken])) == [("rejected", "invalid")]
    assert stored(device) == clock.stamp(100)

    # Ein abgelehnter, aber gültiger Befehl zählt: Er hat einen wirksamen Zeitpunkt.
    missing = device.cmd("package.remove", age=50, package_id="ZZZZZ", reason="consumed")
    assert statuses(device.sync([missing])) == [("rejected", "not_found")]
    assert stored(device) == clock.stamp(50)

    # Ein Abgleich ohne Befehle ändert nichts.
    device.sync()
    assert stored(device) == clock.stamp(50)

    # Der nächste Befehl wäre nach seinem Alter früher: Er bekommt die Untergrenze.
    product_id, create = device.product("Nudeln", age=80)
    device.sync([create])
    assert device.products[product_id]["created_at"] == clock.stamp(50)


def test_a_floor_from_the_future_is_capped_at_the_receive_time(make_device, clock):
    """Die Uhr des Servers wurde zurückgestellt: Wirksame Zeitpunkte liegen trotzdem nie in der Zukunft."""
    device = make_device()
    first_id, first = device.product("Reis")
    device.sync([first])
    wrong = clock.stamp()

    clock.advance(-3600)  # die Serveruhr ging eine Stunde vor und ist jetzt berichtigt
    second_id, second = device.product("Nudeln")
    device.sync([second])
    assert device.products[first_id]["created_at"] == wrong
    assert device.products[second_id]["created_at"] == clock.stamp()
    assert device.products[second_id]["created_at"] < wrong


def test_the_floor_also_holds_behind_a_command_that_was_already_processed(make_device, clock):
    """Antwort verloren: Das Entnehmen ist beim zweiten Versuch schon bekannt, das Rückgängig neu."""
    device = make_device()
    _, package_id = device.store("Reis")
    remove = device.cmd("package.remove", age=-3595, package_id=package_id, reason="consumed")
    restore = device.cmd("package.restore", age=5, package_id=package_id)
    device.post([remove])  # verbucht, die Antwort kommt nie an

    clock.advance(2)
    data = device.sync([remove, restore])
    assert [(r["status"], r["duplicate"]) for r in data["results"]] == [("applied", True), ("applied", False)]
    assert device.packages[package_id]["removed_at"] is None


def test_effective_times_never_run_backwards_within_a_request(make_device, clock, con):
    device = make_device()
    first_id, first = device.product("Erstes", age=10)
    second_id, second = device.product("Zweites", age=500)  # Uhr dazwischen verstellt
    third_id, third = device.product("Drittes", age=3)
    device.sync([first, second, third])
    assert device.products[first_id]["created_at"] == clock.stamp(10)
    assert device.products[second_id]["created_at"] == clock.stamp(10)  # mindestens der Vorgänger
    assert device.products[third_id]["created_at"] == clock.stamp(3)
