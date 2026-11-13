/**
 * Der Abgleich des Kerns gegen die nachgebaute Schnittstelle (docs/sync-protokoll.md,
 * Abschnitte 5, 6, 8 und 9).
 */
import { afterEach, describe, expect, it } from "vitest";

import { MAX_COMMANDS_PER_SYNC, PROTOCOL_VERSION, isPackageId, isTimestamp, isUuid, type Package, type SyncRequest } from "@/contract";

import { FAKE_PASSWORD, validateCommand } from "./testing/fake-api";
import { commandsOf, DAY, disposeAll, expectCoreError, firstZoneId, signedIn, start, value } from "./testing/harness";

afterEach(disposeAll);

const NEW_RICE = { kind: "new", name: "Reis" } as const;

describe("Anmelden", () => {
  it("meldet den geladenen Zustand und war noch nie angemeldet", async () => {
    const { core } = await start();
    expect(value(core.session.state)).toEqual({ status: "signed_out", reason: "never" });
    expect(value(core.sync.status)).toMatchObject({ phase: "idle", pending: 0, last_synced_at: null });
  });

  it("meldet erst nach dem geladenen Zustand etwas anderes als loading", async () => {
    const { another } = await start();
    const { createCore } = await import(".");
    const fresh = createCore({ dbName: "stowly-test-loading", autoSync: false, fetch: async () => new Response("{}") });
    expect(fresh.session.state.get()).toEqual({ status: "loading" });
    expect(fresh.data.zones.get()).toBeUndefined();
    await fresh.ready;
    expect(fresh.session.state.get()).toEqual({ status: "signed_out", reason: "never" });
    expect(fresh.data.zones.get()).toEqual([]);
    fresh.dispose();
    void another;
  });

  it("holt mit der Anmeldung den Bestand: erster Abgleich mit dataset_id null, cursor 0 und reset", async () => {
    const { core, server, network } = await start();
    await core.session.login(FAKE_PASSWORD, "  Handy Küche ");

    expect(value(core.session.state)).toMatchObject({ status: "signed_in", device: { name: "Handy Küche" } });
    const login = network.calls.find((call) => call.path === "/api/auth/login");
    expect(login?.body).toEqual({ password: FAKE_PASSWORD, device_name: "Handy Küche" });

    const first = server.syncRequests[0] as unknown as SyncRequest;
    expect(first).toMatchObject({ protocol: PROTOCOL_VERSION, dataset_id: null, cursor: 0, commands: [], id_pool: { have: 0 } });
    expect(isTimestamp(first.sent_at)).toBe(true);
    // Jeder Aufruf nach der Anmeldung trägt das Token des Geräts.
    const token = server.deviceList[0]?.token;
    expect(network.calls.filter((call) => call.path === "/api/sync").every((call) => call.token === token)).toBe(true);

    // Solange das Gerät angemeldet ist, gibt es mindestens eine Zone und die Einstellungen.
    expect(value(core.data.zones).map((zone) => zone.name)).toEqual(["Vorrat"]);
    expect(value(core.data.settings)).toMatchObject({ zone_mode: "primary", warn_days: 14, trash_retention_days: 30 });
    expect(value(core.sync.status)).toMatchObject({ online: true, phase: "idle", pending: 0, last_error: null, server_version: "0.0.0-fake" });
    expect(value(core.sync.status).last_synced_at).not.toBeNull();
  });

  it("gibt die Fehler des Servers als CoreError weiter und bleibt abgemeldet", async () => {
    const { core, server, network } = await start();
    await expectCoreError(core.session.login("falsch", "Handy"), "invalid_password");
    await expectCoreError(core.session.login(FAKE_PASSWORD, "  "), "invalid");
    await expectCoreError(core.session.login("", "Handy"), "invalid_password");

    server.configured = false;
    await expectCoreError(core.session.login(FAKE_PASSWORD, "Handy"), "not_configured");
    server.configured = true;

    network.offline = true;
    await expectCoreError(core.session.login(FAKE_PASSWORD, "Handy"), "offline");
    expect(value(core.sync.status).online).toBe(false);
    network.offline = false;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expectCoreError(core.session.login("falsch", "Handy"), "invalid_password");
    }
    const limited = await expectCoreError(core.session.login(FAKE_PASSWORD, "Handy"), "rate_limited");
    expect(limited.details.retry_after_s).toBe(60);
    expect(value(core.session.state)).toEqual({ status: "signed_out", reason: "never" });
  });

  it("bleibt abgemeldet, wenn der erste Abgleich scheitert, und sperrt das eben ausgestellte Token wieder", async () => {
    const { core, server, network } = await start();
    network.beforeRequest = (call) => {
      if (call.path === "/api/sync") {
        network.offline = true;
      }
    };
    await expectCoreError(core.session.login(FAKE_PASSWORD, "Handy"), "offline");
    expect(value(core.session.state)).toEqual({ status: "signed_out", reason: "never" });
    expect(server.deviceList).toHaveLength(1);
    expect(server.deviceList[0]?.revoked_at).toBeNull();

    // Sobald der Server wieder da ist, wird das verwaiste Token gesperrt.
    network.beforeRequest = null;
    network.offline = false;
    await core.sync.now();
    await expect.poll(() => server.deviceList[0]?.revoked_at).not.toBeNull();

    await core.session.login(FAKE_PASSWORD, "Handy");
    expect(value(core.session.state).status).toBe("signed_in");
    expect(server.deviceList).toHaveLength(2);
  });

  it("legt bei einem Doppeltipp auf Anmelden nur ein Gerät an", async () => {
    const { core, server } = await start();
    await Promise.all([core.session.login(FAKE_PASSWORD, "Handy"), core.session.login(FAKE_PASSWORD, "Handy")]);
    expect(server.deviceList).toHaveLength(1);
    expect(value(core.session.state).status).toBe("signed_in");
    // Wer schon angemeldet ist, meldet sich nicht noch einmal an.
    await expectCoreError(core.session.login(FAKE_PASSWORD, "Handy"), "invalid");
    expect(server.deviceList).toHaveLength(1);
  });

  it("scheitert bei verschiedenen Protokollversionen mit protocol_mismatch", async () => {
    const { core, server } = await start();
    server.protocol = PROTOCOL_VERSION + 1;
    const error = await expectCoreError(core.session.login(FAKE_PASSWORD, "Handy"), "protocol_mismatch");
    expect(error.details).toMatchObject({ server: PROTOCOL_VERSION + 1, client: PROTOCOL_VERSION });
    expect(value(core.session.state).status).toBe("signed_out");
  });

  it("bleibt nach dem Neuladen angemeldet und kennt den Bestand ohne Netz", async () => {
    const { core, network, another } = await signedIn();
    await core.zones.create({ name: "Keller" });
    await core.sync.now();
    core.dispose();

    network.offline = true;
    const reloaded = await another();
    expect(value(reloaded.session.state)).toMatchObject({ status: "signed_in", device: { name: "Testgerät" } });
    expect(value(reloaded.data.zones).map((zone) => zone.name)).toEqual(["Vorrat", "Keller"]);
  });
});

