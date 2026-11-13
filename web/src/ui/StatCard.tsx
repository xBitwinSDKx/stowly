import type { ReactNode } from "react";
import { Link } from "react-router";

import { cx } from "./base";
import styles from "./StatCard.module.css";

export type StatTone = "default" | "accent" | "warn" | "info" | "danger";

export interface StatCardProps {
  label: string;
  /** Die große Zahl. */
  value: ReactNode;
  /** Zusatz hinter der Zahl, z. B. „(1 abgelaufen)". */
  note?: ReactNode;
  /** Farbe der Zahl und des Symbols. Vorgabe "default". */
  tone?: StatTone;
  /** Kleines Symbol rechts oben, gedämpft oder in der Farbe des Tons. */
  icon?: ReactNode;
  /** Macht die ganze Karte zum Verweis auf eine Ansicht. */
  to?: string;
  className?: string;
}

/** Kennzahl-Karte: Beschriftung, große Zahl, optional ein Zusatz in Klammern. */
export function StatCard({ label, value, note, tone = "default", icon, to, className }: StatCardProps) {
  const content = (
    <>
      <div className={styles.body}>
        <div className={styles.label}>{label}</div>
        <div className={cx(styles.value, "tabular")}>
          {value}
          {/* Das Leerzeichen steht außerhalb der Marke: So lesen es auch Screenreader mit. */}
          {note ? " " : null}
          {note ? <span className={styles.note}>{note}</span> : null}
        </div>
      </div>
      {icon ? (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
    </>
  );
  const classes = cx(styles.stat, styles[tone], to !== undefined && styles.link, className);
  if (to !== undefined) {
    return (
      <Link to={to} className={classes}>
        {content}
      </Link>
    );
  }
  return <div className={classes}>{content}</div>;
}
