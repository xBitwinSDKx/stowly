/**
 * Ein Abgleich zur Zeit je Gerät, auch über mehrere Tabs und den Service Worker hinweg
 * (docs/sync-protokoll.md, 9.4): Web Locks mit dem Namen `stowly-sync`, wo es sie gibt.
 * Dieselbe Sperre (unter eigenem Namen) reiht die Zustellversuche der Etiketten (src/core/print).
 *
 * Ohne sicheren Kontext (http://<LAN-IP>) gibt es keine Web Locks. Dort schützt eine
 * Warteschlange wenigstens vor zwei Abgleichen im selben Tab; dass zwei Tabs gleichzeitig
 * abgleichen, fängt der Store ab (eine veraltete Antwort verändert den Bestand nicht).
 *
 * Ohne DOM: Diese Datei läuft auch im Service Worker.
 */

export const SYNC_LOCK_NAME = "stowly-sync";

/**
 * So oft sieht der Halter einer Sperre nach, ob jemand anderes auf sie wartet (`onLockWanted`
 * mit Web Locks). Ein Fünftel Sekunde: kaum spürbar für den Wartenden, kaum Last für den Halter.
 */
export const LOCK_WANTED_POLL_MS = 200;

interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
  query?(): Promise<{ pending?: { name?: string }[] }>;
}

function lockManager(): LockManagerLike | null {
  const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
  return nav?.locks && typeof nav.locks.request === "function" ? nav.locks : null;
}

/** Ohne Web Locks: die Warteschlange je Name, wie viele darin warten, und wer das wissen will. */
const queues = new Map<string, Promise<unknown>>();
const waiting = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();

/** Führt `work` aus, sobald niemand sonst die Sperre `name` hält. */
export function withLock<T>(name: string, work: () => Promise<T>): Promise<T> {
  const locks = lockManager();
  if (locks) {
    return locks.request(name, work);
  }
  waiting.set(name, (waiting.get(name) ?? 0) + 1);
  for (const listener of [...(listeners.get(name) ?? [])]) {
    listener();
  }
  const run = (): Promise<T> => {
    waiting.set(name, (waiting.get(name) ?? 1) - 1);
    return work();
  };
  const previous = queues.get(name) ?? Promise.resolve();
  const result = previous.then(run, run);
  queues.set(
    name,
    result.catch(() => undefined),
  );
  return result;
}

/**
 * Für den Halter einer Sperre, der etwas tut, das warten kann (das Nachfragen beim
 * Druckdienst): ruft `callback`, sobald jemand anderes die Sperre will, auch aus einem anderen
 * Tab. Mit Web Locks wird dafür regelmäßig nachgesehen (`navigator.locks.query`), ohne sie meldet
 * die Warteschlange dieses Fensters es sofort. Liefert die Funktion zum Abmelden.
 */
export function onLockWanted(name: string, callback: () => void): () => void {
  let stopped = false;
  const notify = () => {
    if (!stopped) {
      callback();
    }
  };
  const locks = lockManager();
  if (locks) {
    const query = locks.query;
    if (typeof query !== "function") {
      return () => undefined;
    }
    const look = () => {
      query.call(locks).then(
        (snapshot) => {
          if ((snapshot.pending ?? []).some((lock) => lock.name === name)) {
            notify();
          }
        },
        () => undefined,
      );
    };
    look();
    const timer = setInterval(look, LOCK_WANTED_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }
  const set = listeners.get(name) ?? new Set<() => void>();
  set.add(notify);
  listeners.set(name, set);
  if ((waiting.get(name) ?? 0) > 0) {
    // Es wartet schon jemand.
    queueMicrotask(notify);
  }
  return () => {
    stopped = true;
    set.delete(notify);
  };
}
