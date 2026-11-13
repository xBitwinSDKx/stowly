import { Bell, Boxes, CloudOff, History, LogOut, MapPin, Printer, RefreshCw, ScanLine, Settings, type LucideIcon } from "lucide-react";
import { NavLink, Outlet, useNavigate } from "react-router";

import { expiryState, isCoreError, ROUTES, todayLocal, useCore, useLive, warnDaysFor } from "@/contract";
import { Badge, Button, cx, IconButton, useToast } from "@/ui/base";

import styles from "./Shell.module.css";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Auch in der Leiste am Handy zeigen. */
  primary?: boolean;
}

const NAV: NavItem[] = [
  { to: ROUTES.stock, label: "Bestand", icon: Boxes, primary: true },
  { to: ROUTES.zones, label: "Zonen", icon: MapPin, primary: true },
  { to: ROUTES.warnings, label: "Warnungen", icon: Bell, primary: true },
  { to: ROUTES.history, label: "Lösch-Historie", icon: History },
  { to: ROUTES.printers, label: "Drucker", icon: Printer },
  { to: ROUTES.settings, label: "Einstellungen", icon: Settings, primary: true },
];

/** Zahl der Packungen, die abgelaufen sind oder bald ablaufen. */
function useWarningCount(): number {
  const core = useCore();
  const packages = useLive(core.data.packages, []);
  const products = useLive(core.data.products, []);
  const settings = useLive(core.data.settings);
  if (!settings) {
    return 0;
  }
  const today = todayLocal();
  const byId = new Map(products.map((product) => [product.id, product]));
  return packages.filter((pkg) => {
    const state = expiryState(pkg.best_before, warnDaysFor(byId.get(pkg.product_id), settings), today);
    return state === "soon" || state === "expired";
  }).length;
}

/**
 * Der Rahmen der App: Seitenleiste am Desktop, Kopfzeile, am Handy eine Leiste unten
 * mit dem Scan-Knopf. Grundgerüst; die Ausgestaltung nach dem Entwurf folgt in Runde 1.
 */
export function Shell() {
  const core = useCore();
  const toast = useToast();
  const navigate = useNavigate();
  const session = useLive(core.session.state);
  const sync = useLive(core.sync.status);
  const app = useLive(core.app.state);
  const warnings = useWarningCount();
  const deviceName = session?.status === "signed_in" ? session.device.name : "";
  const canScan = app?.secure_context !== false;

  async function logout() {
    try {
      await core.session.logout();
    } catch (error) {
      if (isCoreError(error, "pending_changes")) {
        toast.show({
          message: `${String(error.details.pending)} Änderungen sind noch nicht gesendet.`,
          tone: "warn",
          duration: 0,
          action: { label: "Trotzdem abmelden", onAction: () => void core.session.logout({ discard_pending: true }) },
        });
        return;
      }
      throw error;
    }
  }

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <img src="/icons/icon-192.png" alt="" width={32} height={32} />
          <span>Stowly</span>
        </div>
        <nav aria-label="Hauptnavigation" className={styles.nav}>
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === ROUTES.stock} className={({ isActive }) => cx(styles.link, isActive && styles.active)}>
              <item.icon size={20} aria-hidden="true" />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <Button icon={<LogOut />} onClick={() => void logout()}>
          Abmelden
        </Button>
      </aside>

      <div className={styles.main}>
        <header className={styles.header}>
          <div className={styles.brandSmall}>Stowly</div>
          <div className={styles.headerEnd}>
            <NavLink to={ROUTES.sync} className={styles.sync} aria-label="Sync-Status">
              {sync?.online === false ? <CloudOff size={18} aria-hidden="true" /> : <RefreshCw size={18} aria-hidden="true" />}
              <span>{sync?.online === false ? "Offline" : sync?.phase === "syncing" ? "Abgleich läuft" : "Aktuell"}</span>
              {sync && sync.pending > 0 ? <Badge tone="warn">{sync.pending}</Badge> : null}
            </NavLink>
            <NavLink to={ROUTES.warnings} className={styles.pill}>
              <Bell size={18} aria-hidden="true" />
              <span className={styles.pillLabel}>MHD-Warnungen</span>
              <Badge tone={warnings > 0 ? "warn" : "neutral"} solid={warnings > 0}>
                {warnings}
              </Badge>
            </NavLink>
            <span className={styles.device} title="Dieses Gerät">
              {deviceName}
            </span>
            <span className={styles.logoutSmall}>
              <IconButton label="Abmelden" onClick={() => void logout()}>
                <LogOut />
              </IconButton>
            </span>
          </div>
        </header>

        <main className={styles.content}>
          <Outlet />
        </main>
      </div>

      <nav aria-label="Hauptnavigation" className={styles.tabbar}>
        {NAV.filter((item) => item.primary).map((item) => (
          <NavLink key={item.to} to={item.to} end={item.to === ROUTES.stock} className={({ isActive }) => cx(styles.tab, isActive && styles.active)}>
            <item.icon size={22} aria-hidden="true" />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      {canScan ? (
        <button type="button" className={styles.fab} aria-label="Jetzt scannen" onClick={() => void navigate(ROUTES.scan)}>
          <ScanLine size={26} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
