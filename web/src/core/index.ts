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
 *   sync/              Abgleich (engine), Anlässe, Wartezeiten und die Prüfung nebenbei
 *                      (scheduler), Kontakt zum Server über Tabs hinweg (contact), Sperre,
 *                      Aufbewahrung
 *   api/               die Teile der Schnittstelle `Core` (auch die Einkaufsliste, shopping.ts)
 *   images.ts          Produktbilder vorab laden
 *   background.ts      Abgleich im Service Worker
 *   push/              Push auf diesem Gerät (device.ts) und Nachrichten im Service Worker (worker.ts)
 *   pwa/               Installation, Service Worker anmelden, neue Versionen
 *   scanner/           Kamera, Erkennung, Ton und Vibration
 */
import {
  APP_VERSION,
  checkNewPassword,
  checkPushContact,
  CoreError,
  isAppleMobile,
  isStoreInternalBarcode,
  isValidBarcode,
  PRODUCT_LOOKUP_WAIT_S,
  PROTOCOL_VERSION,
  type AppState,
  type Core,
  type CoreErrorCode,
  type Device,
  type LoginResponse,
  type PiPairing,
  type ProductLookup,
  type SessionState,
  type SyncProblem,
  type SyncStatus,
} from "@/contract";

import { createProductsApi, createPrefsUpdate, createSettingsApi, createZonesApi } from "./api/catalog";
import { createDataApi } from "./api/data";
import { createPrintApi, createPrintersApi } from "./api/printing";
import { SYNC_FIRST_MAX_WAIT_MS, toCoreError, type CoreRuntime, type PrintRuntime } from "./api/runtime";
import { createShoppingApi } from "./api/shopping";
import { createStockApi } from "./api/stock";
import { checkDeviceName, invalid, LIMITS } from "./api/validate";
import { BACKGROUND_SYNC_TAG } from "./background";
import { DEFAULT_DB_NAME, type StoredSession } from "./db";
import { ApiClient, type FetchLike } from "./http";
import { clearImages, preloadImages } from "./images";
import { derived, Signal } from "./live";
import { readPermission, watchPermissions, type PermissionReader, type PermissionWatcher } from "./print/address";
import { PrintServiceClient } from "./print/client";
import { DeliveryEngine, PRINT_LOCK_NAME } from "./print/engine";
import { DeliveryScheduler } from "./print/scheduler";
import { PushController, type PushEnvironment } from "./push/device";
import { browserPushEnvironment, NO_PUSH, watchNotificationPermission } from "./push/environment";
import { InstallPrompt } from "./pwa/install";
import { registerServiceWorker } from "./pwa/register";
import { serverIsNewer, type AppUpdates } from "./pwa/updates";
import { Store, type StoreState } from "./store";
import { ContactChannel } from "./sync/contact";
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
  /** Eigene Zeitgeber für die Wartezeiten des Abgleichs und des Zustellens. Für Tests. */
  timers?: SchedulerTimers;
  /**
   * Liest den Stand der Erlaubnis des Browsers für das lokale Netzwerk (Direktdruck).
   * Vorgabe: die Permissions API. Für Tests.
   */
  permissions?: PermissionReader;
  /**
   * Meldet Änderungen dieser Erlaubnis; danach stellt der Kern von selbst zu (nur mit
   * `autoSync`). Vorgabe: die Permissions API. Für Tests.
   */
  watchPermissions?: PermissionWatcher;
  /** Gilt die Umgebung als sicherer Kontext? Vorgabe: `isSecureContext` des Browsers. Für Tests. */
  secureContext?: boolean;
  /** Lädt die Seite neu (`app.applyUpdate`). Vorgabe: `location.reload()`. Für Tests. */
  reload?: () => void;
  /**
   * So lange wartet der Start darauf, dass ein Tab mit älterer App die lokale Datenbank
   * freigibt, bevor der Kern ohne sie weitermacht. Vorgabe 8 Sekunden. Für Tests.
   */
  blockedTimeoutMs?: number;
  /**
   * Sucht sofort nach einer neuen Version der App, weil der Server ein neueres Protokoll spricht.
   * Vorgabe: über den Service Worker (`AppUpdates.checkNow`). Für Tests.
   */
  checkForUpdate?: () => void;
  /**
   * Der Browser, soweit es Push angeht (src/core/push). Vorgabe: der echte. Mit eigener Umgebung
   * gleicht der Kern Push auch ohne `autoSync` beim Start und nach der Anmeldung ab. Für Tests.
   */
  push?: PushEnvironment;
}

