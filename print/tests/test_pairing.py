"""Koppeln des Pi mit Stowly (stowly_print/pairing.py; docs/sync-protokoll.md, 11.8).

Stowly selbst ersetzt hier ein ``post``, das die Antworten des Servers nachbildet; die Zertifikate
signiert eine Test-CA aus ``cryptography``. Für den Selbsttest laufen zwei kleine Dienste auf 127.0.0.1
(HTTP und HTTPS) an Ports, die das System vergibt. Wie der echte Server antwortet, prüft
``server/tests/test_pi_pairing.py`` mit demselben Modul.
"""

import contextlib
import dataclasses
import hashlib
import hmac
import http.client
import http.server
import ipaddress
import json
import os
import signal
import socket
import ssl
import subprocess
import threading
import tomllib
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

from stowly_print import __version__, pairing
from stowly_print.__main__ import main
from stowly_print.config import (
    ConfigurationError,
    Listener,
    ServiceConfig,
    dump_config,
    load_config,
    parse_config,
)
from stowly_print.drivers import PrinterConfig

cryptography = pytest.importorskip("cryptography")
from cryptography import x509  # noqa: E402
from cryptography.hazmat.primitives import hashes, serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID  # noqa: E402

SERVER = "http://192.168.1.10:8010"
CODE = "ABCD-EFGH"
# Der echte Prüfdienst; in den Tests von ``pair`` ersetzt ihn ``responder_calls`` (kein Port 8080).
REAL_RESPONDER = pairing.proof_responder


@pytest.fixture(autouse=True)
def responder_calls(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    """Token und Antrag (SHA-256), mit denen ``pair`` die Rückprüfung beantworten wollte."""
    calls: list[tuple[str, str]] = []

    @contextlib.contextmanager
    def fake(token: str, digest: str) -> Iterator[int | None]:
        calls.append((token, digest))
        yield 8080

    monkeypatch.setattr(pairing, "proof_responder", fake)
    return calls


# --- Code ----------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "normal"),
    [
        ("ABCD-EFGH", "ABCDEFGH"),
        ("abcd-efgh", "ABCDEFGH"),
        (" ab cd ef gh ", "ABCDEFGH"),
        ("O1IL-0000", "0111" + "0000"),
        ("2345-6789", "23456789"),
        ("\tZZZZ\n-ZZZZ", "ZZZZZZZZ"),
    ],
)
def test_codes_are_read_generously(text, normal):
    assert pairing.normalise_code(text) == normal
    assert pairing.format_code(normal) == f"{normal[:4]}-{normal[4:]}"


@pytest.mark.parametrize(
    "text", ["", "ABCD-EFG", "ABCD-EFGHJ", "ABCD-EFGU", "ÄBCD-EFGH", "ABCD_EFGH", "１２３４５６７８"]
)
def test_anything_else_is_no_code(text):
    with pytest.raises(ValueError):
        pairing.normalise_code(text)


def test_the_alphabet_is_crockford_base32():
    assert len(pairing.CODE_ALPHABET) == 32 == len(set(pairing.CODE_ALPHABET))
    assert not set("ILOU") & set(pairing.CODE_ALPHABET)


# --- Drucker am USB ------------------------------------------------------------------------------


def test_the_model_table_uses_the_names_of_the_brother_library():
    assert pairing.BROTHER_MODELS["2028"] == "QL-570"
    assert pairing.BROTHER_MODELS["209b"] == "QL-800"
    assert len(pairing.BROTHER_MODELS) == 17
    assert all(len(key) == 4 and key == key.lower() for key in pairing.BROTHER_MODELS)
    assert all(int(key, 16) for key in pairing.BROTHER_MODELS)
    models = pytest.importorskip("brother_ql.models")
    known = {model.identifier for model in models.ALL_MODELS}
    assert set(pairing.BROTHER_MODELS.values()) <= known


def usb_device(root: Path, name: str, vendor: str, product: str, *interface_classes: str) -> None:
    device = root / name
    device.mkdir(parents=True)
    (device / "idVendor").write_text(f"{vendor}\n")
    (device / "idProduct").write_text(f"{product}\n")
    # Unter Linux heißen die Schnittstellen "1-1:1.0"; Windows erlaubt keinen Doppelpunkt im Namen.
    for index, interface_class in enumerate(interface_classes):
        interface = device / f"{name}.1.{index}"
        interface.mkdir()
        (interface / "bInterfaceClass").write_text(f"{interface_class}\n")
    (device / "power").mkdir()


def test_brother_printers_are_found_in_sysfs(tmp_path):
    usb_device(tmp_path, "1-1", "1d6b", "0002", "09")  # ein Hub, kein Brother
    usb_device(tmp_path, "1-2", "04f9", "2028", "07")
    usb_device(tmp_path, "1-3", "04F9", "209B", "08")  # QL-800 im Editor-Lite-Modus
    usb_device(tmp_path, "1-4", "04f9", "20ff", "07")
    (tmp_path / "1-2.1.0").mkdir()  # Schnittstelle als eigener Eintrag (ohne idVendor), wie 1-2:1.0
    assert pairing.find_printers(tmp_path) == [
        pairing.UsbPrinter(product="2028", model="QL-570", editor_lite=False),
        pairing.UsbPrinter(product="209b", model="QL-800", editor_lite=True),
        pairing.UsbPrinter(product="20ff", model=None, editor_lite=False),
    ]
    assert pairing.find_printers(tmp_path / "fehlt") == []


