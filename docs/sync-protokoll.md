# Sync-Protokoll

Verbindlicher Vertrag zwischen dem Stowly-Server (`server/`) und der Web-App (`web/`), seit Stufe 2 in Protokollversion 2 (Abschnitt 6.5). Er legt fest, welche Daten es gibt, wie Geräte Änderungen melden, wie der Server Konflikte entscheidet und was beide Seiten voneinander erwarten dürfen.

Die Datentypen stehen zusätzlich als Code bereit (Abschnitt 14). Wo dieses Dokument und der Code voneinander abweichen, ist das ein Fehler im Vertrag und wird dem Coordinator gemeldet, nicht stillschweigend ausgelegt.

Etiketten, QR-Inhalte und der Druckdienst stehen in [`etiketten.md`](etiketten.md); Zeitplan, Sicherungen, Push, Home Assistant mit Bring!, der Sensor und die Umgebungsvariablen in [`integrationen.md`](integrationen.md).

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
- **Strenge Formen:** In Kennungen, Barcodes, Zeitstempeln und Datumsangaben sind Ziffern immer `0` bis `9`, keine vollbreiten oder anderen Schriften: Sonst gäbe es denselben Barcode in zwei Schreibweisen. Vor und nach dem Wert darf nichts stehen, auch kein Zeilenende. Nur die Eingabehilfen (`normalizePackageId`, `normalizeBarcode`, `parseQr`) entfernen Leerraum am Rand.
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
| `min_stock` | Zahl 1–999 \| null | Mindestbestand in Packungen; `null` = keiner. Zum Bestand zählt jede nicht entnommene Packung des Produkts, auch eine abgelaufene. Liegt er darunter, legt der Server einen Eintrag der Einkaufsliste an (7.6). Seit Protokoll 2. |
| `lookup` | `none` \| `pending` \| `found` \| `not_found` | Stand bei Open Food Facts (Abschnitt 10) |
| `barcodes` | Liste | Alle Barcodes, aufsteigend sortiert. Ein Barcode gehört zu genau einem Produkt. |
| `created_at`, `updated_at` | Zeitstempel | |
| `deleted_at` | Zeitstempel \| null | Gesetzt = in einem anderen Produkt aufgegangen |
| `merged_into` | UUID \| null | Zielprodukt der Zusammenführung |

Produkte ohne Packungen bleiben bestehen: Sie merken sich, was hinter einem Barcode steckt. Ein eigenes „Produkt löschen" gibt es auch in Stufe 2 nicht.

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
| `notify_time` | Text `"HH:MM"` | `"17:00"` | Uhrzeit der täglichen Push-Nachricht, `00:00` bis `23:59`, zweistellig. Sie gilt in der Zeitzone des Servers (`STOWLY_TIMEZONE`), nicht in der des Geräts ([`integrationen.md`](integrationen.md), Abschnitt 4.8). Seit Protokoll 2. |
| `updated_at` | Zeitstempel | | |

Verweise auf Zonen und Drucker in Einstellungen und Zonen prüft der Server nicht. Zeigt ein Verweis ins Leere oder auf etwas Gelöschtes, gilt er als `null` (Primärzone: die erste Zone der Reihenfolge).

Einstellungen einzelner Geräte (Thema, Akzentfarbe, Ton, Kamera) werden nicht synchronisiert und gehören nicht zu diesem Protokoll.

### 3.5 Drucker, Druckerzustand, Etiketten, Vorlagen

`Printer`, `PrinterStatus`, `PrintJob` und `LabelTemplate` sind Teil des Sync und in [`etiketten.md`](etiketten.md) beschrieben.

### 3.6 Einkaufsliste (`ShoppingItem`)

Seit Protokoll 2. Ein Eintrag hat ein Produkt oder freien Text, genau eines von beiden, und eine Menge, wenn man will. Er ist offen, erledigt oder gelöscht.

