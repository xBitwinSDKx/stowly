"""Daten, die die App je Etikett an den Druckdienst schickt (docs/etiketten.md, „Daten").

Der Druckdienst kennt nur ``dict[str, str]``; diese Modelle beschreiben, welche
Schlüssel die mitgelieferten Vorlagen erwarten. Alle Werte sind fertig formatierte
Zeichenketten: Der Pi hat keine Uhr und kennt keine Sprache.
"""

from pydantic import Field

from stowly.contract.entities import Model


class PackageLabelData(Model):
    qr: str = Field(description="QR-Inhalt, z. B. 'STOWLY/P/A2B3C'.")
    id: str = Field(description="Packungs-ID im Klartext, z. B. 'A2B3C'.")
    title: str = Field(description="Produktname; bei Platzhaltern der Barcode.")
    subtitle: str = Field(description="Marke und Packungsgröße, mit ' · ' verbunden; darf leer sein.")
    best_before: str = Field(description="MHD als 'TT.MM.JJJJ'; leer = keines.")
    stored: str = Field(description="Tag des Einlagerns als 'TT.MM.JJJJ'.")
    zone: str = Field(description="Name der Zone; leer, wenn es nur eine gibt.")


class ZoneLabelData(Model):
    qr: str = Field(description="QR-Inhalt, z. B. 'STOWLY/Z/3F2B…' (32 Hex-Zeichen).")
    title: str = Field(description="Name der Zone.")
    subtitle: str = Field(description="Zusatzzeile, z. B. 'Lagerzone'; darf leer sein.")
