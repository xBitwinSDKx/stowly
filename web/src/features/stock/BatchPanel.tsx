import { formatDate } from "@/contract";
import { useHasPrinter } from "@/features/printers/usePrinting";
import { ShoppingButton } from "@/features/shopping/ShoppingButton";
import { ExpiryLabel, PackageIds, packagesText, ZoneLabel } from "@/ui";
import { Badge, Button, cx, IconButton } from "@/ui/base";
import { ChevronUpIcon, PackagePlusIcon, PrinterIcon } from "@/ui/icons";
import table from "@/ui/Table.module.css";

import styles from "./BatchPanel.module.css";
import type { StockDialogs } from "./dialogs";

/** Die Chargen-Ansicht öffnet Dialoge, mehr braucht sie von ihnen nicht. */
type DialogOpener = Pick<StockDialogs, "open">;
import type { Batch, ProductGroup } from "./model";

export interface BatchPanelProps {
  /** Für `aria-controls` der Schaltfläche „Details". */
  id: string;
  group: ProductGroup;
  /** Zonen zeigen (mehr als eine Zone). */
  multiZone: boolean;
  /** Genug Platz für eine Tabelle; sonst eine Liste aus Karten. */
  wide: boolean;
  dialogs: DialogOpener;
  onCollapse: () => void;
}

/** Eine Charge in Worten, für die Beschriftung ihrer Schaltflächen. */
function batchLabel(batch: Batch, multiZone: boolean): string {
  const date = batch.best_before ? `MHD ${formatDate(batch.best_before)}` : "ohne MHD";
  return multiZone && batch.zone ? `${date}, ${batch.zone.name}` : date;
}

/**
 * Die Charge, die als Nächstes dran ist (FIFO: früheres MHD, dann zuerst eingelagert).
 * Unaufdringlich: nur, wenn es überhaupt eine Wahl gibt, also bei mehr als einer Charge.
 */
function NextBadge() {
  return (
    <Badge tone="accent" className={styles.next} title="Als Nächstes verbrauchen: früheres MHD, sonst zuerst eingelagert">
      als Nächstes<span className="sr-only"> verbrauchen</span>
    </Badge>
  );
}

/** Mindestbestand, Bestand und was fehlt, als eine Zeile. */
function minStockText(group: ProductGroup): string | null {
  const minimum = group.product?.min_stock ?? null;
  if (minimum === null) {
    return null;
  }
  const missing = group.missing > 0 ? `, es ${group.missing === 1 ? "fehlt" : "fehlen"} ${packagesText(group.missing)}` : "";
  return `Mindestbestand ${packagesText(minimum)}, im Bestand ${String(group.stock)}${missing}.`;
}

/**
 * Die aufgeklappte Chargen-Ansicht unter einer Zeile der Bestandsliste:
 * eine Zeile je Kombination aus MHD und Zone, mit Menge und Packungs-IDs.
 * Die Charge, die als Nächstes dran ist, trägt eine Marke; „Auf die Einkaufsliste" setzt das Produkt
 * auf die Liste oder sagt, dass es dort schon steht.
 */
