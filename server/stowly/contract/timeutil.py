"""Zeitstempel und Datumsangaben im Vertrag (docs/sync-protokoll.md, „Umgang mit Zeit").

Zeitstempel sind immer UTC, ISO 8601, genau drei Nachkommastellen und ``Z``:
``2026-11-13T10:15:30.123Z``. Das feste Format lässt sich als Text vergleichen
und sortieren, in SQLite wie in JavaScript (``new Date().toISOString()`` liefert es).
"""

import re
from datetime import UTC, date, datetime, timedelta

TIMESTAMP_PATTERN = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$"
DATE_PATTERN = r"^\d{4}-\d{2}-\d{2}$"
_TIMESTAMP_RE = re.compile(TIMESTAMP_PATTERN)
_DATE_RE = re.compile(DATE_PATTERN)


def format_timestamp(moment: datetime) -> str:
    """Formatiert einen Zeitpunkt (mit Zeitzone) als Vertrags-Zeitstempel."""
    if moment.tzinfo is None:
        raise ValueError("Zeitpunkt ohne Zeitzone")
    utc = moment.astimezone(UTC)
    return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond // 1000:03d}Z"


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
