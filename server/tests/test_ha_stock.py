"""Liste aller Waren für Home Assistant (docs/integrationen.md, Abschnitt 6.3; Protokoll 11.2).

Wie beim Sensor ist die Uhr des Servers angehalten und steht in einer anderen Zeitzone als der
des Rechners: In Auckland ist am 14.11. um 12:00 UTC schon der 15.11.
"""

import dataclasses
import logging
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from support import EAN_A, Device, ServerClock

from stowly import stocklist
from stowly.api import ha as endpoint
from stowly.app import create_app
from stowly.contract import ids
from stowly.contract.api import HA_STOCK_NAME_MAX, HaStock

SENSOR = "sensor-" + "k" * 40
NOW = datetime(2026, 11, 14, 12, 0, tzinfo=UTC)  # in Auckland: 15.11.2026, 01:00
TODAY = "2026-11-15"


@pytest.fixture
def clock(monkeypatch) -> ServerClock:
    server_clock = ServerClock(NOW)
    monkeypatch.setattr("stowly.api.sync.server_now", server_clock.now)
    monkeypatch.setattr(endpoint, "server_now", server_clock.now)
    return server_clock


@pytest.fixture
def sensor_settings(settings):
    return dataclasses.replace(settings, ha_summary_token=SENSOR, timezone="Pacific/Auckland")


@pytest.fixture
def client(sensor_settings):
    with TestClient(create_app(sensor_settings)) as test_client:
        yield test_client


@pytest.fixture
def device(client, clock) -> Device:
    phone = Device(client, "Handy", clock=clock)
    phone.sync()
    return phone


def read(client: TestClient) -> dict:
    response = client.get("/api/ha/stock", headers={"Authorization": f"Bearer {SENSOR}"})
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    HaStock.model_validate(response.json())
    return response.json()


def zone(device: Device, name: str, sort: int) -> str:
    zone_id = ids.new_uuid()
    device.sync([device.cmd("zone.create", zone_id=zone_id, name=name, sort=sort)])
    return zone_id


def stock(device: Device, name: str, *best_before: str | None, zone_id: str | None = None, **product) -> str:
    """Ein Produkt mit je einer Packung je MHD; liefert die Kennung des Produkts."""
    product_id, create = device.product(name, **product)
    where = {} if zone_id is None else {"zone_id": zone_id}
    packages = [device.package(product_id, best_before=day, **where)[1] for day in best_before]
    results = device.sync([create, *packages])["results"]
    assert all(result["status"] == "applied" for result in results), results
    return product_id


def more(device: Device, product_id: str, *best_before: str | None, zone_id: str | None = None) -> list[str]:
    """Weitere Packungen eines vorhandenen Produkts; liefert ihre Kennungen."""
    where = {} if zone_id is None else {"zone_id": zone_id}
    created = [device.package(product_id, best_before=day, **where) for day in best_before]
    results = device.sync([command for _id, command in created])["results"]
    assert all(result["status"] == "applied" for result in results), results
    return [package_id for package_id, _command in created]


def row(name: str, count: int, best_before: str | None, days: int | None, state: str) -> dict:
    mhd = None if best_before is None else stocklist.date_text(best_before)
    return {
        "name": name,
        "count": count,
        "best_before": best_before,
        "mhd": mhd,
        "days": days,
        "state": state,
    }


# --- Token -------------------------------------------------------------------------------------


def test_without_a_sensor_token_everyone_gets_503(settings):
    with TestClient(create_app(settings)) as client:
        device = Device(client, "Handy")
        for headers in ({}, device.headers, {"Authorization": f"Bearer {SENSOR}"}):
            response = client.get("/api/ha/stock", headers=headers)
            assert response.status_code == 503
            assert response.json()["error"]["code"] == "not_configured"


def test_only_the_sensor_token_opens_the_list(client, device):
    for headers in (
        {},
        {"Authorization": "Bearer falsch"},
        {"Authorization": f"Bearer {SENSOR}x"},
        {"Authorization": f"Basic {SENSOR}"},
        device.headers,  # ein Geräte-Token gilt hier nicht
    ):
        response = client.get("/api/ha/stock", headers=headers)
        assert response.status_code == 401, headers
        assert response.json()["error"]["code"] == "unauthorized"
        assert response.headers["www-authenticate"] == "Bearer"
    assert read(client)["state"] == 0


def test_the_token_never_reaches_the_log_or_an_answer(client, device, caplog):
    caplog.set_level(logging.DEBUG)
    answers = [
        client.get("/api/ha/stock", headers={"Authorization": f"Bearer {SENSOR}"}).text,
        client.get("/api/ha/stock", headers={"Authorization": f"Bearer {SENSOR}x"}).text,
    ]
    assert SENSOR not in caplog.text
    assert all(SENSOR not in answer for answer in answers)


# --- Inhalt ------------------------------------------------------------------------------------


def test_an_empty_database(client, device):
    assert read(client) == {
        "state": 0,
        "product_count": 0,
        "zones": [],
        "truncated": False,
        "updated_at": "2026-11-14T12:00:00.000Z",
    }


