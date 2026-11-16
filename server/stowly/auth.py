"""Anmeldung, Haushalts-Passwort und Geräte-Token (docs/sync-protokoll.md, „Anmeldung und Geräte-Token").

* **Ein Haushalts-Passwort**, beliebig viele Geräte. Das Passwort kommt aus ``STOWLY_PASSWORD`` oder wird
  beim ersten Aufruf in der App gesetzt (``POST /api/setup/password``). Die Umgebung geht vor; der Server
  übernimmt sie beim Start als Hash (``adopt_env_password``), damit das Passwort auch gilt, wenn die
  Variable später fehlt. Der Rückfall „stowly" des Entwicklungsmodus wird nie gespeichert.
* **Gespeichert** wird nur ein scrypt-Hash im PHC-Format in ``meta.password_hash``, nie das Passwort.
* **Jedes Gerät** bekommt ein eigenes Token: 32 Zufallsbytes, URL-sicheres Base64 ohne Füllzeichen.
  Gespeichert wird nur der SHA-256 (hex); das Token selbst sieht der Server genau einmal.
* Tokens und das Passwort erscheinen weder im Log noch im Ereignisprotokoll.
"""

import base64
import binascii
import hashlib
import hmac
import logging
import math
import re
import secrets
import sqlite3
import threading
import time
import unicodedata
from collections import deque
from collections.abc import Callable

from stowly import db, events
from stowly.config import Settings
from stowly.contract import ids, timeutil
from stowly.contract.api import PasswordSource

log = logging.getLogger("stowly.auth")

TOKEN_BYTES = 32
BEARER = "bearer"

# Der Hash des Haushalts-Passworts in der Tabelle meta (wie die VAPID-Schlüssel, push.py).
PASSWORD_HASH = "password_hash"

# scrypt: N = 2^SCRYPT_LN, r, p; 16 Byte Salz, 32 Byte Ergebnis. Mit diesen Werten braucht scrypt etwas
# mehr als 32 MiB, die Vorgabe von OpenSSL; daher maxmem 64 MiB.
SCRYPT_LN = 15
SCRYPT_R = 8
SCRYPT_P = 1
SALT_BYTES = 16
HASH_BYTES = 32
SCRYPT_MAXMEM = 64 * 1024 * 1024
# Mehr Speicher gibt der Server auch einem fremden Hash in der Datenbank nicht.
_SCRYPT_MEMORY_LIMIT = 256 * 1024 * 1024
_PHC = re.compile(
    r"\$scrypt\$ln=([0-9]{1,2}),r=([0-9]{1,3}),p=([0-9]{1,3})\$([A-Za-z0-9+/]{16,88})\$([A-Za-z0-9+/]{16,88})"
)

NO_PASSWORD = (
    "Auf dem Server gibt es noch kein Passwort. Bitte Stowly im Browser öffnen und die Einrichtung beginnen."
)


def new_token() -> str:
    return secrets.token_urlsafe(TOKEN_BYTES)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _text_bytes(password: str) -> bytes:
    """Das Passwort als Bytes: nach NFC normalisiert, damit „ä" aus jeder Tastatur gleich zählt.

    Halbe Ersatzzeichen (aus JSON möglich) gehen unverändert durch, statt einen Fehler auszulösen.
    """
    return unicodedata.normalize("NFC", password).encode("utf-8", "surrogatepass")


def password_matches(candidate: str, expected: str) -> bool:
    """Vergleich mit dem Passwort aus der Umgebung, in konstanter Zeit. Über die Hashes, damit auch die
    Länge nichts verrät."""
    return hmac.compare_digest(
        hashlib.sha256(_text_bytes(candidate)).digest(),
        hashlib.sha256(_text_bytes(expected)).digest(),
    )


# --- scrypt im PHC-Format ----------------------------------------------------------------------


def _b64(data: bytes) -> str:
    """Base64 wie im PHC-Format: Standardalphabet, ohne Füllzeichen."""
    return base64.b64encode(data).decode("ascii").rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.b64decode(text + "=" * (-len(text) % 4), validate=True)


