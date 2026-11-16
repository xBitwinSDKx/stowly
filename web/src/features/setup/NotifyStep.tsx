import { useCore, useLive } from "@/contract";
import { useIntegrations } from "@/features/settings/integrations";
import { IosInstallSteps } from "@/features/settings/IosInstallSteps";
import { loadedValue, useLoaded } from "@/features/settings/loaded";
import { PushContactForm } from "@/features/settings/PushContactForm";
import { PushSetting } from "@/features/settings/PushSetting";
import { List, Notice } from "@/ui";
import { Spinner } from "@/ui/base";
import { CloudOffIcon, WarningIcon } from "@/ui/icons";

import styles from "./SetupPage.module.css";
import { SETUP_OFFLINE } from "./useSetup";

/**
 * „Benachrichtigungen": die Kontakt-Adresse für die Push-Dienste (für den ganzen Haushalt), danach
 * Push auf diesem Gerät. Auf iPhone und iPad im Browser steht die Anleitung für den Home-Bildschirm
 * dabei: Nur dort kommen Benachrichtigungen an.
 */
export function NotifyStep({ onChanged }: { onChanged: () => void }) {
  const core = useCore();
  const app = useLive(core.app.state);
  const serverConfig = useLoaded(() => core.serverConfig.load(), SETUP_OFFLINE);
  const integrations = useIntegrations();
  const config = loadedValue(serverConfig.state);
  const failed = serverConfig.state.status === "error" ? serverConfig.state : null;

  return (
    <>
      <p className={styles.lead}>Stowly meldet einmal am Tag, was bald abläuft. Die Push-Dienste von Apple, Google und Mozilla verlangen dafür eine Kontakt-Adresse.</p>
      {failed ? (
        <Notice tone={failed.offline ? "warn" : "danger"} icon={failed.offline ? <CloudOffIcon /> : <WarningIcon />} role="status">
          {failed.message}
        </Notice>
      ) : config ? (
        <PushContactForm
          config={config}
          onSaved={(saved) => {
            serverConfig.set(saved);
            integrations.reload();
            onChanged();
          }}
        />
      ) : (
        <p className={styles.actions}>
          <Spinner size={18} label="Einstellungen werden geladen" />
        </p>
      )}
      <section className={styles.block}>
        <h3 className={styles.subtitle}>Auf diesem Gerät</h3>
        <List>
          <PushSetting integrations={integrations.state} setupLink={false} />
        </List>
        {app?.manual_install === "ios" ? <IosInstallSteps /> : null}
      </section>
    </>
  );
}
