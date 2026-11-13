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
- **Zugestellt wird ein Etikett immer von dem Gerät, das es angefordert hat**, an den Druckdienst seines Druckers, beim Server wie beim Pi mit denselben Aufrufen. Der Sync trägt das Etikett als Datensatz und seine Zustände, nicht den Druckauftrag (Abschnitt 4.1).

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
- **Mindestgröße im Bild:** Das Etikett einer Packung oder Zone zählt beim Scannen erst, wenn die Kante seines QR-Codes mindestens **7 %** der Kante des Auswertungsquadrats misst (benannte Konstante im Scanner, `MIN_LABEL_SIDE_RATIO = 0.07`). Gemessen wird der Code selbst (Mittel der vier Kanten aus den Eckpunkten der Erkennung), ohne Ruhezone. Ist ein Etikett erkannt, aber kleiner, bucht die App nichts, sondern zeigt „Näher ran". Für Produkt-Barcodes gilt die Grenze nicht. Herleitung: Der Code des Packungs-Etiketts ist 16 mm breit (3.2), der des Zonen-Etiketts knapp 20 mm. Das Auswertungsquadrat (80 % der kürzeren Bildseite) erfasst bei einer üblichen Hauptkamera (etwa 43° über die kürzere Seite) eine Fläche mit rund 0,63 × Abstand Kantenlänge. Ein Packungs-Etikett füllt damit bei 20 cm Abstand etwa 13 %, bei 30 cm 8,5 %, bei 36 cm 7 %, bei 60 cm 4 % und bei 1 m 2,5 % der Kante. Wer ein Etikett bewusst scannt, hält es näher als 30 cm; das Etikett im Regal dahinter ist weiter weg als 50 cm. Die Schwelle liegt dazwischen. Sie hängt vom Bildwinkel der Kamera ab und ist an echten Geräten zu bestätigen.
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
- Schriften: die Familie DejaVu (frei lizenziert). `regular` ist `DejaVuSans.ttf`, `bold` ist `DejaVuSans-Bold.ttf`, `mono` ist `DejaVuSansMono-Bold.ttf`. Die drei Dateien liegen im Paket (`print/stowly_print/fonts/`): DejaVu 2.37, unverändert aus `dejavu-fonts-ttf-2.37.tar.bz2` von der Seite des Projekts, samt Lizenztext (`DejaVu-LICENSE.txt`); ein Test hält ihre Prüfsummen fest. Der Renderer sucht jede Datei zuerst dort, dann unter den Schriften des Systems (`/usr/share/fonts/truetype/dejavu/`, Debian-Paket `fonts-dejavu-core`). Das Container-Image und das Installationsskript des Pi installieren dieses Paket zusätzlich, als Rückfall; im Betrieb wird auf dem Pi nichts nachgeladen. Fehlt eine Datei an beiden Stellen, nimmt der Renderer die in Pillow eingebaute Schrift und meldet das im Log, statt zu scheitern. Welche Schrift für `regular`, `bold` und `mono` gilt, nennt der Druckdienst beim Start im Log. Zeichen, die eine Schrift nicht hat, schreibt der Renderer lesbar aus („ü" als „ue", „ß" als „ss"); das betrifft nur die eingebaute Schrift, DejaVu hat sie alle. Die Tests legen die Schriftquelle selbst fest, damit ihre Referenzbilder nicht davon abhängen, welche Schriften auf dem Rechner liegen; die Referenzbilder entstehen mit der eingebauten Schrift, zwei Tests messen die Vorlagen mit den mitgelieferten Dateien nach (ID und Einlagerdatum vollständig, in der Größe der Vorlage).
- Ein Renderer ohne Angabe eines Druckers (Vorschau am Server) rechnet mit der Vorgabe dieser Stufe: 62-mm-Rolle bei 300 dpi, also 696 Pixel druckbare Breite, Länge aus `media.length_mm` der Vorlage (342 Pixel).

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
- **Fortschritt:** Das Gerät, das zustellt, meldet mit `print.report`, was daraus geworden ist: `queued`, sobald der Dienst angenommen hat, und den Endzustand (4.1). Hängt der Drucker am Server, schreibt der Server den Zustand zusätzlich selbst fort (5.8), damit er auch ankommt, wenn das Gerät inzwischen offline ist. Es gilt die jeweils jüngste Meldung, und sie gilt als Ganzes: Sie ersetzt Zustand, `printer_id`, `boot_id` und `error` so, wie sie im Befehl stehen; was sie nicht nennt, ist danach `null` ([`sync-protokoll.md`](sync-protokoll.md), 6.6). Wer meldet, schickt also den Drucker und die `boot_id` jedes Mal mit. Ausnahme: Ein Zwischenstand (`queued`, `printing`) ändert nie ein Etikett, das schon einen Ausgang hat (`printed`, `sent`, `failed`, `unknown`) oder verworfen ist, gleich welchen Zeitpunkt er trägt; das gilt auch für das, was der Server selbst fortschreibt (5.8).
- **Ein neuer Versuch ist ein neues Etikett** mit neuer Kennung (`print.request`). Das alte bleibt, wie es ist. Ein Auftrag druckt nie zweimal.
- **Antwort auf die Nachfrage** bei `unknown`: „Ja" meldet `printed`, „Nein" meldet `failed` mit `error: "not_printed"`; danach bietet die App einen neuen Versuch an.
- **Welcher Drucker:** `PrintJob.printer_id`, sonst der Drucker der Zone (bei Packungen die Zone, in der die Packung jetzt liegt), sonst `HouseholdSettings.default_printer_id`. Ein gelöschter Drucker zählt auf jeder Stufe als nicht gesetzt. Gibt es keinen, bleibt das Etikett `pending`. Entschieden wird bei jedem Zustellversuch neu; als Code: `printerIdForJob` in `web/src/contract/labels.ts`.
- **Ausnahme: Was schon hinausging, bleibt bei seinem Drucker.** Ein Etikett, das das Gerät schon einmal abgeschickt hat (ohne Antwort, 5.4) oder das beim Dienst wartet, geht bei jedem weiteren Versuch an denselben Drucker, auch wenn sich die Zuordnung geändert hat oder er inzwischen gelöscht ist: Nur sein Dienst weiß, ob es gedruckt wurde. Antwortet ein gelöschter Drucker nicht mehr, lässt sich das Etikett verwerfen, auch ein wartendes; druckt es der Dienst später doch, ist das kein doppelter Druck.
- **Drucker löschen** (`printer.delete`) setzt `zones.printer_id` und `default_printer_id`, die auf ihn zeigten, auf `null`, im Server wie in der lokalen Vorwegnahme der App ([`sync-protokoll.md`](sync-protokoll.md), 6.6).
- Ein Etikett bleibt `pending`, solange es nachweislich bei keinem Druckdienst angekommen ist. Es wird später zugestellt (4.1).

