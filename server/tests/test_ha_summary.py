"""Sensor für Home Assistant (docs/integrationen.md, Abschnitt 6; Protokoll 11.2).

Die Uhr des Servers ist angehalten und steht in einer anderen Zeitzone als der des Rechners: In
Auckland ist am 14.11. um 12:00 UTC schon der 15.11.
"""

import dataclasses
import logging
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from support import EAN_A, Device, ServerClock

from stowly import summary, texts
from stowly.api import ha as endpoint
from stowly.app import create_app
from stowly.contract import ids
from stowly.contract.api import HaSummary

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
    response = client.get("/api/ha/summary", headers={"Authorization": f"Bearer {SENSOR}"})
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    HaSummary.model_validate(response.json())
    return response.json()


def stock(device: Device, name: str, *best_before: str | None, age: float = 0.0, **product) -> str:
    """Ein Produkt mit je einer Packung je MHD; liefert die Kennung des Produkts."""
    product_id, create = device.product(name, age=age, **product)
    packages = [device.package(product_id, best_before=day, age=age)[1] for day in best_before]
    results = device.sync([create, *packages])["results"]
    assert all(result["status"] == "applied" for result in results), results
    return product_id


# --- Token -------------------------------------------------------------------------------------


def test_without_a_sensor_token_everyone_gets_503(settings):
    with TestClient(create_app(settings)) as client:
        device = Device(client, "Handy")
        for headers in ({}, device.headers, {"Authorization": f"Bearer {SENSOR}"}):
            response = client.get("/api/ha/summary", headers=headers)
            assert response.status_code == 503
            assert response.json()["error"]["code"] == "not_configured"


def test_only_the_sensor_token_opens_the_sensor(client, device):
    for headers in (
        {},
        {"Authorization": "Bearer falsch"},
        {"Authorization": f"Bearer {SENSOR}x"},
        {"Authorization": f"Basic {SENSOR}"},
        device.headers,  # ein Geräte-Token gilt hier nicht
    ):
        response = client.get("/api/ha/summary", headers=headers)
        assert response.status_code == 401, headers
        assert response.json()["error"]["code"] == "unauthorized"
        assert response.headers["www-authenticate"] == "Bearer"
    assert read(client)["total"] == 0


def test_the_sensor_token_counts_nowhere_else(client, device):
    """Anderswo ist er ein unbekanntes Geräte-Token: 401."""
    sensor = {"Authorization": f"Bearer {SENSOR}"}
    for method, path in (
        ("GET", "/api/devices"),
        ("GET", "/api/integrations"),
        ("GET", "/api/stats"),
        ("GET", "/api/events"),
        ("POST", "/api/backup/run"),
        ("GET", f"/api/lookup/{EAN_A}"),
        ("POST", "/api/auth/logout"),
    ):
        response = client.request(method, path, headers=sensor)
        assert response.status_code == 401, path
    assert client.post("/api/sync", json=device.request(), headers=sensor).status_code == 401
    assert client.get("/print/v1/health", headers=sensor).status_code == 401


def test_the_token_never_reaches_the_log_or_an_answer(client, device, caplog):
    caplog.set_level(logging.DEBUG)
    answers = [
        client.get("/api/ha/summary", headers={"Authorization": f"Bearer {SENSOR}"}).text,
        client.get("/api/ha/summary", headers={"Authorization": f"Bearer {SENSOR}x"}).text,
        client.get("/api/devices", headers={"Authorization": f"Bearer {SENSOR}"}).text,
    ]
    assert SENSOR not in caplog.text
    assert all(SENSOR not in answer for answer in answers)


# --- Inhalt ------------------------------------------------------------------------------------


def test_an_empty_database(client, device):
    assert read(client) == {
        "state": 0,
        "today": 0,
        "expired": 0,
        "total": 0,
        "next": None,
        "shopping": 0,
        "soon_list": [],
        "expired_list": [],
        "shopping_list": [],
        "message": "Nichts läuft bald ab.",
        "updated_at": "2026-11-14T12:00:00.000Z",
    }


