import { useId, type InputHTMLAttributes, type ReactNode, type Ref } from "react";

import { cx } from "./cx";
import styles from "./TextField.module.css";

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Beschriftung. Mit `hideLabel` nur für Screenreader (z. B. beim Suchfeld). */
  label: string;
  hideLabel?: boolean;
  /** Hinweis unter dem Feld. */
  hint?: string;
  /** Fehlermeldung; ersetzt den Hinweis und färbt das Feld. */
  error?: string | null;
  /** Symbol links im Feld, z. B. die Lupe. */
  leading?: ReactNode;
  /** Inhalt rechts im Feld, z. B. eine Schaltfläche zum Leeren. */
  trailing?: ReactNode;
  ref?: Ref<HTMLInputElement>;
}

/** Einzeiliges Eingabefeld mit Beschriftung, Hinweis und Fehlermeldung. */
export function TextField({
  label,
  hideLabel = false,
  hint,
  error,
  leading,
  trailing,
  className,
  id,
  ref,
  ...rest
}: TextFieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const messageId = `${inputId}-message`;
  const message = error || hint;
  return (
    <div className={cx(styles.field, className)}>
      <label htmlFor={inputId} className={cx(styles.label, hideLabel && "sr-only")}>
        {label}
      </label>
      <div className={cx(styles.control, error && styles.invalid)}>
        {leading ? <span className={styles.adornment}>{leading}</span> : null}
        <input
          {...rest}
          ref={ref}
          id={inputId}
          className={styles.input}
          aria-invalid={error ? true : undefined}
          aria-describedby={message ? messageId : undefined}
        />
        {trailing ? <span className={styles.adornment}>{trailing}</span> : null}
      </div>
      {message ? (
        <p id={messageId} className={cx(styles.message, error && styles.error)} role={error ? "alert" : undefined}>
          {message}
        </p>
      ) : null}
    </div>
  );
}