| Feld | Typ | Bedeutung |
|---|---|---|
| `id` | UUID | Eigene Einträge: vom Gerät erzeugt. Automatische: vom Server. |
| `product_id` | UUID \| null | Das Produkt; `null` = freier Text. Folgt Zusammenführungen (7.3): Der Server schreibt das Ziel hinein. |
| `text` | Text, 0–120 | Freier Text; leer genau dann, wenn `product_id` gesetzt ist |
| `quantity` | Zahl 1–999 \| null | Menge in Packungen; `null` = ohne Angabe. Bei `origin = min_stock` gehört sie dem Server: wie viele Packungen zum Mindestbestand fehlen („fehlt 2"), laufend nachgeführt (7.6). |
| `origin` | `manual` \| `min_stock` | `manual`: von einem Gerät angelegt („eigener Eintrag"). `min_stock`: vom Server, weil der Bestand unter dem Mindestbestand liegt („automatischer Eintrag"); immer mit Produkt. |
| `done_at` | Zeitstempel \| null | Gesetzt = erledigt: abgehakt, eingekauft, durch Einlagern erledigt (7.6) oder in Bring! abgehakt |
| `deleted_at` | Zeitstempel \| null | Gesetzt = gelöscht. Endgültig: Danach ändert kein Befehl mehr etwas daran. |
| `created_at`, `updated_at` | Zeitstempel | |

- **Offen** heißt: `done_at` und `deleted_at` sind `null`. Gelöscht geht vor erledigt: Ein Eintrag mit beidem ist gelöscht.
- Je Produkt gibt es höchstens einen offenen automatischen Eintrag (7.6). Eigene Einträge gibt es beliebig viele, auch neben einem automatischen.
- Gelöschte Einträge bleiben als Grabstein erhalten wie entnommene Packungen; erledigte und gelöschte fallen nach der Aufbewahrungsdauer aus einem vollständigen Abzug und von den Geräten (6.4, 9.3).
- Den Namen eines Eintrags zeigt die App selbst: bei einem Produkt dessen Name (`productTitle`), sonst den Text (`shoppingItemTitle` in `web/src/contract/shopping.ts`).

## 4. Umgang mit Zeit

- **Zeitstempel** sind immer UTC, ISO 8601, genau drei Nachkommastellen und `Z`: `2026-11-13T10:15:30.123Z`. Das ist das Format von `new Date().toISOString()`. Es lässt sich als Text vergleichen und sortieren. Andere Schreibweisen (Zeitzonen-Offset, andere Genauigkeit) sind ungültig.
- **Datum** (MHD) ist `YYYY-MM-DD`: ein Kalendertag ohne Uhrzeit und ohne Zeitzone.
- Gültig sind auf beiden Seiten die Jahre `0001` bis `9999`, immer vierstellig geschrieben. Das Jahr `0000` gibt es nicht: Der Kalender des Servers kennt es nicht.
- **Der Server vertraut nie der absoluten Uhr eines Geräts, nur dem Alter eines Befehls.** Jeder Befehl trägt `at` (Geräteuhr im Moment der Änderung), jede Sync-Anfrage `sent_at` (Geräteuhr im Moment des Absendens). Der Server rechnet:

  ```
  alter      = max(0, sent_at − at)
  wirksam    = empfangszeit_des_servers − alter
  ```

  `wirksam` ist der Zeitpunkt, mit dem der Server arbeitet: Er entscheidet Konflikte und steht in `created_at`, `updated_at`, `removed_at` und im Ereignisprotokoll. Eine falsch gehende Geräteuhr verfälscht so nichts, solange sie zwischen Änderung und Absenden nicht springt; `wirksam` liegt nie in der Zukunft. Referenz: `effective_time()` in `server/stowly/contract/timeutil.py`, Beispiele in `vectors.json`. Ein unmögliches Alter begrenzt der Server: `wirksam` liegt nie vor dem 1. Januar 2000 (eine um Jahrzehnte verstellte Geräteuhr ließe die Rechnung sonst aus dem darstellbaren Bereich laufen).
- **Die wirksamen Zeitpunkte eines Geräts laufen nie rückwärts, auch nicht über mehrere Anfragen hinweg:** Ein Befehl bekommt mindestens den wirksamen Zeitpunkt des letzten gültigen Befehls, den der Server zuvor von demselben Gerät verarbeitet hat (`wirksam = max(wirksam, wirksam des Vorgängers)`). Der Vorgänger ist der Befehl davor in derselben Anfrage, für den ersten Befehl einer Anfrage der letzte aus der vorigen. Die Reihenfolge der Outbox ist die Reihenfolge, in der der Anwender gehandelt hat, und sie bleibt so erhalten:
  - wenn die Geräteuhr zwischen zwei Änderungen zurückgestellt wurde,
  - wenn eine Anfrage lange unterwegs war. `wirksam` enthält die Laufzeit der Anfrage: Ein „Entnehmen", das fünf Sekunden unterwegs war, schlüge sonst das „Rückgängig", das zwei Sekunden später entstand und in einer schnellen zweiten Anfrage kam.

  Einzelheiten: „Gerät" ist die Anmeldung, also das Token; nach erneuter Anmeldung beginnt die Untergrenze neu. Ein Befehl, der schon an der Form scheitert (`invalid`), hat keinen wirksamen Zeitpunkt und zählt nicht als Vorgänger; jeder andere zählt, auch ein abgelehnter. Ein schon bekannter Befehl (`duplicate`) zählt mit seinem Zeitpunkt von damals. Die Untergrenze reicht höchstens bis zur Empfangszeit der Anfrage, `wirksam` liegt also weiterhin nie in der Zukunft (das greift nur, wenn die Uhr des Servers inzwischen zurückgestellt wurde). Zwischen verschiedenen Geräten gibt es keine Untergrenze: Dort entscheidet allein das Alter. `effective_time()` bleibt die Rechnung für einen einzelnen Befehl; die Untergrenze setzt der Sync-Ablauf und merkt sie je Gerät (`devices.last_command_at`).
- Alle Zeitstempel, die die App vom Server bekommt, sind Serverzeit. Für die Anzeige rechnet die App in die Zeitzone des Geräts um.
- Der Raspberry Pi im Keller hat keine Uhr. Was er meldet, trägt keine Uhrzeit; die Zeit einer Beobachtung setzt das Handy (Befehl `printer.report`, Feld `at`).

## 5. Anmeldung und Geräte-Token

Es gibt ein Haushalts-Passwort und beliebig viele Geräte. Jedes Gerät bekommt bei der Anmeldung ein eigenes Token, das sich einzeln sperren lässt.

- **Das Passwort** kommt aus der Umgebungsvariable `STOWLY_PASSWORD` oder wird beim ersten Aufruf in der App gesetzt (11.6). Die Variable geht vor: Ist sie gesetzt, übernimmt der Server sie beim Start als Hash in die Datenbank (`meta.password_hash`). Wird sie später entfernt, gilt das Passwort weiter; es entsteht nie wieder ein offenes Fenster für ein „erstes Passwort".
  - Gibt es noch keines (weder Variable noch Hash), meldet `GET /api/health` `configured: false`. Die Anmeldung antwortet dann mit 503 `not_configured`, und die App zeigt die Einrichtung.
  - Ohne Anmeldung setzt nur `POST /api/setup/password` ein Passwort, und das nur, solange es keines gibt (11.6).
  - **Oder eine Sicherung beim ersten Start** (11.9): Solange es kein Passwort gibt, lässt sich ohne Anmeldung eine Sicherung zurückspielen; sie bringt ihr Passwort mit (oder ein neues, wenn sie keines hat). Erstes Passwort und dieses Zurückspielen schließen sich aus: Liegt eine Sicherung bereit, antwortet `POST /api/setup/password` mit 409; ist inzwischen ein Passwort gesetzt, antwortet `POST /api/restore/apply` ohne Token mit 409. Beides prüft der Server unter dem Lock der Bremse, genau einer gewinnt.
  - Ändern geht angemeldet mit `POST /api/auth/password` und dem bisherigen Passwort, außer es kommt aus der Umgebung (409). Ein geändertes Passwort lässt bestehende Geräte angemeldet.
  - Gespeichert wird nur ein scrypt-Hash, nie das Passwort selbst. Der Rückfall `stowly` des Entwicklungsmodus (`--dev`) gilt wie `STOWLY_PASSWORD` (`configured`, 409 beim Setzen und Ändern, `password_source: env`), wird aber nie gespeichert.
  - Ändern zwei Geräte das Passwort zugleich, gewinnt das erste; das zweite bekommt 409 `conflict` und versucht es mit dem neuen Passwort noch einmal.
- **Token:** 32 zufällige Bytes, URL-sicheres Base64 ohne Füllzeichen. Der Server speichert nur den SHA-256-Hash (hex). Das Token läuft nicht ab.
- **Senden:** bei jedem Aufruf außer den ausdrücklich offenen als `Authorization: Bearer <token>`. Fehlt es, ist es unbekannt oder gesperrt: 401 `unauthorized`. Die App wechselt dann nach `signed_out` mit Grund `revoked`, behält ihre Daten und ihre Outbox und sendet nach erneuter Anmeldung weiter.
- Bearer-Token statt Cookie, weil es über HTTP und HTTPS, hinter jedem Proxy und im Entwicklungsserver gleich funktioniert, keinen CSRF-Schutz braucht und der Service Worker es aus IndexedDB lesen kann.

| Aufruf | Anmeldung | Anfrage | Antwort |
|---|---|---|---|
| `POST /api/auth/login` | offen | `LoginRequest { password, device_name }` | 200 `LoginResponse { token, device }` |
| `POST /api/auth/logout` | Token | – | 204; das eigene Token ist gesperrt |
| `POST /api/setup/password` | offen, nur solange es kein Passwort gibt | `SetupPasswordInput { password, device_name }` | 200 `LoginResponse { token, device }`; 409 `conflict`, 400, 429 (11.6) |
| `POST /api/auth/password` | Token | `PasswordChangeInput { current_password, new_password }` | 204; 401 `invalid_password` (das Gerät bleibt angemeldet), 409 `conflict` aus der Umgebung, 429 |
| `GET /api/devices` | Token | – | 200 `DeviceList { devices }`, auch gesperrte, das eigene mit `current: true` |
| `PATCH /api/devices/{device_id}` | Token | `DeviceUpdate { name }` | 200 `Device` |
| `DELETE /api/devices/{device_id}` | Token | – | 204; sperrt das Token dieses Geräts. Wiederholbar. Unbekannt: 404. |

Fehler der Anmeldung: 401 `invalid_password`; 429 `rate_limited` mit Kopfzeile `Retry-After` und `details.retry_after_s`; 503 `not_configured`. Dieselbe Bremse zählt auch das falsche bisherige Passwort beim Ändern, das Passwort beim Zurückspielen (11.9) und beim Hinzufügen eines Schlüssels der Sicherung (11.7) und gilt für das Setzen des ersten Passworts. Der Passwortvergleich läuft in konstanter Zeit. Nach 5 Fehlversuchen innerhalb von 5 Minuten lehnt der Server 60 Sekunden lang jede Anmeldung ab, auch eine mit dem richtigen Passwort. Die Sperre gilt für alle, nicht je Adresse: Hinter einem Reverse Proxy ist die Adresse des Aufrufers nicht verlässlich. Die Fehlversuche bleiben über die Sperre hinaus im Fenster von 5 Minuten stehen: Wer danach weiter falsch rät, löst mit jedem Versuch sofort die nächste Sperre aus. Eine gelungene Anmeldung setzt den Zähler zurück. Der Stand liegt im Arbeitsspeicher des Servers und beginnt mit seinem Start neu. Geräte, die schon angemeldet sind, berührt die Sperre nicht.

Jedes angemeldete Gerät darf jedes Gerät umbenennen und sperren, auch sich selbst; die App meldet ein Gerät, das sich selbst sperrt, sofort ab (`signed_out` / `revoked`). `last_seen_at` ist nach der Anmeldung `null`; der Server schreibt es beim Sync fort, höchstens einmal je Minute.

Die App meldet ein Gerät erst an, wenn auch der erste Abgleich gelungen ist: Dann liegen Zonen und Einstellungen vor. Scheitert er, bleibt das Gerät abgemeldet, und die App sperrt das eben ausgestellte Token wieder.

## 6. Sync-Aufruf

`POST /api/sync` mit Token. Rumpf `SyncRequest`, Antwort `SyncResponse`.

### 6.1 Anfrage

```json
{
  "protocol": 2,
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
| `protocol` | Protokollversion der App, derzeit `2` (Abschnitt 6.5) |
| `dataset_id` | Wert der letzten Antwort; `null` beim ersten Sync |
| `cursor` | Wert der letzten Antwort; `0` beim ersten Sync |
| `sent_at` | Geräteuhr im Moment des Absendens |
| `commands` | Befehle in der Reihenfolge ihrer Entstehung, höchstens 500. Hat die Outbox mehr, folgen weitere Aufrufe. |
| `id_pool.have` | Wie viele unbenutzte Packungs-IDs das Gerät noch hat |
| `app_version` | optional, nur zur Diagnose |

### 6.2 Ablauf im Server

Der ganze Aufruf läuft in **einer** Transaktion (`BEGIN IMMEDIATE`): entweder ist alles verbucht und beantwortet oder nichts.

1. Die Anfrage prüfen, in dieser Reihenfolge; die erste Verletzung bestimmt die Antwort:
   - Token (401 `unauthorized`).
   - `protocol` ist eine Zahl ungleich `2`: 409 `protocol_mismatch` mit `details: { "server": 2, "client": n }`.
   - Mehr als 500 Befehle: 413 `payload_too_large`.
   - Der Rahmen: `protocol`, `dataset_id`, `cursor`, `sent_at`, `id_pool` und dass `commands` eine Liste von Objekten mit gültiger `id` ist. Sonst 422 `invalid_request`, auch wenn `protocol` fehlt oder keine Zahl ist.

   Ein Rumpf über 4 MiB wird schon davor mit 413 abgewiesen, auch ohne `Content-Length` (etwa `chunked`); 500 Befehle bleiben weit darunter. Ein Rumpf, der kein JSON ist oder tiefer als 32 Ebenen verschachtelt, ergibt 422.
2. Feststellen, ob die Antwort ein vollständiger Abzug wird (`reset`, Abschnitt 6.4). Das entscheidet der Stand **vor** den Befehlen dieser Anfrage: Sie heben ihn selbst an und überdeckten sonst einen `cursor`, der dem Server voraus ist.
3. **Jeden Befehl einzeln** in Reihenfolge verarbeiten (Abschnitt 6.3). Ein einzelner ungültiger oder fehlschlagender Befehl lässt nie die ganze Anfrage scheitern: Sonst bliebe die Outbox des Geräts für immer stecken. Streikt dagegen die Datenbank selbst (Platte voll, E/A-Fehler), scheitert die ganze Anfrage mit 500, nichts ist verbucht, und das Gerät versucht es später erneut.
4. Änderungen seit `cursor` einsammeln (Abschnitt 6.4). Die Wirkung der eben verarbeiteten Befehle ist darin enthalten.
5. Packungs-IDs zuteilen (Abschnitt 8).

### 6.3 Verarbeitung eines Befehls

1. Ist die `id` schon in der Tabelle `commands`, wird nichts ausgeführt. Das Ergebnis ist das gespeicherte von damals mit `duplicate: true`.
2. Der Befehl wird gegen den Katalog geprüft (`Command`, Abschnitt 6.6). Unbekannte `type`, fehlende oder zusätzliche Felder, falsche Formate: Ergebnis `rejected` mit `code: "invalid"`. Dazu zählt auch, was der Form nach stimmt und trotzdem nichts bezeichnet: ein Zeitpunkt oder Datum, das es nicht gibt, ein Barcode mit falscher Prüfziffer.
3. Der wirksame Zeitpunkt wird berechnet, mit der Untergrenze des Geräts (Abschnitt 4).
4. Der Befehl wird in einem eigenen Sicherungspunkt ausgeführt. Wirft die Ausführung unerwartet, wird der Sicherungspunkt zurückgerollt; das Ergebnis ist `rejected` mit `code: "internal"`, der Fehler steht im Server-Log. Was der Server aus dem Befehl selbst ableitet (die Einkaufsliste nach 7.6), gehört in denselben Sicherungspunkt: Es gilt mit dem Befehl oder gar nicht.
5. Befehl und Ergebnis werden in `commands` gespeichert, die Wirkung im Ereignisprotokoll vermerkt (Abschnitt 12).

Ergebnis je Befehl (`CommandResult`), in der Reihenfolge der Anfrage:

| Feld | Bedeutung |
|---|---|
| `id` | Kennung des Befehls |
| `status` | `applied` (ausgeführt), `displaced` (traf eine entnommene Packung, Abschnitt 7.2), `rejected` (nicht ausgeführt) |
| `code` | nur bei `rejected`: `invalid`, `not_found`, `id_conflict`, `last_zone`, `internal` |
| `message` | deutscher Klartext zum `code`; nur bei `rejected` gesetzt, sonst `null` |
| `duplicate` | `true`, wenn der Befehl schon bekannt war; `status` ist dann das Ergebnis von damals |

`applied` heißt: verarbeitet. Einzelne Felder können dabei gegen neuere Änderungen verloren haben (Abschnitt 7.1); das ist kein Fehler und wird nicht gemeldet.

**Echo:** Jeder ausgeführte Befehl (`applied` oder `displaced`) gibt dem Datensatz, den er anspricht, einen neuen Stand der Änderungsfolge, auch wenn sich dadurch nichts geändert hat (das Feld hat verloren, der Befehl blieb ohne Wirkung). Das Gerät bekommt so in derselben Antwort den Stand des Servers und muss nicht raten, ob seine lokale Vorwegnahme noch stimmt. Ein abgelehnter Befehl liefert nichts zurück; seine Wirkung verschwindet aus der Anzeige, sobald er die Outbox verlässt (Abschnitt 9.1).

Der Server hebt verarbeitete Befehle mindestens 90 Tage auf.

### 6.4 Antwort

```json
{
  "protocol": 2,
  "dataset_id": "8c0b4b0e-6c1a-4f2e-9f0a-2d5b7c9e1a34",
  "server_time": "2026-11-13T10:15:31.412Z",
  "results": [
    { "id": "3f2b8c1e-5a47-4d09-9b6e-0c1d2e3f4a5b", "status": "applied", "code": null, "message": null, "duplicate": false }
  ],
  "reset": false,
  "changes": {
    "products": [], "zones": [], "packages": [ { "id": "A2B3C", "…": "…" } ],
    "printers": [], "printer_status": [], "print_jobs": [], "label_templates": [],
    "shopping_items": [ { "id": "6a1f…", "origin": "min_stock", "quantity": 1, "…": "…" } ],
    "settings": null
  },
  "cursor": 1240,
  "has_more": false,
  "id_pool": { "grant": ["7K9QX", "…"], "target": 300 },
  "lookup_enabled": true
}
```

- **`changes`** enthält jeden Datensatz, der sich seit `cursor` geändert hat, vollständig und in seinem aktuellen Zustand. `settings` ist `null`, wenn unverändert. Technisch: Jede Zeile trägt den Stand der Änderungsfolge (`rev`) ihres letzten Schreibens; geliefert wird alles mit `rev > cursor`.
- **Was der Server selbst schreibt** (automatische Einträge der Einkaufsliste, Erledigtes aus Bring!, 7.6), kommt als gewöhnliche Änderung: Die Zeile bekommt einen neuen `rev`, und das nächste `changes` jedes Geräts enthält sie. Was ein Befehl auslöst, steht schon in der Antwort auf den Sync, der ihn gebracht hat (Schritt 4 von 6.2 kommt nach den Befehlen). Was ein Hintergrund-Ablauf schreibt (der Abgleich mit Bring!), kommt mit dem nächsten Abgleich. Die App nimmt nichts davon vorweg und braucht keine eigene Behandlung: Für sie ist es Stand des Servers.
- **`cursor`** schickt die App beim nächsten Aufruf zurück. Für die App ist er eine undurchsichtige Zahl.
- **`has_more`:** Eine Antwort enthält höchstens 5000 Datensätze. Bei `true` ruft die App sofort erneut ab, bis `false` kommt: ohne Befehle, mit `dataset_id` und `cursor` der Seite davor; als `have` nennt sie ihren Vorrat einschließlich dessen, was dieser Abgleich schon zugeteilt hat. Meldet eine Folgeseite selbst `reset: true` (der Bestand hat mitten im Blättern gewechselt), wendet die App nichts davon an und beginnt den Abgleich neu. Verweise können zwischen den Seiten vorübergehend ins Leere zeigen; die App wendet deshalb alle Seiten gemeinsam an (Abschnitt 9). Beim Blättern geht nichts verloren: Der gelieferte `cursor` ist immer ein Stand, bis zu dem die Antworten zusammen alles enthalten, über alle Tabellen hinweg. Tragen mehrere Zeilen denselben `rev` (ein Befehl, der viele Packungen auf einmal verschiebt), endet eine Seite nie mitten in diesem `rev`; sie darf dafür größer als 5000 werden.
- **`dataset_id`** kennzeichnet den Datenbestand. **`reset: true`** kommt, wenn die `dataset_id` der Anfrage nicht die des Servers ist (auch beim ersten Sync) oder der `cursor` der Anfrage größer ist als der Stand des Servers vor den Befehlen dieser Anfrage. Die Antwort ist dann ein vollständiger Abzug ab `cursor = 0`; die App leert ihre Kopie vorher (Abschnitt 9.3). Die Befehle der Anfrage sind trotzdem verarbeitet, ihre Wirkung steckt im Abzug. Eine neue Kennung bekommt der Bestand mit jeder Sicherung (Abschnitt 11), beim Zurückspielen in der App und beim Rückgängig (11.9) und mit `python -m stowly --new-dataset`, nachdem eine Kopie der Datenbank auf anderem Weg zurückgespielt wurde.
- **Was ein vollständiger Abzug weglässt:** Eine Antwort mit `reset: true` enthält keine entnommenen Packungen, deren `removed_at` länger zurückliegt als `trash_retention_days`, keine Einträge der Einkaufsliste, die länger als `trash_retention_days` erledigt oder gelöscht sind (gemessen am späteren von `done_at` und `deleted_at`), und keine Etiketten in einem Endzustand (`printed`, `sent`, `failed`, `cancelled`), deren `updated_at` länger als 30 Tage zurückliegt. **Jede andere Antwort liefert ausnahmslos alles mit `rev > cursor`, egal wie alt**, auch die Folgeseiten eines Abzugs. Ein Gerät, das länger offline war als die Aufbewahrungsdauer, muss erfahren, dass eine Packung inzwischen entnommen, ein Eintrag erledigt oder ein Etikett erledigt ist: Sonst zeigte es die Packung für immer im Bestand, den Eintrag auf der Liste und stellte das Etikett noch einmal zu. Die App verwirft alles drei nach derselben Regel, beim Empfang und beim Start; was sie so verwirft, verschwindet auch dann aus ihrer Kopie, wenn es dort bis eben noch als Bestand, offen oder ausstehend geführt war. Gelöschte Zonen und zusammengeführte Produkte kommen immer mit: Die App braucht sie, um alten Verweisen zu folgen.
- **`lookup_enabled`** sagt in jeder Antwort, ob dieser Server unbekannte Barcodes bei Open Food Facts nachschlägt (`STOWLY_OFF_ENABLED`, Abschnitt 10). Die App merkt sich den Wert über Neustarts und richtet danach, was sie verspricht und vorwegnimmt; bis zur ersten Antwort gilt er als unbekannt und wird wie „eingeschaltet" behandelt. Beim Abmelden vergisst sie ihn.
- **Längere Aufbewahrung:** Vergrößert sich `trash_retention_days` in der Kopie der App (durch eine eigene Änderung oder durch eine Antwort), holt sie den Bestand beim nächsten Abgleich einmal vollständig neu (`dataset_id: null`, `cursor: 0`; der Server antwortet mit `reset: true`). Nur so reicht ihre Lösch-Historie wieder so weit zurück wie die des Servers.

### 6.5 Protokollversion

Derzeit `2`. Jede Änderung, die eine ältere App oder einen älteren Server falsch arbeiten ließe, erhöht die Version. Bei Abweichung antwortet der Server mit 409 `protocol_mismatch`; die App sendet dann nicht weiter und fordert zum Aktualisieren auf. Ihre Outbox bleibt erhalten.

**Was Protokoll 2 gegenüber 1 ändert (Stufe 2):**

- `Product.min_stock` (3.1) mit eigener Feld-Uhr; `product.create` und `product.update` kennen es (6.6), das Zusammenführen übernimmt es wie `warn_days` (7.3).
- Der neue Datensatz `ShoppingItem` (3.6), seine Befehle `shopping_item.create`, `.update`, `.delete` (6.6) und die Liste `changes.shopping_items` in jeder Antwort (6.4).
- Automatische Einträge, die der Server selbst schreibt (7.6), samt eigenen Ereignistypen ohne Gerät (Abschnitt 12).
- Die Einstellung `notify_time` (3.4) in `HouseholdSettings` und `settings.update`.
- Die neuen Endpunkte für Statistik, Sensor, Push und den Zustand der Integrationen (Abschnitt 11) liegen außerhalb des Sync; sie allein hätten die Version nicht erhöht.

**Befehle aus Protokoll 1 bleiben gültig.** Alles Neue in bestehenden Befehlen ist optional: `product.create` ohne `min_stock` legt ein Produkt ohne Mindestbestand an, `changes` ohne die neuen Schlüssel ändern sie nicht. Eine App, die mit einer Outbox aus Protokoll 1 aktualisiert wird, sendet sie danach unverändert mit `protocol: 2`; der Server nimmt jeden dieser Befehle an wie zuvor. Die App sendet `min_stock` beim Anlegen nur, wenn es gesetzt ist.

**Der Umstieg in der App:** Ihre lokale Datenbank (Version 3) lädt beim ersten Start einmal alles neu (`dataset_id: null`, `cursor: 0`, 6.4), behält aber Outbox, Geräte-Einstellungen und Anmeldung: Ihre gespeicherten Datensätze aus Protokoll 1 kennen `min_stock`, `notify_time` und die Einkaufsliste noch nicht. Antwortet der Server mit 409 `protocol_mismatch` und meldet eine höhere Version (`details.server` größer als die eigene), sucht die App sofort nach einer neuen Version von sich selbst (Service Worker), nicht erst beim stündlichen Nachsehen (`web/src/core/pwa/updates.ts`). Der Server legt beim Hochziehen der Datenbank (Migration 0003) nichts in die Änderungsfolge: Geräte mit Protokoll 1 können ohnehin nicht abgleichen, und jede App mit Protokoll 2 lädt beim Umstieg alles neu.

### 6.6 Katalog der Befehle

Jeder Befehl hat `id` (UUID, vom Gerät erzeugt), `at` (Geräteuhr im Moment der Änderung) und `type`. Unbekannte Felder sind ein Fehler (`invalid`). Maßgeblich für Feldnamen und Formate ist `server/stowly/contract/commands.py`.

**`changes`-Objekte** ändern nur die Schlüssel, die im JSON vorhanden sind. `null` ist dort ein Wert („MHD entfernen"), kein „nicht angegeben". Felder, die nie `null` sein dürfen, lehnen `null` ab.

| `type` | Nutzlast | Wirkung | Ablehnung |
|---|---|---|---|
| `product.create` | `product_id`, `name` (""), `brand` (""), `quantity` (""), `warn_days` (null), `barcodes` ([]), `min_stock` (null) | Legt das Produkt an. Gehört einer der Barcodes schon einem anderen Produkt, entsteht es als Zusammenführung (7.3). Hat es einen nachschlagbaren Barcode, wird `lookup = pending` (Abschnitt 10). Mit `min_stock` beginnt die Einkaufsliste des Produkts (7.6). | `id_conflict` |
| `product.update` | `product_id`, `changes { name?, brand?, quantity?, warn_days?, min_stock? }` | Feldänderungen (7.1); `min_stock: null` entfernt den Mindestbestand | `not_found` |
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
| `settings.update` | `changes { zone_mode?, primary_zone_id?, warn_days?, trash_retention_days?, default_printer_id?, notify_time? }` | Feldänderungen (7.1) | – |
| `printer.create` | `printer_id`, `name`, `connection`, `server` oder `direct` | Legt den Drucker an | `id_conflict` |
| `printer.update` | `printer_id`, `changes { name?, server?, direct? }` | Feldänderungen (7.1); die Art der Verbindung ändert sich nie | `not_found` (auch gelöscht), `invalid` (Objekt passt nicht zur Verbindung) |
| `printer.delete` | `printer_id` | Markiert den Drucker als gelöscht und setzt Verweise in Zonen und Einstellungen auf `null`; ohne Wirkung, wenn schon gelöscht | `not_found` |
| `printer.report` | `printer_id`, `boot_id`, `status`, `host` | Ersetzt den zuletzt gesehenen Zustand, wenn die Beobachtung neuer ist als die gespeicherte | `not_found` |
| `print.request` | `job_id`, `kind`, `package_id` oder `zone_id`, `printer_id` (null) | Legt ein Etikett im Zustand `pending` an | `id_conflict`, `not_found` |
| `print.report` | `job_id`, `state`, `printer_id`, `boot_id`, `error` | Setzt den Zustand des Etiketts, wenn die Meldung neuer ist als die gespeicherte | `not_found` |
| `shopping_item.create` | `item_id`, `product_id` (null), `text` (""), `quantity` (null) | Legt einen eigenen Eintrag an (`origin = manual`), genau eines von Produkt und Text; `created_at` ist der wirksame Zeitpunkt | `id_conflict`, `not_found` (Produkt), `invalid` (weder Produkt noch Text, oder beides) |
| `shopping_item.update` | `item_id`, `changes { text?, quantity?, done? }` | Feldänderungen (7.1): `done: true` hakt ab (`done_at` = wirksamer Zeitpunkt), `done: false` öffnet wieder. Ohne Wirkung, wenn gelöscht. Folgen für automatische Einträge: 7.6. | `not_found`, `invalid` (`text` bei einem Eintrag mit Produkt, `quantity` bei einem automatischen) |
| `shopping_item.delete` | `item_id` | Löscht endgültig (`deleted_at` = wirksamer Zeitpunkt); ohne Wirkung, wenn schon gelöscht. Folgen für automatische Einträge: 7.6. | `not_found` |

Alle Befehle des Katalogs gehören zum Sync von Anfang an, auch die für Drucker und Etiketten: Sie sind reine Datenhaltung. Gedruckt wird über den Druckdienst ([`etiketten.md`](etiketten.md)). Die drei Befehle der Einkaufsliste gibt es seit Protokoll 2.

Genauer, wo die Tabelle es offen lässt:

- **`package.update` auf eine entnommene Packung** ist immer `displaced`, auch ohne Felder. Die gewünschten Werte werden abgelegt, wie sie sind, und nicht geprüft: Verweisen auf eine gelöschte Zone oder ein zusammengeführtes Produkt folgt erst das Wiederherstellen mit `apply_displaced`. Was sich dann nicht auflösen lässt, bleibt weg; der Rest gilt.
- **`package.restore` ohne Wirkung** (die Packung ist nicht entnommen) rückt die Uhr für Entnehmen und Wiederherstellen trotzdem vor: Ein Entnehmen mit früherem Zeitpunkt, das erst später eintrifft, verliert dann wie vorgesehen (7.2).
- **`zone.delete`** prüft in dieser Reihenfolge: Zone unbekannt (`not_found`); schon gelöscht (ohne Wirkung, `applied`); letzte Zone (`last_zone`); `move_to` ist dieselbe Zone (`invalid`); Ziel unbekannt (`not_found`). `move_to` folgt dabei `moved_to`; führt das zurück zur Zone selbst, ist es ebenfalls `invalid`.
- **`product.merge`** mit einem Paar, das schon dasselbe Produkt ist (zweimal derselbe Wunsch, oder mit sich selbst): `applied` ohne Wirkung.
- **`print.request`** lehnt nur ab, was es nie gab. Eine entnommene Packung, eine gelöschte Zone und ein gelöschter Drucker gelten: Das Entnehmen oder Löschen kann von einem anderen Gerät stammen. Ein Drucker, den es nie gab, ist `not_found`.
- **`print.report`:** Eine Meldung, die gewinnt (7.1), ersetzt Zustand, `printer_id`, `boot_id` und `error` als Ganzes, wörtlich so, wie sie im Befehl stehen. Was der Befehl nicht nennt, ist danach `null`. Nur so hängt das Ergebnis nicht von der Reihenfolge ab, in der Meldungen eintreffen. Wer den Drucker am Etikett behalten will, schickt ihn mit; die App tut das beim Verwerfen und bei der Antwort auf „Wurde gedruckt?". `error` ist freier Text bis 200 Zeichen: der Fehlercode des Druckdienstes, oder `not_printed`, wenn der Anwender auf diese Frage mit Nein antwortet.
- **Ein Zwischenstand überschreibt keinen Ausgang:** Eine Meldung mit `queued` oder `printing` ändert ein Etikett nicht, das schon `printed`, `sent`, `failed`, `cancelled` oder `unknown` ist, gleich welchen Zeitpunkt sie trägt, und stellt auch seine Uhr nicht. Der Befehl gilt trotzdem (`applied`, mit Echo, ohne Eintrag im Ereignisprotokoll). So überschreibt ein `queued`, das ein Gerät erst meldet, nachdem der Server den Druck schon selbst als `printed` fortgeschrieben hat, das Ergebnis nicht. Dieselbe Regel gilt für das, was der Server selbst schreibt (nächster Punkt), und für die lokale Vorwegnahme der App; die App erzeugt eine solche Meldung gar nicht erst. Als Code: `progress_after_outcome` in `server/stowly/sync/handlers.py`, `progressAfterOutcome` in `web/src/contract/labels.ts`.
- **Was der Server selbst schreibt:** Druckt der Server ein Etikett (Druckdienst unter `/print`, [`etiketten.md`](etiketten.md) 5.8), setzt er Zustand, `printer_id`, `boot_id` und `error` des Etiketts selbst, als hätte ein Gerät im selben Moment gemeldet: mit seiner eigenen Uhr als Zeitpunkt und nach derselben Regel (die jüngste Meldung gilt). Ebenso schreibt er den zuletzt gesehenen Zustand seiner eigenen Drucker fort. Beides läuft außerhalb eines Sync-Aufrufs, hebt den Stand der Änderungsfolge und erreicht die Geräte mit ihrem nächsten Abgleich. Für einen Drucker am Server schickt kein Gerät `printer.report`.
- **`product.remove_barcode`** verlangt wie jeder Befehl mit Barcode eine gültige Prüfziffer.
- **`shopping_item.create`** folgt bei `product_id` wie jeder Verweis `merged_into`; ein Produkt, das es nie gab, ist `not_found`. Ein Produkt, das gerade im Bestand ist, macht den Eintrag nicht sofort erledigt: Das tut erst ein Einlagern danach (7.6).
- **`shopping_item.update`** prüft in dieser Reihenfolge: Eintrag unbekannt (`not_found`); gelöscht (ohne Wirkung, `applied`); `text` bei einem Eintrag mit Produkt oder `quantity` bei einem automatischen (`invalid`, der ganze Befehl gilt nicht); dann je Feld die Uhr (7.1). `done: true` auf einen erledigten Eintrag lässt `done_at`, wie es ist, stellt aber die Uhr; ebenso `done: false` auf einen offenen. Wieder öffnen setzt `done_at` auf `null`.
- **`shopping_item.delete`** gewinnt immer: Ein gelöschter Eintrag bleibt gelöscht, gleich welchen Zeitpunkt ein späterer Befehl trägt (wie „Löschen gewinnt" bei Packungen, 7.2, aber ohne Wiederherstellen).
- **Befehle ohne Wirkung** schreiben nichts ins Ereignisprotokoll. Die App erzeugt sie gar nicht erst, wo sie es schon lokal erkennt (derselbe Grund auf eine entnommene Packung, Wiederherstellen einer Packung im Bestand, Umsortieren ohne Änderung, `changes` ohne Felder, Abhaken eines erledigten Eintrags, Öffnen eines offenen, Löschen eines gelöschten).

## 7. Konfliktregeln

### 7.1 Feldänderungen: der spätere Zeitstempel gewinnt

Für jedes änderbare Feld jedes Datensatzes merkt sich der Server den wirksamen Zeitpunkt der zuletzt angewendeten Änderung (Tabelle `field_clocks`). Eine Änderung mit wirksamem Zeitpunkt `t` wird angewendet, wenn es für das Feld noch keine Uhr gibt oder `t >= uhr`; danach ist `uhr = t`. Bei `t < uhr` bleibt das Feld, wie es ist.

- Entschieden wird **je Feld**: Ändert ein Gerät das MHD und ein anderes die Zone derselben Packung, gelten beide Änderungen.
- Bei gleichem Zeitpunkt gewinnt, was der Server später verarbeitet.
- Der überschriebene Wert steht im Ereignisprotokoll (`old`), ebenso eine Änderung, die verloren hat (`superseded`).
- `updated_at` eines Datensatzes ist der späteste wirksame Zeitpunkt einer angewendeten Änderung.
- Eine Uhr stellt nur, wer ein Feld bearbeitet. Anlegen, Zusammenführen, das Löschen einer Zone oder eines Druckers und Open Food Facts stellen keine: Jede Eingabe eines Anwenders gewinnt gegen sie, davor wie danach. Eine Änderung auf den Wert, den das Feld schon hat, stellt die Uhr, steht aber nicht im Ereignisprotokoll.
- Die App entscheidet lokal nichts nach Zeitstempeln: Bis zur Antwort des Servers gilt in ihrer Anzeige der eigene, noch unbestätigte Befehl (Abschnitt 9.1).

Felder mit dieser Regel: Produkt `name`, `brand`, `quantity`, `warn_days`, `min_stock`; Packung `best_before`, `zone_id`, `product_id`; Zone `name`, `icon`, `color`, `sort`, `printer_id`; jede Einstellung (auch `notify_time`); Drucker `name`, `server`, `direct` (das Objekt als Ganzes); Etikett: Zustand samt `printer_id`, `boot_id`, `error` als ein Feld, mit einer Ausnahme (6.6: ein Zwischenstand überschreibt keinen Ausgang); Druckerzustand als Ganzes; Eintrag der Einkaufsliste `text`, `quantity` und `done` (die Uhr von `done` stellt auch das Erledigen durch Einlagern und durch Bring!, 7.6).

### 7.2 Löschen gewinnt gegen Bearbeiten

Die Packung ist physisch weg, also zählt das Entnehmen mehr als eine gleichzeitige Bearbeitung.

- **Entnehmen und Wiederherstellen** teilen sich eine eigene Uhr (`removed`). `package.remove` und `package.restore` wirken, wenn ihr Zeitpunkt nicht vor dieser Uhr liegt. Der spätere der beiden gewinnt, unabhängig von der Reihenfolge ihres Eintreffens.
- **`package.update` auf eine entnommene Packung** wird nicht angewendet, egal welchen Zeitpunkt die Bearbeitung trägt. Der Server legt die gewünschten Feldwerte in `Package.displaced` ab und antwortet mit `status: "displaced"`. Kommen mehrere solche Bearbeitungen, wird je Feld die spätere behalten; `displaced.at` ist der späteste Zeitpunkt der behaltenen Werte. `updated_at` der Packung bleibt, denn angewendet wurde nichts.
- Die Lösch-Historie zeigt die verdrängte Bearbeitung. **`package.restore` mit `apply_displaced: true`** stellt die Packung wieder her und wendet die verdrängten Werte mit dem Zeitpunkt des Wiederherstellens an. In jedem Fall ist `displaced` danach `null`.
- `removed_at` ist der wirksame Zeitpunkt des Entnehmens. `package.remove` auf eine schon entnommene Packung ändert nur `removal_reason` (so wird aus „verbraucht" nachträglich „entsorgt").

### 7.3 Ein Barcode, ein Produkt: Zusammenführen

Zwei Geräte können offline denselben unbekannten Barcode scannen und je einen Platzhalter anlegen. Der Server führt solche Produkte zusammen, statt einen Befehl abzulehnen.

Zusammenführen von `source` in `target` heißt:

1. Alle Packungen von `source`, auch entnommene, gehören danach zu `target`.
2. Alle Barcodes von `source` gehören danach zu `target`.
3. Leere Felder von `target` (`name`, `brand`, `quantity` leer, `warn_days`, `min_stock` und `image` null) übernehmen den Wert von `source`.
4. `source` bekommt `deleted_at` und `merged_into = target` und hat keine Barcodes mehr.
5. Alle Einträge der Einkaufsliste von `source`, auch erledigte und gelöschte, gehören danach zu `target` (`product_id`, `updated_at` wie bei den Packungen). Die Sperre der automatischen Einträge wandert mit, und der Server gleicht `target` ab (7.6): Zwei offene automatische Einträge werden dabei zu einem.

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

Die Etiketten, die das Gerät zu der abgelehnten Packung selbst angefordert hat, gehören zu einer Packung, die es nie gab; die ID trägt jetzt die Packung eines anderen Geräts. Das Gerät verwirft sie deshalb, sobald es die Ablehnung erfährt: Eine Anforderung (`print.request`), die noch in der Outbox wartet, entfernt es dort samt allen Meldungen dazu; für ein schon gesendetes Etikett, das noch nicht in einem Endzustand ist, meldet es `cancelled`. Zugestellt wird davon nichts mehr. Ein Etikett, das schon gedruckt ist, bleibt als Datensatz, wie es ist; das Sync-Problem sagt dem Anwender, dass er es entfernen und die Packung neu einlagern muss.

### 7.6 Einkaufsliste: automatische Einträge und Erledigen durch Einlagern

Seit Protokoll 2. Was hier steht, schreibt der Server selbst; kein Gerät schickt dafür einen Befehl.

**Begriffe:**

- **Bestand** eines Produkts: seine Packungen mit `removed_at = null`, auch abgelaufene.
- **Fehlbestand:** `min_stock` minus Bestand, mindestens 0; ohne Mindestbestand 0. Ein Produkt liegt **unter dem Mindestbestand**, wenn der Fehlbestand größer als 0 ist (`missingStock` in `web/src/contract/shopping.ts`).
- **Offener automatischer Eintrag:** `origin = min_stock`, `done_at` und `deleted_at` sind `null`.
- **Sperre:** je Produkt ein wirksamer Zeitpunkt oder keine (`products.shopping_lock_at`, nicht im Sync).

**Abgleich eines Produkts p zum wirksamen Zeitpunkt t**, immer im Sicherungspunkt des Befehls, der ihn auslöst (6.3):

1. Hat p mehr als einen offenen automatischen Eintrag, bleibt der älteste (nach `created_at`, dann `id`); die übrigen löscht der Server (`deleted_at = t`).
2. Fehlbestand größer als 0:
   - Es gibt einen offenen automatischen Eintrag: Seine `quantity` wird der Fehlbestand.
   - Es gibt keinen, und p ist nicht gesperrt: Der Server legt einen an: neue `id` (UUID v4), `product_id = p`, `text = ""`, `quantity` = Fehlbestand, `origin = min_stock`, `created_at = updated_at = t`.
   - Es gibt keinen, und p ist gesperrt: nichts.
3. Fehlbestand 0 (der Bestand reicht, oder es gibt keinen Mindestbestand mehr): Ein offener automatischer Eintrag wird gelöscht (`deleted_at = t`); seine `quantity` bleibt, wie sie war. Gelöscht, nicht erledigt: So entsteht in Bring! kein „gekauft", das niemand getan hat ([`integrationen.md`](integrationen.md), 5.5).

Jedes Schreiben gibt der Zeile einen neuen `rev` und `updated_at = max(updated_at, t)`. Der Abgleich ist wiederholbar: Läuft er ohne Anlass, ändert er nichts, was schon zur Regel passt.

**Auslöser**, jeweils nur, wenn der Befehl angewendet wurde:

| Befehl | Wann | Vorher | Abgleich für |
|---|---|---|---|
| `package.create` | immer | Sperre von p aufheben, wenn sie nicht nach t liegt; eigene Einträge von p erledigen (unten) | p, das Produkt der Packung |
| `package.remove` | Die Packung war im Bestand. | – | ihr Produkt |
| `package.restore` | Die Packung war entnommen. | – | ihr Produkt; hat `apply_displaced` das Produkt geändert, auch das vorige |
| `package.update` | `product_id` angewendet und geändert | – | das alte und das neue Produkt |
| `product.create` | mit `min_stock` | – | das Produkt, bei einer Zusammenführung das Ziel |
| `product.update` | `min_stock` angewendet und geändert (neuer Wert ungleich altem) | Sperre aufheben, wenn sie nicht nach t liegt | das Produkt |
| Zusammenführen (`product.merge`; `product.create` oder `product.add_barcode` mit vergebenem Barcode) | immer | Einträge wandern (7.3, Schritt 5); Sperre des Ziels = die spätere beider Sperren, die Quelle hat keine mehr | das Ziel |
| `shopping_item.update` | `done: false` angewendet auf einen erledigten automatischen Eintrag | Sperre aufheben, wenn sie nicht nach t liegt | sein Produkt |
| `shopping_item.update` | `done: true` angewendet auf einen offenen automatischen Eintrag | Sperre = die spätere von Sperre und t | – |
| `shopping_item.delete` | trifft einen offenen automatischen Eintrag | Sperre = die spätere von Sperre und t | – |
| Abgleich mit Bring! ([`integrationen.md`](integrationen.md), 5.5) | ein offener automatischer Eintrag ist dort abgehakt oder gelöscht | Sperre = die spätere von Sperre und Zeitpunkt des Abgleichs | – |

Ein erledigter automatischer Eintrag, der danach gelöscht wird, sperrt nicht noch einmal: Das ist Aufräumen, kein Abwählen.

**Die Sperre** gilt bis zum nächsten Einlagern des Produkts oder bis sich sein Mindestbestand ändert, und zwar durch ein Einlagern oder Ändern, das nicht vor dem Abhaken geschah (wirksamer Zeitpunkt ≥ Sperre). Ein Gerät, das offline vor dem Abhaken eingelagert hat und erst danach abgleicht, hebt sie also nicht auf. Solange sie gilt, entsteht kein neuer automatischer Eintrag; ein offener (etwa ein wieder geöffneter) wird weiter nachgeführt.

**Eigene Einträge erledigen sich beim Einlagern:** `package.create` für das Produkt p mit wirksamem Zeitpunkt t erledigt jeden offenen eigenen Eintrag mit `product_id = p`, der seit t oder früher offen ist: `done_at = t`, und die Uhr von `done` (7.1) steht danach auf t. „Offen seit" ist der Zeitpunkt dieser Uhr, wenn es sie gibt (das letzte Wiederöffnen), sonst `created_at`. So erledigt ein Einlagern, das vor dem Anlegen oder vor dem Wiederöffnen geschah, den Eintrag nicht; und ein Abhaken oder Öffnen, das vor dem Einlagern geschah und erst später eintrifft, verliert gegen das Erledigen. Freie Texte erledigt nur der Anwender.

**Was die App davon sieht:** Alles in diesem Abschnitt schreibt der Server ohne Gerät, mit eigenen Ereignistypen (Abschnitt 12). Für die App sind es gewöhnliche Änderungen des Stands (6.4), meist schon in der Antwort auf den Sync, dessen Befehl sie ausgelöst hat; offline kommen sie mit dem nächsten Abgleich. Die App nimmt nichts davon vorweg: Ihre Anzeige ist Stand des Servers plus eigene Befehle (9.1). Den Fehlbestand dagegen zeigt sie sofort selbst, auch offline.

**Testfälle:** [`vectors.json`](vectors.json), Abschnitt `shopping_auto`: Folgen von Befehlen, auch verspätete von einem zweiten Gerät, mit dem erwarteten Stand der Liste. Der Server und die Nachbildung des Servers (`web/src/core/testing`) prüfen dieselben Fälle.

## 8. ID-Vorrat

Eine gedruckte ID lässt sich nicht mehr ändern, also dürfen zwei Geräte offline nie dieselbe vergeben.

- Bei jedem Sync füllt der Server den Vorrat des Geräts auf: Er teilt `max(0, 300 − have)` neue IDs zu (`id_pool.grant`; bei `reset` einen vollen Vorrat, siehe unten), zufällig gewählt, nicht in `packages` vorhanden und für kein Gerät reserviert, und merkt sie in `id_reservations`.
- Die App speichert den Vorrat und entnimmt für jede neue Packung eine ID. `have` ist die Zahl der noch unbenutzten.
- **Vorrat leer** (offline mehr als 300 Packungen ohne einen einzigen Sync): Die App erzeugt Zufalls-IDs (`randomPackageId()`). Ein Zusammenstoß ist dann möglich, aber unwahrscheinlich, und endet in `id_conflict` (7.5).
- Die Reservierung schützt nur davor, dass der Server eine ID zweimal zuteilt. Wer eine freie ID zuerst anlegt, bekommt sie, gleich welches Gerät sie reserviert hatte; die Reservierung verfällt mit dem Anlegen. So scheitern auch die wartenden Befehle eines Geräts nicht, das sich nach einer Sperre neu anmelden musste.
- Geht eine Antwort verloren, sind die darin zugeteilten IDs verschenkt. Das ist bei 33,5 Millionen Kombinationen unerheblich.
- Bei `reset: true` verwirft die App ihren Vorrat und nimmt den neuen aus dieser Antwort. Der Server teilt dann **unabhängig von `have` einen vollen Vorrat** zu (300 IDs): Mit der Differenz stünde das Gerät nach dem Verwerfen fast leer da. Fordert die App selbst einen vollständigen Abzug an (`dataset_id: null`, `cursor: 0`), sendet sie `have: 0`.

## 9. Pflichten der App

### 9.1 Lokale Kopie und Outbox

- Jede Änderung schreibt die App sofort in ihre lokale Kopie und als Befehl in die Outbox, beides in einer Transaktion.
- Die Outbox wird in der Reihenfolge der Entstehung gesendet, höchstens 500 Befehle je Aufruf. Ein Befehl verlässt sie erst, wenn sein Ergebnis da ist (Ausnahme: der Zustand eines Druckers, unten). Hat sie mehr als 500 Befehle, folgen weitere Aufrufe im selben Abgleich (höchstens 20; der Rest geht mit dem nächsten Anlass).
- **Was die App anzeigt, ist immer: Stand des Servers plus die noch nicht bestätigten Befehle, in ihrer Reihenfolge.** Nach jeder Antwort übernimmt die App die gelieferten Datensätze und wendet die Befehle, die inzwischen neu in der Outbox stehen, erneut darauf an. Bestätigte Befehle stecken bereits in den gelieferten Datensätzen.
- **Ausnahme: der Zustand eines Druckers.** Ein `printer.report` ist ein Schnappschuss; es gilt immer die jüngste Meldung (Druckerzustand als Ganzes, 7.1). Eine neue Meldung ersetzt deshalb eine ältere desselben Druckers, die noch ungesendet in der Outbox wartet: Die ältere fällt ohne Ergebnis heraus, die neue steht am Ende. So steht je Drucker höchstens ein noch nicht gesendeter `printer.report` in der Outbox, auch nach einer Stunde im Keller. Was ein Abgleich gerade sendet, bleibt unberührt, auch der eines anderen Tabs oder des Service Workers: Jede Runde hält in der lokalen Datenbank fest, bis zu welchem Befehl der Outbox sie sendet, in derselben Transaktion, in der sie die Befehle nimmt, und gibt das nach der Antwort oder dem Fehlschlag wieder frei. Eine Markierung, die ein mitten im Abgleich beendeter Tab nicht mehr freigibt, verfällt nach zwei Minuten. Die Anzeige ist dieselbe wie ohne Ersetzen. Kommt doch ein Ergebnis zu einem inzwischen ersetzten Befehl, zählt es nur als Antwort des Servers auf das Gesendete und ändert sonst nichts.

### 9.2 Ergebnisse

| Ergebnis | Die App |
|---|---|
| `applied` | entfernt den Befehl aus der Outbox |
| `displaced` | entfernt ihn und zeigt ihn unter den Sync-Problemen („liegt in der Lösch-Historie") |
| `rejected` | entfernt ihn und zeigt ihn unter den Sync-Problemen mit `code`. Ihre lokale Kopie folgt wieder dem Server: Was nur wegen dieses Befehls da war, verschwindet. Bei `package.create` mit `id_conflict` verwirft sie außerdem die eigenen Etiketten zu dieser Packung (7.5). |
| 401 `unauthorized` | wechselt nach `signed_out` / `revoked`, behält Daten und Outbox |
| 409 `protocol_mismatch` | sendet nicht mehr von selbst, fordert zum Aktualisieren auf; ein Abgleich auf Wunsch des Anwenders versucht es einmal |
| Netzfehler, Zeitüberschreitung | „nicht erreichbar": lässt alles, wie es ist, und versucht es später erneut |
| Antwort ohne das Fehlerformat aus Abschnitt 13 (502 bis 504 eines Proxys ohne Server dahinter, Anmeldeseite eines WLANs) | ebenso „nicht erreichbar", auch bei 401: Nur der Server selbst meldet ein Gerät ab |
| 413, 422, 500 im Fehlerformat des Servers | lässt alles, wie es ist, zeigt den Fehler in `sync.status` und versucht es später erneut. Das ist ein Fehler im Programm, nichts, was der Anwender beheben kann. |

Bestätigt eine Antwort keinen einzigen der gesendeten Befehle, gilt der Versuch als gescheitert (`internal`); die Outbox bleibt, wie sie ist.

Die Sync-Probleme sind begrenzt: Die App hebt höchstens 200 auf, die ältesten fallen weg. Ein Eintrag „verdrängt" erledigt sich von selbst, sobald seine Packung keine verdrängte Bearbeitung mehr trägt (wiederhergestellt, mit oder ohne Übernahme, oder nicht mehr in der Lösch-Historie).

### 9.3 Antwort anwenden

1. Bei `has_more` weiter abrufen und alle Seiten sammeln.
2. In einer lokalen Transaktion: bei `reset` zuerst alle synchronisierten Tabellen und den ID-Vorrat leeren (Outbox, Geräte-Einstellungen und Token bleiben); dann alle Datensätze übernehmen; `dataset_id`, `cursor` und den zugeteilten ID-Vorrat speichern.
3. Entnommene Packungen jenseits der Aufbewahrungsdauer, Einträge der Einkaufsliste, die länger als die Aufbewahrungsdauer erledigt oder gelöscht sind, und alte abgeschlossene Etiketten verwerfen (Abschnitt 6.4), auch wenn sie eben erst geliefert wurden. Gerechnet wird dabei mit `server_time` der Antwort; beim Start und in der Anzeige mit der Geräteuhr plus dem Abstand zur Serverzeit, den der letzte Abgleich gemessen hat.
4. Die verbliebenen Befehle der Outbox erneut auf die lokale Kopie anwenden.
5. Hat sich `trash_retention_days` vergrößert: den Bestand beim nächsten Abgleich vollständig neu holen (Abschnitt 6.4).

Die Oberfläche muss Verweise aushalten, die ins Leere zeigen (Produkt oder Zone noch nicht da): Sie zeigt dann einen Platzhalter, keinen Fehler.

### 9.4 Wann abgeglichen wird

- beim Start der App und nach der Anmeldung,
- wenn der Browser `online` meldet,
- wenn die App wieder sichtbar wird (`visibilitychange`),
- nach jeder lokalen Änderung, zusammengefasst über höchstens 2 Sekunden,
- alle 60 Sekunden, solange die App sichtbar und der Server erreichbar ist,
- sobald die Prüfung nebenbei (9.5) oder ein anderer Kontakt den Server nach einem Ausfall wieder erreicht,
- auf Android zusätzlich im Hintergrund (Background Sync, Kennung `stowly-sync`); Safari kann das nicht,
- solange ein Produkt `lookup = pending` hat: zusätzlich nach 3, 10 und 30 Sekunden (Abschnitt 10).

Es läuft immer nur ein Abgleich je Gerät, auch über mehrere Tabs und den Service Worker hinweg (Web Locks, Name `stowly-sync`, wo vorhanden). Nach einem Fehlschlag wartet die App 2, 5, 15, dann 60 Sekunden. War der Server nicht erreichbar und ist das Gerät angemeldet, übernimmt nach den 15 Sekunden die Prüfung nebenbei: Sie fragt alle 15 Sekunden und gleicht ab, sobald er wieder antwortet.

### 9.5 Ist der Server erreichbar?

`navigator.onLine` meldet auf jeder Verbindung `true`, auch im WLAN des Pi ohne Internet. Nur `false` ist verlässlich. Die App prüft deshalb selbst: `GET /api/health` mit `cache: "no-store"`, Abbruch nach 3 Sekunden, und die Antwort gilt nur, wenn `app === "stowly"` ist. Einem Abgleich geht die Prüfung voraus, wenn der letzte Kontakt zum Server länger als 30 Sekunden zurückliegt, der letzte Versuch ihn nicht erreicht hat oder das Gerät nicht angemeldet ist.

**Prüfung nebenbei.** Solange die App sichtbar und das Gerät angemeldet ist, prüft sie so auch ohne Anlass, ob der Server erreichbar ist, sobald 15 Sekunden lang kein Kontakt zu ihm bestand. Kontakt ist jeder Abgleich, jede Prüfung und jeder Aufruf, der den Server braucht (Geräte, Sicherung, Vorschau, Nachschlagen beim Scannen, Statistik, Zustand der Integrationen, Push), auch der eines anderen Tabs desselben Geräts: Die Tabs sagen es einander über einen BroadcastChannel (`stowly-contact`). So entsteht höchstens eine kleine Anfrage je 15 Sekunden, bei mehreren sichtbaren Tabs meist nur in einem, und die App merkt Ausfall und Rückkehr binnen etwa 15 Sekunden (dazu höchstens die 3 Sekunden Zeitgrenze), auch wenn niemand etwas ändert.

- Antwortet der Server nicht, zeigt `sync.status` „nicht erreichbar" wie nach einem gescheiterten Abgleich, in diesem Tab und in den anderen. Der Abgleich alle 60 Sekunden ruht dann.
- Antwortet er nach einem Ausfall wieder, gleicht die App sofort ab.
- Die Prüfung nimmt die Sperre `stowly-sync` (9.4), aber nur, wenn sie frei ist, ohne auf sie zu warten: Gleicht gerade ein anderer Tab oder der Service Worker ab, entfällt sie und kommt 15 Sekunden später wieder.
- Im Hintergrund (App nicht sichtbar) und ohne Anmeldung prüft die App nicht nebenbei, der Service Worker nie.

Zeitgrenzen der übrigen Aufrufe: Abgleich 45 Sekunden (der erste Abzug eines großen Bestands ist kein kleiner Aufruf), Sicherung 120 Sekunden, alles andere 15 Sekunden. Eine Zeitüberschreitung gilt als „nicht erreichbar". Hat der Server die Anfrage trotzdem verbucht, erkennt er die Befehle beim nächsten Versuch als bekannt (`duplicate`).

### 9.6 Bilder

Nach einem Abgleich lädt die App die Bilder der Produkte im Bestand, die sie noch nicht hat, in ihren Cache (`GET /api/images/{id}`), damit sie im Keller ohne Netz erscheinen.

## 10. Open Food Facts

Name, Marke, Packungsgröße und Bild unbekannter Barcodes schlägt der Server bei Open Food Facts nach. Alle Abfragen macht ein einziger Hintergrund-Ablauf, höchstens 10 je Minute: Open Food Facts erlaubt nur 15 Abfragen je Minute und Adresse. Er hat zwei Quellen: Produkte, die als Platzhalter auf ihre Daten warten, und Barcodes, nach denen die App beim Scannen fragt, solange der Server erreichbar ist (10.1). Das Produkt selbst entsteht immer sofort, offline wie online, auch ohne Antwort.

- **Wann:** Ein Produkt mit mindestens einem nicht ladeninternen Barcode bekommt beim Anlegen `lookup = pending`, ebenso nach `product.add_barcode` und nach einem Zusammenführen, wenn es danach etwas nachzuschlagen gibt und noch nichts gefunden ist. Steht das Ergebnis schon in `off_lookups` (etwa weil die App den Barcode beim Scannen nachgeschlagen hat, 10.1), übernimmt das Produkt es noch im selben Abgleich: Die Antwort liefert es schon als `found` oder `not_found`, und im Ereignisprotokoll steht `product.lookup` hinter dem Eintrag des Befehls. Sonst arbeitet der Server die Wartenden im Hintergrund ab, höchstens 10 Abfragen je Minute. Die App zeigt ein eben angelegtes Produkt mit nachschlagbarem Barcode schon vor dem Abgleich als `pending`, außer der Server hat gemeldet, dass er nicht nachschlägt (`lookup_enabled: false`, Abschnitt 6.4): Dann beginnt es wie beim Server als `none`. Maßgeblich ist danach, was der Server liefert.
- **Abruf:** `GET {STOWLY_OFF_URL}/api/v3/product/{barcode}?product_type=all&lc=de&fields=product_name_de,product_name,brands,quantity,image_front_small_url` mit `User-Agent: Stowly/<Version>`, ergänzt um `(<Kontakt>)`, wenn `STOWLY_OFF_CONTACT` gesetzt ist. Im Code steht nie eine persönliche Adresse.
- **Ergebnis:** Gefunden: `lookup = found`. 404 mit `product_not_found`: `lookup = not_found`, endgültig. Netzfehler, 429 und 5xx: Das Produkt bleibt `pending`; neue Versuche nach 1 Minute, 5 Minuten, 30 Minuten, 3 Stunden, danach täglich.
- **Übernahme:** Die Daten füllen **nur leere Felder** des Produkts (`name` aus `product_name_de`, sonst `product_name`; `brand` aus dem ersten Eintrag von `brands`; `quantity`; `image`). Die Uhren der Felder bleiben unberührt: Jede Eingabe eines Anwenders gewinnt, davor wie danach.
- **Bild:** Der Server lädt `image_front_small_url` einmal herunter (nur JPEG, PNG, WebP, höchstens 300 KB) und speichert es in der Datenbank. Die Bild-ID ist der Anfang des SHA-256 des Inhalts (32 Hex-Zeichen) plus Endung, z. B. `9f2c…e1.jpg`.
- **Dauerhaft:** Jedes Ergebnis steht in `off_lookups` und wird von selbst nie erneut abgefragt (neu fragen kann nur der Anwender, 10.2), auch das zu einem Barcode, der (noch) keinem Produkt gehört. Bei einem solchen Barcode ruht, was noch aussteht (ein neuer Versuch nach einem Fehler, ein fehlendes Bild), bis ein Produkt ihn bekommt; einen neuen Versuch löst auch eine erneute Anfrage der App nach der Wartezeit aus. Die Tabelle ist von `products` getrennt, damit die Daten trennbar bleiben (ODbL). Die App nennt die Quelle: „Open Food Facts (ODbL)".
- `STOWLY_OFF_ENABLED=0` schaltet das Nachschlagen ab; Produkte bekommen dann `lookup = none`. Beim Start gleicht der Server `lookup` an die Einstellung an: Wartende werden `none`, und nach dem Wiedereinschalten warten Produkte mit nachschlagbarem Barcode erneut. Jede Sync-Antwort nennt den Stand (`lookup_enabled`).
- **Was die App verspricht:** Dass Name und Bild nachkommen, sagt sie nur, wenn es stimmt: bei einem Barcode, der nachgeschlagen wird (nicht ladenintern), und nur, solange der Server nicht `lookup_enabled: false` gemeldet hat. Die Regel steht als `willLookUp` in `web/src/contract/barcode.ts`; sie entscheidet auch über die lokale Vorwegnahme.
- **Packungsgröße:** Ein Schätzzeichen am Ende der Mengenangabe von Open Food Facts (`e` oder `℮`, mit oder ohne Leerzeichen davor, etwa „400 g e") übernimmt der Server nicht; aus „400 g e" wird „400 g".
- Tests rufen den echten Dienst nie auf.

### 10.1 Nachschlagen beim Scannen

Scannt der Anwender einen Barcode, den die lokale Kopie nicht kennt, soll der Name schon im Dialog stehen. Dafür fragt die App den Server:

`GET /api/lookup/{barcode}?wait=<Sekunden>` mit Token; ohne gültiges Token 401 `unauthorized` wie jeder Aufruf unter `/api`.

- `barcode`: EAN-8 oder EAN-13 in der gespeicherten Form mit gültiger Prüfziffer, dieselbe Prüfung wie bei `product.create`. Sonst 400 `invalid_request` im Fehlerformat (Abschnitt 13), `details.errors` mit `loc: ["path", "barcode"]`.
- `wait`: ganze Zahl von 0 bis 8, Vorgabe 4. So lange wartet der Server höchstens auf ein Ergebnis, das er noch nicht hat. Anderes ist 400 `invalid_request` mit `loc: ["query", "wait"]`.
- Antwort 200 `LookupResult`, `Cache-Control: no-store`:

```json
{
  "barcode": "4006381333931",
  "state": "found",
  "name": "Basmati Reis",
  "brand": "Kornhaus",
  "quantity": "1 kg",
  "image_id": "3f…a1.jpg"
}
```

| `state` | Bedeutung | Felder |
|---|---|---|
| `found` | Open Food Facts kennt den Barcode (aus `off_lookups` oder eben abgefragt) | `name`, `brand`, `quantity` so aufbereitet, wie sie ein Produkt füllen (leer, wenn unbekannt); `image_id`, wenn das Bild schon beim Server liegt (`GET /api/images/{id}`), sonst `null` |
| `not_found` | Open Food Facts kennt ihn nicht | leer |
| `pending` | in `wait` Sekunden keine Antwort (Warteschlange, Rate, Open Food Facts langsam oder weg); der Server fragt im Hintergrund weiter | leer |
| `skipped` | ladeninterner Code (Präfix 2): wird nie nachgeschlagen, auch nicht bei ausgeschaltetem Nachschlagen | leer |
| `disabled` | Nachschlagen ist am Server ausgeschaltet (`STOWLY_OFF_ENABLED=0`); dann gilt auch kein gespeichertes Ergebnis | leer |

Leere Felder sind `""`, nie `null`; nur `image_id` ist `null`, solange es kein Bild gibt.

**Der Server:**

- Steht das Ergebnis in `off_lookups`, antwortet er sofort, ohne Open Food Facts. Ebenso sofort `pending`, solange nach einem Fehlversuch die Wartezeit läuft (1 Minute, 5 Minuten …): Sie gilt auch, wenn jemand wartet.
- Sonst stellt er den Barcode vorn in die Warteschlange des Hintergrund-Ablaufs, vor die Produkte, die ohne Eile warten, weckt ihn und wartet höchstens `wait` Sekunden auf das Ergebnis. Wartet der Ablauf gerade auf die Rate, bekommt der Barcode den nächsten freien Platz. Mehrere Anfragen zum selben Barcode teilen sich eine Abfrage und bekommen dasselbe Ergebnis.
- Das Bild lädt der Ablauf wie sonst auch. Hat Open Food Facts geantwortet, liegt das Bild bis zum Ende der Wartezeit aber noch nicht vor, kommen Name, Marke und Größe ohne `image_id`.
- Kommt in `wait` Sekunden kein Ergebnis, antwortet er `pending` und fragt im Hintergrund weiter; das Ergebnis landet in `off_lookups`. Scheitert die Abfrage (Netzfehler, 429, 5xx), antwortet er sofort `pending`.
- Ein Barcode, zu dem es (noch) kein Produkt gibt, steht danach in `off_lookups`. Ein Produkt, das ihn später bekommt, übernimmt das Ergebnis im selben Abgleich („Wann", oben).
- Wünsche zu Barcodes, die keinem Produkt gehören, nimmt er höchstens 20 zugleich an; sonst könnte ein Gerät mit erfundenen gültigen Barcodes die Warteschlange füllen. Darüber antwortet er `pending`, ohne einzureihen.
- Beim Herunterfahren bekommt eine wartende Anfrage sofort, was bis dahin bekannt ist, sonst `pending`. Sie hält das Beenden nicht auf.

**Die App:**

- Scannt der Anwender einen Barcode, den die lokale Kopie nicht kennt, fragt die App nach, sofern der Server erreichbar ist (9.5) und `willLookUp` gilt. Sie öffnet den Dialog sofort und wartet nicht auf die Antwort.
- Kommt `found`, füllt sie den Namen, sobald die Antwort da ist, aber nur, wenn der Anwender noch nichts eingetragen hat.
- Beim Einlagern schickt sie Name, Marke und Packungsgröße aus der Antwort mit dem Anlegen des Produkts mit (`product.create`), wie eine Eingabe des Anwenders. Was er selbst eingetragen hat, gilt.
- Kommt `pending`, eine andere Antwort ohne Daten oder gar keine (nicht erreichbar, Zeitüberschreitung, Fehler), gilt der bisherige Ablauf: Das Produkt entsteht als Platzhalter, und was der Server weiß oder später erfährt, kommt mit dem Abgleich. Die Zeitgrenze des Aufrufs liegt etwas über `wait`, damit die Antwort des Servers noch ankommt.

**Warum die Rate hält:**

- Der Endpunkt fragt nie selbst, er reiht nur ein. Abgefragt wird ausschließlich im Hintergrund-Ablauf, mit derselben Drosselung (höchstens 10 Abfragen in jedem Fenster von 60 Sekunden), denselben Wartezeiten nach Fehlern und derselben Pause nach 429.
- Jedes Ergebnis wird gespeichert und nie erneut abgefragt. Wird aus dem gescannten Barcode ein Produkt, übernimmt es das gespeicherte Ergebnis, und die Abfrage im Hintergrund entfällt: Sie kommt nur früher, nicht zusätzlich. Neu ist allein die Abfrage zu einem Scan, aus dem kein Produkt wird; auch sie zählt in die 10 je Minute.
- Gleichzeitige Anfragen zum selben Barcode ergeben eine Abfrage, und Wünsche zu Barcodes ohne Produkt sind auf 20 begrenzt.

### 10.2 Neu abfragen (seit 0.5.0)

Ein offline angelegtes Produkt behält seinen getippten Namen, und ein früher unbekannter Barcode bleibt `not_found`. In „Produkt bearbeiten" fragt der Anwender deshalb auf Knopfdruck neu („Online abfragen"):

`POST /api/lookup/{barcode}/refresh?wait=<Sekunden>` mit Token; `barcode` und `wait` wie in 10.1.

- **Jetzt:** Der Server fragt Open Food Facts sofort, auch wenn schon ein Ergebnis gespeichert ist, auch nach `not_found`, und vor allen Abfragen im Hintergrund. Die Rate (10 je Minute) und die Pause nach 429 gelten weiter.
- **Bremse:** Je Barcode höchstens einmal je Minute (`LOOKUP_REFRESH_GAP_S`), und höchstens 5 Neuabrufe warten zugleich. Sonst, und wenn Open Food Facts gerade bremst, kommt das gespeicherte Ergebnis mit `throttled: true`; die App sagt dann „Open Food Facts bremst gerade; in einer Minute noch einmal." Barcodes, nach denen die App beim Scannen fragt (10.1), gehen vor.
- **Ergebnis:** Ein Fund ersetzt das gespeicherte Ergebnis, auch für künftige Scans; das Bild lädt und speichert der Server wie in Abschnitt 10, `image_id` steht in der Antwort. Ein Fehlschlag (Netz, 5xx) ändert nichts am Gespeicherten. `not_found` überschreibt keinen Fund, wird aber gemeldet.
- **Kein Produkt ändert sich,** auch nicht sein Stand `lookup`: Was übernommen wird, entscheidet der Anwender in der Gegenüberstellung (Name, Marke, Packungsgröße, Bild) und speichert es mit `product.update` wie jede Eingabe; das Bild mit `PUT /api/products/{id}/image` (11.12).
- **Antwort** 200 `LookupResult` wie in 10.1, mit `fetched_at` (wann Open Food Facts das Ergebnis geliefert hat) und `throttled`. Ladeninterne Codes: `skipped`, Nachschlagen aus: `disabled`. Die Adresse von Open Food Facts steht fest (`STOWLY_OFF_URL`); fremde Adressen fragt der Server nie.

## 11. Weitere Endpunkte

Alle Pfade, Parameter und Schemata stehen maschinenlesbar in [`openapi.json`](openapi.json).

| Aufruf | Anmeldung | Antwort |
|---|---|---|
| `GET /api/health` | offen | 200 `ServerHealth { app: "stowly", status: "ok", version, protocol, time, configured }`, `Cache-Control: no-store` |
| `GET /api/images/{image_id}` | offen | 200 Bilddaten, nur `image/jpeg`, `image/png` oder `image/webp` mit passenden Bytes (sonst 404), mit `Cache-Control: public, max-age=31536000, immutable`, `Content-Security-Policy: default-src 'none'; sandbox` und `X-Content-Type-Options: nosniff`; 404 |
| `POST /api/backup/run` | Token | 200 `BackupFile { name, size, created_at }`, `Cache-Control: no-store`; 409 `conflict`, 429 `rate_limited`, 500, 503 `not_configured` (11.9) |
| `GET /api/backup/files/{name}` | Token | 200 `application/octet-stream`, `Content-Disposition: attachment`, `Cache-Control: no-store`; 404 bei jedem anderen Namen (11.9) |
| `GET /api/events?before=&limit=&entity=&entity_id=` | Token | 200 `EventPage { events, next_before }`, neueste zuerst, `limit` 1–500 (Vorgabe 100) |
| `GET /api/lookup/{barcode}?wait=` | Token | 200 `LookupResult { barcode, state, name, brand, quantity, image_id }`, `Cache-Control: no-store`; 400 bei ungültigem Barcode oder `wait` (Abschnitt 10.1) |
| `GET /api/stats?start=&end=` | Token | 200 `Stats`, `Cache-Control: no-store`; 400 bei ungültigem Zeitraum (11.1) |
| `GET /api/ha/summary` | Token des Sensors (aus der App oder `STOWLY_HA_SUMMARY_TOKEN`), kein Geräte-Token | 200 `HaSummary`, `Cache-Control: no-store`; 401 ohne gültigen Sensor-Token; 503 `not_configured` ohne Sensor-Token (11.2) |
| `GET /api/ha/stock` | Token des Sensors, kein Geräte-Token | 200 `HaStock`, sonst wie `GET /api/ha/summary` (11.2) |
| `GET /api/push/key` | Token | 200 `PushKey { public_key }`, `Cache-Control: no-store`; 503 `not_configured` (11.3) |
| `PUT /api/push/subscription` | Token | `PushSubscriptionInput { endpoint, keys { p256dh, auth }, origin }`; 204; 422 bei ungültigem oder unbekanntem Push-Dienst; 503 `not_configured` |
| `DELETE /api/push/subscription` | Token | 204, auch ohne Abo; 503 `not_configured` |
| `POST /api/push/test` | Token | 200 `PushTestResult { status, http_status, message }`, `Cache-Control: no-store`; 404 ohne Abo dieses Geräts; 429 `rate_limited`; 503 `not_configured` |
| `GET /api/integrations` | Token | 200 `IntegrationStatus { timezone, backup, ha, push, update }`, `Cache-Control: no-store` (11.4) |
| `POST /api/update/check` | Token | 200 `UpdateStatus`, `Cache-Control: no-store`; 429 `rate_limited` öfter als einmal je Minute; 503 `not_configured`, wenn Updates aus sind (11.5) |
| `POST /api/update/install` | Token | `UpdateInstallInput { version }`; 202 `UpdateStatus`; 409 `conflict`; 503 `not_configured` (11.5) |
| `GET /api/setup` | Token | 200 `SetupStatus`, `Cache-Control: no-store` (11.6) |
| `PATCH /api/setup` | Token | `SetupChanges`; 200 `SetupStatus`; 422 bei einer Adresse außerhalb des Heimnetzes (11.6) |
| `GET /api/setup/ca.crt?download=` | offen | 200 Zertifikat der CA als DER, `Cache-Control: no-store`; 404 ohne nutzbare CA (11.6) |
| `GET /api/server-config` | Token | 200 `ServerConfig`, `Cache-Control: no-store` (11.7) |
| `PATCH /api/server-config` | Token | `ServerConfigChanges`; 200 `ServerConfig`; 401 `invalid_password` und 429 beim Hinzufügen eines Schlüssels der Sicherung; 409 `conflict` bei einem Wert aus der Umgebung; 422 (11.7) |
| `GET /api/server-config/ha` | Token | 200 `HaConfig`, `Cache-Control: no-store` (11.10) |
| `PATCH /api/server-config/ha` | Token | `HaConfigChanges { url, entity, token }`; 200 `HaConfig`; 409 `conflict` aus der Umgebung; 422; 500, wenn sich der Token nicht speichern lässt (11.10) |
| `POST /api/server-config/ha/check` | Token | `HaCheckInput { url, token }`; 200 `HaCheck`, `Cache-Control: no-store`; 409, 422, 429 `rate_limited` (11.10) |
| `POST /api/server-config/ha/sensor-token` | Token | 201 `HaSensorToken { token }`; 409 aus der Umgebung (11.10) |
| `GET /api/server-config/ha/sensor-token` | Token | 200 `HaSensorToken`; 404 ohne; 409 aus der Umgebung (11.10) |
| `DELETE /api/server-config/ha/sensor-token` | Token | 204, auch ohne; 409 aus der Umgebung (11.10) |
| `PUT /api/restore/upload` | Token, beim ersten Start offen | Rumpf: die Datei (`application/octet-stream`), höchstens 512 MiB; 201 `RestoreUpload { upload_id, kind, size }`; 400, 401, 409, 413, 422, 429 (11.9) |
| `POST /api/restore/check` | wie oben | `RestoreCheckInput { upload_id, identity }`; 200 `RestorePreview`; 400, 401, 404, 409, 413, 422 mit `details.reason`, 429 (11.9) |
| `POST /api/restore/apply` | wie oben | `RestoreApplyInput { restore_id, password, device_name }`; 202 `RestoreApplied { login }`; 400, 401 (auch `invalid_password`), 404, 409, 422, 429, 503 (11.9) |
| `GET /api/restore` | Token | 200 `RestoreStatus { state, at, message, undo_until }`, `Cache-Control: no-store` (11.9) |
| `POST /api/restore/undo` | Token | 202 `RestoreApplied`; 404, 409, 503 (11.9) |
| `DELETE /api/restore/previous` | Token | 204, wiederholbar; 409, solange eine Sicherung bereitliegt (11.9) |
| `POST /api/pi/pairings` | Token | `PiPairingInput { origin, printer_id }`; 201 `PiPairing` mit Code und Befehl; 422; 503 `not_configured` (11.8) |
| `GET /api/pi/pairings/{pairing_id}` | Token | 200 `PiPairing`, `Cache-Control: no-store`; 404 (11.8) |
| `DELETE /api/pi/pairings/{pairing_id}` | Token | 204, wiederholbar; 404 (11.8) |
| `POST /api/pi/pair/start` | offen, nur mit Code | `PiPairStartInput`; 204; 404, 409, 429 (11.8) |
| `POST /api/pi/pair` | offen, nur mit Code | `PiPairInput`; 200 `PiPairResult`; 404, 409, 422, 429, 503 (11.8) |
| `GET /api/pi/install.sh` | offen | 200 Startskript (`text/x-shellscript`); 400; 503 ohne Paket (11.8) |
| `GET /api/pi/bundle.tar.gz` | offen | 200 Paket für den Pi (`application/gzip`); 503 ohne Paket (11.8) |
| `/print/v1/…` | Token | Druckdienst des Servers, siehe [`etiketten.md`](etiketten.md) |

- **Bilder sind ohne Anmeldung abrufbar**, weil `<img>` keinen `Authorization`-Kopf senden kann. Die Kennung ist der Hash des Inhalts und nicht zu erraten; ausgeliefert werden nur Vorschaubilder aus Open Food Facts, als JPEG, PNG oder WebP und nur, wenn die Bytes zum Typ passen, so, dass der Browser sie nur als Bild nimmt (`sandbox`, `nosniff`). Selbst ein Bild aus einer gefälschten Sicherung liefe so nie als Seite unter dem Ursprung von Stowly.
- **Sicherung:** eine in sich stimmige Kopie der ganzen Datenbank (`sqlite3.Connection.backup`), seit 0.4.0 nur noch verschlüsselt im Ordner der Sicherungen ([`integrationen.md`](integrationen.md), 3); die unverschlüsselte (`GET /api/backup`) gibt es nicht mehr. Die Kopie bekommt eine **neue `dataset_id`**. Wird sie eingespielt (11.9), antwortet der Server allen Geräten mit `reset: true`; sie holen den Bestand vollständig neu und senden ihre Outbox erneut. Befehle, die schon in der Sicherung stecken, erkennt der Server als bekannt.
- Unbekannte Pfade unter `/api` antworten mit 404 im Fehlerformat. Alles außerhalb von `/api` und `/print` liefert die Web-App (Datei oder `index.html`).
- **Seit Stufe 2** kommen Statistik, Sensor, Push und der Zustand der Integrationen dazu (11.1 bis 11.4), seit 0.4.0 Sicherung jetzt, Zurückspielen und Home Assistant aus der App (11.9, 11.10). Die Pfade, Methoden, `operation_id`, Modelle und die Beschreibungen in `server/stowly/api/` sind Vertrag (sie stehen in `openapi.json`); umsetzen heißt, den Rumpf der Funktion zu füllen.

### 11.1 Statistik

`GET /api/stats?start=YYYY-MM&end=YYYY-MM` mit Geräte-Token.

- **Zeitraum:** ganze Monate in der Zeitzone des Servers (`STOWLY_TIMEZONE`), beide eingeschlossen. Ohne `end` der laufende Monat, ohne `start` 11 Monate vor `end` (zusammen 12, `STATS_DEFAULT_MONTHS`). Höchstens 120 Monate (`STATS_MAX_MONTHS`). Ein Monat, der nicht `YYYY-MM` ist (`isMonth`, Jahre 0001 bis 9999), `start` nach `end`, mehr als 120 Monate oder ein Parameter doppelt: 400 `invalid_request` mit `details.errors[].loc = ["query", "start"]` bzw. `["query", "end"]`. Bei falscher Form und doppeltem Parameter ist es die Stelle des betroffenen Parameters; `start` nach `end` und mehr als 120 Monate meldet der Server an `start`. Ein leerer Wert (`?start=`) ist eine Angabe und ungültig (400); wer keinen Monat meint, lässt den Parameter weg.
- **Gezählt** werden Packungen mit `removed_at` im Zeitraum (umgerechnet in die Zeitzone des Servers) und `removal_reason` `consumed` oder `discarded`. `mistake` („versehentlich") zählt nirgends. Grundlage ist der heutige Stand jeder Packung: Eine wiederhergestellte zählt nicht, ein nachträglich geänderter Grund zählt mit dem neuen Wert. Weil das Zusammenführen die Packungen umhängt (7.3), zählt eine Packung eines zusammengeführten Produkts beim Ziel; ebenso folgt die Zone dem Löschen einer Zone (7.4).
- **Antwort `Stats`:** `months` hat jeden Monat des Zeitraums aufsteigend, auch leere; `consumed` und `discarded` sind die Summen; `discarded_share` = entsorgt / (verbraucht + entsorgt), `null` bei 0 + 0, gerundet auf 4 Nachkommastellen; `top_discarded` sind höchstens 10 Produkte (`STATS_TOP_PRODUCTS`) mit mindestens einer entsorgten Packung, meiste zuerst, bei Gleichstand nach Name (verglichen nach `str.casefold()` in der Reihenfolge der Unicode-Zeichen; Platzhalter mit leerem Namen zuletzt), dann nach Kennung, mit Name und erstem Barcode (für Platzhalter); `zones` hat jede nicht gelöschte Zone in der Reihenfolge der Zonen (`sort`, dann Name), auch mit 0; `timezone` nennt die Zeitzone.
- Die App zeigt die Statistik nur mit Verbindung und sagt offline, warum sie fehlt (`core.stats.load`, CoreError `offline`).

### 11.2 Sensor für Home Assistant

`GET /api/ha/summary`, nur lesend, mit eigenem Token: `Authorization: Bearer <Sensor-Token>`. Der Sensor-Token ist `STOWLY_HA_SUMMARY_TOKEN` oder, ohne die Variable, der Token aus der App (11.10); gelesen wird er bei jeder Anfrage. Der Vergleich läuft in konstanter Zeit (über die SHA-256 beider Werte, wie beim Passwort). Ein Geräte-Token gilt hier nicht (401), und der Sensor-Token gilt nirgends sonst (dort ist er ein unbekanntes Geräte-Token: 401). Gibt es keinen Sensor-Token, antwortet der Endpunkt jedem mit 503 `not_configured`. Inhalt, Regeln und die Schnipsel für HA: [`integrationen.md`](integrationen.md), Abschnitt 6.

`GET /api/ha/stock` liefert mit demselben Token und denselben Regeln die Liste aller Waren im Bestand, je Zone (`HaStock`, [`integrationen.md`](integrationen.md), Abschnitt 6.3).

### 11.3 Push

Alle vier Aufrufe mit Geräte-Token; das Abo gehört zum Gerät, höchstens eines je Gerät. Ohne `STOWLY_PUSH_CONTACT` antworten alle mit 503 `not_configured`; geprüft wird zuerst das Token (401), und ein Rumpf von `PUT`, der schon der Form nach nicht passt, ergibt 422 vor 503. Erlaubte Push-Dienste, Prüfung der Eingabe, Verschlüsselung, Nachricht und Antworten der Push-Dienste: [`integrationen.md`](integrationen.md), Abschnitt 4.

- `GET /api/push/key`: der öffentliche VAPID-Schlüssel (`applicationServerKey`).
- `PUT /api/push/subscription`: legt das Abo dieses Geräts an oder ersetzt es. Gehört derselbe `endpoint` einem anderen Gerät, wechselt er zu diesem (das andere verliert sein Abo). Ungültige Form, unbekannter Push-Dienst oder ungültiger Ursprung: 422 `invalid_request` mit `details.errors[].loc`, etwa `["body", "endpoint"]`.
- `DELETE /api/push/subscription`: löscht das Abo dieses Geräts; 204 auch, wenn es keines gibt.
- `POST /api/push/test`: schickt eine Testnachricht an das Abo dieses Geräts und antwortet erst, wenn der Push-Dienst geantwortet hat (höchstens 10 Sekunden). 404 `not_found` ohne Abo; mehr als eine Testnachricht je Gerät in 10 Sekunden (`PUSH_TEST_INTERVAL_S`): 429 `rate_limited` mit `Retry-After` und `details.retry_after_s`. Es zählt nur eine Testnachricht, die wirklich hinausging, gleich was der Push-Dienst antwortete; ein 404 ohne Abo zählt nicht.
- Wird ein Gerät gesperrt oder meldet es sich ab, löscht der Server sein Abo in derselben Transaktion.

### 11.4 Zustand der Integrationen

`GET /api/integrations` mit Geräte-Token: Sicherung, Home Assistant, Push und Updates für die Einstellungen der App. Nie ein Token, nie ein privater Schlüssel, keine Adresse von HA und kein Push-Kontakt; öffentliche age-Schlüssel nur gekürzt. Felder und Regeln: [`integrationen.md`](integrationen.md), Abschnitt 8.

### 11.5 Updates

`POST /api/update/check` und `POST /api/update/install` mit Geräte-Token. Der erste fragt GitHub sofort nach dem neuesten Release, der zweite legt eine Anforderung für den Updater auf dem Rechner ab. Beide liefern danach `UpdateStatus`. Abfrage, Dateien, Zustände und die Prüfungen beim Anfordern: [`integrationen.md`](integrationen.md), Abschnitt 10.

### 11.6 Einrichtung

Der Assistent der App führt nach dem ersten Passwort durch die Schritte `https`, `printer`, `backup`, `updates`, `notifications` und `home_assistant` (`backup` und `home_assistant` seit 0.4.0), jeder überspringbar. Der Stand liegt auf dem Server, damit er den Wechsel von http zu https und andere Geräte übersteht. HTTPS, CA und Zertifikat: [`integrationen.md`](integrationen.md), Abschnitt 11.

**Erstes Passwort:** `POST /api/setup/password` ohne Anmeldung.
- Nur solange es kein Passwort gibt, weder aus `STOWLY_PASSWORD` noch in der Datenbank. Sonst 409 `conflict`; die App wechselt dann zur Anmeldung.
- Gleichzeitige Aufrufe: genau einer gewinnt, die anderen bekommen 409.
- Die Kopfzeile `Host` muss ins Heimnetz zeigen: eine private IP-Adresse, Loopback, ein einteiliger Name oder eine lokale Endung (Liste in [`integrationen.md`](integrationen.md), 11.3). Sonst 400 `invalid_request`. Das hält Seiten im Internet ab, die per DNS-Rebinding als erste ein Passwort setzen wollen.
- Die Bremse der Anmeldung gilt auch hier (Abschnitt 5).
- Solange beim ersten Start eine Sicherung zum Einspielen bereitliegt (11.9): 409 `conflict` „Gerade wird eine Sicherung zurückgespielt; Stowly startet gleich neu."
- Antwort wie die Anmeldung: `LoginResponse` mit dem Token des neuen Geräts, `Cache-Control: no-store`. Die Adresse aus `Host` lernt der Server fürs Zertifikat.

**Stand:** `GET /api/setup` liefert `SetupStatus`.
- `steps`: je Schritt `state` (`open`, `done`, `skipped`, wie die App ihn markiert hat), `ready` (aus Sicht des Servers erledigt) und `changed_at`.
  - `ready` heißt bei `https`: Eine angemeldete Anfrage kam über den HTTPS-Listener. Bei `printer`: Es gibt einen nicht gelöschten Drucker. Bei `backup`: Die Sicherung wirkt (an, mit Schlüssel, der Ordner taugt), und eine ist gelungen. Bei `updates`: Updates sind an. Bei `notifications`: Ein Kontakt für die Push-Dienste ist wirksam. Bei `home_assistant`: Adresse, Token und Liste sind wirksam, aus der Umgebung oder der App.
  - Die App zeigt einen Schritt als erledigt, wenn er `ready` oder als `done` markiert ist. Läuft die Seite hinter einem Reverse Proxy schon über HTTPS, markiert die App `https` selbst als `done`.
- `finished_at`: wann die Einrichtung abgeschlossen wurde; `null` = offen. Haushalte, die beim Umstieg auf Schema 4 schon Geräte hatten, gelten als eingerichtet. Ist die Einrichtung abgeschlossen, öffnet die App den Assistenten bei der Übersicht; dort stehen Schritte, die später dazukamen (`backup`, `home_assistant`), zum Nachholen. Nach dem Zurückspielen beim ersten Start ist `finished_at` wieder `null` (11.9).
- `password_source`: `env` oder `app` (auch, solange es noch keines gibt).
- `https` (`HttpsStatus`): Listener, Port, Adressen, Ursprünge, CA und Zertifikat ([`integrationen.md`](integrationen.md), 11).
- **Lernen:** Jeder Aufruf lernt die Adresse aus `Host`. Eine neue Adresse stellt das Zertifikat neu aus.
  - Über den HTTPS-Listener lernt er außerdem den externen HTTPS-Port, solange keiner von Hand gesetzt ist; über HTTP den externen HTTP-Port. Steht in `Host` kein Port, gilt 443 bzw. 80.
  - Eine Anfrage mit Proxy-Kopfzeilen (`Forwarded`, `X-Forwarded-*`, `X-Real-IP`) lernt keinen Port: Hinter einem Reverse Proxy wäre er falsch.
  - `https_seen_at` schreibt der Server höchstens einmal je Minute.
  - Ursprünge der App lernt nur `PATCH /api/setup`, aus der Kopfzeile `Origin`.
  - Höchstens 10 Adressen, gelernte und von Hand eingetragene zusammen.

**Ändern:** `PATCH /api/setup` mit `SetupChanges`. Nur vorhandene Felder zählen.
- `step { id, state }` markiert einen Schritt.
- `finished`: `true` schließt ab, `false` öffnet wieder.
- `addresses` ersetzt die von Hand eingetragenen Adressen; gelernte bleiben. Höchstens 10. Liegt eine nicht im Heimnetz oder deckt die CA sie nicht: 422 mit `details.errors[].loc = ["body", "addresses", i]`.
- `https_port`: der Port, unter dem HTTPS von außen erreichbar ist; `null` = wieder lernen.

**CA herunterladen:** `GET /api/setup/ca.crt` ohne Anmeldung, das Zertifikat der CA als DER, `Cache-Control: no-store`.
- Ohne `download` als `application/x-x509-ca-cert` ohne Dateinamen: Das iPhone bietet dann ein Profil an, Firefox seinen Dialog.
- Mit `?download=true` als `application/pkix-cert` mit `Content-Disposition: attachment; filename="stowly-ca.crt"`. Das ist der Weg für Android, Windows und den Mac: Chrome auf Android gäbe den ersten Typ an eine Installation weiter, die CA-Zertifikate ablehnt.
- 404 `not_found` ohne nutzbare CA.

### 11.7 Einstellungen des Servers

`GET /api/server-config` und `PATCH /api/server-config` mit Geräte-Token: Einstellungen, die früher nur in der Umgebung standen und jetzt auch in der App gehen. Die Umgebung geht vor; was dort steht, ist in der App nur zu sehen. Regeln: [`integrationen.md`](integrationen.md), Abschnitt 12.

- **`ServerConfig`:**
  - `push { contact, source }`: der wirksame Kontakt für die Push-Dienste;
  - `update { enabled, repo, source, available }`: der Schalter „Nach Updates suchen";
  - seit 0.4.0 `backup` (`BackupConfig`): `enabled` mit `enabled_source`, `recipients` (je `key` vollständig, `short` gekürzt, `added_at`; `null` aus der Umgebung) mit `recipients_source`, `time` mit `time_source`, `folder` mit `folder_source` (`env`, `mounted` oder `data`), `folder_problem` und `folder_hint` ([`integrationen.md`](integrationen.md), 3.1 und 3.5).
  - `source` ist `env`, `app` oder `default`. Nie ein Geheimnis; öffentliche Schlüssel sind keines.
- **`ServerConfigChanges`:** Nur vorhandene Felder zählen.
  - `push_contact`: `mailto:<Adresse>` oder eine https-Adresse; eine Adresse ohne `mailto:` bekommt es davor. `null` entfernt den Kontakt, Push ist dann aus.
  - `update_enabled`: an oder aus.
  - `backup_enabled`: an oder aus. `backup_time`: `HH:MM`; `null` = wieder die Vorgabe `03:30`.
  - `backup_recipients`: die öffentlichen Schlüssel aus der App, höchstens 10; ersetzt die bisherigen. Kommt dabei ein Schlüssel hinzu, braucht es `current_password`, das Haushalts-Passwort (aus `STOWLY_PASSWORD`, wenn gesetzt): Wer einen Schlüssel hinzufügt, kann jede künftige Sicherung öffnen, samt Passwort-Hash, VAPID-Schlüssel und Push-Abos; ein Geräte-Token allein genügt dafür nicht. Entfernen braucht es nicht. Das Passwort steht nie im Log.
- **Fehler:**
  - 409 `conflict`, wenn das Feld aus der Umgebung kommt (Schlüssel und Schalter bei `STOWLY_BACKUP_RECIPIENTS`, die Uhrzeit bei `STOWLY_BACKUP_TIME`) oder das Image kein Repository für den Schalter kennt (`available: false`).
  - 422 mit `details.errors[].loc`: `["body", "push_contact"]` bei einem ungültigen Kontakt; `["body", "backup_recipients", i]` bei einem Eintrag, der kein öffentlicher age-Schlüssel ist, und bei einem geheimen, ohne ihn zu wiederholen; `["body", "current_password"]` mit „Zum Hinzufügen eines Schlüssels braucht es das Haushalts-Passwort.", wenn das Passwort zum Hinzufügen fehlt.
  - 401 `invalid_password` („Das Passwort stimmt nicht.") bei einem falschen `current_password`, über die Bremse der Anmeldung (Abschnitt 5): nach 5 Fehlversuchen in 5 Minuten 60 Sekunden lang 429, gemeinsam mit der Anmeldung. Das Gerät bleibt angemeldet.
  - 409 `conflict` „Die Schlüssel der Sicherung haben sich inzwischen auf einem anderen Gerät geändert. Bitte neu laden und noch einmal versuchen.", wenn ein anderes Gerät gerade einen Schlüssel entfernt hat, den die Liste ohne Passwort zurückbrächte.
- **Wirkung:** ohne Neustart. Ein neuer Kontakt gilt ab der nächsten Nachricht, ein eingeschalteter Schalter weckt die Abfrage bei GitHub (erste Abfrage nach `UPDATE_CHECK_FIRST_S`), eine Änderung der Sicherung den Zeitplan.

### 11.8 Pi koppeln

Ein Raspberry Pi wird mit einem Befehl zum Druckdienst. Ablauf, Paket und Skripte auf dem Pi: [`etiketten.md`](etiketten.md) und [`../pi/README.md`](../pi/README.md).

**Code erzeugen:** `POST /api/pi/pairings` mit Geräte-Token und `PiPairingInput`.
- `origin`: der Ursprung der App (`location.origin`). Der Pi erlaubt ihn, und der Befehl baut darauf auf.
- `printer_id`: einen vorhandenen, nicht gelöschten direkten Drucker übernehmen, sonst `null`.
- Der Code hat 8 Zeichen Crockford-Base32 (`XXXX-XXXX`), gilt `PI_PAIRING_TTL_S` (30 Minuten) und nur einmal. Gespeichert wird nur der SHA-256 seiner Normalform. Ein neuer Code bricht wartende ältere ab.
- Antwort 201 `PiPairing` mit `code` und `command`, etwa `curl -fsSL http://192.168.1.10:8010/api/pi/install.sh | sudo sh -s -- ABCD-EFGH`. Code und Befehl gibt es nur in dieser Antwort.
- Die HTTP-Adresse im Befehl: der Ursprung der Anfrage, wenn er http ist; sonst der Host aus `origin` mit dem gelernten externen HTTP-Port (11.6).
- 422 bei ungültigem `origin` oder `printer_id`; 503 `not_configured` ohne nutzbare CA oder ohne Paket.

**Stand:** `GET /api/pi/pairings/{pairing_id}` liefert `PiPairing` ohne `code` und `command`, `DELETE` bricht eine wartende Kopplung ab (204, wiederholbar). Unbekannt: 404.
- `state`: `waiting`, `installing` (der Pi hat sich gemeldet), `paired`, `expired`, `cancelled`.
- `pi`: was der Pi gemeldet hat, ab `installing`.
- `printer_id`: der gewählte bzw. gekoppelte Drucker. Ist er gekoppelt, kommt er wie jeder Drucker über den Sync.

**Der Pi** (ohne Anmeldung, nur mit Code):
1. `GET /api/pi/install.sh`: das Startskript. Es kennt die Adresse dieses Servers aus `Host` (nur Name oder IP mit Port, sonst 400) und die SHA-256 des Pakets.
2. `GET /api/pi/bundle.tar.gz`: das Paket mit `pi/` und dem Druckdienst aus `print/`.
3. `POST /api/pi/pair/start` mit `PiPairStartInput { code, hostname, version }`, gleich nach dem Laden. Die Kopplung steht dann auf `installing`. Beim ersten Melden gilt sie ab da noch einmal 30 Minuten, bei weiteren nicht (seit 0.3.1): Ein Code lebt so höchstens eine Stunde. 204.
4. Nach der Installation `POST /api/pi/pair` mit `PiPairInput`: Hostname, IPv4-Adressen (die zum Server zuerst), Zertifikatsantrag (PEM), Token des Druckdienstes, erkanntes Modell, `printer_found` und die Kennung einer früheren Kopplung.
   - **Zertifikat:** Der Server signiert den Antrag mit seiner CA, `PI_CERT_DAYS` (825) Tage. Betreff und Erweiterungen des Antrags zählen nicht. Die Adressen bestimmt der Server; ein mitgelesener Code bringt so kein Zertifikat für fremde Geräte:
     - **IP:** die erste gemeldete Adresse, unter der der Pi die Rückprüfung besteht. Dazu kommt `10.71.83.1`, der Access Point des Pi. Weitere gemeldete Adressen werden nicht signiert; sie stehen nur in `pi.addresses`, die signierte zuerst. Die Adresse, von der die Anfrage kommt, zählt nicht (bis 0.3.0 war es sie): Hinter Docker auf DSM ist sie die von Docker, etwa `172.19.0.1`, hinter einem Proxy die des Proxys.
     - **Rückprüfung** (seit 0.3.1), bei jeder Kopplung:
       - Der Server fragt `GET http://<adresse>:8080/v1/pair-proof?nonce=<frisch>`, höchstens drei gemeldete Adressen der Reihe nach. Er tut das ohne Proxy, ohne Weiterleitung, mit fester Gesamtfrist von 2 Sekunden und höchstens 16 KB je Adresse.
       - Die Antwort muss als `proof` HMAC-SHA256(`token` des Antrags, `stowly-pair:<nonce>:<SHA-256 des Antrags>`) enthalten; die SHA-256 ist die von `csr_digest`. Die erste Adresse, die das besteht, kommt ins Zertifikat.
       - Den Nachweis liefert nur der Pi, der den Antrag gestellt hat, und nur solange `pair` läuft (`stowly_print.pairing.proof_responder`). Der Druckdienst ruht so lange und startet danach wieder, auch nach einem Fehler oder einem abgerissenen SSH (SIGHUP, SIGTERM). Er kennt den Pfad nicht, und `/v1/health` liefert einen anderen Nachweis. Wer das Token eines anderen Pi kennt (es liegt auf allen Geräten des Haushalts), bekommt so kein Zertifikat für dessen Adresse.
       - Der Ablauf hat drei Schritte. Code und Angaben prüft der Server unter der Bremse, die Rückprüfung läuft außerhalb (die Bremse ist ein Lock), danach prüft er noch einmal und signiert. Höchstens zwei Rückprüfungen laufen zugleich, sonst 429 mit `Retry-After: 5` ohne verbrauchte Runde. Je Code gibt es höchstens fünf Runden, danach 409 („Mit diesem Kopplungscode lief die Rückprüfung schon zu oft.").
       - Besteht keine Adresse, 422 mit `loc ["body", "addresses"]` und „Unter keiner gemeldeten Adresse (…) besteht der Pi die Rückprüfung: Port 8080 des Pi muss für Stowly erreichbar sein, solange er koppelt (die Anfrage kam von …)."
     - **Name:** `<hostname>.local` nur, wenn der Hostname mit `stowly` beginnt (etwa `stowly-pi`), sonst gar keiner. So bekommt kein Pi ein Zertifikat für `homeassistant.local` oder ähnliche Namen anderer Geräte.
     - **Nie:** eine Adresse, unter der die App selbst läuft, auch ohne HTTPS-Listener (422).
   - **Drucker:**
     - Gewählt oder bekannt: Der Server übernimmt den gewählten (`printer_id` der Kopplung) bzw. bekannten Drucker, sonst legt er einen neuen an. Die Wahl in der App geht vor; gelöschte Drucker kommen nicht wieder. Die `printer_id`, die der Pi selbst nennt (aus `pairing.json`), gilt nur, wenn sein Token zu diesem Drucker passt.
     - Verbindung `direct` mit `urls` `https://<IP>:8443`, `https://<hostname>.local:8443` (nur mit Namen, siehe oben) und `http://<IP>:8080`, dazu dem Token.
     - Beim Übernehmen ändert sich nur die Verbindung, der Name bleibt. Die Feld-Uhr der Verbindung geht auf die Serverzeit, damit eine ältere Änderung eines Geräts die Kopplung nicht überschreibt (7.1).
     - Die Zeile bekommt einen neuen `rev`; die Geräte erfahren es beim nächsten Sync.
   - **Antwort:** 200 `PiPairResult` mit Zertifikat, CA, Ursprüngen (der aus der Kopplung und die HTTPS-Ursprünge der App), Adressen und Ablauf, `Cache-Control: no-store`. Ein Geheimnis steht nicht darin.
   - **Derselbe Antrag noch einmal**, etwa nach einem Netzaussetzer, bekommt dieselbe Antwort. Ein anderer Antrag mit einem benutzten Code: 409.
- **Fehler:**
  - 404, wenn der Code unbekannt ist, auch bei einem Text, der kein Code sein kann.
  - 409 mit eigenem Satz: „Der Kopplungscode ist abgelaufen.", „Der Kopplungscode gilt nicht mehr: Er wurde in Stowly abgebrochen oder durch einen neueren ersetzt." bzw. „Mit diesem Kopplungscode ist schon ein Pi gekoppelt; ein Code gilt nur einmal."
  - 422 bei unbrauchbarem Antrag, Hostnamen oder Adressen. Gesperrt sind dabei alle Adressen der App: die Hosts der HTTPS-Ursprünge, der Host aus `origin` und der `Host`, unter dem der Pi den Server erreicht. Ebenso ein Hostname, dessen `.local`-Name ein Name der App ist.
  - 503 ohne nutzbare CA.
- **Bremse:** eigene, für alle zusammen. Jeder Fehlversuch zählt; nach 10 Fehlversuchen in 10 Minuten 60 Sekunden Sperre, 429 mit `Retry-After`. Eine Wiederholung mit demselben Antrag gilt nicht als Erfolg und setzt die Fehlversuche nicht zurück.
- **Code lesen:** Kleinschreibung, Bindestriche und Leerzeichen zählen nicht; O gilt als 0, I und L als 1.

### 11.9 Sicherung jetzt und Zurückspielen

**Sicherung jetzt:** `POST /api/backup/run` legt mit Geräte-Token eine verschlüsselte Sicherung wie die tägliche in den Ordner, `GET /api/backup/files/{name}` liefert eine Datei von dort. Regeln: [`integrationen.md`](integrationen.md), 3.8. Die unverschlüsselte Sicherung (`GET /api/backup`) gibt es seit 0.4.0 nicht mehr.

**Zurückspielen** geht in drei Schritten, danach startet Stowly neu (`stowly/restore.py`; Anleitung [`betrieb.md`](betrieb.md), 8.3). Alles liegt in `/data/restore` (`0700`, Dateien `0600`), in keiner Sicherung.

- **Wer darf:** Mit Geräte-Token gilt alles für den laufenden Stowly; ein unbekanntes Token gibt 401. Ohne Token nur beim ersten Start: solange es kein Passwort gibt (weder `STOWLY_PASSWORD` noch einen Hash), sonst 401, und mit der Regel für `Host` wie beim ersten Passwort (11.6), sonst 400.

1. **Hochladen:** `PUT /api/restore/upload`. Der Rumpf ist die Datei selbst (`application/octet-stream`, kein Formular), höchstens `RESTORE_MAX_BYTES` (512 MiB), sonst 413 `payload_too_large`; der Server zählt auch ohne `Content-Length` mit.
   - Die Art erkennt er an den ersten Bytes: `age` (binär oder ASCII-Armor), `gzip` oder `sqlite`. Anderes gibt 422 (`not_stowly`).
   - Nennt die Anfrage ihre Größe, braucht es dreimal so viel freien Platz, sonst 409 mit Satz.
   - Antwort 201 `RestoreUpload { upload_id, kind, size }`, `Cache-Control: no-store`. Ein neues Hochladen ersetzt das vorige erst, wenn es gelingt; eine geprüfte Sicherung bleibt, bis eine neue die Prüfung besteht. So nimmt ein zweites Gerät dem ersten nicht die geprüfte Sicherung weg.
   - Kommen 60 Sekunden lang keine Daten (`UPLOAD_IDLE_S`) oder dauert das Hochladen länger als 20 Minuten (`UPLOAD_TOTAL_S`), antwortet der Server mit 408 `invalid_request` und einem Satz und löscht die Teildatei.
   - Alle 5 Minuten räumt der Server auf, auch ohne Aufruf: abgelaufene Dateien und geprüfte Kopien (nach 30 Minuten), Reste ohne Besitzer in `/data/restore` und nach 7 Tagen die Datenbank von vor dem Zurückspielen.
2. **Prüfen:** `POST /api/restore/check` mit `RestoreCheckInput { upload_id, identity }`.
   - `identity` ist der geheime Schlüssel (`AGE-SECRET-KEY-1…`), auch als ganze Schlüsseldatei (Zeilen mit `#` zählen nicht), höchstens 4096 Zeichen, nur bei `age`. Der Server entschlüsselt mit `pyrage`; der Schlüssel lebt nur im Arbeitsspeicher und steht nie in einer Antwort oder im Log.
   - Dann entpackt er (höchstens 2 GiB, sonst 413) und öffnet die Kopie abgesichert (`trusted_schema = OFF`, `DBCONFIG_DEFENSIVE`, Trigger und Views abgeschaltet, nur lesend); so laufen auch alle späteren Verbindungen zur Kopie. Geprüft wird der Reihe nach: `quick_check`; `PRAGMA application_id` „STOW" (Migration 0005, Abschnitt 15) oder 0; `user_version` zwischen 1 und dem Stand dieses Servers; keine Trigger und keine Views, gleich unter welchem Namen; der Aufbau Zeichen für Zeichen wie aus den Migrationen dieses Stands, also keine fremden oder veränderten Tabellen (Statistiktabellen aus `ANALYZE` nur in der Form, in der SQLite sie anlegt); `integrity_check` und `foreign_key_check`. Erst dann migriert er die Kopie auf den eigenen Stand; Statistiktabellen fallen dabei weg.
   - Antwort 200 `RestorePreview`: `restore_id` (gilt `RESTORE_ID_TTL_S`, 30 Minuten, bis `expires_at`), `kind`, `schema_version` der Sicherung und `current_schema_version`, `last_activity_at` (jüngstes Ereignis oder jüngster Befehl), `has_password`, `devices` (nicht gesperrte), `counts` (`products`, `items` = Packungen im Bestand, `zones`, `shopping` = offene Einträge).
   - Mit einem anderen Schlüssel lässt sich die Prüfung wiederholen, ohne neues Hochladen; auch `upload_id` gilt 30 Minuten.
3. **Anwenden:** `POST /api/restore/apply` mit `RestoreApplyInput { restore_id, password, device_name }`, Antwort 202 `RestoreApplied { login }`, `Cache-Control: no-store`. Der Server legt die geprüfte Kopie als `pending.sqlite3` bereit, dazu `pending.json` mit Prüfsumme und neuer `dataset_id`, und startet nach der Antwort neu.
   - **Laufender Stowly:** `password` ist das jetzige Haushalts-Passwort. Es läuft über die Bremse der Anmeldung (Abschnitt 5): falsch 401 `invalid_password`, gesperrt 429. `login` ist `null`: Alle Anmeldungen bleiben.
   - **Erster Start:** `device_name` ist nötig (sonst 422). Enthält die Sicherung ein Passwort (`has_password`), muss `password` dieses sein (sonst 401 `invalid_password`, ebenfalls über die Bremse); das zeigt zugleich, dass die Sicherung echt ist. Sonst ist `password` ein neues (mindestens `LIMITS.password_min`, sonst 422); dann sperrt der Server die Geräte aus der Sicherung und löscht ihre Push-Abos. `login` bringt Token und Gerät dieses Geräts; es gilt, sobald `GET /api/health` nach dem Neustart `configured: true` meldet.
   - Beim ersten Start vergisst der Server außerdem, was zur alten CA gehört: den Abschluss der Einrichtung (`finished_at`), „über HTTPS gesehen", die gelernten Ports und die Markierung des Schritts `https`. Der Assistent beginnt so mit der sicheren Verbindung.

**Neustart und Tausch:**

- Nach der Antwort 202 beendet Stowly beide Listener sauber und ersetzt seinen Prozess (`os.execv`); der Container läuft weiter. Scheitert das, endet der Prozess mit Exit-Code 3, und Docker startet ihn neu. Unter Windows (Entwicklung) beginnt er im selben Prozess von vorn.
- Getauscht wird nur im frisch gestarteten Prozess, bevor etwas die Datenbank öffnet (`restore.resume`, vor `create_app`):
  1. die bereitgelegte Datei prüfen: Prüfsumme, `quick_check`, Version;
  2. die laufende Datenbank checkpointen und auf `journal_mode = DELETE` stellen; das gelingt nur ohne offene Verbindung, und danach gibt es kein `-wal` mehr;
  3. in einer Kopie die Zugänge übernehmen (unten), die neue `dataset_id` setzen und `server.restored` verbuchen (Abschnitt 12);
  4. die alte Datenbank wird `previous.sqlite3`, die Kopie die Datenbank (`os.replace`).
- Jeder Schritt lässt sich nach einem Absturz wiederholen; ob schon getauscht ist, zeigt die `dataset_id`. Ein Fehler davor behält die alte Datenbank, merkt `failed` und startet normal, ohne Neustart-Schleife. Eine bereitgelegte Sicherung gilt 10 Minuten nach dem Anwenden; kommt der Neustart später, verwirft der Server sie (`failed`).

**Was ein laufender Stowly behält:** aus der laufenden Datenbank die Tabellen `devices`, `push_subscriptions`, `server_config` und `job_runs`, aus `meta` den Passwort-Hash und die VAPID-Schlüssel. So wird niemand abgemeldet, und gesperrte Geräte bleiben gesperrt. Geräte aus einer gefälschten Datei zählen nicht, denn age prüft den Absender nicht. Dazu:

- **Merker `ha_links_entity`:** Er gehört zu `ha_links` und kommt deshalb mit der Sicherung, obwohl der Rest von `server_config` bleibt. Hat die Sicherung keinen (vor 0.4.0), leert der Server `ha_links` und löst die Bindungen der Einkaufsliste (`bring_key = null`); nichts wird abgehakt, der nächste Abgleich spiegelt die offenen Einträge neu ([`integrationen.md`](integrationen.md), 5.4). Das gilt auch beim ersten Start.
- **Reservierte Kennungen:** Packungen, die es nur in der laufenden Datenbank gibt (sie entstanden nach der Sicherung), und dort reservierte Kennungen, die die Sicherung nicht als Packung kennt, kommen nach `id_reservations` (Abschnitt 8). So bekommt kein gedrucktes Etikett eine Kennung ein zweites Mal.
- Kopplungen eines Pi, deren Gerät es nicht mehr gibt, verlieren den Verweis darauf.
- `STOWLY_PASSWORD` geht weiter vor.

Beim ersten Start übernimmt der Server nichts; alles kommt aus der Sicherung. Aus der Sicherung fallen außerdem Bilder weg, die kein JPEG, PNG oder WebP sind oder deren Bytes nicht zum Typ passen (das Log zählt sie), und Kopplungen eines Pi, die dort noch offen waren, gelten als abgebrochen; für den Pi braucht es einen neuen Code. Seit 0.5.0 fallen auch die Etikett-Vorlagen der Sicherung weg (`label_templates`, abgeleitete Daten: Der Start erzeugt sie neu), und die Gestaltung (`label_design`) bleibt nur, wenn sie höchstens 64 KiB groß, als UTF-8 lesbar und nach dem Vertrag gültig ist, ihr Papier im Katalog steht und `updated_at` ein Zeitstempel ist; sonst steht im Log, dass sie verworfen wurde. All das geschieht schon in der geprüften Kopie, für beide Arten des Zurückspielens. Eine Vorlage aus einer gefälschten Sicherung kommt so nie über den Sync auf die Geräte, und eine kaputte Gestaltung verhindert nie den Start.

**Danach:** Die neue `dataset_id` lässt jedes Gerät den Bestand vollständig neu holen (`reset: true`, 6.4). Seine Outbox sendet es erneut; Befehle, die schon in der Sicherung stecken, erkennt der Server als bekannt.

**Stand:** `GET /api/restore` (Geräte-Token, `Cache-Control: no-store`) liefert `RestoreStatus { state, at, message, undo_until }`.

- `state`: `idle`, `pending` (bereitgelegt, der Neustart steht aus), `done`, `undone` oder `failed`, dann mit dem Satz „Das Zurückspielen ist gescheitert: … Die bisherige Datenbank läuft weiter." Nach `RESTORE_UNDO_DAYS` (7) Tagen ist der Stand wieder `idle`.
- Die App fragt nach dem Anwenden hier, bis nicht mehr `pending` dasteht; beim ersten Start fragt sie `GET /api/health`, bis `configured: true` kommt. Beides höchstens fünf Minuten.

**Rückgängig:** `POST /api/restore/undo` (Geräte-Token) spielt `previous.sqlite3` über denselben Tausch zurück: 202 `RestoreApplied`, Neustart, `server.restored` mit `kind: undo`. Das geht bis `undo_until`, sieben Tage nach dem Zurückspielen in einen laufenden Stowly, und lässt sich selbst wieder umkehren. 404, wenn es nichts gibt; beim ersten Start gibt es kein Rückgängig. `DELETE /api/restore/previous` löscht die alte Datenbank vorzeitig (204, wiederholbar). Nach sieben Tagen löscht der Server sie selbst.

**Fehler:**

- 422 `invalid_request` mit `details.reason` und einem deutschen Satz, nie mit dem Schlüssel:
  - `wrong_key`: Der Schlüssel öffnet die Datei nicht.
  - `not_a_key`: kein geheimer age-Schlüssel, auch ein öffentlicher (mit eigenem Satz).
  - `not_stowly`: keine Datei oder Datenbank von Stowly, auch eine mit fremdem Aufbau, mit Triggern oder Views.
  - `damaged`: beschädigt oder unvollständig; seit 0.5.0 auch, wenn ein Text der Datenbank kein gültiges UTF-8 ist, ein einzelner Text 16 MiB übersteigt oder JSON tiefer als 64 Ebenen verschachtelt ist (Stowly selbst schreibt höchstens fünf). Geprüft wird jeder Text aller Tabellen (Bilder ausgenommen), bei beiden Arten des Zurückspielens: Sonst könnte eine gefälschte Sicherung jeden Start von Stowly verhindern.
  - `newer_schema`: von einem neueren Stowly.
  - `migration_failed`: Die Migration der Kopie scheiterte; Einzelheiten im Log.
- 404 `not_found`, wenn `upload_id` oder `restore_id` abgelaufen oder unbekannt ist.
- 409 `conflict`, solange eine Sicherung bereitliegt, ein Update angefordert ist oder läuft, bei zu wenig Platz und beim ersten Start, wenn inzwischen ein Passwort gesetzt ist. Eine Anforderung, die der Updater seit 10 Minuten nicht abholt, und ein Update, zu dem er seit 15 Minuten schweigt, zählen nicht. Umgekehrt antwortet `POST /api/update/install` mit 409, solange ein Schritt läuft oder eine Sicherung bereitliegt ([`integrationen.md`](integrationen.md), 10.5).
- 408 `invalid_request` mit Satz, wenn das Hochladen stockt oder zu lange dauert (oben).
- 413 `payload_too_large` über 512 MiB, entpackt über 2 GiB.
- 429 `rate_limited` mit `Retry-After` aus einer eigenen Bremse: ein Schritt zugleich, Hochladen und Prüfen höchstens sechsmal in 10 Minuten. Passwörter zählen in der Bremse der Anmeldung.
- 503 `not_configured`, wenn sich Stowly hier nicht selbst neu starten kann (ohne Listener, etwa in Tests).

### 11.10 Home Assistant aus der App

`GET` und `PATCH /api/server-config/ha`, `POST /api/server-config/ha/check` und `POST`, `GET`, `DELETE /api/server-config/ha/sensor-token`, alle mit Geräte-Token und `Cache-Control: no-store`. Regeln: [`integrationen.md`](integrationen.md), Abschnitte 5 und 6.

- **`HaConfig`:** `source` der Verbindung (`env`: Adresse, Token und Liste kommen aus der Umgebung und sind gesperrt; `app`; `default`: nichts eingerichtet), `url`, `entity`, `token_set`, `token_set_at`, `ca` (`STOWLY_HA_CA` ist gesetzt), `configured`, `problem` und `sensor { source, set, set_at }`. Nie ein Token.
- **`PATCH` mit `HaConfigChanges { url, entity, token }`:** Nur vorhandene Felder zählen, `null` entfernt.
  - Eine neue Adresse ohne `token` im selben Aufruf löscht den gespeicherten Token; dieselbe Adresse behält ihn. Ein Token ohne Adresse gibt 422.
  - Der Token geht in den eigenen Speicher (`/data/secrets`), Adresse und Liste nach `server_config`. `server.config_changed` nennt nur die Schlüssel (Abschnitt 12). Der Abgleich übernimmt die Änderung ohne Neustart.
  - 409 `conflict`, wenn die Verbindung aus der Umgebung kommt. 422 mit `details.errors[].loc` (`["body", "url"]`, `["body", "token"]`) bei einer ungültigen oder nicht erlaubten Adresse, einem Token, der nicht in eine Kopfzeile passt, oder einem Token ohne Adresse; die Liste muss `^todo\.[a-z0-9_]+$` treffen. 500, wenn sich der Token nicht speichern lässt; dann ändert sich nichts.
- **`POST /check` mit `HaCheckInput { url, token }`:** prüft und speichert nichts; ohne Felder die wirksame Einrichtung. Antwort `HaCheck`. Der gespeicherte Token geht nur an seine eigene Adresse. 409, wenn die Verbindung aus der Umgebung kommt und trotzdem Felder angegeben sind; 422 an `["body", "url"]` ohne jede Adresse; 429 mit `Retry-After`, wenn schon eine Prüfung läuft oder die letzte vor weniger als 3 Sekunden begann. Ablauf, Grenzen und Zustände: [`integrationen.md`](integrationen.md), 5.7.
- **Sensor-Token:** `POST` erzeugt einen neuen (64 Hex-Zeichen; 201 `HaSensorToken { token }`) und ersetzt den bisherigen; `GET` zeigt den gespeicherten (404 ohne, auch wenn er nach einem Zurückspielen fehlt); `DELETE` entfernt ihn (204, auch ohne), danach antwortet der Sensor mit 503. Alle drei geben 409, wenn `STOWLY_HA_SUMMARY_TOKEN` gesetzt ist.

### 11.11 Etiketten gestalten (seit 0.5.0)

Die Gestaltung der Etiketten gilt für den ganzen Haushalt (docs/etiketten.md, 3.2): ein Papier für alle Drucker, je eine Gestaltung für Packungs- und Zonen-Etiketten. Sie steht in der Tabelle `label_design` (eine Zeile, nicht im Sync, in jeder Sicherung). Die Geräte bekommen nur die daraus erzeugten Vorlagen, über `label_templates` wie bisher.

| Aufruf | Antwort |
|---|---|
| `GET /api/labels/design` | `LabelDesignState`: Papier und beide Gestaltungen, `is_default`, `updated_at`, die `hash` der gültigen Vorlagen (`templates`) und der Papier-Katalog (`papers`). Der Katalog kommt vom Server, nicht aus `api.gen.ts`: Das schont das Bündel der App. |
| `PUT /api/labels/design` mit `LabelDesign` | Speichert Papier und beide Gestaltungen zusammen, erzeugt die Vorlagen neu und antwortet mit dem neuen `LabelDesignState`. Ändert sich ein `hash`, bekommt die Vorlage einen neuen `rev`, und alle Geräte bekommen sie beim nächsten Abgleich. Etiketten, die schon unterwegs sind, behalten ihren Inhalt (docs/etiketten.md, 4.1). Passt die Gestaltung nicht, 422 mit einem Satz. |
| `DELETE /api/labels/design` | Zurück zur Vorgabe: Es gelten wieder die mitgelieferten Vorlagen mit ihrem `hash`. Dasselbe geschieht, wenn `PUT` genau die Vorgabe speichert. |
| `POST /api/labels/preview` mit `LabelPreviewInput` | `LabelPreview`: das Etikett als 1-Bit-PNG, so wie man es liest, mit Größe und Hinweisen („Name auf 3,0 mm verkleinert und gekürzt."). Speichert nichts. Höchstens `LABEL_PREVIEWS_AT_ONCE` (2) zugleich, sonst 429 `rate_limited`; die App wartet 300 ms nach der letzten Änderung. Die Daten dürfen nicht länger sein als in der App (`qr` 41, `id` 5, `title` 120 bzw. 60 bei Zonen, `subtitle` 123, `quantity` 40, `brand` 80, `zone` 60, Datum 10, kurzes Datum 8 Zeichen); Längeres lehnt der Server mit 422 und einem Satz ab („Zu lang für ein Etikett: Name höchstens 120 Zeichen."), Stelle `["body", "data", <Schlüssel>]`. Unbekannte Schlüssel übergeht er. |

Beim Start erzeugt der Server die Vorlagen aus der Gestaltung, sonst nimmt er die mitgelieferten. Ändert ein späterer Stowly den Generator, ändern sich beim Start auch die Vorlagen aus einer eigenen Gestaltung, so wie bisher die mitgelieferten. Den `hash` einer gespeicherten Vorlage rechnet der Server dabei aus ihrem Rumpf nach, statt der Spalte zu trauen. Lässt sich die Gestaltung nicht lesen, gelten die mitgelieferten Vorlagen, `GET` zeigt die Vorgabe (`is_default: true`), und das nächste Speichern ersetzt die Zeile. Das gilt auch für ein Papier, das dieser Stowly nicht kennt, etwa nach der Rückkehr zu einer älteren Version. Lässt sie sich lesen, aber nicht mehr erzeugen (ein späterer Generator), bleibt die bisherige Vorlage, sofern ihr Rumpf zu ihrem `hash` passt, sonst die mitgelieferte. Der Start scheitert daran nie.

### 11.12 Produktbild setzen (seit 0.5.0)

`PUT /api/products/{product_id}/image` mit `ProductImageInput { image_id }` setzt das Bild eines Produkts auf ein Bild, das Stowly gespeichert hat (`image_id` aus `LookupResult`), oder entfernt es (`null`). 404 ohne Produkt (auch ein zusammengeführtes), 422 für ein unbekanntes Bild. Das Produkt bekommt einen neuen `rev`, also sehen alle Geräte das Bild beim nächsten Abgleich; die Antwort ist das Produkt danach. Der Aufruf liegt außerhalb des Sync: Protokoll 2 bleibt, und `product.update` ändert sich nicht. Offline geht er nicht; die App sagt dann, dass nur das Bild fehlt.

## 12. Ereignisprotokoll

Der Server schreibt zu jeder Wirkung eines Befehls mindestens einen Eintrag in `events`. Das Protokoll wird nie gekürzt und nicht an die Geräte synchronisiert; es ist über `GET /api/events` lesbar. Die Statistik (11.1) rechnet nicht daraus, sondern aus dem heutigen Stand der Packungen: So zählt ein Zusammenführen oder ein geänderter Grund richtig.

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
| `product.image` | `product` | `old`, `new`: Bild-IDs oder `null` (seit 0.5.0, 11.12) |
| `zone.created`, `zone.updated` | `zone` | wie bei Packungen |
| `zone.deleted` | `zone` | `moved_to`, `packages`: Anzahl |
| `settings.updated` | `settings` (`entity_id`: `household`) | `changes`, `superseded` |
| `printer.created`, `printer.updated`, `printer.deleted` | `printer` | `changes` ohne Token |
| `print.requested`, `print.reported` | `print_job` | `kind`, `state`, `printer_id`, `error` |
| `device.login`, `device.revoked`, `device.renamed` | `device` | `name` |
| `command.rejected` | Art des Befehls | `code`, `type` |
| `shopping_item.created` | `shopping_item` | `product_id`, `text`, `quantity` |
| `shopping_item.updated` | `shopping_item` | `changes`, `superseded` wie bei Packungen; `done` als Feld |
| `shopping_item.deleted` | `shopping_item` | `origin`, `product_id` |

**Was der Server selbst schreibt** (7.6, Bring!), steht mit `device_id: null` und eigenem Typ im Protokoll. `command_id` nennt den Befehl, der es ausgelöst hat, beim Abgleich mit Bring! `null`; `at` ist der wirksame Zeitpunkt des Befehls bzw. die Serverzeit des Abgleichs.

| `type` | `entity` | `data` |
|---|---|---|
| `shopping_item.auto_created` | `shopping_item` | `product_id`, `quantity` |
| `shopping_item.auto_quantity` | `shopping_item` | `product_id`, `old`, `new` |
| `shopping_item.auto_removed` | `shopping_item` | `product_id`, `quantity`, `reason`: `stock` (Bestand reicht oder kein Mindestbestand) oder `merge` (zwei offene zusammengelegt) |
| `shopping_item.store_done` | `shopping_item` | `product_id`, `package_id` |
| `shopping_item.bring_done` | `shopping_item` | `name`, `how`: `completed` (abgehakt) oder `removed` (gelöscht) |
| `product.shopping_lock` | `product` | `lock`: der Zeitpunkt der Sperre oder `null` (aufgehoben), `old` |
| `printer.paired` | `printer` | `created` (neu angelegt oder übernommen), `name`, `direct` ohne Token, `token_changed`, `hostname`, `addresses` (gemeldet), `sans` (signiert), `serial`, `not_after`, `pairing_id` (11.8) |

**Einrichtung und Kopplung** (11.6 bis 11.8) stehen mit dem Gerät, das sie ausgelöst hat, ohne `command_id`:

| `type` | `entity` | `data` |
|---|---|---|
| `server.password_set` | `server` (`entity_id`: `password`) | `source`: `app` (erstes Passwort, auch ein neues beim Zurückspielen beim ersten Start) oder `env` (aus `STOWLY_PASSWORD` übernommen, ohne Gerät) |
| `server.password_changed` | `server` (`entity_id`: `password`) | – |
| `server.config_changed` | `server` (`entity_id`: `config`) | `keys`: die geänderten Schlüssel, nie ihre Werte (aus `PATCH /api/server-config`: `push_contact`, `update_enabled`, `backup_enabled`, `backup_time`, `backup_recipients`; aus `PATCH /api/server-config/ha`: `ha_url`, `ha_todo_entity`, `ha_token_set_at`; aus den Aufrufen zum Sensor-Token: `ha_sensor_set_at`; aus `PATCH /api/setup`: `setup_steps`, `setup_finished_at`, `tls_addresses`, `https_port`) |
| `server.restored` | `server` (`entity_id`: `restore`) | `kind`: `restore` oder `undo`; `source`: `age`, `gzip`, `sqlite` oder `previous` (beim Rückgängig); `first_start`; `schema_version` der Sicherung (`null` beim Rückgängig). Verbucht beim Tausch in der neuen Datenbank, mit dem Gerät, das angewendet hat (11.9) |
| `pi_pairing.created` | `pi_pairing` | `printer_id` (gewählt oder `null`) |
| `pi_pairing.cancelled` | `pi_pairing` | `reason`: `user` oder `replaced` (ein neuerer Code) |
| `labels.changed` | `labels` (`entity_id`: `design`) | `paper`, `default` (`true` nach dem Zurücksetzen oder wenn genau die Vorgabe gespeichert wurde), `templates`: die Schlüssel der Vorlagen mit neuem `hash`; seit 0.5.0, 11.11. Ein Speichern ohne Wirkung schreibt keinen Eintrag |

Das Zusammenführen vermerkt die mitgewanderten Einträge in `product.merged` (`shopping_items`: Anzahl).

`printer.report` erzeugt keinen Eintrag (zu häufig, kein bleibender Wert), ebenso wenig ein Befehl ohne Wirkung. Tokens und das Passwort stehen nie im Protokoll. `data` darf weitere Schlüssel tragen als hier genannt (derzeit: `barcodes` und `filled` bei `product.merged`, `package_id` und `zone_id` bei `print.requested`, `old` bei `print.reported` und `device.renamed`, `message` bei `command.rejected`, `token_changed` bei `printer.updated`); wer das Protokoll auswertet, übergeht Unbekanntes.

## 13. Fehlerformat

Jede Fehlerantwort unter `/api` hat denselben Rumpf (`ErrorBody`):

```json
{ "error": { "code": "invalid_password", "message": "Das Passwort stimmt nicht.", "details": null } }
```

| HTTP | `code` | Wann | In der App (`CoreError`) |
|---|---|---|---|
| 401 | `unauthorized` | Token fehlt, ist unbekannt oder gesperrt | `unauthorized`; das Gerät gilt als abgemeldet (`revoked`) |
| 401 | `invalid_password` | falsches Haushalts-Passwort | `invalid_password` |
| 404 | `not_found` | Pfad oder Datensatz gibt es nicht | `not_found` |
| 400, 405, 422 | `invalid_request` | Anfrage verletzt den Vertrag; bei 400 und 422 nennt `details.errors` die Stellen (`loc`, `msg`, `type`) | `invalid` |
| 408 | `invalid_request` | Das Hochladen einer Sicherung stockt 60 Sekunden oder dauert länger als 20 Minuten (11.9) | `invalid` |
| 409 | `conflict` | Zustand passt nicht zur Anfrage (etwa: Update schon angefordert) | `conflict` |
| 409 | `protocol_mismatch` | verschiedene Protokollversionen; `details: { server, client }` | `protocol_mismatch` |
| 413 | `payload_too_large` | zu viele Befehle, zu großer Rumpf, auch ohne `Content-Length`; eine Sicherung über 512 MiB bzw. entpackt über 2 GiB (11.9) | `internal` |
| 429 | `rate_limited` | zu viele Fehlversuche bei der Anmeldung (auch beim Passwort zum Zurückspielen oder zum Hinzufügen eines Schlüssels), zu viele Testnachrichten (11.3), zu häufiges Suchen nach Updates (11.5), „Jetzt sichern" öfter als einmal je Minute, Zurückspielen (11.9), Prüfung der Verbindung zu HA (11.10); `Retry-After`, `details.retry_after_s` | `rate_limited` mit `details.retry_after_s` |
| 500 | `internal` | Fehler im Server; Einzelheiten nur im Log | `internal` |
| 501 | `not_implemented` | Endpunkt ist noch nicht umgesetzt | `not_supported` |
| 503 | `not_configured` | Es gibt noch kein Passwort, oder eine Integration, die der Aufruf braucht, ist nicht eingerichtet: Push (kein Kontakt), Sensor (kein Sensor-Token), Updates (aus, oder der Updater meldet sich nicht), Pi koppeln (keine nutzbare CA oder kein Paket), „Jetzt sichern" (kein Schlüssel oder kein brauchbarer Ordner), Zurückspielen (kein Neustart möglich) | `not_configured` |

`message` ist deutscher Klartext und als Rückfall anzeigbar. Die App unterscheidet nach `code` und zeigt dazu ihren eigenen Text; die letzte Spalte nennt, als welchen Fehler ihr Kern die Antwort an die Oberfläche weitergibt (`web/src/core/http.ts`). Eine Fehlerantwort ohne diesen Rumpf stammt nicht vom Stowly-Server und gilt in der App als `offline` (Abschnitt 9.2). Im Server: `raise ApiError(status, ErrorCode.X, "…")` aus `stowly/errors.py`. Unbekannte Pfade unter `/api` und `/print` antworten bei jeder Methode mit 404, ein bekannter Pfad mit falscher Methode mit 405 und der Kopfzeile `Allow`; 401 trägt `WWW-Authenticate: Bearer`.

Die Ergebnisse einzelner Befehle (`CommandResult.code`) sind davon getrennt: Ein abgelehnter Befehl ist kein HTTP-Fehler.

## 14. Dieselben Typen auf beiden Seiten

**Die Quelle aller Datentypen ist Python:**

- `server/stowly/contract/` (pydantic): Datensätze, Befehle, Sync-Aufruf, Endpunkte, Fehlerformat, Etikett-Daten
- `print/stowly_print/model.py` (Dataclasses, ohne pydantic): Protokoll des Druckdienstes

Daraus entstehen mit `python -m stowly.contract.export`:

- [`docs/openapi.json`](openapi.json): alle Endpunkte und Schemata
- `web/src/contract/api.gen.ts`: dieselben Typen und Konstanten für die Web-App (`ENDPOINTS`, `PROTOCOL_VERSION`, `COMMAND_TYPES`, das ID-Alphabet, die QR-Präfixe, die Eingabegrenzen `LIMITS`)

**Eingabegrenzen stehen an einer Stelle:** `server/stowly/contract/limits.py`. Die Modelle des Servers lesen sie dort, der Export schreibt sie als `LIMITS` in die Web-App, und dort prüfen der Kern und die Attrappe ihre Eingaben mit denselben Funktionen und Sätzen (`web/src/contract/input.ts`), bevor ein Befehl entsteht. Was die App annimmt, lehnt der Server deshalb nicht als `invalid` ab.

Beide Dateien sind eingecheckt und werden nie von Hand geändert. Der Test `server/tests/test_contract.py::test_generated_files_are_current` schlägt fehl, sobald Modelle oder Endpunkte nicht mehr zu ihnen passen. **Eine Vertragsänderung ist also immer sichtbar:** Sie ändert die Modelle, beide erzeugten Dateien und dieses Dokument, und nur der Coordinator nimmt sie vor.

Regeln, die sich nicht als Typ ausdrücken lassen, gibt es als Funktionen auf beiden Seiten, geprüft gegen dieselben Beispiele in [`vectors.json`](vectors.json):

| Regel | Server | Web-App |
|---|---|---|
| Packungs-IDs, UUIDs | `stowly/contract/ids.py` | `web/src/contract/ids.ts` |
| QR-Inhalte | `stowly/contract/ids.py` | `web/src/contract/qr.ts` |
| Barcodes, „wird nachgeschlagen?" | `stowly/contract/ids.py` | `web/src/contract/barcode.ts` |
| Eingabegrenzen | `stowly/contract/limits.py` | `LIMITS` in `api.gen.ts`, Prüfungen in `web/src/contract/input.ts` |
| Zeitstempel, wirksamer Zeitpunkt, Uhrzeit, Monat | `stowly/contract/timeutil.py` | `web/src/contract/time.ts` |
| Warnstufen nach dem MHD, Eintritt in „bald" und „abgelaufen" | `stowly/contract/mhd.py` | `web/src/contract/mhd.ts` |
| MHD-Eingabe | – | `web/src/contract/mhd.ts` |
| Automatische Einträge der Einkaufsliste (7.6) | Server (Runde 1), gegen `shopping_auto` | Nachbildung in `web/src/core/testing`, gegen `shopping_auto` |
| Fehlbestand, Name und Menge eines Eintrags | – (der Server rechnet den Fehlbestand nach 7.6) | `web/src/contract/shopping.ts` |
| Welche Packung als Nächstes dran ist (FIFO) | – | `web/src/contract/fifo.ts` |
| Etikett-Daten, „welcher Drucker?" | `stowly/contract/labels.py` (nur Typ) | `web/src/contract/labels.ts` |
| age-Schlüssel: der öffentliche zum geheimen, die Schlüsseldatei (seit 0.4.0, gegen `age_keys`) | `pyrage` (geprüft in `server/tests`) | `web/src/features/backup/keys.ts` |

Die Schnittstelle zwischen Oberfläche und Offline-Kern steht in `web/src/contract/core.ts`.

## 15. Datenbankschema

Das Schema steht in `server/stowly/migrations/` und ist Teil dieses Vertrags: `0001_initial.sql` für Stufe 1, Ergänzungen als weitere, nummerierte Migrationen. Eine Migration wird nach ihrem Commit nicht mehr geändert; neue Migrationen schreibt nur der Coordinator. `stowly.db.migrate` wendet sie beim Start an und merkt sich den Stand in `PRAGMA user_version`.

| Migration | Inhalt |
|---|---|
| `0001_initial.sql` | das Schema |
| `0002_device_command_floor.sql` | `devices.last_command_at`: wirksamer Zeitpunkt des letzten gültigen Befehls je Gerät (Abschnitt 4). Bestehende Datenbanken bekommen den spätesten Zeitpunkt aus `commands`. |
| `0003_shopping_push_jobs.sql` | Stufe 2: `products.min_stock` und `products.shopping_lock_at` (Sperre, 7.6), die Tabellen `shopping_items`, `push_subscriptions`, `push_notices`, `ha_links` und `job_runs`, die Einstellung `notify_time` (`"17:00"`) für Datenbanken, die schon Einstellungen haben. Ändert nichts an der Änderungsfolge. |
| `0004_setup.sql` | Einrichtung: die Tabellen `server_config` (Einstellungen des Servers aus der App und was er über sich lernt) und `pi_pairings` (Kopplungen eines Pi). Datenbanken, die schon Geräte haben, gelten als eingerichtet (`setup_finished_at`). Ändert nichts an der Änderungsfolge. |
| `0005_application_id.sql` | Stufe B der Einrichtung: `PRAGMA application_id` = „STOW" (`0x53544F57`). Daran erkennt das Zurückspielen eine Datenbank von Stowly (11.9); ältere Kopien haben 0 und gelten ebenso. Ändert keine Tabelle und nichts an der Änderungsfolge. |

| Tabelle | Inhalt |
|---|---|
| `meta` | Einzelwerte: `dataset_id`, die VAPID-Schlüssel, seit Schema 4 `password_hash` (scrypt) |
| `counters` | `rev` (Änderungsfolge), `settings_rev` |
| `devices` | Geräte mit Token-Hash, `last_seen_at`, `revoked_at`, `last_command_at` |
| `zones`, `products`, `product_barcodes`, `packages` | der Bestand |
| `shopping_items` | Einkaufsliste (3.6), dazu nicht synchronisiert: wodurch ein Eintrag geschlossen wurde (`closed_by`) und an welchen Artikel in Bring! er gebunden ist (`bring_key`) |
| `field_clocks` | Uhr je Datensatz und Feld (7.1), dazu `removed` je Packung (7.2); Einträge der Einkaufsliste als `shopping_item` mit `text`, `quantity`, `done` |
| `settings` | Einstellungen des Haushalts, ein Schlüssel je Zeile |
| `commands` | jeder verarbeitete Befehl mit Ergebnis |
| `events` | Ereignisprotokoll |
| `id_reservations` | reservierte, noch unbenutzte Packungs-IDs |
| `off_lookups`, `images` | Open Food Facts: Warteschlange, Ergebnisse, Bilder |
| `printers`, `printer_status`, `print_jobs`, `label_templates` | Druck |
| `push_subscriptions`, `push_notices` | Push: Abo je Gerät; welche Packung schon in einer Tagesnachricht stand ([`integrationen.md`](integrationen.md), 4) |
| `ha_links` | Home Assistant und Bring!: was Stowly je Artikel zuletzt geschrieben und gesehen hat ([`integrationen.md`](integrationen.md), 5.3) |
| `job_runs` | Zeitplan: je Aufgabe der letzte Lauf ([`integrationen.md`](integrationen.md), 1) |
| `server_config` | Einstellungen des Servers aus der App und Gelerntes (Adressen, Ports, Fortschritt des Assistenten), seit 0.4.0 auch Sicherung, Adresse und Liste von HA und Merker ohne Geheimnis (`ha_token_set_at`, `ha_sensor_set_at`, `ha_links_entity`), je Schlüssel ein JSON-Wert; nie ein Geheimnis (11.6, 11.7, 11.10) |
| `pi_pairings` | Kopplungen eines Pi: Hash des Codes, Fristen, was der Pi gemeldet hat, die Antwort an ihn (11.8) |

Nicht in der Datenbank, aber im selben Datenordner: `/data/tls` (CA und Zertifikat), `/data/secrets` (Tokens aus der App, 11.10), `/data/restore` (Zurückspielen, 11.9), `/data/print` und `/data/update`. Keiner davon steht in einer Sicherung.

Regeln für jeden Zugriff (`stowly/db.py`):

- SQLite direkt über die Standardbibliothek, ohne ORM. Tabellen sind `STRICT`, Fremdschlüssel sind eingeschaltet, Journal im WAL-Modus.
- Jeder schreibende Ablauf läuft vollständig in `with db.transaction(con):` (`BEGIN IMMEDIATE`).
- Jedes Schreiben an einer synchronisierten Zeile setzt `rev = db.next_rev(con)`. Ohne das erfährt kein Gerät von der Änderung. Die Einstellungen teilen sich `counters.settings_rev`.
- Die erste Zone, die Einstellungen und die `dataset_id` legt `db.seed_defaults` beim ersten Start an.
