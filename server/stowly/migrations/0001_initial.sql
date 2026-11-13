-- Stowly: Datenbankschema für die gesamte Stufe 1.
--
-- Diese Datei ist Teil des Vertrags (docs/sync-protokoll.md, Abschnitt „Datenbankschema").
-- Sie wird nicht mehr geändert; Ergänzungen kommen als 0002_*.sql.
--
-- Konventionen
--   Zeitstempel  TEXT, UTC, ISO 8601 mit Millisekunden und "Z" ("2026-11-13T10:15:30.123Z"),
--                als Text vergleich- und sortierbar.
--   Datum (MHD)  TEXT "YYYY-MM-DD".
--   rev          Stand der Änderungsfolge beim letzten Schreiben der Zeile. Jeder Schreibvorgang
--                an einer synchronisierten Zeile holt sich einen neuen Wert aus counters('rev').
--                Der Sync liefert alle Zeilen mit rev > cursor.
--   Löschen      Synchronisierte Zeilen werden nie physisch gelöscht, nur markiert
--                (deleted_at, removed_at). Eine vergebene Packungs-ID wird nie wiederverwendet.

-- Einzelwerte des Servers: dataset_id, ...
CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT;

-- Zähler: 'rev' (Änderungsfolge), 'settings_rev' (rev der Haushalts-Einstellungen)
CREATE TABLE counters (
    name  TEXT PRIMARY KEY,
    value INTEGER NOT NULL
) STRICT;

-- Angemeldete Geräte. Das Token selbst wird nie gespeichert, nur sein SHA-256 (hex).
CREATE TABLE devices (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    created_at   TEXT NOT NULL,
    last_seen_at TEXT,
    revoked_at   TEXT
) STRICT;

CREATE TABLE zones (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    icon       TEXT NOT NULL DEFAULT 'box',
    color      TEXT,
    sort       INTEGER NOT NULL DEFAULT 0,
    printer_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    moved_to   TEXT,
    rev        INTEGER NOT NULL
) STRICT;
CREATE INDEX zones_rev ON zones (rev);

CREATE TABLE products (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT '',
    brand       TEXT NOT NULL DEFAULT '',
    quantity    TEXT NOT NULL DEFAULT '',
    image       TEXT,
    warn_days   INTEGER,
    lookup      TEXT NOT NULL DEFAULT 'none'
                CHECK (lookup IN ('none', 'pending', 'found', 'not_found')),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT,
    merged_into TEXT,
    rev         INTEGER NOT NULL
) STRICT;
CREATE INDEX products_rev ON products (rev);

-- Ein Barcode gehört zu genau einem Produkt, ein Produkt kann mehrere haben.
CREATE TABLE product_barcodes (
    barcode    TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products (id),
    created_at TEXT NOT NULL
) STRICT;
CREATE INDEX product_barcodes_product ON product_barcodes (product_id);

-- Jede Packung ist ein eigener Datensatz. id = 5 Zeichen, steht auf dem Etikett.
CREATE TABLE packages (
    id             TEXT PRIMARY KEY,
    product_id     TEXT NOT NULL REFERENCES products (id),
    zone_id        TEXT NOT NULL REFERENCES zones (id),
    best_before    TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    removed_at     TEXT,
    removal_reason TEXT CHECK (removal_reason IN ('consumed', 'discarded', 'mistake')),
    displaced      TEXT,  -- JSON {"at": ..., "changes": [{"field": ..., "value": ...}]} oder NULL
    created_by     TEXT,  -- Gerät, das eingelagert hat
    rev            INTEGER NOT NULL
) STRICT;
CREATE INDEX packages_rev ON packages (rev);
CREATE INDEX packages_product ON packages (product_id);
CREATE INDEX packages_zone ON packages (zone_id);
CREATE INDEX packages_removed ON packages (removed_at);

-- Uhren für „der spätere Zeitstempel gewinnt": je Datensatz und Feld der Zeitpunkt
-- (Serverzeit) der zuletzt angewendeten Änderung.
--   entity     'product' | 'package' | 'zone' | 'settings' | 'printer' | 'print_job'
--   entity_id  Kennung des Datensatzes; bei 'settings' immer 'household'
--   field      Feldname; bei 'package' zusätzlich 'removed' für Entnehmen/Wiederherstellen
CREATE TABLE field_clocks (
    entity    TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    field     TEXT NOT NULL,
    at        TEXT NOT NULL,
    PRIMARY KEY (entity, entity_id, field)
) STRICT, WITHOUT ROWID;

-- Haushalts-Einstellungen, ein Schlüssel je Zeile, Wert als JSON.
CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

-- Jeder verarbeitete Befehl mit seinem Ergebnis: Grundlage für „höchstens einmal".
CREATE TABLE commands (
    id          TEXT PRIMARY KEY,
    device_id   TEXT NOT NULL,
    type        TEXT NOT NULL,
    at          TEXT NOT NULL,  -- wirksamer Zeitpunkt (Serverzeit)
    received_at TEXT NOT NULL,
    body        TEXT NOT NULL,  -- der Befehl als JSON, wie empfangen
    status      TEXT NOT NULL CHECK (status IN ('applied', 'displaced', 'rejected')),
    code        TEXT,
    message     TEXT
) STRICT;
CREATE INDEX commands_received ON commands (received_at);

-- Ereignisprotokoll: was wann durch welches Gerät geschah, mit Entnahmegrund und
-- überschriebenen Werten. Wird nie gekürzt; Grundlage der Statistik in Stufe 2.
CREATE TABLE events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    device_id   TEXT,
    command_id  TEXT,
    type        TEXT NOT NULL,
    entity      TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    data        TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE INDEX events_entity ON events (entity, entity_id, id);
CREATE INDEX events_type ON events (type, id);

-- ID-Vorrat: für ein Gerät reservierte, noch nicht benutzte Packungs-IDs.
-- Die Zeile verschwindet, sobald eine Packung mit dieser ID angelegt ist.
CREATE TABLE id_reservations (
    package_id TEXT PRIMARY KEY,
    device_id  TEXT NOT NULL,
    granted_at TEXT NOT NULL
) STRICT;
CREATE INDEX id_reservations_device ON id_reservations (device_id);

-- Open Food Facts: Warteschlange und dauerhafter Zwischenspeicher je Barcode.
-- Bewusst getrennt von products, damit die Daten trennbar bleiben (ODbL).
CREATE TABLE off_lookups (
    barcode         TEXT PRIMARY KEY,
    state           TEXT NOT NULL CHECK (state IN ('pending', 'found', 'not_found')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    fetched_at      TEXT,
    name            TEXT,
    brand           TEXT,
    quantity        TEXT,
    image_url       TEXT,
    raw             TEXT
) STRICT;
CREATE INDEX off_lookups_due ON off_lookups (state, next_attempt_at);

-- Produktbilder. id = SHA-256 des Inhalts (hex, 32 Zeichen) + Dateiendung.
CREATE TABLE images (
    id           TEXT PRIMARY KEY,
    content_type TEXT NOT NULL,
    data         BLOB NOT NULL,
    source       TEXT NOT NULL,
    source_url   TEXT,
    created_at   TEXT NOT NULL
) STRICT;

CREATE TABLE printers (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    connection TEXT NOT NULL CHECK (connection IN ('server', 'direct')),
    config     TEXT NOT NULL,  -- JSON: ServerPrinterConfig oder DirectPrinterConfig
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    rev        INTEGER NOT NULL
) STRICT;
CREATE INDEX printers_rev ON printers (rev);

-- Zuletzt gesehener Zustand je Drucker.
CREATE TABLE printer_status (
    printer_id  TEXT PRIMARY KEY,
    observed_at TEXT NOT NULL,
    device_id   TEXT,          -- NULL = der Server selbst hat beobachtet
    boot_id     TEXT,
    status      TEXT,          -- JSON DriverStatus oder NULL
    host        TEXT,          -- JSON HostHealth oder NULL
    rev         INTEGER NOT NULL
) STRICT;
CREATE INDEX printer_status_rev ON printer_status (rev);

-- Etiketten des Haushalts. id ist zugleich die Auftragskennung beim Druckdienst.
CREATE TABLE print_jobs (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL CHECK (kind IN ('package', 'zone')),
    package_id TEXT,
    zone_id    TEXT,
    printer_id TEXT,
    state      TEXT NOT NULL CHECK (state IN
               ('pending', 'queued', 'printing', 'printed', 'sent', 'failed', 'unknown', 'cancelled')),
    error      TEXT,
    boot_id    TEXT,
    device_id  TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    rev        INTEGER NOT NULL
) STRICT;
CREATE INDEX print_jobs_rev ON print_jobs (rev);
CREATE INDEX print_jobs_package ON print_jobs (package_id);

-- Etikett-Vorlagen, beim Start aus stowly_print.templates übernommen.
CREATE TABLE label_templates (
    key        TEXT PRIMARY KEY CHECK (key IN ('package', 'zone')),
    hash       TEXT NOT NULL,
    body       TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    rev        INTEGER NOT NULL
) STRICT;
