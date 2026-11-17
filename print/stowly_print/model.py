"""Datentypen des Druckdienstes (Vertrag, siehe docs/etiketten.md).

Diese Dataclasses sind die Quelle für das Druckauftrags-Protokoll. Der Server
leitet daraus die JSON-Schemata und die TypeScript-Typen der Web-App ab
(``python -m stowly.contract.export``). Wer hier ein Feld ändert, ändert den
Vertrag.

Nur Standardbibliothek: kein pydantic, kein FastAPI.
"""

import base64
import binascii
import dataclasses
import hashlib
import json
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

PROTOCOL_VERSION = 1
APP_NAME = "stowly-print"

# Formate der Vorlage, die dieser Druckdienst rendert (docs/etiketten.md, 3.4): 1 = die 62-mm-Rolle
# ohne Drehung, 2 = jedes Papier des Katalogs, mit ``media.id`` und ``rotate``. Ein Druckdienst vor
# 0.5.0 meldet ``template_schemas`` nicht und kann nur Format 1.
TEMPLATE_SCHEMAS = (1, 2)

MAX_COPIES = 20
MAX_DATA_FIELDS = 32
MAX_DATA_VALUE_LENGTH = 500
MAX_PNG_BYTES = 512 * 1024

# Mehr wartende Aufträge nimmt ein Dienst nicht an (503 ``queue_full``).
MAX_QUEUED_JOBS = 100
# So viele Aufträge merkt sich ein Dienst mit Speicher im RAM mindestens je Lauf, auch erledigte
# und verworfene: Eine verspätete Wiederholung darf nicht doch noch drucken.
MIN_REMEMBERED_JOBS = 10_000


class ServiceError(StrEnum):
    """Fehlercodes der HTTP-Antworten des Druckdienstes (docs/etiketten.md, 5.3)."""

    INVALID_REQUEST = "invalid_request"  # 400: Nutzlast verletzt den Vertrag
    UNAUTHORIZED = "unauthorized"  # 401: Token fehlt oder ist falsch
    NOT_FOUND = "not_found"  # 404: Auftrag unbekannt (am Server auch: kein Etikett mit dieser Kennung)
    UNKNOWN_PRINTER = "unknown_printer"  # 404: diesen Drucker hat der Dienst nicht
    JOB_CONFLICT = "job_conflict"  # 409: dieselbe Kennung mit anderem Inhalt
    BOOT_MISMATCH = "boot_mismatch"  # 409: expect_boot_id passt nicht, details.boot_id nennt die aktuelle
    NOT_CANCELLABLE = "not_cancellable"  # 409: der Auftrag wartet nicht mehr
    NOT_PENDING = "not_pending"  # 409, nur am Server: das Etikett ist verworfen oder erledigt
    RENDER_FAILED = "render_failed"  # 422: Vorlage oder Daten lassen sich nicht rendern
    QUEUE_FULL = "queue_full"  # 503: zu viele wartende Aufträge


class PrinterError(StrEnum):
    """Codes in ``DriverStatus.errors`` und als Fehler eines gescheiterten Auftrags (docs/etiketten.md, 5.5)."""

    NO_MEDIA = "no_media"  # Etiketten leer
    MEDIA_MISMATCH = "media_mismatch"  # andere Rolle eingelegt, als das Etikett braucht (oder das Modell kann das Papier nicht)
    COVER_OPEN = "cover_open"
    CUTTER_JAM = "cutter_jam"
    OVERHEATED = "overheated"
    BUSY = "busy"
    OFFLINE = "offline"  # Gerät nicht gefunden oder nicht verbunden
    CONFIG = "config"  # Modell, Adresse oder Rolle passen nicht zum Treiber
    UNKNOWN = "unknown"


# Fehler eines Auftrags, die nicht vom Drucker stammen (``Job.error.code``).
JOB_ERROR_CANCELLED = "cancelled"  # verworfen, solange er wartete (Zustand failed)
JOB_ERROR_INTERRUPTED = "interrupted"  # mitten im Druck unterbrochen (Zustand unknown)


class JobState(StrEnum):
    """Zustand eines Auftrags im Druckdienst."""

    QUEUED = "queued"  # angenommen, wartet
    PRINTING = "printing"  # wird gerade an den Drucker übertragen
    PRINTED = "printed"  # Endzustand: das Gerät hat den Druck bestätigt
    SENT = "sent"  # Endzustand: übertragen, der Transport kann nicht bestätigen
    FAILED = "failed"  # Endzustand: sicher nicht gedruckt
    UNKNOWN = "unknown"  # Endzustand: mitten im Druck unterbrochen, nie automatisch wiederholen


FINAL_STATES = frozenset({JobState.PRINTED, JobState.SENT, JobState.FAILED, JobState.UNKNOWN})


