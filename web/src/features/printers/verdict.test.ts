/**
 * Das Urteil über einen Drucker und der Rat je Fehler (docs/plan-0.5.md, 3).
 */
import { describe, expect, it } from "vitest";

import type { DriverStatus, LabelPaper, Printer, PrinterProbe, ServiceHealth, ServicePrinter } from "@/contract";

import { adviceFor, outdatedService, paperName, printerLink, PRINTER_ERROR_ADVICE, probeVerdict, rendersFormat2, seenAdvice, serviceOf } from "./verdict";

const READY: DriverStatus = { reachable: true, ready: true, media_detected: true, errors: [] };
const OFF: DriverStatus = { reachable: false, ready: null, media_detected: null, errors: ["offline"] };

const pi: Printer = {
  id: "printer-pi",
  name: "Keller (Pi)",
  connection: "direct",
  server: null,
  direct: { urls: ["https://10.71.83.1:8443"], token: "geheim", printer: null },
  created_at: "2026-11-01T00:00:00.000Z",
  updated_at: "2026-11-01T00:00:00.000Z",
  deleted_at: null,
};
const usb: Printer = { ...pi, id: "printer-usb", name: "Küche", connection: "server", direct: null, server: { driver: "brother_ql", model: "QL-570", address: "usb://04f9:2028", media: "62" } };
const network: Printer = { ...usb, id: "printer-tcp", server: { driver: "brother_ql", model: "QL-820NWB", address: "tcp://192.168.1.60:9100", media: "62" } };
const image: Printer = { ...usb, id: "printer-image", server: { driver: "image", model: null, address: null, media: "62" } };

function service(name: string, status: DriverStatus, loaded: ServicePrinter["loaded"] = { id: "62", kind: "endless", width_mm: 62, length_mm: null }): ServicePrinter {
  return {
    name,
    driver: "brother_ql",
    model: "QL-570",
    capabilities: { dpi: 300, media: { width_mm: 62, length_mm: null, printable_px: 696 }, cutter: true, colors: ["black"], status_query: true, confirms_print: true },
    status,
    loaded,
  };
}

function probe(printers: ServicePrinter[], extra: Partial<PrinterProbe> = {}, health: Partial<ServiceHealth> = {}): PrinterProbe {
  return {
    reachable: true,
    url: "https://10.71.83.1:8443",
    health: { app: "stowly-print", version: "0.5.0", protocol: 1, boot_id: "boot", uptime_s: 10, proof: null, host: null, printers, template_schemas: [1, 2], ...health },
    problem: null,
    error: null,
    ...extra,
  };
}

const CATALOG: LabelPaper[] = [
  { id: "62", kind: "endless", name: "62 mm endlos", width_mm: 62, length_mm: null, printable_width_px: 696, printable_length_px: null },
  { id: "39x90", kind: "die_cut", name: "38 × 90 mm gestanzt", width_mm: 38, length_mm: 90, printable_width_px: 413, printable_length_px: 991 },
];

