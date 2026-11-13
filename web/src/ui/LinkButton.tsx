import type { ReactNode } from "react";
import { Link, type LinkProps } from "react-router";

import { cx, type ButtonSize, type ButtonVariant } from "./base";
import styles from "./base/Button.module.css";

export interface LinkButtonProps extends Omit<LinkProps, "className"> {
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
 * Sieht aus wie `Button`, ist aber ein Verweis: für alles, was zu einer anderen Ansicht
 * führt („Jetzt scannen"). So funktionieren auch „in neuem Tab öffnen" und Screenreader
 * sagen „Link".
 */
export function LinkButton({
  variant = "secondary",
  size = "md",
  icon,
  iconRight,
  block = false,
  className,
  children,
  ...rest
}: LinkButtonProps) {
  return (
    <Link {...rest} className={cx(styles.button, styles[variant], styles[size], block && styles.block, className)}>
      {icon ? <span className={styles.icon}>{icon}</span> : null}
      {children !== undefined && children !== null ? <span className={styles.label}>{children}</span> : null}
      {iconRight ? <span className={styles.icon}>{iconRight}</span> : null}
    </Link>
  );
}
