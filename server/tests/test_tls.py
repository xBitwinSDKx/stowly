"""HTTPS mit eigener CA (docs/integrationen.md, Abschnitt 11; stowly/tls.py).

Geprüft werden die Felder von CA und Zertifikaten, jede Adresse mit ``cryptography.x509.verification``
und die Name Constraints mit einem echten Handshake von OpenSSL: Ein Zertifikat, das an ``sign_csr``
vorbei für eine Adresse im Internet signiert wurde, lehnt der Client ab.
"""

import asyncio
import ipaddress
import os
import re
import ssl
import stat
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.x509 import verification
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from fastapi.testclient import TestClient

from stowly import db, scheduler, tls
from stowly.app import create_app
from stowly.config import Settings
from stowly.contract.api import PI_CERT_DAYS, SERVER_CERT_DAYS
from stowly.contract.timeutil import format_timestamp

START = datetime(2026, 11, 16, 9, 0, tzinfo=UTC)
HOME = [
    "192.168.1.10",
    "nas.local",
    "fd00::10",
    "stowly.fritz.box",
    "10.0.0.2",
    "100.64.1.1",
    "nas.home.arpa",
]
POSIX = os.name == "posix"
# basicConstraints einer CA wie aus pi/make-cert.sh: CA:true, pathlen:0
CA_BASIC = x509.BasicConstraints(ca=True, path_length=0)


class Clock:
    def __init__(self) -> None:
        self.value = START

    def __call__(self) -> datetime:
        return self.value


def make_settings(tmp_path: Path, *, https: bool = True) -> Settings:
    env = {"STOWLY_DATA_DIR": str(tmp_path / "data")}
    if https:
        env["STOWLY_HTTPS_PORT"] = "8443"
    return Settings.from_env(env, dev=False)


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def settings_https(tmp_path) -> Settings:
    return make_settings(tmp_path)


def manager_for(settings: Settings, clock: Clock, addresses: list[str] | None = None) -> tls.TlsManager:
    manager = tls.TlsManager(settings, clock=clock)
    manager.prepare(addresses or [])
    return manager


@pytest.fixture
def manager(settings_https, clock) -> tls.TlsManager:
    return manager_for(settings_https, clock)


def ca_of(settings: Settings) -> x509.Certificate:
    return x509.load_pem_x509_certificate((settings.tls_dir / "ca.crt").read_bytes())


def ca_key_of(settings: Settings):
    return serialization.load_pem_private_key((settings.tls_dir / "ca.key").read_bytes(), password=None)


def server_of(settings: Settings) -> tuple[object, x509.Certificate]:
    data = (settings.tls_dir / "server.pem").read_bytes()
    return serialization.load_pem_private_key(data, password=None), x509.load_pem_x509_certificate(data)


def files(settings: Settings) -> dict[str, bytes]:
    return {path.name: path.read_bytes() for path in sorted(settings.tls_dir.iterdir())}


def extension(certificate: x509.Certificate, kind):
    return certificate.extensions.get_extension_for_class(kind)


def subject_of(address: str):
    try:
        return verification.IPAddress(ipaddress.ip_address(address))
    except ValueError:
        return verification.DNSName(address)


def verify(ca: x509.Certificate, leaf: x509.Certificate, address: str, at: datetime) -> None:
    """Wie ein Browser: Kette zur CA, Adresse in der SAN, Name Constraints, EKU serverAuth."""
    verifier = (
        verification.PolicyBuilder()
        .store(verification.Store([ca]))
        .time(at)
        .build_server_verifier(subject_of(address))
    )
    verifier.verify(leaf, [])


def leaf_signed_by(
    ca: x509.Certificate, ca_key, sans: list[str], *, at: datetime = START
) -> tuple[object, x509.Certificate]:
    """Ein Zertifikat, an ``sign_csr`` vorbei mit dem Schlüssel der CA signiert (wie ein Dieb es täte)."""
    key = ec.generate_private_key(ec.SECP256R1())
    names = [tls._general_name(address) for address in sans]
    certificate = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Fremd")]))
        .issuer_name(ca.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(at - timedelta(hours=1))
        .not_valid_after(at + timedelta(days=30))
        .add_extension(x509.SubjectAlternativeName(names), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_subject_key_identifier(
                extension(ca, x509.SubjectKeyIdentifier).value
            ),
            critical=False,
        )
        .sign(ca_key, hashes.SHA256())
    )
    return key, certificate


