/**
 * Drucker und Etiketten: die reine Logik und alle Sätze dazu, ohne React.
 *
 * - Zustand eines Druckers und des Rechners (Pi) in Worten, mit dem, was auffällt
 * - zu jedem Grund, aus dem ein Druckdienst nicht benutzbar ist, ein Satz mit dem nächsten Schritt
 * - Zustände und Fehler der Etiketten
 * - welcher Drucker am Ende druckt (dieselbe Regel wie im Kern: `printerIdForJob`)
 * - wann das Zertifikat eines gekoppelten Pi bald abläuft
 */
import {
  formatDate,
  PI_CERT_WARN_DAYS,
  printerIdForJob,
  productSubtitle,
  productTitle,
  type DriverStatus,
  type HostHealth,
  type HouseholdSettings,
  type Package,
  type Printer,
  type PrinterErrorCode,
  type PrinterProblem,
  type PrinterStatus,
  type PrintFlushReport,
  type PrintJob,
  type PrintJobErrorCode,
  type PrintJobState,
  type Product,
  toLocalDate,
  type Zone,
} from "@/contract";
import { plural } from "@/ui";

// --------------------------------------------------------------------------------------
// Schwellen: ab wann etwas am Rechner auffällt
// --------------------------------------------------------------------------------------

/** Ab hier gilt der Pi als warm, ab `HOT` als heiß (dort beginnt er zu drosseln). */
export const TEMPERATURE_WARM_C = 70;
export const TEMPERATURE_HOT_C = 80;
/** Belegung des Overlays (Schreibschicht über der schreibgeschützten SD-Karte) in Prozent. */
export const OVERLAY_HIGH_PCT = 80;
export const OVERLAY_FULL_PCT = 95;
/** Freier Arbeitsspeicher in MB, unter dem es eng wird. */
export const MEMORY_LOW_MB = 50;
/** Nach so vielen Tagen ohne Kontakt gilt der gezeigte Zustand als alt: kein Fehler, aber sichtbar. */
export const STALE_AFTER_DAYS = 7;

export type FactTone = "ok" | "neutral" | "warn" | "danger";

/** Eine Angabe zum Zustand: „Temperatur · 81 °C", mit der Farbe, in der sie steht. */
export interface Fact {
  key: string;
  label: string;
  value: string;
  tone: FactTone;
}

// --------------------------------------------------------------------------------------
// Fehler des Druckers und der Etiketten
// --------------------------------------------------------------------------------------

const PRINTER_ERROR_TEXTS: Record<PrinterErrorCode, string> = {
  no_media: "Es sind keine Etiketten eingelegt.",
  media_mismatch: "Die eingelegte Rolle passt nicht. Erwartet wird die 62-mm-Endlosrolle.",
  cover_open: "Die Klappe des Druckers ist offen.",
  cutter_jam: "Das Schneidwerk klemmt.",
  overheated: "Der Drucker ist überhitzt und braucht eine Pause.",
  busy: "Der Drucker ist gerade beschäftigt.",
  offline: "Der Drucker ist aus oder nicht verbunden.",
  config: "Die Angaben zum Drucker passen nicht zum Treiber (Modell, Adresse oder Rolle).",
  unknown: "Der Drucker meldet einen Fehler, den er nicht näher benennt.",
};

/** Der Satz zu einem Fehler aus `DriverStatus.errors`; ein unbekannter Code bleibt, wie er ist. */
export function printerErrorText(code: string): string {
  return Object.hasOwn(PRINTER_ERROR_TEXTS, code) ? PRINTER_ERROR_TEXTS[code as PrinterErrorCode] : code;
}

const JOB_ERROR_TEXTS: Record<PrintJobErrorCode, string> = {
  ...PRINTER_ERROR_TEXTS,
  unknown_printer: "Der Druckdienst kennt diesen Drucker nicht.",
  invalid_request: "Der Druckdienst hat den Auftrag als fehlerhaft abgelehnt.",
  render_failed: "Das Etikett ließ sich nicht aufbereiten (Vorlage oder Daten).",
  cancelled: "Der Auftrag wurde am Drucker verworfen.",
  interrupted: "Der Druck wurde mittendrin unterbrochen.",
  handoff: "An die Seite des Druckers übergeben; die App kennt den Ausgang nicht.",
  not_printed: "Auf Nachfrage als nicht gedruckt vermerkt.",
};