describe("Befehle senden", () => {
  it("schreibt lokal sofort und sendet die Befehle in der Reihenfolge ihrer Entstehung", async () => {
    const { core, server } = await signedIn();
    const zone = firstZoneId(core);
    const before = server.syncRequests.length;

    const stored = await core.stock.store({ product: NEW_RICE, zone_id: zone, best_before: "2027-03-25", count: 2, labels: false });
    const [a, b] = stored.packages;
    await core.stock.remove([a?.id ?? ""], "consumed");
    await core.stock.restore([a?.id ?? ""]);
    await core.stock.update([b?.id ?? ""], { best_before: null });

    // Lokal gilt alles sofort, ohne Server.
    expect(server.syncRequests).toHaveLength(before);
    expect(value(core.sync.status).pending).toBe(6);
    expect(value(core.data.packages).map((pkg) => pkg.id).sort()).toEqual([a?.id, b?.id].sort());

    await core.sync.now();
    const sent = commandsOf(server.syncRequests[before]);
    expect(sent.map((command) => command.type)).toEqual(["product.create", "package.create", "package.create", "package.remove", "package.restore", "package.update"]);
    expect(sent.every((command) => isUuid(String(command.id)) && isTimestamp(String(command.at)))).toBe(true);
    expect(new Set(sent.map((command) => command.id)).size).toBe(sent.length);
    // Kein Befehl, den der echte Server als ungültig ablehnen würde.
    expect(sent.map(validateCommand)).toEqual(sent.map(() => null));

    expect(value(core.sync.status)).toMatchObject({ pending: 0, phase: "idle" });
    expect(value(core.sync.problems)).toEqual([]);
    expect(server.data.packages.get(b?.id ?? "")).toMatchObject({ best_before: null, removed_at: null });
    // Danach zeigt die App, was der Server liefert: seine Zeitstempel, nicht die des Geräts.
    expect(value(core.data.packages).find((pkg) => pkg.id === b?.id)).toEqual(server.data.packages.get(b?.id ?? ""));
  });

  it("überlebt das Neuladen: Die Outbox bleibt und wird danach gesendet", async () => {
    const { core, server, network, another } = await signedIn();
    network.offline = true;
    const stored = await core.stock.store({ product: NEW_RICE, zone_id: firstZoneId(core), best_before: null, count: 3, labels: false });
    await core.sync.now();
    expect(value(core.sync.status)).toMatchObject({ online: false, phase: "error", pending: 4, last_error: { code: "offline" } });
    core.dispose();

    const reloaded = await another();
    expect(value(reloaded.sync.status).pending).toBe(4);
    expect(value(reloaded.data.packages).map((pkg) => pkg.id).sort()).toEqual(stored.packages.map((pkg) => pkg.id).sort());

    network.offline = false;
    await reloaded.sync.now();
    expect(value(reloaded.sync.status)).toMatchObject({ online: true, phase: "idle", pending: 0, last_error: null });
    expect(server.data.packages.size).toBe(3);
  });

  it("sendet nach einer verlorenen Antwort dieselben Befehle mit denselben Kennungen erneut", async () => {
    const { core, server, network } = await signedIn();
    const before = server.syncRequests.length;
    const stored = await core.stock.store({ product: NEW_RICE, zone_id: firstZoneId(core), best_before: null, count: 2, labels: false });

    network.dropResponses = 1;
    await core.sync.now();
    // Der Server hat verbucht, das Gerät weiß es nicht: Die Befehle warten weiter.
    expect(server.data.packages.size).toBe(2);
    expect(value(core.sync.status)).toMatchObject({ phase: "error", pending: 3, last_error: { code: "offline" } });

    await core.sync.now();
    const first = commandsOf(server.syncRequests[before]);
    const second = commandsOf(server.syncRequests[before + 1]);
    expect(second).toEqual(first);
    expect(second).toHaveLength(3);
    expect(value(core.sync.status)).toMatchObject({ phase: "idle", pending: 0 });
    // Nichts doppelt: Der Server führt jeden Befehl höchstens einmal aus.
    expect(server.data.packages.size).toBe(2);
    expect(server.data.products.size).toBe(1);
    expect(value(core.sync.problems)).toEqual([]);
    expect(value(core.data.packages).map((pkg) => pkg.id).sort()).toEqual(stored.packages.map((pkg) => pkg.id).sort());
  });

  it("teilt eine große Outbox in Pakete zu höchstens 500 Befehlen", async () => {
    const { core, server, network } = await signedIn();
    network.offline = true;
    const zone = firstZoneId(core);
    const { product } = await core.stock.store({ product: NEW_RICE, zone_id: zone, best_before: null, count: 50, labels: false });
    for (let batch = 0; batch < 11; batch += 1) {
      await core.stock.store({ product: { kind: "existing", product_id: product.id }, zone_id: zone, best_before: null, count: 50, labels: false });
    }
    expect(value(core.sync.status).pending).toBe(601);
    network.offline = false;
    const before = server.syncRequests.length;

    await core.sync.now();
    const sizes = server.syncRequests.slice(before).map((request) => commandsOf(request).length);
    expect(sizes).toEqual([MAX_COMMANDS_PER_SYNC, 101]);
    expect(value(core.sync.status).pending).toBe(0);
    expect(server.data.packages.size).toBe(600);
    expect(value(core.data.packages)).toHaveLength(600);
  });

  it("sammelt offline und sendet später", async () => {
    const { core, server, network } = await signedIn();
    network.offline = true;
    const zone = await core.zones.create({ name: "Keller" });
    const stored = await core.stock.store({ product: { kind: "barcode", barcode: "4006381333931" }, zone_id: zone.id, best_before: "2027-01-31", count: 2 });
    await core.settings.update({ warn_days: 7 });

    await core.sync.now();
    expect(value(core.sync.status)).toMatchObject({ online: false, phase: "error", pending: 5 });
    // Alles ist lokal da, auch ohne Server.
    expect(value(core.data.zones).map((candidate) => candidate.name)).toEqual(["Vorrat", "Keller"]);
    expect(value(core.data.settings).warn_days).toBe(7);
    expect(stored.product).toMatchObject({ name: "", lookup: "pending", barcodes: ["4006381333931"] });
    await expectCoreError(core.devices.list(), "offline");
    await expectCoreError(core.backup.download(), "offline");

    network.offline = false;
    await core.sync.now();
    expect(value(core.sync.status)).toMatchObject({ online: true, phase: "idle", pending: 0, last_error: null });
    expect(server.data.zones.size).toBe(2);
    expect(server.data.settings?.warn_days).toBe(7);
    expect([...server.data.packages.values()].every((pkg) => pkg.zone_id === zone.id && pkg.best_before === "2027-01-31")).toBe(true);
  });

  it("verliert keine Änderung, die während eines laufenden Abgleichs entsteht", async () => {
    const { core, server, network } = await signedIn();
    const zone = firstZoneId(core);
    const first = await core.stock.store({ product: NEW_RICE, zone_id: zone, best_before: null, count: 1, labels: false });
    const before = server.syncRequests.length;

    let during: Package | undefined;
    network.beforeResponse = async (call) => {
      if (call.path !== "/api/sync" || during) {
        return;
      }
      // Der Server hat die erste Anfrage verbucht, die Antwort ist unterwegs: Jetzt kommt Neues dazu.
      const added = await core.stock.store({ product: { kind: "existing", product_id: first.product.id }, zone_id: zone, best_before: "2027-05-01", count: 1, labels: false });
      during = added.packages[0];
      await core.stock.remove([first.packages[0]?.id ?? ""], "discarded");
    };
    await core.sync.now();
    network.beforeResponse = null;

    // Die zweite Runde desselben Laufs hat das Neue nachgereicht.
    const rounds = server.syncRequests.slice(before).map((request) => commandsOf(request).map((command) => command.type));
    expect(rounds).toEqual([
      ["product.create", "package.create"],
      ["package.create", "package.remove"],
    ]);
    expect(value(core.sync.status).pending).toBe(0);
    expect(value(core.data.packages).map((pkg) => pkg.id)).toEqual([during?.id]);
    expect(value(core.data.removedPackages).map((pkg) => [pkg.id, pkg.removal_reason])).toEqual([[first.packages[0]?.id, "discarded"]]);
    expect(server.data.packages.get(during?.id ?? "")?.best_before).toBe("2027-05-01");
  });

  it("zeigt zwischen den Runden den Stand des Servers plus die wartenden Befehle", async () => {
    const { core, server, network } = await signedIn();
    const zone = firstZoneId(core);
    const stored = await core.stock.store({ product: NEW_RICE, zone_id: zone, best_before: "2027-01-01", count: 1, labels: false });
    const id = stored.packages[0]?.id ?? "";
    await core.sync.now();

    // Ein anderes Gerät ändert dieselbe Packung; dieses Gerät ändert sie während des Abgleichs.
    server.act({ type: "package.update", package_id: id, changes: { best_before: "2027-02-02" } });
    let seen: (string | null | undefined)[] = [];
    let done = false;
    network.beforeResponse = async (call) => {
      if (call.path !== "/api/sync" || done) {
        return;
      }
      done = true;
      await core.stock.update([id], { best_before: "2027-03-03" });
    };
    const unsubscribe = core.data.packages.subscribe(() => {
      seen.push(value(core.data.packages).find((pkg) => pkg.id === id)?.best_before);
    });
    await core.sync.now();
    unsubscribe();
    network.beforeResponse = null;

    // Nie sichtbar: der Wert des anderen Geräts allein, solange die eigene Änderung noch wartet.
    expect(seen).not.toContain("2027-02-02");
    expect(value(core.data.packages).find((pkg) => pkg.id === id)?.best_before).toBe("2027-03-03");
    expect(server.data.packages.get(id)?.best_before).toBe("2027-03-03");
    seen = [];
  });
});

