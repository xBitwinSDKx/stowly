import { Suspense, useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, ScrollRestoration, useLocation, useNavigate } from "react-router";

import { ROUTES, useCore, useLive } from "@/contract";
import { useLogout } from "@/features/auth/logout";
import { UnknownLabelsBanner } from "@/features/printers/UnknownLabels";
import { useOpenLabels } from "@/features/printers/usePrinting";
import { useStock } from "@/features/stock/useStock";
import { summarizeSync, type SyncSummary } from "@/features/sync/status";
import { DESKTOP_QUERY, Logo, Menu, Notice, plural, useMediaQuery } from "@/ui";
import { Badge, Button, cx, IconButton, TextField } from "@/ui/base";
import {
  AlertCircleIcon,
  BellIcon,
  ChevronDownIcon,
  CloseIcon,
  CloudCheckIcon,
  CloudIcon,
  CloudOffIcon,
  HistoryIcon,
  LockOpenIcon,
  LogOutIcon,
  MenuIcon,
  MonitorIcon,
  PlusIcon,
  PrinterIcon,
  RefreshIcon,
  SearchIcon,
  SettingsIcon,
} from "@/ui/icons";

import { primaryDestinations, SECONDARY_DESTINATIONS } from "./destinations";
import { CONTENT_ID, refocusContent } from "./focus";
import { InstallHint } from "./InstallHint";
import { MobileMenu } from "./MobileMenu";
import { PageLoading } from "./Page";
import { preloadPages } from "./pages";
import { SearchProvider, useSearch } from "./search";
import styles from "./Shell.module.css";

function SyncGlyph({ tone, size = 18 }: { tone: SyncSummary["tone"]; size?: number }) {
  switch (tone) {
    case "ok":
      return <CloudCheckIcon size={size} aria-hidden="true" />;
    case "busy":
      return <RefreshIcon size={size} aria-hidden="true" className={styles.spin} />;
    case "offline":
      return <CloudOffIcon size={size} aria-hidden="true" />;
    case "error":
      return <AlertCircleIcon size={size} aria-hidden="true" />;
    default:
      return <CloudIcon size={size} aria-hidden="true" />;
  }
}

/** Sync-Anzeiger: erreichbar oder offline, Zahl der ungesendeten Änderungen; führt zur Sync-Ansicht. */
function SyncIndicator({ summary, compact }: { summary: SyncSummary; compact: boolean }) {
  const attention = summary.tone === "offline" || summary.tone === "error";
  const showCount = summary.pending > 0 && summary.tone !== "pending";
  return (
    <NavLink
      to={ROUTES.sync}
      className={cx(styles.pill, styles.sync, compact && styles.compact, attention && styles.attention)}
      aria-label={`Sync-Status: ${summary.label}${summary.pending > 0 ? `, ${String(summary.pending)} ungesendet` : ""}`}
      title={summary.detail}
    >
      <SyncGlyph tone={summary.tone} />
      {compact ? null : <span>{summary.label}</span>}
      {showCount ? (
        <Badge tone="warn" solid={compact} className={compact ? styles.counter : undefined}>
          {summary.pending}
        </Badge>
      ) : null}
    </NavLink>
  );
}

/** Suchfeld der Kopfzeile. Tippt jemand in einer anderen Ansicht, wechselt die App zum Bestand. */
function SearchField({ desktop }: { desktop: boolean }) {
  const { query, setQuery } = useSearch();
  const location = useLocation();
  const navigate = useNavigate();
  const ref = useRef<HTMLInputElement>(null);

  // „/" setzt den Fokus ins Suchfeld, solange nicht gerade irgendwo getippt wird.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
        return;
      }
      if (document.querySelector("dialog[open]")) {
        return;
      }
      event.preventDefault();
      ref.current?.focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function change(value: string) {
    setQuery(value);
    if (value.trim() !== "" && location.pathname !== ROUTES.stock) {
      void navigate(ROUTES.stock);
    }
  }

  return (
    <form
      role="search"
      className={styles.search}
      onSubmit={(event) => {
        event.preventDefault();
        // Am Handy: Tastatur einklappen, die Treffer stehen schon da.
        ref.current?.blur();
        if (location.pathname !== ROUTES.stock) {
          void navigate(ROUTES.stock);
        }
      }}
    >
      <TextField
        ref={ref}
        label="Bestand durchsuchen"
        hideLabel
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        placeholder={desktop ? "Produkt, Marke, Barcode oder Packungs-ID suchen" : "Bestand durchsuchen"}
        value={query}
        onChange={(event) => change(event.target.value)}
        leading={<SearchIcon aria-hidden="true" />}
        trailing={
          query !== "" ? (
            <IconButton
              label="Suche leeren"
              size="sm"
              onClick={() => {
                setQuery("");
                ref.current?.focus();
              }}
            >
              <CloseIcon />
            </IconButton>
          ) : undefined
        }
      />
    </form>
  );
}

