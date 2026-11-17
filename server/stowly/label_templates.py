"""Etikett-Vorlagen verteilen (docs/etiketten.md, 3.4; docs/plan-0.5.md, 1).

Die Geräte bekommen die Vorlagen über den Sync aus der Tabelle ``label_templates`` und legen sie jedem
Druckauftrag bei. Ohne eigene Gestaltung (keine Zeile in ``label_design``) sind es die mitgelieferten
Vorlagen aus ``stowly_print``, unverändert und mit ihrem ``hash``. Mit Gestaltung erzeugt sie der
Generator (``labels.template_for``); eine Etikettenart, die der Vorgabe entspricht, behält die
mitgelieferte. Ändert sich eine Vorlage, ändert sich ihr ``hash``, die Zeile bekommt einen neuen ``rev``,
und alle Geräte bekommen sie neu.

``install`` läuft beim Start (``app.prepare_database``) und nach jedem Speichern und Zurücksetzen der
Gestaltung (``api/labels.py``, dort mit ``install_in`` in derselben Transaktion).

Was in den beiden Tabellen steht, kann aus einer Sicherung stammen, also von außen. Gelesen wird darum
vorsichtig: Länge zuerst und in SQL, Text als Bytes und erst dann als UTF-8, jede Gestaltung gegen den
Vertrag und den Papier-Katalog. Eine Vorlage gilt nur, wenn ihr Rumpf zu ihrem ``hash`` passt; der Sync
liefert sie sonst nicht unbesehen an alle Geräte aus, sondern ``install`` schreibt sie neu.
"""

import json
import logging
import sqlite3
from typing import Any

from stowly import db, labels
from stowly.contract import timeutil
from stowly.contract.api import LabelDesign, LabelKind
from stowly_print import media as catalog
from stowly_print.templates import builtin_templates, template_hash

log = logging.getLogger("stowly.labels")

# Größer ist keine Gestaltung, die Stowly geschrieben hat (eine echte hat ein paar hundert Bytes), und
# keine Vorlage (eine erzeugte hat wenige Kilobyte).
MAX_DESIGN_BYTES = 64 * 1024
MAX_TEMPLATE_BYTES = 256 * 1024

# Was beim Lesen einer Zeile aus fremder Quelle schiefgehen kann. ValueError umfasst UnicodeError und
# pydantic.ValidationError.
UNREADABLE = (sqlite3.Error, ValueError, TypeError, RecursionError, MemoryError)
# Zuletzt gemeldetes Problem mit der gespeicherten Gestaltung: so steht es nur einmal im Log.
_reported: tuple[str, Any, str] | None = None


def byte_length(column: str) -> str:
    """SQL für die Länge eines Werts in Bytes, ohne ihn in Python zu laden. ``octet_length`` (SQLite ab
    3.43) liest dafür nicht einmal den Inhalt; ältere Versionen wandeln ihn in SQLite in ein BLOB."""
    if sqlite3.sqlite_version_info >= (3, 43, 0):
        return f"octet_length({column})"
    return f"length(CAST({column} AS BLOB))"


def parse_design(body: Any, updated_at: Any) -> tuple[LabelDesign, str]:
    """Eine Zeile aus ``label_design`` (Rumpf und ``updated_at`` als Bytes oder Text), geprüft.

    ``ValueError``, wenn sie nicht taugt: größer als ``MAX_DESIGN_BYTES``, kein gültiges UTF-8 (auch keine
    einzelnen Surrogate), kein ``LabelDesign`` nach dem Vertrag, ein Papier, das der Katalog nicht kennt,
    oder ``updated_at`` kein Zeitstempel. Auch ``restore._clean_candidate`` prüft damit.
    """
    raw = body if isinstance(body, bytes) else str(body).encode("utf-8")
    if len(raw) > MAX_DESIGN_BYTES:
        raise ValueError("Die Gestaltung ist zu groß.")
    # Der JSON-Parser von pydantic prüft UTF-8, lehnt einzelne Surrogate ab und begrenzt die Tiefe.
    design = LabelDesign.model_validate_json(raw)
    if catalog.paper(design.paper) is None:
        raise ValueError("Das Papier der Gestaltung steht nicht im Katalog.")
    stamp = updated_at.decode("utf-8") if isinstance(updated_at, bytes) else updated_at
    if not isinstance(stamp, str) or not timeutil.is_timestamp(stamp):
        raise ValueError("updated_at ist kein Zeitstempel.")
    return design, stamp


def stored_design(con: sqlite3.Connection) -> tuple[LabelDesign, str] | None:
    """Die gespeicherte Gestaltung und wann sie gespeichert wurde; ``None`` ohne eigene.

    Eine Zeile, die sich nicht lesen lässt oder nicht taugt (``parse_design``; etwa aus einer beschädigten
    oder gefälschten Sicherung), zählt wie keine; das steht einmal im Log, nicht bei jedem Aufruf (die
    Drucker am Server fragen bei jedem Auftrag). Das nächste Speichern ersetzt sie.
    """
    global _reported
    size: Any = None
    try:
        row = con.execute(f"SELECT {byte_length('body')} AS size FROM label_design WHERE id = 1").fetchone()
        if row is None:
            _reported = None
            return None
        size = row["size"]
        if not isinstance(size, int) or size > MAX_DESIGN_BYTES:
            raise ValueError("Die Gestaltung ist zu groß.")
        row = con.execute(
            "SELECT CAST(body AS BLOB) AS body, CAST(updated_at AS BLOB) AS updated_at "
            "FROM label_design WHERE id = 1"
        ).fetchone()
        if row is None:
            return None
        design = parse_design(row["body"], row["updated_at"])
    except UNREADABLE as exc:
        problem = (type(exc).__name__, size, str(exc)[:200])
        if problem != _reported:
            _reported = problem
            log.warning(
                "Die gespeicherte Gestaltung der Etiketten ist unbrauchbar (%s); es gelten die mitgelieferten "
                "Vorlagen.",
                type(exc).__name__,
            )
        return None
    _reported = None
    return design


