import { formatTimestamp, type BackupStatus, type ServerConfig } from "@/contract";
import { BackupKeys, KeyCheck } from "@/features/backup/BackupKeys";
import { BackupFolder, BackupRun, BackupSchedule } from "@/features/backup/BackupParts";
import backupStyles from "@/features/backup/Backup.module.css";
import { RestorePanel } from "@/features/backup/RestorePanel";
import { backupWarningText } from "@/features/backup/texts";
import { formatBytes, List, ListRow, Notice, Section, timeAgo, useNow } from "@/ui";
import { Button, Spinner } from "@/ui/base";
import { CloudOffIcon, WarningIcon } from "@/ui/icons";

import type { IntegrationsState } from "./integrations";
import type { LoadedResource } from "./loaded";
import styles from "./SettingsPage.module.css";

export { backupTimeText, backupWarningText } from "@/features/backup/texts";

/** Der Zustand der letzten Läufe: gelungen, Fehler, nächster Versuch, dazu die Warnung nach 48 Stunden. */
function BackupState({ backup }: { backup: BackupStatus }) {
  const now = useNow();
  const warning = backup.warning ? backupWarningText(backup) : null;
  return (
    <>
      {warning ? (
        <Notice tone="danger" icon={<WarningIcon />} title={warning.title} role="alert">
          {warning.text}
        </Notice>
      ) : null}
      {!backup.configured && backup.problem ? (
        <Notice tone="warn" icon={<WarningIcon />} title="Die automatische Sicherung ist aus" role="status">
          {backup.problem}
        </Notice>
      ) : null}
      <List>
        <ListRow
          label="Letzte gelungene"
          hint={
            backup.last_ok_at
              ? [timeAgo(backup.last_ok_at, now), backup.last_size === null ? "" : formatBytes(backup.last_size), backup.last_file ?? ""].filter((part) => part !== "").join(" · ")
              : undefined
          }
        >
          <span className={styles.value}>{backup.last_ok_at ? formatTimestamp(backup.last_ok_at) : "noch keine"}</span>
        </ListRow>
        {backup.last_error ? (
          <ListRow label="Letzter Fehler" hint={backup.last_error}>
            <span className={styles.value}>{backup.last_error_at ? formatTimestamp(backup.last_error_at) : "–"}</span>
          </ListRow>
        ) : null}
        <ListRow label="Nächster Versuch" inline>
          <span className={styles.value}>{backup.configured && backup.next_at ? formatTimestamp(backup.next_at) : "–"}</span>
        </ListRow>
      </List>
    </>
  );
}

export interface BackupSectionProps {
  integrations: IntegrationsState;
  onReload: () => void;
  /** Die Einstellungen des Servers (Schalter, Uhrzeit, Schlüssel, Ordner der Sicherung). */
  serverConfig: LoadedResource<ServerConfig>;
}

/**
 * „Sicherung" (docs/plan-einrichtung-b.md, „Einstellungen"): der Zustand der täglichen,
 * verschlüsselten Sicherung (letzte gelungene, Fehler, nächster Versuch, die Warnung nach 48
 * Stunden), Schalter und Uhrzeit, die Schlüssel samt „Schlüssel erzeugen" und „Schlüssel prüfen",
 * der Ordner, „Jetzt sichern" mit den Sicherungen zum Herunterladen, „Zurückspielen" und sieben Tage
 * lang „Rückgängig". Was aus der Umgebung kommt, ist gesperrt und so beschriftet. Alles braucht den
 * Server; ohne ihn sagt der Abschnitt, was fehlt.
 */
export function BackupSection({ integrations, onReload, serverConfig }: BackupSectionProps) {
  const status = integrations.status === "ready" ? integrations.value : null;
  // Ein Server vor Stufe B kennt die Einstellungen der Sicherung nicht.
  const config = serverConfig.state.status === "ready" ? (serverConfig.state.value.backup ?? null) : null;
  const failed = integrations.status === "error" ? integrations : serverConfig.state.status === "error" ? serverConfig.state : null;

  function saved(next: ServerConfig) {
    serverConfig.set(next);
    onReload();
  }

  return (
    <Section
      title="Sicherung"
      id="sicherung"
      description="Jede Nacht verschlüsselt in einen Ordner auf dem Server. Öffnen lässt sich eine Sicherung nur mit einem geheimen Schlüssel, den nur der Haushalt hat."
    >
      {failed ? (
        <Notice
          tone={failed.offline ? "warn" : "danger"}
          icon={failed.offline ? <CloudOffIcon /> : undefined}
          title="Zustand der Sicherung fehlt"
          role="status"
          action={
            <Button
              size="sm"
              onClick={() => {
                onReload();
                serverConfig.reload();
              }}
            >
              Erneut versuchen
            </Button>
          }
        >
          {failed.message}
        </Notice>
      ) : null}
      {integrations.status === "loading" ? (
        <List>
          <ListRow label={<span className={styles.muted}>Zustand der Sicherung wird geladen …</span>}>
            <Spinner label="Zustand der Sicherung wird geladen" />
          </ListRow>
        </List>
      ) : status ? (
        <BackupState backup={status.backup} />
      ) : null}

      {config ? (
        <>
          <BackupSchedule config={config} timezone={status?.timezone ?? null} onSaved={saved} />
          <h3 className={backupStyles.panelTitle}>Schlüssel</h3>
          <BackupKeys config={config} onSaved={saved} />
          {config.recipients.length > 0 ? (
            <details className={backupStyles.details}>
              <summary>Schlüssel prüfen</summary>
              <p className={backupStyles.small}>Passt der gesicherte geheime Schlüssel? Einfügen oder die Schlüsseldatei wählen; der Browser vergleicht ihn mit den Schlüsseln oben.</p>
              <KeyCheck recipients={config.recipients} />
            </details>
          ) : null}
          <h3 className={backupStyles.panelTitle}>Ordner und Sicherungen</h3>
          <BackupFolder config={config} />
        </>
      ) : null}
      {status ? <BackupRun status={status.backup} onChanged={onReload} /> : null}

      <h3 className={backupStyles.panelTitle}>Zurückspielen</h3>
      <RestorePanel />
    </Section>
  );
}
