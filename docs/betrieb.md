# Betrieb

Anleitung für den Betreiber einer Stowly-Installation: starten, erreichbar machen, auf den Handys installieren, sichern, aktualisieren. Was Stowly ist und wie es aufgebaut ist, steht in [`../README.md`](../README.md) und [`plan-stufe-1.md`](plan-stufe-1.md).

> **Stand.** `Dockerfile`, `docker-compose.yml` und `docker-compose.usb.yml` sind auf dem Entwicklungsrechner **nicht gebaut und nicht gestartet** worden: Dort gibt es kein Docker. Auch Reverse Proxy, Zertifikate, Drucker und die Installation auf den Handys ließen sich nur beschreiben, nicht ausprobieren. Geprüft ist der Server selbst samt Druckdienst mit dem Bild-Treiber (automatische Tests und Durchläufe von Hand unter Windows, die Web-App mit eingeschalteter Content-Security-Policy im Browser). Alles Übrige prüft die [Prüfliste](#prüfliste-für-die-zielumgebung) am Ende; bitte beim ersten Aufsetzen Schritt für Schritt abhaken und Abweichungen melden. Aus Stufe 2 sind die automatische Sicherung, die Benachrichtigungen samt Tagesnachricht, die Zeitzone, der Abgleich mit Bring! über Home Assistant und der Sensor für Home Assistant bisher nur mit automatischen Tests geprüft (Testschlüssel für age, nachgebildete Push-Dienste, ein nachgebildetes Home Assistant, eingestellte Uhr); am Gerät, mit `age` und am echten Home Assistant prüfen sie D7 bis D13, I, J und K. Sicherung, Zurückspielen und Home Assistant in der App (0.4.0) sind mit automatischen Tests geprüft, auch gegen den echten Server und ein nachgebildetes Home Assistant; am NAS und an den Geräten prüft sie N. Für den Raspberry Pi gibt es eine eigene Anleitung samt Prüfliste: [`../pi/README.md`](../pi/README.md). Am 14.11.2026 liefen Bau und Start erstmals in einer Zielumgebung, auf einer Synology mit DSM 6.2.4 (Abschnitt 4.4); was dort geprüft ist, steht in [`pruefliste.md`](pruefliste.md).

## 1. Überblick

- Stowly läuft als **ein Container mit einem Prozess**. Er liefert die Web-App und die Schnittstelle auf Port 8010 über HTTP und seit 0.3.0 dieselbe App auf Port 8443 über HTTPS, mit einer eigenen Zertifizierungsstelle (Abschnitt 20).
- **Am einfachsten** legt man den Container per Mausklick in der Docker-Oberfläche des NAS an und richtet alles Weitere im Einrichtungsassistenten der App ein: Passwort, Zertifikat, Raspberry Pi, Sicherung, Updates, Benachrichtigungen, Home Assistant (Abschnitt 19). Eine Kommandozeile braucht es dafür nicht.
- **Alternativ stellt ein Reverse Proxy HTTPS davor bereit.** Beschrieben sind Nginx Proxy Manager mit eigener Zertifizierungsstelle (Abschnitt 4), der Reverse Proxy von Synology DSM (Abschnitt 4.4) und Tailscale (Abschnitt 5). Der Weg mit Docker Compose und `.env` (Abschnitt 3) bleibt für Rechner mit Kommandozeile.
- **Offline-Betrieb, Kamera und die Installation als App gehen nur über die HTTPS-Adresse** (Abschnitt 6).
- Alle Daten liegen in **einer SQLite-Datei** in einem Docker-Volume (Abschnitt 10).

## 2. Voraussetzungen

| Was | Wofür |
|---|---|
| Rechner mit Debian 13, ohne Bildschirm | Zielsystem; jedes Linux mit Docker sollte genauso gehen |
| Docker Engine mit Compose-Plugin (`docker compose version` zeigt Version 2 oder neuer) | Bau und Betrieb des Containers |
| Internet beim Bauen | lädt die Basis-Images und die Pakete von npm und PyPI (von PyPI nur Dateien, die auf Version und Prüfsumme festgelegt sind, Abschnitt 9.1) |
| etwa 1 GB Plattenplatz für den Bau, danach wenige hundert MB | Images; die Datenbank selbst bleibt klein |
| HTTPS: Stowly selbst mit eigener Zertifizierungsstelle (Abschnitt 20) **oder** ein Reverse Proxy (Nginx Proxy Manager, Synology DSM, Tailscale) | siehe Abschnitte 4, 4.4, 5 und 20 |
| eine feste IP-Adresse des NAS im Heimnetz (im Router einstellen) | Zertifikat und Adresse der App hängen daran (Abschnitt 6) |
| im Betrieb optional Internet | für das Nachschlagen bei Open Food Facts und für Benachrichtigungen (die Push-Dienste von Apple, Google, Mozilla und Microsoft, Abschnitt 15) |
| für die Sicherung: einen Ort für den geheimen Schlüssel (USB-Stick, Passwort-Manager) | Den Schlüssel erzeugt die App im Browser (Abschnitt 8.2). `age` auf einem eigenen Rechner braucht nur der Notweg auf der Kommandozeile (8.4), auf dem Server nie. |
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
| `STOWLY_PASSWORD` | Haushalts-Passwort. Ist es gesetzt, gilt es und lässt sich in der App nicht ändern. Leer: Das erste Passwort vergibt, wer die App zuerst öffnet (Abschnitt 19); bis dahin meldet der Server `"configured": false`. |
| `STOWLY_OFF_ENABLED` | `1`: unbekannte Barcodes bei Open Food Facts nachschlagen (höchstens 10 Abfragen je Minute). `0`: nie. |
| `STOWLY_OFF_CONTACT` | freiwilliger Kontakt im `User-Agent` gegenüber Open Food Facts |
| `STOWLY_LOG_LEVEL` | `info` (Vorgabe), `debug`, `warning` … |
| `STOWLY_CSP` | Content-Security-Policy der Web-App: leer = vorsichtige Vorgabe, `off` = keine, sonst der angegebene Wert (Abschnitt 13) |
| `STOWLY_TIMEZONE` | Zeitzone für „heute" und alle Uhrzeiten, Vorgabe `Europe/Berlin` (Abschnitt 16) |
| `STOWLY_BACKUP_DIR`, `STOWLY_BACKUP_RECIPIENTS`, `STOWLY_BACKUP_TIME` | freiwillig, die Sicherung geht auch ganz in der App: Ordner im Container, öffentliche age-Schlüssel (dann fest an), Uhrzeit. Leer = Wahl des Ordners nach 8.1, Schlüssel und Uhrzeit aus der App (Vorgabe `03:30`) (Abschnitt 8.5) |
| `STOWLY_PUSH_CONTACT` | Absender für Benachrichtigungen, `mailto:<Adresse>` oder eine `https://`-Adresse; leer = Kontakt aus der App, sonst kein Push (Abschnitt 15) |
| `STOWLY_UPDATE_REPO` | Updates über GitHub immer an (Abschnitt 9.2); leer = Schalter in der App |
| `STOWLY_HTTPS_PORT` | Port des HTTPS-Listeners im Container; im Image `8443`. Veröffentlicht wird er nur über `docker-compose.override.yml` (Abschnitt 20) |
| `STOWLY_HA_URL`, `STOWLY_HA_TOKEN`, `STOWLY_HA_TODO_ENTITY`, `STOWLY_HA_CA` | Einkaufsliste nach Bring! über Home Assistant: Adresse, Token, To-do-Liste, eigene Zertifizierungsstelle. Ist eine der ersten drei gesetzt, kommen alle drei von hier; leer = Einrichtung in der App (Abschnitt 17.2). Die Zertifizierungsstelle gibt es nur hier (17.4) |
| `STOWLY_HA_SUMMARY_TOKEN` | Token des Sensors für Home Assistant, mindestens 32 Zeichen; leer = der Sensor-Token aus der App, sonst kein Sensor (Abschnitt 18.1) |
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
- **Noch nicht erprobt:** der Ordner `./backups` der automatischen Sicherung auf einer Freigabe von DSM. Dort entscheidet die Windows-ACL der Freigabe über den Zugriff, nicht allein `chown 10001:10001`. Darf Stowly nicht hinein, nimmt es ohne `STOWLY_BACKUP_DIR` den Datenordner und sagt es; mit der Variable ruht die Sicherung (Abschnitt 8.1).

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

Seit 0.4.0 richtet man die Sicherung in der App ein: unter Einstellungen → „Sicherung" oder im Assistenten (Abschnitt 19.2). Es gibt nur noch die **verschlüsselte Sicherung** im Ordner auf dem Server, jede Nacht von selbst und auf Knopfdruck („Jetzt sichern"). Genau diese Dateien lassen sich auch herunterladen. Die unverschlüsselte Sicherung zum Herunterladen aus 0.3.x gibt es nicht mehr.

Eine Sicherung ist eine vollständige, in sich stimmige Kopie der Datenbank, gezogen bei laufendem Betrieb: Bestand, Lösch-Historie, Einkaufsliste, Ereignisprotokoll, Produktbilder, die Liste der Geräte (ohne deren Tokens, nur Prüfsummen), der Hash des Haushalts-Passworts, die Zugangsdaten eingerichteter Drucker, der Schlüssel des Servers für Benachrichtigungen und die Einstellungen aus der App. Nicht darin ist, was daneben im Datenordner liegt (Abschnitt 10): die Zertifizierungsstelle, die Tokens für Home Assistant und den Sensor, der Druckdienst.

### 8.1 Automatische, verschlüsselte Sicherung

Jeden Tag zur eingestellten Uhrzeit (Vorgabe `03:30`, in `STOWLY_TIMEZONE`) legt der Server eine Datei `stowly-JJJJ-MM-TT-HHMM.sqlite3.gz.age` in den Ordner: gepackt und im Format [age](https://age-encryption.org) an **öffentliche Schlüssel** verschlüsselt. Die geheimen Schlüssel dazu hat nur der Haushalt (8.2); wer Server oder Ordner erbeutet, kann die Sicherungen nicht lesen.

- **Aufbewahrung:** die Sicherungen der 7 neuesten Tage, der 4 neuesten Wochen und der 12 neuesten Monate (gezählt werden Tage, Wochen und Monate, *an denen* es eine gibt; nach einem langen Ausfall bleiben also die letzten erhalten). Aufgeräumt wird nur nach einer gelungenen Sicherung und nur unter den eigenen Dateien; andere Dateien im Ordner fasst der Server nie an.
- **Nachholen:** War der Server zur Uhrzeit aus, macht er die Sicherung gleich nach dem Start, auch abends. Scheitert sie, versucht er es jede Stunde wieder, bis eine des Tages gelingt.
- **Auf Knopfdruck:** „Jetzt sichern" legt dieselbe Datei an, höchstens einmal je Minute, auch bei ausgeschaltetem Schalter. Sie zählt als Sicherung des Tages: Die automatische läuft an diesem Tag nicht noch einmal.
- **Ohne Schlüssel** ruht die Sicherung. Sobald es einen gibt, beginnt sie, ohne Neustart; ist die Uhrzeit heute schon vorbei, kommt die erste gleich.
- **Kein Klartext im Ordner:** Der Server schreibt in eine Zwischendatei (`.stowly-backup-….tmp`, schon verschlüsselt, Rechte `0600`) und benennt sie erst um, wenn sie vollständig auf der Platte steht.

**Der Ordner.** Stowly wählt ihn selbst, bei jeder Sicherung neu, in dieser Reihenfolge:

| Ordner im Container | wann |
|---|---|
| `STOWLY_BACKUP_DIR` | wenn die Variable gesetzt ist (8.5). Diesen Ordner legt Stowly nie an, und es weicht nicht aus: Fehlt er oder ist er nicht beschreibbar, ruht die Sicherung, und die App sagt warum. |
| `/backups` | wenn dort ein eigener Ordner eingebunden ist und der Benutzer des Containers (10001) hineinschreiben darf. Bei Docker Compose ist das `./backups` aus `docker-compose.yml`, in DSM ein zweiter Ordner (Abschnitt 19.4). |
| `/data/backups` | sonst, im Datenordner. Stowly legt ihn vor der ersten Sicherung an (Rechte `0700`). |

Ist `/backups` eingebunden, aber nicht beschreibbar, gehen die Sicherungen in den Datenordner, und die App sagt es unter „Sicherung" („Der eigene Ordner wird nicht benutzt"): „Der eigene Ordner /backups ist eingebunden, taugt aber nicht: Der Ordner für Sicherungen ist nicht beschreibbar (Benutzer 10001). Die Sicherungen gehen deshalb in den Datenordner." Abhilfe bei Docker Compose: `sudo chown 10001:10001 backups`; in DSM das Schreibrecht wie in 19.4. Danach nimmt Stowly `/backups` von selbst, ohne Neustart. Ins Log kommt der Hinweis einmal je Start.

**Ein Ordner auf derselben Platte ersetzt keine Kopie außer Haus.** Er hilft gegen Fehlbedienung und kaputte Daten, nicht gegen einen Plattenschaden, Diebstahl, Brand oder einen Fehler, der den ganzen Rechner trifft. Für `/data/backups` gilt das erst recht: Geht der Datenträger kaputt, sind Daten und Sicherungen zugleich weg. Die Dateien deshalb regelmäßig an einen anderen Ort kopieren (anderer Rechner, externe Platte, auch ein Cloud-Speicher: Sie sind verschlüsselt), auf einer Synology etwa mit Hyper Backup oder Cloud Sync, sonst etwa mit `rsync -a <benutzer>@<server>:~/stowly/backups/ /pfad/zur/kopie/`.

