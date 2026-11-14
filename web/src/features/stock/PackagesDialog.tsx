import { useId, useMemo, useState, type FormEvent } from "react";

import { formatDate, productSubtitle, productTitle, useCore, type PackageChanges } from "@/contract";
import { LabelStatus } from "@/features/printers/LabelStatus";
import { useHasPrinter } from "@/features/printers/usePrinting";
import { BestBeforeField, Checkbox, errorText, FieldGroup, Notice, PackageId, packagesText, readBestBefore, Select, ZoneLabel } from "@/ui";
import { Button, Dialog, dialogFocus, useToast } from "@/ui/base";
import { PrinterIcon } from "@/ui/icons";

import styles from "./dialogs.module.css";
import type { StockData } from "./useStock";

export interface PackagesDialogProps {
  stock: StockData;
  /** Die Packungen, die zur Wahl stehen: eine Charge oder einzelne Packungen. */
  packageIds: readonly string[];
  onClose: () => void;
}

/** Platzhalter der Zonen-Auswahl, wenn die Packungen in verschiedenen Zonen liegen. */
const MIXED = "";

/**
 * MHD und Zone für eine Charge oder einzelne Packungen ändern (`core.stock.update`).
 * Ein geleertes MHD-Feld entfernt das MHD. Geändert wird nur, was im Dialog angefasst wurde.
 * Gibt es einen Drucker, lässt sich für die gewählten Packungen auch ein Etikett nachdrucken.
 */
export function PackagesDialog({ stock, packageIds, onClose }: PackagesDialogProps) {
  const core = useCore();
  const toast = useToast();
  const formId = useId();
  const hasPrinter = useHasPrinter();

  const entries = useMemo(
    () => stock.entries.filter((entry) => packageIds.includes(entry.pkg.id)).sort((a, b) => (a.pkg.id < b.pkg.id ? -1 : 1)),
    [stock.entries, packageIds],
  );

  // Ausgangswerte: der gemeinsame Wert aller Packungen, sonst „verschieden".
  const [initial] = useState(() => {
    const dates = new Set(entries.map((entry) => entry.pkg.best_before));
    const zones = new Set(entries.map((entry) => entry.pkg.zone_id));
    const date = dates.size === 1 ? (entries[0]?.pkg.best_before ?? null) : undefined;
    return {
      /** undefined = verschiedene MHD */
      date,
      text: date ? formatDate(date) : "",
      zone: zones.size === 1 ? (entries[0]?.pkg.zone_id ?? MIXED) : MIXED,
    };
  });

  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(packageIds));
  const [text, setText] = useState(initial.text);
  const [zoneId, setZoneId] = useState(initial.zone);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [labelBusy, setLabelBusy] = useState(false);
  /** Die in diesem Dialog angeforderten Etiketten: Darunter steht, was aus ihnen wird. */
  const [labelJobs, setLabelJobs] = useState<readonly string[]>([]);

  const chosen = entries.filter((entry) => selected.has(entry.pkg.id)).map((entry) => entry.pkg.id);
  const first = entries[0];
  const sameProduct = new Set(entries.map((entry) => entry.pkg.product_id)).size === 1;
  const input = readBestBefore(text, stock.today);
  const dateTouched = text !== initial.text;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (chosen.length === 0 || (dateTouched && input.kind === "invalid")) {
      return;
    }
    const changes: PackageChanges = {};
    if (dateTouched) {
      const next = input.kind === "date" ? input.date : null;
      if (next !== initial.date) {
        changes.best_before = next;
      }
    }
    if (zoneId !== MIXED && zoneId !== initial.zone) {
      changes.zone_id = zoneId;
    }
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await core.stock.update(chosen, changes);
      toast.show({ message: `${packagesText(chosen.length)} geändert`, tone: "success" });
      onClose();
    } catch (caught) {
      setError(errorText(caught, { not_found: "Mindestens eine der Packungen oder die Zone gibt es nicht mehr." }));
      setBusy(false);
    }
  }

  async function printLabels() {
    setLabelBusy(true);
    setError(null);
    try {
      const jobs = await core.print.requestPackageLabels(chosen);
      setLabelJobs(jobs.map((job) => job.id));
    } catch (caught) {
      setError(errorText(caught, { not_found: "Mindestens eine der Packungen gibt es nicht mehr, oder es ist kein Drucker mehr eingerichtet." }));
    } finally {
      setLabelBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      busy={busy}
      title={entries.length === 1 ? "Packung bearbeiten" : "Packungen bearbeiten"}
      variant="sheet"
      footer={
        entries.length === 0 ? (
          <Button onClick={onClose}>Schließen</Button>
        ) : (
          <>
            <Button onClick={onClose} disabled={busy}>
              Abbrechen
            </Button>
            <Button type="submit" form={formId} variant="primary" busy={busy} disabled={chosen.length === 0}>
              Speichern
            </Button>
          </>
        )
      }
    >
      {entries.length === 0 || !first ? (
        <p className={styles.muted}>Diese Packungen sind nicht mehr im Bestand.</p>
      ) : (
        <form id={formId} className={styles.form} onSubmit={(event) => void submit(event)}>
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

          <BestBeforeField
            ref={dialogFocus}
            value={text}
            onChange={setText}
            today={stock.today}
            showError={tried}
            emptyHint={
              initial.date === undefined
                ? "Die Packungen haben verschiedene MHD. Leer lassen, um sie nicht zu ändern."
                : initial.date === null
                  ? "Bisher kein MHD. Leer lassen = weiterhin keines."
                  : "Leer = das MHD wird entfernt."
            }
          />

          {stock.multiZone ? (
            <Select
              label="Zone"
              value={zoneId}
              onChange={setZoneId}
              options={[
                // Der Ausgangswert steht immer zur Wahl, auch wenn er keine (bekannte) Zone ist.
                ...(stock.zones.some((zone) => zone.id === initial.zone)
                  ? []
                  : [{ value: initial.zone, label: initial.zone === MIXED ? "Verschiedene Zonen (nicht ändern)" : "Unbekannte Zone (nicht ändern)" }]),
                ...stock.zones.map((zone) => ({ value: zone.id, label: zone.name })),
              ]}
            />
          ) : null}

          {hasPrinter ? (
            <FieldGroup
              label="Etikett"
              hint={labelJobs.length === 0 ? "Nachdruck, etwa wenn ein Etikett unleserlich geworden ist. Gedruckt wird der gespeicherte Stand." : undefined}
            >
              <div>
                <Button icon={<PrinterIcon />} busy={labelBusy} disabled={chosen.length === 0 || busy} onClick={() => void printLabels()}>
                  {chosen.length <= 1 ? "Etikett drucken" : `${String(chosen.length)} Etiketten drucken`}
                </Button>
              </div>
              <LabelStatus jobIds={labelJobs} className={styles.muted} />
            </FieldGroup>
          ) : null}

          {error ? (
            <Notice tone="danger" role="alert">
              {error}
            </Notice>
          ) : null}
        </form>
      )}
    </Dialog>
  );
}
