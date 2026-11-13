import { formatDate } from "@/contract";
import { ExpiryLabel, PackageIds, ZoneLabel } from "@/ui";
import { Button, cx } from "@/ui/base";
import { ChevronUpIcon, PackagePlusIcon } from "@/ui/icons";
import table from "@/ui/Table.module.css";

import styles from "./BatchPanel.module.css";
import type { StockDialogs } from "./dialogs";
import type { Batch, ProductGroup } from "./model";

export interface BatchPanelProps {
  /** Für `aria-controls` der Schaltfläche „Details". */
  id: string;
  group: ProductGroup;
  /** Zonen zeigen (mehr als eine Zone). */
  multiZone: boolean;
  /** Genug Platz für eine Tabelle; sonst eine Liste aus Karten. */
  wide: boolean;
  dialogs: StockDialogs;
  onCollapse: () => void;
}

/** Eine Charge in Worten, für die Beschriftung ihrer Schaltflächen. */
function batchLabel(batch: Batch, multiZone: boolean): string {
  const date = batch.best_before ? `MHD ${formatDate(batch.best_before)}` : "ohne MHD";
  return multiZone && batch.zone ? `${date}, ${batch.zone.name}` : date;
}

/**
 * Die aufgeklappte Chargen-Ansicht unter einer Zeile der Bestandsliste:
 * eine Zeile je Kombination aus MHD und Zone, mit Menge und Packungs-IDs.
 */
export function BatchPanel({ id, group, multiZone, wide, dialogs, onCollapse }: BatchPanelProps) {
  function actions(batch: Batch) {
    const label = batchLabel(batch, multiZone);
    return (
      <>
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
          <Button
            size="sm"
            variant="ghost"
            icon={<PackagePlusIcon />}
            disabled={!group.product}
            onClick={() => dialogs.open({ kind: "store", product_id: group.product_id, zone_id: group.zone_ids.length === 1 ? group.zone_ids[0] : null })}
          >
            Weitere einlagern
          </Button>
          <Button size="sm" variant="ghost" iconRight={<ChevronUpIcon />} onClick={onCollapse}>
            Einklappen
          </Button>
        </div>
      </header>

      {wide ? (
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
                  <ExpiryLabel date={batch.best_before} state={batch.state} days={batch.days} detail emptyText="ohne MHD" />
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
                <ExpiryLabel date={batch.best_before} state={batch.state} days={batch.days} detail emptyText="ohne MHD" />
                <span className={styles.amount}>
                  <span className="tabular">{batch.count}</span> ×
                </span>
              </div>
              {multiZone ? <ZoneLabel zone={batch.zone} className={styles.zone} /> : null}
              <PackageIds ids={batch.ids} />
              <div className={styles.itemActions}>{actions(batch)}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
