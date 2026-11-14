"""Zusammenfassung für den Sensor in Home Assistant (docs/integrationen.md, Abschnitt 6.1).

Alles gilt für „heute" in ``STOWLY_TIMEZONE`` und für Packungen im Bestand, gestuft mit
``expiry_state`` und ``warn_days_for`` (``stowly.contract.mhd``). Home Assistant begrenzt den
Zustand einer Entität auf 255 Zeichen: Die Listen bleiben kurz, der Satz bleibt darunter.
"""

import sqlite3
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from stowly import localtime, records, texts
from stowly.contract.api import HA_SUMMARY_ENTRY_MAX, HA_SUMMARY_LIST_MAX, HA_SUMMARY_MESSAGE_MAX
from stowly.contract.mhd import days_until, expiry_state, fifo_key, warn_days_for
from stowly.contract.timeutil import format_timestamp

_MAX_HOPS = 1000


@dataclass(frozen=True)
class Stocked:
    """Eine Packung im Bestand mit allem, was Sensor und Tagesnachricht über sie wissen müssen."""

    id: str
    product_id: str
    zone_id: str
    best_before: str | None
    created_at: str
    name: str  # Anzeigename des Produkts
    warn_days: int
    state: str  # Warnstufe heute: none, ok, soon, expired

    def __getitem__(self, key: str) -> Any:
        """Damit ``mhd.fifo_key`` die Packung wie eine Zeile lesen kann."""
        return getattr(self, key)


def first_barcodes(con: sqlite3.Connection) -> dict[str, str]:
    """Der erste Barcode je Produkt (aufsteigend, wie ``Product.barcodes`` im Sync)."""
    return {
        row["product_id"]: row["barcode"]
        for row in con.execute(
            "SELECT product_id, MIN(barcode) AS barcode FROM product_barcodes GROUP BY product_id"
        )
    }


def stocked(con: sqlite3.Connection, today: str) -> list[Stocked]:
    """Alle Packungen im Bestand, gestuft für ``today``."""
    settings = records.settings_values(con)
    barcodes = first_barcodes(con)
    products = {row["id"]: dict(row) for row in con.execute("SELECT id, name, warn_days FROM products")}
    found: list[Stocked] = []
    for row in con.execute(
        "SELECT id, product_id, zone_id, best_before, created_at FROM packages WHERE removed_at IS NULL"
    ):
        product = products.get(row["product_id"])
        warn = warn_days_for(product, settings)
        found.append(
            Stocked(
                id=row["id"],
                product_id=row["product_id"],
                zone_id=row["zone_id"],
                best_before=row["best_before"],
                created_at=row["created_at"],
                name=texts.display_name(
                    None if product is None else product["name"], barcodes.get(row["product_id"])
                ),
                warn_days=warn,
                state=expiry_state(row["best_before"], warn, today),
            )
        )
    return found


def groups(packages: Iterable[Stocked]) -> list[tuple[Stocked, int]]:
    """Je Produkt und MHD eine Gruppe ``(erste Packung, Anzahl)``.

    Sortiert nach MHD, dann nach dem Anzeigenamen (``str.casefold()``), dann nach der Kennung des
    Produkts; die erste Packung einer Gruppe ist die nach FIFO erste.
    """
    found: dict[tuple[str, str | None], list[Stocked]] = {}
    for package in packages:
        found.setdefault((package.product_id, package.best_before), []).append(package)
    ordered = sorted(
        found.values(),
        key=lambda group: (group[0].best_before or "", texts.sort_name(group[0].name), group[0].product_id),
    )
    return [(min(group, key=fifo_key), len(group)) for group in ordered]


def list_entry(name: str, count: int, best_before: str, limit: int) -> str:
    """„Joghurt (16.11.)", bei mehreren Packungen „2× Joghurt (16.11.)"; gekürzt wird der Name."""
    return texts.fitted(
        name, before=texts.counted(count), after=f" ({texts.day_month(best_before)})", limit=limit
    )


def _stage_list(packages: Iterable[Stocked]) -> list[str]:
    return [
        list_entry(first.name, count, first.best_before or "", HA_SUMMARY_ENTRY_MAX)
        for first, count in groups(packages)[:HA_SUMMARY_LIST_MAX]
    ]


def _zone_name(con: sqlite3.Connection, zone_id: str) -> str:
    """Name der Zone; eine gelöschte führt zu ihrem Ziel (``moved_to``)."""
    current = zone_id
    for _hop in range(_MAX_HOPS):
        row = con.execute("SELECT name, deleted_at, moved_to FROM zones WHERE id = ?", (current,)).fetchone()
        if row is None:
            return ""
        if row["deleted_at"] is None or row["moved_to"] is None:
            return str(row["name"])
        current = row["moved_to"]
    return ""


