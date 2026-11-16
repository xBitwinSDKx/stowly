/**
 * Updates über GitHub im echten Kern, gegen die Nachbildung des Servers (src/core/testing):
 * suchen, anfordern, die Fehler des Servers als CoreError (docs/integrationen.md 10.5,
 * docs/sync-protokoll.md 13) und der Zustand in `integrations.load`. Gespeichert wird davon
 * nichts: Jeder Aufruf fragt den Server.
 */
import { afterEach, describe, expect, it } from "vitest";

import { ENDPOINTS, UPDATE_CHECK_MIN_GAP_S, type ErrorBody } from "@/contract";

import type { FakeRelease } from "./testing/fake-api";
import { disposeAll, expectCoreError, signedIn, start, value, type Harness } from "./testing/harness";

afterEach(disposeAll);

const REPO = "beispiel/stowly";
const RELEASE: FakeRelease = {
  version: "0.2.0",
  name: "Updates aus den Einstellungen",
  notes: "## Neu\n\n- Updates lassen sich in den Einstellungen installieren.",
  published_at: "2026-11-12T09:00:00.000Z",
  url: "https://github.com/beispiel/stowly/releases/tag/v0.2.0",
};

/** Ein Server mit eingerichteten Updates, einem Release auf GitHub und einem Updater, der sich eben gemeldet hat. */
async function withUpdates(): Promise<Harness> {
  const harness = await signedIn();
  harness.server.updateRepo = REPO;
  harness.server.githubRelease = { ...RELEASE };
  harness.server.updaterSeenAt = harness.clock.now().toISOString();
  return harness;
}

function callsTo(harness: Harness, path: string) {
  return harness.network.calls.filter((call) => call.path === path);
}

