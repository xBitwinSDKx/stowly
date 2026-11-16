"""Web-Push (docs/integrationen.md, Abschnitt 4; docs/sync-protokoll.md, 11.3).

Kein Test geht ins Netz: Die Push-Dienste bildet ``httpx2.MockTransport`` nach. Die Verschlüsselung
rechnet das Beispiel aus RFC 8291, Anhang A, Byte für Byte nach; den Absender (RFC 8292) prüft der
Test, indem er die Signatur mit dem öffentlichen Schlüssel nachrechnet.
"""

import asyncio
import base64
import dataclasses
import hashlib
import hmac
import json
import logging
import time
from datetime import UTC, datetime, timedelta

import httpx2
import pytest
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi.testclient import TestClient
from support import Device

from stowly import db, push
from stowly.app import create_app
from stowly.config import Settings

CONTACT = "mailto:betrieb@example.org"
FCM = "https://fcm.googleapis.com/fcm/send/abc123:def456"


def b64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def b64e(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


# --- RFC 8291, Anhang A ------------------------------------------------------------------------

RFC_PLAINTEXT = "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"
RFC_AS_PUBLIC = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
RFC_AS_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"
RFC_UA_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"
RFC_UA_PRIVATE = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"
RFC_SALT = "DGv6ra1nlYgDCS1FRnbzlw"
RFC_AUTH = "BTBZMqHH6r4Tts7J_aSIgg"
RFC_HEADER = (
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6Tlz"
    "AC8wEqKK6PBru3jl7A8"
)
RFC_CIPHERTEXT = "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ"
# Abschnitt 5 der RFC: dieselbe Nachricht am Stück.
RFC_MESSAGE = (
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8w"
    "EqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
)


def test_rfc_8291_appendix_a_byte_for_byte():
    server_key = push.private_key_from(RFC_AS_PRIVATE)
    assert (
        push.b64url(
            server_key.public_key().public_bytes(
                serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
            )
        )
        == RFC_AS_PUBLIC
    )
    body = push.encrypt(
        b64(RFC_PLAINTEXT), b64(RFC_UA_PUBLIC), b64(RFC_AUTH), salt=b64(RFC_SALT), server_key=server_key
    )
    assert b64(RFC_PLAINTEXT) == b"When I grow up, I want to be a watermelon"
    assert body == b64(RFC_HEADER) + b64(RFC_CIPHERTEXT)
    assert body == b64(RFC_MESSAGE)
    assert decrypt(body, push.private_key_from(RFC_UA_PRIVATE), b64(RFC_AUTH)) == b64(RFC_PLAINTEXT)


def decrypt(body: bytes, ua_key: ec.EllipticCurvePrivateKey, auth: bytes) -> bytes:
    """Was der Browser tut (RFC 8291 von der anderen Seite): zum Prüfen jeder Nachricht."""
    salt, record_size, id_length = body[:16], int.from_bytes(body[16:20], "big"), body[20]
    assert (record_size, id_length) == (4096, 65)
    as_public, ciphertext = body[21:86], body[86:]
    ua_public = ua_key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    secret = ua_key.exchange(
        ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_public)
    )

    def mac(key: bytes, data: bytes) -> bytes:
        return hmac.new(key, data, hashlib.sha256).digest()

    ikm = mac(mac(auth, secret), b"WebPush: info\x00" + ua_public + as_public + b"\x01")
    prk = mac(salt, ikm)
    cek = mac(prk, b"Content-Encoding: aes128gcm\x00\x01")[:16]
    nonce = mac(prk, b"Content-Encoding: nonce\x00\x01")[:12]
    record = AESGCM(cek).decrypt(nonce, ciphertext, None)
    assert record.endswith(b"\x02")  # Trenner des letzten Datensatzes, ohne Auffüllen
    return record[:-1]


def test_every_message_gets_fresh_salt_and_keys():
    browser = ec.generate_private_key(ec.SECP256R1())
    public = browser.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    auth = b"0123456789abcdef"
    first, second = (push.encrypt(b"Hallo", public, auth) for _ in range(2))
    assert first[:16] != second[:16] and first[21:86] != second[21:86]
    assert decrypt(first, browser, auth) == decrypt(second, browser, auth) == b"Hallo"
    with pytest.raises(ValueError):
        push.encrypt(b"x" * (push.MAX_PLAINTEXT + 1), public, auth)
    assert push.MAX_PLAINTEXT == 3993


