/**
 * Die Scan-Abläufe auf der Attrappe, bedient über die Eingabe von Hand: einlagern,
 * entnehmen und rückgängig, Zonenwechsel, FIFO-Hinweis und „Auf die Einkaufsliste". Eine Kamera
 * gibt es unter jsdom nicht; die Ansicht muss genau dann die Eingabe von Hand anbieten.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { compareFifo, CoreProvider, formatDate, gtinCheckDigit, isOpenItem, nextPackage, ROUTES, zoneQr, type Live, type Product } from "@/contract";
import { createMockCore, sampleBarcode, ZONE_IDS, type MockCore, type MockOptions } from "@/mock";
import { ToastProvider } from "@/ui/base";
// Die Prüfungen toBeUnavailable() und toBeAvailable() für Schaltflächen.
import "@/ui/base/testing";

import { ScanPage } from "./ScanPage";

const NOW = new Date("2026-11-13T10:00:00.000Z");
/** Barcode des ersten Beispielprodukts („Basmati Reis"). */
const RICE_BARCODE = sampleBarcode(1);

function value<T>(live: Live<T>): T {
  const current = live.get();
  if (current === undefined) {
    throw new Error("Live-Wert ist noch nicht geladen");
  }
  return current;
}

function setup(options: MockOptions = {}) {
  const core: MockCore = createMockCore({ latency: 0, now: () => NOW, ...options });
  const router = createMemoryRouter(
    [
      { path: ROUTES.scan, element: <ScanPage /> },
      { path: ROUTES.stock, element: <p>Hier ist der Bestand.</p> },
    ],
    { initialEntries: [ROUTES.scan] },
  );
  render(
    <CoreProvider core={core}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </CoreProvider>,
  );
  return { core, user: userEvent.setup(), router };
}

/** Gibt einen Code von Hand ein, als hätte der Scanner ihn gesehen. */
async function enter(user: ReturnType<typeof userEvent.setup>, code: string): Promise<void> {
  const field = await screen.findByLabelText("Packungs-ID oder Barcode");
  await user.clear(field);
  await user.type(field, `${code}{Enter}`);
}

/** Der Bereich der Meldungen (Toasts) am unteren Rand. */
function toasts(): HTMLElement {
  const region = screen.getAllByRole("status").find((element) => element.tagName === "DIV" && element.getAttribute("aria-live") === "polite");
  if (!region) {
    throw new Error("Der Bereich der Meldungen fehlt");
  }
  return region;
}

function zoneButton(name: string): HTMLElement {
  return within(screen.getByRole("radiogroup", { name: "Zone" })).getByRole("radio", { name: new RegExp(`^${name}`) });
}

describe("Ohne Kamera", () => {
  it("erklärt, was los ist, und bietet die Eingabe von Hand an", async () => {
    setup();
    expect(await screen.findByRole("heading", { name: "Dieser Browser gibt die Kamera nicht her" })).toBeInTheDocument();
    expect(screen.getByText(/lassen sich auch von Hand eingeben/)).toBeInTheDocument();
    expect(screen.getByLabelText("Packungs-ID oder Barcode")).toBeInTheDocument();
  });

  it("weist eine Eingabe zurück, die weder ID noch Barcode ist", async () => {
    const { user, core } = setup();
    const before = value(core.data.packages).length;
    await enter(user, "4006381333932");
    expect(await screen.findByRole("alert")).toHaveTextContent("Prüfziffer");
    await enter(user, "Reis");
    expect(await screen.findByRole("alert")).toHaveTextContent("weder eine Packungs-ID");
    expect(value(core.data.packages)).toHaveLength(before);
  });

  it("führt deutlich zurück zum Bestand", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: "Zurück zum Bestand" }));
    expect(await screen.findByText("Hier ist der Bestand.")).toBeInTheDocument();
  });
});

