import { useMemo, useState } from "react";

import {
  formatDate,
  formatTimestamp,
  productSubtitle,
  productTitle,
  ROUTES,
  useCore,
  useLive,
  type Package,
  type Product,
  type RemovalReason,
  type Zone,
} from "@/contract";
import { Page, PageLoading } from "@/app/Page";
import {
  Checkbox,
  EmptyState,
  errorText,
  Notice,
  PackageId,
  packagesText,
  plural,
  REMOVAL_REASON_LABELS,
  ROOMY_QUERY,
  TextLink,
  useMediaQuery,
  ZoneLabel,
} from "@/ui";
import { Button, Card, cx, Dialog, useToast } from "@/ui/base";
import { ChevronDownIcon, HistoryIcon, InfoIcon, RestoreIcon } from "@/ui/icons";
import table from "@/ui/Table.module.css";

import styles from "./HistoryPage.module.css";
import { displacedLines, type DisplacedLine } from "./model";

const REASONS: readonly RemovalReason[] = ["consumed", "discarded", "mistake"];

/** Der Grund lässt sich nachträglich ändern: So wird aus „verbraucht" noch „entsorgt". */
function ReasonSelect({ pkg, onChange }: { pkg: Package; onChange: (reason: RemovalReason) => void }) {
  return (
    <span className={styles.reason}>
      <select
        className={styles.reasonSelect}
        aria-label={`Grund für ${pkg.id}`}
        value={pkg.removal_reason ?? ""}
        onChange={(event) => onChange(event.target.value as RemovalReason)}
      >
        {pkg.removal_reason === null ? <option value="">ohne Grund</option> : null}
        {REASONS.map((reason) => (
          <option key={reason} value={reason}>
            {REMOVAL_REASON_LABELS[reason]}
          </option>
        ))}
      </select>
      <ChevronDownIcon size={14} aria-hidden="true" className={styles.reasonChevron} />
    </span>
  );
}

/** Was eine verdrängte Bearbeitung ändern wollte, und die Schaltfläche, sie mit zu übernehmen. */
function DisplacedNote({ pkg, lines, onApply }: { pkg: Package; lines: DisplacedLine[]; onApply: () => void }) {
  return (
    <Notice
      tone="info"
      icon={<InfoIcon />}
      title="Verdrängte Bearbeitung"
      action={
        <Button size="sm" aria-label={`Mit Bearbeitung wiederherstellen: ${pkg.id}`} onClick={onApply}>
          Mit Bearbeitung wiederherstellen
        </Button>
      }
    >
      {pkg.displaced ? `Am ${formatTimestamp(pkg.displaced.at)} sollte diese Packung geändert werden, war aber schon entnommen: ` : null}
      {lines.map((line, index) => (
        <span key={line.field}>
          {index > 0 ? "; " : null}
          {line.label} <span className={styles.from}>{line.from}</span> → <strong>{line.to}</strong>
        </span>
      ))}
      .
    </Notice>
  );
}

/**
 * Lösch-Historie: entnommene und gelöschte Packungen innerhalb der Aufbewahrungsdauer,
 * einzeln oder mehrere auf einmal wiederherstellbar. Hat eine Packung eine verdrängte
 * Bearbeitung, lässt sich diese beim Wiederherstellen übernehmen.
 */
