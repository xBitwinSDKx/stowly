import { useState } from "react";

import { formatDate, ROUTES, setupPath, toLocalDate, useCore, type ServerConfig } from "@/contract";
import { securePage } from "@/features/setup/navigateAway";
import { doneCount, WIZARD_STEPS } from "@/features/setup/steps";
import { List, ListRow, Notice, Section } from "@/ui";
import { Button, ButtonLink, Spinner } from "@/ui/base";
import { CloudOffIcon, KeyIcon } from "@/ui/icons";

import { useLoaded, type LoadedResource } from "./loaded";
import { PasswordDialog } from "./PasswordDialog";
import { PushContactForm } from "./PushContactForm";
import styles from "./SettingsPage.module.css";

/** Der Stand der Einrichtung in Worten: „Abgeschlossen am 16.11.2026" oder „2 von 4 erledigt". */
export function setupProgressText(finishedAt: string | null, done: number, total: number = WIZARD_STEPS.length): string {
  if (finishedAt !== null) {
    const ms = Date.parse(finishedAt);
    return Number.isNaN(ms) ? "Abgeschlossen" : `Abgeschlossen am ${formatDate(toLocalDate(new Date(ms)))}`;
  }
  return `${String(done)} von ${String(total)} erledigt`;
}

/**
 * „Einrichtung und Zugang": Stand des Assistenten mit „Öffnen", das Zertifikat für weitere Geräte,
 * das Haushalts-Passwort (`PasswordDialog`) und der Kontakt für die Push-Dienste. Braucht den
 * Server; was aus der Umgebung kommt, ist hier nur zu sehen.
 */
export function SetupSection({ serverConfig }: { serverConfig: LoadedResource<ServerConfig> }) {
  const core = useCore();
  const setup = useLoaded(() => core.setup.load(), "Den Stand der Einrichtung kennt nur der Server, und der ist gerade nicht erreichbar.");
  const [changing, setChanging] = useState(false);
  const secure = securePage();
  const status = setup.state.status === "ready" ? setup.state.value : null;
  const config = serverConfig.state.status === "ready" ? serverConfig.state.value : null;
  const failed = setup.state.status === "error" ? setup.state : serverConfig.state.status === "error" ? serverConfig.state : null;

  function reload() {
    setup.reload();
    serverConfig.reload();
  }

  const loading = (label: string) => (
    <span className={styles.muted}>
      <Spinner label={label} />
    </span>
  );

  return (
    <Section title="Einrichtung und Zugang" id="einrichtung" description="Gilt für den ganzen Haushalt: der Assistent, das Haushalts-Passwort und der Kontakt für Benachrichtigungen.">
      {failed ? (
        <Notice
          tone={failed.offline ? "warn" : "danger"}
          icon={failed.offline ? <CloudOffIcon /> : undefined}
          title="Stand der Einrichtung fehlt"
          role="status"
          action={
            <Button size="sm" onClick={reload}>
              Erneut versuchen
            </Button>
          }
        >
          {failed.message}
        </Notice>
      ) : null}
      <List>
        <ListRow label="Einrichtung" hint={status ? setupProgressText(status.finished_at, doneCount(status, secure)) : "Sichere Verbindung, Drucker, Updates und Benachrichtigungen."}>
          <ButtonLink to={ROUTES.setup}>Öffnen</ButtonLink>
        </ListRow>
        <ListRow label="Weitere Geräte" hint="Jedes weitere Gerät braucht das Zertifikat von Stowly einmal; die Anleitung je Gerät steht in der Einrichtung.">
          <ButtonLink to={setupPath("https")}>Anleitung</ButtonLink>
        </ListRow>
        <ListRow
          label="Haushalts-Passwort"
          hint={
            status?.password_source === "env"
              ? "Kommt aus der Umgebung (STOWLY_PASSWORD)."
              : "Damit melden sich neue Geräte an. Ändern meldet kein Gerät ab."
          }
        >
          {status === null ? (
            loading("Stand wird geladen")
          ) : status.password_source === "env" ? (
            <span className={styles.value}>nur dort änderbar</span>
          ) : (
            <Button icon={<KeyIcon />} onClick={() => setChanging(true)}>
              Passwort ändern
            </Button>
          )}
        </ListRow>
        <ListRow label="Kontakt für Push" hint="Die Push-Dienste von Apple, Google und Mozilla verlangen eine Kontakt-Adresse; ohne sie gibt es keine Benachrichtigungen." stacked>
          {config ? <PushContactForm config={config} onSaved={serverConfig.set} /> : loading("Kontakt wird geladen")}
        </ListRow>
      </List>
      {changing ? <PasswordDialog onClose={() => setChanging(false)} /> : null}
    </Section>
  );
}
