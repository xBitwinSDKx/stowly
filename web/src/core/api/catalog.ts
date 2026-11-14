/**
 * Produkte, Zonen, Einstellungen des Haushalts und des Geräts
 * (`Core.products`, `Core.zones`, `Core.settings`, `Core.prefs`).
 */
import type { ProductChanges, SettingsChanges, ZoneChanges } from "@/contract/api.gen";
import type { DevicePrefs, NewProduct, NewZone, PrefsApi, ProductsApi, SettingsApi, ZonesApi } from "@/contract/core";
import { CoreError } from "@/contract/errors";
import { newUuid } from "@/contract/ids";

import { barcodeOwner } from "../commands/apply";
import type { CoreRuntime } from "./runtime";
import { createProduct } from "./stock";
import {
  activePrinter,
  activeProduct,
  activeZone,
  activeZones,
  checkBarcode,
  checkBarcodeCount,
  checkReference,
  checkRetentionDays,
  checkWarnDays,
  checkZoneColor,
  checkZoneIcon,
  invalid,
  LIMITS,
  optionalText,
  requiredText,
} from "./validate";

/** Alles an `Core.products`, was ohne Server auskommt; `lookup` setzt src/core/index.ts dazu. */
export function createProductsApi(runtime: CoreRuntime): Omit<ProductsApi, "lookup"> {
  return {
    create(input: NewProduct) {
      return runtime.change((mutation) => {
        const id = createProduct(mutation, input, { placeholder: false });
        const product = mutation.draft.get("products", id);
        if (!product) {
          throw new CoreError("internal", "Das Produkt ließ sich nicht anlegen.");
        }
        return product;
      });
    },

    update(id: string, changes: ProductChanges) {
      return runtime.change((mutation) => {
        const product = activeProduct(mutation.draft, id);
        const wanted: ProductChanges = {};
        if (changes.name !== undefined) {
          wanted.name = requiredText(changes.name, LIMITS.product_name, "Das Produkt");
        }
        if (changes.brand !== undefined) {
          wanted.brand = optionalText(changes.brand, LIMITS.brand, "Die Marke");
        }
        if (changes.quantity !== undefined) {
          wanted.quantity = optionalText(changes.quantity, LIMITS.quantity, "Die Packungsgröße");
        }
        if ("warn_days" in changes) {
          checkWarnDays(changes.warn_days);
          wanted.warn_days = changes.warn_days ?? null;
        }
        if (Object.keys(wanted).length > 0) {
          mutation.emit({ type: "product.update", product_id: product.id, changes: wanted });
        }
      });
    },

    addBarcode(id: string, barcode: string) {
      return runtime.change((mutation) => {
        const product = activeProduct(mutation.draft, id);
        checkBarcode(barcode);
        const owner = barcodeOwner(mutation.draft, barcode);
        if (owner && owner.id !== product.id) {
          // Zusammenführen lässt sich nicht umkehren: Das entscheidet der Anwender über `merge`.
          throw new CoreError("barcode_taken", "Der Barcode gehört schon zu einem anderen Produkt.", { product_id: owner.id });
        }
        if (owner) {
          return;
        }
        checkBarcodeCount(product.barcodes.length + 1);
        mutation.emit({ type: "product.add_barcode", product_id: product.id, barcode });
      });
    },

    removeBarcode(id: string, barcode: string) {
      return runtime.change((mutation) => {
        const product = activeProduct(mutation.draft, id);
        if (typeof barcode === "string" && product.barcodes.includes(barcode)) {
          mutation.emit({ type: "product.remove_barcode", product_id: product.id, barcode });
        }
      });
    },

    merge(sourceId: string, targetId: string) {
      return runtime.change((mutation) => {
        const source = activeProduct(mutation.draft, sourceId);
        const target = activeProduct(mutation.draft, targetId);
        if (source.id !== target.id) {
          mutation.emit({ type: "product.merge", source_id: source.id, target_id: target.id });
        }
      });
    },
  };
}

