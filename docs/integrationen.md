# Integrationen

Verbindlicher Vertrag für alles, was der Server in Stufe 2 neben dem Sync tut: Zeitplan, Zeit, Sicherungen, Push, Home Assistant mit Bring!, der Sensor für Home Assistant, die Umgebungsvariablen und der Zustand, den die App davon zeigt. Er ergänzt [`sync-protokoll.md`](sync-protokoll.md); Datentypen und Endpunkte stehen dort (Abschnitt 11) und als Code in `server/stowly/contract/api.py`.

Was sich nur an einem echten Home Assistant klären lässt, ist mit **„klärt die Probe mit dem Anwender"** markiert und in Abschnitt 9 gesammelt. Bis dahin gilt die beschriebene, vorsichtige Auslegung.

## 1. Zeitplan

Eine Schleife im Server, nach dem Muster von `server/stowly/off.py`: eine asyncio-Aufgabe im `lifespan` der App, eine eingereichte Uhr für Tests (`now()`, `monotonic()`, `sleep()` wie `off.Clock`) und `wake()`. Keine neue Bibliothek.

### 1.1 Takt

- Die Schleife prüft **jede Minute** (zur vollen Minute der Serveruhr), dazu sofort nach dem Start und nach `wake()`.
- Aufgaben: `backup` (Abschnitt 3) und `push_daily` (Abschnitt 4.8), in dieser Reihenfolge. Je Aufgabe läuft höchstens ein Lauf zugleich.
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
- **„Heute" im Server** ist der Kalendertag in `STOWLY_TIMEZONE`. Er gilt für den Sensor (6), die Tagesnachricht (4.8), die Monate der Statistik (`sync-protokoll.md`, 11.1), die Dateinamen der Sicherungen (3.3), `job_runs.last_date` und den Dateinamen der Sicherung zum Herunterladen (`stowly-JJJJ-MM-TT.sqlite3`).
- Zeitstempel bleiben UTC (`sync-protokoll.md`, Abschnitt 4). Uhrzeiten (`notify_time`, `STOWLY_BACKUP_TIME`) sind Ortszeit in `STOWLY_TIMEZONE`, nie in der Zeitzone eines Geräts. Die App zeigt die Zeitzone des Servers dazu (`IntegrationStatus.timezone`), wenn sie von der des Geräts abweicht.

## 3. Sicherungen

Täglich eine verschlüsselte Kopie der Datenbank in einen Ordner auf dem Server. Die Sicherung zum Herunterladen (`GET /api/backup`) bleibt daneben bestehen.

### 3.1 Einrichten

| Variable | Bedeutung |
|---|---|
| `STOWLY_BACKUP_DIR` | Ordner für die Sicherungen, absoluter Pfad (im Container etwa `/backups`, von Compose auf `./backups` gelegt) |
| `STOWLY_BACKUP_RECIPIENTS` | öffentliche age-Schlüssel (`age1…`, erzeugt mit `age-keygen`), durch Komma oder Leerraum getrennt; mehrere sind empfohlen |
| `STOWLY_BACKUP_TIME` | Uhrzeit `HH:MM`, Vorgabe `03:30` |

