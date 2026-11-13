/**
 * Daten eines Etiketts (Vertrag, docs/etiketten.md, „Daten").
 *
 * Die App schickt dem Druckdienst fertig formatierte Zeichenketten: Der Pi im Keller
 * hat keine Uhr und kennt keine Sprache. Die Vorlage setzt die Werte nur noch ein.
 */
import type { HouseholdSettings, Package, PackageLabelData, Printer, PrintJob, Product, Zone, ZoneLabelData } from "./api.gen";
import { packageQr, zoneQr } from "./qr";
import { formatDate, toLocalDate } from "./time";

/** Wahr, solange ein Produkt noch keinen Namen hat (angelegt über einen unbekannten Barcode). */
export function isPlaceholder(product: Pick<Product, "name">): boolean {
  return product.name.trim() === "";
}

/** Anzeigename eines Produkts: der Name, bei Platzhaltern der erste Barcode. */
export function productTitle(product: Pick<Product, "name" | "barcodes"> | undefined): string {
  if (!product) {
    return "Unbekanntes Produkt";
  }
  const name = product.name.trim();
  if (name !== "") {
    return name;
  }
  return product.barcodes[0] ?? "Unbekanntes Produkt";
}

/** Marke und Packungsgröße in einer Zeile; leer, wenn beides fehlt. */
export function productSubtitle(product: Pick<Product, "brand" | "quantity"> | undefined): string {
  if (!product) {
    return "";
  }
  return [product.brand.trim(), product.quantity.trim()].filter((part) => part !== "").join(" · ");
}

export interface PackageLabelOptions {
  /** Zonenname mitdrucken. Die App setzt das nur, wenn es mehr als eine Zone gibt. */
  show_zone: boolean;
}

/** Daten für das Etikett einer Packung. */
export function packageLabelData(
  pkg: Pick<Package, "id" | "best_before" | "created_at">,
  product: Pick<Product, "name" | "barcodes" | "brand" | "quantity"> | undefined,
  zone: Pick<Zone, "name"> | undefined,
  options: PackageLabelOptions,
): PackageLabelData {
  return {
    qr: packageQr(pkg.id),
    id: pkg.id,
    title: productTitle(product),
    subtitle: productSubtitle(product),
    best_before: pkg.best_before === null ? "" : formatDate(pkg.best_before),
    stored: formatDate(toLocalDate(new Date(pkg.created_at))),
    zone: options.show_zone && zone ? zone.name : "",
  };
}

/** Daten für das Etikett einer Zone. */
export function zoneLabelData(zone: Pick<Zone, "id" | "name">): ZoneLabelData {
  return {
    qr: zoneQr(zone.id),
    title: zone.name,
    subtitle: "Lagerzone",
  };
}

/** Wo `printerIdForJob` nachschlägt. Kern und Oberfläche reichen ihre eigene Datenhaltung herein. */
export interface PrinterLookup {
  package(id: string): Pick<Package, "zone_id"> | undefined;
  zone(id: string): Pick<Zone, "printer_id"> | undefined;
  printer(id: string): Pick<Printer, "id" | "deleted_at"> | undefined;
  settings: Pick<HouseholdSettings, "default_printer_id"> | null | undefined;
}

/**
 * Welcher Drucker ein Etikett druckt (docs/etiketten.md, Abschnitt 4, „Welcher Drucker"):
 * der am Etikett genannte, sonst der Drucker der Zone (bei Packungen die Zone, in der die
 * Packung jetzt liegt), sonst der Standarddrucker des Haushalts. Ein gelöschter oder
 * unbekannter Drucker zählt auf jeder Stufe als nicht gesetzt. null = es gibt keinen;
 * das Etikett bleibt dann ausstehend.
 */
export function printerIdForJob(job: Pick<PrintJob, "printer_id" | "package_id" | "zone_id">, lookup: PrinterLookup): string | null {
  const usable = (id: string | null | undefined): string | null => {
    if (id === null || id === undefined) {
      return null;
    }
    const printer = lookup.printer(id);
    return printer && printer.deleted_at === null ? printer.id : null;
  };
  const zoneId = job.zone_id ?? (job.package_id === null ? null : (lookup.package(job.package_id)?.zone_id ?? null));
  const zone = zoneId === null ? undefined : lookup.zone(zoneId);
  return usable(job.printer_id) ?? usable(zone?.printer_id) ?? usable(lookup.settings?.default_printer_id);
}
