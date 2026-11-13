import { useEffect, type ReactNode } from "react";

import { useCore, useLive, type SessionState } from "@/contract";
import { LoginPage } from "@/features/auth";
import { Logo } from "@/ui";
import { Spinner } from "@/ui/base";

import styles from "./SessionGate.module.css";

export interface SessionGateProps {
  children: ReactNode;
  /** Wird gerufen, sobald sich das Gerät bewusst abgemeldet hat (nicht bei gesperrtem Token). */
  onLogout?: () => void;
}

/** Zeigt die App nur angemeldeten Geräten, sonst die Anmeldung. */
export function SessionGate({ children, onLogout }: SessionGateProps) {
  const core = useCore();
  const session = useLive<SessionState>(core.session.state, { status: "loading" });
  const loggedOut = session.status === "signed_out" && session.reason === "logout";

  useEffect(() => {
    if (loggedOut) {
      onLogout?.();
    }
  }, [loggedOut, onLogout]);

  if (session.status === "loading") {
    return (
      <div className={styles.loading}>
        <Logo size="lg" />
        <Spinner size={24} label="Stowly wird geladen" />
      </div>
    );
  }
  if (session.status === "signed_out") {
    return <LoginPage reason={session.reason} />;
  }
  return <>{children}</>;
}
