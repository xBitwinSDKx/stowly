# Prüfliste für die Zielumgebung

Auf dem Entwicklungsrechner laufen Server, Druckdienst und App zusammen: automatische Tests auf allen Seiten, dazu ein Durchgang im Browser mit dem Bild-Treiber. Alles, was Docker, echte Handys, einen echten Drucker oder den Raspberry Pi braucht, ließ sich dort nicht prüfen. Diese Liste führt in der Reihenfolge hindurch, in der man es tut.

Die Kürzel in Klammern verweisen auf die Tabellen mit Befehl und erwartetem Ergebnis: A bis H in [`betrieb.md`](betrieb.md) (Abschnitt „Prüfliste für die Zielumgebung"), P bis V in [`../pi/README.md`](../pi/README.md). Wo etwas anders ausgeht als beschrieben, hilft zuerst die Fehlersuche in `betrieb.md`, Abschnitt 11.

## A. Container

- [ ] **1.** `.env` anlegen und `STOWLY_PASSWORD` setzen. `docker compose build`: Beide Stufen laufen durch, dazu `fonts-dejavu-core`, `libusb-1.0-0` und die Brother-Bibliothek mit Prüfsummen. Der Bau braucht Internet; das Paket `packbits` wird dabei aus dem Quelltext gebaut. (A1–A3, F1)
- [ ] **2.** `docker compose up -d`: Der Container wird `healthy`. `/api/health`, `/` und `/sw.js` antworten. Der Dienst läuft als Benutzer `stowly`; `/data` und `/data/print` gehören ihm. (A4–A8, F5)
- [ ] **3.** Log ansehen (A9, F2–F4):
  - kein Traceback
  - „Etikett-Vorlagen übernommen"
  - „Druckdienst unter /print bereit"
  - „Schriften der Etiketten:" nennt dreimal eine DejaVu-Datei, nicht „eingebaut"
  - `brother_ql` und `usb` lassen sich importieren
- [ ] **4.** Anmelden per `curl`. Nach `restart` und nach `down`/`up` sind die Daten noch da. Ohne `STOWLY_PUBLISH` ist der Port von außen nicht erreichbar. Im Log steht die Zeile zu Open Food Facts. `docker compose stop` endet in höchstens 15 Sekunden, auch während eine App auf ein Etikett wartet. (A10–A15, F9)

## B. HTTPS davor

- [ ] **5.** Nginx Proxy Manager (B1–B5) oder Tailscale (B6–B8) einrichten. Die Kopfzeile `Content-Security-Policy` kommt unverändert durch (H1). `/print/v1/health` ohne Token antwortet mit 401 (F7).

## C. Handys über die HTTPS-Adresse

- [ ] **6.** Auf Android und iPhone: öffnen ohne Zertifikatswarnung, installieren, anmelden (C1–C4).
  - Android: Der Hinweis „Stowly als App installieren" erscheint einmal; sonst Einstellungen → Diese App → „Stowly installieren". Dort auch die Zeile „Lokaler Speicher" ansehen: Nach der Installation sollte sie „dauerhaft" zeigen.
  - iPhone und iPad: Die Anleitung „Zum Home-Bildschirm" erscheint (auch auf einem iPad, das sich als Mac ausgibt). Danach vom Home-Bildschirm öffnen und dort anmelden.
  - Die Kamera in der Scan-Ansicht erlauben; das Bild erscheint.

## D. Drucker am Server

- [ ] **7.** Einen Drucker „am Server" mit dem Bild-Treiber anlegen, als Standarddrucker wählen, eine Packung einlagern. Erwartet: „gedruckt"; „Etikett ansehen" zeigt das Etikett mit echten Umlauten; das zweite Handy sieht „gedruckt" nach seinem nächsten Abgleich. (F6)
- [ ] **8.** Den Brother anlegen, im Netz oder per USB (`docker-compose.usb.yml`, F12). Nach dem Anlegen steht der Fokus auf „Verbindung prüfen"; erwartet „Der Druckdienst antwortet" und „verbunden, bereit, Etiketten eingelegt".
  - Gegenproben: Drucker aus ergibt „nicht verbunden" (F11), Rolle heraus ergibt „Etiketten leer".
  - Einlagern: „gesendet" (Netz) oder „gedruckt" (USB). Bei USB den Drucker aus- und wieder einschalten: Er druckt danach weiter. (F10, F13, F14)
- [ ] **9.** Zuordnung: Standarddrucker und den Drucker einer Zone umstellen; „Druckt für …" auf den Drucker-Karten stimmt.
- [ ] **10.** Mit „Etiketten" an von Hand und über die Scan-Ansicht einlagern: Das Etikett kommt aus dem Drucker der Zone. Nachdruck über eine Charge („Etikett") und im Packungs-Dialog. Zonen → QR-Code → „Vorschau des Etiketts" → „Etikett drucken".
- [ ] **11.** **Ab hier die beiden Langzeitproben anstoßen:** ein Folienetikett (DK-22212) auf eine Gefrierdose bei −18 °C und ein Papieretikett (DK-22205) ins Regal (V1, V2, F15); das iPhone acht Tage nicht öffnen (C10). Ausgewertet wird in Abschnitt L.
- [ ] **12.** Hängender Druck mit dem Bild-Treiber: `hang` in `simulate.txt` schreiben, einlagern, `docker compose restart`, Datei entfernen (F8).
  - Erwartet: Das Etikett wird „unklar"; es entsteht kein Bild, und nichts druckt von selbst nach.
  - In der App erscheint „Wurde das Etikett gedruckt?"; „Nein" bietet „Erneut drucken" an.
  - Bei mehreren: „Alle gedruckt" oder einzeln beantworten.
  - Die Scan-Ansicht wird von der Nachfrage nicht unterbrochen.

