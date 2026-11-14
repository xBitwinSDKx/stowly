"""Einkaufsliste: automatische Einträge und Erledigen durch Einlagern (docs/sync-protokoll.md, 7.6).

Was hier steht, schreibt der Server selbst; kein Gerät schickt dafür einen Befehl. Es läuft immer
im Sicherungspunkt des Befehls, der es auslöst (Protokoll 6.3): Es gilt mit dem Befehl oder gar
nicht. Die Befehle der Einkaufsliste selbst und die Auslöser stehen in ``sync/handlers.py``.

* **Abgleich eines Produkts** (``reconcile``): höchstens ein offener automatischer Eintrag je
  Produkt; seine Menge ist der Fehlbestand. Ohne Fehlbestand verschwindet er (gelöscht, nicht
  erledigt). Ein neuer entsteht nur, solange das Produkt nicht gesperrt ist.
* **Sperre** (``products.shopping_lock_at``, nicht im Sync, ohne ``rev``): ein wirksamer Zeitpunkt,
  zu dem ein Anwender den automatischen Eintrag abgehakt oder gelöscht hat. Sie endet mit einem
  Einlagern oder einer Änderung des Mindestbestands, die nicht vor ihr geschah.
* **Erledigen durch Einlagern** (``store_done``): eigene Einträge eines Produkts, die seit dem
  Einlagern oder früher offen sind.
* **Erledigen durch Bring!** (``bring_done``): Der Abgleich mit Home Assistant (``stowly.bring``)
  hat einen gebundenen Artikel abgehakt oder gelöscht gesehen. Er läuft außerhalb eines Sync-Aufrufs;
  ``Cause.command_id`` ist dann ``None``.

Jedes Schreiben an einem Eintrag gibt der Zeile einen neuen ``rev`` und ``updated_at =
max(updated_at, t)``; so erfahren die Geräte davon mit ihrem nächsten Abgleich, meist schon in der
Antwort auf den Sync, dessen Befehl es ausgelöst hat. Ins Ereignisprotokoll kommt es ohne Gerät
(``device_id`` null), mit der Kennung des auslösenden Befehls und eigenen Typen (Protokoll 12).
"""

import sqlite3
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from stowly import db, events
from stowly.contract import ids
from stowly.contract.entities import ShoppingOrigin

ENTITY = "shopping_item"
AUTO = ShoppingOrigin.MIN_STOCK.value  # automatischer Eintrag, vom Server
MANUAL = ShoppingOrigin.MANUAL.value  # eigener Eintrag, von einem Gerät
# Feld-Uhr für abhaken und wieder öffnen (Protokoll 7.1). Sie stellen auch das Erledigen durch
# Einlagern und durch Bring!; ihr Zeitpunkt ist bei einem offenen Eintrag der Zeitpunkt, seit dem
# er offen ist.
DONE_CLOCK = "done"

# Wodurch ein Eintrag geschlossen wurde (Spalte closed_by, nicht im Sync; docs/integrationen.md 5.4).
CLOSED_BY_DEVICE = "device"  # ein Gerät hat abgehakt oder gelöscht
CLOSED_BY_STORE = "store"  # eigener Eintrag, erledigt durch Einlagern
CLOSED_BY_STOCK = "stock"  # automatischer Eintrag, der Bestand reicht (oder kein Mindestbestand mehr)
CLOSED_BY_MERGE = "merge"  # automatischer Eintrag, mit einem anderen desselben Produkts zusammengelegt
CLOSED_BY_BRING = "bring"  # in Bring! abgehakt oder gelöscht (stowly.bring)

# Was Stowly über einen Artikel in Bring! zuletzt geschrieben oder gesehen hat (ha_links.status).
BRING_OPEN = "needs_action"


@dataclass(frozen=True)
class Cause:
    """Was der Server gerade selbst schreibt, und warum.

    ``at`` ist der wirksame Zeitpunkt des auslösenden Befehls, ``recorded_at`` die Serverzeit
    beim Verbuchen, ``command_id`` der Befehl (beim Abgleich mit Bring! ``None``).
    """

    con: sqlite3.Connection
    at: str
    recorded_at: str
    command_id: str | None


def _event(cause: Cause, type_: str, entity: str, entity_id: str, data: dict[str, Any]) -> None:
    events.record(
        cause.con,
        at=cause.at,
        recorded_at=cause.recorded_at,
        device_id=None,
        command_id=cause.command_id,
        type=type_,
        entity=entity,
        entity_id=entity_id,
        data=data,
    )


def _write(cause: Cause, item_id: str, values: Mapping[str, Any]) -> None:
    """Schreibt Spalten eines Eintrags: neuer ``rev``, ``updated_at`` nie rückwärts."""
    assignments = "".join(f"{column} = ?, " for column in values)
    cause.con.execute(
        f"UPDATE shopping_items SET {assignments}updated_at = max(updated_at, ?), rev = ? WHERE id = ?",
        (*values.values(), cause.at, db.next_rev(cause.con), item_id),
    )


# --- Bestand und Fehlbestand -------------------------------------------------------------------


