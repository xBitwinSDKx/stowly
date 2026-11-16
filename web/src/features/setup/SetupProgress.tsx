import { Link } from "react-router";

import { setupPath, type SetupStatus, type SetupStepKey } from "@/contract";
import { useMediaQuery, WIDE_QUERY } from "@/ui";
import { cx } from "@/ui/base";
import { CheckIcon, SkipIcon } from "@/ui/icons";

import styles from "./SetupPage.module.css";
import { progressOf, STEP_COUNT, STEP_LABELS, stepNumber, stepOf, WIZARD_STEPS, type StepProgress } from "./steps";

const SPOKEN: Record<StepProgress, string> = { done: ", erledigt", skipped: ", übersprungen", open: "" };

function Marker({ progress, number }: { progress: StepProgress; number: number | null }) {
  return (
    <span className={cx(styles.marker, progress === "done" && styles.markerDone, progress === "skipped" && styles.markerSkipped)} aria-hidden="true">
      {progress === "done" ? <CheckIcon size={14} /> : progress === "skipped" ? <SkipIcon size={13} /> : number}
    </span>
  );
}

export interface SetupProgressProps {
  status: SetupStatus;
  /** Die Seite, die gerade offen ist. */
  current: SetupStepKey;
  /** Die App läuft über HTTPS: Die sichere Verbindung ist erledigt. */
  secure: boolean;
}

/**
 * Wo der Assistent steht: „Zugang · Sichere Verbindung · Drucker · Sicherung · Updates ·
 * Benachrichtigungen · Home Assistant · Fertig" als Liste, jeder Schritt mit Zeichen für erledigt
 * oder übersprungen und als Verweis. Der Zugang (das Passwort) ist immer erledigt und hat keine
 * eigene Seite. Am Handy kompakt: „Schritt 2 von 7" mit Balken.
 */
export function SetupProgress({ status, current, secure }: SetupProgressProps) {
  const wide = useMediaQuery(WIDE_QUERY);
  if (!wide) {
    const number = stepNumber(current);
    const text = current === "done" ? "Fertig" : `Schritt ${String(number)} von ${String(STEP_COUNT)}: ${STEP_LABELS[current]}`;
    return (
      <div className={styles.compact}>
        <p>{text}</p>
        <div className={styles.bar} role="progressbar" aria-label="Fortschritt der Einrichtung" aria-valuemin={1} aria-valuemax={STEP_COUNT} aria-valuenow={number} aria-valuetext={text}>
          <span style={{ width: `${String((number / STEP_COUNT) * 100)}%` }} />
        </div>
      </div>
    );
  }
  return (
    <nav aria-label="Fortschritt der Einrichtung">
      <ol className={styles.progress}>
        <li className={styles.item}>
          <Marker progress="done" number={1} />
          <span>
            {STEP_LABELS.access}
            <span className="sr-only">{SPOKEN.done}</span>
          </span>
        </li>
        {WIZARD_STEPS.map((id, index) => {
          const progress = progressOf(stepOf(status, id), secure);
          return (
            <li key={id}>
              <Link to={setupPath(id)} className={styles.item} aria-current={current === id ? "step" : undefined}>
                <Marker progress={progress} number={index + 2} />
                <span>
                  {STEP_LABELS[id]}
                  <span className="sr-only">{SPOKEN[progress]}</span>
                </span>
              </Link>
            </li>
          );
        })}
        <li>
          <Link to={setupPath("done")} className={styles.item} aria-current={current === "done" ? "step" : undefined}>
            <Marker progress={status.finished_at !== null ? "done" : "open"} number={null} />
            <span>{STEP_LABELS.done}</span>
          </Link>
        </li>
      </ol>
    </nav>
  );
}
