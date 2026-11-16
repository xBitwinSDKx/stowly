"""Einen Raspberry Pi koppeln (docs/sync-protokoll.md, 11.8; Ereignisse: Abschnitt 12).

* **Code:** 8 Zeichen Crockford-Base32 aus ``secrets``, angezeigt als ``XXXX-XXXX``. Gespeichert wird nur
  die SHA-256 der Normalform; gelesen wird er mit ``stowly_print.pairing.normalise_code``, derselben Regel
  wie am Pi. Er gilt ``PI_PAIRING_TTL_S`` und nur einmal. Ein neuer Code bricht wartende ab
  (``pi_pairing.cancelled`` mit ``replaced``).
* **Zustand** folgt aus der Zeile: ``paired_at`` → ``paired``, ``cancelled_at`` → ``cancelled``, abgelaufene
  Frist → ``expired``, ``started_at`` → ``installing``, sonst ``waiting``. Meldet sich der Pi
  (``start``), gilt die Frist ab da noch einmal 30 Minuten.
* **Der Pi** kommt ohne Anmeldung, nur mit dem Code. Eine eigene Bremse für alle zusammen (``guarded``)
  zählt jeden Fehlversuch: 10 in 10 Minuten, dann 60 Sekunden Sperre. Ein Erfolg setzt sie zurück; die
  Wiederholung eines schon gekoppelten Antrags zählt weder als Erfolg noch als Fehlversuch.
* **Koppeln** (``pair``): Code, dann Hostname und Adressen (nur private IPv4, nie eine Adresse der App),
  dann signiert die CA den Antrag (``tls.TlsManager.sign_csr``), dann schreibt der Server den Drucker.
  Derselbe Antrag noch einmal bekommt die gespeicherte Antwort.
* **Zertifikat** nur für das, was der Server selbst geprüft hat: als IP die erste gemeldete Adresse, unter
  der der Pi die Rückprüfung besteht, dazu ``10.71.83.1``; den Namen ``<hostname>.local`` nur für
  Hostnamen, die mit ``stowly`` beginnen. Weitere gemeldete Adressen stehen nur in der Auskunft. So taugt
  ein mitgelesener Code nicht für ein Zertifikat auf den Router, den NAS oder Home Assistant.
* **Rückprüfung:** Der Server fragt den Pi unter den gemeldeten Adressen nach einem Nachweis für genau
  diesen Antrag (``proves``, ``stowly_print.pairing.pair_proof``). Den liefert nur der Pi selbst, solange
  er koppelt; der Druckdienst eines anderen Pi nicht, auch wenn man dessen Token kennt. Die Adresse, von
  der die Anfrage kommt, zählt nicht: Hinter Docker auf DSM ist sie die von Docker (etwa 172.19.0.1),
  hinter einem Proxy die des Proxys. Der Ablauf hat drei Schritte (``prepare`` unter der Bremse,
  ``check_back`` ohne sie, dann ``pair``), mit fester Frist, je Code wenigen Runden und höchstens zwei
  Rückprüfungen zugleich.
* **Drucker** als Schreibvorgang des Servers, nach dem Muster von ``shopping.py`` und ``bring.py``: neuer
  ``rev``, Ereignis ohne Gerät und ohne Befehl, nie mit Token. Ein neuer Drucker entsteht ohne Feld-Uhr;
  beim Übernehmen ändert sich nur die Verbindung, und ihre Feld-Uhr geht auf die Serverzeit, damit eine
  ältere Änderung eines Geräts die Kopplung nicht überschreibt (7.1). Den Drucker einer früheren Kopplung,
  den der Pi nennt, übernimmt der Server nur mit dessen Token; die Wahl der App gilt immer.

Alles, was schreibt, läuft in einer ``db.transaction``. Code und Token stehen nie im Log.
"""

import hashlib
import hmac
import ipaddress
import json
import logging
import re
import secrets
import socket
import sqlite3
import threading
import time
import unicodedata
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from cryptography import x509

from stowly import __version__, db, events, tls, wizard
from stowly.auth import LoginGuard
from stowly.config import Settings
from stowly.contract import ids
from stowly.contract.api import (
    PI_CERT_DAYS,
    PI_HOSTNAME_PATTERN,
    PI_PAIRING_CODE_LENGTH,
    PI_PAIRING_TTL_S,
    ErrorCode,
    PiPairingState,
    PiPairInput,
    PiPairStartInput,
)
from stowly.contract.entities import DirectPrinterConfig
from stowly.contract.ids import exact
from stowly.contract.limits import LIMITS
from stowly.contract.timeutil import format_timestamp, parse_timestamp
from stowly_print.pairing import (
    AP_ADDRESS,
    CODE_ALPHABET,
    PROOF_PATH,
    csr_digest,
    format_code,
    normalise_code,
    pair_proof,
)

log = logging.getLogger("stowly.pi")

TTL = timedelta(seconds=PI_PAIRING_TTL_S)
ENTITY = "pi_pairing"
# Die Bremse für den Pi: eigene Grenzen, getrennt von der Anmeldung.
GUARD_MAX_FAILURES = 10
GUARD_WINDOW_S = 600.0
GUARD_LOCK_S = 60.0
# Ports des Druckdienstes auf dem Pi (pi/stowly-print.example.toml).
PI_HTTPS_PORT = 8443
PI_HTTP_PORT = 8080
# Rückprüfung (``check_back``): Gesamtfrist je Adresse, höchstens so viele Adressen, so viel Antwort,
# so viele zugleich (sonst 429 nach so vielen Sekunden), so viele Runden je Code.
PROOF_TIMEOUT_S = 2.0
PROOF_TRIES = 3
PROOF_MAX_BYTES = 16 * 1024
PROOF_PARALLEL = 2
PROOF_RETRY_S = 5
PROOF_ROUNDS = 5

