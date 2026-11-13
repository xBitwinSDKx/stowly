import { useEffect, useId, useRef, type MouseEvent, type ReactNode, type SyntheticEvent } from "react";

import { cx } from "./cx";
import styles from "./Dialog.module.css";

export interface DialogProps {
  /** Der Aufrufer hält den Zustand: Der Dialog ist genau dann sichtbar, wenn `open` wahr ist. */
  open: boolean;
  /** Wird gerufen, wenn der Anwender schließen will (Escape, Tippen neben den Dialog, ✕). */
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Schaltflächen am unteren Rand, die Hauptaktion zuletzt. */
  footer?: ReactNode;
  /** Breite am Desktop. Vorgabe "md". */
  size?: "sm" | "md" | "lg";
  /**
   * - "dialog": mittig
   * - "sheet": am Handy von unten eingeschoben, mit dem Daumen erreichbar; am Desktop mittig
   * Vorgabe "dialog".
   */
  variant?: "dialog" | "sheet";
  /** false: nur über die Schaltflächen im Inhalt schließbar (kein Escape, kein ✕). Vorgabe true. */
  dismissable?: boolean;
  className?: string;
}

/**
 * Modaler Dialog auf Basis von `<dialog>`: Der Browser hält den Fokus im Dialog,
 * sperrt den Rest der Seite und gibt den Fokus beim Schließen zurück.
 *
 * Der Inhalt wird nur gerendert, solange der Dialog offen ist. Eingaben darin
 * beginnen also bei jedem Öffnen frisch.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  size = "md",
  variant = "dialog",
  dismissable = true,
  className,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    if (open && !element.open) {
      if (typeof element.showModal === "function") {
        element.showModal();
      } else {
        // Umgebungen ohne showModal (Tests): wenigstens sichtbar machen.
        element.setAttribute("open", "");
      }
    } else if (!open && element.open) {
      if (typeof element.close === "function") {
        element.close();
      } else {
        element.removeAttribute("open");
      }
    }
  }, [open]);

  function handleCancel(event: SyntheticEvent<HTMLDialogElement>) {
    // Escape: Der Zustand gehört dem Aufrufer, also nicht selbst schließen.
    event.preventDefault();
    if (dismissable) {
      onClose();
    }
  }

  function handleClick(event: MouseEvent<HTMLDialogElement>) {
    // Ein Klick auf das <dialog> selbst trifft die Fläche neben dem Inhalt.
    if (dismissable && event.target === event.currentTarget) {
      onClose();
    }
  }

  return (
    <dialog
      ref={ref}
      className={cx(styles.dialog, styles[variant], styles[size], className)}
      aria-labelledby={titleId}
      onCancel={handleCancel}
      onClick={handleClick}
    >
      {open ? (
        <div className={styles.panel}>
          <header className={styles.header}>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            {dismissable ? (
              <button type="button" className={styles.close} aria-label="Schließen" onClick={onClose}>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            ) : null}
          </header>
          <div className={styles.body}>{children}</div>
          {footer ? <footer className={styles.footer}>{footer}</footer> : null}
        </div>
      ) : null}
    </dialog>
  );
}