### 8.2 Einrichten in der App

Unter Einstellungen → „Sicherung", im Assistenten im Schritt „Sicherung":

1. **Schlüssel erzeugen.** Der Browser erzeugt ein Schlüsselpaar für age, auch über http. Den geheimen Teil (`AGE-SECRET-KEY-1…`) zeigt Stowly nur jetzt: zum Kopieren und mit **Als Datei speichern** als `stowly-schluessel-JJJJ-MM-TT.txt` (dasselbe Format wie von `age-keygen`). **Den geheimen Schlüssel an zwei Orten aufheben**, etwa auf einem USB-Stick und im Passwort-Manager: Nur mit ihm lässt sich eine Sicherung zurückspielen, und Stowly speichert ihn nicht. Erst nach dem Haken „Ich habe ihn gesichert." und mit dem **Haushalts-Passwort** schickt **Schlüssel übernehmen** den öffentlichen Schlüssel (`age1…`) an Stowly; der geheime verlässt das Gerät nie.
2. **Weitere Schlüssel**, höchstens 10: noch einmal „Schlüssel erzeugen", oder **Öffentlichen Schlüssel hinzufügen** für einen, der schon anderswo liegt (etwa aus `age-keygen` auf einem anderen Rechner). Jeder geheime Schlüssel öffnet jede neue Sicherung allein. Einen geheimen Schlüssel schickt die App an dieser Stelle nie an den Server, und der Server lehnt ihn ab. **Entfernen** wirkt nur für neue Sicherungen; ältere lassen sich mit dem entfernten Schlüssel weiter öffnen.

   **Einen Schlüssel hinzuzufügen braucht das Haushalts-Passwort**, auch den ersten, ob erzeugt oder eingefügt; gilt `STOWLY_PASSWORD`, ist es dieses. Wer einen Schlüssel hinzufügt, kann jede künftige Sicherung öffnen, samt Passwort-Hash, Schlüssel des Servers für Benachrichtigungen und Push-Abos. Ein falsches Passwort ergibt „Das Haushalts-Passwort stimmt nicht."; das erzeugte Paar bleibt stehen, und es lässt sich gleich noch einmal versuchen. Falsche Passwörter zählen wie bei der Anmeldung: nach 5 in 5 Minuten 60 Sekunden Sperre, gemeinsam mit der Anmeldung (Abschnitt 3, Hinweise). Entfernen braucht kein Passwort. Hat ein anderes Gerät die Schlüssel inzwischen geändert, sagt die App es; dann neu laden und noch einmal versuchen.
3. **Uhrzeit** (Zeit des Servers, Vorgabe 03:30) und Schalter **Automatische Sicherung**. Ohne Einstellung ist er an. Aus heißt: Stowly sichert nicht von selbst; „Jetzt sichern" geht trotzdem.
4. **Ordner** zeigt, wohin die Sicherungen gehen (8.1). Liegt er im Datenordner, steht der Rat dabei, einen zweiten Ordner einzubinden (19.4) oder den Ordner wegzukopieren.
5. **Jetzt sichern** als Probe. Im Assistenten ist der Schritt erledigt, sobald die Sicherung wirkt und eine gelungen ist.
6. **Schlüssel prüfen:** den aufgehobenen geheimen Schlüssel einfügen oder die Schlüsseldatei wählen. Der Browser errechnet daraus den öffentlichen und vergleicht ihn mit den gespeicherten: „Der Schlüssel passt" oder „Der Schlüssel passt nicht". Nichts davon geht an den Server. Ab und zu wiederholen, mit jedem aufgehobenen Schlüssel.

Unter „Ordner und Sicherungen" stehen die Sicherungen im Ordner, neueste zuerst (höchstens 50), je mit **Herunterladen**: die verschlüsselte Datei, wie sie dort liegt. Öffnen lässt sie sich mit dem geheimen Schlüssel, in Stowly (8.3) oder mit `age` (8.4). Darüber zeigt die App die letzte gelungene Sicherung mit Größe, einen Fehler und den nächsten Versuch; nach 48 Stunden ohne gelungene Sicherung warnt sie. Ist die Sicherung nur zum Teil eingerichtet, nennt sie den Grund, etwa „Es fehlt ein öffentlicher Schlüssel (in der App oder in STOWLY_BACKUP_RECIPIENTS)." oder „Die automatische Sicherung ist ausgeschaltet."

Was aus der Umgebung kommt (8.5), ist in der App gesperrt und so beschriftet.

### 8.3 Zurückspielen in der App

Stowly nimmt seine verschlüsselten Sicherungen (`.sqlite3.gz.age`), dazu gepackte (`.sqlite3.gz`) und reine Datenbanken (`.sqlite3`, etwa die Sicherung zum Herunterladen aus 0.3.x); nur die verschlüsselten brauchen einen Schlüssel. Eine Datei darf höchstens 512 MiB groß sein, entpackt höchstens 2 GiB, und auf der Platte braucht es etwa dreimal so viel Platz, wie die Datei groß ist. Ein Reverse Proxy davor kann große Dateien schon vorher abweisen. Kommen beim Hochladen 60 Sekunden lang keine Daten oder dauert es länger als 20 Minuten, bricht Stowly ab und löscht das schon Hochgeladene. Eine hochgeladene Datei und eine geprüfte Sicherung gelten 30 Minuten; was abgelaufen ist, räumt Stowly alle 5 Minuten weg. Ein neues Hochladen oder Prüfen ersetzt das vorige erst, wenn es gelingt.

**Laufender Stowly:** Einstellungen → „Sicherung" → „Zurückspielen …":

1. **Datei wählen.** Sie wird hochgeladen, mit Fortschritt.
2. **Schlüssel eingeben:** den geheimen Schlüssel einfügen oder die Schlüsseldatei wählen, dann **Prüfen**. Stowly entschlüsselt im Arbeitsspeicher, prüft die Datenbank genau und bringt eine Kopie auf den eigenen Stand. Den Schlüssel speichert und loggt es nie. Passt er nicht, lässt sich gleich ein anderer versuchen, ohne neues Hochladen.
3. **Was in der Sicherung steckt:** Stand, Produkte, Vorräte, Zonen, Einkaufsliste, Geräte und ob ein Haushalts-Passwort darin ist.
4. Das **jetzige Haushalts-Passwort** eingeben, **Zurückspielen …**, die Rückfrage „Sicherung jetzt einspielen?" mit **Einspielen** bestätigen.

Stowly startet dann neu und tauscht die Datenbank, bevor etwas sie öffnet. Das dauert meist unter einer Minute; danach lädt die Seite neu. Die geprüfte Sicherung gilt 30 Minuten, danach braucht es ein neues Hochladen. Was danach gilt:

- **Der Bestand kommt aus der Sicherung.** Aus dem laufenden Stowly bleiben die Geräte samt Anmeldungen und Sperren, das Haushalts-Passwort, für Benachrichtigungen der Schlüssel des Servers und die Abos, die Einstellungen aus der App und die Läufe der Aufgaben. Niemand wird abgemeldet, und gesperrte Geräte bleiben gesperrt. `STOWLY_PASSWORD` geht weiter vor.
- **Alle Geräte holen den Bestand beim nächsten Abgleich vollständig neu** (neue Kennung des Datenbestands). Auf den Handys ist nichts zu tun. Änderungen, die ein Gerät noch nicht abgeglichen hatte, sendet es erneut; was schon in der Sicherung steckt, erkennt der Server und führt es nicht doppelt aus.
- Was nach der Sicherung geschah und schon abgeglichen war, ist weg: Das ist der Sinn des Zurückspielens.
- **Kennungen:** Packungen, die erst nach der Sicherung entstanden, behalten ihre Kennungen als reserviert. So bekommt kein schon gedrucktes Etikett eine Kennung ein zweites Mal.
- **Bring!:** Zu welcher Liste in Home Assistant die gespiegelten Artikel gehören, kommt mit der Sicherung (17.5). Eine Sicherung aus 0.3.x weiß das nicht: Dann vergisst Stowly diese Artikel, ohne etwas abzuhaken, und spiegelt die offenen Einträge neu.
- **Was wegfällt:** Produktbilder, die kein JPEG, PNG oder WebP sind oder deren Inhalt nicht dazu passt (das Produkt hat dann kein Bild; das Log nennt ihre Zahl), und Kopplungen eines Pi, die in der Sicherung noch offen waren: Sie gelten als abgebrochen, für den Pi einen neuen Kopplungscode erzeugen.
- **Rückgängig:** Sieben Tage lang hebt Stowly die Datenbank von vor dem Zurückspielen auf (`/data/restore/previous.sqlite3`). Unter „Zurückspielen" stehen so lange **Rückgängig** (holt sie auf demselben Weg zurück, mit Neustart; auch das lässt sich wieder umkehren) und **Alte Datenbank löschen** (danach geht Rückgängig nicht mehr). Nach sieben Tagen löscht Stowly sie selbst.

**Erster Start auf einem neuen Rechner** (Umzug, Plattenausfall): „Willkommen bei Stowly" bietet neben dem ersten Passwort **Aus einer Sicherung wiederherstellen**:

1. **Sicherung wählen**, dann wie oben Schlüssel und Vorschau.
2. Das **Passwort aus der Sicherung** eingeben; das zeigt zugleich, dass die Sicherung echt ist. Enthält sie keins, legt man ein neues fest (mindestens 8 Zeichen); die Geräte aus der Sicherung gelten dann nicht mehr.
3. Den **Namen dieses Geräts** eingeben, **Wiederherstellen**.

Stowly startet neu, und dieses Gerät ist danach angemeldet. Weil die Zertifizierungsstelle auf dem neuen Rechner neu ist, beginnt der Assistent mit der sicheren Verbindung (Abschnitt 19.2). Die Tokens für Home Assistant und den Sensor stehen in keiner Sicherung und sind neu einzutragen (20.4). Das alles geht nur, solange es kein Passwort gibt (auch keines in `STOWLY_PASSWORD`), und nur im Heimnetz, wie das erste Passwort. Ein erstes Passwort und dieses Zurückspielen schließen sich aus; wer zuerst kommt, gewinnt. Ein Rückgängig gibt es beim ersten Start nicht.

