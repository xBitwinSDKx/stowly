"""Datensätze, wie sie der Sync an die Geräte liefert (docs/sync-protokoll.md, „Datenmodell").

Alle Felder sind Pflichtfelder: Ein Datensatz kommt immer vollständig, nie als Differenz.
Zeitstempel sind Serverzeit (UTC), siehe ``timeutil``.
"""

from enum import StrEnum
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field

from stowly.contract.ids import BARCODE_PATTERN, PACKAGE_ID_PATTERN, UUID_PATTERN
from stowly.contract.limits import LIMITS
from stowly.contract.timeutil import DATE_PATTERN, TIME_OF_DAY_PATTERN, TIMESTAMP_PATTERN
from stowly_print.model import DriverStatus, HostHealth

# --- Grundtypen -----------------------------------------------------------------------

Uuid = Annotated[str, Field(pattern=UUID_PATTERN)]
PackageId = Annotated[str, Field(pattern=PACKAGE_ID_PATTERN)]
Barcode = Annotated[str, Field(pattern=BARCODE_PATTERN)]
Timestamp = Annotated[str, Field(pattern=TIMESTAMP_PATTERN)]
DateStr = Annotated[str, Field(pattern=DATE_PATTERN)]
TimeOfDay = Annotated[str, Field(pattern=TIME_OF_DAY_PATTERN)]

ZoneName = Annotated[str, Field(min_length=1, max_length=LIMITS["zone_name"])]
IconKey = Annotated[str, Field(min_length=1, max_length=LIMITS["icon"])]
ColorKey = Annotated[str, Field(min_length=1, max_length=LIMITS["color"])]
ProductName = Annotated[str, Field(max_length=LIMITS["product_name"])]
BrandName = Annotated[str, Field(max_length=LIMITS["brand"])]
QuantityText = Annotated[str, Field(max_length=LIMITS["quantity"])]
PrinterName = Annotated[str, Field(min_length=1, max_length=LIMITS["printer_name"])]
DeviceName = Annotated[str, Field(min_length=1, max_length=LIMITS["device_name"])]
WarnDays = Annotated[int, Field(ge=0, le=LIMITS["warn_days"])]
MinStock = Annotated[int, Field(ge=1, le=LIMITS["min_stock"])]
ShoppingText = Annotated[str, Field(max_length=LIMITS["shopping_text"])]
ShoppingQuantity = Annotated[int, Field(ge=1, le=LIMITS["shopping_quantity"])]


class Model(BaseModel):
    """Basis aller Vertragsmodelle: unbekannte Schlüssel sind ein Fehler."""

    model_config = ConfigDict(extra="forbid")


class LookupState(StrEnum):
    """Stand des Nachschlagens bei Open Food Facts."""

    NONE = "none"  # nichts nachzuschlagen: kein Barcode oder ladeninterner Code
    PENDING = "pending"  # der Server schlägt noch nach
    FOUND = "found"  # Daten übernommen
    NOT_FOUND = "not_found"  # Open Food Facts kennt den Barcode nicht


class RemovalReason(StrEnum):
    """Warum eine Packung entnommen wurde (Grundlage der Statistik in Stufe 2)."""

    CONSUMED = "consumed"  # verbraucht
    DISCARDED = "discarded"  # entsorgt
    MISTAKE = "mistake"  # falsch erfasst, zählt in keiner Statistik


class ZoneMode(StrEnum):
    PRIMARY = "primary"  # Primärzone: ein Zonenwechsel gilt für genau einen Einlager-Vorgang
    EQUAL = "equal"  # gleichwertig: ein Zonenwechsel bleibt bestehen


class PackageField(StrEnum):
    """Änderbare Felder einer Packung."""

    BEST_BEFORE = "best_before"
    ZONE_ID = "zone_id"
    PRODUCT_ID = "product_id"


class PrinterConnection(StrEnum):
    SERVER = "server"  # der Stowly-Server steuert den Drucker (Heimnetz oder USB am Server)
    DIRECT = "direct"  # das Gerät spricht selbst mit einem Druckdienst (Pi im Keller)


class PrinterDriver(StrEnum):
    BROTHER_QL = "brother_ql"
    IMAGE = "image"  # Bild-Treiber: schreibt das Etikett als PNG


class PrintJobKind(StrEnum):
    PACKAGE = "package"
    ZONE = "zone"


class ShoppingOrigin(StrEnum):
    """Wer einen Eintrag der Einkaufsliste angelegt hat (docs/sync-protokoll.md, 3.6)."""

    MANUAL = "manual"  # ein Gerät: ein eigener Eintrag
    MIN_STOCK = "min_stock"  # der Server: Der Bestand liegt unter dem Mindestbestand (7.6)


