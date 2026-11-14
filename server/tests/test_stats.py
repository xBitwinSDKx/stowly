"""Statistik (docs/sync-protokoll.md, Abschnitt 11.1).

Gerechnet wird aus dem heutigen Stand der Packungen, in Monaten der Zeitzone des Servers. Die Uhr
des Servers ist angehalten: Wann eine Packung entnommen wurde, bestimmt der Test.
"""

import dataclasses
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from support import EAN_A, EAN_B, Device, ServerClock

from stowly.api import stats as endpoint
from stowly.app import create_app
from stowly.contract.api import Stats


def utc(*parts: int) -> datetime:
    return datetime(*parts, tzinfo=UTC)


@pytest.fixture
def today(monkeypatch, clock: ServerClock) -> ServerClock:
    """Der laufende Monat der Statistik folgt derselben angehaltenen Uhr wie der Sync."""
    monkeypatch.setattr(endpoint, "server_now", clock.now)
    return clock


def fetch(device: Device, query: str = "") -> dict:
    response = device.client.get(f"/api/stats{query}", headers=device.headers)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    Stats.model_validate(response.json())
    return response.json()


def take_out(
    device: Device, clock: ServerClock, product_id: str, at: datetime, reason: str, **package
) -> str:
    """Lagert eine Packung ein und entnimmt sie zum Zeitpunkt ``at``; liefert ihre ID."""
    clock.value = at
    package_id, create = device.package(product_id, **package)
    remove = device.cmd("package.remove", package_id=package_id, reason=reason)
    results = device.sync([create, remove])["results"]
    assert [result["status"] for result in results] == ["applied", "applied"], results
    return package_id


def new_product(device: Device, name: str, **payload) -> str:
    product_id, create = device.product(name, **payload)
    assert device.sync([create])["results"][0]["status"] == "applied"
    return product_id


def month(data: dict, which: str) -> tuple[int, int]:
    (found,) = [entry for entry in data["months"] if entry["month"] == which]
    return found["consumed"], found["discarded"]


# --- Zählen ------------------------------------------------------------------------------------


def test_consumed_and_discarded_count_but_a_mistake_does_not(make_device, today):
    device = make_device()
    milk = new_product(device, "Milch")
    take_out(device, today, milk, utc(2026, 11, 3, 9), "consumed")
    take_out(device, today, milk, utc(2026, 11, 4, 9), "consumed")
    take_out(device, today, milk, utc(2026, 11, 5, 9), "discarded")
    take_out(device, today, milk, utc(2026, 11, 6, 9), "mistake")
    today.value = utc(2026, 11, 14, 9)

    data = fetch(device)
    assert (data["start"], data["end"]) == ("2025-12", "2026-11")
    assert len(data["months"]) == 12
    assert month(data, "2026-11") == (2, 1)
    assert (data["consumed"], data["discarded"], data["discarded_share"]) == (2, 1, 0.3333)
    assert data["top_discarded"] == [{"product_id": milk, "name": "Milch", "barcode": None, "discarded": 1}]
    assert data["timezone"] == "Europe/Berlin"


def test_the_state_of_today_counts_restored_and_changed_reasons(make_device, today):
    """Eine wiederhergestellte Packung zählt nicht; ein nachträglich geänderter Grund zählt mit dem neuen."""
    device = make_device()
    milk = new_product(device, "Milch")
    restored = take_out(device, today, milk, utc(2026, 11, 3, 9), "discarded")
    changed = take_out(device, today, milk, utc(2026, 11, 4, 9), "consumed")
    today.value = utc(2026, 11, 10, 9)
    device.sync(
        [
            device.cmd("package.restore", package_id=restored),
            # Schon entnommen: Es ändert sich nur der Grund, der Zeitpunkt bleibt im November.
            device.cmd("package.remove", package_id=changed, reason="discarded"),
        ]
    )
    data = fetch(device)
    assert month(data, "2026-11") == (0, 1)
    assert (data["consumed"], data["discarded"], data["discarded_share"]) == (0, 1, 1.0)


