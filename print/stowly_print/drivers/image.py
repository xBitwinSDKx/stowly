"""Bild-Treiber: schreibt jedes Etikett als PNG in ein Verzeichnis.

Solange kein Drucker da ist, lässt sich damit der ganze Weg ansehen und testen: Der Auftrag
``<Auftrag>`` wird zur Datei ``<Auftrag>.png``, weitere Exemplare zu ``<Auftrag>.2.png`` und so fort.

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

from stowly_print.drivers.base import Driver
from stowly_print.model import Capabilities, DriverStatus, Media, PrinterError, PrintOutcome

log = logging.getLogger("stowly_print.image")

SIMULATE_FILE = "simulate.txt"
DEFAULT_DPI = 300
DEFAULT_WIDTH_MM = 62.0
DEFAULT_PRINTABLE_PX = 696
_ERROR_CODES = frozenset(error.value for error in PrinterError)


class PrintAborted(RuntimeError):
    """Der Bild-Treiber wurde angewiesen, mitten im Druck abzubrechen (``simulate = abort``)."""


class ImageDriver:
    """Schreibt PNG-Dateien. ``confirms_print`` ist wahr: Was geschrieben ist, ist „gedruckt"."""

    def __init__(
        self,
        directory: Path | str,
        *,
        dpi: int = DEFAULT_DPI,
        width_mm: float = DEFAULT_WIDTH_MM,
        printable_px: int = DEFAULT_PRINTABLE_PX,
        simulate: str | None = None,
    ) -> None:
        self.directory = Path(directory)
        self.simulate = simulate
        self.last_error: str | None = None
        self._capabilities = Capabilities(
            dpi=dpi,
            media=Media(width_mm=width_mm, length_mm=None, printable_px=printable_px),
            cutter=True,
            colors=["black"],
            status_query=True,
            confirms_print=True,
        )
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
        return self._write(f"druck-{uuid.uuid4().hex}", image)

    # ------------------------------------------------------------------ Erweiterungen für den Auftragsdienst

    def for_job(self, job_id: str, copy: int = 1) -> Driver:
        """Derselbe Treiber, der das nächste Bild unter der Kennung des Auftrags ablegt."""
        return _JobView(self, job_id if copy <= 1 else f"{job_id}.{copy}")

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

    def _write(self, name: str, image: Image.Image) -> PrintOutcome:
        with self._lock:
            self.last_error = None
            expected = self._capabilities.media.printable_px
            if image.mode != "1" or image.size[0] != expected:
                log.error("Bild passt nicht zum Bild-Treiber: %s, Modus %s.", image.size, image.mode)
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


class _JobView:
    """Der Bild-Treiber, an einen Auftrag gebunden: ``print`` schreibt ``<Auftrag>.png``."""

    def __init__(self, driver: ImageDriver, name: str) -> None:
        self._driver = driver
        self._name = name

    @property
    def last_error(self) -> str | None:
        return self._driver.last_error

    def capabilities(self) -> Capabilities:
        return self._driver.capabilities()

    def status(self) -> DriverStatus:
        return self._driver.status()

    def print(self, image: Image.Image, cut: bool = True) -> PrintOutcome:
        return self._driver._write(self._name, image)