def effective_design(con: sqlite3.Connection) -> tuple[LabelDesign, str | None]:
    """Die gültige Gestaltung: die gespeicherte oder die Vorgabe (``updated_at`` dann ``None``)."""
    stored = stored_design(con)
    if stored is None:
        return labels.DEFAULT_DESIGN, None
    return stored


def stored_template(con: sqlite3.Connection, key: str) -> tuple[str, dict[str, Any]] | None:
    """``(hash, rumpf)`` einer Zeile in ``label_templates``; ``None``, wenn es sie nicht gibt oder ihr Rumpf
    unlesbar ist oder nicht zu ihrem ``hash`` passt. Der ``hash`` wird dafür aus dem Rumpf neu berechnet:
    Der Spalte allein traut niemand."""
    try:
        row = con.execute(
            f"SELECT {byte_length('body')} AS size FROM label_templates WHERE key = ?", (key,)
        ).fetchone()
        if row is None or not isinstance(row["size"], int) or row["size"] > MAX_TEMPLATE_BYTES:
            return None
        row = con.execute(
            "SELECT CAST(hash AS BLOB) AS hash, CAST(body AS BLOB) AS body FROM label_templates WHERE key = ?",
            (key,),
        ).fetchone()
        if row is None:
            return None
        digest = row["hash"].decode("utf-8")
        body = json.loads(row["body"].decode("utf-8"))
        if not isinstance(body, dict) or template_hash(body) != digest:
            return None
        return digest, body
    except (*UNREADABLE, AttributeError):
        return None


def _wanted(con: sqlite3.Connection, *, use_design: bool) -> dict[str, dict[str, Any]]:
    """Die Vorlagen, die gelten sollen, als ``{key: body}``. Nie ein Rumpf aus fremder Quelle."""
    builtin = {key: body for key, (_digest, body) in builtin_templates().items()}
    stored = stored_design(con) if use_design else None
    if stored is None:
        return builtin
    design, _updated_at = stored
    wanted: dict[str, dict[str, Any]] = {}
    for kind in LabelKind:
        try:
            body = labels.template_for(kind, design.paper, getattr(design, kind.value))
            template_hash(body)  # muss sich als UTF-8 schreiben lassen
        except Exception as exc:  # eine gespeicherte Gestaltung hält den Start nie auf
            # Gespeichert wurde nur, was passte. Passt es nicht mehr (ein späterer Generator), bleibt die
            # Vorlage, die gerade gilt, sofern ihr Rumpf zu ihrem hash passt; sonst die mitgelieferte. Aus
            # einer Sicherung kommen keine Vorlagen (restore._clean_candidate), nur aus diesem Server.
            current = stored_template(con, kind.value)
            log.error(
                "Die Gestaltung der %s-Etiketten ergibt keine Vorlage (%s); es gilt die %s.",
                "Packungs" if kind == LabelKind.PACKAGE else "Zonen",
                exc.message if isinstance(exc, labels.LabelDesignError) else type(exc).__name__,
                "bisherige" if current is not None else "mitgelieferte",
            )
            body = builtin[kind.value] if current is None else current[1]
        wanted[kind.value] = body
    return wanted


def install_in(con: sqlite3.Connection, *, use_design: bool = True) -> list[str]:
    """Wie ``install``, innerhalb einer schon begonnenen Transaktion."""
    changed: list[str] = []
    for key, body in sorted(_wanted(con, use_design=use_design).items()):
        digest = template_hash(body)
        current = stored_template(con, key)
        if current is not None and current[0] == digest:
            continue
        con.execute(
            "INSERT INTO label_templates (key, hash, body, updated_at, rev) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT (key) DO UPDATE SET hash = excluded.hash, body = excluded.body, "
            "updated_at = excluded.updated_at, rev = excluded.rev",
            (key, digest, json.dumps(body, ensure_ascii=False), timeutil.now(), db.next_rev(con)),
        )
        changed.append(key)
    return changed


def install(con: sqlite3.Connection, *, use_design: bool = True) -> list[str]:
    """Fügt neue Vorlagen ein und ersetzt geänderte oder unstimmige: aus der Gestaltung, ohne eine (oder
    mit ``use_design=False``, dem Rückfall beim Start) die mitgelieferten. Liefert die betroffenen Schlüssel."""
    with db.transaction(con):
        return install_in(con, use_design=use_design)


def hashes(con: sqlite3.Connection) -> dict[str, str]:
    """``hash`` der Vorlagen, die gerade gelten, je Schlüssel."""
    rows = con.execute("SELECT key, CAST(hash AS BLOB) AS hash FROM label_templates").fetchall()
    return {str(row["key"]): bytes(row["hash"] or b"").decode("utf-8", "replace") for row in rows}
