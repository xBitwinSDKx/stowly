/**
 * Die reine Logik rund um Drucker und Etiketten: Zustand in Worten, Sätze zu Gründen und
 * Fehlern, welcher Drucker druckt.
 */
import { describe, expect, it } from "vitest";

import { PRINT_JOB_ERROR_CODES, PRINTER_ERROR_CODES, type HostHealth, type PrinterProblem, type PrinterStatus, type PrintJob } from "@/contract";
import { createSampleData, DEVICE_IDS, PRINTER_IDS, sampleUuid, ZONE_IDS } from "@/mock";
import { troubledPrinterStatus } from "@/mock/sample";

import { labelStatusText, labelStatusTone } from "./LabelStatus";
import {
  describeHealth,
  describeRemoval,
  flushSummary,
  handoffHelps,
  hostFacts,
  isOpenJob,
  JOB_STATES,
  jobErrorText,
  joinNames,
  printerDuties,
  printerErrorText,
  printerForPackage,
  printerForZone,
  problemText,
  uptimeText,
  viewJob,
  type DeliveryProblem,
  type PrintData,
} from "./model";

const NOW = new Date("2026-11-13T12:00:00Z");
const data = createSampleData(NOW);

function printData(overrides: Partial<PrintData> = {}): PrintData {
  return {
    printers: new Map(data.printers.map((printer) => [printer.id, printer])),
    zones: new Map(data.zones.map((zone) => [zone.id, zone])),
    packages: new Map(data.packages.map((pkg) => [pkg.id, pkg])),
    products: new Map(data.products.map((product) => [product.id, product])),
    settings: data.settings,
    ...overrides,
  };
}

const kitchen = data.printers.find((printer) => printer.id === PRINTER_IDS.kitchen);
const cellar = data.printers.find((printer) => printer.id === PRINTER_IDS.cellar);

function status(printerId: string, list: PrinterStatus[] = data.printerStatus): PrinterStatus | undefined {
  return list.find((entry) => entry.printer_id === printerId);
}

