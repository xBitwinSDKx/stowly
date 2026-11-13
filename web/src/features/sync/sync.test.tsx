/**
 * Sync-Status: der Zustand in Worten, die Sätze zu den Sync-Problemen und die Ansicht.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { COMMAND_TYPES, ROUTES, type Command, type Live, type RejectCode, type SyncProblem, type SyncStatus } from "@/contract";
import { renderApp } from "@/app/render.test-setup";
import { createSampleData, PRINTER_IDS, sampleBarcode, sampleUuid, ZONE_IDS } from "@/mock";

import { describeProblem, type ProblemLookup } from "./problems";
import { pendingText, summarizeSync, syncErrorText } from "./status";

function value<T>(live: Live<T>): T {
  const current = live.get();
  if (current === undefined) {
    throw new Error("Live-Wert ist noch nicht geladen");
  }
  return current;
}

const AT = "2026-11-13T10:15:30.123Z";

/** Die ganze Zeile einer Liste zu ihrer Beschriftung. */
function rowOf(label: string): HTMLElement | null | undefined {
  return screen.getByText(label).parentElement?.parentElement;
}

describe("summarizeSync", () => {
  const base: SyncStatus = { online: true, phase: "idle", pending: 0, last_synced_at: AT, last_error: null, server_version: "0.1.0" };

  it("beschreibt jeden Zustand", () => {
    expect(summarizeSync(undefined)).toMatchObject({ tone: "unknown", pending: 0 });
    expect(summarizeSync(base)).toMatchObject({ tone: "ok", label: "Aktuell" });
    expect(summarizeSync({ ...base, pending: 3 })).toMatchObject({ tone: "pending", label: "3 ungesendet", pending: 3 });
    expect(summarizeSync({ ...base, phase: "syncing", pending: 3 })).toMatchObject({ tone: "busy", label: "Abgleich läuft" });
    expect(summarizeSync({ ...base, online: null })).toMatchObject({ tone: "unknown", label: "Verbindung wird geprüft" });
    expect(summarizeSync({ ...base, online: false, phase: "error", pending: 4 })).toMatchObject({ tone: "offline", label: "Offline", pending: 4 });
  });

  it("nennt offline, was wartet, und sperrt nichts", () => {
    const summary = summarizeSync({ ...base, online: false, phase: "error", pending: 1 });
    expect(summary.detail).toContain("1 Änderung wartet auf diesem Gerät.");
    expect(summary.detail).toContain("arbeitet auf der lokalen Kopie weiter");
  });

  it("nennt den Grund, wenn ein Abgleich trotz erreichbarem Server scheitert", () => {
    const summary = summarizeSync({ ...base, phase: "error", last_error: { code: "protocol_mismatch", message: "409", at: AT } });
    expect(summary.tone).toBe("error");
    expect(summary.detail).toContain("verschiedene Versionen");
    expect(syncErrorText({ code: "offline", message: "x" })).toBe("Der Server war nicht erreichbar.");
    // Unbekanntes: der Text des Kerns als Rückfall
    expect(syncErrorText({ code: "invalid", message: "Antwort unlesbar." })).toBe("Antwort unlesbar.");
  });

  it("zählt in Worten", () => {
    expect(pendingText(1)).toBe("1 ungesendete Änderung");
    expect(pendingText(4)).toBe("4 ungesendete Änderungen");
  });
});

