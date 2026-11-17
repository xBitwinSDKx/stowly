/**
 * Produkt bearbeiten → „Online abfragen" auf der Attrappe (docs/plan-0.5.md, 2): wann der Knopf da
 * ist, die Gegenüberstellung, Übernehmen, Speichern mit Bild, und was ohne Server geschieht.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CoreError, gtinCheckDigit, ROUTES, type Core, type Live, type Product } from "@/contract";
import { App } from "@/app/App";
import { renderApp } from "@/app/render.test-setup";
import { createMockCore, MockScanPage, ZONE_IDS, type MockCore, type MockOptions } from "@/mock";

function value<T>(live: Live<T>): T {
  const current = live.get();
  if (current === undefined) {
    throw new Error("Live-Wert ist noch nicht geladen");
  }
  return current;
}

function product(core: Core, name: string): Product {
  const found = value(core.data.products).find((candidate) => candidate.name === name);
  if (!found) {
    throw new Error(`Produkt ${name} fehlt`);
  }
  return found;
}

async function openDialog(name: string): Promise<HTMLElement> {
  await screen.findByRole("heading", { name: "Bestand" });
  await userEvent.click(screen.getByRole("button", { name: `Bearbeiten: ${name}` }));
  return screen.getByRole("dialog", { name: "Produkt bearbeiten" });
}

function isLocked(element: HTMLElement): boolean {
  return element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";
}

function mock(options: MockOptions = {}): MockCore {
  return createMockCore({ latency: 0, ...options });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Online abfragen", () => {
  it("gibt es nur mit einem Barcode, den Open Food Facts kennen kann", async () => {
    const core = renderApp();
    // Ohne Barcode: kein Knopf.
    let dialog = await openDialog("Olivenöl");
    expect(within(dialog).queryByRole("button", { name: "Online abfragen" })).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Abbrechen" }));

    // Nur ein ladeninterner Code (Präfix 2): auch keiner.
    const body = "200123400001";
    await core.stock.store({ product: { kind: "new", name: "Wurst vom Metzger", barcodes: [body + String(gtinCheckDigit(body))] }, zone_id: ZONE_IDS.fridge, best_before: null, count: 1, labels: false });
    dialog = await openDialog("Wurst vom Metzger");
    expect(within(dialog).queryByRole("button", { name: "Online abfragen" })).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Abbrechen" }));

    dialog = await openDialog("Basmati Reis");
    expect(within(dialog).getByRole("button", { name: "Online abfragen" })).toBeInTheDocument();
    // Bei einem Barcode keine Auswahl.
    expect(within(dialog).queryByLabelText("Barcode für die Abfrage")).not.toBeInTheDocument();
  });

  it("ist ohne Server gesperrt, mit Grund, und ebenso, wenn der Server nicht nachschlägt", async () => {
    const core = renderApp();
    const dialog = await openDialog("Basmati Reis");
    core.control.setOnline(false);
    await waitFor(() => expect(isLocked(within(dialog).getByRole("button", { name: "Online abfragen" }))).toBe(true));
    expect(dialog).toHaveTextContent("Online abfragen braucht den Server, und der ist gerade nicht erreichbar.");
    core.control.setOnline(true);
    await waitFor(() => expect(isLocked(within(dialog).getByRole("button", { name: "Online abfragen" }))).toBe(false));
    core.control.setLookupEnabled(false);
    await waitFor(() => expect(dialog).toHaveTextContent("Der Server schlägt keine Barcodes nach"));
    expect(isLocked(within(dialog).getByRole("button", { name: "Online abfragen" }))).toBe(true);
  });

  it("fragt bei mehreren Barcodes den gewählten", async () => {
    const core = renderApp({ scenarios: ["lookup-refresh"] });
    const refresh = vi.spyOn(core.products, "refreshLookup");
    const milk = product(core, "H-Milch 3,5 %");
    expect(milk.barcodes).toHaveLength(2);
    const dialog = await openDialog("H-Milch 3,5 %");
    const choice = within(dialog).getByLabelText("Barcode für die Abfrage");
    expect(within(choice).getAllByRole("option").map((option) => option.textContent)).toEqual(milk.barcodes.map((code) => `Barcode ${code}`));
    await userEvent.selectOptions(choice, `Barcode ${milk.barcodes[1] ?? ""}`);
    await userEvent.click(within(dialog).getByRole("button", { name: "Online abfragen" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledWith(milk.barcodes[1]));
  });

  it("stellt gegenüber, hakt Abweichendes vor, übernimmt ins Formular und speichert danach das Bild", async () => {
    const core = renderApp({ scenarios: ["lookup-refresh"] });
    const update = vi.spyOn(core.products, "update");
    const setImage = vi.spyOn(core.products, "setImage");
    const rice = product(core, "Basmati Reis");
    expect(rice.image).toBeNull();
    const dialog = await openDialog("Basmati Reis");
    await userEvent.click(within(dialog).getByRole("button", { name: "Online abfragen" }));

    const compare = await within(dialog).findByRole("region", { name: "Daten von Open Food Facts" });
    expect(compare).toHaveTextContent("Daten von Open Food Facts (ODbL)");
    // Abweichend und vorgehakt: Name, Größe, Bild. Gleich (ohne Haken): die Marke.
    expect(within(compare).getByRole("checkbox", { name: "Name übernehmen" })).toBeChecked();
    expect(within(compare).getByRole("checkbox", { name: "Packungsgröße übernehmen" })).toBeChecked();
    expect(within(compare).getByRole("checkbox", { name: "Bild übernehmen" })).toBeChecked();
    expect(within(compare).queryByRole("checkbox", { name: "Marke übernehmen" })).not.toBeInTheDocument();
    expect(compare).toHaveTextContent("Bio Basmati Reis");
    expect(within(compare).getByRole("img", { name: "Bild von Open Food Facts" })).toBeInTheDocument();
    // Noch ist nichts geändert: Übernehmen schreibt nur ins Formular.
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Basmati Reis");

    await userEvent.click(within(compare).getByRole("checkbox", { name: "Packungsgröße übernehmen" }));
    await userEvent.click(within(compare).getByRole("button", { name: "Übernehmen" }));
    expect(within(dialog).queryByRole("region", { name: "Daten von Open Food Facts" })).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Bio Basmati Reis");
    expect(within(dialog).getByLabelText("Packungsgröße")).toHaveValue("1 kg");
    expect(dialog).toHaveTextContent("Gespeichert wird mit „Speichern“.");
    expect(dialog).toHaveTextContent("Das Bild kommt mit dem Speichern dazu.");
    expect(product(core, "Basmati Reis").image).toBeNull();
    expect(setImage).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(update).toHaveBeenCalledWith(rice.id, { name: "Bio Basmati Reis" });
    expect(setImage).toHaveBeenCalledWith(rice.id, expect.any(String));
    // Erst die Felder, dann das Bild.
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(setImage.mock.invocationCallOrder[0] ?? 0);
    const saved = value(core.data.products).find((candidate) => candidate.id === rice.id);
    expect(saved).toMatchObject({ name: "Bio Basmati Reis", quantity: "1 kg" });
    expect(saved?.image).not.toBeNull();
  });

  it("speichert die Felder auch dann, wenn nur das Bild am fehlenden Server scheitert, und sagt es", async () => {
    const core = renderApp({ scenarios: ["lookup-refresh"] });
    const rice = product(core, "Basmati Reis");
    const dialog = await openDialog("Basmati Reis");
    await userEvent.click(within(dialog).getByRole("button", { name: "Online abfragen" }));
    await userEvent.click(within(await within(dialog).findByRole("region", { name: "Daten von Open Food Facts" })).getByRole("button", { name: "Übernehmen" }));
    core.control.setOnline(false);
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Die Angaben sind gespeichert, das Bild aber nicht: Der Server ist gerade nicht erreichbar. „Speichern“ versucht es noch einmal.");
    expect(value(core.data.products).find((candidate) => candidate.id === rice.id)).toMatchObject({ name: "Bio Basmati Reis", quantity: "500 g", image: null });

    // Der Server ist zurück: „Speichern" bringt das Bild nach.
    core.control.setOnline(true);
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(value(core.data.products).find((candidate) => candidate.id === rice.id)?.image).not.toBeNull();
  });

  it("verwirft mit „Abbrechen“ alles, auch das vorgemerkte Bild", async () => {
    const core = renderApp({ scenarios: ["lookup-refresh"] });
    const setImage = vi.spyOn(core.products, "setImage");
    const before = product(core, "Basmati Reis");
    const dialog = await openDialog("Basmati Reis");
    await userEvent.click(within(dialog).getByRole("button", { name: "Online abfragen" }));
    await userEvent.click(within(await within(dialog).findByRole("region", { name: "Daten von Open Food Facts" })).getByRole("button", { name: "Übernehmen" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(product(core, "Basmati Reis")).toEqual(before);
    expect(setImage).not.toHaveBeenCalled();
  });

  it("sagt, wenn Open Food Facts den Barcode nicht kennt oder gerade bremst", async () => {
    const core = renderApp();
    // Die Attrappe kennt Barcodes mit gerader Endziffer; hier einer mit ungerader.
    const unknown = value(core.data.products).find((candidate) => candidate.name !== "" && candidate.barcodes.length === 1 && Number(candidate.barcodes[0]?.at(-1)) % 2 === 1);
    if (!unknown) {
      throw new Error("Kein Produkt mit ungerader Endziffer");
    }
    const dialog = await openDialog(unknown.name);
    await userEvent.click(within(dialog).getByRole("button", { name: "Online abfragen" }));
    expect(await within(dialog).findByText("Open Food Facts kennt diesen Barcode nicht.")).toBeInTheDocument();
    expect(within(dialog).queryByRole("region", { name: "Daten von Open Food Facts" })).not.toBeInTheDocument();
    // Gleich noch einmal: Der Server fragt je Barcode höchstens einmal in der Minute.
    await userEvent.click(within(dialog).getByRole("button", { name: "Online abfragen" }));
    expect(await within(dialog).findByText("Open Food Facts bremst gerade; in einer Minute noch einmal.")).toBeInTheDocument();
  });

  it("meldet einen Fehler des Kerns", async () => {
    const base = mock();
    const core: Core = {
      ...base,
      products: {
        ...base.products,
        refreshLookup: async () => {
          throw new CoreError("offline", "weg");
        },
      },
    };
    window.history.replaceState(null, "", ROUTES.stock);
    render(<App core={core} scanPage={MockScanPage} />);
    const dialog = await openDialog("Basmati Reis");
    await userEvent.click(within(dialog).getByRole("button", { name: "Online abfragen" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Online abfragen braucht den Server, und der ist gerade nicht erreichbar.");
  });
});