# --- Adressen, Hostname, Token -------------------------------------------------------------------


def test_only_home_addresses_go_to_stowly_the_one_to_the_server_first():
    others = ["127.0.0.1", "192.168.1.20", "8.8.8.8", "169.254.3.4", "10.71.83.1", "172.17.0.1", "100.64.1.2"]
    assert pairing.pi_addresses("192.168.1.21", others) == [
        "192.168.1.21",
        "192.168.1.20",
        "172.17.0.1",
        "100.64.1.2",
    ]
    assert pairing.pi_addresses(None, [f"10.0.0.{n}" for n in range(1, 20)]) == [
        f"10.0.0.{n}" for n in range(1, 9)
    ]
    assert pairing.pi_addresses("8.8.8.8", ["fe80::1", "kaputt", "192.168.001.2"]) == []


def test_the_addresses_of_the_interfaces_come_from_ip_json():
    output = json.dumps(
        [
            {"ifname": "lo", "addr_info": [{"family": "inet", "local": "127.0.0.1"}]},
            {
                "ifname": "wlan0",
                "addr_info": [{"family": "inet", "local": "192.168.1.20"}, {"family": "inet6"}],
            },
            {"ifname": "eth0", "addr_info": "kaputt"},
            "unsinn",
        ]
    )

    def run(arguments: list[str], **_options: Any) -> subprocess.CompletedProcess:
        assert arguments == ["ip", "-j", "-4", "addr"]
        return subprocess.CompletedProcess(arguments, 0, stdout=output, stderr="")

    assert pairing.interface_addresses(run) == ["127.0.0.1", "192.168.1.20"]
    failing = lambda arguments, **_options: subprocess.CompletedProcess(arguments, 1, stdout="", stderr="x")  # noqa: E731
    assert pairing.interface_addresses(failing) == []

    def missing(*_arguments: Any, **_options: Any) -> subprocess.CompletedProcess:
        raise FileNotFoundError("ip")

    assert pairing.interface_addresses(missing) == []


def test_the_source_address_towards_the_server():
    server = pairing.parse_server("http://127.0.0.1:9")
    assert pairing.source_address(server) == "127.0.0.1"


@pytest.mark.parametrize(
    ("text", "url", "host", "port"),
    [
        ("http://192.168.1.10:8010", "http://192.168.1.10:8010", "192.168.1.10", 8010),
        ("http://nas.local:8010/", "http://nas.local:8010", "nas.local", 8010),
        ("https://nas.local", "https://nas.local", "nas.local", 443),
        ("http://[fd00::10]:8010", "http://[fd00::10]:8010", "fd00::10", 8010),
    ],
)
def test_server_addresses(text, url, host, port):
    assert pairing.parse_server(text) == pairing.Server(url=url, host=host, port=port)


@pytest.mark.parametrize(
    "text", ["192.168.1.10:8010", "ftp://nas", "http://nas:0", "http://nas/pfad", "http://a b"]
)
def test_what_is_no_server_address(text):
    with pytest.raises(pairing.PairingError):
        pairing.parse_server(text)


def test_the_hostname_must_do_for_the_certificate():
    assert pairing.pi_hostname("stowly-drucker.fritz.box") == "stowly-drucker"
    for wrong in ("stowly_drucker", "-pi", "pi-", "x" * 64, ""):
        with pytest.raises(pairing.PairingError, match="raspi-config"):
            pairing.pi_hostname(wrong)


def test_an_existing_token_stays_if_stowly_takes_it():
    assert pairing.keep_or_new_token({"token": " vorhandenes_Token-0123 "}) == (
        "vorhandenes_Token-0123",
        False,
    )
    for raw in (None, {}, {"token": "zu-kurz"}, {"token": "mit Leerzeichen 0123456789"}, {"token": 42}):
        token, new = pairing.keep_or_new_token(raw)
        assert new and pairing.TOKEN.fullmatch(token) and len(token) == 32


# --- Konfiguration -------------------------------------------------------------------------------


def full_config(tmp_path: Path) -> ServiceConfig:
    return ServiceConfig(
        token='token "mit" \\ und ü-0123456789',
        origins=("http://192.168.1.10:8010", "https://nas.local:8443"),
        http=Listener(host="0.0.0.0", port=8080),
        https=Listener(
            host="0.0.0.0",
            port=8443,
            certificate=tmp_path / "tls" / "pi.crt",
            key=tmp_path / "tls" / "pi.key",
        ),
        printers=(
            PrinterConfig(
                name="keller", driver="brother_ql", model="QL-570", address="usb://04f9", media="62"
            ),
            PrinterConfig(name="bild", driver="image", directory=tmp_path / "etiketten", simulate="fail"),
            PrinterConfig(
                name="netz", driver="brother_ql", model="QL-820NWB", address="tcp://192.168.1.60:9100"
            ),
        ),
        log_level="debug",
    )


def test_dump_config_writes_what_parse_config_reads_back(tmp_path):
    config = full_config(tmp_path)
    text = dump_config(config, header=["Kopfzeile", ""])
    assert text.startswith("# Kopfzeile\n#\n")
    assert parse_config(tomllib.loads(text), tmp_path) == config


def test_dump_config_without_https_and_with_http_switched_off(tmp_path):
    config = dataclasses.replace(full_config(tmp_path), origins=())
    without_https = dataclasses.replace(config, https=None)
    assert parse_config(tomllib.loads(dump_config(without_https)), tmp_path) == without_https
    without_http = dataclasses.replace(config, http=None)
    text = dump_config(without_http)
    assert "[http]\nenabled = false" in text
    assert parse_config(tomllib.loads(text), tmp_path) == without_http