def chain_file(path: Path, key, certificate: x509.Certificate) -> Path:
    path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
        )
        + certificate.public_bytes(serialization.Encoding.PEM)
    )
    return path


def handshake(ca: x509.Certificate, chain: Path, host: str) -> dict:
    """Ein TLS-Handshake mit OpenSSL im Speicher: der Client vertraut nur ``ca`` und prüft ``host``.
    Liefert das Zertifikat, das der Client gesehen hat; ``ssl.SSLError``, wenn er ablehnt."""
    server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_context.load_cert_chain(chain)
    client_context = ssl.create_default_context(cadata=ca.public_bytes(serialization.Encoding.PEM).decode())
    client_in, client_out, server_in, server_out = (ssl.MemoryBIO() for _ in range(4))
    client = client_context.wrap_bio(client_in, client_out, server_hostname=host)
    server = server_context.wrap_bio(server_in, server_out, server_side=True)
    done = {"client": False, "server": False}
    for _ in range(20):
        for name, side, outgoing, peer in (
            ("client", client, client_out, server_in),
            ("server", server, server_out, client_in),
        ):
            if not done[name]:
                try:
                    side.do_handshake()
                    done[name] = True
                except ssl.SSLWantReadError:
                    pass
            data = outgoing.read()
            if data:
                peer.write(data)
        if all(done.values()):
            return client.getpeercert()
    raise AssertionError("Der Handshake kam nicht zum Ende.")


# --- Eine CA wie aus pi/make-cert.sh und kaputte CAs -------------------------------------------------


def hand_ca(
    *,
    key=None,
    name: str = "Stowly Drucker-CA",
    days: int = 3650,
    basic: x509.BasicConstraints | None = CA_BASIC,
    cert_sign: bool = True,
    signer=None,
    issuer: str | None = None,
    at: datetime = START,
) -> tuple[bytes, bytes, object]:
    """Eine CA wie ``bash pi/make-cert.sh ca``: CN und O, basicConstraints und keyUsage kritisch, SKI, keine
    Name Constraints. Liefert ``(ca.crt, ca.key, schlüssel)`` als PEM."""
    key = key or ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, name),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Stowly"),
        ]
    )
    issuer_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, issuer)]) if issuer else subject
    builder = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer_name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(at - timedelta(days=1))
        .not_valid_after(at + timedelta(days=days))
        .add_extension(
            x509.KeyUsage(
                digital_signature=False,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=cert_sign,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
    )
    if basic is not None:
        builder = builder.add_extension(basic, critical=True)
    certificate = builder.sign(signer or key, hashes.SHA256())
    key_pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )
    return certificate.public_bytes(serialization.Encoding.PEM), key_pem, key


def place(settings: Settings, cert_pem: bytes | None, key_pem: bytes | None) -> None:
    settings.tls_dir.mkdir(parents=True, exist_ok=True)
    if cert_pem is not None:
        (settings.tls_dir / "ca.crt").write_bytes(cert_pem)
    if key_pem is not None:
        (settings.tls_dir / "ca.key").write_bytes(key_pem)


# --- Neue CA -------------------------------------------------------------------------------------


