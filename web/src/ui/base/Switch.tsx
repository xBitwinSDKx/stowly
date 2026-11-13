import { useId } from "react";

import { cx } from "./cx";
import styles from "./Switch.module.css";

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Beschriftung. Mit `hideLabel` nur für Screenreader. */
  label: string;
  hideLabel?: boolean;
  /** Zweite Zeile unter der Beschriftung. */
  hint?: string;
  disabled?: boolean;
  className?: string;
}

/** Schalter für An/Aus, wie in den Zeilen der Einstellungen. */
export function Switch({ checked, onChange, label, hideLabel = false, hint, disabled = false, className }: SwitchProps) {
  const labelId = useId();
  const hintId = useId();
  return (
    <span className={cx(styles.row, className)}>
      <span className={cx(styles.text, hideLabel && "sr-only")}>
        <span id={labelId} className={styles.label}>
          {label}
        </span>
        {hint ? (
          <span id={hintId} className={styles.hint}>
            {hint}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={hint ? hintId : undefined}
        disabled={disabled}
        className={cx(styles.switch, checked && styles.on)}
        onClick={() => onChange(!checked)}
      >
        <span className={styles.thumb} />
      </button>
    </span>
  );
}
