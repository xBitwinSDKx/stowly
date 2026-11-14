"""Die Befehle des Katalogs und ihre Konfliktregeln (docs/sync-protokoll.md, Abschnitte 6.6 und 7).

Jeder Befehl läuft in einem eigenen Sicherungspunkt (``service``). Ein Handler

* liefert ``applied`` oder ``displaced``,
* wirft ``Reject`` für eine Ablehnung nach Katalog (``not_found``, ``id_conflict`` …);
  alles, was er bis dahin geschrieben hat, wird zurückgerollt,
* wirft bei einem Programmfehler irgendetwas anderes: Daraus wird ``rejected``/``internal``.

Regeln, die für alle Handler gelten:

* **Wirksamer Zeitpunkt** (``self.at``) entscheidet Konflikte und steht in ``created_at``,
  ``updated_at``, ``removed_at`` und im Ereignisprotokoll.
* **Feld-Uhren** (``field_clocks``): Eine Feldänderung wird angewendet, wenn es für das
  Feld noch keine Uhr gibt oder ``at >= uhr``. Anlegen, Zusammenführen, das Löschen einer
  Zone und Open Food Facts stellen keine Uhren: Dort hat niemand ein Feld bearbeitet.
* **Echo:** Jeder ausgeführte Befehl gibt dem Datensatz, den er anspricht, einen neuen
  ``rev``, auch wenn sich nichts geändert hat (Änderung hat verloren, Befehl ohne Wirkung).
  So bekommt das Gerät in derselben Antwort den Stand des Servers und muss nicht raten,
  ob seine lokale Vorwegnahme noch stimmt.
* **Verweise** auf ein zusammengeführtes Produkt folgen ``merged_into``, Verweise auf eine
  gelöschte Zone ``moved_to``, jeweils über mehrere Schritte.
"""

import json
import sqlite3
from collections.abc import Callable, Mapping
from typing import Any

from stowly import db, events, off, records
from stowly.contract import commands as c
from stowly.contract.ids import is_store_internal_barcode, is_valid_barcode
from stowly.contract.sync import CommandStatus, RejectCode
from stowly.contract.timeutil import is_date, is_timestamp
from stowly_print.model import to_dict

# Uhr für Entnehmen und Wiederherstellen einer Packung (Abschnitt 7.2).
REMOVED_CLOCK = "removed"
# Uhren der verdrängten Bearbeitung je Feld: „je Feld die spätere behalten".
DISPLACED_CLOCK_PREFIX = "displaced."
# Uhr für den Zustand eines Etiketts samt printer_id, boot_id und error.
JOB_STATE_CLOCK = "state"
# Zwischenstände eines Etiketts beim Druckdienst und die Zustände, die sie nie überschreiben:
# ein Ausgang (auch der offene, ``unknown``) und das Verwerfen (Abschnitt 6.6).
PROGRESS_STATES = frozenset({"queued", "printing"})
OUTCOME_STATES = frozenset({"printed", "sent", "failed", "cancelled", "unknown"})


def progress_after_outcome(current: str, reported: str) -> bool:
    """Wahr, wenn ein Zwischenstand ein Etikett treffen würde, das schon einen Ausgang hat.

    Eine solche Meldung ändert nichts, gleich welchen Zeitpunkt sie trägt: Sie ist älter als
    das, was das Etikett schon weiß (etwa ``queued``, gemeldet, nachdem der Server ``printed``
    selbst fortgeschrieben hat). Gilt für ``print.report`` und für das Fortschreiben des Servers.
    """
    return reported in PROGRESS_STATES and current in OUTCOME_STATES


PACKAGE_FIELDS = ("best_before", "zone_id", "product_id")
# Mehr Schritte hat keine Kette aus Zusammenführungen oder gelöschten Zonen; schützt vor Schleifen.
MAX_HOPS = 1000

APPLIED = CommandStatus.APPLIED
DISPLACED = CommandStatus.DISPLACED


