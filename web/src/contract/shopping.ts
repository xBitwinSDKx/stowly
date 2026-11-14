/**
 * Mindestbestand und Einkaufsliste: Regeln, die mehrere Seiten brauchen (Vertrag,
 * docs/sync-protokoll.md, 3.1, 3.6 und 7.6).
 *
 * Die Bestandsliste markiert Produkte unter dem Mindestbestand sofort, auch offline: Das rechnet
 * die App selbst (`missingStock`). Automatische Einträge legt dagegen nur der Server an; die App
 * nimmt sie nicht vorweg, sie kommen mit dem Abgleich.
 */
import type { Package, Product, ShoppingItem } from "./api.gen";
import { productTitle } from "./labels";

type Stocked = Pick<Package, "product_id" | "removed_at">;

/** Packungen eines Produkts im Bestand: alle nicht entnommenen, abgelaufene eingeschlossen. */
export function stockCount(packages: readonly Stocked[], productId: string): number {
  let count = 0;
  for (const pkg of packages) {
    if (pkg.product_id === productId && pkg.removed_at === null) {
      count += 1;
    }
  }
  return count;
}

/** Der Bestand aller Produkte in einem Durchgang: Produkt-ID -> Anzahl. Fehlt ein Produkt, ist es 0. */
export function stockCounts(packages: readonly Stocked[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const pkg of packages) {
    if (pkg.removed_at === null) {
      counts.set(pkg.product_id, (counts.get(pkg.product_id) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Wie viele Packungen zum Mindestbestand fehlen: `min_stock` minus Bestand, mindestens 0; ohne
 * Mindestbestand 0. Dieselbe Zahl führt der Server als `quantity` des automatischen Eintrags nach.
 */
export function missingStock(product: Pick<Product, "min_stock"> | undefined | null, stock: number): number {
  const minimum = product?.min_stock ?? null;
  return minimum === null ? 0 : Math.max(0, minimum - stock);
}

/** Liegt das Produkt unter seinem Mindestbestand? */
export function isBelowMinStock(product: Pick<Product, "min_stock"> | undefined | null, stock: number): boolean {
  return missingStock(product, stock) > 0;
}

/** Ein offener Eintrag: weder erledigt noch gelöscht. */
export function isOpenItem(item: Pick<ShoppingItem, "done_at" | "deleted_at">): boolean {
  return item.done_at === null && item.deleted_at === null;
}

/**
 * Anzeigename eines Eintrags: bei einem Produkt dessen Name (bei Platzhaltern der Barcode), sonst
 * der freie Text. Zeigt der Verweis (noch) ins Leere, „Unbekanntes Produkt".
 */
export function shoppingItemTitle(
  item: Pick<ShoppingItem, "product_id" | "text">,
  product: Pick<Product, "name" | "barcodes"> | undefined,
): string {
  return item.product_id === null ? item.text : productTitle(product);
}

/**
 * Die Menge als kurzer Text: "fehlt 2" bei automatischen Einträgen, "2×" bei eigenen mit Menge,
 * sonst leer. In Bring! steht derselbe Text vor " · Stowly" (docs/integrationen.md, 5.2).
 */
export function shoppingQuantityLabel(item: Pick<ShoppingItem, "origin" | "quantity">): string {
  if (item.quantity === null) {
    return "";
  }
  return item.origin === "min_stock" ? `fehlt ${item.quantity}` : `${item.quantity}×`;
}

/**
 * Reihenfolge der Einkaufsliste (`data.shoppingItems`): offene zuerst, die ältesten vorn; danach
 * erledigte, die zuletzt erledigten vorn. Bei Gleichstand nach Kennung.
 */
export function compareShoppingItems(a: ShoppingItem, b: ShoppingItem): number {
  const openA = a.done_at === null;
  const openB = b.done_at === null;
  if (openA !== openB) {
    return openA ? -1 : 1;
  }
  if (openA) {
    return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
  }
  return (b.done_at ?? "").localeCompare(a.done_at ?? "") || a.id.localeCompare(b.id);
}
