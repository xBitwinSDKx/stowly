import { ROUTES } from "@/contract";
import { BellIcon, ChefHatIcon, HistoryIcon, PrinterIcon, RefreshIcon, SettingsIcon, ShoppingIcon, StatsIcon, StockIcon, ZonesIcon, type IconType } from "@/ui/icons";

/** Ein Ziel der Navigation. */
export interface Destination {
  to: string;
  label: string;
  icon: IconType;
}

const STOCK: Destination = { to: ROUTES.stock, label: "Bestand", icon: StockIcon };
const SHOPPING: Destination = { to: ROUTES.shopping, label: "Einkaufsliste", icon: ShoppingIcon };
const ZONES: Destination = { to: ROUTES.zones, label: "Zonen", icon: ZonesIcon };
const SETTINGS: Destination = { to: ROUTES.settings, label: "Einstellungen", icon: SettingsIcon };

/**
 * Die Navigation des Entwurfs. Die Einkaufsliste steht gleich hinter dem Bestand: Am Handy ist
 * sie im Laden die wichtigste Ansicht. „Zonen" gibt es nur mit mehr als einer Zone; die
 * Zonenverwaltung bleibt dann über die Einstellungen erreichbar.
 */
export function primaryDestinations(multiZone: boolean): Destination[] {
  return multiZone ? [STOCK, SHOPPING, ZONES, SETTINGS] : [STOCK, SHOPPING, SETTINGS];
}

/**
 * Die weiteren Bereiche: kleine Symbole in der Seitenleiste, Einträge in den Menüs. „Was koche ich?"
 * folgt den Warnungen: Es macht aus dem, was bald abläuft, ein Essen. Die Statistik steht neben der
 * Lösch-Historie: Beide zeigen, was entnommen wurde.
 */
export const SECONDARY_DESTINATIONS: readonly Destination[] = [
  { to: ROUTES.warnings, label: "Warnungen", icon: BellIcon },
  { to: ROUTES.cook, label: "Was koche ich?", icon: ChefHatIcon },
  { to: ROUTES.history, label: "Lösch-Historie", icon: HistoryIcon },
  { to: ROUTES.stats, label: "Statistik", icon: StatsIcon },
  { to: ROUTES.printers, label: "Drucker", icon: PrinterIcon },
  { to: ROUTES.sync, label: "Sync-Status", icon: RefreshIcon },
];
