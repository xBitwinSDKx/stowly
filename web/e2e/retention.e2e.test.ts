/**
 * Aufbewahrung (docs/sync-protokoll.md, Abschnitte 6.4 und 9.3): Was lange entnommen oder
 * lange erledigt ist, fehlt in einem vollständigen Abzug. Ein Gerät mit altem Stand bekommt
 * es trotzdem geliefert und verwirft es selbst. Eine längere Aufbewahrung holt es zurück.
 *
 * „Vor zwei Tagen“ heißt hier: Die Uhr des Geräts stand beim Handeln zwei Tage zurück, die
 * Befehle sind beim Abgleich also zwei Tage alt. Das muss ein Gerät sein, das seither nichts
 * anderes gesendet hat: Die wirksamen Zeitpunkte eines Geräts laufen nie rückwärts (Abschnitt 4).
 */
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { ID_POOL_TARGET } from "@/contract";

import { firstZone, removed, stockedOf } from "./support/data";
import { DAY, disposeDevices, HOUR, signedIn, value, type Device } from "./support/device";
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

function knownPackages(device: Device): string[] {
  return [...value(device.core.data.packages), ...value(device.core.data.removedPackages)].map((pkg) => pkg.id);
}

it("verwirft lange Entnommenes und holt es zurück, wenn die Aufbewahrung länger wird", async () => {
  const kitchen = await signedIn(server.url, "Küche");
  const cellar = await signedIn(server.url, "Keller");
  const raw = await RawClient.login(server.url);

  const stored = await kitchen.core.stock.store({ product: { kind: "new", name: "Sardinen A1" }, zone_id: firstZone(kitchen).id, best_before: null, count: 2, labels: false });
  const [old, fresh] = stored.packages.map((pkg) => pkg.id) as [string, string];
  await kitchen.core.settings.update({ trash_retention_days: 1 });
  await kitchen.sync();
  // Der Keller kennt beide Packungen und die kurze Aufbewahrung; danach gleicht er lange nicht ab.
  await cellar.sync();
  expect(value(cellar.core.data.settings).trash_retention_days).toBe(1);

  // Ein drittes Gerät hat die eine Packung vor zwei Tagen entnommen und gleicht erst jetzt ab.
  const guest = await signedIn(server.url, "Gast");
  await guest.ago(2 * DAY, () => guest.core.stock.remove([old], "consumed"));
  await guest.sync();

  // Kein Abzug: Der Server liefert die Packung mit, obwohl sie jenseits der Aufbewahrung liegt …
  const answer = guest.net.lastSync.response;
  expect(answer?.reset).toBe(false);
  const delivered = answer?.changes.packages.find((pkg) => pkg.id === old);
  expect(delivered?.removal_reason).toBe("consumed");
  const age = Date.now() - Date.parse(delivered?.removed_at ?? "");
  expect(age).toBeGreaterThan(2 * DAY - HOUR);
  expect(age).toBeLessThan(2 * DAY + HOUR);
  // … und das Gerät verwirft sie beim Empfang.
  expect(knownPackages(guest)).not.toContain(old);
  expect(knownPackages(guest)).toContain(fresh);

  // Der Keller hat einen alten Stand: Auch er bekommt sie geliefert und verwirft sie.
  await cellar.sync();
  expect(cellar.net.lastSync.response?.changes.packages.map((pkg) => pkg.id)).toContain(old);
  expect(stockedOf(cellar, stored.product.id)).toEqual([fresh]);
  expect(knownPackages(cellar)).not.toContain(old);
  await expectSameAsServer(cellar, raw);

  // Auch nach dem Neuladen der App taucht sie nicht wieder auf.
  await cellar.reload();
  expect(knownPackages(cellar)).not.toContain(old);

  // Ein vollständiger Abzug lässt sie weg.
  const late = await signedIn(server.url, "Später");
  const first = late.net.syncs[0]?.response;
  expect(first?.reset).toBe(true);
  const shipped = first?.changes.packages.map((pkg) => pkg.id) ?? [];
  expect(shipped).toContain(fresh);
  expect(shipped).not.toContain(old);

  // Die Küche verlängert die Aufbewahrung: Sie holt den Bestand mit demselben Aufruf vollständig neu.
  await kitchen.sync();
  expect(knownPackages(kitchen)).not.toContain(old);
  await kitchen.core.settings.update({ trash_retention_days: 30 });
  let from = kitchen.net.syncs.length;
  await kitchen.sync();
  const exchange = kitchen.net.syncs[from];
  expect(exchange?.request).toMatchObject({ dataset_id: null, cursor: 0, id_pool: { have: 0 } });
  expect(exchange?.request.commands).toHaveLength(1);
  expect(exchange?.response?.reset).toBe(true);
  expect(exchange?.response?.id_pool.grant).toHaveLength(ID_POOL_TARGET);
  expect(kitchen.net.syncs).toHaveLength(from + 1);
  expect(removed(kitchen, old).removal_reason).toBe("consumed");
  await expectSameAsServer(kitchen, raw);

  // Der Keller erfährt von der längeren Aufbewahrung durch die Antwort und holt im selben Abgleich neu.
  from = cellar.net.syncs.length;
  await cellar.sync();
  const rounds = cellar.net.syncs.slice(from);
  expect(rounds.map((round) => [round.request.dataset_id === null, round.response?.reset])).toEqual([
    [false, false],
    [true, true],
  ]);
  expect(removed(cellar, old).removal_reason).toBe("consumed");
  await expectSameAsServer(cellar, raw);
});

