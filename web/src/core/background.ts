/**
 * Abgleich im Hintergrund (docs/sync-protokoll.md, 9.4): Auf Android weckt der Browser den
 * Service Worker, sobald wieder Netz da ist (Background Sync, Kennung `stowly-sync`), auch
 * wenn die App geschlossen ist. Safari kann das nicht.
 *
 * Der Service Worker benutzt dafür denselben Store und denselben Abgleich wie die Seite:
 * dieselbe Datenbank, dieselbe Sperre. Offene Tabs erfahren über den Zähler der Datenbank
 * und den BroadcastChannel des Stores, dass sich etwas getan hat.
 *
 * Ohne DOM: Diese Datei läuft im Service Worker.
 */
import { ApiClient, type FetchLike } from "./http";
import { Store } from "./store";
import { SyncEngine, type SyncOutcome } from "./sync/engine";
import { SYNC_LOCK_NAME } from "./sync/lock";
import { DEFAULT_DB_NAME } from "./db";

/** Kennung des Abgleichs im Hintergrund; dieselbe meldet die Seite an (src/core/index.ts). */
export const BACKGROUND_SYNC_TAG = "stowly-sync";

export interface BackgroundSyncOptions {
  fetch?: FetchLike;
  now?: () => Date;
  dbName?: string;
}

/**
 * Sendet die wartenden Befehle und holt die Änderungen, einmal.
 *
 * Wirft, wenn der Server nicht erreichbar war: Dann versucht es der Browser später erneut.
 * Ohne Anmeldung oder ohne wartende Befehle gibt es nichts zu tun.
 */
export async function runBackgroundSync(options: BackgroundSyncOptions = {}): Promise<SyncOutcome | null> {
  const dbName = options.dbName ?? DEFAULT_DB_NAME;
  const now = options.now ?? (() => new Date());
  const fetchFn: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const store = new Store({ dbName, now });
  try {
    await store.load();
    const state = store.snapshot;
    if (state.session?.status !== "signed_in" || state.outbox.length === 0) {
      return null;
    }
    const engine = new SyncEngine({
      store,
      api: new ApiClient(fetchFn),
      now,
      lockName: dbName === DEFAULT_DB_NAME ? SYNC_LOCK_NAME : `${SYNC_LOCK_NAME}:${dbName}`,
    });
    const outcome = await engine.run();
    if (!outcome.ok && outcome.error.code === "offline") {
      throw outcome.error;
    }
    return outcome;
  } finally {
    store.close();
  }
}
