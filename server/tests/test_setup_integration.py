"""Die Einrichtung von vorn bis hinten, mit der echten CA (Runde 2, docs/plan-einrichtung.md).

Die Tests der einzelnen Teile ersetzen die CA (``test_pi_pairing``) oder den Pi; hier arbeiten
erstes Passwort, Lernen der Adresse, ``TlsManager``, ``wizard`` und die Kopplung zusammen, so wie
ein frischer Container sie erlebt: ohne Passwort, mit HTTPS-Listener und Paket für den Pi.
"""

import ipaddress
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
from cryptography.x509.verification import PolicyBuilder, Store
from fastapi.testclient import TestClient
from support import Device

from stowly import pairing, tls
from stowly.app import create_app
from stowly.config import Settings

NAS = "192.168.1.10"
PI = "192.168.1.20"  # von hier kommen die Anfragen des Pi; nur diese Adresse kommt in sein Zertifikat
PASSWORD = "ein-gutes-passwort"
TOKEN = "druck-token-0123456789abcdef"


@pytest.fixture
def settings(tmp_path: Path, web_dir: Path) -> Settings:
    bundle = tmp_path / "pi-bundle.tar.gz"
    bundle.write_bytes(b"ein-paket")
    return Settings.from_env(
        {
            "STOWLY_DATA_DIR": str(tmp_path / "data"),
            "STOWLY_WEB_DIR": str(web_dir),
            "STOWLY_OFF_ENABLED": "0",
            "STOWLY_HTTPS_PORT": "8443",
            "STOWLY_PI_BUNDLE": str(bundle),
        },
        dev=False,
    )


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    # Wie ein Browser im Heimnetz, der den Container über HTTP öffnet.
    with TestClient(create_app(settings), base_url=f"http://{NAS}:8010") as test_client:
        yield test_client


def from_pi(client: TestClient, address: str = PI) -> TestClient:
    """Derselbe Server, aber angesprochen vom Pi (``request.client``), so wie im Heimnetz."""
    return TestClient(client.app, base_url=f"http://{NAS}:8010", client=(address, 50000))


def csr_for(name: str = "stowly-pi") -> str:
    key = ec.generate_private_key(ec.SECP256R1())
    request = (
        x509.CertificateSigningRequestBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)]))
        .sign(key, hashes.SHA256())
    )
    return request.public_bytes(serialization.Encoding.PEM).decode("ascii")


def first_password(client: TestClient) -> dict[str, str]:
    response = client.post("/api/setup/password", json={"password": PASSWORD, "device_name": "PC"})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['token']}"}


def pair_body(code: str, **extra: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "code": code,
        "hostname": "stowly-pi",
        "addresses": ["192.168.1.20"],
        "csr": csr_for(),
        "token": TOKEN,
        "model": "QL-570",
        "printer_found": True,
        "version": "0.3.0",
    }
    body.update(extra)
    return body