# --- RFC 8292 (VAPID) --------------------------------------------------------------------------


def verify_jwt(token: str, public_key: str) -> dict:
    """Prüft ein JWT wie ein Push-Dienst: Kopf, Signatur ES256 (rohes r ‖ s) mit dem öffentlichen Schlüssel."""
    header, claims, signature = token.split(".")
    assert json.loads(b64(header)) == {"typ": "JWT", "alg": "ES256"}
    raw = b64(signature)
    assert len(raw) == 64  # r ‖ s, nicht DER
    key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), b64(public_key))
    der = encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
    key.verify(der, f"{header}.{claims}".encode("ascii"), ec.ECDSA(hashes.SHA256()))
    return json.loads(b64(claims))


def test_the_vapid_signature_checks_out_with_the_public_key():
    key = ec.generate_private_key(ec.SECP256R1())
    public = push.b64url(
        key.public_key().public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
        )
    )
    token = push.vapid_jwt(key, aud="https://fcm.googleapis.com", sub=CONTACT, exp=1_800_000_000)
    assert verify_jwt(token, public) == {
        "aud": "https://fcm.googleapis.com",
        "exp": 1_800_000_000,
        "sub": CONTACT,
    }
    # Eine andere Signatur oder ein anderer Inhalt fällt auf.
    header, claims, signature = token.split(".")
    forged = push.b64url(json.dumps({"aud": "https://evil.example", "exp": 1, "sub": CONTACT}).encode())
    with pytest.raises(InvalidSignature):
        verify_jwt(f"{header}.{forged}.{signature}", public)
    assert push.audience(FCM) == "https://fcm.googleapis.com"
    assert push.audience("https://web.push.apple.com:443/QG…") == "https://web.push.apple.com"


# --- Die Endpunkte -----------------------------------------------------------------------------


class PushClock:
    """Uhr des Versands: für das JWT (``now``) und die Bremse der Testnachricht (``monotonic``)."""

    def __init__(self) -> None:
        self.value = datetime(2026, 11, 14, 9, 0, tzinfo=UTC)
        self.mono = 1000.0

    def now(self) -> datetime:
        return self.value

    def monotonic(self) -> float:
        return self.mono

    async def sleep(self, seconds: float) -> None:
        self.mono += seconds

    def advance(self, seconds: float) -> None:
        self.value += timedelta(seconds=seconds)
        self.mono += seconds


class PushService:
    """Nachgebildeter Push-Dienst: merkt sich jede Anfrage und antwortet, wie der Test es will."""

    def __init__(self) -> None:
        self.requests: list[httpx2.Request] = []
        self.answer: int | Exception = 201

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        if isinstance(self.answer, Exception):
            raise self.answer
        headers = {"location": "https://fcm.googleapis.com/anderswo"} if 300 <= self.answer < 400 else {}
        return httpx2.Response(self.answer, headers=headers)


class Browser:
    """Die Schlüssel eines Abos, wie sie ``pushManager.subscribe`` liefert."""

    def __init__(self) -> None:
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.auth = b"geheim-16-bytes!"
        self.p256dh = push.b64url(
            self.key.public_key().public_bytes(
                serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
            )
        )

    def subscription(self, endpoint: str = FCM, origin: str = "https://stowly.example") -> dict:
        return {
            "endpoint": endpoint,
            "keys": {"p256dh": self.p256dh, "auth": push.b64url(self.auth)},
            "origin": origin,
        }


@pytest.fixture
def push_settings(settings) -> Settings:
    return dataclasses.replace(settings, push_contact=CONTACT)


@pytest.fixture
def service() -> PushService:
    return PushService()


@pytest.fixture
def push_clock() -> PushClock:
    return PushClock()


@pytest.fixture
def push_client(push_settings, service, push_clock):
    app = create_app(
        push_settings, push_transport=httpx2.MockTransport(service.handle), push_clock=push_clock
    )
    with TestClient(app) as client:
        yield client


@pytest.fixture
def phone(push_client) -> Device:
    return Device(push_client, "Handy")


def subscriptions(settings) -> list[dict]:
    con = db.connect(settings.database_path)
    try:
        return [
            dict(row)
            for row in con.execute("SELECT * FROM push_subscriptions ORDER BY created_at, device_id")
        ]
    finally:
        con.close()


