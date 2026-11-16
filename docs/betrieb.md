# Betrieb

Anleitung für den Betreiber einer Stowly-Installation: starten, erreichbar machen, auf den Handys installieren, sichern, aktualisieren. Was Stowly ist und wie es aufgebaut ist, steht in [`../README.md`](../README.md) und [`plan-stufe-1.md`](plan-stufe-1.md).

> **Stand.** `Dockerfile`, `docker-compose.yml` und `docker-compose.usb.yml` sind auf dem Entwicklungsrechner **nicht gebaut und nicht gestartet** worden: Dort gibt es kein Docker. Auch Reverse Proxy, Zertifikate, Drucker und die Installation auf den Handys ließen sich nur beschreiben, nicht ausprobieren. Geprüft ist der Server selbst samt Druckdienst mit dem Bild-Treiber (automatische Tests und Durchläufe von Hand unter Windows, die Web-App mit eingeschalteter Content-Security-Policy im Browser). Alles Übrige prüft die [Prüfliste](#prüfliste-für-die-zielumgebung) am Ende; bitte beim ersten Aufsetzen Schritt für Schritt abhaken und Abweichungen melden. Aus Stufe 2 sind die automatische Sicherung, die Benachrichtigungen samt Tagesnachricht, die Zeitzone, der Abgleich mit Bring! über Home Assistant und der Sensor für Home Assistant bisher nur mit automatischen Tests geprüft (Testschlüssel für age, nachgebildete Push-Dienste, ein nachgebildetes Home Assistant, eingestellte Uhr); am Gerät, mit `age` und am echten Home Assistant prüfen sie D7 bis D13, I, J und K. Für den Raspberry Pi gibt es eine eigene Anleitung samt Prüfliste: [`../pi/README.md`](../pi/README.md). Am 14.11.2026 liefen Bau und Start erstmals in einer Zielumgebung, auf einer Synology mit DSM 6.2.4 (Abschnitt 4.4); was dort geprüft ist, steht in [`pruefliste.md`](pruefliste.md).

## 1. Überblick

- Stowly läuft als **ein Container mit einem Prozess**. Er liefert die Web-App und die Schnittstelle auf Port 8010 und spricht nur HTTP.
- **HTTPS stellt ein Reverse Proxy davor bereit.** Beschrieben sind zwei Wege: Nginx Proxy Manager mit eigener Zertifizierungsstelle (Abschnitt 4) und Tailscale (Abschnitt 5). Auf einer Synology übernimmt das der Reverse Proxy von DSM (Abschnitt 4.4).
- **Offline-Betrieb, Kamera und die Installation als App gehen nur über die HTTPS-Adresse** (Abschnitt 6).
- Alle Daten liegen in **einer SQLite-Datei** in einem Docker-Volume (Abschnitt 10).

## 2. Voraussetzungen

| Was | Wofür |
|---|---|
| Rechner mit Debian 13, ohne Bildschirm | Zielsystem; jedes Linux mit Docker sollte genauso gehen |
| Docker Engine mit Compose-Plugin (`docker compose version` zeigt Version 2 oder neuer) | Bau und Betrieb des Containers |
| Internet beim Bauen | lädt die Basis-Images und die Pakete von npm und PyPI (von PyPI nur Dateien, die auf Version und Prüfsumme festgelegt sind, Abschnitt 9.1) |
| etwa 1 GB Plattenplatz für den Bau, danach wenige hundert MB | Images; die Datenbank selbst bleibt klein |
| ein Reverse Proxy mit HTTPS: Nginx Proxy Manager **oder** Tailscale **oder** der von Synology DSM | siehe Abschnitte 4, 4.4 und 5 |
| im Betrieb optional Internet | für das Nachschlagen bei Open Food Facts und für Benachrichtigungen (die Push-Dienste von Apple, Google, Mozilla und Microsoft, Abschnitt 15) |
| für die automatische Sicherung: `age` auf einem eigenen Rechner | Schlüssel erzeugen und Sicherungen öffnen (Abschnitt 8.1); auf dem Server nicht nötig |
| optional Home Assistant mit der Integration Bring! | die Einkaufsliste in Bring! (Abschnitt 17) und der Sensor mit Ansage (Abschnitt 18) |

## 3. Start mit Docker Compose

Wie das Repository auf den Server kommt (ohne Remote): Abschnitt 12. Im Ordner des Repositorys auf dem Server:

```
cp .env.example .env
nano .env                      # STOWLY_PASSWORD setzen
docker compose up -d --build
```

Der erste Bau dauert einige Minuten (die Web-App wird im Image mitgebaut). Danach:

```
docker compose ps                              # Zustand "healthy" nach etwa 30 Sekunden
curl -s http://127.0.0.1:8010/api/health       # {"app":"stowly","status":"ok",...,"configured":true}
docker compose logs -f stowly                  # Meldungen des Servers
```

Die Einstellungen stehen in `.env` und sind dort beschrieben ([`.env.example`](../.env.example)):

| Variable | Bedeutung |
|---|---|
| `STOWLY_PASSWORD` | Haushalts-Passwort. **Pflicht.** Ohne Passwort startet der Server, aber niemand kann sich anmelden (`"configured": false`). |
| `STOWLY_OFF_ENABLED` | `1`: unbekannte Barcodes bei Open Food Facts nachschlagen (höchstens 10 Abfragen je Minute). `0`: nie. |
| `STOWLY_OFF_CONTACT` | freiwilliger Kontakt im `User-Agent` gegenüber Open Food Facts |
| `STOWLY_LOG_LEVEL` | `info` (Vorgabe), `debug`, `warning` … |
| `STOWLY_CSP` | Content-Security-Policy der Web-App: leer = vorsichtige Vorgabe, `off` = keine, sonst der angegebene Wert (Abschnitt 13) |
| `STOWLY_TIMEZONE` | Zeitzone für „heute" und alle Uhrzeiten, Vorgabe `Europe/Berlin` (Abschnitt 16) |
| `STOWLY_BACKUP_DIR`, `STOWLY_BACKUP_RECIPIENTS`, `STOWLY_BACKUP_TIME` | automatische, verschlüsselte Sicherung: Ordner im Container (`/backups`), öffentliche age-Schlüssel, Uhrzeit (Vorgabe `03:30`) (Abschnitt 8.1) |
| `STOWLY_PUSH_CONTACT` | Absender für Benachrichtigungen, `mailto:<Adresse>` oder eine `https://`-Adresse; leer = kein Push (Abschnitt 15) |
| `STOWLY_HA_URL`, `STOWLY_HA_TOKEN`, `STOWLY_HA_TODO_ENTITY`, `STOWLY_HA_CA` | Einkaufsliste nach Bring! über Home Assistant: Adresse, Token, To-do-Liste, eigene Zertifizierungsstelle; leer = kein Bring! (Abschnitt 17) |
| `STOWLY_HA_SUMMARY_TOKEN` | Token des Sensors für Home Assistant, mindestens 32 Zeichen; leer = kein Sensor (Abschnitt 18) |
| `STOWLY_PUBLISH` | unter welcher Adresse des Rechners der Container erreichbar ist; Vorgabe `127.0.0.1:8010` |
| `STOWLY_USB_GID` | nur mit `docker-compose.usb.yml`: Gruppe, der der USB-Drucker gehört; Vorgabe `46` (plugdev) (Abschnitt 14.3) |
| `TZ` | Zeitzone des Containers; Stowly selbst richtet sich nach `STOWLY_TIMEZONE` |

Hinweise:

- Enthält das Passwort Sonderzeichen (`#`, `$`, Leerzeichen, Anführungszeichen), in einfache Anführungszeichen setzen: `STOWLY_PASSWORD='mein#Passwort'`.
- Geänderte Werte gelten nach `docker compose up -d`.
- Ein geändertes Passwort lässt angemeldete Geräte angemeldet. Einzelne Geräte meldet man in der App unter „Einstellungen → Geräte" ab; das sperrt ihr Token.
- Nach 5 falschen Passwörtern innerhalb von 5 Minuten lehnt der Server 60 Sekunden lang jede Anmeldung ab, für alle gemeinsam.
- Der Container läuft als eigener Benutzer ohne Rechte (UID 10001). Wer statt des Volumes einen Ordner des Rechners einhängt (`./data:/data`), muss ihn diesem Benutzer geben: `sudo chown 10001:10001 data`. Dasselbe gilt für den Ordner der Sicherungen (Abschnitt 8.1).
- Jeder Wert wird beim Start geprüft. Ein Fehler beendet den Start mit „Konfigurationsfehler: …" und dem Namen der Variable (`docker compose logs stowly`); der Wert eines Tokens steht nie darin. Ist nur ein Teil einer Integration gesetzt (etwa der Ordner der Sicherung ohne Schlüssel), startet der Server, schreibt eine Warnung ins Log, und die App nennt den Grund unter „Einstellungen".

## 4. Nginx Proxy Manager mit eigener Zertifizierungsstelle

Ziel: Die App ist im Heimnetz unter `https://stowly.home` erreichbar, mit einem Zertifikat der eigenen Zertifizierungsstelle, der die Geräte bereits vertrauen.

### 4.1 Name: Pi-hole

In Pi-hole unter „Local DNS → DNS Records" einen Eintrag anlegen: `stowly.home` → IP-Adresse des Rechners, auf dem **Nginx Proxy Manager** läuft. Die Handys müssen Pi-hole als DNS-Server benutzen (üblicherweise über DHCP des Routers).

Löst ein Handy den Namen nicht auf:

- Android: „Privates DNS" auf „Automatisch" oder „Aus" stellen. Ein fest eingetragener Anbieter umgeht Pi-hole.
- iPhone: für dieses WLAN „IP-Adress-Tracking beschränken" bzw. iCloud Privat-Relay prüfen.

### 4.2 Zertifikat

Mit der eigenen Zertifizierungsstelle ein Serverzertifikat für `stowly.home` ausstellen. Damit auch das iPhone es annimmt:

- der Name steht als **Subject Alternative Name** (`DNS:stowly.home`); der Common Name allein genügt nicht,
- erweiterte Schlüsselverwendung `serverAuth`,
- Gültigkeit **höchstens 825 Tage**,
- RSA mit mindestens 2048 Bit oder ECDSA, Signatur mit SHA-256.

In Nginx Proxy Manager unter „SSL Certificates → Add SSL Certificate → Custom" Zertifikat und Schlüssel hochladen (ein Zwischenzertifikat, falls es eines gibt, dazu).

Das Wurzelzertifikat muss auf jedem Handy installiert sein:

- Android: Einstellungen → Sicherheit → Verschlüsselung und Anmeldedaten → Zertifikat installieren → CA-Zertifikat.
- iPhone: Zertifikat öffnen (Mail, AirDrop, Download in Safari) → Einstellungen → „Profil geladen" → Installieren. Danach **zusätzlich** Einstellungen → Allgemein → Info → Zertifikatsvertrauenseinstellungen → volles Vertrauen für das Wurzelzertifikat einschalten.
- Eine Warnung „Diese Verbindung ist nicht privat" in Safari nicht mit „Website trotzdem besuchen" wegklicken: Dann wirkt die Seite erreichbar, die App aber meldet „Server nicht erreichbar". Die Warnung heißt fast immer, dass der Schalter oben fehlt.

### 4.3 Proxy Host

In Nginx Proxy Manager unter „Hosts → Proxy Hosts → Add Proxy Host":

| Feld | Wert |
|---|---|
| Domain Names | `stowly.home` |
| Scheme | `http` |
| Forward Hostname / IP, Forward Port | siehe unten; Port `8010` |
| **Cache Assets** | **aus** |
| Block Common Exploits | nach Belieben |
| Websockets Support | nicht nötig |
| SSL → SSL Certificate | das Zertifikat aus 4.2 |
| SSL → Force SSL, HTTP/2 Support | an |

**„Cache Assets" muss aus bleiben.** Die Option speichert Skripte im Proxy zwischen und entfernt die `Cache-Control`-Angaben des Servers. Der Service Worker (`/sw.js`) käme dann verspätet auf die Geräte, und eine neue Version der App bliebe hängen.

Wohin der Proxy weiterleitet, hängt davon ab, wo er läuft:

| Nginx Proxy Manager läuft … | Forward Hostname / IP | zusätzlich |
|---|---|---|
| als Container **auf demselben Rechner** (der übliche Fall) | `stowly` | gemeinsames Docker-Netz, siehe unten |
| auf demselben Rechner mit `network_mode: host` oder ohne Docker | `127.0.0.1` | nichts |
| auf einem **anderen** Rechner | IP-Adresse des Stowly-Rechners | in `.env`: `STOWLY_PUBLISH=8010`; Port 8010 in der Firewall auf den Proxy beschränken |

Ein Container erreicht `127.0.0.1` des Rechners nicht. Läuft Nginx Proxy Manager als Container auf demselben Rechner, bekommt Stowly deshalb Zugang zu dessen Netz. Den Namen des Netzes zeigt

```
docker inspect <Name des NPM-Containers> --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}'
```

Damit neben `docker-compose.yml` eine Datei `docker-compose.override.yml` anlegen; Compose liest sie von selbst mit, und ein späteres `git pull` überschreibt sie nicht:

```yaml
services:
  stowly:
    networks:
      - proxy

networks:
  proxy:
    external: true
    name: <Name des Netzes von Nginx Proxy Manager>
```

Danach `docker compose up -d`. Im Proxy Host steht dann `stowly` als Forward Hostname.

Probe von einem Rechner im Heimnetz: `https://stowly.home/api/health` zeigt `"app":"stowly"`, ohne Zertifikatswarnung.

### 4.4 Synology DSM

Erprobt am 14.11.2026 auf DSM 6.2.4 (Docker 20.10.3, `docker-compose` 1.28.5, Kernel 3.10 ohne seccomp) mit einer FRITZ!Box als DNS-Server im Heimnetz. `docker-compose.yml` bleibt unverändert; HTTPS übernimmt der Reverse Proxy von DSM, Nginx Proxy Manager braucht es nicht. Die Images (Debian 13) laufen auch auf dem alten Kernel.

**Dateien auf das NAS** ohne Git: der vierte Weg aus Abschnitt 12 (`git archive`).

**Bauen und starten** per SSH im Ordner der Dateien. `docker-compose` liegt unter `/usr/local/bin`, und das fehlt `sudo` im Suchpfad. Compose ruft zum Bauen `docker` auf und bräche sonst mit „No such file or directory: 'docker'" ab:

```
sudo env PATH="/usr/local/bin:$PATH" /usr/local/bin/docker-compose up -d --build
```

Hakt die Internetverbindung des NAS, bricht pip im Bau mit `ReadTimeoutError` bei `files.pythonhosted.org` ab. Dann den Befehl einfach noch einmal starten: Fertige Schritte nimmt Docker aus dem Zwischenspeicher.

**Adresse ohne eigenen DNS-Server.** Eine FRITZ!Box löst keine eigenen Namen wie `stowly.home` auf, nur Gerätenamen unter `.fritz.box`. Ohne Pi-hole oder einen anderen eigenen DNS-Server nimmt man die feste IP-Adresse des NAS mit einem freien Port, etwa `https://<IP des NAS>:8443`. Das Zertifikat trägt dann die IP-Adresse als Subject Alternative Name. Ausstellen lässt es sich mit der Zertifizierungsstelle des Pi; vertraut ihr das Handy schon, braucht es kein weiteres Profil:

```
bash pi/make-cert.sh issue --ip <IP des NAS> --key-type rsa \
  --ca-cert stowly-zertifikat/stowly-ca.crt --ca-key stowly-zertifikat/stowly-ca.key \
  --out stowly-zertifikat/nas
```

Die Dateien heißen auch hier `pi.crt` und `pi.key`. Die IP-Adresse des NAS muss fest sein. Wechselt sie, passt das Zertifikat nicht mehr, und mit der Adresse wechselt der Speicher der App (Abschnitt 6): Sie muss auf jedem Handy neu installiert werden.

**In DSM 6.2** (in DSM 7 heißen die Stellen ähnlich):

1. Systemsteuerung → Sicherheit → Zertifikat → Hinzufügen → „Neues Zertifikat hinzufügen" → „Zertifikat importieren", **nicht** als Standardzertifikat festlegen. Privater Schlüssel `pi.key`, Zertifikat `pi.crt`, kein Zwischenzertifikat. Lehnt DSM den Schlüssel ab, ihn mit `openssl rsa -in pi.key -traditional -out pi-rsa.key` umwandeln und `pi-rsa.key` nehmen.
2. Systemsteuerung → Anwendungsportal → Reverse Proxy → Erstellen: Quelle `HTTPS`, Hostname `*`, Port `8443`; Ziel `HTTP`, Hostname `127.0.0.1`, Port `8010`. HSTS aus, keine eigenen Kopfzeilen. `127.0.0.1` statt `localhost`, denn der Container ist nur über IPv4 erreichbar.
3. Sicherheit → Zertifikat → Konfigurieren: beim Eintrag für Port 8443 das importierte Zertifikat wählen.

DSM reicht `Cache-Control` und `Content-Security-Policy` unverändert durch, begrenzt die Größe von Anfragen nicht und wartet 60 Sekunden auf eine Antwort; das genügt Stowly.

Dazu:

- **Druckdienst:** Der Pi muss die neue Adresse als Ursprung kennen: `https://<IP des NAS>:8443` in `origins` (`pi/README.md`, Abschnitt „Konfiguration"), danach `sudo systemctl restart stowly-print`.
- **Passwort sichtbar:** Die Docker-App von DSM zeigt beim Container alle Umgebungsvariablen an, auch `STOWLY_PASSWORD`. Dieses Fenster nicht abfotografieren oder weitergeben.
- **Noch nicht erprobt:** der Ordner `./backups` der automatischen Sicherung auf einer Freigabe von DSM. Dort entscheidet die Windows-ACL der Freigabe über den Zugriff, nicht allein `chown 10001:10001` (Abschnitt 8.1).

## 5. Tailscale

Die Alternative ohne eigene Zertifizierungsstelle: Tailscale stellt den Namen und ein öffentlich gültiges Zertifikat. Die App ist dann auf allen Geräten des eigenen Tailnets erreichbar, zu Hause wie unterwegs, und nirgends sonst.

1. Tailscale auf dem Stowly-Rechner installieren und anmelden (`tailscale up`).
2. In der Verwaltung von Tailscale **MagicDNS** und **HTTPS-Zertifikate** einschalten.
3. Auf dem Stowly-Rechner:

   ```
   sudo tailscale serve --bg 8010
   tailscale serve status
   ```

   Das veröffentlicht `http://127.0.0.1:8010` als `https://<rechnername>.<tailnet>.ts.net` innerhalb des Tailnets. `STOWLY_PUBLISH` bleibt bei der Vorgabe. (Die Schreibweise von `tailscale serve` hat sich über die Versionen geändert; im Zweifel `tailscale serve --help`.)
4. Auf jedem Handy die Tailscale-App installieren und im selben Tailnet anmelden.

**Nicht** `tailscale funnel` verwenden: Das stellte Stowly ins offene Internet. Dafür ist die Anmeldung mit einem einzigen Haushalts-Passwort nicht gedacht.

## 6. Warum nur die HTTPS-Adresse zählt

Browser erlauben eine Reihe von Funktionen nur in einem „sicheren Kontext", also über HTTPS. Für Stowly sind das genau die wichtigen:

- **Service Worker**: ohne ihn keine App ohne Netz, keine Installation, kein Abgleich im Hintergrund,
- **Kamera**: ohne sie kein Scannen,
- dauerhafter Speicher für die lokale Kopie, „Bildschirm wach halten" und die eingebaute Barcode-Erkennung.

Über `http://<IP-Adresse>:8010` läuft Stowly deshalb nur als gewöhnliche Online-Webseite: Bestand ansehen und bearbeiten geht, Scannen und Arbeiten ohne Netz nicht. Das taugt für eine schnelle Probe am Rechner, nicht für den Alltag. Auf den Handys immer die HTTPS-Adresse verwenden, und immer **dieselbe**: Jede Adresse hat im Browser ihren eigenen Speicher, also ihre eigene lokale Kopie und ihre eigene Anmeldung.

## 7. Installation als App

Auf jedem Handy einmal. Danach meldet sich das Gerät mit dem Haushalts-Passwort an und gibt sich einen Namen (etwa „Handy Küche"); unter diesem Namen erscheint es in der Geräteliste.

**Android (Chrome)**

1. `https://stowly.home` (oder die Tailscale-Adresse) in Chrome öffnen. Es darf keine Zertifikatswarnung erscheinen.
2. Menü ⋮ → „App installieren" (je nach Version „Zum Startbildschirm hinzufügen") → Installieren.
3. Stowly vom Startbildschirm öffnen, anmelden, beim ersten Scannen den Zugriff auf die Kamera erlauben.

**iPhone (Safari)**

1. Die Adresse in **Safari** öffnen (nicht in einem anderen Browser).
2. Teilen-Symbol → „Zum Home-Bildschirm" → Hinzufügen.
3. Stowly **vom Home-Bildschirm** öffnen und dort anmelden. Die installierte App hat einen eigenen Speicher: Eine Anmeldung in Safari gilt für sie nicht.
4. Beim ersten Scannen den Zugriff auf die Kamera erlauben.

Auf dem iPhone ist die Installation nötig: Safari löscht die lokalen Daten einer Webseite, die sieben Tage lang nicht besucht wurde. Apps auf dem Home-Bildschirm sind davon ausgenommen.

## 8. Sicherung

Es gibt zwei Arten, beide eine vollständige, in sich stimmige Kopie der Datenbank, gezogen bei laufendem Betrieb:

- die **automatische, verschlüsselte Sicherung** jede Nacht in den Ordner `./backups` auf dem Server (8.1),
- die **Sicherung zum Herunterladen** in der App (8.2).

Beide enthalten den ganzen Haushalt: Bestand, Lösch-Historie, Einkaufsliste, Ereignisprotokoll, Produktbilder, die Liste der Geräte (ohne deren Tokens, nur Prüfsummen), die Zugangsdaten eingerichteter Drucker und den Schlüssel des Servers für Benachrichtigungen. Zurückspielen: 8.3.

### 8.1 Automatische, verschlüsselte Sicherung

Jeden Tag zur Uhrzeit `STOWLY_BACKUP_TIME` (Vorgabe `03:30`, in `STOWLY_TIMEZONE`) legt der Server eine Datei `stowly-JJJJ-MM-TT-HHMM.sqlite3.gz.age` in den Ordner: gepackt und im Format [age](https://age-encryption.org) an **öffentliche Schlüssel** verschlüsselt. Den passenden privaten Schlüssel hat nur der Betreiber; wer Server oder Ordner erbeutet, kann die Sicherungen nicht lesen.

- **Aufbewahrung:** die Sicherungen der 7 neuesten Tage, der 4 neuesten Wochen und der 12 neuesten Monate (gezählt werden Tage, Wochen und Monate, *an denen* es eine gibt; nach einem langen Ausfall bleiben also die letzten erhalten). Aufgeräumt wird nur nach einer gelungenen Sicherung und nur unter den eigenen Dateien; andere Dateien im Ordner fasst der Server nie an.
- **Nachholen:** War der Server zur Uhrzeit aus, macht er die Sicherung gleich nach dem Start, auch abends. Scheitert sie, versucht er es jede Stunde wieder, bis eine des Tages gelingt.
- **Kein Klartext im Ordner:** Der Server schreibt in eine Zwischendatei (`.stowly-backup-….tmp`, schon verschlüsselt, Rechte `0600`) und benennt sie erst um, wenn sie vollständig auf der Platte steht.
- **In der App** unter „Einstellungen → Sicherung": letzte gelungene Sicherung, Größe, die Schlüssel (gekürzt), der nächste Versuch und ein Fehler, falls es einen gab. Nach 48 Stunden ohne gelungene Sicherung warnt die App.

**Einrichten**

1. Auf einem **eigenen Rechner**, nicht auf dem Server: `age` installieren (Debian `sudo apt install age`, macOS `brew install age`; für Windows nennt die Seite des Projekts die Wege) und zwei Schlüssel erzeugen:

   ```
   age-keygen -o stowly-schluessel-1.txt
   age-keygen -o stowly-schluessel-2.txt
   ```

   Jeder Aufruf zeigt den öffentlichen Schlüssel (`Public key: age1…`); er steht auch in der Datei. **Mehrere Schlüssel sind empfohlen**, etwa einer im Passwortmanager und einer ausgedruckt an einem anderen Ort: Jeder öffnet jede Sicherung allein. Geht jeder private Schlüssel verloren, sind alle Sicherungen wertlos. Die Dateien mit den privaten Schlüsseln (`AGE-SECRET-KEY-1…`) gehören **nie** auf den Server; trägt jemand einen privaten Schlüssel in `STOWLY_BACKUP_RECIPIENTS` ein, verweigert der Server den Start.
2. In `.env` die öffentlichen Schlüssel eintragen, getrennt durch Komma oder Leerzeichen (`STOWLY_BACKUP_DIR=/backups` steht schon in `.env.example`):

   ```
   STOWLY_BACKUP_DIR=/backups
   STOWLY_BACKUP_RECIPIENTS=age1…,age1…
   ```
3. Den Ordner im Ordner des Repositorys anlegen und dem Benutzer des Containers geben (`docker-compose.yml` legt `./backups` nach `/backups`). Den Ordner legt der Server nicht selbst an: Er läge sonst womöglich im Container statt auf der Platte des Rechners.

   ```
   mkdir -p backups
   sudo chown 10001:10001 backups
   sudo chmod 700 backups
   ```
4. `docker compose up -d`, dann `docker compose logs stowly`: „Automatische Sicherung täglich um 03:30 nach /backups an 2 Schlüssel." Ist die Uhrzeit heute schon vorbei, folgt gleich „Sicherung geschrieben: stowly-….sqlite3.gz.age (… Byte, 2 Schlüssel)".

**Probe-Entschlüsselung:** einmal nach dem Einrichten und dann ab und zu, **mit jedem privaten Schlüssel**. Auf dem eigenen Rechner:

```
scp <benutzer>@<server>:~/stowly/backups/stowly-2026-11-14-0330.sqlite3.gz.age .
age -d -i stowly-schluessel-1.txt stowly-2026-11-14-0330.sqlite3.gz.age | gunzip | head -c 15
age -d -i stowly-schluessel-2.txt stowly-2026-11-14-0330.sqlite3.gz.age | gunzip | head -c 15
```

Beide Male muss `SQLite format 3` erscheinen. Gründlicher, mit dem Programm `sqlite3`: `age -d -i stowly-schluessel-1.txt stowly-….sqlite3.gz.age | gunzip > probe.sqlite3`, dann `sqlite3 probe.sqlite3 "PRAGMA integrity_check; SELECT COUNT(*) FROM packages;"` (zeigt `ok` und die Zahl der Packungen); `probe.sqlite3` danach löschen.

**Ein Ordner auf derselben Platte ersetzt keine Kopie außer Haus.** Er hilft gegen Fehlbedienung und kaputte Daten, nicht gegen einen Plattenschaden, Diebstahl, Brand oder einen Fehler, der den ganzen Rechner trifft. Die Dateien deshalb regelmäßig an einen anderen Ort kopieren (anderer Rechner, externe Platte, auch ein Cloud-Speicher: Sie sind verschlüsselt), etwa mit `rsync -a <benutzer>@<server>:~/stowly/backups/ /pfad/zur/kopie/`.

Meldet die App „Der Ordner für Sicherungen fehlt." oder „Der Ordner für Sicherungen ist nicht beschreibbar (Benutzer 10001).", stimmen Schritt 3 oder die Einbindung in `docker-compose.yml` nicht; der nächste Versuch kommt nach einer Stunde von selbst.

### 8.2 Sicherung zum Herunterladen

In der App unter „Einstellungen → Sicherung": eine Datei `stowly-JJJJ-MM-TT.sqlite3` (Tag in `STOWLY_TIMEZONE`), **unverschlüsselt**. Entsprechend aufbewahren. Sie bleibt neben der automatischen Sicherung bestehen, etwa für eine schnelle Kopie vor jedem Aktualisieren.

### 8.3 Zurückspielen

Eine automatische Sicherung wird zuerst auf dem eigenen Rechner entschlüsselt und entpackt; danach ist sie eine Datei wie die zum Herunterladen:

```
age -d -i stowly-schluessel-1.txt stowly-2026-11-14-0330.sqlite3.gz.age | gunzip > stowly-2026-11-14.sqlite3
```

**Wieder einspielen:** Server anhalten, Datei ersetzen, starten. Wer den jetzigen Stand noch brauchen könnte, zieht vorher auch davon eine Sicherung.

```
docker compose stop
docker compose run --rm -T --no-deps stowly sh -c \
  'rm -f /data/stowly.sqlite3-wal /data/stowly.sqlite3-shm && cat > /data/stowly.sqlite3' \
  < stowly-2026-11-13.sqlite3
docker compose up -d
```

Der mittlere Befehl schreibt die Datei als der Benutzer des Containers ins Volume; so stimmen die Rechte. Was danach geschieht:

- Der Server erkennt an der Kennung des Datenbestands, dass er einen anderen Stand hat. **Alle Geräte holen den Bestand beim nächsten Abgleich von selbst vollständig neu.** Auf den Handys ist nichts zu tun.
- Änderungen, die ein Gerät noch nicht abgeglichen hatte, sendet es erneut. Was schon in der Sicherung steckt, erkennt der Server und führt es nicht doppelt aus.
- Was nach der Sicherung geschah und schon abgeglichen war, ist weg: Das ist der Sinn des Zurückspielens.
- Geräte, die erst nach der Sicherung angemeldet wurden, kennt der eingespielte Stand nicht. Sie melden sich neu an; ihre lokalen Daten und ungesendeten Änderungen bleiben dabei erhalten.
- Der Schlüssel des Servers für Benachrichtigungen kommt mit. Abos für Benachrichtigungen, die nach der Sicherung entstanden sind, fehlen; die App meldet sich beim nächsten Start von selbst neu an.

**Andere Kopien der Datenbank** (Schnappschuss des Volumes, Kopie der Datei bei angehaltenem Server, Sicherung des ganzen Rechners) lassen sich genauso zurückspielen, brauchen aber einen Schritt mehr. Nur die beiden Sicherungen von Stowly (8.1 und 8.2) tragen von sich aus eine neue Kennung des Datenbestands. Jede andere Kopie trägt die alte, und die Geräte bemerkten das Zurückspielen nicht zuverlässig: Sie behielten Packungen, die es auf dem Server nicht mehr gibt. Deshalb nach dem Zurückspielen einer solchen Kopie, vor dem Start:

```
docker compose run --rm --no-deps stowly python -m stowly --new-dataset
docker compose up -d
```

Der Befehl gibt dem Datenbestand eine neue Kennung und endet. Danach verhält sich alles wie oben beschrieben.

## 9. Aktualisieren

Läuft Stowly mit dem fertigen Image von GitHub, geht ein Update per Knopf in der App (9.2) oder von Hand mit `docker compose pull` (9.3). Wer selbst baut:

```
# vorher eine Sicherung herunterladen (Abschnitt 8)
git pull                       # neuen Stand holen; ohne Remote siehe Abschnitt 12
docker compose up -d --build
docker compose logs --tail 50 stowly
```

- Die Datenbank bringt der Server beim Start selbst auf den neuen Stand (Migrationen).
- Zurück auf eine ältere Version geht nicht mit einer neueren Datenbank: Der Server verweigert dann den Start mit einer Meldung. Dafür ist die Sicherung von vorher da.
- Die Web-App auf den Handys aktualisiert sich selbst, sobald sie den Server das nächste Mal erreicht. Passen App und Server einmal nicht zusammen, fordert die App zum Aktualisieren auf; ungesendete Änderungen bleiben erhalten.

Alte Images räumt `docker image prune` weg.

### 9.1 Python-Pakete im Image, Abhängigkeiten erneuern

Das Image installiert die Python-Pakete aus zwei Dateien, in denen jede Datei von PyPI auf Version und Prüfsumme festgelegt ist: `server/requirements.lock` (alles, was Server und Druckdienst zur Laufzeit brauchen, dazu setuptools für den Bau) und `print/requirements-brother.txt` (die Brother-Bibliothek). pip löst dabei nichts auf und lädt nichts ungeprüft nach; weicht eine Datei auf PyPI von ihrer Prüfsumme ab, bricht der Bau ab. Ein Bau in einem Jahr bekommt so dieselben Versionen wie heute, und es sind die, mit denen die Tests liefen. Neuere Versionen kommen nur mit einer neuen Sperrdatei ins Repository. Der Raspberry Pi nimmt Pillow, Starlette und uvicorn aus Debian; für ihn gilt nur `print/requirements-brother.txt` ([`../pi/README.md`](../pi/README.md)).

**Abhängigkeiten erneuern** am Entwicklungsrechner (dieselbe Anleitung steht am Kopf von `server/requirements.lock`):

1. Die gewünschten Versionen in der Entwicklungsumgebung einspielen, etwa `python -m pip install -U -e "./print[dev]" -e "./server[dev]"`, und alle Prüfungen laufen lassen: `python -m pytest` in `server` und `print`, `npm run test:e2e` in `web`.
2. Im Ordner `server`: `python tests/test_requirements_lock.py`. Das schreibt `requirements.lock` neu: Pakete und Versionen aus den Metadaten der Umgebung, die Prüfsummen aller Dateien jeder Version von PyPI.
3. `git diff server/requirements.lock` lesen (neue Pakete, neue Versionen, Lizenzen), dann `python -m pytest tests/test_requirements_lock.py` und das Image bauen (Prüfliste F1).

Wer eine Abhängigkeit ergänzt oder aktualisiert und die Sperrdatei vergisst, merkt es an `server/tests/test_requirements_lock.py`: Der Test nennt, was fehlt oder abweicht. `print/requirements-brother.txt` wird von Hand gepflegt (Versionen und Prüfsummen aus `https://pypi.org/pypi/<name>/<version>/json`); der Test prüft, dass der Brother-Bibliothek zusammen mit der Sperrdatei nichts fehlt.

### 9.2 Über GitHub, per Knopf in der App

Stowly erscheint als fertiges Image auf GitHub: `ghcr.io/<konto>/stowly:X.Y.Z`. Der Server merkt selbst, wenn eine neue Version als „latest" veröffentlicht ist. Die App zeigt sie unter Einstellungen → „Aktualisierung" samt Änderungen, und je Version kommt einmal eine Push-Nachricht. Ein Tipp auf „Update installieren" legt eine Anforderung ab. Ausgeführt wird sie vom **Updater** auf dem Rechner, denn der Server selbst darf Docker nicht bedienen. Regeln und Dateien: [`integrationen.md`](integrationen.md), Abschnitt 10.

**Einmal einrichten:**

1. In der `.env`:

   ```
   STOWLY_UPDATE_REPO=<konto>/stowly
   STOWLY_IMAGE=ghcr.io/<konto>/stowly
   STOWLY_VERSION=0.2.0
   ```

   `STOWLY_VERSION` ist die Version, die gerade laufen soll; der Updater stellt sie danach selbst um.
2. Auf das fertige Image umstellen (statt zu bauen): `docker compose pull`, dann `docker compose up -d`, ohne `--build`.
3. Den Updater als **root** jede Minute starten lassen. Er tut nur etwas, wenn in der App jemand „Installieren" getippt hat; sonst meldet er sich nur beim Server.
   - **Synology DSM:** Systemsteuerung → Aufgabenplaner → Erstellen → Geplante Aufgabe → Benutzerdefiniertes Skript.
     - Reiter „Allgemein": Benutzer `root`.
     - Reiter „Zeitplan": täglich, „Innerhalb desselben Tages fortsetzen", alle 1 Minute (gibt es das nicht, alle 5 Minuten), bis 23:59.
     - Reiter „Aufgabeneinstellungen": `sh /volume1/…/stowly/updater/stowly-update.sh`, mit dem Pfad des Projektordners.
   - **Debian:** ein systemd-Timer, jede Minute:

     ```
     # /etc/systemd/system/stowly-update.service
     [Service]
     Type=oneshot
     ExecStart=/bin/sh /home/<benutzer>/stowly/updater/stowly-update.sh

     # /etc/systemd/system/stowly-update.timer
     [Timer]
     OnBootSec=1min
     OnUnitActiveSec=1min
     [Install]
     WantedBy=timers.target
     ```

     Danach `sudo systemctl daemon-reload && sudo systemctl enable --now stowly-update.timer`.
4. Probe: Nach spätestens einer Minute zeigt die App unter „Aktualisierung", dass sich der Updater meldet.

**Was beim Update geschieht** (etwa ein bis zwei Minuten):
- Der Updater lädt das neue Image; scheitert das, läuft die alte Version unverändert weiter.
- Er hält Stowly an und legt eine Kopie der Datenbank in `update/` im Datenvolume ab (`before-<alt>-<zeit>.sqlite3`; die drei neuesten bleiben).
- Er stellt `STOWLY_VERSION` in der `.env` um (vorher `.env.bak`) und startet. Wird der Container binnen drei Minuten nicht „healthy", spielt er die Kopie zurück und startet die alte Version.
- Das Ergebnis zeigt die App, die Einzelheiten stehen in `update/log` im Datenvolume. Die Web-App auf den Handys kommt danach wie immer über „Jetzt aktualisieren".

**Grenzen:**
- Der Updater tauscht nur das Image. Ändert eine Version `docker-compose.yml`, die `.env` oder den Updater selbst, steht das im Changelog unter „Von Hand" und wird einmal von Hand nachgezogen.
- Der Updater läuft als root aus dem Projektordner: Wer diesen Ordner ändern darf, kann darüber Befehle als root ausführen. Der Ordner gehört deshalb nur Administratoren.
- Die Docker-Oberfläche von DSM nicht zum Ändern des Containers benutzen. Compose und der Updater sind dann nicht mehr im Bilde.

### 9.3 Von Hand, mit dem fertigen Image

Ohne Updater, oder wenn er streikt: eine Sicherung herunterladen (Abschnitt 8), `STOWLY_VERSION` in der `.env` auf die neue Version setzen, dann

```
docker compose pull
docker compose up -d
docker compose logs --tail 50 stowly
```

Zurück geht es nur mit der Sicherung von vorher (siehe oben), denn eine ältere Version startet nicht mit einer neueren Datenbank.

### 9.4 Eine neue Version veröffentlichen

Am Entwicklungsrechner, im Repository:

1. In `CHANGELOG.md` einen Abschnitt `## X.Y.Z` schreiben. Muss beim Umstieg etwas von Hand geschehen, kommt es dort unter „Von Hand".
2. `python scripts/release.py X.Y.Z` setzt die Nummer an allen Stellen. Danach alle Prüfungen laufen lassen, committen („Version X.Y.Z") und das Tag setzen: `git tag vX.Y.Z`.
3. `git push` und `git push origin vX.Y.Z`. GitHub Actions (`.github/workflows/release.yml`) testet, baut das Image ohne die Brother-Bibliothek, lädt es hoch und veröffentlicht danach das Release als „latest". Erst dann sieht es der Server.

Ein Tag mit Zusatz (`vX.Y.Z-rc.1`) durchläuft dasselbe als Vorabversion: Das Image heißt `:X.Y.Z-rc.1`, es gibt kein `:latest`, und das Release ist als Vorabversion markiert. Der Server bietet es nicht an; so lässt sich die Pipeline gefahrlos ausprobieren.

Beim allerersten Image muss das Paket auf GitHub einmal öffentlich gestellt werden (Paket `stowly` → Package settings → Change visibility → Public). Sonst kann der Rechner es nicht ohne Anmeldung laden.

## 10. Wo die Daten liegen

| Was | Wo |
|---|---|
| Datenbank mit allem: Bestand, Einkaufsliste, Produktbilder, Geräte und ihre Abos für Benachrichtigungen, Ereignisprotokoll, der Schlüssel des Servers für Benachrichtigungen, was Stowly zuletzt nach Bring! geschrieben hat (ohne Token) | Docker-Volume `stowly-data`, im Container `/data/stowly.sqlite3` (im Betrieb dazu `-wal` und `-shm`) |
| Druckdienst des Servers: Auftragsspeicher samt `boot_id`, Bilder des Bild-Treibers | im selben Volume unter `/data/print/` (`jobs.sqlite3`, `images/`). Nicht in den Sicherungen; geht er verloren, fragt die App bei offenen Etiketten nach, statt doppelt zu drucken |
| automatische Sicherungen, verschlüsselt | Ordner `backups` im Ordner des Repositorys, im Container `/backups` (Abschnitt 8.1); die privaten Schlüssel dazu nur beim Betreiber |
| Einstellungen des Servers samt Passwort und Tokens (auch die für Home Assistant und den Sensor) | `.env` im Ordner des Repositorys |
| eigene Anpassung an den Proxy, die Zertifizierungsstelle für Home Assistant | `docker-compose.override.yml`, falls angelegt; die Zertifizierungsstelle etwa als `ha-ca.pem` im Ordner des Repositorys (Abschnitt 17.4) |
| lokale Kopie je Gerät, ungesendete Änderungen, Token | im Browser-Speicher des Handys (IndexedDB) |

Das Volume findet `docker volume inspect <ordnername>_stowly-data` (unter Debian üblicherweise `/var/lib/docker/volumes/…/_data`). `docker compose down` lässt es bestehen; erst `docker compose down -v` löscht es und damit den ganzen Haushalt.

Im Log des Servers (`docker compose logs stowly`) stehen Zugriffe und Hinweise, nie Passwort oder Tokens.

## 11. Wenn etwas nicht geht

| Beobachtung | Wahrscheinliche Ursache |
|---|---|
| `/api/health` zeigt `"configured": false`; die App meldet, dass kein Passwort gesetzt ist | `STOWLY_PASSWORD` in `.env` ist leer. Setzen, dann `docker compose up -d`. |
| `docker compose up` bricht ab: „env file … not found" | `.env` fehlt: `cp .env.example .env` |
| Die Startseite zeigt „die Web-App ist noch nicht gebaut" (Status 503) | Die Web-App fehlt im Image: Der Bau der ersten Stufe ist gescheitert oder `STOWLY_WEB_DIR` wurde verstellt. |
| Der Proxy meldet „502 Bad Gateway" | Er erreicht den Container nicht: Tabelle in Abschnitt 4.3 (gemeinsames Netz oder `STOWLY_PUBLISH`). |
| Zertifikatswarnung auf dem Handy | Wurzelzertifikat nicht installiert, auf dem iPhone das volle Vertrauen nicht eingeschaltet, oder dem Zertifikat fehlt der Subject Alternative Name. |
| Die App meldet, der Server sei nicht erreichbar, obwohl die Adresse im Browser aufgeht | Der Proxy liefert unter `/api/health` etwas anderes als Stowly; Probe B3. |
| Scannen fehlt oder die App lässt sich nicht installieren | Die App läuft über `http://` statt über die HTTPS-Adresse (Abschnitt 6). |
| Eine neue Version kommt nicht auf den Handys an | „Cache Assets" im Proxy ist an; Probe B4. |
| Gescannte Produkte bleiben ohne Namen | Der Container kommt nicht ins Internet, oder Open Food Facts kennt den Barcode nicht; Probe A14. Der Name lässt sich immer von Hand eintragen. |
| Nach dem Zurückspielen: Fehler „readonly database" im Log | Die Datei gehört nicht dem Benutzer des Containers. Nach Abschnitt 8 einspielen oder `chown 10001:10001` auf die Datei im Volume. |
| Die Anmeldung wird trotz richtigem Passwort abgelehnt (zu viele Fehlversuche) | Sperre nach 5 falschen Passwörtern; 60 Sekunden warten. |
| Etiketten für einen Drucker am Server bleiben „ausstehend" | Sagt die App „Der Druckdienst des Servers läuft nicht": Im Log steht „Der Druckdienst des Servers ließ sich nicht starten", meist ist `/data/print` nicht beschreibbar (`docker compose exec stowly ls -ld /data/print`); `/print/…` antwortet dann mit 503. Sonst ist das Etikett noch nicht abgeglichen; die App versucht es nach dem nächsten Abgleich wieder („Jetzt drucken" gleicht vorher ab). |
| Im Log „Schrift DejaVuSans… fehlt" | Die Etiketten entstehen mit einer Ersatzschrift ohne Umlaute. Die Schriften liegen im Paket `stowly_print` (Ordner `fonts`) und im Image zusätzlich als `fonts-dejavu-core`; fehlen sie an beiden Stellen, ist die Installation unvollständig: Image neu bauen (`docker compose build --no-cache`), ohne Docker `sudo apt install fonts-dejavu-core` und den Server neu starten. |
| Ein Brother am Server meldet `config` | Modell, Adresse oder Rolle passen nicht, oder die Brother-Bibliothek fehlt; Grund im Log (Abschnitt 14). |
| Der Container startet nicht; im Log „Konfigurationsfehler: STOWLY_…" | Ein Wert in `.env` hat die falsche Form: Die Meldung nennt die Variable und, außer bei Tokens und Schlüsseln, den Wert. Korrigieren, dann `docker compose up -d`. |
| Die App meldet unter „Sicherung": „Der Ordner für Sicherungen fehlt." | `./backups` ist nicht eingebunden oder fehlt auf dem Rechner (Abschnitt 8.1, Schritt 3). |
| „… ist nicht beschreibbar (Benutzer 10001)." | `sudo chown 10001:10001 backups`; der nächste Versuch kommt nach einer Stunde von selbst. |
| Die App nennt bei der Sicherung „STOWLY_BACKUP_RECIPIENTS fehlt." | Der Ordner ist gesetzt, aber kein öffentlicher Schlüssel: Abschnitt 8.1, Schritte 1 und 2. Wer keine automatische Sicherung will, lässt `STOWLY_BACKUP_DIR` leer. |
| „Benachrichtigungen" fehlen in der App oder melden „nicht eingerichtet" | `STOWLY_PUSH_CONTACT` ist leer (Abschnitt 15). |
| Die Testnachricht meldet „Der Push-Dienst lehnt ab (403). Stimmt STOWLY_PUSH_CONTACT?" | Der Absender ist keine gültige `mailto:`- oder `https:`-Adresse; Apple prüft das streng. |
| Die Testnachricht meldet „nicht erreichbar" | Der Container kommt nicht ins Internet (die Push-Dienste von Apple, Google, Mozilla und Microsoft). |
| Die Tagesnachricht kommt nicht | Sie kommt nur, wenn seit der letzten etwas neu bald fällig oder abgelaufen ist, und nur bis 21 Uhr (Abschnitt 15.1). Unter „Einstellungen" nennt die App den letzten Lauf und einen Fehler; im Log steht „Tagesnachricht: nichts Neues." oder „… kein Abo erreicht". |
| Unter „Home Assistant" steht „Home Assistant lehnt den Token ab." | `STOWLY_HA_TOKEN` ist falsch oder der Token wurde in HA gelöscht: neuen langlebigen Token anlegen (Abschnitt 17.2), eintragen, `docker compose up -d`. |
| „Die Liste todo.… gibt es in Home Assistant nicht." | `STOWLY_HA_TODO_ENTITY` stimmt nicht: in HA unter „Entwicklerwerkzeuge → Zustände" nach `todo.` suchen. |
| „Die Liste ist in Home Assistant gerade nicht verfügbar." | HA startet gerade neu, oder die Integration Bring! hat ein Problem (in HA unter „Geräte & Dienste"). Stowly versucht es alle zwei Minuten wieder; die Einkaufsliste in Stowly bleibt, wie sie ist. |
| „Home Assistant ist nicht erreichbar." | Adresse in `STOWLY_HA_URL` falsch, ein Name auf `.local` (löst im Container nicht auf: IP nehmen), Firewall oder HA aus. Probe aus dem Container: `docker compose exec stowly python -c "import httpx2; print(httpx2.get('http://192.168.1.20:8123/api/').status_code)"` zeigt `401` (erreichbar; ohne Token lehnt HA ab). |
| „… Zertifikat nicht vertraut, siehe STOWLY_HA_CA." | HA läuft per https mit eigenem Zertifikat: Abschnitt 17.4. |
| „Home Assistant antwortet mit …" | Ein Fehler in HA; Einzelheiten im Log von HA, bei Stowly steht nur Status und Pfad. „… kennt todo.get_items nicht so (400)": HA liefert über seine Schnittstelle keine Antworten von Diensten (`?return_response`); HA aktualisieren. |
| Ein Eintrag erscheint nicht in Bring! | Er ist keine zwei Minuten offen, oder er hat keinen Namen (ein Platzhalter, der noch auf Open Food Facts wartet), oder in Bring! steht schon ein Artikel desselben Namens: Dann bindet Stowly den Eintrag an ihn, statt einen zweiten anzulegen (Abschnitt 17.1). |
| Der Sensor in HA ist „nicht verfügbar", im Log von HA steht 401 | In `secrets.yaml` fehlt `Bearer ` vor dem Token, oder er stimmt nicht mit `STOWLY_HA_SUMMARY_TOKEN` überein (Abschnitt 18). Bei 503: `STOWLY_HA_SUMMARY_TOKEN` ist leer. Bei einem Fehler zum Zertifikat: Abschnitt 18.3. |
| Die App bleibt nach einer Änderung an `STOWLY_CSP` leer, oder die Konsole des Browsers meldet „Content Security Policy" | Die eigene Policy verbietet etwas, das die App braucht: zurück zur Vorgabe (`STOWLY_CSP` leer) und Abschnitt 13. |

## 12. Das Repository auf den Server bringen

Das Repository hat kein Remote. Vier Wege auf den Server, alle über SSH (`<benutzer>@<server>` ist der eigene Zugang). Auf dem Server liegt danach ein Ordner `~/stowly`, in dem `docker compose` läuft; `.env` und `docker-compose.override.yml` legt man dort einmal an, keiner der Wege überschreibt sie.

**Git-Bundle.** Das ganze Repository samt Verlauf als eine Datei. Vorteil: Auf dem Server liegt ein echtes Git-Repository, ein Stand lässt sich mit `git log` nachsehen und mit `git checkout` zurückholen, und es braucht nur `scp`. Nachteil: Jede Aktualisierung braucht ein neues Bundle und einen Kopierschritt, und die Datei enthält immer den ganzen Verlauf.

```
# Entwicklungsrechner, im Repository
git bundle create stowly.bundle --all
git bundle verify stowly.bundle
scp stowly.bundle <benutzer>@<server>:~/stowly.bundle

# Server, beim ersten Mal
git clone ~/stowly.bundle ~/stowly
cd ~/stowly && git checkout main

# später: neues Bundle wie oben erzeugen und an dieselbe Stelle kopieren, dann auf dem Server
cd ~/stowly && git pull          # liest ~/stowly.bundle (beim Klonen als origin eingetragen)
docker compose up -d --build
```

**rsync über SSH.** Kopiert den Arbeitsstand ohne Git. Vorteil: Am einfachsten, und es überträgt nur, was sich geändert hat. Nachteil: Auf dem Server gibt es keinen Verlauf und kein Zurück, und die Ausnahmen müssen stimmen, sonst landen `.venv`, Daten oder ein lokales `.env` auf dem Server.

```
# Entwicklungsrechner, im Repository (der Schrägstrich hinter ./ zählt)
rsync -av --delete \
  --exclude .git --exclude .venv --exclude data --exclude .env \
  --exclude docker-compose.override.yml --exclude web/node_modules --exclude web/dist \
  --exclude '__pycache__' --exclude '.pytest_cache' --exclude '.ruff_cache' \
  ./ <benutzer>@<server>:~/stowly/
# Server
cd ~/stowly && docker compose up -d --build
```

Ausgeschlossene Dateien löscht `--delete` auf dem Server nicht; `.env` und `docker-compose.override.yml` bleiben dort also stehen.

**Eigenes Remote auf dem Server.** Ein leeres Repository auf dem Server, in das man wie gewohnt schiebt. Vorteil: `git push` und `git pull` wie bei jedem Remote, Verlauf auf beiden Seiten, kein Kopieren von Dateien. Nachteil: Es muss einmal eingerichtet werden, und ein Remote bei einem fremden Dienst (statt auf dem eigenen Server) brächte den Code dorthin, was der Plan ohne ausdrücklichen Wunsch nicht vorsieht.

```
# Server, einmal
git init --bare ~/stowly.git
git clone ~/stowly.git ~/stowly     # zunächst leer

# Entwicklungsrechner, einmal
git remote add server <benutzer>@<server>:stowly.git
git push server main

# Server: holen und starten (beim ersten Mal und nach jedem git push)
cd ~/stowly && git pull origin main
docker compose up -d --build
```

**`git archive` über SSH.** Packt den letzten Commit und entpackt ihn auf dem Server, etwa auf einem NAS ohne Git (Abschnitt 4.4). Vorteil: Es kommt genau der committete Stand an, ohne `.git`, Daten oder lokale Dateien, und auf dem Server braucht es nur `tar`. Nachteil: Kein Verlauf auf dem Server, und Dateien, die es im neuen Stand nicht mehr gibt, bleiben dort liegen.

```
# Entwicklungsrechner, im Repository
git archive --format=tar HEAD | ssh <benutzer>@<server> 'mkdir -p ~/stowly && tar -xf - -C ~/stowly'
# Server
cd ~/stowly && docker compose up -d --build
```

## 13. Content-Security-Policy

Jede Antwort der Web-App trägt eine Content-Security-Policy (Kopfzeile `Content-Security-Policy`). Sie verbietet Inline-Skripte und fremde Quellen und schränkt so ein, was eingeschleuster Code im Browser tun könnte. Die Schnittstelle (`/api`) und der Druckdienst (`/print`) liefern keine Seiten und tragen keine.

| `STOWLY_CSP` | Wirkung |
|---|---|
| nicht gesetzt oder leer | die Vorgabe unten |
| `off` | keine Policy |
| etwas anderes | genau dieser Wert ersetzt die Vorgabe; in `.env` in doppelte Anführungszeichen setzen |

Die Vorgabe ist vorsichtig gewählt, damit nichts bricht:

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self' http: https:;
media-src 'self' blob: data:; worker-src 'self' blob:; manifest-src 'self'; object-src 'none';
base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

- `script-src`: nur Dateien der App (es gibt kein Inline-Skript), dazu `'wasm-unsafe-eval'` für die Barcode-Erkennung per WebAssembly. Safari vor Version 16 (iOS 15 und älter) kennt diese Angabe nicht und verweigert dann das WebAssembly; dort fällt die Erkennung aus. Abhilfe für solche Geräte: `'unsafe-eval'` zusätzlich in `script-src` oder `STOWLY_CSP=off`.
- `style-src 'unsafe-inline'`: Die App setzt Stil-Attribute.
- `img-src blob: data:`: die Vorschau der Etiketten und eingebettete Bilder; Produktbilder kommen von `/api/images`.
- `connect-src http: https:`: Der Direktdruck spricht frei eingetragene Adressen im Heimnetz an (`https://10.71.83.1:8443`, `http://10.71.83.1:8080`). Enger geht es nur mit den eigenen Adressen, etwa `connect-src 'self' https://10.71.83.1:8443 http://10.71.83.1:8080`.
- `worker-src`: der Worker der Barcode-Erkennung und der Service Worker, beide aus eigener Datei.
- `frame-ancestors 'none'`: Keine fremde Seite darf Stowly einbetten.

Der Reverse Proxy sollte keine eigene Policy dazusetzen: Zwei Policies gelten beide, und was eine verbietet, bleibt verboten. Ob die Policy ankommt: `curl -sI https://stowly.home/ | grep -i content-security-policy`. Verstöße meldet der Browser in seiner Konsole („Content Security Policy …"); Prüfschritte in Prüfliste H.

## 14. Drucker

Stowly druckt an zwei Stellen mit derselben Schnittstelle (`docs/etiketten.md`): im Server unter `/print` für Drucker im Heimnetz und auf dem Raspberry Pi im Keller, den die Handys direkt ansprechen. Drucker werden in der App unter Einstellungen → Drucker angelegt. Ein Drucker „am Server" wirkt sofort, ohne Neustart.

Der Druckdienst des Servers legt seine Daten im Volume ab (`/data/print/`): einen Auftragsspeicher (`jobs.sqlite3`) mit der `boot_id`, damit ein Neustart nichts doppelt druckt, und die Bilder des Bild-Treibers. Nach einem Neustart laufen wartende Etiketten weiter; eines, das gerade druckte, gilt als „unklar", und die App fragt, ob es herauskam. Nichts wird von selbst ein zweites Mal gedruckt.

### 14.1 Bild-Treiber zum Ausprobieren

Ohne Drucker: In der App einen Drucker „am Server" mit dem Treiber „Bild (PNG)" anlegen und als Standarddrucker wählen. Jedes Etikett wird dann als PNG geschrieben (`/data/print/images/<Kennung>.png`) und lässt sich in der App unter „Etikett ansehen" anzeigen. Aufgehoben werden die Bilder höchstens 30 Tage und höchstens die letzten 1000.

Für Tests lässt sich der Treiber stören: `docker compose exec stowly sh -c 'echo hang > /data/print/images/simulate.txt'` (auch `fail`, `fail:cover_open`, `abort`); entfernen mit `docker compose exec stowly rm /data/print/images/simulate.txt`.

### 14.2 Netzwerkdrucker (empfohlen)

Ein Brother QL-820NWBc (oder QL-810W) im Heimnetz, mit fester Adresse (Reservierung im Router). In der App: Treiber „Brother QL", Modell `QL-820NWB`, Adresse `tcp://192.168.1.60:9100`, Rolle `62`.

- Der Container erreicht Rechner im Heimnetz von selbst; Port 9100 des Druckers muss offen sein.
- Über das Netz kann der Treiber nur senden: Ein Etikett endet als „gesendet" statt „gedruckt", und „Etiketten leer" zeigt der Drucker selbst, nicht Stowly.

### 14.3 Drucker am USB des Servers

Möglich, aber nicht empfohlen: Ein Container bekommt keine Hotplug-Ereignisse; nach dem Aus- und Einschalten des Druckers kann ein Neustart des Containers nötig sein. Dafür gibt es die zuschaltbare Datei `docker-compose.usb.yml`:

```
# einmal auf dem Rechner: udev-Regel, dann den Drucker neu einstecken
echo 'SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="04f9", MODE="0660", GROUP="plugdev"' \
  | sudo tee /etc/udev/rules.d/99-stowly-brother.rules
sudo udevadm control --reload-rules && sudo udevadm trigger --subsystem-match=usb

docker compose -f docker-compose.yml -f docker-compose.usb.yml up -d
```

Die Datei reicht `/dev/bus/usb` in den Container (`device_cgroup_rules: c 189:* rmw`) und gibt dem Prozess die Gruppe `plugdev` (`STOWLY_USB_GID`, Vorgabe 46). In der App: Treiber „Brother QL", Modell `QL-800`, Adresse `usb://04f9:209b` (Produktnummer aus `lsusb`). Am USB bestätigt der Drucker den Druck („gedruckt") und meldet „Etiketten leer" vorab. Beim QL-800 muss der Editor-Lite-Modus aus sein.

### 14.4 Raspberry Pi im Keller

Eigene Anleitung samt Prüfliste: [`../pi/README.md`](../pi/README.md).

### 14.5 Schriften und Brother-Bibliothek

- Die Etiketten werden mit DejaVu gesetzt. Die drei Schriftdateien liefert Stowly selbst mit (Paket `stowly_print`, Ordner `fonts`: DejaVu 2.37 samt Lizenztext `DejaVu-LICENSE.txt`); so sehen die Etiketten am Server und am Pi gleich aus. Das Image enthält sie zusätzlich als Systempaket `fonts-dejavu-core`, als Rückfall. Beim Start nennt der Druckdienst im Log, welche Schrift er nimmt („Schriften der Etiketten: regular: …/stowly_print/fonts/DejaVuSans.ttf, …“). Fehlt die Schrift an beiden Stellen, druckt Stowly mit einer Ersatzschrift ohne Umlaute („ü“ wird „ue“) und meldet das im Log. Die Lizenz von DejaVu erlaubt das Weitergeben, solange ihr Text dabei bleibt.
- Die Brother-Bibliothek `brother_ql_next` steht unter der GPL-3.0. Sie gehört nicht zum Quelltext von Stowly: Das Image lädt sie beim Bau auf Version und Prüfsumme festgelegt von PyPI nach (`print/requirements-brother.txt`; `packbits` gibt es nur als Quellpaket und wird mit dem setuptools aus der Sperrdatei gebaut, Abschnitt 9.1), und nur der Brother-Treiber lädt sie, erst beim Benutzen. Wer ein Image mit ihr an andere weitergibt, muss deren GPL-Bedingungen einhalten. Das fertige Image auf GitHub (Abschnitt 9.2) entsteht deshalb ohne sie (`--build-arg STOWLY_BROTHER=0`): Ein Brother-Drucker direkt am Server meldet dort `config`. Wer einen braucht, baut das Image selbst; ohne Angabe ist die Bibliothek dabei.

## 15. Benachrichtigungen (Web-Push)

Stowly schickt selbst Benachrichtigungen an die Handys, über die Push-Dienste der Browser (Apple, Google, Mozilla, Microsoft), ohne fremden Dienst dazwischen: einmal am Tag eine Nachricht „nur Neues" (15.1), dazu auf Wunsch eine Testnachricht.

**Einrichten:** In `.env` den Absender setzen, dann `docker compose up -d`:

```
STOWLY_PUSH_CONTACT=mailto:betrieb@example.org
```

- Der Absender ist eine `mailto:`-Adresse oder eine `https://`-Adresse, unter der der Betreiber erreichbar ist. Die Push-Dienste bekommen ihn mit jeder Nachricht zu sehen; **Apple lehnt Nachrichten ohne gültigen Absender ab**. Ohne `STOWLY_PUSH_CONTACT` ist Push aus, und der Server meldet der App „nicht eingerichtet".
- Den Schlüssel, mit dem der Server seine Nachrichten unterschreibt, legt er beim ersten Start selbst an und bewahrt ihn in der Datenbank auf (er kommt mit jeder Sicherung mit). Wird eine ältere Sicherung zurückgespielt, melden sich die Geräte beim nächsten Start von selbst neu an.
- Der Container braucht dafür Zugang ins Internet (ausgehend, https). Angesprochen werden nur Adressen der bekannten Push-Dienste; ein Gerät kann den Server keine Anfragen ins Heimnetz schicken lassen.

**Auf den Handys:** unter „Einstellungen → Dieses Gerät" einschalten (der Browser fragt dabei um Erlaubnis), dann „Testnachricht senden".

- Benachrichtigungen gehen nur über die **HTTPS-Adresse** (Abschnitt 6).
- **iPhone:** erst ab iOS 16.4 und **nur in der installierten App** (Abschnitt 7, vom Home-Bildschirm geöffnet). In Safari selbst erklärt die App das, statt einen Knopf zu zeigen.
- **Android:** in Chrome auch ohne Installation.
- Wird ein Gerät abgemeldet oder unter „Geräte" gesperrt, endet auch sein Abo.

### 15.1 Die Tagesnachricht

Einmal am Tag schickt Stowly allen Geräten mit Benachrichtigungen eine Nachricht, **aber nur, wenn seit der letzten Nachricht etwas neu bald fällig oder abgelaufen ist**, etwa „Neu bald fällig: Joghurt (16.11.). Insgesamt 3 bald, 1 abgelaufen." Tippen öffnet die Warnungen.

- **Uhrzeit:** Die stellt jeder in der App ein (Einstellungen, Vorgabe 17:00). Sie gilt für den ganzen Haushalt und in der Zeitzone des Servers (`STOWLY_TIMEZONE`, Abschnitt 16), nicht in der des Handys; weicht die ab, nennt die App die Zeitzone des Servers dazu.
- **Nachholen:** War der Server zur Uhrzeit aus, kommt die Nachricht nach dem Start, aber **nur bis 21 Uhr** (bei einer Uhrzeit ab 21 Uhr: höchstens eine Stunde später, bis Mitternacht). Danach fällt sie für diesen Tag aus; die nächste deckt alles ab, was seither neu ist.
- **Neu** ist eine Packung, die seit der letzten Nachricht in „bald" oder „abgelaufen" kam, auch eine frisch eingelagerte, die schon so weit ist, und eine, die ein Gerät erst jetzt abgeglichen hat. Je Packung kommen höchstens zwei Nachrichten: einmal „bald", einmal „abgelaufen".
- Ändert jemand die Uhrzeit, nachdem die Nachricht heute schon kam, kommt heute keine zweite.
- Ein Handy ohne Netz bekommt nach dem Funkloch nur die neueste Nachricht; älter als einen Tag wird keine.
- **Zustand** in der App unter „Einstellungen": letzter Lauf, letzte verschickte Nachricht und ein Fehler, wenn sie kein einziges Gerät erreicht hat. Im Log steht je Lauf eine Zeile („Tagesnachricht: …").

## 16. Zeitzone

„Heute" (für das MHD in Sensor und Tagesnachricht, die Monate der Statistik, die Dateinamen der Sicherungen) und alle Uhrzeiten (`STOWLY_BACKUP_TIME`, die Uhrzeit der Tagesnachricht in den Einstellungen der App) gelten in `STOWLY_TIMEZONE`, Vorgabe `Europe/Berlin`. Erlaubt ist jeder IANA-Name, genau so geschrieben (`Europe/Vienna`, `UTC`); ein unbekannter Name beendet den Start mit einem Konfigurationsfehler. Die Zeitzonendaten bringt Stowly selbst mit; die Variable `TZ` des Containers spielt dafür keine Rolle. Gespeicherte Zeitpunkte sind immer UTC; die App zeigt sie in der Zeitzone des Handys und nennt die Zeitzone des Servers dazu, wenn sie abweicht.

Sommer- und Winterzeit brauchen nichts: Fällt die Uhrzeit einer Aufgabe in die Lücke beim Umstellen auf Sommerzeit (etwa 02:30), läuft sie mit dem Sprung um 03:00; gibt es sie beim Umstellen auf Winterzeit zweimal, läuft sie beim ersten Mal.

## 17. Einkaufsliste nach Bring! über Home Assistant

Die Einkaufsliste von Stowly erscheint über eine To-do-Liste von Home Assistant (HA) in Bring!, und was in Bring! abgehakt oder gelöscht wird, ist in Stowly erledigt. Stowly kennt dafür nur einen Token von HA, nie Zugangsdaten für Bring!. Ohne HA funktioniert die Einkaufsliste genauso, nur ohne Bring!.

### 17.1 Was Stowly tut

| In Stowly | In Bring! |
|---|---|
| ein Eintrag, seit zwei Minuten offen, mit Namen | ein Artikel mit dem Namen und der Menge als Spezifikation, etwa „fehlt 2 · Stowly", „3× · Stowly" oder nur „Stowly" |
| die Menge ändert sich („fehlt 2" → „fehlt 1") | die Spezifikation wird nachgeführt |
| abgehakt, gelöscht oder durch Einlagern erledigt | abgehakt: Der Artikel wandert zu „zuletzt gekauft" |
| ein automatischer Eintrag verschwindet, weil der Bestand reicht | Der Artikel wird entfernt, nicht abgehakt: So steht nichts als „gekauft" da, was niemand gekauft hat. |
| umbenannt | nichts |

| In Bring! | In Stowly |
|---|---|
| Artikel abgehakt | Die Einträge dazu sind erledigt (eingekauft); ein automatischer Eintrag kommt erst nach dem nächsten Einlagern wieder. |
| Artikel gelöscht | ebenso, sobald er zweimal nacheinander fehlt (etwa vier Minuten) |
| eigener neuer Artikel | nichts: Was ihr selbst in Bring! eintragt, übernimmt Stowly nicht. |

- **Zwei Minuten** wartet ein Eintrag, bevor er nach Bring! geht: Zeit für Rückgängig und Tippfehler. Ein Platzhalter ohne Namen (der Barcode wartet noch auf Open Food Facts) geht erst, wenn er einen Namen hat.
- **Takt:** Stowly gleicht alle zwei Minuten ab, dazu wenige Sekunden nach jeder Änderung an der Einkaufsliste. Bring! selbst aktualisiert sich in HA etwa alle 90 Sekunden: Ein Haken in der App von Bring! kommt nach einigen Minuten in Stowly an.
- **Ein Artikel je Name:** Namen gelten als gleich, wenn sie sich nur in Groß- und Kleinschreibung und Leerzeichen unterscheiden. Mehrere Einträge desselben Namens teilen sich einen Artikel; die Spezifikation kommt vom ältesten.
- **Eure Artikel bleiben unberührt:** Steht ein Artikel desselben Namens schon in Bring!, legt Stowly keinen zweiten an, ändert ihn nicht und hakt ihn nie ab. Hakt ihn jemand ab, gilt der Eintrag in Stowly als eingekauft. Das gilt auch für einen Artikel, den Stowly angelegt und abgehakt hat und den danach jemand aus „zuletzt gekauft" zurückholt: Von da an gehört er euch.
- **Wieder geöffnet:** Ein Eintrag, dessen Artikel in Bring! schon abgehakt ist, geht neu nach Bring!.

### 17.2 Einrichten

1. In HA die Integration **Bring!** einrichten (Einstellungen → Geräte & Dienste → Integration hinzufügen → Bring!). Jede Liste von Bring! erscheint als To-do-Liste, etwa `todo.zuhause` (Bring! nennt seine erste Liste „Zuhause"). Gleich die Liste nehmen, die ihr wirklich nutzt: Ein späterer Wechsel hakt Einträge ab (17.5). Nicht verwechseln mit der eingebauten Einkaufsliste von HA, die bei deutscher Sprache `todo.einkaufsliste` heißt.
2. Einen **eigenen HA-Benutzer** für Stowly anlegen (Einstellungen → Personen → Benutzer). Administratorrechte sollte er nicht brauchen (Prüfliste J1). So lässt sich der Zugang später einzeln sperren, und im Verlauf von HA steht, was Stowly geändert hat.
3. Als dieser Benutzer anmelden, dann Profil → Sicherheit → **Langlebige Zugangs-Token** → Token erstellen (Name „Stowly"). HA zeigt den Token nur einmal.
4. Den Namen der Liste nachsehen: Entwicklerwerkzeuge → Zustände, nach `todo.` filtern.
5. In `.env` eintragen und `docker compose up -d`:

   ```
   STOWLY_HA_URL=http://192.168.1.20:8123
   STOWLY_HA_TOKEN=…
   STOWLY_HA_TODO_ENTITY=todo.zuhause
   ```

   Die Adresse ist die IP von HA oder ein Name aus dem eigenen DNS (Pi-hole); Namen auf `.local` lösen im Container nicht auf. Ohne Pfad, ein `/` am Ende fällt weg. Läuft HA per https mit eigenem Zertifikat: 17.4.
6. `docker compose logs stowly` zeigt „Einkaufsliste nach Bring! über Home Assistant, Liste todo.zuhause." und kurz danach „Home Assistant: Abgleich mit todo.zuhause läuft." In der App steht unter „Einstellungen → Home Assistant" der Zustand „ok".

Der Token steht nur in `.env`: nie in der Datenbank, einer Sicherung, dem Log oder einer Antwort an die App. Fehlermeldungen nennen den Status und den Pfad des Aufrufs, nie den Token.

### 17.3 Was der Zustand in der App sagt

Die Meldungen schreibt der Server; die App zeigt sie mit dem Zeitpunkt des letzten Erfolgs und des Fehlers.

| Zustand | Meldung | Was tun |
|---|---|---|
| `ok` | – (der letzte Abgleich ist gelungen) | – |
| `pending` | – (eingerichtet, seit dem Start noch kein Abgleich) | einen Moment warten |
| `unauthorized` | „Home Assistant lehnt den Token ab." | neuen Token anlegen (17.2, Schritt 3) |
| `not_found` | „Die Liste todo.… gibt es in Home Assistant nicht." | Namen prüfen (17.2, Schritt 4) |
| `unavailable` | „Die Liste ist in Home Assistant gerade nicht verfügbar." (etwa beim Neustart von HA oder wenn Bring! nicht antwortet) | nichts; es geht von selbst weiter |
| `unreachable` | „Home Assistant ist nicht erreichbar." (Netz, Zeitüberschreitung nach 10 Sekunden), beim Zertifikat „… Zertifikat nicht vertraut, siehe STOWLY_HA_CA." | Adresse, Firewall, 17.4 |
| `error` | „Home Assistant antwortet mit 500." oder „… antwortet unerwartet." | Log von HA |
| `off` | – (nicht eingerichtet; ist nur ein Teil gesetzt, nennt die App, was fehlt) | 17.2, Schritt 5 |

Außerdem nennt die App die Zahl der offenen Einträge, die gerade in Bring! stehen. Solange etwas nicht geht, bleibt die Einkaufsliste in Stowly vollständig; der nächste Versuch kommt nach zwei Minuten. Ins Log schreibt Stowly nur einen Wechsel des Zustands, nicht jeden gescheiterten Versuch.

### 17.4 Eigene Zertifizierungsstelle

Läuft HA im Heimnetz per http, entfällt dieser Schritt. Läuft HA per https mit einem Zertifikat der eigenen Zertifizierungsstelle, muss Stowly ihr vertrauen: die Zertifizierungsstelle (das Wurzelzertifikat im Format PEM, nicht den Schlüssel) als `ha-ca.pem` in den Ordner des Repositorys legen und in `docker-compose.override.yml` einbinden (Compose liest die Datei von selbst mit, siehe Abschnitt 4.3; gibt es sie schon, etwa für das Netz des Proxys, kommt `volumes` dort dazu):

```yaml
services:
  stowly:
    volumes:
      - ./ha-ca.pem:/config/ha-ca.pem:ro
```

In `.env`: `STOWLY_HA_URL=https://ha.example:8123` (der Name, auf den das Zertifikat ausgestellt ist) und `STOWLY_HA_CA=/config/ha-ca.pem`, dann `docker compose up -d`. Lässt sich die Datei nicht lesen oder ist sie kein PEM, beendet der Server den Start mit einem Konfigurationsfehler. Stowly vertraut dann dieser Zertifizierungsstelle, zusätzlich zu denen des Systems.

### 17.5 Neustart von HA und andere Ausfälle

- **HA startet neu:** Erst ist HA nicht erreichbar, dann meldet es die Liste eine Weile als `unavailable`. In beiden Fällen schreibt Stowly nichts und zählt kein Fehlen; der Zustand in der App sagt es.
- **Kurz eine leere Liste:** Als in Bring! gelöscht gilt ein Artikel erst, wenn er **zweimal nacheinander** fehlt, während HA und die Liste erreichbar sind. Ein Neustart, der die Liste einen Abgleich lang leer zeigt, leert so nicht die Liste von Stowly.
- **Fehlen zählt nur bei Artikeln, die schon einmal in der Liste standen.** Ändert HA oder Bring! beim Anlegen den Namen (etwa gekürzt), sieht Stowly den Artikel nie: Er gilt dann nie als gelöscht oder abgehakt, und nach zehn Minuten steht einmal eine Warnung im Log („… steht zehn Minuten nach dem Anlegen noch nicht in der Liste").
- **Ohne Antwort von HA auf das Anlegen** (Zeitüberschreitung) gilt der Artikel als angelegt: lieber so als ein zweiter Artikel desselben Namens.
- **Die Liste nicht wechseln, solange Einträge in Bring! stehen.** Stowly merkt sich die Artikel nach ihrem Namen, nicht nach der Liste. Nach einem Wechsel von `STOWLY_HA_TODO_ENTITY` sucht es die schon gespiegelten Artikel in der neuen Liste, findet sie nicht und hakt die Einträge nach zwei Abgleichen als eingekauft ab. Deshalb gleich die richtige Liste einrichten, statt erst eine Testliste zu nehmen; die Probe-Einträge aus der Prüfliste J sind nach dem Test schnell wieder entfernt.

## 18. Sensor für Home Assistant

HA liest über seine `rest`-Integration eine Zusammenfassung: Zustand des Sensors ist die Zahl der Packungen, die bald ablaufen (heute eingeschlossen); dazu abgelaufene, alle, das nächste ablaufende Produkt, die Länge der Einkaufsliste, kurze Listen und ein fertiger Satz zum Vorlesen wie „Heute laufen 2 Packungen ab: Joghurt. 1 Packung ist abgelaufen. Auf der Einkaufsliste stehen 4 Einträge." „Heute" ist der Tag in `STOWLY_TIMEZONE`. Der Endpunkt `/api/ha/summary` liest nur und hat einen eigenen Token, der nirgends sonst gilt; ein Geräte-Token gilt dort nicht. Ansagen und Lichter baut ihr in HA als Automation; Stowly schickt keinen Webhook.

### 18.1 Token

Auf einem beliebigen Rechner einen Token erzeugen, etwa mit `openssl rand -hex 32`, und in `.env` eintragen, dann `docker compose up -d`:

```
STOWLY_HA_SUMMARY_TOKEN=…
```

Er muss mindestens 32 Zeichen lang sein und darf nur druckbare Zeichen ohne Leerraum enthalten. Probe, ohne HA (`-k` nur bei eigener Zertifizierungsstelle, die der Rechner nicht kennt):

```
curl -s -H "Authorization: Bearer …" https://stowly.example/api/ha/summary
```

zeigt JSON mit `"state"` und `"message"`. Ohne Token antwortet Stowly mit 401, ohne `STOWLY_HA_SUMMARY_TOKEN` mit 503.

### 18.2 In Home Assistant

Den Token mit `Bearer ` davor in die `secrets.yaml` von HA:

```yaml
# secrets.yaml
stowly_summary_auth: "Bearer …"
```

In die `configuration.yaml` (die Adresse ist die HTTPS-Adresse von Stowly, Abschnitt 4 oder 5):

```yaml
# configuration.yaml
rest:
  - resource: https://stowly.example/api/ha/summary
    headers:
      Authorization: !secret stowly_summary_auth
    scan_interval: 300
    timeout: 10
    sensor:
      - name: Stowly
        unique_id: stowly_summary
        value_template: "{{ value_json.state }}"
        unit_of_measurement: Packungen
        json_attributes:
          - today
          - expired
          - total
          - next
          - shopping
          - soon_list
          - expired_list
          - shopping_list
          - message

template:
  - sensor:
      - name: Stowly abgelaufen
        unique_id: stowly_expired
        state: "{{ state_attr('sensor.stowly', 'expired') | int(0) }}"
        unit_of_measurement: Packungen
      - name: Stowly Einkaufsliste
        unique_id: stowly_shopping
        state: "{{ state_attr('sensor.stowly', 'shopping') | int(0) }}"
        unit_of_measurement: Einträge
      - name: Stowly Ansage
        unique_id: stowly_message
        state: "{{ state_attr('sensor.stowly', 'message') }}"
```

Danach HA neu starten (oder unter Entwicklerwerkzeuge „REST-Entitäten neu laden"). Der Sensor `sensor.stowly` aktualisiert sich alle fünf Minuten. Der Satz hat höchstens 255 Zeichen, die Listen höchstens fünf Einträge mit je höchstens 40 Zeichen: So passen auch die Vorlagen-Sensoren in die Grenze von HA für den Zustand einer Entität.

Beispiel-Ansage am Morgen, als Automation mit Zeit-Auslöser (`tts.home_assistant_cloud` und `media_player.kueche` durch die eigenen ersetzen):

```yaml
automation:
  - alias: Stowly am Morgen
    triggers:
      - trigger: time
        at: "07:30:00"
    conditions:
      - condition: template
        value_template: >-
          {{ states('sensor.stowly') | int(0) > 0 or state_attr('sensor.stowly', 'expired') | int(0) > 0 }}
    actions:
      - action: tts.speak
        target:
          entity_id: tts.home_assistant_cloud
        data:
          media_player_entity_id: media_player.kueche
          message: "{{ state_attr('sensor.stowly', 'message') }}"
```

### 18.3 Zertifikat: HA muss Stowly vertrauen

Die `rest`-Integration kennt nur `verify_ssl: true` (Vorgabe) oder `false`, keine eigene Zertifizierungsstelle. Je nach Aufbau:

- **Stowly mit öffentlich gültigem Zertifikat** (Tailscale, Abschnitt 5, wenn HA im selben Tailnet ist): nichts zu tun.
- **HA im Container, eigene Zertifizierungsstelle:** HA nimmt statt seiner eingebauten Liste die Datei aus der Umgebungsvariable `REQUESTS_CA_BUNDLE`. Diese Datei muss alle Zertifizierungsstellen enthalten, die HA braucht: die öffentliche Liste (etwa `/etc/ssl/certs/ca-certificates.crt` eines Debian-Rechners) und dahinter das eigene Wurzelzertifikat. Die Datei in den Container von HA einbinden und die Variable dort setzen. Ungeprüft; Prüfliste K6.
- **Sonst** (etwa Home Assistant OS): `verify_ssl: false` unter `resource` ergänzen. Die Verbindung bleibt verschlüsselt, das Zertifikat wird nicht geprüft; der Token des Sensors erlaubt nur, diese Zusammenfassung zu lesen.

Die andere Richtung, Stowly vertraut HA, steht in 17.4.

### 18.4 Liste aller Waren

Ein zweiter Sensor holt mit demselben Token die Liste aller Waren im Bestand, je Zone (`/api/ha/stock`, Inhalt in [`integrationen.md`](integrationen.md), 6.3). Sein Zustand ist die Zahl der Packungen; die Liste steht im Attribut `zones` und ist für eine Markdown-Karte gedacht.

In die `configuration.yaml`, unter den vorhandenen Abschnitt `rest:` aus 18.2 (die Adresse und `verify_ssl` wie dort):

```yaml
rest:
  - resource: https://stowly.example/api/ha/stock
    headers:
      Authorization: !secret stowly_summary_auth
    scan_interval: 300
    timeout: 10
    sensor:
      - name: Stowly Bestand
        unique_id: stowly_stock
        value_template: "{{ value_json.state }}"
        unit_of_measurement: Packungen
        json_attributes:
          - product_count
          - zones
          - truncated

recorder:
  exclude:
    entities:
      - sensor.stowly_bestand
```

Der Abschnitt `recorder:` nimmt den Sensor aus der Historie von HA. Ohne ihn warnt HA ab etwa 150 Einträgen, die Attribute seien größer als 16 KB, und speichert sie nicht. Steht `recorder:` schon in der Datei, kommt `exclude` dort hinein. Danach die Konfiguration prüfen und HA neu starten.

Die Karte: im Dashboard „Karte hinzufügen" → „Markdown", dann im Code-Editor:

```yaml
type: markdown
title: Bestand
content: |
  {%- set zones = state_attr('sensor.stowly_bestand', 'zones') or [] %}
  {%- for zone in zones %}
  ### {{ zone.name }} ({{ zone.count }})
  | Produkt | Anz. | MHD |
  |:--|--:|--:|
  {%- for p in zone.products %}
  | {{ p.name }} | {{ p.count }} | {% if p.state == 'expired' %}<font color="#d32f2f">{{ p.mhd }}</font>{% elif p.state == 'soon' %}<font color="#ef6c00">{{ p.mhd }}</font>{% else %}{{ p.mhd or '–' }}{% endif %} |
  {%- endfor %}

  {% else %}
  Nichts im Bestand.
  {%- endfor %}
  {%- if state_attr('sensor.stowly_bestand', 'truncated') %}

  *Die Liste ist gekürzt.*
  {%- endif %}
```

Je Zone eine Tabelle, darin nach MHD; abgelaufene Daten rot, bald fällige orange, ohne MHD ein Strich. Die Bindestriche in `{%-` sorgen dafür, dass die Zeilen einer Tabelle ohne Leerzeilen aufeinander folgen; sonst zerfällt die Tabelle. Wer statt nach Zonen lieber eine einzige Liste will, ändert nur die Vorlage: Die Daten enthalten alles.

## Prüfliste für die Zielumgebung

Alles hier ließ sich auf dem Entwicklungsrechner nicht prüfen. Bitte der Reihe nach; hinter jedem Schritt steht, was zu sehen sein muss.

### A. Container auf Debian 13

| # | Schritt | Erwartet |
|---|---|---|
| A1 | `docker --version`, `docker compose version` | Docker Engine vorhanden, Compose in Version 2 oder neuer |
| A2 | `cp .env.example .env`, `STOWLY_PASSWORD` setzen | – |
| A3 | `docker compose build` | Beide Stufen laufen durch: `npm ci` und `npm run build` (Web-App), `pip install` (Server). Kein Fehler, am Ende ein Image `stowly:local`. |
| A4 | `docker compose up -d`, nach 40 Sekunden `docker compose ps` | Zustand `running (healthy)` |
| A5 | `curl -s http://127.0.0.1:8010/api/health` | JSON mit `"app":"stowly"` und `"configured":true` |
| A6 | `curl -sI http://127.0.0.1:8010/` | `200`, `content-type: text/html`. (Ein `503` hieße: Die Web-App fehlt im Image.) |
| A7 | `curl -sI http://127.0.0.1:8010/sw.js` | `200`, `content-type: text/javascript`, `cache-control: no-cache` |
| A8 | `docker compose exec stowly id` und `docker compose exec stowly ls -l /data` | `uid=10001(stowly)`; `stowly.sqlite3` gehört `stowly` |
| A9 | `docker compose logs stowly` | kein Traceback; beim ersten Start „Etikett-Vorlagen übernommen: package, zone" |
| A10 | Anmelden: `curl -s -X POST http://127.0.0.1:8010/api/auth/login -H 'Content-Type: application/json' -d '{"password":"<Passwort>","device_name":"Prüfung"}'` | JSON mit `token` und `device`. Mit falschem Passwort: `401` und `invalid_password`. (Das Gerät „Prüfung" später in der App sperren.) |
| A11 | `docker compose restart`, danach A5 | antwortet wieder; das Gerät „Prüfung" steht noch in der Geräteliste (Daten überleben den Neustart) |
| A12 | `docker compose down`, `docker compose up -d`, danach A5 | wie A11: Das Volume bleibt |
| A13 | Vom Netz aus, ohne Proxy: `curl http://<IP des Rechners>:8010/api/health` von einem anderen Rechner | **keine** Verbindung, solange `STOWLY_PUBLISH` nicht gesetzt ist |
| A14 | In der Scan-Ansicht einen echten, noch unbekannten Barcode scannen (oder von Hand eingeben), dann `docker compose logs stowly \| grep "Open Food Facts"` | Im Dialog stehen nach ein, zwei Sekunden Name, Marke und Größe; im Log eine Zeile mit „gefunden" oder „unbekannt". Nach dem Einlagern hat das Produkt Name und Bild. „fehlgeschlagen (ConnectError)" hieße: Der Container kommt nicht ins Internet. |
| A15 | `docker compose stop` | endet binnen weniger Sekunden, ohne dass Docker nach 15 Sekunden (`stop_grace_period`) hart beendet |

### B. Reverse Proxy

Variante Nginx Proxy Manager:

| # | Schritt | Erwartet |
|---|---|---|
| B1 | Auf einem Rechner im Heimnetz: `nslookup stowly.home` | die IP-Adresse des Proxys |
| B2 | Proxy Host nach Abschnitt 4.3 anlegen, „Cache Assets" aus | – |
| B3 | `https://stowly.home/api/health` im Browser | JSON mit `"app":"stowly"`, Schloss-Symbol ohne Warnung |
| B4 | `curl -sI https://stowly.home/sw.js` | `cache-control: no-cache` (der Proxy hat die Angabe nicht verändert) |
| B5 | `http://stowly.home` | leitet auf `https://` um |

Variante Tailscale:

| # | Schritt | Erwartet |
|---|---|---|
| B6 | `tailscale serve status` | zeigt die Weiterleitung auf `http://127.0.0.1:8010` |
| B7 | `https://<rechnername>.<tailnet>.ts.net/api/health` auf einem Gerät im Tailnet | JSON mit `"app":"stowly"`, gültiges Zertifikat |
| B8 | dieselbe Adresse von einem Gerät **außerhalb** des Tailnets | nicht erreichbar |

### C. Handys

Je einmal auf dem Android-Gerät und dem iPhone, über die HTTPS-Adresse:

| # | Schritt | Erwartet |
|---|---|---|
| C1 | Adresse im Browser öffnen (Android: Chrome, iPhone: Safari) | Anmeldeseite, keine Zertifikatswarnung |
| C2 | Als App installieren (Abschnitt 7) | Symbol auf dem Startbildschirm; Android: bitte notieren, ob „App installieren" oder nur „Zum Startbildschirm hinzufügen" angeboten wird |
| C3 | App vom Startbildschirm öffnen, anmelden | öffnet ohne Adressleiste; der Bestand erscheint |
| C4 | Scannen öffnen | Nachfrage nach der Kamera, danach Kamerabild |
| C5 | Flugmodus an, App schließen und neu öffnen | App startet und zeigt den Bestand |
| C6 | Im Flugmodus eine Packung einlagern, Flugmodus aus | die Änderung erscheint binnen einer Minute auf dem zweiten Gerät |
| C7 | Dasselbe Feld derselben Packung auf beiden Geräten ohne Netz ändern, dann beide ans Netz | beide zeigen danach denselben Wert: den der späteren Änderung |
| C8 | In der App: Einstellungen → Geräte | beide Handys mit Namen und „zuletzt gesehen" |
| C9 | Ein Gerät dort sperren | das gesperrte Gerät verlangt beim nächsten Abgleich die Anmeldung; seine Daten sind noch da |
| C10 | iPhone: die App acht Tage nicht öffnen, dann im Flugmodus öffnen | Bestand ist noch da (die installierte App verliert ihre Daten nicht) |

### D. Sicherung und Zurückspielen

| # | Schritt | Erwartet |
|---|---|---|
| D1 | In der App die Sicherung herunterladen | Datei `stowly-JJJJ-MM-TT.sqlite3` |
| D2 | Auf einem Rechner: `sqlite3 stowly-….sqlite3 "PRAGMA integrity_check; SELECT COUNT(*) FROM packages;"` | `ok` und die Zahl der Packungen |
| D3 | Danach in der App eine Packung einlagern (sie fehlt in der Sicherung) | – |
| D4 | Zurückspielen nach Abschnitt 8 | Befehle laufen ohne Fehler; `docker compose exec stowly ls -l /data` zeigt die Datei im Besitz von `stowly` |
| D5 | Beide Handys öffnen | Sie gleichen ab und zeigen den Stand der Sicherung; die Packung aus D3 ist weg; niemand muss sich neu anmelden |
| D6 | Nur wer Schnappschüsse des Volumes zurückspielen will: `docker compose run --rm --no-deps stowly python -m stowly --new-dataset` | Ausgabe „Neue Kennung des Datenbestands: …"; nach dem Start holen beide Handys den Bestand neu |
| D7 | Automatische Sicherung nach Abschnitt 8.1 einrichten (zwei Schlüssel, Ordner, `.env`), `docker compose up -d`, `docker compose logs stowly` | „Automatische Sicherung täglich um 03:30 nach /backups an 2 Schlüssel."; ist 03:30 heute vorbei, gleich danach „Sicherung geschrieben: stowly-….sqlite3.gz.age" |
| D8 | `ls -l backups` auf dem Rechner | eine Datei `stowly-JJJJ-MM-TT-HHMM.sqlite3.gz.age` mit Rechten `-rw-------`, Besitzer 10001; keine `.tmp`-Datei |
| D9 | In der App „Einstellungen → Sicherung" | letzte Sicherung mit Uhrzeit und Größe, zwei gekürzte Schlüssel (`age1…`), der nächste Versuch; keine Warnung |
| D10 | Probe-Entschlüsselung nach 8.1 mit **jedem** der beiden privaten Schlüssel | beide Male `SQLite format 3`; mit `sqlite3`: `ok` und die Zahl der Packungen |
| D11 | Eine automatische Sicherung nach 8.3 entschlüsseln und zurückspielen | wie D4 und D5 |
| D12 | `sudo chown root:root backups`, `docker compose restart`, in der App „Sicherung" ansehen; danach wieder `sudo chown 10001:10001 backups` | Ist 03:30 vorbei und heute noch keine Sicherung gelungen: „Der Ordner für Sicherungen ist nicht beschreibbar (Benutzer 10001)."; eine Stunde später gelingt sie von selbst |
| D13 | Die Sicherungen an einen anderen Ort kopieren (Abschnitt 8.1, „Kopie außer Haus") | Die Kopie lässt sich wie in D10 öffnen |

### E. Aktualisieren

| # | Schritt | Erwartet |
|---|---|---|
| E1 | `git pull`, `docker compose up -d --build` | neuer Container, `healthy`; Bestand unverändert |
| E2 | App auf einem Handy öffnen | arbeitet weiter; zeigt gegebenenfalls, dass eine neue Version bereitsteht |
| E3 | Aktualisieren über ein Git-Bundle (Abschnitt 12) | `git pull` auf dem Server meldet die neuen Commits |

### F. Druck am Server

| # | Schritt | Erwartet |
|---|---|---|
| F1 | `docker compose build` | Im zweiten Teil laufen `apt-get install fonts-dejavu-core libusb-1.0-0` und die drei `pip install` durch: die Sperrdatei (nur Wheels, darunter `pillow`, `pydantic_core`, `cryptography`, `cffi` und `pyrage` für `manylinux…_x86_64` bzw. `…_aarch64`), Druckdienst und Server („Successfully built stowly-print stowly-server", ohne Download), die Brother-Bibliothek („Building wheel for packbits", aber nirgends „Installing build dependencies"). Danach „Successfully uninstalled setuptools-78.1.1" und „No broken requirements found." |
| F2 | `docker compose exec stowly python -c "import stowly_print, pathlib; print(sorted(p.name for p in (pathlib.Path(stowly_print.__file__).parent / 'fonts').iterdir()))"` | `DejaVu-LICENSE.txt`, `DejaVuSans-Bold.ttf`, `DejaVuSans.ttf`, `DejaVuSansMono-Bold.ttf`; dieselben drei Schriften liegen als Rückfall unter `/usr/share/fonts/truetype/dejavu/` |
| F3 | `docker compose exec stowly python -c "import brother_ql, usb; print('ok')"` | `ok` |
| F4 | `docker compose logs stowly` nach dem Start | „Druckdienst unter /print bereit (boot_id …)"; „Schriften der Etiketten:“ nennt dreimal eine Datei unter `…/stowly_print/fonts/` (die mitgelieferten DejaVu-Schriften), nicht „eingebaut“; keine Meldung „Schrift … fehlt" |
| F5 | `docker compose exec stowly ls -l /data/print` | `jobs.sqlite3` und `images/`, beide im Besitz von `stowly` |
| F6 | In der App einen Drucker „am Server" mit dem Bild-Treiber anlegen, als Standarddrucker wählen, eine Packung einlagern | Etikett „gedruckt"; „Etikett ansehen" zeigt es mit echten Umlauten; auf dem zweiten Handy erscheint „gedruckt" nach dem nächsten Abgleich |
| F7 | `curl -s https://stowly.home/print/v1/health` (ohne Token) | `401` mit `"code":"unauthorized"` |
| F8 | `docker compose exec stowly sh -c 'echo hang > /data/print/images/simulate.txt'`, Packung einlagern, `docker compose restart`, Datei wieder entfernen | Das Etikett ist danach „unklar" (Druck unterbrochen), es entsteht kein Bild, nichts druckt nach |
| F9 | `docker compose stop` | endet binnen etwa 15 Sekunden, auch wenn gerade eine App auf ein Etikett wartet |
| F10 | Netzwerkdrucker (Abschnitt 14.2) anlegen, Packung einlagern | Etikett kommt aus dem Drucker; in der App „gesendet" |
| F11 | Netzwerkdrucker ausschalten, „Verbindung prüfen" | nicht erreichbar (`offline`) |
| F12 | Nur USB: `docker compose -f docker-compose.yml -f docker-compose.usb.yml up -d`, dann `docker compose exec stowly python -c "import usb.core; print([hex(d.idProduct) for d in usb.core.find(find_all=True, idVendor=0x04f9)])"` | die Produktnummer des Druckers, z. B. `['0x209b']` |
| F13 | Nur USB: Drucker mit `usb://04f9:209b` anlegen, Packung einlagern | „gedruckt" (am USB bestätigt der Drucker) |
| F14 | Nur USB: Drucker aus- und einschalten, wieder drucken | druckt; falls erst nach `docker compose restart`, bitte melden |
| F15 | Etiketten aus dem Gefrierschrank (DK-22212, vier Wochen bei −18 °C) mit beiden Handys scannen | haftet, QR-Code lesbar |

### G. Raspberry Pi

Die eigene Prüfliste in [`../pi/README.md`](../pi/README.md#prüfliste-am-gerät) (P bis V): Installation, Drucker, Access Point, Zertifikat auf Android und iPhone, Direktdruck über HTTPS und HTTP, Seite des Druckdienstes, Schreibschutz.

### H. Content-Security-Policy

| # | Schritt | Erwartet |
|---|---|---|
| H1 | `curl -sI https://stowly.home/ \| grep -i content-security-policy` | die Vorgabe aus Abschnitt 13 (Proxy hat nichts verändert oder hinzugefügt) |
| H2 | Desktop-Chrome: App öffnen, Entwicklertools → Konsole, anmelden, Bestand, Einstellungen, Drucker, „Etikett ansehen", Scannen | keine Meldung „Content Security Policy" |
| H3 | Android (Chrome, per USB-Debugging an `chrome://inspect`) und iPhone (Safari, Web-Inspektor am Mac): Scannen mit Kamera, ein Etikett direkt zum Pi drucken | Kamera und Erkennung laufen, Druck geht; keine Meldung „Content Security Policy" |
| H4 | Ein iPhone mit iOS 15 oder älter, falls vorhanden: Scannen | Erkennung läuft; sonst Abschnitt 13 (`'unsafe-eval'` oder `STOWLY_CSP=off`) |
| H5 | `STOWLY_CSP=off` in `.env`, `docker compose up -d`, dann H1 | keine Kopfzeile mehr; danach zurück auf leer |

### I. Benachrichtigungen und Zeitzone

| # | Schritt | Erwartet |
|---|---|---|
| I1 | `STOWLY_PUSH_CONTACT` nach Abschnitt 15 setzen, `docker compose up -d` | Start ohne Konfigurationsfehler; mit `STOWLY_PUSH_CONTACT=betrieb` (ohne `mailto:`) dagegen „Konfigurationsfehler: STOWLY_PUSH_CONTACT …" |
| I2 | Android, Chrome, HTTPS-Adresse: „Einstellungen → Dieses Gerät" → Benachrichtigungen einschalten, erlauben, „Testnachricht senden" | Die App meldet „Der Push-Dienst hat die Nachricht angenommen."; binnen Sekunden erscheint „Testnachricht" mit „Benachrichtigungen kommen auf diesem Gerät an."; Tippen öffnet die Einstellungen |
| I3 | iPhone (ab iOS 16.4), **installierte** App: dasselbe | wie I2. In Safari ohne Installation erklärt die App, dass es erst nach der Installation geht |
| I4 | Eine zweite Testnachricht sofort danach | „Bitte in … Sekunden erneut versuchen" (höchstens eine je 10 Sekunden) |
| I5 | Das Gerät unter „Geräte" abmelden, dann `docker compose exec stowly python -c "import sqlite3; print(sqlite3.connect('/data/stowly.sqlite3').execute('SELECT COUNT(*) FROM push_subscriptions').fetchone())"` | Das Abo des abgemeldeten Geräts ist weg |
| I6 | `docker compose logs stowly` nach den Testnachrichten | „Push an web.push.apple.com angenommen (201)" o. ä.; nie die volle Adresse eines Abos, nie ein Schlüssel |
| I7 | `STOWLY_TIMEZONE=Mars/Olympus`, `docker compose up -d`, Log ansehen; danach zurück | „Konfigurationsfehler: STOWLY_TIMEZONE …"; mit gültigem Namen startet der Server und nennt „Zeitzone des Servers: …" |
| I8 | Die Uhrzeit der Tagesnachricht in der App auf eine Viertelstunde von jetzt stellen; eine Packung einlagern, deren MHD in drei Tagen ist | Zur Uhrzeit (spätestens eine Minute danach) kommt auf jedem Gerät mit Benachrichtigungen „Neu bald fällig: … Insgesamt … bald, … abgelaufen."; Tippen öffnet die Warnungen. Im Log „Tagesnachricht: 1 Packung neu, angenommen bei … von … Abos." |
| I9 | Danach die Uhrzeit auf eine Viertelstunde später stellen | heute keine zweite Nachricht |
| I10 | Am nächsten Tag zur Uhrzeit, ohne dass etwas Neues bald fällig wurde | keine Nachricht; im Log „Tagesnachricht: nichts Neues."; in der App ist der letzte Lauf von heute |
| I11 | iPhone im Flugmodus über die Uhrzeit hinweg, danach wieder ans Netz | die Nachricht kommt nach dem Funkloch, einmal |
| I12 | Server zur Uhrzeit aus (`docker compose stop`), vor 21 Uhr wieder an, mit etwas Neuem | die Nachricht kommt gleich nach dem Start; nach 21 Uhr gestartet: an diesem Tag keine mehr |

### J. Einkaufsliste nach Bring! über Home Assistant

Mit der Liste, die ihr wirklich nutzt (Abschnitt 17.2; ein späterer Wechsel hakt Einträge ab, 17.5). Die Probe-Einträge danach in Bring! löschen. Abgeglichen wird alle zwei Minuten; Bring! braucht in HA bis zu 90 Sekunden.

| # | Schritt | Erwartet |
|---|---|---|
| J1 | Abschnitt 17.2 durchgehen, mit einem eigenen HA-Benutzer **ohne** Administratorrechte | Log: „Home Assistant: Abgleich mit todo.… läuft."; in der App „ok". Sonst bitte melden, mit der Meldung aus der App. |
| J2 | In Stowly einen Eintrag „Milch Probe" anlegen | nach zwei bis vier Minuten in Bring! als „Milch Probe" mit der Spezifikation „Stowly" |
| J3 | Einen Mindestbestand setzen und unterschreiten (automatischer Eintrag „fehlt 2"), dann eine Packung einlagern | in Bring! mit „fehlt 2 · Stowly", danach „fehlt 1 · Stowly" |
| J4 | „Milch Probe" in Stowly abhaken | in Bring! unter „zuletzt gekauft" |
| J5 | Den Mindestbestand wieder erreichen (einlagern) | Der automatische Artikel verschwindet aus Bring!, ohne unter „zuletzt gekauft" zu stehen. |
| J6 | In Bring! einen Artikel „Kaffee Probe" anlegen, in Stowly einen Eintrag „kaffee probe" | Kein zweiter Artikel in Bring!; in der App zählt „in Bring!" den Eintrag mit. Den Eintrag in Stowly abhaken: In Bring! bleibt „Kaffee Probe" stehen. |
| J7 | Einen gespiegelten Artikel in der App von Bring! abhaken | nach einigen Minuten in Stowly erledigt; ein automatischer Eintrag kommt bis zum nächsten Einlagern nicht wieder |
| J8 | Einen gespiegelten Artikel in Bring! löschen | in Stowly erledigt, nach zwei Abgleichen (etwa vier bis sechs Minuten) |
| J9 | Einen in Stowly erledigten Eintrag wieder öffnen | Er geht nach zwei Minuten wieder nach Bring! (zurück aus „zuletzt gekauft" oder als neuer Artikel: bitte notieren, welches) |
| J10 | HA neu starten, während Einträge in Bring! stehen | In der App zeitweise „nicht erreichbar" oder „nicht verfügbar"; danach „ok". Kein Eintrag in Stowly ist erledigt. |
| J11 | `STOWLY_HA_TOKEN` absichtlich verfälschen, `docker compose up -d`; danach zurück | „Home Assistant lehnt den Token ab."; die Einkaufsliste in Stowly bleibt unverändert |
| J12 | Nur bei HA über https mit eigener Zertifizierungsstelle: Abschnitt 17.4; einmal ohne `STOWLY_HA_CA` | ohne: „… Zertifikat nicht vertraut, siehe STOWLY_HA_CA."; mit: „ok" |
| J13 | `docker compose logs stowly \| grep -i "home assistant"` | Wechsel des Zustands und erledigte Einträge, nie der Token und nie die Adresse von HA |

### K. Sensor für Home Assistant

| # | Schritt | Erwartet |
|---|---|---|
| K1 | Token nach 18.1, `curl` wie dort | JSON mit `state`, `today`, `expired`, `total`, `next`, `shopping`, den Listen und `message` |
| K2 | Dasselbe ohne Token und mit dem Token eines Geräts | beide Male 401 |
| K3 | Den Sensor-Token an `/api/devices` schicken | 401 |
| K4 | Schnipsel aus 18.2 in HA, HA neu starten | `sensor.stowly` mit der Zahl der bald ablaufenden Packungen und allen Attributen; die drei Vorlagen-Sensoren mit Werten |
| K5 | Die Automation „Stowly am Morgen" auf eine Minute von jetzt stellen | Der Satz wird vorgelesen. |
| K6 | Nur mit eigener Zertifizierungsstelle: 18.3 (`REQUESTS_CA_BUNDLE` im Container von HA, sonst `verify_ssl: false`) | Der Sensor bekommt Werte; im Log von HA kein Fehler zum Zertifikat. Bitte notieren, welcher Weg ging. |
| K7 | `curl` wie in 18.1, aber an `/api/ha/stock` | JSON mit `state`, `product_count`, `zones` (je Zone `name`, `count`, `products`) und `truncated` |
| K8 | Sensor und Karte aus 18.4 in HA, HA neu starten | `sensor.stowly_bestand` mit der Zahl der Packungen; die Karte zeigt je Zone eine Tabelle, abgelaufene Daten rot, bald fällige orange; im Log von HA keine Warnung zur Größe der Attribute |

### L. Updates über GitHub

| # | Schritt | Erwartet |
|---|---|---|
| L1 | Abschnitt 9.2 einrichten (`.env`, `docker compose pull`, `up -d`, Aufgabe für den Updater) | In der App unter „Aktualisierung“: installierte Version, „Updater bereit“; in `update/updater` im Datenvolume ein frisches `seen_at` |
| L2 | „Nach Updates suchen“, zweimal schnell hintereinander | Das erste Mal der Stand von GitHub; das zweite Mal der Hinweis, in einer Minute erneut zu suchen |
| L3 | Eine Vorabversion veröffentlichen (`vX.Y.Z-rc.1`, 9.4) | Das Image `:X.Y.Z-rc.1` liegt auf ghcr.io; die App bietet nichts an |
| L4 | Eine neue Version veröffentlichen (9.4) | Nach dem nächsten Suchen „Neue Version“ mit den Änderungen; eine Push-Nachricht „Stowly X.Y.Z ist verfügbar.“, nur einmal |
| L5 | „Update installieren“, Rückfrage bestätigen | „Angefordert“, dann „Wird installiert“, dann nach ein bis zwei Minuten „Aktualisiert auf X.Y.Z“; Bestand und Geräte unverändert; auf den Handys „Jetzt aktualisieren“ |
| L6 | In `update/` und im Projektordner nachsehen | `before-<alt>-<zeit>.sqlite3`, `.env.bak`, in der `.env` die neue `STOWLY_VERSION`; die `.env` gehört weiter ihrem Besitzer |
| L7 | Eine Anforderung für eine Version, die es nicht gibt (von Hand: `update/request` mit `version=9.9.9`) | Nach einer Minute „gescheitert“: Das Image ließ sich nicht laden; die alte Version läuft weiter |
| L8 | Die Aufgabe des Updaters zehn Minuten lang anhalten | Die App sagt, dass sich der Updater nicht meldet, und bietet kein Installieren an |
