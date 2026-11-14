"""Alle weiteren Endpunkte: Anmeldung, Geräte, Nachschlagen, Ereignisprotokoll, Fehlerformat,
dazu seit Stufe 2 Statistik, Sensor für Home Assistant, Push und der Zustand der Integrationen
(docs/sync-protokoll.md, Abschnitt 11; docs/integrationen.md)."""

from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import Field

from stowly.contract.entities import (
    Barcode,
    BrandName,
    DateStr,
    DeviceName,
    Model,
    ProductName,
    QuantityText,
    TimeOfDay,
    Timestamp,
    Uuid,
    ZoneName,
)
from stowly.contract.limits import LIMITS
from stowly.contract.timeutil import MONTH_PATTERN

# Wartezeit von GET /api/lookup/{barcode} in Sekunden: ?wait=0 bis LOOKUP_WAIT_MAX_S,
# ohne Angabe LOOKUP_WAIT_DEFAULT_S.
LOOKUP_WAIT_MAX_S = 8
LOOKUP_WAIT_DEFAULT_S = 4

# Statistik (GET /api/stats): ohne Angabe die letzten STATS_DEFAULT_MONTHS Monate bis
# einschließlich des laufenden, höchstens STATS_MAX_MONTHS Monate; die häufigsten entsorgten
# Produkte höchstens STATS_TOP_PRODUCTS.
STATS_DEFAULT_MONTHS = 12
STATS_MAX_MONTHS = 120
STATS_TOP_PRODUCTS = 10

# Sensor für Home Assistant (GET /api/ha/summary): Home Assistant begrenzt Zustände auf 255
# Zeichen. Der Satz bleibt darunter, die Listen kurz, damit auch Vorlagen-Sensoren daraus passen.
HA_SUMMARY_LIST_MAX = 5
HA_SUMMARY_ENTRY_MAX = 40
HA_SUMMARY_MESSAGE_MAX = 255

# Liste aller Waren für Home Assistant (GET /api/ha/stock): je Zone die Produkte, zum Anzeigen in
# einer Karte. Namen höchstens HA_STOCK_NAME_MAX Zeichen; über alle Zonen höchstens
# HA_STOCK_ENTRY_MAX Einträge, danach ist die Liste gekürzt (Zahlen zählen trotzdem alles).
HA_STOCK_NAME_MAX = 60
HA_STOCK_ENTRY_MAX = 300

# Einkaufsliste nach Bring! über Home Assistant (docs/integrationen.md, 5.2 und 5.4): Ein offener
# Eintrag geht erst nach Bring!, wenn er so viele Sekunden offen ist (Zeit für Rückgängig und
# Tippfehler); der Abgleich läuft spätestens nach so vielen Sekunden wieder.
HA_MIRROR_DELAY_S = 120
HA_SYNC_INTERVAL_S = 120

# Testnachricht (POST /api/push/test): höchstens eine je Gerät in diesem Abstand.
PUSH_TEST_INTERVAL_S = 10

# Wohin eine Push-Nachricht führt: Der Server setzt den Ursprung der App davor, den sie beim
# Anmelden mitgibt (docs/integrationen.md, 4.5). Es sind Adressen der Web-App
# (ROUTES in web/src/contract/routes.ts: warnings, settings).
PUSH_PATHS = {"daily": "/warnungen", "test": "/einstellungen"}

Month = Annotated[str, Field(pattern=MONTH_PATTERN)]
Count = Annotated[int, Field(ge=0)]
Share = Annotated[float, Field(ge=0, le=1)]


class ErrorCode(StrEnum):
    """Fehlercodes der HTTP-Schnittstelle (docs/sync-protokoll.md, „Fehlerformat")."""

    INVALID_REQUEST = "invalid_request"  # 422: Anfrage verletzt den Vertrag
    UNAUTHORIZED = "unauthorized"  # 401: Token fehlt, ist unbekannt oder gesperrt
    INVALID_PASSWORD = "invalid_password"  # 401: falsches Haushalts-Passwort
    RATE_LIMITED = "rate_limited"  # 429: zu viele Fehlversuche, Retry-After beachten
    # 503: Auf dem Server ist kein Passwort gesetzt, oder eine Integration, die der Aufruf braucht,
    # ist nicht eingerichtet (Push: STOWLY_PUSH_CONTACT, Sensor: STOWLY_HA_SUMMARY_TOKEN).
    NOT_CONFIGURED = "not_configured"
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