/**
 * Der Rahmen der App nach dem Entwurf.
 *
 * Desktop: schmale Seitenleiste (Logo, Navigation, unten „Abmelden" und eine Reihe kleiner
 * Symbole), Kopfzeile mit Suchfeld, Sync-Anzeiger, der Pille „MHD-Warnungen" und dem Geräte-Menü.
 * Handy: Suchfeld und Menü-Symbol oben, unten mittig der schwebende Plus-Knopf zum Scannen.
 */
export function Shell() {
  return (
    <SearchProvider>
      <ShellFrame />
    </SearchProvider>
  );
}

function ShellFrame() {
  const core = useCore();
  const logout = useLogout();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const session = useLive(core.session.state);
  const app = useLive(core.app.state);
  const sync = summarizeSync(useLive(core.sync.status));
  const { warnings, multiZone } = useStock();
  const labels = useOpenLabels();
  const [menuOpen, setMenuOpen] = useState(false);
  const [updating, setUpdating] = useState(false);

  const deviceName = session?.status === "signed_in" ? session.device.name : "";
  // Über http://<LAN-IP> verweigert der Browser die Kamera: keine Zugänge zum Scannen.
  const canScan = app?.secure_context !== false;
  const showFab = !desktop && canScan;
  const primary = primaryDestinations(multiZone);

  // Meldungen liegen am Handy über dem schwebenden Knopf, nicht darunter.
  useEffect(() => {
    if (!showFab) {
      return;
    }
    const root = document.documentElement;
    root.style.setProperty("--toast-offset", "var(--fab-clearance)");
    return () => {
      root.style.removeProperty("--toast-offset");
    };
  }, [showFab]);

  useEffect(() => {
    if (desktop) {
      setMenuOpen(false);
    }
  }, [desktop]);

  // Kurz nach dem Start alle Ansichten holen: Danach wartet kein Wechsel mehr auf das Netz.
  useEffect(() => {
    const timer = setTimeout(() => void preloadPages(), 1500);
    return () => clearTimeout(timer);
  }, []);

  async function applyUpdate() {
    setUpdating(true);
    try {
      await core.app.applyUpdate();
    } finally {
      setUpdating(false);
      // Lädt die App nicht neu (keine wartende Version mehr), ist der Hinweis samt Schaltfläche fort.
      refocusContent();
    }
  }

  return (
    <div className={styles.shell}>
      <a
        href={`#${CONTENT_ID}`}
        className={styles.skip}
        onClick={(event) => {
          // Fokus setzen statt die Adresse zu ändern: Die gehört dem Router.
          event.preventDefault();
          document.getElementById(CONTENT_ID)?.focus();
        }}
      >
        Zum Inhalt springen
      </a>

      {desktop ? (
        <aside className={styles.sidebar}>
          <Link to={ROUTES.stock} className={styles.brand} aria-label="Stowly: zum Bestand">
            <Logo />
          </Link>
          <nav aria-label="Hauptnavigation" className={styles.nav}>
            {primary.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.to === ROUTES.stock} className={({ isActive }) => cx(styles.link, isActive && styles.active)}>
                <item.icon size={20} aria-hidden="true" />
                <span>{item.label}</span>
              </NavLink>
            ))}
          </nav>
          <div className={styles.sidebarEnd}>
            <Button block icon={<LogOutIcon />} onClick={logout}>
              Abmelden
            </Button>
            <nav aria-label="Weitere Bereiche" className={styles.quick}>
              {SECONDARY_DESTINATIONS.map((item) => {
                // Offene Etiketten stehen als Zahl am Drucker-Symbol; fragt die App nach, in Bernstein.
                const open = item.to === ROUTES.printers ? labels.open : 0;
                const label = open > 0 ? `${item.label}: ${plural(open, "Etikett offen", "Etiketten offen")}` : item.label;
                return (
                  <NavLink key={item.to} to={item.to} className={({ isActive }) => cx(styles.quickLink, isActive && styles.active)} aria-label={label} data-tip={label}>
                    {item.to === ROUTES.sync ? <SyncGlyph tone={sync.tone} size={20} /> : <item.icon size={20} aria-hidden="true" />}
                    {item.to === ROUTES.warnings && warnings.total > 0 ? <span className={styles.dot} /> : null}
                    {item.to === ROUTES.sync && (sync.tone === "offline" || sync.tone === "error") ? <span className={styles.dot} /> : null}
                    {open > 0 ? (
                      <span className={cx(styles.count, labels.asking > 0 && styles.countWarn)} aria-hidden="true">
                        {open > 99 ? "99+" : open}
                      </span>
                    ) : null}
                  </NavLink>
                );
              })}
            </nav>
          </div>
        </aside>
      ) : null}

      <div className={styles.main}>
        <header className={styles.header}>
          <SearchField desktop={desktop} />
          <div className={styles.headerEnd}>
            <SyncIndicator summary={sync} compact={!desktop} />
            {desktop ? (
              <>
                <NavLink to={ROUTES.warnings} className={cx(styles.pill, styles.warnings)}>
                  <BellIcon size={18} aria-hidden="true" />
                  <span>MHD-Warnungen</span>
                  <Badge tone={warnings.total > 0 ? "warn" : "neutral"} solid={warnings.total > 0}>
                    {warnings.total}
                  </Badge>
                </NavLink>
                <Menu
                  label="Geräte-Menü"
                  className={cx(styles.pill, styles.device)}
                  header={
                    <>
                      Angemeldet als <strong className={styles.deviceStrong}>{deviceName}</strong>
                    </>
                  }
                  items={[
                    { key: "settings", label: "Einstellungen", icon: <SettingsIcon />, to: ROUTES.settings },
                    { key: "sync", label: "Sync-Status", icon: <RefreshIcon />, to: ROUTES.sync },
                    { key: "history", label: "Lösch-Historie", icon: <HistoryIcon />, to: ROUTES.history },
                    { key: "printers", label: "Drucker", icon: <PrinterIcon />, to: ROUTES.printers },
                    { key: "logout", label: "Abmelden", icon: <LogOutIcon />, onSelect: logout, tone: "danger", separated: true },
                  ]}
                >
                  <MonitorIcon size={18} aria-hidden="true" />
                  <span className={styles.deviceName}>{deviceName}</span>
                  <ChevronDownIcon size={16} aria-hidden="true" />
                </Menu>
              </>
            ) : (
              <IconButton label="Menü" aria-haspopup="dialog" onClick={() => setMenuOpen(true)}>
                <MenuIcon />
              </IconButton>
            )}
          </div>
        </header>

        {app?.update_ready && !app.update_required ? (
          <Notice
            banner
            tone="accent"
            role="status"
            icon={<RefreshIcon />}
            title="Neue Version"
            action={
              <Button size="sm" variant="primary" busy={updating} onClick={() => void applyUpdate()}>
                Jetzt aktualisieren
              </Button>
            }
          >
            Eine neue Version von Stowly ist geladen und wartet auf den Neustart.
          </Notice>
        ) : null}
        {app?.secure_context === false ? (
          <Notice banner tone="warn" icon={<LockOpenIcon />} title="Kein Scannen über diese Adresse">
            Scannen und Offline-Betrieb brauchen die HTTPS-Adresse von Stowly. Über eine http-Adresse läuft die App nur online und ohne Kamera.
          </Notice>
        ) : null}
        <UnknownLabelsBanner />
        <InstallHint />

        <main id={CONTENT_ID} tabIndex={-1} className={cx(styles.content, showFab && styles.withFab)}>
          <Suspense fallback={<PageLoading />}>
            <Outlet />
          </Suspense>
        </main>
      </div>

      {showFab ? (
        <Link to={ROUTES.scan} className={styles.fab} aria-label="Jetzt scannen" title="Jetzt scannen">
          <PlusIcon size={30} aria-hidden="true" />
        </Link>
      ) : null}

      {desktop ? null : (
        <MobileMenu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          primary={primary}
          deviceName={deviceName}
          warnings={warnings.total}
          labels={labels}
          sync={sync}
          onLogout={() => {
            setMenuOpen(false);
            logout();
          }}
        />
      )}

      {/*
        Neue Ansicht: oben beginnen. Zurück und Neuladen: die alte Stelle wiederfinden.
        Der erste Aufruf einer Adresse hat immer denselben Schlüssel ("default"); dort
        entscheidet deshalb der Pfad, sonst erbte eine frisch geöffnete Ansicht die
        Scroll-Stelle einer anderen.
      */}
      <ScrollRestoration getKey={(location) => (location.key === "default" ? location.pathname : location.key)} />
    </div>
  );
}