# --- Zuordnung ---------------------------------------------------------------------------------


def test_after_merging_everything_counts_at_the_target(make_device, today):
    device = make_device()
    source = new_product(device, "Vollmilch")
    target = new_product(device, "Milch")
    take_out(device, today, source, utc(2026, 11, 3, 9), "discarded")
    take_out(device, today, source, utc(2026, 11, 3, 10), "discarded")
    take_out(device, today, target, utc(2026, 11, 4, 9), "discarded")
    device.sync([device.cmd("product.merge", source_id=source, target_id=target)])
    today.value = utc(2026, 11, 10, 9)

    (only,) = fetch(device)["top_discarded"]
    assert (only["product_id"], only["name"], only["discarded"]) == (target, "Milch", 3)


def test_after_deleting_a_zone_everything_counts_at_its_target(make_device, today):
    device = make_device()
    first = device.zone_id
    cellar, freezer = "6f0c8f43-1c39-4a5f-9a0e-6f3f0b2f6d11", "7a1d9e54-2d4a-4b60-8b1f-7a4f1c3a7e22"
    device.sync(
        [
            device.cmd("zone.create", zone_id=cellar, name="Keller", sort=2),
            device.cmd("zone.create", zone_id=freezer, name="Gefrierschrank", sort=1),
        ]
    )
    milk = new_product(device, "Milch")
    take_out(device, today, milk, utc(2026, 11, 3, 9), "consumed", zone_id=cellar)
    take_out(device, today, milk, utc(2026, 11, 3, 10), "discarded", zone_id=cellar)
    take_out(device, today, milk, utc(2026, 11, 4, 9), "consumed", zone_id=first)
    device.sync([device.cmd("zone.delete", zone_id=cellar, move_to=freezer)])
    today.value = utc(2026, 11, 10, 9)

    data = fetch(device)
    # Jede nicht gelöschte Zone, nach sort, auch mit 0; der Keller zählt beim Gefrierschrank.
    assert [(zone["name"], zone["consumed"], zone["discarded"]) for zone in data["zones"]] == [
        ("Vorrat", 1, 0),
        ("Gefrierschrank", 1, 1),
    ]


def test_zones_come_in_their_order_even_with_nothing(make_device, today):
    device = make_device()
    device.sync(
        [
            device.cmd(
                "zone.create", zone_id="0b6c4d2e-5f3a-4e1b-9c8d-7e6f5a4b3c21", name="b-Keller", sort=5
            ),
            device.cmd(
                "zone.create", zone_id="1c7d5e3f-6a4b-4f2c-8d9e-8f7a6b5c4d32", name="a-Keller", sort=5
            ),
            device.cmd(
                "zone.create", zone_id="2d8e6f4a-7b5c-4a3d-9e0f-9a8b7c6d5e43", name="Kühlschrank", sort=-1
            ),
        ]
    )
    today.value = utc(2026, 11, 10, 9)
    assert [(zone["name"], zone["consumed"], zone["discarded"]) for zone in fetch(device)["zones"]] == [
        ("Kühlschrank", 0, 0),
        ("Vorrat", 0, 0),
        ("a-Keller", 0, 0),
        ("b-Keller", 0, 0),
    ]


# --- Grenzen der Monate ------------------------------------------------------------------------


