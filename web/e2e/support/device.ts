/**
 * Ein „Gerät" im Test: der echte Kern (`createCore`) mit eigener lokaler Datenbank, eigener
 * Uhr und einem `fetch`, das zum echten Server führt.
 *
 * Der Kern gleicht nur ab, wenn der Test es sagt (`autoSync: false`), außer ein Test will
 * gerade das selbsttätige Abgleichen sehen.
 */
import Dexie from "dexie";

import { CoreError, type CoreErrorCode, type Live, type Package, type SessionDevice, type SyncRequest, type SyncResponse, type SyncStatus } from "@/contract";
import { createCore, type StowlyCore } from "@/core";
import type { FetchLike } from "@/core/http";
import type { SchedulerTimers } from "@/core/sync/scheduler";

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

/** Eine Anfrage an einen Druckdienst (am Server unter `/print` oder direkt), wie sie hinausging. */
export interface PrintCall {
  method: string;
  /** Vollständige Adresse. */
  url: string;
  /** Pfad unterhalb des Dienstes ohne Abfrage, z. B. "/v1/jobs/…" (am Server ohne "/print"). */
  path: string;
  /** Die Kopfzeilen, Namen klein geschrieben. */
  headers: Record<string, string>;
  /** Der Rumpf als JSON, sonst null. */
  body: Record<string, unknown> | null;
  /** HTTP-Status der Antwort; null ohne Antwort. */
  status: number | null;
  /** Die Antwort ging im Test verloren, nachdem der Dienst die Anfrage bearbeitet hatte. */
  lost: boolean;
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  new Headers(init?.headers).forEach((entry, name) => {
    result[name.toLowerCase()] = entry;
  });
  return result;
}

/** Die Leitung eines Geräts zum Server, mit Eingriffen für die Tests. */
export class Network {
  /** false: Keine Anfrage erreicht den Server. Direkte Drucker steuert `unreachable`. */
  online = true;
  /** Ursprünge direkter Drucker, die das Gerät gerade nicht erreicht (nicht im WLAN des Pi). */
  readonly unreachable = new Set<string>();
  /** So viele der nächsten Antworten auf einen Abgleich gehen verloren, nachdem der Server sie verbucht hat. */
  loseSyncResponses = 0;
  /** So viele der nächsten Antworten auf das Einreichen eines Druckauftrags gehen verloren, nachdem der Dienst ihn bearbeitet hat. */
  loseSubmitResponses = 0;
  /** Die nächste Anfrage eines Abgleichs ist so lange unterwegs, bevor sie beim Server ankommt. */
  delayNextSyncMs = 0;
  /** Ein langsamer Server: Jede Anfrage eines Abgleichs wartet darauf, bevor sie beim Server ankommt. */
  holdSyncs: Promise<void> | null = null;
  /** Verändert den Rumpf jeder Sync-Anfrage, bevor sie hinausgeht (z. B. eine andere Protokollversion). */
  rewriteSyncRequest: ((body: Record<string, unknown>) => void) | null = null;
  /** Alle Abgleiche dieses Geräts in ihrer Reihenfolge. */
  readonly syncs: SyncExchange[] = [];
  /** Alle Anfragen an Druckdienste in ihrer Reihenfolge. */
  readonly printCalls: PrintCall[] = [];

  constructor(private readonly baseUrl: string) {}

  /** Die Aufträge, die dieses Gerät eingereicht hat (`POST /v1/jobs/{id}`), in ihrer Reihenfolge. */
  submits(jobId?: string): PrintCall[] {
    return this.printCalls.filter((call) => call.method === "POST" && /^\/v1\/jobs\/[^/]+$/.test(call.path) && (jobId === undefined || call.path === `/v1/jobs/${jobId}`));
  }

