/**
 * Die Leitung zwischen Gerät und Server: verlorene Antworten, ein Server, der nicht
 * antwortet, ein neuer Datenbestand, eine zurückgespielte Sicherung und das Blättern
 * durch mehr als 5000 Datensätze.
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { ID_POOL_TARGET, isPackageId, MAX_CHANGES_PER_SYNC, MAX_COMMANDS_PER_SYNC, type SyncResponse } from "@/contract";

import { firstZone, stockedOf } from "./support/data";
import { disposeDevices, expectCoreError, signedIn, value } from "./support/device";
import { expectSameAsServer, RawClient } from "./support/raw";
import { startServer, type ServerHandle } from "./support/server";

let server: ServerHandle;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server?.dispose();
});

afterEach(disposeDevices);

async function setup() {
  const kitchen = await signedIn(server.url, "Küche");
  const cellar = await signedIn(server.url, "Keller");
  const raw = await RawClient.login(server.url);
  return { kitchen, cellar, raw };
}

/** Zahl der Datensätze in einer Antwort. */
function recordCount(response: SyncResponse | null | undefined): number {
  if (!response) {
    return 0;
  }
  const changes = response.changes;
  return (
    changes.products.length +
    changes.zones.length +
    changes.packages.length +
    changes.printers.length +
    changes.printer_status.length +
    changes.print_jobs.length +
    changes.label_templates.length +
    (changes.settings ? 1 : 0)
  );
}

describe("Verlorene Antwort", () => {
  it("sendet dieselben Befehle noch einmal; der Server kennt sie und verbucht nichts doppelt", async () => {
    const { kitchen, cellar, raw } = await setup();
    const stored = await kitchen.core.stock.store({ product: { kind: "new", name: "Graupen T1" }, zone_id: firstZone(kitchen).id, best_before: null, count: 2, labels: false });
    const ids = stored.packages.map((pkg) => pkg.id).sort();
    const from = kitchen.net.syncs.length;

    kitchen.net.loseSyncResponses = 1;
    const failed = await kitchen.trySync();
    expect(failed).toMatchObject({ phase: "error", online: false, pending: 3 });
    expect(failed.last_error?.code).toBe("offline");
    // Der Server hat die Befehle trotzdem verbucht.
    const lost = kitchen.net.syncs[from];
    expect(lost?.lost).toBe(true);
    expect(lost?.response?.results.map((result) => [result.status, result.duplicate])).toEqual([
      ["applied", false],
      ["applied", false],
      ["applied", false],
    ]);
    // Für das Gerät ist nichts bestätigt: Die Packungen stehen weiter nur wegen der Outbox da.
    expect(stockedOf(kitchen, stored.product.id)).toEqual(ids);

    // Inzwischen kommt eine weitere Änderung dazu.
    await kitchen.core.stock.update([ids[0] ?? ""], { best_before: "2027-11-11" });
    await kitchen.sync();
    const again = kitchen.net.lastSync;
    expect(again.request.commands.slice(0, 3).map((command) => command.id)).toEqual(lost?.request.commands.map((command) => command.id));
    expect(again.response?.results.map((result) => [result.status, result.duplicate])).toEqual([
      ["applied", true],
      ["applied", true],
      ["applied", true],
      ["applied", false],
    ]);
    expect(kitchen.status).toMatchObject({ phase: "idle", online: true, pending: 0, last_error: null });

    const state = await expectSameAsServer(kitchen, raw);
    expect(state.products.filter((product) => product.name === "Graupen T1")).toHaveLength(1);
    expect(
      state.packages
        .filter((pkg) => pkg.product_id === stored.product.id)
        .map((pkg) => pkg.id)
        .sort(),
    ).toEqual(ids);
    for (const id of ids) {
      const created = (await raw.events({ entity: "package", entity_id: id })).filter((event) => event.type === "package.created");
      expect(created).toHaveLength(1);
    }
    await cellar.sync();
    expect(stockedOf(cellar, stored.product.id)).toEqual(ids);
  });

  it("verbucht auch ein Entnehmen nur einmal, wenn mehrere Antworten verloren gehen", async () => {
    const { kitchen, raw } = await setup();
    const stored = await kitchen.core.stock.store({ product: { kind: "new", name: "Rollgerste T1b" }, zone_id: firstZone(kitchen).id, best_before: null, count: 1, labels: false });
    const id = stored.packages[0]?.id ?? "";
    await kitchen.sync();

    await kitchen.core.stock.remove([id], "consumed");
    kitchen.net.loseSyncResponses = 2;
    expect((await kitchen.trySync()).pending).toBe(1);
    expect((await kitchen.trySync()).pending).toBe(1);
    await kitchen.sync();
    expect(kitchen.net.lastSync.response?.results).toMatchObject([{ status: "applied", duplicate: true }]);

    await expectSameAsServer(kitchen, raw);
    const removals = (await raw.events({ entity: "package", entity_id: id })).filter((event) => event.type === "package.removed");
    expect(removals).toHaveLength(1);
  });
});

