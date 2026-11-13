/**
 * Der echte Offline-Kern: lokale Datenbank, Outbox, Sync, ID-Vorrat, Sitzung.
 *
 * Die Nahtstelle zu src/entry.real.ts:
 *
 *   export function createCore(): Core
 *
 * `createCore` kehrt sofort zurück. Der Kern lädt seinen Zustand danach selbst und meldet
 * solange `session.state = { status: "loading" }`.
 *
 * Aufbau (alles in diesem Ordner):
 *
 *   db.ts              die Datenbank: Stand des Servers, Outbox, ID-Vorrat, Einzelwerte
 *   tables.ts          Datensätze im Arbeitsspeicher, Entwurf, Abgleich von Referenzen
 *   commands/apply.ts  die Wirkung jedes Befehls auf einen Datenbestand
 *   store.ts           Zustand: Anzeige = Stand des Servers + wartende Befehle
 *   http.ts            Aufrufe an den Server, Fehler als CoreError
 *   sync/              Abgleich (engine), Anlässe und Wartezeiten (scheduler), Sperre, Aufbewahrung
 *   api/               die Teile der Schnittstelle `Core`
 *   images.ts          Produktbilder vorab laden
 *   background.ts      Abgleich im Service Worker
 *   scanner/           Kamera, Erkennung, Ton und Vibration
 */
import { APP_VERSION, CoreError, type AppState, type Core, type Device, type SessionState, type SyncProblem, type SyncStatus } from "@/contract";

import { createProductsApi, createPrefsUpdate, createSettingsApi, createZonesApi } from "./api/catalog";
import { createDataApi } from "./api/data";
import { createPrintApi, createPrintersApi } from "./api/printing";
import { toCoreError, type CoreRuntime } from "./api/runtime";
import { createStockApi } from "./api/stock";
import { checkDeviceName, invalid, LIMITS } from "./api/validate";
import { BACKGROUND_SYNC_TAG } from "./background";
import { DEFAULT_DB_NAME, type StoredSession } from "./db";
import { ApiClient, type FetchLike } from "./http";
import { clearImages, preloadImages } from "./images";
import { derived, Signal } from "./live";
import { registerServiceWorker } from "./pwa/register";
import { Store, type StoreState } from "./store";
import { SyncEngine, type SyncOutcome, type SyncRunOptions } from "./sync/engine";
import { SYNC_LOCK_NAME } from "./sync/lock";
import { SyncScheduler, type SchedulerTimers } from "./sync/scheduler";

export interface CoreOptions {
  /** Eigenes `fetch`, z. B. die nachgebaute Schnittstelle in Tests. Vorgabe: das des Browsers. */
  fetch?: FetchLike;
  /** Eigene Uhr. Vorgabe: die des Geräts. */
  now?: () => Date;
  /** Name der lokalen Datenbank. Vorgabe "stowly". */
  dbName?: string;
  /**
   * false: Der Kern gleicht nie von selbst ab (kein Start-Abgleich, keine Zeitgeber, keine
   * Ereignisse des Browsers), sondern nur über `sync.now()` und `session.login()`. Für Tests.
   */
  autoSync?: boolean;
  /** Eigene Zeitgeber für die Wartezeiten des Abgleichs. Für Tests. */
  timers?: SchedulerTimers;
}

export interface StowlyCore extends Core {
  /** Erfüllt sich, sobald der gespeicherte Zustand geladen ist. */
  readonly ready: Promise<void>;
  /** Beendet Zeitgeber und Ereignisse und schließt die Datenbank. Danach ist der Kern nicht mehr benutzbar. */
  dispose(): void;
}

const LOADING: SessionState = { status: "loading" };

function sessionState(session: StoredSession | null): SessionState {
  if (session?.status === "signed_in" && session.device) {
    return { status: "signed_in", device: session.device };
  }
  // Der zuletzt bekannte Name: Die Anmeldung schlägt ihn vor.
  const lastName = session?.device?.name ?? session?.last_device_name ?? null;
  if (session?.status === "revoked") {
    return { status: "signed_out", reason: "revoked", last_device_name: lastName };
  }
  if (session?.status === "logout") {
    return { status: "signed_out", reason: "logout", last_device_name: lastName };
  }
  return { status: "signed_out", reason: "never", last_device_name: null };
}

