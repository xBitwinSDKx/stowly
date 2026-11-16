import { useState } from "react";

import { formatTimestamp, useCore, type HaConfig, type SetupStatus } from "@/contract";
import { insecureNetwork } from "@/features/backup/texts";
import { ConfirmDialog, errorText, List, ListRow, Notice } from "@/ui";
import { Button, useToast } from "@/ui/base";
import { CopyField } from "@/ui/CopyField";
import { KeyIcon, LockOpenIcon, RefreshIcon, TrashIcon } from "@/ui/icons";

import { haSnippet, usesOwnCa } from "./haSnippet";
import styles from "./SettingsPage.module.css";

const OFFLINE = "Dafür braucht es den Server, und der ist gerade nicht erreichbar.";

export interface HaSensorFormProps {
  config: HaConfig;
  /** Der Stand der Einrichtung (HTTPS, eigene CA); null, solange er fehlt. */
  setup: SetupStatus | null;
  /** Der Sensor-Token hat sich geändert: die Einrichtung neu laden. */
  onChanged: () => void;
}

/**
 * Der Sensor für Home Assistant (docs/betrieb.md, 18): „Sensor-Token erzeugen" und das fertige YAML
 * zum Kopieren (`haSnippet`), für die Adresse dieser App. Ein Token aus der Umgebung
 * (STOWLY_HA_SUMMARY_TOKEN) kennt die App nicht: Im YAML steht dann ein Platzhalter.
 */
export function HaSensorForm({ config, setup, onChanged }: HaSensorFormProps) {
  const core = useCore();
  const toast = useToast();
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renewing, setRenewing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const sensor = config.sensor;
  const env = sensor.source === "env";
  const ownCa = usesOwnCa(window.location, setup?.https ?? null);

  async function create() {
    const next = await core.haConfig.createSensorToken();
    setToken(next);
    setRenewing(false);
    onChanged();
    toast.show({ message: "Sensor-Token erzeugt. Jetzt das YAML in Home Assistant übernehmen.", tone: "success" });
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(errorText(caught, { offline: OFFLINE, not_found: "Es gibt noch keinen Sensor-Token." }));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    await core.haConfig.deleteSensorToken();
    setToken(null);
    setRemoving(false);
    onChanged();
  }

  const snippet = env || token !== null ? haSnippet({ origin: window.location.origin, token: env ? null : token, ownCa }) : null;

  return (
    <div className={styles.push}>
      <List>
        <ListRow
          label="Sensor-Token"
          hint={
            env
              ? "Kommt aus der Umgebung (STOWLY_HA_SUMMARY_TOKEN) und ist nur dort änderbar."
              : sensor.set
                ? `Erzeugt am ${sensor.set_at ? formatTimestamp(sensor.set_at) : "–"}. Er gilt nur für die Zusammenfassung, nirgends sonst.`
                : sensor.source === "app"
                  ? "Er fehlt (steht in keiner Sicherung): bitte neu erzeugen und in Home Assistant eintragen."
                  : "Home Assistant liest damit eine Zusammenfassung: bald fällig, abgelaufen, Einkaufsliste, Bestand."
          }
        >
          {env ? (
            <span className={styles.value}>gesetzt</span>
          ) : sensor.set ? (
            <div className={styles.pushActions}>
              {token === null ? (
                <Button size="sm" icon={<KeyIcon />} busy={busy} onClick={() => void run(async () => setToken(await core.haConfig.sensorToken()))}>
                  YAML zeigen
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" icon={<RefreshIcon />} disabled={busy} onClick={() => setRenewing(true)}>
                Neu erzeugen
              </Button>
              <Button size="sm" variant="ghost" icon={<TrashIcon />} disabled={busy} onClick={() => setRemoving(true)}>
                Entfernen
              </Button>
            </div>
          ) : (
            <Button icon={<KeyIcon />} busy={busy} onClick={() => void run(create)}>
              Sensor-Token erzeugen
            </Button>
          )}
        </ListRow>
      </List>
      {error ? (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      ) : null}
      {snippet ? (
        <>
          <p className={styles.muted}>
            In Home Assistant: den ersten Block in die <code>secrets.yaml</code>, den zweiten in die <code>configuration.yaml</code>, dann HA neu starten.
            {env ? " Den Platzhalter durch den Token aus STOWLY_HA_SUMMARY_TOKEN ersetzen." : ""}
          </p>
          {ownCa ? (
            <Notice tone="info" icon={<LockOpenIcon />}>
              Stowly läuft hier mit seiner eigenen Zertifizierungsstelle, die Home Assistant nicht kennt. Deshalb steht <code>verify_ssl: false</code> dabei: verschlüsselt, aber
              ohne Prüfung des Zertifikats.
            </Notice>
          ) : null}
          {insecureNetwork(window.location) ? (
            <Notice tone="warn" icon={<LockOpenIcon />}>
              Diese Seite läuft über http: Home Assistant läse den Sensor unverschlüsselt. Über die HTTPS-Adresse von Stowly geöffnet, steht hier die passende Adresse.
            </Notice>
          ) : null}
          <CopyField value={snippet.secrets} label="secrets.yaml für Home Assistant" />
          <CopyField value={snippet.configuration} label="configuration.yaml für Home Assistant" />
        </>
      ) : null}
      <ConfirmDialog
        open={renewing}
        onClose={() => setRenewing(false)}
        title="Neuen Sensor-Token erzeugen?"
        confirmLabel="Neu erzeugen"
        onConfirm={create}
        errorText={(caught) => errorText(caught, { offline: OFFLINE })}
      >
        <p>Der bisherige gilt dann nicht mehr: Home Assistant braucht den neuen in der secrets.yaml.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={removing}
        onClose={() => setRemoving(false)}
        title="Sensor-Token entfernen?"
        confirmLabel="Entfernen"
        tone="danger"
        onConfirm={remove}
        errorText={(caught) => errorText(caught, { offline: OFFLINE })}
      >
        <p>Danach liest Home Assistant keine Zusammenfassung mehr; der Sensor meldet einen Fehler.</p>
      </ConfirmDialog>
    </div>
  );
}
