/**
 * Das Design-System oberhalb der Grundbausteine: `import { StatCard, useToday } from "@/ui"`.
 *
 * Die Grundbausteine selbst (Button, Dialog, TextField, …) kommen aus "@/ui/base";
 * was hier liegt, baut darauf auf und gehört der Oberfläche.
 *
 * Bewusst nicht hier: `QrCode` ("@/ui/QrCode") und `CopyField` ("@/ui/CopyField"). Sie werden
 * direkt importiert, damit sie (und die Bibliothek für QR-Codes) nur in den nachgeladenen Teilen
 * landen, die sie brauchen, und das Hauptpaket klein bleibt.
 */
export { BEST_BEFORE_EXAMPLES, BestBeforeField, describeBestBefore, readBestBefore, type BestBeforeFieldProps, type BestBeforeInput } from "./BestBeforeField";
export { Checkbox, type CheckboxProps } from "./Checkbox";
export { ConfirmDialog, type ConfirmDialogProps } from "./ConfirmDialog";
export { EmptyState, type EmptyStateProps } from "./EmptyState";
export { errorText } from "./errors";
export { ExpiryLabel, type ExpiryLabelProps } from "./ExpiryLabel";
export { FieldGroup, type FieldGroupProps } from "./Field";
export { FilterCard, type FilterCardProps } from "./FilterCard";
export {
  deviceTimeZone,
  expiryText,
  formatBytes,
  otherTimeZone,
  packagesText,
  plural,
  relativeDays,
  REMOVAL_REASON_LABELS,
  REMOVAL_REASON_OPTIONS,
  timeAgo,
} from "./format";
export {
  DESKTOP_QUERY,
  focusFirstInvalid,
  LIST_FIRST,
  LIST_STEP,
  ROOMY_QUERY,
  useMediaQuery,
  useNow,
  useProgressiveCount,
  useToday,
  useUiFlag,
  useVisibleInterval,
  WIDE_QUERY,
} from "./hooks";
export { List, ListLink, ListRow, Section, type ListLinkProps, type ListRowProps, type SectionProps } from "./List";
export { Logo, type LogoProps } from "./Logo";
export { Menu, type MenuItem, type MenuProps } from "./Menu";
export { Notice, type NoticeProps, type NoticeTone } from "./Notice";
export { PackageId, PackageIds, type PackageIdsProps } from "./PackageIds";
export { PrintSheet } from "./PrintSheet";
export { Select, type SelectOption, type SelectProps } from "./Select";
export { StatCard, type StatCardProps, type StatTone } from "./StatCard";
export { Stepper, type StepperProps } from "./Stepper";
export { TextLink } from "./TextLink";
export { Swatch, TileChoice, type TileChoiceProps, type TileOption } from "./TileChoice";
export { ZoneLabel, type ZoneLabelProps } from "./ZoneLabel";
