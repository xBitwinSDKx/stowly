# Stowly – Plan für Stufe 2

## Kontext

Stufe 1 ist fertig und lokal committet: Bestand, Offline-Betrieb, Scannen, Etikettendruck und Pi-Druckdienst. Geprüft ist sie hier mit Tests und im Browser, dazu auf deinem iPhone über einen Testaufbau. In deiner Umgebung (Docker, Drucker, Pi) steht die Prüfliste `docs/pruefliste.md` noch aus. Der Plan von Stufe 1 liegt unter `docs/plan-stufe-1.md`.

Stufe 2 bringt, was dort als „später" stand. Deine Entscheidungen:

- **Home Assistant mit Bring!:** Die Einkaufsliste von Stowly landet über HA in Bring!. Stowly speichert dafür nur einen HA-Token, nie Zugangsdaten für Bring!.
- **Benachrichtigungen direkt aus Stowly** (Web-Push), und zwar nur bei Neuem.
- **Sicherungen:** automatisch und verschlüsselt in einen Ordner auf dem Server.

## Umfang

1. Mindestbestand und Einkaufsliste
2. Einkaufsliste nach Bring! über Home Assistant
3. Home Assistant: Sensor mit Zusammenfassung
4. Benachrichtigungen per Web-Push
5. FIFO-Hinweis
6. Statistik: verbraucht und entsorgt
7. Automatische, verschlüsselte Sicherungen
8. Aufräumen aus Stufe 1: das Hauptpaket der App unter die Warngrenze bringen, dazu Kleinigkeiten bei Tastatur und Screenreader

Nicht in Stufe 2 (bleibt für Stufe 3): CSV-Import und -Export, Cookidoo, Verbrauchsprognose.

## Entscheidungen

### 1. Mindestbestand und Einkaufsliste

- **Mindestbestand:** Jedes Produkt bekommt im Produkt-Dialog dieses Feld, als Anzahl Packungen (leer heißt: keiner).
  - Es zählt jede Packung im Bestand, auch eine abgelaufene.
  - Der Wert gilt je Produkt. Wer „3 Milch, egal welche Marke" will, führt die Produkte zusammen; ein Produkt kann mehrere Barcodes haben. Das steht als Hinweis am Feld.
  - Die Bestandsliste markiert Produkte unter dem Mindestbestand sofort, auch offline.
- **Einkaufsliste:** ein neuer Datensatz im Abgleich. Ein Eintrag hat freien Text oder ein Produkt und eine Menge, wenn man will; er ist offen oder erledigt.
  - Mögliche Befehle: anlegen, ändern (dazu gehört das Abhaken) und löschen.
  - Offline lässt sich ein Eintrag anlegen wie alles andere.
  - Den Knopf „Auf die Einkaufsliste" gibt es im Bestand und nach dem Entnehmen der letzten Packung.
- **Automatische Einträge legt der Server an,** sobald der Bestand eines Produkts unter seinen Mindestbestand fällt. Das passiert beim Entnehmen oder wenn ein Mindestbestand neu gesetzt wird. Der Eintrag lautet etwa „fehlt: 2".
  - Reicht der Bestand wieder, verschwindet der Eintrag.
  - Wurde er abgehakt oder gelöscht, kommt er erst zurück, wenn das Produkt wieder eingelagert oder sein Mindestbestand geändert wird.
  - Online steht er Sekunden nach dem Entnehmen auf der Liste, offline erst nach dem nächsten Abgleich.
- **Eigene Einträge** zu einem Produkt sind erledigt, sobald dieses Produkt eingelagert wird.
- **Aufbewahrung:** Erledigte und gelöschte Einträge verschwinden nach der Aufbewahrungsdauer der Lösch-Historie von den Geräten, wie entnommene Packungen.
- **Zusammenführen:** Werden Produkte zusammengeführt, wandern ihre Einträge mit.

### 2. Einkaufsliste nach Bring!

- **Hin:** Der Server spiegelt offene Einträge in die To-do-Liste von HA, die mit Bring! verbunden ist (`todo.add_item`).
  - Als Name nimmt er das Produkt oder den Text.
  - Als Beschreibung schreibt er z. B. „fehlt 2 · Stowly"; in Bring! ist das die „Spezifikation".
  - Ist ein Eintrag in Stowly erledigt oder gelöscht, hakt der Server ihn in Bring! ab; dort wandert er zu „zuletzt gekauft".
