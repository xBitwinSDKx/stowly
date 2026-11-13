"""ID-Vorrat (docs/sync-protokoll.md, Abschnitt 8).

Eine gedruckte Packungs-ID lässt sich nicht mehr ändern, also dürfen zwei Geräte offline
nie dieselbe vergeben. Der Server teilt jedem Gerät bei jedem Sync so viele freie IDs zu,
dass sein Vorrat wieder ``ID_POOL_TARGET`` erreicht, und merkt sie in ``id_reservations``.

Eine Reservierung schützt nur davor, dass der Server eine ID zweimal zuteilt. Sie
verfällt mit dem Anlegen der Packung (``handlers``), sonst nie: Auch ein Gerät, das sich
nach einer Sperre neu anmelden musste, darf seine alten IDs noch verbrauchen.
"""

import sqlite3

from stowly import records
from stowly.contract import ID_POOL_TARGET, ids

# Nach so vielen Runden ohne genügend freie IDs gibt die Zuteilung auf (praktisch nie:
# Es gibt 33,5 Millionen Kombinationen).
_MAX_ROUNDS = 50


def _taken(con: sqlite3.Connection, candidates: list[str]) -> set[str]:
    """Welche Kandidaten schon eine Packung sind oder für irgendein Gerät reserviert."""
    taken: set[str] = set()
    for part in records.chunks(candidates):
        marks = records.placeholders(len(part))
        taken.update(row[0] for row in con.execute(f"SELECT id FROM packages WHERE id IN ({marks})", part))
        taken.update(
            row[0]
            for row in con.execute(
                f"SELECT package_id FROM id_reservations WHERE package_id IN ({marks})", part
            )
        )
    return taken


def grant(con: sqlite3.Connection, *, device_id: str, have: int, reset: bool, now: str) -> list[str]:
    """Teilt dem Gerät neue IDs zu und reserviert sie.

    Bei ``reset`` verwirft die App ihren Vorrat und nimmt den aus dieser Antwort: Dann
    gibt es unabhängig von ``have`` einen vollen Vorrat.
    """
    wanted = ID_POOL_TARGET if reset else max(0, ID_POOL_TARGET - have)
    granted: list[str] = []
    tried: set[str] = set()
    for _round in range(_MAX_ROUNDS):
        missing = wanted - len(granted)
        if missing <= 0:
            break
        candidates: list[str] = []
        for _draw in range(missing * 4):
            if len(candidates) >= missing:
                break
            candidate = ids.random_package_id()
            if candidate not in tried:
                tried.add(candidate)
                candidates.append(candidate)
        taken = _taken(con, candidates)
        granted.extend(candidate for candidate in candidates if candidate not in taken)
    con.executemany(
        "INSERT INTO id_reservations (package_id, device_id, granted_at) VALUES (?, ?, ?)",
        [(package_id, device_id, now) for package_id in granted],
    )
    return granted
