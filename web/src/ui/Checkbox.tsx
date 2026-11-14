import type { ReactNode } from "react";

import { cx } from "./base";
import styles from "./Field.module.css";

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Sichtbare Beschriftung; die ganze Zeile ist antippbar. */
  children?: ReactNode;
  /** Beschriftung für Screenreader, wenn kein sichtbarer Text dabei ist. */
  label?: string;
  /** Teilweise ausgewählt („einige, nicht alle"). */
  indeterminate?: boolean;
  disabled?: boolean;
  className?: string;
  /** Das Eingabefeld selbst, etwa um ihm später den Fokus zu geben. */
  inputRef?: (element: HTMLInputElement | null) => void;
}

/** Ankreuzfeld mit einer Zeile in Mindest-Tipphöhe. */
export function Checkbox({ checked, onChange, children, label, indeterminate = false, disabled, className, inputRef }: CheckboxProps) {
  return (
    <label className={cx(styles.check, className)}>
      <input
        type="checkbox"
        className={styles.checkInput}
        checked={checked}
        disabled={disabled}
        aria-label={label}
        ref={(element) => {
          if (element) {
            element.indeterminate = indeterminate;
          }
          inputRef?.(element);
        }}
        onChange={(event) => onChange(event.target.checked)}
      />
      {children !== undefined && children !== null ? <span className={styles.checkText}>{children}</span> : null}
    </label>
  );
}
