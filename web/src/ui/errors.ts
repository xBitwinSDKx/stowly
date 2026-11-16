/**
 * Fehler des Kerns als deutscher Satz. Die Oberfläche unterscheidet nach `code`;
 * `message` des Kerns ist nur der Rückfall (src/contract/errors.ts).
 *
 * Ausnahmen, bei denen `message` gezeigt wird:
 * - "invalid": der genaue Satz der Eingabeprüfung aus dem Vertrag (src/contract/input.ts, etwa
 *   „Der Name ist zu lang (höchstens 60 Zeichen).“);
 * - "not_supported": warum es hier nicht geht (keine lokale Datenbank, ein anderer Tab mit
 *   älterer oder neuerer Version hält sie fest). Nur der Kern weiß, welcher Fall es ist.
 * - "conflict": der Satz des Servers, was an seinem Stand nicht mehr passt (etwa „Ein Update ist
 *   schon angefordert.“). Nur der Server weiß, welcher Fall es ist.
 */
import { isCoreError, type CoreErrorCode } from "@/contract";

const TEXTS: Record<CoreErrorCode, string> = {
  offline: "Der Server ist gerade nicht erreichbar.",
  unauthorized: "Dieses Gerät ist nicht mehr angemeldet.",
  invalid_password: "Das Passwort stimmt nicht.",
  rate_limited: "Zu viele Fehlversuche. Bitte kurz warten.",
  not_configured: "Auf dem Server ist noch kein Haushalts-Passwort gesetzt.",
  protocol_mismatch: "App und Server passen nicht zusammen. Bitte die App aktualisieren.",
  invalid: "Die Eingabe ist ungültig.",
  not_found: "Der Eintrag existiert nicht mehr.",
  barcode_taken: "Der Barcode gehört schon zu einem anderen Produkt.",
  last_zone: "Die letzte Zone lässt sich nicht löschen.",
  pending_changes: "Es gibt ungesendete Änderungen.",
  not_supported: "Das ist in dieser Ausbaustufe noch nicht verfügbar.",
  conflict: "Das passt nicht mehr zum Stand auf dem Server. Bitte neu laden und noch einmal versuchen.",
  internal: "Unerwarteter Fehler. Bitte noch einmal versuchen.",
};

/**
 * Ein Satz zu einem Fehler.
 * @param overrides eigene Sätze für einzelne Codes, passend zur Stelle („Die Geräteliste braucht den Server.")
 */
export function errorText(error: unknown, overrides: Partial<Record<CoreErrorCode, string>> = {}): string {
  if (isCoreError(error)) {
    // Der Kern sagt bei "invalid" genau, was nicht stimmt, bei "not_supported", was fehlt, und bei
    // "conflict", was nicht mehr passt; ohne eigenen Satz trägt `message` nur den Code.
    if ((error.code === "invalid" || error.code === "not_supported" || error.code === "conflict") && error.message.trim() !== "" && error.message !== error.code) {
      return error.message;
    }
    return overrides[error.code] ?? TEXTS[error.code] ?? error.message;
  }
  // Kein Fehler des Kerns: ein Programmfehler. Für den Anwender ist das ein unerwarteter Fehler.
  return overrides.internal ?? TEXTS.internal;
}
