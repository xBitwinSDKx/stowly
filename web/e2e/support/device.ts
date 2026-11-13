/**
 * Ein „Gerät" im Test: der echte Kern (`createCore`) mit eigener lokaler Datenbank, eigener
 * Uhr und einem `fetch`, das zum echten Server führt.
 *
 * Der Kern gleicht nur ab, wenn der Test es sagt (`autoSync: false`), außer ein Test will
 * gerade das selbsttätige Abgleichen sehen.
 */
import Dexie from "dexie";

import { CoreError, type CoreErrorCode, type Live, type SessionDevice, type SyncRequest, type SyncResponse, type SyncStatus } from "@/contract";
import { createCore, type StowlyCore } from "@/core";
import type { FetchLike } from "@/core/http";

/** Das Passwort von `python -m stowly --dev`. */
export const PASSWORD = "stowly";

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * Die Uhr eines Geräts: die echte Zeit plus eine Abweichung. Der Server rechnet mit seiner
 * eigenen, echten Uhr; ein Gerät kann im Test vor- oder nachgehen oder „vor einer Stunde"
 * gehandelt haben.
 */
export class DeviceClock {
  private offsetMs = 0;

  readonly now = (): Date => new Date(Date.now() + this.offsetMs);

  /** Verstellt die Uhr um `ms` (negativ: zurück). */
  shift(ms: number): void {
    this.offsetMs += ms;
  }

  get offset(): number {
    return this.offsetMs;
  }
}

/** Ein Abgleich, wie er über die Leitung ging. */
export interface SyncExchange {
  request: SyncRequest;
  status: number;
  /** Die Antwort bei Erfolg, sonst null. */
  response: SyncResponse | null;
  /** true, wenn der Test die Antwort verloren gehen ließ. */
  lost: boolean;
}

/** Die Leitung eines Geräts zum Server, mit Eingriffen für die Tests. */
export class Network {
  /** false: Keine Anfrage erreicht den Server. */
  online = true;
  /** So viele der nächsten Antworten auf einen Abgleich gehen verloren, nachdem der Server sie verbucht hat. */
  loseSyncResponses = 0;
  /** Die nächste Anfrage eines Abgleichs ist so lange unterwegs, bevor sie beim Server ankommt. */
  delayNextSyncMs = 0;
  /** Verändert den Rumpf jeder Sync-Anfrage, bevor sie hinausgeht (z. B. eine andere Protokollversion). */
  rewriteSyncRequest: ((body: Record<string, unknown>) => void) | null = null;
  /** Alle Abgleiche dieses Geräts in ihrer Reihenfolge. */
  readonly syncs: SyncExchange[] = [];

  constructor(private readonly baseUrl: string) {}

  readonly fetch: FetchLike = async (input, init) => {
    if (!this.online) {
      throw new TypeError("fetch failed (Netz im Test abgeschaltet)");
    }
    if (input === "/api/sync" && this.delayNextSyncMs > 0) {
      const delay = this.delayNextSyncMs;
      this.delayNextSyncMs = 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    if (input === "/api/sync" && this.rewriteSyncRequest && typeof init?.body === "string") {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      this.rewriteSyncRequest(body);
      init = { ...init, body: JSON.stringify(body) };
    }
    const response = await fetch(this.baseUrl + input, init);
    if (input !== "/api/sync") {
      return response;
    }
    const request = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as SyncRequest;
    let body: SyncResponse | null = null;
    if (response.ok) {
      body = (await response.clone().json()) as SyncResponse;
    }
    const lost = this.loseSyncResponses > 0;
    this.syncs.push({ request, status: response.status, response: body, lost });
    if (lost) {
      this.loseSyncResponses -= 1;
      await response.arrayBuffer().catch(() => undefined);
      throw new TypeError("fetch failed (Antwort im Test verloren)");
    }
    return response;
  };

  /** Der letzte Abgleich, der beim Server angekommen ist. */
  get lastSync(): SyncExchange {
    const last = this.syncs.at(-1);
    if (!last) {
      throw new Error("Dieses Gerät hat noch nicht abgeglichen.");
    }
    return last;
  }

  /** Alle Ergebnisse, die der Server diesem Gerät seit `from` (Index in `syncs`) gemeldet hat. */
  resultsSince(from: number): SyncResponse["results"] {
    return this.syncs.slice(from).flatMap((exchange) => exchange.response?.results ?? []);
  }
}

/** Der aktuelle Wert eines `Live`; wirft, solange nichts geladen ist. */
export function value<T>(live: Live<T>): T {
  const current = live.get();
  if (current === undefined) {
    throw new Error("Der Live-Wert ist noch nicht geladen.");
  }
  return current;
}

/** Erwartet, dass `action` mit einem CoreError dieses Codes scheitert, und liefert ihn. */
export async function expectCoreError(action: Promise<unknown>, code: CoreErrorCode): Promise<CoreError> {
  try {
    await action;
  } catch (error) {
    if (!(error instanceof CoreError)) {
      throw new Error(`Erwartet war CoreError ${code}, geworfen wurde: ${String(error)}`);
    }
    if (error.code !== code) {
      throw new Error(`Erwartet war CoreError ${code}, geworfen wurde ${error.code}: ${error.message}`);
    }
    return error;
  }
  throw new Error(`Erwartet war CoreError ${code}, aber nichts wurde geworfen.`);
}

let counter = 0;
const devices: Device[] = [];

export class Device {
  readonly clock = new DeviceClock();
  readonly net: Network;
  readonly dbName: string;
  core: StowlyCore;
  private readonly tabs: StowlyCore[] = [];

