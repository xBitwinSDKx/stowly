# Etiketten und Druck

Verbindlicher Vertrag für alles rund ums Etikett in Stufe 1: was im QR-Code steht, wie das Etikett aufgebaut ist, wie die App einen Druckauftrag stellt und wie der Druckdienst antwortet. Der Sync selbst steht in [`sync-protokoll.md`](sync-protokoll.md), die technischen Hintergründe in [`recherche.md`](recherche.md), Abschnitte 3 bis 8.

## 1. Überblick

- Jede Packung bekommt ein Etikett mit ihrer 5-stelligen ID als Klartext und als QR-Code. Jede Zone kann ein Etikett mit ihrem QR-Code bekommen.
- **Ein Druckauftrag enthält nur Daten und die Vorlage. Gerendert wird dort, wo der Drucker hängt**, weil nur diese Stelle Etikettengröße und Auflösung kennt.
- Es gibt einen Druckdienst (`stowly_print`) mit einer Schnittstelle, der an zwei Stellen läuft:
  - **im Stowly-Server** unter `/print`, für Drucker im Heimnetz (`Printer.connection = "server"`),
  - **eigenständig auf dem Raspberry Pi** im Keller, den das Handy direkt anspricht (`connection = "direct"`). Der Pi hat kein Internet, keine Verbindung zum Server und keine Uhr.
- Solange kein Drucker da ist, erzeugt der Bild-Treiber das Etikett als PNG.
- Jeder Auftrag hat eine eigene Kennung. **Eine Wiederholung druckt nie doppelt; ein mitten im Druck unterbrochener Auftrag wird nie automatisch wiederholt**, die App fragt nach.

## 2. QR-Inhalte

| Etikett | Inhalt | Beispiel | QR-Code |
|---|---|---|---|
| Packung | `STOWLY/P/` + Packungs-ID | `STOWLY/P/A2B3C` | Version 1 (21 × 21 Module), Fehlerkorrektur Q |
| Zone | `STOWLY/Z/` + Zonen-UUID als 32 große Hex-Zeichen ohne Bindestriche | `STOWLY/Z/3F2B8C1E5A474D099B6E0C1D2E3F4A5B` | Version 3 (29 × 29 Module), Fehlerkorrektur Q |

- Beide Inhalte bestehen nur aus Zeichen des alphanumerischen QR-Modus (`0–9`, `A–Z`, `/`). Dadurch passt das Packungs-Etikett mit 14 Zeichen in Version 1 bei Fehlerkorrektur Q (Grenze: 16 Zeichen), der kleinsten und damit am gröbsten druckbaren Form. Eine Adresse (`https://…`) passt nicht und wäre an den Namen der Installation gebunden.
- **Lesen:** Leerraum am Rand entfernen, in Großbuchstaben wandeln, dann muss der ganze Inhalt passen:
  - `^STOWLY/P/([0-9A-HJKMNP-TV-Z]{5})$` ist eine Packung,
  - `^STOWLY/Z/([0-9A-F]{32})$` ist eine Zone (die 32 Zeichen werden zur UUID in kanonischer Schreibweise),
  - alles andere ist kein Stowly-Code. Die Korrektur verwechselter Zeichen (`O` zu `0`) gilt nur für die Eingabe von Hand, nicht für QR-Inhalte.
- **Scannen:** Der Scanner liest die Formate `qr_code`, `ean_13`, `ean_8` und `upc_a` (Namen der BarcodeDetector-API) und ordnet selbst ein: Etikett einer Packung, Etikett einer Zone, Produkt-Barcode oder unbekannt. Ein QR-Code ist nie ein Produkt-Barcode, ein Strichcode nie ein Etikett.
- Als Code: `packageQr`, `zoneQr`, `parseQr`, `classifyScan` in `web/src/contract/qr.ts`; `package_qr`, `zone_qr`, `parse_qr` in `server/stowly/contract/ids.py`. Gemeinsame Beispiele: [`vectors.json`](vectors.json).

## 3. Das Etikett

### 3.1 Material und Maße