def stock(con: sqlite3.Connection, product_id: str) -> int:
    """Packungen des Produkts im Bestand: alle nicht entnommenen, auch abgelaufene."""
    row = con.execute(
        "SELECT COUNT(*) FROM packages WHERE product_id = ? AND removed_at IS NULL", (product_id,)
    ).fetchone()
    return int(row[0])


def missing(min_stock: int | None, in_stock: int) -> int:
    """Fehlbestand: ``min_stock`` minus Bestand, mindestens 0; ohne Mindestbestand 0.

    Dieselbe Regel rechnet die App als ``missingStock`` (web/src/contract/shopping.ts).
    """
    return 0 if min_stock is None else max(0, min_stock - in_stock)


# --- Sperre ------------------------------------------------------------------------------------


def _lock_of(con: sqlite3.Connection, product_id: str) -> str | None:
    row = con.execute("SELECT shopping_lock_at FROM products WHERE id = ?", (product_id,)).fetchone()
    return None if row is None else row["shopping_lock_at"]


def _set_lock(cause: Cause, product_id: str, old: str | None, new: str | None) -> None:
    """Setzt die Sperre ohne ``rev``: Sie steht nicht im Sync. Ins Protokoll nur, was sich ändert."""
    if new == old:
        return
    cause.con.execute("UPDATE products SET shopping_lock_at = ? WHERE id = ?", (new, product_id))
    _event(cause, "product.shopping_lock", "product", product_id, {"lock": new, "old": old})


def lock(cause: Cause, product_id: str) -> None:
    """Abgehakt oder gelöscht: Sperre = die spätere von Sperre und ``t``."""
    old = _lock_of(cause.con, product_id)
    _set_lock(cause, product_id, old, cause.at if old is None or cause.at > old else old)


def unlock(cause: Cause, product_id: str) -> None:
    """Hebt die Sperre auf, wenn sie nicht nach ``t`` liegt.

    Ein Einlagern oder eine Änderung des Mindestbestands, die vor dem Abhaken geschah und erst
    danach eintrifft, lässt die Sperre also stehen.
    """
    old = _lock_of(cause.con, product_id)
    if old is not None and old <= cause.at:
        _set_lock(cause, product_id, old, None)


def carry_lock(cause: Cause, source_id: str, target_id: str) -> None:
    """Zusammenführen: Sperre des Ziels = die spätere beider Sperren; die Quelle hat keine mehr."""
    source = _lock_of(cause.con, source_id)
    target = _lock_of(cause.con, target_id)
    later = max((value for value in (source, target) if value is not None), default=None)
    _set_lock(cause, source_id, source, None)
    _set_lock(cause, target_id, target, later)


# --- Abgleich eines Produkts -------------------------------------------------------------------


def _remove_auto(cause: Cause, item: Mapping[str, Any], reason: str) -> None:
    """Löscht einen offenen automatischen Eintrag; seine Menge bleibt, wie sie war.

    Gelöscht, nicht erledigt: So entsteht in Bring! kein „gekauft", das niemand getan hat.
    """
    _write(cause, item["id"], {"deleted_at": cause.at, "closed_by": reason})
    _event(
        cause,
        "shopping_item.auto_removed",
        ENTITY,
        item["id"],
        {"product_id": item["product_id"], "quantity": item["quantity"], "reason": reason},
    )


def reconcile(cause: Cause, product_id: str) -> None:
    """Abgleich eines Produkts zum wirksamen Zeitpunkt ``t`` (Protokoll 7.6, Schritte 1 bis 3).

    Wiederholbar: Läuft er ohne Anlass, ändert er nichts, was schon zur Regel passt.
    """
    con = cause.con
    product = con.execute(
        "SELECT id, min_stock, shopping_lock_at, deleted_at FROM products WHERE id = ?", (product_id,)
    ).fetchone()
    if product is None or product["deleted_at"] is not None:
        # Ein zusammengeführtes Produkt hat keine Einträge mehr: Sie sind zum Ziel gewandert.
        return
    open_items = con.execute(
        "SELECT * FROM shopping_items WHERE product_id = ? AND origin = ? "
        "AND done_at IS NULL AND deleted_at IS NULL ORDER BY created_at, id",
        (product_id, AUTO),
    ).fetchall()

    # 1. Mehr als ein offener automatischer Eintrag: Der älteste bleibt, die übrigen gehen.
    for extra in open_items[1:]:
        _remove_auto(cause, extra, CLOSED_BY_MERGE)
    current = open_items[0] if open_items else None

    gap = missing(product["min_stock"], stock(con, product_id))
    if gap > 0:
        # 2. Fehlbestand: nachführen, sonst anlegen, außer das Produkt ist gesperrt.
        if current is not None:
            if current["quantity"] != gap:
                _write(cause, current["id"], {"quantity": gap})
                _event(
                    cause,
                    "shopping_item.auto_quantity",
                    ENTITY,
                    current["id"],
                    {"product_id": product_id, "old": current["quantity"], "new": gap},
                )
        elif product["shopping_lock_at"] is None:
            item_id = ids.new_uuid()
            con.execute(
                "INSERT INTO shopping_items (id, product_id, text, quantity, origin, created_at, "
                "updated_at, rev) VALUES (?, ?, '', ?, ?, ?, ?, ?)",
                (item_id, product_id, gap, AUTO, cause.at, cause.at, db.next_rev(con)),
            )
            _event(
                cause,
                "shopping_item.auto_created",
                ENTITY,
                item_id,
                {"product_id": product_id, "quantity": gap},
            )
    elif current is not None:
        # 3. Der Bestand reicht, oder es gibt keinen Mindestbestand mehr.
        _remove_auto(cause, current, CLOSED_BY_STOCK)


