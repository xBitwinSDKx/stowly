import { useCallback, useDeferredValue, useMemo, useState } from "react";

import { normalizePackageId, ROUTES, useCore, useLive, type Product } from "@/contract";
import { PageBody, PageLoading, usePageTitle } from "@/app/Page";
import { useSearch } from "@/app/search";
import { EmptyState, FilterCard, LinkButton, Notice, packagesText, plural, ROOMY_QUERY, StatCard, useMediaQuery, useUiFlag, WIDE_QUERY } from "@/ui";
import { Button, cx, IconButton, zoneColor, ZoneIcon } from "@/ui/base";
import { CloseIcon, HistoryIcon, PackageIcon, PackageOpenIcon, PackagePlusIcon, ScanIcon, SearchIcon, WarningIcon, ZonesIcon } from "@/ui/icons";

import { useStockDialogs } from "./dialogs";
import { DEFAULT_SORT, filterEntries, groupByProduct, isFiltered, sortGroups, zoneFill, type SortKey, type SortOrder, type StockFilter } from "./model";
import { StockCards, StockTable } from "./StockList";
import styles from "./StockPage.module.css";
import { useStock } from "./useStock";

/** Zeilen, die der Anwender selbst auf- oder zugeklappt hat: Produkt -> offen? */
const NO_ROWS: ReadonlyMap<string, boolean> = new Map();

/**
 * Übersicht und Bestand nach dem Entwurf: Kennzahl-Karten, Überschrift mit „Jetzt scannen",
 * Zonen-Karten als Filter, darunter die nach Produkt gruppierte Bestandsliste mit
 * aufklappbarer Chargen-Ansicht (am Handy als Karten).
 */
