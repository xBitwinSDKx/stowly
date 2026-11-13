# Technische Grundlagen

Ergebnisse der Recherche vom 13.11.2026, auf die sich der Plan für Stufe 1 stützt (`plan-stufe-1.md`). Quellen sind Herstellerdokumentation, Chromium-Quelltext, Paketregister und Fehlerdatenbanken. **Nichts davon wurde auf echter Hardware geprüft.** Punkte unter „Am Gerät zu prüfen" sind offen.

Vom Anwender geliefert (liegen nicht im Repository; die Briefings nennen den Ablageort):

- „LNA Adoption Guide" – Chrome-Leitfaden zu Local Network Access (Stand 18.05.2026)
- Liste der WebKit-Fehler zur iPhone-Kamera (Abzug vom 13.11.2026)

## 1. Scannen im Browser

- **Erkennung:** native `BarcodeDetector`-API verwenden, wenn `getSupportedFormats()` die benötigten Formate abdeckt, sonst das Ponyfill [`barcode-detector`](https://www.npmjs.com/package/barcode-detector) (3.2.3, auf Basis von `zxing-wasm` 3.1.6, beide vom 19.10.2026) in einem Web Worker. Beide haben dieselbe API.
- **Unterstützung:** Chrome für Android seit Version 83. Safari bis 27.x nur hinter einem Schalter. Desktop-Chrome nur auf macOS und ChromeOS.
- **Offline-Falle:** Das Ponyfill lädt seine `.wasm`-Datei standardmäßig von jsDelivr. Sie muss selbst gehostet und im Service Worker vorab gespeichert werden ([README](https://github.com/Sec-ant/barcode-detector#preparezxingmodule)).
- **Nicht geeignet:** `html5-qrcode` (letzte Version April 2023), `@zxing/browser` (nur noch Wartung), `quagga2` (nur 1D-Codes).
- **iPhone-Kamera:**
  - Mehrlinsen-Kameras sind seit iOS 16.4 sichtbar; die Gerätenamen sind lokalisiert, deshalb nach `getCapabilities()` auswählen, nicht nach Namen.
  - WebKit 262416 (offen): Die „Back Triple Camera" wechselt selbstständig die Linse. Eine feste Rückkamera wählen und die Wahl speichern.
  - Pro-Modelle fokussieren mit der Hauptlinse erst ab 15–20 cm. Für kleine Codes 1920×1080 anfordern oder `zoom` setzen.
  - `torch`, `zoom`, `focusDistance` nur nutzen, wenn `getCapabilities()` sie meldet. `getSettings()` lieferte bis Ende 2024 veraltete Werte für `torch` (WebKit 280970).
- **Android-Kamera:** `facingMode: "environment"` kann die Weitwinkel-Linse liefern. Kamera mit Dauerfokus und Taschenlampe bevorzugen, Wahl speichern, Umschalt-Knopf anbieten.
- **Ablauf:** mittleren Bildausschnitt etwa zehnmal pro Sekunde auswerten, denselben Wert zwei Sekunden lang ignorieren, die gesuchten Formate je Schritt einschränken.

Am Gerät zu prüfen: QR-Code von 12–15 mm und kleiner EAN auf einem iPhone Pro; Linsenwahl auf dem Android-Gerät; native Erkennung beim ersten Einsatz ohne Netz.

## 2. Offline-PWA: Grenzen je Plattform

- **HTTPS und Installation auf dem Home-Bildschirm sind auf beiden Plattformen Voraussetzung.**
- **Speicher:** Chrome löscht nur bei Speichermangel und gewährt `navigator.storage.persist()` installierten Apps stillschweigend. Safari-Tabs verlieren skriptbeschreibbaren Speicher nach sieben Tagen Safari-Nutzung ohne Besuch der Seite; Home-Bildschirm-Apps sind ausgenommen.
- **Background Sync:** nur Chromium. Die Outbox deshalb zusätzlich bei App-Start, `online`, `visibilitychange` und per Timer abarbeiten.
- **Vibration:** Chrome für Android nach der ersten Berührung. Safari kennt `navigator.vibrate` nicht.
- **Ton:** einen `AudioContext` beim Tippen auf „Scan starten" entsperren; spätere Töne brauchen keine Geste. Auf iOS nach dem Wechsel in den Hintergrund wieder aufnehmen.
- **Wake Lock:** Chrome 84, Safari 16.4, in iOS-Home-Bildschirm-Apps erst seit 18.4 (WebKit 254545).
- **Reines `http://192.168.x.x` verliert:** Kamera, Service Worker (Offline, Installation, Cache), Background Sync, `persist()`, Wake Lock, `BarcodeDetector`, die Local-Network-Erlaubnis und `crypto.randomUUID`. Übrig bleiben IndexedDB, Vibration und Ton.
- **`navigator.onLine`:** meldet auf jeder Verbindung `true`. Nur `false` ist verlässlich.

Am Gerät zu prüfen: `navigator.storage.persisted()` auf beiden Handys; Ton auf dem iPhone bei aktivem Stummschalter; erneute Kamera-Nachfragen in der iOS-Home-Bildschirm-App.

## 3. Direktdruck vom Handy zum Pi

Eine HTTPS-Seite darf `http://<private IP>` normalerweise nicht aufrufen (Mixed Content).

- **Chrome ab 142 (Desktop und Android):** Anfragen an eine private IP als Literal, an einen `.local`-Namen oder mit `targetAddressSpace: "local"` sind vom Mixed-Content-Verbot ausgenommen und brauchen eine einmalige Erlaubnis je Herkunft. Die Nachfrage erscheint erst, wenn eine Verbindung zustande kommt, und die erste Anfrage muss von einer Seite kommen, nicht vom Service Worker.
- **Seite selbst unter privater Adresse:** In Chromium ist derzeit nur „öffentlich → lokal" erlaubnispflichtig. RFC-1918-Adressen und Tailscales 100.64/10 zählen als lokal. Eine vom Service Worker ausgelieferte Seite erbt den Adressraum, aus dem das Worker-Skript geladen wurde. Eine über LAN oder Tailscale aktualisierte PWA druckt also ohne Nachfrage. Chrome will „lokal → lokal" später ebenfalls absichern, die App muss die Nachfrage daher immer verkraften.
- **Safari:** keine Ausnahme, kein `targetAddressSpace`, also blockiert.
- **Firefox:** Desktop fragt seit 153 nach, Rest ungeprüft.

Bewertung der Wege (1 = am robustesten):

| Weg | Android Chrome | iOS Safari | Robustheit |
|---|---|---|---|
| HTTPS am Pi, Zertifikat einer privaten Zertifizierungsstelle auf die IP | ja | ja | 1 |
| Reines HTTP über Local Network Access | ja | nein | 2 |
| Seite des Pi per `window.open("http://<ip>/p#job")` öffnen | ja | ungeprüft | 3 |

- **Zertifikat:** Chrome akzeptiert vom Nutzer installierte Wurzelzertifikate. Apple begrenzt private Blatt-Zertifikate auf 825 Tage; erforderlich sind ein SAN mit der IP-Adresse und die Verwendung `serverAuth`.
- **Empfehlung:** Der Pi bietet HTTPS und HTTP auf derselben IP. Die App versucht HTTPS, dann HTTP (wo `targetAddressSpace` existiert), dann die Navigation. Aufträge als `text/plain` senden vermeidet die CORS-Vorabanfrage.
- **Verworfen:** öffentlich vertrautes Zertifikat, das das Handy zum Pi trägt (Let's Encrypt sinkt 2027 auf 64 Tage, ein abgelaufenes Zertifikat sperrt den Transportweg); der Pi antwortet auf den Namen der App (braucht das DNS des Pi, das Private DNS und Tailscale-DNS umgehen).

Am Gerät zu prüfen: Nachfrage in der installierten PWA; Android 17 verlangt für Chrome zusätzlich eine Systemerlaubnis für das lokale Netzwerk; Vertrauen in die private Zertifizierungsstelle innerhalb der iOS-Home-Bildschirm-App.

## 4. Handy im WLAN ohne Internet

- **Android:** Ein WLAN ohne Internet wird nicht zum Standardnetz, solange mobile Daten funktionieren. Chrome-Anfragen an den Pi laufen ins Leere, bis der Nutzer „Verbunden bleiben" bestätigt. Solche Netze verlieren Priorität beim automatischen Verbinden.
- **iOS:** verbindet sich automatisch und verlässt das Netz wieder. Nach manuellem Verbinden bleibt es, behält Mobilfunk als Standardroute und erreicht lokale IPs trotzdem.
- **Versteckte SSID:** Apple rät ab und zeigt eine Datenschutzwarnung. Ein WLAN-QR-Code am Eingang macht das manuelle Verbinden schnell.
- **DNS:** Striktes Private DNS, DNS-Profile und Tailscale-DNS ignorieren den Resolver des Pi. Nur IP-Adressen verwenden.
- **Adresse:** Den Pi über ein IP-Literal in einem unüblichen Subnetz ansprechen (192.168.4.1 ist eine häufige Werkseinstellung). Kein Internet vortäuschen.
- **Server erreichbar?** `GET /api/health` mit `cache: "no-store"`, Abbruch nach 3 s, geprüfter JSON-Marker.
- **Drucker erreichbar?** Statusabruf mit Abbruch nach 1,5 s; die Antwort enthält einen HMAC über eine Zufallszahl, damit ein fremdes Gerät unter derselben IP nicht als Drucker durchgeht.

## 5. Etikettendrucker

- **Empfehlung:** Brother QL-8xx. QL-800 per USB am Pi; QL-820NWBc, wo der Server über TCP 9100 druckt.
- **Etikett:** 62-mm-Endlosrolle, auf 29 mm geschnitten: 696 × 342 Pixel bei 300 dpi. Papier DK-22205 fürs Regal, Folie DK-22212 für den Gefrierschrank. Laut Brother überstehen DK-Etiketten 240 h bei −30 °C.
- **QR-Code:** Version 1, 6 Pixel je Modul, etwa 15 mm Kantenlänge. Module brauchen ganze Pixel.
- **Bibliothek:** [`brother_ql_next`](https://pypi.org/project/brother-ql-next/) 0.12.0 (20.05.2026), ein Maintainer. `brother_ql` (2019) und `brother_ql-inventree` (archiviert 12.03.2026) sind tot. Version fest pinnen und hinter einer eigenen Treiber-Schnittstelle kapseln.
- **Status:** Über USB liest die Bibliothek den Druckerstatus und bestätigt den Druck. Ihr Netzwerk-Backend schreibt nur; über LAN gibt es Status nur per SNMP, „Etiketten leer" erst nach einem fehlgeschlagenen Druck.
- **Editor Lite:** Der Modus (USB-Massenspeicher) muss am Drucker ausgeschaltet sein.
- **Komprimierung:** Der QL-800 unterstützt keine Raster-Komprimierung, die 810W/820NWB-Modelle schon.
- **Alternativen:** Zebra/ZPL ist das beste Protokoll (Klartext, Status über USB und TCP) und der naheliegende zweite Treiber. Dymo 550 nimmt nur Original-Rollen mit Chip. Niimbot und Phomemo sind akkubetrieben und für unbeaufsichtigten Druck ungeeignet.

Treiber-Schnittstelle (ein Treiber ist eine Druckersprache auf einem Transport):

```python
capabilities() -> dpi, media(width_mm, length_mm | None, printable_px),
                  cutter, colors, status_query, confirms_print
status()       -> reachable, ready | None, media_detected | None, errors
print(image_1bit, cut=True) -> "printed" | "sent" | "failed"
```

Am Gerät zu prüfen: QR-Leserate und Haftung nach vier Wochen bei −18 °C.

## 6. Raspberry Pi als Druckserver und Access Point

- **System:** Raspberry Pi OS Lite 32-bit (Trixie) läuft auf dem Zero W. Start dauert etwa 2,5 Minuten, nach Optimierung etwa 35 s.
- **Access Point:** hostapd und dnsmasq, nicht der NetworkManager-Hotspot (offene Fehler auf dieser Geräteklasse). WPA2-CCMP.
- **Python:** Trixie liefert Python 3.13.5 mit `python3-pil`, `python3-usb`, `python3-segno`, `python3-starlette`, `python3-uvicorn` als Systempakete. Reine Python-Extras in ein venv mit `--system-site-packages`.
- **Kein FastAPI/pydantic auf dem Pi:** piwheels fehlt `pydantic-core` für cp313/armv6l, die Installation fiele in einen Rust-Build. Der Druckdienst baut deshalb nur auf Starlette und uvicorn.
- **SD-Karte:** Overlay-Root von raspi-config hält alle Schreibzugriffe im RAM. journald begrenzen, denn das RAM sind die 512 MB des Pi.
- **Dienst:** eigener Benutzer in `plugdev`, `video`, `systemd-journal`; udev-Regel für Hersteller `04f9`; `Restart=always`. Nicht auf sudo ohne Passwort bauen.
- **Uhr:** Trixie hat `fake-hwclock` entfernt, und mit Overlay-Root bleibt nichts erhalten: Jeder Start beginnt zur selben Zeit. Monotone Zeit und `boot_id` verwenden, jedes Datum vom Handy übernehmen, kein JWT und kein TOTP.
- **Zero 2 W:** vermeidet die ARMv6- und Startzeit-Probleme.

Was `/health` ehrlich melden kann:

| Feld | Aussagekräftig? |
|---|---|
| Drucker verbunden | ja (USB-Enumeration oder TCP-Verbindung) |
| Bereit, Deckel, Medium, Etiketten leer | Brother über USB ja; über LAN nur per SNMP |
| Unterspannung | nein, die Zero-Reihe hat keinen Detektor: `null` melden |
| Drosselung, Temperatur, Laufzeit | ja |
| SD-Karte | nur Symptome: ext4 `errors_count`, I/O-Fehler im Kernel-Log, unerwartetes Read-only, RAM-Verbrauch des Overlays |

Der Pi hat keine Verbindung zum Server. Das Handy muss den letzten Zustand mitbringen; das Dashboard zeigt „zuletzt gesehen".

## 7. Druckdienst

- **Rendering beim Drucker** aus einer JSON-Nutzlast: Nur dort sind druckbare Pixel und Auflösung bekannt, und eine kleine Nutzlast lässt sich offline gut einreihen. Die Vorlage reist mit dem Auftrag (per Hash adressiert), damit der Pi ohne Netz nie aktualisiert werden muss. Ein exakt passendes 1-Bit-PNG als Notausgang akzeptieren.
- **Idempotenz:** `PUT /v1/jobs/{uuid}`. Eine Wiederholung liefert den vorhandenen Zustand, ein geänderter Inhalt 409.
- **Zustände:** `queued`, `printing`, `printed` (Gerät hat bestätigt), `sent` (Transport schreibt nur), `failed`, `unknown` (mitten im Druck unterbrochen, wird nie automatisch wiederholt).
- **Neustart:** Der Zustand im RAM stirbt mit dem Strom, Antworten tragen deshalb eine `boot_id`. Eine Wiederholung sendet `expect_boot_id` und bekommt nach einem Neustart 409; die App fragt dann nach.
- **Anmeldung:** statisches Bearer-Token, Vergleich in konstanter Zeit, CORS nur für die Herkunft der PWA.

```
stowly_print/
  model.py      Job, JobState, Capabilities, PrinterStatus
  render/       Vorlage + Daten -> 1-Bit-Bild (Pillow, segno, mitgelieferte Schrift)
  drivers/      base.py, brother_ql.py, dummy.py (später zpl.py)
  transport/    pyusb.py, usblp.py, tcp.py
  service.py    PrintService: Warteschlange, sqlite3-Speicher (RAM auf dem Pi, Datei am Server)
  health.py     Prüfungen für Rechner und Drucker
  http.py       Starlette-App
  __main__.py   python -m stowly_print serve --config ...
```

```
GET    /v1/health
GET    /v1/printers              Fähigkeiten und Status
PUT    /v1/jobs/{id}?wait=5      {printer, template, data, expect_boot_id?}
GET    /v1/jobs/{id}
DELETE /v1/jobs/{id}             solange in der Warteschlange
POST   /v1/render                Vorschau als PNG
```

Der Server importiert `PrintService` für seine eigenen Drucker und bindet dieselbe App ein, sodass die PWA mit Server und Pi dasselbe Protokoll spricht.

## 8. USB-Drucker im Docker-Container

- `/dev/bus/usb` einbinden und `device_cgroup_rules: ["c 189:* rmw"]` setzen, keinen festen `--device`-Pfad (die Gerätenummer ändert sich bei jedem Einstecken).
- Container erhalten keine Hotplug-Ereignisse, und pyusb hält einen libusb-Kontext je Prozess. Ein aus- und eingeschalteter Drucker bleibt unter Umständen unsichtbar, bis der Prozess neu startet.

## 9. Open Food Facts

- **Abruf:** `GET https://world.openfoodfacts.org/api/v3/product/{ean}?product_type=all&lc=de&fields=product_name_de,product_name,brands,quantity,image_front_small_url`. v2 ist abgekündigt. Unbekannte Codes liefern 404 mit `product_not_found`.
- **Grenze:** 15 Produktabfragen pro Minute je IP, Sperren sind möglich. Abrufe über eine Warteschlange drosseln und jedes Ergebnis dauerhaft speichern.
- **User-Agent:** `AppName/Version (Kontakt)`. Keine persönliche E-Mail-Adresse fest eintragen; der Kontakt ist eine optionale Einstellung.
- **Lizenz:** ODbL (Datenbank), DbCL (Inhalte), CC BY-SA (Bilder). „Open Food Facts (ODbL)" nennen und die Daten trennbar halten.
- **Abdeckung:** 439.037 Produkte mit Deutschland-Kennzeichen; 94 % haben einen Namen, 80 % eine Marke, 65 % ein Frontfoto.
- **Ladeninterne Codes (Präfix 2):** nicht eindeutig, nur lokal führen.

## 10. Spätere Stufen (nur zur Einordnung)

- **Einkaufsliste:** Home-Assistant-To-do-Listen als einziges Sync-Ziel (`POST /api/services/todo/add_item`), darüber auch Bring!. Kein direkter Bring!-Client.
- **Home Assistant:** eine JSON-Zusammenfassung für HAs `rest:`-Integration und ausgehende Webhooks mit fertigem deutschen Satz. Stowly erzeugt die Konfigurationsschnipsel.
- **Benachrichtigungen:** zuerst über den Home-Assistant-Webhook, danach Web Push (`pywebpush`; iOS braucht 16.4+ und die Installation auf dem Home-Bildschirm).
- **Backups:** `sqlite3.Connection.backup()`, `PRAGMA integrity_check` auf der Kopie, AES-256-ZIP mit `pyzipper`, Zeitplan mit APScheduler 3.x.
- **Cookidoo:** keine offizielle Schnittstelle. Such-Links `https://cookidoo.de/search/de-DE?ingredients=a,b&languages=de`; die inoffizielle Suche (`cookidoo-api` 0.19.0) ist eine Grauzone und wurde 2026 zweimal von Vorwerk gebrochen.

## 11. Bluetooth (geprüft, nicht in Stufe 1)

- **Web Bluetooth:** `getDevices()` (dauerhafte Freigabe) steht in Chrome nur hinter einem Schalter; ohne ihn ist in jeder neuen Sitzung eine Geräteauswahl nötig. Safari und Firefox haben die API nicht. Der Brother QL-820NWBc spricht klassisches Bluetooth (SPP), kein GATT.
- **Web Serial über Bluetooth RFCOMM:** Chrome Desktop ab 117, Chrome für Android ab 138. Das Gerät muss im System gekoppelt sein. Chromium speichert die Freigabe für Bluetooth-Ports dauerhaft (Schlüssel ist die Geräteadresse), `getPorts()` liefert den Port danach ohne Nachfrage. Safari hat die API nicht.
- **Folge:** Auf Android wäre Druck ohne Nachfrage mit dem QL-820NWBc machbar, auf dem iPhone nicht. Der Weg bräuchte Rendering und Brother-Raster im Browser (es gibt `@thermal-label/brother-ql-core`, MIT, ein Maintainer). Entscheidung des Anwenders: nicht in Stufe 1.