**Über http** geht der geheime Schlüssel unverschlüsselt durchs Heimnetz; die App weist darauf hin („Unverschlüsselte Verbindung"). Sicherer ist es über die HTTPS-Adresse von Stowly (Abschnitt 20).

**Wenn etwas nicht passt,** sagt die App warum:

| Meldung | Grund |
|---|---|
| „Der Schlüssel passt nicht zu dieser Sicherung." | Die Sicherung ist für einen anderen Schlüssel verschlüsselt. „Schlüssel prüfen" (8.2) zeigt, ob ein aufgehobener Schlüssel zu den gespeicherten passt. |
| „Das ist kein geheimer age-Schlüssel (AGE-SECRET-KEY-1…)." | Etwas anderes eingefügt; für einen öffentlichen Schlüssel (`age1…`) gibt es einen eigenen Satz. |
| „Das ist keine Sicherung von Stowly …", „Das ist keine Datenbank von Stowly." | eine fremde Datei, oder eine Datenbank mit anderem Aufbau, mit Triggern oder Views (unter welchem Namen auch immer). Der Aufbau muss Zeichen für Zeichen dem aus den Migrationen gleichen; was abweicht, nennt das Log. |
| „Die Datei ist beschädigt oder unvollständig." | abgeschnitten oder verändert: eine andere Sicherung nehmen |
| „Die Sicherung stammt von einem neueren Stowly …" | erst Stowly aktualisieren |
| „Gerade läuft ein Update. Zurückspielen geht erst danach." | Updates und Zurückspielen schließen sich aus; umgekehrt wartet auch ein Update. |
| „Beim Hochladen kamen 60 Sekunden lang keine Daten …", „Das Hochladen dauerte länger als 20 Minuten …" | Verbindung zu langsam oder unterbrochen: noch einmal hochladen, am besten im Heimnetz. |
| „Zu viele Versuche. Nächster Versuch in …" | Hochladen und Prüfen gehen einzeln und höchstens sechsmal in 10 Minuten; falsche Passwörter zählen wie bei der Anmeldung. |
| „Das Zurückspielen ist gescheitert: … Die bisherige Datenbank läuft weiter." | Beim Neustart ging etwas schief; der Grund steht im Satz und im Log. Stowly startet dann normal, ohne Neustart-Schleife. Kommt der Neustart erst mehr als 10 Minuten nach dem Einspielen, verwirft Stowly die Sicherung. |

Für den Neustart ersetzt Stowly seinen eigenen Prozess; der Container läuft weiter. Gelingt das nicht, endet der Prozess, und Docker startet den Container neu (dafür muss der automatische Neustart an sein, 19.1); getauscht wird dann dort.

### 8.4 Notweg auf der Kommandozeile

Nur, wenn es in der App nicht geht, etwa bei einem Stowly vor 0.4.0 oder wenn er gar nicht mehr startet, und mit Docker Compose. Dafür braucht es `age` auf einem eigenen Rechner (Debian `sudo apt install age`, macOS `brew install age`; für Windows nennt die Seite des Projekts die Wege). Die Schlüsseldatei aus der App (8.2) nimmt `age` so, wie sie ist.

**Probe-Entschlüsselung**, ab und zu und mit jedem geheimen Schlüssel:

```
age -d -i stowly-schluessel-2026-11-16.txt stowly-2026-11-16-0330.sqlite3.gz.age | gunzip | head -c 15
```

Es muss `SQLite format 3` erscheinen. Gründlicher, mit dem Programm `sqlite3`: `age -d -i stowly-schluessel-….txt stowly-….sqlite3.gz.age | gunzip > probe.sqlite3`, dann `sqlite3 probe.sqlite3 "PRAGMA integrity_check; SELECT COUNT(*) FROM packages;"` (zeigt `ok` und die Zahl der Packungen); `probe.sqlite3` danach löschen.

**Zurückspielen:** entschlüsseln und entpacken, Server anhalten, Datei ersetzen, neue Kennung, starten:

```
age -d -i stowly-schluessel-2026-11-16.txt stowly-2026-11-16-0330.sqlite3.gz.age | gunzip > stowly-2026-11-16.sqlite3
docker compose stop
docker compose run --rm -T --no-deps stowly sh -c \
  'rm -f /data/stowly.sqlite3-wal /data/stowly.sqlite3-shm && cat > /data/stowly.sqlite3' \
  < stowly-2026-11-16.sqlite3
docker compose run --rm --no-deps stowly python -m stowly --new-dataset
docker compose up -d
```

- Der dritte Befehl schreibt die Datei als der Benutzer des Containers ins Volume; so stimmen die Rechte.
- `--new-dataset` gibt dem Datenbestand eine neue Kennung und endet; danach holen alle Geräte den Bestand vollständig neu. Eine Sicherung von Stowly bringt zwar eine eigene Kennung mit; war dieselbe Datei aber schon einmal eingespielt, kennen die Geräte sie bereits. Andere Kopien der Datenbank (Schnappschuss des Volumes, Kopie der Datei bei angehaltenem Server, Sicherung des ganzen Rechners) tragen die alte; ohne neue Kennung behielten die Geräte Packungen, die es auf dem Server nicht mehr gibt. Der Befehl schadet nie.
- **Anders als in der App** behält dieser Weg nichts aus der laufenden Datenbank: Geräte, Passwort, Abos für Benachrichtigungen und die Einstellungen aus der App kommen aus der Sicherung, und Kennungen von Packungen, die erst nach der Sicherung entstanden, sind nicht reserviert. Geräte, die erst nach der Sicherung angemeldet wurden, melden sich neu an; ihre lokalen Daten und ungesendeten Änderungen bleiben dabei erhalten. Abos für Benachrichtigungen, die nach der Sicherung entstanden sind, fehlen; die App meldet sich beim nächsten Start von selbst neu an.

### 8.5 Sicherung über die `.env`

Mit Docker Compose lässt sich die Sicherung weiter in der `.env` einstellen. Alle drei Variablen sind freiwillig; was dort steht, geht vor und ist in der App gesperrt:

| Variable | Wirkung |
|---|---|
| `STOWLY_BACKUP_RECIPIENTS` | öffentliche Schlüssel (`age1…`), getrennt durch Komma oder Leerzeichen. Damit ist die Sicherung fest an; Schlüssel und Schalter sind in der App nur zu sehen. Ein geheimer Schlüssel hier beendet den Start mit einem Konfigurationsfehler, der ihn nicht zitiert. |
| `STOWLY_BACKUP_TIME` | Uhrzeit `HH:MM`; leer = die Uhrzeit aus der App, sonst 03:30 |
| `STOWLY_BACKUP_DIR` | Ordner im Container; leer = Wahl nach 8.1. Ein gesetzter Ordner gilt fest, auch wenn er nicht taugt. |

Öffentliche Schlüssel für die `.env` entstehen auf einem eigenen Rechner, nicht auf dem Server, mit `age-keygen -o stowly-schluessel-1.txt`; jeder Aufruf zeigt den öffentlichen Schlüssel (`Public key: age1…`), er steht auch in der Datei. Die Dateien mit den geheimen Schlüsseln (`AGE-SECRET-KEY-1…`) gehören **nie** auf den Server.

Den Ordner `./backups` (in `docker-compose.yml` nach `/backups` eingebunden) im Ordner des Repositorys anlegen und dem Benutzer des Containers geben:

```
mkdir -p backups
sudo chown 10001:10001 backups
sudo chmod 700 backups
```

Fehlt der Ordner auf dem Rechner, legt Docker ihn beim Start für root an; dann darf Stowly nicht hinein und nimmt ohne `STOWLY_BACKUP_DIR` den Datenordner (8.1).

Die frühere `.env.example` (bis 0.3.x) setzte `STOWLY_BACKUP_DIR=/backups` und `STOWLY_BACKUP_TIME=03:30`. Wer das übernommen hat, behält beides aus der `.env`: Die Uhrzeit ist in der App gesperrt, und taugt `./backups` nicht, ruht die Sicherung statt auszuweichen. Ohne die beiden Zeilen nimmt Stowly `/backups` trotzdem, sobald es hineinschreiben darf, und die Uhrzeit lässt sich in der App einstellen.

Beim Start nennt das Log die wirksame Einrichtung: „Automatische Sicherung täglich um 03:30 nach /backups an 2 Schlüssel." oder „Keine automatische Sicherung: …" mit dem Grund.

## 9. Aktualisieren

Läuft Stowly mit dem fertigen Image von GitHub, geht ein Update per Knopf in der App (9.2) oder von Hand mit `docker compose pull` (9.3). Wer selbst baut:

```
# vorher in der App „Jetzt sichern" und die Sicherung herunterladen (Abschnitt 8)
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

Stowly erscheint als fertiges Image auf GitHub (`ghcr.io/<konto>/stowly:X.Y.Z`) und seit 0.3.0 auch auf Docker Hub (`<konto>/stowly`). Ob der Server nach neuen Versionen fragt, entscheidet seit 0.3.0 der Schalter unter Einstellungen → „Aktualisierung"; `STOWLY_UPDATE_REPO` in der `.env` schaltet es fest ein. Der Server merkt selbst, wenn eine neue Version als „latest" veröffentlicht ist.

Es gibt zwei Updater. Für einen Container aus der Docker-Oberfläche (Abschnitt 19) ist es der **Updater-Container** (19.3). Für Docker Compose ist es das Skript `updater/stowly-update.sh`, eingerichtet wie unten beschrieben. Die App zeigt sie unter Einstellungen → „Aktualisierung" samt Änderungen, und je Version kommt einmal eine Push-Nachricht. Ein Tipp auf „Update installieren" legt eine Anforderung ab. Ausgeführt wird sie vom **Updater** auf dem Rechner, denn der Server selbst darf Docker nicht bedienen. Regeln und Dateien: [`integrationen.md`](integrationen.md), Abschnitt 10.

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
     - Reiter „Zeitplan": täglich; erste Ausführungszeit **00:00**, Häufigkeit **alle 1 Minute(n)**, letzte Ausführungszeit **23:59**. Die letzte Ausführungszeit erscheint erst, wenn eine Häufigkeit gewählt ist. Prüfen lässt sich das Ergebnis in `/etc/crontab`: In der Zeile `synoschedtask --run id=…` der Aufgabe müssen bei den Stunden 0 bis 23 und bei den Minuten 0 bis 59 stehen. Steht dort nur eine Stunde, läuft der Updater nur in dieser Stunde, und die App meldet, dass er sich nicht meldet.
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
- Eine ältere Version installiert keiner der beiden Updater: Zurück geht es nur mit der Sicherung (9.3).

**Grenzen:**
- Der Updater tauscht nur das Image. Ändert eine Version `docker-compose.yml`, die `.env` oder den Updater selbst, steht das im Changelog unter „Von Hand" und wird einmal von Hand nachgezogen.
- Der Updater läuft als root aus dem Projektordner: Wer diesen Ordner ändern darf, kann darüber Befehle als root ausführen. Der Ordner gehört deshalb nur Administratoren.
- Die Docker-Oberfläche von DSM nicht zum Ändern eines Compose-Containers benutzen. Compose und der Updater sind dann nicht mehr im Bilde.
- Seit 0.3.0 folgt der Updater in `update/` keinen symbolischen Links mehr. Wer von 0.2.x kommt, kopiert den Ordner `updater/` einmal neu (Changelog 0.3.0).

### 9.3 Von Hand, mit dem fertigen Image

Ohne Updater, oder wenn er streikt: in der App „Jetzt sichern" und die Sicherung herunterladen (Abschnitt 8), `STOWLY_VERSION` in der `.env` auf die neue Version setzen, dann

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
3. `git push` und `git push origin vX.Y.Z`. GitHub Actions (`.github/workflows/release.yml`) testet, baut das Image ohne die Brother-Bibliothek, lädt es hoch und veröffentlicht danach das Release als „latest". Erst dann sieht es der Server. Als „latest" (Image `:latest` und Release) gilt nur die höchste Version unter allen Tags `vX.Y.Z`; die vorige verliert die Markierung dabei von selbst. Eine später nachgereichte ältere Nummer bekommt sie nicht.

Ein Tag mit Zusatz (`vX.Y.Z-rc.1`) durchläuft dasselbe als Vorabversion: Das Image heißt `:X.Y.Z-rc.1`, es gibt kein `:latest`, und das Release ist als Vorabversion markiert. Der Server bietet es nicht an; so lässt sich die Pipeline gefahrlos ausprobieren.

Beim allerersten Image muss das Paket auf GitHub einmal öffentlich gestellt werden (Paket `stowly` → Package settings → Change visibility → Public). Sonst kann der Rechner es nicht ohne Anmeldung laden.

**Docker Hub** (seit 0.3.0, damit DSM das Image über seine Suche findet): einmal ein kostenloses Konto anlegen und dort einen Zugangs-Token mit „Read & Write" erzeugen. Im Repository auf GitHub unter Settings → Secrets and variables → Actions die Secrets `DOCKERHUB_USERNAME` und `DOCKERHUB_TOKEN` sowie die Variable `DOCKERHUB_IMAGE` (`<konto>/stowly`) anlegen. Fehlt der Token, baut die Pipeline nur für ghcr.io. Die Kurzbeschreibung des Repositorys auf Docker Hub, die DSM in der Suche zeigt, einmal von Hand setzen. Im Image stehen dann `STOWLY_IMAGE_REF=docker.io/<konto>/stowly` und `STOWLY_IMAGE_TAG` mit dem Tag des Releases (beide für den Befehl des Updater-Containers) und `STOWLY_UPDATE_REPO_DEFAULT` (für den Schalter in der App).

## 10. Wo die Daten liegen

| Was | Wo |
|---|---|
| Datenbank mit allem: Bestand, Einkaufsliste, Produktbilder, Geräte und ihre Abos für Benachrichtigungen, Ereignisprotokoll, der Schlüssel des Servers für Benachrichtigungen, was Stowly zuletzt nach Bring! geschrieben hat, die Einstellungen aus der App (ohne Tokens) | Docker-Volume `stowly-data`, im Container `/data/stowly.sqlite3` (im Betrieb dazu `-wal` und `-shm`) |
| Druckdienst des Servers: Auftragsspeicher samt `boot_id`, Bilder des Bild-Treibers | im selben Volume unter `/data/print/` (`jobs.sqlite3`, `images/`). Nicht in den Sicherungen; geht er verloren, fragt die App bei offenen Etiketten nach, statt doppelt zu drucken |
| Sicherungen, verschlüsselt | `/backups`, wenn dort ein eigener Ordner eingebunden ist (Docker Compose: `backups` im Ordner des Repositorys; DSM: Abschnitt 19.4), sonst im Volume unter `/data/backups/` (Abschnitt 8.1); die geheimen Schlüssel dazu nur beim Haushalt |
| Tokens aus der App: für Home Assistant und den Sensor | im Volume unter `/data/secrets/` (Ordner `0700`, Dateien `0600`); nicht in den Sicherungen (Abschnitte 17.2, 18.1) |
| Zurückspielen: die hochgeladene Datei, die geprüfte Kopie und 7 Tage lang die Datenbank von vor dem Zurückspielen (`previous.sqlite3`) | im Volume unter `/data/restore/` (`0700`); nicht in den Sicherungen (Abschnitt 8.3) |
| Einstellungen des Servers | `.env` im Ordner des Repositorys bzw. die Umgebung des Containers, samt Passwort und Tokens, soweit dort gesetzt; was in der App eingestellt wurde (Push-Kontakt, Updates, Sicherung, Adresse und Liste von Home Assistant, Stand der Einrichtung), in der Datenbank (`server_config`), das Passwort aus der App nur als Hash, die Tokens aus der App in `/data/secrets/` |
| Zertifizierungsstelle und Zertifikat für HTTPS (Abschnitt 20) | im Volume unter `/data/tls/`; nicht in den Sicherungen, beim Umzug den ganzen Datenordner mitnehmen |
| eigene Anpassung an den Proxy, die Zertifizierungsstelle für Home Assistant | `docker-compose.override.yml`, falls angelegt; die Zertifizierungsstelle etwa als `ha-ca.pem` im Ordner des Repositorys (Abschnitt 17.4) |
| lokale Kopie je Gerät, ungesendete Änderungen, Token | im Browser-Speicher des Handys (IndexedDB) |

Das Volume findet `docker volume inspect <ordnername>_stowly-data` (unter Debian üblicherweise `/var/lib/docker/volumes/…/_data`). `docker compose down` lässt es bestehen; erst `docker compose down -v` löscht es und damit den ganzen Haushalt. Beim Container per Mausklick (Abschnitt 19) ist der Datenordner der Ordner, der unter `/data` eingebunden ist, etwa `docker/stowly`.

**Was neben der Datenbank liegt** (`/data/tls`, `/data/secrets`, `/data/restore`, `/data/print`), steht in keiner Sicherung. Wer umzieht, nimmt deshalb den ganzen Datenordner mit (Abschnitt 20.4). Sonst entsteht eine neue Zertifizierungsstelle, und die Tokens für Home Assistant und den Sensor sind neu einzutragen.

Im Log des Servers (`docker compose logs stowly`) stehen Zugriffe und Hinweise, nie Passwort, Tokens oder ein geheimer Schlüssel.

## 11. Wenn etwas nicht geht

| Beobachtung | Wahrscheinliche Ursache |
|---|---|
| `/api/health` zeigt `"configured": false`; die App zeigt „Willkommen bei Stowly" | Es gibt noch kein Passwort. In der App vergeben (Abschnitt 19.2) oder `STOWLY_PASSWORD` setzen und neu starten. |
| Statt der App erscheint eine Seite „Stowly kann nicht in seinen Datenordner schreiben" | Der eingebundene Ordner gehört einem anderen Benutzer. Abhilfe steht auf der Seite (Abschnitt 19.1). |
| `http://<NAS>:8010` lädt nicht, der Container läuft aber | In DSM steht die Zahl in der Spalte „Container-Port" statt „Lokaler Port"; links steht dann eine Zahl wie 49159. Container anhalten, bearbeiten, links 8010 und 8443 eintragen, rechts 8010 und 8443 (Abschnitt 19.1). |
| Die App meldet „Noch keine sichere Verbindung", obwohl das Zertifikat installiert ist | iPhone: Schalter unter Zertifikatsvertrauenseinstellungen aus; Windows: Browser nicht neu gestartet; oder Port 8443 in DSM in der falschen Spalte („Container-Port" statt „Lokaler Port", Abschnitt 19.1). |
| `docker compose up` bricht ab: „env file … not found" | `.env` fehlt: `cp .env.example .env` |
| Die Startseite zeigt „die Web-App ist noch nicht gebaut" (Status 503) | Die Web-App fehlt im Image: Der Bau der ersten Stufe ist gescheitert oder `STOWLY_WEB_DIR` wurde verstellt. |
| Der Proxy meldet „502 Bad Gateway" | Er erreicht den Container nicht: Tabelle in Abschnitt 4.3 (gemeinsames Netz oder `STOWLY_PUBLISH`). |
| Zertifikatswarnung auf dem Handy | Wurzelzertifikat nicht installiert, auf dem iPhone das volle Vertrauen nicht eingeschaltet, oder dem Zertifikat fehlt der Subject Alternative Name. |
| Die App meldet, der Server sei nicht erreichbar, obwohl die Adresse im Browser aufgeht | Der Proxy liefert unter `/api/health` etwas anderes als Stowly; Probe B3. |
| Scannen fehlt oder die App lässt sich nicht installieren | Die App läuft über `http://` statt über die HTTPS-Adresse (Abschnitt 6). |
| Eine neue Version kommt nicht auf den Handys an | „Cache Assets" im Proxy ist an; Probe B4. |
| Gescannte Produkte bleiben ohne Namen | Der Container kommt nicht ins Internet, oder Open Food Facts kennt den Barcode nicht; Probe A14. Der Name lässt sich immer von Hand eintragen. |
| Nach dem Zurückspielen auf der Kommandozeile: Fehler „readonly database" im Log | Die Datei gehört nicht dem Benutzer des Containers. Nach Abschnitt 8.4 einspielen oder `chown 10001:10001` auf die Datei im Volume. |
| Beim Zurückspielen: „Der Schlüssel passt nicht zu dieser Sicherung." | Die Sicherung ist für einen anderen Schlüssel verschlüsselt. Unter „Sicherung" zeigt „Schlüssel prüfen", ob ein aufgehobener Schlüssel zu den gespeicherten passt (Abschnitt 8.2). |
| Unter „Zurückspielen" steht „Das Zurückspielen ist gescheitert: …" | Beim Neustart ging etwas schief; die bisherige Datenbank läuft weiter. Grund im Satz und im Log (Abschnitt 8.3). |
| „Beim ersten Start lässt sich eine Sicherung nur im Heimnetz zurückspielen …" | Die Seite ist über einen Namen oder eine Adresse außerhalb des Heimnetzes offen: Stowly über seine IP-Adresse öffnen, etwa `http://192.168.1.10:8010`. |
| Die Anmeldung wird trotz richtigem Passwort abgelehnt (zu viele Fehlversuche) | Sperre nach 5 falschen Passwörtern; 60 Sekunden warten. |
| Etiketten für einen Drucker am Server bleiben „ausstehend" | Sagt die App „Der Druckdienst des Servers läuft nicht": Im Log steht „Der Druckdienst des Servers ließ sich nicht starten", meist ist `/data/print` nicht beschreibbar (`docker compose exec stowly ls -ld /data/print`); `/print/…` antwortet dann mit 503. Sonst ist das Etikett noch nicht abgeglichen; die App versucht es nach dem nächsten Abgleich wieder („Jetzt drucken" gleicht vorher ab). |
| Im Log „Schrift DejaVuSans… fehlt" | Die Etiketten entstehen mit einer Ersatzschrift ohne Umlaute. Die Schriften liegen im Paket `stowly_print` (Ordner `fonts`) und im Image zusätzlich als `fonts-dejavu-core`; fehlen sie an beiden Stellen, ist die Installation unvollständig: Image neu bauen (`docker compose build --no-cache`), ohne Docker `sudo apt install fonts-dejavu-core` und den Server neu starten. |
| Ein Brother am Server meldet `config` | Modell, Adresse oder Rolle passen nicht, oder die Brother-Bibliothek fehlt; Grund im Log (Abschnitt 14). |
| Der Container startet nicht; im Log „Konfigurationsfehler: STOWLY_…" | Ein Wert in `.env` hat die falsche Form: Die Meldung nennt die Variable und, außer bei Tokens und Schlüsseln, den Wert. Korrigieren, dann `docker compose up -d`. |
| Die App meldet unter „Sicherung": „Der Ordner für Sicherungen fehlt." | Der Ordner aus `STOWLY_BACKUP_DIR` ist nicht eingebunden oder fehlt auf dem Rechner. Einbindung prüfen oder die Variable leeren; dann wählt Stowly den Ordner selbst (Abschnitt 8.1). |
| „… ist nicht beschreibbar (Benutzer 10001)." | Mit `STOWLY_BACKUP_DIR`: `sudo chown 10001:10001 backups`; der nächste Versuch kommt nach einer Stunde von selbst, oder gleich mit „Jetzt sichern". |
| Unter „Sicherung" steht „Der eigene Ordner wird nicht benutzt" | `/backups` ist eingebunden, aber Benutzer 10001 darf nicht hineinschreiben; die Sicherungen gehen so lange in den Datenordner. Docker Compose: `sudo chown 10001:10001 backups`; DSM: Schreibrecht wie in Abschnitt 19.4. |
| Die App nennt bei der Sicherung „Es fehlt ein öffentlicher Schlüssel …" | Etwas ist eingestellt (Uhrzeit, Schalter oder Ordner), aber es gibt keinen Schlüssel: in der App „Schlüssel erzeugen" (Abschnitt 8.2). |
| „Benachrichtigungen" fehlen in der App oder melden „nicht eingerichtet" | `STOWLY_PUSH_CONTACT` ist leer (Abschnitt 15). |
| Die Testnachricht meldet „Der Push-Dienst lehnt ab (403). Stimmt STOWLY_PUSH_CONTACT?" | Der Absender ist keine gültige `mailto:`- oder `https:`-Adresse; Apple prüft das streng. |
| Die Testnachricht meldet „nicht erreichbar" | Der Container kommt nicht ins Internet (die Push-Dienste von Apple, Google, Mozilla und Microsoft). |
| Die Tagesnachricht kommt nicht | Sie kommt nur, wenn seit der letzten etwas neu bald fällig oder abgelaufen ist, und nur bis 21 Uhr (Abschnitt 15.1). Unter „Einstellungen" nennt die App den letzten Lauf und einen Fehler; im Log steht „Tagesnachricht: nichts Neues." oder „… kein Abo erreicht". |
| Unter „Home Assistant" steht „Home Assistant lehnt den Token ab." | Der Token ist falsch, oder er wurde in HA gelöscht: neuen langlebigen Token anlegen (Abschnitt 17.2) und in der App unter „Zugangs-Token" → „Ersetzen" eintragen; aus der `.env`: `STOWLY_HA_TOKEN` ändern, `docker compose up -d`. |
| „Der Token für Home Assistant fehlt (steht in keiner Sicherung); bitte neu eintragen." | Nach dem Zurückspielen auf einem neuen Rechner oder einem Umzug ohne Datenordner: den Token in der App neu eintragen (Abschnitt 17.2). Ebenso „Der Sensor-Token fehlt …": neu erzeugen und in HA eintragen (18.1). |
| „Die Liste todo.… gibt es in Home Assistant nicht." | Die Liste stimmt nicht: in der App „Verbindung prüfen" und eine Liste wählen; aus der `.env`: `STOWLY_HA_TODO_ENTITY`, in HA unter „Entwicklerwerkzeuge → Zustände" nach `todo.` suchen. |
| „Die Liste ist in Home Assistant gerade nicht verfügbar." | HA startet gerade neu, oder die Integration Bring! hat ein Problem (in HA unter „Geräte & Dienste"). Stowly versucht es alle zwei Minuten wieder; die Einkaufsliste in Stowly bleibt, wie sie ist. |
| „Home Assistant ist nicht erreichbar." | Adresse falsch (in der App oder in `STOWLY_HA_URL`), ein Name auf `.local` (löst im Container nicht auf: IP nehmen), Firewall oder HA aus. Probe aus dem Container: `docker compose exec stowly python -c "import httpx2; print(httpx2.get('http://192.168.1.20:8123/api/').status_code)"` zeigt `401` (erreichbar; ohne Token lehnt HA ab). |
| „… Zertifikat nicht vertraut, siehe STOWLY_HA_CA." | HA läuft per https mit eigenem Zertifikat: Abschnitt 17.4. |
| „Home Assistant antwortet mit …" | Ein Fehler in HA; Einzelheiten im Log von HA, bei Stowly steht nur Status und Pfad. „… kennt todo.get_items nicht so (400)": HA liefert über seine Schnittstelle keine Antworten von Diensten (`?return_response`); HA aktualisieren. |
| Ein Eintrag erscheint nicht in Bring! | Er ist keine zwei Minuten offen, oder er hat keinen Namen (ein Platzhalter, der noch auf Open Food Facts wartet), oder in Bring! steht schon ein Artikel desselben Namens: Dann bindet Stowly den Eintrag an ihn, statt einen zweiten anzulegen (Abschnitt 17.1). |
| Der Sensor in HA ist „nicht verfügbar", im Log von HA steht 401 | In `secrets.yaml` fehlt `Bearer ` vor dem Token, oder er stimmt nicht mit dem Sensor-Token überein, etwa nach „Neu erzeugen" (Abschnitt 18.1). Bei 503: Es gibt keinen Sensor-Token, weder aus der App noch aus `STOWLY_HA_SUMMARY_TOKEN`. Bei einem Fehler zum Zertifikat: Abschnitt 18.3. |
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

