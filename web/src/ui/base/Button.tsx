import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { Link, type LinkProps } from "react-router";

import styles from "./Button.module.css";
import { cx } from "./cx";
import { useButtonLock } from "./lock";
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
  /**
   * Zeigt einen Spinner und sperrt die Schaltfläche, solange eine Aktion läuft. Sie behält dabei
   * den Fokus und sagt Screenreadern „beschäftigt, nicht verfügbar" (`aria-busy`, `aria-disabled`).
   * Solange `busy` gilt, bleibt `disabled` ohne Wirkung: Gesperrt ist sie ohnehin.
   */
  busy?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

/**
 * Schaltfläche. `type` ist "button", solange nichts anderes angegeben wird.
 * Gesperrt (`busy`, `disabled`) verliert sie den Fokus nicht: siehe `useButtonLock`.
 */
export function Button({
  variant = "secondary",
  size = "md",
  icon,
  iconRight,
  block = false,
  busy = false,
  disabled = false,
  className,
  children,
  type = "button",
  ref,
  "aria-disabled": ariaDisabled,
  onClick,
  onFocus,
  onBlur,
  ...rest
}: ButtonProps) {
  const lock = useButtonLock({ busy, disabled, "aria-disabled": ariaDisabled, onClick, onFocus, onBlur });
  return (
    <button
      {...rest}
      {...lock}
      ref={ref}
      type={type}
      className={cx(styles.button, styles[variant], styles[size], block && styles.block, className)}
      aria-busy={busy || undefined}
    >
      {busy ? <Spinner size={16} /> : icon ? <span className={styles.icon}>{icon}</span> : null}
      {children !== undefined && children !== null ? <span className={styles.label}>{children}</span> : null}
      {iconRight ? <span className={styles.icon}>{iconRight}</span> : null}
    </button>
  );
}

export interface ButtonLinkProps extends Omit<LinkProps, "className"> {
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
  className?: string;
}

/**
 * Sieht aus wie `Button`, ist aber ein Verweis (`Link` aus react-router): für alles, was zu
 * einer anderen Ansicht führt („Jetzt scannen"). So funktioniert „in neuem Tab öffnen", und
 * Screenreader sagen „Link". Braucht einen Router um sich.
 */
export function ButtonLink({ variant = "secondary", size = "md", icon, iconRight, block = false, className, children, ...rest }: ButtonLinkProps) {
  return (
    <Link {...rest} className={cx(styles.button, styles[variant], styles[size], block && styles.block, className)}>
      {icon ? <span className={styles.icon}>{icon}</span> : null}
      {children !== undefined && children !== null ? <span className={styles.label}>{children}</span> : null}
      {iconRight ? <span className={styles.icon}>{iconRight}</span> : null}
    </Link>
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

/** Quadratische Schaltfläche nur mit Symbol. Gesperrt verliert sie den Fokus nicht: siehe `useButtonLock`. */
export function IconButton({
  label,
  children,
  variant = "ghost",
  size = "md",
  className,
  type = "button",
  ref,
  disabled = false,
  "aria-disabled": ariaDisabled,
  onClick,
  onFocus,
  onBlur,
  ...rest
}: IconButtonProps) {
  const lock = useButtonLock({ disabled, "aria-disabled": ariaDisabled, onClick, onFocus, onBlur });
  return (
    <button
      {...rest}
      {...lock}
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