def test_a_new_configuration_has_one_brother_and_both_listeners(tmp_path):
    config = pairing.build_config(
        previous=None,
        raw=None,
        token="t" * 20,
        origins=["HTTP://192.168.1.10:8010/", "https://nas.local:8443", "http://192.168.1.10:8010", " "],
        tls=tmp_path / "tls",
        detected_model="QL-570",
        model=None,
        address=None,
    )
    assert config.origins == ("http://192.168.1.10:8010", "https://nas.local:8443")
    assert config.http == Listener(host="0.0.0.0", port=8080)
    assert config.https == Listener(
        host="0.0.0.0", port=8443, certificate=tmp_path / "tls" / "pi.crt", key=tmp_path / "tls" / "pi.key"
    )
    assert config.printers == (
        PrinterConfig(name="keller", driver="brother_ql", model="QL-570", address="usb://04f9", media="62"),
    )
    assert config.log_level == "info"
    # Ohne erkannten Drucker die Vorgabe, eine Angabe von Hand geht vor.
    assert (
        pairing.build_config(
            previous=None,
            raw=None,
            token="t" * 20,
            origins=[],
            tls=tmp_path,
            detected_model=None,
            model=None,
            address=None,
        )
        .printers[0]
        .model
        == "QL-800"
    )
    manual = pairing.build_config(
        previous=None,
        raw=None,
        token="t" * 20,
        origins=[],
        tls=tmp_path,
        detected_model="QL-570",
        model="QL-800",
        address="usb://04f9:209b",
    )
    assert (manual.printers[0].model, manual.printers[0].address) == ("QL-800", "usb://04f9:209b")


def test_an_existing_configuration_keeps_its_printers_and_log_level(tmp_path):
    previous = full_config(tmp_path)
    config = pairing.build_config(
        previous=previous,
        raw=None,
        token="neu" * 6,
        origins=["https://nas.local:8443"],
        tls=tmp_path / "anders",
        detected_model="QL-800",
        model=None,
        address="usb://ignoriert",
    )
    assert config.log_level == "debug"
    # Nur der erste Brother bekommt das erkannte Modell; alles andere bleibt.
    assert config.printers[0] == dataclasses.replace(previous.printers[0], model="QL-800")
    assert config.printers[1:] == previous.printers[1:]
    assert config.https is not None and config.https.certificate == tmp_path / "anders" / "pi.crt"


def test_a_configuration_that_would_not_read_back_is_not_written(tmp_path):
    config = dataclasses.replace(full_config(tmp_path), origins=("ftp://nas",))
    with pytest.raises(pairing.PairingError, match="nichts geschrieben"):
        pairing.config_text(config, tmp_path)


# --- Antworten von Stowly ------------------------------------------------------------------------


def reply(status: int, body: Any = None, **headers: str) -> pairing.Reply:
    return pairing.Reply(status, {name.replace("_", "-"): value for name, value in headers.items()}, body)


def error(message: str, **details: Any) -> dict[str, Any]:
    return {"error": {"code": "x", "message": message, "details": details or None}}


def test_answers_that_end_the_pairing_say_what_to_do():
    with pytest.raises(pairing.PairingError) as unknown:
        pairing.expect(reply(404, error("Diesen Kopplungscode kennt Stowly nicht.")), 200)
    assert "kennt Stowly nicht" in str(unknown.value) and "neuen Code" in str(unknown.value)
    with pytest.raises(pairing.PairingError, match="neuen Code"):
        pairing.expect(reply(409, error("Der Kopplungscode ist abgelaufen.")), 200)
    problems = error("Angaben", errors=[{"loc": ["body", "addresses", 0], "msg": "Keine private Adresse."}])
    with pytest.raises(pairing.PairingError, match=r"addresses\.0: Keine private Adresse"):
        pairing.expect(reply(422, problems), 200)
    with pytest.raises(pairing.PairingError, match="erneut"):
        pairing.expect(reply(429, error("Zu viele Fehlversuche.")), 200)
    with pytest.raises(pairing.PairingError, match="antwortet mit 502"):
        pairing.expect(reply(502, "kein JSON"), 200)
    assert pairing.expect(reply(200, {"a": 1}), 200) == {"a": 1}


def test_after_429_there_is_exactly_one_more_try():
    answers = [reply(429, error("Bremse"), retry_after="7"), reply(204)]
    sent: list[str] = []
    slept: list[float] = []

    def post(url: str, payload: dict[str, Any]) -> pairing.Reply:
        sent.append(url)
        return answers.pop(0)

    assert pairing.call(post, "http://x/api", {}, sleep=slept.append).status == 204
    assert slept == [7] and len(sent) == 2
    answers[:] = [reply(429, retry_after="9999"), reply(429)]
    assert pairing.call(post, "http://x/api", {}, sleep=slept.append).status == 429
    assert slept[-1] == pairing.RETRY_AFTER_MAX_S


# --- Koppeln mit nachgebildetem Stowly -----------------------------------------------------------


