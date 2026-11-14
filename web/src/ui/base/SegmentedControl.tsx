import type { KeyboardEvent, ReactNode } from "react";

import { cx } from "./cx";
import { useButtonLock } from "./lock";
import styles from "./SegmentedControl.module.css";

/** Pfeiltasten wie bei einer Gruppe von Optionsfeldern: wohin sie führen. */
const STEPS: Record<string, "next" | "previous" | "first" | "last"> = {
  ArrowRight: "next",
  ArrowDown: "next",
  ArrowLeft: "previous",
  ArrowUp: "previous",
  Home: "first",
  End: "last",
};

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

/** Ein Segment. Gesperrt verliert es den Fokus nicht: siehe `useButtonLock`. */
function Segment({ selected, disabled, onSelect, children }: { selected: boolean; disabled: boolean; onSelect: () => void; children: ReactNode }) {
  const lock = useButtonLock({
    disabled,
    onClick: () => {
      if (!selected) {
        onSelect();
      }
    },
  });
  return (
    <button type="button" role="radio" aria-checked={selected} {...lock} className={cx(styles.segment, selected && styles.selected)}>
      {children}
    </button>
  );
}

/**
 * Umschalter für wenige, sich ausschließende Möglichkeiten („Dunkel / Hell").
 * Mit der Tastatur wie Optionsfelder: Pfeiltasten (und Pos1, Ende) wählen die nächste Möglichkeit.
 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  block = false,
  size = "md",
  className,
}: SegmentedControlProps<T>) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = STEPS[event.key];
    const enabled = options.filter((option) => !option.disabled);
    if (step === undefined || enabled.length === 0 || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    event.preventDefault();
    const current = enabled.findIndex((option) => option.value === value);
    const last = enabled.length - 1;
    const index =
      step === "first"
        ? 0
        : step === "last"
          ? last
          : step === "next"
            ? current === -1 || current === last
              ? 0
              : current + 1
            : current <= 0
              ? last
              : current - 1;
    const target = enabled[index];
    if (!target) {
      return;
    }
    if (target.value !== value) {
      onChange(target.value);
    }
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button");
    buttons[options.indexOf(target)]?.focus();
  }

  return (
    <div role="radiogroup" aria-label={label} className={cx(styles.group, styles[size], block && styles.block, className)} onKeyDown={handleKeyDown}>
      {options.map((option) => (
        <Segment key={option.value} selected={option.value === value} disabled={option.disabled ?? false} onSelect={() => onChange(option.value)}>
          {option.label}
        </Segment>
      ))}
    </div>
  );
}
