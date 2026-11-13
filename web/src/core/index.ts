/**
 * Der echte Offline-Kern. GRUNDGERÜST: Worker 3 ersetzt diese Datei in Runde 1.
 *
 * Fest steht nur die Nahtstelle zu src/entry.real.ts:
 *
 *   export function createCore(): Core
 *
 * `createCore` kehrt sofort zurück (kein await). Der Kern lädt seinen Zustand danach
 * selbst und meldet solange `session.state = { status: "loading" }`.
 */
import { CoreError, type Core } from "@/contract";

import { registerServiceWorker } from "./pwa/register";

export function createCore(): Core {
  registerServiceWorker();
  throw new CoreError(
    "not_supported",
    "Der Offline-Kern ist noch nicht gebaut (Runde 1). Die Oberfläche mit Beispieldaten startet mit: npm run dev:mock",
  );
}
