import { useLocation } from "react-router";

import { ROUTES } from "@/contract";
import { Notice } from "@/ui";
import { Button, ButtonLink } from "@/ui/base";
import { QuestionIcon } from "@/ui/icons";

import { useLabelActions } from "./labelActions";
import styles from "./PrintersPage.module.css";
import { usePrinting } from "./usePrinting";

/**
 * Die Nachfrage „Wurde das Etikett gedruckt?" im Rahmen der App: Sie steht unter der Kopfzeile,
 * solange der Ausgang eines Etiketts offen ist, damit niemand die Drucker-Ansicht suchen muss.
 * In der Scan-Ansicht gibt es den Rahmen nicht; dort unterbricht sie also nichts. In der
 * Drucker-Ansicht steht dieselbe Frage schon bei den Etiketten.
 */
export function UnknownLabelsBanner() {
  const printing = usePrinting();
  const actions = useLabelActions();
  const location = useLocation();
  const asking = printing.asking;
  const first = asking[0];
  if (!first || location.pathname === ROUTES.printers) {
    return null;
  }
  const busy = actions.busy !== null;

  if (asking.length === 1) {
    return (
      <Notice
        banner
        tone="warn"
        role="status"
        icon={<QuestionIcon />}
        title="Wurde das Etikett gedruckt?"
        action={
          <div className={styles.bannerActions} role="group" aria-label="Wurde das Etikett gedruckt?">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void actions.resolve(first, true)}>
              Ja
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void actions.resolve(first, false)}>
              Nein
            </Button>
          </div>
        }
      >
        {first.title}
        {first.detail !== "" ? ` · ${first.detail}` : ""}: Der Ausgang ist unklar. Ein Blick auf den Drucker klärt es.
      </Notice>
    );
  }
  return (
    <Notice
      banner
      tone="warn"
      role="status"
      icon={<QuestionIcon />}
      title={`Wurden ${String(asking.length)} Etiketten gedruckt?`}
      action={
        <div className={styles.bannerActions}>
          <Button size="sm" variant="primary" busy={actions.busy === "all"} onClick={() => void actions.resolveAll(asking)}>
            Alle gedruckt
          </Button>
          <ButtonLink size="sm" to={{ pathname: ROUTES.printers, hash: "#etiketten" }}>
            Einzeln klären
          </ButtonLink>
        </div>
      }
    >
      Bei diesen Etiketten kennt Stowly den Ausgang nicht. Nichts wird von selbst noch einmal gedruckt.
    </Notice>
  );
}
