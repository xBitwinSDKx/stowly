-- Stowly, Schema-Version 3 (Stufe 2).
--
-- Mindestbestand und Einkaufsliste (docs/sync-protokoll.md, 3.1, 3.6 und 7.6), Push, Sicherung,
-- Home Assistant und der Zeitplan (docs/integrationen.md), die Einstellung notify_time.
--
-- Spalten, die nicht im Sync stehen, sind als solche vermerkt: Wer sie schreibt, stellt keinen
-- neuen rev, denn kein Gerät muss davon erfahren.

-- Mindestbestand je Produkt in Packungen; NULL = keiner. Eigene Feld-Uhr in field_clocks
-- (Feld 'min_stock'), wie jedes änderbare Feld.
ALTER TABLE products ADD COLUMN min_stock INTEGER CHECK (min_stock IS NULL OR min_stock >= 1);

-- Nicht im Sync: Sperre der automatischen Einträge des Produkts (Protokoll 7.6). Wirksamer
-- Zeitpunkt, zu dem ein Anwender den automatischen Eintrag abgehakt oder gelöscht hat;
-- NULL = keine Sperre.
ALTER TABLE products ADD COLUMN shopping_lock_at TEXT;

-- Einkaufsliste. Synchronisiert wie Packungen (rev); gelöscht wird nie physisch.
CREATE TABLE shopping_items (
    id         TEXT PRIMARY KEY,
    product_id TEXT REFERENCES products (id),  -- NULL = freier Text; folgt Zusammenführungen
    text       TEXT NOT NULL DEFAULT '',       -- leer bei Einträgen mit Produkt
    quantity   INTEGER CHECK (quantity IS NULL OR quantity >= 1),
    origin     TEXT NOT NULL CHECK (origin IN ('manual', 'min_stock')),
    done_at    TEXT,
    deleted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    -- Nicht im Sync: wodurch der Eintrag zuletzt geschlossen wurde (erledigt oder gelöscht),
    -- NULL solange er offen ist. Daran entscheidet der Abgleich mit Bring!, ob er dort abhakt
    -- oder entfernt (docs/integrationen.md, 5.5).
    --   device  ein Gerät hat abgehakt oder gelöscht
    --   store   eigener Eintrag, erledigt durch Einlagern des Produkts
    --   stock   automatischer Eintrag, der Bestand reicht wieder (oder kein Mindestbestand mehr)
    --   merge   automatischer Eintrag, mit einem anderen desselben Produkts zusammengelegt
    --   bring   in Bring! abgehakt oder gelöscht
    closed_by  TEXT CHECK (closed_by IN ('device', 'store', 'stock', 'merge', 'bring')),
    -- Nicht im Sync: der Artikel in Bring!, an den der Eintrag gebunden ist (ha_links.name_key);
    -- NULL = noch nicht gespiegelt. Bleibt bei Umbenennungen, wie er ist.
    bring_key  TEXT,
    rev        INTEGER NOT NULL,
    CHECK ((product_id IS NULL) <> (text = '')),
    CHECK (origin = 'manual' OR product_id IS NOT NULL),
    CHECK ((closed_by IS NULL) = (done_at IS NULL AND deleted_at IS NULL))
) STRICT;
CREATE INDEX shopping_items_rev ON shopping_items (rev);
CREATE INDEX shopping_items_product ON shopping_items (product_id);

-- Push-Abos, höchstens eines je Gerät. Es endet mit der Abmeldung des Geräts.
CREATE TABLE push_subscriptions (
    device_id     TEXT PRIMARY KEY REFERENCES devices (id),
    endpoint      TEXT NOT NULL UNIQUE,  -- https-Adresse beim Push-Dienst
    p256dh        TEXT NOT NULL,         -- öffentlicher Schlüssel des Browsers, base64url
    auth          TEXT NOT NULL,         -- Geheimnis des Abos, base64url
    origin        TEXT NOT NULL,         -- Ursprung der App: daraus die Adresse in der Nachricht
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    last_ok_at    TEXT,                  -- letzte Nachricht, die der Push-Dienst angenommen hat
    last_error    TEXT,                  -- letzter Fehler; NULL nach einem Erfolg
    last_error_at TEXT
) STRICT;

-- Tagesnachricht „nur Neues": je Packung und Stufe, wann sie in einer Nachricht stand. Jede
-- Packung steht so höchstens zweimal in einer Nachricht (docs/integrationen.md, 4.8).
CREATE TABLE push_notices (
    package_id TEXT NOT NULL REFERENCES packages (id),
    state      TEXT NOT NULL CHECK (state IN ('soon', 'expired')),
    sent_at    TEXT NOT NULL,
    PRIMARY KEY (package_id, state)
) STRICT, WITHOUT ROWID;

-- Home Assistant und Bring!: je Artikel der To-do-Liste, den Stowly kennt, was es zuletzt
-- geschrieben und gesehen hat (docs/integrationen.md, 5.3). Der Token von HA steht nie hier.
CREATE TABLE ha_links (
    name_key    TEXT PRIMARY KEY,   -- Vergleichsform des Namens: ein Artikel je Name
    name        TEXT NOT NULL,      -- der Name, wie er in der Liste steht
    uid         TEXT,               -- Kennung des Artikels in HA (todo.get_items); NULL = noch nicht gesehen
    own         INTEGER NOT NULL CHECK (own IN (0, 1)),  -- 1 = von Stowly angelegt; 0 = gab es schon: nur lesen
    description TEXT,               -- zuletzt geschriebene Beschreibung; NULL = nie geschrieben
    status      TEXT NOT NULL CHECK (status IN ('needs_action', 'completed', 'removed')),
    written_at  TEXT,               -- zuletzt von Stowly geschrieben
    seen_at     TEXT,               -- zuletzt in der Liste gesehen
    misses      INTEGER NOT NULL DEFAULT 0  -- Abgleiche in Folge ohne ihn, bei erreichbarem HA und verfügbarer Liste
) STRICT;

-- Zeitplan: je Aufgabe der letzte Lauf (docs/integrationen.md, Abschnitt 1).
CREATE TABLE job_runs (
    job           TEXT PRIMARY KEY,           -- 'backup', 'push_daily'
    last_date     TEXT,                       -- lokaler Tag (STOWLY_TIMEZONE) des letzten Laufs, "YYYY-MM-DD"
    last_at       TEXT,                       -- Zeitpunkt (UTC) des letzten Laufs
    last_error    TEXT,                       -- Fehler des letzten Versuchs; NULL nach einem Erfolg
    last_error_at TEXT,
    state         TEXT NOT NULL DEFAULT '{}'  -- JSON je Aufgabe (docs/integrationen.md)
) STRICT;

-- Neue Einstellung des Haushalts: Uhrzeit der täglichen Push-Nachricht. Nur in einer Datenbank,
-- die schon Einstellungen hat; eine neue stattet db.seed_defaults vollständig aus. updated_at
-- bleibt der bisherige Stand: Geändert hat niemand etwas.
INSERT INTO settings (key, value, updated_at)
SELECT 'notify_time', '"17:00"', (SELECT max(updated_at) FROM settings)
WHERE EXISTS (SELECT 1 FROM settings)
  AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'notify_time');
