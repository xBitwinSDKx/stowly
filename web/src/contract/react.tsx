/**
 * Anbindung des Kerns an React: `CoreProvider`, `useCore`, `useLive`.
 *
 *   const core = useCore();
 *   const zones = useLive(core.data.zones, []);      // mit Vorgabe: nie undefined
 *   const session = useLive(core.session.state);     // ohne: undefined, solange nichts geladen ist
 *   await core.zones.create({ name: "Keller" });
 */
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";

import type { Core, Live } from "./core";

const CoreContext = createContext<Core | null>(null);

export function CoreProvider({ core, children }: { core: Core; children: ReactNode }) {
  return <CoreContext.Provider value={core}>{children}</CoreContext.Provider>;
}

/** Der Kern. Nur innerhalb von `CoreProvider`. */
export function useCore(): Core {
  const core = useContext(CoreContext);
  if (core === null) {
    throw new Error("useCore() außerhalb von <CoreProvider> aufgerufen.");
  }
  return core;
}

/**
 * Liest einen `Live`-Wert und rendert bei jeder Änderung neu.
 * Ohne `fallback` ist das Ergebnis `undefined`, solange der Kern noch lädt.
 */
export function useLive<T>(live: Live<T>): T | undefined;
export function useLive<T>(live: Live<T>, fallback: T): T;
export function useLive<T>(live: Live<T>, fallback?: T): T | undefined {
  const value = useSyncExternalStore(
    (listener) => live.subscribe(listener),
    () => live.get(),
    () => live.get(),
  );
  return value === undefined ? fallback : value;
}
