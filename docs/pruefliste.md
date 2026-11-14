# Prüfliste für die Zielumgebung

Auf dem Entwicklungsrechner laufen Server, Druckdienst und App zusammen: automatische Tests auf allen Seiten, dazu ein Durchgang im Browser mit dem Bild-Treiber. Alles, was Docker, echte Handys, einen echten Drucker oder den Raspberry Pi braucht, ließ sich dort nicht prüfen. Diese Liste führt in der Reihenfolge hindurch, in der man es tut.

Die Kürzel in Klammern verweisen auf die Tabellen mit Befehl und erwartetem Ergebnis: A bis K in [`betrieb.md`](betrieb.md) (Abschnitt „Prüfliste für die Zielumgebung"), P bis V in [`../pi/README.md`](../pi/README.md). Wo etwas anders ausgeht als beschrieben, hilft zuerst die Fehlersuche in `betrieb.md`, Abschnitt 11.

## A. Container

- [ ] **1.** `.env` anlegen und `STOWLY_PASSWORD` setzen. `docker compose build` (braucht Internet): Beide Stufen laufen durch, dazu `fonts-dejavu-core` und `libusb-1.0-0`. (A1–A3, F1)
  - Die drei Aufrufe `pip install` laufen durch: die Sperrdatei `server/requirements.lock`, Druckdienst und Server, die Brother-Bibliothek. „Building wheel for packbits" erscheint, „Installing build dependencies" nirgends; danach „Successfully uninstalled setuptools-78.1.1" und „No broken requirements found."
  - `docker compose run --rm --no-deps stowly pip freeze` zeigt dieselben Versionen wie `server/requirements.lock` und `print/requirements-brother.txt`, kein setuptools.
- [ ] **2.** `docker compose up -d`: Der Container wird `healthy`. `/api/health`, `/` und `/sw.js` antworten. Der Dienst läuft als Benutzer `stowly`; `/data` und `/data/print` gehören ihm. (A4–A8, F5)
- [ ] **3.** Log ansehen (A9, F2–F4):
  - kein Traceback
  - „Etikett-Vorlagen übernommen"
  - „Druckdienst unter /print bereit"
  - „Schriften der Etiketten:" nennt dreimal eine Datei unter `…/stowly_print/fonts/`, nicht „eingebaut"
  - `brother_ql` und `usb` lassen sich importieren
- [ ] **4.** Anmelden per `curl`. Nach `restart` und nach `down`/`up` sind die Daten noch da. Ohne `STOWLY_PUBLISH` ist der Port von außen nicht erreichbar. Im Log steht die Zeile zu Open Food Facts. `docker compose stop` endet in höchstens 15 Sekunden, auch während eine App auf ein Etikett wartet, und in deutlich unter 5 Sekunden, während nur ein Scan auf das Nachschlagen wartet. (A10–A15, F9)

## B. HTTPS davor

- [ ] **5.** Nginx Proxy Manager (B1–B5) oder Tailscale (B6–B8) einrichten. Die Kopfzeile `Content-Security-Policy` kommt unverändert durch (H1). `/print/v1/health` ohne Token antwortet mit 401 (F7).

## C. Handys über die HTTPS-Adresse

- [ ] **6.** Auf Android und iPhone: öffnen ohne Zertifikatswarnung, installieren, anmelden (C1–C4).
  - Android: Der Hinweis „Stowly als App installieren" erscheint einmal; sonst Einstellungen → Diese App → „Stowly installieren". Dort auch die Zeile „Lokaler Speicher" ansehen: Nach der Installation sollte sie „dauerhaft" zeigen.
  - iPhone und iPad: Die Anleitung „Zum Home-Bildschirm" erscheint (auch auf einem iPad, das sich als Mac ausgibt). Danach vom Home-Bildschirm öffnen und dort anmelden.
  - Die Kamera in der Scan-Ansicht erlauben; das Bild erscheint.
  - Mit VoiceOver (iPhone) bzw. TalkBack (Android): In „Von Hand einlagern" auf „Einlagern" tippen. Angesagt wird „beschäftigt" bzw. „nicht verfügbar", der Fokus bleibt auf der Schaltfläche, danach wird der Dialog „Eingelagert" angesagt.
  - Mit der Bildschirmtastatur: In Einstellungen → Geräte „Umbenennen", neuen Namen tippen, zweimal schnell die Eingabetaste: Das Gerät wird genau einmal umbenannt.

## D. Drucker am Server

- [ ] **7.** Einen Drucker „am Server" mit dem Bild-Treiber anlegen, als Standarddrucker wählen, eine Packung einlagern. Erwartet: „gedruckt"; „Etikett ansehen" zeigt das Etikett mit echten Umlauten; das zweite Handy sieht „gedruckt" nach seinem nächsten Abgleich. (F6)
- [ ] **8.** Den Brother anlegen, im Netz oder per USB (`docker-compose.usb.yml`, F12). Nach dem Anlegen steht der Fokus auf „Verbindung prüfen"; erwartet „Der Druckdienst antwortet" und „verbunden, bereit, Etiketten eingelegt".
  - Gegenproben: Drucker aus ergibt „nicht verbunden" (F11), Rolle heraus ergibt „Etiketten leer".
  - Einlagern: „gesendet" (Netz) oder „gedruckt" (USB). Bei USB den Drucker aus- und wieder einschalten: Er druckt danach weiter. (F10, F13, F14)
- [ ] **9.** Zuordnung: Standarddrucker und den Drucker einer Zone umstellen; „Druckt für …" auf den Drucker-Karten stimmt.
- [ ] **10.** Mit „Etiketten" an von Hand und über die Scan-Ansicht einlagern: Das Etikett kommt aus dem Drucker der Zone. Nachdruck über eine Charge („Etikett") und im Packungs-Dialog. Zonen → QR-Code → „Vorschau des Etiketts" → „Etikett drucken".
  - Bei langsamem Server (großer Bestand, schwaches WLAN): „Jetzt drucken" ist spätestens nach etwa 10 Sekunden wieder frei, das Etikett druckt nach dem Abgleich von selbst. „Verbindung prüfen" an einem eben angelegten Drucker am Server meldet höchstens kurz „unbekannter Drucker".
