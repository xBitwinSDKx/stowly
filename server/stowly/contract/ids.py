"""Kennungen, QR-Inhalte und Barcodes (Vertrag).

Gegenstück in der Web-App: ``web/src/contract/ids.ts``, ``qr.ts`` und ``barcode.ts``.
Beide Seiten werden gegen dieselben Beispiele in ``docs/vectors.json`` getestet.

Die Konstanten ``*_PATTERN`` stehen so im Vertrag (``docs/openapi.json``) und prüfen in den
Modellen die Form. Sie sind in der Schreibweise von JSON Schema gehalten: Ziffern als
``[0-9]`` (die Kurzform für „Ziffer" träfe je nach Auswerter auch vollbreite und andere
Ziffern), das Ende als ``$``. Für Pythons ``re`` übersetzt sie ``exact``: Dort ließe
``$`` ein Zeilenende am Schluss durch.
"""

import re
import secrets
import uuid


def exact(pattern: str) -> re.Pattern[str]:
    r"""Ein Muster des Vertrags für Pythons ``re``: ``\Z`` statt ``$`` am Ende.

    ``re.match("^abc$", "abc\n")`` trifft, weil ``$`` in Python auch vor einem Zeilenende am
    Schluss gilt; ``\Z`` gilt nur am wirklichen Ende. In den Konstanten selbst kann ``\Z``
    nicht stehen: JSON Schema und der Auswerter der Modelle kennen es nicht.
    """
    if not pattern.endswith("$") or pattern.endswith("\\$"):
        raise ValueError(f"Das Muster endet nicht auf $: {pattern!r}")
    return re.compile(pattern[:-1] + r"\Z")


# --- Packungs-IDs ---------------------------------------------------------------------
# 5 Zeichen aus 32 (Crockford-Base32): keine I, L, O, U. 32^5 = 33.554.432 Kombinationen.
PACKAGE_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
PACKAGE_ID_LENGTH = 5
PACKAGE_ID_PATTERN = r"^[0-9A-HJKMNP-TV-Z]{5}$"
_PACKAGE_ID_RE = exact(PACKAGE_ID_PATTERN)
# Beim Eintippen verwechselte Zeichen werden auf das gemeinte abgebildet. U bleibt ungültig.
_TYPO_MAP = str.maketrans({"O": "0", "I": "1", "L": "1"})

# --- UUIDs ----------------------------------------------------------------------------
UUID_PATTERN = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
_UUID_RE = exact(UUID_PATTERN)

# --- QR-Inhalte -----------------------------------------------------------------------
QR_PACKAGE_PREFIX = "STOWLY/P/"
QR_ZONE_PREFIX = "STOWLY/Z/"
_QR_PACKAGE_RE = exact(r"^STOWLY/P/([0-9A-HJKMNP-TV-Z]{5})$")
_QR_ZONE_RE = exact(r"^STOWLY/Z/([0-9A-F]{32})$")

# --- Barcodes -------------------------------------------------------------------------
BARCODE_PATTERN = r"^([0-9]{8}|[0-9]{13})$"
_BARCODE_RE = exact(BARCODE_PATTERN)


def is_package_id(value: str) -> bool:
    """Wahr für genau fünf Zeichen des ID-Alphabets in Großschreibung."""
    return bool(_PACKAGE_ID_RE.match(value))


def normalize_package_id(text: str) -> str | None:
    """Macht aus einer Eingabe von Hand eine Packungs-ID oder ``None``.

    Leerraum und Bindestriche fallen weg, Kleinbuchstaben werden groß,
    O wird 0, I und L werden 1.
    """
    cleaned = re.sub(r"[\s\-]", "", text).upper().translate(_TYPO_MAP)
    return cleaned if is_package_id(cleaned) else None


def random_package_id() -> str:
    """Zufällige Packungs-ID aus einer kryptografisch guten Quelle."""
    return "".join(secrets.choice(PACKAGE_ID_ALPHABET) for _ in range(PACKAGE_ID_LENGTH))


def is_uuid(value: str) -> bool:
    """Wahr für eine UUID in der kanonischen Schreibweise (klein, mit Bindestrichen)."""
    return bool(_UUID_RE.match(value))


def new_uuid() -> str:
    return str(uuid.uuid4())


def package_qr(package_id: str) -> str:
    """QR-Inhalt eines Packungs-Etiketts: ``STOWLY/P/A2B3C``."""
    if not is_package_id(package_id):
        raise ValueError(f"Keine gültige Packungs-ID: {package_id!r}")
    return QR_PACKAGE_PREFIX + package_id


def zone_qr(zone_id: str) -> str:
    """QR-Inhalt eines Zonen-Etiketts: ``STOWLY/Z/`` + UUID als 32 große Hex-Zeichen."""
    if not is_uuid(zone_id):
        raise ValueError(f"Keine gültige Zonen-ID: {zone_id!r}")
    return QR_ZONE_PREFIX + zone_id.replace("-", "").upper()


def parse_qr(text: str) -> tuple[str, str] | None:
    """Erkennt Stowly-QR-Codes.

    Liefert ``("package", id)``, ``("zone", uuid)`` oder ``None`` für alles andere.
    Leerraum am Rand und Kleinschreibung werden toleriert.
    """
    candidate = text.strip().upper()
    match = _QR_PACKAGE_RE.match(candidate)
    if match:
        return ("package", match.group(1))
    match = _QR_ZONE_RE.match(candidate)
    if match:
        h = match.group(1).lower()
        return ("zone", f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}")
    return None


def gtin_check_digit(body: str) -> int:
    """Prüfziffer nach GS1 für die Ziffern ohne Prüfziffer (7 oder 12 Stellen)."""
    total = 0
    for position, char in enumerate(reversed(body)):
        total += int(char) * (3 if position % 2 == 0 else 1)
    return (10 - total % 10) % 10


def is_valid_barcode(code: str) -> bool:
    """Wahr für EAN-8 und EAN-13 mit stimmender Prüfziffer."""
    if not _BARCODE_RE.match(code):
        return False
    return gtin_check_digit(code[:-1]) == int(code[-1])


def normalize_barcode(raw: str) -> str | None:
    """Bringt einen gelesenen Produkt-Barcode in die gespeicherte Form.

    EAN-13 und EAN-8 bleiben, UPC-A (12 Stellen) bekommt eine führende Null.
    ``None`` bei falscher Länge, fremden Zeichen oder falscher Prüfziffer.
    """
    digits = raw.strip()
    if not digits.isascii() or not digits.isdigit():
        return None
    if len(digits) == 12:
        digits = "0" + digits
    return digits if is_valid_barcode(digits) else None


def is_store_internal_barcode(code: str) -> bool:
    """Ladeninterne Codes (Präfix 2) sind nicht eindeutig und werden nie nachgeschlagen."""
    return code.startswith("2")