def test_a_new_ca_is_p256_for_ten_years_and_only_for_the_home_network(manager, settings_https):
    ca = ca_of(settings_https)
    key = ca_key_of(settings_https)
    assert isinstance(key, ec.EllipticCurvePrivateKey) and isinstance(key.curve, ec.SECP256R1)
    assert key.public_key().public_numbers() == ca.public_key().public_numbers()
    common_name = ca.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value
    assert re.fullmatch(r"Stowly CA [0-9a-f]{6}", common_name)
    assert ca.subject == ca.issuer
    ca.verify_directly_issued_by(ca)
    assert ca.not_valid_before_utc == START - timedelta(hours=1)
    assert ca.not_valid_after_utc == START + timedelta(days=3650)

    basic = extension(ca, x509.BasicConstraints)
    assert (basic.critical, basic.value.ca, basic.value.path_length) == (True, True, 0)
    usage = extension(ca, x509.KeyUsage)
    assert usage.critical
    assert (usage.value.key_cert_sign, usage.value.crl_sign, usage.value.digital_signature) == (
        True,
        True,
        False,
    )
    assert extension(ca, x509.SubjectKeyIdentifier).value == x509.SubjectKeyIdentifier.from_public_key(
        key.public_key()
    )

    constraints = extension(ca, x509.NameConstraints)
    assert constraints.critical is False  # Geräte ohne Unterstützung lehnen sonst ab
    assert constraints.value.excluded_subtrees is None
    assert set(constraints.value.permitted_subtrees) == {
        *(
            x509.IPAddress(ipaddress.ip_network(net))
            for net in (
                "10.0.0.0/8",
                "172.16.0.0/12",
                "192.168.0.0/16",
                "100.64.0.0/10",
                "fc00::/7",
                "127.0.0.0/8",
                "::1/128",
            )
        ),
        *(
            x509.DNSName(name)
            for name in (
                "local",
                "lan",
                "home",
                "home.arpa",
                "internal",
                "localdomain",
                "fritz.box",
                "localhost",
            )
        ),
    }

    info = manager.info()["ca"]
    assert info == {
        "name": common_name,
        "fingerprint_sha256": ca.fingerprint(hashes.SHA256()).hex(":").upper(),
        "not_after": format_timestamp(START + timedelta(days=3650)),
        "created_by_stowly": True,
        "name_constraints": True,
    }
    assert re.fullmatch(r"([0-9A-F]{2}:){31}[0-9A-F]{2}", info["fingerprint_sha256"])
    assert manager.ca_der() == ca.public_bytes(serialization.Encoding.DER)
    assert manager.problem is None


def test_the_server_certificate(manager, settings_https):
    ca = ca_of(settings_https)
    key, certificate = server_of(settings_https)
    assert isinstance(key, ec.EllipticCurvePrivateKey) and isinstance(key.curve, ec.SECP256R1)
    certificate.verify_directly_issued_by(ca)
    assert certificate.subject == x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Stowly")])
    assert certificate.not_valid_before_utc == START - timedelta(hours=1)
    assert (
        certificate.not_valid_after_utc
        == START + timedelta(days=SERVER_CERT_DAYS)
        == START + timedelta(days=397)
    )
    # Ohne bekannte Adresse vorläufig für localhost und 127.0.0.1.
    assert extension(certificate, x509.SubjectAlternativeName).value == x509.SubjectAlternativeName(
        [x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]
    )
    assert list(extension(certificate, x509.ExtendedKeyUsage).value) == [ExtendedKeyUsageOID.SERVER_AUTH]
    usage = extension(certificate, x509.KeyUsage)
    assert usage.critical and usage.value.digital_signature and not usage.value.key_encipherment
    assert not usage.value.key_cert_sign
    basic = extension(certificate, x509.BasicConstraints)
    assert basic.critical and basic.value.ca is False
    assert extension(
        certificate, x509.SubjectKeyIdentifier
    ).value == x509.SubjectKeyIdentifier.from_public_key(key.public_key())
    assert (
        extension(certificate, x509.AuthorityKeyIdentifier).value.key_identifier
        == extension(ca, x509.SubjectKeyIdentifier).value.digest
    )
    assert manager.info()["certificate"] == {
        "addresses": ["localhost", "127.0.0.1"],
        "not_after": format_timestamp(START + timedelta(days=397)),
    }
    for address in ("localhost", "127.0.0.1"):
        verify(ca, certificate, address, START)


def test_every_address_of_the_certificate_verifies(settings_https, clock):
    manager_for(settings_https, clock, HOME)
    ca = ca_of(settings_https)
    _key, certificate = server_of(settings_https)
    assert sorted(tls._sans(certificate)) == sorted(HOME)
    for address in HOME:
        verify(ca, certificate, address, START)
    # Was die CA nicht deckt, kommt nicht hinein.
    manager = manager_for(settings_https, clock, ["8.8.8.8", "evil.example", "192.168.1.10"])
    assert manager.info()["certificate"]["addresses"] == ["192.168.1.10"]


