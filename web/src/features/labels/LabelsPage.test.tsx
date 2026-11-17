/**
 * Etiketten gestalten auf der Attrappe (docs/plan-0.5.md, 1): Formular, Reihenfolge, entprellte
 * Vorschau, Sätze des Servers, ohne Server, Probedruck und Hinweise je Drucker.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CoreError, ROUTES, type Core, type LabelPreview, type LabelPreviewInput, type LabelTemplatesInfo } from "@/contract";
import { App } from "@/app/App";
import { renderApp } from "@/app/render.test-setup";
import { createMockCore, MockScanPage, type MockCore, type MockOptions } from "@/mock";

function mock(options: MockOptions = {}): MockCore {
  return createMockCore({ latency: 0, ...options });
}

function renderWith(core: Core): void {
  window.history.replaceState(null, "", ROUTES.labels);
  render(<App core={core} scanPage={MockScanPage} />);
}

async function ready(): Promise<void> {
  await screen.findByRole("heading", { name: "Etiketten gestalten", level: 1 });
  await screen.findByLabelText("Papier für alle Drucker");
}

/** Die Felder in der Reihenfolge der Liste, eingeschaltete mit „+". */
function fieldOrder(): string[] {
  return within(screen.getByRole("list", { name: "Felder" }))
    .getAllByRole("listitem")
    .map((item) => `${within(item).getByRole("switch").getAttribute("aria-checked") === "true" ? "+" : "-"}${item.dataset.field ?? ""}`);
}

function button(name: string): HTMLElement {
  return screen.getByRole("button", { name });
}

