import { ROUTES } from "@/contract";
import type { SyncSummary } from "@/features/sync/status";
import { List, ListLink } from "@/ui";
import { Badge, Button, Dialog } from "@/ui/base";
import { LogOutIcon, SmartphoneIcon } from "@/ui/icons";

import { SECONDARY_DESTINATIONS, type Destination } from "./destinations";
import styles from "./MobileMenu.module.css";

export interface MobileMenuProps {
  open: boolean;
  onClose: () => void;
  /** Die Navigation des Entwurfs (Bestand, Zonen, Einstellungen). */
  primary: readonly Destination[];
  deviceName: string;
  /** Zahl der Packungen mit MHD-Warnung. */
  warnings: number;
  sync: SyncSummary;
  onLogout: () => void;
}

/**
 * Das Menü am Handy: schiebt sich von unten ein, damit jeder Eintrag mit dem Daumen
 * erreichbar ist. Enthält alles, was am Desktop Seitenleiste und Geräte-Menü zeigen.
 */
export function MobileMenu({ open, onClose, primary, deviceName, warnings, sync, onLogout }: MobileMenuProps) {
  function value(item: Destination) {
    if (item.to === ROUTES.warnings) {
      return warnings > 0 ? (
        <Badge tone="warn" solid>
          {warnings}
        </Badge>
      ) : undefined;
    }
    if (item.to === ROUTES.sync) {
      return sync.pending > 0 && sync.tone !== "pending" ? `${sync.label} · ${String(sync.pending)} ungesendet` : sync.label;
    }
    return undefined;
  }

  return (
    <Dialog open={open} onClose={onClose} title="Menü" variant="sheet">
      <nav aria-label="Hauptnavigation" className={styles.menu}>
        <List>
          {primary.map((item) => (
            <ListLink key={item.to} to={item.to} label={item.label} icon={<item.icon size={20} />} onClick={onClose} />
          ))}
        </List>
        <List>
          {SECONDARY_DESTINATIONS.map((item) => (
            <ListLink key={item.to} to={item.to} label={item.label} icon={<item.icon size={20} />} value={value(item)} onClick={onClose} />
          ))}
        </List>
      </nav>
      <div className={styles.device}>
        <span className={styles.deviceName}>
          <SmartphoneIcon size={18} aria-hidden="true" />
          <span>{deviceName}</span>
        </span>
        <Button icon={<LogOutIcon />} onClick={onLogout}>
          Abmelden
        </Button>
      </div>
    </Dialog>
  );
}
