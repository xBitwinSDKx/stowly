# Stowly – Plan: Updates über GitHub

## Kontext

Stowly läuft auf deinem NAS (Synology DSM 6.2.4) unter `https://<IP des NAS>:8443`. Jede neue Version kommt bisher von Hand dorthin: kopieren, `starten.sh` mit deinem Passwort, rund 20 Minuten Bau mit Aussetzern beim Herunterladen. Ein GitHub-Repository gibt es noch nicht. Stowly liegt nur auf diesem PC, ohne Remote. Auf dem NAS gibt es kein `git`, Docker 20.10.3 und `docker-compose` 1.28.5 sind da.

Ziel: Der Server merkt selbst, wenn auf GitHub eine neue Version liegt, und die App bietet an, sie zu installieren.

## Deine Entscheidungen

- **Repository:** öffentlich auf GitHub. Hineinschreiben darfst nur du.
- **Bauen:** GitHub baut bei jeder Version ein fertiges Docker-Image (ghcr.io), der NAS lädt es nur herunter.
- **Auslösen:** per Knopf in der App, mit Sicherung vorher und Rückkehr zur alten Version, wenn die neue nicht startet.
- **Neue Version:** nur ein Release, das auf GitHub als „latest" markiert ist. Vorabversionen und Zwischenstände zählen nicht.
- **Commits:** Deine E-Mail wird durch die anonyme GitHub-Adresse ersetzt, dein Name bleibt.
- **Brother-Bibliothek (GPL-3.0):** nicht im öffentlichen Image. Der Pi lädt sie weiter selbst.
- **Lizenz:** keine. Der Code ist zu sehen, alle Rechte bleiben bei dir.

## Ablauf im Überblick

1. **Neue Version:** Ich setze ein Tag `vX.Y.Z` und lade es hoch. Das geschieht nur, wenn du die Version freigibst.
2. **GitHub Actions:**
   - Tests laufen.
   - Danach wird das Image `ghcr.io/<konto>/stowly:X.Y.Z` (dazu `:latest`) gebaut und hochgeladen.
   - Erst wenn das Image da ist, erscheint das Release, als „latest" markiert und mit den Änderungen aus `CHANGELOG.md`.
3. **Stowly-Server:** Er fragt alle 6 Stunden und auf Knopfdruck bei GitHub nach dem neuesten Release. Ist es neuer als er selbst:
   - zeigt die App es unter Einstellungen → „Aktualisierung",
   - kommt je Version einmal eine Push-Nachricht.
4. **Tipp auf „Installieren":** Der Server legt eine Anforderung in sein Datenvolume (`/data/update/request`). Docker selbst bekommt er nicht in die Hand. Er läuft weiter ohne Rechte.
5. **Updater auf dem NAS:** ein kleines Shell-Skript, das der DSM-Aufgabenplaner jede Minute als root startet. Er sieht die Anforderung und
   - lädt das neue Image,
   - hält Stowly an und kopiert die Datenbank,
   - stellt `STOWLY_VERSION` in der `.env` um und startet neu.
   - Wird der Container nicht binnen 3 Minuten `healthy`, spielt er die Kopie zurück und startet die alte Version.
   - Ergebnis und Log schreibt er nach `/data/update/state`.
6. **Danach:** Die App zeigt „Aktualisiert auf X.Y.Z" oder den Fehler. Die Web-App selbst kommt wie bisher über „Jetzt aktualisieren" auf die Geräte.

## 1. GitHub einrichten und veröffentlichen (mit dir)

1. **Repository anlegen (du):** ein leeres, öffentliches Repository `stowly` auf github.com, ohne README und ohne Lizenz. Mir nennst du die Adresse und deine anonyme Adresse (GitHub → Settings → Emails, `…@users.noreply.github.com`).
2. **Datenschutz-Prüfung (ich):** alle Dateien **und der ganze Verlauf** durchsuchen nach
   - deiner E-Mail-Adresse,
   - Benutzernamen und lokalen Pfaden des Entwicklungsrechners,
   - IP-Adressen deines Heimnetzes,
   - Tokens.

   Funde in der Doku ersetze ich durch Platzhalter. Steht etwas im Verlauf, schreibe ich ihn um.
