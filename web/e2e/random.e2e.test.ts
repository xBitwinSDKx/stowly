/**
 * Zufallsfolgen: Drei Geräte mit verschieden gehenden Uhren tun durcheinander, was die
 * Oberfläche zulässt, gleichen zu zufälligen Zeitpunkten ab, verlieren Antworten, sind
 * zeitweise ohne Netz und laden die App neu.
 *
 * Geprüft wird nach jedem gelungenen Abgleich ohne Rest in der Outbox: Das Gerät zeigt genau
 * das, was ein frischer vollständiger Abzug des Servers enthält. Am Ende gilt das für alle.
 * Kein Befehl darf mit `internal` enden; `invalid` ist nur bei `zone.delete` erlaubt (zwei
 * Geräte löschen über Kreuz ineinander).
 *
 * Die Startwerte stehen fest. Zum Suchen nach Fehlern: STOWLY_E2E_SEEDS=1,2,3 oder =1-200.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { CoreError, type Package, type RemovalReason } from "@/contract";

import { freshBarcode } from "./support/data";
import { DAY, Device, disposeDevices, HOUR, value } from "./support/device";
import { expectSameAsServer, RawClient } from "./support/raw";
import { startServer, type ServerHandle } from "./support/server";

const STEPS = 220;
const DEFAULT_SEEDS = [11, 23, 42, 77, 1234, 98765];

function seeds(): number[] {
  const wanted = process.env.STOWLY_E2E_SEEDS?.trim();
  if (!wanted) {
    return DEFAULT_SEEDS;
  }
  const result: number[] = [];
  for (const part of wanted.split(",")) {
    const range = /^(\d+)-(\d+)$/.exec(part.trim());
    if (range) {
      for (let seed = Number(range[1]); seed <= Number(range[2]); seed += 1) {
        result.push(seed);
      }
    } else if (part.trim() !== "") {
      result.push(Number(part));
    }
  }
  return result;
}

/** Kleiner Zufallsgenerator mit festem Startwert (mulberry32). */
function generator(seed: number) {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (max: number): number => Math.floor(next() * max),
    chance: (probability: number): boolean => next() < probability,
    pick<T>(items: readonly T[]): T | undefined {
      return items.length === 0 ? undefined : items[Math.floor(next() * items.length)];
    },
  };
}

type Random = ReturnType<typeof generator>;

const REASONS: readonly RemovalReason[] = ["consumed", "discarded", "mistake"];
const DATES = ["2026-12-24", "2027-03-31", "2027-10-15", "2028-02-29", null] as const;
const ICONS = ["box", "shelf", "snowflake", "cellar"] as const;
const COLORS = ["blue", "green", "red", null] as const;
/** Fehler, mit denen der Kern eine Eingabe sofort abweist; dann ist schlicht nichts geschehen. */
const LOCAL_REFUSALS = new Set(["not_found", "invalid", "barcode_taken", "last_zone"]);

let server: ServerHandle;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server?.dispose();
});

afterEach(disposeDevices);

interface Run {
  random: Random;
  devices: Device[];
  raw: RawClient;
  barcodes: string[];
  counter: number;
  log: string[];
  /** Geräte, die gerade kein Netz haben: Schritt, bis zu dem das gilt. */
  offlineUntil: Map<Device, number>;
  statuses: Map<string, number>;
}

/** Wertet alle Ergebnisse aus, die das Gerät seit `from` bekommen hat. */
function account(run: Run, device: Device, from: number): void {
  for (const exchange of device.net.syncs.slice(from)) {
    const commands = new Map(exchange.request.commands.map((command) => [command.id, command]));
    for (const result of exchange.response?.results ?? []) {
      const type = commands.get(result.id)?.type ?? "?";
      const key = result.status === "rejected" ? `rejected/${result.code}` : result.status;
      run.statuses.set(key, (run.statuses.get(key) ?? 0) + 1);
      if (result.code === "internal" || (result.code === "invalid" && type !== "zone.delete")) {
        throw new Error(`${device.name}: ${type} endete mit ${result.code}: ${result.message}`);
      }
    }
  }
}

async function syncAndCheck(run: Run, device: Device): Promise<void> {
  const from = device.net.syncs.length;
  const status = await device.trySync();
  account(run, device, from);
  if (status.last_error !== null) {
    if (status.last_error.code !== "offline") {
      throw new Error(`${device.name}: Abgleich gescheitert mit ${status.last_error.code}: ${status.last_error.message}`);
    }
    return;
  }
  if (status.pending === 0) {
    await expectSameAsServer(device, run.raw);
  }
}

function anyPackage(run: Run, device: Device): Package | undefined {
  const stock = value(device.core.data.packages);
  const gone = value(device.core.data.removedPackages);
  return run.random.chance(0.75) ? (run.random.pick(stock) ?? run.random.pick(gone)) : (run.random.pick(gone) ?? run.random.pick(stock));
}

