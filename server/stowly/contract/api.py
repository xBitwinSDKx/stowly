"""Alle weiteren Endpunkte: Anmeldung, Geräte, Ereignisprotokoll, Fehlerformat."""

from enum import StrEnum
from typing import Any, Literal

from pydantic import Field

from stowly.contract.entities import DeviceName, Model, Timestamp, Uuid
from stowly.contract.limits import LIMITS


class ErrorCode(StrEnum):
    """Fehlercodes der HTTP-Schnittstelle (docs/sync-protokoll.md, „Fehlerformat")."""

    INVALID_REQUEST = "invalid_request"  # 422: Anfrage verletzt den Vertrag
    UNAUTHORIZED = "unauthorized"  # 401: Token fehlt, ist unbekannt oder gesperrt
    INVALID_PASSWORD = "invalid_password"  # 401: falsches Haushalts-Passwort
    RATE_LIMITED = "rate_limited"  # 429: zu viele Fehlversuche, Retry-After beachten
    NOT_CONFIGURED = "not_configured"  # 503: auf dem Server ist kein Passwort gesetzt
    NOT_FOUND = "not_found"  # 404
    CONFLICT = "conflict"  # 409
    PROTOCOL_MISMATCH = "protocol_mismatch"  # 409: App und Server sprechen verschiedene Protokollversionen
    PAYLOAD_TOO_LARGE = "payload_too_large"  # 413
    NOT_IMPLEMENTED = "not_implemented"  # 501
    INTERNAL = "internal"  # 500


class ErrorInfo(Model):
    code: ErrorCode
    message: str = Field(description="Deutscher Klartext, als Rückfall anzeigbar.")
    details: dict[str, Any] | None


class ErrorBody(Model):
    """Rumpf jeder Fehlerantwort der Schnittstelle."""

    error: ErrorInfo


class ServerHealth(Model):
    """Antwort von ``GET /api/health``. ``app`` ist der Marker, an dem die App den Server erkennt."""

    app: Literal["stowly"]
    status: Literal["ok"]
    version: str
    protocol: int
    time: Timestamp
    configured: bool = Field(
        description="false = STOWLY_PASSWORD ist nicht gesetzt, Anmelden ist nicht möglich."
    )


class LoginRequest(Model):
    password: str = Field(min_length=1, max_length=LIMITS["password"])
    device_name: DeviceName


class Device(Model):
    id: Uuid
    name: DeviceName
    created_at: Timestamp
    last_seen_at: Timestamp | None
    revoked_at: Timestamp | None
    current: bool = Field(description="true = das Gerät, das gerade fragt.")


class LoginResponse(Model):
    token: str = Field(
        description="Geräte-Token; bei jedem Aufruf als 'Authorization: Bearer <token>' senden."
    )
    device: Device


class DeviceList(Model):
    devices: list[Device]


class DeviceUpdate(Model):
    name: DeviceName


class EventRecord(Model):
    """Ein Eintrag des Ereignisprotokolls."""

    id: int
    at: Timestamp = Field(description="Wann es geschah (Serverzeit, aus dem Befehl berechnet).")
    recorded_at: Timestamp = Field(description="Wann der Server es verbucht hat.")
    device_id: Uuid | None
    command_id: Uuid | None
    type: str
    entity: str
    entity_id: str
    data: dict[str, Any]


class EventPage(Model):
    events: list[EventRecord] = Field(description="Neueste zuerst.")
    next_before: int | None = Field(description="Als ?before= mitsenden, um weiterzublättern; null = Ende.")
