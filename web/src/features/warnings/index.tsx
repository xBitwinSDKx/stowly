import { useMemo } from "react";

import { cookPath, ROUTES } from "@/contract";
import { Page, PageLoading } from "@/app/Page";
import { useStockDialogs, type StockDialogs } from "@/features/stock/dialogs";
import { warningGroups, type WarningGroup } from "@/features/stock/model";
import { useStock } from "@/features/stock/useStock";
import { EmptyState, ExpiryLabel, PackageIds, packagesText, plural, Section, TextLink, ZoneLabel } from "@/ui";
import { Badge, Button, ButtonLink } from "@/ui/base";
import { ChefHatIcon, CircleCheckIcon } from "@/ui/icons";

import styles from "./WarningsPage.module.css";

interface GroupListProps {
  groups: readonly WarningGroup[];
  multiZone: boolean;
  dialogs: StockDialogs;
}

function GroupList({ groups, multiZone, dialogs }: GroupListProps) {
  return (
    <ul className={styles.list}>
      {groups.map((group) => (
        <li key={group.key} className={styles.item}>
          <div className={styles.product}>
            <h3 className={styles.title}>{group.title}</h3>
            {group.subtitle !== "" ? <div className={styles.sub}>{group.subtitle}</div> : null}
          </div>
          <div className={styles.when}>
            <ExpiryLabel date={group.best_before} state={group.state} days={group.days} detail />
          </div>
          <div className={styles.where}>
            {group.zones.map((place) => (
              <div key={place.zone_id} className={styles.place}>
                {multiZone ? <ZoneLabel zone={place.zone} className={styles.zone} /> : null}
                <PackageIds ids={place.ids} />
              </div>
            ))}
          </div>
          <div className={styles.count}>
            <span className="tabular">{group.count}</span> ×
          </div>
          <div className={styles.actions}>
            <Button size="sm" aria-label={`MHD korrigieren: ${group.title}`} onClick={() => dialogs.open({ kind: "packages", package_ids: group.ids })}>
              MHD korrigieren
            </Button>
            <Button
              size="sm"
              aria-label={`Entnehmen: ${group.title}`}
              onClick={() =>
                dialogs.open({
                  kind: "remove",
                  package_ids: group.ids,
                  selection: "all",
                  // Abgelaufenes wird meist weggeworfen, der Rest aufgebraucht.
                  reason: group.state === "expired" ? "discarded" : "consumed",
                })
              }
            >
              Entnehmen
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** So viele Produkte gibt „Was koche ich daraus?" mit: so viele wählt „Was koche ich?" höchstens von selbst vor. */
const COOK_WITH_MAX = 3;

/**
 * Die Produkte für „Was koche ich daraus?": zuerst, was bald abläuft (noch gut), dann Abgelaufenes,
 * je das Dringendste zuerst, ohne Doppelte und ohne Platzhalter.
 */
export function cookProducts(groups: readonly WarningGroup[]): string[] {
  const ordered = [...groups.filter((group) => group.state === "soon"), ...groups.filter((group) => group.state === "expired").reverse()];
  const ids = ordered.filter((group) => group.product !== undefined && group.product.name.trim() !== "").map((group) => group.product_id);
  return [...new Set(ids)].slice(0, COOK_WITH_MAX);
}

/**
 * MHD-Warnungen: alle abgelaufenen und bald ablaufenden Packungen, nach Dringlichkeit,
 * zusammengefasst je Produkt und MHD. Die Liste ergibt sich allein aus dem Bestand;
 * es gibt kein Abhaken. Die Pille der Kopfzeile zählt dieselben Packungen. „Was koche ich
 * daraus?" führt mit den dringendsten Produkten zu „Was koche ich?".
 */
export function WarningsPage() {
  const stock = useStock();
  const dialogs = useStockDialogs(stock);
  const groups = useMemo(() => warningGroups(stock.entries, stock.zones), [stock.entries, stock.zones]);
  const expired = groups.filter((group) => group.state === "expired");
  const soon = groups.filter((group) => group.state === "soon");
  const { warnings } = stock;

  if (!stock.ready) {
    return (
      <Page title="Warnungen">
        <PageLoading label="Warnungen werden geladen …" />
      </Page>
    );
  }

  const warnDays = stock.settings?.warn_days;
  const lead =
    warnDays === undefined ? null : (
      <>
        Gewarnt wird {plural(warnDays, "Tag", "Tage")} vor dem MHD; einzelne Produkte können eine eigene Vorlaufzeit haben.{" "}
        <TextLink to={ROUTES.settings}>Vorlaufzeit ändern</TextLink>
      </>
    );

  const cookIds = cookProducts(groups);
  const cook =
    cookIds.length > 0 ? (
      <ButtonLink to={cookPath(cookIds)} icon={<ChefHatIcon />}>
        Was koche ich daraus?
      </ButtonLink>
    ) : undefined;

  return (
    <Page title="Warnungen" description="Abgelaufene und bald ablaufende Packungen, das Dringendste zuerst." actions={cook}>
      {groups.length === 0 ? (
        <EmptyState icon={<CircleCheckIcon size={26} />} title="Nichts läuft in nächster Zeit ab">
          {lead}
        </EmptyState>
      ) : (
        <>
          <p className={styles.summary} role="status">
            <strong>{packagesText(warnings.total)}</strong>
            {warnings.expired > 0 ? (
              <Badge tone="danger">
                {warnings.expired} abgelaufen
              </Badge>
            ) : null}
            {warnings.soon > 0 ? (
              <Badge tone="warn">
                {warnings.soon} {warnings.soon === 1 ? "läuft bald ab" : "laufen bald ab"}
              </Badge>
            ) : null}
          </p>

          {expired.length > 0 ? (
            <Section title="Abgelaufen">
              <GroupList groups={expired} multiZone={stock.multiZone} dialogs={dialogs} />
            </Section>
          ) : null}
          {soon.length > 0 ? (
            <Section title="Läuft bald ab">
              <GroupList groups={soon} multiZone={stock.multiZone} dialogs={dialogs} />
            </Section>
          ) : null}

          <p className={styles.foot}>{lead} Die Liste ergibt sich aus dem Bestand: Was entnommen oder korrigiert ist, verschwindet von selbst.</p>
        </>
      )}
      {dialogs.element}
    </Page>
  );
}
