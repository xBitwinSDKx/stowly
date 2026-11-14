"""Liste aller Waren für Home Assistant (docs/integrationen.md, Abschnitt 6.3).

Je Zone die Produkte im Bestand: wie viele Packungen dort liegen und welches MHD als Nächstes
fällig ist, gestuft wie beim Sensor (``summary.stocked``) für „heute" in ``STOWLY_TIMEZONE``.
Gedacht ist die Liste für eine Karte in Home Assistant: Sie steht in einem Attribut, nicht im
Zustand einer Entität, und ist deshalb nicht an dessen 255 Zeichen gebunden.
"""

import sqlite3
from collections.abc import Mapping
from datetime import datetime
from typing import Any

from stowly import localtime, summary, texts
from stowly.contract.api import HA_STOCK_ENTRY_MAX, HA_STOCK_NAME_MAX
from stowly.contract.mhd import days_until, fifo_key
from stowly.contract.timeutil import format_timestamp

# Eine Packung, deren Zone es nicht (mehr) gibt, steht hier; das sollte nicht vorkommen.
NO_ZONE = "Ohne Zone"
_MAX_HOPS = 1000


def date_text(day: str) -> str:
    """Ein Kalendertag ``YYYY-MM-DD`` als ``TT.MM.JJJJ``."""
    return f"{day[8:10]}.{day[5:7]}.{day[0:4]}"


def _target(zone_id: str, zones: Mapping[str, sqlite3.Row]) -> str | None:
    """Die Zone, in der eine Packung steht: Eine gelöschte führt zu ihrem Ziel (``moved_to``), wie beim Sensor."""
    current = zone_id
    for _hop in range(_MAX_HOPS):
        row = zones.get(current)
        if row is None:
            return None
        if row["deleted_at"] is None or row["moved_to"] is None:
            return current
        current = row["moved_to"]
    return None


def _product(group: list[summary.Stocked], today: str) -> dict[str, Any]:
    """Ein Eintrag: beschrieben durch die nach FIFO erste Packung, also die mit dem frühesten MHD."""
    first = min(group, key=fifo_key)
    best_before = first.best_before
    return {
        "name": texts.shorten(first.name, HA_STOCK_NAME_MAX),
        "count": len(group),
        "best_before": best_before,
        "mhd": None if best_before is None else date_text(best_before),
        "days": days_until(best_before, today),
        "state": first.state,
    }


def _product_order(group: list[summary.Stocked]) -> tuple[bool, str, str, str]:
    """Nach dem frühesten MHD (ohne MHD zuletzt), dann nach Name, dann nach Produkt."""
    first = min(group, key=fifo_key)
    return (first.best_before is None, first.best_before or "", texts.sort_name(first.name), first.product_id)


def build(con: sqlite3.Connection, tz: Any, now: datetime) -> dict[str, Any]:
    """``HaStock`` zum Zeitpunkt ``now``."""
    today = localtime.today(now, tz).isoformat()
    packages = summary.stocked(con, today)
    zones = {row["id"]: row for row in con.execute("SELECT id, name, sort, deleted_at, moved_to FROM zones")}

    by_zone: dict[str | None, dict[str, list[summary.Stocked]]] = {}
    for package in packages:
        zone_id = _target(package.zone_id, zones)
        by_zone.setdefault(zone_id, {}).setdefault(package.product_id, []).append(package)

    def zone_order(zone_id: str | None) -> tuple[bool, int, str, str]:
        # Wie die Statistik: nach der Reihenfolge der Zonen, dann Name, dann Kennung; ohne Zone zuletzt.
        if zone_id is None:
            return (True, 0, "", "")
        row = zones[zone_id]
        return (False, int(row["sort"]), str(row["name"]), zone_id)

    listed = 0
    truncated = False
    result_zones: list[dict[str, Any]] = []
    for zone_id in sorted(by_zone, key=zone_order):
        groups = sorted(by_zone[zone_id].values(), key=_product_order)
        room = HA_STOCK_ENTRY_MAX - listed
        if room <= 0:
            truncated = True
            break
        if len(groups) > room:
            truncated = True
        shown = groups[:room]
        listed += len(shown)
        result_zones.append(
            {
                "name": NO_ZONE if zone_id is None else str(zones[zone_id]["name"]),
                "count": sum(len(group) for group in groups),
                "products": [_product(group, today) for group in shown],
            }
        )

    return {
        "state": len(packages),
        "product_count": len({package.product_id for package in packages}),
        "zones": result_zones,
        "truncated": truncated,
        "updated_at": format_timestamp(now),
    }