describe("Urteil nach „Verbindung prüfen“", () => {
  it("ist grün nur, wenn Dienst und Drucker bereit sind, und nennt die eingelegte Rolle", () => {
    expect(probeVerdict(probe([service("ql570", READY)]), pi, "62 mm endlos")).toEqual({ kind: "ready", roll: "62 mm endlos" });
    // Ohne Angabe der Rolle (Bild-Treiber, Druckdienst vor 0.5.0) steht keine da.
    expect(probeVerdict(probe([service(image.id, READY, null)]), image, null)).toEqual({ kind: "ready", roll: null });
  });

  it("ist gelb, wenn der Dienst antwortet und der Drucker nicht, mit Rat je nach Anschluss", () => {
    const atPi = probeVerdict(probe([service("ql570", OFF, null)]), pi, null);
    expect(atPi).toEqual({
      kind: "printer",
      roll: null,
      advice: { title: "Der Pi antwortet, der Drucker nicht.", advice: ["Drucker einschalten.", "USB-Kabel an Drucker und Pi prüfen.", "Dann noch einmal „Verbindung prüfen“."] },
    });
    const atServer = probeVerdict(probe([service(usb.id, OFF, null)]), usb, null);
    expect(atServer.kind === "printer" && atServer.advice.title).toBe("Der Server antwortet, der Drucker nicht.");
    expect(atServer.kind === "printer" && atServer.advice.advice.join(" ")).toMatch(/USB-Kabel an Drucker und Server.*Neustart von Stowly/);
    const tcp = probeVerdict(probe([service(network.id, OFF, null)]), network, null);
    expect(tcp.kind === "printer" && tcp.advice.advice.join(" ")).toContain("Netzwerkkabel oder WLAN des Druckers prüfen");
  });

  it("gibt jedem Fehler des Druckers seinen Rat; bei falscher Rolle mit Rolle und Papier des Haushalts", () => {
    const cases: [string, string, string][] = [
      ["no_media", "Es sind keine Etiketten eingelegt.", "Eine Etikettenrolle einlegen."],
      ["cover_open", "Die Klappe des Druckers ist offen.", "Die Klappe des Druckers schließen."],
      ["cutter_jam", "Das Schneidwerk klemmt.", "eingeklemmtes Papier am Schneidwerk vorsichtig entfernen"],
      ["overheated", "Der Drucker ist überhitzt und braucht eine Pause.", "abkühlen lassen"],
    ];
    for (const [code, title, step] of cases) {
      const verdict = probeVerdict(probe([service("ql570", { reachable: true, ready: false, media_detected: true, errors: [code] })]), pi, "62 mm endlos");
      expect(verdict.kind, code).toBe("printer");
      expect(verdict.kind === "printer" && verdict.advice.title, code).toBe(title);
      expect(verdict.kind === "printer" && verdict.advice.advice.join(" "), code).toContain(step);
    }
    const mismatch = probeVerdict(probe([service("ql570", { reachable: true, ready: false, media_detected: true, errors: ["media_mismatch"] })]), pi, "38 × 90 mm gestanzt", CATALOG);
    expect(mismatch).toMatchObject({ kind: "printer", roll: "62 mm endlos", advice: { title: "Die eingelegte Rolle passt nicht zum Papier des Haushalts." } });
    expect(mismatch.kind === "printer" && mismatch.advice.advice[0]).toBe("Eingelegt ist 62 mm endlos; das Papier des Haushalts ist 38 × 90 mm gestanzt.");
    // Der feste Satz zur 62-mm-Rolle ist weg.
    expect(JSON.stringify(mismatch)).not.toContain("Erwartet wird die 62-mm-Endlosrolle");
    // Etiketten leer, auch ohne Fehlercode.
    expect(probeVerdict(probe([service("ql570", { reachable: true, ready: true, media_detected: false, errors: [] })]), pi, null)).toMatchObject({ kind: "printer", advice: { title: "Es sind keine Etiketten eingelegt." } });
    // Nicht bereit ohne Grund.
    expect(probeVerdict(probe([service("ql570", { reachable: true, ready: false, media_detected: true, errors: [] })]), pi, null)).toMatchObject({ kind: "printer", advice: { title: "Der Drucker ist nicht bereit." } });
  });

  it("meldet einen zu alten Druckdienst und sonst die Probleme mit dem Dienst wie bisher", () => {
    expect(probeVerdict(probe([service("ql570", READY, null)], { problem: "outdated" }, { version: "0.4.0" }), pi, null)).toEqual({ kind: "outdated", version: "0.4.0" });
    expect(probeVerdict({ reachable: false, url: null, health: null, problem: "unreachable", error: "…" }, pi, null)).toEqual({ kind: "service", problem: "unreachable" });
    expect(probeVerdict(probe([], { problem: "unknown_printer" }), pi, null)).toEqual({ kind: "service", problem: "unknown_printer" });
    // Der Dienst hat den Drucker nicht, ohne dass der Kern es sagt: wie „unbekannter Drucker".
    expect(probeVerdict(probe([service("anderer", READY)]), { ...pi, direct: { ...(pi.direct as NonNullable<Printer["direct"]>), printer: "ql800" } }, null)).toEqual({
      kind: "service",
      problem: "unknown_printer",
    });
  });

  it("findet den Drucker im Dienst: am Server unter seiner Kennung, am Pi den genannten oder den ersten", () => {
    const list = [service("erster", READY), service("ql800", OFF), service(usb.id, READY)];
    expect(serviceOf(probe(list), pi)?.name).toBe("erster");
    expect(serviceOf(probe(list), { ...pi, direct: { urls: [], token: "x", printer: "ql800" } })?.name).toBe("ql800");
    expect(serviceOf(probe(list), usb)?.name).toBe(usb.id);
    expect(serviceOf({ health: null }, usb)).toBeNull();
  });
});