it("verwirft lange erledigte Etiketten nach derselben Regel", async () => {
  const kitchen = await signedIn(server.url, "Küche");
  const raw = await RawClient.login(server.url);
  const zone = firstZone(kitchen);
  const printer = await kitchen.core.printers.create({ name: "Brother A2", connection: "server", server: { driver: "image", model: null, address: null, media: "62x29" } });
  const open = await kitchen.core.stock.store({ product: { kind: "new", name: "Thunfisch A2" }, zone_id: zone.id, best_before: null, count: 1, labels: true });
  const openJob = open.print_jobs[0]?.id ?? "";
  await kitchen.sync();

  // Ein Gerät hat vor 31 Tagen eingelagert und das Etikett gleich wieder verworfen; es gleicht erst jetzt ab.
  const guest = await signedIn(server.url, "Gast");
  const oldJob = await guest.ago(31 * DAY, async () => {
    const stored = await guest.core.stock.store({ product: { kind: "existing", product_id: open.product.id }, zone_id: zone.id, best_before: null, count: 1, labels: true });
    const job = stored.print_jobs[0]?.id ?? "";
    await guest.core.print.cancel(job);
    return job;
  });
  await guest.sync();
  expect(guest.net.lastSync.response?.changes.print_jobs.find((job) => job.id === oldJob)).toMatchObject({ state: "cancelled" });
  expect(value(guest.core.data.printJobs).map((job) => job.id)).not.toContain(oldJob);

  // Die Küche hat einen alten Stand: geliefert und verworfen. Das offene Etikett bleibt.
  await kitchen.sync();
  expect(kitchen.net.lastSync.response?.changes.print_jobs.map((job) => job.id)).toContain(oldJob);
  const shown = value(kitchen.core.data.printJobs).map((job) => job.id);
  expect(shown).toContain(openJob);
  expect(shown).not.toContain(oldJob);
  await expectSameAsServer(kitchen, raw);

  // Ein vollständiger Abzug lässt es weg.
  const late = await signedIn(server.url, "Später");
  const shipped = late.net.syncs[0]?.response?.changes.print_jobs.map((job) => job.id) ?? [];
  expect(shipped).toContain(openJob);
  expect(shipped).not.toContain(oldJob);

  await kitchen.core.printers.remove(printer.id);
  await kitchen.sync();
});
