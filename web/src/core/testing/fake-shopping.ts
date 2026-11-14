/**
 * Was der Server an der Einkaufsliste selbst schreibt (docs/sync-protokoll.md, 7.6), nachgebaut
 * für die Nachbildung des Servers (fake-server.ts).
 *
 * Die Wirkung der drei Befehle der Einkaufsliste und das Umhängen der Einträge beim Zusammenführen
 * kommen aus src/core/commands/apply.ts, wie bei allen Befehlen. Diese Datei ergänzt, was der
 * Kern nicht vorwegnimmt (Regel 8 in src/contract/core.ts): automatische Einträge, die Sperre,
 * das Erledigen eigener Einträge durch Einlagern, das Zusammenlegen zweier offener automatischer
 * Einträge. Alles läuft im Sicherungspunkt des Befehls, der es auslöst (6.3): Scheitert er, gilt
 * nichts davon.
 *
 * Dafür braucht die Nachbildung zwei Uhren, die sie sonst nicht hat (7.1): die Sperre je Produkt
 * als wirksamen Zeitpunkt und je Eintrag die Uhr von `done`. Ein Abhaken oder Öffnen, das früher
 * geschah als die letzte angewendete Änderung von `done`, verliert. Die Uhren von `text` und
 * `quantity` gibt es hier nicht: Dort gewinnt, was zuletzt eintrifft, wie bei allen anderen
 * Feldern der Nachbildung. `closed_by` führt sie wie der Server, aber nur intern (nie im Sync).
 *
 * Ohne DOM und ohne Node.
 */
import type { Command, Product, ShoppingItem } from "@/contract/api.gen";
import { newUuid } from "@/contract/ids";
import { isOpenItem, missingStock, stockCount } from "@/contract/shopping";

import { barcodeOwner, resolveProduct } from "../commands/apply";
import type { Draft } from "../tables";

/** Wodurch ein Eintrag zuletzt geschlossen wurde (Spalte `closed_by`, Migration 0003); null = offen. */
export type ClosedBy = "device" | "store" | "stock" | "merge" | "bring";

/** Was vor einem Befehl galt, soweit 7.6 es braucht. */
interface Before {
  /** Die angesprochene Packung, wie sie vorher war. */
  pkg?: { product_id: string; removed: boolean };
  /** Das angesprochene Produkt (nach Zusammenführungen) und sein Mindestbestand vorher. */
  product?: { id: string; min_stock: number | null };
  /** Ein Zusammenführen, das der Befehl auslöst: Quelle und Ziel. */
  merge?: { source: string; target: string };
  /** Der angesprochene Eintrag, wie er vorher war. */
  item?: ShoppingItem;
}

function later(a: string, b: string): string {
  return a > b ? a : b;
}

export class ShoppingRules {
  private locks = new Map<string, string>();
  private doneClocks = new Map<string, string>();
  private closed = new Map<string, ClosedBy>();

  /** Die Sperre eines Produkts (wirksamer Zeitpunkt) oder undefined. */
  lockOf(productId: string): string | undefined {
    return this.locks.get(productId);
  }

  /** Wodurch ein Eintrag zuletzt geschlossen wurde; null, solange er offen ist. */
  closedBy(itemId: string): ClosedBy | null {
    return this.closed.get(itemId) ?? null;
  }

  /** Ein Sicherungspunkt: Die gelieferte Funktion stellt den Stand von jetzt wieder her. */
  savepoint(): () => void {
    const saved = { locks: new Map(this.locks), doneClocks: new Map(this.doneClocks), closed: new Map(this.closed) };
    return () => {
      this.locks = saved.locks;
      this.doneClocks = saved.doneClocks;
      this.closed = saved.closed;
    };
  }

  /**
   * Die Uhr von `done` (7.1): Ein Abhaken oder Öffnen mit einem früheren wirksamen Zeitpunkt als
   * die letzte angewendete Änderung verliert. Dann fällt `done` aus dem Befehl; der Rest gilt.
   */
  prepare(command: Command, at: string): Command {
    if (command.type !== "shopping_item.update" || command.changes.done === undefined) {
      return command;
    }
    const clock = this.doneClocks.get(command.item_id);
    if (clock === undefined || at >= clock) {
      return command;
    }
    const { done: _lost, ...rest } = command.changes;
    return { ...command, changes: rest };
  }