- Beide, Ordner und Empfänger, gesetzt: Die Sicherung ist eingerichtet.
- Keines von beiden: keine automatische Sicherung, ohne Hinweis.
- Nur eines: keine automatische Sicherung; der Server startet, schreibt eine Warnung ins Log, und der Zustand nennt den Grund (`problem`, etwa „STOWLY_BACKUP_RECIPIENTS fehlt").
- Ein Empfänger, der kein gültiger öffentlicher age-Schlüssel (X25519, `age1…`) ist, eine ungültige Uhrzeit oder ein relativer Ordner: Konfigurationsfehler beim Start (Exit-Code 2). Der Server kennt nur öffentliche Schlüssel; wer Server und Ordner erbeutet, kann die Sicherungen nicht lesen.

### 3.2 Ablauf

1. **Kopie:** ein in sich stimmiger Schnappschuss wie bei `GET /api/backup` (`sqlite3.Connection.backup`), aber in eine Datenbank im Arbeitsspeicher (`:memory:`). Die Kopie bekommt eine neue `dataset_id` (`sync-protokoll.md`, 6.4), `PRAGMA integrity_check` muss `ok` liefern, dann `serialize()`. Unverschlüsselt berührt die Kopie nie die Platte. Wie der Download ist sie eine einzelne Datei ohne WAL (`journal_mode` `delete`): Nach dem Entschlüsseln genügt diese eine Datei; der Server stellt beim Öffnen selbst wieder auf WAL.
2. **Packen:** gzip (`gzip.compress(…, mtime=0)`).
3. **Verschlüsseln:** age, an alle Empfänger aus `STOWLY_BACKUP_RECIPIENTS` zugleich, mit `pyrage` (`pyrage.encrypt` mit `pyrage.x25519.Recipient`), im binären Format von age (nicht ASCII-Armor). Jeder der privaten Schlüssel kann die Datei allein entschlüsseln.
4. **Schreiben:** in eine Zwischendatei im Ordner, `.stowly-backup-<16 Hex-Zeichen>.tmp`, angelegt mit `O_CREAT | O_EXCL` und Rechten `0600`; schreiben, `flush`, `os.fsync`, schließen. In ihr steht von Anfang an nur Verschlüsseltes.
5. **Umbenennen:** `os.replace` auf den endgültigen Namen (3.3), danach unter Linux `fsync` des Ordners.
6. **Aufräumen:** Rotation (3.4).
7. **Merken:** `job_runs` (`backup`): `last_date`, `last_at`, `last_error = null`, `state = {"file", "size", "recipients"}` (Größe in Byte, Empfänger gekürzt wie in 3.6).

Scheitert ein Schritt, löscht der Server seine Zwischendatei, vermerkt den Fehler (`last_error` als kurzer deutscher Satz ohne Geheimnisse, `last_error_at`), schreibt ihn ins Log und versucht es **eine Stunde später** erneut, so lange, bis eine Sicherung des Tages gelingt. Liegengebliebene eigene Zwischendateien (Muster oben) löscht jeder Lauf vorab.

### 3.3 Dateiname

`stowly-YYYY-MM-DD-HHMM.sqlite3.gz.age`, Tag und Uhrzeit des Laufs in `STOWLY_TIMEZONE`, etwa `stowly-2026-11-14-0330.sqlite3.gz.age`. Eigene Dateien erkennt der Server ausschließlich an diesem Muster:

```
^stowly-([0-9]{4})-([0-9]{2})-([0-9]{2})-([0-9]{4})\.sqlite3\.gz\.age$
```

Gibt es den Namen schon (zwei Läufe in derselben Minute), ersetzt die neue Datei die alte.

### 3.4 Rotation 7/4/12

- Nur **nach einer gelungenen Sicherung**, und nur unter den **eigenen Dateien** (Muster aus 3.3). Andere Dateien im Ordner fasst der Server nie an.
- Grundlage ist das Datum im Dateinamen, nicht das Änderungsdatum der Datei.
- Behalten wird, vereinigt:
  - die neueste Datei jedes der **7** neuesten Tage, an denen es eine Sicherung gibt,
  - die neueste Datei jeder der **4** neuesten ISO-Wochen (`date.isocalendar()`), in denen es eine gibt,
  - die neueste Datei jedes der **12** neuesten Monate, in denen es eine gibt.
- Alle übrigen eigenen Dateien werden gelöscht. Die eben geschriebene ist immer die neueste und bleibt.

So bleiben auch nach einem langen Ausfall die letzten Sicherungen erhalten: Gezählt werden Tage, Wochen und Monate *mit* Sicherung.

### 3.5 Ordner und Rechte

- Der Container läuft als Benutzer mit uid 10001 (Dockerfile). Der Ordner muss ihm gehören oder für ihn beschreibbar sein: `sudo chown 10001:10001 ./backups`. Die Dateien bekommen `0600`.
- Fehlt der Ordner, legt der Server ihn **nicht** an (er läge sonst womöglich im Container statt auf dem eingebundenen Laufwerk); der Zustand meldet „Der Ordner für Sicherungen fehlt." Ist er nicht beschreibbar: „Der Ordner für Sicherungen ist nicht beschreibbar (Benutzer 10001)." Beides steht als `last_error` des Versuchs im Zustand, nicht als `problem` (eingerichtet ist die Sicherung ja), und beim Start zusätzlich als Warnung im Log.
- Ein Ordner auf derselben Platte ersetzt keine Kopie außer Haus; `docs/betrieb.md` sagt das.

### 3.6 Zustand für die App

`IntegrationStatus.backup` (Abschnitt 8):

- `recipients`: die öffentlichen Schlüssel gekürzt auf die ersten 8 Zeichen, „…" und die letzten 4, etwa `age1ql3z…ac8p`.
- `last_ok_at`, `last_file`, `last_size`: aus `job_runs.state` der letzten gelungenen Sicherung.
- `last_error`, `last_error_at`: der letzte Fehlschlag, `null` nach einem Erfolg.
- `next_at`: der nächste geplante Versuch in UTC: heute zur Uhrzeit, wenn sie noch kommt und heute noch nichts lief; nach einem Fehler `last_error_at` plus eine Stunde; sonst morgen zur Uhrzeit (über die Zeitumstellung richtig umgerechnet). `null`, wenn nicht eingerichtet. Maßgeblich ist die Regel „fällig" (1.2): Ist ein Versuch schon jetzt fällig (etwa nach einem Ausfall), ist `next_at` jetzt; ein Fehler kurz vor Mitternacht ergibt die Uhrzeit des nächsten Tages, nicht „eine Stunde später". Liegt `last_error_at` in der Zukunft (Uhr zurückgestellt), wartet die Sicherung nicht darauf.
- **`warning`** (die App warnt): eingerichtet, und entweder liegt die letzte gelungene Sicherung mehr als **48 Stunden** zurück, oder es gab noch keine und der letzte Versuch ist gescheitert.

### 3.7 Zurückspielen

1. Vorab, einmal nach dem Einrichten und dann ab und zu: **Probe-Entschlüsselung** mit jedem privaten Schlüssel: `age -d -i schluessel.txt stowly-….sqlite3.gz.age | gunzip | head -c 15` muss `SQLite format 3` zeigen.
2. Zurückspielen: `age -d -i schluessel.txt stowly-2026-11-14-0330.sqlite3.gz.age | gunzip > stowly.sqlite3`, danach wie bisher `docs/betrieb.md`, Abschnitt 8 (Container anhalten, Datei ersetzen, `-wal` und `-shm` entfernen, starten).
3. Die Kopie trägt eine neue `dataset_id`: Alle Geräte holen den Bestand vollständig neu und senden ihre Outbox erneut. Der VAPID-Schlüssel (4.1) kommt mit; Push-Abos, die nach der Sicherung entstanden sind, fehlen, und die App meldet sich beim nächsten Start neu an.

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

`POST /api/push/test` (`sync-protokoll.md`, 11.3): Titel „Testnachricht", Rumpf „Benachrichtigungen kommen auf diesem Gerät an.", `tag` `stowly-test`, `navigate` `<origin>/einstellungen`, Kopfzeilen nach 4.6. Die Antwort (`PushTestResult`) nennt das Ergebnis nach 4.7, den Status des Push-Dienstes und einen deutschen Satz, etwa „Der Push-Dienst hat die Nachricht angenommen." oder „Der Push-Dienst lehnt ab (403). Stimmt STOWLY_PUSH_CONTACT?".

### 4.10 Ende eines Abos

- Wird ein Gerät gesperrt oder meldet es sich ab (`DELETE /api/devices/{id}`, `POST /api/auth/logout`), löscht der Server sein Abo in derselben Transaktion.
- Die App beendet beim Abmelden und beim Ausschalten das Abo auch im Browser (`PushSubscription.unsubscribe`).
- 404 und 410 eines Push-Dienstes löschen das Abo (4.7).

## 5. Home Assistant und Bring!

Die Einkaufsliste von Stowly erscheint über eine To-do-Liste von Home Assistant (HA) in Bring!. Stowly speichert dafür nur einen Token von HA, nie Zugangsdaten für Bring!. Ohne HA funktioniert die Einkaufsliste genauso, nur ohne Bring!.

### 5.1 Einrichten

| Variable | Bedeutung |
|---|---|
| `STOWLY_HA_URL` | Adresse von HA, etwa `https://192.168.1.20:8123` oder `http://192.168.1.20:8123`; ohne Pfad (ein `/` am Ende fällt weg). Namen auf `.local` lösen im Container nicht auf: IP-Adresse oder einen Namen aus dem eigenen DNS nehmen. |
| `STOWLY_HA_TOKEN` | langlebiger Zugangs-Token aus HA (Profil, „Sicherheit"), am besten von einem eigenen HA-Benutzer nur für Stowly |
| `STOWLY_HA_TODO_ENTITY` | die To-do-Liste, die mit Bring! verbunden ist, etwa `todo.zuhause` |
| `STOWLY_HA_CA` | freiwillig: Pfad zu einer PEM-Datei mit der eigenen Zertifizierungsstelle, wenn HA per https mit eigenem Zertifikat läuft |

- Alle drei von URL, Token und Liste gesetzt: eingerichtet. Keines: aus, ohne Hinweis. Nur ein Teil: aus, der Zustand nennt den Grund (`problem`).
- Beim Start geprüft: URL absolut mit `http` oder `https`, ohne Pfad, Abfrage und Benutzerangabe; Liste nach dem Muster `^todo\.[a-z0-9_]+$`; die CA-Datei ist lesbar und lässt sich als PEM laden. Sonst Konfigurationsfehler.
- **Der Token** steht nur in der `.env`: nie in der Datenbank, einer Sicherung, dem Log, dem Ereignisprotokoll oder einer Antwort. Fehlermeldungen nennen Status und Pfad, nie Kopfzeilen.

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

### 5.4 Abgleich

Eine eigene Schleife im Server nach dem Muster von `off.py` (Aufgabe `stowly-ha`, eingereichte Uhr, `wake()`), nur wenn HA eingerichtet ist:

- **Wann:** alle zwei Minuten (`HA_SYNC_INTERVAL_S` = 120); dazu geweckt nach jeder Änderung an der Einkaufsliste (nach dem Sync, wie `off.OffWorker.wake`), frühestens 5 Sekunden nach der letzten solchen Änderung; und zu dem Zeitpunkt, an dem der nächste offene Eintrag zwei Minuten offen ist. Bring! selbst aktualisiert sich in HA etwa alle 90 Sekunden.
- **HTTP:** `httpx2`, `Authorization: Bearer <STOWLY_HA_TOKEN>`, Zeitgrenze 10 Sekunden je Aufruf, keine Weiterleitungen. `STOWLY_HA_CA` gilt, wenn gesetzt, zusätzlich zu den Zertifizierungsstellen des Systems, nicht statt ihrer.

Ein Lauf:

1. **Liste da?** `GET {STOWLY_HA_URL}/api/states/{entity}`. 401: Zustand `unauthorized`, Ende. 404: `not_found`, Ende. Netzfehler, Zeitüberschreitung, Zertifikat: `unreachable`, Ende. 5xx: `error`, Ende. `state` ist `unavailable` oder `unknown`: `unavailable`, Ende. In allen diesen Fällen schreibt der Server nichts und zählt kein Fehlen. (Der Zustand einer To-do-Entität ist sonst die Zahl ihrer offenen Artikel.)
2. **Lesen:** `POST {STOWLY_HA_URL}/api/services/todo/get_items?return_response` mit `{"entity_id": "<entity>", "status": ["needs_action", "completed"]}`. Die Artikel stehen in `service_response["<entity>"]["items"]`, je Artikel `summary`, `uid`, `status` (`needs_action` oder `completed`), `description`. Erwartet ist, dass „zuletzt gekauft" in Bring! als `completed` erscheint (klärt die Probe mit dem Anwender). Fehler wie in Schritt 1; 400 heißt `error` („HA kennt todo.get_items nicht so").
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
| eingerichtet, seit dem Start noch kein Lauf | `pending` | – |
| letzter Lauf gelungen | `ok` | `null` |
| 401 | `unauthorized` | „Home Assistant lehnt den Token ab." |
| 404 der Liste | `not_found` | „Die Liste todo.zuhause gibt es in Home Assistant nicht." |
| Liste `unavailable` oder `unknown` | `unavailable` | „Die Liste ist in Home Assistant gerade nicht verfügbar." |
| Netzfehler, Zeitüberschreitung, Zertifikat | `unreachable` | „Home Assistant ist nicht erreichbar." (beim Zertifikat: „… Zertifikat nicht vertraut, siehe STOWLY_HA_CA.") |
| 5xx, unerwartete Antwort | `error` | „Home Assistant antwortet mit 500." |

