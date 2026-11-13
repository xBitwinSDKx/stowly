import { useEffect, type ReactNode } from "react";

import { Spinner } from "@/ui/base";

import styles from "./Page.module.css";

const APP_TITLE = "Stowly";

/** Setzt den Titel des Browser-Tabs auf die Ansicht („Zonen · Stowly"), solange sie gezeigt wird. */
export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · ${APP_TITLE}`;
    return () => {
      document.title = APP_TITLE;
    };
  }, [title]);
}

export interface PageProps {
  title: string;
  /** Ein, zwei Sätze unter dem Titel. */
  description?: ReactNode;
  /** Schaltflächen rechts neben dem Titel. */
  actions?: ReactNode;
  /** Schmalere Spalte für Ansichten aus Listen und Formularen (Einstellungen, Sync). */
  narrow?: boolean;
  children: ReactNode;
}

/** Rahmen einer Ansicht innerhalb der Shell: Titelzeile und Inhalt. */
export function Page({ title, description, actions, narrow = false, children }: PageProps) {
  usePageTitle(title);
  return (
    <div className={narrow ? `${styles.page} ${styles.narrow}` : styles.page}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <h1 className={styles.title}>{title}</h1>
          {description ? <p className={styles.description}>{description}</p> : null}
        </div>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}

/** Inhalt einer Ansicht ohne Titelzeile: Die Ansicht setzt ihre Überschrift selbst (Bestand). */
export function PageBody({ children }: { children: ReactNode }) {
  return <div className={styles.page}>{children}</div>;
}

/** Platzhalter, solange der Kern noch lädt. */
export function PageLoading({ label = "Lädt …" }: { label?: string }) {
  return (
    <div className={styles.loading}>
      <Spinner size={22} label={label} />
      <span aria-hidden="true">{label}</span>
    </div>
  );
}