def hash_password(password: str) -> str:
    """``$scrypt$ln=15,r=8,p=1$<Salz>$<Hash>`` (PHC-Format, Base64 ohne Füllzeichen)."""
    salt = secrets.token_bytes(SALT_BYTES)
    digest = hashlib.scrypt(
        _text_bytes(password),
        salt=salt,
        n=2**SCRYPT_LN,
        r=SCRYPT_R,
        p=SCRYPT_P,
        maxmem=SCRYPT_MAXMEM,
        dklen=HASH_BYTES,
    )
    return f"$scrypt$ln={SCRYPT_LN},r={SCRYPT_R},p={SCRYPT_P}${_b64(salt)}${_b64(digest)}"


def verify_password(password: str, stored: str) -> bool:
    """Prüft ``password`` gegen einen Hash aus ``hash_password``, in konstanter Zeit.

    Die Werte von scrypt kommen aus dem Hash selbst. Ein Hash, der nicht passt oder unsinnige Werte trägt,
    gilt als falsch, nie als Fehler.
    """
    match = _PHC.fullmatch(stored)
    if match is None:
        return False
    ln, r, p = (int(value) for value in match.group(1, 2, 3))
    if not (1 <= ln <= 24 and 1 <= r <= 64 and 1 <= p <= 16):
        return False
    try:
        salt, expected = _unb64(match.group(4)), _unb64(match.group(5))
    except (binascii.Error, ValueError):
        return False
    # So viel braucht scrypt nach OpenSSL: 128 · r · (N + 2) für V, 128 · r · p für B, dazu etwas Luft.
    needed = 128 * r * (2**ln + 2) + 128 * r * p + 1024 * 1024
    if needed > _SCRYPT_MEMORY_LIMIT or not expected:
        return False
    try:
        digest = hashlib.scrypt(
            _text_bytes(password),
            salt=salt,
            n=2**ln,
            r=r,
            p=p,
            maxmem=max(SCRYPT_MAXMEM, needed),
            dklen=len(expected),
        )
    except (ValueError, MemoryError):
        return False
    return hmac.compare_digest(digest, expected)


# --- Woher das Passwort kommt ------------------------------------------------------------------


def stored_hash(con: sqlite3.Connection) -> str | None:
    """Der Hash aus ``meta.password_hash``; ``None``, solange keiner gespeichert ist."""
    return db.get_meta(con, PASSWORD_HASH)


def has_password(settings: Settings, con: sqlite3.Connection) -> bool:
    """Gibt es ein Haushalts-Passwort, aus der Umgebung oder als Hash? Sonst setzt es, wer zuerst kommt."""
    return settings.password is not None or stored_hash(con) is not None


def password_source(settings: Settings, con: sqlite3.Connection) -> PasswordSource:
    """``env``, wenn das Passwort aus der Umgebung kommt (auch der Rückfall des Entwicklungsmodus), sonst
    ``app``. Auch ohne jedes Passwort ``app``: Das nächste setzt die App."""
    return PasswordSource.ENV if settings.password is not None else PasswordSource.APP


def password_check(settings: Settings, con: sqlite3.Connection, candidate: str) -> Callable[[], bool] | None:
    """Die Prüfung eines Passworts für die Bremse; ``None``, wenn es noch keines gibt.

    Die Umgebung geht vor; sonst zählt der Hash aus der Datenbank. Die Bremse ruft die Prüfung unter
    ihrem Lock auf: So läuft höchstens ein scrypt zugleich.
    """
    if settings.password is not None:
        expected = settings.password
        return lambda: password_matches(candidate, expected)
    stored = stored_hash(con)
    if stored is None:
        return None
    return lambda: verify_password(candidate, stored)


# --- Geräte ------------------------------------------------------------------------------------


def bearer_token(header: str | None) -> str | None:
    """Liest das Token aus ``Authorization: Bearer <token>``; ``None`` bei allem anderen."""
    if not header:
        return None
    scheme, _, value = header.strip().partition(" ")
    value = value.strip()
    if scheme.lower() != BEARER or not value or " " in value:
        return None
    return value


def device_for_token(con: sqlite3.Connection, token: str) -> sqlite3.Row | None:
    """Das Gerät zu einem Token, sofern es bekannt und nicht gesperrt ist."""
    return con.execute(
        "SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL", (hash_token(token),)
    ).fetchone()


