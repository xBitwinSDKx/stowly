"""Benachrichtigungen per Web-Push (docs/integrationen.md, Abschnitt 4), ohne fremde Bibliothek.

* **Schlüssel des Servers** (VAPID, 4.1): ein Paar auf P-256 in der Tabelle ``meta``. Fehlt es, legt
  der Server es beim Start an; es kommt mit jeder Sicherung und wird nie neu erzeugt, solange es da ist.
  Der private Wert steht nie im Log und nie in einer Antwort.
* **Abos** (4.2): höchstens eines je Gerät, nur an https-Adressen bekannter Push-Dienste. Sonst könnte
  ein Gerät den Server Anfragen ins Heimnetz schicken lassen.
* **Verschlüsselung** nach RFC 8291 (``aes128gcm``, 4.3) und **Absender** nach RFC 8292 (VAPID, 4.4),
  selbst geschrieben auf ``cryptography`` und gegen das Beispiel aus RFC 8291, Anhang A, geprüft.
* **Versand** (4.6, 4.7) über ``httpx2``: ohne Weiterleitungen, höchstens 10 Sekunden je Anfrage. Tests
  setzen einen Ersatz-Transport ein (``httpx2.MockTransport``) und gehen nie ins Netz.

Die Adresse eines Abos (``endpoint``) ist ein Schlüssel zu diesem Gerät: Ins Log kommt nur ihr Rechner.
"""

import asyncio
import base64
import hashlib
import hmac
import ipaddress
import json
import logging
import math
import re
import secrets
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx2
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from stowly import db
from stowly.config import Settings
from stowly.contract.api import PUSH_PATHS, PUSH_TEST_INTERVAL_S, PushTestStatus
from stowly.contract.limits import LIMITS
from stowly.contract.timeutil import format_timestamp
from stowly.off import Clock

log = logging.getLogger("stowly.push")

# Schlüssel des Servers in der Tabelle meta (docs/integrationen.md, 4.1).
VAPID_PRIVATE = "vapid_private_key"
VAPID_PUBLIC = "vapid_public_key"

# Erlaubte Push-Dienste: der Host gleich einer dieser Domänen oder darunter (4.2).
PUSH_SERVICES = (
    "fcm.googleapis.com",  # Google (Chrome und andere Chromium-Browser, auch auf Android)
    "push.apple.com",  # Apple (Safari, iPhone und iPad, etwa web.push.apple.com)
    "push.services.mozilla.com",  # Mozilla (Firefox)
    "notify.windows.com",  # Microsoft (Edge unter Windows)
)

RECORD_SIZE = 4096
# Klartext eines einzigen Datensatzes: 4096 minus Kopf (86), Tag (16) und Trenner (1).
MAX_PLAINTEXT = RECORD_SIZE - 86 - 16 - 1
TIMEOUT_S = 10.0
# Ein JWT gilt 12 Stunden und wird je aud wiederverwendet, solange es noch eine Stunde gilt (4.4).
JWT_LIFETIME = timedelta(hours=12)
JWT_REUSE_MARGIN = timedelta(hours=1)

# iOS setzt unter den Titel selbst „from" und den Namen der App: Der Titel sagt deshalb, worum es geht,
# nicht „Stowly" (docs/integrationen.md, 4.5).
TEST_TITLE = "Testnachricht"
TEST_BODY = "Benachrichtigungen kommen auf diesem Gerät an."
TEST_TAG = "stowly-test"

_B64URL = re.compile(r"^[A-Za-z0-9_-]*={0,2}$")
_HOST = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$")
_LOCAL_ORIGINS = ("localhost", "127.0.0.1", "::1")


# --- base64url -------------------------------------------------------------------------------


