import { useEffect, useState } from "react";

import { formatTimestamp, isCoreError, isTimeOfDay, useCore, type BackupConfig, type BackupFile, type BackupStatus, type ServerConfig, type ServerConfigChanges } from "@/contract";
import { readTime } from "@/features/settings/NotifyTimeSetting";
import { useSecondsLeft } from "@/features/settings/PushSetting";
import settingsStyles from "@/features/settings/SettingsPage.module.css";
import { errorText, formatBytes, List, ListRow, Notice } from "@/ui";
import { Button, Switch, TextField, useToast } from "@/ui/base";
import { DatabaseIcon, DownloadIcon, InfoIcon, WarningIcon } from "@/ui/icons";

import styles from "./Backup.module.css";
import { saveBlob } from "./files";
import { envText, folderText, retryAfter, scheduleHint } from "./texts";

const OFFLINE = "Dafür braucht es den Server, und der ist gerade nicht erreichbar.";

export interface BackupScheduleProps {
  config: BackupConfig;
  /** Zeitzone des Servers (`IntegrationStatus.timezone`); null, solange unbekannt. */
  timezone: string | null;
  onSaved: (config: ServerConfig) => void;
}

/**
 * Schalter und Uhrzeit der täglichen Sicherung (Vorgabe 03:30, Zeitzone des Servers). Was aus der
 * Umgebung kommt, ist gesperrt und so beschriftet. Die Uhrzeit gilt beim Verlassen des Felds.
 */
export function BackupSchedule({ config, timezone, onSaved }: BackupScheduleProps) {
  const core = useCore();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [time, setTime] = useState(config.time);
  const [error, setError] = useState<string | null>(null);

  // Ein anderer Wert vom Server (neu geladen): Feld nachziehen.
  useEffect(() => {
    setTime(config.time);
    setError(null);
  }, [config.time]);

  async function update(changes: ServerConfigChanges) {
    setBusy(true);
    try {
      onSaved(await core.serverConfig.update(changes));
      toast.show({ id: "backup-saved", message: "Einstellung gespeichert", tone: "success", duration: 2500 });
    } catch (caught) {
      toast.show({ message: errorText(caught, { offline: OFFLINE }), tone: "danger" });
      setTime(config.time);
    } finally {
      setBusy(false);
    }
  }

  function commitTime() {
    const next = readTime(time);
    if (!isTimeOfDay(next)) {
      setError("Bitte eine Uhrzeit wie 03:30 eingeben.");
      return;
    }
    setError(null);
    setTime(next);
    if (next !== config.time) {
      void update({ backup_time: next });
    }
  }

  const timeLocked = config.time_source === "env";
  return (
    <List>
      <div className={settingsStyles.switchRow}>
        <Switch
          label="Automatische Sicherung"
          hint={scheduleHint(config, timezone)}
          checked={config.enabled}
          disabled={busy || config.enabled_source === "env"}
          onChange={(enabled) => void update({ backup_enabled: enabled })}
        />
      </div>
      <ListRow
        label="Uhrzeit"
        hint={
          error ? (
            <span className={settingsStyles.error} role="alert">
              {error}
            </span>
          ) : (
            (envText(config.time_source, "STOWLY_BACKUP_TIME") ?? "Zeit des Servers. Vorgabe ist 03:30: nachts, wenn niemand einlagert.")
          )
        }
      >
        {timeLocked ? (
          <span className={settingsStyles.value}>{config.time}</span>
        ) : (
          <TextField
            className={styles.time}
            label="Uhrzeit der Sicherung"
            hideLabel
            type="time"
            step={60}
            autoComplete="off"
            disabled={busy}
            value={time}
            onChange={(event) => {
              setTime(event.target.value);
              setError(null);
            }}
            onBlur={commitTime}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
          />
        )}
      </ListRow>
    </List>
  );
}

/**
 * Wo die Sicherungen landen (docs/plan-einrichtung-b.md, 1): der Ordner mit seiner Quelle. Liegt er
 * im Datenordner, steht die kurze Anleitung dabei, wie ein zweiter Ordner als /backups in DSM
 * eingebunden oder der Ordner weggekopiert wird.
 */
export function BackupFolder({ config }: { config: BackupConfig }) {
  return (
    <div className={styles.stack}>
      {config.folder_problem ? (
        <Notice tone="danger" icon={<WarningIcon />} title="Der Ordner für Sicherungen taugt nicht" role="alert">
          {config.folder_problem}
        </Notice>
      ) : null}
      {config.folder_hint ? (
        <Notice tone="warn" icon={<WarningIcon />} title="Der eigene Ordner wird nicht benutzt" role="status">
          {config.folder_hint} In DSM beim freigegebenen Ordner Schreibrecht geben (Lesen und Schreiben für den Benutzer 10001 oder für alle); danach nimmt Stowly ihn von
          selbst.
        </Notice>
      ) : null}
      <List>
        <ListRow label="Ordner" hint={folderText(config)}>
          <code className={styles.mono}>{config.folder}</code>
        </ListRow>
      </List>
      {config.folder_source === "data" ? (
        <details className={styles.details}>
          <summary>Sicherungen außerhalb des Datenordners</summary>
          <p>Am besten liegen die Sicherungen auf einem anderen Datenträger als die Datenbank. Zwei Wege:</p>
          <ol className={styles.steps}>
            <li>
              Einen zweiten Ordner als <span className={styles.mono}>/backups</span> einbinden: Container Manager → Container „stowly“ stoppen → Bearbeiten → Volume-Einstellungen →
              Ordner hinzufügen, etwa <span className={styles.mono}>docker/stowly-backups</span>, Einhängepfad <span className={styles.mono}>/backups</span> → Container starten.
              Stowly findet den Ordner von selbst. Er braucht Schreibrecht für den Benutzer 10001.
            </li>
            <li>Oder diesen Ordner mit Hyper Backup oder Cloud Sync regelmäßig auf ein anderes Gerät oder in die Cloud kopieren.</li>
          </ol>
        </details>
      ) : null}
    </div>
  );
}

