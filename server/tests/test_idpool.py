"""ID-Vorrat und doppelte Kennungen (docs/sync-protokoll.md, Abschnitte 7.5 und 8)."""

import itertools

import pytest
from support import Device, events_of, statuses

from stowly.contract import ID_POOL_TARGET, ids
from stowly.sync import changes


@pytest.fixture
def scripted_ids(monkeypatch):
    """Ersetzt den Zufall durch eine vorgegebene Folge, danach fortlaufende IDs."""

    def install(first: list[str]) -> None:
        alphabet = ids.PACKAGE_ID_ALPHABET
        counter = ("".join(chars) for chars in itertools.product(alphabet, repeat=ids.PACKAGE_ID_LENGTH))
        sequence = itertools.chain(first, counter)
        monkeypatch.setattr(ids, "random_package_id", lambda: next(sequence))

    return install


def reserved(con, device_id: str | None = None) -> set[str]:
    if device_id is None:
        rows = con.execute("SELECT package_id FROM id_reservations")
    else:
        rows = con.execute("SELECT package_id FROM id_reservations WHERE device_id = ?", (device_id,))
    return {row[0] for row in rows}


def test_the_first_sync_fills_the_pool(make_device, con):
    device = make_device(sync=False)
    data = device.sync()
    grant = data["id_pool"]["grant"]
    assert data["id_pool"]["target"] == ID_POOL_TARGET == 300
    assert len(grant) == len(set(grant)) == 300
    assert all(ids.is_package_id(package_id) for package_id in grant)
    assert reserved(con, device.id) == set(grant)


def test_each_sync_tops_the_pool_up_to_300(make_device, con):
    device = make_device()
    assert device.sync()["id_pool"]["grant"] == []  # voll: nichts Neues

    used = [device.pool.pop() for _ in range(13)]
    data = device.sync()
    assert len(data["id_pool"]["grant"]) == 13
    assert len(device.pool) == 300
    assert not set(data["id_pool"]["grant"]) & set(used)

    assert len(device.sync(id_pool={"have": 0})["id_pool"]["grant"]) == 300
    assert len(device.sync(id_pool={"have": 299})["id_pool"]["grant"]) == 1
    assert device.sync(id_pool={"have": 300})["id_pool"]["grant"] == []
    assert device.sync(id_pool={"have": 5000})["id_pool"]["grant"] == []


def test_two_devices_never_get_the_same_id(make_device, con, scripted_ids):
    phone = make_device("Handy")
    # Der „Zufall" zieht für das Tablet zuerst lauter IDs, die schon das Handy hat.
    scripted_ids(list(phone.pool))
    tablet = make_device("Tablet")

    assert len(tablet.pool) == 300
    assert not set(phone.pool) & set(tablet.pool)
    assert reserved(con, phone.id) == set(phone.pool)
    assert reserved(con, tablet.id) == set(tablet.pool)


def test_an_id_that_is_already_a_package_is_never_granted(make_device, con, scripted_ids):
    phone = make_device("Handy")
    product_id, create = phone.product("Reis")
    # Vorrat leer: Die App würfelt selbst (randomPackageId). Diese IDs kennt der Server nur als Packung.
    taken = ["A2B3C", "7K9QX", "ZZZZZ"]
    phone.sync([create, *[phone.package(product_id, package_id=package_id)[1] for package_id in taken]])

    scripted_ids(taken + taken)  # auch zweimal gezogen wird keine vergeben
    tablet = make_device("Tablet")
    assert len(tablet.pool) == 300
    assert not set(taken) & set(tablet.pool)


def test_the_reservation_ends_when_the_package_is_created(make_device, con):
    device = make_device()
    product_id, create = device.product("Reis")
    package_id, store = device.package(product_id)
    assert package_id in reserved(con)
    device.sync([create, store])
    assert package_id not in reserved(con)
    assert len(reserved(con, device.id)) == 300  # 299 alte und eine neue


def test_whoever_creates_a_free_id_first_gets_it(make_device, con):
    """Die Reservierung schützt nur vor doppelter Zuteilung, nicht vor dem Anlegen durch andere."""
    phone, tablet = make_device("Handy"), make_device("Tablet")
    product_id, create = tablet.product("Reis")
    borrowed = phone.pool[0]
    assert borrowed in reserved(con, phone.id)

    data = tablet.sync([create, tablet.package(product_id, package_id=borrowed)[1]])
    assert statuses(data) == [("applied", None)] * 2
    assert borrowed not in reserved(con)

    # Das Handy kommt mit derselben ID zu spät: Das darf nicht still geheilt werden,
    # das Etikett ist bereits gedruckt.
    late = phone.package(product_id, package_id=borrowed)[1]
    data = phone.sync([late])
    assert statuses(data) == [("rejected", "id_conflict")]
    assert data["results"][0]["message"] == "Diese Packungs-ID ist schon vergeben."
    assert con.execute("SELECT created_by FROM packages WHERE id = ?", (borrowed,)).fetchone()[0] == tablet.id
    rejected = [
        e
        for e in events_of(phone.client, phone, entity="package", entity_id=borrowed)
        if e["type"] == "command.rejected"
    ]
    assert [(e["device_id"], e["data"]["code"]) for e in rejected] == [(phone.id, "id_conflict")]


def test_a_package_id_is_never_reused_even_after_removal(make_device):
    device = make_device()
    product_id, package_id = device.store("Reis")
    device.sync([device.cmd("package.remove", package_id=package_id, reason="consumed")])
    again = device.package(product_id, package_id=package_id)[1]
    assert statuses(device.sync([again])) == [("rejected", "id_conflict")]


def test_a_device_that_signs_in_again_can_still_use_its_old_ids(make_device, client, clock, con):
    """Nach einer Sperre behält die App Daten, Outbox und Vorrat und meldet sich neu an."""
    old = make_device("Handy")
    product_id, create = old.product("Reis")
    package_id, store = old.package(product_id)
    client.delete(f"/api/devices/{old.id}", headers=old.headers)
    assert old.post([create, store]).status_code == 401

    new = Device(client, "Handy", clock=clock)
    data = new.sync([create, store])
    assert statuses(data) == [("applied", None)] * 2
    assert new.packages[package_id]["product_id"] == product_id
    # Die alten Reservierungen bleiben stehen: Sie werden nicht ein zweites Mal zugeteilt.
    assert reserved(con, old.id) & set(new.pool) == set()
    assert len(reserved(con, old.id)) == 299


def test_follow_up_pages_do_not_grant_twice(make_device, monkeypatch, client, clock):
    phone = make_device("Handy")
    phone.sync([phone.cmd("zone.create", zone_id=ids.new_uuid(), name=f"Zone {n}") for n in range(6)])
    monkeypatch.setattr(changes, "PAGE_LIMIT", 3)
    tablet = Device(client, "Tablet", clock=clock)
    pages = tablet.sync_all()
    assert len(pages) > 1
    assert [len(page["id_pool"]["grant"]) for page in pages] == [300] + [0] * (len(pages) - 1)
