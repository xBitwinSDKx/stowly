# Stowly – Plan: Einrichtungsassistent, Stufe A

## Kontext

Heute braucht ein neuer Haushalt für Stowly die Kommandozeile:
- Passwort, Push-Kontakt und Update-Repository stehen in der `.env`.
- HTTPS kommt über einen Reverse Proxy mit einer selbst erzeugten CA (`pi/make-cert.sh`).
- Der Pi wird per SSH, `scp` und abgetipptem Token eingerichtet.

Ziel (dein Wunsch vom 16.11.): Den Container nur per Mausklick in DSM anlegen, alles Weitere geführt in Stowly, jeder Schritt überspringbar, so einfach wie möglich.

Der Assistent kommt in zwei Stufen, jede für sich fertig und nutzbar. Dieser Plan beschreibt **Stufe A** im Einzelnen, Stufe B nur im Umriss. Ihr Plan folgt, wenn A bei dir läuft.

## Deine Entscheidungen

- **Erstes Passwort:** Es setzt, wer die Seite zuerst öffnet; einen Einrichtungscode gibt es nicht. `STOWLY_PASSWORD` in der Umgebung geht weiter vor.
- **HTTPS:** Stowly macht es selbst, mit eigener Zertifizierungsstelle (CA) und Port 8443 im Container. Ein Reverse Proxy ist nicht nötig. Der Assistent führt auf dem iPhone durch „Profil laden" und „Vertrauen einschalten".
- **Pi:** ein Befehl mit Kopplungscode auf dem frischen Pi. Er lädt alles vom Stowly-Server, bekommt Zertifikat und Token, und der Drucker erscheint von selbst.
- **Container:** per Mausklick in der Docker-Oberfläche von DSM. Für Updates per Knopf führt der Assistent zu einem kleinen zweiten Container, dem Updater.
- **In die App (die Umgebung geht weiter vor):**
  - Push-Kontakt;
  - Updates (Repository vorbelegt, nur ein Schalter);
  - in Stufe B Sicherungen sowie Home Assistant und Bring!.
- **Image:** zusätzlich auf Docker Hub, damit DSM 6.2 es findet.
- **Zwei Stufen:**
  - **A:** Passwort, HTTPS, Pi, Updates samt Updater-Container und Docker Hub, Push.
  - **B:** Sicherungen mit im Browser erzeugtem Schlüssel, Home Assistant mit Bring!.
- **Dein NAS:**
  - Stowly erzeugt eine **neue CA** mit Namensbeschränkung. Die Stowly Drucker-CA hat danach ausgedient.
  - HTTPS macht **Stowly selbst unter derselben Adresse** `https://<nas>:8443`; die Regel im DSM-Proxy fällt weg.
  - Der Pi wird über den Assistenten neu gekoppelt.
- **Probe:** parallel als Testcontainer, dein Stowly läuft weiter.

## So läuft es für einen neuen Haushalt

**Am NAS, einmal, nur in der DSM-Oberfläche:**
1. **Ordner:** In der File Station einen Ordner anlegen, etwa `docker/stowly`.
2. **Image:** Docker → Registrierung → „stowly" suchen → `<konto>/stowly` laden, Tag `latest`.
3. **Container:** Image → Starten, Name `stowly`. Unter „Erweiterte Einstellungen":
   - automatischer Neustart an;
   - Volume `docker/stowly` → `/data`;
   - Ports fest: in der Spalte **Lokaler Port** 8010 und 8443 eintragen; der Container-Port bleibt.

   Umgebungsvariablen braucht es keine.

**In Stowly, im Browser am PC oder am iPhone:**
1. **Erster Aufruf:** `http://<nas>:8010` zeigt „Willkommen bei Stowly". Passwort zweimal eingeben, dann ist man angemeldet und der Assistent beginnt.
2. **Sichere Verbindung:** Das Zertifikat gilt schon für die Adresse, unter der die Seite offen ist.
   - Zertifikat der CA laden: am PC per Knopf, fürs iPhone per QR-Code.
   - Die Anleitung passt zum Gerät: iPhone/iPad, Android, Windows, Mac.
   - Stowly prüft, ob das Gerät der CA vertraut. Dann „Zur sicheren Adresse wechseln", dort einmal anmelden, und es geht beim nächsten Schritt weiter.
3. **Drucker:**
   - kurze Anleitung zur SD-Karte (Raspberry Pi Imager);
   - der Befehl mit Code zum Kopieren;
   - der Assistent wartet, bis der Pi sich meldet. Dann steht der Drucker in Stowly, der Pi hat ein Testetikett gedruckt, und „Verbindung prüfen" zeigt, dass das Handy ihn erreicht.
4. **Updates:**
   - der Schalter „Nach Updates suchen";
   - für Updates per Knopf den Updater-Container einmal über den DSM-Aufgabenplaner anlegen. Der Befehl kommt fertig aus dem Assistenten, und Stowly zeigt „Updater bereit".
5. **Benachrichtigungen:** Kontakt-Adresse für die Push-Dienste. Danach auf diesem Gerät einschalten; auf dem iPhone geht das nur in der App auf dem Home-Bildschirm.
6. **Fertig:** eine Übersicht der Schritte. Übersprungene Schritte lassen sich später unter Einstellungen → „Einrichtung" nachholen.

## 1. Zugang: Passwort beim ersten Start

**Speichern**
- Der Hash (scrypt, N=2^15, r=8, p=1, maxmem 64 MiB, PHC-Format) liegt in `meta.password_hash`, wie die VAPID-Schlüssel.
- `STOWLY_PASSWORD` geht vor und wird beim Start als Hash übernommen. Entfernt man die Variable später, gilt das Passwort weiter; es entsteht kein offenes Fenster.
- Der Entwicklungs-Rückfall „stowly" wird nie gespeichert.

