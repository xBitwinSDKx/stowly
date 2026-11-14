"""Statistik: verbraucht und entsorgt (docs/sync-protokoll.md, Abschnitt 11.1).

Gerechnet wird aus dem heutigen Stand jeder Packung, nicht aus dem Ereignisprotokoll: Eine
wiederhergestellte Packung zählt nicht mehr, ein nachträglich geänderter Grund zählt mit dem neuen,
und weil Zusammenführen und das Löschen einer Zone die Packungen umhängen, zählt alles beim Ziel.
„Versehentlich" (``mistake``) zählt nirgends.

Die Monate sind Kalendermonate in ``STOWLY_TIMEZONE``: Eine Packung, die um 23:30 UTC am letzten
Oktober entnommen wurde, gehört in Berlin schon in den November.
"""

import sqlite3
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from stowly import texts
from stowly.contract.api import STATS_DEFAULT_MONTHS, STATS_MAX_MONTHS, STATS_TOP_PRODUCTS
from stowly.contract.timeutil import is_month, parse_timestamp

COUNTED = ("consumed", "discarded")
# Mehr Schritte hat keine Kette aus Zusammenführungen oder gelöschten Zonen; schützt vor Schleifen.
_MAX_HOPS = 1000


class PeriodError(Exception):
    """Ein ungültiger Zeitraum; ``problems`` sind die Einträge für ``details.errors``."""

    def __init__(self, problems: list[dict[str, Any]]) -> None:
        super().__init__(problems[0]["msg"])
        self.problems = problems


# --- Monate ------------------------------------------------------------------------------------


def month_of(day: date) -> str:
    return f"{day.year:04d}-{day.month:02d}"


def _index(month: str) -> int:
    """Fortlaufende Nummer eines Monats: Jahr mal 12 plus Monat."""
    return int(month[:4]) * 12 + int(month[5:7]) - 1


def _month(index: int) -> str:
    return f"{index // 12:04d}-{index % 12 + 1:02d}"


def months_between(start: str, end: str) -> list[str]:
    """Jeder Monat von ``start`` bis ``end``, beide eingeschlossen, aufsteigend."""
    return [_month(index) for index in range(_index(start), _index(end) + 1)]


def _problem(name: str, message: str) -> dict[str, Any]:
    return {"loc": ["query", name], "msg": message, "type": "value_error"}


def period(query: Mapping[str, Sequence[str]], today: date) -> tuple[str, str]:
    """Der Zeitraum aus ``?start=`` und ``?end=``; ``PeriodError`` mit allen Verstößen.

    Ohne ``end`` der laufende Monat, ohne ``start`` 11 Monate vor ``end`` (zusammen 12), aber nie vor
    dem Jahr 0001. Ungültig: ein Monat, der nicht ``YYYY-MM`` ist (Jahre 0001 bis 9999), ein Parameter
    doppelt, ``start`` nach ``end``, mehr als ``STATS_MAX_MONTHS`` Monate.
    """
    values: dict[str, str | None] = {}
    problems: list[dict[str, Any]] = []
    for name in ("start", "end"):
        given = list(query.get(name, ()))
        if len(given) > 1:
            problems.append(_problem(name, f"'{name}' darf nur einmal angegeben sein."))
        elif given and not (given[0].isascii() and is_month(given[0])):
            problems.append(_problem(name, f"'{name}' muss ein Monat YYYY-MM sein (Jahre 0001 bis 9999)."))
        values[name] = given[0] if given else None
    if problems:
        raise PeriodError(problems)

    end = values["end"] or month_of(today)
    start = values["start"] or _month(max(_index(end) - (STATS_DEFAULT_MONTHS - 1), _index("0001-01")))
    if _index(start) > _index(end):
        raise PeriodError([_problem("start", "'start' liegt nach 'end'.")])
    if _index(end) - _index(start) + 1 > STATS_MAX_MONTHS:
        raise PeriodError([_problem("start", f"Der Zeitraum umfasst mehr als {STATS_MAX_MONTHS} Monate.")])
    return start, end


