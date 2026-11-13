import { useCallback, useContext, useState, type ReactNode } from "react";

import { isCoreError, useCore, useLive } from "@/contract";
import { ConfirmDialog, errorText, plural } from "@/ui";

import { LogoutContext } from "./logout-context";

/**
 * Stellt `useLogout()` bereit und zeichnet die Rückfrage dazu.
 *
 * Abmelden löscht die lokale Kopie, deshalb wird immer nachgefragt. Liegen ungesendete
 * Änderungen vor (laut Sync-Zustand oder weil der Kern `pending_changes` meldet), sagt die
 * Rückfrage das ausdrücklich; erst nach dieser Bestätigung wird mit `discard_pending` abgemeldet.
 */
export function LogoutProvider({ children }: { children: ReactNode }) {
  const core = useCore();
  const status = useLive(core.sync.status);
  const [open, setOpen] = useState(false);
  /** Vom Kern gemeldete Zahl, falls er `pending_changes` geworfen hat. */
  const [reported, setReported] = useState<number | null>(null);

  const pending = reported ?? status?.pending ?? 0;

  const request = useCallback(() => {
    setReported(null);
    setOpen(true);
  }, []);

  async function confirm() {
    try {
      await core.session.logout(pending > 0 ? { discard_pending: true } : undefined);
      setOpen(false);
    } catch (error) {
      if (isCoreError(error, "pending_changes")) {
        // Seit dem Öffnen der Rückfrage ist etwas dazugekommen: erst noch einmal fragen.
        const count = Number(error.details.pending);
        setReported(Number.isFinite(count) && count > 0 ? count : 1);
        return;
      }
      throw error;
    }
  }

  return (
    <LogoutContext.Provider value={request}>
      {children}
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={pending > 0 ? "Ungesendete Änderungen verwerfen?" : "Dieses Gerät abmelden?"}
        confirmLabel={pending > 0 ? "Verwerfen und abmelden" : "Abmelden"}
        tone={pending > 0 ? "danger" : "primary"}
        onConfirm={confirm}
        errorText={(error) => errorText(error)}
      >
        {pending > 0 ? (
          <>
            <p>
              <strong>{plural(pending, "Änderung", "Änderungen")}</strong> von diesem Gerät {pending === 1 ? "ist" : "sind"} noch nicht beim Server
              angekommen. Beim Abmelden {pending === 1 ? "geht sie" : "gehen sie"} verloren.
            </p>
            <p>Besser erst abgleichen, sobald der Server erreichbar ist, und danach abmelden.</p>
          </>
        ) : (
          <p>
            Die lokale Kopie der Daten wird von diesem Gerät gelöscht; der Bestand selbst bleibt erhalten. Für die nächste Anmeldung braucht es das
            Haushalts-Passwort und eine Verbindung zum Server.
          </p>
        )}
      </ConfirmDialog>
    </LogoutContext.Provider>
  );
}

/** Startet das Abmelden dieses Geräts (mit Rückfrage). Nur innerhalb von `LogoutProvider`. */
export function useLogout(): () => void {
  const request = useContext(LogoutContext);
  if (request === null) {
    throw new Error("useLogout() außerhalb von <LogoutProvider> aufgerufen.");
  }
  return request;
}
