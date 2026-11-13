import { useId, useState, type MouseEvent, type ReactNode } from "react";

import { isPlaceholder, type Product } from "@/contract";
import { ExpiryLabel, ZoneLabel } from "@/ui";
import { Badge, Button, Card, cx, IconButton, Spinner, Switch } from "@/ui/base";
import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, ChevronUpIcon, PackageIcon } from "@/ui/icons";
import table from "@/ui/Table.module.css";

import { BatchPanel } from "./BatchPanel";
import type { StockDialogs } from "./dialogs";
import type { ProductGroup, SortKey, SortOrder } from "./model";
import styles from "./StockList.module.css";

export interface StockListProps {
  /** Die Zeilen, schon gefiltert und sortiert. */
  groups: readonly ProductGroup[];
  /** Zonen zeigen (mehr als eine Zone). */
  multiZone: boolean;
  /** Ist die Chargen-Ansicht dieses Produkts aufgeklappt? */
  isOpen: (productId: string) => boolean;
  onToggle: (productId: string) => void;
  /**
   * Aufgeklappte Zeilen als ausgewählt markieren (Akzent-Kontur). Aus, wenn ohnehin alle
   * Chargen-Ansichten offen stehen: Dann wäre jede Zeile markiert und keine mehr hervorgehoben.
   */
  markOpen: boolean;
  dialogs: StockDialogs;
  /** Adresse eines Produktbilds oder null. Nur gesetzt, wenn überhaupt ein Produkt ein Bild hat. */
  imageUrl: ((product: Product | undefined) => string | null) | null;
}

export interface StockTableProps extends StockListProps {
  sort: SortOrder;
  onSort: (key: SortKey) => void;
  /** Umschalter „Details" im Tabellenkopf: alle Chargen-Ansichten zeigen. */
  detailsAll: boolean;
  onDetailsAll: (value: boolean) => void;
  /** Wenig Platz (schmales Fenster, Tablet): engere Zellen, „Details" nur als Pfeil. */
  compact: boolean;
}

/** Kleines Kennzeichen an Produkten, die noch keinen Namen haben. */
function PlaceholderBadge({ product }: { product: Product | undefined }) {
  if (!product) {
    return <Badge>wird geladen</Badge>;
  }
  if (!isPlaceholder(product)) {
    return null;
  }
  if (product.lookup === "pending") {
    return (
      <Badge tone="info">
        <Spinner size={10} />
        wird nachgeschlagen
      </Badge>
    );
  }
  return <Badge tone="warn">ohne Namen</Badge>;
}

/** Produktbild; ohne Bild oder wenn es sich (offline) nicht laden lässt, ein neutrales Symbol. */
function Thumb({ url }: { url: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span className={styles.thumb} aria-hidden="true">
      {url && failed !== url ? <img src={url} alt="" loading="lazy" decoding="async" onError={() => setFailed(url)} /> : <PackageIcon size={18} />}
    </span>
  );
}

function Zones({ group, max }: { group: ProductGroup; max: number }) {
  // Jede Charge kennt ihre Zone; je Zone genügt die erste.
  const zones = group.zone_ids.map((zoneId) => group.batches.find((batch) => batch.zone_id === zoneId)?.zone);
  const shown = zones.slice(0, max);
  const rest = zones.length - shown.length;
  return (
    <span className={styles.zones}>
      {shown.map((zone, index) => (
        <ZoneLabel key={group.zone_ids[index]} zone={zone} />
      ))}
      {rest > 0 ? (
        <span
          className={styles.more}
          title={zones
            .slice(max)
            .map((zone) => zone?.name ?? "Unbekannte Zone")
            .join(", ")}
        >
          +{rest}
        </span>
      ) : null}
    </span>
  );
}

