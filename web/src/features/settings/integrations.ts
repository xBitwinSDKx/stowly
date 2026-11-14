import { useCallback, useEffect, useRef, useState } from "react";

import { isCoreError, useCore, useLive, type IntegrationStatus } from "@/contract";
import { errorText } from "@/ui";

/** Der Zustand von Sicherung, Home Assistant und Push, wie ihn der Server meldet. */
export type IntegrationsState =
  | { status: "loading" }
  | { status: "ready"; value: IntegrationStatus }
  /** `offline`: Der Server ist nicht erreichbar; dann fehlt der Zustand, mehr nicht. */
  | { status: "error"; offline: boolean; message: string };

/**
 * Lädt den Zustand der Integrationen, solange die Einstellungen offen sind: beim Öffnen und noch
 * einmal, sobald der Server wieder erreichbar ist (docs/integrationen.md, Abschnitt 8). Er enthält
 * nie einen Token; öffentliche Schlüssel nur gekürzt.
 */
export function useIntegrations(): { state: IntegrationsState; reload: () => void } {
  const core = useCore();
  const online = useLive(core.sync.status)?.online;
  const [state, setState] = useState<IntegrationsState>({ status: "loading" });
  /** Nur die Antwort des jüngsten Aufrufs zählt. */
  const latest = useRef(0);

  const load = useCallback(async () => {
    latest.current += 1;
    const call = latest.current;
    // Ein schon geladener Zustand bleibt stehen, bis der neue da ist.
    setState((current) => (current.status === "ready" ? current : { status: "loading" }));
    try {
      const value = await core.integrations.load();
      if (call === latest.current) {
        setState({ status: "ready", value });
      }
    } catch (caught) {
      if (call === latest.current) {
        setState({
          status: "error",
          offline: isCoreError(caught, "offline"),
          message: errorText(caught, { offline: "Den Zustand kennt nur der Server, und der ist gerade nicht erreichbar." }),
        });
      }
    }
  }, [core]);

  useEffect(() => {
    void load();
  }, [load, online]);

  const reload = useCallback(() => void load(), [load]);
  return { state, reload };
}
