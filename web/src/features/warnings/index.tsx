import { daysUntil, expiryState, formatDate, productTitle, todayLocal, useCore, useLive, warnDaysFor } from "@/contract";
import { Page } from "@/app/Page";
import { Badge, Card } from "@/ui/base";

/** MHD-Warnungen. Grundgerüst; die Ausgestaltung folgt in Runde 1. */
export function WarningsPage() {
  const core = useCore();
  const packages = useLive(core.data.packages, []);
  const products = useLive(core.data.products, []);
  const settings = useLive(core.data.settings);
  const today = todayLocal();
  const byId = new Map(products.map((product) => [product.id, product]));

  const due = packages
    .map((pkg) => {
      const product = byId.get(pkg.product_id);
      const state = settings ? expiryState(pkg.best_before, warnDaysFor(product, settings), today) : "none";
      return { pkg, product, state, days: daysUntil(pkg.best_before, today) };
    })
    .filter((entry) => entry.state === "soon" || entry.state === "expired")
    .sort((a, b) => (a.days ?? 0) - (b.days ?? 0));

  return (
    <Page title="Warnungen">
      {due.length === 0 ? (
        <Card>
          <p style={{ color: "var(--color-text-muted)" }}>Nichts läuft in nächster Zeit ab.</p>
        </Card>
      ) : (
        <Card padding="none">
          <ul>
            {due.map(({ pkg, product, state, days }) => (
              <li
                key={pkg.id}
                style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-3)", padding: "var(--space-3) var(--space-4)", borderTop: "var(--border-width) solid var(--color-border)" }}
              >
                <span>
                  {productTitle(product)} <span style={{ color: "var(--color-text-faint)", fontFamily: "var(--font-mono)" }}>{pkg.id}</span>
                </span>
                <Badge tone={state === "expired" ? "danger" : "warn"}>
                  {pkg.best_before ? formatDate(pkg.best_before) : ""} · {state === "expired" ? "abgelaufen" : days === 0 ? "heute" : `in ${String(days)} Tagen`}
                </Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Page>
  );
}
