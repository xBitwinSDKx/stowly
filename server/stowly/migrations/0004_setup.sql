-- Stowly, Schema-Version 4: Einrichtung (docs/plan-einrichtung.md).
--
-- Einstellungen des Servers aus der App und das Koppeln eines Raspberry Pi
-- (docs/sync-protokoll.md, 11.6 bis 11.8; docs/integrationen.md, Abschnitte 11 und 12). Beide
-- Tabellen stehen nicht im Sync: Kein Gerät erfährt über rev davon. Das Haushalts-Passwort steht,
-- wenn es in der App gesetzt wurde, als Hash in meta (password_hash).

-- Einstellungen des Servers, die auch in der App gehen, und was der Server über sich lernt.
-- Ein Schlüssel je Zeile, der Wert als JSON. Nie ein Geheimnis: Die Tabelle steht in jeder Sicherung.
--   push_contact       Kontakt für die Push-Dienste (STOWLY_PUSH_CONTACT geht vor)
--   update_enabled     Schalter „Nach Updates suchen" (STOWLY_UPDATE_REPO geht vor)
--   setup_steps        je Schritt des Assistenten Zustand und Zeitpunkt
--   setup_finished_at  wann die Einrichtung abgeschlossen wurde
--   tls_addresses      Adressen fürs Zertifikat, je mit Quelle (gelernt, von Hand)
--   https_port         Port, unter dem HTTPS von außen erreichbar ist, mit Quelle
--   http_port          Port, unter dem HTTP von außen erreichbar ist (gelernt)
--   https_seen_at      letzte angemeldete Anfrage über den HTTPS-Listener
--   app_origins_seen   HTTPS-Ursprünge der App, die der Server gesehen hat
CREATE TABLE server_config (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT REFERENCES devices (id)  -- NULL = vom Server selbst gelernt oder gesetzt
) STRICT;

-- Kopplungen eines Raspberry Pi. Der Code steht nur als SHA-256 seiner Normalform hier.
CREATE TABLE pi_pairings (
    id           TEXT PRIMARY KEY,
    code_hash    TEXT NOT NULL UNIQUE,
    origin       TEXT NOT NULL,                     -- Ursprung der App, die den Code erzeugt hat
    printer_id   TEXT REFERENCES printers (id),     -- gewählter oder bei der Kopplung entstandener Drucker
    device_id    TEXT REFERENCES devices (id),      -- Gerät, das den Code erzeugt hat
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    started_at   TEXT,                              -- der Pi hat sich gemeldet (POST /api/pi/pair/start)
    paired_at    TEXT,
    cancelled_at TEXT,
    pi           TEXT,                              -- JSON: hostname, addresses, model, printer_found, version, not_after
    csr_sha256   TEXT,                              -- dieselbe CSR noch einmal bekommt dieselbe Antwort
    result       TEXT                               -- JSON der Antwort an den Pi (ohne Geheimnisse)
) STRICT;

-- Haushalte, die schon Geräte haben, gelten als eingerichtet: Der Assistent drängt sich dort nicht
-- auf, bleibt aber in den Einstellungen erreichbar.
INSERT INTO server_config (key, value, updated_at, updated_by)
SELECT 'setup_finished_at',
       '"' || strftime('%Y-%m-%dT%H:%M:%fZ', 'now') || '"',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       NULL
WHERE EXISTS (SELECT 1 FROM devices);