def test_the_name_constraints_stop_a_certificate_for_the_internet(settings_https, tmp_path):
    """Selbst mit dem Schlüssel der CA in der Hand taugt ein Zertifikat für 8.8.8.8 nicht.

    OpenSSL prüft beim Handshake gegen die echte Uhr; deshalb hier alles mit ihr.
    """
    tls.TlsManager(settings_https).prepare([])
    ca, ca_key, now = ca_of(settings_https), ca_key_of(settings_https), datetime.now(UTC)
    for address in ("8.8.8.8", "evil.example"):
        key, foreign = leaf_signed_by(ca, ca_key, [address], at=now)
        with pytest.raises(ssl.SSLCertVerificationError, match="permitted subtree violation"):
            handshake(ca, chain_file(tmp_path / "fremd.pem", key, foreign), address)
        with pytest.raises(verification.VerificationError):
            verify(ca, foreign, address, now)
    # Zur Probe: Im Heimnetz klappt derselbe Weg.
    key, local = leaf_signed_by(ca, ca_key, ["192.168.1.10"], at=now)
    seen = handshake(ca, chain_file(tmp_path / "heim.pem", key, local), "192.168.1.10")
    assert seen["subjectAltName"] == (("IP Address", "192.168.1.10"),)


def test_the_server_certificate_passes_a_real_handshake(settings_https):
    manager = tls.TlsManager(settings_https)  # die echte Uhr, wie beim Handshake
    manager.prepare(["192.168.1.10", "nas.local"])
    assert manager.ensure(["192.168.1.10", "nas.local", "stowly.lan"]) is True
    ca = ca_of(settings_https)
    for host in ("192.168.1.10", "nas.local", "stowly.lan"):
        handshake(ca, settings_https.tls_dir / "server.pem", host)
    with pytest.raises(ssl.SSLCertVerificationError):
        handshake(ca, settings_https.tls_dir / "server.pem", "10.9.9.9")


# --- Vorhandene CA -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "key",
    [
        pytest.param(lambda: ec.generate_private_key(ec.SECP256R1()), id="ec-p256"),
        pytest.param(lambda: ec.generate_private_key(ec.SECP384R1()), id="ec-p384"),
        pytest.param(lambda: rsa.generate_private_key(public_exponent=65537, key_size=2048), id="rsa-2048"),
    ],
)
def test_a_ca_like_make_cert_sh_is_taken_as_it_is(settings_https, clock, key):
    cert_pem, key_pem, _ = hand_ca(key=key())
    place(settings_https, cert_pem, key_pem)
    manager = manager_for(settings_https, clock, ["192.168.1.10"])
    assert manager.problem is None
    info = manager.info()["ca"]
    assert (info["name"], info["created_by_stowly"], info["name_constraints"]) == (
        "Stowly Drucker-CA",
        False,
        False,
    )
    # Ohne Name Constraints deckt sie alles; ins Zertifikat kommen trotzdem nur die Adressen des Heimnetzes.
    assert manager.covers("8.8.8.8")
    ca = x509.load_pem_x509_certificate(cert_pem)
    _key, certificate = server_of(settings_https)
    certificate.verify_directly_issued_by(ca)
    verify(ca, certificate, "192.168.1.10", START)
    assert (settings_https.tls_dir / "ca.crt").read_bytes() == cert_pem
    assert (settings_https.tls_dir / "ca.key").read_bytes() == key_pem


def _encrypted() -> tuple[bytes, bytes]:
    cert_pem, _key_pem, key = hand_ca()
    encrypted = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.BestAvailableEncryption(b"kennwort"),
    )
    return cert_pem, encrypted


def _wrong_key() -> tuple[bytes, bytes]:
    cert_pem, _key_pem, _ = hand_ca()
    _other_cert, other_key, _ = hand_ca()
    return cert_pem, other_key


def _foreign_issuer() -> tuple[bytes, bytes]:
    _parent_cert, _parent_key, parent = hand_ca(name="Andere CA")
    cert_pem, key_pem, _ = hand_ca(signer=parent, issuer="Andere CA")
    return cert_pem, key_pem


def _small_rsa() -> tuple[bytes, bytes]:
    cert_pem, key_pem, _ = hand_ca(key=rsa.generate_private_key(public_exponent=65537, key_size=1024))
    return cert_pem, key_pem


