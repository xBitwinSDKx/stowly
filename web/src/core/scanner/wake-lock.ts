/**
 * Hält den Bildschirm wach, solange gescannt wird (Screen Wake Lock API).
 *
 * Verfügbar in Chrome ab 84 und Safari ab 16.4; in Apps auf dem iOS-Home-Bildschirm erst
 * seit iOS 18.4 (WebKit 254545). Der Browser gibt die Sperre von selbst frei, sobald die
 * Seite in den Hintergrund geht; bei der Rückkehr wird sie neu angefordert.
 *
 * Einen Rückfall für ältere iPhones gibt es bewusst nicht. Der einzige bekannte Ersatz ist
 * ein unsichtbares Video mit Tonspur in Dauerschleife: Es unterbräche andere Wiedergaben
 * (Musik, Hörbuch), bräuchte eine eingebettete Mediendatei und ließ sich hier nicht an
 * einem Gerät prüfen. Dort dimmt der Bildschirm nach der eingestellten Zeit; ein Tippen
 * weckt ihn, die Kamera läuft weiter.
 */

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
}

interface WakeLockLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

function wakeLock(): WakeLockLike | null {
  const api = (globalThis.navigator as (Navigator & { wakeLock?: WakeLockLike }) | undefined)?.wakeLock;
  return api && typeof api.request === "function" ? api : null;
}

export class ScreenWakeLock {
  private sentinel: WakeLockSentinelLike | null = null;
  private wanted = false;
  private readonly onVisible = () => {
    if (this.wanted && typeof document !== "undefined" && document.visibilityState === "visible") {
      void this.request();
    }
  };

  /** Wahr, wo der Browser die Schnittstelle hat. Ob sie in dieser Umgebung auch wirkt, zeigt erst `acquire`. */
  static get supported(): boolean {
    return wakeLock() !== null;
  }

  /** Fordert die Sperre an und hält sie über Wechsel in den Hintergrund hinweg. Liefert, ob sie jetzt gehalten wird. */
  async acquire(): Promise<boolean> {
    if (!this.wanted) {
      this.wanted = true;
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", this.onVisible);
      }
    }
    return this.request();
  }

  release(): void {
    this.wanted = false;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisible);
    }
    const sentinel = this.sentinel;
    this.sentinel = null;
    void sentinel?.release().catch(() => undefined);
  }

  private async request(): Promise<boolean> {
    const api = wakeLock();
    if (!api) {
      return false;
    }
    if (this.sentinel && !this.sentinel.released) {
      return true;
    }
    try {
      const sentinel = await api.request("screen");
      if (!this.wanted) {
        // Inzwischen nicht mehr gewünscht (Ansicht verlassen, während die Anfrage lief).
        void sentinel.release().catch(() => undefined);
        return false;
      }
      this.sentinel = sentinel;
      sentinel.addEventListener("release", () => {
        if (this.sentinel === sentinel) {
          this.sentinel = null;
        }
      });
      return true;
    } catch {
      // Abgelehnt (Energiesparmodus, Hintergrund, iOS-Home-Bildschirm vor 18.4).
      return false;
    }
  }
}