class Reject(Exception):
    """Ablehnung eines Befehls nach Katalog. Kein Fehler des Servers."""

    def __init__(self, code: RejectCode, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


# Was in eine INTEGER-Spalte von SQLite passt.
_INT64_MIN, _INT64_MAX = -(2**63), 2**63 - 1


def _invalid(reason: str) -> "Reject":
    return Reject(RejectCode.INVALID, f"Der Befehl entspricht nicht dem Vertrag: {reason}")


def check_semantics(command: Any) -> None:
    """Formate, die sich nicht als Muster ausdrücken lassen: Die Modelle prüfen nur die Form.

    * Ein Zeitstempel im 13. Monat, der 30. Februar und ein Barcode mit falscher Prüfziffer
      passen auf das Muster und sind trotzdem ungültig (docs/vectors.json).
    * Ziffern sind 0 bis 9, nichts sonst: Sonst gäbe es denselben Barcode zweimal, einmal je
      Schreibweise. Die Muster des Vertrags lassen andere Ziffern (etwa vollbreite) inzwischen
      selbst nicht mehr durch; die Prüfung auf ASCII hier ist die zweite Sicherung.
    * ``sort`` ist im Modell unbegrenzt, die Spalte fasst 64 Bit.
    """
    if not command.at.isascii() or not is_timestamp(command.at):
        raise _invalid("'at' ist kein Zeitpunkt.")
    barcodes: list[str] = []
    best_before: str | None = None
    sort: int | None = None
    if isinstance(command, c.CmdProductCreate):
        barcodes = command.barcodes
    elif isinstance(command, c.CmdProductAddBarcode | c.CmdProductRemoveBarcode):
        barcodes = [command.barcode]
    elif isinstance(command, c.CmdPackageCreate):
        best_before = command.best_before
    elif isinstance(command, c.CmdPackageUpdate) and "best_before" in command.changes.model_fields_set:
        best_before = command.changes.best_before
    elif isinstance(command, c.CmdZoneCreate):
        sort = command.sort
    elif isinstance(command, c.CmdZoneUpdate) and "sort" in command.changes.model_fields_set:
        sort = command.changes.sort
    for barcode in barcodes:
        if not barcode.isascii() or not is_valid_barcode(barcode):
            raise _invalid(f"{barcode} ist kein Barcode mit gültiger Prüfziffer.")
    if best_before is not None and (not best_before.isascii() or not is_date(best_before)):
        raise _invalid(f"{best_before} ist kein Kalendertag.")
    if sort is not None and not _INT64_MIN <= sort <= _INT64_MAX:
        raise _invalid("'sort' ist zu groß.")


def _plain(value: Any) -> Any:
    """Enum-Werte als Text, alles andere unverändert."""
    return getattr(value, "value", value)


def _without_token(config: Any) -> Any:
    """Die Konfiguration eines Druckers für das Ereignisprotokoll: nie mit Token."""
    if isinstance(config, dict):
        return {key: value for key, value in config.items() if key != "token"}
    return config


class CommandRunner:
    """Führt die Befehle eines Sync-Aufrufs aus. Ein Exemplar je Aufruf."""

    def __init__(
        self, con: sqlite3.Connection, *, device_id: str, recorded_at: str, off_enabled: bool
    ) -> None:
        self.con = con
        self.device_id = device_id
        self.recorded_at = recorded_at
        self.off_enabled = off_enabled
        # Wahr, sobald ein Produkt auf das Nachschlagen wartet: Dann wird der Hintergrund-Ablauf geweckt.
        self.lookup_pending = False
        self.command_id = ""
        self.at = ""
        # Produkte, die der laufende Befehl auf ``pending`` gestellt hat (Abschnitt 10).
        self._waiting: list[str] = []

    def run(self, command: Any, at: str) -> CommandStatus:
        """Führt einen geprüften Befehl mit dem wirksamen Zeitpunkt ``at`` aus."""
        self.command_id = command.id
        self.at = at
        self._waiting = []
        status = _HANDLERS[command.type](self, command)
        # Steht ein Ergebnis von Open Food Facts schon fest, gilt es gleich, im selben Abgleich.
        # Erst nach dem Befehl: Im Ereignisprotokoll steht die Ursache vor der Wirkung.
        for product_id in self._waiting:
            off.settle(self.con, product_id, self.recorded_at)
        return status

    # ------------------------------------------------------------------ Bausteine

    def _rev(self) -> int:
        return db.next_rev(self.con)

    def _event(self, type_: str, entity: str, entity_id: str, data: dict[str, Any]) -> None:
        events.record(
            self.con,
            at=self.at,
            recorded_at=self.recorded_at,
            device_id=self.device_id,
            command_id=self.command_id,
            type=type_,
            entity=entity,
            entity_id=entity_id,
            data=data,
        )

    def _clock(self, entity: str, entity_id: str, field: str) -> str | None:
        row = self.con.execute(
            "SELECT at FROM field_clocks WHERE entity = ? AND entity_id = ? AND field = ?",
            (entity, entity_id, field),
        ).fetchone()
        return None if row is None else str(row["at"])

    def _wins(self, entity: str, entity_id: str, field: str) -> bool:
        """Abschnitt 7.1: gewinnt, wenn es keine Uhr gibt oder ``at >= uhr``; stellt dann die Uhr.

        Bei gleichem Zeitpunkt gewinnt, was der Server später verarbeitet.
        """
        clock = self._clock(entity, entity_id, field)
        if clock is not None and self.at < clock:
            return False
        self.con.execute(
            "INSERT INTO field_clocks (entity, entity_id, field, at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT (entity, entity_id, field) DO UPDATE SET at = excluded.at",
            (entity, entity_id, field, self.at),
        )
        return True

    def _decide(
        self, entity: str, entity_id: str, current: Mapping[str, Any], wanted: Mapping[str, Any]
    ) -> tuple[dict[str, tuple[Any, Any]], dict[str, Any]]:
        """Entscheidet je Feld. Liefert ``(angewendet {feld: (alt, neu)}, unterlegen {feld: wert})``."""
        applied: dict[str, tuple[Any, Any]] = {}
        superseded: dict[str, Any] = {}
        for field, value in wanted.items():
            if self._wins(entity, entity_id, field):
                applied[field] = (current[field], value)
            else:
                superseded[field] = value
        return applied, superseded

    def _field_event(
        self,
        type_: str,
        entity: str,
        entity_id: str,
        applied: Mapping[str, tuple[Any, Any]],
        superseded: Mapping[str, Any],
    ) -> None:
        """Der überschriebene Wert (``old``) und die unterlegene Änderung (``superseded``)."""
        changes = {field: {"old": old, "new": new} for field, (old, new) in applied.items() if old != new}
        if changes or superseded:
            self._event(type_, entity, entity_id, {"changes": changes, "superseded": dict(superseded)})

    def _update(self, table: str, entity_id: str, values: Mapping[str, Any], *, changed: bool) -> None:
        """Schreibt Spalten und gibt der Zeile einen neuen ``rev`` (auch ohne Spalten: Echo).

        ``changed`` schreibt ``updated_at`` fort: der späteste wirksame Zeitpunkt einer
        angewendeten Änderung, also nie rückwärts.
        """
        assignments = [f"{column} = ?" for column in values]
        parameters: list[Any] = list(values.values())
        if changed:
            assignments.append("updated_at = max(updated_at, ?)")
            parameters.append(self.at)
        assignments.append("rev = ?")
        parameters.append(self._rev())
        self.con.execute(
            f"UPDATE {table} SET {', '.join(assignments)} WHERE id = ?", (*parameters, entity_id)
        )

    def _touch_settings(self) -> None:
        self.con.execute("UPDATE counters SET value = ? WHERE name = 'settings_rev'", (self._rev(),))

    def _set_setting(self, key: str, value: Any) -> None:
        self.con.execute(
            "UPDATE settings SET value = ?, updated_at = max(updated_at, ?) WHERE key = ?",
            (json.dumps(value), self.at, key),
        )

    # ------------------------------------------------------------------ Verweisen folgen

    def _resolve_product(self, product_id: str) -> sqlite3.Row | None:
        """Das Produkt hinter einer Kennung; folgt ``merged_into`` über alle Schritte."""
        row = self.con.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
        for _hop in range(MAX_HOPS):
            if row is None or row["merged_into"] is None:
                break
            row = self.con.execute("SELECT * FROM products WHERE id = ?", (row["merged_into"],)).fetchone()
        if row is None or row["deleted_at"] is not None:
            return None
        return row

    def _product(self, product_id: str) -> sqlite3.Row:
        row = self._resolve_product(product_id)
        if row is None:
            raise Reject(RejectCode.NOT_FOUND, "Das Produkt gibt es nicht.")
        return row

    def _resolve_zone(self, zone_id: str) -> sqlite3.Row | None:
        """Die Zone hinter einer Kennung; folgt ``moved_to`` über alle Schritte."""
        row = self.con.execute("SELECT * FROM zones WHERE id = ?", (zone_id,)).fetchone()
        for _hop in range(MAX_HOPS):
            if row is None or row["deleted_at"] is None or row["moved_to"] is None:
                break
            row = self.con.execute("SELECT * FROM zones WHERE id = ?", (row["moved_to"],)).fetchone()
        if row is None or row["deleted_at"] is not None:
            return None
        return row

    def _zone(self, zone_id: str) -> sqlite3.Row:
        row = self._resolve_zone(zone_id)
        if row is None:
            raise Reject(RejectCode.NOT_FOUND, "Die Zone gibt es nicht.")
        return row

    def _package(self, package_id: str) -> sqlite3.Row:
        row = self.con.execute("SELECT * FROM packages WHERE id = ?", (package_id,)).fetchone()
        if row is None:
            raise Reject(RejectCode.NOT_FOUND, "Die Packung gibt es nicht.")
        return row

    def _barcodes(self, product_id: str) -> list[str]:
        rows = self.con.execute(
            "SELECT barcode FROM product_barcodes WHERE product_id = ? ORDER BY barcode", (product_id,)
        )
        return [row["barcode"] for row in rows]

    # ------------------------------------------------------------------ Open Food Facts

    def _refresh_lookup(self, product_id: str) -> None:
        """Stellt ``lookup`` nach einer Änderung an den Barcodes neu (Abschnitt 10).

        Wartet das Produkt danach und steht das Ergebnis schon in ``off_lookups`` (etwa weil der
        Barcode beim Scannen nachgeschlagen wurde), bekommt es die Daten am Ende des Befehls,
        im selben Abgleich (``run``): leere Felder füllen, Bild anhängen. Sonst wartet es, und
        der Hintergrund-Ablauf fragt bei Open Food Facts nach. Ist das Nachschlagen
        abgeschaltet, bleibt der Zustand, wie er ist (neu: ``none``).
        """
        if not self.off_enabled:
            return
        row = self.con.execute(
            "SELECT lookup, deleted_at FROM products WHERE id = ?", (product_id,)
        ).fetchone()
        if row is None or row["deleted_at"] is not None or row["lookup"] == "found":
            return
        codes = [code for code in self._barcodes(product_id) if not is_store_internal_barcode(code)]
        states: dict[str, str] = {}
        for code in codes:
            known = self.con.execute("SELECT state FROM off_lookups WHERE barcode = ?", (code,)).fetchone()
            if known is None:
                self.con.execute(
                    "INSERT INTO off_lookups (barcode, state, attempts, next_attempt_at) VALUES (?, 'pending', 0, ?)",
                    (code, self.recorded_at),
                )
                states[code] = "pending"
            else:
                states[code] = known["state"]
        if not codes:
            wanted = "none"
        elif row["lookup"] == "not_found" and all(state == "not_found" for state in states.values()):
            # Nichts Neues nachzuschlagen: Es bleibt dabei.
            wanted = "not_found"
        else:
            wanted = "pending"
            # Der Ablauf schaut auch dann nach, wenn das Ergebnis schon feststeht: Fehlt das
            # Bild noch, holt er es.
            self.lookup_pending = True
        if wanted != row["lookup"]:
            self._update("products", product_id, {"lookup": wanted}, changed=False)
        if wanted == "pending" and product_id not in self._waiting:
            self._waiting.append(product_id)

    # ------------------------------------------------------------------ Produkte

    def _merge(self, source_id: str, target_id: str, reason: str) -> None:
        """Führt ``source`` in ``target`` zusammen (Abschnitt 7.3)."""
        con = self.con
        # 1. Alle Packungen, auch entnommene, gehören danach zum Ziel. Ein gemeinsamer rev.
        moved = con.execute(
            "UPDATE packages SET product_id = ?, updated_at = max(updated_at, ?), rev = ? WHERE product_id = ?",
            (target_id, self.at, self._rev(), source_id),
        ).rowcount
        # 2. Alle Barcodes ebenso.
        barcodes = self._barcodes(source_id)
        con.execute("UPDATE product_barcodes SET product_id = ? WHERE product_id = ?", (target_id, source_id))
        # 3. Leere Felder des Ziels übernehmen den Wert der Quelle.
        source = con.execute("SELECT * FROM products WHERE id = ?", (source_id,)).fetchone()
        target = con.execute("SELECT * FROM products WHERE id = ?", (target_id,)).fetchone()
        filled: dict[str, Any] = {}
        for field in ("name", "brand", "quantity"):
            if target[field] == "" and source[field] != "":
                filled[field] = source[field]
        for field in ("warn_days", "image", "min_stock"):
            if target[field] is None and source[field] is not None:
                filled[field] = source[field]
        self._update("products", target_id, filled, changed=True)
        # 4. Die Quelle bleibt als Grabstein: Alte Verweise folgen merged_into.
        self._update(
            "products",
            source_id,
            {"deleted_at": self.at, "merged_into": target_id, "lookup": "none"},
            changed=True,
        )
        self._refresh_lookup(target_id)
        self._event(
            "product.merged",
            "product",
            target_id,
            {
                "source_id": source_id,
                "reason": reason,
                "packages": moved,
                "barcodes": barcodes,
                "filled": sorted(filled),
            },
        )

    def _product_create(self, cmd: c.CmdProductCreate) -> CommandStatus:
        con = self.con
        if con.execute("SELECT 1 FROM products WHERE id = ?", (cmd.product_id,)).fetchone() is not None:
            raise Reject(RejectCode.ID_CONFLICT, "Diese Produkt-Kennung ist schon vergeben.")
        barcodes = list(dict.fromkeys(cmd.barcodes))
        # Gehört einer der Barcodes schon einem anderen Produkt, entsteht das neue als
        # Zusammenführung: Ziel ist der Besitzer des ersten betroffenen Barcodes. Barcodes,
        # die einem dritten Produkt gehören, bleiben dort.
        target_id: str | None = None
        free: list[str] = []
        for barcode in barcodes:
            owner = con.execute(
                "SELECT product_id FROM product_barcodes WHERE barcode = ?", (barcode,)
            ).fetchone()
            if owner is None:
                free.append(barcode)
            elif target_id is None:
                target_id = owner["product_id"]
        con.execute(
            "INSERT INTO products (id, name, brand, quantity, warn_days, min_stock, lookup, created_at, updated_at, rev) "
            "VALUES (?, ?, ?, ?, ?, ?, 'none', ?, ?, ?)",
            (
                cmd.product_id,
                cmd.name,
                cmd.brand,
                cmd.quantity,
                cmd.warn_days,
                cmd.min_stock,
                self.at,
                self.at,
                self._rev(),
            ),
        )
        for barcode in free:
            con.execute(
                "INSERT INTO product_barcodes (barcode, product_id, created_at) VALUES (?, ?, ?)",
                (barcode, cmd.product_id, self.at),
            )
        self._event(
            "product.created",
            "product",
            cmd.product_id,
            {
                "name": cmd.name,
                "brand": cmd.brand,
                "quantity": cmd.quantity,
                "warn_days": cmd.warn_days,
                "min_stock": cmd.min_stock,
                "barcodes": barcodes,
            },
        )
        if target_id is None:
            self._refresh_lookup(cmd.product_id)
        else:
            self._merge(cmd.product_id, target_id, "barcode")
        return APPLIED

    def _product_update(self, cmd: c.CmdProductUpdate) -> CommandStatus:
        row = self._product(cmd.product_id)
        wanted = {field: getattr(cmd.changes, field) for field in sorted(cmd.changes.model_fields_set)}
        applied, superseded = self._decide("product", row["id"], row, wanted)
        self._update(
            "products",
            row["id"],
            {field: new for field, (_old, new) in applied.items()},
            changed=bool(applied),
        )
        self._field_event("product.updated", "product", row["id"], applied, superseded)
        return APPLIED

    def _product_add_barcode(self, cmd: c.CmdProductAddBarcode) -> CommandStatus:
        row = self._product(cmd.product_id)
        owner = self.con.execute(
            "SELECT product_id FROM product_barcodes WHERE barcode = ?", (cmd.barcode,)
        ).fetchone()
        if owner is None:
            self.con.execute(
                "INSERT INTO product_barcodes (barcode, product_id, created_at) VALUES (?, ?, ?)",
                (cmd.barcode, row["id"], self.at),
            )
            self._update("products", row["id"], {}, changed=True)
            self._refresh_lookup(row["id"])
            self._event("product.barcode_added", "product", row["id"], {"barcode": cmd.barcode})
        elif owner["product_id"] == row["id"]:
            self._update("products", row["id"], {}, changed=False)
        else:
            # Der bisherige Besitzer geht im genannten Produkt auf.
            self._merge(owner["product_id"], row["id"], "barcode")
        return APPLIED

    def _product_remove_barcode(self, cmd: c.CmdProductRemoveBarcode) -> CommandStatus:
        row = self._product(cmd.product_id)
        removed = self.con.execute(
            "DELETE FROM product_barcodes WHERE barcode = ? AND product_id = ?", (cmd.barcode, row["id"])
        ).rowcount
        self._update("products", row["id"], {}, changed=bool(removed))
        if removed:
            self._refresh_lookup(row["id"])
            self._event("product.barcode_removed", "product", row["id"], {"barcode": cmd.barcode})
        return APPLIED

    def _product_merge(self, cmd: c.CmdProductMerge) -> CommandStatus:
        source = self._product(cmd.source_id)
        target = self._product(cmd.target_id)
        if source["id"] == target["id"]:
            # Schon zusammengeführt (derselbe Wunsch von zwei Geräten) oder mit sich selbst.
            self._update("products", target["id"], {}, changed=False)
        else:
            self._merge(source["id"], target["id"], "user")
        return APPLIED

    # ------------------------------------------------------------------ Packungen

    def _package_create(self, cmd: c.CmdPackageCreate) -> CommandStatus:
        con = self.con
        if con.execute("SELECT 1 FROM packages WHERE id = ?", (cmd.package_id,)).fetchone() is not None:
            # Darf nicht still geheilt werden: Das Etikett ist bereits gedruckt (Abschnitt 7.5).
            raise Reject(RejectCode.ID_CONFLICT, "Diese Packungs-ID ist schon vergeben.")
        product = self._product(cmd.product_id)
        zone = self._zone(cmd.zone_id)
        con.execute(
            "INSERT INTO packages (id, product_id, zone_id, best_before, created_at, updated_at, created_by, rev) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                cmd.package_id,
                product["id"],
                zone["id"],
                cmd.best_before,
                self.at,
                self.at,
                self.device_id,
                self._rev(),
            ),
        )
        # Die Reservierung verfällt mit dem Anlegen, gleich welches Gerät sie hatte.
        con.execute("DELETE FROM id_reservations WHERE package_id = ?", (cmd.package_id,))
        self._event(
            "package.created",
            "package",
            cmd.package_id,
            {"product_id": product["id"], "zone_id": zone["id"], "best_before": cmd.best_before},
        )
        return APPLIED

    def _package_changes(self, changes: c.PackageChanges) -> dict[str, Any]:
        """Die gewünschten Feldwerte; Verweise folgen dabei Zusammenführung und gelöschter Zone."""
        fields = changes.model_fields_set
        wanted: dict[str, Any] = {}
        if "best_before" in fields:
            wanted["best_before"] = changes.best_before
        if "zone_id" in fields:
            wanted["zone_id"] = self._zone(changes.zone_id)["id"]
        if "product_id" in fields:
            wanted["product_id"] = self._product(changes.product_id)["id"]
        return wanted

    def _package_update(self, cmd: c.CmdPackageUpdate) -> CommandStatus:
        row = self._package(cmd.package_id)
        if row["removed_at"] is not None:
            # Nicht angewendet, also auch nicht geprüft: Abgelegt werden die Werte, wie sie
            # gewünscht waren. Verweisen folgt erst das Wiederherstellen.
            fields = cmd.changes.model_fields_set
            return self._displace(
                row, {field: getattr(cmd.changes, field) for field in PACKAGE_FIELDS if field in fields}
            )
        wanted = self._package_changes(cmd.changes)
        applied, superseded = self._decide("package", row["id"], row, wanted)
        self._update(
            "packages",
            row["id"],
            {field: new for field, (_old, new) in applied.items()},
            changed=bool(applied),
        )
        self._field_event("package.updated", "package", row["id"], applied, superseded)
        return APPLIED

    def _displace(self, row: sqlite3.Row, wanted: Mapping[str, Any]) -> CommandStatus:
        """Löschen gewinnt gegen Bearbeiten (Abschnitt 7.2).

        Die Bearbeitung wird nicht angewendet, egal welchen Zeitpunkt sie trägt. Die
        gewünschten Werte stehen danach in ``Package.displaced``; kommen mehrere solche
        Bearbeitungen, bleibt je Feld die spätere.
        """
        package_id = row["id"]
        if not wanted:
            # Eine Bearbeitung ohne Felder: nichts aufzuheben, aber auch sie traf eine entnommene Packung.
            self._update("packages", package_id, {}, changed=False)
            return DISPLACED
        values: dict[str, Any] = {}
        if row["displaced"] is not None:
            values = {change["field"]: change["value"] for change in json.loads(row["displaced"])["changes"]}
        kept: dict[str, Any] = {}
        for field, value in wanted.items():
            if self._wins("package", package_id, DISPLACED_CLOCK_PREFIX + field):
                values[field] = value
                kept[field] = value
        clocks = [self._clock("package", package_id, DISPLACED_CLOCK_PREFIX + field) for field in values]
        displaced = {
            "at": max((clock for clock in clocks if clock is not None), default=self.at),
            "changes": [
                {"field": field, "value": values[field]} for field in PACKAGE_FIELDS if field in values
            ],
        }
        # updated_at bleibt: Angewendet wurde nichts.
        self._update("packages", package_id, {"displaced": dumps(displaced)}, changed=False)
        if kept:
            self._event("package.edit_displaced", "package", package_id, {"changes": kept})
        return DISPLACED

    def _clear_displaced_clocks(self, package_id: str) -> None:
        self.con.execute(
            "DELETE FROM field_clocks WHERE entity = 'package' AND entity_id = ? AND field LIKE ?",
            (package_id, DISPLACED_CLOCK_PREFIX + "%"),
        )

    def _package_remove(self, cmd: c.CmdPackageRemove) -> CommandStatus:
        row = self._package(cmd.package_id)
        reason = cmd.reason.value
        # Entnehmen und Wiederherstellen teilen sich eine Uhr: Der spätere der beiden gewinnt.
        if not self._wins("package", row["id"], REMOVED_CLOCK):
            self._update("packages", row["id"], {}, changed=False)
        elif row["removed_at"] is None:
            self._update(
                "packages",
                row["id"],
                {"removed_at": self.at, "removal_reason": reason, "displaced": None},
                changed=True,
            )
            self._clear_displaced_clocks(row["id"])
            self._event(
                "package.removed",
                "package",
                row["id"],
                {
                    "reason": reason,
                    "product_id": row["product_id"],
                    "zone_id": row["zone_id"],
                    "best_before": row["best_before"],
                },
            )
        elif row["removal_reason"] != reason:
            # Schon entnommen: Es ändert sich nur der Grund, removed_at bleibt.
            self._update("packages", row["id"], {"removal_reason": reason}, changed=True)
            self._event(
                "package.reason_changed", "package", row["id"], {"old": row["removal_reason"], "new": reason}
            )
        else:
            self._update("packages", row["id"], {}, changed=False)
        return APPLIED

    def _package_restore(self, cmd: c.CmdPackageRestore) -> CommandStatus:
        row = self._package(cmd.package_id)
        # Die Uhr rückt auch vor, wenn die Packung gar nicht entnommen ist: Ein Entnehmen
        # mit früherem Zeitpunkt, das erst später eintrifft, verliert dann wie vorgesehen.
        if not self._wins("package", row["id"], REMOVED_CLOCK) or row["removed_at"] is None:
            self._update("packages", row["id"], {}, changed=False)
            return APPLIED

        displaced = None if row["displaced"] is None else json.loads(row["displaced"])
        self._update(
            "packages",
            row["id"],
            {"removed_at": None, "removal_reason": None, "displaced": None},
            changed=True,
        )
        self._clear_displaced_clocks(row["id"])
        apply = bool(cmd.apply_displaced and displaced and displaced["changes"])
        self._event("package.restored", "package", row["id"], {"applied_displaced": apply})
        if not apply:
            return APPLIED

        # Die verdrängten Werte gelten mit dem Zeitpunkt des Wiederherstellens. Verweise
        # werden jetzt aufgelöst: Zone oder Produkt können inzwischen aufgegangen sein.
        wanted: dict[str, Any] = {}
        for change in displaced["changes"]:
            field, value = change["field"], change["value"]
            if field == "best_before":
                wanted[field] = value
            elif field == "zone_id":
                zone = self._resolve_zone(value)
                if zone is not None:
                    wanted[field] = zone["id"]
            elif field == "product_id":
                product = self._resolve_product(value)
                if product is not None:
                    wanted[field] = product["id"]
        applied, superseded = self._decide("package", row["id"], row, wanted)
        self._update(
            "packages",
            row["id"],
            {field: new for field, (_old, new) in applied.items()},
            changed=bool(applied),
        )
        self._field_event("package.updated", "package", row["id"], applied, superseded)
        return APPLIED

    # ------------------------------------------------------------------ Zonen und Einstellungen

    def _zone_create(self, cmd: c.CmdZoneCreate) -> CommandStatus:
        if self.con.execute("SELECT 1 FROM zones WHERE id = ?", (cmd.zone_id,)).fetchone() is not None:
            raise Reject(RejectCode.ID_CONFLICT, "Diese Zonen-Kennung ist schon vergeben.")
        self.con.execute(
            "INSERT INTO zones (id, name, icon, color, sort, printer_id, created_at, updated_at, rev) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                cmd.zone_id,
                cmd.name,
                cmd.icon,
                cmd.color,
                cmd.sort,
                cmd.printer_id,
                self.at,
                self.at,
                self._rev(),
            ),
        )
        self._event(
            "zone.created",
            "zone",
            cmd.zone_id,
            {
                "name": cmd.name,
                "icon": cmd.icon,
                "color": cmd.color,
                "sort": cmd.sort,
                "printer_id": cmd.printer_id,
            },
        )
        return APPLIED

    def _zone_update(self, cmd: c.CmdZoneUpdate) -> CommandStatus:
        row = self.con.execute("SELECT * FROM zones WHERE id = ?", (cmd.zone_id,)).fetchone()
        if row is None or row["deleted_at"] is not None:
            raise Reject(RejectCode.NOT_FOUND, "Die Zone gibt es nicht.")
        wanted = {field: getattr(cmd.changes, field) for field in sorted(cmd.changes.model_fields_set)}
        applied, superseded = self._decide("zone", row["id"], row, wanted)
        self._update(
            "zones", row["id"], {field: new for field, (_old, new) in applied.items()}, changed=bool(applied)
        )
        self._field_event("zone.updated", "zone", row["id"], applied, superseded)
        return APPLIED

    def _zone_delete(self, cmd: c.CmdZoneDelete) -> CommandStatus:
        con = self.con
        row = con.execute("SELECT * FROM zones WHERE id = ?", (cmd.zone_id,)).fetchone()
        if row is None:
            raise Reject(RejectCode.NOT_FOUND, "Die Zone gibt es nicht.")
        if row["deleted_at"] is not None:
            self._update("zones", row["id"], {}, changed=False)
            return APPLIED
        remaining = con.execute("SELECT COUNT(*) FROM zones WHERE deleted_at IS NULL").fetchone()[0]
        if remaining <= 1:
            raise Reject(RejectCode.LAST_ZONE, "Die letzte Zone lässt sich nicht löschen.")
        if cmd.move_to == row["id"]:
            raise Reject(RejectCode.INVALID, "Die Packungen müssen in eine andere Zone wandern.")
        target = self._resolve_zone(cmd.move_to)
        if target is None:
            raise Reject(RejectCode.NOT_FOUND, "Die Zielzone gibt es nicht.")
        if target["id"] == row["id"]:
            # move_to ist eine gelöschte Zone, deren Packungen schon hierher verschoben wurden.
            raise Reject(RejectCode.INVALID, "Die Packungen müssen in eine andere Zone wandern.")

        # Alle Packungen, auch entnommene, wandern in die Zielzone. Ein gemeinsamer rev.
        moved = con.execute(
            "UPDATE packages SET zone_id = ?, updated_at = max(updated_at, ?), rev = ? WHERE zone_id = ?",
            (target["id"], self.at, self._rev(), row["id"]),
        ).rowcount
        self._update("zones", row["id"], {"deleted_at": self.at, "moved_to": target["id"]}, changed=True)
        self._event("zone.deleted", "zone", row["id"], {"moved_to": target["id"], "packages": moved})

        # Die Primärzone zieht mit, falls sie die gelöschte war.
        if records.settings_values(con).get("primary_zone_id") == row["id"]:
            self._set_setting("primary_zone_id", target["id"])
            self._touch_settings()
            self._event(
                "settings.updated",
                "settings",
                events.SETTINGS_ENTITY_ID,
                {
                    "changes": {"primary_zone_id": {"old": row["id"], "new": target["id"]}},
                    "superseded": {},
                },
            )
        return APPLIED

    def _settings_update(self, cmd: c.CmdSettingsUpdate) -> CommandStatus:
        current = records.settings_values(self.con)
        wanted = {
            field: _plain(getattr(cmd.changes, field)) for field in sorted(cmd.changes.model_fields_set)
        }
        applied, superseded = self._decide("settings", events.SETTINGS_ENTITY_ID, current, wanted)
        for field, (_old, new) in applied.items():
            self._set_setting(field, new)
        self._touch_settings()
        self._field_event("settings.updated", "settings", events.SETTINGS_ENTITY_ID, applied, superseded)
        return APPLIED

    # ------------------------------------------------------------------ Drucker

    def _printer_create(self, cmd: c.CmdPrinterCreate) -> CommandStatus:
        if self.con.execute("SELECT 1 FROM printers WHERE id = ?", (cmd.printer_id,)).fetchone() is not None:
            raise Reject(RejectCode.ID_CONFLICT, "Diese Drucker-Kennung ist schon vergeben.")
        connection = cmd.connection.value
        config = (cmd.server if cmd.server is not None else cmd.direct).model_dump(mode="json")
        self.con.execute(
            "INSERT INTO printers (id, name, connection, config, created_at, updated_at, rev) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (cmd.printer_id, cmd.name, connection, dumps(config), self.at, self.at, self._rev()),
        )
        self._event(
            "printer.created",
            "printer",
            cmd.printer_id,
            {"changes": {"name": cmd.name, "connection": connection, connection: _without_token(config)}},
        )
        return APPLIED

    def _printer_update(self, cmd: c.CmdPrinterUpdate) -> CommandStatus:
        row = self.con.execute("SELECT * FROM printers WHERE id = ?", (cmd.printer_id,)).fetchone()
        if row is None or row["deleted_at"] is not None:
            raise Reject(RejectCode.NOT_FOUND, "Den Drucker gibt es nicht.")
        fields = cmd.changes.model_fields_set
        own = row["connection"]
        other = "direct" if own == "server" else "server"
        if other in fields:
            raise Reject(
                RejectCode.INVALID,
                f"'{other}' passt nicht zu diesem Drucker: Die Art der Verbindung ändert sich nie.",
            )
        current = {"name": row["name"], own: json.loads(row["config"])}
        wanted: dict[str, Any] = {}
        if "name" in fields:
            wanted["name"] = cmd.changes.name
        if own in fields:
            wanted[own] = getattr(cmd.changes, own).model_dump(mode="json")
        applied, superseded = self._decide("printer", row["id"], current, wanted)
        values: dict[str, Any] = {}
        if "name" in applied:
            values["name"] = applied["name"][1]
        if own in applied:
            values["config"] = dumps(applied[own][1])
        self._update("printers", row["id"], values, changed=bool(applied))

        # Ins Protokoll ohne Token; ein geändertes Token wird nur als Tatsache vermerkt.
        changes: dict[str, Any] = {}
        for field, (old, new) in applied.items():
            if old == new:
                continue
            entry: dict[str, Any] = {"old": _without_token(old), "new": _without_token(new)}
            if field == "direct" and old.get("token") != new.get("token"):
                entry["token_changed"] = True
            changes[field] = entry
        lost = {field: _without_token(value) for field, value in superseded.items()}
        if changes or lost:
            self._event("printer.updated", "printer", row["id"], {"changes": changes, "superseded": lost})
        return APPLIED

    def _printer_delete(self, cmd: c.CmdPrinterDelete) -> CommandStatus:
        con = self.con
        row = con.execute("SELECT * FROM printers WHERE id = ?", (cmd.printer_id,)).fetchone()
        if row is None:
            raise Reject(RejectCode.NOT_FOUND, "Den Drucker gibt es nicht.")
        if row["deleted_at"] is not None:
            self._update("printers", row["id"], {}, changed=False)
            return APPLIED
        self._update("printers", row["id"], {"deleted_at": self.at}, changed=True)
        # Verweise in Zonen und Einstellungen zeigen danach auf nichts mehr.
        zones = con.execute(
            "UPDATE zones SET printer_id = NULL, updated_at = max(updated_at, ?), rev = ? WHERE printer_id = ?",
            (self.at, self._rev(), row["id"]),
        ).rowcount
        was_default = records.settings_values(con).get("default_printer_id") == row["id"]
        if was_default:
            self._set_setting("default_printer_id", None)
            self._touch_settings()
        self._event(
            "printer.deleted",
            "printer",
            row["id"],
            {
                "changes": {"deleted_at": {"old": None, "new": self.at}},
                "zones": zones,
                "default": was_default,
            },
        )
        return APPLIED

    def _printer_report(self, cmd: c.CmdPrinterReport) -> CommandStatus:
        """Der zuletzt gesehene Zustand als Ganzes; die jüngere Beobachtung gewinnt. Kein Protokolleintrag."""
        con = self.con
        if con.execute("SELECT 1 FROM printers WHERE id = ?", (cmd.printer_id,)).fetchone() is None:
            raise Reject(RejectCode.NOT_FOUND, "Den Drucker gibt es nicht.")
        known = con.execute(
            "SELECT observed_at FROM printer_status WHERE printer_id = ?", (cmd.printer_id,)
        ).fetchone()
        if known is not None and self.at < known["observed_at"]:
            con.execute(
                "UPDATE printer_status SET rev = ? WHERE printer_id = ?", (self._rev(), cmd.printer_id)
            )
            return APPLIED
        con.execute(
            "INSERT INTO printer_status (printer_id, observed_at, device_id, boot_id, status, host, rev) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT (printer_id) DO UPDATE SET observed_at = excluded.observed_at, "
            "device_id = excluded.device_id, boot_id = excluded.boot_id, status = excluded.status, "
            "host = excluded.host, rev = excluded.rev",
            (
                cmd.printer_id,
                self.at,
                self.device_id,
                cmd.boot_id,
                None if cmd.status is None else dumps(to_dict(cmd.status)),
                None if cmd.host is None else dumps(to_dict(cmd.host)),
                self._rev(),
            ),
        )
        return APPLIED

    # ------------------------------------------------------------------ Etiketten

    def _print_request(self, cmd: c.CmdPrintRequest) -> CommandStatus:
        con = self.con
        if con.execute("SELECT 1 FROM print_jobs WHERE id = ?", (cmd.job_id,)).fetchone() is not None:
            raise Reject(RejectCode.ID_CONFLICT, "Diese Etikett-Kennung ist schon vergeben.")
        # Abgelehnt wird nur, was es nie gab. Entnommene Packungen, gelöschte Zonen und gelöschte
        # Drucker gelten: Der Katalog nennt „auch gelöscht" bei zone.update und printer.update,
        # hier nicht; und das Entnehmen oder Löschen kann von einem anderen Gerät stammen.
        if cmd.package_id is not None:
            self._package(cmd.package_id)
        elif con.execute("SELECT 1 FROM zones WHERE id = ?", (cmd.zone_id,)).fetchone() is None:
            raise Reject(RejectCode.NOT_FOUND, "Die Zone gibt es nicht.")
        if cmd.printer_id is not None:
            if con.execute("SELECT 1 FROM printers WHERE id = ?", (cmd.printer_id,)).fetchone() is None:
                raise Reject(RejectCode.NOT_FOUND, "Den Drucker gibt es nicht.")
        kind = cmd.kind.value
        con.execute(
            "INSERT INTO print_jobs (id, kind, package_id, zone_id, printer_id, state, device_id, "
            "created_at, updated_at, rev) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
            (
                cmd.job_id,
                kind,
                cmd.package_id,
                cmd.zone_id,
                cmd.printer_id,
                self.device_id,
                self.at,
                self.at,
                self._rev(),
            ),
        )
        self._event(
            "print.requested",
            "print_job",
            cmd.job_id,
            {
                "kind": kind,
                "state": "pending",
                "printer_id": cmd.printer_id,
                "error": None,
                "package_id": cmd.package_id,
                "zone_id": cmd.zone_id,
            },
        )
        return APPLIED

    def _print_report(self, cmd: c.CmdPrintReport) -> CommandStatus:
        """Zustand samt ``printer_id``, ``boot_id`` und ``error`` als **ein** Feld (Abschnitt 7.1).

        Die jüngere Meldung gewinnt und ersetzt alle vier Werte, so wie sie im Befehl stehen;
        was er nicht nennt, ist ``null``. Nur so hängt das Ergebnis nicht von der Reihenfolge
        ab, in der die Meldungen eintreffen. Wer den Drucker behalten will, schickt ihn mit.
        """
        row = self.con.execute("SELECT * FROM print_jobs WHERE id = ?", (cmd.job_id,)).fetchone()
        if row is None:
            raise Reject(RejectCode.NOT_FOUND, "Das Etikett gibt es nicht.")
        # Ein Zwischenstand ändert kein Etikett mit Ausgang, gleich welchen Zeitpunkt er trägt; er
        # stellt auch die Uhr nicht. Der Befehl gilt trotzdem (applied, mit Echo, ohne Protokoll).
        if progress_after_outcome(row["state"], cmd.state.value) or not self._wins(
            "print_job", row["id"], JOB_STATE_CLOCK
        ):
            self._update("print_jobs", row["id"], {}, changed=False)
            return APPLIED
        state = cmd.state.value
        self._update(
            "print_jobs",
            row["id"],
            {"state": state, "error": cmd.error, "printer_id": cmd.printer_id, "boot_id": cmd.boot_id},
            changed=True,
        )
        self._event(
            "print.reported",
            "print_job",
            row["id"],
            {
                "kind": row["kind"],
                "state": state,
                "printer_id": cmd.printer_id,
                "error": cmd.error,
                "old": {"state": row["state"], "error": row["error"]},
            },
        )
        return APPLIED

    # ------------------------------------------------------------------ Einkaufsliste

    def _shopping_not_yet(self, _cmd: Any) -> CommandStatus:
        """Platzhalter bis Runde 1: Die Einkaufsliste (Protokoll 6.6 und 7.6) baut der Server-Worker."""
        raise Reject(RejectCode.INTERNAL, "Die Einkaufsliste ist in diesem Server noch nicht umgesetzt.")


