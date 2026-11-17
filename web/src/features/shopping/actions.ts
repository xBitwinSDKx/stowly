/**
 * Einträge der Einkaufsliste anlegen und wiederfinden: gemeinsam für die Einkaufsliste, den
 * Bestand und das Entnehmen. Hier, nicht in der Ansicht selbst, damit der Bestand die Ansicht
 * nicht mitladen muss (sie wird nachgeladen, app/pages.tsx).
 */
import { isOpenItem, LIMITS, productTitle, type Core, type Product, type ShoppingItem } from "@/contract";
import { foldText } from "@/features/stock/model";
import { errorText, plural } from "@/ui";
import type { ToastApi } from "@/ui/base";

import { findDuplicate } from "./model";

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

/** Ein freier Text, wie er auf die Liste kommt: Leerraum zusammengezogen, höchstens `LIMITS.shopping_text` Zeichen. */
export function shoppingText(text: string): string {
  return Array.from(text.replace(/\s+/g, " ").trim()).slice(0, LIMITS.shopping_text).join("").trim();
}

/**
 * Setzt freie Texte auf die Einkaufsliste, etwa was einem Rezeptvorschlag fehlt: jeden als eigenen
 * Eintrag ohne Menge, auf `LIMITS.shopping_text` gekürzt (`shoppingText`). Was dort schon offen steht
 * (`findDuplicate`: derselbe Name, auch als Produkt) oder in `texts` doppelt vorkommt, kommt nicht noch
 * einmal dazu. Die Meldung sagt, was neu ist und was schon dastand, und bietet „Rückgängig" an: Das
 * löscht die eben angelegten Einträge wieder. Wie jeder offene Eintrag gehen sie nach Bring!.
 * @returns die neuen Einträge (bei einem Fehler die bis dahin angelegten)
 */
export async function addTextsToShopping(core: Core, toast: ToastApi, texts: readonly string[]): Promise<ShoppingItem[]> {
  const items = core.data.shoppingItems.get() ?? [];
  const products = core.data.products.get() ?? [];
  const wanted: string[] = [];
  const present: string[] = [];
  const seen = new Set<string>();
  for (const raw of texts) {
    const text = shoppingText(raw);
    const key = foldText(text);
    if (text === "" || seen.has(key)) {
      continue;
    }
    seen.add(key);
    (findDuplicate(items, products, { text }) ? present : wanted).push(text);
  }
  const created: ShoppingItem[] = [];
  try {
    for (const text of wanted) {
      created.push(await core.shopping.create({ text }));
    }
  } catch (caught) {
    toast.show({
      id: "shopping-texts",
      message:
        created.length === 0
          ? errorText(caught)
          : `${created.length === 1 ? "Nur ein Eintrag kam" : `Nur ${String(created.length)} Einträge kamen`} auf die Liste. ${errorText(caught)}`,
      tone: "danger",
    });
    return created;
  }
  if (created.length === 0) {
    toast.show({
      id: "shopping-texts",
      message: present.length === 1 ? `„${present[0] ?? ""}“ steht schon auf der Einkaufsliste.` : "Das steht alles schon auf der Einkaufsliste.",
    });
    return created;
  }
  const added = created.length === 1 ? `„${created[0]?.text ?? ""}“ steht jetzt auf der Einkaufsliste.` : `${String(created.length)} Einträge stehen jetzt auf der Einkaufsliste.`;
  const already = present.length === 0 ? "" : present.length === 1 ? ` „${present[0] ?? ""}“ stand schon dort.` : ` ${plural(present.length, "stand", "standen")} schon dort.`;
  toast.show({
    id: "shopping-texts",
    message: `${added}${already}`,
    tone: "success",
    action: {
      label: "Rückgängig",
      onAction: () => {
        Promise.all(created.map((item) => core.shopping.remove(item.id))).catch((caught: unknown) =>
          toast.show({ message: `Rückgängig hat nicht geklappt. ${errorText(caught)}`, tone: "danger" }),
        );
      },
    },
  });
  return created;
}