_HOSTNAME = exact(PI_HOSTNAME_PATTERN)
# Ein Ursprung der App: Schema, Name oder IP (IPv6 in Klammern), Port; ohne Pfad und Benutzerangabe.
_ORIGIN = re.compile(r"(https?)://([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::([0-9]{1,5}))?")
_LABEL = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?")
# Die Kopfzeile Host für das Startskript (sie landet im Skripttext).
_HOST_HEADER = re.compile(r"([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::([0-9]{1,5}))?")
# Netze für die Adressen eines Pi: das Heimnetz der CA (tls.HOME_NETWORKS), nur IPv4.
_PI_NETWORKS = tuple(ipaddress.IPv4Network(network) for network in tls.HOME_NETWORKS if ":" not in network)
# Nur solche Hostnamen bekommen <hostname>.local ins Zertifikat: Ein Pi heißt dann sichtbar nach Stowly,
# und ein Code taugt nicht für den Namen eines anderen Geräts (homeassistant.local, diskstation.local).
_STOWLY_NAME = re.compile(r"stowly[a-z0-9-]*")
# So lang wird ein Text des Pi im Log höchstens.
LOGGED_MAX = 40

NOT_AN_ORIGIN = "Kein Ursprung der App (http:// oder https://, Name oder IP, wahlweise mit Port, ohne Pfad)."
NOT_A_DIRECT_PRINTER = (
    "Diesen Drucker gibt es nicht, er ist gelöscht oder kein direkter Drucker (Raspberry Pi)."
)
UNKNOWN_CODE = "Diesen Kopplungscode kennt Stowly nicht. Bitte den Code prüfen."
EXPIRED = "Der Kopplungscode ist abgelaufen."
CANCELLED = (
    "Der Kopplungscode gilt nicht mehr: Er wurde in Stowly abgebrochen oder durch einen neueren ersetzt."
)
USED = "Mit diesem Kopplungscode ist schon ein Pi gekoppelt; ein Code gilt nur einmal."
UNKNOWN_PAIRING = "Diese Kopplung gibt es nicht."
NOT_FOR_CERTIFICATE = "Der Pi meldet Angaben, die nicht in sein Zertifikat dürfen."
APP_ADDRESS = "Unter dieser Adresse läuft Stowly selbst; sie gehört nie ins Zertifikat eines Pi."
NOT_PROVEN = (
    "Unter keiner gemeldeten Adresse ({reported}) besteht der Pi die Rückprüfung: Port 8080 des Pi muss für "
    "Stowly erreichbar sein, solange er koppelt (die Anfrage kam von {source})."
)
PROOF_BUSY = "Gerade läuft eine andere Rückprüfung. Bitte in ein paar Sekunden erneut versuchen."
TOO_MANY_ROUNDS = "Mit diesem Kopplungscode lief die Rückprüfung schon zu oft."
NO_CA = "Stowly hat keine nutzbare CA; ohne sie bekommt der Pi kein Zertifikat."


