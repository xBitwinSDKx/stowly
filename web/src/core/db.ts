/**
 * Die lokale Datenbank (IndexedDB über Dexie).
 *
 * Was hier liegt:
 *
 *   products, packages, zones, printers,      der Stand des Servers, so wie ihn die Antworten
 *   printer_status, print_jobs,               geliefert haben, nie mit eigenen, unbestätigten
 *   label_templates, shopping_items,          Änderungen vermischt (shopping_items seit Version 3)
 *   kv["settings"]
 *   outbox                                    die wartenden Befehle in der Reihenfolge ihrer Entstehung
 *   id_pool                                   der Vorrat an Packungs-IDs in der Reihenfolge der Zuteilung
 *   problems                                  abgelehnte und verdrängte Befehle
 *   deliveries                                Buchführung des Zustellens: je Etikett, was an welchen
 *                                             Druckdienst hinausging (seit Version 2; nie im Sync)
 *   kv                                        Einzelwerte: Sitzung, Sync-Stand, Geräte-Einstellungen
 *
 * Was die App anzeigt, steht nirgends: Es ist immer „Stand des Servers plus wartende Befehle"
 * und wird daraus berechnet (src/core/store.ts). Eine Änderung des Anwenders ist damit genau
 * ein Schreibvorgang, nämlich der Befehl in der Outbox, und Anzeige und Outbox können nie
 * auseinanderlaufen.
 *
 * Ohne DOM: Diese Datei läuft auch im Service Worker.
 */
import Dexie, { type Table, type Transaction } from "dexie";

import type { Command, HouseholdSettings, LabelTemplate, Package, Printer, PrinterStatus, PrintJob, Product, ShoppingItem, Zone } from "@/contract/api.gen";
import type { DevicePrefs, SessionDevice, SyncProblem } from "@/contract/core";

export const DEFAULT_DB_NAME = "stowly";

/**
 * Version des Aufbaus der lokalen Datenbank. Öffnet ein Tab mit einer neueren App die Datenbank
 * in einer höheren Version, müssen ältere Tabs ihre Verbindung schließen (`versionchange`,
 * siehe src/core/store.ts).
 *
 * - 1: Stufe 1
 * - 2: die Buchführung des Zustellens (`deliveries`)
 * - 3: Protokoll 2 (Stufe 2): die Einkaufsliste (`shopping_items`). Der Umstieg holt den Bestand
 *      einmal vollständig neu (`upgradeToV3`).
 */
export const DB_VERSION = 3;

/** Die Uhrzeit der Tagesnachricht, die der Server für einen schon bestehenden Haushalt annimmt (Migration 0003). */
const DEFAULT_NOTIFY_TIME = "17:00";

export interface OutboxEntry {
  /** Laufende Nummer: die Reihenfolge, in der der Anwender gehandelt hat. */
  seq: number;
  /** Kennung des Befehls. */
  id: string;
  command: Command;
}

export interface PoolEntry {
  /** Laufende Nummer: die Reihenfolge der Zuteilung. */
  n: number;
  id: string;
}

export interface StoredProblem extends SyncProblem {
  /** Laufende Nummer des Eintreffens, für eine stabile Reihenfolge bei gleichem `at`. */
  recorded: number;
}

/** Der Inhalt eines Druckauftrags (docs/etiketten.md, 5.4): Was hier steht, bestimmt `content_hash`. */
export interface DeliveryContent {
  /** Name des Druckers im Dienst: am Server die `Printer.id`, am Pi `direct.printer` (null = Standarddrucker). */
  printer: string | null;
  /** `LabelTemplate.body`, unverändert. */
  template: { [key: string]: unknown };
  /** Fertig formatierte Zeichenketten des Etiketts. */
  data: { [key: string]: string };
  copies: number;
  cut: boolean;
}

/**
 * Buchführung des Zustellens für ein Etikett (docs/etiketten.md, 4.1, Schritt 3).
 *
 * Der Eintrag entsteht, **bevor** der Auftrag zum ersten Mal hinausgeht. Daran hängt „nie
 * doppelt": Gibt es ihn, kann der Auftrag unterwegs sein, und jede Wiederholung schickt genau
 * diesen Inhalt mit genau dieser `boot_id`. Gibt es keinen, ist nie etwas hinausgegangen.
 *
 * - "sending":  festgeschrieben und vielleicht abgeschickt, bisher ohne Antwort
 * - "accepted": Der Dienst hat den Auftrag angenommen (das Etikett ist "queued" oder weiter).
 * - "handoff":  an die Seite des Druckdienstes übergeben (5.7); `content` und `boot_id` sind
 *               dann null, denn eingereicht hat die Seite, nicht die App.
 */
