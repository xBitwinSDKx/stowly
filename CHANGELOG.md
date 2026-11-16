# Änderungen

Jede Version, die auf GitHub erscheint, steht hier. Der Abschnitt einer Version wird zum Text ihres Releases; die App zeigt ihn unter Einstellungen → Aktualisierung. Muss beim Umstieg etwas von Hand geschehen (`docker-compose.yml`, `.env`, der Updater), steht es unter „Von Hand".

## 0.3.0

Der Einrichtungsassistent, Stufe A: Container per Mausklick anlegen, alles Weitere geführt in der App.

- **Erstes Passwort in der App:** Gibt es noch kein Passwort, zeigt Stowly „Willkommen bei Stowly", und wer die Seite zuerst öffnet, legt es fest. `STOWLY_PASSWORD` geht weiter vor. Ändern geht unter Einstellungen → „Einrichtung und Zugang".
- **HTTPS durch Stowly selbst:** eigene Zertifizierungsstelle, Zertifikat für die Adresse des NAS, ein zweiter Listener auf Port 8443. Ein Reverse Proxy ist nicht mehr nötig. Der Assistent führt auf jedem Gerät durch das Vertrauen.
- **Raspberry Pi mit einem Befehl koppeln:** Der Pi lädt alles von Stowly, bekommt sein Zertifikat, und der Drucker erscheint von selbst.
- **Einstellungen in der App:** Push-Kontakt und der Schalter „Nach Updates suchen". Die Umgebung geht weiter vor.
- **Updater-Container:** Updates per Knopf auch für einen Container, der per Mausklick in DSM entstand.
- **Docker Hub:** Das Image erscheint zusätzlich auf Docker Hub; DSM findet es dort über die Suche.
- **Sicherheit:** Der Updater folgt in `/data/update` keinen symbolischen Links mehr.
- **Druckdienst:** meldet jetzt die Version des Releases (bisher immer 0.1.0). `install.sh` installiert nur noch fehlende Pakete; neu ist `install.sh --pair`.

Von Hand, für Installationen mit Docker Compose: den Ordner `updater/` neu auf den Rechner kopieren. Wer HTTPS durch Stowly will: `docker-compose.override.yml` mit Port 8443 und `STOWLY_PUBLISH=8010` (docs/betrieb.md, Abschnitt 20.2).

## 0.2.1

Probe des Updates per Knopf in der App. Stowly selbst ändert sich nicht.

## 0.2.0

Die erste Version auf GitHub.

- **Stufe 2:**
  - Mindestbestand und Einkaufsliste mit automatischen Einträgen, die Einkaufsliste in Bring! über Home Assistant.
  - Sensor und Liste aller Waren für Home Assistant.
  - Benachrichtigungen per Web-Push, FIFO-Hinweis beim Scannen, Statistik.
  - Automatische, verschlüsselte Sicherungen.
- **Updates über GitHub:** Der Server meldet neue Versionen, und die App installiert sie per Knopf. Das erledigt der Updater auf dem Rechner, mit Sicherung vorher und Rückkehr zur alten Version, falls die neue nicht startet.
- **Fertiges Image:** `ghcr.io/<konto>/stowly`, ohne die Brother-Bibliothek. Einen Brother-Drucker direkt am Server gibt es nur mit einem selbst gebauten Image; über den Raspberry Pi geht alles wie bisher.
- **Synology DSM:** Der Betrieb ist in `docs/betrieb.md` beschrieben.

Von Hand, einmal: `docker-compose.yml` und den Ordner `updater/` auf den Rechner kopieren. In der `.env` `STOWLY_IMAGE`, `STOWLY_VERSION` und `STOWLY_UPDATE_REPO` setzen. Dann die Aufgabe für den Updater anlegen (docs/betrieb.md, Abschnitt 9).