export function BatchPanel({ id, group, multiZone, wide, dialogs, onCollapse }: BatchPanelProps) {
  // Ohne Drucker fordert Stowly keine Etiketten an: Dann gibt es auch keinen Nachdruck.
  const hasPrinter = useHasPrinter();
  // Die nächste Charge zu markieren lohnt sich nur, wenn es mehr als eine gibt.
  const markNext = group.batches.length > 1;
  const minStock = minStockText(group);

  /** @param narrow am Handy: „Etikett" nur als Symbol, damit „Bearbeiten" und „Entnehmen" ihren Platz behalten */
  function actions(batch: Batch, narrow = false) {
    const label = batchLabel(batch, multiZone);
    const reprint = () => dialogs.open({ kind: "labels", package_ids: batch.ids });
    return (
      <>
        {hasPrinter ? (
          narrow ? (
            <IconButton size="sm" variant="secondary" label={`Etikett drucken: ${label}`} className={styles.labelButton} onClick={reprint}>
              <PrinterIcon />
            </IconButton>
          ) : (
            <Button size="sm" variant="ghost" icon={<PrinterIcon />} aria-label={`Etikett drucken: ${label}`} onClick={reprint}>
              Etikett
            </Button>
          )
        ) : null}
        <Button size="sm" aria-label={`Bearbeiten: ${label}`} onClick={() => dialogs.open({ kind: "packages", package_ids: batch.ids })}>
          Bearbeiten
        </Button>
        <Button
          size="sm"
          aria-label={`Entnehmen: ${label}`}
          onClick={() =>
            dialogs.open({
              kind: "remove",
              package_ids: batch.ids,
              // Welche Packung es ist, steht auf ihrem Etikett: bei mehreren bewusst auswählen lassen.
              selection: batch.count === 1 ? "all" : "none",
              reason: batch.state === "expired" ? "discarded" : "consumed",
            })
          }
        >
          Entnehmen
        </Button>
      </>
    );
  }

  return (
    <section id={id} className={styles.panel} aria-label={`Bestand im Detail: ${group.title}`}>
      <header className={styles.head}>
        <h3 className={styles.title}>
          Bestand im Detail: <span className={styles.name}>{group.title}</span>
        </h3>
        <div className={styles.headActions}>
          <ShoppingButton product={group.product} />
          <Button
            size="sm"
            variant="ghost"
            icon={<PackagePlusIcon />}
            disabled={!group.product}
            onClick={() => dialogs.open({ kind: "store", product_id: group.product_id, zone_id: group.zone_ids.length === 1 ? group.zone_ids[0] : null })}
          >
            {group.count === 0 ? "Einlagern" : "Weitere einlagern"}
          </Button>
          <Button size="sm" variant="ghost" iconRight={<ChevronUpIcon />} onClick={onCollapse}>
            Einklappen
          </Button>
        </div>
      </header>
      {minStock ? <p className={styles.note}>{minStock}</p> : null}

      {group.batches.length === 0 ? (
        <p className={styles.note}>Nichts im Bestand.</p>
      ) : wide ? (
        <table className={cx(table.table, styles.table)}>
          <thead>
            <tr>
              <th className={table.th}>MHD</th>
              <th className={cx(table.th, table.num)}>Menge</th>
              {multiZone ? <th className={table.th}>Zone</th> : null}
              <th className={table.th}>Packungs-IDs</th>
              <th className={table.th}>
                <span className="sr-only">Aktionen</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {group.batches.map((batch) => (
              <tr key={batch.key}>
                <td className={cx(table.td, table.narrow)}>
                  <span className={styles.when}>
                    <ExpiryLabel date={batch.best_before} state={batch.state} days={batch.days} detail emptyText="ohne MHD" />
                    {markNext && batch.next ? <NextBadge /> : null}
                  </span>
                </td>
                <td className={cx(table.td, table.num, table.narrow)}>{batch.count}</td>
                {multiZone ? (
                  <td className={cx(table.td, table.narrow)}>
                    <ZoneLabel zone={batch.zone} truncate={false} />
                  </td>
                ) : null}
                <td className={table.td}>
                  <PackageIds ids={batch.ids} />
                </td>
                <td className={cx(table.td, table.narrow)}>
                  <div className={table.actions}>{actions(batch)}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <ul className={styles.list}>
          {group.batches.map((batch) => (
            <li key={batch.key} className={styles.item}>
              <div className={styles.itemHead}>
                <span className={styles.when}>
                  <ExpiryLabel date={batch.best_before} state={batch.state} days={batch.days} detail emptyText="ohne MHD" />
                  {markNext && batch.next ? <NextBadge /> : null}
                </span>
                <span className={styles.amount}>
                  <span className="tabular">{batch.count}</span> ×
                </span>
              </div>
              {multiZone ? <ZoneLabel zone={batch.zone} className={styles.zone} /> : null}
              <PackageIds ids={batch.ids} />
              <div className={styles.itemActions}>{actions(batch, true)}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