describe("Rat je Fehler", () => {
  it("kennt jeden Code des Druckers und für Unbekanntes wenigstens den nächsten Schritt", () => {
    for (const code of Object.keys(PRINTER_ERROR_ADVICE)) {
      expect(adviceFor(code, { link: "pi", loaded: null, paper: null }).at(-1), code).toBe("Dann noch einmal „Verbindung prüfen“.");
    }
    expect(adviceFor("etwas_neues", { link: "pi", loaded: null, paper: null })).toEqual(["Dann noch einmal „Verbindung prüfen“."]);
    expect(adviceFor("config", { link: "usb", loaded: null, paper: null })[0]).toBe("Modell und Adresse unter „Bearbeiten“ prüfen.");
  });

  it("unterscheidet den Anschluss", () => {
    expect([pi, usb, network, image].map(printerLink)).toEqual(["pi", "usb", "network", "image"]);
  });

  it("gibt zum zuletzt gesehenen Zustand denselben Rat, ohne zu behaupten, der Dienst habe eben geantwortet", () => {
    const seen = { printer_id: pi.id, observed_at: "2026-11-16T10:00:00.000Z", boot_id: "boot", status: OFF, host: null };
    expect(seenAdvice(seen, pi, null)).toEqual({ title: "Der Drucker ist aus oder nicht verbunden.", advice: ["Drucker einschalten.", "USB-Kabel an Drucker und Pi prüfen.", "Dann noch einmal „Verbindung prüfen“."] });
    expect(seenAdvice({ ...seen, status: READY }, pi, null)).toBeNull();
    expect(seenAdvice({ ...seen, status: null }, pi, null)).toBeNull();
    expect(seenAdvice(undefined, pi, null)).toBeNull();
  });
});

describe("Papier und Druckdienst", () => {
  it("nennt Papiere aus dem Katalog, sonst aus Kennung oder Maßen", () => {
    expect(paperName("62", CATALOG)).toBe("62 mm endlos");
    expect(paperName("39x90", CATALOG)).toBe("38 × 90 mm gestanzt");
    expect(paperName("29")).toBe("29 mm endlos");
    expect(paperName("62x29")).toBe("62 × 29 mm gestanzt");
    expect(paperName({ id: null, kind: "die_cut", width_mm: 29, length_mm: 90 })).toBe("29 × 90 mm gestanzt");
    expect(paperName({ id: null, kind: "endless", width_mm: 62, length_mm: null })).toBe("62 mm endlos");
    expect(paperName(null)).toBeNull();
  });

  it("weiß, ab welcher Version ein Druckdienst Format 2 kann", () => {
    expect(["0.3.0", "0.4.0", "0.4.9"].map(rendersFormat2)).toEqual([false, false, false]);
    expect(["0.5.0", "0.5.0-rc.1", "0.6.2", "1.0.0", "unbekannt"].map(rendersFormat2)).toEqual([true, true, true, true, true]);
  });

  it("hält einen Druckdienst nur dann für zu alt, wenn das Papier Format 2 braucht: frisch geprüft vor gekoppelt", () => {
    expect(outdatedService(1, undefined, { version: "0.4.0" })).toBeNull();
    expect(outdatedService(2, undefined, { version: "0.4.0" })).toEqual({ version: "0.4.0" });
    expect(outdatedService(2, undefined, { version: "0.5.0" })).toBeNull();
    expect(outdatedService(2, undefined, { version: null })).toBeNull();
    expect(outdatedService(2, undefined, undefined)).toBeNull();
    // Nach dem Prüfen gilt die frische Angabe, auch gegen die Kopplung.
    expect(outdatedService(2, probe([], {}, { version: "0.4.0", template_schemas: undefined }), { version: "0.5.0" })).toEqual({ version: "0.4.0" });
    expect(outdatedService(2, probe([], {}, { version: "0.5.1" }), { version: "0.4.0" })).toBeNull();
  });
});
