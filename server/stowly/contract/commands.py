"""Katalog der Befehle (docs/sync-protokoll.md, „Befehle").

Jede Änderung, die ein Gerät macht, ist genau ein Befehl. Der Server führt jeden
Befehl höchstens einmal aus (Schlüssel ist ``id``). Was ein Befehl bewirkt und wie
Konflikte ausgehen, steht im Protokoll-Dokument; hier steht nur die Nutzlast.

``changes``-Objekte ändern nur die Schlüssel, die im JSON vorhanden sind
(``model_fields_set``). ``null`` ist dort ein Wert, kein „nicht angegeben".
"""

from typing import Annotated, Literal

from pydantic import Field, model_validator

from stowly.contract.entities import (
    Barcode,
    BrandName,
    ColorKey,
    DateStr,
    DirectPrinterConfig,
    IconKey,
    MinStock,
    Model,
    PackageId,
    PrinterConnection,
    PrinterName,
    PrintJobKind,
    PrintJobState,
    ProductName,
    QuantityText,
    RemovalReason,
    ServerPrinterConfig,
    ShoppingQuantity,
    ShoppingText,
    TimeOfDay,
    Timestamp,
    Uuid,
    WarnDays,
    ZoneMode,
    ZoneName,
)
from stowly.contract.limits import LIMITS
from stowly_print.model import DriverStatus, HostHealth


class CommandBase(Model):
    id: Uuid = Field(
        description="Kennung des Befehls (UUID v4, vom Gerät erzeugt). Der Server führt sie höchstens einmal aus."
    )
    at: Timestamp = Field(description="Wann der Anwender die Änderung gemacht hat (Geräteuhr, UTC).")


# --- Produkte -------------------------------------------------------------------------


class CmdProductCreate(CommandBase):
    type: Literal["product.create"]
    product_id: Uuid
    name: ProductName = ""
    brand: BrandName = ""
    quantity: QuantityText = ""
    warn_days: WarnDays | None = None
    barcodes: list[Barcode] = Field(default_factory=list, max_length=LIMITS["barcodes"])
    min_stock: MinStock | None = Field(default=None, description="Seit Protokoll 2; fehlt bei älteren Apps.")


class ProductChanges(Model):
    name: ProductName = Field(default=None)
    brand: BrandName = Field(default=None)
    quantity: QuantityText = Field(default=None)
    warn_days: WarnDays | None = None
    min_stock: MinStock | None = Field(
        default=None, description="null = kein Mindestbestand. Seit Protokoll 2."
    )


class CmdProductUpdate(CommandBase):
    type: Literal["product.update"]
    product_id: Uuid
    changes: ProductChanges


class CmdProductAddBarcode(CommandBase):
    type: Literal["product.add_barcode"]
    product_id: Uuid
    barcode: Barcode


class CmdProductRemoveBarcode(CommandBase):
    type: Literal["product.remove_barcode"]
    product_id: Uuid
    barcode: Barcode


class CmdProductMerge(CommandBase):
    type: Literal["product.merge"]
    source_id: Uuid = Field(description="Dieses Produkt geht im Ziel auf.")
    target_id: Uuid


# --- Packungen ------------------------------------------------------------------------


class CmdPackageCreate(CommandBase):
    type: Literal["package.create"]
    package_id: PackageId
    product_id: Uuid
    zone_id: Uuid
    best_before: DateStr | None = None


class PackageChanges(Model):
    best_before: DateStr | None = None
    zone_id: Uuid = Field(default=None)
    product_id: Uuid = Field(default=None)


class CmdPackageUpdate(CommandBase):
    type: Literal["package.update"]
    package_id: PackageId
    changes: PackageChanges


class CmdPackageRemove(CommandBase):
    type: Literal["package.remove"]
    package_id: PackageId
    reason: RemovalReason


class CmdPackageRestore(CommandBase):
    type: Literal["package.restore"]
    package_id: PackageId
    apply_displaced: bool = Field(
        default=False, description="Die verdrängte Bearbeitung beim Wiederherstellen übernehmen."
    )


# --- Zonen und Einstellungen ----------------------------------------------------------


class CmdZoneCreate(CommandBase):
    type: Literal["zone.create"]
    zone_id: Uuid
    name: ZoneName
    icon: IconKey = "box"
    color: ColorKey | None = None
    sort: int = 0
    printer_id: Uuid | None = None


class ZoneChanges(Model):
    name: ZoneName = Field(default=None)
    icon: IconKey = Field(default=None)
    color: ColorKey | None = None
    sort: int = Field(default=None)
    printer_id: Uuid | None = None


class CmdZoneUpdate(CommandBase):
    type: Literal["zone.update"]
    zone_id: Uuid
    changes: ZoneChanges


class CmdZoneDelete(CommandBase):
    type: Literal["zone.delete"]
    zone_id: Uuid
    move_to: Uuid = Field(description="Zone, in die alle Packungen der gelöschten Zone wandern.")


class SettingsChanges(Model):
    zone_mode: ZoneMode = Field(default=None)
    primary_zone_id: Uuid | None = None
    warn_days: WarnDays = Field(default=None)
    trash_retention_days: int = Field(default=None, ge=1, le=LIMITS["retention_days"])
    default_printer_id: Uuid | None = None
    notify_time: TimeOfDay = Field(default=None, description="Seit Protokoll 2.")


class CmdSettingsUpdate(CommandBase):
    type: Literal["settings.update"]
    changes: SettingsChanges


# --- Einkaufsliste --------------------------------------------------------------------


