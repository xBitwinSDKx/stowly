/**
 * Die Einkaufsliste auf der Attrappe: offene und erledigte Einträge, Anlegen mit Produkt oder
 * Text, Abhaken, Wiederöffnen, Ändern, Löschen, automatische Einträge und der Betrieb offline.
 *
 * Beispieldaten (src/mock/sample.ts): offen Olivenöl (1×), H-Milch (automatisch, fehlt 2),
 * Backpapier, Kaffeebohnen (2×); erledigt Butter (automatisch) und Spülmittel.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { isOpenItem, ROUTES, type Core, type Live, type ShoppingItem } from "@/contract";
import { renderApp } from "@/app/render.test-setup";
import { setTestViewport } from "@/ui/testing";

function value<T>(live: Live<T>): T {
  const current = live.get();
  if (current === undefined) {
    throw new Error("Live-Wert ist noch nicht geladen");
  }
  return current;
}

async function ready(): Promise<void> {
  await screen.findByRole("heading", { name: "Einkaufsliste", level: 1 });
}

function openList(): HTMLElement {
  return screen.getByRole("list", { name: "Offene Einträge" });
}

function doneList(): HTMLElement {
  return screen.getByRole("list", { name: "Erledigte Einträge" });
}

/** Die Namen der Ankreuzfelder einer Liste, in der gezeigten Reihenfolge. */
function names(list: HTMLElement): string[] {
  return within(list)
    .getAllByRole("checkbox")
    .map((box) => box.getAttribute("aria-label") ?? "");
}

function itemNamed(core: Core, text: string): ShoppingItem | undefined {
  return value(core.data.shoppingItems).find((item) => item.text === text);
}

function productId(core: Core, name: string): string {
  return value(core.data.products).find((product) => product.name === name)?.id ?? "";
}