- **Zurück:** Wird ein Artikel in Bring! abgehakt oder gelöscht, ist der Eintrag in Stowly erledigt (eingekauft).
- **Eure Artikel bleiben unberührt:**
  - Steht ein Artikel gleichen Namens schon in Bring!, legt Stowly keinen zweiten an, ändert ihn nicht und hakt ihn nie ab. Wird er abgehakt, gilt der Eintrag in Stowly als eingekauft.
  - Was ihr selbst in Bring! eintragt, übernimmt Stowly nicht in seine Liste.
- **Verzögert:** Ein Eintrag geht erst nach Bring!, wenn er zwei Minuten offen ist (Zeit für Rückgängig und Tippfehler) und einen Namen hat. Spätere Umbenennungen übernimmt Bring! nicht.
- **Abgleich:** Der Server gleicht nach jeder Änderung ab und sonst alle zwei Minuten; Bring! selbst aktualisiert sich in HA alle 90 Sekunden.
  - Stowly merkt sich, was es zuletzt geschrieben hat.
  - Als „in Bring! gelöscht" gilt ein Artikel erst, wenn er zweimal nacheinander fehlt, während HA und die Liste erreichbar sind. Ein Neustart von HA leert so nicht eure Liste.
- **Ohne HA** funktioniert die Einkaufsliste in der App genauso, nur ohne Bring!.

### 3. Home Assistant: Sensor

- **Endpunkt:** `/api/ha/summary` darf nur lesen und hat einen eigenen Token, der nur für ihn gilt.
  - Zustand des Sensors: die Zahl der Packungen, die bald ablaufen.
  - Attribute: abgelaufen, gesamt, das nächste ablaufende Produkt, Länge der Einkaufsliste, kurze Listen und ein fertiger deutscher Satz wie „Heute laufen 2 Packungen ab: …".
- **Abfrage:** HA fragt den Endpunkt mit seiner `rest`-Integration ab.
- **Ansagen** (Sprachausgabe, Licht) baut ihr in HA als Automation mit Zeit-Auslöser. Stowly schickt keinen Webhook.
- **Doku:** `docs/betrieb.md` bekommt fertige YAML-Schnipsel für den Sensor, die Vorlagen-Sensoren und eine Beispiel-Ansage, dazu Hinweise zur eigenen CA.

### 4. Benachrichtigungen per Web-Push

- **Wann:** täglich zur eingestellten Uhrzeit, aber **nur, wenn seit der letzten Nachricht etwas neu** „läuft bald ab" oder „abgelaufen" ist.
  - Die Uhrzeit ist eine Einstellung des Haushalts (Vorgabe 17:00).
  - Mit zählen auch frisch eingelagerte Packungen, die schon so weit sind.
- **Inhalt:** Die Nachricht nennt das Neue und die Gesamtzahl, etwa „Neu bald fällig: Joghurt (16.11.). Insgesamt 3 bald, 1 abgelaufen". Tippen öffnet die Warnungen. Je Packung kommen höchstens zwei Nachrichten.
- **Nachholen:** War der Server zur Uhrzeit aus, kommt die Nachricht später, aber nur bis 21 Uhr.
- **Einschalten** je Gerät unter Einstellungen → „Dieses Gerät", per Knopf; die Erlaubnis darf der Browser nur nach einem Tipp erfragen. Daneben gibt es „Testnachricht senden".
- **iPhone:** Push geht nur, wenn Stowly auf dem Home-Bildschirm installiert ist (ab iOS 16.4). Sonst erklärt die App das, statt einen Knopf zu zeigen, der nichts tut. Auf Android geht es auch im Browser.
- **Abmelden:** Wird ein Gerät abgemeldet, endet auch sein Push.

### 5. FIFO-Hinweis

- **Beim Scannen:** Jemand entnimmt eine Packung als „verbraucht", während eine Packung desselben Produkts mit früherem MHD im Bestand liegt. Dann zeigt die Scan-Ansicht neben „Rückgängig": „Älter: XYZ12 · MHD 03.12. · Keller".
- **Tauschen:** Wer tauschen will, tippt auf „Rückgängig" und scannt die ältere Packung. So stimmen Etikett und Bestand immer überein.
- **Bestandsliste:** Sie markiert die Charge, die als Nächstes dran ist.
- **Offline:** Das läuft rein in der App, auch ohne Verbindung.

### 6. Statistik

- **Ansicht:** Eine neue Ansicht „Statistik" zeigt:
  - je Monat verbraucht und entsorgt (Balken)
  - den Anteil des Entsorgten
  - die Produkte, die am häufigsten entsorgt werden
  - die Zahlen je Zone

  „Versehentlich gelöscht" zählt nicht.
