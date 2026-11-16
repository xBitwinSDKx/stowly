import { useEffect, useRef, useState } from "react";

import { Button, cx } from "./base";
import { copyText } from "./copy";
import styles from "./CopyField.module.css";
import { CheckIcon, CopyIcon } from "./icons";

export interface CopyFieldProps {
  /** Der Text, etwa ein Befehl. */
  value: string;
  /** Wofür er steht, für Screenreader: „Befehl für den Pi". */
  label: string;
  className?: string;
}

/** So lange steht nach dem Kopieren „Kopiert" da. */
export const COPIED_MS = 2_000;

/**
 * Ein Text zum Kopieren, etwa ein Befehl: in gleich breiter Schrift, umbrechend, mit „Kopieren".
 * Danach steht zwei Sekunden „Kopiert" da (auch für Screenreader). Gelingt das Kopieren nicht
 * (alter Browser über http), markiert das Feld den Text, damit „Kopieren" des Systems ihn nimmt.
 *
 * Bewusst nicht im Fass `@/ui`: direkt importieren (`@/ui/CopyField`); es gehört zu den
 * nachgeladenen Teilen der Einrichtung.
 */
export function CopyField({ value, label, className }: CopyFieldProps) {
  const textRef = useRef<HTMLElement>(null);
  const [state, setState] = useState<"idle" | "copied" | "selected">("idle");

  useEffect(() => {
    if (state !== "copied") {
      return;
    }
    const timer = setTimeout(() => setState("idle"), COPIED_MS);
    return () => clearTimeout(timer);
  }, [state]);

  // Ein neuer Text: Was über den alten gesagt wurde, gilt nicht mehr.
  useEffect(() => {
    setState("idle");
  }, [value]);

  async function copy() {
    if (await copyText(value)) {
      setState("copied");
      return;
    }
    const node = textRef.current;
    const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
    if (node && selection) {
      const range = document.createRange();
      range.selectNodeContents(node);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    setState("selected");
  }

  return (
    <div role="group" aria-label={label} className={cx(styles.field, className)}>
      <code ref={textRef} className={styles.text}>
        {value}
      </code>
      <div className={styles.actions}>
        <Button size="sm" icon={state === "copied" ? <CheckIcon /> : <CopyIcon />} onClick={() => void copy()}>
          {state === "copied" ? "Kopiert" : "Kopieren"}
        </Button>
        <span className={styles.status} role="status" aria-live="polite">
          {state === "copied" ? "Kopiert" : state === "selected" ? "Markiert – jetzt kopieren." : ""}
        </span>
      </div>
    </div>
  );
}
