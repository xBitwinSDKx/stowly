import { useCallback, useEffect, useRef, useState } from "react";

import { isCoreError, nowTimestamp, useCore, useLive, type Stats } from "@/contract";
import { errorText } from "@/ui";

import { PERIODS, statsRange } from "./model";

export interface StatsState {
  /** Der gewählte Zeitraum in Monaten. */
  months: number;
  /** Die zuletzt geladene Statistik; sie bleibt stehen, während neu geladen wird, und ohne Verbindung. */
  stats: Stats | null;
  /** Wann sie geladen wurde (Vertrags-Zeitstempel). */
  loadedAt: string | null;
  loading: boolean;
  /** Der letzte Versuch ist gescheitert; `offline`: Der Server war nicht erreichbar. */
  error: { offline: boolean; message: string } | null;
}

/**
 * Lädt die Statistik vom Server (`core.stats.load`): beim Öffnen, beim Wechsel des Zeitraums, auf
 * Wunsch und noch einmal, sobald der Server wieder erreichbar ist. Gespeichert wird sie nirgends;
 * die zuletzt geladene bleibt stehen, bis eine neue da ist. Nur die Antwort des jüngsten Aufrufs zählt.
 */
export function useStats(): { state: StatsState; choose: (months: number) => void; reload: () => void } {
  const core = useCore();
  const online = useLive(core.sync.status)?.online;
  const [state, setState] = useState<StatsState>({ months: PERIODS[0] ?? 12, stats: null, loadedAt: null, loading: true, error: null });
  const latest = useRef(0);
  /** Zeitzone des Servers aus der letzten Antwort: Ein längerer Zeitraum endet mit seinem laufenden Monat. */
  const zone = useRef<string | null>(null);

  const load = useCallback(
    async (months: number) => {
      latest.current += 1;
      const call = latest.current;
      setState((current) => ({ ...current, months, loading: true }));
      try {
        const stats = await core.stats.load(statsRange(months, zone.current));
        if (call === latest.current) {
          zone.current = stats.timezone;
          setState({ months, stats, loadedAt: nowTimestamp(), loading: false, error: null });
        }
      } catch (caught) {
        if (call === latest.current) {
          setState((current) => ({
            ...current,
            loading: false,
            error: {
              offline: isCoreError(caught, "offline"),
              message: errorText(caught, { offline: "Die Statistik rechnet der Server, und der ist gerade nicht erreichbar." }),
            },
          }));
        }
      }
    },
    [core],
  );

  // Beim Öffnen die Vorgabe.
  useEffect(() => {
    void load(PERIODS[0] ?? 12);
  }, [load]);

  // Kommt der Server zurück, gleich noch einmal: Ohne ihn gibt es keine Statistik.
  const seen = useRef(online);
  const months = state.months;
  useEffect(() => {
    const before = seen.current;
    seen.current = online;
    if (online === true && before !== true && before !== undefined) {
      void load(months);
    }
  }, [online, load, months]);

  const choose = useCallback(
    (next: number) => {
      void load(next);
    },
    [load],
  );
  const reload = useCallback(() => void load(months), [load, months]);
  return { state, choose, reload };
}
