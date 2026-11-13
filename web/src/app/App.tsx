import { useCallback, useMemo, type ComponentType } from "react";
import { RouterProvider } from "react-router/dom";

import { CoreProvider, ROUTES, type Core } from "@/contract";
import { LogoutProvider } from "@/features/auth/logout";
import { ToastProvider } from "@/ui/base";

import { ErrorBoundary } from "./ErrorBoundary";
import { createAppRouter } from "./routes";
import { SessionGate } from "./SessionGate";
import { UpdateRequired } from "./UpdateRequired";

/**
 * Diese Props sind die Nahtstelle zu src/main.tsx und bleiben, wie sie sind:
 * Der Kern und die Scan-Ansicht werden von außen hereingereicht, damit die Oberfläche
 * weder src/core noch src/features/scan importieren muss.
 */
export interface AppProps {
  core: Core;
  /** Die Scan-Ansicht; sie füllt den ganzen Bildschirm und liegt außerhalb des Rahmens. */
  scanPage: ComponentType;
}

export function App({ core, scanPage }: AppProps) {
  const router = useMemo(() => createAppRouter(scanPage), [scanPage]);
  // Nach einem bewussten Abmelden beginnt die nächste Anmeldung wieder beim Bestand
  // und nicht in der Ansicht, in der abgemeldet wurde.
  const backToStart = useCallback(() => void router.navigate(ROUTES.stock, { replace: true }), [router]);
  return (
    <ErrorBoundary>
      <CoreProvider core={core}>
        <ToastProvider>
          <SessionGate onLogout={backToStart}>
            <LogoutProvider>
              <RouterProvider router={router} />
            </LogoutProvider>
          </SessionGate>
          {/* Über allem, auch über Anmeldung, Scan-Ansicht und offenen Dialogen */}
          <UpdateRequired />
        </ToastProvider>
      </CoreProvider>
    </ErrorBoundary>
  );
}
