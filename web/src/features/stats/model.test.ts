/**
 * Die Statistik ohne React: Monate, Zeiträume, Achsen und die Sätze für Screenreader.
 */
import { describe, expect, it } from "vitest";

import { STATS_DEFAULT_MONTHS, toLocalDate, type Stats } from "@/contract";

import {
  axisFor,
  chartSummary,
  currentMonth,
  isEmpty,
  labelStep,
  monthLabels,
  monthName,
  monthShort,
  PERIODS,
  periodText,
  shareOf,
  shareText,
  shiftMonth,
  statsProductTitle,
  statsRange,
} from "./model";

function stats(months: [string, number, number][]): Stats {
  const consumed = months.reduce((sum, [, value]) => sum + value, 0);
  const discarded = months.reduce((sum, [, , value]) => sum + value, 0);
  return {
    start: months[0]?.[0] ?? "2026-11",
    end: months.at(-1)?.[0] ?? "2026-11",
    months: months.map(([month, c, d]) => ({ month, consumed: c, discarded: d })),
    consumed,
    discarded,
    discarded_share: consumed + discarded === 0 ? null : discarded / (consumed + discarded),
    top_discarded: [],
    zones: [],
    timezone: "Europe/Berlin",
  };
}

describe("Monate", () => {
  it("benennt Monate deutsch, lang und kurz", () => {
    expect(monthName("2026-11")).toBe("November 2026");
    expect(monthName("2026-03")).toBe("März 2026");
    expect(monthShort("2026-03")).toBe("Mär");
    expect(monthShort("2025-12")).toBe("Dez");
  });

  it("verschiebt über Jahresgrenzen", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2025-12", 1)).toBe("2026-01");
    expect(shiftMonth("2026-11", -23)).toBe("2024-12");
    expect(shiftMonth("2026-11", 0)).toBe("2026-11");
  });

  it("kennt den laufenden Monat in der Zeitzone des Servers", () => {
    // 31.10.2026, 23:30 UTC: in Berlin schon November, in New York noch Oktober.
    const now = new Date("2026-10-31T23:30:00.000Z");
    expect(currentMonth("Europe/Berlin", now)).toBe("2026-11");
    expect(currentMonth("America/New_York", now)).toBe("2026-10");
    // Ohne oder mit unbekannter Zeitzone gilt die des Geräts.
    expect(currentMonth(null, now)).toBe(toLocalDate(now).slice(0, 7));
    expect(currentMonth("Mars/Olympus", now)).toBe(toLocalDate(now).slice(0, 7));
  });
});

describe("Zeitraum", () => {
  it("bietet 12 und 24 Monate an; 12 ist die Vorgabe des Servers", () => {
    expect(PERIODS).toEqual([12, 24]);
    expect(PERIODS[0]).toBe(STATS_DEFAULT_MONTHS);
  });

  it("überlässt die Vorgabe dem Server und rechnet den längeren Zeitraum bis zu seinem laufenden Monat", () => {
    const now = new Date("2026-10-31T23:30:00.000Z");
    expect(statsRange(12, "Europe/Berlin", now)).toBeUndefined();
    expect(statsRange(24, "Europe/Berlin", now)).toEqual({ start: "2024-12", end: "2026-11" });
    expect(statsRange(24, "America/New_York", now)).toEqual({ start: "2024-11", end: "2026-10" });
  });

  it("nennt den Zeitraum einer Antwort in Worten", () => {
    expect(periodText({ start: "2025-12", end: "2026-11" })).toBe("Dezember 2025 bis November 2026");
    expect(periodText({ start: "2026-11", end: "2026-11" })).toBe("November 2026");
  });
});

describe("Zahlen", () => {
  it("zeigt den Anteil in Prozent mit höchstens einer Nachkommastelle", () => {
    expect(shareText(null)).toBe("–");
    expect(shareText(0.0893)).toMatch(/^8,9\s%$/);
    expect(shareText(0.5)).toMatch(/^50\s%$/);
    expect(shareText(0)).toMatch(/^0\s%$/);
  });

  it("rechnet den Anteil einer Zone wie der Server", () => {
    expect(shareOf({ consumed: 3, discarded: 1 })).toBe(0.25);
    expect(shareOf({ consumed: 0, discarded: 0 })).toBeNull();
  });

  it("ist leer, wenn nichts entnommen ist", () => {
    expect(isEmpty(stats([["2026-11", 0, 0]]))).toBe(true);
    expect(isEmpty(stats([["2026-11", 0, 1]]))).toBe(false);
  });

  it("nennt Platzhalter beim Barcode", () => {
    expect(statsProductTitle({ name: "Joghurt", barcode: "4006381333931" })).toBe("Joghurt");
    expect(statsProductTitle({ name: "", barcode: "4006381333931" })).toBe("4006381333931");
    expect(statsProductTitle({ name: "", barcode: null })).toBe("Unbekanntes Produkt");
  });
});

describe("Achse und Beschriftung", () => {
  it("rundet den Höchstwert auf runde Schritte", () => {
    expect(axisFor(17)).toEqual({ top: 20, ticks: [0, 5, 10, 15, 20] });
    expect(axisFor(3)).toEqual({ top: 3, ticks: [0, 1, 2, 3] });
    expect(axisFor(7)).toEqual({ top: 8, ticks: [0, 2, 4, 6, 8] });
    expect(axisFor(1)).toEqual({ top: 1, ticks: [0, 1] });
    expect(axisFor(120)).toEqual({ top: 150, ticks: [0, 50, 100, 150] });
    expect(axisFor(0)).toEqual({ top: 1, ticks: [0, 1] });
  });

  it("lässt Monate aus, wenn der Platz nicht reicht, aber nie den Januar", () => {
    expect(labelStep(60)).toBe(1);
    expect(labelStep(23)).toBe(2);
    expect(labelStep(11.6)).toBe(3);
    expect(labelStep(2)).toBe(12);

    const months = ["2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04"];
    expect(monthLabels(months, 1)).toEqual([
      { month: "Nov", year: "2025" },
      { month: "Dez", year: null },
      { month: "Jan", year: "2026" },
      { month: "Feb", year: null },
      { month: "Mär", year: null },
      { month: "Apr", year: null },
    ]);
    // Jeder dritte Monat: Januar und April; das Jahr steht beim ersten beschrifteten.
    expect(monthLabels(months, 3).map((label) => label.month)).toEqual([null, null, "Jan", null, null, "Apr"]);
    expect(monthLabels(months, 3)[2]?.year).toBe("2026");
  });
});

describe("Beschreibung für Screenreader", () => {
  it("nennt Zeitraum, Summen und die stärksten Monate", () => {
    const text = chartSummary(
      stats([
        ["2026-09", 4, 0],
        ["2026-10", 9, 2],
        ["2026-11", 9, 1],
      ]),
    );
    expect(text).toBe(
      "Säulen je Monat, September 2026 bis November 2026: 22 Packungen verbraucht, 3 entsorgt. Am meisten verbraucht im Oktober 2026 (9). Am meisten entsorgt im Oktober 2026 (2). Die Zahlen je Monat stehen in der Tabelle darunter.",
    );
    expect(chartSummary(stats([["2026-11", 1, 0]]))).toContain("Entsorgt wurde nichts.");
    expect(chartSummary(stats([["2026-11", 1, 0]]))).toContain("1 Packung verbraucht");
  });
});
