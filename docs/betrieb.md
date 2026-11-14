# Betrieb

Anleitung für den Betreiber einer Stowly-Installation: starten, erreichbar machen, auf den Handys installieren, sichern, aktualisieren. Was Stowly ist und wie es aufgebaut ist, steht in [`../README.md`](../README.md) und [`plan-stufe-1.md`](plan-stufe-1.md).

> **Stand.** `Dockerfile`, `docker-compose.yml` und `docker-compose.usb.yml` sind auf dem Entwicklungsrechner **nicht gebaut und nicht gestartet** worden: Dort gibt es kein Docker. Auch Reverse Proxy, Zertifikate, Drucker und die Installation auf den Handys ließen sich nur beschreiben, nicht ausprobieren. Geprüft ist der Server selbst samt Druckdienst mit dem Bild-Treiber (automatische Tests und Durchläufe von Hand unter Windows, die Web-App mit eingeschalteter Content-Security-Policy im Browser). Alles Übrige prüft die [Prüfliste](#prüfliste-für-die-zielumgebung) am Ende; bitte beim ersten Aufsetzen Schritt für Schritt abhaken und Abweichungen melden. Aus Stufe 2 sind die automatische Sicherung, die Benachrichtigungen und die Zeitzone bisher nur mit automatischen Tests geprüft (Testschlüssel für age, nachgebildete Push-Dienste, eingestellte Uhr); am Gerät und mit `age` prüfen sie D7 bis D13 und I. Für den Raspberry Pi gibt es eine eigene Anleitung samt Prüfliste: [`../pi/README.md`](../pi/README.md).

## 1. Überblick

- Stowly läuft als **ein Container mit einem Prozess**. Er liefert die Web-App und die Schnittstelle auf Port 8010 und spricht nur HTTP.
- **HTTPS stellt ein Reverse Proxy davor bereit.** Beschrieben sind zwei Wege: Nginx Proxy Manager mit eigener Zertifizierungsstelle (Abschnitt 4) und Tailscale (Abschnitt 5).
- **Offline-Betrieb, Kamera und die Installation als App gehen nur über die HTTPS-Adresse** (Abschnitt 6).
- Alle Daten liegen in **einer SQLite-Datei** in einem Docker-Volume (Abschnitt 10).

## 2. Voraussetzungen

| Was | Wofür |
|---|---|
| Rechner mit Debian 13, ohne Bildschirm | Zielsystem; jedes Linux mit Docker sollte genauso gehen |
| Docker Engine mit Compose-Plugin (`docker compose version` zeigt Version 2 oder neuer) | Bau und Betrieb des Containers |
| Internet beim Bauen | lädt die Basis-Images und die Pakete von npm und PyPI (von PyPI nur Dateien, die auf Version und Prüfsumme festgelegt sind, Abschnitt 9.1) |
| etwa 1 GB Plattenplatz für den Bau, danach wenige hundert MB | Images; die Datenbank selbst bleibt klein |
| ein Reverse Proxy mit HTTPS: Nginx Proxy Manager **oder** Tailscale | siehe Abschnitte 4 und 5 |
| im Betrieb optional Internet | für das Nachschlagen bei Open Food Facts und für Benachrichtigungen (die Push-Dienste von Apple, Google, Mozilla und Microsoft, Abschnitt 15) |
| für die automatische Sicherung: `age` auf einem eigenen Rechner | Schlüssel erzeugen und Sicherungen öffnen (Abschnitt 8.1); auf dem Server nicht nötig |

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
| `STOWLY_HA_URL`, `STOWLY_HA_TOKEN`, `STOWLY_HA_TODO_ENTITY`, `STOWLY_HA_CA`, `STOWLY_HA_SUMMARY_TOKEN` | Home Assistant mit Bring! und der Sensor; folgen in der nächsten Runde, werden aber schon beim Start geprüft |
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

## 10. Wo die Daten liegen

| Was | Wo |
|---|---|
| Datenbank mit allem: Bestand, Einkaufsliste, Produktbilder, Geräte und ihre Abos für Benachrichtigungen, Ereignisprotokoll, der Schlüssel des Servers für Benachrichtigungen | Docker-Volume `stowly-data`, im Container `/data/stowly.sqlite3` (im Betrieb dazu `-wal` und `-shm`) |
| Druckdienst des Servers: Auftragsspeicher samt `boot_id`, Bilder des Bild-Treibers | im selben Volume unter `/data/print/` (`jobs.sqlite3`, `images/`). Nicht in den Sicherungen; geht er verloren, fragt die App bei offenen Etiketten nach, statt doppelt zu drucken |
| automatische Sicherungen, verschlüsselt | Ordner `backups` im Ordner des Repositorys, im Container `/backups` (Abschnitt 8.1); die privaten Schlüssel dazu nur beim Betreiber |
| Einstellungen des Servers samt Passwort und Tokens | `.env` im Ordner des Repositorys |
| eigene Anpassung an den Proxy | `docker-compose.override.yml`, falls angelegt |
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
| Die App bleibt nach einer Änderung an `STOWLY_CSP` leer, oder die Konsole des Browsers meldet „Content Security Policy" | Die eigene Policy verbietet etwas, das die App braucht: zurück zur Vorgabe (`STOWLY_CSP` leer) und Abschnitt 13. |

## 12. Das Repository auf den Server bringen

Das Repository hat kein Remote. Drei Wege auf den Debian-Server, alle über SSH (`<benutzer>@<server>` ist der eigene Zugang). Auf dem Server liegt danach ein Ordner `~/stowly`, in dem `docker compose` läuft; `.env` und `docker-compose.override.yml` legt man dort einmal an, keiner der Wege überschreibt sie.

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
- Die Brother-Bibliothek `brother_ql_next` steht unter der GPL-3.0. Sie gehört nicht zum Quelltext von Stowly: Das Image lädt sie beim Bau auf Version und Prüfsumme festgelegt von PyPI nach (`print/requirements-brother.txt`; `packbits` gibt es nur als Quellpaket und wird mit dem setuptools aus der Sperrdatei gebaut, Abschnitt 9.1), und nur der Brother-Treiber lädt sie, erst beim Benutzen. Wer ein Image mit ihr an andere weitergibt, muss deren GPL-Bedingungen einhalten.

## 15. Benachrichtigungen (Web-Push)

Stowly schickt selbst Benachrichtigungen an die Handys, über die Push-Dienste der Browser (Apple, Google, Mozilla, Microsoft), ohne fremden Dienst dazwischen. Die tägliche Nachricht „nur Neues" folgt in der nächsten Runde; schon jetzt gibt es das Einschalten je Gerät und die Testnachricht.

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

## 16. Zeitzone

„Heute" (für das MHD in Sensor und Tagesnachricht, die Monate der Statistik, die Dateinamen der Sicherungen) und alle Uhrzeiten (`STOWLY_BACKUP_TIME`, die Uhrzeit der Tagesnachricht in den Einstellungen der App) gelten in `STOWLY_TIMEZONE`, Vorgabe `Europe/Berlin`. Erlaubt ist jeder IANA-Name, genau so geschrieben (`Europe/Vienna`, `UTC`); ein unbekannter Name beendet den Start mit einem Konfigurationsfehler. Die Zeitzonendaten bringt Stowly selbst mit; die Variable `TZ` des Containers spielt dafür keine Rolle. Gespeicherte Zeitpunkte sind immer UTC; die App zeigt sie in der Zeitzone des Handys und nennt die Zeitzone des Servers dazu, wenn sie abweicht.

Sommer- und Winterzeit brauchen nichts: Fällt die Uhrzeit einer Aufgabe in die Lücke beim Umstellen auf Sommerzeit (etwa 02:30), läuft sie mit dem Sprung um 03:00; gibt es sie beim Umstellen auf Winterzeit zweimal, läuft sie beim ersten Mal.

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
| I2 | Android, Chrome, HTTPS-Adresse: „Einstellungen → Dieses Gerät" → Benachrichtigungen einschalten, erlauben, „Testnachricht senden" | Die App meldet „Der Push-Dienst hat die Nachricht angenommen."; binnen Sekunden erscheint „Testnachricht von Stowly …"; Tippen öffnet die Einstellungen |
| I3 | iPhone (ab iOS 16.4), **installierte** App: dasselbe | wie I2. In Safari ohne Installation erklärt die App, dass es erst nach der Installation geht |
| I4 | Eine zweite Testnachricht sofort danach | „Bitte in … Sekunden erneut versuchen" (höchstens eine je 10 Sekunden) |
| I5 | Das Gerät unter „Geräte" abmelden, dann `docker compose exec stowly python -c "import sqlite3; print(sqlite3.connect('/data/stowly.sqlite3').execute('SELECT COUNT(*) FROM push_subscriptions').fetchone())"` | Das Abo des abgemeldeten Geräts ist weg |
| I6 | `docker compose logs stowly` nach den Testnachrichten | „Push an web.push.apple.com angenommen (201)" o. ä.; nie die volle Adresse eines Abos, nie ein Schlüssel |
| I7 | `STOWLY_TIMEZONE=Mars/Olympus`, `docker compose up -d`, Log ansehen; danach zurück | „Konfigurationsfehler: STOWLY_TIMEZONE …"; mit gültigem Namen startet der Server und nennt „Zeitzone des Servers: …" |