describe("Zustand eines Druckers", () => {
  it("nennt einen Drucker ohne Eintrag „noch nie gesehen“", () => {
    expect(describeHealth(undefined, cellar, NOW.getTime())).toMatchObject({ level: "never", summary: "noch nie gesehen", observedAt: null, stale: false, facts: [], host: [] });
  });

  it("zeigt verbunden, bereit und Etiketten und beim Pi den Rechner", () => {
    const health = describeHealth(status(PRINTER_IDS.cellar), cellar, NOW.getTime());
    expect(health.level).toBe("ok");
    expect(health.summary).toBe("bereit");
    expect(health.stale).toBe(false);
    expect(health.facts.map((fact) => `${fact.label}: ${fact.value}`)).toEqual(["Drucker: verbunden", "Bereit: ja", "Etiketten: eingelegt"]);
    expect(health.host.map((fact) => fact.label)).toEqual(["Temperatur", "Leistung", "SD-Karte", "Overlay", "Arbeitsspeicher", "Läuft"]);
    expect(health.host.every((fact) => fact.tone === "ok" || fact.tone === "neutral")).toBe(true);
    expect(health.errors).toEqual([]);
  });

  it("lässt beim Bild-Treiber die Etikettenrolle weg und zeigt Unbekanntes nicht als Fehler", () => {
    const health = describeHealth(status(PRINTER_IDS.kitchen), kitchen, NOW.getTime());
    expect(health.level).toBe("ok");
    expect(health.facts.map((fact) => fact.label)).toEqual(["Drucker", "Bereit"]);
    expect(health.host).toEqual([]);

    // Ein Drucker im Netzwerk kann Bereitschaft und Rolle nicht melden: null heißt „lässt sich nicht feststellen".
    const unknown: PrinterStatus = { printer_id: "x", observed_at: NOW.toISOString(), boot_id: null, status: { reachable: true, ready: null, media_detected: null, errors: [] }, host: null };
    const facts = describeHealth(unknown, { server: { driver: "brother_ql", model: "QL-820NWB", address: "tcp://192.168.1.60:9100", media: "62" } }, NOW.getTime());
    expect(facts.level).toBe("ok");
    expect(facts.facts.filter((fact) => fact.tone === "neutral").map((fact) => `${fact.label}: ${fact.value}`)).toEqual([
      "Bereit: lässt sich nicht feststellen",
      "Etiketten: lässt sich nicht feststellen",
    ]);
  });

  it("hebt hervor, was nicht stimmt: Drucker aus, Etiketten leer, Pi heiß und gedrosselt, SD-Karte, Overlay", () => {
    const troubled = troubledPrinterStatus(NOW);
    const off = describeHealth(status(PRINTER_IDS.kitchen, troubled), kitchen, NOW.getTime());
    expect(off).toMatchObject({ level: "trouble", summary: "nicht verbunden", errors: ["Der Drucker ist aus oder nicht verbunden."] });
    expect(off.facts).toEqual([{ key: "reachable", label: "Drucker", value: "nicht verbunden", tone: "danger" }]);

    const pi = describeHealth(status(PRINTER_IDS.cellar, troubled), cellar, NOW.getTime());
    expect(pi.level).toBe("trouble");
    expect(pi.summary).toBe("Etiketten leer");
    // Zuletzt vor neun Tagen gesehen: kein Fehler, aber sichtbar.
    expect(pi.stale).toBe(true);
    expect(pi.errors).toEqual(["Es sind keine Etiketten eingelegt."]);
    expect(pi.facts.find((fact) => fact.key === "media")).toMatchObject({ value: "leer", tone: "danger" });
    const host = Object.fromEntries(pi.host.map((fact) => [fact.key, fact]));
    expect(host.temperature).toMatchObject({ value: "82 °C (heiß)", tone: "danger" });
    expect(host.throttled).toMatchObject({ value: "gedrosselt", tone: "warn" });
    expect(host.storage).toMatchObject({ value: "3 Fehler, nur noch lesbar", tone: "danger" });
    expect(host.overlay).toMatchObject({ value: "91 % belegt (fast voll)", tone: "warn" });
    expect(host.memory).toMatchObject({ value: "38 MB frei", tone: "warn" });
    expect(host.uptime).toMatchObject({ value: "seit 41 Tagen", tone: "neutral" });
  });

  it("zeigt am Rechner nur, was er melden kann, und Unterspannung nur, wenn es einen Detektor gibt", () => {
    expect(hostFacts(null)).toEqual([]);
    expect(hostFacts({})).toEqual([]);
    const allNull: HostHealth = { uptime_s: null, temperature_c: null, throttled: null, undervoltage: null, storage_errors: null, storage_read_only: null, overlay_used_pct: null, memory_available_mb: null };
    expect(hostFacts(allNull)).toEqual([]);
    // Pi Zero: undervoltage ist immer null und erscheint nicht.
    expect(hostFacts({ temperature_c: 48.2, undervoltage: null }).map((fact) => fact.key)).toEqual(["temperature"]);
    expect(hostFacts({ undervoltage: true })).toEqual([{ key: "undervoltage", label: "Stromversorgung", value: "Unterspannung", tone: "danger" }]);
    expect(hostFacts({ undervoltage: false })[0]).toMatchObject({ value: "in Ordnung", tone: "ok" });
    // Schwellen: warm ab 70 °C, heiß ab 80 °C; Overlay auffällig ab 80 %, voll ab 95 %; wenig Speicher unter 50 MB.
    expect(hostFacts({ temperature_c: 69.9 })[0]?.tone).toBe("ok");
    expect(hostFacts({ temperature_c: 70 })[0]).toMatchObject({ value: "70 °C (warm)", tone: "warn" });
    expect(hostFacts({ temperature_c: 80 })[0]?.tone).toBe("danger");
    expect(hostFacts({ overlay_used_pct: 79.9 })[0]?.tone).toBe("ok");
    expect(hostFacts({ overlay_used_pct: 96 })[0]?.tone).toBe("danger");
    expect(hostFacts({ memory_available_mb: 50 })[0]?.tone).toBe("ok");
    expect(hostFacts({ storage_errors: 0, storage_read_only: false })[0]).toMatchObject({ value: "unauffällig", tone: "ok" });
    expect(hostFacts({ storage_read_only: true })[0]).toMatchObject({ value: "nur noch lesbar", tone: "danger" });
  });

  it("stuft Hinweise am Rechner als „mit Hinweisen“ ein und einen Dienst ohne Druckerzustand als unbekannt", () => {
    const warm: PrinterStatus = { printer_id: "x", observed_at: NOW.toISOString(), boot_id: null, status: { reachable: true, ready: true, media_detected: true, errors: [] }, host: { temperature_c: 72 } };
    expect(describeHealth(warm, cellar, NOW.getTime())).toMatchObject({ level: "attention", summary: "bereit, mit Hinweisen" });
    const sick: PrinterStatus = { ...warm, host: { storage_errors: 2 } };
    expect(describeHealth(sick, cellar, NOW.getTime())).toMatchObject({ level: "trouble", summary: "Rechner auffällig" });
    const silent: PrinterStatus = { ...warm, status: null, host: null };
    expect(describeHealth(silent, cellar, NOW.getTime())).toMatchObject({ level: "ok", summary: "Zustand unbekannt" });
    const notReady: PrinterStatus = { ...warm, status: { reachable: true, ready: false, media_detected: true, errors: ["cover_open"] }, host: null };
    expect(describeHealth(notReady, cellar, NOW.getTime())).toMatchObject({ level: "trouble", summary: "nicht bereit", errors: ["Die Klappe des Druckers ist offen."] });
  });

  it("nennt die Laufzeit in Minuten, Stunden und Tagen", () => {
    expect(uptimeText(30)).toBe("seit 1 Minute");
    expect(uptimeText(45 * 60)).toBe("seit 45 Minuten");
    expect(uptimeText(5 * 3600)).toBe("seit 5 Stunden");
    expect(uptimeText(12.5 * 86_400)).toBe("seit 12 Tagen");
  });
});

