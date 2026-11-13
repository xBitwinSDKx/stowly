import { lazy, type ComponentType, type ReactNode } from "react";

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
 * sonst lädt React sie beim ersten Zeigen, und der Rahmen zeigt solange „Lädt …".
 * Scheitert das Laden, fängt der Router den Fehler ab (`RouteError`: „Neu laden").
 */
export function lazyPage(load: () => Promise<ComponentType>): LazyPage {
  let Loaded: ComponentType | null = null;
  const remember = async () => {
    Loaded = await load();
    return Loaded;
  };
  const Deferred = lazy(async () => ({ default: await remember() }));
  const Page = () => (Loaded ? <Loaded /> : <Deferred />);
  Page.preload = async () => {
    await remember();
  };
  return Page;
}

export const StockPage = lazyPage(() => import("@/features/stock").then((module) => module.StockPage));
export const ZonesPage = lazyPage(() => import("@/features/zones").then((module) => module.ZonesPage));
export const WarningsPage = lazyPage(() => import("@/features/warnings").then((module) => module.WarningsPage));
export const HistoryPage = lazyPage(() => import("@/features/history").then((module) => module.HistoryPage));
export const PrintersPage = lazyPage(() => import("@/features/printers").then((module) => module.PrintersPage));
export const SettingsPage = lazyPage(() => import("@/features/settings").then((module) => module.SettingsPage));
export const SyncPage = lazyPage(() => import("@/features/sync").then((module) => module.SyncPage));

const ALL: readonly LazyPage[] = [StockPage, ZonesPage, WarningsPage, HistoryPage, PrintersPage, SettingsPage, SyncPage];

/** Holt alle Ansichten vorab. Scheitert eine (kein Netz), bleibt es beim Nachladen, wenn sie gebraucht wird. */
export function preloadPages(): Promise<void> {
  return Promise.allSettled(ALL.map((page) => page.preload())).then(() => undefined);
}

/**
 * War das ein Fehler beim Nachladen eines Teils der App? Die Browser melden das verschieden;
 * Vite meldet zusätzlich, wenn sich das Stylesheet eines Teils nicht laden ließ.
 */
export function isLoadError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /dynamically imported module|module script failed|unable to preload|chunkloaderror|loading (css )?chunk/i.test(message);
}
