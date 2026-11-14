import { useId, useMemo, useState, type FormEvent } from "react";

import { formatDate, productSubtitle, productTitle, useCore, type Product, type RemovalReason } from "@/contract";
import { addProductToShopping, openItemFor } from "@/features/shopping/actions";
import { Checkbox, errorText, FieldGroup, Notice, PackageId, packagesText, REMOVAL_REASON_LABELS, REMOVAL_REASON_OPTIONS, ZoneLabel } from "@/ui";
import { Button, Dialog, SegmentedControl, useToast } from "@/ui/base";

import styles from "./dialogs.module.css";
import type { StockEntry } from "./model";
import type { StockData } from "./useStock";

/** Kennung der Meldung, die nach dem Entnehmen der letzten Packung die Einkaufsliste anbietet. */
const LAST_PACKAGE_TOAST = "stock-last-package";

/**
 * Das Produkt, dessen letzte Packungen gerade entnommen werden, falls es genau eines ist; sonst undefined.
 * Produkte mit Mindestbestand zählen nicht: Für sie legt der Server den Eintrag der Einkaufsliste
 * selbst an, und die Bestandsliste zeigt sie weiter mit „fehlt n".
 */
export function emptiedProduct(entries: readonly StockEntry[], removing: readonly string[]): Product | undefined {
  const leaving = new Set(removing);
  const products = new Map<string, Product | undefined>();
  for (const entry of entries) {
    if (leaving.has(entry.pkg.id)) {
      products.set(entry.pkg.product_id, entry.product);
    }
  }
  const emptied = [...products].filter(([productId]) => !entries.some((entry) => entry.pkg.product_id === productId && !leaving.has(entry.pkg.id)));
  const [only] = emptied;
  if (emptied.length !== 1 || !only) {
    return undefined;
  }
  const product = only[1];
  return product && product.min_stock === null ? product : undefined;
}

export interface RemoveDialogProps {
  stock: StockData;
  /** Die Packungen, die zur Wahl stehen. */
  packageIds: readonly string[];
  /** Vorauswahl. Vorgabe: alle. */
  initialSelection?: "all" | "none";
  /** Vorgewählter Grund. Vorgabe: verbraucht. */
  initialReason?: RemovalReason;
  onClose: () => void;
}

const REASON_HINTS: Record<RemovalReason, string> = {
  consumed: "Aufgebraucht oder gegessen.",
  discarded: "Weggeworfen, zum Beispiel weil verdorben.",
  mistake: "Gab es so nie oder wurde doppelt erfasst.",
};

/** MHD aufsteigend, ohne MHD zuletzt: Was zuerst weg sollte, steht oben. */
function byExpiry(a: StockEntry, b: StockEntry): number {
  const left = a.pkg.best_before ?? "9999";
  const right = b.pkg.best_before ?? "9999";
  return left < right ? -1 : left > right ? 1 : a.pkg.id < b.pkg.id ? -1 : 1;
}

/**
 * Entnehmen oder löschen: wie viele (alle oder eine Auswahl) und warum.
 * Danach bietet eine Meldung „Rückgängig" an; die Packungen liegen in der Lösch-Historie.
 * War es die letzte Packung eines Produkts, bietet eine zweite Meldung „Auf die Einkaufsliste" an
 * oder sagt, dass es dort schon steht.
 */