function rowActions(group: ProductGroup, open: boolean, panelId: string, onToggle: () => void, dialogs: StockDialogs, compact = false): ReactNode {
  return (
    <>
      {compact ? (
        <IconButton size="sm" label={`Details: ${group.title}`} aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={onToggle}>
          {open ? <ChevronUpIcon /> : <ChevronDownIcon />}
        </IconButton>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Details: ${group.title}`}
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          iconRight={open ? <ChevronUpIcon /> : <ChevronDownIcon />}
          onClick={onToggle}
        >
          Details
        </Button>
      )}
      <Button
        size="sm"
        aria-label={`Bearbeiten: ${group.title}`}
        disabled={!group.product}
        onClick={() => dialogs.open({ kind: "product", product_id: group.product_id })}
      >
        Bearbeiten
      </Button>
      <Button
        size="sm"
        variant="danger"
        aria-label={`Löschen: ${group.title}`}
        onClick={() =>
          dialogs.open({
            kind: "remove",
            package_ids: group.entries.map((entry) => entry.pkg.id),
            // Eine einzelne Packung ist gemeint; bei mehreren wählt man lieber bewusst aus.
            selection: group.count === 1 ? "all" : "none",
          })
        }
      >
        Löschen
      </Button>
    </>
  );
}

/**
 * Die gruppierte Bestandsliste als Tabelle (Desktop): eine Zeile je Produkt.
 *
 * Für Screenreader eine Tabelle (ARIA-Rollen), gezeichnet als Raster: So ist jede
 * Produktgruppe ein eigenes Element und kann als Ganzes die Akzent-Kontur tragen, wenn
 * ihre Chargen-Ansicht offen ist. Die Spalten richten sich wie in einer Tabelle nach
 * ihrem breitesten Inhalt (Unterraster).
 */
export function StockTable({ groups, multiZone, isOpen, onToggle, markOpen, dialogs, imageUrl, sort, onSort, detailsAll, onDetailsAll, compact }: StockTableProps) {
  const baseId = useId();

  function sortHead(key: SortKey, label: string, numeric = false) {
    const active = sort.key === key;
    return (
      <div role="columnheader" className={cx(styles.th, numeric && styles.num)} aria-sort={active ? (sort.descending ? "descending" : "ascending") : undefined}>
        <button type="button" className={cx(styles.sort, active && styles.sortActive)} onClick={() => onSort(key)}>
          {label}
          {active ? sort.descending ? <ArrowDownIcon size={14} aria-hidden="true" /> : <ArrowUpIcon size={14} aria-hidden="true" /> : null}
        </button>
      </div>
    );
  }

  /** Ein Klick irgendwo in die Zeile klappt die Details auf; Schaltflächen behalten ihre eigene Wirkung. */
  function rowClick(event: MouseEvent<HTMLDivElement>, productId: string) {
    if (event.target instanceof Element && event.target.closest("button, a, input, label")) {
      return;
    }
    onToggle(productId);
  }

  return (
    <div className={table.wrap}>
      <div role="table" aria-label="Bestand" className={cx(styles.list, !multiZone && styles.noZone, compact && styles.compact)}>
        <div role="rowgroup" className={styles.head}>
          <div role="row" className={styles.headRow}>
            {sortHead("title", "Produkt")}
            {multiZone ? (
              <div role="columnheader" className={styles.th}>
                Zone
              </div>
            ) : null}
            {sortHead("critical", "Kritischstes MHD")}
            {sortHead("count", compact ? "Menge" : "Gesamtmenge", true)}
            <div role="columnheader" className={cx(styles.th, styles.actionsHead)}>
              <span>Aktionen</span>
              <Switch label="Details" checked={detailsAll} onChange={onDetailsAll} className={styles.detailsSwitch} />
            </div>
          </div>
        </div>
        {groups.map((group, index) => {
          const open = isOpen(group.product_id);
          const panelId = `${baseId}-${String(index)}`;
          return (
            <div role="rowgroup" key={group.product_id} className={cx(styles.group, open && markOpen && styles.selected)}>
              <div role="row" className={styles.row} onClick={(event) => rowClick(event, group.product_id)}>
                <div role="cell" className={styles.td}>
                  <div className={styles.product}>
                    {imageUrl ? <Thumb url={imageUrl(group.product)} /> : null}
                    <div className={styles.productText}>
                      <div className={styles.productTitle}>
                        <span className={table.primary}>{group.title}</span>
                        <PlaceholderBadge product={group.product} />
                      </div>
                      {group.subtitle !== "" ? <div className={table.secondary}>{group.subtitle}</div> : null}
                    </div>
                  </div>
                </div>
                {multiZone ? (
                  <div role="cell" className={styles.td}>
                    <Zones group={group} max={2} />
                  </div>
                ) : null}
                <div role="cell" className={styles.td}>
                  <ExpiryLabel date={group.critical} state={group.state} days={group.days} />
                </div>
                <div role="cell" className={cx(styles.td, styles.num)}>
                  {group.count}
                </div>
                <div role="cell" className={cx(styles.td, styles.actions)}>
                  {rowActions(group, open, panelId, () => onToggle(group.product_id), dialogs, compact)}
                </div>
              </div>
              {open ? (
                <div role="row" className={styles.panelRow}>
                  <div role="cell" className={styles.panelCell}>
                    <BatchPanel id={panelId} group={group} multiZone={multiZone} wide dialogs={dialogs} onCollapse={() => onToggle(group.product_id)} />
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Die gruppierte Bestandsliste als Karten (Handy): Name, drei beschriftete Werte, Aktionen. */
export function StockCards({ groups, multiZone, isOpen, onToggle, markOpen, dialogs, imageUrl }: StockListProps) {
  const baseId = useId();
  return (
    <ul className={styles.cards}>
      {groups.map((group, index) => {
        const open = isOpen(group.product_id);
        const panelId = `${baseId}-${String(index)}`;
        return (
          <Card as="li" key={group.product_id} padding="none" selected={open && markOpen} className={styles.card}>
            <div className={styles.cardMain}>
              <div className={styles.product}>
                {imageUrl ? <Thumb url={imageUrl(group.product)} /> : null}
                <div className={styles.productText}>
                  <div className={styles.productTitle}>
                    <h3 className={styles.cardTitle}>{group.title}</h3>
                    <PlaceholderBadge product={group.product} />
                  </div>
                  {group.subtitle !== "" ? <div className={table.secondary}>{group.subtitle}</div> : null}
                </div>
              </div>
              <dl className={cx(styles.values, !multiZone && styles.twoValues)}>
                {multiZone ? (
                  <div>
                    <dt>Zone</dt>
                    <dd>
                      <Zones group={group} max={1} />
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt>Menge</dt>
                  <dd className="tabular">{group.count}</dd>
                </div>
                <div>
                  <dt>Kritischstes MHD</dt>
                  <dd>
                    <ExpiryLabel date={group.critical} state={group.state} days={group.days} />
                  </dd>
                </div>
              </dl>
              <div className={styles.cardActions}>{rowActions(group, open, panelId, () => onToggle(group.product_id), dialogs)}</div>
            </div>
            {open ? (
              <BatchPanel id={panelId} group={group} multiZone={multiZone} wide={false} dialogs={dialogs} onCollapse={() => onToggle(group.product_id)} />
            ) : null}
          </Card>
        );
      })}
    </ul>
  );
}