describe("Server nicht erreichbar", () => {
  it("lässt Änderungen in der Outbox warten und reicht sie nach dem Neustart des Servers nach", async () => {
    const { kitchen, cellar, raw } = await setup();
    await server.stop();

    const stored = await kitchen.core.stock.store({ product: { kind: "new", name: "Dinkel T2" }, zone_id: firstZone(kitchen).id, best_before: null, count: 1, labels: false });
    const status = await kitchen.trySync();
    expect(status).toMatchObject({ phase: "error", online: false, pending: 2 });
    expect(status.last_error?.code).toBe("offline");
    // Was den Server braucht, scheitert mit „offline“.
    await expectCoreError(kitchen.core.devices.list(), "offline");
    await expectCoreError(kitchen.core.backup.download(), "offline");

    // Die App wird neu geladen: Die Änderung liegt in der lokalen Datenbank.
    await kitchen.reload();
    expect(value(kitchen.core.session.state).status).toBe("signed_in");
    expect(kitchen.status.pending).toBe(2);
    expect(stockedOf(kitchen, stored.product.id)).toHaveLength(1);
    expect((await kitchen.trySync()).online).toBe(false);

    await server.start();
    await kitchen.sync();
    expect(kitchen.status).toMatchObject({ phase: "idle", online: true, pending: 0, last_error: null });
    await cellar.sync();
    expect(stockedOf(cellar, stored.product.id)).toEqual(stockedOf(kitchen, stored.product.id));
    await expectSameAsServer(kitchen, raw);
  });
});