class PrintJobState(StrEnum):
    """Zustand eines Etiketts aus Sicht des Haushalts.

    ``pending`` und ``cancelled`` kennt nur Stowly; die übrigen Werte sind die
    Zustände des Druckdienstes (docs/etiketten.md).
    """

    PENDING = "pending"  # noch bei keinem Druckdienst angekommen („ausstehend")
    QUEUED = "queued"
    PRINTING = "printing"
    PRINTED = "printed"
    SENT = "sent"
    FAILED = "failed"
    UNKNOWN = "unknown"  # Ausgang offen: die App fragt nach
    CANCELLED = "cancelled"  # vom Anwender verworfen


# --- Stammdaten -----------------------------------------------------------------------


class Zone(Model):
    id: Uuid
    name: ZoneName
    icon: IconKey = Field(
        description="Schlüssel aus der Symbolliste der Web-App; Unbekanntes wird als 'box' gezeigt."
    )
    color: ColorKey | None = Field(description="Schlüssel aus der Farbpalette der Web-App oder null.")
    sort: int = Field(description="Reihenfolge, aufsteigend; bei Gleichstand nach Name.")
    printer_id: Uuid | None = Field(description="Drucker für Etiketten dieser Zone; null = Standarddrucker.")
    created_at: Timestamp
    updated_at: Timestamp
    deleted_at: Timestamp | None = Field(description="Gesetzt = Zone gelöscht (Grabstein).")
    moved_to: Uuid | None = Field(description="Bei gelöschten Zonen: wohin ihre Packungen verschoben wurden.")


class Product(Model):
    id: Uuid
    name: ProductName = Field(
        description="Leer = noch unbekannt (Platzhalter); die App zeigt dann den Barcode."
    )
    brand: BrandName
    quantity: QuantityText = Field(description="Packungsgröße als Text, z. B. '500 g'.")
    image: str | None = Field(description="Bild-ID für GET /api/images/{id} oder null.")
    warn_days: WarnDays | None = Field(
        description="Vorlaufzeit der MHD-Warnung in Tagen; null = Haushaltswert."
    )
    min_stock: MinStock | None = Field(
        description=(
            "Mindestbestand in Packungen; null = keiner. Zum Bestand zählt jede nicht entnommene "
            "Packung des Produkts, auch eine abgelaufene."
        )
    )
    lookup: LookupState
    barcodes: list[Barcode] = Field(description="Alle Barcodes dieses Produkts, aufsteigend sortiert.")
    created_at: Timestamp
    updated_at: Timestamp
    deleted_at: Timestamp | None = Field(description="Gesetzt = in einem anderen Produkt aufgegangen.")
    merged_into: Uuid | None = Field(description="Bei zusammengeführten Produkten: das Zielprodukt.")


class DisplacedChange(Model):
    field: PackageField
    value: str | None


class DisplacedEdit(Model):
    """Eine Bearbeitung, die auf eine bereits entnommene Packung traf (Löschen gewinnt)."""

    at: Timestamp = Field(description="Wann die Bearbeitung gemacht wurde.")
    changes: list[DisplacedChange] = Field(description="Die nicht angewendeten Feldwerte.")


class Package(Model):
    """Eine einzelne Packung. Entnommene Packungen bleiben als Datensatz erhalten."""

    id: PackageId
    product_id: Uuid
    zone_id: Uuid
    best_before: DateStr | None = Field(description="MHD als Kalenderdatum; null = keines.")
    created_at: Timestamp = Field(description="Zeitpunkt des Einlagerns.")
    updated_at: Timestamp
    removed_at: Timestamp | None = Field(description="Gesetzt = entnommen (Lösch-Historie).")
    removal_reason: RemovalReason | None
    displaced: DisplacedEdit | None = Field(
        description="Verdrängte Bearbeitung, nur bei entnommenen Packungen."
    )


class HouseholdSettings(Model):
    """Einstellungen des Haushalts; gelten für alle Geräte."""

    zone_mode: ZoneMode
    primary_zone_id: Uuid | None = Field(description="Primärzone; null = erste Zone der Reihenfolge.")
    warn_days: WarnDays = Field(description="Vorlaufzeit der MHD-Warnung in Tagen.")
    trash_retention_days: int = Field(
        ge=1, le=LIMITS["retention_days"], description="Aufbewahrungsdauer der Lösch-Historie in Tagen."
    )
    default_printer_id: Uuid | None = Field(description="Drucker für Zonen ohne eigenen Drucker.")
    notify_time: TimeOfDay = Field(
        description='Uhrzeit der täglichen Push-Nachricht, "HH:MM" in der Zeitzone des Servers (STOWLY_TIMEZONE).'
    )
    updated_at: Timestamp


