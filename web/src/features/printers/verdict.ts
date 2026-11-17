/**
 * Das Urteil über einen Drucker und der Rat je Fehler (docs/plan-0.5.md, 3): nach „Verbindung
 * prüfen" aus Dienst **und** Drucker, ohne neue Abfrage aus dem, was zuletzt gesehen wurde.
 *
 * - bereit (grün): Der Dienst antwortet, der Drucker ist bereit.
 * - Drucker (gelb): Der Dienst antwortet, der Drucker nicht oder nicht bereit; dazu der Rat.
 * - zu alt: Der Druckdienst kennt das Format der Vorlagen des Haushalts nicht (`outdated`).
 * - Dienst: Der Dienst selbst ist nicht benutzbar (wie bisher, `problemText` in model.ts).
 *
 * Reine Logik ohne React; die Sätze gehören der Oberfläche.
 */
import type { DriverStatus, LabelPaper, PairedPrinter, Printer, PrinterErrorCode, PrinterProbe, PrinterProblem, PrinterStatus, ServicePaper, ServicePrinter } from "@/contract";

import { printerErrorText } from "./model";

/** Wie ein Drucker angeschlossen ist: am Pi, per USB am Server, im Netzwerk, oder der Bild-Treiber. */
export type PrinterLink = "pi" | "usb" | "network" | "image";

export function printerLink(printer: Pick<Printer, "connection" | "server">): PrinterLink {
  if (printer.connection === "direct") {
    return "pi";
  }
  if (printer.server?.driver === "image") {
    return "image";
  }
  return printer.server?.address?.startsWith("usb://") ? "usb" : "network";
}

export interface AdviceContext {
  link: PrinterLink;
  /** Die eingelegte Rolle in Worten („62 mm endlos"); null = unbekannt. */
  loaded: string | null;
  /** Das Papier des Haushalts in Worten; null = unbekannt. */
  paper: string | null;
}

const CHECK_AGAIN = "Dann noch einmal „Verbindung prüfen“.";

/** Was bei einem Fehler des Druckers zu tun ist, Schritt für Schritt. */
export const PRINTER_ERROR_ADVICE: Record<PrinterErrorCode, (context: AdviceContext) => string[]> = {
  offline: ({ link }) =>
    link === "pi"
      ? ["Drucker einschalten.", "USB-Kabel an Drucker und Pi prüfen.", CHECK_AGAIN]
      : link === "usb"
        ? [
            "Drucker einschalten.",
            "USB-Kabel an Drucker und Server prüfen.",
            "Docker sieht einen frisch eingeschalteten Drucker manchmal erst nach einem Neustart von Stowly: Fehlt er weiter, Stowly neu starten.",
            CHECK_AGAIN,
          ]
        : ["Drucker einschalten.", "Netzwerkkabel oder WLAN des Druckers prüfen; seine Adresse muss zur Angabe unter „Bearbeiten“ passen.", CHECK_AGAIN],
  no_media: () => ["Eine Etikettenrolle einlegen.", CHECK_AGAIN],
  media_mismatch: ({ loaded, paper }) => [
    loaded && paper ? `Eingelegt ist ${loaded}; das Papier des Haushalts ist ${paper}.` : "Die eingelegte Rolle ist eine andere als das Papier des Haushalts.",
    "Die passende Rolle einlegen oder unter „Etiketten gestalten“ das Papier ändern.",
    CHECK_AGAIN,
  ],
  cover_open: () => ["Die Klappe des Druckers schließen.", CHECK_AGAIN],
  cutter_jam: () => ["Drucker ausschalten, eingeklemmtes Papier am Schneidwerk vorsichtig entfernen, wieder einschalten.", CHECK_AGAIN],
  overheated: () => ["Den Drucker ein paar Minuten abkühlen lassen.", CHECK_AGAIN],
  busy: () => ["Kurz warten, bis der Drucker fertig ist.", CHECK_AGAIN],
  config: ({ link }) => [link === "pi" ? "Modell und Rolle in der Konfiguration des Druckdienstes auf dem Pi prüfen." : "Modell und Adresse unter „Bearbeiten“ prüfen.", CHECK_AGAIN],
  unknown: () => ["Den Drucker aus- und wieder einschalten.", CHECK_AGAIN],
};

