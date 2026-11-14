/**
 * FIFO: welche Packung eines Produkts als Nächstes dran ist (Plan von Stufe 2, Entscheidung 5).
 *
 * Reihenfolge: früheres MHD zuerst, Packungen ohne MHD zuletzt; bei gleichem MHD die zuerst
 * eingelagerte (`created_at`), dann nach ID. Danach markiert die Bestandsliste die Charge, die als
 * Nächstes dran ist (die mit `nextPackage`), und die Scan-Ansicht nennt beim Entnehmen als
 * „verbraucht" eine ältere Packung (`olderPackage`). Alles rein lokal, auch ohne Verbindung.
 */
import type { Package } from "./api.gen";

type Fifo = Pick<Package, "id" | "best_before" | "created_at">;

/** Früheres MHD zuerst; `null` (kein MHD) gilt als später als jedes Datum. */
function compareBestBefore(a: string | null, b: string | null): number {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return a < b ? -1 : 1;
}

/** Ordnet Packungen in der Reihenfolge, in der sie verbraucht werden sollten. */
export function compareFifo(a: Fifo, b: Fifo): number {
  return compareBestBefore(a.best_before, b.best_before) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}

/** Die Packung eines Produkts, die als Nächstes dran ist; undefined, wenn keine im Bestand ist. */
export function nextPackage<P extends Fifo & Pick<Package, "product_id" | "removed_at">>(packages: readonly P[], productId: string): P | undefined {
  let best: P | undefined;
  for (const pkg of packages) {
    if (pkg.product_id === productId && pkg.removed_at === null && (best === undefined || compareFifo(pkg, best) < 0)) {
      best = pkg;
    }
  }
  return best;
}

/**
 * Der FIFO-Hinweis beim Entnehmen: eine Packung desselben Produkts im Bestand mit früherem MHD als
 * die eben entnommene, und zwar die, die als Nächstes dran wäre. undefined, wenn es keine gibt
 * (gleiches MHD zählt nicht als früher). `stock` sind die Packungen im Bestand; die entnommene
 * selbst wird übergangen, auch wenn sie noch darin steht.
 */
export function olderPackage<P extends Fifo & Pick<Package, "product_id" | "removed_at">>(
  removed: Pick<Package, "id" | "product_id" | "best_before">,
  stock: readonly P[],
): P | undefined {
  let best: P | undefined;
  for (const pkg of stock) {
    if (pkg.id === removed.id || pkg.product_id !== removed.product_id || pkg.removed_at !== null) {
      continue;
    }
    if (compareBestBefore(pkg.best_before, removed.best_before) >= 0) {
      continue;
    }
    if (best === undefined || compareFifo(pkg, best) < 0) {
      best = pkg;
    }
  }
  return best;
}
