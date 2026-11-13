/**
 * Was aus den Etiketten des letzten Einlagerns geworden ist, in einem Halbsatz.
 * Ohne React, damit sich die Regel für sich prüfen lässt.
 */
import type { PrintJob } from "@/contract";

import { LABEL_STATUS_TEXTS } from "./texts";

/**
 * - "pending":  mindestens eines ist noch bei keinem Druckdienst angekommen
 * - "printing": alle sind beim Druckdienst, mindestens eines wartet oder druckt noch
 * - "printed":  alle sind gedruckt (oder an den Drucker übertragen)
 * - "problem":  mindestens eines ist gescheitert, verworfen oder sein Ausgang ist offen
 */
export type LabelStatus = "pending" | "printing" | "printed" | "problem";

/** Der gemeinsame Stand mehrerer Etiketten; null, wenn es keine gibt. */
export function labelStatus(jobs: readonly Pick<PrintJob, "id" | "state">[], ids: readonly string[]): LabelStatus | null {
  const wanted = new Set(ids);
  const states = jobs.filter((job) => wanted.has(job.id)).map((job) => job.state);
  if (states.length === 0) {
    return null;
  }
  if (states.some((state) => state === "failed" || state === "unknown" || state === "cancelled")) {
    return "problem";
  }
  if (states.some((state) => state === "pending")) {
    return "pending";
  }
  if (states.some((state) => state === "queued" || state === "printing")) {
    return "printing";
  }
  return "printed";
}

/** Der Halbsatz dazu, in Einzahl oder Mehrzahl. */
export function labelStatusText(status: LabelStatus, count: number): string {
  return LABEL_STATUS_TEXTS[status][count === 1 ? 0 : 1];
}