/** Der Rat zu einem Fehler; ein unbekannter Code bekommt nur den Hinweis, noch einmal zu prüfen. */
export function adviceFor(code: string, context: AdviceContext): string[] {
  return Object.hasOwn(PRINTER_ERROR_ADVICE, code) ? PRINTER_ERROR_ADVICE[code as PrinterErrorCode](context) : [CHECK_AGAIN];
}

function millimetres(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toLocaleString("de-DE");
}

/**
 * Ein Papier in Worten: aus dem Katalog des Servers, sonst aus der Kennung („62" ist „62 mm
 * endlos", „62x29" „62 × 29 mm gestanzt") oder, bei einer gemeldeten Rolle, aus Art und Maßen.
 */
export function paperName(paper: string | ServicePaper | null | undefined, catalog: readonly LabelPaper[] = []): string | null {
  if (paper === null || paper === undefined) {
    return null;
  }
  const id = typeof paper === "string" ? paper : paper.id;
  const known = id === null ? undefined : catalog.find((candidate) => candidate.id === id);
  if (known) {
    return known.name;
  }
  if (typeof paper !== "string") {
    return paper.kind === "die_cut" && paper.length_mm !== null
      ? `${millimetres(paper.width_mm)} × ${millimetres(paper.length_mm)} mm gestanzt`
      : `${millimetres(paper.width_mm)} mm endlos`;
  }
  const endless = /^(\d+)$/.exec(paper);
  if (endless) {
    return `${endless[1] ?? ""} mm endlos`;
  }
  const dieCut = /^(\d+)x(\d+)$/.exec(paper);
  return dieCut ? `${dieCut[1] ?? ""} × ${dieCut[2] ?? ""} mm gestanzt` : paper;
}

/** Der Drucker des Dienstes, um den es geht: am Server unter seiner Kennung, am Pi `direct.printer` oder der erste. */
export function serviceOf(probe: Pick<PrinterProbe, "health">, printer: Pick<Printer, "id" | "connection" | "direct">): ServicePrinter | null {
  const printers = probe.health?.printers ?? [];
  if (printer.connection === "server") {
    return printers.find((candidate) => candidate.name === printer.id) ?? null;
  }
  const name = printer.direct?.printer ?? null;
  return (name === null ? printers[0] : printers.find((candidate) => candidate.name === name)) ?? null;
}

/** Was mit dem Drucker nicht stimmt, als Code; null = bereit. */
function troubleOf(status: DriverStatus): string | null {
  if (!status.reachable) {
    return "offline";
  }
  const first = status.errors[0];
  if (first !== undefined) {
    return first;
  }
  if (status.media_detected === false) {
    return "no_media";
  }
  return status.ready === false ? "not_ready" : null;
}

/** Ein Hinweis zum Drucker: Was los ist, und was zu tun ist. */
export interface PrinterAdvice {
  title: string;
  advice: string[];
}

/**
 * Der Hinweis zum Zustand eines Druckers mit Rat; null, wenn er bereit ist. `answered`: Der Dienst
 * hat eben geantwortet (nach „Verbindung prüfen"); dann heißt „aus" ausdrücklich, dass der Pi oder
 * Server antwortet und nur der Drucker nicht.
 */
