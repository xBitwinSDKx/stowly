/**
 * Lösch-Historie auf der Attrappe: anzeigen, wiederherstellen (einzeln, mehrere),
 * verdrängte Bearbeitung übernehmen, Grund nachträglich ändern.
 */
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { addDays, formatDate, formatTimestamp, productTitle, ROUTES, todayLocal, type Live, type Package } from "@/contract";
import { renderApp } from "@/app/render.test-setup";
import { createSampleData, sampleUuid, ZONE_IDS } from "@/mock";
import { setTestViewport } from "@/ui/testing";

import { displacedLines } from "./model";

function value<T>(live: Live<T>): T {
  const current = live.get();
  if (current === undefined) {
    throw new Error("Live-Wert ist noch nicht geladen");
  }
  return current;
}

async function ready(): Promise<void> {
  await screen.findByRole("heading", { name: "Lösch-Historie" });
}

function rowOf(id: string): HTMLElement {
  const row = screen.getByRole("button", { name: `Wiederherstellen: ${id}` }).closest("tr");
  if (!row) {
    throw new Error(`Zeile ${id} fehlt`);
  }
  return row;
}

describe("displacedLines", () => {
  const data = createSampleData();
  const pkg = { best_before: "2026-11-22", zone_id: ZONE_IDS.cellar, product_id: sampleUuid(2, 1) };

  it("beschreibt je Feld, was die Packung hat und was die Bearbeitung wollte", () => {
    const lines = displacedLines(
      pkg,
      {
        at: "2026-11-04T14:05:00.000Z",
        changes: [
          { field: "product_id", value: sampleUuid(2, 2) },
          { field: "zone_id", value: ZONE_IDS.fridge },
          { field: "best_before", value: "2026-12-23" },
        ],
      },
      data.products,
      data.zones,
    );
    // immer in derselben Reihenfolge: MHD, Zone, Produkt
    expect(lines).toEqual([
      { field: "best_before", label: "MHD", from: "22.11.2026", to: "23.12.2026" },
      { field: "zone_id", label: "Zone", from: "Keller", to: "Kühlschrank" },
      { field: "product_id", label: "Produkt", from: "Basmati Reis", to: "Spaghetti" },
    ]);
  });

  it("kennt das Entfernen des MHD und Verweise ins Leere", () => {
    const lines = displacedLines(
      { ...pkg, best_before: null },
      {
        at: "2026-11-04T14:05:00.000Z",
        changes: [
          { field: "best_before", value: null },
          { field: "zone_id", value: sampleUuid(1, 99) },
          { field: "product_id", value: sampleUuid(2, 99) },
        ],
      },
      data.products,
      data.zones,
    );
    expect(lines.map((line) => [line.from, line.to])).toEqual([
      ["kein MHD", "kein MHD"],
      ["Keller", "Unbekannte Zone"],
      ["Basmati Reis", "Unbekanntes Produkt"],
    ]);
  });
});

