import type { HTMLAttributes } from "react";

import styles from "./Badge.module.css";
import { cx } from "./cx";

export type BadgeTone = "neutral" | "accent" | "warn" | "danger" | "info" | "success";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** Vorgabe "neutral". */
  tone?: BadgeTone;
  /** Gefüllt statt getönt, z. B. der Zähler an der Warn-Pille. */
  solid?: boolean;
}

/** Kleines Abzeichen: Zähler, Zustand, Kennzeichnung. */
export function Badge({ tone = "neutral", solid = false, className, ...rest }: BadgeProps) {
  return <span {...rest} className={cx(styles.badge, styles[tone], solid && styles.solid, className)} />;
}
