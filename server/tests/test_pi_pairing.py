"""Einen Raspberry Pi koppeln (stowly/pairing.py, api/pi.py; docs/sync-protokoll.md, 11.8).

Die CA ersetzt ``FakeTls``: Sie signiert echt, mit einer Test-CA aus ``cryptography`` (Muster
``tests/test_config.py``). Die Ursprünge der App und die HTTP-Adresse liefert ``wizard``; hier ersetzt.
Der letzte Teil koppelt den echten Pi-Teil (``stowly_print.pairing``) gegen diesen Server.
"""

import hashlib
import ipaddress
import json
import shutil
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from fastapi.testclient import TestClient
from support import TEST_PASSWORD, Device

from stowly import pairing, tls, wizard
from stowly.app import create_app
from stowly.config import Settings
from stowly.contract import ids
from stowly.contract.api import PI_CERT_DAYS, PI_PAIRING_TTL_S
from stowly.contract.timeutil import format_timestamp, parse_timestamp
from stowly_print import pairing as pi_side

APP_ORIGINS = ["https://192.168.1.10:8443", "https://nas.local:8443", "https://stowly.local:8443"]
HTTP_ORIGIN = "http://192.168.1.10:8010"
PI_HOST = "192.168.1.10:8010"  # so erreicht der Pi den Server
PI_IP = "192.168.1.20"  # von hier kommen die Anfragen des Pi (request.client)
TOKEN = "druck-token-0123456789abcdef"


# --- Ersatz für die CA ---------------------------------------------------------------------------


class FakeTls:
    """Ersatz für ``tls.TlsManager`` in ``app.state.tls``: signiert echt mit einer Test-CA."""

    def __init__(self) -> None:
        self.key = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Stowly Test-CA")])
        now = datetime.now(UTC)
        self.ca_certificate = (
            x509.CertificateBuilder()
            .subject_name(name)
            .issuer_name(name)
            .public_key(self.key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1))
            .not_valid_after(now + timedelta(days=3650))
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
            .sign(self.key, hashes.SHA256())
        )
        self.calls: list[dict[str, Any]] = []
        self.unavailable: str | None = None
        # Wie TlsManager.certificate: das Zertifikat des Servers selbst (None = noch keins).
        self.certificate: x509.Certificate | None = None

    def ca_pem(self) -> str | None:
        if self.unavailable is not None:
            return None
        return self.ca_certificate.public_bytes(serialization.Encoding.PEM).decode("ascii")

    def sign_csr(self, csr_pem: str, *, ips: list[str], dns: list[str], days: int) -> tls.Issued:
        self.calls.append({"ips": list(ips), "dns": list(dns), "days": days})
        if self.unavailable is not None:
            raise tls.CaUnavailable(self.unavailable)
        try:
            request = x509.load_pem_x509_csr(csr_pem.encode("ascii"))
        except (ValueError, UnicodeEncodeError):
            raise tls.CsrRejected("Der Antrag ist kein Zertifikatsantrag im Format PEM.") from None
        if not request.is_signature_valid:
            raise tls.CsrRejected("Die Signatur des Antrags stimmt nicht.")
        now = datetime.now(UTC)
        sans = [x509.IPAddress(ipaddress.ip_address(ip)) for ip in ips] + [x509.DNSName(name) for name in dns]
        certificate = (
            x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Stowly Drucker")]))
            .issuer_name(self.ca_certificate.subject)
            .public_key(request.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(hours=1))
            .not_valid_after(now + timedelta(days=days))
            .add_extension(x509.SubjectAlternativeName(sans), critical=False)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .sign(self.key, hashes.SHA256())
        )
        return tls.Issued(
            certificate_pem=certificate.public_bytes(serialization.Encoding.PEM).decode("ascii"),
            ca_pem=self.ca_pem() or "",
            not_after=certificate.not_valid_after_utc,
            serial=format(certificate.serial_number, "x"),
        )


def new_csr(key: Any = None, common_name: str = "stowly-drucker") -> tuple[Any, str]:
    key = key or ec.generate_private_key(ec.SECP256R1())
    request = (
        x509.CertificateSigningRequestBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)]))
        .sign(key, hashes.SHA256())
    )
    return key, request.public_bytes(serialization.Encoding.PEM).decode("ascii")


# --- Aufbau --------------------------------------------------------------------------------------


@pytest.fixture
def bundle_file(tmp_path: Path) -> Path:
    path = tmp_path / "pi-bundle.tar.gz"
    path.write_bytes(b"ein-paket")
    return path


@pytest.fixture
def settings(tmp_path: Path, web_dir: Path, bundle_file: Path) -> Settings:
    return Settings.from_env(
        {
            "STOWLY_DATA_DIR": str(tmp_path / "data"),
            "STOWLY_WEB_DIR": str(web_dir),
            "STOWLY_PASSWORD": TEST_PASSWORD,
            "STOWLY_OFF_ENABLED": "0",
            "STOWLY_PI_BUNDLE": str(bundle_file),
        },
        dev=False,
    )


@pytest.fixture
def fake_tls() -> FakeTls:
    return FakeTls()