- Brother DK-Endlosrolle, 62 mm breit, auf 29 mm Länge geschnitten: Papier DK-22205 fürs Regal, Folie DK-22212 für den Gefrierschrank.
- Bei 300 dpi sind das **696 × 342 Pixel** (druckbare Breite × Länge), also etwa 58,9 × 29 mm Zeichenfläche. Die 62 mm liegen quer zur Laufrichtung, das Etikett wird im Querformat gelesen und nicht gedreht.
- Gedruckt wird rein schwarz-weiß (1 Bit), ohne Graustufen.

### 3.2 Aufbau

```
+--------------------------------------------------------------+
|  +-----------+   Basmati Reis                                |
|  |           |   Kornhaus · 1 kg                             |
|  |    QR     |   MHD 25.03.2027                              |
|  |           |   -----------------------------------------   |
|  +-----------+   A2B3C                          13.11.2026   |
+--------------------------------------------------------------+
```

- Links der QR-Code in einem Feld von 24 mm. Module sind immer ganze Pixel: Bei 300 dpi ergibt das für das Packungs-Etikett 9 Pixel je Modul, der Code ohne Ruhezone ist 16 mm breit. Untergrenze sind 6 Pixel je Modul; darunter verweigert der Renderer.
- Rechts Produktname (bis zu zwei Zeilen, wird bei Bedarf kleiner), Marke und Packungsgröße, das MHD, darunter die ID groß in Festbreitenschrift und klein das Datum des Einlagerns.
- Das Zonen-Etikett zeigt links den QR-Code (27 mm), rechts groß den Namen der Zone und darunter „Lagerzone".

### 3.3 Daten

Die App schickt dem Druckdienst **fertig formatierte Zeichenketten**: Der Pi hat keine Uhr und kennt keine Sprache. Leere Zeichenketten sind erlaubt; die Vorlage lässt die Zeile dann weg.

Packung (`PackageLabelData`, erzeugt von `packageLabelData()` in `web/src/contract/labels.ts`):

| Feld | Inhalt | Beispiel |
|---|---|---|
| `qr` | QR-Inhalt | `STOWLY/P/A2B3C` |
| `id` | Packungs-ID | `A2B3C` |
| `title` | Produktname; bei Platzhaltern der Barcode | `Basmati Reis` |
| `subtitle` | Marke und Packungsgröße, mit ` · ` verbunden; darf leer sein | `Kornhaus · 1 kg` |
| `best_before` | MHD als `TT.MM.JJJJ`; leer = keines | `25.03.2027` |
| `stored` | Tag des Einlagerns als `TT.MM.JJJJ` | `13.11.2026` |
| `zone` | Name der Zone; leer, wenn es nur eine gibt | `Keller` |

