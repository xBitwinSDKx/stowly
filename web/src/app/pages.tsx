import { useEffect, useReducer, useState, type ComponentType, type ReactNode } from "react";

import { ROUTES } from "@/contract";

import { PageLoading } from "./Page";

/**
 * Die Ansichten werden nachgeladen: Jede liegt in einem eigenen Teil der App, damit das
 * Hauptpaket klein bleibt. Offline fehlt trotzdem nichts, denn der Service Worker hält alle
 * Teile vor; und kurz nach dem Start holt der Rahmen sie ohnehin alle (`preloadPages`), damit
 * kein Wechsel der Ansicht warten muss und auch ohne Service Worker (http-Adresse) nichts fehlt,
 * wenn der Server später nicht mehr erreichbar ist.
 */
export interface LazyPage {
  (): ReactNode;
  /** Holt die Ansicht vorab. Danach zeichnet sie sofort, ohne Ladeanzeige. */
  preload(): Promise<void>;
}

/**
 * Eine nachgeladene Ansicht. Ist sie schon da (`preload`), wird sie ohne Umweg gezeichnet;
 * sonst steht „Lädt …" da, bis sie angekommen ist. Scheitert das Laden, fängt der Router den
 * Fehler ab (`RouteError`: „Neu laden").
 *
 * Bewusst ohne `React.lazy` und Suspense: React hält Inhalt, der nach einer Ladeanzeige
 * eintrifft, bis zu 300 Millisekunden zurück, damit nichts flackert. Beim Start der App hieße
 * das, der Bestand erschiene eine gute Viertelsekunde später, obwohl sein Teil längst da ist.
 */
export function lazyPage(load: () => Promise<ComponentType>): LazyPage {
  let Loaded: ComponentType | null = null;
  let failure: { error: unknown } | null = null;
  let pending: Promise<void> | null = null;
  /** Gezeichnete Ansichten, die auf das Laden warten. */
  const waiting = new Set<() => void>();

  function start(): Promise<void> {
    if (Loaded) {
      return Promise.resolve();
    }
    pending ??= load()
      .then(
        (component) => {
          Loaded = component;
          failure = null;
        },
        (error: unknown) => {
          // Ein späterer Versuch (die Ansicht wird aufgerufen, Neu laden) darf es noch einmal probieren.
          failure = { error };
          pending = null;
          throw error;
        },
      )
      .finally(() => {
        for (const notify of [...waiting]) {
          notify();
        }
      });
    return pending;
  }

  function Page() {
    const [, update] = useReducer((count: number) => count + 1, 0);
    // Ein Fehlschlag, den die Ansicht beim Aufruf schon vorfindet (etwa beim Vorabholen ohne
    // Netz), gilt ihr nicht: Sie versucht es noch einmal, statt gleich den alten Fehler zu zeigen.
    const [earlier] = useState(() => failure);
    const failed = failure !== null && failure !== earlier;
    const settled = Loaded !== null || failed;
    useEffect(() => {
      if (Loaded !== null || (failure !== null && failure !== earlier)) {
        // Zwischen Zeichnen und Effekt angekommen: noch einmal zeichnen.
        if (!settled) {
          update();
        }
        return;
      }
      waiting.add(update);
      start().catch(() => undefined);
      return () => {
        waiting.delete(update);
      };
    }, [settled, earlier]);

    if (Loaded) {
      return <Loaded />;
    }
    if (failure !== null && failure !== earlier) {
      throw failure.error;
    }
    return <PageLoading />;
  }
  Page.preload = start;
  return Page;
}

export const StockPage = lazyPage(() => import("@/features/stock").then((module) => module.StockPage));
export const ZonesPage = lazyPage(() => import("@/features/zones").then((module) => module.ZonesPage));
export const WarningsPage = lazyPage(() => import("@/features/warnings").then((module) => module.WarningsPage));
export const HistoryPage = lazyPage(() => import("@/features/history").then((module) => module.HistoryPage));
export const PrintersPage = lazyPage(() => import("@/features/printers").then((module) => module.PrintersPage));
export const SettingsPage = lazyPage(() => import("@/features/settings").then((module) => module.SettingsPage));
export const SyncPage = lazyPage(() => import("@/features/sync").then((module) => module.SyncPage));
export const ShoppingPage = lazyPage(() => import("@/features/shopping").then((module) => module.ShoppingPage));

const BY_PATH: Readonly<Record<string, LazyPage>> = {
  [ROUTES.stock]: StockPage,
  [ROUTES.zones]: ZonesPage,
  [ROUTES.warnings]: WarningsPage,
  [ROUTES.history]: HistoryPage,
  [ROUTES.printers]: PrintersPage,
  [ROUTES.settings]: SettingsPage,
  [ROUTES.sync]: SyncPage,
  [ROUTES.shopping]: ShoppingPage,
};

const ALL: readonly LazyPage[] = Object.values(BY_PATH);

/** Holt alle Ansichten vorab. Scheitert eine (kein Netz), bleibt es beim Nachladen, wenn sie gebraucht wird. */
export function preloadPages(): Promise<void> {
  return Promise.allSettled(ALL.map((page) => page.preload())).then(() => undefined);
}

/**
 * Holt die Ansicht der aufgerufenen Adresse schon beim Start, gleichzeitig mit dem Hochfahren
 * der App, statt erst, wenn der Rahmen steht: Sonst warteten die ersten Zeilen des Bestands auf
 * zwei Ladevorgänge hintereinander. Scheitert es, lädt React die Ansicht wie sonst auch nach.
 */
export function preloadPage(pathname: string): void {
  BY_PATH[pathname]?.preload().catch(() => undefined);
}

// Schon beim Laden dieses Moduls, also noch während das Hauptpaket ausgewertet wird.
if (typeof window !== "undefined") {
  preloadPage(window.location.pathname);
}

/**
 * War das ein Fehler beim Nachladen eines Teils der App? Die Browser melden das verschieden;
 * Vite meldet zusätzlich, wenn sich das Stylesheet eines Teils nicht laden ließ.
 */
export function isLoadError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /dynamically imported module|module script failed|unable to preload|chunkloaderror|loading (css )?chunk/i.test(message);
}
