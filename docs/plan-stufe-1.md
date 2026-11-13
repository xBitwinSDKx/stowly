# Stowly – Plan für Stufe 1

## Kontext

Stowly ist eine selbst gehostete Lagerverwaltung für Lebensmittel. Jede Packung bekommt beim Einlagern ein Etikett mit 5-stelliger ID (Klartext und QR-Code), wird per Handy-Scan ein- und ausgebucht und erscheint in einer nach Produkt gruppierten Bestandsliste mit dem kritischsten MHD. Die App muss im Keller ohne Netz funktionieren.

Grundlage sind deine Spezifikation, der UI-Entwurf, der Chrome-Leitfaden zu Local Network Access, deine Liste der WebKit-Kamerafehler und Recherchen zu den technisch heiklen Punkten (Stand 13.11.2026). Der zuerst gestartete Anlauf (einfache Flask-App „PantryManager") wurde gestoppt, bevor Dateien entstanden; das Repo ist unverändert.

Durch deine Antworten festgelegt:

- Handys: Android **und** iPhone
- Drucker: Brother QL, noch nicht gekauft (Empfehlung unten)
- Druckwege: über den Server (Netzwerk) und über den Raspberry Pi; kein Bluetooth
- Betrieb: Linux-Container mit Docker Compose, Ziel ist ein headless Debian 13
- HTTPS über einen vorhandenen Reverse Proxy: bei einem Anwender Nginx Proxy Manager mit eigener Zertifizierungsstelle (`https://stowly.home`, Namensauflösung über Pi-hole), sonst Tailscale
- Anmeldung mit einem Haushalts-Passwort
- Stufe 1 = Kern + Offline + Scan + Druck
- Node.js wird auf diesem PC installiert (nur zum Entwickeln und Testen)
- Stowly bekommt ein eigenes Git-Repository

## Umfang

**Stufe 1 (dieser Plan)**

- Gruppierte Bestandsliste mit aufklappbarer Chargen-Ansicht (MHD, Menge, Zone, Packungs-IDs), Aktionen Details / Bearbeiten / Löschen in der Zeile, Suche
- Lagerzonen: Verwaltung, Modus „Primärzone" oder „gleichwertig", Zonen-QR-Codes, Zonenleiste beim Scannen, Zonen-UI ausgeblendet bei nur einer Zone
- Scannen am Handy: Einlagern (Menge vorwählen, Barcode, MHD, Etiketten), Entnehmen per Etikett-QR, Zonenwechsel per QR, Ton und Vibration als Rückmeldung
- Offline-PWA: App und Daten liegen auf dem Gerät, Änderungen warten in einer Outbox und werden automatisch synchronisiert; geregelte Konfliktauflösung
- Etikettendruck: mehrere Drucker, Drucker je Zone, Brother QL, Druckdienst für den Raspberry Pi, Direktdruck vom Handy zum Pi, Zustandsanzeige im Dashboard
- Lösch-Historie mit Wiederherstellen (Aufbewahrungsdauer einstellbar)
- MHD-Warnungen in der App mit einstellbarer Vorlaufzeit (global und je Produkt)
- Produktdaten und Vorschaubild über Open Food Facts
- Hell/Dunkel, wählbare Akzentfarbe, Oberfläche nach deinem Entwurf, Deutsch
- Anmeldung mit einem Haushalts-Passwort, Geräte bleiben angemeldet
- Linux-Container mit Docker Compose
- Manuelle Sicherung: vollständige Kopie der Datenbank als Download (der CSV-Import und -Export folgt in Stufe 3)

**Später (nicht Teil dieses Plans)**

- Stufe 2: Mindestbestand und Einkaufsliste, Home-Assistant-Anbindung (Sensoren, Webhooks für Sprachansagen, To-do-Listen – darüber läuft auch Bring!, ohne dass Stowly Bring!-Zugangsdaten speichert), FIFO-Hinweis, Statistik verbraucht/entsorgt, automatische verschlüsselte Backups, Push-Benachrichtigungen
- Stufe 3: Daten-Import und -Export als CSV, Cookidoo-Rezeptvorschläge, Verbrauchsprognose. Der CSV-Import legt Packungen über dieselben Befehle an wie die App, bekommt also IDs aus dem Vorrat und kann Etiketten nachdrucken; dafür ist in Stufe 1 nichts umzubauen. Cookidoo hat keine offizielle Schnittstelle: Sicher machbar sind Such-Links mit den bald ablaufenden Zutaten; Rezeptkarten mit Bild gehen nur über eine inoffizielle Abfrage, die Vorwerk jederzeit sperren kann, und wären deshalb abschaltbar.

Damit Stufe 2 und 3 ohne Umbau anschließen, schreibt Stufe 1 bereits ein Ereignisprotokoll mit Entnahmegrund (verbraucht/entsorgt) mit.

## Architektur

| Teil | Technik | Aufgabe |
|---|---|---|
| Server | Python 3.12, FastAPI, SQLite | Maßgeblicher Datenbestand, Sync-Schnittstelle, Anmeldung, Open-Food-Facts-Abruf, Druck auf Drucker im Heimnetz |
| Web-App | React, TypeScript, Vite, Dexie (IndexedDB), Service Worker | Eine App für Desktop und Handy; arbeitet immer auf der lokalen Kopie |
| Druck | Python-Paket `stowly_print` | Etikett rendern, Druckertreiber, Auftragswarteschlange; läuft im Server und eigenständig auf dem Pi, mit derselben Schnittstelle |

```
stowly\
  server\    FastAPI-App: API, Sync, Datenbank-Migrationen, Anmeldung, Tests
  print\     stowly_print: Renderer, Treiber, Auftragsdienst, Zustandsprüfung, Tests
  web\       React-App
    src\core\      Offline-Kern: lokale DB, Outbox, Sync, ID-Vorrat, Scanner, Druck-Weiterleitung
    src\features\  Bestand, Scannen, Zonen, Drucker, Warnungen, Lösch-Historie, Einstellungen
    src\ui\        Design-System nach dem Entwurf
  pi\        Installationsskript, Zertifikats-Skript und Anleitung für den Raspberry Pi
  docs\      Sync-Protokoll, Etikettenformat, Betrieb hinter Nginx Proxy Manager und Tailscale
  Dockerfile, docker-compose.yml, .env.example, README.md
```

Ausgeliefert wird ausschließlich der Linux-Container (Basis `python:3.12-slim`, das Frontend wird beim Image-Bau mitgebaut). Es gibt keine Windows-Startskripte. Auf diesem Windows-PC läuft die App nur zum Entwickeln und Testen direkt mit Python und Node, gestartet über `.claude\launch.json` (Eintrag `stowly`, Port 8010). 

`stowly` wird ein eigenes Git-Repository. Im umgebenden Repo ändere ich nur zwei Dateien: `.gitignore` (Eintrag `stowly/`, damit der Ordner dort nicht doppelt erfasst wird) und `.claude\launch.json`.

## Zentrale Entscheidungen

**1. Jede Packung ist ein eigener Datensatz mit eigener ID.** „4 × Basmati Reis" sind vier Datensätze; Gruppierung, Gesamtmenge und kritischstes MHD entstehen in der Anzeige. Einlagern heißt „Datensatz anlegen", Entnehmen heißt „als gelöscht markieren". Dadurch gibt es keine Zählerstände, die zwei Geräte offline gegeneinander verändern könnten. Ein Produkt kann mehrere Barcodes haben, sodass sich Marken zusammenführen lassen.

**2. IDs kommen aus einem reservierten Vorrat auf dem Handy.** Der Server teilt jedem Gerät bei jedem Sync einige hundert freie IDs zu; offline wird daraus entnommen, ohne Rückfrage. So sind doppelte IDs ausgeschlossen – wichtig, weil sich eine gedruckte ID nicht mehr ändern lässt. Ist der Vorrat offline aufgebraucht, erzeugt das Handy Zufalls-IDs wie in deiner Spezifikation. Empfehlung: Alphabet ohne verwechselbare Zeichen (kein I, L, O, U – 32 Zeichen, 33,5 Mio. Kombinationen), damit sich die ID auch von Hand eintippen lässt.

**3. Sync und Konflikte.** Die App schreibt jede Änderung lokal und zusätzlich als Befehl in die Outbox. Ein Sync-Aufruf schickt die Befehle und holt alle Änderungen seit dem letzten Stand. Jeder Befehl trägt eine eigene Kennung und wird vom Server höchstens einmal ausgeführt.
- Löschen gewinnt gegen gleichzeitiges Bearbeiten (die Packung ist physisch weg). Die verdrängte Bearbeitung erscheint in der Lösch-Historie und lässt sich dort samt Wiederherstellung übernehmen.
- Feldänderungen (MHD, Zone, Produktname): der spätere Zeitstempel gewinnt, der überschriebene Wert steht im Protokoll.
- Sync-Auslöser: App-Start, Rückkehr der Verbindung, Wechsel zurück in die App, nach jeder Änderung; auf Android zusätzlich im Hintergrund (Safari kann das nicht). Ob der Server erreichbar ist, prüft die App selbst, weil die Online-Anzeige des Browsers im Pi-WLAN „online" meldet.

**4. Scannen.** Der Scanner erkennt selbst, was er sieht: Produkt-Barcode startet das Einlagern, Etikett-QR bucht die Packung aus (mit „Rückgängig"), Zonen-QR wechselt die Zone. Im Modus „Primärzone" gilt ein Wechsel für genau einen Einlager-Vorgang, im Modus „gleichwertig" bleibt er bestehen.
- Erkennung: Android nutzt die im Browser eingebaute Barcode-Erkennung. Safari hat keine; dort läuft eine mitgelieferte Erkennung (`barcode-detector` auf Basis von zxing-wasm) im Hintergrund. Sie wird mit der App gespeichert, damit sie offline funktioniert.
- Unbekannter Barcode: Das Produkt wird sofort als Platzhalter angelegt, der Server ergänzt Name und Bild nachträglich aus Open Food Facts. Das gilt offline wie online, weil Open Food Facts nur etwa 15 Abfragen pro Minute erlaubt; jedes Ergebnis wird dauerhaft gespeichert. Ladeninterne Codes (Präfix 2) werden nicht nachgeschlagen. Name von Hand eintragen geht immer.
- iPhone-Kamera (aus deiner Fehlerliste): feste Rückkamera anhand ihrer Fähigkeiten wählen und merken, weil die Dreifachkamera sonst selbstständig die Linse wechselt (WebKit 262416, offen); Taschenlampe und Zoom nur über die abgefragten Fähigkeiten; Bildschirm-wach-halten mit Rückfall für iOS vor 18.4.
- Rückmeldung: Ton auf beiden Plattformen, Vibration nur auf Android – Safari bietet keine.

**5. Druck.** Ein Druckauftrag enthält nur Daten und die Vorlage; gerendert wird dort, wo der Drucker hängt, weil nur diese Stelle Etikettengröße und Auflösung kennt. Server und Pi sprechen dieselbe Schnittstelle. Jeder Auftrag hat eine eigene Kennung, eine Wiederholung druckt nie doppelt; ein mitten im Druck unterbrochener Auftrag wird nicht automatisch wiederholt, die App fragt nach.
- Drucker im Heimnetz: Auftrag geht an den Server, der druckt.
- Drucker am Pi im Keller: Das Handy schickt den Auftrag direkt an den Pi, der dafür HTTPS und HTTP anbietet. HTTPS ist der robuste Weg für beide Plattformen und auf dem iPhone der einzige. Das Zertifikat für den Pi stellt ihr mit der vorhandenen Zertifizierungsstelle aus, der die Geräte bereits vertrauen. Wer keine hat (Tailscale-Variante), erzeugt mit dem mitgelieferten Skript eine eigene und installiert sie einmal pro Handy. Android/Chrome kommt auch ohne Zertifikat aus, weil dort HTTP an private IP-Adressen zulässig ist (dein Chrome-Leitfaden).
- Nichts erreichbar: Etikett bleibt sichtbar „ausstehend" und wird später gedruckt.
- Solange kein Drucker da ist, erzeugt ein Bild-Treiber das Etikett als PNG.

**6. Pi im Keller.** Der Pi spannt ein eigenes WLAN ohne Internet auf und hat keine Verbindung zum Server.
- Zustand: Drucker verbunden, bereit, Etiketten leer, Temperatur und Anzeichen für SD-Karten-Fehler bringt das Handy beim nächsten Sync mit. Das Dashboard zeigt deshalb „zuletzt gesehen", keinen Live-Herzschlag. Unterspannung kann ein Pi Zero nicht melden.
- Der Pi hat keine Uhr; alle Zeitangaben stammen vom Handy.
- Verbinden: Android fragt beim ersten Mal, ob es im WLAN ohne Internet bleiben soll; das iPhone bleibt nach einmaligem manuellem Verbinden. Angesprochen wird der Pi über eine feste IP-Adresse in einem unüblichen Adressbereich, nicht über einen Namen – im Pi-WLAN gibt es kein Pi-hole.
- Aufbau: Raspberry Pi OS Lite, Access Point über hostapd/dnsmasq, schreibgeschützte SD-Karte (Overlay), Druckdienst als Systemdienst.

**7. Zugriff und Betrieb.** Der Container spricht nur HTTP und läuft hinter jedem Reverse Proxy, der HTTPS bereitstellt. Dokumentiert werden zwei Varianten: Nginx Proxy Manager mit eigenem Zertifikat (`https://stowly.home`) und Tailscale. Offline-Modus und Kamera funktionieren nur über die HTTPS-Adresse – das verlangen die Browser; über `http://<LAN-IP>` läuft Stowly nur als Online-Webseite ohne Scan. Auf den Handys wird Stowly als App auf dem Home-Bildschirm installiert; auf dem iPhone ist das nötig, weil Safari lokale Daten sonst nach sieben Tagen ohne Nutzung löscht. Anmeldung: ein Haushalts-Passwort, jedes Gerät bekommt ein eigenes, einzeln sperrbares Token.

**Geprüft und nicht aufgenommen: Bluetooth-Druck.** Die Web-Bluetooth-API verlangt in jeder neuen Sitzung eine Geräteauswahl (dauerhafte Freigabe gibt es nur hinter einem Chrome-Schalter), und der Brother QL spricht klassisches Bluetooth, das diese API nicht bedient. Über Web Serial ginge es auf Android nach einmaligem Koppeln ohne Rückfrage, auf dem iPhone gar nicht. Deine Entscheidung: kein Bluetooth in Stufe 1.

## Hardware-Empfehlung

- **Drucker:** Brother QL-800 (USB) am Pi im Keller. Soll ein Drucker im WLAN-Bereich stehen, der QL-820NWBc; den spricht der Server direkt an. Nicht geeignet: Dymo 550 (nur Original-Rollen mit Chip), Niimbot/Phomemo (Akku, Bluetooth).
- **Etiketten:** 62-mm-Endlosrolle, geschnitten auf 62 × 29 mm. Papier DK-22205 fürs Regal, Folie DK-22212 für den Gefrierschrank.
- **Pi:** Der Zero W funktioniert; der Zero 2 W ist die robustere Wahl (startet schneller, keine Sonderfälle der alten Prozessorarchitektur).
- **Einfachere Alternative:** Führt ein Netzwerkkabel in den Keller, genügt dort ein normaler WLAN-Access-Point. Dann druckt der Server direkt, und der Sonderweg mit Pi-WLAN entfällt.

## Umsetzung mit den Agents

Ein Coordinator und drei Worker, alle Fable 5.2 mit maximalem Aufwand. Die Worker arbeiten in zwei Runden, dazwischen wird integriert; nach Runde 1 ist der Bestand ohne Druck bereits benutzbar. Der gesamte Lauf dauert voraussichtlich mehrere Stunden.

**Phase 0 – Vorbereitung (ich):** Node.js LTS per winget installieren, in `stowly` ein eigenes Git-Repository anlegen (`git init`, Branch `main`), Python-Umgebung `stowly\.venv`.

**Phase 1 – Coordinator:** lauffähiges Skelett aller Teile, Datenbankschema, Sync-Protokoll und Datentypen als verbindlicher Vertrag, Schnittstelle des Offline-Kerns samt Attrappe (damit Oberfläche und Kern unabhängig entstehen), Design-Grundlagen aus dem Entwurf, Briefings mit eindeutigem Dateibesitz.

| Worker | Runde 1 – Kern | Runde 2 – Druck und Härtung | Besitzt |
|---|---|---|---|
| 1 Server | API, Sync mit Konfliktregeln, Anmeldung, ID-Vorrat, Open Food Facts, Lösch-Historie, Export, Dockerfile und Compose | `stowly_print` mit Brother-QL- und Bild-Treiber, Auftragsdienst, Pi-Installation, Zertifikats-Skript | `server\`, `print\`, `pi\`, Deployment |
| 2 Oberfläche | Design-System, Dashboard, Bestandsliste mit Chargen, Zonen, Warnungen, Lösch-Historie, Einstellungen, Anmeldung | Druckerverwaltung, Etikett-Vorschau, ausstehende Etiketten, Pi-Zustand, Zonen-QR drucken, Feinschliff Handy/Desktop | `web\src\ui\`, `web\src\features\` außer Scannen |
| 3 Offline-Kern & Scannen | Lokale DB, Outbox, Sync, Scanner mit Rückmeldung, Scan-Abläufe, Service Worker | Druck-Weiterleitung inkl. Direktdruck, Zustand des Pi weiterreichen, Installations- und Update-Ablauf der App | `web\src\core\`, `web\src\features\scan\`, Service Worker |

**Nach jeder Runde – Coordinator:** Teile verbinden, alle Tests ausführen, Code gegen die Verträge prüfen; Mängel gehen als Nachbesserung an den jeweiligen Worker zurück. Danach prüfe ich selbst im Browser.

Regeln: Jeder Worker ändert nur eigene Dateien und meldet Abweichungen vom Vertrag, statt fremde Dateien anzupassen. Die Agents committen nicht; Commits setze ich an den Phasengrenzen im Stowly-Repository (Grundgerüst, nach jeder Runde, nach jeder Integration). Das Repository bleibt lokal: Ein Remote, etwa auf GitHub, richte ich nur auf deinen ausdrücklichen Wunsch ein. Die beiden Änderungen im umgebenden Repo committe ich nicht ungefragt.

## Verifikation

**Automatisiert**
- Server: pytest für Sync (doppelte Befehle, Konfliktfälle, ID-Vorrat), Anmeldung, Migrationen
- Druck: Etiketten-Rendering gegen Referenzbilder, Brother-QL-Datenstrom ohne Gerät, wiederholte und unterbrochene Aufträge
- Web: Typprüfung, Build, Vitest für Sync-Kern, Zonenlogik, MHD-Eingabe, Scan-Auswertung anhand von Beispielbildern

**Im Browser (ich, über die Vorschau)**
Anmelden, Zone und Produkt anlegen, gruppierte Liste und Chargen prüfen, löschen und wiederherstellen, Etikett als Bild ausgeben. Offline-Fall: Server stoppen, Änderungen machen, Server starten, Sync und Konfliktfall kontrollieren. Handy-Ansicht und Hell/Dunkel.

**Nur in eurer Umgebung prüfbar**
- Container-Bau und Start auf dem Debian-Server (`docker compose up -d --build`) hinter Nginx Proxy Manager – auf diesem PC ist kein Docker installiert
- Installation als App und Kamera-Scan auf Android und iPhone über die HTTPS-Adresse, auch mit kleinem QR-Code aus der Nähe
- Druck auf dem Brother QL; QR-Lesbarkeit und Haftung der Etiketten im Gefrierschrank
- Pi als Access Point, Verbinden beider Handys mit dem WLAN ohne Internet, Direktdruck vom Handy mit dem Pi-Zertifikat

Dockerfile, Compose-Datei und Pi-Skripte liefere ich deshalb ausdrücklich als „in der Zielumgebung ungetestet", zusammen mit einer Schritt-für-Schritt-Prüfliste.

## Risiken und offene Punkte

- **Pi-Zertifikat auf dem iPhone:** Es muss die IP-Adresse des Pi enthalten und darf höchstens 825 Tage gelten. Ob die auf dem Home-Bildschirm installierte App es akzeptiert, lässt sich nur am Gerät klären. Rückfall: Die App öffnet zum Drucken eine Seite des Pi im Browser.
- **Android 17:** Chrome braucht dort zusätzlich eine Systemerlaubnis für das lokale Netzwerk; am Gerät zu prüfen.
- **Versteckte SSID:** Apple rät davon ab, das automatische Verbinden wird unzuverlässig. Empfehlung: sichtbare SSID und ein WLAN-QR-Code am Kellereingang; „versteckt" bleibt als Option im Installationsskript.
- **Access Point auf dem Pi Zero W:** Der eingebaute Hotspot-Modus von Raspberry Pi OS hat offene Fehler, deshalb hostapd/dnsmasq. Die Stabilität zeigt erst der Betrieb.
- **Brother-Bibliothek:** `brother_ql_next` ist die einzige gepflegte Variante und hat nur einen Maintainer. Sie wird fest gepinnt und hinter einer eigenen Treiber-Schnittstelle gekapselt; Zebra/ZPL wäre der naheliegende zweite Treiber.
- **USB-Drucker direkt am Docker-Server:** möglich, aber nach dem Aus- und Einschalten des Druckers kann ein Neustart des Containers nötig sein. Empfohlen sind Netzwerkdrucker oder der Pi.
- **Entwurf als Bild:** Die Worker sehen dein Mockup nicht. Wenn du mir den Dateipfad nennst, bekommt der Oberflächen-Worker das Original statt meiner Beschreibung.