Zone (`ZoneLabelData`, erzeugt von `zoneLabelData()`): `qr`, `title` (Name der Zone), `subtitle` („Lagerzone").

### 3.4 Vorlage

Die Vorlage ist ein JSON-Objekt, das der Renderer deutet. **Sie reist mit jedem Auftrag**, damit ein Druckdienst ohne Netz nie aktualisiert werden muss, wenn sich das Etikett ändert.

- Die mitgelieferten Vorlagen liegen in `print/stowly_print/templates/` (`package-62x29.json`, `zone-62x29.json`).
- Der Server übernimmt sie beim Start in die Tabelle `label_templates` und verteilt sie über den Sync (`LabelTemplate { key: "package" | "zone", hash, body, updated_at }`). Ändert sich eine Vorlage, ändert sich ihr `hash` (16 Hex-Zeichen des SHA-256 über das kanonische JSON), und alle Geräte bekommen sie neu.
- **Die App reicht `body` unverändert als `template` weiter** und deutet es nicht. Für die App ist die Vorlage undurchsichtig.

Format (`"schema": 1`); alle Maße in Millimetern, Ursprung oben links:

```json
{
  "schema": 1,
  "name": "package-62x29",
  "media": { "width_mm": 62, "length_mm": 29 },
  "design": { "width_mm": 58.9, "height_mm": 29.0 },
  "elements": [
    { "type": "qr", "x": 0.5, "y": 2.5, "size": 24.0, "value": "{qr}", "ec": "Q", "quiet": 4, "min_module_px": 6 },
    { "type": "text", "x": 26.0, "y": 1.5, "w": 32.4, "h": 9.6, "value": "{title}", "font": "bold", "size": 4.2, "min_size": 3.0, "max_lines": 2 },
    { "type": "text", "x": 26.0, "y": 15.0, "w": 32.4, "h": 5.2, "value": "MHD {best_before}", "font": "bold", "size": 4.2, "when": "best_before" },
    { "type": "line", "x1": 26.0, "y1": 20.8, "x2": 58.4, "y2": 20.8, "width": 0.25 }
  ]
}
```

| Schlüssel | Bedeutung |
|---|---|
| `media` | Material, für das die Vorlage gedacht ist: Breite der Rolle und Schnittlänge |
| `design` | Zeichenfläche, auf die sich alle Koordinaten beziehen. Der Renderer skaliert sie gleichmäßig auf die druckbare Fläche des Druckers und zentriert sie. So passt dieselbe Vorlage auf jede Auflösung. |
| `elements` | Elemente in Zeichenreihenfolge |

Elemente:

| `type` | Felder | Verhalten |
|---|---|---|
| `text` | `x`, `y`, `w`, `h`, `value`, `font` (`regular`, `bold`, `mono`), `size`, `min_size` (= `size`), `max_lines` (1), `align` (`left`, `center`, `right`), `valign` (`top`, `middle`, `bottom`) | Der Text wird im Kasten umbrochen. Passt er nicht, wird die Schrift in Schritten von 0,2 mm bis `min_size` verkleinert; reicht das nicht, endet die letzte Zeile mit „…". `size` ist die Schriftgröße in mm. |
| `qr` | `x`, `y`, `size`, `value`, `ec` (`L`, `M`, `Q`, `H`; Vorgabe `Q`), `quiet` (Ruhezone in Modulen, Vorgabe 4), `min_module_px` (Vorgabe 6) | Kleinste Version, die den Inhalt bei mindestens `ec` fasst. Modulgröße = größte ganze Pixelzahl, mit der Code samt Ruhezone in das Feld passt; der Code wird im Feld zentriert. Unter `min_module_px` scheitert das Rendern (`render_failed`). |
| `line` | `x1`, `y1`, `x2`, `y2`, `width` | Linie, mindestens 1 Pixel breit |
| `rect` | `x`, `y`, `w`, `h`, `fill` (false), `stroke` (0,25) | Rechteck, gefüllt oder als Rahmen |

Für alle Elemente:

- `value` setzt Daten über `{feld}` ein. Fehlende Felder sind leer. Geschweifte Klammern im Text werden verdoppelt (`{{`).
- `when: "feld"` zeichnet das Element nur, wenn `data[feld]` nicht leer ist.
- Unbekannte Elementtypen und ein unbekanntes `schema` lehnt der Renderer ab (`render_failed`), statt zu raten.
- Die Schriften liefert das Paket mit (frei lizenziert, in `print/stowly_print/fonts/`); auf dem Pi wird nichts nachinstalliert.

## 4. Etiketten des Haushalts (`PrintJob`)

Ob ein Etikett noch aussteht, sollen alle Geräte sehen. Deshalb ist jedes Etikett ein synchronisierter Datensatz. Seine `id` ist zugleich die Kennung des Auftrags beim Druckdienst.

| Feld | Bedeutung |
|---|---|
| `id` | UUID, vom Gerät erzeugt |
| `kind` | `package` oder `zone` |
| `package_id` / `zone_id` | worum es geht; genau eines ist gesetzt |
| `printer_id` | ausdrücklich gewählter Drucker oder `null` |
| `state` | siehe unten |
| `error` | Fehlercode bei `failed` |
| `boot_id` | `boot_id` des Druckdienstes, der den Auftrag angenommen hat |
| `device_id` | Gerät, das das Etikett angefordert hat |
| `created_at`, `updated_at` | |

Zustände:

| `state` | Bedeutung | Endzustand |
|---|---|---|
| `pending` | angefordert, noch bei keinem Druckdienst angekommen: „ausstehend" | nein |
| `queued` | vom Druckdienst angenommen, wartet | nein |
| `printing` | wird gedruckt | nein |
| `printed` | gedruckt und vom Gerät bestätigt, oder vom Anwender bestätigt | ja |
| `sent` | an den Drucker übertragen; der Transport kann nicht bestätigen | ja |
| `failed` | sicher nicht gedruckt | ja |
| `unknown` | Ausgang offen (Verbindung oder Strom mitten im Druck weg): Die App fragt „Wurde das Etikett gedruckt?" | bis zur Antwort |
| `cancelled` | vom Anwender verworfen | ja |

Regeln:

- **Anfordern:** Befehl `print.request`. Beim Einlagern fordert die App je Packung ein Etikett an, wenn die Geräte-Einstellung „Etiketten" an ist. **Etiketten gibt es nur, wenn der Haushalt mindestens einen Drucker hat:** Ohne Drucker fordert die App keine an, sonst würden beim Einrichten des ersten Druckers alte Etiketten nachgedruckt.
- **Entnommen vor dem Druck:** Wird eine Packung entnommen, solange ihr Etikett noch `pending` ist, verwirft die App es (`print.report` mit `cancelled`). Wiederherstellen holt es nicht zurück; ein neues Etikett fordert der Anwender ausdrücklich an.
- **Fortschritt:** Das Gerät, das druckt, meldet jeden Zustandswechsel mit `print.report`. Druckt der Server selbst, schreibt er den Zustand zusätzlich direkt fort, damit er auch ankommt, wenn das Gerät inzwischen offline ist. Es gilt die jeweils jüngste Meldung, und sie gilt als Ganzes: Sie ersetzt Zustand, `printer_id`, `boot_id` und `error` so, wie sie im Befehl stehen; was sie nicht nennt, ist danach `null` ([`sync-protokoll.md`](sync-protokoll.md), 6.6). Wer meldet, schickt also den Drucker und die `boot_id` jedes Mal mit.
- **Ein neuer Versuch ist ein neues Etikett** mit neuer Kennung (`print.request`). Das alte bleibt, wie es ist. Ein Auftrag druckt nie zweimal.
- **Antwort auf die Nachfrage** bei `unknown`: „Ja" meldet `printed`, „Nein" meldet `failed` mit `error: "not_printed"`; danach bietet die App einen neuen Versuch an.
- **Welcher Drucker:** `PrintJob.printer_id`, sonst der Drucker der Zone (bei Packungen die Zone der Packung), sonst `HouseholdSettings.default_printer_id`. Gibt es keinen, bleibt das Etikett `pending`.
- Ein Etikett bleibt `pending`, solange es nachweislich bei keinem Druckdienst angekommen ist. Es wird später zugestellt: beim Start der App, nach jedem Sync, wenn ein Drucker wieder erreichbar ist, und auf Wunsch sofort.

### Drucker (`Printer`) und ihr Zustand (`PrinterStatus`)

| Feld | Bedeutung |
|---|---|
| `id`, `name` | |
| `connection` | `server`: der Server steuert den Drucker. `direct`: das Gerät spricht selbst mit einem Druckdienst. Ändert sich nie. |
| `server` | nur bei `server`: `driver` (`brother_ql`, `image`), `model` (z. B. `QL-820NWB`), `address` (`tcp://192.168.1.60:9100`, `usb://04f9:209b`), `media` (Rollenkennung des Treibers, z. B. `62`) |
| `direct` | nur bei `direct`: `urls` (Adressen in der Reihenfolge der Versuche), `token`, `printer` (Name des Druckers im Druckdienst oder `null`) |
| `created_at`, `updated_at`, `deleted_at` | |

`PrinterStatus` hält je Drucker fest, was zuletzt gesehen wurde: `printer_id`, `observed_at`, `boot_id`, `status` (`DriverStatus`), `host` (`HostHealth`, nur beim Pi). Der Pi kann sich nicht selbst melden; **das Handy bringt seinen Zustand beim nächsten Sync mit** (Befehl `printer.report`). Das Dashboard zeigt deshalb „zuletzt gesehen", keinen Herzschlag. Gemeldet wird nur, wenn der Dienst erreicht wurde; „nicht erreichbar" ist keine Meldung, sondern das Ausbleiben einer.

Das Token eines direkten Druckers steht im Sync, weil alle Geräte des Haushalts dort drucken sollen. Es steht nie im Ereignisprotokoll.

## 5. Protokoll des Druckdienstes

Dieselbe Schnittstelle am Server und am Pi. Datentypen: `print/stowly_print/model.py` (Quelle) und `ServiceJobRequest`, `ServiceJob`, `ServiceHealth`, `ServicePrinter`, `PrinterCapabilities`, `DriverStatus`, `HostHealth` in `web/src/contract/api.gen.ts`.

### 5.1 Adressen und Anmeldung

| | Server | Pi |
|---|---|---|
| Basis | `<Adresse der App>/print` | jede Adresse aus `Printer.direct.urls`, z. B. `https://10.71.83.1:8443` und `http://10.71.83.1:8080` |
| Token | das Geräte-Token | `Printer.direct.token` (fest, in der Konfiguration des Pi) |
| Lesende Aufrufe | brauchen das Token | offen |
| Schreibende Aufrufe | brauchen das Token | brauchen das Token |
| Name des Druckers im Auftrag (`printer`) | die `Printer.id` | `Printer.direct.printer`, `null` = Standarddrucker des Dienstes |

Das Token kommt entweder als `Authorization: Bearer <token>` oder im JSON-Rumpf als `"token"`. Der Vergleich läuft in konstanter Zeit.

### 5.2 Ohne Vorabanfrage zum Pi

Eine HTTPS-Seite, die einen anderen Ursprung anspricht, löst bei `PUT`, `DELETE`, einem `Authorization`-Kopf oder `Content-Type: application/json` eine CORS-Vorabanfrage aus. Auf dem Weg vom Handy zum Pi ist jede zusätzliche Anfrage eine zusätzliche Fehlerquelle. Deshalb gilt für den Pi:

- **Lesende Aufrufe sind einfache `GET` ohne eigene Kopfzeilen** und brauchen kein Token. Was sie liefern, ist nicht geheim; Auftragskennungen sind nicht zu erraten.
- **Schreibende Aufrufe sind `POST` mit `Content-Type: text/plain`**, der Rumpf ist JSON und enthält das Token. Der Dienst liest den Rumpf immer als JSON, gleich welcher `Content-Type` gesetzt ist.
- Für andere Aufrufer (curl, der Server selbst) nimmt der Dienst dieselben Aufrufe auch als `PUT`/`DELETE` mit `Authorization`-Kopf an.
- Der Dienst antwortet mit `Access-Control-Allow-Origin` genau für die in seiner Konfiguration genannten Ursprünge der App (und `Vary: Origin`), beantwortet Vorabanfragen (`OPTIONS`) trotzdem korrekt und setzt dabei auch `Access-Control-Allow-Private-Network: true`.

### 5.3 Aufrufe

| Aufruf | Zweck | Antwort |
|---|---|---|
| `GET /v1/health?nonce=<n>` | Erreichbarkeit, `boot_id`, Zustand des Rechners, Drucker mit Zustand | 200 `ServiceHealth` |
| `GET /v1/printers` | Fähigkeiten und Zustand aller Drucker | 200 `{ "printers": ServicePrinter[] }` |
| `POST /v1/jobs/{id}?wait=<s>` (auch `PUT`) | Auftrag einreichen | 201 `ServiceJob` (neu) oder 200 `ServiceJob` (schon bekannt) |
| `GET /v1/jobs/{id}?wait=<s>` | Zustand eines Auftrags | 200 `ServiceJob`; 404 `not_found` |
| `POST /v1/jobs/{id}/cancel` (auch `DELETE /v1/jobs/{id}`) | Auftrag verwerfen, solange er wartet | 200 `ServiceJob` mit `state: "failed"`, `error.code: "cancelled"`; 409 `not_cancellable` |
| `POST /v1/render` | Vorschau: `{ template, data, printer? }` rendern, ohne zu drucken | 200 `image/png` in der Größe des Druckers |
| `GET /v1/jobs/{id}/image` | das gerenderte Etikett eines Auftrags, nur beim Bild-Treiber | 200 `image/png`; 404 |

`wait` (0 bis 30 Sekunden, Vorgabe 0): Die Antwort wartet so lange auf einen Endzustand.

Auftrag (`ServiceJobRequest`):

```json
{
  "token": "…",
  "printer": null,
  "template": { "schema": 1, "…": "…" },
  "data": { "qr": "STOWLY/P/A2B3C", "id": "A2B3C", "title": "Basmati Reis", "…": "…" },
  "copies": 1,
  "cut": true,
  "expect_boot_id": "c0ffee00-…"
}
```

Entweder `template` und `data` oder `png`: ein fertiges 1-Bit-PNG in exakt passender Größe, Base64, als Notausgang. `copies` 1 bis 20. Geprüft wird die Nutzlast von `JobRequest.from_dict`.

Antwort (`ServiceJob`): `id`, `state` (`queued`, `printing`, `printed`, `sent`, `failed`, `unknown`), `printer`, `boot_id`, `error` (`{ code, message }` oder `null`), `position` (Platz in der Warteschlange, 0 = als Nächstes; sonst `null`).

Fehler haben denselben Rumpf wie am Server: `{ "error": { "code", "message", "details" } }`.

| HTTP | `code` | Wann |
|---|---|---|
| 400 | `invalid_request` | Nutzlast verletzt den Vertrag |
| 401 | `unauthorized` | Token fehlt oder ist falsch |
| 404 | `not_found` | Auftrag unbekannt |
| 404 | `unknown_printer` | diesen Drucker hat der Dienst nicht |
| 409 | `job_conflict` | dieselbe Kennung mit anderem Inhalt |
| 409 | `boot_mismatch` | `expect_boot_id` passt nicht; `details.boot_id` nennt die aktuelle |
| 409 | `not_cancellable` | der Auftrag wartet nicht mehr |
| 422 | `render_failed` | Vorlage oder Daten lassen sich nicht rendern |
| 503 | `queue_full` | zu viele wartende Aufträge |

### 5.4 Nie doppelt drucken

- **Derselbe Auftrag noch einmal** (gleiche Kennung, gleicher Inhalt): Der Dienst druckt nicht, sondern liefert den vorhandenen Zustand. Der Inhalt ist `printer`, `template`, `data`, `png`, `copies`, `cut` (`JobRequest.content_hash`); `token` und `expect_boot_id` gehören nicht dazu. Gleiche Kennung mit anderem Inhalt: 409 `job_conflict`.
- **Verworfene Aufträge bleiben bekannt** (`failed` / `cancelled`), damit eine verspätete Wiederholung nicht doch noch druckt.
- **Neustart:** Am Server liegt der Auftragsspeicher in einer Datei. Wartende Aufträge laufen nach einem Neustart weiter; ein Auftrag, der beim Absturz gerade druckte, wird `unknown`. Auf dem Pi liegt der Speicher im RAM und stirbt mit dem Strom. Deshalb trägt jede Antwort eine **`boot_id`**: am Pi bei jedem Start neu, am Server dauerhaft dieselbe.
- **`expect_boot_id`:** Die App fragt vor dem Einreichen den Zustand ab (`/v1/health`) und schickt die dabei gesehene `boot_id` mit, beim ersten Versuch und bei jeder Wiederholung. Hat der Dienst inzwischen neu gestartet, antwortet er mit 409 `boot_mismatch` und nimmt nichts an.
  - Hatte die App den Auftrag bis dahin **noch nie abgeschickt**, reicht sie ihn mit der neuen `boot_id` ein.
  - Hatte sie ihn **schon einmal abgeschickt** und keine Antwort bekommen, weiß niemand, ob gedruckt wurde: Das Etikett wird `unknown`, die App fragt nach.
- **Abgeschickt ohne Antwort** (Zeitüberschreitung, Verbindungsabbruch): Die App fragt später `GET /v1/jobs/{id}` ab. Kennt der Dienst den Auftrag (gleiche `boot_id`), gilt dessen Zustand. Ist die `boot_id` eine andere oder der Auftrag unbekannt: `unknown`.

### 5.5 Erreichbar und echt?

`GET /v1/health?nonce=<n>` mit einer frischen Zufallsfolge (16 bis 64 Zeichen aus `A–Z a–z 0–9 _ -`), Abbruch nach 1,5 Sekunden. Die Antwort enthält

```
proof = hex( HMAC-SHA256( Schlüssel = Token, Nachricht = nonce ) )
```

Die App rechnet nach (WebCrypto). So geht ein fremdes Gerät, das im falschen WLAN zufällig dieselbe Adresse hat, nicht als Drucker durch. Am Server entfällt die Prüfung: Dort bürgt die Verbindung selbst.

`ServiceHealth`: `app` (immer `"stowly-print"`), `version`, `protocol` (derzeit 1), `boot_id`, `uptime_s`, `proof`, `host` (`HostHealth` oder `null`), `printers`.

Was der Rechner ehrlich melden kann (`HostHealth`, jedes Feld darf `null` = unbekannt sein): `uptime_s`, `temperature_c`, `throttled`, `undervoltage` (auf der Pi-Zero-Reihe immer `null`, sie hat keinen Detektor), `storage_errors` und `storage_read_only` (nur Symptome der SD-Karte), `overlay_used_pct`, `memory_available_mb`.

Zustand eines Druckers (`DriverStatus`): `reachable`, `ready`, `media_detected` (jeweils `null` = lässt sich nicht feststellen), `errors` mit diesen Codes: `no_media`, `media_mismatch`, `cover_open`, `cutter_jam`, `overheated`, `busy`, `offline`, `unknown`.

### 5.6 Der Weg vom Handy zum Pi

Die App versucht die Adressen aus `Printer.direct.urls` der Reihe nach. Vorgesehen sind zwei:

1. **HTTPS** mit einem Zertifikat auf die IP-Adresse des Pi, ausgestellt von einer Zertifizierungsstelle, der die Geräte vertrauen. Der robuste Weg für beide Plattformen, auf dem iPhone der einzige.
2. **HTTP** an die private IP-Adresse. Geht nur in Chrome ab 142 (Android und Desktop) über Local Network Access: Die App setzt `targetAddressSpace: "local"`, der Browser fragt einmal je Ursprung um Erlaubnis. Die erste Anfrage muss von einer Seite kommen, nicht vom Service Worker; die Nachfrage kann jederzeit kommen und abgelehnt werden.

Erreicht die App den Dienst auf keinem Weg, bleibt das Etikett `pending`. Als Notbehelf von Hand liefert der Pi unter `GET /p` eine eigene Seite, die einen Auftrag aus dem Fragment der Adresse liest (`http://<ip>/p#<Auftrag>`) und selbst einreicht.

Angesprochen wird der Pi immer über seine IP-Adresse, nie über einen Namen: In seinem WLAN gibt es keine Namensauflösung, auf die Verlass wäre.

## 6. Treiber-Schnittstelle

Ein Treiber ist eine Druckersprache auf einem Transport (`print/stowly_print/drivers/base.py`):

```python
class Driver(Protocol):
    def capabilities(self) -> Capabilities: ...   # dpi, media, cutter, colors, status_query, confirms_print
    def status(self) -> DriverStatus: ...          # reachable, ready, media_detected, errors
    def print(self, image, cut=True) -> PrintOutcome: ...   # "printed" | "sent" | "failed"
```

- `capabilities()` spricht das Gerät nicht an: Der Renderer braucht die Werte auch, wenn der Drucker aus ist.
- `status()` wirft nicht; ein nicht erreichbares Gerät ist `reachable=False`.
- `print()` bekommt ein 1-Bit-Bild in exakt passender Größe und blockiert, bis das Ergebnis feststeht. `printed` nur, wenn das Gerät bestätigt hat (Brother über USB); `sent`, wenn der Transport nur schreiben kann (Brother über TCP 9100); `failed`, wenn sicher nichts gedruckt wurde. Bricht der Vorgang mittendrin ab und ist der Ausgang offen, wirft die Methode: Der Auftrag wird `unknown`.
- Vorgesehene Treiber: `brother_ql` (über `brother_ql_next`, fest gepinnt und nur in diesem Modul importiert), `image` (schreibt PNG), später `zpl`.

Das Paket `stowly_print` darf weder FastAPI noch pydantic voraussetzen und muss unter Python 3.12 und 3.13 laufen: Auf dem Pi gibt es `pydantic-core` nicht als fertiges Paket. Der Dienst baut auf Starlette und uvicorn aus den Systempaketen von Raspberry Pi OS (Starlette 0.46); der Server bringt über FastAPI eine neuere Starlette mit. Verwendet werden darf nur, was es in beiden gibt.
