"""Druckertreiber. Ein Treiber ist eine Druckersprache auf einem Transport.

Runde 2 ergänzt hier ``brother_ql.py`` und ``image.py`` (Bild-Treiber, schreibt PNG);
``zpl.py`` wäre der naheliegende dritte Treiber.
"""

from stowly_print.drivers.base import Driver

__all__ = ["Driver"]
