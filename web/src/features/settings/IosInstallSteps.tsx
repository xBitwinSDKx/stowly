import { ShareIcon } from "@/ui/icons";

import styles from "./SettingsPage.module.css";

/** Die Anleitung, Stowly auf iPhone und iPad zum Home-Bildschirm hinzuzufügen (Safari kennt keine Aufforderung). */
export function IosInstallSteps() {
  return (
    <ol className={styles.steps}>
      <li>
        In Safari unten auf <ShareIcon size={16} aria-hidden="true" /> <strong>Teilen</strong> tippen.
      </li>
      <li>
        <strong>Zum Home-Bildschirm</strong> wählen und mit „Hinzufügen“ bestätigen.
      </li>
      <li>Stowly künftig über das neue Symbol starten und dort einmal anmelden.</li>
    </ol>
  );
}