def test_without_a_contact_every_push_call_is_503(client):
    device = Device(client, "Handy")
    for method, path, body in (
        ("GET", "/api/push/key", None),
        ("PUT", "/api/push/subscription", Browser().subscription()),
        ("DELETE", "/api/push/subscription", None),
        ("POST", "/api/push/test", None),
    ):
        response = client.request(method, path, json=body, headers=device.headers)
        assert response.status_code == 503, (method, path)
        assert response.json()["error"]["code"] == "not_configured"


def test_the_key_exists_from_the_start_even_without_push(client, settings):
    con = db.connect(settings.database_path)
    try:
        private = db.get_meta(con, push.VAPID_PRIVATE)
        public = db.get_meta(con, push.VAPID_PUBLIC)
    finally:
        con.close()
    assert len(b64(private)) == 32
    raw = b64(public)
    assert len(raw) == 65 and raw[0] == 0x04
    assert "=" not in public and "=" not in private
    # Ein zweiter Start erzeugt nie ein neues Paar.
    with TestClient(create_app(settings)):
        pass
    con = db.connect(settings.database_path)
    try:
        assert (db.get_meta(con, push.VAPID_PRIVATE), db.get_meta(con, push.VAPID_PUBLIC)) == (
            private,
            public,
        )
    finally:
        con.close()


def test_the_public_key(push_client, phone, push_settings):
    response = push_client.get("/api/push/key", headers=phone.headers)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    con = db.connect(push_settings.database_path)
    try:
        assert response.json() == {"public_key": db.get_meta(con, push.VAPID_PUBLIC)}
    finally:
        con.close()
    assert push_client.get("/api/push/key").status_code == 401


@pytest.mark.parametrize(
    "endpoint",
    [
        FCM,
        "https://web.push.apple.com/QGdW8ZnS0x1l8U3dUr0wT9c",
        "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk",
        "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB",
        "https://fcm.googleapis.com:443/fcm/send/x",
    ],
)
def test_known_push_services_are_accepted(push_client, phone, push_settings, endpoint):
    browser = Browser()
    response = push_client.put(
        "/api/push/subscription", json=browser.subscription(endpoint), headers=phone.headers
    )
    assert response.status_code == 204, response.text
    (row,) = subscriptions(push_settings)
    assert (row["device_id"], row["endpoint"], row["p256dh"], row["origin"]) == (
        phone.id,
        endpoint,
        browser.p256dh,
        "https://stowly.example",
    )


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://fcm.googleapis.com/fcm/send/x",
        "https://evil.example/fcm/send/x",
        "https://fcm.googleapis.com.evil.example/x",
        "https://notfcm.googleapis.com/x",
        "https://203.0.113.5/x",
        "https://[::1]/x",
        "https://localhost/x",
        "https://192.168.1.20/x",
        "https://fcm.googleapis.com:8443/x",
        "https://benutzer@fcm.googleapis.com/x",
        "https://benutzer:passwort@fcm.googleapis.com/x",
        "https://evil.example\\.fcm.googleapis.com/x",
        "https://evil.example#.fcm.googleapis.com",
        "fcm.googleapis.com/fcm/send/x",
        "https://fcm.googleapis.com./x",
        "https://FCM.googleapis.com /x",
    ],
)
def test_other_addresses_are_refused(push_client, phone, push_settings, endpoint):
    response = push_client.put(
        "/api/push/subscription", json=Browser().subscription(endpoint), headers=phone.headers
    )
    assert response.status_code == 422, endpoint
    error = response.json()["error"]
    assert error["code"] == "invalid_request"
    assert [problem["loc"] for problem in error["details"]["errors"]] == [["body", "endpoint"]]
    assert subscriptions(push_settings) == []


def test_an_overlong_endpoint_is_refused(push_client, phone):
    endpoint = "https://fcm.googleapis.com/" + "x" * 1000
    response = push_client.put(
        "/api/push/subscription", json=Browser().subscription(endpoint), headers=phone.headers
    )
    assert response.status_code == 422
    assert response.json()["error"]["details"]["errors"][0]["loc"] == ["body", "endpoint"]


def point(raw: bytes) -> str:
    return push.b64url(raw)


