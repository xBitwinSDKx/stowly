import { useId, type ReactNode } from "react";
import { Link } from "react-router";

import { cx } from "./base";
import { ChevronRightIcon } from "./icons";
import styles from "./List.module.css";

export interface SectionProps {
  title: string;
  /** Ein Satz unter der Überschrift. */
  description?: ReactNode;
  /** Schaltflächen rechts neben der Überschrift. */
  actions?: ReactNode;
  children: ReactNode;
  /** Sprungziel, z. B. "geraete" für /einstellungen#geraete. */
  id?: string;
  className?: string;
}

/** Abschnitt einer Ansicht: Überschrift, darunter der Inhalt (meist eine `List`). */
export function Section({ title, description, actions, children, id, className }: SectionProps) {
  const titleId = useId();
  return (
    <section id={id} aria-labelledby={titleId} className={cx(styles.section, className)}>
      <header className={styles.sectionHead}>
        <div className={styles.sectionText}>
          <h2 id={titleId} className={styles.sectionTitle}>
            {title}
          </h2>
          {description ? <p className={styles.sectionDescription}>{description}</p> : null}
        </div>
        {actions ? <div className={styles.sectionActions}>{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

/** Karte aus Zeilen mit feinen Trennlinien, wie die Einstellungen im Entwurf. */
export function List({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx(styles.list, className)}>{children}</div>;
}

export interface ListRowProps {
  /** Beschriftung links. */
  label: ReactNode;
  /** Zweite Zeile unter der Beschriftung. */
  hint?: ReactNode;
  /** Bedienelement oder Wert rechts. */
  children?: ReactNode;
  /** Bedienelement in eine eigene Zeile unter die Beschriftung setzen (breite Elemente am Handy). */
  stacked?: boolean;
  /** Kurzer Wert (Zahl, Abzeichen): bleibt auch am Handy rechts neben der Beschriftung. */
  inline?: boolean;
  className?: string;
}

/** Zeile mit Beschriftung links und Bedienelement rechts. */
export function ListRow({ label, hint, children, stacked = false, inline = false, className }: ListRowProps) {
  return (
    <div className={cx(styles.row, stacked && styles.stacked, inline && styles.inline, className)}>
      <div className={styles.rowText}>
        <div className={styles.rowLabel}>{label}</div>
        {hint ? <div className={styles.rowHint}>{hint}</div> : null}
      </div>
      {children !== undefined && children !== null ? <div className={styles.rowControl}>{children}</div> : null}
    </div>
  );
}

export interface ListLinkProps {
  to: string;
  label: ReactNode;
  hint?: ReactNode;
  /** Aktueller Wert oder Zustand, rechts vor dem Pfeil. */
  value?: ReactNode;
  /** Symbol links. */
  icon?: ReactNode;
  onClick?: () => void;
  className?: string;
}

/** Zeile, die als Ganzes zu einer anderen Ansicht führt. */
export function ListLink({ to, label, hint, value, icon, onClick, className }: ListLinkProps) {
  return (
    <Link to={to} className={cx(styles.row, styles.rowLink, className)} onClick={onClick}>
      {icon ? (
        <span className={styles.rowIcon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className={styles.rowText}>
        <span className={styles.rowLabel}>{label}</span>
        {hint ? <span className={styles.rowHint}>{hint}</span> : null}
      </span>
      {value !== undefined && value !== null ? <span className={styles.rowValue}>{value}</span> : null}
      <ChevronRightIcon size={18} className={styles.rowChevron} aria-hidden="true" />
    </Link>
  );
}
