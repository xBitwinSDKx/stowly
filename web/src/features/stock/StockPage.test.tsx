/**
 * Bestand auf der Attrappe: Liste, Chargen-Ansicht, Filter und die Dialoge
 * (Produkt bearbeiten, Packungen bearbeiten, entnehmen, von Hand einlagern).
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { addDays, formatDate, isPackageId, todayLocal, type Core, type Live, type Package } from "@/contract";
import { App } from "@/app/App";
import { renderApp } from "@/app/render.test-setup";
import { createMockCore, createSampleData, MockScanPage, sampleBarcode, sampleUuid, ZONE_IDS, type MockCore } from "@/mock";
import { setTestViewport } from "@/ui/testing";

function value<T>(live: Live<T>): T {
  const current = live.get();
  if (current === undefined) {
    throw new Error("Live-Wert ist noch nicht geladen");
  }
  return current;
}

function productId(core: Core, name: string): string {
  const product = value(core.data.products).find((candidate) => candidate.name === name);
  if (!product) {
    throw new Error(`Produkt ${name} fehlt`);
  }
  return product.id;
}

function packagesOf(core: Core, name: string): Package[] {
  const id = productId(core, name);
  return value(core.data.packages).filter((pkg) => pkg.product_id === id);
}

/** Zeilen der Bestandsliste: die Produktnamen in der gezeigten Reihenfolge. */
function listedProducts(): string[] {
  return screen.getAllByRole("button", { name: /^Details: / }).map((button) => (button.getAttribute("aria-label") ?? "").replace("Details: ", ""));
}

async function ready(): Promise<void> {
  await screen.findByRole("heading", { name: "Bestand" });
}

