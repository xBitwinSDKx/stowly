/**
 * Verdrahtung für die echte App (`npm run dev`, `npm run build`).
 *
 * Der Alias "@entry" zeigt je nach Ausprägung auf diese Datei oder auf entry.mock.ts.
 * Beide exportieren dasselbe: `createCore`, `ScanPage`, `ENTRY`.
 */
export { createCore } from "@/core";
export { ScanPage } from "@/features/scan";

export const ENTRY: "real" | "mock" = "real";
