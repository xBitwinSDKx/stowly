/**
 * Die Einkaufsliste (`Core.shopping`, docs/sync-protokoll.md 3.6 und 6.6).
 *
 * Jede Methode prüft die Eingabe gegen die lokale Kopie und erzeugt daraus einen Befehl; erfüllt
 * ist sie, sobald er in der Outbox steht, auch offline. Ein Aufruf ohne Wirkung erzeugt keinen
 * Befehl (Regel 7 in src/contract/core.ts). Was der Server daraus ableitet (automatische Einträge,
 * Sperre, Erledigen durch Einlagern, 7.6), nimmt der Kern nicht vorweg: Es kommt mit dem Abgleich.
 */
import type { ShoppingItem, ShoppingItemChanges } from "@/contract/api.gen";
import type { NewShoppingItem, ShoppingApi } from "@/contract/core";
import { CoreError } from "@/contract/errors";
import { newUuid } from "@/contract/ids";
import { checkShoppingQuantity, checkShoppingText } from "@/contract/input";

import type { Draft } from "../tables";
import type { CoreRuntime } from "./runtime";
import { activeProduct, clean, invalid, notFound } from "./validate";

/** Ein Eintrag, den es gibt und der nicht gelöscht ist. */
function liveItem(draft: Draft, id: string): ShoppingItem {
  const item = typeof id === "string" ? draft.get("shopping_items", id) : undefined;
  if (!item) {
    throw notFound("Den Eintrag gibt es nicht.");
  }
  if (item.deleted_at !== null) {
    throw notFound("Der Eintrag ist gelöscht.");
  }
  return item;
}

export function createShoppingApi(runtime: CoreRuntime): ShoppingApi {
  return {
    create(input: NewShoppingItem) {
      return runtime.change((mutation) => {
        if (input === null || typeof input !== "object") {
          throw invalid("Es fehlt die Angabe, was auf die Liste soll.");
        }
        const productId = input.product_id ?? null;
        if (productId !== null && clean(input.text) !== "") {
          throw invalid("Ein Eintrag hat ein Produkt oder einen Text, nicht beides.");
        }
        checkShoppingQuantity(input.quantity);
        // Ein Produkt folgt einer Zusammenführung zum Ziel; ohne Produkt braucht es einen Text.
        const product = productId === null ? null : activeProduct(mutation.draft, productId);
        const text = product ? "" : checkShoppingText(input.text);
        const id = newUuid();
        mutation.emit({ type: "shopping_item.create", item_id: id, product_id: product?.id ?? null, text, quantity: input.quantity ?? null });
        const item = mutation.draft.get("shopping_items", id);
        if (!item) {
          throw new CoreError("internal", "Der Eintrag ließ sich nicht anlegen.");
        }
        return item;
      });
    },

    update(id: string, changes: ShoppingItemChanges) {
      return runtime.change((mutation) => {
        const item = liveItem(mutation.draft, id);
        if (changes === null || typeof changes !== "object") {
          throw invalid("Es fehlt die Angabe, was geändert werden soll.");
        }
        const wanted: ShoppingItemChanges = {};
        if (changes.text !== undefined) {
          if (item.product_id !== null) {
            throw invalid("Ein Eintrag mit Produkt trägt dessen Namen, keinen eigenen Text.");
          }
          wanted.text = checkShoppingText(changes.text);
        }
        if ("quantity" in changes) {
          if (item.origin === "min_stock") {
            throw invalid("Die Menge eines automatischen Eintrags führt der Server.");
          }
          checkShoppingQuantity(changes.quantity);
          wanted.quantity = changes.quantity ?? null;
        }
        if (changes.done !== undefined) {
          if (typeof changes.done !== "boolean") {
            throw invalid("Abhaken geht nur mit ja oder nein.");
          }
          // Abhaken eines erledigten Eintrags (und Öffnen eines offenen) bleibt ohne Wirkung.
          if (changes.done !== (item.done_at !== null)) {
            wanted.done = changes.done;
          }
        }
        if (Object.keys(wanted).length > 0) {
          mutation.emit({ type: "shopping_item.update", item_id: item.id, changes: wanted });
        }
      });
    },

    remove(id: string) {
      return runtime.change((mutation) => {
        const item = typeof id === "string" ? mutation.draft.get("shopping_items", id) : undefined;
        if (!item) {
          throw notFound("Den Eintrag gibt es nicht.");
        }
        // Löschen eines gelöschten bleibt ohne Wirkung.
        if (item.deleted_at === null) {
          mutation.emit({ type: "shopping_item.delete", item_id: item.id });
        }
      });
    },
  };
}
