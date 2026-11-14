# UI-Entwurf

Beschreibung des Mockups, das der Anwender als Bild geliefert hat. Das Bild selbst liegt nicht im Repository; diese Beschreibung ist die Vorlage für das Design-System. Der Entwurf zeigt eine Desktop-Ansicht, zwei Handy-Ansichten und ein Einstellungs-Panel.

## Gesamteindruck

- Dunkles Thema als Ausgangspunkt, ruhig und flächig, ohne Verläufe.
- Hintergrund fast schwarz mit Blaugrün-Stich. Karten und Tabellen eine Stufe heller, mit feiner, kaum sichtbarer Kontur und leicht gerundeten Ecken.
- Akzentfarbe Mint/Türkis für Navigation, Schaltflächen, Fortschrittsbalken und Symbole.
- Bernstein für „läuft bald ab" (Zahlen und MHD-Werte). Blau als zweite Markierungsfarbe für eine Zone.
- Text hell, Beschriftungen gedämpft grau. Große Zahlen in den Kennzahl-Karten.
- Schlichte Linien-Symbole.

Der Entwurf mischt Englisch und Deutsch. **Die Oberfläche wird durchgehend deutsch.** Ein helles Thema und wählbare Akzentfarben kommen dazu (im Entwurf nur als Umschalter „Dark / Light" angedeutet).

## Desktop

**Seitenleiste links** (schmal, volle Höhe)
- Oben Logo mit Glas-Symbol und Produktname.
- Navigation mit Symbol und Text: Gegenstände (aktiv, hinterlegt), Zonen, Einstellungen, Cookidoo.
- Unten eine umrandete Schaltfläche „Abmelden" und eine Reihe kleiner Symbole (Übersicht, Info, Glocke, Zahnrad).

**Kopfzeile**
- Suchfeld links.
- Rechts eine Pille „Ausstehende MHD-Warnungen" mit Glocken-Symbol und Zähler-Abzeichen, daneben das Profil-Menü.

**Inhalt**
1. Zwei breite Kennzahl-Karten nebeneinander: „Packungen gesamt: 154" und „Läuft bald ab: 8" (Zahl in Bernstein, mit Zusatz in Klammern).
2. Überschrift „Bestand", rechts eine kräftige Schaltfläche „Jetzt scannen" in der Akzentfarbe.
3. Eine Reihe aus vier Zonen-Karten: Name, Symbol rechts (Thermometer, Schneeflocke, Warnzeichen, Ortsmarke), darunter ein Fortschrittsbalken und eine Zeile „Status: 19". Die aktive Karte ist farbig hinterlegt. Eine der Karten ist keine Zone, sondern der Filter „Läuft bald ab".
4. Tabelle der gruppierten Bestandsliste:
   - Spalten: Produkt, Zone, kritischstes MHD, Gesamtmenge, Aktionen. Rechts im Tabellenkopf ein Umschalter „Details".
   - Jede Zeile hat rechts eine umrandete Schaltfläche „Bearbeiten" und eine gefüllte „Löschen".
   - MHD-Werte, die bald ablaufen, stehen in Bernstein.
   - Die ausgewählte Zeile ist mit einer Akzent-Kontur markiert.
5. Aufgeklappte Chargen-Ansicht direkt unter der Zeile: Überschrift „Bestand im Detail: Basmati Reis", rechts „Einklappen". Darin eine kleine Tabelle mit MHD, Menge, Zone – eine Zeile je Kombination aus MHD und Zone (z. B. 25.03. · 2 · Keller, 28.03. · 1 · Keller, 03.03. · 1 · Frostschrank).

## Handy

**Übersicht**
- Suchfeld oben, rechts ein Menü-Symbol.
- Kennzahl-Karten im Raster 2 × 2: Packungen gesamt, Läuft bald ab (Bernstein), Aktive Zonen (Blau).
- Zonen-Karten zweispaltig, gleiche Gestaltung wie am Desktop.
- Darunter die gruppierte Bestandsliste.

**Liste**
- Titel „Bestand", rechts eine kleine Schaltfläche „Jetzt scannen".
- Jedes Produkt als Karte: Name, darunter drei beschriftete Werte (Zone, Menge, kritischstes MHD), rechts „Bearbeiten" und „Löschen".
- Unten mittig ein runder, schwebender Plus-Knopf in der Akzentfarbe (führt zum Scannen).

**Einstellungen**
- Liste aus Zeilen mit Schalter rechts: Etiketten, Druckerstatus, Verbindung (IP/USB, mit Wert), Drucker-Verbindungsstatus, Scanner-Einstellungen, Benachrichtigungen.
- Thema als zweiteiliger Umschalter „Dunkel / Hell".
- Daneben eine Karte „Cookidoo-Rezepte" mit Foto, Titel, Kurztext und „Mehr erfahren".

## Abweichungen in Stufe 1

- **Cookidoo** ist Stufe 3. Navigationseintrag und Rezept-Karte entfallen vorerst.
- **Profil/Abmelden:** Es gibt ein Haushalts-Passwort und benannte Geräte statt Benutzerkonten. Das Menü zeigt den Gerätenamen und „Abmelden".
- **Zonen** verschwinden vollständig aus der Oberfläche, wenn nur eine existiert (Karten, Spalte, Zonenleiste).
- **Scannen** ist im Entwurf nicht ausgearbeitet. Vorgabe aus der Spezifikation: Kamera-Vollbild, oben eine Zonenleiste zum Antippen oder Wischen, Mengen-Vorwahl (Standard 1), schnelle MHD-Eingabe, Rückmeldung per Ton und Vibration, Bedienung mit einer Hand.
- **Zusätzliche Ansichten** ohne Vorlage im Entwurf: Warnungen, Lösch-Historie, Druckerverwaltung mit ausstehenden Etiketten, Sync-Status, Anmeldung. Sie folgen derselben Formensprache.

## Ergänzungen in Stufe 2

- **Einkaufsliste** (`/einkaufsliste`, ohne Vorlage im Entwurf): ein Hauptziel gleich hinter „Bestand", in der Seitenleiste und im Menü am Handy mit der Zahl offener Einträge. Offene Einträge oben, erledigte darunter (einklappbar). Neuer Eintrag mit Produkt (Vorschläge beim Tippen) oder freiem Text, Menge freiwillig. Abhaken über ein Ankreuzfeld, mit „Rückgängig". Automatische Einträge tragen „automatisch" und „fehlt n" und lassen sich nur abhaken oder löschen.
- **Kennzahl-Karte „Einkaufsliste"** auf dem Bestand: am Desktop die dritte Karte der Reihe; am Handy steht sie im Raster 2 × 2 an der Stelle von „Produkte". Mit nur einer Zone fehlt „Aktive Zonen", dann stehen beide da.
- **Mindestbestand:** In der Bestandsliste trägt ein Produkt darunter die Marke „fehlt n" in Blau (Bernstein heißt „läuft bald ab"). Produkte mit Mindestbestand ohne Packung bleiben als Zeile mit Menge 0 stehen. Ein Umschalter „Unter Mindestbestand" über der Liste filtert, statt einer sechsten Zonen-Karte.
- **Chargen-Ansicht:** im Kopf „Auf die Einkaufsliste" oder der Verweis „Steht auf der Einkaufsliste", dazu die Marke „als Nächstes" an der Charge, die nach FIFO zuerst dran ist.
- **Statistik** (`/statistik`, ohne Vorlage im Entwurf): bei den weiteren Bereichen neben der Lösch-Historie. Oben Kennzahlen (verbraucht, entsorgt, Anteil entsorgt), darunter Säulen je Monat als schlichtes SVG: verbraucht gefüllt in der Akzentfarbe, entsorgt rot und schräg gestreift, damit beide auch ohne Farbe zu unterscheiden sind. Dazu die am häufigsten entsorgten Produkte und eine Tabelle je Zone. Zeitraum 12 oder 24 Monate. Für Screenreader eine Beschreibung des Bilds und dieselben Zahlen als Tabelle. Ohne Verbindung sagt die Ansicht, warum sie fehlt; eine schon geladene bleibt mit ihrem Stand stehen.
- **Einstellungen:** Abschnitt „Home Assistant und Bring!" nach „Sicherung", mit einem Satz je Zustand des Abgleichs und einem Hinweis darüber bei Störungen (rot, wo am Server etwas zu ändern ist, sonst Bernstein). Im „Haushalt" die Uhrzeit der Tagesnachricht, als Feld für eine Uhrzeit, mit der Zeitzone des Servers, wenn sie von der des Geräts abweicht.
- **Dialoge, die arbeiten** (`Dialog` mit `busy`): Das ✕ bleibt an seinem Platz, ist aber erkennbar gesperrt und sagt, dass Schließen gleich wieder geht; Escape und Tippen daneben tun nichts.
