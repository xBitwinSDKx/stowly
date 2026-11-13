import { formatDate, type ExpiryState } from "@/contract";

import { cx } from "./base";
import styles from "./ExpiryLabel.module.css";
import { expiryText } from "./format";
import { WarningIcon } from "./icons";

export interface ExpiryLabelProps {
  /** MHD "YYYY-MM-DD" oder null. */
  date: string | null;
  /** Warnstufe nach `expiryState()`. */
  state: ExpiryState;
  /** Tage bis zum MHD (`daysUntil()`). */
  days: number | null;
  /** Zusatz in Worten zeigen: „läuft in 9 Tagen ab". */
  detail?: boolean;
  /** Text ohne MHD. Vorgabe „–". */
  emptyText?: string;
  className?: string;
}

/**
 * Ein MHD in der Farbe seiner Warnstufe: bald ablaufend in Bernstein,
 * abgelaufen als rotes Abzeichen mit Warnzeichen.
 */
export function ExpiryLabel({ date, state, days, detail = false, emptyText = "–", className }: ExpiryLabelProps) {
  if (date === null) {
    return (
      <span className={cx(styles.expiry, styles.none, className)}>
        {emptyText}
        {emptyText === "–" ? <span className="sr-only">kein MHD</span> : null}
      </span>
    );
  }
  const text = expiryText(state, days);
  return (
    <span className={cx(styles.expiry, styles[state], className)}>
      {state === "expired" ? (
        <span className={cx(styles.badge, "tabular")}>
          <WarningIcon size={14} aria-hidden="true" />
          {formatDate(date)}
        </span>
      ) : (
        <span className={cx(styles.date, "tabular")}>{formatDate(date)}</span>
      )}
      {detail && text !== "" ? (
        <span className={styles.detail}>{text}</span>
      ) : state === "expired" ? (
        <span className="sr-only">abgelaufen</span>
      ) : state === "soon" ? (
        <span className="sr-only">läuft bald ab</span>
      ) : null}
    </span>
  );
}
