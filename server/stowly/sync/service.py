"""Ablauf eines Sync-Aufrufs (docs/sync-protokoll.md, Abschnitt 6.2).

Der ganze Aufruf läuft in **einer** Transaktion: Entweder ist alles verbucht und
beantwortet oder nichts. Innerhalb davon bekommt jeder Befehl einen eigenen
Sicherungspunkt, damit ein einzelner ungültiger oder fehlschlagender Befehl nie die
ganze Anfrage scheitern lässt; sonst bliebe die Outbox des Geräts für immer stecken.
"""

import json
import logging
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from pydantic import TypeAdapter, ValidationError

from stowly import db, events
from stowly.contract import ID_POOL_TARGET, MAX_COMMANDS_PER_SYNC, PROTOCOL_VERSION, timeutil
from stowly.contract.api import ErrorCode
from stowly.contract.commands import Command
from stowly.contract.ids import is_uuid
from stowly.contract.sync import CommandStatus, RejectCode, SyncRequest, SyncResponse
from stowly.errors import ApiError
from stowly.sync import changes, idpool
from stowly.sync.handlers import CommandRunner, Reject, check_semantics, subject_of

log = logging.getLogger("stowly.sync")

COMMAND = TypeAdapter(Command)

# „Zuletzt gesehen" wird höchstens so oft fortgeschrieben.
LAST_SEEN_INTERVAL_S = 60

# Früher kann kein Befehl entstanden sein; siehe effective_time.
EARLIEST = datetime(2000, 1, 1, tzinfo=UTC)

_INVALID_REQUEST = "Die Anfrage entspricht nicht dem Vertrag."
_INTERNAL = "Fehler im Server. Der Befehl wurde verworfen."


@dataclass(frozen=True)
class Frame:
    """Der geprüfte Rahmen einer Anfrage; die Befehle sind noch roh."""

    request: SyncRequest  # ohne Befehle
    commands: list[dict[str, Any]]


@dataclass(frozen=True)
class Outcome:
    body: bytes  # die Antwort als JSON
    lookup_pending: bool  # ein Produkt wartet auf Open Food Facts


def _problem(loc: tuple[Any, ...], msg: str, type_: str) -> dict[str, Any]:
    return {"loc": ["body", *(str(part) for part in loc)], "msg": msg, "type": type_}


def parse_frame(body: Any) -> Frame:
    """Prüft Protokollversion (409), Zahl der Befehle (413) und den Rahmen (422).

    Die Befehle selbst prüft erst ``run``, jeden einzeln: Ein ungültiger Befehl ist
    kein Fehler der Anfrage. Nur seine ``id`` muss stimmen, sonst ließe sich ihm kein
    Ergebnis zuordnen.
    """
    if not isinstance(body, dict):
        raise ApiError(
            422,
            ErrorCode.INVALID_REQUEST,
            _INVALID_REQUEST,
            {"errors": [_problem((), "Der Rumpf muss ein JSON-Objekt sein.", "dict_type")]},
        )

    protocol = body.get("protocol")
    if isinstance(protocol, int) and not isinstance(protocol, bool) and protocol != PROTOCOL_VERSION:
        raise _protocol_mismatch(protocol)

    raw_commands = body.get("commands")
    if isinstance(raw_commands, list) and len(raw_commands) > MAX_COMMANDS_PER_SYNC:
        raise ApiError(
            413,
            ErrorCode.PAYLOAD_TOO_LARGE,
            f"Höchstens {MAX_COMMANDS_PER_SYNC} Befehle je Aufruf.",
            {"max_commands": MAX_COMMANDS_PER_SYNC, "commands": len(raw_commands)},
        )

    problems: list[dict[str, Any]] = []
    request: SyncRequest | None = None
    try:
        # Der Rahmen nach dem Vertragsmodell; die Befehle kommen danach einzeln dran.
        request = SyncRequest.model_validate({**body, "commands": []})
    except ValidationError as exc:
        problems.extend(
            _problem(error["loc"], str(error["msg"]), str(error["type"])) for error in exc.errors()
        )
    if request is not None and not (request.sent_at.isascii() and timeutil.is_timestamp(request.sent_at)):
        problems.append(_problem(("sent_at",), "Kein gültiger Zeitpunkt.", "timestamp"))

    commands: list[dict[str, Any]] = []
    if "commands" not in body:
        problems.append(_problem(("commands",), "Feld fehlt.", "missing"))
    elif not isinstance(raw_commands, list):
        problems.append(_problem(("commands",), "Muss eine Liste sein.", "list_type"))
    else:
        for index, raw in enumerate(raw_commands):
            if not isinstance(raw, dict):
                problems.append(_problem(("commands", index), "Muss ein Objekt sein.", "dict_type"))
            elif not _is_command_id(raw.get("id")):
                problems.append(
                    _problem(("commands", index, "id"), "Jeder Befehl braucht eine UUID als 'id'.", "uuid")
                )
            else:
                commands.append(raw)

    if problems or request is None:
        raise ApiError(422, ErrorCode.INVALID_REQUEST, _INVALID_REQUEST, {"errors": problems})
    if request.protocol != PROTOCOL_VERSION:
        raise _protocol_mismatch(request.protocol)
    return Frame(request=request, commands=commands)


