# Sync-Protokoll

Verbindlicher Vertrag zwischen dem Stowly-Server (`server/`) und der Web-App (`web/`) für Stufe 1. Er legt fest, welche Daten es gibt, wie Geräte Änderungen melden, wie der Server Konflikte entscheidet und was beide Seiten voneinander erwarten dürfen.

Die Datentypen stehen zusätzlich als Code bereit (Abschnitt 14). Wo dieses Dokument und der Code voneinander abweichen, ist das ein Fehler im Vertrag und wird dem Coordinator gemeldet, nicht stillschweigend ausgelegt.

Etiketten, QR-Inhalte und der Druckdienst stehen in [`etiketten.md`](etiketten.md).

## 1. Grundsätze

1. **Der Server hält den maßgeblichen Bestand.** Jedes Gerät arbeitet auf einer lokalen Kopie und funktioniert ohne Netz.
2. **Jede Änderung ist ein Befehl.** Die App schreibt die Änderung sofort in ihre lokale Kopie und legt denselben Vorgang als Befehl in ihre Outbox. Der Server führt jeden Befehl höchstens einmal aus.
3. **Ein einziger Aufruf gleicht ab:** `POST /api/sync` schickt die wartenden Befehle und holt alle Änderungen seit dem letzten Stand.
4. **Jede Packung ist ein eigener Datensatz mit eigener ID.** Es gibt keine Zählerstände. Einlagern legt Datensätze an, Entnehmen markiert sie. Gruppierung, Gesamtmenge und kritischstes MHD entstehen erst in der Anzeige.
5. **Nichts Synchronisiertes wird physisch gelöscht.** Datensätze werden markiert (`removed_at`, `deleted_at`). Eine vergebene Packungs-ID wird nie wiederverwendet.
6. **Konflikte entscheidet der Server nach festen Regeln** (Abschnitt 7). Die App zeigt danach, was der Server liefert.

## 2. Schreibweise