/** Der Satz zu `PrintJob.error`; ein unbekannter Code bleibt, wie er ist. */
export function jobErrorText(code: string): string {
  return Object.hasOwn(JOB_ERROR_TEXTS, code) ? JOB_ERROR_TEXTS[code as PrintJobErrorCode] : code;
}

export type JobTone = "neutral" | "info" | "warn" | "danger" | "success";

/** Zustand eines Etiketts als Wort und Farbe. */
export const JOB_STATES: Record<PrintJobState, { label: string; tone: JobTone }> = {
  pending: { label: "ausstehend", tone: "warn" },
  queued: { label: "wartet am Drucker", tone: "info" },
  printing: { label: "wird gedruckt", tone: "info" },
  printed: { label: "gedruckt", tone: "success" },
  sent: { label: "gesendet", tone: "success" },
  failed: { label: "fehlgeschlagen", tone: "danger" },
  unknown: { label: "unklar", tone: "warn" },
  cancelled: { label: "verworfen", tone: "neutral" },
};

/** Noch nicht abgeschlossen: Daran erinnern das Drucker-Symbol und das Menü. */
export function isOpenJob(job: Pick<PrintJob, "state">): boolean {
  return job.state === "pending" || job.state === "queued" || job.state === "printing" || job.state === "unknown";
}

// --------------------------------------------------------------------------------------
// Warum ein Druckdienst nicht benutzbar ist
// --------------------------------------------------------------------------------------

/** Die Gründe aus `printers.probe` und `print.flush`. */
export type DeliveryProblem = PrinterProblem | "no_printer";

export interface ProblemText {
  /** Was los ist. */
  title: string;
  /** Was zu tun ist. */
  advice: string;
}

/**
 * Der Satz zu einem Grund, mit dem nächsten Schritt.
 * @param origin   Adresse dieser App (`location.origin`), für den Eintrag in der Konfiguration des Pi
 * @param fallback Satz des Kerns, falls er einen Grund nennt, den die Oberfläche noch nicht kennt
 */
export function problemText(problem: DeliveryProblem, printer: Pick<Printer, "connection"> | undefined, origin: string, fallback?: string | null): ProblemText {
  switch (problem) {
    default:
      return { title: fallback || "Der Druckdienst ist gerade nicht benutzbar.", advice: "Bitte später noch einmal versuchen." };
    case "offline":
      return {
        title: "Der Server ist nicht erreichbar.",
        advice: "Dieser Drucker hängt am Server. Sobald der Server wieder erreichbar ist, werden die ausstehenden Etiketten gedruckt.",
      };
    case "unavailable":
      return {
        title: "Der Druckdienst des Servers läuft nicht.",
        advice:
          "Der Server ist erreichbar, kann aber gerade nicht drucken; den Grund nennt sein Log. Die ausstehenden Etiketten bleiben stehen und werden gedruckt, sobald der Druckdienst wieder läuft.",
      };
    case "unreachable":
      return {
        title: "Der Druckdienst antwortet auf keiner Adresse.",
        advice:
          "Ist dieses Gerät im WLAN des Pi, und ist der Pi eingeschaltet? Für die HTTPS-Adresse muss außerdem das Zertifikat des Pi auf diesem Gerät installiert sein.",
      };
    case "permission":
      return {
        title: "Der Browser hat den Zugriff auf das lokale Netzwerk abgelehnt.",
        advice: "In den Einstellungen des Browsers für diese Seite den Zugriff auf Geräte im lokalen Netzwerk erlauben, dann noch einmal prüfen.",
      };
    case "blocked":
      return {
        title: "Der Druckdienst antwortet, lässt diese App aber nicht zu.",
        advice: `In der Konfiguration des Pi fehlt die Adresse dieser App als erlaubter Ursprung: ${origin}`,
      };
    case "not_verified":
      return {
        title: "Die Gegenstelle hat sich nicht als Druckdienst von Stowly ausgewiesen.",
        advice: "Das Token dieses Druckers prüfen: Es muss dem Token in der Konfiguration des Pi gleichen.",
      };
    case "unknown_printer":
      return printer?.connection === "server"
        ? { title: "Der Server kennt diesen Drucker nicht.", advice: "Einmal abgleichen und noch einmal prüfen; bleibt es dabei, den Drucker neu anlegen." }
        : {
            title: "Der Druckdienst kennt keinen Drucker mit diesem Namen.",
            advice: "Den „Namen des Druckers im Dienst“ prüfen. Ein leeres Feld nimmt den Standarddrucker des Pi.",
          };
    case "insecure_context":
      return {
        title: "Direktdruck geht nur über die HTTPS-Adresse.",
        advice: "Stowly über seine HTTPS-Adresse öffnen. Über eine http-Adresse lässt der Browser nur den Druck über den Server zu.",
      };
    case "no_printer":
      return {
        title: "Dem Etikett ist kein Drucker zugeordnet.",
        advice: "Einen Standarddrucker wählen oder der Zone einen Drucker zuordnen.",
      };
  }
}