Nach einem Fehler kommt der nächste Versuch mit dem normalen Takt. Ins Log schreibt der Server einen Wechsel des Zustands, nicht jeden gescheiterten Lauf. Der Zustand lebt im Arbeitsspeicher und beginnt mit dem Start neu (`pending`); `ha_links` bleibt.

## 6. Sensor für Home Assistant

`GET /api/ha/summary` (`sync-protokoll.md`, 11.2): nur lesend, mit dem Token des Sensors, `Cache-Control: no-store`.

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

Den Token des Sensors erzeugen (etwa `openssl rand -hex 32`), als `STOWLY_HA_SUMMARY_TOKEN` in die `.env` von Stowly und mit `Bearer ` davor in die `secrets.yaml` von HA:

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
| `STOWLY_PASSWORD` | Text | im Entwicklungsmodus `stowly` | – | Server startet, Anmelden geht nicht (503 `not_configured`) |
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
| `STOWLY_BACKUP_DIR` | absoluter Pfad | – | absolut | keine automatische Sicherung (mit Empfängern: Hinweis, 3.1) |
| `STOWLY_BACKUP_RECIPIENTS` | `age1…`, getrennt durch Komma oder Leerraum | – | jeder ein öffentlicher age-Schlüssel (X25519); ein privater (`AGE-SECRET-KEY-…`) beendet den Start mit eigener Meldung, die ihn nicht zitiert | keine automatische Sicherung (mit Ordner: Hinweis) |
| `STOWLY_BACKUP_TIME` | `HH:MM` | `03:30` | Form `HH:MM` | Vorgabe |
| `STOWLY_HA_URL` | `http(s)://Host[:Port]` | – | absolut, ohne Pfad; ein `/` am Ende fällt weg | kein Bring! (mit Token oder Liste: Hinweis) |
| `STOWLY_HA_TOKEN` | Text | – | – | kein Bring! (Hinweis wie oben) |
| `STOWLY_HA_TODO_ENTITY` | `todo.<name>` | – | Muster `^todo\.[a-z0-9_]+$` | kein Bring! (Hinweis wie oben) |
| `STOWLY_HA_CA` | Pfad zu einer PEM-Datei | – | Datei lesbar und als PEM ladbar | Vertrauen des Systems |
| `STOWLY_HA_SUMMARY_TOKEN` | Text, mindestens 32 Zeichen | – | Länge; nur druckbares ASCII ohne Leerraum | kein Sensor (503 `not_configured`) |
| `STOWLY_PUSH_CONTACT` | `mailto:<Adresse>` oder `https://<Host>` | – | Form: `mailto:` mit einer Adresse samt Domäne oder `https://` mit Host, das Schema klein geschrieben, ohne Benutzerangabe | kein Push (503 `not_configured`) |
| `STOWLY_UPDATE_REPO` | `<konto>/<name>` | – | Muster `^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$`, Name nicht `.` oder `..` | keine Abfrage bei GitHub (10.1) |

