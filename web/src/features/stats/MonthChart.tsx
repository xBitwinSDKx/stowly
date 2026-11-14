import { useId, useLayoutEffect, useRef, useState, type RefObject } from "react";

import type { StatsMonth } from "@/contract";

import { axisFor, labelStep, monthLabels, monthName } from "./model";
import styles from "./StatsPage.module.css";

/** Höhe des Diagramms in Pixeln: Säulen, darunter zwei Zeilen Beschriftung (Monat, Jahr). */
const HEIGHT = 232;
const TOP = 14;
const AXIS = 38;
/** Rechts Platz für die halbe Beschriftung des letzten Monats. */
const RIGHT = 10;
/** Breite, solange das Diagramm noch nicht gemessen ist (und in Tests, die keine Maße kennen). */
const FALLBACK_WIDTH = 640;
/** Ab dieser Breite einer Säule stehen die Zahlen darüber. */
const VALUE_LABEL_MIN = 18;

/**
 * Breite des Elements in Pixeln, nachgeführt bei jeder Größenänderung. Das Diagramm zeichnet in echten
 * Pixeln: So bleibt die Schrift am Handy so groß wie am Desktop, und die Säulen teilen sich die Breite.
 */
function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const measure = () => {
      const next = Math.floor(element.getBoundingClientRect().width);
      // 0: nicht gezeichnet (verborgen, oder eine Umgebung ohne Maße): bei der bisherigen Breite bleiben.
      if (next > 0) {
        setWidth(next);
      }
    };
    measure();
    if (typeof ResizeObserver !== "function") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Kennung für Verweise innerhalb eines SVG (`url(#…)`): ohne Zeichen, die dort stören. */
function useSvgId(prefix: string): string {
  return `${prefix}-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

/** Das Muster für „entsorgt": schräge Streifen. So unterscheiden sich die Säulen auch ohne Farbe. */
function Hatch({ id }: { id: string }) {
  return (
    <pattern id={id} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
      <rect width="6" height="6" className={styles.hatchBack} />
      <rect width="2.5" height="6" className={styles.hatchLine} />
    </pattern>
  );
}

/** Kleines Feld der Legende in derselben Füllung wie die Säulen. */
export function Swatch({ kind }: { kind: "consumed" | "discarded" }) {
  const hatch = useSvgId("legend");
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" className={styles.swatch}>
      {kind === "discarded" ? (
        <defs>
          <Hatch id={hatch} />
        </defs>
      ) : null}
      <rect
        x="0.5"
        y="0.5"
        width="13"
        height="13"
        rx="3"
        className={kind === "consumed" ? styles.consumed : styles.discarded}
        fill={kind === "discarded" ? `url(#${hatch})` : undefined}
      />
    </svg>
  );
}

export interface MonthChartProps {
  months: readonly StatsMonth[];
  /** Was das Diagramm zeigt, in Sätzen: Screenreader lesen das statt der Säulen (`role="img"`). */
  label: string;
}

/**
 * Säulen je Monat: verbraucht (gefüllt in der Akzentfarbe) und entsorgt (rot, schräg gestreift)
 * nebeneinander, darunter Monat und Jahr. Schlichtes SVG, ohne Bibliothek.
 *
 * Gezeichnet wird in der gemessenen Breite: Die Seite scrollt am Handy nicht waagrecht, und die
 * Beschriftung lässt Monate aus, wenn der Platz nicht reicht (der Januar bleibt). Mit der Maus
 * nennt jeder Monat seine Zahlen; Screenreader bekommen dieselben als Tabelle unter dem Diagramm.
 */
export function MonthChart({ months, label }: MonthChartProps) {
  const [ref, width] = useWidth();
  const hatch = useSvgId("hatch");

  const max = months.reduce((highest, entry) => Math.max(highest, entry.consumed, entry.discarded), 0);
  const axis = axisFor(max);
  // Links Platz für die längste Zahl der Achse.
  const left = Math.max(22, String(axis.top).length * 7 + 10);
  const plotWidth = Math.max(1, width - left - RIGHT);
  const plotHeight = HEIGHT - TOP - AXIS;
  const bottom = TOP + plotHeight;
  const slot = plotWidth / Math.max(1, months.length);
  // Je Monat zwei Säulen; ein Viertel des Platzes bleibt als Abstand zum Nachbarmonat.
  const bar = Math.max(2, (slot * 0.74) / 2);
  const showValues = bar >= VALUE_LABEL_MIN;
  const labels = monthLabels(
    months.map((entry) => entry.month),
    labelStep(slot),
  );
  const y = (value: number) => bottom - (value / axis.top) * plotHeight;

  return (
    <div ref={ref} className={styles.chart}>
      <svg role="img" aria-label={label} width={width} height={HEIGHT} viewBox={`0 0 ${String(width)} ${String(HEIGHT)}`} className={styles.svg}>
        <defs>
          <Hatch id={hatch} />
        </defs>

        {axis.ticks.map((tick) => (
          <g key={tick}>
            <line x1={left} x2={width - RIGHT} y1={y(tick)} y2={y(tick)} className={tick === 0 ? styles.base : styles.grid} />
            <text x={left - 8} y={y(tick)} dy="0.32em" textAnchor="end" className={styles.tick}>
              {tick}
            </text>
          </g>
        ))}

        {months.map((entry, index) => {
          const x = left + index * slot;
          const start = x + (slot - 2 * bar) / 2;
          const text = labels[index];
          return (
            <g key={entry.month}>
              {/* Mit der Maus: die Zahlen des Monats als Hinweis. */}
              <title>{`${monthName(entry.month)}: ${String(entry.consumed)} verbraucht, ${String(entry.discarded)} entsorgt`}</title>
              <rect x={x} y={TOP} width={slot} height={plotHeight} className={styles.hit} />
              {entry.consumed > 0 ? (
                <rect x={start} y={y(entry.consumed)} width={bar} height={bottom - y(entry.consumed)} rx="2" className={styles.consumed} />
              ) : null}
              {entry.discarded > 0 ? (
                <rect
                  x={start + bar}
                  y={y(entry.discarded)}
                  width={bar}
                  height={bottom - y(entry.discarded)}
                  rx="2"
                  className={styles.discarded}
                  fill={`url(#${hatch})`}
                />
              ) : null}
              {showValues && entry.consumed > 0 ? (
                <text x={start + bar / 2} y={y(entry.consumed) - 4} textAnchor="middle" className={styles.value}>
                  {entry.consumed}
                </text>
              ) : null}
              {showValues && entry.discarded > 0 ? (
                <text x={start + bar * 1.5} y={y(entry.discarded) - 4} textAnchor="middle" className={styles.value}>
                  {entry.discarded}
                </text>
              ) : null}
              {text?.month ? (
                <text x={x + slot / 2} y={bottom + 16} textAnchor="middle" className={styles.tick}>
                  {text.month}
                </text>
              ) : null}
              {text?.year ? (
                <text x={x + slot / 2} y={bottom + 31} textAnchor="middle" className={styles.year}>
                  {text.year}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