class Refused(Exception):
    """Die Anfrage gilt nicht: ``status``, ``code`` und ``message`` (samt ``details``) für die Fehlerantwort."""

    def __init__(
        self,
        status: int,
        code: ErrorCode,
        message: str,
        details: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details
        self.headers = headers


def invalid(
    problems: list[dict[str, Any]], message: str = "Die Anfrage entspricht nicht dem Vertrag."
) -> Refused:
    """422 im Format der Prüfung des Vertrags (``details.errors`` mit ``loc``, ``msg``, ``type``)."""
    return Refused(422, ErrorCode.INVALID_REQUEST, message, {"errors": problems})


def now() -> datetime:
    """Die Serverzeit; Tests setzen eine eigene ein."""
    return datetime.now(UTC)


# --- Bremse ------------------------------------------------------------------------------------

_GUARD_LOCK = threading.Lock()


def guard(state: Any) -> LoginGuard:
    """Die Bremse des Pi in ``app.state.pair_guard``, angelegt beim ersten Gebrauch."""
    with _GUARD_LOCK:
        existing = getattr(state, "pair_guard", None)
        if existing is None:
            existing = LoginGuard(
                max_failures=GUARD_MAX_FAILURES, window_s=GUARD_WINDOW_S, lock_s=GUARD_LOCK_S
            )
            state.pair_guard = existing
        return existing


def guarded[T](state: Any, action: Callable[[], T]) -> T:
    """Führt einen Schritt des Pi unter der Bremse aus.

    Jede Ablehnung mit 4xx zählt als Fehlversuch, ein Erfolg setzt die Bremse zurück. 5xx (keine CA),
    unerwartete Fehler und die Wiederholung einer fertigen Kopplung (``Repeated``) gehen durch, ohne zu
    zählen und ohne zurückzusetzen. Ist gesperrt, kommt 429 mit ``Retry-After``.
    """
    outcome: list[Any] = []

    def check() -> bool:
        try:
            outcome.append(action())
        except Refused as exc:
            if exc.status >= 500:
                raise
            outcome.append(exc)
            return False
        return True

    try:
        _passed, retry_after = guard(state).attempt(check)
    except Repeated as exc:
        return exc.result
    if retry_after is not None:
        raise Refused(
            429,
            ErrorCode.RATE_LIMITED,
            f"Zu viele Fehlversuche. Bitte in {retry_after} Sekunden erneut versuchen.",
            {"retry_after_s": retry_after},
            {"Retry-After": str(retry_after)},
        )
    result = outcome[0]
    if isinstance(result, Refused):
        raise result
    return result


class Repeated(Exception):
    """Derselbe Antrag für eine fertige Kopplung: die gespeicherte Antwort, für die Bremse weder Erfolg
    noch Fehlversuch (sonst ließe sie sich mit einer alten Antwort beliebig oft zurücksetzen)."""

    def __init__(self, result: Any) -> None:
        super().__init__("wiederholt")
        self.result = result


def loggable(text: object, limit: int = LOGGED_MAX) -> str:
    """Ein Text des Pi fürs Log: ohne Steuer- und Formatzeichen, höchstens ``limit`` Zeichen."""
    kept = "".join(
        " " if unicodedata.category(char) in ("Cc", "Cf", "Zl", "Zp", "Cs") else char for char in str(text)
    )
    return kept.strip()[:limit]


# --- Adressen und Ursprünge --------------------------------------------------------------------


def parse_origin(origin: str) -> tuple[str, str, int | None] | None:
    """``(schema, host, port)`` eines Ursprungs; der Host klein und ohne Klammern. ``None``, wenn es keiner ist."""
    match = _ORIGIN.fullmatch(origin)
    if match is None:
        return None
    scheme, host, port_text = match.group(1), match.group(2), match.group(3)
    port = None if port_text is None else int(port_text)
    if port is not None and not 1 <= port <= 65535:
        return None
    if host.startswith("["):
        try:
            host = str(ipaddress.IPv6Address(host[1:-1]))
        except ValueError:
            return None
    elif len(host) > 253 or not all(_LABEL.fullmatch(label) for label in host.split(".")):
        return None
    return scheme, host.lower(), port


def origin_problem(origin: str) -> str | None:
    """Warum ``origin`` kein Ursprung der App ist; ``None``, wenn er taugt."""
    return None if parse_origin(origin) is not None else NOT_AN_ORIGIN


def script_server(host_header: str | None, scheme: str) -> str | None:
    """Die Adresse dieses Servers für das Startskript aus ``Host``; ``None``, wenn ``Host`` kein Name
    und keine IP mit Port ist (der Wert landet im Skripttext)."""
    if not host_header:
        return None
    match = _HOST_HEADER.fullmatch(host_header)
    if match is None or scheme not in ("http", "https"):
        return None
    if match.group(2) is not None and not 1 <= int(match.group(2)) <= 65535:
        return None
    if match.group(1).startswith("["):
        try:
            ipaddress.IPv6Address(match.group(1)[1:-1])
        except ValueError:
            return None
    return f"{scheme}://{host_header}"


def command_base(settings: Settings, con: sqlite3.Connection, origin: str) -> str:
    """Die HTTP-Adresse im Befehl: ``origin`` selbst, wenn er http ist; sonst der Host aus ``origin`` mit dem
    gelernten externen HTTP-Port (``wizard.http_origin``)."""
    parsed = parse_origin(origin)
    if parsed is None:
        raise ValueError(NOT_AN_ORIGIN)
    scheme, host, _port = parsed
    if scheme == "http":
        return origin
    return wizard.http_origin(settings, con, f"[{host}]" if ":" in host else host)


def command(base: str, code: str) -> str:
    """Der fertige Befehl für den Pi."""
    return f"curl -fsSL {base}/api/pi/install.sh | sudo sh -s -- {format_code(code)}"


def address_problem(text: str) -> str | None:
    """Warum ``text`` keine Adresse eines Pi im Heimnetz ist; ``None``, wenn sie taugt."""
    try:
        address = ipaddress.IPv4Address(text)
    except ValueError:
        return "Keine IPv4-Adresse."
    if address.is_loopback:
        return "Loopback gehört nicht ins Zertifikat."
    if address.is_link_local:
        return "Eine Link-local-Adresse gehört nicht ins Zertifikat."
    if not any(address in network for network in _PI_NETWORKS):
        return "Keine private Adresse im Heimnetz (10.x, 172.16–31.x, 192.168.x oder 100.64–127.x)."
    return None


def _host_of(text: str | None) -> str | None:
    """Der Host einer Kopfzeile ``Host`` (ohne Port), klein und ohne Klammern."""
    if not text:
        return None
    match = _HOST_HEADER.fullmatch(text.strip())
    if match is None:
        return None
    host = match.group(1)
    return host[1:-1].lower() if host.startswith("[") else host.lower()


def app_hosts(origins: Iterable[str], request_host: str | None) -> set[str]:
    """Adressen und Namen, unter denen die App läuft: die Hosts von ``origins`` (die HTTPS-Ursprünge der
    App und der Ursprung der Kopplung) und die Adresse, unter der der Pi diesen Server eben erreicht hat."""
    hosts: set[str] = set()
    for candidate in origins:
        parsed = parse_origin(candidate)
        if parsed is not None:
            hosts.add(parsed[1])
    request = _host_of(request_host)
    if request is not None:
        hosts.add(request)
    return hosts


def server_names(con: sqlite3.Connection, manager: Any) -> set[str]:
    """Die Adressen des Servers selbst, auch ohne HTTPS-Listener: die bekannten Adressen fürs Zertifikat
    (``wizard.certificate_addresses``) und die Namen im aktuellen Zertifikat des Servers."""
    names = {address.lower() for address in wizard.certificate_addresses(con)}
    certificate = getattr(manager, "certificate", None)
    if isinstance(certificate, x509.Certificate):
        try:
            sans = certificate.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        except x509.ExtensionNotFound:
            sans = None
        if sans is not None:
            names |= {str(ip) for ip in sans.get_values_for_type(x509.IPAddress)}
            names |= {name.lower() for name in sans.get_values_for_type(x509.DNSName)}
    return names


def source_address(client_host: str | None) -> str | None:
    """Die IPv4-Adresse, von der eine Anfrage kommt (``request.client.host``; Proxy-Kopfzeilen wertet
    Stowly nicht aus). IPv4 in IPv6 (``::ffff:…``) wird zu IPv4; alles andere ist ``None``."""
    if not client_host:
        return None
    try:
        address = ipaddress.ip_address(client_host)
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address):
        mapped = address.ipv4_mapped
        return None if mapped is None else str(mapped)
    return str(address)