Ist von Home Assistant nur `STOWLY_HA_CA` gesetzt, gilt das als halbe Einrichtung: `problem` nennt die drei fehlenden Variablen. `STOWLY_HA_SUMMARY_TOKEN` allein gehört nicht dazu: Der Sensor braucht den Abgleich nicht.

Nur für Docker Compose und den Updater, nicht vom Server gelesen: `STOWLY_PUBLISH`, `STOWLY_USB_GID`, `FORWARDED_ALLOW_IPS`, `TZ` (die Zeitzone für Stowly ist `STOWLY_TIMEZONE`), `STOWLY_IMAGE` und `STOWLY_VERSION` (fertiges Image, 10.1), `STOWLY_VOLUME` (Name des Datenvolumes für den Updater, 10.6). `.env.example` nennt jede Variable mit einem kurzen Satz; Beispiele nur mit Platzhaltern (`stowly.example`, `ha.example`, Token als `…`).

## 8. Zustand der Integrationen

`GET /api/integrations` (`sync-protokoll.md`, 11.4) liefert `IntegrationStatus` für die Einstellungen der App:

- **`timezone`:** `STOWLY_TIMEZONE`.
- **`backup`** (`BackupStatus`): wie in 3.6. `configured` und `problem` nach 3.1, `time` aus `STOWLY_BACKUP_TIME`, auch wenn die Sicherung aus ist; `null` nur, wenn sie gar nicht eingerichtet ist.
- **`ha`** (`HaStatus`): `configured` und `problem` nach 5.1; `entity` aus `STOWLY_HA_TODO_ENTITY`; `state`, `last_ok_at`, `last_error`, `last_error_at` nach 5.6; `linked` = offene Einträge mit `bring_key`; `sensor` = `STOWLY_HA_SUMMARY_TOKEN` gesetzt.
- **`push`** (`PushStatus`): `configured` nach 4.1; `problem` ist derzeit immer `null` (ein ungültiger `STOWLY_PUSH_CONTACT` beendet schon den Start); `subscriptions` = Abos im Haushalt; `this_device` = das fragende Gerät hat eines; `last_run_at` = `job_runs.push_daily.last_at`; `last_sent_at` = `state.sent_at`; `last_error` = `job_runs.push_daily.last_error`.
- **`update`** (`UpdateStatus`): nach 10.4.
- **Nie** darin: ein Token, ein privater Schlüssel, die Adresse von HA, `STOWLY_PUSH_CONTACT`, Pfade des Rechners oder das Log des Updaters. Öffentliche age-Schlüssel nur gekürzt.

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