describe("Ergebnisse", () => {
  it("zeigt einen abgelehnten Befehl unter den Sync-Problemen, und die lokale Kopie folgt wieder dem Server", async () => {
    const { core, server, network } = await signedIn();
    const zone = firstZoneId(core);
    network.offline = true;
    const mine = await core.stock.store({ product: NEW_RICE, zone_id: zone, best_before: "2027-03-25", count: 1, labels: false });
    const id = mine.packages[0]?.id ?? "";

    // Ein anderes Gerät legt inzwischen eine Packung mit derselben ID an: Wer zuerst kommt, bekommt sie.
    const otherProduct = "20000000-0000-4000-8000-000000000001";
    server.act(
      { type: "product.create", product_id: otherProduct, name: "Nudeln" },
      { type: "package.create", package_id: id, product_id: otherProduct, zone_id: zone, best_before: "2028-01-01" },
    );
    network.offline = false;
    const before = server.syncRequests.length;
    await core.sync.now();

    const problems = value(core.sync.problems);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ status: "rejected", code: "id_conflict", command: { type: "package.create", package_id: id } });
    expect(problems[0]?.id).toBe(commandsOf(server.syncRequests[before]).find((command) => command.type === "package.create")?.id);
    expect(problems[0]?.message).toEqual(expect.any(String));

    // Was nur wegen des abgelehnten Befehls da war, ist weg: Die Packung gehört jetzt dem anderen Produkt.
    const current = value(core.data.packages).find((pkg) => pkg.id === id);
    expect(current).toEqual(server.data.packages.get(id));
    expect(current).toMatchObject({ product_id: otherProduct, best_before: "2028-01-01" });
    expect(value(core.sync.status)).toMatchObject({ pending: 0, phase: "idle" });

    await core.sync.dismissProblem(problems[0]?.id ?? "");
    expect(value(core.sync.problems)).toEqual([]);
  });

  it("nimmt eine abgelehnte Änderung auch dann zurück, wenn der Server dazu keinen Datensatz liefert", async () => {
    const { core, server, network, another } = await signedIn();
    const zone = firstZoneId(core);
    const stored = await core.stock.store({ product: NEW_RICE, zone_id: zone, best_before: "2027-03-25", count: 1, labels: false });
    const id = stored.packages[0]?.id ?? "";
    await core.sync.now();

    // Die Packung verschwindet am Server (z. B. Sicherung eingespielt), ohne dass dieses Gerät es erfährt.
    network.offline = true;
    await core.stock.update([id], { best_before: "2030-12-31" });
    expect(value(core.data.packages)[0]?.best_before).toBe("2030-12-31");
    server.forget("packages", id);
    network.offline = false;
    await core.sync.now();

    expect(value(core.sync.problems)).toMatchObject([{ status: "rejected", code: "not_found", command: { type: "package.update" } }]);
    // Der Server hat nichts geliefert, trotzdem ist die eigene Bearbeitung nicht mehr zu sehen.
    expect(value(core.data.packages)[0]?.best_before).toBe("2027-03-25");

    // Auch nach dem Neuladen bleibt es dabei, und das Problem ist noch da.
    core.dispose();
    const reloaded = await another();
    expect(value(reloaded.data.packages)[0]?.best_before).toBe("2027-03-25");
    expect(value(reloaded.sync.problems)).toHaveLength(1);
  });

  it("meldet eine Bearbeitung, die eine entnommene Packung traf, als verdrängt", async () => {
    const { core, server, network } = await signedIn();
    const zone = firstZoneId(core);
    const stored = await core.stock.store({ product: NEW_RICE, zone_id: zone, best_before: "2027-03-25", count: 1, labels: false });
    const id = stored.packages[0]?.id ?? "";
    await core.sync.now();

    // Ein anderes Gerät entnimmt die Packung; dieses bearbeitet sie offline.
    server.act({ type: "package.remove", package_id: id, reason: "consumed" });
    network.offline = true;
    await core.stock.update([id], { best_before: "2027-06-30" });
    expect(value(core.data.packages)[0]?.best_before).toBe("2027-06-30");
    network.offline = false;
    await core.sync.now();

    expect(value(core.sync.problems)).toMatchObject([{ status: "displaced", code: null, command: { type: "package.update", package_id: id } }]);
    // Löschen gewinnt: Die Packung liegt in der Lösch-Historie, die Bearbeitung ist aufgehoben.
    expect(value(core.data.packages)).toEqual([]);
    const removed = value(core.data.removedPackages)[0];
    expect(removed).toMatchObject({ id, best_before: "2027-03-25", removal_reason: "consumed" });
    expect(removed?.displaced?.changes).toEqual([{ field: "best_before", value: "2027-06-30" }]);

    // Beim Wiederherstellen lässt sie sich übernehmen.
    await core.stock.restore([id], { apply_displaced: true });
    expect(value(core.data.packages)[0]).toMatchObject({ id, best_before: "2027-06-30", displaced: null });
    await core.sync.now();
    expect(server.data.packages.get(id)).toMatchObject({ best_before: "2027-06-30", removed_at: null, displaced: null });
  });

  it("wechselt bei 401 nach revoked und behält Daten und Outbox", async () => {
    const { core, server } = await signedIn();
    const zone = firstZoneId(core);
    await core.stock.store({ product: NEW_RICE, zone_id: zone, best_before: null, count: 2, labels: false });
    server.revoke();
    await core.sync.now();

    expect(value(core.session.state)).toEqual({ status: "signed_out", reason: "revoked" });
    expect(value(core.sync.status)).toMatchObject({ phase: "error", pending: 3, last_error: { code: "unauthorized" }, online: true });
    expect(value(core.data.packages)).toHaveLength(2);
    expect(server.data.packages.size).toBe(0);

    // Nach erneuter Anmeldung wird weiter gesendet, mit denselben Daten.
    await core.session.login(FAKE_PASSWORD, "Testgerät");
    expect(value(core.session.state).status).toBe("signed_in");
    expect(value(core.sync.status).pending).toBe(0);
    expect(server.data.packages.size).toBe(2);
    expect(value(core.data.packages)).toHaveLength(2);
    // Kein vollständiger Abzug nötig: Der Stand war noch bekannt.
    expect((server.syncRequests.at(-1) as unknown as SyncRequest).dataset_id).toBe(server.datasetId);
  });

  it("behält den gesperrten Zustand über das Neuladen", async () => {
    const { core, server, another } = await signedIn();
    await core.zones.create({ name: "Keller" });
    server.revoke();
    await core.sync.now();
    core.dispose();
    const reloaded = await another();
    expect(value(reloaded.session.state)).toEqual({ status: "signed_out", reason: "revoked" });
    expect(value(reloaded.sync.status).pending).toBe(1);
  });

  it("sendet bei 409 protocol_mismatch nicht weiter und behält die Outbox", async () => {
    const { core, server } = await signedIn();
    await core.zones.create({ name: "Keller" });
    server.protocol = PROTOCOL_VERSION + 1;
    await core.sync.now();

    expect(value(core.sync.status)).toMatchObject({ phase: "error", pending: 1, online: true, last_error: { code: "protocol_mismatch" } });
    expect(value(core.session.state).status).toBe("signed_in");
    expect(value(core.data.zones)).toHaveLength(2);

    server.protocol = PROTOCOL_VERSION;
    await core.sync.now();
    expect(value(core.sync.status)).toMatchObject({ phase: "idle", pending: 0, last_error: null });
  });

  it("lässt bei einem Fehler des Servers alles, wie es ist", async () => {
    const { core, network } = await signedIn();
    await core.zones.create({ name: "Keller" });
    const sync = (response: () => Response) => {
      network.respondWith = (call) => (call.path === "/api/sync" ? response() : null);
    };

    // 500 im Fehlerformat des Servers
    sync(() => new Response(JSON.stringify({ error: { code: "internal", message: "Fehler im Server.", details: null } }), { status: 500 }));
    await core.sync.now();
    expect(value(core.sync.status)).toMatchObject({ phase: "error", pending: 1, online: true, last_error: { code: "internal" } });

    // 502 eines Proxys ohne Server dahinter: Das ist „nicht erreichbar", kein Fehler von Stowly.
    sync(() => new Response("<html>Bad Gateway</html>", { status: 502 }));
    await core.sync.now();
    expect(value(core.sync.status)).toMatchObject({ phase: "error", pending: 1, online: false, last_error: { code: "offline" } });

    // Die Anmeldeseite eines fremden WLANs antwortet mit 200 und HTML.
    sync(() => new Response("<html>Bitte anmelden</html>", { status: 200 }));
    await core.sync.now();
    expect(value(core.sync.status)).toMatchObject({ phase: "error", pending: 1, last_error: { code: "offline" } });

    // Ein 401, das nicht vom Server stammt, sperrt das Gerät nicht.
    sync(() => new Response("Unauthorized", { status: 401 }));
    await core.sync.now();
    expect(value(core.session.state).status).toBe("signed_in");
    expect(value(core.sync.status)).toMatchObject({ phase: "error", pending: 1 });

    // Eine Antwort ohne die Form des Protokolls verändert die Kopie nicht.
    sync(() => new Response(JSON.stringify({ hello: "world" }), { status: 200 }));
    await core.sync.now();
    expect(value(core.sync.status)).toMatchObject({ phase: "error", pending: 1, last_error: { code: "internal" } });
    expect(value(core.data.zones)).toHaveLength(2);

    network.respondWith = null;
    await core.sync.now();
    expect(value(core.sync.status)).toMatchObject({ phase: "idle", pending: 0, online: true, last_error: null });
  });
});

