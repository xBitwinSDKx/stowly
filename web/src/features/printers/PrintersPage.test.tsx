/**
 * Drucker-Ansicht auf der Attrappe: Drucker verwalten und zuordnen, ihr Zustand, Verbindung
 * prüfen, Etiketten ansehen, drucken, klären und nachdrucken.
 */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CoreError, ROUTES, type Core, type Live, type PrinterProblem, type PrintJob } from "@/contract";
import { App } from "@/app/App";
import { renderApp } from "@/app/render.test-setup";
import { createMockCore, createSampleData, DEVICE_IDS, MockScanPage, PRINTER_IDS, sampleUuid, ZONE_IDS, type MockCore, type MockOptions } from "@/mock";
import { setTestViewport } from "@/ui/testing";

function value<T>(live: Live<T>): T {
  const current = live.get();
  if (current === undefined) {
    throw new Error("Live-Wert ist noch nicht geladen");
  }
  return current;
}

async function ready(): Promise<void> {
  await screen.findByRole("heading", { name: "Drucker", level: 1 });
}

function card(name: string): HTMLElement {
  return within(screen.getByRole("list", { name: "Drucker" })).getByRole("listitem", { name });
}

function section(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

function job(core: Core, id: string): PrintJob {
  const found = value(core.data.printJobs).find((candidate) => candidate.id === id);
  if (!found) {
    throw new Error(`Etikett ${id} fehlt`);
  }
  return found;
}

/** Zeile eines Etiketts im Abschnitt „Etiketten", gefunden über die Packungs-ID. */
function labelRow(packageId: string): HTMLElement {
  const row = within(section("Etiketten"))
    .getAllByRole("listitem")
    .find((item) => item.textContent?.includes(`Packung ${packageId}`));
  if (!row) {
    throw new Error(`Zeile für die Packung ${packageId} fehlt`);
  }
  return row;
}

/** Die App mit einem Kern, an dem einzelne Methoden ersetzt sind (was die Attrappe nicht nachspielt). */
function renderWith(core: Core, path: string = ROUTES.printers): void {
  window.history.replaceState(null, "", path);
  render(<App core={core} scanPage={MockScanPage} />);
}

function mock(options: MockOptions = {}): MockCore {
  return createMockCore({ latency: 0, ...options });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Drucker", () => {
  it("listet die Drucker mit Art, Zuständigkeit und Zustand", async () => {
    renderApp({}, ROUTES.printers);
    await ready();
    const kitchen = card("Küche (Bild)");
    expect(kitchen).toHaveTextContent("am Server · Bild (PNG)");
    expect(kitchen).toHaveTextContent("Standarddrucker");
    expect(kitchen).toHaveTextContent("bereit");
    expect(kitchen).toHaveTextContent(/Zuletzt gesehen (gerade eben|vor einer Minute|vor \d Minuten)/);
    expect(within(kitchen).getByLabelText("Zustand des Druckers")).toHaveTextContent("Druckerverbunden");

    const cellar = card("Keller (Pi)");
    expect(cellar).toHaveTextContent("direkt (Raspberry Pi)");
    // Die Adressen in der Reihenfolge der Versuche, je eine Zeile.
    expect(within(cellar).getByText("https://10.71.83.1:8443")).toBeInTheDocument();
    expect(within(cellar).getByText("http://10.71.83.1:8080")).toBeInTheDocument();
    expect(cellar.textContent?.indexOf("https://10.71.83.1:8443")).toBeLessThan(cellar.textContent?.indexOf("http://10.71.83.1:8080") ?? 0);
    // Das Token ist ein Geheimnis und steht nirgends in der Ansicht.
    expect(document.body).not.toHaveTextContent("attrappe");
    expect(cellar).toHaveTextContent("Druckt für");
    expect(cellar).toHaveTextContent("Keller");
    expect(cellar).toHaveTextContent("Gefrierschrank");
    expect(cellar).toHaveTextContent("Zuletzt gesehen vor 2 Tagen");
    expect(within(cellar).getByLabelText("Zustand des Druckers")).toHaveTextContent("Etiketteneingelegt");
    const host = within(cellar).getByLabelText("Zustand des Rechners");
    expect(host).toHaveTextContent("Temperatur51 °C");
    expect(host).toHaveTextContent("SD-Karteunauffällig");
    expect(host).toHaveTextContent("Läuftseit 12 Tagen");
    // Auf dem Pi Zero gibt es keine Angabe zur Unterspannung.
    expect(host).not.toHaveTextContent("Stromversorgung");
    // Vor dem Zugriff auf das lokale Netzwerk fragt der Browser: Das steht neben der Schaltfläche.
    expect(cellar).toHaveTextContent("kann der Browser einmal fragen, ob Stowly auf Geräte im lokalen Netzwerk zugreifen darf");
    expect(kitchen).not.toHaveTextContent("lokalen Netzwerk");
  });

  it("hebt Störungen hervor: Drucker aus, Etiketten leer, Pi heiß, SD-Karte, alter Stand", async () => {
    renderApp({ scenarios: ["printer-trouble"] }, ROUTES.printers);
    await ready();
    const kitchen = card("Küche (Bild)");
    expect(kitchen).toHaveTextContent("nicht verbunden");
    expect(kitchen).toHaveTextContent("Der Drucker ist aus oder nicht verbunden.");

    const cellar = card("Keller (Pi)");
    expect(cellar).toHaveTextContent("Etiketten leer");
    expect(cellar).toHaveTextContent("Zuletzt gesehen vor 9 Tagen");
    expect(cellar).toHaveTextContent("Stand ist alt");
    expect(cellar).toHaveTextContent("Es sind keine Etiketten eingelegt.");
    const host = within(cellar).getByLabelText("Zustand des Rechners");
    expect(host).toHaveTextContent("82 °C (heiß)");
    expect(host).toHaveTextContent("gedrosselt");
    expect(host).toHaveTextContent("3 Fehler, nur noch lesbar");
    expect(host).toHaveTextContent("91 % belegt (fast voll)");
    // Auffälliges trägt seine Farbe.
    expect(within(host).getByText("82 °C (heiß)").closest("div")).toHaveClass("fact-danger");
    expect(within(host).getByText("gedrosselt").closest("div")).toHaveClass("fact-warn");
  });

  it("erklärt ohne Drucker, was ein Drucker bringt", async () => {
    renderApp({ scenarios: ["empty"] }, ROUTES.printers);
    await ready();
    expect(screen.getByRole("heading", { name: "Noch kein Drucker eingerichtet" })).toBeInTheDocument();
    expect(screen.getByText(/Ohne Drucker fordert Stowly keine Etiketten an/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Zuordnung" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Etiketten" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Drucker hinzufügen" })).toBeInTheDocument();
  });

  it("legt einen Drucker am Server an und bietet gleich an, die Verbindung zu prüfen", async () => {
    const core = renderApp({}, ROUTES.printers);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Drucker hinzufügen" }));
    const dialog = screen.getByRole("dialog", { name: "Drucker hinzufügen" });
    expect(within(dialog).getByLabelText("Name")).toHaveFocus();
    expect(within(dialog).getByRole("radio", { name: "Am Server" })).toBeChecked();

    // Ohne Angaben sagt der Dialog, was fehlt.
    await userEvent.click(within(dialog).getByRole("button", { name: "Anlegen" }));
    expect(within(dialog).getByText("Bitte einen Namen eingeben.")).toBeInTheDocument();
    expect(within(dialog).getByText("Bitte das Modell angeben, z. B. QL-820NWB.")).toBeInTheDocument();
    expect(within(dialog).getByText("Bitte die Adresse des Druckers angeben.")).toBeInTheDocument();

    await userEvent.type(within(dialog).getByLabelText("Name"), "Speisekammer");
    await userEvent.type(within(dialog).getByLabelText("Modell"), "QL-820NWB");
    await userEvent.type(within(dialog).getByLabelText("Adresse"), "192.168.1.60");
    await userEvent.click(within(dialog).getByRole("button", { name: "Anlegen" }));
    expect(within(dialog).getByText(/Erwartet wird tcp:\/\/… für einen Drucker im Netzwerk/)).toBeInTheDocument();
    await userEvent.clear(within(dialog).getByLabelText("Adresse"));
    await userEvent.type(within(dialog).getByLabelText("Adresse"), "tcp://192.168.1.60:9100");
    await userEvent.click(within(dialog).getByRole("button", { name: "Anlegen" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const created = value(core.data.printers).find((printer) => printer.name === "Speisekammer");
    expect(created).toMatchObject({ connection: "server", server: { driver: "brother_ql", model: "QL-820NWB", address: "tcp://192.168.1.60:9100", media: "62" }, direct: null });

    // Eben angelegt: noch nie gesehen, und die Karte bietet die Prüfung an.
    const fresh = card("Speisekammer");
    expect(fresh).toHaveTextContent("noch nie gesehen");
    expect(fresh).toHaveTextContent("am Server · QL-820NWB");
    expect(fresh).toHaveTextContent("noch nichts: weder Standarddrucker noch einer Zone zugeordnet");
    expect(within(fresh).getByText("Drucker angelegt")).toBeInTheDocument();
    await userEvent.click(within(fresh).getByRole("button", { name: "Verbindung prüfen: Speisekammer" }));
    expect(await within(fresh).findByText("Der Druckdienst antwortet.")).toBeInTheDocument();
    expect(fresh).toHaveTextContent(/Zuletzt gesehen gerade eben/);
  });

  it("legt einen Drucker mit Bild-Treiber an: ohne Modell und Adresse", async () => {
    const core = renderApp({}, ROUTES.printers);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Drucker hinzufügen" }));
    const dialog = screen.getByRole("dialog", { name: "Drucker hinzufügen" });
    await userEvent.type(within(dialog).getByLabelText("Name"), "Probe");
    await userEvent.selectOptions(within(dialog).getByLabelText("Treiber"), "Bild (PNG), zum Ausprobieren");
    expect(within(dialog).queryByLabelText("Modell")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Adresse")).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Anlegen" }));
    await waitFor(() => expect(value(core.data.printers).some((printer) => printer.name === "Probe")).toBe(true));
    expect(value(core.data.printers).find((printer) => printer.name === "Probe")?.server).toEqual({ driver: "image", model: null, address: null, media: "62" });
  });

  it("legt einen direkten Drucker an: Adressen in Reihenfolge, Token verdeckt", async () => {
    const core = renderApp({ scenarios: ["empty"] }, ROUTES.printers);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Drucker hinzufügen" }));
    const dialog = screen.getByRole("dialog", { name: "Drucker hinzufügen" });
    await userEvent.type(within(dialog).getByLabelText("Name"), "Keller");
    await userEvent.click(within(dialog).getByRole("radio", { name: "Direkt (Raspberry Pi)" }));
    expect(within(dialog).getByText(/stehen in der Anleitung des Raspberry Pi/)).toBeInTheDocument();
    // Die üblichen beiden Adressen stehen schon da.
    expect(within(dialog).getByLabelText("Adresse 1")).toHaveValue("https://10.71.83.1:8443");
    expect(within(dialog).getByLabelText("Adresse 2")).toHaveValue("http://10.71.83.1:8080");
    const token = within(dialog).getByLabelText("Token");
    expect(token).toHaveAttribute("type", "password");

    await userEvent.click(within(dialog).getByRole("button", { name: "Anlegen" }));
    expect(within(dialog).getByText("Bitte das Token eingeben.")).toBeInTheDocument();

    await userEvent.type(token, "sehr-geheim");
    await userEvent.click(within(dialog).getByRole("button", { name: "Token anzeigen" }));
    expect(token).toHaveAttribute("type", "text");
    await userEvent.click(within(dialog).getByRole("button", { name: "Token verbergen" }));
    expect(token).toHaveAttribute("type", "password");

    // Höchstens vier Adressen; eine ungültige wird benannt, eine leere fällt weg.
    await userEvent.click(within(dialog).getByRole("button", { name: "Adresse hinzufügen" }));
    // Im neuen Feld geht es gleich weiter.
    expect(within(dialog).getByLabelText("Adresse 3")).toHaveFocus();
    await userEvent.click(within(dialog).getByRole("button", { name: "Adresse hinzufügen" }));
    expect(within(dialog).getByLabelText("Adresse 4")).toHaveFocus();
    expect(within(dialog).queryByRole("button", { name: "Adresse hinzufügen" })).not.toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("Adresse 3"), "pi.local:8080");
    await userEvent.click(within(dialog).getByRole("button", { name: "Anlegen" }));
    expect(within(dialog).getByText("Keine gültige Adresse. Beispiel: https://10.71.83.1:8443")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Adresse 3 entfernen" }));
    // Die Schaltfläche ist mit der Zeile verschwunden: Der Fokus bleibt bei den Adressen.
    expect(within(dialog).getByRole("button", { name: "Adresse hinzufügen" })).toHaveFocus();
    await userEvent.type(within(dialog).getByLabelText("Name des Druckers im Dienst (freiwillig)"), "ql800");
    await userEvent.click(within(dialog).getByRole("button", { name: "Anlegen" }));

    await waitFor(() => expect(value(core.data.printers)).toHaveLength(1));
    expect(value(core.data.printers)[0]).toMatchObject({
      name: "Keller",
      connection: "direct",
      server: null,
      direct: { urls: ["https://10.71.83.1:8443", "http://10.71.83.1:8080"], token: "sehr-geheim", printer: "ql800" },
    });
    expect(document.body).not.toHaveTextContent("sehr-geheim");
  });

  it("zeigt bei einer ungültigen Eingabe den genauen Satz des Kerns", async () => {
    renderApp({}, ROUTES.printers);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Drucker hinzufügen" }));
    const dialog = screen.getByRole("dialog", { name: "Drucker hinzufügen" });
    await userEvent.type(within(dialog).getByLabelText("Name"), "x".repeat(61));
    await userEvent.selectOptions(within(dialog).getByLabelText("Treiber"), "Bild (PNG), zum Ausprobieren");
    await userEvent.click(within(dialog).getByRole("button", { name: "Anlegen" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Der Name ist zu lang (höchstens 60 Zeichen).");
  });

  it("bearbeitet einen Drucker: Die Art steht fest, gesendet wird nur, was sich geändert hat", async () => {
    const core = renderApp({}, ROUTES.printers);
    const update = vi.spyOn(core.printers, "update");
    await ready();
    await userEvent.click(within(card("Keller (Pi)")).getByRole("button", { name: "Bearbeiten: Keller (Pi)" }));
    const dialog = screen.getByRole("dialog", { name: "Drucker bearbeiten" });
    expect(within(dialog).queryByRole("radiogroup", { name: "Art" })).not.toBeInTheDocument();
    expect(within(dialog).getByText("Die Art lässt sich nach dem Anlegen nicht ändern.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Token")).toHaveValue("attrappe");
    expect(within(dialog).getByLabelText("Token")).toHaveAttribute("type", "password");

    await userEvent.clear(within(dialog).getByLabelText("Name"));
    await userEvent.type(within(dialog).getByLabelText("Name"), "Keller unten");
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(PRINTER_IDS.cellar, { name: "Keller unten" }));
    expect(card("Keller unten")).toBeInTheDocument();

    // Eine Adresse weniger: Die Angaben zum Druckdienst gehen als Ganzes mit.
    await userEvent.click(within(card("Keller unten")).getByRole("button", { name: "Bearbeiten: Keller unten" }));
    const again = screen.getByRole("dialog", { name: "Drucker bearbeiten" });
    await userEvent.click(within(again).getByRole("button", { name: "Adresse 2 entfernen" }));
    await userEvent.click(within(again).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(update).toHaveBeenLastCalledWith(PRINTER_IDS.cellar, { direct: { urls: ["https://10.71.83.1:8443"], token: "attrappe", printer: null } }));

    // Ohne Änderung wird nichts gesendet.
    update.mockClear();
    await userEvent.click(within(card("Küche (Bild)")).getByRole("button", { name: "Bearbeiten: Küche (Bild)" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Drucker bearbeiten" })).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(update).not.toHaveBeenCalled();
  });

  it("löscht einen Drucker nach Rückfrage und sagt vorher, was passiert", async () => {
    const core = renderApp({}, ROUTES.printers);
    await ready();
    await userEvent.click(within(card("Keller (Pi)")).getByRole("button", { name: "Löschen: Keller (Pi)" }));
    const dialog = screen.getByRole("dialog", { name: "Drucker „Keller (Pi)“ löschen?" });
    expect(dialog).toHaveTextContent("Er druckt für „Keller“ und „Gefrierschrank“.");
    expect(dialog).toHaveTextContent("Diese Zonen nutzen danach wieder den Standarddrucker „Küche (Bild)“.");
    // Wohin die ausstehenden Etiketten danach gehen: zwei eigene und eines eines anderen Geräts.
    expect(dialog).toHaveTextContent("3 ausstehende Etiketten gehen danach an „Küche (Bild)“.");
    expect(dialog).toHaveTextContent("Etiketten werden dabei nicht gelöscht.");
    // Der Fokus liegt auf der sicheren Wahl.
    expect(within(dialog).getByRole("button", { name: "Abbrechen" })).toHaveFocus();
    await userEvent.click(within(dialog).getByRole("button", { name: "Drucker löschen" }));

    await waitFor(() => expect(value(core.data.printers).map((printer) => printer.name)).toEqual(["Küche (Bild)"]));
    expect(value(core.data.zones).every((zone) => zone.printer_id === null)).toBe(true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Die Schaltfläche, die den Dialog geöffnet hat, gibt es nicht mehr: Der Fokus geht nicht verloren.
    await waitFor(() => expect(screen.getByRole("button", { name: "Drucker hinzufügen" })).toHaveFocus());
    // Die Etiketten bleiben stehen und gehen jetzt an den Standarddrucker.
    expect(value(core.data.printJobs).filter((entry) => entry.state === "pending").length).toBeGreaterThan(0);

    await userEvent.click(within(card("Küche (Bild)")).getByRole("button", { name: "Löschen: Küche (Bild)" }));
    const last = screen.getByRole("dialog", { name: "Drucker „Küche (Bild)“ löschen?" });
    expect(last).toHaveTextContent("Er ist der Standarddrucker.");
    expect(last).toHaveTextContent("Einen Standarddrucker gibt es danach nicht mehr, bis ein anderer gewählt ist.");
    // Ohne ihn hätten die ausstehenden Etiketten keinen Drucker mehr.
    expect(last).toHaveTextContent("ausstehende Etiketten bleiben stehen, bis ein Drucker zuständig ist.");
  });
});

describe("Zuordnung", () => {
  it("wählt den Standarddrucker und den Drucker je Zone und zeigt, wer am Ende druckt", async () => {
    const core = renderApp({}, ROUTES.printers);
    await ready();
    const assign = section("Zuordnung");
    expect(within(assign).getByLabelText("Standarddrucker")).toHaveValue(PRINTER_IDS.kitchen);
    const rows = within(assign).getAllByText(/^Druckt auf:/).map((hint) => hint.textContent);
    expect(rows).toEqual(["Druckt auf: Küche (Bild) (Standarddrucker)", "Druckt auf: Keller (Pi)", "Druckt auf: Küche (Bild) (Standarddrucker)", "Druckt auf: Keller (Pi)"]);

    // Der Kühlschrank bekommt den Drucker im Keller.
    await userEvent.selectOptions(within(assign).getByLabelText("Drucker für Kühlschrank"), "Keller (Pi)");
    await waitFor(() => expect(value(core.data.zones).find((zone) => zone.id === ZONE_IDS.fridge)?.printer_id).toBe(PRINTER_IDS.cellar));

    // Der Keller gibt seinen ab und nutzt wieder den Standarddrucker.
    await userEvent.selectOptions(within(assign).getByLabelText("Drucker für Keller"), "Standarddrucker (Küche (Bild))");
    await waitFor(() => expect(value(core.data.zones).find((zone) => zone.id === ZONE_IDS.cellar)?.printer_id).toBeNull());

    // Ohne Standarddrucker bleibt für Zonen ohne eigenen Drucker keiner.
    await userEvent.selectOptions(within(assign).getByLabelText("Standarddrucker"), "Kein Standarddrucker");
    await waitFor(() => expect(value(core.data.settings).default_printer_id).toBeNull());
    expect(within(assign).getAllByText("Kein Drucker: Etiketten für diese Zone bleiben ausstehend.")).toHaveLength(2);
    expect(within(assign).getByText(/Ohne Standarddrucker bleiben Etiketten ausstehend/)).toBeInTheDocument();
    expect(card("Küche (Bild)")).toHaveTextContent("noch nichts: weder Standarddrucker noch einer Zone zugeordnet");
  });

  it("kennt bei nur einer Zone keine Zuordnung je Zone", async () => {
    renderApp({ scenarios: ["single-zone"] }, ROUTES.printers);
    await ready();
    const assign = section("Zuordnung");
    expect(within(assign).getAllByRole("combobox")).toHaveLength(1);
    expect(within(assign).getByText("Druckt alle Etiketten.")).toBeInTheDocument();
    // Auch an den Karten der Drucker stehen dann keine Zonen.
    expect(card("Keller (Pi)")).toHaveTextContent("noch nichts: weder Standarddrucker noch einer Zone zugeordnet");
  });
});

describe("Verbindung prüfen", () => {
  it("fragt erst auf Wunsch ab und meldet den Pi im Obergeschoss als nicht erreichbar", async () => {
    const core = mock();
    const probe = vi.spyOn(core.printers, "probe");
    renderWith(core);
    await ready();
    expect(probe).not.toHaveBeenCalled();

    await userEvent.click(within(card("Keller (Pi)")).getByRole("button", { name: "Verbindung prüfen: Keller (Pi)" }));
    const notice = await within(card("Keller (Pi)")).findByRole("status");
    expect(notice).toHaveTextContent("Keller (Pi): Der Druckdienst antwortet auf keiner Adresse.");
    expect(notice).toHaveTextContent("Ist dieses Gerät im WLAN des Pi");
    // Eigene Etiketten stehen für ihn aus: Der Notweg wird angeboten, mit dem Hinweis, dass die App das Ergebnis nicht erfährt.
    expect(within(notice).getByRole("button", { name: "Über die Seite des Druckers drucken" })).toBeInTheDocument();
    expect(notice).toHaveTextContent("Stowly erfährt das Ergebnis nicht und fragt danach, ob gedruckt wurde.");

    await userEvent.click(within(card("Küche (Bild)")).getByRole("button", { name: "Verbindung prüfen: Küche (Bild)" }));
    expect(await within(card("Küche (Bild)")).findByText("Der Druckdienst antwortet.")).toBeInTheDocument();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("erreicht den Pi in seinem WLAN und nennt die Adresse", async () => {
    renderApp({ scenarios: ["at-pi", "offline"] }, ROUTES.printers);
    await ready();
    await userEvent.click(within(card("Keller (Pi)")).getByRole("button", { name: "Verbindung prüfen: Keller (Pi)" }));
    const notice = await within(card("Keller (Pi)")).findByRole("status");
    expect(notice).toHaveTextContent("Der Druckdienst antwortet.");
    expect(notice).toHaveTextContent("Erreicht über https://10.71.83.1:8443.");

    // Im Keller fehlt der Server: Der Drucker dort oben ist nicht zu erreichen.
    await userEvent.click(within(card("Küche (Bild)")).getByRole("button", { name: "Verbindung prüfen: Küche (Bild)" }));
    expect(await within(card("Küche (Bild)")).findByRole("status")).toHaveTextContent("Küche (Bild): Der Server ist nicht erreichbar.");
  });

  it("hat für jeden Grund einen Satz, der sagt, was zu tun ist", async () => {
    const cases: [PrinterProblem, string, string][] = [
      ["offline", "Der Server ist nicht erreichbar.", "Dieser Drucker hängt am Server."],
      ["unavailable", "Der Druckdienst des Servers läuft nicht.", "den Grund nennt sein Log"],
      ["unreachable", "Der Druckdienst antwortet auf keiner Adresse.", "Zertifikat des Pi"],
      ["permission", "Der Browser hat den Zugriff auf das lokale Netzwerk abgelehnt.", "In den Einstellungen des Browsers"],
      ["blocked", "Der Druckdienst antwortet, lässt diese App aber nicht zu.", `als erlaubter Ursprung: ${window.location.origin}`],
      ["not_verified", "Die Gegenstelle hat sich nicht als Druckdienst von Stowly ausgewiesen.", "Das Token dieses Druckers prüfen"],
      ["unknown_printer", "Der Druckdienst kennt keinen Drucker mit diesem Namen.", "Namen des Druckers im Dienst"],
      ["insecure_context", "Direktdruck geht nur über die HTTPS-Adresse.", "Stowly über seine HTTPS-Adresse öffnen"],
    ];
    for (const [problem, title, advice] of cases) {
      const base = mock();
      const core: Core = {
        ...base,
        printers: { ...base.printers, probe: async () => ({ reachable: problem === "unknown_printer", url: null, health: null, problem, error: "Rückfall des Kerns" }) },
      };
      renderWith(core);
      await ready();
      await userEvent.click(within(card("Keller (Pi)")).getByRole("button", { name: "Verbindung prüfen: Keller (Pi)" }));
      const notice = await within(card("Keller (Pi)")).findByRole("status");
      expect(notice, problem).toHaveTextContent(`Keller (Pi): ${title}`);
      expect(notice, problem).toHaveTextContent(advice);
      // Den Notweg gibt es nur dort, wo er hilft.
      const handoff = within(notice).queryByRole("button", { name: "Über die Seite des Druckers drucken" });
      expect(handoff !== null, problem).toBe(["unreachable", "permission", "insecure_context"].includes(problem));
      document.body.innerHTML = "";
    }
  });

  it("sagt, wenn es den Drucker nicht mehr gibt", async () => {
    const base = mock();
    const core: Core = {
      ...base,
      printers: {
        ...base.printers,
        probe: async () => {
          throw new CoreError("not_found", "printer gone");
        },
      },
    };
    renderWith(core);
    await ready();
    await userEvent.click(within(card("Keller (Pi)")).getByRole("button", { name: "Verbindung prüfen: Keller (Pi)" }));
    expect(await within(card("Keller (Pi)")).findByRole("alert")).toHaveTextContent("Diesen Drucker gibt es nicht mehr.");
  });
});

describe("Etiketten", () => {
  const data = createSampleData();
  const packageOf = (n: number) => data.printJobs.find((entry) => entry.id === sampleUuid(4, n))?.package_id ?? "";

  it("listet die Etiketten in jedem Zustand: zu klären, ausstehend, Verlauf", async () => {
    renderApp({}, ROUTES.printers);
    await ready();
    const labels = section("Etiketten");
    expect(within(labels).getByRole("heading", { name: "Wurde das Etikett gedruckt?" })).toBeInTheDocument();
    expect(within(labels).getByRole("heading", { name: "Ausstehend" })).toBeInTheDocument();
    expect(within(labels).getByRole("heading", { name: "Verlauf" })).toBeInTheDocument();
    expect(within(labels).getAllByRole("listitem")).toHaveLength(9);

    const unknown = labelRow(packageOf(3));
    expect(unknown).toHaveTextContent("unklar");
    expect(unknown).toHaveTextContent("Der Druck wurde mittendrin unterbrochen.");
    expect(unknown).toHaveTextContent("Keller (Pi)");

    const own = labelRow(packageOf(1));
    expect(own).toHaveTextContent("ausstehend");
    expect(own).toHaveTextContent(/angefordert vor \d+ Minuten/);
    expect(within(own).queryByRole("button", { name: /Hier drucken/ })).not.toBeInTheDocument();

    // Ein anderes Gerät hat es angefordert: anzeigen, übernehmen oder verwerfen.
    const foreign = labelRow(packageOf(6));
    expect(foreign).toHaveTextContent("Ein anderes Gerät hat dieses Etikett angefordert und druckt es, sobald es beim Drucker ist.");
    expect(foreign).toHaveTextContent("Das andere Gerät druckt es dann nicht mehr, sobald es abgeglichen hat.");
    expect(within(foreign).getByRole("button", { name: /Hier drucken/ })).toBeInTheDocument();
    expect(within(foreign).getByRole("button", { name: /Verwerfen/ })).toBeInTheDocument();

    const failed = labelRow(packageOf(4));
    expect(failed).toHaveTextContent("fehlgeschlagen");
    expect(failed).toHaveTextContent("Es sind keine Etiketten eingelegt.");
    expect(within(failed).getByRole("button", { name: /Erneut drucken/ })).toBeInTheDocument();

    expect(labelRow(packageOf(5))).toHaveTextContent("gedruckt");
    expect(within(labelRow(packageOf(5))).queryByRole("button")).not.toBeInTheDocument();
    expect(labelRow(packageOf(8))).toHaveTextContent("gesendet");
    expect(labelRow(packageOf(9))).toHaveTextContent("verworfen");
    expect(within(labelRow(packageOf(9))).getByRole("button", { name: /Erneut drucken/ })).toBeInTheDocument();
    // Am Bild-Treiber gedruckt: Das Etikett lässt sich ansehen.
    expect(within(labelRow(packageOf(7))).getByRole("button", { name: /Etikett ansehen/ })).toBeInTheDocument();
  });

  it("druckt auf Wunsch jetzt und sagt, warum es im Obergeschoss nicht geht", async () => {
    const core = mock();
    const flush = vi.spyOn(core.print, "flush");
    renderWith(core);
    await ready();
    const labels = section("Etiketten");
    expect(flush).not.toHaveBeenCalled();
    expect(labels).toHaveTextContent("kann der Browser einmal fragen, ob Stowly auf Geräte im lokalen Netzwerk zugreifen darf");
    await userEvent.click(within(labels).getByRole("button", { name: "Jetzt drucken (2)" }));

    const report = await within(labels).findByLabelText("Ergebnis des Druckversuchs");
    expect(flush).toHaveBeenCalledTimes(1);
    expect(report).toHaveTextContent("2 Etiketten stehen weiter aus.");
    expect(report).toHaveTextContent("Keller (Pi): Der Druckdienst antwortet auf keiner Adresse.");
    expect(report).toHaveTextContent("Ist dieses Gerät im WLAN des Pi");
    expect(within(report).getByRole("button", { name: "Über die Seite des Druckers drucken" })).toBeInTheDocument();
    expect(value(core.data.printJobs).filter((entry) => entry.state === "pending" && entry.device_id === DEVICE_IDS.current)).toHaveLength(2);
  });

  it("nennt im Bericht einen gelöschten Drucker, bei dem noch ein abgeschicktes Etikett hängt", async () => {
    // core.ts, printers.remove: Ein Etikett, das schon an den Drucker abgeschickt war, bleibt bei ihm.
    const base = mock();
    const core: Core = {
      ...base,
      print: {
        ...base.print,
        flush: async () => ({
          delivered: 0,
          pending: 2,
          problems: [{ printer_id: "30000000-0000-4000-8000-0000000000aa", problem: "unreachable", message: "Rückfall des Kerns" }],
        }),
      },
    };
    renderWith(core);
    await ready();
    const labels = section("Etiketten");
    await userEvent.click(within(labels).getByRole("button", { name: "Jetzt drucken (2)" }));
    const report = await within(labels).findByLabelText("Ergebnis des Druckversuchs");
    expect(report).toHaveTextContent("Gelöschter Drucker: Der Druckdienst antwortet auf keiner Adresse.");
    // Den Notweg gibt es nur zu einem Drucker, den es noch gibt.
    expect(within(report).queryByRole("button", { name: "Über die Seite des Druckers drucken" })).not.toBeInTheDocument();
  });

  it("nimmt den Bericht zurück, sobald die Etiketten doch noch gedruckt sind", async () => {
    const core = renderApp({}, ROUTES.printers);
    await ready();
    const labels = section("Etiketten");
    await userEvent.click(within(labels).getByRole("button", { name: "Jetzt drucken (2)" }));
    expect(await within(labels).findByLabelText("Ergebnis des Druckversuchs")).toHaveTextContent("2 Etiketten stehen weiter aus.");

    // Das Gerät kommt ins WLAN des Pi: Die Etiketten gehen von selbst hinaus.
    act(() => core.control.setPiReachable(true));
    await waitFor(() => expect(job(core, sampleUuid(4, 1)).state).toBe("printed"));
    await waitFor(() => expect(within(labels).queryByLabelText("Ergebnis des Druckversuchs")).not.toBeInTheDocument());
    expect(within(labels).queryByRole("button", { name: /Jetzt drucken/ })).not.toBeInTheDocument();
  });

  it("druckt im WLAN des Pi und meldet, was angekommen ist", async () => {
    const core = renderApp({ scenarios: ["at-pi"] }, ROUTES.printers);
    await ready();
    const labels = section("Etiketten");
    await userEvent.click(within(labels).getByRole("button", { name: "Jetzt drucken (2)" }));
    expect(await within(labels).findByLabelText("Ergebnis des Druckversuchs")).toHaveTextContent("2 Etiketten sind beim Drucker angekommen.");
    await waitFor(() => expect(job(core, sampleUuid(4, 1)).state).toBe("printed"));
    expect(job(core, sampleUuid(4, 2)).state).toBe("printed");
    // Das fremde Etikett stellt dieses Gerät nicht zu.
    expect(job(core, sampleUuid(4, 6)).state).toBe("pending");
    expect(within(labels).queryByRole("button", { name: /Jetzt drucken/ })).not.toBeInTheDocument();
    expect(labelRow(packageOf(1))).toHaveTextContent("gedruckt");
  });

  it("zeigt, wenn der Druck scheitert, und druckt auf Wunsch erneut: als neues Etikett", async () => {
    const core = renderApp({ scenarios: ["at-pi"] }, ROUTES.printers);
    await ready();
    core.control.setPrintOutcome("failed");
    await userEvent.click(within(section("Etiketten")).getByRole("button", { name: "Jetzt drucken (2)" }));
    await waitFor(() => expect(job(core, sampleUuid(4, 1))).toMatchObject({ state: "failed", error: "no_media" }));
    const row = labelRow(packageOf(1));
    expect(row).toHaveTextContent("Es sind keine Etiketten eingelegt.");

    core.control.setPrintOutcome("printed");
    const before = value(core.data.printJobs).length;
    await userEvent.click(within(row).getByRole("button", { name: /Erneut drucken/ }));
    await waitFor(() => expect(value(core.data.printJobs)).toHaveLength(before + 1));
    // Das alte bleibt, wie es ist; das neue wird gedruckt.
    expect(job(core, sampleUuid(4, 1)).state).toBe("failed");
    const fresh = value(core.data.printJobs).find((entry) => entry.package_id === packageOf(1) && entry.id !== sampleUuid(4, 1));
    await waitFor(() => expect(job(core, fresh?.id ?? "").state).toBe("printed"));
    expect(await screen.findByText("Neues Etikett angefordert")).toBeInTheDocument();
  });

  it("fragt bei unklarem Ausgang nach: Ja vermerkt es als gedruckt", async () => {
    const core = renderApp({}, ROUTES.printers);
    await ready();
    const row = labelRow(packageOf(3));
    await userEvent.click(within(row).getByRole("button", { name: /^Ja, gedruckt/ }));
    await waitFor(() => expect(job(core, sampleUuid(4, 3))).toMatchObject({ state: "printed", error: null }));
    expect(within(section("Etiketten")).queryByRole("heading", { name: "Wurde das Etikett gedruckt?" })).not.toBeInTheDocument();
    expect(labelRow(packageOf(3))).toHaveTextContent("gedruckt");
  });

  it("bietet nach einem Nein an, erneut zu drucken", async () => {
    const core = renderApp({}, ROUTES.printers);
    await ready();
    await userEvent.click(within(labelRow(packageOf(3))).getByRole("button", { name: /^Nein, nicht gedruckt/ }));
    await waitFor(() => expect(job(core, sampleUuid(4, 3))).toMatchObject({ state: "failed", error: "not_printed" }));
    const row = labelRow(packageOf(3));
    expect(row).toHaveTextContent("Auf Nachfrage als nicht gedruckt vermerkt.");

    // Zweimal angeboten: in der Meldung und an der Zeile.
    const before = value(core.data.printJobs).length;
    await userEvent.click(screen.getByRole("button", { name: "Erneut drucken" }));
    await waitFor(() => expect(value(core.data.printJobs)).toHaveLength(before + 1));
    expect(value(core.data.printJobs).filter((entry) => entry.package_id === packageOf(3) && entry.state === "pending")).toHaveLength(1);
    expect(within(row).getByRole("button", { name: /Erneut drucken/ })).toBeInTheDocument();
  });

  it("führt den Fokus weiter, wenn eine Antwort die Zeile wegräumt", async () => {
    const jobs = data.printJobs.map((entry) => (entry.id === sampleUuid(4, 1) || entry.id === sampleUuid(4, 2) ? { ...entry, state: "unknown" as const, error: "handoff" } : entry));
    const core = renderApp({ data: { printJobs: jobs } }, ROUTES.printers);
    await ready();
    // Ja: weiter zur nächsten Nachfrage, und zwar an die Zeile selbst. Ein zweites Enter beantwortet so nichts.
    const asking = within(section("Etiketten")).getByRole("heading", { name: "Wurden diese Etiketten gedruckt?" }).closest("div")?.parentElement as HTMLElement;
    const first = within(asking).getAllByRole("listitem")[0];
    await userEvent.click(within(first as HTMLElement).getByRole("button", { name: /^Ja, gedruckt/ }));
    await waitFor(() => expect(value(core.data.printJobs).filter((entry) => entry.state === "unknown")).toHaveLength(2));
    await waitFor(() => expect(document.activeElement?.tagName).toBe("LI"));
    expect(within(document.activeElement as HTMLElement).getByRole("button", { name: /^Ja, gedruckt/ })).toBeInTheDocument();
    // Nein: weiter zu „Erneut drucken“ an derselben Packung.
    await userEvent.click(within(labelRow(packageOf(2))).getByRole("button", { name: /^Nein, nicht gedruckt/ }));
    await waitFor(() => expect(job(core, sampleUuid(4, 2)).state).toBe("failed"));
    await waitFor(() => expect(within(labelRow(packageOf(2))).getByRole("button", { name: /^Erneut drucken/ })).toHaveFocus());
  });

  it("lässt den Fokus nach „Verwerfen“ und „Hier drucken“ bei den ausstehenden Etiketten, nicht an „Erneut drucken“", async () => {
    const core = renderApp({}, ROUTES.printers);
    await ready();
    await userEvent.click(within(labelRow(packageOf(6))).getByRole("button", { name: /^Hier drucken/ }));
    await waitFor(() => expect(job(core, sampleUuid(4, 6)).state).toBe("cancelled"));
    await waitFor(() => expect(document.activeElement?.tagName).toBe("LI"));
    expect(document.activeElement?.closest('[data-group="waiting"]')).not.toBeNull();

    await userEvent.click(within(labelRow(packageOf(1))).getByRole("button", { name: /^Verwerfen/ }));
    await waitFor(() => expect(job(core, sampleUuid(4, 1)).state).toBe("cancelled"));
    await waitFor(() => expect(document.activeElement?.tagName).toBe("LI"));
    expect(document.activeElement?.closest('[data-group="waiting"]')).not.toBeNull();
  });

  it("klärt mehrere unklare Etiketten auf einmal", async () => {
    const jobs = data.printJobs.map((entry) => (entry.id === sampleUuid(4, 1) || entry.id === sampleUuid(4, 2) ? { ...entry, state: "unknown" as const, error: "handoff" } : entry));
    const core = renderApp({ data: { printJobs: jobs } }, ROUTES.printers);
    await ready();
    const labels = section("Etiketten");
    expect(within(labels).getByRole("heading", { name: "Wurden diese Etiketten gedruckt?" })).toBeInTheDocument();
    expect(labels).toHaveTextContent("An die Seite des Druckers übergeben; die App kennt den Ausgang nicht.");
    await userEvent.click(within(labels).getByRole("button", { name: "Alle gedruckt" }));
    await waitFor(() => expect(value(core.data.printJobs).filter((entry) => entry.state === "unknown")).toHaveLength(0));
    expect(job(core, sampleUuid(4, 1)).state).toBe("printed");
    expect(await screen.findByText("3 Etiketten als gedruckt vermerkt")).toBeInTheDocument();
  });

  it("übernimmt ein ausstehendes Etikett eines anderen Geräts", async () => {
    const core = renderApp({}, ROUTES.printers);
    await ready();
    const before = value(core.data.printJobs).length;
    await userEvent.click(within(labelRow(packageOf(6))).getByRole("button", { name: /Hier drucken/ }));
    await waitFor(() => expect(job(core, sampleUuid(4, 6)).state).toBe("cancelled"));
    const jobs = value(core.data.printJobs);
    expect(jobs).toHaveLength(before + 1);
    expect(jobs.find((entry) => entry.package_id === packageOf(6) && entry.state === "pending")?.device_id).toBe(DEVICE_IDS.current);
    expect(await screen.findByText("Übernommen: Dieses Gerät druckt das Etikett jetzt.")).toBeInTheDocument();
    expect(within(section("Etiketten")).getByRole("button", { name: "Jetzt drucken (3)" })).toBeInTheDocument();
  });

  it("verwirft ein ausstehendes Etikett", async () => {
    const core = renderApp({}, ROUTES.printers);
    await ready();
    await userEvent.click(within(labelRow(packageOf(1))).getByRole("button", { name: /Verwerfen/ }));
    await waitFor(() => expect(job(core, sampleUuid(4, 1)).state).toBe("cancelled"));
    expect(within(section("Etiketten")).getByRole("button", { name: "Jetzt drucken (1)" })).toBeInTheDocument();
    expect(labelRow(packageOf(1))).toHaveTextContent("verworfen");
  });

  it("bietet „Jetzt drucken“ nicht an, solange kein eigenes Etikett einen Drucker hat", async () => {
    const zones = data.zones.map((zone) => ({ ...zone, printer_id: null }));
    const jobs = data.printJobs.map((entry) => (entry.state === "pending" ? { ...entry, printer_id: null } : entry));
    renderApp({ data: { zones, printJobs: jobs, settings: { ...data.settings, default_printer_id: null } } }, ROUTES.printers);
    await ready();
    expect(labelRow(packageOf(1))).toHaveTextContent("kein Drucker zugeordnet");
    expect(labelRow(packageOf(2))).toHaveTextContent("kein Drucker zugeordnet");
    expect(within(section("Etiketten")).queryByRole("button", { name: /Jetzt drucken/ })).not.toBeInTheDocument();
  });

  it("sagt, wenn ein Etikett keinen Drucker hat, und führt zur Zuordnung", async () => {
    const zones = data.zones.map((zone) => ({ ...zone, printer_id: null }));
    // Eines der beiden eigenen Etiketten verliert seinen Drucker, das andere behält ihn.
    const jobs = data.printJobs.map((entry) => (entry.id === sampleUuid(4, 1) ? { ...entry, printer_id: null } : entry));
    const core = mock({ data: { zones, printJobs: jobs, settings: { ...data.settings, default_printer_id: null } } });
    renderWith(core);
    await ready();
    const row = labelRow(packageOf(1));
    expect(row).toHaveTextContent("kein Drucker zugeordnet");
    expect(row).toHaveTextContent("Das Etikett bleibt stehen, bis es einen Standarddrucker oder einen Drucker für die Zone gibt.");
    expect(within(row).getByRole("button", { name: "Zur Zuordnung" })).toBeInTheDocument();

    // Gezählt wird nur, was sich drucken lässt.
    await userEvent.click(within(section("Etiketten")).getByRole("button", { name: "Jetzt drucken (1)" }));
    const report = await within(section("Etiketten")).findByLabelText("Ergebnis des Druckversuchs");
    expect(report).toHaveTextContent("Dem Etikett ist kein Drucker zugeordnet.");
    expect(report).toHaveTextContent("Einen Standarddrucker wählen oder der Zone einen Drucker zuordnen.");
    expect(within(report).getByRole("button", { name: "Zur Zuordnung" })).toBeInTheDocument();
  });

  it("zeigt das Bild eines Etiketts, das der Bild-Treiber geschrieben hat, und sagt offline, dass der Server fehlt", async () => {
    const core = renderApp({}, ROUTES.printers);
    await ready();
    await userEvent.click(within(labelRow(packageOf(7))).getByRole("button", { name: /Etikett ansehen/ }));
    const dialog = screen.getByRole("dialog", { name: "Gedrucktes Etikett" });
    const image = await within(dialog).findByRole("img", { name: "Etikett: Basmati Reis" });
    expect(image).toHaveAttribute("src", expect.stringMatching(/^blob:/));
    expect(dialog).toHaveTextContent("So hat der Drucker „Küche (Bild)“ das Etikett geschrieben.");
    await userEvent.click(within(dialog).getAllByRole("button", { name: "Schließen" })[1] as HTMLElement);

    core.control.setOnline(false);
    await userEvent.click(within(labelRow(packageOf(7))).getByRole("button", { name: /Etikett ansehen/ }));
    const offline = screen.getByRole("dialog", { name: "Gedrucktes Etikett" });
    expect(await within(offline).findByText("Das Bild liegt beim Server, und der ist gerade nicht erreichbar.")).toBeInTheDocument();
    expect(within(offline).queryByRole("alert")).not.toBeInTheDocument();
    // Der Server ist wieder da: Das Bild kommt von selbst.
    core.control.setOnline(true);
    expect(await within(offline).findByRole("img", { name: "Etikett: Basmati Reis" })).toBeInTheDocument();
  });

  it("zeigt ältere Etiketten erst auf Wunsch", async () => {
    const pkg = data.packages[0];
    const many: PrintJob[] = Array.from({ length: 30 }, (_, index) => ({
      id: sampleUuid(8, index + 1),
      kind: "package" as const,
      package_id: pkg?.id ?? null,
      zone_id: null,
      printer_id: PRINTER_IDS.kitchen,
      state: "printed" as const,
      error: null,
      boot_id: "server",
      device_id: DEVICE_IDS.current,
      created_at: new Date(Date.now() - (index + 1) * 3_600_000).toISOString(),
      updated_at: new Date(Date.now() - (index + 1) * 3_600_000).toISOString(),
    }));
    renderApp({ data: { printJobs: many } }, ROUTES.printers);
    await ready();
    const labels = section("Etiketten");
    expect(within(labels).getAllByRole("listitem")).toHaveLength(12);
    await userEvent.click(within(labels).getByRole("button", { name: "18 ältere Etiketten zeigen" }));
    expect(within(labels).getAllByRole("listitem")).toHaveLength(30);
  });

  it("bleibt am Handy bedienbar", async () => {
    setTestViewport(375);
    const core = renderApp({}, ROUTES.printers);
    await ready();
    await userEvent.click(within(labelRow(packageOf(3))).getByRole("button", { name: /^Ja, gedruckt/ }));
    await waitFor(() => expect(job(core, sampleUuid(4, 3)).state).toBe("printed"));
    expect(within(card("Keller (Pi)")).getByRole("button", { name: "Verbindung prüfen: Keller (Pi)" })).toBeInTheDocument();
  });
});

describe("Notweg über die Seite des Druckers", () => {
  it("öffnet die Seite unmittelbar im Klick, übergibt die Etiketten und fragt danach, ob gedruckt wurde", async () => {
    const replace = vi.fn();
    const tab = { opener: {} as unknown, location: { replace }, close: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    const core = mock();
    const handoff = vi.spyOn(core.print, "handoff");
    renderWith(core);
    await ready();
    await userEvent.click(within(card("Keller (Pi)")).getByRole("button", { name: "Verbindung prüfen: Keller (Pi)" }));
    const notice = await within(card("Keller (Pi)")).findByRole("status");
    await userEvent.click(within(notice).getByRole("button", { name: "Über die Seite des Druckers drucken" }));

    // Das Fenster entsteht vor dem Aufruf des Kerns, sonst blockt der Browser es.
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(open.mock.invocationCallOrder[0]).toBeLessThan(handoff.mock.invocationCallOrder[0] ?? 0);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("http://10.71.83.1:8080/p#attrappe-2"));
    expect(tab.opener).toBeNull();
    expect(await screen.findByText(/2 Etiketten an die Seite des Druckers übergeben\. Stowly fragt danach, ob gedruckt wurde\./)).toBeInTheDocument();
    expect(job(core, sampleUuid(4, 1))).toMatchObject({ state: "unknown", error: "handoff" });
    expect(within(section("Etiketten")).getByRole("heading", { name: "Wurden diese Etiketten gedruckt?" })).toBeInTheDocument();
  });

  it("zeigt die Adresse als Verweis, wenn der Browser das neue Fenster blockiert", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const core = mock();
    renderWith(core);
    await ready();
    await userEvent.click(within(section("Etiketten")).getByRole("button", { name: "Jetzt drucken (2)" }));
    const report = await within(section("Etiketten")).findByLabelText("Ergebnis des Druckversuchs");
    await userEvent.click(within(report).getByRole("button", { name: "Über die Seite des Druckers drucken" }));
    const link = await screen.findByRole("link", { name: "Seite des Druckers öffnen" });
    expect(link).toHaveAttribute("href", "http://10.71.83.1:8080/p#attrappe-2");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("schließt das Fenster wieder, wenn nichts zu übergeben ist, und sagt mit dem Satz des Kerns, warum", async () => {
    // Der Kern übergibt nur nie abgeschickte Etiketten (core.ts, `print.handoff`); warum nichts übrig
    // bleibt, weiß nur er: Die Oberfläche zeigt bei "not_found" seinen Satz.
    const reasons = [
      "Für diesen Drucker steht kein eigenes Etikett aus.",
      "Die ausstehenden Etiketten dieses Druckers sind vielleicht schon beim Drucker angekommen und gehen deshalb nicht über die Seite des Druckdienstes.",
    ];
    for (const reason of reasons) {
      const tab = { opener: {} as unknown, location: { replace: vi.fn() }, close: vi.fn() };
      vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
      const base = mock();
      const core: Core = {
        ...base,
        print: {
          ...base.print,
          handoff: async () => {
            throw new CoreError("not_found", reason);
          },
        },
      };
      renderWith(core);
      await ready();
      await userEvent.click(within(card("Keller (Pi)")).getByRole("button", { name: "Verbindung prüfen: Keller (Pi)" }));
      const notice = await within(card("Keller (Pi)")).findByRole("status");
      await userEvent.click(within(notice).getByRole("button", { name: "Über die Seite des Druckers drucken" }));
      expect(await screen.findByText(reason)).toBeInTheDocument();
      expect(tab.close).toHaveBeenCalledTimes(1);
      expect(tab.location.replace).not.toHaveBeenCalled();
      cleanup();
    }
  });
});
