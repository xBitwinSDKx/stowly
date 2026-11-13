import type { CSSProperties, ReactNode } from "react";

import { cx } from "./base";
import styles from "./FilterCard.module.css";

export interface FilterCardProps {
  /** Name der Zone oder des Filters. */
  label: string;
  /** Symbol rechts oben. */
  icon: ReactNode;
  /** CSS-Farbe für Symbol, Balken und die Tönung der aktiven Karte, z. B. `zoneColor(zone.color)`. */
  color: string;
  /** Zahl hinter „Status". */
  count: number;
  /** Füllstand des Balkens, 0 bis 1. */
  share: number;
  /** Was die Zahl zählt, für Screenreader und Tooltip. Vorgabe "Packungen". */
  unit?: string;
  /** Die Karte ist der aktive Filter: farbig hinterlegt. */
  active: boolean;
  onClick: () => void;
  className?: string;
}

/**
 * Zonen-Karte nach dem Entwurf: Name, Symbol, Fortschrittsbalken, „Status: n".
 * Antippen schaltet den Filter ein und wieder aus.
 */
export function FilterCard({ label, icon, color, count, share, unit = "Packungen", active, onClick, className }: FilterCardProps) {
  const percent = Math.round(Math.min(1, Math.max(0, share)) * 100);
  return (
    <button
      type="button"
      className={cx(styles.card, active && styles.active, className)}
      style={{ "--card-color": color } as CSSProperties}
      aria-pressed={active}
      title={`${label}: ${String(count)} ${unit}`}
      onClick={onClick}
    >
      <span className={styles.head}>
        <span className={styles.label}>{label}</span>
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      </span>
      <span className={styles.track} aria-hidden="true">
        {count > 0 ? <span className={styles.fill} style={{ width: `${String(percent)}%` }} /> : null}
      </span>
      <span className={styles.status}>
        Status: <span className={cx(styles.count, "tabular")}>{count}</span>
        <span className="sr-only"> {unit}</span>
      </span>
    </button>
  );
}
