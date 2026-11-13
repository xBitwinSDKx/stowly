import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router";

import { cx } from "./base";
import styles from "./Menu.module.css";

export interface MenuItem {
  /** Eindeutig innerhalb des Menüs. */
  key: string;
  label: string;
  icon?: ReactNode;
  /** Kleiner Zusatz rechts, z. B. ein Zähler. */
  trailing?: ReactNode;
  /** Verweis auf eine Ansicht … */
  to?: string;
  /** … oder eine Aktion. */
  onSelect?: () => void;
  /** "danger" für Abmelden, Löschen. */
  tone?: "default" | "danger";
  /** Trennlinie über diesem Eintrag. */
  separated?: boolean;
}

export interface MenuProps {
  /** Name des Menüs für Screenreader, z. B. „Geräte-Menü". */
  label: string;
  /**
   * Beschriftung des Auslösers für Screenreader. Nötig, wenn er nur ein Symbol zeigt;
   * sonst wird sein sichtbarer Text vorgelesen.
   */
  triggerLabel?: string;
  /** Inhalt des Auslösers (Symbol, Text). */
  children: ReactNode;
  items: readonly MenuItem[];
  /** Kopfzeile im Menü, z. B. der Gerätename. */
  header?: ReactNode;
  /** An welcher Kante des Auslösers das Menü ausgerichtet ist. Vorgabe "end". */
  align?: "start" | "end";
  /** Klasse des Auslösers. */
  className?: string;
}

/**
 * Aufklappendes Menü an einer Schaltfläche. Tastatur: Pfeiltasten wandern durch die
 * Einträge, Pos1/Ende springen, Escape schließt und gibt den Fokus zurück.
 */
export function Menu({ label, triggerLabel, children, items, header, align = "end", className }: MenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  function entries(): HTMLElement[] {
    return Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  }

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) {
      triggerRef.current?.focus();
    }
  }

  // Tippen neben das Menü schließt es.
  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Beim Öffnen steht der Fokus auf dem ersten Eintrag.
  useEffect(() => {
    if (open) {
      entries()[0]?.focus();
    }
  }, [open]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!open) {
      return;
    }
    const list = entries();
    const index = list.indexOf(document.activeElement as HTMLElement);
    let target: HTMLElement | undefined;
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      case "Tab":
        setOpen(false);
        return;
      case "ArrowDown":
        target = list[(index + 1) % list.length];
        break;
      case "ArrowUp":
        target = list[(index - 1 + list.length) % list.length];
        break;
      case "Home":
        target = list[0];
        break;
      case "End":
        target = list[list.length - 1];
        break;
      default:
        return;
    }
    event.preventDefault();
    target?.focus();
  }

  return (
    <div ref={rootRef} className={styles.root} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className={cx(styles.trigger, className)}
        aria-label={triggerLabel}
        title={triggerLabel ?? label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        {children}
      </button>
      {open ? (
        <div ref={listRef} id={menuId} role="menu" aria-label={label} className={cx(styles.menu, styles[align])}>
          {header ? <div className={styles.header}>{header}</div> : null}
          {items.map((item) => {
            const classes = cx(styles.item, item.tone === "danger" && styles.danger, item.separated && styles.separated);
            const content = (
              <>
                {item.icon ? (
                  <span className={styles.icon} aria-hidden="true">
                    {item.icon}
                  </span>
                ) : null}
                <span className={styles.label}>{item.label}</span>
                {item.trailing ? <span className={styles.trailing}>{item.trailing}</span> : null}
              </>
            );
            if (item.to !== undefined) {
              return (
                <Link key={item.key} to={item.to} role="menuitem" tabIndex={-1} className={classes} onClick={() => close(false)}>
                  {content}
                </Link>
              );
            }
            return (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={classes}
                onClick={() => {
                  close(true);
                  item.onSelect?.();
                }}
              >
                {content}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
