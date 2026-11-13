/**
 * Der Weg vom Handy zum Druckdienst auf dem Pi (docs/etiketten.md, 5.5 und 5.6): in welchem
 * Adressraum eine Adresse liegt, wie es um die Erlaubnis des Browsers für das lokale Netzwerk
 * steht, und ob sich der Dienst ausweisen kann.
 *
 * Nur für die Seite: Aufrufe an einen direkten Drucker macht nie der Service Worker.
 */

/** Adressraum eines direkten Druckers aus Sicht des Browsers. */
export type AddressSpace = "loopback" | "local";

/**
 * `"loopback"` für 127.0.0.0/8, `[::1]` und `localhost` (Entwicklung), sonst `"local"`.
 * Die Angabe reist als `targetAddressSpace` mit jeder Anfrage; passt sie nicht zum wirklichen
 * Adressraum, lehnt der Browser die Anfrage ab.
 */
export function addressSpaceOf(url: string): AddressSpace {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "local";
  }
  if (host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host)) {
    return "loopback";
  }
  return "local";
}

/** Basis-Adresse ohne Schrägstrich am Ende. */
export function baseOf(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Stand der Erlaubnis für das lokale Netzwerk.
 * - "granted": erteilt; Anfragen laufen ohne Nachfrage.
 * - "denied": abgelehnt; es geht keine Anfrage hinaus.
 * - "prompt": Die nächste Anfrage löst die Nachfrage des Browsers aus.
 * - "unknown": Der Browser gibt keine Auskunft. Dann gibt es entweder keine Beschränkung,
 *   oder die Nachfrage lässt sich nicht vorhersehen.
 */
export type PermissionReading = "granted" | "denied" | "prompt" | "unknown";

export type PermissionReader = (space: AddressSpace) => Promise<PermissionReading>;

interface PermissionsLike {
  query(descriptor: { name: string }): Promise<{ state: string }>;
}

/**
 * Liest die Erlaubnis über die Permissions API. Der Name hat sich mit den Browser-Versionen
 * geändert: erst ein gemeinsamer (`local-network-access`), später getrennt nach Adressraum
 * (`local-network`, `loopback-network`). Unbekannte Namen werfen; dann wird der andere versucht.
 */
export const readPermission: PermissionReader = async (space) => {
  const permissions = (globalThis.navigator as { permissions?: PermissionsLike } | undefined)?.permissions;
  if (!permissions || typeof permissions.query !== "function") {
    return "unknown";
  }
  for (const name of [space === "loopback" ? "loopback-network" : "local-network", "local-network-access"]) {
    try {
      const status = await permissions.query({ name });
      if (status.state === "granted" || status.state === "denied" || status.state === "prompt") {
        return status.state;
      }
    } catch {
      // Diesen Namen kennt der Browser nicht.
    }
  }
  return "unknown";
};

/**
 * Meldet, wenn sich die Erlaubnis für das lokale Netzwerk ändert, und liefert die Funktion zum
 * Abmelden. Gebraucht wird das vor allem für einen Fall: Der Browser fragt den Anwender, und der
 * antwortet erst, nachdem die Anfrage des Kerns schon an ihrer Zeitgrenze aufgegeben hat.
 */
export type PermissionWatcher = (onChange: () => void) => () => void;

interface PermissionStatusLike {
  addEventListener?(type: "change", listener: () => void): void;
  removeEventListener?(type: "change", listener: () => void): void;
}

/** Beobachtet die Erlaubnis unter allen Namen, die ein Browser dafür kennt; unbekannte Namen werden übergangen. */
export const watchPermissions: PermissionWatcher = (onChange) => {
  const permissions = (globalThis.navigator as { permissions?: { query(descriptor: { name: string }): Promise<PermissionStatusLike> } } | undefined)?.permissions;
  if (!permissions || typeof permissions.query !== "function") {
    return () => undefined;
  }
  let stopped = false;
  const listener = () => {
    if (!stopped) {
      onChange();
    }
  };
  const watched: PermissionStatusLike[] = [];
  for (const name of ["local-network", "loopback-network", "local-network-access"]) {
    permissions.query({ name }).then(
      (status) => {
        if (!stopped && typeof status.addEventListener === "function") {
          status.addEventListener("change", listener);
          watched.push(status);
        }
      },
      () => undefined,
    );
  }
  return () => {
    stopped = true;
    for (const status of watched.splice(0)) {
      status.removeEventListener?.("change", listener);
    }
  };
};

const NONCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/** Eine frische Zufallsfolge für `GET /v1/health?nonce=…`: 32 Zeichen aus `A–Z a–z 0–9 _ -`. */
export function newNonce(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let nonce = "";
  for (const byte of bytes) {
    nonce += NONCE_ALPHABET[byte % NONCE_ALPHABET.length];
  }
  return nonce;
}

/**
 * Der Nachweis, den ein echter Druckdienst liefert: `hex(HMAC-SHA256(Schlüssel = Token, Nachricht = nonce))`.
 * null, wenn der Browser kein WebCrypto hergibt (kein sicherer Kontext).
 */
export async function proofOf(token: string, nonce: string): Promise<string | null> {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (!subtle) {
    return null;
  }
  try {
    const encoder = new TextEncoder();
    const key = await subtle.importKey("raw", encoder.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = new Uint8Array(await subtle.sign("HMAC", key, encoder.encode(nonce)));
    return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/** Vergleicht zwei Nachweise, ohne sich an Groß- und Kleinschreibung zu stören. */
export function sameProof(expected: string | null, given: unknown): boolean {
  return expected !== null && typeof given === "string" && given.toLowerCase() === expected.toLowerCase();
}