/** Bei diesen Gründen hilft bei einem direkten Drucker der Notweg über die Seite des Druckdienstes. */
export function handoffHelps(problem: DeliveryProblem | null | undefined): boolean {
  return problem === "unreachable" || problem === "permission" || problem === "insecure_context";
}

/** Was ein Zustellversuch gebracht hat, in einem Satz. */
export function flushSummary(report: Pick<PrintFlushReport, "delivered" | "pending">): string {
  if (report.delivered === 0 && report.pending === 0) {
    return "Es stand kein eigenes Etikett aus.";
  }
  const parts: string[] = [];
  if (report.delivered > 0) {
    parts.push(`${plural(report.delivered, "Etikett ist", "Etiketten sind")} beim Drucker angekommen`);
  }
  if (report.pending > 0) {
    parts.push(`${plural(report.pending, "Etikett steht", "Etiketten stehen")} weiter aus`);
  }
  return `${parts.join(", ")}.`;
}

// --------------------------------------------------------------------------------------
// Zustand eines Druckers
// --------------------------------------------------------------------------------------

/**
 * - "never": noch nie gesehen
 * - "ok": zuletzt war alles in Ordnung
 * - "attention": etwas fällt auf (warm, Overlay füllt sich)
 * - "trouble": so druckt er nicht, oder der Rechner zeigt ernste Anzeichen
 */
export type HealthLevel = "never" | "ok" | "attention" | "trouble";

export interface PrinterHealth {
  level: HealthLevel;
  /** Das Urteil in zwei, drei Worten, für das Abzeichen. */
  summary: string;
  /** Wann zuletzt gesehen; null = nie. */
  observedAt: string | null;
  /** Der Zeitpunkt liegt lange zurück: kein Fehler, aber der gezeigte Zustand ist alt. */
  stale: boolean;
  /** Verbunden, bereit, Etiketten. Was sich nicht feststellen lässt, steht neutral da. */
  facts: Fact[];
  /** Fehler des Druckers als Sätze. */
  errors: string[];
  /** Der Rechner (Pi); leer bei Druckern am Server. */
  host: Fact[];
}

function worse(a: HealthLevel, b: HealthLevel): HealthLevel {
  const order: HealthLevel[] = ["never", "ok", "attention", "trouble"];
  return order.indexOf(b) > order.indexOf(a) ? b : a;
}

/** Laufzeit in Worten: „seit 12 Tagen", „seit 3 Stunden". */
export function uptimeText(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `seit ${plural(Math.max(1, minutes), "Minute", "Minuten")}`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `seit ${plural(hours, "Stunde", "Stunden")}`;
  }
  return `seit ${String(Math.floor(hours / 24))} Tagen`;
}

