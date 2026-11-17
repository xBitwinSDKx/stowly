"""Bausteine der Tests: Treiber, die zählen und sich steuern lassen, und Beispielaufträge."""

import threading
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

from PIL import Image

from stowly_print import media as catalog
from stowly_print.drivers.base import Reading, catalog_media, catalog_paper, fits, mismatch_message
from stowly_print.model import Capabilities, DriverStatus, JobRequest, Media, Paper, PrintOutcome
from stowly_print.render import Fonts
from stowly_print.service import JobEvent, PrinterEntry, PrintService, StaticPrinters
from stowly_print.store import JobStore
from stowly_print.templates import load_builtin

PACKAGE = {
    "qr": "STOWLY/P/A2B3C",
    "id": "A2B3C",
    "title": "Basmati Reis",
    "subtitle": "1 kg · Kornhaus",
    "best_before": "25.03.2027",
    "stored": "13.11.2026",
    "zone": "",
}
READY = DriverStatus(reachable=True, ready=True, media_detected=True, errors=[])
# Eingecheckte Referenzen: Bilder der Etiketten und der Datenstrom für den Brother QL.
REFERENCE_DIR = Path(__file__).resolve().parent / "reference"


def new_id() -> str:
    return str(uuid.uuid4())


def package_request(title: str = "Basmati Reis", template: dict | None = None, **more: Any) -> JobRequest:
    """Ein Auftrag für ein Packungs-Etikett, geprüft wie ein empfangener."""
    return JobRequest.from_dict(
        {"template": template or load_builtin("package"), "data": {**PACKAGE, "title": title}, **more}
    )


def format2(paper_id: str, length_mm: float | None = None, kind: str = "package") -> dict[str, Any]:
    """Die mitgelieferte Vorlage im Format 2 auf einem Papier des Katalogs (docs/etiketten.md, 3.4).

    Zeichenfläche und Elemente bleiben die der Vorlage; der Renderer skaliert sie auf die Fläche des
    Papiers. ``length_mm`` ist die Länge auf einer Endlosrolle; die Drehung ergibt sich aus dem Papier.
    """
    paper = catalog.paper(paper_id)
    assert paper is not None, paper_id
    length = paper.length_mm if paper.kind == catalog.DIE_CUT else length_mm
    assert length is not None, "Auf einer Endlosrolle braucht die Vorlage eine Länge."
    template = load_builtin(kind)
    template.update(
        {
            "schema": 2,
            "name": f"{kind}-{paper_id}",
            "media": {"id": paper.id, "kind": paper.kind, "width_mm": paper.width_mm, "length_mm": length},
            "rotate": 90 if catalog.rotated(paper, length) else 0,
        }
    )
    return template


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


def roll(paper_id: str | None, *, kind: str = catalog.ENDLESS, width_mm: float = 62.0) -> Paper:
    """Eine eingelegte Rolle, wie sie ein Drucker meldet: aus dem Katalog oder (``None``) unbekannt."""
    if paper_id is None:
        return Paper(id=None, kind=kind, width_mm=width_mm, length_mm=None)
    paper = catalog.paper(paper_id)
    assert paper is not None, paper_id
    return catalog_paper(paper)


class RollDriver(FakeDriver):
    """Ein Treiber mit eingelegter Rolle, wie der Brother-Treiber über USB, aber ohne Gerät.

    ``loaded`` ist die Rolle; ``media`` das Papier der Konfiguration. ``for_paper`` liefert den
    Treiber für ein Papier: Er vergleicht vor dem Druck die Rolle damit und scheitert sonst mit
    ``media_mismatch`` und einem Satz. ``papers`` merkt sich je Druck das Papier.

    ``probe`` ist eine Abfrage des Geräts (``probes`` zählt sie); der Vergleich mit einem Papier
    kommt aus derselben Abfrage, ``compared`` merkt sich die Papiere.
    """

    def __init__(
        self, loaded: Paper | None, *, media: str = catalog.DEFAULT_PAPER_ID, **options: Any
    ) -> None:
        default = catalog.paper(media)
        assert default is not None, media
        super().__init__(printable_px=default.printable_width_px, **options)
        self._capabilities = Capabilities(
            dpi=300,
            media=catalog_media(default),
            cutter=True,
            colors=["black"],
            status_query=True,
            confirms_print=True,
        )
        self.default = default
        self.loaded = loaded
        self.last_message: str | None = None
        self.papers: list[str] = []
        self.compared: list[str] = []  # mit welchem Papier der Zustand verglichen wurde
        self.probes = 0

    def probe(self) -> Reading:
        self.probes += 1
        loaded = self.loaded
        return Reading(
            self.compare(self.default, loaded),
            loaded=loaded,
            compare=lambda paper: self.compare(paper, loaded),
        )

    def status(self) -> DriverStatus:
        return self.probe().status

    def status_for(self, paper: catalog.PaperSpec) -> DriverStatus:
        return self.probe().for_paper(paper)

    def compare(self, paper: catalog.PaperSpec, loaded: Paper | None) -> DriverStatus:
        self.compared.append(paper.id)
        if fits(loaded, paper):
            return READY
        return DriverStatus(reachable=True, ready=False, media_detected=True, errors=["media_mismatch"])

    def print(self, image: Image.Image, cut: bool = True) -> PrintOutcome:
        return self.print_for(image, cut, self.default)

    def print_for(self, image: Image.Image, cut: bool, paper: catalog.PaperSpec) -> PrintOutcome:
        self.last_message = None
        if not fits(self.loaded, paper):
            self.calls += 1
            self.last_error = "media_mismatch"
            self.last_message = mismatch_message(self.loaded, paper)
            return PrintOutcome.FAILED
        outcome = super().print(image, cut)
        if outcome != PrintOutcome.FAILED:
            self.papers.append(paper.id)
        return outcome

    def for_paper(self, paper: catalog.PaperSpec) -> "RollView":
        return RollView(self, paper)


class RollView:
    """``RollDriver.for_paper``: derselbe Treiber für ein Papier des Katalogs."""

    def __init__(self, driver: RollDriver, paper: catalog.PaperSpec) -> None:
        self.driver = driver
        self.paper = paper

    @property
    def last_error(self) -> str | None:
        return self.driver.last_error

    @property
    def last_message(self) -> str | None:
        return self.driver.last_message

    @property
    def loaded(self) -> Paper | None:
        return self.driver.loaded

    def capabilities(self) -> Capabilities:
        return Capabilities(300, catalog_media(self.paper), True, ["black"], True, True)

    def status(self) -> DriverStatus:
        return self.driver.status_for(self.paper)

    def print(self, image: Image.Image, cut: bool = True) -> PrintOutcome:
        return self.driver.print_for(image, cut, self.paper)