class CmdShoppingItemCreate(CommandBase):
    """Legt einen eigenen Eintrag an (``origin = manual``): genau eines von Produkt und Text."""

    type: Literal["shopping_item.create"]
    item_id: Uuid
    product_id: Uuid | None = None
    text: ShoppingText = ""
    quantity: ShoppingQuantity | None = None

    @model_validator(mode="after")
    def _product_or_text(self) -> "CmdShoppingItemCreate":
        if self.product_id is None and self.text == "":
            raise ValueError("Ein Eintrag braucht ein Produkt oder einen Text.")
        if self.product_id is not None and self.text != "":
            raise ValueError("Ein Eintrag hat ein Produkt oder einen Text, nicht beides.")
        return self


class ShoppingItemChanges(Model):
    """``text`` nur bei Einträgen ohne Produkt, ``quantity`` nur bei eigenen Einträgen (docs/sync-protokoll.md, 6.6)."""

    text: Annotated[str, Field(min_length=1, max_length=LIMITS["shopping_text"])] = Field(default=None)
    quantity: ShoppingQuantity | None = None
    done: bool = Field(default=None, description="true = abhaken (erledigt), false = wieder öffnen.")


class CmdShoppingItemUpdate(CommandBase):
    type: Literal["shopping_item.update"]
    item_id: Uuid
    changes: ShoppingItemChanges


class CmdShoppingItemDelete(CommandBase):
    """Löscht einen Eintrag endgültig, auch einen automatischen."""

    type: Literal["shopping_item.delete"]
    item_id: Uuid


# --- Drucker und Etiketten ------------------------------------------------------------


def _check_printer_config(
    connection: PrinterConnection, server: ServerPrinterConfig | None, direct: DirectPrinterConfig | None
) -> None:
    if connection == PrinterConnection.SERVER and (server is None or direct is not None):
        raise ValueError("connection = server verlangt genau 'server'.")
    if connection == PrinterConnection.DIRECT and (direct is None or server is not None):
        raise ValueError("connection = direct verlangt genau 'direct'.")


class CmdPrinterCreate(CommandBase):
    type: Literal["printer.create"]
    printer_id: Uuid
    name: PrinterName
    connection: PrinterConnection
    server: ServerPrinterConfig | None = None
    direct: DirectPrinterConfig | None = None

    @model_validator(mode="after")
    def _config_matches_connection(self) -> "CmdPrinterCreate":
        _check_printer_config(self.connection, self.server, self.direct)
        return self


class PrinterChanges(Model):
    """Die Art der Verbindung lässt sich nicht ändern; passend zur Verbindung ist nur eines der Objekte erlaubt."""

    name: PrinterName = Field(default=None)
    server: ServerPrinterConfig = Field(default=None)
    direct: DirectPrinterConfig = Field(default=None)


class CmdPrinterUpdate(CommandBase):
    type: Literal["printer.update"]
    printer_id: Uuid
    changes: PrinterChanges


class CmdPrinterDelete(CommandBase):
    type: Literal["printer.delete"]
    printer_id: Uuid


class CmdPrinterReport(CommandBase):
    """Ein Gerät hat einen Druckdienst erreicht und bringt dessen Zustand mit. ``at`` ist der Zeitpunkt der Beobachtung."""

    type: Literal["printer.report"]
    printer_id: Uuid
    boot_id: str | None = Field(default=None, max_length=80)
    status: DriverStatus | None = None
    host: HostHealth | None = None


class CmdPrintRequest(CommandBase):
    """Legt ein Etikett im Zustand ``pending`` an."""

    type: Literal["print.request"]
    job_id: Uuid
    kind: PrintJobKind
    package_id: PackageId | None = None
    zone_id: Uuid | None = None
    printer_id: Uuid | None = None

    @model_validator(mode="after")
    def _subject_matches_kind(self) -> "CmdPrintRequest":
        if self.kind == PrintJobKind.PACKAGE and (self.package_id is None or self.zone_id is not None):
            raise ValueError("kind = package verlangt genau 'package_id'.")
        if self.kind == PrintJobKind.ZONE and (self.zone_id is None or self.package_id is not None):
            raise ValueError("kind = zone verlangt genau 'zone_id'.")
        return self


class CmdPrintReport(CommandBase):
    """Meldet den Fortschritt eines Etiketts, auch Abbruch und die Antwort des Anwenders bei ``unknown``."""

    type: Literal["print.report"]
    job_id: Uuid
    state: PrintJobState
    printer_id: Uuid | None = None
    boot_id: str | None = Field(default=None, max_length=80)
    error: str | None = Field(default=None, max_length=200)


Command = Annotated[
    CmdProductCreate
    | CmdProductUpdate
    | CmdProductAddBarcode
    | CmdProductRemoveBarcode
    | CmdProductMerge
    | CmdPackageCreate
    | CmdPackageUpdate
    | CmdPackageRemove
    | CmdPackageRestore
    | CmdZoneCreate
    | CmdZoneUpdate
    | CmdZoneDelete
    | CmdSettingsUpdate
    | CmdPrinterCreate
    | CmdPrinterUpdate
    | CmdPrinterDelete
    | CmdPrinterReport
    | CmdPrintRequest
    | CmdPrintReport
    | CmdShoppingItemCreate
    | CmdShoppingItemUpdate
    | CmdShoppingItemDelete,
    Field(discriminator="type"),
]

COMMAND_TYPES: tuple[str, ...] = (
    "product.create",
    "product.update",
    "product.add_barcode",
    "product.remove_barcode",
    "product.merge",
    "package.create",
    "package.update",
    "package.remove",
    "package.restore",
    "zone.create",
    "zone.update",
    "zone.delete",
    "settings.update",
    "printer.create",
    "printer.update",
    "printer.delete",
    "printer.report",
    "print.request",
    "print.report",
    "shopping_item.create",
    "shopping_item.update",
    "shopping_item.delete",
)
