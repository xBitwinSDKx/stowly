/**
 * Bestand auf der Attrappe: Liste, Chargen-Ansicht, Filter und die Dialoge
 * (Produkt bearbeiten, Packungen bearbeiten, entnehmen, von Hand einlagern).
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

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
    renderApp({ data: { packages: [{ ...first, product_id: sampleUuid(2, 999), zone_id: sampleUuid(1, 999) }] } });
    await ready();

    expect(listedProducts()).toEqual(["Unbekanntes Produkt"]);
    const row = screen.getByRole("button", { name: "Details: Unbekanntes Produkt" }).closest<HTMLElement>('[role="row"]');
    expect(row).toHaveTextContent("Unbekannte Zone");
    expect(screen.getByRole("button", { name: "Bearbeiten: Unbekanntes Produkt" })).toBeDisabled();

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
    expect(dialog).toHaveTextContent("Open Food Facts kennt diesen Barcode nicht.");
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
    const butter = packagesOf(core, "Butter").map((pkg) => pkg.id);
    expect(butter).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: "Löschen: Butter" }));
    const dialog = screen.getByRole("dialog", { name: "Packungen entnehmen" });
    // Bei mehreren Packungen ist nichts vorgewählt: Welche es ist, steht auf dem Etikett.
    expect(within(dialog).getByRole("button", { name: "Auswahl fehlt" })).toBeDisabled();

    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Alle 2 Packungen" }));
    await userEvent.click(within(dialog).getByRole("radio", { name: "Entsorgt" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "2 entnehmen" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Details: Butter" })).not.toBeInTheDocument();
    const removed = value(core.data.removedPackages).filter((pkg) => butter.includes(pkg.id));
    expect(removed.map((pkg) => pkg.removal_reason)).toEqual(["discarded", "discarded"]);

    expect(screen.getByText("2 Packungen entsorgt")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Rückgängig" }));
    expect(await screen.findByRole("button", { name: "Details: Butter" })).toBeInTheDocument();
    expect(packagesOf(core, "Butter").map((pkg) => pkg.id).sort()).toEqual([...butter].sort());
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
    const milk = packagesOf(core, "H-Milch 3,5 %").map((pkg) => pkg.id);
    await core.stock.remove(milk, "consumed");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Details: H-Milch 3,5 %" })).not.toBeInTheDocument());

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
    renderApp();
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
