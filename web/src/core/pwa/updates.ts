/**
 * Neue Version anbieten statt sofort übernehmen.
 *
 * Ein neuer Service Worker wartet (src/sw.ts ruft `skipWaiting` nicht mehr von selbst). Die
 * Seite merkt das und meldet „Aktualisierung bereit"; erst `apply()` lässt ihn übernehmen und
 * lädt die Seite genau einmal neu, sobald er steuert.
 *
 * - Beim allerersten Besuch gibt es nichts anzubieten: Der erste Service Worker übernimmt die
 *   Seite, ohne dass etwas neu geladen wird.
 * - Eine Version, die schon beim Start wartet (der Tab war zu), wird ebenfalls angeboten.
 * - Mehrere Tabs: Übernimmt der neue Service Worker, steuert er sofort alle Tabs, und die
 *   Dateien der alten Version verschwinden aus dem Cache. Der Tab, der aktualisiert hat, lädt
 *   neu. Ein Tab im Hintergrund lädt ebenfalls sofort neu (dort unterbricht es niemanden). Ein
 *   zweiter sichtbarer Tab bietet die Aktualisierung weiter an und lädt neu, sobald der
 *   Anwender sie annimmt oder der Tab in den Hintergrund geht.
 *
 * Ohne DOM geschrieben: Die Umgebung wird hereingereicht, damit sich der Ablauf ohne Browser
 * prüfen lässt und src/sw.ts die Nachricht von hier beziehen kann.
 */

/** Die Nachricht, auf die hin ein wartender Service Worker übernimmt. */
export const SKIP_WAITING_MESSAGE = { type: "SKIP_WAITING" } as const;

export function isSkipWaitingMessage(data: unknown): boolean {
  return typeof data === "object" && data !== null && (data as { type?: unknown }).type === SKIP_WAITING_MESSAGE.type;
}

export interface WorkerLike {
  readonly state: string;
  postMessage(message: unknown): void;
  addEventListener(type: "statechange", listener: () => void): void;
}

export interface RegistrationLike {
  readonly waiting: WorkerLike | null;
  readonly installing: WorkerLike | null;
  addEventListener(type: "updatefound", listener: () => void): void;
  update?(): Promise<unknown>;
}

export interface ContainerLike {
  readonly controller: unknown;
  addEventListener(type: "controllerchange", listener: () => void): void;
}

export interface UpdateEnvironment {
  container: ContainerLike;
  /** Lädt die Seite neu. */
  reload(): void;
  /** Ist die Seite gerade im Hintergrund? */
  isHidden(): boolean;
  /** Uhr in Millisekunden. Vorgabe: die des Geräts. */
  now?: () => number;
  /** Zeitgeber für den Fall, dass der wartende Service Worker nicht übernimmt. */
  setTimer?: (callback: () => void, delayMs: number) => unknown;
}

/**
 * Meldet ein 409 `protocol_mismatch`, dass der Server ein neueres Protokoll spricht als diese App
 * (`details.server` größer als die eigene Version)? Dann hilft nur eine neue Version der App.
 */
export function serverIsNewer(details: Readonly<Record<string, unknown>>, own: number): boolean {
  return typeof details.server === "number" && details.server > own;
}

/** So lange wartet `apply` darauf, dass der neue Service Worker steuert, bevor es trotzdem neu lädt. */
export const TAKEOVER_TIMEOUT_MS = 8_000;
/** Nach einer neuen Version wird höchstens so oft gesucht, solange die App offen bleibt. */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1_000;

export class AppUpdates {
  private registration: RegistrationLike | null = null;
  /** Diese Seite hat schon einen Service Worker, der sie steuert. */
  private controlled: boolean;
  private applying = false;
  /** Ein anderer Tab hat die neue Version schon übernommen; dieser läuft noch mit der alten. */
  private takenOver = false;
  private reloading = false;
  private lastCheck: number;
  /** Nach einer neuen Version suchen, sobald die Registrierung bekannt ist (`checkNow` kam zu früh). */
  private checkWanted = false;