/** Der Rechner, auf dem der Druckdienst läuft. Unbekanntes (null) wird ausgelassen. */
export function hostFacts(host: HostHealth | null | undefined): Fact[] {
  if (!host) {
    return [];
  }
  const facts: Fact[] = [];
  const number = (value: number, digits = 0) => value.toLocaleString("de-DE", { maximumFractionDigits: digits });

  if (typeof host.temperature_c === "number") {
    const hot = host.temperature_c >= TEMPERATURE_HOT_C;
    const warm = host.temperature_c >= TEMPERATURE_WARM_C;
    facts.push({
      key: "temperature",
      label: "Temperatur",
      value: `${number(host.temperature_c)} °C${hot ? " (heiß)" : warm ? " (warm)" : ""}`,
      tone: hot ? "danger" : warm ? "warn" : "ok",
    });
  }
  if (typeof host.throttled === "boolean") {
    facts.push({ key: "throttled", label: "Leistung", value: host.throttled ? "gedrosselt" : "nicht gedrosselt", tone: host.throttled ? "warn" : "ok" });
  }
  // Auf der Pi-Zero-Reihe immer null (kein Detektor): Dann steht hier nichts.
  if (typeof host.undervoltage === "boolean") {
    facts.push({ key: "undervoltage", label: "Stromversorgung", value: host.undervoltage ? "Unterspannung" : "in Ordnung", tone: host.undervoltage ? "danger" : "ok" });
  }
  if (typeof host.storage_errors === "number" || typeof host.storage_read_only === "boolean") {
    const errors = host.storage_errors ?? 0;
    const readOnly = host.storage_read_only === true;
    const parts: string[] = [];
    if (errors > 0) {
      parts.push(plural(errors, "Fehler", "Fehler"));
    }
    if (readOnly) {
      parts.push("nur noch lesbar");
    }
    facts.push({ key: "storage", label: "SD-Karte", value: parts.length > 0 ? parts.join(", ") : "unauffällig", tone: parts.length > 0 ? "danger" : "ok" });
  }
  if (typeof host.overlay_used_pct === "number") {
    const full = host.overlay_used_pct >= OVERLAY_FULL_PCT;
    const high = host.overlay_used_pct >= OVERLAY_HIGH_PCT;
    facts.push({
      key: "overlay",
      label: "Overlay",
      value: `${number(host.overlay_used_pct)} % belegt${full || high ? " (fast voll)" : ""}`,
      tone: full ? "danger" : high ? "warn" : "ok",
    });
  }
  if (typeof host.memory_available_mb === "number") {
    const low = host.memory_available_mb < MEMORY_LOW_MB;
    facts.push({ key: "memory", label: "Arbeitsspeicher", value: `${number(host.memory_available_mb)} MB frei`, tone: low ? "warn" : "ok" });
  }
  if (typeof host.uptime_s === "number") {
    facts.push({ key: "uptime", label: "Läuft", value: uptimeText(host.uptime_s), tone: "neutral" });
  }
  return facts;
}

function driverFacts(status: DriverStatus, printer: Pick<Printer, "server"> | undefined): Fact[] {
  const facts: Fact[] = [{ key: "reachable", label: "Drucker", value: status.reachable ? "verbunden" : "nicht verbunden", tone: status.reachable ? "ok" : "danger" }];
  if (!status.reachable) {
    return facts;
  }
  facts.push(
    status.ready === null
      ? { key: "ready", label: "Bereit", value: "lässt sich nicht feststellen", tone: "neutral" }
      : { key: "ready", label: "Bereit", value: status.ready ? "ja" : "nein", tone: status.ready ? "ok" : "danger" },
  );
  // Der Bild-Treiber schreibt Dateien: Dort gibt es keine Etikettenrolle.
  if (printer?.server?.driver !== "image") {
    const empty = status.media_detected === false || status.errors.includes("no_media");
    facts.push(
      empty
        ? { key: "media", label: "Etiketten", value: "leer", tone: "danger" }
        : status.media_detected === null
          ? { key: "media", label: "Etiketten", value: "lässt sich nicht feststellen", tone: "neutral" }
          : { key: "media", label: "Etiketten", value: "eingelegt", tone: "ok" },
    );
  }
  return facts;
}

/**
 * Was zuletzt von einem Drucker gesehen wurde, als Urteil und Angaben.
 * @param status Eintrag aus `data.printerStatus` oder undefined (noch nie gesehen)
 * @param now    jetzt, in Millisekunden
 */
