import { useMemo } from "react";

import { useCore, useLive, type HouseholdSettings, type Package, type Printer, type PrinterStatus, type PrintJob, type Product, type Zone } from "@/contract";

import { isOpenJob, viewJob, type JobView, type PrintData } from "./model";

export interface Printing {
  /** false, solange der Kern noch lädt. */
  ready: boolean;
  /** Alle Drucker, nach Name. */
  printers: readonly Printer[];
  /** Gibt es überhaupt einen Drucker? Ohne Drucker fordert Stowly keine Etiketten an. */
  hasPrinter: boolean;
  /** Alle Zonen in ihrer Reihenfolge. */
  zones: readonly Zone[];
  settings: HouseholdSettings | undefined;
  /** Zuletzt gesehener Zustand je Drucker; ohne Eintrag wurde er noch nie gesehen. */
  status: ReadonlyMap<string, PrinterStatus>;
  /** Die Live-Daten für die Regeln aus model.ts (`printerForZone`, `printerForPackage`). */
  data: PrintData;
  /** Alle Etiketten, neueste zuerst. */
  jobs: readonly JobView[];
  /** Ausgang unklar: Die App fragt nach. */
  asking: readonly JobView[];
  /** Ausstehend oder beim Drucker. */
  waiting: readonly JobView[];
  /** Eigene ausstehende Etiketten: Nur die stellt dieses Gerät zu. */
  ownPending: readonly JobView[];
  /** Zahl der noch nicht abgeschlossenen Etiketten (für das Drucker-Symbol und das Menü). */
  openCount: number;
  /** Kennung dieses Geräts oder null. */
  deviceId: string | null;
}

const NO_PRINTERS: Printer[] = [];
const NO_ZONES: Zone[] = [];
const NO_JOBS: PrintJob[] = [];
const NO_PACKAGES: Package[] = [];
const NO_PRODUCTS: Product[] = [];
const NO_STATUS: PrinterStatus[] = [];

function byId<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

/** Wie viele Etiketten noch offen sind und bei wie vielen davon die App nachfragt. */
export interface OpenLabels {
  /** Ausstehend, beim Drucker oder unklar. */
  open: number;
  /** Davon mit unklarem Ausgang: „Wurde das Etikett gedruckt?" */
  asking: number;
}

/** Die offenen Etiketten als Zahlen, ohne den Rest der Druckdaten zu lesen (Rahmen der App, Menü). */
export function useOpenLabels(): OpenLabels {
  const core = useCore();
  const jobs = useLive(core.data.printJobs);
  return useMemo(() => {
    const open = (jobs ?? NO_JOBS).filter(isOpenJob);
    return { open: open.length, asking: open.filter((job) => job.state === "unknown").length };
  }, [jobs]);
}

/** Drucker, ihr Zustand und die Etiketten, wie die Ansichten sie brauchen. Rendert bei jeder Änderung des Kerns neu. */
export function usePrinting(): Printing {
  const core = useCore();
  const printers = useLive(core.data.printers);
  const printerStatus = useLive(core.data.printerStatus);
  const printJobs = useLive(core.data.printJobs);
  const zones = useLive(core.data.zones);
  const settings = useLive(core.data.settings);
  const packages = useLive(core.data.packages);
  const removed = useLive(core.data.removedPackages);
  const products = useLive(core.data.products);
  const session = useLive(core.session.state);
  const deviceId = session?.status === "signed_in" ? session.device.id : null;

  const data = useMemo<PrintData>(
    () => ({
      printers: byId(printers ?? NO_PRINTERS),
      zones: byId(zones ?? NO_ZONES),
      // Auch entnommene Packungen: Ihre Etiketten stehen noch in der Liste.
      packages: byId([...(removed ?? NO_PACKAGES), ...(packages ?? NO_PACKAGES)]),
      products: byId(products ?? NO_PRODUCTS),
      settings,
    }),
    [printers, zones, packages, removed, products, settings],
  );

  const status = useMemo(() => new Map((printerStatus ?? NO_STATUS).map((entry) => [entry.printer_id, entry])), [printerStatus]);
  const jobs = useMemo(() => (printJobs ?? NO_JOBS).map((job) => viewJob(job, data, deviceId)), [printJobs, data, deviceId]);
  const asking = useMemo(() => jobs.filter((view) => view.group === "ask"), [jobs]);
  const waiting = useMemo(() => jobs.filter((view) => view.group === "waiting"), [jobs]);
  const ownPending = useMemo(() => waiting.filter((view) => view.own && view.job.state === "pending"), [waiting]);

  return {
    ready: printers !== undefined && printJobs !== undefined && zones !== undefined && settings !== undefined,
    printers: printers ?? NO_PRINTERS,
    hasPrinter: (printers?.length ?? 0) > 0,
    zones: zones ?? NO_ZONES,
    settings,
    status,
    data,
    jobs,
    asking,
    waiting,
    ownPending,
    openCount: asking.length + waiting.length,
    deviceId,
  };
}

/** Gibt es einen Drucker? Für Stellen, die nur das wissen müssen (Schalter „Etiketten", „Etikett drucken"). */
export function useHasPrinter(): boolean {
  const core = useCore();
  return (useLive(core.data.printers)?.length ?? 0) > 0;
}
