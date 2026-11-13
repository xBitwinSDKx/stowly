import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { cx } from "./base";
import styles from "./PrintSheet.module.css";

/**
 * Ein Blatt nur für den Druck über den Browser (`window.print()`).
 *
 * Am Bildschirm unsichtbar. Solange ein solches Blatt existiert, druckt der Browser
 * statt der App nur dessen Inhalt, schwarz auf weiß (Regel in global.css).
 */
export function PrintSheet({ children, className }: { children: ReactNode; className?: string }) {
  return createPortal(
    <div className={cx(styles.sheet, className)} data-print-sheet="">
      {children}
    </div>,
    document.body,
  );
}
