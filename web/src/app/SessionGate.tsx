import { useEffect, useState, type ReactNode } from "react";

import { ROUTES, useCore, useLive, type SessionState } from "@/contract";
import { LoginPage } from "@/features/auth";
import { movedTo, rememberMove } from "@/features/setup/navigateAway";
import { Logo } from "@/ui";
import { Spinner, useToast } from "@/ui/base";

import { FirstRunPage } from "./pages";
import styles from "./SessionGate.module.css";

/** So lange wartet die Schranke beim allerersten Start höchstens auf die Prüfung des Servers. */
export const FIRST_CHECK_MS = 4_000;

export interface SessionGateProps {
  children: ReactNode;
  /** Wird gerufen, sobald sich das Gerät bewusst abgemeldet hat (nicht bei gesperrtem Token). */
  onLogout?: () => void;
  /** Wird gerufen, bevor das erste Haushalts-Passwort gesetzt wird: Danach beginnt die Einrichtung. */
  onFirstRun?: () => void;
  /**
   * Wird gerufen, wenn sich das Gerät wieder anmeldet, nachdem der Wechsel zur HTTPS-Adresse es hier
   * abgemeldet hatte (die Seite dort ging wohl nicht auf): zurück zur Anleitung.
   */
  onResumeSetup?: () => void;
}

/** Läuft gerade die Einrichtung (/einrichtung…)? Dann sagt die Anmeldung, dass es danach weitergeht. */
function inSetup(): boolean {
  const path = window.location.pathname;
  return path === ROUTES.setup || path.startsWith(`${ROUTES.setup}/`);
}

/**
 * Zeigt die App nur angemeldeten Geräten. Abgemeldet:
 *
 * - Hat der Server noch kein Haushalts-Passwort (`server_configured === false`), die Willkommensseite,
 *   gleich aus welchem Grund das Gerät abgemeldet ist.
 * - War dieses Gerät noch nie angemeldet und hat der Kern den Server noch nicht gefragt, höchstens
 *   `FIRST_CHECK_MS` lang „Verbindung zum Server wird geprüft …": So erscheint bei einem neuen
 *   Server nicht erst die Anmeldung.
 * - Sonst die Anmeldung.
 */
export function SessionGate({ children, onLogout, onFirstRun, onResumeSetup }: SessionGateProps) {
  const core = useCore();
  const session = useLive<SessionState>(core.session.state, { status: "loading" });
  const status = useLive(core.sync.status);
  const loggedOut = session.status === "signed_out" && session.reason === "logout";
  const signedOut = session.status === "signed_out";
  const signedIn = session.status === "signed_in";
  const toast = useToast();
  const checking = session.status === "signed_out" && session.reason === "never" && status?.server_configured == null && status?.online == null;
  const [waited, setWaited] = useState(false);

  useEffect(() => {
    if (loggedOut) {
      onLogout?.();
    }
  }, [loggedOut, onLogout]);

  // Die Sitzung endet (abgemeldet oder gesperrt): Offene Meldungen samt „Rückgängig" gehören zur
  // App dahinter und hätten über der Anmeldung kein Ziel mehr.
  useEffect(() => {
    if (signedOut) {
      toast.dismissAll();
    }
  }, [signedOut, toast]);

  // Wieder angemeldet, obwohl Stowly zur HTTPS-Adresse umgezogen ist: Der Hinweis hat sich
  // erledigt, und es geht zurück zur Anleitung für die sichere Verbindung.
  useEffect(() => {
    if (signedIn && movedTo() !== null) {
      rememberMove(null);
      onResumeSetup?.();
    }
  }, [signedIn, onResumeSetup]);

  useEffect(() => {
    if (!checking) {
      return;
    }
    const timer = setTimeout(() => setWaited(true), FIRST_CHECK_MS);
    return () => clearTimeout(timer);
  }, [checking]);

  if (session.status === "loading") {
    return (
      <div className={styles.loading}>
        <Logo size="lg" />
        <Spinner size={24} label="Stowly wird geladen" />
      </div>
    );
  }
  if (session.status === "signed_out") {
    if (status?.server_configured === false) {
      return <FirstRunPage onFirstRun={onFirstRun} />;
    }
    if (checking && !waited) {
      return (
        <div className={styles.loading}>
          <Logo size="lg" />
          <Spinner size={24} label="Verbindung zum Server wird geprüft" />
          <span className={styles.muted} aria-hidden="true">
            Verbindung zum Server wird geprüft …
          </span>
        </div>
      );
    }
    return <LoginPage reason={session.reason} lastDeviceName={session.last_device_name} context={inSetup() ? "setup" : undefined} movedTo={movedTo()} />;
  }
  return <>{children}</>;
}
