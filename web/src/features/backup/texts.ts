/**
 * Sätze zur Sicherung und zum Zurückspielen als reine Logik, ohne React: woher der Ordner kommt,
 * was ein Fehler beim Zurückspielen heißt, was in einer Sicherung steckt. Die Texte folgen
 * docs/plan-einrichtung-b.md, Abschnitte 1 und 2.
 */
import { formatTimestamp, isCoreError, RESTORE_MAX_BYTES, type BackupConfig, type BackupStatus, type ConfigSource, type RestorePreview, type UploadProgress } from "@/contract";
import { waitText } from "@/features/auth";
import { deviceTimeZone, errorText, formatBytes, otherTimeZone, plural } from "@/ui";

/**
 * Die Uhrzeit der Sicherung gilt in der Zeitzone des Servers. Weicht die des Geräts ab, steht sie
 * dabei (docs/integrationen.md, Abschnitt 2).
 */
export function backupTimeText(time: string, serverZone: string, deviceZone: string = deviceTimeZone()): string {
  const other = otherTimeZone(serverZone, deviceZone);
  return other !== null ? `täglich um ${time} (Zeit des Servers, ${other})` : `täglich um ${time}`;
}

/** Die Warnung nach 48 Stunden (docs/integrationen.md, 3.6), in Worten. */
export function backupWarningText(backup: Pick<BackupStatus, "last_ok_at">): { title: string; text: string } {
  return backup.last_ok_at === null
    ? {
        title: "Noch keine Sicherung gelungen",
        text: "Der letzte Versuch ist gescheitert. Bitte auf dem Server nachsehen (Ordner, Rechte, Platz) und dann „Jetzt sichern“ versuchen.",
      }
    : {
        title: "Seit mehr als 48 Stunden keine Sicherung",
        text: "Die letzte gelungene Sicherung ist älter als zwei Tage. Bitte auf dem Server nachsehen (Ordner, Rechte, Platz) und dann „Jetzt sichern“ versuchen.",
      };
}

/** Was unter dem Schalter „Automatische Sicherung" steht: ob und wann sie läuft, und woher das kommt. */
export function scheduleHint(config: Pick<BackupConfig, "enabled" | "enabled_source" | "recipients" | "time">, timezone: string | null): string {
  const when = backupTimeText(config.time, timezone ?? "");
  if (config.enabled_source === "env") {
    return `Fest an, ${when}: Die Schlüssel kommen aus der Umgebung (STOWLY_BACKUP_RECIPIENTS).`;
  }
  if (!config.enabled) {
    return "Aus: Stowly sichert nicht von selbst. „Jetzt sichern“ geht trotzdem.";
  }
  return config.recipients.length === 0 ? `An, ${when}, sobald es einen Schlüssel gibt.` : `An: ${when}, verschlüsselt für die Schlüssel unten.`;
}

/** Was die Zeile „Ordner" zeigt und darunter sagt. */
export function folderText(config: Pick<BackupConfig, "folder" | "folder_source">): string {
  switch (config.folder_source) {
    case "env":
      return "Kommt aus der Umgebung (STOWLY_BACKUP_DIR).";
    case "mounted":
      return "Ein eigener Ordner, in DSM als /backups eingebunden: Die Sicherungen liegen außerhalb des Datenordners.";
    default:
      return "Im Datenordner von Stowly. Geht der Datenträger kaputt, sind Daten und Sicherungen zugleich weg: Besser einen zweiten Ordner einbinden oder diesen Ordner wegkopieren.";
  }
}

/** Ein Wert aus der Umgebung ist gesperrt; der Satz dazu nennt die Variable. */
export function envText(source: ConfigSource, variable: string): string | null {
  return source === "env" ? `Kommt aus der Umgebung (${variable}) und ist nur dort änderbar.` : null;
}

/** Fortschritt in Prozent, 0 bis 100. */
export function uploadPercent(progress: UploadProgress | null): number {
  if (progress === null || progress.total <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round((progress.loaded / progress.total) * 100)));
}

/** Was eine Datei ist, in Worten: „stowly-….age · 1,2 MB". */
export function fileText(file: { name: string; size: number }): string {
  return `${file.name} · ${formatBytes(file.size)}`;
}

/** Wie lange zu warten ist, aus `details.retry_after_s`; ohne Angabe `fallback` Sekunden. */
export function retryAfter(error: unknown, fallback = 60): number {
  const seconds = isCoreError(error) ? Number(error.details.retry_after_s) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : fallback;
}

/** Was ohne Server beim Speichern der Schlüssel fehlt. */
export const SAVE_OFFLINE = "Zum Speichern braucht es den Server, und der ist gerade nicht erreichbar.";

/**
 * Ein Fehler beim Hinzufügen eines Schlüssels als Satz. Ein neuer Schlüssel braucht das
 * Haushalts-Passwort (wer ihn hat, kann jede künftige Sicherung öffnen); ein falsches zählt wie bei
 * der Anmeldung und sperrt nach fünf Versuchen eine Minute lang.
 */