def test_the_month_is_the_month_in_the_timezone_of_the_server(make_device, today):
    """23:30 UTC am Monatsende ist in Berlin schon der nächste Monat; die Zeitumstellung zählt mit."""
    device = make_device()
    milk = new_product(device, "Milch")
    # Winterzeit (UTC+1): 31.10. 23:30 UTC ist der 1.11. um 00:30.
    take_out(device, today, milk, utc(2026, 10, 31, 23, 30), "consumed")
    # 31.10. 22:30 UTC ist noch der 31.10. um 23:30.
    take_out(device, today, milk, utc(2026, 10, 31, 22, 30), "discarded")
    # Sommerzeit (UTC+2) seit dem 29.03.: 31.03. 22:30 UTC ist der 1.04. um 00:30.
    take_out(device, today, milk, utc(2026, 3, 31, 22, 30), "consumed")
    # 31.03. 21:59 UTC ist noch der 31.03. um 23:59.
    take_out(device, today, milk, utc(2026, 3, 31, 21, 59), "consumed")
    today.value = utc(2026, 11, 14, 9)

    data = fetch(device, "?start=2026-03&end=2026-11")
    assert month(data, "2026-03") == (1, 0)
    assert month(data, "2026-04") == (1, 0)
    assert month(data, "2026-10") == (0, 1)
    assert month(data, "2026-11") == (1, 0)
    # Am Rand des Zeitraums: Was in Berlin schon November ist, fehlt im Oktober.
    assert (fetch(device, "?start=2026-10&end=2026-10")["months"]) == [
        {"month": "2026-10", "consumed": 0, "discarded": 1}
    ]


def test_another_timezone_than_the_computer(settings, monkeypatch):
    """Die Zeitzone des Servers gilt, nicht die des Rechners, auf dem er läuft."""
    clock = ServerClock(utc(2026, 12, 1, 3, 0))
    monkeypatch.setattr("stowly.api.sync.server_now", clock.now)
    monkeypatch.setattr(endpoint, "server_now", clock.now)
    newyork = dataclasses.replace(settings, timezone="America/New_York")
    with TestClient(create_app(newyork)) as client:
        device = Device(client, "Handy", clock=clock)
        device.sync()
        milk = new_product(device, "Milch")
        # 1.12. 03:00 UTC ist in New York noch der 30.11. um 22:00.
        take_out(device, clock, milk, utc(2026, 12, 1, 3, 0), "consumed")
        data = fetch(device)
    assert (data["end"], data["timezone"]) == ("2026-11", "America/New_York")
    assert month(data, "2026-11") == (1, 0)


# --- Leere Lagen -------------------------------------------------------------------------------


def test_empty_months_and_no_share_without_anything(make_device, today):
    device = make_device()
    today.value = utc(2026, 11, 14, 9)
    data = fetch(device, "?start=2026-01&end=2026-03")
    assert data == {
        "start": "2026-01",
        "end": "2026-03",
        "months": [
            {"month": "2026-01", "consumed": 0, "discarded": 0},
            {"month": "2026-02", "consumed": 0, "discarded": 0},
            {"month": "2026-03", "consumed": 0, "discarded": 0},
        ],
        "consumed": 0,
        "discarded": 0,
        "discarded_share": None,
        "top_discarded": [],
        "zones": [{"zone_id": device.zone_id, "name": "Vorrat", "consumed": 0, "discarded": 0}],
        "timezone": "Europe/Berlin",
    }


def test_the_share_is_rounded_to_four_places(make_device, today):
    device = make_device()
    milk = new_product(device, "Milch")
    for day in range(1, 3):
        take_out(device, today, milk, utc(2026, 11, day, 9), "discarded")
    take_out(device, today, milk, utc(2026, 11, 3, 9), "consumed")
    today.value = utc(2026, 11, 14, 9)
    assert fetch(device)["discarded_share"] == 0.6667


# --- Die am häufigsten entsorgten Produkte -----------------------------------------------------