def _bounds(start: str, end: str) -> tuple[str, str | None]:
    """Grobe Grenzen in UTC für die Abfrage, mit zwei Tagen Rand auf jeder Seite.

    Genau entschieden wird danach je Packung in der Zeitzone des Servers. Der Rand fängt jeden
    Versatz einer Zeitzone ab, auch an den Rändern des Kalenders (Jahr 0001 und 9999).
    """
    first = date(int(start[:4]), int(start[5:7]), 1)
    try:
        low = (first - timedelta(days=2)).isoformat()
    except OverflowError:
        low = date.min.isoformat()
    last_index = _index(end) + 1
    try:
        after = date(last_index // 12, last_index % 12 + 1, 1) + timedelta(days=2)
    except (ValueError, OverflowError):
        return f"{low}T00:00:00.000Z", None
    return f"{low}T00:00:00.000Z", f"{after.isoformat()}T00:00:00.000Z"


def local_month(stamp: str, tz: ZoneInfo) -> str | None:
    """Der Monat eines Zeitstempels in der Zeitzone des Servers; ``None``, wenn er sich nicht umrechnen lässt."""
    try:
        return month_of(parse_timestamp(stamp).astimezone(tz).date())
    except (ValueError, OverflowError):
        return None


# --- Rechnen -----------------------------------------------------------------------------------


@dataclass
class _Tally:
    consumed: int = 0
    discarded: int = 0

    def add(self, reason: str) -> None:
        if reason == "consumed":
            self.consumed += 1
        else:
            self.discarded += 1


def _follow(start: str, step: Mapping[str, str | None]) -> str | None:
    """Folgt einer Kette (``merged_into``, ``moved_to``) bis zum Ende; ``None`` bei einer Schleife."""
    current = start
    for _hop in range(_MAX_HOPS):
        following = step.get(current)
        if following is None:
            return current
        current = following
    return None


def compute(con: sqlite3.Connection, tz: ZoneInfo, timezone: str, start: str, end: str) -> dict[str, Any]:
    """``Stats`` für den Zeitraum ``start`` bis ``end`` (beide eingeschlossen)."""
    months = months_between(start, end)
    wanted = set(months)
    low, high = _bounds(start, end)
    query = (
        "SELECT product_id, zone_id, removed_at, removal_reason FROM packages "
        "WHERE removed_at IS NOT NULL AND removal_reason IN ('consumed', 'discarded') AND removed_at >= ?"
    )
    parameters: list[Any] = [low]
    if high is not None:
        query += " AND removed_at < ?"
        parameters.append(high)

    products = {
        row["id"]: row
        for row in con.execute("SELECT id, name, deleted_at, merged_into FROM products").fetchall()
    }
    merged = {product_id: row["merged_into"] for product_id, row in products.items()}
    zones = con.execute("SELECT id, name, sort, deleted_at, moved_to FROM zones").fetchall()
    moved = {row["id"]: (row["moved_to"] if row["deleted_at"] is not None else None) for row in zones}

    per_month = {month: _Tally() for month in months}
    per_zone: dict[str, _Tally] = {}
    discarded_by_product: Counter[str] = Counter()
    for row in con.execute(query, parameters):
        month = local_month(row["removed_at"], tz)
        if month not in wanted:
            continue
        reason = row["removal_reason"]
        per_month[month].add(reason)
        zone_id = _follow(row["zone_id"], moved)
        if zone_id is not None:
            per_zone.setdefault(zone_id, _Tally()).add(reason)
        if reason == "discarded":
            product_id = _follow(row["product_id"], merged)
            if product_id is not None:
                discarded_by_product[product_id] += 1

    consumed = sum(tally.consumed for tally in per_month.values())
    discarded = sum(tally.discarded for tally in per_month.values())
    total = consumed + discarded
    return {
        "start": start,
        "end": end,
        "months": [
            {"month": month, "consumed": per_month[month].consumed, "discarded": per_month[month].discarded}
            for month in months
        ],
        "consumed": consumed,
        "discarded": discarded,
        "discarded_share": None if total == 0 else round(discarded / total, 4),
        "top_discarded": _top(con, products, discarded_by_product),
        "zones": [
            {
                "zone_id": row["id"],
                "name": row["name"],
                "consumed": per_zone.get(row["id"], _Tally()).consumed,
                "discarded": per_zone.get(row["id"], _Tally()).discarded,
            }
            for row in sorted(
                (row for row in zones if row["deleted_at"] is None),
                key=lambda row: (row["sort"], row["name"], row["id"]),
            )
        ],
        "timezone": timezone,
    }


def _top(
    con: sqlite3.Connection, products: Mapping[str, sqlite3.Row], discarded: Counter[str]
) -> list[dict[str, Any]]:
    """Die am häufigsten entsorgten Produkte: meiste zuerst, dann nach Name (Platzhalter zuletzt), dann Kennung."""
    first_barcode = {
        row["product_id"]: row["barcode"]
        for row in con.execute(
            "SELECT product_id, MIN(barcode) AS barcode FROM product_barcodes GROUP BY product_id"
        )
    }

    def name_of(product_id: str) -> str:
        row = products.get(product_id)
        return "" if row is None else row["name"].strip()

    def order(product_id: str) -> tuple[int, bool, str, str]:
        name = name_of(product_id)
        return (-discarded[product_id], name == "", texts.sort_name(name), product_id)

    return [
        {
            "product_id": product_id,
            "name": name_of(product_id),
            "barcode": first_barcode.get(product_id),
            "discarded": discarded[product_id],
        }
        for product_id in sorted(discarded, key=order)[:STATS_TOP_PRODUCTS]
    ]
