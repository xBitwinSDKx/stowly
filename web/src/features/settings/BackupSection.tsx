import { useState } from "react";

import { formatTimestamp, useCore, type BackupStatus } from "@/contract";
import { errorText, formatBytes, List, ListRow, Notice, Section, timeAgo, useNow } from "@/ui";
import { Badge, Button, Spinner, useToast } from "@/ui/base";
import { CloudOffIcon, DownloadIcon, WarningIcon } from "@/ui/icons";

import { deviceTimeZone, type IntegrationsState } from "./integrations";
import styles from "./SettingsPage.module.css";

/** Speichert eine Datei, die der Kern als Blob liefert. */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Der Download hat die Adresse zu diesem Zeitpunkt sicher übernommen.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Die Uhrzeit der Sicherung gilt in der Zeitzone des Servers. Weicht die des Geräts ab, steht sie
 * dabei (docs/integrationen.md, Abschnitt 2).
 */
export function backupTimeText(time: string, serverZone: string, deviceZone: string = deviceTimeZone()): string {
  return serverZone !== "" && deviceZone !== "" && serverZone !== deviceZone ? `täglich um ${time} (Zeit des Servers, ${serverZone})` : `täglich um ${time}`;
}

/** Die Warnung nach 48 Stunden (docs/integrationen.md, 3.6), in Worten. */
export function backupWarningText(backup: Pick<BackupStatus, "last_ok_at">): { title: string; text: string } {
  return backup.last_ok_at === null
    ? {
        title: "Noch keine Sicherung gelungen",
        text: "Der letzte Versuch ist gescheitert. Bitte auf dem Server nachsehen (Ordner, Rechte, Platz); bis dahin hilft die Kopie zum Herunterladen.",
      }
    : {
        title: "Seit mehr als 48 Stunden keine Sicherung",
        text: "Die letzte gelungene Sicherung ist älter als zwei Tage. Bitte auf dem Server nachsehen (Ordner, Rechte, Platz); bis dahin hilft die Kopie zum Herunterladen.",
      };
}

function AutomaticBackup({ backup, timezone }: { backup: BackupStatus; timezone: string }) {
  const now = useNow();
  if (!backup.configured) {
    return (
      <>
        {backup.problem ? (
          <Notice tone="warn" icon={<WarningIcon />} title="Die automatische Sicherung ist aus" role="status">
            {backup.problem}
          </Notice>
        ) : null}
        <List>
          <ListRow
            label="Automatische Sicherung"
            hint="Nicht eingerichtet. Wer den Server betreibt, richtet sie mit STOWLY_BACKUP_DIR und STOWLY_BACKUP_RECIPIENTS ein (docs/betrieb.md)."
            inline
          >
            <span className={styles.value}>aus</span>
          </ListRow>
        </List>
      </>
    );
  }

  const warning = backup.warning ? backupWarningText(backup) : null;
  return (
    <>
      {warning ? (
        <Notice tone="danger" icon={<WarningIcon />} title={warning.title} role="alert">
          {warning.text}
        </Notice>
      ) : null}
      <List>
        <ListRow label="Automatische Sicherung" hint="Verschlüsselt in einen Ordner auf dem Server; lesen kann sie nur, wer einen der privaten Schlüssel hat.">
          <span className={styles.value}>{backup.time ? backupTimeText(backup.time, timezone) : "eingerichtet"}</span>
        </ListRow>
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
          <span className={styles.value}>{backup.next_at ? formatTimestamp(backup.next_at) : "–"}</span>
        </ListRow>
        <ListRow label="Schlüssel" hint="Nur öffentliche, gekürzt. Wer Server oder Ordner erbeutet, kann die Sicherungen damit nicht lesen.">
          {backup.recipients.length === 0 ? (
            <span className={styles.value}>–</span>
          ) : (
            <ul className={styles.keys} aria-label="Öffentliche Schlüssel">
              {backup.recipients.map((recipient) => (
                <li key={recipient}>
                  <Badge className={styles.key}>{recipient}</Badge>
                </li>
              ))}
            </ul>
          )}
        </ListRow>
      </List>
    </>
  );
}

/**
 * „Sicherung": der Zustand der automatischen, verschlüsselten Sicherung auf dem Server (eingerichtet
 * oder nicht, letzte gelungene, Fehler, nächster Versuch, die Warnung nach 48 Stunden) und daneben
 * die Kopie der Datenbank zum Herunterladen. Beides braucht den Server; offline sagt der Abschnitt,
 * dass der Zustand fehlt.
 */
export function BackupSection({ integrations, onReload }: { integrations: IntegrationsState; onReload: () => void }) {
  const core = useCore();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const { blob, filename } = await core.backup.download();
      saveBlob(blob, filename);
      toast.show({ message: `Sicherung heruntergeladen: ${filename}`, tone: "success" });
    } catch (caught) {
      setError(errorText(caught, { offline: "Die Sicherung kommt vom Server, und der ist gerade nicht erreichbar." }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Sicherung" id="sicherung" description="Täglich automatisch und verschlüsselt auf dem Server, dazu jederzeit als Datei. Beides braucht den Server.">
      {integrations.status === "loading" ? (
        <List>
          <ListRow label={<span className={styles.muted}>Zustand der Sicherung wird geladen …</span>}>
            <Spinner label="Zustand der Sicherung wird geladen" />
          </ListRow>
        </List>
      ) : integrations.status === "error" ? (
        <Notice
          tone={integrations.offline ? "warn" : "danger"}
          icon={integrations.offline ? <CloudOffIcon /> : undefined}
          title="Zustand der automatischen Sicherung fehlt"
          role="status"
          action={
            <Button size="sm" onClick={onReload}>
              Erneut versuchen
            </Button>
          }
        >
          {integrations.message}
        </Notice>
      ) : (
        <AutomaticBackup backup={integrations.value.backup} timezone={integrations.value.timezone} />
      )}

      <List>
        <ListRow label="Kopie der Datenbank" hint="Enthält den gesamten Bestand, alle Einstellungen und das Ereignisprotokoll.">
          <Button icon={<DownloadIcon />} busy={busy} onClick={() => void download()}>
            Herunterladen
          </Button>
        </ListRow>
      </List>
      {error ? (
        <Notice tone="warn" role="alert">
          {error}
        </Notice>
      ) : null}
    </Section>
  );
}
