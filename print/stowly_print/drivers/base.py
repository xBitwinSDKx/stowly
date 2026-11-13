"""Treiber-Schnittstelle (docs/recherche.md, Abschnitt 5; docs/etiketten.md).

Der Rest des Pakets kennt nur diese Schnittstelle. Bibliotheken wie
``brother_ql_next`` bleiben hinter ihr gekapselt und werden erst im jeweiligen
Treiber-Modul importiert, damit das Paket auch ohne sie importierbar ist.
"""

from typing import TYPE_CHECKING, Protocol, runtime_checkable

from stowly_print.model import Capabilities, DriverStatus, PrintOutcome

if TYPE_CHECKING:
    from PIL import Image


@runtime_checkable
class Driver(Protocol):
    """Ein Drucker aus Sicht des Druckdienstes."""

    def capabilities(self) -> Capabilities:
        """Auflösung, Material, Schneider, Farben und was der Treiber melden kann.

        Darf das Gerät nicht ansprechen: Der Renderer braucht die Werte auch dann,
        wenn der Drucker gerade aus ist.
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