export function describeHealth(status: PrinterStatus | undefined, printer: Pick<Printer, "server"> | undefined, now: number): PrinterHealth {
  if (!status) {
    return { level: "never", summary: "noch nie gesehen", observedAt: null, stale: false, facts: [], errors: [], host: [] };
  }
  const age = now - Date.parse(status.observed_at);
  const stale = Number.isFinite(age) && age > STALE_AFTER_DAYS * 86_400_000;
  const host = hostFacts(status.host);
  let level: HealthLevel = "ok";
  let summary = "bereit";
  let facts: Fact[] = [];
  let errors: string[] = [];

  if (status.status === null) {
    summary = "Zustand unbekannt";
    facts = [{ key: "reachable", label: "Drucker", value: "Der Dienst konnte seinen Zustand nicht melden", tone: "neutral" }];
  } else {
    const driver = status.status;
    facts = driverFacts(driver, printer);
    // „Etiketten leer" und „nicht verbunden" stehen schon in den Angaben; der Satz dazu sagt dasselbe genauer.
    errors = driver.errors.map(printerErrorText);
    if (!driver.reachable) {
      level = "trouble";
      summary = "nicht verbunden";
    } else if (driver.media_detected === false || driver.errors.includes("no_media")) {
      level = "trouble";
      summary = "Etiketten leer";
    } else if (driver.errors.length > 0 || driver.ready === false) {
      level = "trouble";
      summary = "nicht bereit";
    }
  }

  for (const fact of host) {
    if (fact.tone === "danger") {
      level = worse(level, "trouble");
    } else if (fact.tone === "warn") {
      level = worse(level, "attention");
    }
  }
  if (level === "attention") {
    summary = "bereit, mit Hinweisen";
  } else if (level === "trouble" && summary === "bereit") {
    // Der Drucker selbst ist in Ordnung, aber der Rechner zeigt ernste Anzeichen.
    summary = "Rechner auffällig";
  }
  return { level, summary, observedAt: status.observed_at, stale, facts, errors, host };
}

// --------------------------------------------------------------------------------------
// Welcher Drucker druckt
// --------------------------------------------------------------------------------------

/** Die Live-Daten, in denen die Regeln nachschlagen. */
export interface PrintData {
  printers: ReadonlyMap<string, Printer>;
  zones: ReadonlyMap<string, Zone>;
  /** Bestand und Lösch-Historie. */
  packages: ReadonlyMap<string, Package>;
  products: ReadonlyMap<string, Product>;
  settings: Pick<HouseholdSettings, "default_printer_id"> | null | undefined;
}

function resolve(job: Pick<PrintJob, "printer_id" | "package_id" | "zone_id">, data: PrintData): Printer | undefined {
  const id = printerIdForJob(job, {
    package: (packageId) => data.packages.get(packageId),
    zone: (zoneId) => data.zones.get(zoneId),
    printer: (printerId) => data.printers.get(printerId),
    settings: data.settings,
  });
  return id === null ? undefined : data.printers.get(id);
}

/** Der Drucker, der die Etiketten einer Zone am Ende druckt: ihr eigener, sonst der Standarddrucker, sonst keiner. */
export function printerForZone(zoneId: string, data: PrintData): Printer | undefined {
  return resolve({ printer_id: null, package_id: null, zone_id: zoneId }, data);
}

/** Der Drucker, der die Etiketten einer Packung druckt (nach der Zone, in der sie jetzt liegt). */
export function printerForPackage(packageId: string, data: PrintData): Printer | undefined {
  return resolve({ printer_id: null, package_id: packageId, zone_id: null }, data);
}

/** Wofür ein Drucker zuständig ist: als Standarddrucker und für welche Zonen ausdrücklich. */
export function printerDuties(printer: Pick<Printer, "id">, zones: readonly Zone[], settings: Pick<HouseholdSettings, "default_printer_id"> | null | undefined) {
  return {
    isDefault: settings?.default_printer_id === printer.id,
    zones: zones.filter((zone) => zone.printer_id === printer.id),
  };
}

/** Namen in Anführungszeichen als Aufzählung: „A“, „A“ und „B“, „A“, „B“ und „C“. */
export function joinNames(names: readonly string[]): string {
  const quoted = names.map((name) => `„${name}“`);
  if (quoted.length <= 1) {
    return quoted.join("");
  }
  return `${quoted.slice(0, -1).join(", ")} und ${quoted.at(-1) ?? ""}`;
}

/** Wer ein Etikett druckte, wenn es diesen Drucker nicht mehr gäbe: dieselbe Regel, nur ohne ihn. */
export function printerWithout(job: Pick<PrintJob, "printer_id" | "package_id" | "zone_id">, removedId: string, data: PrintData): Printer | undefined {
  const id = printerIdForJob(job, {
    package: (packageId) => data.packages.get(packageId),
    zone: (zoneId) => data.zones.get(zoneId),
    printer: (printerId) => (printerId === removedId ? undefined : data.printers.get(printerId)),
    settings: data.settings,
  });
  return id === null ? undefined : data.printers.get(id);
}

