import { cx } from "./cx";
import styles from "./Spinner.module.css";

export interface SpinnerProps {
  /** Kantenlänge in Pixeln. Vorgabe 18. */
  size?: number;
  /** Text für Screenreader. Ohne Angabe ist der Spinner reine Dekoration. */
  label?: string;
  className?: string;
}

/** Drehender Ring für „es lädt". */
export function Spinner({ size = 18, label, className }: SpinnerProps) {
  return (
    <span
      className={cx(styles.spinner, className)}
      style={{ width: size, height: size }}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