describe("Sätze", () => {
  it("hat zu jedem Fehler des Druckers einen Satz und lässt Unbekanntes, wie es ist", () => {
    for (const code of PRINTER_ERROR_CODES) {
      expect(printerErrorText(code), code).toMatch(/^[A-ZÄÖÜ].+\.$/);
      expect(printerErrorText(code), code).not.toBe(code);
    }
    expect(printerErrorText("paper_jam_42")).toBe("paper_jam_42");
  });

  it("hat zu jedem Fehler eines Etiketts einen Satz und lässt Unbekanntes, wie es ist", () => {
    const seen = new Set<string>();
    for (const code of PRINT_JOB_ERROR_CODES) {
      const text = jobErrorText(code);
      expect(text, code).toMatch(/^[A-ZÄÖÜ].+\.$/);
      expect(text, code).not.toBe(code);
      seen.add(text);
    }
    // Jeder Code sagt etwas Eigenes.
    expect(seen.size).toBe(PRINT_JOB_ERROR_CODES.length);
    expect(jobErrorText("no_media")).toBe("Es sind keine Etiketten eingelegt.");
    expect(jobErrorText("not_printed")).toBe("Auf Nachfrage als nicht gedruckt vermerkt.");
    expect(jobErrorText("something_new")).toBe("something_new");
  });

  it("hat zu jedem Grund, aus dem ein Druckdienst nicht benutzbar ist, einen Satz mit dem nächsten Schritt", () => {
    const problems: DeliveryProblem[] = ["offline", "unavailable", "unreachable", "permission", "blocked", "not_verified", "unknown_printer", "insecure_context", "no_printer"];
    const titles = new Set<string>();
    for (const problem of problems) {
      const text = problemText(problem, cellar, "https://stowly.home");
      expect(text.title, problem).toMatch(/^[A-ZÄÖÜ].+\.$/);
      expect(text.advice.length, problem).toBeGreaterThan(20);
      titles.add(text.title);
    }
    expect(titles.size).toBe(problems.length);
    expect(problemText("unreachable", cellar, "https://stowly.home").advice).toContain("WLAN des Pi");
    expect(problemText("unreachable", cellar, "https://stowly.home").advice).toContain("Zertifikat");
    expect(problemText("permission", cellar, "https://stowly.home").advice).toContain("lokalen Netzwerk");
    // Der Ursprung dieser App gehört in die Konfiguration des Pi.
    expect(problemText("blocked", cellar, "https://stowly.home").advice).toContain("https://stowly.home");
    expect(problemText("not_verified", cellar, "https://stowly.home").advice).toContain("Token");
    expect(problemText("insecure_context", cellar, "http://192.168.1.20:8000").title).toBe("Direktdruck geht nur über die HTTPS-Adresse.");
    expect(problemText("unknown_printer", kitchen, "https://stowly.home").title).toBe("Der Server kennt diesen Drucker nicht.");
    expect(problemText("unknown_printer", cellar, "https://stowly.home").title).toBe("Der Druckdienst kennt keinen Drucker mit diesem Namen.");
    // Ein Grund, den die Oberfläche noch nicht kennt: der Satz des Kerns als Rückfall.
    expect(problemText("ganz_neu" as PrinterProblem, cellar, "https://stowly.home", "Der Dienst ist überlastet.").title).toBe("Der Dienst ist überlastet.");
  });

  it("bietet den Notweg nur an, wo er hilft", () => {
    expect((["unreachable", "permission", "insecure_context"] as const).every(handoffHelps)).toBe(true);
    expect((["offline", "unavailable", "blocked", "not_verified", "unknown_printer", "no_printer"] as const).some(handoffHelps)).toBe(false);
    expect(handoffHelps(null)).toBe(false);
  });

  it("fasst einen Zustellversuch zusammen", () => {
    expect(flushSummary({ delivered: 0, pending: 0 })).toBe("Es stand kein eigenes Etikett aus.");
    expect(flushSummary({ delivered: 1, pending: 0 })).toBe("1 Etikett ist beim Drucker angekommen.");
    expect(flushSummary({ delivered: 3, pending: 0 })).toBe("3 Etiketten sind beim Drucker angekommen.");
    expect(flushSummary({ delivered: 0, pending: 2 })).toBe("2 Etiketten stehen weiter aus.");
    expect(flushSummary({ delivered: 2, pending: 1 })).toBe("2 Etiketten sind beim Drucker angekommen, 1 Etikett steht weiter aus.");
  });

  it("kennt jeden Zustand eines Etiketts als Wort", () => {
    expect(Object.fromEntries(Object.entries(JOB_STATES).map(([state, entry]) => [state, entry.label]))).toEqual({
      pending: "ausstehend",
      queued: "wartet am Drucker",
      printing: "wird gedruckt",
      printed: "gedruckt",
      sent: "gesendet",
      failed: "fehlgeschlagen",
      unknown: "unklar",
      cancelled: "verworfen",
    });
    expect((["pending", "queued", "printing", "unknown"] as const).every((state) => isOpenJob({ state }))).toBe(true);
    expect((["printed", "sent", "failed", "cancelled"] as const).some((state) => isOpenJob({ state }))).toBe(false);
  });
});