**Erstes Passwort:** `POST /api/setup/password {password (8–200), device_name}`, ohne Anmeldung
- Nur solange es kein Passwort gibt, sonst 409.
- Gegen das Rennen: Modul-Lock plus `INSERT` ohne Upsert, so gewinnt genau einer. Das Gerät entsteht im selben Zug, die Antwort gleicht der Anmeldung.
- Nur mit einem `Host` aus dem Heimnetz (private IP, einteiliger Name oder lokale Endung), sonst 400. Das hält DNS-Rebinding von fremden Seiten ab.
- Gebremst wie die Anmeldung.

**Ändern:** `POST /api/auth/password {current_password, new_password}`, angemeldet
- Ein falsches bisheriges Passwort zählt in der Bremse und meldet `invalid_password`, nie so, dass der Kern das Gerät abmeldet.
- 409, wenn das Passwort aus der Umgebung kommt. Andere Geräte bleiben angemeldet.

**Was sich sonst ändert**
- `ServerHealth.configured` heißt jetzt: Es gibt ein Passwort (aus der Umgebung oder der App). `Settings.configured` fällt weg.
- Ohne Passwort meldet das Start-Log: „Noch kein Passwort: Wer Stowly jetzt öffnet, vergibt es."
- Neue Ereignisse `server.password_set` und `server.password_changed`.
- In `docs/sync-protokoll.md` §5 wird der Satz „Es gibt keinen Endpunkt, der es ohne Anmeldung setzt …" neu gefasst.

## 2. HTTPS durch Stowly

**Dateien** (`server/stowly/tls.py`, `TlsManager` in `app.state.tls`)
- Alles liegt in `/data/tls` (0700): `ca.crt`, `ca.key` (0600), `server.pem` (Schlüssel und Zertifikat, 0600). Geschrieben wird atomar.
- Nichts davon kommt in die Datenbank oder in die Sicherungen, denn die manuelle Sicherung ist unverschlüsselt. Beim Umzug muss das Volume deshalb mit.

**Vorhandene CA laden**
- Liegen `ca.crt` und `ca.key` schon da (vom letzten Start oder von Hand hineingelegt), lädt Stowly sie nach Prüfung: selbst signiert, CA, keyCertSign, Schlüssel passt, noch mindestens 30 Tage gültig.
- Fehlt eine der Dateien oder ist sie unlesbar, meldet Stowly das und überschreibt nichts.

**Neue CA**
- P-256, 10 Jahre gültig, pathlen 0, Name „Stowly CA <6 Hex>".
- Name Constraints, nicht kritisch markiert, damit Geräte ohne Unterstützung nicht ablehnen:
  - private Netze 10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7 und Loopback;
  - lokale Namen local, lan, home, home.arpa, internal, localdomain, fritz.box, localhost.
- So taugt ein gestohlener CA-Schlüssel nicht für fremde Seiten.

**Serverzertifikat**
- P-256, 397 Tage gültig, CN „Stowly", SAN aus den Adressen, EKU serverAuth.
- Neu ausgestellt wird es bei neuer Adresse, bei gewechselter CA oder bei weniger als 60 Tagen Restlaufzeit; das prüft ein täglicher Job.
- Ohne bekannte Adresse gilt es vorläufig für `localhost` und `127.0.0.1`.
- Für die Pi-Kopplung gibt es `sign_csr(...)`.

**Adressen lernen**
- Quellen: der `Host` beim Setzen des Passworts und der angemeldeten Aufrufe unter `/api/setup`.
- Nur private IPs und lokale Namen, höchstens 10, nur was die CA deckt. Weitere Adressen lassen sich von Hand unter „Erweitert" eintragen.
- Port und „schon über HTTPS gesehen" kommen nur aus Anfragen über HTTPS.

**Zwei Listener** (`__main__.py`)
- Zwei `uvicorn.Server` laufen in einer Ereignisschleife, beide mit `lifespan="off"`, gemeinsam innerhalb von `app.router.lifespan_context(app)`. So stehen die Dienste, bevor ein Port aufgeht, und enden erst nach beiden Listenern.
- Signale behandelt Stowly selbst für beide Listener; `release_waiting` läuft vor dem Abbau.
- **Reihenfolge:** HTTP startet zuerst; scheitert es, endet Stowly mit Exit 3. Danach HTTPS: Scheitert es, etwa weil der Port belegt ist, läuft HTTP weiter, und der Status nennt das Problem.
- **Port:** aus `STOWLY_HTTPS_PORT`, im Image 8443. Ohne Angabe ist HTTPS aus, also auch in Tests und beim Entwickeln.
- **Zertifikat tauschen ohne Neustart:** `load_cert_chain` auf demselben Kontext, nur in der Ereignisschleife und nach einer Probe in einem eigenen Kontext. Laufende Verbindungen behalten das alte Zertifikat.
- Kein HSTS. Der Healthcheck bleibt auf HTTP.

**CA zum Herunterladen:** `GET /api/setup/ca.crt`, ohne Anmeldung, als DER
- ohne Parameter `application/x-x509-ca-cert` inline (iPhone-Profil, Firefox);
- mit `?download=true` als Datei `stowly-ca.crt` (Android, Windows, Mac).

## 3. Einstellungen aus der App

**Tabelle `server_config`** (Migration 0004)
- JSON-Werte mit `updated_at` und `updated_by`; nie Geheimnisse, nicht im Sync.
- Inhalt: Push-Kontakt, Updates an/aus, Fortschritt des Assistenten, Adressen, externer HTTPS-Port, gesehene Ursprünge.
- Bestehende Haushalte, also solche mit Geräten, gelten nach der Migration als eingerichtet. Der Assistent drängt sich dort nicht auf.

**Schnittstelle:** `GET/PATCH /api/server-config` liefert je Feld Wert und Quelle (`env`, `app` oder `default`). Kommt ein Feld aus der Umgebung, antwortet PATCH mit 409.

**Vorrang**