# --- Code und Zeile ----------------------------------------------------------------------------


def new_code() -> str:
    """Ein neuer Code in Normalform: 8 Zeichen Crockford-Base32 (40 Bit) aus ``secrets``."""
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(PI_PAIRING_CODE_LENGTH))


def code_hash(code: str) -> str:
    """Was in ``pi_pairings.code_hash`` steht: die SHA-256 der Normalform (hex)."""
    return hashlib.sha256(code.encode("ascii")).hexdigest()


def state_of(row: sqlite3.Row, moment: datetime) -> PiPairingState:
    if row["paired_at"] is not None:
        return PiPairingState.PAIRED
    if row["cancelled_at"] is not None:
        return PiPairingState.CANCELLED
    if parse_timestamp(row["expires_at"]) <= moment:
        return PiPairingState.EXPIRED
    if row["started_at"] is not None:
        return PiPairingState.INSTALLING
    return PiPairingState.WAITING


def _open(state: PiPairingState) -> bool:
    return state in (PiPairingState.WAITING, PiPairingState.INSTALLING)


def _closed(state: PiPairingState) -> Refused:
    """409 mit dem Satz zum Zustand eines Codes, der nicht mehr gilt."""
    message = {PiPairingState.EXPIRED: EXPIRED, PiPairingState.CANCELLED: CANCELLED}.get(state, USED)
    return Refused(409, ErrorCode.CONFLICT, message)


def _pi_info(raw: str | None) -> dict[str, Any] | None:
    """``PiInfo`` aus der Spalte ``pi``; fehlt etwas, gilt die Vorgabe."""
    try:
        stored = json.loads(raw) if raw else None
    except ValueError:
        return None
    if not isinstance(stored, dict) or not isinstance(stored.get("hostname"), str):
        return None
    addresses = stored.get("addresses")
    return {
        "hostname": stored["hostname"],
        "addresses": [item for item in addresses if isinstance(item, str)]
        if isinstance(addresses, list)
        else [],
        "model": stored.get("model") if isinstance(stored.get("model"), str) else None,
        "printer_found": stored.get("printer_found") is True,
        "version": stored.get("version") if isinstance(stored.get("version"), str) else None,
        "not_after": stored.get("not_after") if isinstance(stored.get("not_after"), str) else None,
    }


def describe(
    row: sqlite3.Row, moment: datetime, *, code: str | None = None, command_text: str | None = None
) -> dict[str, Any]:
    """``PiPairing``; Code und Befehl nur in der Antwort auf das Anlegen."""
    return {
        "id": row["id"],
        "state": state_of(row, moment).value,
        "code": None if code is None else format_code(code),
        "command": command_text,
        "expires_at": row["expires_at"],
        "printer_id": row["printer_id"],
        "pi": _pi_info(row["pi"]),
    }


def find(con: sqlite3.Connection, pairing_id: str) -> sqlite3.Row | None:
    return con.execute("SELECT * FROM pi_pairings WHERE id = ?", (pairing_id,)).fetchone()


def _by_code(con: sqlite3.Connection, text: str) -> sqlite3.Row:
    """Die Kopplung zu einem Code; 404, wenn es den Code nicht gibt oder er gar keiner ist."""
    try:
        code = normalise_code(text)
    except ValueError:
        raise Refused(404, ErrorCode.NOT_FOUND, UNKNOWN_CODE) from None
    row = con.execute("SELECT * FROM pi_pairings WHERE code_hash = ?", (code_hash(code),)).fetchone()
    if row is None:
        raise Refused(404, ErrorCode.NOT_FOUND, UNKNOWN_CODE)
    return row


def _event(
    con: sqlite3.Connection, stamp: str, type_: str, entity_id: str, data: dict[str, Any], **who: Any
) -> None:
    events.record(
        con, at=stamp, recorded_at=stamp, type=type_, entity=ENTITY, entity_id=entity_id, data=data, **who
    )


def _direct_printer(con: sqlite3.Connection, printer_id: str | None) -> sqlite3.Row | None:
    """Ein vorhandener, nicht gelöschter direkter Drucker; sonst ``None``."""
    if printer_id is None:
        return None
    row = con.execute("SELECT * FROM printers WHERE id = ?", (printer_id,)).fetchone()
    if row is None or row["deleted_at"] is not None or row["connection"] != "direct":
        return None
    return row


