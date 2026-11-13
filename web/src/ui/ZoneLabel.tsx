import type { Zone } from "@/contract";

import { cx, zoneColor, ZoneIcon } from "./base";
import styles from "./ZoneLabel.module.css";

export interface ZoneLabelProps {
  /** Die Zone; undefined, wenn der Verweis (noch) ins Leere zeigt. */
  zone: Pick<Zone, "name" | "icon" | "color"> | undefined;
  /** Kantenlänge des Symbols. Vorgabe 16. */
  size?: number;
  /**
   * Lange Namen mit „…" kürzen, wenn der Platz nicht reicht. Vorgabe true.
   * In Tabellen false: Dort richtet sich die Spalte nach dem Namen.
   */
  truncate?: boolean;
  className?: string;
}

/** Name einer Zone mit ihrem Symbol in ihrer Farbe. Unbekannte Zonen bekommen einen Platzhalter. */
export function ZoneLabel({ zone, size = 16, truncate = true, className }: ZoneLabelProps) {
  if (!zone) {
    return <span className={cx(styles.zone, styles.unknown, !truncate && styles.full, className)}>Unbekannte Zone</span>;
  }
  return (
    <span className={cx(styles.zone, !truncate && styles.full, className)}>
      <span className={styles.icon} style={{ color: zoneColor(zone.color) }}>
        <ZoneIcon icon={zone.icon} size={size} />
      </span>
      <span className={styles.name}>{zone.name}</span>
    </span>
  );
}
