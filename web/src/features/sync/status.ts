/**
 * Der Sync-Zustand in Worten: für den Anzeiger im Rahmen und für die Sync-Ansicht.
 * Reine Logik ohne React.
 */
import type { CoreErrorCode, SyncStatus } from "@/contract";
import { plural } from "@/ui";

/**
 * - "ok":      erreichbar, nichts wartet
 * - "busy":    ein Abgleich läuft
 * - "pending": erreichbar, Änderungen warten noch auf den nächsten Abgleich
 * - "offline": der Server ist nicht erreichbar; die App arbeitet lokal weiter
 * - "error":   der letzte Abgleich ist gescheitert, obwohl der Server antwortet
 * - "unknown": noch nicht geprüft
 */
export type SyncTone = "ok" | "busy" | "pending" | "offline" | "error" | "unknown";

export interface SyncSummary {
  tone: SyncTone;
  /** Ein, zwei Wörter für den Anzeiger: „Aktuell", „Offline", „Abgleich läuft". */
  label: string;
  /** Ein ganzer Satz für Tooltip und Sync-Ansicht. */
  detail: string;
  /** Änderungen, die noch nicht beim Server angekommen sind. */
  pending: number;
}

export function pendingText(pending: number): string {
  return plural(pending, "ungesendete Änderung", "ungesendete Änderungen");
}

/** Warum ein Abgleich gescheitert ist, als Satz. `message` des Kerns ist nur der Rückfall. */
export function syncErrorText(error: { code: CoreErrorCode; message: string }): string {
  switch (error.code) {
    case "offline":
      return "Der Server war nicht erreichbar.";
    case "unauthorized":
      return "Dieses Gerät ist beim Server nicht mehr angemeldet.";
    case "protocol_mismatch":
      return "App und Server sprechen verschiedene Versionen. Bitte die App aktualisieren; die Änderungen bleiben auf diesem Gerät erhalten.";
    case "not_configured":
      return "Auf dem Server ist kein Haushalts-Passwort gesetzt.";
    case "rate_limited":
      return "Der Server hat zu viele Anfragen erhalten und bittet um eine Pause.";
    case "internal":
      return "Im Server oder in der App ist ein unerwarteter Fehler aufgetreten.";
    default:
      return error.message;
  }
}

export function summarizeSync(status: SyncStatus | undefined): SyncSummary {
  if (!status) {
    return { tone: "unknown", label: "Sync", detail: "Der Zustand wird geladen.", pending: 0 };
  }
  const { pending } = status;
  const waiting = pending > 0 ? ` ${plural(pending, "Änderung wartet", "Änderungen warten")} auf diesem Gerät.` : "";

  if (status.online === false) {
    return {
      tone: "offline",
      label: "Offline",
      detail: `Der Server ist nicht erreichbar. Stowly arbeitet auf der lokalen Kopie weiter und gleicht ab, sobald er wieder da ist.${waiting}`,
      pending,
    };
  }
  if (status.phase === "syncing") {
    return { tone: "busy", label: "Abgleich läuft", detail: "Die Änderungen werden gerade mit dem Server abgeglichen.", pending };
  }
  if (status.phase === "error") {
    const reason = status.last_error ? ` ${syncErrorText(status.last_error)}` : "";
    return { tone: "error", label: "Abgleich gescheitert", detail: `Der letzte Abgleich ist gescheitert.${reason}${waiting}`, pending };
  }
  if (status.online === null) {
    return { tone: "unknown", label: "Verbindung wird geprüft", detail: `Ob der Server erreichbar ist, wird gerade geprüft.${waiting}`, pending };
  }
  if (pending > 0) {
    const soon = pending === 1 ? "Sie wird gleich gesendet." : "Sie werden gleich gesendet.";
    return { tone: "pending", label: `${String(pending)} ungesendet`, detail: `Der Server ist erreichbar.${waiting} ${soon}`, pending };
  }
  return { tone: "ok", label: "Aktuell", detail: "Der Server ist erreichbar, alle Änderungen sind abgeglichen.", pending };
}
