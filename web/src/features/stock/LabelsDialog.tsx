import { useMemo, useState } from "react";

import { formatDate, productSubtitle, productTitle, useCore, type PrintJob } from "@/contract";
import { LabelImage } from "@/features/printers/LabelImage";
import { LabelStatus } from "@/features/printers/LabelStatus";
import { printerForPackage } from "@/features/printers/model";
import { usePrinting } from "@/features/printers/usePrinting";
import { Checkbox, errorText, FieldGroup, Notice, PackageId, plural, ZoneLabel } from "@/ui";
import { Button, Dialog } from "@/ui/base";
import { PrinterIcon } from "@/ui/icons";

import styles from "./dialogs.module.css";
import type { StockData } from "./useStock";

export interface LabelsDialogProps {
  stock: StockData;
  /** Die Packungen, die zur Wahl stehen: eine Charge oder einzelne Packungen. */
  packageIds: readonly string[];
  onClose: () => void;
}

/**
 * Nachdruck: für eine oder mehrere Packungen ein neues Etikett anfordern
 * (`core.print.requestPackageLabels`), mit Vorschau. Danach sagt der Dialog, was mit den
 * Etiketten ist. Ein Nachdruck ist immer ein neues Etikett; alte bleiben in der Liste.
 */
export function LabelsDialog({ stock, packageIds, onClose }: LabelsDialogProps) {
  const core = useCore();
  const printing = usePrinting();

  const entries = useMemo(
    () => stock.entries.filter((entry) => packageIds.includes(entry.pkg.id)).sort((a, b) => (a.pkg.id < b.pkg.id ? -1 : 1)),
    [stock.entries, packageIds],
  );
  // Eine einzelne Packung ist gemeint; bei mehreren wählt man bewusst aus (welche es ist, steht auf ihrem alten Etikett).
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(packageIds.length === 1 ? packageIds : []));
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PrintJob[] | null>(null);

  const chosen = entries.filter((entry) => selected.has(entry.pkg.id));
  const first = entries[0];
  const shown = chosen[0] ?? first;
  const sameProduct = new Set(entries.map((entry) => entry.pkg.product_id)).size === 1;
  const targets = chosen.map((entry) => printerForPackage(entry.pkg.id, printing.data));
  const names = [...new Set(targets.map((printer) => printer?.name).filter((name): name is string => name !== undefined))];
  const unassigned = targets.filter((printer) => printer === undefined).length;

  async function submit() {
    setTried(true);
    if (chosen.length === 0) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setResult(await core.print.requestPackageLabels(chosen.map((entry) => entry.pkg.id)));
    } catch (caught) {
      setError(errorText(caught, { not_found: "Mindestens eine der Packungen gibt es nicht mehr, oder es ist kein Drucker mehr eingerichtet." }));
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <Dialog
        open
        onClose={onClose}
        title={result.length === 1 ? "Etikett angefordert" : "Etiketten angefordert"}
        variant="sheet"
        footer={
          <Button variant="primary" onClick={onClose}>
            Fertig
          </Button>
        }
      >
        {/* Das Symbol folgt dem Stand: gedruckt, unterwegs, unklar oder gescheitert. */}
        <LabelStatus jobIds={result.map((job) => job.id)} icon />
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      busy={busy}
      title={entries.length === 1 ? "Etikett drucken" : "Etiketten drucken"}
      variant="sheet"
      footer={
        entries.length === 0 ? (
          <Button onClick={onClose}>Schließen</Button>
        ) : (
          <>
            <Button onClick={onClose} disabled={busy}>
              Abbrechen
            </Button>
            <Button variant="primary" icon={<PrinterIcon />} busy={busy} onClick={() => void submit()}>
              {chosen.length <= 1 ? "Etikett drucken" : `${String(chosen.length)} Etiketten drucken`}
            </Button>
          </>
        )
      }
    >
      {entries.length === 0 || !first || !shown ? (
        <p className={styles.muted}>Diese Packungen sind nicht mehr im Bestand.</p>
      ) : (
        <div className={styles.form}>
          <div className={styles.subject}>
            <div className={styles.subjectTitle}>{sameProduct ? productTitle(first.product) : "Mehrere Produkte"}</div>
            {sameProduct && productSubtitle(first.product) !== "" ? <div className={styles.muted}>{productSubtitle(first.product)}</div> : null}
          </div>

          {entries.length === 1 ? (
            <div className={styles.single}>
              <PackageId id={first.pkg.id} />
              {stock.multiZone ? <ZoneLabel zone={first.zone} /> : null}
            </div>
          ) : (
            <FieldGroup label="Für welche Packungen?" error={tried && chosen.length === 0 ? "Bitte mindestens eine Packung auswählen." : null}>
              <div className={styles.pick}>
                <Checkbox
                  className={styles.pickAll}
                  checked={chosen.length === entries.length}
                  indeterminate={chosen.length > 0 && chosen.length < entries.length}
                  onChange={(checked) => setSelected(new Set(checked ? entries.map((entry) => entry.pkg.id) : []))}
                >
                  Alle {entries.length} Packungen
                </Checkbox>
                <ul className={styles.pickList}>
                  {entries.map((entry) => (
                    <li key={entry.pkg.id}>
                      <Checkbox
                        checked={selected.has(entry.pkg.id)}
                        onChange={(checked) =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (checked) {
                              next.add(entry.pkg.id);
                            } else {
                              next.delete(entry.pkg.id);
                            }
                            return next;
                          })
                        }
                      >
                        <span className={styles.pickRow}>
                          <PackageId id={entry.pkg.id} />
                          {sameProduct ? null : <span className={styles.pickProduct}>{productTitle(entry.product)}</span>}
                          <span>{entry.pkg.best_before ? `MHD ${formatDate(entry.pkg.best_before)}` : "ohne MHD"}</span>
                          {stock.multiZone ? <ZoneLabel zone={entry.zone} className={styles.muted} /> : null}
                        </span>
                      </Checkbox>
                    </li>
                  ))}
                </ul>
              </div>
            </FieldGroup>
          )}

          <FieldGroup label={entries.length === 1 ? "Vorschau" : `Vorschau: Packung ${shown.pkg.id}`}>
            <LabelImage load={() => core.print.preview({ kind: "package", package_id: shown.pkg.id })} source={shown.pkg.id} alt={`Vorschau des Etiketts für die Packung ${shown.pkg.id}`} />
          </FieldGroup>

          {chosen.length > 0 ? (
            <p className={styles.muted} role="status">
              {unassigned === chosen.length
                ? "Kein Drucker zugeordnet: Die Etiketten bleiben ausstehend, bis es einen Standarddrucker oder einen Drucker für die Zone gibt."
                : `Druckt auf ${names.map((name) => `„${name}“`).join(" und ")}${unassigned > 0 ? `; für ${plural(unassigned, "Packung", "Packungen")} ist kein Drucker zugeordnet` : ""}. Ein Nachdruck ist ein neues Etikett; das alte bleibt gültig.`}
            </p>
          ) : null}

          {error ? (
            <Notice tone="danger" role="alert">
              {error}
            </Notice>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
