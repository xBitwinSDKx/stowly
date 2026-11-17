# Integrationen

Verbindlicher Vertrag für alles, was der Server in Stufe 2 neben dem Sync tut: Zeitplan, Zeit, Sicherungen, Push, Home Assistant mit Bring!, der Sensor für Home Assistant, die Umgebungsvariablen und der Zustand, den die App davon zeigt. Er ergänzt [`sync-protokoll.md`](sync-protokoll.md); Datentypen und Endpunkte stehen dort (Abschnitt 11) und als Code in `server/stowly/contract/api.py`.

Was sich nur an einem echten Home Assistant klären lässt, ist mit **„klärt die Probe mit dem Anwender"** markiert und in Abschnitt 9 gesammelt. Bis dahin gilt die beschriebene, vorsichtige Auslegung.

## 1. Zeitplan

Eine Schleife im Server, nach dem Muster von `server/stowly/off.py`: eine asyncio-Aufgabe im `lifespan` der App, eine eingereichte Uhr für Tests (`now()`, `monotonic()`, `sleep()` wie `off.Clock`) und `wake()`. Keine neue Bibliothek.

### 1.1 Takt

- Die Schleife prüft **jede Minute** (zur vollen Minute der Serveruhr), dazu sofort nach dem Start und nach `wake()`.
- Aufgaben: `backup` (Abschnitt 3; sie steht immer im Zeitplan und ruht ohne Schlüssel) und `push_daily` (Abschnitt 4.8), in dieser Reihenfolge. Je Aufgabe läuft höchstens ein Lauf zugleich.
- Was blockiert (Kopie der Datenbank, Packen, Verschlüsseln, Schreiben), läuft in einem eigenen Thread (`asyncio.to_thread` oder `run_in_threadpool`), damit der Sync nicht wartet. Datenbankzugriffe öffnen eine eigene Verbindung (`db.connect`).
- Der Abgleich mit Home Assistant ist keine Aufgabe dieses Takts; er hat seine eigene Schleife (5.4).
- Ein Fehler in einer Aufgabe beendet die Schleife nie; er steht im Log und in `job_runs`.

### 1.2 Fällig

Je Aufgabe merkt sich die Tabelle `job_runs` den letzten Lauf:

| Spalte | Inhalt |
|---|---|
| `job` | `backup` oder `push_daily` |
| `last_date` | lokaler Tag (`STOWLY_TIMEZONE`) des letzten abgeschlossenen Laufs, `YYYY-MM-DD` |
| `last_at` | Zeitpunkt (UTC, Vertragsformat) dieses Laufs |
| `last_error`, `last_error_at` | Fehler des letzten Versuchs; `null` nach einem Erfolg |
| `state` | JSON je Aufgabe (3.6, 4.8) |

Eine Aufgabe ist **fällig**, wenn

1. es jetzt, in `STOWLY_TIMEZONE` gelesen, mindestens die eingestellte Uhrzeit ist (Vergleich der Uhrzeit des Tages: `jetzt.time() >= HH:MM`),
2. sie heute noch nicht lief (`last_date` ist `null` oder vor heute) und
3. ihre eigene Bedingung gilt: die Sicherung wartet nach einem Fehler eine Stunde (3.2), die Tagesnachricht läuft nur in ihrem Fenster (1.4).

Nach einem abgeschlossenen Lauf: `last_date` = heute, `last_at` = der Beginn des Laufs. „Heute" ist der Tag beim Start des Laufs. Was während des Laufs eintrifft, zählt so beim nächsten (4.8).

### 1.3 Sommer- und Winterzeit

Weil verglichen wird, ob die Uhrzeit des Tages *erreicht* ist, und je Tag gemerkt wird, ob die Aufgabe lief, gilt ohne Sonderfall (Beispiel `Europe/Berlin`, Uhrzeit 02:30):

- **29.03.2026:** Die Uhr springt um 02:00 (01:00 UTC) auf 03:00. 02:30 gibt es nicht. Der erste Takt nach dem Sprung (03:00 Ortszeit = 01:00 UTC) sieht „03:00 ≥ 02:30, heute noch nicht gelaufen" und startet die Aufgabe.
- **25.10.2026:** Die Uhr springt um 03:00 (01:00 UTC) auf 02:00 zurück. 02:30 kommt zweimal. Beim ersten Mal (00:30 UTC) läuft die Aufgabe; beim zweiten Mal (01:30 UTC) ist `last_date` schon heute, sie läuft nicht noch einmal.

Tests stellen die Uhr auf diese Zeitpunkte, ebenso auf einen Neustart nach einem Ausfall.

### 1.4 Nachholen

- **Sicherung:** immer. War der Server zur Uhrzeit aus, holt er sie beim Start nach (der erste Takt nach dem Start), auch abends.
- **Tagesnachricht:** nur in ihrem Fenster.
  - Liegt `notify_time` vor 21:00, reicht das Fenster von `notify_time` bis 21:00 (ausschließlich).
  - Liegt `notify_time` um oder nach 21:00, reicht es eine Stunde ab `notify_time`, höchstens bis Mitternacht.
  - Außerhalb des Fensters fällt die Nachricht für diesen Tag aus und wird nicht am nächsten Tag nachgeholt. Der nächste Lauf deckt dann alles ab, was seit dem letzten Lauf neu ist (4.8), also auch die ausgefallenen Tage.
- Ändert jemand `notify_time`, nachdem die Nachricht heute lief, kommt heute keine zweite.

## 2. Zeit

- **`STOWLY_TIMEZONE`**: Name einer IANA-Zeitzone, Vorgabe `Europe/Berlin`. Beim Start mit `zoneinfo.ZoneInfo` geladen; ein unbekannter Name ist ein Konfigurationsfehler (Exit-Code 2). Die Zeitzonendaten liefert das Paket `tzdata`, weil Windows und das schlanke Image keine eigenen mitbringen. Die Variable `TZ` des Containers spielt dafür keine Rolle.
- **„Heute" im Server** ist der Kalendertag in `STOWLY_TIMEZONE`. Er gilt für den Sensor (6), die Tagesnachricht (4.8), die Monate der Statistik (`sync-protokoll.md`, 11.1), die Dateinamen der Sicherungen (3.3) und `job_runs.last_date`.
- Zeitstempel bleiben UTC (`sync-protokoll.md`, Abschnitt 4). Uhrzeiten (`notify_time`, die Uhrzeit der Sicherung) sind Ortszeit in `STOWLY_TIMEZONE`, nie in der Zeitzone eines Geräts. Die App zeigt die Zeitzone des Servers dazu (`IntegrationStatus.timezone`), wenn sie von der des Geräts abweicht.

## 3. Sicherungen

Täglich und auf Knopfdruck eine verschlüsselte Kopie der Datenbank in einen Ordner auf dem Server; herunterladen lassen sich genau diese Dateien. Seit 0.4.0 kommen die Einstellungen aus der App oder der Umgebung (`serverconfig.backup_setup`), und die unverschlüsselte Sicherung zum Herunterladen (`GET /api/backup`) gibt es nicht mehr. Anleitung: [`betrieb.md`](betrieb.md), Abschnitt 8.

### 3.1 Einrichten

Je Einstellung geht die Umgebung vor der App vor der Vorgabe. Die App sieht die Quelle (`env`, `app`, `default`); was aus der Umgebung kommt, ist dort gesperrt (`PATCH /api/server-config` antwortet für das Feld mit 409, `sync-protokoll.md` 11.7).

| Einstellung | Umgebung | App (`server_config`) | sonst |
|---|---|---|---|
| öffentliche Schlüssel | `STOWLY_BACKUP_RECIPIENTS`, durch Komma oder Leerraum getrennt | `backup_recipients`: höchstens 10, je mit `added_at` | keine: Die Sicherung ruht |
| an oder aus | fest an, sobald die Schlüssel aus der Umgebung kommen | Schalter `backup_enabled` | an |
| Uhrzeit | `STOWLY_BACKUP_TIME` (`HH:MM`) | `backup_time` | `03:30` |
| Ordner | `STOWLY_BACKUP_DIR` (absolut) | – | `/backups` oder `/data/backups` (3.5) |

