import type { ReactNode } from "react";

import styles from "./Page.module.css";

export interface PageProps {
  title: string;
  /** Schaltflächen rechts neben dem Titel. */
  actions?: ReactNode;
  children: ReactNode;
}

/** Rahmen einer Ansicht innerhalb der Shell: Titelzeile und Inhalt. */
export function Page({ title, actions, children }: PageProps) {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>{title}</h1>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}