BROKEN: dict[str, tuple[Callable[[], tuple[bytes | None, bytes | None]], str]] = {
    "nur ca.crt": (lambda: (hand_ca()[0], None), "fehlt ca.key, ca.crt liegt da"),
    "nur ca.key": (lambda: (None, hand_ca()[1]), "fehlt ca.crt, ca.key liegt da"),
    "kein Zertifikat": (
        lambda: (b"kein Zertifikat", hand_ca()[1]),
        "ca.crt ist kein Zertifikat im Format PEM",
    ),
    "kein Schlüssel": (lambda: (hand_ca()[0], b"kein Schluessel"), "ca.key ist kein Schlüssel im Format PEM"),
    "verschlüsselt": (_encrypted, "verschlüsselt"),
    "falscher Schlüssel": (_wrong_key, "ca.key passt nicht zu ca.crt"),
    "keine CA": (
        lambda: hand_ca(basic=x509.BasicConstraints(ca=False, path_length=None))[:2],
        "keine Zertifizierungsstelle",
    ),
    "ohne basicConstraints": (lambda: hand_ca(basic=None)[:2], "keine Zertifizierungsstelle"),
    "ohne keyCertSign": (lambda: hand_ca(cert_sign=False)[:2], "keyCertSign fehlt"),
    "läuft bald ab": (lambda: hand_ca(days=29)[:2], "mindestens 30 Tage"),
    "RSA 1024": (_small_rsa, "RSA mit nur 1024 Bit"),
    "P-521": (
        lambda: hand_ca(key=ec.generate_private_key(ec.SECP521R1()))[:2],
        "keine Kurve P-256 oder P-384",
    ),
    "fremd signiert": (_foreign_issuer, "nicht selbst signiert"),
}


@pytest.mark.parametrize("case", list(BROKEN))
def test_a_ca_that_does_not_fit_is_reported_and_nothing_is_overwritten(settings_https, clock, case):
    make, problem = BROKEN[case]
    cert_pem, key_pem = make()
    place(settings_https, cert_pem, key_pem)
    before = files(settings_https)
    manager = manager_for(settings_https, clock, ["192.168.1.10"])
    assert problem in (manager.problem or ""), manager.problem
    assert "Stowly überschreibt nichts" in (manager.problem or "")
    assert str(settings_https.data_dir) not in (manager.problem or "")  # nie ein Pfad des Rechners
    assert files(settings_https) == before  # kein Byte geändert, kein server.pem
    info = manager.info()
    assert (info["ca"], info["certificate"], info["problem"]) == (None, None, manager.problem)
    assert manager.ca_der() is None
    with pytest.raises(tls.CaUnavailable):
        manager.context()
    with pytest.raises(tls.CaUnavailable):
        manager.sign_csr(csr(), ips=["192.168.1.50"], dns=[])
    # Gedeckt ist dann, was eine neue CA decken würde.
    assert manager.covers("192.168.1.10") and not manager.covers("8.8.8.8")


def test_a_ca_valid_for_exactly_30_days_is_taken(settings_https, clock):
    place(settings_https, *hand_ca(days=31)[:2])
    clock.value = START + timedelta(days=1)
    assert manager_for(settings_https, clock).problem is None


# --- Neu ausstellen ------------------------------------------------------------------------------


def serial(settings: Settings) -> int:
    return server_of(settings)[1].serial_number


def test_a_new_address_brings_a_new_certificate_the_same_ones_do_not(manager, settings_https):
    first = serial(settings_https)
    assert manager.ensure([]) is False
    assert serial(settings_https) == first
    assert manager.ensure(["192.168.1.10"]) is True
    assert serial(settings_https) != first
    assert tls._sans(server_of(settings_https)[1]) == ["192.168.1.10"]  # vorläufig nicht mehr nötig
    second = serial(settings_https)
    assert manager.ensure(["192.168.1.10"]) is False
    assert manager.ensure(["192.168.1.10", "192.168.1.10"]) is False
    assert serial(settings_https) == second
    assert manager.ensure(["nas.local", "192.168.1.10"]) is True
    assert sorted(tls._sans(server_of(settings_https)[1])) == ["192.168.1.10", "nas.local"]
    # Die Reihenfolge allein ist keine Änderung.
    assert manager.ensure(["192.168.1.10", "nas.local"]) is False


def test_60_days_before_the_end_a_new_one_comes(manager, settings_https, clock):
    first = serial(settings_https)
    clock.value = START + timedelta(days=SERVER_CERT_DAYS - 61)
    assert manager.ensure([]) is False
    clock.value = START + timedelta(days=SERVER_CERT_DAYS - 59)
    assert manager.ensure([]) is True
    certificate = server_of(settings_https)[1]
    assert certificate.serial_number != first
    assert certificate.not_valid_after_utc == clock.value + timedelta(days=SERVER_CERT_DAYS)


