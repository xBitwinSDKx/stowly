/**
 * Ein Abgleich zur Zeit je Gerät, auch über mehrere Tabs und den Service Worker hinweg
 * (docs/sync-protokoll.md, 9.4): Web Locks mit dem Namen `stowly-sync`, wo es sie gibt.
 *
 * Ohne sicheren Kontext (http://<LAN-IP>) gibt es keine Web Locks. Dort schützt eine
 * Warteschlange wenigstens vor zwei Abgleichen im selben Tab; dass zwei Tabs gleichzeitig
 * abgleichen, fängt der Store ab (eine veraltete Antwort verändert den Bestand nicht).
 *
 * Ohne DOM: Diese Datei läuft auch im Service Worker.
 */

export const SYNC_LOCK_NAME = "stowly-sync";

interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

function lockManager(): LockManagerLike | null {
  const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
  return nav?.locks && typeof nav.locks.request === "function" ? nav.locks : null;
}

const queues = new Map<string, Promise<unknown>>();

/** Führt `work` aus, sobald niemand sonst die Sperre `name` hält. */
export function withLock<T>(name: string, work: () => Promise<T>): Promise<T> {
  const locks = lockManager();
  if (locks) {
    return locks.request(name, work);
  }
  const previous = queues.get(name) ?? Promise.resolve();
  const result = previous.then(work, work);
  queues.set(
    name,
    result.catch(() => undefined),
  );
  return result;
}
