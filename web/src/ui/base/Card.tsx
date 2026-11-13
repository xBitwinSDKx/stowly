import type { HTMLAttributes, Ref } from "react";

import styles from "./Card.module.css";
import { cx } from "./cx";

export type CardTone = "default" | "accent" | "warn" | "danger" | "info";
export type CardPadding = "none" | "sm" | "md" | "lg";

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** HTML-Element. Vorgabe "div". */
  as?: "div" | "section" | "article" | "li" | "aside";
  /** Innenabstand. Vorgabe "md". */
  padding?: CardPadding;
  /** Farbig hinterlegt, z. B. die aktive Zonen-Karte. Vorgabe "default". */
  tone?: CardTone;
  /** Kontur in der Akzentfarbe: die ausgewählte Karte oder Zeile. */
  selected?: boolean;
  /** Reagiert sichtbar auf Zeiger und Fokus. Die Bedienbarkeit (button, onClick) liefert der Aufrufer. */
  interactive?: boolean;
  ref?: Ref<HTMLElement>;
}

/** Fläche eine Stufe heller als der Hintergrund, mit feiner Kontur und leicht gerundeten Ecken. */
export function Card({
  as: Element = "div",
  padding = "md",
  tone = "default",
  selected = false,
  interactive = false,
  className,
  ref,
  ...rest
}: CardProps) {
  return (
    <Element
      {...rest}
      ref={ref as Ref<never>}
      className={cx(
        styles.card,
        styles[`padding-${padding}`],
        tone !== "default" && styles[`tone-${tone}`],
        selected && styles.selected,
        interactive && styles.interactive,
        className,
      )}
    />
  );
}
