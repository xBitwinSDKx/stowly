"""Zeitstempel und Datumsangaben im Vertrag (docs/sync-protokoll.md, „Umgang mit Zeit").

Zeitstempel sind immer UTC, ISO 8601, genau drei Nachkommastellen und ``Z``:
``2026-11-13T10:15:30.123Z``. Das feste Format lässt sich als Text vergleichen
und sortieren, in SQLite wie in JavaScript (``new Date().toISOString()`` liefert es).
"""

from datetime import UTC, date, datetime, timedelta

from stowly.contract.ids import exact

# Ziffern als [0-9], nicht \d: Das träfe je nach Auswerter auch vollbreite und andere Ziffern.
# Gültig sind die Jahre 0001 bis 9999; das Jahr 0000 kennt der Kalender des Servers nicht.
TIMESTAMP_PATTERN = r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$"
DATE_PATTERN = r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
# Uhrzeit ohne Datum, "HH:MM" von 00:00 bis 23:59 (Einstellung notify_time, STOWLY_BACKUP_TIME).
TIME_OF_DAY_PATTERN = r"^([01][0-9]|2[0-3]):[0-5][0-9]$"
# Ein Kalendermonat "YYYY-MM" (Statistik).
MONTH_PATTERN = r"^[0-9]{4}-(0[1-9]|1[0-2])$"
_TIMESTAMP_RE = exact(TIMESTAMP_PATTERN)
_DATE_RE = exact(DATE_PATTERN)
_TIME_OF_DAY_RE = exact(TIME_OF_DAY_PATTERN)
_MONTH_RE = exact(MONTH_PATTERN)


def format_timestamp(moment: datetime) -> str:
    """Formatiert einen Zeitpunkt (mit Zeitzone) als Vertrags-Zeitstempel."""
    if moment.tzinfo is None:
        raise ValueError("Zeitpunkt ohne Zeitzone")
    utc = moment.astimezone(UTC)
    # Von Hand statt mit strftime: "%Y" schreibt Jahre vor 1000 je nach System ohne führende
    # Nullen, und der Zeitstempel ließe sich dann nicht mehr als Text vergleichen.
    return (
        f"{utc.year:04d}-{utc.month:02d}-{utc.day:02d}"
        f"T{utc.hour:02d}:{utc.minute:02d}:{utc.second:02d}.{utc.microsecond // 1000:03d}Z"
    )


def parse_timestamp(text: str) -> datetime:
    """Liest einen Vertrags-Zeitstempel. ``ValueError`` bei jedem anderen Format."""
    if not _TIMESTAMP_RE.match(text):
        raise ValueError(f"Kein gültiger Zeitstempel: {text!r}")
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=UTC)


def now() -> str:
    """Aktuelle Serverzeit als Vertrags-Zeitstempel."""
    return format_timestamp(datetime.now(UTC))


def is_timestamp(text: str) -> bool:
    if not _TIMESTAMP_RE.match(text):
        return False
    try:
        parse_timestamp(text)
    except ValueError:
        return False
    return True


def is_date(text: str) -> bool:
    """Wahr für ein existierendes Kalenderdatum ``YYYY-MM-DD``."""
    if not _DATE_RE.match(text):
        return False
    try:
        date.fromisoformat(text)
    except ValueError:
        return False
    return True


def is_time_of_day(text: str) -> bool:
    """Wahr für eine Uhrzeit ``HH:MM`` von ``00:00`` bis ``23:59``, zweistellig geschrieben."""
    return bool(_TIME_OF_DAY_RE.match(text))


def is_month(text: str) -> bool:
    """Wahr für einen Monat ``YYYY-MM`` der Jahre 0001 bis 9999."""
    return bool(_MONTH_RE.match(text)) and text[:4] != "0000"


def effective_time(at: str, sent_at: str, received: datetime) -> str:
    """Rechnet die Gerätezeit eines Befehls in Serverzeit um.

    Der Server vertraut nie der absoluten Uhr eines Geräts, nur dem Alter des
    Befehls: ``alter = sent_at - at`` (beides dieselbe Geräteuhr), mindestens 0.
    Ergebnis ist ``received - alter``, also nie in der Zukunft.
    """
    age = parse_timestamp(sent_at) - parse_timestamp(at)
    if age < timedelta(0):
        age = timedelta(0)
    return format_timestamp(received - age)