describe("Bestandsliste", () => {
  it("zeigt eine Zeile je Produkt mit Zone, kritischstem MHD und Gesamtmenge", async () => {
    const core = renderApp();
    await ready();

    const groups = new Set(value(core.data.packages).map((pkg) => pkg.product_id));
    expect(listedProducts()).toHaveLength(groups.size);

    const row = screen.getByRole("button", { name: "Details: Basmati Reis" }).closest<HTMLElement>('[role="row"]');
    if (!row) {
      throw new Error("Zeile fehlt");
    }
    const cells = within(row).getAllByRole("cell");
    expect(cells[0]).toHaveTextContent("Basmati Reis");
    expect(cells[0]).toHaveTextContent("Kornhaus · 1 kg");
    expect(cells[1]).toHaveTextContent("Vorratsregal");
    expect(cells[1]).toHaveTextContent("Keller");
    // das früheste der drei MHD
    expect(cells[2]).toHaveTextContent(formatDate(addDays(todayLocal(), 132)));
    expect(cells[3]).toHaveTextContent("4");
  });

  it("zeigt die Kennzahlen: Packungen gesamt und was bald abläuft, abgelaufene in Klammern", async () => {
    const core = renderApp();
    await ready();
    expect(screen.getByText("Packungen gesamt").nextElementSibling).toHaveTextContent(String(value(core.data.packages).length));
    // Beispieldaten: 7 Packungen laufen bald ab, 1 ist abgelaufen
    expect(screen.getByText("Läuft bald ab", { selector: "div" }).nextElementSibling).toHaveTextContent("8 (1 abgelaufen)");
  });

  it("setzt abgelaufene und bald ablaufende MHD ab", async () => {
    renderApp();
    await ready();
    const cell = (name: string) => {
      const row = screen.getByRole("button", { name: `Details: ${name}` }).closest<HTMLElement>('[role="row"]');
      return row ? within(row).getAllByRole("cell")[2] : undefined;
    };
    expect(cell("Haferflocken")).toHaveTextContent("abgelaufen");
    expect(cell("Butter")).toHaveTextContent("läuft bald ab");
    expect(cell("Basmati Reis")).not.toHaveTextContent(/abgelaufen|läuft bald ab/);
    expect(cell("Apfelmus")).toHaveTextContent("kein MHD");
  });

  it("kennzeichnet Platzhalter und zeigt ihren Barcode", async () => {
    const core = renderApp();
    await ready();
    const placeholders = value(core.data.products).filter((product) => product.name === "");
    expect(placeholders).toHaveLength(2);
    for (const placeholder of placeholders) {
      const row = screen.getByRole("button", { name: `Details: ${placeholder.barcodes[0] ?? ""}` }).closest<HTMLElement>('[role="row"]');
      expect(row).toHaveTextContent(placeholder.lookup === "pending" ? "wird nachgeschlagen" : "ohne Namen");
    }
  });

  it("sortiert nach den Spalten", async () => {
    renderApp();
    await ready();
    expect(listedProducts().slice(2, 5)).toEqual(["Apfelmus", "Basmati Reis", "Butter"]);

    await userEvent.click(screen.getByRole("button", { name: "Gesamtmenge" }));
    await userEvent.click(screen.getByRole("button", { name: "Gesamtmenge" }));
    expect(listedProducts()[0]).toBe("H-Milch 3,5 %");
    expect(screen.getByRole("columnheader", { name: "Gesamtmenge" })).toHaveAttribute("aria-sort", "descending");

    await userEvent.click(screen.getByRole("button", { name: "Kritischstes MHD" }));
    expect(listedProducts()[0]).toBe("Haferflocken");
    // ohne MHD steht am Ende
    expect(listedProducts().at(-1)).toBe("Apfelmus");
  });

  it("zeigt einen Leerzustand mit den Wegen zum Einlagern", async () => {
    renderApp({ scenarios: ["empty"] });
    await ready();
    expect(screen.getByRole("heading", { name: "Noch nichts eingelagert" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Jetzt scannen" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Von Hand einlagern" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("zeigt Platzhalter statt Fehlern, wenn Verweise ins Leere zeigen", async () => {
    const data = createSampleData();
    const first = data.packages.find((pkg) => pkg.removed_at === null);
    if (!first) {
      throw new Error("Beispieldaten ohne Packung");
    }
    // Ohne Mindestbestand: Sonst stünden die Produkte ohne Packung als „fehlt n" mit in der Liste.
    const products = data.products.map((product) => ({ ...product, min_stock: null }));
    renderApp({ data: { products, packages: [{ ...first, product_id: sampleUuid(2, 999), zone_id: sampleUuid(1, 999) }] } });
    await ready();

    expect(listedProducts()).toEqual(["Unbekanntes Produkt"]);
    const row = screen.getByRole("button", { name: "Details: Unbekanntes Produkt" }).closest<HTMLElement>('[role="row"]');
    expect(row).toHaveTextContent("Unbekannte Zone");
    expect(screen.getByRole("button", { name: "Bearbeiten: Unbekanntes Produkt" })).toBeUnavailable();

    await userEvent.click(screen.getByRole("button", { name: "Details: Unbekanntes Produkt" }));
    expect(screen.getByRole("region", { name: "Bestand im Detail: Unbekanntes Produkt" })).toHaveTextContent(first.id);
  });

  it("zeigt einen Platzhalter, solange der Kern noch lädt", async () => {
    // Ein Kern, der seinen Bestand noch nicht gelesen hat.
    const loading: Live<never> = { get: () => undefined, subscribe: () => () => undefined };
    const core = createMockCore({ latency: 0 });
    const slow: Core = { ...core, data: { ...core.data, packages: loading, settings: loading } };
    render(<App core={slow} scanPage={MockScanPage} />);

    expect(await screen.findByRole("status", { name: "Bestand wird geladen …" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    // Die Pille zählt dann nichts, statt abzustürzen.
    expect(screen.getByRole("link", { name: /MHD-Warnungen/ })).toHaveTextContent("0");
  });
});

describe("Chargen-Ansicht", () => {
  it("klappt unter der Zeile auf: je MHD und Zone eine Zeile mit Menge und Packungs-IDs", async () => {
    const core = renderApp();
    await ready();
    const toggle = screen.getByRole("button", { name: "Details: Basmati Reis" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const panel = screen.getByRole("region", { name: "Bestand im Detail: Basmati Reis" });
    const rows = within(panel).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);

    const today = todayLocal();
    const rice = packagesOf(core, "Basmati Reis");
    const ids = (offset: number, zone: string) =>
      rice
        .filter((pkg) => pkg.best_before === addDays(today, offset) && pkg.zone_id === zone)
        .map((pkg) => pkg.id)
        .sort();
    const expected: [number, string, string][] = [
      [132, "Keller", ZONE_IDS.cellar],
      [135, "Keller", ZONE_IDS.cellar],
      [400, "Vorratsregal", ZONE_IDS.shelf],
    ];
    rows.forEach((row, index) => {
      const [offset, zoneName, zoneId] = expected[index] ?? [0, "", ""];
      const cells = within(row).getAllByRole("cell");
      expect(cells[0]).toHaveTextContent(formatDate(addDays(today, offset)));
      expect(cells[1]).toHaveTextContent(String(ids(offset, zoneId).length));
      expect(cells[2]).toHaveTextContent(zoneName);
      expect(within(row).getAllByRole("listitem").map((item) => item.textContent)).toEqual(ids(offset, zoneId));
    });

    await userEvent.click(within(panel).getByRole("button", { name: "Einklappen" }));
    expect(screen.queryByRole("region", { name: "Bestand im Detail: Basmati Reis" })).not.toBeInTheDocument();
  });

  it("zeigt mit dem Umschalter „Details“ alle Chargen und merkt sich das", async () => {
    renderApp();
    await ready();
    const all = screen.getByRole("switch", { name: "Details" });
    await userEvent.click(all);
    expect(screen.getAllByRole("region", { name: /^Bestand im Detail: / })).toHaveLength(listedProducts().length);
    expect(localStorage.getItem("stowly.ui.stock.details")).toBe("1");

    // einzelne Zeile wieder einklappen
    await userEvent.click(screen.getByRole("button", { name: "Details: Butter" }));
    expect(screen.queryByRole("region", { name: "Bestand im Detail: Butter" })).not.toBeInTheDocument();

    await userEvent.click(all);
    expect(screen.queryByRole("region", { name: /^Bestand im Detail: / })).not.toBeInTheDocument();
  });

  it("öffnet sich auch mit einem Klick in die Zeile", async () => {
    renderApp();
    await ready();
    await userEvent.click(screen.getByRole("cell", { name: /Kidneybohnen/ }));
    expect(screen.getByRole("region", { name: "Bestand im Detail: Kidneybohnen" })).toBeInTheDocument();
  });
});

describe("Filter", () => {
  it("filtert mit einer Zonen-Karte und zeigt dann nur, was dort liegt", async () => {
    const core = renderApp();
    await ready();
    const cards = screen.getByRole("group", { name: "Nach Zone filtern" });
    const cellar = within(cards).getByRole("button", { name: /Keller/ });
    expect(cellar).toHaveAttribute("aria-pressed", "false");
    const inCellar = value(core.data.packages).filter((pkg) => pkg.zone_id === ZONE_IDS.cellar);
    expect(cellar).toHaveTextContent(`Status: ${String(inCellar.length)}`);

    await userEvent.click(cellar);
    expect(cellar).toHaveAttribute("aria-pressed", "true");
    expect(listedProducts()).toHaveLength(new Set(inCellar.map((pkg) => pkg.product_id)).size);
    expect(listedProducts()).not.toContain("Butter");
    // Basmati Reis: 3 von 4 Packungen liegen im Keller
    const row = screen.getByRole("button", { name: "Details: Basmati Reis" }).closest<HTMLElement>('[role="row"]');
    expect(row ? within(row).getAllByRole("cell")[3] : null).toHaveTextContent("3");

    await userEvent.click(screen.getByRole("button", { name: /Zonen-Filter zurücksetzen/ }));
    expect(listedProducts()).toContain("Butter");
    expect(cellar).toHaveAttribute("aria-pressed", "false");
  });

  it("filtert mit der Karte „Läuft bald ab“", async () => {
    renderApp();
    await ready();
    await userEvent.click(within(screen.getByRole("group", { name: "Nach Zone filtern" })).getByRole("button", { name: /Läuft bald ab/ }));
    expect(listedProducts()).toEqual(expect.arrayContaining(["Butter", "Haferflocken", "Lachsfilet (TK)", "Passierte Tomaten", "Weizenmehl Type 405"]));
    expect(listedProducts()).not.toContain("Basmati Reis");
    // Butter: nur die eine Packung, die bald abläuft
    const row = screen.getByRole("button", { name: "Details: Butter" }).closest<HTMLElement>('[role="row"]');
    expect(row ? within(row).getAllByRole("cell")[3] : null).toHaveTextContent("1");
  });

  it("findet über Name, Marke, Barcode und Packungs-ID", async () => {
    const core = renderApp();
    await ready();
    const search = screen.getByRole("searchbox", { name: "Bestand durchsuchen" });

    await userEvent.type(search, "sonnenhof");
    expect(listedProducts()).toEqual(["Kidneybohnen", "Passierte Tomaten"]);

    await userEvent.clear(search);
    const butter = value(core.data.products).find((product) => product.name === "Butter");
    await userEvent.type(search, butter?.barcodes[0] ?? "");
    expect(listedProducts()).toEqual(["Butter"]);

    await userEvent.clear(search);
    const pkg = packagesOf(core, "Spaghetti")[0];
    await userEvent.type(search, (pkg?.id ?? "").toLowerCase());
    expect(listedProducts()).toEqual(["Spaghetti"]);
    // nur diese eine Packung, gleich aufgeklappt
    const panel = screen.getByRole("region", { name: "Bestand im Detail: Spaghetti" });
    expect(within(panel).getAllByRole("listitem").map((item) => item.textContent)).toEqual([pkg?.id]);
  });

  it("sagt, wenn nichts gefunden wurde, und verweist bei entnommenen Packungen auf die Lösch-Historie", async () => {
    const core = renderApp();
    await ready();
    const search = screen.getByRole("searchbox", { name: "Bestand durchsuchen" });
    await userEvent.type(search, "gibtesnicht");
    expect(screen.getByRole("heading", { name: "Keine Treffer" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Filter zurücksetzen" }));
    expect(listedProducts().length).toBeGreaterThan(5);

    const removed = value(core.data.removedPackages)[0];
    await userEvent.type(search, removed?.id ?? "");
    expect(screen.getByText(`Die Packung ${removed?.id ?? ""} wurde entnommen.`)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "Zur Lösch-Historie" }));
    expect(await screen.findByRole("heading", { name: "Lösch-Historie" })).toBeInTheDocument();
  });

  it("verweist auch bei leerem Bestand auf die Lösch-Historie, wenn die gesuchte Packung dort liegt", async () => {
    const core = renderApp({ scenarios: ["empty"] });
    await ready();
    const zone = value(core.data.zones)[0];
    const stored = await core.stock.store({ product: { kind: "new", name: "Probierglas" }, zone_id: zone?.id ?? "", best_before: null, count: 1 });
    const id = stored.packages[0]?.id ?? "";
    await core.stock.remove([id], "mistake");
    expect(await screen.findByRole("heading", { name: "Noch nichts eingelagert" })).toBeInTheDocument();

    await userEvent.type(screen.getByRole("searchbox", { name: "Bestand durchsuchen" }), id);
    expect(await screen.findByText(`Die Packung ${id} wurde entnommen.`)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Zur Lösch-Historie" })).toBeInTheDocument();
  });
});

describe("Produkt bearbeiten", () => {
  async function openDialog(name: string): Promise<HTMLElement> {
    await ready();
    await userEvent.click(screen.getByRole("button", { name: `Bearbeiten: ${name}` }));
    return screen.getByRole("dialog", { name: "Produkt bearbeiten" });
  }

  it("ändert Name, Marke, Packungsgröße und die eigene Vorlaufzeit", async () => {
    const core = renderApp();
    const dialog = await openDialog("Basmati Reis");
    const id = productId(core, "Basmati Reis");

    const name = within(dialog).getByLabelText("Name");
    expect(name).toHaveValue("Basmati Reis");
    await userEvent.clear(name);
    await userEvent.type(name, "Basmatireis");
    await userEvent.clear(within(dialog).getByLabelText("Packungsgröße"));
    await userEvent.type(within(dialog).getByLabelText("Packungsgröße"), "2 kg");
    await userEvent.type(within(dialog).getByLabelText("Eigene Vorlaufzeit der MHD-Warnung"), "30");
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(value(core.data.products).find((product) => product.id === id)).toMatchObject({ name: "Basmatireis", brand: "Kornhaus", quantity: "2 kg", warn_days: 30 });
    expect(screen.getByRole("button", { name: "Details: Basmatireis" })).toBeInTheDocument();
  });

  it("entfernt die eigene Vorlaufzeit, wenn das Feld geleert wird", async () => {
    const core = renderApp();
    const dialog = await openDialog("Butter");
    const field = within(dialog).getByLabelText("Eigene Vorlaufzeit der MHD-Warnung");
    expect(field).toHaveValue("5");
    expect(field).toHaveAccessibleDescription(/Leer = Wert des Haushalts \(14 Tage\)/);
    await userEvent.clear(field);
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(value(core.data.products).find((product) => product.name === "Butter")?.warn_days).toBeNull();
  });

  it("prüft die Eingaben", async () => {
    const core = renderApp();
    const dialog = await openDialog("Butter");
    await userEvent.clear(within(dialog).getByLabelText("Name"));
    await userEvent.clear(within(dialog).getByLabelText("Eigene Vorlaufzeit der MHD-Warnung"));
    await userEvent.type(within(dialog).getByLabelText("Eigene Vorlaufzeit der MHD-Warnung"), "abc");
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));

    expect(within(dialog).getByLabelText("Name")).toBeInvalid();
    expect(within(dialog).getByText("Bitte einen Namen eingeben.")).toBeInTheDocument();
    expect(within(dialog).getByText(/ganze Zahl von 0 bis 3650/)).toBeInTheDocument();
    expect(value(core.data.products).find((product) => product.name === "Butter")?.warn_days).toBe(5);
  });

  it("fügt Barcodes hinzu und entfernt sie, übernommen wird beim Speichern", async () => {
    const core = renderApp();
    const dialog = await openDialog("Butter");
    const id = productId(core, "Butter");
    const before = value(core.data.products).find((product) => product.id === id)?.barcodes ?? [];
    const fresh = sampleBarcode(700);

    const input = within(dialog).getByLabelText("Barcode hinzufügen");
    await userEvent.type(input, "12345");
    await userEvent.click(within(dialog).getByRole("button", { name: "Hinzufügen" }));
    expect(within(dialog).getByText(/Kein gültiger Barcode/)).toBeInTheDocument();

    await userEvent.clear(input);
    await userEvent.type(input, `${fresh}{Enter}`);
    expect(within(dialog).getByText(fresh)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: `Barcode ${before[0] ?? ""} entfernen` }));
    // noch nichts gespeichert
    expect(value(core.data.products).find((product) => product.id === id)?.barcodes).toEqual(before);

    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(value(core.data.products).find((product) => product.id === id)?.barcodes).toEqual([fresh]);
  });

  it("bietet das Zusammenführen an, wenn der Barcode schon zu einem anderen Produkt gehört", async () => {
    const core = renderApp();
    const dialog = await openDialog("Basmati Reis");
    const rice = productId(core, "Basmati Reis");
    const spaghetti = value(core.data.products).find((product) => product.name === "Spaghetti");
    const moved = packagesOf(core, "Spaghetti").length;
    const before = packagesOf(core, "Basmati Reis").length;

    await userEvent.type(within(dialog).getByLabelText("Barcode hinzufügen"), spaghetti?.barcodes[0] ?? "");
    await userEvent.click(within(dialog).getByRole("button", { name: "Hinzufügen" }));
    expect(within(dialog).getByText(`Der Barcode ${spaghetti?.barcodes[0] ?? ""} gehört schon zu „Spaghetti“.`)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: "Zusammenführen …" }));
    const confirm = screen.getByRole("dialog", { name: "Produkte zusammenführen?" });
    expect(confirm).toHaveTextContent(`Seine ${String(moved)} Packungen und alle seine Barcodes`);
    expect(confirm).toHaveTextContent("Das lässt sich nicht rückgängig machen.");
    // Abbrechen ändert nichts
    await userEvent.click(within(confirm).getByRole("button", { name: "Abbrechen" }));
    expect(value(core.data.products).some((product) => product.id === spaghetti?.id)).toBe(true);

    await userEvent.click(within(dialog).getByRole("button", { name: "Zusammenführen …" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Produkte zusammenführen?" })).getByRole("button", { name: "Zusammenführen" }));
    await waitFor(() => expect(value(core.data.products).some((product) => product.id === spaghetti?.id)).toBe(false));
    expect(value(core.data.packages).filter((pkg) => pkg.product_id === rice)).toHaveLength(before + moved);
    expect(value(core.data.products).find((product) => product.id === rice)?.barcodes).toContain(spaghetti?.barcodes[0]);

    // Der Dialog des Produkts ist noch offen und kennt die neuen Barcodes.
    expect(within(dialog).getByText(spaghetti?.barcodes[0] ?? "")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Details: Spaghetti" })).not.toBeInTheDocument();
  });

  it("zeigt bei Platzhaltern den Barcode und den Stand des Nachschlagens und nimmt einen Namen an", async () => {
    const core = renderApp();
    await ready();
    const placeholder = value(core.data.products).find((product) => product.name === "" && product.lookup === "not_found");
    const barcode = placeholder?.barcodes[0] ?? "";
    const dialog = await openDialog(barcode);

    expect(dialog).toHaveTextContent(`Noch ohne Namen: Barcode ${barcode}`);
    expect(dialog).toHaveTextContent("Open Food Facts kannte diesen Barcode beim Nachschlagen nicht. „Online abfragen“ fragt noch einmal.");
    // Ein Platzhalter darf namenlos bleiben, aber nicht müssen.
    await userEvent.type(within(dialog).getByLabelText("Name"), "Frischkäse");
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(value(core.data.products).find((product) => product.id === placeholder?.id)?.name).toBe("Frischkäse");
    expect(screen.getByRole("button", { name: "Details: Frischkäse" })).toBeInTheDocument();
  });
});

describe("Entnehmen und löschen", () => {
  it("entnimmt eine Auswahl mit Grund und macht es über die Meldung rückgängig", async () => {
    const core = renderApp();
    await ready();
    const lentils = packagesOf(core, "Rote Linsen").map((pkg) => pkg.id);
    expect(lentils).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: "Löschen: Rote Linsen" }));
    const dialog = screen.getByRole("dialog", { name: "Packungen entnehmen" });
    // Bei mehreren Packungen ist nichts vorgewählt: Welche es ist, steht auf dem Etikett.
    expect(within(dialog).getByRole("button", { name: "Auswahl fehlt" })).toBeUnavailable();

    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Alle 2 Packungen" }));
    await userEvent.click(within(dialog).getByRole("radio", { name: "Entsorgt" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "2 entnehmen" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Details: Rote Linsen" })).not.toBeInTheDocument();
    const removed = value(core.data.removedPackages).filter((pkg) => lentils.includes(pkg.id));
    expect(removed.map((pkg) => pkg.removal_reason)).toEqual(["discarded", "discarded"]);

    expect(screen.getByText("2 Packungen entsorgt")).toBeInTheDocument();
    // Die letzten Packungen: Eine zweite Meldung bietet die Einkaufsliste an.
    expect(screen.getByText("„Rote Linsen“ ist nicht mehr im Bestand.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Rückgängig" }));
    expect(await screen.findByRole("button", { name: "Details: Rote Linsen" })).toBeInTheDocument();
    expect(packagesOf(core, "Rote Linsen").map((pkg) => pkg.id).sort()).toEqual([...lentils].sort());
    // Mit den Packungen ist auch das Angebot fort.
    expect(screen.queryByText("„Rote Linsen“ ist nicht mehr im Bestand.")).not.toBeInTheDocument();
  });

  it("entnimmt einzelne Packungen einer Charge", async () => {
    const core = renderApp();
    await ready();
    const today = todayLocal();
    const batch = packagesOf(core, "Basmati Reis")
      .filter((pkg) => pkg.best_before === addDays(today, 132))
      .map((pkg) => pkg.id)
      .sort();
    expect(batch).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: "Details: Basmati Reis" }));
    const panel = screen.getByRole("region", { name: "Bestand im Detail: Basmati Reis" });
    await userEvent.click(within(panel).getByRole("button", { name: `Entnehmen: MHD ${formatDate(addDays(today, 132))}, Keller` }));

    const dialog = screen.getByRole("dialog", { name: "Packungen entnehmen" });
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(3);
    await userEvent.click(within(dialog).getByRole("checkbox", { name: new RegExp(batch[0] ?? "") }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Entnehmen" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(packagesOf(core, "Basmati Reis").map((pkg) => pkg.id)).not.toContain(batch[0]);
    expect(packagesOf(core, "Basmati Reis").map((pkg) => pkg.id)).toContain(batch[1]);
    expect(value(core.data.removedPackages).find((pkg) => pkg.id === batch[0])?.removal_reason).toBe("consumed");
    expect(screen.getByText("1 Packung verbraucht")).toBeInTheDocument();
  });

  it("wählt eine einzelne Packung vor und nennt das Löschen beim Namen", async () => {
    const core = renderApp();
    await ready();
    const [flour] = packagesOf(core, "Weizenmehl Type 405");
    await userEvent.click(screen.getByRole("button", { name: "Löschen: Weizenmehl Type 405" }));
    const dialog = screen.getByRole("dialog", { name: "Packungen entnehmen" });
    expect(dialog).toHaveTextContent(flour?.id ?? "");

    await userEvent.click(within(dialog).getByRole("radio", { name: "Falsch erfasst" }));
    expect(screen.getByRole("dialog", { name: "Packungen löschen" })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Löschen" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(value(core.data.removedPackages).find((pkg) => pkg.id === flour?.id)?.removal_reason).toBe("mistake");
  });
});

describe("Packungen bearbeiten", () => {
  async function openBatch(name: string, label: string): Promise<HTMLElement> {
    await ready();
    await userEvent.click(screen.getByRole("button", { name: `Details: ${name}` }));
    const panel = screen.getByRole("region", { name: `Bestand im Detail: ${name}` });
    await userEvent.click(within(panel).getByRole("button", { name: `Bearbeiten: ${label}` }));
    return screen.getByRole("dialog", { name: /Packungen? bearbeiten/ });
  }

  it("ändert MHD und Zone einer Charge und zeigt, welches Datum verstanden wurde", async () => {
    const core = renderApp();
    const today = todayLocal();
    const dialog = await openBatch("Passierte Tomaten", `MHD ${formatDate(addDays(today, 250))}, Keller`);
    const ids = packagesOf(core, "Passierte Tomaten")
      .filter((pkg) => pkg.best_before === addDays(today, 250))
      .map((pkg) => pkg.id);
    expect(ids).toHaveLength(4);

    const field = within(dialog).getByLabelText("MHD");
    expect(field).toHaveValue(formatDate(addDays(today, 250)));
    await userEvent.clear(field);
    await userEvent.type(field, "03/2031");
    expect(field).toHaveAccessibleDescription(/Verstanden: 31\.03\.2031 \(Ende März 2031\)/);
    await userEvent.selectOptions(within(dialog).getByLabelText("Zone"), "Gefrierschrank");
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const changed = value(core.data.packages).filter((pkg) => ids.includes(pkg.id));
    expect(changed.every((pkg) => pkg.best_before === "2031-03-31" && pkg.zone_id === ZONE_IDS.freezer)).toBe(true);
    // Die andere Charge bleibt, wie sie war.
    expect(packagesOf(core, "Passierte Tomaten").filter((pkg) => pkg.best_before === addDays(today, 9))).toHaveLength(2);
  });

  it("entfernt das MHD einzelner Packungen", async () => {
    const core = renderApp();
    const today = todayLocal();
    const dialog = await openBatch("H-Milch 3,5 %", `MHD ${formatDate(addDays(today, 60))}, Vorratsregal`);
    const milk = packagesOf(core, "H-Milch 3,5 %")
      .map((pkg) => pkg.id)
      .sort();

    // nur zwei der sechs Packungen
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Alle 6 Packungen" }));
    await userEvent.click(within(dialog).getByRole("checkbox", { name: new RegExp(milk[0] ?? "") }));
    await userEvent.click(within(dialog).getByRole("checkbox", { name: new RegExp(milk[1] ?? "") }));
    await userEvent.click(within(dialog).getByRole("button", { name: "MHD leeren" }));
    expect(within(dialog).getByLabelText("MHD")).toHaveAccessibleDescription("Leer = das MHD wird entfernt.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const after = packagesOf(core, "H-Milch 3,5 %");
    expect(after.filter((pkg) => pkg.best_before === null).map((pkg) => pkg.id).sort()).toEqual(milk.slice(0, 2));
    expect(after.filter((pkg) => pkg.best_before !== null)).toHaveLength(4);
  });

  it("speichert nichts, solange das MHD kein Datum ist", async () => {
    const core = renderApp();
    const today = todayLocal();
    const dialog = await openBatch("Kidneybohnen", `MHD ${formatDate(addDays(today, 700))}, Keller`);
    const field = within(dialog).getByLabelText("MHD");
    await userEvent.clear(field);
    await userEvent.type(field, "morgen");
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(field).toBeInvalid();
    expect(screen.getByRole("dialog", { name: "Packungen bearbeiten" })).toBeInTheDocument();
    expect(packagesOf(core, "Kidneybohnen").every((pkg) => pkg.best_before === addDays(today, 700))).toBe(true);
  });
});

describe("Von Hand einlagern", () => {
  it("legt ein neues Produkt an, lagert ein und zeigt die vergebenen Packungs-IDs", async () => {
    const core = renderApp();
    await ready();
    const before = value(core.data.packages).length;
    await userEvent.click(screen.getByRole("button", { name: "Von Hand einlagern" }));
    const dialog = screen.getByRole("dialog", { name: "Von Hand einlagern" });

    await userEvent.click(within(dialog).getByRole("radio", { name: "Neues Produkt" }));
    await userEvent.type(within(dialog).getByLabelText("Name"), "Tomatenmark");
    await userEvent.type(within(dialog).getByLabelText("Marke"), "Sonnenhof");
    await userEvent.click(within(dialog).getByRole("button", { name: "Mehr" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Mehr" }));
    await userEvent.type(within(dialog).getByLabelText("MHD"), "0327");
    await userEvent.selectOptions(within(dialog).getByLabelText("Zone"), "Keller");
    await userEvent.click(within(dialog).getByRole("button", { name: "3 Packungen einlagern" }));

    const done = await screen.findByRole("dialog", { name: "Eingelagert" });
    expect(done).toHaveTextContent("3 × Tomatenmark");
    const stored = packagesOf(core, "Tomatenmark");
    expect(stored).toHaveLength(3);
    expect(stored.every((pkg) => pkg.best_before === "2027-03-31" && pkg.zone_id === ZONE_IDS.cellar && isPackageId(pkg.id))).toBe(true);
    expect(
      within(done)
        .getAllByRole("listitem")
        .map((item) => item.textContent)
        .sort(),
    ).toEqual(stored.map((pkg) => pkg.id).sort());
    expect(value(core.data.packages)).toHaveLength(before + 3);

    await userEvent.click(within(done).getByRole("button", { name: "Fertig" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Details: Tomatenmark" })).toBeInTheDocument();
  });

  it("lagert zu einem vorhandenen Produkt ein und nimmt es auf Wunsch zurück", async () => {
    const core = renderApp();
    await ready();
    const before = packagesOf(core, "Rote Linsen").length;
    await userEvent.click(screen.getByRole("button", { name: "Von Hand einlagern" }));
    const dialog = screen.getByRole("dialog", { name: "Von Hand einlagern" });

    await userEvent.type(within(dialog).getByLabelText("Produkt suchen"), "lins");
    const choices = within(dialog).getByRole("list", { name: "Produkte" });
    expect(within(choices).getAllByRole("button")).toHaveLength(1);
    await userEvent.click(within(choices).getByRole("button", { name: /Rote Linsen/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Einlagern" }));

    const done = await screen.findByRole("dialog", { name: "Eingelagert" });
    expect(packagesOf(core, "Rote Linsen")).toHaveLength(before + 1);
    // Vorgabe im Modus „Primärzone": die Primärzone
    expect(packagesOf(core, "Rote Linsen").at(-1)?.zone_id).toBe(ZONE_IDS.shelf);

    await userEvent.click(within(done).getByRole("button", { name: "Rückgängig" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(packagesOf(core, "Rote Linsen")).toHaveLength(before);
  });

  it("verlangt ein Produkt und ein lesbares MHD", async () => {
    const core = renderApp();
    await ready();
    const before = value(core.data.packages).length;
    await userEvent.click(screen.getByRole("button", { name: "Von Hand einlagern" }));
    const dialog = screen.getByRole("dialog", { name: "Von Hand einlagern" });

    await userEvent.type(within(dialog).getByLabelText("MHD"), "bald");
    await userEvent.click(within(dialog).getByRole("button", { name: "Einlagern" }));
    expect(within(dialog).getByText("Bitte ein Produkt auswählen.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("MHD")).toBeInvalid();
    expect(value(core.data.packages)).toHaveLength(before);
  });

  it("weist bei einem neuen Produkt auf einen schon vergebenen Barcode hin", async () => {
    const core = renderApp();
    await ready();
    const butter = value(core.data.products).find((product) => product.name === "Butter");
    await userEvent.click(screen.getByRole("button", { name: "Von Hand einlagern" }));
    const dialog = screen.getByRole("dialog", { name: "Von Hand einlagern" });

    await userEvent.click(within(dialog).getByRole("radio", { name: "Neues Produkt" }));
    await userEvent.type(within(dialog).getByLabelText("Name"), "Süßrahmbutter");
    await userEvent.type(within(dialog).getByLabelText("Barcode (freiwillig)"), butter?.barcodes[0] ?? "");
    expect(within(dialog).getByText("Diesen Barcode hat schon „Butter“.")).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: "Dieses Produkt verwenden" }));
    expect(within(dialog).getByRole("radio", { name: "Vorhandenes Produkt" })).toBeChecked();
    expect(dialog).toHaveTextContent("Butter");
    expect(dialog).toHaveTextContent("Almhof · 250 g");
  });

  it("lagert bei mehrfachem Drücken genau einmal ein und lässt den Fokus danach nicht auf „Fertig“", async () => {
    const core = renderApp();
    await ready();
    const before = packagesOf(core, "Kidneybohnen").length;
    // Das Einlagern wartet, bis der Test es freigibt.
    let release: () => void = () => undefined;
    const store = core.stock.store.bind(core.stock);
    const spy = vi.spyOn(core.stock, "store").mockImplementation(async (request) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return store(request);
    });
    await userEvent.click(screen.getByRole("button", { name: "Details: Kidneybohnen" }));
    await userEvent.click(within(screen.getByRole("region", { name: "Bestand im Detail: Kidneybohnen" })).getByRole("button", { name: "Weitere einlagern" }));
    const dialog = screen.getByRole("dialog", { name: "Von Hand einlagern" });
    const submit = within(dialog).getByRole("button", { name: "Einlagern" });
    await userEvent.click(submit);

    // Es läuft: Die Schaltfläche behält den Fokus, weiteres Drücken löst nichts aus.
    expect(submit).toHaveFocus();
    expect(submit).toHaveAttribute("aria-busy", "true");
    expect(submit).toBeUnavailable();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    await userEvent.click(submit);
    expect(spy).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
    });
    const done = await screen.findByRole("dialog", { name: "Eingelagert" });
    expect(packagesOf(core, "Kidneybohnen")).toHaveLength(before + 1);
    // Der Fokus geht an den Dialog, nicht an „Fertig“: Ein schnelles weiteres Enter schließt das Ergebnis nicht.
    expect(within(done).getByRole("button", { name: "Fertig" })).not.toHaveFocus();
    expect(done).toContainElement(document.activeElement as HTMLElement);
  });

  it("öffnet aus der Chargen-Ansicht mit dem Produkt vorgewählt", async () => {
    const core = renderApp();
    await ready();
    const before = packagesOf(core, "Kidneybohnen").length;
    await userEvent.click(screen.getByRole("button", { name: "Details: Kidneybohnen" }));
    await userEvent.click(within(screen.getByRole("region", { name: "Bestand im Detail: Kidneybohnen" })).getByRole("button", { name: "Weitere einlagern" }));
    const dialog = screen.getByRole("dialog", { name: "Von Hand einlagern" });
    expect(dialog).toHaveTextContent("Kidneybohnen");
    // die Zone, in der das Produkt schon liegt
    expect(within(dialog).getByLabelText("Zone")).toHaveDisplayValue("Keller");
    await userEvent.click(within(dialog).getByRole("button", { name: "Einlagern" }));
    await screen.findByRole("dialog", { name: "Eingelagert" });
    expect(packagesOf(core, "Kidneybohnen")).toHaveLength(before + 1);
  });
});

describe("Bestand am Handy", () => {
  it("zeigt jedes Produkt als Karte mit drei beschrifteten Werten und den Aktionen", async () => {
    setTestViewport(375);
    renderApp();
    await ready();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText("Aktive Zonen").nextElementSibling).toHaveTextContent("4");

    const card = screen.getByRole("heading", { name: "Basmati Reis" }).closest("li");
    if (!card) {
      throw new Error("Karte fehlt");
    }
    const terms = within(card).getAllByRole("term").map((term) => term.textContent);
    expect(terms).toEqual(["Zone", "Menge", "Kritischstes MHD"]);
    const values = within(card).getAllByRole("definition");
    expect(values[0]).toHaveTextContent("Vorratsregal");
    expect(values[1]).toHaveTextContent("4");
    expect(values[2]).toHaveTextContent(formatDate(addDays(todayLocal(), 132)));
    expect(within(card).getByRole("button", { name: "Bearbeiten: Basmati Reis" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Löschen: Basmati Reis" })).toBeInTheDocument();

    await userEvent.click(within(card).getByRole("button", { name: "Details: Basmati Reis" }));
    const panel = within(card).getByRole("region", { name: "Bestand im Detail: Basmati Reis" });
    expect(within(panel).getAllByRole("button", { name: /^Entnehmen: / })).toHaveLength(3);
  });

  it("lässt die Zone weg, wenn es nur eine gibt", async () => {
    setTestViewport(375);
    renderApp({ scenarios: ["single-zone"] });
    await ready();
    const card = screen.getByRole("heading", { name: "Basmati Reis" }).closest("li");
    expect(card ? within(card).getAllByRole("term").map((term) => term.textContent) : []).toEqual(["Menge", "Kritischstes MHD"]);
    expect(screen.queryByText("Aktive Zonen")).not.toBeInTheDocument();
  });
});

describe("Änderungen des Kerns", () => {
  it("erscheinen ohne Zutun in der Liste", async () => {
    const core: MockCore = renderApp();
    await ready();
    const beans = packagesOf(core, "Kidneybohnen").map((pkg) => pkg.id);
    await core.stock.remove(beans, "consumed");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Details: Kidneybohnen" })).not.toBeInTheDocument());

    await core.products.update(productId(core, "Apfelmus"), { name: "Apfelmark" });
    expect(await screen.findByRole("button", { name: "Details: Apfelmark" })).toBeInTheDocument();
  });
});

describe("Suchen am Handy", () => {
  it("zeigt gleich die Treffer: Kennzahlen und Zonen-Karten treten zurück, solange gesucht wird", async () => {
    setTestViewport(375);
    renderApp();
    await ready();
    expect(screen.getByText("Packungen gesamt")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Nach Zone filtern" })).toBeInTheDocument();

    await userEvent.type(screen.getByRole("searchbox", { name: "Bestand durchsuchen" }), "reis");
    await waitFor(() => expect(screen.queryByText("Packungen gesamt")).not.toBeInTheDocument());
    expect(screen.queryByRole("group", { name: "Nach Zone filtern" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Basmati Reis" })).toBeInTheDocument();
    expect(screen.getByText("1 Produkt · 4 Packungen")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Suche leeren" }));
    expect(await screen.findByText("Packungen gesamt")).toBeInTheDocument();
  });
});

describe("Auf- und Zuklappen", () => {
  it("behält, was der Anwender selbst aufgeklappt hat, auch wenn eine Suche dazukommt", async () => {
    renderApp();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Details: Butter" }));
    expect(screen.getByRole("region", { name: "Bestand im Detail: Butter" })).toBeInTheDocument();

    // Die Suche führt zu genau diesem Produkt: Es bleibt offen, statt umzuschlagen.
    await userEvent.type(screen.getByRole("searchbox", { name: "Bestand durchsuchen" }), "butter");
    await waitFor(() => expect(listedProducts()).toEqual(["Butter"]));
    expect(screen.getByRole("region", { name: "Bestand im Detail: Butter" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Details: Butter" }));
    expect(screen.queryByRole("region", { name: "Bestand im Detail: Butter" })).not.toBeInTheDocument();
  });
});

describe("Produktbilder", () => {
  it("erscheinen erst, wenn überhaupt ein Produkt ein Bild hat", async () => {
    // Die Beispieldaten haben ein Produkt mit Bild; hier keines.
    renderApp({ data: { products: createSampleData().products.map((product) => ({ ...product, image: null })) } });
    await ready();
    expect(screen.getByRole("table", { name: "Bestand" }).querySelector("img")).toBeNull();
  });

  it("kommen über den Kern und weichen einem Symbol, wenn sie sich nicht laden lassen", async () => {
    const data = createSampleData();
    const products = data.products.map((product) => (product.name === "Basmati Reis" ? { ...product, image: "abc123.jpg" } : product));
    const core = renderApp({ data: { products } });
    await ready();

    const row = screen.getByRole("button", { name: "Details: Basmati Reis" }).closest<HTMLElement>('[role="row"]');
    const image = row?.querySelector("img");
    expect(image).toHaveAttribute("src", core.data.imageUrl("abc123.jpg"));
    // Dann hat jede Zeile ein Feld, damit die Namen untereinander stehen.
    const other = screen.getByRole("button", { name: "Details: Butter" }).closest<HTMLElement>('[role="row"]');
    expect(other?.querySelector("svg.lucide-package")).not.toBeNull();

    image?.dispatchEvent(new Event("error"));
    await waitFor(() => expect(row?.querySelector("img")).toBeNull());
  });
});

describe("Etiketten im Bestand", () => {
  async function openBatches(): Promise<HTMLElement> {
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Details: Basmati Reis" }));
    return screen.getByRole("region", { name: "Bestand im Detail: Basmati Reis" });
  }

  it("druckt aus der Chargen-Ansicht nach: mit Vorschau, für die gewählten Packungen", async () => {
    const core = renderApp();
    const request = vi.spyOn(core.print, "requestPackageLabels");
    const panel = await openBatches();
    const rice = packagesOf(core, "Basmati Reis");
    const pair = rice.filter((pkg) => pkg.best_before === rice[0]?.best_before).map((pkg) => pkg.id).sort();
    expect(pair).toHaveLength(2);

    await userEvent.click(within(panel).getAllByRole("button", { name: /^Etikett drucken: / })[0] as HTMLElement);
    const dialog = screen.getByRole("dialog", { name: "Etiketten drucken" });
    // Die Vorschau zeigt das Etikett der ersten Packung, auf weißem Grund.
    const image = await within(dialog).findByRole("img", { name: `Vorschau des Etiketts für die Packung ${pair[0] ?? ""}` });
    expect(image).toHaveAttribute("src", expect.stringMatching(/^blob:/));
    expect(image.closest("figure")).toHaveClass("frame");

    // Bei mehreren Packungen ist nichts vorgewählt: Welche es ist, steht auf ihrem alten Etikett.
    await userEvent.click(within(dialog).getByRole("button", { name: "Etikett drucken" }));
    expect(within(dialog).getByText("Bitte mindestens eine Packung auswählen.")).toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Alle 2 Packungen" }));
    expect(dialog).toHaveTextContent("Druckt auf „Keller (Pi)“. Ein Nachdruck ist ein neues Etikett; das alte bleibt gültig.");
    await userEvent.click(within(dialog).getByRole("button", { name: "2 Etiketten drucken" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith(pair));

    // Danach sagt der Dialog, was mit den Etiketten ist, und bleibt auf dem Laufenden.
    const done = await screen.findByRole("dialog", { name: "Etiketten angefordert" });
    expect(within(done).getByRole("status")).toHaveTextContent("2 Etiketten stehen aus und werden gedruckt, sobald dieses Gerät den Drucker „Keller (Pi)“ erreicht.");
    core.control.setPiReachable(true);
    await waitFor(() => expect(within(done).getByRole("status")).toHaveTextContent("2 Etiketten sind am Drucker „Keller (Pi)“ gedruckt."));
    await userEvent.click(within(done).getByRole("button", { name: "Fertig" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("wählt eine einzelne Packung vor", async () => {
    const core = renderApp();
    const request = vi.spyOn(core.print, "requestPackageLabels");
    const panel = await openBatches();
    const buttons = within(panel).getAllByRole("button", { name: /^Etikett drucken: / });
    await userEvent.click(buttons[buttons.length - 1] as HTMLElement);
    const dialog = screen.getByRole("dialog", { name: "Etikett drucken" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Etikett drucken" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0]?.[0]).toHaveLength(1);
    expect(await screen.findByRole("dialog", { name: "Etikett angefordert" })).toBeInTheDocument();
  });

  it("sagt offline, dass die Vorschau den Server braucht, und druckt trotzdem", async () => {
    const core = renderApp({ scenarios: ["offline", "at-pi"] });
    const panel = await openBatches();
    await userEvent.click(within(panel).getAllByRole("button", { name: /^Etikett drucken: / })[0] as HTMLElement);
    const dialog = screen.getByRole("dialog", { name: "Etiketten drucken" });
    expect(await within(dialog).findByText("Die Vorschau zeichnet der Server, und der ist gerade nicht erreichbar.")).toBeInTheDocument();
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();

    // Im Keller: Der Server fehlt, der Pi ist da. Gedruckt wird trotzdem.
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Alle 2 Packungen" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "2 Etiketten drucken" }));
    const done = await screen.findByRole("dialog", { name: "Etiketten angefordert" });
    await waitFor(() => expect(within(done).getByRole("status")).toHaveTextContent("2 Etiketten sind am Drucker „Keller (Pi)“ gedruckt."));
    expect(value(core.sync.status).online).toBe(false);
  });

  it("druckt im Packungs-Dialog für die gewählten Packungen nach", async () => {
    const core = renderApp();
    const request = vi.spyOn(core.print, "requestPackageLabels");
    const panel = await openBatches();
    await userEvent.click(within(panel).getAllByRole("button", { name: /^Bearbeiten: / })[0] as HTMLElement);
    const dialog = screen.getByRole("dialog", { name: "Packungen bearbeiten" });
    expect(dialog).toHaveTextContent("Gedruckt wird der gespeicherte Stand.");
    // Eine der beiden Packungen abwählen: Gedruckt wird nur die andere.
    const boxes = within(dialog).getAllByRole("checkbox");
    await userEvent.click(boxes[1] as HTMLElement);
    await userEvent.click(within(dialog).getByRole("button", { name: "Etikett drucken" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0]?.[0]).toHaveLength(1);
    expect(await within(dialog).findByRole("status")).toHaveTextContent(/1 Etikett steht aus/);
    // Der Dialog bleibt offen: Bearbeiten geht weiter.
    expect(within(dialog).getByRole("button", { name: "Speichern" })).toBeInTheDocument();
  });

  it("bietet ohne Drucker keinen Nachdruck an", async () => {
    const data = createSampleData();
    renderApp({ data: { printers: [], printJobs: [], settings: { ...data.settings, default_printer_id: null } } });
    const panel = await openBatches();
    expect(within(panel).queryByRole("button", { name: /^Etikett drucken: / })).not.toBeInTheDocument();
    await userEvent.click(within(panel).getAllByRole("button", { name: /^Bearbeiten: / })[0] as HTMLElement);
    expect(within(screen.getByRole("dialog", { name: "Packungen bearbeiten" })).queryByRole("button", { name: /Etikett/ })).not.toBeInTheDocument();
  });
});

describe("Etiketten beim Einlagern von Hand", () => {
  async function storeRice(dialog: HTMLElement): Promise<void> {
    await userEvent.click(within(dialog).getByRole("button", { name: /Basmati Reis/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Einlagern" }));
  }

  it("zeigt den Schalter nur mit Drucker; er folgt der Einstellung des Geräts", async () => {
    const core = renderApp();
    const store = vi.spyOn(core.stock, "store");
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Von Hand einlagern" }));
    const dialog = screen.getByRole("dialog", { name: "Von Hand einlagern" });
    const labels = within(dialog).getByRole("switch", { name: /Etiketten/ });
    expect(labels).toBeChecked();

    // Ausschalten gilt für dieses Gerät, auch beim Scannen.
    await userEvent.click(labels);
    await waitFor(() => expect(value(core.prefs.value).print_labels).toBe(false));
    expect(within(dialog).getByRole("switch", { name: /Etiketten/ })).not.toBeChecked();
    await storeRice(dialog);
    const done = await screen.findByRole("dialog", { name: "Eingelagert" });
    expect(store.mock.calls[0]?.[0]).toMatchObject({ labels: false });
    expect(done).toHaveTextContent("Etiketten sind auf diesem Gerät ausgeschaltet.");
    expect(within(done).queryByRole("status")).not.toBeInTheDocument();
  });

  it("sagt nach dem Einlagern, was mit den Etiketten ist", async () => {
    const core = renderApp();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Von Hand einlagern" }));
    await storeRice(screen.getByRole("dialog", { name: "Von Hand einlagern" }));
    const done = await screen.findByRole("dialog", { name: "Eingelagert" });
    // Eingelagert wird in die Primärzone (Vorratsregal): Dort druckt der Standarddrucker am Server sofort.
    await waitFor(() => expect(within(done).getByRole("status")).toHaveTextContent("1 Etikett ist am Drucker „Küche (Bild)“ gedruckt."));
    expect(done).toHaveTextContent("Bis das Etikett klebt, hilft die ID von Hand auf der Packung.");
    expect(value(core.data.printJobs).filter((job) => job.state === "printed" && job.device_id !== null).length).toBeGreaterThan(0);
  });

  it("meldet ausstehende Etiketten, wenn der Drucker nicht erreichbar ist", async () => {
    renderApp({ scenarios: ["offline"] });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Von Hand einlagern" }));
    await storeRice(screen.getByRole("dialog", { name: "Von Hand einlagern" }));
    const done = await screen.findByRole("dialog", { name: "Eingelagert" });
    expect(within(done).getByRole("status")).toHaveTextContent("1 Etikett steht aus und wird gedruckt, sobald dieses Gerät den Drucker „Küche (Bild)“ erreicht.");
  });

  it("kennt ohne Drucker weder Schalter noch Etiketten", async () => {
    const core = renderApp({ scenarios: ["empty"] });
    const store = vi.spyOn(core.stock, "store");
    await ready();
    await userEvent.click(screen.getAllByRole("button", { name: "Von Hand einlagern" })[0] as HTMLElement);
    const dialog = screen.getByRole("dialog", { name: "Von Hand einlagern" });
    expect(within(dialog).queryByRole("switch", { name: /Etiketten/ })).not.toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("Name"), "Probierglas");
    await userEvent.click(within(dialog).getByRole("button", { name: "Einlagern" }));
    const done = await screen.findByRole("dialog", { name: "Eingelagert" });
    expect(store.mock.calls[0]?.[0]).toMatchObject({ labels: false });
    expect(done).toHaveTextContent("Ohne Drucker gibt es keine Etiketten.");
  });

  it("zeigt bei einem zu langen Produktnamen den genauen Satz des Kerns", async () => {
    renderApp();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Von Hand einlagern" }));
    const dialog = screen.getByRole("dialog", { name: "Von Hand einlagern" });
    await userEvent.click(within(dialog).getByRole("radio", { name: "Neues Produkt" }));
    await userEvent.type(within(dialog).getByLabelText("Name"), "p".repeat(121));
    await userEvent.click(within(dialog).getByRole("button", { name: "Einlagern" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Der Name ist zu lang (höchstens 120 Zeichen).");
  });
});

/** Die Zeile eines Produkts in der Tabelle. */
function rowOf(name: string): HTMLElement {
  const row = screen.getByRole("button", { name: `Details: ${name}` }).closest<HTMLElement>('[role="row"]');
  if (!row) {
    throw new Error(`Zeile ${name} fehlt`);
  }
  return row;
}

describe("Mindestbestand in der Bestandsliste", () => {
  // Beispieldaten: H-Milch hat 6 von mindestens 8, Butter 2 von 3; Spaghetti und Tomaten reichen.
  it("markiert Produkte unter dem Mindestbestand mit „fehlt n“", async () => {
    renderApp();
    await ready();
    expect(within(rowOf("H-Milch 3,5 %")).getAllByRole("cell")[0]).toHaveTextContent("Unter dem Mindestbestand, fehlt 2");
    expect(within(rowOf("Butter")).getAllByRole("cell")[0]).toHaveTextContent("fehlt 1");
    expect(within(rowOf("Spaghetti")).getAllByRole("cell")[0]).not.toHaveTextContent("fehlt");
    expect(within(rowOf("Basmati Reis")).getAllByRole("cell")[0]).not.toHaveTextContent("fehlt");
  });

  it("zählt sofort selbst, auch offline, und abgelaufene Packungen zählen mit", async () => {
    const core = renderApp({ scenarios: ["offline"] });
    await ready();
    // Spaghetti: 5 im Bestand, mindestens 3. Drei entnehmen: Es fehlt eine.
    const spaghetti = packagesOf(core, "Spaghetti").map((pkg) => pkg.id);
    await core.stock.remove(spaghetti.slice(0, 3), "consumed");
    await waitFor(() => expect(within(rowOf("Spaghetti")).getAllByRole("cell")[0]).toHaveTextContent("fehlt 1"));
    expect(value(core.sync.status).online).toBe(false);

    // Passierte Tomaten: 6 im Bestand, mindestens 4; die zwei mit MHD in 9 Tagen laufen ab. Abgelaufen zählt mit.
    const tomatoes = packagesOf(core, "Passierte Tomaten");
    const expired = addDays(todayLocal(), -1);
    await core.stock.update(
      tomatoes.slice(0, 3).map((pkg) => pkg.id),
      { best_before: expired },
    );
    await waitFor(() => expect(within(rowOf("Passierte Tomaten")).getAllByRole("cell")[2]).toHaveTextContent("abgelaufen"));
    expect(within(rowOf("Passierte Tomaten")).getAllByRole("cell")[0]).not.toHaveTextContent("fehlt");
  });

  it("zeigt ein Produkt ohne Packung weiter, mit Menge 0, und bietet Einlagern an", async () => {
    const core = renderApp();
    await ready();
    const milk = packagesOf(core, "H-Milch 3,5 %").map((pkg) => pkg.id);
    await core.stock.remove(milk, "consumed");
    await waitFor(() => expect(within(rowOf("H-Milch 3,5 %")).getAllByRole("cell")[0]).toHaveTextContent("fehlt 8"));
    const cells = within(rowOf("H-Milch 3,5 %")).getAllByRole("cell");
    expect(cells[1]).toHaveTextContent("nirgends");
    expect(cells[2]).toHaveTextContent("kein MHD");
    expect(cells[3]).toHaveTextContent("0");
    // Nichts zu entnehmen
    expect(screen.getByRole("button", { name: "Löschen: H-Milch 3,5 %" })).toBeUnavailable();

    await userEvent.click(screen.getByRole("button", { name: "Details: H-Milch 3,5 %" }));
    const panel = screen.getByRole("region", { name: "Bestand im Detail: H-Milch 3,5 %" });
    expect(panel).toHaveTextContent("Mindestbestand 8 Packungen, im Bestand 0, es fehlen 8 Packungen.");
    expect(panel).toHaveTextContent("Nichts im Bestand.");
    expect(within(panel).queryByRole("table")).not.toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "Einlagern" }));
    expect(within(screen.getByRole("dialog", { name: "Von Hand einlagern" })).getByText("H-Milch 3,5 %")).toBeInTheDocument();
  });

  it("filtert mit dem Umschalter „Unter Mindestbestand“, auch auf Produkte ohne Packung", async () => {
    const core = renderApp();
    await ready();
    // Ein Umschalter über der Liste; die Reihe der Zonen-Karten bleibt wie im Entwurf.
    expect(within(screen.getByRole("group", { name: "Nach Zone filtern" })).queryByRole("button", { name: /Mindestbestand/ })).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: /Unter Mindestbestand/ });
    // H-Milch und Butter
    expect(toggle).toHaveTextContent("2");
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(listedProducts()).toEqual(["Butter", "H-Milch 3,5 %"]);
    expect(screen.getByText("2 Produkte · 8 Packungen")).toBeInTheDocument();

    await core.stock.remove(
      packagesOf(core, "Butter").map((pkg) => pkg.id),
      "consumed",
    );
    await waitFor(() => expect(within(rowOf("Butter")).getAllByRole("cell")[3]).toHaveTextContent("0"));
    expect(listedProducts()).toEqual(["Butter", "H-Milch 3,5 %"]);

    // Zusammen mit einer Zone: nur, was dort liegt.
    await userEvent.click(within(screen.getByRole("group", { name: "Nach Zone filtern" })).getByRole("button", { name: /Vorratsregal/ }));
    expect(listedProducts()).toEqual(["H-Milch 3,5 %"]);

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(listedProducts()).toContain("Basmati Reis");
  });

  it("kennt den Umschalter auch mit nur einer Zone", async () => {
    renderApp({ scenarios: ["single-zone"] });
    await ready();
    const toggle = screen.getByRole("button", { name: /Unter Mindestbestand/ });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(listedProducts()).toEqual(["Butter", "H-Milch 3,5 %"]);
  });

  it("zeigt den Filter nicht, solange kein Produkt unter seinem Mindestbestand liegt", async () => {
    renderApp({ data: { products: createSampleData().products.map((product) => ({ ...product, min_stock: product.min_stock === null ? null : 1 })) } });
    await ready();
    expect(screen.queryByRole("button", { name: /Unter Mindestbestand/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/fehlt/)).not.toBeInTheDocument();
  });

  it("markiert auch am Handy, mit Menge 0 für Produkte ohne Packung", async () => {
    setTestViewport(375);
    const core = renderApp();
    await ready();
    await core.stock.remove(
      packagesOf(core, "Butter").map((pkg) => pkg.id),
      "consumed",
    );
    const card = (await screen.findByRole("heading", { name: "Butter" })).closest("li");
    if (!card) {
      throw new Error("Karte fehlt");
    }
    await waitFor(() => expect(card).toHaveTextContent("fehlt 3"));
    expect(within(card).getAllByRole("definition")[1]).toHaveTextContent("0");
  });
});

describe("Mindestbestand im Produkt-Dialog", () => {
  async function openDialog(name: string): Promise<HTMLElement> {
    await ready();
    await userEvent.click(screen.getByRole("button", { name: `Bearbeiten: ${name}` }));
    return screen.getByRole("dialog", { name: "Produkt bearbeiten" });
  }

  it("setzt den Mindestbestand und erklärt, was er bewirkt", async () => {
    const core = renderApp();
    const dialog = await openDialog("Basmati Reis");
    const field = within(dialog).getByLabelText("Mindestbestand");
    expect(field).toHaveValue("");
    expect(field).toHaveAccessibleDescription(/Leer = keiner\. Liegen weniger Packungen im Bestand \(abgelaufene zählen mit\), setzt der Server das Produkt auf die Einkaufsliste\./);
    expect(field).toHaveAccessibleDescription(/Im Bestand: 4 Packungen\./);
    expect(field).toHaveAccessibleDescription(/Wer „3 Milch, egal welche Marke“ will, führt die Produkte zusammen; ein Produkt kann mehrere Barcodes haben\./);

    await userEvent.type(field, "6");
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(value(core.data.products).find((product) => product.name === "Basmati Reis")?.min_stock).toBe(6);
    // Sofort markiert, ohne auf den Server zu warten
    expect(within(rowOf("Basmati Reis")).getAllByRole("cell")[0]).toHaveTextContent("fehlt 2");
  });

  it("entfernt den Mindestbestand, wenn das Feld geleert wird", async () => {
    const core = renderApp();
    const update = vi.spyOn(core.products, "update");
    const dialog = await openDialog("Butter");
    const field = within(dialog).getByLabelText("Mindestbestand");
    expect(field).toHaveValue("3");
    await userEvent.clear(field);
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(update).toHaveBeenCalledWith(productId(core, "Butter"), { min_stock: null });
    expect(value(core.data.products).find((product) => product.name === "Butter")?.min_stock).toBeNull();
    expect(within(rowOf("Butter")).getAllByRole("cell")[0]).not.toHaveTextContent("fehlt");
  });

  it("prüft die Eingabe nach den Grenzen des Vertrags", async () => {
    const core = renderApp();
    const dialog = await openDialog("Butter");
    const field = within(dialog).getByLabelText("Mindestbestand");
    await userEvent.clear(field);
    await userEvent.type(field, "0");
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(field).toBeInvalid();
    expect(within(dialog).getByText("Der Mindestbestand muss zwischen 1 und 999 Packungen liegen.")).toBeInTheDocument();

    await userEvent.clear(field);
    await userEvent.type(field, "zwei");
    expect(within(dialog).getByText("Bitte eine ganze Zahl von 1 bis 999 eingeben oder das Feld leer lassen.")).toBeInTheDocument();
    expect(value(core.data.products).find((product) => product.name === "Butter")?.min_stock).toBe(3);
  });

  it("legt beim Einlagern von Hand ein neues Produkt mit Mindestbestand an", async () => {
    const core = renderApp();
    const store = vi.spyOn(core.stock, "store");
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Von Hand einlagern" }));
    const dialog = screen.getByRole("dialog", { name: "Von Hand einlagern" });
    await userEvent.click(within(dialog).getByRole("radio", { name: "Neues Produkt" }));
    await userEvent.type(within(dialog).getByLabelText("Name"), "Kichererbsen");
    const field = within(dialog).getByLabelText("Mindestbestand (freiwillig)");
    await userEvent.type(field, "abc");
    await userEvent.click(within(dialog).getByRole("button", { name: "Einlagern" }));
    expect(field).toBeInvalid();
    expect(store).not.toHaveBeenCalled();

    await userEvent.clear(field);
    await userEvent.type(field, "2");
    await userEvent.click(within(dialog).getByRole("button", { name: "Einlagern" }));
    await screen.findByRole("dialog", { name: "Eingelagert" });
    expect(store.mock.calls[0]?.[0].product).toMatchObject({ kind: "new", name: "Kichererbsen", min_stock: 2 });
    expect(value(core.data.products).find((product) => product.name === "Kichererbsen")?.min_stock).toBe(2);
  });
});

describe("Auf die Einkaufsliste", () => {
  async function openPanel(name: string): Promise<HTMLElement> {
    await ready();
    await userEvent.click(screen.getByRole("button", { name: `Details: ${name}` }));
    return screen.getByRole("region", { name: `Bestand im Detail: ${name}` });
  }

  it("setzt ein Produkt auf die Liste und sagt danach, dass es dort steht", async () => {
    const core = renderApp();
    const panel = await openPanel("Basmati Reis");
    await userEvent.click(within(panel).getByRole("button", { name: "Auf die Einkaufsliste: Basmati Reis" }));
    const link = await within(panel).findByRole("link", { name: "Steht auf der Einkaufsliste: Basmati Reis" });
    expect(link).toHaveAttribute("href", "/einkaufsliste");
    // Der Fokus bleibt an der Stelle des Knopfs.
    expect(link).toHaveFocus();
    const item = value(core.data.shoppingItems).find((candidate) => candidate.product_id === productId(core, "Basmati Reis"));
    expect(item).toMatchObject({ origin: "manual", quantity: null, done_at: null });
    expect(screen.getByText("„Basmati Reis“ steht jetzt auf der Einkaufsliste.")).toBeInTheDocument();

    // Rückgängig löscht den eben angelegten Eintrag.
    await userEvent.click(screen.getByRole("button", { name: "Rückgängig" }));
    expect(await within(panel).findByRole("button", { name: "Auf die Einkaufsliste: Basmati Reis" })).toBeInTheDocument();
    expect(value(core.data.shoppingItems).some((candidate) => candidate.id === item?.id)).toBe(false);
  });

  it("legt keinen zweiten Eintrag an, wenn das Produkt schon offen auf der Liste steht", async () => {
    const core = renderApp();
    const create = vi.spyOn(core.shopping, "create");
    // H-Milch steht automatisch auf der Liste, Olivenöl als eigener Eintrag.
    for (const name of ["H-Milch 3,5 %", "Olivenöl"]) {
      const panel = await openPanel(name);
      expect(within(panel).getByRole("link", { name: `Steht auf der Einkaufsliste: ${name}` })).toBeInTheDocument();
      expect(within(panel).queryByRole("button", { name: /^Auf die Einkaufsliste/ })).not.toBeInTheDocument();
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("bietet es nach dem Entnehmen der letzten Packung an", async () => {
    const core = renderApp();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Löschen: Weizenmehl Type 405" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Packungen entnehmen" })).getByRole("button", { name: "Entnehmen" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    expect(screen.getByText("„Weizenmehl Type 405“ ist nicht mehr im Bestand.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Auf die Einkaufsliste" }));
    await waitFor(() => expect(value(core.data.shoppingItems).some((item) => item.product_id === productId(core, "Weizenmehl Type 405"))).toBe(true));
    expect(await screen.findByText("„Weizenmehl Type 405“ steht jetzt auf der Einkaufsliste.")).toBeInTheDocument();
  });

  it("sagt nach dem Entnehmen der letzten Packung, wenn es schon auf der Liste steht", async () => {
    const core = renderApp();
    const create = vi.spyOn(core.shopping, "create");
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Löschen: Olivenöl" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Packungen entnehmen" })).getByRole("button", { name: "Entnehmen" }));
    expect(await screen.findByText("„Olivenöl“ ist nicht mehr im Bestand und steht schon auf der Einkaufsliste.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Auf die Einkaufsliste" })).not.toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it("bietet nichts an, solange Packungen bleiben, beim Löschen eines Irrtums oder bei Mindestbestand", async () => {
    const core = renderApp();
    await ready();
    // Basmati Reis: eine von vier Packungen
    const [rice] = packagesOf(core, "Basmati Reis");
    await userEvent.click(screen.getByRole("button", { name: "Details: Basmati Reis" }));
    const panel = screen.getByRole("region", { name: "Bestand im Detail: Basmati Reis" });
    await userEvent.click(within(panel).getAllByRole("button", { name: /^Entnehmen: / })[0] as HTMLElement);
    const dialog = screen.getByRole("dialog", { name: "Packungen entnehmen" });
    await userEvent.click(within(dialog).getByRole("checkbox", { name: new RegExp(rice?.id ?? "") }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Entnehmen" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByText(/ist nicht mehr im Bestand/)).not.toBeInTheDocument();

    // Weizenmehl als „Falsch erfasst": Es war nie da, also fehlt auch nichts.
    await userEvent.click(screen.getByRole("button", { name: "Löschen: Weizenmehl Type 405" }));
    const wrong = screen.getByRole("dialog", { name: "Packungen entnehmen" });
    await userEvent.click(within(wrong).getByRole("radio", { name: "Falsch erfasst" }));
    await userEvent.click(within(wrong).getByRole("button", { name: "Löschen" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByText(/ist nicht mehr im Bestand/)).not.toBeInTheDocument();

    // Butter hat einen Mindestbestand: Den Eintrag legt der Server an, die Zeile bleibt mit „fehlt 3".
    await userEvent.click(screen.getByRole("button", { name: "Löschen: Butter" }));
    const butter = screen.getByRole("dialog", { name: "Packungen entnehmen" });
    await userEvent.click(within(butter).getByRole("checkbox", { name: "Alle 2 Packungen" }));
    await userEvent.click(within(butter).getByRole("button", { name: "2 entnehmen" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByText(/ist nicht mehr im Bestand/)).not.toBeInTheDocument();
    expect(within(rowOf("Butter")).getAllByRole("cell")[0]).toHaveTextContent("fehlt 3");
  });
});

describe("Nächste Charge", () => {
  it("markiert in der Chargen-Ansicht, was als Nächstes dran ist", async () => {
    renderApp();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Details: Basmati Reis" }));
    const panel = screen.getByRole("region", { name: "Bestand im Detail: Basmati Reis" });
    const rows = within(panel).getAllByRole("row").slice(1);
    // Die beiden Packungen im Keller mit dem frühesten MHD, die zuerst eingelagert wurden
    expect(rows.map((row) => within(row).queryByText("als Nächstes") !== null)).toEqual([true, false, false]);
    expect(rows[0]).toHaveTextContent("als Nächstes verbrauchen");
  });

  it("markiert nichts, wenn es nur eine Charge gibt", async () => {
    renderApp();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Details: Kidneybohnen" }));
    expect(within(screen.getByRole("region", { name: "Bestand im Detail: Kidneybohnen" })).queryByText("als Nächstes")).not.toBeInTheDocument();
  });

  it("markiert auch am Handy", async () => {
    setTestViewport(375);
    renderApp();
    await ready();
    const card = screen.getByRole("heading", { name: "Lachsfilet (TK)" }).closest("li");
    if (!card) {
      throw new Error("Karte fehlt");
    }
    await userEvent.click(within(card).getByRole("button", { name: "Details: Lachsfilet (TK)" }));
    const items = within(within(card).getByRole("region", { name: "Bestand im Detail: Lachsfilet (TK)" })).getAllByRole("listitem").filter((item) => item.querySelector("ul"));
    expect(items.map((item) => item.textContent?.includes("als Nächstes"))).toEqual([true, false]);
  });
});

describe("Kennzahl Einkaufsliste", () => {
  it("führt mit der Zahl der offenen Einträge zur Einkaufsliste", async () => {
    renderApp();
    await ready();
    // Beispieldaten: H-Milch (automatisch), Olivenöl, Backpapier, Kaffeebohnen
    const card = within(screen.getByRole("main")).getByRole("link", { name: /Einkaufsliste/ });
    expect(card).toHaveTextContent("4 offen");
    await userEvent.click(card);
    expect(await screen.findByRole("heading", { name: "Einkaufsliste", level: 1 })).toBeInTheDocument();
  });

  it("steht am Handy im Raster der Kennzahlen", async () => {
    setTestViewport(375);
    renderApp();
    await ready();
    expect(screen.getByText("Einkaufsliste").nextElementSibling).toHaveTextContent("4 offen");
    expect(screen.getByText("Aktive Zonen")).toBeInTheDocument();
  });
});
