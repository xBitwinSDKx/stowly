"""Stand der Einrichtung (docs/sync-protokoll.md, 11.6; docs/integrationen.md, Abschnitt 11).

* **Schritte** des Assistenten (``https``, ``printer``, ``updates``, ``notifications``): ``state`` setzt die
  App (offen, erledigt, übersprungen), ``ready`` sieht der Server selbst. Abgeschlossen ist die
  Einrichtung mit ``setup_finished_at``. Alles in ``server_config`` (``serverconfig.py``).
* **Lernen**, nur aus ``POST /api/setup/password`` und angemeldeten Aufrufen unter ``/api/setup``:

  - die Adresse aus ``Host``, wenn sie im Heimnetz liegt und die CA sie deckt; höchstens
    ``LIMITS["setup_addresses"]``, gelernt wird nie etwas entfernt. Eine neue Adresse stellt das
    Zertifikat neu aus (``tls.TlsManager.ensure``);
  - über den HTTPS-Listener (``scope["scheme"] == "https"``): wann zuletzt (``https_seen_at``) und den
    externen Port, außer er ist von Hand gesetzt; über HTTP den externen HTTP-Port. Kam die Anfrage über
    einen Reverse Proxy (Kopfzeilen wie ``X-Forwarded-For``), sagt ihr Port nichts und zählt nicht;
  - aus ``Origin`` angemeldeter Änderungen die HTTPS-Ursprünge der App, höchstens 20.
* **Heimnetz:** die privaten Netze und lokalen Endungen aus ``tls.py``. Für das erste Passwort zählen
  auch Loopback und einteilige Namen (``diskstation``); ins Zertifikat kommt nur, was die CA deckt.
"""

import ipaddress
import json
import re
import sqlite3
from collections.abc import Mapping
from datetime import timedelta
from typing import Any

from stowly import auth, autobackup, db, haconfig, push, serverconfig
from stowly.config import Settings
from stowly.contract import timeutil
from stowly.contract.api import (
    HTTPS_PORT_DEFAULT,
    AddressSource,
    ErrorCode,
    PortSource,
    SetupChanges,
    SetupStepId,
    SetupStepState,
)
from stowly.contract.limits import LIMITS
from stowly.errors import ApiError
from stowly.tls import HOME_NETWORKS, LOCAL_SUFFIXES, LOOPBACK_NETWORKS, TlsManager

