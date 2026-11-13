/**
 * Die Wirkung jedes Befehls auf einen Datenbestand (docs/sync-protokoll.md, Abschnitte 6.6 und 7).
 *
 * Der Kern wendet damit seine wartenden Befehle auf die lokale Kopie an: zuerst im Moment
 * der Änderung, danach nach jeder Antwort des Servers erneut auf dessen Stand. Dieselbe
 * Funktion treibt die nachgebaute Schnittstelle (src/core/testing), die damit den Server spielt.
 *
 * Es gibt hier keine Konfliktentscheidung nach Zeitstempeln (7.1): Lokal gilt immer der
 * eigene, noch unbestätigte Befehl. Ein Befehl, den der Server ablehnen würde, bleibt ohne
 * Wirkung; das Ergebnis sagt, warum.
 *
 * Ohne DOM: Diese Datei läuft auch im Service Worker.
 */
import type {
  CmdPackageCreate,
  CmdPackageRemove,
  CmdPackageRestore,
  CmdPackageUpdate,
  CmdPrinterCreate,
  CmdPrinterDelete,
  CmdPrinterReport,
  CmdPrinterUpdate,
  CmdPrintReport,
  CmdPrintRequest,
  CmdProductAddBarcode,
  CmdProductCreate,
  CmdProductMerge,
  CmdProductRemoveBarcode,
  CmdProductUpdate,
  CmdSettingsUpdate,
  CmdZoneCreate,
  CmdZoneDelete,
  CmdZoneUpdate,
  Command,
  DisplacedChange,
  Package,
  Product,
  RejectCode,
  Zone,
} from "@/contract/api.gen";
import { willLookUp } from "@/contract/barcode";

import type { Draft } from "../tables";

export type ApplyOutcome = { status: "applied" } | { status: "displaced" } | { status: "rejected"; code: RejectCode };

export interface ApplyContext {
  /** Zeitpunkt, der in die Datensätze geschrieben wird: lokal die Geräteuhr des Befehls, im Server der wirksame Zeitpunkt. */
  at: string;
  /** Gerät, das den Befehl erzeugt hat (für `PrintJob.device_id`). */
  device_id: string | null;
  /**
   * true im (nachgebauten) Server: Meldungen zu Druckern und Etiketten gelten nur, wenn sie
   * neuer sind als das Gespeicherte. Lokal gilt immer der eigene Befehl, weil sich die Uhr
   * des Geräts nicht mit der des Servers vergleichen lässt.
   */
  authoritative: boolean;
  /**
   * Schlägt der Server Barcodes nach (`SyncResponse.lookup_enabled`)? null = noch unbekannt.
   * Nur bei false beginnt ein neues Produkt mit nachschlagbarem Barcode als `lookup: "none"`.
   */
  lookup_enabled: boolean | null;
}

/** Was der Kern über das Gerät und den Server weiß, wenn er wartende Befehle erneut anwendet. */
export interface ReplayContext {
  /** Gerät, das die Befehle erzeugt hat. */
  device_id: string | null;
  lookup_enabled: boolean | null;
}

const APPLIED: ApplyOutcome = { status: "applied" };
const DISPLACED: ApplyOutcome = { status: "displaced" };

function rejected(code: RejectCode): ApplyOutcome {
  return { status: "rejected", code };
}

const MAX_HOPS = 32;

/** Ein Produkt nach Kennung; folgt einer Zusammenführung bis zum Ziel (7.3). */
export function resolveProduct(ws: Draft, id: string): Product | undefined {
  let product = ws.get("products", id);
  for (let hops = 0; product?.merged_into && hops < MAX_HOPS; hops += 1) {
    product = ws.get("products", product.merged_into);
  }
  return product && product.deleted_at === null ? product : undefined;
}

/** Eine Zone nach Kennung; folgt bei gelöschten Zonen `moved_to` bis zur Zielzone (7.4). */
export function resolveZone(ws: Draft, id: string): Zone | undefined {
  let zone = ws.get("zones", id);
  for (let hops = 0; zone && zone.deleted_at !== null && zone.moved_to && hops < MAX_HOPS; hops += 1) {
    zone = ws.get("zones", zone.moved_to);
  }
  return zone && zone.deleted_at === null ? zone : undefined;
}