### 4.1 Zustellen

**Wer:** Nur das Gerät, das ein Etikett angefordert hat (`device_id`), stellt es zu, an den Drucker am Server genauso wie an den Pi. Nur dieses Gerät weiß, ob es den Auftrag schon einmal abgeschickt hat; deshalb braucht „nie doppelt" keine Absprache zwischen Geräten. Alle anderen Geräte zeigen das Etikett an und können es verwerfen. Will jemand es an einem anderen Gerät drucken, wird das alte verworfen und ein neues angefordert (in der App ein Schritt: „hier drucken"). Die Gerätekennung wechselt mit jeder Anmeldung; Etiketten, die ein Gerät vor einer Sperre angefordert und schon abgeglichen hatte, gehören danach keinem angemeldeten Gerät mehr und bleiben stehen, bis jemand sie verwirft oder übernimmt.

**Wann:** nach dem Anfordern, nach jedem gelungenen Sync, beim Start der App, wenn sie wieder sichtbar wird, und auf Wunsch sofort. Solange eigene Etiketten ausstehen und die App sichtbar ist, versucht sie es von selbst erneut: nach 5, 15 und 60 Sekunden, danach alle 60 Sekunden. An einen Drucker am Server geht ein Etikett erst, wenn seine Anforderung abgeglichen ist (das Etikett also im Server existiert); an den Pi sofort, auch ohne Server. Verlangt der Anwender das Zustellen (`print.flush`) und wartet eine solche Anforderung noch in der Outbox, gleicht die App vorher ab; ebenso vor „Verbindung prüfen“ (`printers.probe`) bei einem Drucker am Server, den der Server noch nicht kennt (angelegt oder geändert, noch nicht abgeglichen).

**Wie**, je Drucker und Versuch:

1. Zustand abfragen (`GET /v1/health`, 5.5) und die `boot_id` merken. Ein Abruf gilt für den ganzen Versuch, nicht je Etikett.
2. Die Etiketten in der Reihenfolge ihrer Anforderung (`created_at`, dann `id`) nacheinander einreichen, nie nebeneinander: So kommen sie in der Reihenfolge der Packungen aus dem Drucker. Fordert die App mehrere Etiketten in einem Schritt an (Einlagern, Nachdruck), tragen sie dasselbe `created_at`; ihre Kennungen vergibt sie deshalb aufsteigend in der Reihenfolge der Packungen.
3. **Vor dem ersten Absenden** hält die App dauerhaft fest (lokale Datenbank, nicht im Sync): Kennung, Drucker, Adresse, die `boot_id` und den **Inhalt** des Auftrags (Vorlage und Daten). Jede Wiederholung schickt genau diesen Inhalt und genau diese `boot_id` wieder, auch wenn sich Produktname oder Vorlage inzwischen geändert haben oder der Dienst neu gestartet ist (5.4). Die Adresse ist nur Auskunft: Eine Wiederholung geht an die Adresse des Druckers, die gerade antwortet und sich ausweist; dass es derselbe Dienst im selben Lauf ist, sichern Nachweis und `boot_id`.
4. Das Ergebnis melden (`print.report`): `queued`, sobald der Dienst angenommen hat, und den Endzustand; jeweils mit `printer_id` (der Drucker, an den es ging) und `boot_id`. `printing` muss nicht eigens gemeldet werden.

Ein Versuch hat zwei Teile. Zuerst werden alle Drucker der Reihe nach bedient: einreichen, was aussteht, und einmal abfragen, was schon beim Dienst ist. Eingereicht wird mit `wait=5`, wenn die App von selbst zustellt (kommt der Endzustand gleich mit, genügt eine Meldung), und mit `wait=0` auf Wunsch des Anwenders: Dann wartet er auf den Bericht (`print.flush` erfüllt sich nach diesem Teil). Danach wird im Hintergrund nachgefragt (`wait=10`, höchstens 60 Sekunden je Drucker); will ein neuer Versuch zustellen, auch der eines anderen Tabs, bricht das Nachfragen ab und der neue fragt selbst wieder nach.

Die Daten des Etiketts entstehen beim ersten Absenden aus dem, was die App dann zeigt (`packageLabelData`, `zoneLabelData`); `show_zone` ist gesetzt, wenn es mehr als eine Zone gibt.

Was die Antwort des Dienstes für das Etikett heißt:

| Antwort | Etikett |
|---|---|
| 201 oder 200 mit `ServiceJob` | Zustand des Auftrags: `queued`/`printing` wird `queued`, ein Endzustand wird übernommen (`failed` mit `error.code`). Solange kein Endzustand da ist, fragt die App nach (`GET /v1/jobs/{id}?wait=10`), höchstens 60 Sekunden je Versuch; danach beim nächsten Versuch. |
| keine Antwort (Zeitüberschreitung, Abbruch) | bleibt, wie es ist. Der nächste Versuch schickt denselben Auftrag wieder (Schritt 3); der Dienst druckt ihn höchstens einmal. |
| 409 `boot_mismatch` | noch nie abgeschickt: mit der neuen `boot_id` einreichen. Schon einmal abgeschickt: `unknown`, die App fragt nach. |
| 409 `job_conflict` | der Dienst kennt die Kennung schon: dessen Zustand übernehmen (`GET /v1/jobs/{id}`) |
| 404 `unknown_printer`, 400 `invalid_request`, 422 `render_failed` | `failed` mit diesem Code |
| 401 `unauthorized` | bleibt `pending`. Am Pi stimmt das Token des Druckers nicht: Die App versucht es an diesem Drucker erst wieder, wenn er geändert wurde oder der Anwender es ausdrücklich verlangt. Am Server ist das Gerät abgemeldet. |
| 503 `queue_full`, 404 `not_found` und 409 `not_pending` (beide nur am Server, 5.8) | bleibt `pending`; die App gleicht ab und versucht es später. Antwortet schon die Abfrage des Zustands am Server mit einem Fehler (503, solange sein Druckdienst nicht läuft), nennt die App den Grund `unavailable`, nicht „Server nicht erreichbar“ |
| Dienst nicht erreichbar | bleibt `pending` |

Zeitgrenzen der App: Zustand 1,5 Sekunden, Einreichen 10 Sekunden, Nachfragen mit `wait=10` 15 Sekunden. Kann die Abfrage des Zustands die Nachfrage des Browsers nach dem lokalen Netzwerk auslösen (Erlaubnis noch offen, 5.6) und kommt der Versuch vom Anwender, bekommt sie bis zu 15 Sekunden, damit er die Nachfrage beantworten kann; alle Adressen eines Druckers zusammen höchstens 20 Sekunden.

**Fehlercodes eines Etiketts** (`PrintJob.error`): die Drucker-Codes aus 5.5 (`no_media`, `media_mismatch`, `cover_open`, `cutter_jam`, `overheated`, `busy`, `offline`, `config`, `unknown`), dazu `unknown_printer`, `invalid_request`, `render_failed`, `cancelled` (am Dienst verworfen), `interrupted` (bei `unknown`: mitten im Druck unterbrochen), `handoff` (bei `unknown`: an die Seite des Druckdienstes übergeben, 5.7) und `not_printed` (der Anwender hat auf die Nachfrage mit Nein geantwortet). Die Oberfläche hat zu jedem einen Satz und zeigt unbekannte Codes unverändert.