ADDRESS_MAX = LIMITS["setup_addresses"]
ORIGINS_MAX = 20
# So oft schreibt der Server „zuletzt über HTTPS gesehen" höchstens.
SEEN_EVERY = timedelta(minutes=1)
# Kopfzeilen eines Reverse Proxy: Der Port einer solchen Anfrage ist nicht der von Stowly.
PROXY_HEADERS = ("forwarded", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-real-ip")

_HOME = tuple(ipaddress.ip_network(net) for net in HOME_NETWORKS)
_LOOPBACK = tuple(ipaddress.ip_network(net) for net in LOOPBACK_NETWORKS)
_HOST = re.compile(r"(?:\[(?P<v6>[0-9A-Fa-f:.]+)\]|(?P<name>[A-Za-z0-9.-]+))(?::(?P<port>[0-9]{1,5}))?")
_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")

NOT_HOME = (
    "Liegt nicht im Heimnetz (private IP-Adresse oder Name mit lokaler Endung wie .local oder .fritz.box)."
)
NOT_COVERED = "Die CA von Stowly darf für diese Adresse kein Zertifikat ausstellen."
NOT_ADDRESS = "Keine IP-Adresse und kein Rechnername (ohne Port und ohne Schema)."
TOO_MANY = f"Höchstens {ADDRESS_MAX} Adressen, die gelernten mitgezählt."


# --- Adressen ----------------------------------------------------------------------------------


def _name(text: str) -> str | None:
    """Ein Rechnername in Kleinbuchstaben, ohne Punkt am Ende; ``None``, wenn es keiner ist."""
    name = text.lower()
    if name.endswith("."):
        name = name[:-1]
    if not name or len(name) > 253:
        return None
    labels = name.split(".")
    if not all(_LABEL.fullmatch(label) for label in labels):
        return None
    if labels[-1].isdigit():
        return None  # sieht aus wie eine IP-Adresse, ist aber keine
    return name


def _ip(text: str) -> str | None:
    try:
        return str(ipaddress.ip_address(text))
    except ValueError:
        return None


def parse_host(header: str | None) -> tuple[str, int | None] | None:
    """``Host`` als ``(adresse, port)``: IP in kurzer Form (IPv6 ohne Klammern) oder Name in Kleinbuchstaben;
    ``None``, wenn die Kopfzeile fehlt oder nichts davon ist."""
    if not header:
        return None
    match = _HOST.fullmatch(header.strip())
    if match is None:
        return None
    port = None if match.group("port") is None else int(match.group("port"))
    if port is not None and not 1 <= port <= 65535:
        return None
    if match.group("v6") is not None:
        try:
            address = str(ipaddress.IPv6Address(match.group("v6")))
        except ValueError:
            return None
    else:
        text = match.group("name")
        address = _ip(text) if re.fullmatch(r"[0-9.]+", text) else _name(text)
        if address is None:
            return None
    return address, port


def normalize_address(text: str) -> str | None:
    """Eine von Hand eingetragene Adresse (IP oder Name, ohne Port), wie sie gespeichert wird."""
    text = text.strip()
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
        return _ip(text) if ":" in text else None
    if ":" in text:
        return _ip(text)
    if re.fullmatch(r"[0-9.]+", text):
        return _ip(text)
    return _name(text)


def _in(address: str, networks: tuple[Any, ...]) -> bool:
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    return any(ip.version == network.version and ip in network for network in networks)


def in_home_network(address: str) -> bool:
    """Private IP aus den Netzen des Heimnetzes oder ein Name mit lokaler Endung (``nas.local``)."""
    if _in(address, _HOME):
        return True
    return any(address.endswith("." + suffix) for suffix in LOCAL_SUFFIXES)


# Endungen, unter denen ein Name auch im Internet vergeben sein kann: ``.box`` ist eine öffentliche
# Top-Level-Domain, ``fritz.box`` dort registrierbar. Fürs Zertifikat taugen sie (die FRITZ!Box löst
# ``nas.fritz.box`` im Heimnetz auf), für das erste Passwort nicht: Wer den Namen im Internet besitzt,
# käme sonst per DNS-Rebinding als erster.
_PUBLIC_SUFFIXES = ("fritz.box",)


def first_password_host(header: str | None) -> bool:
    """Darf eine Anfrage mit diesem ``Host`` das erste Passwort setzen? Heimnetz, Loopback oder ein
    einteiliger Name. Das hält Seiten im Internet ab, die per DNS-Rebinding als erste kommen wollen."""
    parsed = parse_host(header)
    if parsed is None:
        return False
    address = parsed[0]
    if any(address == suffix or address.endswith("." + suffix) for suffix in _PUBLIC_SUFFIXES):
        return False
    return (
        in_home_network(address) or _in(address, _LOOPBACK) or ("." not in address and _ip(address) is None)
    )


def _host(address: str) -> str:
    """Eine Adresse für eine URL: IPv6 in eckigen Klammern."""
    return f"[{address}]" if ":" in address else address


# --- Gespeichertes -----------------------------------------------------------------------------


def addresses(con: sqlite3.Connection) -> list[dict[str, str]]:
    """Die bekannten Adressen, gelernte zuerst, je ``{"address", "source"}``; Unbrauchbares fällt weg."""
    learned: list[dict[str, str]] = []
    manual: list[dict[str, str]] = []
    seen: set[str] = set()
    stored = serverconfig.get(con, serverconfig.TLS_ADDRESSES, [])
    for entry in stored if isinstance(stored, list) else []:
        if not isinstance(entry, Mapping):
            continue
        address, source = entry.get("address"), entry.get("source")
        if not isinstance(address, str) or normalize_address(address) != address or address in seen:
            continue
        if source == AddressSource.LEARNED:
            learned.append({"address": address, "source": AddressSource.LEARNED})
        elif source == AddressSource.MANUAL:
            manual.append({"address": address, "source": AddressSource.MANUAL})
        else:
            continue
        seen.add(address)
    return (learned + manual)[:ADDRESS_MAX]


def certificate_addresses(con: sqlite3.Connection) -> list[str]:
    """Die Adressen fürs Zertifikat des Servers (``TlsManager.ensure`` filtert noch nach der CA)."""
    return [entry["address"] for entry in addresses(con)]


def stored_certificate_addresses(settings: Settings) -> list[str]:
    """Wie ``certificate_addresses``, mit eigener Verbindung (beim Start, für ``TlsRenewJob``)."""
    con = db.connect(settings.database_path)
    try:
        return certificate_addresses(con)
    finally:
        con.close()


def https_port(con: sqlite3.Connection) -> tuple[int, PortSource]:
    """Der Port, unter dem HTTPS von außen erreichbar ist, mit Quelle; ohne Angabe ``HTTPS_PORT_DEFAULT``."""
    stored = serverconfig.get(con, serverconfig.HTTPS_PORT)
    if isinstance(stored, Mapping):
        port, source = stored.get("port"), stored.get("source")
        if (
            isinstance(port, int)
            and not isinstance(port, bool)
            and 1 <= port <= 65535
            and source in (PortSource.LEARNED, PortSource.MANUAL)
        ):
            return port, PortSource(source)
    return HTTPS_PORT_DEFAULT, PortSource.DEFAULT


def http_port(con: sqlite3.Connection) -> int | None:
    """Der gelernte Port, unter dem HTTP von außen erreichbar ist; ``None`` = noch nicht gesehen."""
    stored = serverconfig.get(con, serverconfig.HTTP_PORT)
    if isinstance(stored, int) and not isinstance(stored, bool) and 1 <= stored <= 65535:
        return stored
    return None


def _timestamp(value: Any) -> str | None:
    return value if isinstance(value, str) and timeutil.is_timestamp(value) else None


def seen_origins(con: sqlite3.Connection) -> list[str]:
    stored = serverconfig.get(con, serverconfig.APP_ORIGINS_SEEN, [])
    if not isinstance(stored, list):
        return []
    return [origin for origin in stored if isinstance(origin, str) and _https_origin(origin)][:ORIGINS_MAX]


def _https_origin(origin: str) -> bool:
    return origin.startswith("https://") and push.origin_problem(origin) is None


def app_origins(settings: Settings, con: sqlite3.Connection) -> list[str]:
    """HTTPS-Ursprünge der App: je Adresse des Zertifikats ``https://<adresse>:<port>`` mit dem
    externen HTTPS-Port, dazu die gesehenen Ursprünge (auch hinter einem Reverse Proxy); höchstens
    20, ohne Doppelte, in fester Reihenfolge."""
    origins: list[str] = []
    if settings.https_port is not None:
        port, _source = https_port(con)
        for address in certificate_addresses(con):
            # Wie der Browser schreibt: Port 443 lässt er weg (Origin wird als Text verglichen).
            origins.append(f"https://{_host(address)}" if port == 443 else f"https://{_host(address)}:{port}")
    origins.extend(seen_origins(con))
    return list(dict.fromkeys(origins))[:ORIGINS_MAX]


def http_origin(settings: Settings, con: sqlite3.Connection, hostname: str) -> str:
    """``http://<hostname>:<port>``, über den das Heimnetz Stowly ohne TLS erreicht (Download der CA,
    Befehl für den Pi). Der Port ist der gelernte externe HTTP-Port, sonst ``settings.port``.
    ``hostname`` ist geprüft (IP oder Name, ohne Port); IPv6 steht in eckigen Klammern."""
    port = http_port(con) or settings.port
    host = hostname if hostname.startswith("[") else _host(hostname)
    return f"http://{host}:{port}"


# --- Lernen ------------------------------------------------------------------------------------


def learn(
    settings: Settings,
    con: sqlite3.Connection,
    tls: TlsManager,
    *,
    host: str | None,
    scheme: str,
    origin: str | None = None,
    proxied: bool = False,
    now: str | None = None,
) -> bool:
    """Lernt aus einer Anfrage Adresse, Ports, „über HTTPS gesehen" und (nur für angemeldete Änderungen
    mitgegeben) den Ursprung der App. Liefert, ob eine neue Adresse dazukam; dann muss das Zertifikat neu
    (``refresh_certificate``). Schreibt nur, was sich ändert."""
    now = now or timeutil.now()
    parsed = parse_host(host)
    added = False
    with db.transaction(con):
        if parsed is not None:
            address, port = parsed
            known = addresses(con)
            if (
                address not in {entry["address"] for entry in known}
                and len(known) < ADDRESS_MAX
                and in_home_network(address)
                and tls.covers(address)
            ):
                _store_addresses(con, [*known, {"address": address, "source": AddressSource.LEARNED}], now)
                added = True
            if not proxied:
                _learn_port(con, scheme, port, now)
        if scheme == "https":
            seen = _timestamp(serverconfig.get(con, serverconfig.HTTPS_SEEN_AT))
            if seen is None or timeutil.parse_timestamp(now) - timeutil.parse_timestamp(seen) >= SEEN_EVERY:
                serverconfig.put(con, serverconfig.HTTPS_SEEN_AT, now, now=now, by=None)
        if origin is not None and _https_origin(origin):
            origins = seen_origins(con)
            if origin not in origins and len(origins) < ORIGINS_MAX:
                serverconfig.put(con, serverconfig.APP_ORIGINS_SEEN, [*origins, origin], now=now, by=None)
    return added


def _learn_port(con: sqlite3.Connection, scheme: str, port: int | None, now: str) -> None:
    if scheme == "https":
        value = port if port is not None else 443
        current, source = https_port(con)
        if source != PortSource.MANUAL and (source == PortSource.DEFAULT or current != value):
            serverconfig.put(
                con, serverconfig.HTTPS_PORT, {"port": value, "source": PortSource.LEARNED}, now=now, by=None
            )
    elif scheme == "http":
        value = port if port is not None else 80
        if http_port(con) != value:
            serverconfig.put(con, serverconfig.HTTP_PORT, value, now=now, by=None)


def _store_addresses(
    con: sqlite3.Connection, entries: list[dict[str, str]], now: str, by: str | None = None
) -> None:
    learned = [entry for entry in entries if entry["source"] == AddressSource.LEARNED]
    manual = [entry for entry in entries if entry["source"] == AddressSource.MANUAL]
    serverconfig.put(
        con,
        serverconfig.TLS_ADDRESSES,
        [{"address": entry["address"], "source": str(entry["source"])} for entry in learned + manual],
        now=now,
        by=by,
    )


def refresh_certificate(settings: Settings, con: sqlite3.Connection, tls: TlsManager) -> bool:
    """Stellt das Zertifikat für die bekannten Adressen neu aus, wenn nötig (nur mit HTTPS)."""
    return tls.ensure(certificate_addresses(con))


def proxied(headers: Mapping[str, str]) -> bool:
    """Kam die Anfrage über einen Reverse Proxy? Dann sagt ihr ``Host`` nichts über die Ports von Stowly."""
    return any(name in headers for name in PROXY_HEADERS)


# --- Ändern (PATCH /api/setup) -----------------------------------------------------------------


def _steps(con: sqlite3.Connection) -> dict[str, dict[str, str]]:
    stored = serverconfig.get(con, serverconfig.SETUP_STEPS, {})
    result: dict[str, dict[str, str]] = {}
    if not isinstance(stored, Mapping):
        return result
    for step in SetupStepId:
        entry = stored.get(step.value)
        if not isinstance(entry, Mapping):
            continue
        state, changed_at = entry.get("state"), _timestamp(entry.get("changed_at"))
        if state in {member.value for member in SetupStepState} and changed_at is not None:
            result[step.value] = {"state": state, "changed_at": changed_at}
    return result


def change(
    settings: Settings,
    con: sqlite3.Connection,
    tls: TlsManager,
    changes: SetupChanges,
    *,
    device_id: str,
    now: str | None = None,
) -> bool:
    """Übernimmt die vorhandenen Felder; liefert, ob sich die Adressen geändert haben (dann muss das
    Zertifikat neu). ``ApiError`` 422 bei einer Adresse außerhalb des Heimnetzes oder der CA."""
    now = now or timeutil.now()
    fields = changes.model_fields_set
    manual: list[str] | None = None
    if "addresses" in fields and changes.addresses is not None:
        manual = _check_addresses(con, tls, changes.addresses)

    changed: list[str] = []
    addresses_changed = False
    with db.transaction(con):
        if manual is not None:
            known = addresses(con)
            learned = [entry for entry in known if entry["source"] == AddressSource.LEARNED]
            entries = learned + [{"address": address, "source": AddressSource.MANUAL} for address in manual]
            if entries != known:
                _store_addresses(con, entries, now, device_id)
                changed.append(serverconfig.TLS_ADDRESSES)
                addresses_changed = True
        if "https_port" in fields:
            current = serverconfig.get(con, serverconfig.HTTPS_PORT)
            if changes.https_port is None:
                if isinstance(current, Mapping) and current.get("source") == PortSource.MANUAL:
                    serverconfig.delete(con, serverconfig.HTTPS_PORT)
                    changed.append(serverconfig.HTTPS_PORT)
            else:
                wanted = {"port": changes.https_port, "source": str(PortSource.MANUAL)}
                if current != wanted:
                    serverconfig.put(con, serverconfig.HTTPS_PORT, wanted, now=now, by=device_id)
                    changed.append(serverconfig.HTTPS_PORT)
        if "step" in fields and changes.step is not None:
            steps = _steps(con)
            step = changes.step
            if steps.get(step.id.value, {}).get("state", SetupStepState.OPEN.value) != step.state.value:
                steps[step.id.value] = {"state": step.state.value, "changed_at": now}
                serverconfig.put(con, serverconfig.SETUP_STEPS, steps, now=now, by=device_id)
                changed.append(serverconfig.SETUP_STEPS)
        if "finished" in fields and changes.finished is not None:
            finished = _timestamp(serverconfig.get(con, serverconfig.SETUP_FINISHED_AT))
            if changes.finished and finished is None:
                serverconfig.put(con, serverconfig.SETUP_FINISHED_AT, now, now=now, by=device_id)
                changed.append(serverconfig.SETUP_FINISHED_AT)
            elif not changes.finished and serverconfig.delete(con, serverconfig.SETUP_FINISHED_AT):
                changed.append(serverconfig.SETUP_FINISHED_AT)
        if changed:
            serverconfig.changed_event(con, changed, device_id=device_id, now=now)
    return addresses_changed


def _check_addresses(con: sqlite3.Connection, tls: TlsManager, given: list[str]) -> list[str]:
    """Prüft die von Hand eingetragenen Adressen; liefert sie normalisiert, ohne Doppelte und ohne die
    schon gelernten. ``ApiError`` 422 mit ``details.errors[].loc = ["body", "addresses", i]``."""
    problems: list[dict[str, Any]] = []
    learned = {entry["address"] for entry in addresses(con) if entry["source"] == AddressSource.LEARNED}
    result: list[str] = []
    for index, text in enumerate(given):
        address = normalize_address(text)
        message = None
        if address is None:
            message = NOT_ADDRESS
        elif not in_home_network(address):
            message = NOT_HOME
        elif not tls.covers(address):
            message = NOT_COVERED
        elif address not in learned and address not in result:
            if len(learned) + len(result) >= ADDRESS_MAX:
                message = TOO_MANY
            else:
                result.append(address)
        if message is not None:
            problems.append({"loc": ["body", "addresses", index], "msg": message, "type": "setup_address"})
    if problems:
        raise ApiError(
            422, ErrorCode.INVALID_REQUEST, "Die Anfrage entspricht nicht dem Vertrag.", {"errors": problems}
        )
    return result


# --- Stand (GET /api/setup) --------------------------------------------------------------------


def ready(settings: Settings, con: sqlite3.Connection) -> dict[str, bool]:
    """Je Schritt, ob er aus Sicht des Servers erledigt ist."""
    printer = con.execute("SELECT 1 FROM printers WHERE deleted_at IS NULL LIMIT 1").fetchone()
    return {
        SetupStepId.HTTPS.value: _timestamp(serverconfig.get(con, serverconfig.HTTPS_SEEN_AT)) is not None,
        SetupStepId.PRINTER.value: printer is not None,
        SetupStepId.UPDATES.value: serverconfig.update_repo(settings, con) is not None,
        SetupStepId.NOTIFICATIONS.value: serverconfig.push_contact(settings, con) is not None,
        # Sicherung: wirksam (an, Schlüssel, Ordner) und mindestens eine gelungene (autobackup.ready).
        SetupStepId.BACKUP.value: autobackup.ready(settings, con),
        # Home Assistant: Adresse, Token und Liste sind wirksam (Umgebung oder App, haconfig.effective).
        SetupStepId.HOME_ASSISTANT.value: haconfig.effective(settings, con).configured,
    }


def https_status(
    settings: Settings, con: sqlite3.Connection, tls: TlsManager, *, via_https: bool
) -> dict[str, Any]:
    """``HttpsStatus``: Listener, Ports, Adressen, Ursprünge, CA und Zertifikat."""
    info = tls.info()
    in_certificate = set(info["certificate"]["addresses"]) if info["certificate"] is not None else set()
    port, source = https_port(con)
    return {
        "enabled": info["enabled"],
        "listening": info["listening"],
        "problem": info["problem"],
        "port": port if settings.https_port is not None else None,
        "port_source": source,
        "http_port": http_port(con),
        "addresses": [
            {
                "address": entry["address"],
                "source": entry["source"],
                "in_certificate": entry["address"] in in_certificate,
            }
            for entry in addresses(con)
        ],
        "origins": app_origins(settings, con),
        "seen_at": _timestamp(serverconfig.get(con, serverconfig.HTTPS_SEEN_AT)),
        "via_https": via_https,
        "ca": info["ca"],
        "certificate": info["certificate"],
    }


def paired_printers(con: sqlite3.Connection) -> list[dict[str, str]]:
    """Je nicht gelöschtem Drucker die jüngste gelungene Kopplung eines Pi, früheste Ablaufzeit zuerst.

    Daran warnt jedes Gerät vor dem Ablauf des Zertifikats (``PI_CERT_WARN_DAYS``), nicht nur das, das
    gekoppelt hat. Gelesen wird ``pi_pairings.pi`` (``PiInfo``); was dort nicht passt, bleibt weg.
    """
    rows = con.execute(
        "SELECT p.printer_id, p.pi FROM pi_pairings AS p "
        "JOIN printers AS d ON d.id = p.printer_id AND d.deleted_at IS NULL "
        "WHERE p.paired_at IS NOT NULL ORDER BY p.paired_at, p.id"
    ).fetchall()
    latest: dict[str, dict[str, str]] = {}
    for row in rows:
        try:
            pi = json.loads(row["pi"] or "null")
        except ValueError:
            continue
        if not isinstance(pi, dict):
            continue
        hostname, not_after = pi.get("hostname"), pi.get("not_after")
        if isinstance(hostname, str) and isinstance(not_after, str) and timeutil.is_timestamp(not_after):
            latest[row["printer_id"]] = {
                "printer_id": row["printer_id"],
                "hostname": hostname,
                "not_after": not_after,
            }
    return sorted(latest.values(), key=lambda entry: (entry["not_after"], entry["printer_id"]))


def status(
    settings: Settings, con: sqlite3.Connection, tls: TlsManager, *, via_https: bool
) -> dict[str, Any]:
    """``SetupStatus``. Nie ein Schlüssel, nie ein Passwort."""
    steps = _steps(con)
    done = ready(settings, con)
    return {
        "password_source": auth.password_source(settings, con),
        "steps": [
            {
                "id": step.value,
                "state": steps.get(step.value, {}).get("state", SetupStepState.OPEN.value),
                "ready": done[step.value],
                "changed_at": steps.get(step.value, {}).get("changed_at"),
            }
            for step in SetupStepId
        ],
        "finished_at": _timestamp(serverconfig.get(con, serverconfig.SETUP_FINISHED_AT)),
        "paired_printers": paired_printers(con),
        "https": https_status(settings, con, tls, via_https=via_https),
    }
