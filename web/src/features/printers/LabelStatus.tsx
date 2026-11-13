import { plural } from "@/ui";

import { jobErrorText, type JobView } from "./model";
import { usePrinting } from "./usePrinting";

/** Was aus eben angeforderten Etiketten gerade wird, in einem Satz. */
export function labelStatusText(views: readonly JobView[]): string {
  if (views.length === 0) {
    return "";
  }
  const count = (states: readonly string[]) => views.filter((view) => states.includes(view.job.state)).length;
  const printers = [...new Set(views.map((view) => view.printer?.name).filter((name): name is string => name !== undefined))];
  const where = printers.length === 1 ? ` am Drucker „${printers[0] ?? ""}“` : "";
  const total = views.length;
  const printed = count(["printed", "sent"]);
  const active = count(["queued", "printing"]);
  const pending = count(["pending"]);
  const failed = views.filter((view) => view.job.state === "failed");
  const unknown = count(["unknown"]);
  const cancelled = count(["cancelled"]);

  if (printed === total) {
    return `${plural(total, "Etikett ist", "Etiketten sind")}${where} gedruckt.`;
  }
  if (cancelled === total) {
    return `${plural(total, "Etikett wurde", "Etiketten wurden")} verworfen.`;
  }
  const parts: string[] = [];
  if (active > 0) {
    parts.push(`${plural(active, "Etikett wird", "Etiketten werden")}${where} gerade gedruckt`);
  }
  if (printed > 0) {
    parts.push(`${String(printed)} ${printed === 1 ? "ist" : "sind"} gedruckt`);
  }
  if (pending > 0) {
    const unassigned = views.some((view) => view.job.state === "pending" && !view.printer);
    parts.push(
      unassigned
        ? `${plural(pending, "Etikett steht", "Etiketten stehen")} aus: Es ist kein Drucker zugeordnet`
        : `${plural(pending, "Etikett steht", "Etiketten stehen")} aus und ${pending === 1 ? "wird" : "werden"} gedruckt, sobald dieses Gerät den Drucker${printers.length === 1 ? ` „${printers[0] ?? ""}“` : ""} erreicht`,
    );
  }
  if (failed.length > 0) {
    const reason = failed[0]?.job.error;
    parts.push(`${plural(failed.length, "Etikett wurde", "Etiketten wurden")} nicht gedruckt${reason ? ` (${jobErrorText(reason).replace(/\.$/, "")})` : ""}`);
  }
  if (unknown > 0) {
    parts.push(`bei ${plural(unknown, "Etikett", "Etiketten")} ist der Ausgang unklar`);
  }
  if (cancelled > 0) {
    parts.push(`${String(cancelled)} verworfen`);
  }
  const text = parts.join("; ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/**
 * Sagt nach dem Anfordern, was mit den Etiketten ist, und bleibt dabei auf dem Laufenden:
 * „werden gerade gedruckt", „sind gedruckt", „stehen aus".
 */
export function LabelStatus({ jobIds, className }: { jobIds: readonly string[]; className?: string }) {
  const printing = usePrinting();
  const views = printing.jobs.filter((view) => jobIds.includes(view.job.id));
  if (views.length === 0) {
    return null;
  }
  return (
    <p className={className} role="status">
      {labelStatusText(views)}
    </p>
  );
}