describe("Antwort anwenden", () => {
  it("blättert bei has_more weiter und wendet alle Seiten gemeinsam an", async () => {
    const { core, server, network } = await signedIn({ server: { maxChanges: 4 } });
    const zone = firstZoneId(core);
    const product = "20000000-0000-4000-8000-000000000001";
    server.act({ type: "product.create", product_id: product, name: "Reis" });
    const ids = ["00001", "00002", "00003", "00004", "00005", "00006", "00007", "00008", "00009", "0000A", "0000B"];
    for (const id of ids) {
      server.act({ type: "package.create", package_id: id, product_id: product, zone_id: zone, best_before: null });
    }
    const before = server.syncRequests.length;
    const snapshots: number[] = [];
    const unsubscribe = core.data.packages.subscribe(() => snapshots.push(value(core.data.packages).length));
    await core.sync.now();
    unsubscribe();

    const requests = server.syncRequests.slice(before) as unknown as SyncRequest[];
    expect(requests).toHaveLength(3);
    // Weitere Seiten: ohne Befehle, mit dem jeweils neuen cursor.
    expect(requests.map((request) => request.commands.length)).toEqual([0, 0, 0]);
    expect(requests[1]?.cursor).toBeGreaterThan(requests[0]?.cursor ?? 0);
    expect(requests[2]?.cursor).toBeGreaterThan(requests[1]?.cursor ?? 0);
    expect(requests.every((request) => request.dataset_id === server.datasetId)).toBe(true);
    // Der Vorrat war voll: Auch beim Blättern verlangt die App keine weiteren IDs.
    expect(requests.map((request) => request.id_pool.have)).toEqual([300, 300, 300]);

    expect(value(core.data.packages).map((pkg) => pkg.id).sort()).toEqual(ids);
    // Alle Seiten auf einmal: Die Oberfläche hat nie einen halben Stand gesehen.
    expect(snapshots).toEqual([11]);
  });

  it("holt auch den ersten Abzug seitenweise", async () => {
    const { core, server } = await start({ server: { maxChanges: 3 } });
    const zone = [...server.data.zones.keys()][0] ?? "";
    const product = "20000000-0000-4000-8000-000000000001";
    server.act({ type: "product.create", product_id: product, name: "Reis" });
    for (const id of ["00001", "00002", "00003", "00004", "00005"]) {
      server.act({ type: "package.create", package_id: id, product_id: product, zone_id: zone, best_before: null });
    }
    await core.session.login(FAKE_PASSWORD, "Handy");
    const requests = server.syncRequests as unknown as SyncRequest[];
    expect(requests.length).toBeGreaterThan(2);
    expect(requests[0]).toMatchObject({ dataset_id: null, cursor: 0 });
    // Die Folgeseiten nennen den neuen Bestand, sonst begänne der Abzug immer wieder von vorn.
    expect(requests.slice(1).every((request) => request.dataset_id === server.datasetId && request.cursor > 0)).toBe(true);
    expect(value(core.data.packages)).toHaveLength(5);
    expect(value(core.data.zones)).toHaveLength(1);
  });

  it("leert bei reset die Kopie und den ID-Vorrat, behält aber die Outbox", async () => {
    const { core, server, network } = await signedIn();
    const zone = firstZoneId(core);
    const synced = await core.stock.store({ product: NEW_RICE, zone_id: zone, best_before: null, count: 1, labels: false });
    await core.sync.now();

    network.offline = true;
    const pending = await core.stock.store({ product: { kind: "new", name: "Nudeln" }, zone_id: zone, best_before: null, count: 1, labels: false });
    // Der Server bekommt einen neuen Bestand (Sicherung eingespielt): Die schon abgeglichene Packung fehlt dort.
    server.forget("packages", synced.packages[0]?.id ?? "");
    server.newDataset();
    network.offline = false;
    await core.sync.now();

    // Die Kopie folgt dem neuen Bestand; die wartende Änderung wurde erneut gesendet.
    expect(value(core.data.packages).map((pkg) => pkg.id)).toEqual([pending.packages[0]?.id]);
    expect(server.data.packages.has(pending.packages[0]?.id ?? "")).toBe(true);
    expect(value(core.sync.status).pending).toBe(0);
    expect((server.syncRequests.at(-1) as unknown as SyncRequest).dataset_id).toBe(server.datasetId);
  });

  it("verwirft eine Packung, die der Server als längst entnommen liefert, aus Bestand und Lösch-Historie", async () => {
    const { core, server, clock } = await signedIn();
    const zone = firstZoneId(core);
    const stored = await core.stock.store({ product: NEW_RICE, zone_id: zone, best_before: null, count: 2, labels: false });
    const [gone, kept] = stored.packages.map((pkg) => pkg.id);
    await core.sync.now();
    expect(value(core.data.packages)).toHaveLength(2);

    // Ein anderes Gerät entnimmt eine Packung. Dieses Gerät bleibt 40 Tage aus, länger als die Aufbewahrung.
    server.act({ type: "package.remove", package_id: gone, reason: "consumed" });
    clock.advance(40 * DAY);
    await core.sync.now();

    expect(value(core.data.packages).map((pkg) => pkg.id)).toEqual([kept]);
    expect(value(core.data.removedPackages)).toEqual([]);
    expect(await core.data.findPackage(gone ?? "")).toBeUndefined();
  });

  it("verwirft beim Start, was inzwischen jenseits der Aufbewahrung liegt", async () => {
    const { core, clock, network, another } = await signedIn();
    const zone = firstZoneId(core);
    const stored = await core.stock.store({ product: NEW_RICE, zone_id: zone, best_before: null, count: 1 });
    const id = stored.packages[0]?.id ?? "";
    await core.stock.remove([id], "consumed");
    await core.sync.now();
    expect(value(core.data.removedPackages)).toHaveLength(1);
    core.dispose();

    network.offline = true;
    clock.advance(31 * DAY);
    const reloaded = await another();
    expect(value(reloaded.data.removedPackages)).toEqual([]);
    expect(await reloaded.data.findPackage(id)).toBeUndefined();
  });

  it("holt den Bestand vollständig neu, nachdem die Aufbewahrungsdauer vergrößert wurde", async () => {
    const { core, server, clock } = await signedIn();
    const zone = firstZoneId(core);
    const stored = await core.stock.store({ product: NEW_RICE, zone_id: zone, best_before: null, count: 1, labels: false });
    const id = stored.packages[0]?.id ?? "";
    await core.stock.remove([id], "consumed");
    await core.sync.now();

    // Nach 40 Tagen ist die Packung aus der Lösch-Historie dieses Geräts verschwunden.
    clock.advance(40 * DAY);
    await core.sync.now();
    expect(value(core.data.removedPackages)).toEqual([]);

    await core.settings.update({ trash_retention_days: 90 });
    const before = server.syncRequests.length;
    await core.sync.now();

    const request = server.syncRequests[before] as unknown as SyncRequest;
    expect(request).toMatchObject({ dataset_id: null, cursor: 0, id_pool: { have: 0 } });
    expect(request.commands.map((command) => command.type)).toEqual(["settings.update"]);
    // Die Lösch-Historie reicht wieder so weit zurück wie die des Servers.
    expect(value(core.data.removedPackages).map((pkg) => pkg.id)).toEqual([id]);
    // Einmal vollständig, danach wieder wie gewohnt.
    await core.sync.now();
    expect(server.syncRequests.at(-1)).toMatchObject({ dataset_id: server.datasetId });
    expect((server.syncRequests.at(-1) as unknown as SyncRequest).cursor).toBeGreaterThan(0);
  });

  it("holt auch dann vollständig neu, wenn ein anderes Gerät die Aufbewahrungsdauer vergrößert hat", async () => {
    const { core, server } = await signedIn();
    server.putSettings({ trash_retention_days: 60 });
    const before = server.syncRequests.length;
    await core.sync.now();
    const requests = server.syncRequests.slice(before) as unknown as SyncRequest[];
    expect(requests.map((request) => [request.dataset_id === null, request.cursor === 0])).toEqual([
      [false, false],
      [true, true],
    ]);
    expect(value(core.data.settings).trash_retention_days).toBe(60);
    // Kleiner werden löst nichts aus.
    server.putSettings({ trash_retention_days: 10 });
    const next = server.syncRequests.length;
    await core.sync.now();
    expect(server.syncRequests.slice(next)).toHaveLength(1);
  });
});