# --- Statistik (GET /api/stats) ---------------------------------------------------------


class StatsMonth(Model):
    month: Month = Field(description="Kalendermonat in der Zeitzone des Servers, 'YYYY-MM'.")
    consumed: int = Field(ge=0, description="Packungen, in diesem Monat als verbraucht entnommen.")
    discarded: int = Field(ge=0, description="Packungen, in diesem Monat als entsorgt entnommen.")


class StatsProduct(Model):
    product_id: Uuid = Field(description="Das Produkt; nach einer Zusammenführung das Ziel.")
    name: ProductName = Field(description="Name des Produkts; leer bei Platzhaltern.")
    barcode: Barcode | None = Field(description="Erster Barcode, als Anzeige für Platzhalter; null = keiner.")
    discarded: int = Field(ge=1, description="Entsorgte Packungen im Zeitraum.")


class StatsZone(Model):
    zone_id: Uuid
    name: ZoneName
    consumed: int = Field(ge=0)
    discarded: int = Field(ge=0)


class Stats(Model):
    """Verbraucht und entsorgt im Zeitraum. „Versehentlich" (mistake) zählt nirgends mit."""

    start: Month = Field(description="Erster Monat des Zeitraums.")
    end: Month = Field(description="Letzter Monat des Zeitraums (eingeschlossen).")
    months: list[StatsMonth] = Field(description="Jeder Monat des Zeitraums, aufsteigend, auch leere.")
    consumed: int = Field(ge=0)
    discarded: int = Field(ge=0)
    discarded_share: Share | None = Field(
        description="Anteil des Entsorgten an verbraucht + entsorgt, 0 bis 1; null, wenn beides 0 ist."
    )
    top_discarded: list[StatsProduct] = Field(
        description="Die am häufigsten entsorgten Produkte, meiste zuerst, höchstens 10."
    )
    zones: list[StatsZone] = Field(
        description="Je nicht gelöschter Zone, in der Reihenfolge der Zonen, auch mit 0."
    )
    timezone: str = Field(description="Zeitzone, in der die Monate gerechnet sind (STOWLY_TIMEZONE).")


# --- Sensor für Home Assistant (GET /api/ha/summary) ------------------------------------


class HaSummaryNext(Model):
    """Das nächste ablaufende Produkt: die nicht abgelaufene Packung mit dem frühesten MHD."""

    name: str = Field(description="Anzeigename des Produkts (bei Platzhaltern der Barcode).")
    best_before: DateStr
    days: int = Field(ge=0, description="Tage bis zum MHD; 0 = heute.")
    count: int = Field(ge=1, description="Packungen dieses Produkts mit diesem MHD.")
    zone: str = Field(description="Name der Zone der ersten dieser Packungen.")


class HaSummary(Model):
    """Zusammenfassung für die rest-Integration von Home Assistant (docs/integrationen.md, Abschnitt 6)."""

    state: int = Field(
        ge=0, description="Zustand des Sensors: Packungen, die bald ablaufen (heute eingeschlossen)."
    )
    today: int = Field(ge=0, description="Davon: Packungen, deren MHD heute ist.")
    expired: int = Field(ge=0, description="Abgelaufene Packungen.")
    total: int = Field(ge=0, description="Packungen im Bestand.")
    next: HaSummaryNext | None = Field(description="Das nächste ablaufende Produkt; null = keines.")
    shopping: int = Field(ge=0, description="Offene Einträge der Einkaufsliste.")
    soon_list: list[str] = Field(
        description="Bald ablaufend, nach MHD, höchstens 5 Einträge wie 'Joghurt (16.11.)'."
    )
    expired_list: list[str] = Field(description="Abgelaufen, nach MHD, höchstens 5 Einträge.")
    shopping_list: list[str] = Field(description="Offene Einträge der Einkaufsliste, höchstens 5.")
    message: str = Field(
        max_length=HA_SUMMARY_MESSAGE_MAX, description="Fertiger deutscher Satz zum Vorlesen."
    )
    updated_at: Timestamp = Field(description="Serverzeit der Antwort.")


# --- Liste aller Waren für Home Assistant (GET /api/ha/stock) ---------------------------