def check_printer(con: sqlite3.Connection, printer_id: str | None) -> None:
    """422, wenn ``printer_id`` gesetzt ist, aber kein vorhandener direkter Drucker."""
    if printer_id is not None and _direct_printer(con, printer_id) is None:
        raise invalid([{"loc": ["body", "printer_id"], "msg": NOT_A_DIRECT_PRINTER, "type": "pi_pairing"}])


# --- Die App: Code erzeugen, Stand, Abbrechen --------------------------------------------------


def create(
    con: sqlite3.Connection, *, device_id: str, origin: str, printer_id: str | None, moment: datetime
) -> tuple[sqlite3.Row, str]:
    """Legt eine Kopplung an und bricht wartende ab. Liefert ``(zeile, code)``; den Code gibt es nur hier."""
    stamp = format_timestamp(moment)
    expires = format_timestamp(moment + TTL)
    with db.transaction(con):
        waiting = con.execute(
            "SELECT id FROM pi_pairings WHERE paired_at IS NULL AND cancelled_at IS NULL AND expires_at > ?",
            (stamp,),
        ).fetchall()
        for old in waiting:
            con.execute("UPDATE pi_pairings SET cancelled_at = ? WHERE id = ?", (stamp, old["id"]))
            _event(con, stamp, "pi_pairing.cancelled", old["id"], {"reason": "replaced"}, device_id=device_id)
        pairing_id = ids.new_uuid()
        for _attempt in range(5):
            code = new_code()
            try:
                con.execute(
                    "INSERT INTO pi_pairings (id, code_hash, origin, printer_id, device_id, created_at, expires_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (pairing_id, code_hash(code), origin, printer_id, device_id, stamp, expires),
                )
                break
            except sqlite3.IntegrityError:
                # Derselbe Code wie eine alte Kopplung (bei 40 Bit kaum denkbar): einfach ein neuer.
                continue
        else:
            raise RuntimeError("Kein freier Kopplungscode nach fünf Versuchen.")
        _event(con, stamp, "pi_pairing.created", pairing_id, {"printer_id": printer_id}, device_id=device_id)
        row = find(con, pairing_id)
    log.info("Pi: Kopplung %s angelegt, gültig bis %s.", pairing_id, expires)
    return row, code


def cancel(con: sqlite3.Connection, pairing_id: str, *, device_id: str, moment: datetime) -> bool:
    """Bricht eine wartende Kopplung ab; eine fertige bleibt, wie sie ist. ``False``: unbekannt."""
    stamp = format_timestamp(moment)
    with db.transaction(con):
        row = find(con, pairing_id)
        if row is None:
            return False
        if _open(state_of(row, moment)):
            con.execute("UPDATE pi_pairings SET cancelled_at = ? WHERE id = ?", (stamp, pairing_id))
            _event(con, stamp, "pi_pairing.cancelled", pairing_id, {"reason": "user"}, device_id=device_id)
    return True


# --- Der Pi: melden und koppeln ----------------------------------------------------------------


def start(con: sqlite3.Connection, body: PiPairStartInput, moment: datetime) -> None:
    """``POST /api/pi/pair/start``: Die Kopplung steht auf ``installing``. Beim ersten Melden gilt sie ab
    da noch einmal 30 Minuten, danach nicht wieder: Ein Code lebt so höchstens eine Stunde."""
    found = _by_code(con, body.code)
    stamp = format_timestamp(moment)
    with db.transaction(con):
        row = find(con, found["id"])
        state = state_of(row, moment)
        if not _open(state):
            raise _closed(state)
        pi = _pi_info(row["pi"]) or {
            "addresses": [],
            "model": None,
            "printer_found": False,
            "not_after": None,
        }
        pi.update(hostname=body.hostname.lower(), version=body.version)
        con.execute(
            "UPDATE pi_pairings SET started_at = coalesce(started_at, ?),"
            " expires_at = CASE WHEN started_at IS NULL THEN ? ELSE expires_at END, pi = ? WHERE id = ?",
            (stamp, format_timestamp(moment + TTL), json.dumps(pi, ensure_ascii=False), row["id"]),
        )
    log.info(
        "Pi: %s meldet sich zur Kopplung %s (Druckdienst %s).",
        loggable(body.hostname, 63),
        found["id"],
        loggable(body.version),
    )


# ``csr_digest`` (woran derselbe Antrag wiederzuerkennen ist) kommt aus ``stowly_print.pairing``: Der Pi
# rechnet mit derselben Regel, wenn er die Rückprüfung beantwortet.


def _checked(body: PiPairInput, forbidden: set[str]) -> tuple[str, list[str]]:
    """Hostname (klein) und Adressen (ohne Doppelte); 422 mit allen Stellen, die nicht taugen."""
    problems: list[dict[str, Any]] = []
    hostname = body.hostname.lower()
    if not _HOSTNAME.match(hostname):
        problems.append(
            {"loc": ["body", "hostname"], "msg": "Kein Hostname nach RFC 1123.", "type": "pi_pairing"}
        )
    elif dns_name(hostname) in forbidden:
        problems.append({"loc": ["body", "hostname"], "msg": APP_ADDRESS, "type": "pi_pairing"})
    addresses: list[str] = []
    for index, text in enumerate(body.addresses):
        problem = address_problem(text)
        if problem is None and text in forbidden:
            problem = APP_ADDRESS
        if problem is not None:
            problems.append({"loc": ["body", "addresses", index], "msg": problem, "type": "pi_pairing"})
        elif text not in addresses:
            addresses.append(text)
    if problems:
        raise invalid(problems, NOT_FOR_CERTIFICATE)
    return hostname, addresses


