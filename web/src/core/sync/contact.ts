/**
 * Kontakt zum Server, geteilt zwischen den Tabs eines Geräts (docs/sync-protokoll.md, 9.5).
 *
 * Jeder sichtbare Tab prüft nebenbei, ob der Server erreichbar ist, aber erst, wenn er
 * 15 Sekunden lang nichts von ihm gehört hat (src/core/sync/scheduler.ts). Was ein Tab erfährt
 * (Abgleich, Prüfung, ein anderer Aufruf), sagt er hierüber den anderen: Sie warten dann wieder
 * volle 15 Sekunden und zeigen dasselbe. Bei mehreren sichtbaren Tabs fragt so meist nur einer.
 * Ohne BroadcastChannel prüft jeder sichtbare Tab für sich.
 *
 * Ohne DOM.
 */

/** Name des Kanals; dahinter steht der Name der lokalen Datenbank. */
export const CONTACT_CHANNEL_NAME = "stowly-contact";

export class ContactChannel {
  private channel: BroadcastChannel | null = null;

  /** @param onContact ein anderer Tab hat den Server erreicht (true) oder nicht (false) */
  constructor(dbName: string, onContact: (reachable: boolean) => void) {
    if (typeof BroadcastChannel !== "function") {
      return;
    }
    try {
      const channel = new BroadcastChannel(`${CONTACT_CHANNEL_NAME}:${dbName}`);
      // Unter Node hielte ein offener Kanal den Prozess am Leben.
      (channel as unknown as { unref?: () => void }).unref?.();
      channel.onmessage = (event: MessageEvent<unknown>) => {
        const data = event.data as { reachable?: unknown } | null;
        if (typeof data === "object" && data !== null && typeof data.reachable === "boolean") {
          onContact(data.reachable);
        }
      };
      this.channel = channel;
    } catch {
      this.channel = null;
    }
  }

  /** Sagt den anderen Tabs, was dieser eben über den Server erfahren hat. */
  post(reachable: boolean): void {
    try {
      this.channel?.postMessage({ reachable });
    } catch {
      // Nur ein Zuruf: Ohne ihn prüft jeder Tab für sich.
    }
  }

  close(): void {
    this.channel?.close();
    this.channel = null;
  }
}
