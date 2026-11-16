import { useState } from "react";
import { useNavigate } from "react-router";

import { ROUTES, setupPath, type SetupChanges, type SetupStatus } from "@/contract";
import { SETUP_DONE_FLAG } from "@/app/setupAutoOpen";
import { errorText, List, ListRow, Notice, useUiFlag } from "@/ui";
import { Badge, Button, ButtonLink, useToast, type BadgeTone } from "@/ui/base";
import { SmartphoneIcon } from "@/ui/icons";

import styles from "./SetupPage.module.css";
import { progressOf, STEP_LABELS, stepOf, WIZARD_STEPS, type StepProgress } from "./steps";
import { SETUP_OFFLINE } from "./useSetup";

const BADGES: Record<StepProgress, { tone: BadgeTone; text: string }> = {
  done: { tone: "success", text: "erledigt" },
  skipped: { tone: "warn", text: "übersprungen" },
  open: { tone: "neutral", text: "offen" },
};

export interface DoneStepProps {
  status: SetupStatus;
  update: (changes: SetupChanges) => Promise<SetupStatus>;
  secure: boolean;
}

/**
 * „Fertig": jeder Schritt mit seinem Stand und „Nachholen", dazu der Hinweis auf weitere Geräte.
 * „Zu Stowly" schließt die Einrichtung ab (`finished: true`) und führt zum Bestand; dieses Gerät
 * fragt danach nie wieder.
 */
export function DoneStep({ status, update, secure }: DoneStepProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const [, setDone] = useUiFlag(SETUP_DONE_FLAG, false);
  const [busy, setBusy] = useState(false);

  async function finish() {
    setBusy(true);
    try {
      await update({ finished: true });
      setDone(true);
      void navigate(ROUTES.stock);
    } catch (caught) {
      toast.show({ message: errorText(caught, { offline: SETUP_OFFLINE }), tone: "danger" });
      setBusy(false);
    }
  }

  return (
    <>
      <p className={styles.lead}>Übersprungenes lässt sich jederzeit nachholen, auch später unter Einstellungen → Einrichtung und Zugang.</p>
      <List>
        {WIZARD_STEPS.map((id) => {
          const progress = progressOf(stepOf(status, id), secure);
          return (
            <ListRow key={id} label={STEP_LABELS[id]} inline>
              <span className={styles.actions}>
                <Badge tone={BADGES[progress].tone}>{BADGES[progress].text}</Badge>
                {progress === "done" ? null : (
                  <ButtonLink size="sm" to={setupPath(id)} aria-label={`Nachholen: ${STEP_LABELS[id]}`}>
                    Nachholen
                  </ButtonLink>
                )}
              </span>
            </ListRow>
          );
        })}
      </List>
      <Notice tone="info" icon={<SmartphoneIcon />}>
        Jedes weitere Gerät braucht das Zertifikat einmal: Einstellungen → Einrichtung und Zugang.
      </Notice>
      <div className={styles.actions}>
        <Button variant="primary" size="lg" busy={busy} onClick={() => void finish()}>
          Zu Stowly
        </Button>
      </div>
    </>
  );
}