/**
 * Was das Löschen eines Druckers bewirkt, in Sätzen für die Rückfrage: wofür er zuständig ist,
 * wer danach für seine Zonen druckt und wohin die ausstehenden Etiketten gehen, die er jetzt drucken würde.
 * @param waiting die ausstehenden Etiketten (`Printing.waiting`)
 * @param multiZone Zonen überhaupt nennen (mehr als eine Zone)
 */
export function describeRemoval(
  printer: Pick<Printer, "id">,
  zones: readonly Zone[],
  data: PrintData,
  waiting: readonly JobView[],
  multiZone: boolean,
): { duties: string[]; labels: string[] } {
  const settings = data.settings;
  const isDefault = settings?.default_printer_id === printer.id;
  const own = multiZone ? zones.filter((zone) => zone.printer_id === printer.id) : [];
  const names = joinNames(own.map((zone) => zone.name));
  const fallbackId = isDefault ? null : (settings?.default_printer_id ?? null);
  const fallback = fallbackId === null ? undefined : data.printers.get(fallbackId);
  const sentences: string[] = [];
  const labels: string[] = [];

  if (isDefault && own.length > 0) {
    sentences.push(`Er ist der Standarddrucker und druckt für ${names}.`);
  } else if (isDefault) {
    sentences.push("Er ist der Standarddrucker.");
  } else if (own.length > 0) {
    sentences.push(`Er druckt für ${names}.`);
  } else {
    sentences.push(multiZone ? "Er ist weder Standarddrucker noch einer Zone zugeordnet." : "Er ist nicht der Standarddrucker.");
  }
  if (own.length > 0) {
    sentences.push(
      fallback
        ? `${own.length === 1 ? "Diese Zone nutzt" : "Diese Zonen nutzen"} danach wieder den Standarddrucker „${fallback.name}“.`
        : `${own.length === 1 ? "Diese Zone hat" : "Diese Zonen haben"} danach keinen Drucker, bis ${own.length === 1 ? "ihr" : "ihnen"} einer zugeordnet oder ein Standarddrucker gewählt ist.`,
    );
  }
  if (isDefault) {
    sentences.push("Einen Standarddrucker gibt es danach nicht mehr, bis ein anderer gewählt ist.");
  }

  // Ausstehend und jetzt bei diesem Drucker: Wohin gehen sie danach?
  const affected = waiting.filter((view) => view.job.state === "pending" && view.printer?.id === printer.id);
  if (affected.length > 0) {
    const successors = affected.map((view) => printerWithout(view.job, printer.id, data));
    const first = successors[0];
    const count = plural(affected.length, "ausstehendes Etikett", "ausstehende Etiketten");
    const one = affected.length === 1;
    if (first && successors.every((successor) => successor?.id === first.id)) {
      labels.push(`${count} ${one ? "geht" : "gehen"} danach an „${first.name}“.`);
    } else if (successors.every((successor) => successor === undefined)) {
      labels.push(`${count} ${one ? "bleibt" : "bleiben"} stehen, bis ein Drucker zuständig ist.`);
    } else {
      // Gemischt heißt: mindestens zwei Etiketten, von denen einige einen anderen Drucker finden.
      const moved = successors.filter((successor) => successor !== undefined).length;
      const stay = affected.length - moved;
      labels.push(
        `Von ${String(affected.length)} ausstehenden Etiketten ${moved === 1 ? "geht eines" : `gehen ${String(moved)}`} danach an andere Drucker, ${stay === 1 ? "eines bleibt" : `${String(stay)} bleiben`} stehen, bis ein Drucker zuständig ist.`,
      );
    }
  }
  // Ausnahme der Regel (core.ts, `printers.remove`): Was schon an ihn abgeschickt ist, kann nur
  // sein Dienst klären. Welches das ist, weiß nur der Kern; der Satz gilt deshalb für alle.
  if (waiting.some((view) => view.printer?.id === printer.id)) {
    labels.push("Was schon an diesen Drucker abgeschickt ist, bleibt bei ihm, bis er antwortet; antwortet er nicht mehr, lässt es sich verwerfen.");
  }
  labels.push("Etiketten werden dabei nicht gelöscht.");
  return { duties: sentences, labels };
}

// --------------------------------------------------------------------------------------
// Etiketten für die Anzeige
// --------------------------------------------------------------------------------------