3. **E-Mail umschreiben:** in allen Commits mit `git filter-branch --env-filter`, Name bleibt. Danach gilt im Repository `user.email` = anonyme Adresse, nur lokal. Die Commit-Kennungen ändern sich dabei, das stört nichts.
4. **Erstes Hochladen:** Remote `origin` eintragen, `git push`. Beim ersten Mal öffnet der Git Credential Manager ein Browserfenster, und du meldest dich selbst bei GitHub an.
5. **Arbeitsregel ab dann:** Ich lade nur hoch, wenn du eine Version freigibst oder es ausdrücklich willst. Commits bleiben wie bisher zunächst lokal.
6. **Image öffentlich stellen:** nach dem ersten Bau einmal das Paket `stowly` auf „Public" stellen (Package settings), damit der NAS ohne Anmeldung laden kann.
7. **README:** ein Absatz „Alle Rechte vorbehalten" und einer zu Releases.

## 2. Versionen und Releases

- **Versionsnummern:** SemVer `X.Y.Z`. Die erste öffentliche Version ist **0.2.0**: Stufe 2, die Liste für HA und das Update.
- **Wo die Nummer steht:** `server/stowly/__init__.py`, `server/pyproject.toml`, `print/pyproject.toml`, `web/package.json` (und `package-lock.json`).
- **`scripts/release.py X.Y.Z`:** setzt die Nummer überall und prüft, dass `CHANGELOG.md` einen Abschnitt für X.Y.Z hat. Ich committe „Version X.Y.Z" und setze das Tag `vX.Y.Z`.
- **`CHANGELOG.md`** (deutsch): je Version die Änderungen. Der Abschnitt wird zum Text des Releases, und den zeigt die App.
- **`.github/workflows/release.yml`**, ausgelöst durch ein Tag `v*`:
  1. **Tests:**
     - Python 3.12 aus `server/requirements.lock`: pytest für `server/tests` und `print/tests` getrennt, ruff, Prüfung des Vertrags (`stowly.contract.export`, keine veralteten Dateien), die Tests des Updaters.
     - Node: `npm ci`, `npm run typecheck`, `vitest`.
     - Die Ende-zu-Ende-Tests mit Browser laufen vorerst nicht in CI.
  2. **Image:**
     - Prüft, dass das Tag zu den Versionsnummern im Code passt.
     - Baut für `linux/amd64` mit `--build-arg STOWLY_BROTHER=0` und lädt `:X.Y.Z` und `:latest` hoch, mit OCI-Labels (Quelle, Version, Revision).
  3. **Release:** `gh release create vX.Y.Z --latest` mit dem Abschnitt aus dem Changelog.
     - Ein Tag mit Zusatz (`v0.2.0-rc.1`) wird als Vorabversion veröffentlicht, ohne `:latest`. Der NAS beachtet sie nicht.
  - Rechte: `contents: write` und `packages: write`; die Actions offizieller Herausgeber mit fester Version.
- **Probelauf:** Die erste Pipeline geht als `v0.2.0-rc.1`. Erst wenn sie grün ist, kommt `v0.2.0`.

## 3. Image und Compose

- **`Dockerfile`:**
  - `ARG STOWLY_BROTHER=1`; der dritte `pip install` (Brother) nur bei 1.
  - Eigene Builds bleiben wie bisher. Das öffentliche Image meldet einen Brother-Drucker am Server als `config`, wie bereits dokumentiert.
- **`docker-compose.yml`:** `image: ${STOWLY_IMAGE:-stowly}:${STOWLY_VERSION:-local}`, `build: .` bleibt.
  - Ohne Angaben baut man wie bisher selbst.
  - Mit `STOWLY_IMAGE`/`STOWLY_VERSION` in der `.env` holt man das fertige Image (`pull`, dann `up -d` ohne `--build`).
- **`.dockerignore`:** `.github`, `updater`, `scripts` dazu.
- **`.env.example`:** `STOWLY_IMAGE`, `STOWLY_VERSION`, `STOWLY_UPDATE_REPO`, beschrieben.

## 4. Server: prüfen und anfordern