def test_today_soon_expired_and_without_a_date(client, device):
    """„Heute" ist der Tag in Auckland. Die Vorlaufzeit des Produkts geht vor der des Haushalts (14)."""
    stock(device, "Joghurt", TODAY, TODAY, age=60)
    stock(device, "Eier", TODAY, warn_days=0, age=50)  # 0 ist ein eigener Wert: heute ist bald
    stock(device, "Milch", "2026-11-19")  # in 4 Tagen, Vorlaufzeit des Haushalts
    stock(device, "Sahne", "2026-11-18", warn_days=2)  # in 3 Tagen, eigene Vorlaufzeit 2: noch ok
    stock(device, "Quark", "2026-11-14")  # gestern: abgelaufen
    stock(device, "Reis", "2027-05-01")
    stock(device, "Butter", None)

    data = read(client)
    assert (data["state"], data["today"], data["expired"], data["total"]) == (4, 3, 1, 8)
    # Die nach FIFO erste Packung ab heute: MHD heute, zuerst eingelagert (der Joghurt).
    assert data["next"] == {"name": "Joghurt", "best_before": TODAY, "days": 0, "count": 2, "zone": "Vorrat"}
    assert data["soon_list"] == ["Eier (15.11.)", "2× Joghurt (15.11.)", "Milch (19.11.)"]
    assert data["expired_list"] == ["Quark (14.11.)"]
    assert data["message"] == "Heute laufen 3 Packungen ab: Eier und Joghurt. 1 Packung ist abgelaufen."


def test_the_lead_time_of_the_household(client, device):
    stock(device, "Milch", "2026-11-19")
    device.sync([device.cmd("settings.update", changes={"warn_days": 3})])
    data = read(client)
    assert (data["state"], data["soon_list"], data["message"]) == (0, [], "Nichts läuft bald ab.")
    assert data["next"]["name"] == "Milch" and data["next"]["days"] == 4


def test_soon_names_the_first_soon_package_not_next(client, device):
    """``next`` kann wegen einer kürzeren Vorlaufzeit eine Packung in Stufe ok sein; „Bald …" nennt die erste bald fällige."""
    stock(device, "Sahne", "2026-11-17", warn_days=1)  # in 2 Tagen, Vorlaufzeit 1: ok
    stock(device, "Milch", "2026-11-19")
    data = read(client)
    assert data["next"]["name"] == "Sahne" and data["next"]["days"] == 2
    assert data["message"] == "Bald läuft 1 Packung ab: Milch am 19.11."
    stock(device, "Butter", "2026-11-20", "2026-11-25")
    assert read(client)["message"] == "Bald laufen 3 Packungen ab, als Nächstes Milch am 19.11."


def test_next_counts_the_packages_of_its_product_with_its_date_in_fifo_order(client, device):
    zone = ids.new_uuid()
    device.sync([device.cmd("zone.create", zone_id=zone, name="Keller", sort=1, age=60)])
    product_id, create = device.product("Joghurt", age=50)
    # In der Reihenfolge, in der sie eingelagert wurden: Die Befehle eines Geräts laufen nie rückwärts.
    later = device.package(product_id, best_before="2026-11-20", age=40)[1]
    first = device.package(product_id, best_before="2026-11-16", zone_id=zone, age=30)[1]
    second = device.package(product_id, best_before="2026-11-16", age=20)[1]
    device.sync([create, later, first, second])
    assert read(client)["next"] == {
        "name": "Joghurt",
        "best_before": "2026-11-16",
        "days": 1,
        "count": 2,
        "zone": "Keller",
    }


def test_placeholders_without_a_name(client, device):
    stock(device, "", TODAY, barcodes=[EAN_A])
    stock(device, "  ", "2026-11-14")  # ohne Namen und ohne Barcode
    data = read(client)
    assert data["soon_list"] == [f"{EAN_A} (15.11.)"]
    assert data["expired_list"] == ["Unbekanntes Produkt (14.11.)"]
    assert data["next"]["name"] == EAN_A
    assert data["message"] == f"Heute läuft 1 Packung ab: {EAN_A}. 1 Packung ist abgelaufen."


def test_long_names_are_shortened_to_forty_characters(client, device):
    long_name = "Bio-Vollmilchjoghurt mit Erdbeeren aus der Region und viel Liebe"
    stock(device, long_name, TODAY, TODAY)
    item = ids.new_uuid()
    device.sync(
        [
            device.cmd(
                "shopping_item.create",
                item_id=item,
                text="Grillkohle für das große Sommerfest am See",
                quantity=3,
            )
        ]
    )
    data = read(client)
    (entry,) = data["soon_list"]
    assert len(entry) <= 40 and entry.startswith("2× Bio-Vollmilchjoghurt") and entry.endswith("… (15.11.)")
    (shopping,) = data["shopping_list"]
    assert len(shopping) <= 40 and shopping.endswith("… (3×)")
    # Im Satz steht der ganze Name.
    assert (
        data["message"] == f"Heute laufen 2 Packungen ab: {long_name}. Auf der Einkaufsliste steht 1 Eintrag."
    )