def test_zones_in_their_order_products_by_date_then_name(client, device):
    """„Heute" ist der Tag in Auckland. Zonen nach ``sort``, dann Name; leere Zonen fehlen."""
    cellar = zone(device, "Keller", 2)
    freezer = zone(device, "Gefrierschrank", 1)
    zone(device, "Dachboden", 3)  # ohne Bestand
    stock(device, "Reis", "2027-05-01", "2027-03-01", zone_id=cellar)
    stock(device, "Nudeln", "2027-03-01", zone_id=cellar)
    stock(device, "Salz", None, zone_id=cellar)
    stock(device, "Erbsen", "2026-11-14", zone_id=freezer)  # gestern: abgelaufen
    stock(device, "Joghurt", TODAY, "2026-11-19")  # in der ersten Zone „Vorrat" (sort 0)

    data = read(client)
    assert (data["state"], data["product_count"], data["truncated"]) == (7, 5, False)
    assert [(entry["name"], entry["count"]) for entry in data["zones"]] == [
        ("Vorrat", 2),
        ("Gefrierschrank", 1),
        ("Keller", 4),
    ]
    assert data["zones"][0]["products"] == [row("Joghurt", 2, TODAY, 0, "soon")]
    assert data["zones"][1]["products"] == [row("Erbsen", 1, "2026-11-14", -1, "expired")]
    # Gleiches frühestes MHD: nach Name. Ohne MHD zuletzt.
    assert data["zones"][2]["products"] == [
        row("Nudeln", 1, "2027-03-01", 106, "ok"),
        row("Reis", 2, "2027-03-01", 106, "ok"),
        row("Salz", 1, None, None, "none"),
    ]


def test_a_product_in_two_zones_counts_in_each(client, device):
    cellar = zone(device, "Keller", 1)
    product_id = stock(device, "Milch", "2026-11-25", "2026-11-17")
    more(device, product_id, "2026-11-16", "2026-12-01", zone_id=cellar)
    data = read(client)
    assert (data["state"], data["product_count"]) == (4, 1)
    assert [(entry["name"], entry["products"]) for entry in data["zones"]] == [
        ("Vorrat", [row("Milch", 2, "2026-11-17", 2, "soon")]),
        ("Keller", [row("Milch", 2, "2026-11-16", 1, "soon")]),
    ]


def test_the_lead_time_of_the_product_decides_the_state(client, device):
    stock(device, "Sahne", "2026-11-18", warn_days=2)  # in 3 Tagen, eigene Vorlaufzeit 2: noch ok
    stock(device, "Milch", "2026-11-19")  # in 4 Tagen, Vorlaufzeit des Haushalts
    products = read(client)["zones"][0]["products"]
    assert [(entry["name"], entry["state"]) for entry in products] == [("Sahne", "ok"), ("Milch", "soon")]


def test_removed_packages_do_not_count(client, device):
    product_id = stock(device, "Joghurt", "2026-11-16")
    (later,) = more(device, product_id, "2026-11-20")
    (gone,) = more(device, product_id, "2026-11-15")
    device.sync([device.cmd("package.remove", package_id=gone, reason="consumed")])
    data = read(client)
    assert data["state"] == 2
    assert data["zones"][0]["products"] == [row("Joghurt", 2, "2026-11-16", 1, "soon")]
    device.sync([device.cmd("package.remove", package_id=later, reason="discarded")])
    assert read(client)["zones"][0]["count"] == 1


def test_a_deleted_zone_lists_its_packages_at_its_target(client, device):
    cellar = zone(device, "Keller", 1)
    stock(device, "Reis", "2027-05-01", zone_id=cellar)
    stock(device, "Milch", "2026-11-25")
    device.sync([device.cmd("zone.delete", zone_id=cellar, move_to=device.zone_id)])
    data = read(client)
    assert [entry["name"] for entry in data["zones"]] == ["Vorrat"]
    assert [entry["name"] for entry in data["zones"][0]["products"]] == ["Milch", "Reis"]


def test_placeholders_and_long_names(client, device):
    long_name = "Bio-Vollmilchjoghurt mit Erdbeeren aus der Region und ganz viel Liebe gemacht"
    stock(device, long_name, "2026-11-20")
    stock(device, "", "2026-11-21", barcodes=[EAN_A])
    stock(device, "  ", "2026-11-22")  # ohne Namen und ohne Barcode
    names = [entry["name"] for entry in read(client)["zones"][0]["products"]]
    assert len(names[0]) <= HA_STOCK_NAME_MAX and names[0].startswith("Bio-Vollmilchjoghurt")
    assert names[0].endswith("…")
    assert names[1:] == [EAN_A, "Unbekanntes Produkt"]


def test_the_list_is_cut_after_the_limit_but_counts_everything(client, device, monkeypatch):
    monkeypatch.setattr(stocklist, "HA_STOCK_ENTRY_MAX", 3)
    cellar = zone(device, "Keller", 1)
    attic = zone(device, "Dachboden", 2)
    for index, name in enumerate(("Anis", "Basilikum")):
        stock(device, name, f"2026-12-0{index + 1}")
    for index, name in enumerate(("Curry", "Dill")):
        stock(device, name, f"2026-12-0{index + 1}", zone_id=cellar)
    stock(device, "Estragon", "2026-12-01", zone_id=attic)

    data = read(client)
    assert (data["state"], data["product_count"], data["truncated"]) == (5, 5, True)
    assert [(entry["name"], entry["count"], len(entry["products"])) for entry in data["zones"]] == [
        ("Vorrat", 2, 2),
        ("Keller", 2, 1),  # gekürzt: count zählt trotzdem beide
    ]

    monkeypatch.setattr(stocklist, "HA_STOCK_ENTRY_MAX", 5)
    data = read(client)
    assert data["truncated"] is False
    assert sum(len(entry["products"]) for entry in data["zones"]) == 5


def test_date_text():
    assert stocklist.date_text("2026-03-09") == "09.03.2026"