export function StockPage() {
  usePageTitle("Bestand");
  const core = useCore();
  const stock = useStock();
  const dialogs = useStockDialogs(stock);
  const app = useLive(core.app.state);
  const removed = useLive(core.data.removedPackages);
  const wide = useMediaQuery(WIDE_QUERY);
  const roomy = useMediaQuery(ROOMY_QUERY);
  const { query, setQuery } = useSearch();
  const deferredQuery = useDeferredValue(query);

  const [zoneFilter, setZoneFilter] = useState<string | null>(null);
  const [expiring, setExpiring] = useState(false);
  const [sort, setSort] = useState<SortOrder>(DEFAULT_SORT);
  // „Details" im Tabellenkopf zeigt alle Chargen-Ansichten; `chosen` hält fest, was der Anwender
  // an einzelnen Zeilen selbst auf- oder zugeklappt hat. Das geht der Vorgabe vor.
  const [detailsAll, setDetailsAll] = useUiFlag("stock.details", false);
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(NO_ROWS);

  const { entries, zones, multiZone, warnings } = stock;
  // Ein Zonen-Filter gilt nur, solange es die Zone gibt und Zonen überhaupt sichtbar sind.
  const zoneId = multiZone && zones.some((zone) => zone.id === zoneFilter) ? zoneFilter : null;
  const filter: StockFilter = useMemo(() => ({ query: deferredQuery, zone_id: zoneId, expiring }), [deferredQuery, zoneId, expiring]);

  const groups = useMemo(() => sortGroups(groupByProduct(filterEntries(entries, filter), zones), sort), [entries, filter, zones, sort]);
  const fill = useMemo(() => zoneFill(entries, zones), [entries, zones]);
  const productCount = useMemo(() => new Set(entries.map((entry) => entry.pkg.product_id)).size, [entries]);
  const shownPackages = useMemo(() => groups.reduce((sum, group) => sum + group.count, 0), [groups]);

  // Bilder nur zeigen, wenn es überhaupt welche gibt: Sonst stünde vor jeder Zeile dasselbe leere Feld.
  const hasImages = useMemo(() => entries.some((entry) => entry.product?.image), [entries]);
  const imageUrl = useCallback((product: Product | undefined) => (product?.image ? core.data.imageUrl(product.image) : null), [core]);

  const filtered = isFiltered(filter);
  // Führt die Suche zu genau einem Produkt, steht dessen Chargen-Ansicht gleich offen.
  const autoOpen = filter.query.trim() !== "" && groups.length === 1;
  const openByDefault = detailsAll || autoOpen;
  const isOpen = useCallback((productId: string) => chosen.get(productId) ?? openByDefault, [chosen, openByDefault]);
  const toggle = useCallback(
    (productId: string) => {
      setChosen((current) => new Map(current).set(productId, !(current.get(productId) ?? openByDefault)));
    },
    [openByDefault],
  );

  function changeSort(key: SortKey) {
    setSort((current) => (current.key === key ? { key, descending: !current.descending } : { key, descending: false }));
  }

  function resetFilters() {
    setQuery("");
    setZoneFilter(null);
    setExpiring(false);
  }

  if (!stock.ready) {
    return (
      <PageBody>
        <h1 className={styles.title}>Bestand</h1>
        <PageLoading label="Bestand wird geladen …" />
      </PageBody>
    );
  }

  const canScan = app?.secure_context !== false;
  const activeZone = zones.find((zone) => zone.id === zoneId);
  // Am Handy stehen Kennzahlen und Zonen-Karten über der Liste. Wer sucht, will die Treffer
  // sehen und nicht erst an ihnen vorbeiwischen: Solange gesucht wird, treten sie zurück.
  const showOverview = wide || filter.query.trim() === "";
  // Sucht jemand eine Packungs-ID, die nicht mehr im Bestand ist, hilft ein Verweis auf die Lösch-Historie.
  const searchedId = normalizePackageId(filter.query);
  const removedHit = searchedId !== null && groups.length === 0 ? removed?.find((pkg) => pkg.id === searchedId) : undefined;

  return (
    <PageBody>
      {showOverview ? (
        <div className={cx(styles.stats, wide && styles.statsWide)}>
          <StatCard label="Packungen gesamt" value={entries.length} icon={<PackageIcon size={22} />} />
          <StatCard
            label="Läuft bald ab"
            tone={warnings.total > 0 ? "warn" : "default"}
            value={warnings.total}
            note={warnings.expired > 0 ? `(${String(warnings.expired)} abgelaufen)` : undefined}
            icon={<WarningIcon size={22} />}
            to={ROUTES.warnings}
          />
          {!wide && multiZone ? (
            <>
              <StatCard label="Aktive Zonen" tone="info" value={zones.length} to={ROUTES.zones} />
              <StatCard label="Produkte" value={productCount} />
            </>
          ) : null}
        </div>
      ) : null}

      <header className={styles.head}>
        <h1 className={styles.title}>Bestand</h1>
        <div className={styles.headActions}>
          {wide || !canScan ? (
            <Button
              variant={canScan ? "secondary" : "primary"}
              size={wide ? "lg" : "md"}
              icon={<PackagePlusIcon />}
              onClick={() => dialogs.open({ kind: "store", zone_id: zoneId })}
            >
              Von Hand einlagern
            </Button>
          ) : (
            <IconButton label="Von Hand einlagern" variant="secondary" onClick={() => dialogs.open({ kind: "store", zone_id: zoneId })}>
              <PackagePlusIcon />
            </IconButton>
          )}
          {canScan ? (
            <LinkButton to={ROUTES.scan} variant="primary" size={wide ? "lg" : "md"} icon={<ScanIcon />}>
              Jetzt scannen
            </LinkButton>
          ) : null}
        </div>
      </header>

      {multiZone && showOverview ? (
        <div className={styles.zones} role="group" aria-label="Nach Zone filtern">
          {fill.map(({ zone, count, share }) => (
            <FilterCard
              key={zone.id}
              label={zone.name}
              icon={<ZoneIcon icon={zone.icon} size={20} />}
              color={zoneColor(zone.color)}
              count={count}
              share={share}
              active={zoneId === zone.id}
              onClick={() => setZoneFilter(zoneId === zone.id ? null : zone.id)}
            />
          ))}
          <FilterCard
            label="Läuft bald ab"
            icon={<WarningIcon size={20} />}
            color="var(--color-warn)"
            count={warnings.total}
            share={entries.length === 0 ? 0 : warnings.total / entries.length}
            active={expiring}
            onClick={() => setExpiring(!expiring)}
          />
        </div>
      ) : null}

      {entries.length === 0 ? (
        <EmptyState
          icon={<PackageOpenIcon size={26} />}
          title="Noch nichts eingelagert"
          actions={
            <>
              {canScan ? (
                <LinkButton to={ROUTES.scan} variant="primary" icon={<ScanIcon />}>
                  Jetzt scannen
                </LinkButton>
              ) : null}
              <Button variant={canScan ? "secondary" : "primary"} icon={<PackagePlusIcon />} onClick={() => dialogs.open({ kind: "store" })}>
                Von Hand einlagern
              </Button>
            </>
          }
        >
          {canScan
            ? "Am schnellsten geht es mit dem Handy: Barcode scannen, MHD eintippen, Etikett aufkleben. Ohne Scanner lässt sich hier von Hand einlagern."
            : "Über diese Adresse gibt es kein Scannen. Hier lässt sich von Hand einlagern."}
        </EmptyState>
      ) : (
        <>
          {filtered || !wide || (!multiZone && warnings.total > 0) ? (
            <div className={styles.toolbar}>
              <span className={styles.summary} role="status">
                {plural(groups.length, "Produkt", "Produkte")} · {packagesText(shownPackages)}
              </span>
              {!multiZone && warnings.total > 0 ? (
                <button type="button" className={cx(styles.chip, styles.toggle, expiring && styles.chipOn)} aria-pressed={expiring} onClick={() => setExpiring(!expiring)}>
                  <WarningIcon size={15} aria-hidden="true" />
                  Läuft bald ab
                  <span className="tabular">{warnings.total}</span>
                </button>
              ) : null}
              {filter.query.trim() !== "" ? (
                <button type="button" className={styles.chip} onClick={() => setQuery("")}>
                  <SearchIcon size={15} aria-hidden="true" />
                  <span className={styles.chipText}>„{filter.query.trim()}“</span>
                  <CloseIcon size={15} aria-hidden="true" />
                  <span className="sr-only">Suche zurücksetzen</span>
                </button>
              ) : null}
              {activeZone ? (
                <button type="button" className={styles.chip} onClick={() => setZoneFilter(null)}>
                  <ZonesIcon size={15} aria-hidden="true" />
                  <span className={styles.chipText}>{activeZone.name}</span>
                  <CloseIcon size={15} aria-hidden="true" />
                  <span className="sr-only">Zonen-Filter zurücksetzen</span>
                </button>
              ) : null}
              {expiring && multiZone ? (
                <button type="button" className={styles.chip} onClick={() => setExpiring(false)}>
                  <WarningIcon size={15} aria-hidden="true" />
                  <span className={styles.chipText}>Läuft bald ab</span>
                  <CloseIcon size={15} aria-hidden="true" />
                  <span className="sr-only">Filter zurücksetzen</span>
                </button>
              ) : null}
              {!wide && groups.length > 0 ? (
                <button
                  type="button"
                  className={cx(styles.chip, styles.toggle, styles.end, detailsAll && styles.chipOn)}
                  aria-pressed={detailsAll}
                  onClick={() => {
                    setDetailsAll(!detailsAll);
                    setChosen(NO_ROWS);
                  }}
                >
                  Details
                </button>
              ) : null}
            </div>
          ) : null}

          {groups.length === 0 ? (
            <EmptyState
              icon={<SearchIcon size={26} />}
              title="Keine Treffer"
              actions={
                <Button onClick={resetFilters} icon={<CloseIcon />}>
                  Filter zurücksetzen
                </Button>
              }
            >
              {filter.query.trim() !== ""
                ? `Zu „${filter.query.trim()}“ ist nichts im Bestand${activeZone || expiring ? " (mit den gewählten Filtern)" : ""}. Gesucht wird in Produktname, Marke, Barcode und Packungs-ID.`
                : "Mit diesen Filtern ist nichts im Bestand."}
            </EmptyState>
          ) : wide ? (
            <StockTable
              groups={groups}
              multiZone={multiZone}
              isOpen={isOpen}
              onToggle={toggle}
              markOpen={!detailsAll}
              dialogs={dialogs}
              imageUrl={hasImages ? imageUrl : null}
              sort={sort}
              onSort={changeSort}
              compact={!roomy}
              detailsAll={detailsAll}
              onDetailsAll={(value) => {
                setDetailsAll(value);
                setChosen(NO_ROWS);
              }}
            />
          ) : (
            <StockCards
              groups={groups}
              multiZone={multiZone}
              isOpen={isOpen}
              onToggle={toggle}
              markOpen={!detailsAll}
              dialogs={dialogs}
              imageUrl={hasImages ? imageUrl : null}
            />
          )}
        </>
      )}

      {/* Auch bei leerem Bestand: Gerade dann liegt die gesuchte Packung vielleicht in der Lösch-Historie. */}
      {removedHit ? (
        <Notice
          tone="info"
          icon={<HistoryIcon />}
          title={`Die Packung ${removedHit.id} wurde entnommen.`}
          action={
            <LinkButton to={ROUTES.history} size="sm">
              Zur Lösch-Historie
            </LinkButton>
          }
        >
          Dort lässt sie sich wiederherstellen.
        </Notice>
      ) : null}

      {dialogs.element}
    </PageBody>
  );
}