def test_at_most_five_in_each_list_sorted_by_date_then_name_then_product(client, device):
    for name, day in (("zitrone", "2026-11-20"), ("Apfel", "2026-11-20"), ("Birne", "2026-11-16")):
        stock(device, name, day)
    for index in range(4):
        stock(device, f"Quark {index}", f"2026-11-0{index + 1}")
    data = read(client)
    assert data["soon_list"] == ["Birne (16.11.)", "Apfel (20.11.)", "zitrone (20.11.)"]
    assert data["expired_list"] == [
        "Quark 0 (01.11.)",
        "Quark 1 (02.11.)",
        "Quark 2 (03.11.)",
        "Quark 3 (04.11.)",
    ]
    for index in range(4, 7):
        stock(device, f"Quark {index}", f"2026-11-0{index + 1}")
    data = read(client)
    assert len(data["expired_list"]) == 5 and data["expired"] == 7
    assert data["message"] == (
        "Bald laufen 3 Packungen ab, als Nächstes Birne am 16.11. 7 Packungen sind abgelaufen."
    )


def test_more_than_three_products_today(client, device):
    for name in ("Dill", "Apfel", "Christstollen", "Birne"):
        stock(device, name, TODAY)
    assert read(client)["message"] == "Heute laufen 4 Packungen ab: Apfel, Birne, Christstollen und weitere."


def test_the_shopping_list_in_the_order_of_the_app(client, device, clock):
    milk = stock(device, "Milch", min_stock=3, age=100)  # automatisch: fehlt 3
    butter = stock(device, "Butter", age=90)
    placeholder = stock(device, "", barcodes=[EAN_A], age=90)
    entries = [
        ("Butter (2×)", {"product_id": butter, "quantity": 2}, 80),
        ("Grillkohle", {"text": "Grillkohle"}, 70),
        (f"{EAN_A}", {"product_id": placeholder}, 60),
        ("Kaffee (1×)", {"text": "Kaffee", "quantity": 1}, 50),
        ("Zucker", {"text": "Zucker"}, 40),  # der sechste: fällt weg
    ]
    commands = [
        device.cmd("shopping_item.create", item_id=ids.new_uuid(), age=age, **payload)
        for _, payload, age in entries
    ]
    device.sync(commands)
    data = read(client)
    assert data["shopping"] == 6
    assert data["shopping_list"] == ["Milch (fehlt 3)", *[label for label, _, _ in entries[:4]]]
    assert data["message"] == "Nichts läuft bald ab. Auf der Einkaufsliste stehen 6 Einträge."
    assert milk


def test_a_message_of_exactly_255_characters_stays_whole(client, device):
    """Drei Namen, die den Satz auf genau 255 Zeichen bringen; ein Zeichen mehr kürzt am letzten Wort."""
    prefix_len = len("Heute laufen 3 Packungen ab: ") + len(", ") + len(" und ") + len(".")

    def words(first: str, length: int) -> str:
        text = (first + " Beeren" * 40)[:length]
        assert not text.endswith(" ") and len(text) == length
        return text

    names = [words("Apfelkompott", 100), words("Birnenmus", 100), words("Cassis", 255 - prefix_len - 200)]
    for name in names:
        stock(device, name, TODAY)
    data = read(client)
    assert len(data["message"]) == 255
    assert data["message"] == f"Heute laufen 3 Packungen ab: {names[0]}, {names[1]} und {names[2]}."

    stock(device, "Dattel", "2026-11-14")  # ein vierter Teil: „1 Packung ist abgelaufen."
    longer = read(client)["message"]
    assert len(longer) <= 255 and longer.endswith("…")
    assert longer.startswith(f"Heute laufen 3 Packungen ab: {names[0]}, {names[1]} und ")
    assert " Beere…" not in longer and not longer.endswith(" …")


# --- Bausteine ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("kurz", "kurz"),
        ("a" * 255, "a" * 255),
        ("Wort " * 51 + "x", ("Wort " * 51).rstrip() + "…"),
        ("a" * 300, "a" * 254 + "…"),
        ("Liste: A, B, " + "Cassis" * 50, "Liste: A, B…"),
    ],
)
def test_cutting_at_the_last_word(text, expected):
    cut = texts.cut_at_word(text, 255)
    assert cut == expected
    assert len(cut) <= 255


def test_list_entries_never_exceed_forty_characters():
    assert summary.list_entry("Joghurt", 1, "2026-11-16", 40) == "Joghurt (16.11.)"
    assert summary.list_entry("Joghurt", 12, "2026-11-16", 40) == "12× Joghurt (16.11.)"
    long_entry = summary.list_entry("x" * 120, 2, "2026-11-16", 40)
    assert len(long_entry) == 40 and long_entry == "2× " + "x" * 27 + "… (16.11.)"
