/**
 * Lösch-Historie: reine Logik ohne React.
 */
import { formatDate, productTitle, type DisplacedEdit, type Package, type PackageField, type Product, type Zone } from "@/contract";

/** Eine Zeile einer verdrängten Bearbeitung: was geändert werden sollte. */
export interface DisplacedLine {
  field: PackageField;
  /** „MHD", „Zone", „Produkt" */
  label: string;
  /** Der Wert, den die Packung jetzt hat. */
  from: string;
  /** Der Wert, den die Bearbeitung setzen wollte. */
  to: string;
}

const FIELD_ORDER: readonly PackageField[] = ["best_before", "zone_id", "product_id"];

function dateText(date: string | null): string {
  return date === null ? "kein MHD" : formatDate(date);
}

/**
 * Beschreibt eine verdrängte Bearbeitung (Löschen gewinnt gegen Bearbeiten): je Feld, was
 * die Packung jetzt hat und was die Bearbeitung setzen wollte. Verweise ins Leere bekommen
 * einen Platzhalter.
 */
export function displacedLines(
  pkg: Pick<Package, "best_before" | "zone_id" | "product_id">,
  displaced: DisplacedEdit,
  products: readonly Product[],
  zones: readonly Zone[],
): DisplacedLine[] {
  const zoneName = (id: string | null) => zones.find((zone) => zone.id === id)?.name ?? "Unbekannte Zone";
  const productName = (id: string | null) => productTitle(products.find((product) => product.id === id));
  return [...displaced.changes]
    .sort((a, b) => FIELD_ORDER.indexOf(a.field) - FIELD_ORDER.indexOf(b.field))
    .map((change) => {
      switch (change.field) {
        case "best_before":
          return { field: change.field, label: "MHD", from: dateText(pkg.best_before), to: dateText(change.value) };
        case "zone_id":
          return { field: change.field, label: "Zone", from: zoneName(pkg.zone_id), to: zoneName(change.value) };
        case "product_id":
          return { field: change.field, label: "Produkt", from: productName(pkg.product_id), to: productName(change.value) };
      }
    });
}