  /** Hält fest, was vor dem Befehl galt. */
  observe(ws: Draft, command: Command): Before {
    switch (command.type) {
      case "package.remove":
      case "package.restore":
      case "package.update": {
        const pkg = ws.get("packages", command.package_id);
        return pkg ? { pkg: { product_id: pkg.product_id, removed: pkg.removed_at !== null } } : {};
      }
      case "product.update": {
        const product = resolveProduct(ws, command.product_id);
        return product ? { product: { id: product.id, min_stock: product.min_stock } } : {};
      }
      case "product.add_barcode": {
        const product = resolveProduct(ws, command.product_id);
        const owner = barcodeOwner(ws, command.barcode);
        return product && owner && owner.id !== product.id ? { merge: { source: owner.id, target: product.id } } : {};
      }
      case "product.merge": {
        const source = resolveProduct(ws, command.source_id);
        const target = resolveProduct(ws, command.target_id);
        return source && target && source.id !== target.id ? { merge: { source: source.id, target: target.id } } : {};
      }
      case "shopping_item.update":
      case "shopping_item.delete": {
        const item = ws.get("shopping_items", command.item_id);
        return item ? { item } : {};
      }
      default:
        return {};
    }
  }

  /** Schreibt nach einem angewendeten Befehl, was der Server daraus ableitet (Auslöser in 7.6). */
  apply(ws: Draft, command: Command, before: Before, at: string): void {
    switch (command.type) {
      case "package.create": {
        const productId = ws.get("packages", command.package_id)?.product_id;
        if (productId !== undefined) {
          this.unlock(productId, at);
          this.completeOwnItems(ws, productId, at);
          this.reconcile(ws, productId, at);
        }
        return;
      }
      case "package.remove":
        if (before.pkg && !before.pkg.removed) {
          this.reconcile(ws, before.pkg.product_id, at);
        }
        return;
      case "package.restore": {
        if (before.pkg?.removed) {
          this.reconcile(ws, before.pkg.product_id, at);
          const now = ws.get("packages", command.package_id)?.product_id;
          if (now !== undefined && now !== before.pkg.product_id) {
            this.reconcile(ws, now, at);
          }
        }
        return;
      }
      case "package.update": {
        const now = ws.get("packages", command.package_id)?.product_id;
        if (before.pkg && !before.pkg.removed && now !== undefined && now !== before.pkg.product_id) {
          this.reconcile(ws, before.pkg.product_id, at);
          this.reconcile(ws, now, at);
        }
        return;
      }
      case "product.create": {
        const product = ws.get("products", command.product_id);
        if (product?.merged_into) {
          // Mit einem vergebenen Barcode entsteht das Produkt als Zusammenführung (7.3).
          const target = resolveProduct(ws, product.merged_into);
          if (target) {
            this.merged(ws, product.id, target.id, at);
          }
        } else if (product && (command.min_stock ?? null) !== null) {
          this.reconcile(ws, product.id, at);
        }
        return;
      }
      case "product.update": {
        const after = before.product ? resolveProduct(ws, before.product.id) : undefined;
        if (before.product && after && "min_stock" in command.changes && after.min_stock !== before.product.min_stock) {
          this.unlock(after.id, at);
          this.reconcile(ws, after.id, at);
        }
        return;
      }
      case "product.add_barcode":
      case "product.merge":
        if (before.merge) {
          this.merged(ws, before.merge.source, before.merge.target, at);
        }
        return;
      case "shopping_item.update": {
        const item = before.item;
        const done = command.changes.done;
        if (!item || item.deleted_at !== null || done === undefined) {
          return;
        }
        this.doneClocks.set(item.id, at);
        if (done && item.done_at === null) {
          this.closed.set(item.id, "device");
          if (item.origin === "min_stock" && item.product_id !== null) {
            this.lock(item.product_id, at);
          }
        } else if (!done && item.done_at !== null) {
          this.closed.delete(item.id);
          if (item.origin === "min_stock" && item.product_id !== null) {
            this.unlock(item.product_id, at);
            this.reconcile(ws, item.product_id, at);
          }
        }
        return;
      }
      case "shopping_item.delete": {
        const item = before.item;
        if (!item || item.deleted_at !== null) {
          return;
        }
        this.closed.set(item.id, "device");
        // Ein erledigter Eintrag, der gelöscht wird, sperrt nicht noch einmal: Das ist Aufräumen.
        if (item.origin === "min_stock" && isOpenItem(item) && item.product_id !== null) {
          this.lock(item.product_id, at);
        }
        return;
      }
      default:
        return;
    }
  }