/** Ein zufälliger Schritt eines Geräts. Liefert, was geschah (für das Protokoll bei einem Fehler). */
async function step(run: Run, device: Device, index: number): Promise<string> {
  const { random } = run;
  const core = device.core;
  const zones = value(core.data.zones);
  const products = value(core.data.products);
  const stock = value(core.data.packages);
  const gone = value(core.data.removedPackages);
  const printers = value(core.data.printers);
  const jobs = value(core.data.printJobs);
  const zone = random.pick(zones);
  const product = random.pick(products);
  run.counter += 1;
  const n = run.counter;

  const offline = (run.offlineUntil.get(device) ?? -1) >= index;
  device.net.online = !offline;

  const roll = random.int(100);
  if (roll < 14) {
    if (random.chance(0.12)) {
      device.net.loseSyncResponses = 1;
    }
    await syncAndCheck(run, device);
    device.net.loseSyncResponses = 0;
    return "sync";
  }
  if (roll < 16) {
    const other = random.pick(run.devices.filter((candidate) => candidate !== device));
    if (other) {
      other.net.online = true;
      const from = [device.net.syncs.length, other.net.syncs.length] as const;
      await Promise.all([device.trySync(), other.trySync()]);
      account(run, device, from[0]);
      account(run, other, from[1]);
    }
    return "zwei Geräte gleichen gleichzeitig ab";
  }
  if (roll < 18) {
    run.offlineUntil.set(device, index + 1 + random.int(12));
    return "Netz weg";
  }
  if (roll < 20) {
    await device.reload();
    return "App neu geladen";
  }
  if (roll < 30 && zone) {
    const barcode = random.chance(0.4) ? random.pick(run.barcodes) : undefined;
    const taken = barcode ? await core.data.findProductByBarcode(barcode) : undefined;
    await core.stock.store({
      product: taken ? { kind: "existing", product_id: taken.id } : { kind: "new", name: `Produkt ${n}`, brand: random.chance(0.5) ? "Marke" : "", barcodes: barcode ? [barcode] : [] },
      zone_id: zone.id,
      best_before: random.pick(DATES) ?? null,
      count: 1 + random.int(3),
    });
    return "einlagern (neu)";
  }
  if (roll < 37 && zone) {
    await core.stock.store({ product: { kind: "barcode", barcode: random.pick(run.barcodes) ?? "" }, zone_id: zone.id, best_before: random.pick(DATES) ?? null, count: 1 + random.int(2) });
    return "einlagern (Barcode)";
  }
  if (roll < 42 && zone && product) {
    await core.stock.store({ product: { kind: "existing", product_id: product.id }, zone_id: zone.id, best_before: null, count: 1 });
    return "einlagern (bekannt)";
  }
  if (roll < 52) {
    const target = anyPackage(run, device);
    if (target) {
      await core.stock.remove([target.id], random.pick(REASONS) ?? "consumed");
    }
    return "entnehmen";
  }
  if (roll < 58) {
    const target = random.pick(gone);
    if (target) {
      await core.stock.restore([target.id], { apply_displaced: random.chance(0.5) });
    }
    return "wiederherstellen";
  }
  if (roll < 68) {
    const target = anyPackage(run, device);
    if (target) {
      const changes: { best_before?: string | null; zone_id?: string; product_id?: string } = {};
      if (random.chance(0.6)) {
        changes.best_before = random.pick(DATES) ?? null;
      }
      if (random.chance(0.4) && zone) {
        changes.zone_id = zone.id;
      }
      if (random.chance(0.25) && product) {
        changes.product_id = product.id;
      }
      await core.stock.update([target.id], changes);
    }
    return "Packung bearbeiten";
  }
  if (roll < 73 && product) {
    await core.products.update(product.id, { name: `Umbenannt ${n}`, ...(random.chance(0.5) ? { warn_days: random.chance(0.3) ? null : random.int(60) } : {}) });
    return "Produkt bearbeiten";
  }
  if (roll < 77 && product) {
    const barcode = random.pick(run.barcodes) ?? "";
    try {
      await core.products.addBarcode(product.id, barcode);
    } catch (error) {
      if (error instanceof CoreError && error.code === "barcode_taken" && random.chance(0.6)) {
        // Wie die Oberfläche: nachfragen, dann zusammenführen.
        await core.products.merge(String(error.details.product_id), product.id);
        return "Barcode vergeben: zusammengeführt";
      }
      throw error;
    }
    return "Barcode zuordnen";
  }
  if (roll < 79 && product) {
    const barcode = random.pick(product.barcodes);
    if (barcode) {
      await core.products.removeBarcode(product.id, barcode);
    }
    return "Barcode entfernen";
  }
  if (roll < 81 && product) {
    const other = random.pick(products);
    if (other) {
      await core.products.merge(product.id, other.id);
    }
    return "Produkte zusammenführen";
  }
  if (roll < 84) {
    if (zones.length < 6) {
      await core.zones.create({ name: `Zone ${n}`, icon: random.pick(ICONS) ?? "box", color: random.pick(COLORS) ?? null });
    }
    return "Zone anlegen";
  }
  if (roll < 87 && zone) {
    await core.zones.update(zone.id, { name: `Zone ${n}`, color: random.pick(COLORS) ?? null, ...(random.chance(0.3) ? { printer_id: random.pick(printers)?.id ?? null } : {}) });
    return "Zone bearbeiten";
  }
  if (roll < 89) {
    const order = [...zones].sort(() => random.next() - 0.5).map((entry) => entry.id);
    await core.zones.reorder(order);
    return "Zonen sortieren";
  }
  if (roll < 92 && zone) {
    const target = random.pick(zones.filter((entry) => entry.id !== zone.id));
    if (target) {
      await core.zones.remove(zone.id, target.id);
    }
    return "Zone löschen";
  }
  if (roll < 95) {
    await core.settings.update({
      warn_days: random.int(40),
      ...(random.chance(0.4) ? { zone_mode: random.chance(0.5) ? "equal" : "primary" } : {}),
      ...(random.chance(0.4) ? { primary_zone_id: random.chance(0.2) ? null : (zone?.id ?? null) } : {}),
      ...(random.chance(0.3) ? { trash_retention_days: random.pick([7, 30, 60]) ?? 30 } : {}),
      ...(random.chance(0.2) ? { default_printer_id: random.pick(printers)?.id ?? null } : {}),
    });
    return "Einstellungen";
  }
  if (roll < 97) {
    const printer = random.pick(printers);
    if (!printer || (printers.length < 2 && random.chance(0.6))) {
      await core.printers.create({ name: `Drucker ${n}`, connection: "server", server: { driver: "image", model: null, address: null, media: "62x29" } });
      return "Drucker anlegen";
    }
    if (random.chance(0.5)) {
      await core.printers.update(printer.id, { name: `Drucker ${n}` });
      return "Drucker umbenennen";
    }
    await core.printers.remove(printer.id);
    return "Drucker löschen";
  }
  const job = random.pick(jobs);
  if (job && job.state === "pending" && random.chance(0.5)) {
    await core.print.cancel(job.id);
    return "Etikett verwerfen";
  }
  if (job && job.state === "cancelled") {
    await core.print.retry(job.id);
    return "Etikett neu anfordern";
  }
  const labelled = random.pick(stock);
  if (labelled && printers.length > 0) {
    await core.print.requestPackageLabels([labelled.id]);
    return "Etikett anfordern";
  }
  if (zone && printers.length > 0) {
    await core.print.requestZoneLabel(zone.id);
    return "Zonen-Etikett anfordern";
  }
  return "nichts";
}

