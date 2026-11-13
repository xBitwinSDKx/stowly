import { useMemo, type ComponentType } from "react";
import { RouterProvider } from "react-router/dom";

import { CoreProvider, type Core } from "@/contract";
import { ToastProvider } from "@/ui/base";

import { createAppRouter } from "./routes";
import { SessionGate } from "./SessionGate";

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
  return (
    <CoreProvider core={core}>
      <ToastProvider>
        <SessionGate>
          <RouterProvider router={router} />
        </SessionGate>
      </ToastProvider>
    </CoreProvider>
  );
}