- [ ] **11.** **Ab hier die beiden Langzeitproben anstoßen:** ein Folienetikett (DK-22212) auf eine Gefrierdose bei −18 °C und ein Papieretikett (DK-22205) ins Regal (V1, V2, F15); das iPhone acht Tage nicht öffnen (C10). Ausgewertet wird in Abschnitt L.
- [ ] **12.** Hängender Druck mit dem Bild-Treiber: `hang` in `simulate.txt` schreiben, einlagern, `docker compose restart`, Datei entfernen (F8).
  - Erwartet: Das Etikett wird „unklar"; es entsteht kein Bild, und nichts druckt von selbst nach.
  - In der App erscheint „Wurde das Etikett gedruckt?"; „Nein" bietet „Erneut drucken" an.
  - Bei mehreren: „Alle gedruckt" oder einzeln beantworten.
  - Die Scan-Ansicht wird von der Nachfrage nicht unterbrochen.

## E. Raspberry Pi

- [ ] **13.** SD-Karte, Zertifikat (S4), `install.sh` zweimal hintereinander, Dienst, Rechte, Journal (`pi/README.md` Abschnitte 1–4, P1–P8).
- [ ] **14.** QL-800 am Pi (Q1–Q6, Q8):
  - „Editor Lite" am Drucker an ergibt `offline`, aus ergibt „bereit".
  - Probedruck: Umlaute stimmen, der QR-Code ist lesbar.
  - Deckel offen, Rolle heraus, Kabel gezogen: Die App nennt jeweils den Grund.
  - Drucker aus und wieder ein: Er druckt, ohne dass der Dienst neu gestartet wird.
- [ ] **15.** Access Point: Android „verbunden bleiben", iPhone, DHCP, WLAN-QR-Code am Kellereingang (R1–R5).
- [ ] **16.** Die Zertifizierungsstelle auf Android und iPhone installieren; `https://10.71.83.1:8443/v1/health` öffnet sich ohne Warnung (S1, S2).

**Stand 14.11.2026** (Raspberry Pi 5 mit Raspberry Pi OS Lite 64-bit, Brother QL-570 am USB, im Heim-WLAN):
- **13. teilweise:** SD-Karte, `install.sh` zweimal hintereinander und der Dienst laufen; die Versionen aus Trixie sind wie in P2 erwartet. Offen: Zertifikat (S4), Rechte, Journal.
- **14. teilweise, mit dem QL-570 statt QL-800:** Der Probedruck kam und sah gut aus. Offen: Umlaute und QR-Code genau ansehen, Deckel, Rolle, Kabel, Drucker aus und ein.
- **Behoben** dabei: die falsche Meldung „Speicher nur lesbar" (`print/stowly_print/health.py`).

