import { useId, type ReactNode, type Ref } from "react";

import { cx } from "./base";
import styles from "./Field.module.css";
import { ChevronDownIcon } from "./icons";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string> {
  label: string;
  /** Beschriftung nur für Screenreader. */
  hideLabel?: boolean;
  options: readonly SelectOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Hinweis unter dem Feld. */
  hint?: ReactNode;
  /** Fehlermeldung; ersetzt den Hinweis und färbt das Feld. */
  error?: string | null;
  disabled?: boolean;
  id?: string;
  className?: string;
  ref?: Ref<HTMLSelectElement>;
}

/**
 * Auswahlfeld. Bewusst das Element des Browsers: Am Handy öffnet es die gewohnte,
 * mit dem Daumen bedienbare Auswahl des Systems.
 */
export function Select<T extends string>({
  label,
  hideLabel = false,
  options,
  value,
  onChange,
  hint,
  error,
  disabled,
  id,
  className,
  ref,
}: SelectProps<T>) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const messageId = `${selectId}-message`;
  const message = error || hint;
  return (
    <div className={cx(styles.field, className)}>
      <label htmlFor={selectId} className={cx(styles.label, hideLabel && "sr-only")}>
        {label}
      </label>
      <div className={styles.selectWrap}>
        <select
          ref={ref}
          id={selectId}
          className={cx(styles.select, error && styles.invalid)}
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={message ? messageId : undefined}
          onChange={(event) => onChange(event.target.value as T)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        <span className={styles.chevron} aria-hidden="true">
          <ChevronDownIcon size={18} />
        </span>
      </div>
      {message ? (
        <p id={messageId} className={cx(styles.message, error && styles.error)} role={error ? "alert" : undefined}>
          {message}
        </p>
      ) : null}
    </div>
  );
}
