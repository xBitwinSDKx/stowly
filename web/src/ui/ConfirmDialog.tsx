import { useState, type ReactNode } from "react";

import { Button, Dialog, dialogFocus } from "./base";
import styles from "./ConfirmDialog.module.css";

export interface ConfirmDialogProps {
  open: boolean;
  /** Abbrechen, Escape, Tippen daneben. */
  onClose: () => void;
  title: string;
  /** Was passiert, in ein, zwei Sätzen. */
  children: ReactNode;
  /** Beschriftung der Hauptaktion, z. B. „Löschen". */
  confirmLabel: string;
  /** Vorgabe „Abbrechen". */
  cancelLabel?: string;
  /** "danger" für alles, was sich nicht umkehren lässt. Vorgabe "primary". */
  tone?: "primary" | "danger";
  /**
   * Führt die Aktion aus. Solange sie läuft, sind die Schaltflächen gesperrt.
   * Geschlossen wird vom Aufrufer (in `onConfirm` oder danach über `open`).
   * Wirft die Aktion, bleibt der Dialog offen und zeigt `errorText(error)`.
   */
  onConfirm: () => void | Promise<void>;
  /** Übersetzt einen Fehler der Aktion in einen Satz. Vorgabe: ein allgemeiner Satz. */
  errorText?: (error: unknown) => string;
}

/** Rückfrage vor einer Aktion mit Folgen. */
export function ConfirmDialog({
  open,
  onClose,
  title,
  children,
  confirmLabel,
  cancelLabel = "Abbrechen",
  tone = "primary",
  onConfirm,
  errorText,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (caught) {
      setError(errorText ? errorText(caught) : "Das hat nicht geklappt. Bitte noch einmal versuchen.");
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setError(null);
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      // Solange die Aktion läuft, schließen weder ✕ noch Escape; „Abbrechen" ist gesperrt.
      busy={busy}
      title={title}
      size="sm"
      variant="sheet"
      footer={
        <>
          {/* Der Fokus beginnt auf der sicheren Wahl: bei Folgenschwerem auf „Abbrechen". */}
          <Button ref={tone === "danger" ? dialogFocus : undefined} onClick={close} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button ref={tone === "danger" ? undefined : dialogFocus} variant={tone} busy={busy} onClick={() => void confirm()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        {children}
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