# --- Erledigen durch Einlagern -----------------------------------------------------------------


def store_done(cause: Cause, product_id: str, package_id: str) -> None:
    """``package.create`` für ``product_id`` mit wirksamem Zeitpunkt ``t``: eigene Einträge erledigt.

    Erledigt ist jeder offene eigene Eintrag des Produkts, der seit ``t`` oder früher offen ist:
    „offen seit" ist die Uhr von ``done`` (das letzte Wiederöffnen), sonst ``created_at``. Danach
    steht die Uhr auf ``t``: Ein Abhaken oder Öffnen, das vor dem Einlagern geschah und erst später
    eintrifft, verliert gegen das Erledigen. Freie Texte erledigt nur der Anwender.
    """
    con = cause.con
    rows = con.execute(
        "SELECT s.id, s.created_at, c.at AS opened_at FROM shopping_items s "
        "LEFT JOIN field_clocks c ON c.entity = ? AND c.entity_id = s.id AND c.field = ? "
        "WHERE s.product_id = ? AND s.origin = ? AND s.done_at IS NULL AND s.deleted_at IS NULL "
        "ORDER BY s.created_at, s.id",
        (ENTITY, DONE_CLOCK, product_id, MANUAL),
    ).fetchall()
    for row in rows:
        opened = row["opened_at"] or row["created_at"]
        if opened > cause.at:
            continue
        _write(cause, row["id"], {"done_at": cause.at, "closed_by": CLOSED_BY_STORE})
        con.execute(
            "INSERT INTO field_clocks (entity, entity_id, field, at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT (entity, entity_id, field) DO UPDATE SET at = excluded.at",
            (ENTITY, row["id"], DONE_CLOCK, cause.at),
        )
        _event(
            cause,
            "shopping_item.store_done",
            ENTITY,
            row["id"],
            {"product_id": product_id, "package_id": package_id},
        )


# --- Bring! ------------------------------------------------------------------------------------


def bring_done(cause: Cause, item: Mapping[str, Any], *, name: str, how: str) -> None:
    """In Bring! abgehakt (``how = completed``) oder gelöscht (``removed``): Der offene Eintrag ist erledigt.

    ``done_at`` und die Uhr von ``done`` sind der Zeitpunkt des Abgleichs (docs/integrationen.md, 5.4);
    ein automatischer Eintrag sperrt sein Produkt wie beim Abhaken (Protokoll 7.6).
    """
    _write(cause, item["id"], {"done_at": cause.at, "closed_by": CLOSED_BY_BRING})
    cause.con.execute(
        "INSERT INTO field_clocks (entity, entity_id, field, at) VALUES (?, ?, ?, ?) "
        "ON CONFLICT (entity, entity_id, field) DO UPDATE SET at = excluded.at",
        (ENTITY, item["id"], DONE_CLOCK, cause.at),
    )
    _event(cause, "shopping_item.bring_done", ENTITY, item["id"], {"name": name, "how": how})
    if item["origin"] == AUTO:
        lock(cause, item["product_id"])


def bring_binding_lost(con: sqlite3.Connection, bring_key: str | None) -> bool:
    """Wird ein Eintrag wieder geöffnet, dessen Artikel in Bring! erledigt oder entfernt ist (oder den
    Stowly nicht mehr kennt), verliert er seine Bindung und geht neu nach Bring! (docs/integrationen.md, 5.4)."""
    if bring_key is None:
        return False
    row = con.execute("SELECT status FROM ha_links WHERE name_key = ?", (bring_key,)).fetchone()
    return row is None or row["status"] != BRING_OPEN


# --- Zusammenführen ----------------------------------------------------------------------------


def move_items(cause: Cause, source_id: str, target_id: str) -> int:
    """Alle Einträge der Quelle, auch erledigte und gelöschte, gehören danach zum Ziel (7.3, Schritt 5).

    Wie die Packungen: ein gemeinsamer ``rev``, ``updated_at`` nie rückwärts, keine Uhr. Liefert die
    Zahl der Einträge.
    """
    con = cause.con
    count = int(
        con.execute("SELECT COUNT(*) FROM shopping_items WHERE product_id = ?", (source_id,)).fetchone()[0]
    )
    if count:
        con.execute(
            "UPDATE shopping_items SET product_id = ?, updated_at = max(updated_at, ?), rev = ? "
            "WHERE product_id = ?",
            (target_id, cause.at, db.next_rev(con), source_id),
        )
    return count