class PrintOutcome(StrEnum):
    """Ergebnis von ``Driver.print``."""

    PRINTED = "printed"  # Gerät hat bestätigt (confirms_print)
    SENT = "sent"  # Daten geschrieben, keine Rückmeldung möglich
    FAILED = "failed"  # sicher nicht gedruckt


@dataclass(frozen=True)
class Media:
    """Das eingerichtete Material (``media`` in der Konfiguration): die Vorgabe für Vorlagen, die kein
    Papier nennen. Längenangaben in Millimetern. Welche Rolle wirklich eingelegt ist, meldet
    ``PrinterInfo.loaded``."""

    width_mm: float
    length_mm: float | None  # None = Endlosrolle
    printable_px: int  # druckbare Breite in Pixeln (quer zur Laufrichtung)
    # Seit 0.5.0 (ein älterer Druckdienst lässt sie weg):
    id: str | None = None  # Kennung im Papier-Katalog (stowly_print.media), etwa "62" oder "62x29"
    kind: str | None = None  # "endless" oder "die_cut"
    printable_length_px: int | None = None  # druckbare Länge gestanzter Etiketten in Pixeln


@dataclass(frozen=True)
class Paper:
    """Ein Papier, wie es eine Vorlage nennt (``media`` im Format 2) und wie ein Drucker die eingelegte
    Rolle meldet (``PrinterInfo.loaded``). Längenangaben in Millimetern."""

    id: str | None  # Kennung im Papier-Katalog; None = die gemeldete Rolle steht nicht im Katalog
    kind: str  # "endless" oder "die_cut"
    width_mm: float  # Breite der Rolle, quer zur Laufrichtung
    length_mm: float | None  # gestanzt: Länge des Etiketts; endlos: Länge der Vorlage bzw. None (gemeldet)


@dataclass(frozen=True)
class Capabilities:
    """Was ein Treiber kann. Ändert sich nicht, solange die Konfiguration gleich bleibt."""

    dpi: int
    media: Media
    cutter: bool
    colors: list[str]  # z. B. ["black"] oder ["black", "red"]
    status_query: bool  # status() fragt das Gerät wirklich ab
    confirms_print: bool  # print() kann "printed" liefern, sonst höchstens "sent"


@dataclass(frozen=True)
class DriverStatus:
    """Momentaufnahme eines Druckers. ``None`` heißt: lässt sich nicht feststellen."""

    reachable: bool  # USB-Gerät gefunden bzw. TCP-Verbindung möglich
    ready: bool | None
    media_detected: bool | None
    errors: list[str]  # Codes, siehe docs/etiketten.md; leer = kein Fehler


@dataclass(frozen=True)
class PrinterInfo:
    """Ein Drucker, wie ihn ``GET /v1/printers`` und ``GET /v1/health`` melden."""

    name: str  # Name innerhalb dieses Druckdienstes
    driver: str  # "brother_ql", "image", später "zpl"
    model: str | None
    capabilities: Capabilities
    status: DriverStatus
    # Seit 0.5.0: die eingelegte Rolle, wie der Drucker sie meldet; None = unbekannt (Treiber ohne
    # Abfrage, Drucker aus, älterer Druckdienst).
    loaded: Paper | None = None


@dataclass(frozen=True)
class HostHealth:
    """Zustand des Rechners, auf dem der Druckdienst läuft. ``None`` = unbekannt.

    ``undervoltage`` ist auf der Pi-Zero-Reihe immer ``None``: Sie hat keinen Detektor.
    Für die SD-Karte gibt es nur Symptome (docs/recherche.md, Abschnitt 6).
    """

    uptime_s: float | None = None
    temperature_c: float | None = None
    throttled: bool | None = None
    undervoltage: bool | None = None
    storage_errors: int | None = None  # ext4 errors_count plus I/O-Fehler im Kernel-Log
    storage_read_only: bool | None = None  # unerwartet nur lesbar eingehängt
    overlay_used_pct: float | None = None  # belegter Anteil des RAM-Overlays
    memory_available_mb: float | None = None


@dataclass(frozen=True)
class Health:
    """Antwort von ``GET /v1/health``."""

    app: str  # immer "stowly-print": daran erkennt die App den Dienst
    version: str
    protocol: int
    boot_id: str  # neu bei jedem Start, wenn der Auftragsspeicher im RAM liegt
    uptime_s: float  # monotone Zeit seit dem Start des Dienstes
    proof: str | None  # HMAC-SHA256(token, nonce) als Hex, wenn ?nonce= übergeben wurde
    host: HostHealth | None
    printers: list[PrinterInfo]
    # Seit 0.5.0: die Formate der Vorlage, die der Dienst rendert (TEMPLATE_SCHEMAS). Fehlt die
    # Angabe (älterer Druckdienst), kann er nur Format 1.
    template_schemas: list[int] = dataclasses.field(default_factory=lambda: [1])


