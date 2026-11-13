import type { ReactNode } from "react";

import { cx } from "./cx";
import styles from "./SegmentedControl.module.css";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  /** Beschreibt die Auswahl für Screenreader, z. B. „Thema". */
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Volle Breite, alle Segmente gleich breit. */
  block?: boolean;
  /** "lg" für Daumenbedienung. Vorgabe "md". */
  size?: "md" | "lg";
  className?: string;
}

/** Umschalter für wenige, sich ausschließende Möglichkeiten („Dunkel / Hell"). */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  block = false,
  size = "md",
  className,
}: SegmentedControlProps<T>) {
  return (
    <div role="radiogroup" aria-label={label} className={cx(styles.group, styles[size], block && styles.block, className)}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={option.disabled}
            className={cx(styles.segment, selected && styles.selected)}
            onClick={() => {
              if (!selected) {
                onChange(option.value);
              }
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