class FakeStowly:
    """Antwortet wie Stowly auf ``pair/start`` und ``pair``; signiert mit einer Test-CA."""

    def __init__(self) -> None:
        self.key = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Stowly Test-CA")])
        now = datetime.now(UTC)
        self.ca = (
            x509.CertificateBuilder()
            .subject_name(name)
            .issuer_name(name)
            .public_key(self.key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1))
            .not_valid_after(now + timedelta(days=3650))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .sign(self.key, hashes.SHA256())
        )
        self.requests: list[tuple[str, dict[str, Any]]] = []
        self.answer: pairing.Reply | None = None  # statt der Kopplung
        self.wrong_key = False

    @property
    def ca_pem(self) -> str:
        return self.ca.public_bytes(serialization.Encoding.PEM).decode("ascii")

    def issue(self, public_key: Any, ips: list[str], dns: list[str]) -> x509.Certificate:
        now = datetime.now(UTC)
        sans = [x509.IPAddress(ipaddress.ip_address(ip)) for ip in ips] + [x509.DNSName(name) for name in dns]
        return (
            x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Stowly Drucker")]))
            .issuer_name(self.ca.subject)
            .public_key(public_key)
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(hours=1))
            .not_valid_after(now + timedelta(days=825))
            .add_extension(x509.SubjectAlternativeName(sans), critical=False)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .sign(self.key, hashes.SHA256())
        )

    def __call__(self, url: str, payload: dict[str, Any]) -> pairing.Reply:
        path = urlsplit(url).path
        self.requests.append((path, payload))
        if self.answer is not None:
            return self.answer
        if path == "/api/pi/pair/start":
            return reply(204)
        assert path == "/api/pi/pair"
        request = x509.load_pem_x509_csr(payload["csr"].encode("ascii"))
        public_key = (
            ec.generate_private_key(ec.SECP256R1()).public_key() if self.wrong_key else request.public_key()
        )
        hostname = payload["hostname"]
        certificate = self.issue(public_key, [*payload["addresses"], "10.71.83.1"], [f"{hostname}.local"])
        first = payload["addresses"][0]
        return reply(
            200,
            {
                "printer_id": payload["printer_id"] or "5b3c0d2e-6f1a-4b7c-9d8e-0f1a2b3c4d5e",
                "name": payload["model"] or hostname,
                "certificate": certificate.public_bytes(serialization.Encoding.PEM).decode("ascii"),
                "ca": self.ca_pem,
                "origins": [SERVER, "https://192.168.1.10:8443"],
                # Wie der Server: <hostname>.local nur für Hostnamen, die mit stowly beginnen.
                "urls": [f"https://{first}:8443"]
                + ([f"https://{hostname}.local:8443"] if hostname.lower().startswith("stowly") else [])
                + [f"http://{first}:8080"],
                "not_after": "2029-02-19T10:00:00.000Z",
            },
        )


def key_and_csr(_folder: Path, hostname: str) -> tuple[bytes, str]:
    key = ec.generate_private_key(ec.SECP256R1())
    request = (
        x509.CertificateSigningRequestBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, hostname)]))
        .sign(key, hashes.SHA256())
    )
    pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )
    return pem, request.public_bytes(serialization.Encoding.PEM).decode("ascii")


@pytest.fixture
def paths(tmp_path: Path) -> pairing.Paths:
    sysfs = tmp_path / "sys"
    usb_device(sysfs, "1-1", "04f9", "2028", "07")
    return pairing.Paths(
        config=tmp_path / "etc" / "stowly-print.toml",
        tls=tmp_path / "etc" / "tls",
        state=tmp_path / "etc" / "pairing.json",
        sysfs=sysfs,
    )


def run_pair(stowly: FakeStowly, paths: pairing.Paths, **options: Any) -> pairing.Outcome:
    options.setdefault("addresses", ["192.168.1.20"])
    return pairing.pair(
        SERVER, CODE, paths=paths, post=stowly, hostname="stowly-drucker", make_csr=key_and_csr, **options
    )


def test_the_pi_reports_first_with_hostname_and_version():
    stowly = FakeStowly()
    assert pairing.announce(SERVER, "abcd efgh", post=stowly, hostname="stowly-drucker") == "stowly-drucker"
    assert stowly.requests == [
        ("/api/pi/pair/start", {"code": "ABCDEFGH", "hostname": "stowly-drucker", "version": __version__})
    ]


def test_pairing_writes_key_certificates_configuration_and_state(paths):
    stowly = FakeStowly()
    outcome = run_pair(stowly, paths, origins=["https://Stowly.Home/"])
    ((path, sent),) = stowly.requests
    assert path == "/api/pi/pair"
    assert sent["code"] == "ABCDEFGH" and sent["hostname"] == "stowly-drucker"
    assert sent["addresses"] == ["192.168.1.20"]
    assert (sent["model"], sent["printer_found"], sent["printer_id"]) == ("QL-570", True, None)
    assert sent["version"] == __version__
    assert pairing.TOKEN.fullmatch(sent["token"])

    config = load_config(paths.config)
    assert config.token == sent["token"]
    assert config.origins == (SERVER, "https://192.168.1.10:8443", "https://stowly.home")
    assert config.https is not None and config.https.key == paths.tls / "pi.key"
    assert config.printers[0].model == "QL-570"
    certificate = x509.load_pem_x509_certificate((paths.tls / "pi.crt").read_bytes())
    key = serialization.load_pem_private_key((paths.tls / "pi.key").read_bytes(), password=None)
    assert certificate.public_key().public_numbers() == key.public_key().public_numbers()
    assert (paths.tls / "ca.crt").read_text() == stowly.ca_pem
    state = json.loads(paths.state.read_text())
    assert set(state) == {"server", "printer_id", "not_after", "paired_at"}
    assert state["server"] == SERVER and state["not_after"] == "2029-02-19T10:00:00.000Z"
    assert sent["token"] not in paths.state.read_text()
    if os.name == "posix":
        assert (paths.tls / "pi.key").stat().st_mode & 0o777 == 0o600
        assert (paths.tls / "pi.crt").stat().st_mode & 0o777 == 0o644
        assert (paths.tls / "ca.crt").stat().st_mode & 0o777 == 0o644
        assert paths.config.stat().st_mode & 0o777 == 0o640
    assert outcome.urls[0] == "https://192.168.1.20:8443"
    assert outcome.token_new and outcome.notes == []