def _shopping(con: sqlite3.Connection, barcodes: Mapping[str, str]) -> list[str]:
    """Offene Einträge in der Reihenfolge der App (älteste zuerst), höchstens 5, je höchstens 40 Zeichen."""
    rows = con.execute(
        "SELECT s.product_id, s.text, s.quantity, s.origin, p.name AS product_name FROM shopping_items s "
        "LEFT JOIN products p ON p.id = s.product_id "
        "WHERE s.done_at IS NULL AND s.deleted_at IS NULL ORDER BY s.created_at, s.id LIMIT ?",
        (HA_SUMMARY_LIST_MAX,),
    ).fetchall()
    entries: list[str] = []
    for row in rows:
        if row["product_id"] is None:
            name = row["text"]
        else:
            # Wie shoppingItemTitle in der App: der Anzeigename des Produkts.
            name = texts.display_name(row["product_name"], barcodes.get(row["product_id"]))
        label = texts.quantity_label(row["origin"], row["quantity"])
        entries.append(texts.fitted(name, after=f" ({label})" if label else "", limit=HA_SUMMARY_ENTRY_MAX))
    return entries


def _names(packages: Iterable[Stocked]) -> str:
    """„A", „A und B", „A, B und C", bei mehr „A, B, C und weitere": verschiedene Produkte, sortiert wie die Listen."""
    seen: dict[str, str] = {}
    for first, _count in groups(packages):
        seen.setdefault(first.product_id, first.name)
    names = list(seen.values())
    if len(names) > 3:
        return f"{', '.join(names[:3])} und weitere"
    return texts.joined(names)


def message(*, today: list[Stocked], soon: list[Stocked], expired: int, shopping: int) -> str:
    """Der Satz zum Vorlesen aus drei Teilen, höchstens 255 Zeichen (gekürzt am letzten Wort davor)."""
    parts: list[str] = []
    if today:
        if len(today) == 1:
            parts.append(f"Heute läuft 1 Packung ab: {_names(today)}.")
        else:
            parts.append(f"Heute laufen {len(today)} Packungen ab: {_names(today)}.")
    elif soon:
        first = min(soon, key=fifo_key)
        # „TT.MM." endet schon mit dem Punkt, der auch den Satz beendet: kein zweiter.
        when = texts.day_month(first.best_before or "")
        if len(soon) == 1:
            parts.append(f"Bald läuft 1 Packung ab: {first.name} am {when}")
        else:
            parts.append(f"Bald laufen {len(soon)} Packungen ab, als Nächstes {first.name} am {when}")
    else:
        parts.append("Nichts läuft bald ab.")
    if expired == 1:
        parts.append("1 Packung ist abgelaufen.")
    elif expired > 1:
        parts.append(f"{expired} Packungen sind abgelaufen.")
    if shopping == 1:
        parts.append("Auf der Einkaufsliste steht 1 Eintrag.")
    elif shopping > 1:
        parts.append(f"Auf der Einkaufsliste stehen {shopping} Einträge.")
    return texts.cut_at_word(" ".join(parts), HA_SUMMARY_MESSAGE_MAX)


def build(con: sqlite3.Connection, tz: Any, now: datetime) -> dict[str, Any]:
    """``HaSummary`` zum Zeitpunkt ``now``."""
    today = localtime.today(now, tz).isoformat()
    packages = stocked(con, today)
    soon = [package for package in packages if package.state == "soon"]
    expired = [package for package in packages if package.state == "expired"]
    due_today = [package for package in soon if package.best_before == today]
    shopping = int(
        con.execute(
            "SELECT COUNT(*) FROM shopping_items WHERE done_at IS NULL AND deleted_at IS NULL"
        ).fetchone()[0]
    )

    coming = [
        package for package in packages if package.best_before is not None and package.best_before >= today
    ]
    following: dict[str, Any] | None = None
    if coming:
        first = min(coming, key=fifo_key)
        following = {
            "name": first.name,
            "best_before": first.best_before,
            "days": days_until(first.best_before, today),
            "count": sum(
                1
                for package in coming
                if package.product_id == first.product_id and package.best_before == first.best_before
            ),
            "zone": _zone_name(con, first.zone_id),
        }

    return {
        "state": len(soon),
        "today": len(due_today),
        "expired": len(expired),
        "total": len(packages),
        "next": following,
        "shopping": shopping,
        "soon_list": _stage_list(soon),
        "expired_list": _stage_list(expired),
        "shopping_list": _shopping(con, first_barcodes(con)),
        "message": message(today=due_today, soon=soon, expired=len(expired), shopping=shopping),
        "updated_at": format_timestamp(now),
    }