**Zustand des Druckers weiterreichen:** Nach jeder gelungenen Abfrage eines direkten Druckers erzeugt die App `printer.report` mit `boot_id`, dem Zustand des angesprochenen Druckers (`status`) und dem des Rechners (`host`), aber höchstens einmal je Minute und Drucker, außer es hat sich etwas geändert (`boot_id`, `reachable`, `ready`, `media_detected`, `errors`) oder der Anwender hat ausdrücklich abgefragt. Für Drucker am Server meldet kein Gerät; der Server schreibt selbst (5.8).

### Drucker (`Printer`) und ihr Zustand (`PrinterStatus`)

| Feld | Bedeutung |
|---|---|
| `id`, `name` | |
| `connection` | `server`: der Server steuert den Drucker. `direct`: das Gerät spricht selbst mit einem Druckdienst. Ändert sich nie. |
| `server` | nur bei `server`: `driver` (`brother_ql`, `image`), `model` (z. B. `QL-820NWB`), `address` (`tcp://192.168.1.60:9100`, `usb://04f9:209b`), `media` (Rollenkennung des Treibers, z. B. `62`). In dieser Stufe ist `media` immer `62` (62-mm-Endlosrolle). `model` ist die Bezeichnung, die der Treiber kennt; die App schlägt `QL-800`, `QL-810W` und `QL-820NWB` vor und lässt freie Eingabe zu. Passen Modell, Adresse oder Rolle nicht zum Treiber, bleibt der Drucker gespeichert und meldet den Fehler `config` (5.5). Beim Bild-Treiber sind `model` und `address` `null`. |
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
| Name des Druckers im Auftrag (`printer`) | die `Printer.id`; ohne Angabe 404 `unknown_printer` | `Printer.direct.printer`, `null` = Standarddrucker des Dienstes (der erste in seiner Liste) |

Das Token kommt entweder als `Authorization: Bearer <token>` oder im JSON-Rumpf als `"token"`, am Server wie am Pi. Der Vergleich läuft in konstanter Zeit. Als schreibend gelten Einreichen, Verwerfen und die Vorschau (`/v1/render`: Rendern kostet Rechenzeit); lesend sind `/v1/health`, `/v1/printers`, `GET /v1/jobs/{id}` und `/v1/jobs/{id}/image`.

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
| `POST /v1/render` | Vorschau: `{ template, data, printer? }` rendern, ohne zu drucken | 200 `image/png` in der Größe des Druckers; ohne `printer` am Pi für den Standarddrucker, am Server für die Vorgabe aus 3.4 |
| `GET /v1/jobs/{id}/image` | das gerenderte Etikett eines Auftrags, nur beim Bild-Treiber | 200 `image/png`; 404 |
| `GET /p` | nur am Pi: Seite, die Aufträge selbst einreicht (5.7) | 200 `text/html` |

`wait` (0 bis 30 Sekunden, Vorgabe 0): Die Antwort wartet so lange auf einen Endzustand, beim Einreichen nach dem Annehmen. Gerendert wird schon beim Einreichen: Was sich nicht rendern lässt, wird nicht angenommen (422).

Die Liste der Drucker (`/v1/printers` und `printers` in `/v1/health`) hat eine feste Reihenfolge; am Pi ist der erste Eintrag der Standarddrucker. Ein Dienst merkt sich jeden Auftrag, den er in diesem Lauf gesehen hat, auch erledigte und verworfene (am Pi mindestens die letzten 10 000, am Server mindestens 90 Tage). Mehr als 100 wartende Aufträge nimmt er nicht an (`queue_full`).

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

Entweder `template` und `data` oder `png`: ein fertiges 1-Bit-PNG in exakt passender Größe, Base64, als Notausgang. `copies` 1 bis 20. Geprüft wird die Nutzlast von `JobRequest.from_dict`; unbekannte Schlüssel übergeht sie. Ein Rumpf über der Grenze (ein PNG-Auftrag samt Base64-Aufschlag) ist `invalid_request`.

Reihenfolge der Prüfungen beim Einreichen; die erste Verletzung bestimmt die Antwort:

1. Ein zu großer Rumpf (`invalid_request`), ohne ihn ganz zu lesen.
2. Anmeldung (`unauthorized`). Ohne gültiges Token erfährt der Aufrufer sonst nichts, auch nicht, dass der Rumpf kein JSON ist.
3. Form: Rumpf, `wait` und Kennung (`invalid_request`).
4. Lauf (`boot_mismatch`), dann die Kennung: schon bekannt mit gleichem Inhalt liefert den vorhandenen Zustand, mit anderem `job_conflict`.
5. Nur am Server: das Etikett (`not_found`, `not_pending`). Ein verworfenes Etikett meldet so `not_pending`, auch wenn sein Drucker inzwischen gelöscht ist.
6. Drucker (`unknown_printer`), Platz in der Warteschlange (`queue_full`), zuletzt das Rendern (`render_failed`).

Antwort (`ServiceJob`): `id`, `state` (`queued`, `printing`, `printed`, `sent`, `failed`, `unknown`), `printer`, `boot_id`, `error` (`{ code, message }` oder `null`), `position` (Platz in der Warteschlange, 0 = als Nächstes; sonst `null`).

Fehler haben denselben Rumpf wie am Server: `{ "error": { "code", "message", "details" } }`.

| HTTP | `code` | Wann |
|---|---|---|
| 400 | `invalid_request` | Nutzlast verletzt den Vertrag |
| 401 | `unauthorized` | Token fehlt oder ist falsch |
| 404 | `not_found` | Auftrag unbekannt; am Server auch: Es gibt kein Etikett mit dieser Kennung |
| 404 | `unknown_printer` | diesen Drucker hat der Dienst nicht |
| 409 | `job_conflict` | dieselbe Kennung mit anderem Inhalt |
| 409 | `boot_mismatch` | `expect_boot_id` passt nicht; `details.boot_id` nennt die aktuelle |
| 409 | `not_cancellable` | der Auftrag wartet nicht mehr |
| 409 | `not_pending` | nur am Server: Das Etikett ist laut Datenbestand verworfen oder schon erledigt |
| 422 | `render_failed` | Vorlage oder Daten lassen sich nicht rendern |
| 503 | `queue_full` | zu viele wartende Aufträge |

### 5.4 Nie doppelt drucken

- **Derselbe Auftrag noch einmal** (gleiche Kennung, gleicher Inhalt): Der Dienst druckt nicht, sondern liefert den vorhandenen Zustand. Der Inhalt ist `printer`, `template`, `data`, `png`, `copies`, `cut` (`JobRequest.content_hash`); `token` und `expect_boot_id` gehören nicht dazu. Gleiche Kennung mit anderem Inhalt: 409 `job_conflict`.
- **Verworfene Aufträge bleiben bekannt** (`failed` / `cancelled`), damit eine verspätete Wiederholung nicht doch noch druckt.
- **Neustart:** Am Server liegt der Auftragsspeicher in einer Datei. Wartende Aufträge laufen nach einem Neustart weiter; ein Auftrag, der beim Absturz gerade druckte, wird `unknown`. Auf dem Pi liegt der Speicher im RAM und stirbt mit dem Strom. Deshalb trägt jede Antwort eine **`boot_id`**: am Pi bei jedem Start neu, am Server dauerhaft dieselbe.
- **`expect_boot_id`:** Die App fragt vor dem Einreichen den Zustand ab (`/v1/health`) und schickt die dabei gesehene `boot_id` mit. Bei einer Wiederholung schickt sie die `boot_id`, die sie beim **ersten** Absenden festgehalten hat, nie eine neuere. Hat der Dienst inzwischen neu gestartet, antwortet er mit 409 `boot_mismatch` und nimmt nichts an.
  - Hatte die App den Auftrag bis dahin **noch nie abgeschickt**, reicht sie ihn mit der neuen `boot_id` ein.
  - Hatte sie ihn **schon einmal abgeschickt** und keine Antwort bekommen, weiß niemand, ob gedruckt wurde: Das Etikett wird `unknown`, die App fragt nach.
- **Abgeschickt ohne Antwort** (Zeitüberschreitung, Verbindungsabbruch): Die App schickt beim nächsten Versuch denselben Auftrag noch einmal, mit derselben Kennung, demselben Inhalt und derselben `expect_boot_id`. Läuft der Dienst noch im selben Lauf, liefert er den vorhandenen Zustand oder nimmt den Auftrag jetzt erst an; beides druckt höchstens einmal, auch wenn die erste Sendung verspätet doch noch ankommt. Läuft er in einem neuen Lauf: `boot_mismatch`, also `unknown`. Dasselbe gilt für ein Etikett, das beim Schließen der App `queued` war: Die App fragt beim nächsten Versuch nach (`GET /v1/jobs/{id}`); antwortet ein neuer Lauf oder kennt der Dienst den Auftrag nicht mehr, ist es `unknown`.
- **Der Inhalt bleibt derselbe:** Weil die App den Inhalt beim ersten Absenden festhält (4.1), führt eine Wiederholung nie zu `job_conflict`, auch wenn das Produkt inzwischen einen Namen bekommen hat.

