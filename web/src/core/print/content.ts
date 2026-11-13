/**
 * Was auf ein Etikett kommt und an welchen Drucker es geht (docs/etiketten.md, 3.3 und 4).
 *
 * Die Daten entstehen aus dem, was die App gerade zeigt, also dem Stand des Servers plus den
 * noch nicht bestätigten Befehlen. Die Vorlage ist für die App undurchsichtig: `body` der
 * `LabelTemplate` zur Art des Etiketts reist unverändert mit.
 */
import type { PrintJob, PrintJobKind } from "@/contract/api.gen";
import { newUuid } from "@/contract/ids";
import { packageLabelData, printerIdForJob, zoneLabelData, type PrinterLookup } from "@/contract/labels";

import { resolveProduct, resolveZone } from "../commands/apply";
import type { DeliveryContent } from "../db";
import { Draft, type Tables } from "../tables";

/** Die Vorlage zur Art des Etiketts oder null, solange sie der Abgleich noch nicht gebracht hat. */
export function templateFor(view: Tables, kind: PrintJobKind): { [key: string]: unknown } | null {
  return view.label_templates.get(kind)?.body ?? null;
}

/** Die fertig formatierten Zeichenketten eines Etiketts; null, wenn es zu nichts mehr gehört. */
export function labelData(view: Tables, subject: { package_id: string | null; zone_id: string | null }): { [key: string]: string } | null {
  const draft = new Draft(view);
  if (subject.package_id !== null) {
    const pkg = view.packages.get(subject.package_id);
    if (!pkg) {
      return null;
    }
    let zones = 0;
    for (const zone of view.zones.values()) {
      if (zone.deleted_at === null) {
        zones += 1;
      }
    }
    // Der Zonenname steht nur auf dem Etikett, wenn es mehr als eine Zone gibt.
    return { ...packageLabelData(pkg, resolveProduct(draft, pkg.product_id), resolveZone(draft, pkg.zone_id), { show_zone: zones > 1 }) };
  }
  if (subject.zone_id !== null) {
    const zone = view.zones.get(subject.zone_id);
    return zone ? { ...zoneLabelData(zone) } : null;
  }
  return null;
}

/**
 * Der Inhalt eines Druckauftrags für dieses Etikett: Vorlage, Daten, ein Exemplar, mit Schnitt.
 * `queue` ist der Name des Druckers im Dienst. null, wenn Vorlage oder Gegenstand fehlen.
 */
export function buildContent(view: Tables, job: Pick<PrintJob, "kind" | "package_id" | "zone_id">, queue: string | null): DeliveryContent | null {
  const template = templateFor(view, job.kind);
  const data = labelData(view, job);
  if (!template || !data) {
    return null;
  }
  return { printer: queue, template, data, copies: 1, cut: true };
}

/** Die Sicht von `printerIdForJob` auf den Datenbestand. */
export function printerLookup(view: Tables): PrinterLookup {
  return {
    package: (id) => view.packages.get(id),
    zone: (id) => view.zones.get(id),
    printer: (id) => view.printers.get(id),
    settings: view.settings,
  };
}

/** Der Drucker, an den dieses Etikett jetzt ginge (docs/etiketten.md, Abschnitt 4, „Welcher Drucker"). */
export function printerFor(view: Tables, job: Pick<PrintJob, "printer_id" | "package_id" | "zone_id">): string | null {
  return printerIdForJob(job, printerLookup(view));
}

/** Reihenfolge des Zustellens: nach Anforderung, dann nach Kennung. */
export function byRequestOrder(a: Pick<PrintJob, "created_at" | "id">, b: Pick<PrintJob, "created_at" | "id">): number {
  return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}

/**
 * Kennungen für `count` Etiketten, die in einem Schritt angefordert werden. Sie tragen alle
 * dasselbe `created_at`; dann entscheidet beim Zustellen die Kennung (`byRequestOrder`).
 * Aufsteigend vergeben, kommen die Etiketten so in der Reihenfolge der Packungen aus dem Drucker
 * (docs/etiketten.md, 4.1).
 */
export function labelIdsInOrder(count: number): string[] {
  return Array.from({ length: count }, () => newUuid()).sort((a, b) => a.localeCompare(b));
}
