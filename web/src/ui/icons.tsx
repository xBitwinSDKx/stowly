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
  Ban as BanIcon,
  Barcode as BarcodeIcon,
  Bell as BellIcon,
  BellOff as BellOffIcon,
  BellRing as BellRingIcon,
  Boxes as StockIcon,
  CalendarClock as CalendarClockIcon,
  ChartColumn as StatsIcon,
  Check as CheckIcon,
  ChevronDown as ChevronDownIcon,
  ChevronRight as ChevronRightIcon,
  ChevronUp as ChevronUpIcon,
  CircleCheck as CircleCheckIcon,
  CircleExclamationPoint as AlertCircleIcon,
  CircleQuestionMark as QuestionIcon,
  CircleX as CircleXIcon,
  Clock as ClockIcon,
  Cloud as CloudIcon,
  CloudCheck as CloudCheckIcon,
  CloudOff as CloudOffIcon,
  Cpu as CpuIcon,
  Database as DatabaseIcon,
  Download as DownloadIcon,
  ExternalLink as ExternalLinkIcon,
  Eye as EyeIcon,
  EyeOff as EyeOffIcon,
  Hourglass as HourglassIcon,
  Image as ImageIcon,
  Info as InfoIcon,
  Layers as LayersIcon,
  ListPlus as AddToListIcon,
  LockOpen as LockOpenIcon,
  LogOut as LogOutIcon,
  MapPin as ZonesIcon,
  Menu as MenuIcon,
  Merge as MergeIcon,
  Minus as MinusIcon,
  Monitor as MonitorIcon,
  MonitorDown as InstallIcon,
  Moon as MoonIcon,
  Package as PackageIcon,
  PackageMinus as PackageMinusIcon,
  PackageOpen as PackageOpenIcon,
  PackagePlus as PackagePlusIcon,
  Pencil as PencilIcon,
  Plug as PlugIcon,
  Plus as PlusIcon,
  Printer as PrinterIcon,
  QrCode as QrCodeIcon,
  RefreshCw as RefreshIcon,
  RotateCcwClock as HistoryIcon,
  RotateCw as RetryIcon,
  ScanLine as ScanIcon,
  Search as SearchIcon,
  Send as SendIcon,
  Server as ServerIcon,
  Settings as SettingsIcon,
  Share as ShareIcon,
  ShieldCheck as ShieldCheckIcon,
  ShoppingCart as ShoppingIcon,
  Smartphone as SmartphoneIcon,
  SquarePlus as AddSquareIcon,
  Sun as SunIcon,
  Tag as TagIcon,
  Tags as LabelsIcon,
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