function sameError(a: SyncStatus["last_error"], b: SyncStatus["last_error"]): boolean {
  return a === b || (a !== null && b !== null && a.code === b.code && a.message === b.message && a.at === b.at);
}

function isInstalled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const standalone = typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches;
  return standalone || (navigator as { standalone?: boolean }).standalone === true;
}

export function createCore(options: CoreOptions = {}): StowlyCore {
  const now = options.now ?? (() => new Date());
  const autoSync = options.autoSync ?? true;
  const dbName = options.dbName ?? DEFAULT_DB_NAME;
  const fetchFn: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const hasWindow = typeof window !== "undefined" && typeof document !== "undefined";

  const store = new Store({ dbName, now });
  const api = new ApiClient(fetchFn);
  let disposed = false;
  /** false, wenn der Browser keine lokale Datenbank zulässt. */
  let storageAvailable = true;

  // ---------------------------------------------------------------- Zustand der App

  const app = new Signal<AppState>({
    version: APP_VERSION,
    // Über http://<LAN-IP> verweigert der Browser Kamera, Offline-Betrieb und Installation.
    secure_context: typeof globalThis.isSecureContext === "boolean" ? globalThis.isSecureContext : true,
    installed: isInstalled(),
    can_install: false,
    manual_install: null,
    update_ready: false,
    update_required: false,
    storage_persistent: null,
  });

  function patchApp(changes: Partial<AppState>): void {
    app.update((current) => {
      const next = { ...current, ...changes };
      return (Object.keys(next) as (keyof AppState)[]).every((key) => next[key] === current[key]) ? current : next;
    });
  }

  async function checkPersistence(request: boolean): Promise<void> {
    const storage = (globalThis.navigator as { storage?: StorageManager } | undefined)?.storage;
    try {
      if (request && typeof storage?.persist === "function") {
        patchApp({ storage_persistent: await storage.persist() });
      } else if (typeof storage?.persisted === "function") {
        patchApp({ storage_persistent: await storage.persisted() });
      }
    } catch {
      // Unbekannt bleibt unbekannt.
    }
  }

  // ---------------------------------------------------------------- Status des Abgleichs

  const status = new Signal<SyncStatus>({
    online: null,
    phase: "idle",
    pending: 0,
    last_synced_at: null,
    last_error: null,
    server_version: null,
    lookup_enabled: null,
  });

  function patchStatus(changes: Partial<SyncStatus>): void {
    status.update((current) => {
      const next = { ...current, ...changes };
      const same =
        next.online === current.online &&
        next.phase === current.phase &&
        next.pending === current.pending &&
        next.last_synced_at === current.last_synced_at &&
        next.server_version === current.server_version &&
        next.lookup_enabled === current.lookup_enabled &&
        sameError(next.last_error, current.last_error);
      return same ? current : next;
    });
  }

  const unsubscribeStore = store.state.subscribe(() => {
    const state = store.snapshot;
    patchStatus({ pending: state.outbox.length, last_synced_at: state.meta.last_synced_at, lookup_enabled: state.meta.lookup_enabled });
  });

  const engine = new SyncEngine({
    store,
    api,
    now,
    // Der Name der Sperre steht im Protokoll; eine eigene Datenbank (Tests) bekommt eine eigene.
    lockName: dbName === DEFAULT_DB_NAME ? SYNC_LOCK_NAME : `${SYNC_LOCK_NAME}:${dbName}`,
    appVersion: APP_VERSION,
    onHealth: (health) => {
      patchStatus(health ? { online: true, server_version: health.version } : { online: false });
      if (health) {
        void flushRevocations();
      }
    },
  });

  /** Ein Abgleich samt Buchführung für `sync.status`. Wirft nicht. */
  async function runSync(runOptions?: SyncRunOptions): Promise<SyncOutcome> {
    if (disposed || !storageAvailable) {
      return { ok: false, error: new CoreError("not_supported", "Die lokale Datenbank ist nicht verfügbar.") };
    }
    patchStatus({ phase: "syncing" });
    const outcome = await engine.run(runOptions);
    if (disposed) {
      return outcome;
    }
    if (outcome.ok) {
      patchStatus({ phase: "idle", online: true, last_error: null });
      if (outcome.synced) {
        void cacheImages();
      }
    } else {
      const { code, message } = outcome.error;
      patchStatus({
        phase: "error",
        // Jeder andere Fehler ist eine Antwort des Servers: Er ist also erreichbar.
        online: code !== "offline",
        last_error: { code, message, at: now().toISOString() },
      });
      if (code === "offline" && store.snapshot.outbox.length > 0) {
        registerBackgroundSync();
      }
    }
    return outcome;
  }

  const scheduler = new SyncScheduler({
    run: () => runSync(),
    isVisible: () => !hasWindow || document.visibilityState !== "hidden",
    pendingLookups: () => {
      const result: string[] = [];
      for (const product of store.snapshot.view.products.values()) {
        if (product.lookup === "pending" && product.deleted_at === null) {
          result.push(product.id);
        }
      }
      return result;
    },
    timers: options.timers,
    auto: autoSync,
  });

  /** Lädt die Bilder der Produkte im Bestand vorab (docs/sync-protokoll.md, 9.6). */
  async function cacheImages(): Promise<void> {
    const view = store.snapshot.view;
    const stocked = new Set<string>();
    for (const pkg of view.packages.values()) {
      if (pkg.removed_at === null) {
        stocked.add(pkg.product_id);
      }
    }
    const wanted: string[] = [];
    const keep: string[] = [];
    for (const product of view.products.values()) {
      if (product.image === null) {
        continue;
      }
      keep.push(product.image);
      if (stocked.has(product.id)) {
        wanted.push(product.image);
      }
    }
    await preloadImages(wanted, keep, (url) => fetchFn(url));
  }

  /** Bittet den Service Worker, die Outbox zu senden, sobald wieder Netz da ist (nur Chromium). */
  function registerBackgroundSync(): void {
    if (!autoSync || !hasWindow || !("serviceWorker" in navigator)) {
      return;
    }
    navigator.serviceWorker.ready
      .then((registration) => (registration as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }).sync?.register(BACKGROUND_SYNC_TAG))
      .catch(() => undefined);
  }

  let revoking: Promise<void> | null = null;

  /** Sperrt beim Server die Tokens, die seit einer Abmeldung ohne Netz darauf warten. */
  function flushRevocations(): Promise<void> {
    if (revoking === null) {
      const attempt = (async () => {
        try {
          for (const token of [...store.snapshot.revocations]) {
            await api.logout(token);
            await store.setRevocation(token, false);
          }
        } catch {
          // Kein Netz: beim nächsten Kontakt zum Server noch einmal.
        }
      })();
      revoking = attempt;
      // Erst nach der Zuweisung zurücksetzen: Ohne wartende Tokens endet der Versuch sofort.
      void attempt.then(() => {
        if (revoking === attempt) {
          revoking = null;
        }
      });
    }
    return revoking;
  }

  // ---------------------------------------------------------------- Start

  const ready: Promise<void> = (async () => {
    try {
      await store.load();
    } catch (error) {
      // Ohne lokale Datenbank (manche privaten Fenster) gibt es keinen Offline-Kern.
      storageAvailable = false;
      store.state.set({ ...store.snapshot, loaded: true });
      console.warn("Stowly: Die lokale Datenbank ist nicht verfügbar.", error);
    }
    if (storageAvailable) {
      // Was inzwischen jenseits der Aufbewahrung liegt, verschwindet schon beim Start (6.4).
      await store.purgeExpired().catch((error: unknown) => console.warn("Stowly: Aufräumen beim Start ist gescheitert.", error));
    }
    if (disposed) {
      return;
    }
    void checkPersistence(false);
    if (autoSync) {
      void scheduler.request();
    }
  })();

  // ---------------------------------------------------------------- Ereignisse des Browsers

  const cleanups: (() => void)[] = [unsubscribeStore];
  if (hasWindow && autoSync) {
    const listen = (target: EventTarget, type: string, handler: () => void) => {
      target.addEventListener(type, handler);
      cleanups.push(() => target.removeEventListener(type, handler));
    };
    listen(window, "online", () => scheduler.notifyOnline());
    // Nur `false` ist verlässlich: `navigator.onLine` meldet auch im WLAN ohne Internet „online".
    listen(window, "offline", () => patchStatus({ online: false }));
    listen(document, "visibilitychange", () => {
      const visible = document.visibilityState !== "hidden";
      scheduler.notifyVisibility(visible);
      if (!visible && store.snapshot.outbox.length > 0) {
        registerBackgroundSync();
      }
    });
    listen(window, "pagehide", () => {
      if (store.snapshot.outbox.length > 0) {
        registerBackgroundSync();
      }
    });
    if (typeof window.matchMedia === "function") {
      const media = window.matchMedia("(display-mode: standalone)");
      const onChange = () => patchApp({ installed: isInstalled() });
      media.addEventListener?.("change", onChange);
      cleanups.push(() => media.removeEventListener?.("change", onChange));
    }
    registerServiceWorker();
  }

  // ---------------------------------------------------------------- Gemeinsames für die Schnittstelle

  const runtime: CoreRuntime = {
    store,
    now,
    async change(build) {
      await ready;
      if (!storageAvailable) {
        throw new CoreError("not_supported", "Die lokale Datenbank ist nicht verfügbar.");
      }
      const before = store.snapshot.outbox.length;
      try {
        const result = await store.mutate(build);
        if (store.snapshot.outbox.length > before) {
          scheduler.notifyChange();
        }
        return result;
      } catch (error) {
        throw toCoreError(error);
      }
    },
    async server(call) {
      await ready;
      const session = store.snapshot.session;
      if (session?.status !== "signed_in" || session.token === null) {
        throw new CoreError("unauthorized", "Dieses Gerät ist nicht angemeldet.");
      }
      try {
        const result = await call(session.token);
        patchStatus({ online: true });
        return result;
      } catch (error) {
        const failure = toCoreError(error);
        if (failure.code === "offline") {
          patchStatus({ online: false });
        } else if (failure.code === "unauthorized") {
          await store.markRevoked(session.token).catch(() => undefined);
        }
        throw failure;
      }
    },
  };

  let loginInFlight: Promise<void> | null = null;

  /** Meldet an und holt den Bestand; siehe `SessionApi.login`. */
  async function signIn(password: string, deviceName: string): Promise<void> {
    await ready;
    if (!storageAvailable) {
      throw new CoreError("not_supported", "Der Browser lässt keine lokale Datenbank zu (privates Fenster?). Ohne sie kann Stowly nicht arbeiten.");
    }
    const name = checkDeviceName(deviceName);
    if (typeof password !== "string" || password === "" || password.length > LIMITS.password) {
      throw new CoreError("invalid_password", "Das Passwort stimmt nicht.");
    }
    if (store.snapshot.session?.status === "signed_in") {
      throw invalid("Dieses Gerät ist schon angemeldet.");
    }
    let response;
    try {
      response = await api.login(password, name);
    } catch (error) {
      const failure = toCoreError(error);
      patchStatus({ online: failure.code !== "offline" });
      throw failure;
    }
    // Erst wenn der erste Abgleich gelungen ist, gilt das Gerät als angemeldet:
    // Dann liegen Zonen und Einstellungen sicher vor.
    const outcome = await runSync({ login: { token: response.token, device: { id: response.device.id, name: response.device.name } } });
    const session = store.snapshot.session;
    if (!outcome.ok || session?.status !== "signed_in" || session.token !== response.token) {
      // Das Gerät bleibt abgemeldet; das eben ausgestellte Token wird wieder gesperrt.
      await store.setRevocation(response.token, true).catch(() => undefined);
      void flushRevocations();
      throw outcome.ok ? new CoreError("internal", "Die Anmeldung ließ sich nicht abschließen.") : outcome.error;
    }
    void checkPersistence(true);
  }

  // ---------------------------------------------------------------- Die Schnittstelle

  const core: StowlyCore = {
    ready,

    session: {
      state: derived(
        store.state,
        (s) => [s.loaded, s.session],
        (s: StoreState) => (s.loaded ? sessionState(s.session) : LOADING),
      ),

      login(password, deviceName) {
        // Ein zweiter Aufruf während einer laufenden Anmeldung (Doppeltipp) wartet auf die erste,
        // statt ein zweites Gerät beim Server anzulegen.
        loginInFlight ??= signIn(password, deviceName).finally(() => {
          loginInFlight = null;
        });
        return loginInFlight;
      },

      async logout(logoutOptions) {
        await ready;
        let pending: number | null;
        try {
          pending = await store.logout(logoutOptions?.discard_pending === true);
        } catch (error) {
          throw toCoreError(error);
        }
        if (pending !== null) {
          throw new CoreError("pending_changes", "Es gibt ungesendete Änderungen.", { pending });
        }
        patchStatus({ phase: "idle", last_error: null });
        void clearImages();
        // Gelingt auch offline: Das Token wird gesperrt, sobald der Server erreichbar ist.
        void flushRevocations();
      },
    },

    sync: {
      status,
      problems: derived(
        store.state,
        (s) => [s.loaded, s.problems],
        (s): SyncProblem[] | undefined =>
          s.loaded
            ? [...s.problems]
                .sort((a, b) => b.at.localeCompare(a.at) || b.recorded - a.recorded)
                .map(({ id, at, status: problemStatus, code, message, command }) => ({ id, at, status: problemStatus, code, message, command }))
            : undefined,
      ),
      async now() {
        try {
          await ready;
          await scheduler.request(true);
        } catch {
          // `now` wirft nie; der Fehlschlag steht in `status.last_error`.
        }
      },
      async dismissProblem(id) {
        await ready;
        try {
          await store.dismissProblem(id);
        } catch (error) {
          throw toCoreError(error);
        }
      },
    },

    data: createDataApi(store, ready),
    stock: createStockApi(runtime),
    products: createProductsApi(runtime),
    zones: createZonesApi(runtime),
    settings: createSettingsApi(runtime),

    prefs: {
      value: derived(
        store.state,
        (s) => [s.loaded, s.prefs],
        (s) => (s.loaded ? s.prefs : undefined),
      ),
      update: createPrefsUpdate(runtime),
    },

    printers: createPrintersApi(runtime),
    print: createPrintApi(runtime),

    devices: {
      async list(): Promise<Device[]> {
        const devices = await runtime.server((token) => api.listDevices(token));
        // Hat ein anderes Gerät dieses hier umbenannt, gilt der neue Name auch in der Sitzung:
        // Sonst zeigte die Oberfläche in der Kopfzeile einen anderen Namen als in der Geräteliste.
        const own = devices.find((device) => device.current);
        if (own) {
          await store.renameDevice(own.id, own.name).catch(() => undefined);
        }
        return devices;
      },
      async rename(id, name) {
        const wanted = checkDeviceName(name);
        const device = await runtime.server((token) => api.renameDevice(token, id, wanted));
        await store.renameDevice(device.id, device.name).catch(() => undefined);
        return device;
      },
      async revoke(id) {
        const session = store.snapshot.session;
        await runtime.server((token) => api.revokeDevice(token, id));
        if (session?.status === "signed_in" && session.token !== null && session.device?.id === id) {
          // Das eigene Gerät gesperrt: Das Token gilt ab sofort nicht mehr.
          await store.markRevoked(session.token).catch(() => undefined);
        }
      },
    },

    backup: {
      async download() {
        const { blob, filename } = await runtime.server((token) => api.backup(token));
        const today = now();
        const fallback = `stowly-${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}.sqlite3`;
        return { blob, filename: filename ?? fallback };
      },
    },

    app: {
      state: app,
      async applyUpdate() {
        // Runde 2: Bis dahin übernimmt eine neue Version von selbst (src/core/pwa/register.ts).
      },
      async promptInstall() {
        return false;
      },
      async requestPersistence() {
        await checkPersistence(true);
        return app.get().storage_persistent === true;
      },
    },

    dispose() {
      disposed = true;
      scheduler.stop();
      for (const cleanup of cleanups) {
        cleanup();
      }
      void ready.finally(() => store.close());
    },
  };

  return core;
}
