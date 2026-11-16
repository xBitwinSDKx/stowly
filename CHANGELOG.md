# Änderungen

Jede Version, die auf GitHub erscheint, steht hier. Der Abschnitt einer Version wird zum Text ihres Releases; die App zeigt ihn unter Einstellungen → Aktualisierung. Muss beim Umstieg etwas von Hand geschehen (`docker-compose.yml`, `.env`, der Updater), steht es unter „Von Hand".

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
