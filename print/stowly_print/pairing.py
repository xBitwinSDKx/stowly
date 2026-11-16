"""Den Raspberry Pi mit Stowly koppeln (docs/sync-protokoll.md, 11.8; pi/README.md).

    python -m stowly_print pair --start --server http://192.168.1.10:8010 --code ABCD-EFGH
    python -m stowly_print pair --server http://192.168.1.10:8010 --code ABCD-EFGH
    python -m stowly_print selftest [--no-test-print]

``pi/install.sh --pair`` ruft alle drei auf: ``pair --start`` gleich nach dem Laden des Pakets, noch mit
dem python3 des Systems, ``pair`` nach der Installation und ``selftest`` nach dem Neustart des Dienstes.

``pair``

1. erkennt den Brother-Drucker am USB (sysfs, Hersteller 04f9),
2. nimmt das vorhandene Token oder erzeugt eines, ermittelt Hostname und Adressen im Heimnetz,
3. erzeugt Schlüssel (P-256) und Zertifikatsantrag mit openssl in einem eigenen Ordner; der Schlüssel
   verlässt den Pi nie,
4. schickt Antrag, Token und Adressen an Stowly (``POST /api/pi/pair``) und bekommt Zertifikat, CA,
   erlaubte Ursprünge und den Drucker in Stowly. Solange die Anfrage läuft, ruht der Druckdienst, und der
   Pi beantwortet auf Port 8080 die Rückprüfung (``proof_responder``): Sieht Stowly ihn nicht unter
   seiner ersten gemeldeten Adresse, etwa hinter Docker auf DSM, fragt es ihn dort nach dem Nachweis
   für genau diesen Antrag,
5. schreibt erst danach: die alten Dateien als ``.bak``, Schlüssel und Zertifikate, die Konfiguration
   (``config.dump_config``, vorher gegen das Lesen geprüft) und ``pairing.json`` ohne Token.

Nur Standardbibliothek und die Kommandozeile von openssl: Auf einem frischen Pi läuft ``pair --start``,
bevor irgendein Paket installiert ist. Der Server liest Codes mit ``normalise_code`` von hier.
"""

import contextlib
import dataclasses
import hashlib
import hmac
import http.server
import ipaddress
import json
import os
import re
import secrets
import signal
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from stowly_print import __version__
from stowly_print.config import (
    DEFAULT_HOST,
    DEFAULT_HTTP_PORT,
    DEFAULT_HTTPS_PORT,
    LOG_LEVELS,
    ConfigurationError,
    Listener,
    ServiceConfig,
    dump_config,
    load_config,
    parse_config,
)
from stowly_print.drivers import PrinterConfig

# --- Orte auf dem Pi (pi/install.sh legt sie an) ------------------------------------------------

CONFIG_DIR = Path("/etc/stowly-print")
CONFIG = CONFIG_DIR / "stowly-print.toml"
TLS_DIR = CONFIG_DIR / "tls"
STATE = CONFIG_DIR / "pairing.json"
SYSFS_USB = Path("/sys/bus/usb/devices")
SERVICE_USER = "stowly-print"

# --- Kopplungscode (Protokoll 11.8) ---------------------------------------------------------------

# Crockford-Base32: Ziffern und Großbuchstaben ohne I, L, O und U.
CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
CODE_LENGTH = 8
# Großzügig gelesen: O gilt als 0, I und L als 1.
_CODE_READING = str.maketrans({"O": "0", "I": "1", "L": "1"})

# --- Was der Pi meldet ---------------------------------------------------------------------------

# Wie PI_HOSTNAME_PATTERN und PI_TOKEN_PATTERN im Vertrag des Servers (stowly/contract/api.py).
HOSTNAME = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?")
TOKEN = re.compile(r"[A-Za-z0-9_-]{16,200}")
# Die Adresse des Pi in seinem eigenen WLAN (pi/access-point.sh); sie steht immer im Zertifikat.
AP_ADDRESS = "10.71.83.1"
# Adressen im Heimnetz, wie sie die CA von Stowly beglaubigt (docs/integrationen.md, 11.3).
HOME_NETWORKS = tuple(
    ipaddress.IPv4Network(network)
    for network in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10")
)
MAX_ADDRESSES = 8
# Die Adresse des Stowly-Servers aus dem Befehl: http(s)://Name oder IP[:Port].
SERVER = re.compile(r"(https?)://([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::([0-9]{1,5}))?/?")

# --- Drucker am USB ------------------------------------------------------------------------------

BROTHER_VENDOR = "04f9"
# idProduct -> Modell, wie es die Brother-Bibliothek nennt. Geprüft gegen usb.ids; am Gerät gesehen
# sind bisher nur 2028 (QL-570) und 209b (QL-800).
BROTHER_MODELS = {
    "2015": "QL-500",
    "2016": "QL-550",
    "2027": "QL-560",
    "2028": "QL-570",
    "2029": "QL-580N",
    "201b": "QL-650TD",
    "2020": "QL-1050",
    "202a": "QL-1060N",
    "2042": "QL-700",
    "2043": "QL-710W",
    "2044": "QL-720NW",
    "209b": "QL-800",
    "209c": "QL-810W",
    "209d": "QL-820NWB",
    "20a7": "QL-1100",
    "20a8": "QL-1110NWB",
    "20ab": "QL-1115NWB",
}
# Ein Brother als USB-Massenspeicher (Schnittstellenklasse 08) ist im Editor-Lite-Modus.
MASS_STORAGE_CLASS = "08"
EDITOR_LITE_HINT = (
    'Der Drucker steckt im Editor-Lite-Modus (grüne Lampe „Editor Lite"). Bitte die Taste halten, '
    "bis die Lampe aus ist; erst dann druckt er."
)

