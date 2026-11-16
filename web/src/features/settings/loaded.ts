import { useCallback, useEffect, useRef, useState } from "react";

import { isCoreError, useCore, useLive, type CoreErrorCode } from "@/contract";
import { errorText } from "@/ui";

/** Ein Wert, den nur der Server kennt: wird geladen, ist da, oder fehlt (mit Grund). */
export type Loaded<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  /** `offline`: Der Server ist nicht erreichbar; `code` sagt, was er sonst geantwortet hat. */
  | { status: "error"; offline: boolean; code: CoreErrorCode | null; message: string };

export interface LoadedResource<T> {
  state: Loaded<T>;
  /** Lädt neu; ein schon geladener Wert bleibt stehen, bis der neue da ist. */
  reload: () => void;
  /** Übernimmt einen Wert, den eine Aktion schon geliefert hat (die Antwort auf ein Ändern). */
  set: (value: T) => void;
}

/**
 * Lädt einen Wert vom Server, solange die Ansicht offen ist: beim Öffnen und noch einmal, sobald
 * der Server wieder erreichbar ist (Muster `useIntegrations`). Nur die Antwort des jüngsten Aufrufs
 * zählt. `offlineText` sagt, was ohne Server fehlt.
 */
export function useLoaded<T>(load: () => Promise<T>, offlineText: string): LoadedResource<T> {
  const core = useCore();
  const online = useLive(core.sync.status)?.online;
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  const latest = useRef(0);
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  });

  const run = useCallback(async () => {
    latest.current += 1;
    const call = latest.current;
    setState((current) => (current.status === "ready" ? current : { status: "loading" }));
    try {
      const value = await loader.current();
      if (call === latest.current) {
        setState({ status: "ready", value });
      }
    } catch (caught) {
      if (call === latest.current) {
        setState({ status: "error", offline: isCoreError(caught, "offline"), code: isCoreError(caught) ? caught.code : null, message: errorText(caught, { offline: offlineText }) });
      }
    }
  }, [offlineText]);

  useEffect(() => {
    void run();
  }, [run, online]);

  const reload = useCallback(() => void run(), [run]);
  const set = useCallback((value: T) => {
    // Eine laufende Antwort ist damit überholt.
    latest.current += 1;
    setState({ status: "ready", value });
  }, []);
  return { state, reload, set };
}

/** Der Wert, wenn er geladen ist; sonst null. */
export function loadedValue<T>(state: Loaded<T>): T | null {
  return state.status === "ready" ? state.value : null;
}