def test_at_most_ten_products_most_first_then_by_name_then_by_id(make_device, today):
    device = make_device()
    stamp = utc(2026, 11, 3, 9)
    expected: list[tuple[str, int]] = []
    for count in range(1, 12):
        product_id = new_product(device, f"Produkt {count:02d}")
        for _ in range(count):
            take_out(device, today, product_id, stamp, "discarded")
        expected.append((f"Produkt {count:02d}", count))
    # Gleichstand: nach Name (casefold), Platzhalter ohne Namen zuletzt, dann nach Kennung.
    tie_ids = sorted(["00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000001"])
    device.sync(
        [
            device.cmd("product.create", product_id=tie_ids[1], name="", barcodes=[EAN_B]),
            device.cmd("product.create", product_id=tie_ids[0], name="", barcodes=[EAN_A]),
        ]
    )
    for product_id, name in ((tie_ids[1], ""), (tie_ids[0], ""), (None, "äpfel"), (None, "Zwiebeln")):
        pid = product_id or new_product(device, name)
        for _ in range(11):
            take_out(device, today, pid, stamp, "discarded")
    today.value = utc(2026, 11, 14, 9)

    top = fetch(device)["top_discarded"]
    assert len(top) == 10
    assert [(entry["name"], entry["discarded"]) for entry in top[:5]] == [
        ("Produkt 11", 11),
        ("Zwiebeln", 11),  # "z" vor "ä" in der Reihenfolge der Unicode-Zeichen
        ("äpfel", 11),
        ("", 11),
        ("", 11),
    ]
    assert [entry["product_id"] for entry in top[3:5]] == tie_ids
    assert [entry["barcode"] for entry in top[3:5]] == [EAN_A, EAN_B]
    assert [(entry["name"], entry["discarded"]) for entry in top[5:]] == [
        ("Produkt 10", 10),
        ("Produkt 09", 9),
        ("Produkt 08", 8),
        ("Produkt 07", 7),
        ("Produkt 06", 6),
    ]


# --- Zeitraum ----------------------------------------------------------------------------------


def test_the_default_period_and_one_side_given(make_device, today):
    device = make_device()
    today.value = utc(2026, 1, 15, 9)
    assert (fetch(device)["start"], fetch(device)["end"]) == ("2025-02", "2026-01")
    only_end = fetch(device, "?end=2025-06")
    assert (only_end["start"], only_end["end"], len(only_end["months"])) == ("2024-07", "2025-06", 12)
    only_start = fetch(device, "?start=2025-11")
    assert (only_start["start"], only_start["end"]) == ("2025-11", "2026-01")
    longest = fetch(device, "?start=2016-02&end=2026-01")
    assert len(longest["months"]) == 120
    # Nie vor dem Jahr 0001.
    early = fetch(device, "?end=0001-05")
    assert (early["start"], early["end"]) == ("0001-01", "0001-05")
    late = fetch(device, "?start=9999-01&end=9999-12")
    assert late["months"][-1]["month"] == "9999-12"


@pytest.mark.parametrize(
    ("query", "locs"),
    [
        ("?start=2026-13", [["query", "start"]]),
        ("?start=2026-1", [["query", "start"]]),
        ("?start=0000-12", [["query", "start"]]),
        ("?end=26-01", [["query", "end"]]),
        ("?end=2026-01-01", [["query", "end"]]),
        ("?end=", [["query", "end"]]),
        ("?end=２０２６-01", [["query", "end"]]),
        ("?start=x&end=y", [["query", "start"], ["query", "end"]]),
        ("?start=2026-01&start=2026-02", [["query", "start"]]),
        ("?end=2026-01&end=2026-01", [["query", "end"]]),
        ("?start=2026-03&end=2026-02", [["query", "start"]]),
        ("?start=2027-01", [["query", "start"]]),  # nach dem laufenden Monat
        ("?start=2016-01&end=2026-01", [["query", "start"]]),  # 121 Monate
    ],
)
def test_an_invalid_period_is_400(make_device, today, query, locs):
    device = make_device()
    today.value = utc(2026, 1, 15, 9)
    response = device.client.get(f"/api/stats{query}", headers=device.headers)
    assert response.status_code == 400, query
    error = response.json()["error"]
    assert error["code"] == "invalid_request"
    assert [problem["loc"] for problem in error["details"]["errors"]] == locs


def test_only_a_device_token_opens_the_statistics(settings, monkeypatch):
    sensor = "s" * 40
    with TestClient(create_app(dataclasses.replace(settings, ha_summary_token=sensor))) as client:
        assert client.get("/api/stats").status_code == 401
        response = client.get("/api/stats", headers={"Authorization": f"Bearer {sensor}"})
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "unauthorized"
        assert response.headers["www-authenticate"] == "Bearer"
        device = Device(client, "Handy")
        assert client.get("/api/stats", headers=device.headers).status_code == 200