def test_a_new_ca_brings_a_new_certificate(manager, settings_https, clock):
    old = server_of(settings_https)[1]
    for name in ("ca.crt", "ca.key"):
        (settings_https.tls_dir / name).unlink()
    cert_pem, key_pem, _ = hand_ca()
    place(settings_https, cert_pem, key_pem)
    manager_for(settings_https, clock)
    new = server_of(settings_https)[1]
    assert new.serial_number != old.serial_number
    new.verify_directly_issued_by(x509.load_pem_x509_certificate(cert_pem))


def test_a_broken_server_pem_is_replaced(manager, settings_https, clock):
    (settings_https.tls_dir / "server.pem").write_bytes(b"kaputt")
    manager_for(settings_https, clock)
    server_of(settings_https)[1].verify_directly_issued_by(ca_of(settings_https))


def test_the_certificate_never_outlives_the_ca(settings_https, clock):
    place(settings_https, *hand_ca(days=100)[:2])
    manager = manager_for(settings_https, clock)
    ca = ca_of(settings_https)
    assert server_of(settings_https)[1].not_valid_after_utc == ca.not_valid_after_utc
    issued = manager.sign_csr(csr(), ips=["192.168.1.50"], dns=[])
    assert issued.not_after == ca.not_valid_after_utc


def test_without_https_there_is_a_ca_but_no_server_certificate(tmp_path, clock):
    settings = make_settings(tmp_path, https=False)
    manager = manager_for(settings, clock, ["192.168.1.10"])
    assert sorted(files(settings)) == ["ca.crt", "ca.key"]
    assert manager.ensure(["192.168.1.10"]) is False
    info = manager.info()
    assert (info["enabled"], info["listening"], info["problem"], info["certificate"]) == (
        False,
        False,
        None,
        None,
    )
    assert info["ca"] is not None


def test_nothing_is_left_behind_and_a_second_start_changes_nothing(manager, settings_https, clock):
    before = files(settings_https)
    assert not [name for name in before if name.endswith(".tmp")]
    manager_for(settings_https, clock)
    assert files(settings_https) == before


@pytest.mark.skipif(not POSIX, reason="Rechte gibt es nur unter POSIX")
def test_the_files_get_their_modes(settings_https, clock):
    manager_for(settings_https, clock)
    modes = {path.name: stat.S_IMODE(path.stat().st_mode) for path in settings_https.tls_dir.iterdir()}
    assert modes == {"ca.crt": 0o644, "ca.key": 0o600, "server.pem": 0o600}
    assert stat.S_IMODE(settings_https.tls_dir.stat().st_mode) == 0o700
    # Von Hand gelegte Dateien mit zu weiten Rechten bekommen sie beim Laden.
    os.chmod(settings_https.tls_dir / "ca.key", 0o644)
    os.chmod(settings_https.tls_dir, 0o755)
    manager_for(settings_https, clock)
    assert stat.S_IMODE((settings_https.tls_dir / "ca.key").stat().st_mode) == 0o600
    assert stat.S_IMODE(settings_https.tls_dir.stat().st_mode) == 0o700


# --- sign_csr ------------------------------------------------------------------------------------


def csr(key=None, *, sans: list[str] | None = None, ca: bool = False) -> str:
    """Ein Antrag wie vom Pi; Betreff und Erweiterungen wählt hier der „Pi" selbst."""
    key = key or ec.generate_private_key(ec.SECP256R1())
    builder = x509.CertificateSigningRequestBuilder().subject_name(
        x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "evil.example")])
    )
    if sans:
        builder = builder.add_extension(
            x509.SubjectAlternativeName([tls._general_name(s) for s in sans]), critical=False
        )
    if ca:
        builder = builder.add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
    return builder.sign(key, hashes.SHA256()).public_bytes(serialization.Encoding.PEM).decode()


