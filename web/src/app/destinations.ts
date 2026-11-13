import { ROUTES } from "@/contract";
import { BellIcon, HistoryIcon, PrinterIcon, RefreshIcon, SettingsIcon, StockIcon, ZonesIcon, type IconType } from "@/ui/icons";

/** Ein Ziel der Navigation. */
export interface Destination {
  to: string;
  label: string;
  icon: IconType;
}

const STOCK: Destination = { to: ROUTES.stock, label: "Bestand", icon: StockIcon };
const ZONES: Destination = { to: ROUTES.zones, label: "Zonen", icon: ZonesIcon };
const SETTINGS: Destination = { to: ROUTES.settings, label: "Einstellungen", icon: SettingsIcon };

/**
 * Die Navigation des Entwurfs. „Zonen" gibt es nur mit mehr als einer Zone; die
 * Zonenverwaltung bleibt dann über die Einstellungen erreichbar.
 */
export function primaryDestinations(multiZone: boolean): Destination[] {
  return multiZone ? [STOCK, ZONES, SETTINGS] : [STOCK, SETTINGS];
}

/** Die weiteren Bereiche: kleine Symbole in der Seitenleiste, Einträge in den Menüs. */
export const SECONDARY_DESTINATIONS: readonly Destination[] = [
  { to: ROUTES.warnings, label: "Warnungen", icon: BellIcon },
  { to: ROUTES.history, label: "Lösch-Historie", icon: HistoryIcon },
  { to: ROUTES.printers, label: "Drucker", icon: PrinterIcon },
  { to: ROUTES.sync, label: "Sync-Status", icon: RefreshIcon },
];
