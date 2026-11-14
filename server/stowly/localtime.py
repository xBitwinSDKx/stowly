"""Zeit in der Zeitzone des Servers (docs/integrationen.md, Abschnitt 2).

Zeitstempel bleiben UTC (docs/sync-protokoll.md, Abschnitt 4). „Heute" und alle Uhrzeiten
(``STOWLY_BACKUP_TIME``, ``notify_time``) gelten dagegen in ``STOWLY_TIMEZONE``, nie in der
Zeitzone eines Geräts und nie in der Variable ``TZ`` des Containers. Die Zeitzonendaten liefert
das Paket ``tzdata``.

Sommer- und Winterzeit brauchen keinen Sonderfall, wenn man fragt, ob eine Uhrzeit *erreicht* ist:
Fällt sie in die Lücke beim Umstellen auf Sommerzeit, ist sie mit dem Sprung erreicht; gibt es sie
beim Umstellen auf Winterzeit zweimal, ist sie beim ersten Mal erreicht.
"""

from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo


def parse_time_of_day(text: str) -> time:
    """``HH:MM`` als Uhrzeit; die Form prüft ``timeutil.is_time_of_day``."""
    hours, minutes = text.split(":")
    return time(int(hours), int(minutes))


def local(moment: datetime, tz: ZoneInfo) -> datetime:
    """Ein Zeitpunkt (mit Zeitzone) in der Zeitzone des Servers."""
    if moment.tzinfo is None:
        raise ValueError("Zeitpunkt ohne Zeitzone")
    return moment.astimezone(tz)


def today(moment: datetime, tz: ZoneInfo) -> date:
    """Der Kalendertag in der Zeitzone des Servers."""
    return local(moment, tz).date()


def reached(moment: datetime, tz: ZoneInfo, hhmm: str) -> bool:
    """Ist es in der Zeitzone des Servers mindestens ``hhmm``? (Vergleich der Uhrzeit des Tages.)"""
    return local(moment, tz).time() >= parse_time_of_day(hhmm)


def _wall(moment: datetime, tz: ZoneInfo) -> datetime:
    return moment.astimezone(tz).replace(tzinfo=None)


def first_moment(day: date, hhmm: str, tz: ZoneInfo) -> datetime:
    """Der erste Zeitpunkt (UTC), zu dem die Uhr an ``day`` in ``tz`` mindestens ``hhmm`` zeigt.

    Gibt es die Uhrzeit zweimal (Winterzeit), ist es das erste Mal. Gibt es sie nicht (Sommerzeit),
    ist es der Sprung selbst: Zum Beispiel ist 02:30 am 29.03.2026 in Europe/Berlin um 03:00
    Ortszeit erreicht, also um 01:00 UTC.
    """
    wall = datetime.combine(day, parse_time_of_day(hhmm))
    found = [
        moment
        for moment in (wall.replace(tzinfo=tz, fold=fold).astimezone(UTC) for fold in (0, 1))
        if _wall(moment, tz) == wall
    ]
    if found:
        return min(found)
    # In der Lücke: zoneinfo rechnet mit fold=1 nach dem Versatz danach (der Zeitpunkt liegt vor dem
    # Sprung), mit fold=0 nach dem Versatz davor (er liegt dahinter). Dazwischen liegt der Sprung;
    # gesucht ist die erste Sekunde, deren Ortszeit die Uhrzeit erreicht hat.
    bounds = sorted(int(wall.replace(tzinfo=tz, fold=fold).timestamp()) for fold in (0, 1))
    low, high = bounds
    while high - low > 1:
        middle = (low + high) // 2
        if _wall(datetime.fromtimestamp(middle, UTC), tz) >= wall:
            high = middle
        else:
            low = middle
    return datetime.fromtimestamp(high, UTC)


def next_day(day: date) -> date:
    return day + timedelta(days=1)