- **Konfiguration:** `STOWLY_UPDATE_REPO=<konto>/stowly`; leer heißt aus. Geprüft wird beim Start wie die übrigen Variablen (`server/stowly/config.py`).
- **`server/stowly/updates.py`, `UpdateChecker`:** eine Hintergrundschleife nach dem Muster von `bring.BringSync`, mit Wecker, eingereichter Uhr und Transport für Tests. Gestartet wird sie im `lifespan` in `app.py`.
  - Fragt `GET https://api.github.com/repos/{repo}/releases/latest`, ohne Token (öffentlich, 60 Abfragen je Stunde reichen). Kopfzeilen `User-Agent: Stowly/<version>`, `Accept: application/vnd.github+json`.
  - Takt: eine Minute nach dem Start, dann alle 6 Stunden, dazu auf Knopfdruck, höchstens einmal je Minute.
  - Liest `tag_name` (SemVer, „v" davor erlaubt), `name`, `body` (gekürzt auf 4000 Zeichen), `published_at` und `html_url`.
  - 404 heißt: noch kein Release. Netz- und Ratenfehler stehen als Fehler im Zustand, der nächste Versuch kommt planmäßig.
  - Ergebnis in `job_runs` (Aufgabe `update_check`, `scheduler.record_success`/`record_failure`), damit es einen Neustart übersteht.
  - Ist die Version neu, geht **einmal je Version** eine Push-Nachricht an alle Geräte mit Abo: „Stowly X.Y.Z ist verfügbar", Tag `stowly-update`, Ziel `/einstellungen`. Dafür wird `push.py` wiederverwendet.
- **Dateien in `/data/update/`:** Den Ordner legt der Server an (er gehört uid 10001).
  - `request`, vom Server: `key=value`-Zeilen `version=`, `requested_at=`, `device=`. Geschrieben über eine Zwischendatei, dann umbenannt.
  - `state`, vom Updater: `state=installing|done|failed`, `version=`, `from=`, `at=`, `message=`.
  - `updater`, vom Updater bei jedem Lauf: `seen_at=`. Daran erkennt der Server, ob der Updater eingerichtet ist (zuletzt gesehen vor höchstens 10 Minuten).
  - `log`: die Ausgabe des letzten Updates.
- **Vertrag** (`server/stowly/contract/api.py`, danach `python -m stowly.contract.export`):
  - `UpdateStatus` in `IntegrationStatus.update` mit
    - `configured`, `repo`, `current`, `latest`, `latest_name`, `notes`, `published_at`, `url`,
    - `available`, `checked_at`, `check_error`, `updater_ready`, `updater_seen_at`,
    - `state` (`idle`, `requested`, `installing`, `done`, `failed`), `state_version`, `state_at`, `state_message`.
  - `POST /api/update/check`: Geräte-Token. Antwortet 200 mit `UpdateStatus`, 429 öfter als einmal je Minute, 503 `not_configured`.
  - `POST /api/update/install` mit `{version}`: Geräte-Token. Antwortet 202 mit `UpdateStatus`.
    - 409, wenn die Version nicht die neueste, nicht neuer oder schon angefordert ist.
    - 503, wenn das Update aus ist oder der Updater fehlt.
    - Nur die Versionsnummer gelangt in die Datei, nie etwas anderes aus der Anfrage.
- **`integrations.status`** liest Zustand und Dateien zusammen. Steht in `state` „done" für die eigene Version, meldet die App „Aktualisiert auf X.Y.Z".

## 5. App

- **Kern:** `core.update.check()` und `core.update.install(version)`. Beides nur mit Verbindung, sonst CoreError `offline`. Die Endpunkte kommen aus dem Vertrag.
- **Einstellungen**, neuer Abschnitt **„Aktualisierung"** (`id="aktualisierung"`), unter „Home Assistant". Neue Datei `UpdateSection.tsx` nach dem Muster von `BackupSection.tsx`.
  - Zeilen: installierte Version, neueste Version mit Datum, Änderungen (aufklappbar, als Text), zuletzt geprüft.
  - Knöpfe: „Nach Updates suchen" und „Update installieren". Vor dem Installieren eine Rückfrage: „Stowly ist etwa ein bis zwei Minuten nicht erreichbar. Vorher sichert der NAS die Datenbank; startet die neue Version nicht, kehrt er zur alten zurück."
  - Zustände: wartet auf den NAS, wird installiert, fertig, fehlgeschlagen (mit Meldung). Fehlt der Updater, steht dort ein Hinweis auf die Anleitung.
  - Während des Updates fragt die Seite alle 10 Sekunden nach dem Zustand. Ist der Server weg, steht dort „Server startet neu …".
- **Push:** Den Tag `stowly-update` nimmt `TAG_TARGETS` in `web/src/core/push/worker.ts` auf, Ziel `/einstellungen`. Unter iOS 27 öffnet der Tipp die App weiterhin nur am Anfang, wie bekannt.

## 6. Updater auf dem NAS (`updater/stowly-update.sh`)

- POSIX-`sh`, nur Werkzeuge, die DSM 6.2 und Debian haben: `sh`, `sed`, `grep`, `cp`, `docker`. Dazu `docker-compose` oder `docker compose`, je nachdem, was da ist. Kein `jq`, kein Python. `PATH` mit `/usr/local/bin`.
- **Jeder Lauf:**
  1. Den Ordner des Volumes über `docker volume inspect` finden (Name aus `STOWLY_VOLUME`, Vorgabe `stowly_stowly-data`).
  2. Die Datei `updater` schreiben.
  3. Ohne `request` sofort Ende.
- **Mit `request`:**
  1. **Sperre** über `mkdir lock`, sonst Ende.
  2. **Prüfen:** Version gegen `^[0-9]+\.[0-9]+\.[0-9]+$`, `STOWLY_IMAGE` muss in der `.env` stehen.
  3. **Laden:** `state=installing`, dann `docker pull <image>:<neu>` mit bis zu drei Versuchen. Scheitert das, bleibt die alte Version laufen: `failed`, Ende.
  4. **Sichern:** `stop stowly`, dann die Datenbank samt `-wal`/`-shm` nach `/data/update/before-<alt>-<zeit>.sqlite3` kopieren. Die drei neuesten Kopien bleiben.
  5. **Umstellen:** In der `.env` `STOWLY_VERSION` setzen, vorher eine `.env.bak` anlegen. Dann `up -d stowly`.
     - Geschrieben wird in die vorhandene Datei, nicht mit `sed -i`, das sie durch eine neue ersetzt. So bleiben Besitzer und Rechte, und du kannst die `.env` weiter über die Freigabe bearbeiten.
  6. **Warten:** bis zu 3 Minuten auf `healthy` (`docker inspect`).
     - Ist er `healthy`: `done`, Anforderung löschen. Alte Images aufräumen, die aktuelle und die vorige Version bleiben.
     - Sonst zurück: anhalten, die Kopie zurückspielen, die alte `STOWLY_VERSION` setzen, `up -d`, warten. Dann `failed` mit „Neue Version startete nicht, zurück auf <alt>" und dem Ende des Container-Logs.
- **Einrichten in DSM:** Systemsteuerung → Aufgabenplaner → Erstellen → Geplante Aufgabe → Benutzerdefiniertes Skript.
  - Benutzer `root`, täglich, jede Minute wiederholen (sonst alle 5 Minuten).
  - Befehl `sh <projekt>/updater/stowly-update.sh`.
  - Auf Debian macht das ein systemd-Timer; der Schnipsel kommt in die Doku.
- **Grenze:** Der Updater tauscht nur das Image. Ändert eine Version `docker-compose.yml`, die `.env` oder den Updater selbst, sagt der Changelog das, und es wird einmal von Hand nachgezogen.

## 7. Umstieg des NAS (einmalig, mit dir)

1. Nach `v0.2.0` den Stand dieses Tags auf den NAS kopieren (`git archive`), damit `updater/` und das neue Compose dort sind.
2. In die `.env`: `STOWLY_IMAGE=ghcr.io/<konto>/stowly`, `STOWLY_VERSION=0.2.0`, `STOWLY_UPDATE_REPO=<konto>/stowly`.
3. Einmal `docker compose pull` und `docker compose up -d` (mit `sudo`), statt zu bauen.
4. Die Aufgabe im DSM-Aufgabenplaner anlegen (du, mit meiner Anleitung).
5. **Probe:** Ich veröffentliche nach deiner Freigabe `0.2.1`, nur mit Changelog. Erwartet:
   - Push „Stowly 0.2.1 ist verfügbar",
   - in der App „Update installieren",
   - nach ein bis zwei Minuten „Aktualisiert auf 0.2.1", die Daten unverändert,
   - auf dem iPhone „Jetzt aktualisieren".

## Umsetzung

Wie bei den Stufen: Opus 5.5, maximaler Aufwand, die Agents committen nicht.

- **Runde 0 (ich):**
  - Vertrag (`UpdateStatus`, Endpunkte, `STOWLY_UPDATE_REPO`), Format der Dateien in `/data/update`.
  - Dazu `docs/integrationen.md` (neuer Abschnitt Update) und `docs/sync-protokoll.md`.
- **Runde 1, parallel:**
  - **Worker Server:** `updates.py`, Endpunkte, `integrations.status`, Push je Version, Tests mit nachgebildetem GitHub (200, 404, 403, Netzfehler, alte und neue Version, „v"-Präfix, Vorabversion) und eingereichter Uhr.
  - **Worker Oberfläche:** Kern, `UpdateSection.tsx`, Ziel der Push-Nachricht, Tests, der Fake-Server (`web/src/core/testing/fake-server.ts`).
  - **Ich:**
    - `updater/stowly-update.sh` samt Tests: pytest startet das Skript mit nachgebildetem `docker`/`docker-compose` im PATH. Fälle: ohne Anforderung, ungültige Version, `pull` scheitert, Erfolg, nicht `healthy` mit Rückkehr, Sperre.
    - `Dockerfile`, Compose, `.dockerignore`, `.env.example`, `scripts/release.py`, `CHANGELOG.md`, Workflow, `docs/betrieb.md` (Abschnitt 9 neu: Aktualisieren über GitHub, mit Aufgabenplaner und systemd), Prüfliste, README.
- **Danach:**
  - zusammenführen, alle Prüfungen, im Browser gegen den echten Server mit nachgebildeter Release-Antwort,
  - Commit lokal,
  - dann Abschnitte 1 und 7 mit dir.

## Wichtige Dateien

- **Neu:**
  - `server/stowly/updates.py`, `server/tests/test_updates.py`,
  - `updater/stowly-update.sh`, `updater/tests/`,
  - `web/src/features/settings/UpdateSection.tsx`,
  - `.github/workflows/release.yml`, `scripts/release.py`, `CHANGELOG.md`.
- **Geändert:**
  - `server/stowly/contract/api.py`, `server/stowly/config.py`, `server/stowly/app.py`, `server/stowly/integrations.py`, `server/stowly/api/` (neuer Router `update.py`),
  - `web/src/core/` (Kern, `push/worker.ts`), `web/src/features/settings/index.tsx`,
  - `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.env.example`,
  - `docs/betrieb.md`, `docs/integrationen.md`, `docs/sync-protokoll.md`, `docs/pruefliste.md`, `README.md`.
- **Wiederverwendet:**
  - `bring.BringSync` (Muster der Schleife),
  - `scheduler.record_success`/`record_failure` (`job_runs`),
  - `push.py` (Versand an alle Abos),
  - `BackupSection.tsx`/`integrations.ts` (Muster der Anzeige),
  - `stowly.contract.export` (Vertragsdateien).

## Verifikation

- **Automatisch:**
  - pytest Server (neu: Abfrage, Zustände, Endpunkte, Datei-Formate, Push einmal je Version),
  - pytest Druckdienst,
  - Tests des Updaters (Linux in CI; hier mit Git Bash, sonst übersprungen),
  - vitest und `npm run typecheck`, ruff, Vertragsprüfung.
- **CI:** `v0.2.0-rc.1` läuft durch, das Image liegt unter `:0.2.0-rc.1`, das Release ist eine Vorabversion. `api.github.com/…/releases/latest` zeigt es nicht.
- **Im Browser (ich):** Der Abschnitt „Aktualisierung" mit nachgebildeten Zuständen (aktuell, neu, angefordert, installiert, fehlgeschlagen, Updater fehlt, offline).
- **Auf dem NAS:**
  - eine Anforderung für eine Version, die es nicht gibt: `pull` scheitert, die alte läuft weiter, die App zeigt den Fehler;
  - danach das echte Update auf 0.2.1 (Abschnitt 7).
  - Die Rückkehr bei einer kaputten Version prüfen die Tests des Updaters.

## Risiken

- **Updater als root:** Er läuft als root aus deinem Projektordner. Wer den Ordner ändern kann, kann damit Befehle als root ausführen. Auf deinem NAS bist du ohnehin Administrator; die Anleitung sagt es.
- **Daten:** Die Datenbank wird vor jedem Update kopiert. Die Rückkehr spielt die Kopie nur zurück, wenn die neue Version nie `healthy` wurde. Ein Gerät, das in diesen Minuten abgeglichen hat, ist die seltene Ausnahme.
- **Changelog lesen:** Änderungen an Compose oder `.env` übernimmt der Updater nicht; der Changelog muss sie nennen.
- **Erreichbarkeit:** GitHub, ghcr.io und die Internetverbindung des NAS (bekannte Aussetzer). Scheitert der Download, bleibt die alte Version unverändert in Betrieb.
- **Öffentlicher Code:** Die Datenschutz-Prüfung in Abschnitt 1 ist Pflicht vor dem ersten Hochladen. Danach gehört nichts Persönliches mehr ins Repository, wie bisher.

Nicht enthalten: Updates des Druckdienstes auf dem Pi und ein Update-Hinweis in Home Assistant.