def test_a_second_pairing_keeps_the_token_and_the_old_files_as_bak(paths):
    stowly = FakeStowly()
    run_pair(stowly, paths)
    token = load_config(paths.config).token
    old_key = (paths.tls / "pi.key").read_bytes()
    old_config = paths.config.read_bytes()
    outcome = run_pair(stowly, paths, addresses=["192.168.1.21"])
    assert not outcome.token_new
    assert stowly.requests[-1][1]["token"] == token
    # Der Drucker der ersten Kopplung (pairing.json) geht mit.
    assert stowly.requests[-1][1]["printer_id"] == "5b3c0d2e-6f1a-4b7c-9d8e-0f1a2b3c4d5e"
    assert (paths.tls / "pi.key.bak").read_bytes() == old_key
    assert (paths.tls / "pi.key").read_bytes() != old_key
    assert paths.config.with_name("stowly-print.toml.bak").read_bytes() == old_config
    assert paths.state.with_name("pairing.json.bak").exists()
    if os.name == "posix":
        assert (paths.tls / "pi.key.bak").stat().st_mode & 0o777 == 0o600


def test_a_hand_written_configuration_keeps_its_printers(paths, tmp_path):
    paths.config.parent.mkdir(parents=True)
    previous = dataclasses.replace(full_config(tmp_path), token="mein-eigenes-token-0123456789")
    paths.config.write_text(dump_config(previous), encoding="utf-8")
    run_pair(FakeStowly(), paths)
    config = load_config(paths.config)
    assert config.token == "mein-eigenes-token-0123456789"
    assert [printer.name for printer in config.printers] == ["keller", "bild", "netz"]
    assert config.printers[0].model == "QL-570" and config.log_level == "debug"


def test_an_unreadable_configuration_is_kept_as_bak_and_replaced(paths):
    paths.config.parent.mkdir(parents=True)
    paths.config.write_text('token = "noch-brauchbar-0123456789"\nkaputt = [\n', encoding="utf-8")
    outcome = run_pair(FakeStowly(), paths)
    assert load_config(paths.config).printers[0].name == "keller"
    assert paths.config.with_name("stowly-print.toml.bak").read_text().endswith("kaputt = [\n")
    assert outcome.token_new  # TOML kaputt: auch das Token ließ sich nicht lesen
    assert outcome.notes == [
        "Die bisherige Konfiguration ließ sich nicht lesen; sie bleibt als stowly-print.toml.bak."
    ]


@pytest.mark.parametrize("status", [404, 409, 422, 503])
def test_when_stowly_refuses_nothing_is_written(paths, status):
    stowly = FakeStowly()
    stowly.answer = reply(status, error("Nein."))
    with pytest.raises(pairing.PairingError, match="Nein"):
        run_pair(stowly, paths)
    assert not paths.config.exists() and not paths.tls.exists() and not paths.state.exists()


def test_a_certificate_for_another_key_is_not_written(paths):
    stowly = FakeStowly()
    stowly.wrong_key = True
    with pytest.raises(pairing.PairingError, match="passt nicht zum Schlüssel"):
        run_pair(stowly, paths)
    assert not paths.tls.exists()


def test_without_an_address_in_the_home_network_there_is_no_pairing(paths):
    stowly = FakeStowly()
    with pytest.raises(pairing.PairingError, match="keine Adresse im Heimnetz"):
        run_pair(stowly, paths, addresses=["127.0.0.1", "8.8.8.8"])
    assert stowly.requests == []


# --- Rückprüfung ---------------------------------------------------------------------------------


def health_of(port: int, path: str) -> tuple[int, Any]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        body = response.read()
        return response.status, json.loads(body) if response.status == 200 else None
    finally:
        connection.close()


PI_TOKEN = "druck-token-0123456789abcdef"
NONCE = "Nonce_aus-Stowly-0123"


def test_while_pairing_the_pi_proves_this_one_request():
    digest = pairing.csr_digest(
        "-----BEGIN CERTIFICATE REQUEST-----\r\nabc\r\n-----END CERTIFICATE REQUEST-----\r\n"
    )
    with REAL_RESPONDER(PI_TOKEN, digest, host="127.0.0.1", port=0) as port:
        assert port
        status, body = health_of(port, f"/v1/pair-proof?nonce={NONCE}")
        assert status == 200
        message = f"stowly-pair:{NONCE}:{digest}".encode("ascii")
        expected = hmac.new(PI_TOKEN.encode("utf-8"), message, hashlib.sha256).hexdigest()
        assert body == {"app": "stowly-print", "version": __version__, "proof": expected}
        assert pairing.pair_proof(PI_TOKEN, NONCE, digest) == expected
        # Nicht derselbe Nachweis wie in /v1/health des Druckdienstes, und den gibt es hier gar nicht.
        assert expected != pairing.proof_of(PI_TOKEN, NONCE)
        assert health_of(port, f"/v1/health?nonce={NONCE}")[0] == 404
        # Nur diese eine Frage, und nur mit einem brauchbaren nonce.
        assert health_of(port, "/v1/pair-proof")[0] == 404
        assert health_of(port, "/v1/pair-proof?nonce=kurz")[0] == 404
        assert health_of(port, f"/v1/pair-proof?nonce={NONCE}&nonce={NONCE}")[0] == 404
    with pytest.raises(OSError):
        health_of(port, f"/v1/pair-proof?nonce={NONCE}")  # danach ist der Port wieder zu


