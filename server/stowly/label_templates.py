"""Etikett-Vorlagen verteilen (docs/etiketten.md, Abschnitt „Vorlage").

Die mitgelieferten Vorlagen liegen im Paket ``stowly_print``. Der Server übernimmt sie
beim Start in die Tabelle ``label_templates``; von dort bekommen sie die Geräte über den
Sync und legen sie jedem Druckauftrag bei. Ändert sich eine Vorlage, ändert sich ihr
``hash``, die Zeile bekommt einen neuen ``rev``, und alle Geräte bekommen sie neu.
"""

import json
import sqlite3

from stowly import db
from stowly.contract import timeutil
from stowly_print.templates import builtin_templates


def install(con: sqlite3.Connection) -> list[str]:
    """Fügt neue Vorlagen ein und ersetzt geänderte. Liefert die betroffenen Schlüssel."""
    changed: list[str] = []
    with db.transaction(con):
        for key, (digest, body) in sorted(builtin_templates().items()):
            known = con.execute("SELECT hash FROM label_templates WHERE key = ?", (key,)).fetchone()
            if known is not None and known["hash"] == digest:
                continue
            con.execute(
                "INSERT INTO label_templates (key, hash, body, updated_at, rev) VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT (key) DO UPDATE SET hash = excluded.hash, body = excluded.body, "
                "updated_at = excluded.updated_at, rev = excluded.rev",
                (key, digest, json.dumps(body, ensure_ascii=False), timeutil.now(), db.next_rev(con)),
            )
            changed.append(key)
    return changed
