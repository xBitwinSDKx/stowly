"""Der Vertrag zwischen Server, Web-App und Druckdienst als Code.

Diese Modelle sind die **Quelle** aller Datentypen. Daraus entstehen

* ``docs/openapi.json`` (alle Endpunkte und Schemata) und
* ``web/src/contract/api.gen.ts`` (dieselben Typen für die Web-App)

über ``python -m stowly.contract.export``. Ein Test (``tests/test_contract.py``)
schlägt fehl, sobald Modelle und erzeugte Dateien auseinanderlaufen.

Die Regeln dazu stehen in ``docs/sync-protokoll.md`` und ``docs/etiketten.md``.
Wer hier etwas ändert, ändert den Vertrag für alle drei Teile.
"""

PROTOCOL_VERSION = 1

# Wie viele freie Packungs-IDs ein Gerät vorhalten soll (docs/sync-protokoll.md, „ID-Vorrat").
ID_POOL_TARGET = 300

# Obergrenzen eines Sync-Aufrufs.
MAX_COMMANDS_PER_SYNC = 500
MAX_CHANGES_PER_SYNC = 5000

__all__ = ["ID_POOL_TARGET", "MAX_CHANGES_PER_SYNC", "MAX_COMMANDS_PER_SYNC", "PROTOCOL_VERSION"]
