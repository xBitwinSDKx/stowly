"""Migrationen und Grundausstattung (stowly/db.py, stowly/migrations)."""

import json
import re
import sqlite3

import pytest

from stowly import db
from stowly.contract import ids, timeutil

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
