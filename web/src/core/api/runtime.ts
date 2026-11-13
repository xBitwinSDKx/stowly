/**
 * Was die einzelnen Teile der Schnittstelle (`stock`, `zones`, …) vom Kern brauchen.
 * Zusammengesetzt wird in src/core/index.ts.
 */
import { CoreError } from "@/contract/errors";

import type { Mutation, Store } from "../store";

export interface CoreRuntime {
  readonly store: Store;
  readonly now: () => Date;
  /**
   * Eine Änderung des Anwenders: wartet, bis der Kern geladen ist, führt `build` als
   * Schreibvorgang aus und merkt danach einen Abgleich vor.
   */
  change<R>(build: (mutation: Mutation) => R): Promise<R>;
  /**
   * Ein Aufruf, der den Server braucht: reicht das Token des angemeldeten Geräts herein.
   * @throws CoreError offline | unauthorized | …
   */
  server<R>(call: (token: string) => Promise<R>): Promise<R>;
}

/** Fehler sind an der Schnittstelle immer `CoreError`. */
export function toCoreError(error: unknown): CoreError {
  if (error instanceof CoreError) {
    return error;
  }
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  // Dexie meldet einen vollen Speicher teils als Abbruch der Transaktion mit dem eigentlichen Grund darin.
  const inner = (error as { inner?: { name?: string } } | null)?.inner?.name ?? "";
  if (name === "QuotaExceededError" || inner === "QuotaExceededError") {
    return new CoreError("internal", "Der Speicher des Geräts ist voll. Die Änderung wurde nicht gespeichert.");
  }
  return new CoreError("internal", message || "Unerwarteter Fehler.");
}