def dns_name(hostname: str) -> str | None:
    """``<hostname>.local`` fürs Zertifikat, nur für Hostnamen, die mit ``stowly`` beginnen; sonst ``None``."""
    name = hostname.lower()
    return f"{name}.local" if _STOWLY_NAME.fullmatch(name) else None


# --- Rückprüfung ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class CheckBack:
    """Was ``prepare`` für ``check_back`` festlegt: die Adressen, unter denen der Server den Pi fragt (leer:
    keine Rückprüfung, er sieht ihn selbst), und die SHA-256 des Antrags."""

    pairing_id: str
    candidates: tuple[str, ...]
    digest: str


Prove = Callable[[str, str, str], bool]

_PROBE_SLOTS = threading.BoundedSemaphore(PROOF_PARALLEL)
_ROUNDS_LOCK = threading.Lock()
_ROUNDS: dict[str, tuple[int, float]] = {}  # Kopplung -> (Runden, zuletzt; monotonic)


def _http_get(address: str, port: int, path: str, timeout: float) -> bytes | None:
    """Ein GET über einen eigenen Socket, mit fester Gesamtfrist auch gegen Antworten, die tröpfeln.

    Liefert den Rumpf einer Antwort 200, sonst ``None`` (auch bei Weiterleitung, Fehler, Frist oder mehr
    als ``PROOF_MAX_BYTES``). Kein Proxy: Die Adresse ist eine IPv4 im Heimnetz.
    """
    deadline = time.monotonic() + timeout
    received = bytearray()
    try:
        with socket.create_connection((address, port), timeout=timeout) as connection:
            connection.sendall(
                f"GET {path} HTTP/1.0\r\nHost: {address}:{port}\r\nAccept: application/json\r\n"
                f"User-Agent: Stowly/{__version__}\r\nConnection: close\r\n\r\n".encode("ascii")
            )
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                connection.settimeout(remaining)
                chunk = connection.recv(4096)
                if not chunk:
                    break
                received += chunk
                if len(received) > PROOF_MAX_BYTES:
                    return None
    except OSError:
        return None
    head, separator, body = bytes(received).partition(b"\r\n\r\n")
    status = head.split(b"\r\n", 1)[0].split(b" ")
    if not separator or len(status) < 2 or not status[0].startswith(b"HTTP/1.") or status[1] != b"200":
        return None
    return body


def proves(
    address: str, token: str, digest: str, *, port: int = PI_HTTP_PORT, timeout: float = PROOF_TIMEOUT_S
) -> bool:
    """Die Rückprüfung: Antwortet unter ``address`` der Pi, der den Antrag ``digest`` gestellt hat?

    ``GET http://<address>:8080/v1/pair-proof?nonce=…`` mit frischem ``nonce`` muss als ``proof``
    ``stowly_print.pairing.pair_proof(token, nonce, digest)`` liefern. Das kann nur der Pi selbst, solange
    ``pair`` läuft (``proof_responder``): Der Druckdienst kennt den Pfad nicht, und für einen anderen
    Antrag passt der Nachweis nicht. Wer das Token eines anderen Pi kennt, bekommt so kein Zertifikat für
    dessen Adresse. Jede andere Antwort und jeder Fehler heißt ``False``.
    """
    nonce = secrets.token_urlsafe(24)
    body = _http_get(address, port, f"{PROOF_PATH}?nonce={nonce}", timeout)
    if body is None:
        return False
    try:
        answer = json.loads(body)
        proof = answer.get("proof") if isinstance(answer, dict) else None
        expected = pair_proof(token, nonce, digest).encode("ascii")
        return isinstance(proof, str) and hmac.compare_digest(proof.encode("utf-8"), expected)
    except Exception:  # noqa: BLE001 - jede kaputte Antwort (auch zu tief verschachtelt) heißt: nicht bestanden
        return False


def _count_round(pairing_id: str) -> None:
    """Zählt eine Runde der Rückprüfung für diese Kopplung; nach ``PROOF_ROUNDS`` Runden 409.

    So taugt ein Code nicht dafür, das Heimnetz Port für Port abzufragen. Der Stand liegt im Speicher.
    Ein Code lebt höchstens zwei Fristen (``start`` verlängert nur einmal); so lange bleibt sein Eintrag.
    """
    moment = time.monotonic()
    with _ROUNDS_LOCK:
        for key, (_count, last) in list(_ROUNDS.items()):
            if moment - last > 2 * PI_PAIRING_TTL_S:
                del _ROUNDS[key]
        count, _last = _ROUNDS.get(pairing_id, (0, moment))
        if count >= PROOF_ROUNDS:
            raise Refused(409, ErrorCode.CONFLICT, TOO_MANY_ROUNDS)
        _ROUNDS[pairing_id] = (count + 1, moment)