# Für eine neue Konfiguration (wie pi/install.sh ohne --pair).
DEFAULT_PRINTER_NAME = "keller"
DEFAULT_MODEL = "QL-800"
DEFAULT_ADDRESS = "usb://04f9"
DEFAULT_MEDIA = "62"

# --- Anfragen ------------------------------------------------------------------------------------

TIMEOUT_S = 30.0
RETRY_AFTER_MAX_S = 120
REPLY_MAX_BYTES = 256 * 1024
NEW_CODE = (
    'In Stowly einen neuen Code erzeugen (Drucker → „Raspberry Pi koppeln") und den neuen Befehl ausführen.'
)
# Stowly nimmt <hostname>.local nur für Hostnamen ins Zertifikat, die mit "stowly" beginnen.
LOCAL_NAME_HINT = (
    'Der Name „{hostname}.local" steht nicht im Zertifikat; Stowly nimmt dafür nur Namen, die mit „stowly" '
    "beginnen. Die App erreicht den Pi über seine IP-Adresse. Wer den Namen will: sudo raspi-config → "
    "System Options → Hostname (etwa stowly-drucker), dann neu koppeln."
)
CONFIG_HEADER = (
    "Stowly-Druckdienst, geschrieben beim Koppeln mit Stowly (python -m stowly_print pair).",
    'Format: pi/README.md, „Konfiguration". Nach einer Änderung: sudo systemctl restart stowly-print',
)


class PairingError(Exception):
    """Das Koppeln geht nicht weiter. Die Nachricht ist deutscher Klartext für die Konsole."""


# --- Code ----------------------------------------------------------------------------------------


def normalise_code(text: str) -> str:
    """Die Normalform eines Kopplungscodes: 8 Zeichen Crockford-Base32, groß, ohne Trenner.

    Kleinschreibung, Bindestriche und Leerraum zählen nicht; O gilt als 0, I und L als 1.
    ``ValueError`` bei allem anderen.
    """
    plain = "".join(text.split()).replace("-", "").upper().translate(_CODE_READING)
    if len(plain) != CODE_LENGTH or any(char not in CODE_ALPHABET for char in plain):
        raise ValueError("Das ist kein Kopplungscode (8 Zeichen wie ABCD-EFGH).")
    return plain


def format_code(code: str) -> str:
    """Ein Code in Normalform zum Anzeigen: ``XXXX-XXXX``."""
    return f"{code[:4]}-{code[4:]}"


# --- Server --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Server:
    url: str  # http://192.168.1.10:8010, ohne / am Ende
    host: str  # Name oder IP, ohne eckige Klammern
    port: int


def parse_server(text: str) -> Server:
    """Die Adresse des Stowly-Servers aus dem Befehl; ``PairingError``, wenn sie keine ist."""
    match = SERVER.fullmatch(text.strip())
    port = int(match.group(3)) if match and match.group(3) else None
    if match is None or (port is not None and not 1 <= port <= 65535):
        raise PairingError(
            f'„{text}" ist keine Adresse eines Stowly-Servers (etwa http://192.168.1.10:8010).'
        )
    scheme, host = match.group(1), match.group(2)
    url = f"{scheme}://{host}" + (f":{port}" if port is not None else "")
    return Server(url=url, host=host.strip("[]"), port=port or (443 if scheme == "https" else 80))


# --- Drucker am USB ------------------------------------------------------------------------------


@dataclass(frozen=True)
class UsbPrinter:
    """Ein Brother am USB, wie ihn sysfs zeigt."""

    product: str  # idProduct, vier Hex-Ziffern
    model: str | None  # aus BROTHER_MODELS; None = unbekannte Produktnummer
    editor_lite: bool  # meldet sich als Massenspeicher statt als Drucker


def _read_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding="ascii", errors="replace").strip()
    except OSError:
        return None


def find_printers(root: Path = SYSFS_USB) -> list[UsbPrinter]:
    """Alle Brother-Geräte am USB (``idVendor`` 04f9), in der Reihenfolge von sysfs."""
    try:
        devices = sorted(root.iterdir(), key=lambda path: path.name)
    except OSError:
        return []
    found: list[UsbPrinter] = []
    for device in devices:
        if (_read_text(device / "idVendor") or "").lower() != BROTHER_VENDOR:
            continue
        product = (_read_text(device / "idProduct") or "").lower()
        classes: set[str] = set()
        with contextlib.suppress(OSError):
            for child in device.iterdir():
                interface_class = _read_text(child / "bInterfaceClass")
                if interface_class is not None:
                    classes.add(interface_class.lower())
        found.append(
            UsbPrinter(
                product=product,
                model=BROTHER_MODELS.get(product),
                editor_lite=MASS_STORAGE_CLASS in classes,
            )
        )
    return found


# --- Hostname, Adressen, Token -------------------------------------------------------------------


def pi_hostname(raw: str | None = None) -> str:
    """Der Hostname des Pi ohne Domäne; ``PairingError``, wenn er nicht als ``<name>.local`` taugt."""
    name = (socket.gethostname() if raw is None else raw).split(".")[0]
    if not HOSTNAME.fullmatch(name):
        raise PairingError(
            f'Der Hostname „{name}" taugt nicht für das Zertifikat (nur Buchstaben, Ziffern und „-", '
            "höchstens 63 Zeichen). Ändern mit: sudo raspi-config → System Options → Hostname."
        )
    return name


