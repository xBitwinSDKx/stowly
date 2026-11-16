import { useState } from "react";

import { useCore, type UpdateStatus } from "@/contract";
import { useIntegrations } from "@/features/settings/integrations";
import { loadedValue, useLoaded } from "@/features/settings/loaded";
import settingsStyles from "@/features/settings/SettingsPage.module.css";
import { UPDATE_POLL_MS, updateSwitchHint } from "@/features/settings/UpdateSection";
import { errorText, List, Notice, timeAgo, useNow, useVisibleInterval } from "@/ui";
import { Spinner, Switch, useToast } from "@/ui/base";
import { CircleCheckIcon, CloudOffIcon, InfoIcon, WarningIcon } from "@/ui/icons";
import { CopyField } from "@/ui/CopyField";

import styles from "./SetupPage.module.css";
import { isOlderVersion } from "./steps";
import { SETUP_OFFLINE } from "./useSetup";

/** Welcher Updater sich meldet, in Worten. */
function kindText(update: UpdateStatus): string {
  return update.updater_kind === "container" ? "Updater-Container" : update.updater_kind === "script" ? "Updater-Skript auf dem Rechner" : "Updater";
}

/** Die Zeile „Updater bereit": bereit, zuletzt vor 1 Minute; mit Hinweis, wenn er älter ist als Stowly. */
export function updaterText(update: UpdateStatus, now: number): string {
  const seen = update.updater_seen_at ? `, zuletzt ${timeAgo(update.updater_seen_at, now)}` : "";
  return `${kindText(update)} bereit${seen}.`;
}

/**
 * „Updates": der Schalter „Nach neuen Versionen suchen" (gesperrt, wenn die Umgebung entscheidet),
 * dazu der Updater, der Updates per Knopf installiert. Meldet er sich nicht, die Anleitung für den
 * Aufgabenplaner von DSM mit dem fertigen Befehl; die App fragt dann alle 10 Sekunden nach.
 */
export function UpdatesStep({ onChanged }: { onChanged: () => void }) {
  const core = useCore();
  const toast = useToast();
  const now = useNow();
  const serverConfig = useLoaded(() => core.serverConfig.load(), SETUP_OFFLINE);
  const integrations = useIntegrations();
  const [toggling, setToggling] = useState(false);
  const config = loadedValue(serverConfig.state);
  const update = integrations.state.status === "ready" ? integrations.state.value.update : null;
  const enabled = config?.update.enabled ?? update?.configured ?? false;

  // Bis „Updater bereit" erscheint: alle 10 Sekunden nachfragen, nur bei sichtbarer Seite.
  useVisibleInterval(integrations.reload, UPDATE_POLL_MS, enabled && update !== null && !update.updater_ready);

  async function toggle(next: boolean) {
    setToggling(true);
    try {
      serverConfig.set(await core.serverConfig.update({ update_enabled: next }));
      integrations.reload();
      onChanged();
    } catch (caught) {
      toast.show({ message: errorText(caught, { offline: SETUP_OFFLINE }), tone: "danger" });
    } finally {
      setToggling(false);
    }
  }

  const failed = serverConfig.state.status === "error" ? serverConfig.state : integrations.state.status === "error" ? integrations.state : null;

  return (
    <>
      <p className={styles.lead}>Neue Versionen von Stowly erscheinen auf GitHub. Der Server sucht danach; installiert wird auf Knopfdruck in den Einstellungen.</p>
      {failed ? (
        <Notice tone={failed.offline ? "warn" : "danger"} icon={failed.offline ? <CloudOffIcon /> : <WarningIcon />} role="status">
          {failed.message}
        </Notice>
      ) : null}
      {config ? (
        <List>
          <div className={settingsStyles.switchRow}>
            <Switch
              label="Nach neuen Versionen suchen"
              hint={updateSwitchHint(config.update)}
              checked={config.update.enabled}
              disabled={toggling || config.update.source === "env" || !config.update.available}
              onChange={(next) => void toggle(next)}
            />
          </div>
        </List>
      ) : failed ? null : (
        <p className={styles.actions}>
          <Spinner size={18} label="Einstellungen werden geladen" />
        </p>
      )}
      {enabled && update ? <Updater update={update} now={now} /> : null}
      <details className={styles.details}>
        <summary>Stowly läuft mit Docker Compose?</summary>
        <p>Dann übernimmt das Skript updater/stowly-update.sh die Updates; es läuft über den Aufgabenplaner oder einen systemd-Timer. Die Anleitung steht in docs/betrieb.md, Abschnitt 9.</p>
      </details>
    </>
  );
}

function Updater({ update, now }: { update: UpdateStatus; now: number }) {
  const command = update.updater_command ?? null;
  if (update.updater_ready) {
    const outdated = isOlderVersion(update.updater_version, update.current);
    return (
      <section className={styles.block}>
        <Notice tone="success" role="status" icon={<CircleCheckIcon />} title={updaterText(update, now)}>
          Updates lassen sich in den Einstellungen unter „Aktualisierung“ installieren.
        </Notice>
        {outdated ? (
          <>
            <Notice tone="warn" icon={<WarningIcon />}>
              Der Updater ist älter als Stowly: Befehl erneut ausführen.
            </Notice>
            {command ? <CopyField value={command} label="Befehl für den Updater" /> : null}
          </>
        ) : null}
      </section>
    );
  }
  return (
    <section className={styles.block}>
      <h3 className={styles.subtitle}>Updater anlegen</h3>
      <p>Für Updates per Knopf braucht Stowly einen kleinen zweiten Container, den Updater. Er wird einmal über den Aufgabenplaner von DSM angelegt:</p>
      <ol className={styles.steps}>
        <li>Systemsteuerung → Aufgabenplaner → Erstellen → Geplante Aufgabe → Benutzerdefiniertes Skript.</li>
        <li>Reiter „Allgemein“: Benutzer root.</li>
        <li>Reiter „Aufgabeneinstellungen“: den Befehl unten einfügen, OK.</li>
        <li>Die Aufgabe markieren → „Ausführen“.</li>
        <li>Sobald hier „Updater bereit“ steht, die Aufgabe wieder löschen.</li>
      </ol>
      {command ? (
        <CopyField value={command} label="Befehl für den Updater" />
      ) : (
        <Notice tone="info" icon={<InfoIcon />}>
          Dieses Image kennt keinen fertigen Befehl für den Updater-Container (es fehlt STOWLY_IMAGE_REF, oder Stowly erkennt seinen Container nicht). Den Updater-Container
          beschreibt docs/betrieb.md, Abschnitt 19.3; mit Docker Compose gilt Abschnitt 9.
        </Notice>
      )}
      <p className={styles.actions}>
        <Spinner size={18} />
        <span>Wartet auf den Updater; Stowly fragt alle {String(UPDATE_POLL_MS / 1000)} Sekunden nach.</span>
      </p>
    </section>
  );
}