/**
 * In welchem Abschnitt der Liste ein Etikett steht:
 * - "ask": Ausgang unklar, die App fragt nach
 * - "waiting": ausstehend oder beim Drucker
 * - "done": erledigt, fehlgeschlagen oder verworfen
 */
export type JobGroup = "ask" | "waiting" | "done";

export interface JobView {
  job: PrintJob;
  group: JobGroup;
  /** Wozu das Etikett gehört, als Überschrift: Produktname oder „Zone Keller". */
  title: string;
  /** Darunter: Packungs-ID mit Marke und Größe, oder leer. */
  detail: string;
  /** Kurz und eindeutig, für Beschriftungen: „Basmati Reis, Packung A2B3C" oder „Zone Keller". */
  label: string;
  /** Der Drucker, der druckt oder gedruckt hat; undefined = keiner zugeordnet oder nicht mehr bekannt. */
  printer: Printer | undefined;
  /** Dieses Gerät hat das Etikett angefordert und stellt es zu. */
  own: boolean;
  /** Ein Drucker mit Bild-Treiber hat es geschrieben: Das Bild lässt sich ansehen. */
  hasImage: boolean;
}

function jobGroup(state: PrintJobState): JobGroup {
  if (state === "unknown") {
    return "ask";
  }
  return state === "pending" || state === "queued" || state === "printing" ? "waiting" : "done";
}

/** Bereitet ein Etikett für die Anzeige auf. */
export function viewJob(job: PrintJob, data: PrintData, ownDeviceId: string | null): JobView {
  let title: string;
  let detail = "";
  if (job.kind === "zone") {
    const zone = job.zone_id === null ? undefined : data.zones.get(job.zone_id);
    title = zone ? `Zone ${zone.name}` : "Zone (gelöscht)";
    detail = "Zonen-Etikett";
  } else {
    const pkg = job.package_id === null ? undefined : data.packages.get(job.package_id);
    const product = pkg ? data.products.get(pkg.product_id) : undefined;
    title = pkg ? productTitle(product) : "Packung nicht mehr vorhanden";
    detail = [job.package_id ? `Packung ${job.package_id}` : null, productSubtitle(product) || null].filter(Boolean).join(" · ");
  }
  // Solange ein Etikett aussteht, entscheidet die Regel bei jedem Versuch neu; danach steht fest, wer gedruckt hat.
  const reported = job.printer_id === null ? undefined : data.printers.get(job.printer_id);
  const printer = job.state === "pending" ? resolve(job, data) : (reported ?? (isOpenJob(job) ? resolve(job, data) : undefined));
  return {
    job,
    group: jobGroup(job.state),
    title,
    detail,
    label: job.kind === "package" && job.package_id ? `${title}, Packung ${job.package_id}` : title,
    printer,
    own: ownDeviceId !== null && job.device_id === ownDeviceId,
    hasImage: (job.state === "printed" || job.state === "sent") && printer?.server?.driver === "image",
  };
}

// --------------------------------------------------------------------------------------
// Zertifikat eines gekoppelten Pi
// --------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/**
 * Die ganzen Tage bis zum Ablauf des Zertifikats eines Pi (`PairedPrinter.not_after`), wenn er
 * näher ist als `PI_CERT_WARN_DAYS` (negativ: schon abgelaufen); sonst null, auch ohne lesbaren Ablauf.
 */
export function piCertificateWarning(notAfter: string | null, now: number): number | null {
  const ms = notAfter === null ? Number.NaN : Date.parse(notAfter);
  if (Number.isNaN(ms)) {
    return null;
  }
  const days = Math.floor((ms - now) / DAY_MS);
  return days < PI_CERT_WARN_DAYS ? days : null;
}

/** Die Überschrift der Warnung vor dem Ablauf des Zertifikats eines Pi. */
export function certificateWarningTitle(name: string, days: number, notAfter: string): string {
  if (days < 0) {
    return `Das Zertifikat des Pi „${name}“ ist abgelaufen.`;
  }
  const day = formatDate(toLocalDate(new Date(Date.parse(notAfter))));
  return days === 0 ? `Das Zertifikat des Pi „${name}“ läuft heute ab.` : `Das Zertifikat des Pi „${name}“ läuft in ${plural(days, "Tag", "Tagen")} ab (${day}).`;
}
