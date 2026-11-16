/**
 * Installation als App.
 *
 * Android und Desktop (Chromium): Der Browser meldet mit `beforeinstallprompt`, dass er die
 * Installation anbieten würde. Die App hält das Ereignis fest und zeigt die Aufforderung erst,
 * wenn der Anwender es will (`promptInstall`).
 *
 * iPhone und iPad: Dort gibt es keine Aufforderung. Die App erkennt das Gerät (`isAppleMobile`,
 * src/contract/platform.ts) und sagt der Oberfläche, dass sie die Anleitung zeigen soll
 * („Teilen", dann „Zum Home-Bildschirm").
 */

interface InstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
  readonly userChoice?: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface InstallHooks {
  /** Der Browser bietet die Installation an (oder nicht mehr). */
  canInstall(value: boolean): void;
  /** Die App wurde eben installiert. */
  installed(): void;
}

export class InstallPrompt {
  private pending: InstallPromptEvent | null = null;
  private readonly cleanups: (() => void)[] = [];

  constructor(
    target: EventTarget,
    private readonly hooks: InstallHooks,
  ) {
    const onPrompt = (event: Event) => {
      // Die Leiste des Browsers unterdrücken; die App bietet die Installation selbst an.
      event.preventDefault();
      this.pending = event as InstallPromptEvent;
      hooks.canInstall(true);
    };
    const onInstalled = () => {
      this.pending = null;
      hooks.canInstall(false);
      hooks.installed();
    };
    target.addEventListener("beforeinstallprompt", onPrompt);
    target.addEventListener("appinstalled", onInstalled);
    this.cleanups.push(
      () => target.removeEventListener("beforeinstallprompt", onPrompt),
      () => target.removeEventListener("appinstalled", onInstalled),
    );
  }

  /** Zeigt die Aufforderung des Browsers; true, wenn der Anwender angenommen hat. */
  async prompt(): Promise<boolean> {
    const event = this.pending;
    if (!event) {
      return false;
    }
    // Das Ereignis lässt sich nur einmal verwenden.
    this.pending = null;
    this.hooks.canInstall(false);
    try {
      await event.prompt();
      const choice = await event.userChoice;
      return choice?.outcome === "accepted";
    } catch {
      return false;
    }
  }

  dispose(): void {
    for (const cleanup of this.cleanups.splice(0)) {
      cleanup();
    }
  }
}
