/**
 * Was die einzelnen Teile der Schnittstelle (`stock`, `zones`, …) vom Kern brauchen.
 * Zusammengesetzt wird in src/core/index.ts.
 */
import { CoreError } from "@/contract/errors";

import type { PrintServiceClient } from "../print/client";
import type { DeliveryEngine, DeliveryOutcome } from "../print/engine";
import type { Mutation, Store } from "../store";

/** Was `printers` und `print` vom Zustellen brauchen (src/core/print). */
export interface PrintRuntime {
  readonly engine: DeliveryEngine;
  readonly client: PrintServiceClient;
  /** Jetzt zustellen und nachfragen, auf Wunsch des Anwenders. Wirft nicht. */
  flush(): Promise<DeliveryOutcome>;
  /** Der Anwender hat einen Drucker erreicht: zustellen, sofern der Kern von selbst zustellt. */
  afterProbe(): void;
  /**
   * Gleicht jetzt ab, bevor ein Aufruf den Druckdienst des Servers anspricht, der einen Drucker
   * oder ein Etikett erst nach dem Abgleich kennt. Wirft nicht; scheitert der Abgleich, geht es
   * trotzdem weiter.
   */
  syncFirst(): Promise<void>;
}

export interface CoreRuntime {
  readonly store: Store;
  readonly now: () => Date;
  /** Erfüllt sich, sobald der gespeicherte Zustand geladen ist. */
  readonly ready: Promise<void>;
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
