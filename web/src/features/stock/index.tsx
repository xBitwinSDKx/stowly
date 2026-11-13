import { ScanLine } from "lucide-react";
import { useNavigate } from "react-router";

import { expiryState, formatDate, productTitle, ROUTES, todayLocal, useCore, useLive, warnDaysFor } from "@/contract";
import { Page } from "@/app/Page";
import { Badge, Button, Card } from "@/ui/base";

/**
 * Übersicht und Bestand. Grundgerüst: zeigt, wie eine Ansicht den Kern liest
 * (`useLive`) und dass die Daten ankommen. Die Ausgestaltung nach dem Entwurf
 * (Kennzahl-Karten, Zonen-Karten, Tabelle mit Chargen) folgt in Runde 1.
 */
export function StockPage() {
  const core = useCore();
  const navigate = useNavigate();
  const packages = useLive(core.data.packages);
  const products = useLive(core.data.products, []);
  const zones = useLive(core.data.zones, []);
  const settings = useLive(core.data.settings);

  if (!packages || !settings) {
    return <Page title="Bestand">Lädt …</Page>;
  }

  const today = todayLocal();
  const groups = products
    .map((product) => {
      const own = packages.filter((pkg) => pkg.product_id === product.id);
      const dated = own.map((pkg) => pkg.best_before).filter((date): date is string => date !== null).sort();
      const critical = dated[0] ?? null;
      return { product, count: own.length, critical, state: expiryState(critical, warnDaysFor(product, settings), today) };
    })
    .filter((group) => group.count > 0)
    .sort((a, b) => productTitle(a.product).localeCompare(productTitle(b.product), "de"));
  // Gezählt werden Packungen, wie in der Warn-Pille der Kopfzeile.
  const byId = new Map(products.map((product) => [product.id, product]));
  const expiring = packages.filter((pkg) => {
    const state = expiryState(pkg.best_before, warnDaysFor(byId.get(pkg.product_id), settings), today);
    return state === "soon" || state === "expired";
  }).length;

  return (
    <Page
      title="Bestand"
      actions={
        <Button variant="primary" icon={<ScanLine />} onClick={() => void navigate(ROUTES.scan)}>
          Jetzt scannen
        </Button>
      }
    >
      <div style={{ display: "grid", gap: "var(--space-4)", gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))" }}>
        <Card padding="lg">
          <div style={{ color: "var(--color-text-muted)" }}>Packungen gesamt</div>
          <div className="tabular" style={{ fontSize: "var(--text-3xl)", fontWeight: "var(--weight-bold)" }}>
            {packages.length}
          </div>
        </Card>
        <Card padding="lg">
          <div style={{ color: "var(--color-text-muted)" }}>Läuft bald ab</div>
          <div className="tabular" style={{ fontSize: "var(--text-3xl)", fontWeight: "var(--weight-bold)", color: "var(--color-warn)" }}>
            {expiring}
          </div>
        </Card>
        {zones.length > 1 ? (
          <Card padding="lg">
            <div style={{ color: "var(--color-text-muted)" }}>Zonen</div>
            <div className="tabular" style={{ fontSize: "var(--text-3xl)", fontWeight: "var(--weight-bold)", color: "var(--color-info)" }}>
              {zones.length}
            </div>
          </Card>
        ) : null}
      </div>

      <Card padding="none">
        {groups.length === 0 ? (
          <p style={{ padding: "var(--space-6)", color: "var(--color-text-muted)" }}>Noch nichts eingelagert.</p>
        ) : (
          <table>
            <thead>
              <tr style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)", textAlign: "left" }}>
                <th style={{ padding: "var(--space-3) var(--space-4)" }}>Produkt</th>
                <th style={{ padding: "var(--space-3) var(--space-4)" }}>Kritischstes MHD</th>
                <th style={{ padding: "var(--space-3) var(--space-4)", textAlign: "right" }}>Menge</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr key={group.product.id} style={{ borderTop: "var(--border-width) solid var(--color-border)" }}>
                  <td style={{ padding: "var(--space-3) var(--space-4)" }}>{productTitle(group.product)}</td>
                  <td style={{ padding: "var(--space-3) var(--space-4)" }}>
                    {group.critical === null ? (
                      "–"
                    ) : group.state === "expired" ? (
                      <Badge tone="danger">{formatDate(group.critical)}</Badge>
                    ) : group.state === "soon" ? (
                      <Badge tone="warn">{formatDate(group.critical)}</Badge>
                    ) : (
                      formatDate(group.critical)
                    )}
                  </td>
                  <td className="tabular" style={{ padding: "var(--space-3) var(--space-4)", textAlign: "right" }}>
                    {group.count}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </Page>
  );
}