| Einstellung | Reihenfolge |
|---|---|
| Push-Kontakt | `STOWLY_PUSH_CONTACT` vor App |
| Updates | `STOWLY_UPDATE_REPO` (fest an) vor Schalter in der App vor aus |

Das Vorgabe-Repository kommt aus dem Image (`STOWLY_UPDATE_REPO_DEFAULT`).

**Ohne Neustart**
- PushService, Tagesnachricht und UpdateChecker laufen immer und lesen den wirksamen Wert erst beim Einsatz. Ein Umschalten weckt den Checker (`reconfigure()`).
- `IntegrationStatus` behält seine Form, zeigt aber die wirksamen Werte.

**Einrichtungsstatus**
- `GET /api/setup` liefert die Schritte mit Zustand (offen, erledigt, übersprungen) und `ready` aus Sicht des Servers. `ready` heißt je Schritt: über HTTPS gesehen, Drucker da, Updates wirksam, Kontakt wirksam.
- Dazu kommen die Quelle des Passworts und für HTTPS: Port, Adressen, CA mit Fingerabdruck, Zertifikat, Problem.
- `PATCH /api/setup` setzt Schritt, Abschluss, Adressen und Port. Erledigt ist ein Schritt, wenn er `ready` oder als erledigt markiert ist; übersprungen markiert die App.

**Stufe B nicht verbauen:** Sicherung und Home Assistant folgen demselben Muster. Der HA-Token kommt nicht in `server_config`, sondern in einen Speicher, den beide Sicherungen auslassen.

## 4. Drucker: Pi per Kopplungsbefehl

**Paket im Image**
- `server/stowly/pi_bundle.py` packt ein immer gleiches `pi-bundle.tar.gz`: ganz `pi/`, dazu aus `print/` die Dateien `pyproject.toml`, `requirements-brother.txt` und `stowly_print/`.
- Gebaut wird es in einer eigenen Stufe im Dockerfile; der Pfad steht in `STOWLY_PI_BUNDLE`. Im Quell-Checkout baut der Server das Paket im Speicher.

**Befehl:** `curl -fsSL http://<nas>:8010/api/pi/install.sh | sudo sh -s -- ABCD-EFGH`
- Das Startskript ist eine Vorlage mit Server-Adresse und SHA-256 des Pakets.
- Es lädt das Paket, prüft die Summe, entpackt nach `/tmp` und ruft `pi/install.sh --pair <server> <code>`.
- Es läuft bewusst über HTTP im Heimnetz. Die Doku zeigt, wie man das Skript vorher ansieht.

**Kopplung am Server** (`server/stowly/pairing.py`, `api/pi.py`, Tabelle `pi_pairings`, nicht im Sync)
- **`POST /api/pi/pairings`** (angemeldet, `{origin, printer_id?}`)
  - Code: 8 Zeichen Crockford-Base32 als `XXXX-XXXX`, 30 Minuten gültig, einmalig. Gespeichert wird nur der Hash. Ein neuer Code macht ältere ungültig.
  - Die Antwort enthält den fertigen Befehl.
  - `printer_id` heißt „vorhandenen Drucker übernehmen". Das braucht dein heute von Hand eingerichteter Pi.
- **`GET /api/pi/pairings/{id}`:** Zustand `waiting`, `installing`, `paired`, `expired` oder `cancelled`, dazu der Drucker und der Pi (Hostname, Adressen, Modell, Ablauf des Zertifikats). `DELETE` bricht ab.
- **`POST /api/pi/pair`** (ohne Anmeldung, nur mit Code, eigene Bremse)
  - Gleich nach dem Laden meldet sich der Pi einmal (`stage: start`). Der Assistent zeigt dann „Der Pi richtet sich ein …".
  - Nach der Installation schickt der Pi Hostname, private IPv4-Adressen, eine CSR, das Token und das Modell.
  - **Zertifikat:** Der Server signiert die CSR mit der Stowly-CA. SAN sind die gemeldeten IPs, `<hostname>.local` und `10.71.83.1` (für einen späteren Access Point). Eine Adresse der App selbst kommt nie hinein.
  - **Antwort:** Zertifikat, CA, erlaubte Ursprünge (der Ursprung aus der Kopplung und die HTTPS-Ursprünge der App) und die Adressen des Druckers.
  - Kommt dieselbe CSR noch einmal (Netzaussetzer), gibt es dieselbe Antwort.

**Drucker als Server-Schreibvorgang** (Muster aus `shopping.py` und `bring.py`)
- **Neu anlegen:**
  - Zeile in `printers` mit `db.next_rev`; die Konfiguration entsteht über `DirectPrinterConfig`, damit die Grenzen des Vertrags gelten.
  - Ereignis `printer.paired` ohne Gerät und ohne Token.
  - Adressen: `https://<IP>:8443`, `https://<hostname>.local:8443`, `http://<IP>:8080`.
- **Neu koppeln:**
  - Nur `config` ändert sich.
  - Die Feld-Uhr `printer/<id>/direct` geht auf jetzt; so überschreibt eine ältere Offline-Änderung die Kopplung nicht.
  - Neuer `rev`, `updated_at` wird nachgezogen.
- Den Standarddrucker setzt die App über die normale Einstellung.