- **Berechnung:** Der Server rechnet aus allen Packungen über die ganze Zeit; die Geräte behalten Entnommenes nur für die Aufbewahrungsdauer. Die Ansicht braucht deshalb Verbindung und sagt das, wenn sie offline ist.
- **Diagramme:** schlichtes SVG, ohne zusätzliche Bibliothek.

### 7. Sicherungen

- **Ablauf:** täglich um 03:30 (in der `.env` einstellbar).
  - Kopie der Datenbank mit Prüfung, wie bei der heutigen Sicherung zum Herunterladen.
  - Gepackt und **verschlüsselt im Format age**.
  - Abgelegt im Ordner `./backups` auf dem Server. Er muss dem Benutzer des Containers gehören (uid 10001).
- **Schlüssel:** Verschlüsselt wird an **öffentliche Schlüssel**, die du mit `age-keygen` erzeugst.
  - Mehrere Schlüssel sind möglich und empfohlen, etwa einer im Passwortmanager und einer ausgedruckt.
  - Der Server kennt nur die öffentlichen. Wer Server oder Ordner erbeutet, kann die Sicherungen nicht lesen.
- **Aufbewahrung:** 7 tägliche, 4 wöchentliche, 12 monatliche Sicherungen.
  - Aufgeräumt wird nur nach einer gelungenen Sicherung und nur bei Stowlys eigenen Dateien.
  - War der Server um 03:30 aus, holt er die Sicherung beim Start nach.
- **Kein Klartext im Ordner:** Der Server schreibt in eine Zwischendatei und benennt sie erst um, wenn sie fertig ist.
- **Zustand in der App** unter „Sicherung": letzte gelungene, Größe, verwendete Schlüssel, Fehler.
  - Nach 48 Stunden ohne Sicherung warnt die App.
  - Die Sicherung zum Herunterladen bleibt.
- **Doku:** Ein Ordner auf derselben Platte ersetzt keine Kopie außer Haus; `docs/betrieb.md` sagt das. Dort steht auch das Zurückspielen: `age -d -i schluessel.txt … | gunzip`, danach wie bisher Abschnitt 8. Eine Probe-Entschlüsselung vorab gehört dazu.

### 8. Aufräumen aus Stufe 1

- **Hauptpaket:** Die Scan-Ansicht und die neuen Ansichten werden über das vorhandene `lazyPage` (`web/src/app/pages.tsx`) nachgeladen. Das Entsperren des Tons bleibt sofort da.
- **Fokus:** nach dem Umsortieren von Zonen und nach dem Wiederherstellen in der Lösch-Historie.
- **Dialog:** das ✕, während der Dialog arbeitet.

## Technische Leitplanken

- **Protokoll 2:** `min_stock`, die Einkaufsliste und `notify_time` sind neu, deshalb steigt `PROTOCOL_VERSION` (`server/stowly/contract/__init__.py`) auf 2.
  - Befehle aus der Outbox einer alten App bleiben gültig.
  - Die App-Datenbank v3 lädt beim Umstieg einmal alles neu.
  - Bei 409 `protocol_mismatch` sucht die App sofort nach der neuen Version, nicht erst nach Ablauf der Stunde in `web/src/core/pwa/updates.ts`.
- **Der Server schreibt selbst:** Automatische Einträge und der Abgleich mit Bring! erzeugen Änderungen ohne Gerät (`device_id` leer), mit eigenen Ereignistypen.
- **MHD am Server:** `expiryState` und `warnDaysFor` (`web/src/contract/mhd.ts`) bekommen ein Gegenstück in Python. Dieselben Testfälle (JSON) prüfen beide Seiten; ebenso Testfälle für die automatischen Einträge.
- **Zeit:** „heute" und alle Uhrzeiten gelten in `STOWLY_TIMEZONE`, das beim Start geprüft wird. Die Zeitzonendaten liefert das Paket `tzdata`, weil Windows und das schlanke Image keine eigenen haben.
- **Zeitplan:** eine Schleife im Server nach dem Muster von `server/stowly/off.py` (eingereichte Uhr, `wake`), ohne neue Bibliothek.
  - Sie prüft jede Minute, ob eine Aufgabe heute fällig ist und noch nicht lief; das wird je Aufgabe in der Datenbank gemerkt. So sind Sommer- und Winterzeit und das Nachholen abgedeckt.
  - Packen und Verschlüsseln laufen in einem eigenen Thread, damit der Sync nicht wartet.