function errorBody(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  const body: ErrorBody = { error: { code: code as ErrorBody["error"]["code"], message, details: null } };
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("Nach Updates suchen", () => {
  it("fragt sofort, liefert den Zustand danach und geht höchstens einmal je Minute", async () => {
    const harness = await withUpdates();
    const { core, clock } = harness;
    const status = await core.update.check();
    expect(status).toEqual({
      configured: true,
      repo: REPO,
      current: "0.1.0",
      latest: "0.2.0",
      latest_name: RELEASE.name,
      notes: RELEASE.notes,
      published_at: RELEASE.published_at,
      url: RELEASE.url,
      available: true,
      checked_at: clock.now().toISOString(),
      check_error: null,
      updater_ready: true,
      updater_seen_at: clock.now().toISOString(),
      // Ohne Angabe der Art gilt der Updater als Skript (docs/integrationen.md, 10.4).
      updater_kind: "script",
      updater_version: null,
      updater_command: null,
      state: "idle",
      state_version: null,
      state_at: null,
      state_message: null,
    });
    expect(callsTo(harness, ENDPOINTS.check_update.path)).toMatchObject([{ method: "POST", body: undefined, token: expect.any(String) }]);
    // Derselbe Zustand steht danach in den Integrationen.
    expect((await core.integrations.load()).update).toEqual(status);

    const limited = await expectCoreError(core.update.check(), "rate_limited");
    expect(limited.details).toMatchObject({ status: 429, retry_after_s: UPDATE_CHECK_MIN_GAP_S });
    clock.advance(45_000);
    expect((await expectCoreError(core.update.check(), "rate_limited")).details.retry_after_s).toBe(15);
    // Der Server hat geantwortet: Er gilt weiter als erreichbar.
    expect(value(core.sync.status).online).toBe(true);

    clock.advance(15_000);
    expect((await core.update.check()).checked_at).toBe(clock.now().toISOString());
  });

  it("meldet einen Fehler bei GitHub im Zustand, nicht als Fehler des Aufrufs", async () => {
    const harness = await withUpdates();
    const { core, server, clock } = harness;
    const first = await core.update.check();
    clock.advance(UPDATE_CHECK_MIN_GAP_S * 1000);
    server.githubError = "GitHub ist nicht erreichbar.";
    server.githubRelease = { ...RELEASE, version: "0.3.0" };
    const failed = await core.update.check();
    // Die bisherigen Angaben bleiben stehen, auch die Zeit der letzten gelungenen Abfrage.
    expect(failed).toMatchObject({ check_error: "GitHub ist nicht erreichbar.", latest: "0.2.0", checked_at: first.checked_at, available: true });
  });

  it("kennt einen Server ohne Releases und einen ohne STOWLY_UPDATE_REPO", async () => {
    const harness = await withUpdates();
    harness.server.githubRelease = null;
    expect(await harness.core.update.check()).toMatchObject({ latest: null, notes: null, url: null, available: false, checked_at: expect.any(String), check_error: null });

    const plain = await signedIn();
    expect((await plain.core.integrations.load()).update).toMatchObject({ configured: false, repo: null, current: "0.1.0", latest: null, available: false, state: "idle" });
    const error = await expectCoreError(plain.core.update.check(), "not_configured");
    expect(error.message).toBe("Updates sind auf diesem Server aus. Einschalten unter Einstellungen → Aktualisierung.");
    expect(error.details.status).toBe(503);
    expect(value(plain.core.sync.status).online).toBe(true);
  });

  it("nimmt die Wartezeit auch aus Retry-After", async () => {
    const harness = await withUpdates();
    harness.network.respondWith = (call) => (call.path === ENDPOINTS.check_update.path ? errorBody(429, "rate_limited", "Zu oft.", { "retry-after": "42" }) : null);
    expect((await expectCoreError(harness.core.update.check(), "rate_limited")).details.retry_after_s).toBe(42);
  });
});

describe("Update anfordern", () => {
  it("schickt nur die Version, legt die Anforderung ab und liefert „requested“", async () => {
    const harness = await withUpdates();
    const { core, server, clock } = harness;
    await core.update.check();
    clock.advance(5_000);
    const status = await core.update.install("0.2.0");
    expect(status).toMatchObject({ state: "requested", state_version: "0.2.0", state_at: clock.now().toISOString(), state_message: null, available: true });
    expect(callsTo(harness, ENDPOINTS.install_update.path)).toMatchObject([{ method: "POST", body: { version: "0.2.0" } }]);
    expect(server.updateRequest).toEqual({ version: "0.2.0", requested_at: clock.now().toISOString(), device: "Testgerät" });
    expect((await core.integrations.load()).update).toEqual(status);
  });

  it("gibt die Ablehnungen des Servers mit seinem Satz weiter", async () => {
    const harness = await withUpdates();
    const { core, server, clock } = harness;
    await core.update.check();

    // Der Updater meldet sich seit mehr als zehn Minuten nicht.
    clock.advance(600_001);
    const silent = await expectCoreError(core.update.install("0.2.0"), "not_configured");
    expect(silent.message).toBe("Der Updater auf dem Rechner meldet sich nicht (docs/betrieb.md, Abschnitt 9).");
    expect(silent.details.status).toBe(503);
    server.updaterSeenAt = clock.now().toISOString();

    const older = await expectCoreError(core.update.install("0.1.9"), "conflict");
    expect(older.message).toBe("Das ist nicht die neueste bekannte Version. Bitte erst nach Updates suchen.");
    expect(older.details.status).toBe(409);
    // Keine Version wie 1.2.3: Das prüft der Server (422).
    const malformed = await expectCoreError(core.update.install("1.2"), "invalid");
    expect(malformed.details.status).toBe(422);
    expect(callsTo(harness, ENDPOINTS.install_update.path).map((call) => call.body)).toEqual([{ version: "0.2.0" }, { version: "0.1.9" }, { version: "1.2" }]);

    await core.update.install("0.2.0");
    expect((await expectCoreError(core.update.install("0.2.0"), "conflict")).message).toBe("Ein Update ist schon angefordert.");

    // Der Updater ist fertig, der Server läuft mit der neuen Version.
    server.updateRequest = null;
    server.updaterState = { state: "done", version: "0.2.0", at: clock.now().toISOString(), message: null };
    server.updateCurrent = "0.2.0";
    expect((await core.integrations.load()).update).toMatchObject({ state: "done", available: false, current: "0.2.0" });
    expect((await expectCoreError(core.update.install("0.2.0"), "conflict")).message).toBe("Diese Version ist schon installiert.");
    expect(value(core.sync.status).online).toBe(true);
  });

  it("braucht eingerichtete Updates", async () => {
    const harness = await signedIn();
    const error = await expectCoreError(harness.core.update.install("0.2.0"), "not_configured");
    expect(error.message).toBe("Updates sind auf diesem Server aus. Einschalten unter Einstellungen → Aktualisierung.");
  });
});

describe("Ohne Server, mit fremder Antwort, ohne Anmeldung", () => {
  it("ist offline ohne Server, bei einer fremden oder unbrauchbaren Antwort und bei einem Proxy ohne Server", async () => {
    const harness = await withUpdates();
    const { core, network } = harness;
    network.offline = true;
    await expectCoreError(core.update.check(), "offline");
    await expectCoreError(core.update.install("0.2.0"), "offline");
    expect(value(core.sync.status).online).toBe(false);
    network.offline = false;

    const answers: Response[] = [
      new Response("<html>Anmelden</html>", { status: 200, headers: { "content-type": "text/html" } }),
      new Response(JSON.stringify({ configured: true, state: "irgendwas" }), { status: 200 }),
      new Response("Bad Gateway", { status: 502 }),
    ];
    for (const answer of answers) {
      network.respondWith = (call) => (call.path.startsWith("/api/update/") ? answer.clone() : null);
      await expectCoreError(core.update.check(), "offline");
      await expectCoreError(core.update.install("0.2.0"), "offline");
    }
    // Ein Zustand der Integrationen ohne `update` stammt nicht vom Stowly-Server.
    network.respondWith = (call) =>
      call.path === ENDPOINTS.get_integrations.path ? new Response(JSON.stringify({ timezone: "Europe/Berlin", backup: {}, ha: {}, push: {}, update: null }), { status: 200 }) : null;
    await expectCoreError(core.integrations.load(), "offline");
    network.respondWith = null;
    expect((await core.integrations.load()).update.configured).toBe(true);
  });

  it("meldet einen Server, der Updates noch nicht kann, als not_supported", async () => {
    const harness = await withUpdates();
    harness.network.respondWith = (call) => (call.path.startsWith("/api/update/") ? errorBody(501, "not_implemented", "Noch nicht umgesetzt.") : null);
    await expectCoreError(harness.core.update.check(), "not_supported");
    await expectCoreError(harness.core.update.install("0.2.0"), "not_supported");
  });

  it("braucht eine Anmeldung; ein gesperrtes Token meldet das Gerät ab", async () => {
    const fresh = await start();
    await expectCoreError(fresh.core.update.check(), "unauthorized");
    await expectCoreError(fresh.core.update.install("0.2.0"), "unauthorized");
    expect(fresh.network.calls.filter((call) => call.path.startsWith("/api/update/"))).toEqual([]);

    const harness = await withUpdates();
    harness.server.revoke();
    await expectCoreError(harness.core.update.install("0.2.0"), "unauthorized");
    expect(value(harness.core.session.state)).toMatchObject({ status: "signed_out", reason: "revoked" });
  });
});