export function keyErrorText(error: unknown): string {
  if (isCoreError(error, "rate_limited")) {
    return `Zu viele Fehlversuche. Nächster Versuch in ${waitText(retryAfter(error, 60))}.`;
  }
  return errorText(error, { invalid_password: "Das Haushalts-Passwort stimmt nicht.", offline: SAVE_OFFLINE });
}

/** Wo es beim Zurückspielen gerade hakt: der Schritt, zu dem die Ansicht zurückkehrt. */
export type RestoreFailure = "file" | "key" | "apply";

/** Die Sätze zu den Gründen des Servers (`details.reason`), falls er keinen eigenen mitschickt. */
const REASONS: Readonly<Record<string, string>> = {
  wrong_key: "Der Schlüssel passt nicht zu dieser Sicherung. Gebraucht wird der geheime Schlüssel, der beim Einrichten der Sicherung gesichert wurde.",
  not_a_key: "Das ist kein geheimer Schlüssel von age. Er beginnt mit AGE-SECRET-KEY-1; auch die ganze Schlüsseldatei geht.",
  not_stowly: "Das ist keine Sicherung von Stowly. Sicherungen heißen stowly-JJJJ-MM-TT-HHMM.sqlite3.gz.age.",
  damaged: "Die Sicherung ist beschädigt und lässt sich nicht einspielen. Bitte eine andere nehmen.",
  newer_schema: "Die Sicherung stammt von einer neueren Version von Stowly. Erst Stowly aktualisieren, dann zurückspielen.",
  migration_failed: "Die Sicherung ließ sich nicht auf den Stand dieser Version bringen. Bitte eine andere nehmen.",
};

/**
 * Ein Fehler beim Zurückspielen als Satz. Was der Server dazu sagt (falscher Schlüssel, kein
 * Schlüssel, zu wenig Platz, ein Update läuft, kein Neustart möglich), ist genauer als jeder Satz
 * hier: Er gilt, wo es ihn gibt. Sonst die Sätze zu den Gründen und zu den Codes.
 */
export function restoreErrorText(error: unknown, firstRun = false): string {
  if (isCoreError(error, "rate_limited")) {
    return `Zu viele Versuche. Nächster Versuch in ${waitText(retryAfter(error, 60))}.`;
  }
  if (isCoreError(error, "not_found")) {
    return "Die hochgeladene Sicherung ist abgelaufen (nach 30 Minuten) oder unbekannt. Bitte noch einmal hochladen.";
  }
  if (isCoreError(error)) {
    const said = error.message.trim() !== "" && error.message !== error.code ? error.message : null;
    const tooBig = error.details.status === 413;
    if (said !== null && (error.code === "invalid" || error.code === "conflict" || error.code === "not_configured" || tooBig)) {
      return said;
    }
    if (tooBig) {
      return `Die Datei ist zu groß: Eine Sicherung darf höchstens ${String(RESTORE_MAX_BYTES / 1024 / 1024)} MiB haben.`;
    }
    const reason = typeof error.details.reason === "string" ? REASONS[error.details.reason] : undefined;
    if (error.code === "invalid" && reason !== undefined) {
      return reason;
    }
  }
  return errorText(error, {
    offline: "Zum Zurückspielen braucht es den Server, und der ist gerade nicht erreichbar.",
    invalid_password: firstRun ? "Das Passwort stimmt nicht mit dem aus der Sicherung überein." : "Das Passwort stimmt nicht.",
    not_supported: "Dieser Server kann noch keine Sicherung zurückspielen. Erst Stowly aktualisieren.",
  });
}

/** Zu welchem Schritt ein Fehler führt: abgelaufen zurück zur Datei, ein falscher Schlüssel bleibt beim Schlüssel. */
export function restoreFailureStep(error: unknown, current: RestoreFailure): RestoreFailure {
  return isCoreError(error, "not_found") ? "file" : current;
}

/** Die Zeilen der Vorschau: was in der Sicherung steckt. */
export function previewRows(preview: RestorePreview): { label: string; value: string }[] {
  const { counts } = preview;
  const rows = [
    { label: "Stand", value: preview.last_activity_at ? formatTimestamp(preview.last_activity_at) : "unbekannt" },
    { label: "Produkte", value: String(counts.products) },
    { label: "Vorräte", value: plural(counts.items, "Packung", "Packungen") },
    { label: "Zonen", value: String(counts.zones) },
    { label: "Einkaufsliste", value: counts.shopping === 0 ? "leer" : `${String(counts.shopping)} offen` },
    { label: "Geräte", value: String(preview.devices) },
    { label: "Haushalts-Passwort", value: preview.has_password ? "enthalten" : "keins" },
  ];
  if (preview.schema_version < preview.current_schema_version) {
    rows.push({ label: "Version", value: `${String(preview.schema_version)}, wird beim Einspielen auf ${String(preview.current_schema_version)} gebracht` });
  }
  return rows;
}

/** Läuft die Seite unverschlüsselt über das Heimnetz (nicht über HTTPS, nicht auf diesem Rechner)? */
export function insecureNetwork(location: Pick<Location, "protocol" | "hostname">): boolean {
  if (location.protocol === "https:") {
    return false;
  }
  const host = location.hostname;
  return !(host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost"));
}