export interface DeliveryEntry {
  /** Kennung des Etiketts, zugleich die des Auftrags beim Druckdienst. */
  job_id: string;
  /** Der Drucker, an den der Auftrag geht (`Printer.id`). */
  printer_id: string;
  /** Basis-Adresse, über die abgeschickt wurde; "" beim Druckdienst des Servers. */
  url: string;
  /** `boot_id` aus der Abfrage vor dem ersten Absenden, nach dem Annehmen die aus der Antwort. */
  boot_id: string | null;
  content: DeliveryContent | null;
  phase: "sending" | "accepted" | "handoff";
  /** Wann der Eintrag entstand (Geräteuhr). */
  created_at: string;
}

/**
 * Die Sitzung dieses Geräts. Fehlt der Eintrag, war das Gerät noch nie angemeldet.
 *
 * - "signed_in": Das Token gilt.
 * - "revoked":   Der Server hat das Token gesperrt. Daten und Outbox liegen noch vor.
 * - "logout":    Der Anwender hat sich abgemeldet; die lokale Kopie ist gelöscht.
 */
export interface StoredSession {
  status: "signed_in" | "revoked" | "logout";
  token: string | null;
  /** Das angemeldete Gerät; bleibt bei "revoked" stehen, fällt bei "logout" weg. */
  device: SessionDevice | null;
  /** Nach dem Abmelden: der Name, den das Gerät zuletzt trug (Vorschlag für die Anmeldung). */
  last_device_name?: string | null;
}

export interface SyncMeta {
  /** `dataset_id` der letzten Antwort; null vor dem ersten Abgleich. */
  dataset_id: string | null;
  /** `cursor` der letzten Antwort. */
  cursor: number;
  /** Letzter erfolgreicher Abgleich nach der Geräteuhr. */
  last_synced_at: string | null;
  /** Serverzeit minus Geräteuhr beim letzten Abgleich, in Millisekunden. */
  clock_offset_ms: number;
  /** Beim nächsten Abgleich den Bestand vollständig neu holen (Aufbewahrungsdauer vergrößert). */
  full_resync: boolean;
  /** `lookup_enabled` der letzten Antwort: Schlägt der Server Barcodes nach? null = unbekannt. */
  lookup_enabled: boolean | null;
}

export const INITIAL_SYNC_META: SyncMeta = {
  dataset_id: null,
  cursor: 0,
  last_synced_at: null,
  clock_offset_ms: 0,
  full_resync: false,
  lookup_enabled: null,
};

/**
 * Was ein Abgleich gerade sendet (docs/sync-protokoll.md, 9.1): Befehle der Outbox bis
 * einschließlich der laufenden Nummer `upto` können unterwegs sein, seit `at` (Geräteuhr in
 * Millisekunden). Fehlt der Eintrag, ist nichts unterwegs.
 */
export interface SendingMark {
  upto: number;
  at: number;
}

export interface KvValues {
  /** Zähler: wächst mit jedem Schreibvorgang. Daran erkennt ein Tab, dass ein anderer geschrieben hat. */
  seq: number;
  /**
   * Was ein Abgleich gerade sendet, über Tabs und den Service Worker hinweg. Steht nie im
   * Arbeitsspeicher und zählt `seq` nicht hoch: Wer es braucht, liest es in seiner Transaktion.
   */
  sending: SendingMark;
  session: StoredSession;
  sync: SyncMeta;
  settings: HouseholdSettings;
  prefs: DevicePrefs;
  /** Tokens, die beim Server noch gesperrt werden müssen (Abmelden ohne Netz). */
  revocations: readonly string[];
  /**
   * Adressräume ("local", "loopback"), in denen dieses Gerät einen Druckdienst erreicht hat,
   * obwohl der Browser die Erlaubnis für das lokale Netzwerk als „noch offen" meldet: Dort
   * fragt er gar nicht (src/core/print/connect.ts).
   */
  open_networks: readonly string[];
}

