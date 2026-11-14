/**
 * Lesen (`Core.data`): reaktive Werte über dem, was die App zeigt, also dem Stand des
 * Servers plus den noch nicht bestätigten Befehlen (docs/sync-protokoll.md, 9.1).
 *
 * Filter und Sortierung stehen in src/contract/core.ts. Jeder Wert hängt nur an „seiner"
 * Tabelle: Eine Änderung an den Zonen lässt die Packungen in Ruhe.
 */
import type { HouseholdSettings } from "@/contract/api.gen";
import type { DataApi } from "@/contract/core";
import { compareShoppingItems } from "@/contract/shopping";

import { barcodeOwner, resolveProduct } from "../commands/apply";
import { imageUrl } from "../images";
import { derived } from "../live";
import type { Store } from "../store";
import { isExpiredJob, isExpiredPackage, isExpiredShoppingItem, PRINT_JOB_RETENTION_DAYS, retentionLimit } from "../sync/retention";
import { Draft } from "../tables";

/** Rückfall, falls der Server je keine Einstellungen geliefert hat: die Vorgaben des Protokolls (3.4). */
const DEFAULT_SETTINGS: HouseholdSettings = {
  zone_mode: "primary",
  primary_zone_id: null,
  warn_days: 14,
  trash_retention_days: 30,
  default_printer_id: null,
  notify_time: "17:00",
  updated_at: "1970-01-01T00:00:00.000Z",
};

export function createDataApi(store: Store, ready: Promise<void>): DataApi {
  const state = store.state;
  return {
    products: derived(
      state,
      (s) => [s.loaded, s.view.products],
      (s) => (s.loaded ? [...s.view.products.values()].filter((product) => product.deleted_at === null) : undefined),
    ),
    packages: derived(
      state,
      (s) => [s.loaded, s.view.packages],
      (s) => (s.loaded ? [...s.view.packages.values()].filter((pkg) => pkg.removed_at === null) : undefined),
    ),
    removedPackages: derived(
      state,
      (s) => [s.loaded, s.view.packages, s.view.settings?.trash_retention_days],
      (s) => {
        if (!s.loaded) {
          return undefined;
        }
        const limit = retentionLimit(store.serverNowMs(), (s.view.settings ?? DEFAULT_SETTINGS).trash_retention_days);
        return [...s.view.packages.values()]
          .filter((pkg) => pkg.removed_at !== null && !isExpiredPackage(pkg, limit))
          .sort((a, b) => (b.removed_at ?? "").localeCompare(a.removed_at ?? ""));
      },
    ),
    zones: derived(
      state,
      (s) => [s.loaded, s.view.zones],
      (s) =>
        s.loaded
          ? [...s.view.zones.values()].filter((zone) => zone.deleted_at === null).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "de"))
          : undefined,
    ),
    settings: derived(
      state,
      (s) => [s.loaded, s.view.settings],
      (s) => (s.loaded ? (s.view.settings ?? DEFAULT_SETTINGS) : undefined),
    ),
    printers: derived(
      state,
      (s) => [s.loaded, s.view.printers],
      (s) =>
        s.loaded
          ? [...s.view.printers.values()].filter((printer) => printer.deleted_at === null).sort((a, b) => a.name.localeCompare(b.name, "de"))
          : undefined,
    ),
    printerStatus: derived(
      state,
      (s) => [s.loaded, s.view.printer_status],
      (s) => (s.loaded ? [...s.view.printer_status.values()] : undefined),
    ),
    printJobs: derived(
      state,
      (s) => [s.loaded, s.view.print_jobs],
      (s) => {
        if (!s.loaded) {
          return undefined;
        }
        // Alle offenen und die der letzten 30 Tage, neueste zuerst.
        const limit = retentionLimit(store.serverNowMs(), PRINT_JOB_RETENTION_DAYS);
        return [...s.view.print_jobs.values()].filter((job) => !isExpiredJob(job, limit)).sort((a, b) => b.created_at.localeCompare(a.created_at));
      },
    ),
    shoppingItems: derived(
      state,
      (s) => [s.loaded, s.view.shopping_items, s.view.settings?.trash_retention_days],
      (s) => {
        if (!s.loaded) {
          return undefined;
        }
        // Gelöschte nie, Erledigte nur innerhalb der Aufbewahrungsdauer (wie entnommene Packungen).
        const limit = retentionLimit(store.serverNowMs(), (s.view.settings ?? DEFAULT_SETTINGS).trash_retention_days);
        return [...s.view.shopping_items.values()].filter((item) => item.deleted_at === null && !isExpiredShoppingItem(item, limit)).sort(compareShoppingItems);
      },
    ),

    async findPackage(id) {
      await ready;
      return store.snapshot.view.packages.get(id);
    },
    async findProduct(id) {
      await ready;
      return resolveProduct(new Draft(store.snapshot.view), id);
    },
    async findProductByBarcode(barcode) {
      await ready;
      return barcodeOwner(new Draft(store.snapshot.view), barcode);
    },
    imageUrl,
  };
}