function isLocked(element: HTMLElement): boolean {
  return element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Etiketten gestalten", () => {
  it("zeigt Papier, Reiter und die Felder der Gestaltung", async () => {
    renderApp({}, ROUTES.labels);
    await ready();
    expect(screen.getByLabelText("Papier für alle Drucker")).toHaveDisplayValue("62 mm endlos");
    expect(screen.getByLabelText("Länge in mm")).toHaveValue("29");
    expect(fieldOrder()).toEqual(["+title", "+subtitle", "+best_before", "+id", "+stored", "-quantity", "-brand", "-zone", "-text"]);
    // Der Name hat Zeilen, die anderen Felder nicht.
    expect(screen.getByLabelText("Zeilen: Produktname")).toHaveDisplayValue("2 Zeilen");
    expect(screen.queryByLabelText("Zeilen: MHD")).not.toBeInTheDocument();
    expect(screen.getByText("Es gelten die mitgelieferten Etiketten.")).toBeInTheDocument();

    // Der Reiter „Zone" zeigt die Felder eines Zonen-Etiketts.
    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Etikettenart" })).getByRole("radio", { name: "Zone" }));
    expect(fieldOrder()).toEqual(["+title", "+subtitle", "-text"]);
    expect(screen.getByRole("heading", { name: "Zonen-Etikett" })).toBeInTheDocument();
    // Ohne Datum auf dem Zonen-Etikett.
    expect(screen.queryByRole("radiogroup", { name: "Datum" })).not.toBeInTheDocument();
  });

  it("ordnet Felder mit Pfeilen, schaltet sie an und aus und speichert für den ganzen Haushalt", async () => {
    const core = renderApp({}, ROUTES.labels);
    const save = vi.spyOn(core.labels, "save");
    await ready();
    expect(isLocked(button("Speichern"))).toBe(true);

    await userEvent.click(button("Nach unten: Produktname"));
    expect(fieldOrder().slice(0, 2)).toEqual(["+subtitle", "+title"]);
    // Ganz oben gibt es kein „nach oben", ganz unten kein „nach unten".
    expect(isLocked(button("Nach oben: Größe · Marke"))).toBe(true);
    expect(isLocked(button("Nach unten: Eingelagert am"))).toBe(true);

    await userEvent.click(screen.getByRole("switch", { name: "Marke" }));
    expect(fieldOrder()).toContain("+brand");
    expect(fieldOrder().indexOf("+brand")).toBe(5);
    await userEvent.click(screen.getByRole("switch", { name: "MHD" }));
    expect(fieldOrder()).toContain("-best_before");
    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Größe: Packungs-ID" })).getByRole("radio", { name: "klein" }));
    await userEvent.selectOptions(screen.getByLabelText("Zeilen: Produktname"), "3 Zeilen");
    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Seite des QR-Codes" })).getByRole("radio", { name: "rechts" }));
    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Datum" })).getByRole("radio", { name: "kurz (25.03.27)" }));
    await userEvent.type(screen.getByLabelText("Inhalt des eigenen Texts"), "Vorrat Oma");

    await userEvent.click(button("Speichern"));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const design = save.mock.calls[0]?.[0];
    expect(design?.package).toMatchObject({
      qr: { side: "right", size: "m" },
      date: "short",
      text: "Vorrat Oma",
      fields: [
        { field: "subtitle", size: "m" },
        { field: "title", size: "m", lines: 3 },
        { field: "id", size: "s" },
        { field: "stored", size: "s" },
        { field: "brand", size: "s", lines: null },
      ],
    });
    expect(await screen.findByText(/Gestaltung gespeichert\. Alle Geräte bekommen die neue Vorlage/)).toBeInTheDocument();
    expect(screen.getByText("Eigene Gestaltung des Haushalts.")).toBeInTheDocument();
    expect(isLocked(button("Speichern"))).toBe(true);
    // Der Server kennt sie jetzt.
    expect((await core.labels.design()).design.package.text).toBe("Vorrat Oma");
  });

  it("fragt die Länge nur bei Endlosrollen; gestanzte Etiketten haben ihre feste Länge", async () => {
    const core = renderApp({}, ROUTES.labels);
    const save = vi.spyOn(core.labels, "save");
    await ready();
    await userEvent.selectOptions(screen.getByLabelText("Papier für alle Drucker"), "62 × 29 mm gestanzt");
    expect(screen.queryByLabelText("Länge in mm")).not.toBeInTheDocument();
    expect(screen.getByText("Gestanzte Etiketten haben eine feste Länge.")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Papier für alle Drucker"), "29 mm endlos");
    expect(screen.getByLabelText("Länge in mm")).toHaveValue("29");
    await userEvent.click(button("Speichern"));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]?.[0]).toMatchObject({ paper: "29", package: { length_mm: 29 }, zone: { length_mm: 29 } });
  });

  it("zeichnet die Vorschau erst 300 ms nach der letzten Änderung, höchstens zwei zugleich, mit Hinweisen", async () => {
    const base = mock();
    const asked: LabelPreviewInput[] = [];
    const answers: ((preview: LabelPreview) => void)[] = [];
    let open = 0;
    let mostOpen = 0;
    const core: Core = {
      ...base,
      labels: {
        ...base.labels,
        preview: (input) => {
          asked.push(input);
          open += 1;
          mostOpen = Math.max(mostOpen, open);
          return new Promise<LabelPreview>((resolve) => {
            answers.push((preview) => {
              open -= 1;
              resolve(preview);
            });
          });
        },
      },
    };
    const reply = (index: number, notes: string[] = []) => answers[index]?.({ png: "iVBORw0KGgo=", width_px: 696, height_px: 342, notes });
    renderWith(core);
    await ready();
    // Die erste Vorschau: das Beispiel mit langem Namen.
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]).toMatchObject({ kind: "package", paper: "62", data: null });

    // Schnelles Tippen: eine Anfrage, nach der letzten Änderung.
    await userEvent.type(screen.getByLabelText("Inhalt des eigenen Texts"), "Vorrat");
    await waitFor(() => expect(asked).toHaveLength(2));
    expect(asked[1]?.layout.text).toBe("Vorrat");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(asked).toHaveLength(2);

    // Beide laufen noch: Die dritte wartet, bis eine fertig ist, und fragt dann nach dem neuesten Stand.
    await userEvent.type(screen.getByLabelText("Inhalt des eigenen Texts"), "!");
    await new Promise((resolve) => setTimeout(resolve, 400));
    await userEvent.type(screen.getByLabelText("Inhalt des eigenen Texts"), "?");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(asked).toHaveLength(2);
    reply(0);
    await waitFor(() => expect(asked).toHaveLength(3));
    expect(asked[2]?.layout.text).toBe("Vorrat!?");
    expect(mostOpen).toBe(2);

    // Eine ältere Antwort überschreibt keine neuere; die Hinweise stehen unter der Vorschau.
    reply(2, ["Name auf 3,0 mm verkleinert und gekürzt."]);
    expect(await screen.findByRole("list", { name: "Hinweise zur Vorschau" })).toHaveTextContent("Name auf 3,0 mm verkleinert und gekürzt.");
    reply(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole("list", { name: "Hinweise zur Vorschau" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Vorschau des Packungs-Etiketts" })).toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgo=");
  });

  it("zeigt den Satz des Servers, wenn die Gestaltung nicht passt: in der Vorschau und beim Speichern", async () => {
    renderApp({}, ROUTES.labels);
    await ready();
    // 25 mm lang, und alles groß: zu voll.
    const length = screen.getByLabelText("Länge in mm");
    await userEvent.clear(length);
    await userEvent.type(length, "25");
    await userEvent.tab();
    for (const name of ["Packungsgröße", "Marke", "Zone"]) {
      await userEvent.click(screen.getByRole("switch", { name }));
    }
    const sentence = "Für so viele Felder ist das Etikett zu kurz: ein Feld weglassen, kleiner wählen oder länger machen.";
    expect(await screen.findByText(sentence, {}, { timeout: 2000 })).toBeInTheDocument();
    await userEvent.click(button("Speichern"));
    expect(await screen.findByRole("alert")).toHaveTextContent(sentence);
    // Verwerfen holt den gespeicherten Stand zurück.
    await userEvent.click(button("Verwerfen"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Länge in mm")).toHaveValue("29");
    expect(fieldOrder()).toEqual(["+title", "+subtitle", "+best_before", "+id", "+stored", "-quantity", "-brand", "-zone", "-text"]);
  });

  it("zeigt beim Papierwechsel, was nicht passt, und wechselt beim Speichern zur betroffenen Etikettenart", async () => {
    const core = renderApp({}, ROUTES.labels);
    await ready();
    // Mit der Vorgabe passt der QR-Code nicht auf 62 × 29 mm gestanzt (dort sind knapp 23 mm bedruckbar).
    await userEvent.selectOptions(screen.getByLabelText("Papier für alle Drucker"), "62 × 29 mm gestanzt");
    const qrSentence = "Der QR-Code ist für dieses Etikett zu groß: kleiner wählen oder ein größeres Papier nehmen.";
    expect(await screen.findByText(qrSentence, {}, { timeout: 2000 })).toBeInTheDocument();
    // Das alte Bild passt nicht mehr dazu: Es steht nicht mehr da.
    expect(screen.queryByRole("img", { name: "Vorschau des Packungs-Etiketts" })).not.toBeInTheDocument();

    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Größe des QR-Codes" })).getByRole("radio", { name: "klein" }));
    await userEvent.click(screen.getByRole("switch", { name: "Größe · Marke" }));
    expect(await screen.findByRole("img", { name: "Vorschau des Packungs-Etiketts" }, { timeout: 2000 })).toBeInTheDocument();
    // Gespeichert wird beides: Am Zonen-Etikett ist der QR-Code noch zu groß. Die Seite wechselt dorthin.
    await userEvent.click(button("Speichern"));
    expect(await screen.findByRole("alert")).toHaveTextContent(`Zonen-Etikett: ${qrSentence}`);
    expect(within(screen.getByRole("radiogroup", { name: "Etikettenart" })).getByRole("radio", { name: "Zone" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Größe des QR-Codes" })).getByRole("radio", { name: "klein" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await userEvent.click(button("Speichern"));
    expect(await screen.findByText(/Gestaltung gespeichert/)).toBeInTheDocument();
    expect((await core.labels.design()).design).toMatchObject({ paper: "62x29", package: { length_mm: null, qr: { size: "s" } }, zone: { qr: { size: "s" } } });
  });

  it("bleibt ohne Server lesbar; Vorschau und Speichern brauchen ihn", async () => {
    const core = renderApp({}, ROUTES.labels);
    await ready();
    core.control.setOnline(false);
    expect(await screen.findByText("Ohne Verbindung zum Server")).toBeInTheDocument();
    await userEvent.click(button("Nach unten: Produktname"));
    expect(isLocked(button("Speichern"))).toBe(true);
    expect(screen.getByText("Speichern geht, sobald der Server wieder erreichbar ist.")).toBeInTheDocument();
    expect(screen.getByText("Die Vorschau zeichnet der Server, und der ist gerade nicht erreichbar.")).toBeInTheDocument();
    expect(isLocked(button("Auf Vorgabe zurücksetzen"))).toBe(true);
    // Der Server ist zurück: Speichern geht wieder, das Ungespeicherte ist noch da.
    core.control.setOnline(true);
    await waitFor(() => expect(isLocked(button("Speichern"))).toBe(false));
    expect(fieldOrder().slice(0, 2)).toEqual(["+subtitle", "+title"]);
  });

  it("sagt beim Öffnen ohne Server, wo die Gestaltung liegt, und nennt das Papier laut den Vorlagen", async () => {
    const core = renderApp({ scenarios: ["offline", "labels-die-cut"] }, ROUTES.labels);
    expect(await screen.findByText("Die Gestaltung liegt beim Server, und der ist gerade nicht erreichbar.")).toBeInTheDocument();
    expect(await screen.findByText(/Papier für alle Drucker laut den Vorlagen auf diesem Gerät: 62 × 29 mm gestanzt\./)).toBeInTheDocument();
    // Der Server ist zurück: Die Seite lädt von selbst.
    core.control.setOnline(true);
    await ready();
    expect(screen.getByLabelText("Papier für alle Drucker")).toHaveDisplayValue("62 × 29 mm gestanzt");
  });

  it("bietet den Probedruck erst an, wenn alles gespeichert und die neue Vorlage da ist, und nur für eine echte Packung", async () => {
    const base = mock();
    let synced: LabelTemplatesInfo | null = null;
    const core: Core = { ...base, labels: { ...base.labels, templates: async () => synced ?? base.labels.templates() } };
    const request = vi.spyOn(base.print, "requestPackageLabels");
    renderWith(core);
    await ready();
    expect(isLocked(button("Probedruck"))).toBe(true);
    expect(screen.getByText("Für einen Probedruck oben eine Packung aus dem Bestand wählen.")).toBeInTheDocument();

    const content = screen.getByLabelText("Inhalt der Vorschau");
    const option = within(content)
      .getAllByRole("option")
      .find((entry) => entry.textContent?.startsWith("Basmati Reis"));
    await userEvent.selectOptions(content, option?.getAttribute("value") ?? "");
    await waitFor(() => expect(isLocked(button("Probedruck"))).toBe(false));
    await userEvent.click(button("Probedruck"));
    await waitFor(() => expect(request).toHaveBeenCalledWith([option?.getAttribute("value")]));
    expect(await screen.findByText(/Probedruck angefordert/)).toBeInTheDocument();

    // Geändert: erst speichern.
    await userEvent.click(button("Nach unten: Produktname"));
    expect(isLocked(button("Probedruck"))).toBe(true);
    expect(screen.getByText("Probedruck geht nach dem Speichern.")).toBeInTheDocument();

    // Gespeichert, aber der Abgleich hat die neue Vorlage noch nicht gebracht.
    synced = await base.labels.templates();
    await userEvent.click(button("Speichern"));
    expect(await screen.findByText("Die neue Vorlage kommt mit dem nächsten Abgleich; danach geht der Probedruck.")).toBeInTheDocument();
    expect(isLocked(button("Probedruck"))).toBe(true);
    synced = null;
    await base.sync.now();
    await waitFor(() => expect(isLocked(button("Probedruck"))).toBe(false));
  });

  it("setzt auf die Vorgabe zurück, nach Rückfrage", async () => {
    const core = renderApp({ scenarios: ["labels-custom"] }, ROUTES.labels);
    await ready();
    expect(screen.getByLabelText("Länge in mm")).toHaveValue("50");
    expect(screen.getByText("Eigene Gestaltung des Haushalts.")).toBeInTheDocument();
    await userEvent.click(button("Auf Vorgabe zurücksetzen"));
    const dialog = screen.getByRole("dialog", { name: "Auf Vorgabe zurücksetzen?" });
    expect(dialog).toHaveTextContent("Die eigene Gestaltung geht dabei verloren.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Zurücksetzen" }));
    expect(await screen.findByText("Es gelten wieder die mitgelieferten Etiketten.")).toBeInTheDocument();
    expect(screen.getByLabelText("Länge in mm")).toHaveValue("29");
    expect((await core.labels.design()).is_default).toBe(true);
  });

  it("sagt je Drucker, wenn das Papier nicht passt: alter Druckdienst, andere Rolle", async () => {
    renderApp({ scenarios: ["pi-outdated"] }, ROUTES.labels);
    await ready();
    expect(screen.getByLabelText("Papier für alle Drucker")).toHaveDisplayValue("29 mm endlos");
    const drucker = screen.getByRole("region", { name: "Drucker" });
    expect(drucker).toHaveTextContent("Keller (Pi): Der Druckdienst 0.4.0 kann nur 62 mm endlos. Neu koppeln aktualisiert ihn.");
    expect(within(drucker).getByRole("link", { name: "Zu den Druckern" })).toHaveAttribute("href", ROUTES.printers);
    // Mit der 62-mm-Rolle bis 62 mm Länge kann es auch der alte Dienst: kein Hinweis.
    await userEvent.selectOptions(screen.getByLabelText("Papier für alle Drucker"), "62 mm endlos");
    expect(drucker).not.toHaveTextContent("Druckdienst 0.4.0");
  });

  it("prüft auf Wunsch die eingelegten Rollen", async () => {
    const core = renderApp({ scenarios: ["labels-die-cut", "at-pi"] }, ROUTES.labels);
    const probe = vi.spyOn(core.printers, "probe");
    await ready();
    const drucker = screen.getByRole("region", { name: "Drucker" });
    expect(drucker).not.toHaveTextContent("Eingelegt ist");
    await userEvent.click(within(drucker).getByRole("button", { name: "Eingelegte Rollen prüfen" }));
    await waitFor(() => expect(drucker).toHaveTextContent("Keller (Pi): Eingelegt ist 62 mm endlos."));
    expect(probe).toHaveBeenCalledTimes(2);
    // Mit dem passenden Papier: alles gut.
    await userEvent.selectOptions(screen.getByLabelText("Papier für alle Drucker"), "62 mm endlos");
    expect(drucker).toHaveTextContent("Die geprüften Drucker passen zu diesem Papier.");
  });

  it("meldet einen Fehler beim Laden mit dem Satz des Kerns", async () => {
    const base = mock();
    const core: Core = {
      ...base,
      labels: {
        ...base.labels,
        design: async () => {
          throw new CoreError("not_supported", "Dieser Server kennt die Gestaltung noch nicht.");
        },
      },
    };
    renderWith(core);
    expect(await screen.findByText("Dieser Server kennt die Gestaltung noch nicht.")).toBeInTheDocument();
  });
});