def _device_event(con: sqlite3.Connection, type_: str, device: sqlite3.Row, by: str, data: dict) -> None:
    now = timeutil.now()
    events.record(
        con,
        at=now,
        recorded_at=now,
        device_id=by,
        type=type_,
        entity="device",
        entity_id=device["id"],
        data=data,
    )


def _add_device(con: sqlite3.Connection, name: str) -> tuple[str, sqlite3.Row]:
    """Legt ein Gerät an, in der Transaktion des Aufrufers; liefert ``(token, gerät)``."""
    token = new_token()
    device_id = ids.new_uuid()
    con.execute(
        "INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)",
        (device_id, name, hash_token(token), timeutil.now()),
    )
    device = con.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
    _device_event(con, "device.login", device, device_id, {"name": name})
    return token, device


def create_device(con: sqlite3.Connection, name: str) -> tuple[str, sqlite3.Row]:
    """Legt ein Gerät an und liefert ``(token, gerät)``. Das Token gibt es nur hier."""
    with db.transaction(con):
        return _add_device(con, name)


def rename_device(con: sqlite3.Connection, device_id: str, name: str, *, by: str) -> sqlite3.Row | None:
    """Benennt ein Gerät um; ``None``, wenn es das Gerät nicht gibt."""
    with db.transaction(con):
        device = con.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
        if device is None:
            return None
        if device["name"] != name:
            con.execute("UPDATE devices SET name = ? WHERE id = ?", (name, device_id))
            _device_event(con, "device.renamed", device, by, {"name": name, "old": device["name"]})
        return con.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()


def revoke_device(con: sqlite3.Connection, device_id: str, *, by: str) -> bool:
    """Sperrt das Token eines Geräts. Wiederholbar; ``False``, wenn es das Gerät nicht gibt.

    Sein Push-Abo endet in derselben Transaktion (docs/integrationen.md, 4.10): Ein gesperrtes
    Gerät bekommt keine Nachricht mehr.
    """
    with db.transaction(con):
        device = con.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
        if device is None:
            return False
        if device["revoked_at"] is None:
            con.execute("UPDATE devices SET revoked_at = ? WHERE id = ?", (timeutil.now(), device_id))
            _device_event(con, "device.revoked", device, by, {"name": device["name"]})
        con.execute("DELETE FROM push_subscriptions WHERE device_id = ?", (device_id,))
        return True


# --- Das Passwort setzen, ändern, übernehmen ---------------------------------------------------


class PasswordExists(Exception):
    """Es gibt schon ein Passwort; das erste setzt nur, wer zuerst kam."""


class PasswordChanged(Exception):
    """Das Passwort hat sich geändert, während dieser Aufruf lief."""


# Ein Lock für alle Abläufe im Prozess, dazu INSERT ohne Upsert für alle Prozesse: Genau einer gewinnt.
_FIRST_PASSWORD = threading.Lock()


def _password_event(con: sqlite3.Connection, type_: str, data: dict, device_id: str | None) -> None:
    now = timeutil.now()
    events.record(
        con,
        at=now,
        recorded_at=now,
        device_id=device_id,
        type=type_,
        entity="server",
        entity_id="password",
        data=data,
    )


def set_first_password(con: sqlite3.Connection, password: str, device_name: str) -> tuple[str, sqlite3.Row]:
    """Setzt das erste Haushalts-Passwort und legt im selben Zug das Gerät an; liefert ``(token, gerät)``.

    ``PasswordExists``, wenn schon ein Hash gespeichert ist. Ob die Umgebung ein Passwort setzt, prüft
    der Aufrufer.
    """
    stored = hash_password(password)
    with _FIRST_PASSWORD:
        try:
            with db.transaction(con):
                con.execute("INSERT INTO meta (key, value) VALUES (?, ?)", (PASSWORD_HASH, stored))
                token, device = _add_device(con, device_name)
                _password_event(con, "server.password_set", {"source": PasswordSource.APP}, device["id"])
        except sqlite3.IntegrityError:
            raise PasswordExists from None
    # %r: Der Gerätename kommt aus der Anfrage; so bleibt er eine Zeile ohne Steuerzeichen im Log.
    log.info("Das Haushalts-Passwort ist gesetzt (vom Gerät %r).", device_name)
    return token, device