  constructor(
    readonly baseUrl: string,
    readonly name: string,
    /** true: Der Kern gleicht von selbst ab wie in der App (nach Änderungen, alle 60 Sekunden). Vorgabe false. */
    private readonly autoSync = false,
  ) {
    counter += 1;
    this.dbName = `stowly-e2e-${process.pid}-${counter}`;
    this.net = new Network(baseUrl);
    this.core = this.open();
    devices.push(this);
  }

  private open(): StowlyCore {
    return createCore({ fetch: this.net.fetch, now: this.clock.now, dbName: this.dbName, autoSync: this.autoSync });
  }

  /** Meldet das Gerät mit dem Entwicklungs-Passwort an; erfüllt sich nach dem ersten Abgleich. */
  async login(password: string = PASSWORD): Promise<void> {
    await this.core.ready;
    await this.core.session.login(password, this.name);
  }

  /** Dieses Gerät, wie der Server es kennt. Wirft, wenn es nicht angemeldet ist. */
  get session(): SessionDevice {
    const state = value(this.core.session.state);
    if (state.status !== "signed_in") {
      throw new Error(`${this.name} ist nicht angemeldet (${state.status}).`);
    }
    return state.device;
  }

  get status(): SyncStatus {
    return value(this.core.sync.status);
  }

  /** Gleicht ab, ohne etwas zu erwarten; der Test prüft den Status selbst. */
  async trySync(): Promise<SyncStatus> {
    await this.core.sync.now();
    return this.status;
  }

  /** Gleicht ab und erwartet, dass es gelingt und nichts mehr in der Outbox wartet. */
  async sync(): Promise<void> {
    const status = await this.trySync();
    if (status.last_error !== null || status.phase !== "idle") {
      throw new Error(`${this.name}: Der Abgleich ist gescheitert (${status.last_error?.code ?? status.phase}: ${status.last_error?.message ?? ""}).`);
    }
    if (status.pending !== 0) {
      throw new Error(`${this.name}: Nach dem Abgleich warten noch ${status.pending} Befehle.`);
    }
  }

  /**
   * Führt `action` aus, als hätte das Gerät sie vor `ms` Millisekunden getan: Die Befehle
   * tragen den früheren Zeitpunkt, beim nächsten Abgleich sind sie entsprechend alt.
   */
  async ago<T>(ms: number, action: () => Promise<T>): Promise<T> {
    this.clock.shift(-ms);
    try {
      return await action();
    } finally {
      this.clock.shift(ms);
    }
  }

  /** Ein zweiter Tab desselben Browsers: ein weiterer Kern auf derselben lokalen Datenbank. */
  async secondTab(): Promise<StowlyCore> {
    const tab = this.open();
    this.tabs.push(tab);
    await tab.ready;
    return tab;
  }

  /** Die App wird neu geladen: ein neuer Kern auf derselben lokalen Datenbank. */
  async reload(): Promise<void> {
    await this.close();
    this.core = this.open();
    await this.core.ready;
  }

  async close(): Promise<void> {
    for (const tab of this.tabs.splice(0)) {
      tab.dispose();
      await tab.ready.catch(() => undefined);
    }
    this.core.dispose();
    await this.core.ready.catch(() => undefined);
    // Die Datenbank schließt sich erst nach `ready`.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Ein neues Gerät, noch nicht angemeldet. */
export async function newDevice(baseUrl: string, name: string): Promise<Device> {
  const device = new Device(baseUrl, name);
  await device.core.ready;
  return device;
}

/** Ein Gerät, das angemeldet ist und den ersten Abgleich hinter sich hat. */
export async function signedIn(baseUrl: string, name: string): Promise<Device> {
  const device = await newDevice(baseUrl, name);
  await device.login();
  return device;
}

/** Beendet alle Geräte dieses Tests und löscht ihre lokalen Datenbanken. Gehört in `afterEach`. */
export async function disposeDevices(): Promise<void> {
  for (const device of devices.splice(0)) {
    await device.close();
    await Dexie.delete(device.dbName).catch(() => undefined);
  }
}
