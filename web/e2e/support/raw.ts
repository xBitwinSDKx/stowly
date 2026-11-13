/**
 * Ein Gerät ohne Kern: spricht die Schnittstelle des Servers direkt.
 *
 * Damit prüfen die Tests, was wirklich im Server steht (ein frischer vollständiger Abzug,
 * das Ereignisprotokoll), und stellen Lagen her, die ein Kern von sich aus nie erzeugt
 * (eine Packungs-ID, die ein anderes Gerät reserviert hat).
 */
import { randomUUID } from "node:crypto";

import { expect } from "vitest";

import {
  ID_POOL_TARGET,
  PROTOCOL_VERSION,
  type Changes,
  type Command,
  type EventPage,
  type EventRecord,
  type HouseholdSettings,
  type LabelTemplate,
  type LoginResponse,
  type Package,
  type Printer,
  type PrinterStatus,
  type PrintJob,
  type Product,
  type SyncRequest,
  type SyncResponse,
  type Zone,
} from "@/contract";

import { PASSWORD, value, type Device } from "./device";

/** Der Bestand des Servers, wie ihn ein frischer vollständiger Abzug liefert. */
export interface Snapshot {
  products: Product[];
  zones: Zone[];
  packages: Package[];
  printers: Printer[];
  printer_status: PrinterStatus[];
  print_jobs: PrintJob[];
  label_templates: LabelTemplate[];
  settings: HouseholdSettings | null;
  /** Die Antworten, aus denen der Abzug besteht. */
  pages: SyncResponse[];
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Ein Befehl ohne Kennung und Zeitpunkt; beides ergänzt `RawClient.send`. */
export type RawCommand = DistributiveOmit<Command, "id" | "at"> & { id?: string; at?: string };

const LISTS = ["products", "zones", "packages", "printers", "printer_status", "print_jobs", "label_templates"] as const;

function keyOf(table: (typeof LISTS)[number], row: object): string {
  const record = row as Record<string, unknown>;
  return String(table === "printer_status" ? record.printer_id : table === "label_templates" ? record.key : record.id);
}

export class RawClient {
  private datasetId: string | null = null;
  private cursor = 0;

  private constructor(
    readonly baseUrl: string,
    readonly token: string,
    readonly deviceId: string,
  ) {}