export interface KvEntry<K extends keyof KvValues = keyof KvValues> {
  key: K;
  value: KvValues[K];
}

/**
 * Der Umstieg von Version 2 auf 3 (Protokoll 2, docs/sync-protokoll.md 6.5): Die gespeicherten
 * Datensätze aus Protokoll 1 kennen `min_stock`, `notify_time` und die Einkaufsliste noch nicht.
 *
 * - Der nächste Abgleich holt den Bestand einmal vollständig neu (`full_resync`: Die Anfrage geht
 *   mit `dataset_id: null` und `cursor: 0` hinaus, der Server antwortet mit `reset`).
 * - Bis dahin bekommen die alten Datensätze die neuen Felder mit den Vorgaben des Protokolls
 *   (`min_stock: null`, `notify_time: "17:00"`): Ein Gerät, das die neue App im Keller ohne Netz
 *   bekommt, arbeitet so weiter, und die Oberfläche sieht nie ein fehlendes Feld.
 * - Outbox, ID-Vorrat, Sync-Probleme, Geräte-Einstellungen und Anmeldung bleiben, wie sie sind.
 *   Befehle aus Protokoll 1 nimmt der Server weiter an.
 */
export async function upgradeToV3(tx: Transaction): Promise<void> {
  const kv = tx.table<KvEntry, string>("kv");
  const sync = (await kv.get("sync"))?.value as Partial<SyncMeta> | undefined;
  if (sync !== undefined) {
    await kv.put({ key: "sync", value: { ...INITIAL_SYNC_META, ...sync, full_resync: true } });
  }
  const settings = (await kv.get("settings"))?.value as (Partial<HouseholdSettings> & Omit<HouseholdSettings, "notify_time">) | undefined;
  if (settings !== undefined && typeof settings.notify_time !== "string") {
    await kv.put({ key: "settings", value: { ...settings, notify_time: DEFAULT_NOTIFY_TIME } });
  }
  await tx
    .table<Product, string>("products")
    .toCollection()
    .modify((product) => {
      if (product.min_stock === undefined) {
        product.min_stock = null;
      }
    });
}

export class StowlyDb extends Dexie {
  products!: Table<Product, string>;
  packages!: Table<Package, string>;
  zones!: Table<Zone, string>;
  printers!: Table<Printer, string>;
  printer_status!: Table<PrinterStatus, string>;
  print_jobs!: Table<PrintJob, string>;
  label_templates!: Table<LabelTemplate, string>;
  shopping_items!: Table<ShoppingItem, string>;
  outbox!: Table<OutboxEntry, number, Omit<OutboxEntry, "seq">>;
  id_pool!: Table<PoolEntry, number, Omit<PoolEntry, "n">>;
  problems!: Table<StoredProblem, string>;
  deliveries!: Table<DeliveryEntry, string>;
  kv!: Table<KvEntry, string>;

  constructor(name: string = DEFAULT_DB_NAME) {
    super(name);
    // Ausgewertet wird im Arbeitsspeicher; die Datenbank braucht nur die Schlüssel.
    this.version(1).stores({
      products: "id",
      packages: "id",
      zones: "id",
      printers: "id",
      printer_status: "printer_id",
      print_jobs: "id",
      label_templates: "key",
      outbox: "++seq, &id",
      id_pool: "++n, &id",
      problems: "id",
      kv: "key",
    });
    // Version 2 (Runde 2): die Buchführung des Zustellens. Alles Bisherige bleibt, wie es ist.
    this.version(2).stores({
      deliveries: "job_id",
    });
    // Version 3 (Stufe 2, Protokoll 2): die Einkaufsliste; der Umstieg holt alles einmal neu.
    this.version(DB_VERSION)
      .stores({
        shopping_items: "id",
      })
      .upgrade(upgradeToV3);
  }

  async readKv<K extends keyof KvValues>(key: K): Promise<KvValues[K] | undefined> {
    const entry = await this.kv.get(key);
    return entry?.value as KvValues[K] | undefined;
  }

  async writeKv<K extends keyof KvValues>(key: K, value: KvValues[K]): Promise<void> {
    await this.kv.put({ key, value } as KvEntry);
  }
}