def _is_command_id(value: Any) -> bool:
    """Eine UUID in kanonischer Schreibweise, genau 36 Zeichen.

    ``is_uuid`` lässt ein Zeilenende am Schluss inzwischen selbst nicht mehr durch. Die Länge
    wird trotzdem eigens geprüft: An dieser Kennung hängt die Zuordnung der Ergebnisse.
    """
    return isinstance(value, str) and len(value) == 36 and is_uuid(value)


def _protocol_mismatch(client: int) -> ApiError:
    return ApiError(
        409,
        ErrorCode.PROTOCOL_MISMATCH,
        "App und Server sprechen verschiedene Protokollversionen. Bitte die App aktualisieren.",
        {"server": PROTOCOL_VERSION, "client": client},
    )


def _invalid_message(exc: ValidationError) -> str:
    """Deutscher Klartext zu einem Befehl, der nicht zum Katalog passt."""
    errors = exc.errors()
    first = errors[0] if errors else {}
    if str(first.get("type", "")).startswith("union_tag"):
        return "Der Befehl entspricht nicht dem Vertrag: unbekannte oder fehlende Art ('type')."
    where = ".".join(str(part) for part in first.get("loc", ()))
    more = f" und {len(errors) - 1} weitere" if len(errors) > 1 else ""
    return f"Der Befehl entspricht nicht dem Vertrag: {where or 'Nutzlast'} ({first.get('type', 'ungültig')}){more}."


def _result(command_id: str, status: str, code: str | None, message: str | None, duplicate: bool) -> dict:
    return {"id": command_id, "status": status, "code": code, "message": message, "duplicate": duplicate}


# SQLite-Fehler, an denen kein Befehl schuld ist: INTERNAL, BUSY, LOCKED, NOMEM, READONLY,
# IOERR, CORRUPT, FULL, CANTOPEN, PROTOCOL. Alles andere (allen voran SQLITE_ERROR = 1, also
# ein Fehler in einer Anweisung) ist ein Fehler im Programm und trifft nur den einen Befehl.
_FAILING_DATABASE = frozenset({2, 5, 6, 7, 8, 10, 11, 13, 14, 15})


def database_is_failing(exc: BaseException) -> bool:
    """Wahr, wenn nicht der Befehl schuld ist, sondern die Datenbank selbst streikt.

    Der Unterschied entscheidet, was mit der Outbox des Geräts geschieht: Ein Fehler im
    Programm lehnt den einen Befehl ab (``internal``), die übrigen laufen weiter. Streikt
    die Datenbank, wird gar nichts verbucht (500), und das Gerät versucht es später erneut;
    sonst gingen bei voller Platte alle wartenden Änderungen verloren.
    """
    if not isinstance(exc, sqlite3.DatabaseError):
        return False
    # Verletzte Bedingungen und falsch benutzte Schnittstelle sind immer Fehler im Programm.
    if isinstance(
        exc, sqlite3.IntegrityError | sqlite3.ProgrammingError | sqlite3.DataError | sqlite3.NotSupportedError
    ):
        return False
    code = getattr(exc, "sqlite_errorcode", None)
    # Ohne Kennung lieber vorsichtig: nichts verwerfen.
    return code is None or (code & 0xFF) in _FAILING_DATABASE