def home_address(text: str) -> bool:
    """Eine IPv4-Adresse im Heimnetz, die ins Zertifikat darf (nicht die des eigenen WLANs)."""
    try:
        address = ipaddress.IPv4Address(text)
    except ValueError:
        return False
    return text != AP_ADDRESS and any(address in network for network in HOME_NETWORKS)


def source_address(server: Server) -> str | None:
    """Die eigene Adresse auf dem Weg zum Server: ein UDP-„connect" schickt nichts, legt aber die Route fest."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect((server.host, server.port))
            return str(probe.getsockname()[0])
    except OSError:
        return None


Run = Callable[..., subprocess.CompletedProcess]


def interface_addresses(run: Run = subprocess.run) -> list[str]:
    """Alle IPv4-Adressen der Schnittstellen (``ip -j -4 addr``); leer, wenn das nicht geht."""
    try:
        result = run(["ip", "-j", "-4", "addr"], capture_output=True, text=True, timeout=10, check=False)
        interfaces = json.loads(result.stdout) if result.returncode == 0 else []
    except (OSError, subprocess.SubprocessError, ValueError):
        return []
    addresses: list[str] = []
    for interface in interfaces if isinstance(interfaces, list) else []:
        infos = interface.get("addr_info") if isinstance(interface, dict) else None
        for info in infos if isinstance(infos, list) else []:
            if isinstance(info, dict) and info.get("family") == "inet" and isinstance(info.get("local"), str):
                addresses.append(info["local"])
    return addresses


def pi_addresses(first: str | None, others: Sequence[str]) -> list[str]:
    """Die Adressen für Stowly: die zum Server zuerst, nur Heimnetz, ohne Doppelte, höchstens 8."""
    result: list[str] = []
    for candidate in (first, *others):
        if candidate and home_address(candidate) and candidate not in result:
            result.append(candidate)
    return result[:MAX_ADDRESSES]


def read_raw_config(path: Path) -> dict[str, Any] | None:
    """Die bisherige Konfiguration als TOML, ohne sie zu prüfen; ``None``, wenn es keine lesbare gibt."""
    try:
        with path.open("rb") as handle:
            raw = tomllib.load(handle)
    except (OSError, tomllib.TOMLDecodeError):
        return None
    return raw if isinstance(raw, dict) else None


def keep_or_new_token(raw: dict[str, Any] | None) -> tuple[str, bool]:
    """Das vorhandene Token, wenn Stowly es annimmt; sonst ein neues. Liefert ``(token, neu)``."""
    token = raw.get("token") if raw is not None else None
    if isinstance(token, str) and TOKEN.fullmatch(token.strip()):
        return token.strip(), False
    return secrets.token_urlsafe(24), True


# --- Schlüssel und Antrag ------------------------------------------------------------------------


def _openssl(run: Run, arguments: list[str]) -> None:
    try:
        result = run(arguments, capture_output=True, text=True, timeout=60, check=False)
    except FileNotFoundError:
        raise PairingError("openssl fehlt (Paket openssl).") from None
    except (OSError, subprocess.SubprocessError) as exc:
        raise PairingError(f"openssl lief nicht ({exc}).") from None
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip().splitlines()
        raise PairingError(f"openssl meldet einen Fehler: {detail[-1] if detail else result.returncode}")


def make_key_and_csr(
    folder: Path, hostname: str, *, openssl: str = "openssl", run: Run = subprocess.run
) -> tuple[bytes, str]:
    """Schlüssel (P-256) und Zertifikatsantrag in ``folder``; liefert ``(schlüssel_pem, antrag_pem)``.

    Betreff ist der Hostname; die Adressen bestimmt ohnehin der Server.
    """
    key = folder / "pi.key"
    request = folder / "pi.csr"
    _openssl(
        run,
        [openssl, "genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", str(key)],
    )
    _openssl(
        run, [openssl, "req", "-new", "-key", str(key), "-subj", f"/CN={hostname}", "-out", str(request)]
    )
    return key.read_bytes(), request.read_text(encoding="ascii")


def check_key_pair(folder: Path, key_pem: bytes, certificate_pem: str) -> None:
    """Passt das Zertifikat zum Schlüssel? Sonst bliebe HTTPS nach dem Neustart aus."""
    key = folder / "probe.key"
    certificate = folder / "probe.crt"
    key.write_bytes(key_pem)
    certificate.write_text(certificate_pem, encoding="ascii")
    try:
        ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER).load_cert_chain(str(certificate), str(key))
    except (ssl.SSLError, OSError) as exc:
        raise PairingError(f"Das Zertifikat von Stowly passt nicht zum Schlüssel des Pi ({exc}).") from None


# --- Anfragen an Stowly --------------------------------------------------------------------------


@dataclass(frozen=True)
class Reply:
    status: int
    headers: dict[str, str]  # Namen klein geschrieben
    body: Any  # JSON oder None


Post = Callable[[str, dict[str, Any]], Reply]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args: Any, **_kwargs: Any) -> None:
        return None


def _json_or_none(raw: bytes) -> Any:
    try:
        return json.loads(raw) if raw.strip() else None
    except ValueError:
        return None


def http_post(url: str, payload: dict[str, Any]) -> Reply:
    """``POST`` mit JSON, ohne Proxy und ohne Weiterleitungen. ``PairingError``, wenn Stowly nicht antwortet."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": f"stowly-print/{__version__}",
        },
    )
    try:
        with opener.open(request, timeout=TIMEOUT_S) as response:
            headers = {name.lower(): value for name, value in response.headers.items()}
            return Reply(response.status, headers, _json_or_none(response.read(REPLY_MAX_BYTES)))
    except urllib.error.HTTPError as error:
        headers = {name.lower(): value for name, value in (error.headers or {}).items()}
        with contextlib.suppress(OSError):
            return Reply(error.code, headers, _json_or_none(error.read(REPLY_MAX_BYTES)))
        return Reply(error.code, headers, None)
    except (urllib.error.URLError, OSError, ValueError) as error:
        reason = getattr(error, "reason", error)
        raise PairingError(f"Stowly ist unter {url} nicht erreichbar ({reason}).") from None


