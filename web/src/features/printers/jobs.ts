/**
 * Etiketten für die Anzeige: das, was der Rahmen der App braucht (offene Etiketten zählen,
 * die Nachfrage „Wurde das Etikett gedruckt?"), ohne die Sätze und Regeln der Druckeransicht.
 *
 * Getrennt von model.ts, weil der Rahmen im Hauptpaket liegt: Was hier steht, lädt jede Seite;
 * model.ts mit den Texten zu Druckern, Fehlern und Zustand kommt erst mit den Ansichten, die es
 * brauchen. model.ts reicht alles hier weiter.
 */
import { printerIdForJob, productSubtitle, productTitle, type HouseholdSettings, type Package, type Printer, type PrintJob, type PrintJobState, type Product, type Zone } from "@/contract";

/** Noch nicht abgeschlossen: Daran erinnern das Drucker-Symbol und das Menü. */
export function isOpenJob(job: Pick<PrintJob, "state">): boolean {
  return job.state === "pending" || job.state === "queued" || job.state === "printing" || job.state === "unknown";
}

/** Die Live-Daten, in denen die Regeln nachschlagen. */
export interface PrintData {
  printers: ReadonlyMap<string, Printer>;
  zones: ReadonlyMap<string, Zone>;
  /** Bestand und Lösch-Historie. */
  packages: ReadonlyMap<string, Package>;
  products: ReadonlyMap<string, Product>;
  settings: Pick<HouseholdSettings, "default_printer_id"> | null | undefined;
}

/** Der Drucker, der ein Etikett nach der Regel des Kerns druckt (`printerIdForJob`). */
export function resolvePrinter(job: Pick<PrintJob, "printer_id" | "package_id" | "zone_id">, data: PrintData): Printer | undefined {
  const id = printerIdForJob(job, {
    package: (packageId) => data.packages.get(packageId),
    zone: (zoneId) => data.zones.get(zoneId),
    printer: (printerId) => data.printers.get(printerId),
    settings: data.settings,
  });
  return id === null ? undefined : data.printers.get(id);
}

/**
 * In welchem Abschnitt der Liste ein Etikett steht:
 * - "ask": Ausgang unklar, die App fragt nach
 * - "waiting": ausstehend oder beim Drucker
 * - "done": erledigt, fehlgeschlagen oder verworfen
 */
export type JobGroup = "ask" | "waiting" | "done";

export interface JobView {
  job: PrintJob;
  group: JobGroup;
  /** Wozu das Etikett gehört, als Überschrift: Produktname oder „Zone Keller". */
  title: string;
  /** Darunter: Packungs-ID mit Marke und Größe, oder leer. */
  detail: string;
  /** Kurz und eindeutig, für Beschriftungen: „Basmati Reis, Packung A2B3C" oder „Zone Keller". */
  label: string;
  /** Der Drucker, der druckt oder gedruckt hat; undefined = keiner zugeordnet oder nicht mehr bekannt. */
  printer: Printer | undefined;
  /** Dieses Gerät hat das Etikett angefordert und stellt es zu. */
  own: boolean;
  /** Ein Drucker mit Bild-Treiber hat es geschrieben: Das Bild lässt sich ansehen. */
  hasImage: boolean;
}

function jobGroup(state: PrintJobState): JobGroup {
  if (state === "unknown") {
    return "ask";
  }
  return state === "pending" || state === "queued" || state === "printing" ? "waiting" : "done";
}

/** Bereitet ein Etikett für die Anzeige auf. */
export function viewJob(job: PrintJob, data: PrintData, ownDeviceId: string | null): JobView {
  let title: string;
  let detail = "";
  if (job.kind === "zone") {
    const zone = job.zone_id === null ? undefined : data.zones.get(job.zone_id);
    title = zone ? `Zone ${zone.name}` : "Zone (gelöscht)";
    detail = "Zonen-Etikett";
  } else {
    const pkg = job.package_id === null ? undefined : data.packages.get(job.package_id);
    const product = pkg ? data.products.get(pkg.product_id) : undefined;
    title = pkg ? productTitle(product) : "Packung nicht mehr vorhanden";
    detail = [job.package_id ? `Packung ${job.package_id}` : null, productSubtitle(product) || null].filter(Boolean).join(" · ");
  }
  // Solange ein Etikett aussteht, entscheidet die Regel bei jedem Versuch neu; danach steht fest, wer gedruckt hat.
  const reported = job.printer_id === null ? undefined : data.printers.get(job.printer_id);
  const printer = job.state === "pending" ? resolvePrinter(job, data) : (reported ?? (isOpenJob(job) ? resolvePrinter(job, data) : undefined));
  return {
    job,
    group: jobGroup(job.state),
    title,
    detail,
    label: job.kind === "package" && job.package_id ? `${title}, Packung ${job.package_id}` : title,
    printer,
    own: ownDeviceId !== null && job.device_id === ownDeviceId,
    hasImage: (job.state === "printed" || job.state === "sent") && printer?.server?.driver === "image",
  };
}
