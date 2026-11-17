# Prüfliste für die Zielumgebung

Auf dem Entwicklungsrechner laufen Server, Druckdienst und App zusammen: automatische Tests auf allen Seiten, dazu ein Durchgang im Browser mit dem Bild-Treiber. Alles, was Docker, echte Handys, einen echten Drucker oder den Raspberry Pi braucht, ließ sich dort nicht prüfen. Diese Liste führt in der Reihenfolge hindurch, in der man es tut.

Die Kürzel in Klammern verweisen auf die Tabellen mit Befehl und erwartetem Ergebnis: A bis O in [`betrieb.md`](betrieb.md) (Abschnitt „Prüfliste für die Zielumgebung"), P bis V in [`../pi/README.md`](../pi/README.md). Wo etwas anders ausgeht als beschrieben, hilft zuerst die Fehlersuche in `betrieb.md`, Abschnitt 11.

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

**Stand 14.11.2026** (Synology mit DSM 6.2.4, Docker 20.10.3, `docker-compose` 1.28.5; [`betrieb.md`](betrieb.md), Abschnitt 4.4):
- **1. teilweise:** Beide Stufen bauen durch, die drei `pip install` wie beschrieben, bis „No broken requirements found.". Offen: `pip freeze`.
- **2. teilweise:** Der Container läuft; `/api/health` (`"configured": true`), `/` und `/sw.js` antworten. Offen: Zustand `healthy`, Benutzer und Rechte.
- Stolpersteine, beide in Abschnitt 4.4 beschrieben: `sudo` fand `docker` nicht, und einmal brach pip mit `ReadTimeoutError` ab (Internet des NAS). Der zweite Lauf ging durch.

## B. HTTPS davor

- [ ] **5.** Nginx Proxy Manager (B1–B5) oder Tailscale (B6–B8) einrichten. Die Kopfzeile `Content-Security-Policy` kommt unverändert durch (H1). `/print/v1/health` ohne Token antwortet mit 401 (F7).

**Stand 14.11.2026:** Statt Nginx Proxy Manager der Reverse Proxy von DSM, unter `https://<IP des NAS>:8443` mit einem Zertifikat der Stowly Drucker-CA ([`betrieb.md`](betrieb.md), Abschnitt 4.4). Die Kopfzeile `Content-Security-Policy` kommt unverändert durch, `/print/v1/health` ohne Token antwortet mit 401, `/`, `/sw.js` und das Manifest kommen mit `Cache-Control: no-cache`.

## C. Handys über die HTTPS-Adresse

- [ ] **6.** Auf Android und iPhone: öffnen ohne Zertifikatswarnung, installieren, anmelden (C1–C4).
  - Android: Der Hinweis „Stowly als App installieren" erscheint einmal; sonst Einstellungen → Diese App → „Stowly installieren". Dort auch die Zeile „Lokaler Speicher" ansehen: Nach der Installation sollte sie „dauerhaft" zeigen.
  - iPhone und iPad: Die Anleitung „Zum Home-Bildschirm" erscheint (auch auf einem iPad, das sich als Mac ausgibt). Danach vom Home-Bildschirm öffnen und dort anmelden.
  - Die Kamera in der Scan-Ansicht erlauben; das Bild erscheint.
  - Mit VoiceOver (iPhone) bzw. TalkBack (Android): In „Von Hand einlagern" auf „Einlagern" tippen. Angesagt wird „beschäftigt" bzw. „nicht verfügbar", der Fokus bleibt auf der Schaltfläche, danach wird der Dialog „Eingelagert" angesagt.
  - Mit der Bildschirmtastatur: In Einstellungen → Geräte „Umbenennen", neuen Namen tippen, zweimal schnell die Eingabetaste: Das Gerät wird genau einmal umbenannt.

**Stand 14.11.2026:** Am iPhone (iOS 27) öffnet sich die App vom NAS ohne Zertifikatswarnung, ließ sich installieren und anmelden. Offen: Android und die Unterpunkte oben.

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
- Danach dasselbe mit der App vom NAS (`https://<IP des NAS>:8443`, [`betrieb.md`](betrieb.md), Abschnitt 4.4): Drucker am iPhone angelegt, „Verbindung prüfen" klappte, das Etikett kam. Der Ursprung der App musste dafür in `origins` des Pi.
- Offen: im Keller-WLAN, Android, die Gegenproben.

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

- [ ] **32.** „Jetzt sichern", die Sicherung herunterladen, mit `age` prüfen, in der App zurückspielen (D1–D6). Seit 0.4.0 gibt es nur noch die verschlüsselte Sicherung.

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

Am iPhone (iOS 27, Testaufbau mit eigener CA, 14.11.2026) kamen Testnachricht und Tagesnachricht an. Am selben Tag lief Stowly erstmals mit Docker auf einer Synology (Abschnitt A); auch von dort kam die Testnachricht an.

Offen sind Android, Home Assistant mit Bring!, die automatische Sicherung auf dem Server und das echte Programm `age`.

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

- [ ] **45.** Nur für die Sicherung aus der `.env`: Zwei Schlüssel mit `age-keygen` erzeugen, die öffentlichen in die `.env`, `./backups` für uid 10001 anlegen ([`betrieb.md`](betrieb.md), Abschnitt 8.5; D7–D9). In der App geht es seit 0.4.0 ohne `age` (Abschnitt V).
- [ ] **46.** Nach dem Start liegt `stowly-…sqlite3.gz.age` mit den Rechten 0600 im Ordner. Die App zeigt unter „Sicherung" Uhrzeit, letzte Sicherung und die gekürzten Schlüssel.
- [ ] **47.** Probe-Entschlüsselung mit jedem privaten Schlüssel: `age -d -i … | gunzip | head -c 15` zeigt `SQLite format 3`. Danach an einer Testkopie zurückspielen (D10–D13).
- [ ] **48.** Den Ordner nicht beschreibbar machen: Die App meldet den Fehler und nach 48 Stunden die Warnung.

## Q. Push

- [x] **49.** iPhone, installierte App, iOS 27, Testaufbau: Testnachricht und Tagesnachricht kommen an. Titel „Testnachricht" bzw. „MHD-Hinweis", darunter von iOS „from" mit dem Namen der App (14.11.2026).
- [ ] **50.** Dasselbe auf dem eigenen Server mit eurer CA (I1–I6), dazu die Tagesnachricht „nur Neues" (I8–I12).
  - **Stand 14.11.2026:** Vom NAS (DSM, Zertifikat der Stowly Drucker-CA) kam die Testnachricht an. Offen: die Tagesnachricht „nur Neues".
- [ ] **51.** Android, Chrome, im Browser und installiert:
  - Testnachricht senden.
  - Tippen auf die Testnachricht öffnet die Einstellungen, auf die Tagesnachricht die Warnungen, ohne die App neu zu laden.
- [ ] **52.** iPhone: Tippen auf eine Mitteilung öffnet Stowly.
  - **Bekannte Grenze unter iOS 27:** Stowly öffnet am Anfang, nicht in der Zielansicht ([`integrationen.md`](integrationen.md), Abschnitt 4.5).
  - Mit dem eigenen Server und späteren iOS-Fassungen erneut versuchen; ändert sich etwas, bitte melden.
- [ ] **53.** Benachrichtigungen im Browser blockieren und wieder erlauben: Die Zeile in den Einstellungen wechselt ohne Neuladen.

## R. Home Assistant und Bring!

- [ ] **54.** Home Assistant einrichten ([`betrieb.md`](betrieb.md), Abschnitt 17), dann Bring! hin und zurück (J1–J13).
  - **Stand 14.11.2026** (Stowly auf dem NAS, HA im Heimnetz per http, die echte Bring!-Liste statt einer Testliste):
    - J1: Ein HA-Benutzer ohne Administratorrechte genügt. Die App zeigt „ok".
    - J2: Ein Eintrag aus Stowly stand nach wenigen Minuten in Bring!, mit der Spezifikation „1× · Stowly".
    - J10: HA neu gestartet, während der Artikel in Bring! stand: In Stowly blieb er offen.
    - J7: In Bring! abgehakt, danach in Stowly erledigt.
    - Offen: J3–J6, J8, J9, J11, J13.
  - Dabei die offenen Fragen aus [`integrationen.md`](integrationen.md), Abschnitt 9 beantworten und melden: Sie bestimmen, ob Stowly Namen kürzen oder länger auf gelöschte Artikel warten muss.
- [ ] **55.** Den Sensor in HA einrichten und den Satz vorlesen lassen (K1–K6).
  - **Stand 14.11.2026:**
    - K1–K3: Mit Token kommt die Zusammenfassung; ohne Token und mit dem Sensor-Token an `/api/devices` jeweils 401.
    - K4: In HA haben `sensor.stowly` und die drei Vorlagen-Sensoren Werte, über HTTPS zum NAS mit `verify_ssl: false` (Home Assistant OS, K6).
    - Offen: K5, die Ansage.
- [ ] **55a.** Die Liste aller Waren in HA: der zweite Sensor und die Markdown-Karte aus [`betrieb.md`](betrieb.md), Abschnitt 18.4 (K7, K8). Abgelaufenes steht rot, bald Fälliges orange, je Zone eine Tabelle.

## S. Bedienung

- [ ] **56.** Tastatur am Desktop:
  - Zonen mit Enter umsortieren: Der Fokus bleibt am Knopf.
  - In der Lösch-Historie mit Enter wiederherstellen: Der Fokus geht an die nächste Zeile.
  - Ein Gerät umbenennen und während des Speicherns Escape drücken: Nichts schließt.
- [ ] **57.** Zeitangaben: Was vorgestern war, heißt „vor 2 Tagen", nicht „gestern".

## T. Updates über GitHub

- [ ] **58.** Einrichten nach [`betrieb.md`](betrieb.md), Abschnitt 9.2: fertiges Image, Updater im Aufgabenplaner bzw. als systemd-Timer (L1).

**Stand 16.11.2026** (Synology DSM 6.2.4, Image von ghcr.io, Updater im DSM-Aufgabenplaner):
- **58, L1:** Der NAS lädt das fertige Image statt zu bauen; der Updater meldet sich jede Minute. Stolperstein: Der Zeitplan von DSM lief erst nur in einer Stunde des Tages; richtig ist erste Ausführungszeit 00:00, alle 1 Minute, letzte 23:59 (`betrieb.md` 9.2).
- **L3:** Die Vorabversion `v0.2.0-rc.3` hat kein `:latest` und kein „Latest"-Release; `releases/latest` blieb leer.
- **59, L4:** Nach dem Veröffentlichen von 0.2.1 bot die App die neue Version an.
- **60, L5, L6:** „Update installieren" in der App: Anforderung, Updater übernimmt, lädt 0.2.1, hält Stowly an, sichert die Datenbank (`before-0.2.0-…sqlite3`), stellt die `.env` um (Besitzer bleibt, `.env.bak` daneben), startet; nach gut einer Minute „healthy" und „Aktualisiert von 0.2.0 auf 0.2.1".
- Offen: L2 (Bremse beim Suchen), L7, L8, die Push-Nachricht zur neuen Version auf dem iPhone bestätigen.
- [ ] **59.** Suchen, Vorabversion und neue Version (L2–L4): Die Push-Nachricht kommt einmal je Version.
- [ ] **60.** Ein Update per Knopf in der App (L5, L6): Daten und Anmeldungen bleiben, die Handys holen sich die neue App.
- [ ] **61.** Gegenproben (L7, L8): Ein gescheiterter Download lässt die alte Version laufen; ohne Updater gibt es kein Installieren.

## U. Einrichtung per Mausklick und HTTPS durch Stowly

- [ ] **62.** Einen frischen Container per Mausklick in DSM anlegen und den Assistenten bis „Fertig" durchgehen ([`betrieb.md`](betrieb.md), Abschnitt 19; M1–M10).
- [ ] **63.** Ein Update per Knopf über den Updater-Container, danach den Container in DSM neu starten (M11, M12).
- [x] **64.** Eine Installation mit Docker Compose und Reverse Proxy umstellen: neue CA, HTTPS durch Stowly, den Pi neu koppeln (M8, M13; [`plan-einrichtung.md`](plan-einrichtung.md), „Probe und Umstieg"; 16.11.2026).

**Stand 16.11.2026** (Synology DSM 6.2.4; ein Testcontainer mit `0.3.0-rc.4` von Docker Hub neben dem laufenden Stowly, Ports 8020 und 8444; iPhone mit iOS 27):
- **M1:** Die Registrierung von DSM findet das Image auf Docker Hub; der Download läuft durch.
- **M2:** Der Container läuft ohne Umgebungsvariablen. Stolperstein: Die Ports standen zuerst in der Spalte „Container-Port", dann antwortet niemand. `betrieb.md` 19.1 zeigt die Spalten jetzt als Tabelle, Abschnitt 11 nennt das Anzeichen.
- **M3, M4:** „Willkommen bei Stowly", Passwort am PC vergeben, der Assistent öffnete sich; das iPhone sah danach die Anmeldung.
- **M5, M7:** Am iPhone das Profil der neuen CA installiert und das Vertrauen eingeschaltet. Die Prüfung wurde grün, der Wechsel auf `https://<NAS>:8444` mit Anmeldung gelang: iOS nimmt die CA mit Name Constraints an. Das Zertifikat hat Stowly beim Setzen des Passworts für die IP des NAS neu ausgestellt. Weil auf dem NAS der Reverse Proxy 8443 belegt, stand unter „Erweitert" der Port 8444.
- **M9:** Der Updater-Container entstand über den Aufgabenplaner, die App zeigt „Updater bereit"; DSM nimmt den Befehl an. Gefunden:
  - Bei einer Vorabversion nennt der Befehl das Image mit `:0.3.0` statt `:0.3.0-rc.4`. Von Hand korrigiert; die Korrektur kommt mit 0.3.1.
  - Die Aufgabe nicht „Stowly-Updater" nennen, wenn die Aufgabe des Host-Updaters (`betrieb.md` 9.2) schon so heißt.
- **64:** Der Umstieg des NAS auf 0.3.0 gelang:
  - Update per Knopf über den Host-Updater.
  - Neue CA aufs iPhone.
  - Proxy-Regel gelöscht, Stowly selbst auf 8443 (`docker-compose.override.yml`).
  - Die App am iPhone und Home Assistant laufen weiter.
- **M8:** Das neue Koppeln des Pi scheiterte mit 0.3.0, denn Docker auf DSM stellt jede Anfrage mit 172.19.0.1 zu. Mit 0.3.1 und der Rückprüfung gelang es („Vorhandenen Drucker übernehmen"):
  - Zertifikat der neuen CA für die IP, `stowly-drucker.local` und `10.71.83.1`.
  - Selbsttest und Testetikett durch.
  - Direktdruck vom iPhone über HTTPS.
- **M11:** Mit 0.3.0 war M11 nicht prüfbar, denn die Vorabversion meldet sich schon als 0.3.0. Mit 0.3.1 dann per Knopf:
  - Der Updater-Container ersetzte den Testcontainer.
  - Daten, Zertifikate und Ports blieben.
  - Dein Stowly kam gleichzeitig über den Host-Updater auf 0.3.1.
- **M13** zum Teil: Die Anmeldung mit dem Passwort aus der `.env` geht nach dem Umstieg weiter. Ob sich der Assistent von selbst öffnet, ist nicht eigens geprüft.
- Offen: M5 (Fingerabdruck mit dem Log vergleichen), M6, M10, M12.

## V. Stufe B: Sicherung und Home Assistant in der App (0.4.0)

Automatisch geprüft, auch gegen den echten Server samt Neustart beim Zurückspielen und mit einem nachgebildeten Home Assistant. Am NAS erst an einem Testcontainer per Mausklick, dann am eigenen Stowly; Home Assistant zuerst gegen eine Probe-Liste in HA, nicht gegen die echte Bring!-Liste.

- [ ] **65.** Im Assistenten des Testcontainers die Sicherung einrichten ([`betrieb.md`](betrieb.md), Abschnitt 8.2): Schlüssel erzeugen und an zwei Orten aufheben, mit dem Haushalts-Passwort übernehmen, prüfen, „Jetzt sichern", den Schalter einmal aus (N1–N5).
- [ ] **66.** Eine Sicherung herunterladen und am Rechner mit `age` und der Schlüsseldatei aus der App öffnen (N6, D10).
- [ ] **67.** Erst ohne, dann mit zweitem Ordner `/backups` in DSM (Abschnitt 19.4); einmal ohne Schreibrecht für Benutzer 10001: Stowly weicht in den Datenordner aus und sagt es (N3, N7, N8).
- [ ] **68.** Daten ändern, zurückspielen, die Gegenproben mit falschem Schlüssel und Passwort, dann „Rückgängig" und „Alte Datenbank löschen" (N9–N13). Die Handys laden neu, niemand muss sich neu anmelden.
- [ ] **69.** Ein frischer Container mit derselben Sicherung: „Aus einer Sicherung wiederherstellen", danach die sichere Verbindung neu, die Tokens für HA fehlen (N14–N16).
- [ ] **70.** Home Assistant am Testcontainer gegen eine Probe-Liste („Local To-do"): Verbindung, Liste, Wechsel der Liste, Sensor-Token mit YAML (N17–N19, N21, N22).
**Stand 16.11.2026** (Synology DSM 6.2.4; Testcontainer per Mausklick mit `v0.4.0-rc.2`, rc.1 scheiterte im Bau an einem Test, der nur unter Linux lief; am PC über http):
- **65:** Schlüssel erzeugen und als Datei speichern, mit dem Test-Passwort übernehmen, „Jetzt sichern", Herunterladen, „Schlüssel prüfen" mit der Datei: alles wie beschrieben (N1, N3, N4). Ohne zweiten Ordner landete die Sicherung im Datenordner.
- **67:** Mit zweitem Ordner `/backups` (in DSM per „Bearbeiten" → Volume am gestoppten Container) zeigte die App den eigenen Ordner, und „Jetzt sichern" legte die Datei dort ab (N7). Offen: der Fall ohne Schreibrecht (N8).
- **68:** Etwas Neues angelegt, zurückgespielt: Stowly startete neu, die App lud von selbst neu, angemeldet blieb sie, das Neue fehlte; „Rückgängig" brachte es zurück (N9, N12). Offen: die Gegenproben mit falschem Schlüssel und Passwort (N10), ein zweites Gerät (N11), „Alte Datenbank löschen" (N13).
- **69:** Ein zweiter frischer Container mit derselben Sicherung: „Aus einer Sicherung wiederherstellen" mit dem Passwort der Sicherung, nach dem Neustart angemeldet, die Daten waren da (N14).
- **70:** Gegen zwei Probe-Listen („Local To-do") in HA: Verbindung prüfen, Liste wählen, Zustand „ok"; ein Eintrag erschien in HA, in HA abgehakt war er in Stowly erledigt; nach dem Wechsel auf die zweite Liste wurde nichts abgehakt, der offene Eintrag ging in die neue Liste (N17, N19). Das YAML für den Sensor erschien (N21 nur bis dahin).
- Offen außerdem: 66 (Öffnen mit `age` am Rechner), N16 (Hinweis über http nur gesehen, nicht eigens geprüft), N18, N22.
- [ ] **71.** Das eigene Stowly per Knopf auf 0.4.0:
  - Home Assistant bleibt aus der `.env`; die App zeigt die Werte nur an, und „Verbindung prüfen" listet „Zuhause" (N20).
  - Die Sicherung in der App einrichten. Dabei prüfen, ob uid 10001 in `./backups` schreiben darf; sonst zeigt die App „Der eigene Ordner wird nicht benutzt" (oder, mit `STOWLY_BACKUP_DIR` in der `.env`, „… nicht beschreibbar").
  - Erste Sicherung, dann „Schlüssel prüfen".

**Stand 16.11.2026, spät** (eigenes NAS):
- **71** lief anders als geplant:
  - Das alte Stowly lief zuletzt mit 0.4.0 (`ghcr.io/xbitwinsdkx/stowly:0.4.0`).
  - Dann hat der Anwender es per Mausklick neu aufgesetzt: Image `xbitwinsdkx/stowly:latest`, eigener Datenordner, Ports 8010 und 8443.
  - Er hat mit frischen Daten angefangen; zurückgespielt wurde nichts. Die alte Installation samt Volume ist entfernt.
- **Assistent und Pi:**
  - Der Assistent erzeugte eine neue CA.
  - Der Pi koppelte sich mit dem Befehl aus der App. Die Rückprüfung klappte hinter dem NAT von Docker auch hier.
  - Dabei kam der Druckdienst von 0.3.1 auf 0.4.0, mit einem Zertifikat der neuen CA; der Selbsttest über HTTP und HTTPS lief durch.
  - Das Testetikett übersprang er, weil der Drucker aus war.
- **Sicherung in der App** (N1, N2 zum Teil, N4):
  - Schlüssel erzeugt und übernommen, dann gegen einen neuen getauscht und den alten entfernt.
  - „Jetzt sichern"; „Schlüssel prüfen" passte.
- **Home Assistant in der App** (N17; N21 ohne „Neu erzeugen"):
  - Adresse, Token, „Verbindung prüfen", Liste „Zuhause", „Speichern".
  - Sensor-Token erzeugt, die Zeile in die `secrets.yaml` von HA übernommen, HA neu gestartet: Laut Anwender läuft beides.
  - `/api/ha/summary` antwortete vorher mit 503 „nicht eingerichtet", danach ohne Token mit 401.
- **N20** entfällt am eigenen NAS: Ohne `.env` kommt nichts mehr aus der Umgebung.
- **Gefunden:** Mit ausgeschaltetem Drucker zeigt die Druckerkarte grün „Der Druckdienst antwortet." neben rot „nicht verbunden". Das wirkte widersprüchlich. Der Rat, den Drucker einzuschalten oder das USB-Kabel zu prüfen, gehört sichtbarer in die Karte.
- **Updater:** Den Updater-Container legte eine einmalige Aufgabe im DSM-Aufgabenplaner an, mit dem Befehl aus Einrichtung → „Updates“. Stowly zeigt „Updater bereit“. Die Aufgabe des Host-Updaters der alten Installation ist weg.

## W. Etiketten gestalten, Produktdaten und Druckerkarte (0.5.0)

Automatisch geprüft, auch gegen den echten Server und Druckdienst mit Bild-Treiber. Am NAS erst an einem Testcontainer per Mausklick, dann am eigenen Stowly; schmale und gestanzte Rollen erst, wenn so eine Rolle da ist.

- [ ] **72.** Testcontainer mit der Vorabversion und einem Drucker am Server mit Bild-Treiber: der Editor mit jedem Papier, Vorschau und gedrucktes PNG vergleichen, auch gedreht und gestanzt (O1 bis O7).
- [ ] **73.** Am Testcontainer „Online abfragen" an einem gescannten Produkt (O12 bis O15).
- [ ] **74.** Das eigene Stowly per Knopf auf 0.5.0: Etikett gestalten (62 mm endlos, andere Länge), Probedruck am QL-570 noch mit Druckdienst 0.4.0 (O8); ein Papier, das 0.4.0 nicht kann, bleibt ausstehend (O9).
- [ ] **75.** Den Pi neu koppeln, das sudo-Passwort tippt der Anwender; danach „Rolle: 62 mm endlos" und der Abgleich der Rolle (O10); QL-570 aus und wieder an (O11).
- [ ] **76.** „Online abfragen" an einem offline angelegten Produkt, mit Bild (O12, O13).
- [ ] **77.** Schmale oder gestanzte Rolle am QL-570, sobald eine da ist: Die Karte nennt die Rolle, das Etikett passt, mit der falschen Rolle druckt er nichts. Ungeprüft ist, ob der QL-570 bei gestanzten Rollen ihre Länge meldet: Steht in `GET /v1/health` bei `loaded` eine Länge von `null`, passt die gestanzte Rolle zu keinem Papier, und jeder Druck darauf endet mit `media_mismatch`; dann den Treiber nachbessern.

**Stand 17.11.2026** (eigenes NAS, Synology DSM 6.2.4; den Testcontainer hat der Anwender übersprungen, weil sein Stowly noch nicht in Benutzung ist, deshalb entfallen 72 und 73):
- **74, Update per Knopf:** Es hing bei „wird installiert“, obwohl Stowly 0.5.0 schon lief und „healthy“ war; es fehlte nur der Abschluss.
  - Ursache: Während des Updates lief die DSM-Aufgabe mit dem alten Updater-Befehl mehrmals. Angestoßen hatte das der Hinweis „Der Updater ist älter als Stowly: Befehl erneut ausführen“.
  - Jedes `docker rm -f stowly-updater` brach den Abschluss ab. Ein neuer Updater übernimmt ein fremdes, angefangenes Update erst, wenn die Sperre 30 Minuten alt ist.
  - Gelöst per SSH: den Updater mit dem neuen Befehl aus der App angelegt und die verwaiste Sperre `update/lock` entfernt. Der Updater übernahm („Wiederanlauf“), fand die neue Version „healthy“ und entfernte den alten Container: „Aktualisiert von 0.4.0 auf 0.5.0.“
  - Umgesetzt in 0.5.1 (X): Solange ein Update läuft, rät die App nicht zum Neuanlegen des Updaters. Eine Sperre, deren Container nicht mehr existiert, übernimmt der Updater nach einer Minute.
- **74, Etiketten:** Laut Anwender liefen O1 bis O3 am PC über http und O8 am iPhone wie beschrieben. Bei O8 waren es 62 mm endlos und 40 mm Länge, Probedruck am QL-570 mit Druckdienst 0.4.0. Bei O9 blieb der Probedruck mit „29 mm endlos“ ausstehend, und die Karte zeigte „Druckdienst 0.4.0 kann dieses Papier nicht“ mit „Neu koppeln“.
- **75 und 76** (O10 bis O15): auf Wunsch des Anwenders übersprungen. Der Pi bleibt vorerst bei Druckdienst 0.4.0. Für ein anderes Papier als 62 mm endlos muss er neu gekoppelt werden.

## X. Update per Knopf robuster (0.5.1)

Automatisch geprüft:
- **Übernahme:** Der Updater übernimmt die Sperre eines gelöschten Updaters nach einer Minute und bringt das Update bis „done“ zu Ende, auch wenn die Sperre schon älter als 30 Minuten ist. Ein `stop`, das Docker nach dem Löschen noch zu Ende führt, sieht er dabei schon als beendet.
- **Keine vorzeitige Übernahme:** solange es den alten noch gibt (auch angehalten oder beim Löschen), wenn Docker nicht antwortet, und ohne Journal. Einem laufenden Besitzer nimmt keiner die Sperre weg, auch keine alte. In den übrigen Fällen gilt die alte Regel mit 30 Minuten.
- **Journal:** Wer weiterführt, trägt sich ein; ein zweiter lebender Updater hält sich dann heraus, auch mit seiner eigenen, älteren ID in der Hand. Ohne eigene Container-ID führt keiner weiter.
- **Wiederanlauf nach `stopping`:** Hält Docker Stowly noch an, wartet der Updater bis zu 45 Sekunden und startet es dann wieder; sonst meldet er, dass es weiterläuft.
- **Rückweg nach einem Absturz:**
  - Die Datenbank geht zurück, auch wenn der neue Container schon gelöscht war (`phase=rollback`) oder sein `start` beim Absturz noch unterwegs war.
  - Kein zweites Mal, wenn die alte Version schon wieder läuft (`phase=restored`).
  - Einen alten Container, der auf der Datenbank der neuen nicht healthy wird, hält der Updater vorher an.
  - Lief die alte Version seit der Sicherung und läuft sie mit der jetzigen Datenbank, bleibt diese.
  - Die ersetzte Datenbank liegt als `replaced-…` in `update/`.
  - Ohne alten Container wird der neue gestartet statt gelöscht.
- **Server:** Nach einer Stunde „wird installiert“ sagt `state_message`, wo man nachsieht.
- **App:**
  - Während eines Updates zeigt sie keinen Befehl für den Updater, nach „done“ ohne Neuladen wieder.
  - Nach einer Stunde zeigt sie den Befehl, auch bei einem aktuellen Updater, mit dem Rat, ins Log zu sehen. Gemessen wird mit der Uhr des NAS.
  - Meldet sich der Updater gar nicht, zeigt sie ihn mit einer Warnung.

- [ ] **78.** Das eigene Stowly per Knopf auf 0.5.1 bringen. Noch während „wird installiert“ Einrichtung → Updates öffnen: Dort steht kein Befehl, sondern „Gerade läuft ein Update …“. Nach „Aktualisiert auf 0.5.1“ erscheinen Hinweis und Befehl (M14).
- [ ] **79.** Den Updater mit dem neuen Befehl erneuern (M15). Die Übernahme der Sperre am NAS nicht absichtlich herbeiführen; sie ist automatisch geprüft.

**Stand 17.11.2026** (eigenes NAS):
- **78:** Das Update per Knopf von 0.5.0 auf 0.5.1 lief in gut einer Minute ohne Zwischenfall. Der Updater 0.5.0 hielt Stowly an, sicherte, startete 0.5.1, fand es „healthy“ und räumte das alte Image 0.4.0 auf: „Aktualisiert von 0.5.0 auf 0.5.1.“ Ob Einrichtung → Updates währenddessen den neuen Hinweis zeigte (M14), ist nicht eigens angesehen.
- **79:** Den Updater per SSH mit demselben Befehl erneuert, den die App zeigt: Image 0.5.1, `--volumes-from` des neuen Containers. Vorher prüfte ein Skript, dass `update/state` „done“ für 0.5.1 meldet. Das Lebenszeichen kommt seitdem mit Version 0.5.1 (M15, in der App nicht eigens angesehen).

## Y. Was koche ich? (0.6.0)

Automatisch geprüft, ohne einen echten Aufruf bei Anthropic. Die Tests bilden die API nach; der Server-Teil steckt in `server/tests`, die App in vitest und e2e gegen den echten Server.
- **Schlüssel:**
  - Er steht nie in einer Antwort, im Log (auch DEBUG), in den Dateien der Datenbank, in einer Sicherung oder einem Ereignis.
  - Er geht nur in der Kopfzeile an `api.anthropic.com`, auch wenn Variablen `ANTHROPIC_*` gesetzt sind.
  - Die Umgebung geht vor der App; eine falsche Form gibt 422 ohne den Wert.
  - Fehlt die Datei nach dem Zurückspielen, sagt es `problem`.
- **Anfrage:** `effort` low, festes Schema, kein Parameter `thinking`, kein Sampling, keine Tools; Kopf und `fallbacks` nur bei Opus und Sonnet.
- **Vorratsliste:**
  - Reihenfolge und FIFO; Platzhalter fallen weg.
  - Höchstens 300 Produkte, die gewählten Zutaten auch jenseits der Grenze.
  - Keine Zone, kein Barcode, keine Kennung im Prompt.
- **Antwort:** unbekannte Schlüssel fallen weg, Namen aus Stowly, alles gesäubert und gekürzt; Ablehnung mit und ohne Kategorie; Antwort über das Ersatzmodell.
- **Fehler:** jede Zeile der Tabelle in `integrationen.md`, 13.6, samt Gutschrift.
- **Bremsen:**
  - eine Anfrage zugleich, 30 Sekunden je Gerät, 20 am Tag;
  - der Tageswechsel in `STOWLY_TIMEZONE`, auch ein Rücksprung der Uhr;
  - der Zähler übersteht einen Neustart.
- **Wiederholung:** ein zweiter Versuch nur, wenn der erste sicher nichts gekostet hat; nach dem Senden abgebrochen zählt, nicht gesendet zählt nicht; `x-should-retry: false` gilt.
- **Aufträge:** 202, dann `running` und `done`; ein fremdes Gerät bekommt 404; nach 15 Minuten weg.
- **App:**
  - Suchbegriffe und Links (nur Cookidoo und Chefkoch);
  - Vorwahl und `?mit=`;
  - Karten, „Fehlendes auf die Einkaufsliste“ ohne Doppelte;
  - Einstellungen mit gesperrtem Schlüssel aus der Umgebung;
  - alle Fehlertexte.

**Unabhängige Sicherheitsprüfung, 17.11.2026:** Server und App, mit Proben gegen eine nachgebildete API; kein Fund hoch oder mittel.
- **Behoben:**
  - die Zählung bei der Wiederholung (jetzt ohne die des SDK) und ein langes `retry-after`;
  - `no-store` auf allen Fehlerantworten;
  - die Prüfung bei kaputter oder fremder Antwort;
  - kürzere Felder im Prompt, die die höchsten Kosten senken;
  - Namen nur aus unsichtbaren Zeichen;
  - der Rücksprung der Uhr;
  - das Laden des SDK außerhalb der Ereignisschleife;
  - die Zwischendatei der `.env` im Updater für Docker Compose.
- **Bewusst so gelassen:**
  - Die gekürzte Meldung von Anthropic bei 400 steht im Log.
  - Ein als Feldname geschickter Schlüssel kommt im 422 an denselben Absender zurück.
  - Proxy- und Zertifikatsvariablen wirken (`betrieb.md`, 21.5).
  - Das Passwortfeld könnte der Passwortmanager des Browsers zum Speichern anbieten, wie beim Token für Home Assistant.

Am Gerät, mit dem eigenen Schlüssel (`betrieb.md`, Tabelle P); den Schlüssel trägt der Anwender selbst ein:
- [ ] **80.** Vorabversion `0.6.0-rc.1` am eigenen Stowly oder in einem Testcontainer: Seite, Vorwahl, Begriffe ändern und beide Such-Links, am PC und am iPhone, auch aus der installierten App und mit Umlauten (P1 bis P4).
- [ ] **81.** Schlüssel eintragen und „Prüfen“ (P5).
- [ ] **82.** Ein Durchgang je Modell mit Wunsch: Antwortzeit, Qualität, Kosten in der Console, Ersatzmodell bei einer Ablehnung, falls eine vorkommt (P6, P7). Danach `COOK_EFFORT` gegebenenfalls nachstellen. Nimmt Anthropic den Kopf für das Ersatzmodell nicht an, ihn abschalten.
- [ ] **83.** „Fehlendes auf die Einkaufsliste“ bis zu Bring! (P8).
- [ ] **84.** Bremse je Gerät, Rückkehr auf die Seite, Zähler nach einem Neustart, offline (P9 bis P12).
- [ ] **85.** Log und Arbeitsspeicher am NAS (P13, P14).
