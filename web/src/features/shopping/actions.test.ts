/**
 * Freie Texte auf die Einkaufsliste (`addTextsToShopping`), etwa was einem Vorschlag von Claude fehlt:
 * Doppeltes erkennen, kürzen, Meldung mit „Rückgängig". Auf der Attrappe, ohne Oberfläche.
 *
 * Beispieldaten (src/mock/sample.ts): offen sind Olivenöl, H-Milch 3,5 % (automatisch), Backpapier und
 * Kaffeebohnen; erledigt Butter und Spülmittel.
 */
import { describe, expect, it } from "vitest";

import { CoreError, isOpenItem, LIMITS, type Live } from "@/contract";
import { createMockCore } from "@/mock";
import type { ToastApi, ToastOptions } from "@/ui/base";

import { addTextsToShopping, shoppingText } from "./actions";

function value<T>(live: Live<T>): T {
  const current = live.get();
  if (current === undefined) {
    throw new Error("Live-Wert ist noch nicht geladen");
  }
  return current;
}

/** Ein Toast, der sich die Meldungen merkt. */
function recorder(): ToastApi & { shown: ToastOptions[] } {
  const shown: ToastOptions[] = [];
  return {
    shown,
    show(options) {
      shown.push(options);
      return options.id ?? `toast-${String(shown.length)}`;
    },
    dismiss: () => undefined,
    dismissAll: () => undefined,
  };
}

function openTexts(core: ReturnType<typeof createMockCore>): string[] {
  return value(core.data.shoppingItems)
    .filter((item) => isOpenItem(item) && item.product_id === null)
    .map((item) => item.text);
}

describe("addTextsToShopping", () => {
  it("legt jeden Text als eigenen Eintrag an und bietet Rückgängig an", async () => {
    const core = createMockCore({ latency: 0 });
    const toast = recorder();
    const created = await addTextsToShopping(core, toast, ["Zwiebel", "  Knoblauch  "]);
    expect(created.map((item) => [item.text, item.quantity, item.product_id, item.origin])).toEqual([
      ["Zwiebel", null, null, "manual"],
      ["Knoblauch", null, null, "manual"],
    ]);
    expect(openTexts(core)).toEqual(expect.arrayContaining(["Zwiebel", "Knoblauch"]));
    expect(toast.shown).toHaveLength(1);
    expect(toast.shown[0]).toMatchObject({ message: "2 Einträge stehen jetzt auf der Einkaufsliste.", tone: "success", action: { label: "Rückgängig" } });

    toast.shown[0]?.action?.onAction();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(openTexts(core)).not.toContain("Zwiebel");
    expect(openTexts(core)).not.toContain("Knoblauch");
  });

  it("erkennt, was schon offen dasteht, auch als Produkt und ohne Rücksicht auf die Schreibweise", async () => {
    const core = createMockCore({ latency: 0 });
    const toast = recorder();
    const before = value(core.data.shoppingItems).length;
    // „Backpapier" steht frei auf der Liste, „Olivenöl" als Produkt; „Spülmittel" ist erledigt.
    const created = await addTextsToShopping(core, toast, ["backpapier", "OLIVENÖL", "Spülmittel", "Zitrone", "zitrone"]);
    expect(created.map((item) => item.text)).toEqual(["Spülmittel", "Zitrone"]);
    expect(value(core.data.shoppingItems)).toHaveLength(before + 2);
    expect(toast.shown[0]?.message).toBe("2 Einträge stehen jetzt auf der Einkaufsliste. 2 standen schon dort.");

    const again = await addTextsToShopping(core, toast, ["Zitrone"]);
    expect(again).toEqual([]);
    expect(toast.shown[1]).toMatchObject({ message: "„Zitrone“ steht schon auf der Einkaufsliste." });
    expect(toast.shown[1]?.action).toBeUndefined();

    await addTextsToShopping(core, toast, ["Zitrone", "Backpapier"]);
    expect(toast.shown[2]?.message).toBe("Das steht alles schon auf der Einkaufsliste.");

    await addTextsToShopping(core, toast, ["Dill", "Zitrone"]);
    expect(toast.shown[3]?.message).toBe("„Dill“ steht jetzt auf der Einkaufsliste. „Zitrone“ stand schon dort.");
  });

  it("kürzt lange Texte auf die Grenze der Liste und lässt Leeres weg", async () => {
    const core = createMockCore({ latency: 0 });
    const toast = recorder();
    const long = `Sehr ${"lange ".repeat(40)}Zutat`;
    const created = await addTextsToShopping(core, toast, ["", "   ", long, "Erste\n Zeile"]);
    expect(created).toHaveLength(2);
    expect(created[0]?.text.length).toBe(LIMITS.shopping_text);
    expect(created[1]?.text).toBe("Erste Zeile");
    expect(shoppingText("  a   b  ")).toBe("a b");
    expect(Array.from(shoppingText("ä".repeat(500)))).toHaveLength(LIMITS.shopping_text);
  });

  it("sagt, wenn der Kern ablehnt, und behält, was schon angelegt ist", async () => {
    const core = createMockCore({ latency: 0 });
    const toast = recorder();
    const original = core.shopping.create.bind(core.shopping);
    let calls = 0;
    core.shopping.create = async (input) => {
      calls += 1;
      if (calls === 2) {
        throw new CoreError("internal", "Der Speicher des Geräts ist voll.");
      }
      return original(input);
    };
    const created = await addTextsToShopping(core, toast, ["Zwiebel", "Knoblauch", "Ingwer"]);
    expect(created.map((item) => item.text)).toEqual(["Zwiebel"]);
    expect(toast.shown[0]).toMatchObject({ tone: "danger" });
    expect(toast.shown[0]?.message).toMatch(/^Nur ein Eintrag kam auf die Liste\. /);
  });
});