**Auf dem Pi** (`install.sh --pair`, dazu `python -m stowly_print pair` und `selftest` mit `print/stowly_print/pairing.py`, nur Standardbibliothek und openssl)
- **Pakete:** nur, was fehlt (apt mit Lock-Timeout, denn beim ersten Start ist apt oft belegt). Das Programm kommt wie bisher aus dem Paket.
- **Skripte:** nach `/opt/stowly-print/pi/`, damit `access-point.sh` und `overlay.sh` später bereitliegen.
- **Drucker:** Erkennung über sysfs (Hersteller 04f9, Tabelle der Produkt-IDs, Hinweis „Editor Lite ausschalten"). Ein vorhandenes Token bleibt.
- **Schlüssel und CSR** mit openssl; der Schlüssel verlässt den Pi nie.
- **Konfiguration:**
  - Erst nach gelungener Kopplung neu schreiben, die alte als `.bak`.
  - `dump_config` mit Rundreise-Test, `[https]` immer, Ursprünge vom Server.
  - `/etc/stowly-print/pairing.json` merkt sich Server und Drucker (ohne Token).
- **Zum Schluss:** Dienst neu starten, Selbsttest (HTTP, dann HTTPS gegen `ca.crt`), Testetikett, wenn der Drucker bereit ist.
- **Neu koppeln:** derselbe Befehl mit neuem Code, etwa bei neuer IP oder vor Ablauf des Zertifikats nach 825 Tagen. Die App warnt 60 Tage vorher.
- Der eigene WLAN-Access-Point bleibt außerhalb des Assistenten und wie bisher in `pi/README.md` beschrieben.

## 5. Image, Rechte, Compose

**Ergebnis der NAS-Probe (16.11.)**
- Ein in DSM angelegter Ordner unter `docker` gehört dem DSM-Benutzer und hat die Rechte 777 („Linux mode", ohne ACL). Stowly schreibt dort als uid 10001 ohne Zutun, auch SQLite im WAL-Modus. Ein Probecontainer mit 0.2.1 lief darauf sofort `healthy`.
- DSM schreibt beim Anlegen alle Umgebungsvariablen des Images in den Container, setzt den Hostnamen auf den Containernamen, nutzt den Log-Treiber `db` und `CpuShares` 50. Die Container-ID steht in `/proc/self/mountinfo`.
- Docker 20.10.3, Engine API 1.41, btrfs, AppArmor. Aus einem Container mit `--network none`, `--read-only` und `--volumes-from` geht der Socket als root.
- In der Oberfläche landet eine Portnummer leicht in der falschen Spalte. Die Anleitung sagt deshalb ausdrücklich: in die Spalte **Lokaler Port**; der Container-Port bleibt.

**Rechte deshalb wie bisher**
- Das Image bleibt bei `USER 10001`, ohne Start als root und ohne Rechteabgabe; Compose ändert sich nicht.
- Ist `/data` nicht beschreibbar, etwa ein Ordner mit Windows-ACL auf einem anderen NAS: Statt einer Neustart-Schleife zeigt eine kleine Hilfeseite auf 8010 Ursache und Abhilfe (`rescue.py`; in DSM beim Ordner „Jeder: Lesen/Schreiben").
- `/api/health` antwortet dort mit 503. Der Container bleibt unhealthy, und beide Updater kehren zur alten Version zurück.

**Image**
- `EXPOSE 8010 8443`.
- ENV: `STOWLY_HTTPS_PORT=8443`, `STOWLY_PI_BUNDLE`, `STOWLY_IMAGE_REF`; das Vorgabe-Repository der Updates kommt per Build-Argument.
- Healthcheck unverändert über HTTP.

**Compose und `.dockerignore`**
- `docker-compose.yml` bleibt bis auf Kommentare, wie sie ist. Port 8443 wird nicht standardmäßig veröffentlicht; wer ihn will, nimmt `docker-compose.override.yml`.
- `.dockerignore`: `pi/` kommt ins Image, ohne Tests.

## 6. Updates im Mausklick-Weg: Updater-Container und Docker Hub

**Updater-Container** (`python -m stowly.updater`, Paket `server/stowly/updater/`)
- **Bausteine:** `docker.py` spricht die Engine API über den Unix-Socket, nur mit der Standardbibliothek. Dazu `clone.py` (reine Funktionen) und `run.py`.
- **Anlegen:** DSM 6.2 kann `docker.sock` in der Oberfläche nicht einbinden. Deshalb legt der Anwender den Updater einmal über den Aufgabenplaner an: „Benutzerdefiniertes Skript" als root, „Ausführen", danach die Aufgabe löschen.
- **Befehl:** kommt fertig vom Server (`UpdateStatus.updater_command`), etwa
  `/usr/local/bin/docker rm -f stowly-updater; /usr/local/bin/docker run -d --name stowly-updater --restart unless-stopped --user 0:0 --network none --read-only --tmpfs /tmp --no-healthcheck -v /var/run/docker.sock:/var/run/docker.sock --volumes-from <id> <image>:<version> python -m stowly.updater`
- **Herzschlag:** in `/data/update/updater` mit `kind=container`.
  - Protokoll und Sperre sind dieselben wie beim Host-Updater.
  - Ziel ist der Container mit derselben `/data`-Quelle. Einen Compose-Container lehnt der Updater ab, denn Compose holte sonst die Version aus der `.env` zurück.
- **Update:**
  1. Version prüfen.
  2. Image laden: Fehler im Datenstrom beachten, drei Versuche.
  3. Container anhalten, Datenbank sichern (drei Kopien bleiben), umbenennen.
  4. Neu anlegen nach den Regeln von watchtower: aus `Config` nur, was vom alten Image abweicht; `HostConfig` und Netze übernehmen, anonyme Volumes auch.
  5. Starten und bis 3 Minuten auf `healthy` warten.
  6. Dann den alten Container löschen (nie samt Volumes) und alte Images aufräumen. Sonst zurück zur alten Version.
  - Nach einem Absturz läuft er über ein Journal wieder an.
- **Härtung:** In `/data/update` schreibt der Server ohne Rechte, der Updater als root. Deshalb folgt der Updater keinen Symlinks (`O_NOFOLLOW`, `lstat`, eigene Zwischendateien).
- **Dieselbe Lücke im Host-Updater schließen:** `stowly-update.sh` folgt heute Links (`: > "$LOG"`, vorhersagbare Zwischendatei, `cp -p` der Datenbank). Ein übernommener Container könnte so als root Dateien auf dem NAS schreiben.
- **Kein Selbst-Update in Stufe A:** Die App zeigt die Version des Updaters und rät bei einer alten, den Befehl erneut auszuführen.

**Docker Hub**
- `release.yml` lädt zusätzlich nach `docker.io/<konto>/stowly`, wenn die Secrets `DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN` und die Variable `DOCKERHUB_IMAGE` gesetzt sind. Es gilt dieselbe Tag-Regel: `latest` nur für die höchste Version.
- Die Kurzbeschreibung auf Docker Hub (sie erscheint in der DSM-Suche) wird einmal von Hand gesetzt.

## 7. Der Assistent in der App

**Kern** (`web/src/contract/core.ts`, `core/index.ts`, `core/http.ts`)
- `SyncStatus.server_configured` kommt aus `GET /api/health`; heute wird der Wert verworfen.
- `session.createPassword(password, deviceName)` meldet danach an, wie die Anmeldung. Dazu `session.changePassword(current, next)`.
- `setup.load()` und `setup.update(changes)`; `setup.reachesSecurely(origin)` prüft per no-cors und wirft nie.
- `serverConfig.load()` und `update()`. Ein neuer Push-Kontakt setzt den Push-Zustand zurück (`push.serverChanged()`).
- `printers.pair(…)`, `pairing(id)`, `cancelPairing(id)`. Ist ein Drucker gekoppelt, aber lokal noch nicht da, stößt der Kern einen Abgleich an.

**Anmeldeschranke** (`SessionGate.tsx`)
- Bei `server_configured === false` erscheint „Willkommen bei Stowly" statt der Anmeldung: Passwort zweimal, Gerätename.
- Bei `conflict`: „Inzwischen ist ein Passwort festgelegt. Bitte damit anmelden."
- Nach dem ersten Passwort führt ein Rückruf (wie `onLogout`) zu `/einrichtung`.

**Automatisch öffnen:** nur wenn der Server erreichbar ist, die Einrichtung nicht abgeschlossen ist und auf diesem Gerät nicht „Später fortsetzen" gewählt wurde.

**Seite `/einrichtung/:step?`** (Vollbild wie `/scan`, eigener Chunk, nicht vorgeladen)
- **Rahmen:** Kopf mit Fortschritt, am Handy „Schritt 2 von 5", dazu „Später fortsetzen". Fuß mit Zurück, Überspringen und Weiter.
- **Sichere Verbindung:**
  - Läuft die Seite schon über HTTPS, auch hinter einem Reverse Proxy, ist der Schritt erledigt.
  - Sonst: Zertifikat laden, Anleitung je Plattform (`TrustGuide`, vorgewählt und umschaltbar). Geprüft wird bei der Rückkehr auf die Seite und per Knopf.
  - **Wechsel zu HTTPS:**
    1. Abgleichen.
    2. Auf http abmelden; nicht, solange Änderungen noch nicht beim Server sind.
    3. `https://<host>:<port>/einrichtung#geraet=<Name>` öffnen. Dort steht: „Fast geschafft: einmal anmelden."
  - Tipp fürs iPhone: erst zum Home-Bildschirm hinzufügen, dann dort anmelden, denn die App dort hat ihren eigenen Speicher.
- **Drucker:**
  - SD-Karte, Befehl mit Kopier-Knopf (`CopyField`), Restzeit, „Neuer Code".
  - Abfrage alle 3 Sekunden, nur bei sichtbarer Seite. Zustände: wartet, richtet sich ein, gekoppelt, abgelaufen.
  - Hostname und IP des Pi zur Kontrolle.
  - Standarddrucker setzen, falls es keinen gibt, dann „Verbindung prüfen"; über http steht dort nur ein Hinweis.
  - Auf der Druckerseite gibt es zusätzlich „Raspberry Pi koppeln", auch für „vorhandenen Drucker übernehmen".
- **Updates:**
  - Schalter, gesperrt, wenn der Wert aus der Umgebung kommt.
  - Updater-Zeile „bereit, zuletzt vor 1 Min." oder die Anleitung für den Aufgabenplaner mit dem Befehl. Abfrage alle 10 Sekunden, bis „bereit" erscheint.
  - Hinweis für Compose-Installationen.
- **Benachrichtigungen:** Kontakt-Adresse, danach `PushSetting` dieses Geräts. Auf dem iPhone ohne installierte App steht die Anleitung für den Home-Bildschirm.
- **Fertig:** Übersicht mit „Nachholen" und ein Hinweis zu weiteren Geräten.

**Einstellungen**
- Neuer Abschnitt „Einrichtung und Zugang": Stand und „Öffnen", „Passwort ändern", Push-Kontakt.
- Über http ein Banner mit „Sichere Verbindung einrichten".
- `UpdateSection` zeigt den Schalter statt der Variablen.

**Bausteine:** `CopyField` (mit Rückfall ohne `navigator.clipboard`), `QrCode` (aus `ZoneQr` gelöst), `useVisibleInterval`, `detectPlatform`.

**Bündel:** Alles für die Einrichtung kommt in einen nachgeladenen Chunk. Nach dem Bau gilt: `index-*.js` höchstens 490 kB und ohne `qrcode`.

**Mock und Tests:** Szenarien `unconfigured`, `setup-open`, `setup-env`, `no-https`; dazu Routen im Fake-Server sowie Tests für Kern, Oberfläche und e2e.

## 8. Doku und Version

- **Version 0.3.0.** Im CHANGELOG für Compose-Installationen „Von Hand": den Ordner `updater/` neu kopieren (gehärteter Host-Updater).
- `scripts/release.py` setzt künftig auch `stowly_print.__version__`. Heute meldet der Druckdienst dort noch 0.1.0, und diese Nummer schickt der Pi beim Koppeln mit.
- **`docs/betrieb.md`:**
  - neuer Weg „Per Mausklick in DSM": Registrierung, Ordner, Ports fest, Updater-Container;
  - Betrieb ohne Reverse Proxy;
  - die CA auf jedem Gerätetyp;
  - `/data/tls` beim Sichern und Umziehen.
- **`docs/integrationen.md`:** HTTPS mit eigener CA, Vorrang der Umgebung, Updater-Container (10.7), Push-Kontakt aus der App.
- **`docs/sync-protokoll.md`:** Anmeldung (§5), Einrichtung und Server-Einstellungen (§11), neue Ereignisse (§12), Migration 0004.
- **`pi/README.md`:** Koppeln als Hauptweg; der Weg von Hand steht unter „Erweitert".
- **`docs/pruefliste.md`:** neue Punkte. Der Plan kommt als `docs/plan-einrichtung.md` ins Repository.

## Probe und Umstieg deines NAS (Runde 3, mit dir)

**Vorab**
1. **Docker Hub:** Du legst ein kostenloses Konto und einen Zugangs-Token („Read & Write") an. In GitHub hinterlegst du die Secrets `DOCKERHUB_USERNAME` und `DOCKERHUB_TOKEN` sowie die Variable `DOCKERHUB_IMAGE`. Ich nenne dir jeden Klick; den Token sehe und tippe ich nie.
2. **`v0.3.0-rc.1`:** Die Pipeline legt das Image auf ghcr.io und Docker Hub ab, als Vorabversion ohne `latest`.

**Probe am frischen Container** (parallel, dein Stowly läuft weiter)
3. **Anlegen per Mausklick in DSM:**
   - Ordner `docker/stowly-test`;
   - Image `<konto>/stowly:0.3.0-rc.1` aus der Registry-Suche;
   - Container `stowly-test` mit den Ports 8020 → 8010 und 8444 → 8443.
4. **Assistent ganz durchgehen, am PC und am iPhone:**
   - Passwort vergeben.
   - Test-CA aufs iPhone (Profil und Vertrauen); dabei die Name Constraints prüfen.
   - Wechsel auf `https://<nas>:8444`.
   - Updater-Container über den Aufgabenplaner, Push-Kontakt.
   - Pi koppeln. Ab hier druckt dein Stowly bis Schritt 10 nicht direkt; deshalb alles an einem Tag.
5. **Fehler beheben**, falls nötig mit `rc.2`.
6. **`v0.3.0` veröffentlichen:** Der Testcontainer bietet das Update an, und der Updater-Container installiert es. Das ist die echte Probe des Mausklick-Wegs.

**Umstieg deines Stowly**, am selben Tag
7. **Vor dem Update:**
   - den neuen Ordner `updater/` kopieren;
   - in der `.env` `STOWLY_PUBLISH=8010` setzen (Heimnetz, für Pi-Installer und CA).
   - Dann Update per Knopf über den Host-Updater.
   - Prüfen: Anmeldung (das Passwort aus der `.env` ist übernommen), Push, Home Assistant. HA bleibt unberührt, es prüft das Zertifikat nicht (`verify_ssl: false`).
8. **Neue CA aufs iPhone:**
   - Am PC `http://<nas>:8010` öffnen, anmelden → Einstellungen → Einrichtung → Sichere Verbindung. Stowly lernt dabei die Adresse für sein Zertifikat; sonst trägst du sie unter „Erweitert" ein.
   - Mit dem iPhone den QR-Code scannen → Profil laden → installieren → Vertrauen einschalten.
   - Am PC dasselbe, falls du Stowly dort über HTTPS nutzt.
9. **HTTPS umstellen:**
   - die Regel im Reverse Proxy von DSM löschen;
   - `docker-compose.override.yml` mit `8443:8443` anlegen (Compose und Host-Updater lesen sie von selbst);
   - `starten.sh` ausführen.
   - Die App auf dem iPhone öffnet dieselbe Adresse und bleibt angemeldet; Push bleibt.
10. **Pi neu koppeln:** Drucker → „Raspberry Pi koppeln" → „vorhandenen Drucker übernehmen", dann der Befehl am Pi. Prüfen mit Testetikett und Direktdruck vom iPhone.
11. **Aufräumen:**
    - Testcontainer, Ordner und Test-CA vom iPhone entfernen.
    - Die Stowly Drucker-CA hat ausgedient. Sobald alles läuft, kannst du ihr Profil auf dem iPhone und das Zertifikat „Stowly" in DSM löschen; die Dateien auf dem PC sicherst oder löschst du.

## Umsetzung

Wie bisher: Opus 5.5 mit maximalem Aufwand; die Agents committen nicht.

**Runde 0, ich**
- **NAS-Probe mit dir** (per SSH; `sudo` tippst du):
  - Rechte an einem in DSM angelegten Ordner (`ls -lnd`, `synoacltool`).
  - `docker run` als 10001, als Eigentümer, als root mit Rechteabgabe und mit `--cap-drop ALL`.
  - Ein Container aus der DSM-Oberfläche: `inspect` als Fixture, Fähigkeiten, Container-ID.
  - Der Aufgabenplaner: Benutzer, `PATH`, `docker.sock`; dazu die Version der Engine API und die Registry-Suche.
  - Das Ergebnis legt `privileges.py` und den Befehl für den Updater fest.
- **Vertrag:**
  - alle neuen Modelle, Endpunkte, LIMITS und Ereignisse;
  - Migration 0004 mit `server_config` und `pi_pairings`;
  - Export und `test_contract`;
  - die Schnittstelle `tls.sign_csr` für den Pi-Worker.
- **Doku-Grundlage** in `docs/sync-protokoll.md` und `docs/integrationen.md`.

**Runde 1, parallel**
- **Worker Server-Kern:**
  - `auth` (scrypt, erstes Passwort, Ändern, Übernahme aus der Umgebung), `serverconfig`, `wizard`, `tls`;
  - `__main__` mit zwei Listenern, `api/setup.py`, `api/serverconfig.py`;
  - wirksame Werte in Push, Tagesnachricht und Updates;
  - Tests: `test_setup_password`, `test_server_config`, `test_tls`, `test_https` und Anpassungen.
- **Worker Pi und Container:**
  - `pi_bundle`, Startskript, `pairing` und `api/pi.py` mit dem Drucker-Schreibvorgang;
  - `stowly_print pair`/`selftest` und `dump_config`, `install.sh --pair`;
  - `rescue` (Hilfeseite), Updater-Container, Härtung von `stowly-update.sh`;
  - Dockerfile, Compose, `.dockerignore`, `.env.example`, `release.yml`;
  - Tests: `test_pi_pairing`, `test_pi_bundle`, `test_rescue`, `test_container_updater`, `print/tests/test_pairing` und die Tests des Updaters.
- **Worker Oberfläche:** Kern, Anmeldeschranke, Willkommensseite, `/einrichtung` mit Schritten, `TrustGuide`, `PairPi`, Einstellungen, Bausteine, Mock, Fake-Server, Tests.
- **Ich:** Doku (`docs/betrieb.md`, `pi/README.md`, CHANGELOG, Prüfliste) und die Abstimmung zwischen den Workern.

**Runde 2, ich**
- Zusammenführen, alle Prüfungen, e2e.
- Den Server lokal mit beiden Listenern und eigener CA im Browser prüfen.
- Bündel messen, dann ein lokaler Commit.

**Runde 3, mit dir:** Docker Hub, Vorabversion, Probe am frischen Container, `v0.3.0`, Umstieg deines NAS. Die Schritte stehen in „Probe und Umstieg deines NAS".

## Wichtige Dateien

**Neu**
- Server: `server/stowly/tls.py`, `serverconfig.py`, `wizard.py`, `pairing.py`, `pi_bundle.py`, `pi_install.sh` (Vorlage), `rescue.py`, Paket `updater/`, `api/setup.py`, `api/serverconfig.py`, `api/pi.py`, `migrations/0004_setup.sql`.
- Pi: `print/stowly_print/pairing.py`.
- Web: `web/src/features/setup/*`, `features/printers/PairPi.tsx`, `features/settings/SetupSection.tsx`, `PasswordDialog.tsx`, `ui/CopyField.tsx`, `ui/QrCode.tsx`, `contract/platform.ts`.

**Geändert**
- Server: `server/stowly/__main__.py`, `app.py`, `auth.py`, `api/auth.py`, `api/system.py`, `config.py`, `push.py`, `daily.py`, `updates.py`, `integrations.py`, `contract/api.py`, `contract/limits.py`.
- Pi und Updater: `pi/install.sh`, `print/stowly_print/__main__.py` und `config.py`, `updater/stowly-update.sh`.
- Image und Release: `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.env.example`, `.github/workflows/release.yml`.
- Web:
  - Vertrag und Kern: `web/src/contract/core.ts`, `routes.ts`, `core/index.ts`, `http.ts`, `push/device.ts`.
  - App-Rahmen: `app/SessionGate.tsx`, `App.tsx`, `routes.tsx`, `pages.tsx`, `Shell.tsx`.
  - Features: `features/auth/index.tsx`, `settings/index.tsx`, `UpdateSection.tsx`, `PushSetting.tsx`.
  - Test-Doubles: `mock/core.ts`, `core/testing/fake-server.ts`.
- Doku wie in Abschnitt 8.

**Wiederverwendet**
- Server:
  - `LoginGuard` und `auth.create_device`;
  - das `meta`-Muster aus `push.py` (VAPID);
  - die Server-Schreibvorgänge aus `shopping.py`/`bring.py`;
  - `DirectPrinterConfig`;
  - Dateiprotokoll und `read_fields` aus `updates.py`;
  - die Test-CA aus `tests/test_config.py`.
- Druckdienst: `_usable_tls` aus `print/stowly_print/__main__.py`.
- Web: `respondsWithoutCors`, `ZoneQr`, den Takt aus `UpdateSection.tsx`, `ProblemNotice` und `lazyPage`.

## Verifikation

**Automatisch**
- **pytest Server**, neue Fälle:
  - erstes Passwort mit Rennen und Host-Regel, Ändern, Übernahme aus der Umgebung;
  - `server_config` und Vorrang;
  - TLS: Felder, Name Constraints (Handshake gegen ein fremd signiertes Zertifikat scheitert), Übernahme, Neuausstellen, Neuladen;
  - beide Listener mit echten Sockets, auch mit belegtem Port;
  - Kopplung mit CSR, der Drucker kommt per Sync;
  - Paket und Startskript, Hilfeseite bei nicht beschreibbarem `/data`;
  - Updater-Container gegen eine nachgebildete Engine API: Klonregeln, Rückkehr, Wiederanlauf.
- **pytest Druckdienst:** Kopplung, Rundreise von `dump_config`, Tabelle der Modelle.
- **Host-Updater:** neu mit Symlinks.
- Dazu vitest, `npm run typecheck`, ruff, die Vertragsprüfung und die Bündelgröße.

**Weitere Prüfungen**
- **e2e:** erstes Passwort, ein zweiter Versuch gibt 409, Assistent bis „Fertig", Passwort ändern, Kopplung mit einem nachgebildeten Pi.
- **Im Browser:** echter Server mit beiden Listenern; Assistent über http, dann der Wechsel auf https.
- **CI:** `v0.3.0-rc.1` legt das Image samt Pi-Paket auf ghcr.io und Docker Hub ab, als Vorabversion ohne `latest`.
- **Am NAS und am iPhone, mit dir:** siehe „Probe und Umstieg deines NAS". Dabei die Name Constraints der neuen CA am iPhone prüfen; lehnt iOS ab, fallen sie weg, bevor dein Stowly umsteigt.

## Risiken

- **Erstes Passwort:** Bis es gesetzt ist, kann jeder im Heimnetz es setzen. Dagegen helfen die Host-Regel und der Hinweis im Log. Wer eine alte Sicherung ohne Hash und ohne Variable zurückspielt, öffnet den Server wieder für ein „erstes Passwort"; die Doku sagt das.
- **Kopplung ohne Anmeldung:** Der Endpunkt signiert Zertifikate einer CA, der die Handys vertrauen. Dagegen stehen:
  - ein Code mit 40 Bit, 30 Minuten gültig, gebremst;
  - SAN nur private IPs und `.local`, nie eine Adresse der App;
  - bei einer neuen CA zusätzlich die Name Constraints.
  - Bei einer übernommenen CA ohne Beschränkung wiegt ein abgefangener Code schwerer. Die App zeigt Hostname und IP des Pi zur Kontrolle.
- **HTTP im Heimnetz:** einmal für das Passwort und für den Pi-Installer, bewusst so. Wer das Heimnetz mitliest, hat ohnehin viel in der Hand.
- **CA-Schlüssel auf dem NAS:** Wer das Volume hat, kann Zertifikate ausstellen; bei einer neuen CA nur für Adressen im Heimnetz.
- **Updater:** root mit `docker.sock` heißt root auf dem NAS, wie schon beim Host-Updater. Beide werden gegen Symlinks gehärtet.
- **Andere NAS:** Ein Ordner mit Windows-ACL ist für uid 10001 womöglich nicht beschreibbar. Dann hilft die Hilfeseite mit einem Klick in DSM. Bei dir ist der Ordner beschreibbar, das hat die Probe gezeigt.
- **DSM 6.2:** Die Registry-Suche nach dem eigenen Image prüfen wir in Runde 3. Die Ports gehören in die Spalte „Lokaler Port"; die Anleitung sagt das ausdrücklich.
- **Feste IP des NAS:** nötig, denn Zertifikat und Ursprung der App hängen daran.
- **iPhone:** Man meldet sich zweimal an, einmal in Safari und einmal in der App auf dem Home-Bildschirm.
- **`/data/tls`** ist nicht in den Sicherungen: Beim Umzug das Volume mitnehmen, sonst entsteht eine neue CA.

## Stufe B (Umriss, eigener Plan nach A)

- **Sicherungen:**
  - Das age-Schlüsselpaar entsteht im Browser. Den geheimen Teil zeigt Stowly einmal zum Sichern oder Herunterladen; der öffentliche wird in der App gespeichert.
  - Ordner `/backups` als zweites Volume in DSM.
- **Home Assistant und Bring!:**
  - Adresse, Token (nicht in `server_config`, in beiden Sicherungen ausgelassen), Liste mit Live-Prüfung, Sensor-Token erzeugen.
  - `BringSync` baut seinen Client bei Änderungen neu.

## Nicht enthalten

- der eigene WLAN-Access-Point des Pi im Assistenten;
- eine vorhandene CA über die App hochladen;
- Selbst-Update des Updater-Containers;
- der Reverse-Proxy-Weg im Assistenten (nur erkannt);
- das Druckermodell zur Laufzeit erkennen;
- ein Test mit Android (kein Gerät).

## Änderungen während der Umsetzung

- **Rechte (NAS-Probe, Runde 0):** Ein Ordner aus der DSM-Oberfläche ist für uid 10001 beschreibbar. Das Image bleibt deshalb bei `USER 10001`, ohne Start als root, und Compose ändert sich nicht. Für andere NAS bleibt die Hilfeseite.
- **Ablauf des Pi-Zertifikats für alle Geräte:** `SetupStatus.paired_printers` liefert je Drucker die jüngste Kopplung samt `not_after`; die Druckerseite warnt 60 Tage vorher auf jedem Gerät.
- **Updater-Befehl ohne `--log-opt`:** Auf DSM gilt der Log-Treiber `db`, der die Option womöglich ablehnt.
- **Nach der Sicherheitsprüfung (Runde 2):**
  - Der Updater-Container nimmt sein Journal nur an, wenn root es geschrieben hat, und prüft jeden Container darin gegen Docker.
  - Ein Pi bekommt nur ein Zertifikat für die IP, von der er sich meldet. `<hostname>.local` gibt es nur bei Hostnamen mit `stowly` am Anfang.
  - Beide Updater lehnen ältere Versionen ab. Der Host-Updater liest `request` nur nach dem Umbenennen in einen eigenen Ordner.
  - Die Bremse der Kopplung lässt sich nicht mehr durch Wiederholen zurücksetzen. Ein Pi übernimmt einen vorhandenen Drucker nur mit dessen Token.
  - `fritz.box` gilt nicht mehr für das erste Passwort, denn `.box` ist eine öffentliche Endung.
- **Probe in Runde 3** (Testcontainer mit `0.3.0-rc.4`):
  - iOS 27 nimmt die CA mit nicht kritischen Name Constraints an.
  - Eine Vorabversion meldet sich mit der Nummer der fertigen Version. Deshalb nannte der Befehl für den Updater-Container das Image `:0.3.0` statt `:0.3.0-rc.4`, und der Testcontainer bietet 0.3.0 nicht als Update an.
  - 0.3.0 entsteht deshalb aus genau dem geprüften Stand. Die Korrektur des Befehls und die Probe des Update-Knopfs (M11) kommen mit 0.3.1, nach dem Umstieg des NAS.
- **Umstieg des NAS (Runde 3):** Das neue Koppeln des Pi scheiterte mit 422: Docker auf DSM stellt jede Anfrage mit der Adresse seines eigenen Netzes zu (172.19.0.1), und Stowly signierte nur die Adresse der Anfrage. Ab 0.3.1 prüft Stowly dann die gemeldete Adresse selbst nach (Rückprüfung mit dem Nachweis über das Token auf Port 8080 des Pi, `docs/sync-protokoll.md` 11.8). Der Pi druckte währenddessen unverändert mit dem Zertifikat der alten Drucker-CA.
