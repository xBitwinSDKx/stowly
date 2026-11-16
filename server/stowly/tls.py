"""HTTPS mit eigener Zertifizierungsstelle (docs/integrationen.md, Abschnitt 11).

* **Dateien** in ``/data/tls`` (0700), nie in der Datenbank: ``ca.crt`` (0644), ``ca.key`` (0600) und
  ``server.pem`` (0600, Schlüssel und Zertifikat des HTTPS-Listeners in einer Datei, damit beides
  zusammen wechselt). Geschrieben wird über eine Zwischendatei mit ``fsync`` und ``os.replace``. Das Log
  nennt Fingerabdrücke, nie einen Schlüssel. Rechte prüft und setzt der Server nur unter POSIX.
* **CA:** Liegen ``ca.crt`` und ``ca.key`` da, lädt Stowly sie, wenn sie taugen (auch eine von Hand
  hineingelegte). Fehlt nur eine oder taugt eine nicht, steht das in ``problem``, und nichts wird
  überschrieben. Fehlen beide, entsteht eine neue CA mit Name Constraints auf das Heimnetz.
* **Zertifikat des Servers:** für die Adressen aus ``wizard`` (ohne bekannte vorläufig ``localhost`` und
  ``127.0.0.1``), neu ausgestellt bei geänderten Adressen, gewechselter CA oder weniger als
  ``SERVER_CERT_RENEW_DAYS`` Tagen Rest; das prüft auch ``TlsRenewJob`` einmal am Tag. Nur mit HTTPS
  (``STOWLY_HTTPS_PORT``); die CA entsteht immer, denn das Koppeln eines Pi braucht sie auch ohne.
* **Listener:** ``context`` liefert den SSL-Kontext für uvicorn. Ein neues Zertifikat lädt ``reload`` in
  denselben Kontext, aber nur in der Ereignisschleife und nach einer Probe in einem eigenen Kontext:
  OpenSSL setzt zuerst das Zertifikat und verwirft dabei den alten Schlüssel; dazwischen taugt der
  Kontext für keinen Handshake. Laufende Verbindungen behalten das alte Zertifikat.
* **Koppeln eines Pi:** ``sign_csr`` (``stowly/pairing.py``).
"""

import asyncio
import ipaddress
import logging
import os
import re
import secrets
import ssl
import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from cryptography import x509
from cryptography.exceptions import InvalidSignature, UnsupportedAlgorithm
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from stowly import db, localtime, safefile, scheduler
from stowly.config import Settings
from stowly.contract.api import PI_CERT_DAYS, SERVER_CERT_DAYS, SERVER_CERT_RENEW_DAYS
from stowly.contract.timeutil import format_timestamp

log = logging.getLogger("stowly.tls")

CA_CERT = "ca.crt"
CA_KEY = "ca.key"
SERVER_PEM = "server.pem"

# Eine neue CA gilt so lange; eine geladene muss noch mindestens CA_MIN_DAYS gelten.
CA_DAYS = 3650
CA_MIN_DAYS = 30
CA_NAME = "Stowly CA"
SERVER_NAME = "Stowly"
DEVICE_NAME = "Stowly Drucker"
# notBefore liegt eine Stunde zurück: Geräte mit leicht nachgehender Uhr nehmen das Zertifikat trotzdem.
BACKDATE = timedelta(hours=1)
# Ohne bekannte Adresse gilt das Zertifikat vorläufig hierfür, damit der Listener immer starten kann.
PROVISIONAL = ("localhost", "127.0.0.1")

# Was eine neue CA beglaubigen darf (docs/integrationen.md, 11.2 und 11.3): das Heimnetz, Loopback und
# localhost. Nicht kritisch markiert, damit Geräte ohne Unterstützung nicht ablehnen.
HOME_NETWORKS = ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fc00::/7")
LOOPBACK_NETWORKS = ("127.0.0.0/8", "::1/128")
LOCAL_SUFFIXES = ("local", "lan", "home", "home.arpa", "internal", "localdomain", "fritz.box")
PERMITTED_NAMES = (*LOCAL_SUFFIXES, "localhost")

_STOWLY_CA = re.compile(r"Stowly CA [0-9a-f]{6}")
_POSIX = os.name == "posix"


