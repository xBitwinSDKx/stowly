import { useState, type FormEvent } from "react";

import type { ScanResult } from "@/contract";
import { Button, dialogFocusAlways, TextField } from "@/ui/base";

import { parseManualInput } from "./scan-flow";
import styles from "./ScanPage.module.css";
import { MANUAL_ERRORS } from "./texts";

export interface ManualEntryProps {
  /** Die Eingabe ist gelesen: weiter wie nach einem Scan. */
  onSubmit: (result: ScanResult) => void;
  /** Die Eingabe liegt in einem Dialog und soll beim Öffnen den Fokus bekommen. */
  inDialog?: boolean;
}

/**
 * Eingabe von Hand als Ersatz für die Kamera: eine Packungs-ID oder ein Barcode.
 * Damit ist die Ansicht auch ohne Kamera und am Desktop bedienbar.
 */
export function ManualEntry({ onSubmit, inDialog = false }: ManualEntryProps) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = parseManualInput(text);
    if (!parsed.ok) {
      setError(MANUAL_ERRORS[parsed.reason]);
      return;
    }
    setText("");
    setError(null);
    onSubmit(parsed.result);
  }

  return (
    <form className={styles.manual} onSubmit={submit} noValidate>
      <TextField
        label="Packungs-ID oder Barcode"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
        }}
        error={error}
        hint="Die ID steht auf dem Etikett, z. B. A2B3C. Der Barcode ist die Zahl unter den Strichen."
        placeholder="A2B3C oder 4006381333931"
        autoComplete="off"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
        ref={inDialog ? dialogFocusAlways : undefined}
      />
      <Button type="submit" variant="primary" size="lg" block>
        Übernehmen
      </Button>
    </form>
  );
}