def test_sign_csr_issues_exactly_what_the_server_says(manager, settings_https):
    request = csr(sans=["evil.example", "8.8.8.8"], ca=True)
    issued = manager.sign_csr(request, ips=["192.168.1.50", "10.71.83.1"], dns=["drucker.local"])
    certificate = x509.load_pem_x509_certificate(issued.certificate_pem.encode())
    ca = ca_of(settings_https)
    assert issued.ca_pem == (settings_https.tls_dir / "ca.crt").read_text()
    certificate.verify_directly_issued_by(ca)
    assert extension(certificate, x509.SubjectAlternativeName).value == x509.SubjectAlternativeName(
        [
            x509.IPAddress(ipaddress.ip_address("192.168.1.50")),
            x509.IPAddress(ipaddress.ip_address("10.71.83.1")),
            x509.DNSName("drucker.local"),
        ]
    )
    assert certificate.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value != "evil.example"
    assert extension(certificate, x509.BasicConstraints).value.ca is False
    assert list(extension(certificate, x509.ExtendedKeyUsage).value) == [ExtendedKeyUsageOID.SERVER_AUTH]
    usage = extension(certificate, x509.KeyUsage).value
    assert usage.digital_signature and not usage.key_encipherment
    assert certificate.not_valid_after_utc == START + timedelta(days=PI_CERT_DAYS)
    assert issued.not_after == certificate.not_valid_after_utc
    assert issued.serial == format(certificate.serial_number, "x")
    assert 0 < certificate.serial_number < 2**128
    for address in ("192.168.1.50", "10.71.83.1", "drucker.local"):
        verify(ca, certificate, address, START)
    with pytest.raises(verification.VerificationError):
        verify(ca, certificate, "evil.example", START)


def test_sign_csr_takes_rsa_from_2048_bits(manager):
    issued = manager.sign_csr(
        csr(rsa.generate_private_key(public_exponent=65537, key_size=2048)),
        ips=["192.168.1.50"],
        dns=[],
        days=30,
    )
    certificate = x509.load_pem_x509_certificate(issued.certificate_pem.encode())
    usage = extension(certificate, x509.KeyUsage).value
    assert usage.digital_signature and usage.key_encipherment
    assert certificate.not_valid_after_utc == START + timedelta(days=30)


def _tampered() -> str:
    der = bytearray(x509.load_pem_x509_csr(csr().encode()).public_bytes(serialization.Encoding.DER))
    der[-3] ^= 0x01  # ein Bit in der Signatur
    return x509.load_der_x509_csr(bytes(der)).public_bytes(serialization.Encoding.PEM).decode()


@pytest.mark.parametrize(
    ("request_pem", "message"),
    [
        pytest.param(
            lambda: csr(rsa.generate_private_key(public_exponent=65537, key_size=1024)),
            "1024 Bit",
            id="rsa-1024",
        ),
        pytest.param(lambda: csr(ec.generate_private_key(ec.SECP384R1())), "nicht P-256", id="p384"),
        pytest.param(_tampered, "Signatur", id="signatur"),
        pytest.param(lambda: "kein Antrag", "PEM", id="kein-pem"),
        pytest.param(
            lambda: "-----BEGIN CERTIFICATE REQUEST-----\nÄÖÜ\n-----END CERTIFICATE REQUEST-----",
            "PEM",
            id="umlaute",
        ),
    ],
)
def test_sign_csr_refuses_what_does_not_fit(manager, request_pem, message):
    with pytest.raises(tls.CsrRejected, match=message):
        manager.sign_csr(request_pem(), ips=["192.168.1.50"], dns=[])


def test_sign_csr_is_thread_safe(manager):
    requests = [csr() for _ in range(8)]
    results: list[tls.Issued] = []
    barrier = threading.Barrier(len(requests))

    def sign(request: str) -> None:
        barrier.wait()
        results.append(manager.sign_csr(request, ips=["192.168.1.50"], dns=["drucker.local"]))

    threads = [threading.Thread(target=sign, args=(request,)) for request in requests]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    assert len({issued.serial for issued in results}) == len(requests)


def test_sign_csr_without_a_prepared_ca(settings_https):
    with pytest.raises(tls.CaUnavailable):
        tls.TlsManager(settings_https).sign_csr(csr(), ips=["192.168.1.50"], dns=[])


# --- Name Constraints im Einzelnen ---------------------------------------------------------------