def _retry_after(reply: Reply) -> int:
    try:
        wait = int(reply.headers.get("retry-after", "60"))
    except ValueError:
        wait = 60
    return min(max(wait, 1), RETRY_AFTER_MAX_S)


def call(
    post: Post, url: str, payload: dict[str, Any], *, sleep: Callable[[float], None] = time.sleep
) -> Reply:
    """Eine Anfrage; bei 429 genau ein zweiter Versuch nach ``Retry-After``."""
    reply = post(url, payload)
    if reply.status == 429:
        wait = _retry_after(reply)
        print(
            f"    Stowly bremst gerade (zu viele Fehlversuche). Neuer Versuch in {wait} Sekunden …",
            flush=True,
        )
        sleep(wait)
        reply = post(url, payload)
    return reply


def _server_message(reply: Reply) -> str | None:
    error = reply.body.get("error") if isinstance(reply.body, dict) else None
    message = error.get("message") if isinstance(error, dict) else None
    return message.strip() if isinstance(message, str) and message.strip() else None


def _problems(reply: Reply) -> list[str]:
    error = reply.body.get("error") if isinstance(reply.body, dict) else None
    details = error.get("details") if isinstance(error, dict) else None
    problems = details.get("errors") if isinstance(details, dict) else None
    texts: list[str] = []
    for problem in problems if isinstance(problems, list) else []:
        if isinstance(problem, dict):
            where = ".".join(str(part) for part in problem.get("loc") or [] if part != "body")
            texts.append(f"{where}: {problem.get('msg')}" if where else str(problem.get("msg")))
    return texts


def expect(reply: Reply, status: int) -> Any:
    """Der Rumpf einer erwarteten Antwort; sonst ``PairingError`` mit dem Satz des Servers."""
    if reply.status == status:
        return reply.body
    message = _server_message(reply) or f"Stowly antwortet mit {reply.status}."
    if reply.status in (404, 409):
        raise PairingError(f"{message} {NEW_CODE}")
    if reply.status == 422:
        problems = "; ".join(_problems(reply))
        raise PairingError(f"{message} ({problems})" if problems else message)
    if reply.status == 429:
        raise PairingError(f"{message} Bitte etwas warten und den Befehl erneut ausführen.")
    raise PairingError(message)


# --- Rückprüfung ---------------------------------------------------------------------------------
# Stowly signiert nur eine Adresse, unter der es den Pi selbst sieht. Hinter Docker auf DSM kommt jede
# Anfrage scheinbar aus dem Netz von Docker (etwa 172.19.0.1). Dann fragt Stowly den Pi unter den
# gemeldeten Adressen: GET http://<adresse>:8080/v1/pair-proof?nonce=… muss den Nachweis für genau diesen
# Antrag liefern (``pair_proof``: Token, nonce und die SHA-256 des Antrags; docs/sync-protokoll.md, 11.8).
# Den kennt nur der Pi, der den Antrag gestellt hat, und nur solange ``pair`` läuft. Der Druckdienst kennt
# den Pfad nicht: Wer das Token eines anderen Pi kennt, bekommt über dessen Dienst keinen Nachweis.

NONCE = re.compile(r"[A-Za-z0-9_-]{16,64}")
PROOF_PATH = "/v1/pair-proof"
SERVICE_UNIT = "stowly-print.service"
PORT_BUSY = (
    "    Port {port} ist belegt; die Rückprüfung von Stowly geht dann nicht. Läuft dort ein anderer Dienst?"
)


def proof_of(token: str, nonce: str) -> str:
    """Der Nachweis über das Token: HMAC-SHA256(Token, nonce) als Hex, wie in ``/v1/health`` des Dienstes."""
    return hmac.new(token.encode("utf-8"), nonce.encode("ascii"), hashlib.sha256).hexdigest()


def csr_digest(csr: str) -> str:
    """Woran Stowly einen Antrag erkennt: SHA-256 des PEM ohne Zeilenende-Unterschiede, als Hex."""
    return hashlib.sha256(csr.replace("\r\n", "\n").strip().encode("utf-8")).hexdigest()


def pair_proof(token: str, nonce: str, digest: str) -> str:
    """Der Nachweis der Rückprüfung: HMAC-SHA256(Token, ``stowly-pair:<nonce>:<digest>``) als Hex.

    Er gilt nur für den Antrag mit der SHA-256 ``digest``; ``/v1/health`` liefert etwas anderes.
    """
    message = f"stowly-pair:{nonce}:{digest}".encode("ascii")
    return hmac.new(token.encode("utf-8"), message, hashlib.sha256).hexdigest()


class _ProofHandler(http.server.BaseHTTPRequestHandler):
    """Beantwortet nur ``GET /v1/pair-proof?nonce=…`` mit dem Nachweis; alles andere ist 404."""

    token = ""
    digest = ""
    server_version = "stowly-print"
    sys_version = ""

    def do_GET(self) -> None:
        parts = urllib.parse.urlsplit(self.path)
        nonces = urllib.parse.parse_qs(parts.query).get("nonce", [])
        if parts.path != PROOF_PATH or len(nonces) != 1 or not NONCE.fullmatch(nonces[0]):
            self.send_error(404)
            return
        body = json.dumps(
            {
                "app": "stowly-print",
                "version": __version__,
                "proof": pair_proof(self.token, nonces[0], self.digest),
            }
        ).encode("ascii")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - Name aus http.server
        """Kein Log: Die Ausgabe gehört dem Installer."""


