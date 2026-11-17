"""Bild-Treiber: schreibt jedes Etikett als PNG in ein Verzeichnis.

Solange kein Drucker da ist, lässt sich damit der ganze Weg ansehen und testen: Der Auftrag
``<Auftrag>`` wird zur Datei ``<Auftrag>.png``, weitere Exemplare zu ``<Auftrag>.2.png`` und so fort.

Papier: Der Treiber hat keine Rolle und kann jedes Papier des Katalogs. Nennt die Vorlage eines,
schreibt er das PNG in dessen Größe (``for_paper``), sonst in der des Papiers aus der Konfiguration
(``media``, Vorgabe 62 mm endlos). Das Bild liegt wie für einen Drucker in Druckrichtung, quer ×
längs: Ein gedrehtes Etikett (Format 2, ``rotate: 90``) steht im PNG auf der Seite. Eine eingelegte
Rolle meldet er nicht (``loaded`` ist ``None``) und deshalb auch nie ``media_mismatch``.

Störungen nachstellen: Der Schalter ``simulate`` (beim Anlegen des Treibers oder als Inhalt
der Datei ``simulate.txt`` im Verzeichnis) lässt den Treiber

* ``fail`` oder ``fail:<code>``: scheitern, ohne zu drucken (Vorgabe ``no_media``),
* ``hang``: mitten im Druck hängen, bis der Schalter verschwindet,
* ``abort``: mitten im Druck abbrechen; der Ausgang ist dann offen.

Die Datei wirkt ohne Neustart und ist nur zum Ausprobieren gedacht.
"""

import logging
import os
import threading
import time
import uuid
from pathlib import Path

from PIL import Image

from stowly_print import media as catalog
from stowly_print.drivers.base import Driver, Reading, catalog_media
from stowly_print.model import Capabilities, DriverStatus, Paper, PrinterError, PrintOutcome

log = logging.getLogger("stowly_print.image")

SIMULATE_FILE = "simulate.txt"
DEFAULT_DPI = catalog.DPI
_ERROR_CODES = frozenset(error.value for error in PrinterError)


class PrintAborted(RuntimeError):
    """Der Bild-Treiber wurde angewiesen, mitten im Druck abzubrechen (``simulate = abort``)."""


