# Stowly – Plan: Version 0.5.0

## Kontext

0.4.0 läuft bei dir: Container per Mausklick auf dem NAS, Pi mit Brother QL-570 und 62-mm-Endlosrolle, Home Assistant und Bring! in der App. Drei Wünsche sind offen.

- **Etiketten:**
  - Inhalt und Papier stehen fest in zwei Vorlagen im Druckdienst (`print/stowly_print/templates/package-62x29.json`, `zone-62x29.json`).
  - Der Server übernimmt sie beim Start (`server/stowly/label_templates.py`) und verteilt sie über den Sync. Die App reicht sie undurchsichtig an den Druckdienst.
  - Der Brother-Treiber kennt nur die Endlosrolle aus seiner Konfiguration (`media = "62"`); gestanzte Etiketten lehnt er ab. Der Zonenname steckt schon in den Druckdaten, gedruckt wird er nie.
- **Produktdaten:**
  - Open Food Facts wird je Barcode genau einmal gefragt. Das Ergebnis bleibt für immer gespeichert, „nicht gefunden" ist endgültig.
  - Der Server füllt nur leere Felder. Ein offline angelegtes Produkt mit getipptem Namen behält diesen Namen.
  - Ein Bild kann die App gar nicht setzen.
- **Druckerkarte:**
  - Ist der Drucker aus, zeigt die Karte nach „Verbindung prüfen" grün „Der Druckdienst antwortet." neben rot „nicht verbunden".
  - Das grüne Urteil prüft nur den Dienst, nicht den Drucker. Der Rat steht klein in der Fehlerliste.
  - Beim Koppeln des Pi (Dialog und Assistent) ist es genauso.

**Ziel:**
- Etiketten in der App gestalten, mit Vorschau und Wahl des Papiers.
- Produktdaten auf Knopfdruck neu holen und vor dem Übernehmen vergleichen.
- Eine Druckerkarte, die sich nicht widerspricht und sagt, was zu tun ist.

## Deine Entscheidungen

- **Editor:** ein Formular mit Vorschau. Felder an- und abschalten und ordnen, Schriftgröße je Feld, Seite und Größe des QR-Codes, Länge des Etiketts. Die Anordnung übernimmt Stowly.
- **Geltung:** für den ganzen Haushalt. Je eine Gestaltung für Packungs- und Zonen-Etiketten, ein Papier für alle Drucker.
- **Papier:**
  - die 62-mm-Endlosrolle mit wählbarer Länge;
  - die schmaleren Endlosrollen, quer bedruckt;
  - gestanzte Etiketten.
- **Neue Felder:** Zone, eigener Text, Marke und Größe getrennt, kurzes Datum. Der QR-Code bleibt immer drauf.
- **Produktdaten:**
  - Gegenüberstellung je Feld; „Übernehmen" trägt die angehakten Werte ins Formular, gespeichert wird mit „Speichern".
  - Das Produktbild gehört dazu.

## So sieht es für dich aus

**Drucker → „Etiketten gestalten"** (neue Seite)
- **Papier für alle Drucker:** „62 mm endlos", „29 mm endlos", …, „62 × 29 mm gestanzt", …
- **Zwei Reiter, „Packung" und „Zone",** je mit:
  - Länge, nur bei Endlosrollen (25 bis 100 mm);
  - QR-Code links oder rechts, klein, mittel oder groß. Die kleinste Stufe scannt noch sicher.
  - Felder als Liste:
    - an und aus, mit Pfeilen nach oben und unten (kein Ziehen, das geht am Handy schlecht);
    - je Feld klein, mittel oder groß; beim Namen dazu 1 bis 3 Zeilen;
  - Datum lang (25.03.2027) oder kurz (25.03.27), eigener Text, Trennlinie an oder aus.
- **Vorschau** daneben, am Handy darüber: das echte Etikett, wie der Druckdienst es rendert. Als Inhalt eine Packung aus dem Bestand oder ein Beispiel mit langem Namen. Passt etwas nur verkleinert oder gekürzt, steht es darunter.
- **Knöpfe:** „Speichern", „Verwerfen", „Auf Vorgabe zurücksetzen".
  - Nach dem Speichern bekommen alle Geräte die neue Vorlage. Was schon unterwegs ist, bleibt, wie es war.