describe("ID-Vorrat", () => {
  it("füllt sich aus der Antwort und gibt je Packung eine ID ab", async () => {
    const { core, server } = await signedIn();
    expect(server.reservedIds).toHaveLength(300);
    const zone = firstZoneId(core);
    const stored = await core.stock.store({ product: NEW_RICE, zone_id: zone, best_before: null, count: 5, labels: false });
    const ids = stored.packages.map((pkg) => pkg.id);
    expect(ids.every(isPackageId)).toBe(true);
    expect(new Set(ids).size).toBe(5);
    // Die IDs stammen aus dem Vorrat, den der Server diesem Gerät reserviert hat.
    expect(ids.every((id) => server.isReserved(id))).toBe(true);

    const before = server.syncRequests.length;
    await core.sync.now();
    const request = server.syncRequests[before] as unknown as SyncRequest;
    expect(request.id_pool).toEqual({ have: 295 });
    // Mit dem Anlegen verfällt die Reservierung; der Server füllt wieder auf 300 auf.
    expect(ids.some((id) => server.isReserved(id))).toBe(false);
    await core.sync.now();
    expect((server.syncRequests.at(-1) as unknown as SyncRequest).id_pool).toEqual({ have: 300 });
  });

  it("vergibt nie dieselbe ID zweimal, auch nicht über das Neuladen hinweg", async () => {
    const { core, network, another } = await signedIn();
    network.offline = true;
    const zone = firstZoneId(core);
    const first = await core.stock.store({ product: NEW_RICE, zone_id: zone, best_before: null, count: 50, labels: false });
    core.dispose();
    const reloaded = await another();
    const second = await reloaded.stock.store({ product: { kind: "existing", product_id: first.product.id }, zone_id: zone, best_before: null, count: 50, labels: false });
    const all = [...first.packages, ...second.packages].map((pkg) => pkg.id);
    expect(new Set(all).size).toBe(100);
  });

  it("fällt auf Zufalls-IDs zurück, wenn der Vorrat offline aufgebraucht ist", async () => {
    const { core, server, network } = await signedIn();
    network.offline = true;
    const zone = firstZoneId(core);
    const first = await core.stock.store({ product: NEW_RICE, zone_id: zone, best_before: null, count: 50, labels: false });
    const product = { kind: "existing", product_id: first.product.id } as const;
    const all = first.packages.map((pkg) => pkg.id);
    for (let batch = 0; batch < 6; batch += 1) {
      const more = await core.stock.store({ product, zone_id: zone, best_before: null, count: 50, labels: false });
      all.push(...more.packages.map((pkg) => pkg.id));
    }
    expect(all).toHaveLength(350);
    expect(new Set(all).size).toBe(350);
    expect(all.every(isPackageId)).toBe(true);
    expect(all.slice(0, 300).every((id) => server.isReserved(id))).toBe(true);
    // Die letzten 50 sind Zufalls-IDs: nicht reserviert.
    expect(all.slice(300).some((id) => server.isReserved(id))).toBe(false);

    network.offline = false;
    const before = server.syncRequests.length;
    await core.sync.now();
    expect((server.syncRequests[before] as unknown as SyncRequest).id_pool).toEqual({ have: 0 });
    expect(server.data.packages.size).toBe(350);
    expect(value(core.sync.problems)).toEqual([]);
  });

  it("verwirft den Vorrat bei reset und nimmt den neuen aus der Antwort", async () => {
    const { core, server } = await signedIn();
    const zone = firstZoneId(core);
    const old = await core.stock.store({ product: NEW_RICE, zone_id: zone, best_before: null, count: 1, labels: false });
    await core.sync.now();

    const discarded = new Set(server.reservedIds);
    expect(discarded.size).toBe(300);
    server.newDataset();
    const before = server.syncRequests.length;
    await core.sync.now();
    const requests = server.syncRequests.slice(before) as unknown as SyncRequest[];
    // Unerwarteter Abzug: Der alte Vorrat ist verworfen, eine zweite Runde füllt ihn wieder auf.
    expect(requests.map((request) => request.id_pool.have)).toEqual([300, 0]);

    const next = await core.stock.store({ product: { kind: "existing", product_id: old.product.id }, zone_id: zone, best_before: null, count: 50, labels: false });
    // Die neuen IDs stammen aus der neuen Zuteilung, keine aus dem verworfenen Vorrat.
    expect(next.packages.every((pkg) => server.isReserved(pkg.id))).toBe(true);
    expect(next.packages.some((pkg) => discarded.has(pkg.id))).toBe(false);
  });
});