describe("Welcher Drucker druckt", () => {
  it("nimmt den Drucker der Zone, sonst den Standarddrucker, sonst keinen", () => {
    const lookup = printData();
    expect(printerForZone(ZONE_IDS.cellar, lookup)?.name).toBe("Keller (Pi)");
    expect(printerForZone(ZONE_IDS.shelf, lookup)?.name).toBe("Küche (Bild)");
    const noDefault = printData({ settings: { default_printer_id: null } });
    expect(printerForZone(ZONE_IDS.shelf, noDefault)).toBeUndefined();
    expect(printerForZone(ZONE_IDS.freezer, noDefault)?.name).toBe("Keller (Pi)");
    // Eine Packung druckt dort, wo ihre Zone druckt.
    const inCellar = data.packages.find((pkg) => pkg.zone_id === ZONE_IDS.cellar && pkg.removed_at === null);
    expect(printerForPackage(inCellar?.id ?? "", lookup)?.name).toBe("Keller (Pi)");
    expect(printerForPackage("ZZZZZ", noDefault)).toBeUndefined();
  });

  it("zählt einen gelöschten Drucker als nicht gesetzt", () => {
    const withoutCellar = printData({ printers: new Map(data.printers.filter((printer) => printer.id !== PRINTER_IDS.cellar).map((printer) => [printer.id, printer])) });
    expect(printerForZone(ZONE_IDS.cellar, withoutCellar)?.name).toBe("Küche (Bild)");
  });

  it("sagt, wofür ein Drucker zuständig ist", () => {
    expect(printerDuties({ id: PRINTER_IDS.kitchen }, data.zones, data.settings)).toEqual({ isDefault: true, zones: [] });
    const duties = printerDuties({ id: PRINTER_IDS.cellar }, data.zones, data.settings);
    expect(duties.isDefault).toBe(false);
    expect(duties.zones.map((zone) => zone.name)).toEqual(["Keller", "Gefrierschrank"]);
  });
});