  readonly fetch: FetchLike = async (input, init) => {
    if (/^https?:\/\//.test(input)) {
      return this.direct(input, init);
    }
    if (!this.online) {
      throw new TypeError("fetch failed (Netz im Test abgeschaltet)");
    }
    if (input.startsWith("/print/")) {
      return this.print(this.baseUrl + input, input.slice("/print".length), init);
    }
    if (input === "/api/sync" && this.delayNextSyncMs > 0) {
      const delay = this.delayNextSyncMs;
      this.delayNextSyncMs = 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    if (input === "/api/sync" && this.holdSyncs) {
      await this.holdSyncs;
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

  /** Eine Anfrage an einen direkten Drucker (Pi): eigene Adresse, ohne den Server. */
  private direct(url: string, init: RequestInit | undefined): Promise<Response> {
    const target = new URL(url);
    if (this.unreachable.has(target.origin)) {
      return Promise.reject(new TypeError("fetch failed (Druckdienst im Test nicht erreichbar)"));
    }
    return this.print(url, target.pathname, init);
  }

  /** Eine Anfrage an einen Druckdienst: aufzeichnen und, wenn der Test es will, die Antwort verlieren. */
  private async print(url: string, pathWithQuery: string, init: RequestInit | undefined): Promise<Response> {
    const path = pathWithQuery.split("?")[0] ?? pathWithQuery;
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    const call: PrintCall = { method: init?.method ?? "GET", url, path, headers: headersOf(init), body, status: null, lost: false };
    this.printCalls.push(call);
    const response = await fetch(url, init);
    call.status = response.status;
    const submit = call.method === "POST" && /^\/v1\/jobs\/[^/]+$/.test(path);
    if (submit && this.loseSubmitResponses > 0) {
      this.loseSubmitResponses -= 1;
      call.lost = true;
      await response.arrayBuffer().catch(() => undefined);
      throw new TypeError("fetch failed (Antwort im Test verloren)");
    }
    return response;
  }

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

  /**
   * Die Packungen, wie der Server sie diesem Gerät zuletzt gemeldet hat (die spätere Antwort gilt),
   * mit seinen wirksamen Zeitpunkten. Auch die, die der Kern jenseits der Aufbewahrungsdauer nicht
   * mehr zeigt.
   */
  serverPackages(): Map<string, Package> {
    const result = new Map<string, Package>();
    for (const exchange of this.syncs) {
      for (const pkg of exchange.response?.changes.packages ?? []) {
        result.set(pkg.id, pkg);
      }
    }
    return result;
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

/**
 * Wartet, bis `check` wahr ist: für das, was ein Kern im Hintergrund tut (das Nachfragen beim
 * Druckdienst). Wirft nach `timeoutMs` mit `what` im Text.
 */
export async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`Nach ${timeoutMs / 1000} s noch nicht erreicht: ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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

export interface DeviceOptions {
  /**
   * true: Der Kern gleicht von selbst ab wie in der App (nach Änderungen, alle 60 Sekunden) und
   * prüft nebenbei, ob der Server erreichbar ist. Vorgabe false.
   */
  autoSync?: boolean;
  /** Zeitgeber von Hand für die Wartezeiten des Kerns (`ManualTimers`); Vorgabe: die echten. */
  timers?: SchedulerTimers;
}

export class Device {
  readonly clock = new DeviceClock();
  readonly net: Network;
  readonly dbName: string;
  core: StowlyCore;
  private readonly tabs: StowlyCore[] = [];

  constructor(
    readonly baseUrl: string,
    readonly name: string,
    private readonly options: DeviceOptions = {},
  ) {
    counter += 1;
    this.dbName = `stowly-e2e-${process.pid}-${counter}`;
    this.net = new Network(baseUrl);
    this.core = this.open();
    devices.push(this);
  }

  private open(): StowlyCore {
    return createCore({ fetch: this.net.fetch, now: this.clock.now, dbName: this.dbName, autoSync: this.options.autoSync ?? false, timers: this.options.timers });
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
