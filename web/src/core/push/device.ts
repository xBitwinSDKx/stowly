/**
 * Push auf diesem Gerät (`Core.push`, docs/integrationen.md Abschnitt 4).
 *
 * Der Zustand ergibt sich aus dem Browser (Service Worker, PushManager, Erlaubnis, Abo) und aus
 * dem Server (eingerichtet? kennt er das Abo, mit welchem Schlüssel?):
 *
 * - Beim Start und nach der Anmeldung fragt der Kern den Schlüssel des Servers ab
 *   (`GET /api/push/key`): 503 heißt "not_configured". Hat der Browser ein Abo, meldet der Kern
 *   es neu an, wenn sein `applicationServerKey` vom Schlüssel des Servers abweicht (eine
 *   zurückgespielte Sicherung bringt einen anderen mit), und sonst noch einmal, wie es ist
 *   (`PUT` ist wiederholbar): So kennt der Server es auch wieder, wenn er es vergessen hatte.
 *   Bis zur Antwort gilt ein vorhandenes Abo als "on". Ist der Server nicht erreichbar, holt
 *   der Kern das nach dem nächsten Kontakt nach.
 * - `enable` fragt die Erlaubnis gleich zu Beginn, noch im Tipp des Anwenders und vor jedem
 *   Warten: Safari fragt sonst nicht. Danach Schlüssel, Abo im Browser, Anmeldung beim Server.
 * - `disable` beendet das Abo im Browser sofort; der Server erfährt es gleich oder, ohne
 *   Verbindung, beim nächsten Kontakt (bis die App geschlossen wird; danach spätestens, wenn der
 *   Push-Dienst das Abo als erloschen meldet).
 * - Beim Abmelden endet das Abo im Browser; der Server löscht seines mit dem Token.
 *
 * Browser und Server kommen über Schnittstellen herein (`PushEnvironment`, `PushServer`), damit
 * sich der Ablauf ohne Browser prüfen lässt (src/core/push/push.test.ts).
 */
import type { PushSubscriptionInput, PushTestResult } from "@/contract/api.gen";
import type { PushApi, PushState } from "@/contract/core";
import { CoreError } from "@/contract/errors";

import { Signal } from "../live";

export type PermissionValue = "granted" | "denied" | "default";

/** Was der Kern von einem `PushSubscription` des Browsers braucht. */
export interface PushSubscriptionLike {
  readonly endpoint: string;
  readonly options?: { readonly applicationServerKey?: ArrayBuffer | null } | null;
  toJSON(): { endpoint?: string; keys?: Record<string, string | undefined> };
  getKey?(name: "p256dh" | "auth"): ArrayBuffer | null;
  unsubscribe(): Promise<boolean>;
}

/** Was der Kern vom `PushManager` der Registrierung braucht. */
export interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionLike | null>;
  subscribe(options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array<ArrayBuffer> }): Promise<PushSubscriptionLike>;
}

/** Der Browser, soweit es Push angeht. */
export interface PushEnvironment {
  /** Warum Push hier nicht geht: "unsupported" oder "ios_install"; null, wenn es grundsätzlich geht. */
  support(): "unsupported" | "ios_install" | null;
  /** Die Erlaubnis für Benachrichtigungen (`Notification.permission`). */
  permission(): PermissionValue;
  /** Fragt den Anwender (`Notification.requestPermission`). Muss im Tipp gerufen werden. */
  requestPermission(): Promise<PermissionValue>;
  /** Der PushManager der Registrierung des Service Workers; null ohne Registrierung. */
  pushManager(): Promise<PushManagerLike | null>;
  /** Ursprung der App (`location.origin`): Daraus baut der Server die Adresse in der Nachricht. */
  readonly origin: string;
}

/** Die Aufrufe an den Server; jeder wirft `CoreError` wie `runtime.server`. */
export interface PushServer {
  key(): Promise<string>;
  subscribe(subscription: PushSubscriptionInput): Promise<void>;
  unsubscribe(): Promise<void>;
  test(): Promise<PushTestResult>;
}

export interface PushControllerOptions {
  /** Ist das Gerät angemeldet? Ohne Anmeldung fragt der Kern den Server nicht. */
  signedIn(): boolean;
}

const NOT_CONFIGURED = "Der Server hat keinen Kontakt für die Push-Dienste.";