@pytest.mark.parametrize(
    ("keys", "loc"),
    [
        ({"p256dh": "kein base64!"}, ["body", "keys", "p256dh"]),
        ({"p256dh": point(b"\x04" + b"\x01" * 64)}, ["body", "keys", "p256dh"]),  # nicht auf der Kurve
        ({"p256dh": point(b"\x04" + b"\x01" * 63)}, ["body", "keys", "p256dh"]),  # 64 Byte
        ({"auth": point(b"x" * 15)}, ["body", "keys", "auth"]),
        ({"auth": point(b"x" * 17)}, ["body", "keys", "auth"]),
        ({"auth": "AAAA+/AAAAAAAAAAAAAAAA"}, ["body", "keys", "auth"]),  # base64, nicht base64url
    ],
)
def test_broken_keys_are_refused(push_client, phone, keys, loc):
    body = Browser().subscription()
    body["keys"].update(keys)
    response = push_client.put("/api/push/subscription", json=body, headers=phone.headers)
    assert response.status_code == 422
    assert [problem["loc"] for problem in response.json()["error"]["details"]["errors"]] == [loc]


def test_a_compressed_point_is_refused_and_padding_is_fine(push_client, phone, push_settings):
    browser = Browser()
    compressed = browser.key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.CompressedPoint
    )
    body = browser.subscription()
    body["keys"]["p256dh"] = point(compressed)
    assert push_client.put("/api/push/subscription", json=body, headers=phone.headers).status_code == 422
    # Mit Füllzeichen geschrieben gilt derselbe Schlüssel; gespeichert ohne.
    body = browser.subscription()
    body["keys"]["p256dh"] += "=" * (-len(body["keys"]["p256dh"]) % 4)
    body["keys"]["auth"] += "=="
    assert push_client.put("/api/push/subscription", json=body, headers=phone.headers).status_code == 204
    (row,) = subscriptions(push_settings)
    assert (row["p256dh"], row["auth"]) == (browser.p256dh, push.b64url(browser.auth))


@pytest.mark.parametrize(
    ("origin", "valid"),
    [
        ("https://stowly.example", True),
        ("https://stowly.example:8443", True),
        ("https://stowly.home", True),
        ("https://192.168.1.10", True),
        ("https://[fd00::10]:8443", True),
        ("http://localhost:5173", True),
        ("http://127.0.0.1:8010", True),
        ("http://[::1]:8010", True),
        ("http://localhost", True),
        ("http://stowly.example", False),
        ("http://192.168.1.10:8010", False),
        ("https://stowly.example/", False),
        ("https://stowly.example/app", False),
        ("https://stowly.example?x=1", False),
        ("https://stowly.example#x", False),
        ("https://benutzer@stowly.example", False),
        ("ftp://stowly.example", False),
        ("stowly.example", False),
        ("https://", False),
        ("https://stowly.example:0", False),
    ],
)
def test_the_origin_of_the_app(push_client, phone, origin, valid):
    response = push_client.put(
        "/api/push/subscription", json=Browser().subscription(origin=origin), headers=phone.headers
    )
    if valid:
        assert response.status_code == 204, origin
    else:
        assert response.status_code == 422, origin
        assert response.json()["error"]["details"]["errors"][0]["loc"] == ["body", "origin"]


def test_one_subscription_per_device_and_an_endpoint_moves_to_the_new_device(
    push_client, phone, push_settings
):
    tablet = Device(push_client, "Tablet")
    first, second = Browser(), Browser()
    assert (
        push_client.put(
            "/api/push/subscription", json=first.subscription(), headers=phone.headers
        ).status_code
        == 204
    )
    other = "https://updates.push.services.mozilla.com/wpush/v2/neu"
    assert (
        push_client.put(
            "/api/push/subscription", json=second.subscription(other), headers=phone.headers
        ).status_code
        == 204
    )
    assert [(row["device_id"], row["endpoint"]) for row in subscriptions(push_settings)] == [
        (phone.id, other)
    ]
    # Derselbe Endpunkt meldet sich vom Tablet an: Das Handy verliert ihn.
    assert (
        push_client.put(
            "/api/push/subscription", json=second.subscription(other), headers=tablet.headers
        ).status_code
        == 204
    )
    assert [(row["device_id"], row["endpoint"]) for row in subscriptions(push_settings)] == [
        (tablet.id, other)
    ]


def test_deleting_is_repeatable(push_client, phone, push_settings):
    push_client.put("/api/push/subscription", json=Browser().subscription(), headers=phone.headers)
    for _ in range(2):
        response = push_client.delete("/api/push/subscription", headers=phone.headers)
        assert response.status_code == 204
    assert subscriptions(push_settings) == []


