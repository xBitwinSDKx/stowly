/**
 * Bestand ändern: einlagern, entnehmen, wiederherstellen, bearbeiten (`Core.stock`).
 *
 * Jede Methode prüft die Eingabe gegen die lokale Kopie und erzeugt daraus Befehle. Sie ist
 * erfüllt, sobald die Befehle in der Outbox stehen; auf den Server wartet sie nie.
 */
import type { Package, PackageChanges, PrintJob, RemovalReason } from "@/contract/api.gen";
import { MAX_STORE_COUNT, type ProductRef, type StockApi, type StoreInput, type StoreResult } from "@/contract/core";
import { CoreError } from "@/contract/errors";
import { newUuid } from "@/contract/ids";

import { barcodeOwner } from "../commands/apply";
import type { Mutation } from "../store";
import type { CoreRuntime } from "./runtime";
import {
  activeProduct,
  activeZone,
  checkBarcode,
  checkBestBefore,
  checkWarnDays,
  existingPackages,
  hasPrinter,
  invalid,
  LIMITS,
  optionalText,
  requiredText,
} from "./validate";

const REASONS: readonly RemovalReason[] = ["consumed", "discarded", "mistake"];

/** Legt ein neues Produkt an und liefert seine Kennung. */
export function createProduct(
  mutation: Mutation,
  input: { name: string; brand?: string; quantity?: string; warn_days?: number | null; barcodes?: readonly string[] },
  options: { placeholder: boolean },
): string {
  const name = options.placeholder ? optionalText(input.name, LIMITS.product_name, "Der Name") : requiredText(input.name, LIMITS.product_name, "Das Produkt");
  const brand = optionalText(input.brand, LIMITS.brand, "Die Marke");
  const quantity = optionalText(input.quantity, LIMITS.quantity, "Die Packungsgröße");
  checkWarnDays(input.warn_days);
  const barcodes = [...new Set(input.barcodes ?? [])];
  if (barcodes.length > LIMITS.barcodes) {
    throw invalid(`Ein Produkt kann höchstens ${LIMITS.barcodes} Barcodes haben.`);
  }
  for (const barcode of barcodes) {
    checkBarcode(barcode);
    const owner = barcodeOwner(mutation.draft, barcode);
    if (owner) {
      throw new CoreError("barcode_taken", "Der Barcode gehört schon zu einem anderen Produkt.", { product_id: owner.id });
    }
  }
  const productId = newUuid();
  mutation.emit({ type: "product.create", product_id: productId, name, brand, quantity, warn_days: input.warn_days ?? null, barcodes: barcodes.sort() });
  return productId;
}

/** Das Produkt, das eingelagert wird: ein bekanntes, das zum Barcode, oder ein neues. */
function resolveProductRef(mutation: Mutation, ref: ProductRef): string {
  if (ref?.kind === "existing") {
    return activeProduct(mutation.draft, ref.product_id).id;
  }
  if (ref?.kind === "barcode") {
    checkBarcode(ref.barcode);
    const known = barcodeOwner(mutation.draft, ref.barcode);
    if (known) {
      return known.id;
    }
    // Unbekannter Barcode: sofort ein Platzhalter. Name und Bild ergänzt der Server später.
    return createProduct(mutation, { name: ref.name ?? "", barcodes: [ref.barcode] }, { placeholder: true });
  }
  if (ref?.kind === "new") {
    return createProduct(mutation, ref, { placeholder: false });
  }
  throw invalid("Es fehlt die Angabe, welches Produkt eingelagert wird.");
}

function packageChanges(mutation: Mutation, changes: PackageChanges): PackageChanges {
  const result: PackageChanges = {};
  if (changes === null || typeof changes !== "object") {
    throw invalid("Es fehlt die Angabe, was geändert werden soll.");
  }
  if ("best_before" in changes) {
    const value = changes.best_before ?? null;
    checkBestBefore(value);
    result.best_before = value;
  }
  if (changes.zone_id !== undefined) {
    result.zone_id = activeZone(mutation.draft, changes.zone_id).id;
  }
  if (changes.product_id !== undefined) {
    result.product_id = activeProduct(mutation.draft, changes.product_id).id;
  }
  return result;
}