## F. Direktdruck aus der App

**Stand 14.11.2026:**
- Aus der App unter `http://localhost:8010` (Chrome/Edge am PC im Heimnetz) ließ sich der Pi über `http://<Adresse des Pi>:8080` als Drucker anlegen, prüfen und bedrucken.
- Danach am iPhone (iOS 27, App vom Home-Bildschirm, App über einen HTTPS-Testaufbau am PC statt `stowly.home`):
  - Der Pi war über HTTPS mit einem Zertifikat der Stowly Drucker-CA erreichbar; „Verbindung prüfen" klappte.
  - Ein neues Produkt einlagern: Der Name kam sofort, das Etikett kam direkt nach dem Anlegen.
  - Stolperstein: Der Schalter unter Zertifikatsvertrauenseinstellungen war aus. Safari ließ sich mit „trotzdem besuchen" täuschen, die App meldete „antwortet auf keiner Adresse" (`pi/README.md`, Abschnitt 2).
- Offen: alles unter `stowly.home`, im Keller-WLAN, Android, die Gegenproben.

- [ ] **17.** Über die HTTPS-Adresse der App einen Drucker „Direkt (Raspberry Pi)" anlegen: `https://10.71.83.1:8443`, `http://10.71.83.1:8080`, Token (T1). Im WLAN des Pi „Verbindung prüfen": Chrome fragt einmal nach dem Zugriff auf das lokale Netzwerk, erlauben. Erwartet: „erreicht über https://…"; die Karte zeigt den Rechner des Pi und „zuletzt gesehen".
- [ ] **18.** Gegenproben (T5):
  - Die Nachfrage ablehnen ergibt „Der Browser hat den Zugriff auf das lokale Netzwerk abgelehnt."
  - Ein falsches Token ergibt „Die Gegenstelle hat sich nicht als Druckdienst von Stowly ausgewiesen."
  - Die App über `http://` geöffnet ergibt „Direktdruck geht nur über die HTTPS-Adresse."
  - Den Ursprung der App aus `origins` des Pi entfernt ergibt „Der Druckdienst antwortet, lässt diese App aber nicht zu."
- [ ] **19.** Die Nachfrage des Browsers. Sie ließ sich auf dem Entwicklungsrechner nicht auslösen; bitte genau hinsehen:
  - Einmal erst nach 5 bis 10 Sekunden erlauben: Die Prüfung geht noch durch.
  - Einmal erst nach mehr als 20 Sekunden erlauben: Was aussteht, druckt kurz danach von selbst.
  - In den Einstellungen der Seite erlauben: Es druckt ohne Tipp. Danach wieder entziehen.
  - Android 17: ohne die Systemerlaubnis für Chrome „nicht erreichbar", mit ihr druckt es.
- [ ] **20.** Zwei Packungen in den Keller einlagern, auf Android und iPhone: Die Etiketten kommen in der Reihenfolge der Packungen, Zustand „gedruckt" (T3). Oben im Haus einlagern ergibt „steht aus"; im Keller die App sichtbar machen, dann druckt es von selbst nach 5 bis 60 Sekunden.
- [ ] **21.** Zwei Handys: A lagert oben im Haus eine Packung in den Keller ein; das Etikett bleibt „ausstehend". B gleicht oben ab, geht in den Keller, tippt in der Drucker-Ansicht bei diesem Etikett auf „Hier drucken" und druckt es. Wieder oben gleichen beide ab: A druckt das Etikett nicht mehr.
- [ ] **22.** Nur HTTP (die HTTPS-Adresse vorübergehend aus dem Drucker entfernen), auf Android: Nachfrage, Druck, kein Fehler wegen gemischter Inhalte (T2).
- [ ] **23.** iPhone: in Safari „prüfen" und drucken, danach dasselbe aus der installierten App. **Bitte melden, wenn es aus der installierten App nicht geht** (S3); dann bleibt am iPhone der Notweg aus Schritt 25.
- [ ] **24.** Ein Etikett auslösen und sofort das WLAN aus- und wieder einschalten: Es kommt höchstens ein Etikett; ist der Ausgang unklar, fragt die App (T4). 20 Packungen auf einmal: alle in ihrer Reihenfolge, keines doppelt (Q7).
- [ ] **25.** Notweg über die Seite des Druckdienstes (T6), auch am iPhone:
  - Die Nachfrage des Browsers ablehnen, „Jetzt drucken": Es erscheinen der Satz zur Erlaubnis und „Über die Seite des Druckers drucken".
  - Ein neuer Tab öffnet sich. Greift der Popup-Blocker ein, zeigt die App den Verweis „Seite des Druckers öffnen".
  - Die Seite nennt die Zahl der Etiketten; „Drucken" zeigt je Etikett ein Ergebnis.
  - Zurück in der App die Nachfrage beantworten; danach ist der Verweis verschwunden.
  - Die Seite vor dem Beantworten noch einmal öffnen: Es wird nichts doppelt gedruckt. Mehr als 20 Etiketten brauchen einen zweiten Aufruf.
