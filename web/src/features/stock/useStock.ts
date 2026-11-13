import { useMemo } from "react";

import { useCore, useLive, type HouseholdSettings, type Product, type Zone } from "@/contract";
import { useToday } from "@/ui";

import { buildEntries, countWarnings, type StockEntry, type WarningCount } from "./model";

export interface StockData {
  /** false, solange der Kern noch lädt: Die Ansichten zeigen dann einen Platzhalter. */
  ready: boolean;
  /** Jede Packung des Bestands mit Produkt, Zone und Warnstufe. */
  entries: StockEntry[];
  products: Product[];
  /** Alle Zonen in ihrer Reihenfolge. */
  zones: Zone[];
  settings: HouseholdSettings | undefined;
  /** Heute als "YYYY-MM-DD". */
  today: string;
  /**
   * Gibt es mehr als eine Zone? Nur dann zeigt die Oberfläche überhaupt etwas zu Zonen
   * (Karten, Spalte, Filter, Navigationspunkt).
   */
  multiZone: boolean;
  /** Abgelaufene und bald ablaufende Packungen. */
  warnings: WarningCount;
}

const NO_PRODUCTS: Product[] = [];
const NO_ZONES: Zone[] = [];
const NO_ENTRIES: StockEntry[] = [];

/** Der Bestand, wie ihn die Ansichten brauchen. Rendert bei jeder Änderung des Kerns neu. */
export function useStock(): StockData {
  const core = useCore();
  const packages = useLive(core.data.packages);
  const products = useLive(core.data.products);
  const zones = useLive(core.data.zones);
  const settings = useLive(core.data.settings);
  const today = useToday();

  const ready = packages !== undefined && products !== undefined && zones !== undefined && settings !== undefined;

  const entries = useMemo(
    () => (packages && settings ? buildEntries(packages, products ?? NO_PRODUCTS, zones ?? NO_ZONES, settings, today) : NO_ENTRIES),
    [packages, products, zones, settings, today],
  );
  const warnings = useMemo(() => countWarnings(entries), [entries]);

  return {
    ready,
    entries,
    products: products ?? NO_PRODUCTS,
    zones: zones ?? NO_ZONES,
    settings,
    today,
    multiZone: (zones?.length ?? 0) > 1,
    warnings,
  };
}
