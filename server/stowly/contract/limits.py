"""Eingabegrenzen des Vertrags an einer Stelle.

Die Modelle (``entities.py``, ``commands.py``, ``api.py``) lesen ihre Grenzen von hier, und
der Export schreibt sie als ``LIMITS`` nach ``web/src/contract/api.gen.ts``. Dort prüfen
der Kern der Web-App und die Attrappe ihre Eingaben mit denselben Zahlen
(``web/src/contract/input.ts``), bevor ein Befehl entsteht: Was die App annimmt, lehnt
der Server nicht als ``invalid`` ab.

Alle Werte sind Obergrenzen: Zeichen bei Texten, Anzahl bei Listen, Tage bei Fristen. Einzige
Ausnahme ist ``password_min``, die Mindestlänge eines neuen Haushalts-Passworts.
"""

from types import MappingProxyType
from typing import Final

LIMITS: Final = MappingProxyType(
    {
        "product_name": 120,
        "brand": 80,
        "quantity": 40,
        "zone_name": 60,
        "icon": 32,
        "color": 16,
        "printer_name": 60,
        "device_name": 60,
        "password": 200,
        "barcodes": 20,  # Barcodes je Produkt
        "warn_days": 3650,  # Vorlaufzeit der MHD-Warnung, 0 bis …
        "retention_days": 3650,  # Aufbewahrung der Lösch-Historie, 1 bis …
        "printer_model": 40,
        "printer_address": 200,
        "printer_media": 40,
        "printer_urls": 4,  # Adressen je direktem Drucker, 1 bis …
        "printer_url": 200,
        "printer_token": 200,
        "printer_queue": 60,  # Name des Druckers im Druckdienst
        "min_stock": 999,  # Mindestbestand eines Produkts in Packungen, 1 bis …
        "shopping_text": 120,  # freier Text eines Eintrags der Einkaufsliste
        "shopping_quantity": 999,  # Menge eines Eintrags der Einkaufsliste, 1 bis …
        "push_endpoint": 1024,  # Adresse eines Push-Abos beim Push-Dienst
        "push_origin": 200,  # Ursprung der App (location.origin) beim Anmelden für Push
        # Seit der Einrichtung (docs/sync-protokoll.md, 11.6 bis 11.8):
        "password_min": 8,  # Mindestlänge eines neuen Haushalts-Passworts (Untergrenze)
        "setup_address": 253,  # eine Adresse fürs Zertifikat des Servers: IP oder Name
        "setup_addresses": 10,  # Adressen im Zertifikat des Servers
        "push_contact": 200,  # Kontakt für die Push-Dienste (mailto: oder https)
    }
)