class HaStockProduct(Model):
    """Ein Produkt in einer Zone: seine Packungen dort, beschrieben durch die mit dem frühesten MHD."""

    name: str = Field(
        max_length=HA_STOCK_NAME_MAX,
        description="Anzeigename des Produkts (bei Platzhaltern der Barcode), höchstens 60 Zeichen.",
    )
    count: int = Field(ge=1, description="Packungen dieses Produkts in dieser Zone.")
    best_before: DateStr | None = Field(
        description="Das früheste MHD dieser Packungen; null = keine hat ein MHD."
    )
    mhd: str | None = Field(description="best_before als TT.MM.JJJJ zum Anzeigen; null wie best_before.")
    days: int | None = Field(
        description="Tage bis best_before: 0 = heute, negativ = abgelaufen; null wie best_before."
    )
    state: Literal["none", "ok", "soon", "expired"] = Field(
        description="Warnstufe der Packung mit dem frühesten MHD (none = ohne MHD)."
    )


class HaStockZone(Model):
    """Eine Zone mit Bestand."""

    name: str = Field(description="Name der Zone.")
    count: int = Field(ge=1, description="Packungen in dieser Zone, auch wenn die Liste gekürzt ist.")
    products: list[HaStockProduct] = Field(
        description="Nach dem frühesten MHD (ohne MHD zuletzt), dann nach Name, dann nach Produkt."
    )


class HaStock(Model):
    """Alle Waren im Bestand je Zone, für die rest-Integration von Home Assistant (docs/integrationen.md, 6.3)."""

    state: int = Field(ge=0, description="Zustand des Sensors: Packungen im Bestand.")
    product_count: int = Field(ge=0, description="Verschiedene Produkte im Bestand.")
    zones: list[HaStockZone] = Field(description="Zonen mit Bestand, in der Reihenfolge der Zonen.")
    truncated: bool = Field(
        description="true: nach 300 Einträgen gekürzt; state, product_count und count zählen trotzdem alles."
    )
    updated_at: Timestamp = Field(description="Serverzeit der Antwort.")


# --- Push (GET /api/push/key, PUT und DELETE /api/push/subscription, POST /api/push/test) --


class PushKey(Model):
    public_key: str = Field(
        description=(
            "Öffentlicher VAPID-Schlüssel des Servers: P-256, unkomprimiert (65 Byte), base64url ohne "
            "Füllzeichen. Für pushManager.subscribe als applicationServerKey."
        )
    )


class PushSubscriptionKeys(Model):
    p256dh: str = Field(
        min_length=1, max_length=120, description="Öffentlicher Schlüssel des Browsers (65 Byte), base64url."
    )
    auth: str = Field(min_length=1, max_length=40, description="Geheimnis des Abos (16 Byte), base64url.")


class PushSubscriptionInput(Model):
    """Das Push-Abo dieses Geräts; ersetzt ein früheres desselben Geräts."""

    endpoint: str = Field(
        min_length=1,
        max_length=LIMITS["push_endpoint"],
        description="https-Adresse beim Push-Dienst (PushSubscription.endpoint); nur bekannte Push-Dienste.",
    )
    keys: PushSubscriptionKeys
    origin: str = Field(
        min_length=1,
        max_length=LIMITS["push_origin"],
        description="Ursprung der App (location.origin); daraus baut der Server die Adresse in der Nachricht.",
    )


class PushTestStatus(StrEnum):
    SENT = "sent"  # der Push-Dienst hat die Nachricht angenommen (2xx)
    GONE = "gone"  # das Abo gilt nicht mehr (404, 410); der Server hat es gelöscht
    REJECTED = "rejected"  # der Push-Dienst lehnt ab (400, 401, 403, 413): Einrichtung prüfen
    FAILED = "failed"  # vorübergehend: 429, 5xx, Netzfehler, Zeitüberschreitung


class PushTestResult(Model):
    status: PushTestStatus
    http_status: int | None = Field(description="Antwort des Push-Dienstes; null ohne Antwort.")
    message: str = Field(description="Deutscher Klartext, als Rückfall anzeigbar.")


# --- Zustand der Integrationen (GET /api/integrations) ----------------------------------