def test_a_fresh_container_from_first_password_to_a_paired_pi(client: TestClient) -> None:
    # 1. Frisch: kein Passwort.
    assert client.get("/api/health").json()["configured"] is False

    # 2. Das erste Passwort; die Adresse des NAS lernt der Server dabei fürs Zertifikat.
    headers = first_password(client)
    assert client.get("/api/health").json()["configured"] is True

    setup = client.get("/api/setup", headers=headers)
    assert setup.status_code == 200, setup.text
    status = setup.json()
    https = status["https"]
    assert status["password_source"] == "app"
    assert status["finished_at"] is None
    assert status["paired_printers"] == []
    assert [entry["address"] for entry in https["addresses"]] == [NAS]
    assert https["addresses"][0]["in_certificate"] is True
    assert NAS in https["certificate"]["addresses"]
    assert https["ca"]["created_by_stowly"] is True
    assert https["ca"]["name_constraints"] is True
    assert https["http_port"] == 8010
    assert https["port"] == 8443
    assert f"https://{NAS}:8443" in https["origins"]

    # 3. Die CA zum Herunterladen ist dieselbe, die der Status nennt.
    ca_der = client.get("/api/setup/ca.crt")
    assert ca_der.headers["content-type"] == "application/x-x509-ca-cert"
    ca = x509.load_der_x509_certificate(ca_der.content)
    assert tls.fingerprint(ca) == https["ca"]["fingerprint_sha256"]

    # 4. Code erzeugen: Der Befehl zeigt auf die HTTP-Adresse, unter der der Browser den NAS sieht.
    created = client.post("/api/pi/pairings", json={"origin": f"http://{NAS}:8010"}, headers=headers)
    assert created.status_code == 201, created.text
    pairing = created.json()
    assert pairing["command"] == (
        f"curl -fsSL http://{NAS}:8010/api/pi/install.sh | sudo sh -s -- {pairing['code']}"
    )

    # 5. Der Pi meldet sich, dann koppelt er.
    pi = from_pi(client)
    started = pi.post(
        "/api/pi/pair/start", json={"code": pairing["code"], "hostname": "stowly-pi", "version": "0.3.0"}
    )
    assert started.status_code == 204, started.text
    state = client.get(f"/api/pi/pairings/{pairing['id']}", headers=headers).json()
    assert state["state"] == "installing"

    paired = pi.post("/api/pi/pair", json=pair_body(pairing["code"]))
    assert paired.status_code == 200, paired.text
    result = paired.json()

    # 6. Das Zertifikat des Pi stammt von der echten CA und gilt für seine Adressen.
    certificate = x509.load_pem_x509_certificate(result["certificate"].encode("ascii"))
    assert x509.load_pem_x509_certificate(result["ca"].encode("ascii")) == ca
    sans = certificate.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    assert set(sans.get_values_for_type(x509.IPAddress)) == {
        ipaddress.ip_address("192.168.1.20"),
        ipaddress.ip_address("10.71.83.1"),
    }
    assert sans.get_values_for_type(x509.DNSName) == ["stowly-pi.local"]
    store = Store([ca])
    verifier = (
        PolicyBuilder()
        .store(store)
        .time(datetime.now(UTC))
        .build_server_verifier(x509.IPAddress(ipaddress.ip_address("192.168.1.20")))
    )
    verifier.verify(certificate, [])
    assert f"https://{NAS}:8443" in result["origins"]
    assert result["urls"][0] == "https://192.168.1.20:8443"

    # 7. Der Drucker kommt per Sync, und jedes Gerät sieht den Ablauf des Zertifikats.
    phone = Device(client, "Handy", password=PASSWORD)
    phone.sync_all()
    printer = phone.printers[result["printer_id"]]
    assert printer["connection"] == "direct"
    assert printer["direct"]["token"] == TOKEN
    assert printer["direct"]["urls"] == result["urls"]

    status = client.get("/api/setup", headers=headers).json()
    assert status["paired_printers"] == [
        {"printer_id": result["printer_id"], "hostname": "stowly-pi", "not_after": result["not_after"]}
    ]
    ready = {step["id"]: step["ready"] for step in status["steps"]}
    assert ready["printer"] is True
    assert ready["https"] is False  # noch keine Anfrage über den HTTPS-Listener


def test_the_pi_never_gets_an_address_of_the_app(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    headers = first_password(client)
    code = client.post("/api/pi/pairings", json={"origin": f"http://{NAS}:8010"}, headers=headers).json()[
        "code"
    ]
    # Ein „Pi" auf dem NAS selbst bekäme sonst ein Zertifikat für die Adresse der App.
    refused = from_pi(client, NAS).post("/api/pi/pair", json=pair_body(code, addresses=[NAS]))
    assert refused.status_code == 422, refused.text
    # Besteht er die Rückprüfung unter seiner Adresse nicht, ebenso.
    monkeypatch.setattr(pairing, "proves", lambda _address, _token, _digest: False)
    other = from_pi(client, "192.168.1.30").post("/api/pi/pair", json=pair_body(code))
    assert other.status_code == 422, other.text
    monkeypatch.setattr(pairing, "proves", lambda _address, _token, _digest: True)
    # Der Code bleibt gültig: Ein Pi mit richtigen Angaben koppelt danach.
    assert from_pi(client).post("/api/pi/pair", json=pair_body(code)).status_code == 200


def test_the_server_certificate_follows_a_new_address_without_restart(client: TestClient) -> None:
    headers = first_password(client)
    changed = client.patch("/api/setup", json={"addresses": ["nas.fritz.box"]}, headers=headers)
    assert changed.status_code == 200, changed.text
    certificate = changed.json()["https"]["certificate"]
    assert {NAS, "nas.fritz.box"} <= set(certificate["addresses"])
    # Was die CA nicht deckt, lehnt der Server an der Stelle ab.
    outside = client.patch("/api/setup", json={"addresses": ["stowly.example.com"]}, headers=headers)
    assert outside.status_code == 422
    assert outside.json()["error"]["details"]["errors"][0]["loc"] == ["body", "addresses", 0]