/** Die Bytes eines base64url-Texts (Füllzeichen erlaubt). */
export function base64urlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const plain = text.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(plain + "=".repeat((4 - (plain.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** base64url ohne Füllzeichen. */
export function bytesToBase64url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Wurde das Abo mit diesem Schlüssel des Servers angelegt? Ohne Angabe des Browsers
 * (`options.applicationServerKey` fehlt) gilt es als passend: Neu anmelden ließe sich dann gar
 * nicht entscheiden, und ein falscher Schlüssel zeigt sich in der Testnachricht ("rejected").
 */
export function sameServerKey(subscription: PushSubscriptionLike, key: string): boolean {
  const own = subscription.options?.applicationServerKey;
  if (!own) {
    return true;
  }
  try {
    return bytesToBase64url(own) === bytesToBase64url(base64urlToBytes(key));
  } catch {
    return false;
  }
}

/** Das Abo in der Form, die der Server annimmt (`PushSubscriptionInput`). */
export function subscriptionInput(subscription: PushSubscriptionLike, origin: string): PushSubscriptionInput {
  const json = subscription.toJSON();
  const key = (name: "p256dh" | "auth"): string => {
    const fromJson = json.keys?.[name];
    if (typeof fromJson === "string" && fromJson !== "") {
      return fromJson;
    }
    const raw = subscription.getKey?.(name) ?? null;
    return raw ? bytesToBase64url(raw) : "";
  };
  return { endpoint: json.endpoint ?? subscription.endpoint, keys: { p256dh: key("p256dh"), auth: key("auth") }, origin };
}

function isCode(error: unknown, ...codes: CoreError["code"][]): error is CoreError {
  return error instanceof CoreError && codes.includes(error.code);
}

export class PushController implements PushApi {
  readonly state: Signal<PushState>;
  /** Was der Server zuletzt über Push gesagt hat. */
  private server: "unknown" | "configured" | "not_configured" = "unknown";
  /** Das Abo ist im Browser beendet, der Server weiß es noch nicht. */
  private deletePending = false;
  /** Der Abgleich mit dem Server (Schlüssel, Abo) steht noch aus, weil er nicht erreichbar war. */
  private checkPending = false;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly env: PushEnvironment,
    private readonly api: PushServer,
    private readonly options: PushControllerOptions,
  ) {
    const support = env.support();
    this.state = new Signal<PushState>(support ?? "off");
  }

  // ---------------------------------------------------------------- Zustand

  /** Der Zustand nach dem, was Browser und letzte Antwort des Servers wissen. */
  private async localState(): Promise<PushState> {
    const support = this.env.support();
    if (support) {
      return support;
    }
    if (this.server === "not_configured") {
      return "not_configured";
    }
    const permission = this.env.permission();
    if (permission === "denied") {
      return "denied";
    }
    const manager = await this.env.pushManager().catch(() => null);
    if (!manager) {
      return "unsupported";
    }
    const subscription = await manager.getSubscription().catch(() => null);
    return subscription && permission === "granted" && this.options.signedIn() ? "on" : "off";
  }

  /** Liest den Zustand neu, nur aus dem Browser (etwa wenn die App wieder sichtbar wird). */
  async detect(): Promise<PushState> {
    const state = await this.localState();
    this.state.set(state);
    return state;
  }

  /**
   * Beim Start und nach der Anmeldung: Zustand erkennen, beim Server nachsehen und ein Abo bei
   * Bedarf neu anmelden. Wirft nicht. Läuft schon einer, wartet der Aufruf auf ihn.
   */
  refresh(): Promise<void> {
    this.refreshing ??= this.runRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /**
   * Der Kontakt für die Push-Dienste hat sich geändert (`serverConfig.update`): Was der Server
   * zuletzt über Push sagte („nicht eingerichtet"), gilt nicht mehr. Fragt neu nach.
   */
  serverChanged(): void {
    this.server = "unknown";
    void this.refresh();
  }

  /** Nach einem Kontakt zum Server: nachholen, was ohne ihn liegen blieb. */
  afterContact(): void {
    if (this.checkPending || this.deletePending) {
      void this.refresh();
    }
  }

  private async runRefresh(): Promise<void> {
    try {
      const state = await this.detect();
      if (state === "unsupported" || state === "ios_install" || !this.options.signedIn()) {
        return;
      }
      this.checkPending = false;
      if (this.deletePending) {
        await this.api.unsubscribe();
        this.deletePending = false;
      }
      const key = await this.serverKey();
      if (this.env.permission() !== "granted") {
        await this.detect();
        return;
      }
      const manager = await this.env.pushManager();
      const subscription = await manager?.getSubscription();
      if (!manager || !subscription) {
        await this.detect();
        return;
      }
      await this.register(manager, subscription, key);
      this.state.set("on");
    } catch (error) {
      if (isCode(error, "offline")) {
        // Ohne Server bleibt es beim Zustand des Browsers; nachgeholt wird nach dem nächsten Kontakt.
        this.checkPending = true;
      } else if (!isCode(error, "not_configured", "not_supported", "unauthorized")) {
        console.warn("Stowly: Push ließ sich nicht abgleichen.", error);
        // Ein Abo, das der Server nicht annimmt (etwa ein unbekannter Push-Dienst), gilt nicht als an.
        if (this.state.get() === "on") {
          this.state.set("off");
        }
      }
    }
  }

  /** Fragt den Schlüssel des Servers ab und merkt sich, ob er Push kann. */
  private async serverKey(): Promise<string> {
    try {
      const key = await this.api.key();
      this.server = "configured";
      return key;
    } catch (error) {
      // 503 (nicht eingerichtet) und 501 (ein Server, der Push noch nicht kann) heißen dasselbe.
      if (isCode(error, "not_configured", "not_supported")) {
        this.server = "not_configured";
        this.state.set("not_configured");
        throw new CoreError("not_configured", NOT_CONFIGURED);
      }
      throw error;
    }
  }

  /** Meldet das Abo beim Server an; passt sein Schlüssel nicht, zuerst neu im Browser. */
  private async register(manager: PushManagerLike, subscription: PushSubscriptionLike, key: string): Promise<void> {
    let current = subscription;
    if (!sameServerKey(current, key)) {
      await current.unsubscribe().catch(() => false);
      current = await manager.subscribe({ userVisibleOnly: true, applicationServerKey: base64urlToBytes(key) });
    }
    await this.api.subscribe(subscriptionInput(current, this.env.origin));
    this.deletePending = false;
  }

  // ---------------------------------------------------------------- Die Schnittstelle

  enable(): Promise<PushState> {
    // Alles bis zur Frage nach der Erlaubnis geschieht ohne Warten: noch im Tipp des Anwenders.
    const support = this.env.support();
    if (support) {
      this.state.set(support);
      return Promise.reject(new CoreError("not_supported", support === "ios_install" ? "Auf dem iPhone geht Push erst, wenn Stowly auf dem Home-Bildschirm liegt." : "Dieser Browser kann hier kein Push."));
    }
    if (this.server === "not_configured") {
      return Promise.reject(new CoreError("not_configured", NOT_CONFIGURED));
    }
    let permission: Promise<PermissionValue>;
    try {
      permission = this.env.permission() === "granted" ? Promise.resolve("granted") : this.env.requestPermission();
    } catch (error) {
      permission = Promise.reject(error);
    }
    return this.finishEnable(permission);
  }

  private async finishEnable(permission: Promise<PermissionValue>): Promise<PushState> {
    let answer: PermissionValue;
    try {
      answer = await permission;
    } catch {
      answer = this.env.permission();
    }
    if (answer !== "granted") {
      // Verweigert: Nur die Einstellungen des Browsers ändern das. Weggeklickt: später noch einmal.
      return this.detect();
    }
    const key = await this.serverKey();
    const manager = await this.env.pushManager().catch(() => null);
    if (!manager) {
      this.state.set("unsupported");
      throw new CoreError("not_supported", "Ohne Service Worker gibt es kein Push.");
    }
    let subscription: PushSubscriptionLike | null = await manager.getSubscription().catch(() => null);
    if (!subscription) {
      try {
        subscription = await manager.subscribe({ userVisibleOnly: true, applicationServerKey: base64urlToBytes(key) });
      } catch (error) {
        await this.detect();
        const reason = error instanceof Error && error.message ? ` (${error.message})` : "";
        throw new CoreError("internal", `Der Browser hat kein Abo für Push angelegt${reason}.`);
      }
    }
    await this.register(manager, subscription, key);
    this.state.set("on");
    return "on";
  }

  async disable(): Promise<void> {
    const manager = await this.env.pushManager().catch(() => null);
    const subscription = await manager?.getSubscription().catch(() => null);
    if (subscription) {
      await subscription.unsubscribe().catch(() => false);
    }
    if (this.options.signedIn() && this.server !== "not_configured") {
      try {
        await this.api.unsubscribe();
        this.deletePending = false;
      } catch (error) {
        // Ohne Verbindung: beim nächsten Kontakt.
        this.deletePending = isCode(error, "offline");
      }
    }
    await this.detect();
  }

  async test(): Promise<PushTestResult> {
    try {
      const result = await this.api.test();
      if (result.status === "gone") {
        // Der Push-Dienst kennt das Abo nicht mehr: Auch das im Browser taugt nichts mehr.
        await this.dropBrowserSubscription();
        this.state.set("off");
      }
      return result;
    } catch (error) {
      if (isCode(error, "not_found")) {
        // Der Server kennt kein Abo dieses Geräts; `enable` meldet das vorhandene wieder an.
        if (this.state.get() === "on") {
          this.state.set("off");
        }
      } else if (isCode(error, "not_configured", "not_supported")) {
        this.server = "not_configured";
        this.state.set("not_configured");
        throw new CoreError("not_configured", NOT_CONFIGURED);
      }
      throw error;
    }
  }

  /** Das Gerät meldet sich ab: Das Abo endet im Browser; der Server löscht seines mit dem Token. */
  async endSession(): Promise<void> {
    this.deletePending = false;
    this.checkPending = false;
    this.server = "unknown";
    await this.dropBrowserSubscription();
    await this.detect();
  }

  private async dropBrowserSubscription(): Promise<void> {
    const manager = await this.env.pushManager().catch(() => null);
    const subscription = await manager?.getSubscription().catch(() => null);
    await subscription?.unsubscribe().catch(() => false);
  }
}