def storable(text: str, limit: int) -> str:
    """Text aus einem ungeprüften Befehl so, dass er sich speichern und ausliefern lässt.

    JavaScript-Zeichenketten können halbe Zeichen enthalten (einzelne Surrogate, etwa nach
    dem Kürzen mitten in einem Emoji). JSON überträgt sie, UTF-8 kann sie nicht darstellen.
    Geprüfte Befehle enthalten so etwas nie; hier geht es um das, was von einem ungültigen
    Befehl trotzdem festgehalten wird: seine Art, sein Bezug, die Meldung dazu. Auch
    Steuerzeichen fallen weg, damit niemand über einen Befehl Zeilen ins Log schreibt.
    """
    return "".join(char if char.isprintable() else "?" for char in text[:limit])


def effective_time(at: str, sent_at: str, received: datetime) -> str:
    """Wirksamer Zeitpunkt eines Befehls (Abschnitt 4): ``timeutil.effective_time`` mit Schranke.

    Die Rechnung selbst bleibt die des Vertrags. Nur ein unmögliches Alter wird begrenzt:
    Ein Befehl kann nicht aus der Zeit vor ``EARLIEST`` stammen, da gab es Stowly noch nicht.
    Ohne die Schranke liefe ``empfangszeit - alter`` bei einer um Jahrtausende verstellten
    Geräteuhr aus dem darstellbaren Bereich, und Jahre vor 1000 schriebe ``strftime`` je
    nach System ohne führende Nullen: Solche Zeitstempel ließen sich nicht mehr als Text
    vergleichen.
    """
    oldest = min(EARLIEST, received)
    age = timeutil.parse_timestamp(sent_at) - timeutil.parse_timestamp(at)
    if age > received - oldest:
        return timeutil.format_timestamp(oldest)
    return timeutil.effective_time(at, sent_at, received)


