"""Treiber-Schnittstelle (docs/recherche.md, Abschnitt 5; docs/etiketten.md).

Der Rest des Pakets kennt nur diese Schnittstelle. Bibliotheken wie
``brother_ql_next`` bleiben hinter ihr gekapselt und werden erst im jeweiligen
Treiber-Modul importiert, damit das Paket auch ohne sie importierbar ist.

Seit 0.5.0 gibt es Papier je Auftrag (docs/etiketten.md, 3.4 und 6). Ein Treiber, der das kann,
bietet zusätzlich (der Auftragsdienst fragt mit ``getattr`` danach, ein Treiber ohne druckt wie
bisher auf dem Papier seiner Konfiguration):

* ``for_paper(paper)``: derselbe Treiber für ein Papier aus dem Katalog (``PaperSpec``). Sein
  ``print`` druckt genau dafür und vergleicht vorher die eingelegte Rolle damit; sein ``status``
  meldet ``media_mismatch``, wenn die Rolle nicht passt oder das Modell das Papier nicht kann.
* ``probe()``: fragt das Gerät einmal ab und liefert eine ``Reading``: den Zustand, verglichen mit
  dem Papier der Konfiguration, die eingelegte Rolle, und den Vergleich mit jedem anderen Papier,
  ohne das Gerät noch einmal zu fragen. Ohne ``probe`` fragt der Dienst ``status()``.
* ``loaded``: die eingelegte Rolle, wie sie die letzte Abfrage gemeldet hat (``Paper``), oder
  ``None`` = unbekannt.
* ``last_error`` und ``last_message``: Code und Satz, wenn ``print`` ``failed`` geliefert hat.
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Protocol, runtime_checkable

from stowly_print import media as catalog
from stowly_print.model import Capabilities, DriverStatus, Media, Paper, PrintOutcome

if TYPE_CHECKING:
    from PIL import Image


@runtime_checkable
class Driver(Protocol):
    """Ein Drucker aus Sicht des Druckdienstes."""

    def capabilities(self) -> Capabilities:
        """Auflösung, Material, Schneider, Farben und was der Treiber melden kann.

        Darf das Gerät nicht ansprechen: Der Renderer braucht die Werte auch dann,
        wenn der Drucker gerade aus ist. ``media`` ist das Papier der Konfiguration, die
        Vorgabe für Vorlagen, die kein Papier nennen.
        """
        ...

    def status(self) -> DriverStatus:
        """Momentaufnahme. Wirft nicht: ein nicht erreichbares Gerät ist ``reachable=False``."""
        ...

    def print(self, image: "Image.Image", cut: bool = True) -> PrintOutcome:
        """Druckt ein 1-Bit-Bild (Pillow-Modus ``"1"``) in exakt passender Größe.

        Breite = ``capabilities().media.printable_px``. Blockiert, bis das Ergebnis
        feststeht. ``PRINTED`` nur, wenn das Gerät bestätigt hat; ``SENT``, wenn der
        Transport nur schreiben kann; ``FAILED``, wenn sicher nichts gedruckt wurde.
        Bricht der Vorgang mittendrin ab und ist der Ausgang offen, wirft die Methode
        eine Ausnahme: Der Auftragsdienst führt den Auftrag dann als ``unknown``.
        """
        ...


@dataclass(frozen=True)
class Reading:
    """Was eine Abfrage des Druckers ergab (``probe()``).

    ``status`` ist der Zustand, verglichen mit dem Papier der Konfiguration; ``loaded`` die
    eingelegte Rolle. ``compare`` vergleicht dieselbe Abfrage mit einem anderen Papier, ohne das
    Gerät noch einmal zu fragen; fehlt es, gilt ``status`` für jedes Papier (ein Treiber ohne Rolle).
    """

    status: DriverStatus
    loaded: Paper | None = None
    compare: Callable[[catalog.PaperSpec], DriverStatus] | None = field(default=None, repr=False)

    def for_paper(self, paper: catalog.PaperSpec | None) -> DriverStatus:
        """Der Zustand für ein Papier; ``None`` = das der Konfiguration."""
        if paper is None or self.compare is None:
            return self.status
        return self.compare(paper)


# --------------------------------------------------------------------------- Papier


def catalog_media(paper: catalog.PaperSpec) -> Media:
    """Das Material eines Papiers aus dem Katalog, wie es ``Capabilities.media`` meldet."""
    return Media(
        width_mm=paper.width_mm,
        length_mm=paper.length_mm,
        printable_px=paper.printable_width_px,
        id=paper.id,
        kind=paper.kind,
        printable_length_px=paper.printable_length_px,
    )


def catalog_paper(paper: catalog.PaperSpec) -> Paper:
    """Ein Papier aus dem Katalog als ``Paper`` (so meldet ein Drucker eine erkannte Rolle)."""
    return Paper(id=paper.id, kind=paper.kind, width_mm=paper.width_mm, length_mm=paper.length_mm)


def reported_paper(kind: str, width_mm: float, length_mm: float | None) -> Paper:
    """Die Rolle, die ein Drucker meldet, als ``Paper``: mit Kennung, wenn sie im Katalog steht
    (``media.find``), sonst mit ``id=None`` und den gemeldeten Maßen."""
    found = catalog.find(kind, width_mm, length_mm)
    if found is not None:
        return catalog_paper(found)
    return Paper(
        id=None,
        kind=kind,
        width_mm=float(width_mm),
        length_mm=None if length_mm is None else float(length_mm),
    )


def paper_name(paper: Paper | catalog.PaperSpec) -> str:
    """Der Name eines Papiers für Sätze an den Anwender: „62 mm endlos", „29 × 90 mm gestanzt"."""
    if isinstance(paper, catalog.PaperSpec):
        return paper.name
    if paper.id is not None:
        known = catalog.paper(paper.id)
        if known is not None:
            return known.name
    width = _mm(paper.width_mm)
    if paper.kind == catalog.ENDLESS:
        return f"{width} mm endlos"
    if paper.length_mm is None:
        return f"{width} mm gestanzt"
    return f"{width} × {_mm(paper.length_mm)} mm gestanzt"


def fits(loaded: Paper | None, paper: catalog.PaperSpec) -> bool:
    """Passt die eingelegte Rolle zum Papier? Nur eine Rolle aus dem Katalog mit derselben Kennung.

    Eine Rolle, die der Katalog nicht kennt (``id=None``), passt zu keinem Papier: Was falsch
    gedruckt wäre, wird gar nicht gedruckt.
    """
    return loaded is not None and loaded.id is not None and loaded.id == paper.id


def mismatch_message(loaded: Paper | None, paper: catalog.PaperSpec) -> str:
    """Der Satz zu ``media_mismatch``: „Eingelegt: 62 mm endlos; das Etikett braucht 29 × 90 mm gestanzt."."""
    if loaded is None:
        return f"Die eingelegte Rolle ist unbekannt; das Etikett braucht {paper.name}."
    return f"Eingelegt: {paper_name(loaded)}; das Etikett braucht {paper.name}."


def _mm(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else f"{value:g}".replace(".", ",")