def b64url(data: bytes) -> str:
    """base64url ohne Füllzeichen."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(text: str) -> bytes:
    """base64url mit oder ohne Füllzeichen; ``ValueError`` bei jedem fremden Zeichen.

    ``base64.urlsafe_b64decode`` überginge fremde Zeichen stillschweigend: deshalb erst das Muster.
    """
    if not isinstance(text, str) or not _B64URL.fullmatch(text):
        raise ValueError("kein base64url")
    stripped = text.rstrip("=")
    if len(stripped) % 4 == 1 or (len(stripped) != len(text) and len(text) % 4 != 0):
        raise ValueError("kein base64url")
    return base64.urlsafe_b64decode(stripped + "=" * (-len(stripped) % 4))


# --- Schlüssel des Servers (4.1) -------------------------------------------------------------


def _public_bytes(key: ec.EllipticCurvePrivateKey | ec.EllipticCurvePublicKey) -> bytes:
    public = key.public_key() if isinstance(key, ec.EllipticCurvePrivateKey) else key
    return public.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def private_key_from(value: str) -> ec.EllipticCurvePrivateKey:
    """Der private Schlüssel aus seinem Wert d (32 Byte, base64url)."""
    raw = b64url_decode(value)
    if len(raw) != 32:
        raise ValueError("Der private VAPID-Schlüssel hat nicht 32 Byte.")
    return ec.derive_private_key(int.from_bytes(raw, "big"), ec.SECP256R1())


def ensure_vapid_keys(con: sqlite3.Connection) -> bool:
    """Legt das Schlüsselpaar an, wenn es fehlt; liefert, ob ein neues entstand.

    Gibt es den privaten Wert schon, bleibt er, und der öffentliche wird daraus nachgetragen, falls er
    fehlt oder nicht passt. Nur in einer Datenbank ohne gültigen privaten Wert entsteht ein neues Paar.
    """
    with db.transaction(con):
        stored = db.get_meta(con, VAPID_PRIVATE)
        key: ec.EllipticCurvePrivateKey | None = None
        if stored is not None:
            try:
                key = private_key_from(stored)
            except ValueError:
                log.error("Push: Der gespeicherte VAPID-Schlüssel ist unbrauchbar; es gibt ein neues Paar.")
        created = key is None
        if key is None:
            key = ec.generate_private_key(ec.SECP256R1())
            value = b64url(key.private_numbers().private_value.to_bytes(32, "big"))
            _set_meta(con, VAPID_PRIVATE, value)
        public = b64url(_public_bytes(key))
        if db.get_meta(con, VAPID_PUBLIC) != public:
            _set_meta(con, VAPID_PUBLIC, public)
    if created:
        log.info("Push: neues VAPID-Schlüsselpaar angelegt.")
    return created


def _set_meta(con: sqlite3.Connection, key: str, value: str) -> None:
    con.execute(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def public_key(con: sqlite3.Connection) -> str:
    """Der öffentliche VAPID-Schlüssel (``applicationServerKey``); legt das Paar an, falls es fehlt."""
    value = db.get_meta(con, VAPID_PUBLIC)
    if value is None or db.get_meta(con, VAPID_PRIVATE) is None:
        ensure_vapid_keys(con)
        value = db.get_meta(con, VAPID_PUBLIC)
    assert value is not None
    return value


# --- Prüfung eines Abos (4.2) ----------------------------------------------------------------


def _plain_ascii(text: str) -> bool:
    return text.isascii() and all(" " < char <= "~" for char in text)


def _host_under(host: str, domains: tuple[str, ...]) -> bool:
    return any(host == domain or host.endswith("." + domain) for domain in domains)


def endpoint_problem(endpoint: str) -> str | None:
    """Warum ``endpoint`` nicht gilt, oder ``None``.

    Gilt nur eine absolute ``https://``-Adresse eines bekannten Push-Dienstes, ohne Benutzerangabe,
    ohne Port oder mit 443, höchstens 1024 Zeichen. Geprüft wird auch so, wie ``httpx2`` die Adresse
    liest: Was der Server prüft, ist das, wohin er schickt.
    """
    problem = "Nur https-Adressen bekannter Push-Dienste (Google, Apple, Mozilla, Microsoft) sind erlaubt."
    if len(endpoint) > LIMITS["push_endpoint"] or not _plain_ascii(endpoint) or "\\" in endpoint:
        return problem
    if not endpoint.startswith("https://") or "@" in endpoint or "#" in endpoint:
        return problem
    try:
        parts = urlsplit(endpoint)
        port = parts.port
        url = httpx2.URL(endpoint)
    except Exception:
        return problem
    host = parts.hostname or ""
    if port not in (None, 443) or not _HOST.fullmatch(host) or not _host_under(host, PUSH_SERVICES):
        return problem
    if url.scheme != "https" or url.host != host or url.port not in (None, 443) or url.userinfo:
        return problem
    return None


def point_problem(value: str) -> str | None:
    """``keys.p256dh``: ein unkomprimierter Punkt auf P-256 (65 Byte, beginnend mit 0x04), gültig auf der Kurve."""
    try:
        raw = b64url_decode(value)
        if len(raw) != 65 or raw[0] != 0x04:
            raise ValueError("kein unkomprimierter Punkt")
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), raw)
    except ValueError:
        return "Kein öffentlicher Schlüssel auf P-256 (65 Byte, base64url)."
    return None


def secret_problem(value: str) -> str | None:
    """``keys.auth``: genau 16 Byte, base64url."""
    try:
        raw = b64url_decode(value)
    except ValueError:
        raw = b""
    return None if len(raw) == 16 else "Kein Geheimnis eines Abos (16 Byte, base64url)."


def origin_problem(origin: str) -> str | None:
    """Genau ein Ursprung: ``https://host[:port]``, zum Entwickeln auch ``http://localhost``,
    ``http://127.0.0.1`` oder ``http://[::1]`` (mit Port); ohne Pfad, Abfrage, Fragment, Benutzerangabe."""
    problem = "Kein Ursprung der App (https://host oder https://host:port)."
    if len(origin) > LIMITS["push_origin"] or not _plain_ascii(origin) or "\\" in origin:
        return problem
    if any(char in origin for char in "@?#"):
        return problem
    scheme = "https" if origin.startswith("https://") else "http" if origin.startswith("http://") else None
    if scheme is None:
        return problem
    try:
        parts = urlsplit(origin)
        port = parts.port
    except ValueError:
        return problem
    host = parts.hostname or ""
    if parts.path or port == 0 or not host:
        return problem
    if scheme == "http":
        return None if host in _LOCAL_ORIGINS else problem
    if _HOST.fullmatch(host):
        return None
    try:
        ipaddress.IPv6Address(host)
    except ValueError:
        return problem
    return None


