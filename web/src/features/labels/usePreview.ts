import { useCallback, useEffect, useRef, useState } from "react";

import { isCoreError, useCore, type LabelPreview, type LabelPreviewInput } from "@/contract";
import { errorText } from "@/ui";

import { PREVIEW_DEBOUNCE_MS, PREVIEWS_AT_ONCE } from "./model";

/** Warum gerade keine (neue) Vorschau da ist. */
export interface PreviewProblem {
  /** "invalid": So passt es nicht (der Satz des Servers). "offline": ohne Server. "error": sonst. */
  kind: "invalid" | "offline" | "error";
  message: string;
}

export interface PreviewView {
  /** Die zuletzt gezeichnete Vorschau; null, solange es keine gibt. */
  preview: LabelPreview | null;
  /** Gilt für die jüngste Anfrage; die Vorschau darüber ist dann die letzte, die ging. */
  problem: PreviewProblem | null;
  /** Eine neuere Vorschau ist unterwegs (oder wartet auf das Ende der Eingabe). */
  busy: boolean;
}

/** Bei 429 (doch zu viele zugleich, etwa aus einem zweiten Tab): so lange warten, dann noch einmal. */
const RETRY_MS = 1_000;

/**
 * Die Vorschau eines Etiketts, wie sie der Server rendert (`labels.preview`): erst 300 ms nach
 * der letzten Änderung, höchstens zwei Anfragen zugleich. Eine dritte wartet, bis eine fertig
 * ist, und fragt dann nach dem neuesten Stand. Eine ältere Antwort überschreibt nie eine neuere.
 * `enabled: false` (ohne Server) fragt nicht.
 */
export function usePreview(input: LabelPreviewInput | null, enabled: boolean): PreviewView {
  const core = useCore();
  const [view, setView] = useState<PreviewView>({ preview: null, problem: null, busy: false });
  /** Die jüngste Eingabe mit ihrer laufenden Nummer. */
  const latest = useRef<{ seq: number; input: LabelPreviewInput | null }>({ seq: 0, input: null });
  /** Die Nummer der Eingabe, deren Antwort zuletzt gezeigt wurde. */
  const shown = useRef(0);
  /** Die Nummer der Eingabe, die zuletzt hinausging. */
  const sent = useRef(0);
  const inFlight = useRef(0);
  const waiting = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const send = useCallback(() => {
    const { seq, input: wanted } = latest.current;
    if (wanted === null || seq <= sent.current) {
      return;
    }
    if (inFlight.current >= PREVIEWS_AT_ONCE) {
      waiting.current = true;
      return;
    }
    inFlight.current += 1;
    sent.current = seq;
    const settle = (next: (current: PreviewView) => PreviewView) => {
      if (alive.current && seq > shown.current) {
        shown.current = seq;
        setView((current) => ({ ...next(current), busy: seq < latest.current.seq }));
      }
    };
    core.labels
      .preview(wanted)
      .then(
        (preview) => settle(() => ({ preview, problem: null, busy: false })),
        (error: unknown) => {
          if (isCoreError(error, "rate_limited")) {
            // Der Server rendert gerade schon zwei: gleich noch einmal, mit dem dann neuesten Stand.
            if (sent.current === seq) {
              sent.current = seq - 1;
            }
            setTimeout(() => {
              if (alive.current) {
                send();
              }
            }, RETRY_MS);
            return;
          }
          const problem: PreviewProblem = isCoreError(error, "invalid")
            ? { kind: "invalid", message: error.message }
            : isCoreError(error, "offline")
              ? { kind: "offline", message: "Die Vorschau zeichnet der Server, und der ist gerade nicht erreichbar." }
              : { kind: "error", message: errorText(error) };
          settle((current) => ({ ...current, problem }));
        },
      )
      .finally(() => {
        inFlight.current -= 1;
        if (waiting.current) {
          waiting.current = false;
          send();
        }
      });
  }, [core]);

  const key = input === null ? "" : JSON.stringify(input);
  useEffect(() => {
    if (!enabled || input === null) {
      return;
    }
    latest.current = { seq: latest.current.seq + 1, input };
    setView((current) => (current.busy ? current : { ...current, busy: true }));
    const timer = setTimeout(send, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // Die Eingabe zählt nach ihrem Inhalt (`key`), nicht nach ihrer Identität.
  }, [key, enabled, send]);

  return view;
}
