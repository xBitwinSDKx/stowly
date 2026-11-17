import { useEffect, useMemo, useState } from "react";

import { useCore, useLive, type LabelPaper, type LabelTemplatesInfo } from "@/contract";

import { paperName } from "./verdict";

/**
 * Der Papier-Katalog des Servers, wie ihn „Etiketten gestalten" in dieser Sitzung zuletzt geladen
 * hat. Er dient nur den Namen; ohne ihn entsteht der Name aus der Kennung (`paperName`).
 */
let knownPapers: readonly LabelPaper[] = [];

export function rememberPapers(papers: readonly LabelPaper[]): void {
  knownPapers = papers;
}

export function rememberedPapers(): readonly LabelPaper[] {
  return knownPapers;
}

export interface HouseholdPaper extends LabelTemplatesInfo {
  /** Anzeigename des Papiers; null, solange keine Vorlage da ist. */
  name: string | null;
}

/**
 * Was die Vorlagen im Sync über das Papier des Haushalts sagen (`labels.templates`, ohne Server).
 * Gelesen wird beim ersten Zeichnen und nach jeder Änderung des Abgleichs; null, solange nichts
 * gelesen ist.
 */
export function useHouseholdPaper(): HouseholdPaper | null {
  const core = useCore();
  const status = useLive(core.sync.status);
  const [info, setInfo] = useState<LabelTemplatesInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    core.labels.templates().then(
      (next) => {
        if (!cancelled) {
          setInfo((current) => (current && JSON.stringify(current) === JSON.stringify(next) ? current : next));
        }
      },
      // Ohne den nachgeladenen Teil des Kerns (kein Netz, kein Service Worker): beim nächsten Abgleich.
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [core, status]);
  return useMemo(() => (info ? { ...info, name: paperName(info.paper, knownPapers) } : null), [info]);
}