class Clock:
    """Die Uhr der Kopplung (``pairing.now``), von Hand vorzustellen."""

    def __init__(self) -> None:
        start = datetime.now(UTC)
        self.value = start.replace(microsecond=start.microsecond // 1000 * 1000)

    def __call__(self) -> datetime:
        return self.value

    def advance(self, **delta: float) -> None:
        self.value += timedelta(**delta)


@pytest.fixture
def pi_clock(monkeypatch: pytest.MonkeyPatch) -> Clock:
    clock = Clock()
    monkeypatch.setattr(pairing, "now", clock)
    return clock


# Was wizard.certificate_addresses liefert (die Adressen fürs Zertifikat des Servers); Tests ändern es.
CERTIFICATE_ADDRESSES: list[str] = []


@pytest.fixture
def http_origins(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Die Rufe an ``wizard.http_origin`` (Hostnamen); die Ursprünge der App sind ``APP_ORIGINS``."""
    calls: list[str] = []

    def http_origin(_settings: Settings, _con: Any, hostname: str) -> str:
        calls.append(hostname)
        return f"http://{hostname}:8010"

    monkeypatch.setattr(wizard, "app_origins", lambda _settings, _con: list(APP_ORIGINS))
    monkeypatch.setattr(wizard, "certificate_addresses", lambda _con: list(CERTIFICATE_ADDRESSES))
    monkeypatch.setattr(wizard, "http_origin", http_origin)
    return calls


@pytest.fixture
def client(
    settings: Settings, fake_tls: FakeTls, http_origins: list[str], pi_clock: Clock
) -> Iterator[TestClient]:
    # Alle Anfragen kommen von der Adresse des Pi; der Browser schickt nichts, was davon abhängt.
    with TestClient(create_app(settings), client=(PI_IP, 50000)) as test_client:
        test_client.app.state.tls = fake_tls
        yield test_client


@pytest.fixture
def device(client: TestClient) -> Device:
    return Device(client, "Handy")


def create(client: TestClient, device: Device, **body: Any) -> Any:
    body.setdefault("origin", HTTP_ORIGIN)
    return client.post("/api/pi/pairings", json=body, headers=device.headers)


def code_of(response: Any) -> str:
    assert response.status_code == 201, response.text
    return response.json()["code"]


def pair_body(code: str, csr: str, **extra: Any) -> dict[str, Any]:
    body = {
        "code": code,
        "hostname": "stowly-drucker",
        "addresses": ["192.168.1.20"],
        "csr": csr,
        "token": TOKEN,
        "model": "QL-570",
        "printer_found": True,
        "printer_id": None,
        "version": "0.3.0",
    }
    body.update(extra)
    return body


def pair(client: TestClient, body: dict[str, Any]) -> Any:
    return client.post("/api/pi/pair", json=body, headers={"Host": PI_HOST})


def events_of(con: Any, type_: str) -> list[Any]:
    return con.execute("SELECT * FROM events WHERE type = ? ORDER BY id", (type_,)).fetchall()


def printer_row(con: Any, printer_id: str) -> Any:
    return con.execute("SELECT * FROM printers WHERE id = ?", (printer_id,)).fetchone()


# --- Code erzeugen -------------------------------------------------------------------------------


def test_a_new_code_comes_with_the_command_and_only_its_hash_is_stored(client, device, con, pi_clock):
    response = create(client, device)
    assert response.status_code == 201, response.text
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    code = body["code"]
    assert len(code) == 9 and code[4] == "-"
    assert all(char in pi_side.CODE_ALPHABET for char in code.replace("-", ""))
    assert body["command"] == f"curl -fsSL {HTTP_ORIGIN}/api/pi/install.sh | sudo sh -s -- {code}"
    assert body["state"] == "waiting"
    assert body["pi"] is None and body["printer_id"] is None
    assert parse_timestamp(body["expires_at"]) == pi_clock() + timedelta(seconds=PI_PAIRING_TTL_S)

    row = con.execute("SELECT * FROM pi_pairings WHERE id = ?", (body["id"],)).fetchone()
    assert row["code_hash"] == hashlib.sha256(code.replace("-", "").encode()).hexdigest()
    assert row["device_id"] == device.id and row["origin"] == HTTP_ORIGIN
    plain = code.replace("-", "")
    assert not any(plain in str(value) for value in tuple(row))
    (created,) = events_of(con, "pi_pairing.created")
    assert (created["device_id"], created["entity"], created["entity_id"]) == (
        device.id,
        "pi_pairing",
        body["id"],
    )
    assert json.loads(created["data"]) == {"printer_id": None}
    assert created["command_id"] is None


def test_over_https_the_command_uses_the_http_address_of_the_same_host(client, device, http_origins):
    response = create(client, device, origin="https://nas.local:8443")
    assert response.status_code == 201, response.text
    assert http_origins == ["nas.local"]
    assert response.json()["command"].startswith(
        "curl -fsSL http://nas.local:8010/api/pi/install.sh | sudo sh"
    )
    ipv6 = create(client, device, origin="https://[fd00::10]:8443")
    assert ipv6.status_code == 201, ipv6.text
    assert http_origins[-1] == "[fd00::10]"


@pytest.mark.parametrize(
    "origin",
    [
        "ftp://192.168.1.10",
        "http://192.168.1.10:8010/",
        "http://192.168.1.10/einrichtung",
        "https://nutzer@nas.local",
        "http://192.168.1.10:0",
        "http://192.168.1.10:70000",
        "http://[zz::1]:8010",
        "http://nas..local",
        "http://-nas.local",
        "https://nas.local?x=1",
        "nas.local",
    ],
)
def test_an_origin_that_is_none_is_refused(client, device, origin):
    response = create(client, device, origin=origin)
    assert response.status_code == 422, response.text
    assert response.json()["error"]["details"]["errors"][0]["loc"] == ["body", "origin"]


def test_only_an_existing_direct_printer_can_be_taken_over(client, device):
    direct, server, deleted = ids.new_uuid(), ids.new_uuid(), ids.new_uuid()
    device.sync(
        [
            device.cmd(
                "printer.create",
                printer_id=direct,
                name="Keller",
                connection="direct",
                direct={"urls": ["http://10.71.83.1:8080"], "token": "x" * 20, "printer": None},
            ),
            device.cmd(
                "printer.create",
                printer_id=server,
                name="Büro",
                connection="server",
                server={"driver": "image", "model": None, "address": None, "media": "62"},
            ),
            device.cmd(
                "printer.create",
                printer_id=deleted,
                name="Alt",
                connection="direct",
                direct={"urls": ["http://10.71.83.1:8080"], "token": "y" * 20, "printer": None},
            ),
            device.cmd("printer.delete", printer_id=deleted),
        ]
    )
    assert create(client, device, printer_id=direct).status_code == 201
    for wrong in (server, deleted, ids.new_uuid()):
        response = create(client, device, printer_id=wrong)
        assert response.status_code == 422, wrong
        assert response.json()["error"]["details"]["errors"][0]["loc"] == ["body", "printer_id"]


def test_without_a_bundle_or_a_usable_ca_there_is_no_code(client, device, settings, bundle_file, fake_tls):
    fake_tls.unavailable = "Die CA ist kaputt."
    response = create(client, device)
    assert response.status_code == 503 and response.json()["error"]["code"] == "not_configured"
    fake_tls.unavailable = None
    client.app.state.tls = None
    assert create(client, device).status_code == 503
    client.app.state.tls = fake_tls
    client.app.state.settings = Settings.from_env(
        {
            "STOWLY_DATA_DIR": str(settings.data_dir),
            "STOWLY_WEB_DIR": str(settings.web_dir),
            "STOWLY_PASSWORD": TEST_PASSWORD,
            "STOWLY_OFF_ENABLED": "0",
            "STOWLY_PI_BUNDLE": str(bundle_file.with_name("fehlt.tar.gz")),
        },
        dev=False,
    )
    response = create(client, device)
    assert response.status_code == 503
    assert "Paket" in response.json()["error"]["message"]


def test_creating_a_code_needs_a_device(client):
    assert client.post("/api/pi/pairings", json={"origin": HTTP_ORIGIN}).status_code == 401


# --- Stand und Abbrechen -------------------------------------------------------------------------


def test_a_new_code_cancels_the_waiting_ones(client, device, con):
    first = create(client, device).json()
    assert (
        client.post("/api/pi/pair/start", json={"code": first["code"], "hostname": "pi"}).status_code == 204
    )
    second = create(client, device).json()
    states = {
        pairing_id: client.get(f"/api/pi/pairings/{pairing_id}", headers=device.headers).json()["state"]
        for pairing_id in (first["id"], second["id"])
    }
    assert states == {first["id"]: "cancelled", second["id"]: "waiting"}
    (cancelled,) = events_of(con, "pi_pairing.cancelled")
    assert cancelled["entity_id"] == first["id"] and cancelled["device_id"] == device.id
    assert json.loads(cancelled["data"]) == {"reason": "replaced"}
    # Der alte Code gilt nicht mehr.
    late = client.post("/api/pi/pair/start", json={"code": first["code"], "hostname": "pi"})
    assert late.status_code == 409


def test_the_state_without_code_and_command(client, device, pi_clock):
    created = create(client, device).json()
    response = client.get(f"/api/pi/pairings/{created['id']}", headers=device.headers)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {**created, "code": None, "command": None}
    pi_clock.advance(seconds=PI_PAIRING_TTL_S)
    assert (
        client.get(f"/api/pi/pairings/{created['id']}", headers=device.headers).json()["state"] == "expired"
    )
    assert client.get(f"/api/pi/pairings/{ids.new_uuid()}", headers=device.headers).status_code == 404
    assert client.get(f"/api/pi/pairings/{created['id']}").status_code == 401


def test_cancel_is_repeatable_and_leaves_finished_ones(client, device, con):
    created = create(client, device).json()
    for _ in range(2):
        assert client.delete(f"/api/pi/pairings/{created['id']}", headers=device.headers).status_code == 204
    assert (
        client.get(f"/api/pi/pairings/{created['id']}", headers=device.headers).json()["state"] == "cancelled"
    )
    (event,) = events_of(con, "pi_pairing.cancelled")
    assert json.loads(event["data"]) == {"reason": "user"} and event["device_id"] == device.id
    assert client.delete(f"/api/pi/pairings/{ids.new_uuid()}", headers=device.headers).status_code == 404

    paired = create(client, device).json()
    _key, csr = new_csr()
    assert pair(client, pair_body(paired["code"], csr)).status_code == 200
    assert client.delete(f"/api/pi/pairings/{paired['id']}", headers=device.headers).status_code == 204
    assert client.get(f"/api/pi/pairings/{paired['id']}", headers=device.headers).json()["state"] == "paired"


# --- Der Pi meldet sich ----------------------------------------------------------------------------


def test_the_pi_reports_and_gets_another_thirty_minutes(client, device, pi_clock):
    created = create(client, device).json()
    pi_clock.advance(minutes=20)
    response = client.post(
        "/api/pi/pair/start", json={"code": created["code"], "hostname": "stowly-drucker", "version": "0.3.0"}
    )
    assert response.status_code == 204, response.text
    state = client.get(f"/api/pi/pairings/{created['id']}", headers=device.headers).json()
    assert state["state"] == "installing"
    assert parse_timestamp(state["expires_at"]) == pi_clock() + timedelta(seconds=PI_PAIRING_TTL_S)
    assert state["pi"] == {
        "hostname": "stowly-drucker",
        "addresses": [],
        "model": None,
        "printer_found": False,
        "version": "0.3.0",
        "not_after": None,
    }
    pi_clock.advance(minutes=25)  # ohne die Verlängerung wäre er jetzt abgelaufen
    assert (
        client.get(f"/api/pi/pairings/{created['id']}", headers=device.headers).json()["state"]
        == "installing"
    )


@pytest.mark.parametrize("spelling", ["lower", "spaces", "lookalikes"])
def test_codes_are_read_generously(client, device, spelling):
    code = code_of(create(client, device))
    plain = code.replace("-", "")
    if spelling == "lower":
        text = code.lower()
    elif spelling == "spaces":
        text = f" {plain[:4]} {plain[4:]} "
    else:
        text = plain.replace("0", "O").replace("1", "l")
    response = client.post("/api/pi/pair/start", json={"code": text, "hostname": "pi"})
    assert response.status_code == 204, (text, response.text)


def test_unknown_expired_cancelled_and_used_codes_each_say_why(client, device, pi_clock):
    unknown = client.post("/api/pi/pair/start", json={"code": "ZZZZ-ZZZZ", "hostname": "pi"})
    assert unknown.status_code == 404 and unknown.json()["error"]["message"] == pairing.UNKNOWN_CODE
    not_a_code = client.post("/api/pi/pair/start", json={"code": "UUUU-UUUU", "hostname": "pi"})
    assert not_a_code.status_code == 404

    cancelled = create(client, device).json()
    client.delete(f"/api/pi/pairings/{cancelled['id']}", headers=device.headers)
    messages = {}
    response = client.post("/api/pi/pair/start", json={"code": cancelled["code"], "hostname": "pi"})
    assert response.status_code == 409
    messages["cancelled"] = response.json()["error"]["message"]

    used = code_of(create(client, device))
    _key, csr = new_csr()
    assert pair(client, pair_body(used, csr)).status_code == 200
    response = client.post("/api/pi/pair/start", json={"code": used, "hostname": "pi"})
    assert response.status_code == 409
    messages["used"] = response.json()["error"]["message"]

    expired = code_of(create(client, device))
    pi_clock.advance(seconds=PI_PAIRING_TTL_S + 1)
    response = pair(client, pair_body(expired, new_csr()[1]))
    assert response.status_code == 409
    messages["expired"] = response.json()["error"]["message"]
    assert messages == {"cancelled": pairing.CANCELLED, "used": pairing.USED, "expired": pairing.EXPIRED}


# --- Koppeln -------------------------------------------------------------------------------------


def certificate_of(result: dict[str, Any]) -> x509.Certificate:
    return x509.load_pem_x509_certificate(result["certificate"].encode("ascii"))


def test_pairing_signs_the_request_and_the_printer_comes_by_sync(client, device, con, fake_tls, pi_clock):
    created = create(client, device).json()
    key, csr = new_csr()
    response = pair(
        client, pair_body(created["code"], csr, addresses=["192.168.1.20", "10.0.0.7", "192.168.1.20"])
    )
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    result = response.json()

    # Zertifikat: von der CA, für den Schlüssel des Pi, mit genau diesen Adressen.
    certificate = certificate_of(result)
    assert certificate.public_key().public_numbers() == key.public_key().public_numbers()
    assert certificate.issuer == fake_tls.ca_certificate.subject
    sans = certificate.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    # Nur die Adresse, von der die Anfrage kam, dazu die des eigenen WLANs; 10.0.0.7 meldet der Pi nur.
    assert [str(ip) for ip in sans.get_values_for_type(x509.IPAddress)] == ["192.168.1.20", "10.71.83.1"]
    assert sans.get_values_for_type(x509.DNSName) == ["stowly-drucker.local"]
    assert fake_tls.calls == [
        {"ips": ["192.168.1.20", "10.71.83.1"], "dns": ["stowly-drucker.local"], "days": PI_CERT_DAYS}
    ]
    assert result["ca"] == fake_tls.ca_pem()
    assert result["origins"] == [HTTP_ORIGIN, *APP_ORIGINS]
    assert result["urls"] == [
        "https://192.168.1.20:8443",
        "https://stowly-drucker.local:8443",
        "http://192.168.1.20:8080",
    ]
    assert result["not_after"] == format_timestamp(certificate.not_valid_after_utc)
    assert result["name"] == "QL-570"

    # Der Drucker: neu, direkt, mit dem Token des Pi, ohne Feld-Uhr und ohne Befehl.
    printer = printer_row(con, result["printer_id"])
    assert (printer["name"], printer["connection"], printer["deleted_at"]) == ("QL-570", "direct", None)
    assert json.loads(printer["config"]) == {"urls": result["urls"], "token": TOKEN, "printer": None}
    stamp = format_timestamp(pi_clock())
    assert printer["created_at"] == printer["updated_at"] == stamp
    clocks = con.execute(
        "SELECT * FROM field_clocks WHERE entity = 'printer' AND entity_id = ?", (printer["id"],)
    )
    assert clocks.fetchall() == []
    assert con.execute("SELECT count(*) FROM commands").fetchone()[0] == 0

    # Er kommt wie jeder Drucker über den Sync.
    device.sync()
    synced = device.printers[result["printer_id"]]
    assert synced["direct"] == {"urls": result["urls"], "token": TOKEN, "printer": None}
    assert synced["name"] == "QL-570"

    # Ereignis ohne Gerät, ohne Befehl, ohne Token.
    (event,) = events_of(con, "printer.paired")
    assert (event["device_id"], event["command_id"], event["entity_id"]) == (None, None, result["printer_id"])
    data = json.loads(event["data"])
    assert TOKEN not in event["data"]
    assert data == {
        "created": True,
        "name": "QL-570",
        "direct": {"urls": result["urls"], "printer": None},
        "token_changed": False,
        "hostname": "stowly-drucker",
        "addresses": ["192.168.1.20", "10.0.0.7"],
        "sans": ["192.168.1.20", "10.71.83.1", "stowly-drucker.local"],
        "serial": format(certificate.serial_number, "x"),
        "not_after": result["not_after"],
        "pairing_id": created["id"],
    }

    # Die App sieht die Kopplung als fertig, mit Pi und Drucker.
    state = client.get(f"/api/pi/pairings/{created['id']}", headers=device.headers).json()
    assert state["state"] == "paired" and state["printer_id"] == result["printer_id"]
    assert state["pi"] == {
        "hostname": "stowly-drucker",
        "addresses": ["192.168.1.20", "10.0.0.7"],
        "model": "QL-570",
        "printer_found": True,
        "version": "0.3.0",
        "not_after": result["not_after"],
    }


def test_without_a_model_the_printer_is_named_after_the_pi(client, device):
    code = code_of(create(client, device))
    response = pair(
        client, pair_body(code, new_csr()[1], model=None, printer_found=False, hostname="Keller-Pi")
    )
    assert response.status_code == 200, response.text
    assert response.json()["name"] == "keller-pi"
    # Kein Name im Zertifikat: Er beginnt nicht mit stowly.
    assert response.json()["urls"] == ["https://192.168.1.20:8443", "http://192.168.1.20:8080"]


def test_only_hostnames_starting_with_stowly_get_their_local_name(client, device, fake_tls):
    for hostname, expected in (
        ("Stowly-Keller", ["stowly-keller.local"]),
        ("homeassistant", []),
        ("diskstation", []),
    ):
        code = code_of(create(client, device))
        response = pair(client, pair_body(code, new_csr()[1], hostname=hostname))
        assert response.status_code == 200, response.text
        sans = certificate_of(response.json()).extensions.get_extension_for_class(x509.SubjectAlternativeName)
        assert sans.value.get_values_for_type(x509.DNSName) == expected, hostname
        assert fake_tls.calls[-1]["dns"] == expected
        locals_ = [url for url in response.json()["urls"] if ".local" in url]
        assert locals_ == [f"https://{name}:8443" for name in expected]


def test_the_same_request_again_gets_the_same_answer(client, device, con, fake_tls, pi_clock):
    code = code_of(create(client, device))
    _key, csr = new_csr()
    first = pair(client, pair_body(code, csr))
    assert first.status_code == 200
    again = pair(client, pair_body(code, csr.replace("\n", "\r\n")))
    assert again.status_code == 200 and again.json() == first.json()
    assert len(fake_tls.calls) == 1
    assert con.execute("SELECT count(*) FROM printers").fetchone()[0] == 1
    other = pair(client, pair_body(code, new_csr()[1]))
    assert other.status_code == 409 and other.json()["error"]["message"] == pairing.USED
    pi_clock.advance(seconds=PI_PAIRING_TTL_S + 1)
    assert pair(client, pair_body(code, csr)).status_code == 409


@pytest.mark.parametrize(
    ("change", "loc"),
    [
        ({"addresses": ["8.8.8.8"]}, ["body", "addresses", 0]),
        ({"addresses": ["192.168.1.20", "127.0.0.1"]}, ["body", "addresses", 1]),
        ({"addresses": ["169.254.10.1"]}, ["body", "addresses", 0]),
        ({"addresses": ["192.168.1.10"]}, ["body", "addresses", 0]),  # die App selbst
        ({"addresses": ["192.168.1.30"]}, ["body", "addresses", 0]),  # so erreicht der Pi den Server
        ({"addresses": ["192.168.001.20"]}, ["body", "addresses", 0]),
        ({"hostname": "stowly"}, ["body", "hostname"]),  # stowly.local ist ein Name der App
        (
            {"csr": "-----BEGIN CERTIFICATE REQUEST-----\nkaputt\n-----END CERTIFICATE REQUEST-----\n"},
            ["body", "csr"],
        ),
    ],
)
def test_what_may_not_go_into_the_certificate_is_refused(client, device, fake_tls, change, loc):
    code = code_of(create(client, device))
    body = {**pair_body(code, new_csr()[1]), **change}
    response = client.post("/api/pi/pair", json=body, headers={"Host": "192.168.1.30:8010"})
    assert response.status_code == 422, response.text
    assert response.json()["error"]["details"]["errors"][0]["loc"] == loc
    if loc[1] != "csr":
        assert fake_tls.calls == []


def test_an_rsa_request_works_too(client, device):
    code = code_of(create(client, device))
    _key, csr = new_csr(rsa.generate_private_key(public_exponent=65537, key_size=2048))
    assert pair(client, pair_body(code, csr)).status_code == 200


def test_without_a_ca_pairing_is_503_and_the_code_stays_valid(client, device, fake_tls):
    code = code_of(create(client, device))
    fake_tls.unavailable = "Die CA fehlt."
    response = pair(client, pair_body(code, new_csr()[1]))
    assert response.status_code == 503 and response.json()["error"]["code"] == "not_configured"
    fake_tls.unavailable = None
    assert pair(client, pair_body(code, new_csr()[1])).status_code == 200


# --- Drucker übernehmen ----------------------------------------------------------------------------


def make_direct_printer(device: Device, *, name: str = "Keller", token: str = "alt-token-0123456789") -> str:
    printer_id = ids.new_uuid()
    results = device.sync(
        [
            device.cmd(
                "printer.create",
                printer_id=printer_id,
                name=name,
                connection="direct",
                direct={"urls": ["https://10.71.83.1:8443"], "token": token, "printer": "keller"},
                age=60,
            )
        ]
    )["results"]
    assert results[0]["status"] == "applied", results
    return printer_id


def test_the_chosen_printer_is_taken_over_and_only_its_connection_changes(client, device, con, pi_clock):
    printer_id = make_direct_printer(device)
    before = printer_row(con, printer_id)
    created = create(client, device, printer_id=printer_id).json()
    assert created["printer_id"] == printer_id
    result = pair(client, pair_body(created["code"], new_csr()[1])).json()
    assert result["printer_id"] == printer_id and result["name"] == "Keller"

    after = printer_row(con, printer_id)
    assert after["name"] == "Keller" and after["created_at"] == before["created_at"]
    # Der Name des Druckers im Druckdienst bleibt, Adressen und Token sind neu.
    assert json.loads(after["config"]) == {"urls": result["urls"], "token": TOKEN, "printer": "keller"}
    stamp = format_timestamp(pi_clock())
    assert after["updated_at"] == stamp and after["rev"] > before["rev"]
    clock = con.execute(
        "SELECT at FROM field_clocks WHERE entity = 'printer' AND entity_id = ? AND field = 'direct'",
        (printer_id,),
    ).fetchone()
    assert clock["at"] == stamp
    data = json.loads(events_of(con, "printer.paired")[0]["data"])
    assert (data["created"], data["token_changed"], data["name"]) == (False, True, "Keller")

    # Eine ältere Änderung eines Geräts (offline gemacht) überschreibt die Kopplung nicht.
    device.sync()
    stale = device.cmd(
        "printer.update",
        printer_id=printer_id,
        changes={"direct": {"urls": ["http://10.71.83.1:8080"], "token": "x" * 20, "printer": None}},
        age=30,
    )
    device.sync([stale])
    assert json.loads(printer_row(con, printer_id)["config"])["token"] == TOKEN
    assert device.printers[printer_id]["direct"]["token"] == TOKEN


def test_the_choice_of_the_app_beats_the_printer_of_the_pi(client, device, con):
    chosen = make_direct_printer(device, name="Gewählt")
    remembered = make_direct_printer(device, name="Gemerkt")
    code = code_of(create(client, device, printer_id=chosen))
    result = pair(client, pair_body(code, new_csr()[1], printer_id=remembered)).json()
    assert result["printer_id"] == chosen


def test_the_printer_of_the_pi_counts_when_the_app_chose_none(client, device, con):
    remembered = make_direct_printer(device, name="Gemerkt", token=TOKEN)
    code = code_of(create(client, device))
    assert (
        pair(client, pair_body(code, new_csr()[1], printer_id=remembered)).json()["printer_id"] == remembered
    )
    # Ein gelöschter Drucker kommt nicht wieder: Dann entsteht ein neuer.
    device.sync([device.cmd("printer.delete", printer_id=remembered)])
    code = code_of(create(client, device))
    result = pair(client, pair_body(code, new_csr()[1], printer_id=remembered)).json()
    assert result["printer_id"] != remembered
    assert printer_row(con, remembered)["deleted_at"] is not None


# --- Bremse --------------------------------------------------------------------------------------


def test_ten_failures_lock_pairing_for_a_minute(client, device):
    good = code_of(create(client, device))
    for attempt in range(10):
        endpoint = "/api/pi/pair/start" if attempt % 2 else "/api/pi/pair"
        body = {"code": "ZZZZ-ZZZZ", "hostname": "pi"}
        if endpoint == "/api/pi/pair":
            body = pair_body("ZZZZ-ZZZZ", new_csr()[1])
        assert client.post(endpoint, json=body).status_code == 404
    locked = client.post("/api/pi/pair/start", json={"code": good, "hostname": "pi"})
    assert locked.status_code == 429
    assert locked.headers["retry-after"] == "60"
    assert locked.json()["error"]["details"] == {"retry_after_s": 60}
    # Die Anmeldung der App bremst das nicht.
    assert Device(client, "Zweites Handy").token


def test_the_guard_has_its_own_limits_and_is_made_once(client):
    state = client.app.state
    guard = pairing.guard(state)
    assert pairing.guard(state) is guard
    assert (guard.max_failures, guard.window_s, guard.lock_s) == (10, 600.0, 60.0)
    assert guard is not state.login_guard


def test_a_success_resets_the_guard_and_503_does_not_count(client, device, fake_tls):
    for _ in range(9):
        assert (
            client.post("/api/pi/pair/start", json={"code": "ZZZZ-ZZZZ", "hostname": "pi"}).status_code == 404
        )
    code = code_of(create(client, device))
    fake_tls.unavailable = "keine CA"
    for _ in range(3):
        assert pair(client, pair_body(code, new_csr()[1])).status_code == 503
    fake_tls.unavailable = None
    assert client.post("/api/pi/pair/start", json={"code": code, "hostname": "pi"}).status_code == 204
    for _ in range(9):
        assert (
            client.post("/api/pi/pair/start", json={"code": "ZZZZ-ZZZZ", "hostname": "pi"}).status_code == 404
        )
    assert pair(client, pair_body(code, new_csr()[1])).status_code == 200


# --- Startskript und Paket -----------------------------------------------------------------------


def test_the_start_script_knows_this_server_and_the_bundle(client, bundle_file):
    response = client.get("/api/pi/install.sh", headers={"Host": PI_HOST})
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/x-shellscript")
    assert response.headers["cache-control"] == "no-store"
    script = response.text
    assert f"server='http://{PI_HOST}'" in script
    assert f"sha256='{hashlib.sha256(bundle_file.read_bytes()).hexdigest()}'" in script

    bundle = client.get("/api/pi/bundle.tar.gz")
    assert bundle.status_code == 200
    assert bundle.headers["content-type"] == "application/gzip"
    assert bundle.content == bundle_file.read_bytes()
    assert client.get("/api/pi/install.sh", headers={"Host": "[fd00::10]:8010"}).status_code == 200


@pytest.mark.parametrize(
    "host", ["192.168.1.10:8010'", "a b", "nas.local:99999", "[zz::1]:8010", "nas.local:8010/x", "nas_local"]
)
def test_a_host_that_is_no_address_gets_no_script(client, host):
    response = client.get("/api/pi/install.sh", headers={"Host": host})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_request"


def test_without_a_bundle_both_answer_503(client, settings, bundle_file):
    client.app.state.settings = Settings.from_env(
        {
            "STOWLY_DATA_DIR": str(settings.data_dir),
            "STOWLY_PASSWORD": TEST_PASSWORD,
            "STOWLY_OFF_ENABLED": "0",
            "STOWLY_PI_BUNDLE": str(bundle_file.with_name("fehlt.tar.gz")),
        },
        dev=False,
    )
    assert client.get("/api/pi/install.sh", headers={"Host": PI_HOST}).status_code == 503
    assert client.get("/api/pi/bundle.tar.gz").status_code == 503


def test_in_the_source_checkout_the_server_builds_the_bundle(
    tmp_path, web_dir, fake_tls, http_origins, pi_clock
):
    settings = Settings.from_env(
        {
            "STOWLY_DATA_DIR": str(tmp_path / "data"),
            "STOWLY_WEB_DIR": str(web_dir),
            "STOWLY_PASSWORD": TEST_PASSWORD,
            "STOWLY_OFF_ENABLED": "0",
        },
        dev=False,
    )
    with TestClient(create_app(settings)) as test_client:
        response = test_client.get("/api/pi/bundle.tar.gz")
        assert response.status_code == 200
        assert response.content[:2] == b"\x1f\x8b"
        script = test_client.get("/api/pi/install.sh", headers={"Host": PI_HOST}).text
        assert hashlib.sha256(response.content).hexdigest() in script


# --- Der echte Pi-Teil gegen diesen Server ---------------------------------------------------------


def server_post(client: TestClient, ip: str = PI_IP) -> Callable[[str, dict[str, Any]], pi_side.Reply]:
    """``stowly_print.pairing.http_post``, aber über einen Test-Client von der Adresse ``ip``."""
    from_pi = TestClient(client.app, client=(ip, 50000))

    def post(url: str, payload: dict[str, Any]) -> pi_side.Reply:
        response = from_pi.post(urlsplit(url).path, json=payload, headers={"Host": PI_HOST})
        body = response.json() if response.content else None
        return pi_side.Reply(response.status_code, {k.lower(): v for k, v in response.headers.items()}, body)

    return post


def csr_maker() -> Callable[[Path, str], tuple[bytes, str]]:
    """openssl, wenn es da ist (wie auf dem Pi), sonst derselbe Antrag aus ``cryptography``."""
    if shutil.which("openssl"):
        return pi_side.make_key_and_csr

    def make(_folder: Path, hostname: str) -> tuple[bytes, str]:
        key, csr = new_csr(common_name=hostname)
        pem = key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
        )
        return pem, csr

    return make


def fake_sysfs(root: Path, product: str = "2028") -> Path:
    device = root / "1-1"
    interface = device / "1-1.1.0"
    interface.mkdir(parents=True)
    (device / "idVendor").write_text("04f9\n")
    (device / "idProduct").write_text(f"{product}\n")
    (interface / "bInterfaceClass").write_text("07\n")
    return root


def test_a_pi_pairs_end_to_end(client, device, con, tmp_path, fake_tls):
    created = create(client, device).json()
    paths = pi_side.Paths(
        config=tmp_path / "etc" / "stowly-print.toml",
        tls=tmp_path / "etc" / "tls",
        state=tmp_path / "etc" / "pairing.json",
        sysfs=fake_sysfs(tmp_path / "sys"),
    )
    post = server_post(client)
    assert pi_side.announce("http://192.168.1.10:8010", created["code"], post=post, hostname="stowly-drucker")
    assert (
        client.get(f"/api/pi/pairings/{created['id']}", headers=device.headers).json()["state"]
        == "installing"
    )

    outcome = pi_side.pair(
        "http://192.168.1.10:8010",
        created["code"].lower(),
        origins=["https://stowly.home"],
        paths=paths,
        post=post,
        hostname="stowly-drucker",
        addresses=["192.168.1.20", "172.17.0.1", "127.0.0.1", "10.71.83.1"],
        make_csr=csr_maker(),
    )
    assert outcome.model == "QL-570" and outcome.printer_name == "QL-570"
    assert outcome.addresses == ["192.168.1.20", "172.17.0.1"]
    assert outcome.origins == [HTTP_ORIGIN, *APP_ORIGINS, "https://stowly.home"]

    # Der Server hat den Drucker mit dem Token aus der Konfiguration des Pi.
    config = pi_side.load_config(paths.config)
    printer = printer_row(con, outcome.printer_id)
    assert json.loads(printer["config"])["token"] == config.token
    assert config.https is not None and config.https.certificate == paths.tls / "pi.crt"
    assert config.printers[0].model == "QL-570"
    # Das Zertifikat passt zum Schlüssel und ist von der CA.
    certificate = x509.load_pem_x509_certificate((paths.tls / "pi.crt").read_bytes())
    assert certificate.issuer == fake_tls.ca_certificate.subject
    assert (paths.tls / "ca.crt").read_text() == fake_tls.ca_pem()
    state = json.loads(paths.state.read_text())
    assert state["printer_id"] == outcome.printer_id and state["server"] == "http://192.168.1.10:8010"
    assert config.token not in paths.state.read_text()


def test_a_second_pairing_of_the_same_pi_keeps_printer_and_token(client, device, con, tmp_path):
    paths = pi_side.Paths(
        config=tmp_path / "etc" / "stowly-print.toml",
        tls=tmp_path / "etc" / "tls",
        state=tmp_path / "etc" / "pairing.json",
        sysfs=fake_sysfs(tmp_path / "sys"),
    )
    common = {"paths": paths, "hostname": "stowly-drucker", "make_csr": csr_maker()}
    first = pi_side.pair(
        HTTP_ORIGIN,
        code_of(create(client, device)),
        addresses=["192.168.1.20"],
        post=server_post(client),
        **common,
    )
    token = pi_side.load_config(paths.config).token
    # Neue IP-Adresse, neuer Code: derselbe Drucker in Stowly (aus pairing.json, mit demselben Token).
    second = pi_side.pair(
        HTTP_ORIGIN,
        code_of(create(client, device)),
        addresses=["192.168.1.21"],
        post=server_post(client, "192.168.1.21"),
        **common,
    )
    assert second.printer_id == first.printer_id
    assert pi_side.load_config(paths.config).token == token
    assert json.loads(printer_row(con, first.printer_id)["config"])["urls"][0] == "https://192.168.1.21:8443"
    assert (paths.tls / "pi.crt.bak").exists() and (paths.config.with_name("stowly-print.toml.bak")).exists()
    assert not second.token_new


# --- Nur was der Server selbst sieht (Prüfung der Sicherheit, Runde 2) -------------------------------


def pair_from(client: TestClient, ip: str, body: dict[str, Any]) -> Any:
    """Eine Kopplung von einer anderen Adresse aus (``request.client``)."""
    return TestClient(client.app, client=(ip, 50000)).post(
        "/api/pi/pair", json=body, headers={"Host": PI_HOST}
    )


def test_a_pi_that_reports_another_address_than_it_comes_from_gets_nothing(client, device, fake_tls):
    code = code_of(create(client, device))
    body = pair_body(code, new_csr()[1], addresses=["192.168.1.20"])
    response = pair_from(client, "192.168.1.30", body)
    assert response.status_code == 422, response.text
    (problem,) = response.json()["error"]["details"]["errors"]
    assert problem["loc"] == ["body", "addresses"]
    assert (
        problem["msg"]
        == "Stowly sieht den Pi unter einer anderen Adresse (192.168.1.30) als er meldet (192.168.1.20)."
    )
    # Ohne erkennbare IPv4-Adresse (etwa hinter einem Proxy mit Namen) ebenso.
    unknown = pair_from(client, "testclient", body)
    assert unknown.status_code == 422
    assert unknown.json()["error"]["details"]["errors"][0]["msg"] == pairing.NO_SOURCE
    assert fake_tls.calls == []
    # IPv4 in IPv6 gilt als IPv4.
    assert pair_from(client, "::ffff:192.168.1.20", body).status_code == 200


def test_reported_addresses_other_than_the_source_are_never_signed(client, device, fake_tls):
    code = code_of(create(client, device))
    body = pair_body(code, new_csr()[1], addresses=["192.168.1.1", "192.168.1.20", "10.0.0.1", "172.16.0.1"])
    result = pair(client, body).json()
    sans = certificate_of(result).extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    assert [str(ip) for ip in sans.get_values_for_type(x509.IPAddress)] == ["192.168.1.20", "10.71.83.1"]
    assert result["urls"][0] == "https://192.168.1.20:8443"
    assert fake_tls.calls[0]["ips"] == ["192.168.1.20", "10.71.83.1"]


def test_addresses_of_the_server_are_refused_even_without_https(client, device, fake_tls, monkeypatch):
    # Ohne HTTPS-Listener liefert app_origins nichts; gesperrt bleiben die Adressen fürs Zertifikat.
    monkeypatch.setattr(wizard, "app_origins", lambda _settings, _con: [])
    monkeypatch.setattr(wizard, "certificate_addresses", lambda _con: ["192.168.1.20", "Stowly-NAS.local"])
    code = code_of(create(client, device))
    refused = pair(client, pair_body(code, new_csr()[1]))
    assert refused.status_code == 422, refused.text
    assert refused.json()["error"]["details"]["errors"][0]["msg"] == pairing.APP_ADDRESS
    by_name = pair_from(
        client,
        "192.168.1.21",
        pair_body(code, new_csr()[1], addresses=["192.168.1.21"], hostname="stowly-nas"),
    )
    assert by_name.status_code == 422
    assert by_name.json()["error"]["details"]["errors"][0]["loc"] == ["body", "hostname"]
    assert fake_tls.calls == []


def test_the_names_in_the_certificate_of_the_server_are_refused(client, device, fake_tls):
    key = ec.generate_private_key(ec.SECP256R1())
    now = datetime.now(UTC)
    fake_tls.certificate = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Stowly")]))
        .issuer_name(fake_tls.ca_certificate.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(hours=1))
        .not_valid_after(now + timedelta(days=30))
        .add_extension(
            x509.SubjectAlternativeName(
                [x509.IPAddress(ipaddress.ip_address("192.168.1.20")), x509.DNSName("nas.lan")]
            ),
            critical=False,
        )
        .sign(fake_tls.key, hashes.SHA256())
    )
    code = code_of(create(client, device))
    refused = pair(client, pair_body(code, new_csr()[1]))
    assert refused.status_code == 422
    assert refused.json()["error"]["details"]["errors"][0]["msg"] == pairing.APP_ADDRESS


def test_the_pi_never_takes_over_a_printer_with_another_token(client, device, con):
    foreign = make_direct_printer(device, name="Fremd", token="fremdes-token-0123456789")
    before = printer_row(con, foreign)
    code = code_of(create(client, device))
    result = pair(client, pair_body(code, new_csr()[1], printer_id=foreign)).json()
    assert result["printer_id"] != foreign
    after = printer_row(con, foreign)
    assert (after["config"], after["rev"]) == (before["config"], before["rev"])
    # Die Wahl der App gilt dagegen auch mit anderem Token.
    code = code_of(create(client, device, printer_id=foreign))
    assert pair(client, pair_body(code, new_csr()[1])).json()["printer_id"] == foreign


def test_repeating_an_old_answer_does_not_reset_the_guard(client, device):
    code = code_of(create(client, device))
    _key, csr = new_csr()
    assert pair(client, pair_body(code, csr)).status_code == 200
    for _ in range(9):
        assert (
            client.post("/api/pi/pair/start", json={"code": "ZZZZ-ZZZZ", "hostname": "pi"}).status_code == 404
        )
    # Die Wiederholung bekommt ihre Antwort, setzt die Fehlversuche aber nicht zurück.
    assert pair(client, pair_body(code, csr)).status_code == 200
    assert client.post("/api/pi/pair/start", json={"code": "ZZZZ-ZZZZ", "hostname": "pi"}).status_code == 404
    locked = pair(client, pair_body(code, csr))
    assert locked.status_code == 429


def test_texts_of_the_pi_reach_the_log_only_cleaned(client, device, caplog):
    code = code_of(create(client, device))
    version = "0.3.0\nCRITICAL stowly: gefälscht\u202e"
    with caplog.at_level("INFO", logger="stowly.pi"):
        response = client.post(
            "/api/pi/pair/start", json={"code": code, "hostname": "stowly-pi", "version": version}
        )
    assert response.status_code == 204
    (record,) = [record for record in caplog.records if "meldet sich" in record.getMessage()]
    message = record.getMessage()
    assert "\n" not in message and "\u202e" not in message
    assert "0.3.0 CRITICAL stowly: gefälscht" in message
    assert pairing.loggable("a" * 100) == "a" * pairing.LOGGED_MAX