class _ProofServer(http.server.ThreadingHTTPServer):
    # Unter Linux erlaubt SO_REUSEADDR den Port trotz alter Verbindungen (TIME_WAIT), aber nie neben einem
    # laufenden Dienst. Unter Windows hieße es: den Port einem laufenden Dienst wegnehmen.
    allow_reuse_address = os.name != "nt"


@contextlib.contextmanager
def proof_responder(
    token: str, digest: str, *, host: str = "0.0.0.0", port: int = DEFAULT_HTTP_PORT
) -> Iterator[int | None]:
    """Beantwortet die Rückprüfung für den Antrag ``digest``, solange der Block läuft: Port 8080 auf allen
    Schnittstellen. Liefert den Port; ``None``, wenn er belegt ist (dann scheitert eine Rückprüfung)."""
    handler = type("ProofHandler", (_ProofHandler,), {"token": token, "digest": digest})
    try:
        server = _ProofServer((host, port), handler)
    except OSError:
        yield None
        return
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.2}, daemon=True)
    thread.start()
    try:
        yield int(server.server_address[1])
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


Respond = Callable[[str, str], contextlib.AbstractContextManager[int | None]]


@dataclass
class ServiceControl:
    """Hält den Druckdienst an, solange ``pair`` die Rückprüfung beantwortet: Port 8080 ist dann frei,
    und nur der Pi selbst antwortet dort. Nur als root mit systemd; sonst geschieht nichts."""

    run: Run = subprocess.run

    def pause(self) -> bool:
        """Hält den Dienst an, wenn er läuft; liefert, ob er angehalten wurde."""
        if not hasattr(os, "geteuid") or os.geteuid() != 0:
            return False
        try:
            active = self.run(["systemctl", "is-active", "--quiet", SERVICE_UNIT], check=False, timeout=15)
            if active.returncode != 0:
                return False
            return self.run(["systemctl", "stop", SERVICE_UNIT], check=False, timeout=60).returncode == 0
        except (OSError, subprocess.SubprocessError):
            return False

    def resume(self) -> None:
        """Startet den Dienst wieder, mit der Konfiguration, die dann gilt."""
        with contextlib.suppress(OSError, subprocess.SubprocessError):
            self.run(["systemctl", "start", SERVICE_UNIT], check=False, timeout=60)


@contextlib.contextmanager
def signals_as_exit() -> Iterator[None]:
    """SIGHUP und SIGTERM beenden den Block über ``SystemExit``, sodass jedes ``finally`` darin läuft.

    Reißt die SSH-Sitzung ab, während der Druckdienst ruht, startet ``pair`` ihn so trotzdem wieder.
    Außerhalb des Hauptthreads geht das nicht; dann bleibt alles, wie es ist.
    """
    if threading.current_thread() is not threading.main_thread():
        yield
        return

    def stop(signum: int, _frame: Any) -> None:
        raise SystemExit(128 + signum)

    previous: dict[int, Any] = {}
    for name in ("SIGHUP", "SIGTERM"):
        number = getattr(signal, name, None)
        if number is not None:
            previous[number] = signal.signal(number, stop)
    try:
        yield
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)


# --- Koppeln -------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Paths:
    """Wohin das Koppeln schreibt; Tests setzen eigene Ordner ein."""

    config: Path = CONFIG
    tls: Path = TLS_DIR
    state: Path = STATE
    sysfs: Path = SYSFS_USB


@dataclass(frozen=True)
class Outcome:
    """Was das Koppeln ergeben hat. Ohne Token."""

    server: str
    printer_id: str
    printer_name: str
    urls: list[str]
    origins: list[str]
    not_after: str
    hostname: str
    addresses: list[str]
    model: str | None
    printer_found: bool
    token_new: bool
    notes: list[str] = field(default_factory=list)


def announce(server_text: str, code_text: str, *, post: Post = http_post, hostname: str | None = None) -> str:
    """``pair --start``: meldet den Pi gleich nach dem Laden des Pakets (``POST /api/pi/pair/start``).

    Die App zeigt dann „Der Pi richtet sich ein …". Liefert den Hostnamen.
    """
    server = parse_server(server_text)
    code = _code(code_text)
    name = pi_hostname(hostname)
    reply = call(
        post, f"{server.url}/api/pi/pair/start", {"code": code, "hostname": name, "version": __version__}
    )
    expect(reply, 204)
    return name


def _code(text: str) -> str:
    try:
        return normalise_code(text)
    except ValueError as exc:
        raise PairingError(f"{exc} Bitte den Befehl genau so aus der App kopieren.") from None


def _origin(text: str) -> str:
    """Ein Ursprung so, wie ihn die Konfiguration speichert (wie ``config._origin``)."""
    return text.strip().rstrip("/").lower()


def _previous_printer(path: Path) -> str | None:
    """Der Drucker einer früheren Kopplung aus ``pairing.json``."""
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    printer_id = state.get("printer_id") if isinstance(state, dict) else None
    return printer_id if isinstance(printer_id, str) and re.fullmatch(r"[0-9a-f-]{36}", printer_id) else None


def _existing_config(path: Path) -> ServiceConfig | None:
    if not path.exists():
        return None
    try:
        return load_config(path)
    except ConfigurationError:
        return None