describe("Neuer Datenbestand", () => {
  it("holt nach `--new-dataset` alles neu, sendet die Outbox erneut und bekommt einen vollen ID-Vorrat", async () => {
    const { kitchen, cellar, raw } = await setup();
    const zone = firstZone(kitchen);
    const known = await kitchen.core.stock.store({ product: { kind: "new", name: "Quinoa T3" }, zone_id: zone.id, best_before: null, count: 2, labels: false });
    await kitchen.sync();
    await cellar.sync();
    const oldDataset = kitchen.net.lastSync.response?.dataset_id;

    // Offline entsteht eine weitere Packung.
    const waiting = await kitchen.core.stock.store({ product: { kind: "existing", product_id: known.product.id }, zone_id: zone.id, best_before: null, count: 1, labels: false });

    await server.stop();
    const cli = server.cli(["--new-dataset"]);
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout).toContain("Neue Kennung des Datenbestands");
    await server.start();

    const from = kitchen.net.syncs.length;
    await kitchen.sync();
    const exchange = kitchen.net.syncs[from];
    expect(exchange?.request.dataset_id).toBe(oldDataset);
    expect(exchange?.request.commands).toHaveLength(1);
    expect(exchange?.request.id_pool.have).toBe(ID_POOL_TARGET - 1);
    expect(exchange?.response?.reset).toBe(true);
    expect(exchange?.response?.dataset_id).not.toBe(oldDataset);
    expect(exchange?.response?.results).toMatchObject([{ status: "applied", duplicate: false }]);
    // Ein voller Vorrat, obwohl das Gerät noch fast alle IDs hatte: Die alten verwirft es.
    const pool = exchange?.response?.id_pool.grant ?? [];
    expect(pool).toHaveLength(ID_POOL_TARGET);
    // Der eine Aufruf genügt.
    expect(kitchen.net.syncs).toHaveLength(from + 1);

    const next = await kitchen.core.stock.store({ product: { kind: "existing", product_id: known.product.id }, zone_id: zone.id, best_before: null, count: 1, labels: false });
    expect(next.packages[0]?.id).toBe(pool[0]);
    await kitchen.sync();
    await expectSameAsServer(kitchen, raw);

    await cellar.sync();
    expect(cellar.net.lastSync.response?.reset).toBe(true);
    expect(stockedOf(cellar, known.product.id)).toEqual([...known.packages, ...waiting.packages, ...next.packages].map((pkg) => pkg.id).sort());
    await expectSameAsServer(cellar, raw);
  });

  it("spielt eine Sicherung zurück: Die Geräte holen den älteren Stand vollständig neu", async () => {
    const { kitchen, cellar, raw } = await setup();
    const zone = firstZone(kitchen);
    const before = await kitchen.core.stock.store({ product: { kind: "new", name: "Amaranth T4" }, zone_id: zone.id, best_before: null, count: 1, labels: false });
    await kitchen.sync();
    const { blob } = await kitchen.core.backup.download();

    await kitchen.core.stock.store({ product: { kind: "existing", product_id: before.product.id }, zone_id: zone.id, best_before: null, count: 1, labels: false });
    await kitchen.sync();
    await cellar.sync();
    expect(stockedOf(cellar, before.product.id)).toHaveLength(2);

    // Server anhalten, Datei ersetzen, starten (docs/sync-protokoll.md, Abschnitt 11).
    await server.stop();
    const database = join(server.dataDir, "stowly.sqlite3");
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(database + suffix, { force: true });
    }
    writeFileSync(database, Buffer.from(await blob.arrayBuffer()));
    await server.start();

    await kitchen.sync();
    expect(kitchen.net.lastSync.response?.reset).toBe(true);
    expect(stockedOf(kitchen, before.product.id)).toEqual(before.packages.map((pkg) => pkg.id));
    await expectSameAsServer(kitchen, raw);
    await cellar.sync();
    expect(stockedOf(cellar, before.product.id)).toEqual(before.packages.map((pkg) => pkg.id));
    await expectSameAsServer(cellar, raw);
  });
});

describe("Leerer ID-Vorrat", () => {
  it("vergibt Zufalls-IDs, wenn offline mehr Packungen entstehen, als der Vorrat hergibt", async () => {
    const { kitchen, raw } = await setup();
    const zone = firstZone(kitchen);
    const product = await kitchen.core.products.create({ name: "Gläser T6" });
    const pool = kitchen.net.syncs[0]?.response?.id_pool.grant ?? [];

    const ids: string[] = [];
    for (let batch = 0; batch < 7; batch += 1) {
      const stored = await kitchen.core.stock.store({ product: { kind: "existing", product_id: product.id }, zone_id: zone.id, best_before: null, count: 50, labels: false });
      ids.push(...stored.packages.map((pkg) => pkg.id));
    }
    expect(ids.slice(0, ID_POOL_TARGET)).toEqual(pool);
    const random = ids.slice(ID_POOL_TARGET);
    expect(random).toHaveLength(50);
    expect(random.every(isPackageId)).toBe(true);
    expect(new Set(ids).size).toBe(350);

    const from = kitchen.net.syncs.length;
    await kitchen.sync();
    expect(kitchen.net.syncs[from]?.request.id_pool.have).toBe(0);
    expect(kitchen.net.syncs[from]?.response?.id_pool.grant).toHaveLength(ID_POOL_TARGET);
    expect(kitchen.net.resultsSince(from).filter((result) => result.status !== "applied")).toEqual([]);
    await expectSameAsServer(kitchen, raw);
  });
});