class _Batch:
    """Die Befehle eines Aufrufs in ihrer Reihenfolge."""

    def __init__(
        self,
        con: sqlite3.Connection,
        runner: CommandRunner,
        *,
        sent_at: str,
        received: datetime,
        floor: str | None,
    ) -> None:
        self.con = con
        self.runner = runner
        self.sent_at = sent_at
        self.received = received
        self.now = runner.recorded_at
        # Die wirksamen Zeitpunkte eines Geräts laufen nie rückwärts (Abschnitt 4), auch nicht
        # über Anfragen hinweg: Die Outbox ist die Reihenfolge, in der der Anwender gehandelt
        # hat, auch wenn die Geräteuhr dazwischen zurückgestellt wurde oder eine Anfrage
        # lange unterwegs war. ``floor`` ist der wirksame Zeitpunkt des letzten gültigen
        # Befehls dieses Geräts, anfangs der aus seiner vorigen Anfrage.
        self.floor = floor
        # Wirksamer Zeitpunkt des Befehls, der gerade verarbeitet wird, sobald er feststeht.
        self._at: str | None = None

    def _raise_floor(self, at: str) -> str:
        if self.floor is not None and at < self.floor:
            at = self.floor
        self.floor = at
        return at

    def process(self, raw: dict[str, Any]) -> dict[str, Any]:
        """Abschnitt 6.3: bekannt? gültig? wirksamer Zeitpunkt, ausführen, speichern."""
        con = self.con
        command_id = raw["id"]

        # 1. Höchstens einmal: Bekannte Befehle liefern das Ergebnis von damals.
        known = con.execute(
            "SELECT status, code, message, at FROM commands WHERE id = ?", (command_id,)
        ).fetchone()
        if known is not None:
            if known["code"] != RejectCode.INVALID.value:
                # Auch der Vorgänger von damals zählt als Untergrenze für die Befehle nach ihm.
                self._raise_floor(known["at"])
            return _result(command_id, known["status"], known["code"], known["message"], True)

        raw_type = raw.get("type")
        command_type = storable(raw_type, 64) if isinstance(raw_type, str) and raw_type else "unknown"

        # 2. bis 4. im eigenen Sicherungspunkt. Was auch immer dabei schiefgeht, trifft nur
        # diesen einen Befehl, außer die Datenbank selbst streikt.
        self._at = None
        con.execute("SAVEPOINT command")
        try:
            status, code, message, at = self._attempt(raw)
        except Exception as exc:
            if database_is_failing(exc):
                # Platte voll, E/A-Fehler: kein Fehler dieses Befehls. Die ganze Anfrage
                # scheitert, nichts ist verbucht, und das Gerät versucht es später erneut.
                raise
            con.execute("ROLLBACK TO command")
            log.exception("Befehl %s (%s) ist unerwartet fehlgeschlagen", command_id, command_type)
            status, code, message = CommandStatus.REJECTED, RejectCode.INTERNAL, _INTERNAL
            at = self._at or self.now
        con.execute("RELEASE command")

        # 5. Befehl und Ergebnis speichern; eine Ablehnung steht auch im Ereignisprotokoll.
        code_value = None if code is None else code.value
        if message is not None:
            message = storable(message, 300)
        con.execute(
            "INSERT INTO commands (id, device_id, type, at, received_at, body, status, code, message) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                command_id,
                self.runner.device_id,
                command_type,
                at,
                self.now,
                # Wie empfangen, als reines ASCII: So lässt sich auch ein Befehl mit halben
                # Zeichen ablegen (siehe storable).
                json.dumps(raw, ensure_ascii=True, separators=(",", ":")),
                status.value,
                code_value,
                message,
            ),
        )
        if status is CommandStatus.REJECTED:
            entity, entity_id = subject_of(command_type, raw)
            entity_id = storable(entity_id, 80)
            events.record(
                con,
                at=at,
                recorded_at=self.now,
                device_id=self.runner.device_id,
                command_id=command_id,
                type="command.rejected",
                entity=entity,
                entity_id=entity_id,
                data={"code": code_value, "type": command_type, "message": message},
            )
        return _result(command_id, status.value, code_value, message, False)

    def _attempt(self, raw: dict[str, Any]) -> tuple[CommandStatus, RejectCode | None, str | None, str]:
        """Prüft einen Befehl und führt ihn aus: ``(status, code, message, wirksamer Zeitpunkt)``."""
        # 2. Gegen den Katalog prüfen.
        try:
            command = COMMAND.validate_python(raw)
            check_semantics(command)
        except (ValidationError, Reject) as exc:
            message = exc.message if isinstance(exc, Reject) else _invalid_message(exc)
            # Ohne gültigen Befehl gibt es keinen wirksamen Zeitpunkt, und er zählt auch nicht
            # als Untergrenze. Vermerkt wird die Rechnung aus den rohen Angaben, ersatzweise
            # die Empfangszeit.
            raw_at = raw.get("at")
            if isinstance(raw_at, str) and raw_at.isascii() and timeutil.is_timestamp(raw_at):
                at = effective_time(raw_at, self.sent_at, self.received)
            else:
                at = self.now
            return CommandStatus.REJECTED, RejectCode.INVALID, message, at

        # 3. Wirksamer Zeitpunkt, nie vor dem des Vorgängers: des Befehls davor in dieser
        # Anfrage oder des letzten aus der vorigen.
        at = self._at = self._raise_floor(effective_time(command.at, self.sent_at, self.received))
        # 4. Ausführen. Eine Ablehnung nach Katalog macht rückgängig, was bis dahin geschrieben wurde.
        try:
            status = self.runner.run(command, at)
        except Reject as exc:
            self.con.execute("ROLLBACK TO command")
            return CommandStatus.REJECTED, exc.code, exc.message, at
        return status, None, None, at


