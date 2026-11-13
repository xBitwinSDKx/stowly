import { plural } from "@/ui";
import { cx } from "@/ui/base";
import { CircleCheckIcon, PrinterIcon, QuestionIcon, WarningIcon, type IconType } from "@/ui/icons";

import styles from "./LabelStatus.module.css";
import { jobErrorText, type JobView } from "./model";
import { usePrinting } from "./usePrinting";

/** Wie es um eben angeforderte Etiketten steht, als Farbe: gedruckt, unterwegs, ausstehend, unklar, gescheitert. */
export type LabelStatusTone = "success" | "busy" | "pending" | "warn" | "danger";

/** Der Gesamteindruck: Das Schlechteste bestimmt die Farbe. */
export function labelStatusTone(views: readonly JobView[]): LabelStatusTone {
  const has = (states: readonly string[]) => views.some((view) => states.includes(view.job.state));
  if (has(["failed"])) {
    return "danger";
  }
  if (has(["unknown"])) {
    return "warn";
  }
  if (has(["pending"])) {
    return "pending";
  }
  if (has(["queued", "printing"])) {
    return "busy";
  }
  return "success";
}

/** Ein Satz eines Fehlers als Einschub: „(es sind keine Etiketten eingelegt)". */
function aside(code: string): string {
  const text = jobErrorText(code).replace(/\.$/, "");
  return text === code ? text : `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

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
    parts.push(`${plural(failed.length, "Etikett wurde", "Etiketten wurden")} nicht gedruckt${reason ? ` (${aside(reason)})` : ""}`);
  }
  if (unknown > 0) {
    parts.push(`bei ${plural(unknown, "Etikett", "Etiketten")} ist der Ausgang unklar: Stowly fragt nach, ob ${unknown === 1 ? "es" : "sie"} gedruckt wurde${unknown === 1 ? "" : "n"}`);
  }
  if (cancelled > 0) {
    parts.push(`${String(cancelled)} verworfen`);
  }
  const text = parts.join("; ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

const TONE_ICONS: Record<LabelStatusTone, IconType> = {
  success: CircleCheckIcon,
  busy: PrinterIcon,
  pending: PrinterIcon,
  warn: QuestionIcon,
  danger: WarningIcon,
};

/**
 * Sagt nach dem Anfordern, was mit den Etiketten ist, und bleibt dabei auf dem Laufenden:
 * „werden gerade gedruckt", „sind gedruckt", „stehen aus".
 * @param icon mit einem Symbol in der Farbe des Stands davor (Ergebnis eines Dialogs)
 */
export function LabelStatus({ jobIds, className, icon = false }: { jobIds: readonly string[]; className?: string; icon?: boolean }) {
  const printing = usePrinting();
  const views = printing.jobs.filter((view) => jobIds.includes(view.job.id));
  if (views.length === 0) {
    return null;
  }
  if (!icon) {
    return (
      <p className={className} role="status">
        {labelStatusText(views)}
      </p>
    );
  }
  const tone = labelStatusTone(views);
  const Icon = TONE_ICONS[tone];
  return (
    <p className={cx(styles.status, styles[tone], className)} role="status">
      <Icon size={24} aria-hidden="true" className={styles.icon} />
      <span className={styles.text}>{labelStatusText(views)}</span>
    </p>
  );
}