describe("Blättern", () => {
  it("überträgt mehr als 5000 Datensätze in mehreren Seiten: als Änderungsfolge und als Abzug", { timeout: 300_000 }, async () => {
    const { kitchen, cellar, raw } = await setup();
    const zone = await kitchen.core.zones.create({ name: "Großlager T5" });
    const product = await kitchen.core.products.create({ name: "Dosen T5" });
    const TOTAL = 5_100;

    // Immer ein Vorrat voll (300), dann abgleichen: So stammt jede ID aus dem Vorrat.
    const ids: string[] = [];
    while (ids.length < TOTAL) {
      for (let batch = 0; batch < ID_POOL_TARGET / 50; batch += 1) {
        const stored = await kitchen.core.stock.store({ product: { kind: "existing", product_id: product.id }, zone_id: zone.id, best_before: null, count: 50, labels: false });
        ids.push(...stored.packages.map((pkg) => pkg.id));
      }
      await kitchen.sync();
    }
    expect(new Set(ids).size).toBe(TOTAL);

    // 1. Änderungsfolge: Der Keller hat einen alten cursor und bekommt alles in mehreren Seiten.
    let from = cellar.net.syncs.length;
    await cellar.sync();
    let pages = cellar.net.syncs.slice(from);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.map((page) => page.response?.reset)).toEqual(pages.map(() => false));
    expect(pages.map((page) => page.response?.has_more)).toEqual([...pages.slice(1).map(() => true), false]);
    expect(recordCount(pages[0]?.response)).toBe(MAX_CHANGES_PER_SYNC);
    // Folgeseiten: ohne Befehle, mit dem cursor der Seite davor.
    pages.slice(1).forEach((page, index) => {
      expect(page.request.commands).toEqual([]);
      expect(page.request.cursor).toBe(pages[index]?.response?.cursor);
      expect(page.request.dataset_id).toBe(pages[index]?.response?.dataset_id);
    });
    expect(stockedOf(cellar, product.id)).toHaveLength(TOTAL);
    await expectSameAsServer(cellar, raw);

    // 2. Vollständiger Abzug: Ein neues Gerät bekommt denselben Bestand, ebenfalls in Seiten.
    const fresh = await signedIn(server.url, "Neues Gerät");
    pages = fresh.net.syncs;
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.map((page) => page.response?.reset)).toEqual([true, ...pages.slice(1).map(() => false)]);
    expect(pages.at(-1)?.response?.has_more).toBe(false);
    expect(stockedOf(fresh, product.id)).toHaveLength(TOTAL);
    await expectSameAsServer(fresh, raw);

    // 3. Eine große Outbox geht in Portionen von höchstens 500 Befehlen hinaus.
    await kitchen.core.stock.update(ids, { best_before: "2030-01-31" });
    expect(kitchen.status.pending).toBe(TOTAL);
    from = kitchen.net.syncs.length;
    await kitchen.sync();
    const rounds = kitchen.net.syncs.slice(from).filter((exchange) => exchange.request.commands.length > 0);
    expect(rounds).toHaveLength(Math.ceil(TOTAL / MAX_COMMANDS_PER_SYNC));
    expect(Math.max(...rounds.map((round) => round.request.commands.length))).toBe(MAX_COMMANDS_PER_SYNC);
    expect(kitchen.net.resultsSince(from).filter((result) => result.status !== "applied")).toEqual([]);

    // 4. Ein Befehl, der alle Packungen auf einmal verschiebt: Sie teilen sich einen Stand der
    // Änderungsfolge, und eine Seite endet nie mitten darin. Sie wird dafür größer als 5000.
    await kitchen.core.zones.remove(zone.id, firstZone(kitchen).id);
    await kitchen.sync();
    from = cellar.net.syncs.length;
    await cellar.sync();
    pages = cellar.net.syncs.slice(from);
    expect(Math.max(...pages.map((page) => page.response?.changes.packages.length ?? 0))).toBe(TOTAL);
    expect(value(cellar.core.data.packages).filter((pkg) => pkg.product_id === product.id && pkg.best_before === "2030-01-31")).toHaveLength(TOTAL);
    await expectSameAsServer(cellar, raw);
    await expectSameAsServer(kitchen, raw);
  });
});