export function RemoveDialog({ stock, packageIds, initialSelection = "all", initialReason = "consumed", onClose }: RemoveDialogProps) {
  const core = useCore();
  const toast = useToast();
  const formId = useId();

  // Der Bestand kann sich ändern, während der Dialog offen ist: nur zeigen, was noch da ist.
  const entries = useMemo(() => stock.entries.filter((entry) => packageIds.includes(entry.pkg.id)).sort(byExpiry), [stock.entries, packageIds]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(initialSelection === "all" ? packageIds : []));
  const [reason, setReason] = useState<RemovalReason>(initialReason);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = entries.filter((entry) => selected.has(entry.pkg.id)).map((entry) => entry.pkg.id);
  const single = entries.length === 1 ? entries[0] : undefined;
  const titles = [...new Set(entries.map((entry) => entry.product?.id ?? entry.pkg.product_id))];
  const sameProduct = titles.length === 1;
  const first = entries[0];
  const retention = stock.settings?.trash_retention_days;

  function toggle(id: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (chosen.length === 0) {
      return;
    }
    setBusy(true);
    setError(null);
    // Was „Falsch erfasst" löscht, war nie da: Dann fehlt auch nichts.
    const emptied = reason === "mistake" ? undefined : emptiedProduct(stock.entries, chosen);
    try {
      await core.stock.remove(chosen, reason);
      toast.show({
        message: `${packagesText(chosen.length)} ${REMOVAL_REASON_LABELS[reason]}`,
        duration: 8000,
        action: {
          label: "Rückgängig",
          onAction: () => {
            // Mit den Packungen ist auch das Angebot der Einkaufsliste hinfällig.
            toast.dismiss(LAST_PACKAGE_TOAST);
            core.stock.restore(chosen).catch((caught: unknown) => {
              toast.show({ message: `Rückgängig hat nicht geklappt. ${errorText(caught)}`, tone: "danger" });
            });
          },
        },
      });
      if (emptied) {
        // Nach der letzten Packung: dasselbe Angebot wie im Bestand („Auf die Einkaufsliste").
        const title = productTitle(emptied);
        toast.show(
          openItemFor(core.data.shoppingItems.get(), emptied.id)
            ? { id: LAST_PACKAGE_TOAST, message: `„${title}“ ist nicht mehr im Bestand und steht schon auf der Einkaufsliste.`, duration: 8000 }
            : {
                id: LAST_PACKAGE_TOAST,
                message: `„${title}“ ist nicht mehr im Bestand.`,
                duration: 8000,
                action: { label: "Auf die Einkaufsliste", onAction: () => void addProductToShopping(core, toast, emptied) },
              },
        );
      }
      onClose();
    } catch (caught) {
      setError(errorText(caught, { not_found: "Mindestens eine der Packungen gibt es nicht mehr." }));
      setBusy(false);
    }
  }

  // „Falsch erfasst" heißt löschen, alles andere entnehmen; so steht es auch auf der Schaltfläche.
  const verb = reason === "mistake" ? "Löschen" : "Entnehmen";
  const confirmLabel = chosen.length === 0 ? "Auswahl fehlt" : chosen.length === 1 ? verb : `${String(chosen.length)} ${verb.toLowerCase()}`;

  return (
    <Dialog
      open
      onClose={busy ? () => undefined : onClose}
      title={reason === "mistake" ? "Packungen löschen" : "Packungen entnehmen"}
      variant="sheet"
      footer={
        entries.length === 0 ? (
          <Button onClick={onClose}>Schließen</Button>
        ) : (
          <>
            <Button onClick={onClose} disabled={busy}>
              Abbrechen
            </Button>
            <Button type="submit" form={formId} variant="danger" busy={busy} disabled={chosen.length === 0}>
              {confirmLabel}
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
            <div className={styles.subjectTitle}>{sameProduct ? productTitle(first.product) : `${String(titles.length)} Produkte`}</div>
            {sameProduct && productSubtitle(first.product) !== "" ? <div className={styles.muted}>{productSubtitle(first.product)}</div> : null}
          </div>

          {single ? (
            <div className={styles.single}>
              <PackageId id={single.pkg.id} />
              <span>{single.pkg.best_before ? `MHD ${formatDate(single.pkg.best_before)}` : "ohne MHD"}</span>
              {stock.multiZone ? <ZoneLabel zone={single.zone} /> : null}
            </div>
          ) : (
            <FieldGroup label="Welche Packungen?">
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
                      <Checkbox checked={selected.has(entry.pkg.id)} onChange={(checked) => toggle(entry.pkg.id, checked)}>
                        <span className={styles.pickRow}>
                          <PackageId id={entry.pkg.id} />
                          {sameProduct ? null : <span className={styles.pickProduct}>{productTitle(entry.product)}</span>}
                          <span className={entry.state === "expired" ? styles.expired : entry.state === "soon" ? styles.soon : undefined}>
                            {entry.pkg.best_before ? `MHD ${formatDate(entry.pkg.best_before)}` : "ohne MHD"}
                          </span>
                          {stock.multiZone ? <ZoneLabel zone={entry.zone} className={styles.muted} /> : null}
                        </span>
                      </Checkbox>
                    </li>
                  ))}
                </ul>
              </div>
            </FieldGroup>
          )}

          <FieldGroup
            label="Warum?"
            hint={`${REASON_HINTS[reason]} Die Packungen wandern in die Lösch-Historie${retention ? ` und lassen sich dort ${String(retention)} Tage lang wiederherstellen` : ""}.`}
          >
            <SegmentedControl label="Grund" block value={reason} onChange={setReason} options={REMOVAL_REASON_OPTIONS} />
          </FieldGroup>

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
