import { Minus, Plus } from "lucide-react";

import { MAX_STORE_COUNT } from "@/contract";
import { IconButton } from "@/ui/base";

import styles from "./ScanPage.module.css";

export interface QuantityStepperProps {
  value: number;
  onChange: (value: number) => void;
  /** Beschriftung für Screenreader. */
  label?: string;
}

/** Mengen-Vorwahl: wie viele Packungen der nächste Einlager-Vorgang anlegt (1 bis 50). */
export function QuantityStepper({ value, onChange, label = "Menge" }: QuantityStepperProps) {
  return (
    <div className={styles.stepper} role="group" aria-label={label}>
      <IconButton label="Eine Packung weniger" variant="secondary" size="lg" disabled={value <= 1} onClick={() => onChange(Math.max(1, value - 1))}>
        <Minus />
      </IconButton>
      <output className={styles.stepperValue} aria-live="polite" aria-label={`${label}: ${value}`}>
        {value}
      </output>
      <IconButton label="Eine Packung mehr" variant="secondary" size="lg" disabled={value >= MAX_STORE_COUNT} onClick={() => onChange(Math.min(MAX_STORE_COUNT, value + 1))}>
        <Plus />
      </IconButton>
    </div>
  );
}