## E. Raspberry Pi

- [ ] **13.** SD-Karte, Zertifikat (S4), `install.sh` zweimal hintereinander, Dienst, Rechte, Journal (`pi/README.md` Abschnitte 1–4, P1–P7).
- [ ] **14.** QL-800 am Pi (Q1–Q6, Q8):
  - „Editor Lite" am Drucker an ergibt `offline`, aus ergibt „bereit".
  - Probedruck: Umlaute stimmen, der QR-Code ist lesbar.
  - Deckel offen, Rolle heraus, Kabel gezogen: Die App nennt jeweils den Grund.
  - Drucker aus und wieder ein: Er druckt, ohne dass der Dienst neu gestartet wird.
- [ ] **15.** Access Point: Android „verbunden bleiben", iPhone, DHCP, WLAN-QR-Code am Kellereingang (R1–R5).
- [ ] **16.** Die Zertifizierungsstelle auf Android und iPhone installieren; `https://10.71.83.1:8443/v1/health` öffnet sich ohne Warnung (S1, S2).

## F. Direktdruck aus der App

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
- [ ] **27.** Zurück im Heim-WLAN: Auf dem zweiten Gerät erscheint der Zustand des Pi mit „zuletzt gesehen" (T7).
- [ ] **28.** Den Pi stromlos machen und wieder einschalten: WLAN und Dienst kommen von selbst; die App sieht eine neue `boot_id` und druckt nichts nach (R6).

## G. Scannen

- [ ] **29.** An iPhone und Android:
  - Ein Etikett aus 15 bis 25 cm: bucht aus, mit Ton (Android auch Vibration) und „Rückgängig".
  - Im Regal aus 50 bis 100 cm: „Näher ran", kein Ton, nichts gebucht. Langsam näher: bucht ab etwa 35 cm.
  - Ein Barcode in der Hand, Etiketten im Hintergrund: Nur das Einlagern geht auf.
  - Ein Zonen-Etikett aus 1 m und aus der Nähe: wechselt die Zone.
  - Greift die Schwelle falsch, den Wert `MIN_LABEL_SIDE_RATIO` (Scan-Kern der App) anpassen lassen.

## H. Offline und Abgleich

- [ ] **30.** Flugmodus, Änderungen auf beiden Handys, ein Konflikt (eines entnimmt, das andere ändert das MHD), Geräteliste, ein Gerät sperren; das Gerät „Prüfung" aus A10 sperren (C5–C9).

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
- [ ] **36.** Das Aussehen der Etiketten mit der Schrift DejaVu (V3). Auf dem Entwicklungsrechner gab es nur die Ersatzschrift:
  - Lange Produktnamen stehen in zwei Zeilen, werden kleiner und enden notfalls mit „…".
  - ID und Einlagerdatum stehen vollständig da. **Bitte melden, falls eines davon mit „…" endet.**
  - Bei sehr langen Markennamen kann die Zeile darunter die Packungsgröße abschneiden („COCA-COLA SERVICES SA/NV ·…"). Stört das, lässt sich die Reihenfolge in dieser Zeile umdrehen.