class CaUnavailable(Exception):
    """Es gibt keine nutzbare CA; Stowly kann nichts signieren. Die Nachricht ist deutscher Klartext."""


class CsrRejected(ValueError):
    """Der Zertifikatsantrag taugt nicht (Form, Signatur, Schlüssel). Die Nachricht ist deutscher Klartext."""


@dataclass(frozen=True)
class Issued:
    """Ein ausgestelltes Zertifikat samt dem der CA, beides PEM."""

    certificate_pem: str
    ca_pem: str
    not_after: datetime  # UTC
    serial: str  # Seriennummer, hex


@dataclass(frozen=True)
class _Ca:
    certificate: x509.Certificate
    key: ec.EllipticCurvePrivateKey | rsa.RSAPrivateKey
    pem: str


# --- Name Constraints ----------------------------------------------------------------------------


def stowly_constraints() -> x509.NameConstraints:
    """Die Name Constraints einer neuen CA: erlaubt sind nur Heimnetz, Loopback und lokale Namen."""
    networks = [x509.IPAddress(ipaddress.ip_network(net)) for net in (*HOME_NETWORKS, *LOOPBACK_NETWORKS)]
    names = [x509.DNSName(name) for name in PERMITTED_NAMES]
    return x509.NameConstraints(permitted_subtrees=networks + names, excluded_subtrees=None)


def _general_name(address: str) -> x509.GeneralName:
    try:
        return x509.IPAddress(ipaddress.ip_address(address))
    except ValueError:
        return x509.DNSName(address)


def _dns_within(name: str, base: str) -> bool:
    """Gehört ``name`` unter ``base`` (RFC 5280: links dürfen Labels dazukommen)?"""
    name, base = name.lower().rstrip("."), base.lower()
    if base.startswith("."):
        return name.endswith(base)
    return name == base or name.endswith("." + base)


def _matches(general: x509.GeneralName, subtree: x509.GeneralName) -> bool:
    if isinstance(general, x509.IPAddress) and isinstance(subtree, x509.IPAddress):
        network = subtree.value
        address = general.value
        return (
            isinstance(network, ipaddress.IPv4Network | ipaddress.IPv6Network)
            and isinstance(address, ipaddress.IPv4Address | ipaddress.IPv6Address)
            and address.version == network.version
            and address in network
        )
    if isinstance(general, x509.DNSName) and isinstance(subtree, x509.DNSName):
        return _dns_within(general.value, subtree.value)
    return False


def constraints_permit(constraints: x509.NameConstraints | None, address: str) -> bool:
    """Deckt eine CA mit diesen Name Constraints die Adresse (IP oder Name)? Ohne Constraints: ja.

    Wie RFC 5280: Gibt es erlaubte Teilbäume derselben Art (IP oder Name), muss die Adresse in einem
    davon liegen; in keinem ausgeschlossenen darf sie liegen.
    """
    if constraints is None:
        return True
    general = _general_name(address)
    kind = type(general)
    excluded = [tree for tree in constraints.excluded_subtrees or () if isinstance(tree, kind)]
    if any(_matches(general, tree) for tree in excluded):
        return False
    permitted = [tree for tree in constraints.permitted_subtrees or () if isinstance(tree, kind)]
    return not permitted or any(_matches(general, tree) for tree in permitted)


# --- Hilfen ------------------------------------------------------------------------------------


def fingerprint(certificate: x509.Certificate) -> str:
    """SHA-256 des Zertifikats, Großbuchstaben mit Doppelpunkten (AB:CD:…)."""
    return certificate.fingerprint(hashes.SHA256()).hex(":").upper()


def _common_name(certificate: x509.Certificate) -> str:
    names = certificate.subject.get_attributes_for_oid(NameOID.COMMON_NAME)
    if names and isinstance(names[0].value, str):
        return names[0].value
    return certificate.subject.rfc4514_string()


def _name_constraints(certificate: x509.Certificate) -> x509.NameConstraints | None:
    try:
        return certificate.extensions.get_extension_for_class(x509.NameConstraints).value
    except x509.ExtensionNotFound:
        return None