- **„Probedruck":** fordert für die gezeigte Packung oder Zone ein Etikett an, wie „Nachdrucken" im Bestand. Er geht erst, wenn alles gespeichert ist; beim Beispiel ohne echte Packung gibt es ihn nicht.
- **Hinweis je Drucker,** wenn das Papier nicht passt, etwa:
  - „Keller (Pi): Der Druckdienst 0.4.0 kann nur 62 mm endlos. Neu koppeln aktualisiert ihn."
  - „Eingelegt ist 62 mm endlos."
- **Ohne Server** bleibt die Seite lesbar. Vorschau und Speichern brauchen ihn.

**Produkt bearbeiten → „Online abfragen"** (oben im Dialog)
- **Abfrage:** Open Food Facts wird jetzt neu gefragt, auch wenn der Barcode früher unbekannt war.
- **Gegenüberstellung** je Feld, „jetzt" und „Open Food Facts": Name, Marke, Packungsgröße, Bild.
  - Abweichende Felder sind vorgehakt.
  - Leere Werte von Open Food Facts werden nie angeboten; nichts wird so gelöscht.
- **Knöpfe:**
  - „Übernehmen" trägt die Haken ins Formular;
  - „Speichern" speichert wie bisher, das Bild gleich mit;
  - „Abbrechen" verwirft alles.
- **Mehrere Barcodes:** eine Auswahl, welcher gefragt wird.
- **Kein Knopf** bei Produkten ohne Barcode oder nur mit ladeninternen Codes (Präfix 2). Offline ist er gesperrt, mit Grund.

**Druckerkarte**
- **Grün** nur noch, wenn Dienst **und** Drucker bereit sind: „Drucker bereit."
- **Dienst ja, Drucker nein:** gelb „Der Pi antwortet, der Drucker nicht." Darunter als Liste:
  - Drucker einschalten;
  - USB-Kabel an Drucker und Pi prüfen;
  - dann noch einmal „Verbindung prüfen".
- **Andere Fehler** (keine Etiketten, Klappe offen, falsche Rolle) genauso, je mit Rat.
- **Ohne neues Prüfen:** Zeigt der zuletzt gesehene Zustand ein Problem, steht der Rat sichtbar in der Karte, nicht klein in einer Liste.
- **Nach dem Prüfen** steht die eingelegte Rolle in der Karte, etwa „Rolle: 62 mm endlos".
- **Pi koppeln:** Im Dialog und im Assistenten gilt dasselbe.

## 1. Etiketten-Editor

**Gestaltung am Server, Vorlage daraus erzeugt**
- **Speicher:** `LabelDesign { paper, package, zone, updated_at }` in einer neuen Tabelle `label_design` (Migration `0006_label_design.sql`, eine Zeile). Sie gehört nur dem Server, nicht dem Sync, und steht in jeder Sicherung.
- **`LabelLayout` je Etikettenart:**
  - `length_mm`, nur bei Endlosrollen;
  - `qr { side: left|right, size: s|m|l }`;
  - `fields`: Liste `{ field, size: s|m|l, lines? }`, in Reihenfolge;
  - `date: long|short`, `text` (höchstens 40 Zeichen), `divider`.
