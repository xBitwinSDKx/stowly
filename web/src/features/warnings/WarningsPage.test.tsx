/**
 * MHD-Warnungen auf der Attrappe: die Liste, ihre Zahl und die Aktionen.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { addDays, formatDate, ROUTES, todayLocal, type Live } from "@/contract";
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
  await screen.findByRole("heading", { name: "Warnungen" });
}

/** Die Produktnamen der Warnliste in der gezeigten Reihenfolge. */
function listed(): string[] {
  return screen.getAllByRole("button", { name: /^Entnehmen: / }).map((button) => (button.getAttribute("aria-label") ?? "").replace("Entnehmen: ", ""));
}

describe("Warnungen", () => {
  it("listet Abgelaufenes und bald Ablaufendes nach Dringlichkeit, je Produkt und MHD", async () => {
    const core = renderApp({}, ROUTES.warnings);
    await ready();
    const placeholder = value(core.data.products).find((product) => product.name === "" && product.lookup === "not_found");

    expect(listed()).toEqual(["Haferflocken", placeholder?.barcodes[0], "Butter", "Passierte Tomaten", "Weizenmehl Type 405", "Lachsfilet (TK)"]);
    expect(screen.getByRole("heading", { name: "Abgelaufen" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Läuft bald ab" })).toBeInTheDocument();
    expect(screen.getByText("8 Packungen")).toBeInTheDocument();
    expect(screen.getByText("1 abgelaufen")).toBeInTheDocument();
    expect(screen.getByText("7 laufen bald ab")).toBeInTheDocument();
  });

  it("zeigt je Eintrag MHD, Abstand, Menge, Zone und Packungs-IDs", async () => {
    const core = renderApp({}, ROUTES.warnings);
    await ready();
    const today = todayLocal();
    const tomatoes = value(core.data.products).find((product) => product.name === "Passierte Tomaten");
    const ids = value(core.data.packages)
      .filter((pkg) => pkg.product_id === tomatoes?.id && pkg.best_before === addDays(today, 9))
      .map((pkg) => pkg.id)
      .sort();

    const item = screen.getByRole("button", { name: "Entnehmen: Passierte Tomaten" }).closest("li");
    if (!item) {
      throw new Error("Eintrag fehlt");
    }
    expect(item).toHaveTextContent(formatDate(addDays(today, 9)));
    expect(item).toHaveTextContent("läuft in 9 Tagen ab");
    expect(item).toHaveTextContent("2 ×");
    expect(item).toHaveTextContent("Keller");
    expect(within(item).getAllByRole("listitem").map((entry) => entry.textContent)).toEqual(ids);

    const oats = screen.getByRole("button", { name: "Entnehmen: Haferflocken" }).closest("li");
    expect(oats).toHaveTextContent("seit 3 Tagen abgelaufen");
  });

  it("richtet sich nach der Vorlaufzeit des Produkts", async () => {
    const core = renderApp({}, ROUTES.warnings);
    await ready();
    // Lachs warnt 30 Tage vorher und steht deshalb mit 20 Tagen in der Liste.
    expect(listed()).toContain("Lachsfilet (TK)");
    const salmon = value(core.data.products).find((product) => product.name === "Lachsfilet (TK)");
    await core.products.update(salmon?.id ?? "", { warn_days: null });
    await waitFor(() => expect(listed()).not.toContain("Lachsfilet (TK)"));
    expect(screen.getByText("6 Packungen")).toBeInTheDocument();
  });

  it("entnimmt aus der Liste, mit „entsorgt“ als Vorgabe für Abgelaufenes", async () => {
    const core = renderApp({}, ROUTES.warnings);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Entnehmen: Haferflocken" }));
    const dialog = screen.getByRole("dialog", { name: "Packungen entnehmen" });
    expect(within(dialog).getByRole("radio", { name: "Entsorgt" })).toBeChecked();
    await userEvent.click(within(dialog).getByRole("button", { name: "Entnehmen" }));

    await waitFor(() => expect(listed()).not.toContain("Haferflocken"));
    expect(screen.queryByRole("heading", { name: "Abgelaufen" })).not.toBeInTheDocument();
    expect(value(core.data.removedPackages)[0]?.removal_reason).toBe("discarded");
    // Die Pille der Kopfzeile zählt mit.
    expect(screen.getByRole("link", { name: /MHD-Warnungen/ })).toHaveTextContent("7");
  });

  it("korrigiert das MHD; der Eintrag verschwindet dann von selbst", async () => {
    const core = renderApp({}, ROUTES.warnings);
    await ready();
    const flour = value(core.data.products).find((product) => product.name === "Weizenmehl Type 405");
    await userEvent.click(screen.getByRole("button", { name: "MHD korrigieren: Weizenmehl Type 405" }));
    const dialog = screen.getByRole("dialog", { name: "Packung bearbeiten" });
    const field = within(dialog).getByLabelText("MHD");
    await userEvent.clear(field);
    await userEvent.type(field, "25.11.2028");
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(listed()).not.toContain("Weizenmehl Type 405"));
    expect(value(core.data.packages).find((pkg) => pkg.product_id === flour?.id)?.best_before).toBe("2028-11-25");
  });

  it("sagt, wenn nichts abläuft, und nennt die Vorlaufzeit", async () => {
    renderApp({ scenarios: ["empty"] }, ROUTES.warnings);
    await ready();
    expect(screen.getByRole("heading", { name: "Nichts läuft in nächster Zeit ab" })).toBeInTheDocument();
    expect(screen.getByText(/Gewarnt wird 14 Tage vor dem MHD/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /MHD-Warnungen/ })).toHaveTextContent("0");
  });

  it("zeigt ohne Zonen keine Zonen", async () => {
    renderApp({ scenarios: ["single-zone"] }, ROUTES.warnings);
    await ready();
    expect(screen.queryByText("Vorrat")).not.toBeInTheDocument();
    expect(listed()).toHaveLength(6);
  });

  it("bleibt am Handy bedienbar", async () => {
    setTestViewport(375);
    renderApp({}, ROUTES.warnings);
    await ready();
    expect(listed()).toHaveLength(6);
    await userEvent.click(screen.getByRole("button", { name: "Entnehmen: Butter" }));
    expect(screen.getByRole("dialog", { name: "Packungen entnehmen" })).toBeInTheDocument();
  });
});