describe("Zufallsfolgen über drei Geräte", () => {
  it.each(seeds())("Startwert %i", { timeout: 240_000 }, async (seed) => {
    const random = generator(seed);
    const raw = await RawClient.login(server.url, `Prüfer ${seed}`);
    const devices: Device[] = [];
    // Drei Uhren: richtig, zwei Stunden vor, drei Tage nach. Es zählt nur das Alter der Befehle.
    for (const [name, offset] of [
      ["Küche", 0],
      ["Keller", 2 * HOUR],
      ["Tablet", -3 * DAY],
    ] as const) {
      const device = new Device(server.url, `${name} ${seed}`);
      device.clock.shift(offset);
      await device.login();
      devices.push(device);
    }
    const run: Run = { random, devices, raw, barcodes: Array.from({ length: 5 }, () => freshBarcode()), counter: 0, log: [], offlineUntil: new Map(), statuses: new Map() };

    for (let index = 0; index < STEPS; index += 1) {
      const device = random.pick(devices) as Device;
      let done: string;
      try {
        done = await step(run, device, index);
      } catch (error) {
        if (error instanceof CoreError && LOCAL_REFUSALS.has(error.code)) {
          done = `abgewiesen (${error.code})`;
        } else {
          const recent = run.log.slice(-25).join("\n  ");
          throw new Error(`Startwert ${seed}, Schritt ${index}, ${device.name}: ${String(error instanceof Error ? error.message : error)}\nZuletzt:\n  ${recent}`, { cause: error });
        }
      }
      run.log.push(`${index} ${device.name}: ${done}`);
    }

    // Zur Ruhe kommen: alle wieder am Netz, zweimal reihum abgleichen.
    try {
      for (let pass = 0; pass < 2; pass += 1) {
        for (const device of devices) {
          device.net.online = true;
          device.net.loseSyncResponses = 0;
          const from = device.net.syncs.length;
          await device.sync();
          account(run, device, from);
        }
      }
      for (const device of devices) {
        await expectSameAsServer(device, raw);
      }
    } catch (error) {
      throw new Error(`Startwert ${seed}, am Ende: ${String(error instanceof Error ? error.message : error)}\nZuletzt:\n  ${run.log.slice(-25).join("\n  ")}`, { cause: error });
    }
    // Der Lauf hat wirklich etwas bewegt.
    expect(run.statuses.get("applied") ?? 0).toBeGreaterThan(50);
  });
});
