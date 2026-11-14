"""Warnstufen nach dem Mindesthaltbarkeitsdatum (Vertrag, docs/sync-protokoll.md, 3.2).

Gegenstück zu ``web/src/contract/mhd.ts``: ``days_until``, ``expiry_state`` und
``warn_days_for`` rechnen wie ``daysUntil``, ``expiryState`` und ``warnDaysFor``;
``soon_from`` und ``expired_from`` wie ``soonFrom`` und ``expiredFrom``. Beide Seiten werden
gegen dieselben Beispiele in ``docs/vectors.json`` (Abschnitt ``mhd``) getestet.

Alle Tage sind Kalendertage ``YYYY-MM-DD``. „Heute" ist in der App der Tag in der Zeitzone des
Geräts, im Server der Tag in ``STOWLY_TIMEZONE`` (docs/integrationen.md, Abschnitt 2).
"""

from collections.abc import Mapping
from datetime import date, timedelta
from typing import Any, Literal

from stowly.contract.timeutil import is_date

ExpiryState = Literal["none", "ok", "soon", "expired"]

_FIRST_DAY = "0001-01-01"


def _day(text: str) -> date:
    """Ein Kalendertag ``YYYY-MM-DD``; ``ValueError`` bei allem anderen (wie ``daysBetween``)."""
    if not isinstance(text, str) or not is_date(text):
        raise ValueError(f"Kein gültiges Datum: {text!r}")
    return date.fromisoformat(text)


def days_until(best_before: str | None, today: str) -> int | None:
    """Tage bis zum MHD: 0 = heute, negativ = abgelaufen, ``None`` = kein MHD."""
    if best_before is None:
        return None
    return (_day(best_before) - _day(today)).days


def expiry_state(best_before: str | None, warn_days: int, today: str) -> ExpiryState:
    """Warnstufe nach der Regel des Vertrags.

    Abgelaufen, wenn das MHD vor heute liegt; „läuft bald ab", wenn es in 0 bis ``warn_days``
    Tagen erreicht ist; sonst ``ok``. Ohne MHD ``none``.
    """
    days = days_until(best_before, today)
    if days is None:
        return "none"
    if days < 0:
        return "expired"
    return "soon" if days <= warn_days else "ok"


def warn_days_for(product: Mapping[str, Any] | None, settings: Mapping[str, Any]) -> int:
    """Vorlaufzeit für ein Produkt: der eigene Wert, sonst der des Haushalts. 0 ist ein eigener Wert."""
    if product is not None and product.get("warn_days") is not None:
        return int(product["warn_days"])
    return int(settings["warn_days"])


def soon_from(best_before: str | None, warn_days: int) -> str | None:
    """Erster Tag, an dem die Packung „bald" abläuft: MHD minus Vorlaufzeit.

    ``None`` ohne MHD. Läge der Tag vor dem 0001-01-01, ist es dieser: Früher gibt es keinen.
    """
    if best_before is None:
        return None
    day = _day(best_before)
    try:
        return (day - timedelta(days=warn_days)).isoformat()
    except OverflowError:
        return _FIRST_DAY


def expired_from(best_before: str | None) -> str | None:
    """Erster Tag, an dem die Packung abgelaufen ist: MHD plus ein Tag.

    ``None`` ohne MHD und beim 9999-12-31: Danach gibt es keinen Tag mehr.
    """
    if best_before is None:
        return None
    day = _day(best_before)
    try:
        return (day + timedelta(days=1)).isoformat()
    except OverflowError:
        return None