Jede Antwort der Web-App trägt eine Content-Security-Policy (Kopfzeile `Content-Security-Policy`). Sie verbietet Inline-Skripte und fremde Quellen und schränkt so ein, was eingeschleuster Code im Browser tun könnte. Die Schnittstelle (`/api`) und der Druckdienst (`/print`) liefern keine Seiten und tragen keine; einzig die Produktbilder unter `/api/images` kommen seit 0.4.0 mit `default-src 'none'; sandbox`, damit der Browser sie nur als Bild nimmt.

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

Seit 0.3.0 koppelt man den Pi mit einem Befehl, den die App zeigt: im Einrichtungsassistenten (Abschnitt 19.2) oder unter Drucker → „Raspberry Pi koppeln". Der Pi lädt alles von Stowly, bekommt ein Zertifikat der CA von Stowly (Abschnitt 20), und der Drucker erscheint von selbst in der App. Für den Befehl muss Port 8010 im Heimnetz erreichbar sein. Eigene Anleitung samt Prüfliste und dem Weg von Hand: [`../pi/README.md`](../pi/README.md).

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
- Den Schlüssel, mit dem der Server seine Nachrichten unterschreibt, legt er beim ersten Start selbst an und bewahrt ihn in der Datenbank auf (er kommt mit jeder Sicherung mit). Beim Zurückspielen in der App behält ein laufender Stowly seinen Schlüssel und die Abos (Abschnitt 8.3). Kommt der Schlüssel aus einer älteren Sicherung (Notweg, 8.4), melden sich die Geräte beim nächsten Start von selbst neu an.
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