def _serial() -> int:
    """Zufällige Seriennummer mit 128 Bit, nie 0."""
    return int.from_bytes(secrets.token_bytes(16), "big") or 1


def _key_problem(key: Any) -> str | None:
    """Taugt der Schlüssel einer CA? P-256, P-384 oder RSA ab 2048 Bit."""
    if isinstance(key, ec.EllipticCurvePrivateKey):
        return None if isinstance(key.curve, ec.SECP256R1 | ec.SECP384R1) else "keine Kurve P-256 oder P-384"
    if isinstance(key, rsa.RSAPrivateKey):
        return None if key.key_size >= 2048 else f"RSA mit nur {key.key_size} Bit"
    return "weder EC (P-256, P-384) noch RSA"


def _public_bytes(key: Any) -> bytes:
    return key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)


def _sans(certificate: x509.Certificate) -> list[str]:
    """Die Adressen (SAN) eines Zertifikats als Text, IPs in ihrer kurzen Form, Namen klein."""
    try:
        extension = certificate.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    except x509.ExtensionNotFound:
        return []
    result: list[str] = []
    for general in extension:
        if isinstance(general, x509.IPAddress):
            result.append(str(general.value))
        elif isinstance(general, x509.DNSName):
            result.append(general.value.lower())
    return result


def _write(directory: Path, name: str, data: bytes, mode: int) -> None:
    """Schreibt atomar (``safefile.write_atomic``): Zwischendatei, ``fsync``, ``os.replace``."""
    safefile.write_atomic(directory, name, data, mode)


def _ensure_mode(path: Path, mode: int) -> None:
    """Nur unter POSIX: setzt die Rechte, wenn sie anders sind (etwa bei einer von Hand gelegten Datei)."""
    safefile.ensure_mode(path, mode, label="TLS")


# --- Der Manager -------------------------------------------------------------------------------


