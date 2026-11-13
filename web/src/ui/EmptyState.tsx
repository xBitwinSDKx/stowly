import type { ReactNode } from "react";

import { cx } from "./base";
import styles from "./EmptyState.module.css";

export interface EmptyStateProps {
  /** Symbol über dem Titel. */
  icon?: ReactNode;
  title: string;
  /** Ein, zwei Sätze, was hier erscheinen wird oder was als Nächstes zu tun ist. */
  children?: ReactNode;
  /** Schaltflächen unter dem Text. */
  actions?: ReactNode;
  /** Ohne eigene Karte, z. B. innerhalb einer Tabelle. */
  plain?: boolean;
  /**
   * Der Titel ist die Überschrift der ganzen Ansicht (Seite nicht gefunden, Fehlerseite):
   * dann eine Überschrift erster Ordnung. Das Aussehen bleibt gleich.
   */
  pageTitle?: boolean;
  className?: string;
}

/** Leerzustand: sagt ruhig, dass es nichts zu zeigen gibt, und was man tun kann. */
export function EmptyState({ icon, title, children, actions, plain = false, pageTitle = false, className }: EmptyStateProps) {
  const Heading = pageTitle ? "h1" : "h2";
  return (
    <div className={cx(styles.empty, plain && styles.plain, className)}>
      {icon ? (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <Heading className={styles.title}>{title}</Heading>
      {children ? <p className={styles.text}>{children}</p> : null}
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </div>
  );
}