def check(endpoint: str, p256dh: str, auth: str, origin: str) -> list[dict[str, Any]]:
    """Alle Verstöße gegen 4.2 als ``details.errors`` (``loc``, ``msg``, ``type``)."""
    problems: list[dict[str, Any]] = []
    for loc, message in (
        (("body", "endpoint"), endpoint_problem(endpoint)),
        (("body", "keys", "p256dh"), point_problem(p256dh)),
        (("body", "keys", "auth"), secret_problem(auth)),
        (("body", "origin"), origin_problem(origin)),
    ):
        if message is not None:
            problems.append({"loc": list(loc), "msg": message, "type": "push_subscription"})
    return problems


# --- Abos in der Datenbank -------------------------------------------------------------------


@dataclass(frozen=True)
class Subscription:
    device_id: str
    endpoint: str
    p256dh: str
    auth: str
    origin: str

    @property
    def host(self) -> str:
        """Der Rechner des Push-Dienstes; mehr kommt vom Endpunkt nicht ins Log."""
        return urlsplit(self.endpoint).hostname or "?"


def subscription_of(con: sqlite3.Connection, device_id: str) -> Subscription | None:
    row = con.execute(
        "SELECT device_id, endpoint, p256dh, auth, origin FROM push_subscriptions WHERE device_id = ?",
        (device_id,),
    ).fetchone()
    return None if row is None else Subscription(**{key: row[key] for key in row.keys()})


