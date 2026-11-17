"""Druckertreiber. Ein Treiber ist eine Druckersprache auf einem Transport.

``brother_ql`` (Brother QL über USB und TCP) und ``image`` (schreibt PNG); ``zpl`` wäre der
naheliegende dritte. ``build_driver`` baut aus den Angaben zu einem Drucker den passenden
Treiber und scheitert dabei nie: Mit unbrauchbaren Angaben entsteht ein Treiber, der
``config`` meldet, damit der Drucker in der Liste bleibt und die App den Grund zeigen kann.
"""

import logging
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from stowly_print import media as catalog
from stowly_print.drivers.base import Driver, catalog_media
from stowly_print.model import Capabilities, DriverStatus, PrinterError, PrintOutcome

log = logging.getLogger("stowly_print.drivers")

DRIVER_NAMES = ("brother_ql", "image")

__all__ = ["DRIVER_NAMES", "BrokenDriver", "Driver", "PrinterConfig", "build_driver"]


@dataclass(frozen=True)
class PrinterConfig:
    """Die Angaben zu einem Drucker, wie sie in der Konfiguration oder im Datenbestand stehen."""

    name: str
    driver: str
    model: str | None = None
    address: str | None = None
    # Kennung eines Papiers im Katalog (stowly_print.media): die Vorgabe für Vorlagen, die kein
    # Papier nennen. Ohne Angabe 62 mm endlos.
    media: str | None = None
    # Nur Bild-Treiber: Verzeichnis für die PNG-Dateien und der Schalter zum Nachstellen von Störungen.
    directory: Path | None = None
    simulate: str | None = None
    extra: Mapping[str, Any] = field(default_factory=dict)


class BrokenDriver:
    """Steht für einen Drucker, mit dessen Angaben kein Treiber etwas anfangen kann."""

    def __init__(self, reason: str) -> None:
        self.reason = reason
        self.last_error: str | None = None

    def capabilities(self) -> Capabilities:
        # Die Vorgabe (62 mm endlos), damit sich eine Vorschau trotzdem rendern lässt.
        return Capabilities(
            dpi=catalog.DPI,
            media=catalog_media(catalog.BY_ID[catalog.DEFAULT_PAPER_ID]),
            cutter=False,
            colors=["black"],
            status_query=False,
            confirms_print=False,
        )

    def status(self) -> DriverStatus:
        return DriverStatus(
            reachable=False, ready=None, media_detected=None, errors=[PrinterError.CONFIG.value]
        )

    def print(self, image: Any, cut: bool = True) -> PrintOutcome:
        self.last_error = PrinterError.CONFIG.value
        return PrintOutcome.FAILED


def build_driver(config: PrinterConfig) -> Driver:
    """Der Treiber zu einem Drucker. Wirft nie; im Zweifel entsteht ein ``BrokenDriver``."""
    try:
        if config.driver == "image":
            if config.directory is None:
                return _broken(config, "Für den Bild-Treiber fehlt das Verzeichnis.")
            from stowly_print.drivers.image import ImageDriver

            if config.media is not None and catalog.paper(config.media.strip()) is None:
                return _broken(config, f"Die Rolle '{config.media}' kennt der Bild-Treiber nicht.")
            return ImageDriver(config.directory, media=config.media, simulate=config.simulate)
        if config.driver == "brother_ql":
            # Das Modul selbst lädt die Brother-Bibliothek erst, wenn der Drucker benutzt wird.
            from stowly_print.drivers.brother_ql import BrotherQLDriver

            return BrotherQLDriver(
                model=config.model, address=config.address, media=config.media or catalog.DEFAULT_PAPER_ID
            )
        return _broken(config, f"Den Treiber '{config.driver}' gibt es nicht.")
    except Exception as exc:  # ein Drucker mit kaputten Angaben darf den Dienst nicht aufhalten
        log.exception("Treiber für Drucker %s ließ sich nicht anlegen.", config.name)
        return BrokenDriver(str(exc))


def _broken(config: PrinterConfig, reason: str) -> BrokenDriver:
    log.warning("Drucker %s nicht benutzbar: %s", config.name, reason)
    return BrokenDriver(reason)
