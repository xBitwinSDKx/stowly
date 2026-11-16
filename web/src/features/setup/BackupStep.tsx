import { useCore } from "@/contract";
import { BackupKeys, KeyCheck } from "@/features/backup/BackupKeys";
import { BackupFolder, BackupRun, BackupSchedule } from "@/features/backup/BackupParts";
import backupStyles from "@/features/backup/Backup.module.css";
import { useIntegrations } from "@/features/settings/integrations";
import { loadedValue, useLoaded } from "@/features/settings/loaded";
import { Notice } from "@/ui";
import { Spinner } from "@/ui/base";
import { CircleCheckIcon, CloudOffIcon, WarningIcon } from "@/ui/icons";

import styles from "./SetupPage.module.css";
import { SETUP_OFFLINE } from "./useSetup";

/**
 * „Sicherung" (docs/plan-einrichtung-b.md, „So sieht es für dich aus"): erst der Schlüssel (das Paar
 * entsteht im Browser, der geheime Teil wird gesichert, erst dann geht der öffentliche an Stowly),
 * dann Uhrzeit und Schalter, der Ordner mit Anleitung, „Jetzt sichern" als Probe und „Schlüssel
 * prüfen". Erledigt ist der Schritt, sobald die Sicherung wirksam ist und eine gelungen ist.
 */
export function BackupStep({ onChanged }: { onChanged: () => void }) {
  const core = useCore();
  const serverConfig = useLoaded(() => core.serverConfig.load(), SETUP_OFFLINE);
  const integrations = useIntegrations();
  const config = loadedValue(serverConfig.state);
  const backup = config?.backup ?? null;
  const status = integrations.state.status === "ready" ? integrations.state.value : null;
  const failed = serverConfig.state.status === "error" ? serverConfig.state : integrations.state.status === "error" ? integrations.state : null;

  function changed() {
    integrations.reload();
    onChanged();
  }

  return (
    <>
      <p className={styles.lead}>
        Stowly sichert den Bestand jede Nacht verschlüsselt in einen Ordner auf dem Server. Öffnen lässt sich eine Sicherung nur mit einem geheimen Schlüssel, den der Haushalt
        aufhebt.
      </p>
      {failed ? (
        <Notice tone={failed.offline ? "warn" : "danger"} icon={failed.offline ? <CloudOffIcon /> : <WarningIcon />} role="status">
          {failed.message}
        </Notice>
      ) : null}
      {config && backup === null ? (
        <Notice tone="info" role="status">
          Dieser Server kennt die Sicherung aus der App noch nicht. Erst Stowly aktualisieren.
        </Notice>
      ) : null}
      {backup ? (
        <>
          <section className={styles.block}>
            <h3 className={styles.subtitle}>1. Schlüssel</h3>
            <BackupKeys
              config={backup}
              variant="wizard"
              onSaved={(saved) => {
                serverConfig.set(saved);
                changed();
              }}
            />
          </section>
          <section className={styles.block}>
            <h3 className={styles.subtitle}>2. Wann</h3>
            <BackupSchedule
              config={backup}
              timezone={status?.timezone ?? null}
              onSaved={(saved) => {
                serverConfig.set(saved);
                changed();
              }}
            />
          </section>
          <section className={styles.block}>
            <h3 className={styles.subtitle}>3. Wohin</h3>
            <BackupFolder config={backup} />
          </section>
          <section className={styles.block}>
            <h3 className={styles.subtitle}>4. Probe</h3>
            {status?.backup.configured && status.backup.last_ok_at ? (
              <Notice tone="success" icon={<CircleCheckIcon />} role="status">
                Die Sicherung ist eingerichtet, und die letzte ist gelungen.
              </Notice>
            ) : (
              <p className={backupStyles.small}>Einmal „Jetzt sichern“: Dann liegt die erste Sicherung im Ordner, und der Schritt ist erledigt.</p>
            )}
            <BackupRun status={status?.backup ?? null} onChanged={changed} shown={2} />
            {backup.recipients.length > 0 ? (
              <details className={backupStyles.details}>
                <summary>Schlüssel prüfen</summary>
                <p className={backupStyles.small}>Den gesicherten geheimen Schlüssel einfügen oder die Schlüsseldatei wählen: Der Browser sagt, ob er passt.</p>
                <KeyCheck recipients={backup.recipients} />
              </details>
            ) : null}
          </section>
        </>
      ) : failed ? null : (
        <p className={styles.actions}>
          <Spinner size={18} label="Einstellungen werden geladen" />
        </p>
      )}
    </>
  );
}