/** Ein Fehler von „Jetzt sichern" als Satz. */
export function runErrorText(error: unknown): string {
  if (isCoreError(error, "conflict")) {
    return "Gerade läuft schon eine Sicherung. Gleich noch einmal versuchen.";
  }
  if (isCoreError(error, "not_configured")) {
    return error.message.trim() !== "" && error.message !== error.code ? error.message : "Für die Sicherung fehlt ein Schlüssel oder ein brauchbarer Ordner.";
  }
  return errorText(error, { offline: OFFLINE, not_supported: "Dieser Server kann noch nicht auf Knopfdruck sichern. Erst Stowly aktualisieren." });
}

export interface BackupRunProps {
  /** Der Zustand der Sicherung, wie zuletzt geladen; null, solange er fehlt. */
  status: BackupStatus | null;
  /** Nach „Jetzt sichern": den Zustand neu laden. */
  onChanged: () => void;
  /** So viele Sicherungen stehen sofort da; Vorgabe 3. */
  shown?: number;
}

/**
 * „Jetzt sichern" legt eine Sicherung wie die tägliche in den Ordner (höchstens eine je Minute), und
 * die Sicherungen im Ordner lassen sich herunterladen: verschlüsselt, wie sie dort liegen.
 */
export function BackupRun({ status, onChanged, shown = 3 }: BackupRunProps) {
  const core = useCore();
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pauseUntil, setPauseUntil] = useState(0);
  const secondsLeft = useSecondsLeft(pauseUntil);
  const [all, setAll] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const files: BackupFile[] = status?.files ?? [];

  async function run() {
    setRunning(true);
    setMessage(null);
    try {
      const file = await core.backup.run();
      toast.show({ message: `Sicherung angelegt: ${file.name}`, tone: "success" });
      onChanged();
    } catch (caught) {
      if (isCoreError(caught, "rate_limited")) {
        setPauseUntil(Date.now() + retryAfter(caught) * 1000);
        setMessage("Jetzt sichern geht höchstens einmal je Minute. Bitte kurz warten.");
      } else {
        setMessage(runErrorText(caught));
      }
    } finally {
      setRunning(false);
    }
  }

  async function download(file: BackupFile) {
    setLoading(file.name);
    try {
      saveBlob(await core.backup.file(file.name), file.name);
      toast.show({ message: `Heruntergeladen: ${file.name}`, tone: "success" });
    } catch (caught) {
      toast.show({ message: errorText(caught, { offline: OFFLINE, not_found: "Diese Sicherung liegt nicht mehr im Ordner." }), tone: "danger" });
    } finally {
      setLoading(null);
    }
  }

  const visible = all ? files : files.slice(0, shown);
  return (
    <div className={styles.stack}>
      <div className={styles.actions}>
        <Button icon={<DatabaseIcon />} busy={running} disabled={secondsLeft > 0} onClick={() => void run()}>
          Jetzt sichern
        </Button>
        {secondsLeft > 0 ? <span className={styles.pause}>Nächste in {secondsLeft} s</span> : null}
      </div>
      {message ? (
        <Notice tone="warn" role="alert" icon={<InfoIcon />}>
          {message}
        </Notice>
      ) : null}
      {files.length === 0 ? (
        <p className={styles.small}>Im Ordner liegt noch keine Sicherung.</p>
      ) : (
        <>
          <ul className={styles.files} aria-label="Sicherungen im Ordner">
            {visible.map((file) => (
              <li key={file.name} className={styles.file}>
                <span className={styles.fileText}>
                  <span>
                    {formatTimestamp(file.created_at)} · {formatBytes(file.size)}
                  </span>
                  <span className={styles.fileName}>{file.name}</span>
                </span>
                <Button size="sm" icon={<DownloadIcon />} busy={loading === file.name} aria-label={`Herunterladen: ${file.name}`} onClick={() => void download(file)}>
                  Herunterladen
                </Button>
              </li>
            ))}
          </ul>
          {files.length > shown ? (
            <div className={styles.actions}>
              <Button size="sm" variant="ghost" aria-expanded={all} onClick={() => setAll(!all)}>
                {all ? "Weniger zeigen" : `Alle zeigen (${String(files.length)})`}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