- [ ] **26.** Die App läuft unter `https://stowly.home` und das Handy ist im Keller-WLAN: einmal „prüfen", danach druckt die App dort von selbst.
  - Eine halbe Stunde im Keller mit offener App, Pi erreichbar, Server nicht: „ungesendet" in der Kopfzeile wächst nicht im Minutentakt. Zurück im Heim-WLAN kommt je Drucker genau ein Zustand beim Server an, der jüngste.
- [ ] **27.** Zurück im Heim-WLAN: Auf dem zweiten Gerät erscheint der Zustand des Pi mit „zuletzt gesehen" (T7).
- [ ] **28.** Den Pi stromlos machen und wieder einschalten: WLAN und Dienst kommen von selbst; die App sieht eine neue `boot_id` und druckt nichts nach (R6).

## G. Scannen

- [ ] **29.** An iPhone und Android:
  - Ein Etikett aus 15 bis 25 cm: bucht aus, mit Ton (Android auch Vibration) und „Rückgängig".
  - Im Regal aus 50 bis 100 cm: „Näher ran", kein Ton, nichts gebucht. Langsam näher: bucht ab etwa 35 cm.
  - Ein Barcode in der Hand, Etiketten im Hintergrund: Nur das Einlagern geht auf.
  - Ein Zonen-Etikett aus 1 m und aus der Nähe: wechselt die Zone.
  - Greift die Schwelle falsch, den Wert `MIN_LABEL_SIDE_RATIO` (Scan-Kern der App) anpassen lassen.
  - iPhone: Die Scan-Ansicht startet mit „2×", wenn Safari für die Kamera einen Zoom anbietet; ein ruhig gehaltener Barcode aus etwa 20 cm ist scharf und wird in etwa einer halben Sekunde erkannt. Steht dort kein „2×", bitte melden, ebenso den Namen der Kamera unter „Kamera wechseln".
  - Nach „Abbrechen" im Einlager-Dialog mit dem Barcode weiter im Bild: Der Dialog geht nicht von selbst wieder auf, die Ansicht sagt „Zum erneuten Scannen kurz wegschwenken". Kurz wegschwenken und wieder draufhalten: Der Dialog geht wieder auf.
  - Nach Eingabe des MHD mit der Tastatur läuft das Kamerabild weiter.
  - „Kein MHD" zeigt den Spinner an „Kein MHD", nicht an „Einlagern".
- [ ] **29a.** Nachschlagen beim Scannen, mit Internet am Server: Ein unbekannter echter Barcode öffnet den Dialog sofort; nach ein bis vier Sekunden stehen Name, Marke und Größe darin, mit „Von Open Food Facts (ODbL)" und Bild. Einlagern geht schon vorher.
  - Name schon getippt, bevor die Antwort kommt: Er bleibt stehen.
  - Denselben Barcode noch einmal scannen: Der Name ist sofort da; im Log steht nur eine Zeile „gefunden".
  - Ohne Netz am Handy: der bisherige Hinweis, kein Warten. Ein ladeninterner Code (beginnt mit 2) wird nicht nachgeschlagen.

## H. Offline und Abgleich