describe("describeProblem", () => {
  const data = createSampleData();
  const rice = data.products[0];
  const spaghetti = data.products[1];
  const active = data.packages.find((pkg) => pkg.removed_at === null && pkg.product_id === rice?.id);
  const lookup: ProblemLookup = { products: data.products, zones: data.zones, printers: data.printers, packages: data.packages };
  const empty: ProblemLookup = { products: [], zones: [], printers: [], packages: [] };

  function problem(command: Record<string, unknown>, code: RejectCode | null, status: SyncProblem["status"] = "rejected", message: string | null = null): SyncProblem {
    return { id: sampleUuid(9, 1), at: AT, status, code, message, command: { id: sampleUuid(9, 2), at: AT, ...command } as Command };
  }

  it("sagt, was nicht übernommen wurde und warum", () => {
    expect(
      describeProblem(problem({ type: "package.create", package_id: "A2B3C", product_id: rice?.id, zone_id: ZONE_IDS.cellar, best_before: null }, "id_conflict"), lookup),
    ).toEqual({
      text: "Die Packung A2B3C (Basmati Reis) wurde nicht eingelagert, weil ihre ID schon vergeben ist.",
      advice: "Bitte die Packung neu einlagern und das Etikett ersetzen.",
      inHistory: false,
    });
    expect(describeProblem(problem({ type: "zone.delete", zone_id: ZONE_IDS.cellar, move_to: ZONE_IDS.shelf }, "last_zone"), lookup).text).toBe(
      "Die Zone „Keller“ wurde nicht gelöscht, weil die letzte Zone nicht gelöscht werden kann.",
    );
    expect(describeProblem(problem({ type: "product.update", product_id: spaghetti?.id, changes: { name: "Nudeln" } }, "not_found"), lookup).text).toBe(
      "Die Änderung an dem Produkt „Spaghetti“ wurde nicht übernommen, weil es das Produkt auf dem Server nicht gibt.",
    );
    expect(describeProblem(problem({ type: "product.merge", source_id: spaghetti?.id, target_id: rice?.id }, "not_found"), lookup).text).toBe(
      "Das Produkt „Spaghetti“ wurde nicht mit dem Produkt „Basmati Reis“ zusammengeführt, weil es eines der beiden Produkte auf dem Server nicht gibt.",
    );
    expect(describeProblem(problem({ type: "product.add_barcode", product_id: rice?.id, barcode: sampleBarcode(9) }, "invalid"), lookup).text).toBe(
      `Der Barcode ${sampleBarcode(9)} wurde dem Produkt „Basmati Reis“ nicht zugeordnet, weil der Server die Angaben für ungültig hält.`,
    );
    expect(describeProblem(problem({ type: "package.remove", package_id: active?.id, reason: "consumed" }, "not_found"), lookup).text).toBe(
      `Die Packung ${active?.id ?? ""} (Basmati Reis) wurde nicht entnommen, weil es die Packung auf dem Server nicht gibt.`,
    );
    expect(describeProblem(problem({ type: "printer.update", printer_id: PRINTER_IDS.cellar, changes: { name: "Pi" } }, "not_found"), lookup).text).toBe(
      "Die Änderung an dem Drucker „Keller (Pi)“ wurde nicht übernommen, weil es den Drucker auf dem Server nicht mehr gibt.",
    );
    expect(describeProblem(problem({ type: "settings.update", changes: { warn_days: 7 } }, "internal"), lookup)).toMatchObject({
      text: "Die Änderung an den Einstellungen des Haushalts wurde nicht übernommen, weil im Server ein Fehler aufgetreten ist.",
      advice: "Bitte die Änderung noch einmal vornehmen.",
    });
  });

  it("verweist bei verdrängten Bearbeitungen auf die Lösch-Historie", () => {
    const removed = data.packages.find((pkg) => pkg.removed_at !== null && pkg.product_id === rice?.id);
    const text = describeProblem(problem({ type: "package.update", package_id: removed?.id, changes: { best_before: "2027-01-01" } }, null, "displaced"), lookup);
    expect(text).toEqual({
      text: `Die Bearbeitung der Packung ${removed?.id ?? ""} (Basmati Reis) kam zu spät: Die Packung war schon entnommen.`,
      advice: "Die Bearbeitung liegt in der Lösch-Historie und lässt sich dort beim Wiederherstellen übernehmen.",
      inHistory: true,
    });
  });

  it("kommt ohne bekannte Namen aus und nutzt sonst die Meldung des Servers", () => {
    expect(describeProblem(problem({ type: "zone.update", zone_id: ZONE_IDS.cellar, changes: { name: "X" } }, "not_found"), empty).text).toBe(
      "Die Änderung an einer Zone wurde nicht übernommen, weil es die Zone auf dem Server nicht mehr gibt.",
    );
    expect(describeProblem(problem({ type: "package.restore", package_id: "A2B3C", apply_displaced: false }, null, "rejected", "Abgelehnt wegen X."), empty).text).toBe(
      "Die Packung A2B3C wurde nicht wiederhergestellt; Meldung des Servers: Abgelehnt wegen X.",
    );
    expect(describeProblem(problem({ type: "zone.create", zone_id: sampleUuid(1, 50), name: "Garage" }, null), empty).text).toBe(
      "Die Zone „Garage“ wurde nicht angelegt; der Server nennt keinen Grund.",
    );
  });

  it("hat für jede Befehlsart und jeden Grund einen vollständigen deutschen Satz", () => {
    const payloads: Record<(typeof COMMAND_TYPES)[number], Record<string, unknown>> = {
      "product.create": { product_id: sampleUuid(2, 50), name: "Reis" },
      "product.update": { product_id: rice?.id, changes: {} },
      "product.add_barcode": { product_id: rice?.id, barcode: sampleBarcode(9) },
      "product.remove_barcode": { product_id: rice?.id, barcode: sampleBarcode(9) },
      "product.merge": { source_id: rice?.id, target_id: spaghetti?.id },
      "package.create": { package_id: "A2B3C", product_id: rice?.id, zone_id: ZONE_IDS.cellar },
      "package.update": { package_id: "A2B3C", changes: {} },
      "package.remove": { package_id: "A2B3C", reason: "consumed" },
      "package.restore": { package_id: "A2B3C" },
      "zone.create": { zone_id: sampleUuid(1, 50), name: "Garage" },
      "zone.update": { zone_id: ZONE_IDS.cellar, changes: {} },
      "zone.delete": { zone_id: ZONE_IDS.cellar, move_to: ZONE_IDS.shelf },
      "settings.update": { changes: {} },
      "printer.create": { printer_id: sampleUuid(3, 50), name: "Flur", connection: "server" },
      "printer.update": { printer_id: PRINTER_IDS.cellar, changes: {} },
      "printer.delete": { printer_id: PRINTER_IDS.cellar },
      "printer.report": { printer_id: PRINTER_IDS.cellar },
      "print.request": { job_id: sampleUuid(4, 50), kind: "package", package_id: "A2B3C" },
      "print.report": { job_id: sampleUuid(4, 50), state: "printed" },
    };
    const codes: (RejectCode | null)[] = ["invalid", "not_found", "id_conflict", "last_zone", "internal", null];
    for (const type of COMMAND_TYPES) {
      for (const code of codes) {
        for (const names of [lookup, empty]) {
          const { text } = describeProblem(problem({ type, ...payloads[type] }, code), names);
          expect(text, `${type} / ${String(code)}`).toMatch(/^[A-ZÄÖÜ].* wurden? .*nicht .+\.$/);
          expect(text, `${type} / ${String(code)}`).not.toMatch(/undefined|null|\[object/);
          // Die technische Befehlsart taucht im Satz nicht auf.
          expect(text).not.toContain(type);
        }
      }
    }
  });
});

describe("Sync-Ansicht", () => {
  it("zeigt den Zustand und gleicht auf Wunsch ab", async () => {
    const core = renderApp({}, ROUTES.sync);
    await screen.findByRole("heading", { name: "Sync-Status" });
    expect(screen.getByText("erreichbar")).toBeInTheDocument();
    expect(rowOf("Letzter Abgleich")).toHaveTextContent("gerade eben");
    expect(screen.getByText(/Keine: Der Server hat alle Änderungen übernommen/)).toBeInTheDocument();

    await core.zones.create({ name: "Garage" });
    await userEvent.click(screen.getByRole("button", { name: "Jetzt abgleichen" }));
    await waitFor(() => expect(value(core.sync.status).pending).toBe(0));
  });

  it("sagt offline, was wartet, und dass nichts verloren geht", async () => {
    const core = renderApp({ scenarios: ["offline"] }, ROUTES.sync);
    await screen.findByRole("heading", { name: "Sync-Status" });
    expect(screen.getByText("Der Server ist nicht erreichbar")).toBeInTheDocument();
    expect(screen.getByText("nicht erreichbar")).toBeInTheDocument();
    expect(rowOf("Ungesendete Änderungen")).toHaveTextContent("4");
    expect(rowOf("Letzter Abgleich")).toHaveTextContent("vor 3 Stunden");
    expect(rowOf("Letzter Fehler")).toHaveTextContent("Der Server war nicht erreichbar.");

    // Ein Versuch ohne Server scheitert, ohne dass die Ansicht etwas verliert.
    await userEvent.click(screen.getByRole("button", { name: "Jetzt abgleichen" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Jetzt abgleichen" })).toBeEnabled());
    expect(value(core.sync.status).pending).toBe(4);

    core.control.setOnline(true);
    expect(await screen.findByText("erreichbar")).toBeInTheDocument();
    expect(screen.queryByText("Der Server ist nicht erreichbar")).not.toBeInTheDocument();
  });

  it("listet die Sync-Probleme als Sätze und blendet sie auf Wunsch aus", async () => {
    const core = renderApp({ scenarios: ["problems"] }, ROUTES.sync);
    await screen.findByRole("heading", { name: "Sync-Status" });
    const problems = within(screen.getByRole("region", { name: "Sync-Probleme" })).getAllByRole("listitem");
    expect(problems).toHaveLength(2);

    expect(problems[0]).toHaveTextContent("abgelehnt");
    expect(problems[0]).toHaveTextContent(/Die Packung \w{5} \(.+\) wurde nicht eingelagert, weil ihre ID schon vergeben ist\./);
    expect(problems[0]).toHaveTextContent("Bitte die Packung neu einlagern und das Etikett ersetzen.");

    expect(problems[1]).toHaveTextContent("verdrängt");
    expect(problems[1]).toHaveTextContent(/Die Bearbeitung der Packung \w{5} \(.+\) kam zu spät/);
    expect(within(problems[1] as HTMLElement).getByRole("link", { name: "Zur Lösch-Historie" })).toHaveAttribute("href", ROUTES.history);

    await userEvent.click(within(problems[0] as HTMLElement).getByRole("button", { name: "Ausblenden" }));
    await waitFor(() => expect(value(core.sync.problems)).toHaveLength(1));
    expect(within(screen.getByRole("region", { name: "Sync-Probleme" })).getAllByRole("listitem")).toHaveLength(1);

    await userEvent.click(screen.getByRole("link", { name: "Zur Lösch-Historie" }));
    expect(await screen.findByRole("heading", { name: "Lösch-Historie" })).toBeInTheDocument();
  });
});