describe("Etiketten für die Anzeige", () => {
  const lookup = printData();
  const job = (n: number): PrintJob => {
    const found = data.printJobs.find((candidate) => candidate.id === sampleUuid(4, n));
    if (!found) {
      throw new Error(`Etikett ${String(n)} fehlt in den Beispieldaten`);
    }
    return found;
  };

  it("ordnet nach „klären“, „ausstehend“ und „erledigt“ und erkennt eigene und fremde", () => {
    expect(viewJob(job(1), lookup, DEVICE_IDS.current)).toMatchObject({ group: "waiting", own: true, hasImage: false });
    expect(viewJob(job(3), lookup, DEVICE_IDS.current)).toMatchObject({ group: "ask", own: true });
    expect(viewJob(job(4), lookup, DEVICE_IDS.current)).toMatchObject({ group: "done", title: "Basmati Reis" });
    expect(viewJob(job(6), lookup, DEVICE_IDS.current)).toMatchObject({ group: "waiting", own: false });
    // Nicht angemeldet: Kein Etikett ist das eigene.
    expect(viewJob(job(1), lookup, null).own).toBe(false);
  });

  it("nennt Produkt, Packungs-ID und Drucker und weiß, wozu es ein Bild gibt", () => {
    const view = viewJob(job(7), lookup, DEVICE_IDS.current);
    expect(view.title).toBe("Basmati Reis");
    expect(view.detail).toBe(`Packung ${job(7).package_id ?? ""} · Kornhaus · 1 kg`);
    // Kurz und eindeutig für Beschriftungen: Mehrere Etiketten können zu demselben Produkt gehören.
    expect(view.label).toBe(`Basmati Reis, Packung ${job(7).package_id ?? ""}`);
    expect(view.printer?.name).toBe("Küche (Bild)");
    expect(view.hasImage).toBe(true);
    // Am Pi gedruckt: kein Bild.
    expect(viewJob(job(5), lookup, DEVICE_IDS.current)).toMatchObject({ hasImage: false, printer: { name: "Keller (Pi)" } });
  });

  it("bestimmt den Drucker eines ausstehenden Etiketts bei jedem Blick neu", () => {
    const pending: PrintJob = { ...job(1), printer_id: null };
    expect(viewJob(pending, lookup, DEVICE_IDS.current).printer?.name).toBe("Keller (Pi)");
    const moved = printData({ zones: new Map(data.zones.map((zone) => [zone.id, { ...zone, printer_id: null }])) });
    expect(viewJob(pending, moved, DEVICE_IDS.current).printer?.name).toBe("Küche (Bild)");
    const none = printData({ zones: moved.zones, settings: { default_printer_id: null } });
    expect(viewJob(pending, none, DEVICE_IDS.current).printer).toBeUndefined();
  });

  it("kommt mit Etiketten für Zonen und mit verschwundenen Packungen zurecht", () => {
    const zoneJob: PrintJob = { ...job(1), kind: "zone", package_id: null, zone_id: ZONE_IDS.freezer, printer_id: null };
    expect(viewJob(zoneJob, lookup, DEVICE_IDS.current)).toMatchObject({ title: "Zone Gefrierschrank", detail: "Zonen-Etikett", printer: { name: "Keller (Pi)" } });
    expect(viewJob({ ...zoneJob, zone_id: sampleUuid(1, 99) }, lookup, DEVICE_IDS.current).title).toBe("Zone (gelöscht)");
    const gone: PrintJob = { ...job(1), package_id: "ZZZZZ" };
    expect(viewJob(gone, lookup, DEVICE_IDS.current)).toMatchObject({ title: "Packung nicht mehr vorhanden", detail: "Packung ZZZZZ" });
  });

  it("sagt nach dem Anfordern, was aus den Etiketten wird", () => {
    const view = (state: PrintJob["state"], changes: Partial<PrintJob> = {}) => viewJob({ ...job(1), state, ...changes }, lookup, DEVICE_IDS.current);
    expect(labelStatusText([])).toBe("");
    expect(labelStatusText([view("pending")])).toBe("1 Etikett steht aus und wird gedruckt, sobald dieses Gerät den Drucker „Keller (Pi)“ erreicht.");
    expect(labelStatusText([view("queued"), view("printing")])).toBe("2 Etiketten werden am Drucker „Keller (Pi)“ gerade gedruckt.");
    expect(labelStatusText([view("printed"), view("printed")])).toBe("2 Etiketten sind am Drucker „Keller (Pi)“ gedruckt.");
    expect(labelStatusText([view("printed"), view("pending")])).toBe("1 ist gedruckt; 1 Etikett steht aus und wird gedruckt, sobald dieses Gerät den Drucker „Keller (Pi)“ erreicht.");
    expect(labelStatusText([view("failed", { error: "no_media" })])).toBe("1 Etikett wurde nicht gedruckt (es sind keine Etiketten eingelegt).");
    expect(labelStatusText([view("failed", { error: "paper_jam_42" })])).toBe("1 Etikett wurde nicht gedruckt (paper_jam_42).");
    expect(labelStatusText([view("unknown", { error: "interrupted" })])).toBe("Bei 1 Etikett ist der Ausgang unklar: Stowly fragt nach, ob es gedruckt wurde.");
    expect(labelStatusText([view("unknown"), view("unknown")])).toBe("Bei 2 Etiketten ist der Ausgang unklar: Stowly fragt nach, ob sie gedruckt wurden.");
    expect(labelStatusText([view("cancelled")])).toBe("1 Etikett wurde verworfen.");
    const unassigned = viewJob({ ...job(1), printer_id: null }, printData({ zones: new Map(), settings: { default_printer_id: null } }), DEVICE_IDS.current);
    expect(labelStatusText([unassigned])).toBe("1 Etikett steht aus: Es ist kein Drucker zugeordnet.");
  });

  it("gibt dem Stand eben angeforderter Etiketten eine Farbe: Das Schlechteste zählt", () => {
    const view = (state: PrintJob["state"]) => viewJob({ ...job(1), state }, lookup, DEVICE_IDS.current);
    expect(labelStatusTone([view("printed"), view("sent")])).toBe("success");
    expect(labelStatusTone([view("printed"), view("queued")])).toBe("busy");
    expect(labelStatusTone([view("queued"), view("pending")])).toBe("pending");
    expect(labelStatusTone([view("pending"), view("unknown")])).toBe("warn");
    expect(labelStatusTone([view("unknown"), view("failed")])).toBe("danger");
  });
});