- [ ] **30.** Flugmodus, Änderungen auf beiden Handys, ein Konflikt (eines entnimmt, das andere ändert das MHD), Geräteliste, ein Gerät sperren; das Gerät „Prüfung" aus A10 sperren (C5–C9).
- [ ] **30a.** Ausfall und Rückkehr, App offen und angemeldet: Container stoppen, binnen etwa 15 Sekunden steht „Offline"; starten, binnen etwa 15 Sekunden „Aktuell", ohne Zutun. Im Log des Servers höchstens eine Abfrage `/api/health` je 15 Sekunden, auch mit zwei offenen Fenstern; ist die App im Hintergrund, keine.

## I. Content-Security-Policy an den Geräten

- [ ] **31.** Die Konsole des Browsers auf Desktop, Android und iPhone ansehen, dazu ein älteres iOS und einmal `STOWLY_CSP=off` (H2–H5).

## J. Sicherung

- [ ] **32.** Sicherung herunterladen, prüfen, zurückspielen (D1–D6).

## K. Aktualisieren

- [ ] **33.** `git pull` und `docker compose up -d --build`, oder der Weg über das Git-Bundle (E1–E3). In der App:
  - Das Banner „Neue Version" erscheint nach dem nächsten Öffnen oder binnen einer Stunde, nicht mitten in einem Dialog.
  - „Jetzt aktualisieren" lädt genau einmal neu; die Version steht unter Einstellungen → Über.
  - Zwei Tabs: Der im Hintergrund lädt von selbst neu. Ein sichtbarer bietet die neue Version an oder zeigt die Sperre „Stowly wurde aktualisiert" mit einer Schaltfläche zum Neuladen.
  - Danach offline jede Ansicht öffnen.
- [ ] **34.** Pi: Overlay an, eine Probedatei ist nach dem Neustart verschwunden, aktualisieren trotz Schreibschutz, Overlay aus (U1–U4).

## L. Nach vier Wochen

- [ ] **35.** Gefrierdose und Regal: Das Etikett haftet, der QR-Code ist mit beiden Handys lesbar, auch bereift (V1, V2, F15). Das iPhone hat seinen Bestand nach acht Tagen Pause noch (C10).
- [ ] **36.** Das Aussehen der gedruckten Etiketten (V3). Mit der mitgelieferten Schrift DejaVu ist es auf dem Entwicklungsrechner als Bild geprüft und nachgemessen, aber nicht auf Papier:
  - Lange Produktnamen stehen in zwei Zeilen, werden kleiner und enden notfalls mit „…".
  - ID und Einlagerdatum stehen vollständig da. **Bitte melden, falls eines davon mit „…" endet.**
  - In der Zeile darunter steht die Packungsgröße vor der Marke. Ein sehr langer Markenname endet mit „…", die Größe bleibt stehen („330 ml · COCA-COLA SERVIC…").

# Stufe 2

Auf dem Entwicklungsrechner geprüft:
- alle automatischen Tests
- im Browser gegen den echten Server: Einkaufsliste, Mindestbestand mit automatischem Eintrag, FIFO-Hinweis, Statistik und die Zustände in den Einstellungen
- der Sensor per Aufruf
- eine automatische Sicherung, entschlüsselt und geöffnet

Am iPhone (iOS 27, Testaufbau mit eigener CA, 14.11.2026) kamen Testnachricht und Tagesnachricht an.

Offen sind Docker, Android, Home Assistant mit Bring! und das echte Programm `age`.

## M. Umstieg

- [ ] **37.** Den Server mit den Daten aus Stufe 1 aktualisieren (Punkt 33). Im Log läuft die Migration 0003 ohne Fehler; Bestand und Einstellungen sind unverändert.
- [ ] **38.** Ein Gerät mit der App aus Stufe 1, das noch ungesendete Änderungen hat:
  - Es zeigt „Jetzt aktualisieren".
  - Danach lädt es einmal alles neu und sendet seine Änderungen.
  - Anmeldung, Gerätename, Ton und Kamera bleiben.
- [ ] **39.** Eine neue Version kommt beim nächsten Öffnen der App an: Stowly sucht beim Start danach, nicht erst nach einer Stunde.

## N. Einkaufsliste, Mindestbestand, FIFO

- [ ] **40.** Mindestbestand setzen und unterschreiten:
  - Die Bestandsliste zeigt sofort „fehlt n".
  - Mit Verbindung steht der Eintrag binnen Sekunden auf der Einkaufsliste, ohne Netz nach dem nächsten Abgleich.
