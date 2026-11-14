/**
 * Die Einkaufsliste als Anzeige: reine Logik ohne React.
 *
 * Die Reihenfolge kommt fertig vom Kern (`data.shoppingItems`, `compareShoppingItems`): offene
 * zuerst, die ältesten vorn; dann erledigte, die zuletzt erledigten vorn. Hier entstehen die
 * beiden Abschnitte, die Vorschläge beim Eintippen und die Prüfung auf doppelte Einträge.
 */
import { isOpenItem, productTitle, shoppingItemTitle, type Product, type ShoppingItem } from "@/contract";
import { foldText } from "@/features/stock/model";

export interface ShoppingSections {
  /** Weder erledigt noch gelöscht, in der Reihenfolge des Kerns. */
  open: ShoppingItem[];
  /** Erledigt (abgehakt, eingekauft, durch Einlagern erledigt), die zuletzt erledigten vorn. */
  done: ShoppingItem[];
}

/** Teilt die Liste in offene und erledigte Einträge. Gelöschte zeigt der Kern ohnehin nicht. */
export function splitItems(items: readonly ShoppingItem[]): ShoppingSections {
  const open: ShoppingItem[] = [];
  const done: ShoppingItem[] = [];
  for (const item of items) {
    if (item.deleted_at !== null) {
      continue;
    }
    (isOpenItem(item) ? open : done).push(item);
  }
  return { open, done };
}

/** Ein automatischer Eintrag: vom Server, weil der Bestand unter dem Mindestbestand liegt. */
export function isAutomatic(item: Pick<ShoppingItem, "origin">): boolean {
  return item.origin === "min_stock";
}

const collator = new Intl.Collator("de", { numeric: true, sensitivity: "base" });

/** So viele Produkte schlägt das Eingabefeld höchstens vor. */
export const MAX_SUGGESTIONS = 6;

/**
 * Produkte, die zur Eingabe passen: jedes Wort im Namen oder in der Marke, reine Ziffern auch im
 * Barcode. Produkte, deren Name mit der Eingabe beginnt, stehen vorn; sonst nach Namen.
 */
export function suggestProducts(products: readonly Product[], query: string, limit = MAX_SUGGESTIONS): Product[] {
  const words = query.trim().split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) {
    return [];
  }
  const folded = words.map((word) => ({ text: foldText(word), digits: /^\d+$/.test(word) ? word : null }));
  const start = foldText(query.trim());
  const hits = products.filter((product) => {
    const haystack = foldText(`${product.name} ${product.brand}`);
    return folded.every((word) => haystack.includes(word.text) || (word.digits !== null && product.barcodes.some((code) => code.includes(word.digits as string))));
  });
  const leading = (product: Product) => (foldText(productTitle(product)).startsWith(start) ? 0 : 1);
  return hits.sort((a, b) => leading(a) - leading(b) || collator.compare(productTitle(a), productTitle(b))).slice(0, limit);
}

/** Was neu auf die Liste soll: ein Produkt oder freier Text. */
export type ShoppingDraft = { product: Product } | { text: string };

/**
 * Der offene Eintrag, der dasselbe meint wie der neue: dasselbe Produkt, oder derselbe Name
 * (ohne Rücksicht auf Groß- und Kleinschreibung), auch wenn einer davon ein Produkt ist.
 * So entsteht nicht aus Versehen ein zweiter Eintrag; bewusst geht es trotzdem.
 */
export function findDuplicate(items: readonly ShoppingItem[], products: readonly Product[], draft: ShoppingDraft): ShoppingItem | undefined {
  const byId = new Map(products.map((product) => [product.id, product]));
  const name = foldText("product" in draft ? productTitle(draft.product) : draft.text.trim());
  return items.find((item) => {
    if (!isOpenItem(item)) {
      return false;
    }
    if ("product" in draft && item.product_id === draft.product.id) {
      return true;
    }
    const product = item.product_id === null ? undefined : byId.get(item.product_id);
    return foldText(shoppingItemTitle(item, product)) === name;
  });
}
