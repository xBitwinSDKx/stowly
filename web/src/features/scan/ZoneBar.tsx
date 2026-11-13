import { useEffect, useRef } from "react";

import type { Zone } from "@/contract";
import { cx, zoneColor, ZoneIcon } from "@/ui/base";

import styles from "./ScanPage.module.css";

export interface ZoneBarProps {
  zones: readonly Zone[];
  /** Die Zone, in die der nächste Einlager-Vorgang geht. */
  currentId: string | null;
  /** Die Primärzone, nur im Modus „Primärzone" gekennzeichnet; sonst null. */
  primaryId: string | null;
  /** true: Die aktuelle Zone gilt nur für den nächsten Einlager-Vorgang. */
  temporary: boolean;
  onSelect: (zoneId: string) => void;
}

/**
 * Zonenleiste: alle Zonen nebeneinander, zum Antippen; bei vielen Zonen zum Wischen.
 * Die Ansicht zeigt sie nur, wenn es mehr als eine Zone gibt.
 */
export function ZoneBar({ zones, currentId, primaryId, temporary, onSelect }: ZoneBarProps) {
  const currentRef = useRef<HTMLButtonElement>(null);

  // Die aktuelle Zone bleibt im Blick, auch wenn sie per Etikett gewechselt wurde.
  useEffect(() => {
    currentRef.current?.scrollIntoView?.({ block: "nearest", inline: "center" });
  }, [currentId]);

  return (
    <nav className={styles.zones} aria-label="Zone für das Einlagern">
      <div className={styles.zoneList} role="radiogroup" aria-label="Zone">
        {zones.map((zone) => {
          const current = zone.id === currentId;
          return (
            <button
              key={zone.id}
              ref={current ? currentRef : undefined}
              type="button"
              role="radio"
              aria-checked={current}
              className={cx(styles.zone, current && styles.zoneCurrent)}
              style={{ ["--zone-color" as string]: zoneColor(zone.color) }}
              onClick={() => onSelect(zone.id)}
            >
              <ZoneIcon icon={zone.icon} size={18} className={styles.zoneIcon} />
              <span className={styles.zoneName}>{zone.name}</span>
              {zone.id === primaryId ? <span className={styles.zoneMark}>Primär</span> : null}
            </button>
          );
        })}
      </div>
      {temporary ? <p className={styles.zoneNote}>Gilt nur für das nächste Einlagern, danach wieder die Primärzone.</p> : null}
    </nav>
  );
}
