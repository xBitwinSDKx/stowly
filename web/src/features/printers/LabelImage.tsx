import { useEffect, useRef, useState } from "react";

import { isCoreError, useCore, useLive } from "@/contract";
import { errorText, Notice } from "@/ui";
import { Button, Spinner } from "@/ui/base";
import { CloudOffIcon } from "@/ui/icons";

import styles from "./LabelImage.module.css";

export interface LabelImageProps {
  /** Holt das Bild vom Kern: `() => core.print.preview(…)` oder `() => core.print.image(…)`. */
  load: () => Promise<Blob>;
  /** Wofür das Bild steht (Packungs-ID, Kennung des Etiketts). Ändert es sich, wird neu geladen. */
  source: string;
  /** Beschreibung des Bilds für Screenreader. */
  alt: string;
  /** Der Satz, wenn der Server fehlt. */
  offlineText?: string;
  className?: string;
}

type State = { status: "loading" } | { status: "ready"; url: string } | { status: "offline" } | { status: "error"; message: string };

/**
 * Ein Etikett als Bild: die Vorschau (`print.preview`) oder das, was ein Drucker mit
 * Bild-Treiber geschrieben hat (`print.image`).
 *
 * Das Bild ist 1 Bit, schwarz auf weiß. Es steht deshalb in jedem Thema auf weißem Grund und
 * wird beim Vergrößern nicht weichgezeichnet. Fehlt der Server, sagt die Ansicht das in Ruhe
 * und lädt von selbst nach, sobald er wieder da ist.
 */
export function LabelImage({ load, source, alt, offlineText = "Die Vorschau zeichnet der Server, und der ist gerade nicht erreichbar.", className }: LabelImageProps) {
  const core = useCore();
  const online = useLive(core.sync.status)?.online;
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const loadRef = useRef(load);

  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    setState({ status: "loading" });
    loadRef.current().then(
      (blob) => {
        if (cancelled) {
          return;
        }
        url = URL.createObjectURL(blob);
        setState({ status: "ready", url });
      },
      (error: unknown) => {
        if (cancelled) {
          return;
        }
        setState(
          isCoreError(error, "offline")
            ? { status: "offline" }
            : { status: "error", message: errorText(error, { not_found: "Zu diesem Etikett gibt es kein Bild.", internal: "Das Bild ließ sich nicht laden." }) },
        );
      },
    );
    return () => {
      cancelled = true;
      if (url !== null) {
        URL.revokeObjectURL(url);
      }
    };
  }, [source, attempt]);

  // Der Server ist wieder da: noch einmal versuchen, ohne dass jemand tippen muss.
  const offline = state.status === "offline";
  useEffect(() => {
    if (offline && online === true) {
      setAttempt((current) => current + 1);
    }
  }, [offline, online]);

  if (state.status === "offline") {
    return (
      <Notice
        tone="neutral"
        icon={<CloudOffIcon />}
        role="status"
        className={className}
        action={
          <Button size="sm" onClick={() => setAttempt((current) => current + 1)}>
            Erneut versuchen
          </Button>
        }
      >
        {offlineText}
      </Notice>
    );
  }
  if (state.status === "error") {
    return (
      <Notice tone="warn" role="alert" className={className}>
        {state.message}
      </Notice>
    );
  }
  return (
    <figure className={className ? `${styles.frame} ${className}` : styles.frame}>
      {state.status === "ready" ? <img src={state.url} alt={alt} className={styles.image} /> : <Spinner size={22} label="Das Etikett wird gezeichnet" />}
    </figure>
  );
}