def save(
    con: sqlite3.Connection, device_id: str, *, endpoint: str, p256dh: str, auth: str, origin: str, now: str
) -> bool:
    """Legt das Abo des Geräts an oder ersetzt es; liefert ``False``, wenn das Gerät gesperrt ist.

    Gehört derselbe ``endpoint`` einem anderen Gerät, wechselt er zu diesem: Das andere verliert sein
    Abo. Ein neuer Endpunkt oder neue Schlüssel vergessen, was der Push-Dienst zuletzt gesagt hat.
    """
    p256dh = b64url(b64url_decode(p256dh))
    auth = b64url(b64url_decode(auth))
    with db.transaction(con):
        device = con.execute("SELECT revoked_at FROM devices WHERE id = ?", (device_id,)).fetchone()
        if device is None or device["revoked_at"] is not None:
            return False
        con.execute(
            "DELETE FROM push_subscriptions WHERE endpoint = ? AND device_id <> ?", (endpoint, device_id)
        )
        old = con.execute("SELECT * FROM push_subscriptions WHERE device_id = ?", (device_id,)).fetchone()
        if old is None:
            con.execute(
                "INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, origin, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (device_id, endpoint, p256dh, auth, origin, now, now),
            )
        else:
            fresh = (old["endpoint"], old["p256dh"], old["auth"]) != (endpoint, p256dh, auth)
            con.execute(
                "UPDATE push_subscriptions SET endpoint = ?, p256dh = ?, auth = ?, origin = ?, updated_at = ?"
                + (", last_ok_at = NULL, last_error = NULL, last_error_at = NULL" if fresh else "")
                + " WHERE device_id = ?",
                (endpoint, p256dh, auth, origin, now, device_id),
            )
    return True


def remove(con: sqlite3.Connection, device_id: str) -> None:
    """Löscht das Abo eines Geräts; ohne Abo ohne Wirkung."""
    with db.transaction(con):
        con.execute("DELETE FROM push_subscriptions WHERE device_id = ?", (device_id,))


# --- Verschlüsselung (RFC 8291, 4.3) ---------------------------------------------------------


def _hmac(key: bytes, data: bytes) -> bytes:
    return hmac.new(key, data, hashlib.sha256).digest()


def encrypt(
    plaintext: bytes,
    ua_public: bytes,
    auth_secret: bytes,
    *,
    salt: bytes | None = None,
    server_key: ec.EllipticCurvePrivateKey | None = None,
) -> bytes:
    """Verschlüsselt eine Nachricht für ein Abo (``aes128gcm``, ein einziger Datensatz).

    ``salt`` und ``server_key`` (das Schlüsselpaar des Servers für diese Nachricht) lassen sich für
    Tests vorgeben; sonst sind beide je Nachricht neu und zufällig.
    """
    if len(plaintext) > MAX_PLAINTEXT:
        raise ValueError(f"Die Nachricht ist zu lang ({len(plaintext)} Byte, höchstens {MAX_PLAINTEXT}).")
    if len(auth_secret) != 16:
        raise ValueError("Das Geheimnis des Abos hat nicht 16 Byte.")
    salt = salt if salt is not None else secrets.token_bytes(16)
    if len(salt) != 16:
        raise ValueError("Das Salz hat nicht 16 Byte.")
    server_key = server_key or ec.generate_private_key(ec.SECP256R1())
    as_public = _public_bytes(server_key)
    ua_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public)
    ecdh_secret = server_key.exchange(ec.ECDH(), ua_key)

    # Schlüssel kombinieren: das gemeinsame Geheimnis mit dem Geheimnis des Abos (RFC 8291, 3.3).
    prk_key = _hmac(auth_secret, ecdh_secret)
    key_info = b"WebPush: info\x00" + ua_public + as_public
    ikm = _hmac(prk_key, key_info + b"\x01")
    # Inhaltsschlüssel und Nonce (RFC 8188).
    prk = _hmac(salt, ikm)
    cek = _hmac(prk, b"Content-Encoding: aes128gcm\x00\x01")[:16]
    nonce = _hmac(prk, b"Content-Encoding: nonce\x00\x01")[:12]
    # Ein einziger Datensatz: Klartext, Trenner 0x02, ohne Auffüllen.
    ciphertext = AESGCM(cek).encrypt(nonce, plaintext + b"\x02", None)
    header = salt + RECORD_SIZE.to_bytes(4, "big") + bytes([len(as_public)]) + as_public
    return header + ciphertext


