-- Stowly, Schema-Version 2.
--
-- Untergrenze der wirksamen Zeitpunkte je Gerät (docs/sync-protokoll.md, Abschnitt 4):
-- Die wirksamen Zeitpunkte eines Geräts laufen nie rückwärts, auch nicht über mehrere
-- Anfragen hinweg. Der Server merkt sich dafür je Gerät den wirksamen Zeitpunkt des
-- letzten gültigen Befehls, den er von ihm verarbeitet hat. NULL = noch keiner.

ALTER TABLE devices ADD COLUMN last_command_at TEXT;

-- Bestehende Datenbanken: der späteste wirksame Zeitpunkt aus den bisher verarbeiteten
-- Befehlen des Geräts. Befehle, die schon an der Form scheiterten, zählen nicht.
UPDATE devices
SET last_command_at = (
    SELECT max(commands.at)
    FROM commands
    WHERE commands.device_id = devices.id
      AND (commands.code IS NULL OR commands.code <> 'invalid')
);