export function createStockApi(runtime: CoreRuntime): StockApi {
  return {
    store(input: StoreInput): Promise<StoreResult> {
      return runtime.change((mutation) => {
        if (!Number.isInteger(input.count) || input.count < 1 || input.count > MAX_STORE_COUNT) {
          throw invalid(`Die Menge muss zwischen 1 und ${MAX_STORE_COUNT} liegen.`);
        }
        checkBestBefore(input.best_before);
        const zone = activeZone(mutation.draft, input.zone_id);
        const productId = resolveProductRef(mutation, input.product);

        const packageIds: string[] = [];
        for (let index = 0; index < input.count; index += 1) {
          const packageId = mutation.takePackageId();
          mutation.emit({ type: "package.create", package_id: packageId, product_id: productId, zone_id: zone.id, best_before: input.best_before });
          packageIds.push(packageId);
        }

        // Etiketten gibt es nur, wenn der Haushalt einen Drucker hat (docs/etiketten.md, Abschnitt 4).
        const jobIds: string[] = [];
        if ((input.labels ?? mutation.prefs.print_labels) && hasPrinter(mutation.draft)) {
          for (const packageId of packageIds) {
            const jobId = newUuid();
            mutation.emit({ type: "print.request", job_id: jobId, kind: "package", package_id: packageId });
            jobIds.push(jobId);
          }
        }

        const product = mutation.draft.get("products", productId);
        if (!product) {
          throw new CoreError("internal", "Das Produkt ließ sich nicht anlegen.");
        }
        return {
          product,
          packages: packageIds.map((id) => mutation.draft.get("packages", id)).filter((pkg): pkg is Package => pkg !== undefined),
          print_jobs: jobIds.map((id) => mutation.draft.get("print_jobs", id)).filter((job): job is PrintJob => job !== undefined),
        };
      });
    },

    remove(packageIds: string[], reason: RemovalReason): Promise<void> {
      return runtime.change((mutation) => {
        if (!REASONS.includes(reason)) {
          throw invalid("Unbekannter Grund für das Entnehmen.");
        }
        const packages = existingPackages(mutation.draft, packageIds);
        const ids = new Set(packages.map((pkg) => pkg.id));
        // Erst nachsehen, dann schreiben: Ein Etikett, das noch aussteht, braucht eine entnommene Packung nicht mehr.
        const pendingJobs = mutation.draft.rows("print_jobs").filter((job) => job.state === "pending" && job.package_id !== null && ids.has(job.package_id));
        for (const pkg of packages) {
          if (pkg.removed_at !== null && pkg.removal_reason === reason) {
            continue;
          }
          mutation.emit({ type: "package.remove", package_id: pkg.id, reason });
        }
        for (const job of pendingJobs) {
          mutation.emit({ type: "print.report", job_id: job.id, state: "cancelled", printer_id: job.printer_id, boot_id: job.boot_id, error: null });
        }
      });
    },

    restore(packageIds: string[], options?: { apply_displaced?: boolean }): Promise<void> {
      return runtime.change((mutation) => {
        for (const pkg of existingPackages(mutation.draft, packageIds)) {
          if (pkg.removed_at !== null) {
            mutation.emit({ type: "package.restore", package_id: pkg.id, apply_displaced: options?.apply_displaced === true });
          }
        }
      });
    },

    update(packageIds: string[], changes: PackageChanges): Promise<void> {
      return runtime.change((mutation) => {
        const packages = existingPackages(mutation.draft, packageIds);
        const wanted = packageChanges(mutation, changes);
        if (Object.keys(wanted).length === 0) {
          return;
        }
        for (const pkg of packages) {
          // Jeder Befehl bekommt sein eigenes Objekt: Die Outbox soll keine geteilten Verweise speichern.
          mutation.emit({ type: "package.update", package_id: pkg.id, changes: { ...wanted } });
        }
      });
    },
  };
}