- **Push:**
  - Verschlüsselung nach RFC 8291/8292, selbst geschrieben auf `cryptography` und gegen die Testvektoren der RFC geprüft.
  - Der VAPID-Schlüssel liegt in der Datenbank (Tabelle `meta`), damit eine zurückgespielte Sicherung ihn mitbringt. Die App vergleicht beim Start den Schlüssel und meldet sich neu an, wenn er abweicht.
  - Der Server nimmt nur https-Adressen bekannter Push-Dienste an. Sonst könnte ein Gerät den Server Anfragen ins Heimnetz schicken lassen.
  - Die Nachricht hat das Format „Declarative Web Push". Die absolute Adresse darin gibt die App beim Anmelden mit.
  - `Topic` und TTL sorgen dafür, dass ein Handy nach einem Funkloch nur die neueste Nachricht bekommt.
  - Abgelaufene Abos (404/410) räumt der Server weg.
- **Tokens:** Der HA-Token steht nur in der `.env`, nie in der Datenbank, einer Sicherung oder dem Log. Am besten gehört er einem eigenen HA-Benutzer. Der Sensor-Token gilt nur für `/api/ha/summary` und wird in konstanter Zeit verglichen.
- **Neue Pakete,** mit Version und Prüfsumme in `server/requirements.lock` und mit Wheels für Linux und Windows:
  - `cryptography` samt `cffi` und `pycparser`
  - `pyrage` 1.4.0 (age, MIT)
  - `tzdata`

  Der Pi braucht keine neuen Pakete.
- **Migration 0003:** neue Spalte `products.min_stock`, neue Tabellen `shopping_items`, `push_subscriptions`, `ha_links` und `job_runs`, neue Einstellung `notify_time`.

## Konfiguration (`.env`, beim Start geprüft)

| Variable | Zweck | Wenn nicht gesetzt |
|---|---|---|
| `STOWLY_TIMEZONE` | Zeitzone für „heute" und die Uhrzeiten | Europe/Berlin |
| `STOWLY_BACKUP_DIR`, `STOWLY_BACKUP_RECIPIENTS`, `STOWLY_BACKUP_TIME` | Ordner, öffentliche age-Schlüssel, Uhrzeit (03:30) | keine automatische Sicherung |
| `STOWLY_HA_URL`, `STOWLY_HA_TOKEN`, `STOWLY_HA_TODO_ENTITY`, `STOWLY_HA_CA` | Adresse von HA (IP statt `.local`, das im Container nicht auflöst), Token, To-do-Liste, eigene CA | kein Bring! |
| `STOWLY_HA_SUMMARY_TOKEN` | Token des Sensors | kein Sensor |
| `STOWLY_PUSH_CONTACT` | Absender für Push (`mailto:` oder `https:`; Apple verlangt ihn) | kein Push |

## Umsetzung mit den Agents

Wie in Stufe 1: ein Coordinator und drei Worker, alle Opus 5.5 mit maximalem Aufwand. Die Agents committen nicht; Commits setze ich an den Phasengrenzen im Stowly-Repository, das lokal bleibt. Der Plan kommt als `docs/plan-stufe-2.md` ins Repository.

| Agent | Besitzt |
|---|---|
| Coordinator | Verträge (`server/stowly/contract`, `web/src/contract`), Migrationen, Dokumente |
| Worker 1 – Server | übriges `server/`, Dockerfile, Compose, `.env.example`, `docs/betrieb.md` |
| Worker 2 – Oberfläche | `web/src/ui`, `web/src/features` außer Scannen, `web/src/app` |
| Worker 3 – Kern und PWA | `web/src/core`, `web/src/features/scan`, `web/src/sw.ts`, `web/src/mock`, `web/e2e` |

**Runde 0 – Coordinator: Verträge zuerst.**
- Protokoll 2: Feld, Datensatz und Befehle der Einkaufsliste, Regeln für Zusammenführen und Aufbewahren.
- Endpunkte: Statistik, Sensor, Push, Zustand von Sicherung, HA und Push.
- MHD-Regel in Python samt gemeinsamen Testfällen, ebenso für die automatischen Einträge.
- Migration 0003 und die Schnittstellen des Kerns (`web/src/contract/core.ts`).
- Ein neues Dokument `docs/integrationen.md` für HA/Bring!, Push und Sicherungen (Formate, Zeiten, Variablen), dazu Ergänzungen in `docs/sync-protokoll.md`.

**Runde 1 – die Risiken zuerst.**
- Server: Einkaufsliste mit automatischen Einträgen, `min_stock`, Zeitzone, Zeitplan, Sicherungen, Zustands-Endpunkt; Push mit Schlüssel, Abos, Versand und Testnachricht.
- Kern und PWA:
  - zuerst die Nachbildungen (Mock, Fake-Server)
  - dann die App-Datenbank v3 und die Befehle der Einkaufsliste
  - die Anmeldung für Push samt Neuanmeldung
  - im Service Worker `push` und `notificationclick`
  - in der Scan-Ansicht der FIFO-Hinweis und „Auf die Einkaufsliste"
  - das Nachladen der Scan-Ansicht
