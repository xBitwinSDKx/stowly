import { useState, type AriaAttributes, type FocusEvent, type MouseEvent } from "react";

export interface ButtonLockOptions {
  /** Eine Aktion läuft: gesperrt und fokussierbar, die ganze Zeit. */
  busy?: boolean;
  /** Gesperrt. */
  disabled?: boolean;
  /** Was der Aufrufer selbst angibt; gilt, solange die Sperre es nicht überschreibt. */
  "aria-disabled"?: AriaAttributes["aria-disabled"];
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  onFocus?: (event: FocusEvent<HTMLButtonElement>) => void;
  onBlur?: (event: FocusEvent<HTMLButtonElement>) => void;
}

/** Attribute und Handler für das `<button>`, nach den übrigen Props einzusetzen. */
export interface ButtonLockProps {
  disabled: boolean;
  "aria-disabled": AriaAttributes["aria-disabled"];
  onClick: ((event: MouseEvent<HTMLButtonElement>) => void) | undefined;
  onFocus: (event: FocusEvent<HTMLButtonElement>) => void;
  onBlur: (event: FocusEvent<HTMLButtonElement>) => void;
}

/**
 * Sperrt eine Schaltfläche, ohne ihr den Fokus zu nehmen.
 *
 * Mit dem Attribut `disabled` verliert eine Schaltfläche den Fokus: Er fällt auf die Seite zurück,
 * und wer mit Tastatur oder Screenreader arbeitet, verliert seine Stelle. Deshalb trägt sie statt
 * `disabled` nur `aria-disabled="true"` und bleibt fokussierbar,
 * - solange `busy` gilt, auch beim Wechsel von „bereit" zu „beschäftigt" und zurück;
 * - wenn sie gesperrt wird, während sie den Fokus hat: bis sie ihn abgibt. Erst dann bekommt sie
 *   `disabled` und fällt aus der Tab-Reihenfolge.
 *
 * So gesperrt löst ein Klick nichts aus und erreicht auch die Umgebung nicht, wie bei `disabled`.
 * Das gilt ebenso für Enter und Leertaste und für das Absenden eines Formulars mit Enter in einem
 * seiner Felder: Für all das schickt der Browser einen Klick an die Schaltfläche.
 */
export function useButtonLock({ busy = false, disabled = false, "aria-disabled": ariaDisabled, onClick, onFocus, onBlur }: ButtonLockOptions): ButtonLockProps {
  const [focused, setFocused] = useState(false);
  const held = busy || (disabled && focused);
  return {
    disabled: disabled && !held,
    "aria-disabled": held ? true : ariaDisabled,
    onClick: held ? swallow : onClick,
    onFocus(event) {
      setFocused(true);
      onFocus?.(event);
    },
    onBlur(event) {
      setFocused(false);
      onBlur?.(event);
    },
  };
}

/** Der Klick an eine gesperrte Schaltfläche: kein Absenden des Formulars, nichts für die Umgebung. */
function swallow(event: MouseEvent<HTMLButtonElement>): void {
  event.preventDefault();
  event.stopPropagation();
}
