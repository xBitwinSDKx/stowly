"""Zeilen der Datenbank als Datensätze des Vertrags (docs/sync-protokoll.md, „Datenmodell").

Jede Funktion liefert ein ``dict`` mit genau den Feldern des passenden Modells aus
``stowly.contract.entities``: Ein Datensatz kommt immer vollständig, nie als Differenz.
"""

import json
import sqlite3
from collections.abc import Iterable, Mapping
from typing import Any

SETTINGS_KEYS = (
    "zone_mode",
    "primary_zone_id",
    "warn_days",
    "trash_retention_days",
    "default_printer_id",
    "notify_time",
)

# SQLite erlaubt nur eine begrenzte Zahl von Platzhaltern je Anweisung.
_CHUNK = 400


def chunks[T](items: list[T], size: int = _CHUNK) -> Iterable[list[T]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def placeholders(count: int) -> str:
    return ", ".join("?" * count)


def _json(text: str | None) -> Any:
    return None if text is None else json.loads(text)


def zone(row: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "icon": row["icon"],
        "color": row["color"],
        "sort": row["sort"],
        "printer_id": row["printer_id"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "deleted_at": row["deleted_at"],
        "moved_to": row["moved_to"],
    }


def product(row: Mapping[str, Any], barcodes: Iterable[str]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "brand": row["brand"],
        "quantity": row["quantity"],
        "image": row["image"],
        "warn_days": row["warn_days"],
        "min_stock": row["min_stock"],
        "lookup": row["lookup"],
        "barcodes": sorted(barcodes),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "deleted_at": row["deleted_at"],
        "merged_into": row["merged_into"],
    }


def barcodes_by_product(con: sqlite3.Connection, product_ids: list[str]) -> dict[str, list[str]]:
    """Alle Barcodes der genannten Produkte in einem Rutsch."""
    result: dict[str, list[str]] = {product_id: [] for product_id in product_ids}
    for part in chunks(product_ids):
        rows = con.execute(
            f"SELECT product_id, barcode FROM product_barcodes WHERE product_id IN ({placeholders(len(part))})",
            part,
        )
        for row in rows:
            result[row["product_id"]].append(row["barcode"])
    return result


def products(con: sqlite3.Connection, rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    barcodes = barcodes_by_product(con, [row["id"] for row in rows])
    return [product(row, barcodes[row["id"]]) for row in rows]


def package(row: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "product_id": row["product_id"],
        "zone_id": row["zone_id"],
        "best_before": row["best_before"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "removed_at": row["removed_at"],
        "removal_reason": row["removal_reason"],
        "displaced": _json(row["displaced"]),
    }


def shopping_item(row: Mapping[str, Any]) -> dict[str, Any]:
    """Ein Eintrag der Einkaufsliste; ``closed_by`` und ``bring_key`` stehen nicht im Sync."""
    return {
        "id": row["id"],
        "product_id": row["product_id"],
        "text": row["text"],
        "quantity": row["quantity"],
        "origin": row["origin"],
        "done_at": row["done_at"],
        "deleted_at": row["deleted_at"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def settings_values(con: sqlite3.Connection) -> dict[str, Any]:
    """Die Einstellungen des Haushalts als ``{schlüssel: wert}``, ohne ``updated_at``."""
    return {row["key"]: json.loads(row["value"]) for row in con.execute("SELECT key, value FROM settings")}


def household_settings(con: sqlite3.Connection) -> dict[str, Any]:
    values: dict[str, Any] = {}
    updated_at = ""
    for row in con.execute("SELECT key, value, updated_at FROM settings"):
        if row["key"] in SETTINGS_KEYS:
            values[row["key"]] = json.loads(row["value"])
            updated_at = max(updated_at, row["updated_at"])
    return {**{key: values[key] for key in SETTINGS_KEYS}, "updated_at": updated_at}


def printer(row: Mapping[str, Any]) -> dict[str, Any]:
    config = json.loads(row["config"])
    is_server = row["connection"] == "server"
    return {
        "id": row["id"],
        "name": row["name"],
        "connection": row["connection"],
        "server": config if is_server else None,
        "direct": None if is_server else config,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "deleted_at": row["deleted_at"],
    }


def printer_status(row: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "printer_id": row["printer_id"],
        "observed_at": row["observed_at"],
        "boot_id": row["boot_id"],
        "status": _json(row["status"]),
        "host": _json(row["host"]),
    }


def print_job(row: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "kind": row["kind"],
        "package_id": row["package_id"],
        "zone_id": row["zone_id"],
        "printer_id": row["printer_id"],
        "state": row["state"],
        "error": row["error"],
        "boot_id": row["boot_id"],
        "device_id": row["device_id"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def label_template(row: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "key": row["key"],
        "hash": row["hash"],
        "body": json.loads(row["body"]),
        "updated_at": row["updated_at"],
    }


def device(row: Mapping[str, Any], current_id: str | None) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "created_at": row["created_at"],
        "last_seen_at": row["last_seen_at"],
        "revoked_at": row["revoked_at"],
        "current": row["id"] == current_id,
    }


def event(row: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "at": row["at"],
        "recorded_at": row["recorded_at"],
        "device_id": row["device_id"],
        "command_id": row["command_id"],
        "type": row["type"],
        "entity": row["entity"],
        "entity_id": row["entity_id"],
        "data": json.loads(row["data"]),
    }
