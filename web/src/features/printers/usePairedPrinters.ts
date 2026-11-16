import { useCallback, useEffect, useRef, useState } from "react";

import { useCore, useLive, type PairedPrinter } from "@/contract";

/**
 * Die gekoppelten Pi des Haushalts mit dem Ablauf ihrer Zertifikate (`SetupStatus.paired_printers`,
 * vom Server; jedes Gerät sieht so dieselbe Warnung). Geladen wird nur mit Verbindung zum Server
 * und noch einmal, sobald er wieder erreichbar ist; ohne ihn bleibt es beim zuletzt geladenen
 * Stand (anfangs keiner), ohne Fehlermeldung. `reload` fragt neu, etwa nach dem Neu-Koppeln.
 */
export function usePairedPrinters(): { paired: readonly PairedPrinter[]; reload: () => void } {
  const core = useCore();
  const online = useLive(core.sync.status)?.online === true;
  const [paired, setPaired] = useState<readonly PairedPrinter[]>([]);
  /** Nur die Antwort des jüngsten Aufrufs zählt. */
  const latest = useRef(0);

  const load = useCallback(() => {
    latest.current += 1;
    const call = latest.current;
    core.setup.load().then(
      (status) => {
        if (call === latest.current) {
          // Ein Server vor dieser Angabe lässt sie weg.
          setPaired(status.paired_printers ?? []);
        }
      },
      // Ohne Server, oder ein Server ohne Einrichtung: keine Warnung, kein Fehler.
      () => undefined,
    );
  }, [core]);

  useEffect(() => {
    if (online) {
      load();
    }
  }, [online, load]);

  const reload = useCallback(() => {
    if (core.sync.status.get()?.online === true) {
      load();
    }
  }, [core, load]);
  return { paired, reload };
}
