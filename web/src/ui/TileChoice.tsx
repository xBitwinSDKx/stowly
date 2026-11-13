import type { ReactNode } from "react";

import { cx } from "./base";
import { FieldGroup } from "./Field";
import styles from "./Field.module.css";

export interface TileOption<T extends string> {
  value: T;
  /** Name der Möglichkeit für Screenreader und Tooltip. */
  label: string;
  /** Was in der Kachel zu sehen ist: ein Symbol oder ein Farbfeld. */
  content: ReactNode;
}

export interface TileChoiceProps<T extends string> {
  label: string;
  options: readonly TileOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}

/** Auswahl aus kleinen Kacheln, z. B. das Symbol oder die Farbe einer Zone. */
export function TileChoice<T extends string>({ label, options, value, onChange, className }: TileChoiceProps<T>) {
  return (
    <FieldGroup label={label} className={className}>
      <div className={styles.tiles}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              className={cx(styles.tile, selected && styles.tileSelected)}
              aria-label={option.label}
              aria-pressed={selected}
              title={option.label}
              onClick={() => onChange(option.value)}
            >
              {option.content}
            </button>
          );
        })}
      </div>
    </FieldGroup>
  );
}

/** Farbfeld für eine Kachel: `<Swatch color={zoneColor(key)} />`. */
export function Swatch({ color }: { color: string }) {
  return <span className={styles.swatch} style={{ color }} aria-hidden="true" />;
}
