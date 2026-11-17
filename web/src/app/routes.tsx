import type { ComponentType } from "react";
import { createBrowserRouter, type RouteObject } from "react-router";

import { ROUTES } from "@/contract";

import { NotFoundPage } from "./NotFoundPage";
import { usePageTitle } from "./Page";
import { CookPage, HistoryPage, LabelsPage, PrintersPage, SettingsPage, SetupPage, ShoppingPage, StatsPage, StockPage, SyncPage, WarningsPage, ZonesPage } from "./pages";
import { RouteError } from "./RouteError";
import { Shell } from "./Shell";

/**
 * Die Scan-Ansicht samt Titel des Browser-Tabs. Den Titel setzt der Rahmen der App, nicht die
 * Ansicht selbst: Sie kommt von außen herein (echte Ansicht oder Platzhalter der Attrappe)
 * und kennt `src/app` nicht.
 */
function ScanRoute({ page: ScanPage }: { page: ComponentType }) {
  usePageTitle("Scannen");
  return <ScanPage />;
}

/**
 * Alle Routen der App. Die Adressen stehen in src/contract/routes.ts. Die Ansichten des
 * Rahmens werden nachgeladen (pages.tsx); die Scan-Ansicht kommt als Komponente herein.
 */
export function appRoutes(ScanPage: ComponentType): RouteObject[] {
  return [
    // Vollbild, ohne Rahmen
    { path: ROUTES.scan, element: <ScanRoute page={ScanPage} />, errorElement: <RouteError /> },
    // Die Einrichtung mit dem Kürzel eines Schritts (/einrichtung/drucker); ohne Kürzel der erste offene.
    { path: `${ROUTES.setup}/:step?`, element: <SetupPage />, errorElement: <RouteError /> },
    {
      element: <Shell />,
      errorElement: <RouteError />,
      children: [
        {
          // Ein Fehler in einer Ansicht lässt den Rahmen stehen: Die Navigation bleibt benutzbar.
          errorElement: <RouteError />,
          children: [
            { path: ROUTES.stock, element: <StockPage /> },
            { path: ROUTES.shopping, element: <ShoppingPage /> },
            { path: ROUTES.zones, element: <ZonesPage /> },
            { path: ROUTES.warnings, element: <WarningsPage /> },
            { path: ROUTES.cook, element: <CookPage /> },
            { path: ROUTES.history, element: <HistoryPage /> },
            { path: ROUTES.stats, element: <StatsPage /> },
            { path: ROUTES.printers, element: <PrintersPage /> },
            { path: ROUTES.labels, element: <LabelsPage /> },
            { path: ROUTES.settings, element: <SettingsPage /> },
            { path: ROUTES.sync, element: <SyncPage /> },
            { path: "*", element: <NotFoundPage /> },
          ],
        },
      ],
    },
  ];
}

export function createAppRouter(ScanPage: ComponentType) {
  return createBrowserRouter(appRoutes(ScanPage));
}
