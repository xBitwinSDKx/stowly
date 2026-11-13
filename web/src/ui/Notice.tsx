import type { ReactNode } from "react";

import { cx } from "./base";
import styles from "./Notice.module.css";

export type NoticeTone = "neutral" | "accent" | "info" | "warn" | "danger" | "success";

export interface NoticeProps {
  /** Vorgabe "neutral". */
  tone?: NoticeTone;
  /** Symbol links. */
  icon?: ReactNode;
  /** Kurze Überschrift vor dem Text. */
  title?: string;
  children?: ReactNode;
  /** Schaltfläche oder Verweis rechts (am Handy unter dem Text). */
  action?: ReactNode;
  /** "alert" unterbricht Screenreader, "status" nicht. Ohne Angabe ist der Hinweis stiller Inhalt. */
  role?: "alert" | "status";
  /** Flach über die ganze Breite, ohne Rundung: für Leisten unter der Kopfzeile. */
  banner?: boolean;
  className?: string;
}

/** Hinweis in einer getönten Fläche: Erklärung, Warnung oder Fehler. */
export function Notice({ tone = "neutral", icon, title, children, action, role, banner = false, className }: NoticeProps) {
  return (
    <div className={cx(styles.notice, styles[tone], banner && styles.banner, className)} role={role}>
      {icon ? (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <div className={styles.text}>
        {title ? <strong className={styles.title}>{title}</strong> : null}
        {children ? <div>{children}</div> : null}
      </div>
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
