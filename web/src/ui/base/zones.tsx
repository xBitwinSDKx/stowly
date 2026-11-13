import {
  Archive,
  Car,
  House,
  MapPin,
  Package,
  Refrigerator,
  Rows3,
  Snowflake,
  Thermometer,
  Warehouse,
  Wine,
  type LucideIcon,
} from "lucide-react";

/**
 * Symbole für Zonen. Der Schlüssel steht in `Zone.icon` und wird synchronisiert:
 * Schlüssel dürfen ergänzt, aber nie umbenannt oder entfernt werden.
 */
export const ZONE_ICONS = {
  box: { icon: Package, label: "Kiste" },
  shelf: { icon: Rows3, label: "Regal" },
  pantry: { icon: Archive, label: "Vorratsschrank" },
  fridge: { icon: Refrigerator, label: "Kühlschrank" },
  freezer: { icon: Snowflake, label: "Gefrierschrank" },
  cool: { icon: Thermometer, label: "Kühl" },
  cellar: { icon: Warehouse, label: "Keller" },
  drinks: { icon: Wine, label: "Getränke" },
  garage: { icon: Car, label: "Garage" },
  home: { icon: House, label: "Haus" },
  pin: { icon: MapPin, label: "Ort" },
} as const satisfies Record<string, { icon: LucideIcon; label: string }>;

export type ZoneIconKey = keyof typeof ZONE_ICONS;
export const ZONE_ICON_KEYS = Object.keys(ZONE_ICONS) as ZoneIconKey[];
export const DEFAULT_ZONE_ICON: ZoneIconKey = "box";

/**
 * Farben für Zonen. Der Schlüssel steht in `Zone.color` (null = "accent") und wird
 * synchronisiert: ergänzen ja, umbenennen oder entfernen nein.
 */
export const ZONE_COLORS = {
  accent: { css: "var(--color-accent)", label: "Akzent" },
  blue: { css: "var(--palette-blue)", label: "Blau" },
  amber: { css: "var(--palette-amber)", label: "Bernstein" },
  violet: { css: "var(--palette-violet)", label: "Violett" },
  rose: { css: "var(--palette-rose)", label: "Rosé" },
  lime: { css: "var(--palette-lime)", label: "Limette" },
  slate: { css: "var(--palette-slate)", label: "Schiefer" },
} as const satisfies Record<string, { css: string; label: string }>;

export type ZoneColorKey = keyof typeof ZONE_COLORS;
export const ZONE_COLOR_KEYS = Object.keys(ZONE_COLORS) as ZoneColorKey[];

/** CSS-Farbe einer Zone für `style={{ color: zoneColor(zone.color) }}`. Unbekanntes wird zur Akzentfarbe. */
export function zoneColor(color: string | null | undefined): string {
  if (color && Object.hasOwn(ZONE_COLORS, color)) {
    return ZONE_COLORS[color as ZoneColorKey].css;
  }
  return ZONE_COLORS.accent.css;
}

export interface ZoneIconProps {
  /** `Zone.icon`. Unbekannte Schlüssel zeigen die Kiste. */
  icon: string;
  /** Kantenlänge in Pixeln. Vorgabe 20. */
  size?: number;
  className?: string;
}

/** Das Symbol einer Zone, rein dekorativ (der Name der Zone steht daneben). */
export function ZoneIcon({ icon, size = 20, className }: ZoneIconProps) {
  const entry = Object.hasOwn(ZONE_ICONS, icon) ? ZONE_ICONS[icon as ZoneIconKey] : ZONE_ICONS[DEFAULT_ZONE_ICON];
  const Icon = entry.icon;
  return <Icon size={size} className={className} aria-hidden="true" />;
}
