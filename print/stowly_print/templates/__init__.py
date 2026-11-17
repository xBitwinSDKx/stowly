"""Mitgelieferte Etikett-Vorlagen (docs/etiketten.md, Abschnitt „Vorlage").

Die Vorlagen sind Daten. Der Server verteilt sie über den Sync an die Geräte,
und jedes Gerät legt sie seinem Druckauftrag bei. So muss ein Druckdienst ohne
Netz (der Pi im Keller) nie aktualisiert werden, wenn sich das Etikett ändert.
"""

import hashlib
import json
from importlib import resources
from typing import Any

from stowly_print.model import canonical_json

# Schlüssel im Sync (label_templates.key) -> Datei in diesem Paket
BUILTIN_TEMPLATES: dict[str, str] = {
    "package": "package-62x29.json",
    "zone": "zone-62x29.json",
}

# Format der mitgelieferten Vorlagen (62 mm endlos, ohne Papier-Kennung). Welche Formate der
# Renderer kann, steht in ``stowly_print.model.TEMPLATE_SCHEMAS``; Format 2 erzeugt der Server.
TEMPLATE_SCHEMA = 1


def load_builtin(key: str) -> dict[str, Any]:
    """Lädt eine mitgelieferte Vorlage. ``KeyError`` bei unbekanntem Schlüssel."""
    filename = BUILTIN_TEMPLATES[key]
    text = resources.files(__package__).joinpath(filename).read_text(encoding="utf-8")
    return json.loads(text)


def template_hash(body: dict[str, Any]) -> str:
    """Inhaltsadresse einer Vorlage: SHA-256 über das kanonische JSON, 16 Hex-Zeichen."""
    return hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()[:16]


def builtin_templates() -> dict[str, tuple[str, dict[str, Any]]]:
    """Alle mitgelieferten Vorlagen als ``{key: (hash, body)}``."""
    result: dict[str, tuple[str, dict[str, Any]]] = {}
    for key in BUILTIN_TEMPLATES:
        body = load_builtin(key)
        result[key] = (template_hash(body), body)
    return result