def test_the_digest_is_the_one_stowly_computes():
    # Zeilenenden und Rand zählen nicht; sonst ist es die SHA-256 des PEM.
    pem = "-----BEGIN CERTIFICATE REQUEST-----\nabc\n-----END CERTIFICATE REQUEST-----"
    assert pairing.csr_digest(pem) == hashlib.sha256(pem.encode("utf-8")).hexdigest()
    assert pairing.csr_digest("  " + pem.replace("\n", "\r\n") + "\r\n") == pairing.csr_digest(pem)


def test_a_busy_port_means_no_check_back():
    with socket.socket() as service:
        service.bind(("127.0.0.1", 0))
        service.listen()
        with REAL_RESPONDER(PI_TOKEN, "0" * 64, host="127.0.0.1", port=service.getsockname()[1]) as port:
            assert port is None


class FakeService(pairing.ServiceControl):
    """Ein Druckdienst, der nur mitschreibt."""

    def __init__(self, order: list[str], *, running: bool = True) -> None:
        super().__init__()
        self.order = order
        self.running = running

    def pause(self) -> bool:
        self.order.append("Dienst an" if not self.running else "Dienst hält")
        return self.running

    def resume(self) -> None:
        self.order.append("Dienst läuft")


def ordered_pair(paths: pairing.Paths, stowly: Any, order: list[str], **options: Any) -> pairing.Outcome:
    @contextlib.contextmanager
    def responder(token: str, digest: str) -> Iterator[int | None]:
        order.append(f"auf:{token}:{digest}")
        yield 8080
        order.append("zu")

    def post(url: str, payload: dict[str, Any]) -> pairing.Reply:
        order.append(urlsplit(url).path)
        return stowly(url, payload)

    options.setdefault("service", FakeService(order))
    return pairing.pair(
        SERVER,
        CODE,
        paths=paths,
        post=post,
        hostname="stowly-drucker",
        make_csr=key_and_csr,
        addresses=["192.168.1.20"],
        respond=responder,
        **options,
    )


def test_pairing_pauses_the_service_and_answers_the_check_back_while_it_asks(paths):
    stowly = FakeStowly()
    order: list[str] = []
    ordered_pair(paths, stowly, order)
    sent = stowly.requests[-1][1]
    assert order == [
        "Dienst hält",
        f"auf:{sent['token']}:{pairing.csr_digest(sent['csr'])}",
        "/api/pi/pair",
        "zu",
        "Dienst läuft",
    ]
    assert paths.config.exists()


def test_after_a_refusal_the_service_runs_again_and_nothing_is_written(paths):
    stowly = FakeStowly()
    stowly.answer = reply(422, error("Der Pi meldet Angaben, die nicht in sein Zertifikat dürfen."))
    order: list[str] = []
    with pytest.raises(pairing.PairingError):
        ordered_pair(paths, stowly, order)
    assert order[-1] == "Dienst läuft"
    assert not paths.config.exists()


def test_a_hangup_while_pairing_still_brings_the_service_back(paths):
    # Reißt die SSH-Sitzung ab (SIGHUP) oder beendet jemand den Installer (SIGTERM), läuft ``finally``.
    stowly = FakeStowly()
    order: list[str] = []

    def post(url: str, payload: dict[str, Any]) -> pairing.Reply:
        signal.raise_signal(signal.SIGTERM)
        return stowly(url, payload)

    with pytest.raises(SystemExit):
        pairing.pair(
            SERVER,
            CODE,
            paths=paths,
            post=post,
            hostname="stowly-drucker",
            make_csr=key_and_csr,
            addresses=["192.168.1.20"],
            service=FakeService(order),
        )
    assert order == ["Dienst hält", "Dienst läuft"]
    assert not paths.config.exists()
    # Danach gelten wieder die vorigen Signal-Behandlungen.
    assert signal.getsignal(signal.SIGTERM) is signal.SIG_DFL


def test_a_service_that_was_not_running_stays_off(paths):
    order: list[str] = []
    ordered_pair(paths, FakeStowly(), order, service=FakeService(order, running=False))
    assert "Dienst läuft" not in order


def test_the_service_is_paused_with_systemd_only_as_root(monkeypatch):
    calls: list[list[str]] = []

    def run(arguments: list[str], **_options: Any) -> subprocess.CompletedProcess:
        calls.append(arguments)
        return subprocess.CompletedProcess(arguments, 0)

    control = pairing.ServiceControl(run=run)
    monkeypatch.setattr(pairing.os, "geteuid", lambda: 1000, raising=False)
    assert control.pause() is False and calls == []
    monkeypatch.setattr(pairing.os, "geteuid", lambda: 0, raising=False)
    assert control.pause() is True
    control.resume()
    unit = pairing.SERVICE_UNIT
    assert calls == [
        ["systemctl", "is-active", "--quiet", unit],
        ["systemctl", "stop", unit],
        ["systemctl", "start", unit],
    ]
    # Läuft er nicht, bleibt es dabei.
    calls.clear()
    idle = pairing.ServiceControl(
        run=lambda arguments, **_o: calls.append(arguments) or subprocess.CompletedProcess(arguments, 3)
    )
    assert idle.pause() is False
    assert calls == [["systemctl", "is-active", "--quiet", unit]]