  constructor(
    private readonly env: UpdateEnvironment,
    private readonly onReady: (ready: boolean) => void,
  ) {
    this.controlled = Boolean(env.container.controller);
    this.lastCheck = this.now();
    env.container.addEventListener("controllerchange", () => this.controllerChanged());
  }

  private now(): number {
    return this.env.now ? this.env.now() : Date.now();
  }

  /** Beobachtet die Registrierung des Service Workers. */
  watch(registration: RegistrationLike): void {
    this.registration = registration;
    if (registration.waiting && this.env.container.controller) {
      // Eine Version, die schon beim Start wartet.
      this.offer();
    }
    const track = (installing: WorkerLike | null) => {
      installing?.addEventListener("statechange", () => {
        // Ohne Vorgänger (allererster Besuch) gibt es nichts anzubieten.
        if (installing.state === "installed" && this.env.container.controller) {
          this.offer();
        }
      });
    };
    // Eine Version, deren Installation schon lief, bevor die Registrierung hier ankam: Ihr
    // `updatefound` ist vorbei, ihr Ende kommt noch.
    track(registration.installing);
    registration.addEventListener("updatefound", () => track(registration.installing));
    if (this.checkWanted) {
      this.checkNow();
    }
  }

  private offer(): void {
    if (!this.reloading) {
      this.onReady(true);
    }
  }

  /** Wartet eine neue Version auf diesen Tab? */
  get ready(): boolean {
    return this.takenOver || Boolean(this.registration?.waiting && this.env.container.controller);
  }

  /**
   * Wechselt auf die neue Version: lässt den wartenden Service Worker übernehmen und lädt neu,
   * sobald er steuert. `force` lädt auch ohne wartende Version neu (wenn der Tab ohnehin nicht
   * weiterarbeiten kann).
   */
  apply(force: boolean): void {
    if (this.reloading) {
      return;
    }
    const waiting = this.registration?.waiting ?? null;
    if (this.takenOver || !waiting) {
      if (this.takenOver || force) {
        this.reloadOnce();
      }
      return;
    }
    this.applying = true;
    waiting.postMessage(SKIP_WAITING_MESSAGE);
    // Übernimmt er nicht (ein Service Worker, der die Nachricht nicht kennt), hilft nur neu laden.
    const setTimer = this.env.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
    setTimer(() => this.reloadOnce(), TAKEOVER_TIMEOUT_MS);
  }

  private controllerChanged(): void {
    if (!this.controlled) {
      // Der erste Service Worker hat die Seite übernommen: nichts neu zu laden.
      this.controlled = true;
      return;
    }
    if (this.applying || this.env.isHidden()) {
      this.reloadOnce();
      return;
    }
    // Ein anderer Tab hat aktualisiert, und dieser wird gerade benutzt: anbieten statt unterbrechen.
    this.takenOver = true;
    this.offer();
  }

  /** Die Seite ist in den Hintergrund gegangen. */
  hidden(): void {
    if (this.takenOver) {
      this.reloadOnce();
    }
  }

  /** Die Seite ist wieder sichtbar: gelegentlich nachsehen, ob es eine neue Version gibt. */
  visible(): void {
    const now = this.now();
    if (this.registration?.update && now - this.lastCheck >= UPDATE_CHECK_INTERVAL_MS) {
      this.lastCheck = now;
      void this.registration.update().catch(() => undefined);
    }
  }

  /**
   * Sucht sofort nach einer neuen Version, nicht erst nach Ablauf der Stunde: Der Server spricht
   * ein neueres Protokoll (409 `protocol_mismatch`, docs/sync-protokoll.md 6.5). Findet sich eine,
   * wird sie wie jede andere angeboten. Ist die Registrierung noch nicht da, sucht sie danach.
   */
  checkNow(): void {
    const registration = this.registration;
    if (!registration) {
      this.checkWanted = true;
      return;
    }
    this.checkWanted = false;
    this.lastCheck = this.now();
    void registration.update?.().catch(() => undefined);
  }

  private reloadOnce(): void {
    if (this.reloading) {
      return;
    }
    this.reloading = true;
    this.env.reload();
  }
}
