import type { ReactNode } from "react";

import { useCore, useLive } from "@/contract";
import { LoginPage } from "@/features/auth";
import { Spinner } from "@/ui/base";

/** Zeigt die App nur angemeldeten Geräten, sonst die Anmeldung. */
export function SessionGate({ children }: { children: ReactNode }) {
  const core = useCore();
  const session = useLive(core.session.state, { status: "loading" });

  if (session.status === "loading") {
    return (
      <div style={{ display: "grid", placeItems: "center", flex: 1, color: "var(--color-text-muted)" }}>
        <Spinner size={28} label="Stowly wird geladen" />
      </div>
    );
  }
  if (session.status === "signed_out") {
    return <LoginPage reason={session.reason} />;
  }
  return <>{children}</>;
}