def test_what_a_constraint_permits():
    own = tls.stowly_constraints()
    for address in (
        "192.168.1.10",
        "10.1.1.1",
        "fd12::1",
        "127.0.0.1",
        "::1",
        "nas.local",
        "NAS.LOCAL",
        "localhost",
    ):
        assert tls.constraints_permit(own, address), address
    for address in ("8.8.8.8", "2001:db8::1", "stowly.example", "local.example", "localhost.example"):
        assert not tls.constraints_permit(own, address), address
    assert tls.constraints_permit(None, "8.8.8.8")
    only_names = x509.NameConstraints(permitted_subtrees=[x509.DNSName(".lan")], excluded_subtrees=None)
    assert tls.constraints_permit(only_names, "nas.lan") and not tls.constraints_permit(only_names, "lan")
    assert tls.constraints_permit(only_names, "8.8.8.8")  # IPs sind dann nicht beschränkt
    excluded = x509.NameConstraints(
        permitted_subtrees=None, excluded_subtrees=[x509.IPAddress(ipaddress.ip_network("192.168.2.0/24"))]
    )
    assert tls.constraints_permit(excluded, "192.168.1.10") and not tls.constraints_permit(
        excluded, "192.168.2.1"
    )


# --- Kontext des Listeners und Neuladen ----------------------------------------------------------


def test_the_context_is_always_the_same_and_reloads_in_the_loop(settings_https, clock):
    manager = manager_for(settings_https, clock)
    context = manager.context()
    assert manager.context() is context
    assert context.minimum_version == ssl.TLSVersion.TLSv1_2
    applied: list[str] = []
    original = manager._apply

    def watch(target, path) -> None:
        applied.append(threading.current_thread().name)
        original(target, path)

    manager._apply = watch  # type: ignore[method-assign]
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, name="schleife-des-listeners")
    thread.start()
    try:
        manager.attach(loop)
        assert manager.ensure(["192.168.1.10"]) is True
        for _ in range(200):
            if applied:
                break
            time.sleep(0.01)
        assert applied == ["schleife-des-listeners"]
    finally:
        loop.call_soon_threadsafe(loop.stop)
        thread.join(timeout=5)
        loop.close()
        manager.detach()


def test_an_unloadable_new_certificate_keeps_the_old_one(settings_https, clock, caplog):
    manager = manager_for(settings_https, clock)
    manager.context()
    (settings_https.tls_dir / "server.pem").write_bytes(b"kaputt")
    manager.reload()
    assert manager.problem == "Das neue Zertifikat lässt sich nicht laden; der Listener behält das alte."


def test_the_listener_state(manager):
    assert manager.info()["listening"] is False
    manager.started()
    assert (manager.info()["listening"], manager.problem) == (True, None)
    manager.failed("Der HTTPS-Listener auf Port 8443 läuft nicht: belegt.")
    assert (manager.info()["listening"], manager.problem) == (
        False,
        "Der HTTPS-Listener auf Port 8443 läuft nicht: belegt.",
    )


# --- Der tägliche Job ----------------------------------------------------------------------------


def test_the_daily_job_renews_and_notes_it(tmp_path):
    settings = make_settings(tmp_path)
    app = create_app(settings)
    assert app.state.tls.certificate is not None
    addresses = ["192.168.1.10"]
    job = tls.TlsRenewJob(settings, app.state.tls, lambda: addresses)
    now = datetime.now(UTC)
    assert job.due(scheduler.JobRun(job.name), now)
    job.run(now)
    con = db.connect(settings.database_path)
    try:
        run = scheduler.load_run(con, job.name)
    finally:
        con.close()
    assert run.state["renewed"] is True and run.last_at == format_timestamp(now)
    assert not job.due(run, now)
    job.run(now)  # nichts zu tun: dieselben Adressen, noch lange gültig
    con = db.connect(settings.database_path)
    try:
        assert scheduler.load_run(con, job.name).state["renewed"] is False
    finally:
        con.close()


def test_the_app_schedules_the_job_only_with_https(tmp_path):
    with TestClient(create_app(make_settings(tmp_path / "ohne", https=False))) as client:
        assert client.app.state.scheduler.jobs == ["backup", "push_daily"]
    with TestClient(create_app(make_settings(tmp_path / "mit"))) as client:
        assert client.app.state.scheduler.jobs == ["backup", "push_daily", "tls_renew"]


def test_the_log_names_fingerprints_never_a_key(tmp_path, caplog):
    caplog.set_level("INFO", logger="stowly")
    settings = make_settings(tmp_path)
    create_app(settings)
    ca = ca_of(settings)
    assert ca.fingerprint(hashes.SHA256()).hex(":").upper() in caplog.text
    key_lines = (settings.tls_dir / "ca.key").read_text().splitlines()[1:-1]
    assert not any(line in caplog.text for line in key_lines)
    assert "PRIVATE KEY" not in caplog.text