def build_config(
    *,
    previous: ServiceConfig | None,
    raw: dict[str, Any] | None,
    token: str,
    origins: Sequence[str],
    tls: Path,
    detected_model: str | None,
    model: str | None,
    address: str | None,
) -> ServiceConfig:
    """Die neue Konfiguration: Token, Ursprünge, beide Zugänge und die Drucker.

    Aus der bisherigen bleiben ``log_level`` und alle Drucker; der erste Brother bekommt das erkannte
    Modell (oder ``model``). Ohne bisherige Konfiguration entsteht ein Brother am USB.
    """
    log_level = previous.log_level if previous is not None else None
    if log_level is None and raw is not None and str(raw.get("log_level", "")).lower() in LOG_LEVELS:
        log_level = str(raw["log_level"]).lower()
    wanted_model = model or detected_model
    if previous is not None:
        printers = list(previous.printers)
        for index, printer in enumerate(printers):
            if printer.driver == "brother_ql":
                if wanted_model is not None:
                    printers[index] = dataclasses.replace(printer, model=wanted_model)
                break
    else:
        printers = [
            PrinterConfig(
                name=DEFAULT_PRINTER_NAME,
                driver="brother_ql",
                model=wanted_model or DEFAULT_MODEL,
                address=address or DEFAULT_ADDRESS,
                media=DEFAULT_MEDIA,
            )
        ]
    return ServiceConfig(
        token=token,
        origins=tuple(dict.fromkeys(_origin(origin) for origin in origins if origin.strip())),
        http=Listener(host=DEFAULT_HOST, port=DEFAULT_HTTP_PORT),
        https=Listener(
            host=DEFAULT_HOST, port=DEFAULT_HTTPS_PORT, certificate=tls / "pi.crt", key=tls / "pi.key"
        ),
        printers=tuple(printers),
        log_level=log_level or "info",
    )


def config_text(config: ServiceConfig, base: Path) -> str:
    """Die Konfiguration als TOML; geprüft, dass das Lesen genau sie wieder ergibt."""
    text = dump_config(config, header=CONFIG_HEADER)
    try:
        again = parse_config(tomllib.loads(text), base)
    except (ConfigurationError, tomllib.TOMLDecodeError) as exc:
        raise PairingError(f"Die neue Konfiguration wäre nicht lesbar ({exc}); nichts geschrieben.") from None
    if again != config:
        raise PairingError(
            "Die neue Konfiguration ließe sich nicht genau so wieder lesen; nichts geschrieben."
        )
    return text


def _pem(text: Any, label: str) -> str:
    if not isinstance(text, str) or f"-----BEGIN {label}-----" not in text:
        raise PairingError("Die Antwort von Stowly ist unvollständig (kein Zertifikat).")
    return text if text.endswith("\n") else text + "\n"


def _text_list(value: Any) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise PairingError("Die Antwort von Stowly ist unvollständig (Listen).")
    return value


def pair(
    server_text: str,
    code_text: str,
    *,
    origins: Sequence[str] = (),
    model: str | None = None,
    address: str | None = None,
    paths: Paths | None = None,
    post: Post = http_post,
    hostname: str | None = None,
    addresses: Sequence[str] | None = None,
    make_csr: Callable[[Path, str], tuple[bytes, str]] = make_key_and_csr,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
    respond: Respond | None = None,
    service: ServiceControl | None = None,
) -> Outcome:
    """Koppelt den Pi (``POST /api/pi/pair``) und schreibt danach Schlüssel, Zertifikate und Konfiguration.

    ``addresses`` ersetzt die Erkennung der Adressen (für Tests); sonst die Quelladresse zum Server,
    dann ``ip -j -4 addr``. Während der Anfrage beantwortet ``respond`` die Rückprüfung (Vorgabe:
    ``proof_responder``); der Druckdienst ruht so lange (``service``) und startet danach wieder.
    """
    paths = paths or Paths()
    server = parse_server(server_text)
    code = _code(code_text)
    name = pi_hostname(hostname)
    notes: list[str] = []

    printers = find_printers(paths.sysfs)
    first = printers[0] if printers else None
    detected = first.model if first is not None else None
    if first is not None and first.editor_lite:
        notes.append(EDITOR_LITE_HINT)
    elif first is not None and first.model is None:
        notes.append(f"Ein Brother mit unbekannter Produktnummer {first.product} hängt am USB.")

    if addresses is None:
        found = pi_addresses(source_address(server), interface_addresses())
    else:
        found = pi_addresses(None, addresses)
    if not found:
        raise PairingError(
            "Der Pi hat keine Adresse im Heimnetz (10.x, 172.16–31.x, 192.168.x). Ist er im WLAN des Hauses?"
        )

    raw = read_raw_config(paths.config)
    previous = _existing_config(paths.config)
    if paths.config.exists() and previous is None:
        notes.append(
            f"Die bisherige Konfiguration ließ sich nicht lesen; sie bleibt als {paths.config.name}.bak."
        )
    token, token_new = keep_or_new_token(raw)

    with tempfile.TemporaryDirectory(prefix="stowly-pair-") as work:
        folder = Path(work)
        key_pem, csr = make_csr(folder, name)
        payload = {
            "code": code,
            "hostname": name,
            "addresses": found,
            "csr": csr,
            "token": token,
            "model": detected or model,
            "printer_found": first is not None,
            "printer_id": _previous_printer(paths.state),
            "version": __version__,
        }
        control = service if service is not None else ServiceControl()
        with signals_as_exit():
            paused = control.pause()
            try:
                with (respond or proof_responder)(token, csr_digest(csr)) as port:
                    if port is None:
                        print(PORT_BUSY.format(port=DEFAULT_HTTP_PORT), flush=True)
                    result = expect(call(post, f"{server.url}/api/pi/pair", payload, sleep=sleep), 200)
                if not isinstance(result, dict):
                    raise PairingError("Die Antwort von Stowly ist kein Ergebnis einer Kopplung.")
                certificate = _pem(result.get("certificate"), "CERTIFICATE")
                ca = _pem(result.get("ca"), "CERTIFICATE")
                server_origins = _text_list(result.get("origins"))
                urls = _text_list(result.get("urls"))
                printer_id, printer_name, not_after = (
                    result.get(key) for key in ("printer_id", "name", "not_after")
                )
                if not all(isinstance(value, str) for value in (printer_id, printer_name, not_after)):
                    raise PairingError("Die Antwort von Stowly ist unvollständig (Drucker).")
                check_key_pair(folder, key_pem, certificate)
                if not any(".local:" in url for url in urls):
                    notes.append(LOCAL_NAME_HINT.format(hostname=name))

                config = build_config(
                    previous=previous,
                    raw=raw,
                    token=token,
                    origins=[*server_origins, *origins],
                    tls=paths.tls,
                    detected_model=detected,
                    model=model,
                    address=address,
                )
                text = config_text(config, paths.config.parent)
                state = {
                    "server": server.url,
                    "printer_id": printer_id,
                    "not_after": not_after,
                    "paired_at": now().astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
                }
                install_files(
                    paths, key_pem=key_pem, certificate=certificate, ca=ca, config=text, state=state
                )
            finally:
                # Auch wenn das Koppeln scheitert: Der Dienst läuft danach wieder, mit der Konfiguration, die gilt.
                if paused:
                    control.resume()

    return Outcome(
        server=server.url,
        printer_id=str(printer_id),
        printer_name=str(printer_name),
        urls=urls,
        origins=list(config.origins),
        not_after=str(not_after),
        hostname=name,
        addresses=found,
        model=detected or model,
        printer_found=first is not None,
        token_new=token_new,
        notes=notes,
    )