# --- Absender (RFC 8292, VAPID, 4.4) ---------------------------------------------------------


def audience(endpoint: str) -> str:
    """``aud`` eines Endpunkts: ``<Schema>://<Host>`` (der Ursprung des Push-Dienstes)."""
    url = httpx2.URL(endpoint)
    port = "" if url.port in (None, 443) else f":{url.port}"
    return f"{url.scheme}://{url.host}{port}"


def vapid_jwt(key: ec.EllipticCurvePrivateKey, *, aud: str, sub: str, exp: int) -> str:
    """Ein JWT nach RFC 8292: Kopf, Inhalt und Signatur ES256 als rohes ``r ‖ s``, alles base64url."""
    header = b64url(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode("ascii"))
    claims = b64url(
        json.dumps({"aud": aud, "exp": exp, "sub": sub}, separators=(",", ":"), ensure_ascii=True).encode(
            "ascii"
        )
    )
    signing_input = f"{header}.{claims}".encode("ascii")
    r, s = decode_dss_signature(key.sign(signing_input, ec.ECDSA(hashes.SHA256())))
    return f"{header}.{claims}.{b64url(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"


# --- Nachricht (4.5) -------------------------------------------------------------------------


def notification(title: str, body: str, *, origin: str, path: str, tag: str) -> bytes:
    """Die Nutzlast im Format „Declarative Web Push" (JSON, UTF-8)."""
    payload = {
        "web_push": 8030,
        "notification": {
            "title": title,
            "body": body,
            "navigate": origin + path,
            "lang": "de-DE",
            "dir": "ltr",
            "tag": tag,
            "silent": False,
        },
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


# --- Versand (4.6, 4.7) ----------------------------------------------------------------------


@dataclass(frozen=True)
class Delivery:
    """Was der Push-Dienst geantwortet hat."""

    status: PushTestStatus
    http_status: int | None
    message: str  # deutscher Satz für die App
    note: str | None  # kurzer Vermerk am Abo (last_error); None bei Erfolg


def classify(http_status: int) -> Delivery:
    """Die Antwort eines Push-Dienstes nach 4.7."""
    if 200 <= http_status < 300:
        return Delivery(
            PushTestStatus.SENT, http_status, "Der Push-Dienst hat die Nachricht angenommen.", None
        )
    if http_status in (404, 410):
        return Delivery(
            PushTestStatus.GONE,
            http_status,
            f"Der Push-Dienst kennt dieses Abo nicht mehr ({http_status}). Benachrichtigungen bitte neu einschalten.",
            f"Abo erloschen ({http_status})",
        )
    if http_status == 413:
        return Delivery(
            PushTestStatus.REJECTED,
            http_status,
            "Der Push-Dienst lehnt die Nachricht als zu groß ab (413). Das ist ein Fehler im Server.",
            "Nachricht zu groß (413)",
        )
    if http_status == 429:
        return Delivery(
            PushTestStatus.FAILED,
            http_status,
            "Der Push-Dienst ist gerade überlastet (429). Bitte später noch einmal versuchen.",
            "Push-Dienst überlastet (429)",
        )
    if 400 <= http_status < 500:
        hint = " Stimmt STOWLY_PUSH_CONTACT?" if http_status in (400, 401, 403) else ""
        return Delivery(
            PushTestStatus.REJECTED,
            http_status,
            f"Der Push-Dienst lehnt ab ({http_status}).{hint}",
            f"Abgelehnt ({http_status})",
        )
    if http_status >= 500:
        return Delivery(
            PushTestStatus.FAILED,
            http_status,
            f"Der Push-Dienst hat gerade einen Fehler ({http_status}). Bitte später noch einmal versuchen.",
            f"Fehler des Push-Dienstes ({http_status})",
        )
    return Delivery(
        PushTestStatus.FAILED,
        http_status,
        f"Der Push-Dienst antwortet unerwartet ({http_status}).",
        f"Unerwartete Antwort ({http_status})",
    )


TIMED_OUT = Delivery(
    PushTestStatus.FAILED, None, "Der Push-Dienst hat nicht rechtzeitig geantwortet.", "Zeitüberschreitung"
)
UNREACHABLE = Delivery(
    PushTestStatus.FAILED, None, "Der Push-Dienst ist nicht erreichbar.", "Nicht erreichbar"
)


class NoSubscription(Exception):
    """Dieses Gerät hat kein Abo beim Server."""


class TooSoon(Exception):
    """Mehr als eine Testnachricht je Gerät in ``PUSH_TEST_INTERVAL_S``."""

    def __init__(self, retry_after_s: int) -> None:
        super().__init__(retry_after_s)
        self.retry_after_s = retry_after_s


class PushService:
    """Versand an die Push-Dienste. Ein Exemplar je laufender App (``lifespan``).

    ``transport`` und ``clock`` sind der Ersatz für Tests; im Betrieb bleiben sie ``None``.
    """

    def __init__(
        self,
        settings: Settings,
        *,
        transport: httpx2.AsyncBaseTransport | None = None,
        clock: Clock | None = None,
    ) -> None:
        self._path: Path = settings.database_path
        self._contact = settings.push_contact
        self._clock = clock or Clock()
        self._client = httpx2.AsyncClient(
            transport=transport,
            timeout=httpx2.Timeout(TIMEOUT_S),
            follow_redirects=False,  # Weiterleitungen folgt der Server beim Versand nicht (4.2)
        )
        self._key: ec.EllipticCurvePrivateKey | None = None
        self._public: str | None = None
        self._tokens: dict[str, tuple[str, datetime]] = {}  # aud -> (JWT, gültig bis)
        self._tests: dict[str, float] = {}  # Gerät -> Zeitpunkt der letzten Testnachricht (monoton)

    async def aclose(self) -> None:
        await self._client.aclose()

    # ------------------------------------------------------------------ Absender

    def _load_key(self) -> None:
        con = db.connect(self._path)
        try:
            self._public = public_key(con)
            stored = db.get_meta(con, VAPID_PRIVATE)
        finally:
            con.close()
        assert stored is not None
        self._key = private_key_from(stored)

    def _authorization(self, endpoint: str) -> str:
        """``vapid t=<JWT>, k=<öffentlicher Schlüssel>``; ein JWT je aud, solange es noch eine Stunde gilt."""
        assert self._key is not None and self._public is not None and self._contact is not None
        aud = audience(endpoint)
        now = self._clock.now()
        cached = self._tokens.get(aud)
        if cached is None or cached[1] - now < JWT_REUSE_MARGIN:
            expires = now + JWT_LIFETIME
            token = vapid_jwt(self._key, aud=aud, sub=self._contact, exp=math.floor(expires.timestamp()))
            cached = self._tokens[aud] = (token, expires)
        return f"vapid t={cached[0]}, k={self._public}"

    # ------------------------------------------------------------------ Versand

    async def deliver(
        self, subscription: Subscription, payload: bytes, *, ttl: int, topic: str, urgency: str
    ) -> Delivery:
        """Schickt eine Nachricht an ein Abo und vermerkt die Antwort am Abo (4.7). Ohne Wiederholung."""
        if self._key is None:
            await asyncio.to_thread(self._load_key)
        body = encrypt(payload, b64url_decode(subscription.p256dh), b64url_decode(subscription.auth))
        headers = {
            "TTL": str(ttl),
            "Topic": topic,
            "Urgency": urgency,
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            "Authorization": self._authorization(subscription.endpoint),
        }
        try:
            response = await asyncio.wait_for(
                self._client.post(subscription.endpoint, content=body, headers=headers), TIMEOUT_S
            )
        except (TimeoutError, httpx2.TimeoutException):
            delivery = TIMED_OUT
        except httpx2.HTTPError:
            delivery = UNREACHABLE
        else:
            delivery = classify(response.status_code)
        self._log(subscription, delivery)
        await asyncio.to_thread(self._remember, subscription, delivery)
        return delivery

    def _log(self, subscription: Subscription, delivery: Delivery) -> None:
        if delivery.status is PushTestStatus.SENT:
            log.info("Push an %s angenommen (%s)", subscription.host, delivery.http_status)
        elif delivery.http_status == 413:
            log.error("Push an %s: Nachricht zu groß (413), ein Fehler im Server", subscription.host)
        elif delivery.status is PushTestStatus.REJECTED:
            log.warning(
                "Push an %s abgelehnt (%s): Absender, VAPID oder Schlüssel?",
                subscription.host,
                delivery.http_status,
            )
        else:
            log.info("Push an %s: %s", subscription.host, delivery.note)

    def _remember(self, subscription: Subscription, delivery: Delivery) -> None:
        """Vermerkt die Antwort am Abo, sofern es noch dasselbe ist; 404 und 410 löschen es."""
        now = format_timestamp(self._clock.now())
        con = db.connect(self._path)
        try:
            with db.transaction(con):
                same = (subscription.device_id, subscription.endpoint)
                if delivery.status is PushTestStatus.SENT:
                    con.execute(
                        "UPDATE push_subscriptions SET last_ok_at = ?, last_error = NULL, last_error_at = NULL "
                        "WHERE device_id = ? AND endpoint = ?",
                        (now, *same),
                    )
                elif delivery.status is PushTestStatus.GONE:
                    con.execute("DELETE FROM push_subscriptions WHERE device_id = ? AND endpoint = ?", same)
                else:
                    con.execute(
                        "UPDATE push_subscriptions SET last_error = ?, last_error_at = ? "
                        "WHERE device_id = ? AND endpoint = ?",
                        (delivery.note, now, *same),
                    )
        finally:
            con.close()

    # ------------------------------------------------------------------ Testnachricht (4.9)

    def _subscription(self, device_id: str) -> Subscription | None:
        con = db.connect(self._path)
        try:
            return subscription_of(con, device_id)
        finally:
            con.close()

    def _admit(self, device_id: str) -> None:
        """Höchstens eine Testnachricht je Gerät in ``PUSH_TEST_INTERVAL_S`` Sekunden."""
        now = self._clock.monotonic()
        for other, at in list(self._tests.items()):
            if now - at >= PUSH_TEST_INTERVAL_S:
                del self._tests[other]
        last = self._tests.get(device_id)
        if last is not None:
            raise TooSoon(max(1, math.ceil(last + PUSH_TEST_INTERVAL_S - now)))
        self._tests[device_id] = now

    async def test(self, device_id: str) -> Delivery:
        """Schickt die Testnachricht an das Abo dieses Geräts; ``NoSubscription``, ``TooSoon``."""
        subscription = await asyncio.to_thread(self._subscription, device_id)
        if subscription is None:
            raise NoSubscription
        self._admit(device_id)
        payload = notification(
            TEST_TITLE, TEST_BODY, origin=subscription.origin, path=PUSH_PATHS["test"], tag=TEST_TAG
        )
        return await self.deliver(subscription, payload, ttl=300, topic=TEST_TAG, urgency="high")
