/**
 * Drucker und Etiketten als Datenhaltung (docs/etiketten.md, Abschnitt 4): was ein Gerät,
 * das druckt, an den Server meldet, und wie es bei den anderen Geräten ankommt.
 *
 * Gedruckt wird in Runde 1 noch nichts. Die Meldungen (`print.report`, `printer.report`)
 * schickt hier ein Gerät ohne Kern so, wie sie das Zustellen in Runde 2 schicken wird.
 */
import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { firstZone } from "./support/data";
import { disposeDevices, MINUTE, signedIn, value } from "./support/device";
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

it("zeigt den Fortschritt eines Etiketts und den zuletzt gesehenen Zustand des Druckers auf jedem Gerät", async () => {
  const kitchen = await signedIn(server.url, "Küche");
  const cellar = await signedIn(server.url, "Keller");
  const pi = await RawClient.login(server.url, "Handy am Drucker");
  const other = await RawClient.login(server.url, "Zweites Handy");
  const raw = await RawClient.login(server.url);

  const printer = await kitchen.core.printers.create({
    name: "Keller-Pi",
    connection: "direct",
    direct: { urls: ["https://10.71.83.1:8443", "http://10.71.83.1:8080"], token: "pi-geheim-123", printer: null },
  });
  const stored = await kitchen.core.stock.store({ product: { kind: "new", name: "Mais P1" }, zone_id: firstZone(kitchen).id, best_before: null, count: 2, labels: true });
  const [first, second] = stored.print_jobs.map((job) => job.id) as [string, string];
  await kitchen.sync();

  // Das Handy am Drucker meldet: angenommen, gedruckt. Jede Meldung trägt Drucker und boot_id.
  const boot = randomUUID();
  await pi.send([{ type: "print.report", job_id: first, state: "queued", printer_id: printer.id, boot_id: boot }], { ageMs: 2 * MINUTE });
  await pi.send([{ type: "print.report", job_id: first, state: "printed", printer_id: printer.id, boot_id: boot }], { ageMs: MINUTE });
  // Beim zweiten Etikett scheitert der Druck; die Meldung nennt den Fehler des Druckdienstes.
  await pi.send([{ type: "print.report", job_id: second, state: "failed", printer_id: printer.id, boot_id: boot, error: "no_media" }]);
  // Eine ältere Meldung eines anderen Geräts trifft später ein: Sie verliert.
  const late = await other.send([{ type: "print.report", job_id: first, state: "unknown", printer_id: printer.id, boot_id: boot }], { ageMs: 90_000 });
  expect(late.results).toMatchObject([{ status: "applied" }]);

  // Dazu der Zustand des Druckdienstes, wie ihn das Handy beim Drucken gesehen hat.
  const status = { reachable: true, ready: false, media_detected: false, errors: ["no_media"] };
  const host = { uptime_s: 1234.5, temperature_c: 51.2, throttled: false, undervoltage: null, storage_errors: 0, storage_read_only: false, overlay_used_pct: 3.5, memory_available_mb: 210 };
  await pi.send([{ type: "printer.report", printer_id: printer.id, boot_id: boot, status, host }]);
  // Eine ältere Beobachtung, die später eintrifft, überschreibt die jüngere nicht.
  await other.send([{ type: "printer.report", printer_id: printer.id, boot_id: "alter-start", status: { reachable: true, ready: true, media_detected: true, errors: [] }, host: null }], { ageMs: 10 * MINUTE });

  for (const device of [kitchen, cellar]) {
    await device.sync();
    const jobs = value(device.core.data.printJobs);
    expect(jobs.find((job) => job.id === first)).toMatchObject({ state: "printed", printer_id: printer.id, boot_id: boot, error: null, device_id: kitchen.session.id });
    expect(jobs.find((job) => job.id === second)).toMatchObject({ state: "failed", printer_id: printer.id, boot_id: boot, error: "no_media" });
    expect(value(device.core.data.printerStatus)).toMatchObject([{ printer_id: printer.id, boot_id: boot, status, host }]);
    // Das Token des Druckdienstes kommt auf jedes Gerät: Es druckt selbst.
    expect(value(device.core.data.printers).find((entry) => entry.id === printer.id)?.direct?.token).toBe("pi-geheim-123");
    await expectSameAsServer(device, raw);
  }

  // Ein neuer Versuch ist ein neues Etikett; das fehlgeschlagene bleibt, wie es ist.
  const retry = await cellar.core.print.retry(second);
  expect(retry).toMatchObject({ state: "pending", package_id: stored.packages[1]?.id, printer_id: printer.id });
  await cellar.sync();
  const state = await expectSameAsServer(cellar, raw);
  expect(state.print_jobs.find((job) => job.id === second)?.state).toBe("failed");
  expect(state.print_jobs.find((job) => job.id === retry.id)).toMatchObject({ state: "pending", device_id: cellar.session.id });

  // Im Ereignisprotokoll steht nie das Token des Druckdienstes.
  const events = await raw.events({ entity: "printer", entity_id: printer.id });
  expect(JSON.stringify(events)).not.toContain("pi-geheim-123");
  expect(events.map((event) => event.type)).toEqual(["printer.created"]);
});
