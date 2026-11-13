import { useId, type ReactNode } from "react";

import { cx } from "./base";
import styles from "./Field.module.css";

export interface FieldGroupProps {
  /** Beschriftung der Gruppe. */
  label: string;
  /** Hinweis unter den Bedienelementen. */
  hint?: ReactNode;
  /** Fehlermeldung; ersetzt den Hinweis. */
  error?: string | null;
  children: ReactNode;
  className?: string;
}

/**
 * Beschriftete Gruppe für Bedienelemente, die kein einzelnes Eingabefeld sind
 * (Auswahl aus Symbolen, Liste von Packungen, Mengenwähler).
 */
export function FieldGroup({ label, hint, error, children, className }: FieldGroupProps) {
  const labelId = useId();
  const messageId = useId();
  const message = error || hint;
  return (
    <div role="group" aria-labelledby={labelId} aria-describedby={message ? messageId : undefined} className={cx(styles.field, className)}>
      <span id={labelId} className={styles.label}>
        {label}
      </span>
      {children}
      {message ? (
        <p id={messageId} className={cx(styles.message, error && styles.error)} role={error ? "alert" : undefined}>
          {message}
        </p>
      ) : null}
    </div>
  );
}
