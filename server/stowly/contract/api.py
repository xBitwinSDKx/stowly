"""Alle weiteren Endpunkte: Anmeldung, Geräte, Nachschlagen, Ereignisprotokoll, Fehlerformat."""

from enum import StrEnum
from typing import Any, Literal

from pydantic import Field

from stowly.contract.entities import (
    Barcode,
    BrandName,
    DeviceName,
    Model,
    ProductName,
    QuantityText,
    Timestamp,
    Uuid,
)
from stowly.contract.limits import LIMITS

# Wartezeit von GET /api/lookup/{barcode} in Sekunden: ?wait=0 bis LOOKUP_WAIT_MAX_S,
# ohne Angabe LOOKUP_WAIT_DEFAULT_S.
LOOKUP_WAIT_MAX_S = 8
LOOKUP_WAIT_DEFAULT_S = 4


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


class LookupResultState(StrEnum):
    """Ergebnis von ``GET /api/lookup/{barcode}`` (docs/sync-protokoll.md, Abschnitt 10)."""

    FOUND = "found"  # Open Food Facts kennt den Barcode (gespeichert oder eben abgefragt)
    NOT_FOUND = "not_found"  # Open Food Facts kennt ihn nicht
    PENDING = "pending"  # in der Wartezeit keine Antwort; der Server fragt im Hintergrund weiter
    SKIPPED = "skipped"  # ladeninterner Code (Präfix 2): wird nie nachgeschlagen
    DISABLED = "disabled"  # Nachschlagen ist am Server ausgeschaltet (STOWLY_OFF_ENABLED)


class LookupResult(Model):
    """Antwort von ``GET /api/lookup/{barcode}``. Leere Felder sind ``""``, nie ``null`` (außer ``image_id``)."""

    barcode: Barcode
    state: LookupResultState
    name: ProductName = Field(description="Wie beim Füllen eines Produkts aufbereitet; leer, wenn unbekannt.")
    brand: BrandName = Field(description="Der erste Eintrag von brands; leer, wenn unbekannt.")
    quantity: QuantityText = Field(description="Packungsgröße ohne Schätzzeichen; leer, wenn unbekannt.")
    image_id: str | None = Field(
        description="Bild-ID für GET /api/images/{id}, wenn das Bild schon beim Server liegt; sonst null."
    )


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
