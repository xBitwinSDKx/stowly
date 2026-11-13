/**
 * Die Symbole der Oberfläche an einer Stelle.
 *
 * Schlichte Linien-Symbole aus lucide-react unter den Namen, die die Ansichten verwenden.
 * Benennt lucide ein Symbol um, wird es nur hier angepasst. Das Glas von Stowly ist
 * selbst gezeichnet (im Stil der übrigen Symbole).
 */
import type { SVGProps } from "react";

export type { LucideIcon as IconType } from "lucide-react";

export {
  ArchiveArrowUp as RestoreIcon,
  ArrowDown as ArrowDownIcon,
  ArrowUp as ArrowUpIcon,
  Barcode as BarcodeIcon,
  Bell as BellIcon,
  Boxes as StockIcon,
  CalendarClock as CalendarClockIcon,
  Check as CheckIcon,
  ChevronDown as ChevronDownIcon,
  ChevronRight as ChevronRightIcon,
  ChevronUp as ChevronUpIcon,
  CircleCheck as CircleCheckIcon,
  CircleExclamationPoint as AlertCircleIcon,
  Clock as ClockIcon,
  Cloud as CloudIcon,
  CloudCheck as CloudCheckIcon,
  CloudOff as CloudOffIcon,
  Database as DatabaseIcon,
  Download as DownloadIcon,
  Eye as EyeIcon,
  EyeOff as EyeOffIcon,
  Info as InfoIcon,
  Layers as LayersIcon,
  LockOpen as LockOpenIcon,
  LogOut as LogOutIcon,
  MapPin as ZonesIcon,
  Menu as MenuIcon,
  Merge as MergeIcon,
  Minus as MinusIcon,
  Monitor as MonitorIcon,
  Moon as MoonIcon,
  Package as PackageIcon,
  PackageOpen as PackageOpenIcon,
  PackagePlus as PackagePlusIcon,
  Pencil as PencilIcon,
  Plus as PlusIcon,
  Printer as PrinterIcon,
  QrCode as QrCodeIcon,
  RefreshCw as RefreshIcon,
  RotateCcwClock as HistoryIcon,
  ScanLine as ScanIcon,
  Search as SearchIcon,
  Settings as SettingsIcon,
  ShieldCheck as ShieldCheckIcon,
  Smartphone as SmartphoneIcon,
  Sun as SunIcon,
  Tag as TagIcon,
  Trash as TrashIcon,
  TriangleExclamationPoint as WarningIcon,
  Undo2 as UndoIcon,
  Vibrate as VibrateIcon,
  Volume2 as SoundIcon,
  X as CloseIcon,
} from "lucide-react";

export interface JarIconProps extends Omit<SVGProps<SVGSVGElement>, "ref"> {
  /** Kantenlänge in Pixeln. Vorgabe 24. */
  size?: number;
}

/** Das Glas: Deckel, Körper, Etikett. Zeichen von Stowly, wie im App-Symbol. */
export function JarIcon({ size = 24, ...rest }: JarIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <rect x="6.5" y="2.5" width="11" height="3.5" rx="1.25" />
      <rect x="5" y="8.5" width="14" height="13" rx="3" />
      <rect x="9" y="12.5" width="6" height="5" rx="1" />
    </svg>
  );
}
