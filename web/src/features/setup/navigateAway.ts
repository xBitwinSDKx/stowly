/**
 * Der Wechsel von http zu https verlässt die App: eine andere Adresse, ein anderer Speicher im
 * Browser. Hier steht, was dabei die Seite verlässt und was sich der Tab merkt; in Tests lässt
 * sich `navigateAway` ersetzen (`vi.mock`).
 */

/** Wohin der Wechsel führte; liegt im Speicher dieses Tabs auf der alten (http-)Adresse. */
export const SETUP_MOVED_KEY = "stowly.setup.moved";

/** Öffnet eine andere Adresse in diesem Tab. */
export function navigateAway(url: string): void {
  window.location.assign(url);
}

/** Läuft diese Seite über HTTPS (auch hinter einem Reverse Proxy)? Dann ist die sichere Verbindung erledigt. */
export function securePage(): boolean {
  return window.location.protocol === "https:";
}

/** Merkt sich für die Anmeldung auf dieser Adresse, wohin Stowly umgezogen ist; `null` vergisst es. */
export function rememberMove(target: string | null): void {
  try {
    if (target === null) {
      sessionStorage.removeItem(SETUP_MOVED_KEY);
    } else {
      sessionStorage.setItem(SETUP_MOVED_KEY, target);
    }
  } catch {
    // Ohne Speicher (privates Fenster) fehlt nur der Hinweis bei der Rückkehr.
  }
}

/** Wohin Stowly von dieser Adresse aus umgezogen ist (eine https-Adresse), oder null. */
export function movedTo(): string | null {
  try {
    const target = sessionStorage.getItem(SETUP_MOVED_KEY);
    return target !== null && target.startsWith("https://") ? target : null;
  } catch {
    return null;
  }
}