- JSON, UTF-8. Feldnamen in `snake_case`, auf beiden Seiten gleich: keine Übersetzungsschicht.
- **Kennungen:** UUID v4 in kanonischer Schreibweise (klein, mit Bindestrichen) für Produkte, Zonen, Drucker, Etiketten, Geräte und Befehle. Die App erzeugt sie selbst. `crypto.randomUUID` gibt es nur in sicheren Kontexten; `newUuid()` aus `web/src/contract/ids.ts` fällt auf `crypto.getRandomValues` zurück.
- **Packungs-IDs:** genau 5 Zeichen aus `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (32 Zeichen, kein I, L, O, U; 33.554.432 Kombinationen), immer groß. Bei Eingabe von Hand werden Leerraum und Bindestriche entfernt, Kleinbuchstaben groß, `O` zu `0`, `I` und `L` zu `1`; `U` bleibt ungültig.
- **Barcodes:** nur Ziffern, 8 oder 13 Stellen (EAN-8, EAN-13) mit gültiger Prüfziffer. UPC-A (12 Stellen) wird mit führender `0` gespeichert. Codes mit Präfix `2` sind ladenintern: Sie werden gespeichert, aber nie nachgeschlagen.
- **Zeitstempel:** siehe Abschnitt 4.
- Gemeinsame Beispiele für beide Seiten: [`vectors.json`](vectors.json).

## 3. Datenmodell

Alle Datensätze kommen im Sync immer vollständig, nie als Differenz. Felder mit `| null` dürfen `null` sein; alle Felder sind immer vorhanden.

### 3.1 Produkt (`Product`)

| Feld | Typ | Bedeutung |
|---|---|---|
| `id` | UUID | |
| `name` | Text, 0–120 | Leer = noch unbekannt (Platzhalter). Die App zeigt dann den ersten Barcode (`productTitle()`). |
| `brand` | Text, 0–80 | |
| `quantity` | Text, 0–40 | Packungsgröße als Text, z. B. `500 g` |
| `image` | Text \| null | Bild-ID für `GET /api/images/{id}` |
| `warn_days` | Zahl 0–3650 \| null | Vorlaufzeit der MHD-Warnung; `null` = Haushaltswert |
| `lookup` | `none` \| `pending` \| `found` \| `not_found` | Stand bei Open Food Facts (Abschnitt 10) |
| `barcodes` | Liste | Alle Barcodes, aufsteigend sortiert. Ein Barcode gehört zu genau einem Produkt. |
| `created_at`, `updated_at` | Zeitstempel | |
| `deleted_at` | Zeitstempel \| null | Gesetzt = in einem anderen Produkt aufgegangen |
| `merged_into` | UUID \| null | Zielprodukt der Zusammenführung |

Produkte ohne Packungen bleiben bestehen: Sie merken sich, was hinter einem Barcode steckt. Ein eigenes „Produkt löschen" gibt es in Stufe 1 nicht.

### 3.2 Packung (`Package`)

| Feld | Typ | Bedeutung |
|---|---|---|
| `id` | Packungs-ID | Steht als Klartext und QR-Code auf dem Etikett |
| `product_id` | UUID | |
| `zone_id` | UUID | |
| `best_before` | Datum \| null | MHD; `null` = keines. Immer ein voller Tag: Bei „03/2027" der letzte Tag des Monats. |
| `created_at` | Zeitstempel | Zeitpunkt des Einlagerns |
| `updated_at` | Zeitstempel | |
| `removed_at` | Zeitstempel \| null | Gesetzt = entnommen; die Packung steht in der Lösch-Historie |
| `removal_reason` | `consumed` \| `discarded` \| `mistake` \| null | verbraucht, entsorgt, falsch erfasst |
| `displaced` | Objekt \| null | Verdrängte Bearbeitung (Abschnitt 7.2): `{ "at": Zeitstempel, "changes": [{ "field": "best_before" \| "zone_id" \| "product_id", "value": Text \| null }] }` |

**Warnstufen** (einheitlich für alle Ansichten, `expiryState()` in `web/src/contract/mhd.ts`): „Heute" ist der Kalendertag in der Zeitzone des Geräts. Eine Packung ist **abgelaufen**, wenn ihr MHD vor heute liegt, und **läuft bald ab**, wenn es in 0 bis `warn_days` Tagen erreicht ist. `warn_days` ist der Wert des Produkts, sonst der des Haushalts.

### 3.3 Zone (`Zone`)

| Feld | Typ | Bedeutung |
|---|---|---|
| `id` | UUID | |
| `name` | Text, 1–60 | |
| `icon` | Text | Schlüssel aus `ZONE_ICONS` (`web/src/ui/base/zones.tsx`); Unbekanntes wird als `box` gezeigt |
| `color` | Text \| null | Schlüssel aus `ZONE_COLORS`; `null` = Akzentfarbe |
| `sort` | Zahl | Reihenfolge, aufsteigend; bei Gleichstand nach Name |
| `printer_id` | UUID \| null | Drucker für Etiketten dieser Zone; `null` = Standarddrucker |
| `created_at`, `updated_at` | Zeitstempel | |
| `deleted_at` | Zeitstempel \| null | Gesetzt = gelöscht |
| `moved_to` | UUID \| null | Bei gelöschten Zonen: wohin ihre Packungen verschoben wurden |

Es gibt immer mindestens eine nicht gelöschte Zone. Eine neue Datenbank enthält die Zone „Vorrat". Gibt es nur eine, blendet die Oberfläche alles zu Zonen aus.

### 3.4 Einstellungen des Haushalts (`HouseholdSettings`)

Ein einziger Datensatz für alle Geräte.

| Feld | Typ | Vorgabe | Bedeutung |
|---|---|---|---|
| `zone_mode` | `primary` \| `equal` | `primary` | Primärzone: Ein Zonenwechsel gilt für genau einen Einlager-Vorgang. Gleichwertig: Er bleibt bestehen. |
| `primary_zone_id` | UUID \| null | erste Zone | |
| `warn_days` | Zahl 0–3650 | 14 | Vorlaufzeit der MHD-Warnung |
| `trash_retention_days` | Zahl 1–3650 | 30 | Aufbewahrungsdauer der Lösch-Historie |
| `default_printer_id` | UUID \| null | null | Drucker für Zonen ohne eigenen |
| `updated_at` | Zeitstempel | | |

Verweise auf Zonen und Drucker in Einstellungen und Zonen prüft der Server nicht. Zeigt ein Verweis ins Leere oder auf etwas Gelöschtes, gilt er als `null` (Primärzone: die erste Zone der Reihenfolge).

Einstellungen einzelner Geräte (Thema, Akzentfarbe, Ton, Kamera) werden nicht synchronisiert und gehören nicht zu diesem Protokoll.

### 3.5 Drucker, Druckerzustand, Etiketten, Vorlagen

`Printer`, `PrinterStatus`, `PrintJob` und `LabelTemplate` sind Teil des Sync und in [`etiketten.md`](etiketten.md) beschrieben.

## 4. Umgang mit Zeit

- **Zeitstempel** sind immer UTC, ISO 8601, genau drei Nachkommastellen und `Z`: `2026-11-13T10:15:30.123Z`. Das ist das Format von `new Date().toISOString()`. Es lässt sich als Text vergleichen und sortieren. Andere Schreibweisen (Zeitzonen-Offset, andere Genauigkeit) sind ungültig.
- **Datum** (MHD) ist `YYYY-MM-DD`: ein Kalendertag ohne Uhrzeit und ohne Zeitzone.
- **Der Server vertraut nie der absoluten Uhr eines Geräts, nur dem Alter eines Befehls.** Jeder Befehl trägt `at` (Geräteuhr im Moment der Änderung), jede Sync-Anfrage `sent_at` (Geräteuhr im Moment des Absendens). Der Server rechnet:

  ```
  alter      = max(0, sent_at − at)
  wirksam    = empfangszeit_des_servers − alter
  ```

  `wirksam` ist der Zeitpunkt, mit dem der Server arbeitet: Er entscheidet Konflikte und steht in `created_at`, `updated_at`, `removed_at` und im Ereignisprotokoll. Eine falsch gehende Geräteuhr verfälscht so nichts, solange sie zwischen Änderung und Absenden nicht springt; `wirksam` liegt nie in der Zukunft. Referenz: `effective_time()` in `server/stowly/contract/timeutil.py`, Beispiele in `vectors.json`.
- **Innerhalb einer Anfrage laufen die wirksamen Zeitpunkte nie rückwärts:** Ein Befehl bekommt mindestens den wirksamen Zeitpunkt des Befehls, der in derselben Anfrage vor ihm steht (`wirksam = max(wirksam, wirksam des Vorgängers)`). Die Reihenfolge der Outbox ist die Reihenfolge, in der der Anwender gehandelt hat; sie bleibt so auch erhalten, wenn die Geräteuhr dazwischen zurückgestellt wurde. Sonst verlöre etwa ein „Rückgängig" gegen das Entnehmen unmittelbar davor. `effective_time()` bleibt die Rechnung für einen einzelnen Befehl; die Untergrenze setzt der Sync-Ablauf.
- Alle Zeitstempel, die die App vom Server bekommt, sind Serverzeit. Für die Anzeige rechnet die App in die Zeitzone des Geräts um.
- Der Raspberry Pi im Keller hat keine Uhr. Was er meldet, trägt keine Uhrzeit; die Zeit einer Beobachtung setzt das Handy (Befehl `printer.report`, Feld `at`).

## 5. Anmeldung und Geräte-Token

Es gibt ein Haushalts-Passwort und beliebig viele Geräte. Jedes Gerät bekommt bei der Anmeldung ein eigenes Token, das sich einzeln sperren lässt.

- Das Passwort steht in der Umgebungsvariable `STOWLY_PASSWORD` des Servers. Es gibt keinen Endpunkt, der es ohne Anmeldung setzt oder ändert. Ist die Variable leer, meldet `GET /api/health` `configured: false`, und die Anmeldung antwortet mit 503 `not_configured`. Ein geändertes Passwort lässt bestehende Geräte angemeldet.
- **Token:** 32 zufällige Bytes, URL-sicheres Base64 ohne Füllzeichen. Der Server speichert nur den SHA-256-Hash (hex). Das Token läuft nicht ab.
- **Senden:** bei jedem Aufruf außer den ausdrücklich offenen als `Authorization: Bearer <token>`. Fehlt es, ist es unbekannt oder gesperrt: 401 `unauthorized`. Die App wechselt dann nach `signed_out` mit Grund `revoked`, behält ihre Daten und ihre Outbox und sendet nach erneuter Anmeldung weiter.
- Bearer-Token statt Cookie, weil es über HTTP und HTTPS, hinter jedem Proxy und im Entwicklungsserver gleich funktioniert, keinen CSRF-Schutz braucht und der Service Worker es aus IndexedDB lesen kann.

| Aufruf | Anmeldung | Anfrage | Antwort |
|---|---|---|---|
| `POST /api/auth/login` | offen | `LoginRequest { password, device_name }` | 200 `LoginResponse { token, device }` |
| `POST /api/auth/logout` | Token | – | 204; das eigene Token ist gesperrt |
| `GET /api/devices` | Token | – | 200 `DeviceList { devices }`, auch gesperrte, das eigene mit `current: true` |
| `PATCH /api/devices/{device_id}` | Token | `DeviceUpdate { name }` | 200 `Device` |
| `DELETE /api/devices/{device_id}` | Token | – | 204; sperrt das Token dieses Geräts. Wiederholbar. Unbekannt: 404. |

Fehler der Anmeldung: 401 `invalid_password`; 429 `rate_limited` mit Kopfzeile `Retry-After` und `details.retry_after_s`; 503 `not_configured`. Der Passwortvergleich läuft in konstanter Zeit. Nach 5 Fehlversuchen innerhalb von 5 Minuten lehnt der Server 60 Sekunden lang jede Anmeldung ab. Die Sperre gilt für alle, nicht je Adresse: Hinter einem Reverse Proxy ist die Adresse des Aufrufers nicht verlässlich.

Jedes angemeldete Gerät darf jedes Gerät umbenennen und sperren, auch sich selbst. `last_seen_at` aktualisiert der Server beim Sync.

## 6. Sync-Aufruf

`POST /api/sync` mit Token. Rumpf `SyncRequest`, Antwort `SyncResponse`.

### 6.1 Anfrage

```json
{
  "protocol": 1,
  "dataset_id": "8c0b4b0e-6c1a-4f2e-9f0a-2d5b7c9e1a34",
  "cursor": 1234,
  "sent_at": "2026-11-13T10:15:31.000Z",
  "commands": [
    { "id": "3f2b8c1e-5a47-4d09-9b6e-0c1d2e3f4a5b", "at": "2026-11-13T10:15:30.123Z",
      "type": "package.remove", "package_id": "A2B3C", "reason": "consumed" }
  ],
  "id_pool": { "have": 287 },
  "app_version": "0.1.0"
}
```

| Feld | Bedeutung |
|---|---|
| `protocol` | Protokollversion der App, derzeit `1` |
| `dataset_id` | Wert der letzten Antwort; `null` beim ersten Sync |
| `cursor` | Wert der letzten Antwort; `0` beim ersten Sync |
| `sent_at` | Geräteuhr im Moment des Absendens |
| `commands` | Befehle in der Reihenfolge ihrer Entstehung, höchstens 500. Hat die Outbox mehr, folgen weitere Aufrufe. |
| `id_pool.have` | Wie viele unbenutzte Packungs-IDs das Gerät noch hat |
| `app_version` | optional, nur zur Diagnose |

### 6.2 Ablauf im Server

Der ganze Aufruf läuft in **einer** Transaktion (`BEGIN IMMEDIATE`): entweder ist alles verbucht und beantwortet oder nichts.

1. Token prüfen (401). `protocol` prüfen: ungleich `1` ergibt 409 `protocol_mismatch` mit `details: { "server": 1, "client": n }`.
2. Rahmen prüfen: `dataset_id`, `cursor`, `sent_at`, `id_pool` und dass `commands` eine Liste von Objekten mit gültiger `id` ist. Sonst 422 `invalid_request`. Mehr als 500 Befehle: 413 `payload_too_large`.
3. **Jeden Befehl einzeln** in Reihenfolge verarbeiten (Abschnitt 6.3). Ein einzelner ungültiger oder fehlschlagender Befehl lässt nie die ganze Anfrage scheitern: Sonst bliebe die Outbox des Geräts für immer stecken.
4. Änderungen seit `cursor` einsammeln (Abschnitt 6.4). Die Wirkung der eben verarbeiteten Befehle ist darin enthalten.
5. Packungs-IDs zuteilen (Abschnitt 8).

### 6.3 Verarbeitung eines Befehls

1. Ist die `id` schon in der Tabelle `commands`, wird nichts ausgeführt. Das Ergebnis ist das gespeicherte von damals mit `duplicate: true`.
2. Der Befehl wird gegen den Katalog geprüft (`Command`, Abschnitt 6.6). Unbekannte `type`, fehlende oder zusätzliche Felder, falsche Formate: Ergebnis `rejected` mit `code: "invalid"`.
3. Der wirksame Zeitpunkt wird berechnet (Abschnitt 4).
4. Der Befehl wird in einem eigenen Sicherungspunkt ausgeführt. Wirft die Ausführung unerwartet, wird der Sicherungspunkt zurückgerollt; das Ergebnis ist `rejected` mit `code: "internal"`, der Fehler steht im Server-Log.
5. Befehl und Ergebnis werden in `commands` gespeichert, die Wirkung im Ereignisprotokoll vermerkt (Abschnitt 12).

Ergebnis je Befehl (`CommandResult`), in der Reihenfolge der Anfrage:

| Feld | Bedeutung |
|---|---|
| `id` | Kennung des Befehls |
| `status` | `applied` (ausgeführt), `displaced` (traf eine entnommene Packung, Abschnitt 7.2), `rejected` (nicht ausgeführt) |
| `code` | nur bei `rejected`: `invalid`, `not_found`, `id_conflict`, `last_zone`, `internal` |
| `message` | deutscher Klartext zum `code` oder `null` |
| `duplicate` | `true`, wenn der Befehl schon bekannt war; `status` ist dann das Ergebnis von damals |

`applied` heißt: verarbeitet. Einzelne Felder können dabei gegen neuere Änderungen verloren haben (Abschnitt 7.1); das ist kein Fehler und wird nicht gemeldet.

Der Server hebt verarbeitete Befehle mindestens 90 Tage auf.

### 6.4 Antwort

```json
{
  "protocol": 1,
  "dataset_id": "8c0b4b0e-6c1a-4f2e-9f0a-2d5b7c9e1a34",
  "server_time": "2026-11-13T10:15:31.412Z",
  "results": [
    { "id": "3f2b8c1e-5a47-4d09-9b6e-0c1d2e3f4a5b", "status": "applied", "code": null, "message": null, "duplicate": false }
  ],
  "reset": false,
  "changes": {
    "products": [], "zones": [], "packages": [ { "id": "A2B3C", "…": "…" } ],
    "printers": [], "printer_status": [], "print_jobs": [], "label_templates": [],
    "settings": null
  },
  "cursor": 1240,
  "has_more": false,
  "id_pool": { "grant": ["7K9QX", "…"], "target": 300 }
}
```

- **`changes`** enthält jeden Datensatz, der sich seit `cursor` geändert hat, vollständig und in seinem aktuellen Zustand. `settings` ist `null`, wenn unverändert. Technisch: Jede Zeile trägt den Stand der Änderungsfolge (`rev`) ihres letzten Schreibens; geliefert wird alles mit `rev > cursor`.
- **`cursor`** schickt die App beim nächsten Aufruf zurück. Für die App ist er eine undurchsichtige Zahl.
- **`has_more`:** Eine Antwort enthält höchstens 5000 Datensätze. Bei `true` ruft die App sofort erneut ab (ohne Befehle, mit dem neuen `cursor`), bis `false` kommt. Verweise können zwischen den Seiten vorübergehend ins Leere zeigen; die App wendet deshalb alle Seiten gemeinsam an (Abschnitt 9). Beim Blättern geht nichts verloren: Der gelieferte `cursor` ist immer ein Stand, bis zu dem die Antworten zusammen alles enthalten, über alle Tabellen hinweg. Tragen mehrere Zeilen denselben `rev` (ein Befehl, der viele Packungen auf einmal verschiebt), endet eine Seite nie mitten in diesem `rev`; sie darf dafür größer als 5000 werden.
- **`dataset_id`** kennzeichnet den Datenbestand. **`reset: true`** kommt, wenn die `dataset_id` der Anfrage nicht die des Servers ist (auch beim ersten Sync) oder der `cursor` der Anfrage größer ist als der Stand des Servers. Die Antwort ist dann ein vollständiger Abzug ab `cursor = 0`; die App leert ihre Kopie vorher (Abschnitt 9.3).
- **Was ein vollständiger Abzug weglässt:** Eine Antwort mit `reset: true` enthält keine entnommenen Packungen, deren `removed_at` länger zurückliegt als `trash_retention_days`, und keine Etiketten in einem Endzustand (`printed`, `sent`, `failed`, `cancelled`), deren `updated_at` länger als 30 Tage zurückliegt. **Jede andere Antwort liefert ausnahmslos alles mit `rev > cursor`, egal wie alt**, auch die Folgeseiten eines Abzugs. Ein Gerät, das länger offline war als die Aufbewahrungsdauer, muss erfahren, dass eine Packung inzwischen entnommen oder ein Etikett erledigt ist: Sonst zeigte es die Packung für immer im Bestand und stellte das Etikett noch einmal zu. Die App verwirft beides nach derselben Regel, beim Empfang und beim Start; was sie so verwirft, verschwindet auch dann aus ihrer Kopie, wenn es dort bis eben noch als Bestand oder als ausstehend geführt war. Gelöschte Zonen und zusammengeführte Produkte kommen immer mit: Die App braucht sie, um alten Verweisen zu folgen.
- **Längere Aufbewahrung:** Vergrößert sich `trash_retention_days` in der Kopie der App (durch eine eigene Änderung oder durch eine Antwort), holt sie den Bestand beim nächsten Abgleich einmal vollständig neu (`dataset_id: null`, `cursor: 0`; der Server antwortet mit `reset: true`). Nur so reicht ihre Lösch-Historie wieder so weit zurück wie die des Servers.

### 6.5 Protokollversion

Derzeit `1`. Jede Änderung, die eine ältere App oder einen älteren Server falsch arbeiten ließe, erhöht die Version. Bei Abweichung antwortet der Server mit 409 `protocol_mismatch`; die App sendet dann nicht weiter und fordert zum Aktualisieren auf. Ihre Outbox bleibt erhalten.

### 6.6 Katalog der Befehle

Jeder Befehl hat `id` (UUID, vom Gerät erzeugt), `at` (Geräteuhr im Moment der Änderung) und `type`. Unbekannte Felder sind ein Fehler (`invalid`). Maßgeblich für Feldnamen und Formate ist `server/stowly/contract/commands.py`.

**`changes`-Objekte** ändern nur die Schlüssel, die im JSON vorhanden sind. `null` ist dort ein Wert („MHD entfernen"), kein „nicht angegeben". Felder, die nie `null` sein dürfen, lehnen `null` ab.

| `type` | Nutzlast | Wirkung | Ablehnung |
|---|---|---|---|
| `product.create` | `product_id`, `name` (""), `brand` (""), `quantity` (""), `warn_days` (null), `barcodes` ([]) | Legt das Produkt an. Gehört einer der Barcodes schon einem anderen Produkt, entsteht es als Zusammenführung (7.3). Hat es einen nachschlagbaren Barcode, wird `lookup = pending` (Abschnitt 10). | `id_conflict` |
| `product.update` | `product_id`, `changes { name?, brand?, quantity?, warn_days? }` | Feldänderungen (7.1) | `not_found` |
| `product.add_barcode` | `product_id`, `barcode` | Ordnet den Barcode zu. Gehört er einem anderen Produkt, geht dieses im genannten auf (7.3). | `not_found` |
| `product.remove_barcode` | `product_id`, `barcode` | Entfernt die Zuordnung; ohne Wirkung, wenn sie nicht besteht | `not_found` |
| `product.merge` | `source_id`, `target_id` | Führt zusammen (7.3) | `not_found` |
| `package.create` | `package_id`, `product_id`, `zone_id`, `best_before` (null) | Legt die Packung an; `created_at` ist der wirksame Zeitpunkt | `id_conflict` (ID schon vergeben), `not_found` (Produkt, Zone) |
| `package.update` | `package_id`, `changes { best_before?, zone_id?, product_id? }` | Feldänderungen (7.1). Ist die Packung entnommen: `displaced` (7.2). | `not_found` |
| `package.remove` | `package_id`, `reason` | Entnimmt die Packung (7.2). Ist sie schon entnommen, ändert sich nur der Grund. | `not_found` |
| `package.restore` | `package_id`, `apply_displaced` (false) | Stellt wieder her (7.2); ohne Wirkung, wenn sie nicht entnommen ist | `not_found` |
| `zone.create` | `zone_id`, `name`, `icon` ("box"), `color` (null), `sort` (0), `printer_id` (null) | Legt die Zone an | `id_conflict` |
| `zone.update` | `zone_id`, `changes { name?, icon?, color?, sort?, printer_id? }` | Feldänderungen (7.1). Eine neue Reihenfolge sind mehrere `zone.update` mit `sort`. | `not_found` (auch gelöscht) |
| `zone.delete` | `zone_id`, `move_to` | Löscht die Zone und verschiebt ihre Packungen (7.4); ohne Wirkung, wenn sie schon gelöscht ist | `not_found`, `invalid` (`move_to` ist dieselbe Zone), `last_zone` |
| `settings.update` | `changes { zone_mode?, primary_zone_id?, warn_days?, trash_retention_days?, default_printer_id? }` | Feldänderungen (7.1) | – |
| `printer.create` | `printer_id`, `name`, `connection`, `server` oder `direct` | Legt den Drucker an | `id_conflict` |
| `printer.update` | `printer_id`, `changes { name?, server?, direct? }` | Feldänderungen (7.1); die Art der Verbindung ändert sich nie | `not_found` (auch gelöscht), `invalid` (Objekt passt nicht zur Verbindung) |
| `printer.delete` | `printer_id` | Markiert den Drucker als gelöscht und setzt Verweise in Zonen und Einstellungen auf `null`; ohne Wirkung, wenn schon gelöscht | `not_found` |
| `printer.report` | `printer_id`, `boot_id`, `status`, `host` | Ersetzt den zuletzt gesehenen Zustand, wenn die Beobachtung neuer ist als die gespeicherte | `not_found` |
| `print.request` | `job_id`, `kind`, `package_id` oder `zone_id`, `printer_id` (null) | Legt ein Etikett im Zustand `pending` an | `id_conflict`, `not_found` |
| `print.report` | `job_id`, `state`, `printer_id`, `boot_id`, `error` | Setzt den Zustand des Etiketts, wenn die Meldung neuer ist als die gespeicherte | `not_found` |

Alle Befehle des Katalogs gehören zum Sync von Anfang an, auch die für Drucker und Etiketten: Sie sind reine Datenhaltung. Gedruckt wird über den Druckdienst ([`etiketten.md`](etiketten.md)).

## 7. Konfliktregeln

### 7.1 Feldänderungen: der spätere Zeitstempel gewinnt

Für jedes änderbare Feld jedes Datensatzes merkt sich der Server den wirksamen Zeitpunkt der zuletzt angewendeten Änderung (Tabelle `field_clocks`). Eine Änderung mit wirksamem Zeitpunkt `t` wird angewendet, wenn es für das Feld noch keine Uhr gibt oder `t >= uhr`; danach ist `uhr = t`. Bei `t < uhr` bleibt das Feld, wie es ist.

- Entschieden wird **je Feld**: Ändert ein Gerät das MHD und ein anderes die Zone derselben Packung, gelten beide Änderungen.
- Bei gleichem Zeitpunkt gewinnt, was der Server später verarbeitet.
- Der überschriebene Wert steht im Ereignisprotokoll (`old`), ebenso eine Änderung, die verloren hat (`superseded`).
- `updated_at` eines Datensatzes ist der späteste wirksame Zeitpunkt einer angewendeten Änderung.

Felder mit dieser Regel: Produkt `name`, `brand`, `quantity`, `warn_days`; Packung `best_before`, `zone_id`, `product_id`; Zone `name`, `icon`, `color`, `sort`, `printer_id`; jede Einstellung; Drucker `name`, `server`, `direct` (das Objekt als Ganzes); Etikett: Zustand samt `printer_id`, `boot_id`, `error` als ein Feld; Druckerzustand als Ganzes.

### 7.2 Löschen gewinnt gegen Bearbeiten

Die Packung ist physisch weg, also zählt das Entnehmen mehr als eine gleichzeitige Bearbeitung.

- **Entnehmen und Wiederherstellen** teilen sich eine eigene Uhr (`removed`). `package.remove` und `package.restore` wirken, wenn ihr Zeitpunkt nicht vor dieser Uhr liegt. Der spätere der beiden gewinnt, unabhängig von der Reihenfolge ihres Eintreffens.
- **`package.update` auf eine entnommene Packung** wird nicht angewendet, egal welchen Zeitpunkt die Bearbeitung trägt. Der Server legt die gewünschten Feldwerte in `Package.displaced` ab und antwortet mit `status: "displaced"`. Kommen mehrere solche Bearbeitungen, wird je Feld die spätere behalten.
- Die Lösch-Historie zeigt die verdrängte Bearbeitung. **`package.restore` mit `apply_displaced: true`** stellt die Packung wieder her und wendet die verdrängten Werte mit dem Zeitpunkt des Wiederherstellens an. In jedem Fall ist `displaced` danach `null`.
- `removed_at` ist der wirksame Zeitpunkt des Entnehmens. `package.remove` auf eine schon entnommene Packung ändert nur `removal_reason` (so wird aus „verbraucht" nachträglich „entsorgt").

### 7.3 Ein Barcode, ein Produkt: Zusammenführen

Zwei Geräte können offline denselben unbekannten Barcode scannen und je einen Platzhalter anlegen. Der Server führt solche Produkte zusammen, statt einen Befehl abzulehnen.

Zusammenführen von `source` in `target` heißt:

1. Alle Packungen von `source`, auch entnommene, gehören danach zu `target`.
2. Alle Barcodes von `source` gehören danach zu `target`.
3. Leere Felder von `target` (`name`, `brand`, `quantity` leer, `warn_days` und `image` null) übernehmen den Wert von `source`.
4. `source` bekommt `deleted_at` und `merged_into = target` und hat keine Barcodes mehr.

Auslöser:

- `product.merge`: ausdrücklich durch den Anwender.
- `product.create` mit einem Barcode, der schon einem anderen Produkt gehört: Das neue Produkt entsteht sofort als `source`; `target` ist der Besitzer des ersten betroffenen Barcodes. Barcodes, die bereits einem dritten Produkt gehören, bleiben dort.
- `product.add_barcode` mit einem Barcode, der einem anderen Produkt gehört: Der bisherige Besitzer ist `source`, das genannte Produkt `target`.

**Verweise auf ein zusammengeführtes Produkt folgen `merged_into`**, auch über mehrere Schritte: Ein später eintreffendes `package.create` oder `product.update` mit der alten Kennung wirkt auf das Zielprodukt. Die App hält es genauso (`findProduct`).

Eine Zusammenführung lässt sich nicht rückgängig machen. Die App fragt deshalb nach, bevor sie `product.merge` sendet; kennt sie einen Barcode schon bei einem anderen Produkt, sendet sie nicht `product.add_barcode`, sondern meldet `barcode_taken`.

### 7.4 Zonen löschen

`zone.delete` verschiebt alle Packungen der Zone, auch entnommene, nach `move_to`, setzt `deleted_at` und `moved_to` und stellt die Primärzone um, falls sie die gelöschte war. Die letzte Zone lässt sich nicht löschen (`last_zone`).

**Verweise auf eine gelöschte Zone folgen `moved_to`**, auch über mehrere Schritte: Ein später eintreffendes `package.create` oder `package.update` mit der alten Zone landet in der Zielzone. `zone.update` auf eine gelöschte Zone wird abgelehnt (`not_found`).

### 7.5 Doppelte Kennungen

Legt ein Befehl etwas mit einer Kennung an, die es schon gibt, wird er abgelehnt (`id_conflict`). Bei UUIDs passiert das praktisch nie. Bei Packungs-IDs ist es der Fall, der nicht still geheilt werden darf: Das Etikett ist bereits gedruckt. Die App zeigt die Ablehnung in den Sync-Problemen; der Anwender lagert die Packung neu ein und ersetzt das Etikett.

## 8. ID-Vorrat

Eine gedruckte ID lässt sich nicht mehr ändern, also dürfen zwei Geräte offline nie dieselbe vergeben.

- Bei jedem Sync füllt der Server den Vorrat des Geräts auf: Er teilt `max(0, 300 − have)` neue IDs zu (`id_pool.grant`), zufällig gewählt, nicht in `packages` vorhanden und für kein Gerät reserviert, und merkt sie in `id_reservations`.
- Die App speichert den Vorrat und entnimmt für jede neue Packung eine ID. `have` ist die Zahl der noch unbenutzten.
- **Vorrat leer** (offline mehr als 300 Packungen ohne einen einzigen Sync): Die App erzeugt Zufalls-IDs (`randomPackageId()`). Ein Zusammenstoß ist dann möglich, aber unwahrscheinlich, und endet in `id_conflict` (7.5).
- Die Reservierung schützt nur davor, dass der Server eine ID zweimal zuteilt. Wer eine freie ID zuerst anlegt, bekommt sie, gleich welches Gerät sie reserviert hatte; die Reservierung verfällt mit dem Anlegen. So scheitern auch die wartenden Befehle eines Geräts nicht, das sich nach einer Sperre neu anmelden musste.
- Geht eine Antwort verloren, sind die darin zugeteilten IDs verschenkt. Das ist bei 33,5 Millionen Kombinationen unerheblich.
- Bei `reset: true` verwirft die App ihren Vorrat und nimmt den neuen aus dieser Antwort.

## 9. Pflichten der App

### 9.1 Lokale Kopie und Outbox

- Jede Änderung schreibt die App sofort in ihre lokale Kopie und als Befehl in die Outbox, beides in einer Transaktion.
- Die Outbox wird in der Reihenfolge der Entstehung gesendet, höchstens 500 Befehle je Aufruf. Ein Befehl verlässt sie erst, wenn sein Ergebnis da ist.
- **Was die App anzeigt, ist immer: Stand des Servers plus die noch nicht bestätigten Befehle, in ihrer Reihenfolge.** Nach jeder Antwort übernimmt die App die gelieferten Datensätze und wendet die Befehle, die inzwischen neu in der Outbox stehen, erneut darauf an. Bestätigte Befehle stecken bereits in den gelieferten Datensätzen.

### 9.2 Ergebnisse

| Ergebnis | Die App |
|---|---|
| `applied` | entfernt den Befehl aus der Outbox |
| `displaced` | entfernt ihn und zeigt ihn unter den Sync-Problemen („liegt in der Lösch-Historie") |
| `rejected` | entfernt ihn und zeigt ihn unter den Sync-Problemen mit `code`. Ihre lokale Kopie folgt wieder dem Server: Was nur wegen dieses Befehls da war, verschwindet. |
| 401 | wechselt nach `signed_out` / `revoked`, behält Daten und Outbox |
| 409 `protocol_mismatch` | sendet nicht weiter, fordert zum Aktualisieren auf |
| Netzfehler, 5xx | lässt alles, wie es ist, und versucht es später erneut |

### 9.3 Antwort anwenden

1. Bei `has_more` weiter abrufen und alle Seiten sammeln.
2. In einer lokalen Transaktion: bei `reset` zuerst alle synchronisierten Tabellen und den ID-Vorrat leeren (Outbox, Geräte-Einstellungen und Token bleiben); dann alle Datensätze übernehmen; `dataset_id`, `cursor` und den zugeteilten ID-Vorrat speichern.
3. Entnommene Packungen jenseits der Aufbewahrungsdauer und alte abgeschlossene Etiketten verwerfen (Abschnitt 6.4), auch wenn sie eben erst geliefert wurden.
4. Die verbliebenen Befehle der Outbox erneut auf die lokale Kopie anwenden.
5. Hat sich `trash_retention_days` vergrößert: den Bestand beim nächsten Abgleich vollständig neu holen (Abschnitt 6.4).

Die Oberfläche muss Verweise aushalten, die ins Leere zeigen (Produkt oder Zone noch nicht da): Sie zeigt dann einen Platzhalter, keinen Fehler.

### 9.4 Wann abgeglichen wird

- beim Start der App und nach der Anmeldung,
- wenn der Browser `online` meldet,
- wenn die App wieder sichtbar wird (`visibilitychange`),
- nach jeder lokalen Änderung, zusammengefasst über höchstens 2 Sekunden,
- alle 60 Sekunden, solange die App sichtbar ist,
- auf Android zusätzlich im Hintergrund (Background Sync, Kennung `stowly-sync`); Safari kann das nicht,
- solange ein Produkt `lookup = pending` hat: zusätzlich nach 3, 10 und 30 Sekunden (Abschnitt 10).

Es läuft immer nur ein Abgleich je Gerät, auch über mehrere Tabs und den Service Worker hinweg (Web Locks, Name `stowly-sync`, wo vorhanden). Nach einem Fehlschlag wartet die App 2, 5, 15, dann 60 Sekunden.

### 9.5 Ist der Server erreichbar?

`navigator.onLine` meldet auf jeder Verbindung `true`, auch im WLAN des Pi ohne Internet. Nur `false` ist verlässlich. Die App prüft deshalb selbst: `GET /api/health` mit `cache: "no-store"`, Abbruch nach 3 Sekunden, und die Antwort gilt nur, wenn `app === "stowly"` ist.

### 9.6 Bilder

Nach einem Abgleich lädt die App die Bilder der Produkte im Bestand, die sie noch nicht hat, in ihren Cache (`GET /api/images/{id}`), damit sie im Keller ohne Netz erscheinen.

## 10. Open Food Facts

Unbekannte Barcodes werden nie im Vordergrund nachgeschlagen: Das Produkt entsteht sofort als Platzhalter, der Server ergänzt Name und Bild später. Das gilt offline wie online, weil Open Food Facts nur 15 Abfragen je Minute und Adresse erlaubt.

- **Wann:** Ein Produkt mit mindestens einem nicht ladeninternen Barcode bekommt beim Anlegen `lookup = pending`. Der Server arbeitet die Wartenden im Hintergrund ab, höchstens 10 Abfragen je Minute.
- **Abruf:** `GET {STOWLY_OFF_URL}/api/v3/product/{barcode}?product_type=all&lc=de&fields=product_name_de,product_name,brands,quantity,image_front_small_url` mit `User-Agent: Stowly/<Version>`, ergänzt um `(<Kontakt>)`, wenn `STOWLY_OFF_CONTACT` gesetzt ist. Im Code steht nie eine persönliche Adresse.
- **Ergebnis:** Gefunden: `lookup = found`. 404 mit `product_not_found`: `lookup = not_found`, endgültig. Netzfehler, 429 und 5xx: Das Produkt bleibt `pending`; neue Versuche nach 1 Minute, 5 Minuten, 30 Minuten, 3 Stunden, danach täglich.
- **Übernahme:** Die Daten füllen **nur leere Felder** des Produkts (`name` aus `product_name_de`, sonst `product_name`; `brand` aus dem ersten Eintrag von `brands`; `quantity`; `image`). Die Uhren der Felder bleiben unberührt: Jede Eingabe eines Anwenders gewinnt, davor wie danach.
- **Bild:** Der Server lädt `image_front_small_url` einmal herunter (nur JPEG, PNG, WebP, höchstens 300 KB) und speichert es in der Datenbank. Die Bild-ID ist der Anfang des SHA-256 des Inhalts (32 Hex-Zeichen) plus Endung, z. B. `9f2c…e1.jpg`.
- **Dauerhaft:** Jedes Ergebnis steht in `off_lookups` und wird nie erneut abgefragt. Die Tabelle ist von `products` getrennt, damit die Daten trennbar bleiben (ODbL). Die App nennt die Quelle: „Open Food Facts (ODbL)".
- `STOWLY_OFF_ENABLED=0` schaltet das Nachschlagen ab; Produkte bekommen dann `lookup = none`.
- Tests rufen den echten Dienst nie auf.

## 11. Weitere Endpunkte

Alle Pfade, Parameter und Schemata stehen maschinenlesbar in [`openapi.json`](openapi.json).

| Aufruf | Anmeldung | Antwort |
|---|---|---|
| `GET /api/health` | offen | 200 `ServerHealth { app: "stowly", status: "ok", version, protocol, time, configured }`, `Cache-Control: no-store` |
| `GET /api/images/{image_id}` | offen | 200 Bilddaten, `Cache-Control: public, max-age=31536000, immutable`; 404 |
| `GET /api/backup` | Token | 200 `application/vnd.sqlite3`, `Content-Disposition: attachment; filename="stowly-JJJJ-MM-TT.sqlite3"` |
| `GET /api/events?before=&limit=&entity=&entity_id=` | Token | 200 `EventPage { events, next_before }`, neueste zuerst, `limit` 1–500 (Vorgabe 100) |
| `/print/v1/…` | Token | Druckdienst des Servers, siehe [`etiketten.md`](etiketten.md) |

- **Bilder sind ohne Anmeldung abrufbar**, weil `<img>` keinen `Authorization`-Kopf senden kann. Die Kennung ist der Hash des Inhalts und nicht zu erraten; ausgeliefert werden nur Vorschaubilder aus Open Food Facts.
- **Sicherung:** eine in sich stimmige Kopie der ganzen Datenbank (`sqlite3.Connection.backup`). Die Kopie bekommt eine **neue `dataset_id`**. Wird sie später eingespielt (Server anhalten, Datei ersetzen, starten), antwortet der Server allen Geräten mit `reset: true`; sie holen den Bestand vollständig neu und senden ihre Outbox erneut. Befehle, die schon in der Sicherung stecken, erkennt der Server als bekannt.
- Unbekannte Pfade unter `/api` antworten mit 404 im Fehlerformat. Alles außerhalb von `/api` und `/print` liefert die Web-App (Datei oder `index.html`).

## 12. Ereignisprotokoll

Der Server schreibt zu jeder Wirkung eines Befehls mindestens einen Eintrag in `events`. Das Protokoll wird nie gekürzt und nicht an die Geräte synchronisiert; es ist die Grundlage für die Statistik „verbraucht/entsorgt" in Stufe 2 und über `GET /api/events` lesbar.

`EventRecord`: `id` (fortlaufend), `at` (wirksamer Zeitpunkt), `recorded_at` (Serverzeit beim Verbuchen), `device_id`, `command_id`, `type`, `entity`, `entity_id`, `data`.

| `type` | `entity` | `data` |
|---|---|---|
| `package.created` | `package` | `product_id`, `zone_id`, `best_before` |
| `package.updated` | `package` | `changes: { feld: { old, new } }`, `superseded: { feld: wert }` |
| `package.removed` | `package` | `reason`, `product_id`, `zone_id`, `best_before` |
| `package.reason_changed` | `package` | `old`, `new` |
| `package.restored` | `package` | `applied_displaced` |
| `package.edit_displaced` | `package` | `changes: { feld: wert }` |
| `product.created`, `product.updated` | `product` | wie bei Packungen |
| `product.barcode_added`, `product.barcode_removed` | `product` | `barcode` |
| `product.merged` | `product` (Ziel) | `source_id`, `reason`: `user` oder `barcode`, `packages`: Anzahl |
| `product.lookup` | `product` | `barcode`, `result`: `found` oder `not_found`, `filled`: Feldnamen |
| `zone.created`, `zone.updated` | `zone` | wie bei Packungen |
| `zone.deleted` | `zone` | `moved_to`, `packages`: Anzahl |
| `settings.updated` | `settings` (`entity_id`: `household`) | `changes`, `superseded` |
| `printer.created`, `printer.updated`, `printer.deleted` | `printer` | `changes` ohne Token |
| `print.requested`, `print.reported` | `print_job` | `kind`, `state`, `printer_id`, `error` |
| `device.login`, `device.revoked`, `device.renamed` | `device` | `name` |
| `command.rejected` | Art des Befehls | `code`, `type` |

`printer.report` erzeugt keinen Eintrag (zu häufig, kein bleibender Wert). Tokens und das Passwort stehen nie im Protokoll.

## 13. Fehlerformat

Jede Fehlerantwort unter `/api` hat denselben Rumpf (`ErrorBody`):

```json
{ "error": { "code": "invalid_password", "message": "Das Passwort stimmt nicht.", "details": null } }
```

| HTTP | `code` | Wann |
|---|---|---|
| 401 | `unauthorized` | Token fehlt, ist unbekannt oder gesperrt |
| 401 | `invalid_password` | falsches Haushalts-Passwort |
| 404 | `not_found` | Pfad oder Datensatz gibt es nicht |
| 405, 422 | `invalid_request` | Anfrage verletzt den Vertrag; bei 422 nennt `details.errors` die Stellen (`loc`, `msg`, `type`) |
| 409 | `conflict` | Zustand passt nicht zur Anfrage |
| 409 | `protocol_mismatch` | verschiedene Protokollversionen; `details: { server, client }` |
| 413 | `payload_too_large` | zu viele Befehle, zu großer Rumpf |
| 429 | `rate_limited` | zu viele Fehlversuche; `Retry-After`, `details.retry_after_s` |
| 500 | `internal` | Fehler im Server; Einzelheiten nur im Log |
| 501 | `not_implemented` | Endpunkt ist noch nicht umgesetzt |
| 503 | `not_configured` | `STOWLY_PASSWORD` ist nicht gesetzt |

`message` ist deutscher Klartext und als Rückfall anzeigbar. Die App unterscheidet nach `code` und zeigt dazu ihren eigenen Text. Im Server: `raise ApiError(status, ErrorCode.X, "…")` aus `stowly/errors.py`.

Die Ergebnisse einzelner Befehle (`CommandResult.code`) sind davon getrennt: Ein abgelehnter Befehl ist kein HTTP-Fehler.

## 14. Dieselben Typen auf beiden Seiten

**Die Quelle aller Datentypen ist Python:**

- `server/stowly/contract/` (pydantic): Datensätze, Befehle, Sync-Aufruf, Endpunkte, Fehlerformat, Etikett-Daten
- `print/stowly_print/model.py` (Dataclasses, ohne pydantic): Protokoll des Druckdienstes

Daraus entstehen mit `python -m stowly.contract.export`:

- [`docs/openapi.json`](openapi.json): alle Endpunkte und Schemata
- `web/src/contract/api.gen.ts`: dieselben Typen und Konstanten für die Web-App (`ENDPOINTS`, `PROTOCOL_VERSION`, `COMMAND_TYPES`, das ID-Alphabet, die QR-Präfixe)

Beide Dateien sind eingecheckt und werden nie von Hand geändert. Der Test `server/tests/test_contract.py::test_generated_files_are_current` schlägt fehl, sobald Modelle oder Endpunkte nicht mehr zu ihnen passen. **Eine Vertragsänderung ist also immer sichtbar:** Sie ändert die Modelle, beide erzeugten Dateien und dieses Dokument, und nur der Coordinator nimmt sie vor.

Regeln, die sich nicht als Typ ausdrücken lassen, gibt es als Funktionen auf beiden Seiten, geprüft gegen dieselben Beispiele in [`vectors.json`](vectors.json):

| Regel | Server | Web-App |
|---|---|---|
| Packungs-IDs, UUIDs | `stowly/contract/ids.py` | `web/src/contract/ids.ts` |
| QR-Inhalte | `stowly/contract/ids.py` | `web/src/contract/qr.ts` |
| Barcodes | `stowly/contract/ids.py` | `web/src/contract/barcode.ts` |
| Zeitstempel, wirksamer Zeitpunkt | `stowly/contract/timeutil.py` | `web/src/contract/time.ts` |
| MHD-Eingabe, Warnstufen | – | `web/src/contract/mhd.ts` |
| Etikett-Daten | `stowly/contract/labels.py` (nur Typ) | `web/src/contract/labels.ts` |

Die Schnittstelle zwischen Oberfläche und Offline-Kern steht in `web/src/contract/core.ts`.

## 15. Datenbankschema

Das Schema für die gesamte Stufe 1 steht in `server/stowly/migrations/0001_initial.sql` und ist Teil dieses Vertrags. Die Datei wird nicht mehr geändert; Ergänzungen kommen als weitere, nummerierte Migrationen. `stowly.db.migrate` wendet sie beim Start an und merkt sich den Stand in `PRAGMA user_version`.

| Tabelle | Inhalt |
|---|---|
| `meta` | Einzelwerte, vor allem `dataset_id` |
| `counters` | `rev` (Änderungsfolge), `settings_rev` |
| `devices` | Geräte mit Token-Hash, `last_seen_at`, `revoked_at` |
| `zones`, `products`, `product_barcodes`, `packages` | der Bestand |
| `field_clocks` | Uhr je Datensatz und Feld (7.1), dazu `removed` je Packung (7.2) |
| `settings` | Einstellungen des Haushalts, ein Schlüssel je Zeile |
| `commands` | jeder verarbeitete Befehl mit Ergebnis |
| `events` | Ereignisprotokoll |
| `id_reservations` | reservierte, noch unbenutzte Packungs-IDs |
| `off_lookups`, `images` | Open Food Facts: Warteschlange, Ergebnisse, Bilder |
| `printers`, `printer_status`, `print_jobs`, `label_templates` | Druck |

Regeln für jeden Zugriff (`stowly/db.py`):

- SQLite direkt über die Standardbibliothek, ohne ORM. Tabellen sind `STRICT`, Fremdschlüssel sind eingeschaltet, Journal im WAL-Modus.
- Jeder schreibende Ablauf läuft vollständig in `with db.transaction(con):` (`BEGIN IMMEDIATE`).
- Jedes Schreiben an einer synchronisierten Zeile setzt `rev = db.next_rev(con)`. Ohne das erfährt kein Gerät von der Änderung. Die Einstellungen teilen sich `counters.settings_rev`.
- Die erste Zone, die Einstellungen und die `dataset_id` legt `db.seed_defaults` beim ersten Start an.