export function printerAdvice(status: DriverStatus, printer: Pick<Printer, "connection" | "server">, context: Omit<AdviceContext, "link">, answered: boolean): PrinterAdvice | null {
  const code = troubleOf(status);
  if (code === null) {
    return null;
  }
  const link = printerLink(printer);
  if (code === "not_ready") {
    return { title: "Der Drucker ist nicht bereit.", advice: PRINTER_ERROR_ADVICE.unknown({ ...context, link }) };
  }
  const title =
    code === "offline" && answered ? (link === "pi" ? "Der Pi antwortet, der Drucker nicht." : "Der Server antwortet, der Drucker nicht.") : printerErrorText(code);
  return { title, advice: adviceFor(code, { ...context, link }) };
}

export type ProbeVerdict =
  /** Dienst und Drucker bereit (grün): „Drucker bereit." `roll`: die eingelegte Rolle in Worten. */
  | { kind: "ready"; roll: string | null }
  /** Der Dienst antwortet, der Drucker nicht oder nicht bereit (gelb), mit Rat. */
  | { kind: "printer"; advice: PrinterAdvice; roll: string | null }
  /** Der Druckdienst ist zu alt für das Papier des Haushalts. */
  | { kind: "outdated"; version: string | null }
  /** Der Dienst selbst ist nicht benutzbar (wie bisher). */
  | { kind: "service"; problem: PrinterProblem };

/**
 * Das Urteil nach „Verbindung prüfen" aus Dienst und Drucker (`PrinterProbe` und dem Zustand des
 * Druckers in `health.printers`). `paper`: das Papier des Haushalts in Worten (für den Rat bei
 * falscher Rolle), `catalog` für die Namen der Rollen.
 */
export function probeVerdict(probe: PrinterProbe, printer: Pick<Printer, "id" | "connection" | "server" | "direct">, paper: string | null, catalog: readonly LabelPaper[] = []): ProbeVerdict {
  if (probe.problem === "outdated") {
    return { kind: "outdated", version: probe.health?.version ?? null };
  }
  if (probe.problem !== null) {
    return { kind: "service", problem: probe.problem };
  }
  const service = serviceOf(probe, printer);
  if (!service) {
    // Kein Drucker im Dienst, aber auch kein Grund vom Kern: wie „kennt den Drucker nicht".
    return { kind: "service", problem: "unknown_printer" };
  }
  const roll = paperName(service.loaded ?? null, catalog);
  const advice = printerAdvice(service.status, printer, { loaded: roll, paper }, true);
  return advice ? { kind: "printer", advice, roll } : { kind: "ready", roll };
}

/** Kann ein Druckdienst dieser Version Vorlagen im Format 2? Erst ab 0.5.0 (auch ihre Vorabversionen). */
export function rendersFormat2(version: string): boolean {
  const match = /^(\d+)\.(\d+)/.exec(version.trim());
  if (!match) {
    return true;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 0 || minor >= 5;
}

/**
 * Ist der Druckdienst des Pi zu alt für das Papier des Haushalts? Nach „Verbindung prüfen" gilt die
 * frische Angabe (`template_schemas`), sonst die Version vom Koppeln (`PairedPrinter.version`).
 * Liefert die Version, wenn er zu alt ist; sonst null.
 */
export function outdatedService(schema: number, probe: PrinterProbe | undefined, paired: Pick<PairedPrinter, "version"> | undefined): { version: string | null } | null {
  if (schema < 2) {
    return null;
  }
  if (probe?.health) {
    return (probe.health.template_schemas ?? [1]).includes(schema) ? null : { version: probe.health.version };
  }
  const version = paired?.version ?? null;
  return version !== null && !rendersFormat2(version) ? { version } : null;
}

/** Der Hinweis zum zuletzt gesehenen Zustand eines Druckers (ohne neue Abfrage); null, wenn es keinen gibt. */
export function seenAdvice(seen: PrinterStatus | undefined, printer: Pick<Printer, "connection" | "server">, paper: string | null): PrinterAdvice | null {
  if (!seen?.status) {
    return null;
  }
  return printerAdvice(seen.status, printer, { loaded: null, paper }, false);
}
