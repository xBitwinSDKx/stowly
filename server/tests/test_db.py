"""Migrationen und Grundausstattung (stowly/db.py, stowly/migrations)."""

import json
import re
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from support import TEST_PASSWORD

from stowly import auth, db, records
from stowly.app import create_app
from stowly.contract import PROTOCOL_VERSION, ids, timeutil

EXPECTED_TABLES = {
    "meta",
    "counters",
    "devices",
    "zones",
    "products",
    "product_barcodes",
    "packages",
    "field_clocks",
    "settings",
    "commands",
    "events",
    "id_reservations",
    "off_lookups",
    "images",
    "printers",
    "printer_status",
    "print_jobs",
    "label_templates",
    # Schema-Version 3 (Stufe 2)
    "shopping_items",
    "push_subscriptions",
    "push_notices",
    "ha_links",
    "job_runs",
}


@pytest.fixture
def con(tmp_path):
    path = tmp_path / "data" / "stowly.sqlite3"
    db.initialise(path)
    connection = db.connect(path)
    yield connection
    connection.close()


def test_migrations_are_numbered_without_gaps():
    migrations = db.list_migrations()
    assert [number for number, _name, _sql in migrations] == list(range(1, len(migrations) + 1))
    assert migrations[0][1] == "0001_initial.sql"
    own_transaction = re.compile(
        r"^\s*(BEGIN(\s+(IMMEDIATE|EXCLUSIVE|DEFERRED))?(\s+TRANSACTION)?|COMMIT|END\s+TRANSACTION|ROLLBACK)\s*;",
        re.IGNORECASE | re.MULTILINE,
    )
    for _number, name, sql in migrations:
        assert not own_transaction.search(sql), f"{name}: kein eigenes BEGIN/COMMIT, das übernimmt migrate()"


