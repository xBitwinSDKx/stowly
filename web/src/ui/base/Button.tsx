import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

import styles from "./Button.module.css";
import { cx } from "./cx";
import { Spinner } from "./Spinner";

/**
 * - "primary": gefüllt in der Akzentfarbe, die eine Hauptaktion einer Ansicht („Jetzt scannen")
 * - "secondary": umrandet („Bearbeiten")
 * - "ghost": ohne Rand, für Nebenaktionen und Leisten
 * - "danger": gefüllt rot („Löschen")
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
/** "lg" hat die Höhe für Daumenbedienung am Handy. */
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Vorgabe "secondary". */
  variant?: ButtonVariant;
  /** Vorgabe "md". */
  size?: ButtonSize;
  /** Symbol vor dem Text. */
  icon?: ReactNode;
  /** Symbol hinter dem Text. */
  iconRight?: ReactNode;
  /** Volle Breite des Behälters. */
  block?: boolean;
  /** Zeigt einen Spinner und sperrt die Schaltfläche, solange eine Aktion läuft. */
  busy?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

/** Schaltfläche. `type` ist "button", solange nichts anderes angegeben wird. */
export function Button({
  variant = "secondary",
  size = "md",
  icon,
  iconRight,
  block = false,
  busy = false,
  disabled,
  className,
  children,
  type = "button",
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={cx(styles.button, styles[variant], styles[size], block && styles.block, className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy ? <Spinner size={16} /> : icon ? <span className={styles.icon}>{icon}</span> : null}
      {children !== undefined && children !== null ? <span className={styles.label}>{children}</span> : null}
      {iconRight ? <span className={styles.icon}>{iconRight}</span> : null}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** Beschreibt die Aktion für Screenreader und als Tooltip. Pflicht, weil kein Text sichtbar ist. */
  label: string;
  /** Das Symbol. */
  children: ReactNode;
  /** Vorgabe "ghost". */
  variant?: ButtonVariant;
  /** Vorgabe "md". Jede Größe hält am Handy die Mindest-Tippfläche ein. */
  size?: ButtonSize;
  ref?: Ref<HTMLButtonElement>;
}

/** Quadratische Schaltfläche nur mit Symbol. */
export function IconButton({
  label,
  children,
  variant = "ghost",
  size = "md",
  className,
  type = "button",
  ref,
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cx(styles.button, styles.iconOnly, styles[variant], styles[size], className)}
    >
      <span className={styles.icon}>{children}</span>
    </button>
  );
}