export function createZonesApi(runtime: CoreRuntime): ZonesApi {
  return {
    create(input: NewZone) {
      return runtime.change((mutation) => {
        const name = requiredText(input.name, LIMITS.zone_name, "Die Zone");
        const icon = input.icon ?? "box";
        const color = input.color ?? null;
        const printerId = input.printer_id ?? null;
        checkZoneIcon(icon);
        checkZoneColor(color);
        checkReference(printerId, "Drucker der Zone");
        // Hinter der letzten Zone.
        const sort = activeZones(mutation.draft).reduce((highest, zone) => Math.max(highest, zone.sort), -1) + 1;
        const id = newUuid();
        mutation.emit({ type: "zone.create", zone_id: id, name, icon, color, sort, printer_id: printerId });
        const zone = mutation.draft.get("zones", id);
        if (!zone) {
          throw new CoreError("internal", "Die Zone ließ sich nicht anlegen.");
        }
        return zone;
      });
    },

    update(id: string, changes: ZoneChanges) {
      return runtime.change((mutation) => {
        const zone = activeZone(mutation.draft, id);
        const wanted: ZoneChanges = {};
        if (changes.name !== undefined) {
          wanted.name = requiredText(changes.name, LIMITS.zone_name, "Die Zone");
        }
        if (changes.icon !== undefined) {
          checkZoneIcon(changes.icon);
          wanted.icon = changes.icon;
        }
        if ("color" in changes) {
          const color = changes.color ?? null;
          checkZoneColor(color);
          wanted.color = color;
        }
        if (changes.sort !== undefined) {
          if (!Number.isInteger(changes.sort)) {
            throw invalid("Die Reihenfolge der Zone ist ungültig.");
          }
          wanted.sort = changes.sort;
        }
        if ("printer_id" in changes) {
          const printerId = changes.printer_id ?? null;
          checkReference(printerId, "Drucker der Zone");
          wanted.printer_id = printerId;
        }
        if (Object.keys(wanted).length > 0) {
          mutation.emit({ type: "zone.update", zone_id: zone.id, changes: wanted });
        }
      });
    },

    reorder(ids: string[]) {
      return runtime.change((mutation) => {
        if (!Array.isArray(ids) || new Set(ids).size !== ids.length) {
          throw invalid("Die Reihenfolge nennt eine Zone doppelt.");
        }
        // Erst alle prüfen, dann schreiben: Eine neue Reihenfolge sind mehrere zone.update mit `sort`.
        const zones = ids.map((id) => activeZone(mutation.draft, id));
        zones.forEach((zone, position) => {
          if (zone.sort !== position) {
            mutation.emit({ type: "zone.update", zone_id: zone.id, changes: { sort: position } });
          }
        });
      });
    },

    remove(id: string, moveTo: string) {
      return runtime.change((mutation) => {
        const zone = activeZone(mutation.draft, id);
        if (activeZones(mutation.draft).length <= 1) {
          throw new CoreError("last_zone", "Die letzte Zone lässt sich nicht löschen.");
        }
        if (id === moveTo) {
          throw invalid("Die Packungen müssen in eine andere Zone wandern.");
        }
        const target = activeZone(mutation.draft, moveTo);
        mutation.emit({ type: "zone.delete", zone_id: zone.id, move_to: target.id });
        if (mutation.prefs.scan_zone_id === zone.id) {
          mutation.setPrefs({ scan_zone_id: null });
        }
      });
    },
  };
}

export function createSettingsApi(runtime: CoreRuntime): SettingsApi {
  return {
    update(changes: SettingsChanges) {
      return runtime.change((mutation) => {
        const wanted: SettingsChanges = {};
        if (changes.zone_mode !== undefined) {
          if (changes.zone_mode !== "primary" && changes.zone_mode !== "equal") {
            throw invalid("Unbekannter Zonen-Modus.");
          }
          wanted.zone_mode = changes.zone_mode;
        }
        if ("primary_zone_id" in changes) {
          const zoneId = changes.primary_zone_id ?? null;
          wanted.primary_zone_id = zoneId === null ? null : activeZone(mutation.draft, zoneId).id;
        }
        if (changes.warn_days !== undefined) {
          if (changes.warn_days === null) {
            throw invalid("Die Vorlaufzeit des Haushalts darf nicht leer sein.");
          }
          checkWarnDays(changes.warn_days);
          wanted.warn_days = changes.warn_days;
        }
        if (changes.trash_retention_days !== undefined) {
          const days = changes.trash_retention_days;
          checkRetentionDays(days);
          wanted.trash_retention_days = days;
        }
        if ("default_printer_id" in changes) {
          const printerId = changes.default_printer_id ?? null;
          wanted.default_printer_id = printerId === null ? null : activePrinter(mutation.draft, printerId).id;
        }
        if (Object.keys(wanted).length === 0) {
          return;
        }
        const before = mutation.draft.settings?.trash_retention_days;
        mutation.emit({ type: "settings.update", changes: wanted });
        const after = mutation.draft.settings?.trash_retention_days;
        if (before !== undefined && after !== undefined && after > before) {
          // Längere Aufbewahrung: Die Lösch-Historie reicht erst nach einem vollständigen Abzug wieder so weit zurück (6.4).
          mutation.fullResync = true;
        }
      });
    },
  };
}

const PREF_CHECKS: { [K in keyof DevicePrefs]: (value: unknown) => boolean } = {
  print_labels: (value) => typeof value === "boolean",
  scan_sound: (value) => typeof value === "boolean",
  scan_vibration: (value) => typeof value === "boolean",
  scan_camera_id: (value) => value === null || typeof value === "string",
  scan_zone_id: (value) => value === null || typeof value === "string",
};

export function createPrefsUpdate(runtime: CoreRuntime): PrefsApi["update"] {
  return (changes: Partial<DevicePrefs>) =>
    runtime.change((mutation) => {
      const wanted: Partial<DevicePrefs> = {};
      for (const key of Object.keys(PREF_CHECKS) as (keyof DevicePrefs)[]) {
        const value = changes[key];
        if (value === undefined) {
          continue;
        }
        if (!PREF_CHECKS[key](value)) {
          throw invalid(`Ungültiger Wert für die Geräte-Einstellung ${key}.`);
        }
        (wanted as Record<string, unknown>)[key] = value;
      }
      const changed = (Object.keys(wanted) as (keyof DevicePrefs)[]).some((key) => wanted[key] !== mutation.prefs[key]);
      if (changed) {
        mutation.setPrefs(wanted);
      }
    });
}
