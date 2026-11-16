# Stowly – Plan: Einrichtungsassistent, Stufe B

## Kontext

Stufe A läuft seit 0.3.x auf dem NAS des Anwenders: Container per Mausklick, Passwort, HTTPS, Pi, Updates und Push geführt in der App. Zwei Bereiche brauchen weiter die `.env` oder die Kommandozeile:

- **Sicherungen:**
  - Ordner, Schlüssel und Uhrzeit gibt es nur als Umgebungsvariablen, und Stowly liest sie nur beim Start.
  - Die Sicherung zum Herunterladen ist unverschlüsselt; sie enthält auch den Passwort-Hash und den Push-Schlüssel.
  - Zurückspielen geht nur per Anleitung mit `age` und Docker-Befehlen.
- **Home Assistant und Bring!:**
  - Adresse, Token, Liste und Sensor-Token gibt es nur als Umgebungsvariablen.
  - Die Verbindung entsteht nur beim Start.
  - Ein Wechsel der Liste hakt gespiegelte Einträge als eingekauft ab (`docs/betrieb.md` 17.5).

**Ziel:** beides geführt in der App, ohne Neustart, jeder Schritt überspringbar; die Umgebung geht weiter vor. Grundlage ist der Umriss in `docs/plan-einrichtung.md` (Stufe B und „Stufe B nicht verbauen").

## Deine Entscheidungen

- **Ablage:** `/backups`, wenn in DSM ein zweiter Ordner dort eingebunden ist; sonst ohne Zutun `/data/backups`, mit dem Rat, den Ordner zusätzlich wegzukopieren. `STOWLY_BACKUP_DIR` geht vor.
- **Schlüssel im Browser** (aus Stufe A): Das age-Schlüsselpaar entsteht im Browser. Den geheimen Teil zeigt Stowly einmal zum Herunterladen; nur der öffentliche geht an den Server.
- **Zurückspielen in der App:**
  - beim ersten Start: „Aus einer Sicherung wiederherstellen" neben dem ersten Passwort;
  - in den Einstellungen eines laufenden Stowly: mit Passwort und deutlicher Rückfrage.
- **Herunterladen nur verschlüsselt:** „Jetzt sichern" legt eine Sicherung wie die automatische in den Ordner und bietet sie zum Herunterladen an. Die unverschlüsselte fällt weg.
- **Dein NAS:** Home Assistant bleibt in der `.env`; die App zeigt die Werte nur an.

## So sieht es für dich aus

**Assistent**, zwei neue Schritte, beide überspringbar:
Sichere Verbindung → Drucker → **Sicherung** → Updates → Benachrichtigungen → **Home Assistant** → Fertig.

1. **Sicherung:**
   - **„Schlüssel erzeugen":** Der Browser erzeugt das Schlüsselpaar und bietet den geheimen Schlüssel als Datei und zum Kopieren an, mit dem Rat, ihn an zwei Orten aufzuheben (USB-Stick, Passwort-Manager). Erst nach „Ich habe ihn gesichert" geht der öffentliche Schlüssel an Stowly.
   - **Grundeinstellungen:** Uhrzeit (Vorgabe 03:30), Schalter an.
   - **Ordner:** zeigt, wo die Sicherungen landen. Im Datenordner kommt eine kurze Anleitung dazu, wie man in DSM einen zweiten Ordner als `/backups` einbindet oder den Ordner per Hyper Backup oder Cloud Sync wegkopiert.
   - **„Jetzt sichern"** als Probe; **„Schlüssel prüfen":** den gesicherten Schlüssel einfügen, und der Browser sagt, ob er passt.
2. **Home Assistant:**
   - Adresse eingeben und das Token aus dem HA-Profil einfügen.
   - „Verbindung prüfen" zeigt die To-do-Listen von HA zur Auswahl; dann „Speichern".
   - Danach „Sensor-Token erzeugen", mit fertigem YAML für HA zum Kopieren.

**Erster Start auf einem neuen NAS** (Umzug, Plattenausfall):
- „Willkommen bei Stowly" bietet neben dem Passwort „Aus einer Sicherung wiederherstellen".
- Sicherungsdatei und Schlüssel wählen. Stowly zeigt, was drin ist: Stand, Zahl der Produkte und Vorräte.
- Dann das Passwort aus der Sicherung eingeben. Stowly startet neu, und du bist angemeldet.

**Einstellungen:**
- **Sicherung:** Status, Schlüssel, Uhrzeit, Ordner, „Jetzt sichern", die Sicherungen im Ordner zum Herunterladen, „Zurückspielen" und 7 Tage lang „Rückgängig".
- **Home Assistant:** Verbindung, Liste, Sensor.
- Werte aus der Umgebung sind gesperrt und so beschriftet.

## 1. Sicherung

**Einstellungen** (`serverconfig.backup(settings, con)`, wie Push und Updates in Stufe A, je Feld mit Quelle env/app/default)
- **Schlüssel:** `STOWLY_BACKUP_RECIPIENTS` vor der Liste aus der App. Die App erlaubt höchstens 10 öffentliche Schlüssel `age1…`, geprüft mit pyrage. Ein geheimer Schlüssel wird abgelehnt und nie wiederholt. Öffentliche Schlüssel dürfen in `server_config`.
- **Uhrzeit:** `STOWLY_BACKUP_TIME`, sonst der Wert aus der App, sonst 03:30.
- **An/aus:** fest an, wenn die Schlüssel aus der Umgebung kommen; sonst der Schalter.
- **Ordner:** `STOWLY_BACKUP_DIR`; sonst `/backups`, wenn er in `/proc/self/mountinfo` steht und beschreibbar ist; sonst `/data/backups` (0700, legt Stowly an).
  - Das Image setzt dafür keine Variable, sonst übernähme DSM sie als „Umgebung" und sperrte die App.
  - `.env.example` lässt Ordner und Uhrzeit leer.

**Ablauf**
- **Job:** `BackupJob` läuft immer und liest die Einstellungen bei jedem Takt; ohne Schlüssel ruht er. Eine Änderung weckt ihn.
- **Ändern:** `PATCH /api/server-config` bekommt `backup_enabled`, `backup_time` und `backup_recipients`; 409 bei Feldern aus der Umgebung.
- **„Jetzt sichern":** `POST /api/backup/run`, mit demselben Lock wie der Job.
  - 409, wenn schon eine läuft; 429 bei mehr als einer je Minute; 503 ohne Schlüssel.
- **Herunterladen:** `GET /api/backup/files/{name}` liefert nur Dateien von Stowly (`OWN_FILE`), nie andere Pfade. `GET /api/backup` (unverschlüsselt) und `backup.py` fallen weg.
- **Status:** Ordner und Quelle, letzte und nächste Sicherung, Warnung nach 48 Stunden, die Sicherungen im Ordner mit Größe.

**Schlüssel im Browser**
- **Bibliothek:** `@noble/curves` (x25519) und `@scure/base` (bech32). Sie brauchen nur `getRandomValues` und gehen deshalb auch über http.
  - Alles kommt in einen eigenen, nachgeladenen Chunk `features/backup/keys.ts` für Einstellungen und Assistent, schätzungsweise 6–8 kB gepackt.
  - Nicht `age-encryption`: Ohne `crypto.subtle` scheitert es, und es will künftig womöglich Post-Quanten-Schlüssel, die pyrage nicht kennt.
- **Erzeugen:** Der geheime Schlüssel `AGE-SECRET-KEY-1…` lebt nur im Zustand der Seite. Es gibt ihn als Datei im Format von `age-keygen` und zum Kopieren. Den öffentlichen schickt die App erst nach dem Haken.
- **Prüfen:** Aus dem eingefügten Schlüssel errechnet der Browser den öffentlichen (Zeilen mit `#` zählen nicht) und vergleicht ihn mit den gespeicherten.
- **Testvektoren:** Schlüsselpaare von pyrage in `docs/vectors.json`, für Server und App gemeinsam.

## 2. Zurückspielen

**Drei Schritte** (neu `restore.py` und `api/restore.py`, Ordner `/data/restore` 0700, Dateien 0600)
1. **Hochladen:** `PUT /api/restore/upload` nimmt die Rohdaten, höchstens 512 MiB, nur bei mindestens dreifach freiem Platz. Antwort: `upload_id`.
2. **Prüfen:** `POST /api/restore/check {upload_id, identity}`.
   - Stowly erkennt age, gzip oder SQLite.
   - Es entschlüsselt mit pyrage im Speicher; den Schlüssel speichert und loggt es nie.
   - Dann prüft und migriert es die Kopie zu einem fertigen Kandidaten.
   - Antwort: eine Vorschau (Stand, letzte Aktivität, Zahl der Produkte und Vorräte, ob ein Passwort drin ist) und eine `restore_id`, 30 Minuten gültig.
   - Mit einem anderen Schlüssel lässt sich die Prüfung ohne neues Hochladen wiederholen.
3. **Anwenden:** `POST /api/restore/apply {restore_id, password, device_name?}` antwortet 202. Stowly legt den Kandidaten bereit und startet neu.

**Prüfungen**
- Die Kopie wird geöffnet mit `trusted_schema=OFF` und `DBCONFIG_DEFENSIVE`. Dann der Reihe nach:
  1. `quick_check`.
  2. `application_id`: „STOW" oder 0; dafür setzt die neue Migration `0005_application_id.sql` die Kennung.
  3. `user_version` zwischen 1 und N; eine neuere als dieser Stowly gibt 422.
  4. Das Schema muss genau dem aus den Migrationen entsprechen: keine Trigger, keine Views, keine fremden Tabellen.
  5. `integrity_check` und `foreign_key_check`, dann die Migration.
- **Fehler:**
  - 422 mit Grund (`wrong_key`, `not_a_key`, `not_stowly`, `damaged`, `newer_schema`, `migration_failed`) und einem deutschen Satz, nie mit dem Schlüssel;
  - 413, wenn die Datei zu groß ist;
  - 409, wenn schon etwas läuft oder ein Update ansteht (Updater und Zurückspielen schließen sich aus).
- **Bremse:** 429 aus einer eigenen Bremse: eins zugleich, höchstens 6 in 10 Minuten. Passwörter laufen über die Bremse der Anmeldung.

**Neustart und Tausch**
- **Nur in einem frisch gestarteten Prozess,** bevor irgendetwas die Datenbank öffnet. Laufende Anfragen oder eine Sicherung könnten sonst noch Verbindungen halten, und SQLite fände eine alte `-wal`-Datei über den Pfad.
- **Neustart:** Nach der Antwort 202 beendet Stowly beide Listener sauber und ersetzt sich mit `os.execv` selbst. Der Container läuft weiter und braucht die Neustart-Regel von DSM nicht. Unter Windows (Entwicklung) läuft die Schleife im Prozess.
- **Tausch** (`restore.resume()` in `__main__`, vor `create_app()`):
  1. Kandidat prüfen: sha256, `quick_check`, Version.
  2. Die alte Datenbank checkpointen und auf `journal_mode=DELETE` stellen. Das beweist, dass keine Verbindung mehr offen ist.
  3. Zugänge übernehmen (siehe unten), neue `dataset_id`, Ereignis `server.restored`.
  4. Die alte Datenbank wird `previous.sqlite3`, der Kandidat die Datenbank; `-wal` und `-shm` werden entfernt.
- **Nach einem Absturz** lässt sich jeder Schritt wiederholen. Ein Fehler behält die alte Datenbank, meldet `failed` und startet normal weiter, ohne Neustart-Schleife.

**Laufender Stowly**
- **Was aus der laufenden Datenbank bleibt:**
  - Geräte und Passwort-Hash;
  - für Push die VAPID-Schlüssel und die Abos;
  - `server_config` und die Läufe der Jobs.

  So wird niemand abgemeldet, und gesperrte Geräte bleiben gesperrt. Geräte aus einer gefälschten Datei zählen nicht, denn age prüft den Absender nicht.
- **Kennungen:** Pakete, die nach der Sicherung entstanden sind, behalten ihre Kennungen als reserviert. So bekommt kein gedrucktes Etikett eine Kennung ein zweites Mal.
- **Danach:** Alle Geräte laden neu (neue `dataset_id`). `STOWLY_PASSWORD` geht weiter vor.
- **„Rückgängig":** `previous.sqlite3` bleibt 7 Tage und läuft über denselben Tausch zurück; auch das lässt sich wieder umkehren.

**Erster Start**
- **Wann:** nur solange es kein Passwort gibt, mit derselben Host-Regel wie beim ersten Passwort. `POST /api/setup/password` antwortet 409, solange ein Zurückspielen bereitliegt.
- **Passwort:**
  - Enthält die Sicherung ein Passwort, muss man es eingeben. Das zeigt zugleich, dass die Sicherung echt ist.
  - Sonst legt man ein neues fest, und die Geräte aus der Sicherung gelten nicht mehr.
- **Anmelden:** Das neue Gerät entsteht gleich mit. Die App wartet, bis `/api/health` wieder antwortet, und ist dann angemeldet.
- **Sichere Verbindung:** Die CA ist auf einem neuen NAS neu, deshalb beginnt der Schritt „Sichere Verbindung" von vorn.
- Ein Rückgängig gibt es beim ersten Start nicht.

## 3. Home Assistant und Bring!

**Geheimnisse außerhalb der Datenbank** (`secretstore.py`, nicht `secrets.py`, damit die Standardbibliothek nicht verdeckt wird)
- **Ablage:** Ordner `/data/secrets` (0700), Dateien 0600, atomar geschrieben wie `/data/tls`. Das Schreiben wandert aus `tls._write` in ein gemeinsames `safefile.py`.
- **`ha_token.json` `{token, url, set_at}`:** Das Token gilt nur für die Adresse, für die es eingetragen wurde.
- **`ha_sensor_token.json` `{token, set_at}`.**
- **In `server_config`** stehen nur Merker ohne Geheimnis: `ha_token_set_at` und `ha_sensor_set_at`.
- **Nach Zurückspielen oder Umzug** fehlt die Datei, denn sie steht in keiner Sicherung. Der Status meldet dann: „Der Token für Home Assistant fehlt (steht in keiner Sicherung); bitte neu eintragen."

**Einstellungen** (`haconfig.effective(settings, con, store)`)
- **Adresse, Token und Liste zählen als Gruppe:** Ist eine von `STOWLY_HA_URL`, `STOWLY_HA_TOKEN` oder `STOWLY_HA_TODO_ENTITY` gesetzt, kommen alle drei aus der Umgebung und sind in der App gesperrt. So ist es bei dir. Sonst kommen sie aus der App.
- **Sensor-Token:** `STOWLY_HA_SUMMARY_TOKEN` geht vor der App.
- **`STOWLY_HA_CA`** bleibt nur in der Umgebung.
- **Wer die Werte liest:** `integrations.ha_status`, die Sensor-Endpunkte (`api/ha.py`, bei jeder Anfrage) und der Assistent.

**Verbindung ohne Neustart**
- `BringSync` läuft immer, wie der UpdateChecker, und baut seinen Client nur, wenn HA eingerichtet ist. Ohne Einrichtung ruht er mit dem Zustand `off`.
- `reconfigure()` weckt ihn. Hat sich der Fingerabdruck geändert (Adresse, Token, Liste, CA), schließt er den alten Client und baut einen neuen, nie mitten in einer Anfrage.

**Endpunkte** (`api/haconfig.py`, nur angemeldet, `no-store`)
- **`GET` und `PATCH /api/server-config/ha`:** Adresse, Liste, Token setzen oder entfernen.
  - Ein Token steht nie in der Antwort.
  - 409, wenn die Verbindung aus der Umgebung kommt.
  - Eine neue Adresse ohne neues Token löscht das gespeicherte. So lässt sich ein Token nicht an einen anderen Rechner umleiten.
- **`POST /api/server-config/ha/check`:** prüft Adresse und Token (oder die gespeicherten).
  - Liefert die To-do-Listen (`todo.*`, mit Namen und Zahl der offenen Einträge), die HA-Version und einen Zustand: `ok`, `token_needed`, `unauthorized`, `not_ha`, `unreachable` oder `error`.
  - Grenzen: 8 Sekunden je Abfrage und 12 insgesamt, eine Prüfung zugleich mit 3 Sekunden Abstand, `/api/states` höchstens 8 MiB, höchstens 100 Listen.
  - Erlaubt sind nur http und https, ohne Benutzerangabe; abgelehnt werden Link-local-, Multicast- und unbestimmte Adressen.
  - Antworten von HA gehen nie roh zurück.
- **`POST`, `GET` und `DELETE /api/server-config/ha/sensor-token`:** erzeugen (64 Hex-Zeichen), anzeigen, entfernen.

**Listenwechsel ohne falsch Abgehaktes** (behebt `docs/betrieb.md` 17.5)
- Ein Merker `ha_links_entity` hält fest, zu welcher Liste `ha_links` gehört.
- **Liest Stowly erstmals erfolgreich eine andere Liste,** leert es `ha_links` und löst die Bindungen der Einkaufsliste, in einer Transaktion. Nichts wird abgehakt, und Stowly spiegelt seine Einträge in die neue Liste.
- In der alten Liste bleiben sie stehen; die Doku sagt das.
- Beim ersten Start nach dem Update setzt Stowly nur den Merker.

**YAML für HA**
- `haSnippet.ts` baut `secrets.yaml` und `configuration.yaml` für die Adresse der App: den Sensor und die Vorlagen-Sensoren aus `betrieb.md` 18.2, den Bestand aus 18.4.
- Läuft Stowly mit seiner eigenen CA, steht `verify_ssl: false` mit einem Kommentar dabei.
- Ein Test vergleicht das Ergebnis mit dem Block in `betrieb.md`.

## 4. Die App

- **Assistent:**
  - Neue Schritte `sicherung` und `home-assistant` (`SetupStepId.BACKUP`, `HOME_ASSISTANT`).
  - Erledigt ist „Sicherung" mit wirksamen Schlüsseln und einer gelungenen Sicherung, „Home Assistant", sobald HA eingerichtet ist.
  - Bestehenden Haushalten drängt sich der Assistent nicht auf; die Schritte stehen unter Einstellungen → „Einrichtung" zum Nachholen.
- **Einstellungen:**
  - `BackupSection` mit Schlüsseln, Uhrzeit, Ordner, „Jetzt sichern", den Dateien, Zurückspielen und Rückgängig.
  - `HomeAssistantSection` mit `HaConnectionForm` und `HaSensorForm`.
  - Beim Wechsel der Liste fragt die App nach, wenn Einträge gespiegelt sind.
- **Willkommensseite:** „Aus einer Sicherung wiederherstellen".
- **Kern:** `HaConfigApi`, Sicherung und Zurückspielen. Hochladen, Abfragen und das Anmelden nach dem Neustart liegen in einem nachgeladenen `core/restore.ts`.
- **Bündel:** `index-*.js` liegt bei 488,2 kB von 490 kB. Alles Neue kommt in nachgeladene Chunks, und der alte `backup.download` fällt aus dem Kern. Nach dem Bau wird gemessen.
- **Mock und Fake-Server:**
  - Neue Mock-Szenarien: `backup-none`, `backup-app`, `ha-env`, `ha-token-missing`, `restore-preview`.
  - Der Fake-Server bekommt die neuen Routen mit 409, 422 und 429.

## 5. Doku und Version

- **Version 0.4.0.** Im CHANGELOG unter „Von Hand":
  - Die unverschlüsselte Sicherung zum Herunterladen gibt es nicht mehr.
  - Wer `STOWLY_BACKUP_*` oder `STOWLY_HA_*` in der `.env` hat, behält das; die App zeigt es an.
- **`docs/betrieb.md`:**
  - §8 neu: Sicherung und Zurückspielen in der App; die Kommandozeile nur noch als Notweg.
  - §10, §17.2–17.5, §18.1–18.2, §20.4.
  - §19: Assistent und zweiter Ordner in DSM.
  - Prüflisten D, J und K, dazu eine neue für Stufe B.
- **`docs/integrationen.md`:** §3, §5, §7, §8, §12.
- **`docs/sync-protokoll.md`:** §5, §6.4, §11 (neu 11.9 Zurückspielen), §12 Ereignisse, §15.
- Der Plan kommt als `docs/plan-einrichtung-b.md` ins Repository.

## Umsetzung

Wie bisher: Opus 5.5 mit maximalem Aufwand; die Agents committen nicht.

**Runde 0, ich**
- Vertrag: Modelle, Endpunkte, LIMITS, `SetupStepId`, Ereignisse.
- Migration `0005_application_id.sql`.
- `safefile.py` aus `tls._write` herauslösen.
- Export und `test_contract`, dazu die Grundlage der Doku.

**Runde 1, parallel**
- **Worker Sicherung und Zurückspielen (Server):**
  - `serverconfig.backup`, `autobackup.py`, `api/backup.py`;
  - `restore.py`, `api/restore.py`, `__main__.py` (`os.execv`, `resume`), `api/update.py` (gegenseitiger Ausschluss);
  - Tests: `test_backup_config.py`, `test_restore.py` und Anpassungen.
- **Worker Home Assistant (Server):**
  - `secretstore.py`, `haconfig.py`, `hacheck.py`;
  - `bring.py` (reconfigure, Listenwechsel), `api/haconfig.py`, `api/ha.py`, `integrations.py`, `ha_fake.py`;
  - Tests: `test_secretstore.py`, `test_ha_config.py`, `test_ha_check.py`, `test_bring_reconfigure.py`.
- **Worker Oberfläche:**
  - Schlüssel-Chunk;
  - Sicherung und Zurückspielen in Einstellungen, Assistent und Willkommensseite;
  - HA-Formulare und YAML;
  - Kern, Mock, Fake-Server, Tests;
  - e2e: `restore.e2e.test.ts` und `homeassistant.e2e.test.ts` mit einem nachgebildeten HA.
- **Ich:** Doku und Abstimmung zwischen den Workern.

**Runde 2, ich**
- Zusammenführen, alle Prüfungen, Bündel messen.
- Eine unabhängige Sicherheitsprüfung von Zurückspielen, Geheimnisspeicher und HA-Prüfung (SSRF); Funde beheben.
- Lokaler Commit.

**Runde 3, mit dir**
1. **Vorabversion und Testcontainer:** `v0.4.0-rc.1`, Testcontainer per Mausklick, Assistent mit Sicherung:
   - Schlüssel erzeugen, erst Ablage im Datenordner, dann zweiter Ordner `/backups`;
   - „Jetzt sichern", Herunterladen, Schlüssel prüfen;
   - Daten ändern, zurückspielen, Rückgängig;
   - Erststart-Wiederherstellung in einem frischen Container mit dieser Sicherung.
2. **HA am Testcontainer:** gegen eine Probe-Liste in HA („Local To-do"), nicht gegen die echte Bring!-Liste: Verbindung, Liste, Wechsel, Sensor.
3. **`v0.4.0` für dein Stowly,** per Knopf:
   - HA bleibt aus der `.env`. Die App zeigt die Werte nur an, und „Verbindung prüfen" listet „Zuhause".
   - Sicherung in der App einrichten. Dabei prüfen, ob uid 10001 in deinen Ordner `./backups` schreiben darf.
   - Erste Sicherung, dann Schlüssel prüfen.
4. **Aufräumen.**

## Wichtige Dateien

**Neu**
- Server: `server/stowly/restore.py`, `api/restore.py`, `secretstore.py`, `safefile.py`, `haconfig.py`, `hacheck.py`, `api/haconfig.py`, `migrations/0005_application_id.sql`.
- Web: `web/src/features/backup/*` (unter anderem `keys.ts`, Dialog zum Zurückspielen), `features/setup/BackupStep.tsx`, `HomeAssistantStep.tsx`, `features/settings/HaConnectionForm.tsx`, `HaSensorForm.tsx`, `haSnippet.ts`, `core/restore.ts`.

**Geändert**
- Server: `__main__.py`, `app.py`, `autobackup.py`, `scheduler.py`, `serverconfig.py`, `wizard.py`, `bring.py`, `integrations.py`, `config.py`, `tls.py`, `api/backup.py`, `api/ha.py`, `api/serverconfig.py`, `api/setup.py`, `api/update.py`, `contract/api.py`, `limits.py`.
- Web: `contract/core.ts`, `routes.ts`, `core/index.ts`, `http.ts`, `features/setup/*`, `features/settings/BackupSection.tsx`, `HomeAssistantSection.tsx`, Mock, Fake-Server, `package.json`.

**Entfällt:** `server/stowly/backup.py` und `GET /api/backup`.

**Wiederverwendet**
- `serverconfig`: Quelle der Werte, 409 bei Feldern aus der Umgebung.
- `UpdateChecker.reconfigure()` als Muster zum Wecken.
- `tls._write` für sicheres Schreiben.
- `auth.LoginGuard` und die Host-Regel des ersten Passworts.
- `autobackup.snapshot`, `seal` und `rotate`.
- Aus `bring.py`: `Problem` und `untrusted()`.
- In der App: `CopyField`, `useLoaded`, `lazyPage`.

## Verifikation

**pytest Server**
- **Sicherung:** Einstellungen und Vorrang, Wahl des Ordners, Job ruht und erwacht, „Jetzt sichern", nur eigene Dateien zum Herunterladen.
- **Zurückspielen:**
  - Eingaben: falscher Schlüssel, fremde Datei, Trigger, Schema neuer oder älter, Größengrenzen.
  - Erster Start: Host-Regel und das Rennen mit dem ersten Passwort.
  - Tausch: offene WAL, Absturz zwischen jedem Schritt, `os.execv` (nachgebildet).
  - Ergebnis: Zugänge bleiben, Kennungen sind reserviert, Rückgängig, Ablauf der Fristen.
- **Geheimnisspeicher:** Rechte; das Token steht nie in Datenbank, Sicherung, Log oder Antwort.
- **HA:**
  - Vorrang der Umgebung.
  - Prüfung mit ihren Grenzen und SSRF-Regeln.
  - Änderungen wirken ohne Neustart.
  - Listenwechsel ohne falsch Abgehaktes.
  - Token an die Adresse gebunden, Sensor-Token.

**Web und Werkzeuge**
- vitest: Schlüssel (Vektoren von pyrage), Formulare, Assistent, Willkommensseite, YAML gegen `betrieb.md`.
- Dazu Typecheck, ruff, Vertragsprüfung und Bündelgröße.

**e2e**
- Sicherung, Daten ändern, falscher Schlüssel, Zurückspielen, die Geräte laden neu, Rückgängig.
- Erststart-Wiederherstellung.
- HA mit nachgebildetem HA: speichern, „ok" ohne Neustart, der Sensor-Token wirkt, Felder aus der Umgebung geben 409.

**Im Browser:** echter Server, Assistent mit Sicherung und HA.

**Am NAS und iPhone:** siehe Runde 3.

## Risiken

- **Zurückspielen** ist der heikelste Teil: Ein Fehler beim Tausch kann Daten kosten. Dagegen:
  - Getauscht wird nur im frischen Prozess.
  - Jeder Schritt lässt sich wiederholen.
  - Die alte Datenbank bleibt 7 Tage, mit Rückgängig.
- **NAS-Eigenheiten:** `os.execv` als PID 1 unter DSM (Signale, Healthcheck in der Lücke) und `os.link` auf btrfs; beides prüfen wir in Runde 3.
- **Gefälschte Sicherungen:** age prüft den Absender nicht. Dagegen:
  - die strenge Prüfung des Schemas;
  - Zugänge aus der laufenden Datenbank;
  - beim ersten Start das Passwort der Sicherung.
- **Schlüssel über http:** Beim Zurückspielen geht der geheime Schlüssel unverschlüsselt durchs Heimnetz; die App weist darauf hin und rät zu HTTPS.
- **Platz und Zeit:** Nötig ist dreimal so viel freier Platz wie die Datenbank groß ist; `integrity_check` braucht auf kleinen NAS Zeit.
- **Token für HA:**
  - Nach einem Wechsel der Adresse muss es neu eingetragen werden.
  - Wird HA vor der sicheren Verbindung eingerichtet, geht es im Klartext durchs Heimnetz.
  - `/api/states` kann bei großen Installationen groß werden (Grenze 8 MiB).
- **Listenwechsel:** Stowlys Einträge bleiben in der alten Liste stehen.
- **Bündel:** 1,8 kB Reserve; alles Neue wird nachgeladen.
- **Reverse Proxy:** Ein Proxy davor kann bei großen Sicherungen das Hochladen begrenzen.

## Nicht enthalten

- eigene CA für HA in der App (bleibt `STOWLY_HA_CA`);
- Sicherungen aus Stowly direkt in die Cloud (S3, WebDAV); dafür Hyper Backup oder Cloud Sync auf den Ordner;
- einzelne Einträge aus einer Sicherung holen;
- mehr als eine automatische Sicherung am Tag;
- Etiketten-Editor und das nachträgliche Abfragen von Produktdaten (eigene Pläne).

## Änderungen während der Umsetzung

**Sicherung**
- **`BackupConfig.folder_hint`:** Ist `/backups` eingebunden, taugt aber nicht (etwa ohne Schreibrecht für Benutzer 10001), gehen die Sicherungen in den Datenordner, und die App sagt es mit diesem Hinweis. Taugt der Ordner wieder, nimmt Stowly ihn ohne Neustart.
- **Schalter:** Ohne Einstellung ist die automatische Sicherung an (`enabled_source: default`); sie ruht dann nur, solange es keinen Schlüssel gibt. „Jetzt sichern" geht auch bei ausgeschaltetem Schalter und zählt als Sicherung des Tages.
- **Schlüssel im Browser:** `montgomery` aus `@noble/curves/abstract` statt `x25519` aus `ed25519.js`. Das ist kleiner, denn ed25519 und SHA-512 kommen so nicht in den Chunk.

**Zurückspielen**
- **Warten auf den Neustart:** Ein laufender Stowly fragt `GET /api/restore`, bis dort nicht mehr `pending` steht; beim ersten Start wartet die App wie geplant auf `configured: true` in `/api/health`. Beides höchstens fünf Minuten.
- **Merker `ha_links_entity`:** Er kommt aus der Sicherung, obwohl ein laufender Stowly sonst seine `server_config` behält, denn er gehört zu `ha_links`. Ohne Merker (Sicherung vor 0.4.0) werden `ha_links` und die Bindungen der Einkaufsliste geleert, ohne etwas abzuhaken.
- **Dazugekommen:** „Alte Datenbank löschen" (`DELETE /api/restore/previous`) beendet Rückgängig vorzeitig. Entpackt darf eine Sicherung höchstens 2 GiB haben. Eine bereitgelegte Sicherung gilt 10 Minuten nach dem Anwenden. Beim ersten Start vergisst Stowly mit der alten CA auch den Abschluss der Einrichtung; so beginnt der Assistent mit der sicheren Verbindung.
- **429 statt 409:** Läuft gerade ein Schritt, antwortet der Server mit 429 (`Retry-After: 5`); 409 heißt, eine Sicherung liegt schon bereit, ein Update läuft oder der Platz reicht nicht.
- **Neustart:** Lässt sich der Prozess nicht ersetzen, endet er mit Exit-Code 3, und Docker startet den Container neu; der Tausch geschieht dann dort.

**Home Assistant**
- **Gruppe, auch beim Prüfen:** Kommt die Verbindung aus der Umgebung, prüft „Verbindung prüfen" nur die dort eingetragene; Felder geben 409. `STOWLY_HA_CA` gehört nicht zur Gruppe: Allein gesetzt ist sie keine halbe Einrichtung mehr, und sie gilt auch für die Verbindung aus der App.
- **Abgleich läuft immer:** `BringSync` entsteht immer und liest die Einrichtung vor jedem Lauf. Nach einer Änderung gilt `pending`, bis der erste Lauf mit der neuen Einrichtung durch ist; die App fragt bis dahin nach. Jede Antwort von HA ist auf 8 MiB begrenzt, auch im Abgleich.
- **Prüfung ohne Namensauflösung:** Abgelehnt werden nur wörtliche Link-local-, Multicast- und unbestimmte Adressen (auch in IPv6 verpackt) und IP-Adressen in ungewohnter Schreibweise. Rechnernamen löst die Prüfung nicht auf; dafür steht sie nur angemeldeten Geräten offen, folgt keiner Weiterleitung und schickt den gespeicherten Token nur an seine Adresse.

**App**
- **Nachgeladen:** Die HTTP-Aufrufe der Stufe B liegen wegen der Grenze des Bündels in eigenen, nachgeladenen Teilen des Kerns: `core/admin.ts` (Jetzt sichern, Dateien, Home Assistant) und `core/restore.ts`.
- **Assistent:** Ist die Einrichtung schon abgeschlossen, öffnet er bei „Fertig"; dort stehen Sicherung und Home Assistant zum Nachholen. Einstellungen → „Einrichtung und Zugang" nennt dann etwa „Abgeschlossen am …; 4 von 6 erledigt, der Rest lässt sich nachholen".

**Nach der Sicherheitsprüfung (Runde 2)**
- **Schlüssel hinzufügen nur mit Passwort:** Kommt mit `backup_recipients` ein Schlüssel hinzu, ob erzeugt oder eingefügt, braucht es `ServerConfigChanges.current_password`, das Haushalts-Passwort (auch aus `STOWLY_PASSWORD`). Fehlt es: 422 an `["body", "current_password"]`; falsch: 401 `invalid_password` über die Bremse der Anmeldung (nach 5 Fehlversuchen in 5 Minuten 60 Sekunden 429). Wer einen Schlüssel hinzufügt, kann jede künftige Sicherung öffnen, samt Passwort-Hash, VAPID-Schlüssel und Push-Abos. Entfernen braucht es nicht; bringt eine Liste ohne Passwort einen Schlüssel zurück, den ein anderes Gerät gerade entfernt hat, antwortet der Server mit 409. Die App fragt vor dem Hinzufügen nach dem Passwort, in den Einstellungen und im Assistenten.
- **Bilder:** `GET /api/images/{id}` liefert nur `image/jpeg`, `image/png` und `image/webp` mit passenden Bytes, sonst 404, mit `Content-Security-Policy: default-src 'none'; sandbox` und `X-Content-Type-Options: nosniff`. Beim Zurückspielen fallen andere Bilder weg; das Log zählt sie.
- **Prüfung der Sicherung:** Der Aufbau muss Zeichen für Zeichen dem aus den Migrationen gleichen; Trigger und Views führen unter jedem Namen zu `not_stowly`, und jede Verbindung zur Kopie läuft ohne sie. Statistiktabellen aus `ANALYZE` sind nur in SQLites eigener Form erlaubt und fallen weg. Offene Kopplungen eines Pi aus der Sicherung gelten als abgebrochen.
- **Hochladen:** 60 Sekunden ohne Daten oder mehr als 20 Minuten insgesamt ergeben 408 `invalid_request` mit Satz; die Teildatei wird gelöscht. Datei und geprüfte Sicherung gelten 30 Minuten, ein neues Hochladen oder Prüfen ersetzt das alte erst nach Erfolg, und alle 5 Minuten räumt Stowly Abgelaufenes weg, auch die alte Datenbank nach 7 Tagen.
- **Grenze für Anfragen:** höchstens 4 MiB, auch ohne `Content-Length` (`chunked`), sonst 413; nur das Hochladen einer Sicherung darf bis 512 MiB.
- **HA-Prüfung:** Rechnernamen löst Stowly nicht auf; nur angemeldete Geräte können prüfen. Das steht als bekannte Grenze in `docs/integrationen.md`, 5.1.
