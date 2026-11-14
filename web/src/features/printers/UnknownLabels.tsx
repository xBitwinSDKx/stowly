import { useState } from "react";
import { useLocation } from "react-router";

import { ROUTES } from "@/contract";
import { refocusContent } from "@/app/focus";
import { Notice } from "@/ui";
import { Button, ButtonLink } from "@/ui/base";
import { QuestionIcon } from "@/ui/icons";

import { useLabelActions } from "./labelActions";
import type { JobView } from "./model";
import styles from "./PrintersPage.module.css";
import { usePrinting } from "./usePrinting";

/** Welches Etikett, an welchem Drucker: „Basmati Reis · Packung A2B3C · Keller (Pi)". */
function subject(view: JobView): string {
  const pkg = view.job.kind === "package" && view.job.package_id ? `Packung ${view.job.package_id}` : null;
  return [view.title, pkg, view.printer?.name].filter((part) => part !== null && part !== undefined && part !== "").join(" · ");
}

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
  /** Die zuletzt gegebene Antwort: Solange sie vermerkt wird, zeigt ihre Schaltfläche den Spinner. */
  const [answered, setAnswered] = useState<boolean | null>(null);
  const asking = printing.asking;
  const first = asking[0];
  if (!first || location.pathname === ROUTES.printers) {
    return null;
  }
  const busy = actions.busy !== null;
  /** Die Antwort zum ersten Etikett, die gerade vermerkt wird; sonst null. */
  const answering = actions.busy === first.job.id ? answered : null;

  /** Antwortet; danach schließt sich der Hinweis, und der Fokus geht an den Inhalt der Ansicht. */
  function answer(run: () => Promise<void>) {
    void run().then(refocusContent);
  }

  function answerOne(view: JobView, printed: boolean) {
    setAnswered(printed);
    answer(() => actions.resolve(view, printed));
  }

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
            <Button size="sm" variant="primary" busy={answering === true} disabled={busy} onClick={() => answerOne(first, true)}>
              Ja
            </Button>
            <Button size="sm" busy={answering === false} disabled={busy} onClick={() => answerOne(first, false)}>
              Nein
            </Button>
          </div>
        }
      >
        {/* Kurz, auch am Handy: welches Etikett, an welchem Drucker. Warum gefragt wird, sagt die Drucker-Ansicht. */}
        {subject(first)}
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
          <Button size="sm" variant="primary" busy={actions.busy === "all"} onClick={() => answer(() => actions.resolveAll(asking))}>
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
