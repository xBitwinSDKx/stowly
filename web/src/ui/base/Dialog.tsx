import { useEffect, useId, useLayoutEffect, useRef, type MouseEvent, type ReactNode, type RefObject, type SyntheticEvent } from "react";

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

const FOCUS_ATTRIBUTE = "data-dialog-focus";

function markFocus(mode: "pointer" | "always") {
  return (element: HTMLElement | null): void => {
    element?.setAttribute(FOCUS_ATTRIBUTE, mode);
  };
}

/**
 * `ref` für das Element, das beim Öffnen eines `Dialog` den Fokus bekommt:
 * `<TextField ref={dialogFocus} />`. Gilt für das erste so markierte Element im Dialog.
 * Bei Fingerbedienung bleibt der Fokus am Dialog selbst: Sonst spränge mit jedem Dialog
 * sofort die Bildschirmtastatur auf.
 */
export const dialogFocus = markFocus("pointer");

/**
 * Wie `dialogFocus`, aber auch bei Fingerbedienung: Die Bildschirmtastatur öffnet sich
 * sofort. Für Dialoge, deren einziger Zweck die Eingabe ist (MHD nach dem Scannen).
 */
export const dialogFocusAlways = markFocus("always");

function coarsePointer(): boolean {
  return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

/** Gibt den Fokus an das Element zurück, das ihn vor dem Öffnen hatte, wenn er nicht schon woanders gebraucht wird. */
function restoreFocus(dialog: HTMLElement, opener: RefObject<HTMLElement | null>): void {
  const target = opener.current;
  opener.current = null;
  const active = document.activeElement;
  const lost = active === null || active === document.body || dialog.contains(active);
  if (target && target.isConnected && lost) {
    target.focus({ preventScroll: true });
  }
}

/** Zeigt den Dialog modal an; Umgebungen ohne showModal (Tests) bekommen wenigstens das Attribut. */
function showModal(element: HTMLDialogElement): void {
  if (typeof element.showModal === "function") {
    element.showModal();
  } else {
    element.setAttribute("open", "");
  }
}

/**
 * Modaler Dialog auf Basis von `<dialog>`: Der Browser hält den Fokus im Dialog und
 * sperrt den Rest der Seite.
 *
 * Fokus: Beim Öffnen bekommt ihn das mit `dialogFocus` (oder `dialogFocusAlways`) markierte
 * Element, sonst der Dialog selbst, nie die Schaltfläche zum Schließen: Ein Druck auf Enter
 * schließt so nichts versehentlich. Beim Schließen geht der Fokus zurück an das Element, das
 * ihn vorher hatte, auch wenn der Dialog im offenen Zustand aus dem Baum fällt. Verschwindet im
 * offenen Dialog das Element mit dem Fokus, geht er an den Dialog selbst.
 *
 * Offen ist der Dialog genau so lange, wie `open` es sagt: Schließt der Browser ihn auf Escape
 * von sich aus, obwohl der Aufrufer ihn offen hält (`dismissable={false}`, oder `onClose` tut
 * gerade nichts), öffnet er sich sofort wieder.
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
  const panelRef = useRef<HTMLDivElement>(null);
  /** Wer den Fokus hatte, bevor der Dialog sich öffnete. */
  const openerRef = useRef<HTMLElement | null>(null);
  /** Der zuletzt gezeichnete Wert von `open`, für Ereignisse, die nach dem Zeichnen eintreffen. */
  const openRef = useRef(open);
  const titleId = useId();

  // Im Layout-Effekt: Er läuft noch beim Übernehmen der Änderung, also sicher vor dem
  // close-Ereignis, das der Browser nach einem Escape als eigene Aufgabe nachreicht.
  useLayoutEffect(() => {
    openRef.current = open;
  });

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    if (open && !element.open) {
      const before = document.activeElement;
      openerRef.current = before instanceof HTMLElement && !element.contains(before) ? before : null;
      showModal(element);
      // Anfangsfokus: das markierte Element, sonst der Dialog selbst (nicht das Schließen-Kreuz).
      const coarse = coarsePointer();
      const wanted = Array.from(element.querySelectorAll<HTMLElement>(`[${FOCUS_ATTRIBUTE}]`)).find(
        (candidate) => candidate.getAttribute(FOCUS_ATTRIBUTE) === "always" || !coarse,
      );
      const active = document.activeElement;
      // Ein Element mit dem HTML-Attribut `autofocus` hat der Browser schon gewählt: so lassen.
      const chosen = active instanceof HTMLElement && element.contains(active) && active.hasAttribute("autofocus");
      if (wanted) {
        wanted.focus({ preventScroll: true });
      } else if (!chosen) {
        panelRef.current?.focus({ preventScroll: true });
      }
    } else if (!open) {
      if (element.open) {
        if (typeof element.close === "function") {
          element.close();
        } else {
          element.removeAttribute("open");
        }
      }
      // Auch wenn der Browser den Dialog schon selbst geschlossen hat (Escape, siehe handleClose).
      if (openerRef.current) {
        restoreFocus(element, openerRef);
      }
    }
  }, [open]);

  // Fällt der Fokus im offenen Dialog ins Leere, weil das Element verschwunden ist, das ihn hatte
  // (der Inhalt wechselt vom Formular zum Ergebnis), nimmt ihn der Dialog selbst wieder auf:
  // Die Tabulatortaste führt dann weiter durch den Dialog statt an den Anfang der Seite.
  useEffect(() => {
    const element = ref.current;
    if (!open || !element?.hasAttribute("open")) {
      return;
    }
    const active = document.activeElement;
    if (active === null || active === document.body) {
      panelRef.current?.focus({ preventScroll: true });
    }
  });

  useEffect(() => {
    const element = ref.current;
    return () => {
      // Der Dialog fällt im offenen Zustand aus dem Baum: Der Browser gibt den Fokus dann nicht zurück.
      // Nur wenn er wirklich weg ist: Im StrictMode räumt React probeweise auf, der Dialog bleibt
      // dabei stehen, und wer ihn geöffnet hat, muss für das echte Schließen bekannt bleiben.
      // Hat der Browser ihn vorher schon selbst geschlossen (Escape), gilt dasselbe.
      if (element && !element.isConnected && (element.hasAttribute("open") || openerRef.current !== null)) {
        restoreFocus(element, openerRef);
      }
    };
  }, []);

  function handleCancel(event: SyntheticEvent<HTMLDialogElement>) {
    // Escape: Der Zustand gehört dem Aufrufer, also nicht selbst schließen.
    event.preventDefault();
    if (dismissable) {
      onClose();
    }
  }

  function handleClose() {
    // Nicht jedes Escape lässt sich abfangen: Chrome schließt einen Dialog trotz preventDefault,
    // wenn seit dem Öffnen (oder seit dem letzten Escape) niemand auf der Seite getippt oder
    // geklickt hat. Will der Aufrufer ihn danach noch offen haben (eine Sperre ohne Ausweg, ein
    // Dialog, der gerade arbeitet), öffnet er sich gleich wieder; sonst bleibt er zu.
    const element = ref.current;
    setTimeout(() => {
      if (element && openRef.current && element.isConnected && !element.open) {
        showModal(element);
        panelRef.current?.focus({ preventScroll: true });
      }
    }, 0);
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
      onClose={handleClose}
      onClick={handleClick}
    >
      {open ? (
        <div ref={panelRef} className={styles.panel} tabIndex={-1}>
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
