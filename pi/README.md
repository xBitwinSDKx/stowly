# Raspberry Pi als Druckserver

Platzhalter. Installationsskript, Zertifikats-Skript und Anleitung entstehen in Runde 2.

Was hierher gehört (Hintergrund: [`../docs/recherche.md`](../docs/recherche.md), Abschnitte 3, 4, 6 und 8; Protokoll: [`../docs/etiketten.md`](../docs/etiketten.md)):

- Installation von `stowly_print` auf Raspberry Pi OS Lite (Trixie, Python 3.13) mit den Systempaketen `python3-pil`, `python3-usb`, `python3-segno`, `python3-starlette`, `python3-uvicorn`; ohne FastAPI und pydantic
- Access Point mit hostapd und dnsmasq, feste IP-Adresse in einem unüblichen Bereich, kein vorgetäuschtes Internet
- Druckdienst als Systemdienst unter eigenem Benutzer, udev-Regel für den Brother QL
- HTTPS und HTTP auf derselben Adresse; Skript für ein Zertifikat auf die IP-Adresse (höchstens 825 Tage gültig, `serverAuth`)
- Schreibgeschützte SD-Karte (Overlay), begrenztes Journal

Shell-Skripte, Unit-Dateien und Konfigurationen in diesem Ordner brauchen LF-Zeilenenden; dafür sorgt `.gitattributes`.