def test_fresh_database_has_the_whole_schema(con):
    tables = {row["name"] for row in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert EXPECTED_TABLES <= tables
    assert db.schema_version(con) == len(db.list_migrations())
    assert con.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    assert con.execute("PRAGMA journal_mode").fetchone()[0] == "wal"


def test_seed_creates_dataset_first_zone_and_settings(con):
    dataset_id = db.get_meta(con, "dataset_id")
    assert dataset_id is not None and ids.is_uuid(dataset_id)

    zones = con.execute("SELECT * FROM zones").fetchall()
    assert len(zones) == 1
    assert zones[0]["name"] == db.DEFAULT_ZONE_NAME
    assert zones[0]["deleted_at"] is None
    assert timeutil.is_timestamp(zones[0]["created_at"])

    settings = {
        row["key"]: json.loads(row["value"]) for row in con.execute("SELECT key, value FROM settings")
    }
    assert settings == {
        "zone_mode": "primary",
        "primary_zone_id": zones[0]["id"],
        "warn_days": 14,
        "trash_retention_days": 30,
        "default_printer_id": None,
        "notify_time": "17:00",
    }

    rev = db.current_rev(con)
    settings_rev = con.execute("SELECT value FROM counters WHERE name = 'settings_rev'").fetchone()[0]
    assert zones[0]["rev"] == 1
    assert settings_rev == rev == 2


def test_initialise_is_idempotent(tmp_path):
    path = tmp_path / "stowly.sqlite3"
    db.initialise(path)
    con = db.connect(path)
    before = (
        db.get_meta(con, "dataset_id"),
        db.current_rev(con),
        con.execute("SELECT id FROM zones").fetchall(),
    )
    con.close()

    db.initialise(path)
    con = db.connect(path)
    after = (
        db.get_meta(con, "dataset_id"),
        db.current_rev(con),
        con.execute("SELECT id FROM zones").fetchall(),
    )
    con.close()
    assert [tuple(r) for r in before[2]] == [tuple(r) for r in after[2]]
    assert before[:2] == after[:2]


def test_next_rev_counts_up_and_rolls_back_with_the_transaction(con):
    start = db.current_rev(con)
    with db.transaction(con):
        assert db.next_rev(con) == start + 1
        assert db.next_rev(con) == start + 2
    assert db.current_rev(con) == start + 2

    with pytest.raises(RuntimeError), db.transaction(con):
        db.next_rev(con)
        raise RuntimeError("Abbruch")
    assert db.current_rev(con) == start + 2


def test_schema_enforces_references_types_and_value_lists(con):
    stamp = timeutil.now()
    zone_id = con.execute("SELECT id FROM zones").fetchone()[0]
    product_id = ids.new_uuid()
    with db.transaction(con):
        con.execute(
            "INSERT INTO products (id, name, created_at, updated_at, rev) VALUES (?, 'Reis', ?, ?, ?)",
            (product_id, stamp, stamp, db.next_rev(con)),
        )
        con.execute(
            "INSERT INTO packages (id, product_id, zone_id, created_at, updated_at, rev) VALUES ('A2B3C', ?, ?, ?, ?, ?)",
            (product_id, zone_id, stamp, stamp, db.next_rev(con)),
        )

    # unbekanntes Produkt
    with pytest.raises(sqlite3.IntegrityError):
        con.execute(
            "INSERT INTO packages (id, product_id, zone_id, created_at, updated_at, rev) VALUES ('A2B3D', ?, ?, ?, ?, 99)",
            (ids.new_uuid(), zone_id, stamp, stamp),
        )
    # Packungs-ID ein zweites Mal
    with pytest.raises(sqlite3.IntegrityError):
        con.execute(
            "INSERT INTO packages (id, product_id, zone_id, created_at, updated_at, rev) VALUES ('A2B3C', ?, ?, ?, ?, 99)",
            (product_id, zone_id, stamp, stamp),
        )
    # Wert außerhalb der Liste
    with pytest.raises(sqlite3.IntegrityError):
        con.execute("UPDATE packages SET removal_reason = 'verschenkt' WHERE id = 'A2B3C'")
    # STRICT: Text in einer Zahlenspalte
    with pytest.raises(sqlite3.IntegrityError):
        con.execute("UPDATE packages SET rev = 'viel' WHERE id = 'A2B3C'")
    # ein Barcode gehört zu genau einem Produkt
    con.execute(
        "INSERT INTO product_barcodes (barcode, product_id, created_at) VALUES ('4006381333931', ?, ?)",
        (product_id, stamp),
    )
    with pytest.raises(sqlite3.IntegrityError):
        con.execute(
            "INSERT INTO product_barcodes (barcode, product_id, created_at) VALUES ('4006381333931', ?, ?)",
            (product_id, stamp),
        )


def test_a_newer_database_is_refused(tmp_path):
    path = tmp_path / "stowly.sqlite3"
    db.initialise(path)
    con = db.connect(path)
    con.execute(f"PRAGMA user_version = {len(db.list_migrations()) + 1}")
    with pytest.raises(RuntimeError, match="neueren Server"):
        db.migrate(con)
    con.close()


# --- Der Weg über die Migrationen -------------------------------------------------------


def database_at_version(path: Path, version: int) -> sqlite3.Connection:
    """Eine Datenbank, wie sie ein Server mit Schema-Version ``version`` hinterlassen hat."""
    path.parent.mkdir(parents=True, exist_ok=True)
    con = db.connect(path)
    for number, _name, sql in db.list_migrations()[:version]:
        con.executescript(f"BEGIN IMMEDIATE;\n{sql}\nPRAGMA user_version = {number};\nCOMMIT;")
    db.seed_defaults(con)
    return con


def test_migration_2_adds_the_command_floor_of_each_device(tmp_path):
    """Schema-Version 1 kannte ``devices.last_command_at`` nicht (Abschnitt 4 des Protokolls)."""
    path = tmp_path / "data" / "stowly.sqlite3"
    con = database_at_version(path, 1)
    assert db.schema_version(con) == 1
    assert "last_command_at" not in {row["name"] for row in con.execute("PRAGMA table_info(devices)")}

    busy, idle, broken = ids.new_uuid(), ids.new_uuid(), ids.new_uuid()
    stamp = timeutil.now()
    commands = [
        (busy, "2026-11-01T10:00:00.000Z", "applied", None),
        (busy, "2026-11-03T10:00:00.000Z", "rejected", "not_found"),
        (busy, "2026-11-02T10:00:00.000Z", "displaced", None),
        # Schon an der Form gescheitert: zählt nicht, auch wenn der Zeitpunkt der späteste ist.
        (busy, "2026-11-09T10:00:00.000Z", "rejected", "invalid"),
        (broken, "2026-11-05T10:00:00.000Z", "rejected", "invalid"),
    ]
    with db.transaction(con):
        for device_id in (busy, idle, broken):
            con.execute(
                "INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, 'Gerät', ?, ?)",
                (device_id, f"hash-{device_id}", stamp),
            )
        for device_id, at, status, code in commands:
            con.execute(
                "INSERT INTO commands (id, device_id, type, at, received_at, body, status, code) "
                "VALUES (?, ?, 'package.update', ?, ?, '{}', ?, ?)",
                (ids.new_uuid(), device_id, at, stamp, status, code),
            )
    dataset_id, zones = (
        db.get_meta(con, "dataset_id"),
        con.execute("SELECT COUNT(*) FROM zones").fetchone()[0],
    )
    con.close()

    db.initialise(path)
    con = db.connect(path)
    assert db.schema_version(con) == len(db.list_migrations()) >= 2
    floors = {
        row["id"]: row["last_command_at"] for row in con.execute("SELECT id, last_command_at FROM devices")
    }
    assert floors == {busy: "2026-11-03T10:00:00.000Z", idle: None, broken: None}
    # Der Rest der Datenbank ist unberührt.
    assert db.get_meta(con, "dataset_id") == dataset_id
    assert con.execute("SELECT COUNT(*) FROM zones").fetchone()[0] == zones
    assert con.execute("SELECT COUNT(*) FROM commands").fetchone()[0] == len(commands)
    con.close()


def test_a_server_started_on_a_version_1_database_keeps_the_order_of_its_devices(settings, clock):
    """Ein Gerät aus der Zeit vor der Migration gleicht weiter ab, und seine Reihenfolge gilt."""
    con = database_at_version(settings.database_path, 1)
    token, device_id = "token-aus-schema-version-1", ids.new_uuid()
    last = clock.stamp(10)  # sein letzter Befehl, zehn Sekunden vor „jetzt"
    with db.transaction(con):
        con.execute(
            "INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, 'Altes Handy', ?, ?)",
            (device_id, auth.hash_token(token), clock.stamp(3600)),
        )
        con.execute(
            "INSERT INTO commands (id, device_id, type, at, received_at, body, status) "
            "VALUES (?, ?, 'package.remove', ?, ?, '{}', 'applied')",
            (ids.new_uuid(), device_id, last, last),
        )
    con.close()

    product_id = ids.new_uuid()
    body = {
        "protocol": PROTOCOL_VERSION,
        "dataset_id": None,
        "cursor": 0,
        "sent_at": clock.stamp(),
        "commands": [
            # Nach seinem Alter (60 s) läge der Befehl vor dem letzten aus der Zeit vor der Migration.
            {
                "id": ids.new_uuid(),
                "at": clock.stamp(60),
                "type": "product.create",
                "product_id": product_id,
                "name": "Reis",
            }
        ],
        "id_pool": {"have": 0},
    }
    with TestClient(create_app(settings)) as client:
        response = client.post("/api/sync", json=body, headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200, response.text
    data = response.json()
    assert [result["status"] for result in data["results"]] == ["applied"]
    created = [product for product in data["changes"]["products"] if product["id"] == product_id]
    assert [product["created_at"] for product in created] == [last]

    con = db.connect(settings.database_path)
    assert db.schema_version(con) == len(db.list_migrations())
    assert con.execute("SELECT last_command_at FROM devices WHERE id = ?", (device_id,)).fetchone()[0] == last
    con.close()


def stage_1_database(path: Path) -> sqlite3.Connection:
    """Eine Datenbank, wie sie Stufe 1 hinterlassen hat: Schema-Version 2, Einstellungen ohne notify_time."""
    con = database_at_version(path, 2)
    with db.transaction(con):
        con.execute("DELETE FROM settings WHERE key = 'notify_time'")
    return con


def test_migration_3_brings_a_stage_1_database_to_stage_2(tmp_path):
    """Mindestbestand, Einkaufsliste, Push, Zeitplan, HA und notify_time kommen dazu; sonst ändert sich nichts."""
    path = tmp_path / "data" / "stowly.sqlite3"
    con = stage_1_database(path)
    assert db.schema_version(con) == 2
    assert "min_stock" not in {row["name"] for row in con.execute("PRAGMA table_info(products)")}

    stamp = "2026-11-01T10:00:00.000Z"
    zone_id = con.execute("SELECT id FROM zones").fetchone()[0]
    product_id = ids.new_uuid()
    with db.transaction(con):
        con.execute(
            "INSERT INTO products (id, name, warn_days, created_at, updated_at, rev) VALUES (?, 'Reis', 5, ?, ?, ?)",
            (product_id, stamp, stamp, db.next_rev(con)),
        )
        con.execute(
            "INSERT INTO packages (id, product_id, zone_id, created_at, updated_at, rev) VALUES ('A2B3C', ?, ?, ?, ?, ?)",
            (product_id, zone_id, stamp, stamp, db.next_rev(con)),
        )
        con.execute("UPDATE settings SET updated_at = '2026-11-01T07:00:00.000Z'")
        con.execute(
            "UPDATE settings SET value = '7', updated_at = '2026-11-02T08:00:00.000Z' WHERE key = 'warn_days'"
        )
    before = {
        "dataset_id": db.get_meta(con, "dataset_id"),
        "rev": db.current_rev(con),
        "settings_rev": con.execute("SELECT value FROM counters WHERE name = 'settings_rev'").fetchone()[0],
        "settings": dict(con.execute("SELECT key, value FROM settings").fetchall()),
    }
    con.close()

    db.initialise(path)
    con = db.connect(path)
    assert db.schema_version(con) == len(db.list_migrations()) >= 3
    tables = {row["name"] for row in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert EXPECTED_TABLES <= tables
    for table in ("shopping_items", "push_subscriptions", "push_notices", "ha_links", "job_runs"):
        assert con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0, table

    product = con.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
    assert (product["name"], product["warn_days"], product["min_stock"], product["shopping_lock_at"]) == (
        "Reis",
        5,
        None,
        None,
    )
    # Die neue Einstellung, einmal und mit dem bisherigen Stand: Geändert hat niemand etwas.
    rows = con.execute("SELECT key, value, updated_at FROM settings WHERE key = 'notify_time'").fetchall()
    assert [(row["value"], row["updated_at"]) for row in rows] == [('"17:00"', "2026-11-02T08:00:00.000Z")]
    settings = dict(con.execute("SELECT key, value FROM settings").fetchall())
    assert settings == {**before["settings"], "notify_time": '"17:00"'}
    assert records.household_settings(con)["notify_time"] == "17:00"
    assert records.household_settings(con)["updated_at"] == "2026-11-02T08:00:00.000Z"
    # Kein neuer Stand der Änderungsfolge, dieselbe Kennung: Die App lädt beim Umstieg ohnehin alles neu.
    assert db.get_meta(con, "dataset_id") == before["dataset_id"]
    assert db.current_rev(con) == before["rev"]
    assert (
        con.execute("SELECT value FROM counters WHERE name = 'settings_rev'").fetchone()[0]
        == before["settings_rev"]
    )
    con.close()

    # Ein zweiter Start ändert nichts mehr.
    db.initialise(path)
    con = db.connect(path)
    assert con.execute("SELECT COUNT(*) FROM settings WHERE key = 'notify_time'").fetchone()[0] == 1
    con.close()


def test_a_server_started_on_a_stage_1_database_delivers_the_new_fields(settings, clock):
    """Nach dem Hochziehen liefert der Abzug min_stock an jedem Produkt und notify_time in den Einstellungen."""
    con = stage_1_database(settings.database_path)
    stamp = clock.stamp(3600)
    product_id = ids.new_uuid()
    with db.transaction(con):
        con.execute(
            "INSERT INTO products (id, name, created_at, updated_at, rev) VALUES (?, 'Milch', ?, ?, ?)",
            (product_id, stamp, stamp, db.next_rev(con)),
        )
    con.close()

    with TestClient(create_app(settings)) as client:
        login = client.post("/api/auth/login", json={"password": TEST_PASSWORD, "device_name": "Handy"})
        token = login.json()["token"]
        body = {
            "protocol": PROTOCOL_VERSION,
            "dataset_id": None,
            "cursor": 0,
            "sent_at": clock.stamp(),
            "commands": [],
            "id_pool": {"have": 0},
        }
        response = client.post("/api/sync", json=body, headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200, response.text
    changes = response.json()["changes"]
    assert [(product["id"], product["min_stock"]) for product in changes["products"]] == [(product_id, None)]
    assert changes["settings"]["notify_time"] == "17:00"
    assert changes["shopping_items"] == []


def test_shopping_items_keep_product_or_text_and_their_closing(con):
    """Die Einkaufsliste prüft im Schema: Produkt oder Text, automatische nur mit Produkt, closed_by nur wenn geschlossen."""
    stamp = timeutil.now()
    product_id = ids.new_uuid()
    with db.transaction(con):
        con.execute(
            "INSERT INTO products (id, name, created_at, updated_at, rev) VALUES (?, 'Milch', ?, ?, ?)",
            (product_id, stamp, stamp, db.next_rev(con)),
        )

    def insert(**values):
        row = {
            "id": ids.new_uuid(),
            "product_id": None,
            "text": "",
            "origin": "manual",
            "done_at": None,
            "deleted_at": None,
            "closed_by": None,
            **values,
        }
        con.execute(
            "INSERT INTO shopping_items (id, product_id, text, origin, done_at, deleted_at, closed_by, "
            "created_at, updated_at, rev) VALUES (:id, :product_id, :text, :origin, :done_at, :deleted_at, "
            ":closed_by, :stamp, :stamp, 1)",
            {**row, "stamp": stamp},
        )

    insert(product_id=product_id)
    insert(text="Grillkohle")
    insert(product_id=product_id, origin="min_stock", done_at=stamp, closed_by="device")
    for broken in (
        {},  # weder Produkt noch Text
        {"product_id": product_id, "text": "Milch"},  # beides
        {"text": "Milch", "origin": "min_stock"},  # automatisch ohne Produkt
        {"text": "Milch", "origin": "irgendwer"},
        {"text": "Milch", "done_at": stamp},  # geschlossen ohne closed_by
        {"text": "Milch", "closed_by": "device"},  # offen mit closed_by
        {"text": "Milch", "deleted_at": stamp, "closed_by": "zufall"},
        {"product_id": ids.new_uuid()},  # unbekanntes Produkt
    ):
        with pytest.raises(sqlite3.IntegrityError):
            insert(**broken)
