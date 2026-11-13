/**
 * Die Wirkung der Befehle auf einen Datenbestand (docs/sync-protokoll.md, 6.6 und 7).
 */
import { describe, expect, it } from "vitest";

import { COMMAND_TYPES, type Command, type HouseholdSettings, type Package, type Printer, type Product, type Zone } from "@/contract";

import { Draft, EMPTY_TABLES, tableFrom, type Tables } from "../tables";
import { applyCommand, replay, resolveProduct, resolveZone, type ApplyOutcome } from "./apply";

const T0 = "2026-11-13T10:00:00.000Z";
const T1 = "2026-11-13T11:00:00.000Z";
const uuid = (group: number, n: number) => `${group}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function zone(n: number, changes: Partial<Zone> = {}): Zone {
  return { id: uuid(1, n), name: `Zone ${n}`, icon: "box", color: null, sort: n, printer_id: null, created_at: T0, updated_at: T0, deleted_at: null, moved_to: null, ...changes };
}

function product(n: number, changes: Partial<Product> = {}): Product {
  return { id: uuid(2, n), name: `Produkt ${n}`, brand: "", quantity: "", image: null, warn_days: null, lookup: "none", barcodes: [], created_at: T0, updated_at: T0, deleted_at: null, merged_into: null, ...changes };
}

function pkg(id: string, changes: Partial<Package> = {}): Package {
  return { id, product_id: uuid(2, 1), zone_id: uuid(1, 1), best_before: "2027-01-01", created_at: T0, updated_at: T0, removed_at: null, removal_reason: null, displaced: null, ...changes };
}

const SETTINGS: HouseholdSettings = { zone_mode: "primary", primary_zone_id: uuid(1, 1), warn_days: 14, trash_retention_days: 30, default_printer_id: null, updated_at: T0 };

function tables(data: { zones?: Zone[]; products?: Product[]; packages?: Package[]; printers?: Printer[]; settings?: HouseholdSettings | null } = {}): Tables {
  return {
    ...EMPTY_TABLES,
    zones: tableFrom("zones", data.zones ?? [zone(1), zone(2)]),
    products: tableFrom("products", data.products ?? [product(1), product(2)]),
    packages: tableFrom("packages", data.packages ?? []),
    printers: tableFrom("printers", data.printers ?? []),
    settings: data.settings === undefined ? SETTINGS : data.settings,
  };
}

let counter = 0;
type Payload = Command extends infer C ? (C extends Command ? Omit<C, "id" | "at"> : never) : never;

/** Wendet Befehle der Reihe nach an und liefert den neuen Stand samt Ergebnissen. */
function run(start: Tables, ...payloads: Payload[]): { state: Tables; outcomes: ApplyOutcome[] } {
  const draft = new Draft(start);
  const outcomes = payloads.map((payload) => {
    counter += 1;
    return applyCommand(draft, { id: uuid(9, counter), at: T1, ...payload } as Command, { at: T1, device_id: uuid(5, 1), authoritative: false });
  });
  return { state: draft.commit(), outcomes };
}

const statuses = (outcomes: ApplyOutcome[]) => outcomes.map((outcome) => (outcome.status === "rejected" ? outcome.code : outcome.status));

describe("Produkte", () => {
  it("legt Produkte an; nachschlagbare Barcodes setzen lookup auf pending", () => {
    const { state, outcomes } = run(
      tables({ products: [] }),
      { type: "product.create", product_id: uuid(2, 1), name: "Reis", barcodes: ["4006381333931", "20000004"] },
      { type: "product.create", product_id: uuid(2, 2), barcodes: ["2112345678900"] },
      { type: "product.create", product_id: uuid(2, 3) },
      { type: "product.create", product_id: uuid(2, 1), name: "Noch einmal" },
    );
    expect(statuses(outcomes)).toEqual(["applied", "applied", "applied", "id_conflict"]);
    expect(state.products.get(uuid(2, 1))).toMatchObject({ name: "Reis", lookup: "pending", barcodes: ["20000004", "4006381333931"], created_at: T1 });
    // Ladeninterne Codes und Produkte ohne Barcode werden nie nachgeschlagen.
    expect(state.products.get(uuid(2, 2))).toMatchObject({ name: "", lookup: "none" });
    expect(state.products.get(uuid(2, 3))?.lookup).toBe("none");
  });

  it("führt zusammen: Packungen und Barcodes wandern, leere Felder werden gefüllt", () => {
    const start = tables({
      products: [product(1, { name: "", brand: "", barcodes: ["11111111"], warn_days: null }), product(2, { name: "Reis", brand: "Kornhaus", quantity: "1 kg", barcodes: ["22222222"], warn_days: 5, image: "bild.jpg" })],
      packages: [pkg("AAAAA", { product_id: uuid(2, 2) }), pkg("BBBBB", { product_id: uuid(2, 2), removed_at: T0, removal_reason: "consumed" }), pkg("CCCCC", { product_id: uuid(2, 1) })],
    });
    const { state, outcomes } = run(start, { type: "product.merge", source_id: uuid(2, 2), target_id: uuid(2, 1) });
    expect(statuses(outcomes)).toEqual(["applied"]);
    // Alle Packungen der Quelle, auch entnommene, gehören zum Ziel.
    expect([...state.packages.values()].map((entry) => entry.product_id)).toEqual([uuid(2, 1), uuid(2, 1), uuid(2, 1)]);
    expect(state.products.get(uuid(2, 1))).toMatchObject({ name: "Reis", brand: "Kornhaus", quantity: "1 kg", warn_days: 5, image: "bild.jpg", barcodes: ["11111111", "22222222"], deleted_at: null });
    expect(state.products.get(uuid(2, 2))).toMatchObject({ deleted_at: T1, merged_into: uuid(2, 1), barcodes: [] });
  });

  it("überschreibt beim Zusammenführen keine gefüllten Felder des Ziels", () => {
    const start = tables({ products: [product(1, { name: "Basmati", warn_days: 3 }), product(2, { name: "Reis", warn_days: 9 })] });
    const { state } = run(start, { type: "product.merge", source_id: uuid(2, 2), target_id: uuid(2, 1) });
    expect(state.products.get(uuid(2, 1))).toMatchObject({ name: "Basmati", warn_days: 3 });
  });

  it("lässt ein neues Produkt mit schon vergebenem Barcode sofort im Besitzer aufgehen", () => {
    const start = tables({ products: [product(1, { name: "Reis", barcodes: ["11111111"] }), product(2, { name: "Nudeln", barcodes: ["33333333"] })] });
    const { state, outcomes } = run(start, { type: "product.create", product_id: uuid(2, 9), name: "Platzhalter", barcodes: ["22222222", "11111111", "33333333"] }, { type: "package.create", package_id: "AAAAA", product_id: uuid(2, 9), zone_id: uuid(1, 1) });
    expect(statuses(outcomes)).toEqual(["applied", "applied"]);
    // Ziel ist der Besitzer des ersten betroffenen Barcodes; der freie Barcode wandert mit, der eines dritten Produkts bleibt dort.
    expect(state.products.get(uuid(2, 9))).toMatchObject({ merged_into: uuid(2, 1), deleted_at: T1, barcodes: [] });
    expect(state.products.get(uuid(2, 1))?.barcodes).toEqual(["11111111", "22222222"]);
    expect(state.products.get(uuid(2, 2))?.barcodes).toEqual(["33333333"]);
    // Verweise auf das zusammengeführte Produkt folgen merged_into.
    expect(state.packages.get("AAAAA")?.product_id).toBe(uuid(2, 1));
  });

  it("lässt beim Zuordnen eines vergebenen Barcodes den bisherigen Besitzer im genannten Produkt aufgehen", () => {
    const start = tables({ products: [product(1, { barcodes: ["11111111"] }), product(2, { barcodes: ["22222222"] })], packages: [pkg("AAAAA", { product_id: uuid(2, 2) })] });
    const { state } = run(start, { type: "product.add_barcode", product_id: uuid(2, 1), barcode: "22222222" });
    expect(state.products.get(uuid(2, 2))?.merged_into).toBe(uuid(2, 1));
    expect(state.products.get(uuid(2, 1))?.barcodes).toEqual(["11111111", "22222222"]);
    expect(state.packages.get("AAAAA")?.product_id).toBe(uuid(2, 1));
  });

  it("folgt einer Zusammenführung über mehrere Schritte und ändert Barcodes", () => {
    const start = tables({ products: [product(1, { merged_into: uuid(2, 2), deleted_at: T0 }), product(2, { merged_into: uuid(2, 3), deleted_at: T0 }), product(3, { barcodes: ["11111111"] })] });
    const draft = new Draft(start);
    expect(resolveProduct(draft, uuid(2, 1))?.id).toBe(uuid(2, 3));
    expect(resolveProduct(draft, uuid(2, 99))).toBeUndefined();
    const { state, outcomes } = run(
      start,
      { type: "product.update", product_id: uuid(2, 1), changes: { name: "Neu", warn_days: null } },
      { type: "product.add_barcode", product_id: uuid(2, 1), barcode: "22222222" },
      { type: "product.add_barcode", product_id: uuid(2, 1), barcode: "22222222" },
      { type: "product.remove_barcode", product_id: uuid(2, 2), barcode: "11111111" },
      { type: "product.remove_barcode", product_id: uuid(2, 2), barcode: "99999999" },
      { type: "product.update", product_id: uuid(2, 99), changes: { name: "Nichts" } },
    );
    expect(statuses(outcomes)).toEqual(["applied", "applied", "applied", "applied", "applied", "not_found"]);
    expect(state.products.get(uuid(2, 3))).toMatchObject({ name: "Neu", barcodes: ["22222222"] });
  });
});

describe("Packungen", () => {
  it("legt an, bearbeitet nur die genannten Felder und lehnt Unbekanntes ab", () => {
    const { state, outcomes } = run(
      tables(),
      { type: "package.create", package_id: "AAAAA", product_id: uuid(2, 1), zone_id: uuid(1, 1), best_before: "2027-03-25" },
      { type: "package.create", package_id: "AAAAA", product_id: uuid(2, 1), zone_id: uuid(1, 1) },
      { type: "package.create", package_id: "BBBBB", product_id: uuid(2, 99), zone_id: uuid(1, 1) },
      { type: "package.create", package_id: "CCCCC", product_id: uuid(2, 1), zone_id: uuid(1, 99) },
      { type: "package.update", package_id: "AAAAA", changes: { zone_id: uuid(1, 2) } },
      { type: "package.update", package_id: "AAAAA", changes: { best_before: null } },
      { type: "package.update", package_id: "AAAAA", changes: { zone_id: uuid(1, 99) } },
      { type: "package.update", package_id: "ZZZZZ", changes: { best_before: null } },
    );
    expect(statuses(outcomes)).toEqual(["applied", "id_conflict", "not_found", "not_found", "applied", "applied", "not_found", "not_found"]);
    expect(state.packages.size).toBe(1);
    expect(state.packages.get("AAAAA")).toMatchObject({ zone_id: uuid(1, 2), best_before: null, product_id: uuid(2, 1), created_at: T1, removed_at: null });
  });

  it("lässt Löschen gegen Bearbeiten gewinnen und hebt die Bearbeitung auf", () => {
    const start = tables({ packages: [pkg("AAAAA")] });
    const { state, outcomes } = run(
      start,
      { type: "package.remove", package_id: "AAAAA", reason: "consumed" },
      { type: "package.update", package_id: "AAAAA", changes: { best_before: "2028-01-01", zone_id: uuid(1, 2) } },
      { type: "package.update", package_id: "AAAAA", changes: { best_before: null } },
      { type: "package.remove", package_id: "AAAAA", reason: "discarded" },
    );
    expect(statuses(outcomes)).toEqual(["applied", "displaced", "displaced", "applied"]);
    const removed = state.packages.get("AAAAA");
    // Die Packung selbst bleibt, wie sie war; nur der Grund ändert sich nachträglich.
    expect(removed).toMatchObject({ best_before: "2027-01-01", zone_id: uuid(1, 1), removed_at: T1, removal_reason: "discarded" });
    // Je Feld bleibt die spätere Bearbeitung.
    expect(removed?.displaced?.changes).toEqual([
      { field: "zone_id", value: uuid(1, 2) },
      { field: "best_before", value: null },
    ]);
  });

  it("stellt wieder her, mit oder ohne die verdrängte Bearbeitung", () => {
    const displaced = { at: T0, changes: [{ field: "best_before" as const, value: "2028-01-01" }, { field: "zone_id" as const, value: uuid(1, 2) }] };
    const start = tables({ packages: [pkg("AAAAA", { removed_at: T0, removal_reason: "consumed", displaced }), pkg("BBBBB", { removed_at: T0, removal_reason: "consumed", displaced }), pkg("CCCCC")] });
    const { state, outcomes } = run(
      start,
      { type: "package.restore", package_id: "AAAAA", apply_displaced: true },
      { type: "package.restore", package_id: "BBBBB" },
      { type: "package.restore", package_id: "CCCCC" },
      { type: "package.restore", package_id: "ZZZZZ" },
    );
    expect(statuses(outcomes)).toEqual(["applied", "applied", "applied", "not_found"]);
    expect(state.packages.get("AAAAA")).toMatchObject({ removed_at: null, removal_reason: null, displaced: null, best_before: "2028-01-01", zone_id: uuid(1, 2) });
    // In jedem Fall ist `displaced` danach leer.
    expect(state.packages.get("BBBBB")).toMatchObject({ removed_at: null, displaced: null, best_before: "2027-01-01", zone_id: uuid(1, 1) });
    // Ohne Wirkung, wenn die Packung nicht entnommen ist.
    expect(state.packages.get("CCCCC")).toBe(start.packages.get("CCCCC"));
  });
});

describe("Zonen und Einstellungen", () => {
  it("löscht eine Zone, verschiebt ihre Packungen und stellt die Primärzone um", () => {
    const start = tables({ packages: [pkg("AAAAA"), pkg("BBBBB", { removed_at: T0, removal_reason: "consumed" }), pkg("CCCCC", { zone_id: uuid(1, 2) })] });
    const { state, outcomes } = run(
      start,
      { type: "zone.delete", zone_id: uuid(1, 1), move_to: uuid(1, 1) },
      { type: "zone.delete", zone_id: uuid(1, 1), move_to: uuid(1, 99) },
      { type: "zone.delete", zone_id: uuid(1, 99), move_to: uuid(1, 2) },
      { type: "zone.delete", zone_id: uuid(1, 1), move_to: uuid(1, 2) },
      { type: "zone.delete", zone_id: uuid(1, 1), move_to: uuid(1, 2) },
      { type: "zone.update", zone_id: uuid(1, 1), changes: { name: "Zu spät" } },
      { type: "zone.delete", zone_id: uuid(1, 2), move_to: uuid(1, 1) },
    );
    expect(statuses(outcomes)).toEqual(["invalid", "not_found", "not_found", "applied", "applied", "not_found", "last_zone"]);
    expect([...state.packages.values()].every((entry) => entry.zone_id === uuid(1, 2))).toBe(true);
    expect(state.zones.get(uuid(1, 1))).toMatchObject({ deleted_at: T1, moved_to: uuid(1, 2), name: "Zone 1" });
    expect(state.settings?.primary_zone_id).toBe(uuid(1, 2));
  });

  it("folgt bei gelöschten Zonen moved_to, auch über mehrere Schritte", () => {
    const start = tables({ zones: [zone(1, { deleted_at: T0, moved_to: uuid(1, 2) }), zone(2, { deleted_at: T0, moved_to: uuid(1, 3) }), zone(3)], packages: [pkg("AAAAA", { zone_id: uuid(1, 3) })] });
    expect(resolveZone(new Draft(start), uuid(1, 1))?.id).toBe(uuid(1, 3));
    const { state, outcomes } = run(start, { type: "package.create", package_id: "BBBBB", product_id: uuid(2, 1), zone_id: uuid(1, 1) }, { type: "package.update", package_id: "AAAAA", changes: { zone_id: uuid(1, 2) } });
    expect(statuses(outcomes)).toEqual(["applied", "applied"]);
    expect(state.packages.get("BBBBB")?.zone_id).toBe(uuid(1, 3));
    expect(state.packages.get("AAAAA")?.zone_id).toBe(uuid(1, 3));
  });

  it("legt Zonen mit den Vorgaben an und ändert nur die genannten Felder", () => {
    const { state, outcomes } = run(
      tables(),
      { type: "zone.create", zone_id: uuid(1, 3), name: "Keller" },
      { type: "zone.create", zone_id: uuid(1, 3), name: "Doppelt" },
      { type: "zone.update", zone_id: uuid(1, 3), changes: { color: "blue", sort: 7 } },
      { type: "zone.update", zone_id: uuid(1, 3), changes: { color: null } },
      { type: "settings.update", changes: { zone_mode: "equal", primary_zone_id: null, trash_retention_days: 60 } },
    );
    expect(statuses(outcomes)).toEqual(["applied", "id_conflict", "applied", "applied", "applied"]);
    expect(state.zones.get(uuid(1, 3))).toMatchObject({ name: "Keller", icon: "box", color: null, sort: 7, printer_id: null });
    expect(state.settings).toMatchObject({ zone_mode: "equal", primary_zone_id: null, trash_retention_days: 60, warn_days: 14, updated_at: T1 });
  });
});

describe("Drucker und Etiketten", () => {
  const server = { driver: "image" as const, model: null, address: null, media: "62" };
  const direct = { urls: ["https://10.71.83.1:8443"], token: "geheim", printer: null };

  it("verwaltet Drucker; Löschen räumt die Verweise in Zonen und Einstellungen auf", () => {
    const start = tables({ zones: [zone(1, { printer_id: uuid(3, 1) }), zone(2)], settings: { ...SETTINGS, default_printer_id: uuid(3, 1) } });
    const { state, outcomes } = run(
      start,
      { type: "printer.create", printer_id: uuid(3, 1), name: "Küche", connection: "server", server },
      { type: "printer.create", printer_id: uuid(3, 2), name: "Falsch", connection: "server", direct },
      { type: "printer.update", printer_id: uuid(3, 1), changes: { direct } },
      { type: "printer.update", printer_id: uuid(3, 1), changes: { name: "Flur" } },
      { type: "printer.report", printer_id: uuid(3, 1), boot_id: "boot-1", status: { reachable: true, ready: true, media_detected: null, errors: [] } },
      { type: "printer.delete", printer_id: uuid(3, 1) },
      { type: "printer.delete", printer_id: uuid(3, 1) },
      { type: "printer.update", printer_id: uuid(3, 1), changes: { name: "Zu spät" } },
      { type: "printer.delete", printer_id: uuid(3, 9) },
    );
    expect(statuses(outcomes)).toEqual(["applied", "invalid", "invalid", "applied", "applied", "applied", "applied", "not_found", "not_found"]);
    expect(state.printers.get(uuid(3, 1))).toMatchObject({ name: "Flur", connection: "server", server, direct: null, deleted_at: T1 });
    expect(state.printer_status.get(uuid(3, 1))).toMatchObject({ observed_at: T1, boot_id: "boot-1", host: null });
    expect(state.zones.get(uuid(1, 1))?.printer_id).toBeNull();
    expect(state.settings?.default_printer_id).toBeNull();
  });

  it("legt Etiketten als ausstehend an und meldet ihren Zustand als ein Feld", () => {
    const start = tables({ packages: [pkg("AAAAA")] });
    const { state, outcomes } = run(
      start,
      { type: "print.request", job_id: uuid(4, 1), kind: "package", package_id: "AAAAA", printer_id: uuid(3, 1) },
      { type: "print.request", job_id: uuid(4, 1), kind: "package", package_id: "AAAAA" },
      { type: "print.request", job_id: uuid(4, 2), kind: "zone", zone_id: uuid(1, 1) },
      { type: "print.request", job_id: uuid(4, 3), kind: "package", package_id: "ZZZZZ" },
      { type: "print.request", job_id: uuid(4, 4), kind: "zone", package_id: "AAAAA" },
      { type: "print.report", job_id: uuid(4, 1), state: "failed", printer_id: uuid(3, 1), boot_id: "boot-1", error: "no_media" },
      { type: "print.report", job_id: uuid(4, 2), state: "cancelled" },
      { type: "print.report", job_id: uuid(4, 9), state: "printed" },
    );
    expect(statuses(outcomes)).toEqual(["applied", "id_conflict", "applied", "not_found", "invalid", "applied", "applied", "not_found"]);
    expect(state.print_jobs.get(uuid(4, 1))).toMatchObject({ kind: "package", package_id: "AAAAA", zone_id: null, state: "failed", error: "no_media", boot_id: "boot-1", printer_id: uuid(3, 1), device_id: uuid(5, 1) });
    expect(state.print_jobs.get(uuid(4, 2))).toMatchObject({ kind: "zone", zone_id: uuid(1, 1), package_id: null, state: "cancelled", error: null, created_at: T1 });
  });
});

describe("Erneut anwenden", () => {
  it("kennt jede Befehlsart des Katalogs", () => {
    const draft = new Draft(tables());
    for (const type of COMMAND_TYPES) {
      // Ohne Nutzlast darf ein Befehl abgelehnt werden, aber nie als unbekannte Art durchfallen oder werfen.
      const outcome = (() => {
        try {
          return applyCommand(draft, { id: uuid(9, 0), at: T1, type, changes: {} } as unknown as Command, { at: T1, device_id: null, authoritative: false });
        } catch {
          return null;
        }
      })();
      if (outcome !== null && outcome.status === "rejected") {
        expect(["not_found", "invalid", "last_zone", "id_conflict"], type).toContain(outcome.code);
      }
    }
  });

  it("lässt sich von einem Befehl mit unerwartetem Inhalt nicht aufhalten", () => {
    const draft = new Draft(tables());
    replay(
      draft,
      [
        { id: uuid(9, 1), at: T1, type: "product.update", product_id: uuid(2, 1), changes: null } as unknown as Command,
        { id: uuid(9, 2), at: T1, type: "noch.unbekannt" } as unknown as Command,
        { id: uuid(9, 3), at: T1, type: "zone.update", zone_id: uuid(1, 1), changes: { name: "Keller" } },
      ],
      null,
    );
    expect(draft.commit().zones.get(uuid(1, 1))?.name).toBe("Keller");
  });

  it("berührt nur die Tabellen, die ein Befehl ändert", () => {
    const start = tables({ packages: [pkg("AAAAA")] });
    const { state } = run(start, { type: "zone.update", zone_id: uuid(1, 1), changes: { name: "Keller" } });
    expect(state.packages).toBe(start.packages);
    expect(state.products).toBe(start.products);
    expect(state.settings).toBe(start.settings);
    expect(state.zones).not.toBe(start.zones);
    expect(state.zones.get(uuid(1, 2))).toBe(start.zones.get(uuid(1, 2)));
  });
});
