/**
 * Einträge der Einkaufsliste anlegen und wiederfinden: gemeinsam für die Einkaufsliste, den
 * Bestand und das Entnehmen. Hier, nicht in der Ansicht selbst, damit der Bestand die Ansicht
 * nicht mitladen muss (sie wird nachgeladen, app/pages.tsx).
 */
import { isOpenItem, productTitle, type Core, type Product, type ShoppingItem } from "@/contract";
import { errorText } from "@/ui";
import type { ToastApi } from "@/ui/base";

/** Der offene Eintrag eines Produkts, eigener oder automatischer; der älteste, wenn es mehrere gibt. */
export function openItemFor(items: readonly ShoppingItem[] | undefined, productId: string): ShoppingItem | undefined {
  return items?.find((item) => item.product_id === productId && isOpenItem(item));
}

/**
 * Setzt ein Produkt auf die Einkaufsliste, als eigenen Eintrag ohne Menge. Steht es dort schon
 * offen, entsteht kein zweiter: Die Meldung sagt das stattdessen. Nach dem Anlegen bietet die
 * Meldung „Rückgängig" an; das löscht den eben angelegten Eintrag wieder.
 * @returns der neue Eintrag, oder undefined, wenn keiner entstand
 */
export async function addProductToShopping(core: Core, toast: ToastApi, product: Product): Promise<ShoppingItem | undefined> {
  const title = productTitle(product);
  if (openItemFor(core.data.shoppingItems.get(), product.id)) {
    toast.show({ id: `shopping-${product.id}`, message: `„${title}“ steht schon auf der Einkaufsliste.` });
    return undefined;
  }
  try {
    const item = await core.shopping.create({ product_id: product.id });
    toast.show({
      id: `shopping-${product.id}`,
      message: `„${title}“ steht jetzt auf der Einkaufsliste.`,
      tone: "success",
      action: {
        label: "Rückgängig",
        onAction: () => {
          core.shopping.remove(item.id).catch((caught: unknown) => toast.show({ message: `Rückgängig hat nicht geklappt. ${errorText(caught)}`, tone: "danger" }));
        },
      },
    });
    return item;
  } catch (caught) {
    toast.show({
      id: `shopping-${product.id}`,
      message: errorText(caught, { not_found: "Dieses Produkt gibt es nicht mehr." }),
      tone: "danger",
    });
    return undefined;
  }
}
