"""Anmeldung und Geräte-Token (docs/sync-protokoll.md, „Anmeldung und Geräte-Token").

* Ein Haushalts-Passwort (``STOWLY_PASSWORD``), beliebig viele Geräte.
* Jedes Gerät bekommt ein eigenes Token: 32 Zufallsbytes, URL-sicheres Base64 ohne
  Füllzeichen. Gespeichert wird nur der SHA-256 (hex); das Token selbst sieht der
  Server genau einmal, bei der Anmeldung.
* Tokens und das Passwort erscheinen weder im Log noch im Ereignisprotokoll.
"""

import hashlib
import hmac
import math
import secrets
import sqlite3
import threading
import time
from collections import deque
from collections.abc import Callable

from stowly import db, events
from stowly.contract import ids, timeutil

TOKEN_BYTES = 32
BEARER = "bearer"


def new_token() -> str:
    return secrets.token_urlsafe(TOKEN_BYTES)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def password_matches(candidate: str, expected: str) -> bool:
    """Vergleich in konstanter Zeit. Über die Hashes, damit auch die Länge nichts verrät."""
    return hmac.compare_digest(
        hashlib.sha256(candidate.encode("utf-8")).digest(),
        hashlib.sha256(expected.encode("utf-8")).digest(),
    )


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


def create_device(con: sqlite3.Connection, name: str) -> tuple[str, sqlite3.Row]:
    """Legt ein Gerät an und liefert ``(token, gerät)``. Das Token gibt es nur hier."""
    token = new_token()
    device_id = ids.new_uuid()
    with db.transaction(con):
        con.execute(
            "INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)",
            (device_id, name, hash_token(token), timeutil.now()),
        )
        device = con.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
        _device_event(con, "device.login", device, device_id, {"name": name})
    return token, device


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


class LoginGuard:
    """Bremse gegen das Durchprobieren des Passworts.

    Nach ``max_failures`` Fehlversuchen innerhalb von ``window_s`` Sekunden lehnt der
    Server ``lock_s`` Sekunden lang jede Anmeldung ab. Die Sperre gilt für alle
    gemeinsam: Hinter einem Reverse Proxy ist die Adresse des Aufrufers nicht verlässlich.

    Die Fehlversuche bleiben über die Sperre hinaus im Fenster stehen. Wer danach
    weiter falsch rät, löst mit jedem Versuch sofort die nächste Sperre aus. Der Stand
    liegt im Arbeitsspeicher und beginnt mit dem Start des Servers neu.
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