# --- Dateien schreiben ---------------------------------------------------------------------------


def _ids(user: str | None, group: str | None) -> tuple[int, int] | None:
    """uid und gid zum Benutzer und zur Gruppe; ``None``, wenn das hier nicht geht (nicht root, Windows)."""
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        return None
    # grp und pwd gibt es nur unter Unix.
    import grp
    import pwd

    try:
        uid = pwd.getpwnam(user).pw_uid if user else 0
        gid = grp.getgrnam(group).gr_gid if group else 0
    except KeyError:
        return None
    return uid, gid


def write_file(
    path: Path, data: bytes, *, mode: int, user: str | None = None, group: str | None = None
) -> None:
    """Schreibt atomar: neue Datei daneben (Rechte vorher gesetzt), ``fsync``, dann umbenannt."""
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        owner = _ids(user, group)
        if owner is not None:
            os.chown(temporary, *owner)
        os.replace(temporary, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(temporary)
        raise


def keep_backup(path: Path) -> None:
    """Die bisherige Datei bleibt als ``<name>.bak``: root gehörend, höchstens 0640 (der Schlüssel 0600)."""
    if path.is_file() and not path.is_symlink():
        mode = path.stat().st_mode & 0o777
        write_file(path.with_name(path.name + ".bak"), path.read_bytes(), mode=mode & 0o640)


def install_files(
    paths: Paths, *, key_pem: bytes, certificate: str, ca: str, config: str, state: dict[str, Any]
) -> None:
    """Schreibt alles nach einer gelungenen Kopplung. Rechte wie in pi/README.md, „Was die Skripte anlegen"."""
    paths.config.parent.mkdir(parents=True, exist_ok=True)
    if not paths.tls.is_dir():
        paths.tls.mkdir(parents=True, mode=0o750)
    owner = _ids(None, SERVICE_USER)
    if owner is not None:
        os.chown(paths.tls, *owner)
        os.chmod(paths.tls, 0o750)
    for old in (paths.tls / "pi.key", paths.tls / "pi.crt", paths.tls / "ca.crt", paths.config, paths.state):
        keep_backup(old)
    # Den Schlüssel liest nur der Dienst.
    write_file(paths.tls / "pi.key", key_pem, mode=0o600, user=SERVICE_USER, group=SERVICE_USER)
    write_file(paths.tls / "pi.crt", certificate.encode("ascii"), mode=0o644)
    write_file(paths.tls / "ca.crt", ca.encode("ascii"), mode=0o644)
    write_file(paths.config, config.encode("utf-8"), mode=0o640, group=SERVICE_USER)
    write_file(paths.state, (json.dumps(state, indent=2) + "\n").encode("utf-8"), mode=0o644)


# --- Selbsttest ----------------------------------------------------------------------------------


@dataclass(frozen=True)
class Check:
    name: str
    ok: bool
    message: str


def _get(
    url_host: str, port: int, path: str, *, context: ssl.SSLContext | None, server_name: str | None
) -> Any:
    """``GET`` an den eigenen Dienst; bei HTTPS mit Prüfung gegen ``server_name`` (eine Adresse im Zertifikat)."""
    with socket.create_connection((url_host, port), timeout=10) as raw:
        stream: socket.socket = raw
        if context is not None:
            stream = context.wrap_socket(raw, server_hostname=server_name)
        try:
            request = f"GET {path} HTTP/1.1\r\nHost: {server_name or url_host}\r\nConnection: close\r\n\r\n"
            stream.sendall(request.encode("ascii"))
            chunks: list[bytes] = []
            while chunk := stream.recv(65536):
                chunks.append(chunk)
                if sum(len(part) for part in chunks) > REPLY_MAX_BYTES:
                    break
        finally:
            if stream is not raw:
                stream.close()
    head, _, body = b"".join(chunks).partition(b"\r\n\r\n")
    status = head.split(b"\r\n", 1)[0].split()
    if len(status) < 2 or status[1] != b"200":
        raise OSError(f"Antwort {status[1].decode('ascii', 'replace') if len(status) > 1 else '?'}")
    if b"transfer-encoding: chunked" in head.lower():
        body = _unchunk(body)
    return json.loads(body)


def _unchunk(body: bytes) -> bytes:
    out = bytearray()
    while body:
        size_line, _, rest = body.partition(b"\r\n")
        size = int(size_line.split(b";")[0], 16)
        if size == 0:
            break
        out += rest[:size]
        body = rest[size + 2 :]
    return bytes(out)


def _wait_for_http(port: int, token: str, *, tries: int, sleep: Callable[[float], None]) -> Any:
    """``/v1/health`` über HTTP, mit Nachweis über das Token (``proof``); der Dienst startet eben erst."""
    nonce = secrets.token_hex(16)
    problem: Exception | None = None
    for attempt in range(tries):
        try:
            health = _get("127.0.0.1", port, f"/v1/health?nonce={nonce}", context=None, server_name=None)
        except (OSError, ValueError) as exc:
            problem = exc
            if attempt + 1 < tries:
                sleep(1.0)
            continue
        expected = proof_of(token, nonce)
        if not isinstance(health, dict) or health.get("app") != "stowly-print":
            raise OSError("Antwort ist nicht vom Druckdienst")
        if not hmac.compare_digest(str(health.get("proof", "")), expected):
            raise OSError("Der Dienst kennt das Token aus der Konfiguration nicht")
        return health
    raise OSError(str(problem) if problem is not None else "keine Antwort")


def _print_test_label(port: int, token: str, hostname: str) -> str:
    """Druckt ein Testetikett (Vorlage ``zone``) über HTTP und wartet auf den Ausgang."""
    from stowly_print.templates import load_builtin

    body = {
        "template": load_builtin("zone"),
        "data": {
            "qr": f"Stowly Testetikett {hostname}",
            "title": "Testetikett",
            "subtitle": f"{hostname} · Stowly",
        },
    }
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/v1/jobs/selbsttest-{secrets.token_hex(6)}?wait=25",
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "text/plain", "Authorization": f"Bearer {token}"},
    )
    with opener.open(request, timeout=40) as response:
        job = json.loads(response.read(REPLY_MAX_BYTES))
    return str(job.get("state")) if isinstance(job, dict) else "?"


