# Änderungen

Jede Version, die auf GitHub erscheint, steht hier. Der Abschnitt einer Version wird zum Text ihres Releases; die App zeigt ihn unter Einstellungen → Aktualisierung. Muss beim Umstieg etwas von Hand geschehen (`docker-compose.yml`, `.env`, der Updater), steht es unter „Von Hand".

## 0.5.1

Update per Knopf robuster.

- **Kein Neuanlegen mitten im Update:** Einrichtung → Updates riet nach dem Neustart der neuen Version „Der Updater ist älter als Stowly: Befehl erneut ausführen“, auch während das Update noch lief. Der Befehl löscht aber den laufenden Updater, und das Update blieb bei „wird installiert“ stehen.
  - Jetzt steht dort, solange ein Update läuft: „Gerade läuft ein Update. Den Updater erst danach erneuern“. Den Befehl zeigt die App erst nach „Aktualisiert auf …“, ohne Neuladen.
  - Hängt ein Update über eine Stunde, erscheint der Befehl wieder, auch bei einem aktuellen Updater, mit dem Rat, zuerst ins Log zu sehen. Einstellungen → Aktualisierung sagt es dann ebenfalls. Gemessen wird mit der Uhr des NAS, nicht mit der des Handys.
  - Meldet sich der Updater mitten im Update gar nicht, warnt die App vor dem Befehl.
- **Updater übernimmt nach einer Minute:** Wird der Updater-Container gelöscht, während er ein Update abschließt, bringt sein Nachfolger es nach einer Minute zu Ende oder kehrt zur alten Version zurück. Bisher wartete er 30 Minuten. Die Minute braucht es, weil Docker einen schon angenommenen Aufruf, etwa das Anhalten, auch ohne den gelöschten Updater zu Ende führt. Stirbt der Updater schon beim Laden des Images, bleibt es bei 30 Minuten; die alte Version läuft dann unverändert weiter.
- **Wiederanlauf beim Anhalten:** Startet ein Updater neu oder wird er ersetzt, während Docker Stowly gerade anhält, wartet er, bis es steht, und startet es wieder. Bisher konnte Stowly danach aus bleiben, obwohl es hieß, es laufe weiter.
- **Zwei Updater gleichzeitig:** Wer ein abgebrochenes Update weiterführt, trägt sich ins Journal ein. Ein zweiter Updater hält sich dann heraus, statt dasselbe Update gleichzeitig weiterzuführen. Einem Updater, der noch läuft, nimmt keiner mehr die Sperre weg.
- **Ohne eigene Container-ID** verwirft ein Updater kein abgebrochenes Update mehr. Er lässt es liegen, bis ein Updater mit ID es zu Ende bringt.

Von Hand: Nach dem Update auf 0.5.1 den Updater einmal erneuern, mit dem Befehl aus Einrichtung → Updates und auf demselben Weg wie beim Anlegen (docs/betrieb.md, Abschnitt 19.3). Erst dann übernimmt auch der Updater nach einer Minute.

## 0.5.0

Etiketten gestalten, Produktdaten neu abfragen und eine Druckerkarte, die sagt, was zu tun ist.

- **Etiketten gestalten:** Drucker → „Etiketten gestalten". Ein Papier für alle Drucker: Endlosrollen von 18 bis 62 mm, auf Wunsch quer bedruckt, und gestanzte Etiketten bis 62 mm Breite. Je für Packungs- und Zonen-Etiketten: Länge (bei Endlosrollen), QR-Code links oder rechts in drei Größen, welche Felder in welcher Reihenfolge und Größe, Datum lang oder kurz, ein eigener Text und die Trennlinie. Neue Felder: Zone, Marke und Größe einzeln, kurzes Datum. Die Vorschau zeigt das echte Etikett; „Probedruck" druckt eines zum Vergleich. Wer den Editor nie öffnet, bekommt die Etiketten wie bisher.
- **Produktdaten neu abfragen:** „Online abfragen" oben in „Produkt bearbeiten" fragt Open Food Facts jetzt, auch für einen Barcode, der früher unbekannt war. Name, Marke, Größe und Bild stehen nebeneinander; übernommen wird nur, was angehakt ist, und gespeichert erst mit „Speichern".
- **Druckerkarte:** Grün nur noch, wenn Druckdienst und Drucker bereit sind. Antwortet der Pi, der Drucker aber nicht, steht gelb, was zu tun ist (Drucker einschalten, USB-Kabel prüfen). Nach „Verbindung prüfen" steht die eingelegte Rolle in der Karte. Beim Koppeln eines Pi gilt dasselbe.
- **Druckdienst 0.5.0:** druckt jedes Papier des Katalogs, auch gestanzt, und vergleicht vor jedem Druck die eingelegte Rolle mit dem Etikett. Passt sie nicht, druckt er nichts und sagt, welche Rolle fehlt.