describe("Lösch-Historie", () => {
  it("zeigt Produkt, ID, MHD, Zone, Zeitpunkt und Grund, das Neueste zuerst", async () => {
    const core = renderApp({}, ROUTES.history);
    await ready();
    const removed = value(core.data.removedPackages);
    // Eine Packung liegt außerhalb der Aufbewahrungsdauer und fehlt deshalb.
    expect(removed).toHaveLength(5);
    expect(screen.getAllByRole("button", { name: /^Wiederherstellen: / }).map((button) => button.getAttribute("aria-label"))).toEqual(
      removed.map((pkg) => `Wiederherstellen: ${pkg.id}`),
    );

    const first = removed[0];
    if (!first) {
      throw new Error("Beispieldaten ohne entnommene Packung");
    }
    const product = value(core.data.products).find((candidate) => candidate.id === first.product_id);
    const cells = within(rowOf(first.id)).getAllByRole("cell");
    expect(cells[1]).toHaveTextContent(productTitle(product));
    expect(cells[2]).toHaveTextContent(first.id);
    expect(cells[3]).toHaveTextContent(first.best_before ? formatDate(first.best_before) : "–");
    expect(cells[4]).toHaveTextContent("Keller");
    expect(cells[5]).toHaveTextContent(formatTimestamp(first.removed_at ?? ""));
    expect(within(rowOf(first.id)).getByRole("combobox", { name: `Grund für ${first.id}` })).toHaveDisplayValue("falsch erfasst");

    expect(screen.getByText(/bleiben 30 Tage hier und lassen sich so lange wiederherstellen/)).toBeInTheDocument();
  });

  it("stellt eine einzelne Packung wieder her", async () => {
    const core = renderApp({}, ROUTES.history);
    await ready();
    const target = value(core.data.removedPackages)[1];
    const id = target?.id ?? "";

    await userEvent.click(screen.getByRole("button", { name: `Wiederherstellen: ${id}` }));
    await waitFor(() => expect(screen.queryByRole("button", { name: `Wiederherstellen: ${id}` })).not.toBeInTheDocument());
    expect(value(core.data.packages).find((pkg) => pkg.id === id)).toMatchObject({ removed_at: null, removal_reason: null });
    expect(screen.getByText(`Packung ${id} wiederhergestellt`)).toBeInTheDocument();
  });

  it("zeigt beim Wiederherstellen den Spinner an der gedrückten Schaltfläche, die den Fokus behält, und sperrt solange die anderen", async () => {
    const core = renderApp({}, ROUTES.history);
    await ready();
    const removed = value(core.data.removedPackages);
    const plain = removed.filter((pkg) => pkg.displaced === null);
    const edited = removed.find((pkg) => pkg.displaced !== null);
    const [target, other] = plain;
    if (!target || !other || !edited) {
      throw new Error("Beispieldaten ohne passende entnommene Packungen");
    }
    // Das Wiederherstellen wartet, bis der Test es freigibt.
    let release: () => void = () => undefined;
    const restore = core.stock.restore.bind(core.stock);
    const spy = vi.spyOn(core.stock, "restore").mockImplementation(async (ids, options) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return restore(ids, options);
    });

    const button = screen.getByRole("button", { name: `Wiederherstellen: ${target.id}` });
    await userEvent.click(button);
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toBeUnavailable();
    for (const name of [`Wiederherstellen: ${other.id}`, `Mit Bearbeitung wiederherstellen: ${edited.id}`]) {
      expect(screen.getByRole("button", { name })).toBeUnavailable();
      expect(screen.getByRole("button", { name })).not.toHaveAttribute("aria-busy");
    }
    await userEvent.keyboard("{Enter}");
    expect(spy).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: `Wiederherstellen: ${target.id}` })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: `Wiederherstellen: ${other.id}` })).toBeAvailable();
    expect(screen.getByRole("button", { name: `Mit Bearbeitung wiederherstellen: ${edited.id}` })).toBeAvailable();
  });

  it("stellt mehrere Packungen auf einmal wieder her", async () => {
    const core = renderApp({}, ROUTES.history);
    await ready();
    const removed = value(core.data.removedPackages);
    const plain = removed.filter((pkg) => pkg.displaced === null).slice(0, 2);
    const bulk = screen.getByRole("button", { name: "Auswahl wiederherstellen" });
    expect(bulk).toBeUnavailable();

    for (const pkg of plain) {
      await userEvent.click(screen.getByRole("checkbox", { name: `${pkg.id} auswählen` }));
    }
    await userEvent.click(screen.getByRole("button", { name: "2 wiederherstellen" }));

    await waitFor(() => expect(value(core.data.removedPackages)).toHaveLength(removed.length - 2));
    expect(value(core.data.packages).filter((pkg) => plain.some((candidate) => candidate.id === pkg.id))).toHaveLength(2);
    expect(screen.getByText("2 Packungen wiederhergestellt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Auswahl wiederherstellen" })).toBeUnavailable();
  });

  it("wählt alle auf einmal aus und hebt die Auswahl wieder auf", async () => {
    renderApp({}, ROUTES.history);
    await ready();
    await userEvent.click(screen.getByRole("checkbox", { name: "Alle auswählen" }));
    expect(screen.getByRole("button", { name: "5 wiederherstellen" })).toBeAvailable();
    await userEvent.click(screen.getByRole("button", { name: "Auswahl aufheben" }));
    expect(screen.getByRole("button", { name: "Auswahl wiederherstellen" })).toBeUnavailable();
  });

  it("ändert den Grund nachträglich", async () => {
    const core = renderApp({}, ROUTES.history);
    await ready();
    const target = value(core.data.removedPackages).find((pkg) => pkg.removal_reason === "consumed");
    const id = target?.id ?? "";
    await userEvent.selectOptions(screen.getByRole("combobox", { name: `Grund für ${id}` }), "entsorgt");
    await waitFor(() => expect(value(core.data.removedPackages).find((pkg) => pkg.id === id)?.removal_reason).toBe("discarded"));
    // Die Packung bleibt entnommen, mit ihrem alten Zeitpunkt.
    expect(value(core.data.removedPackages).find((pkg) => pkg.id === id)?.removed_at).toBe(target?.removed_at);
  });

  it("zeigt einen Leerzustand", async () => {
    renderApp({ scenarios: ["empty"] }, ROUTES.history);
    await ready();
    expect(screen.getByRole("heading", { name: "Noch nichts entnommen" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("zeigt Platzhalter, wenn Produkt oder Zone fehlen", async () => {
    const data = createSampleData();
    const removed = data.packages.find((pkg) => pkg.removed_at !== null && pkg.displaced === null);
    if (!removed) {
      throw new Error("Beispieldaten ohne entnommene Packung");
    }
    const orphan: Package = { ...removed, product_id: sampleUuid(2, 999), zone_id: sampleUuid(1, 999) };
    renderApp({ data: { packages: [orphan] } }, ROUTES.history);
    await ready();
    const cells = within(rowOf(orphan.id)).getAllByRole("cell");
    expect(cells[1]).toHaveTextContent("Unbekanntes Produkt");
    expect(cells[4]).toHaveTextContent("Unbekannte Zone");
  });
});

describe("Verdrängte Bearbeitung", () => {
  function displaced(core: { data: { removedPackages: Live<Package[]> } }): Package {
    const pkg = value(core.data.removedPackages).find((candidate) => candidate.displaced !== null);
    if (!pkg) {
      throw new Error("Beispieldaten ohne verdrängte Bearbeitung");
    }
    return pkg;
  }

  it("zeigt, was geändert werden sollte", async () => {
    const core = renderApp({}, ROUTES.history);
    await ready();
    const pkg = displaced(core);
    const today = todayLocal();
    const note = screen.getByText("Verdrängte Bearbeitung").closest("td");
    expect(note).toHaveTextContent(`MHD ${formatDate(addDays(today, 9))} → ${formatDate(addDays(today, 40))}`);
    expect(note).toHaveTextContent("war aber schon entnommen");
    expect(within(note as HTMLElement).getByRole("button", { name: `Mit Bearbeitung wiederherstellen: ${pkg.id}` })).toBeInTheDocument();
    // Daneben bleibt das schlichte Wiederherstellen.
    expect(screen.getByRole("button", { name: `Wiederherstellen: ${pkg.id}` })).toBeInTheDocument();
  });

  it("stellt wieder her und übernimmt die Bearbeitung", async () => {
    const core = renderApp({}, ROUTES.history);
    const restore = vi.spyOn(core.stock, "restore");
    await ready();
    const pkg = displaced(core);

    await userEvent.click(screen.getByRole("button", { name: `Mit Bearbeitung wiederherstellen: ${pkg.id}` }));
    await waitFor(() => expect(value(core.data.packages).some((candidate) => candidate.id === pkg.id)).toBe(true));
    expect(restore).toHaveBeenCalledWith([pkg.id], { apply_displaced: true });
    expect(value(core.data.packages).find((candidate) => candidate.id === pkg.id)).toMatchObject({
      best_before: addDays(todayLocal(), 40),
      displaced: null,
      removed_at: null,
    });
    expect(screen.getByText(`Packung ${pkg.id} wiederhergestellt, Bearbeitung übernommen`)).toBeInTheDocument();
    expect(screen.queryByText("Verdrängte Bearbeitung")).not.toBeInTheDocument();
  });

  it("stellt auf Wunsch ohne die Bearbeitung wieder her", async () => {
    const core = renderApp({}, ROUTES.history);
    await ready();
    const pkg = displaced(core);
    await userEvent.click(screen.getByRole("button", { name: `Wiederherstellen: ${pkg.id}` }));
    await waitFor(() => expect(value(core.data.packages).some((candidate) => candidate.id === pkg.id)).toBe(true));
    expect(value(core.data.packages).find((candidate) => candidate.id === pkg.id)?.best_before).toBe(pkg.best_before);
  });

  it("fragt beim Wiederherstellen mehrerer Packungen, ob die Bearbeitungen mitkommen sollen", async () => {
    const core = renderApp({}, ROUTES.history);
    const restore = vi.spyOn(core.stock, "restore");
    await ready();
    const pkg = displaced(core);
    const all = value(core.data.removedPackages).map((candidate) => candidate.id);

    await userEvent.click(screen.getByRole("checkbox", { name: "Alle auswählen" }));
    await userEvent.click(screen.getByRole("button", { name: "5 wiederherstellen" }));
    const dialog = screen.getByRole("dialog", { name: "Verdrängte Bearbeitungen übernehmen?" });
    expect(dialog).toHaveTextContent("Eine der ausgewählten Packungen sollte noch geändert werden");
    expect(restore).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Mit Bearbeitungen" }));
    await waitFor(() => expect(value(core.data.removedPackages)).toHaveLength(0));
    expect(restore).toHaveBeenCalledWith(all, { apply_displaced: true });
    expect(value(core.data.packages).find((candidate) => candidate.id === pkg.id)?.best_before).toBe(addDays(todayLocal(), 40));
    expect(screen.getByRole("heading", { name: "Noch nichts entnommen" })).toBeInTheDocument();
  });
});

describe("Fokus nach dem Wiederherstellen", () => {
  it("geht an die nächste Zeile, und nach der letzten an die vorige", async () => {
    const core = renderApp({}, ROUTES.history);
    await ready();
    const removed = value(core.data.removedPackages);
    const [first, second] = removed;
    const last = removed.at(-1);
    const beforeLast = removed.at(-2);
    if (!first || !second || !last || !beforeLast) {
      throw new Error("Beispieldaten mit zu wenigen entnommenen Packungen");
    }

    await userEvent.click(screen.getByRole("button", { name: `Wiederherstellen: ${first.id}` }));
    await waitFor(() => expect(screen.queryByRole("button", { name: `Wiederherstellen: ${first.id}` })).not.toBeInTheDocument());
    // Die Zeile selbst, nicht ihre Schaltfläche: Ein zweites Enter stellt nicht gleich die nächste wieder her.
    await waitFor(() => expect(rowOf(second.id)).toHaveFocus());

    await userEvent.click(screen.getByRole("button", { name: `Wiederherstellen: ${last.id}` }));
    await waitFor(() => expect(rowOf(beforeLast.id)).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
  });

  it("geht nach der Rückfrage an die Zeile, die jetzt an der Stelle steht, und ohne Zeilen an die Überschrift", async () => {
    const core = renderApp({}, ROUTES.history);
    await ready();
    const removed = value(core.data.removedPackages);
    const edited = removed.find((pkg) => pkg.displaced !== null);
    const plain = removed.find((pkg) => pkg.displaced === null);
    if (!edited || !plain) {
      throw new Error("Beispieldaten ohne passende entnommene Packungen");
    }
    for (const pkg of [plain, edited]) {
      await userEvent.click(screen.getByRole("checkbox", { name: `${pkg.id} auswählen` }));
    }
    await userEvent.click(screen.getByRole("button", { name: "2 wiederherstellen" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Verdrängte Bearbeitungen übernehmen?" })).getByRole("button", { name: "Nur wiederherstellen" }));
    await waitFor(() => expect(value(core.data.removedPackages)).toHaveLength(removed.length - 2));

    // „Auswahl wiederherstellen“ ist danach gesperrt; der Fokus geht an die Zeile an der Stelle der ersten.
    const left = removed.filter((pkg) => pkg.id !== plain.id && pkg.id !== edited.id);
    const index = Math.min(
      removed.findIndex((pkg) => pkg.id === plain.id || pkg.id === edited.id),
      left.length - 1,
    );
    await waitFor(() => expect(rowOf(left[index]?.id ?? "")).toHaveFocus());

    // Alles Übrige: Danach gibt es keine Zeile mehr, der Fokus geht an die Überschrift.
    await userEvent.click(screen.getByRole("checkbox", { name: "Alle auswählen" }));
    await userEvent.click(screen.getByRole("button", { name: `${String(left.length)} wiederherstellen` }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Noch nichts entnommen" })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("heading", { name: "Lösch-Historie", level: 1 })).toHaveFocus());
  });

  it("lässt den Fokus an „Auswahl wiederherstellen“, solange es dasteht", async () => {
    const core = renderApp({}, ROUTES.history);
    await ready();
    const plain = value(core.data.removedPackages)
      .filter((pkg) => pkg.displaced === null)
      .slice(0, 2);
    for (const pkg of plain) {
      await userEvent.click(screen.getByRole("checkbox", { name: `${pkg.id} auswählen` }));
    }
    const bulk = screen.getByRole("button", { name: "2 wiederherstellen" });
    await userEvent.click(bulk);
    await waitFor(() => expect(bulk).toHaveTextContent("Auswahl wiederherstellen"));
    // Gesperrt, aber mit dem Fokus (useButtonLock): Er ist nicht verloren gegangen.
    expect(bulk).toHaveFocus();
    expect(bulk).toBeUnavailable();
  });

  it("geht am Handy an die nächste Karte", async () => {
    setTestViewport(375);
    const core = renderApp({}, ROUTES.history);
    await ready();
    const [first, second] = value(core.data.removedPackages);
    if (!first || !second) {
      throw new Error("Beispieldaten mit zu wenigen entnommenen Packungen");
    }
    const card = (id: string) => screen.getByRole("button", { name: `Wiederherstellen: ${id}` }).closest("li");
    await userEvent.click(screen.getByRole("button", { name: `Wiederherstellen: ${first.id}` }));
    await waitFor(() => expect(card(second.id)).toHaveFocus());
  });
});

describe("Lösch-Historie am Handy", () => {
  it("zeigt Karten mit denselben Angaben und Aktionen", async () => {
    setTestViewport(375);
    const core = renderApp({}, ROUTES.history);
    await ready();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    const removed = value(core.data.removedPackages);
    expect(screen.getAllByRole("button", { name: /^Wiederherstellen: / })).toHaveLength(removed.length);

    const pkg = removed.find((candidate) => candidate.displaced !== null);
    const card = screen.getByRole("button", { name: `Wiederherstellen: ${pkg?.id ?? ""}` }).closest("li");
    if (!card) {
      throw new Error("Karte fehlt");
    }
    expect(within(card).getAllByRole("term").map((term) => term.textContent)).toEqual(["MHD", "Zone", "Entnommen", "Grund"]);
    expect(card).toHaveTextContent("Verdrängte Bearbeitung");

    await userEvent.click(within(card).getByRole("button", { name: `Mit Bearbeitung wiederherstellen: ${pkg?.id ?? ""}` }));
    await waitFor(() => expect(value(core.data.packages).some((candidate) => candidate.id === pkg?.id)).toBe(true));
  });
});
