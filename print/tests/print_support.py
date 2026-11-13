"""Bausteine der Tests: ein Treiber, der zählt und sich steuern lässt, und Beispielaufträge."""

import threading
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

from PIL import Image

from stowly_print.model import Capabilities, DriverStatus, JobRequest, Media, PrintOutcome
from stowly_print.render import Fonts
from stowly_print.service import JobEvent, PrinterEntry, PrintService, StaticPrinters
from stowly_print.store import JobStore
from stowly_print.templates import load_builtin

PACKAGE = {
    "qr": "STOWLY/P/A2B3C",
    "id": "A2B3C",
    "title": "Basmati Reis",
    "subtitle": "Kornhaus · 1 kg",
    "best_before": "25.03.2027",
    "stored": "13.11.2026",
    "zone": "",
}
READY = DriverStatus(reachable=True, ready=True, media_detected=True, errors=[])
# Eingecheckte Referenzen: Bilder der Etiketten und der Datenstrom für den Brother QL.
REFERENCE_DIR = Path(__file__).resolve().parent / "reference"


def new_id() -> str:
    return str(uuid.uuid4())


def package_request(title: str = "Basmati Reis", **more: Any) -> JobRequest:
    """Ein Auftrag für ein Packungs-Etikett, geprüft wie ein empfangener."""
    return JobRequest.from_dict(
        {"template": load_builtin("package"), "data": {**PACKAGE, "title": title}, **more}
    )


def wait_until(condition: Callable[[], bool], timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not condition():
        if time.monotonic() > deadline:
            raise AssertionError("Bedingung ist nicht rechtzeitig eingetreten")
        time.sleep(0.005)


class FakeDriver:
    """Ein Treiber ohne Gerät: zählt, was er drucken sollte, und lässt sich steuern.

    * ``outcome``: was ``print`` liefert; bei ``FAILED`` steht ``error`` in ``last_error``
    * ``raises``: ``print`` wirft diese Ausnahme (Abbruch mittendrin)
    * ``gate``: solange gelöscht, hängt ``print``; ``entered`` zeigt, dass ein Druck begonnen hat
    """

    def __init__(
        self,
        *,
        outcome: PrintOutcome = PrintOutcome.PRINTED,
        printable_px: int = 696,
        dpi: int = 300,
        confirms_print: bool = True,
    ) -> None:
        self.outcome = outcome
        self.error: str | None = None
        self.raises: BaseException | None = None
        self.gate = threading.Event()
        self.gate.set()
        self.entered = threading.Event()
        self.calls = 0
        self.printed: list[Image.Image] = []
        self.cuts: list[bool] = []
        self.last_error: str | None = None
        self.status_value = READY
        self.status_calls = 0
        self.fail_after: int | None = None  # ab dem wievielten Aufruf (von 1 gezählt) gescheitert wird
        self._capabilities = Capabilities(
            dpi=dpi,
            media=Media(width_mm=62.0, length_mm=None, printable_px=printable_px),
            cutter=True,
            colors=["black"],
            status_query=True,
            confirms_print=confirms_print,
        )

    def capabilities(self) -> Capabilities:
        return self._capabilities

    def status(self) -> DriverStatus:
        self.status_calls += 1
        return self.status_value

    def print(self, image: Image.Image, cut: bool = True) -> PrintOutcome:
        self.calls += 1
        self.last_error = None
        self.entered.set()
        if not self.gate.wait(timeout=30):
            raise AssertionError("Der Test hat den hängenden Treiber nicht freigegeben")
        if self.raises is not None:
            raise self.raises
        if self.outcome == PrintOutcome.FAILED or (
            self.fail_after is not None and self.calls >= self.fail_after
        ):
            self.last_error = self.error
            return PrintOutcome.FAILED
        self.printed.append(image.copy())
        self.cuts.append(cut)
        return self.outcome


class Recorder:
    """Beobachter, der sich alle Zustandswechsel merkt."""

    def __init__(self) -> None:
        self.events: list[JobEvent] = []
        self.statuses: list[tuple[str, DriverStatus]] = []

    def __call__(self, event: JobEvent) -> None:
        self.events.append(event)

    def status(self, name: str, status: DriverStatus) -> None:
        self.statuses.append((name, status))

    def states(self, job_id: str) -> list[str]:
        return [event.job.state.value for event in self.events if event.job.id == job_id]


def make_service(
    *drivers: FakeDriver, store: JobStore | None = None, start: bool = True, **options: Any
) -> tuple[PrintService, Recorder]:
    """Ein Dienst mit den Druckern ``drucker-1``, ``drucker-2`` … und einem Beobachter."""
    entries = [
        PrinterEntry(name=f"drucker-{number}", driver_name="fake", model=None, driver=driver)
        for number, driver in enumerate(drivers or (FakeDriver(),), start=1)
    ]
    recorder = Recorder()
    options.setdefault("fonts", Fonts.builtin())
    service = PrintService(
        StaticPrinters(entries), store, observer=recorder, status_observer=recorder.status, **options
    )
    if start:
        service.start()
    return service, recorder