def check_back(plan: CheckBack, token: str, *, prove: Prove | None = None) -> str | None:
    """Zweiter Schritt von ``POST /api/pi/pair``, ohne die Bremse (sie ist ein Lock): fragt den Pi unter den
    Adressen aus ``prepare``, der Reihe nach; liefert die erste, die besteht, sonst ``None``.

    Höchstens ``PROOF_PARALLEL`` zugleich, sonst 429 mit ``Retry-After`` (ohne eine Runde zu zählen); je
    Code höchstens ``PROOF_ROUNDS`` Runden (409); je Adresse höchstens ``PROOF_TIMEOUT_S``.
    """
    if not plan.candidates:
        return None
    if not _PROBE_SLOTS.acquire(blocking=False):
        raise Refused(
            429,
            ErrorCode.RATE_LIMITED,
            PROOF_BUSY,
            {"retry_after_s": PROOF_RETRY_S},
            {"Retry-After": str(PROOF_RETRY_S)},
        )
    try:
        _count_round(plan.pairing_id)
        for candidate in plan.candidates:
            if (prove or proves)(candidate, token, plan.digest):
                log.info("Pi: Rückprüfung unter %s bestanden.", candidate)
                return candidate
        log.info("Pi: Rückprüfung unter %s nicht bestanden.", ", ".join(plan.candidates))
        return None
    finally:
        _PROBE_SLOTS.release()


def _source(client_host: str | None, addresses: list[str], *, proven: str | None) -> str:
    """Die eine IP fürs Zertifikat: die gemeldete Adresse, unter der der Pi die Rückprüfung bestanden hat
    (``proven``); sonst 422. Die Adresse, von der die Anfrage kommt, zählt nicht: Hinter Docker, einem
    Proxy oder NAT ist sie die eines anderen Geräts. ``addresses`` sind schon geprüft (``_checked``)."""
    if proven is not None and proven in addresses:
        return proven
    source = source_address(client_host) or "?"
    problem = NOT_PROVEN.format(source=source, reported=", ".join(addresses))
    raise invalid([{"loc": ["body", "addresses"], "msg": problem, "type": "pi_pairing"}], NOT_FOR_CERTIFICATE)


def _sign(manager: Any, csr: str, ips: list[str], dns: list[str]) -> tls.Issued:
    if manager is None:
        raise Refused(503, ErrorCode.NOT_CONFIGURED, NO_CA)
    try:
        return manager.sign_csr(csr, ips=ips, dns=dns, days=PI_CERT_DAYS)
    except tls.CsrRejected as exc:
        raise invalid([{"loc": ["body", "csr"], "msg": str(exc), "type": "pi_pairing"}]) from None
    except tls.CaUnavailable as exc:
        raise Refused(503, ErrorCode.NOT_CONFIGURED, f"{NO_CA} ({exc})") from None


def _same_token(row: sqlite3.Row, token: str) -> bool:
    try:
        stored = json.loads(row["config"]).get("token")
    except (ValueError, AttributeError):
        return False
    return isinstance(stored, str) and hmac.compare_digest(stored.encode("utf-8"), token.encode("utf-8"))


def _write_printer(
    con: sqlite3.Connection,
    *,
    chosen: str | None,
    remembered: str | None,
    hostname: str,
    model: str | None,
    token: str,
    urls: list[str],
    stamp: str,
) -> tuple[str, str, bool, dict[str, Any], bool]:
    """Legt den Drucker an oder übernimmt einen vorhandenen direkten Drucker.

    ``chosen`` (die Wahl der App) gilt immer; ``remembered`` (aus ``pairing.json`` des Pi) nur, wenn der
    Drucker schon dasselbe Token hat. Sonst könnte ein Pi mit einem gültigen Code einen fremden Drucker
    übernehmen. Liefert ``(kennung, name, neu, verbindung, token_geändert)``. Kein Eintrag in ``commands``.
    """
    row = _direct_printer(con, chosen)
    if row is None:
        candidate = _direct_printer(con, remembered)
        if candidate is not None and _same_token(candidate, token):
            row = candidate
    if row is None:
        printer_id = ids.new_uuid()
        name = (model or hostname)[: LIMITS["printer_name"]]
        config = DirectPrinterConfig(urls=urls, token=token, printer=None).model_dump(mode="json")
        con.execute(
            "INSERT INTO printers (id, name, connection, config, created_at, updated_at, rev) "
            "VALUES (?, ?, 'direct', ?, ?, ?, ?)",
            (printer_id, name, _dumps(config), stamp, stamp, db.next_rev(con)),
        )
        return printer_id, name, True, config, False
    old = json.loads(row["config"])
    config = DirectPrinterConfig(urls=urls, token=token, printer=old.get("printer")).model_dump(mode="json")
    # Die Feld-Uhr der Verbindung geht auf die Serverzeit, nie zurück (Protokoll 7.1).
    con.execute(
        "INSERT INTO field_clocks (entity, entity_id, field, at) VALUES ('printer', ?, 'direct', ?) "
        "ON CONFLICT (entity, entity_id, field) DO UPDATE SET at = max(at, excluded.at)",
        (row["id"], stamp),
    )
    con.execute(
        "UPDATE printers SET config = ?, updated_at = max(updated_at, ?), rev = ? WHERE id = ?",
        (_dumps(config), stamp, db.next_rev(con), row["id"]),
    )
    return row["id"], row["name"], False, config, old.get("token") != token


def _dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


@dataclass(frozen=True)
class _Request:
    """Ein geprüfter Antrag: die Zeile der Kopplung, SHA-256 des Antrags, Hostname, Adressen, Ursprünge."""

    found: sqlite3.Row
    digest: str
    hostname: str
    reported: list[str]
    origins: list[str]