„Heute" (für das MHD in Sensor und Tagesnachricht, die Monate der Statistik, die Dateinamen der Sicherungen) und alle Uhrzeiten (die der Sicherung und die der Tagesnachricht, beide in den Einstellungen der App) gelten in `STOWLY_TIMEZONE`, Vorgabe `Europe/Berlin`. Erlaubt ist jeder IANA-Name, genau so geschrieben (`Europe/Vienna`, `UTC`); ein unbekannter Name beendet den Start mit einem Konfigurationsfehler. Die Zeitzonendaten bringt Stowly selbst mit; die Variable `TZ` des Containers spielt dafür keine Rolle. Gespeicherte Zeitpunkte sind immer UTC; die App zeigt sie in der Zeitzone des Handys und nennt die Zeitzone des Servers dazu, wenn sie abweicht.

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

Seit 0.4.0 geht das in der App, ohne Neustart. In HA:

1. Die Integration **Bring!** einrichten (Einstellungen → Geräte & Dienste → Integration hinzufügen → Bring!). Jede Liste von Bring! erscheint als To-do-Liste, etwa `todo.zuhause` (Bring! nennt seine erste Liste „Zuhause"). Nicht verwechseln mit der eingebauten Einkaufsliste von HA, die bei deutscher Sprache `todo.einkaufsliste` heißt.
2. Einen **eigenen HA-Benutzer** für Stowly anlegen (Einstellungen → Personen → Benutzer). Administratorrechte sollte er nicht brauchen (Prüfliste J1). So lässt sich der Zugang später einzeln sperren, und im Verlauf von HA steht, was Stowly geändert hat.
3. Als dieser Benutzer anmelden, dann Profil → Sicherheit → **Langlebige Zugangs-Token** → Token erstellen (Name „Stowly"). HA zeigt den Token nur einmal.

In Stowly unter Einstellungen → „Home Assistant und Bring!" → „Verbindung", im Assistenten im Schritt „Home Assistant":

4. **Adresse von Home Assistant** eintragen, etwa `http://192.168.1.20:8123`, und den Token unter **Zugangs-Token** einfügen.
   - Die Adresse ist die IP von HA oder ein Name aus dem eigenen DNS (Pi-hole); Namen auf `.local` lösen im Container nicht auf. http oder https, ohne Pfad, Abfrage und Benutzerangabe; ein `/` am Ende fällt weg. Läuft HA per https mit eigenem Zertifikat: 17.4.
   - Nicht erlaubt sind Link-local-, Multicast- und unbestimmte Adressen (etwa `169.254.…` oder `0.0.0.0`) und IP-Adressen in ungewohnter Schreibweise („Eine IP-Adresse bitte in der üblichen Schreibweise, etwa 192.168.1.20."). Diese Regeln gelten für die eingetragene Adresse; einen Namen löst Stowly dafür nicht auf.
5. **Verbindung prüfen:** Stowly fragt HA, höchstens 12 Sekunden lang, und speichert dabei nichts. Unter **Liste in Home Assistant** stehen danach die To-do-Listen von HA mit der Zahl ihrer offenen Einträge, etwa „Zuhause (3 offen)". Die mit Bring! verbundene wählen; „Von Hand eingeben …" nimmt die Kennung direkt (`todo.…`).
6. **Speichern.** Kurz danach steht unter „Bring! über Home Assistant" „verbunden", im Log „Home Assistant: Abgleich mit todo.zuhause läuft."

Was „Verbindung prüfen" sagen kann:

| Meldung | Bedeutung |
|---|---|
| „Verbindung zu Home Assistant steht; 3 To-do-Listen gefunden." | Adresse und Token stimmen. Folgt „Die Liste todo.… gibt es dort nicht.", stimmt die gespeicherte Liste nicht. |
| „Home Assistant antwortet. Bitte einen langlebigen Zugangs-Token eintragen …" | Die Adresse stimmt, der Token fehlt. |
| „Home Assistant lehnt den Token ab." | Der Token ist falsch oder in HA gelöscht. |
| „Unter dieser Adresse antwortet kein Home Assistant." | anderer Dienst oder falscher Port |
| „Home Assistant ist nicht erreichbar." | Adresse, Netz, Firewall oder HA aus; beim Zertifikat „… Zertifikat nicht vertraut, siehe STOWLY_HA_CA." (17.4) |
| „Die Adresse leitet weiter (301); Stowly folgt dem nicht. …" | etwa http statt https oder ein anderer Port: die Adresse eintragen, unter der HA selbst antwortet |
| „Gerade erst geprüft. Bitte ein paar Sekunden warten." | höchstens eine Prüfung zugleich und eine in 3 Sekunden |

**Der Token** liegt außerhalb der Datenbank, in `/data/secrets` (Abschnitt 10), und gilt nur für die Adresse, für die er eingetragen wurde. Eine neue Adresse braucht ihn deshalb noch einmal („Für eine neue Adresse braucht es den Token noch einmal."); so lässt er sich nicht an einen anderen Rechner umleiten. Er steht nie in der Datenbank, einer Sicherung, dem Log oder einer Antwort an die App; die App zeigt nur, wann er gespeichert wurde, und bietet **Ersetzen** an. Fehlermeldungen nennen den Status und den Pfad des Aufrufs, nie den Token. Nach dem Zurückspielen auf einem neuen Rechner oder einem Umzug ohne Datenordner fehlt er, und die App sagt es: „Der Token für Home Assistant fehlt (steht in keiner Sicherung); bitte neu eintragen." (20.4).

**Verbindung entfernen** vergisst Adresse, Token und Liste. Die Einkaufsliste in Stowly bleibt; in Bring! erscheint nichts Neues mehr.

**Aus der `.env`** (Docker Compose) geht es weiter wie bisher: eintragen, dann `docker compose up -d`.

```
STOWLY_HA_URL=http://192.168.1.20:8123
STOWLY_HA_TOKEN=…
STOWLY_HA_TODO_ENTITY=todo.zuhause
```

Adresse, Token und Liste gehören zusammen: Steht eine der drei Variablen in der Umgebung, kommen alle drei von dort, und die App zeigt sie nur an (Adresse, Liste, Token „gesetzt" oder „fehlt"). „Verbindung prüfen" geht trotzdem und zeigt die Listen von HA. Fehlt in der Umgebung etwas, nennt die App die Variable, etwa „STOWLY_HA_TOKEN fehlt." Beim Start steht im Log „Einkaufsliste nach Bring! über Home Assistant, Liste todo.zuhause (aus der Umgebung)." bzw. „(aus der App)". Der Token steht dann nur in der `.env`, mit denselben Regeln für Log und Antworten. Die eigene Zertifizierungsstelle gibt es nur über die Umgebung (17.4), auch wenn die Verbindung aus der App kommt.

### 17.3 Was der Zustand in der App sagt

Die Meldungen schreibt der Server; die App zeigt sie mit dem Zeitpunkt des letzten Erfolgs und des Fehlers.

| Zustand | In der App | Meldung | Was tun |
|---|---|---|---|
| `ok` | verbunden | – (der letzte Abgleich ist gelungen) | – |
| `pending` | eingerichtet | – (seit dem Start oder der letzten Änderung noch kein Abgleich) | einen Moment warten |
| `unauthorized` | Token abgelehnt | „Home Assistant lehnt den Token ab." | neuen Token anlegen (17.2, Schritt 3), unter „Zugangs-Token" → „Ersetzen" eintragen |
| `not_found` | Liste fehlt | „Die Liste todo.… gibt es in Home Assistant nicht." | „Verbindung prüfen" und eine Liste wählen (17.2, Schritt 5) |
| `unavailable` | Liste nicht verfügbar | „Die Liste ist in Home Assistant gerade nicht verfügbar." (etwa beim Neustart von HA oder wenn Bring! nicht antwortet) | nichts; es geht von selbst weiter |
| `unreachable` | nicht erreichbar | „Home Assistant ist nicht erreichbar." (Netz, Zeitüberschreitung nach 10 Sekunden), beim Zertifikat „… Zertifikat nicht vertraut, siehe STOWLY_HA_CA." | Adresse, Firewall, 17.4 |
| `error` | Fehler | „Home Assistant antwortet mit 500.", „… antwortet unerwartet." oder „Die Antwort von Home Assistant ist zu groß (mehr als 8 MiB)." | Log von HA |
| `off` | aus | – (nicht eingerichtet) | 17.2 |

Ist nur ein Teil eingerichtet, nennt die App, was fehlt, etwa „Für Home Assistant fehlt noch die To-do-Liste.", „Der Token für Home Assistant fehlt (steht in keiner Sicherung); bitte neu eintragen." oder aus der Umgebung „STOWLY_HA_TOKEN fehlt." Außerdem nennt die App die Zahl der offenen Einträge, die gerade in Bring! stehen. Solange etwas nicht geht, bleibt die Einkaufsliste in Stowly vollständig; der nächste Versuch kommt nach zwei Minuten. Ins Log schreibt Stowly nur einen Wechsel des Zustands, nicht jeden gescheiterten Versuch.

### 17.4 Eigene Zertifizierungsstelle

Läuft HA im Heimnetz per http, entfällt dieser Schritt. Läuft HA per https mit einem Zertifikat der eigenen Zertifizierungsstelle, muss Stowly ihr vertrauen. Das geht nur über die Umgebung, auch wenn Adresse, Token und Liste aus der App kommen: die Zertifizierungsstelle (das Wurzelzertifikat im Format PEM, nicht den Schlüssel) als `ha-ca.pem` in den Ordner des Repositorys legen und in `docker-compose.override.yml` einbinden (Compose liest die Datei von selbst mit, siehe Abschnitt 4.3; gibt es sie schon, etwa für das Netz des Proxys, kommt `volumes` dort dazu):

```yaml
services:
  stowly:
    volumes:
      - ./ha-ca.pem:/config/ha-ca.pem:ro
```

In `.env`: `STOWLY_HA_CA=/config/ha-ca.pem`, dann `docker compose up -d`. Als Adresse von HA (in der App oder in `STOWLY_HA_URL`) gilt der Name, auf den das Zertifikat ausgestellt ist, etwa `https://ha.example:8123`. Lässt sich die Datei nicht lesen oder ist sie kein PEM, beendet der Server den Start mit einem Konfigurationsfehler. Stowly vertraut dann dieser Zertifizierungsstelle, zusätzlich zu denen des Systems, im Abgleich und bei „Verbindung prüfen". Allein gesetzt ist `STOWLY_HA_CA` keine halbe Einrichtung: Die Verbindung lässt sich trotzdem in der App eintragen.

### 17.5 Neustart von HA und andere Ausfälle

- **HA startet neu:** Erst ist HA nicht erreichbar, dann meldet es die Liste eine Weile als `unavailable`. In beiden Fällen schreibt Stowly nichts und zählt kein Fehlen; der Zustand in der App sagt es.
- **Kurz eine leere Liste:** Als in Bring! gelöscht gilt ein Artikel erst, wenn er **zweimal nacheinander** fehlt, während HA und die Liste erreichbar sind. Ein Neustart, der die Liste einen Abgleich lang leer zeigt, leert so nicht die Liste von Stowly.
- **Fehlen zählt nur bei Artikeln, die schon einmal in der Liste standen.** Ändert HA oder Bring! beim Anlegen den Namen (etwa gekürzt), sieht Stowly den Artikel nie: Er gilt dann nie als gelöscht oder abgehakt, und nach zehn Minuten steht einmal eine Warnung im Log („… steht zehn Minuten nach dem Anlegen noch nicht in der Liste").
- **Ohne Antwort von HA auf das Anlegen** (Zeitüberschreitung) gilt der Artikel als angelegt: lieber so als ein zweiter Artikel desselben Namens.
- **Die Liste wechseln** hakt seit 0.4.0 nichts mehr ab. Stowly merkt sich, zu welcher Liste seine gespiegelten Artikel gehören. Liest es zum ersten Mal erfolgreich eine andere Liste, vergisst es die Artikel der alten und löst die Bindungen der Einkaufsliste, in einem Schritt; die offenen Einträge gehen danach neu in die neue Liste. **In der alten Liste bleiben sie stehen:** dort von Hand löschen. Stehen gerade Einträge in Bring!, fragt die App vor dem Speichern nach („Liste wechseln?"). Das gilt auch für einen Wechsel von `STOWLY_HA_TODO_ENTITY`. Im Log steht „Home Assistant: Liste gewechselt (todo.neu statt todo.alt): … Nichts wird abgehakt."
- **Nach dem Zurückspielen** kommt mit der Sicherung auch, zu welcher Liste ihre Artikel gehören (8.3). Eine Sicherung aus 0.3.x weiß das nicht: Dann vergisst Stowly diese Artikel wie bei einem Wechsel, ohne etwas abzuhaken. Stehen sie noch offen in Bring!, bindet Stowly die Einträge an sie, statt zweite anzulegen; diese Artikel behandelt es dann wie eure eigenen (17.1).

## 18. Sensor für Home Assistant

HA liest über seine `rest`-Integration eine Zusammenfassung: Zustand des Sensors ist die Zahl der Packungen, die bald ablaufen (heute eingeschlossen); dazu abgelaufene, alle, das nächste ablaufende Produkt, die Länge der Einkaufsliste, kurze Listen und ein fertiger Satz zum Vorlesen wie „Heute laufen 2 Packungen ab: Joghurt. 1 Packung ist abgelaufen. Auf der Einkaufsliste stehen 4 Einträge." „Heute" ist der Tag in `STOWLY_TIMEZONE`. Der Endpunkt `/api/ha/summary` liest nur und hat einen eigenen Token, der nirgends sonst gilt; ein Geräte-Token gilt dort nicht. Ansagen und Lichter baut ihr in HA als Automation; Stowly schickt keinen Webhook.

### 18.1 Token

In der App unter Einstellungen → „Home Assistant und Bring!" → „Sensor", im Assistenten im Schritt „Home Assistant": **Sensor-Token erzeugen**. Stowly erzeugt einen Token aus 64 Hex-Zeichen und zeigt gleich das YAML für HA mit diesem Token zum Kopieren (18.2). Später:

- **YAML zeigen:** dasselbe noch einmal, mit dem gespeicherten Token.
- **Neu erzeugen:** Der bisherige gilt dann nicht mehr; HA braucht den neuen in der `secrets.yaml`.
- **Entfernen:** Danach liest HA keine Zusammenfassung mehr, Stowly antwortet mit 503.

Jede Änderung gilt sofort, ohne Neustart. Der Sensor-Token liegt wie der Token für HA in `/data/secrets`, in keiner Sicherung. Nach dem Zurückspielen auf einem neuen Rechner oder einem Umzug ohne Datenordner fehlt er, und die App sagt es: „Der Sensor-Token fehlt (steht in keiner Sicherung); bitte neu erzeugen."

**Aus der `.env`** geht `STOWLY_HA_SUMMARY_TOKEN` vor. Er muss mindestens 32 Zeichen lang sein und darf nur druckbare Zeichen ohne Leerraum enthalten; auf einem beliebigen Rechner erzeugen, etwa mit `openssl rand -hex 32`, eintragen, dann `docker compose up -d`:

```
STOWLY_HA_SUMMARY_TOKEN=…
```

Die App zeigt ihn dann nur als „gesetzt"; in ihrem YAML steht statt des Tokens ein Platzhalter.

Probe, ohne HA (`-k` nur bei eigener Zertifizierungsstelle, die der Rechner nicht kennt):

```
curl -s -H "Authorization: Bearer …" https://stowly.example/api/ha/summary
```

zeigt JSON mit `"state"` und `"message"`. Ohne Token antwortet Stowly mit 401, ohne Sensor-Token (weder aus der App noch aus `STOWLY_HA_SUMMARY_TOKEN`) mit 503: „Der Sensor ist auf diesem Server nicht eingerichtet (Sensor-Token in der App unter Einstellungen, Home Assistant, oder STOWLY_HA_SUMMARY_TOKEN)."

### 18.2 In Home Assistant

**Aus der App:** Nach „Sensor-Token erzeugen" oder „YAML zeigen" (18.1) stehen beide Dateien fertig zum Kopieren da, der erste Block für die `secrets.yaml`, der zweite für die `configuration.yaml`. Darin stehen die Adresse, unter der die App gerade offen ist, der Token, der Sensor mit den Vorlagen-Sensoren von unten und der Bestand aus 18.4 samt `recorder:`. Die App deshalb über ihre HTTPS-Adresse öffnen; über http weist sie darauf hin. Läuft Stowly mit seiner eigenen Zertifizierungsstelle, die HA nicht kennt, steht `verify_ssl: false` mit einem Kommentar dabei (18.3). Danach HA neu starten.

**Von Hand:** den Token mit `Bearer ` davor in die `secrets.yaml` von HA:

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

Das YAML aus der App (18.2) enthält diesen Sensor und den Abschnitt `recorder:` schon. Von Hand in die `configuration.yaml`, unter den vorhandenen Abschnitt `rest:` aus 18.2 (die Adresse und `verify_ssl` wie dort):

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

## 19. Per Mausklick in DSM, mit dem Einrichtungsassistenten

Der einfachste Weg auf einer Synology: den Container in der Docker-Oberfläche anlegen, alles Weitere führt die App. Beschrieben für DSM 6.2 (Paket „Docker"); in DSM 7 heißt das Paket „Container Manager", die Schritte sind ähnlich.

### 19.1 Container anlegen

1. **Feste IP-Adresse:** Im Router dem NAS eine feste IP-Adresse geben, falls noch nicht geschehen. Zertifikat und Adresse der App hängen daran.
2. **Image laden:** Docker → **Registrierung** → nach `stowly` suchen → `<konto>/stowly` markieren → **Download** → Tag `latest`.
3. **Starten:** Docker → **Image** → `<konto>/stowly` markieren → **Starten**. Containername `stowly`, dann **Erweiterte Einstellungen**:
   - Reiter **Erweiterte Einstellungen:** Haken bei „Automatischen Neustart aktivieren".
   - Reiter **Volume:** **Ordner hinzufügen** → im Ordner `docker` mit **Ordner erstellen** einen Ordner `stowly` anlegen und auswählen → Mount-Pfad `/data`. Freiwillig, besser auf einem anderen Datenträger: ein zweiter Ordner mit Mount-Pfad `/backups` für die Sicherungen (19.4).
   - Reiter **Port-Einstellungen:** DSM zeigt zwei Zeilen; links „Lokaler Port" mit „Automatisch", rechts „Container-Port" mit 8010 bzw. 8443. **Nur links** etwas eintragen, rechts nichts ändern:

     | Lokaler Port (links) | Container-Port (rechts) |
     |---|---|
     | 8010 | 8010 |
     | 8443 | 8443 |

     Stowly hört im Container immer auf 8010 und 8443. Steht rechts eine andere Zahl, antwortet niemand; das ist die häufigste Falle dieser Oberfläche (die Spalten sehen gleich aus). Steht ein Port auf dem NAS schon anderweitig in Gebrauch (etwa 8443 beim Reverse Proxy von DSM), links einen anderen nehmen, etwa 8444; der Assistent fragt dann unter „Erweitert" danach.
   - Umgebungsvariablen braucht es keine.
4. **Übernehmen → Weiter → Übernehmen.** Nach etwa 30 Sekunden steht der Container unter **Container** auf „Wird ausgeführt".

Lässt sich der Ordner nicht beschreiben (etwa ein Ordner mit Windows-ACL), zeigt `http://<NAS>:8010` statt der App eine Hilfeseite mit Ursache und Abhilfe: in der File Station beim Ordner → Eigenschaften → Berechtigung → „Jeder" mit Lesen und Schreiben; bei Docker Compose `sudo chown -R 10001:10001 <Ordner>`. Die Hilfeseite prüft alle 10 Sekunden neu. Ist der Ordner beschreibbar, beendet sie sich, und Docker startet Stowly neu (automatischer Neustart muss dafür an sein). Im Log steht dann „Der Datenordner ist jetzt beschreibbar".

Ohne Passwort steht im Log des Containers „Noch kein Passwort: Wer Stowly jetzt öffnet, vergibt es." Daran erkennt man, dass der Assistent wartet.

### 19.2 Der Assistent

`http://<IP des NAS>:8010` im Browser öffnen, am besten am PC.

1. **Willkommen:** Passwort für den Haushalt zweimal eingeben, dazu den Namen des Geräts. Wer die Seite zuerst öffnet, vergibt das Passwort; deshalb gleich nach dem Anlegen des Containers erledigen. Daneben steht **Aus einer Sicherung wiederherstellen**, für einen Umzug oder ein neues NAS: Die Sicherung bringt den ganzen Bestand und ihr Passwort mit (Abschnitt 8.3).
2. **Sichere Verbindung:** Stowly hat schon ein Zertifikat für die Adresse, unter der die Seite offen ist. Das Zertifikat der Zertifizierungsstelle auf jedes Gerät laden und ihm vertrauen; der Assistent zeigt die Schritte für iPhone/iPad, Android, Windows und Mac (Abschnitt 20.3) und prüft, ob es geklappt hat. Dann „Zur sicheren Adresse wechseln" und dort einmal anmelden.
3. **Drucker:** SD-Karte für den Raspberry Pi vorbereiten (Raspberry Pi Imager: Raspberry Pi OS Lite, Hostname mit `stowly` am Anfang wie `stowly-pi`, Benutzer, Heim-WLAN, SSH), den Drucker per USB anschließen, dann den Befehl aus dem Assistenten per SSH auf dem Pi ausführen. Der Pi richtet sich ein, koppelt sich mit Stowly und druckt ein Testetikett ([`../pi/README.md`](../pi/README.md)).
4. **Sicherung:** „Schlüssel erzeugen", den geheimen Schlüssel an zwei Orten aufheben und mit dem Haushalts-Passwort übernehmen, dann Uhrzeit, Ordner und „Jetzt sichern" als Probe (Abschnitt 8.2). Erledigt ist der Schritt, sobald die Sicherung wirkt und eine gelungen ist. Wo die Sicherungen liegen, zeigt der Schritt; besser als der Datenordner ist ein zweiter Ordner (19.4).
5. **Updates:** Den Schalter „Nach Updates suchen" einschalten. Für Updates per Knopf den Updater-Container einmal anlegen (19.3).
6. **Benachrichtigungen:** eine Kontakt-Adresse für die Push-Dienste eintragen, dann auf dem Gerät einschalten. Auf dem iPhone geht das nur in der App auf dem Home-Bildschirm (Abschnitt 7).
7. **Home Assistant:** Adresse und Token eintragen, „Verbindung prüfen", die Liste wählen, „Speichern"; danach „Sensor-Token erzeugen" mit dem YAML für HA (Abschnitte 17.2 und 18.1). Wer kein Home Assistant hat, überspringt den Schritt.
8. **Fertig:** jeder Schritt mit seinem Stand. Übersprungene lassen sich hier mit „Nachholen" oder später unter Einstellungen → „Einrichtung und Zugang" nachholen.

Wer die Einrichtung schon abgeschlossen hat, etwa vor dem Update auf 0.4.0, dem drängt sich der Assistent nicht auf. Öffnet man ihn unter Einstellungen → „Einrichtung und Zugang", beginnt er bei „Fertig"; Sicherung und Home Assistant stehen dort als offen, mit „Nachholen".

Ein vergessenes Passwort: beim Container die Umgebungsvariable `STOWLY_PASSWORD` setzen (Container anhalten → Bearbeiten → Umgebung), neu starten, anmelden und dann in der App ein neues Passwort vergeben.

### 19.3 Der Updater-Container

DSM 6.2 kann in der Oberfläche den Socket von Docker nicht in einen Container einbinden. Den Updater-Container legt deshalb einmal der Aufgabenplaner an ([`integrationen.md`](integrationen.md), 10.7):

1. Systemsteuerung → **Aufgabenplaner** → Erstellen → **Geplante Aufgabe** → **Benutzerdefiniertes Skript**.
2. Reiter **Allgemein:** Name `Stowly-Updater anlegen`, Benutzer `root`. Reiter **Zeitplan:** beliebig, die Aufgabe wird nur einmal von Hand ausgeführt.
3. Reiter **Aufgabeneinstellungen:** den Befehl aus dem Assistenten bzw. aus Einstellungen → Aktualisierung einfügen. OK.
4. Die Aufgabe markieren → **Ausführen**. Nach wenigen Sekunden zeigt die App „Updater bereit".
5. Die Aufgabe wieder löschen. Der Updater-Container `stowly-updater` läuft von selbst weiter, auch nach einem Neustart des NAS.

Meldet die App, dass der Updater älter ist als Stowly, den Befehl auf dieselbe Weise noch einmal ausführen; er ersetzt den alten Updater.

### 19.4 Ein zweiter Ordner für die Sicherungen

Ohne weiteres Zutun legt Stowly die Sicherungen in den Datenordner (`docker/stowly/backups`, im Container `/data/backups`). Geht der Datenträger kaputt, sind Daten und Sicherungen zugleich weg. Besser liegen sie in einem zweiten Ordner, am besten auf einem anderen Datenträger:

1. Docker → **Container** → `stowly` anhalten → **Bearbeiten**.
2. Reiter **Volume:** **Ordner hinzufügen** → einen Ordner wählen oder mit **Ordner erstellen** anlegen, etwa `stowly-backups` → Mount-Pfad `/backups`.
3. **Übernehmen**, dann den Container wieder starten.

Stowly findet den Ordner von selbst; eine Umgebungsvariable braucht es nicht, und `STOWLY_BACKUP_DIR` sollte leer bleiben. Unter Einstellungen → „Sicherung" steht danach als Ordner `/backups` („Ein eigener Ordner, in DSM als /backups eingebunden"), und die nächste Sicherung landet dort. Die älteren bleiben im Datenordner liegen; Stowly zeigt und räumt nur den wirksamen Ordner.

**Schreibrecht:** Ein Ordner, den DSM unter `docker` anlegt, ist für Stowly (Benutzer 10001) beschreibbar. Bei einem anderen freigegebenen Ordner, etwa mit Windows-ACL, kann das fehlen. Dann zeigt die App „Der eigene Ordner wird nicht benutzt" mit dem Grund, und die Sicherungen gehen weiter in den Datenordner (8.1). Abhilfe wie in 19.1: in der File Station beim Ordner → Eigenschaften → Berechtigung → „Jeder" (oder der Benutzer 10001) mit Lesen und Schreiben. Danach nimmt Stowly den Ordner von selbst, ohne Neustart.

**Statt eines zweiten Ordners** lässt sich der Ordner der Sicherungen mit Hyper Backup oder Cloud Sync regelmäßig auf ein anderes Gerät oder in die Cloud kopieren; die Sicherungen sind verschlüsselt.

## 20. HTTPS durch Stowly selbst

Seit 0.3.0 kann Stowly HTTPS ohne Reverse Proxy: Es hat eine eigene Zertifizierungsstelle (CA), stellt sich selbst ein Zertifikat aus und antwortet im Container auf Port 8443. Einzelheiten: [`integrationen.md`](integrationen.md), Abschnitt 11.

### 20.1 Was Stowly dafür tut

- **CA:** beim ersten Start eine neue, 10 Jahre gültig, in `/data/tls`. Sie beglaubigt nur Adressen im Heimnetz (private IP-Adressen, Namen wie `.local`, `.home.arpa`, `.fritz.box`). Liegen schon `ca.crt` und `ca.key` in `/data/tls`, nimmt Stowly diese.
- **Zertifikat:** für die Adressen, unter denen die App aufgerufen wird; Stowly lernt sie beim Einrichten. Weitere lassen sich im Assistenten unter „Erweitert" eintragen. Es gilt 397 Tage und wird 60 Tage vor Ablauf ohne Neustart erneuert.
- **Die Geräte vertrauen der CA einmal;** danach gilt jedes neue Zertifikat von selbst, auch das eines gekoppelten Pi.

### 20.2 Freigeben

- **Mausklick-Weg (19.1):** Port 8443 in der Spalte „Lokaler Port" eintragen. Ein anderer lokaler Port geht auch; der Assistent lernt ihn beim ersten Aufruf über HTTPS, vorher fragt er unter „Erweitert".
- **Docker Compose:** `docker-compose.yml` veröffentlicht nur 8010. HTTPS kommt über eine Datei `docker-compose.override.yml` daneben, die Compose und der Updater von selbst lesen:

  ```yaml
  services:
    stowly:
      ports:
        - "8443:8443"
  ```

  Dazu in `.env` `STOWLY_PUBLISH=8010`, damit HTTP für den Pi-Installer und das Zertifikat im Heimnetz erreichbar ist. Läuft auf 8443 schon ein Reverse Proxy, erst dessen Regel löschen.
- Ein Reverse Proxy davor geht weiter wie in Abschnitt 4. Der HTTPS-Listener bleibt dann ungenutzt; der Assistent erkennt die sichere Adresse.

### 20.3 Das Zertifikat auf den Geräten

Jedes Gerät, das Stowly über HTTPS öffnet, braucht das Zertifikat der CA einmal. Der Assistent führt durch die Schritte; hier zum Nachschlagen. Das Zertifikat liegt unter `http://<NAS>:8010/api/setup/ca.crt`.

- **iPhone und iPad** (nur Safari): Zertifikat laden → „Erlauben" → Einstellungen → oben „Profil geladen" (sonst Allgemein → VPN und Geräteverwaltung) → Installieren. Dann Allgemein → Info → Zertifikatsvertrauenseinstellungen → den Schalter bei „Stowly CA …" einschalten. Ohne diesen Schalter vertraut Safari dem Zertifikat nicht.
- **Android:** Zertifikat laden, in den Einstellungen nach „Zertifikat installieren" suchen → „CA-Zertifikat" → die Datei wählen. Android verlangt dafür eine Displaysperre.
- **Windows:** Datei öffnen → „Zertifikat installieren…" → Aktueller Benutzer → „Alle Zertifikate in folgendem Speicher speichern" → „Vertrauenswürdige Stammzertifizierungsstellen". Danach den Browser neu starten.
- **Mac:** Datei doppelklicken, im Schlüsselbund „Anmeldung" hinzufügen, den Eintrag öffnen → Vertrauen → „Immer vertrauen".

Den Fingerabdruck der CA zeigt die App unter Einstellungen → „Einrichtung und Zugang"; zum Vergleich steht er auch im Log des Containers.

### 20.4 Sichern und umziehen

`/data/tls` (die CA) und `/data/secrets` (die Tokens für Home Assistant und den Sensor) gehören zum Datenordner, aber zu keiner Sicherung (Abschnitt 8). Für einen Umzug auf einen anderen Rechner deshalb:

1. Stowly anhalten und den **ganzen Datenordner** mitnehmen (DSM: der Ordner unter `/data`, etwa `docker/stowly`; Docker Compose: das Volume `stowly-data`, Abschnitt 10), dazu den Ordner der Sicherungen, wenn er außerhalb liegt.
2. Auf dem neuen Rechner den Container mit diesem Ordner anlegen (19.1). Dieselbe CA, dieselben Tokens, alle Anmeldungen: Es läuft weiter wie vorher.

Geht das nicht, etwa nach einem Plattenausfall, bleibt die Sicherung: beim ersten Start „Aus einer Sicherung wiederherstellen" (8.3). Dann entsteht eine neue CA: Jedes Gerät muss ihr neu vertrauen und jeder Pi neu gekoppelt werden; der Assistent beginnt mit der sicheren Verbindung. Die Tokens für Home Assistant und den Sensor fehlen und sind neu einzutragen bzw. neu zu erzeugen (17.2, 18.1); die App sagt es.

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

Die Abläufe in der App prüft N; hier geht es um die Dateien auf dem Server, die `.env` und den Notweg.

| # | Schritt | Erwartet |
|---|---|---|
| D1 | In der App „Jetzt sichern" (Abschnitt 8.2), dann die neueste Sicherung herunterladen | Datei `stowly-JJJJ-MM-TT-HHMM.sqlite3.gz.age`, so groß wie in der Liste |
| D2 | Auf einem Rechner mit `age` und `sqlite3`: `age -d -i stowly-schluessel-….txt stowly-….sqlite3.gz.age \| gunzip > probe.sqlite3`, dann `sqlite3 probe.sqlite3 "PRAGMA integrity_check; SELECT COUNT(*) FROM packages;"` | `ok` und die Zahl der Packungen; `probe.sqlite3` danach löschen |
| D3 | Danach in der App eine Packung einlagern (sie fehlt in der Sicherung) | – |
| D4 | Diese Sicherung in der App zurückspielen (Abschnitt 8.3) | Vorschau mit Stand und Zahlen; nach dem Neustart lädt die Seite neu; `docker compose exec stowly ls -l /data` zeigt `stowly.sqlite3` im Besitz von `stowly` |
| D5 | Beide Handys öffnen | Sie gleichen ab und zeigen den Stand der Sicherung; die Packung aus D3 ist weg; niemand muss sich neu anmelden |
| D6 | Nur wer Schnappschüsse des Volumes zurückspielen will: `docker compose run --rm --no-deps stowly python -m stowly --new-dataset` | Ausgabe „Neue Kennung des Datenbestands: …"; nach dem Start holen beide Handys den Bestand neu |
| D7 | Nur mit `.env`: Sicherung nach Abschnitt 8.5 einrichten (zwei öffentliche Schlüssel in `STOWLY_BACKUP_RECIPIENTS`, `./backups` für Benutzer 10001), `docker compose up -d`, `docker compose logs stowly` | „Automatische Sicherung täglich um 03:30 nach /backups an 2 Schlüssel."; ist 03:30 heute vorbei, gleich danach „Sicherung geschrieben: stowly-….sqlite3.gz.age"; in der App sind Schlüssel und Schalter gesperrt |
| D8 | `ls -l backups` auf dem Rechner | eine Datei `stowly-JJJJ-MM-TT-HHMM.sqlite3.gz.age` mit Rechten `-rw-------`, Besitzer 10001; keine `.tmp`-Datei |
| D9 | In der App „Einstellungen → Sicherung" | „Letzte gelungene" mit Uhrzeit und Größe, die gekürzten Schlüssel (`age1…`), „Nächster Versuch"; keine Warnung |
| D10 | Probe-Entschlüsselung nach 8.4 mit **jedem** geheimen Schlüssel | beide Male `SQLite format 3`; mit `sqlite3`: `ok` und die Zahl der Packungen |
| D11 | Eine Sicherung auf dem Notweg zurückspielen (8.4, samt `--new-dataset`) | Befehle laufen ohne Fehler; danach wie D5. Geräte, die erst nach der Sicherung angemeldet wurden, melden sich neu an |
| D12 | Mit `STOWLY_BACKUP_DIR=/backups`: `sudo chown root:root backups`, `docker compose restart`, in der App „Sicherung" ansehen; danach wieder `sudo chown 10001:10001 backups` | „Der Ordner für Sicherungen ist nicht beschreibbar (Benutzer 10001)."; „Jetzt sichern" nennt denselben Grund. Nach dem Zurücksetzen gelingt „Jetzt sichern", sonst die nächste Sicherung spätestens eine Stunde nach dem letzten Versuch |
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

Mit der Liste, die ihr wirklich nutzt, oder mit einer Probe-Liste: Seit 0.4.0 hakt ein späterer Wechsel nichts mehr ab (17.5). Die Probe-Einträge danach in Bring! löschen, nach einem Wechsel auch in der alten Liste. Abgeglichen wird alle zwei Minuten; Bring! braucht in HA bis zu 90 Sekunden.

| # | Schritt | Erwartet |
|---|---|---|
| J1 | Abschnitt 17.2 durchgehen, mit einem eigenen HA-Benutzer **ohne** Administratorrechte | Log: „Home Assistant: Abgleich mit todo.… läuft."; in der App „verbunden" (Zustand `ok`). Sonst bitte melden, mit der Meldung aus der App. |
| J2 | In Stowly einen Eintrag „Milch Probe" anlegen | nach zwei bis vier Minuten in Bring! als „Milch Probe" mit der Spezifikation „Stowly" |
| J3 | Einen Mindestbestand setzen und unterschreiten (automatischer Eintrag „fehlt 2"), dann eine Packung einlagern | in Bring! mit „fehlt 2 · Stowly", danach „fehlt 1 · Stowly" |
| J4 | „Milch Probe" in Stowly abhaken | in Bring! unter „zuletzt gekauft" |
| J5 | Den Mindestbestand wieder erreichen (einlagern) | Der automatische Artikel verschwindet aus Bring!, ohne unter „zuletzt gekauft" zu stehen. |
| J6 | In Bring! einen Artikel „Kaffee Probe" anlegen, in Stowly einen Eintrag „kaffee probe" | Kein zweiter Artikel in Bring!; in der App zählt „in Bring!" den Eintrag mit. Den Eintrag in Stowly abhaken: In Bring! bleibt „Kaffee Probe" stehen. |
| J7 | Einen gespiegelten Artikel in der App von Bring! abhaken | nach einigen Minuten in Stowly erledigt; ein automatischer Eintrag kommt bis zum nächsten Einlagern nicht wieder |
| J8 | Einen gespiegelten Artikel in Bring! löschen | in Stowly erledigt, nach zwei Abgleichen (etwa vier bis sechs Minuten) |
| J9 | Einen in Stowly erledigten Eintrag wieder öffnen | Er geht nach zwei Minuten wieder nach Bring! (zurück aus „zuletzt gekauft" oder als neuer Artikel: bitte notieren, welches) |
| J10 | HA neu starten, während Einträge in Bring! stehen | In der App zeitweise „nicht erreichbar" oder „Liste nicht verfügbar"; danach „verbunden". Kein Eintrag in Stowly ist erledigt. |
| J11 | Den Token absichtlich verfälschen (in der App unter „Zugangs-Token" → „Ersetzen"; aus der `.env`: `STOWLY_HA_TOKEN`, `docker compose up -d`); danach zurück | „Home Assistant lehnt den Token ab."; die Einkaufsliste in Stowly bleibt unverändert |
| J12 | Nur bei HA über https mit eigener Zertifizierungsstelle: Abschnitt 17.4; einmal ohne `STOWLY_HA_CA` | ohne: „… Zertifikat nicht vertraut, siehe STOWLY_HA_CA."; mit: „verbunden" |
| J13 | `docker compose logs stowly \| grep -i "home assistant"` | Wechsel des Zustands und erledigte Einträge, nie der Token und nie die Adresse von HA |

### K. Sensor für Home Assistant

| # | Schritt | Erwartet |
|---|---|---|
| K1 | Sensor-Token nach 18.1 (in der App oder aus der `.env`), `curl` wie dort | JSON mit `state`, `today`, `expired`, `total`, `next`, `shopping`, den Listen und `message` |
| K2 | Dasselbe ohne Token und mit dem Token eines Geräts | beide Male 401 |
| K3 | Den Sensor-Token an `/api/devices` schicken | 401 |
| K4 | Das YAML aus der App oder die Schnipsel aus 18.2 in HA, HA neu starten | `sensor.stowly` mit der Zahl der bald ablaufenden Packungen und allen Attributen; die drei Vorlagen-Sensoren mit Werten |
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

### M. Einrichtung per Mausklick und HTTPS durch Stowly (0.3.0)

| # | Schritt | Erwartet |
|---|---|---|
| M1 | In DSM: Image `<konto>/stowly` über die Registrierung suchen und laden (19.1) | Die Suche findet es; der Download läuft durch |
| M2 | Container wie in 19.1 anlegen, ohne Umgebungsvariablen | Nach etwa 30 Sekunden „Wird ausgeführt“; im Ordner `docker/stowly` liegen `stowly.sqlite3`, `print/`, `tls/` |
| M3 | `http://<NAS>:8010` öffnen | „Willkommen bei Stowly“ statt der Anmeldung |
| M4 | Passwort vergeben (zweimal, mindestens 8 Zeichen) | Angemeldet, der Assistent öffnet sich; ein zweites Gerät, das jetzt die Seite öffnet, sieht die Anmeldung |
| M5 | Sichere Verbindung: Zertifikat am iPhone laden, Profil installieren, Vertrauen einschalten | Die App meldet „Dieses Gerät vertraut Stowly“; der Fingerabdruck in der App stimmt mit dem im Log des Containers überein |
| M6 | Name Constraints: in Safari eine Seite im Internet öffnen | Funktioniert wie vorher; die CA beglaubigt nur Adressen im Heimnetz (Einzelheiten [`integrationen.md`](integrationen.md), 11.2) |
| M7 | „Zur sicheren Adresse wechseln“, dort anmelden | `https://<NAS>:8443/einrichtung` ohne Warnung; der Assistent macht beim Drucker weiter |
| M8 | Drucker: Befehl am frischen Pi ausführen | Die App zeigt „Der Pi richtet sich ein …“, dann „Gekoppelt“; der Pi druckt ein Testetikett; „Verbindung prüfen“ gelingt am iPhone über HTTPS |
| M9 | Updates: Schalter ein, Updater-Container über den Aufgabenplaner anlegen (19.3) | „Updater bereit“ nach wenigen Sekunden; in DSM ein Container `stowly-updater` |
| M10 | Benachrichtigungen: Kontakt eintragen, in der installierten App einschalten, Testnachricht | Die Testnachricht kommt an |
| M11 | Eine neue Version veröffentlichen, dann „Update installieren“ | Der Updater-Container tauscht den Container aus; „Aktualisiert auf X.Y.Z“; Daten, Ports, Ordner und Neustart-Regel bleiben; in DSM keine Reste wie `stowly-vorher` |
| M12 | Container in DSM neu starten | Stowly kommt mit denselben Zertifikaten zurück; kein neues Profil nötig |
| M13 | Compose-Installation mit Reverse Proxy auf 0.3.0 aktualisieren | Anmeldung mit dem Passwort aus der `.env` geht weiter; der Assistent öffnet sich nicht von selbst; unter Einstellungen → „Einrichtung und Zugang“ steht „Sichere Verbindung“ als erledigt, sobald die App über HTTPS läuft |

### N. Sicherung und Home Assistant in der App (0.4.0)

Erst in einem Testcontainer (19.1), dann am eigenen Stowly. Home Assistant gegen eine Probe-Liste in HA (etwa „Local To-do"), nicht gegen die echte Bring!-Liste.

| # | Schritt | Erwartet |
|---|---|---|
| N1 | Im Assistenten (oder Einstellungen → Sicherung) „Schlüssel erzeugen", „Als Datei speichern", Haken „Ich habe ihn gesichert.", „Haushalts-Passwort" eingeben, „Schlüssel übernehmen"; vorher einmal mit falschem Passwort | Datei `stowly-schluessel-JJJJ-MM-TT.txt` mit `# public key: age1…` und dem geheimen Schlüssel; „Schlüssel übernehmen" geht erst nach dem Haken. Mit falschem Passwort „Das Haushalts-Passwort stimmt nicht.", das Paar bleibt stehen; mit richtigem steht der Schlüssel gekürzt in der Liste, und der geheime ist aus der Ansicht verschwunden. „Entfernen" fragt nicht nach dem Passwort |
| N2 | „Schlüssel prüfen" mit der Datei aus N1; dann mit einem fremden geheimen Schlüssel (etwa aus `age-keygen`); dann mit dem öffentlichen | „Der Schlüssel passt"; „Der Schlüssel passt nicht"; „Kein geheimer Schlüssel". Im Log des Servers nichts davon |
| N3 | Ohne zweiten Ordner unter „Ordner" nachsehen | `/data/backups`, mit dem Rat, einen zweiten Ordner einzubinden oder den Ordner wegzukopieren |
| N4 | „Jetzt sichern", gleich danach noch einmal | „Sicherung angelegt: stowly-….sqlite3.gz.age"; das zweite Mal „Jetzt sichern geht höchstens einmal je Minute"; im Assistenten ist „Sicherung" erledigt |
| N5 | Schalter „Automatische Sicherung" aus; nach einer Minute „Jetzt sichern" | „Aus: Stowly sichert nicht von selbst. …"; „Jetzt sichern" geht trotzdem; „Nächster Versuch" zeigt „–". Danach den Schalter wieder an |
| N6 | Eine Sicherung „Herunterladen", am Rechner `age -d -i stowly-schluessel-….txt stowly-….sqlite3.gz.age \| gunzip \| head -c 15` | `SQLite format 3` |
| N7 | Einen zweiten Ordner `/backups` in DSM einbinden (19.4), dann „Jetzt sichern" | „Ordner" zeigt `/backups` („Ein eigener Ordner, in DSM als /backups eingebunden"); die neue Sicherung liegt im zweiten Ordner |
| N8 | Denselben Ordner für Benutzer 10001 schreibgeschützt machen, „Sicherung" neu laden; danach wieder Schreibrecht | Hinweis „Der eigene Ordner wird nicht benutzt" mit dem Grund; „Jetzt sichern" schreibt nach `/data/backups`. Mit Schreibrecht nimmt Stowly `/backups` wieder, ohne Neustart |
| N9 | Eine Packung einlagern, dann Einstellungen → Sicherung → „Zurückspielen …" mit einer Sicherung von vorher: Datei, Schlüssel, „Prüfen", jetziges Passwort, „Einspielen" | Vorschau mit Stand und Zahlen; „Stowly startet neu …", nach unter einer Minute lädt die Seite neu; die Packung ist weg; Geräteliste und Anmeldungen wie vorher; die Testnachricht (Abschnitt 15) kommt weiter an |
| N10 | Dasselbe mit einem falschen Schlüssel, dann mit einem falschen Passwort | „Der Schlüssel passt nicht zu dieser Sicherung."; „Das Passwort stimmt nicht." Nichts ist eingespielt |
| N11 | Das zweite Handy öffnen | Es lädt den Bestand neu, ohne neue Anmeldung; die Packung aus N9 ist auch dort weg |
| N12 | „Rückgängig", Rückfrage bestätigen | Stowly startet neu; die Packung aus N9 ist wieder da; „Rückgängig gemacht am …", wieder mit „Rückgängig" |
| N13 | „Alte Datenbank löschen" | Die Zeile mit „Rückgängig" verschwindet; `/data/restore/previous.sqlite3` ist weg |
| N14 | Ein frischer Container (19.1, eigener Datenordner, andere Ports): „Aus einer Sicherung wiederherstellen" mit einer Sicherung und ihrem Schlüssel, Passwort aus der Sicherung, Gerätename | Nach dem Neustart ist das Gerät angemeldet; der Assistent beginnt mit „Sichere Verbindung"; der Bestand ist der aus der Sicherung |
| N15 | Danach Einstellungen → „Home Assistant und Bring!" (falls die Sicherung eine Verbindung aus der App hatte) | „Der Token für Home Assistant fehlt (steht in keiner Sicherung); bitte neu eintragen."; beim Sensor „Er fehlt (steht in keiner Sicherung) …". Neu eingetragen bzw. neu erzeugt läuft beides wieder |
| N16 | Das Zurückspielen über `http://` öffnen, bis zum Schlüssel | Hinweis „Unverschlüsselte Verbindung" |
| N17 | Home Assistant in der App einrichten (17.2): Adresse, Token, „Verbindung prüfen", Liste wählen, „Speichern" | „Verbindung zu Home Assistant steht; … gefunden."; die Listen mit der Zahl offener Einträge; nach dem Speichern ohne Neustart „verbunden"; im Log „Home Assistant: Abgleich mit todo.… läuft." und nirgends der Token |
| N18 | Nur die Adresse ändern (etwa die IP statt eines Namens), ohne Token | „Für eine neue Adresse braucht es den Token noch einmal." |
| N19 | Mit Einträgen in Bring! eine andere Liste wählen, „Speichern" | Rückfrage „Liste wechseln?"; danach ist in Stowly nichts erledigt, die offenen Einträge erscheinen in der neuen Liste, in der alten bleiben sie stehen |
| N20 | Am eigenen Stowly mit HA aus der `.env` | Adresse, Liste und Token „gesetzt" nur zu sehen, mit dem Hinweis auf die Umgebung; „Verbindung prüfen" zeigt die Listen von HA |
| N21 | „Sensor-Token erzeugen", das YAML in HA übernehmen, HA neu starten; dann „Neu erzeugen" | Der Sensor hat Werte (wie K4); nach „Neu erzeugen" bekommt HA mit dem alten Token 401, bis das neue YAML drin ist |
| N22 | „Entfernen" beim Sensor-Token, dann `curl` wie in 18.1 | 503 mit „Der Sensor ist auf diesem Server nicht eingerichtet …" |

### O. Etiketten gestalten, Produktdaten und Druckerkarte (0.5.0)

Erst in einem Testcontainer (19.1) mit einem Drucker am Server mit Bild-Treiber, dann am eigenen Stowly mit dem Pi. Schmale und gestanzte Rollen erst, wenn so eine Rolle da ist.

| # | Schritt | Erwartet |
|---|---|---|
| O1 | Drucker → Abschnitt „Etiketten" → „Etiketten gestalten", ohne etwas zu ändern | Papier „62 mm endlos"; die Vorschau zeigt die Etiketten wie bisher; „Speichern" und „Verwerfen" gehen erst nach einer Änderung |
| O2 | Reiter „Packung": Länge 40 mm, QR-Code rechts und groß, ein Feld mit den Pfeilen verschieben, „Zone" an | Die Vorschau folgt kurz nach jeder Änderung; passt etwas nur verkleinert oder gekürzt, steht es darunter |
| O3 | Felder anschalten und vergrößern, bis es nicht mehr passt; „Speichern" | Ein Satz wie „Für so viele Felder ist das Etikett zu kurz: ein Feld weglassen, kleiner wählen oder länger machen."; gespeichert ist nichts |
| O4 | Eine passende Gestaltung „Speichern", dann an einem zweiten Gerät abgleichen und dort ein Etikett drucken | Beide Geräte drucken die neue Gestaltung; ein Etikett, das vorher schon unterwegs war, bleibt, wie es war |
| O5 | „Probedruck" mit einer Packung aus dem Bestand | Das Etikett entspricht der Vorschau; am Testcontainer liegt das PNG des Bild-Treibers in der Größe des Papiers |
| O6 | Papier „29 mm endlos", Länge 62 mm, Probedruck am Bild-Treiber | Die Vorschau liegt quer, wie man das Etikett liest; das PNG ist gedreht (306 × 732 Pixel) |
| O7 | Papier „62 × 29 mm gestanzt", Probedruck am Bild-Treiber | PNG mit 696 × 271 Pixeln |
| O8 | Eigenes Stowly, Pi noch mit Druckdienst 0.4.0: 62 mm endlos, Länge 40 mm, Probedruck am QL-570 | Druckt wie gestaltet |
| O9 | Eigenes Stowly, Pi noch mit 0.4.0: Papier „29 mm endlos" speichern und ein Etikett anfordern | Es bleibt ausstehend: „Der Druckdienst auf dem Pi ist zu alt für dieses Papier. Neu koppeln aktualisiert ihn."; die Druckerkarte zeigt „Druckdienst 0.4.0 kann dieses Papier nicht" mit „Neu koppeln" |
| O10 | Den Pi neu koppeln („Vorhandenen Drucker übernehmen"), dann „Verbindung prüfen"; mit Papier „29 mm endlos" bei eingelegter 62-mm-Rolle drucken; danach „Auf Vorgabe zurücksetzen" | Druckdienst 0.5.0, „Rolle: 62 mm endlos" in der Karte; der Druck endet mit „Eingelegt: 62 mm endlos; das Etikett braucht 29 mm endlos.", und es kommt nichts aus dem Drucker; nach dem Zurücksetzen druckt er wieder |
| O11 | QL-570 ausschalten, „Verbindung prüfen"; einschalten, noch einmal | Gelb „Der Pi antwortet, der Drucker nicht." mit dem Rat, ihn einzuschalten und das USB-Kabel zu prüfen; danach grün „Drucker bereit." |
| O12 | „Produkt bearbeiten" an einem offline angelegten Produkt mit Barcode, „Online abfragen" | Name, Marke, Größe und Bild „jetzt" und „Open Food Facts" nebeneinander, abweichende vorgehakt; Quelle „Daten von Open Food Facts (ODbL)" |
| O13 | „Übernehmen", dann „Speichern" | Felder und Bild sind gespeichert; ein zweites Gerät zeigt das Bild nach dem Abgleich |
| O14 | Gleich noch einmal „Online abfragen" | „Open Food Facts bremst gerade; in einer Minute noch einmal." |
| O15 | Ein Produkt ohne Barcode oder nur mit ladeninternem Code (beginnt mit 2); dann eines mit Barcode, aber offline | Kein Knopf; offline ist er gesperrt und sagt warum |
