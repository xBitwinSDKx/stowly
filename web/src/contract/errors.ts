/**
 * Fehler, die der Offline-Kern an die Oberfläche meldet.
 * Die Oberfläche unterscheidet nach `code` und zeigt dazu ihren eigenen deutschen Text;
 * `message` ist nur der Rückfall.
 */

export type CoreErrorCode =
  /** Der Server ist nicht erreichbar, die Aktion braucht ihn aber (Anmelden, Geräteliste, Sicherung, Vorschau). */
  | "offline"
  /** Das Geräte-Token ist unbekannt oder gesperrt. */
  | "unauthorized"
  /** Falsches Haushalts-Passwort. */
  | "invalid_password"
  /** Zu viele Fehlversuche; `details.retry_after_s` nennt die Wartezeit. */
  | "rate_limited"
  /**
   * Der Server hat noch kein Haushalts-Passwort (`session.createPassword` setzt es), oder eine
   * Integration, die der Aufruf braucht, ist dort nicht eingerichtet (Push: kein Kontakt; Updates:
   * aus; Pi koppeln: keine CA oder kein Paket).
   */
  | "not_configured"
  /** App und Server sprechen verschiedene Protokollversionen. */
  | "protocol_mismatch"
  /** Die Eingabe ist ungültig (z. B. Menge außerhalb 1-50, leerer Name). */
  | "invalid"
  /** Ein Datensatz, auf den sich die Aktion bezieht, existiert lokal nicht. */
  | "not_found"
  /** Der Barcode gehört schon zu einem anderen Produkt; `details.product_id` nennt es. */
  | "barcode_taken"
  /** Die letzte Zone lässt sich nicht löschen. */
  | "last_zone"
  /** Abmelden würde ungesendete Änderungen verwerfen; `details.pending` nennt die Anzahl. */
  | "pending_changes"
  /** In dieser Umgebung oder in dieser Ausbaustufe nicht verfügbar. */
  | "not_supported"
  /**
   * Der Zustand des Servers passt nicht (mehr) zur Aktion (409), etwa: Ein Update ist schon
   * angefordert, die Version ist nicht mehr die neueste, es gibt schon ein Passwort, oder ein Wert
   * kommt aus der Umgebung. Die Meldung des Servers sagt es.
   */
  | "conflict"
  /** Unerwarteter Fehler. */
  | "internal";

export class CoreError extends Error {
  readonly code: CoreErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: CoreErrorCode, message?: string, details: Record<string, unknown> = {}) {
    super(message ?? code);
    this.name = "CoreError";
    this.code = code;
    this.details = details;
  }
}

/** Wahr für einen CoreError, auf Wunsch mit einem bestimmten Code. */
export function isCoreError(error: unknown, code?: CoreErrorCode): error is CoreError {
  return error instanceof CoreError && (code === undefined || error.code === code);
}
