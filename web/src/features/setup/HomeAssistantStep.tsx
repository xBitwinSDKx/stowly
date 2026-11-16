import { useCore } from "@/contract";
import { HA_OFFLINE, HaSetup } from "@/features/settings/HomeAssistantSection";
import { useIntegrations } from "@/features/settings/integrations";
import { useLoaded } from "@/features/settings/loaded";
import { Notice } from "@/ui";
import { CircleCheckIcon } from "@/ui/icons";

import styles from "./SetupPage.module.css";

/**
 * „Home Assistant" (docs/plan-einrichtung-b.md, „So sieht es für dich aus"): Adresse und Token aus
 * dem Profil von HA, „Verbindung prüfen" zeigt die To-do-Listen zur Auswahl, dann „Speichern";
 * danach „Sensor-Token erzeugen" mit fertigem YAML. Erledigt ist der Schritt, sobald der Abgleich
 * eingerichtet ist. Wer kein Home Assistant hat, überspringt ihn.
 */
export function HomeAssistantStep({ onChanged }: { onChanged: () => void }) {
  const core = useCore();
  const integrations = useIntegrations();
  const config = useLoaded(() => core.haConfig.load(), HA_OFFLINE);
  const ha = integrations.state.status === "ready" ? integrations.state.value.ha : null;

  return (
    <>
      <p className={styles.lead}>
        Mit Home Assistant erscheint die Einkaufsliste in Bring!, und Home Assistant kann ansagen, was bald abläuft. Wer kein Home Assistant hat, überspringt diesen
        Schritt.
      </p>
      {ha?.configured && ha.state === "ok" ? (
        <Notice tone="success" icon={<CircleCheckIcon />} role="status">
          Verbunden: Der Abgleich mit Bring! läuft.
        </Notice>
      ) : null}
      <HaSetup integrations={integrations.state} onReload={integrations.reload} config={config} onChanged={onChanged} />
    </>
  );
}