def selftest(
    config_path: Path = CONFIG,
    *,
    tls: Path = TLS_DIR,
    test_print: bool = True,
    tries: int = 20,
    sleep: Callable[[float], None] = time.sleep,
    hostname: str | None = None,
) -> list[Check]:
    """HTTP, dann HTTPS gegen ``ca.crt``, dann ein Testetikett, wenn der erste Drucker bereit ist."""
    try:
        config = load_config(config_path)
    except ConfigurationError as exc:
        return [Check("Konfiguration", False, str(exc))]
    checks: list[Check] = []
    health: Any = None
    if config.http is None:
        checks.append(Check("HTTP", False, "In der Konfiguration ist kein HTTP-Zugang eingeschaltet."))
    else:
        try:
            health = _wait_for_http(config.http.port, config.token, tries=tries, sleep=sleep)
            checks.append(
                Check("HTTP", True, f"http://127.0.0.1:{config.http.port}/v1/health: {health.get('version')}")
            )
        except (OSError, ValueError) as exc:
            checks.append(Check("HTTP", False, f"http://127.0.0.1:{config.http.port}/v1/health: {exc}"))

    ca = tls / "ca.crt"
    if config.https is None:
        checks.append(Check("HTTPS", False, "In der Konfiguration ist kein HTTPS-Zugang eingeschaltet."))
    else:
        try:
            context = ssl.create_default_context(cafile=str(ca))
            # Die Adresse des eigenen WLANs steht immer im Zertifikat (Protokoll 11.8).
            reply = _get(
                "127.0.0.1", config.https.port, "/v1/health", context=context, server_name=AP_ADDRESS
            )
            if not isinstance(reply, dict) or reply.get("app") != "stowly-print":
                raise OSError("Antwort ist nicht vom Druckdienst")
            checks.append(Check("HTTPS", True, f"Zertifikat von Stowly gilt (geprüft gegen {ca})."))
        except (OSError, ValueError, ssl.SSLError) as exc:
            checks.append(Check("HTTPS", False, f"HTTPS geht nicht ({exc})."))

    if not test_print:
        checks.append(Check("Testetikett", True, "übersprungen (--no-test-print)"))
    elif config.http is not None and isinstance(health, dict):
        printers = health.get("printers") or []
        first = printers[0] if printers and isinstance(printers[0], dict) else {}
        status = first.get("status") if isinstance(first.get("status"), dict) else {}
        if status.get("ready") is True:
            try:
                state = _print_test_label(config.http.port, config.token, pi_hostname(hostname))
                checks.append(Check("Testetikett", state in ("printed", "sent"), f"Auftrag: {state}"))
            except (OSError, ValueError, PairingError) as exc:
                checks.append(Check("Testetikett", False, f"Druck ging nicht ({exc})."))
        else:
            errors = ", ".join(str(error) for error in status.get("errors") or []) or "nicht bereit"
            checks.append(Check("Testetikett", True, f"übersprungen: Drucker meldet {errors}"))
    return checks