class ImageDriver:
    """Schreibt PNG-Dateien. ``confirms_print`` ist wahr: Was geschrieben ist, ist „gedruckt".

    ``media`` ist die Kennung eines Papiers im Katalog, die Vorgabe für Vorlagen ohne Papier
    (ohne Angabe 62 mm endlos). Eine unbekannte Kennung ist ein ``ValueError``; ``build_driver``
    macht daraus einen Drucker, der ``config`` meldet.
    """

    # Eine eingelegte Rolle gibt es nicht: Der Treiber kann jedes Papier.
    loaded: Paper | None = None

    def __init__(
        self,
        directory: Path | str,
        *,
        dpi: int = DEFAULT_DPI,
        media: str | None = None,
        simulate: str | None = None,
    ) -> None:
        paper = catalog.paper(catalog.DEFAULT_PAPER_ID if media is None else media.strip())
        if paper is None:
            raise ValueError(f"Die Rolle '{media}' kennt der Bild-Treiber nicht (Papier-Katalog).")
        self.directory = Path(directory)
        self.simulate = simulate
        self.paper = paper
        self.last_error: str | None = None
        self.last_message: str | None = None
        self._dpi = dpi
        self._capabilities = self._capabilities_for(paper)
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ Treiber-Schnittstelle

    def capabilities(self) -> Capabilities:
        return self._capabilities

    def status(self) -> DriverStatus:
        try:
            mode, code = self._simulation()
            if mode == "fail":
                return DriverStatus(
                    reachable=True, ready=False, media_detected=code != "no_media", errors=[code]
                )
            if not self._writable():
                return DriverStatus(reachable=False, ready=None, media_detected=None, errors=["offline"])
            return DriverStatus(reachable=True, ready=True, media_detected=True, errors=[])
        except Exception:  # status() wirft nie
            log.exception("Der Zustand des Bild-Treibers ließ sich nicht feststellen.")
            return DriverStatus(reachable=False, ready=None, media_detected=None, errors=["unknown"])

    def print(self, image: Image.Image, cut: bool = True) -> PrintOutcome:
        """Ohne Auftrag im Rücken: Die Datei bekommt einen zufälligen Namen."""
        return self._write(f"druck-{uuid.uuid4().hex}", image, self.paper)

    def probe(self) -> Reading:
        """Der Zustand gilt für jedes Papier: Der Treiber hat keine Rolle, die passen müsste."""
        return Reading(self.status())

    # ------------------------------------------------------------------ Erweiterungen für den Auftragsdienst

    def for_job(self, job_id: str, copy: int = 1) -> Driver:
        """Derselbe Treiber, der das nächste Bild unter der Kennung des Auftrags ablegt."""
        return _JobView(self, _name(job_id, copy), self.paper)

    def for_paper(self, paper: catalog.PaperSpec) -> "_JobView":
        """Derselbe Treiber für ein Papier des Katalogs: Das PNG bekommt dessen Größe."""
        return _JobView(self, None, paper)

    def image_path(self, job_id: str) -> Path | None:
        """Das PNG eines Auftrags, falls es schon geschrieben ist."""
        path = self.directory / f"{job_id}.png"
        return path if path.is_file() else None

    def cleanup(self, *, max_age_s: float, keep: int) -> int:
        """Löscht Bilder, die älter sind als ``max_age_s``, und alle über die ``keep`` jüngsten hinaus.

        Liefert die Zahl der gelöschten Dateien. Halbfertige Dateien, die liegen geblieben sind, gehen mit.
        """
        try:
            entries = [entry for entry in self.directory.iterdir() if entry.suffix in (".png", ".tmp")]
        except OSError:
            return 0
        now = time.time()
        aged: list[tuple[float, Path]] = []
        for entry in entries:
            try:
                aged.append((entry.stat().st_mtime, entry))
            except OSError:
                continue
        aged.sort(reverse=True)
        removed = 0
        for position, (modified, entry) in enumerate(aged):
            stale_part = entry.suffix == ".tmp" and now - modified > 3600
            if position >= keep or now - modified > max_age_s or stale_part:
                try:
                    entry.unlink()
                    removed += 1
                except OSError:
                    continue
        return removed

    # ------------------------------------------------------------------ intern

    def _writable(self) -> bool:
        """Wahr, wenn das Verzeichnis da ist oder sich anlegen ließe."""
        probe = self.directory
        while not probe.exists():
            if probe.parent == probe:
                return False
            probe = probe.parent
        return probe.is_dir() and os.access(probe, os.W_OK)

    def _simulation(self) -> tuple[str | None, str]:
        """Der gerade geltende Schalter als ``(art, fehlercode)``."""
        raw = self.simulate
        if raw is None:
            try:
                raw = (self.directory / SIMULATE_FILE).read_text(encoding="utf-8")
            except OSError:
                return None, ""
        mode, _, argument = raw.strip().partition(":")
        mode = mode.strip().lower()
        if mode not in ("fail", "hang", "abort"):
            return None, ""
        code = argument.strip().lower()
        return mode, code if code in _ERROR_CODES else PrinterError.NO_MEDIA.value

    def _capabilities_for(self, paper: catalog.PaperSpec) -> Capabilities:
        return Capabilities(
            dpi=self._dpi,
            media=catalog_media(paper),
            cutter=True,
            colors=["black"],
            status_query=True,
            confirms_print=True,
        )

    def _write(self, name: str, image: Image.Image, paper: catalog.PaperSpec) -> PrintOutcome:
        with self._lock:
            self.last_error = None
            self.last_message = None
            fixed = paper.printable_length_px
            if (
                image.mode != "1"
                or image.size[0] != paper.printable_width_px
                or (fixed is not None and image.size[1] != fixed)
            ):
                log.error(
                    "Bild passt nicht zum Papier %s des Bild-Treibers: %s, Modus %s.",
                    paper.id,
                    image.size,
                    image.mode,
                )
                self.last_error = PrinterError.CONFIG.value
                return PrintOutcome.FAILED

            mode, code = self._simulation()
            if mode == "fail":
                self.last_error = code
                return PrintOutcome.FAILED
            try:
                self.directory.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                log.error("Verzeichnis für Etiketten lässt sich nicht anlegen: %s", exc)
                self.last_error = PrinterError.OFFLINE.value
                return PrintOutcome.FAILED

            target = self.directory / f"{name}.png"
            partial = self.directory / f"{name}.tmp"
            # Ab hier ist der Ausgang offen, bis die Datei an ihrem Platz liegt.
            image.save(partial, format="PNG", optimize=True)
            while mode == "hang":
                time.sleep(0.1)
                mode, _code = self._simulation()
            if mode == "abort":
                raise PrintAborted("Der Bild-Treiber hat den Druck auf Anweisung abgebrochen.")
            os.replace(partial, target)
            return PrintOutcome.PRINTED


def _name(job_id: str, copy: int) -> str:
    return job_id if copy <= 1 else f"{job_id}.{copy}"


class _JobView:
    """Der Bild-Treiber für ein Papier und, wenn bekannt, einen Auftrag: ``print`` schreibt
    ``<Auftrag>.png`` in der Größe des Papiers (ohne Auftrag unter einem zufälligen Namen)."""

    def __init__(self, driver: ImageDriver, name: str | None, paper: catalog.PaperSpec) -> None:
        self._driver = driver
        self._name = name
        self.paper = paper

    @property
    def last_error(self) -> str | None:
        return self._driver.last_error

    @property
    def last_message(self) -> str | None:
        return self._driver.last_message

    @property
    def loaded(self) -> Paper | None:
        return None

    def capabilities(self) -> Capabilities:
        return self._driver._capabilities_for(self.paper)

    def status(self) -> DriverStatus:
        return self._driver.status()

    def print(self, image: Image.Image, cut: bool = True) -> PrintOutcome:
        name = self._name if self._name is not None else f"druck-{uuid.uuid4().hex}"
        return self._driver._write(name, image, self.paper)

    def for_job(self, job_id: str, copy: int = 1) -> Driver:
        return _JobView(self._driver, _name(job_id, copy), self.paper)

    def for_paper(self, paper: catalog.PaperSpec) -> "_JobView":
        return _JobView(self._driver, self._name, paper)