- **Felder:**
  - Packung: `title`, `subtitle` (Größe · Marke), `quantity`, `brand`, `best_before` („MHD …"), `stored`, `id`, `zone`, `text`.
  - Zone: `title`, `subtitle` („Lagerzone"), `text`.
  - Stehen Packungs-ID und Einlagerdatum direkt nacheinander, teilen sie sich wie heute die unterste Zeile.
- **Generator** `server/stowly/labels.py`: `build_template(kind, paper, layout) -> dict`, deterministisch, ohne Brother-Bibliothek.
  - Der QR-Code steht als Quadrat an der gewählten Seite, die Felder untereinander daneben.
  - Größen sind feste Millimeter, auf jedem Papier dieselben.
  - Wird es eng, verkleinert der Renderer bis `min_size` und kürzt zuletzt mit „…", wie heute.
- **Prüfung beim Speichern:** Der Server rendert jede Vorlage mit Beispiel- und Grenzdaten, also langem Namen und allen Feldern voll (`render_with_report`).
  - Scheitert das, antwortet er 422 mit einem Satz, etwa: „Für so viele Felder ist das Etikett zu kurz: ein Feld weglassen, kleiner wählen oder länger machen."
  - Gründe sind ein QR-Code unter 6 Pixeln je Modul oder ein Feld, in das keine Zeile passt.
- **Ohne eigene Gestaltung** bleiben die mitgelieferten Vorlagen wie heute, mit demselben `hash`. Wer den Editor nie öffnet, merkt nichts.
- **Beim Start** erzeugt `label_templates.install()` die Vorlagen aus der Gestaltung, sonst nimmt es die mitgelieferten. Ändert sich der `hash`, bekommen alle Geräte die Vorlage über den Sync, wie bisher.

**Papier** (Katalog `print/stowly_print/media.py`)
- **Daten:** eigene Daten nach der Tabelle von brother_ql_next, denn der Server hat die Bibliothek nicht. Ein Test vergleicht den Katalog mit der Bibliothek, wo sie installiert ist.
- **Endlos:** 12, 18, 29, 38, 50, 54 und 62 mm.
- **Gestanzt** bis 62 mm Breite, einfarbig und rechteckig, unter anderem 17×54, 17×87, 23×23, 29×42, 29×90, 38×90, 39×48, 52×29, 54×29, 62×29 und 62×100.
- **Je Papier:** Art, Breite, bei gestanzten die Länge, dazu die druckbaren Punkte bei 300 dpi. Bei gestanzten ist die druckbare Länge kürzer als das Etikett (62×29: 271 statt 342 Punkte).
- **Das Etikett liegt immer quer.** Ist es länger, als die Rolle breit ist, dreht der Renderer das Bild um 90°. Das betrifft etwa 29 mm endlos, 29×90, 62×100 und 62 mm endlos ab 62 mm Länge.

**Vorlage, Format 2** (`docs/etiketten.md` 3.4)
- **`media`:** Jede erzeugte Vorlage nennt ihr Papier, `media { id, kind, width_mm, length_mm }`.
- **Format 1 bleibt** für 62 mm endlos ohne Drehung. Das kann auch der Druckdienst 0.4.0; er übergeht `id`.
- **Format 2** (`schema: 2`, mit `rotate: 0|90`) für jedes andere Papier und jede Drehung. Ein alter Druckdienst lehnt es mit `render_failed` ab, statt falsch zu drucken.
- **Neue Datenfelder** in `PackageLabelData` (`contract/labels.py`, `web/src/contract/labels.ts`):
  - `brand`, `quantity`, `best_before_short`, `stored_short`;
  - `zone` steht jetzt immer drin, nicht nur bei mehr als einer Zone.

  Ein Druckdienst 0.4.0 nimmt unbekannte Schlüssel an.
- **Die App liest aus der Vorlage nur `schema` und `media.id`.** Alles andere reicht sie weiter wie bisher.

**Druckdienst** (Pi und Server)
- **Papier je Auftrag:** Nennt die Vorlage ein Papier, druckt der Brother-Treiber genau dafür, auch gestanzt.
  - `media` in der Konfiguration ist nur noch die Vorgabe für Vorlagen ohne Papier.
  - Kann das Modell das Papier nicht, endet der Auftrag als `failed` mit `media_mismatch` und einem Satz.
- **Eingelegte Rolle:** Der QL-570 meldet über USB Breite und Art der Rolle.
  - Vor jedem Druck vergleicht der Treiber sie mit dem Papier des Auftrags.
  - Passt es nicht: `media_mismatch`, etwa „Eingelegt: 62 mm endlos; das Etikett braucht 29 × 90 mm gestanzt". Es geht nichts an den Drucker.
- **Zustand:**
  - `GET /v1/health?…&media=<Papier>` vergleicht die Rolle mit dem Papier des Haushalts statt mit der Konfiguration. `ServicePrinter.loaded` (in Python `PrinterInfo`) nennt die eingelegte Rolle.
  - `ServiceHealth.template_schemas` (in Python `Health`) nennt die Formate, die der Dienst kann (`[1, 2]`); fehlt es, gilt `[1]`.
  - Alles kommt nur hinzu: Protokoll 1 des Druckdienstes bleibt. Der synchronisierte `PrinterStatus` ändert sich nicht.
- **Bild-Treiber und `/v1/render`:** rendern in der Größe des Papiers aus der Vorlage. So stimmen auch die Vorschauen im Bestand und bei den Zonen.

**In der App beim Drucken**
- `labelData` (`web/src/core/print/content.ts`) füllt die neuen Felder. Die Vorlage wird gewählt wie bisher.
- **Zu alter Druckdienst:** Kennt der Dienst das Format der Vorlage nicht (`template_schemas`), stellt die App das Etikett nicht zu.
  - Es bleibt ausstehend, mit dem neuen Grund `outdated`: „Der Druckdienst auf dem Pi ist zu alt für dieses Papier. Neu koppeln aktualisiert ihn."
  - Der Notweg über die Seite des Pi reicht die Vorlage weiter wie bisher; ein alter Dienst lehnt sie dort sichtbar ab.

**Endpunkte** (`server/stowly/api/labels.py`, nur angemeldet)
- **`GET /api/labels/design`:** Papier, beide Gestaltungen, ob es die Vorgabe ist, dazu der Papier-Katalog. Er kommt vom Server, nicht aus `api.gen.ts`; das schont das Bündel.
- **`POST /api/labels/preview {kind, paper, layout, data}`:** PNG als Base64 mit Größe und Hinweisen („Name auf 3,0 mm verkleinert und gekürzt").
  - Gezeigt wird das Etikett so, wie man es liest, ungedreht.
  - Höchstens zwei Vorschauen zugleich; die App wartet 300 ms nach der letzten Änderung.
- **`PUT /api/labels/design`:** Papier und beide Gestaltungen zusammen. Bei einem Fehler 422 mit Satz.
- **`DELETE /api/labels/design`:** zurück zur Vorgabe.
- **Ereignis:** `labels.changed`.

## 2. Produktdaten nachträglich abfragen

**Server**
- **`POST /api/lookup/{barcode}/refresh?wait=`** (neu, angemeldet): fragt Open Food Facts jetzt, auch wenn schon ein Ergebnis gespeichert ist, auch nach `not_found`.
  - **Vorrang:** vor allen Abfragen im Hintergrund. Die Grenze von 10 Abfragen je Minute und die Pause nach 429 gelten weiter.
  - **Je Barcode** höchstens einmal je Minute; sonst kommt das gespeicherte Ergebnis.
  - **Ein Fund** ersetzt das gespeicherte Ergebnis, auch für künftige Scans. Das Bild lädt und speichert der Server wie bisher; `image_id` steht in der Antwort.
  - **Ein Fehlschlag** (Netz, 5xx) ändert nichts am gespeicherten Ergebnis. `not_found` überschreibt kein gefundenes, wird aber gemeldet.
  - **Kein Produkt ändert sich,** auch nicht sein Stand `lookup`. Antwort: `LookupResult` mit `fetched_at`.
- **`PUT /api/products/{id}/image {image_id}`** (neu): setzt das Bild eines Produkts auf ein Bild, das Stowly gespeichert hat; `null` entfernt es.
  - Fehler: 404 ohne Produkt, 422 ohne Bild.
  - Das Produkt bekommt einen neuen `rev`, also sehen alle Geräte das Bild.
  - Ereignis: `product.image`.
- **Beide liegen außerhalb des Sync:** Protokoll 2 bleibt, und `product.update` ändert sich nicht.

**App**
- **Knopf:** „Online abfragen" im Kopf des Formulars von `ProductDialog`.
- **Gegenüberstellung:** `LookupCompare` als nachgeladener Teil. Dazu die reine Funktion `compareLookup(form, result)` mit Tests.
- **„Übernehmen"** setzt Name, Marke und Größe im Formular und merkt das Bild vor.
- **„Speichern":**
  - schickt `products.update` wie bisher und danach das Bild;
  - scheitert nur das Bild (offline), sagt der Dialog es, und die Felder sind trotzdem gespeichert.
- **Quelle:** „Daten von Open Food Facts (ODbL)", wie beim Scannen.
- **Hinweis bei Platzhaltern mit `not_found`:** „Open Food Facts kannte diesen Barcode beim Nachschlagen nicht. „Online abfragen" fragt noch einmal."

## 3. Druckerkarte

- **Urteil aus Dienst und Drucker:** `probeVerdict()` in `web/src/features/printers/model.ts`, aus `PrinterProbe` und dem Zustand des Druckers in `health.printers`. Drei Ergebnisse:
  - bereit (grün);
  - Dienst ja, Drucker nein (gelb);
  - Problem mit dem Dienst (wie bisher).
- **Rat je Fehler** (`PRINTER_ERROR_ADVICE`):
  - `offline` je nach Anschluss:
    - USB am Pi;
    - USB am Server, mit dem Hinweis, dass Docker einen frisch eingeschalteten Drucker manchmal erst nach einem Neustart von Stowly sieht;
    - Netzwerk.
  - Dazu `no_media`, `cover_open`, `cutter_jam`, `overheated`;
  - und `media_mismatch` mit eingelegter Rolle und Papier des Haushalts. Das ersetzt den festen Satz „Erwartet wird die 62-mm-Endlosrolle."
- **Wo:**
  - `PrinterCard` und `PairPi` (und damit der Assistent) nutzen dasselbe Urteil.
  - Unter „Zuletzt gesehen" wird aus der Fehlerliste ein Hinweis mit Rat.
  - Das rote Abzeichen „nicht verbunden" bleibt; jetzt passt der Hinweis dazu.
- **Alter Druckdienst:** Braucht das Papier Format 2 und ist der Dienst älter, steht in der Karte „Druckdienst 0.4.0 kann dieses Papier nicht", mit „Neu koppeln".
  - Version und Modell eines Pi kennt der Server vom Koppeln. `PairedPrinter` in `SetupStatus` bekommt dafür `version` und `model`, so sieht die App es ohne Abfrage.
  - Nach „Verbindung prüfen" gilt die frische Angabe.

## 4. Die App

- **Seite** `features/labels`: nachgeladen, Route `/drucker/etiketten`. Auf der Seite „Drucker" kommt ein Abschnitt „Etiketten" dazu, mit Papier und „Etiketten gestalten".
- **Kern:**
  - `core.labels` (`design`, `preview`, `save`, `reset`) sowie `products.refreshLookup` und `products.setImage` liegen in einem nachgeladenen `core/labels.ts`. Muster: `later()` in `core/index.ts`.
  - Im Kern selbst nur das Nötigste: die neuen Datenfelder und der Grund `outdated`.
- **Bündel:** `index-*.js` hat etwa 1,1 kB Reserve (488,9 von 490 kB). Gemessen wird nach dem Bau. Reicht es nicht, wandert Text des Druckens in einen nachgeladenen Teil.
- **Attrappe und Fake-Server:**
  - Neue Szenarien: `labels-custom`, `labels-die-cut`, `printer-off` (Dienst antwortet, Drucker aus), `pi-outdated`, `lookup-refresh`.
  - Der Fake-Server und `fake-print.ts` nehmen Format 2 an, melden `template_schemas` und liefern für die Vorschau ein festes PNG in der Größe des Papiers.

## 5. Doku und Version

- **Version 0.5.0.** Im CHANGELOG unter „Von Hand":
  - Für andere Papiere als 62 mm endlos den Pi einmal neu koppeln: Drucker → „Raspberry Pi koppeln" → „Vorhandenen Drucker übernehmen". Das spielt den neuen Druckdienst ein; Token und Drucker bleiben.
  - Mit der 62-mm-Rolle und bis 62 mm Länge druckt auch der alte Druckdienst die neuen Etiketten.
- **`docs/etiketten.md`:**
  - 3.1 Papier, 3.2 Gestaltung, 3.3 neue Felder, 3.4 Format 2 mit `media` und `rotate`;
  - 4.1 `outdated`;
  - 5.3 und 5.5 `media`, `loaded`, `template_schemas`;
  - 6 Treiber; Zeile „media immer 62" ersetzen.
- **`docs/sync-protokoll.md`:**
  - 10 (Neuabruf statt „nie erneut");
  - 11, neue Abschnitte für Gestaltung und Produktbild;
  - 12 Ereignisse.
- **`docs/betrieb.md`:** neue Tabelle O (0.5.0).
- **`pi/README.md`:** `media` ist nur noch die Vorgabe; dazu Prüfliste W.
- **`docs/pruefliste.md`:** Abschnitt W (0.5.0), Punkte ab 72; Zeile 5 auf „A bis O" anpassen.
- **Plan:** kommt als `docs/plan-0.5.md` ins Repository.

## Umsetzung

Wie bisher: Opus mit maximalem Aufwand; die Agents committen nicht.

**Runde 0, ich**
- **Vertrag:**
  - `LabelDesign`, `LabelLayout`, Papier-Katalog als Antwortmodell;
  - Endpunkte, LIMITS (Länge, Text), `LookupResult.fetched_at`;
  - `PackageLabelData` neu, `ServiceHealth.template_schemas`, `ServicePrinter.loaded`, `PairedPrinter.version` und `.model`;
  - Ereignisse, `PrinterProblem` `outdated`.
- **Katalog** `stowly_print/media.py` (nur Daten), Migration `0006_label_design.sql`.
- **Export und `test_contract`** (Liste der Endpunkte), dazu die Grundlage der Doku.

**Runde 1, parallel**
- **Worker Druckdienst** (`print/`):
  - `model.py` (`Media` mit druckbarer Länge), `render.py` (Format 2, Fläche aus dem Papier, Drehung);
  - `drivers/base.py`, `brother_ql.py` (Papier je Auftrag, gestanzt, eingelegte Rolle, Abgleich), `image.py`;
  - `service.py`, `http.py`, `health.py` (`media`, `loaded`, `template_schemas`);
  - Tests: Referenzbilder für 29 mm gedreht, 62×29 und 29×90 gestanzt; Rasterdaten gegen die Bibliothek; ein Katalog-Test.
- **Worker Server:**
  - `labels.py` (Generator, Prüfung), `label_templates.py` (aus der Gestaltung), `api/labels.py`;
  - `off.py` und `api/lookup.py` (Neuabruf), `api/products.py` (Bild), Ereignisse;
  - Tests: `test_labels.py`, `test_labels_api.py`, `test_lookup_refresh.py`, `test_product_image.py` und Anpassungen.
- **Worker Oberfläche:**
  - Editor-Seite, Abschnitt auf „Drucker", Druckerkarte und `PairPi`;
  - `ProductDialog` mit `LookupCompare`;
  - `core/labels.ts`, `content.ts`, `engine.ts` (`outdated`);
  - Attrappe, Fake-Server, vitest;
  - e2e: `labels.e2e.test.ts` (Gestaltung speichern → Sync → Druck am echten Druckdienst mit Bild-Treiber, je Papier die Größe des PNG; alter Dienst → `outdated`), Neuabruf in `lookup.e2e.test.ts`.
- **Ich:** Doku und Abstimmung zwischen den Workern.

**Runde 2, ich**
- Zusammenführen, alle Prüfungen, Bündel messen.
- **Unabhängige Prüfung:**
  - Vorschau-Endpunkt (Rechenlast, Grenzen der Eingaben);
  - Bild-Endpunkt (nur eigene Bilder);
  - Neuabruf (Grenzen; keine fremden Adressen, die Adresse von OFF ist fest);
  - Funde beheben.
- Lokaler Commit.

**Runde 3, mit dir**
1. **Vorabversion und Testcontainer:** `v0.5.0-rc.1`, Testcontainer per Mausklick, ein Drucker am Server mit Bild-Treiber.
   - Editor mit jedem Papier: Vorschau und gedrucktes PNG vergleichen, auch gedreht und gestanzt.
   - „Online abfragen" an einem gescannten Produkt.
2. **`v0.5.0` für dein Stowly, per Knopf:**
   - Etikett gestalten (62 mm endlos, andere Länge), Probedruck am QL-570, noch mit Druckdienst 0.4.0.
   - Pi neu koppeln („Vorhandenen Drucker übernehmen", sudo-Passwort tippst du), dann prüfen: „Rolle: 62 mm endlos".
   - QL-570 ausschalten: gelber Hinweis mit Rat. Einschalten: grün.
   - „Online abfragen" an einem offline angelegten Produkt, mit Bild.
3. **Aufräumen:** Testcontainer weg.

Schmale Rollen und gestanzte Etiketten bleiben am Gerät offen, bis du so eine Rolle hast; sie stehen in der Prüfliste.

## Wichtige Dateien

**Neu**
- **Server:** `server/stowly/labels.py`, `api/labels.py`, `api/products.py`, `migrations/0006_label_design.sql`.
- **Druckdienst:** `print/stowly_print/media.py`.
- **Web:** `web/src/features/labels/*`, `features/stock/LookupCompare.tsx`, `core/labels.ts`, `e2e/labels.e2e.test.ts`.

**Geändert**
- **Server:** `label_templates.py`, `off.py`, `api/lookup.py`, `app.py`, `contract/api.py`, `contract/labels.py`, `contract/limits.py`, `events.py`, `tests/test_contract.py`.
- **Druckdienst:** `model.py`, `render.py`, `service.py`, `http.py`, `health.py`, `drivers/base.py`, `drivers/brother_ql.py`, `drivers/image.py`, `templates/__init__.py`.
- **Web:**
  - `contract/labels.ts`, `contract/core.ts`, `contract/routes.ts`;
  - `core/index.ts`, `core/print/content.ts`, `engine.ts`, `texts.ts`;
  - `features/printers/model.ts`, `PrinterCard.tsx`, `PairPi.tsx`, `index.tsx`;
  - `features/stock/ProductDialog.tsx`, `app/pages.tsx`, `app/routes.tsx`;
  - `mock/core.ts`, `mock/preview.ts`, `core/testing/fake-server.ts`, `fake-print.ts`.
- **Doku:** `docs/etiketten.md`, `sync-protokoll.md`, `betrieb.md`, `pruefliste.md`, `pi/README.md`, `CHANGELOG.md`.

**Wiederverwendet**
- **Druckdienst:** `render_with_report` als Prüfung, `template_hash` und `canonical_json`.
- **Vorlagen:** `label_templates.install()` als Ort der Erzeugung beim Start.
- **App:**
  - `LabelImage.tsx` für die Vorschau (lädt nach, wenn der Server zurück ist);
  - `core.print.requestPackageLabels` und `requestZoneLabel` als Probedruck;
  - `later()` und `lazyPage`; `Notice` und `problemText`.
- **Open Food Facts:** aus `off.py` die Warteschlange, die Bremse, das Laden und Prüfen der Bilder und `_stored_image`.
- **Pi:** „Vorhandenen Drucker übernehmen" aus `PairPi` als Weg, den Druckdienst zu aktualisieren.

## Verifikation

**pytest Druckdienst**
- **Renderer:** Format 2, Fläche aus dem Papier, Drehung, druckbare Länge gestanzter Etiketten. Die mitgelieferten Vorlagen bleiben bitgleich (Referenzbilder).
- **Treiber:**
  - Rasterdaten für 62×29 gestanzt und 29 mm endlos gegen die der Bibliothek;
  - eingelegte Rolle gegen Papier des Auftrags;
  - Vorgabe aus der Konfiguration für Vorlagen ohne Papier.
- **Zustand:** `media`, `loaded`, `template_schemas`.

**pytest Server**
- **Generator:**
  - Die Vorgabe sieht aus wie heute (Referenzbild).
  - Jedes Papier rendert, Grenzfälle lehnen mit Satz ab, und das Ergebnis ist deterministisch (gleicher `hash`).
- **Endpunkte:**
  - Vorschau, Speichern, 422, Zurücksetzen;
  - neuer `rev` und Auslieferung im Sync;
  - `install()` beim Start mit und ohne Gestaltung;
  - Zurückspielen einer Sicherung von 0.4.0.
- **Neuabruf:**
  - umgeht den Speicher; aus `not_found` wird `found`;
  - ein Fehlschlag ändert nichts;
  - `not_found` überschreibt keinen Fund;
  - Grenzen je Barcode und je Minute;
  - das Bild wird geladen; kein Produkt ändert sich.
- **Produktbild:** nur gespeicherte Bilder, neuer `rev`, Ereignis.
- **Vertrag:** `test_contract`.

**Web und Werkzeuge**
- **vitest:**
  - Editor: Formular, Reihenfolge, entprellte Vorschau, 422-Satz, offline;
  - Druckerkarte: alle Urteile, Rat je Fehler, `PairPi` und Assistent;
  - `ProductDialog`: Zustände des Knopfs, Gegenüberstellung, Übernehmen, Speichern mit Bild, offline;
  - `labelData` mit den neuen Feldern; `outdated` im Kern.
- **Dazu:** Typecheck, ruff, Vertragsprüfung und Bündelgröße.

**e2e**
- Gestaltung speichern, abgleichen, drucken: echter Druckdienst mit Bild-Treiber, je Papier die richtige Größe, gedreht wo nötig.
- Alter Druckdienst (nur Format 1): Das Etikett bleibt mit `outdated` ausstehend.
- Neuabruf mit nachgebildetem Open Food Facts: erst unbekannt, dann gefunden; Name übernehmen, Bild setzen.

**Im Browser:**
- Attrappe mit den neuen Szenarien;
- echter Server mit Bild-Drucker: Editor, Vorschau, Probedruck, Druckerkarte.

**Am NAS, Pi und iPhone:** siehe Runde 3.

## Risiken

- **Ungeprüfte Rollen:** Schmale und gestanzte Rollen lassen sich am Gerät erst prüfen, wenn du so eine Rolle hast. Bis dahin sichern das die Rasterdaten der Bibliothek und der Bild-Treiber ab. Ungeprüft ist auch, was der QL-570 bei gestanzten Rollen als Länge meldet.
- **Pi-Update:** Für andere Papiere braucht der Pi den neuen Druckdienst. Vergisst man das Neukoppeln, bleiben Etiketten mit `outdated` ausstehend; falsch gedruckt wird nichts.
- **Gemischte App-Stände:** Eine noch nicht aktualisierte App schickt die neuen Felder nicht. Marke, Größe einzeln oder das kurze Datum fehlen dann auf ihren Etiketten, bis sie aktualisiert ist.
- **Späterer Generator:** Ändert ein späterer Stowly den Generator, ändern sich beim Start auch eigene Etiketten, so wie heute die mitgelieferten.
- **Rechenlast am NAS:** Die Vorschau kostet Rechenzeit. Dagegen: entprellt, höchstens zwei zugleich, kleine Bilder.
- **Open Food Facts bremst:** Wer oft klickt, bekommt den gespeicherten Stand und den Satz „Open Food Facts bremst gerade; in einer Minute noch einmal."
- **Bild offline:** Ohne Verbindung beim Speichern bleibt das Bild aus; der Dialog sagt es.
- **Bündel:** etwa 1,1 kB Reserve. Alles Neue wird nachgeladen; gemessen wird nach dem Bau.
- **Drucker am Server über USB:** Docker sieht einen frisch eingeschalteten Drucker unter Umständen erst nach einem Neustart. Der Rat sagt es.

## Nicht enthalten

- freie Anordnung (ziehen, Millimeter), Hochformat, eigene Schriften, Logos, Strichcode auf dem Etikett;
- Gestaltung oder Papier je Drucker;
- runde und zweifarbige Etiketten, 102-mm-Rollen (nur QL-1050/1100);
- Testetikett ohne Packung;
- Druckdienst des Pi automatisch aktualisieren;
- „Alle Platzhalter neu abfragen" auf einmal; weitere Felder von Open Food Facts (Kategorien, Nutri-Score);
- die offenen Prüfpunkte aus `docs/pruefliste.md` (eigener Schritt).