describe("Einlagern", () => {
  it("fragt nach einem Produkt-Barcode das MHD ab und lagert die vorgewählte Menge in die Primärzone ein", async () => {
    const { user, core } = setup();
    const before = new Set(value(core.data.packages).map((pkg) => pkg.id));
    await enter(user, RICE_BARCODE);

    const dialog = await screen.findByRole("dialog", { name: "Einlagern" });
    expect(within(dialog).getByText("Basmati Reis")).toBeInTheDocument();
    expect(within(dialog).getByText(/nach Vorratsregal/)).toBeInTheDocument();

    // Schnelle Eingabe: sechs Ziffern; das verstandene Datum erscheint beim Tippen.
    const date = within(dialog).getByLabelText("Mindesthaltbarkeitsdatum");
    const submit = within(dialog).getByRole("button", { name: "Einlagern" });
    expect(submit).toBeUnavailable();
    await user.type(date, "2503");
    expect(within(dialog).getByText(/Verstanden: 25\.03\.2027/)).toBeInTheDocument();
    // Fünf Ziffern sind kein Datum.
    await user.type(date, "2");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Noch kein gültiges Datum");
    expect(submit).toBeUnavailable();
    await user.clear(date);
    await user.type(date, "250327");
    expect(within(dialog).getByText("Verstanden: 25.03.2027")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Eine Packung mehr" }));
    await user.click(within(dialog).getByRole("button", { name: "Eine Packung mehr" }));
    await user.click(submit);

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Einlagern" })).not.toBeInTheDocument());
    const added = value(core.data.packages).filter((pkg) => !before.has(pkg.id));
    expect(added).toHaveLength(3);
    expect(added.every((pkg) => pkg.best_before === "2027-03-25" && pkg.zone_id === ZONE_IDS.shelf)).toBe(true);

    // Die Meldung nennt die vergebenen IDs; die Menge springt auf 1 zurück.
    const status = toasts();
    expect(status).toHaveTextContent("3 × Basmati Reis nach Vorratsregal eingelagert");
    for (const pkg of added) {
      expect(status).toHaveTextContent(pkg.id);
    }
    expect(screen.getByRole("status", { name: "Menge für das nächste Einlagern: 1" })).toBeInTheDocument();

    // Rückgängig entnimmt genau diese Packungen als „falsch erfasst".
    await user.click(within(status).getByRole("button", { name: "Rückgängig" }));
    await waitFor(() => expect(value(core.data.packages).filter((pkg) => !before.has(pkg.id))).toEqual([]));
    const undone = value(core.data.removedPackages).filter((pkg) => added.some((mine) => mine.id === pkg.id));
    expect(undone.map((pkg) => pkg.removal_reason)).toEqual(["mistake", "mistake", "mistake"]);
  });

  it("lagert einen unbekannten Barcode sofort als Platzhalter ein, auf Wunsch mit Namen und ohne MHD", async () => {
    const { user, core } = setup({ latency: 600 });
    const barcode = sampleBarcode(901);
    await enter(user, barcode);

    const dialog = await screen.findByRole("dialog", { name: "Einlagern" });
    expect(within(dialog).getByText("Neues Produkt")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Name (freiwillig)"), "Senf");
    await user.click(within(dialog).getByRole("button", { name: "Kein MHD" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Einlagern" })).not.toBeInTheDocument());
    const product = await core.data.findProductByBarcode(barcode);
    expect(product).toMatchObject({ name: "Senf", barcodes: [barcode] });
    const stored = value(core.data.packages).filter((pkg) => pkg.product_id === product?.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.best_before).toBeNull();
    expect(toasts()).toHaveTextContent("1 × Senf");
  });

  it("lagert ohne Namen ein Produkt ein, das seinen Barcode als Titel trägt", async () => {
    const { user, core } = setup({ latency: 600 });
    const barcode = sampleBarcode(903);
    await enter(user, barcode);
    const dialog = await screen.findByRole("dialog", { name: "Einlagern" });
    await user.type(within(dialog).getByLabelText("Mindesthaltbarkeitsdatum"), "03/27{Enter}");

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Einlagern" })).not.toBeInTheDocument());
    const product = await core.data.findProductByBarcode(barcode);
    expect(product).toMatchObject({ name: "", lookup: "pending" });
    // Nur Monat und Jahr: der letzte Tag des Monats.
    expect(value(core.data.packages).find((pkg) => pkg.product_id === product?.id)?.best_before).toBe("2027-03-31");
    expect(toasts()).toHaveTextContent(`1 × ${barcode}`);
  });

  it("lagert nichts ein, wenn der Dialog geschlossen wird", async () => {
    const { user, core } = setup();
    const before = value(core.data.packages).length;
    await enter(user, RICE_BARCODE);
    const dialog = await screen.findByRole("dialog", { name: "Einlagern" });
    await user.click(within(dialog).getByRole("button", { name: "Schließen" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Einlagern" })).not.toBeInTheDocument());
    expect(value(core.data.packages)).toHaveLength(before);
  });
});

describe("Entnehmen", () => {
  it("bucht eine Packung über ihre ID aus und macht es auf Wunsch rückgängig", async () => {
    const { user, core } = setup();
    const pkg = value(core.data.packages)[0];
    const id = pkg?.id ?? "";
    // Kleinbuchstaben und Bindestrich wie von Hand getippt
    await enter(user, `${id.slice(0, 2).toLowerCase()}-${id.slice(2).toLowerCase()}`);

    await waitFor(() => expect(value(core.data.packages).some((candidate) => candidate.id === id)).toBe(false));
    expect(value(core.data.removedPackages).find((candidate) => candidate.id === id)?.removal_reason).toBe("consumed");
    const status = toasts();
    expect(status).toHaveTextContent(`${id}`);
    expect(status).toHaveTextContent("entnommen");

    await user.click(within(status).getByRole("button", { name: "Rückgängig" }));
    await waitFor(() => expect(value(core.data.packages).some((candidate) => candidate.id === id)).toBe(true));
    expect(toasts()).toHaveTextContent("wieder im Bestand");
  });

  it("lässt die Entnahme stattdessen als entsorgt melden", async () => {
    const { user, core } = setup();
    const id = value(core.data.packages)[0]?.id ?? "";
    await enter(user, id);
    await user.click(await screen.findByRole("button", { name: "Entsorgt" }));

    await waitFor(() => expect(value(core.data.removedPackages).find((candidate) => candidate.id === id)?.removal_reason).toBe("discarded"));
    expect(toasts()).toHaveTextContent("als entsorgt gemeldet");
    expect(screen.queryByRole("button", { name: "Entsorgt" })).not.toBeInTheDocument();
    // Auch das lässt sich noch zurücknehmen.
    await user.click(within(toasts()).getByRole("button", { name: "Rückgängig" }));
    await waitFor(() => expect(value(core.data.packages).some((candidate) => candidate.id === id)).toBe(true));
  });

  it("meldet eine unbekannte ID und eine schon entnommene Packung verständlich", async () => {
    const { user, core } = setup();
    const before = value(core.data.packages).length;
    await enter(user, "ZZZZZ");
    expect(await screen.findByText(/Die Packung ZZZZZ kennt dieses Gerät nicht/)).toBeInTheDocument();

    const removed = value(core.data.removedPackages)[0];
    await enter(user, removed?.id ?? "");
    expect(await screen.findByText(/ist schon entnommen/)).toBeInTheDocument();
    expect(value(core.data.packages)).toHaveLength(before);

    // Eine schon entnommene Packung lässt sich von hier aus wieder einlagern.
    await user.click(screen.getByRole("button", { name: "Wieder einlagern" }));
    await waitFor(() => expect(value(core.data.packages).some((candidate) => candidate.id === removed?.id)).toBe(true));
  });

  it("meldet einen Code, der weder Barcode noch Etikett ist", async () => {
    const { user } = setup();
    // Ein Zonen-Etikett einer Zone, die es nicht gibt
    await enter(user, zoneQr("10000000-0000-4000-8000-000000000099"));
    expect(await screen.findByText("Dieses Zonen-Etikett gehört zu keiner Zone mehr.")).toBeInTheDocument();
  });
});

describe("Zonen", () => {
  it("lässt im Modus Primärzone einen Wechsel für genau einen Einlager-Vorgang gelten", async () => {
    const { user, core } = setup();
    expect(zoneButton("Vorratsregal")).toBeChecked();
    expect(zoneButton("Vorratsregal")).toHaveTextContent("Primär");

    await user.click(zoneButton("Keller"));
    expect(zoneButton("Keller")).toBeChecked();
    expect(screen.getByText(/Gilt nur für das nächste Einlagern/)).toBeInTheDocument();

    const before = new Set(value(core.data.packages).map((pkg) => pkg.id));
    await enter(user, RICE_BARCODE);
    let dialog = await screen.findByRole("dialog", { name: "Einlagern" });
    expect(within(dialog).getByText(/nach Keller/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Kein MHD" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Einlagern" })).not.toBeInTheDocument());

    // Danach gilt wieder die Primärzone.
    expect(zoneButton("Vorratsregal")).toBeChecked();
    expect(screen.queryByText(/Gilt nur für das nächste Einlagern/)).not.toBeInTheDocument();
    await enter(user, RICE_BARCODE);
    dialog = await screen.findByRole("dialog", { name: "Einlagern" });
    await user.click(within(dialog).getByRole("button", { name: "Kein MHD" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Einlagern" })).not.toBeInTheDocument());

    const added = value(core.data.packages).filter((pkg) => !before.has(pkg.id));
    expect(added.map((pkg) => pkg.zone_id).sort()).toEqual([ZONE_IDS.shelf, ZONE_IDS.cellar].sort());
    // Im Modus Primärzone merkt sich das Gerät nichts.
    expect(value(core.prefs.value).scan_zone_id).toBeNull();
  });

  it("wechselt die Zone auch über ihr Etikett", async () => {
    const { user } = setup();
    await enter(user, zoneQr(ZONE_IDS.freezer));
    await waitFor(() => expect(zoneButton("Gefrierschrank")).toBeChecked());
    expect(toasts()).toHaveTextContent("Das nächste Einlagern geht nach Gefrierschrank.");
  });

  it("behält im Modus gleichwertig den Wechsel und merkt ihn auf dem Gerät", async () => {
    const data = createMockCore({ latency: 0, now: () => NOW }).control.snapshot();
    const { user, core } = setup({ data: { settings: { ...data.settings, zone_mode: "equal" } } });
    expect(zoneButton("Vorratsregal")).toBeChecked();
    expect(zoneButton("Vorratsregal")).not.toHaveTextContent("Primär");

    await enter(user, zoneQr(ZONE_IDS.cellar));
    await waitFor(() => expect(zoneButton("Keller")).toBeChecked());
    await waitFor(() => expect(value(core.prefs.value).scan_zone_id).toBe(ZONE_IDS.cellar));
    expect(screen.queryByText(/Gilt nur für das nächste Einlagern/)).not.toBeInTheDocument();

    const before = new Set(value(core.data.packages).map((pkg) => pkg.id));
    for (let round = 0; round < 2; round += 1) {
      await enter(user, RICE_BARCODE);
      const dialog = await screen.findByRole("dialog", { name: "Einlagern" });
      await user.click(within(dialog).getByRole("button", { name: "Kein MHD" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Einlagern" })).not.toBeInTheDocument());
      expect(zoneButton("Keller")).toBeChecked();
    }
    const added = value(core.data.packages).filter((pkg) => !before.has(pkg.id));
    expect(added.map((pkg) => pkg.zone_id)).toEqual([ZONE_IDS.cellar, ZONE_IDS.cellar]);
  });

  it("zeigt bei nur einer Zone nichts zu Zonen", async () => {
    const { user, core } = setup({ scenarios: ["single-zone"] });
    await screen.findByLabelText("Packungs-ID oder Barcode");
    expect(screen.queryByRole("radiogroup", { name: "Zone" })).not.toBeInTheDocument();
    expect(screen.queryByText("Primär")).not.toBeInTheDocument();

    const before = value(core.data.packages).length;
    await enter(user, RICE_BARCODE);
    const dialog = await screen.findByRole("dialog", { name: "Einlagern" });
    expect(within(dialog).queryByText(/nach Vorrat/)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Kein MHD" }));
    await waitFor(() => expect(value(core.data.packages)).toHaveLength(before + 1));
    expect(toasts()).not.toHaveTextContent("nach Vorrat");

    // Das Etikett der einzigen Zone ändert nichts und meldet nichts.
    await enter(user, zoneQr(ZONE_IDS.shelf));
    expect(screen.queryByText(/Zone:/)).not.toBeInTheDocument();
  });
});

describe("Menge", () => {
  it("lässt sich vorwählen und bleibt zwischen 1 und 50", async () => {
    const { user } = setup();
    const less = await screen.findByRole("button", { name: "Eine Packung weniger" });
    const more = screen.getByRole("button", { name: "Eine Packung mehr" });
    expect(less).toBeUnavailable();
    await user.click(more);
    await user.click(more);
    expect(screen.getByRole("status", { name: "Menge für das nächste Einlagern: 3" })).toBeInTheDocument();
    await user.click(less);
    expect(screen.getByRole("status", { name: "Menge für das nächste Einlagern: 2" })).toBeInTheDocument();
  });
});

describe("Was die Ansicht verspricht und meldet", () => {
  /** Ein ladeninterner Code (Präfix 2) mit stimmender Prüfziffer. */
  const INTERNAL_BARCODE = `200000000001${gtinCheckDigit("200000000001")}`;

  async function openStoreSheet(user: ReturnType<typeof userEvent.setup>, barcode: string): Promise<HTMLElement> {
    await enter(user, barcode);
    return screen.findByRole("dialog", { name: "Einlagern" });
  }

  async function closeSheet(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement): Promise<void> {
    await user.click(within(dialog).getByRole("button", { name: "Schließen" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Einlagern" })).not.toBeInTheDocument());
  }

  it("sagt nur dann, dass Name und Bild nachkommen, wenn der Server diesen Barcode nachschlägt", async () => {
    const { user, core } = setup();
    // Ohne Server wird beim Scannen nicht nachgeschlagen: Es bleibt beim Versprechen für später.
    core.control.setOnline(false);
    let dialog = await openStoreSheet(user, sampleBarcode(905));
    expect(within(dialog).getByText(/Name und Bild ergänzt Stowly/)).toBeInTheDocument();
    await closeSheet(user, dialog);
    core.control.setOnline(true);

    // Ein ladeninterner Code wird nie nachgeschlagen: nichts versprechen, zum Namen einladen.
    dialog = await openStoreSheet(user, INTERNAL_BARCODE);
    expect(within(dialog).queryByText(/Name und Bild ergänzt Stowly/)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/schlägt Stowly nicht nach/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Name (freiwillig)")).toBeInTheDocument();
    await closeSheet(user, dialog);

    // Das Nachschlagen ist am Server abgeschaltet.
    core.control.setLookupEnabled(false);
    dialog = await openStoreSheet(user, sampleBarcode(907));
    expect(within(dialog).queryByText(/Name und Bild ergänzt Stowly/)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/schlägt Stowly nicht nach/)).toBeInTheDocument();
  });

  it("schlägt einen unbekannten Barcode gleich nach und legt das Produkt mit Name, Marke und Größe an", async () => {
    const { user, core } = setup({ latency: 50 });
    // Gerade Prüfziffer: Die Attrappe findet ihn.
    const barcode = ["96385074", sampleBarcode(906), sampleBarcode(908)].find((code) => Number(code.at(-1)) % 2 === 0) ?? "96385074";
    const dialog = await openStoreSheet(user, barcode);
    // Der Dialog ist sofort da; nachgeschlagen wird im Hintergrund.
    expect(within(dialog).getByText("Wird bei Open Food Facts nachgeschlagen …")).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByLabelText("Name (freiwillig)")).toHaveValue(`Beispielprodukt ${barcode.slice(-4)}`));
    expect(within(dialog).getByText(/Beispielmarke · 500 g · Von Open Food Facts/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Kein MHD" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Einlagern" })).not.toBeInTheDocument());
    expect(await core.data.findProductByBarcode(barcode)).toMatchObject({ name: `Beispielprodukt ${barcode.slice(-4)}`, brand: "Beispielmarke", quantity: "500 g" });
  });

  it("gibt dem MHD-Feld beim Öffnen den Fokus; Enter ohne Datum schließt nichts", async () => {
    const { user, core } = setup();
    const before = value(core.data.packages).length;
    const dialog = await openStoreSheet(user, RICE_BARCODE);
    const date = within(dialog).getByLabelText("Mindesthaltbarkeitsdatum");
    await waitFor(() => expect(date).toHaveFocus());
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Einlagern" })).toBeInTheDocument();
    expect(value(core.data.packages)).toHaveLength(before);
    // Tippen landet im Feld, Enter mit gültigem Datum lagert ein.
    await user.keyboard("0327{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Einlagern" })).not.toBeInTheDocument());
    expect(value(core.data.packages)).toHaveLength(before + 1);
  });

  it("sagt nach dem Einlagern in einem Halbsatz, was mit den Etiketten ist", async () => {
    const { user, core } = setup();
    const dialog = await openStoreSheet(user, RICE_BARCODE);
    await user.click(within(dialog).getByRole("button", { name: "Kein MHD" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Einlagern" })).not.toBeInTheDocument());
    // Der Haushalt hat einen Drucker: Das Etikett ist angefordert und wird zugestellt.
    expect(value(core.data.printJobs).length).toBeGreaterThan(0);
    expect(await screen.findByText(/· Etikett (steht aus|wird gedruckt|gedruckt|nicht gedruckt)/)).toBeInTheDocument();
  });

  it("sagt nichts zu Etiketten, wenn keine angefordert wurden", async () => {
    const { user, core } = setup();
    await core.prefs.update({ print_labels: false });
    const dialog = await openStoreSheet(user, RICE_BARCODE);
    await user.click(within(dialog).getByRole("button", { name: "Kein MHD" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Einlagern" })).not.toBeInTheDocument());
    expect(toasts()).toHaveTextContent("1 × Basmati Reis");
    expect(screen.queryByText(/· Etikett/)).not.toBeInTheDocument();
  });
});

describe("Nach dem Entnehmen", () => {
  function productNamed(core: MockCore, name: string): Product {
    const product = value(core.data.products).find((candidate) => candidate.name === name);
    if (!product) {
      throw new Error(`Kein Produkt ${name}`);
    }
    return product;
  }

  function stockOf(core: MockCore, productId: string) {
    return value(core.data.packages).filter((pkg) => pkg.product_id === productId);
  }

  it("nennt neben Rückgängig eine ältere Packung desselben Produkts; tauschen heißt zurücknehmen und die ältere scannen", async () => {
    const { user, core } = setup();
    const rice = productNamed(core, "Basmati Reis");
    const packages = stockOf(core, rice.id);
    const newest = [...packages].sort(compareFifo).at(-1);
    const oldest = nextPackage(packages, rice.id);
    const hint = `Älter: ${oldest?.id ?? ""} · MHD ${formatDate(oldest?.best_before ?? "").slice(0, 6)} · Keller`;

    await enter(user, newest?.id ?? "");
    // In der Meldung mit „Rückgängig" und darüber, bis die nächste Aktion ihn ersetzt.
    await waitFor(() => expect(toasts()).toHaveTextContent(hint));
    expect(within(toasts()).getByRole("button", { name: "Rückgängig" })).toBeInTheDocument();
    expect(screen.getByText(hint)).toBeInTheDocument();

    await user.click(within(toasts()).getByRole("button", { name: "Rückgängig" }));
    await waitFor(() => expect(stockOf(core, rice.id).some((pkg) => pkg.id === newest?.id)).toBe(true));
    await enter(user, oldest?.id ?? "");
    await waitFor(() => expect(stockOf(core, rice.id).some((pkg) => pkg.id === oldest?.id)).toBe(false));
    // Die übrigen Packungen sind nicht älter (gleiches MHD zählt nicht): kein Hinweis.
    expect(screen.queryByText(/^Älter:/)).not.toBeInTheDocument();
  });

  it("nennt die Zone nur bei mehr als einer und schweigt nach dem Entsorgen", async () => {
    const { user, core } = setup({ scenarios: ["single-zone"] });
    const rice = productNamed(core, "Basmati Reis");
    const packages = stockOf(core, rice.id);
    const newest = [...packages].sort(compareFifo).at(-1);
    const oldest = nextPackage(packages, rice.id);
    await enter(user, newest?.id ?? "");
    const hint = `Älter: ${oldest?.id ?? ""} · MHD ${formatDate(oldest?.best_before ?? "").slice(0, 6)}`;
    expect(await screen.findByText(hint)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Entsorgt" }));
    await waitFor(() => expect(screen.queryByText(hint)).not.toBeInTheDocument());
  });

  it("bietet nach der letzten Packung die Einkaufsliste an und sagt, wenn das Produkt schon darauf steht", async () => {
    const { user, core } = setup();
    const flour = productNamed(core, "Weizenmehl Type 405");
    const [only] = stockOf(core, flour.id);
    await enter(user, only?.id ?? "");
    await user.click(await screen.findByRole("button", { name: "Auf die Einkaufsliste" }));
    expect(await screen.findByText("Steht jetzt auf der Einkaufsliste.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Auf die Einkaufsliste" })).not.toBeInTheDocument();
    expect(value(core.data.shoppingItems).filter((item) => item.product_id === flour.id && isOpenItem(item))).toMatchObject([{ origin: "manual", quantity: null }]);

    // Olivenöl steht schon auf der Liste (eigener Eintrag der Beispieldaten).
    const oil = productNamed(core, "Olivenöl");
    await enter(user, stockOf(core, oil.id)[0]?.id ?? "");
    expect(await screen.findByText("Steht schon auf der Einkaufsliste.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Auf die Einkaufsliste" })).not.toBeInTheDocument();

    // Ist noch etwas da, gibt es nichts anzubieten.
    const pasta = productNamed(core, "Spaghetti");
    await enter(user, stockOf(core, pasta.id)[0]?.id ?? "");
    await waitFor(() => expect(toasts()).toHaveTextContent("Spaghetti"));
    expect(screen.queryByRole("button", { name: "Auf die Einkaufsliste" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Einkaufsliste\./)).not.toBeInTheDocument();
  });
});