export function HistoryPage() {
  const core = useCore();
  const toast = useToast();
  // Die Tabelle hat acht Spalten und braucht viel Platz; darunter zeigt die Ansicht Karten.
  const wide = useMediaQuery(ROOMY_QUERY);
  const removed = useLive(core.data.removedPackages);
  const products = useLive(core.data.products);
  const zones = useLive(core.data.zones);
  const settings = useLive(core.data.settings);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  /** Rückfrage beim Wiederherstellen mehrerer Packungen, von denen einige eine verdrängte Bearbeitung haben. */
  const [ask, setAsk] = useState<string[] | null>(null);

  const productById = useMemo(() => new Map((products ?? []).map((product) => [product.id, product])), [products]);
  const zoneById = useMemo(() => new Map((zones ?? []).map((zone) => [zone.id, zone])), [zones]);

  if (!removed || !settings) {
    return (
      <Page title="Lösch-Historie">
        <PageLoading label="Lösch-Historie wird geladen …" />
      </Page>
    );
  }

  const multiZone = (zones?.length ?? 0) > 1;
  // Nur zählen, was noch in der Liste steht: Die Historie ändert sich unter der Auswahl.
  const chosen = removed.filter((pkg) => selected.has(pkg.id)).map((pkg) => pkg.id);
  const allChosen = removed.length > 0 && chosen.length === removed.length;

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

  async function restore(ids: string[], applyDisplaced: boolean) {
    setBusy(true);
    try {
      await core.stock.restore(ids, { apply_displaced: applyDisplaced });
      setSelected((current) => new Set([...current].filter((id) => !ids.includes(id))));
      toast.show({
        message:
          ids.length === 1
            ? `Packung ${ids[0] ?? ""} wiederhergestellt${applyDisplaced ? ", Bearbeitung übernommen" : ""}`
            : `${packagesText(ids.length)} wiederhergestellt${applyDisplaced ? ", Bearbeitungen übernommen" : ""}`,
        tone: "success",
      });
    } catch (caught) {
      toast.show({ message: errorText(caught, { not_found: "Mindestens eine der Packungen gibt es nicht mehr." }), tone: "danger" });
    } finally {
      setBusy(false);
      setAsk(null);
    }
  }

  function restoreChosen() {
    const withEdit = removed?.some((pkg) => chosen.includes(pkg.id) && pkg.displaced !== null) ?? false;
    if (withEdit) {
      setAsk(chosen);
    } else {
      void restore(chosen, false);
    }
  }

  function changeReason(pkg: Package, reason: RemovalReason) {
    // Für eine entnommene Packung ändert `remove` nur den Grund.
    core.stock.remove([pkg.id], reason).catch((caught: unknown) => toast.show({ message: errorText(caught), tone: "danger" }));
  }

  const details = (pkg: Package) => {
    const product: Product | undefined = productById.get(pkg.product_id);
    const zone: Zone | undefined = zoneById.get(pkg.zone_id);
    const lines = pkg.displaced ? displacedLines(pkg, pkg.displaced, products ?? [], zones ?? []) : [];
    return { product, zone, lines };
  };

  const askCount = ask ? removed.filter((pkg) => ask.includes(pkg.id) && pkg.displaced !== null).length : 0;

  return (
    <Page
      title="Lösch-Historie"
      description={
        <>
          Entnommene und gelöschte Packungen bleiben {plural(settings.trash_retention_days, "Tag", "Tage")} hier und lassen sich so lange wiederherstellen.
          Danach verschwinden sie endgültig. <TextLink to={ROUTES.settings}>Aufbewahrungsdauer ändern</TextLink>
        </>
      }
    >
      {removed.length === 0 ? (
        <EmptyState icon={<HistoryIcon size={26} />} title="Noch nichts entnommen">
          Hier erscheint, was entnommen oder gelöscht wurde: mit Zeitpunkt, Grund und der Möglichkeit, es wiederherzustellen.
        </EmptyState>
      ) : (
        <>
          <div className={styles.bar}>
            {wide ? (
              <span className={styles.barText}>{packagesText(removed.length)}</span>
            ) : (
              <Checkbox
                checked={allChosen}
                indeterminate={chosen.length > 0 && !allChosen}
                onChange={(checked) => setSelected(new Set(checked ? removed.map((pkg) => pkg.id) : []))}
              >
                Alle {removed.length} auswählen
              </Checkbox>
            )}
            <div className={styles.barActions}>
              {chosen.length > 0 ? (
                <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                  Auswahl aufheben
                </Button>
              ) : null}
              <Button variant="primary" icon={<RestoreIcon />} disabled={chosen.length === 0 || busy} onClick={restoreChosen}>
                {chosen.length === 0 ? "Auswahl wiederherstellen" : `${String(chosen.length)} wiederherstellen`}
              </Button>
            </div>
          </div>

          {wide ? (
            <div className={table.wrap}>
              <table className={cx(table.table, table.dense)}>
                <thead>
                  <tr>
                    <th className={cx(table.th, table.narrow)}>
                      <Checkbox
                        className={styles.check}
                        label="Alle auswählen"
                        checked={allChosen}
                        indeterminate={chosen.length > 0 && !allChosen}
                        onChange={(checked) => setSelected(new Set(checked ? removed.map((pkg) => pkg.id) : []))}
                      />
                    </th>
                    <th className={table.th}>Produkt</th>
                    <th className={table.th}>ID</th>
                    <th className={table.th}>MHD</th>
                    {multiZone ? <th className={table.th}>Zone</th> : null}
                    <th className={table.th}>Entnommen</th>
                    <th className={table.th}>Grund</th>
                    <th className={table.th}>
                      <span className="sr-only">Aktionen</span>
                    </th>
                  </tr>
                </thead>
                {removed.map((pkg) => {
                  const { product, zone, lines } = details(pkg);
                  return (
                    <tbody key={pkg.id}>
                      <tr className={table.row}>
                        <td className={cx(table.td, table.narrow)}>
                          <Checkbox
                            className={styles.check}
                            label={`${pkg.id} auswählen`}
                            checked={selected.has(pkg.id)}
                            onChange={(checked) => toggle(pkg.id, checked)}
                          />
                        </td>
                        <td className={table.td}>
                          <div className={table.primary}>{productTitle(product)}</div>
                          {productSubtitle(product) !== "" ? <div className={table.secondary}>{productSubtitle(product)}</div> : null}
                        </td>
                        <td className={cx(table.td, table.narrow)}>
                          <PackageId id={pkg.id} />
                        </td>
                        <td className={cx(table.td, table.narrow, "tabular")}>{pkg.best_before ? formatDate(pkg.best_before) : <span className={styles.none}>–</span>}</td>
                        {multiZone ? (
                          <td className={table.td}>
                            <ZoneLabel zone={zone} />
                          </td>
                        ) : null}
                        <td className={cx(table.td, table.narrow, "tabular")}>{pkg.removed_at ? formatTimestamp(pkg.removed_at) : "–"}</td>
                        <td className={cx(table.td, table.narrow)}>
                          <ReasonSelect pkg={pkg} onChange={(reason) => changeReason(pkg, reason)} />
                        </td>
                        <td className={cx(table.td, table.narrow)}>
                          <div className={table.actions}>
                            <Button size="sm" aria-label={`Wiederherstellen: ${pkg.id}`} disabled={busy} onClick={() => void restore([pkg.id], false)}>
                              Wiederherstellen
                            </Button>
                          </div>
                        </td>
                      </tr>
                      {lines.length > 0 ? (
                        <tr>
                          <td className={styles.noteCell} />
                          <td className={styles.noteCell} colSpan={multiZone ? 7 : 6}>
                            <DisplacedNote pkg={pkg} lines={lines} onApply={() => void restore([pkg.id], true)} />
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  );
                })}
              </table>
            </div>
          ) : (
            <ul className={styles.cards}>
              {removed.map((pkg) => {
                const { product, zone, lines } = details(pkg);
                return (
                  <Card as="li" key={pkg.id} padding="none" selected={selected.has(pkg.id)}>
                    <div className={styles.card}>
                      <Checkbox className={styles.cardCheck} checked={selected.has(pkg.id)} onChange={(checked) => toggle(pkg.id, checked)}>
                        <span className={styles.cardHead}>
                          <span className={styles.cardTitle}>{productTitle(product)}</span>
                          <PackageId id={pkg.id} />
                        </span>
                      </Checkbox>
                      <dl className={styles.facts}>
                        <div>
                          <dt>MHD</dt>
                          <dd className="tabular">{pkg.best_before ? formatDate(pkg.best_before) : "–"}</dd>
                        </div>
                        {multiZone ? (
                          <div>
                            <dt>Zone</dt>
                            <dd>
                              <ZoneLabel zone={zone} />
                            </dd>
                          </div>
                        ) : null}
                        <div>
                          <dt>Entnommen</dt>
                          <dd className="tabular">{pkg.removed_at ? formatTimestamp(pkg.removed_at) : "–"}</dd>
                        </div>
                        <div>
                          <dt>Grund</dt>
                          <dd>
                            <ReasonSelect pkg={pkg} onChange={(reason) => changeReason(pkg, reason)} />
                          </dd>
                        </div>
                      </dl>
                      {lines.length > 0 ? (
                        <div className={styles.cardNote}>
                          <DisplacedNote pkg={pkg} lines={lines} onApply={() => void restore([pkg.id], true)} />
                        </div>
                      ) : null}
                      <div className={styles.cardAction}>
                        <Button block aria-label={`Wiederherstellen: ${pkg.id}`} disabled={busy} onClick={() => void restore([pkg.id], false)}>
                          Wiederherstellen
                        </Button>
                      </div>
                    </div>
                  </Card>
                );
              })}
            </ul>
          )}
        </>
      )}

      <Dialog
        open={ask !== null}
        onClose={() => setAsk(null)}
        title="Verdrängte Bearbeitungen übernehmen?"
        size="sm"
        variant="sheet"
        footer={
          <>
            <Button disabled={busy} onClick={() => ask && void restore(ask, false)}>
              Nur wiederherstellen
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => ask && void restore(ask, true)}>
              Mit Bearbeitungen
            </Button>
          </>
        }
      >
        <p className={styles.askText}>
          {askCount === 1
            ? "Eine der ausgewählten Packungen sollte noch geändert werden, als sie schon entnommen war. Diese Änderung lässt sich beim Wiederherstellen gleich mit übernehmen."
            : `${String(askCount)} der ausgewählten Packungen sollten noch geändert werden, als sie schon entnommen waren. Diese Änderungen lassen sich beim Wiederherstellen gleich mit übernehmen.`}
        </p>
      </Dialog>
    </Page>
  );
}