_HANDLERS: dict[str, Callable[[CommandRunner, Any], CommandStatus]] = {
    "product.create": CommandRunner._product_create,
    "product.update": CommandRunner._product_update,
    "product.add_barcode": CommandRunner._product_add_barcode,
    "product.remove_barcode": CommandRunner._product_remove_barcode,
    "product.merge": CommandRunner._product_merge,
    "package.create": CommandRunner._package_create,
    "package.update": CommandRunner._package_update,
    "package.remove": CommandRunner._package_remove,
    "package.restore": CommandRunner._package_restore,
    "zone.create": CommandRunner._zone_create,
    "zone.update": CommandRunner._zone_update,
    "zone.delete": CommandRunner._zone_delete,
    "settings.update": CommandRunner._settings_update,
    "printer.create": CommandRunner._printer_create,
    "printer.update": CommandRunner._printer_update,
    "printer.delete": CommandRunner._printer_delete,
    "printer.report": CommandRunner._printer_report,
    "print.request": CommandRunner._print_request,
    "print.report": CommandRunner._print_report,
    "shopping_item.create": CommandRunner._shopping_not_yet,
    "shopping_item.update": CommandRunner._shopping_not_yet,
    "shopping_item.delete": CommandRunner._shopping_not_yet,
}


def subject_of(command_type: str, raw: Mapping[str, Any]) -> tuple[str, str]:
    """Art und Kennung des Datensatzes, um den es einem Befehl geht.

    Für den Eintrag ``command.rejected``; ``raw`` ist der Befehl wie empfangen und
    kann ungültig sein. Fehlt die Kennung, steht die des Befehls selbst.
    """
    entity, key = _SUBJECTS.get(command_type, ("command", "id"))
    if entity == "settings":
        return entity, events.SETTINGS_ENTITY_ID
    value = raw.get(key)
    if isinstance(value, str) and 0 < len(value) <= 80:
        return entity, value
    return entity, str(raw.get("id"))


_SUBJECTS: dict[str, tuple[str, str]] = {
    "product.create": ("product", "product_id"),
    "product.update": ("product", "product_id"),
    "product.add_barcode": ("product", "product_id"),
    "product.remove_barcode": ("product", "product_id"),
    "product.merge": ("product", "target_id"),
    "package.create": ("package", "package_id"),
    "package.update": ("package", "package_id"),
    "package.remove": ("package", "package_id"),
    "package.restore": ("package", "package_id"),
    "zone.create": ("zone", "zone_id"),
    "zone.update": ("zone", "zone_id"),
    "zone.delete": ("zone", "zone_id"),
    "settings.update": ("settings", ""),
    "printer.create": ("printer", "printer_id"),
    "printer.update": ("printer", "printer_id"),
    "printer.delete": ("printer", "printer_id"),
    "printer.report": ("printer", "printer_id"),
    "print.request": ("print_job", "job_id"),
    "print.report": ("print_job", "job_id"),
    "shopping_item.create": ("shopping_item", "item_id"),
    "shopping_item.update": ("shopping_item", "item_id"),
    "shopping_item.delete": ("shopping_item", "item_id"),
}