describe("Mehrere Tabs", () => {
  it("zeigt im zweiten Tab, was der erste geändert hat", async () => {
    const { core, another } = await signedIn();
    const second = await another();
    await core.zones.create({ name: "Keller" });
    await expect.poll(() => value(second.data.zones).map((zone) => zone.name)).toEqual(["Vorrat", "Keller"]);
    expect(value(second.sync.status).pending).toBe(1);

    // Beide schreiben; keiner überschreibt die Outbox des anderen.
    await second.zones.create({ name: "Garage" });
    await expect.poll(() => value(core.data.zones).map((zone) => zone.name)).toEqual(["Vorrat", "Keller", "Garage"]);
    expect(value(second.data.zones).map((zone) => zone.sort)).toEqual([0, 1, 2]);
    await core.sync.now();
    await expect.poll(() => value(second.sync.status).pending).toBe(0);
  });

  it("gleicht nie zweimal gleichzeitig ab und sendet keinen Befehl doppelt", async () => {
    const { core, server, network, another } = await signedIn();
    const second = await another();
    await core.zones.create({ name: "Keller" });
    await expect.poll(() => value(second.sync.status).pending).toBe(1);
    const before = server.syncRequests.length;

    let active = 0;
    let overlap = false;
    network.beforeRequest = async (call) => {
      if (call.path !== "/api/sync") {
        return;
      }
      active += 1;
      overlap ||= active > 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
    };
    network.beforeResponse = (call) => {
      if (call.path === "/api/sync") {
        active -= 1;
      }
    };
    await Promise.all([core.sync.now(), second.sync.now()]);
    expect(overlap).toBe(false);
    const sent = server.syncRequests.slice(before).flatMap((request) => commandsOf(request));
    expect(sent.map((command) => command.type)).toEqual(["zone.create"]);
    expect(server.data.zones.size).toBe(2);
  });
});