def test_logging_out_or_revoking_ends_the_subscription(push_client, phone, push_settings):
    tablet = Device(push_client, "Tablet")
    push_client.put("/api/push/subscription", json=Browser().subscription(), headers=phone.headers)
    push_client.put(
        "/api/push/subscription",
        json=Browser().subscription("https://web.push.apple.com/tablet"),
        headers=tablet.headers,
    )
    assert len(subscriptions(push_settings)) == 2
    assert push_client.post("/api/auth/logout", headers=phone.headers).status_code == 204
    assert [row["device_id"] for row in subscriptions(push_settings)] == [tablet.id]
    third = Device(push_client, "Rechner")
    assert push_client.delete(f"/api/devices/{tablet.id}", headers=third.headers).status_code == 204
    assert subscriptions(push_settings) == []


# --- Testnachricht -----------------------------------------------------------------------------


def subscribe(client, device: Device, browser: Browser, endpoint: str = FCM) -> None:
    response = client.put(
        "/api/push/subscription", json=browser.subscription(endpoint), headers=device.headers
    )
    assert response.status_code == 204, response.text


def test_a_test_message_without_subscription_is_404(push_client, phone):
    response = push_client.post("/api/push/test", headers=phone.headers)
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_the_test_message_reaches_the_push_service_encrypted_and_signed(
    push_client, phone, service, push_clock, push_settings
):
    browser = Browser()
    subscribe(push_client, phone, browser)
    response = push_client.post("/api/push/test", headers=phone.headers)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "status": "sent",
        "http_status": 201,
        "message": "Der Push-Dienst hat die Nachricht angenommen.",
    }

    (request,) = service.requests
    assert (request.method, str(request.url)) == ("POST", FCM)
    headers = request.headers
    assert headers["ttl"] == "300"
    assert headers["topic"] == "stowly-test"
    assert headers["urgency"] == "high"
    assert headers["content-encoding"] == "aes128gcm"
    assert headers["content-type"] == "application/octet-stream"

    # Absender: vapid t=<JWT>, k=<öffentlicher Schlüssel des Servers>.
    scheme, _, value = headers["authorization"].partition(" ")
    parts = dict(part.strip().split("=", 1) for part in value.split(","))
    assert scheme == "vapid"
    public = push_client.get("/api/push/key", headers=phone.headers).json()["public_key"]
    assert parts["k"] == public
    claims = verify_jwt(parts["t"], public)
    assert claims["aud"] == "https://fcm.googleapis.com" and claims["sub"] == CONTACT
    now = int(push_clock.value.timestamp())
    assert now < claims["exp"] <= now + 24 * 3600

    # Inhalt: Declarative Web Push, für den Browser entschlüsselbar.
    payload = json.loads(decrypt(request.content, browser.key, browser.auth))
    assert payload == {
        "web_push": 8030,
        "notification": {
            "title": "Testnachricht",
            "body": "Benachrichtigungen kommen auf diesem Gerät an.",
            "navigate": "https://stowly.example/einstellungen",
            "lang": "de-DE",
            "dir": "ltr",
            "tag": "stowly-test",
            "silent": False,
        },
    }
    (row,) = subscriptions(push_settings)
    assert row["last_ok_at"] == "2026-11-14T09:00:00.000Z" and row["last_error"] is None


def test_the_jwt_is_reused_per_audience_while_it_is_valid_for_an_hour(
    push_client, phone, service, push_clock
):
    subscribe(push_client, phone, Browser())

    def token() -> str:
        push_clock.advance(11)  # über die Bremse der Testnachricht hinweg
        assert push_client.post("/api/push/test", headers=phone.headers).status_code == 200
        return service.requests[-1].headers["authorization"]

    first = token()
    assert token() == first
    push_clock.advance(10 * 3600)  # nach 10 Stunden gilt es noch knapp 2
    assert token() == first
    push_clock.advance(3600)  # jetzt weniger als eine Stunde: ein neues
    assert token() != first