def replace_password(con: sqlite3.Connection, *, old: str, new_password: str, device_id: str) -> None:
    """Ersetzt den Hash ``old`` durch den des neuen Passworts. Andere Geräte bleiben angemeldet.

    ``PasswordChanged``, wenn der Hash inzwischen ein anderer ist: Dann hat ein anderes Gerät das Passwort
    gerade geändert, und dieses Ändern gilt nicht.
    """
    new = hash_password(new_password)
    with db.transaction(con):
        cursor = con.execute(
            "UPDATE meta SET value = ? WHERE key = ? AND value = ?", (new, PASSWORD_HASH, old)
        )
        if cursor.rowcount != 1:
            raise PasswordChanged
        _password_event(con, "server.password_changed", {}, device_id)
    log.info("Das Haushalts-Passwort ist geändert.")


def adopt_env_password(settings: Settings, con: sqlite3.Connection) -> bool:
    """Beim Start: übernimmt ``STOWLY_PASSWORD`` als Hash, wenn er fehlt oder nicht passt; liefert, ob sich
    etwas geändert hat. So gilt das Passwort weiter, wenn die Variable später fehlt, und es entsteht nie
    wieder ein offenes Fenster für ein „erstes Passwort". Der Rückfall des Entwicklungsmodus bleibt außen vor.
    """
    password = settings.env_password
    if password is None:
        return False
    stored = stored_hash(con)
    if stored is not None and verify_password(password, stored):
        return False
    new = hash_password(password)
    with db.transaction(con):
        con.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            (PASSWORD_HASH, new),
        )
        _password_event(con, "server.password_set", {"source": PasswordSource.ENV}, None)
    log.info("Das Passwort aus STOWLY_PASSWORD ist übernommen; es gilt auch ohne die Variable weiter.")
    return True


class LoginGuard:
    """Bremse gegen das Durchprobieren des Passworts.

    Nach ``max_failures`` Fehlversuchen innerhalb von ``window_s`` Sekunden lehnt der
    Server ``lock_s`` Sekunden lang jede Anmeldung ab. Die Sperre gilt für alle
    gemeinsam: Hinter einem Reverse Proxy ist die Adresse des Aufrufers nicht verlässlich.

    Die Fehlversuche bleiben über die Sperre hinaus im Fenster stehen. Wer danach
    weiter falsch rät, löst mit jedem Versuch sofort die nächste Sperre aus. Der Stand
    liegt im Arbeitsspeicher und beginnt mit dem Start des Servers neu.

    Dieselbe Bremse gilt für das Setzen des ersten Passworts und zählt das falsche bisherige Passwort
    beim Ändern. Jede Prüfung läuft unter ihrem Lock: So rechnet scrypt höchstens einmal zugleich.
    """

    def __init__(
        self,
        max_failures: int = 5,
        window_s: float = 300.0,
        lock_s: float = 60.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.max_failures = max_failures
        self.window_s = window_s
        self.lock_s = lock_s
        self.clock = clock
        self._failures: deque[float] = deque()
        self._locked_until = 0.0
        self._lock = threading.Lock()

    def attempt(self, check: Callable[[], bool]) -> tuple[bool, int | None]:
        """Führt einen Anmeldeversuch aus.

        Liefert ``(erfolg, wartezeit)``: ``wartezeit`` sind die Sekunden bis zum Ende
        der Sperre, wenn gerade gesperrt ist; ``check`` wird dann gar nicht aufgerufen.
        Eine Ausnahme aus ``check`` geht durch und zählt nicht als Fehlversuch.
        """
        with self._lock:
            now = self.clock()
            if now < self._locked_until:
                return False, max(1, math.ceil(self._locked_until - now))
            if check():
                self._failures.clear()
                return True, None
            while self._failures and self._failures[0] <= now - self.window_s:
                self._failures.popleft()
            self._failures.append(now)
            if len(self._failures) >= self.max_failures:
                self._locked_until = now + self.lock_s
            return False, None