describe("Drucker löschen", () => {
  const waiting = (lookup: PrintData) => data.printJobs.map((entry) => viewJob(entry, lookup, DEVICE_IDS.current)).filter((view) => view.group === "waiting");
  const job = (n: number): PrintJob => {
    const found = data.printJobs.find((candidate) => candidate.id === sampleUuid(4, n));
    if (!found) {
      throw new Error(`Etikett ${String(n)} fehlt in den Beispieldaten`);
    }
    return found;
  };

  it("sagt, wofür er zuständig ist, wer danach druckt und wohin die ausstehenden Etiketten gehen", () => {
    const lookup = printData();
    const cellar = lookup.printers.get(PRINTER_IDS.cellar);
    const kitchen = lookup.printers.get(PRINTER_IDS.kitchen);
    if (!cellar || !kitchen) {
      throw new Error("Drucker fehlen in den Beispieldaten");
    }
    const alreadySent = "Was schon an diesen Drucker abgeschickt ist, bleibt bei ihm, bis er antwortet; antwortet er nicht mehr, lässt es sich verwerfen.";
    expect(describeRemoval(cellar, data.zones, lookup, waiting(lookup), true)).toEqual({
      duties: ["Er druckt für „Keller“ und „Gefrierschrank“.", "Diese Zonen nutzen danach wieder den Standarddrucker „Küche (Bild)“."],
      labels: ["3 ausstehende Etiketten gehen danach an „Küche (Bild)“.", alreadySent, "Etiketten werden dabei nicht gelöscht."],
    });
    // Der Standarddrucker ohne eigene Zonen: Seine Etiketten gibt es gerade nicht, danach gibt es keinen Standarddrucker.
    expect(describeRemoval(kitchen, data.zones, lookup, waiting(lookup), true)).toEqual({
      duties: ["Er ist der Standarddrucker.", "Einen Standarddrucker gibt es danach nicht mehr, bis ein anderer gewählt ist."],
      labels: ["Etiketten werden dabei nicht gelöscht."],
    });
    // Ohne Standarddrucker haben die Zonen danach keinen Drucker, und die Etiketten bleiben stehen.
    const noDefault = printData({ settings: { default_printer_id: null } });
    expect(describeRemoval(cellar, data.zones, noDefault, waiting(noDefault), true)).toEqual({
      duties: [
        "Er druckt für „Keller“ und „Gefrierschrank“.",
        "Diese Zonen haben danach keinen Drucker, bis ihnen einer zugeordnet oder ein Standarddrucker gewählt ist.",
      ],
      labels: ["3 ausstehende Etiketten bleiben stehen, bis ein Drucker zuständig ist.", alreadySent, "Etiketten werden dabei nicht gelöscht."],
    });
  });

  it("nennt Zonen nur, wenn es mehrere gibt, und kennt gemischte Wege der Etiketten", () => {
    const lookup = printData();
    const cellar = lookup.printers.get(PRINTER_IDS.cellar);
    if (!cellar) {
      throw new Error("Drucker fehlt in den Beispieldaten");
    }
    expect(describeRemoval(cellar, data.zones, lookup, [], false).duties).toEqual(["Er ist nicht der Standarddrucker."]);
    // Ohne Standarddrucker; der Kühlschrank hat die Küche. Ein Etikett nennt den Pi ausdrücklich, liegt
    // aber im Kühlschrank (geht danach an die Küche), das andere liegt im Keller (danach ohne Drucker).
    const zones = new Map(data.zones.map((zone) => [zone.id, zone.id === ZONE_IDS.fridge ? { ...zone, printer_id: PRINTER_IDS.kitchen } : zone]));
    const mixed = printData({ zones, settings: { default_printer_id: null } });
    const fridgePkg = data.packages.find((pkg) => pkg.zone_id === ZONE_IDS.fridge && pkg.removed_at === null);
    const views = [
      viewJob({ ...job(1), printer_id: PRINTER_IDS.cellar, package_id: fridgePkg?.id ?? null }, mixed, DEVICE_IDS.current),
      viewJob({ ...job(2), printer_id: null }, mixed, DEVICE_IDS.current),
    ];
    expect(views.map((view) => view.printer?.name)).toEqual(["Keller (Pi)", "Keller (Pi)"]);
    expect(describeRemoval(cellar, [...zones.values()], mixed, views, true).labels[0]).toBe(
      "Von 2 ausstehenden Etiketten geht eines danach an andere Drucker, eines bleibt stehen, bis ein Drucker zuständig ist.",
    );
    expect(joinNames(["Keller"])).toBe("„Keller“");
    expect(joinNames(["A", "B", "C"])).toBe("„A“, „B“ und „C“");
  });
});