class TlsManager:
    """CA und Zertifikat des HTTPS-Listeners; liegt während des Betriebs in ``app.state.tls``.

    Der Konstruktor fasst keine Datei an (``build_app``); ``prepare`` lädt oder erzeugt beim Start.
    ``clock`` ersetzt in Tests die Uhr. Alles ist threadsicher: Endpunkte rufen aus dem Threadpool.
    """

    def __init__(self, settings: Settings, *, clock: Callable[[], datetime] | None = None) -> None:
        self.settings = settings
        self._now = clock or (lambda: datetime.now(UTC))
        self._lock = threading.RLock()
        self._ca: _Ca | None = None
        self._ca_problem: str | None = "Die CA ist noch nicht geladen."
        self._cert: x509.Certificate | None = None
        self._cert_problem: str | None = None
        self._context: ssl.SSLContext | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._listening = False
        self._listener_problem: str | None = None

    # ------------------------------------------------------------------ Eigenschaften

    @property
    def directory(self) -> Path:
        return self.settings.tls_dir

    @property
    def https(self) -> bool:
        """Stowly hat einen HTTPS-Listener (``STOWLY_HTTPS_PORT``)."""
        return self.settings.https_port is not None

    @property
    def problem(self) -> str | None:
        """Warum HTTPS nicht läuft oder kein brauchbares Zertifikat hat; sonst ``None``."""
        with self._lock:
            if self._ca_problem is not None:
                return self._ca_problem
            if not self.https:
                return None
            return self._cert_problem or self._listener_problem

    @property
    def certificate(self) -> x509.Certificate | None:
        """Das aktuelle Zertifikat des Servers; ``None`` ohne HTTPS oder ohne CA."""
        return self._cert

    def ca_pem(self) -> str | None:
        with self._lock:
            return None if self._ca is None else self._ca.pem

    def ca_der(self) -> bytes | None:
        """Das Zertifikat der CA als DER (``GET /api/setup/ca.crt``); ``None`` ohne nutzbare CA."""
        with self._lock:
            return None if self._ca is None else self._ca.certificate.public_bytes(serialization.Encoding.DER)

    def covers(self, address: str) -> bool:
        """Deckt die CA diese Adresse? Ohne nutzbare CA gelten die Name Constraints einer neuen."""
        with self._lock:
            constraints = (
                stowly_constraints() if self._ca is None else _name_constraints(self._ca.certificate)
            )
        return constraints_permit(constraints, address)

    # ------------------------------------------------------------------ Start

    def prepare(self, addresses: Sequence[str] = ()) -> None:
        """Beim Start: Ordner, CA laden oder anlegen, mit HTTPS das Zertifikat des Servers. Scheitert etwas,
        steht es in ``problem``; der Server startet trotzdem (nur eben ohne HTTPS)."""
        with self._lock:
            try:
                self._prepare_directory()
            except OSError as exc:
                self._ca_problem = (
                    f"Der Ordner tls/ im Datenverzeichnis lässt sich nicht anlegen ({exc.strerror})."
                )
                log.error("TLS: %s", self._ca_problem)
                return
            self._load_or_create_ca()
            if self.https and self._ca is not None:
                self._load_certificate()
                self.ensure(addresses)

    def _prepare_directory(self) -> None:
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        _ensure_mode(self.directory, 0o700)

    def _load_or_create_ca(self) -> None:
        cert_path, key_path = self.directory / CA_CERT, self.directory / CA_KEY
        have_cert, have_key = cert_path.exists(), key_path.exists()
        if not have_cert and not have_key:
            self._create_ca()
            return
        if not (have_cert and have_key):
            missing, present = (CA_KEY, CA_CERT) if have_cert else (CA_CERT, CA_KEY)
            self._refuse(
                f"In tls/ fehlt {missing}, {present} liegt da. Stowly überschreibt nichts: die fehlende Datei "
                "zurücklegen oder beide entfernen (dann entsteht eine neue CA, und jedes Gerät muss ihr neu "
                "vertrauen)."
            )
            return
        try:
            cert_data, key_data = cert_path.read_bytes(), key_path.read_bytes()
        except OSError as exc:
            self._refuse(f"Die CA in tls/ lässt sich nicht lesen ({exc.strerror}).")
            return
        problem, ca = self._check_ca(cert_data, key_data)
        if ca is None:
            self._refuse(f"Die CA in tls/ taugt nicht: {problem} Stowly überschreibt nichts.")
            return
        _ensure_mode(cert_path, 0o644)
        _ensure_mode(key_path, 0o600)
        self._ca, self._ca_problem = ca, None
        log.info(
            "TLS: CA geladen: %s, gültig bis %s, SHA-256 %s",
            _common_name(ca.certificate),
            ca.certificate.not_valid_after_utc.date().isoformat(),
            fingerprint(ca.certificate),
        )

    def _refuse(self, problem: str) -> None:
        self._ca, self._ca_problem = None, problem
        log.error("TLS: %s", problem)

    def _check_ca(self, cert_data: bytes, key_data: bytes) -> tuple[str | None, _Ca | None]:
        """Prüft eine vorhandene CA; liefert ``(problem, None)`` oder ``(None, ca)``."""
        try:
            certificate = x509.load_pem_x509_certificate(cert_data)
        except ValueError:
            return "ca.crt ist kein Zertifikat im Format PEM.", None
        try:
            key = serialization.load_pem_private_key(key_data, password=None)
        except TypeError:
            return "ca.key ist mit einem Kennwort verschlüsselt; Stowly braucht ihn ohne.", None
        except (ValueError, UnsupportedAlgorithm):
            return "ca.key ist kein Schlüssel im Format PEM.", None
        if certificate.subject != certificate.issuer:
            return "ca.crt ist nicht selbst signiert.", None
        try:
            certificate.verify_directly_issued_by(certificate)
        except (ValueError, TypeError, InvalidSignature):
            return "ca.crt ist nicht selbst signiert.", None
        try:
            basic = certificate.extensions.get_extension_for_class(x509.BasicConstraints).value
        except x509.ExtensionNotFound:
            basic = None
        if basic is None or not basic.ca:
            return "ca.crt ist keine Zertifizierungsstelle (basicConstraints CA:true fehlt).", None
        try:
            usage = certificate.extensions.get_extension_for_class(x509.KeyUsage).value
        except x509.ExtensionNotFound:
            usage = None
        if usage is None or not usage.key_cert_sign:
            return "ca.crt darf keine Zertifikate ausstellen (keyUsage keyCertSign fehlt).", None
        problem = _key_problem(key)
        if problem is not None:
            return f"Der Schlüssel in ca.key taugt nicht: {problem}.", None
        if _public_bytes(key.public_key()) != _public_bytes(certificate.public_key()):
            return "ca.key passt nicht zu ca.crt.", None
        until = certificate.not_valid_after_utc
        if until - self._now() < timedelta(days=CA_MIN_DAYS):
            return (
                f"ca.crt gilt nur noch bis {until.date().isoformat()}; Stowly braucht noch mindestens "
                f"{CA_MIN_DAYS} Tage.",
                None,
            )
        assert isinstance(key, ec.EllipticCurvePrivateKey | rsa.RSAPrivateKey)
        return None, _Ca(
            certificate, key, certificate.public_bytes(serialization.Encoding.PEM).decode("ascii")
        )

    def _create_ca(self) -> None:
        key = ec.generate_private_key(ec.SECP256R1())
        now = self._now()
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, f"{CA_NAME} {secrets.token_hex(3)}")])
        certificate = (
            x509.CertificateBuilder()
            .subject_name(name)
            .issuer_name(name)
            .public_key(key.public_key())
            .serial_number(_serial())
            .not_valid_before(now - BACKDATE)
            .not_valid_after(now + timedelta(days=CA_DAYS))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(
                x509.KeyUsage(
                    digital_signature=False,
                    content_commitment=False,
                    key_encipherment=False,
                    data_encipherment=False,
                    key_agreement=False,
                    key_cert_sign=True,
                    crl_sign=True,
                    encipher_only=False,
                    decipher_only=False,
                ),
                critical=True,
            )
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
            .add_extension(stowly_constraints(), critical=False)
            .sign(key, hashes.SHA256())
        )
        key_pem = key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
        )
        cert_pem = certificate.public_bytes(serialization.Encoding.PEM)
        try:
            _write(self.directory, CA_KEY, key_pem, 0o600)
            _write(self.directory, CA_CERT, cert_pem, 0o644)
        except OSError as exc:
            self._refuse(f"Die neue CA ließ sich nicht in tls/ schreiben ({exc.strerror}).")
            return
        self._ca, self._ca_problem = _Ca(certificate, key, cert_pem.decode("ascii")), None
        log.info(
            "TLS: neue CA angelegt: %s, gültig bis %s, SHA-256 %s",
            _common_name(certificate),
            certificate.not_valid_after_utc.date().isoformat(),
            fingerprint(certificate),
        )

    # ------------------------------------------------------------------ Zertifikat des Servers

    def _load_certificate(self) -> None:
        """Liest ``server.pem``, wenn es zur CA passt; sonst bleibt es offen, und ``ensure`` stellt neu aus."""
        path = self.directory / SERVER_PEM
        try:
            data = path.read_bytes()
        except FileNotFoundError:
            return
        except OSError:
            log.warning("TLS: server.pem lässt sich nicht lesen; es gibt ein neues.", exc_info=True)
            return
        try:
            key = serialization.load_pem_private_key(data, password=None)
            certificate = x509.load_pem_x509_certificates(data)[0]
        except (TypeError, ValueError, IndexError, UnsupportedAlgorithm):
            log.warning("TLS: server.pem ist unbrauchbar; es gibt ein neues.")
            return
        if _public_bytes(key.public_key()) != _public_bytes(certificate.public_key()):
            log.warning("TLS: Schlüssel und Zertifikat in server.pem passen nicht; es gibt ein neues.")
            return
        _ensure_mode(path, 0o600)
        self._cert = certificate

    def desired_addresses(self, addresses: Sequence[str]) -> list[str]:
        """Was ins Zertifikat kommt: die Adressen, die die CA deckt, ohne Doppelte; sonst vorläufig
        ``localhost`` und ``127.0.0.1``."""
        result: list[str] = []
        for address in addresses:
            if address not in result and self.covers(address):
                result.append(address)
        return result or list(PROVISIONAL)

    def _renewal_reason(self, wanted: list[str]) -> str | None:
        """Warum das Zertifikat neu muss; ``None``, wenn es so bleiben kann."""
        assert self._ca is not None
        certificate = self._cert
        if certificate is None:
            return "es gibt noch keins"
        try:
            certificate.verify_directly_issued_by(self._ca.certificate)
        except (ValueError, TypeError, InvalidSignature):
            return "die CA ist eine andere"
        if sorted(_sans(certificate)) != sorted(wanted):
            return "die Adressen haben sich geändert"
        if certificate.not_valid_after_utc - self._now() < timedelta(days=SERVER_CERT_RENEW_DAYS):
            return f"es gilt nur noch {SERVER_CERT_RENEW_DAYS} Tage oder weniger"
        return None

    def ensure(self, addresses: Sequence[str]) -> bool:
        """Stellt das Zertifikat des Servers neu aus, wenn nötig, und lädt es in den Listener; liefert, ob
        ein neues entstand. Ohne HTTPS oder ohne CA geschieht nichts."""
        with self._lock:
            if not self.https or self._ca is None:
                return False
            wanted = self.desired_addresses(addresses)
            reason = self._renewal_reason(wanted)
            if reason is None:
                return False
            try:
                self._issue_server_certificate(wanted)
            except OSError as exc:
                self._cert_problem = f"Das Zertifikat ließ sich nicht in tls/ schreiben ({exc.strerror})."
                log.error("TLS: %s", self._cert_problem)
                return False
            self._cert_problem = None
            assert self._cert is not None
            log.info(
                "TLS: neues Zertifikat des Servers (%s) für %s, gültig bis %s",
                reason,
                ", ".join(wanted),
                self._cert.not_valid_after_utc.date().isoformat(),
            )
        self.reload()
        return True

    def _issue_server_certificate(self, sans: list[str]) -> None:
        assert self._ca is not None
        key = ec.generate_private_key(ec.SECP256R1())
        certificate = self._build(
            key.public_key(), sans, days=SERVER_CERT_DAYS, common_name=SERVER_NAME, key_encipherment=False
        )
        data = key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
        ) + certificate.public_bytes(serialization.Encoding.PEM)
        _write(self.directory, SERVER_PEM, data, 0o600)
        self._cert = certificate

    def _build(
        self,
        public_key: Any,
        sans: Sequence[str],
        *,
        days: int,
        common_name: str,
        key_encipherment: bool,
    ) -> x509.Certificate:
        """Ein Zertifikat für einen Server im Heimnetz, signiert von der CA; nie über ihr Ende hinaus."""
        assert self._ca is not None
        ca = self._ca
        now = self._now()
        not_after = min(now + timedelta(days=days), ca.certificate.not_valid_after_utc)
        names = [_general_name(address) for address in sans]
        try:
            authority = x509.AuthorityKeyIdentifier.from_issuer_subject_key_identifier(
                ca.certificate.extensions.get_extension_for_class(x509.SubjectKeyIdentifier).value
            )
        except x509.ExtensionNotFound:
            authority = x509.AuthorityKeyIdentifier.from_issuer_public_key(ca.key.public_key())
        return (
            x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)]))
            .issuer_name(ca.certificate.subject)
            .public_key(public_key)
            .serial_number(_serial())
            .not_valid_before(now - BACKDATE)
            .not_valid_after(not_after)
            .add_extension(x509.SubjectAlternativeName(names), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(
                x509.KeyUsage(
                    digital_signature=True,
                    content_commitment=False,
                    key_encipherment=key_encipherment,
                    data_encipherment=False,
                    key_agreement=False,
                    key_cert_sign=False,
                    crl_sign=False,
                    encipher_only=False,
                    decipher_only=False,
                ),
                critical=True,
            )
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(public_key), critical=False)
            .add_extension(authority, critical=False)
            .sign(ca.key, hashes.SHA256())
        )

    # ------------------------------------------------------------------ Koppeln eines Pi

    def sign_csr(
        self,
        csr_pem: str,
        *,
        ips: Sequence[str],
        dns: Sequence[str],
        days: int = PI_CERT_DAYS,
    ) -> Issued:
        """Signiert den Antrag eines Geräts im Heimnetz (des Pi).

        Das Zertifikat gilt genau für ``ips`` und ``dns`` (SAN), mit EKU serverAuth, ``days`` Tage
        lang, nie über das Ende der CA hinaus. Geprüft werden die Signatur des Antrags und sein
        Schlüssel (P-256 oder RSA ab 2048 Bit); Betreff und Erweiterungen des Antrags zählen nicht.
        Threadsicher; darf aus dem Threadpool gerufen werden.

        Raises:
            CsrRejected: Der Antrag taugt nicht.
            CaUnavailable: Es gibt keine nutzbare CA.
        """
        try:
            request = x509.load_pem_x509_csr(csr_pem.encode("ascii", "strict"))
        except (ValueError, UnicodeEncodeError):
            raise CsrRejected("Der Antrag ist kein Zertifikatsantrag im Format PEM.") from None
        try:
            signed = request.is_signature_valid
            public_key = request.public_key()
        except (ValueError, UnsupportedAlgorithm):
            raise CsrRejected("Der Antrag lässt sich nicht lesen.") from None
        if not signed:
            raise CsrRejected("Die Signatur des Antrags stimmt nicht.")
        if isinstance(public_key, ec.EllipticCurvePublicKey):
            if not isinstance(public_key.curve, ec.SECP256R1):
                raise CsrRejected("Der Schlüssel des Antrags ist EC, aber nicht P-256.")
            encipherment = False
        elif isinstance(public_key, rsa.RSAPublicKey):
            if public_key.key_size < 2048:
                raise CsrRejected(f"Der Schlüssel des Antrags ist RSA mit nur {public_key.key_size} Bit.")
            encipherment = True
        else:
            raise CsrRejected("Der Schlüssel des Antrags ist weder P-256 noch RSA ab 2048 Bit.")
        sans = [str(ipaddress.ip_address(ip)) for ip in ips] + [name.lower() for name in dns]
        if not sans:
            raise ValueError("Ohne Adresse lässt sich kein Zertifikat ausstellen.")
        if days < 1:
            raise ValueError("Ein Zertifikat gilt mindestens einen Tag.")
        with self._lock:
            if self._ca is None:
                raise CaUnavailable(self._ca_problem or "Es gibt keine nutzbare CA.")
            certificate = self._build(
                public_key, sans, days=days, common_name=DEVICE_NAME, key_encipherment=encipherment
            )
            ca_pem = self._ca.pem
        log.info(
            "TLS: Zertifikat für %s ausgestellt, gültig bis %s, Seriennummer %x",
            ", ".join(sans),
            certificate.not_valid_after_utc.date().isoformat(),
            certificate.serial_number,
        )
        return Issued(
            certificate_pem=certificate.public_bytes(serialization.Encoding.PEM).decode("ascii"),
            ca_pem=ca_pem,
            not_after=certificate.not_valid_after_utc,
            serial=format(certificate.serial_number, "x"),
        )

    # ------------------------------------------------------------------ Der Listener

    @staticmethod
    def _new_context() -> ssl.SSLContext:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.set_alpn_protocols(["http/1.1"])
        return context

    def context(self) -> ssl.SSLContext:
        """Der SSL-Kontext des HTTPS-Listeners (uvicorn ``ssl_context_factory``); immer derselbe, ein neues
        Zertifikat kommt über ``reload`` hinein. ``CaUnavailable`` ohne brauchbares Zertifikat."""
        with self._lock:
            if self._context is None:
                if self._cert is None:
                    raise CaUnavailable(self.problem or "Es gibt kein Zertifikat für den HTTPS-Listener.")
                context = self._new_context()
                context.load_cert_chain(self.directory / SERVER_PEM)
                self._context = context
            return self._context

    def reload(self) -> None:
        """Lädt ``server.pem`` in den Kontext des Listeners, für neue Verbindungen.

        Erst eine Probe in einem eigenen Kontext; dann der Wechsel in der Ereignisschleife des Listeners
        (``call_soon_threadsafe``), wo auch die Handshakes laufen. Darf aus jedem Thread gerufen werden.
        """
        with self._lock:
            context, loop = self._context, self._loop
        if context is None:
            return  # Noch kein Listener: Sein Kontext entsteht gleich mit dem neuen Zertifikat.
        path = self.directory / SERVER_PEM
        try:
            self._new_context().load_cert_chain(path)
        except (OSError, ssl.SSLError) as exc:
            with self._lock:
                self._cert_problem = (
                    "Das neue Zertifikat lässt sich nicht laden; der Listener behält das alte."
                )
            log.error("TLS: %s (%s)", self._cert_problem, exc)
            return
        if loop is None or loop.is_closed():
            self._apply(context, path)
        else:
            loop.call_soon_threadsafe(self._apply, context, path)

    def _apply(self, context: ssl.SSLContext, path: Path) -> None:
        try:
            context.load_cert_chain(path)
        except (OSError, ssl.SSLError):
            log.exception("TLS: Das neue Zertifikat ließ sich nicht in den Listener laden.")
        else:
            log.info("TLS: Der Listener nimmt ab jetzt das neue Zertifikat.")

    def attach(self, loop: asyncio.AbstractEventLoop) -> None:
        """Ab jetzt laufen Wechsel des Zertifikats in dieser Ereignisschleife (die der Listener)."""
        with self._lock:
            self._loop = loop

    def detach(self) -> None:
        """Die Listener sind beendet."""
        with self._lock:
            self._loop = None
            self._listening = False

    def started(self) -> None:
        """Der HTTPS-Listener läuft."""
        with self._lock:
            self._listening, self._listener_problem = True, None

    def stopped(self) -> None:
        """Der HTTPS-Listener ist beendet."""
        with self._lock:
            self._listening = False

    def failed(self, problem: str) -> None:
        """Der HTTPS-Listener läuft nicht (Port belegt, Zertifikat unbrauchbar); HTTP läuft weiter."""
        with self._lock:
            self._listening, self._listener_problem = False, problem
        log.error("TLS: %s", problem)

    # ------------------------------------------------------------------ Zustand

    def info(self) -> dict[str, Any]:
        """Für ``HttpsStatus``: ``enabled``, ``listening``, ``problem``, ``ca`` und ``certificate``."""
        with self._lock:
            ca = None
            if self._ca is not None:
                certificate = self._ca.certificate
                ca = {
                    "name": _common_name(certificate),
                    "fingerprint_sha256": fingerprint(certificate),
                    "not_after": format_timestamp(certificate.not_valid_after_utc),
                    "created_by_stowly": _STOWLY_CA.fullmatch(_common_name(certificate)) is not None,
                    "name_constraints": _name_constraints(certificate) is not None,
                }
            current = self._cert if self.https and self._ca is not None else None
            return {
                "enabled": self.https,
                "listening": self._listening,
                "problem": self.problem,
                "ca": ca,
                "certificate": None
                if current is None
                else {
                    "addresses": _sans(current),
                    "not_after": format_timestamp(current.not_valid_after_utc),
                },
            }