/** Wie lange ein blockiertes Öffnen der Datenbank den Start aufhält. */
const BLOCKED_TIMEOUT_MS = 8_000;

const SUPERSEDED_MESSAGE = "Ein anderer Tab läuft schon mit einer neueren Version von Stowly. Diese Seite muss neu geladen werden.";
const BLOCKED_MESSAGE = "Ein anderer Tab mit einer älteren Version von Stowly hält die lokalen Daten fest. Schließe ihn, dann geht es hier weiter.";
const NO_STORAGE_MESSAGE = "Die lokale Datenbank ist nicht verfügbar.";
const OFFLINE_MESSAGE = "Der Server ist nicht erreichbar.";

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

/** iPhone und iPad im Browser, nicht installiert: Dort zeigt die Oberfläche die Anleitung statt einer Aufforderung. */
function manualInstall(installed: boolean): AppState["manual_install"] {
  if (installed || typeof navigator === "undefined") {
    return null;
  }
  return isAppleMobile(navigator) ? "ios" : null;
}

export function createCore(options: CoreOptions = {}): StowlyCore {
  const now = options.now ?? (() => new Date());
  const autoSync = options.autoSync ?? true;
  const dbName = options.dbName ?? DEFAULT_DB_NAME;
  const fetchFn: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const hasWindow = typeof window !== "undefined" && typeof document !== "undefined";

  let disposed = false;
  /** false, wenn der Browser keine lokale Datenbank zulässt (oder ein älterer Tab sie festhält). */
  let storageAvailable = true;
  /** Das Öffnen der Datenbank wartet auf einen Tab mit älterer App. */
  let blocked = false;
  let onBlocked: (() => void) | null = null;

  const store = new Store({
    dbName,
    now,
    // Ein Tab mit neuerer App hat die Datenbank übernommen: Dieser kann nicht weiterarbeiten,
    // bis er neu geladen ist. Der Store hat die Verbindung schon geschlossen.
    onSuperseded: () => {
      patchApp({ update_required: true });
      scheduler.stop();
      deliveries.stop();
      delivery.stop();
      contacts.close();
    },
    onBlocked: () => {
      blocked = true;
      onBlocked?.();
    },
  });
  const api = new ApiClient(fetchFn);

  // ---------------------------------------------------------------- Zustand der App

  const installedAtStart = isInstalled();
  const app = new Signal<AppState>({
    version: APP_VERSION,
    // Über http://<LAN-IP> verweigert der Browser Kamera, Offline-Betrieb und Installation.
    secure_context: options.secureContext ?? (typeof globalThis.isSecureContext === "boolean" ? globalThis.isSecureContext : true),
    installed: installedAtStart,
    can_install: false,
    manual_install: manualInstall(installedAtStart),
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
    server_configured: null,
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
        next.server_configured === current.server_configured &&
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
      // Auch abgemeldet: Ohne Passwort beim Server zeigt die Anmeldeschranke die Einrichtung.
      patchStatus(health ? { online: true, server_version: health.version, server_configured: health.configured !== false } : { online: false });
      if (health) {
        void flushRevocations();
      }
    },
  });

  /**
   * 409 `protocol_mismatch` mit einer höheren Version des Servers: Nur eine neue Version der App
   * kann wieder abgleichen, also gleich danach suchen statt erst nach der Stunde (6.5).
   */
  function checkProtocol(error: CoreError): void {
    if (error.code === "protocol_mismatch" && serverIsNewer(error.details, PROTOCOL_VERSION)) {
      if (options.checkForUpdate) {
        options.checkForUpdate();
      } else {
        updates?.checkNow();
      }
    }
  }

  /** Ein gescheiterter Versuch in `sync.status` (9.2). Nur "offline" heißt: Der Server ist nicht erreichbar. */
  function showFailure(code: CoreErrorCode, message: string): void {
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

  /** Ein Abgleich samt Buchführung für `sync.status`. Wirft nicht. */
  async function runSync(runOptions?: SyncRunOptions): Promise<SyncOutcome> {
    if (disposed || !storageAvailable || store.superseded) {
      const error = new CoreError("not_supported", store.superseded ? SUPERSEDED_MESSAGE : blocked ? BLOCKED_MESSAGE : NO_STORAGE_MESSAGE);
      if (!disposed) {
        // Ohne lokale Datenbank gibt es nichts abzugleichen; der Grund steht im Status.
        patchStatus({ phase: "error", last_error: { code: error.code, message: error.message, at: now().toISOString() } });
      }
      return { ok: false, error };
    }
    patchStatus({ phase: "syncing" });
    const outcome = await engine.run(runOptions);
    if (disposed) {
      return outcome;
    }
    // Die anderen Tabs warten mit ihrer Prüfung nebenbei wieder von vorn (9.5).
    contacts.post(outcome.ok || outcome.error.code !== "offline");
    if (outcome.ok) {
      patchStatus({ phase: "idle", online: true, last_error: null });
      if (outcome.synced) {
        void cacheImages();
        // Was eben abgeglichen wurde, kann jetzt zum Drucker am Server; was dort gedruckt hat, ist jetzt bekannt.
        deliveries.kick("sync");
        // Was Push ohne Server liegen lassen musste, holt es jetzt nach.
        push.afterContact();
      }
    } else {
      showFailure(outcome.error.code, outcome.error.message);
      checkProtocol(outcome.error);
    }
    return outcome;
  }

  /** Wird nebenbei geprüft, ob der Server erreichbar ist (9.5)? Nur, solange das Gerät angemeldet ist. */
  function canCheckServer(): boolean {
    return !disposed && storageAvailable && !store.superseded && store.snapshot.session?.status === "signed_in";
  }

  /**
   * Die Prüfung nebenbei (9.5) für den Zeitplan: true erreichbar, false nicht; null, wenn sie
   * entfiel, weil gerade jemand abgleicht (auch ein anderer Tab oder der Service Worker).
   * Antwortet der Server nicht, zeigt `sync.status` dasselbe wie nach einem gescheiterten Abgleich.
   */
  async function checkServer(): Promise<boolean | null> {
    if (!canCheckServer()) {
      return null;
    }
    const health = await engine.checkIfIdle();
    if (health === "busy" || disposed) {
      return null;
    }
    contacts.post(health !== null);
    if (health === null) {
      showFailure("offline", OFFLINE_MESSAGE);
      return false;
    }
    return true;
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
    check: () => checkServer(),
    canCheck: () => canCheckServer(),
    timers: options.timers,
    auto: autoSync,
  });

  // Was ein anderer Tab über den Server erfährt, gilt auch hier (9.5): Die Prüfung nebenbei wartet
  // wieder von vorn, und `sync.status` zeigt dasselbe. Den eigenen Abgleich stört das nicht.
  const contacts = new ContactChannel(dbName, (reachable) => {
    if (disposed) {
      return;
    }
    scheduler.notifyContact(reachable);
    if (status.get().phase === "syncing") {
      return;
    }
    if (reachable) {
      patchStatus({ online: true });
    } else {
      showFailure("offline", OFFLINE_MESSAGE);
    }
  });

  /** Ein Aufruf außerhalb des Abgleichs hat den Server erreicht oder nicht (9.5). */
  function noteContact(reachable: boolean): void {
    scheduler.notifyContact(reachable);
    contacts.post(reachable);
  }

  // ---------------------------------------------------------------- Etiketten zustellen

  const printClient = new PrintServiceClient(fetchFn);
  const delivery = new DeliveryEngine({
    store,
    client: printClient,
    now,
    lockName: dbName === DEFAULT_DB_NAME ? PRINT_LOCK_NAME : `${PRINT_LOCK_NAME}:${dbName}`,
    isSecureContext: () => app.get()?.secure_context !== false,
    readPermission: options.permissions ?? readPermission,
    onChange: () => scheduler.notifyChange(),
    onUnauthorized: (token) => store.markRevoked(token).catch(() => undefined),
    requestSync: () => {
      if (autoSync && !disposed) {
        void scheduler.request();
      }
    },
  });
  // Von selbst stellt nur eine Seite zu, nie der Service Worker und nie ein Kern ohne Fenster.
  const deliveries = new DeliveryScheduler({
    run: (runOptions) => {
      if (disposed || !storageAvailable) {
        const nothing = Promise.resolve({ delivered: 0, pending: 0, problems: [], outstanding: 0 });
        return { report: nothing, done: nothing };
      }
      return delivery.run(runOptions);
    },
    isVisible: () => !hasWindow || document.visibilityState !== "hidden",
    timers: options.timers,
    auto: autoSync && hasWindow,
  });
  const printRuntime: PrintRuntime = {
    engine: delivery,
    client: printClient,
    flush: () => deliveries.flush(),
    afterProbe: () => {
      if (autoSync) {
        void deliveries.flush();
      }
    },
    syncFirst: async () => {
      // Ein langsamer Server hält „Jetzt drucken" und „Verbindung prüfen" höchstens 10 Sekunden
      // auf. Der Abgleich läuft danach weiter; was er noch nicht gebracht hat, bleibt ausstehend
      // und geht hinaus, sobald er fertig ist (docs/etiketten.md, 4.1).
      await waitAtMost(scheduler.request(), SYNC_FIRST_MAX_WAIT_MS);
    },
  };

  /** Wartet auf `work`, aber höchstens `ms` Millisekunden; es läuft danach weiter. Wirft nicht. */
  function waitAtMost(work: Promise<unknown>, ms: number): Promise<void> {
    const timers = options.timers;
    return new Promise<void>((resolve) => {
      const handle: unknown = timers ? timers.set(resolve, ms) : setTimeout(resolve, ms);
      const done = () => {
        if (timers) {
          timers.clear(handle);
        } else {
          clearTimeout(handle as ReturnType<typeof setTimeout>);
        }
        resolve();
      };
      work.then(done, done);
    });
  }

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

  /** Was nach dem Laden der Datenbank noch zum Start gehört. */
  async function afterLoad(): Promise<void> {
    // Was inzwischen jenseits der Aufbewahrung liegt, verschwindet schon beim Start (6.4).
    await store.purgeExpired().catch((error: unknown) => console.warn("Stowly: Aufräumen beim Start ist gescheitert.", error));
    if (disposed) {
      return;
    }
    void checkPersistence(false);
    if (autoSync) {
      void scheduler.request();
      deliveries.kick("start");
    }
    // Push: Zustand erkennen, Schlüssel des Servers vergleichen, Abo bei Bedarf neu anmelden.
    if (autoSync || options.push) {
      void push.refresh();
    }
  }

  const ready: Promise<void> = (async () => {
    const loading = store.load();
    // Hält ein Tab mit älterer App die Datenbank fest (er reagiert nicht, etwa weil der Browser
    // ihn eingefroren hat), wartet dieser nicht ewig: Er macht ohne lokale Daten weiter und holt
    // den Start nach, sobald die Datenbank frei wird.
    const gaveUp = new Promise<"blocked">((resolve) => {
      const arm = () => setTimeout(() => resolve("blocked"), options.blockedTimeoutMs ?? BLOCKED_TIMEOUT_MS);
      if (blocked) {
        arm();
      } else {
        onBlocked = arm;
      }
    });
    let outcome: "loaded" | "blocked" | "failed";
    try {
      outcome = await Promise.race([loading.then(() => "loaded" as const), gaveUp]);
    } catch (error) {
      outcome = "failed";
      // Ohne lokale Datenbank (manche privaten Fenster) gibt es keinen Offline-Kern.
      console.warn("Stowly: Die lokale Datenbank ist nicht verfügbar.", error);
    }
    onBlocked = null;
    if (outcome !== "loaded") {
      storageAvailable = false;
      store.state.set({ ...store.snapshot, loaded: true });
      if (outcome === "blocked") {
        console.warn("Stowly: Ein anderer Tab mit einer älteren Version hält die lokale Datenbank fest.");
        void loading.then(
          () => {
            // Der andere Tab hat losgelassen: Jetzt beginnt der Kern wirklich.
            storageAvailable = true;
            blocked = false;
            return disposed ? undefined : afterLoad();
          },
          () => undefined,
        );
      }
      return;
    }
    blocked = false;
    await afterLoad();
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
      deliveries.notifyVisibility(visible);
      if (!visible && store.snapshot.outbox.length > 0) {
        registerBackgroundSync();
      }
    });
    listen(window, "pagehide", () => {
      if (store.snapshot.outbox.length > 0) {
        registerBackgroundSync();
      }
    });
    // Die Erlaubnis für das lokale Netzwerk hat sich geändert: Meist hat der Anwender eben die
    // Nachfrage des Browsers beantwortet, oft erst nach der Zeitgrenze der Anfrage, die sie
    // ausgelöst hat. Mit Erlaubnis geht jetzt von selbst hinaus, was aussteht.
    cleanups.push((options.watchPermissions ?? watchPermissions)(() => deliveries.kick("permission")));
  }

  // ---------------------------------------------------------------- Lebenslauf der App

  const reload = options.reload ?? (() => window.location.reload());
  /** Der Update-Ablauf; null, wo es keinen Service Worker gibt. */
  let updates: AppUpdates | null = null;
  let installPrompt: InstallPrompt | null = null;
  if (hasWindow) {
    const setInstalled = () => {
      const installed = isInstalled() || app.get()?.installed === true;
      patchApp({ installed, manual_install: manualInstall(installed), ...(installed ? { can_install: false } : {}) });
    };
    if (typeof window.matchMedia === "function") {
      const media = window.matchMedia("(display-mode: standalone)");
      media.addEventListener?.("change", setInstalled);
      cleanups.push(() => media.removeEventListener?.("change", setInstalled));
    }
    const prompt = new InstallPrompt(window, {
      canInstall: (value) => patchApp({ can_install: value && app.get()?.installed !== true }),
      installed: () => patchApp({ installed: true, can_install: false, manual_install: null }),
    });
    installPrompt = prompt;
    cleanups.push(() => prompt.dispose());
    if (autoSync) {
      updates = registerServiceWorker((value) => patchApp({ update_ready: value }), reload);
    }
  }

  // ---------------------------------------------------------------- Gemeinsames für die Schnittstelle

  const runtime: CoreRuntime = {
    store,
    now,
    ready,
    async change(build) {
      await ready;
      if (!storageAvailable) {
        throw new CoreError("not_supported", blocked ? BLOCKED_MESSAGE : NO_STORAGE_MESSAGE);
      }
      let commands = 0;
      let requested = false;
      try {
        const result = await store.mutate((mutation) => {
          const value = build(mutation);
          commands = mutation.commands.length;
          requested = mutation.commands.some((command) => command.type === "print.request");
          return value;
        });
        if (commands > 0) {
          scheduler.notifyChange();
        }
        if (requested) {
          // Ein Etikett ist angefordert: an einen direkten Drucker geht es sofort, auch ohne Server.
          deliveries.kick("request");
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
        noteContact(true);
        return result;
      } catch (error) {
        const failure = toCoreError(error);
        noteContact(failure.code !== "offline");
        if (failure.code === "offline") {
          patchStatus({ online: false });
        } else if (failure.code === "unauthorized") {
          await store.markRevoked(session.token).catch(() => undefined);
        }
        throw failure;
      }
    },
  };

  // ---------------------------------------------------------------- Push auf diesem Gerät

  const push = new PushController(
    options.push ??
      (hasWindow
        ? browserPushEnvironment({
            secureContext: app.get().secure_context,
            installed: () => app.get().installed,
            // Nur die gebaute App meldet einen Service Worker an (src/core/pwa/register.ts).
            serviceWorker: updates !== null,
          })
        : NO_PUSH),
    {
      key: () => runtime.server((token) => api.pushKey(token)),
      subscribe: (subscription) => runtime.server((token) => api.putPushSubscription(token, subscription)),
      unsubscribe: () => runtime.server((token) => api.deletePushSubscription(token)),
      test: () => runtime.server((token) => api.pushTest(token)),
    },
    { signedIn: () => !disposed && storageAvailable && store.snapshot.session?.status === "signed_in" },
  );

  // Die Erlaubnis für Benachrichtigungen lässt sich in den Einstellungen des Browsers ändern:
  // während die App ruht (danach kommt `visibilitychange`) oder während sie sichtbar bleibt (dann
  // meldet es die Permissions API). Der Kern liest den Zustand dann neu; eine neu erteilte
  // Erlaubnis gilt so ohne Neuladen.
  if (hasWindow && (autoSync || options.push)) {
    const redetect = () => void push.detect().catch(() => undefined);
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") {
        redetect();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    cleanups.push(() => document.removeEventListener("visibilitychange", onVisibility));
    cleanups.push(watchNotificationPermission(redetect));
  }

  /**
   * `products.lookup`: Open Food Facts über den Server, gleich beim Scannen (docs/sync-protokoll.md,
   * Abschnitt 10). Fragt nur, wenn es etwas zu fragen gibt und der Server nicht als unerreichbar
   * gilt. Wirft nicht.
   */
  async function lookupProduct(barcode: string): Promise<ProductLookup> {
    const answer = (state: ProductLookup["state"]): ProductLookup => ({ barcode, state, name: "", brand: "", quantity: "", image_id: null });
    await ready;
    if (typeof barcode !== "string" || !isValidBarcode(barcode)) {
      return answer("failed");
    }
    if (isStoreInternalBarcode(barcode)) {
      return answer("skipped");
    }
    if (store.snapshot.meta.lookup_enabled === false) {
      return answer("disabled");
    }
    if (status.get().online === false) {
      return answer("offline");
    }
    try {
      const found = await runtime.server((token) => api.lookup(token, barcode, PRODUCT_LOOKUP_WAIT_S));
      return { barcode, state: found.state, name: found.name, brand: found.brand, quantity: found.quantity, image_id: found.image_id };
    } catch (error) {
      return answer(error instanceof CoreError && error.code === "offline" ? "offline" : "failed");
    }
  }

  let loginInFlight: Promise<void> | null = null;
  /** Kopplungen, nach deren Abschluss schon abgeglichen wurde (`printers.pairing`). */
  const syncedPairings = new Set<string>();

  /**
   * Meldet an und holt den Bestand; siehe `SessionApi.login` und `createPassword`. `obtain` holt
   * das Token beim Server (Anmeldung oder erstes Passwort), `checkPassword` prüft vorher ohne Anfrage.
   */
  async function signInWith(obtain: (name: string) => Promise<LoginResponse>, deviceName: string, checkPassword: () => void): Promise<void> {
    await ready;
    if (!storageAvailable) {
      throw new CoreError("not_supported", blocked ? BLOCKED_MESSAGE : "Der Browser lässt keine lokale Datenbank zu (privates Fenster?). Ohne sie kann Stowly nicht arbeiten.");
    }
    const name = checkDeviceName(deviceName);
    checkPassword();
    if (store.snapshot.session?.status === "signed_in") {
      throw invalid("Dieses Gerät ist schon angemeldet.");
    }
    let response;
    try {
      response = await obtain(name);
    } catch (error) {
      const failure = toCoreError(error);
      const { code } = failure;
      // Was der Server dabei über sein Passwort verrät, gilt auch für die Anmeldeschranke.
      const configured = code === "not_configured" ? false : code === "conflict" || code === "invalid_password" ? true : undefined;
      patchStatus(configured === undefined ? { online: code !== "offline" } : { online: true, server_configured: configured });
      throw failure;
    }
    // Ein Token gibt es nur von einem Server mit Passwort.
    patchStatus({ online: true, server_configured: true });
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
    // Der Zeitplan geht weiter wie nach einem eigenen Abgleich; ab jetzt prüft er auch nebenbei.
    scheduler.notifySynced(outcome);
    void checkPersistence(true);
    // Hat der Browser noch ein Abo (etwa nach einer Sperre), kennt es der Server wieder.
    if (autoSync || options.push) {
      void push.refresh();
    }
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
        loginInFlight ??= signInWith((name) => api.login(password, name), deviceName, () => {
          if (typeof password !== "string" || password === "" || password.length > LIMITS.password) {
            throw new CoreError("invalid_password", "Das Passwort stimmt nicht.");
          }
        }).finally(() => {
          loginInFlight = null;
        });
        return loginInFlight;
      },

      createPassword(password, deviceName) {
        // Wie die Anmeldung: Ein Doppeltipp legt kein zweites Gerät an (und bekäme sonst "conflict").
        loginInFlight ??= signInWith((name) => api.createPassword(password, name), deviceName, () => checkNewPassword(password)).finally(() => {
          loginInFlight = null;
        });
        return loginInFlight;
      },

      async changePassword(current, next) {
        checkNewPassword(next);
        if (typeof current !== "string" || current === "" || current.length > LIMITS.password) {
          throw new CoreError("invalid_password", "Das bisherige Passwort stimmt nicht.");
        }
        // Ein falsches bisheriges Passwort (401 invalid_password) meldet das Gerät nicht ab:
        // `runtime.server` sperrt nur bei "unauthorized".
        await runtime.server((token) => api.changePassword(token, current, next));
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
        // Mit dem Gerät endet sein Push: im Browser jetzt, beim Server mit dem Sperren des Tokens.
        await push.endSession().catch(() => undefined);
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
    products: { ...createProductsApi(runtime), lookup: lookupProduct },
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

    printers: {
      ...createPrintersApi(runtime, printRuntime),
      // Einen Pi koppeln (Protokoll 11.8): Code und Befehl kommen vom Server, der Drucker mit dem Sync.
      pair(input) {
        return runtime.server((token) => api.createPairing(token, { origin: input.origin, printer_id: input.printer_id ?? null }));
      },
      async pairing(id) {
        const found: PiPairing = await runtime.server((token) => api.pairing(token, id));
        const printerId = found.printer_id;
        if (found.state === "paired" && printerId !== null) {
          const local = store.snapshot.view.printers.get(printerId);
          // Fehlt der Drucker hier noch, oder hat der Server ihn eben neu gekoppelt: jetzt abgleichen.
          if (!local || local.deleted_at !== null || !syncedPairings.has(id)) {
            syncedPairings.add(id);
            void scheduler.request(true);
          }
        }
        return found;
      },
      cancelPairing(id) {
        return runtime.server((token) => api.cancelPairing(token, id));
      },
    },
    print: createPrintApi(runtime, printRuntime),

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
        const required = app.get().update_required;
        if (updates) {
          // Lässt die wartende Version übernehmen und lädt neu, sobald sie steuert. Ohne wartende
          // Version wird nur neu geladen, wenn dieser Tab ohnehin nicht weiterarbeiten kann.
          updates.apply(required);
        } else if (required && hasWindow) {
          reload();
        }
      },
      async promptInstall() {
        return installPrompt ? installPrompt.prompt() : false;
      },
      async requestPersistence() {
        await checkPersistence(true);
        return app.get().storage_persistent === true;
      },
    },

    shopping: createShoppingApi(runtime),

    push: {
      state: push.state,
      // Kein `async` und kein Warten davor: Die Frage nach der Erlaubnis muss im Tipp geschehen.
      enable: () => push.enable(),
      disable: () => push.disable(),
      test: () => push.test(),
    },

    // Statistik (Protokoll 11.1): Jeder Aufruf fragt den Server; gespeichert wird sie nie.
    stats: {
      load(range) {
        return runtime.server((token) => api.stats(token, range));
      },
    },

    integrations: {
      load() {
        return runtime.server((token) => api.integrations(token));
      },
    },

    // Updates über GitHub (Protokoll 11.5): Beide Aufrufe brauchen den Server und liefern den
    // Zustand danach. Gespeichert wird davon nichts; den Zustand lädt `integrations.load` neu.
    update: {
      check() {
        return runtime.server((token) => api.checkUpdate(token));
      },
      install(version) {
        return runtime.server((token) => api.installUpdate(token, version));
      },
    },

    // Einrichtung (Protokoll 11.6): Der Stand liegt beim Server, gespeichert wird hier nichts.
    setup: {
      load() {
        return runtime.server((token) => api.setupStatus(token));
      },
      update(changes) {
        return runtime.server((token) => api.updateSetup(token, changes));
      },
      reachesSecurely(origin) {
        return api.reachesSecurely(origin);
      },
    },

    // Einstellungen des Servers (Protokoll 11.7).
    serverConfig: {
      load() {
        return runtime.server((token) => api.serverConfig(token));
      },
      async update(changes) {
        const wanted = typeof changes.push_contact === "string" ? { ...changes, push_contact: checkPushContact(changes.push_contact) } : changes;
        const config = await runtime.server((token) => api.patchServerConfig(token, wanted));
        if (changes.push_contact !== undefined) {
          // Ein neuer Kontakt (oder keiner mehr): Was der Server zuletzt über Push sagte, gilt nicht mehr.
          push.serverChanged();
        }
        return config;
      },
    },

    dispose() {
      disposed = true;
      scheduler.stop();
      deliveries.stop();
      delivery.stop();
      contacts.close();
      for (const cleanup of cleanups) {
        cleanup();
      }
      void ready.finally(() => store.close());
    },
  };

  return core;
}