### 5.5 Erreichbar und echt?

`GET /v1/health?nonce=<n>` mit einer frischen Zufallsfolge (16 bis 64 Zeichen aus `A–Z a–z 0–9 _ -`), Abbruch nach 1,5 Sekunden. Die Antwort enthält

```
proof = hex( HMAC-SHA256( Schlüssel = Token, Nachricht = nonce ) )
```

Die App rechnet nach (WebCrypto). So geht ein fremdes Gerät, das im falschen WLAN zufällig dieselbe Adresse hat, nicht als Drucker durch. Am Server entfällt die Prüfung: Dort bürgt die Verbindung selbst.

`ServiceHealth`: `app` (immer `"stowly-print"`), `version`, `protocol` (derzeit 1), `boot_id`, `uptime_s`, `proof`, `host` (`HostHealth` oder `null`), `printers`.

Was der Rechner ehrlich melden kann (`HostHealth`, jedes Feld darf `null` = unbekannt sein): `uptime_s`, `temperature_c`, `throttled`, `undervoltage` (auf der Pi-Zero-Reihe immer `null`, sie hat keinen Detektor), `storage_errors` und `storage_read_only` (nur Symptome der SD-Karte), `overlay_used_pct`, `memory_available_mb`.

Zustand eines Druckers (`DriverStatus`): `reachable`, `ready`, `media_detected` (jeweils `null` = lässt sich nicht feststellen), `errors` mit diesen Codes: `no_media`, `media_mismatch`, `cover_open`, `cutter_jam`, `overheated`, `busy`, `offline`, `config`, `unknown`. `config` heißt: Der Treiber kann mit den Angaben zum Drucker nichts anfangen (unbekanntes Modell, unlesbare Adresse, unbekannte Rolle, oder die Treiber-Bibliothek fehlt); der Drucker steht dann trotzdem in der Liste, mit `reachable: false`, damit die App den Grund zeigen kann. Ein Auftrag an ihn endet als `failed` mit `config`.

Die App prüft den Nachweis mit WebCrypto und braucht dafür wie für die Erlaubnis aus 5.6 einen sicheren Kontext: Über `http://<LAN-IP>` gibt es keinen Direktdruck, nur den Druck über den Server.

### 5.6 Der Weg vom Handy zum Pi

Die App versucht die Adressen aus `Printer.direct.urls` der Reihe nach. Vorgesehen sind zwei:

1. **HTTPS** mit einem Zertifikat auf die IP-Adresse des Pi, ausgestellt von einer Zertifizierungsstelle, der die Geräte vertrauen. Der robuste Weg für beide Plattformen, auf dem iPhone der einzige.
2. **HTTP** an die private IP-Adresse. Geht nur in Chrome ab 142 (Android und Desktop) über Local Network Access: Die App setzt `targetAddressSpace: "local"`, der Browser fragt einmal je Ursprung um Erlaubnis. Die erste Anfrage muss von einer Seite kommen, nicht vom Service Worker; die Nachfrage kann jederzeit kommen und abgelehnt werden.

Was die App dabei beachtet:

- **Nur von der Seite aus.** Aufrufe an einen direkten Drucker macht nie der Service Worker: Der Browser fragt nur dort um Erlaubnis, wo ein Fenster ist.
- **`targetAddressSpace`** setzt die App bei jeder Anfrage an einen direkten Drucker passend zur Adresse: `"loopback"` für 127.0.0.0/8, `[::1]` und `localhost` (Entwicklung), sonst `"local"`. Browser ohne Local Network Access übergehen die Angabe.
- **Die Nachfrage des Browsers** kann bei jeder Anfrage kommen, auch bei einer selbsttätigen im Hintergrund. Lehnt der Anwender ab, gilt der Drucker als nicht benutzbar (`permission`), bis er die Erlaubnis in den Einstellungen des Browsers erteilt; die App sagt, wo. Wo der Browser es anbietet, liest sie den Stand der Erlaubnis vorab (Permissions API, Namen `local-network` und `loopback-network`, in älteren Versionen `local-network-access`):
  - abgelehnt: Es geht keine Anfrage hinaus (`permission`).
  - noch offen: Eine Anfrage darf nur auf eine Handlung des Anwenders hin hinausgehen (`print.flush`, `printers.probe`), denn sie kann die Nachfrage auslösen; dann bekommt sie mehr Zeit (4.1, Zeitgrenzen). Selbsttätig wartet die App. Kommt die App selbst aus dem lokalen Netzwerk, fragt der Browser nie und meldet trotzdem dauerhaft „noch offen“: Hat eine Anfrage auf Wunsch des Anwenders eine Antwort bekommen und steht die Erlaubnis danach weiter auf „noch offen“, merkt sich das Gerät diesen Adressraum und stellt dort von da an auch selbsttätig zu.
  - erteilt oder keine Auskunft: Die Anfrage läuft.
  - Ändert sich die Erlaubnis (der Anwender antwortet erst, nachdem die auslösende Anfrage aufgegeben hat), stellt die App sofort zu.
