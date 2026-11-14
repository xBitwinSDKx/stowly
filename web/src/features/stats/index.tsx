import { useMemo } from "react";

import { formatTimestamp, productSubtitle, ROUTES, useCore, useLive, type Stats, type StatsMonth, type Zone } from "@/contract";
import { Page, PageLoading } from "@/app/Page";
import { EmptyState, Notice, otherTimeZone, plural, Section, StatCard, TextLink, useMediaQuery, ZoneLabel } from "@/ui";
import { Button, cx, DEFAULT_ZONE_ICON, SegmentedControl, Spinner } from "@/ui/base";
import { CloudOffIcon, PackageMinusIcon, RefreshIcon, StatsIcon, TrashIcon } from "@/ui/icons";
import table from "@/ui/Table.module.css";

import { MonthChart, Swatch } from "./MonthChart";
import { chartSummary, isEmpty, monthName, PERIODS, periodText, shareOf, shareText, statsProductTitle } from "./model";
import styles from "./StatsPage.module.css";
import { useStats } from "./useStats";

/** Dieselben Zahlen wie das Diagramm, als Tabelle für Screenreader. Sichtbar ist das Diagramm. */
function MonthTable({ months, totals }: { months: readonly StatsMonth[]; totals: Pick<Stats, "consumed" | "discarded"> }) {
  return (
    <table className="sr-only">
      <caption>Verbraucht und entsorgt je Monat</caption>
      <thead>
        <tr>
          <th scope="col">Monat</th>
          <th scope="col">Verbraucht</th>
          <th scope="col">Entsorgt</th>
        </tr>
      </thead>
      <tbody>
        {months.map((entry) => (
          <tr key={entry.month}>
            <th scope="row">{monthName(entry.month)}</th>
            <td>{entry.consumed}</td>
            <td>{entry.discarded}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">Zusammen</th>
          <td>{totals.consumed}</td>
          <td>{totals.discarded}</td>
        </tr>
      </tfoot>
    </table>
  );
}

/** Die am häufigsten entsorgten Produkte, mit einem Balken im Verhältnis zum ersten. */
function TopDiscarded({ stats }: { stats: Stats }) {
  const core = useCore();
  const products = useLive(core.data.products);
  const byId = useMemo(() => new Map((products ?? []).map((product) => [product.id, product])), [products]);
  const most = stats.top_discarded[0]?.discarded ?? 0;

  if (stats.top_discarded.length === 0) {
    return <p className={styles.muted}>Im Zeitraum wurde nichts entsorgt.</p>;
  }
  return (
    <ol className={styles.top}>
      {stats.top_discarded.map((entry) => {
        const title = statsProductTitle(entry);
        const placeholder = entry.name.trim() === "";
        const subtitle = productSubtitle(byId.get(entry.product_id));
        return (
          <li key={entry.product_id} className={styles.topItem}>
            <span className={styles.topText}>
              <span className={cx(styles.topTitle, placeholder && entry.barcode !== null && styles.code)}>{title}</span>
              {placeholder ? <span className={styles.muted}>noch ohne Namen</span> : subtitle !== "" ? <span className={styles.muted}>{subtitle}</span> : null}
            </span>
            <span className={styles.topCount}>{plural(entry.discarded, "Packung", "Packungen")}</span>
            <svg className={styles.topBar} width="100%" height="6" aria-hidden="true">
              <rect width={`${String(Math.max(2, (entry.discarded / Math.max(1, most)) * 100))}%`} height="6" rx="3" className={styles.topFill} />
            </svg>
          </li>
        );
      })}
    </ol>
  );
}

/** Je Zone verbraucht, entsorgt und der Anteil des Entsorgten. */
function ZoneTable({ stats }: { stats: Stats }) {
  const core = useCore();
  const zones = useLive(core.data.zones);
  const byId = useMemo(() => new Map((zones ?? []).map((zone) => [zone.id, zone])), [zones]);
  return (
    <div className={table.wrap}>
      <table className={cx(table.table, table.dense)}>
        <thead>
          <tr>
            <th className={table.th} scope="col">
              Zone
            </th>
            <th className={cx(table.th, table.num)} scope="col">
              Verbraucht
            </th>
            <th className={cx(table.th, table.num)} scope="col">
              Entsorgt
            </th>
            <th className={cx(table.th, table.num, styles.wrapHead)} scope="col">
              Anteil entsorgt
            </th>
          </tr>
        </thead>
        <tbody>
          {stats.zones.map((entry) => {
            const zone: Pick<Zone, "name" | "icon" | "color"> | undefined = byId.get(entry.zone_id);
            return (
              <tr key={entry.zone_id} className={table.row}>
                <th className={cx(table.td, styles.zoneCell)} scope="row">
                  {/* Symbol und Farbe kennt die App; der Name kommt vom Server. */}
                  <ZoneLabel zone={zone ? { ...zone, name: entry.name } : { name: entry.name, icon: DEFAULT_ZONE_ICON, color: null }} truncate={false} />
                </th>
                <td className={cx(table.td, table.num)}>{entry.consumed}</td>
                <td className={cx(table.td, table.num)}>{entry.discarded}</td>
                <td className={cx(table.td, table.num)}>{shareText(shareOf(entry))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Ab dieser Breite steht „Packungen" neben der Zahl der Kennzahl-Karten; am schmalen Handy bräche es um. */
const UNIT_QUERY = "(min-width: 30rem)";

/** Der Inhalt, sobald eine Statistik da ist. */
function StatsContent({ stats }: { stats: Stats }) {
  const total = stats.consumed + stats.discarded;
  const roomy = useMediaQuery(UNIT_QUERY);
  const unit = (count: number) => (roomy ? (count === 1 ? "Packung" : "Packungen") : undefined);

  if (isEmpty(stats)) {
    return (
      <EmptyState icon={<StatsIcon size={26} />} title="Nichts verbraucht oder entsorgt">
        Von {periodText(stats)} wurde keine Packung als verbraucht oder entsorgt entnommen. Sobald das geschieht, steht es hier. Was als „falsch erfasst“ gelöscht
        wird, zählt nicht mit.
      </EmptyState>
    );
  }

  return (
    <>
      <div className={styles.cards}>
        <StatCard label="Verbraucht" tone="accent" value={stats.consumed} note={unit(stats.consumed)} icon={<PackageMinusIcon size={22} />} />
        <StatCard label="Entsorgt" tone="danger" value={stats.discarded} note={unit(stats.discarded)} icon={<TrashIcon size={22} />} />
        <StatCard label="Anteil entsorgt" value={shareText(stats.discarded_share)} note={`(${String(stats.discarded)} von ${String(total)})`} />
      </div>

      <Section title="Je Monat" description="Verbraucht und entsorgt nebeneinander, je Monat in Packungen.">
        <div className={styles.chartCard}>
          <ul className={styles.legend} aria-label="Legende">
            <li>
              <Swatch kind="consumed" />
              Verbraucht
            </li>
            <li>
              <Swatch kind="discarded" />
              Entsorgt
            </li>
          </ul>
          <MonthChart months={stats.months} label={chartSummary(stats)} />
          <MonthTable months={stats.months} totals={stats} />
        </div>
      </Section>

      <Section title="Am häufigsten entsorgt" description="Die Produkte mit den meisten entsorgten Packungen im Zeitraum.">
        <TopDiscarded stats={stats} />
      </Section>

      {stats.zones.length > 1 ? (
        <Section title="Je Zone" description="Wo die Packungen lagen, als sie entnommen wurden; nach dem Löschen einer Zone dort, wohin sie gewandert sind.">
          <ZoneTable stats={stats} />
        </Section>
      ) : null}
    </>
  );
}

/**
 * Statistik: was im Haushalt verbraucht und was entsorgt wurde, je Monat (Säulen), die Summen und der
 * Anteil des Entsorgten, die am häufigsten entsorgten Produkte und die Zahlen je Zone.
 *
 * Der Server rechnet aus allen Packungen der ganzen Zeit; dieses Gerät behält Entnommenes nur für die
 * Aufbewahrungsdauer der Lösch-Historie. Ohne Verbindung gibt es deshalb keine Statistik, und die Ansicht
 * sagt das. Was als „falsch erfasst“ gelöscht wurde, zählt nicht mit.
 */
export function StatsPage() {
  const core = useCore();
  const online = useLive(core.sync.status)?.online;
  const { state, choose, reload } = useStats();
  const { stats, error, loading } = state;
  const zone = otherTimeZone(stats?.timezone);
  // Ein anderer Zeitraum und neue Zahlen brauchen den Server. Ohne Statistik steht „Erneut versuchen“ beim Hinweis.
  const offline = online === false;

  const actions =
    stats === null ? undefined : (
      <>
        <SegmentedControl<string>
          label="Zeitraum"
          value={String(state.months)}
          onChange={(value) => choose(Number(value))}
          options={PERIODS.map((months) => ({ value: String(months), label: `${String(months)} Monate`, disabled: offline }))}
        />
        <Button variant="ghost" icon={<RefreshIcon />} busy={loading} disabled={offline} onClick={reload}>
          Neu laden
        </Button>
      </>
    );

  return (
    <Page
      title="Statistik"
      description={
        <>
          Verbraucht und entsorgt je Monat, je Produkt und je Zone. Der Server zählt alle Packungen über die ganze Zeit; was als „falsch erfasst“ gelöscht wurde,
          zählt nicht mit. <TextLink to={ROUTES.history}>Zur Lösch-Historie</TextLink>
        </>
      }
      actions={actions}
    >
      {stats === null ? (
        loading ? (
          <PageLoading label="Statistik wird geladen …" />
        ) : error?.offline ? (
          <EmptyState
            icon={<CloudOffIcon size={26} />}
            title="Ohne Verbindung keine Statistik"
            actions={
              <Button icon={<RefreshIcon />} onClick={reload}>
                Erneut versuchen
              </Button>
            }
          >
            Die Statistik rechnet der Server aus allen Packungen der ganzen Zeit; ohne Verbindung gibt es sie nicht. Sobald er wieder erreichbar ist, lädt sie von selbst.
          </EmptyState>
        ) : (
          <Notice
            tone="danger"
            role="alert"
            title="Die Statistik ließ sich nicht laden"
            action={
              <Button size="sm" onClick={reload}>
                Erneut versuchen
              </Button>
            }
          >
            {error?.message}
          </Notice>
        )
      ) : (
        <>
          {/* Ein neuer Zeitraum wird angesagt, sobald er da ist; der Spinner ist nur zu sehen. */}
          <p className={styles.period} role="status">
            <span className={styles.periodText}>{periodText(stats)}</span>
            {zone !== null ? <span className={styles.muted}>Monate in der Zeit des Servers ({zone})</span> : null}
            {loading ? <Spinner size={16} /> : null}
          </p>

          {offline ? (
            <Notice tone="warn" icon={<CloudOffIcon />} role="status" title="Der Server ist nicht erreichbar">
              Zu sehen ist der Stand von {formatTimestamp(state.loadedAt ?? "")}. Neu laden geht erst wieder mit Verbindung; dann lädt die Statistik von selbst.
            </Notice>
          ) : error ? (
            <Notice
              tone={error.offline ? "warn" : "danger"}
              icon={error.offline ? <CloudOffIcon /> : undefined}
              role="status"
              title={state.months === stats.months.length ? "Nicht neu geladen" : "Dieser Zeitraum ließ sich nicht laden"}
              action={
                <Button size="sm" onClick={reload}>
                  Erneut versuchen
                </Button>
              }
            >
              {error.message} Zu sehen ist der Stand von {formatTimestamp(state.loadedAt ?? "")}.
            </Notice>
          ) : null}

          <div className={styles.content} aria-busy={loading || undefined}>
            <StatsContent stats={stats} />
          </div>
        </>
      )}
    </Page>
  );
}
