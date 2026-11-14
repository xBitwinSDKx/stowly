# Stowly

Selbst gehostete Lagerverwaltung für Lebensmittel. Jede Packung bekommt beim Einlagern ein Etikett mit einer 5-stelligen ID (Klartext und QR-Code), wird per Handy-Scan ein- und ausgebucht und erscheint in einer nach Produkt gruppierten Bestandsliste mit dem kritischsten MHD. Die App funktioniert im Keller ohne Netz und gleicht ab, sobald der Server wieder erreichbar ist.

**Stand:** Stufe 1 nach zwei Runden samt Integration: Bestand, Offline-Betrieb, Scannen und Etikettendruck (Server und Raspberry Pi) laufen zusammen auf dem Entwicklungsrechner. In der Zielumgebung (Container, Handys, Drucker, Pi) ist noch nichts geprüft: [`docs/pruefliste.md`](docs/pruefliste.md) führt Schritt für Schritt hindurch, die Tabellen mit Befehl und erwartetem Ergebnis stehen in [`docs/betrieb.md`](docs/betrieb.md) und [`pi/README.md`](pi/README.md). Plan: [`docs/plan-stufe-1.md`](docs/plan-stufe-1.md).

## Aufbau

| Ordner | Inhalt |
|---|---|
| `server/` | Python 3.12, FastAPI, SQLite: maßgeblicher Bestand, Sync, Anmeldung. Paket `stowly`. |
| `print/` | Paket `stowly_print`: Etikett rendern, Druckertreiber, Auftragsdienst. Läuft im Server und eigenständig auf dem Raspberry Pi; ohne FastAPI und pydantic. Die Schriften der Etiketten (DejaVu, frei lizenziert) liegen samt Lizenztext im Paket. |
| `web/` | React, TypeScript, Vite: eine App für Desktop und Handy, die immer auf ihrer lokalen Kopie arbeitet. |
| `pi/` | Installation des Druckdienstes auf dem Raspberry Pi samt Anleitung und Prüfliste. |
| `docs/` | Plan, technische Grundlagen und die Verträge. |

In `web/src`:

| Ordner | Inhalt |
|---|---|
| `contract/` | Der Vertrag als Code: erzeugte Datentypen (`api.gen.ts`), Schnittstelle des Offline-Kerns (`core.ts`), gemeinsame Regeln (IDs, QR, Barcodes, Zeit, MHD, Etikett-Daten). |
| `core/` | Der Offline-Kern: lokale Datenbank, Outbox, Sync, Scanner. |
| `mock/` | Attrappe des Kerns mit Beispieldaten, ohne Server. |
| `ui/` | Design-System: Tokens (`tokens.css`), Thema, Grundbausteine (`ui/base`). |
| `features/` | Die Ansichten: Bestand, Zonen, Warnungen, Lösch-Historie, Drucker, Einstellungen, Sync, Anmeldung, Scannen. |
| `app/` | Rahmen der App: Routen, Navigation, Anmelde-Schranke. |

## Verträge

- [`docs/sync-protokoll.md`](docs/sync-protokoll.md): Datenmodell, Sync-Aufruf, Befehle, Konfliktregeln, ID-Vorrat, Anmeldung, Fehlerformat, Zeit
- [`docs/etiketten.md`](docs/etiketten.md): QR-Inhalte, Aufbau des Etiketts, Protokoll des Druckdienstes
- [`docs/openapi.json`](docs/openapi.json) und `web/src/contract/api.gen.ts`: dieselben Datentypen für beide Seiten, erzeugt aus den Python-Modellen in `server/stowly/contract/` und `print/stowly_print/model.py`
- [`docs/vectors.json`](docs/vectors.json): gemeinsame Beispiele, gegen die Server und Web-App getestet werden
- `server/stowly/migrations/`: das Datenbankschema (`0001_initial.sql`) und seine Ergänzungen als nummerierte Migrationen

Die Quelle der Datentypen ist Python. Nach einer Änderung an den Modellen:

```
python -m stowly.contract.export          # schreibt docs/openapi.json und web/src/contract/api.gen.ts
python -m stowly.contract.export --check  # prüft nur
```

## Entwickeln

Der Code läuft unter Windows (Entwickeln, Testen) und Linux (Betrieb). Alle Textdateien haben LF-Zeilenenden (`.gitattributes`). Die Befehle unten gelten in jeder Shell; `python` steht für das Python der Umgebung (`.venv\Scripts\python.exe` unter Windows, `.venv/bin/python` unter Linux).

### Einrichten

```
python -m venv .venv                      # Python 3.12
python -m pip install -e "./print[dev]" -e "./server[dev]"
cd web
npm ci                                    # Node 22.12 oder neuer
```

### Server und Druckdienst

```
cd server
python -m pytest                          # Tests des Servers
cd ../print
python -m pytest                          # Tests des Druckdienstes
cd ..
python -m ruff check server print         # Stilprüfung
python -m ruff format server print        # Formatierung
```

### Web-App

Alles im Ordner `web`:

```
npm run dev:mock        # Oberfläche auf der Attrappe, ohne Server (http://localhost:5173)
npm run dev             # echte App; /api und /print gehen an http://127.0.0.1:8010
npm run dev:fake        # echte App gegen eine nachgebaute Schnittstelle (src/core/testing/fake-api.ts)
npm run typecheck       # alle Typprüfungen
npm test                # alle Tests, die ohne Server auskommen
npm run test:e2e        # der echte Kern gegen den echten Server (siehe unten)
npm run build           # baut nach web/dist (das liefert der Server aus)
npm run build:mock      # baut die Attrappe nach web/dist-mock
```

Einzelne Bereiche lassen sich getrennt prüfen:

| Bereich | Typprüfung | Tests |
|---|---|---|
| Vertrag (`src/contract`) | in beiden enthalten | `npm run test:contract` |
| Oberfläche (`src/ui`, `src/app`, `src/features` ohne `scan`, `src/mock`) | `npm run typecheck:ui` | `npm run test:ui` |
| Kern und Scannen (`src/core`, `src/features/scan`) | `npm run typecheck:core` | `npm run test:core` |
| Service Worker (`src/sw.ts`) | `npm run typecheck:sw` | – |
| Ganze App mit echtem Kern | `npm run typecheck:app` | `npm test` |
| Kern gegen den echten Server (`e2e`) | `npm run typecheck:e2e` | `npm run test:e2e` |

`npm run test:e2e` startet für jede Testdatei den echten Server als eigenen Prozess (freier Port, temporäres Datenverzeichnis, Open Food Facts ausgeschaltet) und lässt den echten Offline-Kern dagegen laufen; `e2e/delivery.e2e.test.ts` startet dazu den eigenständigen Druckdienst (`python -m stowly_print serve`, Bild-Treiber) als zweiten Prozess, wie er auf dem Pi läuft, und zählt die Drucke an seinem Bild-Verzeichnis. Es gehört nicht zu `npm test`, weil es die Python-Umgebung des Servers braucht. Das Python dafür ist das aus `.venv` im Repository oder das aus der Umgebungsvariable `STOWLY_E2E_PYTHON`. Die Zufallsfolgen (`e2e/random.e2e.test.ts`) laufen mit festen Startwerten; andere wählt die Umgebungsvariable `STOWLY_E2E_SEEDS`, zum Beispiel `1-50` oder `7,8,9`.

Ein anderer Port: `npm run dev:mock -- --port 8012 --strictPort`. Die Attrappe kennt Ausgangslagen, wählbar über die Adresse, auch mehrere mit Komma: `?mock=empty`, `single-zone`, `signed-out`, `revoked`, `offline`, `problems`, `update`, `update-required`, `insecure`, `ios`, `installable`, `no-lookup`, `large` (gut 2000 Packungen), `at-pi` (der direkte Drucker ist erreichbar) und `printer-trouble` (Passwort der Attrappe: `stowly`). In der Konsole des Browsers steht `stowlyMock` zum Eingreifen bereit, etwa `stowlyMock.setOnline(false)`, `stowlyMock.setPiReachable(true)`, `stowlyMock.setPiProblem("permission")` oder `stowlyMock.setPrintOutcome("unknown")`; was die Ausgangslagen und Eingriffe bedeuten, steht am Kopf von `web/src/mock/core.ts`. Die Attrappe zeigt unter `/scan` einen Platzhalter; mit `/scan?scan=real` lädt der Entwicklungsserver die echte Scan-Ansicht auf den Beispieldaten.

Wer darf was importieren, prüft `src/contract/boundaries.test.ts`.

## Starten

Ein Prozess auf Port 8010 liefert Schnittstelle und Web-App, genau wie später im Container:

```
cd web
npm run build
cd ..
python -m stowly --dev
```

Dann <http://localhost:8010>. Im Entwicklungsmodus (`--dev`) ist das Haushalts-Passwort `stowly`, solange `STOWLY_PASSWORD` nicht gesetzt ist, und unter `/api/docs` steht die Beschreibung der Schnittstelle. Die Datenbank liegt in `data/` im Repository.

Aus dem **übergeordneten** Ordner heraus gestartet, hält Python den Ordner `stowly` selbst für das Paket. Dort deshalb mit `-P` starten: `python -P -m stowly --dev`.

Einstellungen des Servers sind Umgebungsvariablen, beschrieben in [`.env.example`](.env.example).

## Betrieb

Ausgeliefert wird ein Linux-Container:

```
cp .env.example .env        # STOWLY_PASSWORD setzen
docker compose up -d --build
```

Der Container spricht nur HTTP auf Port 8010 und gehört hinter einen Reverse Proxy, der HTTPS bereitstellt (Nginx Proxy Manager mit eigener Zertifizierungsstelle oder Tailscale). **Offline-Betrieb, Installation als App und Kamera funktionieren nur über die HTTPS-Adresse**: Das verlangen die Browser. Über `http://<LAN-IP>:8010` läuft Stowly nur als Online-Webseite ohne Scan.

**Abhängigkeiten.** Die Python-Pakete im Image sind auf Version und Prüfsumme festgelegt: `server/requirements.lock` für Server und Druckdienst, `print/requirements-brother.txt` für die Brother-Bibliothek. Es sind die Versionen, mit denen die Tests laufen. Wer in einer `pyproject.toml` eine Abhängigkeit ergänzt oder in der Entwicklungsumgebung eine aktualisiert, erneuert die Sperrdatei: im Ordner `server` `python tests/test_requirements_lock.py`. Sonst schlägt genau dieser Test fehl. Anleitung: [`docs/betrieb.md`](docs/betrieb.md), Abschnitt 9.1.

`Dockerfile` und `docker-compose.yml` sind in der Zielumgebung noch nicht gebaut und gestartet worden: Auf dem Entwicklungsrechner gibt es kein Docker.

## Hinweise

- Produktdaten und Vorschaubilder stammen von [Open Food Facts](https://world.openfoodfacts.org) (ODbL). Dabei gehen die Barcodes unbekannter Produkte an deren Server, schon beim Scannen (damit der Name gleich im Dialog steht), auch wenn danach nichts eingelagert wird; abschaltbar mit `STOWLY_OFF_ENABLED=0`.
- Bezeichner im Code sind englisch, Oberfläche, Kommentare und Dokumentation deutsch.