- **Fehlt der Ursprung der App in der Konfiguration des Dienstes,** scheitert die Anfrage für die App wie ein Netzfehler. Sie unterscheidet das durch eine zweite Anfrage ohne CORS (`mode: "no-cors"`): Kommt darauf eine Antwort, ist der Dienst da, lässt diese App aber nicht mitlesen (`blocked`).
- Ein Zertifikat, dem der Browser nicht traut, sieht für die App aus wie „nicht erreichbar".

Erreicht die App den Dienst auf keinem Weg, bleibt das Etikett `pending`.

Angesprochen wird der Pi immer über seine IP-Adresse, nie über einen Namen: In seinem WLAN gibt es keine Namensauflösung, auf die Verlass wäre.

### 5.7 Notweg: die Seite des Druckdienstes

Darf der Browser den Pi aus der App heraus nicht ansprechen (iPhone, wenn die installierte App das Zertifikat nicht annimmt), bleibt ein Weg von Hand: Die App öffnet eine Seite, die der Pi selbst ausliefert, und diese Seite reicht die Aufträge bei ihrem eigenen Ursprung ein. Dafür braucht es weder CORS noch eine Erlaubnis.

- Adresse: `<Basis>/p#<Nutzlast>`. Die App nimmt die erste Adresse aus `Printer.direct.urls`, die mit `http://` beginnt, sonst die erste. Die Nutzlast steht im Fragment und erreicht den Dienst nie als Teil der Adresse.
- Nutzlast: UTF-8-JSON, Base64 in der URL-Form (`-` und `_`, ohne `=`):

  ```json
  {
    "v": 1,
    "token": "…",
    "printer": null,
    "template": { "schema": 1, "…": "…" },
    "jobs": [ { "id": "3f2b8c1e-…", "data": { "qr": "STOWLY/P/A2B3C", "…": "…" } } ],
    "back": "https://stowly.home/drucker"
  }
  ```

  Höchstens 20 Aufträge je Aufruf, alle mit derselben Vorlage (Packungs- und Zonen-Etiketten getrennt). `back` ist die Adresse, zu der die Seite einen Verweis „Zurück zu Stowly" zeigt, oder `null`; angenommen werden nur `http:`- und `https:`-Adressen, und die Seite leitet nie von selbst weiter.
- Die Seite ist eine einzelne HTML-Datei ohne fremde Dateien. Sie zeigt, wie viele Etiketten sie drucken wird, wartet auf einen Tipp auf „Drucken", fragt dann den Zustand ab (`/v1/health`) und reicht die Aufträge in ihrer Reihenfolge ein (`POST /v1/jobs/{id}?wait=30`, mit der eben gesehenen `boot_id` als `expect_boot_id`). Zu jedem Etikett zeigt sie das Ergebnis im Klartext.
- Die Kennungen sind die der Etiketten. Ein zweiter Aufruf derselben Adresse druckt deshalb nichts doppelt, solange der Dienst im selben Lauf ist.
- In der App gelten die übergebenen Etiketten danach als `unknown` mit `error: "handoff"`: Sie erfährt den Ausgang nicht und fragt „Wurde das Etikett gedruckt?". Erreicht sie den Dienst später doch und kennt er den Auftrag, übernimmt sie dessen Ausgang (einen Zwischenstand nicht, 4).
- **Übergeben werden nur Etiketten, die die App noch nie abgeschickt hat.** Eines, das schon hinausging und auf eine Antwort wartet (5.4), bleibt `pending` und wird auf dem normalen Weg geklärt: Die Seite reichte es mit der `boot_id` ein, die sie selbst eben gesehen hat, und nach einem Neustart des Pi druckte es womöglich ein zweites Mal. Bleibt so nichts übrig, sagt die App das, statt eine leere Seite zu öffnen.

### 5.8 Der Druckdienst im Server

Der Server bindet denselben Dienst unter `/print` ein (`/print/v1/health` und so weiter). Was dort anders ist als am Pi:

- **Anmeldung:** Jeder Aufruf braucht das Geräte-Token (`Authorization: Bearer`), auch die lesenden. Fehler kommen im Format des Servers; 401 behandelt die App wie überall (das Gerät ist abgemeldet). CORS-Kopfzeilen und die Seite `/p` gibt es dort nicht.
- **Drucker:** alle nicht gelöschten `Printer` mit `connection = "server"`, unter ihrer `Printer.id` als Name. Ändert ein Sync-Befehl einen Drucker, gilt das für den nächsten Auftrag und die nächste Abfrage. Der Dienst hat keinen Standarddrucker.
- **Nur bekannte Etiketten:** Ein Auftrag wird nur angenommen, wenn es ein Etikett (`PrintJob`) mit dieser Kennung gibt und es `pending` ist. Sonst 404 `not_found` (die Anforderung ist noch nicht abgeglichen) oder 409 `not_pending` (verworfen oder erledigt). Ein Auftrag, den der Dienst schon kennt, liefert wie immer seinen Zustand.
- **Zustand fortschreiben:** Mit dem Annehmen und bei jedem Wechsel schreibt der Server Zustand, `printer_id`, `boot_id` und `error` des Etiketts selbst (Regel in [`sync-protokoll.md`](sync-protokoll.md), 6.6), damit er auch ankommt, wenn das Gerät inzwischen offline ist. Das Gerät meldet trotzdem; beide Meldungen sagen dasselbe. Ein am Dienst verworfener Auftrag (`failed` mit `cancelled`) wird für das Etikett `cancelled` ohne Fehler, so wie es das Gerät meldet; ein unterbrochener `unknown` mit `interrupted`. Ein Zwischenstand ändert kein Etikett, das schon einen Ausgang hat (4).
- **Läuft der Druckdienst im Server nicht** (er ließ sich beim Start nicht einrichten, etwa weil sein Verzeichnis nicht beschreibbar ist), antwortet jeder Aufruf unter `/print` mit 503 `queue_full` und dem Grund im Klartext; der Rest des Servers läuft weiter. Die App lässt die Etiketten ausstehen und nennt den Grund `unavailable`.
- **Zustand der Drucker:** Der Server schreibt `PrinterStatus` seiner Drucker selbst: nach jedem Auftrag und bei jeder Abfrage durch eine App, höchstens einmal je Minute und Drucker, außer es hat sich etwas geändert. `host` ist `null`.
- **Auftragsspeicher und `boot_id`** liegen in einer Datei im Datenverzeichnis und überleben den Neustart: Wartende Aufträge laufen weiter, einer, der beim Absturz gerade druckte, wird `unknown` (5.4).
- **Bild-Treiber:** schreibt je Auftrag ein PNG ins Datenverzeichnis; `GET /print/v1/jobs/{id}/image` liefert es. So lässt sich der ganze Weg ohne Drucker ansehen.

## 6. Treiber-Schnittstelle

Ein Treiber ist eine Druckersprache auf einem Transport (`print/stowly_print/drivers/base.py`):

```python
class Driver(Protocol):
    def capabilities(self) -> Capabilities: ...   # dpi, media, cutter, colors, status_query, confirms_print
    def status(self) -> DriverStatus: ...          # reachable, ready, media_detected, errors
    def print(self, image, cut=True) -> PrintOutcome: ...   # "printed" | "sent" | "failed"
```

- `capabilities()` spricht das Gerät nicht an: Der Renderer braucht die Werte auch, wenn der Drucker aus ist.
- `status()` wirft nicht; ein nicht erreichbares Gerät ist `reachable=False`. Kann der Treiber mit seiner Konfiguration nichts anfangen, meldet er `config` (5.5).
- `print()` bekommt ein 1-Bit-Bild in exakt passender Größe und blockiert, bis das Ergebnis feststeht. `printed` nur, wenn das Gerät bestätigt hat (Brother über USB); `sent`, wenn der Transport nur schreiben kann (Brother über TCP 9100); `failed`, wenn sicher nichts gedruckt wurde. Bricht der Vorgang mittendrin ab und ist der Ausgang offen, wirft die Methode: Der Auftrag wird `unknown`.
- Vorgesehene Treiber: `brother_ql` (über `brother_ql_next`, fest gepinnt und nur in diesem Modul importiert), `image` (schreibt PNG), später `zpl`.

Das Paket `stowly_print` darf weder FastAPI noch pydantic voraussetzen und muss unter Python 3.12 und 3.13 laufen: Auf dem Pi gibt es `pydantic-core` nicht als fertiges Paket. Der Dienst baut auf Starlette und uvicorn aus den Systempaketen von Raspberry Pi OS (Starlette 0.46); der Server bringt über FastAPI eine neuere Starlette mit. Verwendet werden darf nur, was es in beiden gibt.
