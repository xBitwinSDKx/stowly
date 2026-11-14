/**
 * Zonen auf der Attrappe: anlegen, bearbeiten, Reihenfolge, löschen, Modus, QR-Codes.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ROUTES, zoneQr, type Live } from "@/contract";
import { renderApp } from "@/app/render.test-setup";
import { PRINTER_IDS, ZONE_IDS } from "@/mock";
import { setTestViewport } from "@/ui/testing";

function value<T>(live: Live<T>): T {
  const current = live.get();
  if (current === undefined) {
    throw new Error("Live-Wert ist noch nicht geladen");
  }
  return current;
}

async function ready(): Promise<void> {
  await screen.findByRole("heading", { name: "Zonen", level: 1 });
}

/** Die Namen der Zonen in der gezeigten Reihenfolge. */
function listedZones(): string[] {
  return screen.getAllByRole("button", { name: /^Bearbeiten: / }).map((button) => (button.getAttribute("aria-label") ?? "").replace("Bearbeiten: ", ""));
}

describe("Zonen verwalten", () => {
  it("zeigt die Zonen in ihrer Reihenfolge mit der Zahl ihrer Packungen", async () => {
    const core = renderApp({}, ROUTES.zones);
    await ready();
    expect(listedZones()).toEqual(["Vorratsregal", "Keller", "Kühlschrank", "Gefrierschrank"]);

    const inCellar = value(core.data.packages).filter((pkg) => pkg.zone_id === ZONE_IDS.cellar).length;
    const cellar = screen.getByRole("button", { name: "Bearbeiten: Keller" }).closest("li");
    expect(cellar).toHaveTextContent(`${String(inCellar)} Packungen`);
    // Im Modus „Primärzone" ist die Primärzone markiert.
    expect(screen.getByRole("button", { name: "Bearbeiten: Vorratsregal" }).closest("li")).toHaveTextContent("Primärzone");
    expect(cellar).not.toHaveTextContent("Primärzone");
  });

  it("legt eine Zone mit Name, Symbol und Farbe an", async () => {
    const core = renderApp({}, ROUTES.zones);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Zone anlegen" }));
    const dialog = screen.getByRole("dialog", { name: "Zone anlegen" });

    // ohne Namen geht es nicht
    await userEvent.click(within(dialog).getByRole("button", { name: "Anlegen" }));
    expect(within(dialog).getByText("Bitte einen Namen eingeben.")).toBeInTheDocument();

    await userEvent.type(within(dialog).getByLabelText("Name"), "Garage");
    await userEvent.click(within(dialog).getByRole("button", { name: "Garage" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Violett" }));
    expect(within(dialog).getByRole("button", { name: "Garage" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(dialog).getByRole("button", { name: "Anlegen" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(value(core.data.zones).at(-1)).toMatchObject({ name: "Garage", icon: "garage", color: "violet" });
    expect(listedZones()).toEqual(["Vorratsregal", "Keller", "Kühlschrank", "Gefrierschrank", "Garage"]);
    expect(screen.getByText("Zone „Garage“ angelegt")).toBeInTheDocument();
  });

  it("benennt um und ändert nur, was sich geändert hat", async () => {
    const core = renderApp({}, ROUTES.zones);
    const update = vi.spyOn(core.zones, "update");
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Bearbeiten: Keller" }));
    const dialog = screen.getByRole("dialog", { name: "Zone bearbeiten" });
    const name = within(dialog).getByLabelText("Name");
    expect(name).toHaveValue("Keller");
    // Die Farbe der Zone ist vorgewählt.
    expect(within(dialog).getByRole("button", { name: "Blau" })).toHaveAttribute("aria-pressed", "true");

    await userEvent.clear(name);
    await userEvent.type(name, "Vorratskeller");
    await userEvent.click(within(dialog).getByRole("button", { name: "Akzent" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(update).toHaveBeenCalledWith(ZONE_IDS.cellar, { name: "Vorratskeller", color: null });
    expect(value(core.data.zones).find((zone) => zone.id === ZONE_IDS.cellar)).toMatchObject({ name: "Vorratskeller", icon: "cellar", color: null });
  });

  it("ändert die Reihenfolge", async () => {
    const core = renderApp({}, ROUTES.zones);
    await ready();
    expect(screen.getByRole("button", { name: "Vorratsregal nach oben" })).toBeUnavailable();
    expect(screen.getByRole("button", { name: "Gefrierschrank nach unten" })).toBeUnavailable();

    await userEvent.click(screen.getByRole("button", { name: "Gefrierschrank nach oben" }));
    await waitFor(() => expect(listedZones()).toEqual(["Vorratsregal", "Keller", "Gefrierschrank", "Kühlschrank"]));
    await userEvent.click(screen.getByRole("button", { name: "Vorratsregal nach unten" }));
    await waitFor(() => expect(listedZones()).toEqual(["Keller", "Vorratsregal", "Gefrierschrank", "Kühlschrank"]));
    expect(value(core.data.zones).map((zone) => zone.name)).toEqual(["Keller", "Vorratsregal", "Gefrierschrank", "Kühlschrank"]);
  });

  it("lässt den Fokus beim Umsortieren mit der Tastatur an derselben Schaltfläche", async () => {
    const core = renderApp({}, ROUTES.zones);
    await ready();
    screen.getByRole("button", { name: "Keller nach unten" }).focus();

    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(listedZones()).toEqual(["Vorratsregal", "Kühlschrank", "Keller", "Gefrierschrank"]));
    await waitFor(() => expect(screen.getByRole("button", { name: "Keller nach unten" })).toHaveFocus());

    // Noch einmal: Jetzt steht der Keller unten, „nach unten“ ist gesperrt. Der Fokus geht an „nach oben“ derselben Zone.
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(listedZones()).toEqual(["Vorratsregal", "Kühlschrank", "Gefrierschrank", "Keller"]));
    await waitFor(() => expect(screen.getByRole("button", { name: "Keller nach oben" })).toHaveFocus());
    expect(screen.getByRole("button", { name: "Keller nach unten" })).toBeUnavailable();

    // Und mit der Leertaste wieder hinauf, bis ganz nach oben: Dort übernimmt „nach unten“.
    await userEvent.keyboard(" ");
    await waitFor(() => expect(listedZones()).toEqual(["Vorratsregal", "Kühlschrank", "Keller", "Gefrierschrank"]));
    await waitFor(() => expect(screen.getByRole("button", { name: "Keller nach oben" })).toHaveFocus());
    await userEvent.keyboard(" ");
    await waitFor(() => expect(listedZones()).toEqual(["Vorratsregal", "Keller", "Kühlschrank", "Gefrierschrank"]));
    await userEvent.keyboard(" ");
    await waitFor(() => expect(value(core.data.zones).map((zone) => zone.name)).toEqual(["Keller", "Vorratsregal", "Kühlschrank", "Gefrierschrank"]));
    await waitFor(() => expect(screen.getByRole("button", { name: "Keller nach unten" })).toHaveFocus());
    expect(screen.getByRole("button", { name: "Keller nach oben" })).toBeUnavailable();
  });

  it("nimmt einer Schaltfläche ohne Fokus beim Umsortieren nichts weg", async () => {
    renderApp({}, ROUTES.zones);
    await ready();
    const search = screen.getByRole("searchbox", { name: "Bestand durchsuchen" });
    search.focus();
    // Ein Klick, der den Fokus nicht verschiebt (wie in Safari): Der Fokus bleibt, wo er ist.
    screen.getByRole("button", { name: "Gefrierschrank nach oben" }).click();
    await waitFor(() => expect(listedZones()).toEqual(["Vorratsregal", "Keller", "Gefrierschrank", "Kühlschrank"]));
    expect(search).toHaveFocus();
  });

  it("löscht eine Zone und verschiebt ihre Packungen in die gewählte Zielzone", async () => {
    const core = renderApp({}, ROUTES.zones);
    await ready();
    const inFridge = value(core.data.packages).filter((pkg) => pkg.zone_id === ZONE_IDS.fridge).length;
    const inFreezer = value(core.data.packages).filter((pkg) => pkg.zone_id === ZONE_IDS.freezer).length;

    await userEvent.click(screen.getByRole("button", { name: "Löschen: Kühlschrank" }));
    const dialog = screen.getByRole("dialog", { name: "Zone „Kühlschrank“ löschen" });
    const target = within(dialog).getByLabelText(`Wohin mit den ${String(inFridge)} Packungen?`);
    // Die Zone selbst steht nicht zur Wahl.
    expect(within(target).getAllByRole("option").map((option) => option.textContent)).toEqual(["Vorratsregal", "Keller", "Gefrierschrank"]);
    await userEvent.selectOptions(target, "Gefrierschrank");
    await userEvent.click(within(dialog).getByRole("button", { name: "Zone löschen" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(listedZones()).toEqual(["Vorratsregal", "Keller", "Gefrierschrank"]);
    expect(value(core.data.packages).filter((pkg) => pkg.zone_id === ZONE_IDS.freezer)).toHaveLength(inFridge + inFreezer);
    expect(value(core.data.packages).some((pkg) => pkg.zone_id === ZONE_IDS.fridge)).toBe(false);
  });

  it("sagt beim Löschen der Primärzone, wer die Rolle übernimmt", async () => {
    const core = renderApp({}, ROUTES.zones);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Löschen: Vorratsregal" }));
    const dialog = screen.getByRole("dialog", { name: "Zone „Vorratsregal“ löschen" });
    expect(dialog).toHaveTextContent("Diese Zone ist die Primärzone.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Zone löschen" }));
    await waitFor(() => expect(value(core.data.settings).primary_zone_id).toBe(ZONE_IDS.cellar));
    expect(screen.getByRole("button", { name: "Bearbeiten: Keller" }).closest("li")).toHaveTextContent("Primärzone");
  });

  it("lässt die letzte Zone nicht löschen und zeigt mit der zweiten wieder alles zu Zonen", async () => {
    renderApp({ scenarios: ["single-zone"] }, ROUTES.zones);
    await ready();
    expect(screen.getByRole("button", { name: "Löschen: Vorrat" })).toBeUnavailable();
    expect(screen.queryByRole("button", { name: "Vorrat nach oben" })).not.toBeInTheDocument();
    // Der Modus ist mit einer Zone bedeutungslos.
    expect(screen.queryByRole("radiogroup", { name: "Zonenmodus" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Hauptnavigation" })).not.toHaveTextContent("Zonen");

    await userEvent.click(screen.getByRole("button", { name: "Zone anlegen" }));
    await userEvent.type(within(screen.getByRole("dialog")).getByLabelText("Name"), "Keller");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Anlegen" }));

    await waitFor(() => expect(screen.queryByText("Es gibt nur eine Zone")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Löschen: Vorrat" })).toBeAvailable();
    expect(screen.getByRole("radiogroup", { name: "Zonenmodus" })).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Hauptnavigation" })).getByRole("link", { name: "Zonen" })).toBeInTheDocument();
  });
});

describe("Zonenmodus", () => {
  it("wechselt zwischen Primärzone und gleichwertig und erklärt, was das beim Scannen heißt", async () => {
    const core = renderApp({}, ROUTES.zones);
    await ready();
    expect(screen.getByRole("radio", { name: "Primärzone" })).toBeChecked();
    expect(screen.getByText(/lagert genau einen Vorgang dort ein; danach gilt wieder die Primärzone/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: "Gleichwertig" }));
    await waitFor(() => expect(value(core.data.settings).zone_mode).toBe("equal"));
    expect(screen.getByText(/Ein Zonenwechsel beim Scannen bleibt bestehen/)).toBeInTheDocument();
    // Ohne Primärzone gibt es weder deren Auswahl noch die Markierung.
    expect(screen.queryByRole("combobox", { name: "Primärzone" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bearbeiten: Vorratsregal" }).closest("li")).not.toHaveTextContent("Primärzone");
  });

  it("wählt die Primärzone", async () => {
    const core = renderApp({}, ROUTES.zones);
    await ready();
    const select = screen.getByRole("combobox", { name: "Primärzone" });
    expect(select).toHaveDisplayValue("Vorratsregal");
    await userEvent.selectOptions(select, "Keller");
    await waitFor(() => expect(value(core.data.settings).primary_zone_id).toBe(ZONE_IDS.cellar));
    expect(screen.getByRole("button", { name: "Bearbeiten: Keller" }).closest("li")).toHaveTextContent("Primärzone");
  });
});

describe("Zonen-QR-Code", () => {
  it("zeigt den Code einer Zone mit dem vereinbarten Inhalt und druckt über den Browser", async () => {
    renderApp({}, ROUTES.zones);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "QR-Code: Keller" }));
    const dialog = screen.getByRole("dialog", { name: "QR-Code: Keller" });
    expect(zoneQr(ZONE_IDS.cellar)).toBe("STOWLY/Z/10000000000040008000000000000002");
    expect(within(dialog).getByTitle("QR-Code der Zone Keller")).toBeInTheDocument();
    expect(dialog.querySelector("svg path")).not.toBeNull();

    // Das Blatt für den Druck liegt außerhalb der App und trägt Code und Namen.
    const sheet = document.querySelector("body > [data-print-sheet]");
    expect(sheet).toHaveTextContent("Keller");
    expect(sheet).toHaveTextContent("Stowly · Lagerzone");
    expect(sheet?.querySelectorAll("svg")).toHaveLength(1);

    // Mit einem Etikettendrucker ist das Etikett die Hauptaktion; der Druck über den Browser bleibt daneben.
    await userEvent.click(within(dialog).getByRole("button", { name: "Über den Browser drucken" }));
    expect(window.print).toHaveBeenCalledTimes(1);

    // Kreuz oben und Schaltfläche unten: beide schließen.
    const closers = within(dialog).getAllByRole("button", { name: "Schließen" });
    expect(closers).toHaveLength(2);
    if (closers[1]) {
      await userEvent.click(closers[1]);
    }
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.querySelector("[data-print-sheet]")).toBeNull();
  });

  it("zeigt und druckt die Codes aller Zonen auf einmal", async () => {
    renderApp({}, ROUTES.zones);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Alle QR-Codes" }));
    const dialog = screen.getByRole("dialog", { name: "QR-Codes aller Zonen" });
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(4);
    expect(document.querySelectorAll("[data-print-sheet] svg")).toHaveLength(4);
  });
});

describe("Zonen am Handy", () => {
  it("bleibt bedienbar", async () => {
    setTestViewport(375);
    const core = renderApp({}, ROUTES.zones);
    await ready();
    expect(listedZones()).toHaveLength(4);
    await userEvent.click(screen.getByRole("button", { name: "Keller nach oben" }));
    await waitFor(() => expect(value(core.data.zones)[0]?.name).toBe("Keller"));
  });
});

describe("Drucker der Zonen", () => {
  it("zeigt zu jeder Zone, welcher Drucker ihre Etiketten druckt", async () => {
    renderApp({}, ROUTES.zones);
    await ready();
    expect(screen.getByRole("button", { name: "Bearbeiten: Keller" }).closest("li")).toHaveTextContent("Etiketten: Keller (Pi)");
    expect(screen.getByRole("button", { name: "Bearbeiten: Vorratsregal" }).closest("li")).toHaveTextContent("Etiketten: Küche (Bild)");
  });

  it("ordnet im Zonen-Dialog einen Drucker zu und nimmt ihn wieder", async () => {
    const core = renderApp({}, ROUTES.zones);
    const update = vi.spyOn(core.zones, "update");
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Bearbeiten: Kühlschrank" }));
    const dialog = screen.getByRole("dialog", { name: "Zone bearbeiten" });
    const printer = within(dialog).getByLabelText("Drucker");
    expect(printer).toHaveValue("");
    expect(within(printer).getAllByRole("option").map((option) => option.textContent)).toEqual(["Standarddrucker (Küche (Bild))", "Keller (Pi)", "Küche (Bild)"]);
    await userEvent.selectOptions(printer, "Keller (Pi)");
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(ZONE_IDS.fridge, { printer_id: PRINTER_IDS.cellar }));
    expect(screen.getByRole("button", { name: "Bearbeiten: Kühlschrank" }).closest("li")).toHaveTextContent("Etiketten: Keller (Pi)");

    await userEvent.click(screen.getByRole("button", { name: "Bearbeiten: Kühlschrank" }));
    const again = screen.getByRole("dialog", { name: "Zone bearbeiten" });
    await userEvent.selectOptions(within(again).getByLabelText("Drucker"), "Standarddrucker (Küche (Bild))");
    await userEvent.click(within(again).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(update).toHaveBeenLastCalledWith(ZONE_IDS.fridge, { printer_id: null }));
  });

  it("legt eine Zone gleich mit Drucker an", async () => {
    const core = renderApp({}, ROUTES.zones);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Zone anlegen" }));
    const dialog = screen.getByRole("dialog", { name: "Zone anlegen" });
    await userEvent.type(within(dialog).getByLabelText("Name"), "Garage");
    await userEvent.selectOptions(within(dialog).getByLabelText("Drucker"), "Keller (Pi)");
    await userEvent.click(within(dialog).getByRole("button", { name: "Anlegen" }));
    await waitFor(() => expect(value(core.data.zones).find((zone) => zone.name === "Garage")?.printer_id).toBe(PRINTER_IDS.cellar));
  });

  it("kennt bei nur einer Zone und ohne Drucker keine Zuordnung", async () => {
    renderApp({ scenarios: ["single-zone"] }, ROUTES.zones);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Bearbeiten: Vorrat" }));
    expect(within(screen.getByRole("dialog", { name: "Zone bearbeiten" })).queryByLabelText("Drucker")).not.toBeInTheDocument();
    await userEvent.click(within(screen.getByRole("dialog", { name: "Zone bearbeiten" })).getByRole("button", { name: "Abbrechen" }));
    // Die zweite Zone bekommt die Auswahl: Mit ihr gibt es etwas zuzuordnen.
    await userEvent.click(screen.getByRole("button", { name: "Zone anlegen" }));
    expect(within(screen.getByRole("dialog", { name: "Zone anlegen" })).getByLabelText("Drucker")).toBeInTheDocument();
  });

  it("zeigt bei einem zu langen Namen den genauen Satz des Kerns", async () => {
    renderApp({}, ROUTES.zones);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Zone anlegen" }));
    const dialog = screen.getByRole("dialog", { name: "Zone anlegen" });
    await userEvent.type(within(dialog).getByLabelText("Name"), "z".repeat(61));
    await userEvent.click(within(dialog).getByRole("button", { name: "Anlegen" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Der Name ist zu lang (höchstens 60 Zeichen).");
  });
});

describe("Zonen-Etikett", () => {
  it("druckt den Code einer Zone als Etikett und sagt, was daraus wird", async () => {
    const core = renderApp({}, ROUTES.zones);
    const request = vi.spyOn(core.print, "requestZoneLabel");
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "QR-Code: Keller" }));
    const dialog = screen.getByRole("dialog", { name: "QR-Code: Keller" });
    expect(dialog).toHaveTextContent("Das Etikett druckt „Keller (Pi)“.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Etikett drucken" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith(ZONE_IDS.cellar));
    // Der Pi ist im Obergeschoss nicht erreichbar: Das Etikett steht aus.
    expect(await within(dialog).findByRole("status")).toHaveTextContent("1 Etikett steht aus und wird gedruckt, sobald dieses Gerät den Drucker „Keller (Pi)“ erreicht.");
    const job = value(core.data.printJobs).find((entry) => entry.kind === "zone");
    expect(job).toMatchObject({ zone_id: ZONE_IDS.cellar, package_id: null, state: "pending" });

    core.control.setPiReachable(true);
    await waitFor(() => expect(within(dialog).getByRole("status")).toHaveTextContent("1 Etikett ist am Drucker „Keller (Pi)“ gedruckt."));
  });

  it("zeigt die Vorschau des Zonen-Etiketts und sagt offline, dass der Server fehlt", async () => {
    const core = renderApp({}, ROUTES.zones);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "QR-Code: Keller" }));
    const dialog = screen.getByRole("dialog", { name: "QR-Code: Keller" });
    expect(within(dialog).queryByRole("img", { name: /Vorschau/ })).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Vorschau des Etiketts" }));
    expect(await within(dialog).findByRole("img", { name: "Vorschau des Etiketts für die Zone Keller" })).toHaveAttribute("src", expect.stringMatching(/^blob:/));

    // Ausblenden, Server weg, wieder einblenden: ein ruhiger Hinweis statt eines Fehlers.
    await userEvent.click(within(dialog).getByRole("button", { name: "Vorschau des Etiketts" }));
    core.control.setOnline(false);
    await userEvent.click(within(dialog).getByRole("button", { name: "Vorschau des Etiketts" }));
    expect(await within(dialog).findByText("Die Vorschau zeichnet der Server, und der ist gerade nicht erreichbar.")).toBeInTheDocument();
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Erneut versuchen" })).toBeInTheDocument();
  });

  it("druckt die Etiketten aller Zonen auf einmal", async () => {
    const core = renderApp({ scenarios: ["at-pi"] }, ROUTES.zones);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Alle QR-Codes" }));
    const dialog = screen.getByRole("dialog", { name: "QR-Codes aller Zonen" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Etiketten drucken" }));
    await waitFor(() => expect(value(core.data.printJobs).filter((entry) => entry.kind === "zone")).toHaveLength(4));
    await waitFor(() => expect(within(dialog).getByRole("status")).toHaveTextContent("4 Etiketten sind gedruckt."));
  });

  it("bietet ohne Drucker nur den Druck über den Browser an", async () => {
    renderApp({ scenarios: ["empty"] }, ROUTES.zones);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "QR-Code: Vorrat" }));
    const dialog = screen.getByRole("dialog", { name: "QR-Code: Vorrat" });
    expect(within(dialog).queryByRole("button", { name: "Etikett drucken" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Vorschau des Etiketts" })).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Drucken" }));
    expect(window.print).toHaveBeenCalled();
  });
});
