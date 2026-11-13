import { formatTimestamp, productTitle, useCore, useLive, type RemovalReason } from "@/contract";
import { Page } from "@/app/Page";
import { Badge, Button, Card, useToast } from "@/ui/base";

const REASONS: Record<RemovalReason, string> = {
  consumed: "verbraucht",
  discarded: "entsorgt",
  mistake: "falsch erfasst",
};

/** Lösch-Historie mit Wiederherstellen. Grundgerüst; die Ausgestaltung folgt in Runde 1. */
export function HistoryPage() {
  const core = useCore();
  const toast = useToast();
  const removed = useLive(core.data.removedPackages, []);
  const products = useLive(core.data.products, []);
  const byId = new Map(products.map((product) => [product.id, product]));

  async function restore(id: string, apply_displaced: boolean) {
    await core.stock.restore([id], { apply_displaced });
    toast.show({ message: `Packung ${id} wiederhergestellt`, tone: "success" });
  }

  return (
    <Page title="Lösch-Historie">
      {removed.length === 0 ? (
        <Card>
          <p style={{ color: "var(--color-text-muted)" }}>Hier erscheinen entnommene und gelöschte Packungen.</p>
        </Card>
      ) : (
        <Card padding="none">
          <ul>
            {removed.map((pkg) => (
              <li
                key={pkg.id}
                style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)", padding: "var(--space-3) var(--space-4)", borderTop: "var(--border-width) solid var(--color-border)" }}
              >
                <span>
                  {productTitle(byId.get(pkg.product_id))}{" "}
                  <span style={{ color: "var(--color-text-faint)", fontFamily: "var(--font-mono)" }}>{pkg.id}</span>
                  <br />
                  <span style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
                    {pkg.removed_at ? formatTimestamp(pkg.removed_at) : ""}
                    {pkg.removal_reason ? ` · ${REASONS[pkg.removal_reason]}` : ""}
                  </span>
                  {pkg.displaced ? (
                    <>
                      {" "}
                      <Badge tone="info">Bearbeitung verdrängt</Badge>
                    </>
                  ) : null}
                </span>
                <span style={{ display: "flex", gap: "var(--space-2)" }}>
                  {pkg.displaced ? (
                    <Button size="sm" onClick={() => void restore(pkg.id, true)}>
                      Mit Bearbeitung wiederherstellen
                    </Button>
                  ) : null}
                  <Button size="sm" onClick={() => void restore(pkg.id, false)}>
                    Wiederherstellen
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Page>
  );
}
