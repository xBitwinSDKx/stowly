# Raspberry Pi als Druckserver im Keller

Der Pi steht im Keller beim Etikettendrucker, spannt dort ein eigenes WLAN ohne Internet auf und nimmt Etiketten direkt vom Handy an: über HTTPS (`https://10.71.83.1:8443`) und HTTP (`http://10.71.83.1:8080`). Er hat keine Verbindung zum Server und keine Uhr; den Zustand von Pi und Drucker bringt das Handy beim nächsten Abgleich mit. Protokoll: [`../docs/etiketten.md`](../docs/etiketten.md), Hintergrund: [`../docs/recherche.md`](../docs/recherche.md), Abschnitte 3 bis 8.

> **Stand: teilweise am Gerät geprüft (14.11.2026).** Auf einem Raspberry Pi 5 mit Raspberry Pi OS Lite (64-bit, Trixie) und einem Brother QL-570 am USB liefen:
> - `install.sh` zweimal (Erstinstallation und Aktualisierung)
> - der Probedruck
> - der Direktdruck aus der App über HTTP, von einem PC im Heimnetz aus (`http://localhost:…` als Ursprung)
>
> Dabei fiel ein Fehler auf und ist behoben: Wegen `ProtectSystem=strict` meldete der Dienst „Speicher nur lesbar", obwohl die Karte beschreibbar war.
>
> Noch nicht am Gerät ausprobiert sind:
> - der Access Point
> - HTTPS mit Zertifikat vom Handy
> - der Schreibschutz
> - der Pi Zero
> - der QL-800
>
> Bitte beim Aufsetzen die [Prüfliste](#prüfliste-am-gerät) abhaken und Abweichungen melden.

## Was hier liegt

| Datei | Wofür |
|---|---|
| `install.sh` | installiert den Druckdienst als Systemdienst (braucht Internet) |
| `access-point.sh` | macht das WLAN des Pi zum Access Point (danach kein Internet mehr) |
| `overlay.sh` | schaltet den Schreibschutz der SD-Karte ein und aus |
| `make-cert.sh` | Zertifikat für HTTPS auf die IP-Adresse des Pi (auf jedem Rechner mit bash) |
| `stowly-print.example.toml` | Beispiel der Konfiguration (Abschnitt [Konfiguration](#konfiguration)) |
| `stowly-print.service`, `99-stowly-brother.rules`, `journald-stowly.conf` | Systemdienst, udev-Regel, Grenzen des Journals; spielt `install.sh` ein |

Die Skripte werden mit `sudo bash pi/…` aufgerufen; sie brauchen dafür kein Ausführungsrecht.

## Einkaufsliste

| Was | Hinweis |
|---|---|
| Raspberry Pi Zero 2 W (der Zero W geht auch) | Der Zero 2 W startet schneller und hat keine Sonderfälle der alten Prozessorarchitektur |
| Netzteil 5 V, mindestens 2,5 A, Micro-USB | Der Zero kann Unterspannung nicht melden; ein schwaches Netzteil zeigt sich nur in seltsamen Fehlern |
| microSD-Karte, 16 bis 32 GB, „High Endurance" oder A1 | |
| USB-OTG-Adapter (Micro-USB-Stecker auf USB-A-Buchse) | für das Druckerkabel |
| Brother QL-800 (USB) | alternativ QL-820NWBc; den kann auch der Server über das Netz ansprechen. Der ältere **QL-570** (nur USB) geht ebenso, am Pi 5 geprüft. |
| Endlosrollen 62 mm: DK-22205 (Papier, Regal), DK-22212 (Folie, Gefrierschrank) | Etiketten werden auf 29 mm geschnitten |
| zum Einrichten: Rechner mit SD-Kartenleser und Raspberry Pi Imager, Heim-WLAN mit Internet | nur für die Installation |

**Raspberry Pi 5** statt Zero (am 14.11.2026 geprüft):
- Raspberry Pi OS Lite **64-bit** nehmen.
- Der Drucker kommt direkt an eine USB-A-Buchse, ohne OTG-Adapter.
- Netzteil: das offizielle mit 27 W, USB-C.
- Alles Weitere gilt unverändert.

Führt ein Netzwerkkabel in den Keller, geht es einfacher: ein gewöhnlicher WLAN-Access-Point dort, und der Server druckt direkt auf einen Netzwerkdrucker ([`../docs/betrieb.md`](../docs/betrieb.md), Abschnitt 14).

## Ablauf in Kürze

Die Reihenfolge ist wichtig: Der Pi braucht Internet nur beim Installieren und verliert es, sobald er Access Point ist.

1. SD-Karte beschreiben, Pi mit dem Heim-WLAN starten
2. Zertifikat erzeugen (am eigenen Rechner)
3. Dateien auf den Pi kopieren
4. `install.sh` (mit Internet)
5. Drucker anschließen, Probedruck
6. `access-point.sh`, neu starten: ab jetzt eigenes WLAN, kein Internet
7. Drucker in Stowly anlegen, vom Handy aus prüfen
8. WLAN-QR-Code an den Kellereingang
9. `overlay.sh on`: Schreibschutz, als letzter Schritt

## 1. SD-Karte

Im Raspberry Pi Imager:

- Gerät: der eigene Pi. Betriebssystem: „Raspberry Pi OS (other)" → **„Raspberry Pi OS Lite (32-bit)"** (Trixie; für den Zero 2 W geht auch 64-bit).
- Einstellungen anpassen: Hostname (etwa `stowly-drucker`), Benutzer und Passwort, **WLAN des Hauses** (nur für die Installation), Zeitzone und Tastatur, unter „Dienste" **SSH mit öffentlichem Schlüssel**.
- Schreiben, Karte in den Pi, Strom an. Der erste Start dauert auf dem Zero W einige Minuten.

Dann vom eigenen Rechner: `ssh <benutzer>@stowly-drucker.local` (oder über die IP-Adresse, die der Router zeigt).

## 2. Zertifikat

HTTPS ist auf dem iPhone der einzige Weg zum Pi und auf Android der robustere. Das Zertifikat gilt für die IP-Adresse des Pi in seinem eigenen WLAN (Vorgabe `10.71.83.1`), nie für einen Namen. Am eigenen Rechner im Ordner des Repositorys (Linux, macOS oder Git Bash unter Windows):

```
bash pi/make-cert.sh ca --ip 10.71.83.1
```

Das erzeugt in `stowly-zertifikat/` eine eigene Zertifizierungsstelle (`stowly-ca.crt`, `stowly-ca.key`, zehn Jahre) und ein Zertifikat für den Pi (`pi.crt`, `pi.key`, 825 Tage). Das Skript nennt am Ende das Ablaufdatum und den Fingerabdruck der Zertifizierungsstelle.

- **Vorhandene Zertifizierungsstelle**, der die Handys schon vertrauen: `bash pi/make-cert.sh issue --ip 10.71.83.1 --ca-cert meine-ca.crt --ca-key meine-ca.key` (Zwischenzertifikate mit `--chain`). Oder nur einen Antrag erzeugen und dort unterschreiben lassen: `bash pi/make-cert.sh csr --ip 10.71.83.1`; danach mit `bash pi/make-cert.sh show pi.crt` prüfen, dass die IP-Adresse und `serverAuth` darin stehen.
- Immer gilt: Subject Alternative Name mit der IP-Adresse, `extendedKeyUsage = serverAuth`, höchstens 825 Tage (länger nimmt das iPhone nicht an), Schlüssel nur für den Besitzer lesbar.
- `stowly-ca.key` gehört nicht auf den Pi und nicht ins Repository. Wer sie verliert, braucht beim nächsten Zertifikat eine neue Zertifizierungsstelle und muss sie neu auf jedes Handy bringen.
- **Ablauf:** Das Zertifikat des Pi läuft nach 825 Tagen ab (`bash pi/make-cert.sh show stowly-zertifikat/pi.crt` zeigt `notAfter`). Ein abgelaufenes Zertifikat sieht für die App aus wie „nicht erreichbar". Rechtzeitig mit `issue` ein neues ausstellen und nach [Aktualisieren](#aktualisieren-trotz-schreibschutz) einspielen. Die Zertifizierungsstelle selbst gilt zehn Jahre.

### Zertifizierungsstelle auf dem Handy

Einmal je Handy `stowly-ca.crt` installieren (nicht `pi.crt`):

- **Android:** Datei aufs Handy bringen (Mail, Cloud, USB). Einstellungen → Sicherheit und Datenschutz → Weitere Sicherheitseinstellungen → Verschlüsselung und Anmeldedaten → Zertifikat installieren → **CA-Zertifikat** → Datei wählen. Die Bezeichnungen weichen je nach Hersteller ab. Chrome vertraut danach dem Pi.
- **iPhone:** Datei per AirDrop, Mail oder aus „Dateien" öffnen → „Profil geladen". Einstellungen → Allgemein → VPN und Geräteverwaltung → das Profil „Stowly Drucker-CA" → Installieren. **Danach zusätzlich:** Einstellungen → Allgemein → Info → Zertifikatsvertrauenseinstellungen → „Stowly Drucker-CA" einschalten. Ohne diesen zweiten Schritt vertraut Safari dem Pi nicht.
- Probe (im WLAN des Pi, nach Schritt 6): `https://10.71.83.1:8443/v1/health` im Browser zeigt JSON mit `"app":"stowly-print"`, ohne Warnung.
- **Eine Warnung nicht wegklicken.** Bietet Safari „Diese Verbindung ist nicht privat" mit „Website trotzdem besuchen" an, fehlt der Schalter unter Zertifikatsvertrauenseinstellungen. Mit der Ausnahme zeigt Safari die Seite, die App aber meldet „Der Druckdienst antwortet auf keiner Adresse". Am iPhone gesehen (14.11.2026).

## 3. Dateien auf den Pi

Gebraucht werden nur die Ordner `print/` und `pi/` und das Zertifikat. Vom eigenen Rechner aus dem Ordner des Repositorys:

```
ssh <benutzer>@stowly-drucker.local mkdir -p stowly
scp -r print pi <benutzer>@stowly-drucker.local:stowly/
scp stowly-zertifikat/pi.crt stowly-zertifikat/pi.key <benutzer>@stowly-drucker.local:stowly/
```

## 4. Installieren (mit Internet)

Auf dem Pi:

```
cd ~/stowly
sudo bash pi/install.sh --origin https://stowly.home --cert pi.crt --key pi.key
```

- `--origin` ist die Adresse, unter der die App läuft (ohne Pfad), etwa `https://stowly.home` oder `https://<rechner>.<tailnet>.ts.net`; mehrfach möglich. Nur von diesen Ursprüngen darf die App den Pi direkt ansprechen.
- `--model` (Vorgabe `QL-800`; auch `QL-810W`, `QL-820NWB`, `QL-570` und die übrigen der Brother-Bibliothek) und `--address` (Vorgabe `usb://04f9` = der erste Brother am USB) nur, wenn es nicht der QL-800 am USB ist.
- `sudo` fragt beim Benutzer aus dem Imager nach dessen Passwort. Wer den Pi von einem anderen Rechner aus einrichtet, startet den Befehl per `ssh -t …`, damit die Frage dort ankommt.
- Das Skript sagt vor jedem Schritt, was es tut, und bricht bei einem Fehler ab: Systempakete (`python3-pil`, `python3-usb`, `python3-segno`, `python3-starlette`, `python3-uvicorn`, `python3-venv`, `python3-setuptools`, `fonts-dejavu-core`, `libusb-1.0-0`, `hostapd`, `dnsmasq`, `qrencode`, dazu `overlayroot` für den Schreibschutz am Ende), Benutzer `stowly-print` in der Gruppe `plugdev`, Programm in `/opt/stowly-print` (venv mit den Systempaketen, kein FastAPI, kein pydantic), die Brother-Bibliothek von PyPI auf Version und Prüfsumme festgelegt, udev-Regel, Konfiguration, Journal nur im Arbeitsspeicher (höchstens 16 MB), Systemdienst mit `Restart=always`, zuletzt eine Probe.
- Gebaut wird mit `python3-setuptools` aus Debian, ohne eigene Bau-Umgebung: das Programm und `packbits` (gibt es nur als Quellpaket). So lädt pip nichts, was nicht in `print/requirements-brother.txt` mit Prüfsumme steht.
- Am Ende steht das **Token** des Druckers: Es kommt in Stowly beim Drucker ins Feld „Token" (Schritt 7) und steht auch in `/etc/stowly-print/stowly-print.toml`.
- Wiederholbar: Ein zweiter Lauf bringt Programm, Dienst und Regeln auf den neuen Stand und lässt die Konfiguration samt Token stehen.

## 5. Drucker anschließen

- **Editor-Lite-Modus aus:** Beim QL-800 leuchtet sonst die grüne Lampe „Editor Lite", und der Drucker meldet sich als USB-Speicher statt als Drucker. Die Taste gedrückt halten, bis die Lampe aus ist.
- Rolle einlegen (62 mm endlos), Drucker per USB-Kabel und OTG-Adapter an die **Daten-Buchse** des Pi (beim Zero die mittlere, „USB", nicht „PWR"), Drucker einschalten.
- `lsusb` zeigt eine Zeile mit `04f9:` (beim QL-800 `04f9:209b`, beim QL-570 `04f9:2028`). Der QL-570 hat keinen Editor-Lite-Modus.
- `curl -s http://127.0.0.1:8080/v1/health` zeigt beim Drucker `"reachable":true,"ready":true`. Sonst [Fehlersuche](#fehlersuche).

**Probedruck** ohne App (druckt ein Etikett „Probedruck"):

```
sudo /opt/stowly-print/venv/bin/python - <<'EOF'
import json, tomllib, urllib.request, uuid
from stowly_print.templates import load_builtin
config = tomllib.load(open("/etc/stowly-print/stowly-print.toml", "rb"))
body = {"token": config["token"], "template": load_builtin("package"),
        "data": {"qr": "STOWLY/P/A2B3C", "id": "A2B3C", "title": "Probedruck", "subtitle": "Stowly",
                 "best_before": "", "stored": "", "zone": ""}}
request = urllib.request.Request(f"http://127.0.0.1:8080/v1/jobs/probe-{uuid.uuid4().hex[:12]}?wait=20",
                                 data=json.dumps(body).encode(), headers={"Content-Type": "text/plain"})
print(urllib.request.urlopen(request, timeout=30).read().decode())
EOF
```

Erwartet: `"state":"printed"` und ein Etikett aus dem Drucker.

## 6. Access Point

Ab jetzt hat der Pi kein Internet mehr. Vorher prüfen: Dienst läuft, Probedruck klappt.

```
sudo bash pi/access-point.sh --ssid Stowly-Keller --generate-password
sudo reboot
```

- Statt `--generate-password` geht `--password '…'` (8 bis 63 Zeichen) oder `--password-file`; ohne Angabe fragt das Skript nach. Ein erzeugtes Passwort zeigt es am Ende an, zusammen mit dem Inhalt des WLAN-QR-Codes.
- WPA2 (CCMP), Kanal 6, Land `DE`, Adresse `10.71.83.1/24` (änderbar mit `--channel`, `--country`, `--address`; dann auch das Zertifikat für die neue Adresse ausstellen). Die Handys bekommen per DHCP eine Adresse aus `10.71.83.50` bis `10.71.83.150`.
- Kein vorgetäuschtes Internet: Der Pi nennt sich als Router, leitet aber nichts weiter, und er hat kein DNS. Android fragt deshalb beim Verbinden „Dieses Netzwerk hat keinen Internetzugriff. Verbunden bleiben?": **Ja**, sonst schickt Chrome die Anfragen an den Pi ins Mobilnetz. Das iPhone bleibt nach einmaligem Verbinden.
- **Sichtbare SSID** ist die Vorgabe. `--hidden` versteckt sie; davon rät Apple ab, iPhones verbinden sich dann unzuverlässig.
- Wirksam wird alles erst beim Neustart. Danach erreicht man den Pi nur noch im WLAN „Stowly-Keller": Laptop oder Handy damit verbinden, `ssh <benutzer>@10.71.83.1`. Zurück zum Heim-WLAN: `sudo bash pi/access-point.sh --remove`, neu starten.
- Probe: Handy mit dem WLAN verbinden, `http://10.71.83.1:8080/v1/health` öffnen.

## 7. Drucker in Stowly anlegen

In der App unter Einstellungen → Drucker → „Drucker hinzufügen", Art „direkt (Raspberry Pi)":

| Feld | Wert |
|---|---|
| Adressen, in dieser Reihenfolge | `https://10.71.83.1:8443` und `http://10.71.83.1:8080` |
| Token | das Token aus Schritt 4 |
| Drucker im Dienst | leer lassen (= der erste Drucker der Konfiguration) |

- Der Ursprung der App muss in der Konfiguration des Pi stehen (`origins`, Schritt 4). Fehlt er, zeigt die App den Drucker als „blockiert".
- Danach mit dem Handy im WLAN des Pi „Verbindung prüfen". Die App weist den Pi über `nonce` und `proof` nach; ein fremdes Gerät unter derselben Adresse geht nicht als Drucker durch.
- **HTTP** geht nur in Chrome ab Version 142 (Local Network Access); Chrome fragt einmal je Ursprung um Erlaubnis. Auf dem iPhone geht nur HTTPS. Klappt keins von beiden, bietet die App „Über die Seite des Druckers drucken" an (`http://10.71.83.1:8080/p`, docs/etiketten.md 5.7).

## 8. WLAN-QR-Code für den Kellereingang

`access-point.sh` zeigt den QR-Code im Terminal und seinen Inhalt (`WIFI:T:WPA;S:…;P:…;;`). Zum Ausdrucken auf einem beliebigen Rechner mit `qrencode`:

```
qrencode -o wlan-keller.png 'WIFI:T:WPA;S:Stowly-Keller;P:<Passwort>;;'
```

Ausdrucken und an den Kellereingang kleben: Die Kamera-App beider Handys verbindet damit ohne Tippen. Der Code enthält das Passwort.

## 9. Schreibschutz der SD-Karte

Als **letzter, eigener Schritt**, wenn alles läuft: Danach geht jede Änderung am System beim Neustart verloren. Die Karte wird nicht mehr beschrieben und übersteht so auch plötzliche Stromausfälle. Der Druckdienst hält seine Aufträge ohnehin nur im Arbeitsspeicher.

```
sudo bash pi/overlay.sh on
sudo reboot
sudo bash pi/overlay.sh status     # nach dem Neustart: "Overlay jetzt: an", Boot-Partition "nur lesbar"
```

Das Skript benutzt `raspi-config` (`raspi-config nonint do_overlayfs 0`): Das trägt `overlayroot=tmpfs` in die Kernel-Befehlszeile ein (Paket `overlayroot`, kommt mit `install.sh`) und macht die Boot-Partition in `/etc/fstab` nur lesbar. Klappt es nicht, von Hand: `sudo raspi-config` → Performance Options → Overlay File System → „Ja" für das Overlay und „Ja" für die schreibgeschützte Boot-Partition.

Zurück: `sudo bash pi/overlay.sh off` (oder derselbe Menüpunkt mit „Nein"), neu starten. Danach ist das Wurzelverzeichnis wieder beschreibbar, die Boot-Partition aber noch nicht: Die ändert `raspi-config` nur, solange kein Overlay läuft. Zum Aktualisieren genügt das. Braucht ein Systemupdate (`apt`) die Boot-Partition, nach dem Neustart ein zweites Mal `sudo bash pi/overlay.sh off` und noch einmal neu starten.

## Aktualisieren trotz Schreibschutz

Der Pi hat kein Internet; neue Dateien kommen über sein WLAN.

1. Laptop mit dem WLAN des Pi verbinden. `ssh <benutzer>@10.71.83.1`, dort `sudo bash ~/stowly/pi/overlay.sh off`, `sudo reboot`. Die Boot-Partition bleibt dabei nur lesbar; für die Schritte hier ist das recht.
2. Neue Ordner hinüberkopieren: `scp -r print pi <benutzer>@10.71.83.1:stowly/`
3. Auf dem Pi: `cd ~/stowly && sudo bash pi/install.sh --offline` (ohne Internet: nur das Programm, Dienst und Regeln neu; Konfiguration und Token bleiben). Ein neues Zertifikat zusätzlich mit `--cert pi.crt --key pi.key`.
4. Konfiguration ändern (Token, Ursprünge, Drucker): `sudo nano /etc/stowly-print/stowly-print.toml`, dann `sudo systemctl restart stowly-print`.
5. Braucht ein Update neue Pakete oder eine neue Brother-Bibliothek (das steht dann in den Änderungen): `sudo bash pi/access-point.sh --remove`, neu starten (der Pi verbindet sich wieder mit dem Heim-WLAN), `sudo bash pi/install.sh`, dann wieder `access-point.sh` mit denselben Angaben, neu starten. Ein Systemupdate (`sudo apt full-upgrade`) braucht zusätzlich die beschreibbare Boot-Partition (Abschnitt 9, „Zurück").
6. Zuletzt `sudo bash pi/overlay.sh on`, `sudo reboot`.

## Konfiguration

`/etc/stowly-print/stowly-print.toml` (Beispiel: [`stowly-print.example.toml`](stowly-print.example.toml)). Nach einer Änderung: `sudo systemctl restart stowly-print`; mit Schreibschutz vorher `overlay.sh off`.

| Schlüssel | Bedeutung | Vorgabe |
|---|---|---|
| `token` | Token des Druckers, mindestens 16 Zeichen; dasselbe steht in Stowly beim Drucker | Pflicht |
| `origins` | Ursprünge der App, die direkt drucken dürfen, etwa `["https://stowly.home"]` | `[]` |
| `log_level` | `critical`, `error`, `warning`, `info`, `debug` | `info` |
| `[http]` `enabled`, `host`, `port` | HTTP-Zugang | an, `0.0.0.0`, `8080` |
| `[https]` `enabled`, `host`, `port`, `certificate`, `key` | HTTPS-Zugang; nur mit Zertifikat und Schlüssel. Taugen die nicht, bleibt HTTPS aus und HTTP läuft trotzdem. | aus, `0.0.0.0`, `8443` |
| `[[printers]]` | Drucker in fester Reihenfolge; **der erste ist der Standarddrucker** | mindestens einer |
| … `name` | Name im Druckdienst (Buchstaben, Ziffern, `-`, `_`, `.`) | Pflicht |
| … `driver` | `brother_ql` oder `image` | Pflicht |
| … `model` | Brother: `QL-800`, `QL-810W`, `QL-820NWB` (auch `QL-820NWBc`) und die übrigen der Bibliothek | – |
| … `address` | `usb://04f9`, `usb://04f9:209b`, `usb://04f9:209b/<Seriennummer>` oder `tcp://192.168.1.60:9100` | – |
| … `media` | Rolle; in dieser Stufe `62` (62 mm endlos) | `62` |
| … `directory` | nur `image`: wohin die PNG-Dateien kommen | Pflicht bei `image` |

Unbrauchbare Angaben zu einem Drucker (unbekanntes Modell, falsche Adresse, fehlende Bibliothek) halten den Dienst nicht auf: Der Drucker steht in der Liste und meldet `config`, der Grund steht im Journal. Ein Fehler in der Datei selbst (kein Token, kaputtes TOML) verhindert den Start mit einer Meldung im Journal.

## Fehlersuche

| Beobachtung | Was tun |
|---|---|
| Läuft der Dienst? | `systemctl status stowly-print`; Meldungen: `journalctl -u stowly-print -e` (Tokens stehen nie darin) |
| Antwortet er? | auf dem Pi `curl -s http://127.0.0.1:8080/v1/health`; vom Handy im WLAN des Pi `http://10.71.83.1:8080/v1/health` |
| HTTPS? | von einem Laptop im WLAN des Pi: `curl --cacert stowly-ca.crt https://10.71.83.1:8443/v1/health`; Laufzeit: `sudo openssl x509 -in /etc/stowly-print/tls/pi.crt -noout -dates` |
| Drucker meldet `offline` | nicht am USB gefunden: eingeschaltet? Editor-Lite-Modus aus? Kabel an der Daten-Buchse? `lsusb` |
| Drucker meldet `config` | Modell, Adresse oder Rolle passen nicht, oder die Brother-Bibliothek fehlt; Grund im Journal |
| `no_media`, `cover_open`, `media_mismatch` | Rolle leer, Deckel offen, andere Rolle als 62 mm endlos |
| App zeigt den Drucker als „blockiert" | Ursprung der App fehlt in `origins` |
| App zeigt „nicht erreichbar", Browser aber geht | Zertifikat (Handy vertraut der Zertifizierungsstelle nicht, iPhone: volles Vertrauen fehlt, abgelaufen) oder Android ohne „Verbunden bleiben" |
| WLAN erscheint nicht | `systemctl status hostapd`, `journalctl -u hostapd -e`; Land (`--country`) passend? `nmcli device status` muss `wlan0` als `unmanaged` zeigen, sonst greift NetworkManager ein; `rfkill list` darf für das WLAN keine Sperre zeigen |
| Handy bekommt keine Adresse | `systemctl status dnsmasq`, `ip address show wlan0` muss `10.71.83.1/24` zeigen. dnsmasq startet erst nach `network-online.target`; kurz nach dem Einschalten etwas warten |
| Overlay ist nach dem Neustart nicht an | `grep -o overlayroot=tmpfs /proc/cmdline` (fehlt: `overlay.sh on` wiederholen); `dpkg -s overlayroot` (fehlt: Aktualisieren, Schritt 5) |
| Etikett blieb „unklar" | Der Druck wurde unterbrochen (Strom, Kabel). Nichts druckt von selbst nach; in der App beantworten |

Ein Etikett, das beim Neustart des Pi noch nicht gedruckt war, kennt der Dienst danach nicht mehr (jeder Start hat eine neue `boot_id`); die App fragt dann nach, statt doppelt zu drucken.

## Ohne Pi ausprobieren

Derselbe Dienst läuft auf jedem Rechner mit Python 3.12 und dem Paket `stowly_print` (samt Starlette und uvicorn), zum Beispiel aus dem Repository heraus mit dem Bild-Treiber, der jedes Etikett als PNG schreibt. Eine Datei `probe.toml`:

```toml
token = "probe-token-0123456789abcdef"
origins = ["http://localhost:5173", "http://127.0.0.1:8010"]

[http]
host = "127.0.0.1"
port = 8021

# freiwillig, mit einem Zertifikat aus make-cert.sh für 127.0.0.1:
# [https]
# host = "127.0.0.1"
# port = 8022
# certificate = "zertifikat/pi.crt"
# key = "zertifikat/pi.key"

[[printers]]
name = "bild"
driver = "image"
directory = "etiketten"
```

Start: `python -m stowly_print serve --config probe.toml` (relative Pfade gelten ab dem Ordner der Datei). Die Etiketten liegen dann in `etiketten/`; die Seite des Druckdienstes unter `http://127.0.0.1:8021/p`. `python -m stowly_print sample --out muster` rendert die beiden Vorlagen mit Beispieldaten und den Schriften dieses Rechners.

Für Tests lässt sich der Bild-Treiber stören: eine Datei `simulate.txt` im Verzeichnis der Etiketten mit `fail` (oder `fail:cover_open`), `hang` (hängt, bis die Datei verschwindet) oder `abort` (bricht mittendrin ab).

## Was die Skripte auf dem Pi anlegen

| Skript | Dateien |
|---|---|
| `install.sh` | Benutzer `stowly-print`; `/opt/stowly-print/` (venv, README); `/etc/stowly-print/stowly-print.toml` und `tls/`; `/etc/systemd/system/stowly-print.service`; `/etc/udev/rules.d/99-stowly-brother.rules`; `/etc/systemd/journald.conf.d/stowly.conf` |
| `access-point.sh` | `/etc/hostapd/hostapd.conf` (enthält das WLAN-Passwort, nur für root); `/etc/dnsmasq.d/stowly-ap.conf`; `/etc/NetworkManager/conf.d/99-stowly-ap.conf`; `/etc/systemd/system/stowly-ap-address.service`; `/etc/sysctl.d/99-stowly-ap.conf`; über `raspi-config` das Land (`cfg80211.ieee80211_regdom=DE` in `/boot/firmware/cmdline.txt`) |
| `overlay.sh` | Einstellungen von `raspi-config`: `overlayroot=tmpfs` in `/boot/firmware/cmdline.txt`, `ro` für die Boot-Partition in `/etc/fstab` |

## Lizenz der Brother-Bibliothek

Die Bibliothek `brother_ql_next` steht unter der GPL-3.0. Stowly liefert sie nicht mit: `install.sh` (und das Container-Image) laden sie auf Version und Prüfsumme festgelegt von PyPI nach, und nur das Treiber-Modul `stowly_print/drivers/brother_ql.py` lädt sie, erst beim Benutzen. Ohne sie läuft der Druckdienst mit dem Bild-Treiber weiter; ein Brother-Drucker meldet dann `config`. Wer Stowly samt dieser Bibliothek an andere weitergibt, muss deren GPL-Bedingungen einhalten.

## Prüfliste am Gerät

Alles hier ließ sich auf dem Entwicklungsrechner nicht prüfen. Bitte der Reihe nach; hinter jedem Schritt steht, was zu sehen sein muss.

Die Skripte sind gegen die Quellen geprüft (Paketlisten von Debian, Raspbian und Raspberry Pi für Trixie, Quelltext von `raspi-config` im Zweig `trixie`, Debian-Pakete von hostapd und dnsmasq, NetworkManager 1.52). Was sich nur am Gerät klären lässt, steht in P2, P8, R1, R6, U1 und U4.

### P. Pi und Druckdienst

| # | Schritt | Erwartet |
|---|---|---|
| P1 | Pi mit frischer Karte starten, `ssh` | Anmeldung klappt, `cat /etc/os-release` nennt Trixie |
| P2 | `sudo bash pi/install.sh --origin … --cert pi.crt --key pi.key` | läuft durch; die Probe am Ende zeigt `stowly-print 0.1.0` und den Drucker; Token wird angezeigt. Bei der Brother-Bibliothek steht „Building wheel for packbits", aber kein „Installing build dependencies". Die Versionen aus Trixie: Starlette 0.46.1, uvicorn 0.32.0, Pillow 11.1.0, segno 1.6.6; bitte die Zeile notieren |
| P3 | `install.sh` gleich noch einmal | läuft durch, „gibt es schon; sie bleibt, wie sie ist", Token unverändert |
| P4 | `systemctl status stowly-print`, `journalctl -u stowly-print -e` | `active (running)`, Meldungen „Druckdienst … hört auf http://0.0.0.0:8080" und „https://0.0.0.0:8443"; kein Token im Journal |
| P5 | `id stowly-print`, `ls -l /etc/stowly-print/tls/` | Gruppe `plugdev`; `pi.key` gehört `stowly-print`, Rechte `-rw-------` |
| P6 | `sudo systemctl kill -s KILL stowly-print`, nach 5 s `systemctl status stowly-print` | läuft wieder (Restart=always) |
| P7 | `journalctl --disk-usage`, `ls /var/log/journal` | Journal nur im Arbeitsspeicher (`/run/log/journal`) |
| P8 | `/opt/stowly-print/venv/bin/python -c "import uvloop"` | läuft meist ohne Fehler: `python3-uvicorn` aus Debian zieht uvloop nach. Der Druckdienst legt trotzdem asyncio und h11 fest, wie in den Tests (`print/stowly_print/__main__.py`). Beide Zugänge (P4) und HTTPS (S1, T3) laufen; sonst bitte melden |

### Q. Drucker

| # | Schritt | Erwartet |
|---|---|---|
| Q1 | QL-800 mit Editor Lite **an** anschließen, `/v1/health` | Drucker `offline` |
| Q2 | Editor Lite aus | binnen Sekunden `reachable: true, ready: true, media_detected: true` |
| Q3 | Probedruck (Abschnitt 5) | Etikett 62 × 29 mm, sauber geschnitten; QR-Code lesbar (Handy-Kamera zeigt `STOWLY/P/A2B3C`), Text scharf, Umlaute richtig (DejaVu) |
| Q4 | Deckel öffnen, `/v1/health`; dann Probedruck | `cover_open`; Auftrag endet `failed` mit `cover_open`, nichts gedruckt |
| Q5 | Rolle entnehmen, Probedruck | `failed` mit `no_media` |
| Q6 | Während eines Drucks das USB-Kabel ziehen | Auftrag endet `unknown` (`interrupted`); nach dem Wiedereinstecken druckt nichts nach |
| Q7 | 20 Etiketten hintereinander (App: 20 Packungen einlagern) | alle in Reihenfolge, keines doppelt; `/v1/health` bleibt währenddessen erreichbar |
| Q8 | Drucker aus und wieder ein, dann Probedruck | druckt ohne Neustart des Dienstes (sonst bitte melden) |

### R. Access Point und Handys

| # | Schritt | Erwartet |
|---|---|---|
| R1 | `access-point.sh`, Neustart | WLAN „Stowly-Keller" sichtbar; `ip address show wlan0` zeigt `10.71.83.1/24`; `nmcli device status` zeigt `wlan0` als `unmanaged`; `systemctl is-active stowly-ap-address hostapd dnsmasq` dreimal `active`; `iw dev wlan0 info` zeigt `type AP`; `iw reg get` nennt `country DE` |
| R2 | Android verbinden | Frage „kein Internet, verbunden bleiben?" → Ja; `http://10.71.83.1:8080/v1/health` öffnet; mobile Daten gehen weiter (andere Seiten laden) |
| R3 | iPhone verbinden | `http://10.71.83.1:8080/v1/health` öffnet in Safari |
| R4 | Beide Handys: Adresse im WLAN | aus `10.71.83.50` bis `10.71.83.150`, Router `10.71.83.1`, kein DNS-Server |
| R5 | WLAN-QR-Code mit der Kamera-App beider Handys | verbindet ohne Tippen |
| R6 | Pi stromlos machen, wieder einschalten (mit Overlay) | WLAN und Druckdienst kommen von selbst; neue `boot_id`. Bitte die Zeit vom Einschalten bis zur Adresse am Handy notieren: dnsmasq startet erst nach `network-online.target` |

### S. Zertifikat

| # | Schritt | Erwartet |
|---|---|---|
| S1 | Android: `stowly-ca.crt` installieren, `https://10.71.83.1:8443/v1/health` in Chrome | JSON, Schloss ohne Warnung |
| S2 | iPhone: Profil installieren, volles Vertrauen einschalten, dieselbe Adresse in Safari | JSON ohne Warnung |
| S3 | iPhone: dieselbe Adresse aus der installierten Stowly-App heraus („Verbindung prüfen") | erreichbar. Bitte melden, falls nicht (offener Punkt im Plan) |
| S4 | `bash pi/make-cert.sh show pi.crt` | `IP Address:10.71.83.1`, `TLS Web Server Authentication`, Laufzeit 825 Tage |

### T. Direktdruck aus der App

| # | Schritt | Erwartet |
|---|---|---|
| T1 | Drucker in Stowly anlegen (Abschnitt 7), „Verbindung prüfen" | erreichbar, Zustand des Pi (Temperatur, Speicher) sichtbar |
| T2 | Android, nur HTTP (HTTPS-Adresse vorübergehend entfernen) | Chrome fragt nach dem lokalen Netzwerk; nach „Zulassen" druckt es |
| T3 | Android und iPhone über HTTPS: Packung einlagern | Etikett kommt; in der App „gedruckt" |
| T4 | Etikett auslösen, sofort WLAN aus, wieder an | höchstens ein Etikett; die App fragt bei Unklarheit nach |
| T5 | Ursprung der App aus `origins` entfernen, Dienst neu starten, „Verbindung prüfen" | „blockiert" |
| T6 | iPhone: „Über die Seite des Druckers drucken" | Seite `http://10.71.83.1:8080/p` zeigt die Etiketten, „Drucken" druckt, Ergebnis je Etikett; noch einmal öffnen und drucken: nichts doppelt |
| T7 | Nach dem Drucken zurück ins Heim-WLAN, App öffnen | Zustand des Pi erscheint beim nächsten Abgleich auf dem zweiten Gerät („zuletzt gesehen") |

### U. Schreibschutz und Aktualisieren

| # | Schritt | Erwartet |
|---|---|---|
| U1 | `overlay.sh on`, Neustart, `overlay.sh status` | „Overlay jetzt: an", „Boot-Partition jetzt: nur lesbar (ro)"; „Wurzelverzeichnis: overlay …"; `grep /boot/firmware /etc/fstab` zeigt genau ein `ro` |
| U2 | Datei anlegen (`touch ~/x`), Neustart | Datei ist weg |
| U3 | Aktualisieren nach Abschnitt „Aktualisieren trotz Schreibschutz" | Dienst läuft danach mit neuem Stand, Token unverändert |
| U4 | `overlay.sh off`, Neustart, `overlay.sh status`; dann `overlay.sh off` ein zweites Mal, Neustart, `overlay.sh status` | erst „Overlay jetzt: aus", Boot-Partition noch „nur lesbar (ro)"; nach dem zweiten Mal „Boot-Partition jetzt: beschreibbar (rw)" |

### V. Etiketten im Alltag

| # | Schritt | Erwartet |
|---|---|---|
| V1 | Folienetikett (DK-22212) auf eine Gefrierdose, vier Wochen bei −18 °C | haftet noch; QR-Code mit beiden Handys lesbar, auch bereift |
| V2 | Papieretikett (DK-22205) im Regal, mehrere Wochen | lesbar, löst sich nicht |
| V3 | Lange Produktnamen | zwei Zeilen, kleiner, notfalls „…"; die ID und das Einlagerdatum rechts unten vollständig (die Felder sind für die mitgelieferte Schrift DejaVu bemessen und damit nachgemessen: ID bei 6 mm, Datum bei 2,4 mm; reicht es nicht, werden sie etwas kleiner statt gekürzt). Bitte melden, wenn eines davon mit „…" endet |
