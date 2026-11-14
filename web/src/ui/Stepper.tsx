import { useEffect, useId, useState } from "react";

import { cx, useButtonLock } from "./base";
import styles from "./Field.module.css";
import { MinusIcon, PlusIcon } from "./icons";

export interface StepperProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  /** Vorgabe 1. */
  min?: number;
  max: number;
  /** Hinweis unter dem Feld. */
  hint?: string;
  className?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Mengenwähler: Minus, Zahl, Plus. Die Zahl lässt sich auch direkt eintippen;
 * beim Verlassen des Felds wird sie auf den erlaubten Bereich gebracht.
 * An der Grenze ist Minus bzw. Plus gesperrt; wer dorthin zählt, behält den Fokus (`useButtonLock`).
 */
export function Stepper({ label, value, onChange, min = 1, max, hint, className }: StepperProps) {
  const inputId = useId();
  const hintId = useId();
  const [text, setText] = useState(String(value));
  const less = useButtonLock({ disabled: value <= min, onClick: () => onChange(clamp(value - 1, min, max)) });
  const more = useButtonLock({ disabled: value >= max, onClick: () => onChange(clamp(value + 1, min, max)) });

  // Wert von außen geändert (Plus, Minus, Zurücksetzen): Text nachziehen.
  useEffect(() => {
    setText((current) => (Number(current) === value ? current : String(value)));
  }, [value]);

  function commit(raw: string) {
    const parsed = Number.parseInt(raw, 10);
    const next = Number.isNaN(parsed) ? value : clamp(parsed, min, max);
    setText(String(next));
    if (next !== value) {
      onChange(next);
    }
  }

  return (
    <div className={cx(styles.field, className)}>
      <label htmlFor={inputId} className={styles.label}>
        {label}
      </label>
      <div className={styles.stepper}>
        <button type="button" className={styles.step} aria-label="Weniger" {...less}>
          <MinusIcon size={20} aria-hidden="true" />
        </button>
        <input
          id={inputId}
          className={styles.stepValue}
          inputMode="numeric"
          autoComplete="off"
          value={text}
          aria-describedby={hint ? hintId : undefined}
          onChange={(event) => {
            const digits = event.target.value.replace(/\D/g, "").slice(0, 3);
            setText(digits);
            const parsed = Number.parseInt(digits, 10);
            if (!Number.isNaN(parsed) && parsed >= min && parsed <= max && parsed !== value) {
              onChange(parsed);
            }
          }}
          onBlur={(event) => commit(event.target.value)}
          onFocus={(event) => event.target.select()}
        />
        <button type="button" className={styles.step} aria-label="Mehr" {...more}>
          <PlusIcon size={20} aria-hidden="true" />
        </button>
      </div>
      {hint ? (
        <p id={hintId} className={styles.message}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