Von Hand: Für ein anderes Papier als die 62-mm-Endlosrolle braucht der Pi den neuen Druckdienst. Dafür den Pi einmal neu koppeln: Drucker → „Raspberry Pi koppeln" → „Vorhandenen Drucker übernehmen"; Token und Drucker bleiben. Bis dahin bleiben solche Etiketten ausstehend, statt falsch gedruckt zu werden. Mit der 62-mm-Rolle und bis 62 mm Länge druckt auch der alte Druckdienst die neuen Etiketten.

## 0.4.0

Der Einrichtungsassistent, Stufe B: Sicherung und Home Assistant geführt in der App, ohne Neustart. Die Umgebung geht weiter vor.

- **Sicherung in der App:** Den Schlüssel erzeugt der Browser; nur der öffentliche geht an Stowly, den geheimen hebt man an zwei Orten auf. Ihn prüfen, Uhrzeit und Schalter einstellen, einen Schlüssel hinzufügen nur mit dem Haushalts-Passwort. Die Sicherungen gehen nach `/backups`, wenn dort ein eigener, beschreibbarer Ordner eingebunden ist, sonst in den Datenordner, mit Hinweis. „Jetzt sichern" und die Sicherungen im Ordner zum Herunterladen, verschlüsselt.
- **Zurückspielen in der App:** in den Einstellungen mit Passwort und Rückfrage. Geräte, Passwort, Push und Einstellungen bleiben; Stowly startet neu, alle Geräte laden neu, und sieben Tage lang geht „Rückgängig". Beim ersten Start steht „Aus einer Sicherung wiederherstellen" neben dem Passwort, für einen Umzug oder ein neues NAS.
- **Home Assistant in der App:** Adresse und Token eintragen, „Verbindung prüfen" zeigt die Listen von HA, dazu „Sensor-Token erzeugen" mit fertigem YAML zum Kopieren. Die Tokens liegen außerhalb der Datenbank und jeder Sicherung.
- **Listenwechsel sicher:** Ein Wechsel der Liste in HA hakt nichts mehr ab. Die Einträge bleiben in der alten Liste stehen und gehen neu in die neue.
- **Assistent:** neue Schritte „Sicherung" und „Home Assistant". Wer die Einrichtung schon abgeschlossen hat, findet sie unter Einstellungen → „Einrichtung und Zugang" zum Nachholen.
- **Sicherheit:** Produktbilder nur noch als JPEG, PNG oder WebP; die Grenze für Anfragen gilt auch ohne `Content-Length`.

Von Hand: Die unverschlüsselte Sicherung zum Herunterladen gibt es nicht mehr; herunterladen lassen sich nur noch die verschlüsselten aus dem Ordner. Wer `STOWLY_BACKUP_*` oder `STOWLY_HA_*` in der `.env` hat, behält das; die App zeigt es an und sperrt es. `STOWLY_BACKUP_DIR=/backups` und `STOWLY_BACKUP_TIME=03:30` aus der früheren `.env.example` dürfen raus: Dann wählt Stowly den Ordner selbst, und die Uhrzeit lässt sich in der App einstellen (docs/betrieb.md, Abschnitt 8.5).

## 0.3.1

- **Raspberry Pi koppeln hinter Docker auf DSM:** Das Koppeln scheiterte mit „Stowly sieht den Pi unter einer anderen Adresse (172.19.0.1) …", denn Docker auf DSM stellt jede Anfrage mit der Adresse seines eigenen Netzes zu. Jetzt prüft Stowly bei jeder Kopplung die gemeldete Adresse selbst nach: Der Pi weist sich dort während des Koppelns auf Port 8080 für genau diesen Antrag aus; sein Druckdienst ruht dafür einige Sekunden. Ein Zertifikat gibt es nur für eine Adresse, unter der wirklich dieser Pi antwortet. Ein Kopplungscode verlängert sich nur noch beim ersten Melden des Pi.
- **Updater-Container bei Vorabversionen:** Der Befehl aus dem Assistenten nannte bei einer Vorabversion ein Image, das es noch nicht gab (`:0.3.0` statt `:0.3.0-rc.4`), und der Updater-Container startete nicht. Das Image kennt jetzt sein Tag (`STOWLY_IMAGE_TAG`).

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
