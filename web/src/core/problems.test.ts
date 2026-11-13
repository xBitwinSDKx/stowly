/**
 * `sync.problems` (docs/sync-protokoll.md, 9.2, letzter Absatz): begrenzt auf 200 Einträge,
 * und ein „verdrängt" erledigt sich von selbst.
 */
import { afterEach, describe, expect, it } from "vitest";

import { MAX_SYNC_PROBLEMS, type SyncProblem } from "@/contract";

import { DAY, disposeAll, firstZoneId, signedIn, value } from "./testing/harness";

afterEach(disposeAll);

describe("Sync-Probleme", () => {
  it("hebt höchstens 200 auf; die ältesten fallen weg, auch in der Datenbank", async () => {
    const harness = await signedIn();
    const { core, server, clock } = harness;
    const product = await core.products.create({ name: "Senf" });
    await core.sync.now();
    // Der Server kennt das Produkt nicht mehr (ältere Sicherung eingespielt): Jede Änderung wird abgelehnt.
    server.forget("products", product.id);
    const extra = 5;
    for (let index = 0; index < MAX_SYNC_PROBLEMS + extra; index += 1) {
      clock.advance(1_000);
      await core.products.update(product.id, { name: `Senf ${index}` });
    }
    await core.sync.now();

    const names = (list: SyncProblem[]) => list.map((problem) => (problem.command.type === "product.update" ? problem.command.changes.name : null));
    const problems = value(core.sync.problems);
    expect(problems).toHaveLength(MAX_SYNC_PROBLEMS);
    // Neueste zuerst; die fünf ältesten sind weggefallen.
    expect(names(problems)[0]).toBe(`Senf ${MAX_SYNC_PROBLEMS + extra - 1}`);
    expect(names(problems).at(-1)).toBe(`Senf ${extra}`);

    // Auch nach dem Neuladen sind es 200: Die Datenbank hebt nicht mehr auf.
    const reloaded = await harness.another();
    expect(value(reloaded.sync.problems)).toHaveLength(MAX_SYNC_PROBLEMS);
    expect(names(value(reloaded.sync.problems)).at(-1)).toBe(`Senf ${extra}`);

    // Wegklicken geht wie bisher.
    await core.sync.dismissProblem(problems[0]?.id ?? "");
    expect(value(core.sync.problems)).toHaveLength(MAX_SYNC_PROBLEMS - 1);
  });

  it("lässt ein „verdrängt“ verschwinden, sobald die Packung wiederhergestellt ist, mit oder ohne Übernahme", async () => {
    const harness = await signedIn();
    const { core, server } = harness;
    const stored = await core.stock.store({ product: { kind: "new", name: "Reis" }, zone_id: firstZoneId(core), best_before: "2027-01-01", count: 2, labels: false });
    await core.sync.now();
    const [first, second] = stored.packages.map((pkg) => pkg.id) as [string, string];
    // Ein anderes Gerät entnimmt beide; hier ist das noch nicht angekommen.
    server.act({ type: "package.remove", package_id: first, reason: "consumed" }, { type: "package.remove", package_id: second, reason: "consumed" });
    await core.stock.update([first, second], { best_before: "2027-02-02" });
    await core.sync.now();
    expect(value(core.sync.problems).map((problem) => problem.status)).toEqual(["displaced", "displaced"]);
    expect(value(core.data.removedPackages).every((pkg) => pkg.displaced !== null)).toBe(true);

    // Wiederherstellen mit Übernahme: Es gibt nichts mehr zu übernehmen, der Eintrag ist sofort weg.
    await core.stock.restore([first], { apply_displaced: true });
    expect(value(core.sync.problems).map((problem) => (problem.command.type === "package.update" ? problem.command.package_id : ""))).toEqual([second]);
    expect(value(core.data.packages).find((pkg) => pkg.id === first)?.best_before).toBe("2027-02-02");

    // Ohne Übernahme genauso.
    await core.stock.restore([second]);
    expect(value(core.sync.problems)).toEqual([]);
    expect(value(core.data.packages).find((pkg) => pkg.id === second)?.best_before).toBe("2027-01-01");

    await core.sync.now();
    expect(value(core.sync.problems)).toEqual([]);
    const reloaded = await harness.another();
    expect(value(reloaded.sync.problems)).toEqual([]);
  });

  it("lässt ein „verdrängt“ verschwinden, wenn die Packung aus der Lösch-Historie fällt; ein abgelehnter Befehl bleibt", async () => {
    const harness = await signedIn();
    const { core, server, clock } = harness;
    const stored = await core.stock.store({ product: { kind: "new", name: "Reis" }, zone_id: firstZoneId(core), best_before: "2027-01-01", count: 1, labels: false });
    await core.sync.now();
    const packageId = stored.packages[0]?.id ?? "";
    server.act({ type: "package.remove", package_id: packageId, reason: "discarded" });
    await core.stock.update([packageId], { best_before: "2027-02-02" });
    // Dazu eine Ablehnung: Der Server kennt das Produkt nicht mehr.
    server.forget("products", stored.product.id);
    await core.products.update(stored.product.id, { name: "Reis, lang" });
    await core.sync.now();
    expect(value(core.sync.problems).map((problem) => problem.status).sort()).toEqual(["displaced", "rejected"]);

    // Die Aufbewahrungsdauer (30 Tage) läuft ab: Die Packung verschwindet mit dem nächsten Abgleich.
    clock.advance(31 * DAY);
    await core.sync.now();
    expect(value(core.data.removedPackages)).toEqual([]);
    expect(value(core.sync.problems).map((problem) => problem.status)).toEqual(["rejected"]);
  });
});