/** Das nicht zusammengeführte Produkt, dem ein Barcode gehört. */
export function barcodeOwner(ws: Draft, barcode: string): Product | undefined {
  for (const product of ws.rows("products")) {
    if (product.deleted_at === null && product.barcodes.includes(barcode)) {
      return product;
    }
  }
  return undefined;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/** Führt `source` in `target` zusammen (7.3). */
function mergeProducts(ws: Draft, source: Product, target: Product, at: string): void {
  for (const pkg of ws.rows("packages")) {
    if (pkg.product_id === source.id) {
      ws.put("packages", { ...pkg, product_id: target.id, updated_at: at });
    }
  }
  ws.put("products", {
    ...target,
    barcodes: sortedUnique([...target.barcodes, ...source.barcodes]),
    name: target.name === "" ? source.name : target.name,
    brand: target.brand === "" ? source.brand : target.brand,
    quantity: target.quantity === "" ? source.quantity : target.quantity,
    warn_days: target.warn_days ?? source.warn_days,
    image: target.image ?? source.image,
    updated_at: at,
  });
  ws.put("products", { ...source, barcodes: [], deleted_at: at, merged_into: target.id, updated_at: at });
}

// ---------------------------------------------------------------------------------- Produkte

function productCreate(ws: Draft, cmd: CmdProductCreate, ctx: ApplyContext): ApplyOutcome {
  if (ws.get("products", cmd.product_id)) {
    return rejected("id_conflict");
  }
  const wanted = sortedUnique(cmd.barcodes ?? []);
  // Barcodes, die schon einem anderen Produkt gehören, bleiben dort.
  let target: Product | undefined;
  const free: string[] = [];
  for (const barcode of cmd.barcodes ?? []) {
    const owner = barcodeOwner(ws, barcode);
    if (owner) {
      target ??= owner;
    } else if (!free.includes(barcode)) {
      free.push(barcode);
    }
  }
  const product: Product = {
    id: cmd.product_id,
    name: cmd.name ?? "",
    brand: cmd.brand ?? "",
    quantity: cmd.quantity ?? "",
    image: null,
    warn_days: cmd.warn_days ?? null,
    lookup: wanted.some((barcode) => willLookUp(barcode, ctx.lookup_enabled)) ? "pending" : "none",
    barcodes: free.sort(),
    created_at: ctx.at,
    updated_at: ctx.at,
    deleted_at: null,
    merged_into: null,
  };
  ws.put("products", product);
  if (target) {
    // Das neue Produkt entsteht sofort als Zusammenführung in den Besitzer des ersten betroffenen Barcodes.
    mergeProducts(ws, { ...product, lookup: "none" }, ws.get("products", target.id) ?? target, ctx.at);
  }
  return APPLIED;
}

function productUpdate(ws: Draft, cmd: CmdProductUpdate, ctx: ApplyContext): ApplyOutcome {
  const product = resolveProduct(ws, cmd.product_id);
  if (!product) {
    return rejected("not_found");
  }
  const changes = cmd.changes;
  ws.put("products", {
    ...product,
    name: changes.name === undefined ? product.name : changes.name,
    brand: changes.brand === undefined ? product.brand : changes.brand,
    quantity: changes.quantity === undefined ? product.quantity : changes.quantity,
    warn_days: "warn_days" in changes ? (changes.warn_days ?? null) : product.warn_days,
    updated_at: ctx.at,
  });
  return APPLIED;
}

function productAddBarcode(ws: Draft, cmd: CmdProductAddBarcode, ctx: ApplyContext): ApplyOutcome {
  const product = resolveProduct(ws, cmd.product_id);
  if (!product) {
    return rejected("not_found");
  }
  const owner = barcodeOwner(ws, cmd.barcode);
  if (owner?.id === product.id) {
    return APPLIED;
  }
  if (owner) {
    // Der bisherige Besitzer geht im genannten Produkt auf.
    mergeProducts(ws, owner, product, ctx.at);
    return APPLIED;
  }
  ws.put("products", { ...product, barcodes: sortedUnique([...product.barcodes, cmd.barcode]), updated_at: ctx.at });
  return APPLIED;
}

function productRemoveBarcode(ws: Draft, cmd: CmdProductRemoveBarcode, ctx: ApplyContext): ApplyOutcome {
  const product = resolveProduct(ws, cmd.product_id);
  if (!product) {
    return rejected("not_found");
  }
  if (product.barcodes.includes(cmd.barcode)) {
    ws.put("products", { ...product, barcodes: product.barcodes.filter((code) => code !== cmd.barcode), updated_at: ctx.at });
  }
  return APPLIED;
}

function productMerge(ws: Draft, cmd: CmdProductMerge, ctx: ApplyContext): ApplyOutcome {
  const source = resolveProduct(ws, cmd.source_id);
  const target = resolveProduct(ws, cmd.target_id);
  if (!source || !target) {
    return rejected("not_found");
  }
  if (source.id !== target.id) {
    mergeProducts(ws, source, target, ctx.at);
  }
  return APPLIED;
}

// ---------------------------------------------------------------------------------- Packungen

function packageCreate(ws: Draft, cmd: CmdPackageCreate, ctx: ApplyContext): ApplyOutcome {
  if (ws.get("packages", cmd.package_id)) {
    return rejected("id_conflict");
  }
  const product = resolveProduct(ws, cmd.product_id);
  const zone = resolveZone(ws, cmd.zone_id);
  if (!product || !zone) {
    return rejected("not_found");
  }
  ws.put("packages", {
    id: cmd.package_id,
    product_id: product.id,
    zone_id: zone.id,
    best_before: cmd.best_before ?? null,
    created_at: ctx.at,
    updated_at: ctx.at,
    removed_at: null,
    removal_reason: null,
    displaced: null,
  });
  return APPLIED;
}

function displacedChanges(cmd: CmdPackageUpdate): DisplacedChange[] {
  const result: DisplacedChange[] = [];
  const changes = cmd.changes;
  if ("best_before" in changes) {
    result.push({ field: "best_before", value: changes.best_before ?? null });
  }
  if (changes.zone_id !== undefined) {
    result.push({ field: "zone_id", value: changes.zone_id });
  }
  if (changes.product_id !== undefined) {
    result.push({ field: "product_id", value: changes.product_id });
  }
  return result;
}

function packageUpdate(ws: Draft, cmd: CmdPackageUpdate, ctx: ApplyContext): ApplyOutcome {
  const pkg = ws.get("packages", cmd.package_id);
  if (!pkg) {
    return rejected("not_found");
  }
  if (pkg.removed_at !== null) {
    // Löschen gewinnt (7.2): Die Bearbeitung wird aufgehoben, je Feld die spätere.
    const fresh = displacedChanges(cmd);
    const kept = (pkg.displaced?.changes ?? []).filter((old) => !fresh.some((change) => change.field === old.field));
    ws.put("packages", { ...pkg, displaced: { at: ctx.at, changes: [...kept, ...fresh] } });
    return DISPLACED;
  }
  const changes = cmd.changes;
  const zone = changes.zone_id === undefined ? undefined : resolveZone(ws, changes.zone_id);
  const product = changes.product_id === undefined ? undefined : resolveProduct(ws, changes.product_id);
  if ((changes.zone_id !== undefined && !zone) || (changes.product_id !== undefined && !product)) {
    return rejected("not_found");
  }
  ws.put("packages", {
    ...pkg,
    best_before: "best_before" in changes ? (changes.best_before ?? null) : pkg.best_before,
    zone_id: zone?.id ?? pkg.zone_id,
    product_id: product?.id ?? pkg.product_id,
    updated_at: ctx.at,
  });
  return APPLIED;
}

function packageRemove(ws: Draft, cmd: CmdPackageRemove, ctx: ApplyContext): ApplyOutcome {
  const pkg = ws.get("packages", cmd.package_id);
  if (!pkg) {
    return rejected("not_found");
  }
  if (pkg.removed_at !== null) {
    // Schon entnommen: Es ändert sich nur der Grund.
    if (pkg.removal_reason !== cmd.reason) {
      ws.put("packages", { ...pkg, removal_reason: cmd.reason, updated_at: ctx.at });
    }
    return APPLIED;
  }
  ws.put("packages", { ...pkg, removed_at: ctx.at, removal_reason: cmd.reason, updated_at: ctx.at });
  return APPLIED;
}

function packageRestore(ws: Draft, cmd: CmdPackageRestore, ctx: ApplyContext): ApplyOutcome {
  const pkg = ws.get("packages", cmd.package_id);
  if (!pkg) {
    return rejected("not_found");
  }
  if (pkg.removed_at === null) {
    return APPLIED;
  }
  const restored: Package = { ...pkg, removed_at: null, removal_reason: null, displaced: null, updated_at: ctx.at };
  if (cmd.apply_displaced && pkg.displaced) {
    for (const change of pkg.displaced.changes) {
      if (change.field === "best_before") {
        restored.best_before = change.value;
      } else if (change.field === "zone_id" && change.value !== null) {
        restored.zone_id = resolveZone(ws, change.value)?.id ?? restored.zone_id;
      } else if (change.field === "product_id" && change.value !== null) {
        restored.product_id = resolveProduct(ws, change.value)?.id ?? restored.product_id;
      }
    }
  }
  ws.put("packages", restored);
  return APPLIED;
}

// ---------------------------------------------------------------------------------- Zonen, Einstellungen

function zoneCreate(ws: Draft, cmd: CmdZoneCreate, ctx: ApplyContext): ApplyOutcome {
  if (ws.get("zones", cmd.zone_id)) {
    return rejected("id_conflict");
  }
  ws.put("zones", {
    id: cmd.zone_id,
    name: cmd.name,
    icon: cmd.icon ?? "box",
    color: cmd.color ?? null,
    sort: cmd.sort ?? 0,
    printer_id: cmd.printer_id ?? null,
    created_at: ctx.at,
    updated_at: ctx.at,
    deleted_at: null,
    moved_to: null,
  });
  return APPLIED;
}

function zoneUpdate(ws: Draft, cmd: CmdZoneUpdate, ctx: ApplyContext): ApplyOutcome {
  const zone = ws.get("zones", cmd.zone_id);
  if (!zone || zone.deleted_at !== null) {
    return rejected("not_found");
  }
  const changes = cmd.changes;
  ws.put("zones", {
    ...zone,
    name: changes.name === undefined ? zone.name : changes.name,
    icon: changes.icon === undefined ? zone.icon : changes.icon,
    color: "color" in changes ? (changes.color ?? null) : zone.color,
    sort: changes.sort === undefined ? zone.sort : changes.sort,
    printer_id: "printer_id" in changes ? (changes.printer_id ?? null) : zone.printer_id,
    updated_at: ctx.at,
  });
  return APPLIED;
}

function zoneDelete(ws: Draft, cmd: CmdZoneDelete, ctx: ApplyContext): ApplyOutcome {
  const zone = ws.get("zones", cmd.zone_id);
  if (!zone) {
    return rejected("not_found");
  }
  if (zone.deleted_at !== null) {
    return APPLIED;
  }
  if (ws.rows("zones").filter((candidate) => candidate.deleted_at === null).length <= 1) {
    return rejected("last_zone");
  }
  if (cmd.move_to === cmd.zone_id) {
    return rejected("invalid");
  }
  const target = resolveZone(ws, cmd.move_to);
  if (!target) {
    return rejected("not_found");
  }
  if (target.id === zone.id) {
    return rejected("invalid");
  }
  for (const pkg of ws.rows("packages")) {
    if (pkg.zone_id === zone.id) {
      ws.put("packages", { ...pkg, zone_id: target.id, updated_at: ctx.at });
    }
  }
  ws.put("zones", { ...zone, deleted_at: ctx.at, moved_to: target.id, updated_at: ctx.at });
  const settings = ws.settings;
  if (settings && settings.primary_zone_id === zone.id) {
    ws.settings = { ...settings, primary_zone_id: target.id, updated_at: ctx.at };
  }
  return APPLIED;
}

function settingsUpdate(ws: Draft, cmd: CmdSettingsUpdate, ctx: ApplyContext): ApplyOutcome {
  const settings = ws.settings;
  if (!settings) {
    // Ohne Einstellungen gibt es nichts zu ändern; der Server hat sie immer.
    return APPLIED;
  }
  const changes = cmd.changes;
  ws.settings = {
    ...settings,
    zone_mode: changes.zone_mode === undefined ? settings.zone_mode : changes.zone_mode,
    primary_zone_id: "primary_zone_id" in changes ? (changes.primary_zone_id ?? null) : settings.primary_zone_id,
    warn_days: changes.warn_days === undefined ? settings.warn_days : changes.warn_days,
    trash_retention_days: changes.trash_retention_days === undefined ? settings.trash_retention_days : changes.trash_retention_days,
    default_printer_id: "default_printer_id" in changes ? (changes.default_printer_id ?? null) : settings.default_printer_id,
    updated_at: ctx.at,
  };
  return APPLIED;
}

// ---------------------------------------------------------------------------------- Drucker, Etiketten

function printerCreate(ws: Draft, cmd: CmdPrinterCreate, ctx: ApplyContext): ApplyOutcome {
  if (ws.get("printers", cmd.printer_id)) {
    return rejected("id_conflict");
  }
  const server = cmd.server ?? null;
  const direct = cmd.direct ?? null;
  if ((cmd.connection === "server" && (!server || direct)) || (cmd.connection === "direct" && (!direct || server))) {
    return rejected("invalid");
  }
  ws.put("printers", {
    id: cmd.printer_id,
    name: cmd.name,
    connection: cmd.connection,
    server,
    direct,
    created_at: ctx.at,
    updated_at: ctx.at,
    deleted_at: null,
  });
  return APPLIED;
}

function printerUpdate(ws: Draft, cmd: CmdPrinterUpdate, ctx: ApplyContext): ApplyOutcome {
  const printer = ws.get("printers", cmd.printer_id);
  if (!printer || printer.deleted_at !== null) {
    return rejected("not_found");
  }
  const changes = cmd.changes;
  if ((changes.server !== undefined && printer.connection !== "server") || (changes.direct !== undefined && printer.connection !== "direct")) {
    return rejected("invalid");
  }
  ws.put("printers", {
    ...printer,
    name: changes.name === undefined ? printer.name : changes.name,
    server: changes.server === undefined ? printer.server : changes.server,
    direct: changes.direct === undefined ? printer.direct : changes.direct,
    updated_at: ctx.at,
  });
  return APPLIED;
}

function printerDelete(ws: Draft, cmd: CmdPrinterDelete, ctx: ApplyContext): ApplyOutcome {
  const printer = ws.get("printers", cmd.printer_id);
  if (!printer) {
    return rejected("not_found");
  }
  if (printer.deleted_at !== null) {
    return APPLIED;
  }
  ws.put("printers", { ...printer, deleted_at: ctx.at, updated_at: ctx.at });
  for (const zone of ws.rows("zones")) {
    if (zone.printer_id === printer.id) {
      ws.put("zones", { ...zone, printer_id: null, updated_at: ctx.at });
    }
  }
  const settings = ws.settings;
  if (settings && settings.default_printer_id === printer.id) {
    ws.settings = { ...settings, default_printer_id: null, updated_at: ctx.at };
  }
  return APPLIED;
}

function printerReport(ws: Draft, cmd: CmdPrinterReport, ctx: ApplyContext): ApplyOutcome {
  if (!ws.get("printers", cmd.printer_id)) {
    return rejected("not_found");
  }
  const known = ws.get("printer_status", cmd.printer_id);
  if (ctx.authoritative && known && known.observed_at > ctx.at) {
    return APPLIED;
  }
  ws.put("printer_status", {
    printer_id: cmd.printer_id,
    observed_at: ctx.at,
    boot_id: cmd.boot_id ?? null,
    status: cmd.status ?? null,
    host: cmd.host ?? null,
  });
  return APPLIED;
}

function printRequest(ws: Draft, cmd: CmdPrintRequest, ctx: ApplyContext): ApplyOutcome {
  if (ws.get("print_jobs", cmd.job_id)) {
    return rejected("id_conflict");
  }
  const packageId = cmd.package_id ?? null;
  const zoneId = cmd.zone_id ?? null;
  if ((cmd.kind === "package" && (packageId === null || zoneId !== null)) || (cmd.kind === "zone" && (zoneId === null || packageId !== null))) {
    return rejected("invalid");
  }
  if (packageId !== null && !ws.get("packages", packageId)) {
    return rejected("not_found");
  }
  if (zoneId !== null && !ws.get("zones", zoneId)) {
    return rejected("not_found");
  }
  ws.put("print_jobs", {
    id: cmd.job_id,
    kind: cmd.kind,
    package_id: packageId,
    zone_id: zoneId,
    printer_id: cmd.printer_id ?? null,
    state: "pending",
    error: null,
    boot_id: null,
    device_id: ctx.device_id,
    created_at: ctx.at,
    updated_at: ctx.at,
  });
  return APPLIED;
}

function printReport(ws: Draft, cmd: CmdPrintReport, ctx: ApplyContext): ApplyOutcome {
  const job = ws.get("print_jobs", cmd.job_id);
  if (!job) {
    return rejected("not_found");
  }
  if (ctx.authoritative && job.updated_at > ctx.at) {
    return APPLIED;
  }
  // Zustand samt Drucker, boot_id und Fehler gelten als ein Feld (7.1): Die Meldung ersetzt
  // alle vier Werte so, wie sie im Befehl stehen; was er nicht nennt, ist null. Wer den
  // Drucker behalten will, schickt ihn mit (so tun es `print.cancel` und `print.resolveUnknown`).
  ws.put("print_jobs", {
    ...job,
    state: cmd.state,
    printer_id: cmd.printer_id ?? null,
    boot_id: cmd.boot_id ?? null,
    error: cmd.error ?? null,
    updated_at: ctx.at,
  });
  return APPLIED;
}

/** Wendet einen Befehl auf den Entwurf an und sagt, was der Server dazu melden würde. */
export function applyCommand(ws: Draft, command: Command, ctx: ApplyContext): ApplyOutcome {
  switch (command.type) {
    case "product.create":
      return productCreate(ws, command, ctx);
    case "product.update":
      return productUpdate(ws, command, ctx);
    case "product.add_barcode":
      return productAddBarcode(ws, command, ctx);
    case "product.remove_barcode":
      return productRemoveBarcode(ws, command, ctx);
    case "product.merge":
      return productMerge(ws, command, ctx);
    case "package.create":
      return packageCreate(ws, command, ctx);
    case "package.update":
      return packageUpdate(ws, command, ctx);
    case "package.remove":
      return packageRemove(ws, command, ctx);
    case "package.restore":
      return packageRestore(ws, command, ctx);
    case "zone.create":
      return zoneCreate(ws, command, ctx);
    case "zone.update":
      return zoneUpdate(ws, command, ctx);
    case "zone.delete":
      return zoneDelete(ws, command, ctx);
    case "settings.update":
      return settingsUpdate(ws, command, ctx);
    case "printer.create":
      return printerCreate(ws, command, ctx);
    case "printer.update":
      return printerUpdate(ws, command, ctx);
    case "printer.delete":
      return printerDelete(ws, command, ctx);
    case "printer.report":
      return printerReport(ws, command, ctx);
    case "print.request":
      return printRequest(ws, command, ctx);
    case "print.report":
      return printReport(ws, command, ctx);
    default:
      // Eine Befehlsart, die diese Version nicht kennt (neuerer Befehl in einer alten Outbox).
      return rejected("invalid");
  }
}

/**
 * Wendet die wartenden Befehle in ihrer Reihenfolge an. Ein einzelner Befehl, der dabei
 * scheitert, hält die übrigen nicht auf: Was die App zeigt, soll immer berechenbar bleiben.
 */
export function replay(ws: Draft, commands: readonly Command[], context: ReplayContext): void {
  for (const command of commands) {
    try {
      applyCommand(ws, command, { at: command.at, device_id: context.device_id, authoritative: false, lookup_enabled: context.lookup_enabled });
    } catch {
      // Ein Befehl mit unerwartetem Inhalt bleibt ohne Wirkung; der Server entscheidet über ihn.
    }
  }
}