def test_the_default_check_back_gets_token_and_request_that_go_to_stowly(paths, responder_calls):
    stowly = FakeStowly()
    run_pair(stowly, paths)
    sent = stowly.requests[-1][1]
    assert responder_calls == [(sent["token"], pairing.csr_digest(sent["csr"]))]


def test_editor_lite_and_a_missing_printer_are_reported(paths, tmp_path):
    usb = tmp_path / "sys-lite"
    usb_device(usb, "1-1", "04f9", "209b", "08")
    outcome = run_pair(FakeStowly(), dataclasses.replace(paths, sysfs=usb))
    assert outcome.model == "QL-800" and outcome.notes == [pairing.EDITOR_LITE_HINT]
    nothing = run_pair(FakeStowly(), dataclasses.replace(paths, sysfs=tmp_path / "leer"), model="QL-700")
    assert (nothing.printer_found, nothing.model) == (False, "QL-700")


def test_openssl_makes_a_p256_key_and_a_request(tmp_path):
    if not __import__("shutil").which("openssl"):
        pytest.skip("kein openssl")
    key_pem, csr_pem = pairing.make_key_and_csr(tmp_path, "stowly-drucker")
    key = serialization.load_pem_private_key(key_pem, password=None)
    request = x509.load_pem_x509_csr(csr_pem.encode("ascii"))
    assert isinstance(key, ec.EllipticCurvePrivateKey) and isinstance(key.curve, ec.SECP256R1)
    assert request.is_signature_valid
    assert request.public_key().public_numbers() == key.public_key().public_numbers()
    assert request.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value == "stowly-drucker"


def test_a_failing_openssl_ends_with_its_message(tmp_path):
    def run(arguments: list[str], **_options: Any) -> subprocess.CompletedProcess:
        return subprocess.CompletedProcess(arguments, 1, stdout="", stderr="Zeile 1\nkaputt\n")

    with pytest.raises(pairing.PairingError, match="kaputt"):
        pairing.make_key_and_csr(tmp_path, "pi", run=run)


# --- Selbsttest ----------------------------------------------------------------------------------


class Service(http.server.BaseHTTPRequestHandler):
    """Der Druckdienst im Kleinen: /v1/health mit Nachweis, /v1/jobs/<id> druckt sofort."""

    token = ""
    ready = True
    jobs: list[dict[str, Any]] = []

    def log_message(self, *_args: Any) -> None:
        pass

    def answer(self, body: dict[str, Any]) -> None:
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802 - Name aus http.server
        query = parse_qs(urlsplit(self.path).query)
        nonce = query.get("nonce", [None])[0]
        proof = None
        if nonce is not None:
            proof = hmac.new(self.token.encode(), nonce.encode(), hashlib.sha256).hexdigest()
        self.answer(
            {
                "app": "stowly-print",
                "version": "0.0.0",
                "proof": proof,
                "printers": [
                    {
                        "name": "keller",
                        "status": {"ready": self.ready, "errors": [] if self.ready else ["no_media"]},
                    }
                ],
            }
        )

    def do_POST(self) -> None:  # noqa: N802 - Name aus http.server
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        assert self.headers["Authorization"] == f"Bearer {self.token}"
        type(self).jobs.append({"path": self.path, **body})
        self.answer({"id": "x", "state": "printed"})


def serve(server: http.server.HTTPServer) -> threading.Thread:
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return thread


@pytest.fixture
def services(tmp_path: Path) -> Iterator[tuple[pairing.Paths, FakeStowly, type[Service]]]:
    """HTTP und HTTPS des Pi auf freien Ports, mit Zertifikat von der Test-CA und passender Konfiguration."""
    stowly = FakeStowly()
    tls = tmp_path / "tls"
    tls.mkdir()
    key = ec.generate_private_key(ec.SECP256R1())
    certificate = stowly.issue(key.public_key(), ["192.168.1.20", "10.71.83.1"], ["stowly-drucker.local"])
    (tls / "pi.crt").write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    (tls / "pi.key").write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
        )
    )
    (tls / "ca.crt").write_text(stowly.ca_pem)

    handler = type("Handler", (Service,), {"token": "selbsttest-token-0123456789", "ready": True, "jobs": []})
    plain = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    secure = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(str(tls / "pi.crt"), str(tls / "pi.key"))
    secure.socket = context.wrap_socket(secure.socket, server_side=True)
    serve(plain), serve(secure)
    config = ServiceConfig(
        token=handler.token,
        origins=(),
        http=Listener(host="127.0.0.1", port=plain.server_address[1]),
        https=Listener(
            host="127.0.0.1", port=secure.server_address[1], certificate=tls / "pi.crt", key=tls / "pi.key"
        ),
        printers=(
            PrinterConfig(
                name="keller", driver="brother_ql", model="QL-570", address="usb://04f9", media="62"
            ),
        ),
    )
    paths = pairing.Paths(config=tmp_path / "stowly-print.toml", tls=tls, state=tmp_path / "pairing.json")
    paths.config.write_text(dump_config(config), encoding="utf-8")
    try:
        yield paths, stowly, handler
    finally:
        plain.shutdown()
        secure.shutdown()
        plain.server_close()
        secure.server_close()