  /** Meldet ein weiteres Gerät an, das nur über die Schnittstelle spricht. */
  static async login(baseUrl: string, name = "Prüfer"): Promise<RawClient> {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD, device_name: name }),
    });
    if (!response.ok) {
      throw new Error(`Anmeldung des Prüfgeräts gescheitert: ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as LoginResponse;
    return new RawClient(baseUrl, body.token, body.device.id);
  }

  request(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, accept: "application/json" };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    return fetch(this.baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  /** Ein Sync-Aufruf, wie er dasteht. Liefert Status und Rumpf, auch bei einem Fehler. */
  async syncRaw(request: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const response = await this.request("POST", "/api/sync", request);
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  private async syncOnce(request: SyncRequest): Promise<SyncResponse> {
    const { status, body } = await this.syncRaw(request as unknown as Record<string, unknown>);
    if (status !== 200) {
      throw new Error(`Sync des Prüfgeräts gescheitert: ${status} ${JSON.stringify(body)}`);
    }
    return body as SyncResponse;
  }

  /**
   * Sendet Befehle, als wären sie vor `ageMs` Millisekunden entstanden, und liest alle Seiten
   * der Antwort. Liefert die erste Antwort (mit den Ergebnissen).
   */
  async send(commands: readonly RawCommand[], options: { ageMs?: number } = {}): Promise<SyncResponse> {
    const now = Date.now();
    const at = new Date(now - (options.ageMs ?? 0)).toISOString();
    const first = await this.syncOnce({
      protocol: PROTOCOL_VERSION,
      dataset_id: this.datasetId,
      cursor: this.cursor,
      sent_at: new Date(now).toISOString(),
      commands: commands.map((command) => ({ id: randomUUID(), at, ...command }) as Command),
      // Ein Prüfgerät lagert nichts ein: Es will keine Packungs-IDs.
      id_pool: { have: ID_POOL_TARGET },
    });
    let page = first;
    while (page.has_more) {
      page = await this.syncOnce({
        protocol: PROTOCOL_VERSION,
        dataset_id: page.dataset_id,
        cursor: page.cursor,
        sent_at: new Date().toISOString(),
        commands: [],
        id_pool: { have: ID_POOL_TARGET },
      });
    }
    this.datasetId = page.dataset_id;
    this.cursor = page.cursor;
    return first;
  }

  /** Ein frischer vollständiger Abzug über alle Seiten. Ändert den gemerkten Stand von `send` nicht. */
  async snapshot(): Promise<Snapshot> {
    const pages: SyncResponse[] = [];
    let request: SyncRequest = {
      protocol: PROTOCOL_VERSION,
      dataset_id: null,
      cursor: 0,
      sent_at: new Date().toISOString(),
      commands: [],
      id_pool: { have: ID_POOL_TARGET },
    };
    for (;;) {
      const page = await this.syncOnce(request);
      pages.push(page);
      if (!page.has_more) {
        break;
      }
      request = { ...request, dataset_id: page.dataset_id, cursor: page.cursor, sent_at: new Date().toISOString() };
    }
    const merged = Object.fromEntries(LISTS.map((table) => [table, new Map<string, object>()])) as Record<(typeof LISTS)[number], Map<string, object>>;
    let settings: HouseholdSettings | null = null;
    for (const page of pages) {
      const changes: Changes = page.changes;
      for (const table of LISTS) {
        for (const row of changes[table]) {
          merged[table].set(keyOf(table, row), row);
        }
      }
      settings = changes.settings ?? settings;
    }
    const list = <T>(table: (typeof LISTS)[number]): T[] => [...merged[table].values()] as T[];
    return {
      products: list<Product>("products"),
      zones: list<Zone>("zones"),
      packages: list<Package>("packages"),
      printers: list<Printer>("printers"),
      printer_status: list<PrinterStatus>("printer_status"),
      print_jobs: list<PrintJob>("print_jobs"),
      label_templates: list<LabelTemplate>("label_templates"),
      settings,
      pages,
    };
  }

  /** Das Ereignisprotokoll, neueste zuerst, gefiltert wie `GET /api/events`. */
  async events(filter: { entity?: string; entity_id?: string; limit?: number } = {}): Promise<EventRecord[]> {
    const query = new URLSearchParams();
    for (const [key, entry] of Object.entries(filter)) {
      if (entry !== undefined) {
        query.set(key, String(entry));
      }
    }
    const response = await this.request("GET", `/api/events?${query.toString()}`);
    if (!response.ok) {
      throw new Error(`Ereignisprotokoll nicht lesbar: ${response.status}`);
    }
    return ((await response.json()) as EventPage).events;
  }
}

function byId<T extends { id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Erwartet, dass das Gerät genau das zeigt, was ein frischer vollständiger Abzug des Servers
 * enthält. Gilt nach einem gelungenen Abgleich ohne Rest in der Outbox.
 *
 * Das ist die schärfste Prüfung der lokalen Vorwegnahme: Was der Kern beim Ändern selbst
 * ausgerechnet hat, ist nach dem Abgleich durch den Stand des Servers ersetzt, und der
 * muss über die Änderungsfolge derselbe sein wie über einen Abzug.
 */
export async function expectSameAsServer(device: Device, raw: RawClient): Promise<Snapshot> {
  const server = await raw.snapshot();
  const data = device.core.data;
  expect(value(device.core.sync.status).pending, `${device.name}: Outbox`).toBe(0);
  expect(value(data.settings), `${device.name}: Einstellungen`).toEqual(server.settings);
  expect(byId(value(data.zones)), `${device.name}: Zonen`).toEqual(byId(server.zones.filter((zone) => zone.deleted_at === null)));
  expect(byId(value(data.products)), `${device.name}: Produkte`).toEqual(byId(server.products.filter((product) => product.deleted_at === null)));
  expect(byId([...value(data.packages), ...value(data.removedPackages)]), `${device.name}: Packungen`).toEqual(byId(server.packages));
  expect(byId(value(data.printers)), `${device.name}: Drucker`).toEqual(byId(server.printers.filter((printer) => printer.deleted_at === null)));
  expect(byId(value(data.printJobs)), `${device.name}: Etiketten`).toEqual(byId(server.print_jobs));
  expect(
    [...value(data.printerStatus)].sort((a, b) => a.printer_id.localeCompare(b.printer_id)),
    `${device.name}: Zustand der Drucker`,
  ).toEqual([...server.printer_status].sort((a, b) => a.printer_id.localeCompare(b.printer_id)));
  return server;
}
