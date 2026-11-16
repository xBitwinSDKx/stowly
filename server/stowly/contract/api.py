"""Alle weiteren Endpunkte: Anmeldung, Geräte, Nachschlagen, Ereignisprotokoll, Fehlerformat,
dazu seit Stufe 2 Statistik, Sensor für Home Assistant, Push und der Zustand der Integrationen,
seit der Einrichtung das erste Passwort, HTTPS, Einstellungen des Servers und das Koppeln eines Pi
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

# Updates über GitHub (docs/integrationen.md, Abschnitt 10): Der Server fragt eine Minute nach dem
# Start, dann alle UPDATE_CHECK_INTERVAL_S Sekunden nach dem neuesten Release, auf Knopfdruck
# (POST /api/update/check) höchstens einmal in UPDATE_CHECK_MIN_GAP_S Sekunden. Die Änderungen des
# Releases kommen gekürzt auf UPDATE_NOTES_MAX Zeichen mit. Der Updater auf dem Rechner gilt als
# eingerichtet, wenn er sich vor höchstens UPDATER_READY_S Sekunden gemeldet hat; holt er eine
# Anforderung nicht binnen UPDATE_REQUEST_STALE_S Sekunden ab, meldet die App das.
UPDATE_CHECK_FIRST_S = 60
UPDATE_CHECK_INTERVAL_S = 6 * 3600
UPDATE_CHECK_MIN_GAP_S = 60
UPDATE_NOTES_MAX = 4000
UPDATER_READY_S = 600
UPDATE_REQUEST_STALE_S = 600
# Versionen sind SemVer ohne Zusatz, im Release-Tag mit oder ohne „v" davor.
VERSION_PATTERN = r"^[0-9]+\.[0-9]+\.[0-9]+$"

# Wohin eine Push-Nachricht führt: Der Server setzt den Ursprung der App davor, den sie beim
# Anmelden mitgibt (docs/integrationen.md, 4.5). Es sind Adressen der Web-App
# (ROUTES in web/src/contract/routes.ts: warnings, settings).
PUSH_PATHS = {"daily": "/warnungen", "test": "/einstellungen", "update": "/einstellungen"}

Month = Annotated[str, Field(pattern=MONTH_PATTERN)]
Count = Annotated[int, Field(ge=0)]
Share = Annotated[float, Field(ge=0, le=1)]


class ErrorCode(StrEnum):
    """Fehlercodes der HTTP-Schnittstelle (docs/sync-protokoll.md, „Fehlerformat")."""

    INVALID_REQUEST = "invalid_request"  # 422: Anfrage verletzt den Vertrag
    UNAUTHORIZED = "unauthorized"  # 401: Token fehlt, ist unbekannt oder gesperrt
    INVALID_PASSWORD = "invalid_password"  # 401: falsches Haushalts-Passwort (auch beim Ändern)
    RATE_LIMITED = "rate_limited"  # 429: zu viele Fehlversuche, Retry-After beachten
    # 503: Auf dem Server gibt es noch kein Passwort, oder eine Integration, die der Aufruf braucht,
    # ist nicht eingerichtet (Push: kein Kontakt, Sensor: STOWLY_HA_SUMMARY_TOKEN, Updates: aus
    # oder der Updater meldet sich nicht, Pi koppeln: keine CA oder kein Paket für den Pi).
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
        description=(
            "false = es gibt noch kein Haushalts-Passwort (weder STOWLY_PASSWORD noch in der App "
            "gesetzt). Die App zeigt dann die Einrichtung (POST /api/setup/password)."
        )
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

    configured: bool = Field(
        description="Ein Kontakt für die Push-Dienste ist wirksam (STOWLY_PUSH_CONTACT oder in der App)."
    )
    problem: str | None = Field(description="Warum Push aus ist, obwohl etwas gesetzt ist; sonst null.")
    subscriptions: int = Field(ge=0, description="Geräte des Haushalts mit Push-Abo.")
    this_device: bool = Field(description="Das fragende Gerät hat ein Abo beim Server.")
    last_run_at: Timestamp | None = Field(description="Letzter Lauf der Tagesnachricht, auch ohne Neues.")
    last_sent_at: Timestamp | None = Field(description="Letzte verschickte Tagesnachricht.")
    last_error: str | None = Field(description="Fehler des letzten Laufs; null nach einem Erfolg.")


class UpdateState(StrEnum):
    """Wo ein Update steht (docs/integrationen.md, 10.4)."""

    IDLE = "idle"  # nichts angefordert, oder das Ergebnis betrifft eine andere Version
    REQUESTED = "requested"  # angefordert, der Updater hat es noch nicht aufgenommen
    INSTALLING = "installing"  # der Updater arbeitet daran
    DONE = "done"  # installiert: Dieser Server läuft mit state_version
    FAILED = "failed"  # gescheitert; state_message sagt warum, die vorige Version läuft


class UpdaterKind(StrEnum):
    """Welcher Updater sich meldet (docs/integrationen.md, 10.3 und 10.7)."""

    SCRIPT = "script"  # updater/stowly-update.sh auf dem Rechner (Compose und .env)
    CONTAINER = "container"  # Updater-Container (python -m stowly.updater, Engine API)


class UpdateStatus(Model):
    """Updates über GitHub (docs/integrationen.md, Abschnitt 10). Nie ein Token."""

    configured: bool = Field(
        description="Updates sind an: STOWLY_UPDATE_REPO ist gesetzt oder der Schalter in der App an."
    )
    repo: str | None = Field(description="Das Repository der Releases; null, solange Updates aus sind.")
    current: str = Field(description="Version dieses Servers.")
    latest: str | None = Field(
        description='Version des neuesten Releases ohne „v"; null = noch nicht gefragt oder keins.'
    )
    latest_name: str | None = Field(description="Titel des neuesten Releases.")
    notes: str | None = Field(
        description="Änderungen des neuesten Releases als Markdown-Text, höchstens 4000 Zeichen."
    )
    published_at: Timestamp | None = Field(description="Wann das neueste Release erschienen ist.")
    url: str | None = Field(description="Seite des neuesten Releases auf GitHub.")
    available: bool = Field(description="latest ist neuer als current.")
    checked_at: Timestamp | None = Field(description="Letzte gelungene Abfrage bei GitHub.")
    check_error: str | None = Field(description="Fehler der letzten Abfrage; null nach einem Erfolg.")
    updater_ready: bool = Field(
        description="Der Updater auf dem Rechner hat sich vor höchstens 10 Minuten gemeldet."
    )
    updater_seen_at: Timestamp | None = Field(description="Letzte Meldung des Updaters.")
    updater_kind: UpdaterKind | None = Field(
        description="Welcher Updater sich zuletzt gemeldet hat; null = noch keiner."
    )
    updater_version: str | None = Field(description="Version des Updaters, soweit er sie meldet.")
    updater_command: str | None = Field(
        description=(
            "Befehl, der den Updater-Container anlegt oder erneuert (einmal als root, etwa im "
            "Aufgabenplaner von DSM); null, wenn das Image keine Referenz kennt "
            "(STOWLY_IMAGE_REF) oder Stowly seinen Container nicht erkennt."
        )
    )
    state: UpdateState
    state_version: str | None = Field(description="Die Version, um die es in state geht.")
    state_at: Timestamp | None = Field(description="Seit wann state gilt.")
    state_message: str | None = Field(
        description="Erklärung zu state, bei failed der Grund; sonst meist null."
    )


class UpdateInstallInput(Model):
    """Anforderung eines Updates (POST /api/update/install)."""

    version: Annotated[str, Field(pattern=VERSION_PATTERN, max_length=40)] = Field(
        description="Die Version, die die App als neueste gezeigt hat; muss latest sein."
    )


class IntegrationStatus(Model):
    """Zustand von Sicherung, Home Assistant, Push und Updates für die Einstellungen der App."""

    timezone: str = Field(
        description="Zeitzone des Servers für Uhrzeiten und den heutigen Tag (STOWLY_TIMEZONE)."
    )
    backup: BackupStatus
    ha: HaStatus
    push: PushStatus
    update: UpdateStatus


# --- Einrichtung (docs/sync-protokoll.md, 11.6; docs/integrationen.md, Abschnitt 11) -----

# Zertifikat des Servers: so viele Tage gültig; neu ausgestellt, sobald weniger als
# SERVER_CERT_RENEW_DAYS übrig sind (Apple erlaubt höchstens 825 Tage, 397 halten auch strengere Regeln).
SERVER_CERT_DAYS = 397
SERVER_CERT_RENEW_DAYS = 60
# Zertifikat eines gekoppelten Pi: so viele Tage; die App warnt PI_CERT_WARN_DAYS vor dem Ende.
PI_CERT_DAYS = 825
PI_CERT_WARN_DAYS = 60
# Port, unter dem HTTPS von außen erreichbar ist, solange Stowly ihn nicht kennt.
HTTPS_PORT_DEFAULT = 8443

NewPassword = Annotated[str, Field(min_length=LIMITS["password_min"], max_length=LIMITS["password"])]
SetupAddressText = Annotated[str, Field(min_length=1, max_length=LIMITS["setup_address"])]
PortNumber = Annotated[int, Field(ge=1, le=65535)]


class SetupPasswordInput(Model):
    """Das erste Haushalts-Passwort (``POST /api/setup/password``)."""

    password: NewPassword
    device_name: DeviceName


class PasswordChangeInput(Model):
    """Neues Haushalts-Passwort (``POST /api/auth/password``)."""

    current_password: str = Field(min_length=1, max_length=LIMITS["password"])
    new_password: NewPassword


class PasswordSource(StrEnum):
    """Woher das Haushalts-Passwort kommt."""

    ENV = "env"  # STOWLY_PASSWORD; in der App nicht änderbar
    APP = "app"  # in der App gesetzt (nur sein Hash steht in der Datenbank)


class ConfigSource(StrEnum):
    """Woher ein wirksamer Wert kommt (docs/integrationen.md, Abschnitt 12)."""

    ENV = "env"  # aus der Umgebung (.env, Einstellungen des Containers); in der App nicht änderbar
    APP = "app"  # in der App gesetzt
    DEFAULT = "default"  # Vorgabe von Stowly bzw. des Images


class SetupStepId(StrEnum):
    """Die Schritte des Assistenten nach dem Passwort, in dieser Reihenfolge."""

    HTTPS = "https"  # sichere Verbindung
    PRINTER = "printer"  # Drucker (Raspberry Pi)
    UPDATES = "updates"  # Updates
    NOTIFICATIONS = "notifications"  # Benachrichtigungen


class SetupStepState(StrEnum):
    OPEN = "open"
    DONE = "done"
    SKIPPED = "skipped"


class SetupStep(Model):
    id: SetupStepId
    state: SetupStepState = Field(description="Wie die App den Schritt markiert hat; ohne Markierung open.")
    ready: bool = Field(
        description=(
            "Aus Sicht des Servers erledigt: https = eine angemeldete Anfrage kam über den HTTPS-Listener; "
            "printer = es gibt einen Drucker; updates = Updates sind an; notifications = ein Kontakt "
            "für die Push-Dienste ist wirksam."
        )
    )
    changed_at: Timestamp | None = Field(description="Wann state zuletzt gesetzt wurde.")


class AddressSource(StrEnum):
    LEARNED = "learned"  # aus der Kopfzeile Host einer Anfrage gelernt
    MANUAL = "manual"  # in der App eingetragen


class SetupAddress(Model):
    address: str = Field(description="IP-Adresse oder Name, unter dem Stowly erreichbar ist, ohne Port.")
    source: AddressSource
    in_certificate: bool = Field(description="Das aktuelle Zertifikat des Servers gilt für diese Adresse.")


class CaInfo(Model):
    """Die Zertifizierungsstelle von Stowly. Nie ein Schlüssel."""

    name: str
    fingerprint_sha256: str = Field(
        description="SHA-256 des Zertifikats, Großbuchstaben mit Doppelpunkten (AB:CD:…)."
    )
    not_after: Timestamp
    created_by_stowly: bool = Field(description="false = von Hand nach /data/tls gelegt.")
    name_constraints: bool = Field(description="Die CA beglaubigt nur Adressen im Heimnetz.")


class CertificateInfo(Model):
    """Das Zertifikat des HTTPS-Listeners."""

    addresses: list[str] = Field(description="Adressen (SAN) des Zertifikats.")
    not_after: Timestamp


class PortSource(StrEnum):
    DEFAULT = "default"  # Vorgabe HTTPS_PORT_DEFAULT
    LEARNED = "learned"  # aus einer Anfrage über den HTTPS-Listener gelernt
    MANUAL = "manual"  # in der App eingetragen


class HttpsStatus(Model):
    """HTTPS durch Stowly selbst (docs/integrationen.md, Abschnitt 11)."""

    enabled: bool = Field(description="Stowly hat einen HTTPS-Listener (STOWLY_HTTPS_PORT ist gesetzt).")
    listening: bool = Field(description="Der HTTPS-Listener läuft.")
    problem: str | None = Field(
        description="Warum HTTPS nicht läuft oder kein brauchbares Zertifikat hat; sonst null."
    )
    port: PortNumber | None = Field(
        description="Port, unter dem HTTPS von außen erreichbar ist; null ohne HTTPS-Listener."
    )
    port_source: PortSource
    http_port: PortNumber | None = Field(
        description=(
            "Port, unter dem HTTP von außen erreichbar ist, gelernt aus Anfragen über HTTP (für den "
            "Download der CA und den Befehl für den Pi); null = noch nicht gesehen."
        )
    )
    addresses: list[SetupAddress] = Field(description="Höchstens 10, gelernte zuerst.")
    origins: list[str] = Field(description="HTTPS-Ursprünge der App, etwa https://192.168.1.10:8443.")
    seen_at: Timestamp | None = Field(description="Letzte angemeldete Anfrage über den HTTPS-Listener.")
    via_https: bool = Field(description="Diese Anfrage kam über den HTTPS-Listener von Stowly.")
    ca: CaInfo | None = Field(description="null = keine nutzbare CA (problem sagt warum).")
    certificate: CertificateInfo | None


class PairedPrinter(Model):
    """Ein Drucker an einem gekoppelten Pi, mit dem Ablauf von dessen Zertifikat."""

    printer_id: Uuid
    hostname: str = Field(description="Hostname des Pi bei der Kopplung.")
    not_after: Timestamp = Field(
        description="Ablauf des Zertifikats; die App warnt PI_CERT_WARN_DAYS Tage vorher."
    )


class SetupStatus(Model):
    """Stand der Einrichtung (``GET /api/setup``). Nie ein Schlüssel, nie ein Passwort."""

    password_source: PasswordSource
    steps: list[SetupStep] = Field(description="Alle Schritte, in der Reihenfolge des Assistenten.")
    finished_at: Timestamp | None = Field(
        description="Wann die Einrichtung abgeschlossen wurde; null = offen."
    )
    paired_printers: list[PairedPrinter] = Field(
        description=(
            "Je nicht gelöschtem Drucker die jüngste Kopplung eines Pi, früheste Ablaufzeit zuerst. "
            "Daran warnt jedes Gerät vor dem Ablauf des Zertifikats."
        )
    )
    https: HttpsStatus


class SetupStepChange(Model):
    id: SetupStepId
    state: SetupStepState


class SetupChanges(Model):
    """Änderungen an der Einrichtung (``PATCH /api/setup``). Nur vorhandene Felder zählen."""

    step: SetupStepChange = Field(default=None, description="Einen Schritt markieren.")
    finished: bool = Field(default=None, description="true = abschließen, false = wieder öffnen.")
    addresses: list[SetupAddressText] = Field(
        default=None,
        max_length=LIMITS["setup_addresses"],
        description=(
            "Die von Hand eingetragenen Adressen (IP oder Name, ohne Port); ersetzt die bisherigen. "
            "Gelernte bleiben. Jede muss im Heimnetz liegen und von der CA gedeckt sein."
        ),
    )
    https_port: PortNumber | None = Field(
        default=None, description="Port, unter dem HTTPS von außen erreichbar ist; null = wieder lernen."
    )


# --- Einstellungen des Servers aus der App (docs/integrationen.md, Abschnitt 12) ---------

PushContact = Annotated[str, Field(min_length=1, max_length=LIMITS["push_contact"])]


class PushConfig(Model):
    contact: str | None = Field(
        description="Wirksamer Kontakt für die Push-Dienste (mailto: oder https); null = keiner, Push ist aus."
    )
    source: ConfigSource


class UpdateConfig(Model):
    enabled: bool = Field(description="Der Server fragt GitHub nach neuen Versionen.")
    repo: str | None = Field(description="Das Repository der Releases; null = keines bekannt.")
    source: ConfigSource = Field(
        description=(
            "env: STOWLY_UPDATE_REPO (immer an); app: Schalter in der App; default: noch nicht "
            "geschaltet, aus."
        )
    )
    available: bool = Field(
        description=(
            "Der Schalter wirkt: Das Image kennt ein Repository (STOWLY_UPDATE_REPO_DEFAULT) und die "
            "Umgebung legt nichts fest."
        )
    )


class ServerConfig(Model):
    """Einstellungen des Servers, die auch in der App gehen. Die Umgebung geht vor; nie ein Geheimnis."""

    push: PushConfig
    update: UpdateConfig


class ServerConfigChanges(Model):
    """``PATCH /api/server-config``. Nur vorhandene Felder zählen; 409, wenn das Feld aus der Umgebung kommt."""

    push_contact: PushContact | None = Field(
        default=None,
        description=(
            "mailto:<Adresse> oder eine https-Adresse; eine Adresse ohne mailto: bekommt es davor. "
            "null = entfernen (Push ist dann aus)."
        ),
    )
    update_enabled: bool = Field(default=None)


# --- Pi koppeln (docs/sync-protokoll.md, 11.8; docs/etiketten.md) ----------------------

# Ein Kopplungscode gilt so viele Sekunden. Meldet sich der Pi (POST /api/pi/pair/start), gilt er ab
# da noch einmal so lange: Die Installation auf einem frischen Pi braucht Zeit.
PI_PAIRING_TTL_S = 1800
# Der Code: 8 Zeichen aus Crockford-Base32 (Ziffern und Großbuchstaben ohne I, L, O, U), angezeigt
# als XXXX-XXXX. Der Server liest ihn großzügig: Kleinschreibung, Bindestriche und Leerzeichen zählen
# nicht, O gilt als 0, I und L als 1.
PI_PAIRING_CODE_LENGTH = 8
PI_HOSTNAME_PATTERN = r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$"
PI_TOKEN_PATTERN = r"^[A-Za-z0-9_-]+$"
PI_CSR_MAX = 8192

PairingCode = Annotated[str, Field(min_length=PI_PAIRING_CODE_LENGTH, max_length=20)]
PiHostname = Annotated[str, Field(pattern=PI_HOSTNAME_PATTERN, max_length=63)]
SoftwareVersion = Annotated[str, Field(min_length=1, max_length=40)]


class PiPairingState(StrEnum):
    WAITING = "waiting"  # Code erzeugt, der Pi hat sich noch nicht gemeldet
    INSTALLING = "installing"  # der Pi hat sich gemeldet und richtet sich ein
    PAIRED = "paired"  # gekoppelt: Zertifikat ausgestellt, Drucker angelegt oder übernommen
    EXPIRED = "expired"  # die Frist lief ab, ohne dass der Pi gekoppelt wurde
    CANCELLED = "cancelled"  # abgebrochen oder durch einen neueren Code ersetzt


class PiPairingInput(Model):
    """Neuer Kopplungscode (``POST /api/pi/pairings``)."""

    origin: str = Field(
        min_length=1,
        max_length=LIMITS["push_origin"],
        description="Ursprung der App (location.origin): Der Pi erlaubt ihn, und der Befehl baut darauf auf.",
    )
    printer_id: Uuid | None = Field(
        default=None, description="Einen vorhandenen direkten Drucker übernehmen; null = neu anlegen."
    )


class PiInfo(Model):
    """Was der Pi beim Koppeln gemeldet hat."""

    hostname: str
    addresses: list[str] = Field(description="Seine IPv4-Adressen im Heimnetz.")
    model: str | None = Field(description="Erkanntes Druckermodell, etwa QL-570; null = keins erkannt.")
    printer_found: bool = Field(description="Beim Koppeln hing ein Brother-Drucker am USB.")
    version: str | None = Field(description="Version des Druckdienstes auf dem Pi.")
    not_after: Timestamp | None = Field(description="Ablauf seines Zertifikats; null vor der Kopplung.")


class PiPairing(Model):
    """Eine Kopplung (``POST /api/pi/pairings``, ``GET /api/pi/pairings/{pairing_id}``)."""

    id: Uuid
    state: PiPairingState
    code: str | None = Field(description="Der Code als XXXX-XXXX; nur in der Antwort auf POST, sonst null.")
    command: str | None = Field(
        description="Der fertige Befehl für den Pi; nur in der Antwort auf POST, sonst null."
    )
    expires_at: Timestamp
    printer_id: Uuid | None = Field(description="Der gewählte bzw. gekoppelte Drucker.")
    pi: PiInfo | None = Field(
        description="Was der Pi gemeldet hat; null, solange er sich nicht gemeldet hat."
    )


class PiPairStartInput(Model):
    """Der Pi meldet sich gleich nach dem Laden des Pakets (``POST /api/pi/pair/start``)."""

    code: PairingCode
    hostname: PiHostname
    version: SoftwareVersion | None = None


class PiPairInput(Model):
    """Die Kopplung selbst (``POST /api/pi/pair``), nach der Installation auf dem Pi."""

    code: PairingCode
    hostname: PiHostname
    addresses: list[Annotated[str, Field(min_length=7, max_length=15)]] = Field(
        min_length=1, max_length=8, description="IPv4-Adressen des Pi im Heimnetz, die zum Server zuerst."
    )
    csr: str = Field(
        min_length=1,
        max_length=PI_CSR_MAX,
        description=(
            "Zertifikatsantrag (PEM), Schlüssel P-256 oder RSA ab 2048 Bit. Betreff und Erweiterungen "
            "zählen nicht: Die Adressen bestimmt der Server."
        ),
    )
    token: str = Field(
        min_length=16,
        max_length=LIMITS["printer_token"],
        pattern=PI_TOKEN_PATTERN,
        description="Token des Druckdienstes; Stowly trägt es in die Konfiguration des Druckers ein.",
    )
    model: str | None = Field(default=None, max_length=LIMITS["printer_model"])
    printer_found: bool
    printer_id: Uuid | None = Field(
        default=None,
        description="Der Drucker einer früheren Kopplung (pairing.json); die Wahl in der App geht vor.",
    )
    version: SoftwareVersion | None = None


class PiPairResult(Model):
    """Antwort an den Pi. Enthält keine Geheimnisse."""

    printer_id: Uuid
    name: str = Field(description="Name des Druckers in Stowly.")
    certificate: str = Field(description="Das Zertifikat des Pi (PEM), von der CA von Stowly signiert.")
    ca: str = Field(description="Das Zertifikat der CA (PEM).")
    origins: list[str] = Field(description="Ursprünge der App, die direkt drucken dürfen.")
    urls: list[str] = Field(description="Adressen, unter denen die App den Druckdienst anspricht.")
    not_after: Timestamp