class BackupStatus(Model):
    """Automatische Sicherung (docs/integrationen.md, Abschnitt 3). Nie ein Schlüssel im Klartext."""

    configured: bool = Field(description="STOWLY_BACKUP_DIR und STOWLY_BACKUP_RECIPIENTS sind gesetzt.")
    problem: str | None = Field(
        description="Warum die Sicherung aus ist, obwohl etwas gesetzt ist; sonst null."
    )
    time: TimeOfDay | None = Field(description="Uhrzeit der täglichen Sicherung (STOWLY_BACKUP_TIME).")
    recipients: list[str] = Field(description="Öffentliche age-Schlüssel, gekürzt: 'age1ql3z…ac8p'.")
    last_ok_at: Timestamp | None = Field(description="Letzte gelungene Sicherung.")
    last_file: str | None = Field(description="Dateiname der letzten gelungenen Sicherung.")
    last_size: Count | None = Field(description="Größe der letzten gelungenen Sicherung in Byte.")
    last_error: str | None = Field(description="Fehler des letzten Versuchs; null nach einem Erfolg.")
    last_error_at: Timestamp | None
    next_at: Timestamp | None = Field(description="Nächster geplanter Versuch; null = keiner.")
    warning: bool = Field(
        description="Seit 48 Stunden keine gelungene Sicherung (Regel: docs/integrationen.md, 3.6)."
    )


class HaState(StrEnum):
    """Ergebnis des letzten Abgleichs mit Home Assistant."""

    OFF = "off"  # nicht eingerichtet
    PENDING = "pending"  # eingerichtet, seit dem Start noch kein Abgleich
    OK = "ok"  # letzter Abgleich gelungen
    UNAUTHORIZED = "unauthorized"  # HA lehnt den Token ab (401)
    NOT_FOUND = "not_found"  # die To-do-Liste gibt es nicht (404)
    UNAVAILABLE = "unavailable"  # HA antwortet, die Liste ist aber nicht verfügbar
    UNREACHABLE = "unreachable"  # HA nicht erreichbar: Netz, Zeitüberschreitung, Zertifikat
    ERROR = "error"  # anderer Fehler (5xx, unerwartete Antwort)


class HaStatus(Model):
    """Home Assistant und Bring! (docs/integrationen.md, Abschnitt 5). Nie ein Token."""

    configured: bool = Field(
        description="STOWLY_HA_URL, STOWLY_HA_TOKEN und STOWLY_HA_TODO_ENTITY sind gesetzt."
    )
    problem: str | None = Field(
        description="Warum der Abgleich aus ist, obwohl etwas gesetzt ist; sonst null."
    )
    entity: str | None = Field(description="Die To-do-Liste in HA (STOWLY_HA_TODO_ENTITY).")
    state: HaState
    last_ok_at: Timestamp | None = Field(description="Letzter gelungener Abgleich.")
    last_error: str | None = Field(description="Fehler des letzten Abgleichs; null nach einem Erfolg.")
    last_error_at: Timestamp | None
    linked: int = Field(ge=0, description="Offene Einträge, die gerade in Bring! stehen.")
    sensor: bool = Field(description="Der Sensor ist eingerichtet (STOWLY_HA_SUMMARY_TOKEN).")


class PushStatus(Model):
    """Benachrichtigungen per Web-Push (docs/integrationen.md, Abschnitt 4)."""

    configured: bool = Field(description="STOWLY_PUSH_CONTACT ist gesetzt.")
    problem: str | None = Field(description="Warum Push aus ist, obwohl etwas gesetzt ist; sonst null.")
    subscriptions: int = Field(ge=0, description="Geräte des Haushalts mit Push-Abo.")
    this_device: bool = Field(description="Das fragende Gerät hat ein Abo beim Server.")
    last_run_at: Timestamp | None = Field(description="Letzter Lauf der Tagesnachricht, auch ohne Neues.")
    last_sent_at: Timestamp | None = Field(description="Letzte verschickte Tagesnachricht.")
    last_error: str | None = Field(description="Fehler des letzten Laufs; null nach einem Erfolg.")


class IntegrationStatus(Model):
    """Zustand von Sicherung, Home Assistant und Push für die Einstellungen der App."""

    timezone: str = Field(
        description="Zeitzone des Servers für Uhrzeiten und den heutigen Tag (STOWLY_TIMEZONE)."
    )
    backup: BackupStatus
    ha: HaStatus
    push: PushStatus
