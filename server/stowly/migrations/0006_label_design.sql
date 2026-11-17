-- Stowly, Schema-Version 6: Etiketten gestalten (docs/plan-0.5.md, 1).
--
-- Die Gestaltung des Haushalts: ein Papier für alle Drucker, je eine Gestaltung für Packungs- und
-- Zonen-Etiketten. Höchstens eine Zeile; ohne Zeile gelten die mitgelieferten Vorlagen. Die Tabelle
-- gehört nur dem Server: Kein Gerät erfährt über rev davon, die Geräte bekommen die daraus erzeugten
-- Vorlagen über label_templates. Sie steht in jeder Sicherung und kommt beim Zurückspielen mit.
CREATE TABLE label_design (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    body       TEXT NOT NULL,  -- LabelDesign als JSON: paper, package, zone
    updated_at TEXT NOT NULL,
    updated_by TEXT            -- Gerät, das gespeichert hat; kein Fremdschlüssel: Ein Zurückspielen
                               -- behält die Geräte der laufenden Datenbank, die Gestaltung kommt mit
) STRICT;
