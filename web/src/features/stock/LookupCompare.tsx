import { useState } from "react";

import type { LookupResult } from "@/contract";
import { Checkbox } from "@/ui";
import { Button, cx } from "@/ui/base";
import { CheckIcon } from "@/ui/icons";

import styles from "./dialogs.module.css";

/** Was im Formular steht (Name, Marke, Größe) und das Bild, das das Produkt hat oder bekommen soll. */
export interface LookupForm {
  name: string;
  brand: string;
  quantity: string;
  image: string | null;
}

export type CompareField = "name" | "brand" | "quantity" | "image";

/** Eine Zeile der Gegenüberstellung: was jetzt gilt und was Open Food Facts anbietet. */
export interface CompareRow {
  field: CompareField;
  label: string;
  /** Was jetzt gilt; "" = leer (beim Bild: keins). */
  current: string;
  /** Was Open Food Facts liefert; nie leer (beim Bild: die Kennung des Bilds bei Stowly). */
  offered: string;
  /** Weicht ab: Dann ist die Zeile vorgehakt. */
  differs: boolean;
}

/**
 * Gegenüberstellung je Feld (docs/plan-0.5.md, 2): Name, Marke, Packungsgröße und Bild. Leere
 * Werte von Open Food Facts werden nie angeboten, damit nichts gelöscht wird; abweichende sind
 * vorgehakt. Verglichen wird ohne Leerraum am Rand.
 */
export function compareLookup(form: LookupForm, result: Pick<LookupResult, "name" | "brand" | "quantity" | "image_id">): CompareRow[] {
  const rows: CompareRow[] = [];
  const texts: [CompareField, string, string, string][] = [
    ["name", "Name", form.name, result.name],
    ["brand", "Marke", form.brand, result.brand],
    ["quantity", "Packungsgröße", form.quantity, result.quantity],
  ];
  for (const [field, label, current, offered] of texts) {
    const value = offered.trim();
    if (value !== "") {
      rows.push({ field, label, current: current.trim(), offered: value, differs: value !== current.trim() });
    }
  }
  if (result.image_id !== null && result.image_id !== "") {
    rows.push({ field: "image", label: "Bild", current: form.image ?? "", offered: result.image_id, differs: result.image_id !== form.image });
  }
  return rows;
}

/** Was „Übernehmen" ins Formular trägt; fehlende Felder bleiben, wie sie sind. */
export type LookupTaken = Partial<Record<CompareField, string>>;

export interface LookupCompareProps {
  result: LookupResult;
  form: LookupForm;
  /** Adresse eines Bilds für `<img>` (`data.imageUrl`). */
  imageUrl: (image: string) => string;
  onApply: (taken: LookupTaken) => void;
  onClose: () => void;
}

/** Ein Wert in der Gegenüberstellung: Text oder Bild, leer als „leer". */
function Value({ row, value, imageUrl, label }: { row: CompareRow; value: string; imageUrl: (image: string) => string; label: string }) {
  if (value === "") {
    return <span className={styles.compareEmpty}>{row.field === "image" ? "kein Bild" : "leer"}</span>;
  }
  return row.field === "image" ? <img className={styles.compareImage} src={imageUrl(value)} alt={label} /> : <span>{value}</span>;
}

/**
 * Was Open Food Facts jetzt über den Barcode weiß, neben dem, was im Formular steht. Gespeichert
 * wird hier nichts: „Übernehmen" trägt die angehakten Werte ins Formular (das Bild wird vorgemerkt),
 * gespeichert wird mit „Speichern" des Dialogs.
 */
export function LookupCompare({ result, form, imageUrl, onApply, onClose }: LookupCompareProps) {
  const rows = compareLookup(form, result);
  const [checked, setChecked] = useState<ReadonlySet<CompareField>>(() => new Set(rows.filter((row) => row.differs).map((row) => row.field)));
  const differing = rows.filter((row) => row.differs);

  function apply() {
    const taken: LookupTaken = {};
    for (const row of differing) {
      if (checked.has(row.field)) {
        taken[row.field] = row.offered;
      }
    }
    onApply(taken);
  }

  return (
    <section className={styles.compare} aria-label="Daten von Open Food Facts">
      {differing.length === 0 ? <p className={styles.muted}>Open Food Facts liefert nichts, was hier nicht schon steht.</p> : null}
      <ul className={styles.compareRows}>
        {rows.map((row) => (
          <li key={row.field} className={cx(styles.compareRow, !row.differs && styles.compareSame)}>
            {row.differs ? (
              <Checkbox
                checked={checked.has(row.field)}
                onChange={(on) =>
                  setChecked((current) => {
                    const next = new Set(current);
                    if (on) {
                      next.add(row.field);
                    } else {
                      next.delete(row.field);
                    }
                    return next;
                  })
                }
                label={`${row.label} übernehmen`}
              />
            ) : (
              <span className={styles.compareCheck} aria-hidden="true">
                <CheckIcon size={16} />
              </span>
            )}
            <span className={styles.compareLabel}>{row.label}</span>
            <span className={styles.compareValues}>
              <span className={styles.compareValue}>
                <span className={styles.compareSource}>jetzt</span>
                <Value row={row} value={row.current} imageUrl={imageUrl} label={`${row.label} jetzt`} />
              </span>
              <span className={styles.compareValue}>
                <span className={styles.compareSource}>Open Food Facts</span>
                {row.differs ? <Value row={row} value={row.offered} imageUrl={imageUrl} label={`${row.label} von Open Food Facts`} /> : <span className={styles.muted}>gleich</span>}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className={styles.muted}>Daten von Open Food Facts (ODbL)</p>
      <div className={styles.compareActions}>
        {differing.length > 0 ? (
          <Button variant="primary" size="sm" disabled={checked.size === 0} onClick={apply}>
            Übernehmen
          </Button>
        ) : null}
        <Button size="sm" onClick={onClose}>
          Schließen
        </Button>
      </div>
    </section>
  );
}
