/**
 * Statistik auf der Attrappe: Summen, Säulen, häufig Entsorgtes, Zonen, leer, offline, Zeitraum,
 * die Tabelle für Screenreader.
 */
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CoreError, ROUTES, type Stats } from "@/contract";
import { renderApp } from "@/app/render.test-setup";
import type { MockCore } from "@/mock";
import { deviceTimeZone } from "@/ui";
import { setTestViewport } from "@/ui/testing";

import { chartSummary, currentMonth, monthName, periodText, shareText, shiftMonth, statsProductTitle } from "./model";

async function ready(): Promise<void> {
  await screen.findByRole("heading", { name: "Statistik", level: 1 });
}

/** Wartet, bis die Statistik gezeichnet ist, und liefert, was der Kern dazu sagt. */
async function loaded(core: MockCore): Promise<Stats> {
  await ready();
  await screen.findByRole("img", { name: /^Säulen je Monat/ });
  return core.stats.load();
}

function card(label: string): HTMLElement {
  const element = screen.getByText(label, { selector: "div" }).parentElement;
  if (!element) {
    throw new Error(`Kennzahl ${label} fehlt`);
  }
  return element;
}

/** Ein Anteil, wie `toHaveTextContent` ihn vergleicht: Es macht aus jedem Leerraum ein Leerzeichen. */
function share(value: number | null): string {
  return shareText(value).replace(/\s/g, " ");
}

/** Öffnet die Statistik vom Bestand aus: So gilt, was der Test vorher am Kern eingerichtet hat, schon für das erste Laden. */
async function openFromStock(): Promise<void> {
  await userEvent.click(within(screen.getByRole("navigation", { name: "Weitere Bereiche" })).getByRole("link", { name: "Statistik" }));
  await ready();
}

