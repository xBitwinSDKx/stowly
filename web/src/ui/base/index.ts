/**
 * Grundbausteine der Oberfläche: `import { Button, Dialog, useToast } from "@/ui/base"`.
 *
 * Oberfläche und Scan-Ansichten benutzen diese Bausteine parallel. Ihre Schnittstellen
 * (Namen, Props) sind deshalb eingefroren; das Aussehen steckt in den .module.css-Dateien
 * daneben und in src/ui/tokens.css.
 *
 * Voraussetzung: tokens.css und global.css sind geladen (macht main.tsx) und um die App
 * liegt ein <ToastProvider>.
 */
export { Badge, type BadgeProps, type BadgeTone } from "./Badge";
export { Button, IconButton, type ButtonProps, type ButtonSize, type ButtonVariant, type IconButtonProps } from "./Button";
export { Card, type CardPadding, type CardProps, type CardTone } from "./Card";
export { cx } from "./cx";
export { Dialog, type DialogProps } from "./Dialog";
export { SegmentedControl, type SegmentedControlProps, type SegmentedOption } from "./SegmentedControl";
export { Spinner, type SpinnerProps } from "./Spinner";
export { Switch, type SwitchProps } from "./Switch";
export { TextField, type TextFieldProps } from "./TextField";
export { ToastProvider, useToast, type ToastApi, type ToastOptions, type ToastTone } from "./Toast";
export {
  DEFAULT_ZONE_ICON,
  ZONE_COLOR_KEYS,
  ZONE_COLORS,
  ZONE_ICON_KEYS,
  ZONE_ICONS,
  zoneColor,
  ZoneIcon,
  type ZoneColorKey,
  type ZoneIconKey,
  type ZoneIconProps,
} from "./zones";