  // ---------------------------------------------------------------- Bausteine

  private lock(productId: string, at: string): void {
    const current = this.locks.get(productId);
    this.locks.set(productId, current === undefined ? at : later(current, at));
  }

  /** Hebt die Sperre auf, wenn sie nicht nach `at` liegt. */
  private unlock(productId: string, at: string): void {
    const current = this.locks.get(productId);
    if (current !== undefined && current <= at) {
      this.locks.delete(productId);
    }
  }

  /** Zusammenführen: Die Sperre des Ziels ist die spätere beider, die Quelle hat keine mehr; dann Abgleich des Ziels. */
  private merged(ws: Draft, source: string, target: string, at: string): void {
    const sourceLock = this.locks.get(source);
    this.locks.delete(source);
    if (sourceLock !== undefined) {
      this.lock(target, sourceLock);
    }
    this.reconcile(ws, target, at);
  }

  /**
   * Eigene Einträge erledigen sich beim Einlagern: jeder offene eigene Eintrag des Produkts, der seit
   * `at` oder früher offen ist (die Uhr von `done`, sonst `created_at`).
   */
  private completeOwnItems(ws: Draft, productId: string, at: string): void {
    for (const item of ws.rows("shopping_items")) {
      if (item.product_id !== productId || item.origin !== "manual" || !isOpenItem(item)) {
        continue;
      }
      const openSince = this.doneClocks.get(item.id) ?? item.created_at;
      if (openSince <= at) {
        ws.put("shopping_items", { ...item, done_at: at, updated_at: later(item.updated_at, at) });
        this.doneClocks.set(item.id, at);
        this.closed.set(item.id, "store");
      }
    }
  }

  /** Abgleich eines Produkts zum wirksamen Zeitpunkt `at` (7.6, Schritte 1 bis 3). */
  reconcile(ws: Draft, productId: string, at: string): void {
    const product: Product | undefined = resolveProduct(ws, productId);
    if (!product) {
      return;
    }
    const open = ws
      .rows("shopping_items")
      .filter((item) => item.product_id === product.id && item.origin === "min_stock" && isOpenItem(item))
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    const [kept, ...extra] = open;
    // 1. Mehr als ein offener automatischer Eintrag: Der älteste bleibt.
    for (const item of extra) {
      ws.put("shopping_items", { ...item, deleted_at: at, updated_at: later(item.updated_at, at) });
      this.closed.set(item.id, "merge");
    }
    const missing = missingStock(product, stockCount(ws.rows("packages"), product.id));
    if (missing > 0) {
      // 2. Fehlbestand: nachführen, oder anlegen, wenn das Produkt nicht gesperrt ist.
      if (kept) {
        if (kept.quantity !== missing) {
          ws.put("shopping_items", { ...kept, quantity: missing, updated_at: later(kept.updated_at, at) });
        }
      } else if (!this.locks.has(product.id)) {
        ws.put("shopping_items", {
          id: newUuid(),
          product_id: product.id,
          text: "",
          quantity: missing,
          origin: "min_stock",
          done_at: null,
          deleted_at: null,
          created_at: at,
          updated_at: at,
        });
      }
    } else if (kept) {
      // 3. Der Bestand reicht: gelöscht, nicht erledigt; die Menge bleibt.
      ws.put("shopping_items", { ...kept, deleted_at: at, updated_at: later(kept.updated_at, at) });
      this.closed.set(kept.id, "stock");
    }
  }
}