@pytest.mark.parametrize(
    ("answer", "status", "http_status", "kept", "note"),
    [
        (201, "sent", 201, True, None),
        (202, "sent", 202, True, None),
        (404, "gone", 404, False, None),
        (410, "gone", 410, False, None),
        (413, "rejected", 413, True, "Nachricht zu groß (413)"),
        (429, "failed", 429, True, "Push-Dienst überlastet (429)"),
        (400, "rejected", 400, True, "Abgelehnt (400)"),
        (401, "rejected", 401, True, "Abgelehnt (401)"),
        (403, "rejected", 403, True, "Abgelehnt (403)"),
        (418, "rejected", 418, True, "Abgelehnt (418)"),
        (500, "failed", 500, True, "Fehler des Push-Dienstes (500)"),
        (503, "failed", 503, True, "Fehler des Push-Dienstes (503)"),
        (301, "failed", 301, True, "Unerwartete Antwort (301)"),
        (httpx2.ReadTimeout("zu langsam"), "failed", None, True, "Zeitüberschreitung"),
        (httpx2.ConnectError("weg"), "failed", None, True, "Nicht erreichbar"),
    ],
)
def test_the_answers_of_a_push_service(
    push_client, phone, service, push_settings, answer, status, http_status, kept, note
):
    subscribe(push_client, phone, Browser())
    service.answer = answer
    response = push_client.post("/api/push/test", headers=phone.headers)
    assert response.status_code == 200
    result = response.json()
    assert (result["status"], result["http_status"]) == (status, http_status)
    assert result["message"]
    assert len(service.requests) == 1  # nie wiederholt, keiner Weiterleitung gefolgt
    rows = subscriptions(push_settings)
    assert bool(rows) is kept
    if kept:
        assert rows[0]["last_error"] == note
        assert (rows[0]["last_error_at"] is None) is (note is None)
    if answer == 403:
        assert result["message"] == "Der Push-Dienst lehnt ab (403). Stimmt der Kontakt für die Push-Dienste?"


def test_a_slow_push_service_is_given_up_after_the_time_limit(push_settings, push_clock, monkeypatch):
    """Höchstens 10 Sekunden je Anfrage; der Test kürzt die Grenze, statt so lange zu warten."""
    assert push.TIMEOUT_S == 10.0
    monkeypatch.setattr(push, "TIMEOUT_S", 0.2)

    async def slow(request: httpx2.Request) -> httpx2.Response:
        await asyncio.sleep(5)
        return httpx2.Response(201)

    app = create_app(push_settings, push_transport=httpx2.MockTransport(slow), push_clock=push_clock)
    with TestClient(app) as client:
        device = Device(client, "Handy")
        subscribe(client, device, Browser())
        started = time.monotonic()
        result = client.post("/api/push/test", headers=device.headers).json()
        assert time.monotonic() - started < 3
    assert result == {
        "status": "failed",
        "http_status": None,
        "message": "Der Push-Dienst hat nicht rechtzeitig geantwortet.",
    }
    (row,) = subscriptions(push_settings)
    assert row["last_error"] == "Zeitüberschreitung"


def test_one_test_message_per_device_in_ten_seconds(push_client, phone, service, push_clock):
    tablet = Device(push_client, "Tablet")
    subscribe(push_client, phone, Browser())
    subscribe(push_client, tablet, Browser(), "https://web.push.apple.com/tablet")
    assert push_client.post("/api/push/test", headers=phone.headers).status_code == 200
    push_clock.advance(3.2)
    response = push_client.post("/api/push/test", headers=phone.headers)
    assert response.status_code == 429
    assert response.headers["retry-after"] == "7"
    assert response.json()["error"]["code"] == "rate_limited"
    assert response.json()["error"]["details"] == {"retry_after_s": 7}
    # Jedes Gerät für sich.
    assert push_client.post("/api/push/test", headers=tablet.headers).status_code == 200
    push_clock.advance(6.8)
    assert push_client.post("/api/push/test", headers=phone.headers).status_code == 200
    assert len(service.requests) == 3


def test_the_endpoint_is_never_logged(push_client, phone, service, push_clock, caplog):
    """Die Adresse eines Abos ist ein Schlüssel zu diesem Gerät: Ins Log kommt nur der Rechner."""
    caplog.set_level(logging.INFO, logger="stowly")
    subscribe(push_client, phone, Browser())
    for answer in (201, 403, 413, 503, 404):
        service.answer = answer
        assert push_client.post("/api/push/test", headers=phone.headers).status_code == 200
        push_clock.advance(10)
        if answer != 404:
            continue
    records = [record for record in caplog.records if record.name == "stowly.push"]
    assert len(records) >= 5
    assert "abc123" not in caplog.text and "def456" not in caplog.text
    assert all(
        "fcm.googleapis.com" in record.getMessage() for record in records if "Push an" in record.getMessage()
    )