def _device_floor(device: sqlite3.Row, now: str) -> str | None:
    """Die Untergrenze, mit der die Befehle dieser Anfrage beginnen (Abschnitt 4).

    Das ist der wirksame Zeitpunkt des letzten gültigen Befehls, den der Server von dem
    Gerät verarbeitet hat, höchstens aber die Empfangszeit dieser Anfrage: Ein wirksamer
    Zeitpunkt liegt nie in der Zukunft. Die Schranke greift nur, wenn die Uhr des Servers
    inzwischen zurückgestellt wurde; ohne sie trügen alle weiteren Befehle des Geräts auf
    Dauer den zu späten Zeitpunkt von damals und gewännen jeden Konflikt.
    """
    floor = device["last_command_at"]
    if floor is not None and floor > now:
        return now
    return floor


def _touch_device(con: sqlite3.Connection, device_id: str, received: datetime) -> None:
    """Schreibt ``last_seen_at`` fort, höchstens einmal je Minute."""
    con.execute(
        "UPDATE devices SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at <= ?)",
        (
            timeutil.format_timestamp(received),
            device_id,
            timeutil.format_timestamp(received - timedelta(seconds=LAST_SEEN_INTERVAL_S)),
        ),
    )


def run(
    con: sqlite3.Connection, *, device_id: str, frame: Frame, received: datetime, off_enabled: bool
) -> Outcome:
    """Führt einen Sync-Aufruf aus. Gehört in den Thread-Pool, nicht in die Ereignisschleife."""
    request = frame.request
    now = timeutil.format_timestamp(received)
    runner = CommandRunner(con, device_id=device_id, recorded_at=now, off_enabled=off_enabled)

    with db.transaction(con):
        # Das Token wurde vor der Transaktion geprüft; inzwischen kann es gesperrt worden sein.
        device = con.execute(
            "SELECT revoked_at, last_command_at FROM devices WHERE id = ?", (device_id,)
        ).fetchone()
        if device is None or device["revoked_at"] is not None:
            raise ApiError(
                401, ErrorCode.UNAUTHORIZED, "Nicht angemeldet.", headers={"WWW-Authenticate": "Bearer"}
            )
        batch = _Batch(
            con, runner, sent_at=request.sent_at, received=received, floor=_device_floor(device, now)
        )

        # Ob das Gerät einen vollständigen Abzug braucht, entscheidet der Stand **vor** seinen
        # Befehlen: Die heben ihn selbst an und überdeckten sonst einen cursor, der dem Server
        # voraus ist (zurückgespielte Kopie der Datenbank mit alter Kennung).
        dataset_id = db.get_meta(con, "dataset_id")
        reset = request.dataset_id != dataset_id or request.cursor > db.current_rev(con)

        results = [batch.process(raw) for raw in frame.commands]
        if batch.floor != device["last_command_at"]:
            # Gemerkt in derselben Transaktion wie die Befehle: Die nächste Anfrage des Geräts
            # beginnt mit dieser Untergrenze.
            con.execute("UPDATE devices SET last_command_at = ? WHERE id = ?", (batch.floor, device_id))

        page = changes.collect(con, cursor=request.cursor, reset=reset, now=received)
        granted = idpool.grant(con, device_id=device_id, have=request.id_pool.have, reset=reset, now=now)
        _touch_device(con, device_id, received)

    response = {
        "protocol": PROTOCOL_VERSION,
        "dataset_id": dataset_id,
        "server_time": timeutil.now(),
        "results": results,
        "reset": reset,
        "changes": page.changes,
        "cursor": page.cursor,
        "has_more": page.has_more,
        "id_pool": {"grant": granted, "target": ID_POOL_TARGET},
    }
    try:
        # Die Antwort gegen den Vertrag prüfen, bevor sie hinausgeht.
        body = SyncResponse.model_validate(response).model_dump_json().encode("utf-8")
    except ValidationError:
        # Darf nicht vorkommen: Alles in der Datenbank stammt aus geprüften Befehlen. Käme es
        # doch dazu, wäre ein Fehler hier das Schlimmste: Die Befehle sind verbucht, und jedes
        # Gerät liefe bei jedem Abgleich wieder in denselben Fehler. Also laut melden und liefern.
        log.exception("Die Sync-Antwort verletzt den Vertrag und wird trotzdem ausgeliefert")
        body = json.dumps(response, ensure_ascii=True, separators=(",", ":")).encode("ascii")
    return Outcome(body=body, lookup_pending=runner.lookup_pending)
