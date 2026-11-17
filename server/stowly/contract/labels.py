"""Daten, die die App je Etikett an den Druckdienst schickt (docs/etiketten.md, „Daten").

Der Druckdienst kennt nur ``dict[str, str]``; diese Modelle beschreiben, welche
Schlüssel die Vorlagen erwarten (die mitgelieferten und die aus der Gestaltung erzeugten).
Alle Werte sind fertig formatierte Zeichenketten: Der Pi hat keine Uhr und kennt keine Sprache.
Ein Schlüssel, den eine Vorlage nicht nutzt, schadet nicht; einer, den sie nutzt und der fehlt,
gilt als leer.
"""

from pydantic import Field

from stowly.contract.entities import Model


class PackageLabelData(Model):
    qr: str = Field(description="QR-Inhalt, z. B. 'STOWLY/P/A2B3C'.")
    id: str = Field(description="Packungs-ID im Klartext, z. B. 'A2B3C'.")
    title: str = Field(description="Produktname; bei Platzhaltern der Barcode.")
    subtitle: str = Field(
        description="Packungsgröße und Marke, mit ' · ' verbunden; darf leer sein. Die Größe steht vorn."
    )
    best_before: str = Field(description="MHD als 'TT.MM.JJJJ'; leer = keines.")
    stored: str = Field(description="Tag des Einlagerns als 'TT.MM.JJJJ'.")
    zone: str = Field(
        description=(
            "Name der Zone, in der die Packung liegt; leer nur, wenn sie keine hat. Seit 0.5.0 immer "
            "gefüllt: Ob er gedruckt wird, entscheidet die Vorlage (ältere Apps schickten ihn nur bei "
            "mehr als einer Zone)."
        )
    )
    # Seit 0.5.0 (docs/plan-0.5.md, 1): einzelne Felder für die Gestaltung. Eine ältere App schickt
    # sie nicht; die Vorlage lässt die Zeile dann weg.
    brand: str = Field(description="Marke allein; darf leer sein.")
    quantity: str = Field(description="Packungsgröße allein, z. B. '500 g'; darf leer sein.")
    best_before_short: str = Field(description="MHD als 'TT.MM.JJ'; leer = keines.")
    stored_short: str = Field(description="Tag des Einlagerns als 'TT.MM.JJ'.")


class ZoneLabelData(Model):
    qr: str = Field(description="QR-Inhalt, z. B. 'STOWLY/Z/3F2B…' (32 Hex-Zeichen).")
    title: str = Field(description="Name der Zone.")
    subtitle: str = Field(description="Zusatzzeile, z. B. 'Lagerzone'; darf leer sein.")
