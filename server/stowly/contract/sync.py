"""Der Sync-Aufruf ``POST /api/sync`` (docs/sync-protokoll.md, „Sync-Aufruf")."""

from enum import StrEnum

from pydantic import Field

from stowly.contract import MAX_COMMANDS_PER_SYNC
from stowly.contract.commands import Command
from stowly.contract.entities import (
    HouseholdSettings,
    LabelTemplate,
    Model,
    Package,
    PackageId,
    Printer,
    PrinterStatus,
    PrintJob,
    Product,
    Timestamp,
    Uuid,
    Zone,
)


class CommandStatus(StrEnum):
    APPLIED = "applied"  # ausgeführt
    DISPLACED = "displaced"  # traf eine entnommene Packung; in der Lösch-Historie aufgehoben
    REJECTED = "rejected"  # nicht ausgeführt, siehe code


class RejectCode(StrEnum):
    INVALID = "invalid"  # Nutzlast verletzt den Vertrag
    NOT_FOUND = "not_found"  # ein Datensatz, auf den sich der Befehl bezieht, existiert nicht
    ID_CONFLICT = "id_conflict"  # die Kennung ist schon vergeben
    LAST_ZONE = "last_zone"  # die letzte Zone lässt sich nicht löschen
    INTERNAL = "internal"  # Fehler im Server; der Befehl wurde verworfen und protokolliert


class IdPoolState(Model):
    have: int = Field(ge=0, description="Wie viele unbenutzte Packungs-IDs das Gerät noch hat.")


class SyncRequest(Model):
    protocol: int = Field(description="Protokollversion des Geräts.")
    dataset_id: Uuid | None = Field(description="dataset_id der letzten Antwort; null beim ersten Sync.")
    cursor: int = Field(ge=0, description="cursor der letzten Antwort; 0 beim ersten Sync.")
    sent_at: Timestamp = Field(description="Geräteuhr im Moment des Absendens.")
    commands: list[Command] = Field(
        max_length=MAX_COMMANDS_PER_SYNC, description="Befehle in der Reihenfolge ihrer Entstehung."
    )
    id_pool: IdPoolState
    app_version: str | None = Field(default=None, max_length=40)


class CommandResult(Model):
    id: Uuid
    status: CommandStatus
    code: RejectCode | None = Field(description="Nur bei rejected.")
    message: str | None = Field(description="Deutscher Klartext zum code, als Rückfall anzeigbar.")
    duplicate: bool = Field(description="Der Befehl war schon bekannt; status ist das Ergebnis von damals.")


class Changes(Model):
    """Alle seit ``cursor`` geänderten Datensätze, jeweils vollständig."""

    products: list[Product]
    zones: list[Zone]
    packages: list[Package]
    printers: list[Printer]
    printer_status: list[PrinterStatus]
    print_jobs: list[PrintJob]
    label_templates: list[LabelTemplate]
    settings: HouseholdSettings | None = Field(description="null = unverändert.")


class IdPoolGrant(Model):
    grant: list[PackageId] = Field(description="Neu für dieses Gerät reservierte Packungs-IDs.")
    target: int = Field(description="Sollgröße des Vorrats.")


class SyncResponse(Model):
    protocol: int
    dataset_id: Uuid = Field(
        description="Kennung des Datenbestands. Weicht sie vom gespeicherten Wert ab, ist reset = true."
    )
    server_time: Timestamp
    results: list[CommandResult] = Field(
        description="Ein Ergebnis je gesendetem Befehl, in derselben Reihenfolge."
    )
    reset: bool = Field(
        description="true = die Antwort ist ein vollständiger Abzug; lokale Kopie vorher leeren."
    )
    changes: Changes
    cursor: int = Field(description="Beim nächsten Sync mitsenden.")
    has_more: bool = Field(
        description="true = sofort erneut abrufen (ohne Befehle), es gibt weitere Änderungen."
    )
    id_pool: IdPoolGrant
    lookup_enabled: bool = Field(
        description="Schlägt der Server unbekannte Barcodes bei Open Food Facts nach? false = abgeschaltet (STOWLY_OFF_ENABLED=0)."
    )
