import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { cx } from "./cx";
import styles from "./Toast.module.css";

export type ToastTone = "neutral" | "success" | "warn" | "danger";

export interface ToastOptions {
  message: string;
  /** Vorgabe "neutral". */
  tone?: ToastTone;
  /** Eine Aktion in der Meldung, typisch „Rückgängig". Der Toast schließt sich danach. */
  action?: { label: string; onAction: () => void };
  /** Anzeigedauer in Millisekunden. Vorgabe 5000; 0 = bleibt, bis er geschlossen wird. */
  duration?: number;
  /** Eigene Kennung: Ein Toast mit derselben Kennung ersetzt den vorhandenen. */
  id?: string;
}

export interface ToastApi {
  /** Zeigt eine kurze Meldung am unteren Rand und liefert ihre Kennung. */
  show(options: ToastOptions): string;
  dismiss(id: string): void;
  /** Schließt alle Meldungen, z. B. wenn die Sitzung endet: „Rückgängig“ hätte dann kein Ziel mehr. */
  dismissAll(): void;
}

interface ToastItem extends ToastOptions {
  id: string;
}

const ToastContext = createContext<ToastApi | null>(null);

const DEFAULT_DURATION = 5000;
const MAX_VISIBLE = 3;

/** Stellt `useToast()` bereit und zeichnet die Meldungen. Einmal um die ganze App legen. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const dismissAll = useCallback(() => {
    for (const timer of timers.current.values()) {
      clearTimeout(timer);
    }
    timers.current.clear();
    setItems((current) => (current.length === 0 ? current : []));
  }, []);

  const show = useCallback(
    (options: ToastOptions) => {
      counter.current += 1;
      const id = options.id ?? `toast-${counter.current}`;
      const existing = timers.current.get(id);
      if (existing !== undefined) {
        clearTimeout(existing);
        timers.current.delete(id);
      }
      setItems((current) => [...current.filter((item) => item.id !== id), { ...options, id }].slice(-MAX_VISIBLE));
      const duration = options.duration ?? DEFAULT_DURATION;
      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
      }
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) {
        clearTimeout(timer);
      }
      pending.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(() => ({ show, dismiss, dismissAll }), [show, dismiss, dismissAll]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={styles.region} role="status" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={cx(styles.toast, styles[item.tone ?? "neutral"])}>
            <span className={styles.message}>{item.message}</span>
            {item.action ? (
              <button
                type="button"
                className={styles.action}
                onClick={() => {
                  item.action?.onAction();
                  dismiss(item.id);
                }}
              >
                {item.action.label}
              </button>
            ) : null}
            <button type="button" className={styles.close} aria-label="Meldung schließen" onClick={() => dismiss(item.id)}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Kurze Meldungen mit optionaler Aktion. Nur innerhalb von `ToastProvider`. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) {
    throw new Error("useToast() außerhalb von <ToastProvider> aufgerufen.");
  }
  return api;
}