- Oberfläche:
  - die Einkaufsliste
  - der Mindestbestand im Produkt-Dialog und in der Bestandsliste
  - die Markierung der nächsten Charge
  - der Push-Knopf mit Hinweis fürs iPhone
  - der Zustand der Sicherung
- Danach mit dir:
  - eine Testnachricht auf dem iPhone (installiert) und auf Android
  - eine echte Sicherung entschlüsseln

  Das iPhone braucht dafür HTTPS: deinen Server, falls Stowly dort schon läuft, sonst wieder den Testaufbau.
- Noch während Runde 1, wenn du magst, eine kurze Probe gegen euer HA:
  - eine eigene Testliste in Bring!
  - zwei Aufrufe: einen Artikel anlegen, die Liste lesen

  Die Befehle bekommst du von mir; deinen Token gibst du dabei nicht heraus. Die Antworten werden zu Testdaten für den nachgebildeten HA.

**Runde 2.**
- Server: Abgleich mit HA/Bring!, Sensor-Endpunkt, tägliche Push-Nachricht, Statistik.
- Kern: Statistik, Zustände, `notify_time`.
- Oberfläche: die Ansicht „Statistik", der Zustand von HA, die Uhrzeit der Nachricht, Barrierefreiheit.
- Danach mit dir:
  - Bring! hin und zurück, auch mit gleichem Namen, Löschen und einem Neustart von HA
  - der Sensor in HA
  - eine echte Tagesnachricht

Nach jeder Runde verbindet der Coordinator die Teile und prüft sie gegen die Verträge, dann prüfe ich im Browser, dann committe ich. Am Ende bekommt die Prüfliste einen Abschnitt für Stufe 2.

## Verifikation

**Automatisiert:** pytest, Vitest und Ende-zu-Ende-Tests gegen den echten Server. Dazu kommen:
- dieselben Testfälle für MHD und automatische Einträge in Python und TypeScript
- der Zeitplan mit eingereichter Uhr, auch an den Tagen der Zeitumstellung (29.03.2026 und 25.10.2026) und nach einem Ausfall
- ein nachgebildetes HA aus den Antworten der Probe: gleicher Name, Löschen, `unavailable`, 401
- Push:
  - die Testvektoren aus RFC 8291
  - ein nachgebildeter Push-Dienst (201, 404, 410)
  - abgewiesene Adressen
  - im Browser der Service Worker mit einer Nachricht über die DevTools-Schnittstelle
- Sicherung:
  - mit einem Testschlüssel verschlüsseln, entschlüsseln, öffnen und die Datenbank prüfen
  - die Rotation
  - keine Klartextdatei im Ordner
- Tokens: Der Sensor-Token gilt nur für den Sensor; ein Geräte-Token wird dort abgewiesen.

**Im Browser (ich):**
- Mindestbestand setzen und unterschreiten
- automatische und eigene Einträge, offline und wieder online
- den FIFO-Hinweis über die Eingabe von Hand in der Scan-Ansicht
- die Statistik
- die Zustände in den Einstellungen
- das Hauptpaket unter 500 kB

**Nur bei dir prüfbar:** Push auf iPhone und Android, Bring! über euer HA, Sensor und Ansage in HA, eine Sicherung im Ordner und das Zurückspielen mit `age`. Dafür bekommt `docs/pruefliste.md` einen eigenen Abschnitt.

## Risiken

- **Push auf dem iPhone** ist mit der Adresse `stowly.home` und eurer eigenen CA nicht erprobt. Deshalb kommt die Testnachricht gleich nach Runde 1. Außerdem lehnt Apple Nachrichten mit ungültigem Absender ab (`STOWLY_PUSH_CONTACT`).
- **Bring!** hängt in HA an einer inoffiziellen Bibliothek und erkennt Artikel am Namen. Änderungen aus Bring! kommen erst nach einigen Minuten in Stowly an. Fällt die Integration aus, bleibt die Liste in Stowly vollständig.
- **Der private Schlüssel der Sicherungen:** Geht er verloren, sind die Sicherungen wertlos. Deshalb mehrere Schlüssel und vorab eine Probe-Entschlüsselung.
- **Eigene CA in beide Richtungen:** Stowly muss HA vertrauen, falls HA per https läuft, und HA muss Stowly vertrauen (für den Sensor). Die Schnipsel in der Doku decken beides ab.
- **Internet:** Für Push braucht der Server Zugang zu den Push-Diensten von Apple, Google und Mozilla; HA erreicht er im Heimnetz.