- [ ] **41.** Eigene Einträge, mit Produkt und als freier Text, im Keller ohne Netz anlegen und abhaken, danach abgleichen. Ein Produkt mit eigenem Eintrag einlagern: Der Eintrag ist erledigt.
- [ ] **42.** Scannen: Nach der letzten Packung eines Produkts ohne Mindestbestand bietet die Scan-Ansicht „Auf die Einkaufsliste" an, bei einem Produkt mit Mindestbestand nicht.
- [ ] **43.** FIFO: Eine neuere Packung per Scan entnehmen, während eine ältere desselben Produkts da ist. Erwartet:
  - „Älter: … · MHD … · Zone" neben „Rückgängig"
  - „Rückgängig" bucht zurück, danach die ältere scannen.
  - Mit echten Etiketten prüfen.

## O. Statistik

- [ ] **44.** Am Handy (375 px):
  - kein waagrechtes Scrollen, in beiden Themen lesbar
  - im Flugmodus der Hinweis
  - Je eine Packung als verbraucht, entsorgt und „falsch erfasst" entnehmen: Im laufenden Monat steigen „verbraucht" und „entsorgt" um je 1, „falsch erfasst" zählt nicht.

## P. Automatische Sicherung

- [ ] **45.** Zwei Schlüssel mit `age-keygen` erzeugen, die öffentlichen in die `.env`, `./backups` für uid 10001 anlegen ([`betrieb.md`](betrieb.md), Abschnitt 8.1; D7–D9).
- [ ] **46.** Nach dem Start liegt `stowly-…sqlite3.gz.age` mit den Rechten 0600 im Ordner. Die App zeigt unter „Sicherung" Uhrzeit, letzte Sicherung und die gekürzten Schlüssel.
- [ ] **47.** Probe-Entschlüsselung mit jedem privaten Schlüssel: `age -d -i … | gunzip | head -c 15` zeigt `SQLite format 3`. Danach an einer Testkopie zurückspielen (D10–D13).
- [ ] **48.** Den Ordner nicht beschreibbar machen: Die App meldet den Fehler und nach 48 Stunden die Warnung.

## Q. Push

- [x] **49.** iPhone, installierte App, iOS 27, Testaufbau: Testnachricht und Tagesnachricht kommen an. Titel „Testnachricht" bzw. „MHD-Hinweis", darunter von iOS „from" mit dem Namen der App (14.11.2026).
- [ ] **50.** Dasselbe auf dem eigenen Server mit eurer CA (I1–I6), dazu die Tagesnachricht „nur Neues" (I8–I12).
- [ ] **51.** Android, Chrome, im Browser und installiert:
  - Testnachricht senden.
  - Tippen auf die Testnachricht öffnet die Einstellungen, auf die Tagesnachricht die Warnungen, ohne die App neu zu laden.
- [ ] **52.** iPhone: Tippen auf eine Mitteilung öffnet Stowly.
  - **Bekannte Grenze unter iOS 27:** Stowly öffnet am Anfang, nicht in der Zielansicht ([`integrationen.md`](integrationen.md), Abschnitt 4.5).
  - Mit dem eigenen Server und späteren iOS-Fassungen erneut versuchen; ändert sich etwas, bitte melden.
- [ ] **53.** Benachrichtigungen im Browser blockieren und wieder erlauben: Die Zeile in den Einstellungen wechselt ohne Neuladen.

## R. Home Assistant und Bring!

- [ ] **54.** Home Assistant einrichten ([`betrieb.md`](betrieb.md), Abschnitt 17), dann Bring! hin und zurück (J1–J13).
  - Dabei die offenen Fragen aus [`integrationen.md`](integrationen.md), Abschnitt 9 beantworten und melden: Sie bestimmen, ob Stowly Namen kürzen oder länger auf gelöschte Artikel warten muss.
- [ ] **55.** Den Sensor in HA einrichten und den Satz vorlesen lassen (K1–K6).

## S. Bedienung

- [ ] **56.** Tastatur am Desktop:
  - Zonen mit Enter umsortieren: Der Fokus bleibt am Knopf.
  - In der Lösch-Historie mit Enter wiederherstellen: Der Fokus geht an die nächste Zeile.
  - Ein Gerät umbenennen und während des Speicherns Escape drücken: Nichts schließt.
- [ ] **57.** Zeitangaben: Was vorgestern war, heißt „vor 2 Tagen", nicht „gestern".