- **`STOWLY_UPDATE_REPO=<konto>/<name>`:** das öffentliche Repository der Releases. Leer heißt keine Abfrage; `update.configured` ist dann `false`, und die App zeigt nur die Version.
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
| `updater` | Updater, bei jedem Lauf | `seen_at=<Zeitpunkt>`, `updater=<Version des Skripts>` |
| `log` | Updater | Ausgabe des letzten Updates, nur zur Fehlersuche auf dem Rechner |
| `before-<alt>-<zeit>.sqlite3` | Updater | Kopie der Datenbank vor dem Update; die drei neuesten bleiben |
| `lock/` | Updater | Sperre während eines Laufs |

### 10.4 Zustand (`UpdateStatus`)

- **`configured`, `repo`:** aus `STOWLY_UPDATE_REPO`.
- **`current`:** `stowly.__version__`.
- **`latest` bis `url`, `checked_at`, `check_error`:** aus `job_runs` (10.2). `checked_at` ist die letzte gelungene Abfrage, auch eine mit 404.
- **`available`:** `latest` ist gesetzt und neuer als `current`. Verglichen werden die drei Zahlen.
- **`updater_seen_at`:** `seen_at` aus `updater`. **`updater_ready`:** höchstens `UPDATER_READY_S` (600) Sekunden alt.
- **`state`:** Die erste passende Regel gilt.
  1. `request` liegt vor, und `state` meldet `installing` für dieselbe Version: `installing`, `state_at` aus `at`.
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

`POST /api/update/install` mit `{"version": "X.Y.Z"}`. Geprüft wird in dieser Reihenfolge:

1. **`STOWLY_UPDATE_REPO` fehlt:** 503 `not_configured` „Updates sind auf diesem Server nicht eingerichtet (STOWLY_UPDATE_REPO)."
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