# --- Der tägliche Job --------------------------------------------------------------------------


class TlsRenewJob:
    """Aufgabe ``tls_renew`` des Zeitplans (nur mit HTTPS): einmal am Tag prüfen, ob das Zertifikat des
    Servers neu muss (weniger als ``SERVER_CERT_RENEW_DAYS`` Tage Rest, andere Adressen, andere CA).

    ``addresses`` liefert die Adressen aus der Datenbank (``wizard.certificate_addresses``).
    """

    name = "tls_renew"

    def __init__(
        self, settings: Settings, manager: TlsManager, addresses: Callable[[], Sequence[str]]
    ) -> None:
        self.settings = settings
        self._manager = manager
        self._addresses = addresses

    def due(self, run: scheduler.JobRun, now: datetime) -> bool:
        return not scheduler.ran_today(run, now, self.settings.tz)

    def run(self, now: datetime) -> None:
        renewed = self._manager.ensure(self._addresses())
        certificate = self._manager.certificate
        con = db.connect(self.settings.database_path)
        try:
            scheduler.record_success(
                con,
                self.name,
                day=localtime.today(now, self.settings.tz).isoformat(),
                at=format_timestamp(now),
                state={
                    "renewed": renewed,
                    "not_after": None
                    if certificate is None
                    else format_timestamp(certificate.not_valid_after_utc),
                },
            )
        finally:
            con.close()