describe("Statistik", () => {
  it("zeigt Summen, Anteil, Säulen, häufig Entsorgtes und die Zonen", async () => {
    const core = renderApp({}, ROUTES.stats);
    const stats = await loaded(core);
    // Die Beispieldaten haben einen Verlauf: Es gibt etwas zu zeigen.
    expect(stats.consumed).toBeGreaterThan(0);
    expect(stats.discarded).toBeGreaterThan(0);

    expect(screen.getByText(periodText(stats))).toBeInTheDocument();
    expect(card("Verbraucht")).toHaveTextContent(String(stats.consumed));
    expect(card("Entsorgt")).toHaveTextContent(String(stats.discarded));
    expect(card("Anteil entsorgt")).toHaveTextContent(share(stats.discarded_share));
    expect(card("Anteil entsorgt")).toHaveTextContent(`(${String(stats.discarded)} von ${String(stats.consumed + stats.discarded)})`);

    // Säulen mit Beschreibung; „falsch erfasst" zählt nicht, das steht dabei.
    expect(screen.getByRole("img", { name: chartSummary(stats) })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Legende" })).toHaveTextContent("VerbrauchtEntsorgt");
    expect(screen.getByText(/was als „falsch erfasst“ gelöscht wurde, zählt nicht mit/)).toBeInTheDocument();

    // Am häufigsten entsorgt, meiste zuerst; Platzhalter beim Barcode.
    const top = within(screen.getByRole("region", { name: "Am häufigsten entsorgt" })).getAllByRole("listitem");
    expect(top.map((item) => item.querySelector("span span")?.textContent)).toEqual(stats.top_discarded.map(statsProductTitle));
    stats.top_discarded.forEach((entry, index) => {
      expect(top[index]).toHaveTextContent(entry.discarded === 1 ? "1 Packung" : `${String(entry.discarded)} Packungen`);
    });

    // Je Zone: Name, verbraucht, entsorgt, Anteil.
    const zones = within(screen.getByRole("region", { name: "Je Zone" })).getByRole("table");
    const rows = within(zones).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(stats.zones.length);
    stats.zones.forEach((zone, index) => {
      const cells = within(rows[index] as HTMLElement).getAllByRole("cell");
      expect(within(rows[index] as HTMLElement).getByRole("rowheader")).toHaveTextContent(zone.name);
      expect(cells.map((cell) => cell.textContent)).toEqual([
        String(zone.consumed),
        String(zone.discarded),
        shareText(zone.consumed + zone.discarded === 0 ? null : zone.discarded / (zone.consumed + zone.discarded)),
      ]);
    });
  });

  it("nennt Screenreadern dieselben Zahlen je Monat als Tabelle", async () => {
    const core = renderApp({}, ROUTES.stats);
    const stats = await loaded(core);
    const table = screen.getByRole("table", { name: "Verbraucht und entsorgt je Monat" });
    const rows = within(table).getAllByRole("row");
    // Kopf, ein Monat je Zeile, Summe
    expect(rows).toHaveLength(stats.months.length + 2);
    stats.months.forEach((month, index) => {
      const row = rows[index + 1] as HTMLElement;
      expect(within(row).getByRole("rowheader")).toHaveTextContent(monthName(month.month));
      expect(within(row).getAllByRole("cell").map((cell) => cell.textContent)).toEqual([String(month.consumed), String(month.discarded)]);
    });
    expect(within(rows.at(-1) as HTMLElement).getAllByRole("cell").map((cell) => cell.textContent)).toEqual([String(stats.consumed), String(stats.discarded)]);
    // Die Säulen selbst sind ein Bild mit Beschreibung: Screenreader lesen nicht jede einzeln.
    expect(screen.getByRole("img", { name: /Die Zahlen je Monat stehen in der Tabelle darunter\.$/ })).toBeInTheDocument();
  });

  it("wechselt den Zeitraum auf 24 Monate und zurück", async () => {
    const core = renderApp({}, ROUTES.stats);
    const load = vi.spyOn(core.stats, "load");
    const stats = await loaded(core);
    load.mockClear();

    const period = screen.getByRole("radiogroup", { name: "Zeitraum" });
    expect(within(period).getByRole("radio", { name: "12 Monate" })).toBeChecked();
    await userEvent.click(within(period).getByRole("radio", { name: "24 Monate" }));

    // Bis zum laufenden Monat in der Zeitzone des Servers.
    const end = currentMonth(stats.timezone);
    expect(load).toHaveBeenCalledWith({ start: shiftMonth(end, -23), end });
    await waitFor(() => expect(within(screen.getByRole("table", { name: "Verbraucht und entsorgt je Monat" })).getAllByRole("row")).toHaveLength(24 + 2));
    expect(screen.getByText(`${monthName(shiftMonth(end, -23))} bis ${monthName(end)}`)).toBeInTheDocument();
    expect(within(period).getByRole("radio", { name: "24 Monate" })).toBeChecked();

    await userEvent.click(within(period).getByRole("radio", { name: "12 Monate" }));
    expect(load).toHaveBeenLastCalledWith(undefined);
    await waitFor(() => expect(within(screen.getByRole("table", { name: "Verbraucht und entsorgt je Monat" })).getAllByRole("row")).toHaveLength(12 + 2));
  });

  it("lädt auf Wunsch neu und zeigt danach den neuen Stand", async () => {
    const core = renderApp({}, ROUTES.stats);
    const stats = await loaded(core);
    const load = vi.spyOn(core.stats, "load").mockResolvedValue({ ...stats, consumed: stats.consumed + 5 });
    await userEvent.click(screen.getByRole("button", { name: "Neu laden" }));
    expect(load).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(card("Verbraucht")).toHaveTextContent(String(stats.consumed + 5)));
  });

  it("zeigt einen Leerzustand, solange nichts verbraucht oder entsorgt ist", async () => {
    renderApp({ scenarios: ["stats-empty"] }, ROUTES.stats);
    await ready();
    expect(await screen.findByRole("heading", { name: "Nichts verbraucht oder entsorgt" })).toBeInTheDocument();
    expect(screen.getByText(/wurde keine Packung als verbraucht oder entsorgt entnommen/)).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Je Zone" })).not.toBeInTheDocument();
    // Ein anderer Zeitraum bleibt wählbar.
    expect(screen.getByRole("radiogroup", { name: "Zeitraum" })).toBeInTheDocument();
  });

  it("sagt offline, warum die Statistik fehlt, und lädt sie, sobald der Server zurück ist", async () => {
    const core = renderApp({ scenarios: ["offline"] }, ROUTES.stats);
    await ready();
    expect(await screen.findByRole("heading", { name: "Ohne Verbindung keine Statistik" })).toBeInTheDocument();
    expect(screen.getByText(/Die Statistik rechnet der Server aus allen Packungen der ganzen Zeit; ohne Verbindung gibt es sie nicht\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Erneut versuchen" })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Zeitraum" })).not.toBeInTheDocument();

    act(() => core.control.setOnline(true));
    expect(await screen.findByRole("img", { name: /^Säulen je Monat/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Ohne Verbindung keine Statistik" })).not.toBeInTheDocument();
  });

  it("behält eine geladene Statistik, wenn der Server wegfällt, sagt, von wann sie ist, und lädt mit ihm neu", async () => {
    const core = renderApp({}, ROUTES.stats);
    const stats = await loaded(core);
    act(() => core.control.setOnline(false));
    expect(await screen.findByText("Der Server ist nicht erreichbar")).toBeInTheDocument();
    expect(screen.getByText(/Zu sehen ist der Stand von \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}\. Neu laden geht erst wieder mit Verbindung/)).toBeInTheDocument();
    expect(card("Verbraucht")).toHaveTextContent(String(stats.consumed));
    expect(screen.getByRole("img", { name: chartSummary(stats) })).toBeInTheDocument();
    // Neu laden und ein anderer Zeitraum brauchen den Server.
    expect(screen.getByRole("button", { name: "Neu laden" })).toBeUnavailable();
    expect(screen.getByRole("radio", { name: "24 Monate" })).toBeUnavailable();

    const load = vi.spyOn(core.stats, "load");
    act(() => core.control.setOnline(true));
    await waitFor(() => expect(screen.queryByText("Der Server ist nicht erreichbar")).not.toBeInTheDocument());
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Neu laden" })).toBeAvailable();
  });

  it("sagt, wenn das Neuladen scheitert, und zeigt solange den alten Stand", async () => {
    const core = renderApp({}, ROUTES.stats);
    const stats = await loaded(core);
    vi.spyOn(core.stats, "load").mockRejectedValueOnce(new CoreError("offline"));
    await userEvent.click(screen.getByRole("button", { name: "Neu laden" }));
    expect(await screen.findByText("Nicht neu geladen")).toBeInTheDocument();
    expect(screen.getByText(/Die Statistik rechnet der Server, und der ist gerade nicht erreichbar\. Zu sehen ist der Stand von/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: chartSummary(stats) })).toBeInTheDocument();

    // Scheitert der Wechsel des Zeitraums, sagt die Meldung das so.
    vi.spyOn(core.stats, "load").mockRejectedValueOnce(new CoreError("internal"));
    await userEvent.click(screen.getByRole("radio", { name: "24 Monate" }));
    expect(await screen.findByText("Dieser Zeitraum ließ sich nicht laden")).toBeInTheDocument();
    // Die Zahlen sind weiter die der 12 Monate; das sagt die Zeile darüber.
    expect(screen.getByText(periodText(stats))).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    await waitFor(() => expect(screen.queryByText("Dieser Zeitraum ließ sich nicht laden")).not.toBeInTheDocument());
    expect(within(screen.getByRole("table", { name: "Verbraucht und entsorgt je Monat" })).getAllByRole("row")).toHaveLength(24 + 2);
  });

  it("meldet andere Fehler und versucht es auf Wunsch noch einmal", async () => {
    const core = renderApp();
    await screen.findByRole("heading", { name: "Bestand" });
    const load = vi.spyOn(core.stats, "load").mockRejectedValueOnce(new CoreError("internal", "kaputt"));
    await openFromStock();
    expect(await screen.findByRole("alert")).toHaveTextContent("Die Statistik ließ sich nicht laden");
    expect(screen.getByRole("alert")).toHaveTextContent("Unerwarteter Fehler. Bitte noch einmal versuchen.");
    await userEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    expect(await screen.findByRole("img", { name: /^Säulen je Monat/ })).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("sagt dazu, wenn der Server die Monate in einer anderen Zeitzone rechnet", async () => {
    const core = renderApp();
    await screen.findByRole("heading", { name: "Bestand" });
    const other = deviceTimeZone() === "Pacific/Auckland" ? "America/New_York" : "Pacific/Auckland";
    const original = core.stats.load.bind(core.stats);
    vi.spyOn(core.stats, "load").mockImplementation(async (range) => ({ ...(await original(range)), timezone: other }));
    await openFromStock();
    expect(await screen.findByText(`Monate in der Zeit des Servers (${other})`)).toBeInTheDocument();
    // In der Zeitzone des Geräts kein Hinweis.
    vi.mocked(core.stats.load).mockImplementation(async (range) => ({ ...(await original(range)), timezone: deviceTimeZone() }));
    await userEvent.click(screen.getByRole("button", { name: "Neu laden" }));
    await waitFor(() => expect(screen.queryByText(/Monate in der Zeit des Servers/)).not.toBeInTheDocument());
  });

  it("zeigt am Handy dieselben Teile, ohne Zonen bei nur einer Zone", async () => {
    setTestViewport(375);
    const core = renderApp({ scenarios: ["single-zone"] }, ROUTES.stats);
    const stats = await loaded(core);
    expect(card("Verbraucht")).toHaveTextContent(String(stats.consumed));
    expect(screen.getByRole("table", { name: "Verbraucht und entsorgt je Monat" })).toBeInTheDocument();
    // Mit nur einer Zone gäbe die Tabelle je Zone nur die Summen noch einmal.
    expect(screen.queryByRole("region", { name: "Je Zone" })).not.toBeInTheDocument();
  });

  it("ist über die weiteren Bereiche erreichbar", async () => {
    renderApp();
    await screen.findByRole("heading", { name: "Bestand" });
    await openFromStock();
    expect(window.location.pathname).toBe(ROUTES.stats);
    expect(document.title).toBe("Statistik · Stowly");
  });
});
