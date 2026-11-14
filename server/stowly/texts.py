"""Kurze Texte für Sensor, Tagesnachricht und Bring! (docs/integrationen.md, 4.8, 5.2 und 6.1).

Gegenstücke in der App, wo es sie gibt: ``display_name`` rechnet wie ``productTitle``
(web/src/contract/labels.ts), ``quantity_label`` wie ``shoppingQuantityLabel``
(web/src/contract/shopping.ts). Gezählt wird in Zeichen (Unicode-Codepunkte), wie Home Assistant
die Länge eines Zustands zählt.
"""

from collections.abc import Sequence

UNKNOWN_PRODUCT = "Unbekanntes Produkt"
ELLIPSIS = "…"
TIMES = "×"


def display_name(name: str | None, first_barcode: str | None) -> str:
    """Anzeigename eines Produkts: der Name (getrimmt), sonst der erste Barcode, sonst „Unbekanntes Produkt"."""
    trimmed = (name or "").strip()
    if trimmed:
        return trimmed
    return first_barcode or UNKNOWN_PRODUCT


def sort_name(name: str) -> str:
    """Vergleichsform zum Sortieren: ``str.casefold()``, verglichen in der Reihenfolge der Unicode-Zeichen."""
    return name.casefold()


def name_key(name: str) -> str:
    """Vergleichsform eines Namens in Bring! (5.2): getrimmt, Leerraum innen zu einem Leerzeichen, casefold."""
    return " ".join(name.split()).casefold()


def shorten(text: str, limit: int) -> str:
    """Höchstens ``limit`` Zeichen; ist der Text länger, endet er gekürzt auf „…"."""
    if len(text) <= limit:
        return text
    return text[: max(limit - 1, 0)].rstrip() + ELLIPSIS


def day_month(day: str) -> str:
    """Ein Kalendertag ``YYYY-MM-DD`` als ``TT.MM.``."""
    return f"{day[8:10]}.{day[5:7]}."


def quantity_label(origin: str, quantity: int | None) -> str:
    """Die Menge eines Eintrags: „fehlt 2" (automatisch), „2×" (eigener mit Menge), sonst leer."""
    if quantity is None:
        return ""
    return f"fehlt {quantity}" if origin == "min_stock" else f"{quantity}{TIMES}"


def fitted(name: str, *, before: str = "", after: str = "", limit: int) -> str:
    """``before + name + after`` mit höchstens ``limit`` Zeichen; gekürzt wird nur der Name, mit „…"."""
    room = limit - len(before) - len(after)
    return before + shorten(name, max(room, 1)) + after


def counted(count: int) -> str:
    """Vorsatz für mehrere Packungen: „2× " bei 2 und mehr, sonst nichts."""
    return f"{count}{TIMES} " if count > 1 else ""


def joined(parts: Sequence[str]) -> str:
    """„A", „A und B", „A, B und C"."""
    if len(parts) <= 1:
        return "".join(parts)
    return f"{', '.join(parts[:-1])} und {parts[-1]}"


def cut_at_word(text: str, limit: int) -> str:
    """Höchstens ``limit`` Zeichen; ist der Text länger, endet er am letzten Wort davor mit „…".

    Ein Wort, das nicht mehr ganz hineinpasst, fällt weg. Satzzeichen, die danach am Ende stünden
    (Komma, Doppelpunkt), auch. Gibt es gar keine Wortgrenze, wird hart gekürzt.
    """
    if len(text) <= limit:
        return text
    head = text[: limit - 1]
    if not text[limit - 1].isspace():
        boundary = max(head.rfind(" "), 0)
        if boundary > 0:
            head = head[:boundary]
    return head.rstrip().rstrip(",;:").rstrip() + ELLIPSIS