describe("Einkaufsliste", () => {
  it("zeigt offene Einträge oben, die ältesten zuerst, erledigte darunter", async () => {
    renderApp({}, ROUTES.shopping);
    await ready();
    expect(names(openList())).toEqual(["Olivenöl, 1×", "H-Milch 3,5 %, fehlt 2", "Backpapier", "Kaffeebohnen, 2×"]);
    expect(names(doneList())).toEqual(["Butter, fehlt 1", "Spülmittel"]);
    expect(within(doneList()).getAllByRole("checkbox").every((box) => (box as HTMLInputElement).checked)).toBe(true);
    // Gelöschte und alte erledigte Einträge erscheinen nicht.
    expect(screen.queryByText("Alufolie")).not.toBeInTheDocument();
    expect(screen.queryByText("Grillkohle")).not.toBeInTheDocument();
  });

  it("kennzeichnet automatische Einträge und nennt Bestand und Mindestbestand", async () => {
    renderApp({}, ROUTES.shopping);
    await ready();
    const milk = within(openList()).getByRole("checkbox", { name: "H-Milch 3,5 %, fehlt 2" }).closest("li") as HTMLElement;
    expect(milk).toHaveTextContent("automatisch");
    expect(milk).toHaveTextContent("Almhof · 1 l · im Bestand: 6 · Mindestbestand: 8");
    // Die Menge eines automatischen Eintrags führt der Server: nicht änderbar.
    expect(within(milk).queryByRole("button", { name: /^Ändern/ })).not.toBeInTheDocument();
    const oil = within(openList()).getByRole("checkbox", { name: "Olivenöl, 1×" }).closest("li") as HTMLElement;
    expect(oil).not.toHaveTextContent("automatisch");
    expect(oil).toHaveTextContent("750 ml · im Bestand: 1");
    expect(within(oil).getByRole("button", { name: "Ändern: Olivenöl" })).toBeInTheDocument();
  });

  it("erklärt, woher automatische Einträge kommen und wann eigene erledigt sind", async () => {
    renderApp({}, ROUTES.shopping);
    await ready();
    expect(screen.getByText(/mit Verbindung Sekunden nach dem Entnehmen, ohne Verbindung nach dem nächsten Abgleich/)).toBeInTheDocument();
    expect(screen.getByText(/mit Produkt sind erledigt, sobald dieses Produkt eingelagert wird/)).toBeInTheDocument();
    expect(within(screen.getByRole("main")).getByRole("link", { name: "Bestand" })).toHaveAttribute("href", ROUTES.stock);
  });

  it("ist über die Navigation erreichbar und nennt dort die offenen Einträge", async () => {
    renderApp();
    await screen.findByRole("heading", { name: "Bestand" });
    const link = within(screen.getByRole("navigation", { name: "Hauptnavigation" })).getByRole("link", { name: "Einkaufsliste: 4 offen" });
    expect(link).toHaveTextContent("4");
    await userEvent.click(link);
    await ready();
    expect(document.title).toBe("Einkaufsliste · Stowly");
  });

  it("steht am Handy im Menü gleich hinter dem Bestand", async () => {
    setTestViewport(375);
    renderApp();
    await screen.findByRole("heading", { name: "Bestand" });
    await userEvent.click(screen.getByRole("button", { name: "Menü" }));
    const links = within(screen.getByRole("dialog", { name: "Menü" })).getAllByRole("link");
    expect(links[1]).toHaveTextContent("Einkaufsliste4 offen");
    await userEvent.click(links[1] as HTMLElement);
    await ready();
  });

  it("sagt, wenn nichts auf der Liste steht", async () => {
    renderApp({ scenarios: ["empty"] }, ROUTES.shopping);
    await ready();
    expect(screen.getByRole("heading", { name: "Nichts auf der Liste" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Erledigt" })).not.toBeInTheDocument();
  });
});

describe("Neuer Eintrag", () => {
  it("legt freien Text mit Menge an und bleibt für den nächsten bereit", async () => {
    const core = renderApp({}, ROUTES.shopping);
    await ready();
    const what = screen.getByLabelText("Was fehlt?");
    await userEvent.type(what, "Brot");
    await userEvent.type(screen.getByLabelText("Menge"), "2");
    await userEvent.click(screen.getByRole("button", { name: "Hinzufügen" }));

    await waitFor(() => expect(names(openList()).at(-1)).toBe("Brot, 2×"));
    expect(itemNamed(core, "Brot")).toMatchObject({ product_id: null, quantity: 2, origin: "manual", done_at: null });
    expect(screen.getByLabelText("Was fehlt?")).toHaveValue("");
    expect(screen.getByLabelText("Menge")).toHaveValue("");
    expect(screen.getByLabelText("Was fehlt?")).toHaveFocus();
    expect(screen.getByText("„Brot“ steht jetzt auf der Liste.")).toBeInTheDocument();

    // Mit Enter, ohne Menge
    await userEvent.type(screen.getByLabelText("Was fehlt?"), "Zahnpasta{Enter}");
    await waitFor(() => expect(names(openList()).at(-1)).toBe("Zahnpasta"));
  });

  it("schlägt beim Tippen Produkte vor und legt den Eintrag mit Produkt an", async () => {
    const core = renderApp({}, ROUTES.shopping);
    await ready();
    await userEvent.type(screen.getByLabelText("Was fehlt?"), "reis");
    const suggestions = screen.getByRole("list", { name: "Passende Produkte" });
    const rice = within(suggestions).getByRole("button", { name: /Basmati Reis/ });
    expect(rice).toHaveTextContent("Kornhaus · 1 kg · im Bestand: 4");
    await userEvent.click(rice);

    // Das Suchfeld weicht dem gewählten Produkt; weiter geht es mit der Menge.
    expect(screen.queryByRole("textbox", { name: "Was fehlt?" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Was fehlt?" })).toHaveTextContent("Basmati ReisKornhaus · 1 kg");
    expect(screen.getByLabelText("Menge")).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Hinzufügen" }));

    await waitFor(() => expect(names(openList()).at(-1)).toBe("Basmati Reis"));
    expect(value(core.data.shoppingItems).find((item) => item.product_id === productId(core, "Basmati Reis"))).toMatchObject({ text: "", quantity: null, origin: "manual" });
    await waitFor(() => expect(screen.getByLabelText("Was fehlt?")).toHaveFocus());
  });

  it("erreicht die Vorschläge mit den Pfeiltasten und wählt mit Enter", async () => {
    renderApp({}, ROUTES.shopping);
    await ready();
    await userEvent.type(screen.getByLabelText("Was fehlt?"), "sonnenhof");
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: /Kidneybohnen/ })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: /Passierte Tomaten/ })).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(screen.getByLabelText("Was fehlt?")).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByText("Kidneybohnen")).toBeInTheDocument();
    // Ein anderes Produkt oder doch freier Text
    await userEvent.click(screen.getByRole("button", { name: "Anderes Produkt oder freien Text wählen" }));
    expect(screen.getByLabelText("Was fehlt?")).toHaveValue("sonnenhof");
    await waitFor(() => expect(screen.getByLabelText("Was fehlt?")).toHaveFocus());
  });

  it("legt keinen zweiten Eintrag an, wenn dasselbe schon offen auf der Liste steht; bewusst geht es doch", async () => {
    const core = renderApp({}, ROUTES.shopping);
    const create = vi.spyOn(core.shopping, "create");
    await ready();
    await userEvent.type(screen.getByLabelText("Was fehlt?"), "backpapier{Enter}");
    expect(await screen.findByText("„backpapier“ steht schon auf der Liste.")).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Trotzdem hinzufügen" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ text: "backpapier", quantity: null }));

    // Ein Produkt, das automatisch auf der Liste steht
    await userEvent.type(screen.getByLabelText("Was fehlt?"), "h-milch");
    await userEvent.click(within(screen.getByRole("list", { name: "Passende Produkte" })).getByRole("button", { name: /H-Milch/ }));
    await userEvent.click(screen.getByRole("button", { name: "Hinzufügen" }));
    expect(await screen.findByText("„H-Milch 3,5 %“ steht schon auf der Liste (fehlt 2).")).toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("prüft Text und Menge nach den Grenzen des Vertrags", async () => {
    const core = renderApp({}, ROUTES.shopping);
    const create = vi.spyOn(core.shopping, "create");
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Hinzufügen" }));
    expect(screen.getByLabelText("Was fehlt?")).toBeInvalid();
    expect(screen.getByText("Der Eintrag braucht einen Text.")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Was fehlt?"), "x".repeat(121));
    expect(screen.getByText("Der Text ist zu lang (höchstens 120 Zeichen).")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Was fehlt?"));
    await userEvent.type(screen.getByLabelText("Was fehlt?"), "Senf");
    await userEvent.type(screen.getByLabelText("Menge"), "0");
    await userEvent.click(screen.getByRole("button", { name: "Hinzufügen" }));
    expect(screen.getByText("Die Menge muss zwischen 1 und 999 liegen.")).toBeInTheDocument();
    expect(screen.getByLabelText("Menge")).toHaveFocus();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("Abhaken und wieder öffnen", () => {
  it("hakt ab, verschiebt den Eintrag zu den erledigten und gibt den Fokus an den nächsten", async () => {
    const core = renderApp({}, ROUTES.shopping);
    await ready();
    const paper = within(openList()).getByRole("checkbox", { name: "Backpapier" });
    paper.focus();
    await userEvent.keyboard(" ");

    await waitFor(() => expect(names(doneList())[0]).toBe("Backpapier"));
    expect(names(openList())).not.toContain("Backpapier");
    expect(itemNamed(core, "Backpapier")?.done_at).not.toBeNull();
    // Weiter mit dem nächsten offenen Eintrag
    await waitFor(() => expect(within(openList()).getByRole("checkbox", { name: "Kaffeebohnen, 2×" })).toHaveFocus());

    // Rückgängig öffnet ihn wieder.
    expect(screen.getByText("„Backpapier“ abgehakt")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Rückgängig" }));
    await waitFor(() => expect(names(openList())).toContain("Backpapier"));
    expect(itemNamed(core, "Backpapier")?.done_at).toBeNull();
  });

  it("öffnet einen erledigten Eintrag wieder", async () => {
    const core = renderApp({}, ROUTES.shopping);
    await ready();
    await userEvent.click(within(doneList()).getByRole("checkbox", { name: "Spülmittel" }));
    await waitFor(() => expect(names(openList())).toContain("Spülmittel"));
    expect(screen.getByText("„Spülmittel“ ist wieder offen")).toBeInTheDocument();
    expect(itemNamed(core, "Spülmittel")?.done_at).toBeNull();
  });

  it("blendet die erledigten auf Wunsch aus und merkt sich das", async () => {
    renderApp({}, ROUTES.shopping);
    await ready();
    const done = screen.getByRole("region", { name: "Erledigt" });
    await userEvent.click(within(done).getByRole("button", { name: "Verbergen" }));
    expect(screen.queryByRole("list", { name: "Erledigte Einträge" })).not.toBeInTheDocument();
    expect(within(done).getByRole("button", { name: "Zeigen" })).toHaveAttribute("aria-expanded", "false");
    expect(localStorage.getItem("stowly.ui.shopping.done")).toBe("0");
    await userEvent.click(within(done).getByRole("button", { name: "Zeigen" }));
    expect(doneList()).toBeInTheDocument();
  });
});

describe("Ändern und löschen", () => {
  it("ändert Menge und Text eines eigenen Eintrags", async () => {
    const core = renderApp({}, ROUTES.shopping);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Ändern: Kaffeebohnen" }));
    const dialog = screen.getByRole("dialog", { name: "Eintrag ändern" });
    await userEvent.clear(within(dialog).getByLabelText("Text"));
    await userEvent.type(within(dialog).getByLabelText("Text"), "Kaffeebohnen, kräftig");
    await userEvent.clear(within(dialog).getByLabelText("Menge"));
    await userEvent.type(within(dialog).getByLabelText("Menge"), "3");
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(names(openList())).toContain("Kaffeebohnen, kräftig, 3×");
    expect(itemNamed(core, "Kaffeebohnen, kräftig")?.quantity).toBe(3);
  });

  it("ändert bei einem Eintrag mit Produkt nur die Menge; leer heißt ohne Angabe", async () => {
    const core = renderApp({}, ROUTES.shopping);
    const update = vi.spyOn(core.shopping, "update");
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Ändern: Olivenöl" }));
    const dialog = screen.getByRole("dialog", { name: "Eintrag ändern" });
    expect(within(dialog).queryByLabelText("Text")).not.toBeInTheDocument();
    expect(dialog).toHaveTextContent("Olivenöl");
    await userEvent.clear(within(dialog).getByLabelText("Menge"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(update).toHaveBeenCalledWith(expect.any(String), { quantity: null });
    expect(names(openList())).toContain("Olivenöl");
  });

  it("prüft die Menge im Dialog", async () => {
    const core = renderApp({}, ROUTES.shopping);
    const update = vi.spyOn(core.shopping, "update");
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Ändern: Backpapier" }));
    const dialog = screen.getByRole("dialog", { name: "Eintrag ändern" });
    await userEvent.type(within(dialog).getByLabelText("Menge"), "abc");
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(within(dialog).getByText("Bitte eine ganze Zahl von 1 bis 999 eingeben oder das Feld leer lassen.")).toBeInTheDocument();
    await userEvent.clear(within(dialog).getByLabelText("Text"));
    expect(within(dialog).getByText("Der Eintrag braucht einen Text.")).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it("löscht einen eigenen Eintrag sofort; Rückgängig legt ihn neu an", async () => {
    const core = renderApp({}, ROUTES.shopping);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Löschen: Backpapier" }));
    await waitFor(() => expect(names(openList())).not.toContain("Backpapier"));
    expect(value(core.data.shoppingItems).some((item) => item.text === "Backpapier" && isOpenItem(item))).toBe(false);
    expect(screen.getByText("„Backpapier“ gelöscht")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Rückgängig" }));
    await waitFor(() => expect(names(openList())).toContain("Backpapier"));
  });

  it("fragt vor dem Löschen eines automatischen Eintrags und sagt, wann er wiederkommt", async () => {
    const core = renderApp({}, ROUTES.shopping);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Löschen: H-Milch 3,5 %" }));
    const dialog = screen.getByRole("dialog", { name: "„H-Milch 3,5 %“ löschen?" });
    expect(dialog).toHaveTextContent("Gelöscht kommt er erst wieder, wenn „H-Milch 3,5 %“ eingelagert oder sein Mindestbestand geändert wird.");
    expect(dialog).toHaveTextContent("Wer es schon gekauft hat, hakt es besser ab: Das lässt sich wieder öffnen.");
    // Abbrechen ändert nichts.
    await userEvent.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
    expect(names(openList())).toContain("H-Milch 3,5 %, fehlt 2");

    await userEvent.click(screen.getByRole("button", { name: "Löschen: H-Milch 3,5 %" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "„H-Milch 3,5 %“ löschen?" })).getByRole("button", { name: "Löschen" }));
    await waitFor(() => expect(names(openList())).not.toContain("H-Milch 3,5 %, fehlt 2"));
    expect(value(core.data.shoppingItems).some((item) => item.product_id === productId(core, "H-Milch 3,5 %") && isOpenItem(item))).toBe(false);
    // Der Fokus geht an den Nachbarn, statt verloren zu gehen.
    await waitFor(() => expect(within(openList()).getByRole("checkbox", { name: "Backpapier" })).toHaveFocus());
  });

  it("löscht alle erledigten nach Rückfrage", async () => {
    const core = renderApp({}, ROUTES.shopping);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Erledigte löschen" }));
    const dialog = screen.getByRole("dialog", { name: "Alle 2 erledigten Einträge löschen?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Löschen" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Erledigt" })).not.toBeInTheDocument());
    expect(value(core.data.shoppingItems).filter((item) => item.done_at !== null)).toEqual([]);
    expect(screen.getByText("2 erledigte Einträge gelöscht")).toBeInTheDocument();
    expect(names(openList())).toHaveLength(4);
  });
});

describe("Automatische Einträge und Betrieb ohne Netz", () => {
  it("zeigt den automatischen Eintrag, sobald der Server ihn nach dem Entnehmen angelegt hat", async () => {
    const core = renderApp({}, ROUTES.shopping);
    await ready();
    // Spaghetti: 5 im Bestand, mindestens 3
    const spaghetti = value(core.data.packages).filter((pkg) => pkg.product_id === productId(core, "Spaghetti"));
    await core.stock.remove(
      spaghetti.slice(0, 4).map((pkg) => pkg.id),
      "consumed",
    );
    expect(await within(openList()).findByRole("checkbox", { name: "Spaghetti, fehlt 2" })).toBeInTheDocument();
  });

  it("funktioniert offline; automatische Einträge kommen erst mit dem nächsten Abgleich", async () => {
    const core = renderApp({ scenarios: ["offline"] }, ROUTES.shopping);
    await ready();
    expect(screen.getByText("Der Server ist nicht erreichbar")).toBeInTheDocument();
    expect(screen.getByText(/neue automatische Einträge kommen erst dann/)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Was fehlt?"), "Brot{Enter}");
    await waitFor(() => expect(names(openList())).toContain("Brot"));
    await userEvent.click(within(openList()).getByRole("checkbox", { name: "Backpapier" }));
    await waitFor(() => expect(names(doneList())).toContain("Backpapier"));

    const spaghetti = value(core.data.packages).filter((pkg) => pkg.product_id === productId(core, "Spaghetti"));
    await core.stock.remove(
      spaghetti.slice(0, 4).map((pkg) => pkg.id),
      "consumed",
    );
    // Der Kern nimmt nichts vorweg: Ohne Server gibt es noch keinen Eintrag.
    expect(names(openList())).not.toContain("Spaghetti, fehlt 2");

    core.control.setOnline(true);
    expect(await within(openList()).findByRole("checkbox", { name: "Spaghetti, fehlt 2" })).toBeInTheDocument();
    expect(screen.queryByText("Der Server ist nicht erreichbar")).not.toBeInTheDocument();
  });
});