# --- Einkaufsliste --------------------------------------------------------------------


class ShoppingItem(Model):
    """Ein Eintrag der Einkaufsliste: ein Produkt oder freier Text. Gelöschte bleiben als Grabstein."""

    id: Uuid
    product_id: Uuid | None = Field(description="Das Produkt; null = freier Text.")
    text: ShoppingText = Field(description="Freier Text; leer bei Einträgen mit Produkt.")
    quantity: ShoppingQuantity | None = Field(
        description=(
            "Menge in Packungen; null = ohne Angabe. Bei origin = min_stock: wie viele Packungen "
            "zum Mindestbestand fehlen, vom Server nachgeführt."
        )
    )
    origin: ShoppingOrigin
    done_at: Timestamp | None = Field(description="Gesetzt = erledigt (abgehakt oder eingekauft).")
    deleted_at: Timestamp | None = Field(description="Gesetzt = gelöscht; endgültig.")
    created_at: Timestamp
    updated_at: Timestamp


# --- Druck ----------------------------------------------------------------------------


class ServerPrinterConfig(Model):
    """Drucker, den der Server ansteuert."""

    driver: PrinterDriver
    model: str | None = Field(
        max_length=LIMITS["printer_model"],
        description="Modell für den Treiber, z. B. 'QL-820NWB'; null beim Bild-Treiber.",
    )
    address: str | None = Field(
        max_length=LIMITS["printer_address"],
        description="'tcp://192.168.1.60:9100' oder 'usb://04f9:209b'; null beim Bild-Treiber.",
    )
    media: str = Field(
        max_length=LIMITS["printer_media"],
        description="Rollenkennung des Treibers, z. B. '62' für die 62-mm-Endlosrolle.",
    )


class DirectPrinterConfig(Model):
    """Druckdienst, den das Gerät selbst anspricht (Raspberry Pi im Keller)."""

    urls: list[Annotated[str, Field(max_length=LIMITS["printer_url"])]] = Field(
        min_length=1,
        max_length=LIMITS["printer_urls"],
        description="Basis-Adressen in der Reihenfolge der Versuche, z. B. https://10.71.83.1:8443, dann http://10.71.83.1:8080.",
    )
    token: str = Field(
        min_length=1, max_length=LIMITS["printer_token"], description="Bearer-Token des Druckdienstes."
    )
    printer: str | None = Field(
        max_length=LIMITS["printer_queue"],
        description="Name des Druckers im Druckdienst; null = dessen Standarddrucker.",
    )


class Printer(Model):
    id: Uuid
    name: PrinterName
    connection: PrinterConnection
    server: ServerPrinterConfig | None = Field(description="Gesetzt genau dann, wenn connection = server.")
    direct: DirectPrinterConfig | None = Field(description="Gesetzt genau dann, wenn connection = direct.")
    created_at: Timestamp
    updated_at: Timestamp
    deleted_at: Timestamp | None


class PrinterStatus(Model):
    """Zuletzt gesehener Zustand eines Druckers („zuletzt gesehen", kein Herzschlag)."""

    printer_id: Uuid
    observed_at: Timestamp = Field(
        description="Wann ein Gerät oder der Server den Druckdienst zuletzt erreicht hat."
    )
    boot_id: str | None
    status: DriverStatus | None = Field(
        description="Zustand des Druckers; null, wenn der Dienst ihn nicht melden konnte."
    )
    host: HostHealth | None = Field(description="Zustand des Rechners (Pi); null bei Druckern am Server.")


class PrintJob(Model):
    """Ein Etikett, das gedruckt werden soll oder wurde. Die Kennung ist zugleich die Auftragskennung beim Druckdienst."""

    id: Uuid
    kind: PrintJobKind
    package_id: PackageId | None = Field(description="Gesetzt bei kind = package.")
    zone_id: Uuid | None = Field(description="Gesetzt bei kind = zone.")
    printer_id: Uuid | None = Field(
        description="Zieldrucker; null = beim Drucken aus Zone und Standarddrucker bestimmen."
    )
    state: PrintJobState
    error: str | None = Field(description="Fehlercode des Druckdienstes bei failed.")
    boot_id: str | None = Field(description="boot_id des Druckdienstes, der den Auftrag angenommen hat.")
    device_id: Uuid | None = Field(description="Gerät, das den Auftrag angelegt hat.")
    created_at: Timestamp
    updated_at: Timestamp


class LabelTemplate(Model):
    """Etikett-Vorlage. Die App reicht ``body`` unverändert mit jedem Druckauftrag weiter."""

    key: PrintJobKind
    hash: str
    body: dict[str, Any]
    updated_at: Timestamp