def _validated(
    con: sqlite3.Connection,
    settings: Settings,
    manager: Any,
    body: PiPairInput,
    *,
    request_host: str | None,
    moment: datetime,
) -> _Request:
    """Code, Zustand, Hostname und Adressen eines Antrags; ``Repeated`` für denselben Antrag noch einmal."""
    found = _by_code(con, body.code)
    digest = csr_digest(body.csr)
    state = state_of(found, moment)
    if state is PiPairingState.PAIRED:
        if (
            found["csr_sha256"] == digest
            and parse_timestamp(found["expires_at"]) > moment
            and found["result"]
        ):
            raise Repeated(json.loads(found["result"]))
        raise _closed(state)
    if not _open(state):
        raise _closed(state)
    origins = list(dict.fromkeys([found["origin"], *wizard.app_origins(settings, con)]))
    forbidden = app_hosts(origins, request_host) | server_names(con, manager)
    hostname, reported = _checked(body, forbidden)
    return _Request(found, digest, hostname, reported, origins)


def prepare(
    con: sqlite3.Connection,
    settings: Settings,
    manager: Any,
    body: PiPairInput,
    *,
    request_host: str | None,
    client_host: str | None,
    moment: datetime,
) -> CheckBack:
    """Erster Schritt von ``POST /api/pi/pair``, unter der Bremse und ohne Netz: prüft den Antrag wie
    ``pair`` und legt die Adressen für die Rückprüfung fest (``check_back``): die ersten ``PROOF_TRIES``
    gemeldeten. ``client_host`` zählt dafür nicht (siehe ``_source``)."""
    checked = _validated(con, settings, manager, body, request_host=request_host, moment=moment)
    log.info(
        "Pi: Antrag zur Kopplung %s von %s, gemeldet %s.",
        checked.found["id"],
        source_address(client_host) or "?",
        ", ".join(checked.reported),
    )
    return CheckBack(checked.found["id"], tuple(checked.reported[:PROOF_TRIES]), checked.digest)


def pair(
    con: sqlite3.Connection,
    settings: Settings,
    manager: Any,
    body: PiPairInput,
    *,
    request_host: str | None,
    client_host: str | None,
    moment: datetime,
    proven: str | None = None,
) -> dict[str, Any]:
    """``POST /api/pi/pair``: Code, Angaben, Zertifikat, Drucker; liefert ``PiPairResult``.

    ``manager`` ist ``app.state.tls`` (``None``: keine CA, 503), ``client_host`` die Adresse, von der die
    Anfrage kommt, ``proven`` die Adresse, die die Rückprüfung bestanden hat (``check_back``). Derselbe
    Antrag innerhalb der Frist bekommt die gespeicherte Antwort (``Repeated``); ein anderer mit einem
    benutzten Code 409.
    """
    checked = _validated(con, settings, manager, body, request_host=request_host, moment=moment)
    found, digest, hostname, reported, origins = (
        checked.found,
        checked.digest,
        checked.hostname,
        checked.reported,
        checked.origins,
    )
    source = _source(client_host, reported, proven=proven)
    addresses = [source, *(address for address in reported if address != source)]
    ips = list(dict.fromkeys([source, AP_ADDRESS]))
    local_name = dns_name(hostname)
    dns = [local_name] if local_name is not None else []
    issued = _sign(manager, body.csr, ips, dns)
    stamp = format_timestamp(moment)
    urls = [f"https://{source}:{PI_HTTPS_PORT}"]
    if local_name is not None:
        urls.append(f"https://{local_name}:{PI_HTTPS_PORT}")
    urls.append(f"http://{source}:{PI_HTTP_PORT}")
    not_after = format_timestamp(issued.not_after)

    with db.transaction(con):
        row = find(con, found["id"])
        state = state_of(row, moment)
        if not _open(state):
            # Inzwischen abgebrochen, abgelaufen oder von einem anderen Antrag gekoppelt.
            raise _closed(state)
        printer_id, name, created, config, token_changed = _write_printer(
            con,
            chosen=row["printer_id"],
            remembered=body.printer_id,
            hostname=hostname,
            model=body.model,
            token=body.token,
            urls=urls,
            stamp=stamp,
        )
        result = {
            "printer_id": printer_id,
            "name": name,
            "certificate": issued.certificate_pem,
            "ca": issued.ca_pem,
            "origins": origins,
            "urls": urls,
            "not_after": not_after,
        }
        pi = {
            "hostname": hostname,
            "addresses": addresses,
            "model": body.model,
            "printer_found": body.printer_found,
            "version": body.version,
            "not_after": not_after,
        }
        con.execute(
            "UPDATE pi_pairings SET paired_at = ?, pi = ?, csr_sha256 = ?, result = ?, printer_id = ? WHERE id = ?",
            (stamp, _dumps(pi), digest, _dumps(result), printer_id, row["id"]),
        )
        events.record(
            con,
            at=stamp,
            recorded_at=stamp,
            type="printer.paired",
            entity="printer",
            entity_id=printer_id,
            data={
                "created": created,
                "name": name,
                "direct": {key: value for key, value in config.items() if key != "token"},
                "token_changed": token_changed,
                "hostname": hostname,
                "addresses": addresses,
                "sans": [*ips, *dns],
                "serial": issued.serial,
                "not_after": not_after,
                "pairing_id": row["id"],
            },
        )
    log.info(
        "Pi: %s gekoppelt (Zertifikat für %s), Drucker %s %s, gültig bis %s.",
        loggable(hostname, 63),
        ", ".join(ips + dns),
        printer_id,
        "neu angelegt" if created else "übernommen",
        not_after,
    )
    return result