- **Schlüssel:** nur öffentliche age-Schlüssel (X25519, `age1…`), geprüft mit `pyrage`, in Normalform (klein) und ohne Doppelte; wer bleibt, behält sein `added_at`. Ein geheimer (`AGE-SECRET-KEY-…`) gibt in der App 422 mit `details.errors[].loc = ["body", "backup_recipients", i]`, in der Umgebung einen Konfigurationsfehler beim Start (Exit-Code 2); wiederholt wird er nie, weder in einer Antwort noch im Log. Öffentliche Schlüssel sind kein Geheimnis und dürfen in `server_config`.
- **Hinzufügen nur mit Passwort:** Kommt mit `backup_recipients` ein Schlüssel hinzu, braucht der Aufruf `current_password`, das Haushalts-Passwort (aus `STOWLY_PASSWORD`, wenn gesetzt, sonst der Hash). Ein Geräte-Token allein genügt nicht: Wer einen Schlüssel hinzufügt, kann jede künftige Sicherung öffnen, samt Passwort-Hash, VAPID-Schlüssel und Push-Abos. Fehlt das Passwort, 422 an `["body", "current_password"]` („Zum Hinzufügen eines Schlüssels braucht es das Haushalts-Passwort."); falsch: 401 `invalid_password` („Das Passwort stimmt nicht."), über die Bremse der Anmeldung, nach 5 Fehlversuchen in 5 Minuten 60 Sekunden lang 429. Entfernen braucht es nicht. Hat ein anderes Gerät inzwischen einen Schlüssel entfernt, den die Liste ohne Passwort zurückbrächte, antwortet der Server mit 409 („Die Schlüssel der Sicherung haben sich inzwischen auf einem anderen Gerät geändert. Bitte neu laden und noch einmal versuchen."). Das Passwort steht nie im Log.
- **Im Browser:** Das Schlüsselpaar entsteht in der App (`web/src/features/backup/keys.ts`, mit `@noble/curves` und `@scure/base`; nur `crypto.getRandomValues`, also auch über http). An den Server geht nur der öffentliche. Die Schlüsselpaare in `vectors.json` (`age_keys`) stammen von pyrage; Server und App prüfen sich an ihnen.
- **Ohne Neustart:** Die Aufgabe `backup` steht immer im Zeitplan und liest die Einstellungen bei jedem Takt; ohne Schlüssel oder ausgeschaltet ruht sie. Eine Änderung in der App weckt den Zeitplan.
- **Wann ein Grund dasteht** (`problem` in 3.6 und 8):

| Lage | `problem` |
|---|---|
| wirksam: an, mit Schlüssel, der Ordner taugt | `null` |
| Schlüssel, aber ausgeschaltet | „Die automatische Sicherung ist ausgeschaltet." |
| Schlüssel, an, der Ordner taugt nicht (3.5) | „Der Ordner für Sicherungen fehlt." bzw. „Der Ordner für Sicherungen ist nicht beschreibbar (Benutzer 10001)." |
| kein Schlüssel, aber etwas eingestellt (Ordner oder Uhrzeit aus der Umgebung, Schalter oder Uhrzeit aus der App) | „Es fehlt ein öffentlicher Schlüssel (in der App oder in STOWLY_BACKUP_RECIPIENTS)." |
| nichts eingestellt | `null` |

Beim Start steht dasselbe im Log („Keine automatische Sicherung: …"); eine wirksame Sicherung meldet sich mit „Automatische Sicherung täglich um 03:30 nach /backups an 2 Schlüssel."

### 3.2 Ablauf

Ein Lauf, aus dem Zeitplan oder auf Knopfdruck (3.8), unter einem gemeinsamen Lock: Läuft schon einer, wartet der tägliche Lauf bis zum nächsten Takt, und „Jetzt sichern" antwortet mit 409.

1. **Kopie:** ein in sich stimmiger Schnappschuss (`sqlite3.Connection.backup`) in eine Datenbank im Arbeitsspeicher (`:memory:`). Die Kopie bekommt eine neue `dataset_id` (`sync-protokoll.md`, 6.4), `PRAGMA integrity_check` muss `ok` liefern, dann `serialize()`. Unverschlüsselt berührt die Kopie nie die Platte. Sie ist eine einzelne Datei ohne WAL (`journal_mode` `delete`): Nach dem Entschlüsseln genügt diese eine Datei; der Server stellt beim Öffnen selbst wieder auf WAL.
2. **Packen:** gzip (`gzip.compress(…, mtime=0)`).
3. **Verschlüsseln:** age, an alle wirksamen öffentlichen Schlüssel zugleich (3.1), mit `pyrage` (`pyrage.encrypt` mit `pyrage.x25519.Recipient`), im binären Format von age (nicht ASCII-Armor). Jeder der geheimen Schlüssel kann die Datei allein entschlüsseln.
4. **Schreiben:** in eine Zwischendatei im Ordner, `.stowly-backup-<16 Hex-Zeichen>.tmp`, angelegt mit `O_CREAT | O_EXCL` und Rechten `0600`; schreiben, `flush`, `os.fsync`, schließen. In ihr steht von Anfang an nur Verschlüsseltes.
5. **Umbenennen:** `os.replace` auf den endgültigen Namen (3.3), danach unter Linux `fsync` des Ordners.
6. **Aufräumen:** Rotation (3.4).
7. **Merken:** `job_runs` (`backup`): `last_date`, `last_at`, `last_error = null`, `state = {"file", "size", "recipients"}` (Größe in Byte, Empfänger gekürzt wie in 3.6). Auch ein Lauf auf Knopfdruck zählt als Sicherung des Tages; der tägliche läuft dann an diesem Tag nicht mehr.

Scheitert ein Schritt, löscht der Server seine Zwischendatei, vermerkt den Fehler (`last_error` als kurzer deutscher Satz ohne Geheimnisse, `last_error_at`), schreibt ihn ins Log und versucht es **eine Stunde später** erneut, so lange, bis eine Sicherung des Tages gelingt. Liegengebliebene eigene Zwischendateien (Muster oben) löscht jeder Lauf vorab.

### 3.3 Dateiname

`stowly-YYYY-MM-DD-HHMM.sqlite3.gz.age`, Tag und Uhrzeit des Laufs in `STOWLY_TIMEZONE`, etwa `stowly-2026-11-14-0330.sqlite3.gz.age`. Eigene Dateien erkennt der Server ausschließlich an diesem Muster:

```
^stowly-([0-9]{4})-([0-9]{2})-([0-9]{2})-([0-9]{4})\.sqlite3\.gz\.age$
```

Gibt es den Namen schon (zwei Läufe in derselben Minute), ersetzt die neue Datei die alte.

### 3.4 Rotation 7/4/12

- Nur **nach einer gelungenen Sicherung**, und nur unter den **eigenen Dateien** (Muster aus 3.3) im wirksamen Ordner. Andere Dateien im Ordner fasst der Server nie an.
- Grundlage ist das Datum im Dateinamen, nicht das Änderungsdatum der Datei.
- Behalten wird, vereinigt:
  - die neueste Datei jedes der **7** neuesten Tage, an denen es eine Sicherung gibt,
  - die neueste Datei jeder der **4** neuesten ISO-Wochen (`date.isocalendar()`), in denen es eine gibt,
  - die neueste Datei jedes der **12** neuesten Monate, in denen es eine gibt.
- Alle übrigen eigenen Dateien werden gelöscht. Die eben geschriebene ist immer die neueste und bleibt.

So bleiben auch nach einem langen Ausfall die letzten Sicherungen erhalten: Gezählt werden Tage, Wochen und Monate *mit* Sicherung.

### 3.5 Ordner und Rechte

- **Wahl** (`serverconfig.backup_folder`, bei jedem Lauf und jeder Anfrage neu):
  1. `STOWLY_BACKUP_DIR`, wenn gesetzt (`folder_source: env`). Diesen Ordner legt der Server **nie** an (er läge sonst womöglich im Container statt auf dem eingebundenen Laufwerk), und er weicht nicht aus.
  2. `/backups`, wenn er in `/proc/self/mountinfo` als Einhängepunkt steht und für uid 10001 beschreibbar ist (`mounted`): bei Docker Compose `./backups`, in DSM ein zweiter Ordner. Das Image setzt dafür keine Variable; DSM übernähme sie sonst als Umgebung und sperrte den Ordner in der App.
  3. Sonst `<STOWLY_DATA_DIR>/backups`, im Container `/data/backups` (`data`). Den legt der Server vor dem ersten Lauf an (`0700`); bis dahin gilt er als brauchbar.
- **`/backups` eingebunden, aber unbrauchbar:** Die Sicherungen gehen in den Datenordner, und `BackupConfig.folder_hint` sagt es: „Der eigene Ordner /backups ist eingebunden, taugt aber nicht: … Die Sicherungen gehen deshalb in den Datenordner." Im Log steht das einmal je Prozess. Taugt der Ordner wieder, nimmt der Server ihn ohne Neustart.
- Der Container läuft als Benutzer mit uid 10001 (Dockerfile). Ein Ordner muss ihm gehören oder für ihn beschreibbar sein: `sudo chown 10001:10001 ./backups`; ein Ordner, den DSM unter `docker` anlegt, ist es von selbst. Die Dateien bekommen `0600`.
- **Taugt der wirksame Ordner nicht** (fehlt, nicht beschreibbar), wirkt die Sicherung nicht: `problem` (3.1) und `BackupConfig.folder_problem` nennen den Grund. Ist sie an und hat einen Schlüssel, versucht der Zeitplan es trotzdem, nach einem Fehler stündlich; der Fehler steht dann auch als `last_error`.
- Ein Ordner auf derselben Platte ersetzt keine Kopie außer Haus, `/data/backups` erst recht nicht; `docs/betrieb.md` (8.1) sagt das.

### 3.6 Zustand für die App

`IntegrationStatus.backup` (Abschnitt 8):

- `configured`: Die Sicherung wirkt, also an, mit mindestens einem Schlüssel, und der Ordner taugt. `problem`: nach 3.1.
- `folder`: der wirksame Ordner im Container (3.5). `files`: die eigenen Sicherungen darin (Muster aus 3.3), neueste zuerst, höchstens `LIMITS.backup_files_listed` (50), je `name`, `size` und `created_at` (aus dem Dateinamen, Uhrzeit in `STOWLY_TIMEZONE`). Andere Dateien, Ordner und Verweise zählen nicht; fehlt der Ordner, ist die Liste leer.
- `time`: die wirksame Uhrzeit (Umgebung, App oder Vorgabe), auch wenn die Sicherung aus ist; `null` nur ohne Schlüssel und ohne jede Einstellung.
- `recipients`: die öffentlichen Schlüssel gekürzt auf die ersten 8 Zeichen, „…" und die letzten 4, etwa `age1ql3z…ac8p`.
- `last_ok_at`, `last_file`, `last_size`: aus `job_runs.state` der letzten gelungenen Sicherung.
- `last_error`, `last_error_at`: der letzte Fehlschlag, `null` nach einem Erfolg.
- `next_at`: der nächste geplante Versuch in UTC: heute zur Uhrzeit, wenn sie noch kommt und heute noch nichts lief; nach einem Fehler `last_error_at` plus eine Stunde; sonst morgen zur Uhrzeit (über die Zeitumstellung richtig umgerechnet). Maßgeblich ist die Regel „fällig" (1.2): Ist ein Versuch schon jetzt fällig (etwa nach einem Ausfall), ist `next_at` jetzt; ein Fehler kurz vor Mitternacht ergibt die Uhrzeit des nächsten Tages, nicht „eine Stunde später". Liegt `last_error_at` in der Zukunft (Uhr zurückgestellt), wartet die Sicherung nicht darauf. `null`, solange die Sicherung aus ist oder keinen Schlüssel hat; ein Ordner, der nicht taugt, hält den Versuch nicht auf.
- **`warning`** (die App warnt): an und mit Schlüssel, und entweder liegt die letzte gelungene Sicherung mehr als **48 Stunden** zurück, oder es gab noch keine und der letzte Versuch ist gescheitert.

Die Einstellungen selbst liefert `GET /api/server-config` als `BackupConfig` (`sync-protokoll.md` 11.7): je Feld der wirksame Wert und seine Quelle, die Schlüssel vollständig und gekürzt, dazu `folder_source` (`env`, `mounted`, `data`), `folder_problem` und `folder_hint`.

### 3.7 Zurückspielen

In der App (`sync-protokoll.md`, 11.9; Anleitung `betrieb.md`, 8.3): hochladen, mit dem geheimen Schlüssel prüfen, einspielen. Stowly startet neu und tauscht die Datenbank, bevor etwas sie öffnet. Ein laufender Stowly behält dabei Geräte, Passwort-Hash, VAPID-Schlüssel (4.1) samt Abos, `server_config` und `job_runs`; beim ersten Start kommt alles aus der Sicherung, auch der VAPID-Schlüssel.

Auf der Kommandozeile, als Notweg (`betrieb.md`, 8.4):

1. Vorab, einmal nach dem Einrichten und dann ab und zu: **Probe-Entschlüsselung** mit jedem geheimen Schlüssel: `age -d -i schluessel.txt stowly-….sqlite3.gz.age | gunzip | head -c 15` muss `SQLite format 3` zeigen. Die Schlüsseldatei aus der App hat das Format von `age-keygen`.
2. Zurückspielen: `age -d -i schluessel.txt stowly-2026-11-14-0330.sqlite3.gz.age | gunzip > stowly.sqlite3`, dann Container anhalten, Datei ersetzen, `-wal` und `-shm` entfernen, `python -m stowly --new-dataset`, starten.
3. Die Kopie trägt eine neue `dataset_id`: Alle Geräte holen den Bestand vollständig neu und senden ihre Outbox erneut. Der VAPID-Schlüssel (4.1) kommt mit; Push-Abos, die nach der Sicherung entstanden sind, fehlen, und die App meldet sich beim nächsten Start neu an.

### 3.8 Jetzt sichern und Herunterladen

- **`POST /api/backup/run`** (Geräte-Token): ein Lauf wie der tägliche (3.2), unter demselben Lock, auch wenn der Schalter aus ist. Antwort 200 `BackupFile { name, size, created_at }`, `Cache-Control: no-store`.
  - 409 `conflict` „Gerade läuft schon eine Sicherung.", wenn schon einer läuft; dieser Versuch zählt nicht für die Bremse.
  - 429 `rate_limited` mit `Retry-After` bei mehr als einem Knopfdruck je Minute, für den ganzen Server.
  - 503 `not_configured` ohne öffentlichen Schlüssel oder ohne brauchbaren Ordner, mit dem Satz aus 3.1.
  - 500 `internal`, wenn die Sicherung selbst scheitert (etwa „Auf der Platte ist kein Platz für die Sicherung."), vermerkt wie in 3.2.
- **`GET /api/backup/files/{name}`** (Geräte-Token): eine Datei aus dem wirksamen Ordner als `application/octet-stream` mit `Content-Disposition: attachment`, `Cache-Control: no-store`. Nur Namen nach dem Muster aus 3.3 und nur gewöhnliche Dateien, kein Verweis; alles andere 404 „Diese Sicherung gibt es nicht."

## 4. Push

Benachrichtigungen per Web-Push direkt aus Stowly, ohne fremde Bibliothek: Verschlüsselung und Signatur sind auf `cryptography` selbst geschrieben und gegen die Testvektoren der RFC geprüft.

### 4.1 Einrichten

- **`STOWLY_PUSH_CONTACT`**: Absender für VAPID (`sub`), `mailto:` mit einer Adresse oder eine `https:`-Adresse. Apple lehnt Nachrichten ohne gültigen Absender ab. Ungültige Form: Konfigurationsfehler beim Start. Nicht gesetzt: kein Push; alle Aufrufe unter `/api/push` antworten mit 503 `not_configured`, die Tagesnachricht läuft nicht.
- **VAPID-Schlüssel:** ein Schlüsselpaar auf P-256, in der Tabelle `meta`: `vapid_private_key` (der private Wert d, 32 Byte, base64url ohne Füllzeichen) und `vapid_public_key` (der öffentliche Punkt unkomprimiert, 65 Byte, base64url). Fehlt es, legt der Server es beim Start an, auch ohne `STOWLY_PUSH_CONTACT`. Es kommt mit jeder Sicherung und wird nie neu erzeugt, solange es da ist. Der private Wert steht nie im Log und nie in einer Antwort.
- **Die App** vergleicht beim Start den öffentlichen Schlüssel (`GET /api/push/key`) mit dem `applicationServerKey` ihres Abos. Weicht er ab (zurückgespielte Sicherung, neue Datenbank), meldet sie sich neu an: Abo im Browser beenden, neu anlegen, beim Server ersetzen. Sonst meldet sie ein vorhandenes Abo beim Start und nach der Anmeldung trotzdem noch einmal an (`PUT` ist wiederholbar): So kennt der Server es auch wieder, wenn er es vergessen hatte. Ohne Server holt sie das nach dem nächsten Kontakt nach.
- **Sperrt ein anderes Gerät dieses hier,** löscht der Server das Abo (4.10); der Browser behält seines. Meldet sich das Gerät wieder an, meldet die App das vorhandene Abo neu an: Push ist dann wieder an. Nur das Abmelden auf dem Gerät selbst und „Ausschalten" beenden das Abo auch im Browser.

### 4.2 Erlaubte Push-Dienste

Der Server schickt nur an Adressen bekannter Push-Dienste; sonst könnte ein Gerät ihn Anfragen ins Heimnetz schicken lassen. Ein `endpoint` gilt, wenn er

- eine absolute `https://`-Adresse ist, ohne Benutzerangabe, ohne Port oder mit Port 443, höchstens 1024 Zeichen, und
- sein Host (klein geschrieben) gleich einer dieser Domänen ist oder darunter liegt:

| Domäne | Dienst |
|---|---|
| `fcm.googleapis.com` | Google (Chrome und andere Chromium-Browser, auch auf Android) |
| `push.apple.com` | Apple (Safari, iPhone und iPad, etwa `web.push.apple.com`) |
| `push.services.mozilla.com` | Mozilla (Firefox, etwa `updates.push.services.mozilla.com`) |
| `notify.windows.com` | Microsoft (Edge unter Windows) |

Sonst: 422 `invalid_request`, `details.errors[0].loc = ["body", "endpoint"]`. Weiterleitungen folgt der Server beim Versand nicht.

Weiter geprüft beim Anlegen:

- `keys.p256dh`: base64url (Füllzeichen erlaubt) eines unkomprimierten Punkts auf P-256, 65 Byte, beginnend mit `0x04`, gültig auf der Kurve. `keys.auth`: base64url von genau 16 Byte. Sonst 422 mit `loc` `["body", "keys", "p256dh"]` bzw. `["body", "keys", "auth"]`.
- `origin`: genau ein Ursprung, `https://host` oder `https://host:port`, für die Entwicklung auch `http://localhost`, `http://127.0.0.1` oder `http://[::1]` (mit Port); ohne Pfad (auch ohne `/` am Ende, die App schickt `location.origin`), Abfrage, Fragment und Benutzerangabe, höchstens 200 Zeichen. Sonst 422 mit `loc` `["body", "origin"]`.

### 4.3 Verschlüsselung (RFC 8291, `aes128gcm`)

Je Nachricht und Abo, mit `cryptography`:

1. Neues Schlüsselpaar des Servers auf P-256 (`as_private`, `as_public`, unkomprimiert 65 Byte); `ecdh_secret` = ECDH(`as_private`, `ua_public`), wobei `ua_public` = `keys.p256dh`.
2. `PRK_key` = HMAC-SHA-256(Schlüssel `auth_secret`, `ecdh_secret`); `key_info` = `"WebPush: info" ‖ 0x00 ‖ ua_public ‖ as_public`; `IKM` = HMAC-SHA-256(`PRK_key`, `key_info ‖ 0x01`).
3. `salt` = 16 Zufallsbytes; `PRK` = HMAC-SHA-256(`salt`, `IKM`); `CEK` = die ersten 16 Byte von HMAC-SHA-256(`PRK`, `"Content-Encoding: aes128gcm" ‖ 0x00 ‖ 0x01`); `NONCE` = die ersten 12 Byte von HMAC-SHA-256(`PRK`, `"Content-Encoding: nonce" ‖ 0x00 ‖ 0x01`).
4. Ein einziger Datensatz: `Klartext ‖ 0x02` (Trenner des letzten Datensatzes, ohne Auffüllen), verschlüsselt mit AES-128-GCM (`CEK`, `NONCE`); das Ergebnis enthält das 16-Byte-Tag.
5. Rumpf = `salt` (16) ‖ `rs` (4 Byte, big-endian, 4096) ‖ `idlen` (1 Byte, 65) ‖ `as_public` (65) ‖ Chiffrat.

Der Klartext (das JSON aus 4.5, UTF-8) darf höchstens 3993 Byte haben (4096 minus Kopf, Tag und Trenner); die Nachrichten von Stowly bleiben weit darunter. Salz und Schlüsselpaar lassen sich für Tests vorgeben: Der Test rechnet das Beispiel aus RFC 8291, Anhang A, Byte für Byte nach.

### 4.4 Absender (RFC 8292, VAPID)

- Kopfzeile `Authorization: vapid t=<JWT>, k=<vapid_public_key>`.
- JWT: Kopf `{"typ":"JWT","alg":"ES256"}`, Inhalt `{"aud": "<Schema>://<Host>" des Endpunkts, "exp": <jetzt + 12 Stunden, Unix-Sekunden>, "sub": STOWLY_PUSH_CONTACT}`, beides base64url ohne Füllzeichen. `exp` liegt höchstens 24 Stunden in der Zukunft.
- Signatur ES256 über `Kopf.Inhalt` mit `vapid_private_key`, als rohes `r ‖ s` (je 32 Byte, nicht DER), base64url.
- Ein JWT darf je `aud` wiederverwendet werden, bis es noch eine Stunde gilt.

### 4.5 Nachricht

Die Nutzlast ist JSON im Format „Declarative Web Push" (WebKit, Push API der W3C):

```json
{
  "web_push": 8030,
  "notification": {
    "title": "MHD-Hinweis",
    "body": "Neu bald fällig: Joghurt (16.11.). Insgesamt 3 bald, 1 abgelaufen.",
    "navigate": "https://stowly.example/warnungen",
    "lang": "de-DE",
    "dir": "ltr",
    "tag": "stowly-daily",
    "silent": false
  }
}
```

- **Titel:** Er sagt, worum es geht („MHD-Hinweis", „Testnachricht"), nie „Stowly". iOS setzt unter den Titel einer Web-App selbst eine Zeile „from" mit dem Namen der App, nicht abschaltbar und nicht übersetzt; Android nennt die App ohnehin. Ein Titel „Stowly" stünde dort doppelt (am iPhone gesehen: „Stowly from Stowly").
- `navigate` ist absolut: der `origin` des Abos plus der Pfad aus `PUSH_PATHS` (`server/stowly/contract/api.py`, in der App `PUSH_PATHS` aus `api.gen.ts`): `/warnungen` für die Tagesnachricht, `/einstellungen` für die Testnachricht.
- Kein `mutable` und kein `app_badge`.
- **Warum Declarative Web Push:** Safari ab iOS 18.4 zeigt solche Nachrichten selbst an, auch wenn der Service Worker einmal fehlt oder scheitert. Andere Browser geben dieselben Bytes als `push` an den Service Worker, der sie anzeigt.

**Der Service Worker** (`web/src/sw.ts`, `web/src/core/push/worker.ts`):

- `push`: JSON lesen; nur bei `web_push === 8030` und einem `notification.title` zeigt er `registration.showNotification(title, { body, lang, dir, tag, silent, data: { navigate } })`, sonst nichts.
- `notificationclick`: Nachricht schließen. Das Ziel steht in `notification.navigate` (wo der Browser die Mitteilung selbst angezeigt hat), sonst in `data.navigate`, sonst gilt es nach der Kennung (`stowly-daily` → `/warnungen`, `stowly-test` → `/einstellungen`).
  - Einem offenen Fenster der App schickt der Service Worker die Nachricht `{ type: "stowly:navigate", url }` (`NAVIGATE_MESSAGE` in `web/src/contract/routes.ts`) und holt es nach vorn; die App wechselt die Ansicht ohne Neuladen (`web/src/app/notificationNavigation.ts`).
  - `WindowClient.navigate` nimmt er bewusst nicht: Safari kennt es nicht, und es lädt neu.
  - Ohne Fenster, oder wenn das Fenster keine Nachricht annimmt, öffnet `clients.openWindow` das Ziel.
  - Ziele außerhalb des eigenen Ursprungs und ungültige öffnet er nicht: Der Tipp führt dann zum Anfang der App.

**Grenze unter iOS 27** (Test am iPhone, 14.11.2026, über eine eigene CA):

- Die Nachrichten kommen an, im Vordergrund wie im Hintergrund.
- Ein Tipp öffnet Stowly aber am Anfang (`/`), nicht in der Zielansicht.
- Was dabei zu sehen war:
  - Der Service Worker bekam für Push-Mitteilungen nie `notificationclick`, nur für Mitteilungen, die er bei offener App selbst gezeigt hatte.
  - Was er beim Empfang einer Push-Nachricht ablegte (Cache Storage) oder abrief, kam weder in der App noch beim Server an.
  - `WindowClient.navigate` gibt es nicht.
  - Mit `"web_push": 8030` zeigt iOS die Nachricht selbst an und führt beim Tipp trotzdem nicht zu `navigate`.
- Das passt zu offenen Fehlerberichten bei WebKit (etwa 263687, 259212). Ein Umweg (Ziel beim Empfang merken, beim Zurückkehren einlösen) scheiterte an der Ablage und ist wieder entfernt.
- Erneut prüfen auf dem echten Server und mit späteren iOS-Fassungen (`docs/pruefliste.md`).

### 4.6 Kopfzeilen

| Kopfzeile | Tagesnachricht | Testnachricht | Neue Version (10.2) |
|---|---|---|---|
| `TTL` | `86400` (ein Tag) | `300` | `86400` |
| `Topic` | `stowly-daily` | `stowly-test` | `stowly-update` |
| `Urgency` | `normal` | `high` | `normal` |
| `Content-Encoding` | `aes128gcm` | `aes128gcm` | `aes128gcm` |
| `Content-Type` | `application/octet-stream` | `application/octet-stream` | ebenso |
| `Authorization` | `vapid t=…, k=…` (4.4) | ebenso | ebenso |

`Topic` (höchstens 32 Zeichen aus dem base64url-Alphabet) lässt den Push-Dienst eine noch nicht zugestellte ältere Nachricht desselben Themas ersetzen: Nach einem Funkloch kommt nur die neueste. Zeitgrenze je Anfrage 10 Sekunden.

### 4.7 Antworten des Push-Dienstes

| Antwort | Der Server | Ergebnis der Testnachricht |
|---|---|---|
| 201 (jedes 2xx) | angenommen: `last_ok_at`, `last_error = null` | `sent` |
| 404, 410 | das Abo ist erloschen: Er löscht es. | `gone` |
| 413 | Nachricht zu groß: ein Fehler im Server; Log, Abo bleibt | `rejected` |
| 429 | überlastet: vermerken, Abo bleibt, kein sofortiger neuer Versuch | `failed` |
| 400, 401, 403 und andere 4xx | abgelehnt (Absender, VAPID, Schlüssel): vermerken, Warnung im Log, Abo bleibt | `rejected` |
| 5xx, Netzfehler, Zeitüberschreitung | vorübergehend: vermerken, Abo bleibt | `failed` |
| 3xx | unerwartet (Weiterleitungen folgt der Server nicht, 4.2): vermerken, Abo bleibt | `failed` |

Vermerkt wird am Abo (`last_error` als kurzer Text mit dem Status, `last_error_at`). Eine Nachricht wird nicht wiederholt; die nächste Tagesnachricht kommt ohnehin.

### 4.8 Die Tagesnachricht „nur Neues"

Die Aufgabe `push_daily` des Zeitplans (1), fällig ab `notify_time` in ihrem Fenster (1.4), nur mit `STOWLY_PUSH_CONTACT`. Sie läuft auch ohne Abo (dann ohne Nachricht): Der Lauf rückt das Fenster vor.

**Das Fenster:** `P` ist der vorige Lauf (`job_runs.push_daily`: Tag `P.date`, Zeitpunkt `P.at`); gab es keinen, gilt gestern zur selben Stunde (`P.date` = gestern, `P.at` = jetzt minus 24 Stunden). `R` ist dieser Lauf (`R.date` = heute, `R.at` = jetzt).

**Was neu ist**, je Packung im Bestand (`removed_at = null`) mit MHD, Vorlaufzeit `w = warn_days_for(Produkt, Einstellungen)` und Stufe `expiry_state(MHD, w, R.date)` (`server/stowly/contract/mhd.py`):

- **neu bald fällig:** Stufe `soon`, die Packung stand noch nie als „bald" in einer Nachricht, und entweder liegt ihr Eintritt in „bald" (`soon_from(MHD, w)` = MHD minus Vorlaufzeit) im Fenster (`P.date < Eintritt ≤ R.date`), oder sie ist seit `P.at` neu im Bestand.
- **neu abgelaufen:** Stufe `expired`, die Packung stand noch nie als „abgelaufen" in einer Nachricht, und entweder liegt ihr Eintritt in „abgelaufen" (`expired_from(MHD)` = MHD plus ein Tag) im Fenster, oder sie ist seit `P.at` neu im Bestand.
- **Neu im Bestand seit `P.at`:** Der Server hat für sie `package.created` oder `package.restored` mit `recorded_at` nach `P.at` verbucht (Ereignisprotokoll). Es zählt, wann der Server davon erfuhr, nicht der wirksame Zeitpunkt: Eine Packung, die ein Gerät vor Tagen offline eingelagert hat und erst heute abgleicht, ist für den Haushalt neu.
- Ist eine Packung in einem Lauf zugleich neu bald fällig und neu abgelaufen (etwa nach einem Ausfall), zählt sie als abgelaufen und gilt danach für beide Stufen als gemeldet.

**Je Packung höchstens zwei Nachrichten:** Die Tabelle `push_notices` merkt sich je Packung und Stufe (`soon`, `expired`), wann sie in einer Nachricht stand. Was dort steht, ist nie wieder neu, auch nicht nach einem geänderten MHD oder einem Wiederherstellen. Eingetragen wird, sobald die Nachricht an mindestens ein Abo hinausging, gleich was der Push-Dienst antwortet. **Hinausgegangen** heißt: Ein Push-Dienst hat mit einem HTTP-Status geantwortet, gleich welchem (auch 404, 410 oder 5xx). Kam von keinem eine Antwort (Netzfehler, Zeitüberschreitung), gilt nichts als gemeldet, und `sent_at` fehlt.

**Ist nichts neu, geht keine Nachricht hinaus.** Der Lauf zählt trotzdem.

**Der Text:** Titel „MHD-Hinweis", Rumpf aus diesen Teilen, mit Leerzeichen verbunden:

1. Gibt es neu Abgelaufenes: `Neu abgelaufen: <Liste>.`
2. Gibt es neu bald Fälliges: `Neu bald fällig: <Liste>.`
3. Immer: `Insgesamt <s> bald, <e> abgelaufen.` mit den Zahlen aller Packungen im Bestand in Stufe `soon` bzw. `expired`.

Die `<Liste>` fasst je Produkt und MHD zusammen: `Joghurt (16.11.)`, bei mehreren Packungen `2× Joghurt (16.11.)`; sortiert nach MHD, dann nach dem Anzeigenamen (verglichen nach `str.casefold()` in der Reihenfolge der Unicode-Zeichen), dann nach der Kennung des Produkts. Bis zu drei Einträge stehen alle da („A", „A und B", „A, B und C"); ab vier die ersten zwei und `und <n> weitere` („Joghurt (16.11.), Milch (18.11.) und 2 weitere"), also nie „und 1 weitere". Der Name ist der Anzeigename des Produkts (Name, sonst erster Barcode, sonst „Unbekanntes Produkt"), gekürzt auf 40 Zeichen mit „…". Das Datum ist `TT.MM.`.

Beispiel: `Neu bald fällig: Joghurt (16.11.). Insgesamt 3 bald, 1 abgelaufen.`

`tag` `stowly-daily`, `navigate` `<origin>/warnungen`, Kopfzeilen nach 4.6. Danach `job_runs.state` = `{"sent_at": …, "packages": <Anzahl neu>, "subscriptions": <Abos beim Lauf>, "errors": <Zustellungen ohne 2xx>}` (`sent_at` nur, wenn etwas hinausging) und `last_error` = `null` oder ein Satz, wenn kein einziges Abo erreicht wurde. Erreicht heißt: Der Push-Dienst hat mit 2xx angenommen.

### 4.9 Testnachricht

`POST /api/push/test` (`sync-protokoll.md`, 11.3): Titel „Testnachricht", Rumpf „Benachrichtigungen kommen auf diesem Gerät an.", `tag` `stowly-test`, `navigate` `<origin>/einstellungen`, Kopfzeilen nach 4.6. Die Antwort (`PushTestResult`) nennt das Ergebnis nach 4.7, den Status des Push-Dienstes und einen deutschen Satz, etwa „Der Push-Dienst hat die Nachricht angenommen." oder „Der Push-Dienst lehnt ab (403). Stimmt der Kontakt für die Push-Dienste?". Ohne wirksamen Kontakt geht keine Testnachricht hinaus, und sie zählt nicht für die Bremse.

### 4.10 Ende eines Abos

- Wird ein Gerät gesperrt oder meldet es sich ab (`DELETE /api/devices/{id}`, `POST /api/auth/logout`), löscht der Server sein Abo in derselben Transaktion.
- Die App beendet beim Abmelden und beim Ausschalten das Abo auch im Browser (`PushSubscription.unsubscribe`).
- 404 und 410 eines Push-Dienstes löschen das Abo (4.7).

## 5. Home Assistant und Bring!

Die Einkaufsliste von Stowly erscheint über eine To-do-Liste von Home Assistant (HA) in Bring!. Stowly speichert dafür nur einen Token von HA, nie Zugangsdaten für Bring!. Ohne HA funktioniert die Einkaufsliste genauso, nur ohne Bring!.

### 5.1 Einrichten

Adresse, Token und To-do-Liste gehören zusammen (`haconfig.effective`), seit 0.4.0 aus der Umgebung oder aus der App:

- **Umgebung:** Ist eine von `STOWLY_HA_URL`, `STOWLY_HA_TOKEN` oder `STOWLY_HA_TODO_ENTITY` gesetzt, kommen alle drei aus der Umgebung (`source: env`) und sind in der App gesperrt (409). Fehlt dort etwas, nennt `problem` die Variablen, etwa „STOWLY_HA_TOKEN fehlt."
- **App:** Sonst kommen alle drei aus der App (`PATCH /api/server-config/ha`, `sync-protokoll.md` 11.10; Anleitung `betrieb.md` 17.2). Adresse und Liste stehen in `server_config` (`ha_url`, `ha_todo_entity`), der Token im eigenen Speicher (unten). Fehlt etwas, nennt `problem` es, etwa „Für Home Assistant fehlt noch die To-do-Liste."
- **Nichts gesetzt:** aus, ohne Hinweis (`source: default`).
- **`STOWLY_HA_CA`** gibt es nur in der Umgebung. Die CA gilt für beide Wege, im Abgleich und bei der Prüfung (5.7). Allein gesetzt ist sie keine halbe Einrichtung.
- **Gelesen** wird die Einrichtung bei Gebrauch: vor jedem Lauf des Abgleichs (5.4), bei jeder Prüfung, im Zustand (8), im Assistenten und beim Start fürs Log („Einkaufsliste nach Bring! über Home Assistant, Liste todo.zuhause (aus der App)."). Eine Änderung wirkt so ohne Neustart.

| Variable | Bedeutung |
|---|---|
| `STOWLY_HA_URL` | Adresse von HA, etwa `https://192.168.1.20:8123` oder `http://192.168.1.20:8123`; ohne Pfad (ein `/` am Ende fällt weg). Namen auf `.local` lösen im Container nicht auf: IP-Adresse oder einen Namen aus dem eigenen DNS nehmen. |
| `STOWLY_HA_TOKEN` | langlebiger Zugangs-Token aus HA (Profil, „Sicherheit"), am besten von einem eigenen HA-Benutzer nur für Stowly |
| `STOWLY_HA_TODO_ENTITY` | die To-do-Liste, die mit Bring! verbunden ist, etwa `todo.zuhause` |
| `STOWLY_HA_CA` | freiwillig: Pfad zu einer PEM-Datei mit der eigenen Zertifizierungsstelle, wenn HA per https mit eigenem Zertifikat läuft |

- **Geprüft:** aus der Umgebung beim Start, aus der App beim Speichern, nach denselben Regeln (`config.normalize_ha_url`): URL absolut mit `http` oder `https`, ohne Pfad, Abfrage und Benutzerangabe; Liste nach dem Muster `^todo\.[a-z0-9_]+$`. In der Umgebung dazu die CA-Datei (lesbar, als PEM ladbar); ein Fehler dort ist ein Konfigurationsfehler.
- **Gegen fremde Ziele** gilt für eine Adresse aus der App außerdem (`haconfig.target_problem`): IP-Adressen nur in der üblichen Schreibweise (nicht `2852039166`, `0xa9.0xfe.0xa9.0xfe` oder mit führenden Nullen), keine wörtliche Link-local-, Multicast- oder unbestimmte Adresse, auch nicht in IPv6 verpackt (`::ffff:…`, 6to4, NAT64). Das Heimnetz und Loopback sind erlaubt. Sonst 422 an `["body", "url"]`.
- **Bekannte Grenze:** Rechnernamen löst Stowly für diese Regeln nicht auf. Ein Name, der auf eine verbotene Adresse zeigt, kommt also durch. Dagegen: Einrichten und Prüfen dürfen nur angemeldete Geräte, keine Anfrage folgt einer Weiterleitung, und der gespeicherte Token geht nur an seine eigene Adresse (unten).
- **Der Token aus der App** steht in `/data/secrets/ha_token.json` (`{token, url, set_at}`; Ordner `0700`, Datei `0600`, atomar geschrieben wie `/data/tls`, `stowly/secretstore.py`). Er steht nie in der Datenbank, einer Sicherung, dem Log, dem Ereignisprotokoll oder einer Antwort. In `server_config` steht nur der Merker `ha_token_set_at`.
  - **An seine Adresse gebunden:** Er gilt nur für die Adresse, für die er eingetragen wurde; ein anders gebundener zählt als fehlend. Eine neue Adresse ohne Token im selben Aufruf löscht ihn. So lässt er sich nicht an einen anderen Rechner umleiten.
  - **Nach Zurückspielen oder Umzug** fehlt die Datei (sie steht in keiner Sicherung), der Merker aber nicht: `problem` „Der Token für Home Assistant fehlt (steht in keiner Sicherung); bitte neu eintragen."
  - Eine fehlende, zu große (über 64 KiB) oder kaputte Datei gilt als nicht da; die Warnung im Log nennt den Inhalt nie. Lässt sich `/data/secrets` beim Start nicht anlegen, startet der Server trotzdem, und `problem` sagt es.
- **Der Token aus der Umgebung** steht nur in der `.env` bzw. den Einstellungen des Containers, mit denselben Regeln für Log, Ereignisprotokoll und Antworten. Fehlermeldungen nennen Status und Pfad, nie Kopfzeilen.

### 5.2 Abbildung

- **Gespiegelt** wird ein offener Eintrag, der **seit mindestens zwei Minuten offen** ist (`HA_MIRROR_DELAY_S` = 120 in `server/stowly/contract/api.py` und `api.gen.ts`; die App nimmt ihren Text daraus) und **einen Namen** hat. „Offen seit" ist der Zeitpunkt der letzten Öffnung (Uhr von `done`, sonst `created_at`, `sync-protokoll.md` 7.6), verglichen mit der Serveruhr. Die zwei Minuten lassen Zeit für Rückgängig und Tippfehler.
- **Name:** bei einem Produkt dessen Name (getrimmt); ein Platzhalter ohne Namen wird erst gespiegelt, wenn er einen hat. Bei freiem Text der Text.
- **Vergleichsform** eines Namens (`name_key`): getrimmt, Leerraum innen zu einem Leerzeichen, `str.casefold()`. Zwei Namen sind gleich, wenn ihre Vergleichsformen gleich sind (ob Bring! Groß- und Kleinschreibung unterscheidet, klärt die Probe mit dem Anwender).
- **Beschreibung** (in Bring! die „Spezifikation"): der Text der Menge aus `shoppingQuantityLabel` (`web/src/contract/shopping.ts`), dann ` · Stowly`: `fehlt 2 · Stowly` (automatisch), `3× · Stowly` (eigener mit Menge), sonst nur `Stowly`.
- **Ein Artikel je Name:** Haben mehrere offene Einträge denselben Namen, teilen sie sich einen Artikel in Bring!; seine Beschreibung kommt vom ältesten von ihnen.
- **Gebunden:** Geht ein Eintrag zum ersten Mal nach Bring!, merkt sich der Server den Artikel (`shopping_items.bring_key` = `ha_links.name_key`). Umbenennungen danach (Produkt oder Text) gehen nicht nach Bring!; der Eintrag bleibt an seinem Artikel.

### 5.3 `ha_links`: was Stowly zuletzt geschrieben hat

Eine Zeile je Artikel, den Stowly kennt:

| Spalte | Inhalt |
|---|---|
| `name_key` | Vergleichsform des Namens (Schlüssel) |
| `name` | der Name, wie er in der Liste steht |
| `uid` | Kennung des Artikels in HA aus `todo.get_items`; `null`, solange nicht gesehen. Ersetzt ein neuer eigener Artikel die Zeile eines alten, erledigten desselben Namens (5.4, Schritt 4), bleibt die `uid` des alten stehen, bis der neue gesehen ist. |
| `own` | 1 = Stowly hat ihn angelegt; 0 = er stand schon in der Liste (fremd): Stowly liest ihn nur. Holt jemand einen eigenen Artikel, den Stowly abgehakt oder entfernt hatte, zurück auf die Liste, wird er fremd. |
| `description` | zuletzt geschriebene Beschreibung (nur eigene) |
| `status` | was Stowly zuletzt geschrieben (eigene) oder gesehen (fremde) hat: `needs_action`, `completed`, `removed` |
| `written_at`, `seen_at` | zuletzt geschrieben, zuletzt in der Liste gesehen |
| `misses` | Abgleiche in Folge, in denen er fehlte, während HA erreichbar und die Liste verfügbar war |

Zu welcher Liste diese Zeilen gehören, merkt sich `server_config` (`ha_links_entity`, 5.4, Schritt 2). Der Merker kommt beim Zurückspielen mit der Sicherung (`sync-protokoll.md` 11.9).

### 5.4 Abgleich

Eine eigene Schleife im Server nach dem Muster von `off.py` (Aufgabe `stowly-ha`, eingereichte Uhr, `wake()`). Seit 0.4.0 läuft sie immer, wie die Abfrage bei GitHub (10.2):

- **Einrichtung:** Vor jedem Lauf liest sie die wirksame Einrichtung (5.1). Ohne sie ruht sie mit dem Zustand `off`, ohne Anfrage an HA. Eine Änderung in der App weckt sie (`reconfigure`); ein laufender Abgleich hört nach der laufenden Anfrage auf. Hat sich der Fingerabdruck geändert (Adresse, Hash des Tokens, Liste, CA), schließt sie den alten Client und baut einen neuen, nie mitten in einer Anfrage. Bis zum ersten Lauf mit der neuen Einrichtung ist der Zustand `pending`, und dieser Lauf kommt gleich.
- **Wann:** alle zwei Minuten (`HA_SYNC_INTERVAL_S` = 120); dazu geweckt nach jeder Änderung an der Einkaufsliste (nach dem Sync, wie `off.OffWorker.wake`), frühestens 5 Sekunden nach der letzten solchen Änderung; und zu dem Zeitpunkt, an dem der nächste offene Eintrag zwei Minuten offen ist. Bring! selbst aktualisiert sich in HA etwa alle 90 Sekunden.
- **HTTP:** `httpx2`, `Authorization: Bearer <Token>`, keine Weiterleitungen. Je Aufruf höchstens 10 Sekunden für Anfrage und Antwort zusammen, auch wenn die Antwort tröpfchenweise kommt, und höchstens 8 MiB Rumpf (sonst `error`: „Die Antwort von Home Assistant ist zu groß (mehr als 8 MiB)."). `STOWLY_HA_CA` gilt, wenn gesetzt, zusätzlich zu den Zertifizierungsstellen des Systems, nicht statt ihrer.

Ein Lauf:

1. **Liste da?** `GET {Adresse}/api/states/{entity}`. 401: Zustand `unauthorized`, Ende. 404: `not_found`, Ende. Netzfehler, Zeitüberschreitung, Zertifikat: `unreachable`, Ende. 5xx: `error`, Ende. `state` ist `unavailable` oder `unknown`: `unavailable`, Ende. In allen diesen Fällen schreibt der Server nichts und zählt kein Fehlen. (Der Zustand einer To-do-Entität ist sonst die Zahl ihrer offenen Artikel.)
2. **Lesen:** `POST {Adresse}/api/services/todo/get_items?return_response` mit `{"entity_id": "<entity>", "status": ["needs_action", "completed"]}`. Die Artikel stehen in `service_response["<entity>"]["items"]`, je Artikel `summary`, `uid`, `status` (`needs_action` oder `completed`), `description`. Erwartet ist, dass „zuletzt gekauft" in Bring! als `completed` erscheint (klärt die Probe mit dem Anwender). Fehler wie in Schritt 1; 400 heißt `error` („HA kennt todo.get_items nicht so").
   - **Liste gewechselt?** Danach vergleicht der Server die gelesene Liste mit dem Merker `ha_links_entity` in `server_config`, in einer Transaktion. Gehört `ha_links` zu einer anderen Liste, leert er `ha_links` und löst die Bindungen aller Einträge der Einkaufsliste (`bring_key = null`). Nichts wird abgehakt: Die offenen Einträge gehen in Schritt 4 neu in die neue Liste, in der alten bleiben sie stehen. Dann gilt der Merker für die neue Liste. Fehlt er (erster Lauf nach dem Update auf 0.4.0), setzt der Server nur ihn. `bring_key` steht nicht im Sync; die Geräte bekommen dafür keinen neuen `rev`. Ins Log kommt eine Zeile „Home Assistant: Liste gewechselt (…): … Nichts wird abgehakt." Bis 0.3.x suchte Stowly die gespiegelten Artikel nach einem Wechsel in der neuen Liste und hakte die Einträge nach zwei Abgleichen als eingekauft ab.
3. **Zurück** (aus Bring! nach Stowly), je Zeile von `ha_links`, gesucht nach `name_key` (steht ein Name als offen und als erledigt in der Liste, gilt der offene):
   - offen gefunden: `seen_at`, `misses = 0`, `uid` übernehmen; bei fremden `status = needs_action`. Ein eigener Artikel mit `status` `completed` oder `removed`, der wieder offen dasteht, wurde zurückgeholt: Er wird fremd (`own = 0`, `status = needs_action`), Stowly schreibt ihn nie mehr.
   - erledigt gefunden, zuletzt aber offen geschrieben oder gesehen: **in Bring! abgehakt.** Alle offenen Einträge, die an diesen Artikel gebunden sind, werden erledigt: `done_at` = jetzt, `closed_by = bring`, Uhr von `done` = jetzt, Ereignis `shopping_item.bring_done` (`how: completed`); bei einem automatischen Eintrag die Sperre (`sync-protokoll.md`, 7.6). `status = completed`. Hat Stowly den eigenen Artikel seit dem Anlegen noch nie gesehen, zählt ein erledigter Artikel desselben Namens nur, wenn seine `uid` nicht die des alten Artikels aus „zuletzt gekauft" ist (5.3, `uid`).
   - nicht gefunden: `misses + 1`. Erst beim **zweiten Fehlen in Folge** und nur, wenn er zuletzt offen war: **in Bring! gelöscht**, Folgen wie beim Abhaken (`how: removed`), `status = removed`. Ein Neustart von HA, der die Liste kurz leer zeigt, leert so nicht die Liste von Stowly.
   - **Fehlen zählt erst, wenn der Artikel schon einmal in der Liste stand** (`seen_at` gesetzt). Einen eigenen Artikel, den Stowly angelegt, aber noch nie gesehen hat, hält der Server nie für gelöscht. So erledigt weder ein Bring!, das neue Artikel erst nach einer Weile zeigt, noch ein Name, den HA oder Bring! beim Anlegen verändert (gekürzt, anders geschrieben), Einträge in Stowly. Steht ein eigener Artikel zehn Minuten nach dem Anlegen noch nie in der Liste, schreibt der Server einmal eine Warnung ins Log; der Eintrag bleibt gebunden und offen.
   - Das gilt für eigene **und fremde** Artikel: Hakt jemand einen gleichnamigen fremden Artikel ab, gilt der Eintrag in Stowly als eingekauft.
4. **Hin** (aus Stowly nach Bring!):
   - **Neue Einträge** (offen, gespiegelt nach 5.2, noch ohne `bring_key`): Gibt es zu ihrem `name_key` einen Artikel, der gerade offen in der Liste steht, bindet der Server den Eintrag daran. Ist es ein Artikel, den Stowly nicht kennt, legt er dafür eine Zeile mit `own = 0` an: **Stowly legt keinen zweiten an, ändert ihn nie und hakt ihn nie ab.** Ebenso bindet er an einen eigenen offenen Artikel, den er angelegt, aber noch nie gesehen hat. Fehlt ein schon gesehener eigener Artikel gerade, wartet er einen Lauf: Erst Schritt 3 entscheidet, ob er gelöscht ist. Sonst `POST /api/services/todo/add_item` mit `{"entity_id", "item": <Name>, "description": <Beschreibung>}`, Zeile mit `own = 1`, `status = needs_action`, `misses = 0` (eine alte Zeile desselben Namens wird ersetzt; deren geschlossene Einträge verlieren ihre Bindung), dann binden.
   - **Ohne Antwort auf `add_item`** (Netzfehler oder Zeitüberschreitung, nachdem die Anfrage hinaus ist) gilt der Artikel als angelegt: Lieber steht ein Eintrag nie in Bring! als zweimal. Die Warnung nach zehn Minuten (Schritt 3) sagt es dann.
   - **Beschreibung** eines eigenen offenen Artikels nachführen, wenn sie sich geändert hat: `POST /api/services/todo/update_item` mit `{"entity_id", "item": <uid oder Name>, "description": …}`.
   - **Eigene Artikel ohne offenen Eintrag** (alle gebundenen sind erledigt oder gelöscht) mit `status = needs_action`: Entschieden wird nach dem zuletzt geschlossenen gebundenen Eintrag (`closed_by`):
     - `bring`: nichts; in Bring! ist es schon erledigt.
     - `stock` oder `merge` (der Bestand reicht wieder, kein Mindestbestand mehr, zusammengelegt): `POST /api/services/todo/remove_item` mit `{"entity_id", "item": <uid oder Name>}`, `status = removed`. So entsteht kein „gekauft", das niemand getan hat.
     - `device` oder `store` (abgehakt, gelöscht, durch Einlagern erledigt): `update_item` mit `"status": "completed"`, `status = completed`. In Bring! wandert er zu „zuletzt gekauft".
     - `closed_by` nennt, was den Eintrag geschlossen hat. Wird ein erledigter Eintrag danach gelöscht, bleibt es dabei: Das ist Aufräumen, wie bei der Sperre (`sync-protokoll.md`, 7.6).
   - **Fremde Artikel** schreibt Stowly nie.
   - **Wieder geöffnet:** Ein Eintrag, dessen Artikel `completed` oder `removed` ist oder zu dessen `bring_key` es keine Zeile in `ha_links` gibt, verliert beim Wiederöffnen seine Bindung (`bring_key = null`) und geht beim nächsten Lauf neu nach Bring!. Steht der Name dort unter „zuletzt gekauft", holt `todo.add_item` ihn erwartungsgemäß zurück auf die Liste, statt einen zweiten anzulegen (klärt die Probe mit dem Anwender).
5. Zustand `ok`, `last_ok_at` = jetzt.

**Schreiben** (`update_item`, `remove_item`) geht nur an eigene Artikel, die in diesem Lauf offen in der Liste stehen, mit ihrer `uid` aus diesem Lauf (ohne `uid` mit dem Namen, wie er dort steht). Steht der Artikel gerade nicht da, wartet der Server bis zu einem Lauf, in dem er ihn sieht. Scheitert das Schreiben eines einzelnen Artikels mit 4xx oder 5xx, schreibt er die übrigen trotzdem; der Lauf endet dann mit `error`, und der nächste versucht es erneut. 401 und Netzfehler beenden den Lauf sofort (`unauthorized`, `unreachable`). Beim Lesen (Schritte 1 und 2) ergibt ein anderer unerwarteter Status, etwa 403, `error`.

Was ihr selbst in Bring! eintragt, übernimmt Stowly nie in seine Liste.

### 5.5 Übersicht

| In Stowly | In Bring! |
|---|---|
| Eintrag seit zwei Minuten offen, mit Namen | Artikel mit Name und Beschreibung, oder Bindung an einen gleichnamigen vorhandenen |
| Menge ändert sich („fehlt 2" → „fehlt 1") | Beschreibung nachgeführt (nur eigene Artikel) |
| abgehakt, gelöscht, durch Einlagern erledigt | abgehakt: „zuletzt gekauft" (nur eigene) |
| automatischer Eintrag, Bestand reicht wieder, kein Mindestbestand mehr oder zusammengelegt | entfernt, kein „gekauft" (nur eigene) |
| umbenannt | nichts |

| In Bring! | In Stowly |
|---|---|
| Artikel abgehakt | gebundene offene Einträge erledigt (eingekauft); bei automatischen die Sperre |
| Artikel gelöscht (zweimal nacheinander nicht gesehen) | ebenso |
| neuer Artikel | nichts |

### 5.6 Fehler und Zustand

| Lage | `HaStatus.state` | `last_error` (Beispiel) |
|---|---|---|
| nicht eingerichtet | `off` | – |
| eingerichtet, seit dem Start oder der letzten Änderung noch kein Lauf | `pending` | – |
| letzter Lauf gelungen | `ok` | `null` |
| 401 | `unauthorized` | „Home Assistant lehnt den Token ab." |
| 404 der Liste | `not_found` | „Die Liste todo.zuhause gibt es in Home Assistant nicht." |
| Liste `unavailable` oder `unknown` | `unavailable` | „Die Liste ist in Home Assistant gerade nicht verfügbar." |
| Netzfehler, Zeitüberschreitung, Zertifikat | `unreachable` | „Home Assistant ist nicht erreichbar." (beim Zertifikat: „… Zertifikat nicht vertraut, siehe STOWLY_HA_CA.") |
| 5xx, unerwartete Antwort | `error` | „Home Assistant antwortet mit 500." |
| Antwort über 8 MiB | `error` | „Die Antwort von Home Assistant ist zu groß (mehr als 8 MiB)." |

Nach einem Fehler kommt der nächste Versuch mit dem normalen Takt. Ins Log schreibt der Server einen Wechsel des Zustands, nicht jeden gescheiterten Lauf. Der Zustand lebt im Arbeitsspeicher und gehört zu einer Einrichtung (ihrem Fingerabdruck, 5.4): Er beginnt mit dem Start und mit jeder geänderten Einrichtung neu (`pending`); `ha_links` bleibt. Was an der Einrichtung fehlt, steht daneben in `problem` (5.1, 8).

### 5.7 Prüfung der Verbindung

`POST /api/server-config/ha/check` (`sync-protokoll.md` 11.10, `stowly/hacheck.py`): Assistent und Einstellungen prüfen damit Adresse und Token, bevor sie gespeichert werden, und holen die To-do-Listen zur Auswahl. Die Prüfung speichert nichts.

- **Was geprüft wird:** ohne Felder die wirksame Einrichtung, sonst `url` und `token` aus der Anfrage. Ohne `token` geht der gespeicherte nur an seine eigene Adresse, an eine andere keiner. Kommt die Verbindung aus der Umgebung, prüft sie nur die dort eingetragene; Felder geben dann 409.
- **Ablauf:**
  1. `GET /api/` (mit dem Token, wenn es einen gibt): `{"message": "API running."}` heißt Home Assistant.
  2. `GET /api/config`, freiwillig: Version und Name des Zuhauses; ein Fehler hier zählt nicht.
  3. `GET /api/states`, gestreamt, höchstens 8 MiB: die Entitäten `todo.*` mit ihrem Namen (ohne Steuer- und Formatzeichen, höchstens 100 Zeichen) und der Zahl offener Einträge, nach Namen sortiert, höchstens 100.
- **Grenzen:** 8 Sekunden je Abfrage, 12 insgesamt. Eine Prüfung zugleich, und zwischen dem Beginn zweier liegen mindestens 3 Sekunden, für den ganzen Server; sonst 429 mit `Retry-After`. Einer Weiterleitung folgt die Prüfung nie. Erlaubte Ziele nach 5.1, mit derselben bekannten Grenze: Namen löst sie dafür nicht auf.
- **Antwort `HaCheck`:** `state`, `message` (ein deutscher Satz), `ha_version`, `location_name`, `lists` (je `entity_id`, `name`, `open`) und `entity_found` (die wirksame Liste gibt es in HA; `null` ohne Liste). Nie eine rohe Antwort von HA, nie ein Token. Fehler bildet die Prüfung ab wie der Abgleich (5.6).

| `state` | Wann | `message` (Beispiel) |
|---|---|---|
| `ok` | `/api/states` gelesen | „Verbindung zu Home Assistant steht; 3 To-do-Listen gefunden.", dazu „Die Liste todo.… gibt es dort nicht.", wenn die wirksame fehlt |
| `token_needed` | 401 ohne Token | „Home Assistant antwortet. Bitte einen langlebigen Zugangs-Token eintragen (in Home Assistant: Profil, Sicherheit)." |
| `unauthorized` | 401 mit Token | „Home Assistant lehnt den Token ab." |
| `not_ha` | `/api/` antwortet nicht wie HA, oder mit 404 bzw. 405 | „Unter dieser Adresse antwortet kein Home Assistant." |
| `unreachable` | Netz, Zeitüberschreitung, Zertifikat, Frist der Prüfung | „Home Assistant ist nicht erreichbar.", „Home Assistant antwortet zu langsam (die Prüfung dauert höchstens 12 Sekunden)." |
| `error` | Weiterleitung, anderer Status, zu große oder unerwartete Antwort, unbrauchbare CA | „Die Adresse leitet weiter (301); Stowly folgt dem nicht. …" |

## 6. Sensor für Home Assistant

`GET /api/ha/summary` (`sync-protokoll.md`, 11.2): nur lesend, mit dem Token des Sensors, `Cache-Control: no-store`.

**Der Sensor-Token** kommt aus `STOWLY_HA_SUMMARY_TOKEN` oder, ohne die Variable, aus der App (`POST /api/server-config/ha/sensor-token`, `sync-protokoll.md` 11.10): 64 Hex-Zeichen, gespeichert wie der Token für HA in `/data/secrets` (`ha_sensor_token.json`, in keiner Sicherung; in `server_config` nur der Merker `ha_sensor_set_at`). Gelesen wird er bei jeder Anfrage: Erzeugen, Ersetzen und Entfernen wirken ohne Neustart. Gibt es keinen, antwortet der Sensor mit 503 `not_configured`. Nach einem Zurückspielen fehlt ein Token aus der App, und `HaStatus.problem` sagt es: „Der Sensor-Token fehlt (steht in keiner Sicherung); bitte neu erzeugen." Er hängt nicht an der Verbindung für Bring!: Der Sensor geht auch ohne sie.

### 6.1 Antwort

```json
{
  "state": 3,
  "today": 2,
  "expired": 1,
  "total": 42,
  "next": { "name": "Joghurt", "best_before": "2026-11-14", "days": 0, "count": 2, "zone": "Kühlschrank" },
  "shopping": 4,
  "soon_list": ["2× Joghurt (14.11.)", "Milch (18.11.)"],
  "expired_list": ["Quark (12.11.)"],
  "shopping_list": ["Milch (fehlt 2)", "Butter (2×)", "Grillkohle", "Kaffee"],
  "message": "Heute laufen 2 Packungen ab: Joghurt. 1 Packung ist abgelaufen. Auf der Einkaufsliste stehen 4 Einträge.",
  "updated_at": "2026-11-14T06:30:00.000Z"
}
```

Alles gilt für „heute" in `STOWLY_TIMEZONE` und für Packungen im Bestand, gestuft mit `expiry_state` und `warn_days_for` (`mhd.py`):

- `state`: Packungen in Stufe `soon` (heute eingeschlossen); `today`: davon mit MHD heute; `expired`: Stufe `expired`; `total`: alle im Bestand.
- `next`: unter den Packungen mit MHD ab heute (`days` ≥ 0) die nach FIFO erste (`compare_fifo`: früheres MHD, dann zuerst eingelagert, dann Kennung; in der App `compareFifo`), gleich in welcher Stufe; `name` ist der Anzeigename ihres Produkts, `count` die Zahl der Packungen dieses Produkts mit diesem MHD, `zone` die Zone der ersten davon nach FIFO. `null`, wenn es keine gibt.
- `shopping`: offene Einträge der Einkaufsliste.
- `soon_list`, `expired_list`: je Produkt und MHD ein Eintrag `Name (TT.MM.)`, bei mehreren Packungen `2× Name (TT.MM.)`; nach MHD, dann nach dem Anzeigenamen (verglichen nach `str.casefold()` in der Reihenfolge der Unicode-Zeichen), dann nach der Kennung des Produkts; **höchstens 5**, jeder höchstens 40 Zeichen (der Name wird mit „…" gekürzt).
- `shopping_list`: offene Einträge in der Reihenfolge der App (älteste zuerst), `Name (fehlt 2)`, `Name (2×)` oder nur `Name`; höchstens 5, je höchstens 40 Zeichen.
- `message`: ein fertiger Satz zum Vorlesen, **höchstens 255 Zeichen**, aus diesen Teilen, mit Leerzeichen verbunden:
  1. `today` ≥ 1: `Heute läuft 1 Packung ab: <Namen>.` bzw. `Heute laufen <n> Packungen ab: <Namen>.`; sonst `state` ≥ 1: `Bald läuft 1 Packung ab: <Name> am <TT.MM.>` bzw. `Bald laufen <n> Packungen ab, als Nächstes <Name> am <TT.MM.>` (der Punkt des Datums beendet den Satz, kein zweiter); sonst `Nichts läuft bald ab.`
  2. `expired` ≥ 1: `1 Packung ist abgelaufen.` bzw. `<n> Packungen sind abgelaufen.`
  3. `shopping` ≥ 1: `Auf der Einkaufsliste steht 1 Eintrag.` bzw. `Auf der Einkaufsliste stehen <n> Einträge.`

  `<Namen>` sind die Anzeigenamen der verschiedenen Produkte der heute ablaufenden Packungen, sortiert wie die Listen, höchstens drei: „A", „A und B", „A, B und C", bei mehr „A, B, C und weitere". `<Name>` und `<TT.MM.>` in „Bald …" gehören zur nach FIFO ersten Packung in Stufe `soon`; das ist nicht immer `next`, denn `next` kann wegen einer kürzeren Vorlaufzeit eine Packung in Stufe `ok` sein. Wäre der Satz länger als 255 Zeichen, wird er am letzten Wort davor mit „…" gekürzt.
- `updated_at`: Serverzeit der Antwort.

Home Assistant begrenzt den *Zustand* einer Entität auf 255 Zeichen. Der Zustand des Sensors ist hier eine Zahl; die Grenzen der Listen und des Satzes sorgen dafür, dass auch Vorlagen-Sensoren daraus darunter bleiben. Sie stehen im Vertrag als `HA_SUMMARY_LIST_MAX` (5), `HA_SUMMARY_ENTRY_MAX` (40) und `HA_SUMMARY_MESSAGE_MAX` (255), in `server/stowly/contract/api.py` und `api.gen.ts`.

### 6.2 Entwurf für `docs/betrieb.md`

Seit 0.4.0 steht die Anleitung in `betrieb.md`, 18; die App erzeugt den Token und liefert das YAML fertig für ihre Adresse (`web/src/features/settings/haSnippet.ts`, ein Test vergleicht es mit `betrieb.md`). Von Hand: den Token des Sensors erzeugen (etwa `openssl rand -hex 32`), als `STOWLY_HA_SUMMARY_TOKEN` in die `.env` von Stowly und mit `Bearer ` davor in die `secrets.yaml` von HA:

```yaml
# secrets.yaml
stowly_summary_auth: "Bearer …"
```

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

Beispiel-Ansage am Morgen (Automation mit Zeit-Auslöser; Stowly schickt keinen Webhook):

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

**Eigene Zertifizierungsstelle in beide Richtungen:**

- *HA muss Stowly vertrauen (Sensor).* Die `rest`-Integration kennt nur `verify_ssl: true/false`, keine eigene CA. Am besten bekommt HA die CA ins Vertrauen des Systems (bei HA im Container etwa über die Zertifikatsablage des Containers; wie es bei eurer Installation geht, klärt die Probe mit dem Anwender). Sonst `verify_ssl: false`: verschlüsselt, aber ohne Prüfung; der Sensor-Token erlaubt nur, diese Zusammenfassung zu lesen.
- *Stowly muss HA vertrauen (Bring!),* wenn HA per https mit eigenem Zertifikat läuft: die CA als PEM-Datei in den Container legen und `STOWLY_HA_CA` darauf zeigen lassen. Läuft HA per http im Heimnetz, entfällt das.

### 6.3 Liste aller Waren

`GET /api/ha/stock` (`sync-protokoll.md`, 11.2): nur lesend, mit demselben Token wie der Sensor, `Cache-Control: no-store`. Gedacht für eine Karte in HA (`betrieb.md`, 18.4), nicht für den Zustand einer Entität: Die Liste steht in einem Attribut und ist deshalb nicht an 255 Zeichen gebunden.

```json
{
  "state": 7,
  "product_count": 5,
  "zones": [
    {
      "name": "Kühlschrank",
      "count": 3,
      "products": [
        { "name": "Quark", "count": 1, "best_before": "2026-11-12", "mhd": "12.11.2026", "days": -2, "state": "expired" },
        { "name": "Joghurt", "count": 2, "best_before": "2026-11-14", "mhd": "14.11.2026", "days": 0, "state": "soon" }
      ]
    },
    {
      "name": "Keller",
      "count": 4,
      "products": [
        { "name": "Reis", "count": 2, "best_before": "2027-03-01", "mhd": "01.03.2027", "days": 107, "state": "ok" },
        { "name": "Nudeln", "count": 1, "best_before": "2027-05-01", "mhd": "01.05.2027", "days": 168, "state": "ok" },
        { "name": "Salz", "count": 1, "best_before": null, "mhd": null, "days": null, "state": "none" }
      ]
    }
  ],
  "truncated": false,
  "updated_at": "2026-11-14T06:30:00.000Z"
}
```

Alles gilt für „heute" in `STOWLY_TIMEZONE` und für Packungen im Bestand, gestuft wie beim Sensor (6.1):

- `state`: alle Packungen im Bestand (wie `total` des Sensors); `product_count`: verschiedene Produkte.
- `zones`: nur Zonen mit Bestand, in der Reihenfolge der Zonen (`sort`, dann Name, dann Kennung, wie die Statistik). Eine gelöschte Zone führt zu ihrem Ziel (`moved_to`), wie bei `next.zone`. Eine Packung ohne auffindbare Zone stünde am Ende unter „Ohne Zone".
- Je Zone `count`, die Packungen dort, und `products`: je Produkt ein Eintrag mit der Zahl seiner Packungen in dieser Zone (`count`). Liegt ein Produkt in zwei Zonen, steht es in beiden.
- Ein Eintrag beschreibt sich durch die nach FIFO erste seiner Packungen in der Zone, also die mit dem frühesten MHD: `best_before`, `mhd` (dasselbe als `TT.MM.JJJJ` zum Anzeigen), `days` (0 = heute, negativ = abgelaufen) und `state` (`none`, `ok`, `soon`, `expired`). Hat keine Packung ein MHD, sind die drei ersten `null` und `state` ist `none`.
- Sortiert nach diesem MHD (ohne MHD zuletzt), dann nach dem Anzeigenamen (`str.casefold()`), dann nach der Kennung des Produkts.
- `name`: der Anzeigename (bei Platzhaltern der Barcode), höchstens 60 Zeichen (`HA_STOCK_NAME_MAX`), sonst mit „…" gekürzt.
- Höchstens 300 Einträge über alle Zonen (`HA_STOCK_ENTRY_MAX`). Danach ist `truncated` `true`, die übrigen Einträge und Zonen fehlen; `state`, `product_count` und `count` zählen trotzdem alles.

HA speichert Attribute über 16 KB nicht in seiner Historie und schreibt dann eine Warnung ins Log; das sind grob 150 Einträge. Deshalb nimmt man diesen Sensor aus der Historie aus (`betrieb.md`, 18.4); die Anzeige geht trotzdem.

## 7. Umgebungsvariablen

Alle Einstellungen des Servers, beim Start gelesen und geprüft (`server/stowly/config.py`). Ein Konfigurationsfehler beendet den Start mit Exit-Code 2 und einer deutschen Meldung, die die Variable nennt; der Wert eines Tokens erscheint darin nie. Leere Werte gelten als nicht gesetzt, Leerraum am Rand fällt weg.

| Variable | Format | Vorgabe | Prüfung beim Start | Wenn nicht gesetzt |
|---|---|---|---|---|
| `STOWLY_PASSWORD` | Text | im Entwicklungsmodus `stowly` | – | Das Passwort aus der App gilt (`meta.password_hash`); gibt es keines, setzt es, wer die Seite zuerst öffnet ([`sync-protokoll.md`](sync-protokoll.md), 5 und 11.6) |
| `STOWLY_DATA_DIR` | Pfad | `/data` im Container, `data/` im Repository | – | Vorgabe |
| `STOWLY_WEB_DIR` | Pfad | `/app/web` im Container, `web/dist` im Repository | – | nur die Schnittstelle |
| `STOWLY_HOST` | Adresse | `127.0.0.1` (im Container `0.0.0.0`) | – | Vorgabe |
| `STOWLY_PORT` | Zahl | `8010` | eine Zahl | Vorgabe |
| `STOWLY_DEV` | `1`/`0`, `ja`/`nein` … | `0` | Wahrheitswert | aus |
| `STOWLY_LOG_LEVEL` | `critical` … `trace` | `info` | eine der Stufen | Vorgabe |
| `STOWLY_CSP` | Text oder `off` | Vorgabe des Servers | druckbares ASCII | Vorgabe |
| `STOWLY_OFF_ENABLED` | Wahrheitswert | `1` | Wahrheitswert | an |
| `STOWLY_OFF_URL` | URL | `https://world.openfoodfacts.org` | – | Vorgabe |
| `STOWLY_OFF_CONTACT` | Text | – | – | kein Kontakt im User-Agent |
| `STOWLY_TIMEZONE` | IANA-Name | `Europe/Berlin` | `zoneinfo` kennt sie (aus `tzdata`), genau so geschrieben wie dort (unter Windows fände `zoneinfo` sonst auch „europe/berlin", unter Linux nicht) | Vorgabe |
| `STOWLY_BACKUP_DIR` | absoluter Pfad | – | absolut | Wahl nach 3.5: `/backups`, wenn eingebunden und beschreibbar, sonst `/data/backups` |
| `STOWLY_BACKUP_RECIPIENTS` | `age1…`, getrennt durch Komma oder Leerraum | – | jeder ein öffentlicher age-Schlüssel (X25519); ein privater (`AGE-SECRET-KEY-…`) beendet den Start mit eigener Meldung, die ihn nicht zitiert | die Schlüssel aus der App (3.1); gesetzt ist die Sicherung fest an |
| `STOWLY_BACKUP_TIME` | `HH:MM` | – | Form `HH:MM` | die Uhrzeit aus der App, sonst `03:30` |
| `STOWLY_HA_URL` | `http(s)://Host[:Port]` | – | absolut, ohne Pfad; ein `/` am Ende fällt weg | mit Token und Liste aus der App (5.1); ist eine der drei gesetzt, kommen alle drei aus der Umgebung |
| `STOWLY_HA_TOKEN` | Text | – | – | wie `STOWLY_HA_URL` |
| `STOWLY_HA_TODO_ENTITY` | `todo.<name>` | – | Muster `^todo\.[a-z0-9_]+$` | wie `STOWLY_HA_URL` |
| `STOWLY_HA_CA` | Pfad zu einer PEM-Datei | – | Datei lesbar und als PEM ladbar | Vertrauen des Systems; gesetzt gilt sie auch für die Verbindung aus der App |
| `STOWLY_HA_SUMMARY_TOKEN` | Text, mindestens 32 Zeichen | – | Länge; nur druckbares ASCII ohne Leerraum | der Sensor-Token aus der App (6), sonst kein Sensor (503 `not_configured`) |
| `STOWLY_PUSH_CONTACT` | `mailto:<Adresse>` oder `https://<Host>` | – | Form: `mailto:` mit einer Adresse samt Domäne oder `https://` mit Host, das Schema klein geschrieben, ohne Benutzerangabe | Kontakt aus der App (12), sonst kein Push (503 `not_configured`) |
| `STOWLY_UPDATE_REPO` | `<konto>/<name>` | – | Muster `^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$`, Name nicht `.` oder `..` | Schalter in der App (12), sonst keine Abfrage bei GitHub (10.1) |
| `STOWLY_UPDATE_REPO_DEFAULT` | `<konto>/<name>` | im veröffentlichten Image das eigene Repository | wie `STOWLY_UPDATE_REPO` | der Schalter in der App wirkt nicht (`available: false`) |
| `STOWLY_HTTPS_PORT` | Zahl | im Image `8443` | 1 bis 65535, nicht `STOWLY_PORT` | kein HTTPS-Listener (11) |
| `STOWLY_PI_BUNDLE` | absoluter Pfad | im Image `/app/pi-bundle.tar.gz` | absolut | im Quell-Checkout baut der Server das Paket selbst, sonst gibt es keines ([`sync-protokoll.md`](sync-protokoll.md), 11.8) |
| `STOWLY_IMAGE_REF` | Image ohne Tag, etwa `docker.io/<konto>/stowly` | im veröffentlichten Image gesetzt | Form einer Docker-Referenz ohne Tag und Digest | kein fertiger Befehl für den Updater-Container (10.7) |
| `STOWLY_IMAGE_TAG` | Tag des Images, etwa `0.3.1` oder `0.3.1-rc.1` | im veröffentlichten Image gesetzt (seit 0.3.1) | Docker-Tag: bis 128 Zeichen aus Buchstaben, Ziffern, `_`, `.`, `-`, nicht mit `.` oder `-` am Anfang | der Befehl für den Updater-Container nennt die Version des Servers (10.7) |

Seit 0.4.0 sind alle Variablen der Sicherung und von Home Assistant freiwillig: Was fehlt, kommt aus der App (3.1, 5.1, 12). Was gesetzt ist, geht vor und ist in der App gesperrt. Öffentliche Schlüssel aus `STOWLY_BACKUP_RECIPIENTS` schalten die Sicherung fest an. Von Home Assistant ist `STOWLY_HA_CA` allein keine halbe Einrichtung mehr: Adresse, Token und Liste kommen dann aus der App, und die CA gilt für sie. Ebenso wenig `STOWLY_HA_SUMMARY_TOKEN` allein: Der Sensor braucht den Abgleich nicht.

Nur für Docker Compose und den Updater, nicht vom Server gelesen: `STOWLY_PUBLISH`, `STOWLY_USB_GID`, `TZ` (die Zeitzone für Stowly ist `STOWLY_TIMEZONE`), `STOWLY_IMAGE` und `STOWLY_VERSION` (fertiges Image, 10.1), `STOWLY_VOLUME` (Name des Datenvolumes für den Updater, 10.6). `FORWARDED_ALLOW_IPS` wirkt seit 0.3.0 nicht mehr: Beide Listener werten keine Proxy-Kopfzeilen aus, damit Stowly sicher weiß, ob eine Anfrage über seinen HTTPS-Listener kam (11). `.env.example` nennt jede Variable mit einem kurzen Satz; Beispiele nur mit Platzhaltern (`stowly.example`, `ha.example`, Token als `…`).

## 8. Zustand der Integrationen

`GET /api/integrations` (`sync-protokoll.md`, 11.4) liefert `IntegrationStatus` für die Einstellungen der App:

- **`timezone`:** `STOWLY_TIMEZONE`.
- **`backup`** (`BackupStatus`): wie in 3.6. `configured` und `problem` nach 3.1, `folder` und `files` nach 3.5 und 3.6; `time` aus Umgebung, App oder Vorgabe, auch wenn die Sicherung aus ist, `null` nur ohne Schlüssel und ohne jede Einstellung; `next_at` und `warning` nur, wenn sie an ist und einen Schlüssel hat.
- **`ha`** (`HaStatus`): `configured` = Adresse, Token und Liste sind wirksam, aus der Umgebung oder der App (5.1). `problem` nennt, was an der Verbindung fehlt, und danach, was am Sensor fehlt, etwa „Der Sensor-Token fehlt (steht in keiner Sicherung); bitte neu erzeugen." `entity` = die wirksame Liste; `state`, `last_ok_at`, `last_error`, `last_error_at` nach 5.6, `pending` auch nach einer Änderung, bis der erste Lauf mit der neuen Einrichtung durch ist; `linked` = offene Einträge mit `bring_key`; `sensor` = ein Sensor-Token wirkt (Umgebung oder App).
- **`push`** (`PushStatus`): `configured` = ein Kontakt ist wirksam (aus der Umgebung oder der App, 12); `problem` ist derzeit immer `null` (ein ungültiger `STOWLY_PUSH_CONTACT` beendet schon den Start, einen ungültigen in der App lehnt `PATCH /api/server-config` ab); `subscriptions` = Abos im Haushalt; `this_device` = das fragende Gerät hat eines; `last_run_at` = `job_runs.push_daily.last_at`; `last_sent_at` = `state.sent_at`; `last_error` = `job_runs.push_daily.last_error`.
- **`update`** (`UpdateStatus`): nach 10.4.
- **Nie** darin: ein Token, ein privater Schlüssel, die Adresse von HA, `STOWLY_PUSH_CONTACT`, Pfade des Rechners oder das Log des Updaters. Öffentliche age-Schlüssel nur gekürzt. `backup.folder` ist ein Pfad im Container, nicht auf dem Rechner.

Die App lädt den Zustand, wenn die Einstellungen offen sind (`core.integrations.load`); offline sagt sie, dass er fehlt.

## 9. Was die Probe mit dem Anwender klären soll

Kurze Probe gegen euer HA mit einer eigenen Testliste in Bring! (Plan, Runde 1). Die Antworten werden zu Testdaten für das nachgebildete HA in den Tests des Servers.

1. Liefert `todo.get_items` mit `status: ["needs_action", "completed"]` die Artikel von „zuletzt gekauft" als `completed`, und wie viele?
2. Was tut `todo.add_item` mit einem Namen, der schon offen in der Liste steht (zweiter Artikel, geänderte Spezifikation, Fehler)? Und mit einem Namen aus „zuletzt gekauft" (wandert er zurück)?
3. Unterscheidet Bring! Groß- und Kleinschreibung und Leerzeichen am Rand?
4. Kommt `description` als Spezifikation in Bring! an und zurück? Ändert `todo.update_item` mit nur `description` die Spezifikation?
5. Ist die `uid` eines Artikels über Abgleiche von Bring! und Neustarts von HA stabil? Gehen `update_item` und `remove_item` mit der `uid`?
6. Wie sieht die Liste während und nach einem Neustart von HA aus: zuerst `unavailable`, kurz leer, oder gleich vollständig?
7. Wie lange dauert es, bis ein Abhaken in der App von Bring! in HA ankommt (erwartet: bis zu 90 Sekunden)?
8. Wie lang dürfen Name und Spezifikation in Bring! sein?
9. Wie bekommt euer HA die eigene CA von Stowly ins Vertrauen (Sensor über https), oder bleibt es bei `verify_ssl: false`?
10. Darf ein HA-Benutzer ohne Administratorrechte die Dienste `todo.*` über die Schnittstelle aufrufen?

**Stand 14.11.2026**, aus der Einrichtung beim Anwender (Home Assistant OS, echte Bring!-Liste statt einer Testliste, `docs/pruefliste.md` 54 und 55):

- **1:** Ja. Ein in Bring! abgehakter Artikel kam über `get_items` als `completed` zurück. Wie viele aus „zuletzt gekauft" höchstens kommen, ist offen.
- **4:** Die `description` kommt als Spezifikation an („1× · Stowly") und über `get_items` zurück. `update_item` mit nur `description` ist ungeprüft.
- **6:** Ein Neustart von HA, während der Artikel in Bring! stand, ließ den Eintrag in Stowly offen. Welche der Varianten HA dabei zeigte, ist nicht beobachtet.
- **9:** `verify_ssl: false`; Home Assistant OS bietet keinen einfachen Weg für eine eigene CA.
- **10:** Ja. Ein Benutzer ohne Administratorrechte liest Zustände und ruft `todo.add_item` und `todo.get_items` auf; `update_item` und `remove_item` kamen im Test nicht vor.
- Offen: 2, 3, 5, 7 und 8.

**Bis zur Probe angenommen** (Vorgaben des nachgebildeten HA, `Behaviour()` in `server/tests/ha_fake.py`; jede Annahme ist dort umschaltbar, und die Tests prüfen, dass die Regeln aus 5.4 in jeder Variante gelten):

| Frage | angenommen | auch geprüft |
|---|---|---|
| 1 | `get_items` liefert erledigte Artikel mit | ohne erledigte: Abhaken in Bring! gilt nach zweimal Fehlen als gelöscht |
| 2 | `add_item` mit offenem Namen legt einen zweiten Artikel an; mit einem Namen aus „zuletzt gekauft" wandert dieser zurück | Spezifikation aktualisiert, Fehler 400; neuer Artikel statt Zurückwandern |
| 3 | Groß- und Kleinschreibung und Leerzeichen am Rand gelten als gleich | als verschieden |
| 5 | die `uid` bleibt stabil | neue `uid` nach einem Neustart |
| 6 | nach einem Neustart meldet HA die Liste zuerst als `unavailable` | kurz leere Liste, gleich vollständig |
| 7 | neue Artikel sind sofort sichtbar | erst nach einem oder zwei Abgleichen |
| 8 | Namen werden nicht gekürzt | gekürzt auf wenige Zeichen |

Grenzen, solange die Probe aussteht:

- Kürzt Bring! Namen, sieht Stowly den eigenen Artikel nie: Er gilt nie als gelöscht oder abgehakt, und die Warnung nach zehn Minuten (5.4, Schritt 3) sagt es. Kennt die Probe die Länge, kürzt Stowly die Namen vor `add_item` selbst.
- Liefert `get_items` keine erledigten Artikel und zeigt HA neue Artikel erst verzögert, bleibt ein Eintrag offen, den jemand in Bring! abhakt, bevor Stowly den Artikel je gesehen hat.
- Zeigt ein Neustart von HA die Liste zwei Abgleiche lang leer, also länger als zwei Minuten, gelten ihre Artikel als gelöscht. Sonst bräuchte „gelöscht" mehr Abgleiche oder eine Zeitspanne.

## 10. Updates über GitHub

Der Server fragt GitHub nach dem neuesten Release, die App bietet es an, und installiert wird es vom Updater auf dem Rechner (`updater/stowly-update.sh`), der Docker bedienen darf. Der Server selbst bekommt nie Zugriff auf Docker und läuft weiter ohne Rechte. Anleitung zum Einrichten: [`betrieb.md`](betrieb.md), Abschnitt 9.

### 10.1 Einrichten

- **`STOWLY_UPDATE_REPO=<konto>/<name>`:** das öffentliche Repository der Releases; Updates sind dann immer an. Ohne die Variable entscheidet der Schalter „Nach Updates suchen" in der App über das Repository aus `STOWLY_UPDATE_REPO_DEFAULT`, das das veröffentlichte Image mitbringt (12). Ist beides aus, ist `update.configured` `false`, und die App zeigt nur die Version.
- **Betrieb mit fertigem Image:** `STOWLY_IMAGE` (etwa `ghcr.io/<konto>/stowly`) und `STOWLY_VERSION` (etwa `0.2.0`) stehen in der `.env`. Sie liest nur Docker Compose und der Updater, nicht der Server.
- **Neue Version:** Als neu gilt nur das Release, das GitHub als „latest" führt. Vorabversionen und Entwürfe liefert `releases/latest` nicht. Das Image dazu (`<STOWLY_IMAGE>:X.Y.Z`) entsteht in GitHub Actions, bevor das Release erscheint.

### 10.2 Abfrage bei GitHub

- **Aufruf:** `GET https://api.github.com/repos/{repo}/releases/latest`, ohne Token.
  - Kopfzeilen: `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `User-Agent: Stowly/<version>`.
  - Zeitüberschreitung nach 10 Sekunden.
- **Takt:**
  - `UPDATE_CHECK_FIRST_S` (60) Sekunden nach dem Start, danach `UPDATE_CHECK_INTERVAL_S` (6 Stunden) nach der letzten Abfrage, ob gelungen oder nicht.
  - Dazu auf Knopfdruck (`POST /api/update/check`), höchstens einmal in `UPDATE_CHECK_MIN_GAP_S` (60) Sekunden, sonst 429 mit `Retry-After`. Ein Knopfdruck beginnt den Takt neu.
- **200:**
  - `tag_name` ohne führendes „v" muss `VERSION_PATTERN` (`1.2.3`) treffen. Sonst gilt die Abfrage als gescheitert mit „Das neueste Release hat keine Versionsnummer wie 1.2.3 (Tag …)."
  - `name` wird `latest_name` (leer ergibt `null`).
  - `body` wird `notes`, gekürzt auf `UPDATE_NOTES_MAX` (4000) Zeichen, mit „…" am Ende.
  - `published_at` wird in das Zeitformat des Vertrags umgewandelt.
  - `html_url` wird `url`, nur wenn sie mit `https://github.com/` beginnt, sonst `null`.
- **404:** Es gibt noch kein Release, die Abfrage gilt aber als gelungen: `latest` bis `url` sind `null`, `check_error` ist `null`, `checked_at` ist gesetzt.
- **Fehler:** In allen folgenden Fällen bleiben die bisherigen Angaben zum neuesten Release stehen.
  - **403 oder 429:** `check_error` „GitHub lehnt die Abfrage gerade ab (Ratenlimit). Der nächste Versuch kommt planmäßig."
  - **anderer Status:** „GitHub antwortet mit <Status>."
  - **Netzfehler oder Zeitüberschreitung:** „GitHub ist nicht erreichbar."
  - **200, aber kein JSON-Objekt:** „GitHub antwortet unerwartet." Fehlt `tag_name`, nennt die Meldung zum Tag „(Tag fehlt)".
  - **Weiterleitungen** (3xx) folgt der Server nicht: „GitHub antwortet mit <Status>."
- **Gespeichert** in `job_runs`, Aufgabe `update_check`, mit `scheduler.record_success` bzw. `record_failure`. Der Zustand (`state`) enthält `latest`, `latest_name`, `notes`, `published_at`, `url` und `notified`. So übersteht er einen Neustart.
- **Push, einmal je Version:** Ist `latest` neuer als der Server und noch nicht gemeldet (`notified` ≠ `latest`), geht eine Nachricht an alle Abos des Haushalts:
  - Titel „Neue Version", Text „Stowly X.Y.Z ist verfügbar.", Tag `stowly-update`, Ziel `/einstellungen`.
  - Danach gilt `notified` = `latest`, auch wenn Push nicht eingerichtet ist. Ein späteres Einschalten meldet so nichts nach.

### 10.3 Dateien in `/data/update`

Der Austausch zwischen Server (uid 10001) und Updater (root) läuft über Dateien im Datenvolume. Den Ordner legt der Server beim Start an.

- **Format:** UTF-8, je Zeile `key=value`, Werte ohne Zeilenumbruch. Unbekannte Schlüssel und Zeilen ohne `=` werden überlesen.
- **Zeitpunkte:** in UTC, entweder `YYYY-MM-DDTHH:MM:SSZ` (so schreibt sie der Updater) oder im Format des Vertrags (so schreibt sie der Server). Gelesen werden beide.

| Datei | schreibt | Inhalt |
|---|---|---|
| `request` | Server: zuerst `request.tmp`, dann umbenannt | `version=X.Y.Z`, `requested_at=<Zeitpunkt>`, `device=<Gerätename>` (höchstens 60 Zeichen, Steuerzeichen und `=` entfernt) |
| `state` | Updater | `state=installing\|done\|failed`, `version=<Ziel>`, `from=<vorher>`, `at=<Zeitpunkt>`, `message=<Satz>` |
| `updater` | Updater, bei jedem Lauf | `seen_at=<Zeitpunkt>`, `updater=<Protokoll des Updaters>` (1 bis 0.2.x, 2 ab 0.3.0); seit 0.3.0 dazu `kind=script\|container` (fehlt: `script`), beim Updater-Container `version=<Version von Stowly, aus der er stammt>` und `target=<Name des Ziel-Containers>` |
| `log` | Updater | Ausgabe des letzten Updates, nur zur Fehlersuche auf dem Rechner |
| `before-<alt>-<zeit>.sqlite3` | Updater | Kopie der Datenbank vor dem Update; die drei neuesten bleiben |
| `lock/` | Updater | Sperre während eines Laufs |

### 10.4 Zustand (`UpdateStatus`)

- **`configured`, `repo`:** die wirksamen Werte (12): `STOWLY_UPDATE_REPO`, sonst der Schalter in der App mit `STOWLY_UPDATE_REPO_DEFAULT`.
- **`current`:** `stowly.__version__`.
- **`latest` bis `url`, `checked_at`, `check_error`:** aus `job_runs` (10.2). `checked_at` ist die letzte gelungene Abfrage, auch eine mit 404.
- **`available`:** `latest` ist gesetzt und neuer als `current`. Verglichen werden die drei Zahlen.
- **`updater_seen_at`:** `seen_at` aus `updater`. **`updater_ready`:** höchstens `UPDATER_READY_S` (600) Sekunden alt.
- **`updater_kind`:** `kind` aus `updater` (fehlt es, `script`); `null`, solange sich kein Updater gemeldet hat. **`updater_version`:** `version` aus `updater`, nur in der Form `X.Y.Z`.
- **`updater_command`:** der Befehl, der den Updater-Container anlegt oder erneuert (10.7), mit `STOWLY_IMAGE_REF`, dem Tag aus `STOWLY_IMAGE_TAG` (ohne ihn der Version dieses Servers) und der eigenen Container-ID; `null` ohne `STOWLY_IMAGE_REF` oder ohne erkannte Container-ID.
- **`state`:** Die erste passende Regel gilt.
  1. `request` liegt vor, und `state` meldet `installing` für dieselbe Version: `installing`, `state_at` aus `at`.
     - Ist `at` älter als eine Stunde (seit 0.5.1): `state_message` „Das Update läuft seit über einer Stunde. Woran es hängt, zeigt update/log im Datenordner.“
  2. `request` liegt vor: `requested`; `state_version` und `state_at` aus `request`.
     - Ist die Anforderung älter als `UPDATE_REQUEST_STALE_S` (600 Sekunden) und `updater_ready` falsch: `state_message` „Der Updater hat die Anforderung noch nicht abgeholt. Läuft die Aufgabe auf dem Rechner?"
  3. `state` meldet `installing`: `installing`.
     - Ist `at` älter als 15 Minuten: `state_message` „Der Updater meldet sich seit 15 Minuten nicht. Bitte auf dem Rechner nachsehen."
  4. `state` meldet `done` und `version` = `current`: `done`.
  5. `state` meldet `failed`: `failed`, mit `message` als `state_message`.
  6. Sonst `idle`, auch bei `done` für eine andere Version als `current`, etwa nach einem Zurückspielen von Hand.

  Bei `installing`, `done` und `failed` kommen `state_version` und `state_at` aus `state`, bei `requested` aus `request`.
- **Nie** darin: Pfade des Rechners, der Inhalt von `log`.

### 10.5 Anfordern

`POST /api/update/install` mit `{"version": "X.Y.Z"}`. Vorab: Läuft gerade ein Schritt des Zurückspielens oder liegt eine Sicherung zum Einspielen bereit (`sync-protokoll.md` 11.9), antwortet der Server mit 409 `conflict` „Gerade wird eine Sicherung zurückgespielt. Ein Update geht erst danach." Umgekehrt wartet das Zurückspielen, solange ein Update angefordert ist oder läuft. Danach wird in dieser Reihenfolge geprüft:

1. **Updates sind aus** (weder `STOWLY_UPDATE_REPO` noch der Schalter): 503 `not_configured` „Updates sind auf diesem Server aus. Einschalten unter Einstellungen → Aktualisierung."
2. **`updater_ready` ist falsch:** 503 `not_configured` „Der Updater auf dem Rechner meldet sich nicht (docs/betrieb.md, Abschnitt 9)."
3. **`state` ist `requested` oder `installing`:** 409 `conflict` „Ein Update ist schon angefordert."
4. **`version` ≠ `latest`:** 409 `conflict` „Das ist nicht die neueste bekannte Version. Bitte erst nach Updates suchen."
5. **`latest` ist nicht neuer als `current`:** 409 `conflict` „Diese Version ist schon installiert."
6. **Sonst:** `request` schreiben (10.3), eine Zeile ins Log („Update auf X.Y.Z angefordert von <Gerät>"), Antwort 202 mit `UpdateStatus` (`requested`).

In die Datei kommt nur die geprüfte Versionsnummer, dazu Zeitpunkt und Gerätename, nie etwas anderes aus der Anfrage. Eine vorhandene `state` mit `failed` bleibt liegen, bis der Updater sie überschreibt.

### 10.6 Der Updater

`updater/stowly-update.sh` ist ein POSIX-Skript. Es läuft jede Minute als root, auf DSM über den Aufgabenplaner, auf Debian über einen systemd-Timer.

1. **Ordner finden:** Den Ordner des Datenvolumes liefert `docker volume inspect` (Name aus `STOWLY_VOLUME`, Vorgabe `stowly_stowly-data`). Dann `updater` schreiben.
2. **Anforderung:** Liegt kein `request` vor, ist der Lauf zu Ende. Sonst die Sperre `lock/` anlegen; besteht sie schon, Ende.
3. **Prüfen:** Die Version muss `^[0-9]+\.[0-9]+\.[0-9]+$` treffen, `STOWLY_IMAGE` in der `.env` stehen. Sonst `failed`, `request` löschen.
4. **Laden:** `state` auf `installing`, dann `docker pull <STOWLY_IMAGE>:<version>` mit bis zu drei Versuchen. Scheitert das: `failed`, `request` löschen. Die alte Version läuft unverändert weiter.
5. **Sichern:** Stowly anhalten (`stop`). Die Datenbank samt `-wal` und `-shm` nach `before-<alt>-<zeit>.sqlite3` kopieren.
6. **Umstellen:** `STOWLY_VERSION` in der `.env` setzen. Geschrieben wird in die vorhandene Datei, damit Besitzer und Rechte bleiben; vorher entsteht eine Kopie `.env.bak`. Dann `up -d stowly`.
7. **Warten:** bis zu 180 Sekunden, bis `docker inspect` `healthy` meldet.
8. **Erfolg:** `done`, `request` löschen. Alte Images aufräumen; die aktuelle und die vorige Version bleiben.
9. **Sonst zurück:** anhalten, die Kopie zurückspielen (`-wal` und `-shm` des Fehlversuchs löschen), die alte `STOWLY_VERSION` setzen, `up -d`, warten. Dann `failed` mit „Die neue Version startete nicht, zurück auf <alt>." und dem Ende des Container-Logs in `log`. `request` löschen.

Der Updater tauscht nur das Image. Ändert eine Version `docker-compose.yml`, die `.env` oder den Updater selbst, nennt der Changelog das, und es wird einmal von Hand nachgezogen.

**Härtung (seit 0.3.0):** In `/data/update` schreibt der Server ohne Rechte, der Updater als root. Der Updater folgt dort deshalb keinem Symlink:
- Er prüft `update/`, `log`, `state` und die Datenbank mit `[ -L ]` bzw. `lstat`, schreibt über eigene Zwischendateien (`mktemp` im Ordner) und kopiert nur echte Dateien. Liegt ein Link vor, bricht er mit `failed` ab, ohne ihm zu folgen.
- `request` benennt er zuerst in einen eigenen Ordner um (das folgt keinem Link), prüft dort, dass es eine echte Datei ist, und liest höchstens 4 KiB. Während des Updates liegt deshalb keine `request` mehr in `update/`.
- Ausgaben ersetzt er mit `mv -T`, wo das `mv` des Systems es kann. Ohne `-T` bleibt ein schmales Zeitfenster, in dem ein übernommener Server einen Namen gegen einen Link auf einen Ordner tauschen könnte; root legte dann eine Datei mit zufälligem Namen dort ab. Das ist bekannt und hingenommen.
- Eine Version, die nicht neuer ist als `STOWLY_VERSION`, lehnt er ab (kein Downgrade).

### 10.7 Der Updater-Container

Für einen Container, der per Mausklick in der Docker-Oberfläche entstand (ohne Compose und `.env`), gibt es einen zweiten Weg: einen kleinen Container aus demselben Image, der über den Socket von Docker die Updates ausführt (`python -m stowly.updater`, Paket `server/stowly/updater/`). Dateien und Zustände sind dieselben wie beim Host-Updater (10.3 bis 10.5), ebenso die Sperre `lock/`; beide schließen sich gegenseitig aus.

- **Anlegen:** einmal als root, auf DSM über den Aufgabenplaner (Benutzerdefiniertes Skript, „Ausführen", danach die Aufgabe löschen), weil die Oberfläche von DSM 6.2 `docker.sock` nicht einbinden kann. Den Befehl liefert der Server fertig in `UpdateStatus.updater_command`:

  ```
  /usr/local/bin/docker rm -f stowly-updater; /usr/local/bin/docker run -d --name stowly-updater --restart unless-stopped --user 0:0 --network none --read-only --tmpfs /tmp --no-healthcheck -v /var/run/docker.sock:/var/run/docker.sock --volumes-from <Container-ID> <STOWLY_IMAGE_REF>:<Tag> python -m stowly.updater
  ```

  - Die Container-ID liest der Server aus `/proc/self/mountinfo` (`/containers/<64 hex>/`). Der Hostname taugt nicht dafür: DSM setzt ihn auf den Namen des Containers.
  - Das Tag kommt aus `STOWLY_IMAGE_TAG`. Eine Vorabversion meldet sich mit der Nummer der fertigen Version (`0.3.0`), liegt aber unter `:0.3.0-rc.4`; ein Image `:0.3.0` gibt es zu der Zeit noch nicht. Bis 0.3.0 nannte der Befehl deshalb bei Vorabversionen ein Image, das Docker nicht fand.
  - `--user 0:0`, weil der Socket nur root offensteht; `--network none`, weil Docker selbst das Image lädt; `--no-healthcheck`, weil der Healthcheck des Images den Port 8010 fragt.
  - Keine Optionen zum Log: Es gilt der Log-Treiber des Rechners, auf DSM `db`, der Optionen wie `max-size` womöglich ablehnt. Der Updater schreibt nur bei Updates und Fehlern ins Log, nicht bei jedem Herzschlag. So erscheinen seine Meldungen in DSM unter Container → `stowly-updater` → Protokoll.
  - **Journal und Aufräumen:** Während eines Updates liegt `update/journal` mit der eigenen ID des Updaters; der alte Container heißt so lange `<name>-vorher`. Bleibt nach einem Absturz einer übrig, räumt der Updater ihn beim nächsten Lauf auf.
  - **Sperre eines anderen Updaters:** Bis 0.5.0 wartete ein Updater, der eine fremde Sperre fand, immer, bis sie 30 Minuten alt war. Seit 0.5.1 fragt er Docker nach dem Updater-Container aus dem Journal:
    - **Übernahme:** Kennt Docker ihn seit einer Minute nicht mehr (`OWNER_GONE_S`; `GET /containers/<id>/json` antwortet 404, etwa nach `docker rm -f` beim Erneuern), übernimmt der Updater die Sperre. Er legt sie neu an und läuft dann wieder an wie nach einem Absturz.
    - **Warum eine Minute:** Einen Aufruf, den Docker schon angenommen hat, führt es auch nach dem Löschen des Aufrufers zu Ende, etwa `stop` mit seiner Frist von 15 Sekunden. Ohne die Karenz sähe der Wiederanlauf womöglich Stowly noch laufen, das gleich darauf steht. Die Minute gilt auch für eine Sperre, die schon älter als 30 Minuten ist.
    - **Nie:** einem Besitzer, der läuft, neu startet, pausiert oder gerade gelöscht wird, auch nicht über die 30-Minuten-Regel.
    - **Nach 30 Minuten:** wenn der Besitzer unbekannt ist (kein Journal, weil der Updater beim Laden des Images starb; keine gültige ID; Docker antwortet nicht) oder sein Container angehalten ist. Die alte Version läuft in der Zeit unverändert weiter.
    - **Eintrag ins Journal:** Wer die Sperre für einen Wiederanlauf nimmt, ob frisch, eigene, alte oder übernommene, liest das Journal neu und trägt seine ID ein. So nennt es den, der die Sperre hält. Findet er dabei schon einen anderen Updater im Journal als erwartet, hält er sich heraus und lässt die Sperre liegen.
    - **Ohne eigene Container-ID** (`/proc/self/mountinfo` verrät sie nicht) führt ein Updater kein abgebrochenes Update weiter. Er könnte das Journal nicht prüfen und verwürfe das Update; das Log nennt es, und ein Updater mit ID bringt es zu Ende.
  - **Wiederanlauf nach `stopping`:** Läuft der alte Container noch, sieht der Updater bis zu 45 Sekunden nach (`STOP_SETTLE_S`), ob ein noch laufendes `stop` ihn anhält. Das kommt vor, wenn der Updater mitten im Anhalten starb, neu startete oder gelöscht wurde. Hält Stowly an, startet er es wieder; sonst meldet er, dass die alte Version weiterläuft.
  - **Grenzen:** Engine API 1.40 bis 1.44, nur öffentliche Images (der Updater meldet sich bei keiner Registry an).
  - **Erneuern:** Erneut ausführen erneuert den Updater, etwa wenn die App meldet, dass er älter ist als der Server. Das gilt erst nach dem Ende eines Updates, denn der Befehl löscht den laufenden Updater mitten in seiner Arbeit. Die App zeigt den Befehl deshalb nicht, solange ein Update läuft und der Updater sich meldet. Ein Update läuft, wenn `state` `requested` oder `installing` ist, höchstens eine Stunde lang. Gemessen wird nur mit Zeiten des NAS, von `state_at` bis `updater_seen_at`; die Uhr des Geräts kann falsch gehen.
    - **Nach einer Stunde** zeigt sie den Befehl wieder, auch bei einem aktuellen Updater, mit dem Rat, zuerst `update/log` anzusehen. Ein erneuerter Updater übernimmt das Update nach einer Minute.
    - **Ohne Herzschlag** (`updater_ready` falsch) zeigt sie den Befehl mit einer Warnung, denn ein großes Image kann länger laden, als der Herzschlag frisch bleibt.
    - **Während eines Updates** fragt sie alle 10 Sekunden nach.
- **Herzschlag:** alle 15 Sekunden `updater` mit `seen_at`, `updater=2`, `kind=container`, `version` und `target`.
- **Ziel:** der andere Container mit derselben Quelle für `/data` wie der Updater selbst. So übersteht die Zuordnung neue Container-IDs. Trägt das Ziel Labels von Docker Compose (`com.docker.compose.project`), weigert sich der Updater (`failed`: „Dieser Container gehört zu Docker Compose; dafür gibt es updater/stowly-update.sh."). Sonst holte Compose beim nächsten `up` die Version aus der `.env` zurück.
- **Update, Aufruf für Aufruf** (Engine API über `/var/run/docker.sock`, mindestens 1.40; auf DSM 6.2 ist es 1.41):
  1. **Prüfen:** `GET /version`. Die Version aus `request` muss `VERSION_PATTERN` treffen. Aus der Anforderung zählt nur sie; das Repository stammt aus dem laufenden Ziel (`Config.Image` ohne Tag und Digest, sonst `STOWLY_IMAGE_REF`).
  2. **Laden:** `state=installing`, dann `POST /images/create?fromImage=<repo>&tag=<version>`. Den Datenstrom bis zum Ende lesen: Ein `error` darin ist ein Fehlschlag, auch bei HTTP 200. Bis zu drei Versuche, danach `failed`; die alte Version läuft weiter.
  3. **Anhalten:** `POST /containers/<id>/stop?t=15`, dann prüfen, dass er steht.
  4. **Sichern:** die Datenbank samt `-wal` und `-shm` nach `before-<alt>-<zeit>.sqlite3` kopieren (wie 10.6, drei bleiben).
  5. **Umbenennen:** `POST /containers/<id>/rename?name=<name>-vorher`, dazu ein Journal in `update/`, damit ein Absturz mittendrin aufgeräumt werden kann.
  6. **Neu anlegen:** `POST /containers/create?name=<name>` mit dem Klon (unten), weitere Netze per `POST /networks/<n>/connect`.
  7. **Starten und warten:** `POST /containers/<neu>/start`, dann bis zu 180 Sekunden auf `State.Health.Status` `healthy`. `exited`, `dead` oder `unhealthy` gelten als Fehlschlag.
  8. **Erfolg:** den alten Container löschen (`DELETE /containers/<alt>`, nie mit `v=1`, das löschte anonyme Volumes); alte Images derselben Herkunft aufräumen, die neue und die vorige Version bleiben; `done`, `request` löschen.
  9. **Sonst zurück:** das Ende des Logs des neuen Containers in `log`, ihn anhalten und löschen, die Kopie der Datenbank zurückspielen, den alten Container zurückbenennen, starten und warten. Dann `failed` wie beim Host-Updater.
     - **Merker im Journal (seit 0.5.1):** Muss die Datenbank zurück, steht vor dem Löschen des neuen Containers `phase=rollback` im Journal, nach dem Zurückspielen `phase=restored`.
     - **Wiederanlauf bei `rollback`:** Er spielt die Datenbank zurück, auch wenn der neue Container schon weg ist.
     - **Wiederanlauf bei `restored`:** Er startet nur noch den alten Container. Ein zweites Zurückspielen nähme der schon wieder laufenden alten Version ihre neuen Daten.
     - **Nie unter einem laufenden Stowly:** Läuft der alte Container vor dem Zurückspielen, hält der Updater ihn erst an.
     - **In den übrigen Schritten nach dem Sichern** (`renaming` bis `starting`) spielt der Wiederanlauf zurück, sobald der alte Container nicht läuft. So zählt auch ein `start` der neuen Version, der beim Absturz noch unterwegs war. Bis 0.5.0 lief die alte Version in diesen Fällen auf der Datenbank der neuen und startete bei neuerem Schema gar nicht.
     - **Alte Version lief seit der Sicherung:** Wurde der alte Container nach der Sicherung gestartet (`State.StartedAt` später als die Zeit im Namen der Sicherung), hat sie womöglich neue Daten. Das kommt vor, wenn ihn jemand von Hand startete oder Docker ihn nach einem Neustart des NAS per Neustart-Regel startete. Dann probiert sie zuerst die jetzige Datenbank: Wird sie damit healthy, bleibt diese, mit ihren neuen Daten und, ohne Schemawechsel, auch mit dem, was die gescheiterte neue Version kurz geschrieben hat. Nur sonst (die neue Version hatte schon migriert, die alte verweigert den Start) wird angehalten und zurückgespielt.
     - **Umkehrbar:** Vor jedem Zurückspielen kommt die jetzige Datenbank samt `-wal` und `-shm` als `replaced-<zeit>.sqlite3` nach `update/`; die drei neuesten bleiben, das Log nennt den Namen.
     - **Fehlt der alte Container**, ist der neue der einzige. Der Updater löscht ihn dann nie, sondern startet ihn und wartet auf healthy.
- **Klonregeln** (wie bei watchtower): Aus `Config` bleibt nur, was vom **alten Image** abweicht: `Env` je Variable, `Labels` je Schlüssel, `ExposedPorts`, `Volumes`, `Cmd`, `Entrypoint`, `Healthcheck`, `User`, `WorkingDir`, `StopSignal`. Die Oberfläche von DSM schreibt alle Umgebungsvariablen des Images in den Container; ohne diese Regel klebten sie am alten Image. `Hostname` bleibt, außer er ist die alte Kurz-ID. `HostConfig` wird unverändert übernommen (bei DSM auch der Log-Treiber `db` und `CpuShares`), Netze nur mit `IPAMConfig`, `Aliases`, `Links` und `DriverOpts`. Anonyme Volumes aus `Mounts` kommen als `<Name>:<Ziel>` in `Binds`, sonst startete der neue Container mit leerem `/data`.
- **Sicherheit:** root mit Socket heißt root auf dem Rechner, wie beim Host-Updater. Der Updater hat kein Netz, liest aus `request` nur die Versionsnummer, spricht nur sein Ziel an und folgt in `/data/update` keinem Symlink (10.6).
  - **Journal:** Er nimmt `update/journal` nur an, wenn root es geschrieben hat (Eigentümer 0, genau ein Link). Bevor er mit einem Wert daraus Docker anspricht, prüft er ihn: Jeder Container darin hat dieselbe Quelle für `/data` wie der Updater und ist nicht er selbst; das Repository ist das des Ziels bzw. `STOWLY_IMAGE_REF`; die Sicherung hat die Form `before-<version>-<zeit>.sqlite3`. Sonst `failed`, ohne Docker-Aufruf. Ein übernommener Server kann so keinen fremden Container anfassen.
  - **Kein Downgrade:** Eine Version, die nicht neuer ist als die laufende (Label `org.opencontainers.image.version`, sonst der Tag), lehnt er ab. Das gilt auch für den Host-Updater.
  - **Kopien** der Datenbank bekommen nur Lese- und Schreibrechte, nie setuid, setgid oder sticky.
- **Kein Selbst-Update:** Der Updater bleibt auf der Version, mit der er angelegt wurde. Ist `updater_version` älter als der Server, rät die App, den Befehl erneut auszuführen.

## 11. HTTPS mit eigener CA

Stowly kann HTTPS selbst bereitstellen, ohne Reverse Proxy: mit einer eigenen Zertifizierungsstelle (CA), der jedes Gerät einmal vertraut, und einem zweiten Listener im selben Prozess. Ein Reverse Proxy davor geht weiter; dann bleibt der HTTPS-Listener ungenutzt.

### 11.1 Dateien

Alles liegt in `/data/tls` (Rechte 0700), nicht in der Datenbank und damit in keiner Sicherung.

| Datei | Rechte | Inhalt |
|---|---|---|
| `ca.crt` | 0644 | Zertifikat der CA (PEM) |
| `ca.key` | 0600 | Schlüssel der CA (PEM, unverschlüsselt) |
| `server.pem` | 0600 | Schlüssel und Zertifikat des HTTPS-Listeners in einer Datei, damit beides zusammen wechselt |

- Geschrieben wird über eine Zwischendatei mit `fsync` und `os.replace`. Das Log nennt Fingerabdrücke, nie einen Schlüssel.
- **Beim Start:** Liegen `ca.crt` und `ca.key` da, lädt Stowly sie, wenn sie taugen: selbst signiert, CA mit `keyCertSign`, Schlüssel passt und ist unverschlüsselt, P-256, P-384 oder RSA ab 2048 Bit, noch mindestens 30 Tage gültig. So lässt sich auch eine vorhandene CA von Hand hineinlegen. Fehlt nur eine der beiden Dateien oder taugt eine nicht, meldet Stowly das (`HttpsStatus.problem`, auch ohne HTTPS-Listener) und überschreibt nichts. Fehlen beide, erzeugt Stowly eine neue CA.
- **Die CA entsteht immer**, auch ohne `STOWLY_HTTPS_PORT`: Das Koppeln eines Pi braucht sie auch hinter einem Reverse Proxy. Zertifikat des Servers und täglicher Job gibt es nur mit HTTPS-Listener.
- `CaInfo.created_by_stowly` erkennt Stowly am Namen „Stowly CA <6 Hex>".
- **Sicherungen** enthalten `/data/tls` nicht. Wer umzieht, nimmt das Volume mit; sonst entsteht eine neue CA, und jedes Gerät muss neu vertrauen.

### 11.2 Zertifikate

- **Neue CA:** P-256, 10 Jahre, Name „Stowly CA <6 Hex>", `basicConstraints` CA mit `pathlen` 0 (kritisch), `keyUsage` `keyCertSign` und `cRLSign` (kritisch), SKI.
  - **Name Constraints** (nicht kritisch markiert, damit Geräte ohne Unterstützung nicht ablehnen): erlaubt sind nur die Netze und Namen aus 11.3 sowie Loopback und `localhost`. Ein gestohlener Schlüssel taugt so nicht für fremde Seiten. Chrome, Edge, Firefox und OpenSSL werten sie aus, iOS und macOS nach Prüfliste, Android wohl nicht (dort kein Schutz, aber auch kein Schaden).
- **Zertifikat des Servers:** P-256, `SERVER_CERT_DAYS` (397) Tage, nie über das Ende der CA hinaus, `notBefore` eine Stunde zurück. CN „Stowly" (kein Name), SAN = die Adressen (11.3), EKU `serverAuth`, `keyUsage` `digitalSignature`, CA:false, SKI und AKI.
  - Neu ausgestellt bei geänderten Adressen, gewechselter CA oder weniger als `SERVER_CERT_RENEW_DAYS` (60) Tagen Rest; das prüft auch der tägliche Job `tls_renew` (in `job_runs`, Zustand `renewed` und `not_after`). Ohne bekannte Adresse gilt es vorläufig für `localhost` und `127.0.0.1`, damit der Listener immer starten kann; sobald eine Adresse bekannt ist, fallen diese beiden weg.
- **Zertifikat eines Pi:** `PI_CERT_DAYS` (825) Tage, CN „Stowly Drucker", bei einem RSA-Schlüssel zusätzlich `keyEncipherment`, sonst wie oben ([`sync-protokoll.md`](sync-protokoll.md), 11.8).

### 11.3 Adressen

- **Gelernt** aus der Kopfzeile `Host`: beim Setzen des ersten Passworts und bei jedem angemeldeten Aufruf unter `/api/setup`. Von Hand dazu: `PATCH /api/setup` mit `addresses`. Höchstens 10; gelernt wird nie etwas entfernt.
- **Erlaubt:** private Netze `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10` (Tailscale), `fc00::/7`; Namen mit einer der Endungen `local`, `lan`, `home`, `home.arpa`, `internal`, `localdomain`, `fritz.box`. Für das erste Passwort zählen auch Loopback und einteilige Namen (`diskstation`); ins Zertifikat kommt nur, was die CA deckt.
- **Port:** Der externe HTTPS-Port kommt aus `Host` der ersten angemeldeten Anfrage über den HTTPS-Listener (bis dahin `HTTPS_PORT_DEFAULT`, 8443), solange er nicht von Hand gesetzt ist. Ebenso lernt der Server aus Anfragen über HTTP den externen HTTP-Port, für den Download der CA und den Befehl für den Pi.
- **Ursprünge der App** (`HttpsStatus.origins`): je Adresse `https://<adresse>:<port>`, dazu die gesehenen HTTPS-Ursprünge aus `Origin` angemeldeter Änderungen (geprüft wie bei Push, 4), höchstens 20. Daraus entstehen die erlaubten Ursprünge eines Pi.

### 11.4 Der HTTPS-Listener

- Zwei `uvicorn.Server` in einer Ereignisschleife, dieselbe App: HTTP auf `STOWLY_PORT` (8010), HTTPS auf `STOWLY_HTTPS_PORT` (im Image 8443; ohne die Variable kein HTTPS, auch in Tests und beim Entwickeln). Beide mit `lifespan` aus und ohne Proxy-Kopfzeilen; der Lebenszyklus der App umschließt beide, damit die Dienste stehen, bevor ein Port aufgeht, und erst nach beiden enden.
- **Start:** erst HTTP; scheitert es, endet der Prozess mit Exit-Code 3. Dann HTTPS; scheitert es, läuft HTTP weiter, und `HttpsStatus.problem` sagt warum: „Der Port 8443 ist belegt oder nicht erlaubt (Einzelheiten im Log)." bzw. das Problem der CA. Die genaue Ursache eines belegten Ports schreibt uvicorn nur ins Log.
- **Vorher** prüft Stowly, ob es in `/data` schreiben darf. Wenn nicht, startet statt der App eine Hilfeseite auf dem HTTP-Port ([`betrieb.md`](betrieb.md), 19.1).
- **Signale:** Stowly fängt sie selbst und beendet beide Listener; `release_waiting` läuft vor dem Abbau (Nachschlagen mit Wartezeit).
- **Neues Zertifikat ohne Neustart:** `load_cert_chain` auf demselben SSL-Kontext, nur in der Ereignisschleife und erst, nachdem ein Probe-Kontext die Datei geladen hat. Laufende Verbindungen behalten das alte Zertifikat.
- **Kein HSTS:** Bei einer IP-Adresse wirkte es nicht, bei einem Namen träfe es auch Port 8010 und andere Dienste unter demselben Namen. Der Healthcheck des Containers bleibt auf HTTP.
- **Über welchen Listener eine Anfrage kam:** `scope["scheme"] == "https"`; deshalb wertet kein Listener `X-Forwarded-Proto` aus.

### 11.5 Vertrauen auf den Geräten

Die App führt im Assistenten durch die Schritte je Plattform; die CA kommt über `GET /api/setup/ca.crt` ([`sync-protokoll.md`](sync-protokoll.md), 11.6). Ob ein Gerät vertraut, prüft die App über `http` mit einem Abruf `fetch(https://…/api/health, { mode: "no-cors" })`: Er scheitert genau dann, wenn Vertrauen oder Port fehlen. Wechselt ein Gerät danach auf die HTTPS-Adresse, meldet es sich dort einmal neu an; jede Adresse hat ihren eigenen Speicher im Browser ([`betrieb.md`](betrieb.md), 6).

## 12. Einstellungen aus der App

Was früher nur in der Umgebung stand, geht seit 0.3.0 auch in der App (`GET` und `PATCH /api/server-config`, [`sync-protokoll.md`](sync-protokoll.md), 11.7). Die Umgebung geht vor: Ein Wert aus `.env` oder aus den Einstellungen des Containers ist in der App nur zu sehen (`source: env`, `PATCH` antwortet 409).

| Einstellung | Wirksam ist | Gelesen |
|---|---|---|
| Haushalts-Passwort | `STOWLY_PASSWORD` (beim Start als Hash übernommen), sonst der Hash aus der App | bei jeder Anmeldung |
| Kontakt für die Push-Dienste | `STOWLY_PUSH_CONTACT`, sonst der Kontakt aus der App, sonst keiner | bei jeder Zustellung, in der Tagesnachricht und vor jedem Aufruf unter `/api/push` |
| Updates | `STOWLY_UPDATE_REPO` (immer an), sonst der Schalter in der App mit `STOWLY_UPDATE_REPO_DEFAULT`, sonst aus | vor jeder Abfrage bei GitHub |
| Sicherung: öffentliche Schlüssel (seit 0.4.0, 3.1) | `STOWLY_BACKUP_RECIPIENTS`, sonst die Liste aus der App (höchstens 10; Hinzufügen nur mit dem Haushalts-Passwort, Entfernen ohne), sonst keine | bei jedem Takt des Zeitplans und vor jedem „Jetzt sichern" |
| Sicherung: an oder aus | fest an mit Schlüsseln aus der Umgebung, sonst der Schalter in der App, sonst an | ebenso |
| Sicherung: Uhrzeit | `STOWLY_BACKUP_TIME`, sonst die Uhrzeit aus der App, sonst `03:30` | ebenso |
| Sicherung: Ordner (3.5) | `STOWLY_BACKUP_DIR`, sonst `/backups` (eingebunden und beschreibbar), sonst `/data/backups`; in der App nur zu sehen | ebenso, dazu bei jeder Anfrage nach dem Zustand |
| Home Assistant: Adresse, Token und Liste (seit 0.4.0, 5.1) | als Gruppe: aus der Umgebung, sobald eine der drei Variablen gesetzt ist, sonst aus der App | vor jedem Lauf des Abgleichs und bei jeder Prüfung |
| Sensor-Token (6) | `STOWLY_HA_SUMMARY_TOKEN`, sonst der Token aus der App | bei jeder Anfrage des Sensors |
| Zertifizierungsstelle für HA | nur `STOWLY_HA_CA` | beim Start |
| Port des HTTPS-Listeners | nur `STOWLY_HTTPS_PORT` | beim Start |
| Adressen, externe Ports, Fortschritt des Assistenten | nur App oder gelernt | bei Gebrauch |

- **Ohne Neustart:** Versand von Push, Tagesnachricht, Abfrage bei GitHub, Sicherung und Abgleich mit HA laufen immer und lesen den wirksamen Wert erst beim Einsatz; der Sensor bei jeder Anfrage. Wird der Schalter für Updates eingeschaltet, kommt die erste Abfrage nach `UPDATE_CHECK_FIRST_S` (60) Sekunden. Eine Änderung der Sicherung weckt den Zeitplan, eine von HA den Abgleich.
- **Gespeichert** in `server_config`, je Schlüssel ein JSON-Wert mit Zeitpunkt und Gerät. Dort steht nie ein Geheimnis; die Tabelle ist in jeder Sicherung. Schlüssel aus der App: `push_contact`, `update_enabled`, `backup_enabled`, `backup_time`, `backup_recipients` (je `{key, added_at}`), `ha_url`, `ha_todo_entity`; dazu Merker ohne Geheimnis: `ha_token_set_at`, `ha_sensor_set_at` und `ha_links_entity` (5.4, vom Server selbst geschrieben).
- **Tokens aus der App** (HA und Sensor) stehen nicht in `server_config`, sondern in `/data/secrets` (5.1), den keine Sicherung enthält. Wer umzieht, nimmt den Datenordner mit; sonst sind sie neu einzutragen, und der Zustand sagt es.
