import { useCallback, useEffect, useRef, useState } from "react";

import { useCore, type CookIdeasInput, type CookJob } from "@/contract";

/** Wo ein Auftrag gerade steht, aus Sicht der Seite. */
export type CookView =
  | { phase: "idle" }
  /** `ai.start` ist unterwegs. */
  | { phase: "starting" }
  | { phase: "running"; job: CookJob }
  /** Fertig: "done" mit Vorschlägen oder "failed" mit `problem`. */
  | { phase: "finished"; job: CookJob }
  /** Der Start oder das Warten ist gescheitert (ein `CoreError`). */
  | { phase: "error"; error: unknown };

/**
 * Wann dieses Gerät einen Auftrag gestartet hat, nach seiner eigenen Uhr: Die Sekunden des Fortschritts
 * zählen ab da, auch nach einem Wechsel der Seite. Für Aufträge, die die Seite hier nicht kennt, gilt
 * `started_at` des Servers.
 */
const startedHere = new Map<string, number>();

/** Seit wann ein Auftrag läuft, in Millisekunden nach der Uhr dieses Geräts. */
export function startedAt(job: Pick<CookJob, "id" | "started_at">): number {
  return startedHere.get(job.id) ?? Date.parse(job.started_at);
}

/**
 * Ein Auftrag für Vorschläge von Claude, solange die Seite offen ist: starten, auf das Ende warten, und
 * beim Öffnen der Seite zu einem schon laufenden oder fertigen zurückfinden (`ai.lastJob`). Verlässt man
 * die Seite, hört nur das Warten auf; der Auftrag läuft am Server weiter.
 */
export function useCookJob(): { view: CookView; start: (input: CookIdeasInput) => void } {
  const core = useCore();
  const [view, setView] = useState<CookView>({ phase: "idle" });
  const current = useRef<AbortController | null>(null);

  const follow = useCallback(
    async (job: CookJob, controller: AbortController) => {
      setView(job.state === "running" ? { phase: "running", job } : { phase: "finished", job });
      if (job.state !== "running") {
        return;
      }
      try {
        const done = await core.ai.wait(job.id, {
          signal: controller.signal,
          onTick: (tick) => {
            if (!controller.signal.aborted) {
              setView({ phase: "running", job: tick });
            }
          },
        });
        if (!controller.signal.aborted) {
          setView({ phase: "finished", job: done });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setView({ phase: "error", error });
        }
      }
    },
    [core],
  );

  // Beim Öffnen: Gibt es einen Auftrag dieses Geräts, zeigt die Seite ihn (oder wartet weiter).
  useEffect(() => {
    const controller = new AbortController();
    current.current = controller;
    void (async () => {
      try {
        const id = await core.ai.lastJob();
        if (id === null || controller.signal.aborted) {
          return;
        }
        const job = await core.ai.job(id);
        if (!controller.signal.aborted) {
          await follow(job, controller);
        }
      } catch {
        // Abgelaufen, ein Neustart des Servers, keine Verbindung: Dann gibt es eben nichts zu zeigen.
      }
    })();
    return () => {
      controller.abort();
    };
  }, [core, follow]);

  const start = useCallback(
    (input: CookIdeasInput) => {
      current.current?.abort();
      const controller = new AbortController();
      current.current = controller;
      setView({ phase: "starting" });
      void (async () => {
        try {
          const job = await core.ai.start(input);
          startedHere.set(job.id, Date.now());
          if (!controller.signal.aborted) {
            await follow(job, controller);
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            setView({ phase: "error", error });
          }
        }
      })();
    },
    [core, follow],
  );

  // Verlässt man die Seite, endet das Warten.
  useEffect(
    () => () => {
      current.current?.abort();
    },
    [],
  );

  return { view, start };
}
