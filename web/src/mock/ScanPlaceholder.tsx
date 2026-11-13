import { useState } from "react";
import { Link } from "react-router";

import { formatDate, productTitle, ROUTES, useCore, useLive } from "@/contract";
import { Button, Card, useToast } from "@/ui/base";

/**
 * Platzhalter für die Scan-Ansicht in der Attrappe.
 *
 * Die echte Ansicht (Kamera, Zonenleiste, MHD-Eingabe) liegt in src/features/scan und
 * gehört Worker 3. Damit sich die Oberfläche auch ohne sie vollständig durchklicken lässt,
 * spielt dieser Platzhalter die beiden Hauptfälle über den Kern nach.
 */
export function MockScanPage() {
  const core = useCore();
  const toast = useToast();
  const products = useLive(core.data.products, []);
  const packages = useLive(core.data.packages, []);
  const zones = useLive(core.data.zones, []);
  const [busy, setBusy] = useState(false);

  async function store() {
    const product = products.find((candidate) => candidate.name !== "");
    const zone = zones[0];
    if (!product || !zone) {
      toast.show({ message: "Kein Produkt oder keine Zone vorhanden.", tone: "warn" });
      return;
    }
    setBusy(true);
    try {
      const result = await core.stock.store({
        product: { kind: "existing", product_id: product.id },
        zone_id: zone.id,
        best_before: null,
        count: 2,
      });
      toast.show({
        message: `2 × ${productTitle(result.product)} eingelagert: ${result.packages.map((pkg) => pkg.id).join(", ")}`,
        tone: "success",
        action: { label: "Rückgängig", onAction: () => void core.stock.remove(result.packages.map((pkg) => pkg.id), "mistake") },
      });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const pkg = packages[0];
    if (!pkg) {
      toast.show({ message: "Der Bestand ist leer.", tone: "warn" });
      return;
    }
    const product = products.find((candidate) => candidate.id === pkg.product_id);
    await core.stock.remove([pkg.id], "consumed");
    toast.show({
      message: `${productTitle(product)} (${pkg.id}${pkg.best_before ? `, MHD ${formatDate(pkg.best_before)}` : ""}) entnommen`,
      action: { label: "Rückgängig", onAction: () => void core.stock.restore([pkg.id]) },
    });
  }

  return (
    <main style={{ display: "grid", gap: "var(--space-4)", maxWidth: "32rem", margin: "0 auto", padding: "var(--space-6) var(--space-4)" }}>
      <h1>Scannen</h1>
      <Card tone="info">
        <p>
          Platzhalter der Attrappe. Die echte Scan-Ansicht mit Kamera entsteht in <code>src/features/scan</code>.
        </p>
      </Card>
      <Button variant="primary" size="lg" block busy={busy} onClick={() => void store()}>
        Einlagern nachspielen (2 Packungen)
      </Button>
      <Button size="lg" block onClick={() => void remove()}>
        Entnehmen nachspielen (1 Packung)
      </Button>
      {/* Link statt <a>: Ein Neuladen der Seite würde die Änderungen der Attrappe verwerfen. */}
      <Link to={ROUTES.stock}>Zurück zum Bestand</Link>
    </main>
  );
}
