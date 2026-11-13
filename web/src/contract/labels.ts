/**
 * Daten eines Etiketts (Vertrag, docs/etiketten.md, „Daten").
 *
 * Die App schickt dem Druckdienst fertig formatierte Zeichenketten: Der Pi im Keller
 * hat keine Uhr und kennt keine Sprache. Die Vorlage setzt die Werte nur noch ein.
 */
import type { Package, PackageLabelData, Product, Zone, ZoneLabelData } from "./api.gen";
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