def by_name(checks: list[pairing.Check]) -> dict[str, pairing.Check]:
    return {check.name: check for check in checks}


def test_the_selftest_checks_http_https_and_prints_a_label(services):
    paths, _stowly, handler = services
    checks = by_name(pairing.selftest(paths.config, tls=paths.tls, hostname="stowly-drucker"))
    assert all(check.ok for check in checks.values()), checks
    assert set(checks) == {"HTTP", "HTTPS", "Testetikett"}
    assert "printed" in checks["Testetikett"].message
    (job,) = handler.jobs
    assert job["path"].startswith("/v1/jobs/selbsttest-") and job["path"].endswith("?wait=25")
    assert job["template"]["name"] == "zone-62x29"
    assert job["data"]["subtitle"] == "stowly-drucker · Stowly"


def test_without_a_ready_printer_or_with_no_test_print_nothing_is_printed(services):
    paths, _stowly, handler = services
    handler.ready = False
    checks = by_name(pairing.selftest(paths.config, tls=paths.tls, hostname="pi"))
    assert checks["Testetikett"].ok and "no_media" in checks["Testetikett"].message
    handler.ready = True
    checks = by_name(pairing.selftest(paths.config, tls=paths.tls, test_print=False))
    assert checks["Testetikett"].ok and "übersprungen" in checks["Testetikett"].message
    assert handler.jobs == []


def test_https_with_another_ca_fails_the_selftest(services):
    paths, _stowly, _handler = services
    (paths.tls / "ca.crt").write_text(FakeStowly().ca_pem)
    checks = by_name(pairing.selftest(paths.config, tls=paths.tls, test_print=False))
    assert checks["HTTP"].ok and not checks["HTTPS"].ok


def test_a_service_with_another_token_fails_the_selftest(services):
    paths, _stowly, handler = services
    handler.token = "ein-anderes-token-0123456789"
    checks = by_name(pairing.selftest(paths.config, tls=paths.tls, test_print=False, tries=1))
    assert not checks["HTTP"].ok and "Token" in checks["HTTP"].message


def test_without_a_configuration_the_selftest_says_so(tmp_path):
    (check,) = pairing.selftest(tmp_path / "fehlt.toml", tls=tmp_path)
    assert not check.ok and check.name == "Konfiguration"


# --- Kommandozeile -------------------------------------------------------------------------------


def test_pair_on_the_command_line_shows_no_token(paths, monkeypatch, capsys):
    stowly = FakeStowly()
    original = pairing.pair

    def pair(*args: Any, **kwargs: Any) -> pairing.Outcome:
        return original(
            *args,
            **kwargs,
            post=stowly,
            hostname="stowly-drucker",
            addresses=["192.168.1.20"],
            make_csr=key_and_csr,
        )

    monkeypatch.setattr(pairing, "pair", pair)
    arguments = ["pair", "--server", SERVER, "--code", CODE, "--config", str(paths.config)]
    arguments += ["--tls-dir", str(paths.tls), "--state", str(paths.state), "--origin", "https://stowly.home"]
    # sysfs aus der Vorgabe gibt es hier nicht: kein Drucker erkannt.
    assert main(arguments) == 0
    output = capsys.readouterr().out
    assert "Gekoppelt mit http://192.168.1.10:8010" in output and "https://stowly.home" in output
    assert load_config(paths.config).token not in output

    stowly.answer = reply(409, error("Der Kopplungscode ist abgelaufen."))
    assert main(arguments) == 1
    assert "abgelaufen" in capsys.readouterr().err


def test_pair_start_on_the_command_line(monkeypatch, capsys):
    stowly = FakeStowly()
    monkeypatch.setattr(pairing, "http_post", stowly)
    monkeypatch.setattr(pairing.socket, "gethostname", lambda: "stowly-drucker")
    original = pairing.announce
    monkeypatch.setattr(pairing, "announce", lambda server, code: original(server, code, post=stowly))
    assert main(["pair", "--start", "--server", SERVER, "--code", "abcd-efgh"]) == 0
    assert "stowly-drucker" in capsys.readouterr().out
    assert stowly.requests[0][0] == "/api/pi/pair/start"


def test_selftest_on_the_command_line(services, capsys):
    paths, _stowly, _handler = services
    arguments = ["selftest", "--config", str(paths.config), "--tls-dir", str(paths.tls), "--no-test-print"]
    assert main(arguments) == 0
    assert "HTTPS: ok" in capsys.readouterr().out
    (paths.tls / "ca.crt").write_text(FakeStowly().ca_pem)
    assert main(arguments) == 1


def test_a_broken_configuration_file_is_still_a_configuration_error(tmp_path):
    path = tmp_path / "x.toml"
    path.write_text("token = 1\n")
    with pytest.raises(ConfigurationError):
        load_config(path)


def test_a_hostname_without_stowly_gets_a_hint_instead_of_a_local_name(paths):
    stowly = FakeStowly()
    outcome = pairing.pair(
        SERVER,
        CODE,
        paths=paths,
        post=stowly,
        hostname="raspberrypi",
        make_csr=key_and_csr,
        addresses=["192.168.1.20"],
    )
    assert outcome.urls == ["https://192.168.1.20:8443", "http://192.168.1.20:8080"]
    assert outcome.notes == [pairing.LOCAL_NAME_HINT.format(hostname="raspberrypi")]
    assert run_pair(FakeStowly(), paths).notes == []  # stowly-drucker bekommt seinen Namen