@dataclass(frozen=True)
class JobError:
    code: str
    message: str


@dataclass(frozen=True)
class Job:
    """Antwort auf das Einreichen und Abfragen eines Auftrags."""

    id: str
    state: JobState
    printer: str
    boot_id: str
    error: JobError | None
    position: int | None  # Platz in der Warteschlange (0 = als Nächstes), sonst None


@dataclass(frozen=True)
class JobRequest:
    """Inhalt eines Druckauftrags.

    Entweder ``template`` und ``data`` (Normalfall: gerendert wird beim Drucker)
    oder ``png`` (Notausgang: fertiges 1-Bit-PNG in exakt passender Größe, Base64).
    ``expect_boot_id`` gehört nicht zum Inhalt und beeinflusst ``content_hash`` nicht.
    """

    template: dict[str, Any] | None = None
    data: dict[str, str] | None = None
    png: str | None = None
    printer: str | None = None  # None = Standarddrucker des Dienstes
    copies: int = 1
    cut: bool = True
    expect_boot_id: str | None = None

    @classmethod
    def from_dict(cls, raw: Any) -> "JobRequest":
        """Prüft eine empfangene Nutzlast. Unbekannte Schlüssel werden ignoriert.

        Wirft ``ValueError`` mit einer deutschen Meldung, wenn die Nutzlast ungültig ist.
        """
        if not isinstance(raw, dict):
            raise ValueError("Der Auftrag muss ein JSON-Objekt sein.")

        template = raw.get("template")
        data = raw.get("data")
        png = raw.get("png")

        if png is not None:
            if template is not None or data is not None:
                raise ValueError("Entweder 'png' oder 'template' mit 'data', nicht beides.")
            if not isinstance(png, str) or not png:
                raise ValueError("'png' muss eine Base64-Zeichenkette sein.")
            try:
                decoded = base64.b64decode(png, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise ValueError("'png' ist kein gültiges Base64.") from exc
            if len(decoded) > MAX_PNG_BYTES:
                raise ValueError("'png' ist zu groß.")
            if not decoded.startswith(b"\x89PNG\r\n\x1a\n"):
                raise ValueError("'png' enthält kein PNG.")
        else:
            if not isinstance(template, dict):
                raise ValueError("'template' fehlt oder ist kein Objekt.")
            if not isinstance(data, dict):
                raise ValueError("'data' fehlt oder ist kein Objekt.")
            if len(data) > MAX_DATA_FIELDS:
                raise ValueError("'data' hat zu viele Felder.")
            for key, value in data.items():
                if not isinstance(key, str) or not isinstance(value, str):
                    raise ValueError("'data' darf nur Zeichenketten enthalten.")
                if len(value) > MAX_DATA_VALUE_LENGTH:
                    raise ValueError(f"'data.{key}' ist zu lang.")

        printer = raw.get("printer")
        if printer is not None and (not isinstance(printer, str) or not printer):
            raise ValueError("'printer' muss ein Name oder null sein.")

        copies = raw.get("copies", 1)
        if isinstance(copies, bool) or not isinstance(copies, int) or not 1 <= copies <= MAX_COPIES:
            raise ValueError(f"'copies' muss zwischen 1 und {MAX_COPIES} liegen.")

        cut = raw.get("cut", True)
        if not isinstance(cut, bool):
            raise ValueError("'cut' muss true oder false sein.")

        expect_boot_id = raw.get("expect_boot_id")
        if expect_boot_id is not None and not isinstance(expect_boot_id, str):
            raise ValueError("'expect_boot_id' muss eine Zeichenkette oder null sein.")

        return cls(
            template=template,
            data=data,
            png=png,
            printer=printer,
            copies=copies,
            cut=cut,
            expect_boot_id=expect_boot_id,
        )

    def content_hash(self) -> str:
        """Kennzeichnet den Inhalt: gleiche Kennung + anderer Hash = 409 ``job_conflict``."""
        content = {
            "template": self.template,
            "data": self.data,
            "png": self.png,
            "printer": self.printer,
            "copies": self.copies,
            "cut": self.cut,
        }
        return hashlib.sha256(canonical_json(content).encode("utf-8")).hexdigest()


def canonical_json(value: Any) -> str:
    """JSON mit sortierten Schlüsseln und ohne Leerraum: Grundlage aller Hashes."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def to_dict(value: Any) -> Any:
    """Wandelt Dataclasses (auch verschachtelt) in JSON-taugliche Python-Werte um."""
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {f.name: to_dict(getattr(value, f.name)) for f in dataclasses.fields(value)}
    if isinstance(value, StrEnum):
        return value.value
    if isinstance(value, dict):
        return {str(k): to_dict(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [to_dict(v) for v in value]
    return value
